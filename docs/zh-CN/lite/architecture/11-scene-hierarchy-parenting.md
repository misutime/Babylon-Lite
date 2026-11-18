# 模块：场景层级与父子关系（Scene Hierarchy & Parenting）

> 包路径：`packages/babylon-lite/src/scene/`

## 用途

实时父子层级关系，通过两个接口 `IWorldMatrixProvider`（父级契约）和 `IParentable`（子级契约）使**任意实体**（TransformNode、Mesh、Camera、Light）都能与任意其他实体建立父子关系。变换写入会沿着子树向下推送版本失效标记；矩阵合成则保持惰性计算。未发生变化的引擎节点读取复杂度为 O(1)。

---

## 公共 API 表面

### 接口（`scene/parentable.ts`）

```typescript
interface IWorldMatrixProvider {
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

interface IParentable {
    parent: IWorldMatrixProvider | null;
}
```

零运行时代码——接口在编译期会被擦除。

### 重新设置父级（`scene/set-parent.ts`）

```typescript
// Reparent while preserving world-space transform (Babylon.js TransformNode.setParent).
// Accepts any SceneNode (mesh, transform node, camera, light), not just Mesh.
export function setParent(child: SceneNode, parent: IWorldMatrixProvider | null): void;
```

`setParent` 先对子节点的当前世界矩阵做快照，设置 `child.parent`，然后写回局部 TRS（通过 `decomposeMat4` 完成，因此旋转以四元数表示——不会发生有损的欧拉角往返转换）。它还会同步维护场景图的 `children` 数组：将子节点从旧父级的 `children` 中移除，并追加到新父级的 `children` 中，使遍历辅助函数（如 `setMeshVisible` 级联、克隆、相机包围盒计算）能感知到新的层级结构。直接赋值 `child.parent` 会驱动变换数学计算，但**不会**更新 `children`——如果同样需要遍历支持，则需手动维护数组。

**保留镜像子节点。** glTF 加载器创建的合成 `__root__` 节点通过 `scaling = (-1, 1, 1)` 承载从右手系到左手系（RH→LH）的惯性系翻转，因此其局部变换具有负行列式。`decomposeMat4` 会保留该镜像反射（按 Babylon.js 的方式折叠到负 Y 缩放上），从而使重新挂载到用户创建的变换节点下的已加载模型呈现与之前完全一致的渲染效果。

**同样支持基于矩阵的节点。** 使用 `createSceneNodeFromMatrix` 创建的节点（用于声明了原始 `matrix` 而非 TRS 的 glTF 节点）会直接将该矩阵作为其局部变换，并忽略 `position`/`rotationQuaternion`/`scaling`。`setParent` 会清除 `_localMatrix` 并写入分解后的 TRS，将控制权交还给 TRS 三元组——该分解结果可以精确还原被替换的矩阵，因此节点除重设父级本身外不会产生任何位移。

**父级链接由 `addToScene` 建立。** glTF 加载器只填充 `children` 数组而不设置 `parent`；`addToScene` 会遍历树并为其分配 `parent`。由于 `setParent` 需要真实的父级链来读取节点的世界变换，因此仅在容器被添加到场景之后才能重新挂载其_嵌套_已加载节点。事先重新挂载容器自身的根节点是可以的——因为它的父级本来就是 null。

### TransformNode（`scene/transform-node.ts`）

```typescript
interface TransformNode extends IWorldMatrixProvider, IParentable {
    name: string;
    position: ObservableVec3;
    rotationQuaternion: ObservableQuat;
    scaling: ObservableVec3;
    children: (TransformNode | Mesh)[];
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

function createTransformNode(name, px, py, pz, qx, qy, qz, qw, sx, sy, sz): TransformNode;
function cloneTransformNode(src: TransformNode): TransformNode;
function collectMeshes(node: TransformNode, parentProvider?: IWorldMatrixProvider): Mesh[];
function isTransformNode(obj: unknown): obj is TransformNode;
```

### Mesh（`mesh/mesh.ts`）

```typescript
interface Mesh extends IWorldMatrixProvider, IParentable {
    // ... existing fields ...
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}
```

