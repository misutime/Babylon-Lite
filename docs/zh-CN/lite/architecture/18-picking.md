# 模块：拾取（Picking）

> 包路径：`packages/babylon-lite/src/picking/`

## 目的

GPU 加速的标识与表面拾取。每次拾取都会将选定的屏幕像素渲染到 1×1 离屏目标中，回读获胜的 ID 和深度，并重建世界空间坐标点。在暴露可选 WebGPU `primitive-index` 特性的适配器上，`createEngine` 会在创建设备时请求该特性，且 `enableDetailedPicking` 会激活一个精确的 GPU 详情附件，其中包含获胜的图元索引（primitive index）和插值后的局部坐标。不支持的设备会保持详细拾取处于未激活状态；系统不提供 CPU 三角形搜索回退路径。

## 公共 API 接口

### 类型

```typescript
interface PickingInfo {
    hit: boolean;
    distance: number;
    pickedPoint: [number, number, number] | null;
    pickedNormal: [number, number, number] | null; // local-space, set by detailed picking
    pickedNormalWorld: [number, number, number] | null;
    pickedFaceNormal: [number, number, number] | null;
    pickedFaceNormalWorld: [number, number, number] | null;
    pickedMesh: Mesh | GaussianSplattingMesh | null; // GS meshes resolve here too, via their pick contributor
    faceId: number; // -1 if no detailed picking
    bu: number; // barycentric u
    bv: number; // barycentric v
    subMeshId: number;
    thinInstanceIndex: number; // -1 if not thin instance
    ray: Ray | null; // the pick ray, set when detailed picking ran
    _spritePick?: BillboardPickInfo; // billboard hit payload, set by the billboard pick contributor (read by pickBillboardSprite)
}

// GpuPicker is pure state — used via the standalone functions below, never as methods.
interface GpuPicker {
    _scene: SceneContext;
    _detailedPicking: boolean;
    _contributors: Map<PickSource, PickContributor> | null; // built once per pick source, cached
    // + lazily-allocated 1×1 ID/depth/detail targets, scene UBO, and scene bind group
}

interface Ray {
    origin: [number, number, number];
    direction: [number, number, number];
    length: number;
}

interface PickOptions {
    filter?: (mesh: Mesh) => boolean;
    /** Exclude visible identities while selecting the surface behind them.
     *  Omit thin fields to exclude a regular mesh or all thin instances;
     *  provide one index or a contiguous range to discard only those instances. */
    ignore?: PickIgnore | readonly PickIgnore[];
    discard?: PickDiscardRule;
    debugLabel?: string;
}

interface PickIgnore {
    readonly mesh: Mesh;
    readonly thinInstanceIndex?: number;
    readonly thinInstanceRange?: { readonly start: number; readonly count: number };
}

type PickVertexDataAttribute = "normal" | "uv" | "uv2" | "tangent" | "color";

interface PickDiscardStorage {
    readonly name: string;
    readonly type: string;
    /** Opt this binding into vertex-stage visibility when worldAdjustWgsl reads it. */
    readonly vertex?: boolean;
    readonly data: (mesh: Mesh) => ArrayBufferView | null | undefined;
}

interface PickDiscardRule {
    readonly key: string;
    readonly wgsl: string;
    /** Optional vertex-stage hook that returns the world position used for projection and fragment discard. */
    readonly worldAdjustWgsl?: string;
    readonly storage?: readonly PickDiscardStorage[];
    /** Optional regular-mesh vertex attribute exposed to the discard predicate.
     *  Missing components and meshes without the requested buffer read as zero. Thin instances
     *  always read zero here and keep their per-instance payload in `instanceExtras`. */
    readonly vertexData?: PickVertexDataAttribute;
}

// WGSL shape injected when PickDiscardRule.vertexData is set.
// Rules without vertexData keep the legacy shape without that field.
struct PickDiscardInput {
    worldPos: vec3f,
    fragmentCoord: vec2f, // selected pixel center in the original backing framebuffer
    pickId: u32,
    thinInstanceIndex: u32,
    hasThinInstance: u32,
    instanceExtras: vec4f,
    vertexData: vec4f,
}

struct PickWorldInput {
    worldPos: vec3f,          // affine world transform of localPos before custom displacement
    localPos: vec3f,          // position read by the current pick pipeline
    basis0: vec3f,            // affine world basis column 0
    basis1: vec3f,            // affine world basis column 1
    basis2: vec3f,            // affine world basis column 2
    origin: vec3f,            // affine world translation column
    instanceExtras: vec4f,    // thin-instance matrix w lanes; zero for regular meshes
    thinInstanceIndex: u32,   // actual index or 0xffffffffu for a regular mesh
    hasThinInstance: u32,     // 1 for thin instances, otherwise 0
    vertexData: vec4f,        // selected regular-mesh attribute or zero
}
```

