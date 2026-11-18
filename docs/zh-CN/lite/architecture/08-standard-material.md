# 模块：Standard Material（Blinn-Phong）

> 包路径：`packages/babylon-lite/src/material/standard/`
> 文件：`standard-material.ts`（类型）、`create-standard-material.ts`（工厂函数）、`standard-group-builder.ts`（动态导入）、`standard-template.ts`（着色器模板）、`standard-pipeline.ts`（管线/绑定/已组合着色器缓存）、`standard-renderable.ts`（可渲染对象构建器与单网格重建闭包）、`standard-flags.ts`（特性标志与扩展注册表）、`enable-standard-mesh-features.ts`（已发布的可选 API）、`geometry-view.ts` / `standard-geometry-renderable.ts` / `standard-geometry-output-shader.ts`（几何通道复用）、`../geometry-deformation-hooks.ts` / `../geometry-deformation-velocity.ts`（共享的可选上一帧姿态状态）、`no-color-view.ts`（通道专用的材质视图）

## 目的

StandardMaterial 模块实现了 Blinn-Phong 着色模型，支持点光源/方向光、可选雾效（线性、指数、指数平方）、可选漫反射纹理、可选自发光纹理、可选凹凸/法线贴图纹理、可选高光纹理、可选环境光/遮蔽纹理、可选光照贴图纹理、可选不透明度/透明纹理、可选反射纹理（球面与平面模式）、针对特定纹理通道的 UV2 支持、带逐实例颜色的精简实例、`disableLighting` 模式以及可选的 ESM/PCF 阴影接收。显式可选开关为骨骼蒙皮和 RGBA 顶点颜色增加了仅限 Standard 的网格变形/状态支持。共享的 `enableMaterialUvTransform(material)` 可选开关为 Standard 材质启用了独立的逐纹理缩放、偏移和旋转，而无需在不相关的打包产物中保留 UV 变换片段。其输出与开启相应宏定义的 `BABYLON.StandardMaterial` 一致。

着色器通过 `ShaderFragment` / `ShaderComposer` 系统**动态组合** —— 不使用原始 `.wgsl` 文件。`ShaderTemplate`（`standard-template.ts`）提供带有槽位标记的基础 WGSL；可选的 `ShaderFragment` 模块（位于 `fragments/`）将代码注入这些槽位。仅组合给定网格特性所需的片段，从而依据体积支柱（Size Pillar）最小化包体积。片段模块在构建时**动态导入**，以便未使用特性被 tree-shake 移除。旧的 `standard-textured-material.ts` 已合并入此统一系统。

`setStandardParallaxOcclusion(material, props)` 可按需为包括凹凸贴图在内的现有表面纹理启用独立实现的高度图 UV 视差遮蔽位移，同时保留它们原有的纹理梯度和法线贴图坐标系。完整 API 和通道行为请参阅[视差遮蔽贴图](parallax-occlusion-mapping.md)。

## ShaderFragment 组合系统

Standard 材质着色器使用与 PBR 相同的 `ShaderComposer` 架构构建（定义于 `src/shader/shader-composer.ts`）：

1. **`ShaderTemplate`**（`standard-template.ts` → `createStandardTemplate()`）—— 提供带有槽位标记（如 `/*AC*/`、`/*AD*/`、`/*AT*/`、`/*BC*/`、`/*BA*/`、`/*SV*/`、`/*VB*/`）的基础顶点/片元 WGSL、基础 UBO 字段、基础顶点属性、基础插值变量以及用于灯光/材质/漫反射的基础绑定。

2. **`ShaderFragment`** —— 每个可选特性（法线贴图、自发光纹理、高光纹理、环境光纹理、光照贴图、不透明度、反射、阴影）都是一个片段对象，包含：
    - `id` —— 唯一字符串标识
    - `fragmentSlots` / `vertexSlots` —— 按槽位名称索引的 WGSL 代码片段
    - `bindings` —— 纹理/采样器的 `BindingDecl[]`
    - `varyings` —— 额外的阶段间插值变量（阴影）
    - `helperFunctions` / `vertexHelperFunctions` —— WGSL 辅助函数代码

3. **`composeShader(template, fragments)`** —— 对片段进行拓扑排序、合并 UBO 字段、分配绑定索引、用拼接后的片段代码替换槽位标记，并返回包含最终 WGSL + 绑定组布局描述符的 `ComposedShader`。

### 组合流程（Standard）

```
standard-group-builder.ts:
  1. Scans meshes for needed features (bump, emissive, specular, etc.)
  2. Dynamically imports fog WGSL only when `scene.fog != null`
  3. Runs only mesh-feature dispatchers installed by explicit Standard enablers
  4. Dynamically imports only needed fragment modules
  5. Passes fragment factories plus the scene shader context to buildStandardMeshRenderables()

standard-renderable.ts (buildStandardMeshRenderables):
  1. Resolves MaterialOrView to source material state + render feature bits
  2. Lets registered mesh extensions contribute skeleton / 8-bone / vertex-color bits
  3. Per mesh: builds fragment list from material, mesh, shadow, morph, and instance features
  4. Calls composeStandardShader(features, meshFeatures, fragments, ..., sceneShader) → ComposedShader
  5. Calls getOrCreateStandardBindings() and getOrCreateStandardPipeline()
```

## 可选 Standard 网格特性契约

变形/顶点特性启用器是从根包入口显式导出的命名函数：

```ts
import { enableStandardSkeleton, enableMaterialUvTransform, enableStandardVertexColors } from "@babylonjs/lite";
```

当场景创建匹配的 Standard 网格/材质状态时，请在 `registerScene()` 之前调用各启用器。启用器是幂等的，且在导入时不产生任何注册副作用：

- `enableStandardSkeleton()` 安装一个网格谓词和延迟片段加载器。该片段复用 PBR 所使用的与材质无关的共享骨骼着色器片段。匹配的几何速度通道会单独加载共享的上一帧蒙皮/变形状态；上一帧变形权重在上一帧骨骼之前应用，如[模块 31](31-geometry-renderer.md) 所述。
- `enableStandardVertexColors()` 安装 RGBA 顶点颜色组合及绘制时颜色缓冲区绑定。
- `enableMaterialUvTransform(material)` 标记手动构建的 Standard 材质以启用独立纹理变换。在 `registerScene()` 之前调用它，随后在任意已绑定的 `Texture2D` 上设置 `uScale`、`vScale`、`uOffset`、`vOffset` 或 `uAng`。仅当存在被标记的材质时，Standard 组构建器才会加载 `std-uv-transform-fragment.ts`。
- `enableStandardUvOffset()` 保留为 `material.uvOffset` 的轻量级共享材质平移路径；缺失的偏移始终解析为 `[0, 0]`。

UV 变换片段贡献一个顶点可见的 uniform 缓冲区，并且仅贡献材质活跃纹理通道所需的插值变量。其固定通道顺序为：漫反射、自发光、凹凸、高光、环境光、光照贴图、不透明度。每个通道存储一个 2x2 矩阵加上平移量；该矩阵围绕 UV 原点应用缩放和 `uAng` 旋转，然后平移。UV1 通道会先组合现有的 `material.uvScale` / 可选的 `material.uvOffset`，而 UV2 通道则保留原有的原始 UV2 行为。`invertY` 会被折叠进通道变换中。纹理变换字段在构建可渲染对象时采样；之后的修改需要调用 `rebuildMaterial`。

启用器仅注册标量回调和延迟加载器。没有任何模块在导入时分配 `Map`/`Set` 或注册扩展。若未使用这些根导出，生产环境场景打包产物会完全省略变形/偏移分块；仅前向渲染的骨骼场景也不会加载几何速度分块。

## `_buildGroup` 模式

