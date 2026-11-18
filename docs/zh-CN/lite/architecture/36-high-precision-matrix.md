# 模块：高精度矩阵（High-Precision Matrix，HPM）

> 包路径：`packages/babylon-lite/src/math/_matrix-allocator.ts`、`packages/babylon-lite/src/math/_mat4-storage-f64.ts`、`packages/babylon-lite/src/math/pack-mat4-into-f32.ts`

## 用途

高精度矩阵（High-Precision Matrix，HPM）是 `Mat4` 的可选 Float64 底层存储支持。当引擎以 `useHighPrecisionMatrix: true` 创建时，页面上的每次矩阵分配都会返回 `Float64Array(16)` 而不是 `Float32Array(16)`。CPU 侧的矩阵合成（父级链世界矩阵、lookAt、求逆）随后都在 F64 中完成，从而在远离原点（约 1e5 及以上，此时 F32 量化误差会变得明显）的大坐标下保留亚单位精度。唯一一次 F64→F32 向下转型发生在一个显式边界上——即矩阵写入 GPU Uniform 缓冲区时的 `packMat4IntoF32`。

HPM 是大世界渲染（Large World Rendering，`35-large-world-rendering.md`）所依托的基础层：浮动原点在执行 F32 存储**之前**先以 F64 精度从世界平移中减去视点位置，从而以全精度保留较小的余数。

## 公共 API 接口

### 引擎选项（`engine/engine.ts`）

```typescript
export interface EngineOptions {
    /** When true, world matrices are computed using Float64 intermediate
     *  precision and downcast to Float32 at GPU upload time. Defaults to false. */
    useHighPrecisionMatrix?: boolean;
    // ...
}
```

### 进程全局分配器（`math/_matrix-allocator.ts`）

```typescript
/** Allocate a fresh zero-initialized 16-element `Mat4`. Returns an F32 array
 *  by default, or F64 if any engine on the page was created with
 *  `useHighPrecisionMatrix: true`. */
export function allocateMat4(): Mat4;

/** @internal Install the HPM (F64) allocator. Called once by `createEngine`
 *  when `useHighPrecisionMatrix: true`. Subsequent calls overwrite. */
export function _setHpmAllocator(allocate: () => Mat4): void;

/** @internal Reset to F32 default — test-only. */
export function _resetMatrixAllocatorForTests(): void;
```

### F64 存储模块（`math/_mat4-storage-f64.ts`）

```typescript
/** @internal F64-backed Mat4 allocator. Dynamic-imported by createEngine
 *  inside `if (options.useHighPrecisionMatrix)`. Tree-shaken out of HPM-off
 *  bundles. This module is the ONLY place in the package that names
 *  `new Float64Array(16)`. */
export function allocateF64Mat4(): Mat4;

/** @internal Build-time tag string asserted absent from HPM-off bundles by
 *  `tests/bundle-content-no-f64.test.ts`. */
export const MAT4_STORAGE_F64_BUILD_TAG = "@@MAT4_STORAGE_F64@@";
```

### GPU 打包边界（`math/pack-mat4-into-f32.ts`）

```typescript
/** @internal Pack one Mat4 into a Float32Array upload view at the given float
 *  offset. Source storage may be F32 or F64; this is the only place in the
 *  package where F64→F32 downcast happens for GPU upload. Does not allocate.
 *
 *  When `srcOffsetFloats` is provided, the helper reads 16 floats starting at
 *  `src[srcOffsetFloats]` instead of `src[0]` — used by thin-instance and
 *  similar packed-slab uploaders.
 *
 *  When `offsetXYZ` is provided, the floating-origin offset is subtracted from
 *  the translation column `[12..14]` during pack — see LWR (doc 27).
 *  Subtraction happens in JavaScript number precision (F64) BEFORE the
 *  implicit F32 store, so `large - large = small` is computed at full F64 and
 *  a single F32 store rounds the remainder with ample headroom. */
export function packMat4IntoF32(
    view: Float32Array,
    mat: Mat4 | Float32Array | Float64Array,
    offsetFloats?: number,
    srcOffsetFloats?: number,
    offsetXYZ?: readonly [number, number, number]
): void;
```

