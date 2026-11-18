# 模块：着色器材质（Shader Material）

> 包路径：`packages/babylon-lite/src/material/shader/`

## 目的

ShaderMaterial 模块提供了 Lite 中对应 Babylon.js `ShaderMaterial` 的纯 WGSL 实现：支持用户编写的顶点与片元着色器、显式顶点属性列表、强类型自定义 uniform、纹理采样器、视频外部纹理、编译期宏定义（define）以及诸如 Alpha 混合等渲染状态提示。

本模块刻意**不是** GLSL 兼容层。Babylon.js 的文档和 Playground 仍可用作参考场景和 API 概念对照，但 Lite 仅接受 WGSL 源码。核心中不存在 GLSL 解析器、GLSL 到 WGSL 的转译器，也没有 `Effect.ShadersStore` 全局注册表。

该设计遵循 Lite 材质契约：

- ShaderMaterial 是带有材质自身持有的 `_buildGroup` 的纯数据。
- 场景从不了解特定于着色器的细节。
- 渲染器仅绑定 group 0 并请求可渲染对象进行绘制。
- 材质拥有着色器源码、绑定组布局、管线、绑定组及资源生命周期。
- 结构化的 GPU 布局来自强类型选项，绝不通过解析发出的 WGSL 获得。

## 公共 API 接口

### 工厂函数

```typescript
export function createShaderMaterial(options: ShaderMaterialOptions): ShaderMaterial;
export function enableShaderMaterialInstanceWorld(material: ShaderMaterial): void;
export function enableShaderMaterialFinalColor(material: ShaderMaterial): void;
export function enableShaderMaterialPipelineSharing(): void;
export function enableShaderMaterialVisiblePacketUpdates(material: ShaderMaterial): void;
export function setShaderAttributeFormats(material: ShaderMaterial, formats: ShaderAttributeFormats): void;
```

`createShaderMaterial` 是同步的，并接受已解析的 WGSL 源码字符串。

`enableShaderMaterialVisiblePacketUpdates(material)` 允许单个材质选择启用推迟隐藏数据包（packet）的系统 uniform 求值/上传以及资源绑定组刷新。默认行为保持不变。该辅助函数在数据包的网格上安装一个材质持有的内部谓词；通用数据包更新器在读取任何相机、世界版本、目标、alpha 截断或资源修订版本号之前先调用该接缝。仅当 `mesh.visible === false` 时，该谓词才返回 true。重复启用是安全的，包括在构建绑定之后启用。不发生导入时注册或可见性修改。未使用的策略代码会被 tree-shake 移除。

该策略覆盖分组不透明成员、单个数据包、透明数据包以及共享的薄实例数据包更新器。材质共享的自定义 UBO 上传保持活跃，即使每个数据包都处于隐藏状态：其他绑定/视图可能共享该材质状态。透明排序中心点以及薄实例同步/剔除保持其现有调度；这并非通用的隐藏可渲染对象调度器。初始数据包分配和管线准备不会被推迟。

隐藏的数据包保持其上次写入的依赖键和资源修订版本号不变。因此，常规更新器在首次恢复绘制之前会使用当前通道的 `DrawUpdateContext._camera`（或场景相机）、尺寸和材质状态观察到所有累积的变更。资源获取/释放保持事务性。现有的已销毁/材质不匹配守卫首先运行；重建和材质覆写使用其所属材质的谓词。材质视图（`createShaderNormalMaterialView`、`createShaderNoColorMaterialView`）通过现有的原型链继承源材质的策略；请在源材质上启用该策略，因为公共视图工厂返回 `MaterialView` 而非 `ShaderMaterial`。
隐藏和恢复均请使用公共函数 `setMeshVisible(mesh, visible)`：它会使缓存的不透明束（bundle）失效。渲染任务更新和批处理刷新仍优先于录制/回放束以及透明排序。不引入任何任务、相机、束或绘制顺序的改变。

普通不透明和透明路径共享一个文件局部的生命周期/所有权守卫，独立于可选的更新策略。薄实例组入口点保留其位置参数辅助函数签名；其私有构建器直接在组工厂的词法作用域中捕获这些辅助回调，而不是分配和转发中间辅助对象。重建闭包保留相同的回调和显式网格资源所有权。辅助函数保留在其现有的异步模块边界内，而不引入跨 chunk 导出。

`tests/lite/unit/shader-visible-packet-updates.test.ts` 中的回归测试断言：隐藏期间零次世界版本读取、系统写入/拷贝及绑定组重建；双成员组中一个可见拷贝的行为；共享自定义上传；所有变更输入的恢复；替代相机；透明排序；销毁、替换和覆写重建；以及一个薄实例网格在隐藏时继续进行实例上传并在恢复绘制前刷新其数据包。

`enableShaderMaterialPipelineSharing()` 是无参数的包级选装函数，用于共享等价的 ShaderMaterial 布局、模块和管线。请在管线准备之前调用它。它在管线绑定路径中安装一个可选的供给器调用，并在第一次启用查找之前不分配缓存。此后创建的材质和视图自动参与共享。同一 `GPUDevice` 上的等价材质在共享 GPU 管线状态的同时，保留独立的 uniform 值、纹理、自定义 UBO 和绑定组。重复调用启用会以相同行为替换该接缝，且是安全的。未调用它的应用保留现有的逐材质行为；通过 `enableShaderPipelineCache` 进行的显式多材质构建组共享保持不变。

```typescript
export interface ShaderMaterialOptions {
    readonly name?: string;
    readonly vertexSource: string;
    readonly fragmentSource: string;
    readonly attributes: readonly ShaderAttributeName[];
    readonly uniforms?: readonly ShaderUniformOption[];
    readonly samplers?: readonly ShaderSamplerOption[];
    readonly externalTextures?: readonly string[];
    readonly defines?: ShaderDefineMap;
    /** Bind/inject the mesh's optional thin-instance RGBA stream for this material. Default true. */
    readonly useThinInstanceColors?: boolean;
    readonly needAlphaBlending?: boolean;
    readonly blendMode?: "alpha" | "additive";
    readonly blend?: GPUBlendState;
    readonly needAlphaTesting?: boolean;
    readonly backFaceCulling?: boolean;
    readonly depthWrite?: boolean;
    readonly depthCompare?: GPUCompareFunction;
    readonly topology?: "point-list" | "line-list" | "triangle-list";
}
```

支持的 Babylon 路由形式：

| Babylon 路由形式 | Lite 阶段 1 处理方式 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `{ vertexSource, fragmentSource }` | 支持，但源码字符串必须为 WGSL。 |
| `{ vertex, fragment }` 配合 `Effect.ShadersStore` | 核心不支持；全局着色器存储违反 Lite 的无副作用规则。 |
| `{ vertexElement, fragmentElement }` | 核心不支持。调用者可自行读取 DOM 文本并显式传入 WGSL 字符串。 |
| `"./COMMON_NAME"` 外部 `.fx` 文件 | 核心不支持。未来辅助函数可能会显式获取 WGSL，但材质工厂保持同步。 |

### 材质类型

