# 模块：Texture2D + KTX/KTX2 加载器

> 包路径：
>
> - `packages/babylon-lite/src/texture/texture-2d.ts` — 基于图像的纹理加载
> - `packages/babylon-lite/src/texture/external-image-texture.ts` — 从已解码的外部图像创建独立所有权的纹理
> - `packages/babylon-lite/src/texture/ktx-loader.ts` — KTX1 压缩纹理加载
> - `packages/babylon-lite/src/texture/ktx2-loader.ts` — 用于 glTF `KHR_texture_basisu` 的 KTX2/BasisU 上传
> - `packages/babylon-lite/src/texture/compressed-formats.ts` — GL→WebGPU 格式映射
> - `packages/babylon-lite/src/texture/mip-count.ts` — 用于透射折射的带偏移 mip 计数辅助函数

## 用途

从四种来源将纹理加载到 WebGPU 中：

1. **图像纹理**（`loadTexture2D`）— 通过 `ImageBitmap` 从 URL 加载 PNG/JPG → 转为带可选 mipmap 生成的 `rgba8unorm` GPU 纹理。
2. **已解码外部图像**（`createTexture2DFromExternalImage`）— 将 `ImageBitmap`、`ImageData`、canvas、image、video 或 `VideoFrame` 上传到一个全新的、具有独立所有权的纹理中，支持可选的保持纵横比降采样。
3. **KTX1 压缩纹理**（`loadKtxTexture2D`）— 从 KTX1 文件加载 GPU 压缩纹理（ASTC、BC/DXT、ETC2），具备自动格式选择与 PNG 回退。支持完全 Tree-Shaking：未使用时打包体积为零字节。
4. **KTX2/BasisU glTF 纹理源**（`uploadKtx2Texture2D`）— 由 glTF `KHR_texture_basisu` 扩展使用的内部动态路径。它懒加载 Babylon 的 KTX2 解码器，解码并上传完整的 mip 链，且在所有未声明 `KHR_texture_basisu` 的场景中均不会被引入。

两者均返回相同的 `Texture2D` 接口——调用方无需区分获取到的是压缩纹理还是未压缩纹理。

---

## 公共 API 表面

### 接口

```typescript
export interface Texture2D {
    texture: GPUTexture;
    view: GPUTextureView;
    sampler: GPUSampler;
    width: number;
    height: number;
}

export interface Texture2DOptions {
    /** Generate mipmaps. Default true. */
    mipMaps?: boolean;
    /** Address mode U. Default 'repeat'. */
    addressModeU?: GPUAddressMode;
    /** Address mode V. Default 'repeat'. */
    addressModeV?: GPUAddressMode;
    /** Min filter. Default 'linear'. */
    minFilter?: GPUFilterMode;
    /** Mag filter. Default 'linear'. */
    magFilter?: GPUFilterMode;
    /** Flip Y axis during upload. Default true (matches Babylon.js convention). */
    invertY?: boolean;
    /** Use sRGB format (rgba8unorm-srgb). Enables hardware sRGB→linear on sample.
     *  Use for color/albedo textures in PBR workflows. Default false. */
    srgb?: boolean;
}

export interface ExternalImageTexture2DOptions extends Texture2DOptions {
    /**
     * Downscale images whose larger dimension exceeds this value. The larger
     * output dimension is exactly `maxDimension`; the other is rounded to the
     * nearest positive integer to preserve aspect ratio. Smaller images are
     * never enlarged. Must be a positive integer when provided.
     */
    maxDimension?: number;
}
```

### 函数

