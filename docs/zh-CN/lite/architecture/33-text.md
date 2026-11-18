# 模块：文本（Text）

> 包路径：`packages/babylon-lite/src/text/`
>
> 面向 Lite 的 Slug 风格 GPU 字体渲染。字形作为二次贝塞尔轮廓存储在 `rgba32float` 曲线纹理中，并在 `rg32uint` 纹理中附带空间条带（band）索引；绘制时以实例化单位四边形的形式提交，由片段着色器根据与每个像素所在条带相交的曲线解析计算解析覆盖率。模块按分层组织：最底层（`GlyphStorage`）仅持有轮廓与图集，中间层（`TextData`）在其上叠加逐实例槽位分配器，最顶层（`TextRenderable`、`TextRenderer`）则将 `TextData` 接入 3D 场景或独立 2D 通道。

## 目的

文本特性的存在是为了在任何地方绘制与分辨率无关的字形——既可以作为世界空间 `TextRenderable` 放入 3D 场景，也可以在纯 2D 下作为独立的 `TextRenderer`（无场景、无相机）。两条路径共享同一套 CPU 布局（`TextData` 逐实例缓冲区 + 绘制组）和同一套 GPU 管线（针对曲线+条带纹理的 Slug 片段着色器）。它们仅在 MVP 矩阵的构建方式以及由哪个渲染通道拥有绘制上有所不同。

该模块组织为四个生命周期层级，按生命周期从长到短排列：

1. **`GlyphStorage`** —— 轮廓 + GPU 图集。单个存储可以容纳多个曲线集（每个字体族一个）并支撑多个 `TextData`。由调用方拥有。
2. **`TextData`** —— 逐文本块的实例缓冲区 + 槽位分配器 + 绘制组。借用 `GlyphStorage`。每个逻辑文本块对应一个 `TextData`。
3. **`TextRenderable`**（3D）/ **`TextRenderer` + `TextLayer`**（2D）—— 注册到引擎/场景并实际执行绘制的对象。
4. **`DefaultTextData`** + 辅助函数 —— 通过 `text-shaper` 执行默认从左到右（LTR）布局并自带私有 `GlyphStorage` 的便捷层。

每一层仅依赖其下一层，因此自行编写布局的调用方（例如外部富文本引擎）只需导入 `GlyphStorage` + `TextData` + 一个渲染器，无需为默认布局 / `text-shaper` 胶水代码付出任何字节。

## 公共 API 接口

### 第 1 层 —— `GlyphStorage`（生命周期最长）

```typescript
export interface GlyphStorage {
    /* opaque */
}
export type CurveSetId = string;

export function createGlyphStorage(initial?: Map<CurveSetId, Map<number, GlyphCurves>>): GlyphStorage;
export function updateGlyphStorage(storage: GlyphStorage, curveSetId: CurveSetId, curves: ReadonlyMap<number, GlyphCurves>): void;
export function disposeGlyphStorage(storage: GlyphStorage): void;
```

`GlyphStorage` 是一个封装了 `(curveSetId → 字形轮廓 + 打包图集)` 的不透明包。每个 `CurveSetId`（一个字符串，通常为字体族名称）映射到一个图集；一个 `GlyphStorage` 可容纳任意数量的曲线集。曲线集内部的字形 ID 是稠密小整数（字体字形索引），一旦打包进图集，字形的槽位就绝不会移动。

`updateGlyphStorage` 对每个字形 ID 是幂等的——已经存在的 ID 会被跳过，因此调用方可以传入所有可能绘制的字形的并集而无需重新光栅化。生命周期由调用方拥有（与 `Texture2D` 语义一致）：调用方必须确保其生命周期长于任何借用该存储的 `TextData`，随后调用一次 `disposeGlyphStorage` 以释放所有图集的 GPU 纹理。

同一个 `GlyphStorage` 可以通过引用在任意数量的 `TextData` 之间共享——这正是将其拆为独立层级的原因。使用同一种字体的两个文本块只需付出一次图集上传。

### 第 2 层 —— `TextData`

```typescript
export interface TextData {
    readonly runs: readonly GlyphRun[];
    // ... opaque internals
}

export type GlyphRun = {
    readonly curveSet: CurveSetId;
    readonly glyphs: readonly PlacedGlyph[];
    readonly pixelsPerFontUnit: number;
    readonly defaultColor?: readonly [number, number, number, number];
};
export type PlacedGlyph = {
    readonly glyphId: number;
    readonly x: number; // pixels, glyph origin
    readonly y: number; // pixels, baseline up
    readonly color?: readonly [number, number, number, number]; // overrides run defaultColor
};

export function createTextData(storage: GlyphStorage, runs?: readonly GlyphRun[]): TextData;
export function updateTextData(data: TextData, update: TextDataUpdate): void;
export function disposeTextData(data: TextData): void;

export type TextDataUpdate =
    | { update: "reset"; runs?: GlyphRun[]; storage?: GlyphStorage }
    | { update: "addRun"; run: GlyphRun; insertBefore?: number }
    | { update: "removeRun"; run: GlyphRun | number }
    | { update: "replaceRun"; previous: GlyphRun | number; run: GlyphRun };
```

一个 `TextData` 将一个逻辑文本块表示为有序的 `GlyphRun` 列表。每个 run 携带单一字体（一个 `curveSet`）在单一 `pixelsPerFontUnit` 缩放比例下的字形；混合字体 / 混合字号的内容只需在同一个 `TextData` 中放置多个 run。`update` API 是一个用于驱动槽位分配器的小型可辨识联合类型（见 §实现）。

`disposeTextData` 仅释放逐文本块的 GPU 资源（实例缓冲区 + 绑定组）。它**不会**触碰借用的 `GlyphStorage` —— 该生命周期仍由调用方拥有。

### 第 3a 层 —— `TextRenderable`（3D，挂载到场景）

```typescript
export interface TextRenderableOptions {
    readonly position?: Vec3;
    readonly rotationQuaternion?: { x: number; y: number; z: number; w: number };
    readonly scaling?: Vec3;
    readonly opacity?: number; // whole-block fade. default 1
    readonly ignoreDepth?: boolean; // skip depth test/write. default false
    readonly order?: number; // sort order. default 200
}

export interface TextRenderable extends Renderable {
    readonly position: ObservableVec3;
    readonly rotation: EulerProxy;
    readonly rotationQuaternion: ObservableQuat;
    readonly scaling: ObservableVec3;
    opacity: number;
    ignoreDepth: boolean;
    order: number;
}

export function createTextRenderable(data: TextData, options?: TextRenderableOptions): TextRenderable;
export function addTextRenderableToScene(scene: SceneContext, renderable: TextRenderable): void; // idempotent
export function removeTextRenderableFromScene(scene: SceneContext, renderable: TextRenderable): boolean; // false when not a member
export function getSceneTextRenderables(scene: SceneContext): readonly TextRenderable[]; // add-order snapshot
export function onSceneTextRenderablesChanged(scene: SceneContext, listener: SceneRenderableChangeListener<TextRenderable>): () => void;
export function disposeTextRenderable(renderable: TextRenderable): void;
```