`standard-material.ts` 定义了 `standardGroupBuilder`（未导出），这是一个动态导入 `standard-renderable.js` 和所需片段模块的 `MeshGroupBuilder` 函数。该函数作为 `_buildGroup` 字段设置在 `createStandardMaterial()` 创建的每个 Standard 材质上。在 `startEngine()` 时，`scene.ts` 按构建器标识对网格进行分组，从而将所有 Standard 材质的网格合批交由单次 `buildStandardMeshRenderables()` 调用处理。

`standardGroupBuilder` 检测所有网格所需的特性，仅按需导入所需的片段模块，并在存在精简实例时导入 `thin-instance-gpu.ts`。雾效是场景着色器特性而非材质特性：构建器仅在启用雾效的场景中导入 `std-fog-wgsl.ts`，并传入一个包含 `STD_SCENE_FOG` 与雾效 `ShaderFragment` 的 `StandardSceneShaderContext`。仅当已发布的启用器安装网格特性片段分发时，该分发逻辑才存在。这确保未使用的特性对包体积的影响为零。构建器将 `buildStandardMeshRenderables()` 返回的 `rebuildSingle` 闭包存储在 `standardGroupBuilder._rebuildSingle` 上，用于材质替换、`rebuildMaterial()` 以及逐通道材质覆写。

Standard 网格顶点颜色采用更严格的可选接缝，因为自动检测颜色缓冲区会向每个 Standard 场景添加一个动态导入谓词。`enableStandardVertexColors()` 在 `registerScene()` 之前安装片段工厂。当打包产物中不包含该函数时，`_stdVertexColorFragment` 静态为 null，所有颜色缓冲区分支都会被折叠消除，使未使用该特性的场景保持字节完全一致。

## 动态特性标志

| 标志                         | 位        | 条件                                | 着色器效果                                      |
| ---------------------------- | --------- | ----------------------------------- | ----------------------------------------------- |
| `HAS_DIFFUSE_TEXTURE`        | `1 << 0`  | `material.diffuseTexture`           | 漫反射纹理采样                                  |
| `HAS_EMISSIVE_TEXTURE`       | `1 << 1`  | `material._emissiveTexture`         | 自发光纹理采样                                  |
| `HAS_BUMP_TEXTURE`           | `1 << 2`  | `material._bumpTexture`             | 余切框架法线贴图                                |
| `HAS_SPECULAR_TEXTURE`       | `1 << 3`  | `material._specularTexture`         | 高光纹理替代 specularColor                      |
| `HAS_AMBIENT_TEXTURE`        | `1 << 4`  | `material._ambientTexture`          | 环境光遮蔽相乘                                  |
| `HAS_LIGHTMAP_TEXTURE`       | `1 << 5`  | `material._lightmapTexture`         | 叠加光照贴图                                    |
| `HAS_OPACITY_TEXTURE`        | `1 << 6`  | `material._opacityTexture`          | Alpha/不透明度纹理                              |
| `LIGHTMAP_USES_UV2`          | `1 << 7`  | 光照贴图使用 UV2                    | 为光照贴图提供 UV2 属性                         |
| `AMBIENT_USES_UV2`           | `1 << 8`  | 环境光使用 UV2                      | 为环境光提供 UV2 属性                           |
| `DOUBLE_SIDED`               | `1 << 9`  | `!material.backFaceCulling`         | `cullMode: 'none'`                              |
| `DIFFUSE_USES_UV2`           | `1 << 10` | 漫反射使用 UV2                      | 为漫反射提供 UV2 属性                           |
| `SPECULAR_USES_UV2`          | `1 << 11` | 高光使用 UV2                        | 为高光提供 UV2 属性                             |
| `OPACITY_FROM_RGB`           | `1 << 12` | `material.opacityFromRGB`           | 根据 RGB 亮度计算不透明度                       |
| `HAS_REFLECTION_TEXTURE`     | `1 << 13` | `material._reflectionTexture`       | 球面/平面反射                                   |
| `DISABLE_LIGHTING`           | `1 << 14` | `material.disableLighting`          | 跳过灯光循环，仅输出自发光                      |
| `MATERIAL_ALPHA_BLEND`       | `1 << 16` | `material.alpha < 1`                | Alpha 混合管线状态                              |
| `HAS_CUBE_REFLECTION`        | `1 << 17` | `material._reflectionCubeTexture`   | 立方体反射采样                                  |
| `NO_COLOR_OUTPUT`            | `1 << 18` | 无颜色材质视图                      | 片元阶段运行丢弃/Alpha 测试逻辑且不写入颜色     |
| `HAS_DEPTH_EMISSIVE_TEXTURE` | `1 << 19` | 自发光纹理具有深度采样类型          | 深度纹理自发光预览                              |
| `HAS_VERTEX_COLOR`           | `1 << 23` | 启用器激活 + 网格颜色缓冲区         | RGBA 顶点颜色乘以基础色和 Alpha                 |
| `HAS_SKELETON`               | `1 << 26` | 启用器激活 + 网格骨骼               | 位置和法线的骨骼纹理蒙皮                        |
| `HAS_SKELETON_8`             | `1 << 27` | 骨骼拥有 JOINTS_1 / WEIGHTS_1       | 添加后四个骨骼影响                              |
| `NEEDS_UV`                   | 推导值    | 存在任意纹理                        | UV 顶点属性                                     |
| `NEEDS_UV2`                  | 推导值    | 存在任意 `*_USES_UV2` 标志          | UV2 顶点属性                                    |

精简实例与阴影接收状态是 `material/mesh-features.ts` 中的网格特性位，独立于 Standard 材质渲染特性。

顶点颜色使用 `MSH_HAS_VERTEX_COLOR` 加上已安装的 `_stdVertexColorFragment` 工厂，而非 Standard 材质位。一旦通过 `enableStandardVertexColors()` 启用，每个带有 `mesh._gpu.colorBuffer` 的 Standard 网格都会接收顶点颜色着色器变体及缓冲区绑定。RGB 始终乘以基础色；仅当网格通过 `mesh.hasVertexAlpha`（Babylon `VERTEXALPHA`）显式启用时才会消费 Alpha 通道（并并入 Alpha 测试），该标志同时设置 `VERTEX_ALPHA | MATERIAL_ALPHA_BLEND`，使网格执行 source-over 混合并排入透明阶段。动态加载的精简实例片段会在存在逐实例 RGBA 时声明，从而允许同样的 `hasVertexAlpha` 开关在不要求网格拥有顶点颜色缓冲区的情况下设置 `MATERIAL_ALPHA_BLEND`。它刻意不设置 `VERTEX_ALPHA`，从而在不存在此类缓冲区或片段时避免多余的顶点颜色着色器/缓存变体。Standard 几何输出仍仅支持顶点颜色，因为精简实例颜色不参与该路径的 Alpha 分类。

`STD_SCENE_FOG` 是一个独立的场景特性位。它包含在 Standard 绑定/已组合着色器缓存键中，但从不存储在材质上。

绑定与已组合着色器按 `(features, meshFeatures, sceneFeatures, shadowVariant, stencilVariant)` 缓存。管线嵌套在那些绑定之下，并按完整的渲染目标签名缓存。因此，共享同一个 `GPUDevice` 的有雾场景与无雾场景即使在所有材质和网格特性位都匹配时，也绝不会共享已组合着色器、绑定组布局对象或管线。

## 公共 API 接口

### 类型（`standard-material.ts`）