```typescript
export interface ShaderMaterial extends Material {
    readonly name?: string;
    readonly vertexSource: string;
    readonly fragmentSource: string;
    readonly attributes: readonly ShaderAttributeName[];
    readonly uniformDecls: readonly ShaderUniformDecl[];
    readonly samplerDecls: readonly ShaderSamplerDecl[];
    readonly _externalTextureDecls?: readonly string[];
    readonly defines: readonly ShaderDefine[];
    readonly needAlphaBlending: boolean;
    readonly blendMode: "alpha" | "additive";
    readonly blend?: GPUBlendState;
    readonly needAlphaTesting: boolean;
    readonly backFaceCulling: boolean;
    readonly depthWrite: boolean;
    readonly depthCompare: GPUCompareFunction;
    _uniformValues: Map<string, ShaderUniformSlot>;
    _textureSlots: Map<string, ShaderTextureSlot>;
    _externalTextureSlots?: Map<string, ShaderExternalTextureSlot>;
    _uniformVersion: number;
    _resourceVersion: number;
}
```

外部纹理布局、WGSL、验证及绑定行为位于可 tree-shake 的 `shader-external-texture` 模块中，该模块与 `setShaderExternalTexture` / `getShaderExternalTexture` 一并导出。核心材质创建会对声明名称拍快照，因此调用者的变更不会导致槽位不同步。首次调用绑定 API 会激活（hydrate）并验证在代码拆分绑定模块加载之前创建的材质，并显式安装可选的管线和可渲染对象解析器接缝。导入该模块没有任何副作用。管线准备会拒绝在安装这些接缝之前的外部纹理材质，而不是缓存不完整的布局。可选的可渲染对象解析器用于识别需要直接绘制和逐帧 group-1 刷新的材质。刷新仅重建绑定组，不获取或释放普通纹理。不使用该 API 的 ShaderMaterial 不会拉取视频绑定或采样器缓存代码。

外部槽位属于底层的源材质。先激活一个材质视图必须填充源材质，而不是遮蔽（shadow）其槽位。通过源或视图进行绑定均会更新同一份源映射表和资源版本号，从而使其他视图能继续看到后续的视频替换。

来自基类 `Material` 的 `_uboVersion` 会镜像 `_uniformVersion`，以兼容现有的脏检查跟踪。`_resourceVersion` 是独立的，因为纹理/采样器更改需要重建绑定组，而不仅仅是写入 UBO。

`blend` 是一个显式的颜色目标混合状态覆写。存在时，它会替换由 `blendMode` 推导的状态，除非显式覆写否则隐含 `needAlphaBlending`，默认将 `depthWrite` 设为 `false`，并参与跨材质管线缓存键的构成。

`topology` 默认为 `triangle-list`。它在创建材质时固定并参与管线选择；提供线列表几何体的调用者可以使用 `"line-list"` 进行诊断性线框渲染，而无需访问内部管线状态。带索引的条带（strip）拓扑被拒绝，因为 WebGPU 要求 `stripIndexFormat` 与每个网格的索引缓冲区匹配，而 ShaderMaterial 的管线分组是基于材质的。

### 属性

```typescript
export type ShaderAttributeName = "position" | "normal" | "uv" | "uv2" | "tangent" | "color" | "joints" | "weights" | "joints1" | "weights1";
export type ShaderAttributeFormats = Partial<Record<ShaderAttributeName, GPUVertexFormat>>;
```

`options.attributes` 中的顺序即为顶点缓冲区绑定顺序以及 WGSL `@location` 顺序。不支持的名称在创建材质时抛出异常。缺失的可选网格缓冲区使用零填充缓冲区。启用 `enableShaderMaterialFinalColor()` 时，缺失的 `color` 回退值改为白色，以避免颜色相乘时将没有顶点颜色的网格变黑。常规网格渲染需要 `position`。

`setShaderAttributeFormats` 在注册或管线准备之前更改材质持有的顶点签名：声明的 `GPUVertexFormat` 同时选择生成的 WGSL 输入类型和紧凑默认步长。网格持有的 `MeshGPU._vbLayout` 独立提供逐属性的步长/偏移量打包。仅当物理格式兼容时，同一材质才能绘制普通紧凑几何体和由存储缓冲区支持的板（slab）。规范的 CPU/glTF 几何体保留其规范编码（例如 XYZ 位置使用 `float32x3`）；声明 `float32x4` 不会重新打包这些缓冲区。此类不匹配会在可渲染对象构建期间被拒绝。匹配的存储支持流支持非规范格式；其偏移对齐和字节范围必须适配声明的步长。格式声明由 setter 拍下快照，而存储支持的常量零流对所有受支持格式均有效。打包变体参与同步、异步、跨材质、深度/法线视图及薄实例管线键的构成。存储支持的绘制保留网格的 `_baseVertex`，缺省的可选 slab 流使用共享的零步长默认缓冲区。网格特定的布局复用绑定已解析的格式，仅更改步长/偏移量，而不是为每个网格重建材质签名。

存储/格式选装在 `shader-vb-support.ts` 中安装一个同步支持记录。该小型模块拥有共享的规范格式/类型/步长元数据以及属性布局辅助函数，而可渲染对象将其已编写流查找传递给可选的支持回调。因此，导入 `setShaderAttributeFormats` 或构建存储几何体不会静态地将完整的惰性 `shader-pipeline.ts` / `shader-renderable.ts` 实现拉入入口模块。直接绘制将 `baseVertex` 直接传递给 WebGPU，无需转发包装器。薄实例路径在构建期间一次性解析其组合顶点布局，并在绑定和异步准备之间共享；间接参数编码保留在 `mesh-indexed-indirect.ts` 中。

交错 glTF 加载器在创建带步长的网格时安装相同的解析器。PBR、Standard 和拾取直接消费该网格打包；安装该解析器还会使普通和薄实例 ShaderMaterial 绘制使用记录的步长和逐属性偏移量。加载器的归一化 `COLOR_0` 流仍为单独的紧凑 `float32x4` 缓冲区，而保持交错的属性保留其编写时的打包。仅在准备布局和分组数据包时才需要顶点格式支持；可渲染对象绘制闭包不保留它。缺失缓冲区分配直接调用引擎持有的接缝。启用最终颜色辅助函数后，缺失的存储支持颜色输入使用一个网格持有的零步长白色 float32 RGBA 记录。其物理回退格式是规范的 `float32x4`，即使编写的颜色声明使用了归一化格式也是如此，从而使中性值保持为白色。该缓冲区随最后一个几何体所有者一并释放；普通的缺失流仍使用其现有的零默认值。
验证在数据包分配之前计算一次每个网格的缺失流掩码。数据包保留该掩码用于分组和布局解析，避免重复扫描流。不透明和透明可渲染对象共享目标绑定构建，同时保留各自不同的排序和更新行为。
默认 GPU 拾取仅支持兼容的 float32 分量。材质不兼容的位置或请求的丢弃数据格式会产生显式拾取错误；调用者可以使用 `mesh.pickable = false`、过滤器或忽略条目排除该网格。

### 薄实例与 GPU 剔除

ShaderMaterial 网格可以通过标准薄实例 API（`setThinInstances`、`setThinInstanceColors`、`enableThinInstanceGpuCulling` —— 参见 `12-thin-instances.md`）进行硬件实例化。不需要新的 ShaderMaterial 选项：当网格具有 `thinInstances` 时，渲染器会构建逐网格的**实例管线变体**，并自动将额外属性注入到生成的 `VertexInput` 结构体中，追加在声明的属性之后（即从 `@location(attributes.length)` 开始）：

```wgsl
@location(N)   world0: vec4<f32>,   // instance world matrix columns
@location(N+1) world1: vec4<f32>,
@location(N+2) world2: vec4<f32>,
@location(N+3) world3: vec4<f32>,
@location(N+4) instanceColor: vec4<f32>,   // only when setThinInstanceColors() was called
```