## 内部架构

### 单一分配器单例（进程全局）

分配器是**进程全局**的——在 `_matrix-allocator.ts` 中是一个模块级绑定 `let _allocate: () => Mat4`。默认实现返回 `Float32Array(16)`；从 `createEngine` 调用 `_setHpmAllocator(allocateF64Mat4)` 会在进程剩余生命周期内将其切换为 F64 底层存储。

这出于打包体积考量打破了最初的 M0 设计（最初将 `engine._matrixPolicy` 作为按引擎实例持有的字段）：将按引擎实例的分配器传递到每个实体工厂、场景缓存和加载器暂存区会为每个 bundle 增加约 300-500 字节。该单例的懒初始化形式（`let _allocate = () => …` 是函数表达式赋值，而非初始化执行）按照 GUIDANCE 支柱 4 第 35 行的要求保持了模块的可 Tree-shaking 性。

**约束：** 不支持在同一页面上混用启用 HPM 和未启用 HPM 的引擎。第二个引擎会静默继承第一个引擎的精度；针对其创建的网格和相机将使用错误的底层存储。此处没有运行时检查——违反该规则会静默产生错误结果。这是我们为了相比原按引擎 `engine._matrixPolicy` 字段节省打包体积而做出的权衡。

### F64 存储的动态导入门控

`createEngine` 仅在 `if (useHpm)` 内动态导入 `_mat4-storage-f64.ts`。当 `useHighPrecisionMatrix` 保持默认值 `false` 时，Vite 打包器会证明该导入目标不可达，并将整个模块从关闭 HPM 的 bundle 中 Tree-shake 掉。`tests/bundle-content-no-f64.test.ts` 通过两种方式断言这一点：（1）构建标记字符串 `@@MAT4_STORAGE_F64@@` 不会出现在任何关闭 HPM 的 bundle 中；（2）对于关闭 HPM 的场景，`lab/public/bundle/manifest.json` 绝不会将 `_mat4-storage-f64` 列为运行时 chunk。

### `Mat4` 类型与 `Mat4Storage`

公共 `Mat4` 接口是不透明、只读且带品牌标记的（branded），因此用户无法伪造或意外写入引擎返回的矩阵。内部内核（`multiplyMat4`、`invertMat4`、`packMat4IntoF32`、分配器）则直接操作原始的 `Mat4Storage = Float32Array | Float64Array` 联合类型，该类型可写且无品牌标记。两种类型描述的是同一块内存；在信任边界处通过 `as unknown as Mat4Storage` / `as unknown as Mat4` 进行转换。完整类型细节参见 `21-core-math.md`。

### 每次加载的 glTF 暂存矩阵

glTF 加载器在 `loader-gltf/_loader-scratch.ts` 中使用三个可复用的暂存矩阵（`tmpLocal`、`tmpAnim`、`tmpInstance`），通过模块级懒获取器暴露：

```typescript
let _tmpLocal: Mat4 | null = null;
export function getLoaderTmpLocal(): Mat4 {
    return (_tmpLocal ??= allocateMat4());
}
```

通过 `allocateMat4()` 进行懒初始化意味着暂存矩阵会继承进程全局分配器所安装的精度。它在并发 `loadGltf` 调用之间可以安全共享，因为所有触及暂存矩阵的解析路径在读写之间都是同步的（仅有的 `await` 位于网络获取和图像解码处，均不触及矩阵暂存区）。JS 单线程特性保证其他解析任务不会在计算中途交错访问暂存使用点。

## 分配边界清单

引擎返回的每一个 `Mat4` 都必须来自 `allocateMat4()`。直接调用 `new F32(16)` 会无论引擎如何配置都把该矩阵固定在 F32 精度，下游没有任何手段能够找回丢失的精度。执行分配的位置包括：

