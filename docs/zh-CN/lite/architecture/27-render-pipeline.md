# 模块：Renderable + 帧图架构

> 包路径：`packages/babylon-lite/src/render/renderable.ts`、`packages/babylon-lite/src/frame-graph/`

## 目的

渲染管线由场景拥有的帧图（frame graph）驱动。材质仍然拥有着色器、管线和绑定组；帧图只负责调度渲染通道，并请求材质的 renderable 绑定针对特定目标的绘制闭包。

这使得引擎渲染循环保持与材质无关，同时允许同一个 `Renderable` 参与具有不同目标签名（颜色/深度格式、深度比较函数以及 MSAA 采样数）的多个通道。

## 公共 API 接口

### Renderable 契约（`render/renderable.ts`）

```typescript
export interface DrawUpdateContext {
    readonly targetWidth: number;
    readonly targetHeight: number;
    readonly _camera?: Camera | null;
}

export interface DrawBinding {
    readonly renderable: Renderable;
    readonly pipeline: GPURenderPipeline;
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, engine: EngineContext): number;
    update?(context: DrawUpdateContext): void;
    readonly _updateBatches?: readonly DrawUpdateBatch[];
    _sortDistance?: number;
}

export interface Renderable {
    readonly order: number;
    readonly isTransparent: boolean;
    readonly _transmissive?: boolean;
    readonly _direct?: boolean;
    readonly mesh?: Mesh;
    _sortDistance?: number;
    _worldCenter?: [number, number, number];
    _lastMaterial?: any;
    _lifetimeDisposers?: (() => void)[];
    _rebuild?: () => Renderable | Promise<Renderable>;
    bind(engine: EngineContext, target: RenderTargetSignature): DrawBinding;
}

export interface PrePassRenderable {
    execute(encoder: GPUCommandEncoder, engine: EngineContext): number;
}

export interface MeshGroupBuildResult {
    renderables: Renderable[];
    updater?: SceneUniformUpdater;
    rebuildSingle: MeshRebuilder;
}

/** @internal Auxiliary rebuilds register resources with their caller, not the scene. */
export interface MeshRebuildResources {
    readonly _lifetimeDisposers: (() => void)[];
}

export type MeshRebuilder = (scene: SceneContext, mesh: Mesh, materialOverride?: Material, resources?: MeshRebuildResources) => Renderable;
```

`Renderable.bind(engine, target)` 是关键的职责分离点：材质模块针对通道目标解析一次管线，并返回一个 `DrawBinding` 闭包。`RenderTask` 拥有场景绑定组（group 0），因此 renderable 本身从不设置绑定组 0。

在开启渲染通道之前，每一帧都会为每个绑定调用一次 `DrawBinding.update(context)`。该上下文包含当前通道目标尺寸（`targetWidth`、`targetHeight`）以及当前通道相机（`_camera`），以便绑定可以刷新依赖目标尺寸的 UBO 或按相机排序的实例缓冲区，而无需重建其管线或绑定组。不依赖这些状态的网格/材质 UBO 更新同样使用该钩子，并通过版本号守卫其写入操作。

不透明材质族的 renderable 可以将多个网格合并为一个缓存的绘制绑定。此类绑定中的每个逐网格数据包仍然保持独立所有权：移除网格会在 GPU 回收之前同步标记并分离其数据包，隐藏或已分离的数据包永远不会被更新或绘制。逐数据包资源会随其所属网格一起回收；由合并材质组共享的资源则会保留到最后一个数据包回收为止。

### 帧图（`frame-graph/`）

```typescript
export interface Task {
    readonly name: string;
    readonly engine: EngineContext;
    readonly scene?: SceneContext;
    _passes: Pass[];
    record(): void;
    _preload?(): Promise<void>;
    _removeMesh?(mesh: object): void;
    execute?(): number;
    dispose(): void;
}

export interface FrameGraph {
    _tasks: Task[];
    _currentProcessedTask: Task | null;
    build(): void;
    execute(): number;
    dispose(): void;
}
```

除非调用时传入 `{ defaultRenderTask: false }`，否则 `createSceneContext()` 会预先创建一个带有单个名为 `"scene"` 的默认 `RenderTask` 的 `FrameGraph`，该任务将渲染到交换链中。将场景渲染到离屏源目标并将最终通道写入交换链的后处理管线会禁用此默认任务，以免场景被绘制两次。用户代码可以通过 `addTask()`、`addTaskAtStart()` 或 `addTaskBefore()` 添加任务。

