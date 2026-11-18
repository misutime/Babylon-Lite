# 模块：效果渲染器（Effect Renderer）

> 包路径：`packages/babylon-lite/src/effect/`

## 目的

效果渲染器模块为全屏着色器工作提供了 Babylon.js `EffectRenderer` / `EffectWrapper` 的 Lite 原生等价实现。它有意采用 WebGPU/WGSL 优先设计，并将最简单的交换链路径保持在场景帧图之外：

- 效果是纯状态的包装器句柄；
- 行为通过独立函数暴露；
- uniform、纹理和采样器通过 `EffectBindingLayout` 显式声明；
- 全屏几何体是由 `@builtin(vertex_index)` 生成的标准单个三角形；
- 仅面向交换链的效果直接注册为引擎渲染上下文，因此不需要 `SceneContext` 或默认场景 `RenderTask`；
- 离屏渲染到纹理（RTT）效果作为 `Task` 调度在现有的场景 `FrameGraph` 中；
- 当全屏着色器只需要一个 uniform 缓冲区且不需要纹理或采样器时，仅含 uniform 的离屏效果可以使用更精简的 `UniformEffectWrapper` 路径；
- 帧图任务的目标是现有的 `RenderTarget`；
- 面向用户的资源始终是 Lite 句柄（`Texture2D`、`RenderTarget`），绝不暴露原始 WebGPU 句柄。

该模块适用于后处理、程序化全屏通道、渲染到纹理效果、拷贝/位块传输（blit）工具，以及在未来替代临时全屏通道。

## 公共 API 接口（类型、函数、常量——完整签名）

```ts
export type EffectBindingKind = "uniform" | "texture" | "sampler";

export interface EffectBindingLayout {
    name?: string;
    binding: number;
    kind: EffectBindingKind;
    visibility?: GPUShaderStageFlags;
    uniformByteLength?: number;
    textureSampleType?: GPUTextureSampleType;
    samplerType?: GPUSamplerBindingType;
    textureBinding?: string | number;
}

export interface EffectWrapperOptions {
    name?: string;
    fragmentWGSL: string;
    vertexWGSL?: string;
    bindings?: EffectBindingLayout[];
    blend?: GPUBlendState;
}

export interface EffectWrapper {
    readonly name: string;
    readonly options: EffectWrapperOptions;
}

// ─── Direct swapchain renderer (no SceneContext / frame graph) ───────

export interface EffectRendererOptions {
    name?: string;
    clear?: boolean;
    clearColor?: GPUColorDict;
}

export interface EffectRenderer extends RenderingContext {
    readonly name: string;
}

export function createEffectRenderer(engine: EngineContext, effect: EffectWrapper, options?: EffectRendererOptions): EffectRenderer;
export function registerEffectRenderer(er: EffectRenderer): void;
export function unregisterEffectRenderer(er: EffectRenderer): void;
export function disposeEffectRenderer(er: EffectRenderer): void;

// ─── Frame-graph task (use for offscreen RTT workflows) ──────────────

export interface EffectRenderTaskConfig {
    name: string;
    effect: EffectWrapper;
    target: RenderTarget;
    clear?: boolean;
    clearColor?: GPUColorDict;
}

export interface EffectRenderTask extends Task {
    readonly name: string;
    /** Optional draw region, normalized to the target, origin bottom-left (the `NormalizedViewport` convention). */
    scissor?: NormalizedViewport | null;
    readonly _config: EffectRenderTaskConfig;
    readonly _rt: RenderTarget;
}

export function createEffectWrapper(engine: EngineContext, options: EffectWrapperOptions): EffectWrapper;
export function setEffectUniforms(wrapper: EffectWrapper, data: ArrayBuffer | ArrayBufferView | Record<string | number, ArrayBuffer | ArrayBufferView>): void;
export function setEffectTexture(wrapper: EffectWrapper, bindingNameOrIndex: string | number, texture: Texture2D): void;
export function createEffectRenderTask(config: EffectRenderTaskConfig, engine: EngineContext, scene: SceneContext): EffectRenderTask;
export function disposeEffectWrapper(wrapper: EffectWrapper): void;

// ─── Uniform-only frame-graph task (smaller bundle path) ─────────────

export interface UniformEffectWrapperOptions {
    name?: string;
    fragmentWGSL: string;
    vertexWGSL?: string;
    uniformByteLength: number;
}

export interface UniformEffectWrapper {
    readonly name: string;
    readonly options: UniformEffectWrapperOptions;
}

export interface UniformEffectRenderTaskConfig {
    name: string;
    effect: UniformEffectWrapper;
    target: RenderTarget;
    clear?: boolean;
    clearColor?: GPUColorDict;
}

export interface UniformEffectRenderTask extends Task {
    readonly name: string;
    readonly _config: UniformEffectRenderTaskConfig;
    readonly _rt: RenderTarget;
}

export function createUniformEffectWrapper(engine: EngineContext, options: UniformEffectWrapperOptions): UniformEffectWrapper;
export function setUniformEffectUniforms(wrapper: UniformEffectWrapper, data: ArrayBuffer | ArrayBufferView): void;
export function createUniformEffectRenderTask(config: UniformEffectRenderTaskConfig, engine: EngineContext, scene?: SceneContext): UniformEffectRenderTask;
export function disposeUniformEffectWrapper(wrapper: UniformEffectWrapper): void;
```

