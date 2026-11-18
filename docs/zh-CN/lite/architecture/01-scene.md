# 模块：Scene

> 包路径：`packages/babylon-lite/src/scene/scene.ts`

## 目的

Scene 模块定义了 `SceneContext` —— 用于存放所有渲染状态的中央扁平数据容器。它遵循严格的单向所有权模型，没有任何循环引用：场景持有对引擎、相机、灯光和网格的引用，但这些对象均不会反向引用场景。场景与材质无关 —— 它通过 `_buildGroup` 模式将所有管线/绑定组的创建委托给由材质拥有的构建器。它还提供了 `createDefaultCamera()`，用于围绕已加载网格的包围盒自动构图并计算一个 ArcRotateCamera。

## 公共 API 接口

```typescript
/** Image processing configuration. */
export interface ImageProcessingConfig {
    exposure: number;
    contrast: number;
    toneMappingEnabled: boolean;
}

/** Top-level scene context — flat struct, no deep hierarchy. */
export interface SceneContext {
    readonly engine: Engine;
    clearColor: GPUColorDict;
    camera: ArcRotateCamera | FreeCamera | null;
    lights: LightBase[]; // All light types (HemisphericLight, DirectionalLight, PointLight, SpotLight)
    imageProcessing: ImageProcessingConfig;

    /** All meshes (standard, PBR, or any future material type). */
    meshes: Mesh[];

    /** Animation groups (one per glTF animation clip). */
    animationGroups: AnimationGroup[];

    fog: FogConfig | null;
    shadowGenerators: ShadowGenerator[];

    /** Background material primaryColor (linear RGB). */
    environmentPrimaryColor?: [number, number, number];

    /** Fixed timestep for animation ticks (ms, 0 = use real rAF delta). */
    fixedDeltaMs: number;

    /** Internal renderable lists — populated by material builders. */
    _renderables: Renderable[];
    _opaqueRenderables: Renderable[];
    _transparentRenderables: Renderable[];
    _prePasses: PrePassRenderable[];
    _uniformUpdaters: SceneUniformUpdater[];

    /** Fixed timestep alias (internal). */
    _fixedDeltaMs: number;

    /** Per-frame callbacks invoked before rendering. */
    _beforeRender: ((deltaMs: number) => void)[];

    /** Deferred builder functions; may be async. Drained by buildScene() during registerScene(). */
    _deferredBuilders: (() => void | Promise<void>)[];
}

/** Add an entity or asset container to the scene. Auto-routes by type. Adding a camera makes it
 *  the active `scene.camera`; an asset container's camera is installed only when none is set. */
export function addToScene(scene: SceneContext, entity: Mesh | LightBase | Camera | ShadowGenerator | TransformNode | AssetContainer): void;

/** Remove an entity or asset container from the scene, undoing addToScene. Idempotent.
 *  Removing a mesh from its LAST scene disposes it — every claim it holds on its shared GPU
 *  resources is released, the ones it last owned are destroyed, and the mesh is retired for good
 *  (re-adding it throws). See "Mesh GPU Lifetime". */
export function removeFromScene(scene: SceneContext, entity: Mesh | LightBase | Camera | ShadowGenerator | TransformNode | AssetContainer): void;

/** Set environment rotation around the Y axis, in radians. */
export function setEnvironmentRotation(scene: SceneContext, rotation: number): void;

/** Rotate only the image-based lighting around the Y axis, in radians; the visible skybox keeps its own orientation. */
export function setEnvironmentLightingRotation(scene: SceneContext, rotation: number): void;

/** Give the visible skybox a fixed Y rotation, in radians, independent of the lighting. Call before the skybox is built. */
export function setEnvironmentSkyboxRotation(scene: SceneContext, rotation: number): void;

/** Register a callback to run before each rendered frame. */
export function onBeforeRender(scene: SceneContext, cb: (deltaMs: number) => void): void;

/** Register a callback to run when `disposeScene(scene)` is called. */
export function onSceneDispose(scene: SceneContext, cb: () => void): void;

/** Build deferred GPU resources, build the frame graph, and register the scene for rendering.
 *  Every ordinary scene clears its target; use `createOverlayScene(baseScene, { rt, rst? })` to composite into explicit borrowed color targets with independent cleared depth.
 *  Rebuilds the scene first when its light/shadow topology changed since the initial build. */
export function registerScene(scene: SceneContext): Promise<void>;

/** Remove the scene from the engine render list without disposing scene-owned resources. */
export function unregisterScene(scene: SceneContext): void;

/** Re-run every material group builder in place so renderables pick up the current light/shadow
 *  topology. No-op before the initial build. */
export function rebuildSceneRenderables(scene: SceneContext): Promise<void>;

/** Release all GPU resources owned by this scene. */
export function disposeScene(scene: SceneContext): void;

/** Create an empty scene context bound to the given engine. */
export interface SceneContextOptions {
    defaultRenderTask?: boolean;
}

export function createSceneContext(engine: Engine, options?: SceneContextOptions): SceneContext;

/** Create an ArcRotateCamera framed to fit all loaded meshes, assign it to scene. */
export function createDefaultCamera(scene: SceneContext): ArcRotateCamera;
```