### RenderTask

`RenderTask` 是内置的直接执行任务。`record()` 准备其渲染目标、描述符、场景绑定以及暂存的绘制字段；`execute()` 开启 WebGPU 渲染通道，更新/分桶/绘制 renderable，并结束通道。它的 `_passes` 数组保持为空。通用的 `Task` 契约仍然支持基于通道的自定义任务。

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

重要字段：

| 字段         | 含义                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `rt`         | 具体的颜色/深度渲染目标。单采样默认任务可以使用表面拥有的 `scRT`；MSAA 任务使用自有的多重采样目标。                                       |
| `rst`        | 可选的单采样解析目标，在 `rt` 为多重采样时使用。默认 MSAA 场景任务会解析到表面的 `scRT`。                                                 |
| `depth`      | 可选的独立深度目标。预分配（eager）目标为借用；非预分配目标由任务构建和销毁。                                                             |
| `clr`        | `true`/undefined 时清除颜色；`false` 时加载之前的颜色内容，用于叠加层或多场景合成。                                                       |
| `depthClear` | 独立控制 `rt` 拥有的深度。`true`/undefined 时清除深度；`false` 时加载现有深度。外部 `depth` 目标保留其自身的所有权策略。                  |
| `sharedRt`   | 使用由更早任务拥有并录制的渲染目标；此任务不会构建或销毁 `rt`/`rst`。                                                                     |
| `cam`        | 逐通道相机覆盖；默认为 `scene.camera`。                                                                                                   |
| `cs`         | 使用画布尺寸而非 RTT 尺寸来计算场景 UBO 的宽高比。当 RTT 纹理必须以画布宽高比渲染时使用。                                                 |
| `autoMirror` | 设为 `false` 以保留空的显式渲染列表，而不是镜像场景的 renderable 列表。                                                                   |

`addMeshToTask(task, mesh, { material })` 接受源材质或 `MaterialView`。网格在 `record()` 阶段通过已完成的场景局部材质组的 `r` 闭包进行解析，从而使显式离屏任务能够以特定于通道的材质特性渲染同一个网格，而无需修改 `mesh.material`。独立几何视图工厂显式选择加入 `_sceneIndependentRebuild`；只有这些工厂可以在不存在场景组时回退到 `_buildGroup._rebuildSingle`。

对于多个网格，`addMeshesToTask(task, meshes, { material })` 按输入顺序排队，并在活动任务上最多发布一次绑定代次（generation）。失败会恢复调用前的队列和代次。`removeMeshesFromTask(task, meshes)` 使用成员集合压缩所有任务列表，并一次性重新选择/释放更新批次。空批次为空操作；特定于任务的刷新钩子保留与单独调用相同的填充与移除语义。

`RenderTask.enabled` 默认为 `true`。将其设为 `false` 会在执行更新、附件加载、解析或绘制之前跳过该通道。

## 运行时流程

```text
createSceneContext(engine)
  -> createFrameGraph(engine, scene)
  -> append default swapchain RenderTask unless defaultRenderTask is false
  -> build frame graph

startEngine/registerScene frame:
  scene._update()
    -> before-render callbacks
    -> material swap processing
    -> shadow generators and legacy pre-passes
    -> shared uniform updaters
  scene._record()
    -> frameGraph.execute()
      -> task.execute() when present
      -> otherwise each pass._execute()
```

`FrameGraph.build()` 对每个任务调用 `record()`，然后初始化所有已录制的通道。`RenderTask.record()` 构建渲染目标，在处于场景镜像模式时跟随场景 renderable，解析待处理的 `addMeshToTask()` 输入，暂存逐目标的 `DrawBinding` 列表，作为最后的可失败步骤刷新任务拥有的场景绑定组，只有在此之后才发布绘制字段以及描述符/尺寸更新。`FrameGraph.execute()` 会直接调用任务的 `execute()` 函数，而不是排空 `RenderPass`。

## RenderTask 分桶

在录制/重新同步时，渲染通道任务将绑定划分为以下分桶：

| 分桶        | 来源标志                           | 绘制路径                                                                                     |
| ----------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Opaque      | `!isTransparent && !_direct`       | 缓存的 `GPURenderBundle`；在新的绑定代次或全局可见性/资源纪元（epoch）变化时重建             |
| Direct      | `_direct`                          | 在不透明 bundle 之后直接绘制                                                                 |
| Transparent | `isTransparent \|\| _transmissive` | 直接绘制，逐通道按相机空间深度从后向前排序                                                   |

