# 模块：Animation

> 包路径：`packages/babylon-lite/src/animation/`

## 目的

为 glTF 动画以及用户编写的属性动画提供零内存分配的关键帧动画系统。支持骨骼关节变换、变形目标权重、`KHR_animation_pointer` 通道，以及绑定到对象属性路径（如 `position.x`、`position`、`rotationQuaternion` 或 `scaling`）的手动轨道。每个求值片段都封装在 `AnimationGroup` 中，既可由独立的 `AnimationManager` 驱动，也可由场景渲染循环或显式确定性更新驱动。求值器使用预分配的暂存缓冲区执行 LINEAR、STEP 和 CUBICSPLINE 插值，无任何逐帧堆内存分配。

## 公共 API 接口

### 常量

```typescript
// Interpolation modes (numeric for hot-path comparison)
export const INTERP_LINEAR = 0;
export const INTERP_STEP = 1;
export const INTERP_CUBICSPLINE = 2;

// Target paths (numeric)
export const PATH_TRANSLATION = 0;
export const PATH_ROTATION = 1;
export const PATH_SCALE = 2;
export const PATH_WEIGHTS = 3;
```

### 类型

```typescript
export type InterpMode = 0 | 1 | 2;
export type TargetPath = 0 | 1 | 2 | 3;

export interface AnimationSampler {
    readonly input: Float32Array; // keyframe timestamps (seconds, monotonically increasing)
    readonly output: Float32Array; // packed values; CUBICSPLINE: [inTangent, value, outTangent] per key
    readonly interpolation: InterpMode;
}

export interface AnimationChannel {
    readonly samplerIdx: number;
    readonly nodeIdx: number;
    readonly path: TargetPath;
}

export interface AnimationClip {
    readonly name: string;
    readonly channels: readonly AnimationChannel[];
    readonly samplers: readonly AnimationSampler[];
    readonly duration: number; // max of all sampler input times (seconds)
    readonly frameRate?: number; // defaults to 60 for glTF clips
}

export interface NodeRest {
    readonly parentIdx: number; // -1 for root nodes
    tx: number;
    ty: number;
    tz: number; // translation
    rx: number;
    ry: number;
    rz: number;
    rw: number; // rotation quaternion
    sx: number;
    sy: number;
    sz: number; // scale
}

export interface SkeletonBinding {
    readonly jointNodes: readonly number[];
    readonly inverseBindMatrices: Float32Array;
    readonly invMeshWorld: Mat4;
    readonly boneTexture: GPUTexture;
    readonly boneCount: number;
}

export interface MorphBinding {
    readonly nodeIdx: number;
    readonly weightsBuffer: GPUBuffer;
    readonly targetCount: number; // max 4 supported
}

export interface GltfAnimationData {
    readonly clips: readonly AnimationClip[];
    readonly nodes: readonly NodeRest[];
    readonly skeletons: readonly SkeletonBinding[];
    readonly morphBindings: readonly MorphBinding[];
}

export type AnimationKeyframeValue = number | readonly number[];

export interface AnimationKeyframe {
    /** Timestamp in seconds. Mutually exclusive with `frame`. */
    readonly time?: number;
    /** Frame index converted with `frameRate`. Mutually exclusive with `time`. */
    readonly frame?: number;
    readonly value: AnimationKeyframeValue;
}

export type PropertyAnimationInterpolation = "linear" | "step";

export interface PropertyAnimationTrackOptions {
    readonly path: string;
    readonly keys: readonly AnimationKeyframe[];
    readonly frameRate?: number;
    readonly interpolation?: PropertyAnimationInterpolation;
    /** Forces quaternion-aware interpolation for vec4 tracks. Inferred for `rotationQuaternion` paths. */
    readonly quaternion?: boolean;
    /**
     * Optional segment-local progress transform. Receives the normalized progress
     * between the selected key pair and returns the progress used for interpolation.
     */
    readonly easing?: AnimationEasing;
}

export interface PropertyAnimationClipOptions {
    readonly frameRate?: number;
}

export interface PropertyAnimationTrack {
    readonly path: string;
    readonly sampler: AnimationSampler;
    readonly stride: number;
    readonly quaternion: boolean;
    readonly easing?: AnimationEasing;
}

export interface PropertyAnimationClip {
    readonly name: string;
    readonly tracks: readonly PropertyAnimationTrack[];
    readonly duration: number;
    readonly frameRate: number;
}

export interface AnimationManagerOptions {
    /** Optional engine enables glTF skeleton/morph GPU uploads when manager is not scene-hosted. */
    readonly engine?: EngineContext;
    /** Fixed step in ms. `0` means caller-supplied / rAF delta. */
    readonly fixedDeltaMs?: number;
    /** Called after each autonomous tick, e.g. to render a custom view. */
    readonly onUpdate?: (deltaMs: number) => void;
}

export interface AnimationTask {
    readonly _entityType: "animation-task";
    active: boolean;
}

export type AnimationTaskUpdate = (manager: AnimationManager, deltaMs: number, task: AnimationTask) => void;
export type AnimationTaskCategoryHandler = (manager: AnimationManager, deltaMs: number) => boolean;

export interface AnimationTaskOptions {
    readonly category?: string;
    readonly dispose?: (manager: AnimationManager) => void;
}

export interface AnimationManager {
    animations: AnimationTask[];
    fixedDeltaMs: number;
    running: boolean;
    readonly engine?: EngineContext;
    readonly onUpdate?: (deltaMs: number) => void;
    _rafId: number;
    _lastTime: number;
}

export interface SkeletonData {
    readonly boneTexture: GPUTexture;
    readonly boneCount: number;
    readonly jointsBuffer: GPUBuffer;
    readonly weightsBuffer: GPUBuffer;
    readonly joints1Buffer: GPUBuffer | null; // 8-bone skinning
    readonly weights1Buffer: GPUBuffer | null;
}

export interface MorphTargetData {
    readonly texture: GPUTexture;
    readonly count: number;
    readonly weightsBuffer: GPUBuffer;
}
```

