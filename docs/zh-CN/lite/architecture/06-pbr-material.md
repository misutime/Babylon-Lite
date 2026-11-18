# 模块：PBR Material

> 包路径：`packages/babylon-lite/src/material/pbr/`
> 文件：`pbr-material.ts`（属性 + 工厂函数）、`pbr-template.ts`（着色器模板）、`pbr-pipeline.ts`（管线缓存）、`pbr-renderable.ts`（可渲染对象构建器与单网格重建闭包）、`pbr-built-variant.ts`（逐网格 `rebuildMaterial()` 检查）、`pbr-flags.ts` / `pbr-flag-bits.ts`（特性标志常量）、`no-color-view.ts`（通道专用的材质视图）、`fragments/singlelight-wgsl.ts`（单灯光 WGSL）、`fragments/multilight-wgsl.ts`（多灯光 WGSL）

## 目的

PBR 操作边界划分明确：`pbr-material.ts` 负责面向用户的类型与材质创建，`pbr-group-builder.ts` 负责延迟场景组构建，`pbr-material-features.ts` 计算原生与已注册扩展的特性位，而 `collect-pbr-bound-textures.ts` 枚举原生与扩展纹理。材质模块保留兼容性重导出，但生产环境调用方应导入具体操作模块，从而避免纹理/特性消费者不必要地保留材质创建或回退纹理安装代码。

PBR 材质模块实现了一个基于物理的渲染材质，包含 GGX 微表面 BRDF、Smith-GGX 高度相关几何函数、Schlick Fresnel、球谐漫反射 IBL、基于 Split-Sum 近似的高光 IBL、法线贴图（切线空间或余切框架）、自发光（纹理及/或统一颜色）、图像处理（曝光、色调映射、对比度）、Kulla-Conty 能量守恒、清漆层（clearcoat）、光泽层（sheen）、金属反射率扩展、高光抗锯齿、骨骼动画、变形目标、精简实例、无循环单灯光路径、通用多灯光循环以及 ESM/PCF 阴影接收。它以与 Babylon.js PBR 输出一致的方式渲染 glTF 金属-粗糙度（metallic-roughness）和镜面-光泽度（specular-glossiness）工作流网格。

着色器通过 `ShaderFragment` / `ShaderComposer` 系统**动态组合** —— 不使用原始 `.wgsl` 文件。`ShaderTemplate`（`pbr-template.ts`）提供带有槽位标记的基础 WGSL；可选的 `ShaderFragment` 模块将代码注入这些槽位。仅组合给定网格特性所需的片段，从而依据体积支柱（Size Pillar）最小化包体积。片段模块在构建时**动态导入**，以便未使用特性被 tree-shake 移除。

`setPbrParallaxOcclusion(material, props)` 可按需启用独立实现的高度图 UV 视差遮蔽位移，采用纹素限制的自适应步进、二分法接触精细化、单级高度读取以及显式梯度表面采样。它保留现有的法线贴图和网格深度。完整 API、求解器、通道行为和限制请参阅[视差遮蔽贴图](parallax-occlusion-mapping.md)。

## ShaderFragment 组合系统

PBR 着色器使用定义在 `src/shader/shader-composer.ts` 中的 `ShaderComposer` 架构构建：

1. **`ShaderTemplate`**（`pbr-template.ts` → `createPbrTemplate()`）—— 提供带有槽位标记（如 `/*MF*/`、`/*AD*/`、`/*AI*/`、`/*AT*/`、`/*SV*/`、`/*VR*/`、`/*VW*/`、`/*VB*/`、`/*BC*/`、`/*BA*/`、`/*BL*/`、`/*NI*/`）的基础顶点/片元 WGSL、基础 UBO 字段、基础顶点属性、基础插值变量（varyings）和基础绑定。

2. **`ShaderFragment`** —— 每个可选特性（IBL、清漆、光泽、阴影、骨骼、变形、自发光颜色、反射率）都是一个片段对象，包含：
    - `id` —— 唯一字符串标识
    - `dependencies` —— 必须先组合的其他片段 ID
    - `fragmentSlots` / `vertexSlots` —— 按槽位名称索引的 WGSL 代码片段
    - `bindings` / `vertexBindings` —— 纹理/采样器/UBO 的 `BindingDecl[]`
    - `uboFields` —— 额外的材质 UBO 字段
    - `vertexAttributes` —— 额外的顶点缓冲区属性
    - `varyings` —— 额外的阶段间插值变量
    - `helperFunctions` / `vertexHelperFunctions` —— WGSL 辅助函数代码
    - `vertexBuiltins` —— 内建输入（如 `vertex_index`）
    - `pipelineVertexBuffers` —— 额外的 GPU 顶点缓冲区布局

3. **`composeShader(template, fragments)`** —— 按依赖对片段进行拓扑排序、合并 UBO 字段、按顺序分配绑定索引、用拼接后的片段代码替换槽位标记，并返回包含最终 WGSL + 绑定组布局描述符 + 顶点缓冲区布局的 `ComposedShader`。

### 组合流程（PBR）

```
pbr-renderable.ts:
  1. Resolves MaterialOrView to source material state + render feature bits
  2. Dynamically imports only needed fragment modules
  3. Calls createPbrTemplate(config) → ShaderTemplate
  4. Calls composeShader(template, fragments) → ComposedShader
  5. Caches ComposedShader per feature bitmask
  6. Passes ComposedShader to getOrCreatePbrPipeline()
```

## 动态特性标志（`pbr-flags.ts`）

仅由单个延迟加载片段使用的比特位在该片段内部声明，并在 `pbr-flag-bits.ts` 中保留其位号：清漆层拥有第 20 位，光泽层拥有其纹理/反照率缩放的第 23 和第 30 位。跨片段共享的位仍保持共享。迁移所有权不会改变任何位值或着色器缓存键。

| 标志                               | 常量      | 条件                      | 着色器效果                                       |
| ---------------------------------- | --------- | ------------------------- | ------------------------------------------------ |
| `PBR_HAS_NORMAL_MAP`               | `1 << 0`  | 网格拥有切线缓冲区        | 切线顶点属性 + 法线纹理 + TBN 变换               |
| `PBR_HAS_EMISSIVE`                 | `1 << 1`  | 材质拥有自发光纹理        | 自发光纹理采样                                   |
| `PBR_HAS_ENV`                      | `1 << 2`  | 已加载环境                | IBL（BRDF LUT + 高光立方体贴图 + SH 辐照度）     |
| `PBR_HAS_TONEMAP`                  | `1 << 4`  | 启用色调映射              | 曝光/对比度/Gamma 后处理                         |
| `PBR_HAS_ALPHA_BLEND`              | `1 << 6`  | 材质启用 Alpha 混合       | Alpha 混合管线状态                               |
| `PBR_HAS_SPEC_GLOSS`               | `1 << 7`  | 镜面-光泽度工作流         | 使用 SpecGloss 纹理替代 ORM                      |
| `PBR_HAS_DOUBLE_SIDED`             | `1 << 8`  | 材质为双面渲染            | `cullMode: 'none'` + 正面朝向法线翻转            |
| `PBR_HAS_COTANGENT_NORMAL`         | `1 << 9`  | 有法线贴图但无顶点切线    | 余切框架法线扰动                                 |
| `PBR_HAS_METALLIC_REFLECTANCE_MAP` | `1 << 10` | 拥有金属反射率贴图        | 反射率纹理采样                                   |
| `PBR_HAS_REFLECTANCE_MAP`          | `1 << 11` | 拥有反射率贴图            | 反射率贴图采样                                   |
| `PBR_HAS_USE_ALPHA_ONLY_MR`        | `1 << 12` | 仅使用 MR 贴图 Alpha 通道 | 仅 Alpha 金属反射率                              |
| 分簇点光源门控（局部）             | `1 << 13` | 分簇点光源状态            | 仅点光源的分簇片段与缓存变体                     |
| 分簇聚光灯门控（局部）             | `1 << 14` | 分簇聚光灯状态            | 支持聚光灯的分簇片段与缓存变体                   |
| `PBR_HAS_OCCLUSION`                | `1 << 15` | 存在遮蔽强度              | 带强度因子的 ORM/独立遮蔽                        |
| `PBR_HAS_SPECULAR_AA`              | `1 << 17` | 高光抗锯齿                | 几何抗锯齿粗糙度调整                             |
| `PBR_HAS_CLEARCOAT`                | `1 << 20` | 启用清漆层                | 清漆 BRDF + 能量守恒                             |
| `PBR_HAS_EMISSIVE_COLOR`           | `1 << 21` | 非零自发光 uniform        | 自发光颜色 uniform 贡献                          |
| `PBR_HAS_SHEEN`                    | `1 << 22` | 启用光泽层                | 光泽 BRDF（Charlie NDF + Ashikhmin 可见性）      |
| `PBR_HAS_SHEEN_TEXTURE`            | `1 << 23` | 光泽层拥有纹理            | 光泽纹理采样                                     |
| 光照贴图门控（局部）               | `1 << 24` | 可选光照贴图纹理          | 光照贴图片段与缓存变体                           |
| `PBR_HAS_GAMMA_ALBEDO`             | `1 << 25` | 基础色处于 Gamma 空间     | Gamma 到线性解码                                 |
| `PBR_HAS_ANISOTROPY`               | `1 << 26` | 启用各向异性              | 各向异性高光 BRDF                                |
| `PBR_HAS_SUBSURFACE`               | `1 << 27` | 启用次表面                | 透光 / 散射 / 体积特性根标志                     |
| `PBR_HAS_THICKNESS_MAP`            | `1 << 28` | 存在厚度纹理              | 厚度纹理采样                                     |
| `PBR_HAS_SKYBOX`                   | `1 << 29` | PBR 天空盒模式            | 直接环境查找                                     |
| `PBR_HAS_SHEEN_ALBEDO_SCALING`     | `1 << 30` | 启用光泽反照率缩放        | 光泽层的能量补偿                                 |