不透明和直接绘制绑定按 `renderable.order` 排序。透明绑定必须保持按相机空间深度排序，不按管线排序。`_transmissive` 标记真正的场景纹理折射表面；渲染任务将它们路由到同一个排序后的透明循环中，以便透射快照在当前透射绘制之前立即发生。`_direct` 选择非透明的直接绘制分桶；写入深度的可变精灵/公告板批次会设置 `_direct` 而不设置 `_transmissive`，使它们仍能出现在不透明场景折射 RTT 中。

`_lastVersion` 是在构建活动绑定代次之前捕获的场景 renderable 版本号。自动镜像任务用它来检测源列表同步，`enableRenderTaskMeshRefresh` 使用相同的快照来检测何时需要重建被跟踪网格的 renderable。绘制执行从不覆盖它。不透明 bundle 缓存是独立的：发布绑定会提供一个全新的空 `_ob`，显式失效会清除 `_ob`，而 `_vis` 纪元变化会重建该 bundle。仅替换 group-0 灯光缓冲区会清除 `_ob`，使 bundle 捕获新的场景绑定组，但会保留 `_lastVersion` 和材质绑定代次。因此它会重建一次 bundle，而不会冗余地重新绑定每个材质或触发显式网格刷新。相同的规则也适用于透射分通道路径。

## 逐通道场景 UBO

每个 `RenderTask` 拥有：

- `_sceneUBO`
- `_sceneBG`，在首次录制时创建
- 场景 UBO 暂存/缓存数组

场景 UBO 随任务一同分配。其绑定组仅在首次录制需要时创建；灯光缓冲区存储仍归场景所有。在发布新的绘制绑定代次之前，绑定创建必须成功，从而使失败的首次录制可以重试。

`writePassSceneUBO()` 为通道写入规范的 352 字节 `SceneUniforms` 结构体。所有渲染目标都使用相同的正向投影/剔除约定；下游纹理拷贝和后处理着色器会在没有逐目标翻转标志的情况下自行处理采样约定。任务级 UBO 允许 RTT 通道、画布通道和相机覆盖共存，而无需修改全局场景状态。

## 场景绑定组布局缓存

`render/scene-helpers.ts` 中的 `getSceneBindGroupLayout(engine)` 将不可变的 group-0 布局惰性缓存在 `WeakMap<GPUDevice, GPUBindGroupLayout>` 中。共享同一设备的引擎会获得相同的布局；不同设备或替换设备则使用独立的键。新创建的布局只有在 `GPUDevice.createBindGroupLayout()` 成功后才会插入缓存，因此失败的分配仍可重试，且绝不会返回上一个设备创建的布局。

场景布局独立于材质管线/绑定组缓存。清除 Standard、PBR、Shader 或 Node 材质缓存不会清除场景布局，设备恢复也不需要显式使布局失效：替换后的 `GPUDevice` 会自然选择新的键，而失效的设备条目保持可被弱引用回收。`clearSceneBGLCache()` 仅保留为面向专项测试和工具的显式内部重置方法；生产环境的材质缓存清除和恢复路径不会保留或调用它。

## 光照模块边界

光照支持经过拆分，以便每个使用方只保留其所需的层：

- `render/lights-ubo.ts` 是一个兼容外观（facade）模块。它不包含实现，仅重新导出下面的场景状态、网格布局和网格选择辅助函数。
- `render/scene-lights-ubo.ts` 拥有场景级 GPU 光照状态：共享灯光缓冲区/暂存/版本记录、`ensureSceneLightState()`、`refreshSceneLightsUBO()`、`getLightsUboSize()`，以及用于特定任务相机/光源的 `_writeTaskLightsData()`。
- `render/mesh-light-layout.ts` 仅拥有着色器/UBO 布局构建：`appendMeshLightUboFields()` 和 `meshLightIndexWGSL()`。Standard/PBR 模板导入此模块，而不会保留场景灯光上传代码。
- `render/mesh-light-selection.ts` 通过 `writeMeshLightSelection()` 拥有逐网格的包含/排除过滤和索引打包。Standard/PBR/Node 的 renderable 构建器导入它，而不会保留场景状态分配。