## 内部架构

### SceneContext — 扁平数据结构

`createSceneContext(engine, options?)` 返回一个带有以下默认值的普通对象。默认情况下，它还会追加一个名为 `"scene"` 的交换链渲染任务；当调用方需要显式提供最终交换链任务（例如后处理链）时，可传入 `{ defaultRenderTask: false }`。

| 字段                      | 默认值                                                        | 说明                                                                      |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `engine`                  | 传入参数                                                      | 对 Engine 的不可变引用                                                    |
| `clearColor`              | `{ r: 0.2, g: 0.2, b: 0.3, a: 1.0 }`                          | 渲染通道清除颜色                                                          |
| `camera`                  | `null`                                                        | 由 `addToScene(camera)`、`createDefaultCamera` 或直接赋值设置             |
| `lights`                  | `[]`                                                          | 所有灯光类型（`LightBase[]`）                                             |
| `meshes`                  | `[]`                                                          | 所有网格（Standard、PBR 等）                                              |
| `animationGroups`         | `[]`                                                          | 来自 glTF 片段的动画组                                                    |
| `fog`                     | `null`                                                        | 雾效配置（`null` 表示禁用）                                               |
| `shadowGenerators`        | `[]`                                                          | 阴影生成器                                                                |
| `imageProcessing`         | `{ exposure: 1.0, contrast: 1.0, toneMappingEnabled: false }` | 图像处理参数                                                              |
| `_renderables`            | `[]`                                                          | 所有可渲染对象（合并列表）                                                |
| `_opaqueRenderables`      | `[]`                                                          | 按 `order` 排序的不透明可渲染对象                                         |
| `_transparentRenderables` | `[]`                                                          | 每帧按从后到前排序的透明可渲染对象                                        |
| `_prePasses`              | `[]`                                                          | 预通道实体（阴影深度、计算着色器）                                        |
| `_uniformUpdaters`        | `[]`                                                          | 每帧 UBO 更新器                                                           |
| `_fixedDeltaMs`           | `0`                                                           | 动画的固定时间步长（毫秒）                                                |
| `_beforeRender`           | `[]`                                                          | 渲染前回调 `(deltaMs) => void`                                            |
| `_deferredBuilders`       | `[]`                                                          | 支持异步的构建器，在 `registerScene()` 期间由 `buildScene()` 依次执行清空 |

### 设计原则：单向所有权

```
Engine ← SceneContext → Camera
                      → Lights[]
                      → Meshes[]
                      → AnimationGroups[]
                      → ShadowGenerators[]
                      → _renderables[]
                      → _prePasses[]
                      → _uniformUpdaters[]
                      → _beforeRender[]
```

子对象均不引用场景。引擎将可渲染对象数组作为不透明契约进行遍历。

### `addToScene()` — 实体路由

`addToScene(scene, entity)` 检查实体并将其路由到正确的集合：