```typescript
export async function loadTexture2D(engine: Engine, url: string, opts?: Texture2DOptions): Promise<Texture2D>;

/**
 * Create a fresh Texture2D from an already-decoded WebGPU external-image
 * source. Every invocation allocates a distinct GPUTexture; there is no URL or
 * source-identity cache. The caller retains ownership of `source`, and the
 * function never closes or mutates it.
 *
 * The returned texture owns one resource-pool reference. The caller must call
 * `releaseTexture(texture)` after all material bindings have released it.
 * Decode/resample, source validation, allocation, upload, and mip-generation
 * failures reject the promise; no fallback texture is returned.
 */
export async function createTexture2DFromExternalImage(engine: EngineContext, source: GPUCopyExternalImageSource, options?: ExternalImageTexture2DOptions): Promise<Texture2D>;

/**
 * Load a texture with KTX compressed format auto-selection and fallback.
 * Tries each suffix in priority order, picks the first whose compressed format
 * the GPU supports, fetches and parses the KTX1 file, and uploads compressed
 * mip data. Falls back to loadTexture2D(engine, baseUrl) if none work.
 *
 * Fully tree-shakable: only bundled when explicitly imported.
 */
export async function loadKtxTexture2D(engine: Engine, baseUrl: string, suffixes: string[], opts?: Texture2DOptions): Promise<Texture2D>;

/**
 * Internal glTF KHR_texture_basisu upload path.
 * Not exported from the public barrel; imported only by gltf-ext-basisu.ts.
 */
export async function uploadKtx2Texture2D(engine: EngineContextInternal, buffer: ArrayBuffer, sRGB: boolean): Promise<Texture2D>;

/**
 * Internal KTX2 mip0 decode for ORM composition fallback.
 */
export async function decodeKtx2ImageBitmapFromBuffer(buffer: ArrayBuffer): Promise<ImageBitmap>;
```

### 导入依赖

从引擎模块导入 `Engine`（用于在内部访问 `GPUDevice`），并从资源池导入 `acquireTexture`/`getOrCreateSampler`。

---

## 内部架构

### 默认选项值

| 选项 | 默认值 | 类型 |
| -------------- | ---------- | ---------------- |
| `mipMaps` | `true` | `boolean` |
| `addressModeU` | `'repeat'` | `GPUAddressMode` |
| `addressModeV` | `'repeat'` | `GPUAddressMode` |
| `minFilter` | `'linear'` | `GPUFilterMode` |
| `magFilter` | `'linear'` | `GPUFilterMode` |
| `invertY` | `true` | `boolean` |
| `srgb` | `false` | `boolean` |

### 纹理创建参数

```typescript
device.createTexture({
    size: { width, height }, // from ImageBitmap dimensions
    format: srgb ? "rgba8unorm-srgb" : "rgba8unorm",
    mipLevelCount: mipMaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
});
```

**Mip 级别公式：** `Math.floor(Math.log2(Math.max(width, height))) + 1`

示例：512×256 图像 → `Math.floor(log2(512)) + 1 = 9 + 1 = 10` 个 mip 级别。

### 图像上传

```typescript
device.queue.copyExternalImageToTexture({ source: imageBitmap, flipY: invertY }, { texture }, { width, height });
```

### 已解码外部图像上传

`createTexture2DFromExternalImage` 无需 DOM 构造函数即可读取固有尺寸：

1. 对于 `VideoFrame` 使用 `displayWidth` / `displayHeight`
2. 对于视频元素使用 `videoWidth` / `videoHeight`
3. 对于图像元素使用 `naturalWidth` / `naturalHeight`
4. 对于 `ImageBitmap`、`ImageData` 和 canvas 源使用 `width` / `height`

最先匹配到的完整正整数尺寸对生效。如果源没有任何受支持的尺寸对，则在任何 GPU 分配之前抛出 `TypeError`。

当 `maxDimension` 小于源的较大边尺寸时，辅助函数会创建一个临时的已调整尺寸的 `ImageBitmap`：

```typescript
const scale = maxDimension / Math.max(sourceWidth, sourceHeight);
const width = sourceWidth >= sourceHeight ? maxDimension : Math.max(1, Math.round(sourceWidth * scale));
const height = sourceHeight >= sourceWidth ? maxDimension : Math.max(1, Math.round(sourceHeight * scale));
const resized = await createImageBitmap(source, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
    premultiplyAlpha: premultiplyAlpha ? "premultiply" : "none",
    colorSpaceConversion: "none",
});
```

