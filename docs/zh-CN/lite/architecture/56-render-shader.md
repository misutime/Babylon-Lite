# 模块：渲染着色器（自定义渲染 Pass）

> 包路径：`packages/babylon-lite/src/render-shader/`

## 用途

在不暴露原始 GPU 句柄且不在帧图之外创建第二套调度器的前提下，向用户暴露自定义渲染 Pass（实例化绘制、索引绘制、间接绘制、任意 WGSL 以及任意渲染目标格式）。它是计算模块（`54-compute.md`）在渲染 Pass 侧的姊妹模块，并遵循相同的模型：

- `RenderShader`：不可变程序（包含顶点和片元入口点的 WGSL）、绑定布局、顶点缓冲区布局以及固定管线状态。管线按渲染目标签名进行编译。
- `RenderBindingSet`：用于单个程序的不可变可复用资源集合，使用与计算模块相同的绑定辅助函数声明（`computeUniformBufferBinding`、`computeStorageBufferBinding`、`computeTextureBinding` 等）。
- `RenderDraw`：单个可复用绘制（直接、索引或间接），包含其顶点/索引 `StorageBuffer`、动态偏移和可变计数。
- `RenderDrawTask`：一个帧图任务，在当前帧的命令编码器中将有序绘制列表录制到一个借用的 `RenderTarget` 的单个渲染 Pass 中。

## 公共 API 接口

```ts
export interface RenderShaderOptions {
    readonly name?: string;
    readonly renderSource: string;
    readonly vertexEntryPoint?: string; // default "vertexMain"
    readonly fragmentEntryPoint?: string; // default "fragmentMain"
    readonly bindings?: readonly ComputeBindingDecl[];
    readonly vertexBuffers?: readonly GPUVertexBufferLayout[];
    readonly primitive?: GPUPrimitiveState;
    readonly target?: { readonly blend?: GPUBlendState; readonly writeMask?: GPUColorWriteFlags };
    readonly depth?: { readonly depthWriteEnabled?: boolean; readonly depthCompare?: GPUCompareFunction };
}
export function createRenderShader(engine: EngineContext, options: RenderShaderOptions): RenderShader;
export function prepareRenderShader(shader: RenderShader, target: RenderTarget): Promise<void>;
export function disposeRenderShader(shader: RenderShader): void;
export function createRenderBindingSet(shader: RenderShader, resources: ComputeBindingResources): RenderBindingSet;
export function disposeRenderBindingSet(bindings: RenderBindingSet): void;

export interface RenderDrawOptions {
    readonly vertexCount: number; // index count for indexed draws
    readonly instanceCount?: number;
    readonly firstVertex?: number;
    readonly firstInstance?: number;
    readonly vertexBuffers?: readonly StorageBuffer[]; // created with `vertex: true`
    readonly indexBuffer?: StorageBuffer; // created with `index: true`
    readonly indexFormat?: GPUIndexFormat;
    readonly enabled?: boolean;
}
export function createRenderDraw(shader: RenderShader, bindings: RenderBindingSet, options: RenderDrawOptions): RenderDraw;
export function setRenderDrawCount(draw: RenderDraw, vertexCount: number, instanceCount?: number): void;
export function setRenderDrawDynamicOffset(draw: RenderDraw, bindingName: string, byteOffset: number): void;
export function setRenderDrawIndirect(draw: RenderDraw, buffer: StorageBuffer, byteOffset?: number): void;

export interface RenderDrawTaskConfig {
    readonly name?: string;
    readonly target: RenderTarget;
    readonly clear?: boolean; // default false: draw over the target's contents
    readonly clearColor?: GPUColorDict;
}
export function createRenderDrawTask(engine: EngineContext, config: RenderDrawTaskConfig): RenderDrawTask;
export function addRenderDraw(task: RenderDrawTask, draw: RenderDraw): void;
export function removeRenderDraw(task: RenderDrawTask, draw: RenderDraw): void;
export function setRenderDrawTaskTarget(task: RenderDrawTask, target: RenderTarget): void;
```

## 内部架构

