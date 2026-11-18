# 模块：精灵（Sprites）

> 包路径：`packages/babylon-lite/src/sprite/`
>
> 本文档是精灵模块独立、完整的一站式架构文档。其中定义了两类精灵家族：`Sprite2DLayer`（基础模块；像素坐标四边形，附带可选的用于“2.5D”标签的世界锚点适配器）以及 `*BillboardSpriteSystem`（世界坐标、透视校正、面向相机的四边形，支持两种当前朝向模式）。
>
> 引擎包含一个小型注册列表。两类对象实现了 `RenderingContext` 并可注册到引擎上：`SceneContext`（通过 `registerScene(scene)`）和 `SpriteRenderer`（通过 `registerSpriteRenderer(sr)`）。`startEngine(engine)` 每帧按注册顺序驱动它们一次。纯 2D 应用（Lottie/Rive 级别的应用）创建一个或多个 `SpriteRenderer` 并将其注册到引擎上——无需 `SceneContext`，也无需 `addToScene`。3D 上叠加 HUD 的应用先注册一个 `SceneContext`，再为 HUD 图层构造一个单独的 `SpriteRenderer` 并将其注册在场景之后，使其绘制在顶层；HUD 的 GPU 生命周期通过 `onSceneDispose(scene, () => disposeSpriteRenderer(hud))` 绑定到场景。带深度的 `Sprite2DLayer`（`depth: "test" | "test-write"`）通过 `addDepthHostedSpriteLayerToScene(scene, layer)` 添加。这个显式启用的精灵模块函数会注册一个延迟场景构建器；由于调用方在需要场景托管精灵时才会显式导入该函数，其对 `sprite-renderable` 的静态导入仅限于该显式启用路径。该构建器向场景插入一个通用的 `Renderable`，随后帧图按 `isTransparent` / `_direct` 将其与网格一起分桶；PBR 折射设置则单独使用 `_transmissive` 将真正的折射表面排除在不透明场景 RTT 之外。
>
> 本文档包含从零实现该模块所需的完整规范——公共 API、内部架构、GPU 布局、WGSL 组合器、拾取贡献者、生命周期、句柄、父子级关系、测试和打包体积上限。无需参考任何先前的精灵设计文档。

## 目的

可选的 [Sprite2D 实例参数扩展](sprite-instance-params.md)为自定义片段添加了一个逐精灵的 flat vec4 输入。它保持普通布局不变，并使颜色、UV 滚动、图层级着色器参数和深度相互独立。

Lite 的设计原则是“在前代基础之上构建”。精灵是 2D 四边形。世界锚定（“2.5D”）标签是其像素位置每帧由 3D 锚点计算得出的 2D 四边形。面向相机的世界尺寸公告板（billboard）则是不同的几何体（世界单位尺寸、透视近大远小、参与深度测试），因此它们仍是一个独立的家族。

该模块暴露**两个**精灵家族：

1. **`Sprite2DLayer`** —— 基础。像素坐标四边形，无视图矩阵，无透视除法，不强制要求相机。每个图层在构造时选择其深度参与方式（`depth: "none" | "test" | "test-write"`），该选项会成为管线缓存键的一部分。同一个图层工厂服务于三类调用方：
    - **纯 2D 应用**（无场景）：图层交给调用方构造并注册到引擎上的 `SpriteRenderer`。
    - **3D 场景上的 HUD 叠加层**：相同——调用方构造 `SpriteRenderer`，注册在场景之后，并通过 `onSceneDispose` 将销毁绑定到场景。HUD 图层（`depth: "none"`）**绝不**通过 `addToScene`。
    - **与 3D 网格按深度排序的深度托管精灵**（`depth: "test"` 或 `"test-write"`）：通过 `addDepthHostedSpriteLayerToScene(scene, layer)` 添加。这个显式启用函数将它们排入现有的 renderable 系统中，从而参与 3D 深度附件。

    世界锚定精灵不是独立家族。它们是带有可选 `AnchorSource` 适配器的 `Sprite2DLayer` 精灵，该适配器在 CPU 上每帧的 `_beforeRender` 钩子中运行，通过场景相机投影世界锚点，并将结果图层空间 `positionPx`（以及可选的派生逐实例 `z`）直接写入纯 2D 精灵所用的同一个逐实例槽位。其顶点着色器、逐实例布局、打包缓冲区和管线与纯 2D 图层**逐字节相同**。

2. **`*BillboardSpriteSystem`** —— 两个朝向工厂（`createFacingBillboardSystem` 和 `createAxisLockedBillboardSystem`），在当前精简的共享公告板 renderable/管线模块中具有各自不同的 WGSL 基向量路径和管线键。该模块仅在公告板系统实际排入场景时由场景添加辅助函数动态导入。
   世界坐标四边形，世界单位尺寸，透视近大远小，完整的深度参与。在场景的 3D 通道内绘制；无法在纯 2D 路径（无相机）中使用。偏航锁定（Yaw-locked）公告板是以 `[0, 1, 0]` 为锁定轴的轴锁定公告板。

写入深度的精灵可以在场景注册前选择开启 Alpha-to-Coverage：

- `setAlphaToCoverage(layer, true)` 对多重采样目标上的、带 `depth: "test-write"` 的场景托管 `Sprite2DLayer` 有效。图层保持其所选的混合模式；使用 `spriteBlendOpaque` 可实现替换颜色/深度渲染。
- `setAlphaToCoverage(system, true)` 对多重采样目标上的镂空（cutout）`BillboardSpriteSystem` 有效。A2C 变体用连续的纹理 Alpha 采样覆盖率取代二值裁切。

镂空公告板变体使用替换颜色和逐采样深度写入。纯 2D/HUD `SpriteRenderer` 图层以 1x 交换链为目标并保留正常的混合描述符；在该路径上 A2C 既无用也未启用。

`SpriteAtlas` 和 `SpriteFrame` 在两个家族之间共享。片段动画、稳定句柄对象和父子级关系是路线图模块，必须保持增量式且可独立导入，以便仅使用索引 API 的场景为其支付零字节。

### 核心支柱

- **渲染路径上无 `if`。** 家族选择、锚点模式和深度模式都在图层/系统构造时决定，并烘焙进管线缓存键中。每帧绘制遍历固定数组，没有任何逐精灵的模式判断。
- **按需付费。** 纯 2D 应用的静态导入图止步于 `engine` + `sprite-atlas` + `sprite-2d` + `sprite-renderer`。它从不导入 `scene-core`、`Camera`、`Mesh`、`LightBase`、深度/MSAA 目标、公告板 renderable/管线或锚点投影代码。Tree-shaking 会将它们全部移除。
- **一个引擎循环，两种可注册类型。** `startEngine(engine)` 每帧遍历一次 `engine._renderingContexts`。纯 2D 应用注册一个或多个 `SpriteRenderer`；3D 上带 HUD 的应用注册一个 `SceneContext`，再为 HUD 注册一个单独的 `SpriteRenderer`。深度托管的 Sprite2D 图层通过 `addDepthHostedSpriteLayerToScene` 加入，并通过现有 renderable 系统在场景的 3D 通道内绘制。引擎没有“2D 对 3D”的概念——它只是遍历注册项；场景上下文执行其帧图，精灵渲染器开启一个仅精灵的交换链通道。
- **以扩展替代硬编码。** 锚定机制仍是一个可 tree-shake 的路线图附加项，仅当场景实际使用世界锚点时才应导入。公告板场景渲染位于 `billboard-scene.ts` 之后；仅导入公告板系统工厂不会导入场景 renderable、管线或 WGSL 主体。

## 分类学 —— 两大精灵家族

| 家族                     | 变体                              | 坐标空间                                             | 尺寸单位 | 深度                           | 绘制方式                                                                                                                            |
| ------------------------ | --------------------------------- | ---------------------------------------------------- | -------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Sprite2DLayer`          | 1 种（带可选 `AnchorSource`）     | 像素（图层空间；锚定精灵经 CPU 投影）                | 像素     | 逐图层配置（组合器烘焙）       | 注册在引擎上的 `SpriteRenderer`（纯 2D，或注册在场景之后的 3D 上 HUD），或针对 `depth: "test" \| "test-write"` 图层的场景 3D 通道 |
| `*BillboardSpriteSystem` | 2 种：`Facing`、`AxisLocked`      | 世界空间                                             | 世界单位 | 读取；写入可配置               | 场景的 3D 通道（无纯 2D 路径）                                                                                                      |

### 为什么锚定精灵不再是一个独立家族

朴素的设计会将 `Sprite2DLayer` 和 `AnchoredSpriteLayer` 拆分为两个家族，因为锚定精灵需要 `viewProjection` 来投影其世界锚点，且需要被 3D 几何体遮挡的锚定精灵需要深度附件。那种分家族设计会拥有自己的 WGSL 组合器、自己的 112 字节实例步长（worldPos + offsetPx + depthBias），以及自己的 GPU 顶点阶段投影。

那种结构之所以错误，基于三个具体原因：

1. **实际差异只是每个锚定精灵每帧的一次 CPU 运算。** 将世界锚点通过 `viewProjection` 投影、除以 `w`、缩放到视口像素，然后将结果写入纯 2D 精灵使用的同一个 `positionPx[2]` 槽位。这只是一次 Mat4 × Vec4（16 次 FMA）加上 2 次乘法和 2 次加法。对于典型的锚定数量（HUD 图钉、铭牌、地图标记——几十到几百个），这每帧只需几微秒。在 CPU 上执行使 GPU 管线、逐实例布局、打包缓冲区步长和 WGSL 顶点着色器与纯 2D 图层**逐字节完全一致**。

2. **深度参与是逐渲染通道附件的决策，而不是逐家族的决策。** 将其建模为家族会把通道级约束泄漏到图层类型中，并迫使公共 API 选择某一种固定形态（“anchored”），而不是让任何 2D 图层都能显式启用深度测试。按图层建模（`depth: "none" | "test" | "test-write"`）才是正确的粒度。每个值都是组合时烘焙一次的管线缓存键位——运行时绝不分支。

3. **3D 场景 UBO（viewProjection + 相机基向量 + 视口）原本仅仅是为了 GPU 投影锚点而付出的代价。** 一旦我们在 CPU 上投影，锚定图层就完全不需要那个 UBO（相机基向量仅作为 CPU 投影辅助函数所消费的 `viewProjection` 矩阵出现，而 `viewportPx` 已经存在于纯 2D 场景 UBO 中）。3D 场景 UBO 成为仅服务于公告板的产物，这原本就是它的本质。

路线图中的“anchor”是一个小接口：

```typescript
export interface AnchorSource {
    /** Project this anchor for the current frame.
     *  Writes into outPx (length 2) and outZ (length 1, view-space depth).
     *  Returns false to hide the sprite this frame (off-screen, behind camera, parent not yet built). */
    readonly project: (outPx: Float32Array, outZ: Float32Array, scene: SceneContext) => boolean;
}
```

`AnchorSource` 应位于独立的 `sprite/anchor/sprite-anchor.ts` 模块中。从不实例化锚点的场景绝不能导入该模块，也不应为相机基向量投影代码付出体积代价。

### 为什么公告板仍然保留为独立家族

公告板不是“Sprite2D + 另一种锚点源”。它们的差异在于逐顶点计算，而不是逐 CPU 更新：

- **世界单位尺寸。** 公告板四边形在投影**之前**沿相机基向量按世界单位挤出（`cameraRight * sizeWorld.x + cameraUp * sizeWorld.y`），这会产生正确的透视近大远小效果。锚定精灵则在投影**之后**在像素空间挤出。这是完全相反的契约（尺寸随距离缩小 vs. 尺寸不随距离变化）——也是各自变体存在的全部意义。

- **逐顶点相机基向量。** 每种公告板变体都会逐顶点地根据相机（`Facing`）或根据锁定轴加相机方向（`AxisLocked`，其中包含作为 `[0, 1, 0]` 的偏航锁定）计算 `(right, up)`。纯 2D 顶点着色器完全没有相机基向量输入，且不打包任何相机基向量代码。

- **深度写入语义。** 镂空公告板写入深度（以便它们与不透明网格互相遮挡/投射）；锚定精灵从不写入深度。

强行将公告板塞入 Sprite2D 管线要么需要逐顶点的 `if (isBillboard) { compute world basis } else { compute pixel offset }`（违反渲染路径无 `if` 的规则），要么需要 CPU“投影四个角”路径（对树木森林每帧执行 O(N×4) 次 Mat4×Vec4，正是公告板顶点着色器技巧旨在避免的开销）。将它们拆开是正确的。

两个朝向工厂保持显式（`createFacingBillboardSystem`、`createAxisLockedBillboardSystem(atlas, axis, opts)`）——两条着色器基向量路径，两个管线键，没有 `axisLock?: 'none'|'y'|Vec3` 标志。偏航锁定公告板就是 `createAxisLockedBillboardSystem(atlas, [0, 1, 0], opts)`。

### 刻意未添加的模式

- **世界对齐的非公告板精灵** —— 请使用带有纹理 Alpha 混合材质的 `Mesh`。
- **瓦片地图（类 `SpriteMap`）** —— 留作独立的未来模块。
- **带平移/缩放的 2D 相机场景** —— 这就是 `Sprite2DLayer.view`（逐图层平移 + 缩放 + 旋转），无需额外家族。

## 决议：一个引擎循环，两种可注册类型

**决策：引擎拥有单一的注册列表。两类对象实现 `RenderingContext` 并可注册到引擎：`SceneContext`（通过 `registerScene(scene)`）和 `SpriteRenderer`（通过 `registerSpriteRenderer(sr)`）。`startEngine(engine)` 每帧按顺序遍历一次 `engine._renderingContexts`。引擎拥有该帧的命令编码器和交换链视图；每个上下文针对当前帧状态运行 `_update()` 和 `_record()`。`SceneContext` 通过其 `FrameGraph`（通常为默认交换链 `RenderTask`）进行录制，而 `SpriteRenderer` 直接在交换链上开启自己的精灵通道。纯 2D 应用（Lottie/Rive 级别的应用）创建一个或多个 `SpriteRenderer` 并将其注册到引擎——它们从不触碰 `SceneContext`。3D 上带 HUD 的应用先注册 `SceneContext`，为 HUD 图层构造独立的 `SpriteRenderer` 并将其注册在场景之后以绘制在顶层，并通过 `onSceneDispose(scene, () => disposeSpriteRenderer(hud))` 将其销毁绑定到场景。深度托管的 Sprite2D 图层（`depth: "test" | "test-write"`）通过 `addDepthHostedSpriteLayerToScene` 添加，后者通过场景的通用可选 renderable 钩子注册一个延迟构建器。该钩子向场景插入一个通用 renderable，使其在场景的 3D 通道内部与 3D 网格排序并合成。**

`SceneContext` 的结构、`addToScene` 的 switch 主体以及默认帧图均保持与精灵无关。精灵模块不会引入第二种场景类型或向 `SceneContext` 添加隐式 HUD 图层列表；合成组合在引擎注册层级保持显式。

### 被否决的替代方案

| 替代方案 | 否决原因 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增与 `SceneContext` 平行的 `Scene2DContext` | 为同一操作引入了两套平行的 API。两种可注册对象已经共享 `RenderingContext` —— 不需要新的总括类型。 |
| 强制纯 2D 应用走 `SceneContext` | 会使 Lottie/Rive 级别的应用背负 `SceneContext` 的形态以及它隐含的所有逐帧分支。纯 2D 体验不应为场景基础设施付出代价。 |
| 纯 2D 用户自己拥有 `requestAnimationFrame` 循环并调用自由函数 `renderSprite2DLayers(engine, layers, target)` | 两个不同的循环所有者（基于场景用引擎，纯 2D 用用户）意味着两套首帧就绪握手、两套固定时间步长契约、两套设备丢失恢复路径。通过 `register*` 让引擎成为唯一循环所有者具有更小的接口面积且符合帧图形态。 |
| 通过 `addToScene` 自动路由 HUD 图层，并让 `registerScene` 惰性创建并注册内部 `SpriteRenderer` | 会为没有 HUD 的场景增加字节（所有人都要为惰性初始化代码路径买单），将精灵模块的生命周期与场景模块耦合，并使“引擎上注册了什么”对调用方不透明。显式的 `createSpriteRenderer + registerSpriteRenderer + onSceneDispose` 只需三行调用方代码，且对非 HUD 场景为零字节。 |
| 将 `addToScene` 重构为实体上的方法路由 + 逐阶段包装器 | 公共对象必须保持纯状态；可选的场景托管系统使用独立的添加辅助函数加上通用的延迟 renderable 钩子，而不是将行为附加到公共数据上。 |
| 将所有精灵 GPU 细节提取到场景渲染循环中 | 将精灵渲染耦合到场景编排中。届时纯 2D 路径要么重新实现 GPU 绘制（分叉），要么拉入场景基础设施以访问它们（浪费字节）。 |

### 引擎的注册列表

```typescript
// src/engine/engine.ts — sprite support adds nothing here;
// this is the existing RenderingContext shape that both SceneContext
// and SpriteRenderer implement.

/** A thing that can be registered with an engine and driven once per frame. */
export interface RenderingContext {
    /** Draw calls produced by pre-pass work during `_update` (shadows + pre-passes). */
    _drawCallsPre: number;
    /** Clear color used when this context is the first active one in a frame. */
    clearColor: GPUColorDict;
    /** Per-frame update: beforeRender hooks, shadow + pre-passes, UBO updates. */
    _update(): void;
    /** Record frame work using the engine's current encoder/swapchain view. Returns draw-call count. */
    _record(): number;
}

/** @internal Inside EngineContext: */
//   _renderingContexts: RenderingContext[];

export function registerRenderingContext(engine: EngineContext, context: RenderingContext): boolean;
export function unregisterRenderingContext(engine: EngineContext, context: RenderingContext): boolean;

/** Drive the engine's render loop. Walks _renderingContexts in order, once per frame. */
export function startEngine(engine: EngineContext): Promise<void>;
```

`startEngine` 在注册成功后的第一帧 resolve。每帧中引擎获取交换链视图并创建一个命令编码器，然后把它们存储在当前帧的内部引擎状态上。它按顺序在每个已注册上下文上调用 `_update()` 和 `_record()`。场景上下文执行其帧图任务；精灵渲染器录制一个仅精灵的交换链通道。没有任何每帧的 `if (is2D)` 分支；循环只是遍历执行。

### `SpriteRenderer`

```typescript
// src/sprite/sprite-renderer.ts
import type { EngineContext, RenderingContext } from "../engine/engine.js";
import type { Sprite2DLayer } from "./sprite-2d.js";

/** Options accepted by `createSpriteRenderer`. */
export interface SpriteRendererOptions {
    /** Layers to draw, in registration order. The renderer also re-sorts internally
     *  by `layer.order` each frame (TimSort is O(n) on already-sorted input). */
    layers: readonly Sprite2DLayer[];
    /** Default true. Set false for HUD overlays so the sprite pass preserves existing scene color. */
    clear?: boolean;
    /** Default `{ r: 0, g: 0, b: 0, a: 1 }`. Used when `clear` is true. */
    clearValue?: GPUColorDict;
}

/** A `SpriteRenderer` — pure data, plugs into `engine._renderingContexts`. */
export interface SpriteRenderer extends RenderingContext {
    readonly _kind: "sprite-renderer";
    /** Renderer-owned layer membership. Use add/remove helpers to mutate. */
    readonly layers: readonly Sprite2DLayer[];
}

export function createSpriteRenderer(engine: EngineContext, opts: SpriteRendererOptions): SpriteRenderer;
export function addSpriteRendererLayer(sr: SpriteRenderer, layer: Sprite2DLayer): void;
export function removeSpriteRendererLayer(sr: SpriteRenderer, layer: Sprite2DLayer): boolean;
export function registerSpriteRenderer(sr: SpriteRenderer): void;
export function unregisterSpriteRenderer(sr: SpriteRenderer): void;
export function disposeSpriteRenderer(sr: SpriteRenderer): void;
/** Redirect output to an offscreen render texture (render-to-texture), or null = swapchain.
 *  See "Offscreen render target" below. */
