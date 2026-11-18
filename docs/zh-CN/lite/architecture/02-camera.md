# 模块：Camera（ArcRotateCamera + FreeCamera）

> 包路径：`packages/babylon-lite/src/camera/`

## 目的

Camera 模块以纯数据对象的形式提供了两种相机实现，外加独立的矩阵辅助函数和将 DOM 事件连接到相机属性修改的配套控制函数。相机是纯粹的数据 —— 在挂载控制器之前，它们对场景和 DOM 一无所知。两种相机均实现了共享的 `Camera` 接口，并通过 `IWorldMatrixProvider` / `IParentable` 集成到场景的世界矩阵层级结构中。

## 公共 API 接口

### `camera.ts` — 共享相机契约

```typescript
/** Minimal camera contract — any camera with world and projection state.
 *  Both ArcRotateCamera and FreeCamera implement this interface.
 *  Plain data, no scene knowledge (pillar 4b). */
export interface Camera {
    fov: number;
    nearPlane: number;
    farPlane: number;
    viewport?: NormalizedViewport;
    children: SceneNode[];
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
    ortho?: OrthographicBounds | null;
}

export function getViewMatrix(camera: Camera): Mat4;
export function getProjectionMatrix(camera: Camera, aspectRatio: number): Mat4;
export function getViewProjectionMatrix(camera: Camera, aspectRatio: number): Mat4;
export function getCameraPosition(camera: Camera): Vec3;
```

### `arc-rotate.ts`

```typescript
/** ArcRotateCamera — orbits around a target point.
 *  Uses Babylon.js convention: left-handed, alpha=rotation around Y, beta=elevation.
 *  Plain data. Does NOT know about the scene.
 *
 *  Push-based dirty tracking: alpha/beta/radius use Object.defineProperty,
 *  target uses ObservableVec3. Changes call wm.markLocalDirty() immediately.
 *
 *  Inertia follows the Babylon.js model: input handlers accumulate per-frame
 *  offsets (inertialAlphaOffset, etc.) which are applied and exponentially
 *  decayed each frame by the controls module. */
export interface ArcRotateCamera extends IWorldMatrixProvider, IParentable {
    alpha: number; // Rotation around Y axis (radians)
    beta: number; // Elevation angle from Y axis (radians, 0=top, π=bottom)
    radius: number; // Distance from target
    target: Vec3; // Orbit center point (ObservableVec3 at runtime)
    fov: number; // Vertical field of view (radians)
    nearPlane: number; // Near clipping plane
    farPlane: number; // Far clipping plane

    inertia: number; // Inertia for rotation & zoom (0=instant, 0.9=default, 1=no decay)
    panningInertia: number; // Inertia for panning (0=instant, 0.9=default)

    inertialAlphaOffset: number; // Per-frame accumulated rotation offset
    inertialBetaOffset: number;
    inertialRadiusOffset: number; // Per-frame accumulated zoom offset
    inertialPanningX: number; // Per-frame accumulated pan offset
    inertialPanningY: number;

    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

/** Create a bare ArcRotateCamera with given params. Pure data, no scene knowledge. */
export function createArcRotateCamera(alpha: number, beta: number, radius: number, target: Vec3): ArcRotateCamera;
```

**默认值**（在 `createArcRotateCamera` 中设置）：

- `fov = 0.8`（约 45.8°）
- `nearPlane = 0.1`
- `farPlane = 1000`
- `inertia = 0.9`
- `panningInertia = 0.9`

### `arc-rotate-controls.ts`

```typescript
/** Camera gesture assigned to a pointer button. */
export type ArcRotatePointerAction = "rotate" | "pan";

/** Optional non-touch pointer-button mappings.
 *  Omitted fields preserve the default independently. */
export interface ArcRotatePointerMappings {
    /** Primary button (PointerEvent.button 0). Default: "rotate". */
    primaryButton?: ArcRotatePointerAction;
    /** Secondary button (PointerEvent.button 2). Default: "pan". */
    secondaryButton?: ArcRotatePointerAction;
}

export interface AttachControlOptions {
    /** Non-touch pointer-button mappings. Touch remains one-finger rotate + pinch zoom. */
    pointerMappings?: ArcRotatePointerMappings;
    /** Keyboard controls after enableArcRotateKeyboardControls() installs the opt-in seam. */
    keyboard?: boolean | ArcRotateKeyboardOptions;
    shouldHandlePointerDown?: (event: PointerEvent) => boolean;
    isExternalDragActive?: () => boolean;
    isExternalPickPending?: () => boolean;
}

/** Attach orbit/zoom/pan controls to an ArcRotateCamera.
 *  Matches Babylon.js ArcRotateCameraPointersInput behavior with inertia.
 *  Input handlers accumulate into the camera's inertial offset properties.
 *  Inertia is applied each frame via scene._beforeRender (single RAF loop).
 *  Returns a cleanup function to remove all event listeners and the beforeRender hook. */
export function attachControl(camera: ArcRotateCamera, canvas: HTMLCanvasElement, scene?: SceneContext, options?: AttachControlOptions): () => void;
```

### `arc-rotate-keyboard-controls.ts`

```typescript
/** KeyboardEvent.code mappings. Omitted fields retain the Arrow-key defaults. */
export interface ArcRotateKeyboardMappings {
    left?: readonly string[];
    right?: readonly string[];
    up?: readonly string[];
    down?: readonly string[];
}

/** Optional keyboard configuration used after installing the keyboard seam. */
export interface ArcRotateKeyboardOptions {
    /** Key mappings, matched against KeyboardEvent.code. */
    keys?: ArcRotateKeyboardMappings;
    /** Prevent browser defaults for mapped keydown/keyup events. Default: true. */
    preventDefault?: boolean;
    /** Rotation divisor. Higher values rotate more slowly. Default: 100. */
    angularSensitivity?: number;
    /** Panning divisor. Higher values pan more slowly. Default: 50. */
    panningSensitivity?: number;
    /** Zooming divisor. Higher values zoom more slowly. Default: 25. */
    zoomingSensitivity?: number;
}

/** Install the optional arc-rotate keyboard input seam. Process-global and idempotent. */
export function enableArcRotateKeyboardControls(): void;
```

`pointerMappings` 会在每次非触摸 `pointerdown` 时解析。每个按键独立回退默认值，因此 `{ primaryButton: "pan" }` 仅改变主键行为，而次键仍保持平移。选定的动作在该次拖拽期间保持固定。两种动作均使用现有的惯性路径和指针捕获；滚轮输入始终用于缩放且不可重映射。触摸输入会忽略 `pointerMappings`：单指旋转、双指捏合缩放，与默认控制完全一致。