### AnimationGroup 接口

```typescript
export interface AnimationGroup {
    readonly name: string;
    readonly duration: number; // seconds
    readonly frameRate: number; // used by goToFrame()
    isPlaying: boolean;
    currentTime: number; // seconds
    readonly targetedAnimations: readonly TargetedAnimation[];
    speedRatio: number; // default 1
    loopAnimation: boolean; // default true
    weight: number; // default 1
    mask?: AnimationGroupMask; // optional include/exclude target-name filter
    _stopped: boolean;
    readonly _ctrl?: AnimationController;
}

export interface TargetedAnimation {
    readonly target?: object;
    readonly targetName?: string;
    readonly nodeIndex?: number;
    readonly path: string;
}
```

### AnimationGroupMask

通过 `group.mask` 挂载到动画组的可选包含/排除过滤器。设置后，仅遮罩**保留**的目标会执行动画；被遮罩排除的目标保持在它们的绑定/静息姿态（与 Babylon.js 暂停这些目标的行为一致）。目标按 glTF 节点 / 骨骼**名称**匹配（精确、区分大小写）。完全按需启用：首次调用 `createAnimationGroupMask` 才会激活控制器的遮罩路径，因此从未创建遮罩的动画场景无需承担任何包体积开销。

```typescript
export enum AnimationGroupMaskMode {
    Include = 0, // only the listed names animate
    Exclude = 1, // all but the listed names animate
}

export interface AnimationGroupMask {
    mode: AnimationGroupMaskMode;
    names: string[]; // target (node/bone) names
    disabled: boolean; // when true the mask is ignored (everything animates)
}

export function createAnimationGroupMask(names?: string[], mode?: AnimationGroupMaskMode): AnimationGroupMask;
export function animationGroupMaskRetainsTarget(mask: AnimationGroupMask, name: string): boolean;
```

### 函数

```typescript
export function createAnimationGroups(animData: GltfAnimationData): AnimationGroup[];
export function goToFrame(group: AnimationGroup, frame: number, engine?: EngineContext): void;
export function createAnimationGroupMask(names?: string[], mode?: AnimationGroupMaskMode): AnimationGroupMask;
export function animationGroupMaskRetainsTarget(mask: AnimationGroupMask, name: string): boolean;
export function createAnimationManager(options?: AnimationManagerOptions): AnimationManager;
export function createAnimationTask(update: AnimationTaskUpdate, options?: AnimationTaskOptions): AnimationTask;
export function addAnimationTask(manager: AnimationManager, task: AnimationTask): void;
export function removeAnimationTask(manager: AnimationManager, task: AnimationTask): void;
export function setAnimationTaskCategoryHandler(manager: AnimationManager, category: string, handler: AnimationTaskCategoryHandler): void;
export function addAnimationGroup(manager: AnimationManager, group: AnimationGroup): void;
export function addAnimationGroups(manager: AnimationManager, groups: readonly AnimationGroup[]): void;
export function removeAnimationGroup(manager: AnimationManager, group: AnimationGroup): void;
export function getAnimationGroups(manager: AnimationManager): readonly AnimationGroup[];
export function updateAnimationManager(manager: AnimationManager, deltaMs: number): void;
export function startAnimationManager(manager: AnimationManager): void;
export function stopAnimationManager(manager: AnimationManager): void;
export function setAnimationWeight(group: AnimationGroup, weight: number): void;
export function enablePropertyAnimationBlending(manager: AnimationManager): void;
export function fadeAnimationWeight(manager: AnimationManager, group: AnimationGroup, options: FadeAnimationWeightOptions): void;
export function crossFadeAnimationGroups(manager: AnimationManager, fromGroup: AnimationGroup, toGroup: AnimationGroup, options: CrossFadeAnimationGroupsOptions): void;
export function enableAnimationBlending(manager: AnimationManager): void;
export function setAnimationAdditive(group: AnimationGroup, options?: AnimationAdditiveOptions): void;

export function createPropertyAnimationClip(name: string, tracks: readonly PropertyAnimationTrackOptions[], options?: PropertyAnimationClipOptions): PropertyAnimationClip;

export function createPropertyAnimationGroup(
    manager: AnimationManager,
    target: object,
    clip: PropertyAnimationClip,
    options?: {
        readonly loop?: boolean;
        readonly speedRatio?: number;
        readonly fromFrame?: number;
        readonly toFrame?: number;
        readonly fromTime?: number;
        readonly toTime?: number;
    }
): AnimationGroup;

export function evaluateSampler(
    sampler: AnimationSampler,
    t: number,
    stride: number, // 3 for vec3, 4 for quat
    isQuat: boolean, // true → uses slerp for LINEAR, normalizes for CUBICSPLINE
    dst: Float32Array,
    dstOffset: number
): void;
```