场景成员关系是一个自定义 renderable 集合（见 [01-scene.md § 自定义 renderable 集合](01-scene.md#自定义可渲染对象集合)），独立于 `addToScene` / `onSceneChange`。移除文本 renderable 会立即停止其绘制，并在进行中的帧结束后释放其 GPU 缓冲区；其 `TextData` 仍由调用方拥有，重新添加的 renderable 会在下一次构建时重新创建其 GPU 记录（及其绘制组的绑定组）。一个文本 renderable 同一时间应只属于一个场景，因为它的绘制绑定共享同一份 GPU 记录。

`TextRenderable` 镜像了 `Mesh` 的 TRS 接口（`position`、`rotation`、`rotationQuaternion`、`scaling`）并实现标准的 `Renderable` 接口，因此它可以像其他任何场景实体一样排序和绑定。它默认 `isTransparent` 为真（文本始终使用 src-over 混合）并以只读方式消费其 `TextData`——数据和其底层的 `GlyphStorage` 可以在许多 `TextRenderable` 之间共享。

挂载到场景的文本可以在添加/注册前通过 `setAlphaToCoverage(renderable, true)` 显式启用 Alpha-to-Coverage。该选项仅在 `ignoreDepth === false` 且场景目标为多重采样时有效。该变体使用非预乘（straight）RGB、将解析字形覆盖率作为 Alpha、替换颜色（无混合）以及逐采样深度写入。独立的 `TextRenderer` 图层绘制到 1x 交换链并保留普通的非预乘 Alpha 混合。

### 第 3b 层 —— `TextRenderer` + `TextLayer`（独立 2D）

```typescript
export interface TextLayerOptions {
    readonly positionPx?: { x: number; y: number }; // canvas pixel origin
    readonly rotationRad?: number; // z-axis rotation
    readonly scale?: number; // uniform
    readonly order?: number; // within renderer
    readonly opacity?: number;
    readonly visible?: boolean;
}
export interface TextLayer {
    readonly data: TextData;
    positionPx: { x: number; y: number };
    rotationRad: number;
    scale: number;
    order: number;
    opacity: number;
    visible: boolean;
}
export function createTextLayer(data: TextData, options?: TextLayerOptions): TextLayer;
export function setTextLayerPosition(layer: TextLayer, x: number, y: number): void;

export interface TextRendererOptions {
    layers: readonly TextLayer[];
    clear?: boolean; // default true
    clearValue?: GPUColorDict;
}
export function createTextRenderer(engine: EngineContext, opts: TextRendererOptions): TextRenderer;
export function addTextRendererLayer(tr: TextRenderer, layer: TextLayer): void;
export function removeTextRendererLayer(tr: TextRenderer, layer: TextLayer): boolean;
export function registerTextRenderer(tr: TextRenderer): void;
export function unregisterTextRenderer(tr: TextRenderer): void;
export function disposeTextRenderer(tr: TextRenderer): void;
```

`TextRenderer` 是一个独立的 `RenderingContext`（`SpriteRenderer` 的兄弟）：无场景，无相机。它开启自己的交换链渲染通道，并按 `order` 顺序绘制每个可见的 `TextLayer`。MVP 是纯 CPU 构建的 2D 仿射变换（图层位置/旋转/缩放 + 正交投影）——没有视图矩阵。图层可以随时添加/移除；它们的像素位置/旋转/缩放/不透明度可以在帧间直接修改。

需要在 3D 之上显示 2D HUD 文本的场景先调用 `registerScene`，然后调用 `createTextRenderer` + `registerTextRenderer`，从而使文本通道在场景的帧图之后运行。

### 第 4 层 —— 默认辅助函数（依赖 `text-shaper`）

```typescript
export interface Font {
    /* opaque, wraps text-shaper.Font */
}
export function loadFont(url: string): Promise<Font>;
export function createFontFromBuffer(data: ArrayBuffer): Font;

export function extractGlyphCurves(font: Font, glyphIds: ReadonlySet<number>, target: Map<number, GlyphCurves>): void;
export function cubicToQuadratics(/* control points */): [QuadCurve, QuadCurve];

export interface DefaultTextData extends TextData {
    readonly width: number; // pixel-space laid-out width
    readonly height: number; // pixel-space laid-out height
}
export function createDefaultTextData(font: Font, fontSizePx: number, text: string, textColor?: [number, number, number, number], options?: TextLayoutOptions): DefaultTextData;
export function updateDefaultTextData(data: DefaultTextData, text: string, textColor?: [number, number, number, number]): void;
export function disposeDefaultTextData(data: DefaultTextData): void;
```

`createDefaultTextData` 运行默认的 LTR + 自动换行 + 对齐布局（`layout.ts`，基于 `text-shaper` 的 HarfBuzz 风格塑形构建），从字体中提取所需的字形轮廓（`glyph-extraction.ts`，使用 `text-shaper` 的字形路径提供器），将它们打包进一个全新的单曲线集 `GlyphStorage`，并将结果包装为带有一个 `GlyphRun` 的 `TextData`。品牌化的 `DefaultTextData` 携带像素空间的 `width` / `height`，以便调用方精确调整 `TextRenderable.scaling` 或放置 `TextLayer`。

`updateDefaultTextData` 重新对文本进行塑形，将新需要的字形轮廓追加到现有的 `GlyphStorage` 中（已存在的 id 通过 `updateGlyphStorage` 空操作跳过），并通过 `updateTextData(replaceRun)` 应用新 run——每当字形数量未变时就会命中原地重写快速路径。

`disposeDefaultTextData` 同时释放逐文本块资源和拥有的 `GlyphStorage`（因为此辅助函数分配了这两者）。

自行驱动文本布局的调用方仅导入第 1–3 层，无需为 `layout.ts`、`glyph-extraction.ts`、`default-text-data.ts` 或 `text-shaper` 的塑形代码路径支付任何字节。

### 最小示例 —— `createDefaultTextData` + `TextRenderer`

从字体 URL 到画布渲染文本的最短路径：

```typescript
import { createEngine, startEngine, loadFont, createDefaultTextData, createTextLayer, createTextRenderer, registerTextRenderer } from "@babylonjs/lite";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const font = await loadFont("/fonts/Inter.ttf");

// Shape + extract curves + pack atlas in one call (a fresh GlyphStorage is
// allocated under the hood and released by `disposeDefaultTextData`).
const data = createDefaultTextData(font, 48, "Hello, world!");

// Place the laid-out block at pixel (32, 64) on the canvas.
const layer = createTextLayer(data, { positionPx: { x: 32, y: 64 } });

// Standalone 2D renderer — no scene, no camera.
const renderer = createTextRenderer(engine, { layers: [layer] });
registerTextRenderer(renderer);

await startEngine(engine);
```

对于 3D 场景，将最后三行替换为 `createTextRenderable(data)` + `addTextRenderableToScene(scene, …)`；其余一切完全相同。

## 实现

### CPU 数据布局

每个 `GlyphStorage` 曲线集拥有一个 `SharedAtlas`：

```typescript
type SharedAtlas = {
    curveTexData: Float32Array; // rgba32float, width 4096, grows by row doubling
    curveTexelsUsed: number;
    bandTexData: Uint32Array; // rg32uint (two components per texel), width 4096, grows by row doubling
    bandTexelsUsed: number;
    glyphSlots: Map<number, AtlasSlot>; // glyphId → curve start + band header location + band counts
    version: number; // monotonic, bumped per packAppendGlyph
    gpu: SharedAtlasGpu | null; // lazy
};
```

两张纹理均为固定宽度 `4096`，按行倍增步长增长。曲线纹素存储二次控制点（每条曲线的 `p0`、`p1`、`p2` 打包为两个 `vec4`）；条带纹素存储逐条带头部（计数 + 偏移），紧随其后的是整数形式的曲线索引列表（着色器中无浮点舍入）。逐字形元数据位于 `AtlasSlot`（曲线起始纹素、条带头位置、用于片段着色器变换的 `(vBandCount, hBandCount)`）。

每个 `TextData` 拥有一个连续打包的实例缓冲区（`Float32Array`，20 个浮点数 = 5 个 `vec4` = 每个实例 80 字节）、一个 `instanceCount`，以及一个绘制组列表：

```typescript
type TextDataDrawGroup = {
    groupKey: TextGroupKey; // draw-group identity; === curveSetId unless a styling feature interned another
    curveSetId: CurveSetId;
    curveSet: GlyphStorageCurveSet; // cached pointer into _storage._curveSets
    slotStart: number;
    slotCount: number; // live + dead
    liveCount: number;
    freeSlots: number[]; // LIFO stack of dead slot indices
    bindGroup: GPUBindGroup | null;
    bindGroupVersion: number; // last-seen atlas.uploadedVersion
};
```

活动 run 所使用的每个唯一 `groupKey` 对应一个绘制组——即每个唯一 `curveSetId` 一个，除非显式启用的样式特性进一步拆分了某个曲线集（见“绘制组键”）。每个组在共享实例缓冲区中拥有一段连续的 `[slotStart, slotStart + slotCount)` 槽位范围；**活动槽位与死亡槽位在该范围内交错**。顶点着色器检测死亡槽位并发射一个离屏退化四边形，因此它们仅消耗一次顶点着色器调用。逐 run 的 `RunRecord` 跟踪每个 `GlyphRun` 当前占用的绝对槽位索引，因此添加/移除/替换的时间复杂度为 O(受影响字形数)。

### 逐实例布局（5 × `vec4`，80 字节）

| 字段         | 浮点数 | 内容                                                                                        |
| ------------ | ------ | ------------------------------------------------------------------------------------------- |
| `slugBounds` | 4      | 字体单位中的 `(xMin, yMin, xMax, yMax)` —— 四边形范围                                       |
| `slugAnchor` | 4      | `(xPx, yPx, 1/pixelsPerFontUnit, deadSentinel)` —— 像素原点 + 缩放；`.w = 1` 标记槽位已死亡 |
| `slugAtlas`  | 4      | `(glyphLocX, glyphLocY, bandMaxX, bandMaxY)` —— 条带纹理查找基址 + 最大条带索引             |
| `slugBand`   | 4      | `(bandScaleX, bandScaleY, bandOffsetX, bandOffsetY)` —— 由字形边界 + 条带数推导             |
| `slugColor`  | 4      | 逐字形线性 RGBA（回退到 run 的 `defaultColor`，再回退到白色）                               |

顶点着色器首先读取 `slugAnchor.w`；当非零时，它在 `(-2, -2, -2, 1)` 处发射一个裁剪空间点，使全部六个四边形顶点坍缩为一个屏幕外点，光栅化器随之剔除零面积三角形。

### 槽位分配器（快速增量更新）

分配器是该模块的核心——其目的是让 `updateTextData` 足够廉价，使正在打字的用户无需重建 GPU 缓冲区即可在每次按键时驱动它。

- **`addRun`** 为每个字形分配一个槽位，首先从所属组的 `freeSlots` LIFO 栈中弹出（先前由 `removeRun` 腾出的死亡槽位），然后再扩展该组的范围。扩展需要将之后的每一个组向右 `copyWithin` 移动 `extraSlots`；同组的 run 从不移动，因为组内槽位是无序的。
- **`removeRun`** 将死亡槽位哨兵值写入该 run 占用的每个槽位，并将这些槽位索引压入组的 `freeSlots`。如果该组变空（没有活动 run），它会被丢弃，随后的组向左移动以填补空隙。被移除的槽位将缓冲区范围 `[minSlot, maxSlot+1)` 标记为脏。
- **`replaceRun`** 具有一条快速路径：相同的 curveSet + 相同的字形数量 → 原地重写现有槽位（无分配器工作，无缓冲区移动）。当用户在未触发自动换行的行中输入单个字符时，`updateDefaultTextData` 就会命中此路径。不同大小或不同 curveSet 则回退到在同一 `runs` 索引处执行 `removeRun` + `addRun`。
- **`reset`（完整重置或压缩）** 从头重建组和槽位范围，在 curveSet 匹配时复用现有的组记录（当图集指针未变时保留 `bindGroup` 身份），并将每个活动槽位无空隙地连续打包。因此，在省略 `runs` 和 `storage` 时调用 `updateTextData(data, { update: "reset" })` 是一次纯粹的压缩遍历。

**自动压缩与手动压缩。** 分配器在两种情况下会自动压缩：(a) 组内的死亡槽位总会通过 `freeSlots` LIFO 被下一次 `addRun` / `replaceRun` 回收，因此释放的槽位不会丢失，只是原地休眠；(b) `liveCount` 降为零的组会被 `dropEmptyGroup` 整体丢弃，并将后续组左移以填补空隙。**不会**自动执行的是组仍处于活动状态时的组内空洞闭合：如果一个 200 字形的 run 缩小到 5 个字形，其余 195 个槽位会保持死亡状态，直到未来的 run 复用它们或调用方调用 `reset`。顶点着色器将死亡槽位坍缩为单个屏幕外点（一次廉价的顶点调用，无片段工作），因此稳态开销是有界的——仅当工作负载长时间维持高比例死亡槽位且调用方希望缩小 GPU 实例缓冲区时，才需要显式 `reset`。添加内部启发式策略（例如当 `dead / total > 0.5` 时自动重置）是未来的可选项，但目前尚未实现。

### 脏范围 + 基于版本的 GPU 上传

`TextData` 携带 `_version`（每次变更递增）和一个 `[_dirtyStart, _dirtyEnd)` 半开脏范围。写入实例缓冲区的每条分配器路径都会调用 `markDirty(data, minSlot, maxSlot + 1)`。GPU 侧（`TextRenderable` / `TextRenderer`）缓存 `uploadedDataVersion`，并在帧上传时执行：

1. 如果 `data._version === uploadedDataVersion` → 完全跳过。
2. 否则如果局部上传安全（`uploadedDataVersion !== -1` 且脏范围非空）→ 仅对脏子范围执行 `writeBuffer`。
3. 否则（重置后或扩容后）→ 上传整个前缀 `[0, _instanceCount)`。

实例 GPU 缓冲区在需要时将容量翻倍；扩容后的下一次上传会落入第 3 分支。

`SharedAtlas.version` 对曲线+条带纹理扮演相同的角色。`ensureSharedAtlasGpu(device, atlas)` 惰性分配纹理，在容量需求变化时扩容（2 的幂次行），并仅在 `uploadedVersion !== atlas.version` 时重新上传。它返回 `{ rebuilt, gpu }`；`rebuilt = true`（纹理对象身份已改变）是通知渲染器丢弃每个绘制组 `bindGroup` 的信号，使其基于新纹理视图重新创建。稳态下的同版本轮询只是一次整数比较。

### 空间条带索引（`glyph-storage.ts` 内部）

对于每个字形，`buildGlyphBands(glyph)` 按包围盒重叠将曲线划分为至多 8 个水平条带和 8 个垂直条带。水平条带内的曲线按 `max(p0x, p1x, p2x)` 降序排列（垂直条带按 `max(p0y, p1y, p2y)` 降序排列），以便一旦曲线完全位于像素左侧/下方时片段着色器可以提前退出条带。结果通过 `@internal _bands?` 字段记忆在 `GlyphCurves` 对象上，从而使被第二个 `GlyphStorage` 复用的字形（例如从同一 `Font` 重新提取的另一个文本块）只需付出一次条带构建成本。

### 管线（`_gpu/text-pipeline.ts`）

每个 `GPUDevice` 缓存一个绑定组布局 + 一对基础 WGSL 模块（一个 `WeakMap<GPUDevice, TextPipelineDeviceCache>`）。渲染管线本身按固定元数的 `(colorFormat, sampleCount, depthStencilFormat, depthWrite, alphaToCoverage, variantId)` 键缓存——因此 `ignoreDepth=true` 的 `TextRenderable` 与 `ignoreDepth=false` 的 `TextRenderable` 共享模块和绑定组布局，但获得各自独立的管线。可选着色器变体由显式启用的特性作为已预编译的不透明模块对提供；见下文“变体模块生命周期”。

混合固定为 src-over：

```
color: (src.a * src.rgb) + (1 - src.a) * dst.rgb
alpha: src.a + (1 - src.a) * dst.a
```

拓扑为 `triangle-list`（来自共享 6 顶点单位四边形缓冲区的每个字形两个三角形）。绑定组有三个条目：binding 0 上的 `TextU` UBO（mvp + viewport + color），以及 binding 1 和 2 上的曲线/条带纹理（曲线为 `unfilterable-float` 的 `texture_2d<f32>`，条带为 `uint` 的 `texture_2d<u32>`）。

### WGSL 轮廓

两个着色器阶段都是 Eric Lengyel 的 Slug 算法（[github.com/EricLengyel/Slug](https://github.com/EricLengyel/Slug)）的直接 WGSL 移植——曲线+条带图集布局、逐像素条带查找、二次求根编码表以及屏幕空间膨胀数学均源自该参考实现。Babylon Lite 着色器是为了适配 Lite 的实例缓冲区 + 绑定组管线而重塑的同一套算法。

顶点阶段（`shaders/slug-shader.ts` 的顶点部分）：

1. **死亡槽位检测。** `if (in.pk == 0xffffffffu) → emit (-2,-2,-2,1) point`。死亡槽位使用全 1 的打包字形/样式索引。
2. **四边形角点展开。** `tex = mix(slugBounds.xy, slugBounds.zw, isMax)` 将单位角点符号映射到字形的字体单位边界；`pos = slugAnchor.xy + tex * scale` 将角点放置到对象空间像素中。
3. **Slug 膨胀**（Eric Lengyel 的解析抗锯齿扩展）—— 提取 MVP 行，计算与 `(1 / viewport, 1 / viewport)` 成比例的屏幕空间膨胀向量 `d`，使字形边缘始终覆盖一个片段。同时按逆字形雅可比矩阵膨胀纹理坐标。
4. 输出膨胀后的裁剪位置 + 膨胀后的 `vTexcoord` + flat `vBanding` / `vGlyph` / `vColor`。

片段阶段（`shaders/slug-shader.ts` 的片段部分）：

1. 从 `vTexcoord` 推导出 `(hBandIndex, vBandIndex)`，通过将 `bandScale * tex + bandOffset` 钳位到 `[0, bandMax]`。
2. 从 `bandTex` 的 `glyphLoc + bandIndex` 处读取条带头（计数 + 曲线列表偏移）。
3. 遍历曲线索引列表；对每条曲线，从 `curveTex` 获取其两个 `vec4` 并求解水平（对垂直条带则是垂直）多项式，使用标准的 Loop-Blinn 3 位根编码表（`0x2E74`）统计带符号交叉数。当排序后曲线的 x/y 越过像素时提前退出。
4. 累加来自水平条带和垂直条带的带符号覆盖率并求平均；钳位到 `[0, 1]`；乘以 `vColor`。混合输出会预乘有效 Alpha（`color.a * coverage`）；Alpha-to-Coverage 变体则保留非预乘 RGB 并仅在 Alpha 中携带覆盖率。

着色器独立于布局 / 曲线提取路径——它仅消费打包后的图集 + 实例缓冲区。

### `TextRenderable`（3D）逐帧流程

`TextRenderable` 是一个 `isTransparent = true` 的 `Renderable`。它的 `bind` 由场景的帧图调用；`update` 执行：

0. **延迟安装的变体刷新。** `bind` 会同时解析两条管线，但场景绑定只构建一次——而不是每帧构建——因此在绑定存在*之后*才启用的样式特性，原本会导致其加权组一直使用基础管线绘制，直到某个无关的场景变更重建了该绑定。因此绑定的 `update` 会在 `gpu._variantPipeline === gpu._pipeline && _textVariantResolver` 成立时精确重新解析一次变体管线——这是一个基础消费方在第一项就会失败、且在单次刷新后便不再匹配的身份比较，因此绝不会每帧构建缓存键。重新解析复用捕获在绑定闭包中的*绑定时*目标参数（`colorFormat`、`sampleCount`、`depthStencilFormat`、`depthWrite` 以及作为 Alpha-to-Coverage 所有者的 renderable 本身），从而使刷新后的变体与该绑定已经声明的基础管线成为精确的兄弟管线。
1. 对每个绘制组：`ensureSharedAtlasGpu`（上传/扩容曲线+条带纹理）；当图集被重建或 `bindGroupVersion` 过时时重建 `bindGroup`。
2. 按上述版本 + 脏范围协议调整大小 / 重新上传实例缓冲区。
3. 从活动相机的视图-投影矩阵 × renderable 的世界矩阵将 MVP 组合进 16 浮点暂存区；`writeBuffer` 到 `TextU` UBO 偏移 0 处。当世界矩阵干净**且**相机身份、`_cameraChangeKey` 以及有效宽高比全部未变时，跳过重新计算和上传。
4. 当目标尺寸变化时，在 UBO 偏移 64（16 字节）处写入视口尺寸。当不透明度变化时，在 UBO 偏移 80 处写入 `(1, 1, 1, opacity)`。

随后 `draw` 遍历绘制组：绑定该组的管线（当 `g.groupKey !== g.curveSetId` 时为预解析的变体管线，否则为基础管线，针对当前已绑定管线去重）；`setBindGroup(0, g.bindGroup)`；`pass.draw(6, g.slotCount, 0, g.slotStart)`。每个非空组对应一次绘制调用，且 `slotCount` 包含死亡槽位（在顶点着色器中坍缩）。如果绑定过任何变体管线组，则在返回前重新绑定基础管线，以使绘制列表的 `setPipeline` 去重对下一个 renderable 保持有效。至关重要的是，`TextRenderable` **不**在 group 0 绑定场景的共享场景 UBO——它自行组合 MVP，从而使同一管线可以在完全没有场景的 `TextRenderer` 中运行。

### `TextRenderer`（2D）逐帧流程

`TextRenderer` 是通过 `registerTextRenderer` 注册的 `RenderingContext`。`startEngine` 每帧调用一次它的 `_update`（逐图层 GPU 同步）和 `_record`（开启交换链渲染通道并发出逐图层绘制）。

2D 图层的 MVP 直接构建：

```
[ cos·(2s/W)   sin·(2s/W)   0   (2·px/W - 1)  ]
[ -sin·(2s/H)  cos·(2s/H)   0   (1 - 2·py/H)  ]
[ 0            0            1   0             ]
[ 0            0            0   1             ]
```

一个 6 浮点 `lastMvpInputs` 缓存（px, py, rot, scale, W, H）门控 MVP 的 `writeBuffer`，使静止图层在首帧之后每帧开销为零。

渲染器的管线以 `(swapchain format, sampleCount=1, no depth, depthWrite=false, flipY=false)` 缓存；无深度意味着 3D 上的深度托管文本必须改用 `TextRenderable`。当图层数量 >1 时，每帧按 `order` 排序一次；逐图层 GPU 记录（`LayerGpu`）持有一个逐绘制组的绑定组加上一个 `instanceBuf` 和一个 `textU` UBO。

### 默认布局（`layout.ts`）

`layoutText(font, text, fontSizePx, options)` 对每个段落运行 LTR 塑形（`text-shaper.shape` 返回已定位的字形簇），按 `maxWidth` 进行贪心换行，应用可选对齐，然后烘焙出带有像素空间位置的扁平 `PlacedGlyph[]`：

- Y 朝上：第 0 行位于 `y=0`，后续行位于 `y = -lineIdx * lineHeightPx`。这天然与字体的 em 空间 Y 朝上边界配对，使带有 Y 朝上相机的 3D 场景无需额外变换即可正向渲染文本。
- 同时返回 `pixelsPerFontUnit = font.scaleForSize(fontSizePx)`；`GlyphRun` 消费它，且逐实例的 `slugAnchor.z = 1 / scale` 驱动顶点着色器的 em→像素变换。

### 默认曲线提取（`glyph-extraction.ts`）

`extractGlyphCurves(font, glyphIds, target)` 为每个请求的 id 遍历 `text-shaper.getGlyphPath`，将每条命令（`M`、`L`、`Q`、`C`、`Z`）转换为二次贝塞尔线段，并将结果存入 `target`。`L` 被拆分为退化二次曲线（控制点在中点）；`C` 通过“3/4 规则”拆分为两条二次曲线（公开暴露为 `cubicToQuadratics`，供摄取来自 DirectWrite / FreeType 等自有三次轮廓的调用方使用）。

`Font._curvesCache` 跨调用记忆逐字形提取结果，因此使用同一字体再次调用 `createDefaultTextData` 会复用已光栅化的轮廓。

## 依赖关系

- `text-shaper`（npm）—— 由 `font.ts`（字体加载）、`layout.ts`（塑形）和 `glyph-extraction.ts`（字形路径提取）使用。仅默认布局/默认曲线模块导入它；使用手写布局的调用方为此支付零字节。
- `engine/engine.ts` —— `EngineContext`、`RenderingContext`（TextRenderer 注册）、`getRenderTargetSize`。
- `engine/render-target.ts` —— `RenderTargetSignature`（TextRenderable 管线键）。
- `render/renderable.ts` —— `Renderable`、`DrawBinding`、`DrawUpdateContext`（TextRenderable 契约）。
- `scene/scene-renderable-collection.ts` —— 自定义 renderable 集合辅助函数（`addTextRenderableToScene` / `removeTextRenderableFromScene` / `getSceneTextRenderables` / `onSceneTextRenderablesChanged`）。
- `camera/camera.ts` —— `getViewProjectionMatrix`、`getEffectiveAspectRatio`（TextRenderable 逐帧 MVP 组合）。
- `math/observable-vec3.ts`、`math/observable-quat.ts`、`math/compose-mat4.ts`、`math/multiply-mat4-into-buffer.ts`、`scene/world-matrix-state.ts`、`scene/scene-node.ts` —— 从 Mesh 复用的 TRS + 世界矩阵底层支持。
- `resource/gpu-buffers.ts` —— 用于 `TextU` UBO 的 `createEmptyUniformBuffer`。

## 参考场景

- **Scene 180 — `scene180-text-renderer`**：由 `<textarea>` + 滑块驱动的独立 2D `TextRenderer` + `TextLayer`。演示纯 2D 路径（无场景、无相机）、实时 `updateDefaultTextData`、路由至 `replaceRun` 操作的颜色滑块、拖拽移动、滚轮缩放。
- **Scene 181 — `scene181-text-editor`**：挂载到弧线旋转场景的 3D `TextRenderable`，由每次按键调用 `updateDefaultTextData` 的 `<textarea>` 驱动。演示原地图集增长和实例缓冲区复用——输入新字符会用该字形的轮廓扩展图集，并在字形数量未变时通过 `replaceRun` 的原地快速路径重写 run。

两个场景均标记为 `skipParity` 和 `skipPerf`（交互式演示，无基准图像对比）。

## 测试规范

单元测试位于 `tests/lite/unit/`：

- `text-glyph-storage.test.ts` —— 覆盖 `GlyphStorage` 所有权语义：`disposeTextData` 不触碰借用的存储；一个 `GlyphStorage` 支撑多个 `TextData`；`disposeGlyphStorage` 是幂等的并拆除每个曲线集的图集；`updateGlyphStorage` 扩展现有曲线集并按需创建新曲线集；不带参数的 `reset` 执行压缩（重新布局槽位并释放死亡槽位空隙）。
- `text-color.test.ts` —— 覆盖逐字形 `PlacedGlyph.color` 覆盖 run 的 `defaultColor`，以及 `defaultColor` 传播到省略自身颜色的字形。

## 文件清单

| 文件                                         | 职责                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/text/font.ts`                           | `Font`（品牌类型）+ `loadFont` + `createFontFromBuffer`；`text-shaper` 边界。                                                                                                                                                 |
| `src/text/glyph-extraction.ts`               | `extractGlyphCurves` + `cubicToQuadratics`；基于 `text-shaper` 的默认字形路径提取。轮廓值类型位于 `glyph-storage.ts`。                                                                                                         |
| `src/text/glyph-storage.ts`                  | `GlyphStorage`（品牌类型）+ `CurveSetId` + 轮廓值类型（`QuadCurve`、`GlyphBounds`、`GlyphCurves`）+ 支撑的 `SharedAtlas` / `AtlasSlot` / `GlyphBands` 类型及其打包器（`packAppendGlyph`、`buildGlyphBands`）。公共 API：`createGlyphStorage` / `updateGlyphStorage` / `disposeGlyphStorage`。 |
| `src/text/layout.ts`                         | `TextLayoutOptions` + `layoutText` —— 通过 `text-shaper.shape` 实现默认 LTR + 自动换行 + 对齐布局。                                                                                                                            |
| `src/text/text-data.ts`                      | `TextData`（品牌类型）+ `GlyphRun` + `PlacedGlyph` + `TextDataUpdate` + 槽位分配器类型。公共 API：`createTextData` / `updateTextData` / `disposeTextData` 以及逐实例分配器（addRun / removeRun / replaceRun / reset+压缩）。 |
| `src/text/default-text-data.ts`              | `DefaultTextData`（品牌类型）+ `createDefaultTextData` / `updateDefaultTextData` / `disposeDefaultTextData`；组合布局 + 曲线提取 + 私有 `GlyphStorage` 的便捷层。                                                               |
| `src/text/text-renderable.ts`                | `TextRenderable` + `createTextRenderable` / `addTextRenderableToScene` / `disposeTextRenderable`；3D `Renderable` 实现。                                                                                                       |
| `src/text/text-renderer.ts`                  | `TextLayer`（2D 像素空间放置记录）+ `TextRenderer`（独立 `RenderingContext`）+ 它们的工厂和交换链绘制通道。                                                                                                                  |
| `src/text/_gpu/text-textures.ts`             | `ensureSharedAtlasGpu`；惰性 `rgba32float` 纹理创建 + 版本门控上传 + 容量扩容。（图集拆除内联在 `disposeGlyphStorage` 中以避免循环导入。）                                                                                     |
| `src/text/_gpu/text-pipeline.ts`             | `getOrCreateTextPipeline` / `getTextPipelineCache` / `clearTextPipelineCache` + `TextPipelineVariant` 接缝；逐设备绑定组布局 + 基础 WGSL 模块 + 逐目标键管线缓存。不了解着色器片段也不组合 WGSL。                                |
| `src/text/shaders/slug-shader.ts`            | **Slug WGSL 的唯一权威副本。** 内联 TypeScript 模板 + `composeSlugShader(fragment)` —— 确定性构建器，在命名槽位处将可选的 `TextShaderFragment` 插值进基础顶点/片段源码。传入 `null` 即得基础变体。                                |
| `src/text/shaders/text-shader-fragment.ts`   | 纯类型模块：`TextShaderFragment`、`TextVertexSlot`、`TextFragmentSlot`。与特性无关——不含字重（或任何其他特性）语义。构建时擦除。                                                                                               |
| `src/text/set-font-weight-offset.ts`         | 显式启用特性入口：`setFontWeightOffset(data, run, offset)`。拥有逐 run 偏移映射、驻留（interned）绘制组键以及逐 `GPUDevice` 组合+编译的变体模块对；针对其 `TextData` 验证并解析 run，在首次有效调用时安装 `text-data` 样式接缝和 `text-pipeline` 变体解析器，然后通过 `updateTextData({ update: "reset" })` 重新打包数据。 |
| `src/text/load-font-weight-offset.ts`        | 根包导出的用于精确 `set-font-weight-offset.ts` 实现模块的惰性加载器。应用代码可将该特性保留在动态边界之后，而无需将包桶文件作为命名空间导入。                                                                                  |
| `src/text/shaders/weight-shader-fragment.ts` | 仅字重的 `TextShaderFragment`：点到二次曲线距离辅助函数、有界最近轮廓条带扫描、字重 varying、四边形膨胀以及无符号距离覆盖率扩展。**不包含**任何基础 Slug 逻辑副本。仅可从 `set-font-weight-offset.ts` 到达。                        |

---

## Slug 着色器组合

### 一个模板，多个变体

基础 Slug 顶点和片段逻辑存在且仅存在**一份**副本，它作为内联 TypeScript 模板位于 `src/text/shaders/slug-shader.ts`。没有 `slug.vert.wgsl` / `slug.frag.wgsl` `?raw` 文件，也没有第二份“带字重”的着色器副本：可选特性通过类型化片段提供*增量* WGSL，模板在命名槽位处将其插值进去。

```typescript
export function composeSlugShader(fragment: TextShaderFragment | null): ComposedSlugShader;

export interface ComposedSlugShader {
    /** @internal Composed vertex WGSL. */ readonly _vert: string;
    /** @internal Composed fragment WGSL. */ readonly _frag: string;
    /** @internal Fragment id ("" for the base variant) — folded into the pipeline cache key. */
    readonly _key: string;
}
```

这镜像了材质栈的 `ShaderTemplate` + `ShaderFragment` + `composeShader` 模型（`src/shader/fragment-types.ts`、`src/shader/shader-composer.ts`），但它是一个紧凑的文本专用构建器，而不是通用材质组合器的第二个实例：文本拥有一个固定的自定义 `@group(0)` 布局（uniform + 曲线纹理 + 条带纹理 + 字形元数据存储 + 样式存储），没有网格/材质 UBO、没有阴影组、没有顶点属性协商也没有 UBO 布局计算，因此通用组合器的任何机制都不适用。

插值是**直接进行的**（向模板字面量 `${...}` 注入），而非标记替换，也不是对发射出的 WGSL 进行正则扫描。生产环境打包会压缩内联 WGSL 模板字面量（`scripts/wgsl-minify-plugin.ts` → `renderChunk`），这会剥离 `//` 注释并折叠空白；任何依赖注释标记或解析发射字符串的方案在那里都会崩溃（见 GUIDANCE“切勿解析已发射的 WGSL 字符串”）。一个仅拼接已知字符串的构建器对此免疫。

### 注入槽位

`TextShaderFragment` 是一个纯类型描述（`src/text/shaders/text-shader-fragment.ts`）：

```typescript
export type TextVertexSlot = "VO" | "VD" | "VB" | "VA";
export type TextFragmentSlot = "FI" | "FH" | "CO";

export interface TextShaderFragment {
    /** @internal Stable id — part of the pipeline cache key and the shader module label. */
    readonly _id: string;
    /** @internal */ readonly _vertexSlots?: Partial<Record<TextVertexSlot, string>>;
    /** @internal */ readonly _fragmentSlots?: Partial<Record<TextFragmentSlot, string>>;
}
```

| 槽位 | 阶段     | 位置                                                           | 契约                                                                                                                                                                                                                            |
| ---- | -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VO` | vertex   | `VOut` 结构体主体末尾                                          | 以逗号结尾的成员声明。位置 `0..3` 已被基础 varying 占用，因此片段从 `@location(4)` 开始。                                                                                                                                       |
| `VD` | vertex   | 死亡槽位提前返回块                                             | 在局部 `d: VOut` 上为片段添加的每个成员赋一个明确值的语句。                                                                                                                                                                     |
| `VB` | vertex   | 在 `md`（字形元数据）和 `sy`（样式）进入作用域后、四边形设置前 | **必须**声明 `let sb: vec4<f32>` 的语句——即塑形后的 em 空间字形边界。当该槽位存在时模板使用 `sb` 替代 `md.b`；缺席时模板直接命名 `md.b`，因此基础变体没有任何开销。此处声明的值对 `VA` 保持在作用域内。                   |
| `VA` | vertex   | 紧接在 `return out;` 之前                                      | 在 `out` 上为片段添加的 varying 赋值的语句。                                                                                                                                                                                    |
| `FI` | fragment | `FIn` 结构体主体末尾（在 `@builtin(front_facing)` 之前）       | 镜像 `VO` 的以逗号结尾的成员声明。                                                                                                                                                                                              |
| `FH` | fragment | 模块作用域，基础辅助函数之后、`@fragment fn main` 之前         | 辅助函数 / 常量声明。基础辅助函数（`rcode`、`solveH`、`solveV`、`ccov`、`cwgt`、`bloc`）以及 `ct` / `bt` 纹理已在作用域内，因此需要自行扫描字形条带列表的片段可在此编写为自包含函数。                                      |
| `CO` | fragment | 基础 `cov` 计算并钳位之后、覆盖率 Gamma `pow` 之前             | 可以读取并重新赋值 `var cov: f32`（`[0,1]` 内的覆盖率）的语句。作用域内有：`rc`（em 空间渲染坐标）、`pe`（每 em 像素数）、`gp`（字形纹素原点）、`bm`（最大条带索引）、`in`。Gamma、`a2c` 预乘选择以及最终颜色写入保留在模板中。 |

基础条带循环内部刻意**没有**逐曲线槽位。那些循环在曲线沿条带排序轴落到像素后面时就会 `break`，而且它们只访问包含该像素的那一个条带——这两点对覆盖率都是正确的，但对任何需要*最近轮廓*信息的功能都是错误的（见“为什么字重片段拥有自己的扫描”）。需要不同遍历方式的特性应在 `FH` 中编写自己有界限的扫描，而不是搭在一个它无法控制退出条件的循环上。

槽位 id 很短，因为它们是体积敏感路径中的准 WGSL 标识符；它们被枚举为联合类型，因此拼写错误会是编译错误而不是静默被忽略的注入。

### 基础变体零开销

`composeSlugShader(null)` 发射的正是完全相同的基础着色器：没有额外的 varying、没有辅助函数、没有覆盖率覆盖——槽位表达式坍缩为 `""`，边界表达式直接命名为 `md.b`。因此未加权（基础）绘制组执行的着色器代码在行为上与引入该特性前的引擎完全一致，没有任何额外的片段着色器工作。

### 变体模块生命周期

`src/text/_gpu/text-pipeline.ts` 对着色器片段一无所知，且从不组合 WGSL。它接收一个已预编译的不透明模块对：

```typescript
/** @internal Opaque compiled shader-module pair for one composed text shader variant. */
export interface TextPipelineVariant {
    /** @internal Stable id — the variant field of the pipeline cache key. */
    readonly _id: string;
    /** @internal */ readonly _vertModule: GPUShaderModule;
    /** @internal */ readonly _fragModule: GPUShaderModule;
}

/** @internal Installed by an opt-in text styling feature; resolves that feature's compiled
 *  module pair for a device. Null until a feature installs one. */
export let _textVariantResolver: ((device: GPUDevice) => TextPipelineVariant) | null;
/** @internal */ export function _installTextVariantResolver(resolve: (device: GPUDevice) => TextPipelineVariant): void;
```

- **特性拥有组合和编译。** `set-font-weight-offset.ts` 自行调用 `composeSlugShader(WEIGHT_SHADER_FRAGMENT)` 和 `device.createShaderModule`，并将结果的 `TextPipelineVariant` 记忆在惰性创建的 `WeakMap<GPUDevice, TextPipelineVariant>` 中（无模块级分配，按设备自动失效——GUIDANCE §4）。核心缓存完全不保存任何变体模块字段，因此第二个特性绝不会覆盖或继承另一个特性的过时模块。
- **同一时间一个样式特性。** 解析器是单个可空槽位；安装第二个特性会替换第一个。组键接缝（下文）和变体解析器由同一特性一并安装，因此它们不可能不一致。
- 管线缓存键是**固定元数**的，六个以 `:` 分隔的字段，每个字段始终存在：
  `format : sampleCount : depthStencilFormat|"-" : "w"|"r" : "a"|"-" : variantId|"-"`。
  没有可选字段也没有分隔符别名，因此基础 A2C 管线（`…:a:-`）绝不可能与 id 碰巧是 `"a"` 的变体（`…:-:a`）碰撞。
- Alpha-to-Coverage 在管线使用的任意模块上继续作为**管线可覆盖常量**（`@id(0) override a2c`）存在——同一个模块仍然同时服务于每个变体的混合管线和 A2C 管线。

### 逐绘制组管线选择

`getOrCreateTextPipeline` 为目标签名同时返回两条管线：

```typescript
export interface TextPipelineSet {
    /** @internal Base Slug pipeline. */ _pipeline: GPURenderPipeline;
    /** @internal Composed-variant pipeline; **aliases `_pipeline`** when no styling feature
     *  is installed, so draw paths can bind it unconditionally. */ _variantPipeline: GPURenderPipeline;
    /** @internal */ _cache: TextPipelineDeviceCache;
}
```

解析在每次绑定（`TextRenderable`）/ 每次帧更新（`TextRenderer`）时发生一次，并存储在逐 renderable / 逐图层的 GPU 记录上——绝不在绘制循环内部进行，绘制循环不做任何映射查找也不构建任何键字符串。如果样式特性是在绑定构建*之后*才安装的，`TextRenderable` 绑定还会额外重新解析一次其变体管线（见“`TextRenderable`（3D）逐帧流程”第 0 步）；`TextRenderer` 路径不需要等价操作，因为它的 `_update` 每帧本来就同时解析两条管线。仅需要共享四边形缓冲区或绑定组布局的绘制路径改为调用 `getTextPipelineCache(engine)`，这只是一次 `WeakMap` 查找。

绘制组通过一次身份比较 `g._groupKey === g._curveSetId`（见“绘制组键”）在两条管线间进行选择，在局部跟踪当前已绑定的管线，并且——在 `TextRenderable` 路径（与场景绘制列表共享编码器）中——在返回前恢复基础管线，以使调用方的 `setPipeline` 去重对下一个 renderable 保持有效。`TextRenderer` 路径录制到渲染 bundle 中，其状态生命周期不会超出 `executeBundles`，因此无需恢复。

### Tree-shaking

- `text-shader-fragment.ts` 仅含类型 → 零运行时字节。
- `slug-shader.ts`（基础模板 + 构建器）可从 `text-pipeline.ts` 到达，因此每个文本消费方都携带它——如前所述恰好一份副本。
- `weight-shader-fragment.ts` **仅**由 `set-font-weight-offset.ts` 导入。不导入 `setFontWeightOffset` 的消费方永远不会到达它，因此打包产物中不存在点到二次曲线距离 WGSL、条带扫描、字重 varying 和覆盖率覆盖。`tests/lite/build/text-shader-fragment-treeshake.test.ts` 针对真实的已发布 `build/lib` 输出双向断言了这一点。
- `text-data.ts` 不携带任何字重语义。它只知道一个可选的逐 run 样式参数，以及一个默认值为 run 自身 `CurveSetId` 的不透明绘制组键。

---

## 显式启用特性：合成字重偏移

### 目的

针对每个 `GlyphRun` 在 Slug 片段着色器中解析求值的合成轮廓偏移（加粗）。这**不是** CSS 字重字体选面（100–900）；它是一个以字体设计单位计的非负轮廓偏移，通过向外扩展使渲染轮廓变粗。圆润的轮廓连接从距离场中自然得出——无需斜接/斜角逻辑。

该特性在其启用器处独自承担所有开销：导入 `setFontWeightOffset` 会拉入字重着色器片段；以实际改变某条 run 的偏移调用它会安装两个核心接缝并组合变体着色器。从不导入该 setter 的消费方支付零着色器字节和零着色器工作。

### 公共 API

```typescript
export function setFontWeightOffset(data: TextData, run: GlyphRun | number, offset: number): void;
export function loadFontWeightOffset(): Promise<typeof setFontWeightOffset>;
```

`loadFontWeightOffset()` 是由应用拥有惰性边界的形式。其实现仅动态导入 `text/set-font-weight-offset`，绝不导入包根命名空间，从而使打包器不会保守地在惰性分块中保留无关的根导出。

| 参数     | 类型                 | 描述                                                                                                                                         |
| -------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`   | `TextData`           | 拥有该 run 的 `TextData`。该 setter 直接修改实时数据：它会立即重新打包并重新分组 `data`，与实时材质上的 setter 完全一致。                     |
| `run`    | `GlyphRun \| number` | 要设置字重的 run，可以传其 `GlyphRun` 引用或其在 `data.runs` 中的当前索引。必须是 `data` 的活动 run；否则会以与 `updateTextData` 相同的错误格式抛出异常。 |
| `offset` | `number`             | 以**字体设计单位**（`GlyphCurves.bounds` 所在空间）计的轮廓偏移。正值 = 更粗。必须是有限数；伴随 `console.warn` 钳位到 `[0, 100]`。零会清除先前设置的偏移。 |

```typescript
import { setFontWeightOffset, createDefaultTextData, loadFont } from "@babylonjs/lite";

const font = await loadFont("/fonts/Inter.ttf");
const data = createDefaultTextData(font, 48, "Bold text");
setFontWeightOffset(data, data.runs[0]!, 10); // +10 font units
setFontWeightOffset(data, 0, 10); // identical: runs may be addressed by index
setFontWeightOffset(data, 0, 0); // back to the base pipeline
```

它接收所属的 `TextData` —— 而不是孤立的 `GlyphRun` —— 因为 run 是**同步**打包的。`createTextData` / `createDefaultTextData` 在返回前就已经打包好了它们的 run，而 `updateTextData` 在应用每次编辑时即时打包，因此仅把状态记录在游离 run 描述符上的 setter 永远无法影响已经存在的数据；在 `DefaultTextData`（其唯一的 run 在工厂内部创建并打包）上，甚至根本不存在能进行此类调用的时机。拥有 `TextData` 让 setter 可以当场重新打包并重新分组，因此该调用在数据生命周期的任意时刻都有效，包括在它已经绑定并正在渲染之后。

### Setter 生命周期

1. **验证偏移量。** 非有限数 → `console.error`，直接返回。不安装任何东西也不重新打包。
2. **针对 `data` 解析 run。** `_resolveRunRef(data, run, "setFontWeightOffset")`（`text-data.ts`）接收 `data` 中活动的 `GlyphRun` 引用或 `data.runs` 中的有效范围索引，否则抛出异常——与 `updateTextData` 错误的措辞相同（`… : run index N out of range (0..M).` / `… : GlyphRun reference is not in this TextData.`）。`updateTextData` 自身的索引路径共享此辅助函数，因此两者绝不会发生漂移。
3. **钳位** 到 `[0, 100]`，超范围时输出 `console.warn`。
4. **空操作检测。** 如果解析出的 run 当前的有效偏移已经等于钳位后的值，则在触碰任何东西之前返回：不安装接缝、不组合着色器、不递增 `_version` / `_layoutVersion`。因此对从未设置过偏移的 run 传入零是一个*真正的*空操作——它不会安装特性或编译其着色器——而首次非零调用总会安装。
5. **捕获** `WeakMap` 中该 run 的精确先前条目——无论它之前是否有条目及其值——随后**存储**钳位后的偏移（为零则删除条目），随后幂等地**安装接缝**（`_installTextStyleSeam` + `_installTextVariantResolver`）。
6. 通过 `updateTextData(data, { update: "reset" })` **重新打包** —— 这是现有的最窄 `TextData` 操作，既能重读每个 run 的绘制组键，又能重写每个样式条目的 `params.y`。不带 `runs` 的 `reset` 保留当前的 run 对象（它防御性地拷贝 `data._runs`），压缩槽位分配器，并按键复用先前的绘制组对象，因此 run 在基础组与加权组之间移动只是一次重新分组——而不是重建调用方的描述符。该特性刻意不重复实现任何分配器、分组或样式打包逻辑。
7. **失败时回滚。** 如果第 6 步抛出异常（例如该 run 的曲线集已不在 `data` 的存储中），第 5 步写入的 `WeakMap` 条目会恢复到其精确的先前状态——如果调用前该 run 没有条目则删除，若有则恢复为先前值——然后再原样重新抛出错误。如果不这样做，失败的重新打包会让映射停留在*新*偏移上而数据本身其实从未被重新打包；随后修正了失败原因并以相同偏移重试的调用方就会命中第 4 步的空操作守卫，导致静默未修复而非重试。第 5 步中安装的接缝**不**回滚——它们是幂等的，在任何 run 实际使用它们之前都没有副作用，且重试时再次运行 `ensureInstalled` 是空操作，因此失败调用后让它们保持安装是无害的。

因此，传入零在同一次调用中既清除了偏移，又将该 run 的组恢复为基础键（以及基础管线）。

### `DefaultTextData` 与 run 替换

`createDefaultTextData` 在返回前打包其单个 run，因此 setter 可立即可用：`setFontWeightOffset(data, data.runs[0]!, 10)`（或 `setFontWeightOffset(data, 0, 10)`）。

`updateDefaultTextData` 将文本重新塑形为一个**新的** `GlyphRun` 描述符并用 `replaceRun` 应用它。偏移量以 run 身份为键，因此它们**不会**转移到替换后的 run 上：该文本块会退回到基础管线，直到调用方在新 run 上重新应用 `setFontWeightOffset(data, 0, offset)`（由于引用变了，这里用索引形式很方便）。这是有意为之——通用的“跨 replaceRun 搬运逐 run 特性状态”接缝会把特性语义放回 `text-data.ts`，并让每个文本消费方都为普通消费方根本用不到的搬运机制付出字节代价。对于任何替换 run 描述符的调用方驱动 `updateTextData({ update: "replaceRun" | "reset", runs })` 也是如此。

### 核心样式接缝

`text-data.ts` 精确暴露一个可空接缝对象和一个不透明类型：

```typescript
/** @internal Opaque draw-group identity, compared by `===` only. The default is the run's
 *  own `CurveSetId`; a styling feature may substitute an interned non-string token, which
 *  by construction can never equal a curve-set id. */
export type TextGroupKey = CurveSetId | object;

/** @internal */
export interface TextStyleSeam {
    /** @internal Draw-group key for a run — `run.curveSet` unless the run needs a different
     *  pipeline variant. Must never return a value that equals another curve set's key. */
    _key(run: GlyphRun): TextGroupKey;
    /** @internal Extra style float, packed verbatim into `TextStyle.params.y`. */
    _param(run: GlyphRun): number;
}

/** @internal */ export let _textStyleSeam: TextStyleSeam | null;
/** @internal */ export function _installTextStyleSeam(seam: TextStyleSeam): void;
```

`text-data.ts` 对这两个返回值**不附加任何**含义：`_param` 是它直接拷入 `params.y` 的浮点数，`_key` 是它用 `===` 比较的令牌。两个调用点都是带中性默认值的单个可选链调用（`_textStyleSeam?._key(run) ?? run.curveSet`、`_textStyleSeam?._param(run) ?? 0`），跨越边界的只有标量或不透明值。所有字重语义都位于 `set-font-weight-offset.ts` 中。

`text-data.ts` 额外导出一个与特性无关的辅助函数，以便逐 run 特性 setter 能以与 `updateTextData` 完全相同的方式解析并验证其 run 参数：

```typescript
/** @internal Resolve a `GlyphRun | number` reference against `data`'s live runs. `op`
 *  prefixes the thrown message. */
export function _resolveRunRef(data: TextData, ref: GlyphRun | number, op: string): GlyphRun;
```

`updateTextData` 自身的索引路径也使用它，因此两者绝不会漂移，且对于不导入任何特性 setter 的消费方它会被 tree-shake 掉。

### 样式打包

`writeRunToSlots` 对每个 run 调用一次 `_param`，并将结果写入 `TextStyle.params.y`（先前预留/为零；`params.x` 仍携带 `invScale`）。结构体和步长无任何变化。该值像所有其他样式浮点数一样通过 `Math.fround` 进行比较，因此未改变的偏移不会递增 `_styleVersion`。

### 绘制组键

`TextDataDrawGroup._groupKey: TextGroupKey` 取代了引入该特性前隐式的“每个曲线集一个组”的身份。分组、跨越 `reset` 的旧组复用、`addRun` 查找以及 `replaceRun` 的原地快速路径全都**按身份比较那一个字段**——引入该特性前代码的扁平 `Map<TextGroupKey, GlyphRun[]>` / `Map<TextGroupKey, TextDataDrawGroup>` 形态、分配特征和迭代顺序均被原封不动地保留（每组一个数组，无嵌套映射，无逐曲线集数组对）。`_curveSetId` 仍保留在组上，用于图集查找、绑定组标签和错误消息。

- 未安装样式特性时，每个组的 `_groupKey === _curveSetId`，分组算法与引入该特性前逐字节相同。
- `set-font-weight-offset.ts` 对未加权 run 返回 `run.curveSet`，对加权 run 则返回一个驻留的**对象**令牌（每个 `CurveSetId` 一个，来自惰性创建的 `Map<CurveSetId, object>`）。对象绝不可能与字符串 `===` 相等，因此 id 恰好看起来像另一个组变体键的曲线集绝不会发生碰撞——使用分隔符拼接复合字符串键会混淆的病态 `"X"` / `"X:w"` 组合仍会留在不同的组中（已通过回归测试）。
- 同一个曲线集上的基础 run 和加权 run 会落入**分开的**绘制组，因为它们需要不同的管线。具有**不同**非零偏移的加权 run 则合批进**同一个**组——偏移量通过每个样式条目中的 `params.y` 传递。
- `g._groupKey !== g._curveSetId` 精确地表示“该组需要变体管线”，因此绘制路径不需要任何额外的逐组状态。

### 字重着色器片段

`src/text/shaders/weight-shader-fragment.ts` 导出一个 `TextShaderFragment`（`_id: "w"`），**仅**包含增量代码：

| 槽位 | 贡献                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `VO` | `@location(4) @interpolate(flat) wo:f32,` —— 逐实例字重偏移 varying。                                                              |
| `VD` | `d.wo=0.0;` —— 死亡槽位默认值。                                                                                                    |
| `VB` | `let wo=sy.p.y; let sb=vec4<f32>(md.b.xy-vec2<f32>(wo),md.b.zw+vec2<f32>(wo));` —— 对称膨胀字体空间边界，使四边形覆盖扩展后的轮廓。 |
| `VA` | `out.wo=wo;`                                                                                                                       |
| `FI` | `@location(4) @interpolate(flat) wo:f32,`                                                                                          |
| `FH` | `dot2` + `dq`（点到二次贝塞尔曲线的精确距离）+ `wdst`（有界最近轮廓条带扫描）。                                                    |
| `CO` | 零偏移守卫、无符号距离、加权覆盖率以及单调 `max` 最终化。                                                                          |

### 为什么字重片段拥有自己的扫描

基础条带遍历是*环绕数（winding）*查询，而非*最近轮廓*查询，其两项优化仅对环绕数成立：

1. 它精确地读取**一个**水平条带（包含像素 `y` 的条带）和一个垂直条带。对于 `+x` / `+y` 射线投射而言这是完备的，因为从像素出发的射线会一直停留在自己的条带内。但对于距离而言这是**不完备的**：靠近条带边界的像素的最近轮廓往往位于相邻条带中。
2. 在条带内部，一旦曲线的 `max x` 落在像素后方超过半个像素，它就会 `break`（曲线按 `max x` 降序排列）。其余每条曲线都在射线后方，因此不可能与射线相交——但位于像素*左侧*的曲线恰恰是可能离它最近的曲线。

因此在那些循环内部累加最小距离会静默跳过像素左侧和下方的曲线，导致在字形的右侧、顶部边缘以及所有四个角上裁切掉正（加粗）偏移。故字重片段在 `FH` 中声明了自己完备且有界的扫描，不从基础循环读取任何东西：

```wgsl
fn wdst(rc:vec2<f32>,gp:vec2<i32>,bm:vec2<i32>,bn:vec4<f32>,rad:f32)->f32
```

- **搜索半径。** `rad = wo + 1/aaScale` 字体单位，其中 `aaScale = max(pe.x, pe.y)` 是每字体单位的像素数。超出该半径之外，加权覆盖率会饱和到 0（外部）或被基础覆盖率主导（内部），因此距离远于 `rad` 的曲线不可能改变结果。
- **完备的条带范围。** 每个水平条带在 `x` 上跨越整个字形宽度并在 `y` 上划分（`glyph-storage.ts` → `buildBandsInternal`），条带包含所有 `y` 范围与之相交的曲线。因此 `wdst` 遍历所有与 `[rc.y - rad, rc.y + rad]` 相交的水平条带：
  `y0 = clamp(i32((rc.y - rad) * bn.y + bn.w), 0, bm.y)`，
  `y1 = clamp(i32((rc.y + rad) * bn.y + bn.w), 0, bm.y)`。
  任何存在距离像素 `rad` 以内点的曲线，其该点都在字形的 `y` 边界内，因此其条带索引位于 `[y0, y1]` 内，且该曲线就在该条带的列表中。
  *已验证的条带变换不变量：* 当 `heightFu > 0` 时 `bandScaleY = hBandCount / heightFu` 否则为 `0`，且 `bandOffsetY = -yMin * bandScaleY`，因此该变换单调非减且永不为负。零缩放会将范围坍缩到条带 0，这也是零高度字形唯一的条带。不需要符号守卫；一项单元测试在构建器中钉死了该不变量。
- **仅使用感知半径的提前中断。** 在条带内部，扫描仍利用 `max x` 降序排列的特性，但使用感知半径的界限 `curveMaxX < rc.x - rad`。存在距离像素 `rad` 以内点的曲线满足 `maxX >= rc.x - rad`，而在排序顺序中排在它前面的每条曲线具有至少同样大的 `maxX`，因此绝不会跳过任何范围内的曲线。
- `dq` 是精确的点到二次曲线距离：当 `dot(b,b) < 1e-7` 时走退化直线段快速路径，否则执行将 `t` 钳位到 `[0,1]` 的最近点缺项三次方程求解（单个实根用卡尔丹公式，三个实根用三角形式）。

### 着色器数学（`CO` 槽位）

```wgsl
if(in.wo!=0.0){
  let aas=max(max(pe.x,pe.y),1.0e-8);
  let d=wdst(rc,gp,bm,in.bn,in.wo+1.0/aas);
  let wc=clamp((in.wo-d)*aas+0.5,0.0,1.0);
  cov=max(cov,wc);
}
```

1. **零偏移守卫。** 偏移为零的 run——包括留在变体组中的过时样式条目——完全不执行距离扫描，并逐位保留基础覆盖率。
2. **基础 Slug 覆盖率原封不动运行**，并在原始填充内部保持权威。
3. **无符号轮廓距离。** 仅正值加粗无需内/外分类：`wdst` 是任意方向上到最近轮廓的距离。
4. **偏移阈值。** 覆盖率随距离递减，而偏移量将边界向外推移：`wc = saturate((wo - d) * aaScale + 0.5)`，约为 1px 的屏幕空间过渡。
5. **单调最终化。** 加粗只能增加覆盖率：`cov = max(cov, wc)`。这使解析基础覆盖率在原始填充内部保持权威，而距离场仅贡献其向外扩展的部分。高估的 `wdst` 绝不会在原始字形内部打出空洞。
6. 随后模板以与基础变体完全相同的方式应用覆盖率 Gamma 和 `a2c` 预乘选择。

`aaScale` 下限设为 `1e-8`，使退化的导数（`fwidth == inf`）无法产生非有限半径；对于任何真实字形，覆盖率传递函数不受影响。

### 限制

偏移量钳位到 `[0, 100]` 字体设计单位；超范围值伴随 `console.warn` 钳位，非有限值伴随 `console.error` 被拒绝。比例效果取决于字体的 `unitsPerEm`：对于 2048 单位的字体，`100` 大约为 `0.049 em`。设立该上限是因为大偏移会将字形四边形扩展到相邻字形中，并拉长逐像素条带扫描（其开销与半径跨越的条带数量成正比）。

### 测试规范

`tests/lite/unit/text-font-weight-offset.test.ts`：

- **Setter 语义** —— 在实时 `TextData` 上附加 / 覆盖 / 用零清除；`NaN` 和 `Infinity` 伴随 `console.error` 被拒绝且不重新打包；值伴随 `console.warn` 钳位到 `[0, 100]`；设置为 run 已有的值是空操作（`_version` 和 `_layoutVersion` 不变），且对从未加权的 run 传入零不会安装任何内容。
- **Run 解析** —— 索引形式（`setFontWeightOffset(data, 0, …)`）等价于引用形式；越界索引和属于另一个 `TextData` 的 `GlyphRun` 均以 `updateTextData` 风格的错误消息抛出异常。
- **创建后变更** —— 在 `createTextData` *之后*（即 run 已经打包之后）进行的 setter 调用立即改变 run 的绘制组键及其 `params.y`；紧接着传入零会将两者都恢复为基础键和 `0`。
- **样式打包** —— 加权 run 的 `params.y` 保存 `Math.fround(offset)`；基础 run 的为 `0`。
- **`DefaultTextData` 流程** —— setter 在 `createDefaultTextData` 之后立即可用于 `data.runs[0]`，且在 `updateDefaultTextData` 替换 run 之后偏移不会自动转移，但按索引重新应用可以生效。
- **变体分组** —— 同一曲线集上的一个基础 run 和一个加权 run 产生两个具有相同 `_curveSetId` 的组，一个以曲线集为键，另一个以驻留令牌为键；具有不同偏移的两个加权 run 共享同一个组；`addRun` / `replaceRun` / `removeRun` 尊重该键。
- **组键碰撞回归** —— `"X:w"` / `"X"` 组合在创建时及跨越 `reset` 时保持在各自的组中并带有正确的曲线集（组对象身份按键复用）。
- **条带扫描完备性（算法层面）** —— 由合成正方形字形的真实 `buildGlyphBands` 输出驱动的 `wdst` 候选选择的 JS 复现，对于全部四个外侧边和四个角上的采样点都必须能考虑到真正的最近曲线。断言修复前“在基础循环内累加”的候选集在同一检查上*失败*，从而使该回归不会静默重现。
- **条带变换不变量** —— `buildGlyphBands` + 打包元数据始终产生非负且单调的条带变换（`wdst` 的范围钳位所依赖的性质）。
- **组合性** —— `composeSlugShader(null)` 不含字重 varying、`dq`/`wdst` 辅助函数或覆盖率覆盖，且其条带循环不含注入语句；组合后的变体包含全部这些内容；基础源码在每一个有效行上都是变体的子序列，证明了是组合而非复制。基础的 `_key` 为 `""`，变体为片段 id。
- **覆盖率方向** —— `CO` 传递函数的 JS 复现证明正偏移会产生扩展，且 `max` 最终化绝不会移除解析基础覆盖率。
- **管线缓存键** —— 导出的键构建器为固定元数，且基础 A2C 管线不能与 id 为 `"a"` 的变体碰撞。

`tests/lite/unit/text-renderer-variant-pipeline.test.ts`：模拟设备 + 渲染 bundle 编码器录制一个包含基础、加权和基础绘制组的图层，并断言精确的 `setPipeline` / `setBindGroup` / `draw` 命令序列（base → variant → base）、仅基础的图层录制的命令序列与引入特性前完全一致，以及变体管线是在 `_update` 期间而非逐次绘制时解析的。同一个文件在模块隔离下（`vi.resetModules()` + 动态导入，确保没有更早的测试安装过解析器）覆盖了 `TextRenderable` 延迟安装路径：renderable **先绑定**，其绑定 `update` 在未安装样式特性的情况下运行（变体管线别名指向基础管线），随后在其活动 `TextData` 上调用 setter，而下一次绑定 `update` 必须将 `gpu._variantPipeline` 刷新为由同一目标签名构建的独立管线——之后录制的绘制序列为 base → variant → base。

`tests/lite/build/text-shader-fragment-treeshake.test.ts`（在已发布的 `build/lib` 上运行 Rollup）：导入文本渲染但不导入 `setFontWeightOffset` 的消费方保留基础 Slug 源码而**不含**字重片段的 WGSL；同时导入 `setFontWeightOffset` 的文本消费方则保留两者，且基础 Slug 逻辑仍然只声明一次。
