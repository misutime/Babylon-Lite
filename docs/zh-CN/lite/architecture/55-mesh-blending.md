# 模块：网格混合（Mesh Blending）

> 包路径：`packages/babylon-lite/src/mesh/`、`packages/babylon-lite/src/frame-graph/`、`packages/babylon-lite/src/material/`、`packages/babylon-lite/src/post-process/`

## 用途

网格混合是一种可选的、单帧的、屏幕空间 SceneColor 后处理效果，用于柔化独立渲染网格之间可见的交接边缘。它不会修改顶点、法线、深度、光照、阴影贴图、碰撞数据、材质或场景所有权。该效果消费以下输入：

- 已渲染的 SceneColor 纹理；
- 单采样的 `r8uint` 几何附件，其中包含每个可见片元对应的打包网格混合标签；
- 有符号视图空间 Z 或硬件屏幕深度；
- 可选的线性反照率/基础颜色附件，仅用于阴影差异衰减；
- 由网格混合任务自有的确定性空间蓝噪声纹理。

该实现是 Babylon.js 网格混合的仅 WebGPU 移植版本。它保留了 Babylon.js 的标签编码、默认值、质量变体、搜索与校验数学、插值行为、调试模式、直通规则以及任务所有权，同时将全屏坐标适配到 Babylon Lite 的左上角原点后处理 UV 约定。

该特性完全按需启用：

- 无关场景不会导入网格混合任务、着色器、蓝噪声生成器或几何标签辅助函数；
- 没有任何模块在导入时分配 `Map`、`Set`、`WeakMap`、GPU 资源或其他状态；
- 唯一的通用运行时更改是一个普通的可选网格状态字段以及一个新的惰性几何附件枚举值/访问器；
- 所有网格混合 GPU 资源归创建的任务所有，并针对当前设备重建。

## 公共 API 接口

所有公共导出仅从 `packages/babylon-lite/src/index.ts` 重新导出。

### 网格标签 API

```ts
export enum MeshBlendingRadiusClass {
    Small = 0,
    Medium = 1,
    Large = 2,
    ExtraLarge = 3,
}

export interface MeshBlendingTag {
    readonly groupId: number;
    readonly radiusClass: MeshBlendingRadiusClass;
}

export function packMeshBlendingTag(groupId: number, radiusClass: MeshBlendingRadiusClass): number;
export function unpackMeshBlendingTag(tag: number): MeshBlendingTag;
export function validatePackedMeshBlendingTag(tag: number): number;
export function resolveMeshBlendingTag(mesh: Mesh): number;
```

`Mesh` 新增字段：

```ts
export interface Mesh {
    /**
     * Packed mesh-blending tag. Undefined is equivalent to zero/disabled.
     * Bits 0..5 are the group and bits 6..7 are the radius class.
     */
    meshBlendingTag?: number;
}
```

标签规则：

- `groupId` 是 `0` 到 `63` 之间的整数。
- `radiusClass` 是 `0` 到 `3` 之间的整数。
- 打包公式为 `(radiusClass << 6) | groupId`。
- `groupId === 0` 始终打包为精确的 `0`。
- 合法的打包值为 `0`，或低六位非零的无符号字节。
- `64`、`128` 和 `192` 是非法的，因为它们用非零半径等级编码了组 0。
- 相同的非零组之间绝不混合。
- 当两个组相遇时，较小的半径等级胜出。
- 薄实例使用拥有该薄实例绘制的网格的标签。
- Lite 克隆体是独立网格，拥有独立的标签。
- 几何渲染在上传前校验解析出的原始字节。

### 几何渲染器扩展

`GeometryTextureType` 新增：

```ts
MESH_BLEND_TAG = 11;
```

`GEOMETRY_TEXTURE_DESCRIPTIONS[GeometryTextureType.MESH_BLEND_TAG]` 为：

```ts
{
    name: "MeshBlendTag",
    defaultFormat: "r8uint",
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
}
```

`GeometryRendererTask` 新增：

```ts
readonly geometryMeshBlendTagTexture: RenderTarget | null;
```

几何标签不变量：

- 请求 `MESH_BLEND_TAG` 的任务必须使用 `samples: 1`；
- 标签附件格式精确为 `r8uint`；覆写为任何其他格式会抛出异常；
- 标签可以占据任意 MRT 颜色槽位；
- 完整 MRT 仍限制为最多八个颜色附件；
- 其清除值为精确的无符号整数 0；
- 其管线目标没有混合状态；
- 所有其他附件保留其现有的几何混合行为；
- 默认包含透明网格；调用方可以传入过滤后的 `meshes` 数组以仅生成不透明标签；
- Standard 与 PBR 的 alpha 测试几何保留丢弃覆盖，但混合后的透明标签仍依赖顺序，并可能用零覆写底层标签；
- 通过 `setMeshOpacity` 淡出的镂空物体在经不透明度调整后的 `alpha <= 0.4` 时不输出标签：仅几何丢弃会在标签/数据写入之前运行，同时抑制该采样额外的发射颜色槽；
- alpha 混合几何附件必须使用可混合格式；32 位浮点附件需要 `float32-blendable`，因此不具备该特性的调用方应将 `VIEW_DEPTH` 覆写为 `r16float` 或传入过滤后的网格列表；
- PBR、Standard 和 Node 几何管线创建通过 `_geometryColorTarget` 校验混合目标，包括已安装标签扩展时；在缺少所需特性的情况下，混合 32 位浮点附件会在管线创建前抛出既有的 `Transparent geometry output format "${format}" requires the float32-blendable WebGPU feature or a blendable format override.` 错误，而 `r8uint` 标签目标保持非混合；
- 当请求 `MESH_BLEND_TAG` 时，透明 Node 材质会被拒绝，因为计算图的片元 alpha 对几何终端不可用；调用方必须将其过滤掉；
- 常规透明 Node 几何始终对数据附件使用不透明度/替换混合，即使前向材质使用加法颜色混合也是如此；
- 重叠透明层仍由调用方控制，网格混合不会使其变为顺序无关。

