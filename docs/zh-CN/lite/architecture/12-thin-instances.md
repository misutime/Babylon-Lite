# 模块：瘦实例（Thin Instances）

> 包路径：`packages/babylon-lite/src/mesh/`（数据 + GPU 同步 + GPU 剔除）、`packages/babylon-lite/src/material/standard/`、`packages/babylon-lite/src/material/pbr/`、`packages/babylon-lite/src/material/node/` 和 `packages/babylon-lite/src/material/shader/`（渲染）

## 用途

瘦实例允许单个网格使用单次实例化绘制调用（instanced draw call）渲染数千次，且每个实例拥有独立的世界矩阵和可选的逐实例 RGBA 颜色。这是渲染大型人群、类粒子效果和程序化网格的主要机制。系统分为三层——CPU 数据模型、GPU 缓冲区同步和材质集成——旨在确保**不使用瘦实例的场景无需承担任何打包体积开销**。

所有四个网格材质家族均支持瘦实例：**Standard**、**PBR**、**NodeMaterial** 和 **ShaderMaterial**（用户自定义 WGSL）。有关 ShaderMaterial 集成细节（自动注入的 `world0..world3` / `instanceColor` 顶点属性以及用户着色器契约），请参阅 `24-shader-material.md`。

ShaderMaterial 绘制可以通过 `useThinInstanceColors: false` 显式忽略已有的实例颜色流。这是局部于绘制的设置：网格仍为其他材质保留其颜色，而所选材质仅绑定实例矩阵。其典型用途是与颜色无关的深度覆盖（depth override），共享可见网格的矩阵而无需为未使用的颜色同步或顶点读取付出开销。

---

## 公共 API 表面

### 接口

```typescript
/** Per-mesh thin-instance state. Stored as mesh.thinInstances. */
export interface ThinInstanceData {
    matrices: Float32Array; // 16 floats per instance (column-major 4x4 world matrix)
    count: number; // active instance count
    _capacity: number; // allocated capacity (≥ count)
    _version: number; // bumped by every mutating helper; checked by render system
    _gpuBuffer: GPUBuffer | null; // matrix GPU buffer, managed by render system
    _gpuVersion: number; // last _version uploaded to GPU
    colors?: Float32Array | null; // optional RGBA per instance (4 floats each)
    _colorVersion: number; // independent of _version; bumped by setThinInstanceColors
    _colorGpuBuffer: GPUBuffer | null;
    _colorGpuBufferStorage: boolean;
    _colorGpuVersion: number;
    _gpuCullingEnabled: boolean; // opt-in GPU frustum culling + indirect draw
    _lodPartner?: Mesh | null; // lower-detail mesh receiving the far cull bucket
    _lodSource?: Mesh | null; // source mesh when this mesh is the LOD partner
}
```

### 函数 — CPU 数据模型（`thin-instance.ts`）

```typescript
/** Bulk-set all instance matrices. Creates ThinInstanceData if absent. */
export function setThinInstances(mesh: Mesh, matrices: Float32Array, count: number): void;

/** Change the active count and mark the complete active matrix range dirty. */
export function setThinInstanceCount(mesh: Mesh, count: number): void;

/** Change the active draw count without marking matrix or color data dirty. */
export function setThinInstanceDrawCount(mesh: Mesh, count: number): void;

/** Pre-create stable indirect draw arguments during scene warm-up. */
export function enableThinInstanceDynamicDrawCount(mesh: Mesh): void;

/** Add one instance. Returns the new instance index. Grows capacity 2× when full. */
export function addThinInstance(mesh: Mesh, matrix: Mat4): number;

/** Overwrite the matrix at a specific index. */
export function setThinInstanceMatrix(mesh: Mesh, index: number, matrix: Mat4): void;

/** Remove instance at index via swap-remove (last instance moves into the gap). */
export function removeThinInstance(mesh: Mesh, index: number): void;

/** Bump _version after direct manipulation of the matrices Float32Array. */
export function flushThinInstances(mesh: Mesh): void;

/** Include exact thin-instance placements in default-camera and environment auto-sizing. */
export function enableThinInstanceWorldBounds(mesh: Mesh): void;

/** Set per-instance RGBA colors. Bumps _colorVersion. */
export function setThinInstanceColors(mesh: Mesh, colors: Float32Array): void;

/** Enable/disable per-pass GPU frustum culling. Must be called before registerScene(). */
export function enableThinInstanceGpuCulling(mesh: Mesh, enabled?: boolean): void;

interface ThinInstanceLodPartnerOptions {
    distance: number; // camera-space switch distance in world units
    band?: number; // deterministic per-instance dither width, default 0
}

/** Split one GPU-culling result into near/full-detail and far/LOD buckets. */
export function setThinInstanceLodPartner(fullMesh: Mesh, lodMesh: Mesh, options: ThinInstanceLodPartnerOptions): void;

/** Restore the two meshes to independent rendering. */
export function clearThinInstanceLodPartner(fullMesh: Mesh): void;
```

`setThinInstanceDrawCount()` 是针对已填充 CPU 数组和 GPU 缓冲区的固定容量池的纯计数路径。它接收 `[0, _capacity]` 范围内的整数，仅更新 `count`，并保持矩阵/颜色版本号和脏范围不变。缓存的绘制通过其稳定的间接绘制参数缓冲区读取计数，因此更改活跃前缀既不会替换实例缓冲区，也不会使渲染束（render bundle）失效。暴露新写入槽位的调用方必须通过相应的更新 API 将这些确切的矩阵/颜色范围标记为脏；纯计数设置器刻意不上传顶点数据。使用此设置器之前，对象池必须先完成一次全容量的 GPU 同步。

`setThinInstanceCount()` 仍然是便利路径，它会更改计数并将完整的活跃矩阵范围 `[0, count)` 标记为脏以进行上传。

