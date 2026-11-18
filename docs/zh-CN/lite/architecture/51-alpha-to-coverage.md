# 模块：Alpha-to-Coverage

> 包路径：`packages/babylon-lite/src/render/alpha-to-coverage.ts`
> 管线接缝：PBR/Standard/Shader 材质管线、场景附着文本管线、深度托管 Sprite2D 管线以及公告板（billboard）管线。

## 用途

为多重采样的 Standard、PBR 和 Shader 材质管线，以及最受益于该特性的深度写入文本/精灵管线所有者提供可选启用的 WebGPU alpha-to-coverage（A2C）。Alpha-to-coverage 在深度/模板和颜色写入之前，将片元 Alpha 转换为逐样本覆盖掩码（coverage mask）。它适用于深度写入的抗锯齿文本、镂空（cutout）精灵、植被以及有序不透明表面。未请求该特性的应用仅在管线所有者模块中保留极小的解析器接缝；该特性的状态与行为会被 tree-shake 掉。

该特性仅拥有多重采样覆盖状态。它**不会**静默启用 Alpha 混合、改变片元 Alpha 或改变材质的深度写入策略。希望使用常见不透明替代 A2C 模式的调用方，应在保持混合禁用且深度写入启用的同时输出小数 Alpha。

## 公共 API 接口

```typescript
export type AlphaToCoverageTarget = StandardMaterialProps | PbrMaterialProps | ShaderMaterial | TextRenderable | Sprite2DLayer | BillboardSpriteSystem;

/** Enable or disable alpha-to-coverage for one pipeline-owning target.
 * Call before registerScene()/adding the target to a scene. Material changes after
 * registration require rebuildMaterial(). */
export function setAlphaToCoverage(target: AlphaToCoverageTarget, enabled: boolean): void;

/** Return the requested alpha-to-coverage state for a target. Defaults to false. */
export function getAlphaToCoverage(target: AlphaToCoverageTarget): boolean;
```

这两个函数以及 `AlphaToCoverageTarget` 均从包根显式重导出。公共对象保持为纯状态；不暴露任何方法或原生 `GPURenderPipeline`/`GPUDevice` 句柄。
`NodeMaterial` 被通用公共签名及运行时家族检查有意拒绝，因为其管线在能应用此逐所有者选项之前就已编译。

有效目标路径有意窄于所有文本/精灵 API：

- `StandardMaterialProps`、`PbrMaterialProps` 和 `ShaderMaterial`：主通道材质管线。
- `TextRenderable`：仅当其参与深度且场景目标为多重采样时生效。A2C 变体使用替换颜色外加逐样本深度写入。
- `Sprite2DLayer`：仅对多重采样目标上的场景托管 `depth: "test-write"` 图层生效。
- `BillboardSpriteSystem`：仅对多重采样目标上的深度写入 `cutout` 系统生效。
- 独立的 `TextRenderer` 和 `SpriteRenderer` HUD 通道直接渲染到 1x 交换链并继续使用 Alpha 混合；它们不是 `AlphaToCoverageTarget`。

## 内部架构

### 可选状态

`alpha-to-coverage.ts` 拥有一个惰性分配的 `WeakSet<AlphaToCoverageTarget>`：

- 模块加载时不分配任何对象；
- `setAlphaToCoverage(target, true)` 在首次使用时创建集合并添加目标；
- `setAlphaToCoverage(target, false)` 删除目标而不进行分配；
- 当集合不存在时，`getAlphaToCoverage()` 和内部解析器返回 `false`。

当启用第一个目标时，该模块会将其内部解析器安装到 `alpha-to-coverage-hook.ts` 中。Shader、Standard、PBR、文本和精灵管线所有者读取那个默认为 null 的钩子，而不是仅仅为了询问目标是否启用就导入完整的特性模块。当设置器缺席时，代码压缩会将解析器分支折叠消除。剩余接缝对典型现有场景 bundle 仅增加几个原始字节，且必须保持在其现有上限之内。

### 材质管线集成

对于每个主通道材质家族：