移除了 `computeWorldMatrix()`。所有调用点均直接使用 `mesh.worldMatrix`。
移除了 `MeshGPU.worldMatrix`——缓存改由 `createWorldMatrixState` 闭包管理。
移除了 `mesh._transformVersion`——由 `worldMatrixVersion` 取代。

### 相机

`ArcRotateCamera` 和 `FreeCamera` 均扩展自 `IWorldMatrixProvider, IParentable`。
相机的 `worldMatrix` 为相机到世界的变换矩阵（即视图矩阵的逆矩阵）。
`getViewMatrix(camera)` 和 `getCameraPosition(camera)` 均派生自 `worldMatrix`。

### 灯光

`LightBase` 扩展自 `SceneNode`。因此所有 4 种灯光类型（点光源、方向光、聚光灯、半球光）都暴露标准的 `position`、四元数/欧拉角旋转、`scaling`、`parent`、`children` 和世界矩阵状态。设置灯光的局部 `direction` 会更新其光照数据，而直接修改 `SceneNode` 旋转则会通过世界矩阵来定向该局部方向。`setParent` 对灯光和其他所有 `SceneNode` 使用相同路径，包括常规的 `children` 数组遍历。灯光 UBO 和阴影消费方均读取世界矩阵，因此祖先节点的移动和缩放会一致地影响两条路径。

UBO 写入器从 `worldMatrix` 的列中读取世界空间的值：

- 位置 = 第 3 列：`[w[12], w[13], w[14]]`
- 方向 = 归一化后的 `worldMatrix * localDirection`（`w = 0`）

---

## 内部架构

### 共享世界矩阵辅助函数（`scene/world-matrix-state.ts`）

```typescript
function createWorldMatrixState(getLocalMatrix: () => Mat4): WorldMatrixAccessors;
```

该工厂返回 `{ getWorldMatrix, getWorldMatrixVersion, markLocalDirty, parent }`。每个实体提供一个 `getLocalMatrix()` 闭包。该辅助函数拥有以下状态：

- `_worldVersion`：在每次局部写入、祖先失效或重设父级时递增。
- `_cachedLocal`：最新的局部矩阵，仅在 `markLocalDirty()` 时清除。
- `_cachedWorld`：在局部失效或世界失效时清除。
- `_ownedWorld`：通过 `allocateMat4()` 分配一次，并由 `multiplyMat4IntoBuffer` 复用来存储带父级的结果。
- 由 `parent` setter 独立于宿主公开的 `children` 数组之外维护的私有子节点注册表。由 `attachWorldMatrixState` 附加的 symbol 用于标识引擎父级并连接它们的失效状态。
- `_lastSeenParentVersion`：仅用于轮询直接的外部父级（不带该 symbol 的 provider）。读取世界矩阵或版本号时会轮询该父级的公开版本号，若发生变化则推送仅世界矩阵失效。

`markLocalDirty()` 会清除局部缓存，然后无条件地使该节点及其所有后代的世界缓存与版本号失效。`_invalidate()` 仅作用于世界矩阵：祖先移动与重设父级不会改变节点自身的局部变换。这两种遍历都不能在已经标记为脏的节点处提前停止：在连续多次祖先移动期间，中间节点可能未被读取，而消费方可能仅读取某个叶子节点的版本号。

`_markWorldMatrixDirty(host)` 仅作用于世界矩阵：几何体更新需要刷新世界版本号，而无需重新合成未变的局部变换。`_markLocalMatrixDirty(host)` 为常规 TRS 回调之外的可变局部输入调用 `markLocalDirty()`。倾斜相机（banked camera）为其 up 向量使用后者，因为它在不写入位置/旋转/缩放的情况下改变了局部 look-at 基。

### SceneNode 局部存储（`scene/scene-node.ts`）

`initSceneNodeTransform` 通过 `allocateMat4()` 惰性分配一个私有 TRS 矩阵。仅当共享局部缓存失效时，其局部工厂才会调用
`composeTrsLocalMatrixIntoBuffer(local: Mat4Storage, position: Vec3, rotation: Quat, scaling: Vec3): void` 填充该矩阵；后续局部编辑会复用同一块存储。对于非单位 TRS，该写入器使用 `composeMat4IntoBuffer`；对于默认变换，它会向存储填零并将对角线设为 1，从而在不产生分配的前提下保留现有的快速路径和带符号零规范化。仅由父级触发的移动/重设父级既不会重新合成也不会分配局部矩阵。存储在默认情况下为 F32，若在节点创建/使用前安装了 HPM 分配器则为 F64。

