# 模块：着色器组合（Shader Composition）

> 包路径：`packages/babylon-lite/src/shader/`

## 目的

提供声明式的、基于片段（fragment）的着色器组合系统。各个渲染特性（IBL、清漆、骨骼蒙皮、薄实例、法线贴图等）被封装为 `ShaderFragment` 对象，声明其 WGSL 代码、绑定、UBO 字段、顶点属性和插值变量（varying）。`ShaderComposer`（`composeShader()`）通过拓扑排序、槽位注入和绑定组布局合并，将片段组装为最终的 WGSL 源码和 GPU 管线描述符。

关键设计原则：

- **零全局状态** —— 无模块级注册表；片段以数组形式传入
- **完全可 tree-shake** —— 未使用的片段不会向 bundle 增加任何字节
- **材质拥有着色器** —— 组合器是通用的；材质自行选择要包含哪些片段
- **不解析 WGSL** —— 结构化数据（UBO 字段、绑定）使用强类型接口，绝不对生成的 WGSL 运行正则解析

## 公共 API 接口

### 常量

```typescript
// Shader stage visibility flags (numeric for Node.js compatibility — no GPUShaderStage in Node)
const STAGE_VERTEX = 0x1; // GPUShaderStage.VERTEX
const STAGE_FRAGMENT = 0x2; // GPUShaderStage.FRAGMENT
```

### 类型 —— `fragment-types.ts`

```typescript
// ── WGSL scalar/vector types ──
export type WgslScalarType = "f32" | "u32" | "i32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>" | "mat4x4<f32>";

// ── Vertex Attributes ──
export interface VertexAttribute {
    readonly name: string; // WGSL variable name (e.g. "position", "world0")
    readonly type: string; // WGSL type (e.g. "vec3<f32>")
    readonly gpuFormat: GPUVertexFormat;
    readonly arrayStride: number;
    readonly stepMode?: GPUVertexStepMode; // default "vertex"
    readonly bufferGroup?: string; // shared buffer key (e.g. "ti-matrix")
    readonly offset?: number; // byte offset within buffer (default 0)
}

// ── Varyings ──
export interface Varying {
    readonly name: string; // WGSL variable name
    readonly type: string; // WGSL type
}

// ── UBO Fields ──
export interface UboField {
    readonly name: string; // WGSL field name
    readonly type: WgslScalarType;
}

// ── Binding Declarations ──
export type BindingKind =
    | { readonly kind: "uniform-buffer" }
    | {
          readonly kind: "texture";
          readonly textureType: "texture_2d<f32>" | "texture_cube<f32>" | "texture_depth_2d" | "texture_2d<u32>";
          readonly sampleType?: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
      }
    | { readonly kind: "sampler"; readonly samplerType: "sampler" | "sampler_comparison" }
    | {
          readonly kind: "storage-texture";
          readonly access: "read" | "write" | "read_write";
          readonly gpuAccess: GPUStorageTextureAccess;
          readonly format: string;
      };

export interface BindingDecl {
    readonly name: string; // WGSL variable name
    readonly type: BindingKind;
    readonly group?: "mesh" | "shadow"; // default "mesh" → group(1); "shadow" → group(2)
    readonly visibility: GPUShaderStageFlags;
}

// ── Fragment Slot Markers ──
export type FragmentSlot = "HF" | "SV" | "AT" | "AC" | "MF" | "BL" | "AD" | "AI" | "NI" | "BC" | "BA";
export type VertexSlot = "VR" | "VW" | "VB";
```

### ShaderFragment 接口

```typescript
export interface ShaderFragment {
    readonly id: string; // unique ID for dedup + dependency resolution
    readonly dependencies?: readonly string[]; // fragment IDs that must compose before this one

    // ── Vertex stage ──
    readonly vertexAttributes?: readonly VertexAttribute[];
    readonly varyings?: readonly Varying[];
    readonly vertexBindings?: readonly BindingDecl[];
    readonly vertexSlots?: Partial<Record<VertexSlot, string>>;
    readonly pipelineVertexBuffers?: (nextLoc: number) => { buffers: GPUVertexBufferLayout[]; nextLoc: number };
    readonly vertexBuiltins?: readonly { readonly name: string; readonly builtin: string; readonly type: string }[];
    readonly vertexHelperFunctions?: string;

    // ── Fragment stage ──
    readonly uboFields?: readonly UboField[];
    readonly bindings?: readonly BindingDecl[];
    readonly helperFunctions?: string;
    readonly fragmentSlots?: Partial<Record<FragmentSlot, string>>;
}
```

### ShaderTemplate 接口