键盘支持是一个独立的可选模块。在挂载启用键盘的相机之前，先调用一次 `enableArcRotateKeyboardControls()`。该启用函数会在 `attachControl` 中安装一个不透明工厂接缝（seam）；当打包产物中未引入该启用函数时，工厂、监听器行为、按住键状态以及可选的逐帧/清理调用都会被全部裁剪掉。这使得仅使用指针的场景无需承担任何键盘实现的字节开销。

安装该接缝后，若省略 `keyboard` 或传入 `false`，键盘输入仍保持禁用。传入 `keyboard: true` 会启用传统的方向键行为。传入配置对象同样会启用键盘输入，并可独立覆盖任意方向的 `KeyboardEvent.code` 列表；传入空列表则会禁用该方向。除非 `preventDefault` 为 `false`，否则已映射按键的 `keydown` 和 `keyup` 事件会阻止浏览器默认行为；无论是否阻止默认行为，输入处理和移动均保持启用。灵敏度参数作为除数使用，因此默认值在每个渲染帧分别产生 `1 / 100`、`1 / 50` 和 `1 / 25` 的角度、平移和缩放增量。

### `free-camera.ts`

```typescript
/** FreeCamera — positioned in world space, looking at a target point.
 *  Matches Babylon.js FreeCamera: position + target, left-handed.
 *  Plain data. Does NOT know about the scene.
 *
 *  Push-based dirty tracking: position and target use ObservableVec3,
 *  _yaw/_pitch use Object.defineProperty. */
export interface FreeCamera extends Camera, IWorldMatrixProvider, IParentable {
    position: ObservableVec3; // World-space position
    target: ObservableVec3; // Look-at target (auto-updated by controls from yaw/pitch)
    speed: number; // Movement speed (default 2.0, matches BJS)
    angularSensitivity: number; // Mouse rotation sensitivity (higher=less sensitive, default 2000)
    inertia: number; // Inertia damping factor (0=instant stop, 0.9=smooth, default 0.9)
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

/** @internal FreeCamera with internal yaw/pitch state. Not re-exported from index.ts. */
export interface FreeCameraInternal extends FreeCamera {
    _yaw: number;
    _pitch: number;
}

/** Create a FreeCamera at the given position looking at target. Pure data, no scene knowledge. */
export function createFreeCamera(position: Vec3, target: Vec3): FreeCamera;
```

**默认值**（在 `createFreeCamera` 中设置）：

- `fov = 0.8`（约 45.8°）
- `nearPlane = 1`
- `farPlane = 10000`
- `speed = 2.0`
- `angularSensitivity = 2000`
- `inertia = 0.9`

**glTF 加载器消费者**：调用 `enableGltfCameras()` 后，`gltf-feature-camera.ts`（见模块 04 “glTF `camera` 节点属性”）会将每个内嵌 glTF 相机构建为位于 `(0,0,0)` 且朝向 `(0,0,-1)` 的 `FreeCamera` —— 遵循 glTF 自身的局部 -Z 前向/+Y 向上约定 —— 并通过一个抵消引擎 RH→LH 根镜像的 `fixupNode` 建立父子关系。每个导入的相机都会将其世界变换还原为单位缩放，以保证默认的刚体视图逆矩阵依然精确；投影参数保持源 glTF 单位。不支持零缩放、非均匀缩放或带动画的祖先缩放。加载器随后通过 `AssetContainer.cameras` 暴露结果。

### `banked-free-camera.ts` — 可选的滚转上方向向量

```typescript
/** A FreeCamera with an explicit, mutable world-space up vector. */
export interface BankedFreeCamera extends FreeCamera {
    readonly upVector: ObservableVec3;
}

/** Create a FreeCamera whose look-at up vector is explicit and mutable, so the camera can roll. */
export function createBankedFreeCamera(position: Vec3, target: Vec3, up?: Vec3): BankedFreeCamera;
```

普通的 `createFreeCamera` 基于共享常量 `Vec3Up` 构建其基向量，永远无法进行滚转（roll）。而固定在倾斜或倒置赛道车辆上的追逐相机，需要第三个基向量随车辆一起转动；`createBankedFreeCamera` 正好只暴露了这一能力而别无他物。

两个构造函数共用同一个工厂函数 —— `free-camera.ts` 中的 `_createFreeCamera(position, target, up: Vec3)`，它始终直接使用传入的 `up` 且完全没有“倾斜（banked）”的概念：从不对 `up` 向量的来源做分支判断，也从不定义 `upVector` 属性。`createFreeCamera` 传入共享常量 `Vec3Up`，因此从未导入倾斜构造函数的场景与该功能出现前相比字节完全一致。`createBankedFreeCamera` 自行完成所有可选扩展工作：它创建自己的 `ObservableVec3` 上方向向量 —— 由于工厂函数在内部计算 `wm`，因此等 `cam` 存在后再将其脏回调延迟绑定到 `_markLocalMatrixDirty(cam)` —— 仅在此之后才在返回的相机上定义公共 `upVector` 属性。写入 `upVector` 会像写入 `position` / `target` 一样同时使局部与世界矩阵缓存失效。`up` 默认为世界 +Y 轴，这使得倾斜相机的初始世界矩阵与普通相机完全一致。退化的 `up`（与视线方向平行）会回退到单位旋转矩阵，与 `writeLookAtWorldMat4LHIntoBuffer` 一致。

等价于 Babylon.js 的 `camera.upVector`，即 `TargetCamera._getViewMatrix` 传递给 `Matrix.LookAtLHToRef` 的向量。

### `free-camera-controls.ts`

```typescript
/** Attach keyboard + mouse controls to a FreeCamera.
 *  Matches Babylon.js FreeCamera input behavior.
 *  Camera stays plain data — this function reads/writes its properties.
 *  Returns a cleanup function to remove all listeners and the beforeRender hook. */
export interface FreeCameraControlOptions {
    upKeys?: readonly string[];
    downKeys?: readonly string[];
    fastKeys?: readonly string[];
    fastMultiplier?: number;
}
export function attachFreeControl(camera: FreeCamera, canvas: HTMLCanvasElement, scene?: SceneContext): () => void;
export function attachConfigurableFreeControl(camera: FreeCamera, canvas: HTMLCanvasElement, scene?: SceneContext, options?: FreeCameraControlOptions): () => void;
```

