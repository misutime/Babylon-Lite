# 模块：帧图（Frame Graph）

> 包路径：`packages/babylon-lite/src/frame-graph/`
> 相关路径：`packages/babylon-lite/src/engine/render-target.ts`、`packages/babylon-lite/src/texture/rtt.ts`、`packages/babylon-lite/src/render/renderable.ts`

## 目的

帧图将场景的渲染工作调度为一个有序的任务列表。它用场景拥有的任务取代了过去“引擎拥有唯一特权主渲染通道”的模型，所有任务都向引擎当前的 `GPUCommandEncoder` 中编码命令。

首个实现特意保持精简：

- `FrameGraph` 是一个有序任务列表，而不是依赖 DAG
- `RenderTask` 是默认的场景渲染任务类型；`EffectRenderTask` 也是用于全屏 RTT 效果的帧图任务
- `ShadowTask` 是一个内部适配器任务，仅由 `registerSceneWithShadowSupport()` 安装，用于在默认场景渲染之前通过 `Task.execute()` 调度阴影生成器
- `Task` 接口特意保持开放，以便后续工作可以添加其他任务类型
- 基于通道的任务在 `record()` 期间录制一个或多个 `Pass` 实例；目前只有 `RenderPass` 存在
- 内置任务可以直接实现 `execute()`；`RenderTask`、`ShadowTask` 以及若干全屏/效果任务使用了这一快速路径
- 渲染目标目前是显式对象，尚未成为虚拟图资源
- 默认场景渲染本身就是一个 `RenderTask`

这为 Babylon Lite 提供了足够的架构能力来支持离屏 RTT 通道、逐通道相机和逐通道材质覆盖，同时保持调度显式、面向数据且可 tree-shake。如果 Lite 将来引入节点渲染图（node render graph），那套更高层的编排层可以是 DAG，但可执行的帧图仍然是一个有序任务列表。

## 强制性显式输出纹理（PR 准入门槛）

**每一个执行渲染的帧图任务都必须提供一个显式的输出参数/字段，以标识它实际渲染进入的纹理。此规则是 PR 验收的强制性条件。**

该契约同时适用于原生（native）和兼容（compat）代码中的场景渲染、全屏/后处理通道、叠加层、深度渲染、拷贝/解析目标以及复合任务。请发布诸如 `RenderTarget` 之类的类型化资源；不要向用户代码暴露原始 GPU 句柄。下游任务必须能够直接使用生产方声明的输出，而无需搜索整个图、检查私有通道，或假设输入纹理中仍然包含最终结果。

### 调用方提供目标与任务自有分配均合法

**目标纹理并不总是必须作为输入传入。** 以下两种模型均合法：

1. 调用方提供目标，任务渲染进该目标并将其发布。
2. 任务根据其文档化的配置自行分配并拥有其输出纹理，并发布这些纹理。

`GeometryRendererTask` 就是第二种模型的合法示例：它分配所请求的 G-buffer 附件，并通过 `geometryDepthTexture`、`geometryWorldNormalTexture` 及其它类型化输出访问器暴露结果。它不需要调用方为所有这些附件提供纹理。也允许私有的中间/历史纹理分配。

任务 API 必须明确记录分配、所有权、尺寸调整、加载/清除行为以及解析语义。带有文档化分配/默认模式的可选目标本身并不违规；然而，任务在每一种受支持的模式下都必须仍然发布实际结果。调用方提供的目标必须得到尊重，不得为了兼容性而静默替换。

**自行分配并不授权启发式地发现另一个任务的目标。** 不得通过搜索“最后一个活动解析器（last active resolver）”、通过任务名称或注册顺序，或通过隐藏相同启发式逻辑的回调来选择附件。仅靠文档化的默认目标不足以满足输出契约：实际目标仍必须被显式暴露。

在调整大小/设备恢复后读取声明输出的当前视图，或替换任务拥有的分配，都是合法的。请保持已发布的输出为最新状态，并在需要时由组合所有者重新连接依赖任务。对于借用的叠加层颜色，`createRenderTask({ name: "overlay", rt: finalColor, rst: screen, ... }, engine, scene)` 仍然属于显式目标模型；将 `finalColor` 替换为 `findLastResolver(scene)` 是不合法的。

### 显式产出的纹理结果

区分源输入与渲染目标：任务可以读取 `inputTexture`，接受或分配一个目标，并将产出的纹理发布为 `outputTexture`（名称仅为示例，并非新的通用包装器 API）。已发布的输出必须标识实际使用的目标。当 GPU 操作允许原地操作时，它可以与源输入别名（alias）指向同一对象；对于异地/乒乓（ping-pong）通道，它也可以是不同的纹理。这并不允许在纹理同时作为渲染附件绑定时对其进行采样。

对于多附件或 MSAA 解析，请显式暴露对应的输出，并区分多重采样颜色与其解析后的结果。切勿发布更早的中间产物、历史附件，或任务已静默停止使用的请求目标。

在工厂返回的任务/结果上或通过显式输出绑定发布类型化资源句柄。当资源身份发生变化时保持它们为最新，并让组合所有者显式重新连接依赖方。此契约不要求每帧分配结果对象，也不要求更改 `Task.execute()` 的绘制计数返回值。

对于 `RenderTask`，返回任务的公共 `config` 同时也是它的显式实时输出绑定：`config.rt` 标识主渲染目标，`config.rst` 标识其可选解析结果，`config.depth` 标识可选的独立深度输出。这些是通道编码所消费的规范目标，而不是输入参数的独立缓存副本。后处理任务通过 `outputTexture` 及其声明的解析输出暴露其实际结果。复用现有的类型化输出绑定是合法的；不需要添加另一个包装器或输出发现回调。

### 阻塞性审查清单

1. 任务是否显式发布了它实际产出的每一个纹理，以便下游任务能够直接使用结果？
2. 目标是否要么由调用方提供，要么根据任务的文档化契约选择/分配，而没有启发式地发现其他任务的附件？
3. 是否区分了颜色/深度/解析输出，并且明确定义了所有权以及任何原地别名关系？
4. 输出句柄在分配变更后是否保持最新，并且依赖绑定是否通过显式更新而非自动发现或过时句柄来更新？

**如果任意一条回答为否，请要求修改：在输出契约修正之前，绝不得批准或合并该 PR。** 测试通过、截图一致、兼容性要求和较小的打包体积均不能凌驾于此准入门槛之上。不需要目标输入本身并不是拒绝一个自行管理并发布其输出的任务的正当理由。

尚未发布其实际结果的现有 API 属于迁移技术债。它们的迁移应放在单独的 PR 中；本仅限文档的策略更新并不声称每一个历史任务都已经完成迁移。

## 公共 API 接口

```typescript
export type { FrameGraph } from "./frame-graph/frame-graph.js";
export type { Task } from "./frame-graph/task.js";
export { getFrameGraph } from "./scene/scene.js";
export { getFrameGraphTasks } from "./frame-graph/frame-graph.js";
export { addRenderPass, addTask, addTaskAtStart, addTaskBefore, addTaskAfter, removeTask } from "./frame-graph/frame-graph-actions.js";

export type { Pass } from "./frame-graph/pass.js";
export { addPassDependencies } from "./frame-graph/pass.js";
export type { RenderPass } from "./frame-graph/render-pass.js";
export type { RenderPassExecuteFunc } from "./frame-graph/pass.js";

export type { RenderTask, RenderTaskConfig } from "./frame-graph/render-task.js";
export { createRenderTask, addMeshToTask, addMeshesToTask, removeMeshFromTask, removeMeshesFromTask } from "./frame-graph/render-task.js";
export { enableRenderTaskMeshRefresh } from "./frame-graph/render-task-mesh-refresh.js";
export type { OverdrawCostMeasure } from "./engine/gpu-task-timing.js";
export { measureRenderTaskOverdrawCost } from "./engine/gpu-task-timing.js";
export type { ImageProcessingSource, ImageProcessingTaskConfig } from "./frame-graph/image-processing-task.js";
export { createImageProcessingTask } from "./frame-graph/image-processing-task.js";

export type { RenderTarget, RenderTargetDescriptor } from "./engine/render-target.js";
export { createRenderTarget } from "./engine/render-target.js";
export type { RenderTargetDepthSampler, RenderTargetTextureResult } from "./texture/rtt.js";
export { createRenderTargetTexture, disposeRenderTargetTexture } from "./texture/rtt.js";
export { createSurfaceRenderTargetTexture, onRenderTargetTextureResize } from "./texture/rtt-surface.js";
export { withSampledDepthTexture } from "./texture/rtt-depth.js";
```

### `FrameGraph`

```typescript
export interface FrameGraph {
    _tasks: Task[];
    _currentProcessedTask: Task | null;
    build(): void;
    execute(): number;
    dispose(): void;
}
```

除非 `options.defaultRenderTask === false`，否则 `createSceneContext(engine, options?)` 会立即创建一个帧图，并追加一个名为 `"scene"` 的默认交换链 `RenderTask`。将场景渲染到离屏源目标并将最终全屏通道解析到交换链的后处理管线会禁用该默认任务，以避免重复渲染场景。`registerSceneWithShadowSupport()` 会在最前面插入名为 `"shadow"` 的内部阴影适配器任务，而普通的 `registerScene()` 则保持无阴影，从而使非阴影场景不会保留阴影任务模块。用户代码通常通过 `getFrameGraph(scene)` 访问帧图，或者直接将场景传给 `addTask*()`。

`build()` 分两个阶段运行（镜像了 BJS `frameGraph.buildAsync` 的隐式形态）：

1. **Record（录制）。** 按执行顺序对每个任务：清空 `task._passes`，设置 `_currentProcessedTask = task`，调用 `task.record()`，然后在 `finally` 中清除游标。该游标使 `record()` 内部的 `addRenderPass(...)` 能够将新创建的 `Pass` 关联到当前正在录制的任务。
2. **Initialize（初始化）。** 按执行顺序对每个任务的每个通道：调用 `pass._initialize()`。这种延迟初始化使通道能够安全地引用由*其他*任务分配的资源（例如由更早任务的 `record()` 构建颜色纹理的 RTT）。

在阶段 1 之外 `_currentProcessedTask` 为 `null`；在 `record()` 之外调用 `addRenderPass(...)` 会抛出异常。

`RenderDrawTask` 保留直接执行模式，但会为阶段 2 初始化录制一个内部纹理任务通道。在所有任务录制完成后，其初始化器通过绑定到成员的 `_syncEager` 调用同步当前的预分配（eager）目标并刷新其缓存附件。它绝不会重建普通目标。因此，即使源分配任务在更晚的时候才录制，借用方包装器也能观察到表面 RTT 的替换。两个阶段均保持同步。`buildFrameGraphTask()` 仅初始化其选定的任务，而不初始化其他生产方。执行顺序和内容依赖仍由调用方负责。重新录制会替换该初始化器通道；任务销毁会清除它而不释放借用的目标。

