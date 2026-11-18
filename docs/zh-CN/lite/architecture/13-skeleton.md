# 模块：骨骼（Skeleton）

> 包路径：`packages/babylon-lite/src/skeleton/`

## 用途

提供 GPU 加速的骨骼动画基础设施。从解析后的 glTF 蒙皮数据创建骨骼纹理和顶点缓冲区，并提供逐帧骨骼矩阵求值与 GPU 上传。支持 4 骨骼与 8 骨骼蒙皮路径。骨骼系统按懒加载方式导入——不含蒙皮网格的场景永远不会加载该模块。

## 公共 API 表面

### 可选的骨骼发现

```typescript
interface Bone {
    readonly name: string;
    /** Nearest ancestor joint in the same skin, skipping non-joint nodes. */
    readonly parent: Bone | null;
}

function getMeshSkeleton(mesh: Mesh): Skeleton | undefined;
```

请在加载 glTF 蒙皮**之前**启用 `enableBoneControl()` 或 `enableBoneControlForSkinnedAssets()`。该可选构建器会按 glTF 关节顺序创建骨骼，随后通过沿节点祖先链向上回溯直到找到同一蒙皮中的另一个关节来解析每根骨骼的父级；根骨骼的 `parent: null`。数组索引即骨骼索引，不存在单独的 `Bone.index`。不支持链接的场景节点。

构建器在每个绑定上将直接的内部引用 `SkeletonData._skeleton` 与现有的 `_overrides` 一并写入。`getMeshSkeleton` 直接读取 `mesh.skeleton?._skeleton`，不使用注册表。对于非蒙皮网格、未启用骨骼控制时加载的蒙皮、USD 蒙皮以及手工编写的骨骼数据，它返回 `undefined`，且不会为后者创建公共包装对象。

要进行枚举，可遍历 `scene.meshes`，调用 `getMeshSkeleton`，并按 `Skeleton` 对象身份去重。共享运行时骨骼数据的克隆体会共享公共句柄与覆盖状态。设备丢失恢复通过 `Object.assign` 替换 GPU 字段，而不会覆写可选的关联引用。骨骼及其父级引用保持稳定。现有的 `setBoneVisible` 和 `clearBoneOverride` 提供隐藏/显示与重置能力；请使用 `setMeshVisible` 而非直接赋值网格可见性。

在可选构建器中，发现功能仅花费每根骨骼一个父引用以及每个绑定一次关联写入的开销。未启用骨骼控制的场景不会创建这些句柄。专项发现测试覆盖了跳过非关节祖先节点、乱序关节、根节点、关联身份、克隆体、不可用句柄以及恢复式赋值。无需任何着色器或渲染改动。

### 函数

```typescript
// create-skeleton.ts
export function createSkeleton(
    engine: EngineContext,
    joints: Uint16Array | Uint8Array, // 4 joint indices per vertex (JOINTS_0)
    weights: Float32Array, // 4 blend weights per vertex (WEIGHTS_0)
    boneCount: number, // number of bones (joints)
    boneData: Float32Array, // initial bone matrices (16 floats per bone)
    joints1?: Uint16Array | Uint8Array | null, // JOINTS_1 for 8-bone skinning
    weights1?: Float32Array | null // WEIGHTS_1 for 8-bone skinning
): SkeletonData;
```

```typescript
// update-skeleton-bone-matrices.ts
export function updateSkeletonBoneMatrices(engine: EngineContext, skeleton: SkeletonData, boneMatrices: Float32Array): void;
```

`updateSkeletonBoneMatrices()` 会校验矩阵数量，更新骨骼的 CPU 镜像，并上传完整的矩阵集合，而无需向场景代码暴露底层的 `GPUTexture`。

```typescript
// skeleton-updater.ts
export interface AnimationController {
    tick(deltaMs: number, device: GPUDevice): void;
    time: number; // current playback time in seconds
    playing: boolean;
    speedRatio: number; // default 1
    loop: boolean; // default true
    readonly _debugWorldMat?: Float32Array;
    readonly _debugNodeNames?: string[];
}

export function createAnimationController(animData: GltfAnimationData): AnimationController;
```

### 类型（来自 `animation/types.ts`）