`useThinInstanceColors` 控制此特定 ShaderMaterial 绘制是否消费网格可选的 RGBA 流。它默认为 `true`，保留上述自动行为。当设为 `false` 时，实例化变体仍会注入并绑定 `world0..world3`，但不会注入 `instanceColor`、绑定或 GPU 剔除颜色缓冲区，也不会为该绘制同步颜色。网格的 `ThinInstanceData.colors` 保持不变，因此渲染同一网格的另一个材质仍可消费它。

该选项专门适用于无采样器的深度/材质覆写：可见材质可以消费逐实例色调，而其 `_shadowCasterMaterial` 使用 `{ useThinInstanceColors: false }`。两者共享网格的一个矩阵缓冲区，而阴影投射器避免了未使用的颜色顶点流。覆写 WGSL 不得引用 `input.instanceColor`。对于非实例化网格，此选项被忽略。

在 `registerScene()` 之前调用 `enableShaderMaterialInstanceWorld(material)`，即可为单个材质选择启用生成的 `getFinalWorld(input: VertexInput)` 辅助函数。该辅助函数对常规网格和薄实例网格具有单一稳定的签名：

```wgsl
let finalWorld = getFinalWorld(input);
out.position = shaderSystem.viewProjection * finalWorld * vec4<f32>(input.position, 1.0);
// out.vColor = input.instanceColor;  // when instance colors are present
```

对于常规网格，`getFinalWorld` 返回 `shaderSystem.world`。对于薄实例网格，它返回 `shaderSystem.world * mat4x4<f32>(input.world0, input.world1, input.world2, input.world3)`。这使同一份顶点源码可以同时服务两种网格类型，而不会在常规网格变体中引用仅限实例的属性。`ShaderMaterialOptions.uniforms` 中必须存在 `"world"` 系统 uniform；否则启用器将抛出异常。未调用该启用器的材质保留原始生成的序言（prelude），且不会引入任何辅助 WGSL 或材质跟踪实现。

`world` 系统 uniform 保持为**网格**世界矩阵。烘焙的 `worldViewProjection` / `worldView` 系统 uniform **不**感知实例 —— 共享的常规/实例化着色器必须使用 `viewProjection` 和 `getFinalWorld(input)`。

在 `registerScene()` 之前调用 `enableShaderMaterialFinalColor(material)`，即可为单个材质选择启用生成的 `getFinalColor(input: VertexInput)` 辅助函数：

```wgsl
out.vColor = getFinalColor(input);
```

当材质未声明颜色属性且管线没有实例颜色流时，生成的实现返回白色；仅存在顶点颜色时返回 `input.color`；仅存在实例颜色时返回 `input.instanceColor`；两者兼有时返回 `input.color * input.instanceColor`。`input.color` 仍是通过 `attributes: ["color"]` 请求的普通网格逐顶点属性；`setThinInstanceColors()` 提供独立的逐实例速率 `input.instanceColor`。当材质声明了 `color` 但网格没有顶点颜色缓冲区时，`input.color` 使用网格持有的中性白色回退值，以便可用的实例颜色原样透传。该回退缓冲区参与正常的共享几何体销毁、调整大小退役以及设备恢复。

与 `getFinalWorld` 一样，最终颜色辅助函数仅针对选择启用的材质生成。实例颜色特化是从绑定的顶点缓冲区布局中选择，而不是通过管线键命名约定或解析生成的 WGSL 来选择。

实现说明（bundle 纪律）：

- 实例顶点缓冲区布局、序言属性行以及逐网格实例化可渲染对象位于 `material/shader/shader-thin-instance.ts`，仅当 `meshes.some(m => m.thinInstances)` 为真时，才通过 `shader-group-builder.ts` → `buildShaderGroup` **动态导入**。非实例化 ShaderMaterial 场景通过未更改的同步 `buildShaderMaterialRenderables` 路由。
- 开销较大的绑定（`group1BGL`、`systemSpec`、`customSpec`）在非实例化与实例化变体之间共享 —— 实例化改变的是顶点数据，而非绑定组。只有顶点缓冲区布局和 `VertexInput` 结构体不同，因此 `getOrCreateShaderPipeline()` 使用紧凑的非空变体后缀（`0` 或 `1`）为实例化管线编键。仅当网格具有颜色且材质未通过 `useThinInstanceColors` 选择退出时，颜色位才为 `1`。
- 实例化 ShaderMaterial 网格以**每网格一个 `_direct` 可渲染对象**的方式渲染（不合并），因此每帧都会重新绑定逐网格实例缓冲区（避免在实例容量增长时出现陈旧的渲染束引用）。
- **选装 GPU 视锥剔除**通过共享的 `mesh/thin-instance-cull-binding.ts` 辅助函数接入（与 Standard/PBR 相同）：当设置 `enableThinInstanceGpuCulling(mesh)` 时，计算剔除通道在绑定 `update()` 中运行，绘制变为 `drawIndexedIndirect`。仅限不透明实例化 ShaderMaterial；透明实例化网格使用常规（非剔除）实例化绘制。

### Uniform 声明

```typescript
export type ShaderUniformType = "f32" | "u32" | "i32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>" | "mat4x4<f32>";

export type ShaderSystemUniformName = "world" | "view" | "projection" | "viewProjection" | "worldView" | "worldViewProjection" | "cameraPosition" | "screenSize" | "alphaCutoff";

export type ShaderUniformOption = ShaderSystemUniformName | ShaderUniformDecl;

export interface ShaderUniformDecl {
    readonly name: string;
    readonly type: ShaderUniformType;
    readonly defaultValue?: number | readonly number[];
}
```

字符串形式的 uniform 仅对已知的 Babylon 风格系统 uniform 接受。自定义 uniform 必须包含类型。这在安全处保留了 Babylon `uniforms: ["worldViewProjection", "time"]` 的概念，同时拒绝模糊的自定义字符串如 `"time"`，除非调用者提供 `{ name: "time", type: "f32" }`。

### 采样器声明

```typescript
export type ShaderSamplerOption = string | ShaderSamplerDecl;

export interface ShaderSamplerDecl {
    readonly name: string;
    readonly sampleType?: "float" | "unfilterable-float" | "depth";
}
```

每个采样器名称对应一对 WGSL 绑定：

```wgsl
@group(1) @binding(N) var textureSampler: texture_2d<f32>;
@group(1) @binding(N + 1) var textureSamplerSampler: sampler;
```

深度采样器使用 `texture_depth_2d`，且不假定为可过滤采样器。公共 API 仅接受 `Texture2D`，从不接受原始 GPU 句柄。

### 外部纹理声明

```typescript
export interface ExternalTexture {
    readonly video: HTMLVideoElement;
}

export function createExternalTexture(video: HTMLVideoElement): ExternalTexture;
export function isExternalTextureReady(texture: ExternalTexture): boolean;
export function setShaderExternalTexture(material: ShaderMaterial, name: string, texture: ExternalTexture | null): void;
export function getShaderExternalTexture(material: ShaderMaterial, name: string): ExternalTexture | null;
```

`options.externalTextures` 是 Babylon 风格绑定名称的列表。每个名称对应一个外部纹理及其所需的过滤采样器：

```wgsl
@group(1) @binding(N) var videoSampler: texture_external;
@group(1) @binding(N + 1) var videoSamplerSampler: sampler;
```

外部纹理使用 `textureSampleBaseClampToEdge(videoSampler, videoSamplerSampler, uv)` 进行采样。Lite 绑定一个设备缓存的默认最近邻 clamp-to-edge 采样器，与 Babylon.js `ExternalTexture` 一致；原始 GPU 采样器保持内部私有。一个资源名称不能同时出现在 `samplers` 和 `externalTextures` 中；所有声明及生成的 `<name>Sampler` 标识符共享生成的 group-1 命名空间。