### 网格混合配置

```ts
export enum MeshBlendQuality {
    Low = 0,
    Medium = 1,
    High = 2,
    Cinematic = 3,
}

export enum MeshBlendDepthType {
    View = 0,
    Screen = 1,
}

export enum MeshBlendDebugMode {
    Off = 0,
    PackedTag = 1,
    CandidateDirectionDistance = 2,
    SeamFade = 3,
    RejectionReason = 4,
    StageWork = 5,
    Continuation = 6,
    TinyObject = 7,
    MultiTarget = 8,
    TargetColor = 9,
    ShadowAttenuation = 10,
    ColorInterpolation = 11,
    WorldPosition = 12,
}

export interface MeshBlendRadiusDefinition {
    worldRadius: number;
    minimumProjectedRadius: number;
}

export type MeshBlendRadiusDefinitions = readonly [MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition];

export function createMeshBlendRadiusDefinition(worldRadius: number, minimumProjectedRadius: number): MeshBlendRadiusDefinition;
export function createDefaultMeshBlendRadiusDefinitions(): MeshBlendRadiusDefinitions;
```

每个半径定义均独立分配，并暴露带校验的可变设置器。两个值都必须为有限非负数。返回的四元素定义数组被冻结，而其四个元素仍可修改。

精确默认值：

| 等级 | `worldRadius` | `minimumProjectedRadius` |
| --- | ---: | ---: |
| Small | `0.06` | `1.5` |
| Medium | `0.1` | `3` |
| Large | `0.2` | `3` |
| ExtraLarge | `0.3` | `5` |

### 帧图任务

```ts
export interface MeshBlendingPostProcessTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    meshBlendTagTexture: RenderTarget;
    depthTexture: RenderTarget;
    baseColorTexture?: RenderTarget | null;
    targetTexture?: RenderTarget | null;
    camera: Camera;
    quality?: MeshBlendQuality;
    depthType?: MeshBlendDepthType;
    debugMode?: MeshBlendDebugMode;
    radiusClasses?: readonly MeshBlendRadiusDefinition[];
    slopeFactor?: number;
    enabled?: boolean;
    alphaMode?: PostProcessAlphaMode;
    viewport?: NormalizedViewport | null;
    clear?: boolean;
}

export interface MeshBlendingPostProcessTask extends Task {
    readonly name: string;
    sourceTexture: RenderTarget;
    meshBlendTagTexture: RenderTarget;
    depthTexture: RenderTarget;
    baseColorTexture: RenderTarget | null;
    targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    camera: Camera;
    quality: MeshBlendQuality;
    depthType: MeshBlendDepthType;
    debugMode: MeshBlendDebugMode;
    readonly radiusClasses: MeshBlendRadiusDefinitions;
    slopeFactor: number;
    enabled: boolean;
    alphaMode: PostProcessAlphaMode;
    viewport: NormalizedViewport | null;
    clear: boolean;
    updateUniforms(): void;
}

export function createMeshBlendingPostProcessTask(config: MeshBlendingPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): MeshBlendingPostProcessTask;
```

默认值：

- `quality = MeshBlendQuality.Medium`；
- `depthType = MeshBlendDepthType.View`；
- `debugMode = MeshBlendDebugMode.Off`；
- `radiusClasses = createDefaultMeshBlendRadiusDefinitions()`；
- `slopeFactor = 2`；
- `enabled = true`；
- `alphaMode = 0`；
- `viewport = null`；
- `clear = true`；
- `baseColorTexture = null`；
- `targetTexture = null`，将创建一个与源格式和尺寸匹配的任务自有单采样目标。

校验：

- 枚举值必须是已定义的枚举成员；
- `slopeFactor` 必须为有限数且至少为 `1`；
- 精确接受四个半径定义；
- 所有输入颜色附件均为 2D 且单采样；
- 源、标签、深度、可选基础颜色与输出具有完全相同的物理维度；
- 源/输出格式为支持渲染附件和纹理加载的非整数 RGB/RGBA 格式，包括无符号字节、半精度浮点及浮点 HDR 格式；
- 标签格式精确为 `r8uint`；
- 视图深度为浮点/半精度浮点 `r`、`rg` 或 `rgba` 颜色格式；
- 屏幕深度接受上述格式以及规范化无符号字节颜色格式；
- 没有任何采样输入（源、标签、深度或可选基础颜色）可与输出形成别名，包括围绕同一个 GPU 纹理的不同包装器；
- 混合的 `rgba32float` 输出需要 WebGPU `float32-blendable` 特性；
- 调用方自有的输入与目标绝不由任务销毁。

运行时变更：

- 半径值、`slopeFactor`、`enabled`、相机矩阵及视口为 uniform/运行时状态，不改变着色器变体；
- 质量、深度类型、调试模式、基础颜色存在性、源/标签/深度标识、目标格式、alpha 模式以及替换 GPU 设备会使相应的管线/绑定组状态失效；
- 当 `alphaMode === 0` 时，设置 `enabled = false` 保留精确的 SceneColor 纹素直通；
- 非零 `alphaMode` 刻意将调用方选择的后处理混合状态同时应用于启用与禁用两种输出。

## 内部架构

### 文件

```text
packages/babylon-lite/src/mesh/mesh-blending-tag.ts
packages/babylon-lite/src/frame-graph/geometry-mesh-blending.ts
packages/babylon-lite/src/post-process/mesh-blending-blue-noise.ts
packages/babylon-lite/src/post-process/mesh-blending-wgsl.ts
packages/babylon-lite/src/post-process/mesh-blending.ts
```

扩展的现有文件：

