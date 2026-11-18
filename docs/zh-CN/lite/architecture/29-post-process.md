# 模块：帧图后处理（Frame-Graph Post-Process）

> 包路径：`packages/babylon-lite/src/frame-graph/`、`packages/babylon-lite/src/post-process/`

## 目的

帧图后处理任务在源渲染目标的颜色纹理上运行全屏 WGSL 片段通道，并将结果写入调用方提供的渲染目标或任务内部拥有的渲染目标。该辅助工具特意设计得比 Babylon.js 的 `FrameGraphPostProcessTask` 更精简：它没有 `ThinPostProcess`、没有着色器存储查找、没有效果抽象，公共 API 中也没有原始 WebGPU 句柄。

之所以提取这个可复用辅助工具，是因为大多数后处理都共享相同的结构：

- 一个源颜色纹理；
- 一个由 `sourceSamplingMode` 选择的采样器；
- 一个可选的 uniform 块；
- 一个全屏三角形；
- 一个颜色输出目标；
- 可选的 Alpha 混合以及归一化视口/裁剪区域（scissor）。

网格混合（Mesh blending）特意实现为专用任务，而不是通过 `createPostProcessTask` 实现：它的标签输入是 `texture_2d<u32>`，每个输入都使用精确的 `textureLoad`，它拥有确定性的 `rg8unorm` 蓝噪声，并且其质量/调试/基础色选项会特化一个大型着色器。该专用模块保持完全可 tree-shake，并遵循相同的源/目标、视口、清除、Alpha 模式、设备重建和自有内部目标约定。完整契约见 `55-mesh-blending.md`。

公共的[自定义后处理适配器](custom-post-process.md)为应用级 WGSL、额外颜色输入和显式 uniform 更新暴露了这条基于 RenderTarget 的全屏路径。内置任务工厂则保留其现有实现和打包开销。

## 公共 API 接口（类型、函数、常量——完整签名）