### 函数

```typescript
/** Create a GPU picker bound to a scene (pure state; render targets are allocated on the first pick). */
function createGpuPicker(scene: SceneContext): GpuPicker;

/** Run one pick at pixel (x, y) on the picker's scene surface. `options` can filter meshes,
 *  inject a GPU discard rule, or set a debug label. */
function pickAsync(picker: GpuPicker, x: number, y: number, options?: PickOptions): Promise<PickingInfo>;

/** Free the picker's GPU resources (render targets, scene UBO, and each cached contributor's state). */
function disposePicker(picker: GpuPicker): void;

/** Enable exact GPU primitive details when the device has the requested `primitive-index` feature.
 *  Unsupported devices leave the picker in basic mode. */
function enableDetailedPicking(picker: GpuPicker): void;

/** Interpolate the normal at the picked point using barycentric coords. */
function getPickedNormal(info: PickingInfo, useWorldCoordinates?: boolean): [number, number, number] | null;

/** Interpolate the UV at the picked point using barycentric coords. */
function getPickedUV(info: PickingInfo): [number, number] | null;
```

### 网格 CPU 几何字段（位于 `Mesh` 接口上）

```typescript
_cpuPositions?: Float32Array;  // retained positions for barycentric reconstruction
_cpuNormals?: Float32Array;    // retained normals for interpolation
_cpuUvs?: Float32Array;        // retained UVs for interpolation
_cpuIndices?: Uint32Array;     // retained indices for exact primitive lookup
```

由 `createMeshFromData`（网格工厂）、glTF 加载器和 `.babylon` 加载器自动填充。无需额外拷贝——这些数组原本就已存在于 JS 内存中。

## 内部架构

### GPU 拾取通道

1. 为每个网格（或薄实例）分配一个顺序拾取 ID（从 1 开始；0 表示未命中）。
2. WGSL 着色器在 `@location(0)` 写入 24 位拾取 ID（作为 RGB），并在 `@location(1)` 写入片元的 NDC 深度。
3. 该通道使用**拾取缩放视图投影矩阵（pick-zoomed view-projection）**，使只有被拾取的像素能够留存下来，将所有网格绘制到一个 **1×1** 目标中：包含两个颜色附件（`rgba8unorm` 拾取 ID + `r32float` NDC 深度）以及一个 `depth24plus` 深度缓冲区（反向 Z，比较函数为 `greater`）。由于 1×1 目标中的片元位置始终为 `(0.5, 0.5)`，场景 UBO 会单独携带原始后台帧缓冲区坐标系下选定像素的中心位置，供自定义丢弃 WGSL 使用。
4. 详细模式会增加一个 `rgba32uint` 附件。网格片元会写入 `(primitiveIndex, bitcast(localX), bitcast(localY), bitcast(localZ))`。公告牌和高斯泼溅贡献者（contributor）会写入 `0xffffffff` 作为图元哨兵值。
5. 将 1×1 纹素复制到可复用的暂存缓冲区并回读。
6. 解码拾取 ID：`(r << 16) | (g << 8) | b`。
7. 通过 `inverse(VP)` 对同一个选定像素中心及回读深度进行反投影，重建世界空间点。可选的射线同样使用该精确中心。
8. 在录制命令时会拍下网格 ID 范围的快照，因此异步回读期间的场景变更不会导致返回的 ID 映射错乱。

### 可选常规网格顶点数据

