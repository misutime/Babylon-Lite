# 模块：帧图几何渲染器（Frame-Graph Geometry Renderer）

> 包路径：`packages/babylon-lite/src/frame-graph/`、`packages/babylon-lite/src/material/standard/standard-geometry-output-shader.ts`

## 目的

几何渲染器任务将场景网格列表渲染到一组多渲染目标（MRT）几何纹理中——视图空间法线、世界空间位置、反射率、反照率（albedo）、归一化视图深度、线性速度等。这些纹理供下游任务使用（屏幕空间环境光遮蔽、后处理效果、屏幕空间反射、运动模糊等）。

其接口形态与纹理类型镜像了 Babylon.js 的 `MaterialHelperGeometryRendering.GeometryTextureDescriptions`。Babylon Lite 暴露了一个严格子集，偏向最小化打包体积：

- 排除 `ALBEDO_SQRT` —— 仅暴露 `ALBEDO`。
- 排除 `VELOCITY` —— 下文规定了 `LINEAR_VELOCITY` 契约。
- 排除 `IRRADIANCE_LEGACY` —— 仅暴露 `IRRADIANCE`。
- 排除 `COLOR` —— 调用方通过任务可选的 `targetTexture` 颜色附件连接单独的场景颜色 RT（对应 BJS `PREPASS_COLOR_INDEX`）。

此外还提供了配套的 `createCopyToTextureTask()`，使调用方可以将生成的几何附件位块传输（blit）到交换链（或任何其他 RT）上的某个视口中，用于检查、替代条带（impostor strips）或后处理输入。

## 公共 API 接口（类型、函数、常量——完整签名）

```ts
export const enum GeometryTextureType {
    IRRADIANCE = 0,
    WORLD_POSITION = 1,
    LOCAL_POSITION = 2,
    REFLECTIVITY = 3,
    VIEW_DEPTH = 4,
    NORMALIZED_VIEW_DEPTH = 5,
    SCREENSPACE_DEPTH = 6,
    VIEW_NORMAL = 7,
    WORLD_NORMAL = 8,
    ALBEDO = 9,
    LINEAR_VELOCITY = 10,
    MESH_BLEND_TAG = 11,
}

export type GeometryClearValue = GPUColor;

export interface GeometryTextureDescription {
    readonly name: string;
    readonly defaultFormat: GPUTextureFormat;
    readonly clearValue: GeometryClearValue;
}

export const GEOMETRY_TEXTURE_DESCRIPTIONS: readonly GeometryTextureDescription[];

export interface GeometryRendererTextureDescription {
    readonly type: GeometryTextureType;
    readonly format?: GPUTextureFormat;
}

export interface GeometryRendererTaskConfig {
    name?: string;
    meshes?: readonly Mesh[];
    camera?: Camera | null;
    size?: "canvas" | { width: number; height: number };
    samples?: 1 | 4;
    depthTexture?: RenderTarget | null;
    readonly textureDescriptions: readonly GeometryRendererTextureDescription[];
    reverseCulling?: boolean;
}

export interface GeometryVelocityOptions {
    previousDepth?: boolean;
}
export function enableGeometryVelocity(task: GeometryRendererTask, options?: GeometryVelocityOptions): void;

export interface GeometryRendererTask extends Task {
    readonly name: string;
    readonly outputTarget: RenderTargetMrt;
    readonly geometryIrradianceTexture: RenderTarget | null;
    readonly geometryWorldPositionTexture: RenderTarget | null;
    readonly geometryLocalPositionTexture: RenderTarget | null;
    readonly geometryReflectivityTexture: RenderTarget | null;
    readonly geometryViewDepthTexture: RenderTarget | null;
    readonly geometryNormalizedViewDepthTexture: RenderTarget | null;
    readonly geometryScreenspaceDepthTexture: RenderTarget | null;
    readonly geometryViewNormalTexture: RenderTarget | null;
    readonly geometryWorldNormalTexture: RenderTarget | null;
    readonly geometryAlbedoTexture: RenderTarget | null;
    readonly geometryLinearVelocityTexture: RenderTarget | null;
    readonly geometryMeshBlendTagTexture: RenderTarget | null;
    excludeFromVelocity(mesh: Mesh): void;
    includeInVelocity(mesh: Mesh): void;
}

export function createGeometryRendererTask(scene: SceneContext, config: GeometryRendererTaskConfig): GeometryRendererTask;

export interface CopyToTextureTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    targetTexture?: RenderTarget;
    ownsTargetTexture?: boolean;
    viewport?: NormalizedViewport | null;
    lodLevel?: number;
    resolveTexture?: RenderTarget;
}

export interface CopyToTextureTask extends Task {
    readonly name: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget | undefined;
    ownsTargetTexture: boolean;
    resolveTexture: RenderTarget | undefined;
    viewport: NormalizedViewport | null | undefined;
    lodLevel: number;
    readonly outputTexture: RenderTarget;
}

export function createCopyToTextureTask(scene: SceneContext, config: CopyToTextureTaskConfig): CopyToTextureTask;
```

## 用法

