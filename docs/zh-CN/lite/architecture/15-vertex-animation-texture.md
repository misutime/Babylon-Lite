# 模块：顶点动画纹理（Vertex Animation Texture / VAT）

> 包路径：`packages/babylon-lite/src/vat/`（烘焙器 + 运行时）、`packages/babylon-lite/src/material/pbr/fragments/vat-fragment.ts`（GPU 顶点路径）

## 用途

在 CPU 上预求值蒙皮网格的骨骼动画，并将每一帧的骨骼矩阵烘焙到单张 `rgba32float` 纹理（即**顶点动画纹理 / VAT**）中，随后在渲染网格时从该纹理对应当前帧的行读取骨骼矩阵——**无需实时 CPU 骨骼，也无需逐帧上传骨骼矩阵**。由于省去了逐帧骨骼计算工作，已烘焙的网格可以进行 **GPU 瘦实例化**：每个实例均可从同一张共享纹理中播放各自独立的动画片段与相位（还可以混合两个片段以实现平滑交叉淡入淡出），从而使整群动画网格在单次绘制调用中渲染并投射 CSM 阴影。

严格按需启用并懒加载导入：从未烘焙 VAT 的场景永远不会加载此模块，且共享的 PBR 可渲染对象不携带任何特定于 VAT 的代码（VAT 扩展在 `attachVat` 运行时自注册），因此**非 VAT 场景在字节层面完全不变**。

其 API 形态镜像自 Babylon.js 的 `VertexAnimationBaker` / `BakedVertexAnimationManager`，并针对 Lite/WebGPU 进行了适配。

## 公共 API 表面

### 函数（`vat/vat-baker.ts`）

```typescript
export function bakeVat(engine: EngineContext, mesh: Mesh, groups: AnimationGroup[], opts?: VatBakeOptions): VatBakeResult;
export function bakeVatMany(engine: EngineContext, targets: readonly VatBakeTarget[], groups: readonly AnimationGroup[]): VatBakeResult[];
export function prepareVat(mesh: Mesh, groups: AnimationGroup[], opts?: VatBakeOptions): PreparedVatBakeResult;
export function prepareVatMany(targets: readonly VatBakeTarget[], groups: readonly AnimationGroup[]): PreparedVatBakeResult[];
export function createVatBakeResult(engine: EngineContext, prepared: PreparedVatBakeResult): VatBakeResult;
export function createVatBakeResults(engine: EngineContext, prepared: readonly PreparedVatBakeResult[]): VatBakeResult[];
export function attachVat(engine: EngineContext, mesh: Mesh, baked: VatBakeResult, clip?: string): VatHandle;
export function setVatInstanceStorage(engine: EngineContext, mesh: Mesh, buffer: StorageBuffer | null): void;
export function setVatTime(engine: EngineContext, mesh: Mesh, seconds: number): void;
```

- **`bakeVat`** — 逐帧求值 `groups` 中的每个片段（网格必须仍保留其实时的 `mesh.skeleton`），将骨骼矩阵堆叠到一张 `rgba32float` 纹理中：宽度为 `boneCount*4`，高度 = 总帧数，每行对应一个动画帧。返回该纹理以及逐片段的行范围映射。
- **`prepareVat` / `prepareVatMany`** — 在无需 GPU 设备或纹理分配的情况下执行相同的 CPU 求值，生成可持久化的 `Float32Array` 载荷以供离线预处理。
- **`createVatBakeResult` / `createVatBakeResults`** — 校验并上传预处理载荷。字节完全相同的批量条目共享同一张带引用计数的纹理；部分上传失败会销毁此次调用分配的所有纹理。
- **`attachVat`** — 设置 `mesh.vat`，将 `mesh.skeleton` 置为 `null`（不再进行实时蒙皮），构建 32 字节设置 UBO，自注册 VAT `pbrExt`，并返回一个 `VatHandle`。`clip` 选择初始片段（默认为首个已烘焙片段）。