网格/通道特性位位于 `mesh-features.ts` 中（`MSH_HAS_SKELETON`、`MSH_HAS_MORPH_TARGETS`、`MSH_HAS_THIN_INSTANCES`、`MSH_HAS_INSTANCE_COLOR`、`MSH_HAS_VERTEX_COLOR`、`MSH_HAS_UV2`、`MSH_RECEIVE_SHADOWS`）。不要将网格特性重复定义为 `PBR_HAS_*` 或 `PBR2_HAS_*`；网格标志优先。

扩展的 `features2` 比特位承载溢出特性及通道专用特性，包括清漆纹理位、透射/体积、无光照、UV 变换、UV2 遮蔽材质意图（由 `MSH_HAS_UV2` 门控的 `PBR2_HAS_UV2`）、用于折射的线性图像处理，以及用于无颜色材质视图的 `PBR2_NO_COLOR_OUTPUT`。扩展局部的第 29 位专门为光照贴图选择 UV2（与共享的 `PBR2_HAS_UV2` 并列）；光泽粗糙度纹理选择器移至第 31 位，以保持各门控相互独立。

灯光类型位也会通过 `getLightTypeFeatureBits()` 移位并入特性掩码（hemispheric=1，directional=2，point=3）。

基础色 + ORM 纹理始终存在（核心 PBR 工作流）。

PBR 缓存为两级结构：与渲染目标签名无关的着色器绑定按内联键字符串 `${features}:${features2}:${meshFeatures}:${sceneFeatures}:${shaderKey}` 缓存，其中 `shaderKey` 包含色调映射标识和材质插件索引；几何输出组合及逐视图资源同样包含插件索引。每个绑定再按 `targetSignatureKey(sig)`（格式、深度格式、采样数、Y 翻转）缓存签名特定的管线。

## 公共 API 接口

### 材质属性（`pbr-material.ts`）

```typescript
import type { Texture2D } from "../../texture/texture-2d.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";

/** Clearcoat layer properties. */
export interface ClearCoatProps {
    isEnabled?: boolean;
    intensity?: number;
    roughness?: number;
    indexOfRefraction?: number;
    texture?: Texture2D;
    roughnessTexture?: Texture2D;
    bumpTexture?: Texture2D;
    bumpTextureScale?: number;
    useF0Remap?: boolean;
}

/** Sheen layer properties. */
export interface SheenProps {
    isEnabled: boolean;
    color?: [number, number, number];
    roughness?: number;
    intensity?: number;
    texture?: Texture2D;
    albedoScaling?: boolean;
}

export interface AnisotropyProps {
    isEnabled: boolean;
    intensity?: number;
    direction?: [number, number];
}

export interface TranslucencyProps {
    intensity?: number;
    color?: [number, number, number];
    diffusionDistance?: [number, number, number];
}

export interface ScatteringProps {
    diffusionDistance?: [number, number, number];
    metersPerUnit?: number;
}

export interface ThicknessProps {
    texture?: Texture2D;
    useGlTFChannel?: boolean;
    min?: number;
    max?: number;
}

export interface RefractionProps {
    intensity?: number;
    texture?: Texture2D;
    indexOfRefraction?: number;
    useThicknessAsDepth?: boolean;
}

export interface TintProps {
    color?: [number, number, number];
    atDistance?: number;
}

export interface SubSurfaceProps {
    translucency?: TranslucencyProps;
    scattering?: ScatteringProps;
    thickness?: ThicknessProps;
    tint?: TintProps;
    refraction?: RefractionProps;
}

/** User-facing PBR material properties. */
export interface PbrMaterialProps extends Material {
    baseColorTexture?: Texture2D;
    normalTexture?: Texture2D;
    normalTextureScale?: number;
    /** Occlusion-Roughness-Metallic packed: R=occ, G=rough, B=metal. */
    ormTexture?: Texture2D;
    emissiveTexture?: Texture2D;
    specGlossTexture?: Texture2D;
    metallicReflectanceTexture?: Texture2D;
    reflectanceTexture?: Texture2D;
    /** @internal Set via `setPbrEmissive()` — direct assignment skips extension registration. */
    _emissiveColor?: [number, number, number];
    doubleSided?: boolean;
    alpha?: number;
    alphaBlend?: boolean;
    alphaCutOff?: number;
    environmentIntensity?: number;
    directIntensity?: number;
    usePhysicalLightFalloff?: boolean;
    reflectance?: number;
    metallicFactor?: number;
    roughnessFactor?: number;
    occlusionStrength?: number;
    occlusionTexCoord?: number;
    occlusionTexture?: Texture2D;
    bentNormalTexture?: Texture2D;
    bentNormalStrength?: number;
    metallicF0Factor?: number;
    metallicReflectanceColor?: [number, number, number];
    useOnlyMetallicFromMetallicReflectanceTexture?: boolean;
    enableSpecularAA?: boolean;
    gammaAlbedo?: boolean;
    clearCoat?: ClearCoatProps;
    sheen?: SheenProps;
    anisotropy?: AnisotropyProps;
    subsurface?: SubSurfaceProps;
    transmissive?: boolean;
    skyboxMode?: boolean;
    unlit?: boolean;
    unlitColor?: [number, number, number];
}

/** Create a PbrMaterialProps with optional overrides. */
export function createPbrMaterial(props?: Partial<PbrMaterialProps>): PbrMaterialProps;

/** MeshGroupBuilder that dynamically imports pbr-renderable.js. */
export const pbrGroupBuilder: MeshGroupBuilder;

/** Collect all non-null textures for acquire/release tracking. */
export function collectPbrBoundTextures(mat: PbrMaterialProps): Texture2D[];

/** Create a pass-specific no-color material view over a PBR source material. */
export function createPbrNoColorMaterialView(source: PbrMaterialProps): MaterialView;
```

用法：

```typescript
// Manual creation
const mat = createPbrMaterial({
    baseColorTexture: await loadTexture2D(engine, "albedo.png"),
    normalTexture: await loadTexture2D(engine, "normal.png"),
    ormTexture: await loadTexture2D(engine, "orm.png"),
    clearCoat: { isEnabled: true, intensity: 1, roughness: 0.1 },
    sheen: { isEnabled: true, color: [1, 1, 1], roughness: 0.5 },
});

// From glTF (automatic — loadGltf() builds PbrMaterialProps internally)
addToScene(scene, await loadGltf(engine, "model.glb"));
```

### 材质视图与重建

PBR 可渲染对象接受 `MaterialOrView`。普通材质计算并存储 `_renderFeatures = _computePbrMaterialFeatures(mat)`。视图则精确使用 `view._renderFeatures`，同时从 `view.source` 读取所有 uniform/纹理状态。

`createPbrNoColorMaterialView(source)` 创建一个清除 `PBR_HAS_ALPHA_BLEND` 并设置 `PBR2_NO_COLOR_OUTPUT` 的视图。它还像 ESM 阴影视图那样清除仅用于着色的 `PBR_HAS_NORMAL_MAP` 和 `PBR_HAS_SPEC_GLOSS`：深度通道既不读取法线贴图也不读取高光光泽贴图，因此该视图绝不需要它们懒加载的 WGSL，也不绑定这两张纹理。即使在所属组构建之后材质才获得了其中某张贴图，当添加该贴图的组重建尚处于挂起状态时，仍可通过其闭包正常构建该视图。它同样清除 `PBR2_HAS_REFRACTION`：深度通道没有可供绑定的场景颜色抓取纹理，保留该位的视图会将其绑定组推迟等待一个通道绝不会提供的折射纹理，因此透射投射体在此视图下保持为普通不透明投射体。`createPbrGeometryMaterialView` 出于相同原因也会丢弃该位：几何任务同样不抓取场景颜色。这生成了一个无颜色输出的 PBR 管线，适用于需要执行片元阶段（例如 Alpha 测试）而不写入颜色的通道，同时保留源材质的几何相关状态和纹理。

从 `buildPbrRenderables()` 返回的 `rebuildSingle` 闭包会作为 `r` 安装在场景局部组上，同时也会缓存在 `pbrGroupBuilder._rebuildSingle` 上。材质替换、`rebuildMaterial()` 以及逐通道覆写均使用场景局部闭包：构建器级缓存捕获了场景状态，不得被另一个场景中未完成或缺失的组使用。

