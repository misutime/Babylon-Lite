# 模块：纹理区域上传

> 包路径：`packages/babylon-lite/src/texture/texture-region.ts`

## 目的

将符合纹理分配自身可复制格式的 CPU 数据写入 mip / 数组层矩形区域。在将上传任务加入队列之前，校验目标块几何形状及完整源数据占用空间（包含最后一行）。直接复用描述符和调用方的源缓冲区，不分配新的视图。

## 公共 API 接口

```typescript
export interface TextureRegion {
    x?: number;
    y?: number;
    layer?: number;
    mipLevel?: number;
    width: number;
    height: number;
    layerCount?: number;
    bytesPerRow: number;
    rowsPerImage?: number;
    dataOffset?: number;
}

export function updateTextureRegion(
    engine: EngineContext,
    texture: Texture2D,
    data: ArrayBufferView,
    region: TextureRegion
): void;
```

原点坐标、mip 级别和数据偏移量均默认为 0；层数默认为 1。宽度和高度以目标纹素为单位，包含完整的压缩边缘块。`bytesPerRow` 为源数据的行字节步幅。`rowsPerImage` 表示**块行数**，默认值为 `height / blockH`。`dataOffset` 相对于传入的视图，而非其底层缓冲。只要满足数据占用空间要求，任意字节偏移和步幅均合法：`queue.writeTexture` 既不要求纹素字节对齐，也不要求 256 字节对齐。

目标纹理必须是单重采样的，且具有复制目标（copy-destination）用途。不执行 mip 生成、格式转换或 UV 翻转。调用方持有的 region 状态可被修改和复用。

## 内部架构

`compressed-formats.ts` 额外维护了一个内部 GPU 格式块信息查询表：

```typescript
export function getTextureFormatBlockInfo(
    format: GPUTextureFormat
): Pick<CompressedFormatInfo, "blockW" | "blockH" | "blockBytes"> | undefined;
```

其惰性初始化的字符串键映射复用了现有的压缩格式记录，包含每一种 ASTC 块形状。BC1/2/3 sRGB 键名复用对应的线性格式记录。未压缩格式记录的 `blockW = blockH = 1`，并按以下字节占用共享记录：

| 字节数 | 格式 |
| ------ | ---- |
| 1 | r8unorm, r8snorm, r8uint, r8sint, stencil8 |
| 2 | r16unorm, r16snorm, r16uint, r16sint, r16float, rg8unorm, rg8snorm, rg8uint, rg8sint, depth16unorm |
| 4 | r32uint, r32sint, r32float, rg16unorm, rg16snorm, rg16uint, rg16sint, rg16float, rgba8unorm, rgba8unorm-srgb, rgba8snorm, rgba8uint, rgba8sint, bgra8unorm, bgra8unorm-srgb, rgb9e5ufloat, rgb10a2uint, rgb10a2unorm, rg11b10ufloat |
| 8 | rg32uint, rg32sint, rg32float, rgba16unorm, rgba16snorm, rgba16uint, rgba16sint, rgba16float |
| 16 | rgba32uint, rgba32sint, rgba32float |

不允许对 depth32float 执行 CPU 写入；depth24plus 具有不透明的深度表示。组合格式需要显式指定单个 aspect，而本 API 不暴露该参数。这些格式均无查询记录，因此上传时会直接抛出异常，而不是猜测数据占用大小。仅含 depth16 或仅含模板（stencil-only）的上传必须覆盖所选每一层的完整物理 mip 宽高。允许只上传部分数组层：层属于独立的子资源，而非二维子资源的另一空间维度。

通过将逻辑尺寸向上舍入到 `blockW` / `blockH` 的倍数来计算物理 mip 宽高。数组层数不会随 mip 级别缩小，而 3D 纹理分配的深度则会随 mip 级别缩小。校验整数类型的 mip 级别、尺寸范围、原点、层范围、源偏移量，以及无符号 32 位整数的行/图像步幅。尺寸范围和 x/y 原点必须是块大小的整数倍。

令 `blockRows = height / blockH` 且 `lastRowBytes = width / blockW * blockBytes`。要求满足 `bytesPerRow >= lastRowBytes` 且 `rowsPerImage >= blockRows`。精确的所需源数据长度为：

```text
bytesPerRow * (rowsPerImage * (layerCount - 1) + blockRows - 1) + lastRowBytes
```

要求计算结果为安全整数，且满足 `dataOffset + requiredBytes <= data.byteLength`。最后一行之后不需要填充；超出视图末尾的数据永远无法通过校验。

三个模块局部的可空描述符会进行惰性初始化：目标 `{texture, mipLevel, origin:{x,y,z}}`、布局 `{offset, bytesPerRow, rowsPerImage}` 和范围 `{width,height,depthOrArrayLayers}`。每次调用仅重写它们的标量字段。将 `data.buffer` 连同 `offset = data.byteOffset + dataOffset` 一同传入；WebGPU 会同步对这些描述符拍照保存。元数据不包含任何 GPU 句柄，在设备替换后依然有效。

## 管线配置

无。队列上传操作会在后续提交的渲染工作之前执行。

## 着色器逻辑

无。CPU 字节已按目标格式编码；不进行 WGSL 检查或格式转换。

## 状态机 / 生命周期

1. 校验用途、采样数、复制格式、目标几何形状以及源数据占用空间。
2. 惰性获取或复用描述符。
3. 使用调用方的底层缓冲区将一次写入操作入队。

非法请求会在任何队列写入之前抛出异常。本模块不获取或释放纹理、不保留源数据，也不管理设备恢复。

## Babylon.js 等价映射

等价于带有显式源步幅以及选定层/mip 的原始纹理区域更新。Lite 直接暴露分配格式字节接口，而非仅限 RGBA8 的像素转换 API。

## 依赖关系

引擎和纹理外观（facade）仅为类型导入。`engine/gpu-flags.ts` 提供复制用途标志。`texture/compressed-formats.ts` 负责维护块元数据，避免重复定义压缩格式表。根入口导出 `TextureRegion` 和 `updateTextureRegion`，不导出内部的元数据查询函数。

## 测试规范

`tests/lite/unit/texture-render-target.test.ts` 覆盖了以下场景：最后一行恰好匹配与缺少 1 字节的边界、视图与底层缓冲区的边界、多层行填充、步幅过小、合法的奇数偏移/步幅、非有限/小数/越界数值、压缩块原点/范围、物理边缘 mip、块行数默认值、格式占用字节数、向选定数组层执行全宽/全高深度/模板复制、3D mip 深度边界、不支持的 aspect、复制用途/采样数，以及描述符引用身份保持不变。现有的 RGBA16 和 R32 上传契约同样保持覆盖。

## 文件清单

- `texture/texture-region.ts`：目标/布局校验与队列上传。
- `texture/compressed-formats.ts`：共享的惰性 GPU 格式块元数据。
- `tests/lite/unit/texture-render-target.test.ts`：上传回归测试用例。