当已同步的池将在交互中改变计数时，请在 `registerScene()` 之前调用 `enableThinInstanceDynamicDrawCount()`。它的下一次常规 GPU 同步会在预热期间创建稳定的间接参数缓冲区，从而使随后的首次计数变更不会使缓存的渲染束失效。

所有瘦实例材质家族（包括 Node Material 主渲染、透明渲染及覆盖/阴影绑定）都在其逐帧更新中同步活跃计数。最初以直接绘制方式记录的绑定在计数首次变化时会升级为一个稳定的间接参数缓冲区；随后可见性纪元（visibility epoch）会使那一个过时的渲染束失效。之后在容量范围内的变化（包括非零到零以及零到非零的转换）仅更新间接参数，并保持矩阵缓冲区与缓存渲染束稳定。

CPU 间接参数数组同时也是索引计数/基顶点的快照；这些值不会在并行字段中重复保存。存储的实例计数在成功上传后得到确认，并在写入前先置为无效，以便上传失败时无需分配新的参数缓冲区即可重试。基顶点按有符号 32 位字进行比较。矩阵缓冲区始终携带用于 GPU 拾取（GPU picking）的 `STORAGE` 用途标志，因此开启或关闭剔除不会重新创建或重新上传它们。颜色缓冲区仍单独跟踪其可选的存储用途。

`enableThinInstanceWorldBounds()` 是一个设置期可 Tree-Shaking 的可选功能，面向将被 `createDefaultCamera()` 或自动环境尺寸计算消费的手工构建瘦实例网格。它通过 `mesh.worldMatrix × instanceMatrix` 为每个活跃实例扩展原型网格的对象局部包围盒，并忽略线性变换实际上为零的停放（parked）实例。请在 `setThinInstances()` 之后、相机或环境创建之前调用它。glTF `EXT_mesh_gpu_instancing` 特性会自动启用它。

### 函数 — 层级实例池（`hierarchy-instance-pool.ts`）

针对旧版 Babylon.js `parentNode.instantiateHierarchy()` 道具工作流，Lite 暴露了一个小巧的可选辅助工具，保持基于瘦实例的渲染路径，同时保留子网格的偏移/旋转/缩放：

```typescript
/** Build a fixed-capacity pool from a template hierarchy. Call before registerScene(). */
export function createHierarchyInstancePool(root: SceneNode, capacity: number): HierarchyInstancePool;

/** Add one logical hierarchy instance and return its slot index. */
export function addHierarchyInstance(pool: HierarchyInstancePool, matrix: Mat4): number;

/** Update one logical hierarchy instance root matrix. */
export function setHierarchyInstanceMatrix(pool: HierarchyInstancePool, index: number, matrix: Mat4): void;

/** Remove one logical hierarchy instance via swap-remove. */
export function removeHierarchyInstance(pool: HierarchyInstancePool, index: number): void;

/** Change active logical count without reallocating buffers. */
export function setHierarchyInstanceCount(pool: HierarchyInstancePool, count: number): void;
```

实例 `matrix` 会与模板层级**合成**——其行为如同添加在根节点之上的父变换节点，因此每个后代的最终世界矩阵为 `matrix * meshWorld`（在每个网格上存储为 `meshWorld⁻¹ * matrix * meshWorld`，因为着色器按 `finalWorld = mesh.world * instanceMatrix` 绘制）。因此单位矩阵会原封不动地复现模板。对象池不得除掉根节点的世界矩阵：`loadGltf()` 根节点以缩放 `(-1, 1, 1)` 承载 RH→LH 转换，若抵消它会使每个实例镜像并反转其绕序。

`createHierarchyInstancePool()` 遍历所有后代网格，为每个网格分配其自身指定容量的瘦实例矩阵缓冲区，然后将活跃计数设为零。因此源网格成为对象池的渲染载体：它们本身不绘制模板，但必须保持 `visible !== false`，以便它们的瘦实例可以绘制。请勿使用 `setSubtreeVisible(root, false)` 隐藏层级池；而应使用 `setHierarchyInstanceCount(pool, 0)` 清空它。扩容时优先使用 `addHierarchyInstance(pool, matrix)`，以确保新可见的槽位在下一帧之前拥有已定义的矩阵。

### 函数 — GPU 同步（`thin-instance-gpu.ts`）

```typescript
/**
 * Sync CPU thin-instance data to GPU vertex buffers and bind them to the render pass.
 * Returns the next free vertex buffer slot.
 */
export function syncThinInstanceBuffers(
    engine: EngineContextInternal,
    ti: ThinInstanceData,
    pass: GPURenderPassEncoder | GPURenderBundleEncoder,
    slot: number,
    hasColor: boolean,
    drawBuffers?: ThinInstanceDrawBuffers | null
): number;
```

### 特性标志常量

```typescript
// standard-pipeline.ts
export const THIN_INSTANCES = 1 << 15; // matrix instancing
export const THIN_INSTANCE_COLOR = 1 << 16; // per-instance color buffer
export const DISABLE_LIGHTING = 1 << 17; // skip light loop, output emissive × diffuse × baseColor

// mesh-features.ts
export const MSH_HAS_THIN_INSTANCES = 1 << 4;
export const MSH_HAS_INSTANCE_COLOR = 1 << 5;
```

### 材质属性

```typescript
// StandardMaterialProps — extended with:
disableLighting: boolean; // default false. When true, skip all lighting; output emissive * diffuse * baseColor.
```

---

## 内部架构

### 数据流