```text
packages/babylon-lite/src/mesh/mesh.ts
packages/babylon-lite/src/frame-graph/geometry-types.ts
packages/babylon-lite/src/frame-graph/geometry-renderer-task.ts
packages/babylon-lite/src/material/standard/standard-geometry-output-shader.ts
packages/babylon-lite/src/material/standard/standard-geometry-renderable.ts
packages/babylon-lite/src/material/pbr/pbr-geometry-output-shader.ts
packages/babylon-lite/src/material/pbr/pbr-geometry-renderable.ts
packages/babylon-lite/src/material/node/node-geometry-renderable.ts
packages/babylon-lite/src/post-process/mesh-blending-pbr-support.ts
packages/babylon-lite/src/index.ts
```

### Tree-shaking 与状态

- 标签打包/解包/默认值/数学辅助函数均为纯函数。
- 仅当调用网格混合工厂函数时才生成蓝噪声 CPU 数据。
- 蓝噪声模块没有模块级缓存。
- 任务拥有其蓝噪声 `GPUTexture`、视图、uniform 缓冲区、着色器模块、绑定组布局、绑定组、管线布局、管线以及可选内部输出目标。
- 任务在其公共接口中不存储任何 GPU 句柄。
- 着色器源码生成返回一个字符串且不包含 GPU 状态。
- 创建网格混合任务会安装类型化几何输出扩展以及兼容 Babylon.js 的 PBR 非一致法线（non-uniform-normal）片元。该扩展在未请求 `MESH_BLEND_TAG` 的几何组合之外保持惰性，因此前向渲染与无关几何任务保持不变。注册发生在后处理任务构造之后、帧图预加载之前；实现位于 `geometry-mesh-blending.ts`。
- Standard、PBR 和 Node 几何可渲染对象通过该可选扩展解析并校验原始网格标签，而不静态导入 `mesh-blending-tag.ts`。
- 几何渲染器已经惰性加载 Standard、PBR 和 Node 材质族桥接，并将请求的附件列表传递到它们的几何视图。
- 普通几何打包仅保留微小的可空扩展接缝；在启用网格混合前，标签辅助函数、类型化输出实现、蓝噪声、搜索着色器及非一致 PBR 修正均不存在。打包场景 145-149 经验证不大于其精确的 public-master 基线。

### 任务内部状态

具体任务包含：

```ts
interface MeshBlendingPostProcessTaskInternal extends MeshBlendingPostProcessTask {
    _internalTarget: RenderTarget | null;
    _internalTargetKey: string;
    _device: GPUDevice | null;
    _compiledQuality: MeshBlendQuality | -1;
    _compiledDepthType: MeshBlendDepthType | -1;
    _compiledDebugMode: MeshBlendDebugMode | -1;
    _compiledHasBaseColor: boolean | null;
    _compiledOutputFormat: GPUTextureFormat | null;
    _compiledSourceFormat: GPUTextureFormat | null;
    _compiledDepthFormat: GPUTextureFormat | null;
    _compiledBaseColorFormat: GPUTextureFormat | null;
    _compiledAlphaMode: PostProcessAlphaMode | -1;
    _uniformBuffer: GPUBuffer | null;
    _uniformData: Float32Array;
    _blueNoiseTexture: GPUTexture | null;
    _blueNoiseView: GPUTextureView | null;
    _shaderModule: GPUShaderModule | null;
    _bindGroupLayout: GPUBindGroupLayout | null;
    _pipelineLayout: GPUPipelineLayout | null;
    _pipeline: GPURenderPipeline | null;
    _bindGroup: GPUBindGroup | null;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment;
    _boundSource: GPUTexture | null;
    _boundTag: GPUTexture | null;
    _boundDepth: GPUTexture | null;
    _boundBaseColor: GPUTexture | null;
    _validatedSource: GPUTexture | null;
    _validatedTag: GPUTexture | null;
    _validatedDepth: GPUTexture | null;
    _validatedBaseColor: GPUTexture | null;
    _validatedOutput: GPUTexture | null;
    _validatedWidth: number;
    _validatedHeight: number;
    _validatedDepthType: MeshBlendDepthType | -1;
    _validatedAlphaMode: PostProcessAlphaMode | -1;
}
```

GPU 状态在 `record()` 中惰性创建并在 `execute()` 中重新校验。如果 `engine._device` 发生变更：

1. 销毁或丢弃陈旧的缓冲区/纹理句柄；
2. 清除所有绑定组/管线/模块引用；
3. 将确定性的 CPU 噪声上传到新的当前设备纹理；
4. 重新绑定当前输入视图；
5. 重新编译当前变体。

任务绝不会从可执行状态中保留任何陈旧旧设备句柄的可达性。

### Uniform 布局

一个 256 字节的 uniform 缓冲区按 64 个 `f32` 值写入：

| 浮点范围 | 值 |
| --- | --- |
| `0..15` | 投影矩阵 |
| `16..31` | 逆投影矩阵 |
| `32..47` | 逆视图矩阵 |
| `48..51` | 世界半径 Small..ExtraLarge |
| `52..55` | 最小投影半径 Small..ExtraLarge |
| `56` | `meshBlendIsOrthographic`，`1` 或 `0` |
| `57` | `slopeFactor` |
| `58` | `enabled`，`1` 或 `0` |
| `59` | 保留零值 |
| `60..61` | 源相机视口原点（像素） |
| `62..63` | 源相机视口尺寸 |

投影和逆投影从任务相机与源附件尺寸计算得出，包含相机视口的有效纵横比。源相机视口按与几何渲染 Pass 相同的 floor/ceil 规则打包；重建将全附件像素映射到该整数视口中，投影世界半径计算使用其像素高度。该源视口独立于可选的后处理输出视口。对于普通变体，`inverseView` 范围保持为零，仅针对 WorldPosition 调试变体才计算并写入。当引擎使用浮动原点时，其平移清零以匹配几何生产者的有效渲染视图，包括不带相机局部浮动原点标志的覆写相机。正交状态为 `camera.ortho ? 1 : 0`。

### 蓝噪声

