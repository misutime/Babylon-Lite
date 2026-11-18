# 模块：异步 ShaderMaterial 管线编译

> 包路径：`packages/babylon-lite/src/material/shader/`

## 用途

该可选功能用于在 `FrameGraph.build()` 之前或调用方定义的就绪边界之前预准备 ShaderMaterial 渲染管线。它将 WebGPU 管线编译移出首次同步 `Renderable.bind()`，同时不改变像素结果、管线键、描述符或同步回退路径。Standard、PBR、NodeMaterial、几何材质、后处理和特效管线不在此模块范围内。

## 公共 API 接口

```ts
type ShaderMaterialPipelineLayout = "mesh" | "thin-instances" | "thin-instances-color";

function enableAsyncShaderPipelineCompilation(engine: EngineContext): void;

function prepareShaderMaterialPipeline(
    engine: EngineContext,
    material: ShaderMaterial,
    layout: ShaderMaterialPipelineLayout,
    target: RenderTarget | RenderTask,
    mesh?: Mesh
): Promise<void>;

function prepareShaderMaterialPipelineForTask(task: RenderTask, material: ShaderMaterial, layout: ShaderMaterialPipelineLayout, mesh?: Mesh): Promise<void>;
```

`enableAsyncShaderPipelineCompilation` 是幂等的。如果希望在场景注册时自动执行预准备，必须在构建 ShaderMaterial 可渲染对象之前调用该函数。`prepareShaderMaterialPipeline` 与 `prepareShaderMaterialPipelineForTask` 属于显式预准备查询，不要求预先存在可渲染对象或先调用 `addMeshToTask`。
当需要为基于存储缓冲区或其他非规范打包方式的资源做准备时，请传入 `mesh`。其经过校验的步长、偏移、缺失流默认值以及管线键后缀都会按绑定时的完全一致的方式进行预准备。
省略 `mesh` 则保持规范布局的预准备行为。

各布局值的含义如下：

- `mesh`：由 `ShaderMaterial.attributes` 声明的顶点缓冲区。
- `thin-instances`：上述网格缓冲区，外加位于连续着色器位置上的四个实例速率（instance-rate）`float32x4` 矩阵行。
- `thin-instances-color`：薄实例（thin-instance）矩阵布局，外加一个实例速率的 `float32x4` 颜色。

没有任何公共 API 接受 `GPUDevice`、`GPURenderPipelineDescriptor`、着色器模块、管线布局或顶点缓冲区描述符。

## 内部架构

`shader-pipeline.ts` 依然是 ShaderMaterial 管线标识与构建的唯一所有者。异步预准备会针对一个临时捕获设备（capture device）调用未修改的同步构建器；该设备将着色器模块创建委托给真实设备，并仅拦截 `createRenderPipeline(descriptor)`。占位管线会在控制权让出之前同步地从已完成缓存中移除，而捕获到的描述符会通过 `createRenderPipelineAsync` 提交给真实设备。

这保证了两条路径推导出完全相同的变体键、着色器模块、最终缓存键以及完整的 `GPURenderPipelineDescriptor`，而无需在常规首次绑定路径中添加任何分支或描述符抽象。两条路径都会将结果发布到同一个 `ShaderPipelineBindings.pipelines` 映射表中。

自动薄实例注册会通过父级 ShaderMaterial 构建器提供的回调记录网格及其解析后的顶点布局。惰性薄实例构建器仅解析一次该布局，并在注册与绑定之间共享。预准备会在该可选模块内部追加逻辑上的仅矩阵（matrix-only）或矩阵加颜色（matrix-and-color）布局。显式预准备使用相同的网格解析器。未导入启用器的场景不会保留任何注册器分支、显式解析器或描述符捕获代码。

每个绑定对象可以惰性地持有一个内部的待处理管线映射表（pending-pipeline map），仅在使用异步预准备时才会分配。每个最终管线键只保留一个 Promise；针对同一键的并发请求会等待同一个 Promise。无论 Promise 兑现还是拒绝，对应条目都会被移除。同步绑定路径始终可用；如果同步绑定在竞争中胜出，其创建的管线在共享的已完成缓存中保持权威地位。

场景注册阶段的自动预准备采用尽力而为（best-effort）策略。拒绝错误会通过 `console.error` 报告，不会中止帧图构建或场景注册；随后的首次绑定会走未修改的同步路径。显式预准备 API 则会直接拒绝 Promise，以便由定义了自定义就绪边界的调用方自行处理失败。

ShaderMaterial 可渲染模块暴露了一个仅用于安装的注册器设置函数（install-only registrar setter）。启用器在全局安装一个回调，并为每个已启用的引擎维护一个 `WeakMap`。普通可渲染对象按可渲染对象标识索引；薄实例配方按网格标识索引，从而使惰性薄实例模块无需任何特性钩子。当启用器未被导入时，Rollup 会移除该注册器及所有相关调用。

配方仅保留 `ShaderMaterial` 以及已计算好的逻辑管线附加信息。预准备总是在执行时解析当前设备的绑定，因此不会复用已丢失设备上的绑定组布局、管线布局、模块或管线映射表。

在执行预准备之前，该可选模块会将已安装的跨材质缓存重新定位到当前 GPU 设备，随后按常规方式解析绑定和模块。对于未导入该特性的场景，常规同步路径在字节码级别保持等价。

## 管线配置

预准备生成的描述符与同步 ShaderMaterial 渲染所使用的描述符完全一致：