1. 在构建可渲染对象时解析材质的 A2C 请求。
2. 在启用和禁用的材质之间保持着色器组合、bind-group 布局和 bind group 共享。当安装了 A2C 解析器时，共享绑定还会在正常/A2C 变体之间复用 GPU 着色器模块；没有 A2C 时，模块创建遵循现有的逐管线路径。
3. 仅向渲染管线键添加 A2C 区分符。
4. 仅当材质启用 **且** 目标签名的 `_sampleCount > 1` 时，才输出 `multisample.alphaToCoverageEnabled = true`。
5. 单采样描述符保持禁用（WebGPU 回退行为）。

Standard、PBR 和 Shader 绑定在 A2C 状态之间共享，因为 A2C 不会更改着色器源码或资源布局。仅它们的管线键包含解析后的 A2C 状态。

没有任何帧热路径会读取可变的 A2C 状态：它在绑定/注册期间就被烘焙进不可变管线中。

### 文本管线集成

普通的 Slug 文本片元着色器及其预乘 Alpha 混合保持不变。单独的 A2C Slug 片元保留完整字形 RGB，并仅将解析覆盖率放入 Alpha 中。只有当 null 解析器钩子能够选择 A2C 文本所有者时，才会保留该源码。A2C `TextRenderable` 变体：

1. 要求深度写入且 `sampleCount > 1`；
2. 向文本管线键添加 A2C 区分符；
3. 省略颜色混合（替换颜色）；
4. 设置 `alphaToCoverageEnabled: true`。

因此，被覆盖的样本接收字形的完整 RGB 和深度，同时解析边缘 Alpha 选择样本覆盖率。这避免了二次应用覆盖率。独立的 `TextRenderer` 保持普通的混合 1x 管线。

### 精灵管线集成

对于深度托管的 `Sprite2DLayer`，仅当 `depth === "test-write"` 且目标为多重采样时，A2C 才有效。现有图层对象本身即管线所有者和缓存区分符。A2C 保留所选混合描述符；需要替换颜色/深度的调用方应显式使用 `spriteBlendOpaque`。纯 2D/HUD 图层保持 1x 路径。

对于 `BillboardSpriteSystem`，仅对深度写入的 `cutout` 模式及多重采样目标，A2C 才有效。其 A2C 着色器变体移除了二元 `alphaCutoff` 丢弃（discard），使纹理 Alpha 连续驱动样本掩码；其管线使用替换颜色和逐样本深度写入。透明/叠加公告板模式保留其现有混合路径。

## 管线配置

```typescript
multisample: {
    count: target._sampleCount,
    alphaToCoverageEnabled: requested && target._sampleCount > 1,
}
```

所有其他管线字段均保持不变。具体而言：

- 混合状态仍由材质控制；
- 深度比较/写入仍由材质控制；
- 片元着色器的 Alpha 输出是覆盖率源；
- 1x 目标的行为完全等同于禁用 A2C。

## 状态机 / 生命周期

```text
target created
    -> setAlphaToCoverage(target, true|false)
    -> registerScene(scene)
    -> A2C state is baked into cached pipelines

runtime state change
    -> setAlphaToCoverage(material, ...)
    -> rebuildMaterial(scene, material)
    -> bindings select/build the matching pipeline variant
```

销毁无需显式清理，因为 `WeakSet` 不会强引用保留目标。

## Babylon.js 等价映射

| Babylon.js                                      | Babylon Lite                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| 绘制前调用 `engine.setAlphaToCoverage(true)`    | 注册前调用 `setAlphaToCoverage(pipelineOwner, true)`               |
| `engine.getAlphaToCoverage()`                   | `getAlphaToCoverage(pipelineOwner)`                                |
| WebGPU 管线缓存 A2C 位                          | 管线变体键或文本/精灵所有者键                                      |
| MSDF `writeToDepthBuffer`                       | 深度写入 A2C `TextRenderable`                                      |
| A2C + `ALPHA_REPLACE_COLOR`                     | 不带混合描述符的 A2C 管线变体                                      |
| `alphaToCoverageEnabled && sampleCount > 1`     | 相同的 WebGPU 描述符规则，额外受深度所有权门控                     |
| 全局命令式管线状态                              | 不可变的逐所有者管线状态                                           |

逐所有者 API 是有意设计的：WebGPU 的 alpha-to-coverage 是管线状态，而 Lite 在绘制前预先录制管线/bundle，并且没有可变的引擎绘制状态对象。