`createMeshBlendingBlueNoiseData()` 返回一个确定性的 `128 * 128 * 2` 字节 `Uint8Array`。

对两个通道中的每一个：

1. 分别使用种子 `0x68bc21eb`（R）和 `0x2f6e2b1d`（G）生成整数哈希白噪声；
2. 减去八个环形（toroidally wrapped）邻域采样的平均值；
3. 按高通值对像素索引排序，平局时按像素索引打破；
4. 赋值字节 `floor(rank * 256 / 16384)`。

这在每个通道中保留了精确均匀的字节直方图，同时将低频能量分布到高空间频率中。任务将结果上传至：

```ts
{
    size: [128, 128, 1],
    format: "rg8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    mipLevelCount: 1,
    sampleCount: 1,
}
```

着色器手动环绕整数像素坐标，不使用时间/帧索引。因此噪声图案是确定性且空间稳定的。

## 几何管线集成

### 逐网格数据

当几何视图请求 `MESH_BLEND_TAG` 时，CPU 在不增大现有 UBO 布局的情况下解析并校验源网格的打包字节。Standard 与 PBR 将标签存储在现有无符号光照计数字（light-count word）的 8-15 位；光照屏蔽低八位计数，而几何输出读取 `mesh.lc >> 8u`。Node 几何将标签存储在 `meshU.receivesShadow.x` 中，该槽位在此无阴影输入的几何路径中未被使用。前向可渲染对象保持不变。

### Standard 材质几何输出

Standard 几何视图继续组合完整的 Standard 着色器，保留：

- 漫反射/不透明度/凹凸纹理；
- 材质 alpha；
- alpha 截断/丢弃；
- 骨骼；
- 变形目标；
- 顶点颜色与顶点 alpha；
- 常规与薄实例；
- 所有现有 UV 与变换行为。

`FragmentOutput` 按附件生成：

```wgsl
struct FragmentOutput {
    // float attachment
    @location(N) fN: vec4<f32>,

    // mesh tag attachment
    @location(M) meshBlendTagM: u32,
}
```

对于启用 alpha 测试的变体，所有到达返回点的片元都通过了现有的 discard，因此标签写入原始源标签。对于非 alpha 测试变体：

```wgsl
out.meshBlendTagM = select(0u, mesh.lc >> 8u, alpha > 0.4);
```

所有现有的浮点附件写入保持不变。

### PBR 材质几何输出

PBR 几何视图继续组合完整的 PBR 着色器，保留：

- 金属度/粗糙度与高光工作流；
- alpha 截断/丢弃；
- 骨骼、变形、顶点颜色与薄实例；
- 法线、清漆、光泽、各向异性、虹彩、次表面、自发光、阴影、IBL 及现有插件片元。

类型化输出规则与 Standard 一致。启用 alpha 测试的 PBR 变体在现有 discard 之后写入原始标签。其他变体除非最终材质 alpha 大于 `0.4`，否则写入零。

PBR 调试/辅助浮点写入绝不寻址到整数附件。

### Node 材质几何输出

Node 几何视图继续从 `GeometryTextureOutputBlock` 重新生成计算图；不引入单独的简化材质渲染器。现有的计算图 discard 逻辑在返回块之前运行。几何输出构建器：

- 仅针对 `MESH_BLEND_TAG` 生成 `u32`；
- 对所有现有几何附件类型生成 `vec4<f32>`；
- 复用几何 Pass 的 `meshU.receivesShadow.x` 槽位而不增大网格 UBO；
- 为存活片元写入经过校验的源网格标签。

该标签由引擎控制，不作为 `GeometryTextureOutputBlock` 的图输入暴露。

无论材质的前向 alpha 模式为何，透明 Node 几何均使用与 Standard 和 PBR 几何输出相同的不透明度/替换混合状态。加法前向混合绝不会拷贝到几何数据附件，因为这会把深度、位置和法线值数值相加到先前内容上。

### 管线颜色目标

对于每个附件格式：

```ts
format === "r8uint" ? { format } : { format, blend: existingGeometryBlendState };
```

渲染 Pass 以精确零值清除整数附件。这允许 `r8uint` 与浮点/规范化无符号整数附件共处于任意槽位中，而不为整数目标指定浮点混合状态。

## 网格混合着色器

### 绑定

着色器仅使用 `textureLoad`；没有采样器。

无基础颜色时：

| 绑定 | WGSL 类型 | 资源 |
| ---: | --- | --- |
| 0 | `texture_2d<f32>` | 源 SceneColor |
| 1 | `texture_2d<u32>` | 网格标签 |
| 2 | `texture_2d<f32>` | 深度 |
| 3 | `texture_2d<f32>` | 蓝噪声 |
| 4 | uniform buffer | 网格混合 uniform |

带基础颜色时：

| 绑定 | WGSL 类型 | 资源 |
| ---: | --- | --- |
| 0 | `texture_2d<f32>` | 源 SceneColor |
| 1 | `texture_2d<u32>` | 网格标签 |
| 2 | `texture_2d<f32>` | 深度 |
| 3 | `texture_2d<f32>` | 线性基础颜色 |
| 4 | `texture_2d<f32>` | 蓝噪声 |
| 5 | uniform buffer | 网格混合 uniform |

缺乏基础颜色会生成一个不包含基础颜色声明、加载、字段或阴影估计计算的着色器变体。

### 全屏约定

全屏三角形使用 Lite 标准的左上角 UV：

```wgsl
out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
```

像素坐标：

```wgsl
renderSize = textureDimensions(depthTexture, 0);
pixel = clamp(vec2<i32>(floor(uv * vec2<f32>(renderSize))), vec2<i32>(0), vec2<i32>(renderSize) - 1);
pixelUv = (vec2<f32>(pixel) - sourceViewport.xy + 0.5) / sourceViewport.zw;
```

`sourceViewport` 包含源相机的整数光栅原点和尺寸，而非可独立配置的后处理输出视口。由于 UV Y 向下递增，重建使用：

