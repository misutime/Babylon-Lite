# 模块：Texture2DArray

> 包路径：`packages/babylon-lite/src/texture/texture-array.ts`

## 用途

提供可 tree-shake 的 WebGPU 2D 纹理数组创建与上传辅助函数，支持图像源、原始 RGBA8 像素、单个多层 KTX2 容器，或按顺序排列的非空独立单层 KTX2 文件列表。

`Texture2DArray` 在自定义着色器中作为 `texture_2d_array<f32>` 采样。内置的 Standard 与 PBR 材质纹理槽仍保持二维，不接受数组层选择。

## 公共 API 接口

```typescript
export interface Texture2DArray extends Texture2D {
    layers: number;
}

export interface TextureArrayOptions {
    mipMaps?: boolean;
    srgb?: boolean;
    format?: GPUTextureFormat;
    addressModeU?: GPUAddressMode;
    addressModeV?: GPUAddressMode;
    minFilter?: GPUFilterMode;
    magFilter?: GPUFilterMode;
}

export interface ArrayLayerUploadOptions {
    invertY?: boolean;
    premultiplyAlpha?: boolean;
}

export interface TextureArrayFromUrlsOptions extends TextureArrayOptions, ArrayLayerUploadOptions {}

export function createTexture2DArray(
    engine: EngineContext,
    width: number,
    height: number,
    layers: number,
    options?: TextureArrayOptions
): Texture2DArray;

export function uploadImageToArrayLayer(
    engine: EngineContext,
    tex: Texture2DArray,
    layer: number,
    source: GPUCopyExternalImageSource,
    opts?: ArrayLayerUploadOptions
): void;

export function loadImageToArrayLayer(
    engine: EngineContext,
    tex: Texture2DArray,
    layer: number,
    url: string,
    opts?: ArrayLayerUploadOptions
): Promise<void>;

export function createTexture2DArrayFromUrls(
    engine: EngineContext,
    urls: readonly [string, ...string[]],
    options?: TextureArrayFromUrlsOptions
): Promise<Texture2DArray>;

export function createTexture2DArrayFromPixels(
    engine: EngineContext,
    data: Uint8Array,
    width: number,
    height: number,
    layers: number,
    options?: TextureArrayOptions
): Texture2DArray;

export function updateTexture2DArrayFromPixels(
    engine: EngineContext,
    tex: Texture2DArray,
    data: Uint8Array,
    mipLevel?: number
): void;

export function uploadKtx2Texture2DArray(
    engine: EngineContext,
    buffer: ArrayBuffer,
    sRGB?: boolean
): Promise<Texture2DArray>;

export function uploadKtx2Texture2DArrayFromBuffers(
    engine: EngineContext,
    buffers: readonly [ArrayBuffer | ArrayBufferView, ...(ArrayBuffer | ArrayBufferView)[]],
    sRGB?: boolean
): Promise<Texture2DArray>;

export function loadKtx2Texture2DArray(
    engine: EngineContext,
    url: string,
    sRGB?: boolean
): Promise<Texture2DArray>;

export function loadKtx2Texture2DArrayFromUrls(
    engine: EngineContext,
    urls: readonly [string, ...string[]],
    sRGB?: boolean
): Promise<Texture2DArray>;
```

包中还在 `texture/ktx2-texture-array.ts` 中保留了这个面向兼容性的 API：

```typescript
export interface Ktx2TextureArrayOptions {
    generateMipMaps?: boolean;
    srgb?: boolean;
    invertY?: boolean;
    minFilter?: GPUFilterMode;
    magFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
}

export function createTexture2DArrayFromKtx2(
    engine: EngineContext,
    buffer: ArrayBuffer | ArrayBufferView,
    options?: Ktx2TextureArrayOptions
): Promise<Texture2DArray>;
```

