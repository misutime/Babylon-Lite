# 模块：节点粒子（Node Particles，NPE）

> 包路径：`packages/babylon-lite/src/particle/`
>
> 本文档完整规范了节点粒子特性。其内容足以重建解析器、图构建器、CPU 模拟、特性列存储、精灵表支持、公告板与 Sprite2D 同步以及实时注册路径。

## 1. 范围与目标

该特性在 CPU 上执行序列化的节点粒子编辑器（Node Particle Editor，NPE）图。其兼容性边界为此处列出的 NPE 节点块与序列化值集合，而非完整的经典 `ParticleSystem` 接口。

设计要求如下：

- 仅支持 CPU NPE 图。不存在 GPU 粒子模拟路径。
- `ParticleSystem` 为可变纯状态。行为由独立函数提供。公共接口通过 `startParticleSystem`、`stopParticleSystem` 和 `animateParticleSystem` 等函数保持命令式风格；不暴露 Babylon 风格的粒子系统构造函数或挂载在粒子系统上的方法。
- 粒子属性采用结构体数组（Struct-of-Arrays，SoA）存储。每个粒子是一个整数槽位，而非堆分配的粒子对象。
- 模拟顺序、随机数消耗、数值存储及生命周期边界遵循 Babylon.js 兼容契约，并以 Babylon.js 作为等价性真值参考进行验证。
- 渲染支持两个显式目标：面向相机的世界空间公告板（billboard），以及基于 NPE 世界 XY 平面的纯 2D Sprite2D 桥接。Sprite2D 路径不投影 XZ 或 YZ 平面。
- 代码与可选存储遵循按需付费原则。可达的节点块求值器按需动态导入，可选特性列仅由需要它们的特性分配。每个缓冲区均包含第 4 节所述的底层模拟列及标准 NPE 渲染/生命周期列。
- 基于索引的模拟路径不在每粒子或每次更新时分配内存。图读取器返回标量或复用的暂存值。公告板同步会为每个存活粒子分配临时值；Sprite2D 同步则直接写入紧凑缓冲区，不产生按粒子的内存分配。

## 2. 包根入口 API

`packages/babylon-lite/src/index.ts` 精确导出了二十七个节点粒子函数和十二个节点粒子类型。

### 2.1 函数

```ts
function parseNodeParticleSource(source: unknown): ParticleGraph;
function normalizeNodeParticleGraph(graph: ParticleGraph): Promise<ParticleGraph>;

function buildNodeParticleSet(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithBlendModes(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithFlowMaps(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithNoiseTextures(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithTextureUpdates(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithEmitterProvider(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    provider: NodeParticleEmitterProvider,
    options?: BuildNodeParticleOptions
): Promise<NodeParticleSet>;
function withNodeParticleEmitterProvider<T extends object = BuildNodeParticleOptions>(
    provider: NodeParticleEmitterProvider,
    options?: T & BuildNodeParticleOptions
): T & BuildNodeParticleOptions;
function enableNodeParticleBlendModes(set: NodeParticleSet): NodeParticleSet;

function parseNodeParticleSetFromSnippet(engine: EngineContext, scene: SceneContext, snippetId: string, options?: ParseNodeParticleOptions): Promise<NodeParticleSet>;

function startParticleSystem(system: ParticleSystem): void;
function stopParticleSystem(system: ParticleSystem): void;
function isParticleSystemStarted(system: ParticleSystem): boolean;
function animateParticleSystem(system: ParticleSystem, scaledRatio: number): void;

function createParticleBillboard(system: ParticleSystem): FacingBillboardSpriteSystem;
function syncParticleBillboard(system: ParticleSystem, billboard: FacingBillboardSpriteSystem): void;

function registerNodeParticleSet(scene: SceneContext, set: NodeParticleSet, options?: RegisterNodeParticleOptions): void;
function getParticleSystems(scene: SceneContext): readonly ParticleSystem[];

function createParticleSprite2DBridge(system: ParticleSystem, options?: ParticleSprite2DBridgeOptions): ParticleSprite2DBridge;
function syncParticleSprite2DBridge(bridge: ParticleSprite2DBridge): void;
function registerNodeParticleSet2D(renderer: SpriteRenderer, set: NodeParticleSet, options?: RegisterNodeParticleSet2DOptions): NodeParticleSet2DBinding;
function disposeNodeParticleSet2DBinding(binding: NodeParticleSet2DBinding): void;

function createParticleSprite2DBridgeWithBlendModes(system: ParticleSystem, options?: ParticleSprite2DBridgeOptions): ParticleSprite2DBlendModesBridge;
function syncParticleSprite2DBridgeWithBlendModes(bridge: ParticleSprite2DBlendModesBridge): void;
function registerNodeParticleSet2DWithBlendModes(renderer: SpriteRenderer, set: NodeParticleSet, options?: RegisterNodeParticleSet2DOptions): NodeParticleSet2DBlendModesBinding;
function disposeNodeParticleSet2DBlendModesBinding(binding: NodeParticleSet2DBlendModesBinding): void;
```

上方列出的全部二十七个函数——包括图规范化器、构建选项辅助函数以及混合模式启用器——均为包根公共导出。`ParticleGraph` 由 `parseNodeParticleSource` 返回，并由 `normalizeNodeParticleGraph` 接收和返回，但它不是包根处的具名节点粒子类型导出。TypeScript 通过解析器/规范化器调用链推导图类型，且汇总生成的声明文件也沿用现有解析器 API 的表示方式，未新增随意的具名导出。

### 场景发现

对于内联 JSON 与代码片段（snippet）构建，`ParticleSystem.name?: string` 均保留非空的 NPE `SystemBlock` 名称。未命名系统省略该属性。`isParticleSystemStarted(system)` 返回 `_started && !_stopped`：已停止的系统中 `buffer.alive` 里仍可能包含正在排空的粒子。容量仍可通过 `buffer.capacity` 访问；启动/停止使用现有的独立函数。

`getParticleSystems(scene)` 仅枚举通过 3D `registerNodeParticleSet` 注册的系统，按首次注册顺序排列，并按对象标识去重。它返回实时的只读数组；若需快照请自行拷贝。`SceneContext` 声明了一个可选的 `@internal _particleSystems?: ParticleSystem[]` 字段及纯类型导入；这不会产生任何输出代码，且该字段会从发布的声明文件中裁剪。粒子模块负责其分配与清理。在现有的按系统注册循环中，首个系统懒分配该列表并安装恰好一个用 `length = 0` 清空它的场景销毁器；每个系统仅在尚未包含于列表时追加。在场景销毁之前，该列表只增不减，现有引用可观察到清空效果。若不存在列表，读取器返回一个新数组 `[]`。

枚举去重**不会**对渲染去重：每次注册仍会构建其公告板并压入各自的帧回调。现有的回调顺序、帧中注册、拾取注册以及 `autoStart` 行为保持不变。不提供注销或调度器合并功能。2D 绑定不会被枚举，列出的系统均为 CPU 系统。开销仅为每个粒子场景一个懒数组及一个清理闭包、每次注册一次按标识 `includes` 检查，以及每个命名系统一个名称引用；非粒子场景不会创建任何此类存储。

针对性测试覆盖了有序成员关系、重复注册但保留重复渲染、`autoStart: false`、回调顺序与帧中注册、场景隔离、销毁、名称保留以及带有排空粒子的已启动/已停止状态。

### 2.2 类型

```ts
interface BuildNodeParticleOptions {
    emitter?: Vec3;
    emitterWorldMatrix?: Mat4;
    textureBaseUrl?: string;
}

interface ParseNodeParticleOptions extends BuildNodeParticleOptions {
    json?: string | object;
    snippetServer?: string;
}

type NodeParticleEmitterProvider = () => Mat4;

interface NodeParticleSet {
    readonly systems: ParticleSystem[];
    /** @internal */
    _graph: ParticleGraph;
}

interface RegisterNodeParticleOptions {
    autoStart?: boolean;
}

interface ParticleSprite2DBridgeOptions {
    pixelsPerUnit?: number;
    originPx?: readonly [number, number];
    invertY?: boolean;
    layer?: Pick<Sprite2DLayerOptions, "opacity" | "visible" | "order" | "view">;
}

interface ParticleSprite2DBridge {
    readonly system: ParticleSystem;
    readonly layer: Sprite2DLayer;
    pixelsPerUnit: number;
    originPx: [number, number];
    invertY: boolean;
}

interface RegisterNodeParticleSet2DOptions extends ParticleSprite2DBridgeOptions {
    autoStart?: boolean;
}

interface NodeParticleSet2DBinding {
    /** @internal */
    readonly _entityType: "node-particle-set-2d-binding";
    readonly bridges: readonly ParticleSprite2DBridge[];
    active: boolean;
    /** @internal */
    _dispose: () => void;
}

interface ParticleSprite2DBlendModesBridge {
    readonly system: ParticleSystem;
    /** Primary presentation layer: the only layer for modes 0-3/default, or the Multiply layer for mode 4. */
    readonly layer: Sprite2DLayer;
    /** All ordered render-pass layers. Mode 4 contains `[Multiply, Add]`; every other mode contains `[layer]`. */
    readonly layers: readonly Sprite2DLayer[];
    pixelsPerUnit: number;
    originPx: [number, number];
    invertY: boolean;
    /** @internal */
    readonly _passes: readonly ParticleSprite2DBridge[];
}

interface NodeParticleSet2DBlendModesBinding {
    /** @internal */
    readonly _entityType: "node-particle-set-2d-blend-modes-binding";
    readonly bridges: readonly ParticleSprite2DBlendModesBridge[];
    active: boolean;
    /** @internal */
    _dispose: () => void;
}
```

`ParticleSystem` 是第十个导出类型，详见第 5 节。`ParticleSprite2DBlendModesBridge` 与 `NodeParticleSet2DBlendModesBinding` 分别是第十一个和第十二个导出类型。`NodeParticleEmitterProvider` 是纯状态源：它不接收任何运行时对象，仅返回一个矩阵值。`NodeParticleSet.systems` 是只读属性背后的可变数组，每个系统及其类型化数组都是可变的。两个桥接类型家族均暴露只读的 system/layer 引用，同时保持 `pixelsPerUnit`、`originPx` 和 `invertY` 可变。两个绑定类型家族均暴露只读的桥接列表与可变的 `active` 状态。所有公共类型均为纯状态；行为保留在独立函数中。

### 2.3 破坏性迁移

构建后的 `enableNodeParticleEmitterProvider` API 已被移除，且不提供已废弃的兼容垫片。请将发射器提供方选择移入构建器选项中：

```ts
// Removed
await enableNodeParticleEmitterProvider(await builder(engine, scene, graph, options), provider);

// Replacement for every node-particle builder, including snippet parsing
await builder(engine, scene, graph, withNodeParticleEmitterProvider(provider, options));
```

默认构建器的便捷函数仍保留为 `buildNodeParticleSetWithEmitterProvider(engine, scene, graph, provider, options)`。选项辅助函数返回浅拷贝，保留扩展特有字段（例如 `ParseNodeParticleOptions.json` 与 `snippetServer`），并让提供方优先于静态 `emitterWorldMatrix` 与 `emitter` 值。

### 2.4 Phase 3 图迁移

直接调用 `parseNodeParticleSource` 的用户需要在调用任何构建器之前显式启用 Teleport、LocalVariable、Elbow 与 Debug 支持。一份规范化后的图可与默认、流场贴图、噪声、组合纹理更新、混合模式及带提供方的构建器家族自由组合：

```ts
const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(source));
const set = await buildNodeParticleSet(engine, scene, graph);
```

若使用未规范化的图直接调用构建器，且其中某条可达边指向 `ParticleTeleportOutBlock`，则会保留原有的不支持的值块错误。这种省略报错行为是有意设计的：解析器可以表示 Teleport 记录，但直接构建器仅在调用方对图完成规范化后才支持其路由语义。

同样，当省略直接规范化时，Elbow 与 Debug 仍不受支持。LocalVariable 拥有自己的求值器，因此结构简单的未规范化图虽然能触达该可选求值器，但这样做会绕过强制性的连接角色与域掩码校验，属于不受支持的用法。任何包含 Phase 3C 类的直接图都必须先经过规范化。

`parseNodeParticleSetFromSnippet` 本身就是一个异步的任意内容边界，因此它在解析之后、默认构建之前总是会调用 `normalizeNodeParticleGraph`。内联 JSON 与远程拉取的代码片段由此自动获得 Teleport 支持。不含 Teleport 的代码片段仅付出极轻量的图扫描开销，直接从辅助函数收到原解析图引用，且不会拉取重型运行时。

### 2.5 内部 API

以下符号属于实现级内部 API，不是节点粒子的包根导出：

- 图类型：`ParticleGraph`、`ParsedParticleBlock` 与 `ParsedParticleInput`。
- 构建类型：`NpeBuildState`、`NpeBuildContext` 与 `NpeBlockEvaluator`。
- 值类型：`NpeValue`、`NpeTextureValue`、`NpeTextureContent`、`NpeGetter`、`ScalarGetter`、`Vec3Getter`、`Color4Getter` 与 `ParticleStep`。
- 存储类型与函数：`ParticleColumn`、`ParticleBuffer`、`createParticleBuffer`、`column`、`spawnParticle` 与 `killParticle`。
- 运行时构造：`ParticleSpriteHandle` 与 `createParticleSystem`。
- 精灵特性：`SpriteSheetConfig`、`SpriteSheet`、`useSpriteSheet` 与 `useRandomSpriteSheet`。
- 代码片段传输：`fetchNodeParticleSnippet`。
- 图布线运行时：`normalizeNodeParticleGraphRuntime` 及内部 `_isGraphPlumbingNormalized` 标记。
- 上下文工厂、局部位置辅助函数、求值器值以及注册表加载器。

## 3. 模块、所有权与数据流

直接数据流如下：

```text
serialized value
    -> parseNodeParticleSource
    -> ParticleGraph
    -> for a Teleport graph: explicit normalizeNodeParticleGraph
     -> buildNodeParticleSet
         or buildNodeParticleSetWithBlendModes for exact billboard Multiply/MultiplyAdd rendering
         or buildNodeParticleSetWithFlowMaps for UpdateFlowMapBlock graphs
         or buildNodeParticleSetWithNoiseTextures for UpdateNoiseBlock graphs
         or buildNodeParticleSetWithTextureUpdates for graphs containing both
         with options from withNodeParticleEmitterProvider for a live emitter matrix on any builder
         or buildNodeParticleSetWithEmitterProvider as the default-builder convenience form
     -> optional enableNodeParticleBlendModes for exact billboard blending on a set from any builder
    -> NodeParticleSet { systems }
    -> startParticleSystem / stopParticleSystem / animateParticleSystem
        -> billboard target:
                 createParticleBillboard + syncParticleBillboard
                 -> addBillboardSystemToScene or registerNodeParticleSet
             or pure-2D target:
                 createParticleSprite2DBridge + syncParticleSprite2DBridge
                 -> addSpriteRendererLayer or registerNodeParticleSet2D
             or exact-blend pure-2D target:
                 createParticleSprite2DBridgeWithBlendModes + syncParticleSprite2DBridgeWithBlendModes
                 -> registerNodeParticleSet2DWithBlendModes
```

代码片段便捷数据流如下：

```text
inline JSON or fetched snippet response
    -> parseNodeParticleSource
    -> normalizeNodeParticleGraph automatically
        no TeleportOut -> exact graph, heavy runtime not fetched
        TeleportOut    -> lazy runtime normalization
    -> buildNodeParticleSet
```

运行时分层如下：

```text
particle-buffer.ts       dense typed-array storage and slot lifecycle
particle-system.ts       mutable system state and CPU simulation
sprite-columns*.ts       optional sprite cell state and animation
particle-billboard.ts    conversion of live columns to billboard instances
particle-blend.ts        exact Babylon.js particle blend descriptors
particle-billboard-scene.ts
                         ordinary/advanced scene registration boundary
particle-billboard-renderable.ts
                         lazy Multiply shader and MultiplyAdd second pass
particle-scene.ts        scene registration and per-frame callback wiring
particle-sprite-2d.ts    packed Sprite2D bridge and renderer binding lifecycle
particle-sprite-2d-blend-modes.ts
                         optional exact Sprite2D descriptors, Multiply shader, and mode-4 pass/lifecycle composition

node/npe-parser.ts       serialized source normalization
node/npe-types.ts        readonly TypeScript graph shapes
node/npe-build.ts        root-reachable DFS and system construction
node/npe-blend-modes.ts  explicit Multiply/MultiplyAdd rendering enabler
node/npe-emitter-provider.ts
                         build-options helper, provider validation/copy/inverse refresh, and convenience builder
node/npe-value.ts        indexed getter and step contracts
node/npe-texture-content.ts
                         pay-for-use CPU RGBA texture decoding
node/npe-texture-update-runtime.ts
                         shared lazy graph walk for one CPU texture update family
node/npe-contextual*.ts  contextual source getters and optional columns
node/npe-local-position.ts
                         local birth seeding and world-position conversion
node/npe-registry*.ts    side-effect-free dynamic evaluator dispatch
node/blocks/*.ts         supported block classes, variants, and helpers
```

`particle-billboard.ts` 生成 `FacingBillboardSpriteSystem`；公告板子系统负责图集解析、常规管线选择、GPU 实例数据及基础可渲染对象构建。粒子包仅拥有懒加载的 Multiply 片元主体以及包裹基础可渲染对象的 MultiplyAdd 包装器，不重复实现公告板几何体或实例缓冲区。

私有 Multiply 着色器将其顶点 WGSL 保留在局部，同时复用 `makeBillboardBasisWgsl`。经测量，共享运行时顶点辅助函数因跨 chunk 边导致不使用粒子混合的普通公告板 bundle 体积增大，因此予以弃用。

`particle-sprite-2d.ts` 创建并独占式批量写入 `Sprite2DLayer`；精灵子系统继续拥有该图层的紧凑布局、脏追踪、上传、管线与 `SpriteRenderer` 绘制路径。`particle-sprite-2d-blend-modes.ts` 是该基础桥接器的独立粒子侧按需消费方。它复用精确描述符工厂，仅添加了 Sprite2D Multiply 片元与模式 4 图层组合，不导入任何公告板可渲染对象或场景注册模块。普通桥接器绝不导入精确模式模块。粒子包负责粒子到渲染目标的映射以及实时注册策略，而非通用材质、管线、绑定组或 GPU 实例缓冲区实现。

### 3.1 `particle/` 之外的直接依赖

- 相机：`camera/camera.ts`。
- 引擎类型：`engine/engine.ts`。
- 数学：`math/types.ts`、`math/random-range.ts`、`math/create-identity-mat4.ts`、`math/invert-mat4.ts`、`math/invert-mat4-to-ref-or-identity.ts`、`math/mat4-transform.ts` 和 `math/create-translation-mat4.ts`。
- 场景：`scene/scene.ts` 和 `scene/scene-core.ts`。
- 纹理：`texture/texture-2d.ts`。
- 精灵：`sprite/shared/sprite-atlas.ts`、`sprite/billboard-sprite.ts`、`sprite/billboard-blend.ts`、`sprite/billboard-scene.ts`、`sprite/billboard-custom-shader.ts`、`sprite/billboard-pipeline.ts`、`sprite/billboard-renderable.ts`、`sprite/sprite-2d.ts`、`sprite/sprite-blend.ts`、`sprite/sprite-custom-shader.ts` 和 `sprite/sprite-renderer.ts`。

`billboard-scene.ts` 将公告板注册为场景持有的延迟可渲染对象和拾取源。它在构建场景可渲染对象时动态导入 `sprite/billboard-renderable.ts`，并在拾取首次需要该拾取源时动态导入 `picking/billboard-pick-pipeline.ts`。

Sprite2D 依赖是单向的：按需启用的粒子桥接器导入精灵模块，而静态 Sprite2D 代码绝不导入粒子代码。基础桥接器也不导入高级桥接器。因此，未导入任一桥接器的场景不付出粒子桥接字节开销，仅导入基础桥接器的场景也不付出精确描述符、自定义着色器或双通道字节开销。

## 4. 粒子存储

### 4.1 内置列

`createParticleBuffer(capacity)` 创建 21 列，每列精确包含 `capacity` 个元素：

| 字段                                                   | 类型化数组     | 含义                     |
| ------------------------------------------------------ | -------------- | ------------------------ |
| `posX`, `posY`, `posZ`                                 | `Float32Array` | 世界渲染位置             |
| `dirX`, `dirY`, `dirZ`                                 | `Float32Array` | 运动方向或速度           |
| `age`                                                  | `Float64Array` | 已存活粒子时间           |
| `lifeTime`                                             | `Float64Array` | 死亡阈值                 |
| `id`                                                   | `Uint32Array`  | 生成标识                 |
| `size`                                                 | `Float32Array` | 均匀粒子尺寸             |
| `angle`                                                | `Float32Array` | 渲染旋转角               |
| `scaleX`, `scaleY`                                     | `Float32Array` | 各轴尺寸乘数             |
| `colorR`, `colorG`, `colorB`, `colorA`                 | `Float32Array` | 当前渲染颜色             |
| `colorStepR`, `colorStepG`, `colorStepB`, `colorStepA` | `Float32Array` | 每生命周期单位的颜色变化 |

`ParticleColumn` 为联合类型 `Float64Array | Float32Array | Uint32Array | Uint16Array | Uint8Array | Int32Array`。

`ParticleBuffer` 定义为：

```ts
interface ParticleBuffer {
    readonly capacity: number;
    alive: number;
    readonly posX: Float32Array;
    readonly posY: Float32Array;
    readonly posZ: Float32Array;
    readonly dirX: Float32Array;
    readonly dirY: Float32Array;
    readonly dirZ: Float32Array;
    readonly age: Float64Array;
    readonly lifeTime: Float64Array;
    readonly id: Uint32Array;
    readonly size: Float32Array;
    readonly angle: Float32Array;
    readonly scaleX: Float32Array;
    readonly scaleY: Float32Array;
    readonly colorR: Float32Array;
    readonly colorG: Float32Array;
    readonly colorB: Float32Array;
    readonly colorA: Float32Array;
    readonly colorStepR: Float32Array;
    readonly colorStepG: Float32Array;
    readonly colorStepB: Float32Array;
    readonly colorStepA: Float32Array;
    readonly _columns: Map<string, ParticleColumn>;
    readonly _all: ParticleColumn[];
    _nextId: number;
}
```

存活粒子占据稠密区间 `[0, buffer.alive)`。`_all` 初始包含全部 21 个内置数组，并接收每个可选特性数组。

当 `alive >= capacity` 时，`spawnParticle` 返回 `-1`。成功时它预留 `i = alive`，递增 `alive`，写入 `id[i] = _nextId++`，写入 `age[i] = 0`，并返回 `i`。它不会清零其他基础或特性槽位；创建步骤必须写入各自负责的每一个字段。

`killParticle(buffer, i)` 递减 `alive`，当 `i` 不是最后一个槽位时将最后一个存活槽位拷贝到 `_all` 中每一个数组的 `i` 处，并使超出存活范围的值保持未指定状态。这种交换移除（swap-remove）规则同等适用于基础列、标准列以及仅特性列。

`column(buffer, name, ctor)` 在字符串键已存在时返回现有的 `_columns` 条目。否则它构造 `new ctor(capacity)`，按键存储，并将其追加到 `_all`。使用相同字符串的调用方共享同一个数组。该函数不会校验后续传入的构造函数是否与首次分配时一致。

### 4.2 标准渲染/生命周期字段

其中十二个内置 `Float32Array` 字段提供了标准的 NPE 创建与渲染状态：

| 状态       | 直接字段                                               |
| ---------- | ------------------------------------------------------ |
| 尺寸       | `size`                                                 |
| 旋转角     | `angle`                                                |
| 缩放       | `scaleX`, `scaleY`                                     |
| 颜色       | `colorR`, `colorG`, `colorB`, `colorA`                 |
| 颜色步长   | `colorStepR`, `colorStepG`, `colorStepB`, `colorStepA` |

`CreateParticleBlock` 在每次粒子诞生时初始化这些字段，上下文节点块与更新节点块读取或修改它们，`syncParticleBillboard` 与 `syncParticleSprite2DBridge` 则直接读取其中的渲染子集。Sprite2D 同步器仅消费 XY 位置并忽略 `posZ`。它们属于每个缓冲区的一部分，因为主要运行时契约是一个可渲染的 NPE 粒子系统。

### 4.3 特性专用列

除基础列和标准列之外，仅按需分配以下列：

- `InitialColor` 源 `0x13`：`initialColor.r`、`initialColor.g`、`initialColor.b` 与 `initialColor.a`，均为 `Float32Array`。
- `ColorDead` 源 `0x14`：`colorDead.r`、`colorDead.g`、`colorDead.b` 与 `colorDead.a`，均为 `Float32Array`。
- `InitialDirection` 源 `0x15`：`initialDir.x`、`initialDir.y` 与 `initialDir.z`，均为 `Float32Array`，除非网格法线发射模式选中了常量零源而不进行分配。
- `LocalPositionUpdated` 源 `0x18`：`localPosition.x`、`.y` 和 `.z`（`Float32Array`），`localPosition.id`（`Uint32Array`），以及 `localPosition.valid`（`Uint8Array`）。
- 块 `B` 的标量 `OncePerParticle` 随机缓存：`random.B.id`（`Uint32Array`）、`random.B.valid`（`Uint8Array`）以及 `random.B.value0`（`Float64Array`）。
- 块 `B` 的向量或颜色 `OncePerParticle` 缓存：相同的 id 与 valid 数组，外加 `random.B.value0...N`（`Float64Array`）。对于 Vector2 及其他非 Vector3/非 Color4 标签，分量数为 2；Vector3 为 3；Color4 为 4。块 id 是列键的一部分；id 列中存储的当前粒子 id 用于使被回收槽位失效。缓存内存受粒子容量限制。
- 精灵动画：`sprite.cellIndex`（`Uint16Array`）。
- 随机起始帧精灵动画：除 `sprite.cellIndex` 外，还有 `sprite.randomOffset`（`Float32Array`）。

