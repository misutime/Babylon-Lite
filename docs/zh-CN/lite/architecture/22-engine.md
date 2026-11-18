# 模块：引擎（Engine）

> 包路径：`packages/babylon-lite/src/engine/engine.ts`

## 目的

引擎模块是 Babylon Lite 的最底层。它负责获取 WebGPU 适配器和设备、在渲染画布上配置交换链、创建 MSAA 和深度/模板渲染目标，并通过 `requestAnimationFrame` 驱动逐帧渲染循环。所有其他模块均依赖引擎获取 GPU 设备访问权限和帧编排能力。

渲染画布既可以是 DOM `HTMLCanvasElement`（主线程），也可以是 `OffscreenCanvas`（例如通过 `transferControlToOffscreen()` 传输到 Web Worker 的画布）。引擎在这两种情况下均无需修改即可运行 —— 参见下文的_离屏 / Worker 渲染_。

## 公共 API 接口

```typescript
/** A surface the engine can render into: a DOM canvas or an OffscreenCanvas. */
export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Read-only public view of a registered rendering context. */
export interface RenderingContext {
    clearColor: GPUColorDict;
}

/** Return the surface's live rendering-context list in render order. */
export function getRenderingContexts(surface: SurfaceContext): readonly RenderingContext[];

/** Move a registered context to its final position in the surface's render order. */
export function moveRenderingContext(surface: SurfaceContext, context: RenderingContext, index: number): boolean;

/** Return the rendering context's stable family identifier. */
export function getRenderingContextKind(context: RenderingContext): string;

/** Top-level scene context. */
export interface SceneContext extends RenderingContext {
    /** Optional display name for tooling and diagnostics. */
    name?: string;
    /** Factory-created default producer; custom graphs retain their own task handles. */
    readonly defaultRenderTask?: RenderTask;
}

/** Create a scene that composites over a base scene on the same surface. */
export interface OverlaySceneOptions {
    rt: RenderTarget;
    rst?: RenderTarget;
}
export function createOverlayScene(baseScene: SceneContext, options: OverlaySceneOptions): SceneContext;

/** A utility scene and the scene it composites onto. */
export interface UtilityLayer {
    readonly scene: SceneContext;
    readonly mainScene: SceneContext;
}
export interface UtilityLayerOptions extends OverlaySceneOptions {
    addDefaultLight?: boolean;
    lightIntensity?: number;
}
export function createUtilityLayer(mainScene: SceneContext, options: UtilityLayerOptions): UtilityLayer;
export function registerUtilityLayer(utility: UtilityLayer): Promise<void>;
export function disposeUtilityLayer(utility: UtilityLayer): void;

/** Handle to the WebGPU engine — public API surface.
 *  GPU internals (device, context, format) are @internal — not user-facing. */
export interface EngineContext {
    readonly canvas: RenderCanvas;
    readonly msaaSamples: number; // 1 or 4
    readonly format: GPUTextureFormat;

    /** GPU draw calls executed by the latest `renderFrame` call, summed across its selected surfaces. */
    drawCallCount: number;

    /** Instrumented GPU interval for the last measured frame, in milliseconds. Includes every frame
     *  command plus the opening and closing marker dispatches. 0 before the first sample and while disabled. */
    gpuFrameTimeMs: number;
}

/** Whether GPU frame-time measurement is available on this engine's device (the adapter offered the
 *  WebGPU `timestamp-query` feature). When false, `setGpuTimingEnabled` is a no-op. */
export function isGpuTimingSupported(engine: EngineContext): boolean;
/** Enable or disable per-frame GPU timing (disabled by default). While on, `engine.gpuFrameTimeMs`
 *  reports the instrumented frame interval including marker dispatches. Opt-in and zero-cost when unused. */
export function setGpuTimingEnabled(engine: EngineContext, enabled: boolean): void;

export type RenderTaskGpuTimingStatus = "unsupported" | "disabled" | "pending" | "available" | "error";
export interface RenderTaskGpuTiming {
    readonly index: number;
    readonly name: string;
    /** Raw task interval; intervals can overlap and are not additive. */
    readonly durationMs: number;
}
export interface RenderTaskGpuTimings {
    readonly status: RenderTaskGpuTimingStatus;
    readonly supported: boolean;
    readonly enabled: boolean;
    readonly frameIndex: number;
    readonly tasks: readonly RenderTaskGpuTiming[];
    /** Envelope from the earliest measured task begin to the latest measured task end. */
    readonly totalDurationMs: number;
    readonly droppedTaskCount: number;
    readonly error?: string;
}
export function isRenderTaskGpuTimingSupported(engine: EngineContext): boolean;
export function getRenderTaskGpuTimings(engine: EngineContext): RenderTaskGpuTimings;
export function setRenderTaskGpuTimingEnabled(engine: EngineContext, enabled: boolean): Promise<RenderTaskGpuTimings>;

/** Start the render loop for all registered rendering contexts. Resolves after the first frame renders. */
export function startEngine(engine: EngineContext): Promise<void>;
/** Resolve after all GPU commands submitted before this call have completed. */
export function waitForGpuIdle(engine: EngineContext): Promise<void>;
export function waitForGpuResourceRetirements(engine: EngineContext): Promise<void>;
/** Stop the render loop. */
export function stopEngine(engine: EngineContext): void;
/** Resize render targets to match canvas layout size. No-op for an OffscreenCanvas. */
export function resizeEngine(engine: EngineContext): void;
/** Set the backing-store size directly in device pixels (used for OffscreenCanvas). */
export function setEngineSize(engine: EngineContext, widthPx: number, heightPx: number): void;
/** Release all engine-owned GPU resources (render targets, device). */
export function disposeEngine(engine: EngineContext): void;
/** Render all engine surfaces, or an explicit non-empty subset, through one encoder and submission. */
export function renderFrame(engine: EngineContext, delta: number, surfaces?: readonly [SurfaceContext, ...SurfaceContext[]]): void;

export interface EngineOptions extends SurfaceOptions {
    readonly device?: never;
    readonly requiredLimits?: Record<string, GPUSize64 | undefined>;
    readonly useHighPrecisionMatrix?: boolean;
    readonly useFloatingOrigin?: boolean;
}

export interface EngineDeviceOptions extends Omit<EngineOptions, "requiredLimits" | "device"> {
    device: DeviceContext;
    requiredLimits?: never;
    requiredFeatures?: never;
}

export interface EngineFeatureOptions extends EngineOptions {
    readonly requiredFeatures: readonly GPUFeatureName[];
}

export function createEngineWithFeatures(canvas: RenderCanvas, options: EngineFeatureOptions): Promise<EngineContext>;

/** Create the Babylon Lite engine. Acquires GPU adapter + device, configures swapchain. */
export async function createEngine(canvas: RenderCanvas, options?: EngineOptions): Promise<EngineContext>;
export function createEngine(canvas: RenderCanvas, options: EngineDeviceOptions): Promise<EngineContext>;
```