上传或失败后，临时位图始终会被关闭（close）。原始源永远不会被关闭。若不进行降采样，则直接复制原始源，避免中间分配，除非启用了可选的设备丢失恢复（device-lost recovery）。恢复机制会保留一个由工厂拥有的 `ImageBitmap` 副本，使调用方仍可立即关闭其源。该不可变副本在上传前创建，并同时用于初始上传与后续恢复，因此可变的 canvas 和 video 不会重放后续帧。当纹理的最后一个所有权引用被释放时，该副本将被关闭。由于 `ImageBitmap`、`ImageData`、`OffscreenCanvas`、`VideoFrame` 和 `createImageBitmap` 均不依赖 document DOM，因此该流程在 Worker 中同样适用。

纹理工厂本身不包含特定于恢复的分支、元数据编码或所有权规则，它仅在上传后执行一次不透明的可选捕获调用。恢复启用器安装该接缝，并通过其自身的不透明资源池钩子负责复制、元数据捕获、跟踪、重建与释放。未启用恢复的使用方不会保留任何相关实现。

目标纹理和采样器与 `loadTexture2D` 保持一致：RGBA8 线性或 sRGB 格式、可选完整 mip 链、由调用方选择的过滤/寻址模式、显式 `invertY`（默认 `true`），以及显式预乘 alpha 处理。mipmap 模块会在开启嵌套的 WebGPU `validation` 和 `out-of-memory` 错误作用域之前解析。随后的分配、上传、mip 生成和采样器创建均在这些作用域内同步执行，防止并发调用交错影响设备全局作用域栈。同步平台异常会原样拒绝（reject）；作用域内的 GPU 错误会以该 GPU 错误作为 `cause` 进行拒绝。在任一失败路径上都会销毁目标纹理，且不会返回回退纹理。

#### 最简用法

```typescript
import { createTexture2DFromExternalImage, releaseTexture } from "@babylonjs/lite";

const bitmap = await createImageBitmap(blob);
const texture = await createTexture2DFromExternalImage(engine, bitmap, {
    maxDimension: 2048,
    invertY: true,
    srgb: true,
});
bitmap.close(); // source remains caller-owned

material.diffuseTexture = texture;
// After removing it from every material:
releaseTexture(texture);
```

#### 从自定义图像加载器迁移

```typescript
// Before: application code decoded, resized, and uploaded a private texture.
const image = await decodeApplicationImage(imageUrl);
const texture = await createTexture2DFromExternalImage(engine, image, {
    maxDimension: maxTextureSize,
    invertY: true,
    srgb: true,
});

// Keep one Texture2D per independently-owned image. Do not replace this with
// loadTexture2D(imageUrl), whose URL cache intentionally shares.
material.diffuseTexture = texture;

// During teardown, after material references are removed:
releaseTexture(texture);
image.close();
```

### 采样器配置

```typescript
device.createSampler({
    addressModeU, // default: 'repeat'
    addressModeV, // default: 'repeat'
    minFilter: opts.minFilter ?? "linear",
    magFilter: opts.magFilter ?? "linear",
    mipmapFilter: mipMaps ? "linear" : "nearest",
    maxAnisotropy: 4,
});
```

### 内部 Mipmap 生成器

```typescript
async function generateMipmaps(device: GPUDevice, texture: GPUTexture, _width: number, _height: number, mipLevelCount: number): Promise<void>;
```

**算法：**

1. 创建一个包含以下内容的内联 WGSL 着色器模块：
    - **顶点着色器：** 通过 3 个硬编码顶点生成全屏三角形
    - **片元着色器：** 采样源 mip 级别并返回颜色
2. 创建一个用于降采样的线性采样器
3. 创建一个渲染管线
4. 对于从 1 到 `mipLevelCount - 1` 的每个 mip 级别：
   a. 创建上一级别（源）的纹理视图
   b. 创建当前级别（目标）的纹理视图
   c. 创建绑定源视图 + 采样器的绑定组
   d. 开始以目标视图为渲染目标的渲染通道
   e. 绘制 3 个顶点（全屏三角形）
5. 提交命令缓冲区

**内联 mipmap 着色器（嵌入函数体内）：**