`PickDiscardRule` 可通过 `vertexData` 指定一个现有的网格属性。随后拾取器会选择一个缓存的常规网格管线变体，其第二个顶点缓冲区会读取该属性，并以 `flat` 方式将其作为填充后的 `vec4f` 转发给 `PickDiscardInput.vertexData`：

| 属性 | GPU 格式 | `vertexData` 投影 |
| --------- | ----------- | ----------------------- |
| `normal` | `float32x3` | `(x, y, z, 0)` |
| `uv` | `float32x2` | `(x, y, 0, 0)` |
| `uv2` | `float32x2` | `(x, y, 0, 0)` |
| `tangent` | `float32x4` | `(x, y, z, w)` |
| `color` | `float32x4` | `(r, g, b, a)` |

材质声明的格式必须与这些 float32 读取兼容。多余的 float32 分量可以被忽略（例如，`float32x4` 位置会作为 XYZ 读取），但 float16、整数、归一化或分量不足的格式会被显式拒绝，而不会重新解释。位置验证在打开拾取编码器之前运行；丢弃数据验证仅在实际消耗已编写的数据流时运行。缺失的数据流保留下述零值回退行为。可使用 `Mesh.pickable = false`、`PickOptions.filter` 或 `ignore` 排除不兼容的几何体。

转发使用 `@interpolate(flat)`，因此类别型载荷在三角形内保持精确。如果常规网格不拥有请求的 GPU 属性，拾取器将使用仅位置管线并提供 `vec4f(0.0)`；已知的零填充占位 UV 缓冲区（`hasUv === false`）不会被绑定。交错（interleaved）glTF 缓冲区对位置和所选属性均使用其记录的步长（stride）和字节偏移量。转发的值是原始源缓冲区的值：蒙皮和变形（morph）不会为此通用载荷变换法线或切线。薄实例拾取同样提供零值 `vertexData`；其现有的 `instanceExtras` 字段仍作为通用的每实例载荷。这使该特性保持可选，不会给默认紧凑拾取增加顶点缓冲区绑定，也不会让拾取器去解释消费者数据。

顶点数据/世界空间调整着色器生成、属性查找以及紧凑/交错管线变体均位于统一的 `picking-shader.ts` / `picking-pipeline.ts` 所有者中。缓存键包含规则键、所选属性、存储阶段布局、详细/基础模式以及顶点缓冲区步长/偏移量。

### 拾取顶点世界空间调整

`PickDiscardRule.worldAdjustWgsl` 允许调用者在拾取通道中镜像可见顶点的位移。源代码必须定义：

```wgsl
fn adjustPickWorld(input: PickWorldInput) -> vec3f
```

默认实现原样返回 `input.worldPos`。常规和薄实例着色器在仿射世界变换之后、视图投影之前调用该钩子。返回的位置用于投影，并成为 `PickDiscardInput.worldPos`，因此片元谓词可以观察到变形后的表面。常规网格提供零值 `instanceExtras` 和 `0xffffffffu` 非实例哨兵值；薄实例提供矩阵中四个预留的 `w` 通道及其实际的实例索引。当选择了 `vertexData` 时，常规网格会向 `PickWorldInput` 和 `PickDiscardInput` 暴露相同的填充后源属性；缺失的属性和薄实例则提供零值。

存储声明默认仅对片元阶段可见。仅当 `worldAdjustWgsl` 读取该绑定时，才将存储条目的 `vertex: true` 设为真；此时 Lite 会为该条目使用 `VERTEX | FRAGMENT` 可见性。这使仅片元使用的丢弃数据不会占用顶点阶段的存储限制，同时仍允许两个钩子共享选定的每网格数据。每当任一 WGSL 源码或其存储/顶点布局发生变化时，调用者都必须更改 `PickDiscardRule.key`，以保证缓存管线的有效性。

薄实例输入使用与可见渲染相同的组合变换：`mesh.world * instanceWorld`。矩阵中四个打包的 `w` 通道单独作为 `instanceExtras` 暴露，并在仿射变换中强制置为 `0,0,0,1`。经世界空间调整的详细拾取仍保留 GPU 深度、精确图元索引、位移后的世界点、重心坐标以及 UV 插值。由于任意的调用者 WGSL 可能会在没有 CPU 法线契约的情况下旋转或非均匀地变形表面，因此经世界空间调整的命中会刻意不提供插值法线和面法线（`getPickedNormal` / `getPickedFaceNormal` 返回 `null`）。