```ts
const gbuffer = createGeometryRendererTask(scene, {
    samples: engine.msaaSamples as 1 | 4,
    textureDescriptions: [
        { type: GeometryTextureType.NORMALIZED_VIEW_DEPTH },
        { type: GeometryTextureType.VIEW_NORMAL },
        { type: GeometryTextureType.WORLD_POSITION },
        { type: GeometryTextureType.REFLECTIVITY },
        { type: GeometryTextureType.ALBEDO },
    ],
});
addTask(scene, gbuffer);

// Blit the depth attachment into a 256×144 strip at the top of the swapchain.
addTask(
    scene,
    createCopyToTextureTask(scene, {
        sourceTexture: gbuffer.geometryNormalizedViewDepthTexture!,
        targetTexture: outputTarget,
        viewport: { x: 0, y: 0, width: 0.2, height: 0.2 },
    })
);
```

该任务最多接受 8 个附件（WebGPU 上限）。每个 `GeometryRendererTextureDescription.format` 默认取 `GEOMETRY_TEXTURE_DESCRIPTIONS[type].defaultFormat` 中的条目，且可按附件覆盖。

`MESH_BLEND_TAG` 是通用格式覆盖规则的例外：它始终是单采样 `r8uint`，清除为无符号整数零，并拒绝任何其他格式或非零清除值。Standard、PBR 和 Node 几何视图为其 MRT 槽位发射一个类型化的 `u32` `FragmentOutput` 成员，而所有其他槽位保持 `vec4<f32>`。整数目标省略混合状态。上传的标签是经过验证的源网格标签，因此基于源的克隆/常规实例和精简实例使用其源绘制的标签。

`createMeshBlendingPostProcessTask` 安装这一显式启用的输出支持。几何任务可以先创建，但该后处理任务必须在帧图预加载其任务之前存在。

Alpha 混合网格默认参与几何渲染，与 Babylon.js 几何渲染一致。需要仅不透明通道的调用方请提供过滤后的 `meshes` 数组。Alpha 测试材质继续受支持，因为它们现有的材质着色器会在写入任何几何输出之前丢弃被拒绝的片段。BLEND 材质以及通过 `setMeshOpacity` 淡出的网格是混合几何参与者：每一个颜色目标都必须支持混合。默认的 `VIEW_DEPTH` 使用 `r32float`，对于此类参与者需要设备特性 `float32-blendable`；否则请将其覆盖为 `r16float`。整数目标绝不进行混合。

PBR、Standard 和 Node 几何管线创建通过 `geometry-types.ts` 中的内部 `_geometryColorTarget` 辅助函数验证混合目标。若缺少所需的设备特性，混合的 32 位浮点目标会在管线创建前抛出以下现有错误：
`Transparent geometry output format "${format}" requires the float32-blendable WebGPU feature or a blendable format override.`
混合另一个整数目标会抛出：
`Transparent geometry output cannot blend integer format "${format}".`
网格混合输出扩展保持其 `r8uint` 标签目标不混合，并将其他目标的验证委托给同一个辅助函数。

当堆叠超过两个 HDR（`rgba16float`）附件时，请求可能会超过 WebGPU 默认的 `maxColorAttachmentBytesPerSample` 32 字节上限。调用方可通过 `EngineOptions.requiredLimits` 提高该上限：

```ts
const engine = await createEngine(canvas, {
    requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
});
```

## 设计

### PBR 交错几何体

PBR 几何工厂从 `mesh._gpu._vbLayout` / `mesh._gpu._vbKey` 读取顶点布局和布局键，与前向 PBR 渲染完全一致。将两者传入着色器组合并将布局键包含在逐视图资源缓存身份中。布局是逐网格的，绝非材质拥有的：共享同一材质的网格可能使用不同的属性步长/偏移。将顶点缓冲区绑定在偏移量零处；属性偏移属于组合后的管线布局。

### 变形感知速度（PBR 与 Standard）

`LINEAR_VELOCITY` 是前一帧减去当前帧的 NDC XY 除以二（Y 朝上），而不是世界空间速度。Z 默认保持为零，以保留现有的速度可视化及消费方。在场景注册之前调用 `enableGeometryVelocity(task)`，以显式启用 PBR 刚体/变形运动和共享上一帧姿态资源。`enableGeometryVelocity(task, { previousDepth: true })` 还会显式启用 Z 中的上一帧正视图深度（上一帧裁剪空间 W），这需要浮点 RGBA 速度附件和透视相机，并使用预留的几何参数标量 `gp.cameraNearFar.z = 1`。AO 示例将生产方标志与时间消费方的匹配标志一并启用。同一套契约服务于 SSAO 及其他时间消费方，而无需在几何渲染器中编写特定于 AO 的代码。

非实例化的实时骨骼和变形网格按与当前几何体相同的顺序重建**上一帧**变形局部位置：基础位置、将上一帧变形权重应用于不可变位置增量、随后进行上一帧四/八影响骨骼混合、再应用上一帧网格世界矩阵和上一帧任务视图-投影矩阵。当两者同时变化时，将当前变形位置与上一帧骨骼混合是错误的。世界/相机运动与变形相互组合；静止的姿态在下一帧产生零变形运动，而不是重复的运动。

