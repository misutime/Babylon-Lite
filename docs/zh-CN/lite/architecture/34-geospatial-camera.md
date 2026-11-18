# 模块：地理空间相机（Geospatial Camera）

> 包路径：
> `packages/babylon-lite/src/camera/geospatial-camera.ts`
> `packages/babylon-lite/src/camera/geospatial-limits.ts`
> `packages/babylon-lite/src/camera/geospatial-camera-controls.ts`
> `packages/babylon-lite/src/camera/geospatial-camera-fly.ts`

## 目的

一个匹配 Babylon.js `GeospatialCamera` 的球体轨道相机。它绕位于世界原点的球形行星运行，由四个参数完全描述：

- `center` —— 相机注视的地球表面锚定点（ECEF 坐标），
- `yaw` —— 绕地心向上轴的旋转（0 = 正北，π/2 = 正东），
- `pitch` —— 从垂直向下看行星中心（0）到看向地平线（π/2）的俯仰倾角，
- `radius` —— 相机视点到 `center` 的距离（不同于 `planetRadius`）。

设置其中任意一个参数都会重新计算导出的视点 `position`、`upVector` 以及相机的世界矩阵。该相机是**纯状态**（Lite 核心原则 4b）：它从不引用场景；所有行为都位于独立函数中。

## 公共 API 接口

```ts
interface GeospatialCameraOptions {
    planetRadius: number;
}

// Core
function createGeospatialCamera(options: GeospatialCameraOptions): GeospatialCamera;
function setGeospatialOrientation(camera: GeospatialCamera, orientation: GeospatialOrientation): void;
//   GeospatialOrientation = { yaw?, pitch?, radius?, center? } — omitted fields keep their value.

// Limits
function createGeospatialLimits(planetRadius: number): GeospatialLimits;
function getEffectivePitchMax(limits: GeospatialLimits, currentRadius: number): number;
function clampZoomDistance(limits, zoomDistance, currentRadius, distanceToTarget?): number;

// Controls (interactive) — returns a disposer
function attachGeospatialControls(
    camera: GeospatialCamera,
    canvas: HTMLCanvasElement,
    scene: SceneContext,
    options?: { zoomToCursor?: boolean; checkCollisions?: boolean }z
): () => void;

// Animation
function flyGeospatialCameraToAsync(camera: GeospatialCamera, scene: SceneContext, options: GeospatialFlyOptions): Promise<void>;
//   GeospatialFlyOptions = { yaw?, pitch?, radius?, center?, durationMs?, centerHopScale? }

// Math helpers (exported for reuse / testing)
function computeLocalBasis(worldPos, refEast, refNorth, refUp): void;
function computeLookAtFromYawPitch(yaw, pitch, center, result): Vec3;
function computeYawPitchFromLookAt(lookAt, center, currentYaw, result): { x; y };
function clampCenterFromPoles(center): Vec3;
function normalizeRadians(angle: number): number;
```

用法：

```ts
const cam = createGeospatialCamera({ planetRadius: 100 });
cam.fov = 0.8;
cam.nearPlane = 1;
cam.farPlane = 100 * 16;
setGeospatialOrientation(cam, { center: { x: 100, y: 0, z: 0 }, radius: 170, yaw: 0.6, pitch: 0.85 });
scene.camera = cam;

// Interactive:
const dispose = attachGeospatialControls(cam, canvas, scene, { zoomToCursor: true });
// Animated:
await flyGeospatialCameraToAsync(cam, scene, { yaw: 1.2, radius: 250, durationMs: 1500 });
```

## 内部架构

`GeospatialCamera extends Camera, IWorldMatrixProvider, IParentable`。相机存储 `center/yaw/pitch/radius` 以及导出的 `position`、`upVector` 和私有 `_lookAt`。公共标量属性（`yaw`、`pitch`、`radius`、`center`）是 getter/setter，会通过内部的 `_setOrientation(yaw, pitch, radius, center)` 闭包重新运行朝向数学计算。

### 世界矩阵（Camera 契约）

与 `FreeCamera` 一样，该相机生成一个由 `LookAtLH(position, position + lookAt, upVector)` 视图矩阵转置回相机到世界旋转矩阵、并以 `position` 作为平移列的**局部世界矩阵**。共享的 `getViewMatrix(camera)`（位于 `camera.ts`）从 `worldMatrix` 重新推导出视图矩阵（`R = transpose(world.R)`，`t = -R · eye`），因此不需要定制的视图矩阵代码。每次朝向变化都会通过共享的 `world-matrix-state` 辅助函数递增 `worldMatrixVersion`，从而驱动视图/投影缓存更新。