```typescript
import type { MeshGroupBuilder } from "../../render/renderable.js";

/** StandardMaterial properties — plain data. */
export interface StandardMaterialProps extends Material {
    diffuseColor: [number, number, number];
    alpha: number;
    specularColor: [number, number, number];
    specularPower: number;
    emissiveColor: [number, number, number];
    ambientColor: [number, number, number];
    diffuseTexture: Texture2D | null;
    diffuseCoordIndex: 0 | 1;
    /** @internal Set via `setStandardEmissiveTexture()`. */
    _emissiveTexture?: Texture2D | null;
    /** @internal Set via `setStandardBumpTexture()`. */
    _bumpTexture?: Texture2D | null;
    bumpLevel: number;
    /** @internal Set via `setStandardSpecularTexture()`. */
    _specularTexture?: Texture2D | null;
    specularCoordIndex: 0 | 1;
    /** @internal Set via `setStandardAmbientTexture()`. */
    _ambientTexture?: Texture2D | null;
    ambientTexLevel: number;
    ambientCoordIndex: 0 | 1;
    /** @internal Set via `setStandardLightmapTexture()`. */
    _lightmapTexture?: Texture2D | null;
    lightmapLevel: number;
    lightmapCoordIndex: 0 | 1;
    /** @internal Set via `setStandardOpacityTexture()`. */
    _opacityTexture?: Texture2D | null;
    opacityLevel: number;
    opacityFromRGB: boolean;
    alphaCutOff: number;
    /** @internal Set via `setStandardReflectionTexture()`. */
    _reflectionTexture?: Texture2D | null;
    /** @internal Set via `setStandardReflectionCubeTexture()`. */
    _reflectionCubeTexture?: CubeTexture | null;
    reflectionLevel: number;
    reflectionCoordMode: 1 | 2;
    uvScale: [number, number];
    uvOffset?: [number, number];
    /** @internal True when enableMaterialUvTransform() enabled per-texture transforms. */
    _hasUvTx?: boolean;
    backFaceCulling: boolean;
    disableLighting: boolean;
}

/** Fog configuration — plain data. */
export interface FogConfig {
    mode: 0 | 1 | 2 | 3; // 0=off, 1=exp, 2=exp2, 3=linear
    density: number;
    start: number;
    end: number;
    color: [number, number, number];
}

/** Create StandardMaterial with Babylon defaults. Sets _buildGroup to standardGroupBuilder. */
export function createStandardMaterial(): StandardMaterialProps;

/** Collect all non-null textures for acquire/release tracking. */
export function collectStdBoundTextures(mat: StandardMaterialProps): Texture2D[];

/** Create a pass-specific no-color material view over a Standard source material. */
export function createStandardNoColorMaterialView(source: StandardMaterialProps): MaterialView;
```

### 顶点颜色（`enable-standard-vertex-colors.ts`）

```typescript
import { enableStandardVertexColors } from "babylon-lite";

/**
 * Enable RGBA mesh vertex colors for StandardMaterial.
 * Call once before registerScene().
 */
export function enableStandardVertexColors(): void;
```

颜色缓冲区契约为每个顶点四个 `f32` 值。RGB 始终乘以 Standard 基础色。仅当网格通过 `mesh.hasVertexAlpha`（Babylon `VERTEXALPHA`）显式启用时才消费 Alpha：片段随后将当前材质 Alpha 乘以 `vColor.a`，将 `vColor.a` 并入 Alpha 测试截止值，且网格执行 source-over 混合（关闭深度写入，进入透明排序阶段）。未开启该选项时顶点颜色仅作用于 RGB。同一片段同时参与主颜色、无颜色/阴影以及 Standard 几何视图着色器组合。逐精简实例 RGBA 对 Standard 前向透明遵循相同的 `hasVertexAlpha` 开关。其延迟片段将颜色标记为 Alpha 源，使前向构建器在不启用或绑定网格顶点颜色片段的情况下选择透明管线；Standard 几何视图分类仍仅限于顶点颜色。

### 可选纹理 Setter

```typescript
export function setStandardEmissiveTexture(mat: StandardMaterialProps, texture: Texture2D | null): void;
export function setStandardBumpTexture(mat: StandardMaterialProps, texture: Texture2D | null): void;
export function setStandardSpecularTexture(mat: StandardMaterialProps, texture: Texture2D | null): void;
export function setStandardAmbientTexture(mat: StandardMaterialProps, texture: Texture2D | null): void;
export function setStandardLightmapTexture(mat: StandardMaterialProps, texture: Texture2D | null): void;
export function setStandardOpacityTexture(mat: StandardMaterialProps, texture: Texture2D | null): void;
export function setStandardReflectionTexture(mat: StandardMaterialProps, texture: Texture2D | null): void;
export function setStandardReflectionCubeTexture(mat: StandardMaterialProps, texture: CubeTexture | null): void;
```

每个 setter 位于各自独立的模块中，且恰好只做两件事：设置 `@internal` 支撑字段以及注册其 `StdExt`。**每个模块仅含一个 setter 是架构的关键承载设计** —— 若放在共享模块中，其静态导入会将全部八个着色器片段拉入每个消费者，从而破坏整个按需加载设计。

注册是同步的且发生在调用时刻；特性检测则在稍后构建可渲染对象时通过扩展的 `_detect(mat)` 运行。因此伴随标量（`bumpLevel`、`lightmapCoordIndex`、`opacityFromRGB` 等）可以按任意顺序在 setter 之前或之后赋值。在材质已经构建之后设置纹理仍需调用 `rebuildMaterial()`。

支撑字段带有 `@internal`（下划线前缀），因此直接赋值 —— 这会跳过注册并静默导致什么都不渲染 —— 将产生编译错误。**Setter 就是边界：** 每次对支撑字段的写入都必须经过它。

`_computeStandardMaterialFeatures` 仅保留始终存在的核心位（`HAS_DIFFUSE_TEXTURE`、`DIFFUSE_USES_UV2`、`DOUBLE_SIDED`、`DISABLE_LIGHTING`、`MATERIAL_ALPHA_BLEND`）；所有可选位 —— 包括诸如 `LIGHTMAP_USES_UV2`、`SPECULAR_USES_UV2`、`OPACITY_FROM_RGB` 和 `HAS_DEPTH_EMISSIVE_TEXTURE` 等子位 —— 均由所属扩展的 `_detect` 贡献。这镜像了 `PbrExt.detect`。

`loadBabylon()` 通过按槽位的动态导入将 `.babylon` 纹理槽位映射到这些 setter，因此 `.babylon` 场景仅保留其文件实际引用的片段。

### 可选根导出

```typescript
export function enableStandardSkeleton(): void;
export function enableStandardUvOffset(): void;
export function enableMaterialUvTransform(material: PbrMaterialProps | StandardMaterialProps): boolean;
```

骨骼蒙皮、UV 平移以及 RGBA 顶点颜色的可选开关从根 `index.ts` 显式重导出。源码及发布包仅暴露 `"."` 导出入口；未使用的启用器及其延迟特性分块会由 tree-shaking 移除。

### 管线（`standard-pipeline.ts`）

```typescript
// Feature flags (see Dynamic Feature Flags table above for full list)
export const HAS_DIFFUSE_TEXTURE = 1 << 0;
// ... (all flags as documented)

export function _computeStandardMaterialFeatures(mat: StandardMaterialProps): number;
export function getOrCreateStandardBindings(
    engine: EngineContextInternal,
    features: number,
    meshFeatures: number,
    fragments?: ShaderFragment[],
    shaderKey?: string,
    esmShadowDepthCode?: string,
    stencil?: StencilState | null,
    sceneShader?: StandardSceneShaderContext | null
): StandardShaderBindings;

export function getOrCreateStandardPipeline(engine: EngineContextInternal, sig: RenderTargetSignature, bindings: StandardShaderBindings): GPURenderPipeline;

export function clearStandardPipelineCache(): void;
export function releaseStandardPipelineVariant(variant: PipelineVariant): void;

// Re-exports from lights-ubo
export { LIGHTS_UBO_SIZE, getLightsUboSize, writeLightsUBO, refreshLightsUBO };
```