```wgsl
// Vertex: fullscreen triangle
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0)
  );
  return vec4(pos[i], 0.0, 1.0);
}

// Fragment: sample previous mip level
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  return textureSample(src, samp, pos.xy / vec2<f32>(textureDimensions(src)));
}
```

---

## 管线配置

此模块不创建主渲染管线，仅创建用于生成 mipmap 的临时管线：

**Mipmap 生成管线：**

- 顶点：无顶点缓冲区（由 `vertex_index` 生成全屏三角形）
- 片元：采样源纹理，写入目标 mip 级别
- 颜色目标：`rgba8unorm`（与纹理格式相同）
- 无深度/模板缓冲
- 图元拓扑：`triangle-list`

---

## 着色器逻辑

无独立着色器文件。mipmap 生成着色器以内联方式嵌入（参见上方“内部架构”）。

**Mipmap 降采样公式：**
每个 mip 级别都通过渲染全屏三角形并借助线性采样器采样上一级别来生成，利用硬件双线性过滤产生 2× 降采样结果。

---

## 状态机 / 生命周期

```
loadTexture2D(engine, url, opts)
  │
  ├─ 1. Parse options (apply defaults)
  ├─ 2. Fetch image: fetch(url) → blob → createImageBitmap
  ├─ 3. Calculate mip level count from image dimensions
  ├─ 4. Create GPUTexture (rgba8unorm, with mip levels)
  ├─ 5. Upload image data: copyExternalImageToTexture (with flipY)
  ├─ 6. If mipMaps: await generateMipmaps(device, texture, w, h, levels)
  │     ├─ Create shader module (inline WGSL)
  │     ├─ Create sampler (linear)
  │     ├─ Create render pipeline
  │     ├─ For each level 1..N-1:
  │     │   ├─ Create source view (level-1)
  │     │   ├─ Create dest view (level)
  │     │   ├─ Create bind group
  │     │   ├─ Render pass: draw fullscreen triangle
  │     │   └─ End pass
  │     └─ Submit command buffer
  ├─ 7. Create GPUSampler (with anisotropy, mipmap filter)
  └─ 8. Return { texture, view: texture.createView(), sampler, width, height }
```

```
createTexture2DFromExternalImage(engine, source, opts)
  │
  ├─ 1. Validate source dimensions and maxDimension
  ├─ 2. If required, resize to a temporary ImageBitmap (aspect ratio preserved)
  ├─ 3. Create a new GPUTexture (never cached)
  ├─ 4. Upload with explicit flipY / premultipliedAlpha
  ├─ 5. Generate mipmaps when enabled
  ├─ 6. Create/reuse the configured sampler
  ├─ 7. If recovery is active, retain a factory-owned decoded image and settings
  ├─ 8. Acquire one caller-owned resource-pool reference
  ├─ 9. Close any non-retained temporary resized bitmap
  └─ 10. Return a normal Texture2D
```

**所有权：** `createTexture2DFromExternalImage` 会获取一个由调用方拥有的引用。材质绑定会自行获取和释放各自的引用。在纹理从所有材质中分离后，工厂的调用方必须调用 `releaseTexture(texture)`。工厂永远不会拥有或关闭传入的源。如果启用了设备丢失恢复，工厂会拥有一份单独保留的位图，并在最后一个纹理引用释放时将其关闭。

---

## Babylon.js 等价映射表

| Babylon Lite | Babylon.js |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `loadTexture2D(engine, url, opts)` | `new Texture(url, scene, ...options)` |
| `createTexture2DFromExternalImage(engine, source, opts)` | `new Texture(null, scene)` + 私有外部图像上传 |
| `Texture2D` 接口 | `Texture` 类（内部 GPU 纹理 + 采样器） |
| `Texture2DOptions.mipMaps` | `Texture.noMipmap`（取反：`mipMaps = !noMipmap`） |
| `Texture2DOptions.addressModeU` | `Texture.wrapU`（枚举值不同） |
| `Texture2DOptions.addressModeV` | `Texture.wrapV` |
| `Texture2DOptions.invertY` | `Texture.invertY`（两者默认均为 true） |
| `maxAnisotropy: 4` | `Texture.anisotropicFilteringLevel`（默认 4） |
| `format: 'rgba8unorm'` | 已加载图像的标准 RGBA 格式 |
| `generateMipmaps()`（基于渲染通道） | `Engine.generateMipmaps()`（可能使用计算着色器或渲染通道） |
| `releaseTexture(texture)` | 用于显式清理的 `Texture.dispose()` |

