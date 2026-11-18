# 模块：Sprite2D 实例参数（instance parameters）

> 包路径：`packages/babylon-lite/src/sprite/`
>
> 对 [Sprites](32-sprites.md) 的增量扩展。普通精灵图层保留其原有的布局、着色器、缓冲区、合批及上传行为。

## 用途

将每个精灵的四个由应用程序定义的 Float32 值传递到其自定义片段着色器，而无需重新解释颜色、UV 坐标或 NDC 深度。表现层高度偏移是一种可能的用途；引擎本身不解释这些值，也不会改变精灵几何体。

## 公共 API 接口

所有导出均来自单一的 `@babylonjs/lite` 根入口点：

```typescript
type Sprite2DInstanceParams = readonly [number, number, number, number] | Float32Array;

function enableSprite2DInstanceParams(layer: Sprite2DLayer): void;
function setSprite2DInstanceParamsIndex(layer: Sprite2DLayer, index: number, params: Sprite2DInstanceParams): void;
function setSprite2DInstanceParams(handle: Sprite2DHandle, params: Sprite2DInstanceParams): void;
```

在初始化设置期间、创建带有 `customShader` 的图层之后、且在其片段首次使用 `in.instanceParams` 渲染之前显式启用。对于由深度托管（depth-hosted）的图层，请在 `addDepthHostedSpriteLayerToScene` 之前启用；注册后再更改其布局不受支持，因为它们的绘制绑定会缓存管线。只有纯 2D `SpriteRenderer` 支持在渲染若干帧之后再启用。对非自定义图层或已带有其他顶点扩展的图层启用会抛出异常。针对本扩展重复调用是幂等的。已有及新增实例均接收 `[0, 0, 0, 0]`。

setter 要求图层已启用、传入存活的整数索引（或存活的稳定句柄）、恰好包含四个分量，且转为 Float32 后均为有限值。无效参数会在修改实例数据或脏状态之前抛出异常。setter 会将各分量拷贝到自有存储中；之后调用方的修改在再次调用 setter 前不会生效。使用可复用的元组或四元素 Float32Array 可避免调用方分配。setter 本身不创建任何数组、视图、对象或闭包。

常规的 `updateSprite2DIndex`、句柄更新以及帧/可见性编辑会保留这些参数。当参数变化时请单独使用参数 setter。`Sprite2DProps` 与现有的图层级 `fx.params` 语义均保持不变。

## 内部架构

可 tree-shake 的 `sprite-2d-instance-params.ts` 启用器拥有全部参数语义、校验、属性构建及 WGSL 扩展文本。

普通图层上不存在可选内部字段 `layer._vertexExtension`。该字段包含所有者标识、独立的管线与着色器键、一个预计算的 `GPUVertexAttribute`、顶点输入/输出/赋值文本以及一个实例初始化回调。本模块使用其启用器函数作为所有者标识：启用与 setter 会在修改数据、布局或脏状态之前拒绝由其他扩展拥有的描述符。核心代码仅消费这些数据或在插入时调用可选回调。公共声明裁剪会移除内部描述符及所有 GPU 类型。

可选的共享 `sprite-2d-instance-layout.ts` 辅助模块向实例记录追加浮点数。它仅由 UV 滚动与参数启用器导入，不被核心模块导入。它分配一个与容量等大的暂存数组，按新步幅（stride）拷贝现有的完整记录，更新内部的浮点/字节步幅，并将所有存活记录标脏。它返回原步幅作为追加偏移量。

参数向每条记录追加四个浮点数（16 字节）。属性 location 8 预留给该 vec4。深度 Z 保持在 float 13 / location 6；UV 滚动保持在 location 7，并使用其预计算的属性偏移量而非假定固定尾部位置。两个启用器可以任意顺序启用，且会保留彼此的现有数值。

| 布局 | 浮点数个数 | 字节数 |
| ------------------------------------ | -----: | ----: |
| 纯 2D，普通 | 13 | 52 |
| 深度托管，普通 | 14 | 56 |
| 纯 2D，带参数 | 17 | 68 |
| 深度托管，带参数 | 18 | 72 |
| 纯 2D，带参数 + UV 滚动 | 19 | 76 |
| 深度托管，带参数 + UV 滚动 | 20 | 80 |