```wgsl
ndcXY = vec2<f32>(pixelUv.x * 2.0 - 1.0, 1.0 - pixelUv.y * 2.0);
```

Babylon.js 的后处理着色器在自底向上的像素坐标系中评估算法。为了在 Lite 按自顶向下存储渲染目标行的同时保留精确的确定性图案，移植版将候选/调试方向保留在 Babylon.js 算法空间中，并仅在纹理访问边界进行转换：

```wgsl
algorithmPixel = vec2<i32>(pixel.x, renderSize.y - 1 - pixel.y);
pixelOffset = round(vec2<f32>(direction.x, -direction.y) * distancePixels);
```

蓝噪声使用 `algorithmPixel` 索引。候选方向、细化角度与调试方向颜色与 Babylon.js 保持一致；每次搜索、延续、目标颜色与反向纹理偏移均使用 `pixelOffset`。若缺少这两处转换中的任一处，同一显示像素就会读取另一行蓝噪声并探测垂直镜像的候选位置。

### 编译期质量常量

| 质量 | 方向数 | 径向采样 | 方向采样 | 方向步数 | 精确边缘 | 半径缩放 | 旋转 | 抖动 | 回退 | 极小物体 | 次目标 | 插值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- | --- |
| Low | 3 | 2 | 1 | 2 | 5 | `0.50` | 8 步量化 | `0.5` | 否 | 否 | 否 | sRGB |
| Medium | 3 | 3 | 2 | 4 | 8 | `0.90` | 8 步量化 | `0.5` | 否 | 否 | 否 | OKLab |
| High | 3 | 3 | 3 | 5 | 10 | `1.00` | 连续 | `0.5` | 是 | 是 | 是 | OKLab |
| Cinematic | 8 | 6 | 4 | 5 | 50 | `0.95` | 连续 | `1.0` | 是 | 是 | 是 | OKLab |

质量、深度类型、调试模式与基础颜色存在性通过生成的 WGSL 常量/死分支编码，从而使 WebGPU 仅编译所选变体的循环和可选计算。

### 着色器常量

```text
TWO_PI                            6.283185307179586
EPSILON                           0.00001
REFINEMENT_SECTOR_SCALE           0.2
TINY_OBJECT_PROBE_COUNT           8
MIN_SLOPE_SCALE                   0.25
BOUNDARY_SEPARATION_FACTOR        0.75
BOUNDARY_PIXEL_TOLERANCE          3.0
FOREGROUND_DEPTH_FACTOR           0.35
FOREGROUND_LATERAL_FACTOR         2.0
TARGET_SPAN_FACTOR                1.5
TOTAL_SPAN_FACTOR                 2.5
NEAR_EDGE_TARGET_WEIGHT           0.35
NEAR_SEAM_MAX_DISTANCE            1.25
NEAR_SEAM_COLOR_DELTA             0.02
BASE_LUMINANCE_EPSILON            0.00001
TARGET_DARKER_RATIO               0.65
TARGET_NON_DARK_RATIO             0.9
SHADOW_DIFFERENCE_LOW             0.15
SHADOW_DIFFERENCE_HIGH            0.5
SHADOW_MIN_ATTENUATION            0.25
```

拒绝代码：

```text
0 NONE
1 NO_CANDIDATE
2 NO_CONTINUATION
3 INVALID_DEPTH
4 DEPTH_SEPARATION
5 FOREGROUND_BACKGROUND
6 PHYSICAL_SPAN
7 CONTACT_ANGLE
```

### 着色器结构体

生成的 WGSL 定义：

```text
MeshBlendTag
  groupId: u32
  radiusClass: u32

MeshBlendCandidate
  targetGroupId: u32
  radiusClass: u32
  direction: vec2f
  distancePixels: f32
  searchRadiusPixels: f32
  score: f32
  valid: bool

MeshBlendResult
  candidate: MeshBlendCandidate
  targetPixel: vec2i
  targetFarPixel: vec2i
  currentViewPosition: vec3f
  effectiveRadiusPixels: f32
  fade: f32
  tinyObjectRadiusRatio: f32
  rejectionReason: i32
  stageReached: i32
  valid: bool
  continuationFound: bool
  usedFallback: bool
  tinyObjectRadiusReduced: bool

MeshBlendTargetColorSamples
  fartherColor: vec4f
  boundaryPlusOneColor: vec4f
  boundaryPlusTwoColor: vec4f
  conservativeNearColor: vec4f
  targetColor: vec4f
  fartherBaseColor: vec3f             // base-color variant only
  conservativeNearBaseColor: vec3f    // base-color variant only
  onePixelEdge: bool

MeshBlendColorEvaluation
  samples: MeshBlendTargetColorSamples
  currentColor: vec4f
  blendedColor: vec4f
  worldPosition: vec3f
  shadowAttenuation: f32
  adjustedFade: f32
  nearSeamCorrected: bool
```

### 标签、深度与位置辅助函数

标签解码：

```wgsl
groupId = packed & 0x3fu;
radiusClass = packed >> 6u;
```

等级选择对 0/1/2/3+ 分别使用 x/y/z/w。

所有标签/深度加载都钳制到合法深度维度。因此搜索探测会沿边界发生混叠，唯独延续检查除外——它会拒绝未钳制的越界坐标。

深度重建：

- 屏幕深度直接使用 WebGPU 硬件深度作为 NDC Z。
- 视图深度将 `(0,0,depth,1)` 通过当前投影矩阵投影以获取 NDC Z。
- 位置为 `inverseProjection * vec4(ndcXY, ndcZ, 1)` 后执行齐次除法。
- 反向深度完全由投影/逆投影矩阵处理。
- 位置有效性检查会拒绝指数位全为 `0xff` 的任何分量，涵盖 NaN 与无穷大。
- WorldPosition 调试模式在视图重建之后应用 `inverseView`。

### 半径数学