### 模板（`standard-template.ts`）

```typescript
/** Configuration for standard shader template generation. */
export interface StandardTemplateConfig {
    _diffuse?: boolean;
    _needsUV: boolean;
    _needsUV2: boolean;
    _diffuseUsesUV2?: boolean;
    _disableLighting?: boolean;
    _noColorOutput?: boolean;
    _esmShadowOutput?: boolean;
    _hasMorph?: boolean;
}

/** Create a ShaderTemplate from standard material configuration. */
export function createStandardTemplate(config: StandardTemplateConfig, esmShadowDepthCode?: string): ShaderTemplate;
```

`StandardSceneShaderContext` 是纯内部状态：

```typescript
export interface StandardSceneShaderContext {
    readonly _features: number;
    readonly _fragments: readonly ShaderFragment[];
}
```

### 可渲染对象（`standard-renderable.ts`）

```typescript
/** Fragment factories passed from standardGroupBuilder. */
export interface StdFragmentFactories {
    tiSync?: ThinInstanceSync;
    tiFragment?: ShaderFragment;
    bumpFragment?: ShaderFragment;
    shadowFragment?: (shadowLights: ShadowLightSlot[]) => ShaderFragment;
    emissiveFragment?: ShaderFragment;
    specularFragment?: (usesUV2: boolean) => ShaderFragment;
    ambientFragment?: (usesUV2: boolean) => ShaderFragment;
    lightmapFragment?: (usesUV2: boolean) => ShaderFragment;
    opacityFragment?: (fromRGB: boolean) => ShaderFragment;
    reflectionFragment?: ShaderFragment;
}

export function buildStandardMeshRenderables(scene: SceneContext, meshes: Mesh[], factories: StdFragmentFactories): MeshGroupBuildResult;
```

### 材质视图与重建

Standard 可渲染对象接受 `MaterialOrView`。普通材质计算并存储 `_renderFeatures = { features: _computeStandardMaterialFeatures(mat) }`。视图精确使用 `view._renderFeatures`，同时从 `view.source` 读取所有 uniform/纹理状态。

`createStandardNoColorMaterialView(source)` 创建一个将 `NO_COLOR_OUTPUT` 按位或入源材质特性位的视图。这会生成一个执行丢弃/Alpha 测试代码且不写入颜色的 Standard 着色器变体，适用于需要执行片元阶段但不写入颜色的通道。

从 `buildStandardMeshRenderables()` 返回的 `rebuildSingle` 闭包会作为 `r` 安装在场景局部组上，同时也会缓存在 `standardGroupBuilder._rebuildSingle` 上。材质替换、`rebuildMaterial()` 以及逐通道覆写均通过场景局部组解析，绝不使用另一个场景的构建器缓存。Standard 重建要求传入场景的 `_standardRebuildContext` 已初始化；若缺少上下文会直接拒绝，而不是回退到闭包原本的场景。

### 默认材质值

| 属性                     | 默认值      |
| ------------------------ | ----------- |
| `diffuseColor`           | `[1, 1, 1]` |
| `alpha`                  | `1`         |
| `specularColor`          | `[1, 1, 1]` |
| `specularPower`          | `64`        |
| `emissiveColor`          | `[0, 0, 0]` |
| `ambientColor`           | `[0, 0, 0]` |
| `diffuseTexture`         | `null`      |
| `diffuseCoordIndex`      | `0`         |
| `bumpLevel`              | `1`         |
| `specularCoordIndex`     | `0`         |
| `ambientTexLevel`        | `1`         |
| `ambientCoordIndex`      | `0`         |
| `lightmapLevel`          | `1`         |
| `lightmapCoordIndex`     | `1`         |
| `useLightmapAsShadowmap` | `false`     |
| `opacityLevel`           | `1`         |
| `opacityFromRGB`         | `false`     |
| `alphaCutOff`            | `0`         |
| `reflectionLevel`        | `1`         |
| `reflectionCoordMode`    | `1`         |
| `uvScale`                | `[1, 1]`    |
| `backFaceCulling`        | `true`      |
| `disableLighting`        | `false`     |

八个可选纹理字段**没有默认值** —— 在调用对应的 `setStandardXTexture()` 之前，它们处于缺失状态（`undefined`）。省略 `null` 初始化器正是让从未导入某 setter 的场景能够完全丢弃该字段、其扩展以及其着色器片段的关键。

## 管线配置

### 顶点缓冲区（随特性变化）

**基础（始终存在）：**

| 槽位 | 属性     | 格式        | 步长    | 着色器 Location |
| ---- | -------- | ----------- | ------- | --------------- |
| 0    | Position | `float32x3` | 12 字节 | `@location(0)`  |
| 1    | Normal   | `float32x3` | 12 字节 | `@location(1)`  |

**条件属性（按顺序追加，槽位编号动态顺移）：**

| 属性             | 格式                     | 步长                | 步进模式   | 着色器 Location               | 启用条件                       |
| ---------------- | ------------------------ | ------------------- | ---------- | ----------------------------- | ------------------------------ |
| UV               | `float32x2`              | 8 字节              | `vertex`   | `@location(2)`                | `NEEDS_UV`                     |
| UV2              | `float32x2`              | 8 字节              | `vertex`   | `@location(3)`                | `NEEDS_UV2`                    |
| Vertex color     | `float32x4`              | 16 字节             | `vertex`   | 下一个空闲 location           | 启用顶点颜色且存在颜色缓冲区   |
| Joints/weights   | `uint32x4` + `float32x4` | 跨越 2 个缓冲区 32B | `vertex`   | 接下来 2 个 location          | `HAS_SKELETON`                 |
| Joints1/weights1 | `uint32x4` + `float32x4` | 跨越 2 个缓冲区 32B | `vertex`   | 接下来 2 个 location          | `HAS_SKELETON_8`               |
| Instance matrix  | 4× `float32x4`           | 64 字节             | `instance` | `@location(N)..@location(N+3)` | `THIN_INSTANCES`              |
| Instance color   | `float32x4`              | 16 字节             | `instance` | `@location(N+4)`              | `THIN_INSTANCE_COLOR`          |

### 管线状态

| 设置     | 值                                       |
| -------- | ---------------------------------------- |
| 拓扑     | `triangle-list`                          |
| 剔除模式 | `back`（若为 `DOUBLE_SIDED` 则为 `none`）|
| 正面绕序 | `ccw`                                    |
| 深度格式 | `depth24plus-stencil8`                   |
| 深度比较 | `greater-equal`                          |
| 深度写入 | `true`                                   |
| MSAA     | `count = msaaSamples`                    |
| 颜色目标 | 画布首选格式，无混合                     |

### 绑定组布局

**Group 0 — 场景：**

| Binding | 可见性             | 类型                                       |
| ------- | ------------------ | ------------------------------------------ |
| 0       | VERTEX \| FRAGMENT | Uniform 缓冲区（规范 Scene UBO，352 字节） |
| 1       | FRAGMENT           | Uniform 缓冲区（场景所属 `LightsUniforms`）|

**Group 1 — 逐网格**（基于特性的动态绑定）：

| Binding | 可见性             | 类型                  | 资源                                                 | 启用条件                         |
| ------- | ------------------ | --------------------- | ---------------------------------------------------- | -------------------------------- |
| 0       | VERTEX \| FRAGMENT | Uniform 缓冲区        | 网格 UBO（`world` + 逐网格灯光选择）                 | 始终存在                         |
| 1       | FRAGMENT           | Uniform 缓冲区        | 材质 UBO（96B）                                      | 始终存在                         |
| 2       | FRAGMENT           | texture_2d            | 漫反射纹理                                           | HAS_DIFFUSE_TEXTURE              |
| 3       | FRAGMENT           | sampler               | 漫反射采样器                                         | HAS_DIFFUSE_TEXTURE              |
| 4       | VERTEX+FRAGMENT    | Uniform 缓冲区        | 阴影 UBO（96B）或 UV UBO（16B）                      | RECEIVE_SHADOWS 或 NEEDS_UV      |
| next    | FRAGMENT           | 纹理/采样器对         | 自发光、凹凸、高光、环境光、光照贴图、不透明度、反射资源 | 取决于特性，由着色器组合器顺序分配 |
| next    | VERTEX             | texture_2d            | 骨骼矩阵纹理                                         | `HAS_SKELETON`                   |