export function setSpriteRendererTarget(sr: SpriteRenderer, target: Texture2D | null): void;
```

`SpriteRenderer` **不**拥有持久的颜色/深度附件。在 `_record` 期间，它使用 `sampleCount = 1`、引擎交换链格式以及无深度附件直接在每帧交换链视图上开启一个仅精灵的渲染通道。`clear: false` 使通道使用 `loadOp: "load"`，即 3D 场景已解析到交换链之后使用的 HUD 路径。纯 2D 图层使用不含 Z 属性的 40 字节（注：实际含颜色为 52 字节）实例布局；深度托管图层使用带逐实例 Z 的布局。

在内部，`SpriteRenderer._update`：

1. 刷新缓存的目标尺寸（画布可能已调整大小）。
2. 按 `layer.order` 就地排序渲染器拥有的图层列表（单图层情况跳过）。
3. 对每个可见的非空图层：确保 GPU 资源存在，并仅当数据实际发生变化时（与上一次写入字节的 CPU 端影子副本比较）才通过 `device.queue.writeBuffer` 写入逐实例数据和逐图层 UBO。

在内部，`SpriteRenderer._record`：

1. 对每个可见的非空图层：查找（或构建并缓存）一个烘焙了 `setIndexBuffer` + `setPipeline` + `setBindGroup` + `setVertexBuffer` + `drawIndexed(6, count)` 的 `GPURenderBundle`。仅当图层的精灵数量变化或其实例缓冲区重新分配时才重建该 bundle。
2. 用一个复用的 `pass.executeBundles(...)` 数组重放所有可见 bundle——跳过了逐次调用的 WebGPU 验证与 IPC，在稳态下 CPU 开销接近于零。

`SpriteRenderer` 是 HUD/纯 2D 精灵 GPU 绘制逻辑的唯一归宿。深度托管的 Sprite2D 图层（`depth: "test" | "test-write"`）不经过它——它们由 `sprite-renderable.ts` 产出的独立 `Renderable` 绘制（见下文“调用方 2”）。

### 离屏渲染目标（渲染到纹理）

默认情况下，`SpriteRenderer` 在每帧交换链视图上录制其通道（`rr._targetView ?? eng._swapchainView`）。两个小巧的、**显式启用且可 tree-shake** 的附加函数使渲染器能够改为绘制到离屏纹理中，这也是全屏后处理的构建基石（平台跳跃演示中的 CRT/扫描线效果完全基于它们构建——没有任何定制引擎通道）：

```typescript
// src/texture/pixels-texture.ts
export interface RenderTexture2DOptions {
    addressModeU?: GPUAddressMode; // default 'clamp-to-edge'
    addressModeV?: GPUAddressMode; // default 'clamp-to-edge'
    minFilter?: GPUFilterMode; // default 'linear'
    magFilter?: GPUFilterMode; // default 'linear'
    format?: GPUTextureFormat; // default engine.format (REQUIRED for a SpriteRenderer target)
}
/** An empty Texture2D usable as BOTH a render target and a sampled texture
 *  (RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_DST). */
export function createRenderTexture2D(engine: EngineContext, width: number, height: number, options?: RenderTexture2DOptions): Texture2D;

// src/sprite/sprite-renderer.ts
/** Point a renderer at an offscreen render texture (`Texture2D`), or null for the swapchain (default). */
export function setSpriteRendererTarget(sr: SpriteRenderer, target: Texture2D | null): void;
```

两者均默认指向交换链 / 交换链格式，因此**每一个现有场景和示例都逐字节不受影响**，并且未使用时整个能力会被 tree-shake 掉（`createRenderTexture2D` 是独立导入；`_targetView` 默认为 `null`）。

> **格式约束：** `SpriteRenderer` 目标必须使用 `engine.format`。精灵管线是以该格式创建的，而 WebGPU 会拒绝颜色附件格式与绑定管线不同的渲染通道（在通道开始时发生验证错误）。因此对于任何传给 `setSpriteRendererTarget` 的纹理，请将 `RenderTexture2DOptions.format` 保持为默认值；自定义格式仅适用于由其他通道驱动的离屏目标（例如 `EffectRenderer`）。

渲染到纹理模式由两个按顺序注册的渲染器组成：

1. **场景通道** → `setSpriteRendererTarget(scene, rt)`，使其绘制到离屏 `rt = createRenderTexture2D(engine, w, h)`（大小与画布后备存储一致，采用交换链格式以便采样和呈现）。
2. **呈现通道** → 第二个 `SpriteRenderer`，拥有一个全屏图层，其图集**就是** `rt`（通过 `createGridSpriteAtlas`），并使用自定义着色器片段（例如 CRT 曲率 + 扫描线）进行绘制。它以交换链为目标（`target = null`）并注册在场景通道**之后**，因此第二个运行并采样完成后的帧。关闭该效果只需调用 `setSpriteRendererTarget(scene, null)` + 注销呈现通道——恢复到零开销的直接路径。

在画布调整大小时必须重建离屏纹理和呈现图层（RT 是固定尺寸的 GPU 纹理）。完整的可开关实现见 `lab/lite/src/demos/platformer/crt.ts`。

### 调用方 1：纯 2D —— 无 `SceneContext`

Lottie/Rive 级别的应用从不创建场景。它创建一个 `SpriteRenderer`，注册到引擎，并让 `startEngine` 驱动循环：

```typescript
const engine = await createEngine(canvas);
const atlas = await loadSpriteAtlas(engine, "sprites.png", { gridSize: [32, 32] });
const layer = createSprite2DLayer(atlas);
addSprite2DIndex(layer, { positionPx: [100, 200], sizePx: [64, 64], frame: 0 });

const sr = createSpriteRenderer(engine, {
    layers: [layer],
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
});
registerSpriteRenderer(sr);

await startEngine(engine);
```

静态导入图精确地为：`engine` + `sprite-atlas` + `sprite-2d` + `sprite-renderer`。没有其他任何东西。没有 `SceneContext`、没有 `addToScene`、没有 `registerScene`、没有 `Camera`、没有 `Mesh`、没有 `LightBase`、没有深度/MSAA 目标分配器、没有 PBR、没有 Standard、没有阴影生成器、没有动画组遍历器、没有锚点投影、没有公告板变体。

此路径不支持锚定精灵——因为没有可供投影的相机。它们需要下面的基于场景的路径。

### 调用方 2：基于场景 —— `registerScene` + `addToScene` + 独立的 HUD `SpriteRenderer`

新的 `registerScene(scene)` 是场景侧对应于 `registerSpriteRenderer` 的操作。它运行场景的延迟构建器，并将场景作为 `RenderingContext` 注册到引擎上。之后，`startEngine(engine)` 每帧驱动该场景，就像驱动其他已注册上下文一样。

```typescript
export function registerScene(scene: SceneContext): Promise<void>;
export function unregisterScene(scene: SceneContext): void;

/** Register a callback to fire when `disposeScene(scene)` is called.
 *  Used to tie user-owned GPU resources (e.g. a HUD `SpriteRenderer`)
 *  to the scene's lifetime — mirrors `onBeforeRender`. */
export function onSceneDispose(scene: SceneContext, cb: () => void): void;
```

深度托管图层是一个场景自定义 renderable 集合（见 [01-scene.md § 自定义 renderable 集合](01-scene.md#自定义可渲染对象集合)），独立于 `addToScene` / `onSceneChange`。这些显式启用辅助函数静态导入精灵拥有的 renderable 构建器，因为调用它们即代表显式选择了该特性：

```typescript
// src/sprite/sprite-scene.ts
export function addDepthHostedSpriteLayerToScene(scene: SceneContext, layer: Sprite2DLayer): void; // idempotent; throws for depth "none"
export function removeDepthHostedSpriteLayerFromScene(scene: SceneContext, layer: Sprite2DLayer): boolean; // false when not a member
export function getSceneDepthHostedSpriteLayers(scene: SceneContext): readonly Sprite2DLayer[]; // add-order snapshot
export function onSceneDepthHostedSpriteLayersChanged(scene: SceneContext, listener: SceneRenderableChangeListener<Sprite2DLayer>): () => void;
```

`buildSpriteRenderable` 会拒绝 `depth: "none"`，因为场景 renderable 需要深度策略。`addDepthHostedSpriteLayerToScene` 在将工作入队前执行相同的检查。HUD 图层直接使用 `SpriteRenderer`。移除操作会立即停止该图层场景 renderable 的绘制，并在进行中的帧结束后回收其场景构建的 GPU 资源；图层本身（实例数据、图集）仍由调用方拥有并可重新添加。

现有的 `"billboard-sprite-system"` 分支保持现状（拥有其自身的 `_deferredBuild` 钩子）；公告板被推入现有的场景级 renderable 数组中。

`registerScene(scene)` 精确地做两件事：运行每一个排队的 `_deferredBuild`（从而将深度托管精灵 renderable 接入场景的 `_renderables` 列表），然后调用 `registerRenderingContext(engine, scene)`。**它不会创建或注册任何 HUD `SpriteRenderer`** —— HUD 完全是调用方的显式关注点（见下文）。

端到端示例（3D 上的 HUD 场景，镜像 `lab/lite/src/lite/scene52.ts`）：

```typescript
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);

addToScene(scene, createDirectionalLight([0, -1, 0]));
addToScene(scene, await loadGltf(engine, "world.glb"));
const trees = createAxisLockedBillboardSystem(treeAtlas, [0, 1, 0]);
addBillboardSystemToScene(scene, trees);

// Depth-hosted anchored labels: same Sprite2DLayer factory, depth:"test"
// routes it through addDepthHostedSpriteLayerToScene → sprite-renderable, drawn
// inside the scene's 3D pass.
const labels = createSprite2DLayer(labelAtlas, { depth: "test" });
addAnchoredSprite2D(labels, {
    anchor: createWorldAnchor([0, 1.8, 0]),
    sizePx: [128, 32],
    frame: "name-bg",
});
addDepthHostedSpriteLayerToScene(scene, labels);

await registerScene(scene);

// HUD overlay: separate Sprite2DLayer with depth:"none", drawn by a
// separate SpriteRenderer registered AFTER the scene so it draws on top.
// `addToScene` is never called for HUD layers — they have no business
// in the 3D pass.
const hud = createSprite2DLayer(hudAtlas, { depth: "none" });
addSprite2DIndex(hud, { positionPx: [16, 16], sizePx: [200, 32], frame: "score" });
const hudRenderer = createSpriteRenderer(engine, { layers: [hud], clear: false });
registerSpriteRenderer(hudRenderer);
// Tie HUD lifetime to the scene — disposeScene fires this and frees the GPU buffers.
onSceneDispose(scene, () => disposeSpriteRenderer(hudRenderer));

await startEngine(engine);
```

核心结论：**一个** `createSprite2DLayer` 工厂与一套公共索引 API，逐图层实例布局在创建时固定。`depth` 选项决定图层最终走哪条路径：

- `depth: "none"` → 调用方将图层交给 `SpriteRenderer`（纯 2D 或 HUD）；绝不经过 `addToScene`。该图层使用 13 浮点数 / 52 字节实例布局，且纯 2D 着色器保持裁剪空间 Z 恒定。
- `depth: "test" | "test-write"` → 调用方将图层传给 `addDepthHostedSpriteLayerToScene`，后者在显式启用的场景集成模块内部静态导入深度托管 renderable 构建器；图层在场景的 3D 通道内绘制，并按逐实例 Z 与网格排序。该图层使用 14 浮点数 / 56 字节布局，槽位 `[13]` 作为 `@location(6) iZ` 暴露给着色器。

下文描述的世界锚点适配器属于路线图规划。当前的深度托管实现接受显式的逐精灵 `z` 值，尚未暴露锚点辅助函数。

---

## 公共 API 接口

### 共享 —— 图集与帧

```typescript
// src/sprite/shared/sprite-atlas.ts
import type { EngineContext } from "../../engine/engine.js";
import type { Texture2D, Texture2DOptions } from "../../texture/texture-2d.js";

export type SpriteSampling = "linear" | "nearest";

/** A single frame in an atlas. UVs in [0,1]; pivot in [0,1] of the frame. */
export interface SpriteFrame {
    readonly name?: string;
    readonly uvMin: readonly [number, number];
    readonly uvMax: readonly [number, number];
    readonly sourceSizePx: readonly [number, number];
    readonly pivot: readonly [number, number];
}

export interface SpriteAtlas {
    readonly texture: Texture2D;
    readonly textureSizePx: readonly [number, number];
    readonly frames: readonly SpriteFrame[];
    readonly premultipliedAlpha: boolean;
}

export interface GridAtlasOptions {
    cellWidthPx: number;
    cellHeightPx: number;
    columns?: number;
    rows?: number;
    marginPx?: number;
    spacingPx?: number;
    pivot?: readonly [number, number];
    premultipliedAlpha?: boolean;
}

export interface LoadAtlasOptions {
    gridSize?: readonly [number, number];
    /** Reserved for a future TexturePacker-style JSON loader. Throws today. */
    metadataUrl?: string;
    sampling?: SpriteSampling;
    premultipliedAlpha?: boolean;
    premultiplyOnLoad?: boolean;
    textureOptions?: Texture2DOptions;
}

export function loadSpriteAtlas(engine: EngineContext, textureUrl: string, options?: LoadAtlasOptions): Promise<SpriteAtlas>;
export function createGridSpriteAtlas(texture: Texture2D, options: GridAtlasOptions): SpriteAtlas;
/** @internal */
export function resolveSpriteFrame(atlas: SpriteAtlas, frame: number): number;
```

`SpriteAtlas` 是共享资源：同一个图集可以支撑跨一个或多个场景的多个图层/系统。它的 `Texture2D` 在 `loadSpriteAtlas` 时一次性上传。图层持有引用；只有当没有任何图层持有图集时它才会被释放（常规 `Texture2D` 生命周期）。

`SpriteFrame.pivot` 处于帧的归一化 `[0, 1]` 范围内——`(0.5, 0.5)` 将四边形居中于精灵的锚点。目前帧通过数字索引寻址。命名帧、片段动画和 TexturePacker 元数据属于路线图扩展，且落地时必须不向数字索引调用方增加任何字节。

### 家族 1 —— `Sprite2DLayer`（基础）

```typescript
// src/sprite/sprite-2d.ts
import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import type { SpriteBlendDescriptor } from "./sprite-blend.js";
import type { Sprite2DCustomShader } from "./sprite-custom-shader.js";

// Blend modes are importable, pure-data descriptor values (see `sprite-blend.ts`), not a
// string union. `SpriteBlendMode` is a type alias of `SpriteBlendDescriptor`; pass one of the
// exported `spriteBlend*` values as `Sprite2DLayerOptions.blendMode`.
export type SpriteBlendMode = SpriteBlendDescriptor;
export type Sprite2DDepthMode = "none" | "test" | "test-write";

export interface Sprite2DView {
    positionPx: [number, number];
    zoom: number;
    rotation: number;
}

export interface Sprite2DLayerOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    opacity?: number;
    visible?: boolean;
    order?: number;
    view?: Partial<Sprite2DView>;
    /**
     * Layer-wide rotation / scaling pivot in normalised sprite-local space
     * (`[0,0]` = top-left, `[0.5, 0.5]` = center, `[1,1]` = bottom-right).
     * Defaults to `[0.5, 0.5]`. Per-sprite pivot is a future PR — most 2D
     * HUD layers want one uniform pivot anyway.
     */
    pivot?: [number, number];
    /**
     * Depth participation:
     *  - "none"        (default) → drawn by a `SpriteRenderer` registered on the engine. Pipeline has no depth attachment; the per-instance layout has no Z slot. HUD overlays must use this mode and live on a `SpriteRenderer` (not on `addDepthHostedSpriteLayerToScene`).
     *  - "test"                  → drawn inside the scene's 3D pass via `addDepthHostedSpriteLayerToScene` with `depthCompare: "greater-equal"`, `depthWrite: false`. Sprites occlude behind 3D geometry but do not write depth.
     *  - "test-write"            → drawn inside the scene's 3D pass via `addDepthHostedSpriteLayerToScene` with `depthCompare: "greater-equal"`, `depthWrite: true`. Sprites direct-draw after cached opaque meshes and before transparent renderables.
     *  Each value is a pipeline-cache key bit, baked at composition time. No runtime branch.
     *  Pure-2D engines (no scene) can only use `"none"` — they have no depth attachment.
     */
    depth?: Sprite2DDepthMode;
    /**
     * Opt-in per-layer custom fragment shader (see `createSprite2DCustomShader`). Works on both
     * pure-2D (`depth: "none"`) and depth-hosted (`depth: "test" | "test-write"`) layers. Drives
     * procedural effects (animated sky, clouds, water/heat shimmer, twinkle, vignette) from a
     * built-in `fx.time` clock plus an optional `fx.params` vec4 set via `setSprite2DShaderParams`.
     * Absent on plain layers, so the always-loaded path carries zero custom-shader bytes (see
     * `sprite-fx-hook.ts`).
     */
    customShader?: Sprite2DCustomShader;
    /**
     * Default per-instance NDC depth (`0` = near, `1` = far) for sprites added to this
     * layer when their `Sprite2DProps.z` is omitted. Only stored and consumed by `depth: "test" |
     * "test-write"` layers; HUD/pure-2D layers use a 13-float layout and allocate no
     * per-instance Z attribute. Defaults to `0.5`. Mutating `layer.layerZ` after
     * sprites have been added does **not** retroactively change them — call
     * `updateSprite2DIndex(layer, idx, { z: … })` to move an existing sprite.
     */
    layerZ?: number;
    /**
     * Opt-in per-sprite UV scroll. When `true`, every sprite gains two extra instance floats
     * (`uvOffset.xy`) added to its sampled UV in the vertex stage — enabling parallax /
     * infinite-scroll backgrounds. Set the offset per sprite via `Sprite2DProps.uvOffset` (on add)
     * or `setSprite2DUvOffset` (live). Layers created without `uvScroll` keep the narrow 13/14-float
     * layout, the base vertex attributes, and the base WGSL — they ship none of the widening; the
     * wider stride, the extra `@location(7)` attribute, and the `+ iUvOffset` WGSL are gated on this
     * flag. Pairs naturally with a tileable atlas sampled in `repeat` wrap mode. Defaults to `false`.
     */
    uvScroll?: boolean;
}

export interface Sprite2DLayer {
    readonly _entityType: "sprite-2d-layer";
    readonly atlas: SpriteAtlas;
    readonly depth: Sprite2DDepthMode;
    readonly blendMode: SpriteBlendMode;
    opacity: number;
    visible: boolean;
    order: number;
    view: Sprite2DView;
    pivot: [number, number];
    /**
     * Opt-in custom fragment shader; see `Sprite2DLayerOptions.customShader`. **Absent** (not
     * `null`) on plain layers — never default-initialized, so the always-loaded path carries zero
     * custom-shader bytes (see `sprite-fx-hook.ts`).
     */
    readonly customShader?: Sprite2DCustomShader;
    /**
     * User `fx.params` vec4 fed to a custom shader each frame; mutate via `setSprite2DShaderParams`.
     * **Absent** on plain layers (allocated only for custom-shader layers, or lazily by the setter).
     */
    shaderParams?: [number, number, number, number];
    /**
     * Opt-in per-sprite UV-scroll flag; see `Sprite2DLayerOptions.uvScroll`. **Absent** (not
     * `false`) on plain layers, so non-scroll scenes keep the narrow layout and base shader. Present
     * (`true`) only when the layer was created with `uvScroll: true`, which widens the instance
     * stride by two floats (`uvOffset.xy`).
     */
    readonly _uvScroll?: boolean;
    /** Default per-instance Z applied to newly added sprites whose `Sprite2DProps.z` is omitted. */
    layerZ: number;
    readonly count: number;
}

export interface Sprite2DProps {
    positionPx: [number, number];
    sizePx?: [number, number];
    /** Atlas-frame index. Pre-resolved at the call site (e.g. via `getSpriteAtlasFrameIndex`). */
    frame?: number;
    rotation?: number;
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
    /** Reserved for clip animation (later PR). Accepted but unused today. */
    clip?: unknown;
    /**
     * Per-sprite NDC depth (`0` = near, `1` = far). Only consumed by depth-hosted layers
     * (`depth: "test" | "test-write"`); pure-2D / HUD layers ignore it. When omitted on
     * add, defaults to the owning layer's `layerZ` at the moment of insertion. When omitted
     * on update, the sprite's existing Z is preserved.
     */
    z?: number;
    /**
     * Per-sprite UV-scroll offset, added to the sampled UV in the vertex stage. Only consumed by
     * `uvScroll` layers (created with `Sprite2DLayerOptions.uvScroll: true`); non-scroll layers use
     * the narrow 13/14-float layout and allocate no uvOffset slot. Defaults to `[0, 0]` on add;
     * preserved when omitted on update. Live updates: `setSprite2DUvOffset`.
     */
    uvOffset?: [number, number];
}

export function createSprite2DLayer(atlas: SpriteAtlas, opts?: Sprite2DLayerOptions): Sprite2DLayer;