```ts
export type PostProcessSamplingMode = "nearest" | "linear";
export type PostProcessAlphaMode = 0 | 1 | 2 | 7;

export interface PostProcessShaderConfig {
    fragmentWGSL: string;
    uniformWGSL?: string;
    uniformByteLength?: number;
    uniformBinding?: number;
    writeUniforms?: (data: Float32Array) => void;
    extraTextureWGSL?: string;
    extraTextures?: readonly RenderTarget[];
}

export interface PostProcessTaskSettings {
    name?: string;
    sourceTexture: RenderTarget;
    sourceSamplingMode?: PostProcessSamplingMode;
    targetTexture?: RenderTarget | null;
    alphaMode?: PostProcessAlphaMode;
    viewport?: NormalizedViewport | null;
    clear?: boolean;
}

export interface PostProcessTaskConfig extends PostProcessTaskSettings {
    _shader: PostProcessShaderConfig;
}

export interface PostProcessTask extends Task, PostProcessTaskSettings {
    readonly name: string;
    sourceSamplingMode: PostProcessSamplingMode;
    targetTexture: RenderTarget | null;
    alphaMode: PostProcessAlphaMode;
    viewport: NormalizedViewport | null;
    outputTexture: RenderTarget;
    updateUniforms(): void;
}

export function createPostProcessTask(config: PostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): PostProcessTask;

export interface BlackAndWhitePostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    degree?: number;
}

export interface BlackAndWhitePostProcessTask extends PostProcessTask {
    degree: number;
}

export function createBlackAndWhitePostProcessTask(config: BlackAndWhitePostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): BlackAndWhitePostProcessTask;

export interface AnaglyphPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    leftTexture: RenderTarget;
}

export function createAnaglyphPostProcessTask(config: AnaglyphPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): PostProcessTask;

export interface BlurPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    direction?: { x: number; y: number };
    kernel?: number;
}

export interface BlurPostProcessTask extends PostProcessTask {
    direction: { x: number; y: number };
    kernel: number;
}

export function createBlurPostProcessTask(config: BlurPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): BlurPostProcessTask;

export interface ExtractHighlightsPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    threshold?: number;
    exposure?: number;
}

export interface ExtractHighlightsPostProcessTask extends PostProcessTask {
    threshold: number;
    exposure: number;
}

export function createExtractHighlightsPostProcessTask(
    config: ExtractHighlightsPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ExtractHighlightsPostProcessTask;

export interface ChromaticAberrationPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    aberrationAmount?: number;
    direction?: { x: number; y: number };
    radialIntensity?: number;
    centerPosition?: { x: number; y: number };
}

export interface ChromaticAberrationPostProcessTask extends PostProcessTask {
    aberrationAmount: number;
    direction: { x: number; y: number };
    radialIntensity: number;
    centerPosition: { x: number; y: number };
}

export function createChromaticAberrationPostProcessTask(
    config: ChromaticAberrationPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ChromaticAberrationPostProcessTask;

export interface BloomPostProcessTaskConfig extends PostProcessTaskSettings {
    weight?: number;
    kernel?: number;
    threshold?: number;
    exposure?: number;
    bloomScale?: number;
}

export interface BloomPostProcessTask extends Task, PostProcessTaskSettings {
    readonly name: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    weight: number;
    kernel: number;
    threshold: number;
    exposure: number;
    readonly bloomScale: number;
    updateUniforms(): void;
}

export function createBloomPostProcessTask(config: BloomPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): BloomPostProcessTask;

export enum MeshBlendQuality {
    Low = 0,
    Medium = 1,
    High = 2,
    Cinematic = 3,
}

export enum MeshBlendDepthType {
    View = 0,
    Screen = 1,
}

export enum MeshBlendDebugMode {
    Off = 0,
    PackedTag = 1,
    CandidateDirectionDistance = 2,
    SeamFade = 3,
    RejectionReason = 4,
    StageWork = 5,
    Continuation = 6,
    TinyObject = 7,
    MultiTarget = 8,
    TargetColor = 9,
    ShadowAttenuation = 10,
    ColorInterpolation = 11,
    WorldPosition = 12,
}

export interface MeshBlendingPostProcessTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    meshBlendTagTexture: RenderTarget;
    depthTexture: RenderTarget;
    baseColorTexture?: RenderTarget | null;
    targetTexture?: RenderTarget | null;
    camera: Camera;
    quality?: MeshBlendQuality;
    depthType?: MeshBlendDepthType;
    debugMode?: MeshBlendDebugMode;
    radiusClasses?: readonly MeshBlendRadiusDefinition[];
    slopeFactor?: number;
    enabled?: boolean;
    alphaMode?: PostProcessAlphaMode;
    viewport?: NormalizedViewport | null;
    clear?: boolean;
}

export function createMeshBlendingPostProcessTask(config: MeshBlendingPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): MeshBlendingPostProcessTask;

export interface FrameGraphContextOptions {
    name?: string;
    clearColor?: GPUColorDict;
    update?: (deltaMs: number) => void;
}

export interface FrameGraphContext extends RenderingContext {
    readonly name: string;
    readonly engine: EngineContext;
    readonly frameGraph: FrameGraph;
    clearColor: GPUColorDict;
}

export function createFrameGraphContext(engine: EngineContext, options?: FrameGraphContextOptions): FrameGraphContext;
export function registerFrameGraphContext(ctx: FrameGraphContext): void;
export function unregisterFrameGraphContext(ctx: FrameGraphContext): void;
export function disposeFrameGraphContext(ctx: FrameGraphContext): void;
```

`PostProcessShaderConfig` 和 `PostProcessTaskConfig` 是面向具体后处理工厂实现的类型；`_shader` 故意设为内部字段，并从公共的具体后处理配置中省略。

`PostProcessTask` 保留了 Babylon.js 的属性名称：`sourceTexture`、`sourceSamplingMode`、`targetTexture`、`alphaMode`、`viewport` 和 `outputTexture`。该契约以 `RenderTarget` 为中心，因为 Lite 的公共 `Texture2D` 包装器没有携带足够用于创建同格式/同尺寸渲染目标的附件元数据。`updateUniforms()` 是当调用方修改暴露出来的参数（例如 `BlackAndWhitePostProcessTask.degree`）时，具体后处理使用的共享显式钩子。

## 内部架构（数据结构、内存布局）

`createPostProcessTask` 返回一个普通任务记录，对导出接口隐藏内部槽位：

- `_internalTarget`：当 `targetTexture` 为 `null` 时使用的渲染目标；
- `_pipeline`：对应当前目标格式/采样数/Alpha 模式的单个渲染管线；
- `_bindGroup`：源纹理 + 采样器 + 可选 uniform 缓冲区 + 可选额外纹理；
- `_uniformBuffer`：按 `_shader.uniformByteLength` 确定大小的可选 uniform 缓冲区；
- `_renderPassDescriptor` 和 `_colorAttachment`：缓存的渲染通道状态，每帧为交换链目标进行修补；
- `_shaderModule`：将辅助顶点阶段、源绑定、可选 uniform 声明、用户 `fragmentWGSL` 以及生成的片段入口点组合在一起的 WGSL 模块。