```text
projectionScale = max(0.5 * renderHeight * abs(projection[1][1]), EPSILON)
viewDepth = abs(viewPosition.z)

perspectiveProjected = worldRadius * projectionScale / max(viewDepth, EPSILON)
orthographicProjected = worldRadius * projectionScale

scaledRadius =
    max(projectedWorldRadius, minimumProjectedRadius) * qualityRadiusScale

searchRadius =
    scaledRadius > 0 ? max(1, scaledRadius) : 0
```

每像素对应的世界单位：

```text
orthographic: 1 / projectionScale
perspective: max(viewDepth, EPSILON) / projectionScale
```

### 候选搜索

蓝噪声值：

```text
algorithmPixel = vec2(pixel.x, renderHeight - 1 - pixel.y)
noisePixel = algorithmPixel % vec2(noiseWidth, noiseHeight)
random = textureLoad(blueNoise, noisePixel, 0).rg
sector = TWO_PI / directionCount
rotation =
    continuous quality ? random.x * sector
                       : floor(random.x * 8) * 0.125 * sector
radialJitter = mix(0.5, random.y, jitterFactor)
```

依次遍历每个径向壳层、然后每个方向：

```text
normalized = (radialIndex + radialJitter) / radialSampleCount
distance = max(1, ceil(normalized^3 * currentRadius))
```

拒绝组 0、当前组以及可选的已忽略次搜索组。候选等级为当前等级与采样等级中的较小者。按该等级重新计算半径，若距离超出该半径则拒绝。

评分：

```text
1 - clamp(distance / max(candidateRadius, EPSILON), 0, 1)
```

严格更大的评分替换当前最佳候选。搜索在产生任意候选的首个径向壳层之后停止。

方向细化：

- 在距离 `<= 2` 时跳过；
- 区间为 `atan2(direction) ± sector * 0.2`；
- 采样随机数为 `fract(random.y + random.x * 0.754877666 + sampleIndex * 0.618033989)`；
- 步长为 `max(1, distance / (stepCount + 1))`；
- 每条细化射线向内步进直至离开目标组。

精确边缘细化每次迭代精确减去 1 像素，并在第一个非目标像素处停止。

### 延续与回退

延续距离：

```text
max(2 * boundaryDistance, boundaryDistance + 1)
```

未钳制的延续坐标必须仍在边界内且属于目标组。目标等级与延续等级会将候选收紧至参与其中的最小等级。

Low 与 Medium 拒绝缺少延续的候选。

High 与 Cinematic 按精确顺序搜索四个正交一像素邻域：

```text
(+1,0), (-1,0), (0,+1), (0,-1)
```

偏好的原始目标组获得 `+1` 评分。允许回退候选在没有延续的情况下通过校验；此时目标 C 与更远目标均等于目标 B。

### 极小物体保护

仅 High/Cinematic：

1. 向目标反方向探测八个距离以找到当前物体的投影厚度；
2. 在原始半径处探测四个正交方向；
3. 仅当存在对侧边界且至少三个正交探测离开当前组时才缩减；
4. 使用：

```text
newRadius = max(candidateDistance, min(originalRadius, max(1, thickness * 1.25)))
```

### 接触校验

坐标：

```text
A = current pixel
B = refined target boundary
E = direction * max(distance - 2, 0)
C = continuation, or B for permitted fallback
```

标签按适用情况必须为 current/current/target/target。重建 A/E/B/C 并拒绝无效位置。

设：

```text
R = candidateRadius * worldUnitsPerPixel
T = 3 * worldUnitsPerPixel
```

当满足以下条件时拒绝：

```text
distance(B,E) > 0.75 * R + T
```

前景/背景拒绝需要同时满足：

```text
abs(abs(B.z) - abs(E.z)) > max(0.35 * R, T)
abs(abs(B.z) - abs(E.z)) > 2 * length((B-E).xy)
```

物理跨度拒绝条件：

```text
distance(B,C) > 1.5 * R + T
distance(A,C) > 2.5 * R + T
```

接触方向：

```text
oppositeFacing = -dot(normalize(A-B), normalize(C-B))
slopeScale =
    slopeFactor <= 1
        ? 1
        : 0.25 + 0.75 * clamp(oppositeFacing,0,1)^(slopeFactor-1)
```

候选距离必须满足 `candidateRadius * slopeScale`。

### 衰减（Fade）

```text
boundaryDistance = max(distance - 0.5, 0)
normalized = clamp(boundaryDistance / max(radius, EPSILON), 0, 1)
inverse = 1 - normalized
fade = mix(inverse^2, inverse, clamp(inverse - 0.75, 0, 1)) * 0.5
```

非正的已接受衰减被视为 `PHYSICAL_SPAN`。

### 目标颜色与近接缝修正

加载：

- 更远/延续目标；
- 距边界更远一像素；
- 更远两像素；
- 仅在阴影估计变体中加载对应的基础颜色。

如果 plus-one 不属于目标组，则直接使用更远目标。否则按 sRGB 亮度选择更暗的有效 plus-one/plus-two 采样并构造：

```text
target = 0.65 * farther + 0.35 * conservativeNear
```

对于距离 `<= 1.25` 的单像素接缝，采样目标反方向一像素。如果它仍在当前组中且满足：

```text
distance(current.rgb, target.rgb) + 0.02 < distance(opposite.rgb, target.rgb)
```

在插值前用对侧 RGBA 替换当前 RGBA。

### 颜色插值

Low 在 sRGB 空间插值再转换回线性空间。

Medium/High/Cinematic 在 OKLab 空间使用标准矩阵进行插值：