## 5. ParticleSystem 与模拟

### 5.1 状态与默认值

```ts
interface ParticleSpriteHandle {
    readonly cellWidth: number;
    readonly cellHeight: number;
    readonly cellIndex: Uint16Array;
    readonly update: (i: number) => void;
}

interface ParticleSystem {
    readonly buffer: ParticleBuffer;
    emitRate: number;
    updateSpeed: number;
    targetStopDuration: number;
    blendMode: number;
    texture: Texture2D | null;

    createLifeTime: ParticleStep | null;
    createPosition: ParticleStep | null;
    createDirection: ParticleStep | null;
    createEmitPower: ParticleStep | null;
    createSize: ParticleStep | null;
    createAngle: ParticleStep | null;
    createColor: ParticleStep | null;
    createColorDead: ParticleStep | null;
    updateSteps: ParticleStep[];

    _scaledStep: number;
    _emitPower: number;
    _scaledUpdateSpeed: number;
    _newPartsExcess: number;
    _started: boolean;
    _stopped: boolean;
    _actualFrame: number;
    _emitRateGetter?: () => number;
    _prepareFrame?: () => void;
    _spriteSheet?: ParticleSpriteHandle;
    _writeColorDead?: (i: number, color: Color4) => void;
    _suppressInitialDirectionCapture?: boolean;
    _seedLocalPosition?: ParticleStep;
    _registerBillboard?: (scene: SceneContext, billboard: FacingBillboardSpriteSystem) => void;
}
```

`createParticleSystem(capacity)` 为内部函数。它创建一个全新缓冲区并设置：

| 字段                     | 默认值           |
| ------------------------ | ---------------- |
| `emitRate`                | `10`             |
| `updateSpeed`             | `0.0167`         |
| `targetStopDuration`      | `0`              |
| `blendMode`               | `2`              |
| `texture`                 | `null`           |
| 全部八个 `create*` 槽位   | `null`           |
| `updateSteps`             | `[]`             |
| `_scaledStep`             | `0`              |
| `_emitPower`              | `1`              |
| `_scaledUpdateSpeed`      | `0`              |
| `_newPartsExcess`         | `0`              |
| `_started`, `_stopped`    | `false`, `false` |
| `_actualFrame`            | `0`              |

可选内部字段在某特性安装它们之前均不存在。

### 5.2 启动与停止

`startParticleSystem(system)` 设置 `_started = true`、`_stopped = false` 以及 `_actualFrame = 0`。它不会清除存活粒子、id、列、创建/更新步骤、`_newPartsExcess`、纹理或特性句柄。

`stopParticleSystem(system)` 设置 `_stopped = true`。它不会将 `_started` 设为 `false`，也不会清除存活粒子。调用 `animateParticleSystem` 时会继续更新并使存活粒子到期死亡，同时抑制新粒子创建。

启动一个已停止的系统会重置模拟时间并允许重新发射，同时保留所有存活粒子与小数发射结余。

### 5.3 特性持有的帧准备

`_prepareFrame` 是一个可选的零参数回调。普通静态系统不设置它。`animateParticleSystem` 在 `_started` 守卫之后，且在缩放速度、动态发射率、已有粒子更新或粒子诞生之前调用它。公共模拟函数签名严格保持为 `(system, scaledRatio)`；相机与目标尺寸不是模拟输入参数。

基础粒子系统没有相机或目标尺寸准备 API。依赖相机的可选特性各自在其启用器后维护其准备工作。`UpdateFlowMap` 会追加一个场景回调，在相机控制回调之后、实时粒子模拟之前截取当前视图投影矩阵快照。当相机静止时，手动模拟可以直接使用构建时快照；或在修改相机/目标尺寸后调用已注册的场景回调。

`withNodeParticleEmitterProvider(provider, options)` 是构建时按需启用函数。它会立即采样并校验提供方，返回传入选项的浅拷贝（附带一个内部 `_setupEmitter` 回调），并通过泛型交叉返回类型保留扩展特有的选项字段。其结果可传递给任意节点粒子构建器或 `parseNodeParticleSetFromSnippet`。每个构建器在构造临时 `NpeBuildState` 之后、开始求值器遍历之前立即调用该回调。该回调会用提供方拥有的全新稳定矩阵替换调用方持有的静态矩阵引用，将初始矩阵与平移拷贝到稳定的求值器引用中，分配一个提供方拥有的全新逆矩阵列表，并在该系统上安装帧准备回调。提供方初始化不会修改原始选项或其 `emitterWorldMatrix`。

提供方初始化在求值器遍历之前通过其 Phase 2 闭包安装 `_prepareFrame`。首个可达的 Loop LocalVariable 会在遍历期间在其懒加载求值器内部以相同的“先旧后新”顺序包装该现有回调。将组合逻辑保持在特性局部可防止从未拉取的 LocalVariable 代码影响仅使用提供方或普通粒子的 bundle。提供方准备始终最先运行，若前序回调失败则后续回调不会执行，且不添加任何共享辅助函数或根文件。

初始化会立即将稳定的发射器向量、发射器矩阵和逆矩阵列表引用拷贝到局部变量中。提供方回调仅持有这些引用、提供方函数、一个私有下一帧矩阵暂存区、一个懒分配的求值逆矩阵暂存区以及任意先前的帧回调。它不会持有 `NpeBuildState`、`SceneContext`、`ParticleSystem`、其缓冲区、选项对象或图构建数据，也不反向指向所属系统。需要 Loop 组合包装器时，它仅持有先前的提供方回调及其特性持有的 epoch 递增操作。包装后的选项对象仅持有提供方、经校验的初始矩阵及初始化回调；绝不会累积对系统或构建过程的引用。静态系统不会分配提供方数组、逆矩阵列表集合、对象、闭包、暂存矩阵或提供方字段。

提供方返回值必须是有限的 16 元素矩阵。校验逻辑会先拷贝到私有暂存存储中，再触及构建器持有的引用。初始隐式圆柱体逆矩阵在遍历期间根据已拷贝的提供方矩阵计算。在已启动帧上，该系统的刷新逻辑会检查自身的逆矩阵列表，按需懒分配一个私有逆矩阵暂存区，并用退化矩阵回退为单位矩阵的逻辑计算采样逆矩阵。仅当完整采样全部成功后，刷新逻辑才会提交该系统的稳定发射器矩阵、平移向量与收集到的逆矩阵。提供方抛出的异常原样透传；结构或有限性错误则抛出显式提供方错误。无论哪种失败，都会保持稳定引用和粒子模拟状态完好无损。

辅助函数执行时的初始采样确立了提供方相对于包装选项中静态 `emitterWorldMatrix` 或 `emitter` 的优先级。提供方既可以在每次采样时返回新矩阵对象，也可以原地修改并返回同一对象；每次通过校验的采样都会被拷贝到稳定的构建器持有引用中。不存在构建后替换提供方的路径，系统上也不保留提供方句柄。

单个包装后的选项对象可以在多次构建间复用而互不耦合。它在辅助函数调用时采集的单一校验快照会为由该对象构建的每个系统提供初始值；初始化回调本身不会再次采样。随后每个已安装的帧钩子每帧会精确采样一次当前提供方，并仅在模拟前更新自己所属的系统。仅当后续构建需要在启动前使用新的构建时快照时，才需要新的包装对象。驱动两个系统会产生两次独立采样，每次模拟调用一次。未启动的系统调用会直接返回而不采样。已停止但曾启动的系统在其排空更新前仍会采样，因为 `stopParticleSystem` 不会清除 `_started`。

### 5.4 单次模拟调用

`animateParticleSystem(system, scaledRatio)` 严格按以下顺序执行操作：

1. 当 `_started` 为 false 时直接返回。
2. 若存在 `_prepareFrame`，调用 `_prepareFrame?.()`。
3. 计算 `scaledUpdateSpeed = updateSpeed * scaledRatio` 并赋值给 `_scaledUpdateSpeed`。
4. 若存在 `_emitRateGetter`，求值 `_emitRateGetter()`；否则读取 `emitRate`。连接了发射率端口的读取器会观察到此次调用尚未推进前的当前 `_actualFrame`。
5. 计算 `emission = emitRate * scaledUpdateSpeed` 与 `newParticles = emission >> 0`。
6. 将 `emission - newParticles` 累加到 `_newPartsExcess`。仅当 `_newPartsExcess > 1.0` 时，取 `extra = _newPartsExcess >> 0`，将 `extra` 加到 `newParticles`，并从 `_newPartsExcess` 中减去 `extra`。恰好等于 `1.0` 时不释放新粒子。
7. 若 `_stopped` 已为 true，将 `newParticles` 设为 `0`。此时发射率读取器与小数结余计算已经执行完毕。
8. 若 `_stopped` 为 false，将 `scaledUpdateSpeed` 加到 `_actualFrame`。当 `targetStopDuration` 为真值且 `_actualFrame >= targetStopDuration` 时，调用 `stopParticleSystem`。本次调用计算出的 `newParticles` 数量仍然保留，因此到达阈值的这一帧依然会创建该批粒子。
9. 更新在更新循环开始时即存活的所有粒子。
10. 在容量允许范围内创建至多 `newParticles` 个粒子。

`| 0` 与 `>> 0` 运算采用 JavaScript 有符号 32 位转换。发射率、比例及速度不做钳位或合法性校验。

### 5.5 已有粒子更新与死亡

按升序遍历每个稠密槽位：

1. 设 `stepSpeed = scaledUpdateSpeed` 及 `ageBefore = age[i]`。
2. 写入 `age[i] = ageBefore + stepSpeed`。
3. 若新年龄大于 `lifeTime[i]`，计算：

    ```ts
    const diff = age[i] - ageBefore;
    const remaining = lifeTime[i] - ageBefore;
    stepSpeed = (remaining * stepSpeed) / diff;
    age[i] = lifeTime[i];
    ```

4. 将可能被缩短的步长赋值给 `_scaledStep`。
5. 按数组顺序执行 `updateSteps` 中的每一个函数。
6. 若 `age[i] >= lifeTime[i]`，对该粒子执行交换移除。将循环索引减一，使从最后一个存活槽位拷贝过来的粒子在同一次调用中得以在新槽位上接受求值。

更新步骤在死亡边界上、槽位被回收之前运行一次。`_scaledStep` 保存按生命周期钳位后的单粒子步长。`_scaledUpdateSpeed` 始终保留全调用范围的步长值，包括在求值即将死亡的粒子期间。

### 5.6 粒子创建

对于每一次请求的诞生，调用 `spawnParticle`。返回 `-1` 会中止创建循环，使得该次诞生及后续剩余请求诞生的创建读取器与创建随机抽取均不再执行。

成功诞生时按以下固定顺序运行非空槽位：

1. `createLifeTime`
2. `createPosition`
3. `createDirection`
4. `createEmitPower`
5. `createSize`
6. `createAngle`
7. `createColor`
8. `createColorDead`

该顺序独立于图遍历顺序，属于随机数消耗契约的一部分。精灵诞生初始化挂载于 `createColorDead` 上，并在捕获的死亡颜色步骤之后运行。

### 5.7 确定性要求

- 形状发射器使用 `randomRange(min, max)`。当 `min === max` 时直接返回 `min` 而不调用 `Math.random()`；否则返回 `Math.random() * (max - min) + min`。
- `ParticleRandomBlock` 总是为每个输出分量消耗一次抽取，包括上下界相等的情况。
- 固定的创建顺序、有序的 `updateSteps`、先更新后创建顺序、发射结余阈值、目标停止时机以及死亡步长钳位必须保持精确一致。
- 位置、方向、标准渲染字段及多数特性值以 Float32 精度存储。年龄、生命周期以及 `OncePerParticle` 缓存值使用 Float64 存储。精灵单元格使用 Uint16 存储，id 使用 Uint32 存储。
- 向量与颜色读取器可能返回共享暂存值。消费方在调用另一个可能共享或覆写该暂存区的读取器之前，必须先拷贝所需的所有分量。

## 6. 序列化图与解析器

### 6.1 输入形状

解析器接收内部节点粒子载荷：

```ts
interface SerializedSource {
    blocks: Array<{
        customType?: string;
        id?: number;
        name?: string;
        inputs?: Array<{
            name?: string;
            targetBlockId?: number;
            targetConnectionName?: string;
            value?: unknown;
            valueType?: string;
        }>;
        [blockField: string]: unknown;
    }>;
}
```

### 6.2 规范化

按数组顺序遍历每个块，`parseNodeParticleSource` 执行：

- 要求 `typeof id === "number"`。
- 将 `customType` 中开头的 `BABYLON.` 去掉转为无前缀类名。缺失的类型变为 `""`。
- 使用 `name ?? ""`，不对块名称执行首尾去空格。
- 使用 `inputs ?? []`。
- 对每个输入名称执行首尾去空格。
- 保留数值型的 `targetBlockId`；其他任何值均变为 `null`。
- 对字符串型的 `targetConnectionName` 执行首尾去空格；其他任何值均变为 `null`。
- 按引用保留 `value` 并保留字符串型的 `valueType`。
- 将原始块对象本身保存为 `serialized`。
- 将解析后的块存入 `Map<number, ParsedParticleBlock>`，并将遇到的每一个 `SystemBlock` id 追加到 `systemBlockIds`。

重复的 id 会用最后一个携带该 id 的块覆盖 Map 条目。`systemBlockIds` 不去重，因此重复的序列化 `SystemBlock` id 会产生重复的根条目，并通过最终的 Map 条目解析。如果后续块覆写了该 Map 条目，原本记为 System 根的 id 也可能解析为另一个类。

TypeScript 图接口使用 `readonly`、`ReadonlyMap` 与 `Readonly<Record<...>>`。解析过程不调用 `Object.freeze`，不深拷贝源对象，也不会把运行时的 `Map`、数组或原始序列化值变为不可变对象。

### 6.3 解析器错误

解析器抛出以下显式错误：

- `NodeParticle: invalid source — expected a \`blocks\` array`
- `NodeParticle: block missing numeric id (name=<stringified name>)`
- `NodeParticle: graph has no SystemBlock`

它不会校验类名、重复 id、连接目标、输出名称、特定块的字段或数组内容。

### 6.4 代码片段传输

当 `options.json` 不为 `undefined` 时，`parseNodeParticleSetFromSnippet` 使用 `options.json`。字符串会通过 `JSON.parse` 解析；对象则直接送入图解析器。在此路径下 `snippetId` 会被忽略。

没有内联 JSON 时，函数会动态导入 `npe-snippet.ts`。`fetchNodeParticleSnippet` 执行：

1. 若未提供服务器地址，使用 `https://snippet.babylonjs.com`。
2. 将代码片段 id 中的所有 `#` 替换为 `/`。
3. 请求 `${server}/${convertedId}`。
4. 若响应非 OK，抛出 `NodeParticle: snippet fetch failed (<status>)`。
5. 将响应解析为 `{ jsonPayload: string }`。
6. 将 `jsonPayload` 解析为 `{ nodeParticle: string | object }`。
7. 当 `nodeParticle` 为字符串时再次解析。

畸形 JSON 与畸形响应形状会产生原生的 `JSON.parse`、属性访问或 `fetch` 错误。

## 7. 图构建器

### 7.1 根节点初始化

`buildNodeParticleSet` 为 `graph.systemBlockIds` 中每一个能在 Map 中解析到条目的 id 创建一个全新的运行时系统。缺失的根条目会被跳过。

对于每个根节点：

- 当 `systemBlock.serialized.capacity` 为数字时使用该值作为容量，否则使用 `1000`。
- 在任何块求值器运行前先执行 `createParticleSystem(capacity)`。
- 仅当 `systemBlock.serialized.isLocal === true` 时，`isLocal` 为 true。
- `options.emitterWorldMatrix` 优先于 `options.emitter`。公共构建选项不包含提供方字段。其唯一内部扩展点是一个可选的 `_setupEmitter(state)` 回调，其声明会从公共包类型中裁剪。
- 使用静态矩阵时，保留该矩阵引用，并将其索引 12、13 和 14 一次性拷贝到新的发射器 `Vec3` 中，从而保持现有的静态契约。
- 未提供矩阵时，将 `emitter` 选项或显式零向量拷贝到稳定发射器值及一个平移矩阵中。
- 在构造 `NpeBuildState` 后，构建器立即调用 `options._setupEmitter?.(state)`，随后开始图遍历。使用普通选项时该调用什么也不做，系统也不保留任何发射器状态或提供方句柄。提供方初始化在任何求值器捕获稳定发射器引用之前即已拷贝其通过校验的初始采样。
- 每个隐式圆柱体求值器正常计算其静态逆矩阵，并通过 `state.emitterInverseWorldMatrices?.push(...)` 可选地追加其稳定的 `{ inverse }` 状态。显式方向圆柱体不追加任何内容。静态构建中该字段不存在，且不分配集合数组。提供方初始化会在遍历前安装新列表，从而在不引入求值器导入或提供方特定分支的情况下收集同一系统中全部可达的隐式圆柱体。
- `scene` 与 `textureBaseUrl` 仅在图遍历期间保存在 `NpeBuildState` 中。
- 普通、流场贴图、噪声纹理与组合纹理更新遍历均执行相同的遍历前可选初始化调用。它们不分配包含发射器状态的对象，不导入提供方代码，不针对提供方行为分支，也不在遍历结束后保留 `NpeBuildState`。
- 每个标准构建器根都有自己的输出映射表与块 id 集合。每个标准 `ParticleTextureSourceBlock` 仍留在基础注册表中；其现有求值器优先使用非空字符串 `url`，否则接收字符串 `textureDataUrl`，而不导入可选求值器。流场贴图、噪声纹理与组合纹理更新构建器仅通过其显式公共函数动态导入特性运行时。它们的共享专用遍历还额外以解析后的块对象为键维护依赖覆盖，使同一纹理源既能被求值一次用于公告板上传，又能被求值一次用于 CPU 解码。
- `enableNodeParticleBlendModes(set)` 在任意已构建集合的每个系统上安装 `_registerBillboard` 回调并返回同一集合。该回调在注册发生时读取系统当前可变的 `blendMode`，应用精确的 Babylon.js 描述符，为模式 `3` 和 `4` 挂载私有 Multiply 着色器，并选择单通道或双通道。`buildNodeParticleSetWithBlendModes` 接收经过提供方包装的选项，因此两种按需启用机制无需修改求值器遍历即可组合。
- `buildNodeParticleSetWithBlendModes` 是 `enableNodeParticleBlendModes(await buildNodeParticleSet(...))` 的便捷形式。导入任一公共启用器即是引入精确粒子混合状态与高级渲染的按需边界；普通构建器对可选模块没有任何运行时导入边。
- `withNodeParticleEmitterProvider(provider, options)` 是同步的，会在构建前校验其初始提供方采样。它返回携带提供方所持初始化回调的选项。`buildNodeParticleSetWithEmitterProvider` 是默认构建器便捷形式 `buildNodeParticleSet(engine, scene, graph, withNodeParticleEmitterProvider(provider, options))`。代码片段、流场贴图、噪声纹理、组合纹理更新与精确混合模式组合均将包装后的选项传给其现有的构建器入口。不存在构建后启用器或替换路径。
- 整个集合的构建 Promise 会被收集并在所有根节点遍历完成后统一等待。

`CreateParticleBlock` 不创建系统。`SystemBlock` 不设置容量或局部性；构建器在 DFS 之前消费这些序列化字段。

### 7.2 可达性与遍历

仅会构建从根节点顺着输入连接可达的块。游离块不会加载任何求值器，也不会分配任何列。

标准的异步 `buildBlock(id)` 算法步骤严格如下：

1. 若 `id` 已在 `built` 中则直接返回，否则在递归前将其加入 `built`。
2. 若映射表中不存在该 `id` 对应的块则直接返回。
3. 按序列化输入顺序遍历所有名称精确为 `particle` 的已连接输入。
4. 按序列化输入顺序遍历其余所有已连接输入。
5. 选择并动态导入一个求值器。
6. 运行 `evaluator.build(block, ctx)`。

CPU 纹理更新构建器在其动态加载的特性模块中镜像了这一遍历逻辑。每个轻量特性运行时提供一个类、一个纹理输入名、其更新求值器以及 `cpuTextureSourceBlock`。流场贴图选择 `UpdateFlowMapBlock.flowMap`；噪声选择 `UpdateNoiseBlock.noiseTexture`。其他所有块遵循标准注册表。对于不调用按需纹理更新构建器的场景，普通构建器及所有共享注册表均保持不变。

在递归前标记访问可终止环路。若求值器请求尚未安装的输出，环路仍会失败。

仅当 `targetBlockId != null` 且 `targetConnectionName != null` 时，输入才算已连接。空的连接名字符串仍算已连接。有目标 id 但无连接名，或有连接名但无目标 id，均视作未连接。

输出映射键为 `${blockId}:${connectionName}`。读取器输出端口为：

- `output`：`ParticleInputBlock`、`ParticleRandomBlock`、`ParticleMathBlock`、`ParticleLerpBlock`、`ParticleGradientBlock`、`ParticleGradientValueBlock`、`ParticleConditionBlock`、`ParticleFloatToIntBlock` 以及 `ParticleVectorLengthBlock`。
- `color`、`xyz`、`xy`、`zw`、`x`、`y`、`z` 与 `w`：`ParticleConverterBlock`。
- `texture`：`cpuTextureSourceBlock`，仅通过 CPU 纹理更新构建器的依赖覆盖才可达。

`SystemBlock`、`CreateParticleBlock`、全部六种形状类、`SetupSpriteSheetBlock`、`BasicSpriteUpdateBlock` 以及全部七种更新类均不安装读取器输出。它们的 `particle` 连接仅控制可达性与顺序。更新块不发布流输出。

### 7.3 输入解析与字面量

`ctx.input(block, name, fallback)` 查找首个具有该名称的输入。

- 已连接的输入必须找到精确的输出映射键，否则调用抛出 `NodeParticle: unresolved connection <ClassName>.<inputName>`。
- 带有已解析字面量的未连接输入返回一个捕获该字面量的闭包。
- 若无已解析字面量，则返回提供的 `fallback`。
- 若也无 `fallback`，读取器返回强转为图值类型的 `null`。

字面量解析规则：

- 数值型或标记为 `number` 的值仅当运行时值确实为 `number` 时才被接受。
- `BABYLON.Vector2` 数组转为 `{ x: value[0] ?? 0, y: value[1] ?? 0 }`。
- `BABYLON.Vector3` 数组追加 `z: value[2] ?? 0`。
- `BABYLON.Color4` 数组转为 `{ r: value[0] ?? 0, g: value[1] ?? 0, b: value[2] ?? 0, a: value[3] ?? 1 }`。
- 其他字面量形式会被忽略。

### 7.4 懒注册表结构

求值器不进行预加载。当 DFS 到达每个块时才执行选择与动态导入。

- `npe-registry.ts` 处理 System、Create、Box、UpdatePosition、UpdateColor、TextureSource、Input、精简 Math、Lerp、Converter 与普通 Random。
- 未命中 Box 分支的形状名称路由到 `npe-registry-extra-emitters.ts`，后者处理 Point、Sphere、Cone、Cylinder 与 Mesh。
- `npe-registry-extra.ts` 处理 UpdateSize、Gradient、GradientValue、SetupSpriteSheet 与 BasicSpriteUpdate。其他所有未命中项转至 `npe-registry-extra-remaining.ts`。
- `npe-registry-extra-remaining.ts` 处理 UpdateAttractor，将 `Particle` 前缀名称转发给 `npe-registry-extra-values.ts`，并将非 `Particle` 名称发往 `npe-registry-extra-basic.ts` 以处理 UpdateDirection 与 UpdateAngle。
- `npe-registry-extra-values.ts` 处理 Condition、FloatToInt、VectorLength 与 LocalVariable。未知的 `Particle` 名称保留不支持的值诊断错误。UpdateFlowMap 与 UpdateNoise 由动态加载的特性构建器拥有，不存在于共享注册表中。
- 当 `state.isLocal` 为 true 时，`npe-registry-local-shapes.ts` 为全部六种形状类选择各自的局部实现。
- `npe-registry-variants.ts` 选择额外的上下文 Input、源 `0x18` Input、别名安全的 Math、带类型的 OncePerParticle Random、动态发射率 System 以及随机起始帧 SetupSpriteSheet 求值器。
- 标量 OncePerParticle Random 直接由构建器导入其求值器。

变体选择依据序列化数据与连接标识：

- 对于 Position、Age、Lifetime、Color、ScaledDirection 和 ScaledColorStep 之外的所有非零上下文源，Input 使用变体。
- 当按首次可用性选出的 `min` 或 `max` 值类型精确为 `number` 时，Random 锁定模式 `3` 使用标量求值器；所有其他类型标签使用带类型求值器。
- 当左右输入具有相同的目标 id 和相同的目标连接名（包括两个均缺失或等效未连接的目标）时，Math 使用别名安全求值器。
- 当 `emitRate` 已连接时，System 使用动态变体。
- 仅当 `randomStartCell === true` 时，SetupSpriteSheet 使用随机变体。

