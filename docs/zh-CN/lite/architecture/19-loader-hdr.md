# 模块：HDR 加载器（Loader HDR）

> 包路径：`packages/babylon-lite/src/loader-hdr/`

## 目的

加载 Radiance `.hdr` (RGBE) 等距柱状投影全景图文件，并生成与 Babylon.js `HDRCubeTexture` 相同的 GPU 就绪 IBL（基于图像的光照）纹理。该管线分为五个阶段运行：RGBE 解析（CPU）、球谐函数提取（CPU）、等距柱状图→立方体贴图转换（GPU 计算着色器）、重要性采样 GGX 立方体贴图预过滤（GPU 计算着色器）以及 BRDF split-sum 查找表生成（GPU 计算着色器）。

## 公共 API 接口

### 函数

```typescript
// load-hdr.ts
export async function loadHdrEnvironment(scene: SceneContext, url: string, options?: HdrLoadOptions): Promise<EnvironmentTextures>;
```

### 类型

```typescript
export interface HdrLoadOptions {
    faceSize?: number; // cubemap face size in pixels (default 256)
    useCubemapSkybox?: boolean; // render HDR cubemap as skybox background
    skipGround?: boolean; // skip ground plane renderable
    skyboxSize?: number; // skybox mesh size (matches BJS createDefaultEnvironment)
}
```

```typescript
// hdr-parser.ts
export interface HdrImage {
    width: number;
    height: number;
    data: Float32Array; // Float32 RGB (3 floats per pixel, row-major)
}

export function parseRGBE(buffer: ArrayBuffer): HdrImage;

export function computeSHFromEquirect(data: Float32Array, width: number, height: number): Float32Array; // 27 floats: SphericalPolynomial coefficients
```

```typescript
// hdr-ibl-pipeline.ts
export function equirectToCubemapGPU(device: GPUDevice, hdr: HdrImage, faceSize: number): GPUTexture;
export function prefilterCubemapGPU(device: GPUDevice, srcCube: GPUTexture, faceSize: number, mipCount: number): GPUTexture;
export function generateBrdfLut(device: GPUDevice): GPUTexture;
```

## 内部架构

### 阶段 1：RGBE 解析 —— `parseRGBE()`

解码 Radiance `.hdr` 文件：

1. **文件头解析**：读取 `#?` 签名行，接着读取键值对直至空行。提取 `FORMAT=32-bit_rle_rgbe`。
2. **分辨率**：解析 `-Y height +X width` 行。
3. **扫描线解码**：对每一行调用 `decodeScanline()`：
    - **新式 RLE**（若 `width ∈ [8, 0x7FFF]` 且前 4 个字节为 `[2, 2, width_hi, width_lo]`）：
        - 4 个通道遍（R、G、B、E），各自进行 RLE 压缩
        - 游程字节 > 128 → 将下一字节重复 `(run - 128)` 次
        - 游程字节 ≤ 128 → 复制对应数量的字面量字节
    - **旧式扁平格式**：每像素直接占 4 个字节
4. **RGBE → Float**：`rgbeToFloat(r, g, b, e)`：
    ```
    if e == 0: RGB = (0, 0, 0)
    else: scale = 2^(e - 136); RGB = (r * scale, g * scale, b * scale)
    ```
    注：指数偏移为 136（= 128 + 8），符合 Radiance 惯例。

### 阶段 2：球谐函数 —— `computeSHFromEquirect()`

从等距柱状投影全景图计算 2 阶（L=2）球谐函数，与 BJS `SphericalPolynomial.FromHarmonics()` 匹配。

**算法：**

1. 对每个像素 `(px, py)`：
    - `φ = (py + 0.5) / height * π`（极角）
    - `θ = (2(px + 0.5) / width - 1) * π`（方位角）
    - 方向：`(x, y, z) = (sinφ sinθ, cosφ, sinφ cosθ)`
    - 立体角：`dΩ = sinφ * (π/height) * (2π/width)`
    - 钳制极端值：若 `max(r,g,b) > 4096`，则等比缩放使其上限为 4096