```typescript
export interface ShaderTemplate {
    readonly vertexTemplate: string; // WGSL with slot markers
    readonly fragmentTemplate: string; // WGSL with slot markers
    readonly baseMeshUboFields: readonly UboField[];
    readonly baseVertexAttributes: readonly VertexAttribute[];
    readonly baseVaryings: readonly Varying[];
    readonly baseBindings?: readonly BindingDecl[];
    readonly baseVertexBindings?: readonly BindingDecl[];
    readonly baseMaterialUboFields?: readonly UboField[];
}
```

### 组合输出

```typescript
export interface UboSpec {
    readonly totalBytes: number; // aligned to 16 bytes
    readonly offsets: ReadonlyMap<string, number>; // field name → byte offset
    readonly structBody: string; // WGSL struct body (fields only)
}

export interface ComposedShader {
    readonly vertexWGSL: string;
    readonly fragmentWGSL: string;
    readonly meshBGLDescriptor: GPUBindGroupLayoutDescriptor; // group(1)
    readonly shadowBGLDescriptor: GPUBindGroupLayoutDescriptor | null; // group(2)
    readonly vertexBufferLayouts: GPUVertexBufferLayout[];
    readonly meshUboSpec: UboSpec;
    readonly sceneUboSpec: UboSpec;
    readonly fragmentKey: string; // sorted IDs joined with "|" — pipeline cache key
}
```

### 主函数

```typescript
export function composeShader(template: ShaderTemplate, fragments: readonly ShaderFragment[]): ComposedShader;
```

### UBO 布局

```typescript
export function computeUboLayout(fields: readonly UboField[]): UboSpec;
```

## 内部架构

### 拓扑排序 —— `topoSort()`

片段通过 `dependencies: string[]` 声明依赖关系。组合器执行：

1. 构建 `id → ShaderFragment` 映射表
2. 根据依赖边计算入度
3. 执行 Kahn 算法，对入度为零的节点按确定性的字母序排列
4. 遇到重复 ID、未知依赖或循环依赖时抛出异常

排序后的顺序决定了：

- 代码注入顺序（片段按依赖顺序向槽位贡献代码）
- 绑定索引分配（确定性的绑定编号）
- UBO 字段顺序

### 槽位注入 —— `injectSlots()`

模板包含格式为 `/*SLOT_NAME*/`（例如 `/*AI*/`、`/*VW*/`）的注释标记。

正则表达式 `SLOT_RE = /\/\*([A-Z_0-9]+)\*\//g` 查找所有标记。对于每个标记，组合器：

1. 遍历排序后的片段
2. 从 `fragmentSlots` 或 `vertexSlots` 收集对该槽位名的所有贡献
3. 使用 `\n` 拼接各贡献代码
4. 将标记替换为拼接后的代码

**片元槽位标记**（片元着色器）：

| 槽位 | 用途 |
| ---- | ------------------------------- |
| `HF` | 辅助函数 |
| `SV` | 着色器变量初始化 |
| `AT` | Alpha / 纹理修改 |
| `AC` | Alpha 截断（Alpha cutoff） |
| `MF` | 材质函数覆写 |
| `BL` | 光照计算前的变量 |
| `AD` | 直接光照之后 |
| `AI` | 环境光 / IBL 集成 |
| `NI` | 法线注入 |
| `BC` | 颜色输出之前 |
| `BA` | Alpha 输出之前 |

**顶点槽位标记**：

| 槽位 | 用途 |
| ---- | ------------------------------------------------------- |
| `VR` | 主体之前（变形预蒙皮） |
| `VW` | 计算 `finalWorld`（骨骼蒙皮、薄实例） |
| `VB` | 世界变换之后（varying 透传） |

### 模板标记（非槽位）

一次性替换的固定标记（不跨片段迭代）：

| 标记 | 替换内容 |
| -------- | ---------------------------------------------- |
| `/*SU*/` | `struct SceneUniforms { ... }` |
| `/*MU*/` | `struct MeshUniforms { ... }` |
| `/*VI*/` | `struct VertexInput { ... }` |
| `/*VO*/` | `struct VertexOutput { ... }` |
| `/*VD*/` | 顶点绑定声明 |
| `/*VP*/` | 顶点函数参数（内置变量 + 输入） |
| `/*VH*/` | 顶点辅助函数 |
| `/*FI*/` | `struct FragmentInput { ... }` |
| `/*HF*/` | 片元辅助函数 |
| `/*FB*/` | 片元绑定声明 |

### 绑定组布局构建

组合器在帧图场景组之后发出材质持有的绑定组：

- **Group 0**：外部帧图场景组，不由组合器拥有。binding 0 是逐通道 `SceneUniforms` UBO，binding 1 是场景持有的 `LightsUniforms` UBO。
- **Group 1 ("mesh")**：Mesh UBO（binding 0，始终存在）、可选的 Material UBO（当存在 `baseMaterialUboFields` 时为 binding 1），以及随后的片段绑定
- **Group 2 ("shadow")**：阴影专用绑定（可选）