### 7.5 异步纹理工作

纹理求值器向构建 Promise 数组添加 Promise。构建器遍历完所有根节点后，统一等待 `Promise.all(buildPromises)`，随后返回集合。它不运行独立的纹理分辨率解析通道。仅上传 GPU 的普通纹理求值器调度该上传。CPU 纹理更新构建器单独为已连接的纹理源发布一个 CPU 可读值，并由更新求值器调度解码。两者均在返回专用集合前完成。

## 8. 值与源

### 8.1 读取器契约

```ts
type NpeValue = number | Vec2 | Vec3 | Color4;
type NpeGetter = (i: number) => NpeValue;
type ParticleStep = (i: number) => void;
```

标量读取器返回数字。向量与颜色读取器通常填充一个由该读取器捕获的值并在每次调用时返回同一个对象引用。消费方在调用另一个易变读取器之前须拷贝各个分量。

流场贴图与噪声特性通过其依赖覆盖在内部传递一个构建局部纹理值（跨标量/向量读取器契约强转，且仅由匹配的更新块消费）：

```ts
interface NpeTextureContent {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

interface NpeTextureValue {
    readonly url: string;
    readonly invertY: boolean;
    _content?: Promise<NpeTextureContent | null>;
}
```

除非有 CPU 纹理消费方请求它，否则 `_content` 不存在。首次请求会将解码 Promise 存储在值上，使同一系统构建内对该纹理源的多个消费方共享同一次拉取与解码。

### 8.2 上下文粒子源

| Id       | 名称                 | 返回值与行为                                                                                                     |
| -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `0x0001` | Position             | 来自基础位置列的暂存 `Vec3`                                                                                      |
| `0x0002` | Direction            | 来自基础方向列的暂存 `Vec3`                                                                                      |
| `0x0003` | Age                  | 来自 `age[i]` 的 `number`                                                                                        |
| `0x0004` | Lifetime             | 来自 `lifeTime[i]` 的 `number`                                                                                   |
| `0x0005` | Color                | 来自标准颜色列的暂存 `Color4`                                                                                    |
| `0x0006` | ScaledDirection      | 暂存 `Vec3 = direction * system._scaledStep`                                                                     |
| `0x0007` | Scale                | 来自标准缩放列的暂存 `Vec2`                                                                                      |
| `0x0008` | AgeGradient          | `age[i] / lifeTime[i]`，无零保护                                                                                 |
| `0x0009` | Angle                | 来自标准旋转角列的 `number`                                                                                      |
| `0x0013` | InitialColor         | 暂存 `Color4`；请求四列初始颜色并包装 `createColorDead`，在调用捕获步骤前拷贝当前颜色                            |
| `0x0014` | ColorDead            | 暂存 `Color4`；请求四列死亡颜色并安装 `_writeColorDead`                                                          |
| `0x0015` | InitialDirection     | 暂存 `Vec3`；通常请求三列并包装 `createEmitPower`，在调用捕获步骤前拷贝方向                                      |
| `0x0016` | ColorStep            | 来自标准颜色步长列的暂存 `Color4`                                                                                |
| `0x0017` | ScaledColorStep      | 暂存 `Color4 = colorStep * system._scaledUpdateSpeed`                                                            |
| `0x0018` | LocalPositionUpdated | 暂存世界 `Vec3` 并写入基础位置，详见下文                                                                         |
| `0x0019` | Size                 | 来自标准尺寸列的 `number`                                                                                        |
| `0x0020` | DirectionScale       | 等于 `system._scaledStep` 的 `number`                                                                            |

`InitialColor` 在构建其读取器时捕获当前的 `createColorDead` 函数。它安装的函数将标准 RGBA 拷贝到 `initialColor.*`，随后在被捕获函数非空时调用之。`ColorDead` 安装一个写入器将传入的 RGBA 拷贝到 `colorDead.*`；`CreateParticleBlock.createColorDead` 在推导标准颜色步长之前调用它。

当构建 `InitialDirection` 时 `_suppressInitialDirectionCapture` 为 true，该源返回一个共享的零 `Vec3` 且不请求初始方向列。否则它捕获当前的 `createEmitPower`，安装一个包装器（当抑制仍为 false 时将基础方向拷贝到 `initialDir.*`），然后在被捕获函数非空时调用之。其读取器将这三列读入暂存区。

受支持的上下文 id 严格限定为上表所列。源 `0x0018` 拥有自己的求值器。Direction 及其他可选源使用额外上下文工厂，其默认分支在构建期间抛出 `NodeParticle: unsupported contextual source 0x<lowercase hex>`。若某个非零数字 id 被路由至通用工厂但未在其中处理，则会安装 null 输出；消费它的连接随后将在同一图构建期间抛出未解析连接错误。不支持的源不会延迟到逐粒子更新时才报错。

### 8.3 LocalPositionUpdated

源 `0x0018` 首先检查 `state.isLocal`。若为 false，则在请求任何局部位置列之前抛出 `NodeParticle: LocalPositionUpdated requires SystemBlock.isLocal`。

校验通过时，该源分配五个局部列并安装 `_seedLocalPosition`。每个局部形状在 `createPosition` 末尾、基础位置仍保存着发射器局部坐标时调用 `finishLocalPosition`。该辅助函数执行：

1. 当已安装 `_seedLocalPosition` 时调用 `_seedLocalPosition(i)`，拷贝局部 xyz 以及当前粒子 id 与有效标志。
2. 通过 `emitterWorldMatrix` 变换基础位置。
3. 将变换后的结果写回基础位置。

每次读取该源都会检查 `valid !== 0` 且缓存 id 等于 `buffer.id[i]`。失败则抛出 `NodeParticle: LocalPositionUpdated read before local shape position creation`。

对于有效读取，当 `age[i] === 0` 时 `step = 0`；否则 `step = system._scaledStep`。它按 `direction * step` 推进每个局部坐标分量，通过发射器矩阵变换局部 xyz，将世界结果写入基础位置，并返回同一暂存世界向量。年龄为零的规则允许在局部形状为槽位播种之后、尚未移动之前在创建阶段执行读取。

### 8.4 系统源与时机

| Id  | 名称    | 返回值                                                                                           |
| --- | ------- | ------------------------------------------------------------------------------------------------ |
| `1` | Time    | `system._actualFrame`                                                                            |
| `2` | Delta   | `system._scaledUpdateSpeed`                                                                      |
| `3` | Emitter | 稳定的构建状态发射器 `Vec3`，在由提供方支持的构建中于每次已启动的模拟调用前刷新                  |

其他 id 在构建期间抛出 `NodeParticle: unsupported system source <decimal id>`。

在单次模拟调用中，Time 具有三个可观测阶段。动态发射率读取器看到的是递增前的值。当系统在调用入口处于发射状态时，更新步骤与创建读取器看到的是递增后的值。调用时若系统已停止，则不会递增该值。

Emitter 在引用上是稳定的。静态构建保留其构建时值。由提供方驱动的帧会在发射率求值、已有粒子更新与诞生之前原地修改其分量，因此同一次模拟调用中的每一次上下文读取都能观测到该系统的已提交快照。

Delta 在发射率求值之前赋值，并在整次调用期间保持完整的 `updateSpeed * scaledRatio`。DirectionScale 在每个存活粒子的 `updateSteps` 之前立即赋值；在粒子死亡边界上它可能被缩短。在已有粒子更新之外，它保留初始值或上一个刚处理完的粒子的值。

### 8.5 ParticleInputBlock 常量

当上下文源与系统源 id 均为零时，块读取 `serialized.type`，默认为 Float `0x0002`：

| 类型 id          | 结果                                               |
| ---------------- | -------------------------------------------------- |
| `0x0001` Int     | 数值型序列化值或 `0`                               |
| `0x0002` Float   | 数值型序列化值或 `0`                               |
| `0x0004` Vector2 | 数组分量，缺失条目为 `0`                           |
| `0x0008` Vector3 | 数组分量，缺失条目为 `0`                           |
| `0x0080` Color4  | 数组 RGB 缺失条目为 `0`，alpha 缺失条目为 `1`      |
| 其他任何 id      | 数值型序列化值或 `0`                               |

上下文源优先于系统源，系统源优先于常量。块安装 `output`。

## 9. 支持的块

图规范化之后，构建器精确支持 34 个块类名。其中 29 个普通类可直接用于未规范化的已解析图；`ParticleTeleportInBlock`、`ParticleTeleportOutBlock`、`ParticleLocalVariableBlock`、`ParticleElbowBlock` 和 `ParticleDebugBlock` 仅在规范化边界之后受支持。解析器本身可以表示任意序列化类名。

```text
SystemBlock                         CreateParticleBlock
BoxShapeBlock                       PointShapeBlock
SphereShapeBlock                    ConeShapeBlock
CylinderShapeBlock                  MeshShapeBlock
ParticleInputBlock                  ParticleRandomBlock
ParticleMathBlock                   ParticleLerpBlock
ParticleConverterBlock              ParticleGradientBlock
ParticleGradientValueBlock          ParticleConditionBlock
ParticleFloatToIntBlock             ParticleVectorLengthBlock
ParticleTextureSourceBlock          SetupSpriteSheetBlock
BasicSpriteUpdateBlock              UpdatePositionBlock
UpdateColorBlock                    UpdateDirectionBlock
UpdateAngleBlock                    UpdateSizeBlock
UpdateAttractorBlock                UpdateFlowMapBlock
UpdateNoiseBlock                    ParticleTeleportInBlock
ParticleTeleportOutBlock            ParticleLocalVariableBlock
ParticleElbowBlock                   ParticleDebugBlock
```

局部形状模块与序列化变体保留此列表中的类名。

### 9.1 SystemBlock

构建器在此求值器运行之前已创建了系统。该求值器：

- 仅当 `serialized.updateSpeed` 为数字时将其赋值给系统。
- 仅当 `serialized.blendMode` 为数字时将其赋值给系统。
- 对于未连接的 `emitRate`，在构建时以回退值 `10` 求值一次并赋值数值结果。
- 对于已连接的 `emitRate`，动态求值器安装 `_emitRateGetter`。每次调用在粒子索引 `0` 处求值该图并返回数字结果，若结果非数字则回退为系统常量 `emitRate`。构建期间不对其求值。
- 在构建时以回退值 `0` 对 `targetStopDuration` 求值一次并赋值数值结果。

`capacity` 与 `isLocal` 为构建器字段。`billBoardMode` 与 `isBillboardBased` 被忽略。求值器不安装输出读取器。

### 9.2 CreateParticleBlock

该块捕获十二个标准缓冲区字段并安装六个创建槽位。形状块安装位置与方向。

输入默认值如下：

| 输入        | 默认值                       |
| ----------- | ---------------------------- |
| `lifeTime`  | `1`                          |
| `emitPower` | `1`                          |
| `color`     | `{ r: 1, g: 1, b: 1, a: 1 }` |
| `colorDead` | `{ r: 0, g: 0, b: 0, a: 0 }` |
| `scale`     | `{ x: 1, y: 1 }`             |
| `angle`     | `0`                          |
| `size`      | `1`                          |

各槽位行为：

- `createLifeTime`：写入 `lifeTime[i]` 并将 `emitPower` 求值存入 `_emitPower`。
- `createEmitPower`：当 `_emitPower === 0` 时，将所有方向分量写入零。否则将每个方向分量乘以 `_emitPower`。若已安装 `InitialDirection` 包装器，它会在该步骤运行前捕获方向。
- `createSize`：写入数字尺寸，非数字时使用 `1`。对象类型的缩放写入 `.x` 和 `.y`；标量缩放同时拷贝到两个分量。
- `createAngle`：通过类型化数组强制转换写入数字旋转角。
- `createColor`：当求值结果为真值时写入 RGBA。
- `createColorDead`：若已安装 `_writeColorDead`，则将求值得到的死亡颜色传给它，随后向每个颜色步长分量写入 `(dead - current) / lifeTime`。不存在零生命周期保护。

该块不创建运行时系统，也不安装输出读取器。

### 9.3 形状变换契约

矩阵采用列主序。位置变换使用：

```text
rx = x*m[0] + y*m[4] + z*m[8]  + m[12]
ry = x*m[1] + y*m[5] + z*m[9]  + m[13]
rz = x*m[2] + y*m[6] + z*m[10] + m[14]
rw = 1 / (x*m[3] + y*m[7] + z*m[11] + m[15])
position = (rx*rw, ry*rw, rz*rw)
```

方向变换使用左上角 3x3 矩阵，不做平移、透视除法或归一化：

```text
direction = (
    x*m[0] + y*m[4] + z*m[8],
    x*m[1] + y*m[5] + z*m[9],
    x*m[2] + y*m[6] + z*m[10]
)
```

世界形状模块变换诞生位置与方向。局部形状模块存储发射器局部方向，并使用 `finishLocalPosition` 处理诞生位置。Sphere 与 Cone 的隐式局部方向由变换后的诞生点与发射器平移计算得出，因此属于世界朝向值。Box、Point、显式 Sphere/Cone/Cylinder 以及 Mesh 的方向保持为发射器局部方向。Cylinder 的隐式局部算法在写入方向之前会通过逆矩阵转换其径向向量。

所有形状闭包仅持有稳定的构建状态矩阵、发射器及形状局部值。在由提供方支持的构建中，世界形状诞生使用当前稳定矩阵，所有局部形状的 `finishLocalPosition` 使用该矩阵，`LocalPositionUpdated` 用它变换已有局部位置，而隐式 Sphere/Cone/Cylinder 方向计算则读取当前稳定的发射器平移。帧刷新会原地修改这些稳定引用，因此求值器闭包绝不需要重建。

对于 Sphere、Cone 与 Cylinder，仅当 `direction1` 与 `direction2` 同时满足双字段已连接条件时，才选择显式方向模式。只连接一个方向端口不会进入显式模式。

### 9.4 BoxShapeBlock

默认值为 `direction1 = direction2 = (0,1,0)`、`minEmitBox = (-0.5,-0.5,-0.5)` 与 `maxEmitBox = (0.5,0.5,0.5)`。

位置会在求值最大值之前先求值并拷贝所有最小值分量，随后用 `randomRange` 抽取各分量，并在世界模块中对结果执行矩阵变换。方向对 `direction1` 与 `direction2` 执行相同的拷贝边界分量抽取，并仅在世界模块中执行变换。局部模块在写入局部位置后调用 `finishLocalPosition`。两个模块均安装 `createPosition` 与 `createDirection`，不安装输出读取器。

### 9.5 PointShapeBlock

默认值为 `direction1 = direction2 = (0,1,0)`。位置在局部空间为 `(0,0,0)`；世界模块对其进行变换，局部模块将其传给 `finishLocalPosition`。方向拷贝 `direction1` 分量，求值 `direction2`，用 `randomRange` 抽取各分量，并仅在世界模块中变换。两个模块均安装 `createPosition` 与 `createDirection`，不安装输出读取器。

### 9.6 SphereShapeBlock

默认值为 `radius = 1`、`radiusRange = 1`、`directionRandomizer = 0`，两个方向边界均为 `(0,1,0)`。仅当序列化值为 `true` 时 `isHemispheric` 为 true。

位置按如下方式抽取：

```text
sampleRadius = radius - randomRange(0, radius * radiusRange)
v = randomRange(0, 1)
phi = randomRange(0, 2*pi)
theta = acos(2*v - 1)
x = sampleRadius*cos(phi)*sin(theta)
y = sampleRadius*cos(theta)
z = sampleRadius*sin(phi)*sin(theta)
```

半球模式应用 `y = abs(y)`。世界模块变换该点并保留未经量化的变换后分量用于方向计算。局部模块写入局部分量，调用 `finishLocalPosition`，并保留其变换后的暂存分量用于方向计算。

显式方向在两个边界之间抽取各分量。世界模式变换该方向；局部模式直接写入。

隐式方向以变换后的诞生位置减去发射器平移为起点，仅当长度既不为零也不为一时执行归一化，随后向 x、y、z 各自独立加上 `randomRange(0, directionRandomizer)` 并再次应用相同的条件归一化。之后世界模式通过发射器矩阵变换该法线；局部模式则直接写入计算出的分量。

两个模块均安装 `createPosition` 与 `createDirection`，不安装输出读取器。

### 9.7 ConeShapeBlock

默认值为 `radius = 1`、`angle = pi`、`radiusRange = 1`、`heightRange = 1`、`directionRandomizer = 0`，两个方向边界均为 `(0,1,0)`。仅当序列化值为 `true` 时 `emitFromSpawnPointOnly` 为 true。

位置按如下公式计算：

```text
heightFactor = emitFromSpawnPointOnly
    ? 0.0001
    : 1 - randomRange(0, heightRange)^2
sampleRadius = (radius - randomRange(0, radius * radiusRange)) * heightFactor
azimuth = randomRange(0, 2*pi)
x = sampleRadius * sin(azimuth)
z = sampleRadius * cos(azimuth)
y = heightFactor * (angle !== 0 ? radius / tan(angle / 2) : 1)
```

世界与局部位置处理与 Sphere 一致。显式与隐式方向处理同样与 Sphere 一致，包括其归一化与正分量抖动规则。两个模块均安装 `createPosition` 与 `createDirection`，不安装输出读取器。

### 9.8 CylinderShapeBlock

默认值为 `radius = 1`、`height = 1`、`radiusRange = 1`、`directionRandomizer = 0`，两个方向边界均为 `(0,1,0)`。

位置按如下公式计算：

```text
y = randomRange(-height/2, height/2)
angle = randomRange(0, 2*pi)
sampleRadius = sqrt(randomRange((1-radiusRange)^2, 1)) * radius
x = sampleRadius * cos(angle)
z = sampleRadius * sin(angle)
```

显式方向使用分量范围抽取且无需矩阵求逆。世界模块对其进行变换；局部模块直接写入。

对于隐式方向，每个求值器在构建期间计算 `invertMat4(emitterWorldMatrix)`，并在行列式绝对值小于 `1e-10` 时用新的单位矩阵替代。它将稳定的 `{ inverse }` 状态追加到 `emitterInverseWorldMatrices`。按需启用的提供方会在每次已启动模拟调用前原地刷新列出的每个逆矩阵，对于奇异矩阵同样回退为单位矩阵。每次诞生时执行：

1. 计算变换后诞生位置减去发射器平移，并执行条件归一化。
2. 用逆矩阵对向量执行 `transformNormal` 并写入暂存区。
3. 抽取 `y = randomRange(-randomizer/2, randomizer/2)`。
4. 计算 `azimuth = atan2(scratch.x, scratch.z) + randomRange(-pi/2, pi/2) * randomizer`。
5. 设 `x = sin(azimuth)` 与 `z = cos(azimuth)`，并对 xyz 执行条件归一化。
6. 在世界模式下，用发射器矩阵执行 `transformNormal`。在局部模式下，直接写入 xyz。

当随机化因子为零时，y 的抽取因上下界相等而短路，而方位角（azimuth）的抽取在乘以零之前仍会消耗一次随机数。两个模块均安装 `createPosition` 与 `createDirection`，不安装输出读取器。

### 9.9 MeshShapeBlock

该块读取 `serialized.cachedVertexData.positions`、`.indices`、可选 `.normals` 与可选 `.colors`。若缺少位置或索引，求值器直接返回且不安装位置或方向步骤。不会校验数组是否非空、三角形计数是否合法、索引是否越界或属性长度是否匹配。

每次位置创建消耗三次原始 `Math.random()` 调用：

```text
faceOffset = 3 * ((random() * (indices.length / 3)) | 0)
u = random()
v = random() * (1 - u)
w = 1 - u - v
```

所选三角形上的位置为 `u*A + v*B + w*C`。世界模式变换该点。局部模式写入该点并调用 `finishLocalPosition`。

当 `useMeshNormalsForDirection !== false` 且存在真值法线数组时，由网格法线控制方向。块以相同权重对 xyz 插值而不做归一化。世界模式变换该法线；局部模式直接写入。它同时设置 `_suppressInitialDirectionCapture`，使 `InitialDirection` 读为零。不使用网格法线方向时，`direction1` 与 `direction2` 默认为 `(0,1,0)`，始终按分量范围求值，且仅在世界模式下变换。

当 `useMeshColorForColor === true` 且存在真值颜色数组时，由网格颜色控制诞生颜色。块请求标准 RGBA 列，将 `createColor` 设为 `null`，并在 `createPosition` 期间写入加权的四分量顶点颜色。随后死亡颜色创建步骤据此颜色推导颜色步长。

序列化的网格 `worldSpace` 字段不会被读取。仅 `emitterWorldMatrix` 用于变换世界模式几何体。两个模块均安装 `createPosition` 与 `createDirection`，不安装输出读取器。

### 9.10 ParticleInputBlock

当 `serialized.contextualValue` 为非零数字时，块选择上下文源。否则当 `serialized.systemSource` 为非零数字时选择系统源。否则创建第 8.5 节指定的常量。不支持的源 id 按第 8 节所述在构建期间失败。块安装 `output`。

### 9.11 ParticleRandomBlock

默认值为 `min = 0`、`max = 1` 与 `lockMode = 1`。抽取函数依据求值得到的最小值选择形状，拷贝所有最小值分量，求值最大值，并按分量计算 `min + Math.random() * (max - min)`。它不使用 `randomRange`，也不会跳过相等上下界。若最大值形状不匹配，缺失分量补零。

锁定模式如下：