## 朝向数学（`geospatial-camera.ts`）

这是 Babylon.js `GeospatialCamera._setOrientation` 与 `ComputeLocalBasisToRefs` / `ComputeLookAtFromYawPitchToRef` 的忠实左手坐标系移植。

`_setOrientation(yaw, pitch, radius, center)`：

1. `yaw = NormalizeRadians(yaw)`，`pitch = NormalizeRadians(pitch)`，拷贝 `center`。
2. **钳位到限制范围：** `yaw → [yawMin, yawMax]`，`pitch → [pitchMin, getEffectivePitchMax(radius)]`，`radius → [radiusMin, radiusMax]`，然后执行 `clampCenterFromPoles(center)`。
3. **`center` 处的局部基**（左手系）：`up = normalize(center)`，`east = cross(up, +Z)`（在极点处回退到 `cross(up, +X)`），`north = cross(east, up)`。
4. **lookAt：** `horiz = north·cos(yaw) + east·sin(yaw)`；`lookAt = normalize(horiz·sin(pitch) − up·cos(pitch))`。
5. **相机上方向：** `right = cross(up, lookAt)`（垂直向下看时回退到 `cross(horiz, lookAt)`）；`upVector = normalize(cross(lookAt, right))`。
6. **视点：** `position = center − lookAt·radius`；将世界矩阵标记为脏。

`computeYawPitchFromLookAt` 是精确的逆运算（供控制器的平移/缩放重定中心路径使用）：`cosPitch = −(lookAt · up)`，`pitch = acos(cosPitch)`，`lookHorizontal = lookAt + up·cosPitch`，以及 `yaw = atan2(lookHorizontal·east, lookHorizontal·north)`。

### 手性说明

Babylon 的左手分支将 `east` 定义为 `cross(up, worldNorth)`，其中 `worldNorth = +Z`（`LeftHandedForwardReadOnly`）。Lite 采用左手坐标系（`useRightHandedSystem = false`），因此原样使用了该分支——有意**没有**移植右手坐标系的叉乘顺序。

## 限制（`geospatial-limits.ts`）

镜像 Babylon 默认值：`radiusMin = 10`，`radiusMax = planetRadius·4`，`pitchMin = ε (0.001)`，`pitchMax = π/2 − 0.01`，`yawMin/Max = ∓∞`，`pitchDisabledRadiusScale = { x: 2, y: 4 }`。

`getEffectivePitchMax(radius)` 在半径从 `x·planetRadius` 增长到 `y·planetRadius` 的过程中，将允许的最大俯仰角从 `pitchMax` 线性衰减到 `pitchMin`，因此完全拉远的相机只会垂直向下看。**结果：** 当通过单个 setter 命令式设置姿态时，应先设置 `radius` 再设置 `pitch`（或者使用 `setGeospatialOrientation`，它会感知半径并在一次调用中应用全部四个参数）。

## 移动 / 控制器（`geospatial-camera-controls.ts`）

`attachGeospatialControls` 移植了 Babylon 的帧率无关物理模型（`GeospatialCameraMovement` + `CameraMovement`）：逐帧输入像素增量累积到速度中，并按逐轴惯性衰减（`frameDecay = inertia^(Δt / (1000/60))`），每帧在 `scene._beforeRender`（接收帧间隔 `deltaMs`）中积分一次。

交互方式：

- **左键拖拽** —— 平移；光标通过拖拽平面（拾取表面点处的切平面）保持锚定在地球上，并使用 `computeYawPitchFromLookAt` 重新定心。
- **中键/右键拖拽** —— 旋转（偏航 + 俯仰/倾斜），速率为每像素 `π/500` 弧度。
- **滚轮** —— 缩放；默认朝光标方向缩放（`zoomToCursor`），否则沿视线向量缩放。缩放速度随到目标的距离缩放，并在拖拽/旋转期间被抑制。`zoomInertia = 0.9`（其他默认均为 0）。
- **触控** —— 单指拖拽平移（通过指针事件）；双指捏合朝质心缩放（解析射线求交），并在质心漂移 ≥ 20 px 时升级为平移。双指按下期间会抑制指针驱动的平移/旋转，并阻止 `gesture*`/原生捏合缩放。
- **键盘** —— 方向键平移（从画布中心拖拽），Ctrl+方向键倾斜（俯仰/偏航），+/− 沿视线向量缩放。
- **碰撞**（`checkCollisions`）—— 钳位视点使其不会陷入地表以下。

### 球体拾取 —— 解析射线-球体求交（关键简化）