该包装器是围绕调用者持有的 `HTMLVideoElement` 的纯状态。它不拥有任何浏览器或 GPU 资源，也没有销毁 API。应用程序仍负责视频播放、媒体流轨道、对象 URL 以及元素生命周期。`isExternalTextureReady` 报告视频是否具有当前帧数据。

WebGPU 外部纹理是瞬态的。每当包含外部纹理的 ShaderMaterial 绑定组因渲染而刷新时（包括每帧，即使包装器标识未变），Babylon Lite 都会调用 `GPUDevice.importExternalTexture({ source: texture.video })`。这种逐帧导入不会重新获取、释放或以其他方式更改普通 `Texture2D` 的所有权。公共 API 从不暴露 `GPUExternalTexture`。

### 宏定义（Defines）

```typescript
export type ShaderDefineValue = boolean | number;
export type ShaderDefineMap = Readonly<Record<string, ShaderDefineValue>>;

export interface ShaderDefine {
    readonly name: string;
    readonly value: ShaderDefineValue;
}
```

WGSL 没有预处理器。Lite 将 defines 转换为生成序言中的 const 声明：

```wgsl
const MyDefine: bool = true;
const Scale: f32 = 2.0;
```

归一化后的 define 集合是管线缓存键的一部分。调用者编写普通的 WGSL `if (MyDefine) { ... }`；WGSL 编译器可对该分支进行常量折叠。不支持 `#define`、`#ifdef` 和字符串宏替换。

### 设置器（Setters）

```typescript
export type ShaderUniformValue = number | readonly number[] | Float32Array;

export function setShaderUniform(material: ShaderMaterial, name: string, value: ShaderUniformValue): void;
export function setShaderTexture(material: ShaderMaterial, name: string, texture: Texture2D | null): void;
export function setShaderExternalTexture(material: ShaderMaterial, name: string, texture: ExternalTexture | null): void;
export function enableShaderMaterialUniformCaching(): void;
export function enableShaderUniformRangeUpdates(scene: SceneContext, material: ShaderMaterial): void;
```

`setShaderUniform` 验证名称是否存在、声明的类型是否为自定义或可设置，以及提供的浮点数个数是否与声明匹配。它会递增 `_uniformVersion` 和 `_uboVersion`。

`enableShaderMaterialUniformCaching` 是面向拥有大量 ShaderMaterial 的场景的进程级选装。它缓存每个材质的系统/自定义 UBO 布局及类型化数组视图，并且仅序列化其 setter 版本发生变化的自定义 uniform 槽位。请在场景注册前调用。不选择启用的场景保留紧凑的默认序列化器，且不会在 bundle 中包含缓存实现。

系统块失效在默认和缓存路径上均由声明驱动；它不需要额外选装，也不在网格之间共享系统 UBO。GPU 布局和依赖关系源自材质拍下快照的声明，绝不解析 WGSL。调用者持有的声明对象和数组无法更改现有材质的布局。公共声明集合保持只读；更改着色器布局需要新建材质。

| 声明的系统 uniform | 使数据包块失效的输入 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `world` | 网格世界版本（含父级）；当活动相机重定基准（浮动原点）时，还包括该相机的标识和变更键 |
| `view` | 活动相机标识、变更键和浮动原点模式 |
| `projection` | 活动相机标识、变更键和有效目标/视口宽高比 |
| `viewProjection` | `view` 和 `projection` 输入的并集 |
| `worldView` | `world` 和 `view` 输入的并集 |
| `worldViewProjection` | `world` 和 `viewProjection` 输入的并集 |
| `cameraPosition` | 活动相机标识、变更键和浮动原点模式 |
| `screenSize` | 目标宽度和高度（非视口或相机位姿） |
| `alphaCutoff` | 其标量值，而非自定义 uniform 版本 |

每个依赖相机的块都以完整的 `_cameraChangeKey`（`worldMatrixVersion` 加上投影修订号）作为键，而非仅位姿或仅投影的拆分键。注入的投影（例如 `updateXrCameraForView` 写入的逐眼 `XRView.projectionMatrix`）仅推进 `worldMatrixVersion`，因此仅投影键会保留陈旧的投影。其代价是在 FOV/裁剪面编辑时冗余上传仅视图块，或在相机移动时冗余上传仅投影块 —— 与此策略所跳过的与相机无关的块相比，这两者都很罕见。数据包还以活动相机的浮动原点模式为键，因此即便变更键未移动，在数据包首次上传后才被标记的相机（例如曾作为通道覆写相机而后来成为活动场景相机的对象）也会被重新序列化。

每个数据包保留一个基于其系统 UBO 偏移量和上次相关输入推导一次的依赖位掩码。更新路径仅查询声明的依赖项。空块的 16 字节零填充在创建时初始化，此后不再排队。非空块保留首次逐通道上传，因此注册画布尺寸不会掩盖不同的首次渲染目标或替代通道相机。相关变更会使用与之前相同的偏移量、填充和 F32 字节序列化并上传整个系统块，通过 `writeBuffer` 或现有的 `UniformCopyBatch` 执行。两个写入器仅解析其声明操作所消费的矩阵，且默认写入器按依赖位而非按 uniform 名称分发每个 UBO 偏移量。

空相机保留现有的零相机矩阵/位置值和绝对世界矩阵。

资源修订版本号/自定义缓冲区标识检查以及外部纹理刷新独立于系统块门控运行。重建和设备恢复根据替换布局创建已初始化的数据包和依赖掩码；销毁仍阻止对失效数据包的所有更新。此策略既不抑制隐藏数据包的工作，也不改变绘制提交或共享场景 UBO 的行为。

`enableShaderUniformRangeUpdates` 是面向拥有大型自定义 UBO 且仅有一个或少数几个动画值的材质的选装项。在自定义 UBO 打包过一次之后，每个变更的自定义值直接写入材质保留的打包 `ArrayBuffer`。该选装更新器在下一帧之前的所有变更中扩大一个待处理字节范围，然后从场景的渲染前回调中通过 `queue.writeBuffer` 仅上传该 4 字节对齐的范围。首次上传和每次重建打包缓冲区仍为整缓冲区写入。系统 uniform 没有自定义偏移量，因此不产生自定义 UBO 上传。启用操作对每个场景是幂等的，且同一个材质可注册到多个场景。未选择启用的材质保留原始的可渲染对象持有的整缓冲区路径，且引入零字节的范围更新实现代码。

`setShaderTexture` 验证采样器存在，并同时跟踪 `Texture2D | null` 标识以及绑定组捕获的视图/采样器。当外观或这些资源任一变化时，它会递增 `_resourceVersion`。这使普通的重复设置保持零分配，同时允许表面 RTT 调整大小回调再次传入同一个稳定的外观对象并针对其替换附件进行重建。当资源版本变更时，可渲染对象会重建 group-1 绑定组。

`setShaderExternalTexture` 验证外部声明存在，且仅当包装器标识变化时递增 `_resourceVersion`。只要材质存在外部声明，可渲染对象仍每帧重建 group 1，因为导入的外部纹理会独立于材质状态而过期。

如果保持小巧且可 tree-shake，可添加便捷包装函数：

```typescript
export function setShaderFloat(material: ShaderMaterial, name: string, value: number): void;
export function setShaderVector3(material: ShaderMaterial, name: string, value: readonly [number, number, number]): void;
export function setShaderMatrix(material: ShaderMaterial, name: string, value: Float32Array): void;
```