// Index API — low-level, parallels ThinInstance.
export function addSprite2DIndex(layer: Sprite2DLayer, props: Sprite2DProps): number;
export function updateSprite2DIndex(layer: Sprite2DLayer, index: number, patch: Partial<Sprite2DProps>): void;
export function removeSprite2DIndex(layer: Sprite2DLayer, index: number): void;
export function clearSprite2DLayer(layer: Sprite2DLayer): void;
export function setSprite2DFrameIndex(layer: Sprite2DLayer, index: number, frame: number): void;
// Custom-shader + UV-scroll setters (no-ops / cheap on layers that did not opt in).
export function setSprite2DShaderParams(layer: Sprite2DLayer, params: readonly [number, number, number, number]): void;
export function setSprite2DUvOffset(layer: Sprite2DLayer, index: number, uvOffset: readonly [number, number]): void;
```

### Sprite2D 视图工具

`sprite-2d-view.ts` 拥有与 Sprite2D 顶点着色器所用相同变换的 CPU 形式。视图将其 `positionPx` 映射到逻辑屏幕 `(0, 0)`，然后应用 `rotation` 和 `zoom`。屏幕尺寸和坐标为带有左上角原点的后备存储像素。`Bounds2D` 是可复用的数学类型；可见边界辅助函数将世界空间值写入其中。

```typescript
export interface Bounds2D {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export function sprite2DWorldToScreenToRef<T extends Vec2>(view: Sprite2DView, worldX: number, worldY: number, result: T): T;
export function sprite2DScreenToWorldToRef<T extends Vec2>(view: Sprite2DView, screenX: number, screenY: number, result: T): T;
export function getSprite2DVisibleBoundsToRef<T extends Bounds2D>(view: Sprite2DView, screenWidthPx: number, screenHeightPx: number, result: T): T;
export function centerSprite2DView<T extends Sprite2DView>(view: T, worldX: number, worldY: number, screenWidthPx: number, screenHeightPx: number): T;
```

对于 `SpriteRenderer` 以及通过完整相机视口渲染的深度托管图层，逻辑屏幕坐标即为绝对帧缓冲区坐标。指针调用方首先按画布后备存储缩放比例转换 CSS 像素。在非全屏相机视口下渲染的深度托管图层仍然将整个渲染目标保留为其逻辑屏幕尺寸，因为渲染通道是在 Sprite2D 顶点变换之后才应用相机视口的。请使用 `resolveCameraViewport`，然后先重映射绝对帧缓冲区点再对其进行反投影：

```typescript
const screenX = ((framebufferX - viewport.x) * targetWidth) / viewport.width;
const screenY = ((framebufferY - viewport.y) * targetHeight) / viewport.height;
sprite2DScreenToWorldToRef(layer.view, screenX, screenY, worldPosition);
```

逆映射将投影后的 Sprite2D 点置于绝对帧缓冲区中：`framebufferX = viewport.x + screenX * viewport.width / targetWidth`，Y 方向表达式同理。请向 `getSprite2DVisibleBoundsToRef` 和 `centerSprite2DView` 传递完整的渲染目标宽度和高度，而不是相机视口缩小后的像素尺寸。

`ToRef` 函数写入调用方拥有的对象，居中函数原地修改传入的视图，因此稳态相机和剔除更新不产生任何分配。负缩放仍然合法并镜像渲染器。逆投影、可见边界和居中函数在 `zoom === 0`（不存在逆矩阵）时抛出异常；世界到屏幕投影仍与渲染器保持一致并坍缩到 `(0, 0)`。

该模块仅包含类型导入和纯函数。`sprite-2d.ts`、`sprite-pipeline.ts` 或渲染循环中均不导入它，因此不引用这些辅助函数的应用不会保留任何运行时字节或分支。

Handle API（`addSprite2D` / `removeSprite2D`，返回带稳定 id 的 `Sprite2DHandle`）位于可独立导入的 `sprite-2d-handle.ts` 模块中，因此仅使用索引 API 的场景不会拉取句柄代码、映射表或类型化数组（见[句柄、身份与父子级关系](#句柄身份与父子级关系)）。可观察字段和父子级关系仍是增量式的后续模块。

```typescript
// src/sprite/sprite-2d-handle.ts — optional, tree-shakable Handle API.
export interface Sprite2DHandle {
    readonly _entityType: "sprite-2d-handle";
    readonly layer: Sprite2DLayer;
    readonly id: number;
}

export function addSprite2D(layer: Sprite2DLayer, props: Sprite2DProps): Sprite2DHandle;
export function updateSprite2D(handle: Sprite2DHandle, patch: Partial<Sprite2DProps>): void;
export function removeSprite2D(handle: Sprite2DHandle): void;
export function setSprite2DFrame(handle: Sprite2DHandle, frame: number): void;
export function getSprite2DHandleIndex(handle: Sprite2DHandle): number;
export function isSprite2DHandleAlive(handle: Sprite2DHandle): boolean;
```

### 可选的渲染器原生 Sprite2D Y 排序

`sprite-2d-y-sort.ts` 是显式导入的扩展，用于单个纯 2D 图层内的俯视、等距视角和 2.5D 重叠排序。它从不重排 `Sprite2DLayer._instanceData`：数字索引 API 槽位、交换移除（swap-remove）语义、稳定句柄 id 以及句柄到索引的映射均保持规范不变。取而代之，它拥有一个可复用的 GPU 顺序置换表和打包上传缓冲区。渲染器上传打包后的表示，而公共读取和修改继续寻址逻辑槽位。

初始支持边界特意限定为 `depth: "none"`。深度托管图层在视觉上可能由逐精灵 Z、深度写入以及介入其中的场景几何体共同决定，因此仅靠 CPU Y 顺序无法定义其视觉上最顶层的精灵，也无法使 `pickSprite2D` 与深度附件一致。因此，在 `depth: "test"` 或 `"test-write"` 上启用 Y 排序会在分配状态前抛出异常。

```typescript
// src/sprite/sprite-2d-y-sort.ts — optional Index API extension.
import type { Sprite2DLayer } from "./sprite-2d.js";

/** Options validated on every enable call and applied when creating Y-sort state. */
export interface Sprite2DYSortOptions {
    /** Bias assigned to existing and newly inserted sprites until individually changed. Default 0. */
    defaultBias?: number;
}

/** Layer-owned, pure state returned by `enableSprite2DYSort`. */
export interface Sprite2DYSortState {
    /** Layer whose GPU representation is Y-sorted. */
    readonly layer: Sprite2DLayer;
    /** Bias assigned to existing and future sprites by default. */
    readonly defaultBias: number;
    /** Whether this state remains installed on its layer. */
    readonly enabled: boolean;

    /** @internal Draw slot -> logical slot. */
    _permutation: Uint32Array;
    /** @internal Logical slot -> draw slot. */
    _inversePermutation: Uint32Array;
    /** @internal Stable merge-sort scratch. */
    _mergeScratch: Uint32Array;
    /** @internal Persistent insertion serial per logical slot. */
    _serials: Float64Array;
    /** @internal Per-logical-slot bias. */
    _biases: Float64Array;
    /** @internal Cached `positionPx.y + bias` per logical slot. */
    _keys: Float64Array;
    /** @internal Packed GPU-order instance records. */
    _packedInstances: Float32Array;
    /** @internal Capacity represented by the metadata arrays. */
    _capacity: number;
    /** @internal Instance-record float width represented by `_packedInstances`. */
    _packedStride: number;
    /** @internal Number of logical slots currently represented by metadata. */
    _activeCount: number;
    /** @internal Next persistent insertion serial. */
    _nextSerial: number;
    /** @internal Whether `_permutation` must be recomputed. */
    _sortDirty: boolean;
    /** @internal Whether the next upload must repack every active record. */
    _fullUpload: boolean;
    /** @internal Minimum dirty packed draw slot, inclusive. */
    _dirtyMin: number;
    /** @internal Maximum dirty packed draw slot, exclusive. */
    _dirtyMax: number;
}

/** Enable stable ascending Y-sort. Valid repeated calls return the installed state unchanged. */
export function enableSprite2DYSort(layer: Sprite2DLayer, options?: Sprite2DYSortOptions): Sprite2DYSortState;

/** Disable Y-sort, release its state, and mark canonical logical order for upload. */
export function disableSprite2DYSort(layer: Sprite2DLayer): boolean;

/** Set the finite ordering bias for one current logical Index API slot. */
export function setSprite2DYSortBias(layer: Sprite2DLayer, index: number, bias: number): void;

// src/sprite/sprite-2d-handle-y-sort.ts — optional Handle API companion.
import type { Sprite2DHandle } from "./sprite-2d-handle.js";

/** Resolve the handle's current logical slot, then set its finite Y-sort bias. */
export function setSprite2DYSortHandleBias(handle: Sprite2DHandle, bias: number): void;
```

每次启用调用都会验证 `defaultBias`，包括状态已经安装时的调用。每个 setter 的偏置值也必须是有限数；`NaN`、正/负无穷以及越界索引都会抛出异常而不改变状态。有效的重复启用是幂等的，并原样返回已安装的状态；其最初的 `defaultBias` 遵循首次选项生效原则。句柄 setter 使用 `getSprite2DHandleIndex`，因此已移除的句柄会抛出与其他句柄变更相同的稳定句柄错误。将句柄配套模块保留在独立文件中，意味着仅使用索引 API 的 Y 排序用户不会导入句柄映射表。

在模块 +Y 向下的图层空间约定下，绘制键为升序的 `(positionPx.y + bias, insertionSerial)`：较小的 Y 先上传，较大的 Y 后上传并合成在上方。`insertionSerial` 在精灵进入已启用图层时单调分配。它是活动精灵的元数据，而非当前逻辑槽位的元数据；交换移除会将序号和偏置随最后一个精灵一起移动到空出的槽位中。因此即使发生了无关的移除，相等键值的平局仍保留其原始插入顺序。对已经填充的图层启用 Y 排序会按其当前逻辑顺序分配序号。`clearSprite2DLayer` 清空活动元数据，但不会倒回序号计数器。

隐藏的精灵在置换表中保留其键、偏置、序号和位置。其打包后的尺寸保持为零，因此不光栅化任何片段；恢复可见性不会扰乱相等键值的相邻精灵。图层间排序保持不变：`SpriteRenderer` 仍按 `layer.order` 对整个图层排序，Y 排序仅应用于每个已启用图层内部。

实现模块在第一个图层启用时注册一个惰性的空钩子。中性钩子槽位和不透明契约共置于每个图层消费者都必须依赖的 `sprite-2d.ts` 中；这避免了在未启用 Y 排序的 Rolldown 构建中保留一个单独的可选钩子模块。始终加载的变更、上传和拾取模块只认识该不透明契约；所有状态字段名、键语义、排序代码和类型化数组分配均保留在 `sprite-2d-y-sort.ts` 中。仅导入或从根包导出启用器而不使用它，不会创建任何状态也不会执行任何模块级分配。

变更行为是精确的：

1. 启用时按图层当前容量分配置换表、逆置换表、归并暂存区、序号、偏置、键以及打包暂存数组，初始化所有活动元数据，并将整个图层标记为脏。
2. 添加仅在图层容量增长时扩容所有数组，分配下一个序号和默认偏置，然后使顺序失效。
3. 在规范写入之后检查任何脏逻辑范围。发生变化的 Y 键会使顺序失效。颜色、UV、帧、尺寸、仅 X 位置、旋转、可见性以及与 Z 无关的变更保持顺序完好，并通过 `_inversePermutation` 将逻辑脏槽位映射到打包绘制槽位脏范围。
4. 偏置更改重新计算单个键，且仅当该键发生变化时才使顺序失效。
5. 交换移除将偏置、序号和缓存键从 `last` 移动到 `index`，清除退出的尾部元数据，并使顺序失效。规范实例和句柄存储保持其现有的交换移除行为。
6. 清空会清零先前的活动元数据以及依赖数量的置换状态，保留已分配容量和下一个插入序号。

禁用会将返回的状态标记为 `enabled: false`，移除图层的状态附着以便其数组可被释放，并标脏整个活动范围。当图层保持禁用状态时，其下一次上传会恢复规范的逻辑顺序。重新启用不会恢复旧状态：它会创建全新数组，为每个活动精灵分配新的 `defaultBias`，按当前逻辑顺序分配序号 `0..count - 1`，并将下一个序号设为 `count`。因此禁用/重新启用会刻意重置逐精灵偏置覆盖和序号历史，而有效的重复启用则会原封不动地保留两者。

当顺序为脏时，自底向上的稳定归并排序按键再按序号填充 `_permutation`，重建 `_inversePermutation`，将每条活动记录打包到 `_packedInstances`，并执行一次完整的 `queue.writeBuffer`。当顺序未变时，仅刷新并上传通过逆映射到达的打包绘制槽位区间。排序、打包和局部更新在稳态下没有任何分配：所有循环都将标量通道复制到复用的类型化数组中，绝不创建逐精灵的 `subarray` 视图。诸如 UV 滚动之类的结构性实例步长启用项可能会替换一次打包缓冲区以匹配新记录宽度；普通操作仅随图层容量增长存储。

排序暂存路径位于共享的 `uploadSpriteInstances` 内部，因此渲染器资源扩容和设备恢复都保持自动。新创建的 GPU 实例缓冲区传入 `uploadedVersion === -1`，这总会触发一次从 CPU 状态进行的完整重新打包和排序上传。禁用路径的完整规范脏范围使同一个辅助函数无需特殊上传 API 即可恢复普通的逻辑顺序上传。

`pickSprite2D` 在遍历图层前向可选钩子询问当前绘制顺序。如果同帧内的 Y/偏置变更使其过时，钩子会对 CPU 置换表进行排序，但不进行打包也不触碰 GPU。随后拾取逆序遍历绘制槽位并返回映射后的逻辑槽位，因此结果与渲染的最顶层顺序（包括持久序号平局）一致。图层本身仍按数组逆绘制顺序进行测试。

因为该扩展不拥有任何 GPU 句柄，所以没有显式的 GPU 销毁方法。该状态附着在其调用方拥有的图层上，并具有相同的 GC 生命周期。当调用方希望在丢弃图层前释放数组时，`disableSprite2DYSort` 是显式的提前释放/关闭行为开关；直接丢弃图层的调用方只需一并丢弃返回的状态即可。

### 可选的 NPE → Sprite2D 桥接集成

`particle/particle-sprite-2d.ts` 是 Sprite2D 基础的一个显式启用消费方。它为每个 NPE 粒子系统创建一个居中的 `depth: "none"` 图层，并通过调用方拥有的 `SpriteRenderer` 渲染这些图层。粒子模块拥有坐标、精灵表、混合、同步、注册和销毁策略；精灵模块继续拥有图层存储和渲染。完整桥接契约位于 [42-node-particle.md](42-node-particle.md#104-sprite2d-桥接创建与映射)。

`particle/particle-sprite-2d-blend-modes.ts` 是针对精确 NPE 混合模式的独立粒子拥有显式启用模块。它复用普通的 `Sprite2DLayer` 和现有的自定义片段 API；模式 4 连续注册两个相同 `order` 的图层，使渲染器的稳定排序保持先 Multiply 后 Add。通用 Sprite2D 不解释粒子混合编号、不更新粒子系统动画、也不拥有多通道策略，且基线桥接不导入此高级模块。确切的 API、着色器公式、生命周期和测试位于 [42-node-particle.md](42-node-particle.md#105-精确-sprite2d-混合模式桥接)。

桥接独占其图层的完整活动范围。每次同步直接将 NPE 列写入现有的 13 浮点纯 2D 实例布局和保存尺寸缓冲区，然后执行一次数量更新和至多一次脏范围更新。桥接拥有的图层不能混用独立的索引 API 精灵，也不能安装可选的句柄 API；两者都会破坏全范围所有权。请通过 `SpriteRenderer` 而非深度托管场景路径来渲染它。

依赖关系保持单向：两个粒子桥接模块都导入 Sprite2D 模块，而没有任何精灵模块导入任一桥接。尽管包根目录导出了这两个 API，无副作用的 tree-shaking 意味着不导入它们的静态 Sprite2D 用户支付零字节桥接代码，而基线桥接用户不支付精确描述符、自定义着色器或第二通道字节。

### 混合模式 —— 可 tree-shake 的描述符

混合模式**不是**由静态查找表支持的联合字符串类型。每种模式都是一个可导入的纯数据描述符值，因此场景仅打包它导入的描述符——默认（alpha）场景只引用 `spriteBlendAlpha` 而不包含其他任何模式；导入 `spriteBlendAdditive` **不会**拖入 `spriteBlendPremultiplied`。未来添加新的混合模式对不使用它的场景开销为**零字节**。管线直接从该值上读取 `_descriptor` / `_key` / `_premultipliedOpacity`，因此没有需要打包器保留的运行时字符串 `switch`。这些描述符在 `GPUBlendState` 上与旧表逐字节相同，因此视觉一致性保持不变。

```typescript
// src/sprite/sprite-blend.ts
export interface SpriteBlendDescriptor {
    /** @internal Pipeline-cache discriminator (distinguishes blend variants of one pipeline). */
    readonly _key: string;
    /** @internal Color-target blend state; `undefined` means no color blend (opaque). */
    readonly _descriptor?: GPUBlendState;
    /** @internal When true, per-layer opacity scales RGB *and* A (premultiplied fade). */
    readonly _premultipliedOpacity?: boolean;
}

export const spriteBlendOpaque: SpriteBlendDescriptor; // replacement color; no blend
export const spriteBlendAlpha: SpriteBlendDescriptor; // straight-alpha "over" (default)
export const spriteBlendPremultiplied: SpriteBlendDescriptor; // premultiplied "over"
export const spriteBlendAdditive: SpriteBlendDescriptor; // glows/sparks: src*alpha + dst
export const spriteBlendOneOne: SpriteBlendDescriptor; // pure additive: src + dst
export const spriteBlendMultiply: SpriteBlendDescriptor; // shadow/tint: result = src * dst

// src/sprite/billboard-blend.ts — mirrors the above for world-space billboards.
export interface BillboardBlendDescriptor extends SpriteBlendDescriptor {
    /** @internal Depth/blend pipeline path this mode selects ("transparent" | "cutout"). */
    readonly _depthMode: BillboardDepthMode;
}

export const billboardBlendAlpha: BillboardBlendDescriptor;
export const billboardBlendPremultiplied: BillboardBlendDescriptor;
export const billboardBlendCutout: BillboardBlendDescriptor; // alpha-test, depth-writing
export const billboardBlendAdditive: BillboardBlendDescriptor; // transparent, no depth write
```

Sprite2D 支持 `opaque`、`alpha`、`premultiplied`、`additive`、`one-one` 和 `multiply` 描述符。`spriteBlendAdditive` 使用颜色因子 `src-alpha` / `one`，因此源 RGB 在加到目标之前会乘以源 Alpha。`spriteBlendOneOne` 对颜色和 Alpha 都使用 `one` / `one`，因此源 RGB 不经 Alpha 加权直接相加。其颜色因子匹配 Babylon.js `BLENDMODE_ONEONE` / `ALPHA_ONEONE`，但其通用 Sprite2D Alpha 因子为 `one` / `one`；精确粒子 OneOne 则使用 `zero` / `one`。两个叠加描述符中的所有操作均为 `add`。

公告板公开支持 `alpha`、`premultiplied`、`cutout` 和 `additive`——特意不为公告板提供 `multiply`。共享的 `blend-descriptors.ts` 持有两种常见状态（`_ALPHA_BLEND_STATE`、`_PREMULTIPLIED_BLEND_STATE`），因此 alpha/premultiplied 不会重复字节。

### 逐图层自定义片段着色器

图层/系统可以提供自己的 WGSL **片段主体**，同时引擎保留对变换、实例化、排序和深度的所有权。工厂返回一个作为 `customShader` 传入的不透明、按需编译描述符：

```typescript
// src/sprite/sprite-custom-shader.ts
export type Sprite2DCustomTexture = CustomShaderTexture; // becomes `<name>Tex` + `<name>Samp` in WGSL
export interface Sprite2DCustomShaderOptions {
    readonly fragment: string; // WGSL fragment body
    readonly extraTextures?: readonly Sprite2DCustomTexture[];
}
export function createSprite2DCustomShader(options: Sprite2DCustomShaderOptions): Sprite2DCustomShader;

// src/sprite/billboard-custom-shader.ts — parallel API for world-space billboards.
export function createBillboardCustomShader(options: BillboardCustomShaderOptions): BillboardCustomShader;
```

提供的 `fragment` 主体在作用域内拥有：`in: VOut`（2D 图层暴露 `uv: vec2<f32>` 和 `tint: vec4<f32>`，以及在 `enableSprite2DInstanceParams` 后暴露 flat `in.instanceParams: vec4<f32>`；公告板额外暴露 `viewDist` / `worldPos`）；位于绑定槽 1/2 的图层图集 `atlasTex` / `atlasSamp`；每个额外纹理为 `<name>Tex` / `<name>Samp`；`fx` UBO（`fx.time`、`fx.params`）；以及 `L` 图层 UBO（例如 `L.opacityMul`）。它必须 `return vec4<f32>(...)` 且可以 `discard`；该主体全权负责 Alpha 处理（不会自动应用逐图层不透明度）。常量 `fx.params` vec4 每帧通过 `setSprite2DShaderParams(layer, params)` / `setBillboardShaderParams(system, params)` 馈送。运行时 WGSL 标识符重混淆使压缩后的打包产物中的用户片段代码仍可正常工作。

**通过惰性空注册表实现 Tree-shaking（`sprite/sprite-fx-hook.ts`）。** 这是架构关键所在，镜像了 PBR 扩展注册表（`pbr-flags.ts`）。该模块声明两个钩子接口（`SpriteFxHook`、`BillboardFxHook`），其方法（`initLayer`、`pipelineKeyPart`、`shaderModule`、`layoutEntries`、`createLayerFx`、`updateFx`、`bindEntries`、`disposeFx`）均**不透明地**接收图层/系统，因此每次读取 `layer.customShader` / `layer.shaderParams` 属性都发生在被 tree-shake 的实现*内部*。它持有两个模块级槽位（`let _spriteFxHook: SpriteFxHook | null = null`、`_billboardFxHook`）以及 `_registerSpriteFxHook` / `_getSpriteFxHook` / `_registerBillboardFxHook` / `_getBillboardFxHook` 函数——没有任何模块级副作用。始终加载的精灵/公告板/管线/渲染器模块只调用 `_getSpriteFxHook()?.method(...)`；在 `createSprite2DCustomShader` / `createBillboardCustomShader` 注册实现之前，该槽位保持 `null`。因此普通精灵场景打包**零个**自定义着色器令牌——甚至连公共字段名字符串 `customShader` / `shaderParams` 也没有。`sprite-pipeline.ts` 的 `spritePipelineKey` 仅通过 `_getSpriteFxHook()?.pipelineKeyPart(layer)`（即 `cs${customKey}` 片段）触及该特性。2D 和公告板组合器通过 `custom-shader-core.ts` 共享它们的*机制*（额外纹理绑定、名称验证、`SpriteFx` UBO、键分配），同时各自保留自己的顶点阶段和 varying 契约。

### 显式启用的逐精灵 UV 滚动（视差）

`uvScroll` 是一个**结构性**显式启用项，而非逐精灵值：启用它会改变 GPU 数据布局和编译后的着色器，因此遵循与 `depth` 相同的按需付费门控。当图层首次调用 `setSprite2DUvOffset` 时，每个精灵会获得两个额外的实例浮点数（`uvOffset.xy`），在顶点阶段加到采样 UV 上——从而无需重新上传纹理坐标即可实现视差/无限滚动背景。偏移量通过 `setSprite2DUvOffset(layer, index, uvOffset)` 逐精灵设置。对于深度托管图层，请在 `addDepthHostedSpriteLayerToScene` 之前的设置阶段启用；仅纯 2D SpriteRenderer 支持后期布局更改。

启用该标志会 (1) 将实例步长加宽两个浮点数，(2) 添加一个 `@location(7) iUvOffset: vec2<f32>` 顶点属性，(3) 选择一个不同的 WGSL 变体（`let uv = mix(...) + in.iUvOffset`），以及 (4) 向管线键添加一个 `:uv${uvKey}` 片段以防变体碰撞。该加宽与深度正交，并追加到当前布局之后。在没有实例参数时，其偏移量为：

```text
pure-2D + uvScroll  (15 floats = 60 bytes):  [13..14] uvOffset.xy (float32x2 @ byte offset 52)
depth   + uvScroll  (16 floats = 64 bytes):  [14..15] uvOffset.xy (float32x2 @ byte offset 56)
```

如果先启用了实例参数，UV 改为从字节偏移 68/72 开始；组合步长为 76/80 字节。预计算的 `_uvScrollAttr.offset` 为权威值。未启用任一扩展的图层保持窄的 13/14 浮点布局、基础属性和基础 WGSL——它们不打包任何加宽代码。该特性天然适合配合以 `repeat` 环绕模式采样的可平铺图集（`loadSpriteAtlas(..., { textureOptions: { addressModeU: "repeat", addressModeV: "repeat" } })`）。

### 路线图 —— `Sprite2DLayer` 的 `AnchorSource` 显式启用 3D 桥接

本节中的 API 目前不属于当前根包导出。

```typescript
// src/sprite/anchor/sprite-anchor.ts — separate module, dynamic-imported on first use.
import type { Sprite2DLayer, Sprite2DProps } from "../sprite-2d.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { IWorldMatrixProvider } from "../../scene/parenting.js";

export interface AnchorSource {
    readonly project: (outPx: Float32Array, outZ: Float32Array, scene: SceneContext) => boolean;
}

/** Static world-space anchor. */
export function createWorldAnchor(worldPos: [number, number, number]): AnchorSource;

/** World anchor that follows a moving entity (mesh, transform node, sprite handle). */
export function createParentAnchor(parent: IWorldMatrixProvider, localOffset?: [number, number, number]): AnchorSource;

/** Attach an AnchorSource to a sprite. The sprite's positionPx is overwritten each frame
 *  by the projection result. Layer must have depth !== "none" for occlusion against 3D geometry. */
export interface AnchoredSprite2DInit extends Sprite2DProps {
    anchor: AnchorSource;
    offsetPx?: [number, number];
    /** NDC-z bias added after projection (positive = pushed toward camera). Default 0. */
    depthBias?: number;
}

export function addAnchoredSprite2D(layer: Sprite2DLayer, init: AnchoredSprite2DInit): number;
export function setSprite2DAnchor(layer: Sprite2DLayer, index: number, anchor: AnchorSource | null): void;
```

在给定图层上首次调用 `addAnchoredSprite2D`（或以非 null 锚点调用 `setSprite2DAnchor`）时：

1. 在图层上惰性分配一个稀疏的 `Map<number, AnchoredEntry>`（没有锚点的精灵没有条目）。
2. 向 `scene._beforeRender` 安装一个每帧钩子（通过 `unshift`，使其在用户 `onBeforeRender` 回调之前运行），该钩子遍历图层的锚点映射，调用每个 `anchor.project()`，并通过 `updateSprite2DIndex` 使用的同一代码路径将结果的 `positionPx`、可选 `layerZ`（从视图 Z 映射）以及经 `depthBias` 调整的排序写入图层的扁平存储中。`project` 返回 `false` 的精灵会在其槽位写入 `sizePx = [0, 0]`（退化四边形——与 `visible: false` 相同技巧）。
3. 注册单个可销毁项，当图层销毁或其锚点映射变空时移除该钩子。

```typescript
// In sprite-anchor.ts internal:
interface AnchoredEntry {
    anchor: AnchorSource;
    offsetPx: [number, number];
    depthBias: number;
}
```

拥有零个锚定精灵的场景绝不会导入 `sprite-anchor.ts`、绝不会分配稀疏映射、绝不会安装投影钩子，也绝不会在 CPU 上为 `viewProjection` 付出代价。

### 家族 2 —— `*BillboardSpriteSystem`

当前实现切片刻意比完整公告板路线图更窄：它交付了 **Facing（面向相机）** 和 **Axis-Locked（轴锁定）** 公告板（偏航锁定作为使用 `[0, 1, 0]` 的轴锁定特例），带有底层索引 API、显式场景启用辅助函数以及针对当前紧凑顶点缓冲区上传的 CPU 端透明排序。它还交付了生产级镂空（cutout）路径：通过 `billboardBlendCutout` 选择的 Alpha 测试、写入深度的公告板系统，加上通过 `billboardBlendAdditive` 实现的**叠加**混合，以及通过 `createBillboardCustomShader` 实现的显式启用**逐系统自定义片段着色器**（见[逐图层自定义片段着色器](#逐图层自定义片段着色器)）。片段播放、可观察句柄字段、父子级关系、拾取、存储缓冲区排序间接层以及公告板 `multiply` 混合模式属于增量式后续模块。稳定句柄身份本身位于 `billboard-sprite-handle.ts`。该拆分保持了首批公告板路径精简，并防止纯 2D 精灵打包产物导入场景渲染代码。

```typescript
// src/sprite/billboard-sprite.ts
import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import type { BillboardBlendDescriptor } from "./billboard-blend.js";
import type { BillboardCustomShader } from "./billboard-custom-shader.js";

export interface BillboardSpriteSystemOptions {
    capacity?: number;
    blendMode?: BillboardBlendMode;
    alphaCutoff?: number;
    opacity?: number;
    visible?: boolean;
    order?: number;
    /** Opt-in per-system custom fragment shader; see `createBillboardCustomShader`. */
    customShader?: BillboardCustomShader;
}

// Blend mode is a descriptor value (see `billboard-blend.ts`), not a string. Billboards accept
// alpha / premultiplied / cutout / additive; `multiply` is intentionally not offered.
export type BillboardBlendMode = BillboardBlendDescriptor;
export type BillboardOrientation = "facing" | "axis-locked";
export type BillboardDepthMode = "transparent" | "cutout";

export interface BillboardSpriteSystem<TOrientation extends BillboardOrientation = BillboardOrientation> {
    readonly _entityType: "billboard-sprite-system";
    readonly atlas: SpriteAtlas;
    readonly blendMode: BillboardBlendMode;
    alphaCutoff: number;
    opacity: number;
    visible: boolean;
    readonly order: number;
    readonly count: number;
    readonly orientation: TOrientation; // fixed by the factory
    readonly axis: readonly [number, number, number]; // normalized lock axis; [0, 0, 0] for facing