---

## 依赖项

- `texture/compressed-formats.ts` — GL 内部格式 → WebGPU 格式映射表（仅由 ktx-loader 导入）
- `resource/gpu-pool.ts` — `acquireTexture`、`getOrCreateSampler`
- WebGPU API 类型（`GPUDevice`、`GPUTexture`、`GPUSampler` 等）
- 平台 API：`fetch`、`createImageBitmap`；已解码图像的创建与缩放保持对 Worker 兼容，不依赖 `document`

---

## KTX1 压缩纹理加载

### 支持的格式

| 格式族 | GL 十六进制范围 | WebGPU 格式 | 设备特性 |
| --------------- | ------------- | ----------------- | -------------------------- |
| BC / S3TC / DXT | 0x83F0–0x8E8D | bc1..bc7 | `texture-compression-bc` |
| ETC2 / EAC | 0x9270–0x9279 | etc2/eac | `texture-compression-etc2` |
| ASTC 4×4–12×12 | 0x93B0–0x93DD | astc-NxM | `texture-compression-astc` |
| PVRTC | — | _（WebGPU 不支持）_ | — |

### KTX1 二进制格式（64 字节头）

```
Offset  Size  Field
 0      12    Magic: «KTX 11»\r\n\x1A\n
12       4    endianness (0x04030201 = little-endian)
16       4    glType (0 = compressed)
24       4    glFormat (0 = compressed)
28       4    glInternalFormat → lookup in compressed-formats.ts
36       4    pixelWidth
40       4    pixelHeight
56       4    numberOfMipmapLevels
60       4    bytesOfKeyValueData
```

在文件头与键/值元数据之后，mip 级别按从大到小的顺序存储：

- `uint32 imageSize` + `imageData[imageSize]` + 填充至 4 字节对齐

### `loadKtxTexture2D` 流程

```
loadKtxTexture2D(engine, "grid.png", ["-astc.ktx", "-dxt.ktx", "-etc2.ktx"])
  ├─ For each suffix: check device.features.has(requiredFeature)
  ├─ For each supported suffix (try all, not just first):
  │   ├─ Rewrite URL: "grid.png" → "grid-dxt.ktx"
  │   ├─ fetch → ArrayBuffer → parseKtx1 → uploadCompressed
  │   └─ On success: return Texture2D
  │   └─ On failure: warn, try next suffix
  └─ Fallback: loadTexture2D(engine, "grid.png")
```

### Tree-Shaking

`loadKtxTexture2D` 位于 `ktx-loader.ts` 中，静态导入了 `compressed-formats.ts`。
如果场景从未导入 `loadKtxTexture2D`，这两个模块会被完全 Tree-Shaking 剔除至 0 字节。
`loadTexture2D` 未被修改——对非 KTX 场景零侵入。

---

## KTX2 / `KHR_texture_basisu` 加载

目前有意**不将** KTX2 支持作为公开的直接纹理 API，而是限定在声明了 `KHR_texture_basisu` 的 glTF 资产中，从而避免解码器胶水代码和纹理上传路径进入任何非 KTX2 场景。

### 运行时流程

```
loadGltf(engine, url)
  ├─ sees extensionsUsed includes KHR_texture_basisu
  ├─ dynamic import("./gltf-ext-basisu.js")
  ├─ gltf-ext-basisu strips KTX2 textureInfos from core material parsing
  ├─ fetch image.uri or bufferView bytes for the referenced KTX2 image
  ├─ dynamic decoder script: https://cdn.babylonjs.com/v9.32.1/babylon.ktx2Decoder.js
  ├─ decoder.decode(..., { forceRGBA: true }) returns mip levels
  └─ uploadKtx2Texture2D() creates Texture2D with full mip chain
```