`RenderTask` 和设备恢复直接导入 `scene-lights-ubo.ts`。材质模板导入 `mesh-light-layout.ts`，而材质 renderable 构建器导入 `mesh-light-selection.ts`。这使得场景 GPU 状态所有权、着色器声明和逐网格 CPU 选择成为相互分离且可 tree-shake 的关注点。

## 材质拥有的管线

Standard 阴影变体键（variant-key）的构建私有于惰性接收器片段。共享的 Standard 材质类型/特性模块不得重新导出它：否则即使未使用的接收器入口也可能通过共享模块导出把阴影键代码保留在普通 Standard 打包产物中。

`standard-material.ts` 仅包含类型和兼容重导出。运行时特性检测位于 `standard-material-features.ts`，而管线缓存键构建私有于 `standard-pipeline.ts`。渲染器、插件桥接和几何体加载器直接导入各自的具体操作而非材质外观模块，从而避免通过材质创建和加载产生循环依赖。

材质 renderable 构建器仍然负责：

1. 根据网格/材质/场景状态计算特性位
2. 动态导入所需的着色器片段
3. 组合 WGSL
4. 创建/缓存管线和绑定组布局
5. 返回其 `bind(engine, target)` 能为该目标签名选择正确管线的 renderable

帧图从不导入特定于材质的着色器代码。

## 材质视图（Material Views）

材质视图是源材质之上的轻量级、特定于通道的视图。当渲染任务需要针对同一源材质状态使用不同的渲染特性时（例如将 Standard/PBR 网格渲染到阴影深度 RTT 中），就会使用材质视图。

```typescript
export interface Material {
    readonly _buildGroup: MeshGroupBuilder;
    _renderFeatures?: MaterialRenderFeatures;
    _uboVersion: number;
}

export interface MaterialRenderFeatures {
    features: number;
    features2?: number;
}

export interface MaterialView extends Material {
    readonly source: Material;
    _renderFeatures: MaterialRenderFeatures;
}

export function createMaterialView(source: Material, renderFeatures: MaterialRenderFeatures): MaterialView;
export function markMaterialUboDirty(materialOrView: Material): void;
export function rebuildMaterial(scene: SceneContext, materialOrView: Material, options?: RebuildMaterialOptions): void;

// Public, read-only material-family discriminator.
export function getMaterialFamily(material: Material): string | undefined;

// Public, read-only enumeration of the material's currently bound 2D textures.
export function getMaterialTextures(material: Material): readonly Texture2D[];

// Public TypeScript type guards for the well-known core material families.
export function isPbrMaterial(material: Material): material is PbrMaterialProps;
export function isStandardMaterial(material: Material): material is StandardMaterialProps;
export function isShaderMaterial(material: Material): material is ShaderMaterial;
export function isNodeMaterial(material: Material): material is NodeMaterial;
```

`getMaterialFamily()` 返回一个稳定字符串，用于标识材质所属的具体材质族，从而使场景浏览器、序列化器和诊断工具仅使用公共 API（绝不使用私有渲染器字段或属性形状启发式判断）即可显示材质族。它会将 `MaterialView` 解包至其 `source` 并读取材质 `_buildGroup` 上声明的材质族。它返回 `"pbr"`、`"standard"`、`"shader"`（包括网格材质及其他基于 `createShaderMaterial` 的材质）、`"node"` 或 `undefined`（特意在 `string | undefined` 签名中体现，以便调用方处理未知情况）。材质构建器接口（`_buildGroup`）为 `@internal`，因此包的使用者无法自行编写构建器：用户创建的“自定义材质”要么是 `createShaderMaterial`（报告为 `"shader"`），要么是节点材质（`"node"`），当前 `getMaterialFamily` 不会返回任意用户定义的字符串。尽管如此，其返回类型仍为原始 `string` 而非字符串字面量联合类型，以便将来可以在不破坏兼容性的前提下添加新的核心材质族，并在将来引入公共自定义材质族构建器 API 时保持向前兼容（它会原样透传任何已标记的字符串）。

`getMaterialTextures()` 返回一个新分配的只读数组，其中包含材质当前绑定的所有非空 `Texture2D` 句柄。它支持 Standard、PBR、Shader 和 Node 材质族，包括已注册的材质扩展和插件纹理。未知材质族返回空数组。材质视图会解包到其源材质，以便枚举报告源材质的绑定。该函数实现在无副作用模块中，未被导入时打包体积为零字节。