    readonly _depthMode: BillboardDepthMode;
    _capacity: number;
    readonly _instanceFloatsPerSprite: number;
    readonly _instanceStrideBytes: number;
    _instanceData: Float32Array;
    _savedSize: Float32Array;
    _version: number;
    _dirtyMin: number;
    _dirtyMax: number;
}

export type FacingBillboardSpriteSystem = BillboardSpriteSystem<"facing">;
export type AxisLockedBillboardSpriteSystem = BillboardSpriteSystem<"axis-locked">;

export interface BillboardSpriteInit {
    position: [number, number, number];
    sizeWorld: [number, number];
    frame?: number;
    rotation?: number;
    pivot?: [number, number];
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
}

export function createFacingBillboardSystem(atlas: SpriteAtlas, opts?: BillboardSpriteSystemOptions): FacingBillboardSpriteSystem;
export function createAxisLockedBillboardSystem(atlas: SpriteAtlas, axis: readonly [number, number, number], opts?: BillboardSpriteSystemOptions): AxisLockedBillboardSpriteSystem;

// Index API — low-level, parallels ThinInstance and existing Sprite2DLayer index calls.
export function addBillboardSpriteIndex(system: BillboardSpriteSystem, init: BillboardSpriteInit): number;
export function updateBillboardSpriteIndex(system: BillboardSpriteSystem, index: number, patch: Partial<BillboardSpriteInit>): void;
export function removeBillboardSpriteIndex(system: BillboardSpriteSystem, index: number): void;
export function clearBillboardSprites(system: BillboardSpriteSystem): void;
export function setBillboardSpriteFrameIndex(system: BillboardSpriteSystem, index: number, frame: number): void;

// src/sprite/billboard-sprite-handle.ts — optional, tree-shakable Handle API.
export interface BillboardSpriteHandle {
    readonly _entityType: "billboard-sprite-handle";
    readonly system: BillboardSpriteSystem;
    readonly id: number;
}

export function addBillboardSprite(system: BillboardSpriteSystem, init: BillboardSpriteInit): BillboardSpriteHandle;
export function updateBillboardSprite(handle: BillboardSpriteHandle, patch: Partial<BillboardSpriteInit>): void;
export function removeBillboardSprite(handle: BillboardSpriteHandle): void;
export function setBillboardSpriteFrame(handle: BillboardSpriteHandle, frame: number): void;
export function getBillboardSpriteHandleIndex(handle: BillboardSpriteHandle): number;
export function isBillboardSpriteHandleAlive(handle: BillboardSpriteHandle): boolean;

// src/sprite/billboard-scene.ts
export function addBillboardSystemToScene(scene: SceneContext, system: BillboardSpriteSystem): void; // idempotent
export function removeBillboardSystemFromScene(scene: SceneContext, system: BillboardSpriteSystem): boolean; // false when not a member
export function getSceneBillboardSystems(scene: SceneContext): readonly BillboardSpriteSystem[]; // add-order snapshot
export function onSceneBillboardSystemsChanged(scene: SceneContext, listener: SceneRenderableChangeListener<BillboardSpriteSystem>): () => void;
```

`BillboardSpriteSystem.order` 是构造时状态：当场景辅助函数在 `registerScene` 期间构建 GPU 资源时会拷贝它。当注册后需要更改渲染顺序时，请创建一个新系统。

`setSprite2DFrameIndex` 和 `setBillboardSpriteFrameIndex` 是仅修改 UV 的辅助函数。即使目标图集帧具有不同的 `sourceSizePx`，它们也会保留精灵显式的 `sizePx`/`sizeWorld`。需要由图集驱动尺寸变化的调用方应使用带有显式尺寸策略的 `updateSprite2DIndex(layer, index, { frame, sizePx })` 或 `updateBillboardSpriteIndex(system, index, { frame, sizeWorld })`。对于公告板，像素帧尺寸绝不隐含世界空间尺寸。`setBillboardSpriteFrameIndex` 同样保留精灵当前的枢轴（pivot）；希望在动画期间由图集驱动枢轴变化的调用方应使用 `updateBillboardSpriteIndex(system, index, { frame, pivot })`。

翻转状态通过交换 UV 最小/最大端点来编码，因此帧 setter 会为非退化图集帧（`uvMin.x !== uvMax.x` 且 `uvMin.y !== uvMax.y`）保留翻转状态。零面积图集帧无法区分翻转和未翻转状态；调用方应避免制作坍缩的 UV 范围，或在从此数据恢复时通过完整更新辅助函数传入显式的 `flipX`/`flipY`。

`addBillboardSystemToScene(scene, system)` 是两种朝向的场景集成入口。它加入场景的公告板自定义 renderable 集合（见 [01-scene.md § 自定义 renderable 集合](01-scene.md#自定义可渲染对象集合)），注册系统的拾取源，并通过 `addDeferredSceneRenderables` 将延迟 renderable 构建器排入队列，从而使 `scene-core` 和 `addToScene` 保持与精灵无关。该构建器动态导入 `billboard-renderable.ts`，后者进而导入 `billboard-pipeline.ts`、`getSceneBindGroupLayout` 以及 WGSL 组合器。从不将公告板系统排入队列的场景永远不会在运行时拉取该分块。`removeBillboardSystemFromScene` 注销拾取源并立即停止绘制，在进行中的帧结束后回收场景构建的 GPU 资源。粒子混合通道公告板（`addFacingBillboardSystemWithParticleBlend`）以粒子拥有的构建器加入同一集合，因此发现和移除也同样覆盖它们。

在内部，共享的 renderable 根据 `system.orientation` 和 `system._depthMode` 进行路由；当前公共工厂设置 `"facing"` 或 `"axis-locked"`，且每个混合描述符自带其 `_depthMode` —— `alpha` / `premultiplied` / `additive` 为 `"transparent"`，`billboardBlendCutout` 为 `"cutout"`。透明系统开启 Alpha 混合、深度测试、禁用深度写入、维护用于场景透明分桶排序的 `_worldCenter`，并在上传前按从远到近对单个公告板实例排序。`_worldCenter` 是活动锚点包围盒的中心而非算术平均值，因为当渲染任务将该单一 renderable 与其他透明 renderable 排序时，它是系统空间占用的代理。渲染通道在透明分桶排序之前运行绑定更新，从而使 `_worldCenter` 在决定绘制顺序前反映同帧内的任何公告板变更。镂空系统没有混合状态，丢弃采样纹理 Alpha 低于 `alphaCutoff` 的片段，写入深度，并通过非透明直接绘制分桶（使用 `_direct` 而非 `_transmissive`）进行路由。

偏航锁定公告板（世界 Y 轴约束）通过 `createAxisLockedBillboardSystem(atlas, [0, 1, 0], opts)` 创建。

### 拾取

以下拾取 API 从包根目录导出（`pickSprite2D`、`pickBillboardSprite`，以及 `SpritePickInfo` / `BillboardPickInfo` 结果类型）。

```typescript
// src/sprite/picking/pick-sprite-2d.ts — handles every Sprite2DLayer
// reachable from the scene (depth-hosted layers added via addToScene)
// AND the layers of any SpriteRenderer the caller hands in.
export function pickSprite2D(layers: ReadonlyArray<Sprite2DLayer>, xPx: number, yPx: number): SpritePickInfo | null;

// src/sprite/picking/pick-billboard.ts — GPU picker into the shared mesh pick pass.
// An optional caller-owned `picker` (from createGpuPicker) is reused across calls for
// high-frequency picking; when omitted, a transient picker is created and disposed per call.
export function pickBillboardSprite(scene: SceneContext, xPx: number, yPx: number, picker?: GpuPicker): Promise<BillboardPickInfo | null>;
```

`pickSprite2D` 是纯 CPU 拾取器：调用方传入其拥有的任意 `Sprite2DLayer` 数组——对于 HUD 叠加层是 `spriteRenderer.layers`，或是 `scene._renderables`（过滤到 `addToScene` 推入其中的 Sprite2D `Renderable`）。拾取器按逆绘制（插入）顺序遍历，对每个候选精灵将屏幕点旋转进其感知枢轴的局部矩形。对于锚定图层，`positionPx` 在本帧已经于 CPU 端完成投影，因此拾取器命中的是与 GPU 绘制完全相同的屏幕矩形。Sprite2D 没有 GPU 拾取通道。

`pickBillboardSprite` 绘制到 GPU 上共享的网格拾取通道中；完整设计见下文[拾取](#拾取)。

### 纯 2D 用法 —— 无场景

纯 2D 应用完全跳过场景。它创建 `SpriteRenderer`，注册到引擎，并让 `startEngine` 驱动循环：

```typescript
import { createEngine, loadSpriteAtlas, createSprite2DLayer, addSprite2DIndex, createSpriteRenderer, registerSpriteRenderer, startEngine } from "@babylonjs/lite";

const engine = await createEngine(canvas);
const atlas = await loadSpriteAtlas(engine, "sprites.png", { gridSize: [32, 32] });
const layer = createSprite2DLayer(atlas);
addSprite2DIndex(layer, { positionPx: [100, 200], sizePx: [64, 64], frame: 0 });

const sr = createSpriteRenderer(engine, {
    layers: [layer],
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
});
registerSpriteRenderer(sr);

await startEngine(engine);
```

`src/scene/*` 中没有任何代码可从此路径到达——甚至连 `scene-core.ts` 也不行。这里不支持锚定精灵（它们需要相机）。

---

## 内部架构

### 核心规则：跨模式无 `if`（依然如此）

仍然没有共享的 `createSprite()`、没有 `SpriteMode` 枚举、没有每帧的 `if (sprite.kind === ...)`。两个家族拥有各自独立的组合器、独立的 renderable 和独立的 WGSL。统一发生在**场景**层，而不是精灵着色器层。`AnchorSource` 投影是在稀疏逐图层映射上的 CPU 步骤；它写入所属图层的基础实例字段（纯 2D 为 52 B，深度托管为 56 B）；可选扩展在不移动这些基础槽位的前提下向后追加字段。

### 逐实例 GPU 布局

`Sprite2DLayer` 在创建时根据 `depth` 选择基础实例步长。`depth: "none"` 使用 52 字节 / 13 浮点数，没有 Z 通道。`depth: "test" | "test-write"` 使用 56 字节 / 14 浮点数，并将槽位 `[13]` 暴露为逐实例深度属性。UV 滚动和实例参数分别向后追加 8 字节和 16 字节；两种启用顺序详见[实例参数](sprite-instance-params.md)。锚点数据保存在实例之外的稀疏 JS 映射中。逐图层常量（视图、屏幕尺寸、枢轴、不透明度）位于单独的 48 字节 UBO 中，纯渲染器绑定在 `@group(0) @binding(0)`，深度托管场景 renderable 绑定在 `@group(1) @binding(0)`。

#### Sprite2DLayer 纯逐实例顶点缓冲区（52 B = 13 浮点数）

| 偏移（字节） | 槽位    | 字段         | 顶点属性             | 备注                                                               |
| ------------ | ------- | ------------ | -------------------- | ------------------------------------------------------------------ |
| 0..7         | [0..1]  | `positionPx` | `@location(0)` f32×2 | 图层空间像素；对于锚定精灵，由 CPU 同步钩子写入                    |
| 8..15        | [2..3]  | `sizePx`     | `@location(1)` f32×2 | 像素宽/高；`visible: false` 时清零（退化四边形）                   |
| 16..23       | [4..5]  | `uvMin`      | `@location(2)` f32×2 | 图集 UV 最小值                                                     |
| 24..31       | [6..7]  | `uvMax`      | `@location(3)` f32×2 | 图集 UV 最大值                                                     |
| 32..35       | [8]     | `rotation`   | `@location(4)` f32   | 弧度；顶点着色器每个顶点计算一次 `sin`/`cos`                       |
| 36..51       | [9..12] | `colorRGBA`  | `@location(5)` f32×4 | 四个 float32 通道，匹配 Babylon.js SpriteRenderer 颜色精度         |

#### Sprite2DLayer 深度托管扩展（56 B = 14 浮点数）

深度托管图层使用相同的前 52 字节，加上：

| 偏移（字节） | 槽位 | 字段 | 顶点属性           | 备注                                                 |
| ------------ | ---- | ---- | ------------------ | ---------------------------------------------------- |
| 52..55       | [13] | `z`  | `@location(6)` f32 | NDC 深度（`0` = 近，`1` = 远），由场景管线消费       |

#### Sprite2DLayer `uvScroll` 扩展（显式启用；+8 B = +2 浮点数）

首次调用 `setSprite2DUvOffset` 会与深度正交地在当前布局之后追加两个浮点数（`uvOffset.xy`）。更宽的步长、`@location(7)` 属性以及 `+ iUvOffset` WGSL 由 `_uvScrollAttr` 是否存在来门控。仅含基础字段的偏移量为：

| 布局                 | 步长           | 槽位     | 字段       | 顶点属性             | 备注                                    |
| -------------------- | -------------- | -------- | ---------- | -------------------- | --------------------------------------- |
| pure-2D + `uvScroll` | 60 B / 15 fl   | [13..14] | `uvOffset` | `@location(7)` f32×2 | 字节偏移 52 处的 `uvOffset.xy`          |
| depth + `uvScroll`   | 64 B / 16 fl   | [14..15] | `uvOffset` | `@location(7)` f32×2 | 基础 56 B + 偏移 56 处的 `uvOffset.xy`  |

如果先启用了实例参数，UV 槽位则为 `[17..18]`/`[18..19]`，位于偏移 68/72 处；组合步长为 76/80 字节。如果先启用 UV，其偏移保持在 52/56，参数追加在其后。请始终使用描述符的实际偏移量。

顶点阶段将 `in.iUvOffset` 加到采样 UV 上（`let uv = mix(uvMin, uvMax, corner) + in.iUvOffset`），并且管线键增加一个 `:uv${uvKey}` 片段，从而使滚动/非滚动变体绝不碰撞。

可见性（`visible: false`）通过将槽位 `[2..3]` 清零实现；精灵的真实尺寸保存在 `layer._savedSize` 中，以便后续 `visible: true`（无需重新提供 `sizePx`）可以恢复它。

**深度托管图层使用逐实例 Z，而非逐图层 Z。** 单个深度托管图层可以混合不同深度的精灵——适用于一个精灵位于 3D 物体前方而另一个位于后方的场景。纯 2D 图层不分配、不上传、不声明也不读取 Z 槽位；`z` 仍被公共 props 类型接受，但在存储前被忽略。

#### Sprite2DLayer 图层 UBO（48 B = 12 浮点数；std140 对齐）

绑定在 `@group(0) @binding(0)`。每帧根据当前视图 + 目标尺寸更新；仅当 12 浮点数暂存缓冲区与上次写入的副本不同时，才通过 `device.queue.writeBuffer` 写入。

| WGSL 字段    | 偏移 | 备注                                                                                                         |
| ------------ | ---- | ------------------------------------------------------------------------------------------------------------ |
| `viewPos`    | 0    | `vec2<f32>` —— 图层视图像素平移                                                                              |
| `viewScale`  | 8    | `f32` —— 图层视图缩放                                                                                        |
| `viewRot`    | 12   | `f32` —— 图层视图弧度旋转                                                                                    |
| `screenSize` | 16   | `vec2<f32>` —— 引擎目标像素尺寸                                                                              |
| `pivot`      | 24   | `vec2<f32>` —— 归一化精灵局部空间中的图层级旋转/缩放枢轴                                                     |
| `opacityMul` | 32   | `vec4<f32>` —— 按图层不透明度预塑形。直接 Alpha：`(1, 1, 1, opacity)`。预乘：`(o, o, o, o)`。CPU 按混合模式预塑形，使着色器无分支 |

总计 48 字节——`vec4<f32>` 强制 16 字节结构体对齐，48 = 3 × 16 天然对齐；无需额外填充。

#### 当前 BillboardSpriteSystem 实例布局（64 B = 16 浮点数）

首批面向相机公告板切片使用紧凑的逐实例顶点缓冲区，而不是存储缓冲区或排序间接层。该缓冲区作为唯一的顶点缓冲区绑定，带有 `stepMode: "instance"`；着色器使用 `@builtin(vertex_index)` 生成四个四边形顶点，并对所有活动精灵执行 `drawIndexed(6, system.count, 0, 0, 0)`。

| 偏移（浮点数） | 字段        | 顶点格式    | 备注                                       |
| -------------- | ----------- | ----------- | ------------------------------------------ |
| 0..2           | `position`  | `float32x3` | 世界空间锚点                               |
| 3..4           | `sizeWorld` | `float32x2` | 隐藏时清零；真实尺寸镜像保存在 `_savedSize` |
| 5..6           | `uvMin`     | `float32x2` | 帧 UV 最小值，翻转时与最大值交换           |
| 7..8           | `uvMax`     | `float32x2` | 帧 UV 最大值，翻转时与最小值交换           |
| 9              | `rotation`  | `float32`   | 弧度，应用在面向相机的局部空间             |
| 10..11         | `pivot`     | `float32x2` | 归一化 `[0,1]` 枢轴                        |
| 12..15         | `color`     | `float32x4` | 以四个 float32 通道存储的 RGBA 色调        |

`position` 是除 `_savedSize` 之外唯一拥有 CPU 端影子副本的字段。`system._anchor` 以 F64 保存相同的三个分量（每个精灵 24 B），由 `writeInstance`、`growCapacity`、`removeBillboardSpriteIndex` 和 `clearBillboardSprites` 与 `_instanceData` 同步维护。

之所以存在该影子副本，是因为浮动原点无法挽救已经被量化过的值。`billboard-pipeline.ts` 中的相对视点减法必须读取仍然保留低位精度的源，因此它读取 `_anchor`；事后再从 F32 `_instanceData` 中做减法无法恢复任何东西，因为细节已经在前一步存储为 F32 时丢失了。该减法处的注释指出锚点“存在于世界尺度（~5e6）”，在该尺度下 F32 的 ULP 为 0.5 米——几乎相当于一整个粒子精灵的大小。这镜像了 `packMat4IntoF32WithOffset` 对网格遵循的规则（`36-high-precision-matrix.md`）：在 F64 下做减法，在 F32 下存储一次。

该影子副本无条件分配，不以 `useFloatingOrigin` 为门控。精灵系统是独立创建的，之后才注册到场景中，因此 `createBillboardSystem` 没有引擎可供询问，而锚点在写入第一个精灵时就必须已是 F64 精确的——太早而无法基于任何条件做门控。因此非 FO 场景会为它们从不读取的值支付每个精灵 24 B 的 CPU 内存（相对于现有的 64 B 实例记录）。它们不支付任何每帧开销：FO 上传路径原本每帧就要把每个实例拷贝到暂存区（因为每个锚点都依赖实时相机偏移），而非 FO 路径继续直接从 `_instanceData` 进行局部脏范围上传。

`_instanceData` 仍然携带 F32 位置，拾取（`billboard-pick-pipeline.ts`）和包围中心计算（`refreshBillboardWorldCenter`）都继续读取它。两者都在世界尺度下工作，在该尺度下 F32 精度是相称的。

当前系统 UBO 为 32 字节：

- 字节偏移 0 处的 `opacityMul`：`vec4<f32>`。直接 Alpha 和镂空写入 `(1, 1, 1, opacity)`；预乘写入 `(opacity, opacity, opacity, opacity)`，使着色器无分支。
- 字节偏移 16 处的 `axisAndCutoff`：`vec4<f32>`。`xyz` 对轴锁定系统是归一化轴，对面向相机系统是零。`w` 是仅由镂空着色器消费的运行时 `alphaCutoff`。

渲染管线在 group 0 使用场景 UBO，在 group 1 使用公告板 UBO/图集绑定组，管线键包含渲染目标格式、采样数、`orientation`、混合模式、`_depthMode` 以及深度格式。着色器模块缓存也以 `_depthMode` 为键：透明着色器没有丢弃路径，而镂空着色器采样纹理 Alpha，丢弃低于 `billboards.axisAndCutoff.w` 的片段，并返回采样颜色乘以色调和 `opacityMul`。`"transparent"` 深度模式使用深度比较 `greater-equal`、关闭深度写入、无剔除，以及 Alpha、预乘或叠加混合。`"cutout"` 深度模式使用深度比较 `greater-equal`、开启深度写入、无混合状态，以及无剔除。不支持的公告板 `multiply` 混合模式会在系统创建时抛出异常。

透明公告板系统在上传前逐公告板排序，而不是修改 `system._instanceData`。当 `DrawUpdateContext` 提供当前通道 `camera` 时，公告板 renderable 获取缓存的相机视图矩阵，并填充 renderable 拥有的暂存数组：视图空间深度、稳定索引顺序以及排序后的 64 字节实例暂存缓冲区。深度为每个锚点的视图空间 z（`view[2] * x + view[6] * y + view[10] * z + view[14]`），按降序排列，使较远的公告板先上传。当系统版本、相机身份或 `camera.worldMatrixVersion` 发生变化时，通过一次完整的 `queue.writeBuffer` 将排序后的暂存缓冲区写入同一个紧凑 GPU 顶点缓冲区。系统数据和相机视图未变的重复帧会跳过实例上传。镂空公告板系统完全跳过此透明排序路径，直接按逻辑插入顺序从 `system._instanceData` 上传脏范围，匹配深度托管精灵图层所使用的直接深度写入分桶语义。

这种依赖相机的透明排序有意采用保守策略：当相机移动时，公告板的相对顺序可能改变，因此 renderable 重新计算深度并上传排序后的紧凑缓冲区。如果与其他透明 renderable 的精确交错很重要，大型透明系统应按区域或深度带拆分；单个公告板系统在全局场景排序中仍作为一个透明 renderable 参与。

#### 未来目标 BillboardSpriteSystem（96 B = 24 浮点数）

后续的句柄/拾取/存储间接层路线图将公告板数据移至 `@group(1) @binding(3)` 处的存储缓冲区（而非顶点缓冲区——3D 精灵家族通过一个按排序间接顶点属性索引的存储缓冲区读取精灵数据，见下文）。24 浮点数布局如下：

| 偏移（浮点数） | 字段          | 备注                                                 |
| -------------- | ------------- | ---------------------------------------------------- |
| 0..2           | `worldPos`    | xyz —— 世界空间锚点位置                              |
| 3              | `_reserved`   | 0（锚定图层使用此槽位存放 `depthBias`）              |
| 4..5           | `_reserved`   | (0,0)（锚定图层使用这些槽位存放 `offsetPx`）         |
| 6..7           | `sizeWorld`   | 世界单位宽/高                                        |
| 8..9           | `pivot`       | 归一化 `[0,1]`                                       |
| 10..11         | `sinCos`      | 旋转角的预计算 sin/cos                               |
| 12..15         | `uvRect`      | uvMin.xy, uvMax.xy                                   |
| 16..19         | `color`       | RGBA 色调                                            |
| 20..23         | `flagsAndPad` | 浮点编码的 `[flipX, flipY, _reserved, _reserved]`    |

锁定轴（仅轴锁定变体）位于**系统 UBO** 中，而不是逐精灵存储。浮点数 3..5 处的预留槽位保留在布局中，是因为同一套打包缓冲区布局和打包辅助函数签名与深度托管 `Sprite2DLayer` 的锚定写入路径共享（后者将那些槽位用于 `depthBias` 和 `offsetPx`）；对于纯公告板系统，CPU 打包辅助函数写入 `0.0`。

##### 排序间接层 + 存储缓冲区

未来的存储缓冲区路径保持与当前 CPU 暂存路径相同的公共不变量：公告板系统绝不重排打包精灵缓冲区。排序完全通过一个单独的精灵索引 `Uint32Array` 间接缓冲区表达，每帧作为 `@location(0)` 处的逐实例顶点属性上传一次。着色器读取 `sortIndex` 并索引进打包精灵存储缓冲区以获取实际记录。这使得排序上传开销为 O(N)，而非 O(N × stride)。

**打包精灵缓冲区。** 由 `sprite-gpu.ts` 分配，带有 `usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST`。

**排序间接顶点缓冲区。** `@location(0)` 处的逐实例 Uint32 缓冲区，带有 `stepMode: "instance"`、`arrayStride: 4`，属性格式 `uint32`。每个活动精灵占一个 u32。当存储容量增长时重建。

**存储缓冲区绑定。** 在 `@group(1) @binding(3)` 处绑定为 `var<storage, read> sprites: array<SpriteData>`。绑定组布局条目使用 `buffer: { type: "read-only-storage" }` 和 `GPUShaderStage.VERTEX` 可见性。renderable 仅在 `system._storage.gpuBuffer`（JS 指针）在帧间变化时（容量增长或首次同步）才惰性重建图层绑定组。

**共享 WGSL。** `sprite/shared/sprite-3d-instance-wgsl.ts` 导出两个 TS 字符串常量，每个公告板变体着色器都会包含它们：

```wgsl
// SPRITE_3D_DATA_WGSL — 96 B / 24-float storage record.
struct SpriteData {
    worldPos: vec3<f32>,
    depthBias_or_reserved: f32,        // anchored: depthBias; billboard: 0
    offsetPx_or_reserved: vec2<f32>,   // anchored: offsetPx; billboard: (0,0)
    sizePxOrWorld: vec2<f32>,          // anchored: sizePx;   billboard: sizeWorld
    pivot: vec2<f32>,
    sinCos: vec2<f32>,
    uvRect: vec4<f32>,
    color: vec4<f32>,
    flagsAndPad: vec4<f32>,            // .x flipX, .y flipY, .z reserved, .w reserved
};
@group(1) @binding(3) var<storage, read> sprites: array<SpriteData>;

// SPRITE_3D_VS_IN_WGSL — input/output structs + helpers.
struct VSIn {
    @builtin(vertex_index) vid: u32,
    @location(0) sortIndex: u32,
};
struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};
fn rotate2(p: vec2<f32>, sinCos: vec2<f32>) -> vec2<f32> { /* ... */ }
fn cornerOf(vid: u32) -> vec2<f32> { /* 6-corner triangle list */ }
fn cornerUV(corner: vec2<f32>, rect: vec4<f32>, flipX: f32, flipY: f32) -> vec2<f32> { /* ... */ }
```

`SpriteData` 字段名称经过刻意统一（`depthBias_or_reserved`、`offsetPx_or_reserved`、`sizePxOrWorld`），使单个结构体定义可以同时服务于两个公告板变体以及 `Sprite2DLayer` 内部的锚定写入路径。公告板着色器忽略 `depthBias_or_reserved`，并将 `sizePxOrWorld` 作为世界尺寸读取。

**重新排序触发条件。** 仅当自上次同步以来以下至少一项发生变化时才运行重新排序：

- `_sortVersion`（由添加 / 移除 / 位置更新递增）。
- 相机世界位置（仅对混合系统重要——镂空系统不执行从后向前排序）。
- 精灵数量（在扩容后强制重新上传）。

**镂空 vs. 混合。** 镂空系统总是发射顺序的 `0..N-1` 间接索引（无每帧从后向前排序开销），从而使着色器路径保持统一。混合系统在平方相机距离上使用插入排序——对于小 N 和接近有序的列表非常快，这正是相机平滑移动时的典型情况。

**`SpriteSortState`**（位于 `sprite/shared/sprite-sort.ts`）：

```typescript
export interface SpriteSortState {
    indexBuffer: GPUBuffer | null;
    indices: Uint32Array;
    distances: Float32Array;
    lastSortVersion: number;
    lastCamX: number;
    lastCamY: number;
    lastCamZ: number;
    lastUploadedCount: number;
    blended: boolean;
    boundsCenter: [number, number, number];
}
```

**用于引擎级透明排序的包围中心。** `computeSpriteBoundsCenter(state, storage)` 遍历每个活动槽位的前三个浮点数，计算活动锚点包围盒的中心，写入 `state.boundsCenter` 并返回它。renderable 每帧将其复制到 `Renderable._worldCenter`，使引擎级透明排序能将公告板系统与透明网格正确排序。

**`sprite-sort.ts` 导出的辅助函数：**

- `createSpriteSortState(blended)` —— 分配状态。GPU 缓冲区在首次同步时惰性创建。
- `syncSpriteSortIndices(engine, state, storage, sortVersion, camX, camY, camZ, label)` —— 确保容量，如果触发了任一条件则运行排序，并通过单次 `writeBuffer` 上传。
- `computeSpriteBoundsCenter(state, storage)` —— 活动锚点包围盒中心。
- `disposeSpriteSortState(state)` —— 释放 GPU 索引缓冲区。

### 无顶点四边形

没有位置顶点缓冲区。每个实例由 `@builtin(vertex_index)` 进行六次调用（三角形列表）：

```wgsl
const QUAD_CORNERS: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
    vec2<f32>(0, 0), vec2<f32>(1, 0), vec2<f32>(1, 1),
    vec2<f32>(0, 0), vec2<f32>(1, 1), vec2<f32>(0, 1),
);
```

绘制调用：`pass.draw(6, batch.count)`，拓扑为 `'triangle-list'`。使用 triangle-list（而非 triangle-strip）消除了一系列跨 WebGPU 实现的边缘驱动差异。

### CPU → GPU 同步（`sprite-gpu.ts`）

每个图层/系统拥有一个大小为 `capacity × stride` 的 `Float32Array` 打包缓冲区。在每帧同步时：

1. 如果 `_version === _gpuVersion`，跳过。
2. 否则，遍历 `[dirtyMin, dirtyMax]` 并为每个脏槽位打包 20 或 24 浮点记录。通过 `atlas.frames[frameIndex]` 将 `frame` 解析为 UV 矩形。
3. 执行单次 `device.queue.writeBuffer(_gpuBuffer, dirtyMin*stride, _data.buffer, dirtyMin*stride, (dirtyMax - dirtyMin + 1) * stride)`。
4. `_gpuVersion = _version`。

溢出时容量按 2× 增长（新分配 + 拷贝）。renderable 的 GPU 缓冲区引用在扩容时在内部重建，新缓冲区在下一帧 `draw()` 时重新绑定——调用方不持有 GPU 缓冲区句柄，因此无需调用方做任何操作。精灵索引在扩容期间保持稳定。移除采用**交换移除**（最后一个槽位移动到空位；该槽位的 `_dirty` 范围被标记）。与 `mesh/thin-instance.ts` 模式相同。

此模块由每个家族 renderable **动态导入**，因此纯 2D 场景不会打包公告板或锚定代码。

锚点投影通过与其他所有更新相同的 `updateSprite2DIndex` 写入路径馈送脏范围机制。投影位置每帧都变化的锚定精灵（常见情况）实际上每帧都会完整重新上传锚定精灵所在的连续槽位范围——与每帧移动的粒子图层具有相同的开销特征。静态锚点（父级从不移动、相机从不移动）通过 `_version === _gpuVersion` 短路跳过上传。

#### 脏标记 / 版本跟踪

| 字段           | 递增方                                                                 | 检查方     |
| -------------- | ---------------------------------------------------------------------- | ---------- |
| `_version`     | 所有 `add*` / `update*` / `remove*` / `set*Frame` / 片段推进辅助函数   | GPU 同步   |
| `_gpuVersion`  | 上传后的 GPU 同步                                                      | —          |
| `_sortVersion` | 相机变更（公告板家族）或任意 3D 位置变更                               | 排序重算   |

#### 可见性（`visible: false`）

切换精灵的 `visible: false` **不会**压缩数组或偏移索引。打包步骤向槽位写入 `sizePx = [0, 0]`（或 `sizeWorld = [0, 0]`）；顶点着色器将全部六个顶点坍缩为单个点，光栅化器发出零个片段。索引保持稳定，排序顺序不受影响，切换可见性只是一次递增 `_version` 的常规 `update*({ visible })` 调用。权衡：不可见精灵在每帧上传范围中仍占用其步长字节。对于可见性剧烈抖动的图层（实践中很少见），请拆分为两个图层。

### 钩子注册顺序

逐图层动画/片段计时更新以及逐图层锚点投影钩子都通过 `unshift` 注册到 `scene._beforeRender`，因此它们在任何用户 `onBeforeRender` 回调之前运行。**这是冻结标志契约所必需的**：驱动确定性捕获的应用（例如 `seekTime` 参考场景）先推进 N 帧，然后在其自己的 `onBeforeRender` 中设置冻结标志；该回调必须能在冻结帧上观察到完全推进后的片段状态，否则图层会在捕获的图像中丢失一帧动画。所有精灵家族（Sprite2D、锚定 Sprite2D、Billboard）共享这一约定。

---

## 管线配置

### 所有图层共享

| 设置         | 值                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 拓扑         | `triangle-list`                                                                                                              |
| 索引缓冲区   | 共享的 6 索引 Uint16 四边形索引缓冲区（每个 `SpriteRenderer` 一个，每个深度托管 renderable 一个）                            |
| 剔除模式     | `none`                                                                                                                       |
| 正面方向     | `ccw`                                                                                                                        |
| 颜色目标     | 引擎交换链格式                                                                                                               |
| MSAA         | `SpriteRenderer` 始终以 `sampleCount = 1` 录制直接交换链通道；深度托管的 Sprite2D 图层在帧图内继承场景渲染目标的采样数       |
| 图集采样器   | 逐图集（`linear` 或 `nearest`），`clamp-to-edge`，默认无 mipmap                                                              |

### Sprite2DLayer 逐 `depth` 管线状态

| 图层 `depth`   | 绘制途径                                                                               | 深度附件       | 深度比较        | 深度写入 | 实例布局 / Z                    | 渲染顺序                                      |
| -------------- | -------------------------------------------------------------------------------------- | -------------- | --------------- | -------- | ------------------------------- | --------------------------------------------- |
| `"none"`       | 注册在引擎上的 `SpriteRenderer`                                                        | 无             | 无              | `false`  | 52 B / 13 浮点数；无槽位 [13]   | 引擎注册顺序；渲染器内部按图层 order 排序     |
| `"test"`       | `addDepthHostedSpriteLayerToScene` → `sprite-renderable.ts`（renderable `order = 200`）| 引擎深度附件   | `greater-equal` | `false`  | 56 B / 14 浮点数；消费槽位 [13] | 场景透明队列（在不透明网格之后）              |
| `"test-write"` | `addDepthHostedSpriteLayerToScene` → `sprite-renderable.ts`（renderable `order = 100`）| 引擎深度附件   | `greater-equal` | `true`   | 56 B / 14 浮点数；消费槽位 [13] | 在缓存的不透明网格之后、透明之前直接绘制      |

精灵管线缓存键包含 `(format, sampleCount, blendMode, hasDepth, depthWrite, depthStencilFormat)`，加上用于自定义着色器图层的 `cs${customKey}` 片段（通过 `_getSpriteFxHook()?.pipelineKeyPart(layer)` 不透明地贡献）以及用于 `uvScroll` 图层的 `:uv${uvKey}` 片段。`SpriteRenderer` 图层总是请求 `hasDepth = false` 和 `sampleCount = 1`，因此它们的管线在没有深度-模板描述符的情况下构建。深度托管图层请求 `hasDepth = true`，使用帧图提供的目标深度-模板格式，并根据图层的 `depth` 模式设置 `depthWrite`。

### 绑定组布局

`Sprite2DLayer` 使用上述逐实例章节中描述的 `Layer` UBO：在精灵绑定组的 binding 0 处占 48 字节，加上位于 binding 1 和 2 的图集纹理和采样器。纯 `SpriteRenderer` 图层将该组绑定在 group 0。深度托管的 Sprite2D renderable 将场景现有的 group 0 绑定在 group 0，并将精灵图层组绑定在 group 1。

在当前实现中，公告板**不**分配单独的仅精灵场景 UBO。渲染通道任务已经拥有规范的场景 UBO 并将其绑定在 group 0；公告板 WGSL 从该现有绑定中读取 `scene.viewProjection` 和 `scene.view`。仅网格的场景仍支付零字节公告板代码，因为公告板 renderable/管线模块位于 `billboard-scene.ts` 中的动态导入之后。

公告板绑定组位于 group 1：

| 绑定槽 | 资源                  | 着色器阶段        | 备注                                                            |
| ------ | --------------------- | ----------------- | --------------------------------------------------------------- |
| 0      | `BillboardSystem` UBO | vertex + fragment | 32 B：`opacityMul: vec4<f32>`，`axisAndCutoff: vec4<f32>`       |
| 1      | 图集纹理              | fragment          | 来自 `system.atlas.texture.view` 的 `texture_2d<f32>`           |
| 2      | 图集采样器            | fragment          | 来自图集纹理的过滤采样器                                        |

`BillboardSystem.axisAndCutoff.xyz` 对轴锁定系统是归一化锁定轴，对面向相机系统是零。`axisAndCutoff.w` 是仅由镂空着色器消费的运行时 `alphaCutoff`。`opacityMul` 由 CPU 按混合模式塑形：直接 Alpha 和镂空写入 `(1, 1, 1, opacity)`，而预乘写入 `(opacity, opacity, opacity, opacity)`，从而使片段着色器没有任何混合模式分支。

### 管线缓存

逐设备，惰性创建。当前键：

- `Sprite2DLayer`：`(format, sampleCount, blendMode, hasDepth, depthWrite, depthStencilFormat)`。
- `BillboardSpriteSystem`：`(format, sampleCount, orientation, blendMode, depthMode, depthStencilFormat)`。

`alphaCutoff` 和 `opacity` **不在**公告板管线键中。两者都位于 32 字节系统 UBO 中，因此动态调整不透明度或微调裁切阈值只是一次 UBO 写入，而非管线重编译。`flipX` / `flipY` 通过交换逐实例数据中的 UV 最小/最大值来存储，而不通过更换管线。

---

## 着色器逻辑

组合器（每个家族/公告板变体各一个）发射完整的 WGSL 字符串。共三个组合器：`composeSprite2D`（同时覆盖纯 2D 和锚定图层——WGSL 完全相同）、`composeFacingBillboard` 以及 `composeAxisLockedBillboard`。

### Sprite2DLayer 顶点着色器（同时覆盖纯 2D 与锚定）

```wgsl
@group(0) @binding(0) var<uniform> scene: Sprite2DSceneUBO;
@group(1) @binding(2) var<uniform> layer: SpriteLayerUBO;