```typescript
function addToScene(scene: SceneContext, entity: Mesh | LightBase | ShadowGenerator | TransformNode | AssetContainer) {
    // AssetContainer — from loadGltf() or loadBabylon()
    if ("entities" in entity) {
        const result = entity as AssetContainer;
        for (const e of result.entities) addToScene(scene, e); // recurse into individual entities
        if (result.clearColor) ctx.clearColor = result.clearColor;
        if (result.animationGroups?.length) {
            const engine = ctx.engine as EngineContextInternal;
            const groups = result.animationGroups;
            ctx.animationGroups.push(...groups);
            ctx._beforeRender.push((dt) => {
                for (const g of groups) tickAnimation(g, dt, engine);
            });
        }
        return;
    }
    if (isTransformNode(entity)) {
        // TransformNode: collect all meshes from hierarchy and add each
        const meshes = collectMeshes(entity, entity.parent ?? undefined);
        for (const m of meshes) {
            ctx.add(m);
        }
        return;
    }
    if ("_gpu" in entity && "material" in entity) {
        // Mesh → meshes + register material builder (deduped by builder identity)
        this.meshes.push(entity);
        // Subscribe this scene to the mesh. A mesh never references the scene (one-way
        // ownership), so the reverse index lives off the mesh in a lazily-allocated
        // `WeakMap<Mesh, Set<SceneContext>>`. The `mesh.material` setter is installed
        // exactly once (on the mesh's first registration); the captured subscriber set is
        // mutated in place, so a mesh shared across scenes notifies ALL of them on swap.
        // The set's size also ref-counts the mesh's shared GPU buffers: disposeScene /
        // removeFromScene only call disposeMeshGpu on the LAST scene removal.
        registerMeshScene(this, entity);
        const builder = entity.material?._buildGroup;
        if (builder && !_groups.has(builder)) {
            _groups.set(builder, []);
            this._deferredBuilders.push(async () => {
                const result = await builder(this, _groups.get(builder)!);
                this._renderables.push(...result.renderables);
                if (result.updater) this._uniformUpdaters.push(result.updater);
            });
        }
        _groups.get(builder)?.push(entity);
    } else {
        // Light → lights
        this.lights.push(entity as LightBase);
    }
}
```

系统首先检查 `AssetContainer` 分支（通过 `'entities' in entity`）。对于 `glTF` 结果，`entities` 包含单个根 `TransformNode` —— 随后 TransformNode 分支会调用 `collectMeshes` 将所有子网格拉入场景。对于 `.babylon` 结果，`entities` 是扁平的 `[...meshes, ...lights]`，直接进行分发。

场景从不对材质类型（PBR 与 Standard）进行分支判断。材质通过 `material._buildGroup` 自我描述其构建器，场景使用内部的 `Map<MeshGroupBuilder, Mesh[]>` 按构建器标识对网格进行分组。每个唯一的构建器仅作为延迟构建器注册一次。

### 网格 GPU 生命周期 — `removeFromScene` 契约

网格的 GPU 资源（几何体 `_gpu`、骨骼、变形目标、精简实例）是**共享且引用计数的**（`resource/ref-count.ts`）：多个场景可能持有同一个网格，`cloneTransformNode` 与其克隆体共享缓冲区，且 glTF 加载器在引用同一图元的节点间共享同一份几何体。

- `removeFromScene(scene, mesh)` / `disposeScene(scene)` 会将场景从网格中注销（`unregisterMeshScene`）。只有当网格离开其**最后一个**场景时，才会调用 `disposeMeshGpu(mesh)`，从而释放该网格对每项共享资源的占用声明。仅从持有它的多个场景之一中移除网格并不会销毁它 —— 之后再将其重新添加到该场景是完全合法的。`disposeMeshGpu` 也是公共 API，因此直接调用它会以同样的方式销毁网格，无论该网格是否曾属于某个场景。
- 当某次释放是某项资源的**最后一次**占用声明时，该资源的缓冲区会被销毁；仍被克隆体或其他 glTF 节点持有的资源则会保留。
- 场景销毁会清空 `_disposables` 的快照，因此即使某个回调在清理期间注销了自身或相关的共享资源回调，销毁开始时存在的每个回调仍会恰好执行一次。重复调用 `disposeScene` 为空操作。
- **销毁对网格而言是终结性的。** `disposeMeshGpu` 会将网格标记为 `_disposed`，并在任何重复调用时提前返回，从而保证幂等的 `removeFromScene` 永远不会将同一份占用声明释放两次（第二次释放会把存活克隆体的占用声明误判为最后一次，进而销毁仍在使用的缓冲区）。此后对已销毁的网格调用 `addToScene` 将抛出异常：`Mesh "<name>" cannot be added: it was disposed when it left its last scene. Create a new mesh instead.`，`cloneTransformNode` 同样会拒绝它 —— 因为已销毁网格的克隆体将永远无法释放克隆操作所保留的占用声明。该标记是按网格（per-mesh）而非按资源（per-resource）设置的，因为两种失败模式均发生在网格维度：独占所有者会使用已销毁的句柄进行绘制，而共享所有者则会释放其不再持有的第二份占用声明，并释放存活兄弟节点仍在用于渲染的缓冲区。它同样涵盖独立于共享几何体而被销毁的资源（例如几何体共享但各自独立的逐节点骨骼或变形目标），以及设备丢失恢复后遗留的失效句柄（恢复过程仅重建仍在场景中的网格）。
- 该守卫会在修改任何场景状态之前运行，因此被拒绝的网格添加操作不会改变场景状态。添加层级结构或资源容器不具备事务性：在触发异常的网格之前已处理的实体仍会保留在场景中。
- 因此，如果打算再次显示某个网格，除非仍有其他场景持有它，否则将其移除绝不是合法操作；否则只能新建一个网格。若要临时隐藏网格，请调用 `setMeshVisible(mesh, false)` 而不是移除它，调用 `setMeshVisible(mesh, true)` 即可重新显示。`SceneNode.visible` 在公共 API 中是只读的：`setMeshVisible` 会将可见性值级联传播到后代节点并递增可见性纪元（visibility epoch），从而使缓存的不透明渲染包重新录制，这是直接写入字段所无法实现的。