2. 对每个颜色通道累加 9 个 SH 基函数（共 27 个）：
    - `Y₀₀ = 0.282094791773878`
    - `Y₁₋₁ = 0.48860251190292 * y`，`Y₁₀ = ... * z`，`Y₁₁ = ... * x`
    - `Y₂₋₂ = 1.092548430592079 * x*y`，以此类推
3. 按 `4π / totalWeight` 归一化
4. 应用辐照度与朗伯缩放：`L0 *= 1, L1 *= 2/3, L2 *= 1/4`
5. 将 SH 转换为 SphericalPolynomial（BJS `FromHarmonics` 惯例）：
    - `poly[x] = L₁₁ * 1.02333 / π`
    - `poly[y] = L₁₋₁ * 1.02333 / π`
    - `poly[z] = L₁₀ * 1.02333 / π`
    - `poly[xx] = (L₀₀ * 0.886227 - L₂₀ * 0.247708 + L₂₂ * 0.429043) / π`
    - `poly[yy] = (L₀₀ * 0.886227 - L₂₀ * 0.247708 - L₂₂ * 0.429043) / π`
    - `poly[zz] = (L₀₀ * 0.886227 + L₂₀ * 0.495417) / π`
    - `poly[yz] = L₂₋₁ * 0.858086 / π`
    - `poly[zx] = L₂₁ * 0.858086 / π`
    - `poly[xy] = L₂₋₂ * 0.858086 / π`

输出：`Float32Array(27)` —— 9 个多项式系数 × 3 个颜色通道（每个系数内 RGB 交错存储）。

### 阶段 3：等距柱状图 → 立方体贴图 —— `equirectToCubemapGPU()`

GPU 计算着色器将等距柱状投影全景图转换为 6 面立方体贴图。

**输入**：`rgba32float` 2D 纹理（等距柱状图，在 CPU 端完成 RGB→RGBA 扩展）
**输出**：`rgba16float` 2D 数组纹理 `[faceSize, faceSize, 6]`

**WGSL 计算着色器**（`EQUIRECT_TO_CUBE_WGSL`）：

- 工作组大小：`(8, 8, 1)`，调度维度 `ceil(faceSize/8) × ceil(faceSize/8) × 6`
- 面角查找：24 个预计算的 `vec3<f32>` 角点（每面 4 个），匹配 BJS `panoramaToCubemap.ts` 布局：
    - 层 0：FACE_RIGHT，层 1：FACE_LEFT，层 2：FACE_UP，层 3：FACE_DOWN，层 4：FACE_FRONT，层 5：FACE_BACK
- 方向：使用 `u = x/size`, `v = y/size` 对面角进行双线性插值
- 等距柱状图 UV：`eu = atan2(z, x) / π * 0.5 + 0.5`，`ev = acos(y) / π`
- 应用 BJS `invertY` 惯例：`py = height - py_raw - 1`

**创建与销毁的资源**：

- 创建 `equirectTex`（rgba32float）、`paramBuf`（16B uniform）—— 均在调度后销毁
- 将 `cubeTex` 返回给调用者

### 阶段 4：立方体贴图预过滤 —— `prefilterCubemapGPU()`

针对 IBL 镜面反射立方体贴图的重要性采样 GGX 预过滤，匹配 BJS `HDRFiltering`。

**输入**：来自阶段 3 的源立方体贴图
**输出**：具有 `mipCount` 个 mip 级别的 `rgba16float` 立方体纹理

**每个 mip 级别的算法**：