### 精确 GPU 详细结果

`primitive_index` 是一个可选设备特性，而非无条件的 WGSL 语言特性。`createEngine` 会检查 `adapter.features`，并在可用时将 `"primitive-index"` 添加到 `requestDevice({ requiredFeatures })`。设备丢失恢复也会捕获并重新请求相同的特性集合。仅当 `device.features.has("primitive-index")` 为真时，`enableDetailedPicking` 才会激活；否则为空操作。

对于网格命中，详情附件会标识精确的带索引三角形及其插值后的局部表面点。Lite 仅在该已知三角形内计算重心权重——不会进行扫描或射线/三角形相交检测——并使用保留/变形后的位置加上源顶点法线来填充 `faceId`、`bu`、`bv`、局部/世界插值法线以及局部/世界面法线。这与 Babylon.js 的 `PickingInfo.getNormal(..., true)` 一致：变形/蒙皮位置会为命中点执行变形，而公共顶点法线插值则使用网格的源法线数据。UV 辅助函数使用相同的权重。薄实例法线变换会重建与 WGSL 相同的仿射实例矩阵，排除打包的 `w` 载荷通道。

基础的非变形拾取从不读取保留的 CPU 位置或法线。这保留了惰性交错 glTF CPU 访问器的优势，并避免了对基础 GPU ID/深度路径不消费的数组进行解交错和分配。

### 材质持有的顶点投影（VAT）

统一管线接收一个由可见材质特性惰性提供的可选内部 `PickingVertexProjection`。VAT 是第一个实现此投影的特性：

- 仅当某个可拾取网格具有 `mesh.vat` 时，`gpu-picker.ts` 才会导入 `vat-picking-pipeline.ts`。
- `vat-picking-pipeline.ts` 向 `vat-fragment.ts` 请求与可见渲染完全相同的辅助函数、帧行选择、4/8 骨骼矩阵求和、双剪辑混合及变换顺序。
- 常规 VAT 使用 `mesh.world * influence` 进行投影。
- 薄实例 VAT 使用 `instanceWorld * mesh.world * influence` 进行投影，匹配可见的外部实例放置方式，而非普通的仿射 `mesh.world * instanceWorld` 路径。
- 该投影同时提供 `projectedWorld` 和 `projectedTransform`，因此 `PickWorldInput.worldPos`、基向量列和原点在进入调用者可选的 `worldAdjustWgsl` 之前均描述实际的 VAT 变形后变换。
- Group 3 拥有 VAT 纹理/设置以及可选的实例参数资源。Group 0/1 仍为拾取器场景/网格组；Group 2 仍为丢弃存储（或空布局）。
- 蒙皮顶点缓冲区追加在位置和可选 `vertexData` 之后：4 骨骼蒙皮使用 joints/weights，8 骨骼蒙皮额外附加 joints1/weights1。
- 薄实例回放既可以读取常规的双纹素 `instanceTexture`，也可以读取由 `setVatInstanceStorage` 配置的权威公共 `StorageBuffer`。

在没有 VAT 网格的场景中，不会加载 VAT 投影模块和着色器字节。VAT 详细拾取保留精确的图元/重心/UV 标识以及位移后的世界深度/点；由于 CPU 不保留逐帧烘焙的法线变换，因此法线不可用。

### 忽略单个可见标识

`PickOptions.ignore` 支持直接操纵工作流，使拾取能够穿透一个或多个选定物体而选中其背后的表面。常规网格（或某个网格的所有薄实例）会从 ID 分配和绘制中省略。单个薄实例或单个连续薄实例范围仍保留在位置 ID 范围内，但其顶点会标记 `excluded`，从而使片元在同一按深度排序的 GPU 通道中仅丢弃该范围。既不需要第二次拾取，也不需要 CPU 代理几何体。