### 内部类型（未导出）

```typescript
/** @internal — GPU internals accessible only to renderable/loader code. */
interface EngineContextInternal extends EngineContext {
    readonly device: GPUDevice;
    readonly context: GPUCanvasContext;
    readonly format: GPUTextureFormat;
    readonly alphaMode: GPUCanvasAlphaMode;
    _renderingContexts: RenderingContext[];
    _currentEncoder: GPUCommandEncoder;
    _swapchainView: GPUTextureView;
    _currentDelta: number;
    _cbs: GPUCommandBuffer[];
}
```

## 内部架构

### 初始化序列（`createEngine`）

1. **请求适配器**：`navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })` —— 若 WebGPU 不可用则抛出异常。
2. **请求设备**：`createDevice` 机会性地请求 Lite 支持的浮点过滤、纹理压缩（含非对齐压缩尺寸）、时间戳查询（timestamp-query）和图元索引（primitive-index）特性。`createEngineWithFeatures` 会安装一个内部特性解析器，用于验证并添加诸如 `shader-f16` 等显式特性；从不调用该函数的 bundle 会将此解析器检查折叠消除。
3. **画布上下文**：`canvas.getContext('webgpu')` —— 若上下文不可用则抛出异常。
4. **配置交换链**：`context.configure({ device, format, alphaMode })`，其中 `format = navigator.gpu.getPreferredCanvasFormat()` 且 `alphaMode = options?.alphaMode ?? "opaque"`。
5. **MSAA**：默认为 `msaaSamples = 4`，若请求则为 `1`。
6. **渲染上下文**：初始化一个空的 `_renderingContexts` 列表。场景和其他渲染器会自行向引擎注册。

### 准备设备

`createDevice()` 独立于画布执行步骤 1-2。将其从包根路径导入到一个小型引导 bundle 中，即可使 GPU 初始化与下载应用代码并行重叠：

```typescript
const [device, app] = await Promise.all([createDevice(), import("./app.js")]);
const engine = await createEngine(canvas, { device });
await app.start(engine);
```

使用 `{ device }` 创建的引擎会跳过获取步骤；未传时，`createEngine` 会自行调用 `createDevice`。可在创建设备时配置限制；其适配器和可选特性在获取期间选定。`EngineDeviceOptions` 会拒绝相互冲突的获取选项（包括显式特性）。`engine.device` 暴露上下文对象，但从不暴露其原生句柄。

一个设备上下文只支持一个引擎，且由该引擎拥有：`disposeEngine` 会销毁该设备，且将同一个上下文传递给第二个引擎会抛出异常。所有权仅在初始化成功后转移。如果初始化失败，调用者可以销毁或使用仍处于未认领状态的传入上下文重试。部分初始化的画布不会自动取消配置，这与现有的失败行为保持一致。

选择启用恢复功能时，会使用上下文的原始限制请求替换设备，并就地更新上下文。
完整的拥有权和恢复规范参见[设备上下文](device-context.md)。

### 渲染上下文内省