`attachFreeControl` 保留了现有场景使用的默认按键映射与字节完全一致的实现。`attachConfigurableFreeControl` 是一个独立的可选接口，使自定义按键数组和加速逻辑不会给普通自由相机用户增加任何字节。其 `upKeys`/`downKeys` 替换默认的 Space+PageUp / Shift+PageDown 垂直移动映射；`fastKeys` 和 `fastMultiplier` 则在按住对应键时应用速度倍率提升。鼠标视角控制与惯性保持不变。

### `orthographic.ts` — 可选正交投影

```typescript
/** Live orthographic view-volume extents, in world units. Mutable and animatable:
 *  every setter invalidates the camera's projection cache. A plane left `null` is
 *  derived from `halfHeight` (horizontally scaled by the render aspect ratio). */
export interface OrthographicBounds {
    halfHeight: number;
    left: number | null;
    right: number | null;
    bottom: number | null;
    top: number | null;
}

/** Initial extents — every field optional, omitted planes derived from `halfHeight` (default 1). */
export interface OrthographicBoundsOptions {
    halfHeight?: number;
    left?: number | null;
    right?: number | null;
    bottom?: number | null;
    top?: number | null;
}

/** Switch a camera to an orthographic projection; returns the live `camera.ortho` bounds. */
export function enableOrthographicCamera(camera: Camera, bounds?: OrthographicBoundsOptions): OrthographicBounds;

/** Switch a camera back to its perspective projection. */
export function disableOrthographicCamera(camera: Camera): void;
```

适用于任何满足 `Camera` 契约的相机（ArcRotate、Free、Geospatial）—— 投影方式与相机的定位方式正交解耦。深度范围仍由 `camera.nearPlane` / `camera.farPlane` 决定；在此模式下 `camera.fov` 不起作用，因此正交相机通过修改 `halfHeight` 来实现缩放。

#### 在运行时修改视景体范围

只需调用一次 `enableOrthographicCamera`。它返回的边界对象（也可通过 `camera.ortho` 访问）保持实时活跃状态，因此可以在每帧中驱动其范围：

```typescript
const ortho = enableOrthographicCamera(camera, { halfHeight: 6 });
onBeforeRender(scene, () => {
    ortho.halfHeight = 6 + Math.sin(t) * 2; // zoom
});
```

每个字段都是一个访问器，在发生变化时会使相机的投影状态失效。这一点至关重要，因为投影缓存以 `_cameraChangeKey` + 宽高比作为键 —— 当仅有视景体范围变化时两者均未改变，因此如果没有访问器，新的边界直到相机移动时才会被读取。

失效操作通过专用的投影修订号进行，**而不仅仅**是清除 `_projVer` / `_vpVer`，**也并非**通过将相机变换标记为脏。仅清除矩阵缓存只能修复 getter 的返回值，而无法更新渲染帧：逐帧消费者依据相机变更键来决定是否执行 GPU 上传，前向通道的 `_writePassSceneUBO` 在 `[camera, fog, changeKey, aspect, exposure, contrast, envTextures]` 未变时会提前返回（ShaderMaterial、文本、分簇光照、TAA 和 CSM 均有等价的门控）。更改视景体不会改变其中任何一项，因此处于稳态的场景会继续使用先前上传的视图投影矩阵进行渲染，即便 `getProjectionMatrix` 返回的已是新矩阵。

因此，每个边界 setter 都会递增 `camera._projRev`，依赖投影的消费者以 `_cameraChangeKey(camera)` 作为键，该函数将其与变换版本相加（同时也会轮询 `fov` / `nearPlane` / `farPlane` —— 见**投影变更检测**）：

```typescript
camera.worldMatrixVersion + (camera._projRev ?? 0);
```

两项均单调不减，因此其和也单调不减，且任一项发生变化都会使该和严格增大 —— 不可能发生别名碰撞。（与 `shadow-base.ts` 及 `gltf-feature-lights-punctual.ts` 使用了相同的版本累加惯用法。）

特意将该修订号与 **`worldMatrixVersion` 分离**，而非并入其中。将相机变换标脏意味着相机发生了_位移_，这不仅会使相机的子级全部失效（世界矩阵状态会将失效通过 `_children` 向下推送），而且在启用浮动原点时会导致 `wrapRenderableForFO` 对场景中的**每一个可渲染对象**执行重定基准 —— 如果每帧都在对 `ortho.halfHeight` 做动画，而相机在世界空间中根本没有移动，这会带来不必要的逐帧开销。仅关心变换的消费者（浮动原点、子节点、网格 UBO）继续读取 `worldMatrixVersion`，并且正确地不受其影响。

由于这些字段是真正的可枚举自有属性（通过 `Object.defineProperty` 定义，而非留作可选字段），它们也能解析为动画属性路径。`resolvePropertyBinding` 使用 `in` 遍历路径，并通过普通的 `target[prop] = value` 赋值语句写入，该赋值会直接命中 setter：

```typescript
const clip = createPropertyAnimationClip("orthoZoom", [
    {
        path: "ortho.halfHeight",
        keys: [
            { frame: 0, value: 6 },
            { frame: 60, value: 2 },
        ],
    },
]);
createPropertyAnimationGroup(manager, camera, clip, { fromFrame: 0, toFrame: 60, loop: true });
```

将某个平面设为数字会产生偏心视景体（对应 Babylon 的 `orthoLeft` / `orthoRight` / `orthoBottom` / `orthoTop`）；将其设回 `null` 则恢复为由 `halfHeight` 推导出的范围。

## 内部架构

### 共享世界矩阵集成

两种相机类型都使用 `createWorldMatrixState()` 与场景的父子层级进行基于推送的脏追踪。相机的局部世界矩阵根据其自身状态计算（ArcRotate 使用球坐标参数，Free 使用 position+target），然后按需乘以父级的世界矩阵。

视图矩阵由世界矩阵通过转置左上角 3×3 旋转块并取反平移量导出：

```
viewMatrix[0..2]   = column 0 of worldMatrix (transposed row 0)
viewMatrix[4..6]   = column 1 of worldMatrix (transposed row 1)
viewMatrix[8..10]  = column 2 of worldMatrix (transposed row 2)
viewMatrix[12..14] = -(rotation^T × eye)
viewMatrix[15]     = 1
```

`getCameraPosition(camera)` 从最终世界矩阵中读取平移量：`{ x: w[12], y: w[13], z: w[14] }`。

### ArcRotateCamera 位置计算

相机的局部观察点（eye）位置由球坐标计算得出：