### 任务发现

```typescript
export function getFrameGraphTasks(frameGraph: FrameGraph): readonly Task[];
```

这个根包导出的函数直接返回 `frameGraph._tasks`，不进行分配、过滤或对类型化参数进行验证。该数组是一个**实时视图**，而非快照：重复调用在图的整个生命周期内返回同一个数组实例。后续的 `addTask()`、`addTaskAtStart()`、`addTaskBefore()`、`addTaskAfter()` 和 `removeTask()` 调用会原地修改同一数组。`frameGraph.dispose()` 会销毁仍注册在其中的任务并清空同一数组。

```typescript
const sceneTasks = getFrameGraphTasks(getFrameGraph(scene));
const standaloneTasks = getFrameGraphTasks(frameGraphContext.frameGraph);
const snapshot = sceneTasks.slice(); // copy membership/order when a stable snapshot is needed
```

对于场景图，使用 `getFrameGraph(scene)`。对于无场景图，使用 `FrameGraphContext.frameGraph`；已注册的上下文可以通过 `getRenderingContexts(surface)` 找到，并通过 `getRenderingContextKind(context) === "frame-graph-context"` 来识别。

每个已注册的顶层任务都会按构建/执行顺序列出，包括默认场景渲染任务、诸如前置阴影任务之类的系统任务，以及 `executionEnabled` 为 `false` 的任务。像泛光（bloom）这样的复合任务在每次注册时只出现一次；其私有拥有的提取、模糊和合并子任务不会作为独立条目出现。重复注册会保留为重复条目。名称既不唯一也不是稳定标识符。插入或移除后索引会偏移，因此轮询消费方必须重新读取列表，并将当前索引与每个任务对象的身份关联起来。

调用方不得修改返回的数组；`readonly` 仅是 TypeScript 编译期限制，并非运行时冻结。发现不转移所有权：帧图继续拥有已注册的任务及其销毁权。拷贝出的快照也只是借用任务对象，其资源随后可能会被销毁。显式移除会按照 **任务移除与所有权** 中的描述转移清理责任。

有效的执行门控为 `task.executionEnabled !== false`：`true` 和 `undefined` 都表示启用，消费方在切换时应写入布尔值。将其设为 `false` 会保留录制与资源，但完全跳过该任务，而不是变成一个禁用的透传通道；因此下游消费方可能会采样到过时目标。这与特定于任务的 `enabled` 设置相互独立。一次性计算任务也会写入自身的 `executionEnabled`，因此消费方的切换可能会被该调度器覆盖。任务发现不会改变任何这些语义。

### `Task`

```typescript
export interface Task {
    readonly name: string;
    executionEnabled?: boolean;
    readonly engine: EngineContext;
    readonly scene?: SceneContext;
    _passes: Pass[];
    record(): void;
    _preload?(): Promise<void>;
    _removeMesh?(mesh: object): void;
    execute?(): number;
    dispose(): void;
}
```

任务生命周期：

| 方法        | 调用方                         | 用途                                                                                                     |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `record()`  | `FrameGraph.build()`（阶段 1） | 分配/重建 GPU 资源，并可选地将 `Pass` 实例注册到 `_passes`。直接任务则改为准备自身的描述符/状态。同步。 |
| `execute()` | `FrameGraph.execute()`         | 可选的任务级直接执行钩子。存在时，帧图调用它而不是排空 `_passes`。                                       |
| `dispose()` | `FrameGraph.dispose()`         | 释放任务拥有的 GPU 资源；基于通道的任务同时销毁其拥有的通道。                                            |

`RenderTask` 是 `Task` 的主要场景渲染实现，而 `EffectRenderTask` 使用相同的任务/通道契约来实现全屏 RTT 效果。存在该接口是为了让未来的帧图工作无需修改 `FrameGraph` 本身即可添加其他有序任务类型，例如计算任务、拷贝/解析任务、对象列表任务或资源转换/辅助任务。

`_passes` 列表是逐任务的已录制通道视图。`FrameGraph.build()` 在每个任务录制开始时清空它，任务负责在 `record()` 期间重新推入其通道。`RenderTask` 是一个直接任务：`_passes` 保持为空，`record()` 准备其描述符/绑定，`execute()` 自行开启并关闭 GPU 渲染通道。用户定义的基于通道的任务以及通过 `addRenderPass()` 创建的辅助对象仍然使用 `_passes` 以及阶段 2 的 `_initialize()` 遍历。

当存在 `task.execute()` 时，`FrameGraph.execute()` 累加其返回的绘制次数；否则它排空已录制的通道。直接执行是有意设计的内置快速路径，而不仅仅是一个迁移逃生通道。逐任务 GPU 计时是显式启用的：公共计时 API 会在运行时动态导入一个性能分析器来包装已注册的 `FrameGraph.execute()` 函数，因此非性能分析打包产物既不会获取分析器代码，也不会在此携带静态的任务计时分支。内置的 `ShadowTask` 使用此路径进行阴影调度：ESM 生成器暴露由 `ShadowTask` 编码的深度/模糊资源，而 PCF 生成器则通过 ShadowTask 拥有的仅深度 `RenderTask` 渲染，这些任务使用 Standard/PBR/Node 无颜色阴影材质视图。这些 PCF 变体在需要时保留一个 void 片段阶段，以便材质的 `discard` 逻辑无需绑定颜色目标仍能影响深度附件。

## `Pass` 与 `RenderPass`

`Pass` 是由恰好一个基于通道的任务所拥有的 GPU 工作单元。当任务没有直接的 `execute()` 时，`FrameGraph.execute()` 通过调用 `pass._execute()` 来排空其通道。这种拆分镜像了 Babylon.js 的 `IFrameGraphPass` / `FrameGraphRenderPass`，并带有下面描述的两处刻意设计的 Lite 风格差异。

### `Pass` 基础接口

```typescript
export interface Pass {
    readonly name: string;
    _parentTask: Task;
    _dependencies: Set<RenderTarget>;
    _executeFunc: ((pass: GPURenderPassEncoder) => number) | null;
    _beforeExecute: (() => void) | null;
    _initialize(): void;
    _execute(): number;
    _dispose(): void;
}
```

| 方法            | 调用方                           | 用途                                                                                                                    |
| --------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `_initialize()` | `FrameGraph.build()`（阶段 2）   | 构建需要其他任务的 RT 已完成分配的缓存。`RenderPass` 在此处构建其 `GPURenderPassDescriptor`。不需要此阶段的通道可为空操作。|
| `_execute()`    | 每帧由 `FrameGraph.execute()` 调用 | 执行具体的通道 GPU 工作。返回发出的绘制调用次数（累加进引擎的绘制计数器）。                                             |
| `_dispose()`    | 所属任务的 `dispose()`           | 释放通道拥有的 GPU/CPU 状态。幂等。                                                                                     |

`addPassDependencies(pass, deps)` 将一个或多个 `RenderTarget` 添加到 `pass._dependencies`（`Set` 语义，幂等）。它被提升到了基础 `Pass` 上（BJS 将其保留在 `FrameGraphRenderPass` 上），因为它是整个纹理图通用的概念，未来的计算/拷贝/对象列表通道都会用到它，而无需在每种通道类型上重复引入。目前它仅作信息记录之用；未来的纹理虚拟化步骤将读取它以计算生命周期与内存别名。

### `RenderPass`

```typescript
export interface RenderPass extends Pass {
    _renderTarget: RenderTarget | null;
    _renderTargetDepth: RenderTarget | null;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment | null;
    _depthAttachment: GPURenderPassDepthStencilAttachment | null;
    clearColor: GPUColorDict;
    clear: boolean;
}
```

`RenderPass` 将单个 `encoder.beginRenderPass(...)` / `pass.end()` 括起来，并将主体委托给基础 `Pass._executeFunc`。缓存的描述符在 `_initialize()`（`FrameGraph.build()` 的阶段 2）中根据 `_renderTarget` / `_renderTargetDepth` 构建一次。每帧中，`_execute()`：

1. 如果存在 `_beforeExecute`，则运行它。
2. 使用实时 `clearColor`、`clear` 以及目标当前的 `_colorView` 修补缓存的颜色附件。
3. `enc = engine._currentEncoder.beginRenderPass(_renderPassDescriptor)`。
4. `draws = _executeFunc?.(enc) ?? 0`。
5. `enc.end()` 并返回 `draws`。

`_renderTargetDepth` 是可选的。当为 `null` 时，深度视图来自 `_renderTarget`（当前的组合 RT 行为，与 BJS 默认一致）。

### 通道操作（Pass actions）

用户任务代码通过公共操作创建和配置通道：

| 函数                              | 用途                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `addRenderPass(target, name)`     | 创建一个 `RenderPass`，将其与当前正在录制的任务（通过 `FrameGraph._currentProcessedTask`）关联，推入 `task._passes`，并返回它。必须在 `Task.record()` 内部调用。|
| `addPassDependencies(pass, deps)` | 添加一个或多个通道从中读取的 `RenderTarget`（幂等）。                                                                                            |

更底层的 `setRenderPass*` 辅助函数位于它们所修改的状态旁边：渲染目标/清除状态 setter 位于 `frame-graph/render-pass.ts`，而通用通道回调（`setRenderPassExecuteFunc`、`setRenderPassBeforeExecute`）位于 `frame-graph/pass.ts`。`setRenderPassClear(pass, clear, clearColor)` 一并更新清除/加载标志和清除颜色，而不会分配状态对象。这些辅助函数目前有意**不**从包中重新导出。基于通道的辅助函数使用 `createRenderPass(...)`（它原子性地创建通道并将其追加到 `task._passes`），然后通过 setter 对其进行配置。诸如 `RenderTask` 之类的直接内置任务不保留任何此类通道对象编排代码。

### 与 BJS 的两处刻意 Lite 风格差异

- **没有共享的 `FrameGraphRenderContext`。** BJS 通过一个在通道间切换的上下文对象来路由实时渲染通道编码器。在 Lite 中，每个 `RenderPass` 拥有自己的描述符，其基础通道 `_executeFunc(enc)` 直接接收实时编码器。这使接口更扁平，并避免了在当前规模下毫无收益却消耗打包字节的逐通道间接层。
- **没有数字 `TextureHandle` 间接层。** `pass._renderTarget` / `pass._renderTargetDepth` 是具体的 `RenderTarget` 引用，而不是纹理管理器中的句柄。完整的虚拟化方案（句柄、生命周期/别名分析、延迟分配、MRT、历史纹理）是有意留待后续的步骤。句柄层将仅是已知调用点（`setRenderPassRenderTarget`、`setRenderPassRenderTargetDepth` 和 `_initialize()`）上的类型参数变更；其余接口的形态已做好无痛兼容它的准备。

