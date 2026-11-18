# 模块：世界坐标到屏幕坐标投影

> 包路径：`packages/babylon-lite/src/camera/world-to-screen.ts`

## 用途

世界坐标到屏幕坐标投影（world-to-screen projection）模块将世界空间中的 `Vec3` 转换为画布后备存储（backing-store）像素坐标以及相对于画布的 CSS 像素坐标。它是一个纯 CPU 数学辅助模块：不创建或定位 DOM 覆盖层，不读取全局浏览器状态，也不保留相机或表面状态。

调用方需要传入相机的视图矩阵和视图投影矩阵。这使得热路径上的投影函数保持通用，并允许调用方每帧仅缓存一次矩阵。现有的相机与视口辅助函数负责推导当前渲染状态：

```typescript
const backingWidth = surface.canvas.width;
const backingHeight = surface.canvas.height;
const view = getViewMatrix(camera);
const viewProjection = getViewProjectionMatrix(camera, getEffectiveAspectRatio(camera, backingWidth, backingHeight));
const viewport = resolveCameraViewport(camera, backingWidth, backingHeight);
const worldOrigin = engine.useFloatingOrigin ? getFloatingOriginOffset(scene) : undefined;
```

对于 DOM 画布，请将其当前相对于画布的 CSS 尺寸作为 `cssWidth` 和 `cssHeight` 传入（通常为 `clientWidth` / `clientHeight`，或在必须计入 CSS 变换时使用 `getBoundingClientRect()` 的尺寸）。对于 `OffscreenCanvas`，宿主应同时提供可见画布的 CSS 尺寸以及后备存储尺寸。省略 CSS 尺寸会使 CSS 坐标等于后备像素坐标。

## 公共 API 接口

```typescript
export interface ScreenProjectionOptions {
    /** Active viewport in canvas backing pixels, with top-left origin. */
    viewport: PixelViewport;
    /** Full canvas backing-store dimensions in device pixels. */
    backingWidth: number;
    backingHeight: number;
    /** World-space position represented by zero in the supplied matrices. */
    worldOrigin?: Vec3;
    /** Canvas-relative CSS dimensions. Both must be supplied together. */
    cssWidth?: number;
    cssHeight?: number;
}

export interface ScreenProjectionResult extends Vec3 {
    /** Canvas backing-pixel X coordinate. */
    x: number;
    /** Canvas backing-pixel Y coordinate. */
    y: number;
    /** WebGPU NDC depth. In Lite's reverse-Z cameras, near=1 and far=0. */
    z: number;
    /** Canvas-relative CSS pixel coordinate. */
    cssX: number;
    /** Canvas-relative CSS pixel coordinate. */
    cssY: number;
    /** Homogeneous clip-space W before perspective divide. */
    clipW: number;
    /** True when the point's left-handed view-space Z is <= 0. */
    behindCamera: boolean;
    /** True when the point is outside any WebGPU clip plane or is non-finite. */
    clipped: boolean;
    /** True when the point cannot appear inside the viewport's 2D rectangle, including negative clip W. */
    offscreen: boolean;
}

export function projectWorldToScreenToRef<T extends ScreenProjectionResult>(
    point: Vec3,
    view: Mat4,
    viewProjection: Mat4,
    options: ScreenProjectionOptions,
    result: T
): T;

export function projectWorldToScreen(
    point: Vec3,
    view: Mat4,
    viewProjection: Mat4,
    options: ScreenProjectionOptions
): ScreenProjectionResult;
```

`projectWorldToScreenToRef` 不执行任何内存分配，并返回调用方传入的精确 `result` 对象。`projectWorldToScreen` 是便捷形式，会分配一个结果对象。

`worldOrigin` 标识传入矩阵中 `(0, 0, 0)` 所代表的绝对世界空间位置。当 `view` 和 `viewProjection` 基于绝对世界坐标运算时可省略该参数。当启用大世界渲染（Large World Rendering）时，传入 `getFloatingOriginOffset(scene)`：Lite 的浮动原点矩阵是相对于视点（eye-relative）的，而 CPU 节点位置仍保持绝对坐标。该辅助函数在应用任一矩阵前先从输入点减去 `worldOrigin`，与 GPU 上传重基准化（rebase）行为保持一致，且不导入相机、场景或浮动原点运行时代码。

## 投影契约

Babylon Lite 矩阵采用列主序，相机采用左手坐标系。对于绝对世界点 `point` 和可选的 `worldOrigin`，该辅助函数首先计算：

```text
(x, y, z) = point - (worldOrigin ?? (0, 0, 0))
```

随后计算：

```text
viewZ = view[2]*x + view[6]*y + view[10]*z + view[14]

clipX = vp[0]*x + vp[4]*y + vp[8]*z  + vp[12]
clipY = vp[1]*x + vp[5]*y + vp[9]*z  + vp[13]
clipZ = vp[2]*x + vp[6]*y + vp[10]*z + vp[14]
clipW = vp[3]*x + vp[7]*y + vp[11]*z + vp[15]

ndcX = clipX / clipW
ndcY = clipY / clipW
ndcZ = clipZ / clipW
```

需要单独传入视图矩阵是因为齐次 W 分量仅对透视投影能区分朝向相机的半空间，而在正交投影中恒为 `1`。左手坐标系的 `viewZ <= 0` 对透视和正交投影都能正确识别相机后方的点。