### 类型（`vat/vat-baker.ts`）

```typescript
export interface VatClip {
    readonly fromRow: number;
    readonly frameCount: number;
    readonly fps: number;
}

export interface VatBakeResult {
    readonly texture: GPUTexture; // rgba32float, (boneCount*4) x frameCount
    readonly boneCount: number;
    readonly frameCount: number;
    readonly clips: Record<string, VatClip>; // clip name -> row range
    readonly boneOrigins?: Record<number, Float32Array>;
    readonly boneMatrices?: Record<number, Float32Array>;
    /** @internal */ readonly _textureResource: { readonly texture: GPUTexture; _refCount?: number };
}

export interface PreparedVatBakeResult {
    readonly boneCount: number;
    readonly frameCount: number;
    readonly data: Float32Array;
    readonly clips: Readonly<Record<string, VatClip>>;
    readonly boneOrigins?: Readonly<Record<number, Float32Array>>;
    readonly boneMatrices?: Readonly<Record<number, Float32Array>>;
}

export interface VatHandle {
    readonly mesh: Mesh;
    readonly clips: Record<string, VatClip>;
    play(clip: string, opts?: { offset?: number; fps?: number }): void; // shared (non-instanced) playback
    update(dtSeconds: number): void; // advance the shared clock
    setInstances(params: Float32Array): void; // per-instance single clip (4 floats/inst)
    setInstancesBlend(params: Float32Array): void; // per-instance dual-clip blend (8 floats/inst)
}
```

### 内部类型（`animation/types.ts`，未导出 — 与 `SkeletonData` 类似）

```typescript
export interface VatData {
    boneCount: number;
    texture: GPUTexture; // the baked bone texture
    frameCount: number;
    settingsBuffer: GPUBuffer; // 32-byte UBO: params vec4 + clock vec4
    jointsBuffer: GPUBuffer; // reused from the (now-dropped) skeleton
    weightsBuffer: GPUBuffer;
    joints1Buffer: GPUBuffer | null; // 8-bone
    weights1Buffer: GPUBuffer | null;
    instanceTexture?: GPUTexture | null; // per-instance params ((2*instanceCount) x 1, two texels/instance)
}
```

### 网格特性位（`material/mesh-features.ts`）

```typescript
export const MSH_VAT = 1 << 9; // mesh.vat present — the ONLY VAT mesh-feature bit
// "Instanced VAT" needs NO dedicated bit: it is derived in the fragment from
//   (MSH_VAT && MSH_HAS_THIN_INSTANCES)
// so mesh-features.ts (a shared chunk fetched by every scene) is byte-identical for non-VAT scenes
// (zero bundle movement). 8-bone uses the existing MSH_HAS_SKELETON_8.
```

## 内部架构

### 烘焙纹理格式（与实时骨骼纹理完全一致）

逐行布局与 `skeleton/create-skeleton.ts` 完全匹配——每根骨骼 4 个纹素（每列占一个 mat4 列向量），因此 `VAT(frame N)` 能以完整浮点精度复现第 N 帧的实时姿势（相对实时骨骼的一致性 MAD ≈ 0.000）：

- **尺寸**：`[boneCount * 4, frameCount]`（宽 × 高），`rgba32float`。
- **第 r 行** = 动画帧 `r` 的所有骨骼矩阵（16 浮点数/骨骼 = 4 个纹素）。
- **用途**：`TEXTURE_BINDING | COPY_DST`。通过 `writeTexture` 一次性上传（bytesPerRow = `boneCount*4*16`）。

### 预处理与上传

`bakeVat` 和 `bakeVatMany` 组合了以下两个显式阶段：

1. `prepareVat` / `prepareVatMany` 完全在 CPU 上求值动画，并返回矩阵行以及片段/捕获元数据。它们不分配也不上传 GPU 资源。
2. `createVatBakeResult` / `createVatBakeResults` 校验预处理维度、片段与可选捕获轨道，然后按确切的类型化数组字节偏移上传 `data`。返回的 `VatBakeResult` 对象不保留 CPU `data` 载荷。