| 模式                | 行为                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0` None            | 每次调用读取器都重新抽取                                                                                                                                       |
| `1` PerParticle     | 持有一个 `stored` 值与一个 `currentLockId`；当 `buffer.id[i]` 与紧邻前一次缓存值所用的 id 不同时重新抽取。同一 id 的连续读取共享值，但 A-B-A 访问顺序会对 A 抽取两次 |
| `2` PerSystem       | 使用锁定 id `0`；首次调用读取器抽取，之后所有调用共享该值                                                                                                      |
| `3` OncePerParticle | 在粒子槽位上使用按块的类型化数组 id、valid 与 Float64 分量缓存；每个粒子 id 仅抽取一次，包括 id 0 与槽位复用场景                                               |

模式 3 的标量结果使用 `value0`。带类型模式根据序列化值类型使用两个、三个或四个值列，并返回一个复用的 Vector2、Vector3 或 Color4 暂存值。0 到 3 之外的数字模式会进入普通求值器，但永远无法满足其抽取条件，因此总是返回初始化的存储标量 `0`。块安装 `output`。

### 9.12 ParticleMathBlock

运算包括 `0 Add`、`1 Subtract`、`2 Multiply`、`3 Divide`、`4 Max` 与 `5 Min`；默认为 Add。不支持的运算返回左操作数分量。直接使用 JavaScript 除法与 `Math.max`/`Math.min`，不做有限性或零值检查。

两个标量产生标量。一个标量与 Vector2、Vector3 或 Color4 运算时，将标量扩展（splat）到另一个形状的各分量。两个非标量使用左操作数形状并逐分量运算。

当左右输入未引用同一源对时选择精简求值器。它依次求值左右输入，选择非标量形状或左操作数形状，并直接读取该形状的分量属性。假定图类型兼容；不兼容的形状可能传入 `undefined` 并产生 `NaN`。

当两个输入具有相同目标 id 与相同目标连接名时选择别名安全求值器。它先求值左输入并在求值右输入之前拷贝所有非标量分量。对于非标量左输入，标量右输入会扩展，匹配形状的右输入提供对应分量，不兼容的右输入补零。结果使用每个形状各自的一个复用暂存值。两种变体均安装 `output`。

### 9.13 ParticleLerpBlock

`gradient` 默认为 `0`。结果为未经钳位的 `left + (right - left) * gradient`。读取器在求值右输入前先拷贝左输入的全部分量。形状由左输入决定；不兼容的右输入补零。支持标量、Vector2、Vector3 与 Color4，将非标量写入复用暂存区，并安装 `output`。

### 9.14 ParticleConverterBlock

仅已连接的输入参与计算。若 `color` 已连接，它提供全部分量并拥有最高优先级。否则各值从零开始按以下顺序覆盖：

1. 已连接的标量 `x`、`y`、`z` 与 `w`。
2. 已连接的 `xy` 覆写 x 与 y。
3. 已连接的 `zw` 使用其 x 与 y 分量覆写 z 与 w。
4. 已连接的 `xyz` 覆写 x、y 与 z。

共享的四分量数据将 `r/g/b/a` 映射到 `x/y/z/w`。块安装 `color`、`xyz`、`xy`、`zw`、`x`、`y`、`z` 与 `w`；每次调用读取器都会重新填充数据，向量输出使用各自专用的暂存值。

### 9.15 ParticleGradientValueBlock

`reference` 为数值型序列化值或 `0`。`value` 是回退值为 `0` 的懒读取器。块安装 `output`，其内部值为供 Gradient 块消费的 `{ reference, value }` 元数据。

### 9.16 ParticleGradientBlock

`gradient` 默认为 `1`。名称以 `value` 开头且目标 id 非空的输入在构建索引 `0` 处被解析为梯度条目，随后按数字 reference 升序排序。有效条目来自 `ParticleGradientValueBlock.output`；畸形条目使用常规 JavaScript 属性访问与排序行为。

求值时：

- 无条目返回标量 `0`。
- 单个条目对所有 gradient 均返回其懒求值结果。
- 多条目梯度中，若 gradient 低于所有 reference，返回标量 `0`。
- 若位于或高于最大适用 reference 且无更高条目，返回该条目值。
- 在两条目之间，计算 `(gradient - lower.reference) / (upper.reference - lower.reference)`，将比例钳位到 `[0,1]`，并使用与 Lerp 相同的别名安全插值。

标量值直接返回标量；向量与颜色值拷贝入复用暂存区。块安装 `output`。

### 9.17 ParticleConditionBlock

默认值为 `test = 0`、`epsilon = 0`、`left = 0`、`right = 0`、`ifTrue = 1` 与 `ifFalse = 0`。它求值标量 `left` 与 `right`，并仅懒求值被选中的结果读取器。

| 测试类型       | Id  | 谓词                               |
| -------------- | --- | ---------------------------------- |
| Equal          | `0` | `abs(left-right) <= epsilon`       |
| NotEqual       | `1` | `abs(left-right) > epsilon`        |
| LessThan       | `2` | `left < right + epsilon`           |
| GreaterThan    | `3` | `left > right - epsilon`           |
| LessOrEqual    | `4` | `left <= right + epsilon`          |
| GreaterOrEqual | `5` | `left >= right - epsilon`          |
| Xor            | `6` | 一个操作数为真值且另一个为假值     |
| Or             | `7` | 任一操作数为真值                   |
| And            | `8` | 两个操作数均为真值                 |

未知测试 id 选中 false 分支。块安装 `output`。

### 9.18 ParticleFloatToIntBlock

输入默认为 `0`。操作 id 为 `0 Math.round`、`1 Math.ceil`、`2 Math.floor` 与 `3 Math.trunc`。缺失或未知操作 id 使用 `Math.round`。块安装 `output`。

### 9.19 ParticleVectorLengthBlock

块安装标量 `output`：对标量返回 `abs(value)`，对两分量或三分量向量返回欧几里得长度，对四分量 Color4 返回四维欧几里得长度。其输入没有显式回退值，因此缺失输入会返回构建器的 null 值并在读取器检查时失败。

### 9.20 ParticleTextureSourceBlock

普通求值器保留仅上传 GPU 的行为。它优先使用非空字符串 `serialized.url`，否则使用字符串 `serialized.textureDataUrl`，否则使用空字符串。Babylon 序列化会在设置 `textureDataUrl` 时清空 `url`，因此序列化后的缓存载荷会选择 data URL。若手工编写的输入同时提供两个非空字符串，Lite 刻意优先选择 `url`；Babylon 序列化器从不生成这种形式。单独的 `serializedCachedData` 标志因为不携带像素而没有任何效果。

普通求值器与专用内嵌求值器都将 HTTP(S)、协议相对 URL 以及根相对 URL 视为绝对路径，并将其他非空源基于提供的 `textureBaseUrl` 进行解析。它们使用 `{ invertY: serialized.invertY === false }` 调度 `loadTexture2D`，将结果保存在 `system.texture` 上并捕获加载失败。省略 `invertY` 时应用 Lite 块类的默认值 `true`，从而向加载器传递 `invertY: false`。这与 Babylon `_deserialize` 在缺失字段时的回退逻辑不同，但 Babylon 序列化器总是会输出该字段。

这两个语义匹配的求值器刻意保持导入独立，使专用遍历不会输出或拉取基础 `texture-source-block` 求值器。仅使用 URL 的标准图保留基础纹理 chunk 集合，绝不拉取 `embedded-texture-source-block`；只有支持噪声的专用路径才可能拉取该求值器。

`buildNodeParticleSetWithFlowMaps` 动态导入一个专用的仅流场遍历器。它为系统纹理保留普通求值器，并仅为流场贴图输入选择 `cpuTextureSourceBlock`。保持该遍历器专用化可防止仅使用流场的图保留多特性分发或内嵌渲染纹理处理代码。

`buildNodeParticleSetWithNoiseTextures` 动态导入启用了噪声的纹理更新遍历器。`buildNodeParticleSetWithTextureUpdates` 则使用同时启用流场与噪声的同一遍历器，以服务由同时使用这两种更新的经典系统生成的图。在这些支持噪声的构建器中，普通纹理源求值使用 `embeddedParticleTextureSourceBlock`（优先 `url`，回退至 `textureDataUrl`）；CPU 纹理输入使用 `cpuTextureSourceBlock`。CPU 求值器让 `textureDataUrl` 优先于 `url`，仅接受显式的 `http`、`https`、`data` 与 `blob` 协议，将相对 URL 基于 `textureBaseUrl` 解析，并将 `texture` 安装为 `NpeTextureValue`。它不执行任何 GPU 上传。

普通角色与依赖角色在专用构建器中使用不同的已构建键。因此单个序列化源可以同时馈送系统纹理与 CPU 更新输入：普通求值执行一次 GPU 上传，依赖求值发布一次 CPU 值，双方互不覆盖。

### 9.21 SetupSpriteSheetBlock

配置默认值如下：

| 序列化字段              | 默认值                          |
| ----------------------- | ------------------------------- |
| `start`                 | `0`                             |
| `end`                   | `0`                             |
| `loop`                  | `true`                          |
| `spriteCellChangeSpeed` | `1`                             |
| `width`, `height`       | `0`                             |
| `randomStartCell`       | 仅精确为 `true` 时才开启随机    |

普通变体分配 `sprite.cellIndex`。诞生时写入 `startCellID`。更新时计算：

```text
distance = endCellID - startCellID + 1
progress = age * changeSpeed
ratio = loop
    ? clamp01((progress % lifeTime) / lifeTime)
    : clamp01(progress / lifeTime)
cellIndex = (startCellID + ratio * distance) | 0
```

`clamp01(value)` 在小于零时返回 0，大于一时返回 1，其余情况原样返回。向 Uint16 赋值时会应用 Uint16 强制转换。

随机起始帧变体额外分配 `sprite.randomOffset`。诞生时写入偏移 `-1` 与起始单元格。更新时若偏移为负，则写入 `Math.random() * lifeTime`。当 `changeSpeed` 为零时，`progress` 即为偏移；否则 `progress` 为 `(age + offset) * changeSpeed`。比例与单元格计算随后与普通变体一致。

两种变体均设置包含单元格尺寸、单元格数组与更新函数的 `_spriteSheet`。它们捕获当前的 `createColorDead` 并安装一个包装器，使精灵诞生步骤在被捕获函数非空时于其后运行；若原函数为 null，则精灵诞生步骤直接成为该槽位。它们不安装输出读取器。

### 9.22 BasicSpriteUpdateBlock

该块在构建期间要求已存在 `_spriteSheet`，否则抛出 `NodeParticle: BasicSpriteUpdateBlock requires SetupSpriteSheetBlock`。它向 `updateSteps` 追加一个调用已捕获精灵表更新函数的步骤。不安装输出读取器。

### 9.23 UpdateAttractorBlock

输入为 `particle`、`attractor` 与 `strength`。`attractor` 默认为 `(0,0,0)`，`strength` 默认为 `1`。该块不分配任何列，并追加一个仅修改方向的更新步骤。

对于吸引子位置 $a$、粒子位置 $p$、方向 $d$、强度 $s$ 以及粒子按生命周期钳位后的 `system._scaledStep` $\Delta t$：

```text
offset = attractor - position
lengthSquared = dot(offset, offset)

if lengthSquared != 0:
    scale = strength * scaledStep / ((lengthSquared + 1) * sqrt(lengthSquared))
    direction += offset * scale
```

这等价于加上 `normalize(offset) * strength / (lengthSquared + 1) * scaledStep`。位置与吸引子重合时不产生力。负强度产生斥力。在求值 `strength` 之前会先拷贝吸引子分量，因为两个输入最终都可能依赖共享暂存区的读取器。

该块观察此前 `updateSteps` 留下的位置与方向，后续步骤则会观察到其对方向的修改。它本身不更新位置。序列化的局部系统使用同一求值器；不存在局部/世界吸引子变体。

### 9.24 UpdateFlowMapBlock

输入为 `particle`、`flowMap` 与 `strength`；`strength` 默认为 `1`。该块不分配粒子列，并追加一个仅修改方向的更新步骤。`flowMap` 接收 `ParticleTextureSourceBlock` 的 `texture` 输出。若值缺失或非纹理，则保留已安装的更新步骤但无已加载贴图，从而不产生任何效果。

构建期间，首次对纹理值的 CPU 请求会调用 `loadNpeTextureContent`。它请求解析后的 URL 并拒绝非 OK 响应，使用 `premultiplyAlpha: "none"` 与 `colorSpaceConversion: "none"` 解码为 `ImageBitmap`，然后将其绘制到 `OffscreenCanvas`（若可用）或 HTML canvas 中。当 `invertY === true` 时，画布变换会在 `getImageData` 之前垂直翻转位图；false 则保留源行顺序。得到的 `{ width, height, data: Uint8ClampedArray }` Promise 会缓存在纹理值上。求值器会捕获解码失败并保留 null 贴图，使每次更新成为空操作。

构建期间，该块以有效视口宽高比推导相机视图投影矩阵，将全部 16 个分量拷贝到通过 `allocateMat4()` 分配的求值器自有矩阵中，并将该准备回调追加到 `scene._beforeRender`。因此其存储遵循进程全局 F32/F64 矩阵策略，且绝不与相机自有矩阵存储产生别名。缺少相机时会把已准备矩阵标记为不可用。画布宽度与高度在计算宽高比前会各自独立规范化为有限正数。

在每次粒子更新时，若缺少已准备矩阵或贴图则立即返回，不求值 `strength`。否则求值器通过已准备矩阵（含透视除法）变换当前粒子位置，并对 RGBA 数据执行最近邻采样：

```text
screen = transformCoordinates(position, viewProjection)
u = screen.x * 0.5 + 0.5
v = 1 - (screen.y * 0.5 + 0.5)
x = floor(u * width)
y = floor(v * height)

if x or y is outside the texture:
    return

index = (y * width + x) * 4
alphaStrength = strength * scaledStep * data[index + 3] / 255
direction.x += (data[index]     / 255 * 2 - 1) * alphaStrength
direction.y += (data[index + 1] / 255 * 2 - 1) * alphaStrength
direction.z += (data[index + 2] / 255 * 2 - 1) * alphaStrength
```

`strength` 在通过贴图与已准备矩阵检查之后、边界检查之前为每个粒子求值。`scaledStep` 是粒子按生命周期钳位后的 `system._scaledStep`。RGB 字节值 `127.5` 为中性值；因此除通过 alpha 或 strength 外，整数字节没有精确零值。alpha 为零时不产生力。位于 `screen.x === 1` 或 `screen.y === -1` 的坐标映射到开区间上边界并被拒绝。

该块使用一个复用的屏幕位置暂存区，不在每粒子时分配内存。它观察之前更新步骤留下的位置与方向；后续步骤观察其方向修改。它不积分位置。局部系统使用同一求值器与当前存储位置；不存在单独的局部流场贴图变体。相机控制在流场构建之前追加其更新回调；流场准备回调紧随其后追加；实时粒子注册最后追加模拟回调，因此即使在场景注册之后才构建粒子集合，也能产生 控制 → 矩阵准备 → 模拟 的执行顺序。

### 9.25 UpdateNoiseBlock

输入为 `particle`、`noiseTexture` 与 `strength`。`strength` 默认为 `{ x: 100, y: 100, z: 100 }`。该块分配八个可选列：两组三分量 Float64 坐标集、一个 Uint32 粒子 id 以及一个 Uint8 有效性标志。id 与有效性列会在每个新粒子 id（包括被回收槽位）的首次更新时重新生成全部六个随机坐标；后续更新复用这些坐标。

构建期会等待与流场贴图相同的静态 CPU 纹理解码。缺失或加载失败的纹理会使更新步骤处于非激活状态且不消耗任何随机值。实时的程序纹理逐帧刷新不属于此处实现的序列化契约。

对于每一对分量，采样逻辑精确匹配 Babylon 的 `_fetchR`：

```text
u = abs(u) * 0.5 + 0.5
v = abs(v) * 0.5 + 0.5
x = trunc((u * width) % width)
y = trunc((v * height) % height)
red = data[(x + y * width) * 4] / 255

sampleX = red(coord1.x, coord1.y)
sampleY = red(coord1.z, coord2.x)
sampleZ = red(coord2.y, coord2.z)
direction += (2 * sample - 1) * strength * scaledStep
```

仅读取红色通道；alpha 与粒子位置不影响噪声。`strength` 在构建期间解析一次并保留返回的 Vector3 引用，与 Babylon 的连接点求值时机一致。`_scaledStep` 为按生命周期钳位后的更新增量。该块观察之前更新留下的方向并按图顺序影响后续更新。

### 9.26 UpdatePositionBlock

当 `position` 已连接时，追加一个更新步骤，求值 Vec3 并写入基础位置 xyz。输入未连接时不追加任何步骤。不安装输出读取器。

### 9.27 UpdateColorBlock

当 `color` 已连接时，请求标准 RGBA 列并追加一个更新步骤，求值 Color4 并写入全部分量。输入未连接时不追加任何步骤。不安装输出读取器。

### 9.28 UpdateDirectionBlock

当 `direction` 已连接时，追加一个更新步骤，求值 Vec3 并写入基础方向 xyz。输入未连接时不追加任何步骤。不安装输出读取器。

### 9.29 UpdateAngleBlock

当 `angle` 已连接时，请求标准旋转角列并追加一个更新步骤，写入标量结果。输入未连接时不追加任何步骤。不安装输出读取器。

### 9.30 UpdateSizeBlock

当 `size` 已连接时，请求标准尺寸列并追加一个更新步骤，写入标量结果。输入未连接时不追加任何步骤。不安装输出读取器。

### 9.31 Phase 3 图布线架构（Phase 3C 已实现）

本节最初作为五个序列化类名的 Phase 3A 契约：`ParticleTeleportInBlock`、`ParticleTeleportOutBlock`、`ParticleLocalVariableBlock`、`ParticleElbowBlock` 和 `ParticleDebugBlock`。解析器以不透明方式存储类名。Phase 3B 添加了 Teleport 路由；Phase 3C 添加了 LocalVariable 存储以及 Elbow 和 Debug 的编译期消除路由。经过必需的规范化边界后，当前支持的块数量为 34。

#### 9.31.1 执行摘要

| 关注点           | 混合模式行为                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直接解析器用户   | 普通图零特性字节直通任意构建器。包含 Phase 3 候选块的图必须在调用任意构建器前显式调用 `normalizeNodeParticleGraph`。                              |
| 代码片段用户     | `parseNodeParticleSetFromSnippet` 因本就异步且面向任意内容，会自动为内联和远程拉取的内容调用该辅助函数。                                          |
| 传送门（Teleport）| 可达的 TeleportOut 输出在求值器遍历前被重写为对应的 TeleportIn 源。若直接调用时省略按需启用，则保留现有的不支持的值块错误。                       |
| 折线（Elbow）    | 针对每一种连接角色执行写时复制（copy-on-write）源重写；无求值器且无运行时调用。                                                                   |
| 调试（Debug）    | 写时复制 `NpeValue` 透传；`stackSize`、日志与可观察对象仅限编辑器使用，不引入任何模拟状态。                                                       |
| Particle 局部量  | 按粒子 id 存储的 Float64 分量快照，存于感知交换移除的可选列中。                                                                                   |
| Loop 局部量      | 按系统、按次已启动的 `animateParticleSystem` 调用的快照，由该次调用中的更新与诞生共享。                                                           |
| 游离候选块       | 辅助函数命中后拉取运行时，其仅从根出发的遍历返回一个带有标记且共享原解析存储的图，不产生任何诊断错误或特性存储。                                  |
| 重复规范化       | 已规范化的候选图带有内部标记，因此第二次调用辅助函数会直接返回原图，不会重新扫描或重新拉取模块。                                                  |
| 无候选图调用     | 轻量辅助函数扫描一次，直接返回原图引用，且绝不执行动态导入。                                                                                      |

需求列表如下：

- **GP-REQ-01 —— 单一公共按需启用入口：** `normalizeNodeParticleGraph(graph: ParticleGraph): Promise<ParticleGraph>` 是唯一新增的包根函数。不新增具名图类型导出；重型运行时与内部标记保持内部私有并从声明文件中裁剪。
- **GP-REQ-02 —— 混合按需付费：** 解析器与所有构建器内部不包含任何图布线检测、元数据、分支或导入。因此直接普通图用户付出 0 B。显式辅助函数用户与代码片段用户付出轻量扫描成本；仅当命中 TeleportOut、LocalVariable、Elbow 或 Debug 候选块时才动态导入重型运行时。
- **GP-REQ-03 —— 传送门等价性：** 任意数量的独立 TeleportOut 块均可读取同一个 TeleportIn。Teleport 与 Elbow 对值、粒子流、系统流、纹理和梯度连接执行不透明连接对重写，而不具象化传递的值。每个消费方均观察到终端源的原始输出名、值与易变性。
- **GP-REQ-04 —— 确定性图失败：** 畸形的可达代理路由会在返回任何粒子系统前失败。诊断信息区分缺失端点、错误端点类、未连接的代理输入、不支持的输出名以及代理环路。
- **GP-REQ-05 —— 源不可变性与幂等性：** 规范化绝不修改调用方 JSON、`ParsedParticleBlock`、`ParsedParticleInput` 或原始 `ParticleGraph`。候选图仅在路由发生变更时写时复制块，并返回带有内部标记的图；重复调用辅助函数会直接返回该图。无候选块的图则原样返回且不打标记。
- **GP-REQ-06 —— 零代理运行时：** TeleportIn、TeleportOut、Elbow 与 Debug 不安装任何读取器、步骤、列、帧回调或求值器模块。规范化后的消费方边直接指向终端非代理源。即便如此，Debug 在编译消除前仍会校验其与 Babylon 兼容的仅 `NpeValue` 连接限制。
- **GP-REQ-07 —— 粒子快照：** Particle 作用域对每个粒子 id 至多求值输入一次，立即拷贝全部分量，在交换移除下保持存活，并通过 id 而非重置回调使复用槽位失效。
- **GP-REQ-08 —— 循环快照：** Loop 作用域对同一系统每次已启动模拟调用至多求值输入一次。同一次调用中的已有粒子更新、系统读取器与粒子诞生观察到同一份快照。
- **GP-REQ-09 —— 暂存安全与精度：** 标量与分量快照使用 Float64 存储。向量与颜色输出使用块持有的复用暂存值，因此保留现有的“读取时拷贝”消费方规则。
- **GP-REQ-10 —— 确定性合并重映射：** 未来的图合并操作必须在规范化之前通过同一个源局部 id 映射表重映射普通连接 id 与 TeleportOut `entryPoint` id。原始 id 冲突绝不会产生跨源传送门配对。
- **GP-REQ-11 —— 构建器一致性：** 同一份显式规范化后的图可与默认、流场贴图、噪声、组合纹理更新、混合模式及提供方驱动的构建器组合。内联与远程拉取的代码片段构建会在默认根遍历前自动规范化。
- **GP-REQ-12 —— 真值参照与隔离覆盖：** 实现要求具备状态固件、畸形图固件、内联/远程代码片段覆盖、官方 Teleport 一致性对比图，以及证明直接非用户既不加载辅助函数也不加载运行时的已拉取模块断言。

#### 9.31.2 当前数据流

Phase 3B 之前的数据流：

```text
serialized blocks
    -> parseNodeParticleSource
    -> readonly block map
    -> root DFS
    -> registry lookup for reachable class
    -> unsupported block error
```

当前直接 Phase 3C 数据流：

```text
serialized blocks
    -> parseNodeParticleSource
    -> readonly block map with no feature metadata
    -> caller chooses boundary
        ordinary graph -> any builder directly
        Phase 3 graph -> await normalizeNodeParticleGraph(graph)
            already marked -> exact graph; no scan or import
            no candidate -> exact graph; no runtime import
            candidate -> dynamic npe-graph-plumbing-runtime.ts
                detached candidate -> marked graph sharing parsed storage; no diagnostic or feature storage
                reachable candidate -> role and two-bit domain validation
                                    -> copy-on-write proxy source resolution
                                    -> cycle / endpoint validation
                                    -> marked normalized graph
    -> existing root DFS and lazy evaluator registry
         Teleport / Elbow / Debug are no longer reachable
         LocalVariable alone loads its evaluator and storage
```

代码片段路径是混合模式的自动半边：

```text
inline JSON or fetched snippet
    -> parseNodeParticleSource
    -> await normalizeNodeParticleGraph
    -> buildNodeParticleSet