- `RenderShader._program` 是一个仅作为共享绑定核心使用的 `ComputeShader`：负责针对设备限制的声明校验、槽位表、动态偏移记录以及绑定组生成。`createRenderShader` 会立即在其上安装渲染可见的绑定组布局和管线布局（顶点 + 片元可见性；按 WebGPU 要求，可写存储缓冲区和可写存储纹理仅限片元可见），因此 `_ensureComputeBindingGroups` 绝不会为它构建计算布局。
- 管线：`Map<signatureKey, GPURenderPipeline>` 加上一个按目标索引的 `WeakMap`，后者保存管线以及颜色格式、深度/模板格式、有效深度比较函数和采样数的快照。在复用按目标标识命中的缓存前会先比较这些标量字段。未变更的目标在每帧查找时不执行任何分配；签名变更时会解析匹配的共享管线并刷新快照。因此急切附件重建不会遗留陈旧管线。
- 异步预准备：一个惰性 `Map<signatureKey, Promise<GPURenderPipeline>>` 在并发调用之间（包括具有相同签名的不同目标）共享同一次编译。结算时仅移除匹配的进行中 Promise。仅当程序在其所属设备上仍存活时才会发布成功结果；失败则会使该签名保持可重试状态，并将错误传播给所有等待中的调用方。
- `RenderDrawTask` 使用直接 `execute()` 快速路径，并仅出于参与帧图第 2 阶段初始化的目的而录制一个内部纹理任务 Pass。其 `GPURenderPassDescriptor` 和附件在 `record()` 中（以及 `setRenderDrawTaskTarget` 更改附件集合时）构建。在所有任务完成录制后，其初始化器读取当前的 `_target`，通过绑定在成员上的 `_syncEager` 调用同步急切目标，并重建缓存的附件。普通目标保留其录制时的分配和描述符。每帧仅修补 `view`、`loadOp` 和 `clearValue`；帧图直接调用 `execute()`，而不会执行初始化器 Pass。
- 深度/模板附件仅针对实际存在的方面包含操作。`"stencil8"` 省略所有深度操作；`"depth24plus-stencil8"` 和 `"depth32float-stencil8"` 同时包含深度和模板操作。清除/加载更改应用于每个存在的方面，使用目标的默认深度清除值以及模板清除值 0。缓存 `buildAttachments` 使用的深度/模板格式；将该快照及缓存颜色附件的存在性与同步后的目标比较，而不是与另一个实时目标描述符比较。在原地格式变更后重新选择同一目标会重建描述符以增减方面操作，而无需再次调用 `record()`。未变更的附件签名会保留描述符标识。
- 与 `ComputeTask` 相同，会跳过冗余的 `setPipeline` / `setBindGroup` 调用。

## 管线配置

颜色格式、深度格式、默认深度比较函数和采样数来自目标的 `RenderTargetDescriptor`；混合状态、写入掩码、图元状态、深度写入和比较函数来自着色器。仅模板（stencil-only）管线省略不适用于该格式的深度写入/比较状态，其签名不依赖深度比较函数。

## 着色器逻辑

WGSL 由调用方提供，不对其声明进行解析或重写。配置好的顶点与片元入口点使用已声明的绑定布局和顶点缓冲区。该模块不提供任何材质光照或 UV 转换。

## 状态机与生命周期