这一拆分使构建工具可以持久化预处理后的字节数据，并将 GPU 上传推迟到运行时，同时无需改变 `attachVat` 所消费的纹理布局。

### 烘焙（`bakeVat`）

`clipFrameCount(group) = round(group.duration * group.frameRate) + 1`。各片段按连续行块排列（片段 0 在前）；`clips[name] = { fromRow, frameCount, fps }`。对于每一帧：`goToFrame(group, f, engine)` 驱动控制器求值，然后从 `SkeletonBinding`（`group._gltfMixer[2][0].boneMatrices`）读取该帧的矩阵并复制到对应行中。每个片段烘焙完成后调用 `stopAnimation(group)`（由 VAT 接替实时播放）。

### 设置 UBO（32 字节，`attachVat`）

```
params: vec4<f32> = (fromRow, toRow, frameOffset, fps)   // shared/non-instanced playback
clock:  vec4<f32> = (elapsedSeconds, _, _, _)            // advanced by update()
```

`play(name, opts)` 写入 `params`；`update(dt)` 累加 `clock.x`。两者均向 32 字节 UBO 执行 `writeBuffer`。

### 逐实例参数纹理（`setInstances` / `setInstancesBlend`）

一张单独的 `rgba32float` 纹理，尺寸为 `texels × 1`，在顶点着色器中通过 `@builtin(instance_index)` 读取。选择纹理而非存储缓冲区 / uniform 数组 / 顶点属性，是为了**不引入新的绑定类型、不造成管线碎片化，且对共享实例化/绘制路径零改动**——它像骨骼纹理一样直接搭乘现有的 VAT 绑定钩子。

- **`setInstances`**（单片段）：`params.length = 4 * instanceCount` = 每个实例 `(fromRow, toRow, timeOffset, fps)`。内部展开为双片段布局（片段 B == A，blend 为 0），因此只需一个实例化着色器变体。
- **`setInstancesBlend`**（双片段）：`params.length = 8 * instanceCount` — 纹素 `2i` = A `(fromRow, toRow, offset, fpsA)`，纹素 `2i+1` = B `(fromRow, toRow, blend, fpsB)`（B 复用 A 的偏移）。`blend` 在 `[0,1]` 内将 A→B 线性插值。**纹理始终为每个实例分配两个纹素。**

纹理原地扩容（容量以纹素计）；共享时钟统一驱动整个人群，而逐实例偏移量则错开各自的相位。

## 管线配置

VAT `pbrExt`（`vat-fragment.ts`）是一个**顶点阶段** PBR 扩展。它由 `attachVat` 通过 `_registerPbrExt` **自注册**（与 `enableMaterialPlugins` 模式相同）——共享的 `pbr-renderable` 不导入任何 VAT 代码。`pbrExt.frag(ctx)` 受 `MSH_VAT` 门控，并返回对应变体 `(has8Bones, instanced)` 的片段，其中 `instanced = (ctx._meshFeatures & MSH_HAS_THIN_INSTANCES)`（无专门的 VAT 实例化位）。

### Group-1 顶点绑定（由 `pbrExt.bind` 按声明顺序推入）

| 绑定 | 资源 | 条件 |
| ------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| b | `vatSampler` — `texture_2d<f32>`（`unfilterable-float`），顶点可见 | 始终存在（MSH_VAT） |
| b+1 | `vat` — uniform 缓冲区（设置 UBO） | 始终存在 |
| b+2 | `vatInstanceTex` — `texture_2d<f32>`（`unfilterable-float`） | `MSH_VAT && MSH_HAS_THIN_INSTANCES`（已设置 instanceTexture） |

### 顶点属性 / 内建变量