绑定分配顺序：

1. `template.baseVertexBindings`（顶点阶段绑定）
2. 每个排序后片段的 `vertexBindings`
3. `template.baseBindings`（片元阶段绑定）
4. 每个排序后片段中 `group === "mesh"` 或默认组的 `bindings`
5. 每个排序后片段中 `group === "shadow"` 的 `bindings`

组合器的 `addBinding()` 对每个 `BindingKind` 仅处理一次，同时生成其 `GPUBindGroupLayoutEntry` 和 WGSL 声明，随后根据 `visibility` 将声明路由到顶点和/或片元阶段。绑定顺序以及独立的 mesh/shadow 计数器保持不变。

存储纹理声明保留 WGSL 访问拼写（`read`、`write`、`read_write`），而其 WebGPU 描述符使用对应的 `read-only`、`write-only` 和 `read-write` 值。非过滤采样器同样在描述符中使用 `non-filtering`，而在 WGSL 中使用普通的 `sampler`。生成的顶点输入文本也同时复用于输入结构体和顶点入口参数。

### 顶点缓冲区布局构建

1. 对模板 `baseVertexAttributes` + 片段 `vertexAttributes` 按名称去重
2. 每个没有 `bufferGroup` 的属性获得自己独立的 `GPUVertexBufferLayout`
3. 共享同一 `bufferGroup` 的属性打包到单个交错缓冲区布局中（例如，薄实例 `world0`–`world3` 共享步长为 64 的 `"ti-matrix"`）
4. 带有 `pipelineVertexBuffers` 回调的片段会追加额外布局（例如骨骼关节/权重）

### UBO 布局 —— `ubo-layout.ts`

`computeUboLayout()` 遵循 WGSL uniform 缓冲区对齐规则（类 std140）：

| 类型 | 对齐 | 大小 |
| --------------------- | ----- | ------ |
| `f32` | 4 | 4 |
| `u32` / `i32` | 4 | 4 |
| `vec2<f32>` | 8 | 8 |
| `vec3<f32>` | 16 | 12 |
| `vec4<f32>` | 16 | 16 |
| `vec4<u32>` | 16 | 16 |
| `mat4x4<f32>` | 16 | 64 |
| `array<vec4<u32>, N>` | 16 | 16 × N |

数组类型解析允许逗号后存在可选空白，因此 `array<vec4<u32>, 4>` 和 `array<vec4<u32>,4>` 都是有效的字段类型字符串。这对于生产环境 bundle 很重要，因为内联 WGSL 压缩可能会移除空格。

算法：

1. 按顺序遍历字段，将游标对齐到字段对齐边界
2. 记录每个字段名的字节偏移量
3. 生成 WGSL 结构体主体（每个字段一行 `name: type,`）
4. 将总大小向上取整至 16 字节边界

组合后的着色器仅生成材质持有的 UBO 规范：

- **Mesh UBO**：模板 `baseMeshUboFields`（group 1, binding 0）
- **Material UBO**：当存在 `baseMaterialUboFields` 时为模板 `baseMaterialUboFields` + 片段 `uboFields`（group 1, binding 1）；否则片段 `uboFields` 追加到 Mesh UBO

规范场景 UBO 并非由片段组合而成。材质模板通过 `/*SU*/` 标记前置引入 `SCENE_UBO_WGSL`，并由 `RenderTask` 为每个通道写入 group-0 场景绑定组。

### 去重 —— `dedup()`

模板基础数组和片段贡献以按名称去重的方式合并。首次出现优先。应用于顶点属性和插值变量。

## 管线配置

不适用 —— 组合器生成管线描述符，但不创建 GPU 管线。管线创建由材质系统负责。

## 着色器逻辑 —— `wgsl-helpers.ts`

共享 WGSL 代码段（纯函数字符串，无绑定）：

### `WGSL_PERTURB_NORMAL`

切线空间法线贴图扰动。要求作用域内存在 `bumpTex`、`bumpSampler`。

```
fn perturbNormal(vNormalW, positionW, uv, bumpScale) → vec3<f32>
  Sample normal map, construct cotangent frame from screen-space derivatives,
  transform normal sample into world space.
```

### `WGSL_SHADOW_ESM`

指数阴影贴图采样。要求作用域内存在 `shadowTex`、`shadowSampler`。

```
fn computeFallOff(value, clipSpace, frustumEdgeFalloff) → f32
fn computeShadowWithESM(posFromLight, depthMetric, darkness, depthScale, frustumEdgeFalloff) → f32
  Projects shadow coordinates, samples depth, applies ESM with edge falloff.
```

### `WGSL_FOG`