任务按数组顺序执行。没有自动依赖分析；调用方顺序即契约。

```typescript
addTask(sceneOrGraph, task); // append at end
addTaskAtStart(sceneOrGraph, task); // insert at start of user work, after built-in system tasks such as ShadowTask
addTaskBefore(sceneOrGraph, task, beforeTask);
addTaskAfter(sceneOrGraph, task, afterTask); // insert immediately after afterTask
removeTask(sceneOrGraph, task); // detach every registration of this task; returns whether any were removed
```

规则：

- 离屏生产方任务必须在采样其输出的消费方任务之前运行。
- 叠加层任务应使用 `sharedRt: true`、`clr: false`，并在所属任务之后运行。当它们必须针对所属任务 rt 自有的深度进行深度测试时，请添加 `depthClear: false`。
- 如果未找到 `beforeTask`，`addTaskBefore()` 会追加到末尾。
- `addTaskAfter()` 会紧接在 `afterTask` 之后插入，如果未找到则追加到末尾。
- 如果在启动/调整大小路径之外添加或插入任务，调用方代码必须在下一帧之前重建图。
- 如果任务在 `registerScene()` 之前使用了 `addMeshToTask()`，请将显式 `build()` 调用推迟到 `registerScene()` 之后，以便延迟材质构建器已经运行。

### 任务移除与所有权

```typescript
export function removeTask(target: FrameGraph | SceneContext, task: Task): boolean;
```

`removeTask()` 按任务对象身份匹配，从现有的有序任务数组中移除每一次出现，并保留所有其他任务的顺序。当成员关系发生变化时返回 `true`，当任务不存在时返回 `false`。具有相同名称的其他任务不受影响。场景及其图都会选中同一个列表。请在图构建/执行之间执行此操作，例如在场景的渲染前更新中；在任务/通道回调中进行修改超出了调度契约的范围。

移除会将生命周期责任转移给调用方。它会保留已录制的通道和任务状态，不会调用 `dispose()`、不会重建存活的任务、不会重新连接资源消费方，也不会取消正在进行的异步预加载工作。被移除的任务在未来的图构建、执行和图销毁中都会被跳过。仍然有效的已录制任务无需重建即可重新添加；未录制或已更改的任务在重新添加后使用 `buildFrameGraphTask()`。所有者只有在其消费方以及已编码/提交的 GPU 工作不再使用其资源之后，才释放被移除的任务。生产方/消费方排序仍由调用方负责。

验证覆盖了直接任务和基于通道的任务、图/场景目标、不存在的任务与同名任务、重复注册、保留的通道状态、销毁所有权以及重新添加。公共声明与 tree-shaking 验证了根包访问权限以及无关导入中不存在移除/渲染器代码。

### 内部阴影适配器任务

`registerSceneWithShadowSupport(scene)` 会在默认 `"scene"` 渲染任务之前安装一个内部 `ShadowTask`：

```typescript
await registerSceneWithShadowSupport(scene);
createRenderTask({ name: "scene", rt: swapRT, clrColor: scene.clearColor }, engine, scene);
```

该任务拥有为每个阴影生成器注册的投射网格输入。它自身不录制直接通道。在 `record()` 期间，它会创建/录制内部阴影渲染任务，从而使投射网格通过材质拥有的管线进行渲染：

```typescript
record(): void {
    task._passes.length = 0;
    // PCF/ESM shadow generators record internal caster RenderTasks here.
}
```

每帧中，`execute()` 遍历场景的灯光，利用任务拥有的投射器输入渲染每个灯光的阴影生成器，并返回累加后的绘制次数。ESM 会在其内部材质视图投射任务之后添加模糊通道；PCF 则执行早先录制的内部仅深度材质视图任务。

## 渲染目标（Render Targets）

### 描述符

```typescript
export interface RenderTargetDescriptor {
    lbl?: string;
    format?: GPUTextureFormat;
    dFormat?: GPUTextureFormat;
    depthClearValue?: number;
    depthCompare?: GPUCompareFunction;
    samples: number;
    size: SurfaceContext | RenderTargetSurfaceSize | { width: number; height: number };
}

export interface RenderTargetSurfaceSize {
    readonly surface: SurfaceContext;
    readonly scale: number;
}
```

渲染目标是纯状态描述符加上所拥有的 GPU 纹理句柄。`buildRenderTarget(rt, engine)` 在 `RenderTask.record()` 期间分配纹理。

| 字段              | 含义                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `lbl`             | 可选 GPU 调试标签。                                                                                                         |
| `format`          | 可选颜色格式。仅深度目标可省略。                                                                                            |
| `dFormat`         | 可选深度/模板格式。纯颜色目标（如表面交换链包装器）可省略。                                                                 |
| `depthClearValue` | 可选清除深度值；反向 Z（reverse-Z）目标默认为 `0`，而标准 Z 目标通常使用 `1`。                                              |
| `depthCompare`    | 可选的通道级管线深度比较函数；默认为反向 Z `"greater-equal"`，传入时会覆盖材质默认值。                                      |
| `samples`         | 附件采样数（`1` 或 `4`）。                                                                                                  |
| `size`            | `SurfaceContext` 表示完整实时尺寸，`{ surface, scale }` 表示缩放实时尺寸，或固定 `{ width, height }` 设备像素。由于 `EngineContext` 继承自 `SurfaceContext`，传入 `EngineContext` 也有效。|

缩放后的表面尺寸会将正的有限 `scale` 应用于每个实时画布维度，对结果向下取整，并将每个轴钳位到至少一个像素。缩放比例由描述符固定，而画布尺寸保持实时更新：

```typescript
const halfResolution = { surface: scene.surface, scale: 0.5 };
```

表面拥有 `scRT`，它是围绕当前交换链纹理的预分配单采样纯颜色包装器。单采样的默认 `RenderTask` 直接写入 `scRT` 并拥有一个单独的深度目标。使用 MSAA 时，任务写入自有的多重采样颜色/深度目标，并使用 `RenderTaskConfig.rst = surface.scRT` 作为显式单采样解析目标。不存在 `resolveToSwapchain` 描述符标志。

### 目标签名（Target Signature）

```typescript
export interface RenderTargetSignature {
    readonly _colorFormat?: GPUTextureFormat;
    readonly _depthStencilFormat?: GPUTextureFormat;
    readonly _depthCompare?: GPUCompareFunction;
    readonly _sampleCount: number;
    readonly _transmissionTexture?: Texture2D | null;
    _collectBatches?: (state: DrawBatchState | undefined, binding: DrawBinding) => DrawBatchState | undefined;
}
```

材质管线按目标签名缓存。附件键序列化器位于 `engine/render-target-signature.ts`，与 `render-target.ts` 中的分配/销毁分离，因此仅使用附件的使用方不会保留键构建代码。`_transmissionTexture` 仅在场景颜色透射时安装，而 `_collectBatches` 仅由绑定更新特性安装。所有颜色目标均以正向投影和逆时针正面约定渲染；不存在任何描述符或签名翻转标志。

### 预分配 RTT 纹理（Eager RTT Texture）

```typescript
export interface RenderTargetTextureResult {
    readonly rt: RenderTarget;
    readonly texture: Texture2D;
    readonly depthTexture: Texture2D | null;
}

export type RenderTargetDepthSampler = (engine: EngineContext, target: RenderTarget) => Texture2D;
export function withSampledDepthTexture(engine: EngineContext, target: RenderTarget): Texture2D;
export function createRenderTargetTexture(engine: EngineContext, descriptor: RenderTargetDescriptor, sampleDepth?: RenderTargetDepthSampler): RenderTargetTextureResult;
export function createSurfaceRenderTargetTexture(
    engine: EngineContext,
    descriptor: RenderTargetDescriptor & { size: SurfaceContext | RenderTargetSurfaceSize },
    sampleDepth?: RenderTargetDepthSampler
): RenderTargetTextureResult;
export function disposeRenderTargetTexture(result: RenderTargetTextureResult): void;
export function onRenderTargetTextureResize(result: RenderTargetTextureResult, callback: () => void): () => void;
```

当必须在帧图构建之前将通道输出连线到材质或计算绑定中时，使用此功能。它预分配渲染目标并将颜色附件暴露为 `texture`。在颜色目标上，`dFormat` 默认会创建一个自有的深度测试附件，但不创建可采样的深度外观。传入 `withSampledDepthTexture` 作为第三个参数即可显式启用额外的 `depthTexture`。仅深度的固定或表面目标必须传入该辅助函数；此时其 `texture` 和 `depthTexture` 会别名指向同一个可采样深度包装器。

```typescript
const output = createSurfaceRenderTargetTexture(engine, { format: engine.format, dFormat: "depth32float", samples: 1, size: engine }, withSampledDepthTexture);
const halfDepth = createSurfaceRenderTargetTexture(engine, { dFormat: "depth32float", samples: 1, size: { surface: engine, scale: 0.5 } }, withSampledDepthTexture);
```

**破坏性迁移：** 以前把可采样深度作为主 `texture` 接收的仅深度 `createRenderTargetTexture(engine, descriptor)` 调用，现在必须传入 `withSampledDepthTexture` 作为第三个参数。`createSurfaceRenderTargetTexture` 也有相同要求。缺少辅助函数会在附件分配前被拒绝。除非显式请求，颜色目标（包括带深度测试附件的颜色目标）不保留深度辅助函数或可采样深度外观。在没有深度附件的情况下请求可采样深度会抛出异常并释放部分构建的附件。

可采样深度辅助函数要求实际的深度分配是单采样的。MSAA 深度无法作为 `texture_depth_2d` 暴露；对多重采样深度请求该辅助函数会在创建采样视图或采样器之前抛出异常，且两个 RTT 工厂都会释放失败的分配。如需采样深度，请使用单独的单采样深度目标。不可采样的深度测试附件可以继续保持多重采样。表面调整大小也会在发布前拒绝附件采样数变更，保留上一代外观并释放失败的替换品。

除了由采样消费方持有的引用之外，每个附件都拥有一个渲染目标所有权引用。移除最后一个采样器无法销毁正在写入者的附件。所属渲染任务在销毁时释放目标引用；剩余的采样消费方会继续让最后一个图像保持存活。未交给所属任务的目标可以通过 `disposeRenderTargetTexture` 释放。销毁是幂等的，且能阻止后续重建。`sharedRt` 任务和预分配的外部 `depth` 附件是借用方，而非额外的所有者。