`getRenderingContexts(surface)` 将表面现有的注册表数组作为只读实时视图返回；它不会分配快照。因此，注册和注销可以通过此前返回的引用按渲染顺序立即可见，且无任何逐帧开销。对于当前的内置上下文，`getRenderingContextKind(context)` 返回 `"scene"`、`"frame-graph-context"`、`"effect-renderer"`、`"sprite-renderer"` 或 `"text-renderer"`。其返回类型刻意设为开放的 `string` 类型，以便新增上下文族时不构成破坏性 API 变更。当传入非 Lite 创建的结构化公共对象作为渲染上下文时，会抛出 `TypeError`。实用层（utility layer）会注册一个默认名称为 `"UtilityLayer"` 的普通场景上下文；工具可以显示 `SceneContext.name`，而无需将实用层视为独立的渲染上下文族。

### 渲染顺序、叠加场景和实用层

`moveRenderingContext(surface, context, index)` 将已注册的上下文移动到其最终整数位置 `index`（钳制在注册表边界内），若上下文未注册则不做任何更改并返回 `false`。在修改注册表之前，非整数索引会抛出 `RangeError`。它按标识查找上下文，将其移除，并在同一个实时注册表数组中按钳制后的位置重新插入；移动已在正确位置的上下文也会返回 `true`。上下文按列表顺序渲染。其独立的 `rendering-context-order.ts` 模块仅导入表面和上下文类型，从而允许从从不使用该操作的应用中 tree-shake 移除。

每个普通场景都会清除其配置的目标。若要将另一个场景合成到其上，请使用显式的最终颜色目标调用 `createOverlayScene(baseScene, { rt, rst? })`。基础场景仅提供表面和注册顺序。`createUtilityLayer(mainScene, { rt, rst?, addDefaultLight?, lightIntensity? })` 使用相同的契约，跟随主相机并可选地添加默认灯光。同级和嵌套叠加场景必须显式接收预期的颜色目标。它们的顺序保持深度优先，同级按注册顺序排列，后注册的文本上下文位于上层。

若叠加场景（包括实用层）的基础场景未在表面上注册（尚未注册、已注销或已销毁），则该叠加场景保持注册状态，但跳过其 `_update` 和 `_record` 工作。当其基础场景重新注册时，场景注册会将其移回关联叠加场景之前，并将这些叠加场景分组排列在其后。之后显式移动上下文可以改变此顺序，因此使用 `moveRenderingContext` 的调用者必须保留叠加场景的分组。

叠加场景本身也可以托管叠加场景或实用层。它们的分组保持深度优先的连续顺序，同级叠加场景按注册顺序排列。仅当其基础链上的每个场景都已注册时，叠加场景才处于激活状态。由于叠加场景的基础在创建时即固定，因此 `createOverlayScene` 在创建时对叠加场景的录制包装一次；注销并重新注册叠加场景不会添加额外的回调或包装器。

场景注册拥有一个可选的模块级接缝：`scene/scene-core.ts` 中的 `_installOverlaySceneRegistration(registered)`。由 `createOverlayScene` 安装它；`scene/overlay-scene.ts` 拥有已安装的函数、非激活基础包装器、后代发现以及显式分组逻辑。从不导入 `createOverlayScene` 的应用会 tree-shake 掉安装器，因此压缩器会完全移除该接缝调用，单场景或多表面应用不会携带任何叠加代码。注册仅在新上下文成功插入后调用已安装的函数，包括在阴影支持注册路径上。已安装的函数解析叠加树的最高层根；当该根未注册时不会移动任何内容，因此在此期间注册的同级保持其注册顺序。否则，它会将根移动到任何更早的显式后代之前，并按现有相对顺序将每个直接子代及其子树递归移动到根之后。一旦安装，该接缝适用于应用中的每个引擎；在没有叠加场景的表面上，其分组逻辑为空操作。逐帧渲染循环中不添加任何排序或注册表搜索。

#### 显式附件契约（破坏性变更）