## 内部架构

### 数据布局

所有动画数据均使用扁平类型化数组以获得对 GPU 友好的内存布局：

- **NodeRest**：每个节点 10 个字段（tx,ty,tz, rx,ry,rz,rw, sx,sy,sz），存储在 `GltfAnimationData.nodes[]` 中
- **AnimationSampler.output**：连续打包存储：
    - LINEAR/STEP：`[value0, value1, ...]` —— 每个关键帧 `stride` 个浮点数
    - CUBICSPLINE：`[inTangent0, value0, outTangent0, inTangent1, value1, outTangent1, ...]` —— 每个关键帧 `stride * 3` 个浮点数
- **属性动画时间戳**使用现有的 `AnimationSampler.input` `Float32Array`。仅属性求值路径会在查找关键帧与插值之前使用 `Math.fround()` 规范化回放时间，使调用方编写的帧号与时间边界在同一精度域内进行比较。通用/glTF 采样器求值保持不变。

### 关键帧搜索

`evaluateSampler()` 在搜索前将 `t <= input[0]` 限幅为首帧，将 `t >= input[last]` 限幅为末帧。对于中间采样点，`findKeyframe(input, t)` 执行二分搜索以找到满足 `input[i] <= t < input[i+1]` 的索引 `i`。

### 属性缓动（Property Easing）

属性动画缓动是每条 `PropertyAnimationTrackOptions` 上由调用方提供的函数，而非内建曲线注册表，也不属于 glTF 使用的通用 `AnimationSampler` 形状。该回调仅变换所选属性动画片段内的归一化进度：

```typescript
const gradient = (time - startTime) / (endTime - startTime);
const interpolationGradient = easing ? easing(gradient) : gradient;
```

求值器在 STEP 处理之后、标量/向量线性插值（lerp）或四元数球面插值（slerp）之前应用此变换。STEP 片段绝不调用缓动回调。位于或超出首末关键帧的采样会直接返回对应关键帧值而不调用缓动回调，因此自定义回调无法移动片段端点。返回的进度不会被限幅：超调（overshoot）曲线可以外推标量/向量值，或令四元数 slerp 超越片段端点继续插值。

属性四元数插值遵循 Babylon.js `Quaternion.SlerpToRef` 的近平行（near-parallel）处理行为。通用 glTF 采样器保留其原有的 glTF 四元数插值路径。

回调保留在编译后的属性轨道上，而非烘焙到采样数据中。因此兼容适配器可以闭包捕获可变 API 状态，并在每次内部采样时查询当前指派的缓动函数。在回放期间修改或清除 `Animation.setEasingFunction()` 无需重新编译原生片段即可立即生效。

该接缝仅限属性动画使用。glTF 的 LINEAR、STEP 和 CUBICSPLINE 采样器继续原样走 `evaluateSampler()`，因此调用方编写的缓动不会悄无声息地改变导入资产的语义。两套求值器共享关键帧搜索与四元数数学，而属性求值器抽取了其自身的打包值拷贝与 LINEAR 插值路径。通用求值器刻意保持其热路径内联，使仅含 glTF 的打包产物字节完全不变。属性轨道不能产生 CUBICSPLINE 采样器，因此 Hermite 求值仅保留在通用 glTF 路径中，而不会在属性求值器中重复。

### 原生缓动曲线

Lite 导出一组纯 ease-in 函数，与 compat 层使用的曲线数学完全一致：

```typescript
circleEase(gradient);
quadraticEase(gradient);
cubicEase(gradient);
quarticEase(gradient);
quinticEase(gradient);
sineEase(gradient);
powerEase(gradient, power);
exponentialEase(gradient, exponent);
backEase(gradient, amplitude);
elasticEase(gradient, oscillations, springiness);
bounceEase(gradient, bounces, bounciness);
bezierCurveEase(gradient, x1, y1, x2, y2);
```

固定曲线可直接作为 `PropertyAnimationTrackOptions.easing` 传入。参数化曲线还提供 `createPowerEase`、`createExponentialEase`、`createBackEase`、`createElasticEase`、`createBounceEase` 和 `createBezierCurveEase`，它们捕获参数并返回一个 `AnimationEasing` 回调。这些均为命名独立导出，而非注册表或类继承层次，因此导入一条曲线不会保留未使用的曲线。调用工厂函数是唯一会产生内存分配的操作。

这些函数暴露原始的 ease-in 曲线。Babylon.js 的缓动模式（ease mode）仍属于 compat 门面层的职责：`EasingFunction.ease()` 对 ease-out 和 ease-in-out 重新映射输入/输出，然后将原始曲线计算委托给 Lite。

### Compat 逐键缓动

原生属性轨道保留其轨道级缓动契约。compat 关键帧模型额外接受 Babylon.js 风格的逐键缓动：