```typescript
export interface SkeletonData {
    readonly boneTexture: GPUTexture;
    readonly boneCount: number;
    readonly jointsBuffer: GPUBuffer;
    readonly weightsBuffer: GPUBuffer;
    readonly joints1Buffer: GPUBuffer | null;
    readonly weights1Buffer: GPUBuffer | null;
}
```

## 内部架构

### 骨骼纹理格式

每根骨骼以 4×4 矩阵形式存储在一张一维 `rgba32float` 纹理中：

- **纹理尺寸**：`[boneCount * 4, 1]`（宽 × 高）
- **布局**：每根骨骼占 4 个纹素（每列占 1 个纹素），每个纹素 = rgba32float（4 个浮点数）
- **总计**：每根骨骼 16 个浮点数 = 每根骨骼 64 字节
- **用途标志**：`TEXTURE_BINDING | COPY_DST`

顶点着色器使用 `textureLoad(boneTex, vec2<i32>(boneIdx * 4 + col, 0), 0)` 采样该纹理以重建骨骼矩阵。

### 顶点缓冲区布局

由于管线读取 `uint32x4` 顶点格式，关节索引会从 `Uint8Array`/`Uint16Array` 扩展为 `Uint32Array`。关节缓冲区与权重缓冲区均使用：

- **用途**：`VERTEX | COPY_DST`
- **最小尺寸**：4 字节（满足 WebGPU 最小缓冲区尺寸要求）
- **创建时映射**：通过 `mappedAtCreation: true` 拷贝数据以高效上传

### 4 骨骼 vs 8 骨骼蒙皮

- **4 骨骼**：使用 `JOINTS_0` + `WEIGHTS_0` → `jointsBuffer` + `weightsBuffer`
- **8 骨骼**：额外使用 `JOINTS_1` + `WEIGHTS_1` → `joints1Buffer` + `weights1Buffer`
- 检测方式：检查 `joints1`/`weights1` 参数是否存在（来源于 glTF `JOINTS_1`/`WEIGHTS_1` 属性）
- 骨骼 `ShaderFragment` 会为 4 骨骼与 8 骨骼生成不同的 WGSL 代码

### 逐帧骨骼矩阵计算 — `skeleton-updater.ts`

`AnimationController.tick()` 方法每帧执行以下步骤：

#### 1. 重置为静止姿势（Rest Pose）

将静止姿势 TRS 从 `GltfAnimationData.nodes[]` 拷贝到预分配的 `currentTRS` 暂存缓冲区中。
每个节点的布局：12 个浮点数（`TRS_STRIDE = 12`）：

- `[0..2]` = 平移（T_OFF = 0）
- `[3..6]` = 旋转四元数 xyzw（R_OFF = 3）
- `[7..9]` = 缩放（S_OFF = 7）
- `[10..11]` = 填充

#### 2. 求值动画通道

对于活跃片段中的每个通道，在当前时间 `t` 处对其采样器求值：

- `PATH_TRANSLATION`：`evaluateSampler(sampler, t, 3, false, currentTRS, base + T_OFF)`
- `PATH_ROTATION`：`evaluateSampler(sampler, t, 4, true, currentTRS, base + R_OFF)`
- `PATH_SCALE`：`evaluateSampler(sampler, t, 3, false, currentTRS, base + S_OFF)`
- `PATH_WEIGHTS`：求值变形目标权重并上传到 GPU 缓冲区（前 16 字节 = 权重 vec4）

#### 3. 局部 → 世界矩阵计算

按拓扑顺序（父节点先于子节点）处理节点：

```
for each node in topoOrder:
    localMat[node] = compose(translation, rotation, scale)
    if node has parent:
        worldMat[node] = worldMat[parent] * localMat[node]
    else:
        worldMat[node] = RH_TO_LH * localMat[node]   // root: apply handedness fix
```

`RH_TO_LH` 矩阵为 `diag(-1, 1, 1, 1)` — 将 glTF 右手坐标系转换为 BJS 左手坐标系。

拓扑顺序在初始化时通过 `computeTopoOrder()` 使用迭代 DFS 计算一次。

#### 4. 骨骼矩阵上传

对于每个骨骼绑定：

```
for each bone i:
    boneMatrix[i] = invMeshWorld * worldMat[jointNode[i]] * inverseBindMatrix[i]
```

使用预分配的 `boneScratch` 数组原地执行矩阵乘法：