- **LOD 0**：通过 `copyTextureToTexture` 进行精确纹素拷贝（无双线性重采样）—— 匹配 BJS 行为
- **LOD 1+**：对每个纹素：
    1. 根据面角计算方向 `N`（与阶段 3 相同的参数化）
    2. `alphaG = 2^(mipLevel / 0.8) / srcSize` —— 当前 mip 的粗糙度参数
    3. 根据 `N` 构建切线空间坐标系
    4. 使用 Hammersley 序列进行 1024 次重要性采样：
        - `ξ₀ = i / 1024`，`ξ₁ = radicalInverseVdC(i)`
        - GGX 半程向量：`H = importanceSampleGGX(ξ₀, ξ₁, alphaG)`
        - 反射得到光线方向：`L = 2(N·H)H - N`
        - 基于 PDF 的 LOD：`sampleLod = 0.5 * log2(omegaS / omegaP) + 1.0`
        - 累加：`result += textureSampleLevel(srcCube, L, sampleLod).rgb * NdotL`
    5. 按总 NdotL 权重归一化

**每个 mip 级别提交一次 GPU 命令**，以确保在下一次 `writeBuffer` 前参数缓冲区已被消费。

**资源**：预过滤后销毁源立方体贴图。销毁参数缓冲区。

### 阶段 5：BRDF LUT —— `generateBrdfLut()`

生成 256×256 `rgba16float` BRDF split-sum 查找表。

**WGSL 计算着色器**（`BRDF_LUT_WGSL`）：

- 工作组：`(8, 8)`，调度 `(32, 32)`
- 对每个纹素 `(x, y)`：
    - `NdotV = max((x + 0.5) / 256, 0.001)`
    - `roughness = max((y + 0.5) / 256, 0.04)`
    - `a = roughness²`, `a2 = a²`
    - 每纹素 1024 次重要性采样
    - Smith-GGX 高度相关可见性：`V_Vis = 0.5 / (GGXV + GGXL) * NdotL * (4 * VdotH / NdotH)`
    - Schlick 菲涅耳拆分：`A += (1 - Fc) * V_Vis`，`B += Fc * V_Vis`
- 输出布局：`vec4(B/N, (A+B)/N, 0, 1)` —— 匹配 BJS BRDF LUT 惯例

**管线缓存**：`_brdfPipeline` 在模块级别缓存（首次调用创建，后续复用）。

### 完整管线编排 —— `loadHdrEnvironment()`

```
fetch(url) → ArrayBuffer
     │
     ▼
parseRGBE() → HdrImage { width, height, data: Float32Array }
     │
     ▼
computeSHFromEquirect() → Float32Array(27) irradiance SH
     │
     ▼
equirectToCubemapGPU() → GPUTexture (rgba16float cube, mip 0 only)
     │
     ▼
prefilterCubemapGPU() → GPUTexture (rgba16float cube, all mips, GGX-filtered)
     │
     ▼
generateBrdfLut() → GPUTexture (rgba16float 256×256)
     │
     ▼
assembleEnvironmentTextures() → EnvironmentTextures
     │
     ▼
Set scene._envTextures, scene._irradianceSH
Set imageProcessing: toneMappingEnabled=false, exposure=0.8, contrast=1.2
Register deferred builder for background renderables (skybox + ground)
```

加载后清理：

- 镜面立方体贴图和 BRDF LUT 通过 `acquireGPUTexture()` / `releaseGPUTexture()` 进行引用计数
- 可销毁对象注册到 `scene._disposables`，以便在场景销毁时清理

## 管线配置

### 计算管线：等距柱状图 → 立方体贴图

- 布局：`"auto"`
- 绑定组 0：
    - binding 0：`equirect` —— `texture_2d<f32>`（输入全景图）
    - binding 1：`cubeFaces` —— `texture_storage_2d_array<rgba16float, write>`（输出）
    - binding 2：`params` —— uniform 缓冲区（faceSize、equirectWidth、equirectHeight）

### 计算管线：立方体贴图预过滤

- 布局：`"auto"`
- 绑定组 0：
    - binding 0：`srcCube` —— `texture_cube<f32>`（输入立方体贴图）
    - binding 1：`srcSampler` —— `sampler`（线性过滤）
    - binding 2：`dstFaces` —— `texture_storage_2d_array<rgba16float, write>`（输出 mip）
    - binding 3：`params` —— uniform 缓冲区（faceSize、mipLevel、totalMips、srcSize）