核心实现应将所有包装函数路由至 `setShaderUniform`。

## WGSL 编写契约

用户 WGSL 必须定义完整的顶点和片元入口点。Lite 不重写入口点函数体。

推荐的入口点名称为 `mainVertex` 和 `mainFragment`，如果日后需要，选项可以暴露入口点名称。阶段 1 可以要求：

```wgsl
@vertex
fn mainVertex(input: VertexInput) -> VertexOutput { ... }

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> { ... }
```

Lite 在用户源码之前前置拼接一段生成的序言：

1. 来自共享场景组的 `SceneUniforms`（`@group(0) @binding(0)`）。
2. 用于请求的逐网格系统值的 `ShaderSystemUniforms`（`@group(1) @binding(0)`）。
3. 用于自定义 uniform 的可选 `ShaderUniforms`（`@group(1) @binding(1)`）。
4. `options.samplers` 对应的纹理/采样器声明。
5. `options.externalTextures` 对应的外部纹理/采样器声明。
6. `options.defines` 对应的 WGSL const 声明。
7. 根据 `options.attributes` 生成的 `VertexInput`。
8. 选装的 `getFinalWorld(input)` 和 `getFinalColor(input)` 辅助函数，针对当前活跃管线变体特化。

用户 WGSL 不得声明：

- `@group(0)` 绑定。
- 使用材质生成名称的 `@group(1)` 绑定。
- `struct VertexInput`（除非某个选项显式选择关闭生成输入）。
- 重复的 uniform、采样器、外部纹理或 define 标识符。

生成的名称在可能的情况下刻意与选项中列出的名称匹配：

- 系统矩阵字段可通过 `shaderSystem.world`、`shaderSystem.worldViewProjection` 等访问。
- 自定义 uniform 可通过 `shaderUniforms.time`、`shaderUniforms.direction` 等访问。
- 纹理采样器可通过 `<name>` 和 `<name>Sampler` 访问。
- 外部纹理可通过其声明的名称配合生成的 `<name>Sampler` 过滤采样器访问，并使用 `textureSampleBaseClampToEdge` 进行采样。
- 场景字段仍可通过 `scene.viewProjection`、`scene.view`、`scene.vEyePosition` 等访问。

## 内部架构

### 文件清单

```text
packages/babylon-lite/src/material/shader/
  shader-material.ts       Public types, factory, setters, validation.
  shader-material-view-gpu.ts  Terminal private view-UBO retirement.
  enable-shader-material-instance-world.ts  Opt-in regular/thin-instance final-world helper.
  enable-shader-material-final-color.ts  Opt-in effective vertex/instance color helper.
  enable-shader-material-visible-packet-updates.ts  Opt-in hidden-packet deferral; owns the visibility predicate.
  shader-group-builder.ts  MeshGroupBuilder entry point and lazy renderable import.
  shader-renderable.ts     Per-scene/per-mesh renderables, UBO writes, bind groups.
  shader-system-dependencies.ts  System-uniform name → dependency-bit table shared by validation and writers.
  shader-pipeline.ts       Generated prelude, BGL creation, pipeline lookup.
  shader-pipeline-cache.ts Lazy cross-material bindings, modules, and pipeline cache.
  enable-shader-material-pipeline-sharing.ts  Opt-in global cache attachment and layout-identity memo.
  enable-async-shader-pipeline-compilation.ts  Real-device async descriptor preparation.
  shader-vb-support.ts     Tiny opt-in seam and canonical attribute layouts.
  shader-vb.ts             Declared formats, per-mesh packing, grouping, bounded defaults.
```

### 组构建器

`createShaderMaterial` 返回的每个材质都将 `_buildGroup` 设置为 `shaderGroupBuilder`。

```typescript
export const shaderGroupBuilder: MeshGroupBuilder = async (scene, meshes) => {
    const { buildShaderMaterialRenderables } = await import("./shader-renderable.js");
    const result = buildShaderMaterialRenderables(scene, meshes);
    shaderGroupBuilder._rebuildSingle = result.rebuildSingle;
    return result;
};
```

组构建器没有模块级注册表，且仅当场景实际使用 ShaderMaterial 时才导入可渲染对象代码。

### 逐材质分组

`buildShaderMaterialRenderables(scene, meshes)` 按 `ShaderMaterial` 实例对网格进行分组。每个材质实例拥有：

- 归一化后的源码字符串。
- 归一化后的属性。
- 归一化后的 uniform / 采样器 / 外部纹理 / define 声明。
- 针对目标签名的管线变体缓存。
- 若存在自定义 uniform，则拥有一个每材质自定义 UBO。
- 逐纹理与逐外部纹理槽位，外加资源版本号。

不透明 ShaderMaterial 如果共享同一个材质实例和目标管线，可以将多个网格合批到同一个可渲染对象下。透明 ShaderMaterial 应为每个网格发出一个可渲染对象，以便帧图排序可以使用每个网格的世界中心。

合并后的不透明可渲染对象没有单个源网格供帧图进行可见性过滤。因此，其渲染束录制循环必须跳过每个 `visible === false` 的网格对应的数据包；稳态逐帧更新保持不变。

### 管线缓存

在没有全局启用器的情况下，孤立材质保留各自逐材质的绑定/模块/管线，且多材质构建组仍可通过 `enableShaderPipelineCache(engine, meshes)` 安装作用域共享缓存。全局启用器复用相同的缓存实现。`shader-pipeline.ts` 仅拥有一个可空 `(device, material) => void` 接缝，并在 `getOrCreateShaderPipelineBindings` 开始处通过可选链调用它一次。`enable-shader-material-pipeline-sharing.ts` 中的接缝实现选择当前设备缓存，且仅当材质的当前缓存不同时才赋值。这使所有选装语义都隐藏在启用器背后，同时确保当引擎的真实 `GPUDevice` 变化时，已准备好的材质能够重新定向。
缓存所有者在运行时不导入管线所有者或全局启用器；其管线协议依赖仅为类型级依赖。根入口从独立的扩展模块重导出公共启用器，绝不通过作用域缓存模块导出。

```typescript
/** @internal */
export function _setSharedShaderPipelineCache(seam: ((device: GPUDevice, material: ShaderMaterial) => void) | null): void;
/** @internal */
export function retargetShaderPipelineCache(material: ShaderMaterial, device: GPUDevice): void;
/** @internal */
export function _getShaderDeviceCache(device: GPUDevice): ShaderPipelineCache;
/** @internal */
export function _setShaderVertexBuffersKey(resolve: ((layouts: readonly GPUVertexBufferLayout[]) => string) | null): void;
/** @internal */
export function _serializeShaderVertexBuffers(layouts: readonly GPUVertexBufferLayout[]): string;
```

内部设置器、缓存访问器、序列化器和缓存协议会从生成的声明文件中剥离。`retargetShaderPipelineCache` 仅迁移已经拥有共享缓存的材质；它不会为独立材质选择启用共享。`ShaderMaterial` 将其共享缓存引用以及精确材质/绑定模块记忆体（memo）作为强类型 `@internal` 状态携带，没有单独的公共/内部伴生接口。渲染器和管线状态扩展继承该缓存字段；它们不得以仅包含缓存代次的更窄协议重新声明它。

设备缓存存储在惰性分配的 `WeakMap<GPUDevice, DeviceCache>` 中。每个设备缓存拥有绑定、着色器模块和管线映射表。绑定以属性名和声明格式、强类型 uniform 声明、采样器声明、外部纹理声明以及存储缓冲区声明为键。相等的生成 WGSL 字符串共享由设备缓存局部数字 ID 标识的设备局部模块。每材质模块记忆体仅对精确的材质/视图标识和精确的绑定对象有效，因此继承的材质视图不会意外复用其源材质生成的片元代码。