在 PBR 材质上调用 `rebuildMaterial()` 会重建整个 PBR 组，除非该材质的每一个 PBR 网格都能通过该闭包使用其组构建时已经组合过的变体进行重建；完整生命周期（冷启动、构建时快照、资格判定、逐网格执行、回退）在 27-render-pipeline 的“PBR 材质重建生命周期”中详述。

### 管线（`pbr-pipeline.ts`）

```typescript
/** Compute PBR feature bitmask from mesh/material/scene capabilities. */
export function computePbrFeatures(...): number;

/** Get or create sig-independent PBR shader bindings. */
export function getOrCreatePbrBindings(
  engine: EngineContextInternal, features: number, features2: number,
  meshFeatures: number, sceneFeatures: number,
  composed: ComposedShader, shaderKey?: string,
): _PbrShaderBindings;

/** Get or create a cached PBR pipeline for a render-target signature. */
export function getOrCreatePbrPipeline(
  engine: EngineContextInternal, sig: RenderTargetSignature, bindings: _PbrShaderBindings,
): GPURenderPipeline;

/** Create per-mesh bind group (group 1) with textures matching the composed shader layout. */
export function createPbrMeshBindGroup(
  engine: EngineContextInternal, bindings: PbrShaderBindings, composed: ComposedShader,
  meshUBO: GPUBuffer, materialUBO: GPUBuffer, material: PbrMaterialProps,
  env: EnvironmentTextures | null,
  meshCtx: { skeleton?: { boneTexture: GPUTexture } | null; morphTargets?: { texture: GPUTexture; weightsBuffer?: GPUBuffer } | null } | null,
): GPUBindGroup;

export function clearPbrPipelineCache(): void;
```

### 模板（`pbr-template.ts`）

```typescript
/** Full configuration for PBR template generation. */
export interface PbrTemplateConfig {
    // Light configuration
    _hasSingleLight?: boolean;
    _hasMultiLight?: boolean;
    _singleLightWGSL?: string;
    _singleLightBlock?: string;
    _multiLightWGSL?: string;
    _multiLightLoop?: string;
    // Feature booleans
    _normalMode?: "tangent" | "cotangent" | "none";
    _hasEmissiveTexture?: boolean;
    _hasSpecGloss?: boolean;
    _hasDoubleSided?: boolean;
    _hasTonemap?: boolean;
    _acesHelpers?: string;
    _acesTonemapCall?: string;
    _hasAlphaBlend?: boolean;
    _hasSpecularAA?: boolean;
    _hasGammaAlbedo?: boolean;
    _hasMorph?: boolean;
    _hasOcclusion?: boolean;
    _hasEmissiveColor?: boolean;
    _hasReflectanceExt?: boolean;
    _hasIbl?: boolean;
    _hasAnisotropy?: boolean;
    _anisoBrdfFunctions?: string;
    _anisoTBBlock?: string;
    _ext?: PbrTemplateExt;
    _noColorOutput?: boolean;
    _esmShadowOutput?: boolean;
    _esmShadowDepthCode?: string;
}

/** Create a ShaderTemplate from PBR configuration. */
export function createPbrTemplate(config: PbrTemplateConfig): ShaderTemplate;
```

### 可渲染对象构建器（`pbr-renderable.ts`）

```typescript
/** Build PBR renderables from mesh data. */
export function buildPbrRenderables(
  scene: SceneContext, meshes: Mesh[], envTextures: EnvironmentTextures | undefined,
): Promise<MeshGroupBuildResult>;

/** Internal helper used by the captured single-mesh rebuild closure. */
export function _createPbrMeshUBO(...): GPUBuffer;
```

## 片段模块

所有片段均位于 `src/material/pbr/fragments/`，并导出返回 `ShaderFragment` 对象的工厂函数。

### `ibl-fragment.ts` — IBL 环境光照

- **工厂**：`createIblFragment(hasNormalMap: boolean): ShaderFragment`
- **ID**：`"ibl"`
- **绑定**：`brdfLUT`（texture2D）、`brdfSampler_`（sampler）、`iblTexture`（立方体纹理）、`iblSampler`（sampler）
- **辅助 WGSL**：`environmentHorizonOcclusion()`、`getEnergyConservationFactor()`、`rotateY()`
- **片元槽位**：
    - `AI` —— 完整 IBL 计算：反射向量、BRDF LUT 采样、高光辐射度、SH 辐照度、地平线遮蔽、能量守恒
    - `BA` —— 用于 Alpha 混合的亮度叠加（luminance-over-alpha）累积

### `local-cubemap-fragment.ts` — 逐材质与有界局部 IBL（可选启用）

- **启用/初始化**：在加载任何将用作探针的 DDS 或 HDR 环境、创建探针集或注册场景之前，调用 `await enablePbrLocalCubemap({ maxCandidates })`。`maxCandidates` 默认为 4，接受 1–12，并在首次调用后固定。
- **零开销默认**：状态、WGSL、资源打包与绑定逻辑仅从 `enable-pbr-local-cubemap.ts` 及其动态片段导入可达。普通 PBR 材质保留原有的 IBL 着色器和绑定。
- **公共赋值接口**：
    - `setPbrEnvironment(material, environment)` 为单个材质选择无视差校正的专属立方体贴图。
    - `setPbrLocalEnvironment(material, environment, options)` 选择单个盒式或球形投影的立方体贴图。`capturePosition` 可以与 `projectionPosition` 不同；为保持向后兼容，其默认值为投影中心。
    - `setPbrLocalEnvironmentProbeSet(material, set)` 选择按片元加权的局部探针。
    - `clearPbrLocalEnvironment(material)` 移除上述任意私有可选赋值。
- **绑定生命周期**：请在 `registerScene()` 之前配置赋值。在可渲染对象存在之后，修改或清除赋值后需调用 `rebuildMaterial(scene, material)`。
- **材质视图**：局部环境状态通过视图的源材质解析，因此几何通道及其他通道视图无需拷贝即可组合、写入并绑定相同的赋值。
- **通道变体**：无颜色、ESM 阴影与天空盒变体特意跳过局部 IBL 重写，因为它们不包含常规的着色 IBL 目标。当存在场景环境时，仍通过既有路径为这些变体服务。
- **分层 IBL**：即使场景没有全局环境，局部环境也计为激活的 IBL。因此清漆、光泽、次表面、无光照及 Alpha 亮度合成都会与基础 PBR 层一样使用同一张局部立方体贴图或混合后的探针辐射度。
- **设备替换**：当引擎获取替换 GPU 设备时，探针集纹理、uniform/存储缓冲区、视图、采样器和占位绑定会惰性重建。源 `EnvironmentTextures` 必须已指向针对该设备恢复后的资源。
- **特性变体**：主 PBR 位 31 门控单个局部环境片段。材质 UBO 模式在运行时选择无投影、盒式、球形或探针数组行为，避免与光照贴图和光泽特性位冲突，同时使实现代码不进入未启用该功能的打包产物中。
- **单个局部环境**：指派的环境提供预过滤高光辐射度、BRDF LUT、漫反射球谐系数及 LOD 缩放。有限投影将反射射线与配置的盒体或球体求交，随后使用从独立的 `capturePosition` 指向该交点的向量采样立方体贴图。
- **探针集漫反射光照**：纹理数组替换高光辐射度。当存在场景环境时，漫反射辐照度使用场景球谐系数；否则使用第一个探针的球谐系数。探针辐照度特意不进行混合。
- **探针数组**：`createPbrLocalEnvironmentProbeSet()` 将每个探针复制到单个 `texture_cube_array<f32>` 中。源纹理须共享同一格式且具有 2 的幂次相关正方形尺寸。目标使用最小尺寸；较大的源纹理贡献匹配的较低 mip 级别，因此无需重采样通道。该数组使用引擎去重后的三线性采样器，而不依赖任意源环境的采样器标识。源立方体贴图必须包含 `COPY_SRC` 用途。内建 `.env` 加载器始终包含它；DDS 和 HDR 加载器仅在调用 `enablePbrLocalCubemap()` 之后加载的环境中包含它。更早加载的环境必须重新加载，不支持的自定义环境会同步拒绝并报出相同的调用顺序要求错误。
- **共享探针 UBO**：每个探针占用七个 `vec4`：投影中心/层索引、投影半尺寸/LOD 缩放、捕获位置/LOD 偏置、内部影响中心/偏航角余弦、内部半尺寸/偏航角正弦、外部影响中心以及外部半尺寸/打包元数据。最后一个字存储 RGB8 调试颜色及球体标志。因此 WebGPU 保证的 64 KiB uniform 绑定在固定头部之后可容纳 585 个探针。
- **独立的影响中心**：`influencePosition` 定位内部全权重体积中心。盒式探针可独立设置 `influenceOuterPosition`；默认值为内部中心。校验逻辑将其偏移变换到探针的偏航局部坐标系中，并要求内部盒完全包含在外部盒内。
- **世界空间体素查找**：每个集合拥有一个稠密的只读存储缓冲区。其头部存储网格最小值、体素尺寸倒数、网格维度和固定单元步长；每个单元存储一个计数及随后最多 `maxCandidates` 个探针索引。CPU 体素化使用外部中心与精确的偏航定向盒/AABB 或球体/AABB 相交测试。溢出会抛出异常而非丢弃探针，空单元则分配单元中心处确定性的最近探针。
- **非对称盒式影响**：片元将 `worldPos - influencePosition` 旋转到探针局部空间。对于每个轴，朝向负边界或正边界的衰减跨度会并入内外中心之间的有符号偏移。盒式 NDF 为各轴最大值；球体则使用 `(distance - innerRadius) / (outerRadius - innerRadius)`。命中内部获得全权重，仅命中一个外部获得全权重，重叠的外部命中采用归一化混合权重，位于所有外部体积之外的点则采样无界 NDF 最小的候选探针。
- **限制**：立方体数组数量还受限于 `maxTextureArrayLayers / 6`；稠密网格必须适配 `maxBufferSize` 与 `maxStorageBufferBindingSize`。在分配逐单元 CPU 数组之前会检查网格维度和字节大小。创建探针集会在测量网格前锁定当前的 `maxCandidates`，因此必须先通过 `enablePbrLocalCubemap({ maxCandidates })` 配置自定义值；溢出的单元始终抛出异常而非截断。
- **诊断**：`setPbrLocalEnvironmentProbeDebug(set, true)` 保留生产环境的影响权重计算，但将立方体贴图采样和最终 PBR 输出替换为加权打包后的探针颜色。
- **测试覆盖**：场景 186 对比了逐材质无投影环境、硬有限投影以及混合探针（含影响权重调试可视化）。它设置了 `skipParity`，因为 Babylon.js 没有等价的片元加权局部立方体数组混合功能。
- **参考资料**：
    - Shadertoy 参考实现：<https://www.shadertoy.com/view/DtlBWn>
    - Sébastien Lagarde, _Local Image-based Lighting with Parallax-Corrected Cubemaps_: <https://dl.acm.org/doi/10.1145/2343045.2343094>