`Mesh.visible` 刻意不作为拾取门控：操纵杆（gizmo）会使用不可见、放大的碰撞网格，且它们仍可被拾取。`Mesh.pickable === false`、`PickOptions.filter` 和 `ignore` 是从拾取通道中移除网格标识的显式方式。

### 拾取贡献者（可选实体类型）

拾取器首先自行绘制网格（阶段 1，ID 为 `1..M`），随后遍历 `scene._pickSources`——一个由 `PickSource` 记录（`{ entity, load }`，`pick-contributor.ts`）组成的通用列表——而无需了解任何具体实体类型。每种_可选_可拾取实体在添加到场景时注册一个源：高斯泼溅网格（`attachGaussianSplattingMesh`，每个网格一个 ID）和公告牌精灵系统（`addBillboardSystemToScene`，`system.count` 个 ID；通过 `removeBillboardSystemFromScene` 注销）。源只是纯数据加上一个动态 `import()` thunk——注册时不绑定任何拾取行为。在首次拾取时，拾取器会 `load()` 每个源的管线，调用其 `createPickContributor(entity)` 构建处理器，并将结果缓存在 `picker._contributors` 中。贡献者将结果绘制到**同一个** 1×1 通道并共用**同一个**深度目标，因此它们能与网格及彼此之间进行深度排序；每个贡献者拥有一段连续的 ID 范围 `[base, next)`，拾取器会记录该范围用于解析。添加新的可拾取类型只需新建一个调用 `registerPickSource` 的模块——无需修改 `gpu-picker.ts` 或 `scene-core.ts`。

由于源不携带拾取行为代码，_渲染_公告牌或 GS 实体不会拉取任何拾取管线字节（仅包含实体引用 + 导入 thunk）——只有拾取器（在首次拾取时）才会导入 `gs-picking-pipeline.ts` / `billboard-pick-pipeline.ts`、构建贡献者，并将每个拾取器的 GPU 资源缓存在贡献者闭包中（通过每个贡献者可选的 `dispose` 进行通用释放）。没有此类实体的场景拉取零贡献者拾取字节；从不进行拾取的场景完全不拉取任何拾取代码。解析时，GS 贡献者设置 `info.pickedMesh`（命中点来自共享的深度回读），而公告牌设置 `info._spritePick`。当详细模式激活时，贡献者也会参与第三个附件的写入，但会写入图元哨兵值，因为它们的公共载荷不使用网格面/重心辅助函数。

### 重心插值（辅助函数）

对于每个顶点具有值 `A0, A1, A2` 的顶点属性 `A`：

```
A_hit = bu * A0 + bv * A1 + (1 - bu - bv) * A2
```

用于法线（`getPickedNormal`）和 UV（`getPickedUV`）。

## 管线配置

### 渲染目标（1×1，无 MSAA，首次拾取时惰性创建）

通道通过拾取缩放视图投影渲染到一个 **1×1** 目标中，因此每个附件仅为一个纹素：

- **拾取 ID 颜色**：`rgba8unorm`，用途 `RENDER_ATTACHMENT | COPY_SRC` —— 24 位 ID。
- **深度颜色**：`r32float`，用途 `RENDER_ATTACHMENT | COPY_SRC` —— 片元的 NDC 深度，写入到 `@location(1)`（作为颜色附件以便使用 `COPY_SRC` 回读）。
- **详情颜色（仅激活时）**：`rgba32uint`，用途 `RENDER_ATTACHMENT | COPY_SRC` —— 图元索引加上经 bitcast 编码的局部位置。
- **深度缓冲区**：`depth24plus`，用途 `RENDER_ATTACHMENT` —— 实际的深度测试（反向 Z，清除为 `0`，比较函数为 `greater`）；不进行复制。
- **暂存缓冲区**：可复用的 256 字节（`MAP_READ | COPY_DST`）缓冲区，用于 ID、深度和可选详情。256 字节是 `copyTextureToBuffer` 所需的最小 `bytesPerRow`。

### 顶点布局