@vertex fn vs(in: VSIn) -> VSOut {
    let corner = cornerOf(in.vid);
    let localPx = (corner - in.pivot) * in.sizePx;
    let rotated = rotate2(localPx, in.sinCos);
    let layerPx = in.positionPx + rotated;
    let sc = vec2<f32>(sin(scene.viewRotation), cos(scene.viewRotation));
    let viewed = rotate2(layerPx - scene.viewPositionPx, sc) * scene.zoom;
    // PIXEL_SNAP: composer emits floor(viewed + 0.5) when pixelSnap is true.
    let snapped = viewed;
    let ndc = vec2<f32>(
         snapped.x * scene.invViewportPx.x * 2.0 - 1.0,
        1.0 - snapped.y * scene.invViewportPx.y * 2.0,
    );
    // For depth: "none" layers, z is ignored. For depth: "test" / "test-write",
    // layerZ ∈ [0,1] is mapped to NDC depth ∈ [1,0]. The CPU anchor sync writes
    // the projected NDC-z (with depthBias applied) into in.layerZ for anchored sprites.
    let z = 1.0 - clamp(in.layerZ, 0.0, 1.0);
    var out: VSOut;
    out.pos = vec4<f32>(ndc, z, 1.0);
    out.uv = cornerUV(corner, in.uvRect, in.flipX > 0.5, in.flipY > 0.5);
    out.color = in.color;
    return out;
}
```

关键之处：对于锚定精灵，`in.positionPx` 已经携带由 CPU 同步钩子在本帧 GPU 上传之前写入的**投影后**图层空间像素。着色器完全不知道该精灵是否被锚定。没有 `if (anchored)`、没有逐实例世界位置字段，也没有为非锚定精灵浪费任何字节。

### 公告板顶点着色器

当前公告板路径使用 64 字节逐实例顶点缓冲区和 `@builtin(vertex_index)` 来生成四个四边形顶点。共享组合器根据 `system.orientation` 发射以下两个基函数之一；顶点着色器的其余部分完全相同。

#### Facing（球面）基

```wgsl
fn getBillboardBasis(_anchor: vec3<f32>) -> BillboardBasis {
  let cameraRight = normalize(vec3<f32>(scene.view[0][0], scene.view[1][0], scene.view[2][0]));
  let cameraUp = normalize(vec3<f32>(scene.view[0][1], scene.view[1][1], scene.view[2][1]));
  return BillboardBasis(cameraRight, -cameraUp);
}
```

#### Axis-Locked（轴锁定）基

```wgsl
fn getBillboardBasis(_anchor: vec3<f32>) -> BillboardBasis {
  let lockAxis = normalize(billboards.axisAndCutoff.xyz);
  let cameraRight = normalize(vec3<f32>(scene.view[0][0], scene.view[1][0], scene.view[2][0]));
  let projectedRight = cameraRight - lockAxis * dot(cameraRight, lockAxis);
  let projectedRightLen = length(projectedRight);
  let safeProjectedRightLen = max(projectedRightLen, 1e-4);
  let fallbackSeed = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(lockAxis.z) > 0.999);
  let fallbackRightRaw = cross(lockAxis, fallbackSeed);
  let fallbackRight = fallbackRightRaw / max(length(fallbackRightRaw), 1e-4);
  let right = select(fallbackRight, projectedRight / safeProjectedRightLen, projectedRightLen > 1e-4);
  return BillboardBasis(right, -lockAxis);
}
```

#### 共享顶点主体

```wgsl
@vertex
fn vs(in: VIn) -> VOut {
  let corner = vec2<f32>(select(0.0, 1.0, in.vid == 1u || in.vid == 2u), select(0.0, 1.0, in.vid >= 2u));
  let local = (corner - in.iPivot) * in.iSize;
  let cosRot = cos(in.iRot);
  let sinRot = sin(in.iRot);
  let rotated = vec2<f32>(local.x * cosRot - local.y * sinRot, local.x * sinRot + local.y * cosRot);
  let basis = getBillboardBasis(in.iPos);
  let worldPos = in.iPos + basis.right * rotated.x + basis.up * rotated.y;
  var out: VOut;
  out.pos = scene.viewProjection * vec4<f32>(worldPos, 1.0);
  out.uv = mix(in.iUvMin, in.iUvMax, corner);
  out.tint = in.iColor;
  return out;
}
```

### 公告板片段着色器

透明公告板着色器采样图集并返回 `sampleColor * tint * billboards.opacityMul`。镂空公告板着色器使用相同的乘法，但会先丢弃采样 Alpha 低于 `billboards.axisAndCutoff.w` 的片段。

```wgsl
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let sampleColor = textureSample(atlasTex, atlasSamp, in.uv);
  if (sampleColor.a < billboards.axisAndCutoff.w) {
    discard;
  }
  return sampleColor * in.tint * billboards.opacityMul;
}
```

`alphaCutoff` 和 `opacity` 都位于公告板系统 UBO 中。两者都不烘焙到 WGSL 中，也不进入管线缓存键。

---

## 排序与透明

| 家族 / 变体                            | 绘制途径                                                                               | 渲染槽位                               | 逐实例排序                                                                  | 混合       | 深度写入 |
| -------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- | ---------- | -------- |
| Sprite2DLayer `depth: "none"`          | 注册在引擎上的 `SpriteRenderer`                                                        | 引擎 `_renderingContexts`（场景上下文之后）| 逻辑顺序，或使用 `enableSprite2DYSort` 时按稳定升序 Y 暂存                  | 按混合模式 | 关       |
| Sprite2DLayer `depth: "test"` 混合     | `addDepthHostedSpriteLayerToScene` → `sprite-renderable.ts`（`order = 200`）           | 场景透明队列（不透明网格之后）         | 消费；逐实例深度测试，不写入                                                | 按混合模式 | 关       |
| Sprite2DLayer `depth: "test"` 镂空     | `addDepthHostedSpriteLayerToScene` → `sprite-renderable.ts`（`order = 200`）           | 场景透明队列（不透明网格之后）         | 消费；逐实例深度测试，不写入                                                | 无         | 关       |
| Sprite2DLayer `depth: "test-write"`    | `addDepthHostedSpriteLayerToScene` → `sprite-renderable.ts`（`order = 100`）           | 缓存不透明网格之后直接绘制             | 消费；逐实例深度测试 + 写入                                                 | 按混合模式 | 开       |
| Billboard 混合                         | `addBillboardSystemToScene`（`order = 200`）                                           | 场景透明队列                           | CPU 按从远到近排序后暂存上传                                                | 按混合模式 | 关       |
| Billboard 镂空                         | `addBillboardSystemToScene`（`order = 100`）                                           | 缓存不透明网格之后直接绘制             | 逻辑插入顺序；由 GPU 深度解决                                               | 无         | 开       |

深度托管的 Sprite2D 图层**不**对精灵单独进行 Y 排序——每个图层成为一个 `Renderable`，由 GPU 的深度测试解决同一图层内（镂空）或共享深度缓冲区的图层之间的重叠。在深度托管图层内部，精灵按插入顺序绘制，并将逐实例 Z（槽位 `[13]`）用作深度测试值。纯 2D 图层没有槽位 `[13]`；除非可选的 Y 排序扩展提供了打包的 GPU 顺序表示，否则它们保持逻辑顺序。当前的透明公告板系统会排序进 renderable 拥有的暂存缓冲区并上传排序后的 64 字节实例，而不会修改 `system._instanceData`。镂空公告板系统跳过排序，直接按逻辑插入顺序上传脏范围。

---

## 拾取

两个拾取器覆盖两大精灵家族，各自适配其家族所在的空间：

- `pickSprite2D` 是**纯 CPU** 的。`Sprite2DLayer` 精灵是屏幕空间矩形，且纯 2D 应用没有供 GPU 通道接入的场景、相机或深度目标。
- `pickBillboardSprite` 是 **GPU** 的。公告板位于场景的 3D 深度缓冲区中，因此拾取它们必须尊重网格和更近公告板的遮挡；它绘制到网格拾取器所用的同一个 `gpu-picker.ts` 1×1 拾取通道中。

### `pickSprite2D` —— CPU 矩形测试

`pickSprite2D(layers, xPx, yPx)` 接收调用方的 `Sprite2DLayer` 数组（对于 HUD 叠加层为 `spriteRenderer.layers`，或是场景持有的 Sprite2D `Renderable`），并按逆绘制顺序遍历：最后一个图层优先，图层内最后一个 GPU 绘制槽位优先，从而确保最顶层绘制的精灵胜出。普通图层将绘制槽位直接映射到逻辑槽位；Y 排序后的图层通过其当前的稳定置换表映射，仍然返回规范的逻辑槽位。隐藏的精灵（`visible: false`，存储为零尺寸四边形）会被跳过。对每个候选精灵，它会把查询点旋转到精灵感知枢轴的局部矩形中——逆转顶点着色器的枢轴偏移和旋转——落在 `[0, 1]²` 内的点即为命中。它返回第一个命中项 `SpritePickInfo { layer, spriteIndex, u, v }`，其中 `(u, v)` 是命中点在四边形内的比例，未命中则返回 `null`。`(xPx, yPx)` 处于图层共享的局部空间中（与每个精灵的 `positionPx` 同一空间）；对于平移/缩放过的图层，调用方应先将指针坐标映射到该空间。没有全局注册表——调用方通过传入正确的图层数组来选择拾取范围。

### `pickBillboardSprite` —— 接入共享网格通道的 GPU 拾取

`pickBillboardSprite(scene, xPx, yPx, picker?)` 运行一次 `pickAsync` 并返回该通道在命中时附着的公告板载荷，未命中则返回 `null`。默认情况下，它每次调用创建一个瞬态 `GpuPicker` 并在之后销毁，因此一次性拾取（点击）不保留任何 GPU 状态；对于高频拾取（悬停、拖拽），调用方传入通过 `createGpuPicker` 创建的可复用 `GpuPicker`，从而跨调用复用 1×1 目标、场景 UBO 和逐源贡献者（它们负责编译拾取管线），由调用方统一销毁一次。公告板与网格绘制在**同一个** 1×1 拾取渲染通道中，共享拾取 ID 颜色目标、`r32float` 深度目标以及 `greater` 反向 Z 深度测试——因此被网格或更近公告板遮挡的公告板不会赢得拾取。

公告板通过通用的 `PickContributor` 接缝（`registerPickSource` / `scene._pickSources`）接入拾取器——该接缝本身记录在 [18-picking.md](18-picking.md) 中。`addBillboardSystemToScene` 在 `billboard-scene.ts` 中**为每个公告板系统注册一个拾取源**（在 `removeBillboardSystemFromScene` 或场景销毁时注销）。拾取源是纯数据加上动态导入 thunk，因此公告板*渲染*不会拉取任何拾取代码；仅在首次拾取时，拾取器才导入 `billboard-pick-pipeline.ts`，通过 `createPickContributor` 构建贡献者，并在贡献者闭包中缓存其逐拾取器的 GPU 资源。

**绘制与拾取 ID 范围。** 在 `draw(pickCtx, baseId)` 上，公告板贡献者消费 `system.count` 个拾取 ID——即使是隐藏或空系统也是如此，以使 ID 到精灵的映射保持位置对应——并在有内容可绘制时调用 `drawBillboardSystemForPicking`，后者将 `@group(0)` 重新绑定到共享的拾取场景 UBO（更早的贡献者可能重新绑定了 group 0）并发出绘制。

**逐系统 48 字节拾取 UBO**（`BILLBOARD_PICK_UBO_BYTES = 48`），由 `packBillboardPickUbo` 打包；浮点布局匹配 WGSL `BB` 结构体（`vec3` + 标量交错）：

| 浮点数 | 字段       | 备注                                                |
| ------ | ---------- | --------------------------------------------------- |
| 0..2   | `camRight` | 列主序视图矩阵的第 0 行（`view[0,4,8]`）            |
| 3      | `baseId`   | `u32` —— 分配给该系统的首个拾取 ID                  |
| 4..6   | `camUp`    | 视图矩阵的第 1 行（`view[1,5,9]`）                  |
| 7      | `cutoff`   | `f32` —— Alpha 裁切阈值（仅镂空系统；否则为 `0`）   |
| 8..10  | `axis`     | 归一化锁定轴（仅轴锁定系统；面向相机系统为零）      |
| 11     | `_pad`     | 尾部填充                                            |

`camRight` / `camUp` 是相机基向量行，复现渲染着色器的 `normalize(view rowN)`，使拾取到的像素与绘制的四边形一致。拾取通道中不绑定单独的公告板场景 UBO。

**绑定组。** `@group(0)` = 共享拾取场景 UBO（网格拾取所用的同一个）。`@group(1) @binding(0)` = 逐系统拾取 UBO；镂空系统额外绑定图集 `texture@1` + `sampler@2` 以用于 Alpha 测试丢弃。逐实例数据按逻辑（未排序）顺序上传到**顶点**缓冲区，因此 `pickId − baseId` 直接就是精灵索引；共享的双三角形索引缓冲区（`[0, 1, 2, 0, 2, 3]`）绘制每个四边形。如果系统在两次拾取之间扩容，系统的实例缓冲区也会随之增长。

**管线缓存。** 键为 `"${orientation}|${isCutout ? 1 : 0}"` —— 至多四个条目（`facing` / `axis-locked` × 镂空标志）。每个管线在 WGSL 中烘焙变体的基向量数学：`facing` 使用 `normalize(camRight)` / `normalize(camUp)`；`axis-locked` 将 `camRight` 从归一化锁定轴上投影出去。片段着色器在 `@location(0)` 写入作为 RGB 的拾取 ID，并在 `@location(1)` 写入 NDC 深度，匹配网格拾取器的双附件契约；镂空管线在低于 `cutoff` 时执行 `discard`。深度状态为 `depth24plus`，比较函数 `greater`，开启写入。

**解析。** 当拾取器回读到由公告板贡献者拥有的拾取 ID 时，它调用贡献者的 `resolve(info, spriteIndex)`，将 `info._spritePick = { system, spriteIndex, pickedPoint, distance }` 设置上去（局部 ID 直接就是精灵索引）。拾取点和距离来自共享的拾取深度回读（与网格拾取器执行的相同世界点重建，在 `resolve` 之前完成一次）；没有逐公告板的 CPU 射线测试，也没有逐命中的 UV 重建。

---

## 状态机 / 生命周期

### 图集 + 图层创建

```text
loadSpriteAtlas(engine, url, opts) → SpriteAtlas