一个与材质无关的变形速度特性拥有上一帧姿态着色器代码和逐 renderable 资源。显式启用器将其以及 PBR 几何速度实现安装在可空的（nullable）类型化接缝之后；普通 PBR 几何体保持其历史上的仅相机速度，而无需导入矩阵求逆或上一帧姿态代码。Standard 速度通道在任务预加载时若存在蒙皮或变形网格，则会预加载该共享特性。蒙皮 Standard 速度仍然必须依赖它；而在其加载前绑定的仅变形 Standard 网格（例如在注册后添加的网格）会保留历史上的“当前变形上一帧位置”行为，而不会使通道失败。这也是针对**非 SSAO Standard 速度消费方**的行为变更：预加载了变形网格的通道现在对其使用上一帧变形权重，而不是两帧都使用当前变形位置。因此即使不存在 SSAO 任务，运动模糊或其他时间消费方也会接收到变形运动数据。纯颜色渲染不受影响；上述延迟添加的仅变形回退路径仍然可用。仅安装实现并不会激活另一个任务：启用器仅在预加载后装饰自己任务的 PBR 视图工厂，标记这些视图（连同任务的速度排除项），并使用任务局部标签进行上一帧姿态分配和着色器选择。共享组合器缓存键包含启用的速度变体。活动特性视图作用域在同步组合/绑定（包括嵌套调用）之后会恢复，因此旧版任务和显式启用任务可以在同一场景中共存。纯颜色或非速度几何通道不会分配任何上一帧姿态。通用任务不包含新的速度策略、分配或导入；它仅保留一个可选的有效相机验证器。启用器仅初始化一次预留的任务参数字段 18，参数上传会保留该字段。使用相同契约重复启用是幂等的；更改该契约、在注册后启用、缺少/已销毁的速度目标、不兼容的格式以及仅支持透视的上一帧深度都会显式失败。

每个几何 renderable 拥有一个上一帧骨骼 RGBA32F 纹理和/或一个上一帧变形权重只读存储缓冲区，外加 CPU 姿态快照。绑定只创建一次。在每次几何绘制之前，上传先前的快照，并将当前 CPU 镜像保存为下一次绘制的快照；首次使用、排除/重新包含以及隐藏/重现的网格使用当前姿态作为其中性初始化值。所有历史记录都是任务/renderable 局部的：共享材质、骨骼、变形权重、其他几何任务和前向/阴影通道都无法推进另一个消费方的上一帧状态。不会修改或销毁任何当前源资源，在更新循环中也不会分配任何向量/数组/绑定组。回收操作会随现有代次的带栅栏生命周期一起销毁上一帧资源。设备重建会从中性状态开始。

共享的骨骼影响生成器被复用于上一帧骨骼混合。速度特性将上一帧权重描述为类型化的只读存储绑定。其资源生产方安装了一个绑定发射器，根据该元数据在组合分配的绑定索引处同时生成存储 WGSL 声明和 GPU 布局条目。对于上一帧权重，既不解析也不重写任何发射出的着色器文本。该可选发射器隔离在一个可空的组合接缝之后，因此普通着色器不保留任何存储缓冲区策略。普通变形渲染保持其现有的双绑定重写不变。当前位置/法线变形以及法线/材质着色均保持不变。绘制之后，相机历史直接从任务自己的场景 UBO 暂存区拷贝当前矩阵。不需要第二个当前视图-投影数组或中间逐帧拷贝；浮动原点调整在该 UBO 上传前就已经完成。

任意 NodeMaterial 图变形、烘焙 VAT 和独立动画的精简实例变换仍属于独立契约；此特性不会为它们凭空构造上一帧变换。现有的显式自定义图速度仍然可用。AO 示例包含了独立的动画蒙皮和变形示例以及动画开关。`geometry-deformation-velocity.test.ts`、`geometry-renderer-task.test.ts` 和 `standard-geometry-features.test.ts` 中的生产级单元测试检查上一帧姿态所有权、首帧初始化、源替换、任务局部显式启用、上一帧深度配置、排除项、仅变形回退以及销毁。

文件：`frame-graph/enable-geometry-velocity.ts`（公共启用器）、`material/geometry-deformation-hooks.ts` / `material/geometry-deformation-velocity.ts`（共享上一帧姿态接缝与状态），以及 `material/pbr/pbr-geometry-velocity-hooks.ts` / `material/pbr/pbr-geometry-velocity.ts`（PBR 接缝与逐网格上一帧世界状态）。

### 两阶段任务：`record()` 与 `execute()`

所有分配、着色器编译、管线创建、绑定组创建、绘制列表构建和视口数学计算都位于 `record()` 中。`execute()` 仅执行：

1. 更新每帧 UBO 内容（来自任务相机的场景 UBO、逐网格世界矩阵、用于速度的上一帧世界矩阵、几何参数），以及
2. 针对预构建的 MRT 渲染通道描述符派发预构建的绘制列表。

当场景输入变化时，帧图会重建并重新录制，因此调用方无需担心缓存过时。`RenderPassTask`、`CopyToTextureTask` 和后处理任务使用了相同的 `record()` 与 `execute()` 职责划分。

### 资源所有权与失败的重建