- 默认紧凑常规/薄实例路径：单个位置 `float32x3` 缓冲区，步长 12，着色器位置 0。
- 带有 `vertexData` 的丢弃规则会添加一个缓存的常规网格管线变体，在着色器位置 5 处包含第二个缓冲区。其格式遵循上表，而紧凑或交错步长/偏移量来自网格。仅当当前网格拥有该属性时才选择该变体；否则仅位置变体提供零值。
- 即使没有 `vertexData`，交错常规和薄实例位置也使用缓存的位置布局变体。
- 默认紧凑拾取或薄实例不绑定额外缓冲区。

### 绑定组

**常规网格：**

| 组 | 绑定 | 类型 | 内容 |
| ----- | ------- | ------- | ---------------------------------------------------------------------------------- |
| 0 | 0 | uniform | `mat4x4f` viewProjection + `vec2f` 原始片元坐标（共享，80 字节） |
| 1 | 0 | uniform | `mat4x4f` world + `u32` pickId（80 字节，16 字节对齐） |

**薄实例网格：**

| 组 | 绑定 | 类型 | 内容 |
| ----- | ------- | ----------------- | ----------------------------------------------------------------------------------- |
| 0 | 0 | uniform | `mat4x4f` viewProjection + `vec2f` 原始片元坐标（共享，80 字节） |
| 1 | 0 | uniform | `mat4x4f` 网格 world + `u32` baseMeshPickId + `u32` excludedThinInstance（80 字节） |
| 1 | 1 | read-only-storage | `array<mat4x4f>` —— 实例世界矩阵 |

**丢弃/世界空间调整存储：**

Group 2 包含调用者提供的只读存储绑定。绑定默认对片元阶段可见；`PickDiscardStorage.vertex: true` 会额外仅将该绑定暴露给顶点阶段的世界空间调整钩子。

### 深度/模板

- 格式：`depth24plus`
- 比较函数：`greater`（反向 Z；深度清除为 `0`）
- 写入：启用
- 无模板

### 图元状态

- 拓扑：`triangle-list`
- 剔除模式：`none`（匹配双面 `Scene.pick` 相交语义）
- 正面：`ccw`
- 多重采样数：`1`（无 MSAA —— 需要精确的像素 ID 匹配）

### 管线缓存

- 通过 `device !== _cachedDevice` 失效模式按设备缓存。
- 每组均由同一着色器所有者生成常规仅位置变体和薄实例变体。
- 仅当设备特性激活时才创建详细变体组，并包含第三个附件。
- 常规顶点数据和交错位置变体缓存在 `picking-pipeline.ts` 中。
- 缓存键包含规则标识、存储阶段可见性、详细/基础模式、所选属性以及位置/数据步长和偏移量。当 WGSL 或语义布局更改时，调用者仍须更改 `PickDiscardRule.key`。

## 着色器逻辑（WGSL）

```wgsl
// Detailed variants begin with:
enable primitive_index;

// Vertex — regular mesh
@vertex fn vs(@location(0) pos: vec3f) -> VsOut {
    let baseWorld = (mesh.world * vec4f(pos, 1.0)).xyz;
    let wp = adjustPickWorld(PickWorldInput(...));
    out.p = scene.viewProjection * vec4f(wp, 1.0);
    out.localPos = pos; // detailed variants
}

// Optional discard-data variant (example: tangent; other attributes are padded to vec4f).
@vertex fn vsWithData(@location(0) pos: vec3f,
                      @location(5) tangent: vec4f) -> VsOut {
    // world/pick fields omitted here; vertexData is forwarded flat.
    out.vertexData = tangent;
}

// Vertex — thin instances (packed w lanes are payload, not transform)
@vertex fn vsTI(@location(0) pos: vec3f,
                @builtin(instance_index) iid: u32) -> VsOut {
    let packed = instances[iid];
    let instanceWorld = mat4x4f(
        vec4f(packed[0].xyz, 0.0),
        vec4f(packed[1].xyz, 0.0),
        vec4f(packed[2].xyz, 0.0),
        vec4f(packed[3].xyz, 1.0));
    let world = tiMesh.world * instanceWorld;
    out.excluded = select(0u, 1u, iid == tiMesh.excludedThinInstance);
    // adjustPickWorld + projection as above
}

// Fragment — ID, NDC depth, and optional exact detail.
struct FsOut {
    @location(0) color: vec4f,
    @location(1) depth: f32,
    @location(2) detail: vec4u,
}
@fragment fn fs(input: VsOut,
                @builtin(primitive_index) primitiveIndex: u32) -> FsOut {
    if (input.excluded != 0u) { discard; }
    let r = f32((pickId >> 16u) & 0xFFu) / 255.0;
    let g = f32((pickId >> 8u)  & 0xFFu) / 255.0;
    let b = f32(pickId & 0xFFu) / 255.0;
    return FsOut(
        vec4f(r, g, b, 1.0),
        input.p.z,
        vec4u(primitiveIndex,
              bitcast<u32>(input.localPos.x),
              bitcast<u32>(input.localPos.y),
              bitcast<u32>(input.localPos.z)));
}
```