线性 / 指数 / 指数平方雾。要求 `scene.vFogInfos`（vec4：mode, start, end, density）。

```
fn calcFogFactor(fogDistance: vec3<f32>) → f32
```

### `WGSL_IMAGE_PROCESSING`

曝光 → Reinhard 色调映射 → 伽马校正 → 对比度。要求 `scene.exposureLinear`、`scene.contrast`。

```
fn applyImageProcessing(result: vec4<f32>) → vec4<f32>
  rgb *= exposureLinear
  rgb = 1 - exp2(-1.590579 * rgb)   // tonemapping
  rgb = pow(rgb, 1/2.2)              // gamma
  contrast interpolation (below 1: mix with 0.5; above 1: mix with S-curve)
```

### `WGSL_DITHER`

基于噪声的抖动。纯数学计算，无 UBO 依赖。

```
fn dither(seed: vec2<f32>, varianceAmount: f32) → f32
  fract(sin(dot(seed, [12.9898, 78.233])) * 43758.5453)
  Mix ±normVariance where normVariance = varianceAmount / 255
```

### 规范 SceneUniforms

所有运行时材质着色器均使用来自 `packages/babylon-lite/shaders/scene-uniforms.wgsl`、通过 `src/shader/scene-uniforms.ts` 导入的规范 `SceneUniforms` 声明。该结构体大小固定（`SCENE_UBO_BYTES = 352`），包含：

- `viewProjection`、`view` 和 `vEyePosition`
- 环境旋转、SH 辐照度、曝光/对比度/LOD 图像处理字段
- 雾效信息/颜色

光照数据不追加到 `SceneUniforms` 中；当直接光照激活时，Standard 和 PBR 使用独立的 `render/lights-ubo.ts` 缓冲区。帧图 `RenderTask` 为每个通道拥有一个场景 UBO/绑定组，使离屏通道可以写入特定于目标的投影状态（包括 Y 轴翻转），而不会修改全局场景状态。

## 状态机 / 生命周期

组合器是一个纯函数 —— 无生命周期或状态。调用 `composeShader(template, fragments)` 并接收一个 `ComposedShader`。

材质按 `fragmentKey`（以 `"|"` 连接的已排序片段 ID）缓存组合后的着色器。

## Babylon.js 等价映射

| Babylon.js | Babylon Lite |
| ------------------------------------- | --------------------------------------------------------- |
| `ShaderMaterial` + Effect 系统 | `ShaderTemplate` + `ShaderFragment[]` + `composeShader()` |
| `#define` 预处理宏 | 槽位注入（`/*AI*/`、`/*VW*/` 等） |
| `UniformBuffer` 布局 | 基于 `UboField[]` 的 `computeUboLayout()` |
| `MaterialPluginBase` | `ShaderFragment` 接口 |
| `Effect.ShadersStore`（全局） | 片段模块（可 tree-shake 导入） |
| `Engine._caps` 特性检测 | 片段 `dependencies`（显式） |
| `PBRMaterial.customShaderNameResolve` | 片段槽位贡献 |

## 依赖项

- 无外部依赖 —— 纯 TypeScript，零 npm 导入
- 内部：`fragment-types.ts`（类型）、`ubo-layout.ts`（UBO 计算）

## 测试规范

1. **拓扑排序**：验证菱形依赖（A→B,C→D）下的正确排序
2. **环检测**：验证对 A→B→A 抛出错误
3. **重复片段 ID**：验证抛出错误
4. **未知依赖**：验证抛出错误
5. **槽位注入**：验证 `/*AI*/` 按依赖顺序被替换为拼接的片段贡献
6. **绑定分配**：验证网格绑定获得从 1 开始的顺序索引
7. **UBO 布局对齐**：验证 vec3 获得 16 字节对齐，结构体总大小取整到 16
8. **顶点缓冲区分组**：验证 `bufferGroup` 属性合并为单个布局
9. **去重**：验证同名属性/插值变量不重复
10. **片段键**：验证用于管线缓存的确定性键生成

## 文件清单

| 文件 | 职责 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `fragment-types.ts` | 所有类型定义：ShaderFragment、ShaderTemplate、ComposedShader、UboSpec、槽位类型、绑定类型 |
| `shader-composer.ts` | `composeShader()` —— 拓扑排序、槽位注入、绑定组布局构建、WGSL 组装 |
| `ubo-layout.ts` | `computeUboLayout()` —— UBO 结构体的 WGSL 类 std140 对齐计算 |
| `wgsl-helpers.ts` | 共享 WGSL 代码段：perturbNormal、ESM 阴影、雾效、图像处理、抖动 |
| `fragments/thin-instance-fragment.ts` | 示例片段：薄实例世界矩阵 + 可选实例颜色 |