### 延迟构建与 `_buildGroup` 模式

材质携带一个 `_buildGroup: MeshGroupBuilder` 函数，该函数负责为共享同一材质类型的一批网格创建 GPU 管线、绑定组和可渲染对象。其流程如下：

1. `addToScene(scene, mesh)` 根据网格的 `material._buildGroup` 标识进行分组。
2. 如果这是某个给定构建器的第一个网格，则注册一个延迟构建器。
3. 在 `buildScene(scene)` 阶段（由 `registerScene()` 在构建帧图之前调用），每个延迟构建器会使用该组的完整网格批次运行一次。
4. 构建器返回 `MeshGroupBuildResult`；`renderables` 被推入 `_renderables`，而可选的 `updater` 仅在存在时才会被推入 `_uniformUpdaters`。

在 `addToScene` 之后且在初始构建之前，可以对 `mesh.material` 进行赋值或替换。材质的 setter 会将网格加入队列。当该队列非空时，初始 `buildScene` 会丢弃排队的替换项（因为启动构建器已经使用每个网格的最终材质），并按添加顺序从场景中每个网格当前的 `material._buildGroup` 重新填充尚未构建的组，必要时创建新组及其延迟构建器。因此，添加时没有材质的网格会在设置材质后构建，而迁移到另一材质家族的网格仅由新家族的构建器构建。如果在启动前因网格迁出或被移除而导致某个启动组变空，则该组绝不会传递给其构建器（构建器要求至少有一个网格）。相反，其延迟构建器会将其从 `_groups` 中移除，以便在启动清空过程的后续阶段加入该家族的网格能够创建并构建一个新组。

`buildScene(scene)` 是异步的 —— 延迟构建器可以返回 `Promise<void>` 用于 GPU 资源创建。

这种设计将场景搭建与 GPU 资源创建解耦，确保在构建管线前所有资产均已加载完毕，并使 `scene.ts` 完全与材质无关。

### 运行时添加与移除（在 `registerScene` 之后）

延迟构建器仅在启动时于 `buildScene()` 内部运行。之后添加的任何内容都通过逐帧材质替换队列（`processMaterialSwaps`，从场景的 `_update` 钩子中清空）处理，该队列涵盖两种不同情况：

- **材质所属的组已经存在且已构建**（`group.r` 已设置）—— 该网格的可渲染对象会在同一帧内同步重建，因此不会出现网格缺失导致的闪烁。
- **材质所属的组从未构建过** —— 要么该网格是此场景中其材质家族的**第一个**网格，要么 `mesh.material` 被重新赋值为一个根本没有组的家族（材质 setter 只负责入队，从不创建组）。这些情况会交由运行时构建路径（`scene-runtime-mesh-build.ts`，通过动态导入加载，以免静态场景将其打包）处理，由其具体化该组：PBR 会通过 `rebuildScenePbrPipelines` 重建整个组，其他家族则构建单个网格并安装该组的重建函数。每个 PBR 网格都会先将自己移入该组，然后加入尚未分派的 PBR 组重建中，因此同一次清空或同一次 `rebuildMaterial` 调用中的网格会共享同一次重建；在重建运行期间到达的请求会合并为一次后续重建，并在当前重建完成后分派。

当某个 PBR 材质所属的组已经组合了其变体时，`rebuildMaterial()` 也可以为该材质的 PBR 网格同步清空队列：它仅将那些网格入队、执行清空，并将因其他原因入队的网格放回队列留待下一帧清空（参见 27-render-pipeline 中的 PBR 材质重建生命周期）。