### 计算管线：BRDF LUT

- 布局：`"auto"`
- 绑定组 0：
    - binding 0：`outputTex` —— `texture_storage_2d<rgba16float, write>`

## 着色器逻辑

完整的 WGSL 伪代码和数学公式参见上文阶段 3、4、5。

关键数学函数：

- **radicalInverseVdC**：用于准随机采样的 Van der Corput 序列（位反转）
- **importanceSampleGGX**：根据 GGX NDF 分布生成半程向量
- **D_GGX**：`D = a² / (π * ((N·H)²(a²-1)+1)²)` —— GGX 法线分布函数
- **integrateBRDF**：Smith-GGX 可见性 × Schlick 菲涅耳 split-sum 积分

## 状态机 / 生命周期

该加载器是一次性异步函数。除以下内容外无持久化状态：

- `_brdfPipeline`：模块级缓存的计算管线（每个设备生命周期创建一次）
- 延迟构建器：注册在 `scene._deferredBuilders` 上，用于背景可渲染对象

## Babylon.js 等价映射

| Babylon.js | Babylon Lite |
| --------------------------------------- | -------------------------------------- |
| `HDRCubeTexture` | `loadHdrEnvironment()` |
| `HDRTools.RGBE_ReadPixels` | `parseRGBE()` → `decodeScanline()` |
| `CubeMapToSphericalPolynomialTools` | `computeSHFromEquirect()` |
| `panoramaToCubemap.ts` 面角 | WGSL 中的 `CORNERS` 常量数组 |
| `HDRFiltering`（重要性采样 GGX） | `prefilterCubemapGPU()` 计算着色器 |
| `BRDFTextureTools.GetBRDFTexture` | `generateBrdfLut()` 计算着色器 |
| `EnvironmentTextureTools` | `assembleEnvironmentTextures()` |

## 依赖项

- `../loader-env/load-env.js` —— `EnvironmentTextures` 类型
- `../loader-env/env-helpers.js` —— `assembleEnvironmentTextures()`
- `../resource/gpu-pool.js` —— `acquireGPUTexture`、`releaseGPUTexture`、`getOrCreateSampler`
- `../scene/scene.js` —— `SceneContext`、`SceneContextInternal`
- `../engine/engine.js` —— `EngineInternal`（用于访问设备）
- `../material/pbr/background-hdr-skybox.js` —— 动态导入用于 HDR 天空盒
- `../material/pbr/background-renderable.js` —— 动态导入用于纯色天空盒/地面

## 测试规范

1. **RGBE 解析**：验证针对已知 `.hdr` 文件的宽/高提取与像素值是否正确
2. **RLE 解码**：验证新式（4 通道 RLE）和旧式（扁平）扫描线解码
3. **RGBE→Float 转换**：验证 `2^(e-136)` 缩放能生成正确的 HDR 值
4. **球谐函数**：针对已知全景图，将 SH 系数与 BJS 参考值对比验证
5. **等距柱状图→立方体贴图**：验证面方向与 BJS 角点惯例匹配；验证 UV 映射
6. **GGX 预过滤**：验证 LOD 0 为精确拷贝；验证更高的 LOD 逐级模糊
7. **BRDF LUT**：验证 256×256 输出匹配 BJS split-sum 格式
8. **管线集成**：验证 `loadHdrEnvironment()` 生成有效的 `EnvironmentTextures`
9. **资源清理**：验证中间纹理（等距柱状图、源立方体贴图）已被销毁

## 文件清单

| 文件 | 职责 |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `load-hdr.ts` | 公共 API：编排完整 HDR→IBL 管线，设置场景环境与延迟构建器 |
| `hdr-parser.ts` | CPU 端 RGBE 解析以及从等距柱状投影全景图中提取球谐函数 |
| `hdr-ibl-pipeline.ts` | GPU 计算着色器：等距柱状图→立方体贴图、重要性采样 GGX 预过滤、BRDF LUT 生成 |