该辅助工具不创建任何模块级缓存。管线状态属于任务本身，并在源生产方分配好源纹理且目标分配好之后，在 `record()` 期间重建。

Uniform 内存由调用方定义。如果设置了 `uniformByteLength`，它会向上对齐到 16 字节的倍数，创建一个该大小的 `Float32Array` 暂存缓冲区，并在 `record()` 期间以及每次调用 `updateUniforms()` 时由 `writeUniforms(data)` 填充。Uniform 字节默认位于绑定槽 `2 + extraTextures.length`，当具体任务需要显式槽位时，则位于 `_shader.uniformBinding`。额外纹理是面向实现的 `RenderTarget`，与 `_shader.extraTextureWGSL` 声明配对；立体红蓝滤镜（anaglyph）绑定左眼纹理，泛光（bloom）合并阶段绑定模糊后的高光纹理。

## 管线配置（顶点/片段阶段、绑定组、深度/模板）

管线：

- 拓扑：`triangle-list`；
- 绘制顶点数量：`3`；
- 顶点缓冲区：无；
- 深度/模板：无；
- 多重采样数：`outputTexture._descriptor.sampleCount`；
- 颜色格式：`outputTexture._descriptor.colorFormat`；
- 混合（blend）：由 `alphaMode` 推导。

绑定组 `0`：

| 绑定槽                                                 | 资源                                      | 可见性   |
| ------------------------------------------------------ | ----------------------------------------- | -------- |
| `0`                                                    | 源采样器（`nearest` 或 `linear`）         | fragment |
| `1`                                                    | 源颜色纹理（`texture_2d<f32>`）           | fragment |
| `2+`                                                   | 可选额外纹理（`texture_2d<f32>`）         | fragment |
| `2 + extraTextures.length` 或 `_shader.uniformBinding` | 可选 uniform 缓冲区                       | fragment |

`alphaMode` 映射遵循节点材质管线所使用的现有 Lite/Babylon.js 数值模式：

- `0`：不透明/无混合；
- `1`：叠加（`src-alpha`、`one`）；
- `2`：标准合并（`src-alpha`、`one-minus-src-alpha`）；
- `7`：预乘（`one`、`one-minus-src-alpha`）。

当存在 `viewport` 时，它与相机视口一样经过归一化，并遵循 Babylon 的左下角原点约定。它会根据输出目标尺寸转换为像素视口和裁剪矩形。`clear` 控制颜色附件的加载操作并默认为 `true`；多视口示例通过仅清除第一个任务来将多个后处理任务渲染到同一个目标中。

## 着色器逻辑（WGSL 轮廓或含精确数学的伪代码）

辅助工具拥有顶点阶段和片段包装器：

```wgsl
struct PostProcessVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn postProcessVertex(@builtin(vertex_index) vertexIndex: u32) -> PostProcessVertexOutput {
    var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    let p = positions[vertexIndex];
    var out: PostProcessVertexOutput;
    out.position = vec4f(p, 0.0, 1.0);
    // V is flipped: clip space is +Y up, texture space is +Y down.
    out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
    return out;
}

@group(0) @binding(0) var sourceSampler: sampler;
@group(0) @binding(1) var sourceTextureSampler: texture_2d<f32>;

fn samplePostProcessSource(uv: vec2f) -> vec4f {
    return textureSample(sourceTextureSampler, sourceSampler, uv);
}

// Texel-snapped read. Takes a NORMALIZED uv, like samplePostProcessSource —
// not a pixel coordinate — and clamps to the texel centres so a snapped fetch
// cannot bleed outside the source.
fn readPostProcessSource(uv: vec2f) -> vec4f {
    let dims = vec2f(textureDimensions(sourceTextureSampler));
    let p = clamp(floor(uv * dims) + vec2f(0.5), vec2f(0.5), dims - vec2f(0.5));
    return textureSampleLevel(sourceTextureSampler, sourceSampler, p / dims, 0);
}

// user fragmentWGSL must define:
fn applyPostProcess(color: vec4f, uv: vec2f) -> vec4f;

@fragment
fn postProcessFragment(input: PostProcessVertexOutput) -> @location(0) vec4f {
    return applyPostProcess(samplePostProcessSource(input.uv), input.uv);
}
```

黑白任务声明了一个 uniform 程度参数，并使用 Babylon.js 的着色器数学公式：