1. `multiplyMat4IntoBuffer(boneData, bi*16, invMeshWorld, 0, worldMat, jointIdx*16)` — temp = invMeshWorld × jointWorld
2. 手动 4 列矩阵乘法：temp × IBM → boneData[bi*16]

通过以下调用上传：`device.queue.writeTexture({ texture: boneTexture }, boneData.buffer, { bytesPerRow: texWidth * 16 }, { width: texWidth, height: 1 })`

### 预分配暂存缓冲区

所有暂存内存均在 `createAnimationController()` 中一次性分配：

- `currentTRS`：`Float32Array(numNodes * TRS_STRIDE)` — 每个节点的动画 TRS
- `localMat`：`Float32Array(numNodes * 16)` — 局部变换矩阵
- `worldMat`：`Float32Array(numNodes * 16)` — 世界变换矩阵
- `boneScratch`：每套骨骼一个 `Float32Array(boneCount * 16)` — 骨骼矩阵输出
- `morphWeightScratch`：`Float32Array(8)` — 临时变形权重求值
- `morphUploadF32`：`Float32Array(4)` — 变形权重 GPU 上传缓冲区

### 变形目标权重上传

对于 `PATH_WEIGHTS` 通道：

1. 求值采样器 → `morphWeightScratch[0..targetCount-1]`
2. 拷贝到 `morphUploadF32[0..3]`（最多 4 个目标）
3. 写入每个变形绑定的 GPU 缓冲区：`device.queue.writeBuffer(mb.weightsBuffer, 0, morphUploadF32.buffer, 0, 16)`

仅写入前 16 字节（权重 vec4）；变形 UBO 中的 count/texWidth/rowsPerBand 为不可变字段。

## 管线配置

不适用 — Skeleton 是 CPU 侧模块。GPU 交互为只写操作（纹理/缓冲区上传）。骨骼 `ShaderFragment`（位于 `shader/fragments/skeleton-fragment.ts`）负责顶点着色器侧处理。

## 着色器逻辑

不适用 — 此模块中无着色器。顶点着色器蒙皮代码由骨骼 `ShaderFragment` 提供，它读取骨骼纹理并计算：

```wgsl
let skinMatrix = w0 * boneMatrix[j0] + w1 * boneMatrix[j1] + w2 * boneMatrix[j2] + w3 * boneMatrix[j3];
// For 8-bone: + w4 * boneMatrix[j4] + ... + w7 * boneMatrix[j7]
finalWorld = mesh.world * skinMatrix;
```

## 状态机 / 生命周期

```
glTF load
  │
  ▼
extractSkin() ──► GltfSkinData { jointNodes, IBM, jointWorldMatrices, meshWorldMatrix }
  │
  ▼
computeBoneTextureData() ──► Float32Array (rest-pose bone matrices)
  │
  ▼
createSkeleton() ──► SkeletonData { boneTexture, jointsBuffer, weightsBuffer, ... }
  │                    (attached to mesh.skeleton)
  ▼
parseAnimationData() ──► GltfAnimationData { clips, nodes, skeletons, morphBindings }
  │
  ▼
createAnimationController() ──► AnimationController
  │                               (pre-allocates all scratch buffers)
  ▼
createAnimationGroups() ──► AnimationGroup[]
  │                          (one per clip, wraps controller)
  ▼
Per frame: tickAnimation(group, deltaMs, engine)
  └──► controller.tick() → evaluate → compute matrices → GPU upload
```

### glTF 集成

glTF 加载器（`load-gltf.ts`）集成了骨骼创建：

1. 解析 `JOINTS_0`、`WEIGHTS_0`（以及可选的 `JOINTS_1`、`WEIGHTS_1`）顶点属性
2. 对于带有 `skin` 属性的节点，调用 `extractSkin()` 获取关节数据与逆绑定矩阵（IBM）
3. 调用 `computeBoneTextureData()` 计算静止姿势的骨骼矩阵
4. 调用 `createSkeleton()` 创建 GPU 资源
5. 将 `SkeletonData` 挂载到 `mesh.skeleton`
6. 在所有网格处理完毕后：`parseAnimationData()` 构建 `GltfAnimationData`，其骨骼绑定指向每个网格的 `boneTexture`

所有骨骼/动画模块均为**动态导入**——仅当 glTF 包含蒙皮或动画时才会加载。

## 骨骼控制（可选启用）