每个几何绑定都拥有一个 `MeshRebuildResources` 生命周期接收器。任务在调用 Standard/PBR/Node 几何重建器之前创建它，并在绑定前将其标记在返回的 renderable 上。构建器要求该所有者，并在后续可失败工作之前注册释放操作。绑定的列表仅在每一次重建和绑定都成功后才发布；任何失败都会同步释放所有候选接收器（包括失败的条目），而不改变先前的绘制列表或其携带的任何条目。同步操作会在任务视图缓存的独立副本中构建视图，仅当列表发布时才替换缓存，因此失败的同步也会使缓存保持为上次发布时的状态；它创建的视图会随该副本一同丢弃（其变体的缓冲区已随释放的接收器一起清理）。

被替换或销毁的活动条目会在已提交的 GPU 工作之后回收其分离的生命周期批次。共享的 Standard/Node 视图资源由每个 renderable 保留，仅当最后一个所有者释放时才销毁；旧的回调绝不会驱逐替换后的缓存条目。不存在隐式视图租约或场景辅助销毁器映射。

着色器模块不是按代次拥有的。Standard 和 PBR 几何体通过一个以设备和精确组合后的 WGSL 为弱键的私有逐族备忘录（memo）来解析它们，因此重新录制、renderable 版本重建、重新发布的前向 PBR 上下文以及组合出相同 WGSL 的材质都会按代码字符串复用同一个模块，而不是重新编译。每个备忘录条目会统计正在用它进行绘制的 renderable 数量：renderable 在构建时获取其顶点和片段条目，并在其幂等的逐网格生命周期数据包中释放它们，因此旧代次回收前构建的候选代次仍能命中缓存，且条目会在其最后一个持有者离开时（被取代的插件或材质变体、被移除的网格、被回滚的候选、被销毁的任务）离开备忘录。renderable 仅记录成功获取的条目，释放操作绝不编译或创建条目，因此顶点或片段编译抛出异常的候选会精确回滚它持有的资源，并依然销毁其网格 UBO。`GPUShaderModule` 没有 `destroy()` 方法，因此丢弃条目绝不会使旧管线仍引用的模块失效。组合、BGL、管线布局和管线仍保留为逐视图资源。因设备丢失恢复而替换的设备会编译自己的模块。Node 几何体已经通过其基于代码键的管线缓存共享模块。

### 增量重新同步

`record()` 和每次 `scene._renderableVersion` 变化都会重新同步绑定列表，但只有变更触及的条目才会被重建，类似前向 `RenderTask` 的重新同步。每个 Standard 或 PBR 条目都会记住构建时场景为其网格跟踪的前向 renderable（Standard 为 `scene._renderables`，PBR 为组的跟踪输出）。只要网格仍然通过同一个前向 renderable 绘制同一个源材质，该条目就会原样保留：相同的 renderable、绑定、更新状态（含速度历史）和生命周期接收器。条目所捕获的每一项内容要么在变更时会强制触发前向重建（材质特性和纹理、网格能力和顶点布局、PBR 上下文和灯光/阴影请求），要么在任务生命周期内为常量，要么每帧实时读取（世界矩阵、灯光选择、材质 UBO 版本、顶点/索引缓冲区、精简实例数量）。因此调整大小或帧图重建不会重建任何条目，而 Standard 材质交换、材质重建或新网格只会重建其自身的网格。PBR 遵循其前向通道：逐网格前向重建（通过组的重建闭包进行材质交换、`markMeshRenderableDirty`、走逐网格路径的 `rebuildMaterial`）仅重建该条目，而完整 PBR 组重建（在不符合逐网格路径条件的 PBR 材质上调用 `rebuildMaterial`、需要扩展或运行时构建其组的 PBR 网格、`rebuildScenePbrPipelines`）则会替换每一个 PBR 前向 renderable 并发布新的 PBR 上下文，从而导致每一个 PBR 几何条目被重建且每一个 PBR 视图为新上下文重新组合一套变体；Standard 条目仍然原样保留。PBR 前向代次门控（`isPbrForwardBuildCurrent`）会先运行，因此前向重建正处于待处理状态的 PBR 网格会被丢弃，绝不会被保留。只有被取代的条目才会被回收。