## 内部架构（数据结构、内存布局）

`EffectWrapper` 是一个普通的公共状态对象，其内部槽位对导出类型隐藏。在内部，它拥有：

- 一个组合后的 WGSL 着色器模块（`vertexWGSL + fragmentWGSL`）；
- 一个由显式 `EffectBindingLayout[]` 推导出的绑定组布局；
- 一个管线布局；
- 一个惰性的逐包装器管线缓存，以 `targetSignatureKey(RenderTargetSignature)` 为键；
- 按绑定编号/名称索引的 uniform 槽位；
- 按绑定编号/名称索引的纹理槽位；
- 一个缓存的绑定组，在 uniform/纹理变化时重建。

不使用任何模块级 `Map`、`WeakMap` 或 `Set` 分配。管线缓存保存在包装器上并惰性创建。

Uniform 数据被复制到包装器拥有的 uniform 缓冲区中。`setEffectUniforms(wrapper, data)` 支持：

- 单个 `ArrayBuffer` / 类型化数组载荷，写入第一个 uniform 绑定；
- 以绑定名称或数字绑定索引为键的记录对象，写入匹配的 uniform 绑定。

`setEffectTexture(wrapper, bindingNameOrIndex, texture)` 将 `Texture2D` 句柄存储在纹理绑定上。采样器绑定使用以下之一：

1. 由 `textureBinding` 指定的纹理（如果已提供）；
2. 否则使用第一个纹理槽位。

这允许支持常见的 `texture + sampler` 配对，而无需在公共 API 中暴露 `GPUTextureView` 或 `GPUSampler`。

`UniformEffectWrapper` 是针对最小仅含 uniform 情况特化的相同全屏三角形效果形态：它创建一个位于 group 0 / binding 0 的 uniform 缓冲区、一个绑定组布局、一个绑定组以及一个渲染任务。它特意省略了纹理/采样器绑定发现、混合配置、直接交换链渲染和多 uniform 查找，从而使简单的程序化帧图示例无需为通用 `EffectWrapper` 绑定机制付出体积代价。

## 管线配置（顶点/片段阶段、绑定组、深度/模板）

默认顶点阶段：

```wgsl
struct EffectVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn effectFullscreenVertex(@builtin(vertex_index) vertexIndex: u32) -> EffectVertexOutput {
    var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    let p = positions[vertexIndex];
    var out: EffectVertexOutput;
    out.position = vec4<f32>(p, 0.0, 1.0);
    out.uv = p * 0.5 + vec2<f32>(0.5, 0.5);
    return out;
}
```

管线状态：

- 拓扑：`triangle-list`；
- 绘制顶点数：`3`；
- 无顶点/索引缓冲区；
- 无深度/模板附件；
- 颜色目标格式和采样数来自渲染器/任务目标；
- 混合为 `options.blend` 或禁用；
- 关闭剔除。

片段入口点始终为 `effectFragment`。

## 着色器逻辑（WGSL 轮廓或含精确数学的伪代码）