```typescript
interface IAnimationKey {
    frame: number;
    value: AnimationValue;
    interpolation?: number;
    easingFunction?: IEasingFunction;
}
```

对于每个非 STEP 片段 `[a, b)`，`Animation.evaluate()` 选取 `a.easingFunction ?? animation.getEasingFunction()`，并在插值前将其 `ease()` 方法应用于归一化进度。若未提供回调，进度保持线性。关键帧缓动覆盖动画默认缓动；下一个关键帧的回调仅作用于它起始的那一段。保留回调的接收者（`this`）、未限幅的超调行为以及当前的标量/向量/四元数插值。STEP 片段以及限幅后的首/末端点绝不调用缓动回调。

带有外发非 STEP 关键帧回调的直接或挂载轨道会使用现有的 compat 求值器，并附带显式的回退原因。独立的受支持轨道仍委托给 Lite。末关键帧上的回调以及 STEP 片段上的回调不会被使用，也不会触发回退。结构化动画组使用同一 `evaluate()` 路径。求值器所有权在回放开始时选定；向此前按原生路径运行的轨道添加关键帧回调需要重新启动回放。原生属性轨道编译与通用 glTF `AnimationSampler` 数据均无任何改动。

### 暂存缓冲区：`_quat`

模块级的 `[0,0,0,1]` 数组被复用于四元数 slerp 输出，以避免逐次调用产生堆分配。

### 帧时序模型

- `AnimationGroup.currentTime` 以**秒**为单位存储时间
- `goToFrame(frame)` 使用组的 `frameRate` 将帧号转换为秒，当存在显式单次求值器时立即求值姿态，然后暂停
- `tickAnimation(group, deltaMs, engine?)` 推进 `group.currentTime += (deltaMs / 1000) * speedRatio`，并仅在需要求值/上传时同步内部控制器
- 暂停的属性动画组在常规管理器 tick 期间不会求值或重写目标属性
- 持续时间以秒为单位（所有采样器输入时间戳的最大值）
- 循环播放通过取模回绕在有效范围内：`time = from + ((time - from) % (to - from))`
- 非循环属性动画组精确应用一次最终姿态，随后停止，以免已完成的动画组在后续管理器 tick 中覆盖之后的动画
- glTF 动画组默认为 60fps；属性动画组继承 `PropertyAnimationClip.frameRate`
- Babylon 风格的帧范围会在创建时使用片段的 `frameRate` 一次性转换

### AnimationManager 生命周期

`AnimationManager` 是通用动画任务的独立所有者。它不依赖场景，可通过三种方式驱动：

```typescript
const manager = createAnimationManager();
startAnimationManager(manager); // autonomous requestAnimationFrame loop
updateAnimationManager(manager, 16.667); // caller-owned loop
goToFrame(group, 20); // deterministic seek + pose evaluation
```

场景仍可通过 `scene.animationGroups` 拥有已加载的动画组。非场景代码可直接创建独立管理器并注册任意可动画适配器。

动画组通过 `animation-group-task.ts` 注册：`addAnimationGroup()` 将组所有权存储在通用管理器之外，随后添加一个调用 `tickAnimation(group, deltaMs, manager.engine)` 的内部任务。其他功能模块可以使用 `createAnimationTask()` / `addAnimationTask()` 注册各自的适配器，而无需让 `animation-manager.ts` 导入这些功能模块。

加权动画混合器仍是特定于动画组的可选扩展。它们为 `animation-group` 任务类别安装一个处理器；当该处理器在某一 tick 混合并推进动画组任务时，管理器仅跳过该类别并继续更新不相关的任务，例如精灵帧动画任务。

自主 `requestAnimationFrame` 生命周期现直接位于 `AnimationManager` 中。管理器拥有 `running`、`_rafId`、`_lastTime`、固定步长步进、`onUpdate`、任务分发以及启动/停止调度。

### 使用示例

手动属性动画，对应 Babylon.js `beginDirectAnimation(target, [animation], from, to, loop)`：

```typescript
const manager = createAnimationManager();
const clip = createPropertyAnimationClip("xSlide", [
    {
        path: "position.x",
        frameRate: 10,
        keys: [
            { frame: 0, value: 2 },
            { frame: 10, value: -2 },
            { frame: 20, value: 2 },
        ],
    },
]);
const group = createPropertyAnimationGroup(manager, box, clip, { fromFrame: 0, toFrame: 20, loop: true });
startAnimationManager(manager);
```

无场景的自主动画：

```typescript
const target = { position: { x: -2 } };
const manager = createAnimationManager({ onUpdate: () => draw(target.position.x) });
const group = createPropertyAnimationGroup(manager, target, clip);
startAnimationManager(manager);
```

统一的 glTF + 手动动画所有权：

```typescript
const shark = await loadGltf(engine, "https://models.babylonjs.com/shark.glb");
for (const entity of shark.entities) {
    addToScene(scene, entity);
}

const manager = createAnimationManager({ engine });
addAnimationGroups(manager, shark.animationGroups ?? []);
createPropertyAnimationGroup(manager, camera, cameraClip, { loop: true });
onBeforeRender(scene, (deltaMs) => updateAnimationManager(manager, deltaMs));
```

加权手动动画与确定性交叉淡入淡出：