```
User code
  │  setThinInstances(mesh, matrices, count)
  │  setThinInstanceColors(mesh, colors)
  ▼
thin-instance.ts  →  mesh.thinInstances: ThinInstanceData
  │  _version / _colorVersion bumped on every mutation
  ▼
standardGroupBuilder (standard-material.ts)
  │  detects meshes.some(m => !!m.thinInstances)
  │  dynamic import('./thin-instance-gpu.js')  ← lazy-loaded chunk
  │  passes syncThinInstanceBuffers as tiSync callback
  ▼
buildStandardMeshRenderables (standard-renderable.ts)
  │  stores the version-gated GPU sync in the per-frame update closure
  │  binds the stable matrix/color buffers in the draw closure
  ▼
Per-frame update + draw
  │  update: if mesh.thinInstances, upload dirty matrix/color ranges
  │  draw: if mesh.thinInstances and tiSync:
  │    slot = tiSync(device, ti, pass, slot, hasInstanceColor)
  │    pass.drawIndexed(indexCount, ti.count)  ← instanced draw
  ▼
GPU vertex shader
  │  world0..world3 → instanceWorld → finalWorld = mesh.world * instanceWorld
  │  instanceColor → vInstanceColor varying
  ▼
GPU fragment shader
  │  lighting or disableLighting path
  │  final color.rgba *= vInstanceColor.rgba (if instance color)
```

### 容量增长与交换移除（Swap-Remove）

**容量增长** — `addThinInstance` 初始容量为 16。当 `count === _capacity` 时，分配一个容量为 `_capacity * 2` 的新 `Float32Array` 并复制旧数据：

```typescript
const newCap = ti._capacity * 2;
const newData = new Float32Array(newCap * 16);
newData.set(ti.matrices);
ti.matrices = newData;
ti._capacity = newCap;
```

**交换移除** — `removeThinInstance` 使用 `copyWithin` 将最后一个实例矩阵复制到被移除的槽位，然后递减计数：

```typescript
ti.matrices.copyWithin(index * 16, last * 16, last * 16 + 16);
ti.count--;
ti._version++;
```

这避免了移动整个数组，保持移除操作为 O(1)。调用方必须注意最后一个实例的索引会发生变化。

### 版本追踪

| 版本字段 | 触发递增的操作 | 检查方 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `_version` | 矩阵/计数辅助函数以及颜色辅助函数（纯颜色变更会使矩阵脏范围保持为空，但仍会令静态阴影变脏） | `syncThinInstanceBuffers`（矩阵同步/版本） |
| `_colorVersion` | `setThinInstanceColors` | `syncThinInstanceBuffers`（颜色上传） |
| `_gpuVersion` | `syncThinInstanceBuffers`（矩阵上传后） | — |
| `_colorGpuVersion` | `syncThinInstanceBuffers`（颜色上传后） | — |

当 `_version === _gpuVersion`（或 `_colorVersion === _colorGpuVersion`）时跳过 GPU 上传，从而避免为静态实例执行冗余的 `writeBuffer` 调用。
`setThinInstanceDrawCount` 不会将任一数据流标记为脏；绘制参数同步独立观察 `count`。它会推进现有的瘦实例版本号而不标记矩阵/颜色脏范围，因此阴影缓存能感知变化，而 GPU 同步不执行任何属性上传。静态 ESM、PCF 和 CSM 贴图因此仅在其中一个实际投射者发生变化时才重绘。

不透明的主颜色与阴影绘制通常会录制到缓存渲染束（render bundle）中。录制时的 `setVertexBuffer` 调用保留的是 GPU 缓冲区句柄而非内容快照，因此运行时的矩阵变更必须在任一渲染束执行之前，通过可渲染对象的逐帧 `update` 闭包上传到同一缓冲区。仅在绘制闭包中上传是不正确的：在复用缓存渲染束时，绘制闭包不会再次运行。更新保持受版本门控，且同容量变更不得重新创建缓冲区或使渲染束失效/重新录制。缓冲区扩容或用途变更仍遵循现有的可见性纪元失效路径，因为这些操作会替换被捕获的句柄。

---

## GPU 缓冲区同步（`thin-instance-gpu.ts`）

### 矩阵缓冲区

1. 比较 `ti._version !== ti._gpuVersion` — 相等则跳过。
2. 计算 `byteSize = ti.count * 64`（16 个 float × 4 字节）。
3. 如果 `ti._gpuBuffer` 为 null 或 `ti._gpuBuffer.size < byteSize`：
    - 销毁旧缓冲区（如果存在）。
    - 创建新缓冲区：`size = ti._capacity * 64`，`usage = VERTEX | COPY_DST`，启用 GPU 剔除时附加 `STORAGE`。
4. `device.queue.writeBuffer(ti._gpuBuffer, 0, ti.matrices.buffer, ti.matrices.byteOffset, byteSize)`。
5. 设置 `ti._gpuVersion = ti._version`。
6. 绑定：`pass.setVertexBuffer(slot++, ti._gpuBuffer)`。

### 颜色缓冲区（条件：`hasColor && ti.colors`）

1. 比较 `ti._colorVersion !== ti._colorGpuVersion` — 相等则跳过。
2. 计算 `byteSize = ti.count * 16`（4 个 float × 4 字节）。
3. 如果 `ti._colorGpuBuffer` 为 null 或 `ti._colorGpuBuffer.size < byteSize`：
    - 销毁旧缓冲区（如果存在）。
    - 创建新缓冲区：`size = ti._capacity * 16`，`usage = VERTEX | COPY_DST`，启用 GPU 剔除时附加 `STORAGE`。
4. `device.queue.writeBuffer(ti._colorGpuBuffer, 0, ti.colors.buffer, ti.colors.byteOffset, byteSize)`。
5. 设置 `ti._colorGpuVersion = ti._colorVersion`。
6. 绑定：`pass.setVertexBuffer(slot++, ti._colorGpuBuffer)`。

### 返回值