> **在运行时引入新的材质家族是异步操作。** 它需要动态模块导入、着色器编译以及完整的组构建，因此网格会在 `addToScene` 返回几帧之后才变为可见 —— `addToScene` 本身返回 `void` 且不提供就绪信号。在调用 `registerScene` 之前为每个材质家族添加至少一个网格可使一切保持同步。构建失败会通过场景的渲染前错误钩子暴露出来，而不会被静默吞掉。

`removeFromScene` 在销毁侧体现了这种不对称性：场景记账（列表剪接、组与帧图驱逐、可渲染版本号递增）是同步的，但 **GPU 销毁是延迟的** —— 逐网格/材质 UBO、纹理释放和共享几何体缓冲区会通过 `retireGpuResources` 退役，并仅在下一次 `queue.submit` 排空后才被销毁。这使得在 `onBeforeRender` 内部调用 `removeFromScene` 成为合法操作（在帧中间直接销毁会触发 "Destroyed texture / Buffer used in a submit" 错误），同时为与另一网格共享的资源保留了“先建后拆”（make-before-break）语义：重建过程会在延迟释放生效前重新获取纹理，从而使其引用计数永远不会降为零。由于释放是延迟的，释放网格共享缓冲区的权利会作为一次性、可撤销的声明（`claimMeshGpuDisposal` / `consumeMeshGpuDisposal`）来获取，因此在此期间的重复移除、重新添加或 `disposeScene` 不会两次释放相同的缓冲区。

### 自定义可渲染对象集合

文本可渲染对象（Text renderables）、深度托管的 `Sprite2DLayer` 以及广告牌系统（billboard systems）不是 `SceneEntity` 值，不经过 `addToScene` / `removeFromScene` / `onSceneChange`。每个家族在其功能模块中拥有四个公共函数，均构建于内部的 `scene/scene-renderable-collection.ts` 辅助工具之上：

| 家族                        | 添加（幂等）                       | 移除（`boolean`）                       | 发现（按添加顺序快照）            | 观察                                    |
| --------------------------- | ---------------------------------- | --------------------------------------- | --------------------------------- | --------------------------------------- |
| `TextRenderable`            | `addTextRenderableToScene`         | `removeTextRenderableFromScene`         | `getSceneTextRenderables`         | `onSceneTextRenderablesChanged`         |
| 深度托管的 `Sprite2DLayer`  | `addDepthHostedSpriteLayerToScene` | `removeDepthHostedSpriteLayerFromScene` | `getSceneDepthHostedSpriteLayers` | `onSceneDepthHostedSpriteLayersChanged` |
| `BillboardSpriteSystem`     | `addBillboardSystemToScene`        | `removeBillboardSystemFromScene`        | `getSceneBillboardSystems`        | `onSceneBillboardSystemsChanged`        |

每个家族共享的语义如下：

- **成员关系。** 集合在首次添加或订阅时按需延迟分配在 `scene._renderableCollections`（一个按家族为键的 `Map`）上，作为一个按插入顺序排列的从成员到其场景侧条目的 `Map`。重复添加同一成员无任何效果；仅当成员存在时移除操作才返回 `true`。移除后再重新添加的成员会移动到发现顺序的末尾。
- **构建。** 添加操作会将成员的渲染附件排入场景的延迟构建器队列，因此它会与场景的其他延迟工作一同构建（在 `registerScene` 时，或者若后续添加则在下一次注册时）。功能注册（例如广告牌拾取源）会在添加事件发布前完成安装。每次添加都会创建一个新条目；当附件解析完成时，会在不经过任何 `await` 的情况下立即重新检查成员资格，然后再追加可渲染对象，因此如果构建在其成员已被移除或重新添加后才完成，它会释放其 GPU 状态而不进行绘制，且“移除→重新添加”在构建前只会绘制一次。
- **移除。** 已构建的可渲染对象会从 `_renderables` 中同步剪接移除（同时递增 `_renderableVersion`），诸如广告牌拾取源等功能注册会被注销，附件的 GPU 状态会立即分离并在飞行中的帧完成后通过 `retireGpuResources` 释放。成员对象本身仍由调用方拥有，可随时重新添加。
- **事件。** `onScene…Changed(scene, listener)` 仅报告已提交的成员变更（`{ type: "added" | "removed", entity }`）。分发器由首次订阅安装，因此从未观察过某个家族的场景不会携带任何分发代码。监听器内部发起的变更会排队等待当前事件到达所有监听器后再执行；监听器抛出的异常不会阻止后续监听器执行，并在变更提交后重新抛出（单个错误或 `AggregateError`）给发起变更的调用方。返回的取消订阅函数是幂等的。观察已销毁的场景会抛出异常。
- **销毁。** `disposeScene` 会通过每个附件注册的场景销毁回调立即释放所有已构建成员的 GPU 状态（移除操作会将其丢弃；销毁后才落地的构建会由延迟清理释放），并且不发布移除事件（与 `onSceneChange` 一致）。集合本身不会单独拆除：已销毁场景的 getter 返回 `[]`，其 remove 返回 `false`；其拾取源由 `disposeScene` 清除。