NDC 映射到以左上角为原点的当前后备像素视口：

```text
canvasX = viewport.x + (ndcX + 1) * viewport.width  / 2
canvasY = viewport.y + (1 - ndcY) * viewport.height / 2
```

完整后备尺寸仅用于将绝对画布坐标映射到 CSS 空间，因此视口偏移和局部画布视口都能正确缩放：

```text
cssX = canvasX * cssWidth  / backingWidth
cssY = canvasY * cssHeight / backingHeight
```

该比例可在不读取 `globalThis.devicePixelRatio` 的情况下处理设备像素比、`maxDevicePixelRatio`、显式后备存储尺寸设置以及非整数的 CSS 到后备存储缩放比例。

## 裁剪与屏幕外行为

- 当 `viewZ <= 0` 时，`behindCamera` 为 true。
- 当点位于相机后方、`clipW` 为负、任意计算得到的坐标为非有限数、`ndcX` 或 `ndcY` 超出 `[-1, 1]`，或 `ndcZ` 超出 WebGPU 的 `[0, 1]` 深度范围时，`clipped` 为 true。
- `offscreen` 仅关注点是否可能出现在视口的二维矩形内。对于相机后方/非有限点、负 `clipW`，或 `ndcX` / `ndcY` 超出 `[-1, 1]`，它都为 true。即使单独传入的视图矩阵报告正的 `viewZ`，负 `clipW` 仍属于不可显示状态。位于二维矩形内但仅被近/远平面裁剪的点满足 `offscreen=false` 且 `clipped=true`。
- 坐标不会被钳制。视口外的有限点会保留其外推的后备/CSS 坐标，以便调用方自行放置边缘指示器。
- 当 `clipW` 为零或任何输入计算为非有限数时，`x`、`y`、`z`、`cssX` 和 `cssY` 为 `NaN`；除 `behindCamera` 外的所有状态标志均报告不可显示行为（`clipped=true`、`offscreen=true`）。
- 后备尺寸与视口宽高必须为正有限数，视口 x/y 必须为有限数，传入的 `worldOrigin` 必须包含有限分量。传入的 CSS 尺寸必须同时为正有限数。无效选项会抛出 `RangeError`，而不是返回看似成功的坐标。

## 内部架构

该模块没有可变模块状态、缓存、DOM 导入或模块级分配。`ToRef` 函数以标量形式减去可选的原点分量，直接读取标量矩阵元素，并在每次调用时写入所有结果字段，因此复用结果对象不会泄漏陈旧的 CSS 坐标或标志。

执行分配的包装函数会构造一个普通结果对象并委托给 `projectWorldToScreenToRef`；它不持有独立的数学路径。

## Babylon.js 等价映射

| Babylon Lite | Babylon.js |
| --- | --- |
| `projectWorldToScreen(point, view, viewProjection, options)` | `Vector3.Project(point, Matrix.Identity(), scene.getTransformMatrix(), viewport)` 加上后备到 CSS 的缩放 |
| `projectWorldToScreenToRef(..., result)` | `Vector3.ProjectToRef(...)` 加上后备到 CSS 的缩放与显式可见性标志 |
| `result.z` | 投影后的 `Vector3.z` |
| `result.behindCamera` | `Vector3.Project` 未返回的显式视图空间测试 |
| `result.clipped` / `result.offscreen` | `Vector3.Project` 未返回的显式状态 |

## 依赖关系

- `../math/types.js` — `Vec3`、`Mat4`
- `./viewport.js` — 仅 `PixelViewport` 类型

两者均为仅类型（type-only）导入。该模块保持为叶子模块，不引入任何运行时依赖边。

## 测试规范

| 测试项 | 预期行为 |
| --- | --- |
| 透视中心 | 相机前方点映射到视口中心 |
| 后备/CSS 缩放 | 类 DPR 的后备到 CSS 比例缩放两个坐标轴 |
| 局部视口 | NDC 角点与中心包含视口偏移/范围 |
| 透视相机后方 | `behindCamera`、`clipped` 和 `offscreen` 均为 true |
| 正交相机后方 | 尽管 `clipW=1`，独立视图空间测试仍可识别它 |
| 浮动原点透视 | 在大世界平移后，重基准化保持投影与相机后方分类不变 |
| 浮动原点正交 | 在大世界平移后，重基准化保持投影与相机后方分类不变 |
| XY 屏幕外 | 保留外推坐标；clipped/offscreen 均为 true |
| 负 clip W | 即使单独传入的视图矩阵报告点在前方，仍判为不可显示 |
| 仅深度裁剪 | clipped 为 true，而 offscreen 保持 false |
| 零 clip W | 坐标为 NaN；clipped/offscreen 为 true |
| ToRef 复用 | 返回精确的 result 对象标识；每个字段都被覆写 |
| 无效尺寸 | 非正/非有限的后备、视口或部分传入的 CSS 尺寸抛出异常 |
| 未使用时的 tree-shaking | 导入其他根导出不会保留该模块的任何代码 |

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `src/camera/world-to-screen.ts` | 纯投影函数及结果/选项契约 |
| `tests/lite/unit/world-to-screen.test.ts` | 针对数学、视口、CSS、状态及校验的专项覆盖 |
| `tests/lite/build/world-to-screen-treeshake.test.ts` | 根导出未使用保留回归测试 |