懒加载的默认解码器固定到一个经过验证的 CDN 发布版本，以便其内嵌的转码器 URL 能解析到同一套已发布的 JS/WASM 资产。动态指向最新版的未固定版本脚本可能会引用尚未可用的资产。`setKtx2DecoderUrl()` 仍然可以同时为主线程和 Worker 解码覆盖脚本和可选的转码器 URL。

### 上传规则

- 颜色纹理使用 `rgba8unorm-srgb`；法线/ORM 纹理使用线性格式。
- 为与 Babylon.js 的 FlightHelmetKTX 保持视觉一致性，解码器路径目前强制输出 RGBA。
- 上传的纹理保留解码器提供的 mip 链；无需额外调用 `generateMipmaps()`。
- 采样器使用 repeat 寻址、线性 min/mag 过滤、在存在 mip 时使用线性 mip 过滤，并为有 mipmap 的纹理设置各向异性过滤级别为 4。
- 仅当扩展需要合成拆分的金属度-粗糙度 + 环境光遮蔽（ORM）纹理时，`decodeKtx2ImageBitmapFromBuffer()` 才将 mip0 解码为 `ImageBitmap`。

### 可选的 Worker 解码

```typescript
export interface Ktx2WorkerDecodingOptions {
    workerCount?: number; // default: hardwareConcurrency - 1, clamped to [1, 4]
}
export function enableKtx2WorkerDecoding(options?: Ktx2WorkerDecodingOptions): void;
```

默认情况下解码器脚本在主线程运行，因此每次 KTX2 转码都会在完整耗时内阻塞页面。
`enableKtx2WorkerDecoding()`（`src/texture/ktx2-worker-decoder.ts`）通过 `ktx2-loader.ts` 的内部 `_setKtx2DecoderSource` 接缝安装一个由专用 Worker 池支持的解码器：

- 每个 Worker 从包含 `_ktx2WorkerMain` 的 Blob URL 启动。它接收 `{ t: 0, url, wasmUrls }`，调用 `importScripts(url)`，设置 `MSCTranscoder.UseFromWorkerThread` 和 `WASMMemoryManager.LoadBinariesFromCurrentThread`，应用 `setKtx2DecoderUrl` 的转码器覆盖配置并回复 `{ t: 0 }`（或 `{ t: 0, e }`）。由于嵌套的 Blob Worker 没有可用的基准 URL，URL 会在页面中根据 `document.baseURI` 解析，或在调用方的 Worker 中根据 `globalThis.location.href` 解析。
- `decode(data, caps, options)` 将 `data` 的一份**副本**（通过转移所有权）作为 `{ t: 1, id, data, caps, options }` 发送给最空闲的 Worker；调用方的字节数组永远不会被分离（detach）。Worker 回复 `{ t: 1, id, d }` 并将每个 mip 缓冲区转移回来；如果某个 mip 是更大缓冲区或已转移缓冲区的视图，则会先复制一份。
- 在确认初始化前出错的 Worker 会被终止并排除，其余存活的 Worker 继续工作。在启动后崩溃的 Worker 会拒绝其正在进行的任务并退出池。如果 `Worker` 不可用，或没有任何 Worker 能完成解码器初始化，该模式会自动卸载自身（输出一次 `console.warn`），并由 `loadKtx2Decoder` 返回主线程解码器。

上传、输出格式和所有公共加载器均保持不变；仅 `decode` 运行的位置有所不同。

### Tree-Shaking

`ktx2-loader.ts` 仅由 `loader-gltf/gltf-ext-basisu.ts` 导入，而后者仅在资产声明了 `KHR_texture_basisu` 时动态导入。这使得 KTX2 解码器代码、CDN 脚本配置以及 ORM 合成逻辑不会出现在现有的 KTX1、Basis `.basis` 及普通图像场景中。

---

## 测试规范