`TextRenderable` 维护一个被其绘制绑定所捕获的 GPU 记录，因此它一次应只属于一个场景：将其从场景移除（或销毁场景）会释放该记录，即使另一个场景仍在绘制该可渲染对象。这与现有的 `disposeScene` 行为一致。

### 隐藏状态（通过 `(scene as any)` 访问）

| 属性           | 设置者              | 类型                  | 用途                                |
| -------------- | ------------------- | --------------------- | ----------------------------------- |
| `_envTextures` | `loadEnvironment()` | `EnvironmentTextures` | IBL 立方体贴图 + BRDF LUT           |
| `_pbrSceneBGL` | PBR 构建器          | `GPUBindGroupLayout`  | 供背景复用的 PBR 场景绑定组布局     |
| `_pbrSceneBG`  | PBR 构建器          | `GPUBindGroup`        | 供背景复用的 PBR 场景绑定组         |

> **已移除**：`_gpuMeshes` 与 `GpuMesh` 类型不再存在。网格直接在其 `mesh._gpu` 中携带 GPU 数据，并在 `mesh.boundMin`/`mesh.boundMax` 中携带包围盒。

### 自动构图相机（`createDefaultCamera`）

算法：

1. 读取 `scene.meshes`（可能为空）。
2. 遍历每个 `Mesh` 的 `boundMin`/`boundMax`，计算所有网格在世界空间下的 AABB。
3. 计算对角线长度：`diag = √(sx² + sy² + sz²)`，其中 `sx = maxX - minX`，以此类推。
4. 半径 = `diag * 1.5`（Babylon 公式）。
5. 中心点 = AABB 的中点。
6. 若半径为 0 或非有限值：radius = 1，center = (0,0,0)。
7. 创建相机：`alpha = -π/2`，`beta = π/2`，`radius`，`target = center`。
8. 设置 `minZ = radius * 0.01`，`maxZ = radius * 1000`。
9. 赋值 `scene.camera = cam`。

## 生命周期：构建时烘焙的内容

`registerScene` / `registerSceneWithShadowSupport` **只运行一次**延迟组构建器（`_built`）；`unregisterScene` 仅将场景从其渲染表面（surface）的渲染列表中分离，因此重新注册只是重新挂载而非重新构建。各类变更的开销如下：

| 初始构建后的变更                                    | 生效时机                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 灯光位置 / 方向 / 颜色 / 强度                       | 立即生效 —— 每帧都会根据 `_lightVersion` 刷新灯光 UBO                                   |
| **移除**或替换灯光                                  | 数据：下一帧（`_lightListVersion` 使 UBO 失效）。烘焙状态：在下次注册时自动重建         |
| 移除阴影生成器                                      | 在下次注册时自动重建                                                                    |
| **添加**灯光，或将生成器附加到现有灯光              | 数据：下一帧（灯光数量变化）。烘焙状态：仅通过显式调用 `rebuildSceneRenderables(scene)` |
| `mesh.material = …`                                 | 下一帧，通过材质替换队列清空完成                                                        |

每个可渲染对象在构建时烘焙的状态包括：逐网格的灯光**索引**列表、单灯光与多灯光着色器变体排列、网格是否接收阴影，以及附加到每个灯光上的生成器的阴影绑定组。`rebuildSceneRenderables(scene)` 会重新运行组构建器，从而重新计算上述所有内容。若要在不改变拓扑的情况下临时禁用已附加的生成器，请使用 `setShadowGeneratorEnabled(generator, false)`；它会保留已烘焙的绑定，中和接收方的贡献，并暂停阴影贴图渲染。`removeFromScene` 会安装一个由 `buildScene` 运行的重建钩子，因此**移除**操作会在场景下次注册时自动被捕获，常规流程即可正常工作：