**Group 2 — 阴影贴图**（仅当 `RECEIVE_SHADOWS`）：

| Binding | 可见性   | 类型       | 资源           |
| ------- | -------- | ---------- | -------------- |
| 0       | FRAGMENT | texture_2d | 阴影贴图纹理   |
| 1       | FRAGMENT | sampler    | 阴影贴图采样器 |

## 内部架构

### Uniform 缓冲区布局

#### 场景 UBO（Group 0，Binding 0）—— 352 字节（规范 `SceneUniforms`）

| 偏移（字节） | 浮点数索引 | WGSL 类型             | 字段                                            |
| ------------ | ---------- | --------------------- | ----------------------------------------------- |
| 0            | 0–15       | `mat4x4<f32>`         | `viewProjection`                                |
| 64           | 16–31      | `mat4x4<f32>`         | `view`                                          |
| 128          | 32–35      | `vec4<f32>`           | `vEyePosition` (xyz + pad)                      |
| 144          | 36–39      | 标量/填充             | 环境旋转/填充                                   |
| 160–303      | 40–75      | 9 × SH vec3 + 填充    | 环境辐照度                                      |
| 304          | 76–79      | 标量/填充             | 曝光、对比度、LOD 缩放                          |
| 320          | 80–83      | `vec4<f32>`           | `vFogInfos` (x=mode, y=start, z=end, w=density) |
| 336          | 84–87      | `vec4<f32>`           | `vFogColor` (rgb + pad)                         |

#### 网格 UBO（Group 1，Binding 0）

| 偏移 | WGSL 类型                                | 字段                                           |
| ---- | ---------------------------------------- | ---------------------------------------------- |
| 0    | `mat4x4<f32>`                            | `world`                                        |
| 64   | `u32`                                    | `lc`                                           |
| 80.. | `array<vec4<u32>, ceil(MAX_LIGHTS / 4)>` | 索引至 group-0 `LightsUniforms` 的打包灯光索引 |

#### 灯光 UBO（Group 0，Binding 1）—— 16 字节头部 + `MAX_LIGHTS × 64` 字节

| 偏移（字节）   | 类型            | 字段                                                         |
| -------------- | --------------- | ------------------------------------------------------------ |
| 0–15           | `u32 + padding` | `count` 头部                                                 |
| 16 + N×64 + 0  | `vec4<f32>`     | `vLightData` —— xyz=位置/方向，w=类型                        |
| 16 + N×64 + 16 | `vec4<f32>`     | `vLightDiffuse` —— rgb=diffuse×intensity，a=range            |
| 16 + N×64 + 32 | `vec4<f32>`     | `vLightSpecular` —— rgb=specular×intensity，a=聚光灯衰减指数 |
| 16 + N×64 + 48 | `vec4<f32>`     | `vLightDirection` —— 聚光灯方向/半角余弦                     |

#### 材质 UBO（Group 1，Binding 1）—— 96 字节（24 个浮点数）

| 偏移（字节） | 类型        | 字段                                             |
| ------------ | ----------- | ------------------------------------------------ |
| 0–15         | `vec4<f32>` | `vDiffuseColor` —— rgb=diffuse，a=alpha          |
| 16–31        | `vec4<f32>` | `vSpecularColor` —— rgb=specular，a=specularPower |
| 32–43        | `vec3<f32>` | `vEmissiveColor`                                 |
| 44–47        | `f32`       | `bumpScale` (1.0 / bumpLevel)                    |
| 48–59        | `vec3<f32>` | `vAmbientColor`                                  |
| 60–63        | `f32`       | `textureLevel`（当 `NEEDS_UV` 时为 1.0）         |
| 64–67        | `f32`       | `ambientTexLevel`                                |
| 68–71        | `f32`       | `lightmapLevel`                                  |
| 72–75        | `f32`       | `opacityLevel`                                   |
| 76–79        | `f32`       | `alphaCutOff`                                    |
| 80–83        | `f32`       | `reflectionLevel`                                |
| 84–87        | `f32`       | `reflectionCoordMode`（1=球面，2=平面）          |
| 88–95        | 2× `f32`    | 填充                                             |

#### 阴影 UBO（Group 1，Binding 5）—— 96 字节（若存在 `RECEIVE_SHADOWS`）

| 偏移（字节） | 类型          | 字段                                                       |
| ------------ | ------------- | ---------------------------------------------------------- |
| 0–63         | `mat4x4<f32>` | `lightMatrix`                                              |
| 64–79        | `vec4<f32>`   | `depthValues` (x=near, y=far)                              |
| 80–95        | `vec4<f32>`   | `uvScaleOffset` (x=uScale, y=vScale, z=uOffset, w=vOffset) |

#### UV UBO（Group 1，Binding 5）—— 16 字节（若存在 `NEEDS_UV` 且无阴影）

| 偏移（字节） | 类型        | 字段                                                                                                     |
| ------------ | ----------- | -------------------------------------------------------------------------------------------------------- |
| 0–15         | `vec4<f32>` | `uvScaleOffset` (x=uScale, y=vScale, z=uOffset, w=vOffset)；即使全局启用了可选开关但材质省略了 `uvOffset`，偏移仍默认为 `[0, 0]` |

### 着色器模板（`standard-template.ts`）

`createStandardTemplate(config, esmShadowDepthCode?)` 构建一个带有片段注入槽位标记的 `ShaderTemplate`。模板提供：

**常驻 WGSL 代码块（内嵌于模板）：**

| 代码块        | 内容                                                                                | 包含条件                           |
| ------------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| `LIGHTING_FN` | `computeLighting()` —— 遍历场景级 `MAX_LIGHTS` 灯光中网格选中子集的 Blinn-Phong、阴影因子 | 非 `DISABLE_LIGHTING`              |
| `FOG_FN`      | `calcFogFactor()` —— 来自按需动态导入的 Standard 雾效 WGSL 的线性/exp/exp2 计算     | `STD_SCENE_FOG` 且为产生颜色的通道 |

**模板槽位标记**（由 `ShaderComposer` 注入）：

| 槽位     | 阶段 | 用途                                   |
| -------- | ---- | -------------------------------------- |
| `/*AC*/` | 片元 | 法线扰动（凹凸贴图）                   |
| `/*AD*/` | 片元 | 环境光/阴影/反射贡献                   |
| `/*AT*/` | 片元 | 自发光/高光/不透明度纹理采样           |
| `/*BC*/` | 片元 | 光照后合成（光照贴图、实例颜色）       |
| `/*BA*/` | 片元 | 最终 Alpha 调整                        |
| `/*SV*/` | 片元 | 变量初始化                             |
| `/*VB*/` | 顶点 | 阴影灯光空间变换                       |
| `/*VR*/` | 顶点 | 变换前修改                             |
| `/*VW*/` | 顶点 | 世界矩阵覆写（蒙皮）                   |

**`disableLighting` 路径**：当设置 `DISABLE_LIGHTING` 时，模板省略光照函数、灯光循环、阴影因子、环境光、反射与光照贴图。输出变为 `clamp(emissiveContrib * diffuseColor, 0, 1) * baseColor`。

