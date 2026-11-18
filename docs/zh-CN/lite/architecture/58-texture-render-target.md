# 模块：纹理渲染目标

> 包路径：`packages/babylon-lite/src/texture/texture-render-target.ts`

## 目的

借用现有渲染附件（render-attachment）纹理的某一个数组层和 mip 级别作为 `RenderTarget`。不分配新的纹理。颜色、仅深度、仅模板以及深度/模板组合格式会使用对应的附件槽位，而不是将所有纹理都当作颜色附件处理。

## 公共 API 接口

```typescript
export interface TextureRenderTargetOptions {
    readonly layer?: number;
    readonly mipLevel?: number;
}

export function createTextureRenderTarget(
    engine: EngineContext,
    texture: Texture2D,
    options?: TextureRenderTargetOptions
): RenderTarget;

export function disposeRenderTarget(target: RenderTarget | null | undefined): void;
```

两个子资源索引均默认为 0。该函数通过 `Texture2D` 基础接口接受 `Texture2DArray`。使用 `disposeRenderTarget(target)` 释放返回的目标；传入的纹理仍归调用方所有。这两个操作均从公共包根路径导出。

## 内部架构

在获取所有权之前，先校验渲染附件用途、`"2d"` 纹理维度，以及在纹理分配的层数和 mip 数范围内的整数层/mip 索引。

描述符会复制原纹理分配的标签和采样数。其尺寸为 `max(1, gpu.width >> mipLevel)` 和 `max(1, gpu.height >> mipLevel)`。以 `"depth"` 开头的格式以及 `"stencil8"` 会填充 `dFormat`；其他格式则填充 `format`。

创建一个维度为 `"2d"`、`baseArrayLayer = layer`、`arrayLayerCount = 1`、`baseMipLevel = mipLevel` 且 `mipLevelCount = 1` 的视图。颜色目标填充 `_colorTexture` 和 `_colorView`；深度/模板目标填充 `_depthTexture` 和 `_depthView`。未使用的那对附件保持为 null。

颜色包装器还会在目标上保留 `_colorSubresource = { layer, mipLevel }`。这些经过校验的标量索引独立于完整的 `_colorTexture` 分配来描述附件视图。`CopyToTextureTask` 会将其用于任一原始复制（raw-copy）端点：`mipLevel` 选择其 mip，`origin = { x: 0, y: 0, z: layer }` 选择其层。复制范围为所选 mip 的尺寸，而非整个分配的基础尺寸。`lodLevel` 相对于源采样视图而言：包装器仅暴露单个 mip，因此无论 `lodLevel` 为何值，采样都会钳制到相对于视图的 LOD 0；原始复制路径同样使用包装器所选的物理 mip 及其未位移的 `_width`/`_height`，绝不会将 `lodLevel` 累加到该物理 mip 上，也不会再次将其应用于尺寸。没有此元数据的普通源保留其原有的 `lodLevel` mip 选择；普通目标保留第 0 层和第 0 级 mip。Blit 和 resolve 路径原本就使用选定的附件视图，无需不同路径。

将目标标记为 eager。其 `_syncEager` 钩子会拒绝已释放的状态，比较当前活动的附件分配与 `texture.texture`，当外观（facade）上兼容的纹理分配被替换时，仅重建视图。因此，普通的 `buildRenderTarget` 调用绝不会分配另一个附件，也不会覆盖所选的层/mip。颜色子资源元数据也会随替换视图一起使用相同的捕获索引进行刷新。替换过程还会根据新分配在所选 mip 下的尺寸重新发布 `_width`、`_height` 和描述符 `size`，同样保持最小 1 像素。这同时适用于颜色包装器和深度/模板包装器。真实的表面尺寸渲染目标纹理（RTT）可能会在借用它的包装器同步之前就替换其外观分配；随后包装器会向附件兼容性检查暴露实时尺寸。`ClearTextureTask` 会在 pass 初始化阶段（在所有任务完成录制之后，且在校验或缓存附件之前）再次调用 eager 同步钩子。其录制阶段可能先于准备源 RTT 而准备了借用包装器；初始化阶段会刷新该较早准备的包装器，而不会分配另一个普通渲染目标。`RenderDrawTask` 同样注册了一个第 2 阶段初始化器，同时保留直接执行能力。该初始化器会同步任务当前的 eager 目标（包括在录制期间通过 setter 更改的目标），然后刷新其缓存的附件。普通目标保留其录制时的分配和缓存。此机制不会刷新已经被其他任务的绑定组（bind group）或复制命令捕获的视图；这些消费方必须在源分配更新后再自行准备其资源。

## 管线配置

目标的颜色或深度/模板格式及采样数决定了渲染管线签名。深度目标保留渲染目标所有者的反向 Z（reverse-Z）默认设置。仅模板目标没有深度 aspect；渲染通道和渲染管线必须省略仅限深度的状态。

## 着色器逻辑