用户片段以 WGSL 提供，且必须定义：

```wgsl
@fragment
fn effectFragment(input: EffectVertexOutput) -> @location(0) vec4<f32> {
    // input.uv follows Babylon.js post-process coordinates:
    // bottom-left triangle vertex maps to (0,0), top-left screen pixels approach y=1.
}
```

如果提供了自定义 `vertexWGSL`，它必须提供一个名为 `effectFullscreenVertex` 的 `@vertex` 入口点。

## 状态机 / 生命周期

### 仅交换链路径（`EffectRenderer`）

1. `createEffectWrapper(engine, options)` 返回一个纯状态包装器。着色器/布局对象在首次使用时惰性创建。
2. 用户代码调用 `setEffectUniforms` 和/或 `setEffectTexture`。
3. `createEffectRenderer(engine, effect, options?)` 创建一个直接实现 `RenderingContext` 的 `EffectRenderer`。它拥有一个内部交换链 `RenderTarget`，不需要 `SceneContext`。
4. `registerEffectRenderer(er)` 将渲染器注册到引擎。
5. `startEngine(engine)` 启动渲染循环。每一帧：`_record()` 在画布大小变化时重建 RT，修补交换链视图，并编码一次绘制调用。
6. `disposeEffectRenderer(er)` 注销并释放交换链 `RenderTarget`。
7. `disposeEffectWrapper(wrapper)` 销毁包装器拥有的 uniform 缓冲区并清除 GPU 引用。

### 离屏 RTT 路径（`createEffectRenderTask`）

1. `createEffectWrapper(engine, options)` —— 同上。
2. `createRenderTargetTexture(engine, descriptor)` 返回用于离屏目标的 `{ rt, texture }`。
3. `createEffectRenderTask(config, engine, scene)` 创建一个帧图 `Task`。若 `target` 是 `RenderTarget`，任务将渲染入其中；随后可将第 2 步的 `Texture2D` 绑定到场景材质。
4. `addTaskAtStart(scene, task)`（或 `addTask`）将该通道调度在场景默认渲染通道之前。
5. 按常规流程调用 `registerScene` / `startEngine`。
6. 可选：设置 `task.scissor`（任意帧）以仅光栅化目标的该归一化矩形，而不改变全屏视口或 UV。`execute()` 使用与后处理视口相同的取整方式将其转换为像素（下边界 `floor`，上边界 `ceil`），将其钳位到目标范围，并在绘制前调用 `setScissorRect`。非正数的归一化宽/高或钳位后的空矩形会直接结束通道而不绘制，并返回 `0`；执行绘制则返回 `1`。当 `clear` 开启时清除仍会发生，因为清除操作属于附件。`null` 或未设置时绘制整个目标。每次执行都会读取该区域和当前目标尺寸，因此修改和目标大小调整无需重新录制。
7. 完成后调用 `disposeEffectWrapper(wrapper)`。

### 仅 Uniform 帧图路径（`createUniformEffectRenderTask`）

1. `createUniformEffectWrapper(engine, { fragmentWGSL, uniformByteLength })` 创建一个更小的效果包装器，在 binding 0 处拥有一个 uniform 缓冲区。
2. 用户代码在每次需要更新 uniform 数据的绘制前调用 `setUniformEffectUniforms(wrapper, data)`。
3. `createUniformEffectRenderTask(config, engine, scene?)` 为显式 `RenderTarget` 创建一个帧图 `Task`。它可以调度在场景帧图或独立 `FrameGraphContext` 中。
4. 该任务录制单个全屏三角形管线，并将包装器的 uniform 绑定组绑定到 group 0。
5. `disposeUniformEffectWrapper(wrapper)` 销毁包装器拥有的 uniform 缓冲区。

## Babylon.js 对照表