预分配与销毁所有权是区分开的：可采样目标会安装附件释放钩子，而引擎交换链和几何/阴影包装器则保留其现有的外部所有者。调整大小会在发布之前先准备替换附件，转移写入方和采样方引用，并保留旧分配直到大小调整消费方重建了它们的绑定为止。只有在此之后，旧分配才会在已提交的 GPU 工作排空后回收。

源自表面尺寸 RTT 的 `cloneTexture2D` 包装器（包括克隆的克隆）与其源共享同一个附件底层记录。替换其分配代次会原子性地更新每个包装器的纹理、视图、宽度和高度。UV 变换和采样器选择仍保留在包装器局部。普通纹理克隆则保留快照语义。创建克隆不会获取引用：每个采样所有者仍必须配对调用 `acquireTexture` 和 `releaseTexture`。缓存的绑定组仍然需要现有的调整大小回调来重建它们捕获的视图。

`createRenderTargetTexture` 是固定尺寸工厂。它保留附件所有权和销毁守卫，但既不导入调整大小支持也不导入可替换克隆底层。表面尺寸描述符需要单独导入 `createSurfaceRenderTargetTexture`；将表面尺寸描述符传给固定工厂会产生显式错误，而不是静默冻结目标。

表面工厂位于 `texture/rtt-surface.ts`。其目标会在帧图重建期间（当解析后的尺寸或所属 `GPUDevice` 发生变化时）重新分配，更新共享外观，并回收旧分配。当消费方缓存绑定组时，请注册 `onRenderTargetTextureResize(result, callback)`；回调会在外观替换之后运行，以便调用方在调整大小后的帧绘制之前进行重建。ShaderMaterial 消费方可以在该回调中再次调用 `setShaderTexture`：该 setter 能检测到稳定外观背后视图和采样器的变化，而不会在普通重复设置时重建。

调整大小通知的派发是同步且可重试的。每个订阅都有一个独立的待处理标志：

- 发布替换会将当前所有订阅标记为待处理，并尝试执行每一个订阅，即使其中另一个抛出异常。
- 成功的订阅会被确认，并在尺寸未变的重建中不再重复触发。失败的订阅会在下一次 `buildRenderTarget` 或帧图构建时重试，即使此时尺寸和设备已经匹配。
- 单个失败会原样重新抛出；多个失败则生成一个包含所有抛出值的 `AggregateError`。回调失败绝不会静默报告成功。
- 在派发处于待处理期间，被替换的颜色和深度分配保持被拥有状态。后续的调整大小会通知所有订阅者最新的外观代次，并让所有更早的分配保持存活直到派发成功。随后释放会通过 GPU 回收栅栏。
- 取消注册会取消该订阅的重试，并立即结算派发记账。当不再有待处理观察者时，持有的代次无需再次构建目标或销毁目标即可直接进入受 GPU 栅栏保护的回收流程。取消注册绝不会调用其他观察者；取消待处理重试的消费方必须停止使用其被取代的视图。
- 如果在正在运行的回调内部发生取消，结算会等到当前派发遍历返回后再执行。同一个函数的重复订阅保持相互独立。在派发期间添加的订阅会从后续的调整大小开始观察。
- 销毁目标会取消派发并对所有持有的替换品加栅栏回收，即使释放当前附件时抛出异常也是如此。
- 尺寸未变的嵌套目标构建不会递归派发回调。在回调中尝试另一次物理尺寸调整会收到显式错误，并可由更晚的外层构建重试。

订阅注册表、待处理派发和持有的替换列表完全由表面 RTT 扩展拥有。固定尺寸目标和未导入表面 RTT 支持的消费方不会保留任何回调派发机制。

已完成的回收批次会立即启动引擎的微任务延迟 GPU 栅栏，因此非活动目标不需要等到下一帧或下一次构建就能释放过时分配。当取消发生在帧内部时，该微任务仍然会在当前同步帧提交之后运行。

早期分支自动表面尺寸支持的调用方在变基（restacking）时必须切换到此工厂。固定目标保持快照克隆语义，绝不保留表面实现。早期分支中在颜色目标上隐式使用额外深度外观的调用必须传入 `withSampledDepthTexture`；普通带深度测试的颜色目标不需要采样辅助函数。仅深度调用也必须传入该辅助函数并按上述方式迁移。

约束：

- 目标必须拥有颜色纹理，或者显式从深度附件请求可采样深度；借用的交换链视图不是 RTT 附件。
- 固定尺寸目标标记为预分配且永不重新分配。表面尺寸目标仅在其后备存储（backing-store）尺寸变化时重建。

## `RenderTask`

管线签名键位于 `engine/render-target-signature.ts`，与 `engine/render-target.ts` 中的附件分配和销毁分离。材质和效果构建器直接导入键函数，因此仅使用附件的消费方不会保留管线缓存键构建代码。

目标销毁会在释放任一分配之前先对两个附件进行快照并分离它们。可采样目标通过其所有权钩子接收这些捕获的句柄；普通目标则直接销毁它们。因此可重入销毁会观察到一个空目标，而颜色释放失败时仍会尝试清理深度。可采样外观可以继续保留各自独立获取的对已分离分配的引用。

目标还拥有自己的已销毁状态标记。固定 RTT 将共享的释放/就绪回调安装在该所有者上，而不是让闭包持有结果外观；表面调整大小包装器在转发附件释放时保留目标接收者。

`RenderTask` 是主要的具体帧图任务，并使用直接的 `Task.execute()`。在 `record()` 期间，它分配目标、暂存分桶后的绑定、刷新任务拥有的场景绑定组，并构建其缓存的 `GPURenderPassDescriptor`；`_passes` 保持为空。每帧中，`execute()` 运行 UBO/灯光/绑定更新、修补实时清除/解析视图、开启渲染通道、执行绘制并结束通道。

`task.config` 是公共的实时 `RenderTaskConfig` 对象，与内部的 `_config` 相同。更改清除状态会影响下一次执行；更改目标布局则需要重新创建任务及依赖管线。`scene.defaultRenderTask` 按身份提供由工厂创建的默认生产方，包括由 `createOverlayScene` 安装的任务；对于使用 `defaultRenderTask: false` 创建的场景，直到工厂安装此类任务前该字段缺席。叠加层接收显式的颜色和解析目标，而不是被发现的“最后一个解析器”。借用的附件在执行时使用其当前视图，而叠加层拥有的深度保留独立的清除和销毁语义。

```typescript
export interface RenderTaskConfig {
    name: string;
    rt: RenderTarget;
    rst?: RenderTarget;
    depth?: RenderTarget;
    clrColor?: GPUColorDict;
    clr?: boolean;
    depthClear?: boolean;
    sharedRt?: boolean;
    cam?: Camera | null;
    cs?: boolean;
    transmission?: { copyCount?: number; generateMipmaps?: boolean; mipLevelCount?: number; grabDepth?: boolean };
    autoMirror?: boolean;
}
```

| 字段           | 含义                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | 用于标签和诊断。                                                                                                                          |
| `rt`           | 此通道的具体渲染目标。                                                                                                                    |
| `rst`          | 可选的单采样解析目标，在 `rt` 为多重采样时使用。                                                                                          |
| `depth`        | 可选的独立深度目标。预分配目标为借用；非预分配目标由任务管理。                                                                            |
| `clrColor`     | 清除颜色。该对象可在帧间直接修改。                                                                                                        |
| `clr`          | 默认为清除。设为 `false` 以使用颜色 `loadOp: "load"`，用于叠加层或多场景合成。                                                            |
| `depthClear`   | 独立控制 `rt` 拥有的深度。默认为清除；设为 `false` 以加载现有深度。对于外部 `depth` 目标则忽略，它们保留各自的预分配/任务管理所有权策略。 |
| `sharedRt`     | 将 `rt`/`rst` 标记为由另一个更早任务拥有。此任务直接复用实时视图，而不重建或销毁它们。                                                    |
| `cam`          | 可选的逐通道相机。默认为 `scene.camera`。                                                                                                 |
| `cs`           | 画布尺寸宽高比标志。为 true 时，场景 UBO 宽高比使用画布尺寸而非 RTT 尺寸。当 RTT 稍后作为材质纹理采样但需保持画布宽高比时很有用。         |
| `transmission` | 可选的场景纹理透射设置。`copyCount: 0` 在每次透射绘制前刷新；否则默认刷新一次。`generateMipmaps` 默认为 `true`；设为 `false` 仅分配 mip 0 并跳过折射 mip 生成。|
| `autoMirror`   | 设为 `false` 以保留显式渲染列表，使其在通过 `addMeshToTask()` 填充前保持为空。                                                            |

### 清除与生成 Mipmap 任务

```typescript
export interface ClearTextureTaskConfig {
    name?: string;
    targetTexture?: RenderTarget | RenderTarget[];
    depthTexture?: RenderTarget;
    color?: GPUColorDict;
    clearColor?: boolean;
    convertColorToLinearSpace?: boolean;
    clearDepth?: boolean;
    clearStencil?: boolean;
    stencilValue?: number;
}

export interface ClearTextureTask extends Task {
    targetTexture: RenderTarget | RenderTarget[] | undefined;
    depthTexture: RenderTarget | undefined;
    color: GPUColorDict;
    clearColor: boolean;
    convertColorToLinearSpace: boolean;
    clearDepth: boolean;
    clearStencil: boolean;
    stencilValue: number;
    readonly outputTexture: RenderTarget | undefined;
    readonly outputDepthTexture: RenderTarget | undefined;
}

export function createClearTextureTask(config: ClearTextureTaskConfig, engine: EngineContext, scene?: SceneContext): ClearTextureTask;

export interface GenerateMipMapsTaskConfig<T extends RenderTarget | Texture2D = RenderTarget | Texture2D> {
    name?: string;
    targetTexture: T;
}

export interface GenerateMipMapsTask<T extends RenderTarget | Texture2D = RenderTarget | Texture2D> extends Task {
    targetTexture: T;
    readonly outputTexture: T;
}

export function createGenerateMipMapsTask<T extends RenderTarget | Texture2D>(
    config: GenerateMipMapsTaskConfig<T>,
    engine: EngineContext,
    scene?: SceneContext
): GenerateMipMapsTask<T>;
export function createMipMappedRenderTarget(descriptor: RenderTargetDescriptor): RenderTarget;
```

这些工厂是根包导出，且对于独立帧图不需要场景。输入和输出遵循 `FrameGraphClearTextureTask` / `FrameGraphGenerateMipMapsTask`；Lite 使用具体资源而非悬空纹理句柄。输出与输入互为别名；在清除多个颜色附件时，清除颜色输出别名指向第一个目标。这些任务借用所有输入纹理，且永不销毁其分配。Mipmap 输出类型保留具体输入类型，以便连接后续消费方。