**逐实例颜色**：当设置 `THIN_INSTANCE_COLOR` 时，一个 `vInstanceColor` 插值变量从顶点传递到片元。在主合成之后的 `BC` 槽位中作为 `color.rgb *= vInstanceColor.rgb` 应用。

### 管线缓存（`standard-pipeline.ts`）

`getOrCreateStandardPipeline` 为每个 `StandardShaderBindings` 维护一个 `Map<targetSignatureKey(sig), GPURenderPipeline>`。BGL 在跨签名时保持稳定（仅管线依赖 `sig`），因此网格绑定组对于同一个 `(features, meshFeatures, sceneFeatures, variants)` 绑定实例所生成的任意管线都有效。

已组合着色器也使用该完整着色器键缓存，以避免在仅有格式/MSAA 不同时重复组合。雾效是否存在必须纳入缓存键中，因为雾效在不改变材质或网格比特位的情况下会改变生成的 WGSL。group-0 场景绑定组由 `RenderTask` 拥有；Standard 可渲染对象仅绑定材质/网格/阴影组。

在 GPU 设备变更时，管线与已组合着色器缓存会被清空。

### 可渲染对象构建器（`standard-renderable.ts`）

`buildStandardMeshRenderables(scene, meshes, factories)`：

1. 将每个网格材质或材质视图解析为源材质状态加上渲染特性。
2. 应用当前网格已启用的 Standard 网格特性位。
3. 根据特性标志 + `StdFragmentFactories` 构建片段列表。
4. 调用 `composeStandardShader(features, meshFeatures, fragments, ..., sceneShader)`。
5. 创建/复用与签名无关的着色器绑定和签名特定的管线。
6. 为每个网格创建一个 `Renderable`（order = `mesh.renderOrder ?? (isTransparent ? 200 : 100)`）。
7. 依赖 `RenderTask` 刷新 group-0 场景 UBO 和场景所属的灯光 UBO。
8. 获取纹理用于引用计数，并注册清理销毁回调。

当存在精简实例时，绘制函数会在每次实例化绘制之前调用 `tiSync(device, ti, pass, slot, hasInstanceColor)` 以同步 GPU 缓冲区，并使用 `drawIndexed(indexCount, ti.count)` 进行实例化渲染。

### 单网格重建闭包

从 `buildStandardMeshRenderables()` 返回的 `rebuildSingle(scene, mesh, materialOverride?)` 闭包在材质替换或通道特定覆写后重建单个网格而无需重建整个场景。它接受 `MaterialOrView`，结合源材质资源使用视图的渲染特性，计算材质/网格特性与着色器变体键，创建/复用着色器绑定与管线，写入逐网格灯光选择，构建可选阴影绑定组，并返回一个在网格材质再次变更时会提前退出的 `Renderable`（除非它是为显式覆写而构建的）。

## 片段模块

所有片段均位于 `src/material/standard/fragments/`，并导出返回 `ShaderFragment` 对象的工厂函数。

### `normal-map-fragment.ts` — 凹凸/法线贴图

- **工厂**：`createNormalMapFragment(): ShaderFragment`
- **ID**：`"normal-map"`
- **绑定**：`bumpTex`（texture2D）、`bumpSampler`（sampler）
- **辅助 WGSL**：`WGSL_PERTURB_NORMAL` —— 基于屏幕空间导数的余切框架法线扰动
- **片元槽位**：
    - `AC` —— `normalW = perturbNormal(input.vNormalW, input.vPositionW, input.vUV, mat.bumpScale)`

### `std-emissive-fragment.ts` — 自发光纹理

- **工厂**：`createStdEmissiveFragment(): ShaderFragment`
- **ID**：`"std-emissive"`
- **绑定**：`emissiveTex`（texture2D）、`emissiveSampler`（sampler）
- **片元槽位**：
    - `AT` —— `emissiveContrib = mat.vEmissiveColor * textureSample(emissiveTex, ..., input.vUV).rgb * mat.textureLevel`

### `std-specular-fragment.ts` — 高光纹理

- **工厂**：`createStdSpecularFragment(usesUV2: boolean): ShaderFragment`
- **ID**：`"std-specular"`
- **绑定**：`specularTex`（texture2D）、`specularSampler`（sampler）
- **片元槽位**：
    - `AT` —— `specularColor = textureSample(specularTex, ..., uv).rgb`（根据 `usesUV2` 使用 UV 或 UV2）

### `std-ambient-fragment.ts` — 环境光/遮蔽纹理

- **工厂**：`createStdAmbientFragment(usesUV2: boolean): ShaderFragment`
- **ID**：`"std-ambient"`
- **绑定**：`ambientTex`（texture2D）、`ambientSampler`（sampler）
- **片元槽位**：
    - `AD` —— `baseAmbientColor = textureSample(ambientTex, ..., uv).rgb * mat.ambientTexLevel`

### `std-lightmap-fragment.ts` — 光照贴图纹理

- **工厂**：`createStdLightmapFragment(usesUV2: boolean): ShaderFragment`
- **ID**：`"std-lightmap"`
- **绑定**：`lightmapTex`（texture2D）、`lightmapSampler`（sampler）
- **片元槽位**：
    - `BC` —— 叠加光照贴图：`color = vec4(color.rgb + textureSample(lightmapTex, ..., uv).rgb * mat.lightmapLevel, color.a)`

### `std-opacity-fragment.ts` — 不透明度/透明纹理

- **工厂**：`createStdOpacityFragment(fromRGB: boolean): ShaderFragment`
- **ID**：`"std-opacity"`
- **绑定**：`opacityTex`（texture2D）、`opacitySampler`（sampler）
- **片元槽位**：
    - `AT` —— 调制 Alpha：
        - RGB 模式（`fromRGB=true`）：`alpha *= luminance(textureSample(...).rgb) * mat.opacityLevel`
        - Alpha 模式：`alpha *= textureSample(...).a * mat.opacityLevel`

### `std-vertex-color-fragment.ts` — 网格顶点颜色

- **工厂**：`createStdVertexColorFragment(): ShaderFragment`
- **ID**：`"std-vertex-color"`
- **顶点属性**：`color: vec4<f32>`（`float32x4`，16 字节步长）
- **插值变量**：`vColor: vec4<f32>`
- **顶点槽位**：
    - `VB` —— `out.vColor = color`
- **片元槽位**：
    - `AT` —— `baseColor *= input.vColor.rgb; alpha *= input.vColor.a`
- **激活方式**：`enableStandardVertexColors()` 安装该工厂；仅带有颜色缓冲区的网格使用它。

### `std-reflection-fragment.ts` — 反射纹理

- **工厂**：`createStdReflectionFragment(): ShaderFragment`
- **ID**：`"std-reflection"`
- **绑定**：`reflectionTex`（texture2D）、`reflectionSampler`（sampler）
- **辅助 WGSL**：`computeSphericalCoords()`、`computePlanarCoords()`
- **片元槽位**：
    - `AD` —— 通过 `mat.reflectionCoordMode` 选择球面或平面坐标，采样反射纹理，写入 `reflectionColor * mat.reflectionLevel`

### `std-shadow-fragment.ts` — 阴影接收

- **工厂**：`createStdShadowFragment(shadowLights: ShadowLightSlot[]): ShaderFragment`
- **ID**：`"std-shadow"`
- **接口**：`ShadowLightSlot { lightIndex: number; shadowType: "esm" | "pcf" }`
- **插值变量**：逐灯光 `vPosFromLight_<n>`（`vec4<f32>`）、`vDepthMetric_<n>`（`f32`）
- **绑定**：逐灯光阴影纹理 + 采样器 + `shadowInfo_<n>` uniform 缓冲区（组 `"shadow"`）
- **辅助 WGSL**：逐灯光 `shadowInfo_<n>Uniforms` 结构体、ESM（`computeShadowESM_<n>`、`computeFallOff_<n>`）以及 PCF（`computeShadowPCF_<n>`）函数
- **顶点槽位**：
    - `VB` —— 将世界位置变换到灯光空间，计算深度度量