**强制性的[显式输出 PR 验收规则](28-frame-graph.md#强制性显式输出纹理pr-准入门槛)适用于每个渲染任务：它必须暴露自己实际产生的纹理。任务可以接收目标，也可以像 `GeometryRendererTask` 那样自行分配输出；要求所有目标均作为输入并非通用规则。当 GPU 操作允许时，输入和输出纹理可以相同也可以不同。拒绝缺失或具有误导性的输出契约；兼容性和通过视觉测试均不能作为例外。**

此叠加 API 专门借用现有的颜色目标：因此 `createOverlayScene(baseScene, { rt, rst? })` 需要目标颜色目标，以及可选的单采样解析目标。`createUtilityLayer(mainScene, options)` 在 `UtilityLayerOptions` 中要求相同的字段。此要求特定于这些 API，并不禁止其他任务自行分配其输出。基础场景仅决定表面、排序和注册生命周期，绝不决定颜色资源选择。

叠加场景在创建时不带默认任务，随后安装一个自动场景渲染任务，其配置为 `rt`、`rst`、`sharedRt: true` 和 `clr: false`。它拥有一个与颜色目标的尺寸、采样数和深度惯例相匹配的独立深度/模板目标；即使加载颜色，深度也会被清除。它既不分配也不销毁借用的颜色/解析目标。它们的生产者必须在叠加场景执行前初始化它们；注册顺序不限。执行期间会读取它们的实时视图（包括在调整大小之后），而不会扫描任务或覆盖附件视图。

`scene.defaultRenderTask` 按标识暴露工厂创建的生产者（当 `defaultRenderTask: false` 时为 undefined）。每个渲染任务都将其现有的实时配置暴露为 `task.config`；内部 `_config` 指向同一对象。因此普通场景可以直接将 `scene.defaultRenderTask.config` 传递给叠加场景，而无需重复创建目标或搜索帧图。这是默认生产者的配置，而非自动选定的最终后处理输出。自定义生产者继续使用 `createSceneContext(surface, { defaultRenderTask: false })` 和 `addTask(scene, createRenderTask({ name: "scene", rt, rst, depth? }, engine, scene))`。替换任务、更改其格式/采样数或更改后处理链的输出都需要显式地重新接线/重建消费者；叠加场景从不主动发现替换项，也从不推断任务启用状态。调用者必须将消费者与禁用的生产者一起门控。未注册的祖先仍会挂起叠加场景。

私有叠加深度目标通过共享的渲染目标状态工厂复用其颜色目标的尺寸解析器。其尺寸 getter 在每次重建时读取所提供的颜色目标的当前描述符，包括当纹理外观（facade）替换描述符的尺寸对象时。这保留了缩放/自定义尺寸调整能力，而无需将缩放尺寸解释逻辑拉入普通叠加 bundle。对于描述符尺寸为占位符的 `surface.scRT`，深度会改用实时表面尺寸。绘制更新尺寸在可用时来自任务持有的深度目标，因此在其生产者之前注册的叠加场景无需逐帧尺寸同步即可拥有有效尺寸。

对于后处理，在单采样纹理中计算 AO 和模糊，然后将最终合成结果写入叠加场景所使用的显式 MSAA 颜色目标。合成后再解析到屏幕。任何后续效果都必须写入同一条权威颜色链，而不是在旧的 MSAA 图像解析覆盖到 `scRT` 之前仅修改 `scRT`。不存在交换链回读、初始化着色器、隐式颜色拷贝或新的 WGSL。无论表面的默认采样数是多少，单采样叠加场景都可以直接以 `scRT` 为目标。

借用目标上的透射（transmission）必须使用 `enableRenderTaskTransmission(task, engine, { linear: false })` 和显式配置的线性/色调映射链。自动线性离屏重定向会拒绝借用目标，而不是替换其颜色目标。分段透射在第一段清除叠加场景的私有深度，并在恢复的段上加载它，与颜色加载独立。

透射源绑定会在抓取（grab）前立即从声明的颜色目标和有效深度目标刷新（当它们的 GPU 纹理发生变化时）。这支持在构建借用颜色生产者之前录制叠加场景，且在没有抓取的帧上不会重新绑定未更改的源或执行源刷新工作。`grabDepth: true` 会对 `config.depth ?? config.rt` 拍快照，匹配实际的通道附件，而非借用颜色目标可能不相关的深度。

深度抓取源跟踪、发布和资源生命周期完全属于惰性导入的深度抓取模块。选装任务预加载提供其工厂；每次录制都会从声明的深度目标创建一个私有深度控制器。透射调用可选的同步/录制/销毁钩子，而不保留深度抓取解释逻辑或模块级注册副作用。颜色 blit 尺寸调整在重建其绑定时直接读取源目标，而不是在缓存状态中复制目标尺寸。

迁移方式：分配预期的颜色目标，将其传递给 `createRenderTask`，并将 `{ rt, rst }` 传递给共享它的每个同级/嵌套叠加场景。可以安全地借用带有深度的生产者目标：叠加场景始终使用自己独立的深度。替换用的叠加任务本身必须指定 `clr: false` 和借用目标所有权。

#### 模块：叠加场景（overlay scene）

实现位于 `scene/overlay-scene.ts`；先前的 `swapchain-overlay.ts` 发现模块已被移除。注册分组和缺失祖先挂起仍为选装（opt-in）。叠加任务借用颜色和解析目标，拥有自己独立的深度，并使用普通的渲染任务执行路径。重点注册/附件测试覆盖显式后处理输出、独立深度、MSAA 表面上的单采样输出、实时视图替换、借用所有权及 API 验证。浏览器集成覆盖保留 1x 和 4x MSAA 下的嵌套层和文本排序。

### 渲染目标

引擎不再直接拥有逐帧颜色/深度渲染目标。渲染目标由已注册的渲染上下文拥有，主要是场景帧图 `RenderTask`。引擎拥有画布/交换链，并通过 `_swapchainView` 每帧一次暴露当前交换链视图。

渲染目标销毁拥有一条共享的附件分离路径。普通目标销毁其拥有的纹理；采样 RTT 则安装一个所有者回调来改为释放纹理引用。两条路径即使在释放抛出异常时也会清除附件句柄、视图和尺寸。没有所有者回调的急切包装器保持借用状态，不会被分离或销毁。
RTT 工厂在分配目标之前根据请求的格式选择颜色采样还是深度采样。分配过程无法更改该选择，因此仅深度调用者不会仅仅因为 GPU 分配接收了描述符就保留颜色外观和双线性采样器路径。

### 调整大小逻辑

`resizeEngine(engine)` 在**每一帧开始时**（在 rAF 回调内部）调用，而不是在 resize 事件中调用。它仅根据 **DOM 画布**的布局框自动调整大小：

```
if canvas is not an HTMLCanvasElement: return         // OffscreenCanvas → externally sized
w = canvas.clientWidth * devicePixelRatio | 0
h = canvas.clientHeight * devicePixelRatio | 0
setEngineSize(engine, w, h)                           // applies only if changed
```

`setEngineSize(engine, w, h)` 是共享的应用路径：

```
if w<=0 or h<=0: return
if (w == canvas.width && h == canvas.height) return
canvas.width = w; canvas.height = h;
for each registered context: context._resize?.()
```

与 0 按位或（`| 0`）用于截断为整数。

### 离屏 / Worker 渲染

`OffscreenCanvas` 没有布局框（`clientWidth`/`clientHeight`），也没有属性，因此：

- 跳过为它添加画布标签（`setAttribute("data-engine", …)`）。该标签在 `_buildSurface` 中应用，受 DOM 画布检查保护，因此 Babylon Lite 渲染到的每个 DOM 画布——引擎的主画布以及任何辅助 `createSurface` 画布——都带有该标签。
- `resizeEngine` 对它来说是**空操作** —— 可见画布位于另一个线程上。
- 宿主线程（拥有可见画布）测量 CSS 尺寸，乘以 `devicePixelRatio`，并将这些设备像素尺寸发送给 Worker，Worker 调用 `setEngineSize(engine, w, h)`。这既会设置后备存储，**又**会触发 `_resize()` 钩子，以便重建与画布尺寸相关的 GPU 资源。

其余一切（适配器/设备获取、`getContext("webgpu")`、rAF 渲染循环）完全相同 —— Chromium 中的专用 Worker 暴露了 `requestAnimationFrame`/`cancelAnimationFrame`。有关端到端的主线程对比 Worker 示例，请参阅 **Offscreen** 实验室演示（`lab/lite/src/demos/offscreen*.ts`）。

### 渲染循环

`startEngine(engine)` 返回一个 `Promise<void>`，在第一帧渲染完成后兑现。在调用之前注册的任何场景都会参与第一帧；之后注册的场景会在后续帧加入。

`waitForGpuIdle(engine)` 委托给 WebGPU 队列栅栏（queue fence），并在调用之前提交的所有命令完成后兑现。它不等待延迟的资源释放回调。它适用于不频繁的生命周期同步，而非稳态帧循环。

`waitForGpuResourceRetirements(engine)` 是独立的有序清理边界。先停止生产者并销毁场景/渲染任务消费者，然后等待此函数，再销毁它们的共享资源。它会让出当前同步帧，对未完成的退役批次拍快照，等待已提交的 GPU 工作完成，并同步认领这些精确批次。普通的延迟栅栏也可以认领批次，但其回调仅运行一次。在等待期间或由其他释放回调排队的退役请求会在后续带栅栏的批次中排空。新排队的批次绝不会针对更早的栅栏释放。GPU 栅栏失败会拒绝而不释放未加栅栏的资源；回调失败会被报告，同时仍尝试执行其余回调。该排空逻辑可 tree-shake，且不会引入额外的稳态帧调度。

退役使用者在首次排队释放时安装引擎的可选 `_flushGpuRetirements` 接缝。帧提交和停止仅调用该接缝；引擎创建不导入退役实现。`disposeEngine` 位于一个单独的模块中，使其同步排空逻辑不会将退役代码拉入从不排队退役的应用的初始 Vite chunk 中。未完成的带栅栏批次在 `Set` 中按标识跟踪，在为清理保留插入顺序的同时，允许栅栏回调或显式排空直接移除批次。每个批次在运行任何回调之前通过清空其回调数组来被认领。核心队列及其批处理辅助函数仅接受清理回调。特定特性的回调集合和带有 `destroy()` 的对象使用 `gpu-resource-disposal.ts`，该文件单独存放，以便普通渲染不保留异构销毁器分发逻辑。

```
registerScene(scene):
  adds scene as a RenderingContext

startEngine(engine):
  return new Promise(resolve => {
    renderFn = (now) => {
      resizeEngine(engine);
      deltaMs = now - prev
      renderFrame(engine, deltaMs);
      resolve()                  // first frame only
      prev = now
      animFrameId = requestAnimationFrame(renderFn);
    };
    animFrameId = requestAnimationFrame(renderFn);
  })

stopEngine(engine):
  cancelAnimationFrame(animFrameId);
  animFrameId = 0; renderFn = null;
```

场景在 `_update()` 步骤期间读取 `engine._currentDelta`。如果设置了 `scene.fixedDeltaMs`，场景将改用该值 —— 这对于确定性动画回放非常有用。

### 帧渲染（`renderFrame`）

当省略 `surfaces` 时，`renderFrame(engine, delta, surfaces?)` 按注册顺序渲染 `engine.surfaces` 中的每个表面。默认列表是实时的：如果早先的表面回调销毁了后续表面，其余帧和捕获循环将观察到缩短后的列表并跳过已销毁的表面。传入非空只读元组则会通过同一编码器和提交按调用者顺序精确渲染该固定子集。在创建编码器之前会验证显式元组的所有权；调用者必须提供已注册且唯一的表面，并在调用返回前保持其注册状态，以避免逐帧注册扫描或去重分配。当重复渲染单个表面时，请缓存单例元组以避免调用端逐帧分配。

`engine.drawCallCount` 记录最近一次已完成的 `renderFrame` 调用所发出的绘制调用次数，仅对其选定的表面求和。渲染回调继续观察上一已完成帧的值；一次成功的无上下文调用在返回前会将零发布到该字段。

每次调用包括以下步骤：

1. **预检选定表面**：验证引擎所有权并统计其渲染上下文数量。如果不存在任何上下文，则刷新挂起的资源退役请求并在不分配或提交空编码器的情况下返回。
2. **创建命令编码器**：`device.createCommandEncoder({ label: "frame" })` 并赋值给 `engine._currentEncoder`。
3. **准备每个选定表面**：运行其可选的截图帧前钩子，然后获取该表面当前的交换链纹理到 `surface.scRT`。
4. **更新/录制上下文**：对于每个选定表面，对每个已注册的 `RenderingContext` 先调用 `_update()`，再调用 `_record()`。
    - 场景的 `_update()` 运行渲染前回调、材质切换、阴影贴图、传统预通道和共享 uniform 更新器。
    - 场景的 `_record()` 委托给 `scene._frameGraph.execute()`。
    - 以 `scene.surface.scRT` 为目标的渲染任务会在打开通道前立即重新读取该表面的附件视图。它不得与仅标识主画布的 `engine.scRT` 进行比较，否则会导致辅助场景提交已过期的构建期交换链视图。
5. **录制截图拷贝**：每个带有排队请求的选定表面将其刚刚渲染的交换链纹理复制到一个暂存缓冲区。
6. **提交**：结束命令编码器并通过可复用的 `engine._cbs` 数组提交，以避免逐帧数组分配。

逐表面的附件刷新是必需的，因为 `GPUCanvasContext.getCurrentTexture()` 会随时间推移返回新的交换链纹理。复用帧图构建期间捕获的辅助表面视图会产生 WebGPU 验证错误；由于单个命令缓冲区包含每个表面的工作，该无效的辅助通道也会导致主画布的渲染被丢弃。

全表面帧和显式定位帧均使用相同的退役接缝和编码器生命周期。活动编码器会在 `finally` 中清除，包括当选定表面抛出异常时；部分录制的工作不会提交，且先前的绘制计数保持发布状态。没有渲染上下文的选择仍会通过选装接缝刷新挂起的退役请求。

### 延迟构建器执行

当调用 `registerScene(scene)` 时，场景会运行其延迟构建器、构建材质可渲染对象并重建其帧图。随后 `startEngine(engine)` 启动 rAF 循环，并在第一次 `renderFrame()` 调用完成后兑现。

交换链 MSAA/深度附件由默认场景 `RenderTask` 通过渲染目标辅助函数管理，而不是由引擎渲染循环本身管理。

### GPU 帧计时（可选，不使用时零开销）

`setGpuTimingEnabled(engine, true)` 将轻度平滑后的 **GPU** 时间间隔发布到 `engine.gpuFrameTimeMs`（毫秒）。该时间间隔从开场标记通道开始，到收尾标记通道结束，因此包含了该帧录制的所有命令以及两次单工作组标记调度。它不同于 CPU/墙钟时间，是一个经过插桩的性能分析值，而非不含标记的渲染/计算通道时长总和。该特性是一个开发者/HUD 辅助工具，默认禁用。

该特性的实现确保从不启用它的场景支付**零**成本 —— 繁重的计时器代码（`src/engine/gpu-timer.ts`）仅通过 `setGpuTimingEnabled` 内部的动态 `import()` 可达，而在未使用时该函数本身会被 tree-shake 移除。`renderFrame` 仅携带三个帧计时可选链短路判断，以及下文所述的独立任务计时解析短路判断；在对应分析器关闭时，它们全为空操作。唯一另外总是打包进来的成本是在 `createEngine` 中机会性地请求 `timestamp-query` 设备特性（运行时免费）以及一个单字段初始化器 —— 仅数个字节，保持在现有场景 bundle 上限之内。

启用时的工作原理如下：

1. 每当适配器提供 `timestamp-query` 特性时，`createEngine` 都会机会性地请求它（与纹理压缩特性一并请求），以便稍后随时开启计时。`isGpuTimingSupported(engine)` 报告该特性是否可用。
2. 首次调用 `setGpuTimingEnabled(engine, true)` 会动态导入 `gpu-timer.ts`，惰性创建一个 `GpuFrameTimer`（一个 2 槽 `timestamp` 查询集、一个无绑定计算管线以及可回收的 MAP_READ 回读缓冲区），并在引擎上安装三个逐帧钩子（`_gpuTimerBegin` / `_gpuTimerEnd` / `_gpuTimerResolve`）。
3. 每个帧标记都会使用随计时器一次性分配的管线，录制一个具有空着色器体（`@compute @workgroup_size(1) fn main() {}`）的计算工作组。开场通道在其开始处写入查询 0；收尾通道在其结束处写入查询 1。该管线在禁用/重新启用期间随计时器保留，没有缓冲区或绑定，也不需要显式的销毁方法。这两次标记调度是测量间隔的一部分；必须在目标设备上测量它们的开销。
4. `renderFrame` 在创建命令编码器后向其中录制开场标记，并在结束编码器前录制收尾标记。提交后，`_gpuTimerResolve` 录制查询解析和缓冲区拷贝，然后异步映射。5 秒以内的有效非负间隔会送入现有的指数平滑算法（首次正样本之后取 80% 上次值、20% 新值）。仅凭正时间戳并不能确立新鲜度或跨通道计时准确性；目标设备验证必须检查原始样本。

禁用会清除帧开始/结束钩子并将 `gpuFrameTimeMs` 重置为 0；除非任务计时仍独立启用，否则共享的解析钩子将变为空操作。帧计时器的 GPU 资源会被保留，并在重新启用时复用。

#### 标记开销实测数据与限制

该保留标记设计在 Windows 10、Chrome 151 以及 NVIDIA Blackwell 适配器上于预热提交后使用 1,000 对交错的 timestamp-query 进行了测量：

- 基线：单个计算通道内的一个无操作工作组，带开始/结束时间戳；
- 插桩：一个开场标记通道、同一个载荷通道以及一个收尾标记通道；
- 基线中位数 / p95 / 均值：`0.544 / 0.608 / 0.5392 µs`；
- 插桩中位数 / p95 / 均值：`0.544 / 0.576 / 0.4621 µs`。

实测中位数差值为 `0.000 µs`；p95 和均值差异小于时间戳噪声，不得解释为负开销。因此在该目标设备上，这两个标记通道没有增加可测量的 GPU 时间间隔，即使对于刻意极简的单工作组载荷也是如此。这仅是针对该适配器/驱动的实测证据，并非通用保证：基于分块（tile-based）及其他 GPU 架构可能会表现出不同的通道边界开销。跨设备比较亚微秒级工作负载的调用者必须考虑所记录的标记开销，且精确的任务/通道归因应使用独立的任务计时 API。

### GPU 渲染任务计时（可选，不使用时零开销）

`setRenderTaskGpuTimingEnabled(engine, true)` 启用逐帧图任务的 GPU 计时。它会立即返回一个快照（成功启用后为 `"pending"`），而 `getRenderTaskGpuTimings(engine)` 返回最新异步完成的帧结果：

```typescript
await setRenderTaskGpuTimingEnabled(engine, true);
// Later, after one or more rendered frames:
const timings = getRenderTaskGpuTimings(engine);
if (timings.status === "available") {
    for (const task of timings.tasks) {
        // task.name is the existing Task.name label ("shadow", "scene", "post-process", ...)
        console.log(task.index, task.name, task.durationMs);
    }
}
```

不支持的设备行为是显式的：如果 WebGPU 设备缺少 `timestamp-query`，`isRenderTaskGpuTimingSupported(engine)` 为 false，且启用和读取 API 均返回 `status: "unsupported"` 及空 `tasks` 数组。

Bundle 体积保护与截图捕获和帧计时保持一致：

1. 仅当适配器提供 `timestamp-query` 时，`createEngine` 才机会性地请求它。
2. 公共 API 位于一个薄模块（`engine/gpu-task-timing.ts`）中。timestamp-query 实现（`engine/gpu-task-timer.ts`）仅通过 `setRenderTaskGpuTimingEnabled` 内部的动态导入可达。
3. 非用户不会拉取分析器 chunk，且在常加载的帧图模块中不携带任何任务分析代码。启用时，动态分析器会包装当前已注册帧图的 `execute()` 函数，以及新推入的表面/上下文，因此仅当明确启用分析时才会写入时间戳通道。

启用时，在新帧编码器中看到的第一个计时任务会清空当前记录列表。动态帧图包装器在每个 `Task` 执行前后写入一个带时间戳的空计算通道。在 `renderFrame` 提交帧命令缓冲区后，一个共享解析钩子会优先调度帧计时（若启用），其次调度任务计时。当帧计时关闭时，任务计时直接拥有该钩子，因此当两者同时启用时，任一分析器都能独立工作且不会重复解析。任务分析器通过一个小型后续命令缓冲区解析/复制已使用的查询槽位，然后异步映射一个回收的回读缓冲区。结果滞后一帧或多帧，并包含现有的 `Task.name` 标签加上执行顺序 `index` 以消除重复名称的歧义。如果超过固定的查询容量，超出的任务将正常执行，`droppedTaskCount` 会报告未计时的任务数。

禁用任务计时会销毁其查询集、解析缓冲区、池化回读缓冲区以及任何挂起的回读缓冲区。禁用后才落定的回读会被忽略，重新启用会创建一个全新的任务计时器。这与上述帧计时器刻意不同，后者会保留其较小的资源集以供复用。

## 状态机 / 生命周期

```
[Created] --registerScene(scene)--> [Context registered + frame graph built]
          --startEngine(engine)-----------> [Running (rAF loop)]
                                                          |
                                                      resizeEngine(engine) each frame
                                                      _beforeRender(deltaMs) each frame
                                                      renderFrame() each frame
                                                          |
                                          --stopEngine(engine)----> [Stopped]
                                                          |
                                           --startEngine(engine)----------> [Running]
```

## Babylon.js 等价映射

| Babylon Lite | Babylon.js |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createEngine(canvas)` | `new BABYLON.WebGPUEngine(canvas)` + `engine.initAsync()` |
| `engine._device` | `engine._device` |
| `engine.format` | `engine._textureHelper._glslang.getPreferredFormat()` |
| `engine.msaaSamples` (1 或 4) | `engine._samples` |
| `registerScene(scene)` + `startEngine(engine)` | `engine.runRenderLoop(() => scene.render())` —— 同时也类似于 `scene.whenReadyAsync()`，因为返回的 Promise 在第一帧后兑现 |
| `waitForGpuIdle(engine)` | `engine._device.queue.onSubmittedWorkDone()` |
| `stopEngine(engine)` | `engine.stopRenderLoop()` |
| `resizeEngine(engine)` | `engine.resize()` |
| 已注册的 `RenderingContext` | 引擎渲染循环回调 |
| 场景帧图执行 | 场景渲染图 / 渲染管理器 |
| `_update()` 中的 `scene._prePasses` | `scene.onBeforeRenderObservable` + 阴影预处理 |
| `scene._frameGraph.execute()` | 内部绘制列表调度 |

## 依赖项

- **排序辅助函数**：对 `RenderingContext` 和 `SurfaceContext` 的仅类型导入。
- **实用层叠加钩子**：引擎和场景类型、排序辅助函数，以及场景叠加注册/配置接缝。
- **外部**：WebGPU API（`navigator.gpu`、`GPUDevice`、`GPUCanvasContext` 等）。

## 测试规范

| 测试 | 描述 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `createEngine returns valid Engine` | 模拟 `navigator.gpu`，验证所有接口字段已填充 |
| `resize only recreates targets when size changes` | 使用相同尺寸调用 resize → 目标未变；更改 `clientWidth` → 重建目标 |
| `start/stop manages rAF` | 验证启动时调用 `requestAnimationFrame`，停止时调用 `cancelAnimationFrame` |
| `waitForGpuIdle returns the queue fence` | 验证调用一次 `onSubmittedWorkDone()` 并返回其精确的 Promise |
| `renderFrame calls scene callbacks` | 验证 预通道 → 更新器 → 可渲染对象 的执行顺序 |
| `rendering-context query is live and readonly` | 验证稳定的数组标识、注册顺序更新以及公共类型判别器 |
| `rendering-context ordering` | 验证钳制移动、未注册上下文以及稳定的实用层分组与生命周期 |
| `MSAA resolve target is swap chain view` | 检查渲染通道描述符中的颜色附件 `resolveTarget` |
| `depth format is depth24plus-stencil8` | 验证 `depthTexture.format` |

## 文件清单

| 文件 | 大小 | 职责 |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `src/engine/engine.ts` | ~150 行 | 引擎接口、创建、渲染循环、MSAA 目标 |
| `src/engine/rendering-context-order.ts` | ~20 行 | 针对表面渲染上下文注册表的可 tree-shake 移动操作 |
| `src/scene/overlay-scene.ts` | ~110 行 | 选装 `createOverlayScene`、已安装的注册接缝以及连续排序 |
| `src/engine/engine-dispose.ts` | ~25 行 | 显式引擎销毁和同步资源退役排空 |
| `src/engine/gpu-resource-retirement.ts` | ~110 行 | 延迟退役、恰好一次批次所有权以及可等待销毁 |
| `src/engine/gpu-timer.ts` | ~110 行 | 可选 GPU 帧时间测量（由 `setGpuTimingEnabled` 动态导入；不使用时零开销） |
| `src/engine/gpu-task-timing.ts` | ~120 行 | 轻量公共逐任务计时 API；仅在启用时动态导入分析器实现 |
| `src/engine/gpu-task-timer.ts` | ~150 行 | 逐帧图任务 GPU 计时的可选 timestamp-query 实现 |
