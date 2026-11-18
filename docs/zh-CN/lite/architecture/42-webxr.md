# 模块：WebXR（WebGPU 绑定）

> 包路径：`packages/babylon-lite/src/xr/`

> **状态：前瞻性实现 / 尚无法在任何浏览器中运行。**
> 本模块面向**草案阶段**的 [WebXR/WebGPU 绑定](https://github.com/immersive-web/WebXR-WebGPU-Binding)（`XRGPUBinding`、投影层、`getViewSubImage`）。目前尚无用户代理（浏览器）实现该绑定，因此代码已按 Mock 完成结构化、类型标注与单元测试，一旦有浏览器实现即可直接运行。权威 API 以 `packages/babylon-lite/src/xr/` 中导出的 TSDoc 为准。

---

## 用途

通过 WebGPU XR 绑定将 Babylon Lite 场景立体渲染至沉浸式 XR 设备（`immersive-vr` 或 `immersive-ar`），并暴露基础输入源（控制器目标射线 / 握持姿态以及选择/握持事件）。

本模块是 **100% 按需启用且可 Tree-shake** 的。不从 `xr/` 导入任何内容的场景付出**零字节**成本——关键在于该集成**没有向 `camera.ts`、`render-task.ts` 或任何热点路径/共享 chunk 添加任何代码**。它直接复用现有引擎机制（帧图、渲染任务、即时渲染目标、相机矩阵缓存），而非在其中穿插 XR 专用分支。

本阶段范围之外的内容：瞬移（teleport）、手部关节追踪、触觉反馈、AR 命中测试、锚点以及任何默认体验 UI。

---

## 公共 API 接口

全部从包汇总文件 `packages/babylon-lite/src/index.ts` 导出。

### `xr/xr-support.ts`

```ts
type XrSessionMode = "immersive-vr" | "immersive-ar";

function isWebXrPresent(): boolean; // navigator.xr exists
function isWebGpuXrSupported(): boolean; // global XRGPUBinding exists (false everywhere today)
function isXrSessionSupported(mode: XrSessionMode): Promise<boolean>; // combines both + navigator.xr.isSessionSupported; never throws
```

### `xr/xr-camera.ts`

```ts
interface XrCamera extends Camera {
    readonly eye: XREye; // "left" | "right" | "none"
    _world: Mat4Storage; // @internal mutable eye pose (view→world), backs worldMatrix
    _wmv: number; // @internal version, backs worldMatrixVersion
}

function createXrCamera(eye: XREye): XrCamera;
function updateXrCameraForView(cam: XrCamera, view: XRView, rtWidth: number, rtHeight: number, viewport: NormalizedViewport): void;
```

### `xr/xr-input.ts`

```ts
interface XrInputSource {
    readonly source: XRInputSource; // underlying WebXR source
    readonly handedness: XRHandedness;
    readonly targetRayMode: XRTargetRayMode;
    readonly targetRayMatrix: Float32Array; // column-major 4×4, valid when targetRayTracked
    targetRayTracked: boolean;
    readonly gripMatrix: Float32Array; // valid when gripTracked
    gripTracked: boolean;
    selecting: boolean; // true between selectstart/selectend
    squeezing: boolean; // true between squeezestart/squeezeend
    readonly gamepad: Gamepad | null;
}

interface XrInputCallbacks {
    onInputSourcesChange?(added: readonly XrInputSource[], removed: readonly XrInputSource[]): void;
    onSelectStart?(i: XrInputSource): void;
    onSelect?(i): void;
    onSelectEnd?(i): void;
    onSqueezeStart?(i: XrInputSource): void;
    onSqueeze?(i): void;
    onSqueezeEnd?(i): void;
}

interface XrInputManager {
    readonly inputSources: readonly XrInputSource[]; /* + @internal state */
}

function createXrInputManager(session: XRSession, callbacks: XrInputCallbacks): XrInputManager;
function updateXrInputPoses(mgr: XrInputManager, frame: XRFrame, referenceSpace: XRReferenceSpace): void;
function disposeXrInputManager(mgr: XrInputManager): void;
```

### `xr/xr-session.ts`

```ts
interface XrSessionOptions {
    mode?: XrSessionMode; // default "immersive-vr"
    referenceSpaceType?: XRReferenceSpaceType; // default "local-floor", falls back to "local"
    requiredFeatures?: string[]; // merged with mandatory "webgpu"
    optionalFeatures?: string[];
    colorFormat?: GPUTextureFormat; // default binding.getPreferredColorFormat()
    depthStencilFormat?: GPUTextureFormat | null; // default "depth24plus"; null = color-only
    input?: XrInputCallbacks | false; // false disables input tracking
    onFrame?(ctx: XrSessionContext, frame: XRFrame, time: DOMHighResTimeStamp): void;
    onEnd?(): void;
}

interface XrSessionContext {
    readonly mode;
    session;
    binding;
    layer;
    referenceSpace;
    scene;
    engine;
    readonly colorFormat;
    depthFormat;
    readonly cameras: readonly XrCamera[]; // per-eye, in XRViewerPose.views order
    readonly input: XrInputManager | null;
    /* + @internal lifecycle state */
}

function enterXr(scene: SceneContext, options?: XrSessionOptions): Promise<XrSessionContext>;
function exitXr(ctx: XrSessionContext): Promise<void>;
```

### 环境草案类型 —— `xr/webxr-webgpu.d.ts`

全局脚本（无 import/export），使其 `interface` 块能够与标准库全局声明合并。声明了 `XRGPUBinding`、`XRGPUSubImage`、图层初始化字典、`GPURequestAdapterOptions.xrCompatible` 以及 `XRRenderState(Init).layers`。文件开头使用 `/// <reference types="webxr" />`，以便即使在 `tsconfig.base.json` 的 `types` 白名单仅包含 `["@webgpu/types"]` 的情况下，也能引入标准 WebXR DOM 类型（`@types/webxr`）。

---

## 内部架构

### 每眼渲染单元

会话为每个 `XRView`（即每只眼睛）持有一个 `XrEyeUnit`，每个单元包含：

- 一个**即时（eager）** `RenderTarget`（`_eager = true`），
- 一个 `XrCamera`，
- 一个镜像场景的 `RenderTask`（`createRenderTask({ rt, clr, cam }, engine, scene)`）。

采用**每眼一个渲染任务**（而非在单个共享任务上反复重设目标），因为每个渲染任务拥有自己的 `_sceneUBO`。单一共享 UBO 在双眼间会产生别名冲突：`queue.writeBuffer` 在提交前只会保留**最后一次**写入的值，导致双眼最终都读取到第二只眼的视图/投影矩阵。

### 零开销相机矩阵注入（`xr-camera.ts`）

`XrCamera` 不在共享的 `camera.ts` 读取器中添加 XR 覆盖分支（那样会增大所有场景的 bundle），而是直接写入这些读取器本就会读取的矩阵缓存：

- **视图矩阵 + 视点位置**自动从 `worldMatrix` 推导。将 `_world = XRView.transform.matrix`（列主序的眼部姿态，view→world）赋值并递增 `_wmv`，即可使 `getViewMatrix` 生成对应的刚体逆变换，同时使 `_packSceneUniforms` 从世界矩阵平移列中读取视点位置——两者全部自动生效。
- **投影矩阵**是来自 `XRView.projectionMatrix` 的按眼**非对称**视锥体，对称透视的 `getProjectionMatrix` 无法复现它。因此将其直接注入 `_projCache`，同时设置 `_projVer = _wmv` 并将 `_projAspect` 设为渲染任务将会请求的精确宽高比。`_viewVer`/`_vpVer` 被置为无效（`-1`），使视图和视图投影缓存在使用新姿态 + 注入投影时重新合成。

**宽高比浮点恒等不变量：** 仅当 `_projAspect === aspect` 时，`getProjectionMatrix` 才会返回注入的缓存。渲染任务按 `aspect = (rt._width / rt._height) * (viewport.width / viewport.height)` 计算宽高比。`updateXrCameraForView` **必须以完全相同的操作数顺序复现这一浮点表达式**，以确保数值逐比特完全相等；否则缓存会未命中，进而错误地重算一个对称透视矩阵。

### 即时渲染目标（Eager render targets）

`rt._eager = true` 使 `buildRenderTarget` 成为空操作（由合成器拥有纹理），并使 `disposeRenderTarget` 成为空操作（绝不销毁 XR 持有的纹理）。每一帧循环都会从 `XRGPUSubImage` 刷新 `rt._colorTexture/_colorView/_depthTexture/_depthView/_width/_height`。

### 逐帧附件替换

`executePass` 仅在 `cfg.rt === eng.scRT` 时才会每帧从 RT 重新读取颜色视图。由于 XR RT 不是 `scRT`，循环每帧手动更新 `task._colorAttachment.view` **以及** `task._renderPassDescriptor.depthStencilAttachment.view`（合成器每帧从双缓冲/三缓冲交换链返回新的 `GPUTexture`）。

### 深度处理

单个即时 RT **同时**携带颜色与深度（其描述符包含 `format + dFormat`）；不使用独立的 `config.depth`。若在 `_eager` 模式下同时指定 `config.depth`，会强制使用 `loadOp: "load"`，但 XR 每帧需要的是 `"clear"`。将深度挂在颜色 RT 上而不设置 `config.depth` 时，`_depthLoadOp` 为 `undefined` 并默认采用 `"clear"`，行为正确。

---

## 管线配置

XR **不引入任何新管线**。`Renderable.bind(engine, targetSignature)` 已经能够按目标签名解析/构建管线，因此场景中的可渲染对象可以直接正确地渲染到 XR 目标的格式中（例如 `rgba8unorm` / `depth24plus` / 1 次采样）——这与如今阴影贴图和 RTT 针对各自签名渲染的机制完全一致。绑定组 0（scene UBO）归渲染任务所有，因此每只眼的渲染任务都带有各自的每眼视图/投影数据。

---

## 着色器逻辑

无。XR 原封不动地复用场景现有的材质与着色器；仅 group(0) 的场景 UBO 内容（每眼的视图/投影/视点位置）有所不同，且这些内容全部来自注入的相机缓存。

---

## 状态机 / 生命周期

```
enterXr(scene, opts)
  ├─ guard: isWebXrPresent() && isWebGpuXrSupported()  → throw if missing
  ├─ navigator.xr.requestSession(mode, { requiredFeatures: ["webgpu", ...] })
  ├─ binding = new XRGPUBinding(session, device)
  ├─ layer = binding.createProjectionLayer({ colorFormat, depthStencilFormat })
  ├─ session.updateRenderState({ layers: [layer] })
  ├─ referenceSpace = requestReferenceSpace("local-floor") ?? "local"
  ├─ stopEngine(engine)                 // hand the render loop to XR
  ├─ input = createXrInputManager(...) | null
  ├─ if AR: save scene.clearColor, force alpha = 0 (passthrough)
  ├─ session.addEventListener("end", () => cleanup(ctx), { once: true })
  └─ session.requestAnimationFrame(onXrFrame)

onXrFrame(ctx, time, frame)             // per XRFrame
  ├─ reschedule next frame
  ├─ pose = frame.getViewerPose(referenceSpace)
  ├─ if input: updateXrInputPoses(...)
  ├─ options.onFrame?.(...)
  ├─ if !pose: return (skip render, keep loop alive)
  ├─ encoder = device.createCommandEncoder(); set eng._currentEncoder/_currentDelta
  ├─ scene._update()                    // ONCE: animations, pre-passes, uniform updaters
  ├─ for each view:
  │    ├─ subImage = binding.getViewSubImage(layer, view)
  │    ├─ ensureUnit(i, eye)            // lazily build RT + camera + task
  │    ├─ refresh eager RT views + task attachment views
  │    ├─ task.record() once
  │    ├─ updateXrCameraForView(camera, view, texW, texH, viewport)
  │    └─ task.execute()
  ├─ device.queue.submit([encoder.finish()])
  └─ restore prev encoder/delta

exitXr(ctx) → session.end() → "end" event → cleanup(ctx)

cleanup(ctx)                            // idempotent
  ├─ cancel rAF
  ├─ disposeXrInputManager(input)
  ├─ dispose per-eye tasks; clear units
  ├─ restore saved clearColor (AR)
  ├─ options.onEnd?.()
  └─ startEngine(engine)                // resume the canvas loop
```

**AR 透视（passthrough）。** 在会话期间 `scene.clearColor.a` 被强制设为 0，以便真实世界透出；会话结束时恢复原值。因为处于 XR 状态时画布渲染循环已停止，这一修改对画布不可见。

---

## Babylon.js 对照表

| Babylon.js (`dev/core/src/XR/`)               | Babylon Lite (`xr/`)                               |
| --------------------------------------------- | -------------------------------------------------- |
| `WebXRSessionManager`                         | `enterXr` / `exitXr` / `XrSessionContext`          |
| `WebXRExperienceHelper` (enter/exit)          | `enterXr` / `exitXr`（无默认体验 UI）              |
| `WebXRCamera` + 装备相机                      | `XrCamera`（每眼一个）+ 矩阵缓存注入               |
| `WebXRRenderTarget` / WebGL 图层              | 即时 `RenderTarget` + `XRGPUBinding` 投影层        |
| `WebXRInput` / `WebXRInputSource`             | `XrInputManager` / `XrInputSource`                 |
| `WebXRSessionManager.isSessionSupportedAsync` | `isXrSessionSupported`                             |
| WebGL 绑定（`XRWebGLBinding`）                | **WebGPU 绑定**（`XRGPUBinding`）—— 草案           |

实质差异：Babylon.js XR 运行在基于 `XRWebGLBinding` 的 WebGL2 上；Babylon Lite 仅面向 WebGPU 并针对草案中的 `XRGPUBinding`，因此每视图循环是从 `getViewSubImage` 获取 `GPUTexture`，而非绑定帧缓冲。

---

## 依赖项

- `engine/engine.ts` —— `startEngine` / `stopEngine`、`EngineContext` 内部成员（`_device`、`_currentEncoder`、`_currentDelta`）。
- `engine/render-target.ts` —— `createRenderTarget` 及即时 RT 语义。
- `frame-graph/render-task.ts` —— `createRenderTask`、`record`/`execute`/`dispose`、`_colorAttachment`、`_renderPassDescriptor`。
- `camera/camera.ts` —— `Camera` 接口 + 矩阵缓存契约（仅读取，未修改）。
- `scene/scene-core.ts` —— `SceneContext`、`scene._update`、`scene.clearColor`、`scene.surface.engine`。
- 开发依赖 `@types/webxr` 提供标准 WebXR DOM 类型；草案绑定类型以环境声明形式位于 `webxr-webgpu.d.ts`。发布后的包将 `@types/webxr` 列为（纯类型）依赖，且汇总生成的 `index.d.ts` 以 `/// <reference types="webxr" />` 开头，因此严格配置下的消费方即使从未使用 XR 或在 `compilerOptions.types` 中未包含 `webxr`，也能对公共 XR API 正常通过类型检查。

无模块级副作用（支柱：禁止模块级 `new Map()` 等）；所有状态均存储在返回的上下文对象上。

---

## 测试规范

单元测试（基于 Mock，`tests/lite/unit/xr/`）—— 通过 `pnpm test:unit` 运行。一致性/性能测试不适用（尚无 XR 基准参考）。

- **`xr-support.test.ts`** —— 覆盖 `navigator.xr` 与 `XRGPUBinding` 存在/缺失组合下的 `isWebXrPresent` / `isWebGpuXrSupported` / `isXrSessionSupported`；保证被拒绝时绝不抛出异常。
- **`xr-camera.test.ts`** —— 视图矩阵为眼部姿态的逆；投影矩阵按渲染任务的精确宽高比原样注入；视图投影矩阵 = proj × view；宽高比与渲染任务公式逐比特一致；每次更新递增版本号。
- **`xr-input.test.ts`** —— 从 `session.inputSources` 初始化；`inputsourceschange` 时增删；不重复添加；select/squeeze 标志切换与回调；忽略未追踪的输入源；姿态更新及未追踪回退；dispose 移除监听器。
- **`xr-session.test.ts`** —— 缺少 WebXR / 缺少绑定时抛出异常；完整的进入 → 单帧立体渲染（双相机、双通道、单次提交）→ 退出流程；无姿态帧保持循环存活但不渲染；AR 强制/恢复 `clearColor.a`；VR 不改动清屏色；输入管理器创建/释放；`onFrame`/`onEnd` 回调触发。

Lab 演示：`lab/lite/xr.html` + `lab/lite/src/xr.ts` —— 一个包含 **Enter VR / Enter AR / Exit** 按钮的小场景，通过 `isXrSessionSupported` 进行特性检测并优雅提示 `"WebGPU XR not yet supported"`。状态暴露于 `window.__xrDemo`。

---

## 文件清单

| 文件                             | 职责                                             |
| -------------------------------- | ------------------------------------------------ |
| `xr/webxr-webgpu.d.ts`           | 草案 WebGPU XR 绑定的环境类型声明。              |
| `xr/xr-support.ts`               | 特性检测（`XrSessionMode` 及三项检测函数）。     |
| `xr/xr-camera.ts`                | `XrCamera` + 按视图的视图/投影缓存注入。         |
| `xr/xr-input.ts`                 | 输入源追踪 + select/squeeze 事件。               |
| `xr/xr-session.ts`               | 会话生命周期 + 逐帧立体渲染循环。                |
| `tests/lite/unit/xr/*.test.ts`   | 基于 Mock 的单元测试（支持度、相机、输入、会话）。|
| `lab/lite/xr.html` + `src/xr.ts` | 受门控且优雅降级的 lab 演示。                    |