```
sinB = sin(beta)    // if sinB == 0, clamp to 0.0001
cosB = cos(beta)
cosA = cos(alpha)
sinA = sin(alpha)

eye.x = target.x + radius * cosA * sinB
eye.y = target.y + radius * cosB
eye.z = target.z + radius * sinA * sinB
```

这是 **Babylon.js 左手系**球坐标约定：

- `alpha` 绕 Y 轴旋转
- `beta` 是相对于 +Y 轴的极角（0 = 垂直向下看，π = 垂直向上看）
- 当 `alpha = -π/2, beta = π/2` 时，相机位于 +Z 轴上朝向目标点

局部世界矩阵为：视图矩阵左上角 3×3 的转置加上观察点位置。

### ArcRotateCamera 脏追踪

`alpha`、`beta`、`radius` 使用 `Object.defineProperty` 定义带有 setter 的属性，并在变更时调用 `wm.markLocalDirty()`。`target` 是一个 `ObservableVec3`，当任意分量（x、y、z）被修改时会调用相同的脏回调。

### FreeCamera 位置与朝向

FreeCamera 的局部世界矩阵通过 `writeLookAtWorldMat4LHIntoBuffer(_localMat, position, target, up)` 计算 —— 参见下文的**世界矩阵（所有相机）**。对于 `createFreeCamera`，`up` 是共享常量 `Vec3Up`；对于 `createBankedFreeCamera`，`up` 是相机自身的 `upVector`；`_createFreeCamera` 直接读取传入的向量而不做任何分支判断。

初始偏航角（yaw）和俯仰角（pitch）由 position→target 方向推导而出：

```
dx = target.x - position.x
dy = target.y - position.y
dz = target.z - position.z

_yaw   = atan2(dx, dz)
_pitch = atan2(dy, sqrt(dx² + dz²))
```

### FreeCamera 脏追踪

`position` 和 `target` 是 `ObservableVec3` 实例。`_yaw` 和 `_pitch` 使用 `Object.defineProperty`。所有修改都会调用 `wm.markLocalDirty()`。`BankedFreeCamera` 额外增加 `upVector`，它是相机自身的 `ObservableVec3`（完全在 `banked-free-camera.ts` 中构造和定义），其脏回调会通过共享的 `_markLocalMatrixDirty()` 接缝同时使相机的局部与世界矩阵缓存失效。

### 视图矩阵

两种相机使用相同的“世界矩阵转视图矩阵”求逆方式（如上所述）。对于各自对应的 eye/target 值，这等价于 `createLookAtMat4LH(eye, target, Vec3Up)`。

### 世界矩阵（所有相机）

相机的局部矩阵是其**相机到世界（camera-to-world）**矩阵 —— 相机像其他节点一样参与父子层级，而 `getViewMatrix` 每帧对其求逆。`writeLookAtWorldMat4LHIntoBuffer(out, eye, target, up)` 直接将其写为列向量 `[xAxis, yAxis, zAxis, eye]`，其中的基向量与 `createLookAtMat4LH` 所推导的完全一致：

```
zAxis = normalize(target - eye)          // left-handed: +Z looks at the target
xAxis = normalize(cross(up, zAxis))
yAxis = cross(zAxis, xAxis)
```

三个工厂（`ArcRotate`、`Free`、`Geospatial`）都调用该函数。此前它们先用 `createLookAtMat4LH` 构建**视图**矩阵，再手工逆转回去 —— 分配一个 `Float32Array`，计算一个随即被 eye 覆盖的包含三个点积的平移列，然后再转置旋转部分 —— 且那段 17 行的转置代码块在每个工厂中都复制粘贴了一份。退化输入（eye 与 target 重合，或视线方向与 `up` 平行）会保留带有 eye 平移的单位旋转矩阵，与 `createLookAtMat4LH` 的单位矩阵回退行为完全匹配。

### 投影矩阵

两种相机均使用：`createPerspectiveMat4LH(fov, aspectRatio, nearPlane, farPlane)` —— 带有反向 Z（reverse-Z）零到一深度映射的左手系透视投影（`nearPlane` 映射到 `1`，`farPlane` 映射到 `0`）。

### 投影变更检测

`fov`、`nearPlane` 和 `farPlane` 是纯数据相机上的普通可写字段（支柱 4b′），因此写入它们不会通知任何对象。`camera.ts` 中的矩阵缓存以及每个依赖投影的逐帧消费者都以 `_cameraChangeKey` 为键，该函数**按值轮询这三个字段**并将任何变动并入 `camera._projRev`：

```typescript
export function _cameraChangeKey(camera: Camera): number {
    if (camera._projFov !== camera.fov || camera._projNear !== camera.nearPlane || camera._projFar !== camera.farPlane) {
        camera._projFov = camera.fov;
        camera._projNear = camera.nearPlane;
        camera._projFar = camera.farPlane;
        camera._projRev = (camera._projRev ?? 0) + 1;
    }
    return camera.worldMatrixVersion + (camera._projRev ?? 0);
}
```

在此处轮询而非在每个相机工厂中安装访问器，使投影契约保持在**单一**位置，对各相机类型零开销，并且适用于满足 `Camera` 接口的手写对象 —— 这与 `world-matrix-state.ts` 轮询外部父节点版本而非向其推送失效通知的思路一致。正交边界则相反，采用_推送_方式（见下文）：该模块本身已拥有 setter，因此推送是精确的，且轮询无需承担任何开销。

### 正交投影接缝（零开销按需引入）

`camera.ts` 持有一个模块局部变量 `let _orthoProjector = null` 以及一个仅由 `orthographic.ts` 调用的 `@internal` setter `_installOrthographicProjector()`。`getProjectionMatrix` 根据 `_orthoProjector !== null && camera.ortho` 进行分支。当打包产物中不包含 `enableOrthographicCamera` 时，该 setter 会被 tree-shake 移除，打包器即可证明投影器始终为 `null`，从而将整个正交分支折叠消除 —— 纯透视场景保持字节完全一致。这与 `standard-pipeline.ts` 中的 `_stencilResolver` / `_stdVertexColorFragment` 接缝模式相同。

实时边界变更的缓存失效被特意排除在共享路径之外：由边界 setter 递增 `camera._projRev`。依赖投影的消费者改为读取 `_cameraChangeKey(camera)` 来代替 `camera.worldMatrixVersion`，这只是一次替换而非额外的比较操作，因此任何逐帧门控都不会增加槽位。

`writeOrthoOffCenterMat4LHIntoBuffer` 写入一个反向 Z（reverse-Z）的 `OrthoOffCenterLH` 矩阵，使正交相机能共享引擎的反向 Z 深度状态（清除值 `0`，比较函数 `greater`）：