清除的默认值为 `color = { r: 0.2, g: 0.2, b: 0.3, a: 1 }`、`clearColor = true`、`convertColorToLinearSpace = false`、`clearDepth = false`、`clearStencil = false` 和 `stencilValue = 0`。至少需要一个非空的颜色目标列表或显式深度目标。不会使用颜色目标自身的隐式深度附件：请显式传入 `depthTexture`。每个绑定的附件必须具有匹配的尺寸和采样数。支持仅深度、仅模板和组合格式；缺少的方面（aspect）会被忽略，未选中的方面使用 `load` / `store`。深度清除使用深度目标的 `depthClearValue`，默认为反向 Z `0`。颜色转换仅对 RGB 应用 Babylon.js 默认的 gamma-2.2 线性化；Alpha 和输入颜色对象均保持不变。仅当实际选中某个颜色附件进行清除时，才会读取并转换颜色状态。

`record()` 在下游消费方录制之前准备借用的目标：它同步预分配目标，分配缺失的普通附件，并在解析尺寸变化时重建普通附件。分配所有权仍归调用方；销毁清除任务绝不会销毁其借用的目标。随后录制阶段创建一个对所有引用目标具有依赖关系的通道。其阶段 2 初始化器在所有生产方录制完成（包括可能替换分配的所属渲染任务）之后，先同步每个颜色和深度目标的 `_syncEager` 钩子，然后再验证和缓存最终附件视图。即使其源在同一次录制中或由更晚的任务调整了大小，这也会刷新借用方纹理包装器。普通目标在初始化期间不会再次重建；其分配保留在录制阶段。因此独立的“清除到拷贝”链在首次构建和调整大小时即可正常工作，无需单独的分配任务或手动构建目标。执行阶段修补实时附件视图和标量清除设置，开启并结束一个无绘制的渲染通道，并返回零次绘制。如果不存在任何选中的方面，执行阶段不发出任何 GPU 工作。运行时设置无需重建即可更改；更改目标身份或附件布局则需要重建图。MSAA 清除不会自动执行解析。

Mipmap 通道同样将准备工作推迟到阶段 2。它要求单采样、可过滤、可渲染且具有 `TEXTURE_BINDING | RENDER_ATTACHMENT` 用途和已分配 mip 级别的颜色纹理。交换链目标、深度/整数/压缩纹理以及 1D/3D 纹理会被显式报错拒绝。单层级的 1x1 纹理是合法的空操作；更大的单层级纹理会被拒绝。纹理数组和立方体贴图分配会使用 2D 视图独立重新生成每一层。准备阶段复用 `prepareMipmaps()` 来构建特定于 mip 的视图、管线、绑定组和描述符。执行阶段在当前帧编码器上调用 `recordPreparedMipmaps()`，对每个生成的层级的每一层返回一次绘制，并且不创建任何视图、绑定组、描述符、着色器或辅助命令提交。重建会释放先前的预准备 CPU 状态并重新绑定实时分配。`texture-formats-tier1` 特性仅对 8 位 snorm 格式启用基于渲染的 mip 生成。其六种 16 位归一化格式不可过滤，即使启用该特性也会被拒绝。执行阶段在编码链之前会检查一次已录制的分配身份。替换或销毁渲染目标分配，或替换 `Texture2D` 的底层纹理，都需要重建；否则任务会在编码过时的 GPU 绑定之前抛出异常。在其所属 API 之外直接销毁 GPU 纹理仍然受 WebGPU 自身验证的约束。

`createMipMappedRenderTarget()` 是一个显式启用的工厂，而不是添加到普通目标上的标志。它要求颜色格式和 `samples: 1`；可选深度保持单层级。它使用现有的预分配同步和附件销毁钩子，因此普通目标不会保留任何它的格式验证或生命周期策略。解析后的尺寸必须是不大于当前设备 `maxTextureDimension2D` 的正整数。在 GPU 分配前拒绝超大尺寸保留了回滚能力：WebGPU 验证失败无需同步抛出。附件分配描述符通过 `_createRenderTargetTextureDescriptor(descriptor, resolvedSize, format, usage)` 与普通目标以及固定/表面 RTT 共享。颜色和深度分配都复用解析后的尺寸，而不是创建单独的尺寸字典。普通分配器原样使用该描述符。只有该显式启用的工厂会添加 `mipLevelCount`，因此普通场景不会保留任何可选 mip 计数参数或描述符属性。深度分配在临时仅深度描述符上使用 `buildRenderTarget(rt, engine)` 并保持单层级。通用分配器创建默认视图且不导入任何 mipmap 生成代码。普通单层级目标对渲染和采样使用同一个视图。

在首次构建或尺寸/设备/格式发生变化时，mipmapped 工厂创建一个临时普通深度目标，然后使用共享颜色描述符添加带有 `floor(log2(max(width, height))) + 1` 个层级的颜色纹理。其默认的完整链颜色视图成为 `_colorSamplingView`；额外的仅 mip-0 视图成为用于渲染附件的 `_colorView`。拷贝 blit 和通用后处理采样器使用 `_colorSamplingView ?? _colorView`，因此显式 LOD 和基于导数的 LOD 都可以访问生成的 mip，同时附件视图保持有效。额外后处理纹理遵循相同的规则。只有完整构建才会将其附件、视图和尺寸发布到实时目标。失败会销毁临时目标并保留之前的分配。未更改的构建复用现有分配。销毁会释放所拥有的附件一次并阻止重建。该工厂返回一个渲染目标（而不是 RTT 可采样外观）；后处理和拷贝任务可以直接消费它。通常由一个渲染任务拥有其生命周期。

```typescript
const target = createMipMappedRenderTarget({
    format: "rgba8unorm",
    samples: 1,
    size: scene.surface,
});
const clear = createClearTextureTask({ targetTexture: target }, engine, scene);
const render = createRenderTask({ name: "producer", rt: target, clr: false }, engine, scene);
const mips = createGenerateMipMapsTask({ targetTexture: target }, engine, scene);
addTaskAtStart(scene, clear);
addTaskAfter(scene, render, clear);
addTaskAfter(scene, mips, render);
```

专项测试覆盖了默认值/输出别名、MRT/深度/模板选择与保留、实时清除设置和交换链视图、附件兼容性、阶段 2 分配顺序、执行门控、所有权/销毁、mip 层级和数组层覆盖、当前编码器顺序、零每帧 GPU 对象创建、不支持资源的拒绝、过时分配拒绝、完整链消费方采样、重建，以及显式启用分配/tree-shaking。

### 图像处理任务（Image Processing Task）

```typescript
export type ImageProcessingSource = Texture2D | RenderTarget | (() => Texture2D | RenderTarget | null | undefined);

export interface ImageProcessingTaskConfig {
    name?: string;
    source: ImageProcessingSource;
}

export function createImageProcessingTask(config: ImageProcessingTaskConfig, engine: EngineContext, scene: SceneContext): Task;
```

`createImageProcessingTask()` 是一个可复用的全屏后处理任务。在 `record()` 期间，它将 `config.source` 解析为 `Texture2D` 或 `RenderTarget`，读取源的 `GPUTexture.sampleCount`（默认回退到 `1`），构建匹配的绑定组布局，并创建一个以交换链格式为目标的全屏三角形管线。在 `execute()` 期间，它将 `scene.imageProcessing.exposure`、`scene.imageProcessing.contrast` 和 `scene.imageProcessing.toneMappingEnabled` 写入一个 16 字节的 uniform 缓冲区，用 `scene.clearColor` 清除交换链，采样源纹理，应用曝光/色调映射/Gamma/对比度，并向当前交换链视图绘制一个三角形。

该着色器有两种源变体：

- 单采样：`texture_2d<f32>` 配合 `textureLoad(source, pixel, 0)`
- 多重采样：`texture_multisampled_2d<f32>` 配合 `textureNumSamples(source)`；每个采样点独立进行图像处理，然后将处理后的颜色求平均

该任务仅拥有自己的管线、绑定组和 uniform 缓冲区。它不拥有源纹理。在图重建时，`record()` 会销毁先前的 uniform 缓冲区，并基于 getter 返回的最新源进行重建。

透射（Transmission）使用此任务作为其最终交换链通道。`enableSceneTransmission(scene, engine)` 将渲染任务重定向到线性 `rgba16float` 离屏输出，然后在尚未存在时，于最后一个渲染任务之后追加一个 `"transmission-image-processing"` 任务。MSAA 场景直接由 MSAA 颜色纹理向图像处理任务提供输入，因此不存在额外的最终解析纹理或 `*-transmission-scene` 目标。

透射折射纹理仅分配折射着色器固定 `-4.0` LOD 偏置所能到达的 mip 层级。对于当前的 1024x1024 折射纹理，这意味着 7 个层级（`0..6`）而非完整的 11 层级链，并且 mip 生成仅录制这些已分配的层级。设置了 `transmission.generateMipmaps = false` 的任务仅分配 mip 0 并跳过此生成步骤。

### SMAA 任务

`createSmaaPostProcessTask()` 将空间 SMAA 实现为三个有序的全屏通道：

1. 亮度边缘检测使用线性采样读取最终颜色源，并写入 `rgba8unorm` 边缘目标。
2. 混合权重重建使用最近邻采样精确读取边缘纹素，搜索每条边缘连续段，并写入 `rgba8unorm` 权重目标。
3. 邻域混合读取原始颜色和权重，然后写入抗锯齿输出。

源必须是单采样 `RenderTarget`；请在录制任务之前解析 MSAA。SMAA 是感知滤波器，因此请将其放在色调映射之后、帧图链的末尾。当源使用 sRGB 视图时请设置 `sourceIsSrgb`，以便边缘检测在应用亮度阈值之前重新编码采样值。该任务暴露 `outputTexture`、`edgesTexture` 和 `weightsTexture`；中间目标可用于诊断，并由任务拥有和销毁。

公共控制项包括 `threshold`、`maxSearchSteps`、`diagonalDetection`、`minDiagonalRun`、`cornerDetection`、`dominantAxisBlend` 和 `sourceIsSrgb`。更改其中任意项后，一旦图已录制，请调用 `updateUniforms()`。搜索步数和最小对角连续长度是以额外纹理读取换取更长模式重建的权衡。简化的对角路径默认禁用，因为它可能对相邻对角边缘通道进行双重处理；仅对真正以 45 度结构为主的内容启用它并测量结果。拐角模式衰减也是显式启用的：它使用参考 SMAA 的 25% 拐角圆滑预设，且仅在启用时对每个处理轴额外增加四次边缘纹理读取。