```ts
unregisterScene(scene);
removeFromScene(scene, oldLight); // its shadow generator goes with it — arms the rebuild
addToScene(scene, newLight); // with its own generator
await registerSceneWithShadowSupport(scene); // rebuilds, then re-attaches
```

仅向已构建场景**添加**灯光时不会安装钩子（从而让从未变更拓扑的场景在 `addToScene` 中保持零重建字节开销）—— 此时请显式调用 `rebuildSceneRenderables`。

移除阴影生成器**不会**就地释放其 GPU 资源：在此移除之前构建的接收方可渲染对象仍然绑定着这些资源，因此销毁操作会排队进入 `_pendingTopologyRetirements`，并由全家族重建（在替换绑定组创建之后）或由 `disposeScene` 清空。仅限特定家族的重建（图像处理 → 仅 PBR）有意从不清空该队列。

只有组所拥有的可渲染对象会被替换。`_renderables` 中由功能模块拥有的条目（天空盒、地面、HDR 背景、高斯泼溅）会被保留：每个 `SceneMeshGroup` 将其上次构建的输出记录在 `group.o` 中 —— 同一组的多个网格可能会被合并成一个没有 `mesh` 反向引用的组合可渲染对象，因此无法通过网格标识来反推所有权。在解析时捕获了 `shadowGenerators` 的节点材质（Node materials）保留其自身的引用，不在拓扑替换的作用范围内。

## Babylon.js 等价对照表

| Babylon Lite                    | Babylon.js                                                 |
| ------------------------------- | ---------------------------------------------------------- |
| `createSceneContext(engine)`    | `new BABYLON.Scene(engine)`                                |
| `scene.clearColor`              | `scene.clearColor`                                         |
| `scene.camera`                  | `scene.activeCamera`                                       |
| `scene.lights`                  | `scene.lights`                                             |
| `scene.meshes`                  | `scene.meshes`                                             |
| `scene.animationGroups`         | `scene.animationGroups`                                    |
| `addToScene(scene, entity)`     | `scene.addMesh()` / `scene.addLight()`（取决于实体类型）   |
| `scene._renderables`            | `scene._renderingManager._renderingGroups`                 |
| `scene._prePasses`              | `scene.onBeforeRenderObservable` 处理器                    |
| `scene._beforeRender`           | `scene.onBeforeRenderObservable`                           |
| `scene._uniformUpdaters`        | `scene.render()` 期间的内部 UBO 更新                       |
| `scene._deferredBuilders`       | `scene._prepareFrame()` 延迟编译                           |
| `scene.imageProcessing`         | `scene.imageProcessingConfiguration`                       |
| `createDefaultCamera(scene)`    | `scene.createDefaultCameraOrLight(true, true, true)`       |
| `scene.environmentPrimaryColor` | `env.groundMaterial.primaryColor`                          |

## 依赖关系

- **导入**：来自 `../engine/engine.js` 的 `Engine`；来自 `../camera/arc-rotate.js` 的 `ArcRotateCamera` + `createArcRotateCamera`；来自 `../math/vec3.js` 的 `vec3`；来自 `../render/renderable.js` 的 `Renderable`/`PrePassRenderable`/`SceneUniformUpdater`/`MeshGroupBuilder`；来自 `../mesh/mesh.js` 的 `Mesh`（仅类型）；来自 `../animation/animation-group.js` 的 `AnimationGroup` 和 `tickAnimation`。
- **被以下模块依赖**：`engine.ts`、所有材质可渲染对象、所有加载器。

## 测试规范