## 生命周期

1. **创建**：`createGpuPicker(scene)` → 纯状态；渲染目标在首次拾取时分配。
2. **启用详情**（可选）：`enableDetailedPicking(picker)` → 仅当已创建的设备具备 `"primitive-index"` 时设置 `_detailedPicking`。
3. **拾取**：`pickAsync(picker, x, y, options?)` →
    - 对网格 ID 范围拍快照，将网格、然后 `scene._pickSources` 绘制到共享的 1×1 通道中
    - 读取 ID + 深度（+ 激活时的精确详情），从快照解析，并重建像素中心的世界坐标点
    - 对于详细网格命中，根据精确的 GPU 图元/局部点推导重心坐标和法线
4. **销毁**：`disposePicker(picker)` → 销毁 ID/深度/详情目标、暂存缓冲区、场景 UBO 及每个贡献者的 GPU 状态。

## Babylon.js 等价映射

| BJS API | Babylon Lite |
| ------------------------------------- | ------------------------- |
| `scene.pick(x, y)` | `pickAsync(picker, x, y)` |
| `pickingInfo.hit` | `info.hit` |
| `pickingInfo.pickedMesh` | `info.pickedMesh` |
| `pickingInfo.pickedPoint` | `info.pickedPoint` |
| `pickingInfo.distance` | `info.distance` |
| `pickingInfo.faceId` | `info.faceId` |
| `pickingInfo.bu` | `info.bu` |
| `pickingInfo.bv` | `info.bv` |
| `pickingInfo.thinInstanceIndex` | `info.thinInstanceIndex` |
| `pickingInfo.getNormal()` | `getPickedNormal(info)` |
| `pickingInfo.getTextureCoordinates()` | `getPickedUV(info)` |

## 依赖项

- `../math/types.js` —— `Mat4` 类型
- `../math/invert-mat4.js` —— `invertMat4`
- `../math/multiply-mat4.js` —— 用于详细法线的仿射基础网格 × 薄实例组合
- `./pick-contributor.js` —— `PickContributor` 接缝（可选可拾取实体在此注册）
- `../mesh/mesh.js` —— `Mesh` 接口（CPU 几何字段）
- `../scene/scene.js` —— `SceneContext`（用于相机 + 网格列表）
- `../mesh/thin-instance.js` —— `ThinInstanceData`（矩阵子数组）
- `./deform-picking-projection.js` —— 骨骼/变形顶点投影，使变形/蒙皮拾取在 GPU 上变形
- `./deformed-vertex.js` —— 用于详细面法线的 O(1) 单顶点/三角形 CPU 变形
- `../material/pbr/fragments/vat-fragment.js` —— 由可见着色器和拾取着色器共享的材质持有 VAT 投影

## 测试规范

当前已由单元测试（`picking-discard-api`、`pick-sprite-2d`、`billboard-pick`）以及一致性测试场景 113-115、117、118、129（真实 WebGPU）覆盖。以下用例列举了预期覆盖范围。

### 单元测试