返回更新后的 `slot` 编号——即所有瘦实例缓冲区绑定完成后的下一个可用顶点缓冲区槽位。

---

## 可选 GPU 视锥剔除（`thin-instance-gpu-culling.ts`）

GPU 剔除通过 `enableThinInstanceGpuCulling(mesh)` 按需启用。该辅助函数仅翻转已有 `ThinInstanceData` 上的状态；计算模块仅当某个材质家族中至少有一个网格的 `_gpuCullingEnabled === true` 时，才由 Standard、PBR 和 ShaderMaterial 的组构建器（通过共享的 `thin-instance-cull-binding.ts` 生命周期辅助函数）动态导入。

逐绑定的剔除生命周期被抽离到一个共享模块 `packages/babylon-lite/src/mesh/thin-instance-cull-binding.ts` 中，供三个材质家族以完全相同的方式使用。它的 `tryBind()` 接缝在每个可渲染对象的 `bind()` 中调用：它基于 opt-in 与仅限不透明材质进行门控，创建逐绑定的 `ThinInstanceGpuCullState`，注册其销毁钩子，并返回一个 `TiCullBinding`——其 `update()` 派发计算剔除通道，其 `draw()` 发出 `drawIndexedIndirect`（或在未运行剔除时回退到常规实例化绘制）。

### 适用范围

- 支持：不透明 Standard、不透明 PBR 和不透明 ShaderMaterial 瘦实例。
- 排除：透明瘦实例、透射 PBR 表面（`needsTaskRefraction`）以及任意非实例化网格。
- 该辅助函数必须在 `registerScene()` 之前调用，以便材质组构建器可以导入剔除模块并将可渲染对象标记为直接绘制（direct-drawn）。

### 逐绑定状态

剔除状态归每个 `DrawBinding` 所有，而非 `ThinInstanceData`，因为同一网格可能被多个渲染任务/相机渲染。每个绑定拥有：

| 资源 | 用途 | 目的 |
| --------------------- | --------- | --------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 源矩阵缓冲区 | `VERTEX   | COPY_DST  | STORAGE` | 完整的 CPU 编写实例矩阵列表 |
| 源颜色缓冲区 | `VERTEX   | COPY_DST  | STORAGE` | 完整的 CPU 编写颜色列表（存在时） |
| 可见矩阵缓冲区 | `VERTEX   | STORAGE` | 由计算着色器写入、由顶点着色器读取的紧凑可见矩阵 |
| 可见颜色缓冲区 | `VERTEX   | STORAGE` | 紧凑可见颜色（存在时） |
| 间接参数缓冲区 | `INDIRECT | STORAGE   | COPY_DST` | `[indexCount, visibleInstanceCount, firstIndex, baseVertex, firstInstance]` |
| 参数统一缓冲区 | `UNIFORM  | COPY_DST` | 六个视锥平面、网格世界矩阵、局部包围球、实例计数 |

### 逐帧流程

`RenderTask.prepareRenderTaskPass()` 在 `DrawUpdateContext` 中暴露活跃相机与渲染目标尺寸；剔除模块使用引擎当前的命令编码器来执行计算通道。材质绑定随后在 update 中：

1. 将源矩阵/颜色同步到支持 `STORAGE` 的 GPU 缓冲区。
2. 写入 `instanceCount = 0` 及常量绘制字段的间接参数缓冲区。
3. 从活跃相机的视图-投影矩阵提取六个归一化的世界空间视锥平面。
4. 上传剔除参数，包括 `mesh.worldMatrix` 以及根据 `_cpuPositions` 计算的保守局部包围球。
5. 为每个源实例派发一次计算着色器调用。
6. 计算着色器用 `mesh.world * instanceWorld` 变换局部包围球，测试其与所有平面的相交，原子地将可见实例追加到紧凑缓冲区中，并原子地递增 `args[1]`。
7. 绘制闭包绑定紧凑缓冲区并调用 `drawIndexedIndirect(argsBuffer, 0)`。

启用剔除的不透明可渲染对象仍然兼容渲染束，因为它们的紧凑缓冲区和间接参数缓冲区是稳定的。任何缓冲区替换都会递增全局可见性纪元，强制不透明渲染束在执行前重新录制新的句柄。

### 计算着色器概览

```wgsl
let world = params.meshWorld * srcMatrices[i];
let center = (world * vec4<f32>(params.localSphere.xyz, 1.0)).xyz;
let radius = params.localSphere.w * max(length(world[0].xyz), length(world[1].xyz), length(world[2].xyz));

if (sphereIntersectsFrustum(center, radius)) {
  let outIndex = atomicAdd(&args[1], 1u);
  dstMatrices[outIndex] = srcMatrices[i];
  dstColors[outIndex] = srcColors[i]; // color variant only
}
```

该测试是保守的：与平面相交的球体保持可见。这保证了与未剔除渲染的画面一致性。

### 距离 LOD 配对

`setThinInstanceLodPartner(fullMesh, lodMesh, { distance, band })` 为可选 GPU 剔除器扩展了第二个紧凑输出。两个网格都必须已经具备瘦实例状态，且必须是不同的、不透明的、非透射网格。全细节网格必须是该搭档的唯一源，且两个网格都不得同时参与另一个 LOD 链。LOD 配对的瘦实例状态无法通过 `cloneTransformNode` 共享；请在克隆前配对网格或使用独立的瘦实例数据。`distance` 和 `band` 为有限的非负世界空间数值。

源网格保留比阈值更近的视锥内实例。更远的实例被紧凑写入由搭档网格消费的稳定矩阵/颜色缓冲区及间接参数缓冲区。`band` 应用了范围在 `[-band/2, +band/2]` 内的确定性实例索引哈希，从而在不产生帧间闪烁噪点的情况下平滑过渡。搭档网格保留其自身的几何体和材质管线，但其绘制的矩阵和可选实例颜色来自源网格。因此，渲染实例颜色的搭档同样要求源绘制提供实例颜色。