Standard/PBR 视图连同其上编译的变体在同步之间持续保留，只要源材质保持其 `_renderFeatures` 对象；视图映射会在每次发布时修剪为当前绘制的材质集合。使用已绘制材质的新增 Standard 网格不会编译任何内容。PBR 视图为它曾基于之组合过的每一个前向 PBR 上下文保留一套变体集合，以该上下文为弱键：上下文提供组合器、场景特性和阴影布局，而每个条目从其自身网格的上下文绑定环境与阴影纹理，因此变体绝不会跨上下文共享。一个视图可以同时有多个活跃上下文：完整 PBR 组重建会发布一个新的场景上下文，而一个在请求之后才构建的组中被运行时构建的 PBR 网格（在场景首次构建完成前同一次排空中构建的、属于从未构建过的 PBR 组的若干网格）会保留各自的上下文直到下一次完整重建。不同上下文上的网格绝不会相互驱逐对方的变体集合，因此对其中任意网格的后续重建都不会编译任何内容。新增 PBR 网格当其上下文在视图上已存在集合时不会编译任何内容；否则它会像前向构建一样组合自己的变体。因此首批绑定 K 个位于 K 个逐网格上下文上的网格时，会组合 K 个变体，而不是每个材质只组合一个。Node 条目和视图会在每次同步时重建，因为 Node 几何资源会一次性快照材质的 uniform；Node 视图会打上不持有视图的逐同步令牌，因此已发布的 Node 视图不会让更早的 Node 材质或视图保持存活。显式列表中的非场景网格没有前向 renderable，也会在每次同步时重建。如果某次同步看到设备、相机或 `config.reverseCulling` 与上次发布不同，则不保留任何条目也不复用任何视图，因此相机或剔除更改，或设备丢失恢复（其 `record()` 还会重建任务自身的缓冲区），会像之前一样重建整个通道。相机以两个元素标记，两者均按身份比较：视图捕获的覆盖相机（`config.camera ?? null`，因此省略覆盖与设为 null 是同一选择）和通道实际用来绘制的相机（`config.camera`，否则 `scene.camera`）。在浮动原点下两者都很重要。覆盖相机决定了条目相对谁打包其世界矩阵以及由谁的版本触发重新打包：即覆盖相机本身，或者每次打包时的任意 `scene.camera`（它还决定 PBR 条目是否接收阴影）。如果不记录覆盖相机，在 `scene.camera` 和 `config.camera` 之间移动同一台相机时可能会保留相同的有效相机，从而保留了条目，随后当 `scene.camera` 改变时这些条目就会跟随错误的原点。有效相机则负责捕获没有覆盖的任务上 `scene.camera` 被替换的情况：它的条目仅在其比较的版本号移动时重新打包，而新相机的版本号可能正好等于旧相机的版本号。同步只能看到那一刻的相机，因此在浮动原点下，一旦某帧用与标记不同的另一台相机绘制，`execute()` 就会清除该标记：这样 `scene.camera` 就可以在经历其他相机后又回到标记的相机且版本号恰好与条目上次比较的一样（此时它实际上相对另一台相机的原点打包），而下一次同步就不会错误地保留任何条目。清除标记而非重建可以使帧间切换相机无需重建通道。如果针对已更改配置的同步失败并恢复了先前的配置，下一次同步会保留已发布的条目和视图，而不会保留任何来自失败同步的视图。

任务的 `_removeMesh` 钩子会立即驱逐每一个匹配的绑定条目并排队等待回收，即使在渲染停止时也是如此。其弱排除集合仍然拒绝已移除的非场景输入，并允许网格在重新添加到场景后再次加入。

任务在录制期间创建 group 0，而不是在工厂中创建一次又在录制期间再创建一次。不可变的颜色清除/加载/存储状态随附件一同初始化；每次录制工作仅刷新变化的视图、尺寸和深度附件。

### 打包体积隔离

`createGeometryRendererTask()` 拥有自己的场景 UBO、场景绑定组、材质视图缓存和管线缓存。它**不会**经过 `getOrCreateStandardBindings()` 或 `getOrCreateStandardPipeline()`。从不导入 `geometry-renderer-task.js` 的现有场景支付零字节。

同理，`geometry-types.ts` 和 Standard 几何输出着色器组合器（`standard-geometry-output-shader.ts`）仅由几何任务加载。

### MRT 引擎底层支持 —— 专用 `RenderTargetMrt` 模块

几何任务的 `outputTarget` 根据 `textureDescriptions` 数组设置 `colorFormats` 来构建。特定于 MRT 的渲染目标 API 位于独立模块（`engine/render-target-mrt.ts`）中，与每一个现有场景所使用的单附件 `RenderTarget`（`engine/render-target.ts`）分离。这种拆分使非几何场景无需为 MRT 辅助函数付出体积代价：

- `RenderTargetMrt` 拥有 `colorFormats: readonly GPUTextureFormat[]`（1..8）、`_colorTextures: GPUTexture[]`、`_colorViews: GPUTextureView[]`，以及当 `sampleCount > 1` 时的 `_resolveColorTextures` / `_resolveColorViews`（MSAA → 解析）。
- 单附件 `RenderTarget` 保持其原有的 `_colorTexture` / `_colorView` 形态——为保持二进制格式兼容性而与 `master` 保持一致。
- `createRenderTargetMrt` / `buildRenderTargetMrt` / `disposeRenderTargetMrt` / `getSampledColorTexture` / `getSampledColorView` 从 MRT 模块导出，且仅由几何渲染器按需加载。

`GeometryRendererTask` 上的每个按类型访问器（例如 `geometryViewNormalTexture`）返回一个单附件 `RenderTarget` 包装器，其 `_colorTexture` / `_colorView` 通过 `getSampledColorTexture` / `getSampledColorView` 别名指向底层的 MRT 附件。该包装器设置 `_eager: true`，使 `buildRenderTarget` 成为空操作（真正的 GPU 纹理由 MRT 拥有）。这使下游任务（`createCopyToTextureTask`、后处理等）能够像消费普通单附件 RT 一样消费单个几何附件——它们完全不需要知道 MRT 的存在。

### Standard 材质几何视图