```text
linear RGB -> LMS:
[0.4122214708 0.5363325363 0.0514459929]
[0.2119034982 0.6806995451 0.1073969566]
[0.0883024619 0.2817188376 0.6299787005]

cuberoot LMS -> OKLab:
[ 0.2104542553  0.7936177850 -0.0040720468]
[ 1.9779984951 -2.4285922050  0.4505937099]
[ 0.0259040371  0.7827717662 -0.8086757660]

OKLab -> cubed LMS:
l_ = L + 0.3963377774a + 0.2158037573b
m_ = L - 0.1055613458a - 0.0638541728b
s_ = L - 0.0894841775a - 1.2914855480b

LMS -> linear RGB:
[ 4.0767416621 -3.3077115913  0.2309699292]
[-1.2684380046  2.6097574011 -0.3413193965]
[-0.0041960863 -0.7034186147  1.7076147010]
```

使用带符号立方根。不应用色域、负值或 HDR 钳制。Alpha 使用相同的调整后衰减独立插值。

### 可选阴影衰减

基础颜色变体估计：

```text
shadow = luminance(linearToSrgb(rendered)) / luminance(linearToSrgb(base))
```

基础亮度 `<= 0.00001` 时返回 `1`。

```text
difference = abs(fartherShadow - conservativeNearShadow)
mismatch = smoothstep(0.15, 0.5, difference)
targetToCurrent = targetLuminance / max(currentLuminance, 0.00001)
targetNotDark = smoothstep(0.65, 0.9, targetToCurrent)
attenuation = mix(1, 0.25, mismatch * targetNotDark)
adjustedFade = geometricFade * attenuation
```

不会传递任何阴影值；仅缩减衰减量。

### 次目标

High/Cinematic 执行第二次搜索，排除主目标组。如果两个结果均校验通过：

```text
totalDistance = max(primaryDistance + secondaryDistance, EPSILON)
primaryProximity = secondaryDistance / totalDistance
secondaryProximity = primaryDistance / totalDistance
primaryWeight = primaryAdjustedFade * primaryProximity
secondaryWeight = secondaryAdjustedFade * secondaryProximity
```

如果组合权重实质为零，则直通源颜色；否则输出两个独立混合 RGBA 结果的归一化加权平均值。

### 调试模式

所有调试输出均使用 alpha `1`。

半径颜色：

```text
Small      (0.15, 0.55, 1.00)
Medium     (0.15, 0.90, 0.35)
Large      (1.00, 0.65, 0.10)
ExtraLarge (0.95, 0.20, 0.65)
```

1. `PackedTag`：等级颜色乘以 `0.45 + 0.55 * fract(groupId * 0.61803398875)`；组 0 为黑色。
2. `CandidateDirectionDistance`：`(dir.x*0.5+0.5, dir.y*0.5+0.5, 1-distance/radius)`；无效为 `(0.04,0.04,0.04)`。
3. `SeamFade`：四分之一亮度的等级颜色按 `clamp(totalFade*2,0,1)` 插值到白色。
4. `RejectionReason`：接受按斜率比例从蓝 `(0.10,0.55,1.00)` 到绿 `(0.20,1.00,0.25)`；无候选为灰；无延续为紫；无效深度为品红；分离为红；前景/背景为橙；物理跨度为黄；接触角为青。
5. `StageWork`：阶段 1..7 使用藏青、蓝、青、绿青、酸橙绿、琥珀、绿。无效定径深度为 `(0.45,0.1,0.1)`，半径为零为 `(0.2,0.2,0.65)`。
6. `Continuation`：无候选为暗色；因缺少延续被拒绝为品红；回退为黄；否则为绿。
7. `TinyObject`：按保留半径比例从红/橙到蓝，缩减时为全亮度，未变时为 `0.45` 亮度；不支持/无候选为暗色。
8. `MultiTarget`：有效次目标为近白；被拒绝次目标为品红；仅主目标为蓝；无为暗色。
9. `TargetColor`：按 `(pixel.x / 4) % 4` 选择的四像素宽重复列：更远目标、plus-one、plus-two、构造目标。
10. `ShadowAttenuation`：`(1-attenuation, attenuation, nearSeamCorrected ? 1 : 0)`。无基础颜色时衰减为 `1`。
11. `ColorInterpolation`：sRGB 橙 `(1,0.4,0.05)`，OKLab 青 `(0.1,0.75,1)`，强度 `mix(0.35,1,clamp(adjustedFade*2,0,1))`。
12. `WorldPosition`：`fract(worldPosition * 0.1)`。

通用调试背景为 `(0.04,0.04,0.04,1)`。调试 Off 时，所有无效/禁用分支返回精确加载的源纹素。

## 状态机与生命周期

### 创建

1. 校验标量配置并克隆四个任务自有的半径定义。
2. 仅当未提供目标时创建任务自有的内部输出描述符。
3. 分配 CPU uniform 暂存区以及确定性的 CPU 蓝噪声字节。
4. 不分配任何 GPU 资源。

### 录制（Record）

1. 构建当前源/输入/输出渲染目标。
2. 解析物理维度并校验格式/采样/维度契约。
3. 如果源格式/尺寸标识发生变更，原地重配置并重建任务自有的内部目标，保留下游任务使用的已发布 `outputTexture` 对象。
4. 检测设备替换、清除陈旧 GPU 状态，并为新设备重建同一个已发布的内部输出目标。
5. 如果当前设备上不存在蓝噪声，则上传蓝噪声。
6. 生成所选 WGSL 变体。
7. 创建着色器模块、绑定组布局、管线布局、管线、uniform 缓冲区与绑定组。
8. 刷新渲染 Pass 描述符的当前输出视图。

### 执行（Execute）

1. 重新校验源/视图标识，必要时重建绑定组或变体状态。
2. 更新相机/半径/斜率/启用状态 uniform。
3. 应用输出视口/裁剪矩形与清除/加载状态。
4. 绘制一个全屏三角形。
5. 返回一次绘制调用。

### 销毁（Disposal）

- 销毁任务自有的 uniform 缓冲区与蓝噪声纹理；
- 仅销毁任务自有的内部输出目标；
- 清除管线/模块/布局/绑定组引用；
- 绝不销毁源、标签、深度、基础颜色、相机或调用方目标。