```typescript
const walk = createPropertyAnimationGroup(manager, box, walkClip);
const run = createPropertyAnimationGroup(manager, box, runClip);

enablePropertyAnimationBlending(manager);
setAnimationWeight(walk, 1);
setAnimationWeight(run, 0);
crossFadeAnimationGroups(manager, walk, run, { durationMs: 300 });
```

加权 glTF 骨骼混合：

```typescript
const xbot = await loadGltf(engine, "https://playground.babylonjs.com/scenes/Xbot.glb");
for (const entity of xbot.entities) {
    addToScene(scene, entity);
}

const manager = createAnimationManager({ engine });
addAnimationGroups(manager, xbot.animationGroups ?? []);

for (const group of xbot.animationGroups ?? []) {
    setAnimationWeight(group, 0);
}
setAnimationWeight(
    xbot.animationGroups!.find((group) => group.name === "walk")!,
    0.5
);
setAnimationWeight(
    xbot.animationGroups!.find((group) => group.name === "run")!,
    0.5
);
enableAnimationBlending(manager);
onBeforeRender(scene, (deltaMs) => updateAnimationManager(manager, deltaMs));
```

在覆盖片段之上叠加姿态/循环层：

```typescript
setAnimationWeight(walk, 1);

setAnimationAdditive(headShake, { referenceFrame: 0 });
setAnimationWeight(headShake, 0.6);

setAnimationAdditive(sadPose, { referenceFrame: 0 });
sadPose.currentTime = 2 / sadPose.frameRate;
pauseAnimation(sadPose);
setAnimationWeight(sadPose, 0.35);

enableAnimationBlending(manager);
```

遮罩骨骼的一部分（仅保留的目标执行动画；其余保持绑定姿态）：

```typescript
const walk = xbot.animationGroups!.find((group) => group.name === "walk")!;

// Exclude the legs → the hips, spine, and arms walk while the legs stay at bind pose.
walk.mask = createAnimationGroupMask(
    ["mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot", "mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot"],
    AnimationGroupMaskMode.Exclude
);
playAnimation(walk);
// Include mode instead lists the only targets that should animate.
```

### AnimationGroup 创建

`createAnimationGroups()` 为每个 `AnimationClip` 创建一个 `AnimationGroup`。每个组包装一个携带该单片段动画数据切片的 `AnimationController`（来自 `skeleton-updater.ts`）。直接控制器仅上传包含被该片段直接驱动的关节、或位于被驱动祖先节点之下的关节的骨骼；否则同一资产中独立播放的不同片段会相互将对方的骨架重置回静息姿态。所有组默认自动播放（与 BJS 行为一致）。

手动属性片段与 glTF 动画共享打包关键帧表示，但它们不伪装成 glTF `AnimationChannel`。`createPropertyAnimationClip()` 存储可复用的未解析属性轨道（包括可选的缓动回调）。`createPropertyAnimationGroup()` 针对目标校验每条轨道、构建紧凑的属性运行时轨道（`sampler`、`stride`、`quaternion`、`easing`、`writer`、`mixTarget`、`mixProperty`），并将其包装在 `AnimationGroup` 中。`mixTarget` 从根对象和路径解析当前的属性所有者，使加权桶标识和写入操作能够跟随被替换的中间对象，同时保留解析到同一所有者的别名。加权桶占用当前帧的活跃前缀：陈旧的所有者引用会被覆写，匹配元数的值缓冲区会被回收复用，且保留的桶计数会截断为当前帧的绑定数量。属性热路径使用仅限属性的带缓动采样器加直接属性写入器；glTF 求值器保持不变。

### 属性绑定

手动属性路径在创建动画组时进行校验。其叶子所有者/属性对在每次写入前都会重新解析，从而在回放期间替换中间对象时（例如在动画 `position.x` 期间赋入新的 `position`），后续写入能重定向到新对象：

- 标量路径（`position.x`、`alpha`、`visible`）直接写入解析后的属性；
- 向量/四元数路径（`position`、`scaling`、`rotationQuaternion`）在目标对象暴露 setter 方法时调用 `.set(...)`；
- 向量/四元数写入器缓存当前属性对象但在每次写入时比对其对象标识，仅当应用代码在回放期间替换了该对象时才重建分量/setter 写入器；
- 无效路径会在 `createPropertyAnimationGroup()` 期间立即抛出异常，拼写错误绝不会静默失败。

绑定是特定于目标对象的；`PropertyAnimationClip` 可复用，而生成的属性运行时轨道归返回的 `AnimationGroup` 所有。

### 手动权重混合

手动属性权重为可选功能，位于默认直接求值器之外。调用 `enablePropertyAnimationBlending(manager)` 会为共享同一目标与属性路径的手动属性轨道安装一个管理器侧混合器。`setAnimationWeight()` 仅修改组权重，因此纯 glTF 场景不会加载手动属性混合器。混合器推进一次组时间，使用 `evaluatePropertySampler()` 采样每个贡献片段，然后为每个属性写入一个最终加权值，以免多个组退化为“最后写入胜出”行为。

该第一层有意采用 Babylon 风格的加权和：`final = sum(group.weight * sampledValue)`（针对指向同一属性的各个组）。混合器不对总权重做归一化，也不向静息姿态混合。`crossFadeAnimationGroups()` 基于同样的权重，在管理器内部调度确定性的基于持续时间的淡入淡出任务。