当需要 Babylon.js 兼容性或其采样器/mipmap 选项时，请使用 `createTexture2DArrayFromKtx2`。它会强制输出 RGBA8，仅上传制作好的基础层（base level），并按需重新生成 mipmap。对于原生 Lite 路径，请使用 `uploadKtx2Texture2DArray` / `loadKtx2Texture2DArray`：它会保留解码器选择的 GPU 压缩格式，并上传完整的预设 mip 链。`FromBuffers` / `FromUrls` 变体将同样的原生契约应用于按调用方顺序提供的独立单层文件。

## 内部架构

KTX2 路径在创建 GPU 资源之前，会将解码器输出转换为一个经过校验的上传计划：

```typescript
interface Ktx2ArrayUploadPlanBase {
    layers: number;
    levels: Ktx2DecodedMip[][]; // [mip level][array layer]
    width: number;
    height: number;
    gpuFormat: GPUTextureFormat;
}

interface CompressedKtx2ArrayUploadPlan extends Ktx2ArrayUploadPlanBase {
    kind: "compressed";
    info: CompressedFormatInfo;
}

interface UncompressedKtx2ArrayUploadPlan extends Ktx2ArrayUploadPlanBase {
    kind: "uncompressed";
    bytesPerPixel: number;
}

type Ktx2ArrayUploadPlan = CompressedKtx2ArrayUploadPlan | UncompressedKtx2ArrayUploadPlan;
```

`groupArrayMips` 将解码器扁平的、按层级主序（level-major）的输出重塑为 `[level][layer]`，并校验每一个 `layerIndex`。`mergeSeparateKtx2Layers` 校验各个独立文件并输出相同的结构，从而使打包源与独立源共享所有后续的校验和上传代码。

预检（Preflight）会校验以下内容：

- 解码维度与基础 mip 维度均为正整数；
- 精确满足 `max(1, base >> level)` 的 mip 递推关系；
- 设备的 2D 维度、数组层数以及合法 mip 数量限制；
- 所选 ASTC、BC 或 ETC2 特性的可用性；
- 当压缩基础尺寸未按块对齐时，检查 `texture-compression-unaligned` 特性；
- 每一个压缩或未压缩的层/mip 负载的精确字节长度。

当适配器提供 `texture-compression-unaligned` 时，`createEngine` 会按需机会性地请求该特性。设备丢失恢复逻辑会捕获设备已启用的特性集合，并在替换适配器/设备上请求相同的特性。

## 管线配置

空纹理数组默认使用 RGBA8，但也可以通过 `options.format` 选择其他可渲染格式，该选项的优先级高于 `srgb`。数据格式可通过 `updateTextureRegion` 填充数据，或通过 `createTextureRenderTarget` 渲染到指定的层/mip。图像辅助函数要求格式受 WebGPU 外部图像拷贝支持。原始像素辅助函数仍明确限定为 RGBA8：它们仅接受 `"rgba8unorm"` 和 `"rgba8unorm-srgb"`，并在分配/上传之前拒绝其他格式。

图像/像素数组分配使用如下配置：

```typescript
{
    dimension: "2d",
    format: options.format ?? (srgb ? "rgba8unorm-srgb" : "rgba8unorm"),
    mipLevelCount: mipMaps ? floor(log2(max(width, height))) + 1 : 1,
    usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT
}
```

其视图维度为 `"2d-array"`。图像上传使用 `copyExternalImageToTexture`；像素上传使用 `writeTexture`。共享的 mipmap 生成器会为每个发生变更的层录制一条 blit 链。

KTX2 数组使用解码器选定的压缩或未压缩格式、预设的 mip 数量以及 `TEXTURE_BINDING | COPY_DST` 用途。由于不进行 mip 生成，它们省略了 `RENDER_ATTACHMENT`。每个层/mip 都以 `origin.z = layer` 写入；压缩拷贝范围向上取整到完整的压缩块，而负载校验使用精确的块数量。