`bone-control.ts` 添加了面向用户的 API，用于覆盖已加载蒙皮模型上的单个骨骼变换——这是 Babylon.js 中操作 `skeleton.bones[i]` 在 Lite 中的等价实现（例如“将骨骼缩放到 0 以隐藏其子树”，或为当前播放片段未驱动的骨骼摆姿势）。

它是**按需启用且在未使用时打包体积开销接近零**的：始终会被拉取的骨骼/动画分包仅通过两个空钩子（`bone-control-hooks.ts`）引用它。调用 `enableBoneControl()` 会安装其实现；在此之前，整个模块（句柄构建、即时烘焙、覆盖应用）都会被 Tree-Shaking 剔除。

```typescript
// Public API (index.ts)
export function enableBoneControl(): void; // call ONCE before loading
export function getBoneByName(skeleton: Skeleton, name: string): Bone | undefined;
export function setBonePosition(skeleton: Skeleton, bone: Bone, x, y, z): void;
export function setBoneRotationQuaternion(skeleton: Skeleton, bone: Bone, x, y, z, w): void;
export function setBoneScaling(skeleton: Skeleton, bone: Bone, x, y, z): void;
export function setBoneVisible(skeleton: Skeleton, bone: Bone, visible: boolean): void; // scale→0 hide, beats animation
export function setBonePoseDeferred(skeleton: Skeleton, bone: Bone, px, py, pz, rx, ry, rz, rw): void;
export function setBoneWorldPoseDeferred(skeleton: Skeleton, bone: Bone, px, py, pz, rx, ry, rz, rw): void;
export function bakeSkeleton(skeleton: Skeleton): void;
export function clearBoneOverride(skeleton: Skeleton, bone: Bone): void;
export interface Skeleton {
    readonly bones: readonly Bone[]; /* +@internal */
}
export interface Bone {
    readonly name: string; /* +@internal */
}
```

```typescript
enableBoneControl(); // ← before loadGltf
const character = await loadGltf(engine, "character.glb");
addToScene(scene, character);
const skel = character.skeletons![0]; // one per glTF skin
const head = getBoneByName(skel, "Head");
if (head) setBoneVisible(skel, head, false); // hide the head + everything under it
```

### 语义

- **即时烘焙（Eager bake）。** 每次调用 `setBone*` 都会立即根据静止姿势 + 覆盖项重新计算资产的骨骼矩阵并上传骨骼纹理，因此即使在**没有**播放任何动画时（静态模型），覆盖也能立即生效。
- **延迟姿势批处理。** `setBonePoseDeferred` 写入局部平移与旋转，而 `setBoneWorldPoseDeferred` 写入绝对的 Lite 世界空间姿势并在内部应用加载器的左右手系镜像转换。两者都不会立即上传；调用方更新完整组被驱动的骨骼后，调用一次 `bakeSkeleton` 即可。这是物理布娃娃（ragdoll）等逐帧多关节驱动器的受支持公共路径。
- **按分量动画优先——可见性除外。** 当播放片段时，逐帧 tick 会在静止重置之后、通道求值**之前**重新应用 `setBonePosition` / `setBoneRotationQuaternion` / `setBoneScaling` 覆盖项，因此片段动画驱动的任何分量都会覆盖该覆盖项，而片段未触及的分量则保留覆盖值。`setBoneVisible(…, false)` 则不同：它属于可见性控制，因此会在所有姿势路径中——包括单片段控制器（`skeleton-updater.ts`）、加权混合器（`weighted-gltf-mixer.ts` → `uploadTarget`）以及即时烘焙——于通道求值**之后**重新应用（将骨骼缩放归零）。若非如此，一旦播放带有缩放轨道的片段，隐藏的骨骼就会立刻弹回，而现实中几乎所有绑定都会在**每根**骨骼上烘焙常量缩放轨道（所有 Mixamo 导出，如 Xbot.glb，都在全部 67 个关节上带有平移 + 旋转 + 缩放轨道）。可见性由其独立的 `BoneOverride.mask` 位（第 8 位）追踪，因此重新显示骨骼时会保留任何显式设置的 `setBoneScaling` 覆盖项。
- **每个蒙皮一个句柄，但重烘焙所有网格。** 拆分到多个网格上的 glTF 蒙皮（例如 Xbot 的 `Beta_Joints` + `Beta_Surface`）在 Lite 中会为_每个网格_生成一张骨骼纹理，因此在 `container.skeletons` 上为每个蒙皮网格生成一个 `Skeleton` 句柄。覆盖映射表是资产级别的，即时烘焙会重烘焙该资产的**所有**骨骼纹理，因此单次 `setBone*` 调用会更新共享该蒙皮的所有网格——与 Babylon.js 的共享 `Skeleton` 行为一致。