```wgsl
let luminance = dot(color.rgb, vec3f(0.3, 0.59, 0.11));
let grayscale = vec3f(luminance);
return vec4f(mix(color.rgb, grayscale, clamp(params.degree, 0.0, 1.0)), color.a);
```

当前的具体后处理效果镜像了对应的 Babylon.js 精简后处理着色器数学：

- 黑白（black-and-white）按 `degree` 将源颜色与亮度混合；
- 立体红蓝（anaglyph）采样配置的左眼纹理与源/右眼纹理，并合并红/青通道；
- 模糊（blur）将 Babylon 风格的优化高斯偏移/权重写入 uniform，并沿 `direction / textureDimensions(source)` 采样；
- 提取高光（extract-highlights）保留经曝光缩放后的亮度高于 `threshold^(1/2.2)` 的源像素，并将其他像素置黑；
- 色差（chromatic aberration）使用 `aberrationAmount`、`direction`、`radialIntensity`、`centerPosition` 以及在 `record()` 期间捕获的源纹理尺寸应用 Babylon 径向通道偏移。
- 泛光（bloom）是一个复合任务，每次录制和执行四个内部后处理通道：可复用的高光提取、水平高斯模糊、垂直高斯模糊以及合并（`source.rgb + blurred.rgb * weight`）。每次录制时，其内部提取/模糊渲染目标尺寸设为 `floor(sourceSize * bloomScale)`，其 `kernel` setter 会按 `bloomScale` 缩放内部模糊核大小，与 Babylon.js 帧图泛光一致。

## 状态机 / 生命周期

1. 调用方创建一个生产方，其目标拥有一个单采样颜色纹理。生产方可以是场景 `RenderTask`、`EffectRenderTask` 或任何自定义任务。
2. 场景管线如常使用场景的帧图。无场景管线则创建 `const ctx = createFrameGraphContext(engine, { update })`；该更新回调每帧在图执行前运行一次，是更新效果 uniform 的恰当位置。
3. 调用方创建后处理任务，将 `sourceTexture` 设为生产方目标。如果省略 `targetTexture`，任务会使用源描述符的格式、采样数和尺寸创建一个内部纯颜色目标。如果后处理写入画布，请使用 `resolveToSwapchain: true` 的目标。
4. 调用方使用 `addTask(sceneOrFrameGraph, producer)`、`addTask(sceneOrFrameGraph, postProcess)` 及后续消费/输出任务按顺序调度任务。
5. 无场景图通过 `registerFrameGraphContext(ctx)` 启动，它会构建 `ctx.frameGraph` 并将渲染上下文注册到引擎。后续画布尺寸调整会通过上下文的 `_resize` 钩子重建图。
6. `FrameGraph.build()` 先调用生产方的 `record()`，分配源纹理资源。
7. 后处理的 `record()` 验证源颜色纹理，分配/重建输出目标，创建管线、绑定组和可选 uniform 缓冲区，初始化 uniform，并且因为任务直接执行而不录制单独的 `Pass`。
8. 如果调用方在录制后修改了暴露的后处理参数，需在下次绘制前调用 `updateUniforms()` 以重写任务 UBO。
9. 每一帧，`execute()` 在需要时修补交换链附件，按请求应用视口/裁剪区域，绑定管线/绑定组，并绘制一个全屏三角形。
10. `dispose()` 销毁可选的 uniform 缓冲区，并仅销毁内部拥有的目标。调用方拥有的 `sourceTexture` 和 `targetTexture` 的生命周期仍归其各自所有者管理。`disposeFrameGraphContext(ctx)` 注销无场景图并销毁其中的所有任务；重复销毁为空操作。

## Babylon.js 对照表

| Babylon.js                                                                 | Babylon Lite                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `FrameGraphPostProcessTask`                                                | `PostProcessTask` 普通任务记录                          |
| `sourceTexture` 句柄                                                       | 带有可采样颜色附件的 `RenderTarget` 源                  |
| `targetTexture` 句柄                                                       | 可选 `RenderTarget` 输出                                |
| 自动创建的输出纹理                                                         | 从源描述符复制的内部 `RenderTarget`                     |
| `sourceSamplingMode`                                                       | `"nearest"` / `"linear"` 采样器选择                     |
| `alphaMode`                                                                | 映射到 WebGPU 混合状态的数值模式 `0`、`1`、`2`、`7`     |
| `viewport`                                                                 | 输出通道上的归一化视口/裁剪区域                         |
| `ThinPostProcess`                                                          | 不存在；着色器配置为直接 WGSL                           |
| `FrameGraphBlackAndWhiteTask`                                              | `createBlackAndWhitePostProcessTask`                    |
| `FrameGraphAnaglyphTask` / `ThinAnaglyphPostProcess`                       | `createAnaglyphPostProcessTask`                         |
| `FrameGraphBlurTask` / `ThinBlurPostProcess`                               | `createBlurPostProcessTask`                             |
| `FrameGraphExtractHighlightsTask` / `ThinExtractHighlightsPostProcess`     | `createExtractHighlightsPostProcessTask`                |
| `FrameGraphChromaticAberrationTask` / `ThinChromaticAberrationPostProcess` | `createChromaticAberrationPostProcessTask`              |
| `FrameGraphBloomTask` / `BloomEffect`                                      | `createBloomPostProcessTask`                            |