| 测试                                         | 说明                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `createSceneContext returns valid defaults`  | 验证所有字段均与文档记录的默认值匹配                                                         |
| `addToScene routes mesh`                     | 添加 Mesh → 出现在 `meshes` 中，构建器注册到 `_deferredBuilders`                             |
| `addToScene routes light`                    | 添加 light → 出现在 `lights` 中                                                              |
| `addToScene routes shadow generator`         | 添加 ShadowGenerator → 出现在 `shadowGenerators` + `_prePasses` 中                           |
| `addToScene deduplicates builders`           | 两个具有相同 `_buildGroup` 的网格 → 仅注册一个延迟构建器                                     |
| `createDefaultCamera with meshes`            | 提供具有已知包围边界的网格，验证 radius = diag\*1.5                                          |
| `createDefaultCamera with no meshes`         | radius=1，center=(0,0,0)                                                                     |
| `deferred builders run at buildScene()`      | 注册构建器 → 验证由 `buildScene()` 调用                                                      |
| `buildScene() awaits async builders`         | 注册异步构建器 → 验证被 await                                                                |
| `rebuildSceneRenderables no-op pre-build`    | `_built === false` → 构建器不会重新运行                                                      |
| `rebuildSceneRenderables preserves features` | 天空盒/地面可渲染对象保留；组输出被替换                                                      |
| `rebuildSceneRenderables regroups meshes`    | 更换材质后的网格由其**当前**家族构建器重建                                                   |
| `rebuild retires old disposers after build`  | 先建后拆（Make-before-break）顺序；任务拥有的辅助资源不受影响                                |
| `light removal marks topology dirty`         | `_lightListVersion` 递增，安装重建钩子，销毁延迟执行                                         |
| `addToScene rejects a disposed mesh`         | 移除独占网格后再次添加 → 抛出异常，场景保持不变                                              |
| `addToScene rejects a disposed clone`        | 移除仍有克隆体持有几何体的网格后再次添加 → 抛出异常                                          |
| `removeFromScene stays idempotent`           | 两次移除克隆体的源网格 → 克隆体的几何体绝不会被销毁                                          |
| `cloneTransformNode rejects a disposed mesh` | 克隆已从最后一个场景移除的网格 → 抛出异常而非继续保留引用                                    |
| `addToScene keeps multi-scene meshes`        | 从持有某网格的两个场景之一移除该网格 → 重新添加成功                                          |
| `pre-boot material assignment regroups`      | 在 `addToScene` 后设置/替换/清除材质 → 仅由最终家族构建；变空组（含 PBR）被跳过              |
| 测试                                         | 说明                                                                                         |
| -------------------------------------------  | -------------------------------------------------------------------------                    |
| `createSceneContext returns valid defaults`  | 验证所有字段均与文档记录的默认值匹配                                                         |
| `addToScene routes mesh`                     | 添加 Mesh → 出现在 `meshes` 中，构建器注册到 `_deferredBuilders`                             |
| `addToScene routes light`                    | 添加 light → 出现在 `lights` 中                                                              |
| `addToScene routes shadow generator`         | 添加 ShadowGenerator → 出现在 `shadowGenerators` + `_prePasses` 中                           |
| `addToScene deduplicates builders`           | 两个具有相同 `_buildGroup` 的网格 → 仅注册一个延迟构建器                                     |
| `createDefaultCamera with meshes`            | 提供具有已知包围边界的网格，验证 radius = diag\*1.5                                          |
| `createDefaultCamera with no meshes`         | radius=1，center=(0,0,0)                                                                     |
| `deferred builders run at buildScene()`      | 注册构建器 → 验证由 `buildScene()` 调用                                                      |
| `buildScene() awaits async builders`         | 注册异步构建器 → 验证被 await                                                                |
| `rebuildSceneRenderables no-op pre-build`    | `_built === false` → 构建器不会重新运行                                                      |
| `rebuildSceneRenderables preserves features` | 天空盒/地面可渲染对象保留；组输出被替换                                                      |
| `rebuildSceneRenderables regroups meshes`    | 更换材质后的网格由其**当前**家族构建器重建                                                   |
| `rebuild retires old disposers after build`  | 先建后拆（Make-before-break）顺序；任务拥有的辅助资源不受影响                                |
| `light removal marks topology dirty`         | `_lightListVersion` 递增，安装重建钩子，销毁延迟执行                                         |
| `scene272-runtime-mesh-swap`                 | 在 `onBeforeRender` 中移除带纹理网格 + 添加共享其材质的克隆体 → 无已销毁资源提交，与 BJS 一致 |
| `scene273-runtime-material-family`           | 向已构建的仅含 StandardMaterial 的场景添加首个 PBR 网格 → 网格正常渲染而非被静默丢弃         |
| `scene-renderable-collection.test.ts`        | 自定义可渲染对象的 add/remove/get/onChanged 语义、构建前移除/重加、构建后移除、场景销毁      |

## 文件清单

| 文件                                       | 规模     | 用途                                                                   |
| ------------------------------------------ | -------- | ---------------------------------------------------------------------- |
| `src/scene/scene.ts`                       | ~150 行  | `SceneContext` 接口、工厂函数、实体路由、自动构图相机                  |
| `src/scene/scene-renderable-collection.ts` | ~170 行  | 内部自定义可渲染对象集合（成员管理、构建挂载、事件）                   |