- **片元槽位**：
    - `AD` —— 通过 ESM 或 PCF 为每个灯光写入 `shadowFactors[lightIndex]`

## 着色器逻辑

### 顶点着色器（由模板 + 片段组合）

```
finalWorld = mesh.world
if skeleton: finalWorld = mesh.world × weightedBoneMatrix(joints, weights[, joints1, weights1])
worldPos = finalWorld × vec4(positionOrMorphedPosition, 1.0)
normalWorld = mat3x3(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz)
vNormalW = normalize(normalWorld × normal)
clipPos = scene.viewProjection × worldPos
if scene fog: vFogDistance = (scene.view × worldPos).xyz
```

若 `NEEDS_UV`：`vDiffuseUV = uv × uvScaleOffset.xy + uvScaleOffset.zw`，其中省略的 `uvOffset` 贡献 `[0, 0]`。
若顶点颜色已启用且存在：传递 `vec4<f32>` `vColor` 插值变量；片元 RGB 始终乘以 `baseColor`。在 `mesh.hasVertexAlpha`（VERTEX_ALPHA）开关下，Alpha 会额外乘以当前 `alpha` 且 Alpha 测试比较使用 `vColor.a`；否则顶点颜色仅作用于 RGB。
若 `RECEIVE_SHADOWS`：`vPositionFromLight = shadow.lightMatrix × worldPos`，`vDepthMetric = (lightClip.z + near) / far`
若为 CSM：在片元着色器中根据 `(scene.view × vec4(vp, 1)).z` 推导级联选择视图 Z 值；不依赖仅限雾效的 `vFogDistance` 插值变量。

### 片元着色器（由模板 + 片段组合）

#### Blinn-Phong 光照（`computeLighting`）

```
if lightData.w == 0:  // Point light
  direction = lightPos - fragmentPos
  attenuation = max(0, 1 - length(direction) / range)
  lightVectorW = normalize(direction)
else:                  // Directional light
  lightVectorW = normalize(-lightDir)
  attenuation = 1.0

NdotL = max(0, dot(N, L))
diffuse = NdotL × lightDiffuse × attenuation
H = normalize(V + L)
specComp = pow(max(0, dot(N, H)), max(1, glossiness))
specular = specComp × lightSpecular × attenuation
```

当启用顶点颜色时：

```
baseColor *= vColor.rgb
alpha *= vColor.a
```

#### ESM 阴影（若 `RECEIVE_SHADOWS`）

```
shadowPixelDepth = clamp(depthMetric, 0, 1)
shadowMapSample = textureSampleLevel(shadowTex, shadowSampler, uv, 0).x
esm = 1 - clamp(exp(min(87, depthScale × shadowPixelDepth)) × shadowMapSample, 0, 1 - darkness)
shadow = computeFallOff(esm, clipSpace.xy, frustumEdgeFalloff)
```

#### 雾效（`calcFogFactor`）

```
dist = length(vFogDistance)
mode 3 (linear):  fogCoeff = (end - dist) / (end - start)
mode 1 (exp):     fogCoeff = 1 / e^(dist × density)
mode 2 (exp2):    fogCoeff = 1 / e^(dist² × density²)
```

#### 最终合成

```
baseColor = textureSample(diffuseTex, ...) × textureLevel     // if HAS_DIFFUSE_TEXTURE, else vec4(1)
emissiveTex = textureSample(emissiveTex, ...).rgb              // if HAS_EMISSIVE_TEXTURE
shadow = computeShadowWithESM(...)                             // if RECEIVE_SHADOWS, else 1.0

finalDiffuse = clamp(diffuseBase × shadow × diffuseColor + emissiveColor + ambientColor, 0, 1) × baseColor.rgb
finalSpecular = specularBase × shadow × specularColor
color = vec4(finalDiffuse + finalSpecular, alpha)
color = max(color, 0)
if fogMode > 0: color.rgb = mix(fogColor, color.rgb, fogCoeff)
```

## 状态机 / 生命周期

```
addToScene(scene, mesh)            → mesh registered for deferred building
registerScene(scene)       → runs deferred builders and builds frame graph
  standardGroupBuilder()           → detects features, dynamically imports fragment modules
  buildStandardMeshRenderables()   → groups meshes by features, composes shaders
    composeStandardShader()        → createStandardTemplate() + composeShader(template, fragments)
    getOrCreatePipeline()          → cached pipeline + scene UBO
    createDynamicMeshGPU()         → per-mesh UBOs + bind groups
  → renderables + updater registered by buildScene
  render loop begins
    updater.update(engine)         → refreshes light/material state
    RenderTask updates each DrawBinding with its target dimensions
    DrawBinding.draw(pass, engine) → dispatches draw calls per mesh
  mesh.material = newMat           → triggers single-rebuild path
    buildSingleStandardRenderable()→ recomputes features, gets pipeline, creates mesh GPU resources
```

## Babylon.js 等价对照表

| Babylon Lite                                   | Babylon.js                                                 |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `createStandardMaterial()`                     | `new BABYLON.StandardMaterial("mat", scene)`               |
| `HAS_DIFFUSE_TEXTURE`                          | `#define DIFFUSE`                                          |
| `HAS_EMISSIVE_TEXTURE`                         | `#define EMISSIVE`                                         |
| `RECEIVE_SHADOWS`                              | `#define SHADOW0`                                          |
| `HAS_BUMP_TEXTURE`                             | `#define BUMP`                                             |
| `HAS_SPECULAR_TEXTURE`                         | `#define SPECULAR`                                         |
| `HAS_AMBIENT_TEXTURE`                          | `#define AMBIENT`                                          |
| `HAS_LIGHTMAP_TEXTURE`                         | `#define LIGHTMAP`                                         |
| `HAS_OPACITY_TEXTURE`                          | `#define OPACITY`                                          |
| `HAS_REFLECTION_TEXTURE`                       | `#define REFLECTION`                                       |
| `THIN_INSTANCES` / `THIN_INSTANCE_COLOR`       | `mesh.thinInstanceSetBuffer(...)`                          |
| `material.disableLighting`                     | `material.disableLighting`                                 |
| `computeFeatures()`                            | `StandardMaterial._getEffect()` 中的内部宏定义计算         |
| `getOrCreatePipeline()`                        | StandardMaterial 中的管线缓存                              |
| `createStandardTemplate()` + `composeShader()` | 基于宏定义生成 GLSL 着色器                                 |
| `ShaderFragment` 组合                          | `#include` / `#define` 预处理器                            |
| `DrawBinding.update(context)`                  | 绘制前刷新逐网格/材质 uniform                              |
| `buildSingleStandardRenderable()`              | `Material._markAllSubMeshesAsAllDirty()`                   |
| 着色器中的 `computeLighting()`                 | Babylon 标准着色器中的 `computeLighting()`                 |
| `calcFogFactor()`                              | Babylon 中的 `CalcFogFactor()`                             |
| `computeShadowWithESM()`                       | Babylon 中的 `computeShadowWithESM()`                      |

## 依赖关系