### `bent-normal-fragment.ts` — 弯曲法线反射遮蔽（可选启用）

移植自 BJS `PBRMaterial.bentNormalTexture`（`BENTNORMAL` 宏定义，Babylon.js PR #19069）。**显式按需启用**：在 `registerScene` 之前调用一次 `enableBentNormals()`。未调用该函数时设置 `bentNormalTexture` 不会产生任何效果。`pbr-renderable.ts` 与 `ibl-fragment.ts` 均不引用此模块，因此未启用的场景承担零字节开销。

- **API**：`enableBentNormals(): void` —— 幂等且全局生效。它就地增强导出的 IBL `pbrExt` 对象（添加 `detect`、`writeUbo` 和 `textures`，并包装 `frag` 和 `bind`）。之所以采用就地增强而非注册独立扩展，是因为必须修改 IBL `AI` 代码（后续如清漆、光泽和折射片段会基于其中的局部变量重新计算）且 `pbr-renderable` 在构建时会按 ID 重新注册 `"ibl"` 扩展。
- **工厂**：`createBentNormalFragment(reuseTbn: boolean, doubleSided: boolean): ShaderFragment` —— 合并到 IBL 片段中（同 ID `"ibl"`），弯曲法线绑定追加在 IBL 绑定之后。
- **标志**：`PBR_HAS_BENT_NORMAL` —— 弯曲法线局部的材质 `features` 位（`1 << 4`，在片段模块内部声明并在 `pbr-flag-bits.ts` 中保留；由于 `PBR_HAS_TONEMAP` 仅存在于 `sceneFeatures` 中，该位在 `features` 中可用）。当材质受光照、非天空盒模式、拥有 `bentNormalTexture` 且拥有 `occlusionStrength > 0` 的 AO 纹理（`ormTexture` 或 `occlusionTexture`）时，由 `detect` 置位 —— 镜像了 BJS 要求存在环境光遮蔽纹理的条件。仅当 IBL 激活时生效。
- **UBO**：`bentNormalParams: vec4<f32>` —— `.x` 为强度（使用 `saturate` 限幅，映射到 BJS `bentNormalTexture.level`）。使用完整的 `vec4` 以保持后续片段写入器（如反射率）所假设的 16 字节对齐。
- **绑定**：`bentNormalTexture_`、`bentNormalSampler_`
- **辅助 WGSL**：`bentNormalSGOverlap()`、`bentNormalSGOcclusion()`、`environmentBentNormalOcclusion()` —— 围绕弯曲法线的 AO 可见锥体与 GGX 反射波瓣之间的球面高斯重叠，并按开放半球重叠度归一化。
- **片元槽位**：
    - `AC` —— 构建切线框架（仅当法线贴图使用 UV1 且无 UV 变换时才复用顶点 `TBN`，使其切线与弯曲法线贴图的基一致 —— 镜像 BJS 的 `BENTNORMALDIRECTUV && BUMPDIRECTUV` 门控；否则使用屏幕空间余切框架），从切线空间贴图解码 `bentNormalW`（使用 UV1 采样），仅应用一次双面背面翻转（在顶点 TBN 路径上显式翻转；余切框架基于已翻转的 `N_geom` 和取反的 UV 构建，等价于 BJS 的翻转），并为 IBL `AI` 代码定义 `bentNormalStrength`。
    - `AI` —— 对 IBL `AI` 代码进行字符串修补：从 `colorSpecularEnvReflectance` 中移除解析高光遮蔽（`seo`），并在能量守恒前将环境辐射度乘以 `mix(1, environmentBentNormalOcclusion(...), bentNormalStrength)`。搜索/替换字符串均带有 `wgsl` 标签，以便打包器的 WGSL 压缩器能将其与 IBL 源码完全一致地重写。
- **切线框架**：当存在法线贴图与顶点切线且无精简实例时复用模板的顶点 `TBN`；否则使用与基础法线贴图相同的约定从 `N_geom` 构建屏幕空间余切框架（取反副切线、背面镜像 UV；在右手系构建中两个轴均反转）。
- **与 BJS 的已知差异**：需要显式调用 `enableBentNormals()`；弯曲法线纹理始终采样 UV1 且不应用 UV 变换；有切线但无法线贴图的网格使用余切框架（BJS 会复用 vTBN，而 Lite 仅在法线贴图路径发射它）；未镜像 BJS 的非均匀缩放检查（Lite 没有非均匀缩放网格特性；其基础法线贴图也未镜像该检查）；天空盒模式材质忽略弯曲法线纹理。
- **纹理发现 / MeshLoD**：`getMaterialTextures()` 在其他 PBR 槽位之后列出 `bentNormalTexture`。MeshLoD 会以 `MLOD_UNSUPPORTED_MATERIAL`（`actual: "bent normals"`）拒绝弯曲法线材质，因为其着色器路径不运行 IBL 扩展。
- **一致性场景**：场景 230（`scene230-bent-normals`），源自 BJS PG `#ZH5HB3#3`，及其右手系孪生场景 353（`scene353-rh-bent-normals`）。

### `clearcoat-fragment.ts` — 清漆层

- **工厂**：`createClearcoatFragment(hasIbl: boolean, hasReflectance?: boolean): ShaderFragment`
- **ID**：`"clearcoat"`
- **依赖**：当 `hasIbl` 时依赖 `["ibl"]`，当 `hasReflectance` 时依赖 `["reflectance"]`
- **辅助 WGSL**：`visibility_Kelemen()`、`getR0RemappedForClearCoat()`
- **片元槽位**：
    - `MF` —— 使用来自 `mesh.ccParams` / `mesh.ccRefractionParams` 的清漆 IOR/折射参数重映射基础 F0
    - `BL` —— 初始化直接清漆衰减/高光变量
    - `AD` —— 直接清漆 BRDF（GGX NDF + Kelemen 可见性 + Fresnel）
    - `AI`（IBL 路径）—— 为清漆环境反射采样 IBL，应用 Jones 风格能量守恒
    - `NI`（非 IBL 路径）—— 非 IBL 清漆能量守恒

### `sheen-fragment.ts` — 光泽层

- **工厂**：`createSheenFragment(hasSheenTexture: boolean, hasIbl?: boolean): ShaderFragment`
- **ID**：`"sheen"`
- **依赖**：当 `hasIbl` 时依赖 `["ibl"]`
- **辅助 WGSL**：`normalDistributionFunction_CharlieSheen()`、`visibility_Ashikhmin()`
- **片元槽位**：
    - `SV` —— 初始化光泽局部变量（`sheenDirectTerm`、`sheenIblTerm`、`sheenAlbedoScaling`、`sheenColorFinal`、`sheenRoughnessAdjusted`）；可选采样光泽纹理
    - `AD` —— 通过 Charlie NDF + Ashikhmin 可见性计算直接光泽高光项
    - `AI`（IBL 路径）—— 从 `iblTexture` 和 `brdfLUT` 计算 IBL 光泽反射
    - `NI`（非 IBL 路径）—— 仅计算直接光泽