采样器来自引擎采样器池。KTX2 数组使用共享的 KTX2 采样器策略；图像/像素数组使用调用方的寻址/过滤选项。

## 着色器逻辑

使用 `viewDimension: "2d-array"` 声明材质采样器，并通过 `setShaderTexture` 绑定返回的门面对象（facade）。WGSL 单独提供整数层索引：

```wgsl
textureSampleGrad(surfaceMap, surfaceMapSampler, uv, layer, dx, dy)
```

图像上传默认执行物理 Y 轴翻转。由编解码器解码的 KTX2 数据则以未翻转状态上传，并返回 `invertY = true`；自定义着色器代码在遵循该元数据时必须应用 `v = 1 - v`。

## 状态机与生命周期

### 空/图像/像素数组

1. 校验正维度、层数、层索引、mip 索引和负载大小。像素辅助函数还会额外校验 RGBA8 分配格式；格式拒绝不会发布部分创建的纹理，也不会入队上传操作。
2. 创建纹理、`"2d-array"` 视图和池化采样器。
3. 在返回前获取一个逻辑纹理所有权引用。
4. 上传图像/像素数据。
5. 当启用 mipmap 时，在基础层上传后为受影响的层生成 mip。
6. 调用方最终通过共享纹理所有权 API 释放/销毁返回的纹理。

`createTexture2DArrayFromUrls` 使用 `Promise.allSettled` 获取并解码每张图像。如果任意源失败，在重新抛出第一个拒绝错误之前，会关闭所有已兑现的 `ImageBitmap`。成功时，会校验所有维度、上传每个位图并关闭每个位图。

### 打包 KTX2

1. 通过 `decodeKtx2Async` 解码缓冲区。
2. 对所有层和预设 mip 进行分组与预检。
3. 推入 validation 和 out-of-memory 错误作用域。
4. 创建纹理/视图/采样器并上传每个层/mip。
5. 在发布所有权之前弹出并等待两个作用域。
6. 通过惰性弱缓存为每个 `GPUDevice` 观察一次设备丢失。在两个作用域结算后，如果捕获的设备已丢失或在等待期间 `engine._device` 已被替换，则拒绝并销毁该纹理。
7. 失败时销毁已创建的 GPU 纹理，并重新抛出原始操作、作用域、设备丢失或 GPU 错误。
8. 仅在同步工作、异步 WebGPU 校验和设备标识检查均成功后才获取纹理所有权。

### 独立文件 KTX2

1. 在运行时针对无类型检查的调用方拒绝空集合；公共元组类型会在静态层面拒绝空集合。
2. 在启动异步解码之前，将每个 `ArrayBufferView` 规范化为精确独立的 `ArrayBuffer`。
3. 并发解码所有缓冲区。
4. 要求每个结果描述一个具有匹配格式、维度和预设 mip 链的单层。
5. 合并为打包计划格式，并继续执行相同的预检、分配、上传、错误作用域和获取序列。

URL 加载器仅负责 fetch/状态校验，并委托给对应的缓冲区上传器。

## Babylon.js 等价映射

| Lite API | Babylon.js 概念 | Lite 刻意采用的行为 |
|---|---|---|
| `createTexture2DArray` / 像素与图像辅助函数 | `RawTexture2DArray` 及原始数组上传辅助函数 | 带池化采样器与显式所有权的直接 WebGPU 门面 |
| `createTexture2DArrayFromKtx2` | 兼容版 `CreateTexture2DArrayFromKTX2Async` | 为兼容语义和采样器选项保留的 RGBA8/基础层路径 |
| `uploadKtx2Texture2DArray` / `loadKtx2Texture2DArray` | KTX2 数组解码/上传 | 带全部预设 mip 的原生 WebGPU 压缩上传 |
| `FromBuffers` / `FromUrls` | 应用侧独立层组装 | 每个源一次解码、严格一致性检查、调用方顺序定义层序 |