初始化回调会将新精灵的四个槽位清零，包括交换删除（swap-remove）或清空/重填后复用的尾部槽位。容量扩容会拷贝完整记录。交换删除会拷贝整个末尾记录，从而保留参数归属。稳定句柄在调用索引 setter 之前先解析当前索引。

## 管线配置

保留现有的实例顶点缓冲区、索引四边形绘制及绑定组。不新增绘制调用、缓冲区绑定、纹理或 UBO。精灵 FX 钩子向现有管线构建器提供可选的预计算属性；普通管线没有额外属性。

自定义管线键整合了不透明的扩展键，其中包含属性偏移量。逐设备着色器模块键使用扩展的着色器标识，而非缓冲区偏移量：两种 UV 启用顺序生成相同的 WGSL，因而共享同一个着色器模块，同时保留各自独立的管线。深度、UV 滚动与扩展着色器排列保持区分。图层级着色器描述符可共享而不会修改描述符本身。

两条路径均按所需字节大小扩展 GPU 缓冲区，并在重新分配后上传完整记录。纯 2D `SpriteRenderer` 每帧解析管线，因此延迟启用会替换缓冲区与管线并重新录制其渲染 bundle。深度托管绑定仅在帧图重建时解析管线；请在将图层添加到场景前的初始化设置阶段同时启用所需的布局扩展。不添加任何特定于渲染器的参数分支或新的深度托管失效逻辑。

## 着色器逻辑

共享序言（prologue）接收不透明的扩展文本，无需解析发出的 WGSL。启用器提供：

```wgsl
// 顶点输入 I
@location(8) instanceParams: vec4f
// 顶点输出 / 片段输入 O
@location(2) @interpolate(flat) instanceParams: vec4f,
// 顶点主体
out.instanceParams = in.instanceParams;
```

自定义片段读取 `in.instanceParams`。每个顶点角点都会收到相同的逐实例 vec4，而 flat 限定符明确了不插值的契约。现有的 `in.uv`、`in.tint`、`fx`、`L`、图集及额外纹理绑定保持不变。参数不会编码或改动 UV 滚动。

## 状态机 / 生命周期

1. 图层创建：普通记录布局，无描述符。
2. 显式启用：校验自定义着色器、追加四个清零的浮点数、安装一次描述符、强制下次执行全量上传与管线排列。
3. 插入：将参数重置为零而不产生分配。
4. 参数更新：原子性校验、写入四个 Float32 值、通过 `_markSprite2DDirty` 将一条逻辑记录标脏。
5. 普通更新：保留额外槽位。
6. 交换删除：拷贝完整记录；下次插入时重置被复用的槽位。
7. 清空/重填：保留容量与描述符，重置每条插入的记录。
8. 扩容或启用 UV：保留完整记录及预计算的属性偏移量。
9. Y 排序（Y-sort）：现有打包逻辑拷贝完整记录并将逻辑脏范围映射到绘制顺序；参数跟随其所属精灵。
10. 设备恢复/销毁：现有的实例缓冲区生命周期已足够。恢复使用保留的 CPU 数据与全新的逐设备管线/模块缓存；销毁释放同一现有缓冲区，不涉及额外 GPU 资源。

上传保持有界，仅限于脏记录。每条按需启用的上传记录宽 16 字节；未发生变化的帧不上传实例数据。内存增长精确为 `capacity * 16` 字节暂存内存加上对应的 GPU 顶点存储，并在容量增长时沿用现有的翻倍策略。在没有合格性能证据之前，不得声称耗时改善或零实测开销。

## Babylon.js 等价映射

不复用或重新解释任何 Babylon.js 精灵颜色/深度约定。这是 Lite 增量的自定义片段输入，而非新的变换、动画系统或高度解释机制。

## 依赖项

Sprite2D 状态/脏辅助函数、类型化数组别名、现有自定义着色器/FX 钩子、现有 WGSL 组合器、可选的稳定句柄索引解析。无场景反向引用、导入期注册表修改或 GPU 分配。

## 测试规范