完整的共享管线键采用 JSON 编码，包含：

- 目标签名（颜色/深度格式、深度比较函数和采样数）；
- 逻辑变体键，包括 alpha-to-coverage 特化；
- 顶点和片元模块 ID；
- 序列化后的顶点缓冲区布局；
- alpha/混合、深度写入/比较/偏移、剔除、拓扑以及模板状态。

生成的模块已经捕获了源 WGSL、生成序言、宏定义、声明以及实例属性。因此，法线/无颜色视图、仅颜色/深度目标、打包网格布局和薄实例颜色变体仅当其完整生成代码和管线状态相等时才共享。

普通作用域缓存使用纯 `_serializeShaderVertexBuffers` 序列化器，不带布局标识记忆体。全局启用器通过 `_setShaderVertexBuffersKey` 安装一个解析器；缓存所有者仅调用该可选解析器，否则回退到纯序列化器。该扩展拥有一个按布局数组标识编键的惰性分配 `WeakMap<readonly GPUVertexBufferLayout[], string>`。序列化格式为 `[arrayStride, stepMode ?? "vertex", attributes]`，每个属性表示为 `[shaderLocation, offset, format]`。对同一数组的重复查找仅遍历一次；具有相等描述符的不同数组生成相同的字符串，从而共享管线。布局数组、每个描述符以及每个可复用属性集合在数组首次查找后均不可变。构建器可以在查找前完成或替换布局，但之后的更改需要新建数组，而非就地修改。打包网格和薄实例路径在数组被捕获前完成各自的步长/偏移量、矩阵和可选颜色布局。

两条路径返回完全相同的序列化字符串，作为字符串嵌入外层管线键 JSON 中。在作用域缓存已编译管线或已启动异步编译之后再启用共享，不得更改键表示、替换设备缓存或绑定、清空模块/管线/待处理映射表或推进缓存代次。等价的后创建材质会加入同一设备缓存。重复启用会替换已安装的回调，而不会包装它们或重置布局记忆体。

`clearShaderPipelineCache()` 会丢弃设备缓存 WeakMap 并递增全局代次。现有的作用域缓存会在下次使用时惰性清空其绑定/模块；全局启用的材质会被重新分配到当前设备的新缓存。现有材质绑定随后会因为其记录的缓存代次或设备不再匹配而更新，且源优先的视图更新仍会使每个视图的模块记忆体通过新绑定标识失效。清理不会禁用全局接缝。不可变顶点布局标识记忆体刻意跨越缓存代次存活：其序列化的描述符值与设备无关，且在不可变性契约下保持有效。

异步准备必须在描述符捕获前针对真实设备解析绑定。它调用 `retargetShaderPipelineCache(material, engine._device)`，然后执行常规绑定查找。只有管线创建通过合成捕获设备运行；在那里不调用可选的共享接缝。因此，待处理的编译停留在真实设备的共享绑定存储中，对等价材质（包括普通、薄实例和薄实例颜色变体）进行去重，且已完成的管线会被首次同步绑定复用。

模块导入时不分配任何 `Map`、`WeakMap` 或 `Set`。未选择启用的管线路径不导入缓存所有者，仅支付可空可选调用的开销。

### 绑定组布局

管线布局如下：

| 组 | 所有者 | 绑定 |
| ----- | ----------------------- | ----------------------------------------------------------------------------------- |
| 0 | 帧图渲染任务 | `SceneUniforms`、场景灯光 UBO |
| 1 | ShaderMaterial | 系统 UBO、可选自定义 UBO、纹理、采样器、外部纹理/采样器对 |

Group 1 绑定顺序：

1. `ShaderSystemUniforms` 位于 binding 0。始终存在以保持布局稳定。
2. 若存在自定义 uniform 声明，则 `ShaderUniforms` 位于 binding 1。
3. 按声明顺序排列的纹理/采样器对。
4. 按声明顺序排列的外部纹理/采样器对。

### UBO 布局

使用来自 `src/shader/ubo-layout.ts` 的 `computeUboLayout()`。不要拆分 WGSL 字符串或解析用户着色器源码。

`ShaderSystemUniforms` 仅包含请求的逐网格值：

| Uniform | 类型 | 来源 |
| --------------------- | ------------- | -------------------------------------------------------- |
| `world` | `mat4x4<f32>` | `mesh.worldMatrix` |
| `worldView` | `mat4x4<f32>` | 按 Lite 矩阵惯例计算的 `view * world` |
| `worldViewProjection` | `mat4x4<f32>` | 按 Lite 矩阵惯例计算的 `scene.viewProjection * world` |
| `projection` | `mat4x4<f32>` | 活动通道相机投影 |
| `screenSize` | `vec2<f32>` | 活动通道目标宽/高 |
| `alphaCutoff` | `f32` | 材质/系统值，默认 `0.4` |

场景级值在可能时应通过别名引用或从 group 0 读取，而不是按网格复制：

| Uniform | 首选来源 |
| ---------------- | ------------------------ |
| `view` | `scene.view` |
| `viewProjection` | `scene.viewProjection` |
| `cameraPosition` | `scene.vEyePosition.xyz` |

如果调用者请求 Babylon 风格的 `viewProjection` 字符串，生成序言可以在辅助代码中暴露别名函数或类似 const 的局部表达式，但不应分配重复的逐网格 UBO 槽位。

### 矩阵惯例

Lite 的相机辅助函数将 `viewProjection` 计算为 `projection * view`，且材质模板当前按照现有引擎惯例用 `scene.viewProjection * worldPosition` 相乘得到裁剪空间位置。ShaderMaterial 必须使用相同惯例，以与 Standard、PBR 和 NodeMaterial 匹配。

### 浮动原点

在 LWR（`35-large-world-rendering.md`）下，系统 uniform 所描述的参考系是**相对于视点的（eye-relative），而非绝对的**。`getViewMatrix` 会在浮动原点相机上强制将视图平移置零，因为它期望网格世界矩阵已经完成重定基准；Standard、PBR 和 Node 可渲染对象在其网格世界矩阵打包中执行该操作，而 ShaderMaterial 在 `_shaderWorldMatrix(mesh, camera, out?)` 中执行，默认和缓存 uniform 写入器均会调用该函数。

着色器作者观察到的效果：

- `world`、`worldView` 和 `worldViewProjection` 均携带相机相对平移。它们源自同一个重定基准后的矩阵，因此保持在同一参考系中。
- `cameraPosition` 为 `(0, 0, 0)` —— 在 `world` 所表达的参考系中，相机_就是_原点。这保持了上文记录的 `scene.vEyePosition.xyz` 等价关系，`_packSceneUniforms` 在 FO 下已经将其置零。因此类似 `cameraPosition - worldPos` 的表达式仍能产生正确的相对视点向量，并且现在具有全精度。对于在启用 `useFloatingOrigin` 时将 `cameraPosition` 作为绝对世界空间位置读取的任何自定义着色器，**这是一项破坏性变更** —— 迁移路径请参见发行说明。
- 无法从 UBO 中恢复绝对世界坐标。真正需要绝对世界坐标的着色器应将其作为自定义 uniform 传入。

关闭浮动原点时，上述所有值均为普通绝对值，且该路径为零拷贝。

### 系统 uniform 依赖表