- **拾取 ID 编码往返**：将 u32 编码 → RGB 浮点 → RGBA8 回读 → 解码 u32 = 原始值。
- **世界空间调整着色器钩子**：默认恒等变换；自定义 WGSL 在常规/薄实例着色器中精确注入一次；常规网格接收非实例哨兵值，薄实例接收打包的额外数据 + `instanceIndex`。
- **丢弃顶点数据**：每个受支持的属性均生成正确的第二缓冲区布局和 WGSL 填充；带有该缓冲区的常规网格以 flat 方式转发它，不带该缓冲区的常规网格及所有薄实例提供零值；默认规则保留仅位置布局。
- **交错拾取布局**：常规/薄实例位置和请求的丢弃属性使用网格记录的步长/偏移量；占位 UV 缓冲区不被视为真实属性。
- **图元特性门控**：引擎设备特性仅在具有 `"primitive-index"` 时激活详细模式；不支持的设备保持基础模式（两个附件）且无 CPU 三角形搜索回退。
- **精确 GPU 详情**：详细着色器启用 `primitive_index` 并打包图元/局部点；回读为基础、世界空间调整及薄实例网格填充面/重心/法线数据。
- **异步 ID 快照**：暂存缓冲区映射期间的可见性/顺序变更不能重新映射获胜 ID。
- **忽略标识**：完整网格忽略不消耗 ID；单个薄实例忽略将精确的排除索引写入 UBO。
- **打包薄实例额外数据**：非零矩阵 `w` 载荷通道不会破坏详细世界法线。
- **变形详情**：变形/蒙皮拾取在拾取顶点着色器中变形；详细结果在变形后的三角形上插值静止空间局部位置，并从 O(1) CPU 变形的三角形顶点推导面法线。
- **VAT 投影**：常规/薄实例、纹理/StorageBuffer、4/8 骨骼变体复用可见 VAT 变形和绑定组 3，而不改变仿射拾取器布局。
- **射线反投影**：在画布中心使用单位 VP 调用 `createPickingRay` 应生成 Z 轴向前射线。
- **重心插值**：已知面法线/UV + 已知 `bu`/`bv` → 预期插值结果。

### 集成测试（WebGPU，一致性测试套件）

- **单网格拾取**：创建球体，在中心拾取 → `hit=true`，`pickedMesh` 匹配，`distance > 0`。
- **背景未命中**：在无网格的角落拾取 → `hit=false`。
- **多网格**：两个网格，分别拾取 → 识别出正确的网格。
- **薄实例**：带有薄实例的网格，拾取特定实例 → 正确的 `thinInstanceIndex`。
- **详细拾取**：当适配器暴露 `"primitive-index"` 时，验证引擎创建请求了该特性、详细模式处于激活状态，且球体拾取返回精确的 `faceId`（`bu + bv <= 1`）；否则验证详细模式保持未激活。
- **世界空间调整详情**：位移后的球体在受支持设备上仍返回正命中，并具有位移后的深度/点及精确的 faceId。
- **深度精度**：拾取已知距离的网格 → `info.distance` 在预期值的 1% 以内。

## 文件清单

| 文件 | 职责 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `picking-info.ts` | `PickingInfo` 接口 + `createEmptyPickingInfo` |
| `ray.ts` | `Ray` 接口 + `createPickingRay` |
| `gpu-picker.ts` | GPU ID/深度/详情通道、快照解析、详细表面解码、忽略处理 |
| `pick-contributor.ts` | `PickContributor` 接缝 —— 可选的可拾取实体（GS、公告牌）在此注册 |
| `gs-picking-pipeline.ts` | GS 拾取管线（由 GS 拾取贡献者惰性导入） |
| `billboard-pick-pipeline.ts` | 公告牌拾取管线（由公告牌拾取贡献者惰性导入） |
| `deform-picking-projection.ts` | 惰性骨骼/变形拾取投影；复用渲染路径的蒙皮/变形 WGSL |
| `deformed-vertex.ts` | 单个顶点/三角形的 O(1) CPU 变形（热点、详细面法线） |
| `picking-pipeline.ts` | 统一缓存所有网格拾取变体的管线/布局所有者 |
| `picking-shader.ts` | 基础/详细、常规/薄实例、数据/调整变体的统一 WGSL 生成器 |
| `vat-picking-pipeline.ts` | 惰性 VAT 投影布局/绑定；复用 VAT 材质 WGSL |
| `detailed-picking.ts` | `enableDetailedPicking` 门控 + 惰性精确图元详情解码器 |
| `picking-helpers.ts` | `getPickedNormal`、`getPickedUV` —— 重心插值 |