## 依赖关系

- `engine/engine.ts`：设备、队列、限制以及协商后的特性。
- `engine/gpu-flags.ts`：纹理用途常量。
- `resource/texture-acquire.ts`：逻辑所有权获取。
- `resource/texture-sampler-pool.ts`：采样器复用。
- `texture/ktx2-loader.ts`：解码器加载、能力选择、解码类型、采样器策略、sRGB 格式转换。
- `texture/compressed-formats.ts`：压缩块几何信息与所需特性。
- `texture/generate-mipmaps.ts`：图像/像素数组的逐层 mip 生成。
- `texture/mip-count.ts`：完整链 mip 计数。
- `texture/texture-2d.ts`：共享纹理门面。

该模块在导入时不执行任何 GPU 工作。其唯一的可变模块状态是一个惰性 `WeakMap`，用于为每个 `GPUDevice` 安装一次设备丢失观察器；弱键不会持有已退役的设备。

## 测试规范

`tests/lite/unit/ktx2-texture-array.test.ts` 必须覆盖：

- 打包数组、层/mip 排序、维度、视图形状、方向与 sRGB；
- 压缩格式保留、按块填充的拷贝范围以及预设 mip 上传；
- 不支持的压缩特性与非对齐压缩特性门控；
- 设备维度/层数/mip 限制以及精确的压缩/未压缩负载大小；
- 格式错误的层索引、维度、格式、mip 计数和层数；
- 独立缓冲区规范化、确定性层序以及 fetch 错误；
- 对无类型检查调用方的零源运行时拒绝；
- 同步上传/视图/采样器失败、异步校验/内存不足错误以及作用域结算期间设备丢失/替换时的清理；
- 仅在所有错误作用域成功后才获取所有权。

`tests/lite/unit/texture-array.test.ts` 必须覆盖图像与像素的创建/上传、层边界、维度相等性、位图关闭、mip 生成以及 URL 失败处理。

`tests/lite/unit/engine-device-features.test.ts` 必须证明仅在适配器提供时才请求 `texture-compression-unaligned`。`tests/lite/unit/device-lost-recovery.test.ts` 必须证明已启用的特性会被捕获用于替换设备协商。公共 API/报告测试必须暴露四个原生 KTX2 入口点，并在独立源输入上具有非空元组类型。

## 文件清单

| 文件 | 职责 |
|---|---|
| `packages/babylon-lite/src/texture/texture-array.ts` | 公共数组门面、图像/像素上传、原生打包/独立 KTX2 校验与事务性上传 |
| `packages/babylon-lite/src/texture/ktx2-texture-array.ts` | 兼容的 RGBA8/基础层 KTX2 数组 API |
| `packages/babylon-lite/src/texture/ktx2-loader.ts` | 共享解码器配置与格式选择 |
| `packages/babylon-lite/src/texture/compressed-formats.ts` | 压缩格式元数据 |
| `packages/babylon-lite/src/index.ts` | 公共包导出 |
| `packages/babylon-lite/src/engine/engine.ts` | 初始可选特性协商 |
| `packages/babylon-lite/src/engine/device-lost-recovery.ts` | 已启用特性捕获 |
| `packages/babylon-lite/src/engine/device-lost-recovery-run.ts` | 替换适配器/设备特性强制 |
| `tests/lite/unit/texture-array.test.ts` | 图像与原始像素数组行为 |
| `tests/lite/unit/ktx2-texture-array.test.ts` | 原生 KTX2 数组行为与失败所有权 |
| `tests/lite/unit/engine-device-features.test.ts` | 初始可选特性选择 |
| `tests/lite/unit/device-lost-recovery.test.ts` | 恢复特性保留 |
| `tests/lite/build/public-api-types.test.ts` | 发布的声明形状与非空源不变量 |
| `docs/lite/architecture/54-texture-array.md` | 可重新生成的模块契约 |