`shader-system-dependencies.ts` 是系统 uniform 名称的唯一分类处。它没有模块级副作用，仅导出常量和两个内部函数：

```typescript
export const WORLD = 1;
export const VIEW = 2;
export const PROJECTION = 4;
export const VIEW_PROJECTION = 8;
export const CAMERA_POSITION = 16;
export const SCREEN_SIZE = 32;
export const ALPHA_CUTOFF = 64;
export const CAMERA = VIEW | PROJECTION | VIEW_PROJECTION | CAMERA_POSITION;

/** Dependency bits of one name; 0 for any non-system name (including "_pad"). */
export function shaderSystemDependency(name: string): number;
/** Bitwise OR over every name in `spec._offsets`. */
export function shaderSystemDependencies(spec: UboSpec): number;
```

| 名称 | 位掩码 |
| --------------------- | -------------------------- |
| `world` | `WORLD` |
| `view` | `VIEW` |
| `projection` | `PROJECTION` |
| `viewProjection` | `VIEW_PROJECTION` |
| `worldView` | `WORLD \| VIEW` |
| `worldViewProjection` | `WORLD \| VIEW_PROJECTION` |
| `cameraPosition` | `CAMERA_POSITION` |
| `screenSize` | `SCREEN_SIZE` |
| `alphaCutoff` | `ALPHA_CUTOFF` |

该表是一个无原型的对象字面量，因此诸如 `constructor` 等继承键会归类为 0。
消费者：

- `shader-material.ts`：`_isShaderSystemUniform(name)` 即 `shaderSystemDependency(name) !== 0`，而 `systemUniformType` 从 `CAMERA_POSITION` / `SCREEN_SIZE` / `ALPHA_CUTOFF` / 矩阵位推导 `vec3<f32>` / `vec2<f32>` / `f32` / `mat4x4<f32>`。
- `shader-renderable.ts`：`createPacket` 将 `shaderSystemDependencies(systemSpec)` 存储为 `ShaderPacket._systemDependencies`；`updatePacket` 基于它进行门控；`writeSystemUniforms` 按位分发每个偏移量（矩阵位选择 view、projection 或 view-projection，且 `WORLD` 乘以重定基准后的世界矩阵；其余为 world、相机位置、屏幕尺寸或 alpha 截断）。
- `enable-shader-material-uniform-caching.ts`：缓存的系统写入计划存储相同的掩码，且仅解析其命名的矩阵。

`_shaderWorldMatrix` 的第三个参数 `out` 是可选的，它的存在仅是为了让测试和其他直接调用者可以提供自己的目标缓冲区，而不复用模块作用域的 FO 暂存缓冲区 —— 若不提供，连续两次调用会别名引用同一个数组，第二次会覆盖第一次。上述两个可渲染对象写入器从不传入它，因此它们保留了原始的零拷贝行为：FO 开启时使用共享暂存缓冲区，FO 关闭时按引用返回 `mesh.worldMatrix`。当传入 `out` 时，两个分支都会写入其中（包括 FO 关闭的情况，否则将原样返回 `mesh.worldMatrix`），从而使传入 `out` 始终意味着“答案就在这里”。

## 管线配置

默认值匹配常规 Lite 网格渲染：

```typescript
primitive.topology = "triangle-list";
primitive.frontFace = target.flipY ? "cw" : "ccw";
primitive.cullMode = options.backFaceCulling === false ? "none" : "back";
depthStencil.format = target.depthStencilFormat ?? "depth24plus-stencil8";
depthStencil.depthCompare = options.depthCompare ?? "greater-equal";
depthStencil.depthWriteEnabled = options.needAlphaBlending ? false : (options.depthWrite ?? true);
multisample.count = target.sampleCount;
```

Alpha 混合：

```typescript
if (needAlphaBlending) {
    blend.color = { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" };
    blend.alpha = { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" };
}
```

Alpha 测试：

- `needAlphaTesting` 不会自动注入片元代码。
- 着色器必须显式调用 `discard`。
- 如果着色器需要引擎提供的截断值，则在 `uniforms` 中列出 `"alphaCutoff"` 并读取 `shaderSystem.alphaCutoff`。

## 着色器逻辑概览

Babylon 文档中基础 ShaderMaterial 的最简 WGSL 等价实现：

```wgsl
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
    return out;
}

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
```

纹理采样器等价实现：

```wgsl
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
    out.uv = input.uv;
    return out;
}

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(textureSampler, textureSamplerSampler, input.uv);
}
```

视频外部纹理等价实现：

```wgsl
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
    out.uv = input.uv;
    return out;
}

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSampleBaseClampToEdge(videoSampler, videoSamplerSampler, input.uv);
}
```

## 状态机 / 生命周期

1. 用户调用 `createShaderMaterial(options)`。
2. 工厂函数验证属性，归一化 uniform/采样器/外部纹理/define 声明，创建值槽位，并附加 `_buildGroup`。
3. 用户将材质分配给网格并将它们添加到场景中。
4. `registerScene` 运行延迟构建器；`shaderGroupBuilder` 动态导入 `shader-renderable.ts`。
5. 可渲染对象构建器按材质实例对网格分组。
6. 若已启用全局共享，绑定查找为引擎当前设备选择惰性缓存；否则材质保留其现有的作用域或私有状态。
7. 对每个材质，`shader-pipeline.ts` 为活跃的目标签名构建或复用生成序言、着色器模块、group-1 BGL 以及渲染管线。
8. 对每个网格，可渲染对象准备 CPU 系统 uniform 映像，使用 `createUniformBuffer` 事务性地分配并上传它，然后在创建 group 1 之前注册数据包清理。分配标签被保留，且失败的初始上传会销毁未发布的缓冲区。
9. 每一帧，`DrawBinding.update(context)` 在世界/相机/目标数据变化时刷新系统 UBO，在 `_uboVersion` 变化时刷新自定义 UBO。
10. 绘制时按材质属性顺序绑定顶点缓冲区，设置索引缓冲区和 group 1，然后使用网格可选的存储分配 `_baseVertex` 发出带索引的绘制调用。
11. 若 `setShaderTexture` 更改了纹理，下一次更新会为受影响的网格数据包重建 group 1，并更新已获取/已释放的纹理引用。
12. 若声明了外部纹理，每次数据包更新都会重新导入当前视频帧并重建 group 1，而不更改普通纹理租约。
13. 材质切换使用 `shaderGroupBuilder._rebuildSingle`，与 Standard/PBR 一致。

辅助重建会接收一个显式的 `MeshRebuildResources` 生命周期接收器（sink），而不是将其数据包注册到场景持有的销毁器映射表中。存储缓冲区分配仍归其 `StorageBuffer` 和引擎注册所有；数据包绑定实时的已验证句柄，但不维护第二个未读的原始缓冲区列表。销毁着色器数据包会释放其系统 UBO 和纹理租约，而不会销毁调用者持有的存储分配。

`releaseMaterialViewGpu(engine: EngineContext, view: MaterialView): void` 关闭一个已废弃的 ShaderMaterial 视图自身拥有的自定义 UBO。请先分离使用该视图的每个绘制调用；这是终结性废弃操作，而非挂起/恢复 API。对于源材质或借用其源材质 UBO 的视图，此操作为空操作。管线所有者捕获精确的自有缓冲区及其分配引擎，同步清除私有 CPU/UBO 状态，并通过 `retireGpuResources` 将其销毁排入队列。在队列栅栏之前或之后重复调用不会再次销毁。共享绑定、着色器模块、源 uniform、纹理和存储缓冲区均不受影响。