`isPbrMaterial()`、`isStandardMaterial()`、`isShaderMaterial()` 和 `isNodeMaterial()` 是基于 `getMaterialFamily()` 的正式 TypeScript 类型守卫：每个守卫都会将 `Material` 窄化为对应的具体材质族类型（`PbrMaterialProps`、`StandardMaterialProps`、`ShaderMaterial`、`NodeMaterial`）。针对匹配源材质的 `MaterialView` 也会通过其材质族的守卫，因为它通过原型链继承了源材质的所有属性。所有这些函数均可完全 tree-shake：从不调用它们的场景不会为它们保留任何字节。

`createMaterialView()` 创建一个兼容材质的对象，其原型为源材质，随后仅存储视图拥有的渲染特性位以及一个 `source` 指针。纹理、采样器、uniform、Alpha/剔除状态、扩展数据、`_buildGroup` 和 UBO 版本号均继承自源材质。基于另一个视图创建视图会自动折叠到原始源材质；源材质一侧不保留视图注册表。

材质 renderable 有意不导入材质视图辅助函数或解包源材质。它们直接正常读取所选材质对象：普通材质在构建时重新计算并存储 `material._renderFeatures`，而视图则提供自身的 `_renderFeatures` 并从源材质继承其他所有属性。这使得材质视图辅助函数字节仅隔离在导入了 `createMaterialView()` 或特定族视图辅助函数的场景中。网格/通道特性位保持独立，并在每个 renderable 上单独计算。

`markMaterialUboDirty()` 递增 `source._uboVersion`，以便从该源派生的每个 renderable/视图都能独立观察标量/向量 UBO 变化。`rebuildMaterial()` 扫描场景网格并匹配该源材质或以其为 `source` 的视图；`rebuildViews: false` 则将匹配限制为确切传入的材质/视图。当发生特性/布局变化时（例如纹理更改、采样器/布局更改、Alpha/剔除更改或视图特性更改）使用它。

### PBR 材质重建生命周期

`rebuildMaterial()` 清除源材质缓存的 `_renderFeatures`，运行可选的 `scene._materialRebuild` 接缝（seam），并收集匹配的场景网格。材质族不是 `"pbr"` 的网格始终通过其组的闭包（`resolveMeshRebuild`）逐个重建。此次调用中的 PBR 网格会走两条路径之一，该路径在调用内部同步决定，因此当请求本应加入待处理的 PBR 组重建时就会加入其中：

- **组重建（默认）。** 每个 PBR 网格经过运行时网格构建（`scene-runtime-mesh-build.ts`）并加入一次 PBR 组重建（`rebuildScenePbrPipelines`）：场景中的每一个 PBR renderable 都会被替换，捕获的场景状态会被刷新，新的 PBR 上下文会被发布，并且帧图会被重建。在场景构建之前，尚未拥有已构建组的 PBR 网格会被跳过（延迟构建会构建它）。
- **逐网格重建。** 仅当 `_pbrRebuildsComposed(scene, pbrMeshes)`（`material/pbr/pbr-built-variant.ts`）对整个集合返回 `true` 时才走此路径。每个 PBR 网格通过场景局部组闭包 `r` 重建，与材质赋值完全相同，不会触及任何其他 PBR renderable、PBR 上下文或帧图。

**冷启动。** `material-rebuild.ts` 通过动态导入加载 `pbr-built-variant.ts`，并将 `_pbrRebuildsComposed` 保存在模块级变量中。第一次匹配到 PBR 网格的 `rebuildMaterial()`（在任意场景中）只会启动该导入并走组重建路径；一旦该导入解析完成，后续调用就会使用该检查。如果导入失败则被忽略，PBR 重建继续走组重建路径。从不重建 PBR 材质的场景不会获取任何这部分代码。

**构建时快照。** `buildPbrRenderables()` 通过 `rebuildSingle` 构建其所有网格，然后将其着色器组合器缓存键存入 PBR 几何上下文（`_PbrGeometryContext._b`）上的 `_b = new Set(composePbr._c.keys())`（见 06-pbr-material，“Composed Shader Caching”）。快照中的每个变体都是在该次构建加载了其网格所需的惰性 WGSL 和辅助模块之后组合的，因此再次组合它将返回完整的着色器。后续通过闭包组合的变体（运行时材质赋值）不会被添加进来：此类变体可能缺少该次构建从未加载过的模块。每次组构建（初始构建、运行时构建的逐网格上下文、组重建）都会在它发布的上下文上存储各自的快照。