```
m[0]  =  2 / (right - left)      m[12] = (left + right) / (left - right)
m[5]  =  2 / (top - bottom)      m[13] = (top + bottom) / (bottom - top)
m[10] = -1 / (far - near)        m[14] = far / (far - near)
m[11] =  0                       m[15] = 1
```

`writePerspectiveMat4LHIntoBuffer` 仅写入透视矩阵所需的项，并依赖新分配（已清零）缓存的其余元素。正交写入器会覆盖**全部 16 个元素**，因此在共享缓存上从透视切换为正交是无条件安全的；但反向切换并不对称，因为 `m[12]`、`m[13]` 和 `m[15]` 仅由正交路径写入，因此 `disableOrthographicCamera` 在交回 `_projCache` 前会精确清除这三个元素。由可选投影器完全覆盖其输出是核心契约，这样未来即使引入第三种投影类型也不会被此前运行过的投影器残留数据所污染。该清理逻辑位于延迟加载模块中，共享透视路径无需为此付出任何代价。

### 仍假设透视投影的消费者

正交支持属于投影级别；少数功能会从投影矩阵推导屏幕空间量，因而需要各自的处理。分簇光照（Clustered lighting）的 `projectedSphereBounds` 根据 `proj[11] === 0`（透视为 1，正交为 0 —— 一个与投影类型无关的判别式）进行分支，并使用不受深度影响且遵守 `proj[12]` / `proj[13]` 偏心偏移量的边界计算；而透视路径则按视图深度缩放轮廓并完全忽略这些偏移量。

以下功能目前仍仅支持透视投影，因此在正交相机下**不受支持**：

| 功能         | 假设条件                                                                |
| ------------ | ----------------------------------------------------------------------- |
| 高斯泼溅     | `1/z` 泼溅尺寸计算及 `gs-depth-fragments.ts` 中的线性深度解码           |
| 相机辅助线框 | 始终绘制透视视锥体线框（`camera-gizmo.ts`）                             |

启用/禁用以及每次调用边界 setter 都会重置投影状态 —— 这正是视景体范围在相机不移动时也能生效的原因（否则投影缓存仅以 `_cameraChangeKey` + 宽高比为键）。

### 视图投影矩阵

两种相机均为：`multiplyMat4(projectionMatrix, viewMatrix)`。

---

## ArcRotateCamera 控制 — 惯性模型

### 灵敏度常量

| 常量                 | 值     | 说明             |
| -------------------- | ------ | ---------------- |
| `angularSensibility` | `1000` | Babylon 默认值   |
| `panningSensibility` | `50`   | 每单位对应的像素 |
| `wheelPrecision`     | `3`    | 滚轮增量除数     |

### 惯性阈值常量

| 常量               | 值       | 用途                |
| ------------------ | -------- | ------------------- |
| `ROTATION_EPSILON` | `0.001`  | alpha/beta 偏移量   |
| `RADIUS_EPSILON`   | `0.001`  | radius 偏移量       |
| `PANNING_EPSILON`  | `0.0001` | X/Y 平移偏移量      |

### 输入处理器

输入处理器**不会**直接修改相机属性。它们将输入累加到相机的 `inertial*` 偏移字段中，然后由 `applyInertia()` 在每帧中应用并衰减。

#### 旋转动作（主键默认）

```
camera.inertialAlphaOffset -= dx / angularSensibility
camera.inertialBetaOffset  -= dy / angularSensibility
```

#### 平移动作（次键默认）

```
camera.inertialPanningX += -dx / panningSensibility
camera.inertialPanningY +=  dy / panningSensibility
```

#### 滚轮（缩放）

```
camera.inertialRadiusOffset -= (deltaY * camera.radius) / (wheelPrecision * 1000)
```

缩放量与当前半径成正比（对数手感）。

#### 触摸捏合（缩放 — 直接生效，无惯性）

双指捏合直接修改半径：

```
on touchstart (2 fingers): pinchStartDist = distance between fingers
                            pinchStartRadius = camera.radius
on touchmove (2 fingers):  dist = distance between fingers
                            camera.radius = pinchStartRadius * (pinchStartDist / dist)
                            camera.radius = max(0.01, camera.radius)
```

#### 键盘（可选启用）

`keydown` 记录事件的 `code` 及当前修饰键状态；`keyup` 将其移除。`blur` 和清理函数会清除所有按住键和修饰键状态。识别到的映射会阻止浏览器方向键滚动页面。带有 `metaKey` 的事件不会被记录，按住 Meta 键也会抑制任何已按住的映射。Shift 不改变映射行为。Ctrl 优先级高于 Alt。

在每次 `applyInertia()` 调用开始时，每个按住的已映射按键会添加一个兼容传统行为的增量：

| 按住的映射 | 无修饰键                         | Ctrl                         | 仅 Alt（无 Ctrl）                |
| ---------- | -------------------------------- | ---------------------------- | -------------------------------- |
| left       | `inertialAlphaOffset -= 1 / 100` | `inertialPanningX -= 1 / 50` | 同无修饰键                       |
| right      | `inertialAlphaOffset += 1 / 100` | `inertialPanningX += 1 / 50` | 同无修饰键                       |
| up         | `inertialBetaOffset -= 1 / 100`  | `inertialPanningY += 1 / 50` | `inertialRadiusOffset += 1 / 25` |
| down       | `inertialBetaOffset += 1 / 100`  | `inertialPanningY -= 1 / 50` | `inertialRadiusOffset -= 1 / 25` |

配置的 `angularSensitivity`、`panningSensitivity` 和 `zoomingSensitivity` 分别替换 `100`、`50` 和 `25`。相反方向相互抵消。组合的双轴旋转方向与 Ctrl 平移方向在应用灵敏度前会先进行归一化，使斜向移动与单轴移动具有相同的幅值。Alt 缩放保持为一维。键盘输入将这些增量写入与指针和滚轮输入相同的惯性偏移量中，随后统一积分并衰减；它不会创建额外的动画循环。

### 逐帧惯性应用（`applyInertia`）

每帧通过 `scene._beforeRender` 调用：