显式设置的 `_localMatrix` 优先使用，不进行合成或修改其数值。锁定的 glTF 矩阵仍会忽略 TRS 写入；未锁定的 TRS 写入会清除该覆盖并使局部缓存失效。`setParent` 会写入 TRS 种子值，并使用其现有路径精确保留仿射矩阵，包括错切与镜像反射。

`worldMatrix` 是只读借用存储，而非快照：如果其数值需要在后续编辑后的矩阵读取中继续保留，请拷贝其内容。根节点返回其局部矩阵；带父级的节点返回 `_ownedWorld`。没有任何公共工厂改变其所有权契约：`composeMat4` 和 `composeTrsLocalMatrix` 仍返回全新的独立矩阵，后者分配一次并委托给共享的 TRS 写入器。

### 基于推送的脏状态追踪

引擎实体使用基于推送的脏通知；直接外部父级保留上述版本号轮询回退机制：

| 实体 | 属性 | 机制 |
| --------------- | ------------------------- | --------------------------------------------------- |
| TransformNode | position/scaling | `ObservableVec3` → `markLocalDirty()` |
| TransformNode | rotationQuaternion | `ObservableQuat` → `markLocalDirty()` |
| Mesh | position/rotation/scaling | `ObservableVec3` → `markLocalDirty()` |
| ArcRotateCamera | alpha/beta/radius | `Object.defineProperty` setter → `markLocalDirty()` |
| ArcRotateCamera | target | `ObservableVec3` → `markLocalDirty()` |
| FreeCamera | position/target | `ObservableVec3` → `markLocalDirty()` |
| FreeCamera | \_yaw/\_pitch | `Object.defineProperty` setter → `markLocalDirty()` |
| 所有灯光 | position/direction | `ObservableVec3` → `markLocalDirty()` |

### `ObservableQuat`（`math/observable-quat.ts`）

与 `ObservableVec3` 相同模式，但包含 4 个分量（x,y,z,w）。用于 `TransformNode.rotationQuaternion`。任意分量发生变化时触发 `onDirty` 回调。

### 灯光矩阵辅助函数（`light/light-matrix.ts`）

```typescript
function localMatrixFromDirection(dx, dy, dz, px?, py?, pz?): Mat4;
```

根据方向向量构建标准正交基。第 2 列 = forward（归一化后的方向）。用于方向光、聚光灯和半球光。内联 `Float32Array(16)` 以避免导入 `createIdentityMat4`。

---

## 基于版本的惰性算法

```
get worldMatrix():
    poll direct foreign parent, if any
    if cachedWorld exists → return cachedWorld
    if cachedLocal is null → cachedLocal = getLocalMatrix()
    if parent:
        multiplyMat4IntoBuffer(ownedWorld, parent.worldMatrix, cachedLocal)
        cachedWorld = ownedWorld
    else:
        cachedWorld = cachedLocal
    return cachedWorld
```

### 性能特征

| 场景 | 每帧开销 |
| --------------------------- | -------------------------------------------- |
| 静态场景（无变化） | 每个实体 O(1) — 读取缓存矩阵/版本号 |
| 根节点变化，存在 N 个后代 | O(N) 版本号推送；惰性计算世界矩阵乘积，仅根节点需要合成局部矩阵 |
| 单个叶子节点变化 | O(1) 失效；基于已缓存父级进行一次局部合成与乘积计算 |

这些结构复杂度并非通用的性能实测值。实际 CPU 收益取决于层级形状、局部移动与祖先移动的比例以及矩阵精度。必需的世界矩阵乘法以及无条件向后代传播版本号仍然存在。

### 专项测试规范