- 复用骨骼顶点属性：`joints`/`weights`（`uint32x4`/`float32x4`），8 骨骼时加上 `joints1`/`weights1`。
- 实例化变体通过 `_vertexBuiltins` 请求 `@builtin(instance_index)`（仅存在于实例化片段中，因此非实例化 VAT 保持不变）。
- 实例化片段声明 `_dependencies: ["thin-instance"]`，使其在共享 `VW` 顶点槽位中组合在瘦实例片段**之后**——否则瘦实例的 `finalWorld` 写入会覆盖蒙皮+实例化后的变换。它从 `world0..3`（由瘦实例片段声明）中读取逐实例世界矩阵。

### 阴影投射（免费获得）

CSM 投射器（`shadow/csm-shadow-task-hooks.ts`）通过每个投射网格**自身的**材质可渲染对象配合无颜色视图进行渲染。该可渲染对象会自动根据网格特性组合 VAT 扩展，因此 VAT（包括实例化）网格无需任何阴影通道改动即可在阴影贴图中产出准确的逐姿势深度。

## 着色器逻辑（顶点 `VW` 槽位，WGSL 概览）

```
fn vatFrameRow(p: vec4f, t: f32) -> i32:        // p = (fromRow, toRow, offset, fps)
    span = max(1, p.y - p.x + 1)
    raw  = p.z + t * p.w
    return i32(p.x + (raw - floor(raw / span) * span))   // wrap into [fromRow, toRow]

fn readMatrixFromVat(smp, index, row) -> mat4x4f:        // 4 texels at (index*4 + col, row)

// Variant A — non-instanced (shared UBO):
vatRow = vatFrameRow(vat.params, vat.clock.x)
influence = sum_k readMatrixFromVat(vatSampler, joints[k], vatRow) * weights[k]   // 4 or 8 bones
finalWorld = mesh.world * influence

// Variant B — instanced (ALWAYS the dual-clip path; single-clip is the blend==0 case):
A = textureLoad(vatInstanceTex, (2*instance_index,   0))
B = textureLoad(vatInstanceTex, (2*instance_index+1, 0))
rowA = vatFrameRow(A, clock); rowB = vatFrameRow((B.xy, A.z, B.w), clock)
infA = sum_k read(joints[k], rowA)*w[k]; infB = sum_k read(joints[k], rowB)*w[k]
influence = infA*(1 - B.z) + infB*B.z                     // weighted bone-matrix blend == gait cross-fade
finalWorld = mat4(world0..3) * mesh.world * influence     // instance OUTERMOST = world-space placement
```

由于蒙皮网格的 `mesh.world` 为单位矩阵（glTF 加载器，参见 `12-thin-instances.md` §world-matrix），实例矩阵承载了全部空间放置信息（位置/偏航角/缩放）。唯一的实例化变体始终运行双片段混合路径（单片段即 blend = 0 的情况），因此**无需额外的网格特性位，且对非 VAT 场景没有任何打包体积迁移**；相较于单次绘制调用带来的巨大收益，2× 骨骼读取的开销微不足道。

## 状态机 / 生命周期

1. 加载并动画化一个蒙皮 glTF（存在实时骨骼）。
2. 直接调用 `bakeVat(engine, mesh, groups)`，或先调用 `prepareVat(mesh, groups)` 再于之后调用 `createVatBakeResult(engine, prepared)`。
3. `attachVat(engine, mesh, baked, clip?)` → 设置 `mesh.vat`，`mesh.skeleton = null`，并注册 VAT 扩展。
4. （可选）在 `registerScene` 之前调用 `setThinInstances(mesh, matrices, count)` + `handle.setInstances`/`setInstancesBlend(params)`（首次调用设置 `instanceTexture`，从而选中实例化着色器变体）。随后可原地重新上传逐实例参数。
5. 每帧：`handle.update(dt)` 推进共享时钟；当模拟状态变化时，通过瘦实例/VAT 设置器更新逐实例矩阵/参数。

## Babylon.js 等价映射表