```
invoke the opaque opt-in input hook (when installed for this attachment)

// Rotation
alpha += inertialAlphaOffset
beta  += inertialBetaOffset
beta = clamp(beta, 0.01, π - 0.01)    // prevent gimbal flip
inertialAlphaOffset *= camera.inertia
inertialBetaOffset  *= camera.inertia
if |offset| < ROTATION_EPSILON: offset = 0

// Zoom
radius -= inertialRadiusOffset
radius = max(0.01, radius)
inertialRadiusOffset *= camera.inertia
if |offset| < RADIUS_EPSILON: offset = 0

// Panning (uses camera.panningInertia, not camera.inertia), in the camera's view plane as in Babylon.js:
// X along the camera right vector, Y along the camera up vector (world up made orthogonal to the view direction).
// The camera looks at its target with world up, so both vectors flip when sin(beta) < 0. sin(beta) = 0 is placed at
// 0.0001 like the camera's eye. When |sin(beta)| < 1e-10 the eye is straight above or below the target and the camera's
// look-at falls back to the identity basis, so panning does too.
sinB  = sin(beta) == 0 ? 0.0001 : sin(beta)
if |sinB| < 1e-10:
    right = (1, 0, 0)
    up    = (0, 1, 0)
else:
    s     = sinB < 0 ? -1 : 1
    right = s * (-sin(alpha), 0, cos(alpha))
    up    = s * (-cos(alpha) * cos(beta), sinB, -sin(alpha) * cos(beta))
panScale = radius * 0.001
target += (right * inertialPanningX + up * inertialPanningY) * panScale
inertialPanningX *= camera.panningInertia
inertialPanningY *= camera.panningInertia
if |offset| < PANNING_EPSILON: offset = 0
```

### 场景集成

当向 `attachControl` 传入 `scene` 时：

- `applyInertia` 注册到 `scene._beforeRender` —— 单一 RAF 链。
- 清理函数会将该回调从 `_beforeRender` 中移除。

当省略 `scene` 时，输入仍可累加惯性偏移量，但不会创建独立的动画循环。

### 事件注册

| 事件          | 处理器          | 选项                        |
| ------------- | --------------- | --------------------------- |
| `pointerdown` | `onPointerDown` | —                           |
| `pointermove` | `onPointerMove` | —                           |
| `pointerup`   | `onPointerUp`   | —                           |
| `wheel`       | `onWheel`       | `{ passive: false }`        |
| `contextmenu` | `onContextMenu` | —（阻止右键菜单）           |
| `touchstart`  | `onTouchStart`  | `{ passive: false }`        |
| `touchmove`   | `onTouchMove`   | `{ passive: false }`        |
| `touchend`    | `onTouchEnd`    | —                           |
| `gesture*`    | `onGesture`     | `{ passive: false }`        |
| `keydown`     | `onKeyDown`     | —（可选键盘模块）           |
| `keyup`       | `onKeyUp`       | —（可选键盘模块）           |
| `blur`        | `onBlur`        | —（可选键盘模块）           |

指针捕获（`setPointerCapture`/`releasePointerCapture`）确保拖拽在移出画布后依然保持有效。

主键和次键可以通过 `AttachControlOptions.pointerMappings` 独立选择旋转或平移动作。默认值等价于历史固定映射：

```typescript
attachControl(camera, canvas, scene, {
    pointerMappings: {
        primaryButton: "rotate",
        secondaryButton: "pan",
    },
});
```

若要使主键拖拽直接平移而无需应用层编写相机数学计算：

```typescript
attachControl(camera, canvas, scene, {
    pointerMappings: { primaryButton: "pan" },
});
```

非触摸指针包括鼠标和触控笔输入。触摸指针事件会故意绕过此映射，以保证单指环绕旋转和双指捏合缩放稳定工作。滚轮缩放、外部交互守卫、指针捕获和清理均不依赖此映射。

键盘控制为可选启用：

```typescript
enableArcRotateKeyboardControls();
attachControl(camera, canvas, scene, { keyboard: true });
```

自定义按键映射与灵敏度仅作用于当前挂载实例：

```typescript
enableArcRotateKeyboardControls();
attachControl(camera, canvas, scene, {
    keyboard: {
        keys: {
            left: ["KeyA"],
            right: ["KeyD"],
            up: ["KeyW"],
            down: ["KeyS"],
        },
        angularSensitivity: 200,
        panningSensitivity: 100,
        zoomingSensitivity: 50,
    },
});
```

---

## FreeCamera 控制

### 输入绑定

| 按键                    | 动作                     |
| ----------------------- | ------------------------ |
| `W` / `ArrowUp`         | 向前移动（局部 +Z）      |
| `S` / `ArrowDown`       | 向后移动（局部 −Z）      |
| `A` / `ArrowLeft`       | 向左平移（局部 −X）      |
| `D` / `ArrowRight`      | 向右平移（局部 +X）      |
| `Space` / `PageUp`      | 向上移动（世界 +Y）      |
| `Shift` / `PageDown`    | 向下移动（世界 −Y）      |
| 鼠标拖拽（任意按键）    | 环顾四周（偏航/俯仰）    |

### 鼠标旋转

鼠标拖拽将位移累加到旋转累加器中：

```
crY += dx / camera.angularSensitivity   // yaw delta
crX += dy / camera.angularSensitivity   // pitch delta
```

### 移动速度公式

匹配 Babylon.js 与帧率无关的速度计算：

```
dt = max(deltaMs, 1)
moveSpeed = camera.speed × sqrt(dt² / 100000)
```

### 逐帧更新

每帧通过 `scene._beforeRender` 并传入 `deltaMs` 调用：

```
// 1. Accumulate keyboard input (local space)
cdZ += moveSpeed  (forward/back)
cdX += moveSpeed  (strafe)
cdY += moveSpeed  (up/down)

// 2. Apply rotation
_yaw   += crY
_pitch -= crX
_pitch = clamp(_pitch, -(π/2 - 0.01), π/2 - 0.01)

// 3. Transform local direction → world space
cosY = cos(_yaw),  sinY = sin(_yaw)
position.x += sinY × cdZ + cosY × cdX
position.y += cdY
position.z += cosY × cdZ - sinY × cdX

// 4. Recompute target from yaw/pitch
cosP = cos(_pitch)
target = (position.x + sinY×cosP, position.y + sin(_pitch), position.z + cosY×cosP)

// 5. Decay accumulators (inertia)
cd* *= camera.inertia
cr* *= camera.inertia
if |accumulator| < camera.speed × 0.001: accumulator = 0
```

### 画布焦点

如果画布没有 `tabindex` 属性，`attachFreeControl` 会设置 `canvas.tabIndex = 0` 以使其可获得键盘焦点。

### 事件注册