对于投射网格中的每一种唯一源 `Material`，任务都会创建一个 `MaterialView`，其 `_renderFeatures` 开启 `GEOMETRY_OUTPUT` 并清除 `MATERIAL_ALPHA_BLEND`。该视图共享源材质的绑定（纹理、采样器、UBO 数据），仅交换编译后的着色器管线。

`MaterialView` 间接层（原型继承包装器，见 `material/material-view.ts`）意味着源材质的 `diffuseTexture`、`bumpTexture`、`opacityTexture` 等属性会原样透传——每次属性查找都会回落到源材质上。几何任务复用常规 Standard 管线所使用的相同纹理句柄和采样器对象。

该视图编译后的片段 WGSL 是通过对 `composeStandardShader`（常规 Standard 组合器）的输出进行**后处理**生成的：

1. Standard 组合器发射完整的片段主体，包括凹凸扰动（通过 AC 槽位的 `normalW = perturbNormal(...)`）、不透明度纹理 Alpha 调制（`alpha *= textureSample(oT, oS, ...)`）、Alpha 剔除丢弃、实例化、精简实例颜色以及光照循环。这些逻辑都不会为几何通道重新实现。
2. 随后 `composeStandardGeometryShader`（位于 `standard-geometry-output-shader.ts`）对组合后的片段 WGSL 进行字符串修补：
    - 将入口点返回类型从 `-> @location(0) vec4<f32>` 重写为 `-> FragmentOutput`，
    - 在前置位置插入按请求附件数量确定大小的 `struct FragmentOutput { @location(0) f0: vec4<f32>, ... };` 声明，以及
    - 将 `return color;` 替换为根据已在作用域内的变量（`normalW`、`baseColor`、`alpha`、`input.vp`、`scene.view`、`gp.cameraNearFar`）计算的 MRT 写入语句。
3. 当任意请求的附件需要 `cameraNearFar` / `previousViewProjection`（`NORMALIZED_VIEW_DEPTH`、`LINEAR_VELOCITY`）时，会将一个小型 `~geometry-params` ShaderFragment 追加到片段列表中以贡献 `gp` UBO 绑定。该片段 id 以 `~` 开头，因此在组合器的字母表拓扑排序顺序中排在所有 `std-*` 扩展之后，从而使该绑定位于布局的末尾。

其结果是**每一个已启用的 Standard 材质和网格特性都能无缝贯通**：变形目标、骨骼蒙皮、凹凸扰动、不透明度纹理 Alpha 调制、Alpha 剔除、UV 缩放/偏移变换、RGBA 顶点颜色调制、实例化和精简实例颜色全部使用与主场景渲染相同的片段。Standard 几何路径根据源材质和当前网格特性位计算相同的有效材质特性掩码，然后镜像常规的绑定组和绘制缓冲区顺序。

可选的 Standard 骨骼 / 顶点颜色 / UV 偏移路径仍然位于已发布的 Standard 网格特性启用器之后。几何任务不会静态导入这些分块。骨骼上一帧骨骼状态是一个独立的动态分块，仅当同时存在骨骼启用器、匹配的 Standard 网格以及速度附件时才会被加载。

#### Standard 几何变体与缓存身份

`view._geometry` 以所有与着色器相关的输入作为键：

```
meshFeatures
sceneFeatures (including fog presence)
attachment list (owned by the view)
emitColor (owned by the view)
```

`meshFeatures` 包含变形、骨骼、8 骨骼蒙皮、顶点颜色、UV2、精简实例和实例颜色。存储在该键下的资源拥有组合后的着色器、网格 BGL 及其逐渲染目标的管线映射；其着色器模块来自以精确 WGSL 为键的逐设备备忘录（见“资源所有权与失败的重建”），因此相同的代码共享同一个模块。管线映射继续以完整的 MRT 目标签名作为键。在同一个设备上共享的带雾场景与无雾场景，当 `targetTexture` 请求光照颜色时，不能复用同一个 Standard 几何颜色着色器。

#### Standard 几何绑定与绘制顺序

Group-1 资源和顶点缓冲区严格遵循组合后的着色器：

1. 网格 UBO（`world`、灯光选择以及在请求时的速度字段），
2. 激活变形时的变形存储缓冲区，
3. 材质 UBO，
4. 漫反射纹理/采样器，
5. UV 变换 UBO，
6. 排序后的 Standard 扩展绑定（包括骨骼矩阵纹理），
7. 速度需要时的几何参数 UBO 和上一帧骨骼纹理。

顶点缓冲区依次为：位置、法线、UV/UV2、排序后的已启用扩展缓冲区（顶点颜色和骨骼关节/权重），然后是精简实例缓冲区。交错偏移来自 `MeshGPU._vbLayout`，与常规 Standard 绘制路径一致。

逐场景雾片段和 `STD_SCENE_FOG` 位参与 Standard 几何组合与缓存身份。在没有真实颜色目标的情况下，生成的受光照 `color` 和雾混合对于 WGSL 编译器而言属于死代码；在有 `targetTexture` 时，同一片段会生成前向雾化颜色。