### `reflectance-fragment.ts` — 金属反射率扩展

- **工厂**：`createReflectanceFragment(hasMetallicReflectanceMap: boolean, hasReflectanceMap: boolean, useAlphaOnlyMR: boolean): ShaderFragment`
- **ID**：`"reflectance"`
- **绑定**：按需包含 `metallicReflectanceMap` + 采样器、`reflectanceMap` + 采样器
- **片元槽位**：
    - `MF` —— 计算 `mrFactors`、电介质 F0、表面反射率、`colorF0`/`colorF90`、表面反照率
    - `AT` —— 使用 `mesh.occlusionStrength` 从 ORM 计算遮蔽

### `emissive-fragment.ts` — 自发光颜色 Uniform

- **工厂**：`createEmissiveColorFragment(hasEmissiveTexture: boolean): ShaderFragment`
- **ID**：`"emissive-color"`
- **片元槽位**：
    - `AT` —— 从 `mesh.emissiveColor` 设置 `emissive`，可选乘以自发光纹理采样值

### `lightmap-fragment.ts` — 烘焙光照贴图（可选启用）

- **公共 API**：在 `registerScene()` 之前调用 `await enablePbrLightmap()`，随后通过 `setPbrLightmap(material, texture, options)` 赋值纹理。
- **Tree-shaking**：启用调用动态导入并注册片段。常驻加载的 PBR 可渲染对象构建器从不扫描光照贴图，因此未启用的场景不保留任何光照贴图实现代码。
- **特性变体**：主位 24 门控光照贴图是否存在，扩展位 29 选择光照贴图 UV2，主位 16/18/19 选择阴影贴图合成、Gamma 解码以及有效 V 翻转。分簇点/聚光灯光照保留主位 13/14。光照贴图局部比特位在不与这些光照门控重叠的前提下参与正常的 PBR 着色器缓存键。
- **UV 选择**：`setPbrLightmap()` 拥有 `_uv2Mask` 的第 64 位；这复用了现有的 `TEXCOORD_1` 属性/插值路径，同时保留所有其他通道的声明。
- **UBO 与绑定**：贡献 `lmLvl`、`lmTexture` 和 `lmSampler`。
- **合成**：`NI` 槽位默认叠加解码后的采样值，或在开启 `useLightmapAsShadowmap` 时乘以受光结果同时保留自发光。依赖顺序将其置于无光照、光泽、折射和次表面最终颜色重建之后。
- **朝向**：V 翻转条件为 `texture.invertY XOR (texture.uAng === Math.PI)`，与处理上传翻转及编解码器解码纹理的 Standard 纹理路径一致。
- **测试覆盖**：`pbr-lightmap.test.ts` 覆盖特性检测、UV 回退、合成顺序、UBO/绑定以及纹理枚举；场景 167 覆盖 UV1/UV2、叠加/阴影贴图、Gamma 解码及 V 翻转一致性。

### `morph-fragment.ts` — 变形目标

- **工厂**：`createMorphFragment(): ShaderFragment`
- **ID**：`"morph"`
- **顶点内建输入**：`vertex_index`（`u32`）
- **顶点绑定**：`morphTargets`（texture2D，不可过滤）、`morph`（包含 weights/count/texWidth/rowsPerBand 的 uniform 缓冲区）
- **顶点槽位**：
    - `VR` —— 遍历变形目标，从变形纹理累加位置/法线增量

### `skeleton-fragment.ts` — 骨骼动画

- **工厂**：`createSkeletonFragment(has8Bones: boolean): ShaderFragment`
- **ID**：`"skeleton"`
- **顶点属性**：`joints`、`weights`（8 骨骼时另加 `joints1`、`weights1`）
- **顶点绑定**：`boneSampler`（texture2D，不可过滤）
- **辅助 WGSL**：`readMatrixFromRawSampler()`
- **顶点槽位**：
    - `VW` —— 读取骨骼矩阵，混合 4 或 8 个骨骼影响，设置 `finalWorld = mesh.world * influence`

### `pbr-shadow-fragment.ts` — 阴影接收

- **工厂**：`createPbrShadowFragment(shadowLights: PbrShadowLightSlot[]): ShaderFragment`
- **ID**：`"pbr-shadow"`
- **接口**：`PbrShadowLightSlot { lightIndex: number; shadowType: "esm" | "pcf" }`
- **插值变量**：逐灯光 `vPosFromLight_<n>`（`vec4<f32>`）、`vDepthMetric_<n>`（`f32`）
- **绑定**：逐灯光阴影纹理 + 采样器 + `shadowInfo_<n>` uniform 缓冲区（组 `"shadow"`）
- **顶点槽位**：
    - `VB` —— 将世界位置变换到灯光空间，计算深度度量
- **片元槽位**：
    - `AD` —— 通过 ESM 或 PCF 计算逐灯光阴影因子，写入 `shadowFactors[lightIndex]`
- 支持为每个灯光分别配置 ESM（`computeShadowESM_<n>`）和 PCF（`computeShadowPCF_<n>`）阴影模式。

## PBR 光照 WGSL

PBR 光照消费共享的 `render/lights-ubo.ts` 缓冲区。光照代码仍采用动态导入，使场景仅获取所需的着色器辅助模块：

| 辅助模块                        | 加载时机                       | 导出                                                                |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `fragments/singlelight-wgsl.ts` | 恰好一个场景灯光且无阴影接收体 | `SINGLE_LIGHT_STRUCTS`、`getSingleLightBlock(lightType)`            |
| `fragments/multilight-wgsl.ts`  | 超过一个灯光，或存在任何阴影接收体 | `MULTI_LIGHT_STRUCTS()`、`COMPUTE_PBR_LIGHT`、`getMultiLightLoop()` |

单灯光辅助模块为半球光、方向光、点光源或聚光灯生成特化的无循环 WGSL，并读取网格选中的灯光索引。多灯光辅助模块生成 `computePbrLight()` 加上遍历网格选中灯光索引的循环；它还为直接光照片段（`clearcoat`、`sheen`、`subsurface`）暴露首灯光别名，并支持由 `pbr-shadow-fragment.ts` 写入的阴影因子。

`usePhysicalLightFalloff` 默认为 `true`，匹配 Babylon.js PBR 的物理平方反比点光源/聚光灯衰减。当设为 `false` 时，点光源和聚光灯改用 Babylon 的 Standard 风格衰减：线性范围衰减和聚光灯圆锥指数衰减。场景 22 使用此路径来镜像 Babylon.js 参考中的 `PBRMaterial.usePhysicalLightFalloff = false`。

## 管线配置

### 顶点缓冲区（随特性变化）

基础顶点缓冲区由模板定义。片段模块添加额外属性：

**基础（始终存在）：**

| 槽位 | 属性     | 格式        | 步长    | 着色器 Location |
| ---- | -------- | ----------- | ------- | --------------- |
| 0    | Position | `float32x3` | 12 字节 | `@location(0)`  |
| 1    | Normal   | `float32x3` | 12 字节 | `@location(1)`  |
| 2    | UV       | `float32x2` | 8 字节  | `@location(2)`  |

**条件属性（由模板或片段追加，location 索引由组合器分配）：**

| 属性                                        | 来源                     | 启用条件                            |
| ------------------------------------------- | ------------------------ | ----------------------------------- |
| Tangent (`float32x4`)                       | 模板                     | `PBR_HAS_NORMAL_MAP`（切线模式）    |
| Joints (`uint16x4`) + Weights (`float32x4`) | `skeleton-fragment`      | `MSH_HAS_SKELETON`                  |
| Joints1 + Weights1                          | `skeleton-fragment`      | `MSH_HAS_SKELETON_8`                |
| Instance matrix (4× `float32x4`)            | `thin-instance-fragment` | `MSH_HAS_THIN_INSTANCES`            |
| Instance color (`float32x4`)                | `thin-instance-fragment` | `MSH_HAS_INSTANCE_COLOR`            |

### 管线状态

| 设置     | 值                                                            |
| -------- | ------------------------------------------------------------- |
| 拓扑     | `triangle-list`                                               |
| 剔除模式 | `back`（若为 `PBR_HAS_DOUBLE_SIDED` 则为 `none`）             |
| 正面绕序 | `ccw`                                                         |
| 深度格式 | `depth24plus-stencil8`                                        |
| 深度比较 | `greater-equal`                                               |
| 深度写入 | `true`（Alpha 混合变体禁用）                                  |
| MSAA     | `count = msaaSamples` (4)                                     |
| 颜色目标 | 画布首选格式，若为 `PBR_HAS_ALPHA_BLEND` 则开启 Alpha 混合    |

### 绑定组布局

**Group 0 — 场景 Uniform**（所有材质共享）：

| Binding | 可见性             | 类型                                     |
| ------- | ------------------ | ---------------------------------------- |
| 0       | VERTEX \| FRAGMENT | Uniform 缓冲区（大小随特性变化）         |

**Group 1 — PBR 网格**（动态，绑定索引由 `ShaderComposer` 分配）：

Binding 0 始终为网格 UBO（VERTEX+FRAGMENT）。后续绑定由组合器根据激活的片段按顺序分配。顺序遵循片段的拓扑排序：