- 程序、绑定集与绘制均与设备相关，与计算模块完全一致：设备变更后它们会抛出 `"recreate the compute graph"`（沿用共享核心的措辞）。应用在其设备丢失恢复路径中重新创建它们。
- 目标属于借用资源：任务绝不会销毁它们。从未分配过的目标会在 `record()` 中或被 `setRenderDrawTaskTarget` 选中时构建一次，并始终归调用方所有。两个入口点都会通过 `buildRenderTarget` 同步急切目标。对于非急切目标，通过 `target._resolveSize`（回退到 `_resolveRenderTargetSize`）解析当前尺寸，如果两个附件视图均缺失或任一维度与 `_width`/`_height` 不同，则进行重建。尺寸未变时保留现有分配与内容。因此表面和按比例缩放的表面尺寸会在重新录制或选择目标（包括重新选择同一目标）时跟随调整大小。目标选择会在更改任务状态之前进行同步，因此刷新的附件会立即反映在紧接着的下一次绘制中，无需再次构建帧图。仅尺寸变更会复用缓存管线，并在目标选择时复用 Pass 描述符；执行阶段会读取新的附件视图。在任务销毁后切换目标会在同步或分配目标前被拒绝。
- 第 2 阶段急切同步同样会针对禁用执行的任务运行。表面 RTT 生产者可能在借用该目标的绘制任务之后进行录制：调整大小后仅执行同步 `graph.build()` 必须在任何执行前刷新绘制的视图及所选 mip 维度。初始化器会观察在另一任务录制期间执行的目标选择，并传播已销毁包装器的错误。重新录制会替换单个初始化器 Pass。Pass 销毁会清空附件缓存而不销毁任务或目标；任务销毁会清空其 Pass 和绘制而不释放借用的分配。`buildFrameGraphTask()` 仅初始化其选中的任务，无法预准备未录制的生产者。执行顺序、内容依赖以及其他使用方捕获的绑定组视图或拷贝端点仍由调用方负责。
- 当没有任何绘制被启用且 `clear` 为 false 时，任务不会开启渲染 Pass。
- 销毁会清空已完成和进行中的管线缓存。未完成的编译无法重新填充已销毁的着色器，且其等待中的预准备会拒绝而不是报告成功。

## Babylon.js 等价映射

自定义渲染程序与帧图绘制 Pass 对应用户编写的渲染特效与绘制任务。Lite 共享计算模块的绑定核心，同时保持单一帧编码器和纯状态绘制。

## 依赖关系

`compute/compute-shader.ts`、`compute/compute-bindings.ts`（绑定核心）、`engine/render-target.ts`、`resource/storage-buffer.ts`、`frame-graph/texture-task-pass.ts`。除根重新导出外没有其他模块导入此模块，因此不使用它的场景不会携带任何相关字节。

## 测试规范

`tests/lite/unit/render-shader.test.ts`：布局可见性、带有着色器固定管线状态的每种目标格式一个管线、带顶点缓冲区的实例化绘制、空闲时不开启 Pass、按需清除、索引绘制与间接绘制、动态偏移、顶点用途校验、异步预准备、设备变更拒绝、绘制所有权。
回归用例还涵盖并发同签名预准备、独立签名、拒绝后重试、预准备期间的销毁/设备替换、条件深度/模板操作、清除/加载变更、目标格式切换、仅模板管线状态、重复录制与目标切换时的急切同步、借用未构建目标的单次分配以及任务销毁后拒绝目标切换。非急切表面与按比例缩放表面目标覆盖通过图重建和同目标选择实现的仅宽与仅高调整大小、替换颜色/深度视图、旧附件的单次销毁、无调整大小时的分配和管线复用以及任务销毁后的借用所有权。同格式的颜色到颜色和深度到深度切换会复用 Pass 描述符同时刷新其附件视图。真实 mipmap 目标所有者上的可变描述符在不重新录制的情况下通过选择同一目标演练清除/加载两种模式下的深度格式重建。恢复为仅深度会移除模板操作并复用原有的缓存管线。

`tests/lite/unit/frame-graph-texture-tasks.test.ts` 覆盖生产者排在最前和最后两种顺序下的真实表面 RTT 颜色与可采样深度包装器。调整大小后仅调用 `graph.build()` 即可刷新包装器及编码后的附件、保留签名与缓存管线、每个源附件仅分配一次，并在退役和未变更重建后依然有效。启用的绘制会演练实际的着色器/管线查找和编码路径；这些属于模拟 GPU 的附件测试，而非像素验证。禁用执行时仍会执行初始化。其他用例覆盖录制期间的目标选择、同步已销毁包装器错误、每次录制单个初始化器、销毁时的借用生命周期以及第 2 阶段无额外常规目标分配。

## 文件清单

- `render-shader/render-shader.ts`：程序、管线、绑定集。
- `render-shader/render-draw.ts`：绘制记录、计数、动态偏移。
- `render-shader/render-draw-indirect.ts`：可选的间接绘制。
- `render-shader/render-draw-task.ts`：帧图任务。