## 依赖关系

- `engine/engine.ts`：用于内部设备/编码器/交换链状态；
- `engine/render-target.ts`：用于源/输出目标分配和销毁；
- `resource/samplers.ts`：用于共享最近邻/线性采样器；
- `scene/scene-core.ts`：仅用于场景拥有的帧图；独立帧图上下文避免运行时场景导入；
- `camera/camera.ts`：仅用于公共 `NormalizedViewport` 类型。

## 测试规范

- 场景 142 将一个确定性的彩色网格场景渲染到离屏 `RenderTarget` 中，然后分别在四个视口象限中写入黑白、立体红蓝、128px 模糊和色差效果。Babylon.js 参考实现使用对应的 Babylon 后处理类。
- 场景 143 让 Sponza 依次经过两个 16px 模糊任务（先 `direction=(1,0)` 再 `direction=(0,1)`）和色差任务，演示通过内部创建的中间目标进行的后处理流水线。Babylon.js 参考实现使用对应的挂载在相机上的 Babylon 后处理类。
- 场景 144 渲染来自 Babylon.js Playground `#SUEU9U#114` 的 Tarisland 龙资产，将 `Qishilong_attack01` 冻结在第 180 帧，并运行权重 `2`、阈值 `0.1`、核大小 `64` 和泛光缩放 `0.5` 的复合泛光后处理。Babylon.js 参考实现通过 `PostProcessRenderPipeline` 使用 `BloomEffect`。
- 一致性测试规范 `tests/lite/parity/scenes/scene142-black-and-white-post-process.spec.ts` 捕获/使用 `reference/lite/scene142-post-process-viewports/babylon-ref-golden.png` 并将 Lite 输出与 `scene-config.json` 进行比较。
- 一致性测试规范 `tests/lite/parity/scenes/scene143-pipelined-post-processes.spec.ts` 捕获/使用 `reference/lite/scene143-pipelined-post-processes/babylon-ref-golden.png` 并将 Lite 输出与 `scene-config.json` 进行比较。
- 一致性测试规范 `tests/lite/parity/scenes/scene144-bloom-post-process.spec.ts` 捕获/使用 `reference/lite/scene144-bloom-post-process/babylon-ref-golden.png` 并将 Lite 输出与 `scene-config.json` 进行比较。
- 打包体积覆盖为场景 142、场景 143 和场景 144 添加体积上限条目，同时不改变现有上限。

## 文件清单

- `packages/babylon-lite/src/frame-graph/post-process-task.ts`
- `packages/babylon-lite/src/post-process/black-and-white.ts`
- `packages/babylon-lite/src/post-process/anaglyph.ts`
- `packages/babylon-lite/src/post-process/blur.ts`
- `packages/babylon-lite/src/post-process/extract-highlights.ts`
- `packages/babylon-lite/src/post-process/chromatic-aberration.ts`
- `packages/babylon-lite/src/post-process/bloom.ts`
- `docs/lite/architecture/29-post-process.md`
- `lab/lite/src/bjs/scene142.ts`
- `lab/lite/src/lite/scene142.ts`
- `lab/lite/src/bjs/scene143.ts`
- `lab/lite/src/lite/scene143.ts`
- `lab/lite/src/bjs/scene144.ts`
- `lab/lite/src/lite/scene144.ts`
- `lab/lite/babylon-ref-scene142.html`
- `lab/lite/scene142.html`
- `lab/lite/babylon-ref-scene143.html`
- `lab/lite/scene143.html`
- `lab/lite/babylon-ref-scene144.html`
- `lab/lite/scene144.html`
- `tests/lite/parity/scenes/scene142-black-and-white-post-process.spec.ts`
- `tests/lite/parity/scenes/scene143-pipelined-post-processes.spec.ts`
- `tests/lite/parity/scenes/scene144-bloom-post-process.spec.ts`