每个贡献的属性轨道在应用其组权重之前先完成缓动与采样。轨道缓动绝不改变组权重或交叉淡入淡出时序。

### glTF 骨骼权重混合

加权 glTF 骨骼混合置于通用的 `enableAnimationBlending(manager)` 可选开关之后，使仅用手动动画或直接 glTF 回放的场景无需加载骨骼混合器。启用后，共享同一解析后 glTF 节点数组的多个组会求值为单个混合 TRS 姿态，每个受影响的骨骼在每次更新中仅上传一次骨骼纹理。

默认混合语义匹配 Babylon.js 权重：平移和缩放使用加权和，旋转使用带半球修正与最终归一化的加权四元数累加，且不对权重进行归一化。当前的 glTF 混合器覆盖骨骼 TRS 通道；变形目标混合计划作为后续混合器阶段实现。

叠加动画组通过 `setAnimationAdditive(group, { referenceFrame })` 标记。混合器先求值覆盖/基础组，再在单次骨骼上传前按管理器顺序应用叠加增量。平移与缩放按权重叠加 `sample - reference`；旋转则计算 `reference^-1 * sample`，将该增量乘到基础旋转上，再按叠加权重从基础旋转 slerp 到应用增量后的旋转。

## 管线配置

不适用 —— Animation 是 CPU 侧系统。GPU 交互仅限于：

- `device.queue.writeTexture()` 用于骨骼矩阵上传（通过 `skeleton-updater.ts`）
- `device.queue.writeBuffer()` 用于变形权重上传

## 着色器逻辑

不适用 —— 本模块不包含着色器。蒙皮 WGSL 位于 `shader/fragments/skeleton-fragment.ts`。

## 状态机 / 生命周期

```
┌─────────┐  play()   ┌─────────┐  pause()  ┌────────┐
│ STOPPED │ ────────► │ PLAYING │ ────────► │ PAUSED │
│ (t=0)   │ ◄──────── │         │ ◄──────── │        │
└─────────┘  stop()   └─────────┘  play()   └────────┘
                            │
                            │ tickAnimation(group, deltaMs, engine)
                            ▼
                      advance time, wrap/clamp,
                      evaluate channels,
                      upload bone matrices + morph weights
```

- **STOPPED**：`group.isPlaying = false`，`group.currentTime = 0`，`group._stopped = true`。`tickAnimation()` 立即返回。
- **PLAYING**：`group.isPlaying = true`。每次 `tickAnimation()` 推进时间、求值采样器并上传 GPU 数据。
- **PAUSED**：`group.isPlaying = false`。`tickAnimation()` 仍会求值（确保姿态最新），但不推进时间。
- **goToFrame(f)**：设置 `group.currentTime = f / group.frameRate`，对于手动属性片段（或在提供了引擎时对于引擎支持的片段）立即求值姿态，然后暂停。属性片段将跳转限幅到已编译的关键帧时间域，而非活跃播放范围；每个采样器仍限幅到各自的首/末关键帧。
- **被移除的带动画网格**：`disposeMeshGpu()` 在销毁 GPU 资源前将最后所有者的 `SkeletonData` 或 `MorphTargetData` 标记为已销毁。动画组可能比其网格存活更久，因此所有控制器、姿态以及加权混合器上传路径都会跳过已销毁的运行时资源。直接的骨骼/变形更新 API 则显式拒绝已销毁的目标。

## Babylon.js 等价对照表

| Babylon.js API                                                               | Babylon Lite                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `new Animation(name, "position.x", frameRate, FLOAT, CYCLE)`                 | `createPropertyAnimationClip(name, [{ path: "position.x", frameRate, keys }])`                |
| `animation.setKeys(keys)`                                                    | 传入 `createPropertyAnimationClip()` 的 keys                                                  |
| `animation.setEasingFunction(easing)`                                        | 轨道选项 `easing: (gradient) => easing.ease(gradient)`                                        |
| `scene.beginDirectAnimation(target, [anim], from, to, loop)`                 | `createPropertyAnimationGroup(manager, target, clip, { fromFrame: from, toFrame: to, loop })` |
| `AnimationGroup`                                                             | `AnimationGroup` 接口                                                                         |
| `AnimationGroup.play()`                                                      | `playAnimation(group)`                                                                        |
| `AnimationGroup.pause()`                                                     | `pauseAnimation(group)`                                                                       |
| `AnimationGroup.stop()`                                                      | `stopAnimation(group)`                                                                        |
| `AnimationGroup.goToFrame(f)`                                                | `goToFrame(group, f)`（使用 `group.frameRate`）                                               |
| `AnimationGroup.speedRatio`                                                  | `group.speedRatio`                                                                            |
| `AnimationGroup.loopAnimation`                                               | `group.loopAnimation`                                                                         |
| `AnimationGroup.weight` / `setWeightForAllAnimatables()`                     | `setAnimationWeight(group, weight)`；对于加权 glTF 骨骼片段需调用 `enableAnimationBlending(manager)` |
| `AnimationGroup.MakeAnimationAdditive(group, frame)`                         | `setAnimationAdditive(group, { referenceFrame: frame })`                                      |
| `AnimationGroup.mask = new AnimationGroupMask(names, mode)`                  | `group.mask = createAnimationGroupMask(names, mode)`                                          |
| `AnimationGroupMask` / `AnimationGroupMaskMode` / `mask.retainsTarget(name)` | `AnimationGroupMask` / `AnimationGroupMaskMode` / `animationGroupMaskRetainsTarget(mask, name)` |
| 手动属性加权混合                                                             | `enablePropertyAnimationBlending(manager)` + `setAnimationWeight(group, weight)`              |
| 手动权重渐变 / 混合速度                                                      | `fadeAnimationWeight(manager, group, { to, durationMs })`                                     |
| 手动交叉淡入淡出                                                             | `crossFadeAnimationGroups(manager, from, to, { durationMs })`                                 |
| `scene.animationGroups`                                                      | `scene.animationGroups`                                                                       |
| `Animation.ANIMATIONTYPE_QUATERNION`                                         | `PATH_ROTATION = 1`                                                                           |
| `Animation.ANIMATIONTYPE_VECTOR3`                                            | `PATH_TRANSLATION = 0`，`PATH_SCALE = 2`                                                      |