**适用条件。** 仅当没有运行时构建正在进行（`scene._runtimeBuilds.w`）且集合中的每一个 PBR 网格都满足以下全部条件时，`_pbrRebuildsComposed` 才返回 `true`：

1. 该材质的场景局部组存在，拥有其闭包 `r`，且列出了该网格（不在成员列表中的网格需要组重建才能将其移入）。
2. 该网格没有精简实例（thin instance）也没有运行时精简实例构建（`_runtimeThinBuild`），且材质不是透射材质（`_transmissive`）：它们的闭包还捕获了该键未编码的剔除与折射状态。
3. 闭包将向其组合器请求的键存在于上下文的 `_b` 中。该键为 `_pbrComposeKey(features, features2, meshFeatures, ctx._sceneFeatures, lightMode, singleLightType, mesh._gpu._vbKey ?? "", mat._uv2Mask ?? 0, mat._pi ?? 0)`，其中 `features`/`features2` 来自缓存的 `_renderFeatures`，或者在其被清除时通过 `_computePbrMaterialFeatures(mat)` 计算而不填充缓存；`ctx`、`meshFeatures`、`lightMode` 和 `singleLightType` 来自 `_pbrMeshRequest(scene, mesh, features2 & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT))`。

只要有一个网格不符合条件，本次调用中的所有 PBR 网格都会走组重建路径。如果检查抛出异常，错误会通过返回的 Promise 报告，并且 PBR 网格走组重建路径。

**逐网格执行。** 该调用清空场景的材质交换队列，填入此次调用的 PBR 网格，使用 `processMaterialSwaps(scene)` 同步排空它，然后放回因其他原因排队的网格，这些网格保持其位置以供下一帧排空。排空会通过 `r` 重建每个网格并递增材质的 `_csmGen`、`scene._renderableVersion` 和 `scene._materialEpoch`，与材质赋值相同。复用的闭包保留了它捕获的场景状态（环境纹理、阴影灯光、雾、色调映射），而不是刷新它们。如果设置了 `rebuildFrameGraph: true`，在所有待处理工作稳定后，无论走哪条路径都会重建一次帧图。

**回退。** 如果排空过程抛出异常，该调用清空队列，通过返回的 Promise 报告一次错误（`rebuildMaterial()` 会将其转发至 `scene._runtimeBuilds._x` 和 `console.error`），并将这些网格送入组重建。排空已经回收了失败网格的 renderable，因此一旦该组重建提交，网格就会重新绘制。相反，如果让网格继续留在队列中，会导致帧排空在每一帧都重新抛出异常。

**测试。** `tests/lite/unit/pbr-built-variant.test.ts` 覆盖了适用条件规则（组中另一个网格曾用来构建的变体；构建后通过闭包组合的变体；构建从未组合过的 UV2、UV 变换和阴影接收更改；精简实例、透射和非成员网格；正在进行的运行时构建）。`tests/lite/unit/runtime-material-rebuild.test.ts` 覆盖了冷启动、两条路径、因其他原因排队的网格、逐网格路径上的 `rebuildFrameGraph`，以及重建抛出异常后的回退行为。

## `_buildGroup` 模式

材质在其 props 上携带 `_buildGroup: MeshGroupBuilder`。`addToScene()` 按构建器对网格进行分组，延迟构建器在渲染前运行以生成 renderable。

`MeshGroupBuildResult.rebuildSingle` 作为 `r` 存储在场景组上，用于材质交换和逐通道材质覆盖。构建器自身的 `_rebuildSingle` 缓存并不代表另一个场景的就绪状态；没有 `r` 的现有组必须先完成其构建，然后才能重建网格。

NodeMaterial 顶点特性使用可选的类型化编译器/绑定接缝。内置的 `MorphTargetsBlock` 直接安装变形（morph）特性；对于仅设置了既定 `usesMorphTargets` 标志的公共自定义块加载器，异步材质解析器会在管线编译前动态导入并安装相同的特性。这种兼容回退不是同步管线依赖，因此普通的静态 Node 图不会获取变形 WGSL、绑定代码或零目标回退分配。