```

公共辅助函数无副作用且不含模块级分配。其完整的加载决策逻辑为：

```ts
if (graph._isGraphPlumbingNormalized) return graph;
for (const block of graph.blocks.values()) {
    if (
        block.className === "ParticleTeleportOutBlock" ||
        block.className === "ParticleLocalVariableBlock" ||
        block.className === "ParticleElbowBlock" ||
        block.className === "ParticleDebugBlock"
    ) {
        return (await import("./npe-graph-plumbing-runtime.js")).normalizeNodeParticleGraphRuntime(graph);
    }
}
return graph;
```

`NodeParticleSet._graph` 始终精确保持传给所选构建器的图。构建器不会对其进行规范化、替换或标注。因此直接调用方仅在自己传入规范化图时才观测到规范化图；代码片段调用方则观测到由代码片段边界规范化后的图。

#### 9.31.3 序列化块契约

| 类                           | 输入            | 输出     | 序列化字段   | 契约                                                                                                                           |
| ---------------------------- | --------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `ParticleTeleportInBlock`    | 必填 `input`    | 无       | 无           | 定义一个或多个 TeleportOut 端点的源侧，接受所有序列化连接类型。                                                                |
| `ParticleTeleportOutBlock`   | 无              | `output` | `entryPoint` | `entryPoint` 为某 TeleportIn 的数字块 id。多个不同的 TeleportOut id 可指向同一个 TeleportIn id。                               |
| `ParticleElbowBlock`         | 必填 `input`    | `output` | 无           | 仅用于可视化布线；每一种序列化连接类型均规范化为其输入源。                                                                     |
| `ParticleDebugBlock`         | 必填 `input`    | `output` | `stackSize`  | 仅做 `NpeValue` 透传。Lite 不重建日志、可观察对象或编辑器插桩。`stackSize` 保留在序列化数据中但模拟不读取它。                  |
| `ParticleLocalVariableBlock` | 必填 `input`    | `output` | `scope`      | 仅做 `NpeValue` 快照。`scope === 0` 选择 Particle；其他任何值（包括缺失字段）均选择 Loop。                                     |

Babylon 使 TeleportIn 与 Elbow 的端口类型保留 `AutoDetect`，不排除 Particle、System、Texture 或梯度连接类型。因此 Lite 将它们的路由视作不透明的 `(targetBlockId, targetConnectionName)` 重写：它们可以传递粒子流、系统流、纹理、梯度或普通值，因为它们从不具象化所传递的值。这不会向 `NpeValue` 添加梯度元数据；重写后是否受支持取决于终端求值器与消费方。

Babylon 从 Debug 与 LocalVariable 中排除了 Particle、System、Texture 及全部四种梯度连接类型。Lite 保持这一边界：这两个类仅接受标量、Vector2、Vector3 与 Color4 `NpeValue` 路径。当消费方角色表识别出流、纹理或梯度路由时，规范化器会报告特定于类的不支持连接诊断；LocalVariable 还执行第 9.31.6 节中的运行时形状校验，因为序列化的输出端口不包含可用的 `type` 或 `valueType` 元数据。

#### 9.31.4 可达性、特性加载与写时复制规范化

辅助函数与运行时遵循以下精确路径：

1. `parseNodeParticleSource` 仅构造现有的块映射表与根 id 列表。它既不识别传送门，也不添加特性元数据。
2. 直接调用方显式调用 `normalizeNodeParticleGraph`；`parseNodeParticleSetFromSnippet` 在内联或网络解析之后自动调用它。
3. 轻量辅助函数首先直接返回带有已规范化标记的图。否则遍历 `graph.blocks.values()` 查找 TeleportOut、LocalVariable、Elbow 或 Debug。未命中则返回原图且绝不执行动态导入。命中则动态导入无副作用的 `npe-graph-plumbing-runtime.ts`，即使所有候选块都是游离的也不例外。
4. 重型运行时仅从 `systemBlockIds` 播种双比特域掩码遍历。游离的畸形候选块不会被访问，因此规范化返回共享原块映射表与根 id 的带标记图，不产生诊断错误或特性存储。可达路由则在求值器遍历前完成校验与重写。

TeleportIn 不是轻量辅助函数的触发器，因为它没有可用输出，在语义上仅通过 TeleportOut 的 `entryPoint` 访问。因此仅含 TeleportIn 而无 TeleportOut 的源会从辅助函数原样返回；若畸形手写输入直接连接到它，保留现有的不支持的值注册表错误是有意为之。LocalVariable、Elbow 与 Debug 是候选触发器。解析器与构建器均未添加任何检测器。

运行时使用双比特域映射执行根播种可达性遍历。它仅从 `systemBlockIds` 启动，在每个块上记录所有入边粒子/系统域的按位或，并仅当共享块获得新的域比特时才重新访问其输入。

遍历由消费方边驱动。对于每个访问到的块，先按序列化顺序选择名为 `particle` 的已连接输入，再按序列化顺序选择其余所有已连接输入。因此，粒子优先遍历为每一个被访问的块（不仅限于 `SystemBlock`）决定了确定性的诊断优先级；一旦校验通过，规范化重写结果本身与遍历顺序无关。对于每个已连接的消费方输入，规范化器按序执行以下操作：

1. 在深入终端源之前，先沿着完整的 Teleport 代理链解析源对 `(targetBlockId, targetConnectionName)`。
2. 仅替换源对。保留消费方输入的 `name`、位置、字面量 `value` 与 `valueType`；保留解析出的终端源的 `targetConnectionName`，而非代理的 `output` 名称。
3. 深入解析出的终端源。因此后续所属构建器在为值依赖赋值/构建之前，依然先解析 `particle` 边，即使该边最初指向 TeleportOut。

传出域推导自消费方输入，绝不推导自代理或终端输出：名为 `particle` 的 System 消费方输入启动粒子比特，其余所有 System 输入启动系统比特，非 System 消费方则传播其累积的入边掩码。

连接角色依据以下固定内部表从消费方推导，而不依赖缺失的源输出类型元数据：

| 角色       | 消费方规则                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 粒子流     | 任意名为 `particle` 的输入                                                                                    |
| 系统流     | 名为 `system`、`onStart` 或 `onEnd` 的输入                                                                    |
| 纹理       | `SystemBlock.texture`、`UpdateFlowMapBlock.flowMap` 或 `UpdateNoiseBlock.noiseTexture`                       |
| 梯度元数据 | `ParticleGradientBlock` 中名称以 `value` 开头的输入；其独立的 `gradient` 输入仍为普通标量 `NpeValue`           |
| `NpeValue` | 当前求值器契约接受的所有其他输入                                                                              |

角色在所有代理间原样传递。Teleport 与 Elbow 接受所有角色。Debug 与 LocalVariable 在求值器遍历前拒绝除 `NpeValue` 之外的所有角色。未来若新增支持非值连接的块，必须在同一 PR 中扩展此表；未知的不支持类在规范化后仍沿用普通注册表诊断失败。

保留消费方输入对于专用依赖是必需的。流场贴图与纹理更新遍历在规范化后继续根据未改变的消费方输入名称选择 CPU/内嵌纹理求值器覆盖，随后将该覆盖应用于解析出的终端源块。终端 `targetConnectionName` 同样被保留用于输出查找。因此经过 Teleport 或 Elbow 路由的纹理依然作为纹理依赖处理，而非变成通用的 `output` 值。

代理解析器识别以下规则：

- **TeleportOut：** 要求输出名为 `output`；要求 `entryPoint` 为有限、整型且大于等于零的数；通过解析器的最终块映射表解析该 id 并要求其为 TeleportIn；要求 TeleportIn 的 `input` 已连接；随后递归解析该输入的完整源对。当块 `0` 存在时，id `0` 合法。空字符串视为无效而非未连接。
- **Elbow 与 Debug：** 要求输出名为 `output` 且 `input` 已连接，校验 Debug 的角色为 `NpeValue`，随后递归解析完整源对。
- **LocalVariable：** 要求输出名为 `output`、`input` 已连接且角色为 `NpeValue`，随后将其作为终端求值器源返回。
- **其他终端源：** 原样返回源对。

解析器记录有序的代理 id 栈。重新访问已在栈中的代理属于布线环路，并报告完整的重复路径。即使 TeleportOut 本身没有序列化输入，TeleportOut 的可达性也会显式跨越其 `entryPoint` 连接到 TeleportIn 的输入。记忆化仅在终端解析成功后进行，因此失败或成环的路径不会污染其他诊断。

写时复制在边解析成功后执行。仅当某条输入的源对发生变更时才拷贝该输入；仅当某个块包含已变更输入时才拷贝该块。其 id、类、名称、原始序列化对象、未修改的输入对象、字面量值与值类型标签均按引用保留。仅当至少一条可达边发生变更时才构造新的块映射表；`systemBlockIds` 与所有未触及的块引用均保持不变。重型运行时返回的每一个图都带有内部属性 `_isGraphPlumbingNormalized: true`，包括共享原两套集合的游离候选图。轻量辅助函数在扫描前检查该标记，从而使重复规范化直接返回原图而不会再次拉取运行时。该标记从公共声明中裁剪，且绝不写入原解析图。原图与原始 JSON 在规范化后仍可继续复用。

解析器统一对所有重复块 id 保留现有的“后定义胜出”行为，包括 TeleportOut 与 TeleportIn 路由 id。规范化读取最终解析出的映射条目，因此最终有效的端点路由会成功，而最终为错误类的块会收到普通的错误端点类诊断。多个不同 TeleportOut id 可引用同一个最终 TeleportIn 条目实现扇出。

#### 9.31.5 图合并契约

Phase 3 中 Lite 不提供公共图合并 API。以下契约预留了未来合并的安全行为，当前不增加 API 或代码：

1. 在恢复任何边之前，为每个传入的原始块分配唯一的目标 id。
2. 将同一个源局部 id 映射表应用到每条输入的 `targetBlockId` 与每个 TeleportOut 的 `entryPoint`。
3. 仅在所有 id 与端点 id 重写完毕后合并重映射后的块。
4. 对合并后的唯一 id 图运行图布线规范化。
5. 绝不允许因合并前原始 id 碰巧相同，而将来自一个源的 TeleportOut 解析到来自另一个源的 TeleportIn。

不支持在不做源局部重映射的情况下合并已解析的图。这避免了在 Phase 3 中暴露可变图编辑 API。

这是在 Babylon 现有重连行为基础上有意进行的加固。Babylon 使用真值守卫检查 `entryPoint`，因此序列化的 `0` 与 `""` 会被静默忽略，且原始 id 合并冲突可能重连到错误源。Lite 在块存在时接受有限整数 id `0`，拒绝空字符串及所有其他无效端点值，并要求源局部重映射以杜绝跨图误连。

#### 9.31.6 Particle 作用域局部变量存储

每个可达的 Particle 作用域 LocalVariable 都会请求六个以其块 id 命名的可选列：

| 列后缀             | 存储    | 用途                                                               |
| ------------------ | ------- | ------------------------------------------------------------------ |
| `id`               | Uint32  | 当前快照占用的密集槽位所属的粒子 id。                              |
| `valid`            | Uint8   | 区分真正的 id-0 快照与零初始化的存储。                             |
| `value0` 到 `value3` | Float64 | 标量或 Vector2/Vector3/Color4 分量。未使用的分量保持忽略。         |

序列化输出连接点未保留可用的 `type` 或 `valueType`，因此构建时无法按输出形状特化该布局。每个可达的 Particle 作用域块都会无条件分配全部六列。容量开销为每块每粒子槽位 `4 + 1 + 4 * 8 = 37` 字节（不含六个类型化数组对象头以及分配器/对齐开销）。

两种作用域在求值输入一次后均使用完全相同的运行时判别器：

1. `typeof value === "number"` 选择标量。不额外增加有限性检查。
2. 否则，若为非 null 对象且满足 `"r" in value` 则选择 Color4，并要求具有数值型 `r`、`g`、`b` 与 `a` 属性。
3. 否则，若对象满足 `"z" in value` 则选择 Vector3，并要求具有数值型 `x`、`y` 与 `z` 属性。
4. 否则，具有数值型 `x` 与 `y` 属性的对象选择 Vector2。
5. `null`、非对象以及在其选中分支下格式错误的对象均为不支持的值。畸形的 Color4 或 Vector3 不会降级匹配更小维度的向量形状。

对 Particle 槽位的首次读取会同时比较 `valid` 与缓存 id 是否等于 `buffer.id[i]`。未命中时精确求值输入一次，对其分类与校验，在任何其他读取器有机会覆写暂存区前拷贝全部分量，最后才提交 id、分量与 valid 标志。首次接受的值固定该求值器的运行时形状。后续出现另一种形状的有效值将抛出形状变更诊断；出现畸形值则抛出不支持的值诊断。无论哪种失败，均保持先前的快照与有效性不变。

全部六列都会加入 `buffer._all`，因此交换移除会随存活粒子的搬移一并搬运快照、id 与有效性。新生成的粒子获得新的 id；除非全局 Uint32 id 源发生回绕（即第 11 节所述的既有 id 回绕限制），否则陈旧的尾部数据不可能匹配。不添加生成或死亡回调。

标量输出读取 `value0`。Vector2、Vector3 与 Color4 输出将所需分量拷贝到块持有的复用暂存值中。消费方遵循常规 `NpeGetter` 规则：在调用另一个可能覆写暂存区的读取器之前先消费或拷贝该结果。

这种 id 加 valid 的设计刻意规避了 Babylon 的重置回调耦合。Babylon 由每个 LocalVariable 块写入粒子对象单一的 `_properties.onReset` 回调，导致后一个局部块可能覆写前一个局部块的清理逻辑。Lite 没有按粒子回调或隐藏块顺序：每个局部变量的列随交换移除搬移，id 不匹配即令陈旧数据失效。独立的 `valid` 列还能将粒子 id `0` 与空存储区分开来。

#### 9.31.7 Loop 作用域 epoch 与帧准备

Loop 刻意定义为：对单个已构建系统执行一次已启动的 `animateParticleSystem` 调用。这是 Lite 自己定义的模拟边界，并不声称手动调用复现了 Babylon 的场景帧 id 缓存。它为手动模拟、固定步长回放以及渲染器托管模拟提供了确定性语义，同时无需让粒子系统依赖 Scene 帧计数器。

单个系统中的首个 Loop 作用域 LocalVariable 会创建一个构建局部 epoch 对象，并向系统的可选帧准备链追加一次 epoch 递增。同一系统中额外的 Loop 块共享该 epoch，不新增帧回调。每个块存储其最近一次观察到的 epoch、有效标志、运行时形状、四个 Float64 JavaScript 数值字段以及一个复用的输出暂存值。Loop 作用域不分配按容量大小的列。

`_prepareFrame` 采用有序的特性局部组合。提供方初始化在求值器遍历前安装其回调。在遍历期间，首个 Loop 局部块捕获该回调，并用一个先调用被捕获回调再递增共享 Loop epoch 的包装器替换它。后续 Loop 块复用该 epoch 且不安装任何回调。

```text
started animate call
    -> provider preparation, when present (installed before evaluator traversal)
    -> one local-variable epoch increment, when any Loop block is reachable
    -> dynamic emit-rate evaluation
    -> existing-particle updates
    -> particle births