| Babylon.js                                            | Babylon Lite                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `EffectWrapper`                                       | `EffectWrapper` 纯状态句柄                                              |
| `EffectRenderer.render(wrapper)`（交换链）            | `createEffectRenderer(engine, effect)` + `registerEffectRenderer`——无需场景 |
| `EffectRenderer.render(wrapper, outputTexture)`（RTT）| 在 `FrameGraph` 中调度的 `createEffectRenderTask({ effect, target: rt })` |
| 仅 uniform 全屏通道                                   | `createUniformEffectWrapper` + `createUniformEffectRenderTask`          |
| 全屏四边形/索引缓冲区                                 | 基于顶点索引的全屏三角形                                                |
| `onApplyObservable`                                   | 用户在通道执行前调用 `setEffectUniforms` / `setEffectTexture`           |
| 当前帧缓冲区 / RTT                                    | 直接 `EffectRenderer` / 帧图 `RenderTarget` 任务                        |
| `effect.setTexture("name", texture)`                  | `setEffectTexture(wrapper, "name", texture2D)`                          |

该 API 有意不实现 Babylon.js 的着色器存储查找、GLSL include 处理、可观察对象（observables）、原始渲染目标包装器或 WebGL 兼容性。

## 依赖关系

- `engine/engine.ts`：用于 `EngineContext` / 内部设备访问；
- `engine/render-target.ts`：用于 `RenderTarget`、`buildRenderTarget`、`disposeRenderTarget` 和 `targetSignatureKey`；
- `frame-graph/task.ts`：用于任务多态；
- `resource/gpu-pool.ts`：用于通过 `Texture2D.sampler` 复用采样器；
- `scene/scene-core.ts`：用于场景所有权和帧图调度；
- `texture/texture-2d.ts`：用于公共纹理句柄。

## 测试规范

- `effect-render-task-scissor.test.ts` 记录渲染通道调用，以验证未设置/null 行为、左下角原点、向外像素取整、所有边界钳位、零/负尺寸（含小数边界）、目标外矩形、实时更新/调整大小、绘制次数以及空区域时的附件清除。裁剪（scissor）从不改变视口或全屏 UV 映射。
- 场景 74 通过 Babylon.js `EffectRenderer` 和 Babylon Lite 的直接效果渲染器渲染一个确定性的全屏程序化效果。
- 场景 75 将一个效果渲染到 `RenderTarget` 并把该纹理映射到球体上，匹配 Babylon.js Playground 风格的 RTT 工作流。
- 场景 76 通过 `setEffectTexture()` 绑定一个 `Texture2D`，并在直接效果渲染器中通过关联的采样器绑定对其采样。
- 一致性测试捕获/使用 `reference/lite/scene74-effect-renderer`、`reference/lite/scene75-effect-rtt-sphere` 和 `reference/lite/scene76-effect-texture` 基准图，然后对照 `scene-config.json` 断言全图 MAD。
- 打包体积核算仅为新的效果场景添加特定场景的 `maxRawKB` 条目；现有上限保持不变。

## 文件清单

- `tests/lite/unit/effect-render-task-scissor.test.ts`
- `packages/babylon-lite/src/effect/effect-renderer.ts`
- `packages/babylon-lite/src/effect/uniform-effect-renderer.ts`
- `docs/lite/architecture/30-effect-renderer.md`
- `lab/lite/src/bjs/scene74.ts`
- `lab/lite/babylon-ref-scene74.html`
- `lab/lite/src/lite/scene74.ts`
- `lab/lite/scene74.html`
- `tests/lite/parity/scenes/scene74-effect-renderer.spec.ts`
- `reference/lite/scene74-effect-renderer/babylon-ref-golden.png`
- `lab/public/thumbnails/scene74.jpg`
- `lab/lite/src/bjs/scene75.ts`
- `lab/lite/babylon-ref-scene75.html`
- `lab/lite/src/lite/scene75.ts`
- `lab/lite/scene75.html`
- `tests/lite/parity/scenes/scene75-effect-rtt-sphere.spec.ts`
- `reference/lite/scene75-effect-rtt-sphere/babylon-ref-golden.png`
- `lab/public/thumbnails/scene75.jpg`
- `lab/lite/src/bjs/scene76.ts`
- `lab/lite/babylon-ref-scene76.html`
- `lab/lite/src/lite/scene76.ts`
- `lab/lite/scene76.html`
- `tests/lite/parity/scenes/scene76-effect-texture.spec.ts`
- `reference/lite/scene76-effect-texture/babylon-ref-golden.png`
- `lab/public/thumbnails/scene76.jpg`