## 依赖项

- 对三个受支持材质家族、`TextRenderable`、`Sprite2DLayer` 和 `BillboardSpriteSystem` 的仅类型（type-only）引用。
- PBR、Standard 和 Shader 主通道管线构建器。
- 场景附着文本、深度托管 Sprite2D 和公告板管线构建器。
- WebGPU `GPUMultisampleState.alphaToCoverageEnabled`。
- 公共 API 中无外部运行时依赖，也无 GPU 句柄。

## 测试规范

1. 聚焦单元测试验证已启用的 4x Shader 管线设置 `alphaToCoverageEnabled: true`。
2. 同一测试验证 1x 管线保持禁用。
3. A2C 状态相反的等效 Shader 材质不得共享同一个管线。
4. 聚焦测试通过公共设置器构建真实的 Standard/PBR 可渲染对象，验证着色器绑定/模块保持共享，并验证仅多重采样管线变体发生改变。
5. Scene 53 验证深度托管 Sprite2D 集成显式使用 `spriteBlendOpaque` 配合 A2C；其硬 Alpha 图集并非小数覆盖率证明。
6. Scene 57 在 WebGPU 上验证镂空公告板 A2C 管线；其二值图集并非小数覆盖率证明。
7. Scene 274 渲染关闭和开启 A2C 时的红/绿重叠，并使用标准全图 MAD 门限与 Babylon.js WebGPU 基准图进行对比。两行演示彼此隔开，使没有任何卡片与另一行的卡片重叠：跨行重叠会产生相同的深度值，而深度相等在反向 Z `greater-equal` 下与严格 `LESS` 下的判定不同，这会因与 alpha-to-coverage 无关的原因导致 WebGPU 和 WebGL2 场景失去同步。
8. Scene 275 提供小数覆盖率证明：重叠的深度写入 MSDF 文本通过由 `a2c` override 常量特化的 Slug 片元着色器运行，并断言部分字形边缘样本会混合前后景颜色。
9. 重新构建不导入 A2C 的现有 Shader、Standard、PBR、文本和精灵场景时，其极小的原始字节波动必须保持在现有上限之内。

## 文件清单

- `render/alpha-to-coverage.ts` —— 公共目标状态函数以及内部惰性解析器安装。
- `render/alpha-to-coverage-hook.ts` —— 所有可选 A2C 管线所有者使用的默认为 null 的接缝。
- `material/pbr/pbr-pipeline.ts` —— 共享 PBR 着色器资源并发出 A2C 管线变体。
- `material/pbr/pbr-renderable.ts` —— 解析逐材质 A2C 状态以选择管线。
- `material/standard/standard-pipeline.ts` —— 共享 Standard 着色器资源并发出 A2C 管线变体。
- `material/standard/standard-renderable.ts` —— 解析逐材质 A2C 状态以选择管线。
- `material/shader/shader-pipeline.ts` —— Shader 缓存键与描述符接缝。
- `text/_gpu/text-pipeline.ts` —— 预乘 Alpha 普通变体与替换颜色 A2C 变体，通过 `a2c` 管线可覆盖常量选择。
- `text/shaders/slug.frag.wgsl` —— 共享 Slug 片元着色器；`a2c` override 将其输出在预乘 RGB 和非预乘 Alpha（仅 Alpha 中包含覆盖率）之间切换。声明为 `@id(0)`，以便管线通过编号为其定键，从而在 JS 属性混淆下保持稳健。
- `text/text-renderable.ts` —— 提供场景文本管线所有者。
- `sprite/sprite-pipeline.ts` —— 深度托管 Sprite2D 缓存键、混合与描述符接缝。
- `sprite/billboard-pipeline.ts` —— 镂空公告板着色器/缓存/描述符接缝。
- `index.ts` —— 显式根导出。
- `tests/lite/unit/alpha-to-coverage.test.ts` —— 聚焦管线测试。
- `lab/lite/src/{bjs,lite}/scene274.ts` 及一致性资产 —— 材质 A2C 视觉一致性场景。
- `lab/lite/src/{bjs,lite}/scene275.ts` 及一致性资产 —— 深度写入 MSDF 文本 A2C 视觉一致性场景。