### Compat 委托边界

`@babylonjs/lite-compat` 将每个原生属性系统能够保留其语义的 Babylon.js 风格 `Animation` 转换为原生属性片段。受支持的路径要求：

- 每个动画至少有一个关键帧；
- 共享同一个正的帧率；
- 有限标量值、固定大小数组或 Babylon.js 风格的 Vector2、Vector3 或 Quaternion 值；
- 其现有叶子可由原生标量或 `.set(...)` 向量/四元数绑定写入的目标路径；
- 整条轨道采用单一插值模式（全 LINEAR 或全 STEP）；
- 循环（cycle）模式、前向非空播放范围，以及有限非负的速率比。

Compat 会将一次直接动画调用划分为原生子集和显式回退子集。即使同一调用中的另一条独立轨道不受支持，受支持的轨道仍保持原生执行。其点分属性路径存在重叠的轨道（例如 `position` 和 `position.x`）会留在同一个求值器上，以确保写入顺序不会改变。返回的组合 `Animatable` 协调跳转、暂停、重启、停止、速度、循环和完成回调，而 Babylon Lite 负责所有委托轨道的帧推进、片段选择、缓动、插值和属性写入。

Compat 门面拥有原生管理器成员资格：被委托的组仅在活跃播放时挂载，在暂停、停止或自然完成时分离，并在重启时重新挂载。跳转（seek）只求值一次，而不重新加入逐帧管理器。每个组保留其首次挂载的顺序令牌，因此重新挂载一个更早暂停的组会恢复其相对于更新组的优先级，而非追加到它们之后。场景销毁会清除 compat 所属的管理器。完成状态由原生组的停止状态与回退子集的逐轨道状态共同推导，而非从浮点时间重建端点。

Compat 保留了公开的六参数 `Animatable(target, animations, from, to, loop, speedRatio)` 构造函数。原生管理器/组所有权仅通过内部工厂状态传入，因此现有的 TypeScript 与 JavaScript 调用方无需改动参数位置。

回退所有权同时保留根目标/点分路径以及解析后的叶子对象/属性对。因此根相对的祖先/后代路径（如 `position` 与 `position.x`）在跨多次独立动画调用时仍会留在同一求值器上，而当不同目标对象别名引用同一嵌套属性、或更早停止的回退动画随后重启时，解析后的叶子标识也能保持写入顺序。

原生缓动适配器在采样时读取 `Animation.getEasingFunction()`，因此替换或清除动画级缓动保持实时生效。编译后的片段仍是 `beginDirectAnimation()` 调用时刻关键帧的快照。这在后续调用 `setKeys()` 替换关键帧数组时与 Babylon.js 表现一致（现有运行时动画保留其原关键帧数组），但与 Babylon.js 不同的是，它不会观测对已编译进紧凑原生缓冲区中的关键帧对象所做的就地修改。

Compat 暂时为其显式不支持的轨道保留现有的 CPU 求值器：逐键缓动、混合逐键 STEP/LINEAR 片段、矩阵/颜色/自定义数据形状、相对/常量循环模式、未解析或非原生属性绑定，以及其关键帧时间域无法覆盖所请求前向播放范围的轨道。具有不同轨道帧率、反向范围/速度、非有限时序或无动画的调用也保留整次调用的回退，因为它们不共享单一的原生门面时钟。Compat 使用 Babylon.js 规则规范化反向范围/速度，并以各自的帧率推进每个回退动画。在原生回放开始后赋予负速度或非有限速度会被显式拒绝，而不会静默更改求值器所有权。结构化多目标 `AnimationGroup` 路径同样保持由 compat 拥有，因为其基于静息姿态加权的混合器与可变生命周期尚未与 Lite 的单目标属性组和可选混合器语义完全对齐。结构化静息姿态按值捕获（包括克隆向量/四元数值），因此重复的部分权重混合不会修改其自身的基准。逐键缓动即由同一 compat 求值器实现；仅使用动画级缓动的轨道保留上述原生委托。

## 依赖关系