createSprite2DLayer(atlas, { depth })
  └─> { atlas, depth, capacity, _data (Float32Array), _animations,
        _anchored: null,                                      // sparse map; null until first anchor
        _deferredBuild,
        _version, _gpuVersion, _entityType: "sprite-2d-layer" }

createAxisLockedBillboardSystem(atlas, axis, opts)
  └─> { ..., _entityType: "billboard-sprite-system", orientation: "axis-locked", axis: normalized(axis), ... }
```

### 深度托管场景准入

深度托管精灵准入作为显式启用的 `addDepthHostedSpriteLayerToScene` 辅助函数位于精灵模块中。场景核心仅暴露通用的 `addDeferredSceneRenderables` 钩子；`addToScene` 保持与精灵无关。Renderable 构建与深度模式验证保留在 `sprite-renderable.ts` 中：

```text
addDepthHostedSpriteLayerToScene(scene, layer)
  └─> rejects depth === "none"
  └─> no-op when layer is already a member
  └─> records membership, publishes "added" to subscribers
  └─> addDeferredSceneRenderables(scene, builder)
        └─> buildSpriteRenderable(engine, layer)
        └─> releases the build if the layer left (or left and re-joined) meanwhile;
            otherwise pushes the renderable into the scene
```

纯 2D 应用根本不调用 `addToScene` —— 它们直接创建 `SpriteRenderer`，将其注册到引擎，并在没有任何场景的情况下拥有自己的图层。3D 上带 HUD 的应用将 HUD 图层交给单独的 `SpriteRenderer`，并在 `registerScene` 之后将其注册到引擎；深度托管图层则通过 `addDepthHostedSpriteLayerToScene`。

### 构建（在 `registerScene` 时）

`registerScene(scene)` 运行每一个 `_deferredBuild`。精灵延迟构建器调用静态导入的 `buildSpriteRenderable`，构建管线（带缓存键）、分配逐图层 GPU 实例缓冲区 + UBO，并创建绑定组。深度托管的 `Renderable`（每个通过 `addDepthHostedSpriteLayerToScene` 添加的 Sprite2D 图层对应一个）对于 `depth: "test-write"` 以 `order = 100` 和 `_direct = true` 推入 `scene._renderables`，而对于混合 / `depth: "test"` 则以 `order = 200` 推入，从而使场景现有的 renderable 循环能将其与不透明和透明网格一起拾起并绘制。

`registerScene` **不**创建或拥有任何 `SpriteRenderer`。HUD 叠加层完全由调用方管理。

### 逐帧渲染

```text
startEngine(engine) per-frame:
  1. Acquire swap-chain view + create command encoder.
  2. For each context c in engine._renderingContexts (in registration order):
       a. Pre-pass updates: c._update()
            Scene context:
              - Run scene._beforeRender hooks: clip ticks; anchor projection writes positionPx.
              - Run pre-pass renderables and scene uniform updaters.
            SpriteRenderer:
              - For each dirty layer: upload the canonical dirty range, or let the
                optional Y-sort hook pack/upload its GPU-order range; update layer UBO.
       b. Record draws: c._record()
            Scene context:
              - Execute its frame graph. The default swapchain RenderTask
                buckets and draws renderables sorted by `order`:
                  * meshes opaque (order 0)
                  * Sprite2D depth-hosted cutout / `"test-write"` (order 100)
                  * meshes transparent
                  * Sprite2D depth-hosted blended / `"test"` (order 200)
                  * billboards (order 200)
            SpriteRenderer:
              - Open a sprite-only sampleCount=1 pass directly on the
                per-frame swapchain view with no depth attachment.
              - For each layer in this.layers (sorted by layer.order):
                  bind pipeline + groups; drawIndexed(6, count).
  3. Submit command buffer.