远距分桶按 `RenderTargetSignature` 发布，因此主渲染、阴影与辅助相机通道永远不会共享紧凑状态。搭档可渲染对象使用直接绘制阶段，并在所有绑定更新和共享计算批次完成之后解析当前分桶；因此场景插入顺序不会引入一帧延迟，也不会在某个不透明渲染束中捕获过时的跨可渲染对象句柄。源可渲染对象保留其常规稳定缓冲区渲染束路径。如果源剔除不可用、被禁用、被隐藏或为空，源网格将回退为绘制所有活跃实例，而配对搭档不绘制任何内容。

配对在 `setThinInstances()` 之后、`registerScene()` 之前配置。对同一对网格重复调用会实时更新 `distance`/`band`。`clearThinInstanceLodPartner()` 会立即使搭档回退到其独立实例绘制；当任一网格被销毁时，配对链接也会自动解除，以确保没有任何绘制会保留已销毁的远距分桶缓冲区。

---

## 管线配置

### 特性标志逻辑

`computeFeatures(material, receiveShadows)` 设置：

```typescript
if (material.disableLighting) f |= DISABLE_LIGHTING;
```

可渲染对象构建器设置：

```typescript
if (mesh.thinInstances) features |= THIN_INSTANCES;
if (mesh.thinInstances.colors) features |= THIN_INSTANCE_COLOR;
```

### 顶点缓冲区布局

基础逐顶点属性使用从 0 开始的连续 `shaderLocation` 值：

| 位置（Location） | 属性 | 格式 | 步长 | 步进模式（Step Mode） |
| ---------- | --------- | ----------- | ------ | --------- |
| 0 | position | `float32x3` | 不等 | vertex |
| 1 | normal | `float32x3` | 不等 | vertex |
| 2 (可选) | uv | `float32x2` | 不等 | vertex |
| next (可选) | uv2 | `float32x2` | 不等 | vertex |

当设置了 `THIN_INSTANCES` 时，追加一个实例化缓冲区布局：

```typescript
{
  arrayStride: 64,        // 4 × vec4<f32> = 4 × 16 bytes
  stepMode: 'instance',
  attributes: [
    { shaderLocation: nextAttr++, offset: 0,  format: 'float32x4' },  // world0 (row 0)
    { shaderLocation: nextAttr++, offset: 16, format: 'float32x4' },  // world1 (row 1)
    { shaderLocation: nextAttr++, offset: 32, format: 'float32x4' },  // world2 (row 2)
    { shaderLocation: nextAttr++, offset: 48, format: 'float32x4' },  // world3 (row 3)
  ],
}
```

当设置了 `THIN_INSTANCE_COLOR` 时，追加另一个实例化缓冲区布局：

```typescript
{
  arrayStride: 16,        // 1 × vec4<f32>
  stepMode: 'instance',
  attributes: [
    { shaderLocation: nextAttr++, offset: 0, format: 'float32x4' },  // instanceColor (RGBA)
  ],
}
```

---

## 着色器逻辑

### 顶点着色器

**实例矩阵属性**（当启用 `THIN_INSTANCES` 时）：

```wgsl
@location(N)   world0: vec4<f32>,
@location(N+1) world1: vec4<f32>,
@location(N+2) world2: vec4<f32>,
@location(N+3) world3: vec4<f32>,
```

**实例颜色属性**（当启用 `THIN_INSTANCE_COLOR` 时）：

```wgsl
@location(M) instanceColor: vec4<f32>,
```

**世界矩阵合成**：

```wgsl
let instanceWorld = mat4x4<f32>(world0, world1, world2, world3);
let finalWorld = mesh.world * instanceWorld;
```

在后续所有顶点变换（位置、法线）中，`finalWorld` 替换 `mesh.world`。

ShaderMaterial 通过可选的 `enableShaderMaterialInstanceWorld(material)` 辅助函数暴露此特化功能。声明了 `"world"` 系统 uniform 的自定义顶点着色器随后可同时为普通网格和瘦实例网格调用 `getFinalWorld(input)`；普通变体返回网格世界矩阵，而无需 `world0..world3`。

ShaderMaterial 同样可以通过 `enableShaderMaterialFinalColor(material)` 选择开启颜色辅助。生成的 `getFinalColor(input)` 根据当前激活的常规/实例化管线布局及其绑定的颜色属性，返回白色、网格顶点颜色、瘦实例颜色或两者的乘积。

**实例颜色透传**（varying）：

```wgsl
// Vertex output struct
@location(K) vInstanceColor: vec4<f32>,

// Vertex main
out.vInstanceColor = instanceColor;
```

### 片元着色器

**常规光照路径**（未设置 `DISABLE_LIGHTING`）：

标准 Blinn-Phong 光照循环（漫反射、镜面反射、环境光、自发光、阴影）。合成后，如果启用了 `THIN_INSTANCE_COLOR`：

```wgsl
color = vec4<f32>(
  color.rgb * input.vInstanceColor.rgb,
  color.a * input.vInstanceColor.a
);
```

**禁用光照路径**（设置了 `DISABLE_LIGHTING`）：

跳过：光照函数定义、光照循环、阴影采样、环境光、反射、光照贴图。输出：

```wgsl
var color = vec4<f32>(
  clamp(emissiveContrib * diffuseColor, vec3<f32>(0.0), vec3<f32>(1.0)) * baseColor.rgb,
  alpha
);
```

然后，如果启用了 `THIN_INSTANCE_COLOR`，应用相同的实例颜色乘法：

```wgsl
color = vec4<f32>(
  color.rgb * input.vInstanceColor.rgb,
  color.a * input.vInstanceColor.a
);
```