- 顶点入口点：`mainVertex`；
- 可选片元入口点：`mainFragment`；
- group 0：场景绑定组布局；
- group 1：ShaderMaterial 绑定组布局；
- 图元拓扑与剔除模式：材质配置值；
- 颜色格式与混合状态：目标与材质配置值；
- 深度/模板格式、比较函数、写入标志、偏移及模板状态：目标与材质配置值；
- 采样数与 alpha-to-coverage：目标签名加上已安装的材质解析器。

仅深度（depth-only）目标会省略片元阶段，除非设置了 `depthOnlyFragment`。`RenderTask` 会提供其保留的 `_targetSignature`，其中包括独立深度目标的格式和比较函数。`RenderTarget` 签名则从其描述符的颜色格式、深度格式、深度比较函数和采样数推导而来。使用带有独立深度附件的任务的调用方必须传入 `RenderTask`，而不能仅传入颜色目标。

## 着色器逻辑

不改变任何片元或顶点数学运算。对于薄实例，所有者会在材质声明的属性之后追加以下输入：

```wgsl
world0: vec4<f32>
world1: vec4<f32>
world2: vec4<f32>
world3: vec4<f32>
instanceColor: vec4<f32> // only for thin-instances-color
```

它们的着色器位置从 `material.attributes.length` 开始。矩阵数据使用一个步长为 64 的实例速率缓冲区，偏移量分别为 0、16、32 和 48。颜色数据使用第二个步长为 16、偏移量为 0 的实例速率缓冲区。

## 状态机与生命周期

1. 调用方按需在引擎上启用自动预准备。
2. 不透明、透明及薄实例 ShaderMaterial 可渲染对象的创建会通过已安装的模块局部回调注册逻辑配方。
3. 场景注册会构建延迟的场景内容，并等待每一个顶层任务的 `_preload`。
4. 预准备钩子会实体化待处理的 RenderTask 网格以及阴影任务状态，随后遍历顶层任务及内部 `_task`、`_tasks` 和 `_staticTasks` 所有者。
5. 每个 ShaderMaterial 配方都会针对每个 RenderTask 签名进行预准备。重复的最终键共享同一个待处理 Promise。
6. 场景注册等待所有预准备完成后，再调用 `FrameGraph.build()`；常规绑定阶段即可命中已完成的管线。
7. 仅在运行时创建的可渲染对象或未提前预准备的签名，仍走未修改的同步回退路径。

PCF 和 ESM 通过其阴影状态暴露一个内部 RenderTask。CSM 暴露一个复合 `_task` 及其级联 `_tasks`；可选的 CSM 静态缓存还会额外暴露 `_staticTasks`。仅当场景拥有顶层 `shadow` 任务时，才会实体化阴影状态。

在设备丢失后，配方仍保持逻辑状态。仅当预准备再次运行时，才会解析当前设备的绑定与当前设备的跨材质缓存。旧设备上的绑定不再具有权威性。

## Babylon.js 等价映射

Babylon.js 支持在首次使用前异步编译渲染管线。Lite 仅对 ShaderMaterial 暴露了相同的调度能力，同时保留了 Lite 现有的材质自有描述符、缓存以及同步绑定行为。该模块仅改变编译发生的时机，而不改变管线状态或着色器结果。

## 依赖关系

- `scene/scene-core.ts`：在任务预加载之后、帧图构建之前执行并等待的预准备边界。
- `frame-graph/render-task.ts`：精确的任务签名与待处理网格解析。
- `frame-graph/shadow-inputs.ts`：已注册的阴影投射体集合。
- `material/shader/shader-pipeline.ts`：同步描述符/键构建及已完成/待处理缓存。
- `material/shader/shader-pipeline-cache.ts`：与设备关联的跨材质缓存。
- `material/shader/shader-renderable.ts`：不透明与透明配方来源。
- `material/shader/shader-thin-instance.ts`：薄实例布局选择与配方来源。

## 测试规范

专项测试必须证明：

1. 在启用之前该特性保持完全惰性；
2. 不透明、透明、薄实例仅矩阵、薄实例带颜色四种配方生成的键与描述符与同步绑定所消耗的完全一致；
3. 重复配方和重复任务针对每个最终键仅调用一次 `createRenderPipelineAsync`；
4. 拒绝会移除待处理条目，且后续同步绑定仍可正常创建其管线；
5. 注册流程会在任务预加载之后、`FrameGraph.build()` 之前等待预准备完成；
6. 在任何可渲染对象或 `addMeshToTask` 调用存在之前，显式预准备即可正常工作；
7. RenderTarget 和 RenderTask 目标签名会选择预期的颜色、深度、比较和采样状态；
8. 遍历 PCF、ESM、默认 CSM 和带缓存 CSM 的内部任务，包括 `_tasks` 和 `_staticTasks`；
9. 普通注册不会实体化未使用的阴影状态；
10. 切换到第二个 GPUDevice 后，普通路径和跨材质缓存路径均会分配新的绑定/模块/管线，绝不会读取第一个设备的 GPU 对象；
11. Standard、PBR、NodeMaterial、几何、后处理及特效管线的创建次数保持不变。

## 文件清单

- `packages/babylon-lite/src/material/shader/enable-async-shader-pipeline-compilation.ts`
- `packages/babylon-lite/src/material/shader/shader-pipeline.ts`
- `packages/babylon-lite/src/material/shader/shader-pipeline-cache.ts`
- `packages/babylon-lite/src/material/shader/shader-renderable.ts`
- `packages/babylon-lite/src/material/shader/shader-thin-instance.ts`
- `packages/babylon-lite/src/scene/scene-core.ts`
- `packages/babylon-lite/src/index.ts`