```

提供方回调与 Loop 包装器不捕获系统对象，也不会形成自引用环。若提供方抛出异常，则会阻止 epoch 递增与模拟执行，保持错误原子性。不含 Loop 的系统完全保留原有的 Phase 2 提供方钩子（或根本没有 `_prepareFrame` 字段），而 `animateParticleSystem` 中原有的可选调用仍是唯一公共模拟开销。

在某个 epoch 中的首次 Loop 读取会使用第 9.31.6 节的判别器求值并快照其输入。同一次调用中的后续每次读取都返回该快照，包括来自系统读取器、多个已有粒子以及新创建粒子的读取。未启动的调用会在 epoch 推进前直接返回。已停止但曾启动的排空调用仍会推进 epoch。比例为零的调用同样会推进，因为一次显式模拟调用即构成一个 Loop。

每个 System 根都会获得全新的求值器、epoch 状态与快照。因此即使多个系统出自同一份已解析图并在同一调用序列中被驱动，不同系统与不同构建之间依然相互独立。这刻意不同于 Babylon——在 Babylon 中，单个 LocalVariable 块实例会在观察同一场景帧 id 的系统间共享其 Loop 映射表。Lite 保持状态归纯状态系统所有，避免跨系统的隐藏注册表，并使手动模拟具备确定性。测试必须预期系统彼此独立。

Particle 作用域 LocalVariable 在任何累积掩码包含系统比特的路径上均会被拒绝，包括掩码同时包含粒子与系统的共享块。Loop 作用域在任一域或双域上均合法，并在该次已启动调用中谁先读取就对谁做快照。这是有意偏离 Babylon 的安全改进：Babylon 允许系统域路径使用 Particle 作用域，将缺失粒子上下文归入 `-1` 桶，同时还通过 `id || -1` 把粒子 id `0` 也映射成 `-1`。Lite 拒绝这种歧义的系统路径，同时凭借独立的 `valid` 与 Uint32 `id` 列正确保留 id `0`。

对于 Lite 的 Loop 边界不存在直接的 Babylon 真值参照。Babylon 读取 Loop 局部量要求非空场景，而第 13.2 节的空场景手动流程会抛出异常；若保留场景但不经过渲染直接反复调用粒子动画，其帧 id 并不会推进。因此确定性 Lite 测试自身拥有已启动调用语义的归属权，不声称有任何 Babylon 固件证明该边界。未来的有限固件或许可以每观察一步调用一次 `scene.render()`（配合真实递增的帧 id 以及每次渲染恰好一次相关的首次读取），但也仅能覆盖该兼容子集。

#### 9.31.8 Elbow 与 Debug 行为

Elbow 与 Debug 使用与 TeleportOut 相同的递归源解析器。规范化之后不再有可达消费方指向这两个块，因此二者均不需要注册表条目或求值器文件。

Elbow 仅重写不透明源对，从而保留每一种序列化连接角色（包括粒子流、系统流、纹理与梯度路由）。Debug 仅保留 `NpeValue` 流，刻意省略 Babylon 的诊断副作用：没有日志数组、字符串格式化、可观察对象或受 `stackSize` 限制的收集集合。这些属于运行期数值之上的编辑器插桩，而非序列化的模拟输出。忽略它们可避免逐粒子字符串构造和观察者通知进入 Lite 热点路径。

在 Lite 中，Elbow、Debug 与 LocalVariable 的输入均是必填的。未连接的可达块会在规范化期间抛出异常。这是有意偏离 Babylon 行为（Babylon 对未连接的 Debug/Local 返回 null，对未连接的 Elbow 做透传）的确定性设计：无法产出所承诺输出的图绝不会进入部分构建好的系统。

链式串联的 Elbow、Debug 与 Teleport 路由会解析为单个终端源对。这些代理任意组合形成的环路均使用相同的确定性环路诊断。

#### 9.31.9 诊断信息

所有已实现的图布线与 LocalVariable 诊断均集中列于第 11 节。它们的实现使用内联字面量或模板字符串参数，以便 Lite 错误提取插件在生产 bundle 中替换错误文本。

#### 9.31.10 按需付费与打包契约

- 直接解析器/构建用户不会在解析器或任何所属构建器中触发检测器、辅助函数导入、动态导入引用或分支。标准直接图场景 262、263、264、276、277、280、281、283 和 284 必须与已评审的 Phase 3B 检查点保持原始字节完全一致，且既不拉取图布线模块也不拉取 LocalVariable 求值器。场景 302 演练必需的提供方/帧准备集成，且必须保持相同的图/局部模块隔离性。
- 显式辅助函数用户付出轻量模块与一次块映射表扫描的开销。无候选块图在动态导入前直接返回原图，因此不会拉取重型运行时。对已规范化的候选图重复调用会在扫描前从内部标记处直接返回。
- `parseNodeParticleSetFromSnippet` 静态导入轻量辅助函数，因为代码片段解析是自动特性边界。内联与网络代码片段共享同一路径。不含 Teleport 的代码片段保留轻量辅助函数但不会拉取重型运行时；含 Teleport 的代码片段则会拉取。
- 显式或代码片段辅助函数调用中若存在任意 TeleportOut、LocalVariable、Elbow 或 Debug 候选块，都会拉取重型运行时。游离的畸形候选块在语义上保持惰性，因为仅从根开始的规范化会返回共享原解析存储的带标记图，不产生诊断或特性存储。单独的 TeleportIn 不触发运行时，若畸形输入直接连接它则依然不受支持。
- Teleport、Elbow 与 Debug 不增加求值器文件、输出读取器、更新步骤、创建槽位、粒子列或每次模拟回调。它们的校验与重写全部位于规范化器中。
- Particle 局部存储仅在存在可达的 Particle 作用域块时分配。Loop 局部状态及其单个准备闭包仅在存在可达的 Loop 作用域块时分配。
- 局部变量求值器通过现有的可选值注册表触达。不含 LocalVariable 的图不会拉取其模块。
- 生产 bundle 断言会在当前 CI 发布的基线工作流下检查生成的 bundle-info；PR 中不得包含任何生成的清单文件。
- 现有标准直接粒子场景拒绝两个图布线模块以及局部变量求值器。场景 305 显式调用辅助函数，必须拉取轻量辅助函数、重型运行时以及局部求值器。Teleport、Elbow 与 Debug 求值器模块不存在。

#### 9.31.11 备选方案与风险

| 备选方案                                               | 决策                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 复现 Babylon 对象映射表与粒子重置回调                  | 否决。Lite 粒子是稠密槽位而非对象；带 id 校验的列可在交换移除下保持生命周期而无需回调或逐粒子分配。                                       |
| 使用 `scene` 帧 id 作为 Loop 边界                      | 否决。手动模拟与纯 Sprite2D 用法必须独立于场景帧。单次已启动模拟调用是确定性的 Lite 循环边界。                                            |
| 像 Babylon 一样跨系统共享一个 Loop 映射表              | 否决。按根独立的求值器保持系统所有权，避免隐藏的跨系统注册表，并使手动模拟具备确定性。                                                    |
| 为 Teleport、Elbow 与 Debug 提供运行时透传求值器       | 否决。这会为本可在遍历前消除的拓扑结构增加读取器调用与模块字节数。                                                                        |
| 自动解析器标记外加三个构建器接缝                       | 实测后否决。即使普通场景不拉取规范化器，场景 262/280/281/302 也增大了 175–193 原始字节。直接用户要求 0 B 开销。                           |
| 从每个所属遍历静态导入完整规范化器                     | 否决。会让所有直接图用户为可选的拓扑重写付费。                                                                                            |
| 为所有调用方提供公共辅助函数，并对代码片段自动规范化   | 采纳。直接 Teleport 用户显式按需启用；既有的异步代码片段边界保留导入内容的自动行为。                                                      |
| 添加静态导入的候选块/可达性探测器                      | 实测后否决。尽管规范化器本身仍保持懒加载，但它让无关场景增大了约 1.1 KB。                                                                 |
| 按需构建器解析器                                       | 实测后否决。现有直接场景仍增大了 185–191 原始字节。                                                                                       |
| 在每个构建器中直接执行所有者扫描                       | 实测后否决。现有直接场景增大了 207–221 原始字节。                                                                                         |
| 自动构建器背后的共享辅助函数或解析器 thunk             | 实测后否决。两者均比已批准的混合边界体积更大，且依然向直接用户收费。                                                                      |
| 原地修改已解析的输入                                   | 否决。会导致图复用与对比构建产生顺序依赖。                                                                                                |
| 将局部快照存为 JS 对象或数组                           | 否决。会在每粒子时产生分配，且除非克隆每个值否则会与易变读取器暂存区产生别名冲突。                                                        |
| 从序列化输出元数据推导 LocalVariable 形状              | 否决。输出点缺少可靠的 `type`/`valueType`，因此每个 Particle 局部量均预留完整的 37 字节槽位布局。                                         |
| 为每个系统无条件添加 epoch 字段                        | 否决。共享的特性自有 epoch 对象与现有的可选帧接缝使非用户保持零分配。                                                                     |
| 静默跟随畸形的传送门路由                               | 否决。显式的端点、连接、输出名与环路诊断使畸形可达图保持确定性。                                                                          |

主要实现风险在于代理环路处理、意外诊断游离块、暂存区别名冲突以及槽位复用。有序栈解析器、仅从根开始的遍历、分量拷贝以及 id/valid 列是必需的缓解措施。

#### 9.31.12 实现与测试切片

Phase 3A 仅修改了本架构文档。

Phase 3B 实现了两个无副作用的节点基础设施文件：

```text
packages/babylon-lite/src/particle/node/npe-graph-plumbing.ts
packages/babylon-lite/src/particle/node/npe-graph-plumbing-runtime.ts
```

轻量文件负责公共扫描与懒导入；运行时负责写时复制路由解析与诊断。`npe-types.ts` 仅携带内部已规范化返回标记。`node-particle.ts` 在代码片段边界调用辅助函数，`index.ts` 从根导出该辅助函数，场景 305 则在解析与构建之间显式调用它。解析器及全部三条所属遍历在受影响区域均与普通基线保持逐字节一致。这使节点基础设施文件数从 27 增至 29，规范化构建器类数从 29 增至 31；两个 Teleport 类均未获得求值器。

修正后的 46 文件求值器/辅助函数清单包含了 `embedded-texture-source-block.ts`——该文件在 Phase 3B 之前即已存在，但在早先的 45 文件清单中被遗漏，它并非 Phase 3B 新增的求值器。

Phase 3B 针对性固件覆盖了：直接未规范化遗漏报错；显式规范化成功；Teleport 跨标量、Vector2、Vector3、Color4、梯度、粒子/系统流与纹理边的扇出及链式路由；终端输出名保留；System `particle` 顺序；同一规范化图跨所有专用构建器使用；端点 id `0`；无效/空/缺失/错误端点；重复 Teleport 路由 id 的“后定义胜出”行为；未连接的 TeleportIn；环路；图不可变性；所有图均无解析器元数据；仅含 TeleportIn 时辅助函数原样返回且保留原有不支持错误；非 Teleport 图原样引用返回；游离畸形 Teleport 的共享存储规范化且无诊断或存储分配；重复规范化恒等性；内联与远程拉取代码片段自动支持；非 Teleport 代码片段行为；声明文件裁剪；无 Teleport 求值器/注册表主体；以及生成的运行时 chunk/模块隔离。针对性测试必须包含粒子流 Teleport 覆盖。

Phase 3B 还引入了官方场景 305（`scene305-npe-teleport`）及其全部锚点：Lite、Babylon 参考与打包页面（`lab/lite/scene305.html`、`lab/lite/babylon-ref-scene305.html` 与 `lab/lite/bundle-scene305.html`）；共享图源 `lab/lite/src/shared/scene305-teleport-npe.ts`；Babylon 与 Lite 源码入口 `lab/lite/src/bjs/scene305.ts` 与 `lab/lite/src/lite/scene305.ts`；`reference/lite/scene305-npe-teleport/babylon-ref-golden.png`；`lab/public/thumbnails/scene305.jpg`；`tests/lite/parity/scenes/scene305-npe-teleport.spec.ts`；以及场景配置。图载荷使用标准的 `*-npe.ts` 后缀，使打包统计排除检入的图数据，而场景 305 上限仅衡量引擎/运行时代码。Lab HTML/Vite 入口与画廊卡片均基于配置/文件自动发现，无需修改硬编码的 Vite 或画廊列表。Phase 3C 保留了 Teleport 扇出，并围绕仅创建阶段的随机尺寸值串联了 Elbow、Debug 与一个 Particle 作用域 LocalVariable。它不添加 Loop 语义。其 Lite 入口在默认构建器前显式调用 `normalizeNodeParticleGraph(parseNodeParticleSource(...))`；Babylon 与 Lite 解析同一份共享图。

场景 305 沿用场景 262 的确定性运行时参考约定，但属于冻结且不可交互的一致性固件。双方入口创建同一个固定相机，且均不导入或挂接相机控制；Lite 入口刻意镜像 Babylon.js 真值参照。该归属关系仅针对场景 305，不改变可交互或通用 NPE 场景的约定。其一致性规范在打开 Lite 前先调用共享 `captureGolden` 辅助函数截取 Babylon WebGPU 页面，随后以 `MAD <= 0.01` 对比 Lite。Phase 3B 运行结果取得了 `MAD = 0.000`、`43,936` 原始字节与 `25,906` gzip 字节。Phase 3C 不修改或重新生成已提交的基准图或缩略图：针对性非视觉测试证明其与场景 262 的 200 步粒子状态完全相等，而 CI 负责视觉/一致性结果。生成的 bundle 输出保持忽略，且变更中不应包含任何生成的清单。

Phase 3C 显式将 Phase 3B 的根播种普通已访问 `Set` 替换为第 9.31.4 节规定的域掩码遍历。它扩展了轻量辅助函数的候选扫描与重型运行时以支持 LocalVariable、Elbow 与 Debug，新增 `blocks/particle-local-variable-block.ts` 并从 `npe-registry-extra-values.ts` 路由到它，在 LocalVariable 求值器内部通过现有的 `_prepareFrame` 接缝组合 Loop epoch，为 `NpeBuildState` 扩展特性自有的 Loop epoch 共享，并增加了确定性测试覆盖：

- 粒子 id 为零与非零、A-B-A 读取、双粒子、交换移除、尾部槽位复用、id 不匹配、标量/Vector2/Vector3/Color4 快照、易变源暂存区以及运行时形状不匹配。
- 精确的运行时判别器优先级、畸形属性、无条件的 37 字节 Particle 槽位布局，以及无 Loop 容量列。
- 跨动态发射率、已有更新与诞生的 Loop 首次读取行为；多次读取与多块；零比例、未启动、停止排空、重启、独立系统、提供方组合顺序与回调错误。
- Particle 作用域对纯系统与粒子+系统共享掩码的拒绝；Loop 在任一域中的接纳；id 为零时的健壮性；以及有文档记录的 Babylon 差异。
- 所有连接角色的 Elbow 路由；Debug `NpeValue` 路由；特定于类的不支持流/纹理/梯度诊断；传送门加透传链；未连接输入；混合代理环路；被忽略的 `stackSize`；图不可变性；以及游离畸形块。
- 默认、流场贴图、噪声、组合纹理更新、混合模式、提供方与代码片段构建器的一致性。
- 确定性的 Lite Loop 语义，并明确记录 Babylon 帧 id 限制，而非将其误报为 Lite 调用边界的证明。

Phase 3C 修改了共享的场景 305 图，围绕一个快照等于其源值的确定性按粒子值串联了 Elbow、Debug 与 Particle 作用域 LocalVariable。它未添加 Loop 块。冻结且不可交互的 Lite 入口刻意不导入也不调用 `attachControl`，与 Babylon.js 真值参照的固定相机一致。因此其上限衡量的是 Phase 3 图特性成本，而非可选输入控制；此固件特例不适用于通用 NPE 场景。按策略保留已提交的 Phase 3B 基准图与缩略图不变；本地提供非视觉状态相等性证据，CI 提供一致性结果。打包检查仅对场景 305 要求存在局部变量求值器，同时标准场景继续拒绝规范化器与局部求值器；并且在源码、运行时 chunk 与运行时模块三个边界上均禁止场景 305 引入 `arc-rotate-controls`。

Phase 3C 将规范化构建器类数从 31 提高到 34，块求值器/辅助函数文件数从 46 提高到 47。节点基础设施保持 29 个、粒子根文件保持 11 个，因为轻量辅助函数/运行时与帧准备组合均在现有文件内扩展。

当前描述性章节已同步为：34 个规范化构建器类、11 个粒子根文件、29 个节点基础设施文件以及 47 个求值器/辅助函数文件。

## 10. 渲染与实时注册

### 10.1 公告板创建

`createParticleBillboard` 将 `ParticleSystem` 转换为通用的 `FacingBillboardSpriteSystem` 渲染表示。它要求 `system.texture` 非空；若为 null，则抛出 `createParticleBillboard: the particle system has no texture`。

它基于现有纹理创建按行主序排列的网格图集：

- 当 `cellWidth` 与 `cellHeight` 均大于零时，精灵系统使用这两个尺寸。
- 缺失、为零或负值的维度则采用对应轴上的完整纹理尺寸。
- 边距（margin）与间距（spacing）均为零。
- 列数为 `max(1, floor(texture.width / cellWidth))`，行数为 `max(1, floor(texture.height / cellHeight))`。
- 每一帧具有自顶向下的 UV 边界、等于单元格尺寸的源尺寸以及 `[0.5, 0.5]` 的轴心。
- `premultipliedAlpha` 为 false。

随后它创建一个面向相机的公告板系统，初始容量为 `system.buffer.capacity` 并带有映射后的混合描述符。公告板构造会将内部容量钳位到至少 1，并分配 `capacity * 16` 个 Float32 实例值外加 `capacity * 2` 个 Float32 保存尺寸值。

普通构建器保留既有的公告板映射：模式 `0` 使用通用的 OneOne 描述符，模式 `1` 使用通用 alpha 混合，其他任何数值均使用通用 Add。该路径不导入任何精确或高级混合模块；因此模式 `3` 和 `4` 会安全地降级为 Add。

`enableNodeParticleBlendModes` 在注册时根据当前可变的模式解析粒子侧私有的描述符，使 alpha 通道状态与高级模式在不修改公共公告板描述符的前提下与 Babylon.js 保持一致。其精确映射如下：

| 粒子 `blendMode` | 通道               | 颜色因子                                              | Alpha 因子                       |
| ---------------- | ------------------ | ----------------------------------------------------- | -------------------------------- |
| `0`              | OneOne             | source `one`, destination `one`                       | source `zero`, destination `one` |
| `1`              | Standard           | source `src-alpha`, destination `one-minus-src-alpha` | source `one`, destination `one`  |
| `2`              | Add                | source `src-alpha`, destination `one`                 | source `zero`, destination `one` |
| `3`              | Multiply           | source `dst`, destination `zero`                      | source `one`, destination `one`  |
| `4`              | 先 Multiply 后 Add | 第一遍使用模式 `3`；第二遍使用模式 `2`                | 分别采用上方各通道对应的因子     |
| 其他任何数值     | Add                | source `src-alpha`, destination `one`                 | source `zero`, destination `one` |

所有混合操作均为 `add`。所有映射均走透明公告板路径并禁用深度写入。

Multiply 通道使用专用片元着色器变体。给定采样的图集纹素、逐粒子色调以及公告板不透明度，其计算为：

```wgsl
let sampled = textureSample(atlasTex, atlasSamp, in.uv);
let baseColor = sampled * in.tint * billboards.opacityMul;
let sourceAlpha = sampled.a * in.tint.a * billboards.opacityMul.a;
return vec4f(baseColor.rgb * sourceAlpha + vec3f(1.0) * (1.0 - sourceAlpha), baseColor.a);
```

在进行目标颜色乘法混合前向白色插值，可确保零 alpha 的纹素让帧缓冲保持不变。Add 通道则使用标准的公告板片元着色器（`sampled * tint * opacityMul`）。

内部粒子混合注册器会就地配置新创建的面向相机公告板表示。不含 `_particlePasses` 的模式委托给 `addBillboardSystemToScene`。高级模式挂载私有 Multiply 着色器，并通过粒子模块拥有的延迟可渲染对象构建器加入相同的场景公告板集合（成员关系、拾取、移除、发现）。

通用的 `buildBillboardRenderable(engine, system)` API 及其普通场景注册器保持不变。可选粒子路径在调用该基础构建器之前先挂载静态着色器。所有粒子系统共享单个懒创建的描述符以及按设备/朝向缓存的着色器模块，因此相同的系统会共享着色器模块与管线缓存键。

私有描述符不输出 `SpriteFx` UBO 声明、布局条目、分配或逐帧写入。其钩子刻意镜像公共的公告板自定义着色器钩子，而不是将该可选特性及其核心代码引入仅使用 Multiply 的 bundle 中。该镜像在行为上与最后写入者胜出的全局钩子保持兼容，并使用单个模块级空参数数组，而不在每次更新时分配内存。

模式 `3` 原封不动地使用生成的常规公告板可渲染对象。模式 `4` 用一条标准 Add 管线、第二个绑定组以及第二个系统 Uniform 缓冲区包装其绘制绑定。两条管线需要各自独立的绑定组，因为每条管线拥有自己的绑定组布局。基础可渲染对象刻意将其 GPU 缓冲区保持私有，因此可选的模式 4 模块拥有并按脏标志更新自己的一份 32 字节拷贝，而不通过通用公告板契约暴露 GPU 内部细节。它仍然是一个透明可渲染对象，拥有一个逻辑公告板系统、一次排序后的实例上传、一个实例缓冲区以及一个索引缓冲区。

模式 `4` 首先绘制常规 Multiply 绑定。主绘制结束后实例缓冲区与索引缓冲区仍处于绑定状态，因此包装器随后仅绑定 Add 管线与 Add 绑定组，然后针对同一批实例发出第二次带索引绘制调用。最后它恢复主 Multiply 管线，使渲染任务的连续管线缓存保持正确。当粒子可见时该绘制报告两次 GPU 绘制调用，系统隐藏或为空时报告零次。

`registerNodeParticleSet` 调用每个系统已安装的 `_registerBillboard` 回调，未安装时回退到 `addBillboardSystemToScene`。因此经增强的系统会根据当前的 `system.blendMode` 精确解析全部五种模式；普通构建器则保留原生的实时注册路径与 Add 回退。

### 10.2 公告板同步

`syncParticleBillboard` 清空公告板计数与已保存尺寸，请求标准 size、scale、angle 和 color 列，随后遍历 `[0, buffer.alive)`。它为每个粒子调用一次 `addBillboardSpriteIndex`，参数为：

```ts
{
    position: [posX[i], posY[i], posZ[i]],
    sizeWorld: [size[i] * scaleX[i], size[i] * scaleY[i]],
    color: [colorR[i], colorG[i], colorB[i], colorA[i]],
    rotation: angle[i],
    frame: spriteSheet ? spriteSheet.cellIndex[i] : 0,
}
```

该属性对象及其 position、size 和 color 元组都是为每个存活粒子创建的临时分配。公告板将它们写入其紧凑的 Float32 实例数组。由于公告板初始容量等于粒子容量且 `alive <= capacity`，正常同步不会触发扩容。

帧查找由精灵图集进行边界检查。同步期间遇到无效单元格会抛出 `resolveSpriteFrame: index <frame> out of range [0, <frameCount>)`。非精灵图总是请求帧 0。

公告板路径使用上述临时分配以及公告板子系统的存储、着色器、管线、绑定组、延迟可渲染对象和拾取支持。

### 10.3 公告板场景注册

`registerNodeParticleSet(scene, set, options = {})` 使用 `autoStart = options.autoStart ?? true`。按 `set.systems` 顺序对每个系统执行：

1. 创建粒子公告板。
2. 调用 `(system._registerBillboard ?? addBillboardSystemToScene)(scene, billboard)`。仅显式混合模式构建器会安装粒子混合注册器，且仅针对携带 `_particlePasses` 的描述符。
3. 当 `autoStart` 为 true 时调用 `startParticleSystem`。
4. 向 `scene._beforeRender` 追加一个内部回调。

每个回调计算：

```ts
const ratio = deltaMs > 0 ? deltaMs / (1000 / 60) : 1;
animateParticleSystem(system, ratio);
syncParticleBillboard(system, billboard);
```

注册期间不执行同步；首个已注册回调会执行首次实时模拟与上传。内部回调采用追加方式，因此先于集合注册的相机控制和特性准备会先运行，且多系统集合的回调保留系统注册顺序。

该注册函数返回 `void`，不暴露公告板对象，也不提供回调注销句柄。当 `autoStart` 为 false 时，回调依然会被注册；在系统启动前动画步进是空操作，而同步仍每帧运行。

### 10.4 Sprite2D 桥接创建与映射

`createParticleSprite2DBridge(system, options = {})` 是手动纯 2D 桥接工厂。它要求 `system.texture` 非空；缺失纹理时抛出 `createParticleSprite2DBridge: the particle system has no texture`。

该工厂遵循第 10.1 节所述的行主序网格图集规则，包括缺失或非正单元格尺寸时的整张纹理回退以及带边界检查的帧查找。它创建一个居中的 `Sprite2DLayer`：

- `capacity` 固定为 `system.buffer.capacity`；
- `depth: "none"` 且 `pivot: [0.5, 0.5]`；
- 混合模式由下方的桥接映射决定；以及
- 将可选的 `opacity`、`visible`、`order` 与 `view` 从 `options.layer` 透传。

不能通过 `options.layer` 覆盖 `capacity`、`depth`、`blend` 与 `pivot`。返回的桥接对象持有系统与图层的只读引用，以及可变的坐标映射字段。`pixelsPerUnit` 默认为 `1` 且必须为正有限数。`originPx` 默认为 `[0, 0]` 且两个分量必须为有限数。`invertY` 默认为 `true`。

对于每个存活槽位，令 `ySign = invertY ? -1 : 1`。映射关系为：

```ts
positionPx = [originPx[0] + posX[i] * pixelsPerUnit, originPx[1] + posY[i] * pixelsPerUnit * ySign];
sizePx = [size[i] * scaleX[i] * pixelsPerUnit, size[i] * scaleY[i] * pixelsPerUnit];
rotation = angle[i] * ySign;
color = [colorR[i], colorG[i], colorB[i], colorA[i]];
frame = spriteSheet ? spriteSheet.cellIndex[i] : 0;
```

这默认将 +Y 向上的 NPE 世界 XY 显式转换为 +Y 向下的 Sprite2D 像素坐标。禁用 `invertY` 会保留 +Y 向上的位置与旋转。`posZ` 不会被消费；该桥接器仅支持 XY，不承诺 XZ/YZ 投影。

混合映射为：

| 粒子 `blendMode` | Sprite2D 描述符       | 颜色因子                                              | Alpha 因子                                      |
| ---------------- | --------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| `0`              | `spriteBlendOneOne`   | source `one`, destination `one`                       | source `one`, destination `one`                 |
| `1`              | `spriteBlendAlpha`    | source `src-alpha`, destination `one-minus-src-alpha` | source `one`, destination `one-minus-src-alpha` |
| 其他任何数值     | `spriteBlendAdditive` | source `src-alpha`, destination `one`                 | source `one`, destination `one`                 |

所有混合操作均为 `add`。模式 `0` 为纯 1:1 相加；与带 alpha 加权的加法回退不同，源 RGB 不会乘以源 alpha。

`enableNodeParticleBlendModes` 不会改变此基础 Sprite2D 映射。它仅安装公告板的 `_registerBillboard` 回调。因此当调用方显式选用普通桥接器时，模式 `3`、`4` 以及未知值仍映射为 `spriteBlendAdditive`。精确的 Sprite2D 渲染是下文所述的独立按需启用特性。

### 10.5 精确 Sprite2D 混合模式桥接

`particle-sprite-2d-blend-modes.ts` 是精确 Sprite2D 输出的粒子侧按需启用模块。它适用于任何已构建的 `NodeParticleSet`，在创建桥接时读取每个系统当前可变的 `blendMode`；既不需要 `buildNodeParticleSetWithBlendModes` 也不需要 `enableNodeParticleBlendModes`，因为那两个 API 仅配置公告板注册。

`createParticleSprite2DBridgeWithBlendModes(system, options = {})` 将基础纹理、映射与图集校验委托给 `createParticleSprite2DBridge`。在暴露该桥接之前，它用 `createParticleBlend(system.blendMode)` 替换主图层的内部描述符。这种结构复用之所以安全，是因为 `BillboardBlendDescriptor` 扩展了 `SpriteBlendDescriptor`；Sprite2D 仅读取 `_key`、`_descriptor` 与 `_premultipliedOpacity`。`particle-blend.ts` 仅按类型导入公告板描述符，因此精确 Sprite2D bundle 不会保留任何公告板运行时模块。

工厂返回一个逻辑桥接对象，带有一份可变映射状态。`layer` 是权威展示图层，`layers` 暴露所有按序排列的渲染通道图层，供渲染器挂接与检查。内部 `_passes` 列表为每个通道持有一个基础紧凑桥接，从而使图集解析与实例映射保持单一来源。

精确模式表如下：

| 粒子 `blendMode` | Sprite2D 通道      | 颜色因子                                              | Alpha 因子                       |
| ---------------- | ------------------ | ----------------------------------------------------- | -------------------------------- |
| `0`              | OneOne             | source `one`, destination `one`                       | source `zero`, destination `one` |
| `1`              | Standard           | source `src-alpha`, destination `one-minus-src-alpha` | source `one`, destination `one`  |
| `2`              | Add                | source `src-alpha`, destination `one`                 | source `zero`, destination `one` |
| `3`              | Multiply           | source `dst`, destination `zero`                      | source `one`, destination `one`  |
| `4`              | 先 Multiply 后 Add | 第一遍使用模式 `3`；第二遍使用模式 `2`                | 分别采用上方各通道对应的因子     |
| 其他任何数值     | Add                | source `src-alpha`, destination `one`                 | source `zero`, destination `one` |

所有混合操作均为 `add`。模式 `0`、`1`、`2`、`3` 与默认值创建单个图层。模式 `4` 在同一图集与容量之上精确创建两个图层。两者接收相同的 `order` 并连续挂接。`SpriteRenderer` 使用稳定的升序排序，因此相同 `order` 的 Multiply 与 Add 图层保持紧邻且顺序固定。绑定拥有成员所有权；调用方不得单独移除/重新插入某个通道图层。不添加任何通用的 `SpriteRenderer` 多通道机制。

模式 `3` 与 `4` 在主图层上使用一个懒创建的 `Sprite2DCustomShader`。给定采样的图集纹素、逐粒子色调与图层不透明度，其精确着色器主体为：

```wgsl
let sampled = textureSample(atlasTex, atlasSamp, in.uv);
let baseColor = sampled * in.tint * L.opacityMul;
let sourceAlpha = sampled.a * in.tint.a * L.opacityMul.a;
return vec4f(baseColor.rgb * sourceAlpha + vec3f(1.0) * (1.0 - sourceAlpha), baseColor.a);
```

alpha 到白色的插值变换使透明纹素在目标颜色乘法混合下呈中性。它与公告板公式匹配，同时使用 Sprite2D 作用域内的 `L.opacityMul`。模式 `4` 的第二个图层没有自定义着色器，因此使用标准 Sprite2D 片元，包含相同的色调与不透明度语义。模块状态仅为 `let _multiplyShader = null`；着色器描述符及其缓存在首次创建高级 Multiply 桥接时分配，自定义着色器钩子注册也通过该显式调用发生。

`syncParticleSprite2DBridgeWithBlendModes(bridge)` 在写入任何通道前先校验这一份逻辑映射以及每个通道图层的独占所有权。它无分配地将 `pixelsPerUnit`、两个 `originPx` 分量以及 `invertY` 拷贝到内部各通道桥接中。主 `layer` 是可变展示状态的权威来源：不透明度、可见性、顺序、视图位置/缩放/旋转与轴心会在同步前拷贝到次级图层。随后对每个通道调用一次基础紧凑同步器。因此模式 `4` 仅复制图层实例存储/上传，而不复制模拟：两个通道包含逐字节等价的粒子实例以及当前映射值。

手动调用方将 `bridge.layers` 中的每一项按数组顺序添加到同一个渲染器，并在每次高级同步前精确调用一次 `animateParticleSystem`。`registerNodeParticleSet2DWithBlendModes(renderer, set, options = {})` 提供了该托管策略：

1. 在修改渲染器前先创建并初始同步所有逻辑桥接。
2. 按系统顺序和通道顺序挂接所有通道图层。任何失败都会按对象标识移除本次新增的所有通道图层，包括在管线创建抛出异常前一刻刚压入的图层。
3. 当 `autoStart = options.autoStart ?? true` 时启动每个系统一次。
4. 为整个集合安装一个渲染器钩子。在每次渲染器更新时计算常规帧比例，随后精确模拟每个系统一次并同步该系统的所有通道图层。

`NodeParticleSet2DBlendModesBinding` 拥有该钩子与全部通道图层挂接。`disposeNodeParticleSet2DBlendModesBinding` 具有幂等性，且渲染器销毁会自动调用它。销毁会移除所有图层与回调，但不会停止系统或销毁粒子纹理。出于与基础桥接相同的独占存活区间原因，禁止在任何桥接持有的通道图层上使用可选的 Handle API。

### 10.6 Sprite2D 桥接同步

`syncParticleSprite2DBridge(bridge)` 独占图层完整的存活范围。该图层不能包含独立的 Index API 精灵，且函数拒绝已通过可选 Handle API 安装钩子的图层。

对于 `[0, system.buffer.alive)`，同步逻辑解析精灵表帧并直接将位置、尺寸、UV 边界、旋转与 RGBA 写入现有的 `depth: "none"` 13 浮点数实例布局。同时将宽度与高度写入图层的保存尺寸侧缓冲区。不存在任何按粒子对象、元组或其他临时分配。

紧凑循环结束后，同步逻辑清除陈旧尾部 `[alive, previousCount)` 的保存尺寸条目，更新一次图层计数，并至多标记一个脏范围：`[0, max(previousCount, alive))`。这使得增长和收缩都能在不调用公共逐精灵修改 API 的情况下对下一次渲染器上传可见。无效的精灵表单元格保留共享的 `resolveSpriteFrame` 越界错误。

由于映射字段是可变的，每次同步在触及紧凑范围前都会重新校验 `pixelsPerUnit` 与 `originPx`。这支持在帧间移动原点或修改缩放比例，同时拒绝非有限状态。

### 10.7 SpriteRenderer 注册与生命周期

手动调用方创建桥接，将 `bridge.layer` 添加到 `SpriteRenderer`，并自行决定何时调用 `animateParticleSystem` 与 `syncParticleSprite2DBridge`。`registerNodeParticleSet2D(renderer, set, options = {})` 提供托管路径：

1. 在修改渲染器前先创建并初始同步每个桥接。
2. 保留 `set.systems` 顺序为每个系统挂接一个桥接持有的图层。若任意挂接抛出异常，在重新抛出前先移除本次调用已挂接的所有图层。
3. 当 `autoStart = options.autoStart ?? true` 时启动所有系统。
4. 为整个集合追加一个渲染器更新前钩子。它计算 `ratio = deltaMs > 0 ? deltaMs / (1000 / 60) : 1`，随后按序模拟并同步每个桥接。

创建与初始同步相对于渲染器成员关系具有事务性：任一系统缺少纹理、映射无效或精灵帧无效都会使渲染器保持原样、不挂接任何桥接图层且不启动任何系统。与公告板场景注册不同，返回的图层在函数返回前就已经完成同步。

返回的 `NodeParticleSet2DBinding` 拥有更新钩子、渲染器挂接以及桥接创建的图层。其 `bridges` 数组为只读，`active` 标志为可变状态并在销毁时设为 `false`。`disposeNodeParticleSet2DBinding(binding)` 具有幂等性：它移除钩子、渲染器销毁回调以及所有桥接图层。销毁渲染器会自动触发相同的销毁逻辑。粒子系统、其模拟状态及其纹理仍由调用方拥有；绑定销毁不会停止系统或销毁纹理。

## 11. 错误与失败行为

实现保留以下显式错误：

- 解析器：`NodeParticle: invalid source — expected a \`blocks\` array`。
- 解析器：`NodeParticle: block missing numeric id (name=<stringified name>)`。
- 解析器：`NodeParticle: graph has no SystemBlock`。
- 对未规范化的可达 TeleportOut 直接调用构建器：`NodeParticle: unsupported value block "ParticleTeleportOutBlock"`。
- Teleport 端点值：`NodeParticle: ParticleTeleportOutBlock <outId> has invalid entryPoint`。
- 缺失 Teleport 端点：`NodeParticle: ParticleTeleportOutBlock <outId> references missing entryPoint <entryId>`。
- Teleport 端点类错误：`NodeParticle: ParticleTeleportOutBlock <outId> entryPoint <entryId> is not ParticleTeleportInBlock`。
- 未连接的 Teleport 输入：`NodeParticle: ParticleTeleportInBlock <id> input is not connected`。
- 未连接的 Elbow、Debug 或 LocalVariable 输入：`NodeParticle: <ClassName> <id> input is not connected`。
- 布线输出不匹配：`NodeParticle: <ClassName> <id> does not expose output "<name>"`。
- Debug 或 LocalVariable 承载粒子流/系统流、纹理或梯度元数据：`NodeParticle: <ClassName> <id> does not support <role> connections`。
- 混合代理路由环路：`NodeParticle: graph plumbing cycle <id> -> ... -> <id>`。
- 位于包含系统比特域上的 Particle LocalVariable：`NodeParticle: ParticleLocalVariableBlock <id> Particle scope requires particle-only evaluation`。
- 不支持的 LocalVariable 运行时值：`NodeParticle: ParticleLocalVariableBlock <id> received an unsupported value`。
- LocalVariable 运行时形状变更：`NodeParticle: ParticleLocalVariableBlock <id> changed value type`。
- 代码片段 HTTP 响应：`NodeParticle: snippet fetch failed (<status>)`。
- 未安装读取器的已连接值：`NodeParticle: unresolved connection <ClassName>.<inputName>`。
- 不支持的世界形状：`NodeParticle: unsupported emitter block "<ClassName>"`。
- 不支持的局部形状：`NodeParticle: unsupported local shape "<ClassName>"`。
- 以 `Particle` 开头的不支持名称：`NodeParticle: unsupported value block "<ClassName>"`。
- 路由至基础注册表的其他不支持名称：`NodeParticle: unsupported Basic Properties block "<ClassName>"`。
- 不支持的直接变体加载请求：`NodeParticle: unsupported block variant "<ClassName>"`。
- 不支持的上下文源：`NodeParticle: unsupported contextual source 0x<lowercase hex>`。
- 不支持的系统源：`NodeParticle: unsupported system source <decimal id>`。
- 无效的局部源使用：`NodeParticle: LocalPositionUpdated requires SystemBlock.isLocal`。
- 无效的局部源时机或被回收槽位：`NodeParticle: LocalPositionUpdated read before local shape position creation`。
- 无效的发射器提供方返回值：`NodeParticle: emitter provider must return a finite 16-element matrix`。
- 缺少 setup 的精灵更新：`NodeParticle: BasicSpriteUpdateBlock requires SetupSpriteSheetBlock`。
- 无纹理时创建公告板：`createParticleBillboard: the particle system has no texture`。
- 无纹理时创建 Sprite2D 桥接：`createParticleSprite2DBridge: the particle system has no texture`。
- 创建时 Sprite2D 比例无效：`createParticleSprite2DBridge: pixelsPerUnit must be a positive finite number, got <value>`。
- 创建时 Sprite2D 原点无效：`createParticleSprite2DBridge: originPx must be finite, got [<x>, <y>]`。
- 同步时可变 Sprite2D 比例无效：`syncParticleSprite2DBridge: pixelsPerUnit must be a positive finite number, got <value>`。
- 同步时可变 Sprite2D 原点无效：`syncParticleSprite2DBridge: originPx must be finite, got [<x>, <y>]`。
- 在桥接持有的图层上安装了 Handle API：`syncParticleSprite2DBridge: the bridge-owned layer cannot use the Sprite2D Handle API`。
- 精确桥接创建将纹理与初始映射校验委托给基础工厂，因此保留其 `createParticleSprite2DBridge` 错误字符串。
- 同步时可变精确桥接比例无效：`syncParticleSprite2DBridgeWithBlendModes: pixelsPerUnit must be a positive finite number, got <value>`。
- 同步时可变精确桥接原点无效：`syncParticleSprite2DBridgeWithBlendModes: originPx must be finite, got [<x>, <y>]`。
- 在任意精确桥接通道图层上安装了 Handle API：`syncParticleSprite2DBridgeWithBlendModes: bridge-owned layers cannot use the Sprite2D Handle API`。
- 同步时无效精灵帧：`resolveSpriteFrame: index <frame> out of range [0, <frameCount>)`。