---

## 可渲染对象集成（`standard-renderable.ts`）

### tiSync 回调类型

```typescript
type ThinInstanceSync = (
    engine: EngineContextInternal,
    ti: ThinInstanceData,
    pass: GPURenderPassEncoder | GPURenderBundleEncoder,
    slot: number,
    hasColor: boolean,
    drawBuffers?: ThinInstanceDrawBuffers | null
) => number;
```

### 绘制函数

`buildStandardMeshRenderables` 接受一个可选的 `tiSync` 回调。在逐网格的绘制闭包中：

```typescript
const ti = mesh.thinInstances;
if (ti && tiSync) {
    slot = tiSync(engine, ti, pass, slot, hasInstanceColor, cullResult?.drawBuffers ?? null);
    if (cullResult) {
        pass.drawIndexedIndirect(cullResult.argsBuffer, 0);
    } else {
        pass.drawIndexed(g.indexCount, ti.count);
    }
} else {
    pass.drawIndexed(g.indexCount);
}
```

常规路径使用 `drawIndexed(indexCount, instanceCount)`，在单次 GPU 调用中绘制所有实例。剔除路径使用 `drawIndexedIndirect()`，仅绘制经计算着色器紧凑处理后的可见实例。

---

## 动态加载架构（`standard-material.ts`）

### 组构建器

`standardGroupBuilder` 函数在构建时检测瘦实例：

```typescript
const hasTI = meshes.some((m) => !!m.thinInstances);
const hasTICulling = meshes.some((m) => m.thinInstances?._gpuCullingEnabled === true);
let tiSync;
if (hasTI) {
    const mod = await import("../../mesh/thin-instance-gpu.js");
    tiSync = mod.syncThinInstanceBuffers;
}
if (hasTICulling) {
    tiCull = await import("../../mesh/thin-instance-gpu-culling.js");
}
const { buildStandardMeshRenderables } = await import("./standard-renderable.js");
return buildStandardMeshRenderables(scene, meshes, { tiSync, tiFragment, tiCull });
```

这确保了仅当场景实际使用瘦实例时才拉取 `thin-instance-gpu.ts`，且仅当场景显式选择启用时才拉取 `thin-instance-gpu-culling.ts`。

### 打包体积影响

瘦实例特性设计为**对不使用它的场景零打包体积影响**：

| 层级 | 开销 | 加载时机 |
| ------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `thin-instance.ts`（CPU 数据模型） | ~1 KB | 仅当用户导入 `setThinInstances()` 等时加载 |
| `thin-instance-gpu.ts`（GPU 同步） | ~0.9 KB | 动态导入，仅当 `standardGroupBuilder` 检测到瘦实例时加载 |
| `thin-instance-gpu-culling.ts`（计算剔除） | 可选分包 | 动态导入，仅当 `_gpuCullingEnabled` 为 true 时加载 |
| 着色器/管线特性标志检查 | ~400 字节 | 始终存在于标准着色器组合器中（不可避免——特性标志在共享组合函数中检查） |

场景 16 分包明细：`scene16.js` (18.1 KB) + `standard-renderable` (22.5 KB) + `thin-instance-gpu` (0.9 KB) = 共 41.5 KB。

---

## 状态机 / 生命周期

### 初始化

1. 用户为单个网格调用 `setThinInstances(mesh, matrices, count)` / `addThinInstance(mesh, matrix)`，或为道具层级调用 `createHierarchyInstancePool(root, capacity)`。
2. 在 `mesh.thinInstances` 上创建具有初始容量的 `ThinInstanceData`。
3. 可选地，用户调用 `setThinInstanceColors(mesh, colors)` 设置逐实例 RGBA。
4. 可选地，用户在 `registerScene()` 之前调用 `enableThinInstanceGpuCulling(mesh)`。

### 逐帧渲染

```
1. standardGroupBuilder detects mesh.thinInstances
2. Dynamically imports thin-instance-gpu.ts (cached after first load)
3. Retains the shared sync helper for per-frame upload and draw-time binding
4. For each mesh with thinInstances, before cached main/shadow bundles execute:
   a. the renderable update checks _version vs _gpuVersion
   b. Creates / resizes GPU buffer if needed (capacity x 64 bytes for matrices)
   c. writeBuffer from CPU Float32Array → GPU
   d. Bumps _gpuVersion = _version
5. During bundle recording or direct transparent drawing:
   a. setVertexBuffer(slot, stable matrixBuffer); slot++
   b. If hasColor: bind the stable color buffer; slot++
   c. drawIndexed(indexCount, ti.count), or drawIndexedIndirect(argsBuffer, 0) after GPU culling
6. On steady opaque frames, the cached main and shadow bundles reuse those buffer handles and consume
   the contents uploaded by step 4 without re-recording.
```

### 运行时变更

- `addThinInstance` → 满时容量翻倍，复制旧数据，递增 `_version`。
- `removeThinInstance` → 交换移除（O(1)），递增 `_version`。
- `setThinInstanceMatrix` → 原地覆盖 16 个浮点数，递增 `_version`。
- `flushThinInstances` → 仅递增 `_version`（用于直接数组操作）。
- `setThinInstanceColors` → 替换颜色数组，递增 `_colorVersion`。
- `addHierarchyInstance` → 将一个逻辑根矩阵写入每个后代网格缓冲区，并递增所有计数。
- `removeHierarchyInstance` → 从每个后代网格缓冲区中交换移除相同的逻辑槽位。
- `setHierarchyInstanceCount` → 在不重新分配的情况下更改每个后代网格的活跃逻辑计数。

---

## PBR 材质集成

PBR 瘦实例已完整实现。该系统与标准材质路径镜像对应，但使用 ShaderFragment 组合系统：