- `math/compose-mat4.ts`、`create-mat4-from-quat.ts`、`create-identity-mat4.ts`、`invert-mat4.ts`、`create-look-at-mat4-lh.ts`、`multiply-mat4.ts`、`create-perspective-mat4-lh.ts`、`create-scaling-mat4.ts` —— 返回新矩阵的八个工厂函数
- `scene/world-matrix-state.ts` —— 每个节点的 `_ownedWorld`
- `scene/scene-node.ts` —— 每个 TRS 节点懒分配的可复用局部矩阵
- `camera/arc-rotate.ts`、`camera/free-camera.ts`、`camera/geospatial-camera.ts` —— `_localMat`、`_viewCache`、`_projCache`、`_vpCache`
- `light/directional-light.ts`、`light/hemispheric.ts`、`light/point-light.ts`、`light/spot-light.ts` —— 每个光源的 `_localMatrix`
- `loader-gltf/_loader-scratch.ts` —— 三个每次加载共用的暂存矩阵
- `particle/node/blocks/update-flow-map-block.ts` —— 流场贴图（flow-map）矩阵

`_matrix-allocator.ts` 还导出了 `allocateMat4Storage()`，这是一个薄包装函数，返回已转型为 `Mat4Storage`（内核用于按索引写入的视图）的 `allocateMat4()`——与 `allocateMat4()` 一样，它仅限内部使用，不会从包入口点重新导出。它将 `allocateMat4() as unknown as Mat4Storage` 转型集中到一处，但**刻意只用在 `create-look-at-mat4-lh.ts`** 这一个当前没有实际调用流量的调用点（没有场景导入 `createLookAtMat4LH`，因此该包装函数会随该工厂函数一起被 Tree-shake 掉）。`as unknown as Mat4Storage` 转型在编译期被擦除、没有任何开销，但真正的包装**函数**却并非零开销：实测表明，将另外七个本就处于热点路径的工厂函数路由到该包装函数会给每个组合变换的场景（即几乎所有场景）增加约 35–39 字节的原始代码体积——压缩器会保留这层间接调用而不会将其内联，从而使包装函数自身定义成为每个场景的永久体积税。测量时 `scene7` 的体积上限余量仅剩 141–176 B，仅这项额外开销就可能导致超限。因此原有的七个调用点仍保留直接的 `allocateMat4() as unknown as Mat4Storage` 转型；只有新增的第八个调用点（在所有当前场景中均属死代码）使用该辅助函数。

`*Into` / `*ToRef` 内核函数（`composeMat4IntoBuffer`、`multiplyMat4IntoBuffer`、`writePerspectiveMat4LHIntoBuffer`、`writeLookAtMat4LHIntoBuffer` 等）不执行分配——它们写入调用方已拥有的存储空间并继承其精度。只有返回新矩阵的工厂函数负责选择存储类型，因此它们构成了分配边界。

**根节点使得局部分配至关重要。** `createWorldMatrixState` 通过分配器分配 `_ownedWorld`，但仅在节点有父节点时才使用它。对于根节点，`getWorldMatrix()` 会原样返回**局部**矩阵（`_cachedWorld = local`）。`SceneNode` 的可复用局部存储通过 `allocateMat4()` 懒分配，并由 `composeTrsLocalMatrixIntoBuffer` 填充（填充单位矩阵或调用 `composeMat4IntoBuffer`）；其他提供方也可返回自己分配的局部存储或使用创建新矩阵的 `composeTrsLocalMatrix` 工厂。因此，绕过分配器的局部分配会直接让根级对象在 HPM 下失去 F64 世界变换——而这正是 HPM 存在的意义——同时由于挂接在父节点下的子节点仍表现为正确，还会掩盖这一缺陷。局部/世界矩阵缓存保留分配器选定的存储精度，不会引入向下转型。

## GPU 上传边界清单