由于地球是以原点为中心、半径为 `planetRadius` 的球体，拾取**不需要**网格拾取子系统。来自 `createPickingRay` 的拾取射线直接与球体进行解析求交（二次方程 `a = 1`，`b = 2·O·D`，`c = O·O − R²`），取最近的正根。这是与 Babylon 通用 `scene.pick` 方式相比最主要的结构差异，并使该模块保持自包含。

## 飞行动画（`geospatial-camera-fly.ts`）

`flyGeospatialCameraToAsync` 在 `durationMs` 时间内使用三次缓入缓出（匹配 `CubicEase` `EASEINOUT`）对 `yaw/pitch/radius/center` 进行补间，由 `scene._beforeRender` 驱动。偏航角走最短角路径；`center` 沿大圆弧（ECEF 球面线性插值 slerp）移动，并带有可选的抛物线跳跃高度（`centerHopScale`）。同一时间只能运行一个飞行动画：相机存储一个 `_cancelFly` 回调，`attachGeospatialControls` 会在用户输入时调用它（打断飞行），后续的 `flyGeospatialCameraToAsync` 调用也会在开始前调用它。

## Babylon.js 对照表

| Babylon.js                                    | Babylon Lite                                         |
| --------------------------------------------- | ---------------------------------------------------- |
| `GeospatialCamera._setOrientation`            | `applyOrientation`（`geospatial-camera.ts` 中的闭包） |
| `ComputeLocalBasisToRefs`（LH 分支）          | `computeLocalBasis`                                  |
| `ComputeLookAtFromYawPitchToRef`              | `computeLookAtFromYawPitch`                          |
| `ComputeYawPitchFromLookAtToRef`              | `computeYawPitchFromLookAt`                          |
| `ClampCenterFromPolesInPlace`                 | `clampCenterFromPoles`                               |
| `GeospatialLimits` + `getEffectivePitchMax`   | `geospatial-limits.ts`                               |
| `GeospatialCameraMovement` / `CameraMovement` | `attachGeospatialControls` 中的物理逻辑              |
| 对地球网格调用 `scene.pick`                   | 解析射线-球体求交 `intersectPlanet`                  |
| `flyToAsync` + `InterpolatingBehavior`        | `flyGeospatialCameraToAsync`                         |
| `Matrix.LookAtLHToRef(pos, center, up)`       | 从相机世界矩阵推导 `getViewMatrix`                   |

## 打包体积规范

所有地理空间代码都位于四个新的 `camera/` 模块中，仅通过它们各自在 `index.ts` 中的导出访问；从不创建地理空间相机的场景支付零字节体积。核心（`geospatial-camera.ts` + `geospatial-limits.ts`）对控制器或飞行模块没有任何依赖，因此静态姿态场景无需拉取交互物理代码。

## 依赖关系

`camera`（`Camera`、`getViewProjectionMatrix`）、`scene/world-matrix-state`、`scene/parentable`、`math/_matrix-allocator`、`math/write-look-at-world-mat4-lh-into-buffer`、`math/invert-mat4`、`picking/ray`（`createPickingRay`）、`scene/scene-core`（`SceneContext` 类型 + `_beforeRender`）。

## 测试规范

`tests/lite/parity/scenes/scene225-geospatial-camera.spec.ts` —— 捕获 BJS `GeospatialCamera` 基准图（`captureGolden({ force: true })`）并对比 `scene225.html` 的 Lite 渲染结果：一个带有六个彩色表面标记立方体的蓝色地球（`planetRadius = 100`），从固定且确定性的姿态（`center = ECEF(20°, 30°)`、`radius = 170`、`yaw = 0.6`、`pitch = 0.85`）观察且未挂载控制器。标记立方体打破了球体的旋转对称性，从而使偏航角可被观测。阈值 `maxMad` 位于 `scene-config.json` 中。

## 文件清单

- `camera/geospatial-camera.ts` —— 接口、工厂、朝向数学、基向量辅助函数、飞行状态字段。
- `camera/geospatial-limits.ts` —— `GeospatialLimits` + 钳位/有效俯仰角辅助函数。
- `camera/geospatial-camera-controls.ts` —— 交互式移动物理、解析拾取、平移/缩放/旋转/键盘/碰撞。
- `camera/geospatial-camera-fly.ts` —— 带 ECEF slerp 与高度跳跃的缓入缓出飞行动画。
- `lab/lite/src/lite/scene225.ts`、`lab/lite/scene225.html` —— Lite 演示场景。
- `lab/lite/src/bjs/scene225.ts`、`lab/lite/babylon-ref-scene225.html` —— BJS 基准参照。
- `reference/lite/scene225-geospatial-camera/babylon-ref-golden.png` —— 基准图（测试时捕获）。