内部 `BoneOverride` 映射类型未暴露在公共 API 表面：公共边界（`createAnimationController`、`GltfAnimationData.boneOverrides`）将其类型定义为 `ReadonlyMap<number, unknown>`，内部钩子再进行类型转换还原。

## Babylon.js 等价映射表

| Babylon.js | Babylon Lite |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Skeleton` 类 | `SkeletonData` 纯数据 + `AnimationController` |
| `Bone[]` 层级 | `NodeRest[]` 扁平数组 + `parentIdx` 链接 |
| `skeleton.getTransformMatrices()` → Float32Array 缓冲区 | 骨骼纹理（`rgba32float`，4 纹素/骨骼） |
| 每帧 `skeleton.prepare()` | `AnimationController.tick()` |
| `Mesh.useBones` | 是否存在 `mesh.skeleton` 属性 |
| 4 骨骼：`matricesIndices`、`matricesWeights` | `jointsBuffer`、`weightsBuffer` |
| 8 骨骼：`matricesIndicesExtra`、`matricesWeightsExtra` | `joints1Buffer`、`weights1Buffer` |
| `bone.setRotationQuaternion()` / `bone.setScale()` / 摆骨骼姿势 | `setBoneRotationQuaternion()` / `setBoneScaling()`（调用 `enableBoneControl()` 之后） |
| 将骨骼缩放到 0 以隐藏其子树 | `setBoneVisible(skel, bone, false)` |
| `skeleton.bones.find(b => b.name === ...)` | `getBoneByName(skeleton, name)` |

## 依赖项

- `../animation/types.js` — `GltfAnimationData`、`SkeletonData`、`AnimationClip`、路径/插值常量
- `../animation/evaluate.js` — 用于关键帧插值的 `evaluateSampler()`
- `../math/mat4.js` — 用于矩阵计算的 `composeMat4IntoBuffer`、`multiplyMat4IntoBuffer`

## 测试规范

1. **createSkeleton**：验证骨骼纹理尺寸 = `boneCount * 4` × 1，格式为 `rgba32float`
2. **4 骨骼路径**：验证关节索引已扩展为 Uint32Array，缓冲区尺寸正确
3. **8 骨骼路径**：验证当提供 JOINTS_1/WEIGHTS_1 时，`joints1Buffer` 和 `weights1Buffer` 非空
4. **静止姿势骨骼矩阵**：验证在平凡情况下 `computeBoneTextureData()` 产出单位矩阵
5. **逐帧求值**：验证 `tick()` 为已知动画片段计算正确的骨骼矩阵
6. **拓扑顺序**：验证父节点始终先于子节点处理
7. **RH→LH 变换**：验证根节点被左乘 `diag(-1,1,1,1)`
8. **变形目标权重上传**：验证向变形权重缓冲区写入正确的 16 字节数据
9. **零分配**：验证 `tick()` 热路径中无 `new Float32Array` 调用

## 文件清单

| 文件 | 用途 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `create-skeleton.ts` | GPU 资源工厂：从解析后的 glTF 蒙皮数据创建骨骼纹理 + 关节/权重顶点缓冲区 |
| `update-skeleton-bone-matrices.ts` | 高层编程式骨骼矩阵更新，保持 CPU 镜像与 GPU 纹理同步 |
| `skeleton-updater.ts` | 逐帧动画求值：关键帧插值 → 层级遍历 → 骨骼矩阵计算 → GPU 上传 |
| `skeleton-pose.ts` | 共享烘焙原语（拓扑排序、静止重置、世界矩阵、骨骼纹理上传），供可选即时骨骼控制烘焙使用 |
| `bone-control.ts` | 可选骨骼控制 API：`enableBoneControl`、`getBoneByName`、`setBone*`、即时烘焙 + 逐帧覆盖应用器 |
| `bone-control-hooks.ts` | 两个空钩子（`_boneBuilder`、`_boneApplier`），使常驻分包能引用骨骼控制而不将其打包 |