此实现不携带参考 Area/Search 查找纹理。它在权重通道中解析地重建覆盖率并直接搜索，使运行时保持自包含。不实现预测（predication）、模板优化和时间 SMAA 模式；需要时间超采样时请使用 TAA。场景 187 提供了一个确定性的并排压力测试场景，并仅在带有 `?debug=1` 时加载其参数 UI。

### 场景纹理透射（Scene-Texture Transmission）

`enableSceneTransmission(scene, engine)` 包装每个 `RenderTask`，而不是向渲染器添加特定于材质的行为：

1. 在任务录制之前，它使用 `engine.msaaSamples` 将交换链输出重定向到线性离屏 `rgba16float` 渲染目标，为该任务创建一个共享的 1024x1024 透射纹理，并将其存储在 `task._targetSignature._transmissionTexture` 上。
2. 随后原始的 `RenderTask.record()` 针对该目标签名绑定 renderable。PBR 透射 renderable 此时创建其材质绑定组，捕获共享透射纹理；没有逐次绘制的透射绑定组变更。
3. 在 `record()` 构建完渲染目标之后，透射将 `rt._colorTexture` 存为源。如果源是 MSAA 或尺寸与透射纹理不同，它会为本次图构建一次性创建全屏 blit 管线和绑定组；否则执行时可以直接使用 `copyTextureToTexture()`。
4. 在执行期间，渲染任务为不透明 bundle 和直接绘制分桶开启一个通道，然后遍历单个按相机排序的透明列表。在遇到 `_transmissive` 绑定之前，当 `copyCount` 允许时，会结束通道，将当前离屏颜色拷贝/blit 到共享透射纹理中，生成可选的 mip，并以 `loadOp: "load"` 恢复任务。剩余的透明和透射绑定继续走同一循环。

这使得折射纹理和所有绑定组在图重建之间保持稳定。`copyCount: 0` 在每次透射绘制前刷新；有限值在达到上限后停止刷新，并使用最后一次快照绘制排序后的其余透明/透射列表。

### 默认场景通道

`createSceneContext(engine)` 默认创建此任务；对于自行提供最终交换链任务的场景，`createSceneContext(engine, { defaultRenderTask: false })` 会跳过它：

```typescript
const msaa = surface.msaaSamples > 1;
const rt = msaa
    ? createRenderTarget({
          lbl: "scene-color",
          format: surface.format,
          dFormat: "depth24plus-stencil8",
          samples: surface.msaaSamples,
          size: surface,
      })
    : surface.scRT;
const depth = msaa ? undefined : createRenderTarget({ lbl: "scene-depth", dFormat: "depth24plus-stencil8", samples: 1, size: surface });

_createAutomaticRenderTask({ name: "scene", rt, rst: msaa ? surface.scRT : undefined, depth }, engine, scene);
```

除非 `autoMirror: false`，否则此任务以场景镜像模式启动。当 `addMeshToTask` 提交添加时，任务会选择显式填充模式。如果因网格添加/移除/材质交换导致场景 renderable 版本号变化，处于场景镜像模式的任务会重新同步并重新绑定其绘制列表。刻意留空的非镜像列表在多次录制之间保持为空；提供借用 renderable 的内部调用方会选择 `autoMirror: false`。

`RenderTask.enabled` 默认为 `true`。禁用的任务会在逐通道更新之前退出，不会加载附件、解析 MSAA 或发出绘制。

### 显式任务填充

渲染任务可以通过以下方式显式填充：

```typescript
addMeshToTask(task, mesh);
addMeshToTask(task, mesh, { material: overrideMaterialOrView });
```

对于大型编辑器选区，请使用根导出的批量 API：

```typescript
addMeshesToTask(task: RenderTask, meshes: readonly Mesh[], opts?: { material?: Material }): void;
removeMeshesFromTask(task: RenderTask, meshes: readonly object[]): void;
```

批量添加保留输入顺序，并在未提供覆盖材质时跳过没有材质的网格。在录制之前它仅将请求加入队列；在活动任务上它会构建一个候选代次并一次性绑定，而不是逐个网格绑定。如果构建或绑定失败，活动代次和原始待处理队列保持不变：该批次中的任何内容都不会保留用于重试。这不同于失败的单次添加，后者会保留其请求用于重试。启用了刷新的任务还会回滚新跟踪的网格和刷新脏状态；它们的批量钩子像单次添加一样对被跟踪网格去重，而覆盖请求则保留重复项。特定于任务的填充策略提供匹配的批量钩子，以保留刷新和材质视图语义。

批量移除使用成员集合，并对待处理列表、renderable 列表和三个绑定列表执行稳定的原地压缩。它回收被移除的自有资源和绑定批次，然后一次性选择/释放更新批次状态，并且仅在移除了活动条目时使 bundle 失效。源列表移除钩子仍按输入顺序运行；刷新跟踪拥有其自己基于集合的批量移除钩子。重复或不存在的网格是无害的。空数组不做任何事（不启用填充），两个批量 API 均会拒绝已销毁的任务。

**破坏性 API 迁移：** 将 `task.addMesh(mesh, options)` 替换为从 `@babylonjs/lite` 导入的 `addMeshToTask(task, mesh, options)`。构造函数以及同步队列/实时添加行为保持不变。场景镜像通道不再仅仅因为导入了 `createRenderTask` 而保留辅助网格构建、所有权或事务代码。

`addMeshToTask()` 接受源材质或 `MaterialView`。重建解析使用已完成的场景局部材质组的 `r` 闭包。没有 `r` 的现有组尚未就绪：绝不能回退到另一个场景缓存的构建器级闭包。只有显式标记了 `_sceneIndependentRebuild` 的构建器（独立几何视图工厂）才可以在没有场景组时使用 `_rebuildSingle`。普通任务填充、刷新和显式材质重建共享 `material/resolve-mesh-rebuild.ts` 的 `resolveMeshRebuild(scene, builder)` 解析器。传入材质视图允许通道以特定于通道的渲染特性位复用源材质状态，例如由 PCF 阴影渲染任务使用的 Standard/PBR/Node 无颜色阴影变体。

在任务首次 `record()` **之前**进行的添加会先排队，并在 `record()` 时排空。队列仅在启用显式填充时分配；仅调用 `createRenderTask()` 和幂等移除不会保留队列。**运行时**添加（在 `record()` 之后，任务已发布其场景绑定组后）会立即解析网格并将其重新分桶到该任务中，使其在下一帧无需调用 `frameGraph.build()` 即可渲染——完整重建会在帧中重新分配共享场景 UBO 和每个任务的渲染目标。

如果任务拥有显式 renderable，它就**不会**自动镜像场景。

场景的自动渲染任务借用 renderable 并使用轻量级的 `render-task-base.ts` 路径。它没有显式网格填充 API，也没有对辅助所有权或 `render-task-transaction.ts` 的静态依赖。共享的通道执行、目标处理、绑定分桶、移除和 GPU 回收都保留在基础路径中。公共 `createRenderTask` 也使用此路径。`addMeshToTask` 在首次使用时安装一个可选的显式录制接缝和排队策略，同时保持任务稳定的 `record` 函数不变。因此，无论填充发生在包装器安装之前还是之后，透射和其他包装器都能正常组合，而仅使用 `createRenderTask` 的打包产物不保留事务代码。公共移除和场景移除使用相同的基础列表驱逐逻辑。基础移除和销毁路径仅回收携带所有者提供的生命周期销毁器接收器的 renderable，因此自动借用的 renderable 保持不受影响，且早先捕获的 `dispose` 函数也能观察到后来添加的所有权。目标所有权在创建时从 `sharedRt` 捕获，并在录制和销毁时一致使用；随后对配置的修改不能静默改变哪个任务拥有附件。稳定的场景 UBO 从创建起即归任务所有。其场景绑定组和共享灯光缓冲区绑定在首次录制时通过灯光变化时使用的同一刷新路径进行解析。材质绑定先构建，因为 `Renderable.bind` 不消费 group 0。场景绑定组刷新是最后一个可失败的录制步骤：它在赋值给任务拥有的 `_lightsUBO` / `_sceneBG` 之前先创建新的绑定组，因此失败会保留旧的根绑定和旧的绘制代次。通道尺寸和描述符仅在此成功后才更新。

公共显式任务和启用了刷新的显式任务共享 `render-task-transaction.ts`。每个辅助 renderable 都有一个任务拥有的生命周期销毁器列表。材质族的 `MeshRebuilder(scene, mesh, materialOverride?, resources?)` 通过 `MeshRebuildResources` 显式接收这些列表。当存在 `resources` 时，构建器在后续可失败工作之前将分配释放注册到 `resources._lifetimeDisposers`，而绝不会注册到场景的主网格销毁器映射中。绑定期间创建的缓存资源在属于该 renderable 时也使用此生命周期列表。绑定代次工作由 `DrawUpdateBatch` 及其特性拥有的 `DrawBatchState` 表示；不存在第二套未使用的回调代次账本。可失败的生产方在抛出异常前释放未发布的私有分配。不带资源所有者的调用保留普通场景拥有的构建逻辑。Rebuilder 包装器必须原样转发所有者。因此主场景材质交换无法释放显式任务的 UBO 或纹理租约，显式任务也不再临时重写场景销毁器映射。辅助所有权直接存储在每个任务拥有的 `Renderable` 上；其现有的 `mesh` 和 `_lifetimeDisposers` 字段即可提供成员关系和清理能力，而无需平行的所有权列表。`autoMirror` 是构造模式；第一次成功提交的显式添加会永久将任务切换为显式模式，即使最后一个自有 renderable 被移除后也是如此。每次解析尝试单独收集其确切的新 renderable，因此回滚仅释放未发布的分配，而已转移的 renderable 保持不受影响。每个材质重建器都为其传入的生命周期接收器返回一个全新的 renderable 实例；共享管线和视图缓存不会共享 renderable 本身。因此填充直接追加每个重建条目，而不是对先前解析过的网格做二次方复杂度的身份扫描。

待处理的添加和源 renderable 暂存在一个类型化的 `RenderTaskPopulation` 中，它不包含任务方法、门控、包装器、描述符或上下文。绑定产生一个单独的 `RenderTaskBindingGeneration`，包含源列表、opaque/direct/transparent 分桶、bundle 缓存、批次状态和版本键。它是脱离任务的暂存值，而非持久嵌套状态。绑定直接填充该候选对象，没有第二层元组容器。其源版本快照在目标准备和材质绑定之前捕获，因此改变场景的回调不会错误地将这些新 renderable 标记为已同步。只有当完整重建、场景 BG 刷新以及描述符/上下文更新全部完成后，才使用 `Object.assign` 将其已知的绘制字段发布到任务上。场景绑定和更新上下文保持任务所有，因为它们具有独立的生命周期。不存在镜像或嵌套的权威副本。