`tests/lite/unit/world-matrix-parent-propagation.test.ts` 将兼容性断言（修改前后均须通过）与优化断言（修改前预期失败）分开：涵盖局部 TRS 编辑、跨越未读取中间节点的连续祖先移动、直接外部父级轮询、重设父级/分离、显式局部失效、原始矩阵交接、F32/F64 数值以及全新数学工厂输出。通过对现有分配器/合成内核及传入局部工厂进行监控，无需引入运行时计数器即可验证存储与合成复用。`engine-matrix-policy`、`banked-free-camera`、`mat4-decompose-mirrored` 与 `light-parenting` 测试覆盖了相关的精度、局部 look-at 失效及仿射消费方行为。

---

## 场景集成

### `addToScene(scene, TransformNode)`

```typescript
if (isTransformNode(entity)) {
    const meshes = collectMeshes(entity, entity.parent ?? undefined);
    for (const m of meshes) {
        ctx.add(m);
    }
}
```

`collectMeshes` 递归遍历 `children`，为每个子节点设置 `parent` 链接，并返回所有 `Mesh` 叶子节点。网格进入 `scene.meshes[]` 以供扁平化的渲染遍历使用。层级关系通过 `parent` 指针持续保留。

### glTF 加载器

`buildNodeHierarchy()` 使用 `createTransformNode()` 并将子 `TransformNode` 和 `Mesh` 一并推入统一的 `children` 数组。当该树被添加到场景中时，由 `collectMeshes` 设置父级链接。

为优化打包体积，动画/蒙皮解析通过 `gltf-animation.ts` 懒加载。

---

## 文件清单

| 文件 | 状态 | 描述 |
| ------------------------------- | --------- | --------------------------------------------------------- |
| `scene/parentable.ts` | 新增 | `IWorldMatrixProvider` + `IParentable` 接口 |
| `scene/world-matrix-state.ts` | 新增 | `createWorldMatrixState` 工厂 |
| `math/observable-quat.ts` | 新增 | `ObservableQuat` 类 |
| `light/light-matrix.ts` | 新增 | `localMatrixFromDirection` 辅助函数 |
| `loader-gltf/gltf-animation.ts` | 新增 | 懒加载的动画/蒙皮解析 |
| `scene/transform-node.ts` | 重写 | `createTransformNode`，统一的 `children` |
| `mesh/mesh.ts` | 修改 | 移除 `computeWorldMatrix`，添加 `IWorldMatrixProvider` |
| `camera/arc-rotate.ts` | 修改 | 添加 `IWorldMatrixProvider`，基于推送的脏标记 |
| `camera/free-camera.ts` | 修改 | 添加 `IWorldMatrixProvider`，基于推送的脏标记 |
| `light/types.ts` | 修改 | `LightBase` 扩展 `IWorldMatrixProvider` |
| `light/point-light.ts` | 修改 | `ObservableVec3` position，`createWorldMatrixState` |
| `light/directional-light.ts` | 修改 | `ObservableVec3` position/direction |
| `light/spot-light.ts` | 修改 | `ObservableVec3` position/direction |
| `light/hemispheric.ts` | 修改 | `ObservableVec3` direction |
| `scene/scene-core.ts` | 修改 | `addToScene()` 通过 `collectMeshes` 设置父级链接 |
| `loader-gltf/load-gltf.ts` | 修改 | 使用 `createTransformNode`，懒加载动画 |
| `index.ts` | 修改 | 导出 `IWorldMatrixProvider`、`IParentable`、`ObservableQuat` |

---

## Babylon.js 等价映射表

| Babylon Lite | Babylon.js |
| ---------------------------- | -------------------------------------- |
| `IWorldMatrixProvider` | `Node`（包含 `getWorldMatrix()`） |
| `IParentable` | `Node.parent` 属性 |
| `mesh.parent = node` | `mesh.parent = node` |
| `mesh.worldMatrix`（getter） | `mesh.getWorldMatrix()` |
| `mesh.worldMatrixVersion` | `mesh._currentRenderId` |
| `createTransformNode(name)` | `new TransformNode(name, scene)` |
| `node.position.set(x, y, z)` | `node.position = new Vector3(x, y, z)` |
| `node.children` | `node.getChildren()` |
| 惰性拉取模型 | 推送模型（`_markAsDirty`） |
| 基于版本号的过期检测 | 基于帧的 `_currentRenderId` 检查 |