- 网格 UBO —— 始终存在（binding 0）
- 变形目标纹理 + UBO —— 若存在 `MSH_HAS_MORPH_TARGETS`
- 骨骼采样器纹理 —— 若存在 `MSH_HAS_SKELETON`
- 基础色纹理 + 采样器 —— 始终存在
- 法线纹理 + 采样器 —— 若存在 `PBR_HAS_NORMAL_MAP`
- ORM 纹理 + 采样器 —— 始终存在（或 specGloss 纹理）
- 自发光纹理 + 采样器 —— 若存在 `PBR_HAS_EMISSIVE`
- BRDF LUT + 采样器 + IBL 立方体贴图 + 采样器 —— 若存在 `PBR_HAS_ENV`
- 反射率贴图 + 采样器 —— 若存在反射率扩展
- 光泽纹理 + 采样器 —— 若存在 `PBR_HAS_SHEEN_TEXTURE`
- 光照贴图纹理 + 采样器 —— 若激活了可选的 PBR 光照贴图扩展

**Group 2 — 阴影**（仅当 `MSH_RECEIVE_SHADOWS`）：

逐灯光的阴影信息 UBO、阴影纹理和阴影采样器。

## `_buildGroup` 模式

`pbr-material.ts` 导出 `pbrGroupBuilder`，这是一个在构建时动态导入 `pbr-renderable.js` 的 `MeshGroupBuilder` 函数。该函数作为 `_buildGroup` 字段设置在 `createPbrMaterial()` 创建的每个 PBR 材质上。在 `startEngine()` 时，`scene.ts` 调用每个网格的 `material._buildGroup`，按构建器标识对网格进行分组，从而将所有 PBR 网格合批交由单次 `buildPbrRenderables()` 调用处理。

构建器将返回的 `rebuildSingle` 闭包保存在 `pbrGroupBuilder._rebuildSingle` 上。该闭包在 `pbr-renderable.ts` 中捕获构建时的状态，复用初次构建时的场景缓存，用于在更换材质、调用 `rebuildMaterial()` 或通过 `addMeshToTask(task, mesh, { material })` 覆盖单个渲染通道的材质时重建单个网格。

## 可见环境天空盒可选项

可见的 HDR 和 DDS 天空盒各自拥有一个规范的可渲染对象构建器：

- `buildHdrSkyboxRenderable`
- `buildDdsSkyboxRenderable`

当启用某个可选环境特性时，构建器会基于一个固定核心对其片元着色器进行修补。它们从不选择或导入替代的可渲染对象构建器。

两个公共场景 setter 提供各自独立的可选开启接口：

```ts
setEnvironmentBlur(scene: SceneContext, blur: number): void;
setEnvironmentRotation(scene: SceneContext, rotation: number): void;
```

`setEnvironmentRotation` 会同时旋转基于图像的光照（IBL）和可见天空盒。另外两个粒度更细的 setter 将其拆分，供希望天空盒保持自身朝向而仅旋转光照的调用方使用（Babylon.js 是基于环境纹理的克隆体构建 `createDefaultSkybox` 的，因此后续的 `rotationY` 修改不会作用于它）：

```ts
setEnvironmentLightingRotation(scene: SceneContext, rotation: number): void; // lighting only, never registers the skybox patch
setEnvironmentSkyboxRotation(scene: SceneContext, rotation: number): void; // skybox only, angle compiled into the shader
```

`setEnvironmentSkyboxRotation` 填充与 `setEnvironmentRotation` 相同的方向槽位，因此在天空盒构建之前最后调用的那一个将决定天空盒补丁。其角度在构建时固定。

每个 setter 都在存储于该场景上的、与特性无关的组合器中的一个有序组合槽位中注册一个由特性拥有的补丁加载器。因此无论 setter 调用顺序如何，旋转总是先于模糊应用。配置一个场景绝不会激活另一个场景的特性。

规范构建器仅包含一次对场景局部组合器的可选调用。它们不导入该组合器或任一特性补丁，从而使未启用特性的天空盒消费者保持在规范构建器基准体积。这遵循了无需全局注册表的 PBR/Standard 扩展原则：通用组合代码仅由导入了环境特性 setter 的消费者保留。

核心天空盒着色器有两个组合槽位：

| 槽位 | 默认值             | 可选贡献                                                                                                                               |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 方向 | 归一化立方体方向   | `setEnvironmentRotation` 使用场景 uniform `envRotationY` 绕 Y 轴旋转采样方向；`setEnvironmentSkyboxRotation` 改用编译进着色器的固定角度 |
| LOD  | Mip 级别 `0.0`     | `setEnvironmentBlur` 根据 blur、立方体贴图尺寸、scale 和 offset 计算限幅后的小数立方体贴图 LOD                                         |

模糊补丁与旋转补丁是相互独立的模块。导入其中一个 setter 不会保留另一个补丁。旋转注册仅在可见天空盒构建期间场景局部组合器首次运行时才加载其补丁，而模糊注册则解析其静态导入的补丁。仅使用光照的消费者不会获取旋转补丁。

对任一 setter 的首次调用必须发生在可见天空盒构建之前，以便其着色器变体包含相应的补丁。后续调用直接更新场景 uniform 数据并在不重建天空盒的情况下生效。

## 内部架构

### 场景 Uniform 缓冲区布局（Group 0，Binding 0）

PBR 使用与 Standard/材质无关通道共享的规范 `SceneUniforms`。该结构体大小固定（`SCENE_UBO_BYTES = 352`），声明于 `packages/babylon-lite/shaders/scene-uniforms.wgsl`。它包含视图/投影矩阵、相机位置、环境旋转、SH 辐照度、图像处理字段以及雾效字段。

为了对齐和着色器兼容性，环境旋转槽位仍保留在此固定布局中，但基础场景打包器和缓存键并不读取它。旋转完全由 setter 驱动：`setEnvironmentRotation` 拥有内部场景值、延迟天空盒补丁注册、贡献者注册以及任务缓存失效；`setEnvironmentLightingRotation` 执行相同操作但不带天空盒补丁。环境加载器为 SH 数据注册相同的贡献者，而 glTF 基于图像的灯光可从资产元数据初始化该内部值。

灯光数据**不**存储在 `SceneUniforms` 中。当启用 `_hasSingleLight` 或 `_hasMultiLight` 时，PBR 直接光照从 group 0 binding 1 读取场景所属的 `LightsUniforms` UBO。

### 网格 Uniform 缓冲区布局（Group 1，Binding 0）

基础字段（始终存在）：

| 偏移（字节） | 大小                        | WGSL 类型                                | 字段                                               |
| ------------ | --------------------------- | ---------------------------------------- | -------------------------------------------------- |
| 0            | 64                          | `mat4x4<f32>`                            | `world`                                            |
| 64           | 4                           | `u32`                                    | `lc`                                               |
| 80..         | `ceil(MAX_LIGHTS / 4) × 16` | `array<vec4<u32>, ceil(MAX_LIGHTS / 4)>` | 索引至 group-0 `LightsUniforms` 的打包灯光索引     |

由片段追加的额外字段：

| 字段                                                                | 类型                      | 片段                   |
| ------------------------------------------------------------------- | ------------------------- | ---------------------- |
| `metallicReflectanceColor`, `metallicF0Factor`, `occlusionStrength` | `vec3<f32>`, `f32`, `f32` | `reflectance-fragment` |
| `emissiveColor`                                                     | `vec3<f32>`               | `emissive-fragment`    |
| `ccParams`, `ccRefractionParams`                                    | `vec4<f32>`, `vec4<f32>`  | `clearcoat-fragment`   |
| `sheenParams`, `sheenParams2`                                       | `vec4<f32>`, `vec4<f32>`  | `sheen-fragment`       |

精确布局由 `computeUboLayout()` 根据合并后的 UBO 字段列表计算得出。

### 管线缓存

`getOrCreatePbrPipeline` 为每个 `PbrShaderBindings` 维护一个 `Map<targetSignatureKey(sig), GPURenderPipeline>`。绑定组布局在跨签名时保持稳定（仅管线本身依赖 `sig`），因此网格绑定组对于同一个 `(features, features2)` 绑定实例所生成的任何管线都是合法的。

### 着色器模板（`pbr-template.ts`）

`createPbrTemplate(config)` 构建一个带有以下内容的 `ShaderTemplate`：

- **顶点模板** —— 世界变换、可选 TBN（切线或余切）、UV 透传，以及用于变形（`/*VR*/`）、蒙皮（`/*VW*/`）、阴影（`/*VB*/`）的槽位标记
- **片元模板** —— 纹理采样、BRDF 函数（始终包含：GGX NDF、Smith-GGX 几何函数、Schlick Fresnel）、可选高光 AA、可选 Gamma 解码，以及用于材质准备（`/*MF*/`、`/*SV*/`、`/*BL*/`）、直接光照（`/*AD*/`）、IBL（`/*AI*/` 或 `/*NI*/`）、后处理效果（`/*AT*/`、`/*BC*/`、`/*BA*/`）的槽位标记
- 用于网格灯光选择数据的**基础 UBO 字段**以及用于常驻纹理的**基础绑定**；直接光照使用固定的 group-0 灯光 UBO