| Babylon.js | Lite VAT |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `VertexAnimationBaker.bakeVertexData(ranges)` | `bakeVat(engine, mesh, groups)` |
| `BakedVertexAnimationManager` (`manager.time`, `setAnimationParameters`) | `VatHandle`（`update`、`play`） |
| `mesh.bakedVertexAnimationManager` | `mesh.vat`（`VatData`） |
| `manager.texture`（VAT 纹理） | `VatBakeResult.texture` / `VatData.texture` |
| 通过 `bakedVertexAnimationSettingsInstanced` 缓冲区传递逐实例参数 | `setInstances` / `setInstancesBlend` → `instanceTexture`（按 `instance_index` 读取） |

## 依赖项

- `animation/animation-group.ts` — `goToFrame`、`stopAnimation`、`SkeletonBinding`（烘焙时读取）。
- `skeleton/create-skeleton.ts` — 实时骨骼纹理，VAT 镜像了其逐行布局；VAT 复用骨骼的关节/权重顶点缓冲区。
- `material/pbr/pbr-flags.ts` — `_registerPbrExt`、`PbrExt`（`frag`/`bind`）。
- `material/mesh-features.ts` — `MSH_VAT*` 检测。
- `shader/fragments/thin-instance-fragment.ts` — 声明 `world0..3`（实例化变体依赖它）。
- 用于投射阴影的 CSM 投射路径（无代码依赖；通过材质可渲染对象复用自动生效）。

## 测试规范

- **一致性（`tests/lite/parity/scenes/scene218-vat.spec.ts`）** — 场景 218 烘焙场景 11 的鲨鱼，并在**没有**实时骨骼的情况下通过 VAT 路径渲染；Golden 图像为冻结在同一整数帧（`?seekTime`）的 BJS 实时骨骼参考结果。断言全图 MAD ≤ `scene-config.maxMad`（0.02）。由于 `VAT(frame N) == live(frame N)`，实际 MAD ≈ 0.000。
- **单元测试（`tests/lite/unit/vat-baker.test.ts`）** — 覆盖纯 CPU 预处理、预处理载荷校验、非零类型化数组上传偏移、捕获往返、纹理去重/引用计数、上传失败清理，并确认已上传结果不保留 CPU 载荷。
- **手动 / 实验场景（`lab/lite/scene219.ts`）** — 36 只瘦实例化的已烘焙鲨鱼，在网格间混合游动↔盘旋动画并投射 CSM 阴影，每通道仅一次绘制调用。（开发场景；非一致性测试场景——实例化 VAT 没有对应的单网格 BJS 参考用例。）
- **打包体积** — 非 VAT 场景字节完全不变（自注册机制）；VAT 场景包仅包含懒加载导入的 `vat` 分包。

## 文件清单

```
packages/babylon-lite/src/vat/vat-baker.ts                          # prepare/upload/bake APIs, attachVat, VatHandle
packages/babylon-lite/src/material/pbr/fragments/vat-fragment.ts    # pbrExt + 2 vertex variants (non-instanced / instanced dual-clip)
packages/babylon-lite/src/animation/types.ts                        # VatData (internal)
packages/babylon-lite/src/material/mesh-features.ts                 # MSH_VAT (the only VAT feature bit; instanced derived from MSH_HAS_THIN_INSTANCES)
packages/babylon-lite/src/mesh/mesh.ts                              # mesh.vat field
packages/babylon-lite/src/index.ts                                  # exports all public VAT preparation, upload, bake, and runtime APIs
lab/lite/scene218.html + src/lite/scene218.ts                       # single-mesh VAT parity scene
lab/lite/scene219.html + src/lite/scene219.ts                       # instanced + blended + shadowed crowd (dev)
tests/lite/parity/scenes/scene218-vat.spec.ts                       # parity test
tests/lite/unit/vat-baker.test.ts                                   # prepared-payload and runtime ownership tests
```