Node 光照选择遵循相同的显式启用规则。设置了 `usesLightsUbo` 的发射器会安装 `node-lighting.ts` 网格布局/写入接缝；仅设标志的自定义发射器会从异步解析器回退处获得相同的接缝。无光照 Node 材质仅保留 20 浮点数的世界/接收器/属性标志网格 UBO，且不导入网格光照选择代码。受光照材质保留现有的 `lc`/`li` 字段、`nli()` 辅助函数、group-0 灯光声明、40 浮点数网格 UBO 和逐网格索引打包。

辅助任务重建会将 `MeshRebuildResources` 穿过每个包装器和专用构建器。带上该参数时，构建器会在后续可失败工作之前将清理操作注册到传入的生命周期列表中，而不是替换网格在场景中拥有的销毁器条目。不带该参数时，普通场景渲染使用主网格销毁器列表。不存在单独的场景拥有辅助注册表：渲染任务和几何任务各自拥有自己的辅助资源。任务回滚仅释放未发布的辅助资源；移除或替换则会在已提交的 GPU 工作完成之后回收已发布的资源。共享几何视图资源保留其 renderable 所有者，因此回收一个任务的条目或交换主材质不会销毁另一个任务仍在使用的存储。

Standard 重建上下文保留特定于场景的片段工厂和场景的阴影存在标志，而不是另一个引擎引用或详细的阴影槽位列表。重建器从其传入的场景解析引擎。组构建成功后，几何通道共享同一个已完成的工厂对象，而不是将其雾和变形（morph）成员复制到第二个上下文对象中。

Standard 和 PBR 阴影接收器模块各自拥有其共享的 group-2 绑定解析器。其缓存在接收器模块加载后才创建，并以 GPU 绑定组布局对象为键。两个材质族使用相同的描述符构建逻辑，保留灯光顺序以及每个灯光的纹理/采样器/uniform 三元组。普通材质构建器既不保留该构建循环，也不保留阴影绑定缓存。Standard 着色器生成也直接使用现有的场景局部阴影槽位，而不是为每个网格投影生成新的槽位和生成器数组。Standard 接收器模块还拥有槽位捕获、变体键构建以及由该场景构建中的所有网格复用的惰性创建不可变接收器片段。非阴影 Standard 渲染不保留任何这些操作。

内部工厂为 `createMaterialShadowBindings(engine: EngineContext, lights: readonly { readonly gen: ShadowGenerator }[]): (layout: GPUBindGroupLayout) => GPUBindGroup`。每次调用都会创建一个独立的弱键缓存。布局只有在绑定组成功创建后才会发布到该缓存中，因此失败的构建仍可重试，且无需借用其他场景的生成器。

绑定可以暴露特性拥有的 `_updateBatches`。其生产方仅在需要时在目标签名上安装收集器；普通渲染使用可选的批次重置/刷新钩子，而不保留收集和回收实现。这项工作独立于 renderable 生命周期所有权，不需要第二套销毁器映射代次。缓存的批次代次在调度回收时即变为不可用，而不是等到其栅栏（fence）完成时。因此重新激活会创建新的代次，且旧代次的延迟或重复销毁绝不会驱逐其替代者。被另一个活动状态保留的批次既不会被回收，也不会从其缓存中移除。uniform 批次工厂拥有缓存和专用收集器的替换逻辑。在其栅栏排空后，已回收的条目仅保留已清理的弱键代次元数据，直到该签名被复用或垃圾回收；延迟销毁从不修改缓存或当前收集器。由其他特性安装的通用收集器会被保留。uniform 生产方将固定大小的引擎拥有暂存图像加入队列。入队操作会验证对齐，在累计所需字节数的同时为每次拷贝分配打包上传偏移量，并仅在其源图像变化时使缓存的字节视图失效。两次刷新遍历会复用这些偏移量，而不是重新计算前缀和。刷新仅需要 CPU 打包和 GPU 拷贝录制遍历，而不需要单独的大小/验证扫描。图像内容在打包前保持有效，并且队列上传仍然在录制任何 GPU 拷贝命令之前完成。仅含 uniform 的收集会复用一个不可变的单批次状态。当另一个生产方加入候选时，通用收集器会在追加批次前拷贝该状态；它绝不会修改先前已发布的仅含 uniform 状态。

着色器组合为每个片段保留一条依赖记录，并为每个交错组保留一条原生顶点布局记录。第一个属性仍然决定其组的步长和步进模式；未分组的布局按首次出现顺序排在分组之前。材质绑定保持在阴影绑定之前，基础模板替换保持其原始顺序。这些仅是 CPU 端的准备更改：生成的 WGSL 和 GPU 布局描述符保持不变。