### 基于片段的集成

`pbr-renderable.ts` 在构建时检测瘦实例并动态导入瘦实例片段：

```typescript
if (meshes.some((m) => !!m.thinInstances)) {
    const { createThinInstanceFragment } = await import("../../shader/fragments/thin-instance-fragment.js");
    fragments.push(createThinInstanceFragment(hasInstanceColor));
    const { syncThinInstanceBuffers } = await import("../../mesh/thin-instance-gpu.js");
    tiSync = syncThinInstanceBuffers;
}
```

### 瘦实例片段（`shader/fragments/thin-instance-fragment.ts`）

该片段提供：

- **顶点属性**：`world0..world3`（实例矩阵行）+ 可选 `instanceColor`
- **顶点槽位**：合成 `finalWorld = mesh.world * instanceWorld` — 在所有后续变换中替换网格世界矩阵
- **片元槽位**：将基础颜色/透明度乘以实例颜色（当设置 `MSH_HAS_INSTANCE_COLOR` 时）

### 绘制路径

```typescript
if (ti && tiSync) {
    slot = tiSync(engine, ti, pass, slot, hasInstanceColor, cullResult?.drawBuffers ?? null);
    if (cullResult) pass.drawIndexedIndirect(cullResult.argsBuffer, 0);
    else pass.drawIndexed(indexCount, ti.count);
}
```

Standard 和 PBR 路径共享相同的 GPU 同步函数（`syncThinInstanceBuffers`）。

### 场景 17

场景 17（`scene17-pbr-std-thin-instances`）验证 PBR 瘦实例：一个带有 2 个瘦实例及逐实例颜色的 PBR 立方体，以及同一场景中的 Standard 材质瘦实例。

---

## Node Material 集成

Node 材质通过 `parseNodeMaterialFromSnippet(engine, id, { hasInstances: true })` 选择开启瘦实例。当节点图到达 `InstancesBlock` 时，其 world 输出声明四个 `float32x4`、步进模式为 `instance` 的属性并求值：

```wgsl
meshU.world * mat4x4<f32>(in.world0, in.world1, in.world2, in.world3)
```

该节点的 `instanceID` 输出读取 `@builtin(instance_index)` 并将其转换为兼容 Babylon 的 `f32` 图数值。如果禁用了实例支持，该节点返回 `meshU.world` 和 `0.0`；既不发出属性也不发出内建变量。

可渲染对象在两个独立阶段中使用共享的瘦实例 GPU 辅助函数：

- 每个不透明数据包更新与每个透明可渲染对象更新在渲染前执行受版本门控的上传；
- 渲染束录制/直接绘制绑定由此得到的稳定矩阵缓冲区，并发出 `drawIndexed(indexCount, thinInstances.count)`。

这种分离是必需的，因为不透明 Node Material 的主渲染束与阴影渲染束都会被缓存：它们的绘制闭包只录制一次，而更新闭包继续每帧运行。两个通道绑定同一个矩阵缓冲区，因此一次预渲染上传就能使当前内容对两者同时可见，无需独立的脏标志或重复写入。GPU 同步模块仅在启用 `hasInstances` 时于解析期间动态导入，并保留在该材质上。因此普通节点材质场景不包含瘦实例上传代码。逐实例颜色与 GPU 剔除不属于节点材质的可选范围。

Node 数据包所有权对普通网格和瘦实例网格遵循相同的同步可见性 / 延迟 GPU 退役拆分。主场景数据包销毁器同时可从 `scene._meshDisposables` 和场景生命周期注册表访问，从而使部分构建的场景仍能安全清理。移除或同步重建网格会注销重复的场景生命周期引用，立即取消其数据包链接，并在最后一个数据包离开时消费该组的单次 owner-empty 回调。因此空的合并可渲染对象永远无法到达绑定阶段，生命周期注册表也不会滞留已退役的网格。数据包回调对共享 Node UBO 进行引用计数，仅在最后一个网格资源退役后销毁它，然后注销其幂等的场景生命周期兜底项。

辅助可渲染对象则将每次分配注册到调用方的 `MeshRebuildResources._lifetimeDisposers` 汇点中，从不获取主场景所有权。Node 构建会在发布前追踪所有分配：如果后续任何绑定组或特性绑定步骤抛出异常，在错误传播前会释放每个未发布的缓冲区并移除任何临时主网格注册。

---

## Babylon.js 等价映射表

| Babylon Lite | Babylon.js |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `setThinInstances(mesh, matrices, count)` | `mesh.thinInstanceSetBuffer("matrix", data, 16)` |
| `setThinInstanceColors(mesh, colors)` | `mesh.thinInstanceSetBuffer("color", data, 4)` |
| `enableThinInstanceGpuCulling(mesh)` | 无直接核心等价物；类似于在瘦实例绘制前执行引擎级自定义 GPU 剔除 |
| `addThinInstance(mesh, matrix)` | `mesh.thinInstanceAdd(matrix)` |
| `removeThinInstance(mesh, index)` | `mesh.thinInstanceRemove(index)` |
| `setThinInstanceMatrix(mesh, index, matrix)` | `mesh.thinInstanceSetMatrixAt(index, matrix)` |
| `flushThinInstances(mesh)` | `mesh.thinInstanceBufferUpdated("matrix")` |
| `material.disableLighting = true` | `material.disableLighting = true` |
| `THIN_INSTANCES` 特性标志 | 内部 `#define THIN_INSTANCES` |
| `THIN_INSTANCE_COLOR` 特性标志 | 内部 `#define THIN_INSTANCE_COLOR` |
| 通过顶点属性传递逐实例颜色 | 通过顶点属性传递逐实例颜色 |
| `finalWorld = mesh.world * instanceWorld` | `finalWorld = world * instanceWorld` |
| 使用 `copyWithin` 的交换移除 | 使用缓冲区操作的交换移除 |
| GPU 同步模块的动态导入 | 始终加载（无代码拆分） |