本模块不拥有任何着色器。render-draw、effect 或 clear 任务自行提供行为。此包装器不生成 mipmap，也不改变纹理 UV 方向。

## 状态机 / 生命周期

1. 校验子资源并创建其附件视图。
2. 获取恰好一个逻辑纹理引用。
3. 重复借用同一目标；兼容的外观替换会刷新其视图。
4. 首次释放时，将包装器标记为已释放，并精确释放其获取的那一个引用。
5. 后续释放调用不执行任何操作；随后再构建则抛出异常。

包装器从不直接销毁纹理。共享纹理引用计数决定最后一个所有者何时释放底层分配。纹理本身、它的其他视图以及其他包装器仍保持各自独立的所有权。

## Babylon.js 等价映射

等价于在不创建第二个纹理的情况下选择现有渲染目标附件的数组层或 mip。Lite 暴露了一个普通目标和独立的生命周期函数，而非挂载在渲染目标上的方法。

## 依赖关系

`engine/render-target.ts` 拥有目标生命周期，`engine/gpu-flags.ts` 提供用途标志，`resource/texture-acquire.ts` / `texture-release.ts` 负责逻辑分配引用。`texture-2d.ts` 仅作为外观类型导入。不存在模块级缓存或注册表。

## 测试规范

`tests/lite/unit/texture-render-target.test.ts` 覆盖了精确的层/mip 视图描述符、尺寸、采样数、各类附件分类、eager 构建一致性、外观替换、非法用途/维度/索引以及幂等释放。两次释放包装器不得销毁仍被持有的源纹理；释放剩余的源所有者时必须恰好销毁底层分配一次。替换测试覆盖 mip 0 及非零选定 mip 下尺寸变化的情况，包括深度/模板附件。`tests/lite/unit/frame-graph-texture-tasks.test.ts` 中的真实 `createSurfaceRenderTargetTexture` 尺寸调整回归测试使用颜色包装器与原 RTT 的深度附件重建了一个 clear 任务，仅调用 `graph.build()` 而不在调整尺寸后手动构建源 RTT。实时尺寸和附件视图都必须成功刷新且不发生兼容性错误，并且源纹理的颜色与深度分配各只能替换一次。额外的颜色和深度包装器用例将源纹理的分配任务放在录制顺序的更后位置，以验证 pass 初始化和实际渲染通道附件都使用了替换后的分配。普通借用目标在初始化和尺寸未变的重建期间必须保留其分配。Render-draw 附件回归测试在两种生产者顺序下都使用了相同的真实表面 RTT 及颜色/采样深度包装器。仅在调整尺寸后执行同步 `graph.build()` 就必须刷新包装器和实际渲染通道视图，每个源附件仅分配一次，保留格式/采样签名及缓存管线，并在资源淘汰（retirement）及未改变尺寸的重建后依然保持正确。启用绘制时会使用 GPU mock 测试管线查找和绘制编码，不声明原生像素验证。禁用执行不得抑制初始化，且释放绘制任务必须保留其借用的目标存活。普通目标在第 2 阶段不得再次分配。

`tests/lite/unit/copy-to-texture-task.test.ts` 集成了数组工厂、包装器和复制任务。将一个 128x64 的 `rgba16float` 源复制到 256x128 数组的第 5 层、mip 1 中时，必须向该精确的层/mip 发出范围为 128x64 的编码器复制命令，且不发生绘制或管线创建。仅指定层、仅指定 mip、默认选择以及非零源 LOD 均保持相同的快速路径契约。重新录制保留目标，释放借用任务时保留包装器和数组的引用计数完好。源包装器用例覆盖仅指定层、仅指定 mip、组合指定及默认选择。原生复制测试夹具模拟具备 `COPY_SRC` 能力的分配；普通数组工厂不请求此用途，仍保留基于视图的 blit 回退路径。将该 256x128 数组的第 5 层、mip 1 复制到匹配的 128x64 目标时，必须选择物理源 mip 1 和 `origin.z = 5`，包括超出链范围和非零的 `lodLevel` 值（均钳制到包装器唯一暴露的 mip）。重新录制保留源视图和所有权。尺寸不同的目标使用 blit 路径，并绑定同一个选定源视图，而非采样整个数组。

`tests/lite/unit/render-shader.test.ts` 覆盖了 render-draw 任务使用这些目标时的深度/模板通道操作和仅模板管线状态。
`tests/lite/build/public-api-types.test.ts` 检查生成的根类型声明是否同时导出了包装器的创建与释放函数。

## 文件清单

- `texture/texture-render-target.ts`：子资源校验、视图附着、所有权钩子。
- `engine/render-target.ts`：现有的目标所有者与释放入口。
- `frame-graph/copy-to-texture-task.ts`：原始复制端点子资源与视图相对源 LOD。
- `tests/lite/unit/texture-render-target.test.ts`：包装器回归测试覆盖。
- `tests/lite/unit/copy-to-texture-task.test.ts`：复制源/目标集成测试覆盖。