还可观察到以下附加行为：

- `normalizeNodeParticleGraph` 在构建器运行前报告畸形的可达 Phase 3 路由与无效的 LocalVariable 域。代码片段 API 自动调用它；直接调用方仅在按需启用后才会看到这些诊断。省略直接规范化会使编译消除类保持不受支持状态，并绕过 LocalVariable 角色/域校验。
- 悬空的目标块 id 会被标记为已构建并跳过。仅当消费方请求其缺失的读取器时才会失败；纯流边可能保持静默。
- 游离的不支持块因不可达而被忽略。
- 可达求值器或注册表模块的动态导入失败会从异步构建中传播出来。
- `NodeParticleEmitterProvider` 抛出的异常在辅助函数创建、默认便捷构建或模拟中均原样传播。结构无效或非有限的结果会在修改任何稳定矩阵、平移、逆矩阵或模拟字段之前抛出显式提供方错误。下一帧的有效采样仍可正常继续。
- 缺失网格位置或索引会静默使系统不安装网格创建槽位。畸形或空数组可能在创建期间产生 `undefined`、`NaN`、越界访问或原生错误。
- 粒子纹理拉取、解码与上传失败在 `ParticleTextureSourceBlock` 内部被捕获；构建会以 `texture` 未改动的状态正常完成。若未分配其他纹理，随后会在公告板或 Sprite2D 桥接创建时失败。
- `registerNodeParticleSet2D` 在挂接前创建并同步所有桥接。创建或同步失败使渲染器成员关系保持不变；挂接失败会移除本次调用已挂接的图层然后继续传播异常。
- `registerNodeParticleSet2DWithBlendModes` 跨越所有系统与通道图层提供相同的事务性保障。当某个图层的管线创建抛出异常时，它会移除刚压入的图层，然后移除同一调用中之前的所有通道图层。
- 流场贴图拉取或 CPU 解码失败在 `UpdateFlowMapBlock` 内部被捕获；构建完成且该块不施加任何力。
- 噪声纹理拉取或 CPU 解码失败在 `UpdateNoiseBlock` 内部被捕获；构建完成、不施加任何力且不消耗任何坐标随机数。
- 无效的相对 URL 解析可能从 `new URL` 同步抛出异常。
- 无效 JSON、畸形代码片段载荷、无效类型化数组长度以及错误运行时值形状会触发原生 JavaScript 错误或类型化数组强制转换。
- 容量耗尽会丢弃该次模拟调用中从首次失败生成起的所有剩余创建请求。发射结余与模拟时间不会回滚。
- 数值字段不检查有限性、符号、整数范围或图值类型兼容性。
- 零生命周期在颜色步长创建中产生除零结果。精灵更新中的零生命周期产生 JavaScript 取余/除法结果及 Uint16 强制转换。
- `_nextId` 是无界 JavaScript 数字，而存储的粒子与缓存 id 为 Uint32 值，因此存储的 id 会在 Uint32 赋值时发生回绕。

## 12. 当前限制

- 解析器可以表示任意序列化类名。构建器直接支持 29 个普通类，并在必需的规范化边界之后支持五个 Phase 3 类，规范化后共计 34 个受支持类。其他可达的 NPE 类遵循第 11 节的注册表错误。
- 模拟仅支持 CPU。
- 渲染目标由调用方显式选择：面向相机的公告板或纯 2D Sprite2D。序列化的 `billBoardMode` 与 `isBillboardBased` 均不选择运行时路径。
- Sprite2D 桥接仅映射 NPE 世界 XY。它忽略 `posZ`，不支持 XZ/YZ 投影。
- 精确粒子混合因子与专用的 Multiply/MultiplyAdd 输出需按渲染目标显式启用。公告板需要 `buildNodeParticleSetWithBlendModes` 或 `enableNodeParticleBlendModes`；Sprite2D 需要 `createParticleSprite2DBridgeWithBlendModes` 或 `registerNodeParticleSet2DWithBlendModes`，且可搭配任意构建器生成的集合使用。
- 普通公告板路径将模式 `0` 映射为 OneOne，模式 `1` 映射为 alpha，模式 `2`、`3`、`4` 及未知值映射为 Add。基础 Sprite2D 桥接器独立地将模式 `0` 映射为 `spriteBlendOneOne`，模式 `1` 映射为 `spriteBlendAlpha`，其余所有值映射为 `spriteBlendAdditive`。这些回退契约对未按需启用的调用方刻意保持不变。
- 系统源 4 以及 1、2、3 之外的所有系统源均不受支持。
- 自定义发射函数、子发射器触发器与继承发射器速度没有受支持的块求值器。
- `ParticleTextureSource` 支持序列化的静态 URL/data-URL 像素。Babylon 的实时 `sourceTexture`（包括 `NoiseProceduralTexture` 刷新）不会重建，因为它是内存对象，不会序列化进 NPE 图 JSON 中。
- 发射能量（emit power）缩放所创建的方向；恰好为零时会将其清零。不叠加继承速度项。
- 网格发射仅读取 `cachedVertexData`；忽略网格 `worldSpace`，且不对网格数据做结构校验。
- 可渲染的粒子系统需要成功加载或手动赋值的纹理。两个渲染目标均无无纹理回退。
- 局部位置积分仅在根设有 `isLocal === true` 的系统上通过源 `0x0018` 可用。
- 公告板场景注册不提供注销句柄，且当已停止系统排空时不会将 `_started` 设为 false。Sprite2D 渲染器注册返回可幂等销毁的绑定，但同样不会停止调用方持有的系统。
- 模拟结构在每次索引步进时不分配内存。实时发射器刷新拷贝到稳定的矩阵/向量/逆矩阵存储中，同样每次调用零分配。公告板同步分配临时值；Sprite2D 桥接同步在每粒子与每次更新时均零分配。

## 13. 验证契约

### 13.1 确定性状态测试

真值状态测试通过解析器与构建器构建系统，在异步构建完成后安装如下生成器，启动系统，并按固件步数调用 `animateParticleSystem(system, 1)`：

```ts
let seed = 1;
Math.random = () => {
    const value = Math.sin(seed++) * 10000;
    return value - Math.floor(value);
};
```

快照按粒子 id 对存活槽位排序。场景 262 标准状态测试使用容差 `1e-6`；其余标准、发射器、精灵、Basic Properties 与 Change 状态测试套对数值粒子字段使用 `1e-4`。id 顺序必须精确一致，对于因真值进程分配进程全局 id 而产生的恒定 id 偏移则允许存在。精灵 `cellIndex` 必须精确相等。

当前单元测试类别包括：

- 缓冲区与生命周期：仅基础列分配、字符串键列共享、稠密生成/交换移除、容量、发射、积分、死亡钳位以及精灵列数学。
- 构建行为：内联 JSON、根可达性、游离块隔离、双字段连接判据、动态发射率惰性求值、系统时间重求值、针对序列化器不可达的手工输入刻意保持 URL 优于 data 的优先级，以及默认路径内嵌纹理上传对显式 false 的映射与省略 `invertY` 时使用 Lite 类默认值。
- 标准图状态：场景 262、263、264 与 276；完整 Basic Properties；Size；Sphere；以及确定性/随机起始精灵变体。
- 变化图：Size、Color、Speed、Angular Speed、多停靠点 Angular Speed、Drag、Emit Rate、Lifetime、Start Size 与 Speed Limit。
- 发射器：Point、Box、Sphere、定向 Sphere、Hemisphere、Cone、定向 Cone、Cylinder、定向 Cylinder、Mesh、旋转 Cylinder、全部六种变换后局部形状、网格顶点色、网格 InitialDirection、共享易变边界以及局部源构建/读取守卫。
- 移动发射器：平移与旋转提供方快照、新返回矩阵与原地修改、静态选项优先级与不可变性、世界诞生、全部六种世界/局部形状路径、`LocalPositionUpdated`、上下文 Emitter、同一系统内所有隐式 Cylinder 逆矩阵、所有构建器家族、Parse 选项保留、未启动与停止但已启动调用、多系统独立采样、包装选项复用隔离，以及提供方异常/无效结果在矩阵、平移、逆矩阵与粒子状态间的原子性。
- 值正确性：共享暂存区 Math、Lerp/Gradient 端点、Random min/max 别名、锁定模式、Uint32 id 边界情况以及受容量限制的 OncePerParticle 缓存。
- 吸引子：软化平方反比吸引、负强度排斥、默认值、重合点处理、按生命周期钳位的步长缩放以及懒求值器隔离。
- 流场贴图：包括非零行跨距在内的投影最近邻采样、垂直屏幕映射、RGBA 力解码、alpha 与边界处理、逐粒子强度求值、按生命周期钳位步长缩放、由分配器选定的 F32/F64 矩阵快照以及懒纹理/求值器隔离。
- 噪声纹理：精确的三采样红通道寻址、六个确定性 Float64 随机坐标、坐标复用与槽位回收、Vector3 默认值/强度、按生命周期钳位步长缩放、提取失败、包括普通/CPU 内嵌纹理扇出在内的已解析图布线、Babylon 多步状态固件以及懒运行时隔离。
- 图布线：直接未规范化遗漏失败与显式成功；解析器无元数据；仅含 TeleportIn 时辅助函数原样返回；无候选图原样引用返回与游离畸形共享存储路径；Teleport 与 Elbow 跨标量、Vector2、Vector3、Color4、梯度、粒子/系统流与纹理角色的路由；Debug 仅值路由；双比特共享域重访问；消费方边优先诊断优先级；专用纹理求值器覆盖；端点 id `0`；畸形端点；后定义胜出行为；混合环路；写时复制同一性、幂等性与原始源不可变性；所有构建器家族；自动内联/远程代码片段；无 Teleport/Elbow/Debug 求值器主体；以及轻量/运行时 chunk/模块隔离。
- LocalVariable 状态：精确的形状判别与畸形优先判别；标量/Vector2/Vector3/Color4 易变暂存快照；精确的 37 字节 Particle 槽位分配；id `0`；A-B-A、双粒子、交换移除、尾部复用与失败原子性；对 Particle 系统/共享域的拒绝；Loop 未启动/零比例/停止/重启 epoch；动态发射率/更新/诞生共享；多块；独立系统/构建；提供方顺序与错误；以及无 Loop 容量列。
- 特性隔离：运行时 chunk 清单以及当 bundle-info 存在时的已拉取模块内容。
- 基础 Sprite2D 桥接：纹理与映射校验、精确 XY/+Y 转换、包括模式 `3`/`4`/未知值加法回退在内的混合映射、精灵表映射及其越界单元格错误、Handle API 所有权拒绝、全范围紧凑同步、陈旧保存尺寸清理、单次脏更新、事务性多系统注册、自动启动控制、幂等销毁与渲染器销毁清理。
- 精确 Sprite2D 混合桥接：模式 0 到 4 及默认值的描述符、模式 3 自定义着色器结构与不透明度公式、模式 4 `[Multiply, Add]` 图层与稳定顺序、每系统/每更新一次模拟、在可变映射/展示状态下的逐字节等价通道同步、所有通道的 Handle 所有权拒绝、事务性创建/挂接回滚、手动与渲染器销毁以及基础路径隔离。
- 公共声明：`normalizeNodeParticleGraph` 存在且具有可表示的 `ParticleGraph` Promise 签名；其运行时函数与标记不存在；已移除的构建后提供方 API 不存在；两个构建时提供方辅助函数均存在；泛型选项交叉保留扩展构建器选项；`_setupEmitter`、Loop epoch 以及提供方内部成员均从输出的包声明中裁剪。
- 路径所有权：`particle/soa` 源码目录与 `particle-soa*.test.ts` 单元测试名不得存在。TypeScript 编译校验所有源码与测试导入。

Loop 真值分离是有意为之的：确定性 Lite 测试拥有手动已启动调用语义的归属权。不声称有任何 Babylon 固件能证明该边界。

### 13.2 真值固件生成流程

获取可复现的 Babylon.js 等价数据步骤如下：

1. 在已加载 NPE 块注册的前提下构造目标 CPU 粒子系统，并使用 `ConvertToNodeParticleSystemSetAsync` 进行转换。
2. 调用 `buildAsync(scene)` 使序列化包含所有挂载的块。
3. 序列化节点粒子集，并仅规范化 Lite 固件所需的外部纹理 URL。
4. 将真值系统的 scene 引用置为 null，使每次显式模拟调用使用比例 1 且不受场景帧 id 抑制。
5. 构建后安装同一个带种子的随机生成器。
6. 运行精确的固件步数。
7. 记录 id、position、direction、color、size、scale、angle、age、lifetime 以及适用时的 sprite cell。

请使用转换路径来提取图。真值参照的直接解析路径不能保留这些固件所需的全部 Color4 输入。在此流程中 Babylon.js 仅用作兼容性真值参照。

移动发射器固件还会在每次显式模拟调用前立即设置真值发射器的平移/旋转时间表，强制更新其世界矩阵，并将该矩阵连同得到的粒子状态一并记录。Lite 使用提供方包装选项构建，并在每次对应调用前返回记录的矩阵以重放同一时间表。固件包含足以区分当前平移、左上 3x3 方向变换、局部位置重投影以及依赖逆矩阵的 Cylinder 方向的平移与旋转变化。

未来的有限 Loop LocalVariable 真值参照将是此手动流程的明确例外。它不得将 Babylon 的 scene 置空，也不得在同一个未变化的场景帧内反复调用粒子动画：在 Loop 作用域下访问 null 场景会抛出异常，而未变化的帧 id 会抑制新快照。它可以每步调用一次 `scene.render()` 并观察每次渲染一次兼容的首次读取，但该序列不能作为 Lite“单次已启动 `animateParticleSystem` 调用”边界的真值参照。当前实现既不要求也不声称存在此类固件。

### 13.3 视觉场景

十个冻结的公告板真值参照 Lite 场景在构建后播种、同步一个公告板并注册冻结场景。场景 262 至 281 与场景 305 使用黑色清屏色；场景 283 与 284 使用第 13.5 节指定的暖色调目标颜色。场景 262、263、264、276、277 与 305 运行 200 个比例为 1 的步长。场景 280 运行 300 步，场景 281 运行 240 步，场景 283 运行 40 步，场景 284 运行 20 步。场景 280 的 Babylon 参考页在手动步进前会调用 `scene.updateTransformMatrix(true)`，因为 Babylon 的 UpdateFlowMap 会在首帧渲染前读取场景变换矩阵。场景 302 是第十一个公告板真值参照，并增加了默认实时模式与确定性冻结查询模式。

| 场景                                  | 覆盖范围                                                                      | 相机                                                          | MAD 上限 | 原始体积上限 |
| ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | -------- | ------------ |
| 262 `scene262-npe-size`               | Basic Properties - Size, Box                                                  | alpha `-pi/2`, beta `1.2`, radius `4`, target `(0,0.3,0)`     | `0.01`   | `44.1 KB`    |
| 263 `scene263-npe-sphere`             | Sphere 发射器                                                                 | alpha `-pi/2`, beta `1.2`, radius `14`, target 原点           | `0.01`   | `44.1 KB`    |
| 264 `scene264-npe-change-size`        | Gradient, GradientValue, UpdateSize                                           | alpha `-pi/2`, beta `1.2`, radius `12`, target `(0,0.7,0)`    | `0.01`   | `44.1 KB`    |
| 276 `scene276-npe-animations`         | 确定性精灵表，单元格 0 到 9，64×64 像素单元格，速度 30                        | alpha `-pi/2`, beta `1.2`, radius `4`, target `(-1,0,0)`      | `0.01`   | `45.0 KB`    |
| 277 `scene277-npe-attractor`          | 位置积分后的 UpdateAttractor，吸引子 `(0,2,0)`，强度 `8`                      | alpha `-pi/2`, beta `1.2`, radius `5`, target `(0,0.8,0)`     | `0.01`   | `45.0 KB`    |
| 280 `scene280-npe-flow-map`           | 积分后的 UpdateFlowMap，翻转排斥贴图，强度 `15`，尺寸 `0.6`                   | alpha `pi/2`, beta `pi/2`, radius `9`, target `(-5,0,0)`      | `0.01`   | `45.0 KB`    |
| 281 `scene281-npe-noise-texture`      | 积分后的 UpdateNoise，缓存的 8×8 噪声，强度 `(1.5,0.5,1.5)`                   | alpha `-pi/2`, beta `1.2`, radius `11`, target `(0,1,0)`      | `0.01`   | `45.0 KB`    |
| 283 `scene283-npe-multiply-blend`     | 暖色背景上使用程序化径向 alpha 的 Multiply 混合                               | alpha `-pi/2`, beta `pi/2`, radius `12`, target 原点          | `0.01`   | `45.0 KB`    |
| 284 `scene284-npe-multiply-add-blend` | 稀疏程序化径向 alpha 场上的 MultiplyAdd 混合                                  | alpha `-pi/2`, beta `pi/2`, radius `12`, target 原点          | `0.01`   | `45.0 KB`    |
| 302 `scene302-npe-moving-emitter`     | 局部 Point，移动提供方，`LocalPositionUpdated`，实时/冻结模式                 | alpha `-pi/2`, beta `1.2`, radius `8.5`, target `(0,0.35,0)`  | `0.01`   | `61.5 KB`    |
| 305 `scene305-npe-teleport`           | Teleport/Elbow/Debug 路由外加 Particle LocalVariable 尺寸快照                 | alpha `-pi/2`, beta `1.2`, radius `4`, target `(0,0.3,0)`     | `0.01`   | `45.0 KB`    |

每个相机使用近裁剪面 `0.1` 与远裁剪面 `100`。十个始终冻结的场景在引擎启动后同时将 `canvas.dataset.animationFrozen` 与 `canvas.dataset.ready` 设为 `"true"`。场景 302 在两种模式下都设置 `ready`，并仅在传入有限非负 `seekTime` 时才设置 `animationFrozen`。

每个一致性 spec 都会等待其确定性的就绪/冻结标志，留出短暂 GPU 稳定时间后对画布截图，并与 `reference/lite/<scene-slug>/babylon-ref-golden.png` 对比整图 MAD。spec 262、263、264、277、280、281、283、284 与 305 在打开 Lite 页面前会调用共享的基准图捕获辅助函数；spec 276 与 302 则直接读取已提交的基准图。场景 302 的一致性测试绝不能在运行时导航至其 Babylon.js 页面。通过标准源自 `scene-config.json`，所有十一个场景均为 `MAD <= 0.01`。

场景 305 遵循运行时捕获组，而非场景 302 的手动仅提交基准图约定。它是一个冻结且不可交互的固件：其 Lite 相机刻意不导入也不挂接任何控制，因为 Babylon.js 真值参照同样未挂接相机控制。这并不为其他 NPE 场景确立相机策略。其共享图保留了 Teleport 扇出，并在仅创建阶段的随机尺寸路径上加入了 Elbow、Debug 与 Particle LocalVariable。包装后的值、随机数消耗以及 200 步状态完全不变；针对性非视觉测试验证其完整状态与场景 262 精确一致。未使用任何 Loop 块。本地不修改现有的基准图与缩略图；视觉一致性由 CI 负责。

场景 300（`scene300-npe-sprite2d`）是一个独立的确定性 Lite 原生集成固件。它以带种子的比例 1 步长推进一个手写 NPE 图 200 步，冻结模拟，通过 `registerNodeParticleSet2D` 注册集合，并让渲染器钩子持续采样稳定的紧凑图层。`scene-config.json` 将其标记为 `skipParity: true`，因为 Babylon.js 没有等价的纯 2D SpriteRenderer 路径。其 Playwright spec 验证激活的绑定状态、实时采样、粒子数与图层数相等、冻结的粒子年龄、单渲染器图层、绘制调用以及可见光斑像素；它不使用 Babylon 基准图或 MAD 对比。该固件使用双单元格 128×64 图集。确定性的槽位 0 被隔离为位于画布坐标 `(96,96)`、使用单元格 1 的未旋转 64 px 标记精灵；上下标记带对比断言用于检测垂直纹理或 UV 翻转。`demo-npe-sprite2d` 是其可交互对应页面，通过指针/触摸输入修改桥接原点，同时渲染器托管的模拟保持实时运行。

场景 301（`scene301-npe-sprite2d-blend-modes`）是确定性的 Lite 原生精确混合集成固件。它在来自场景 283/284 的暖色目标背景之上，使用相同的程序化径向 alpha 纹理与色调并排渲染一个模式 3 粒子与一个模式 4 粒子。它通过普通 `buildNodeParticleSet` 构建两个系统，合并其可变系统数组，并通过 `registerNodeParticleSet2DWithBlendModes` 注册；公告板启用器不参与其中。图层不透明度为 `0.75`，使精确中心像素方程可直接观测：

```text
multiplySource = tint.rgb * 0.75 + white * 0.25
multiplyResult = destination.rgb * multiplySource
multiplyAddResult = multiplyResult + tint.rgb * 0.75
```

`scene-config.json` 因 Babylon.js 无纯 2D 渲染器而将场景 301 标记为 `skipParity: true`。其针对性 Playwright 测试检查就绪/冻结状态、Multiply 的单图层、MultiplyAdd 的有序双 `[p4, p2]` 图层、三个渲染器图层/绘制调用、对照上述方程的两个中心像素以及未改变背景的透明边缘像素。它没有 Babylon 参考页，也没有 PNG 基准图。其画廊缩略图是从 Lite 固件截取的精确 1280×720 JPG。

场景 302（`scene302-npe-moving-emitter`）是 Phase 2 移动发射器视觉与打包固件。两个引擎解析同一份紧凑共享图，包含一个 `isLocal` SystemBlock、PointShapeBlock、UpdatePositionBlock 以及上下文 `LocalPositionUpdated` 源 `0x18`。它们使用相同的生成 64×64 最近邻过滤径向 RGBA 纹理、相机、清屏色、带种子生成器、60 Hz 步长计数以及循环的 XYZ 平移加 Z 旋转姿态函数。该图不含外部纹理或网络资产。

默认 Lite URL 持续实时运行。稳定矩阵由 `NodeParticleEmitterProvider` 原地修改，集合通过 `buildNodeParticleSet(..., withNodeParticleEmitterProvider(provider, options))` 构建。`registerNodeParticleSet` 负责自动启动、逐帧模拟与普通 3D 公告板同步。相机控制保持挂接。遥测数据发布发射器 X/Y/Z、Z 角度、提供方调用次数、活跃粒子数、绘制调用数、就绪状态与错误。实时 Playwright 测试采样两帧，要求 X/Y 遥测为有限数、角度与提供方调用次数发生变化、活跃粒子数非零、且画布像素非空白并发生变化；不打开 Babylon.js。X/Y 不采用严格逐轴不等式，因为任一正弦曲线在浮点舍入后可能在极值处重复。

任意有限非负 `?seekTime=T` 会选中确定性冻结模式。两个引擎安装相同的带种子生成器，应用初始姿态，并在对应显式模拟调用前立即为步数 `1...round(T * 60)` 重放姿态。对于已提交的捕获 `T=2`，这精确对应 120 次调用。Lite 手动调用 `animateParticleSystem(system, 1)`，将 `updateSpeed = 0`，让提供方返回最终稳定矩阵，并以 `autoStart: false` 注册。Babylon.js 在 `buildAsync` 之前将一个隐藏的具体 `AbstractMesh` 发射器赋值给 `set.systemBlocks[0].emitter`，更新其位置与 `rotation.z`，强制调用 `computeWorldMatrix(true)`，并调用真实的 `ParticleSystem.animate(true)` 路径。因此其原生更新会刷新 `_emitterWorldMatrix`；没有任何粒子位置是手动模拟的。仅在 seek 模式下两个页面才会标记 `data-animation-frozen="true"`。

Babylon.js 页面仅作为手动基准图真值参照。已提交的 `reference/lite/scene302-npe-moving-emitter/babylon-ref-golden.png` 从 `babylon-ref-scene302.html?seekTime=2` 一次性捕获；自动化冻结测试仅加载 `scene302.html?seekTime=2`，校验遥测并将生成的画布与该基准图对比。初始上限为 `MAD <= 0.01`；调整它需要实测一致性证据与审批。场景 302 本身不增加任何包 API。Phase 3C 不增加包根 API：公共导出计数仍保持二十五个函数与十二个类型，当前粒子实现计数为 11 个根文件、29 个节点基础设施/注册表文件以及 47 个求值器/辅助函数文件。

### 13.4 打包清单与条件内容

打包输出与按场景清单均为生成产物且已被忽略。在冲突驱动的上游集成与重新编号之前，一次过滤构建精确生成了场景 262、263、264、276、277、280、281、283、284、302 以及如今编号为 305 的 NPE 图布线固件。在已评审的 Phase 3B 检查点 `37ac466e93b2842337248901955c4fc4b195096e` 上进行的独立同环境构建提供了如下对比总计：