失败的尝试仅释放由该次填充创建的销毁器接收器，保留先前的绘制字段身份，并保留待处理请求以供重试。包装器和门控变更始终作用于实时任务本身，绝不会从候选对象复制。网格刷新仅在真正需要重建时暂存精确替换品，并在绘制字段发布后回收它们；异步准备构造相同的类型化填充但不发布它。CSM 转移为每个源/目标准备一个填充和代次，在回收先前的批次状态之前先分配每个任务的暂存绘制字段，并在回滚期间保留所有源批次状态。重新绑定保留的 renderable 仅替换其绑定批次状态；缓存的 renderable 生命周期资源得以保留。移除网格或销毁任务会在已提交的 GPU 工作排空后回收其拥有的回调。场景镜像的 renderable 保持借用状态。几何任务使用相同的显式生命周期接收器。接收器在每次几何重建前暂存，并在绑定前附着到 renderable；回滚释放每一个未发布的接收器，包括重建或绑定失败的接收器。已发布的几何批次在队列栅栏之后回收。任务的网格移除钩子即使在渲染停止时也会立即驱逐并回收所有匹配条目。共享几何视图资源仅由其 renderable 所有者进行引用计数；不存在隐式视图租约或场景辅助注册表。轻量级自动路径同样发布完整的绑定分桶，而不是在绑定失败后保留部分构建的绘制列表。它不获取辅助所有权。显式填充启用器安装 renderable 回收接缝。自动渲染仅在移除/销毁期间调用该可选接缝，且不会为借用的 renderable 保留生命周期列表处理或资源代次快照辅助函数。Standard 和 PBR 在每次分配完成之后、绑定组创建之前注册 UBO 释放。Standard 的可选 UV UBO 加入同一所有权列表。失败的初始 uniform 上传会在传播错误前销毁刚创建的缓冲区。任务清理通过引擎回收服务对回调/可销毁对象批次进行快照。立即回滚和带栅栏的清理共享其报错运行器；destroy 方法保留其接收者，而在回收之后追加的回调会等待后续批次。

更新批次收集与生命周期处理属于 `render/draw-update-batches.ts`，由 uniform 拷贝和计算派发批次工厂激活。它们在任务的目标签名上安装 `_collectBatches`。普通任务不携带更新批次数组或批次差分算法。当绑定暴露更新批次时，收集器构建一个任务局部的 `DrawBatchState`，其中包含去重后的活动批次引用以及重置、刷新、选择和释放操作。该状态在收集后不可变：移除操作会构建一个新的选择集合，而不是修改已发布的状态。候选回滚仅释放保留状态中不存在的批次；成功提交仅回收新活动状态中不存在的批次。多任务转移提供所有活动状态，以便当目标绑定失败时，从源借用的批次不会被销毁。对于没有更新批次的绑定不创建任何状态，且非活动特性不执行批次重置/刷新工作。普通渲染器调用可选钩子而无需导入其实现。

转移操作会将所有权条目连同其 renderable 一并移动。目标绑定在受影响的任务之间具有事务性；失败会使源所有权和绘制列表保持完好。批量的 CSM 转移暂存所有移动并一次性绑定每个目标。异步着色器准备使用临时的辅助 renderable，而不消耗任务的待处理请求。该准备辅助函数由异步着色器显式启用项导入，不会附着到每个渲染任务上。自动录制和显式录制共享目标、描述符和尺寸准备；显式事务仅在绑定和场景 BG 刷新成功后才更新任务拥有的上下文。

显式任务通常保持由 `addMeshToTask()` 解析得到的 renderable。在运行时替换网格几何体、更改网格材质或跨过 1 更改网格不透明度（`1 ↔ <1`）的应用可以让任务选择性地跟随相应的场景 renderable 重建：

```typescript
const task = createRenderTask({ name: "dynamic", rt, autoMirror: false }, engine, scene);
enableRenderTaskMeshRefresh(task);
addMeshToTask(task, dynamicMesh);
```

`enableRenderTaskMeshRefresh()` 必须在任务录制之前运行。它仅跟踪未带逐任务材质覆盖而添加的场景拥有网格。它通过已注册的材质族重建钩子为每个被跟踪网格构建一个辅助单网格 renderable，因此显式任务绝不会从合并的场景 renderable 中继承未被跟踪的兄弟网格。任务认领并拥有这些辅助销毁器，在 `scene._renderableVersion` 变化时重建它们，并在已提交的 GPU 工作排空后回收被替换的资源和绑定更新批次。该启用器仅包装选定的任务；未导入它的应用保留基础渲染任务和材质 renderable 的打包体积占用。

刷新是一个“先构建后提交”的事务。在发布新的绘制字段之前，所有被跟踪的替换品、其显式生命周期销毁器接收器及其绘制绑定都会先准备好。如果任何重建或绑定抛出异常，临时资源会被清理，先前的任务列表、绑定、所有权和版本号保持不变以供重试。只有完整替换才会回收上一代资源。在整个任务构建期间，场景拥有的主销毁器列表完全不受触动。未完成的场景局部材质构建会抛出同步就绪错误。被跟踪或待处理的添加将继续留在队列中，等待该构建完成后的下一次 `record()` / 刷新重试；它既不会发布部分绑定，也不会启动另一次异步材质构建。待处理的材质覆盖参与同一个事务，包括在启用刷新之前排队的覆盖以及实时的 `addMeshToTask(task, mesh, { material })` 调用。失败的尝试保留待处理队列不变，仅清理新创建的资源。已提交的覆盖在网格移除或任务销毁前保持归任务所有；后续的绑定尝试暂存其特性拥有的批次资源。

renderable 生命周期资源与绑定代次批次资源相互分离。对保留覆盖的成功重绑定会回收其上一个绑定代次，并仅保留新代次。失败的尝试仅销毁候选绑定并恢复上一代。renderable 构建和惰性缓存的 renderable 资源保持存活，直到该 renderable 被替换或移除；缓存的剔除状态使用显式生命周期销毁器接收器。

### 分桶与绘制执行

在录制/重新同步时，`RenderTask` 通过调用以下方法将 renderable 转换为 `DrawBinding`：

```typescript
const binding = renderable.bind(engine, targetSignature);
```

在 `record()` 期间，任务构建/刷新其目标，暂存绑定，刷新场景绑定组，然后发布描述符/尺寸和绘制代次状态：

```typescript
task._updateContext.targetWidth = rt._width;
task._updateContext.targetHeight = rt._height;
Object.assign(task, generation);
```

绑定被划分为：

| 分桶        | Renderable 标志                    | 执行方式                                                          |
| ----------- | ---------------------------------- | ----------------------------------------------------------------- |
| Opaque      | `!isTransparent && !_direct`       | 缓存的 `GPURenderBundle`                                          |
| Direct      | `_direct`                          | 在不透明之后直接绘制                                              |
| Transparent | `isTransparent \|\| _transmissive` | 在 direct 之后直接绘制，每帧按相机空间深度从后向前排序            |

Opaque 和 direct 分桶当前按 `renderable.order` 排序。Transparent 按当前通道相机的相机空间深度排序，且不得按管线排序。

`DrawBinding.pipeline` 是强制性的。逐通道编码器主体拥有 `setPipeline()`，并在调用绑定的 `draw()` 闭包之前对具有相同管线的连续绑定进行去重。

`_lastVersion` 专指在构建活动绑定代次之前捕获的场景 renderable 版本号。`prepareRenderTaskPass()` 将其与 `scene._renderableVersion` 进行比较以用于自动镜像源同步，而 `enableRenderTaskMeshRefresh()` 使用同一快照来检测影响其被跟踪网格的更改。普通绘制主体和透射绘制主体都不会覆盖它。不透明 bundle 失效是独立的：新绑定代次发布一个全新的 `_ob`，显式失效清除 `_ob`，而 `_lastVis !== _vis` 处理全局可见性/资源更改。仅替换任务的 group-0 灯光缓冲区会清除 `_ob`，使下一个 bundle 捕获新的场景绑定组，但保持 `_lastVersion` 和所有材质绑定完好无损。因此它不会触发冗余的自动重绑定或显式网格刷新。

每帧在开启通道之前，`RenderTask.execute()` 在编码器之外运行通道前工作：

1. 如果场景的 `_renderableVersion` 发生变化，自动重新同步 renderable 列表。
2. 如果场景级灯光缓冲区被替换，刷新任务的场景绑定组。这仅清除 `_ob`；源/材质绑定保持同步。
3. 写入逐任务场景 UBO，刷新场景级灯光 UBO，设置 `_updateContext._camera`，并为 opaque、direct 和 transparent 绑定调用 `binding.update?.(_updateContext)`。这会使用通道目标尺寸刷新脏的逐绑定 UBO，同时允许不透明渲染 bundle 保持缓存。
4. 在更新之后（以便 renderable 先刷新 `_worldCenter`），从活动相机按从后向前排序透明绑定。
5. 使用实时目标视图、可选解析视图、清除颜色以及清除/加载操作修补任务拥有的颜色附件。

随后 `RenderTask.execute()` 调用 `beginRenderPass(task._renderPassDescriptor)`，执行不透明 bundle 以及 direct 和 transparent 绘制列表，然后结束通道。其 `_passes` 数组不参与其中。

### 按需过绘制（Overdraw）开销探测

```typescript
export interface OverdrawCostMeasure {
    width: number;
    height: number;
    sampleCount: number;
    bindings: number;
    msAsIs: number;
    msVisibleOnly: number;
    overdrawMs: number;
    ratio: number;
    msFrontToBack: number;
    sortGainMs: number;
    repeats: number;
}

export function measureRenderTaskOverdrawCost(engine: EngineContext, task: RenderTask, options?: { repeats?: number }): Promise<OverdrawCostMeasure>;
```

`measureRenderTaskOverdrawCost()` 是针对先前已渲染任务的显式仅诊断探针。它把任务当前的可见绑定重放到与任务颜色、深度、采样数、视口和场景绑定组相匹配的瞬态附件中。每次重复记录三个带时间戳的通道：按原发货顺序配合全新深度、针对第一个通道的最终深度使用相同绑定，以及在保留透明顺序的同时按从前向后排序 opaque/direct 绑定。返回的中位数用于估算当前被遮挡片段的着色预算，以及通过逐次绘制排序可回收的部分。

该探针需要可选的 WebGPU `timestamp-query` 特性、具有真实深度方面的颜色目标、已填充的绘制绑定以及正整数重复次数。它会拒绝配置了 `depthClear: false` 的叠加层任务以及使用预分配外部深度的任务，因为它们原通道会加载预先存在的深度，而瞬态全新深度重放无法复现这一点。它不刷新绑定状态，并且有意等待 GPU 回读，因此调用方仅在任务渲染之后运行它，绝不在生产帧循环中调用。该模块没有状态或导入时副作用；重型诊断实现仅在调用该公共函数时才动态导入，因此未使用的场景不会保留任何探针运行时代码。