| 事件          | 处理器          | 选项 |
| ------------- | --------------- | ---- |
| `pointerdown` | `onPointerDown` | —    |
| `pointermove` | `onPointerMove` | —    |
| `pointerup`   | `onPointerUp`   | —    |
| `contextmenu` | `onContextMenu` | —    |
| `keydown`     | `onKeyDown`     | —    |
| `keyup`       | `onKeyUp`       | —    |

清理函数会移除全部 6 个事件监听器和 `_beforeRender` 回调。

---

## Babylon.js 等价对照表

| Babylon Lite                                                                | Babylon.js                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Camera` 接口                                                               | `BABYLON.Camera` 基类                                                      |
| `createArcRotateCamera(alpha, beta, radius, target)`                        | `new BABYLON.ArcRotateCamera("cam", alpha, beta, radius, target, scene)`   |
| `camera.alpha / beta / radius / target`                                     | 同名属性                                                                   |
| `camera.fov`（默认 0.8）                                                    | `camera.fov`（默认 0.8）                                                   |
| `camera.nearPlane` / `camera.farPlane`                                      | `camera.minZ` / `camera.maxZ`                                              |
| `camera.inertia`（默认 0.9）                                                | `camera.inertia`（默认 0.9）                                               |
| `camera.panningInertia`（默认 0.9）                                         | `camera.panningInertia`（默认 0.9）                                        |
| `camera.inertialAlphaOffset`                                                | `camera.inertialAlphaOffset`                                               |
| `camera.getViewMatrix()`                                                    | `camera.getViewMatrix()`                                                   |
| `camera.getProjectionMatrix(aspect)`                                        | `camera.getProjectionMatrix()`                                             |
| `enableOrthographicCamera(camera, bounds)`                                  | `camera.mode = Camera.ORTHOGRAPHIC_CAMERA`                                 |
| `camera.ortho.left / right / bottom / top`                                  | `camera.orthoLeft / orthoRight / orthoBottom / orthoTop`                   |
| `camera.ortho.halfHeight`（按宽高比推导宽度）                               | 无对应项 —— BJS 默认取渲染尺寸像素的一半                                   |
| 对路径 `"ortho.halfHeight"` 执行动画                                        | 对 `orthoTop` / `orthoBottom` / … 执行 `Animation`                         |
| `disableOrthographicCamera(camera)`                                         | `camera.mode = Camera.PERSPECTIVE_CAMERA`                                  |
| `attachControl(camera, canvas, scene)`                                      | `camera.attachControl(canvas, true)`                                       |
| `enableArcRotateKeyboardControls(); attachControl(..., { keyboard: true })` | `ArcRotateCameraKeyboardMoveInput`                                         |
| `angularSensibility = 1000`                                                 | `camera.inputs.attached.pointers.angularSensibilityX/Y`                    |
| `panningSensibility = 50`                                                   | `camera.inputs.attached.pointers.panningSensibility`                       |
| `wheelPrecision = 3`                                                        | `camera.inputs.attached.mousewheel.wheelPrecision`                         |
| 主键拖拽 → 旋转（默认，可配置）                                             | `ArcRotateCameraPointersInput` button 0                                    |
| 次键拖拽 → 平移（默认，可配置）                                             | `ArcRotateCameraPointersInput` button 2                                    |
| 滚轮 → 缩放半径                                                             | `ArcRotateCameraMouseWheelInput`                                           |
| 捏合 → 缩放半径（直接生效，无惯性）                                         | `ArcRotateCameraPointersInput` 多点触控捏合                                |
| Beta 限幅至 `[0.01, π-0.01]`                                                | `camera.lowerBetaLimit / upperBetaLimit`                                   |
| `createFreeCamera(position, target)`                                        | `new BABYLON.FreeCamera("cam", position, scene); camera.setTarget(target)` |
| `createBankedFreeCamera(position, target, up)`                              | 同上，外加 `camera.upVector = up`（供 `Matrix.LookAtLHToRef` 使用）        |
| `camera.speed`（默认 2.0）                                                  | `camera.speed`（默认 2.0）                                                 |
| `camera.angularSensitivity`（默认 2000）                                    | `camera.inputs.attached.mouse.angularSensibility`                          |
| `attachFreeControl(camera, canvas, scene)`                                  | `camera.attachControl(canvas)`                                             |
| WASD / 方向键                                                               | `FreeCameraKeyboardMoveInput`                                              |
| 鼠标拖拽 → 偏航/俯仰                                                        | `FreeCameraMouseInput`                                                     |
| 俯仰角限幅至 ±(π/2 − 0.01)                                                  | BJS `FreeCameraMouseInput` 俯仰角限制                                      |
| `_yaw` / `_pitch`（内部）                                                   | BJS 内部 `_cameraRotationMatrix`                                           |

## 依赖关系

- **`camera.ts` 导入**：来自 `../math/types.js` 的 `Vec3`、`Mat4`。
- **`arc-rotate.ts` 导入**：来自 `../math/types.js` 的 `Vec3`、`Mat4`；来自 `../math/vec3.js` 的 `Vec3Up`；来自 `../math/write-look-at-world-mat4-lh-into-buffer.js` 的 `writeLookAtWorldMat4LHIntoBuffer`；来自 `../scene/parentable.js` 的 `IWorldMatrixProvider`、`IParentable`；来自 `../scene/world-matrix-state.js` 的 `createWorldMatrixState`；来自 `../math/observable-vec3.js` 的 `ObservableVec3`。
- **`arc-rotate-controls.ts` 导入**：来自 `./arc-rotate.js` 的 `ArcRotateCamera`；来自 `../scene/scene.js` 的 `SceneContext`、`SceneContextInternal`。
- **`free-camera.ts` 导入**：来自 `./camera.js` 的 `Camera`；来自 `../math/types.js` 的 `Vec3`、`Mat4`；来自 `../math/vec3.js` 的 `Vec3Up`；来自 `../math/write-look-at-world-mat4-lh-into-buffer.js` 的 `writeLookAtWorldMat4LHIntoBuffer`；来自 `../scene/parentable.js` 的 `IWorldMatrixProvider`、`IParentable`；来自 `../scene/world-matrix-state.js` 的 `createWorldMatrixState`；来自 `../math/observable-vec3.js` 的 `ObservableVec3`。
- **`free-camera-controls.ts` 导入**：来自 `./free-camera.js` 的 `FreeCamera`、`FreeCameraInternal`；来自 `../scene/scene.js` 的 `SceneContext`。
- **被以下模块依赖**：`scene.ts`（创建相机）、渲染管线（读取相机矩阵）。

## 测试规范

| 测试                                           | 说明                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **ArcRotate**                                  |                                                                                          |
| `getCameraPosition at alpha=-π/2, beta=π/2`    | 相机应位于 `(target.x, target.y, target.z + radius)`                                     |
| `getCameraPosition at alpha=0, beta=π/2`       | 相机应位于 `(target.x + radius, target.y, target.z)`                                     |
| `getViewMatrix is valid LH lookAt`             | `view × position` 应给出类似 NDC 的坐标                                                  |
| `getProjectionMatrix aspect ratio`             | 验证 `m[0] = tan/aspect`、`m[5] = tan`                                                   |
| `getViewProjectionMatrix = proj × view`        | 与手动矩阵乘法对比                                                                       |
| `beta clamping`                                | 惯性应用将 beta 限幅到 `[0.01, π-0.01]`                                                  |
| `wheel zoom proportional`                      | 更大的半径 → 更大的绝对变化量                                                            |
| `pan shifts target via inertia`                | 累加的平移偏移量移动 target，radius 保持不变                                             |
| `pinch zoom`                                   | 双指触摸事件正确直接缩放 radius                                                          |
| `inertia decay`                                | 输入停止后，偏移量每帧按 `camera.inertia` 衰减                                           |
| `cleanup removes all listeners + beforeRender` | 清理后，事件和 RAF 钩子全部移除                                                          |
| `primary/secondary mappings are independent`   | 任一按键均可独立选择旋转或平移而不影响另一按键                                           |
| `custom mappings preserve touch`               | 单指触摸仍旋转，双指捏合仍缩放                                                           |
| `keyboard defaults and modifiers`              | 方向键旋转、Ctrl 平移、Alt 垂直缩放、Ctrl 优先于 Alt                                     |
| `keyboard direction normalization`             | 默认/自定义斜向移动保持单轴速度；相反方向相互抵消                                        |
| `keyboard lifecycle`                           | 按住输入每帧重复；keyup、blur 和清理会停止进一步累加                                     |
| `keyboard filtering`                           | 带 Meta 修饰键的映射被忽略；Shift 不改变映射                                             |
| `custom keyboard options`                      | 方向键代码列表与三个灵敏度除数均可独立覆盖                                               |
| `keyboard disabled by default`                 | 未请求 `keyboard` 时无键盘监听器或按住键输入                                             |
| **FreeCamera**                                 |                                                                                          |
| `initial yaw/pitch from position→target`       | 验证 atan2 计算                                                                          |
| `WASD movement in local space`                 | W 沿局部 +Z 移动，A 沿局部 −X 移动                                                       |
| `mouse drag rotates yaw/pitch`                 | 验证角灵敏度缩放                                                                         |
| `pitch clamped to ±(π/2 − 0.01)`               | 极端俯仰角值被限幅                                                                       |
| `inertia decay on accumulators`                | 移动/旋转累加器按 `camera.inertia` 衰减                                                  |
| `target updated from yaw/pitch`                | 每帧从朝向重新推导 target                                                                |
| `world-to-view matrix consistency`             | 视图矩阵 = 世界矩阵的逆矩阵                                                              |
| `cleanup removes 6 listeners + beforeRender`   | 所有处理器均已分离                                                                       |
| **Orthographic**                               |                                                                                          |
| `view volume corners → NDC`                    | 反向 Z 深度（near→1，far→0）；x/y 与深度无关                                             |
| `off-center volume`                            | 视景体中点投影到 NDC 原点                                                                |
| `aspect-derived horizontal extent`             | `halfWidth = halfHeight * aspectRatio`                                                   |
| `revert to perspective`                        | 共享缓存中不残留 `m[12] / m[13] / m[15]`                                                 |
| `re-enable re-arms the projection cache`       | 修改 `halfHeight` 无需移动相机即可生效                                                   |
| `live bound mutation`                          | `ortho.halfHeight = x` 使 proj 与 viewProj 缓存失效                                      |
| `steady-state scene UBO re-upload`             | 边界变更会重新打开真实的 `_writePassSceneUBO` 门控                                       |
| `runtime enable/disable re-upload`             | 首帧之后切换正交状态同样会重新打开门控                                                   |
| `projection change is not camera motion`       | `_cameraChangeKey` 变化；`worldMatrixVersion`/`worldMatrix` 不变                         |
| `no-op assignment does not re-upload`          | 向边界写入当前相同值会跳过 GPU 写入                                                      |
| `halfHeight is number-only`                    | 各平面接受 `null`；`halfHeight` 不能变为退化值                                           |
| `null plane toggles derived/off-center`        | 先赋数值再赋 `null` 可恢复推导范围                                                       |
| `bounds are own enumerable properties`         | 诸如 `"ortho.halfHeight"` 的动画路径可正常解析并写入                                     |
| **投影参数**                                   |                                                                                          |
| `fov write rebuilds the projection`            | 相机静止时修改 fov，`m[5] = 1/tan(fov/2)` 随之更新                                       |
| `near/far write rebuilds the projection`       | 反向 Z 深度项 `m[10]` / `m[14]` 随之更新                                                 |
| `propagates through the view-projection cache` | `getViewProjectionMatrix` 也不会过期                                                     |
| `steady-state scene UBO re-upload`             | 在透视与正交模式下，fov / near / far 中任一项变化均会重新打开真实的 `_writePassSceneUBO` 门控 |
| `no-op rewrite does not re-upload`             | 向参数重复写入当前值会跳过 GPU 写入                                                      |

## 文件清单

| 文件                                         | 规模     | 用途                                               |
| -------------------------------------------- | -------- | -------------------------------------------------- |
| `src/camera/camera.ts`                       | ~15 行   | 共享 `Camera` 接口契约                             |
| `src/camera/arc-rotate.ts`                   | ~198 行  | ArcRotateCamera 数据 + 世界矩阵 + 脏追踪           |
| `src/camera/arc-rotate-controls.ts`          | ~400 行  | 带惯性模型的 ArcRotate 指针/滚轮/触摸输入          |
| `src/camera/arc-rotate-keyboard-controls.ts` | ~160 行  | 可选的 ArcRotate 键盘映射、监听器与输入接缝        |
| `src/camera/free-camera.ts`                  | ~161 行  | FreeCamera 数据 + 世界矩阵 + 脏追踪                |
| `src/camera/banked-free-camera.ts`           | ~44 行   | 带显式可变上方向向量的可选 FreeCamera              |
| `src/camera/free-camera-controls.ts`         | ~184 行  | 带惯性的 FreeCamera 键盘/鼠标输入                  |
| `src/camera/orthographic.ts`                 | ~75 行   | 可选正交投影（安装接缝）                           |