| 场景  | 当前原始大小 | 当前 gzip  | Phase 3B 原始大小 | Phase 3B gzip | 原始增量   | gzip 增量  | 忽略的图载荷原始大小 | 上限      |
| ----- | -----------: | ---------: | ----------------: | ------------: | ---------: | ---------: | -------------------: | --------: |
| 262   |   `40,849 B` | `24,745 B` |        `40,849 B` |    `24,745 B` |      `0 B` |      `0 B` |           `29,222 B` | `44.1 KB` |
| 263   |   `42,984 B` | `25,359 B` |        `42,984 B` |    `25,357 B` |      `0 B` |     `+2 B` |           `28,166 B` | `44.1 KB` |
| 264   |   `41,074 B` | `26,599 B` |        `41,074 B` |    `26,596 B` |      `0 B` |     `+3 B` |           `35,205 B` | `44.1 KB` |
| 276   |   `45,241 B` | `25,905 B` |        `45,241 B` |    `25,903 B` |      `0 B` |     `+2 B` |           `27,796 B` | `45.0 KB` |
| 277   |   `42,734 B` | `25,930 B` |        `42,734 B` |    `25,926 B` |      `0 B` |     `+4 B` |           `30,538 B` | `45.0 KB` |
| 280   |   `42,466 B` | `26,560 B` |        `42,466 B` |    `26,556 B` |      `0 B` |     `+4 B` |           `31,697 B` | `45.0 KB` |
| 281   |   `42,405 B` | `26,751 B` |        `42,405 B` |    `26,745 B` |      `0 B` |     `+6 B` |           `32,909 B` | `45.0 KB` |
| 283   |   `42,563 B` | `24,727 B` |        `42,563 B` |    `24,725 B` |      `0 B` |     `+2 B` |           `29,326 B` | `45.0 KB` |
| 284   |   `42,426 B` | `24,672 B` |        `42,426 B` |    `24,669 B` |      `0 B` |     `+3 B` |           `29,326 B` | `45.0 KB` |
| 302   |   `56,705 B` | `22,761 B` |        `56,683 B` |    `22,761 B` |    `+22 B` |      `0 B` |                `0 B` | `61.5 KB` |
| 305   |   `44,827 B` | `27,356 B` |        `41,012 B` |    `25,906 B` | `+3,815 B` | `+1,450 B` |           `32,250 B` | `45.0 KB` |

场景 262、263、264、276、277、280、281、283 和 284 与 Phase 3B 保持原始字节完全一致，且既不拉取图布线模块也不拉取 LocalVariable 求值器。场景 302 原始字节增加了 `22` 字节，仍低于上限，gzip 字节完全相同，且不拉取任何图/局部模块。其拉取的提供方、粒子系统与构建器运行时源码相对 Phase 3B 没有任何改动；唯一的共享源码差异是一个在编译后被擦除的内部构建状态类型字段。因此原始字节变动属于构建全局错误码/压缩器分配漂移，而非保留了 Phase 3C 行为。不会为这种附带变动添加补偿性运行时代码。同理，在其他原始字节完全一致的场景上出现 `2` 到 `6` 字节的 gzip 波动，也并不削弱运行时模块隔离判据。

场景 305 按要求拉取了轻量辅助函数、重型运行时、现有可选注册表链以及 LocalVariable 求值器。它刻意不拉取任何 `arc-rotate-controls` chunk 或模块，因为该冻结固件镜像了不可交互的 Babylon.js 真值参照。其检入的图命名为 `scene305-teleport-npe.ts`，遵循标准的 `*-npe.ts` 约定，从而使打包统计排除图载荷，而不将其计作引擎运行时代码。合并当前上游并将该固件从场景 304 迁至场景 305 后，一次针对性构建测得 `42,077` 原始字节与 `26.4 KB` gzip，距离已批准的 `45.0 KB`（`46,080` 字节）上限仍有 `4,003` 字节余量。上方的历史对比表保留了同一环境下的 Phase 3B/3C 对比，未混入无关的上游运行时体积优化。

Phase 3B 当时原始测得 `43,936` 原始字节，原因在于同一份 2,924 字节的场景 305 图载荷当时使用了非规范文件名而被计入体积。对比列同时从 Phase 3B 原始结果中减去了该载荷（`43,936 - 2,924 = 41,012`），以保持 `+3,815` 原始增量作为诚实的引擎/运行时对比。gzip 子集无法从混合 chunk 中剥离，因此实测 gzip 值保持未调整状态。

本地 `*-npe.ts` 图载荷模块从引擎运行时字节统计中排除，并记入忽略字节中。通用打包体积规范将场景 id 262、263、264、276、277、280、281、283、284、300、301、302 与 305 识别为精灵用户。其中场景 262 至 284、302 与 305 通过公告板精灵模块渲染。场景 300 要求存在 `particle-sprite-2d.ts` 与 `sprite-renderer.ts`，同时拒绝精确 Sprite2D 模块、自定义着色器路径、粒子公告板、粒子场景注册、带深度 Sprite2D 以及公告板渲染路径。场景 301 要求存在 `particle-sprite-2d-blend-modes.ts`、`particle-blend.ts`、`sprite-custom-shader.ts` 与 `sprite-renderer.ts`，同时拒绝 `particle-billboard-renderable.ts`、`particle-billboard-scene.ts` 以及场景渲染精灵路径。代表性的无关 Sprite2D 场景 50 同样拒绝所有粒子精确混合与自定义着色器模块。CI 发布的基线与生成的 bundle-info 是对比输入，不提交任何按场景清单。

场景 302 是正向的移动发射器打包固件。其拉取模块列表必须包含 `npe-emitter-provider.ts`、`invert-mat4-to-ref-or-identity.ts`、`particle-scene.ts`、`particle-billboard.ts`、`billboard-scene.ts` 与 `billboard-renderable.ts`。不得包含已删除的 `npe-live-emitter.ts`、普通分配型 `invert-mat4.ts`、流场/噪声/纹理更新运行时、CPU 纹理更新、高级粒子混合模块、任一图布线模块或任一 Sprite2D 桥接/渲染路径。最终过滤构建测得 `56,705` 原始字节（`55.4 KB`）与 `22,761` gzip 字节（`22.2 KB`）。共享固件与场景入口不符合 `*-npe.ts` 载荷排除规则而被刻意计入，因此该测量结果偏保守，不能与排除载荷的兄弟场景直接横向比较。

粒子打包内容测试将通用的未使用特性拒绝列表应用于九个标准公告板一致性场景。每个标准场景必须具有非空运行时 chunk 列表，若其拉取的 chunk 匹配未使用的变体、extra-basic、extra-emitter、extra-value、局部形状、吸引子/流场/噪声/方向/角度更新、CPU 或内嵌纹理源、带类型 once-random、随机精灵、动态发射率、可选值块、局部输入/位置或可选发射器模式，则测试失败。场景 263 允许拉取 `npe-registry-extra-emitters`（因为它使用 Sphere），场景 277 必须拉取 `update-attractor-block`，仅场景 280 允许拉取 `npe-flow-map-runtime`，仅场景 281 允许拉取 `npe-noise-runtime` 与 `embedded-texture-source-block`。打包后每个专用纹理运行时均包含其求值器、CPU 纹理解码器与共享纹理更新构建器。

当 `lab/public/bundle/bundle-info/sceneN.json` 存在时，同一测试还会仅检查已拉取运行时 chunk 中的模块。它拒绝 extra-value 与局部形状注册表、局部位置支持、动态发射率、Condition、FloatToInt、VectorLength、所有局部形状主体、场景 281 之外的 `embedded-texture-source-block` 以及 `math/invert-mat4.ts`。它要求场景 283 与 284 拉取 `particle-blend`、`npe-blend-modes`、`particle-billboard-scene` 与 `particle-billboard-renderable`（无论 Rollup 输出命名 chunk 还是折叠进场景入口），同时在所有普通粒子场景中拒绝这四个模块。当 bundle-info 缺失时跳过该模块级分支，而运行时 chunk 断言仍照常运行。

`npe-emitter-provider.ts` 属于可选内容。独立的提供方隔离检查要求场景 12 与每个已配置粒子场景具有非空运行时 chunk 列表。当 bundle-info 存在时，场景 302 必须拉取提供方模块。场景 12 及所有其他已配置粒子场景（262、263、264、276、277、280、281、283、284、300 与 301）拒绝提供方与实时发射器模块/chunk 名称。过滤打包构建与权威 Bundle Size 任务测量实际输出；生成的运行时 chunk 清单、已拉取模块检查与提供方隔离充当回归守卫，而不通过单元测试将清单字节值与重复硬编码常量比对。

Phase 3 打包守卫通过每个场景的 `runtimeChunks` 过滤生成的 bundle-info，因为 Vite 可能构建了懒加载运行时 chunk 但并未在运行时拉取它。现有标准直接场景与场景 302 同时拒绝 `npe-graph-plumbing.ts`、`npe-graph-plumbing-runtime.ts` 以及 `particle-local-variable-block.ts`；场景 305 则要求包含这三者，同时拒绝 `arc-rotate-controls`、提供方、专用纹理更新、精确混合以及 Sprite2D 模块。源码守卫同样禁止场景 305 导入或调用任何 `attachControl`。游离畸形单元测试固件证明了带标记的共享块/根存储以及构建成功，但刻意不在显式调用辅助函数之后做虚假的无导入断言。现有 lab 场景均未使用 `parseNodeParticleSetFromSnippet`，因此过滤打包列表中未新增代表性代码片段场景；内联/网络单元测试与辅助函数的动态导入源码守卫覆盖了该边界。任何 bundle 均不得包含 Teleport、Elbow 或 Debug 求值器模块，因为这些文件并不存在。

解析器、默认构建器、流场贴图运行时以及纹理更新运行时均不含任何图布线源码。轻量辅助函数仅因显式的辅助函数/代码片段导入而保留；重型运行时仅在命中候选块后通过其动态导入才可达。相对于 Phase 3B 的精确原始字节总计，全部九个标准直接图场景变动为 `0 B`，且既不拉取图布线模块也不拉取局部求值器。场景 264 与场景 276 不拉取 `npe-registry-extra-remaining`；场景 277 因 UpdateAttractor 仍拉取它，保留了 Phase 3B 的可选注册表组成。场景 305 拉取轻量辅助函数、重型运行时、可选值路由与 LocalVariable 求值器，不拉取相机控制，且在排除检入的 `*-npe.ts` 图载荷后仍比已批准的 `45.0 KB` 上限低 `4,003` 字节。

提供方实现是同步的，因为其公共选项辅助函数必须在构建器启动前安装回调。Tree-shaking 会从未使用提供方的场景中移除整个模块（包括其矩阵校验与求逆刷新依赖）。

在模块级上，场景 281 反向拒绝 `texture-source-block`，确保其专用路径绝不拉取基础纹理求值器。针对场景 50、300 与 301 的 Sprite2D 循环在两个层级上应用相同的内嵌纹理隔离：拒绝命名的 `embedded-texture-source` 运行时 chunk，并在 bundle-info 存在时拒绝已拉取的 `embedded-texture-source-block` 模块。

### 13.5 Multiply 混合一致性场景

场景 283（`scene283-npe-multiply-blend`）是专门用于粒子混合模式 `3` 的 Babylon.js/Lite 真值对比场景。两个引擎解析由场景 262 派生并做如下修改的同一份图：

- `SystemBlock.blendMode = 3`，容量 `64`，更新速度 `0.05`，发射率 `8`。
- 发射能量与方向均为零，使粒子停留在其创建位置。
- 发射盒为 `[-3, -1.65, 0]` 到 `[3, 1.65, 0]`。配合三倍的相机半径，这保持了场在屏幕空间中的范围，同时将每个精灵的投影尺寸缩小到三分之一并限制重叠的 Multiply 遍数。
- 生命周期固定为 `10`，尺寸固定为 `0.8`，创建/死亡颜色固定为 `[0.3, 0.8, 0.45, 1]`。
- 两个引擎创建同一张 32×32 最近邻过滤的程序化 RGBA 纹理。RGB 为纯白；alpha 具有完全不透明的径向核心，经由确定性 8 位值渐变，且在外围纹素处为零。这无需网络或解码器差异即可演练 Multiply 片元基于纹理 alpha 向白色的插值。
- 清屏色为 `[0.65, 0.45, 0.25, 1]`。完全透明的光斑纹素必须使该目标颜色保持不变，而被覆盖纹素则必须将其变暗并染色。因此，加法回退会产生明显的全图差异。
- 两个引擎安装确定性正弦随机生成器，启动系统，并精确执行 40 个比例为 1 的模拟步长。这会创建 16 个静止粒子。Lite 通过 `buildNodeParticleSetWithBlendModes` 构建集合；随后两个引擎均将 `updateSpeed = 0`，Lite 通过 `registerNodeParticleSet(..., { autoStart: false })` 注册增强后的集合。
- 相机使用 alpha `-pi/2`、beta `pi/2`、radius `12`、target 原点、近裁剪面 `0.1` 与远裁剪面 `100`。

一致性 spec 从 Babylon.js WebGPU 参考页面刷新 `reference/lite/scene283-npe-multiply-blend/babylon-ref-golden.png`，捕获冻结的 Lite 画布，并要求全图 `MAD <= 0.01`。打包场景必须拉取可选的粒子 Multiply 可渲染对象，并保持在场景配置的原始字节上限之内。

向任一场景 283 页面追加 `?live` 会切换至非一致性检查模式。两个引擎解析同一个实时图变体：发射能量固定为 `1`，方向固定为 `[0, 0.6, 0]`，其余所有混合、纹理、生命周期、尺寸、颜色与发射盒设置保持不变。启动前同样安装带种子生成器，但两个引擎均不预步进或冻结系统。Babylon.js 让其原生粒子系统持续运行；Lite 的显式混合模式构建器已安装了高级注册器，因此 `registerNodeParticleSet` 根据场景帧增量推进、同步并渲染系统。两个页面均在首帧渲染后设置 `data-ready="true"`，但省略 `data-animation-frozen`，以便保持可见动画供本地并排对比检查。

### 13.6 MultiplyAdd 混合一致性场景

场景 284（`scene284-npe-multiply-add-blend`）是专门针对粒子混合模式 `4` 的独立 Babylon.js/Lite 真值对比场景。它复用场景 283 的程序化纹理、暖色清屏色、相机、发射盒、固定生命周期/尺寸/颜色以及零运动图，差异如下：

- `SystemBlock.blendMode = 4` 选择先 Multiply 后 Add。
- 两个引擎精确执行 20 个比例为 1 的模拟步长，创建八个静止粒子。该稀疏场仅包含一对重叠粒子，足以验证有序的双通道合成而不会累积稠密场跨 GPU 混合误差。
- Lite 使用 `buildNodeParticleSet` 构建，应用 `enableNodeParticleBlendModes(set)`，不修改任何求值器状态，并通过 `registerNodeParticleSet(..., { autoStart: false })` 注册。这证明启用器可与独立产出的集合组合使用。
- 一致性 spec 刷新 `reference/lite/scene284-npe-multiply-add-blend/babylon-ref-golden.png`，捕获 Lite，并要求全图 `MAD <= 0.01`。初始本地 MAD 为 `0.00044`。
- 生产 bundle 必须拉取全部四个可选混合模块并保持在 `45.0 KB` 原始字节以内。

## 14. 精确文件清单

### 14.1 粒子根目录：11 个文件

```text
packages/babylon-lite/src/particle/particle-billboard.ts
packages/babylon-lite/src/particle/particle-billboard-renderable.ts
packages/babylon-lite/src/particle/particle-billboard-scene.ts
packages/babylon-lite/src/particle/particle-blend.ts
packages/babylon-lite/src/particle/particle-buffer.ts
packages/babylon-lite/src/particle/particle-scene.ts
packages/babylon-lite/src/particle/particle-sprite-2d.ts
packages/babylon-lite/src/particle/particle-sprite-2d-blend-modes.ts
packages/babylon-lite/src/particle/particle-system.ts
packages/babylon-lite/src/particle/sprite-columns-random.ts
packages/babylon-lite/src/particle/sprite-columns.ts
```

### 14.2 节点基础设施与注册表：29 个文件

```text
packages/babylon-lite/src/particle/node/node-particle.ts
packages/babylon-lite/src/particle/node/npe-blend-modes.ts
packages/babylon-lite/src/particle/node/npe-build.ts
packages/babylon-lite/src/particle/node/npe-emitter-provider.ts
packages/babylon-lite/src/particle/node/npe-flow-map-runtime.ts
packages/babylon-lite/src/particle/node/npe-flow-map.ts
packages/babylon-lite/src/particle/node/npe-graph-plumbing.ts
packages/babylon-lite/src/particle/node/npe-graph-plumbing-runtime.ts
packages/babylon-lite/src/particle/node/npe-noise-runtime.ts
packages/babylon-lite/src/particle/node/npe-noise.ts
packages/babylon-lite/src/particle/node/npe-contextual-extra.ts
packages/babylon-lite/src/particle/node/npe-contextual.ts
packages/babylon-lite/src/particle/node/npe-local-position.ts
packages/babylon-lite/src/particle/node/npe-parser.ts
packages/babylon-lite/src/particle/node/npe-registry-extra-basic.ts
packages/babylon-lite/src/particle/node/npe-registry-extra-emitters.ts
packages/babylon-lite/src/particle/node/npe-registry-extra-remaining.ts
packages/babylon-lite/src/particle/node/npe-registry-extra-values.ts
packages/babylon-lite/src/particle/node/npe-registry-extra.ts
packages/babylon-lite/src/particle/node/npe-registry-local-shapes.ts
packages/babylon-lite/src/particle/node/npe-registry-variants.ts
packages/babylon-lite/src/particle/node/npe-registry.ts
packages/babylon-lite/src/particle/node/npe-snippet.ts
packages/babylon-lite/src/particle/node/npe-texture-content.ts
packages/babylon-lite/src/particle/node/npe-texture-update-runtime.ts
packages/babylon-lite/src/particle/node/npe-texture-updates-runtime.ts
packages/babylon-lite/src/particle/node/npe-texture-updates.ts
packages/babylon-lite/src/particle/node/npe-types.ts
packages/babylon-lite/src/particle/node/npe-value.ts
```

Phase 3C 原地扩展了 `npe-graph-plumbing.ts` 与 `npe-graph-plumbing-runtime.ts` 并在 `blocks/` 下新增了一个局部求值器；未新增节点基础设施文件，因此计数仍为 29。

### 14.3 块求值器与辅助文件：47 个文件

46 个文件的 Phase 3B 基线修正了一处先前清单的遗漏：`embedded-texture-source-block.ts` 在 Phase 3B 之前即已存在。Phase 3C 仅新增了 `particle-local-variable-block.ts`。

```text
packages/babylon-lite/src/particle/node/blocks/basic-sprite-update-block.ts
packages/babylon-lite/src/particle/node/blocks/box-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/box-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/cone-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/cone-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/create-particle-block.ts
packages/babylon-lite/src/particle/node/blocks/cylinder-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/cylinder-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/cpu-texture-source-block.ts
packages/babylon-lite/src/particle/node/blocks/embedded-texture-source-block.ts
packages/babylon-lite/src/particle/node/blocks/mesh-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/mesh-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-condition-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-converter-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-float-to-int-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-gradient-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-gradient-value-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-input-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-input-extra-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-input-local-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-lerp-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-local-variable-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-math-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-math-compact-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once-typed-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once-typed.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once.ts
packages/babylon-lite/src/particle/node/blocks/particle-vector-length-block.ts
packages/babylon-lite/src/particle/node/blocks/point-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/point-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/setup-sprite-sheet-block.ts
packages/babylon-lite/src/particle/node/blocks/setup-sprite-sheet-random-block.ts
packages/babylon-lite/src/particle/node/blocks/sphere-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/sphere-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/system-block.ts
packages/babylon-lite/src/particle/node/blocks/system-dynamic-emit-rate-block.ts
packages/babylon-lite/src/particle/node/blocks/texture-source-block.ts
packages/babylon-lite/src/particle/node/blocks/update-angle-block.ts
packages/babylon-lite/src/particle/node/blocks/update-attractor-block.ts
packages/babylon-lite/src/particle/node/blocks/update-color-block.ts
packages/babylon-lite/src/particle/node/blocks/update-direction-block.ts
packages/babylon-lite/src/particle/node/blocks/update-flow-map-block.ts
packages/babylon-lite/src/particle/node/blocks/update-noise-block.ts
packages/babylon-lite/src/particle/node/blocks/update-position-block.ts
packages/babylon-lite/src/particle/node/blocks/update-size-block.ts
```

TeleportIn、TeleportOut、Elbow 与 Debug 不新增求值器文件。帧准备组合仍作为函数留在现有 `particle-system.ts` 中，因此第 14.1 节保持为 11 个根文件。

### 14.4 直接集成依赖

以下文件由粒子源码文件直接导入，或定义了包根导出：

```text
packages/babylon-lite/src/camera/camera.ts
packages/babylon-lite/src/engine/engine.ts
packages/babylon-lite/src/math/_matrix-allocator.ts
packages/babylon-lite/src/math/create-identity-mat4.ts
packages/babylon-lite/src/math/invert-mat4.ts
packages/babylon-lite/src/math/invert-mat4-to-ref-or-identity.ts
packages/babylon-lite/src/math/mat4-transform.ts
packages/babylon-lite/src/math/create-translation-mat4.ts
packages/babylon-lite/src/math/random-range.ts
packages/babylon-lite/src/math/types.ts
packages/babylon-lite/src/scene/scene-core.ts
packages/babylon-lite/src/scene/scene.ts
packages/babylon-lite/src/sprite/billboard-blend.ts
packages/babylon-lite/src/sprite/billboard-scene.ts
packages/babylon-lite/src/sprite/billboard-sprite.ts
packages/babylon-lite/src/sprite/shared/sprite-atlas.ts
packages/babylon-lite/src/sprite/sprite-2d.ts
packages/babylon-lite/src/sprite/sprite-blend.ts
packages/babylon-lite/src/sprite/sprite-custom-shader.ts
packages/babylon-lite/src/sprite/sprite-renderer.ts
packages/babylon-lite/src/texture/texture-2d.ts
packages/babylon-lite/src/index.ts
```

公告板子系统拥有其额外的渲染、拾取、GPU 及混合描述符依赖。Sprite2D 子系统拥有其紧凑图层布局、脏追踪、渲染器、GPU 上传及混合描述符。它们位于粒子实现边界之外；粒子包仅拥有转换与注册策略。

### 14.5 场景与配置锚点

```text
demos-config.json
scene-config.json
lab/lite/src/demos/npe-sprite2d.ts
lab/lite/src/lite/scene262.ts
lab/lite/src/lite/scene263.ts
lab/lite/src/lite/scene264.ts
lab/lite/src/lite/scene276.ts
lab/lite/src/lite/scene277.ts
lab/lite/src/lite/scene280.ts
lab/lite/src/lite/scene281.ts
lab/lite/src/lite/scene283.ts
lab/lite/src/lite/scene284.ts
lab/lite/src/lite/scene300.ts
lab/lite/src/lite/scene301.ts
lab/lite/src/lite/scene302.ts
lab/lite/src/lite/scene305.ts
lab/lite/src/bjs/scene302.ts
lab/lite/src/bjs/scene305.ts
lab/lite/src/shared/scene262-npe.ts
lab/lite/src/shared/scene263-npe.ts
lab/lite/src/shared/scene264-npe.ts
lab/lite/src/shared/scene276-npe.ts
lab/lite/src/shared/scene277-npe.ts
lab/lite/src/shared/scene280-npe.ts
lab/lite/src/shared/scene281-npe.ts
lab/lite/src/shared/scene283-npe-multiply-blend.ts
lab/lite/src/shared/scene284-npe-multiply-add-blend.ts
lab/lite/src/shared/scene302-npe-moving-emitter.ts
lab/lite/src/shared/scene305-teleport-npe.ts
lab/lite/src/shared/npe-sprite2d-fixture.ts
lab/public/thumbnails/scene301.jpg
lab/public/thumbnails/scene302.jpg
lab/public/thumbnails/scene305.jpg
lab/lite/bundle-scene301.html
lab/lite/scene301.html
lab/lite/babylon-ref-scene302.html
lab/lite/bundle-scene302.html
lab/lite/scene302.html
lab/lite/babylon-ref-scene305.html
lab/lite/bundle-scene305.html
lab/lite/scene305.html
reference/lite/scene302-npe-moving-emitter/babylon-ref-golden.png
reference/lite/scene305-npe-teleport/babylon-ref-golden.png
tests/lite/parity/scenes/scene262-npe-size.spec.ts
tests/lite/parity/scenes/scene263-npe-sphere.spec.ts
tests/lite/parity/scenes/scene264-npe-change-size.spec.ts
tests/lite/parity/scenes/scene276-npe-animations.spec.ts
tests/lite/parity/scenes/scene277-npe-attractor.spec.ts
tests/lite/parity/scenes/scene280-npe-flow-map.spec.ts
tests/lite/parity/scenes/scene281-npe-noise-texture.spec.ts
tests/lite/parity/scenes/scene283-npe-multiply-blend.spec.ts
tests/lite/parity/scenes/scene284-npe-multiply-add-blend.spec.ts
tests/lite/parity/scenes/scene300-npe-sprite2d.spec.ts
tests/lite/parity/scenes/scene301-npe-sprite2d-blend-modes.spec.ts
tests/lite/parity/scenes/scene302-npe-moving-emitter.spec.ts
tests/lite/parity/scenes/scene305-npe-teleport.spec.ts
tests/lite/parity/bundle-size.spec.ts
tests/lite/unit/npe-particle-flow-map.test.ts
tests/lite/unit/npe-particle-noise-texture.test.ts
tests/lite/unit/npe-particle-bundle-content.test.ts
tests/lite/unit/npe-particle-305-graph.test.ts
tests/lite/unit/npe-particle-graph-plumbing.test.ts
tests/lite/unit/npe-particle-graph-plumbing-phase3c.test.ts
tests/lite/unit/npe-particle-local-variable.test.ts
tests/lite/unit/npe-particle-moving-emitter.test.ts
tests/lite/unit/particle-sprite-2d.test.ts
tests/lite/unit/particle-sprite-2d-blend-modes.test.ts
```