## 逐通道场景 UBO

每个 `RenderTask` 拥有：

- `_sceneUBO`
- `_sceneBG`
- `_lightsUBO`
- `_updateContext`
- `_suData` 暂存区
- `_sceneUboCacheKey` 脏检查缓存

`writePassSceneUBO()` 写入规范的 352 字节 `SceneUniforms` 布局：

| 浮点偏移 | 字段                 |
| -------: | -------------------- |
|        0 | `viewProjection`     |
|       16 | `view`               |
|       32 | `vEyePosition`       |
|       36 | `envRotationY`       |
|       40 | 球谐函数系数         |
|       76 | `exposureLinear`     |
|       77 | `contrast`           |
|       78 | `lodGenerationScale` |
|       80 | `vFogInfos`          |
|       84 | `vFogColor`          |

当相机、雾、宽高比、曝光、对比度和环境纹理身份均未变化时，写入器在触碰暂存区/GPU 之前直接退出。环境旋转由显式启用的环境贡献者写入；`setEnvironmentRotation` 在动态更新前显式使任务局部缓存失效。

离屏目标和交换链目标使用相同的正向投影和逆时针正面约定。不存在目标签名或描述符翻转标志；下游拷贝/后处理采样会统一处理纹理坐标约定。

## 用法：离屏通道喂给材质

场景 110 演示了核心模式：

```typescript
const { rt, texture } = createRenderTargetTexture(engine, {
    lbl: "r1",
    format: engine.format,
    dFormat: "depth24plus-stencil8",
    samples: 1,
    size: { width: 512, height: 512 },
});

const consumerMaterial = createStandardMaterial();
consumerMaterial.diffuseTexture = texture;

const rttCamera = createFreeCamera({ x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 0 });
const task = createRenderTask({ name: "r1", rt, cam: rttCamera, clrColor: { r: 0.1, g: 0.1, b: 0.3, a: 1 }, cs: true }, engine, scene);

addTaskAtStart(scene, task);
addMeshToTask(task, sourceMesh, { material: overrideMaterial });

await registerScene(scene);
await getFrameGraph(scene).build();
await startEngine(engine);
```

其工作原理：

1. `createRenderTargetTexture()` 预分配纹理，以便 `consumerMaterial` 可以在其绑定组中捕获它。
2. `addTaskAtStart()` 使 RTT 通道在默认场景通道之前运行。
3. `addMeshToTask()` 仅将选定网格渲染进 RTT。
4. 默认场景通道随后采样产出的纹理。

## 场景移除与材质交换

`removeMeshFromTask(task, mesh)` 将网格从任务的源 renderable 列表和分桶绑定中移除。场景移除会为帧图渲染通道任务调用此方法，使已移除的网格不会继续绘制。

材质交换使用场景材质交换队列以及每个材质构建器的 `_rebuildSingle` 钩子。自动镜像的 `RenderTask` 会注意到 `_renderableVersion` 变化并重新绑定其绘制列表。

## 调整大小与重建

`resizeEngine(engine)` 更新画布后备存储并调用每个已注册渲染上下文的 `_resize()` 钩子。对于场景，`_resize()` 会重建帧图，使画布尺寸的渲染目标以新尺寸重新分配。

固定尺寸的预分配 RTT 不会在图重建时重新分配，因为它们的 GPU 纹理句柄可能已被材质绑定组捕获。

## 设计边界

- 帧图是有意设计为有序的，而非依赖求解的。调用方必须将生产方插入在消费方之前。
- 未来的节点渲染图如果要在 Lite 中实现，它将是一个独立的更高层 DAG，最终生成此有序任务列表。
- `RenderTask` 是主要的具体场景渲染任务，`EffectRenderTask` 是全屏效果 RTT 任务。随着帧图覆盖范围扩大，预期会有新的 `Task` 实现。
- `RenderPass` 是目前唯一的具体通道，由基于通道的任务使用。`RenderTask` 直接执行，不合成通道对象。
- 渲染目标是具体对象。目前尚未有虚拟资源别名或自动生命周期分析。`Pass._dependencies` 为未来的纹理管理器记录，但目前 Lite 中尚无任何代码读取它。
- `pass._renderTarget` 和 `RenderTaskConfig.rt` 有意直接接受 `RenderTarget` 而非数字 `TextureHandle`。句柄 + 虚拟化将作为后续步骤引入；通道接口将在已知调用点上通过类型参数变更来吸纳它。
- `addMeshToTask()` 依赖材质族重建钩子，因此要求该网格/材质族属于场景构建的一部分。
- 透明绑定仅按相机距离排序；它们不按管线合批。

## Babylon.js FrameGraph 对照表

| Babylon.js 概念                 | Babylon Lite                                               |
| ------------------------------- | ---------------------------------------------------------- |
| Frame graph                     | 有序的 `FrameGraph._tasks`                                 |
| `frameGraph.tasks`              | `getFrameGraphTasks(frameGraph)`（只读实时视图）           |
| Frame graph task                | `Task`（带有 `_passes: Pass[]`）                           |
| `IFrameGraphPass`               | `Pass`                                                     |
| `FrameGraphRenderPass`          | `RenderPass`（无共享渲染上下文）                           |
| `frameGraph.addRenderPass`      | `addRenderPass(target, name)`                              |
| `addDependencies`               | `addPassDependencies(pass, deps)`（提升至基类）            |
| Render pass task                | `RenderTask`                                               |
| `FrameGraphClearTextureTask`    | `createClearTextureTask()`                                 |
| `FrameGraphGenerateMipMapsTask` | `createGenerateMipMapsTask()`                              |
| 纹理/资源句柄                   | 目前为具体的 `RenderTarget`                                |
| 任务录制/构建阶段               | 通过 `FrameGraph.build()`（阶段 1）调用 `Task.record()`    |
| 通道录制后初始化                | 通过 `FrameGraph.build()`（阶段 2）调用 `Pass._initialize()` |
| 逐帧执行阶段                    | 存在时调用 `Task.execute()`；否则遍历 `_passes`            |
| 内置直接任务工作                | 可选 `Task.execute()`                                      |
| 渲染目标纹理                    | `createRenderTargetTexture()`                              |
| 逐通道相机/场景 UBO             | `RenderTaskConfig.cam` + 任务拥有的 `_sceneUBO`            |

## 任务发现测试规范

- 根导入和生成的声明文件精确暴露 `getFrameGraphTasks(frameGraph: FrameGraph): readonly Task[]`；不通过此 API 泄漏任何内部任务存储或 GPU 类型。
- 图和场景的 `addTask()` 调用保留插入/构建/执行顺序，包括场景的默认渲染任务和前置阴影适配器。
- 实时数组在追加、头部/之前/之后插入、移除（含重复项）以及图销毁期间保持同一数组实例。
- 已禁用的任务保持可见。真实的泛光复合任务只出现一次，且不暴露其私有拥有的子任务。
- 独立 `FrameGraphContext.frameGraph` 可枚举。销毁会清空保留的数组，并仅销毁仍由图拥有的任务。
- 专项帧图单元测试和公共 API 构建测试强制执行该契约；过滤后的 scene1 运行时打包对比验证未使用发现 API 时增加零字节。CI 负责视觉/一致性及更广泛的场景覆盖。

## 文件清单

| 文件                                         | 用途                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/frame-graph/task.ts`                    | 多态任务接口（现带有 `_passes: Pass[]`）                                                   |
| `src/frame-graph/pass.ts`                    | `Pass` 基础接口、`addPassDependencies`                                                     |
| `src/frame-graph/render-pass.ts`             | `RenderPass` 接口、`createRenderPass`、`setRenderPass*` setter                             |
| `src/frame-graph/frame-graph.ts`             | 有序任务列表、只读实时发现与两阶段 build/execute/dispose 生命周期                          |
| `src/frame-graph/frame-graph-actions.ts`     | 公共任务插入 + `addRenderPass` 操作                                                        |
| `src/frame-graph/render-task-base.ts`        | 直接 RenderTask 目标准备、场景 UBO/绑定、绘制分桶、描述符、执行                            |
| `src/frame-graph/render-task.ts`             | 公共任务工厂以及惰性安装的显式网格填充接缝                                                 |
| `src/frame-graph/render-task-transaction.ts` | 类型化的脱离任务填充/绑定暂存、回滚和已知字段发布                                          |
| `src/frame-graph/overdraw-probe-run.ts`      | 仅由公共 GPU 计时诊断探针加载的时间戳查询重放实现                                          |
| `src/frame-graph/image-processing-task.ts`   | 用于交换链输出的可复用全屏图像处理任务                                                     |
| `src/frame-graph/clear-texture-task.ts`      | 带实时设置的无绘制颜色/MRT、深度和模板清除                                                 |
| `src/frame-graph/generate-mipmaps-task.ts`   | 在帧编码器中预准备的原地 mip 生成                                                          |
| `src/frame-graph/texture-task-pass.ts`       | 延迟纹理通道初始化和共享通道生命周期                                                       |
| `src/engine/render-target-mipmaps.ts`        | 通过现有目标钩子实现的显式启用完整 mip 链渲染目标分配                                      |
| `src/texture/mipmap-format.ts`               | 感知设备特性的可过滤/可渲染颜色格式谓词                                                    |
| `src/frame-graph/shadow-task.ts`             | 通过 `Task.execute()` 调度现有阴影生成器的内部适配器任务                                   |
| `src/engine/render-target.ts`                | 渲染目标/签名状态以及附件分配和销毁                                                        |
| `src/engine/render-target-signature.ts`      | `RenderTargetSignature` 的管线缓存键序列化                                                 |
| `src/texture/rtt.ts`                         | 预分配渲染目标纹理辅助函数                                                                 |
| `src/render/renderable.ts`                   | 渲染通道任务消费的 `Renderable`、`DrawBinding` 和 `DrawUpdateContext` 契约                 |
| `src/render/lights-ubo.ts`                   | 拆分后的场景灯光、网格布局和网格选择辅助函数的兼容外观模块                                 |
| `src/render/scene-lights-ubo.ts`             | 场景拥有的共享灯光 GPU 状态、上传刷新和任务相机灯光数据写入器                              |
| `src/render/mesh-light-layout.ts`            | 网格灯光 UBO 字段和 WGSL 打包索引访问器                                                    |
| `src/render/mesh-light-selection.ts`         | 逐网格灯光过滤和打包索引写入                                                               |
