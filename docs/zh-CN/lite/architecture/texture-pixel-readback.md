# 模块：纹理像素回读（Texture pixel readback）

> 包路径：`packages/babylon-lite/src/texture/texture-pixel-readback.ts`

## 用途

面向预览与 PNG 导出的可选只读纹理检查功能。现有的工厂使用标志（factory usage flags）、应用渲染、资源引用及源纹理内容均保持不变。导入根包但不使用这些函数时，整个回读实现必须能被 tree-shaking 消除。

## 公共 API 接口

```ts
interface TextureReadbackInfo {
    kind: "2d" | "cube" | "2d-array" | "3d";
    width: number;
    height: number;
    depthOrArrayLayers: number;
    mipLevelCount: number;
}
interface TextureReadbackOptions {
    mipLevel?: number;
    face?: number;
    layer?: number;
    slice?: number;
    flipY?: boolean;
}
interface TextureReadbackResult {
    pixels: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
}
function getTextureReadbackInfo(texture: Texture2D | CubeTexture): TextureReadbackInfo;
function readTexturePixelsRGBA8(engine: EngineContext, texture: Texture2D | CubeTexture, options?: TextureReadbackOptions): Promise<TextureReadbackResult>;
```

`Texture2DArray` 和 `Texture3D` 已可赋值给 `Texture2D`。立方体纹理（cube）尺寸在内部查询，而不暴露其不透明的原生句柄。元数据描述的是底层分配的资源，而非可能已过时的包装器尺寸或包装器的受限视图。

各选择器默认值为 0。立方体贴图面采用 WebGPU 立方体顺序：+X, -X, +Y, -Y, +Z, -Z。仅接受与纹理类型相匹配的选择器，即使另一个选择器的值为 0 也不例外。Mip 级别与选择器必须为所选子资源范围内的有限非负整数。数组层数不会随 mip 级别缩小；3D 切片数则会缩小。第 `m` 级 mip 的尺寸为 `max(1, floor(baseSize / 2**m))`。

输出为紧凑排列的行主序 RGBA8 数据，GPU 存储第 0 行位于最前。`flipY` 会显式反转行序。不会对 `invertY`、UV 变换、立方体投影或材质状态做任何隐式解释。由调用方自行决定展示方向。

可采样的浮点、归一化及压缩颜色格式均会被转换为 RGBA8。数值裁剪至 [0,1] 并量化为 8 位。按照 WebGPU 纹理加载规则，缺失的 RGB 通道补 0，缺失的 alpha 通道补 1。对于 sRGB 输入，硬件解码与编码会保留源 RGB 传输编码；线性格式则保持线性。不执行色调映射（tone mapping）、曝光调整、线性输入的 gamma 转换或 alpha 反预乘（alpha unpremultiplication）。因此，HDR/线性图像可能需要由调用方另行执行显示变换。浮点源数据中的 NaN 和无穷大值不保证具有可移植的 RGBA8 转换结果。

深度/模板、整数、多重采样、不可采样以及非 2D/3D 的分配资源会显式拒绝。WebGPU 验证错误（包括已销毁的纹理以及属于其他设备的纹理）、分配错误、设备丢失及映射（map）失败均会拒绝，而不会返回看似成功的空白像素。仅凭元数据无法判定资源分配是否处于存活/可读状态。

## 内部架构

公共实现仅导入包装器与引擎类型，以及 GPU 标志别名和现有的内部 RGBA8 暂存拷贝（staging-copy）辅助函数（`read-texture-pixels.ts`）。无需修改工厂、注册表、缓存管线或模块级分配。

从 `Texture2D.texture` 或 `CubeTexture._texture` 解析原生纹理。根据立方体包装器、原生 `dimension` 以及数组包装器的 `layers` 属性确定类型（同时识别包含多个 2D 层的原生分配）。在分配资源前先执行校验。切勿使用应用的采样器或视图：为 2D/数组/立方体输入创建专用的单 mip、单层 2D 视图，为体积纹理（volume）创建单 mip 3D 视图。