管线上下文更新也会在替换状态之前退役视图之前自有的自定义 UBO。源材质清理不在此视图废弃 API 的职责范围内。
共享管线缓存生命周期独立于数据包和视图 UBO 生命周期。设备更新在重建数据包之前在新设备上解析绑定；丢弃缓存引用不能替代现有的针对其他数据包自有 GPU 资源的设备恢复重建。分配记录了其所属引擎，因此在另一个引擎上更新会通过旧引擎的队列退役。数据包更新在绘制前除了检查资源修订版本号外，还会重新创建缺失的自定义 UBO 并比较实际绑定的缓冲区与当前缓冲区。普通、透明和薄实例数据包消费这同一条更新路径。设备恢复仍负责重建所有其他设备绑定的数据包资源；仅凭此规则本身并不是完整的数据包恢复 API。

重点生命周期测试使用真实材质/视图工厂、数据包写入器和惰性 GPU 缓冲区：包含源加三个私有视图、加栅栏/幂等释放、借用视图安全性、代次更新以及变更分配引擎的场景。它们检查提交的字节和绑定；不测量渲染像素、显存或浏览器性能。

数据包所有权独立于材质覆写标识：提供的资源接收器拥有辅助数据包；未提供时，数据包属于场景的主网格销毁器列表。普通和薄实例构建器转发同一个接收器。覆写标志仅在更新和绘制期间控制材质标识守卫，而不维护第二个场景持有的辅助注册表。

## Babylon.js 等价映射

| Babylon ShaderMaterial 概念 | Lite ShaderMaterial 等价实现 |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `new ShaderMaterial(name, scene, route, options)` | `createShaderMaterial({ name, vertexSource, fragmentSource, ...options })` |
| `scene` 构造函数参数 | 不接受；场景通过 `addToScene` 拥有网格/材质 |
| GLSL 着色器源码 | 不支持 |
| WGSL 着色器源码 | 支持 |
| `attributes: ["position", "normal", "uv"]` | 相同名称，依据 Lite 支持的属性进行验证 |
| `uniforms: ["worldViewProjection"]` | 对已知系统 uniform 相同 |
| 自定义 `uniforms: ["time"]` | 使用 `{ name: "time", type: "f32" }` |
| `samplers: ["textureSampler"]` | 相同名称，通过 `setShaderTexture` 绑定 |
| `externalTextures: ["videoSampler"]` | 相同名称，通过 `setShaderExternalTexture` 绑定 |
| `defines: ["MyDefine"]` | `defines: { MyDefine: true }`，作为 WGSL const 发出 |
| `setFloat`、`setVector3`、`setTexture` 方法 | `setShaderUniform`、`setShaderTexture` 独立函数 |
| `needAlphaBlending` | 透明可渲染对象 + 混合管线 |
| `needAlphaTesting` | 仅提示；着色器自行执行 discard |
| 逐绘制薄实例颜色选择退出 | 在与颜色无关的 ShaderMaterial 上设置 `useThinInstanceColors: false` |

## 依赖项

- `material/material.ts`：用于基础 `Material`。
- `render/renderable.ts`：用于 `MeshGroupBuilder`、`Renderable`、`DrawBinding`。
- `render/scene-helpers.ts`：用于场景绑定组布局和默认管线描述符。
- `shader/scene-uniforms.ts`：用于共享场景 UBO WGSL。
- `shader/ubo-layout.ts`：用于强类型 UBO 打包。
- `material/shader/shader-pipeline-cache.ts`：用于惰性按设备编键的共享绑定、模块和管线。
- `material/shader/enable-shader-material-pipeline-sharing.ts`：用于选装全局附加和布局记忆化。
- `material/shader/enable-async-shader-pipeline-compilation.ts`：用于真实设备待处理编译与描述符捕获。
- `texture/texture-2d.ts`：用于公共纹理资源。
- `texture/external-texture.ts`：用于调用者持有的视频外部纹理状态。
- `resource/gpu-pool.ts`：用于适当位置的纹理获取/释放与采样器复用。
- `camera/camera.ts`：用于活动通道视图/投影数据以及用于依赖相机的系统块失效的 `_cameraChangeKey`。
- `material/shader/shader-system-dependencies.ts`：用于系统 uniform 分类和依赖位。

## 测试规范

使用 Babylon.js 文档 Playground 作为 BJS 参考概念，同时保持 Lite 源码为纯 WGSL。

| 场景 | 参考来源 | Lite 覆盖范围 |
| ------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| ShaderMaterial 基础颜色 | 文档 Playground `#5T8G3I` | Position 属性、`worldViewProjection`、纯色片元输出 |
| ShaderMaterial 纹理采样器 | 文档 Playground `#D8IDR8` | `uv` 属性、`Texture2D`、采样器对、`setShaderTexture` |
| ShaderMaterial 外部纹理 | Lite 自编视频参考 | `texture_external`、逐帧导入、`setShaderExternalTexture` |
| ShaderMaterial uniform 更新 | 文档 Playground `#5T8G3I#16` | 通过 `setShaderUniform` 修改自定义标量/向量/颜色 uniform |
| ShaderMaterial defines 变体 | 衍生自文档 `defines` 选项 | WGSL const define 注入序言并包含在管线键中 |
| ShaderMaterial alpha | Lite 自编 WGSL 参考 | `needAlphaBlending` 以及针对 alpha 测试的显式着色器端 discard |
| 薄实例颜色选择退出 | Lite 单元契约 | 覆写保留矩阵实例化但省略颜色布局、同步和绑定 |

实现应使用下一个可用场景 ID 添加实验室场景，加上一致性规范和 bundle 体积上限。BJS 侧可使用文档中带 GLSL 的 Babylon `ShaderMaterial`；Lite 侧必须使用等价 WGSL 和新版 Lite `ShaderMaterial`。

重点管线共享单元测试使用惰性 GPU 间谍对象和真实材质/视图工厂验证：

- 独立创建材质的默认选择退出及启用共享；
- 保留不同的代码、声明、顶点布局和渲染状态；
- 对已持有另一设备缓存的材质进行当前设备重定向；
- 缓存代次更新，包括源优先的材质视图；
- 每个不可变布局数组标识仅遍历一次，并按相等的替换描述符共享；
- 无记忆化的作用域选择退出，以及跨延迟/重复启用的精确键连续性；
- 复用已编译的作用域缓存，无需重建绑定、模块或管线；
- 在作用域异步编译挂起期间延迟启用，包括所有三种实例变体；
- 普通、薄实例和实例颜色布局的待处理异步去重及已完成同步复用；
- 仅暴露根入口无参数 API，不暴露内部设置器或缓存接口。

这些测试仅验证 CPU 端所有权和缓存契约。它们不声称验证渲染像素、真实 GPU 上的 WGSL 验证、显存减少、bundle 体积变动或性能提升。

仅在授权执行时运行的重点验证命令：

```powershell
pnpm run lint:fix
pnpm run lint
pnpm exec vitest run tests/lite/unit/shader-pipeline-cache.test.ts tests/lite/unit/shader-pipeline-module-memo.test.ts tests/lite/unit/async-shader-pipeline-compilation.test.ts
pnpm exec vitest run tests/lite/build/public-api-types.test.ts -t "pipeline-sharing enabler"
git diff tests/lite/parity/bundle-size.spec.ts
git diff reference/lite/
```

生成的 API 测试需要全新的包构建。CI 负责视觉一致性与全仓库场景覆盖。请勿在代理会话中运行 `pnpm test`、完整一致性测试、未过滤的场景 bundle 或 `pnpm test:perf`。