```

任何地方都没有 `if (is2D)`。引擎只是遍历其 `_renderingContexts` 列表并要求每个上下文更新与录制。具有零个非空图层的 `SpriteRenderer` 完全跳过其通道。没有 Sprite2D renderable 的场景只绘制网格和公告板。

### 销毁

`disposeScene(scene)` 调用 `scene._disposables` 中的每一个回调，包括每个自定义 renderable 集合释放其成员的场景构建 GPU 状态和拾取源（静默释放，不触发“removed”事件）、逐 renderable 的 GPU 缓冲区 / 绑定组 / 管线清理、逐图层的锚点钩子移除，以及逐目标的深度/MSAA 附件释放（现有代码；精灵不添加新附件）。

调用方注册在引擎上的任何 HUD `SpriteRenderer` 均由调用方另行负责销毁。推荐模式是在 `registerSpriteRenderer` 之后通过 `onSceneDispose(scene, () => disposeSpriteRenderer(hud))` 将 HUD 销毁绑定到场景生命周期，从而单次 `disposeScene(scene)` 调用也能一并销毁 HUD。

`disposeSpriteRenderer(sr)` 释放渲染器的管线缓存（逐设备，最多四个条目）以及任何逐渲染器 UBO，且在未先调用 `unregisterSpriteRenderer` 的情况下也可以安全调用——它会同时完成注销和释放。

Y 排序状态仅存在于 CPU 且归图层所有，不归渲染器所有。因此销毁渲染器不会禁用或销毁它：同一个图层可以附着到新的渲染器上，其下一次 `uploadedVersion === -1` 同步会重建排序后的 GPU 表示。当调用方希望在丢弃图层前释放数组时，`disableSprite2DYSort(layer)` 会移除附着并在禁用期间强制执行一次规范顺序上传。后续重新启用会以新的默认偏置和从零重新开始的插入序号创建新状态；它绝不会复活已释放的状态。

---

## 句柄、身份与父子级关系

稳定句柄身份被实现为索引 API 之上的可选层。父子级关系和可观察字段对象仍是路线图扩展。

Babylon Lite 中的精灵使用**两级 API**，镜像了面向数据引擎中常见的 Index/Handle 拆分（也平行于 Lite 在 3D 几何体上的 ThinInstance vs. Mesh 拆分）。

### 两级 API 设计

| 层级           | 函数                                                                                                                                                                 | 返回值                                     | 适用场景                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Index API**  | `addSprite2DIndex`、`updateSprite2DIndex`、`removeSprite2DIndex`、`clearSprite2DLayer`、`setSprite2DFrameIndex`（以及公告板的 `addBillboardSpriteIndex` 等）         | `number`（槽位索引）                       | 瓦片地图、布景、粒子、大型固定布局 HUD。最高吞吐量，零逐精灵 GC。索引**不稳定** —— `removeXIndex` 会执行交换移除        |
| **Handle API** | `addSprite2D`、`removeSprite2D`、`addBillboardSprite`、`removeBillboardSprite` 及匹配的更新辅助函数                                                                  | `Sprite2DHandle` / `BillboardSpriteHandle` | 玩家角色、敌人、会移动或之后会挂载父级的 UI 元素。稳定 ID，移除安全的更新辅助函数                                     |

马里奥类比：`Index` 是场景瓷砖（设置一次，永不更新，可以生成 10,000 个）；`Handle` 是马里奥本人（每帧移动，挂载在移动平台上，拥有动画状态）。

句柄模块位于独立文件中，因此仅使用索引 API 的场景永远不会加载句柄代码（见下文 **Tree-shaking**）。持有句柄会刻意使其所属图层/系统保持 GC 可达，直到该句柄自身不再可达为止。

### 稳定 ID（`idToIndex` / `indexToId`）

每个句柄拥有一个 `readonly id: number`（u32，从家族句柄状态单调分配）。图层/系统拥有两个平行结构，在首次创建句柄时惰性分配：

- `idToIndex: Map<number, number>` —— 将 `handle.id` 映射到当前槽位索引。
- `indexToId: Uint32Array` —— 与存储容量平行；将槽位索引映射到 `handle.id`（0 = 该槽位无句柄，因为 id 从 1 开始）。

当 `removeXIndex` 将最后一个槽位交换移除到释放出的槽位时，它会调用一个惰性安装的通用钩子来修补这两个映射，使被移入槽位的 id 解析到其新索引。当调用 `removeSprite2D(handle)` 或 `removeBillboardSprite(handle)` 时，句柄模块通过 `idToIndex` 解析句柄的当前槽位，然后调用现有的索引移除辅助函数。同一个钩子使被移除句柄的 id 失效，并重新绑定被移入的句柄 id。

**开销：** `_indexToId` 中每个槽位 4 B + 每次句柄变更一次 Map 查找。索引 API 用户完全跳过 Map 和 `Uint32Array`——他们保留原始索引，且不支付任何句柄状态分配。基础状态对象上仅有一个可选钩子槽位，钩子对象在首次调用 `add*` 句柄函数时由句柄模块安装。如果未导入句柄模块，打包会完全剔除它。

### 路线图可观察句柄字段表

当前句柄 API 提供稳定身份加上独立的更新/移除辅助函数。可观察字段计划作为同一套 id 和映射表之上的后续层。

**`Sprite2DHandle`**（Sprite2D 家族）：

| 字段       | 写入的槽位浮点数（按 `SPRITE_2D_STRIDE = 20`）                    | Setter 副作用                                                          |
| ---------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `position` | `[off+0]` = x，`[off+1]` = y                                      | 将 worldMatrix2D 标记为脏；如有父级，遍历器下一帧会覆盖                |
| `sizePx`   | `[off+2]` = w·scale.x，`[off+3]` = h·scale.y（仅无父级时）        | 将槽位标记为脏                                                         |
| `pivot`    | `[off+4]`、`[off+5]`                                              | —                                                                      |
| `scale`    | （不直接写入——缩放到 sizePx 中）                                  | 将 worldMatrix2D 标记为脏；重写打包尺寸                                |
| `color`    | `[off+12..15]`                                                    | —                                                                      |
| `rotation` | （通过 `updateSprite2DIndex` 修补 —— sin/cos 位于 `[off+6..7]`）  | 将 worldMatrix2D 标记为脏                                              |
| `frame`    | 位于 `[off+8..11]` 的 UV                                          | 调用 `setSprite2DFrameIndex`                                           |
| `visible`  | 在原值与 0 之间切换打包的 sizePx                                  | 调用 `writeSizePx`                                                     |
| `layerZ`   | `[off+16]`                                                        | 钳位到 `[0, 1]`                                                        |
| `parent`   | （仅 `IParentable2D`；不直接触碰槽位）                            | 添加/移除出 `_parentedHandles`；在首次设置父级时安装遍历器             |
| `anchor`   | （不直接写入；CPU 投影每帧写入 positionPx + layerZ）              | 设置 `AnchorSource` 添加到图层 `_anchored` 映射；设为 `null` 则移除    |

**`BillboardSpriteHandle`**（公告板家族）结构相似，但使用 3D `position: ObservableVec3` 和 `sizeWorld: ObservableVec2` 替代 `sizePx`。其 `parent` setter 接收任意 `IWorldMatrixProvider`（Mesh、TransformNode，甚至另一个精灵句柄）。

### `anchor` setter —— 锚定精灵仍然是 Sprite2D 句柄

```typescript
export interface Sprite2DHandle {
    // ... fields above ...