## 管线配置

使用单个全屏三角形，无顶点缓冲区，默认不剔除，无深度/模板测试，无混合。显式的片段可见绑定采用 `unfilterable-float` 采样类型，可在不请求浮点过滤特性的情况下同时兼容可过滤和不可过滤的颜色格式。Bind group 0 仅包含源纹理视图。无需采样器或 uniform：所选的 3D 切片为经校验并直接嵌入着色器的整数。对于 sRGB 源纹理，输出附件格式为 `rgba8unorm-srgb`，否则为 `rgba8unorm`，使用 `RENDER_ATTACHMENT | COPY_SRC` 用途标志，其尺寸为所选 mip 的宽高。

## 着色器逻辑

通过顶点索引生成 (-1,-1)、(3,-1)、(-1,3) 顶点位置。片段坐标直接转换为整数像素坐标。使用 `textureLoad(source, xy, 0)` 或 `textureLoad(source, vec3(xy, slice), 0)` 精确读取单个纹素，不进行过滤、缩放，也不依赖原始采样器。相对于单 mip 视图，mip 级别为 0。直接返回加载的颜色，由输出附件完成裁剪、量化以及（如适用）sRGB 编码。

## 状态机 / 生命周期

每次调用独立拥有其输出附件、管线、视图、bind group 与暂存缓冲区。推入（push）验证与内存不足作用域，同步录制/提交转换命令，启动暂存拷贝/映射，并在任何 await 之前弹出（pop）两个作用域。这可防止并发读取互相捕获对方的错误作用域。同时等待作用域错误与 CPU 像素结果。只要存在作用域错误即拒绝。暂存辅助函数会在 `finally` 中取消映射/销毁其缓冲区；公共函数会在其自身的 `finally` 中销毁输出附件（包括失败情况）。不会对源纹理执行引用计数增减（retain/release）或销毁操作。已提交的应用渲染通道先于回读执行；此 API 不会刷新未提交的应用命令。当需要读取特定帧的内容时，请在该应用帧提交之后调用。

## Babylon.js 对等映射

提供 Inspector 纹理预览/导出中像素获取部分的功能，并支持显式的 face/layer/slice/mip 选择器。PNG 编码与画布/显示变换属于 UI 层职责，而非引擎 API。与通用的 BJS 纹理读取不同，本契约始终返回 RGBA8。

## 依赖项

仅类型依赖：`EngineContext`、`Texture2D`、`CubeTexture`。
运行时依赖：GPU 标志常量与现有的暂存拷贝辅助函数。仅限 WebGPU。

## 测试规范

单元测试覆盖所有类型的元数据、选择器校验、mip 尺寸、视图描述符、着色器/管线配置、sRGB 与线性附件格式对比、填充移除（padding removal）、显式行反转、不支持的格式/用途、作用域错误、映射失败、资源清理以及独立并发调用。构建测试针对发布的根声明文件编译使用方代码，证明未使用的回读代码可被消除。非可视化浏览器 GPU 测试验证精确字节、face/layer/slice/mip 选择以及源纹理保留。

## 文件清单

- `packages/babylon-lite/src/texture/texture-pixel-readback.ts`：公共 API 与转换实现。
- `packages/babylon-lite/src/texture/read-texture-pixels.ts`：现有的私有暂存拷贝实现。
- `packages/babylon-lite/src/index.ts`：根值/类型导出。
- `tests/lite/unit/texture-pixel-readback.test.ts`：作用域单元测试覆盖。
- `tests/lite/build/texture-pixel-readback.test.ts`：tree-shaking 与发布 API 覆盖。
- `tests/lite/build/public-api-types.test.ts`：发布的根 API 类型探测。
- `tests/lite/integration/texture-pixel-readback.spec.ts`：非可视化浏览器 GPU 检查，由 `config/playwright.integration-cloud.config.ts` 选中。
- 本文档：独立规范说明。