## Babylon.js 等价映射

| Babylon.js 源 | Babylon Lite 实现 |
| --- | --- |
| `Meshes/meshBlendingTag.ts` | `mesh/mesh-blending-tag.ts` |
| `AbstractMesh.meshBlendingTag` | `Mesh.meshBlendingTag` |
| 常规/薄实例源标签 | 无常规实例 API；薄实例使用所属网格标签 |
| `ThinMeshBlendingPostProcess` 设置与宏定义 | 纯任务状态 + WGSL 生成器 |
| `meshBlendingBlueNoise.ts` | 任务局部确定性生成器/上传 |
| `meshBlending.fragment.fx` | `mesh-blending-wgsl.ts` |
| `FrameGraphMeshBlendingTask` | `createMeshBlendingPostProcessTask` |
| `PREPASS_MESH_BLEND_TAG` | `GeometryTextureType.MESH_BLEND_TAG` |
| Standard/PBR/Node prepass 输出 | 带有类型化标签槽位的现有 Lite 几何视图 |
| NRGE 网格混合节点 | 刻意省略；Lite 直接暴露帧图任务 |

## 测试规范

### 单元测试

`tests/lite/unit/mesh-blending-tag.test.ts`：

- 所有合法组/等级打包组合；
- 组 0 规范化；
- 非法组/等级输入；
- 非法原始打包值 `64`、`128`、`192`、负数、小数以及大于 `255` 的值；
- 解包往返；
- 源网格解析与薄实例/源语义；
- 默认半径值与冻结元组/可变已校验元素；
- 斜率/枚举校验；
- 质量常量表以及透视/正交的投影半径数学。

`tests/lite/unit/mesh-blending-blue-noise.test.ts`：

- 逐字节确定性生成；
- 精确维度与双通道；
- 每个通道内每个字节精确出现 64 次的直方图；
- 兼容 Babylon.js 的 FNV-1a 摘要 `0x965547cd`；
- 不同通道种子生成不同输出；
- Babylon.js 频谱断言将选定低频能量保持在选定高频能量的 10% 以下。

`tests/lite/unit/mesh-blending-shader.test.ts`：

- 每种质量生成精确的循环常量/特性/插值；
- 缺乏基础颜色时移除所有基础颜色绑定与阴影计算；
- 存在基础颜色时添加它们；
- 视图深度与屏幕深度重建契约；
- 左上角 NDC Y 转换以及自底向上的 Babylon.js 噪声行与方向偏移映射；
- 类型化 `texture_2d<u32>` 标签绑定；
- 全部 13 种调试变体；
- 精确的半径/接触/衰减/OKLab 常量；
- 源直通分支；
- HDR 路径不包含对插值 SceneColor 的 saturate/clamp；
- 次目标代码仅出现在 High/Cinematic 中；
- 与 alpha 无关的纹理加载与精确纹素访问。

`tests/lite/unit/geometry-renderer-task.test.ts` 新增内容：

- 标签访问器与 `r8uint` 默认值；
- 标签采样数/格式校验；
- 透明过滤默认值/覆写；
- Standard、PBR 与 Node 几何路径的类型化着色器输出；
- 整数目标混合省略。

专项网格混合单元测试独立于完整仓库测试套件运行。

### 一致性测试场景

ID `310..315` 包含六个专项场景。场景 315 是经用户批准的原有五场景上限例外：

| ID | 覆盖范围 |
| ---: | --- |
| 310 | 核心 Standard/PBR 相交、默认 Medium/视图深度行为、打包半径等级以及同组接缝 |
| 311 | 三个大型 ShadowAttenuation 接缝，对比左侧无反照率与右侧线性反照率 |
| 312 | 近全幅正交面板，使用反向 Z 屏幕深度、High 质量与自定义半径/斜率值 |
| 313 | Alpha 测试 Standard/PBR 材质，证明被丢弃片元不写入标签 |
| 314 | Cinematic 极小物体保护、延续/回退、三组次目标以及重复接触 |
| 315 | 托管 `coastalCliff.glb`，使用 PBR 材质、屏幕深度、可选反照率、排除列表及资产缩放半径 |

每个场景包含：

- `lab/lite/sceneN.html`；
- `lab/lite/babylon-ref-sceneN.html`；
- `lab/lite/bundle-sceneN.html`；
- `lab/lite/src/lite/sceneN.ts`；
- `lab/lite/src/bjs/sceneN.ts`；
- 一个带有新上限的 `scene-config.json` 条目，绝不修改现有上限；
- `tests/lite/parity/scenes/` 下的一个一致性测试规范；
- 通过 `scene-config.json` 实现的画廊发现；
- 通过现有 HTML 自动输入扫描实现的 Vite 发现；
- 通过现有 scene-config 驱动的打包测试套件实现的打包体积发现。

每个场景在 `reference/lite/` 下都有已提交的 Babylon.js 黄金图，并在 `lab/public/thumbnails/` 下有画廊缩略图。

场景 311 与同一浏览器会话中新鲜捕获的 Babylon.js 截图对比。其两个半宽后处理视口将片元中心精确映射到源纹素边界上，在不同 GPU 实现上全屏插值变量可能选择相邻纹素。同 GPU 参考可以在不更改已提交黄金图或削弱算法的前提下保留严格的 MAD 阈值。面板占据帧高度的 75%；仅前景 MAD 检查仍作为覆盖守卫，而全帧检查用于检测更广泛的回归。

## 依赖关系

静态依赖仅限于现有的 Lite 模块：

- 相机矩阵获取器与矩阵求逆；
- 渲染目标创建/构建/销毁；
- 帧图任务类型；
- 几何材质视图组合器；
- GPU 标志与资源退役约定；
- `wgsl` 源码品牌类型标记（branding）。

不新增任何外部依赖。`@babylonjs/lite` 不导入任何 Babylon.js 运行时包；Babylon.js 导入仅存在于参考场景源码中。