逐附件的 `writeGeometryInfo` 门控（`wg = select(0.0, 1.0, alpha > 0.4)`）匹配 BJS `default.fragment.fx` PREPASS：配合逐附件 `ALPHA_COMBINE` 混合状态，低不透明度采样会保留目标（背景），而高不透明度采样会覆盖它。当源材质具有 `alpha < 1` 或 `HAS_OPACITY_TEXTURE` 时，MRT 管线会开启逐附件 Alpha 混合并关闭深度写入。

顶点颜色为 `vec4<f32>`。其 RGB 乘以 `baseColor`；其 Alpha 在 Alpha 测试丢弃和几何写入门控之前乘以运行中的 Standard `alpha`。省略的 Standard `uvOffset` 在前向和几何 UV UBO 中始终贡献 `[0, 0]`，即使为另一个材质全局启用了 UV 偏移支持也是如此。

`REFLECTIVITY` 附件会重新采样 `sT`/`sS`（高光纹理 + 采样器），以恢复 std-specular 片段在写入 `specularColor.rgb` 时丢弃的光泽度 Alpha 通道。

### 速度附件

当请求 `LINEAR_VELOCITY` 时，任务会跨帧为其现有材质路径跟踪逐网格世界矩阵。`excludeFromVelocity(mesh)` 和 `includeInVelocity(mesh)` 允许调用方将单个网格排除在速度跟踪之外（例如已知静止的实例或天空盒/HUD 网格）。

对于 Standard 网格，renderable 会用 `previousWorld` 和一个速度启用标量扩展 `MeshUniforms`。当前裁剪空间位置使用完全变形后的 `out.vp`；上一帧裁剪空间位置使用先前的局部世界快照和变形状态。骨骼速度为每个 renderable 惰性创建两个 `rgba32float` 骨骼纹理和两个匹配的绑定组。每次更新都会采样上一帧写入的纹理，同时 `queue.writeTexture` 为下一帧刷新空闲纹理，随后交换角色。仅前向的骨骼和非骨骼几何场景永远不会加载此实现。

第一帧从当前状态初始化上一帧世界矩阵和两个骨骼纹理，并保持速度门控禁用，产生零运动。`excludeFromVelocity()` 会清除逐网格 UBO 门控，而局部上一帧状态继续推进，因此重新包含时无需重建绑定组，也不会产生过时帧跳变。

### 深度附件

当省略 `config.depthTexture` 时，任务会自行分配 `depth32float` 深度纹理。传入外部 `RenderTarget` 可以与另一个任务（例如主场景渲染任务）共享现有的深度附件。几何管线的深度格式取自实际附着的深度-模板纹理。

### 相机

`config.camera` 覆盖逐通道相机。省略时，任务在 `execute()` 时读取 `scene.camera`。视图矩阵和视图-投影矩阵都会通过 `writePassSceneUBO()` 写入任务自己的场景 UBO 中。

## CopyToTextureTask

在场景 145 的替代条带中用于显示几何附件。在 `record()` 中选择两条执行路径之一：

- **快速路径** —— `GPUCommandEncoder.copyTextureToTexture`。当没有视口、源和目标均为单采样且格式相同、源 mip 尺寸与目标附件尺寸匹配、目标不是交换链，且源/目标纹理创建时带有 `COPY_SRC`/`COPY_DST` 时适用。帧图渲染目标默认携带这两种拷贝用途；不具备所需用途的外部/预分配纹理会回退到 blit 路径。基于纹理的颜色包装器保留 `_colorSubresource`，以便编码器拷贝目标使用附件所选定的 `mipLevel` 和图层（`origin.z`），而不是整个分配的默认 mip/图层。没有此元数据的目标保留普通的 mip 0、图层 0 目标。源包装器同样提供物理源 mip 和 `origin.z`。它的视图只暴露恰好一个 mip：`lodLevel` 是相对于视图的并钳位到零，因此拷贝使用其所选 mip 的尺寸而不会再做偏移。普通源保留其现有的源 LOD 选择。如果所选源尺寸与目标尺寸不同，blit 路径改为采样包装器所选的视图。

- **Blit 路径** —— 全屏三角形采样源纹理。MSAA 源使用 `textureLoad` 逐采样解析。LOD 层级通过 `textureSampleLevel` 应用。当源和目标具有不同的 `flipY` 朝向时，会翻转 Y 轴。

当 `ownsTargetTexture` 为 true 时，任务在每次帧图构建期间重建其目标，在 `targetTexture` 更改时销毁先前拥有的目标，并在任务销毁时销毁当前目标。`sourceTexture` 不能是引擎的 `scRT`，因为它的 GPU 纹理每帧都在变化。仅解析（resolve-only）和 blit-加-解析（blit-plus-resolve）模式使用 `resolveTexture` 进行硬件 MSAA 解析。

当设置了视口时，颜色附件的 `loadOp` 为 `"load"`（从而保留视口外的像素——这是叠加在场景渲染之上的替代条带所必需的），否则为 `"clear"`。

## 场景 145

`lab/src/lite/scene145.ts` 是几何渲染器任务的主要一致性/集成测试。它加载公共的 Hill Valley `.babylon` 场景，通过 MSAA 交换链 `RenderTask` 渲染它，在相同的网格上运行一个六附件 `GeometryRendererTask`，并使用六个 `CopyToTextureTask` 在画布顶部的一条带状区域中显示这些几何附件：