    /** Optional world anchor. Setting this attaches the AnchorSource;
     *  setting null removes it. Setting it to a different AnchorSource
     *  swaps the projection target without recreating the handle. */
    anchor: AnchorSource | null;
}
```

`anchor` setter 委托给 `setSprite2DAnchor(layer, slot, src)`——后者位于 `sprite-anchor.ts` 中，在首次赋值锚点时动态导入。从未用作锚定精灵的句柄为锚点代码支付零字节。设置 `handle.anchor = createParentAnchor(mesh)` 是将精灵固定到移动 3D 实体的规范方式；锚点本身编码了父子关系，这使句柄的父子级故事与 3D 跟踪句柄保持统一。将其设回 `null` 会移除图层的锚点条目，并（如果是最后一个条目）销毁每帧投影钩子。

### 3D 父子级（公告板句柄）

`BillboardSpriteHandle` 实现了 `IParentable` + `IWorldMatrixProvider` —— 与网格使用的接口相同。设置 `handle.parent = mesh` 将句柄添加到 `system._parentedHandles: Set<IParentedBillboardHandle>`，并通过函数指针钩子 `system._parentedHandlesWalker` 安装每帧遍历器（见下文 **Tree-shaking**）。

每帧在存储同步之前，renderable 会调用存在的遍历器。遍历器迭代 `_parentedHandles`，读取每个句柄的 `worldMatrix`（通过 `WorldMatrixAccessors` 沿链惰性解析），并仅将**世界平移**写入槽位 `[off+0..2]`。精灵旋转保持为槽位中的 2D 绕枢轴旋转；父级旋转和缩放**不会**传播到精灵的四边形朝向（公告板在其 renderable 中面向相机；允许父级旋转使其倾斜会违背公告板的初衷）。只有平移会传播。

未设置父级的句柄不遍历任何工作——在首次调用 `handle.parent = …` 之前，`_parentedHandles` 为 `null`。

### 2D 父子级（Sprite2D）

Sprite2D 句柄实现了 `IParentable2D` + `IWorldMatrix2DProvider`，即基于 `Mat3` 仿射矩阵而非 `Mat4` 构建的 2D 对应接口。这使得 Spine 风格的 2D 骨骼层级成为可能：父级精灵的旋转和缩放**确实会**传播给子级（由于 Sprite2D 四边形在 2D 中是显式定向的，没有“始终面向相机”的约束会被破坏）。

Sprite2D 句柄增加了一个 `scale: ObservableVec2` 字段（默认 `(1, 1)`），使句柄可以在 `sizePx` 之上表达非均匀局部缩放。遍历器（`walkParentedSprite2DHandles`）将每个句柄的世界 `Mat3` 分解为 `(tx, ty)`、旋转和 `(sx, sy)`，然后写入：

- `[off+0..1]` = `(tx, ty)` —— 世界平移
- `[off+2..3]` = `(sizePx.x · sx, sizePx.y · sy)` —— 包含世界缩放的打包尺寸
- `[off+4..5]` = pivot（保持局部值不变）
- `[off+6..7]` = `(sin(rot), cos(rot))` —— 世界旋转

### Tree-shaking

句柄模块和遍历器模块刻意放在**单独的文件**中，使每个 renderable 的静态导入图始终不含句柄代码：

- **Renderable 文件**（`sprite-renderable.ts`、`billboard-renderable.ts`）仅静态导入家族状态文件（`sprite-2d.ts`、`billboard-sprite.ts`）——不导入句柄模块，不导入遍历器模块。未来的句柄支持应继续使用函数指针钩子，以便仅使用索引 API 的场景支付零句柄遍历器开销。
- **句柄模块**仅静态导入家族索引模块。未来的父子级支持必须保留在首次设置 `handle.parent = …` 时通过函数指针钩子赋值的独立遍历器模块中，从而使使用句柄但从不使用父子级的应用仍不加载遍历器代码。
- **仅使用索引 API 的应用**（例如瓦片地图场景）从不导入任何句柄模块，因此 `idToIndex` / `indexToId` / `_parentedHandles` / `_parentedHandlesWalker` 永远不会被分配。句柄模块的字节会从打包产物中被彻底 tree-shake 掉。

### 未来物理集成

句柄的 `position: ObservableVec3`（或 Sprite2D 的 `ObservableVec2`）是未来 `@babylon-lite/physics-2d` / `physics-3d` 包的天然集成点。物理刚体每帧通过每帧同步从其求解器状态写入 `handle.position.x = …`；可观察对象的写回路径捕获该更改并将其推入 GPU 缓冲区（或对于有父级的句柄推入世界矩阵）。无需修改核心。

这保留了“不用就不付费”的边界：物理是一个只看到公共 Handle API 且绝不触及图层内部的可选包。

---

## Babylon.js 对照表

| Babylon.js                                        | Babylon Lite                                                          | 备注                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `SpriteManager`（2D 用法）                        | `Sprite2DLayer`（任意场景）                                           | 无独立 2D 场景类型                                                              |
| `SpriteManager`（3D 用法，世界尺寸）              | `*BillboardSpriteSystem`                                              | 始终世界空间、透视校正                                                          |
| `SpritePackedManager`                             | 路线图命名图集包装器 + 家族工厂                                       | 当前图集路径仅支持数字网格/加载                                                 |
| `Sprite`                                          | `*Init` 接口 + 逐家族索引辅助函数                                     | 当前 API 返回可变槽位索引                                                       |
| `sprite.cellIndex` / `cellRef`                    | `setSprite*FrameIndex(layer, idx, frame)`                             | 当前 `frame` 为数字                                                             |
| `sprite.playAnimation(from, to, loop, delay, cb)` | 路线图片段辅助函数                                                    | 当前分支未实现命名片段                                                          |
| `sprite.invertU` / `invertV`                      | `init.flipX` / `init.flipY`                                           |                                                                                 |
| `sprite.angle`                                    | `init.rotation`（弧度）                                               |                                                                                 |
| `sprite.position`                                 | `init.positionPx`（Sprite2D）/ `init.position`（Billboard）           | Sprite2D 的世界锚定属于路线图                                                   |
| `sprite.size` / `width` / `height`                | `init.sizePx`（Sprite2D）/ `init.sizeWorld`（Billboard）              | 类型编码了像素空间与世界空间的区分                                              |
| `sprite.color`                                    | `init.color` / `update*({ color: [r,g,b,a] })`                        | 逐精灵色调                                                                      |
| `mesh.billboardMode = BILLBOARDMODE_ALL`          | `createFacingBillboardSystem`                                         | 显式工厂                                                                        |
| `mesh.billboardMode = BILLBOARDMODE_Y`            | `createAxisLockedBillboardSystem(atlas, [0,1,0])`                     | 世界 Y 轴是偏航锁定的特例                                                       |
| `mesh.billboardMode = BILLBOARDMODE_X/Z`          | `createAxisLockedBillboardSystem(atlas, [1,0,0])`                     | 同一工厂覆盖所有锁定轴                                                          |
| `SpriteManager.disableDepthWrite`                 | `Sprite2DLayer.depth`（`"test"` / `"test-write"`）+ `SpriteBlendMode` | 由组合器逐图层烘焙                                                              |
| `sprite.blendMode`（ADD / MULTIPLY 等）           | 可导入的 `spriteBlend*` / `billboardBlend*` 描述符值                  | 可 tree-shake；无字符串查找表                                                   |
| 精灵上的自定义 `ShaderMaterial`                   | `createSprite2DCustomShader` / `createBillboardCustomShader`          | WGSL 片段主体 + `fx.time` / `fx.params` / 额外纹理                              |
| 动画/滚动纹理（`uOffset`/`vOffset`）              | `Sprite2DLayerOptions.uvScroll` + 逐精灵 `uvOffset`                   | 显式启用的逐精灵 UV 偏移（视差）                                                |
| `AdvancedDynamicTexture` + `Image`                | 3D `SceneContext` 上的 `Sprite2DLayer` 叠加层                         | 不同定位 —— 无 GUI 树                                                           |
| `scene.pickSprite(x, y)`                          | `pickSprite2D`（CPU）/ `pickBillboardSprite`（GPU）                   | 图层用 CPU 矩形测试；公告板用接入共享网格通道的 GPU 拾取                        |
| `SpriteMap`（瓦片地图）                           | 超出范围                                                              | 未来模块                                                                        |
| `SpriteManager` `epsilon` 参数                    | *无等价物*                                                            | 当渗色有问题时，图集必须带有透明边界 / NPOT / 填充子矩形                        |
| 四边形 VBO                                        | 无顶点（`vertex_index`）                                              | 消除了静态四边形缓冲区                                                          |

### 路线图锚定尺寸 —— 常见移植陷阱

`sprite-anchor.ts` 中的 CPU 投影代码遵循 GPU 顶点着色器原本会使用的同一契约：`clipPos.w = cz`（相机空间深度，而非 3D 距离），屏幕向上 = 相机向上。锚定精灵通过在投影后的锚点上添加裁剪空间像素偏移来维持固定像素尺寸。

当从手写的、每帧重新计算 `sprite.size` 的 BJS 场景移植“恒定像素尺寸”代码时，有两个 BJS 侧的错误在孤立状态下看似正确，但与 Lite 的精确投影不一致：

- **使用相机空间深度 `cz`，而非 3D 距离。** BJS 精灵着色器使用 `clipPos.w = cz` 进行透视除法，因此任意锚点处的每像素世界尺度为 `(2 · cz · tan(fov/2)) / viewportHeight`。计算 `Vector3.Distance(anchor, camPos)` 会过度放大离轴精灵，因为距离包含了投影并不包含的横向分量。按 `|forward · anchor + tz|` 从视图矩阵提取 `cz`（按 `Matrix.LookAtLHToRef` 定义的 BJS 视图矩阵：前向轴 `(m[2], m[6], m[10])`，平移 `(m[12], m[13], m[14])`）。

- **沿相机的上方向轴而非世界 Y 轴应用屏幕空间偏移。** 在倾斜相机上，“屏幕空间 −32 px”的偏移是沿着屏幕上方向（映射到视图矩阵的世界向上轴：`(m[1], m[5], m[9])`），而不是世界 Y 轴。仅当相机未倾斜时，世界 Y 才等于屏幕上方向。

Lite 的锚定投影直接在裁剪空间完成等价计算（锚点经 VP 投影，然后以 `(2 · offsetPx / viewport) · w` 加上 `offsetPx`），因此在 Lite 侧不会出现这两个陷阱——它们仅在移植或编写一致性参考场景时才会显现。现在锚定 Sprite2D 图层每帧在 CPU 上执行相同的数学计算；`sprite-anchor.ts` 中的投影辅助函数精确实现了 `(2 · offsetPx / viewport) · w`。

---

## 依赖关系

导入：

- 来自 `../texture/texture-2d.js` 的 `Texture2D`、`loadTexture2D`
- 来自 `../engine/engine.js` 的 `EngineContext`
- （仅在 `sprite-scene.ts` 集成代码中，不在纯 2D 打包产物中）来自 `../scene/scene-core.js` 的 `SceneContext`（仅类型导入）
- （仅在 `sprite-scene.ts` / `billboard-scene.ts` 中，不在纯 2D 打包产物中）来自 `../scene/scene-renderable-collection.js` 的自定义 renderable 集合辅助函数
- （仅在 `sprite-scene.ts` 集成代码中，不在纯 2D 打包产物中）来自 `./sprite-renderable.js` 的 `buildSpriteRenderable`
- （仅在 `billboard-scene.ts` 中，不在纯 2D 打包产物中）来自 `../picking/pick-contributor.js` 的 `registerPickSource`
- （仅在动态公告板 renderable 分块中）`getViewMatrix`、`getSceneBindGroupLayout`、GPU 缓冲区辅助函数以及公告板管线模块

惰性 / 动态导入：

- `billboard-renderable.ts` 和 `billboard-pipeline.ts` —— 仅当 `registerScene` 运行排队的公告板构建器时由 `addBillboardSystemToScene` 拉入。

被以下模块依赖：

- `lab/lite/src/lite/scene50.ts` 至 `scene57.ts` —— 当前的 2D、HUD、深度托管和公告板参考场景。自定义着色器、UV 滚动和叠加/正片叠底混合场景为 `scene92.ts` 至 `scene98.ts`。
- `particle/particle-sprite-2d.ts` —— 可选的 NPE 桥接消费 `SpriteAtlas`、`Sprite2DLayer`、打包实例存储、混合描述符和 `SpriteRenderer`；此依赖绝不会从精灵反向指向粒子。

不依赖：

- PBR / Standard / Background 材质、ShaderComposer、Mesh、Skeleton、Morph、Shadow 模块——精灵使用独立的 WGSL，不进行片段组合。

---

## 测试规范

### 单元测试（vitest）

- `sprite-renderer.test.ts` —— 纯 2D 渲染器生命周期、图层成员关系、管线缓存和深度模式护栏。
- `sprite-2d-y-sort.test.ts` —— 显式启用创建与深度拒绝；升序绘制顺序；持久序号平局；索引和句柄偏置；Y/非 Y 脏行为；添加/容量增长；交换移除；不复用序号的清空；隐藏精灵；无效值；规范实例/句柄身份；规范普通上传；缓冲区恢复后的排序重传；以及跨 Y 排序图层的最顶层拾取。
- `sprite-depth-hosted-routing.test.ts` —— `addDepthHostedSpriteLayerToScene(scene, layer)` 路由、深度-模板管线格式、上传大小、绑定组兼容性以及销毁。
- `scene-renderable-collection.test.ts` —— 深度托管图层、公告板和文本集合成员关系：幂等添加、移除返回值、按添加顺序发现、变更事件、构建前移除/重新添加、构建后移除、拾取源注销以及场景销毁。
- `billboard-sprite.test.ts` —— 紧凑公告板实例布局、场景辅助函数路由、透明 CPU 排序、镂空深度写入管线状态以及轴归一化。
- `particle-sprite-2d.test.ts` —— 桥接所有权、精确打包布局写入、坐标与混合映射、事务性渲染器附着以及销毁生命周期。
- `render-pass-task.test.ts` —— 透明绑定更新在透明分桶排序前运行，使公告板 `_worldCenter` 变化影响同帧绘制顺序。
- `rendering-context-registration.test.ts` —— 引擎渲染上下文注册、场景注册幂等性、销毁注销以及预注册帧图任务录制。

### 可视化测试（Playwright）

现有场景系列直接移植（由于投影数学相同，基准图逐像素等价）：

- **Scene 50/51-sprite-grid** —— 由注册在引擎上的 `SpriteRenderer` 驱动的纯 `Sprite2DLayer`；不存在 `SceneContext`。
- **Scene 52-hud-on-3d** —— 一个 3D 场景加上为 HUD 图层单独注册的 `SpriteRenderer`。
- **Scene 53-depth-hosted-sprites** —— 通过 `addDepthHostedSpriteLayerToScene` 添加到场景的 `Sprite2DLayer { depth: "test" | "test-write" }`。
- **Scene 54-facing-billboards** —— 面向相机公告板系统、Alpha 混合以及与不透明盒子的深度测试。
- **Scene 55-billboard-sorting** —— 紧凑实例上传前的透明公告板 CPU 排序。
- **Scene 56-axis-locked-billboards** —— 任意轴锁定公告板基向量数学。
- **Scene 57-cutout-billboards** —— 镂空公告板 Alpha 丢弃、无混合状态与深度写入。

在 `engine/sprite-additive-customshader` 分支上添加的特性场景（每个都带有 Lite 实现、Babylon.js 基准参照和一致性测试规范）：

- **Scene 92-sprite-customshader-params** —— 由 `fx.params` 色调驱动的 2D 精灵自定义着色器。
- **Scene 93-sprite-customshader-palette** —— 带 256×1 调色板重映射查找纹理的 2D 精灵自定义着色器。
- **Scene 94-billboard-customshader-params** —— 面向相机公告板自定义着色器，`fx.params` 色调。
- **Scene 95-billboard-customshader-palette** —— 面向相机公告板自定义着色器，调色板重映射。
- **Scene 96-sprite-uvoffset-parallax** —— 带有固定 `uvOffset` 带状区域的 `uvScroll` 图层（视差）。
- **Scene 97-sprite-multiply-blend** —— `spriteBlendMultiply`。
- **Scene 98-billboard-additive-blend** —— `billboardBlendAdditive`。

Lite 原生集成覆盖：

- **Scene 300-npe-sprite2d** —— 通过独占 Sprite2D 桥接和纯 2D `SpriteRenderer` 渲染的确定性冻结 NPE 状态。其 Playwright 规范检查桥接/绑定状态、实时同步、稳定的冻结粒子数据、渲染器成员关系、绘制提交和可见输出。该场景标为 `skipParity`，因为 Babylon.js 没有等价的纯 2D 桥接路径。
- **Scene 303-sprite2d-y-sort** —— 三组孤立的重叠对通过采样 RGB 和 `pickSprite2D` 证明公共行为。在实时 Y 对中，槽位 0 在槽位 1 之前插入，随后从 Y=260 移动到 Y=360；升序 Y 排序必须将槽位 0 绘制/拾取在槽位 1 之上，而规范顺序会错误地让后插入的槽位 1 留在顶部。在等 Y 对中，重叠的槽位 2 和 3 共享 Y=340，后插入序号 3 必须在视觉和拾取上胜出。在偏置对中，位于 Y=290 的槽位 4 接收 +60，必须绘制/拾取在位于 Y=320 的较后规范槽位 5 之上。专项 Playwright 规范断言全部三组重叠颜色和拾取结果；禁用 Y 排序会使实时 Y 和偏置样本解析回规范槽位 1 和 5。它标为 `skipParity`，因为这是一个没有 Babylon.js 基准或基准图的 Lite 原生渲染器扩展。

### 打包体积上限

打包体积棘轮检查：

- **纯 2D 上限。** 仅导入 `createEngine`、`loadSpriteAtlas`、`createSprite2DLayer`、`addSprite2DIndex`、`createSpriteRenderer`、`registerSpriteRenderer` 和 `startEngine` 的纯 2D 入口点**绝不能**获取以下任何模块：`scene/scene-core.js`、`sprite-anchor.js`、`billboard-renderable.js`、`billboard-pipeline.js`、`camera/*`、`light/*`、`mesh/*`、`shadow/*`、`material/pbr/*`、`material/standard/*`、`picking/*`。这是最重要的一条上限——也是将 `SpriteRenderer` 拆分为独立于场景的模块的根本理由。
- **深度托管无公告板上限。** 带有深度托管 Sprite2D 图层但没有公告板的场景**绝不能**获取公告板 renderable、公告板管线或 GPU 拾取器。
- **公告板场景辅助函数上限。** 导入公告板工厂函数但未将公告板系统排入场景时，**绝不能**在运行时获取 `billboard-renderable.ts` / `billboard-pipeline.ts`。
- **纯网格无精灵上限。** 没有精灵的场景**绝不能**获取 `sprite-2d.js`、`sprite-renderer.js` 或公告板模块。
- **Y 排序隔离。** 对比 Scene303 和 Scene50 的过滤生产构建。Scene303 必须保留 Y 排序实现、SpriteRenderer 和 CPU 拾取器，同时排除深度托管/公告板路径。Scene50 绝不能包含或获取 `sprite-2d-y-sort.ts`、`sprite-2d-handle-y-sort.ts`、它们的状态字段令牌或排序逻辑。它的中性空钩子位于本就必需的 `sprite-2d.ts` 中，因此运行时图中不得出现任何单独的可选钩子模块。

---

## 文件清单

```text
packages/babylon-lite/src/

  scene/
    scene-core.ts                                # Existing SceneContext + addToScene switch + startEngine + onBeforeRender + disposeScene

  sprite/
    shared/
      sprite-atlas.ts                            # SpriteAtlas, createGrid/loadSpriteAtlas, internal resolveSpriteFrame

    sprite-2d.ts                                 # createSprite2DLayer + Index API + neutral null Y-sort seam (no sorting semantics)
    sprite-blend.ts                              # spriteBlend* descriptor values (alpha/premultiplied/additive/one-one/multiply); tree-shakable
    billboard-blend.ts                           # billboardBlend* descriptor values (alpha/premultiplied/cutout/additive); tree-shakable
    blend-descriptors.ts                         # Shared _ALPHA_BLEND_STATE / _PREMULTIPLIED_BLEND_STATE GPUBlendState constants
    sprite-fx-hook.ts                            # Lazy null-by-default custom-shader registry (SpriteFxHook/BillboardFxHook); keeps custom-shader bytes off the always-loaded path
    custom-shader-core.ts                        # Shared custom-shader mechanics (extra-texture bindings, name validation, SpriteFx UBO, key allocation)
    sprite-custom-shader.ts                      # createSprite2DCustomShader; registers the 2D SpriteFxHook impl
    billboard-custom-shader.ts                   # createBillboardCustomShader; registers the billboard FxHook impl
    sprite-renderable.ts                         # Renderable builder for Sprite2DLayer depth-hosted layers
    sprite-pipeline.ts                           # Sprite2D WGSL, pipeline cache, dirty upload helpers
    sprite-renderer.ts                           # createSpriteRenderer / registerSpriteRenderer / unregisterSpriteRenderer / disposeSpriteRenderer + (sampleCount, hasDepth) pipeline cache

    sprite-2d-handle.ts                          # Optional stable-id Sprite2D Handle API; lazy maps/hooks, no render code
    sprite-2d-y-sort.ts                          # Optional stable Y-sort state, merge sort, packed uploads, Index bias API
    sprite-2d-handle-y-sort.ts                   # Optional stable-handle bias companion; Index-only Y-sort does not import handles

    billboard-sprite.ts                          # BillboardSpriteSystem factories + Index API + 64-byte float-color instance storage
    billboard-sprite-handle.ts                   # Optional stable-id Billboard Handle API; lazy maps/hooks, no render code
    billboard-scene.ts                           # add/remove/get/onChanged billboard collection; dynamically imports the renderable builder
    billboard-renderable.ts                      # Scene Renderable wrapper, transparent CPU sort, world-center maintenance, GPU resource lifetime
    billboard-pipeline.ts                        # Billboard WGSL composer, pipeline cache, UBO and instance upload helpers

    sprite-animation.ts                          # Optional sprite frame animation core manager + scene/renderer attachment helpers
    sprite-2d-index-animation.ts                 # Optional Sprite2D raw-index frame animation helper
    sprite-2d-handle-animation.ts                # Optional Sprite2D stable-handle frame animation helper
    billboard-sprite-index-animation.ts          # Optional Billboard raw-index frame animation helper
    billboard-sprite-handle-animation.ts         # Optional Billboard stable-handle frame animation helper

    # Roadmap modules: anchors, and sprite picking.
```

渲染器原生 Y 排序特性不添加任何 BJS 源码、基准参考、PNG 或包子路径导出。其实现保持隔离在可选的 Y 排序模块中；基础 Sprite2D 路径上仅存在不透明的、默认为空的接缝。

---

## 精灵帧动画（可选）

**模块：** `sprite-animation.ts` 用于无副作用的精灵帧状态/更新逻辑，`sprite-animation-task.ts` 用于通用 `AnimationManager` 集成，再加上每个目标类型一个极小的家族绑定模块。静态精灵不导入其中任何一个，支付零动画字节。

为 Sprite2D（索引/句柄）和 BillboardSprite（索引/句柄）家族提供 Babylon.js 风格的逐精灵帧动画。动画由 `SpriteAnimationManager` 收集，它可以通过以下方式驱动：

- 通过 `updateSpriteAnimationManager(manager, deltaMs)` 手动驱动
- 通过 `addSpriteAnimationManager(animationManager, spriteManager)` 注册到通用 `AnimationManager`
- 通过 `attachSpriteAnimationsToScene(scene, manager)` 挂载到 `SceneContext` 以在 `scene._beforeRender` 中更新
- 通过 `attachSpriteAnimationsToRenderer(sr, manager)` 挂载到 `SpriteRenderer` 以在图层上传前更新

### 核心原则

- **零模块级副作用。** 导入时不分配任何对象。
- **可选挂载辅助函数。** 基础精灵家族从不导入动画代码。核心模块没有对精灵家族的运行时导入；家族绑定模块仅导入它们所需的特定索引或句柄辅助函数。
- **Babylon.js 时序语义：**
    - 立即从 `from` 帧开始
    - 当累计时间**严格大于**延迟时间（而非 `>=`）时推进一帧
    - 较大的时间增量（> 延迟）每次更新只推进一帧（钳位帧步进）
    - 循环动画重置回 `from`；非循环动画停在 `to` 并触发一次回调
    - 支持反向播放（`from > to`）；非循环反向结束于 `to`
    - 延迟时间下限钳位为 1ms
- **索引与句柄分离。** 仅使用索引的调用方为句柄跟踪代码支付零字节。基于句柄的动画通过稳定身份在交换移除后依然有效。
- **原始索引动画是槽位动画。** `playSprite2DIndexAnimation` 和 `playBillboardSpriteIndexAnimation` 有意绑定到结构稳定的图层/系统上的数字槽位。如果调用方交换移除了该槽位，动画会跟随新的占用者。需要稳定精灵身份时请使用句柄辅助函数。
- **管理器所有权显式化。** 添加动画会将其跟踪在所属管理器中。将同一动画重复添加到同一个管理器是 O(1) 空操作；将其添加到另一个管理器会先从先前的所有者拆离。完成、移除和清空路径会在内部取消所有者设置。
- **重播选项显式化。** `playSpriteFrameAnimation` 在省略其 `options` 参数时保留现有的回调/移除选项，并在传入选项对象时替换它们。
- **`removeWhenFinished` 选项**（等价于 Babylon.js 在动画结束时销毁）：
    - 对于句柄：调用 `removeSprite2D(handle)` 或 `removeBillboardSprite(handle)`
    - 对于原始索引：对该槽位的当前占用者调用 `removeSprite2DIndex(layer, index)` 或 `removeBillboardSpriteIndex(system, index)`（适用交换移除语义）

### API

```typescript
export interface SpriteFrameAnimation {
    readonly _entityType: "sprite-frame-animation";
    readonly target: SpriteAnimationTarget;
    from: number;
    to: number;
    current: number;
    loop: boolean;
    delayMs: number;
    accumulatedMs: number;
    animationStarted: boolean;
    onEnd?: () => void;
    removeWhenFinished: boolean;
}

export interface SpriteAnimationTarget {
    readonly setFrame: (frame: number) => void;
    readonly remove?: () => void;
    readonly isAlive?: () => boolean;
}

export interface SpriteAnimationManager {
    readonly _entityType: "sprite-animation-manager";
    animations: SpriteFrameAnimation[];
    fixedDeltaMs: number;
    running: boolean;
}

export interface SpriteAnimationBinding {
    readonly _entityType: "sprite-animation-binding";
    active: boolean;
}

export interface SpriteAnimationManagerOptions {
    fixedDeltaMs?: number;
    onUpdate?: (deltaMs: number) => void;
}

export interface PlaySpriteAnimationOptions {
    onEnd?: () => void;
    removeWhenFinished?: boolean;
}

// Core manager (no sprite family imports at module level)
export function createSpriteAnimationManager(options?: SpriteAnimationManagerOptions): SpriteAnimationManager;
export function createSpriteFrameAnimation(
    target: SpriteAnimationTarget,
    from: number,
    to: number,
    loop: boolean,
    delayMs: number,
    options?: PlaySpriteAnimationOptions
): SpriteFrameAnimation;
export function addSpriteAnimation(manager: SpriteAnimationManager, anim: SpriteFrameAnimation): void;
export function removeSpriteAnimation(manager: SpriteAnimationManager, anim: SpriteFrameAnimation): void;
export function clearSpriteAnimations(manager: SpriteAnimationManager): void;
export function updateSpriteAnimationManager(manager: SpriteAnimationManager, deltaMs: number): void;
export function playSpriteFrameAnimation(anim: SpriteFrameAnimation, from?: number, to?: number, loop?: boolean, delayMs?: number, options?: PlaySpriteAnimationOptions): void;
export function stopSpriteAnimation(anim: SpriteFrameAnimation): void;

// Generic AnimationManager task adapter
export function addSpriteAnimationManager(manager: AnimationManager, spriteManager: SpriteAnimationManager): void;
export function removeSpriteAnimationManager(manager: AnimationManager, spriteManager: SpriteAnimationManager): void;
export function startSpriteAnimationManager(manager: SpriteAnimationManager): void;
export function stopSpriteAnimationManager(manager: SpriteAnimationManager): void;

// Family helpers (import sprite families on first call)
export function playSprite2DIndexAnimation(
    manager: SpriteAnimationManager,
    layer: Sprite2DLayer,
    index: number,
    from: number,
    to: number,
    loop: boolean,
    delayMs: number,
    options?: PlaySpriteAnimationOptions
): SpriteFrameAnimation;

export function playSprite2DAnimation(
    manager: SpriteAnimationManager,
    handle: Sprite2DHandle,
    from: number,
    to: number,
    loop: boolean,
    delayMs: number,
    options?: PlaySpriteAnimationOptions
): SpriteFrameAnimation;

export function playBillboardSpriteIndexAnimation(
    manager: SpriteAnimationManager,
    system: BillboardSpriteSystem,
    index: number,
    from: number,
    to: number,
    loop: boolean,
    delayMs: number,
    options?: PlaySpriteAnimationOptions
): SpriteFrameAnimation;

export function playBillboardSpriteAnimation(
    manager: SpriteAnimationManager,
    handle: BillboardSpriteHandle,
    from: number,
    to: number,
    loop: boolean,
    delayMs: number,
    options?: PlaySpriteAnimationOptions
): SpriteFrameAnimation;

// Attachment helpers (optional scene/renderer integration)
export function attachSpriteAnimationsToScene(scene: SceneContext, manager: SpriteAnimationManager): SpriteAnimationBinding;

export function attachSpriteAnimationsToRenderer(sr: SpriteRenderer, manager: SpriteAnimationManager): SpriteAnimationBinding;

export function disposeSpriteAnimationBinding(binding: SpriteAnimationBinding): void;
```

以下划线为前缀的运行时记账字段（如 RAF 句柄、活动渲染循环绑定以及动画所有权/方向跟踪）刻意保持在未导出的内部类型之后。公共 API 块中仅有的下划线字段是判别标签。

### 用法示例

```typescript
// Scene-based with attachment
const scene = createSceneContext(engine);
const atlas = await loadSpriteAtlas(engine, "sprites.png", { gridSize: [32, 32] });
const layer = createSprite2DLayer(atlas, { depth: "test" });
addDepthHostedSpriteLayerToScene(scene, layer);

const animMgr = createSpriteAnimationManager();
attachSpriteAnimationsToScene(scene, animMgr);

const handle = addSprite2D(layer, { positionPx: [100, 200], sizePx: [64, 64], frame: 0 });
playSprite2DAnimation(animMgr, handle, 0, 7, true, 100); // 8-frame loop at 100ms/frame

// Pure-2D with manual update
const sr = createSpriteRenderer(engine, { layers: [layer] });
const binding = attachSpriteAnimationsToRenderer(sr, animMgr);
// Animation now updates before sprite uploads
```

### 实现说明

- `updateSpriteAnimationManager` 遍历 `manager.animations`，累计时间，当 `accumulatedMs > delayMs`（而非 `>=`）时推进帧，并在回调/移除路径运行完毕后移除已完成的非循环动画。
- `sprite-animation-task.ts` 创建精灵侧的 `AnimationTask` 适配器并将其注册到通用 `AnimationManager`。这使得单个管理器能够在同一循环中推进 glTF/属性动画组和精灵帧动画，而无需动画核心导入精灵代码。
- `startSpriteAnimationManager` / `stopSpriteAnimationManager` 保留现有的独立精灵 API，但在内部通过 `sprite-animation-task.ts` 中的私有通用 `AnimationManager` 来调度精灵管理器。特定于精灵的场景/渲染器挂载保留在 `sprite-animation.ts` 中。
- 挂载辅助函数：
    - `attachSpriteAnimationsToScene` 通过 `unshift` 添加一个 `_beforeRender` 钩子，接收场景 delta 并调用 `updateSpriteAnimationManager`。通过 `disposeSpriteAnimationBinding` 销毁；销毁会剪除该钩子并清除管理器的内部绑定状态。挂载到场景的绑定还会向场景销毁注册相同的清理操作，因此 `disposeScene(scene)` 会释放该绑定状态。
    - `attachSpriteAnimationsToRenderer` 将一个回调推入渲染器内部的更新前钩子列表；`SpriteRenderer._update` 在图层上传前向这些钩子传递引擎当前的 delta。通过 `disposeSpriteAnimationBinding` 销毁时仅剪除该回调并清除管理器的内部绑定状态。挂载到渲染器的绑定会向 `disposeSpriteRenderer` 注册相同的清理操作，因此销毁渲染器也会释放该绑定状态。
- 家族辅助函数位于独立模块中。`sprite-2d-index-animation.ts` 不导入句柄代码；`sprite-2d-handle-animation.ts` 导入稳定句柄辅助函数。公告板索引/句柄辅助函数遵循相同的拆分。
- 索引目标跟踪使用原始槽位索引。如果非动画代码对该索引执行了交换移除，动画会遵循原始索引语义，继续以同一个数字槽位为目标。对于可能从外部移除的动画精灵，调用方应使用句柄，或在移除前手动停止动画。
- 句柄目标跟踪使用稳定的 `Sprite2DHandle` 或 `BillboardSpriteHandle`。交换移除是安全的；句柄在动画通过 `removeWhenFinished` 将其移除前一直保持有效。

---

### 对 `packages/babylon-lite/src/index.ts` 的公共 API 新增项

```typescript
// ─── Engine ──────────────────────────────────────────────────────────
export type { RenderingContext, EngineContext } from "./engine/engine.js";
// `startEngine(engine)` walks `engine._renderingContexts` in registration order.
export { startEngine } from "./engine/engine.js";

// ─── Scene ───────────────────────────────────────────────────────────
// The existing scene API is unchanged. Depth-hosted Sprite2D layers use
// `addDepthHostedSpriteLayerToScene`; HUD overlays use `createSpriteRenderer` +
// `registerSpriteRenderer`.
// `onSceneDispose(scene, cb)` is the public hook for tying caller-owned
// resources (typically a HUD `SpriteRenderer`) to the scene's lifetime.
export { addToScene, registerScene, disposeScene, onSceneDispose } from "./scene/scene.js";

// ─── Sprites ─────────────────────────────────────────────────────────
// The engine-registerable sprite renderer — usable with OR without a SceneContext.
export {
    createSpriteRenderer,
    addSpriteRendererLayer,
    removeSpriteRendererLayer,
    registerSpriteRenderer,
    unregisterSpriteRenderer,
    disposeSpriteRenderer,
} from "./sprite/sprite-renderer.js";
export type { SpriteRenderer, SpriteRendererOptions } from "./sprite/sprite-renderer.js";

export { loadSpriteAtlas, createGridSpriteAtlas } from "./sprite/shared/sprite-atlas.js";
export type { SpriteAtlas, SpriteFrame, SpriteSampling, GridAtlasOptions, LoadAtlasOptions } from "./sprite/shared/sprite-atlas.js";
export { createSprite2DLayer, addSprite2DIndex, updateSprite2DIndex, removeSprite2DIndex, clearSprite2DLayer, setSprite2DFrameIndex } from "./sprite/sprite-2d.js";
export type { Sprite2DLayer, Sprite2DLayerOptions, Sprite2DProps, Sprite2DView, Sprite2DDepthMode, SpriteBlendMode } from "./sprite/sprite-2d.js";
export {
    addDepthHostedSpriteLayerToScene,
    removeDepthHostedSpriteLayerFromScene,
    getSceneDepthHostedSpriteLayers,
    onSceneDepthHostedSpriteLayersChanged,
} from "./sprite/sprite-scene.js";

// Billboards.
export {
    createFacingBillboardSystem,
    createAxisLockedBillboardSystem,
    addBillboardSpriteIndex,
    updateBillboardSpriteIndex,
    removeBillboardSpriteIndex,
    clearBillboardSprites,
    setBillboardSpriteFrameIndex,
} from "./sprite/billboard-sprite.js";
export { addBillboardSystemToScene, removeBillboardSystemFromScene, getSceneBillboardSystems, onSceneBillboardSystemsChanged } from "./sprite/billboard-scene.js";
export type {
    FacingBillboardSpriteSystem,
    AxisLockedBillboardSpriteSystem,
    BillboardSpriteSystemOptions,
    BillboardSpriteInit,
    BillboardOrientation,
    BillboardDepthMode,
    BillboardBlendMode,
} from "./sprite/billboard-sprite.js";
```