- **`standard-material.ts`**：从 `texture-2d` 导入 `Texture2D`，从 `ubo-layout` 导入 `computeUboLayout`，从 `standard-template` 导入 `createStandardTemplate`。
- **`standard-template.ts`**：从 `fragment-types` 导入 `ShaderTemplate`、`UboField`、`VertexAttribute`、`Varying`、`BindingDecl`，从 `wgsl-helpers` 导入 `WGSL_FOG`。
- **`standard-pipeline.ts`**：从 `standard-template` 导入 `createStandardTemplate`，从 `shader-composer` 导入 `composeShader`，从 `standard-material` 导入类型，以及阴影生成器类型、灯光 UBO 辅助函数。
- **`standard-renderable.ts`**：从 `standard-pipeline` 导入管线函数，从 `fragment-types` 导入 `ShaderFragment`，以及场景/引擎/网格/灯光类型、材质视图类型、可渲染对象接口、资源池辅助函数，并返回单网格重建闭包。
- **`no-color-view.ts`**：导入 `createMaterialView` 与 Standard 特性标志以创建无颜色材质视图，同时不将该辅助函数拉入普通 Standard 场景。
- **片段模块**（`fragments/`）：每个模块仅从 `fragment-types.js` 导入 `ShaderFragment`（以及可选的 `BindingDecl`、`Varying`）。
- **`thin-instance-gpu.ts`**（`src/mesh/`）：当检测到精简实例时由 `standardGroupBuilder` 按需导入。
- **被以下模块依赖**：应用代码（通过 `createStandardMaterial`）、网格工厂、`skybox-cubemap`（共享场景 UBO 布局）。

## 测试规范

| 测试                              | 说明                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- |
| `createStandardMaterial defaults` | 所有属性与文档记录的默认值一致                                         |
| `pipeline cache hit`              | 相同的 features+format+msaa → 同一变体对象                             |
| `pipeline cache miss on features` | 不同的 features → 不同的变体                                           |
| `simple shader (features=0)`      | 无 UV 属性，无纹理绑定                                                 |
| `textured shader (features=1)`    | 添加了 UV 属性，绑定了漫反射纹理                                       |
| `shadow shader (features=4)`      | 创建了阴影 UBO 与阴影贴图绑定组                                        |
| `full shader (features=7)`        | 所有绑定均存在                                                         |
| `mesh grouping`                   | 具有相同特性的网格共享管线                                             |
| `Blinn-Phong NdotL=0`             | 漫反射 = 0，高光 = 0                                                   |
| `minimal Standard excludes fog`   | 无场景雾效上下文时不包含雾效辅助函数或混合 WGSL                        |
| `explicit fog composition`        | 使用 `STD_SCENE_FOG` 时出现雾效辅助函数与混合代码                      |
| `fog cache separation`            | 共享设备上的有雾/无雾场景获得各自的绑定/WGSL                           |
| `default UV offset`               | 全局启用 UV 偏移且材质省略偏移时写入零                                 |
| `Standard skeleton composition`   | 共享的 4/8 骨骼片段、骨骼绑定以及顶点布局                              |
| `Standard vertex-color alpha`     | RGBA 调制先于 Alpha 测试和几何遮罩                                     |
| `geometry deformation`            | 几何着色器/布局/绑定/绘制变体包含变形、骨骼和顶点颜色                  |
| `root feature exports`            | 根声明暴露每个启用器且不包含包子路径                                   |
| `single rebuild`                  | 材质替换仅重建单个网格而无需完整场景拆除                               |
| `fragment composition`            | 凹凸片段注入 perturbNormal 辅助函数 + AC 槽位代码                      |
| `shadow fragment ESM`             | 逐灯光 ESM 阴影因子计算                                                |
| `shadow fragment PCF`             | 逐灯光 PCF 阴影因子计算                                                |
| `scene267-standard-vertex-colors` | Standard RGBA 顶点颜色插值精确匹配 BJS                                 |

## 文件清单

| 文件                                                           | 规模     | 用途                                                                                       |
| -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `src/material/standard/standard-material.ts`                   | ~299 行  | 类型（StandardMaterialProps、FogConfig）、工厂函数、collectStdBoundTextures、带动态片段导入的 standardGroupBuilder |
| `src/material/standard/standard-template.ts`                   | —        | `StandardTemplateConfig` + `createStandardTemplate()` —— 构建最小 Blinn-Phong `ShaderTemplate`；雾效为动态加载片段 |
| `src/material/standard/standard-pipeline.ts`                   | —        | `composeStandardShader()`、完整着色器上下文缓存键、网格绑定组、UV 变换写入、材质 UBO 写入  |
| `src/material/standard/standard-renderable.ts`                 | —        | `StdFragmentFactories`、有效网格特性、逐场景着色器上下文、已组合绑定/管线、绘制时变形缓冲区 |
| `src/material/standard/enable-standard-vertex-colors.ts`       | —        | 规范的进程全局可选入口，用于安装 Standard RGBA 顶点颜色支持同时保持非特性打包字节一致     |
| `src/material/standard/enable-standard-mesh-features.ts`       | —        | 已发布的幂等骨骼与 UV 偏移启用器                                                           |
| `src/material/geometry-deformation-hooks.ts`                   | —        | 仅限几何通道的延迟加载共享变形速度特性                                                     |
| `src/material/geometry-deformation-velocity.ts`                | —        | 由 PBR 与 Standard 共享的可渲染对象局部上一帧骨骼/变形快照及着色器代码                     |
| `src/material/standard/fragments/std-skeleton-fragment.ts`     | —        | 围绕共享骨骼片段的 Standard 包装器；骨骼纹理 + joints/weights 绑定                         |
| `src/material/standard/std-fog-wgsl.ts`                        | —        | 动态导入的 Standard 雾效片段（插值变量、辅助函数与最终混合）                               |
| `src/shader/fragments/skeleton-fragment.ts`                    | —        | 由 PBR 与 Standard 共享的材质无关 4/8 骨骼 WGSL                                            |
| `src/material/standard/standard-geometry-renderable.ts`        | —        | 几何通道 Standard 变体缓存、布局、绑定、更新以及包含变形状态的绘制缓冲区                   |
| `src/material/standard/no-color-view.ts`                       | ~16 行   | `createStandardNoColorMaterialView()` —— 通道专用的无颜色材质视图辅助函数                  |
| `src/material/standard/fragments/normal-map-fragment.ts`       | ~33 行   | 余切框架凹凸/法线贴图片段（`AC` 槽位）                                                     |
| `src/material/standard/fragments/std-emissive-fragment.ts`     | ~17 行   | 自发光纹理采样片段（`AT` 槽位）                                                            |
| `src/material/standard/fragments/std-specular-fragment.ts`     | ~18 行   | 高光纹理采样片段（`AT` 槽位，支持 UV/UV2）                                                 |
| `src/material/standard/fragments/std-ambient-fragment.ts`      | ~18 行   | 环境光/AO 纹理采样片段（`AD` 槽位，支持 UV/UV2）                                           |
| `src/material/standard/fragments/std-lightmap-fragment.ts`     | ~18 行   | 叠加光照贴图片段（`BC` 槽位，支持 UV/UV2）                                                 |
| `src/material/standard/fragments/std-opacity-fragment.ts`      | ~20 行   | 不透明度纹理片段（`AT` 槽位，RGB 或 Alpha 模式）                                           |
| `src/material/standard/fragments/std-vertex-color-fragment.ts` | ~20 行   | RGBA 顶点属性/插值变量及基础色/Alpha 相乘（`VB` + `AT` 槽位）                              |
| `src/material/standard/fragments/std-reflection-fragment.ts`   | ~39 行   | 球面/平面反射片段（`AD` 槽位）                                                             |
| `src/material/standard/fragments/std-shadow-fragment.ts`       | ~155 行  | ESM/PCF 阴影接收片段（逐灯光，`VB` + `AD` 槽位）                                           |
| `src/mesh/thin-instance-gpu.ts`                                | ~50 行   | `syncThinInstanceBuffers()` —— 上传实例矩阵/颜色顶点缓冲区                                 |
| `src/shader/shader-composer.ts`                                | ~293 行  | `composeShader()` —— 拓扑排序、UBO 合并、绑定分配、槽位注入                                |