通过 `_hasSpecGloss` 同时支持金属-粗糙度和镜面-光泽度工作流。

### 已组合着色器缓存

`pbr-renderable.ts` 维护按材质特性、扩展特性、网格特性、场景特性、光照模式和着色器变体键索引的已组合着色器缓存。从初始构建返回的 `rebuildSingle` 闭包复用同一个捕获的组合器。

组合器（`pbr-compose.ts` 中的 `createPbrComposer`）以 `_pbrComposeKey(features, features2, meshFeatures, sceneFeatures, lightMode, singleLightType, vbKey, uv2Mask, pluginIndex)` = `` `${features}:${features2}:${meshFeatures}:${sceneFeatures}:${lightMode}:${singleLightType}${vbKey}:${uv2Mask}:${pluginIndex}` `` 为键缓存每个变体，并将其作为只读属性 `composePbr._c` 暴露。在构建网格后，`buildPbrRenderables()` 会立即将这些键快照存入 `_PbrGeometryContext._b`（`ReadonlySet<string>`）。之后通过闭包组合的键不会加入其中，因为初始构建可能并未加载该变体所需的全部模块。`_pbrRebuildsComposed`（`pbr-built-variant.ts`）使用同一函数重算网格的键并检查其是否在 `_b` 中。

### 可渲染对象构建器（`pbr-renderable.ts`）

`buildPbrRenderables(scene, meshes, envTextures)`：

1. 仅动态导入网格集合所需的片段模块
2. 根据场景灯光计算每个网格受影响的灯光索引
3. 按特性掩码与逐网格光照模式（无光照、单灯光快速路径或多灯光/阴影路径）创建已组合着色器
4. 构建逐网格的网格/材质 UBO 与绑定组；网格 UBO 存储 `lc` 与打包的 `li` 场景灯光索引
5. 对每个网格：`computePbrFeatures()` → 组合着色器 → `getOrCreatePbrPipeline()` → 创建网格 UBO → `createPbrMeshBindGroup()`
6. 为每个网格返回一个 `Renderable`；每个可渲染对象为帧图通道绑定特定于渲染目标的 `DrawBinding`
7. 不透明对象使用 order = 100，透明/透射对象使用 order = 150；场景纹理折射表面设置 `_transmissive` 并在 `record()` 期间绑定 `RenderTargetSignature._transmissionTexture`
8. 返回 `rebuildSingle`，以便材质替换和逐通道材质覆写能重建单个网格而无需重建整个场景
9. 设置销毁回调以在场景拆除时清除管线缓存和采样器

### 单网格重建闭包

从 `buildPbrRenderables()` 返回的 `rebuildSingle(scene, mesh, materialOverride?, resources?)` 闭包在材质替换或逐通道覆写后重建单个网格，而无需重建整个场景。它接受 `MaterialOrView`，结合源材质资源使用视图的渲染特性，复用捕获的逐场景片段导入/组合器缓存/阴影缓存/环境状态，重算网格特性与光照变体，创建/复用着色器绑定与管线，并返回一个在网格材质再次变更时会提前退出的 `Renderable`（除非它是为显式覆写而构建的）。

对于辅助任务重建，`resources: MeshRebuildResources` 提供调用方的生命周期销毁器列表。构建器会在后续可能失败的搭建步骤之前将 UBO 和纹理租约清理注册到该列表中，而不是修改场景所属的销毁器映射。这使得显式覆写在主材质替换期间保持存活，并让失败的任务候选对象能够释放自身分配而不扰乱已发布的场景或任务代次。

阴影 group-2 绑定由来自惰性加载接收方模块的 `createMaterialShadowBindings` 提供。普通 PBR 构建器不分配阴影绑定组缓存，也不保留其描述符构造循环；Standard 和 PBR 共享该仅限接收方的实现。

## 着色器逻辑

### 顶点着色器（由模板 + 片段组合）

**输入**：position (`vec3`)、normal (`vec3`)、uv (`vec2`)、可选 tangent (`vec4`)、可选 joints/weights、可选实例矩阵。

**处理流程**：

1. `/*VR*/` —— 变形目标应用（若存在 `MSH_HAS_MORPH_TARGETS`）：从变形纹理累加位置/法线增量
2. `/*VW*/` —— 蒙皮（若存在 `MSH_HAS_SKELETON`）：`finalWorld = mesh.world * boneInfluence`；否则 `finalWorld = mesh.world`
3. `worldPos = finalWorld × vec4(position, 1.0)`
4. `clipPos = scene.viewProjection × worldPos`
5. `worldNormal = normalize((finalWorld × vec4(normalize(normal), 0)).xyz)`
6. 若使用切线法线贴图 —— **先在局部空间中**计算 TBN（对于反射矩阵至关重要）：
    ```
    N_local = normalize(normal)
    T_local = normalize(tangent.xyz)
    B_local = cross(N_local, T_local) * tangent.w
    worldTangent = (finalWorld × vec4(T_local, 0)).xyz
    worldBitangent = (finalWorld × vec4(B_local, 0)).xyz
    ```
7. `/*VB*/` —— 阴影灯光空间变换（若存在 `MSH_RECEIVE_SHADOWS`）

**输出**：`worldPos`、`worldNormal`、[`worldTangent`, `worldBitangent`]、`uv`、可选阴影插值变量。

### 片元着色器（由模板 + 片段组合）

#### 1. 纹理采样（始终执行）

```
baseColor = textureSample(baseColorTexture, baseColorSampler, uv)
// Optional gamma decode when gammaAlbedo flag is set
occlusion = orm.r
roughness = clamp(orm.g, 0.04, 1.0)
metallic  = orm.b
```

#### 2. 材质准备槽位

- `/*MF*/` —— 反射率 F0 重映射（reflectance-fragment）、清漆 IOR 重映射（clearcoat-fragment）
- `/*SV*/` —— 光泽变量初始化（sheen-fragment）
- `/*BL*/` —— 清漆变量初始化（clearcoat-fragment）

#### 3. 法线贴图

- 切线模式（`PBR_HAS_NORMAL_MAP`）：由插值得到的切线/副切线构成 TBN 矩阵
- 余切模式（`PBR_HAS_COTANGENT_NORMAL`）：根据屏幕空间导数重建余切框架
- 无贴图：`N = normalize(worldNormal)`，若为双面材质则根据正面朝向翻转

#### 4. 自发光

- 若存在 `PBR_HAS_EMISSIVE`：`emissive = textureSample(emissiveTexture, ...).rgb`
- `/*AT*/` 槽位：`emissive-fragment` 加上自发光颜色 uniform 贡献

#### 5. 直接光照 + `/*AD*/` 槽位

针对主光源的 BRDF 求值（GGX NDF + Smith-GGX 几何函数 + Schlick Fresnel），外加：

- 清漆直接 BRDF（clearcoat-fragment `AD`）
- 光泽直接项（sheen-fragment `AD`）
- 阴影因子应用（pbr-shadow-fragment `AD`）
- 启用 `_hasSingleLight` 时的单灯光直接光照块
- 启用 `_hasMultiLight` 时的多灯光循环

#### 6. 环境光照 — `/*AI*/` 或 `/*NI*/` 槽位

- `AI`（IBL 路径）：SH 辐照度、基于 Split-Sum 的高光辐射度、BRDF LUT、能量守恒、地平线遮蔽、清漆 IBL、光泽 IBL
- `NI`（非 IBL 路径）：清漆/光泽非 IBL 能量守恒

#### 7. 最终合成 — `/*BC*/` 与 `/*BA*/` 槽位

- 自发光叠加
- 光照贴图贡献
- Alpha 混合亮度累积（`BA`）

#### 8. 图像处理（若存在 `PBR_HAS_TONEMAP`）

- 曝光：`color *= exposureLinear`
- 色调映射：`color = color / (1 + color)`
- 对比度调整
- Gamma：`pow(color, 1/2.2)`

## Babylon.js 等价对照表

| Babylon Lite                                 | Babylon.js                                          |
| -------------------------------------------- | --------------------------------------------------- |
| `computePbrFeatures()`                       | `PBRMaterial._getEffect()` 中的内部宏定义标志       |
| `getOrCreatePbrPipeline()`                   | `PBRMaterial._getEffect()` 中的管线缓存             |
| `createPbrTemplate()` + `composeShader()`    | 基于宏定义生成 GLSL 着色器                          |
| `ShaderFragment` 组合                        | `#include` / `#define` 预处理器                     |
| Scene UBO (group 0)                          | `Scene.sceneUbo`                                    |
| Mesh UBO (group 1, binding 0)                | `Mesh._uniformBuffer`                               |
| `PBR_HAS_NORMAL_MAP`                         | `#define BUMP`                                      |
| `PBR_HAS_EMISSIVE`                           | `#define EMISSIVE`                                  |
| `PBR_HAS_ENV`                                | `#define REFLECTION` + `#define SS_REFRACTION`      |
| `PBR_HAS_CLEARCOAT`                          | `#define CLEARCOAT`                                 |
| `PBR_HAS_SHEEN`                              | `#define SHEEN`                                     |
| `MSH_HAS_SKELETON`                           | `#define BONES`                                     |
| `MSH_HAS_MORPH_TARGETS`                      | `#define MORPHTARGETS`                              |
| `MSH_RECEIVE_SHADOWS`                        | `#define SHADOW0`                                   |
| `PBR_HAS_SPEC_GLOSS`                         | `#define SPECULARGLOSSINESS`                        |
| `PBR_HAS_SPECULAR_AA`                        | `#define SPECULARAA`                                |
| `rebuildSingle` 闭包                         | `Material._markAllSubMeshesAsAllDirty()`            |
| `singlelight-wgsl.ts` / `multilight-wgsl.ts` | `pbr.fragment.fx` 中的直接光照准备与计算函数        |