**相同的数学逻辑，极简的代码。** 没有类继承体系——只有类型化数组、版本计数器和一个 GPU 同步函数。

---

## 依赖项

- WebGPU 实例化绘制（`drawIndexed(indexCount, instanceCount)`）
- WebGPU 间接索引绘制（`drawIndexedIndirect(argsBuffer, 0)`），用于 GPU 剔除后的瘦实例
- 用于可选剔除的 WebGPU 计算着色器与存储缓冲区
- WebGPU 顶点缓冲区 `stepMode: 'instance'`
- 用于 CPU → GPU 传输的 `device.queue.writeBuffer`
- Standard 材质着色器组合（特性标志驱动的 WGSL 生成）
- 用于懒加载分包的动态 `import()`

---

## 测试规范

| 测试 | 描述 |
| ----------------------- | ---------------------------------------------------------------------------------- |
| 场景 16 一致性 | 64K 彩色立方体与 Babylon.js 参考结果的像素对比 |
| 实时参考 | 打开 `babylon-ref-scene16.html`，捕获 `live-ref.png`，并与 Lite 对比 |
| Golden 回退 | 若实时捕获失败，则回退到 `babylon-ref-golden.png` |
| MAD 阈值 | 全图平均绝对误差（MAD）≤ 1 |
| 精确匹配率 | ≥ 95% 的像素必须精确匹配 |
| 容量增长 | `addThinInstance` 超出初始容量 → 数组翻倍，保留现有数据 |
| 交换移除正确性 | `removeThinInstance(i)` → 最后一个实例移至槽位 `i`，计数减 1 |
| 版本跳过 | 静态实例：当 `_version === _gpuVersion` 时跳过 GPU 上传 |
| 颜色独立性 | 矩阵变更不会触发颜色重传（独立版本计数器） |
| 纯计数绘制更新 | 活跃计数变化更新绘制参数，但不弄脏矩阵或颜色缓冲区 |
| 零成本加载 | 不含瘦实例的场景从不拉取 `thin-instance-gpu.js` 分包 |

---

## 文件清单

| 文件 | 用途 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/mesh/thin-instance.ts` | CPU 侧数据模型 + 公共 API（`ThinInstanceData`、`setThinInstances` 等） |
| `src/mesh/thin-instance-gpu.ts` | GPU 缓冲区同步 — 懒加载分包（`syncThinInstanceBuffers`） |
| `src/mesh/thin-instance-gpu-culling.ts` | 可选计算视锥剔除 + 紧凑可见缓冲区 + 间接参数 |
| `src/material/standard/standard-material.ts` | `disableLighting` 属性 + 带动态同步加载的 `standardGroupBuilder` |
| `src/material/standard/standard-pipeline.ts` | `THIN_INSTANCES`、`THIN_INSTANCE_COLOR`、`DISABLE_LIGHTING` 标志 + 管线顶点缓冲区布局 |
| `src/material/standard/standard-template.ts` | `instanceColor` varying + `disableLighting` 片元路径 + 实例世界矩阵合成 |
| `src/material/standard/standard-renderable.ts` | `tiSync` 回调集成 + 实例化 `drawIndexed` / `drawIndexedIndirect` |
| `src/material/mesh-features.ts` | `MSH_HAS_THIN_INSTANCES`、`MSH_HAS_INSTANCE_COLOR` 特性标志常量 |
| `src/material/pbr/pbr-renderable.ts` | PBR 瘦实例检测、片段/剔除加载、实例化绘制 |
| `src/material/pbr/pbr-pipeline.ts` | 瘦实例的 PBR 管线顶点缓冲区布局 |
| `src/material/node/blocks/instances-block.ts` | 节点图实例世界矩阵属性与 `instanceID` 内建量 |
| `src/material/node/node-material.ts` | Node 材质瘦实例选择启用及懒加载 GPU 同步 |
| `src/material/node/node-renderable.ts` | Node 材质矩阵绑定与实例化绘制 |
| `src/shader/fragments/thin-instance-fragment.ts` | 用于实例矩阵/颜色的 ShaderFragment — 由 PBR 和 Standard 共享 |
| `lab/lite/src/lite/scene16.ts` | 参考/验证场景：40x40x40 = 64K 彩色立方体，带可选 GPU 剔除 |
| `lab/lite/src/lite/scene17.ts` | 参考/验证场景：同一场景中的 PBR + Standard 瘦实例，均启用剔除 |
| `lab/lite/src/lite/scene35.ts` | 参考/验证场景：带可选 GPU 剔除的 glTF `EXT_mesh_gpu_instancing` |
| `tests/lite/parity/scene16-thin-instances.spec.ts` | Standard 瘦实例的一致性测试 |
| `tests/lite/parity/scene17-pbr-std-thin-instances.spec.ts` | PBR + Standard 瘦实例的一致性测试 |

---

## 限制

- **不支持逐实例自定义数据** — 仅支持世界矩阵和 RGBA 颜色作为实例属性。
- **交换移除会重排实例** — 移除实例会改变最后一个实例的索引。管理外部索引映射的调用方必须考虑这一点。
- **每个颜色最多 4 个浮点数** — 仅支持 RGBA，不支持 HDR 或扩展的逐实例数据。
- **GPU 剔除为可选开启** — 必须在 `registerScene()` 之前调用 `enableThinInstanceGpuCulling(mesh)`。
- **v1 中 GPU 剔除仅限不透明材质** — 透明与透射瘦实例使用常规绘制路径。
- **GPU 剔除对实例顺序的紧凑化是非确定性的** — 对不透明渲染完全正确，但不适用于透明排序。