- `../math/mat4.js` —— 用于 LINEAR 四元数插值的 `quatSlerp`
- `../skeleton/skeleton-updater.js` —— `createAnimationController`、`AnimationController`
- `../loader-gltf/gltf-animation.ts` —— `parseAnimationData`（glTF → `GltfAnimationData`）
- `../loader-gltf/gltf-parser.ts` —— `resolveAccessor`、`computeNodeWorldMatrix`、`findParent`
- `./animation-manager.ts` —— 通用任务调度器；拥有更新/启动/停止/固定步长语义
- `./animation-group-task.ts` —— AnimationGroup 到 AnimationTask 的适配器及所有权状态
- `./property-animation.ts` —— 手动属性片段构建器及属性路径绑定
- `./weighted-pointer-mixer.ts` —— 可选手动属性权重混合器及基于时长的权重渐变调度
- `./weighted-gltf-mixer.ts` —— 可选 glTF 骨骼权重混合器，仅在显式导入/启用时加载

## 测试规范

1. **LINEAR 插值**：验证 vec3 lerp 和 quat slerp 产生正确的中间值
2. **STEP 插值**：验证输出直接吸附到关键帧值而不进行混合
3. **CUBICSPLINE 插值**：验证带切线的 Hermite 样条求值；验证四元数归一化
4. **二分搜索边界情况**：`t` 位于首帧之前、末帧之后、恰好落在关键帧上、位于关键帧之间
5. **AnimationGroup 生命周期**：play → tick → 验证时间推进；pause → tick → 验证时间冻结；stop → 验证重置为 0
6. **goToFrame**：验证 `goToFrame(120)` 将时间设为 `2.0` 秒、立即求值姿态并暂停
7. **循环**：验证时间在持续时间边界正确回绕
8. **速率比**：验证 `speedRatio = 2` 使回放速度加倍
9. **变形权重上传**：验证针对 `PATH_WEIGHTS` 通道向 GPU 缓冲区写入正确的权重
10. **手动标量动画**：验证 `position.x` 关键帧复现 Babylon 帧率时序
11. **手动向量动画**：验证 `position` 调用 `.set(x, y, z)` 并标记世界矩阵为脏
12. **独立管理器**：验证 `updateAnimationManager()` 在无场景或引擎的情况下适用于手动属性片段
13. **错误路径失败**：验证无效属性路径在绑定期间抛出异常
14. **手动加权混合**：验证指向同一标量的两个组写入与组顺序无关的单一加权结果
15. **手动交叉淡入淡出**：验证管理器渐变任务按已流逝时长更新组权重
16. **glTF 加权骨骼混合**：验证 Xbot walk/run 加权 TRS 混合与 Babylon.js 参考一致
17. **叠加骨骼混合**：验证 Xbot 叠加姿态/循环层与 Babylon.js 参考一致
18. **独立骨骼片段**：验证针对一个骨骼的片段不会上传或重置同一资产中的另一个骨骼
19. **已销毁的动画资源**：验证存活的动画组可以继续求值 CPU 状态，而不会向已销毁的骨骼纹理或变形权重缓冲区上传数据
20. **属性缓动**：验证标量/向量/四元数插值使用缓动后的片段进度、STEP 绕过回调、端点保持精确且超调值不被限幅
21. **Compat 原生委托**：验证受支持的 Babylon.js 风格直接动画与挂载动画由 Lite 属性组推进并写入，而不受支持的独立轨道使用显式的 compat 回退
22. **Compat 缓动门面**：验证 `IEasingFunction | null`、实时替换/清除、直接与结构化求值，以及原生标量/向量/四元数回放
23. **Compat 生命周期**：验证非零范围、精确循环边界、完成、暂停/重启/停止、全关键帧域跳转、正速度变更以及重叠写入顺序
24. **Compat 逐键缓动**：验证起始键优先级、默认/线性回退、STEP 与末关键帧回调绕过、标量/向量/四元数值、结构化动画组以及原生/compat 混合回放

## 文件清单

| 文件                        | 用途                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `types.ts`                  | 所有动画数据类型、插值/路径常量、GPU 挂载数据接口                                          |
| `evaluate.ts`               | 关键帧插值引擎（LINEAR、STEP、CUBICSPLINE）；二分搜索；零内存分配                          |
| `animation-group.ts`        | 面向用户的 AnimationGroup 工厂；为每个片段包装 AnimationController                         |
| `animation-group-mask.ts`   | 可选包含/排除目标名称遮罩（`AnimationGroupMask`）；首次使用时安装控制器的遮罩解析器        |
| `animation-manager.ts`      | 通用动画任务调度器；无 2D、3D、glTF 或属性动画运行时导入                                   |
| `animation-group-task.ts`   | AnimationGroup 到 AnimationTask 的适配器、所有者追踪以及 `getAnimationGroups()` 查找       |
| `property-animation.ts`     | 手动属性动画片段构建器及属性路径绑定                                                       |
| `weighted-pointer-mixer.ts` | 可选手动属性权重混合器外加淡入淡出/交叉淡入淡出调度                                        |
| `weighted-gltf-mixer.ts`    | 可选 glTF 骨骼加权/叠加混合器，每个混合目标每帧仅上传一次骨骼                              |