## 依赖关系

- **`pbr-material.ts`**：从 `texture-2d` 导入 `Texture2D`，从 `renderable` 导入 `MeshGroupBuilder`。
- **`pbr-flags.ts`**：纯 PBR 特性/扩展常量及注册表辅助函数。无灯光扩展依赖。
- **`pbr-template.ts`**：从 `fragment-types` 导入 `ShaderTemplate`、`UboField`、`VertexAttribute`、`Varying`、`BindingDecl`。
- **`pbr-pipeline.ts`**：从 `pbr-material` 导入 `PbrMaterialProps`，从 `shader-composer` 导入 `ComposedShader`，从 `pbr-flags` 导入特性标志。
- **`pbr-renderable.ts`**：导入管线函数、模板创建器、着色器组合器、片段工厂（动态）、引擎/场景/网格/灯光类型、材质视图类型、资源池辅助函数，并返回单网格重建闭包。
- **`no-color-view.ts`**：导入 `createMaterialView` 与 PBR 特性标志以创建无颜色材质视图，同时不将该辅助函数拉入普通 PBR 场景。
- **`fragments/singlelight-wgsl.ts`**：无导入（纯 WGSL 字符串辅助模块）。
- **`fragments/multilight-wgsl.ts`**：导入 `MAX_LIGHTS` 以确定生成的 WGSL 数组大小。
- **片段模块**：每个模块仅从 `fragment-types.js` 导入 `ShaderFragment`（以及可选的 `BindingDecl`、`Varying`）。
- **被以下模块依赖**：`load-gltf.ts`（导入 `PbrMaterialProps`、`createPbrMaterial`）、`background-renderable.ts`（复用场景 BGL/BG）、`index.ts`（公共导出）。

## 测试规范

| 测试                                       | 说明                                                        |
| ------------------------------------------ | ----------------------------------------------------------- |
| `pipeline cache hit`                       | 相同的 features+format+msaa → 同一管线对象                  |
| `pipeline cache miss on features`          | 不同的 features → 不同的管线                                |
| `vertex buffers with tangent`              | HAS_NORMAL_MAP → 布局中包含切线缓冲区                       |
| `vertex buffers without tangent`           | 无 HAS_NORMAL_MAP → 无切线缓冲区                            |
| `composed shader with IBL`                 | IBL 片段注入 BRDF LUT + 立方体贴图绑定                      |
| `composed shader without IBL`              | 片段省略 IBL 代码块，输出结果更小                           |
| `clearcoat fragment integration`           | 清漆槽位注入 BRDF + 能量守恒代码                            |
| `sheen fragment integration`               | 光泽槽位注入 Charlie NDF + Ashikhmin 可见性                 |
| `skeleton fragment`                        | 4 骨骼和 8 骨骼顶点属性注入                                 |
| `morph fragment`                           | 变形目标纹理绑定 + 顶点槽位代码                             |
| `shadow fragment ESM`                      | 逐灯光 ESM 阴影因子计算                                     |
| `shadow fragment PCF`                      | 逐灯光 PCF 阴影因子计算                                     |
| `single rebuild`                           | 材质替换仅重建单个网格而无需完整场景拆除                    |
| `_pbrRebuildsComposed`                     | 仅接受其所属组构建时已经组合过的变体                        |
| `rebuildMaterial per-mesh path`            | 符合条件的 PBR 重建跳过全组重建                             |
| `GGX NDF at roughness=0.5, NdotH=1`        | D = α⁴/(π) ≈ 0.001245                                       |
| `Fresnel at cosθ=0`                        | F = 1.0（全反射）                                           |
| `Image processing: exposure=1, contrast=1` | 仅色调映射                                                  |

## 文件清单

| 文件                                                   | 规模     | 用途                                                                                       |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------ |
| `src/material/pbr/pbr-material.ts`                     | ~360 行  | 材质接口、`createPbrMaterial()` 以及兼容性重导出                                           |
| `src/material/pbr/pbr-group-builder.ts`                | ~20 行   | 延迟单例组构建                                                                             |
| `src/material/pbr/pbr-material-features.ts`            | ~50 行   | 原生与扩展材质特性检测                                                                     |
| `src/material/pbr/collect-pbr-bound-textures.ts`       | ~20 行   | 原生与扩展纹理枚举                                                                         |
| `src/material/pbr/pbr-flags.ts`                        | ~43 行   | 特性标志位常量 + PBR 扩展注册表辅助函数                                                    |
| `src/material/pbr/pbr-template.ts`                     | ~465 行  | `PbrTemplateConfig` + `createPbrTemplate()` —— 构建带 BRDF 辅助函数、槽位标记、基础 UBO/绑定的 `ShaderTemplate` |
| `src/material/pbr/pbr-pipeline.ts`                     | ~284 行  | `computePbrFeatures()`、`getOrCreatePbrPipeline()`、`createPbrMeshBindGroup()`、管线缓存管理 |
| `src/material/pbr/pbr-renderable.ts`                   | ~723 行  | `buildPbrRenderables()` —— 动态片段导入、着色器组合、灯光 UBO 搭建、可渲染对象创建、单网格重建闭包 |
| `src/material/pbr/pbr-built-variant.ts`                | ~60 行   | `_pbrRebuildsComposed()` —— 判断 PBR `rebuildMaterial()` 能否通过组闭包重建每个网格（延迟加载） |
| `src/material/pbr/no-color-view.ts`                    | ~18 行   | `createPbrNoColorMaterialView()` —— 通道专用的无颜色材质视图辅助函数                       |
| `src/material/pbr/fragments/singlelight-wgsl.ts`       | ~75 行   | 无循环单灯光直接路径的延迟 WGSL 辅助模块                                                   |
| `src/material/pbr/fragments/multilight-wgsl.ts`        | ~120 行  | 延迟 WGSL 辅助模块：`MULTI_LIGHT_STRUCTS()`、`COMPUTE_PBR_LIGHT`、`getMultiLightLoop()`    |
| `src/material/pbr/fragments/ibl-fragment.ts`           | ~86 行   | IBL 环境光照片段（BRDF LUT、高光立方体贴图、SH 辐照度）                                    |
| `src/material/pbr/fragments/local-cubemap-fragment.ts` | ~600 行  | 可选的逐材质环境、有限盒式/球形投影以及片元加权探针数组 IBL                                |
| `src/material/pbr/enable-pbr-local-cubemap.ts`         | ~500 行  | 公共局部环境 API、校验、探针打包、立方体数组创建与体素查找                                 |
| `src/material/pbr/fragments/clearcoat-fragment.ts`     | ~122 行  | 清漆层片段（Kelemen 可见性、F0 重映射、直接光照 + IBL 清漆）                               |
| `src/material/pbr/fragments/sheen-fragment.ts`         | ~115 行  | 光泽层片段（Charlie NDF、Ashikhmin 可见性、直接光照 + IBL 光泽）                           |
| `src/material/pbr/fragments/reflectance-fragment.ts`   | ~79 行   | 金属反射率扩展片段（F0 计算、反射率贴图）                                                  |
| `src/material/pbr/fragments/emissive-fragment.ts`      | ~29 行   | 自发光颜色 uniform 片段                                                                    |
| `src/material/pbr/fragments/lightmap-fragment.ts`      | ~140 行  | 可选烘焙光照贴图片段（UV1/UV2、叠加/阴影贴图、Gamma 解码、有效 V 翻转）                    |
| `src/material/pbr/enable-pbr-lightmap.ts`              | ~70 行   | 已发布的 `enablePbrLightmap()` / `setPbrLightmap()` 可选接缝                               |
| `src/material/pbr/fragments/morph-fragment.ts`         | ~48 行   | 变形目标顶点动画片段                                                                       |
| `src/material/pbr/fragments/skeleton-fragment.ts`      | ~71 行   | 骨骼动画片段（4 骨骼或 8 骨骼）                                                            |
| `src/material/pbr/fragments/pbr-shadow-fragment.ts`    | ~143 行  | PBR 阴影接收片段（ESM + PCF，逐灯光）                                                      |
| `src/shader/shader-composer.ts`                        | ~293 行  | `composeShader()` —— 拓扑排序、UBO 合并、绑定分配、槽位注入                                |