## Babylon.js 对照表

| Babylon Lite                            | Babylon.js                                        |
| --------------------------------------- | ------------------------------------------------- |
| `FrameGraph` + `Task`                   | Frame graph / 渲染图调度                          |
| `RenderTask`                            | 绑定目标 + 相机状态的渲染通道任务                 |
| `Renderable.bind()`                     | 面向目标的材质/特效子网格绑定                     |
| `DrawBinding`                           | 预准备的绘制项 / 子网格绘制数据包                 |
| `MaterialView`                          | 特定于通道的材质变体 / 渲染覆盖                   |
| 任务拥有的场景 UBO                      | 逐通道场景 uniform 状态                           |
| Opaque/transmissive/transparent 分桶    | 渲染组绘制列表                                    |
| `renderable.order`                      | 渲染顺序 / 组排序                                 |

Node 变形位置和法线辅助函数由同一个带权增量循环模板生成，在六浮点增量记录中分别使用偏移 `0` 和 `3`。这仅共享了 CPU 端的源码构建；发射出的 WGSL、加载索引和浮点累加顺序保持不变。

## 依赖关系

- `render/renderable.ts` 仅导入引擎/网格/渲染目标类型。
- `frame-graph/frame-graph.ts` 仅依赖 `Task`，并使用每个任务已经捕获的引擎。
- `frame-graph/render-task-base.ts` 拥有普通录制和执行逻辑，不导入辅助重建所有权代码。
- `frame-graph/render-task.ts` 暴露任务创建以及可独立 tree-shake 的 `addMeshToTask`；任务填充拥有事务性辅助重建。
- 材质模块依赖 `Renderable` 并返回可绑定目标的 renderable；帧图不依赖材质模块。
- `material/material-view.ts`、`material/material-dirty.ts` 和 `material/material-rebuild.ts` 拥有供渲染任务和材质族使用的共享材质视图和材质重建辅助函数。

## 文件清单

| 文件                                         | 用途                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/render/renderable.ts`                   | `Renderable`、`DrawBinding`、`PrePassRenderable`、可选 `SceneUniformUpdater`、`MeshGroupBuildResult`、`MeshGroupBuilder`    |
| `src/frame-graph/task.ts`                    | 多态帧图任务接口                                                                                                             |
| `src/frame-graph/frame-graph.ts`             | 有序任务列表、build/execute/dispose 生命周期                                                                                 |
| `src/frame-graph/frame-graph-actions.ts`     | `addTask`、`addTaskAtStart`、`addTaskBefore` 辅助函数                                                                        |
| `src/frame-graph/render-task-base.ts`        | 逐通道场景 UBO、renderable 分桶、RTT/交换链通道执行                                                                          |
| `src/frame-graph/render-task.ts`             | 公共任务创建与显式启用（opt-in）的网格填充                                                                                   |
| `src/frame-graph/render-task-transaction.ts` | 辅助重建发布、回滚与所有权                                                                                                   |
| `src/render/draw-update-batches.ts`          | 可选批次收集与生命周期协调                                                                                                   |
| `src/render/scene-helpers.ts`                | 以 GPUDevice 为键的场景 BGL 缓存、世界矩阵 UBO 更新及默认管线描述符构建                                                      |
| `src/render/lights-ubo.ts`                   | 重新导出拆分后光照辅助函数的兼容外观模块                                                                                     |
| `src/render/scene-lights-ubo.ts`             | 场景拥有的共享灯光缓冲区、暂存/版本状态、上传刷新以及特定任务的灯光数据写入器                                                |
| `src/render/mesh-light-layout.ts`            | 网格灯光 UBO 字段声明与 WGSL 索引访问器                                                                                      |
| `src/render/mesh-light-selection.ts`         | 逐网格灯光过滤与打包灯光索引写入                                                                                             |
| `src/shadow/material-shadow-bindings.ts`     | 仅接收器用的阴影绑定组构建与由 Standard/PBR 共享的逐场景布局缓存                                                             |
| `src/material/material.ts`                   | 共享材质、材质视图和渲染特性接口                                                                                             |
| `src/material/material-view.ts`              | 轻量级材质视图创建与源规范化                                                                                                 |
| `src/material/material-dirty.ts`             | 源材质 UBO 版本递增辅助函数                                                                                                  |
| `src/material/material-rebuild.ts`           | 源材质及其视图的重建辅助函数                                                                                                 |