- 纯 2D 与两种深度模式：不变的普通步幅；精确的按需启用步幅、偏移量、零默认值与 Float32 值。
- 在启用、更新、帧/可见性编辑、扩容、交换删除、尾部复用及清空/重填过程中保留颜色/UV/Z。
- 在参数之前或之后启用 UV 滚动；两种顺序下均为独立数值与正确属性。
- 句柄交换删除与过期句柄错误；Y 排序打包标识。
- 原子性校验失败；重复调用 setter 复用存储且无类型化数组分配/视图创建；有界脏上传且无变化帧零上传。
- 在不修改布局/数据/脏状态的前提下拒绝外部顶点扩展所有权。
- 跨 UV 启用顺序时，相同 WGSL 对应不同管线但共享着色器模块；location 8 vec4、flat location 2 varying；按设备键重新编译。
- 纯 2D 延迟启用：与容量等大的 68 字节记录替换旧缓冲区、切换管线并重新录制渲染 bundle，且无稳态抖动。
- CI GPU 见证测试（witness）：两个具有相同非白 RGBA/UV 及不同 vec4 值的非黑实例产生预期像素。UV 参与某个像素通道的计算，因此其属性偏移在两种启用顺序下均可观测。遗漏第一个实例、将参数清零、把 tint 当作参数或错误寻址 UV 均必须独立破坏该见证。
- 限定范围的 bundle 上限以及普通场景中不存在该启用器。
- 针对分配、脏字节与缓冲区大小的合格 CI/用户性能证据。智能体不在本地运行性能或视觉/对等性测试战役。

`tests/lite/parity/regressions/sprite-instance-params.spec.ts` 在真实 WebGPU 设备上执行生产管线构建器、实例缓冲区扩宽及脏上传器。它直接读取离屏 RGBA8 渲染目标（无需截图或新基准图），覆盖全部三种深度模式与全部三种 UV 启用顺序（无、参数之前、参数之后）。具有相同非白 tint/UV 的实例携带不同的非黑 vec4 值。片段将加权后的 UV 加到蓝色通道；不透明混合保留全部四个输出通道。独立的像素中心计算验证每个四边形的两个采样点。反事实测试（counterfactuals）将 varying 清零、把 tint 当作参数获取、省略第一个实例或把参数当作 UV 获取——每一项都必须在不引发 GPU 校验错误的前提下改变像素。

同一 CI 见证测试还测量精确的 CPU/GPU 缓冲区大小、全量与合并单记录脏写入以及无变化帧的零写入。它在导入引擎**之前**对 Float32 构造函数进行插桩（从而测量其捕获的 `F32` 别名），统计 `subarray` 视图数量，并记录 50,000 次可复用输入 setter 调用。新数组/视图创建属于硬性失败。耗时作为合格性证据附后，而非设定对机器敏感的任意计时上限。普通场景性能仍由现有的 CI 回归作业覆盖。云端对等性配置始终选中该见证测试，包括当其场景过滤器激活时。智能体不在本地运行该测试。

## 文件清单

- `sprite-2d-instance-params.ts`：启用器、公共 setter、校验、WGSL 数据。
- `sprite-2d-instance-layout.ts`：共享的可选记录扩宽工具。
- `sprite-2d.ts`：内部描述符与不透明插入接缝。
- `sprite-fx-hook.ts`：擦除后的描述符类型与属性钩子签名。
- `sprite-custom-shader.ts`：感知描述符的组合与缓存键。
- `sprite-pipeline.ts`：不透明序言文本与属性消费。
- `sprite-2d-uvscroll.ts`：共享扩宽与基于属性的偏移寻址。
- `index.ts`：显式公共根导出。
- `tests/lite/unit/sprite-2d-instance-params.test.ts`：生命周期、校验、所有权、UV 组合、Y 排序、分配/视图与脏上传检查。
- `tests/lite/unit/sprite-renderer.test.ts`：管线/模块排列。
- `tests/lite/unit/device-lost-renderer-recovery.test.ts`：替换设备上的保留参数状态与扩展着色器重建。
- `tests/lite/build/public-api-types.test.ts`：裁剪后的根声明。
- `tests/lite/parity/regressions/sprite-instance-params.spec.ts`：真实 GPU 见证测试、传输变异体、精确内存/上传及 setter 开销证据。
- `config/playwright.parity-cloud.config.ts`：CI 见证测试选择配置。