1. `NORMALIZED_VIEW_DEPTH`
2. `VIEW_NORMAL`
3. `WORLD_NORMAL`
4. `WORLD_POSITION`
5. `REFLECTIVITY`
6. `ALBEDO`

在所选格式下，六个附件每采样点共占 34 字节（考虑 WebGPU 对齐后略高于默认的 32 字节上限），因此场景调用 `createEngine(canvas, { requiredLimits: { maxColorAttachmentBytesPerSample: 64 } })`。

BJS 参考场景移植自 [Playground #ARI9J5#6](https://playground.babylonjs.com/#ARI9J5#6)（去除了不在 Lite 范围内的 `FrameGraphGUITask` 叠加层）。一致性测试相对于 BJS 基准图以 `MAD ≈ 0.002` 通过——MaterialView 后处理方式逐字复用了标准片段主体，因此替代条带与 BJS 逐像素匹配（没有有损的材质常量近似）。

## 测试规范

- 极简 Standard 组合不包含雾辅助函数/混合 WGSL。
- 显式 Standard 雾上下文包含辅助函数/混合 WGSL。
- 在同一设备上，含雾与无雾的 Standard 绑定和几何颜色资源保持分离。
- 缺失的 `uvOffset` 在前向和几何 UBO 数据中写入零。
- 带骨骼的 Standard 几何组合包含共享蒙皮辅助函数、骨骼绑定、关节/权重布局、变形后的世界位置/法线，以及上一帧骨骼速度状态。
- 带顶点颜色的 Standard 几何组合在丢弃/写入掩码之前调制反照率和 Alpha，并绑定颜色缓冲区。
- 变形/骨骼/顶点颜色特性位参与几何资源键构建。
- 重新录制任务、renderable 版本重建以及重新发布等效上下文的前向 PBR 重建均不会编译新的 Standard 或 PBR 几何着色器模块；组合出相同 WGSL 的材质共享同一对模块；写入不同附件的任务仅编译其新的片段模块并共享同一顶点模块；替换后的设备编译自己的模块。
- 被回收的 PBR 插件变体和 Standard 材质变体会在活动变体保持共享的同时离开备忘录；被销毁的任务仅释放没有其他任务用来绘制的模块，其最后一个持有者清空该条目。
- 顶点或片段模块编译失败的候选仅释放它已获取的模块，不创建条目，不从活动代次持有的阶段扣减计数，并销毁其网格 UBO；重试时只编译一次缺失的阶段。
- 重新同步会保留前向 renderable 未变的网格条目（新网格、重新录制、无关交换），仅重建被触及的条目，包括由场景自身生产方（材质 setter、`markMeshRenderableDirty`、`rebuildMaterial`、`addToScene`）驱动的情况；使用已绘制材质的新网格复用缓存的视图和变体；共享 Standard 变体的材质 UBO 在延迟回收期间存活，直到其最后一个所有者释放它；失败的替换使所有保留条目保持完好；失败的同步（无论是增量同步还是针对更改后的相机或剔除方向）使视图缓存保持为已发布状态，因此恢复配置后会在其自身视图上重建刷新后的条目；Node 条目每次同步都会重建，且经过多次同步交换后的 Node 材质不会从已发布视图中保留任何早期材质或视图的可达引用。
- 在浮动原点下，被跟踪网格相对通道用于绘制的相机进行打包：在没有覆盖的任务上替换 `scene.camera`（具有相同的世界矩阵版本）之后、在其相机变为 `config.camera` 且 `scene.camera` 随后移走之后、在 `config.camera` 作为场景相机时被移除且 `scene.camera` 随后移走之后，以及在用其他场景相机绘制若干帧并再次回到标记的相机之后的录制中。
- 针对被取代的前向 PBR 上下文所组合的 PBR 几何变体不会被复用。
- PBR 视图为每个活动前向上下文保留一套变体集合：在将场景上下文上的网格和逐网格运行时构建上下文上的网格绑定（每个上下文一个变体）之后，对其中任意网格的逐网格刷新和批量刷新均不会编译任何内容。

## 未来扩展

- **PBR 支持** —— 用 `pbr-geometry-output-shader.ts` 镜像 `standard-geometry-output-shader.ts`，对 PBR 组合器的片段输出进行后处理（将入口返回和 `return finalColor;` 重写为 MRT 写入）。
- **高斯泼溅（Gaussian splatting）+ 精灵** —— 将高斯泼溅网格和精灵批次渲染到相同的 MRT 附件中。标志管线已存在（Standard 上的 `GEOMETRY_OUTPUT`）；剩余工作为逐渲染器的管线组合。

## 相关文档

- `28-frame-graph.md` —— `Task` / 单附件 `RenderTarget` API。
- `29-post-process.md` —— 兄弟帧图任务族。
- `08-standard-material.md` —— Standard 材质特性和绑定。
- `engine/render-target-mrt.ts` —— 仅 MRT 的渲染目标模块，由 `geometry-renderer-task.ts` 按需加载，因此现有场景无需为多附件 API 付出任何开销。