1. **Mip 级别数** — 1024×1024：11 级。512×256：10 级。1×1：1 级。
2. **默认选项** — 验证当 `opts = {}` 时应用所有默认值。
3. **无 mipmap 模式** — 当 `mipMaps: false` 时：mipLevelCount = 1，mipmapFilter = `'nearest'`。
4. **采样器配置** — 验证 `maxAnisotropy = 4`，寻址模式与选项一致。
5. **InvertY** — 默认为 true；图像在上传期间应垂直翻转。
6. **纹理格式** — 始终为 `rgba8unorm`。
7. **纹理用途标志** — 必须包含 `TEXTURE_BINDING`、`COPY_DST` 和 `RENDER_ATTACHMENT`。
8. **返回值结构** — 必须包含 `texture`、`view`、`sampler`、`width`、`height`。
9. **KTX2 glTF 路径** — 场景 112 通过 `KHR_texture_basisu` 加载 FlightHelmetKTX，体积保持在打包上限以下，且不增加现有场景的运行时 JS 加载量。
   9b. **KTX2 Worker 解码**（`tests/lite/unit/ktx2-worker-decoder.test.ts`）— 真实 Worker 源码在带有消息传输语义的 VM 域中运行：从页面或 HTTP(S) 调用方 Worker 解析解码器/转码器 URL（同时保留绝对 URL）、调用方字节保持完好、共享/子视图 mip 完整返回、最空闲调度、初始化前错误仅终止并排除失败 Worker、解码错误与启动后崩溃被拒绝，以及当无 Worker 初始化成功或缺少 `Worker` 时使用主线程解码器。
10. **独立已解码图像** — 使用同一源调用两次会创建不同的 GPU 纹理，且各自持有独立的引用计数所有权。
11. **外部图像尺寸识别** — 识别 bitmap/data/canvas、image、video 和 VideoFrame 尺寸属性；在分配前拒绝不受支持或零尺寸的源。
12. **保持纵横比降采样** — 仅当较大边超过 `maxDimension` 时截断缩放，保持方向/纵横比，且绝不放大。
13. **外部图像所有权** — 无论成功还是失败均关闭临时的已缩放位图；绝不关闭调用方的源。
14. **外部图像失败处理** — 传播缩放/解码及上传失败并销毁部分创建的 GPU 纹理；绝不返回回退纹理。
15. **外部图像 Tree-Shaking** — 导入其他根 API 的使用方不会保留任何 `createTexture2DFromExternalImage` 实现代码。
16. **并发外部图像上传** — 并发的 mipmap 调用将验证错误与内存不足错误准确关联到各自的调用方。
17. **外部图像恢复** — 可选的设备丢失恢复为初始上传与重放使用同一份由工厂拥有的不可变图像，恢复上传与采样器设置，并随纹理一起释放保留的图像。
18. **恢复逻辑隔离** — 未启用设备丢失恢复的外部图像使用方不会保留任何捕获、恢复源编码或保留图像释放的实现。

---

## 文件清单

| 文件 | 职责 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/texture/texture-2d.ts` | 图像加载、GPU 纹理创建、mipmap 生成、采样器创建 |
| `src/texture/external-image-texture.ts` | 外部图像全新上传、源尺寸读取、可选保持纵横比降采样及显式调用方所有权 |
| `src/texture/ktx-loader.ts` | KTX1 解析器、压缩纹理上传、后缀选择、回退至 loadTexture2D |
| `src/texture/ktx2-loader.ts` | 内部 KTX2/BasisU 解码器桥接与 glTF `KHR_texture_basisu` 的 Texture2D 上传 |
| `src/texture/ktx2-worker-decoder.ts` | 可选 `enableKtx2WorkerDecoding`：在 Web Worker 池中运行 KTX2 解码器，支持主线程回退 |
| `src/texture/compressed-formats.ts` | GL `glInternalFormat` → `{ gpuFormat, feature, blockW, blockH, blockBytes }` 查找表（懒初始化） |
| `src/texture/solid-texture.ts` | 程序化 1×1 纯色纹理 |
| `src/texture/generate-mipmaps.ts` | 通过渲染通道进行 GPU mipmap 生成，包含编码器本地录制 |
| `src/texture/mip-count.ts` | 帧图透射所使用的共享带偏移 mip 计数辅助函数 |