每一次 mat4 → GPU 缓冲区的写入都经过 `packMat4IntoF32`。完整列表如下：

- `frame-graph/render-task.ts` —— 场景 UBO 的视图矩阵、投影矩阵、视图投影矩阵上传
- `material/standard/standard-renderable.ts` —— 标准可渲染对象网格 UBO 中的网格世界矩阵（初始上传与逐帧更新）
- `material/pbr/pbr-renderable.ts` —— PBR 可渲染对象的同类上传
- `material/node/node-renderable.ts` —— 节点材质可渲染对象的同类上传
- `mesh/thin-instance-gpu.ts` —— 瘦实例世界矩阵缓冲区段（通过 `srcOffsetFloats` 进行子数组打包）
- `shadow/esm-directional-shadow-generator.ts`、`shadow/pcf-shadow-task-hooks.ts`、`shadow/shadow-base.ts` —— 阴影 `_lightMatrix` 打包

上述 6 个网格世界矩阵调用点会将 `_foOffset`（场景的 `_floatingOriginOffset` 引用）作为第 5 个参数传入。非网格调用点省略该偏移量，仅执行高精度打包（当底层存储为 F32 时为逐比特完全相同的拷贝）。

**唯一例外：** `material/shader/shader-renderable.ts` 及其带缓存的对应模块 `enable-shader-material-uniform-caching.ts` 自行序列化 `ShaderMaterial` 的系统 Uniform 块（`data.set(world, …)` / `multiplyMat4IntoBuffer(data, …)`），而不调用 `packMat4IntoF32`。它们无法复用该函数——因为 `packMat4IntoF32WithOffset` 位于仅限 LWR 的 bundle 中，本模块不得静态导入它，否则会破坏前述 Tree-shaking 门控。相对视点减法改由 `shader-renderable.ts` 中的 `_shaderWorldMatrix(mesh, camera, out?)` 完成，采用相同的 `large - large = small` 运算顺序：减法在 F32 存储之前以 JS 数值精度执行，因此基于 F64 的网格矩阵依然保留其小余数。除这两个文件之外的任何新 mat4 → GPU 写入都应归入上方清单，而非此处。

## 验证

- 单元测试：`tests/unit/engine-matrix-policy.test.ts` 覆盖默认返回 F32 的 `allocateMat4()`、调用 `_setHpmAllocator` 后返回 F64、每次调用返回新实例以及 `_resetMatrixAllocatorForTests` 恢复默认。同时包含分配边界守卫：逐一断言八个工厂函数都遵守已安装的分配器（各自独立命名，因此回归时会明确报告是哪一个），外加一组行为对比测试，展示根节点在 4.6e6 坐标下启用 HPM 时保持亚米级精度，而在默认 F32 下丢失精度。
- 单元测试：`tests/unit/pack-mat4-into-f32.test.ts` 覆盖 F32→F32 逐比特一致、F64→F32 向下转型、源/目标偏移量以及 LWR 偏移减法路径。
- 打包检查：`tests/bundle-content-no-f64.test.ts` 强制验证关闭 HPM 的 bundle 中已对 F64 完成 Tree-shaking（字符串标记不存在且清单互不相交）。
- 打包体积：场景配置上限——bundle 体积测试确认关闭 HPM 的场景保持在其固定体积上限内；F64 chunk 仅在可达时才输出。

## 文件 / 体积

| 文件                                     | 用途                                               |
| ---------------------------------------- | -------------------------------------------------- |
| `math/_matrix-allocator.ts`（约 40 行）  | 进程全局懒初始化分配器 + 安装钩子                  |
| `math/_mat4-storage-f64.ts`（约 25 行）  | F64 分配器函数 + 构建标记                          |
| `math/pack-mat4-into-f32.ts`（约 60 行） | 带可选浮动原点偏移量的单一 GPU 上传边界            |
| `math/types.ts`（Mat4, Mat4Storage）     | 不透明品牌化的 `Mat4` + 原始 `Mat4Storage` 联合类型 |
