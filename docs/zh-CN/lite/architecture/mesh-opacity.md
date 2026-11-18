# 模块：网格不透明度（Mesh opacity）

> 包路径：`packages/babylon-lite/src/mesh/opacity/`

## 用途

为普通的 Standard 和 PBR 网格提供按需启用的原生逐网格不透明度，无需修改或克隆其材质。兼容层通过同一套原生 API 自动实现 `Mesh.visibility`。共享同一材质的网格（包括 glTF 图元网格）可以拥有各自独立的不透明度。

不透明度独立于网格可见性、层级结构、拾取、包围盒与可见性纪元（visibility epochs）。薄实例（thin instances）共享其所属网格的不透明度。节点/着色器材质无法淡出至低于 1。MeshLoD 实例不是普通的 Mesh 对象，在任何不透明度下均不受支持。逐实例不透明度、子网格不透明度以及兼容层的 `InstancedMesh.visibility` 均不在本模块契约范围内。

## 公共 API 接口

以下两个函数均作为命名导出从唯一的包根导出：

```typescript
function setMeshOpacity(mesh: Mesh, opacity: number): void;
function getMeshOpacity(mesh: Mesh): number;
```

默认值为 1。原生 setter 会将有限数值钳制到 `[0, 1]`；getter 返回存储的钳制后数值（包括销毁后）。

setter 按以下顺序执行操作：

1. 对非数值、NaN 和无穷大输入抛出 `RangeError`：
   `setMeshOpacity: opacity must be a finite number, got <value>`。
2. 要求对象具有现有的 `_gpu` Mesh 判别字段，否则抛出：
   `setMeshOpacity: "<name>" is not a Lite Mesh (for example a MeshLoD instance); per-mesh opacity is not supported on MeshLoD in this release.`
   getter 使用自身的 API 名称前缀执行相同的目标检查。
3. 拒绝已销毁的 `_disposed` 对象：
   `Mesh "<name>" cannot set opacity: it was disposed when it left its last scene. Create a new mesh instead.`
4. 钳制数值。
5. 若值小于 1，则校验非空材质的 `_buildGroup._materialFamily`。
   仅接受 `"standard"` 与 `"pbr"`；否则抛出：
   `setMeshOpacity: mesh "<name>" uses a "<family>" material; mesh opacity supports only "standard" and "pbr" materials.`
6. 仅执行一次功能安装。如果已存储的值或默认值与新的钳制值相等，则直接返回，不存储、不标脏也不写入。
7. 存储该值并同步设置 `mesh._skipColorDraw = value === 0`，在跨越边界 1 时将重建任务入队，并在每次值变化时（包括变为 1）更新存活绑定的 uniform。

允许使用空（null）材质。普通的未销毁 Mesh 无论采用何种材质族都可以重置为 1。无效调用不得安装钩子/扩展、存储状态、分配/写入缓冲区、入队替换或修改场景。

## 内部架构

### 网格值与绑定记录

该功能使用局部交叉类型，而非在核心 Mesh 接口上增加成员：

```typescript
type OpacityMesh = Mesh & { _opacity?: number };
interface OpacityBinding {
    readonly _buffer: GPUBuffer;
    readonly _device: GPUDevice;
    readonly _engine: EngineContext;
    readonly _disposers: (() => void)[];
}
```

`mesh-opacity.ts` 负责校验、标量存储、安装、状态转换及 GPU 记录。一个延迟创建的 `WeakMap<Mesh, Set<OpacityBinding>>` 用于跟踪存活的绑定自有缓冲区。该映射及其集合均不会在导入时分配。一个可复用的单元素 `Float32Array` 用于实时写入；另有一个双元素数组用于绑定初始化。

每个网格的绑定生命周期与设备对拥有一个 16 字节的 uniform 缓冲区。其前两个 `f32` 值为 `[opacity, policy]`，分别位于字节偏移 0 和 4。Standard 忽略第二个值（初始化为 0）；PBR 将其用作不可变的逐绑定 OPAQUE 策略。实时 setter 仅写入偏移 0 处的 4 个字节，绝不改写策略。使用相同 disposer 数组标识与设备进行重复绑定时，会复用现有缓冲区和记录，不再执行分配、初始上传或注册 disposer，即使后续绑定传入不同策略也会保留其创建时的策略。不同的生命周期数组或设备会创建各自独立的记录；任何材质都不拥有该缓冲区。原生浅克隆网格会复制该标量及对应的跳过标志，但绝不复制绑定记录。

### 延迟安装与链式安装器

首次成功调用 setter 时，会执行以下仅运行一次（once-guarded）的序列：

1. 注册 Standard 扩展 `"0-mesh-opacity"`。
2. 注册 PBR 扩展 `"z-mesh-opacity"`。
3. 安装网格特性编码器：当且仅当不透明度低于 1 时返回 `1 << 22`。
4. 安装 PBR 绑定上下文增强器，将绑定的 disposer 数组复制到 `context._disposers`。
5. 使用网格的实时不透明度安装材质切换校验。

扩展注册会使已排序的扩展缓存失效。仅导入该 API 不会触发任何注册、映射/集合分配或 GPU 工作。

通用安装器会按安装顺序保留先前的特性：

| 安装器 | 组合方式 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `_installMeshFeatureExtra` | 将上一个编码器的结果与新编码器的结果按位或（OR）。 |
| `_installPbrBindingContext` | 使用相同的 context、标量 id 和 disposers，先调用上一个增强器，再调用新增强器。 |
| `_installMeshMaterialValidator` | 在修改前先运行上一个校验器，再运行新校验器。 |

无论以何种顺序安装，这都能保留镜像网格编码、矩形区域光绑定上下文以及索引间接借用校验。安装到链式槽位中的特性必须自行保证一次性安装保护：不透明度特性如此实现，`installRectAreaEmissionPbr` 也会在安装其光照 id/disposer 增强器前进行同样保护。绑定 id 与 disposer 数组保持逐次调用独立，不会从首次 prepare 中捕获。

### 网格位传输与 Standard 折叠

`material/mesh-features.ts` 通过注释预留了网格位 22。不透明度编码器拥有其语义；核心代码不添加共享的不透明度常量，也不读取不透明度。已安装的编码器在不透明度为 1 时返回 0，低于 1 时设置第 22 位，但不编码材质 alpha 策略。

PBR 的不透明度片段声明了特性局部常量 `MESH_OPACITY_MESH_BIT = 1 << 22`。OPAQUE alpha 策略保存在 uniform 中，而非着色器变体位中。

Standard 使用其现有的扩展钩子：

```typescript
_meshFeatures?(meshFeatures: number, material?: StandardMaterialProps): number;
```

Standard 的不透明度钩子会检测网格第 22 位以及源材质缓存的 `NO_COLOR_OUTPUT | ESM_SHADOW_OUTPUT` 位。对于淡出的颜色网格，它返回特性局部的 `STD_MESH_OPACITY_BIT = 1 << 30` 加上 `MATERIAL_ALPHA_BLEND`；否则返回 0。第 30 位在 `standard-flags.ts` 中通过注释预留。Standard 的前向与几何路径都会将该结果折叠进各自的有效材质特性中。

Standard 前向队列分类保留实时的 `mat.alpha < 1` 项，并检测最终的 `HAS_OPACITY_TEXTURE | MATERIAL_ALPHA_BLEND` 字。因此，队列与管线选择会使用经过不透明度折叠后的混合位，同时不会丢失现有的实时材质 alpha 行为。

### 在三个消费端进行的 PBR 折叠

PBR 没有逐网格扩展折叠钩子或临时对象。现有的通用传输方式为：

```typescript
(meshFeatures >>> 16) & PBR_HAS_ALPHA_BLEND;
```

网格第 22 位映射到材质 alpha 混合第 6 位。该特性位保留在网格字中供 PBR 不透明度片段使用；通用折叠则提供路由、混合状态和组合键标识。

三个消费端分别为：

1. **`pbr-renderable.ts` 前向重建。** 仅当 `features2` 既不包含 `PBR2_NO_COLOR_OUTPUT` 也不包含 `PBR2_ESM_SHADOW_OUTPUT` 时，将该传输结果按位或（OR）进 `renderFeatures.features`。这个有效字将驱动着色器组合、绑定/管线键以及透明分类。
2. **`pbr-geometry-renderable.ts` 几何管线选择。** 几何的组合视图会剥离材质混合分支，但其源混合判定会将该传输结果按位或进 `source._renderFeatures?.features ?? 0`。因此，对于淡出网格，这一颜色输出路径会启用混合并禁用深度写入，而几何着色器仍根据有效 alpha 进行门控。
3. **`pbr-built-variant.ts` 已组合变体查找。** 在 `_pbrComposeKey` 之前，使用与前向路径相同的无颜色/ESM 掩码将同一传输结果折叠到源特性中。查找必须请求前向重建实际组合的那个变体。

阴影/无颜色/ESM 输出不会获得 alpha 混合位或不透明度片段。网格第 22 位仍可能区分原本相同的阴影变体键，但它不会改变投射体（caster）的 alpha。

`_pbrMeshRequest(scene, mesh, noShadows)` 保留其四元返回结构：

```typescript
readonly[(context, meshFeatures, lightMode, singleLightType)];
```

前向生成元数据保持为：

```typescript
[geometryContext, meshFeatures, lightMode, singleLightType, renderFeatures];
```

两个元组中均未增加额外的折叠材质字段，且 `Renderable` 或几何视图生成元数据也无任何变更。

### 绑定上下文与退役传输

`_PbrBindCtx._mesh` 允许 `Mesh | null`。不透明度扩展要求实际存在的网格及其绑定自有的 disposer 数组。

`_installPbrBindingContext` 还会启用 `_pbrBindingIdentity`（用于可选数字绑定 id 的恒等函数）和 `_createPbrBindingDisposers`（返回新数组的工厂函数）。`createPbrMeshBindGroup` 构建普通上下文，调用已安装的增强器，然后运行片段绑定钩子。只有特性自有的增强器才会填充 `_disposers` 和 `_lightingId`。

PBR 几何路径精确使用：

```typescript
const bindingDisposers = _createPbrBindingDisposers?.();
```

不存在 `?? []` 回退。没有安装器时它保持为 undefined，不会分配辅助生命周期集合。安装不透明度后，该工厂在几何绑定前就已存在。同一个数组会传递到 PBR 上下文和几何销毁流程。Standard 通过 `StdExt._bind` 传递其现有的主路径/几何绑定自有数组。

### 透明与几何循环跳过

Mesh 接口声明了一个可选的 `@internal _skipColorDraw?: boolean`。它没有工厂初始化器，也不出现在公共声明中。仅 `setMeshOpacity` 会在存储钳制标量后立即写入该字段。恰好在 opacity 为 0 时为 true，在其他所有赋值时为 false。它随网格共存且不拥有资源，因此无需额外的销毁钩子。

通用渲染循环在现有的 `visible === false` 检测旁读取这一通用标志。对于本特性，直接读取普通内部字段是对 GUIDANCE 中“引擎安装接缝”要求的明确批准例外：在从不使用不透明度的场景中它仅增加约 16–25 B，低于按需逐可渲染对象绘制包装钩子方案（同一场景下实测高达 148 B）。没有任何渲染器会导入不透明度模块或读取不透明度标量。

| 循环 | 跳过条件 | 路由行为 |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `render-task-base.ts` `drawList` | `mesh && (mesh.visible === false \|\| (transparent && mesh._skipColorDraw))` | 第四个可选布尔值仅对透明列表和透射叠加层为 true。不透明 bundle 录制和直接列表省略该参数。 |
| `transmission.ts` 透明循环 | `mesh && (mesh.visible === false \|\| mesh._skipColorDraw)` | 在现有位置（所有透射纹理更新之后）检查。`renderOnTop` 叠加层使用 `drawList(..., true)`。 |
| `geometry-renderer-task.ts` 几何循环 | `mesh.visible === false \|\| mesh._skipColorDraw` | 几何绑定属于颜色/输出绑定，绝非阴影投射体。 |

淡出的 Standard/PBR 颜色绑定会通过现有的特性折叠被强制归入透明列表。阴影可渲染对象绝不会是透明的，因此其不透明/直接列表会忽略跳过标志并保持全强度阴影投射。不透明渲染 bundle 录制与可见性纪元保持不变。

循环每帧都会读取该标志。`0.5 → 0 → 0.5` 切换无需重建，也不会缓存陈旧的跳过状态。不透明孪生对象重放相同的 bundle。公共 `visible`、兼容层 `isVisible`、拾取和无障碍访问相互独立，绝不会因不透明度而改变。

这是 CPU 侧的绘制省略，而非着色器 discard。Standard/PBR 构建器返回其普通的未包装绘制调用；不存在网格绘制钩子模块、包装器或安装器。直接调用原始绑定会绕过任务级过滤。诊断性过度绘制（overdraw）探针保持不变，可能会计入 opacity 为 0 的透明绑定。

## 管线配置

| 路径 | Opacity 1 | Opacity 在 (0, 1) 区间 | Opacity 0 |
| -------------------------------------- | ------------------------- | ------------------------------------------------------ | -------------------- |
| Standard/PBR 主路径及离屏颜色 | 现有变体/绑定 | 开启混合、关闭深度写入、排序后的透明队列 | 不绘制 |
| PBR 折射 | 现有变体 | 相同的逐网格系数；纹理组策略不变 | 不绘制 |
| Standard/PBR 几何输出 | 现有变体 | 开启混合、关闭深度写入；alpha 进入 `> 0.4` 门控 | 不绘制/无输出 |
| 无颜色/CSM/PCF/ESM 阴影 | 不变 | 全强度投射体；无不透明度片段/绑定 | 全强度投射体 |
| 拾取、剔除、包围盒与 `visible` | 不变 | 不变 | 不变 |
| 透射不透明捕获/GPS 深度 | 现有分类 | 透明，从不透明/深度捕获中排除 | 透明，不绘制 |

在几何任务中淡出网格会使其成为混合参与者。每个颜色目标都必须支持混合：默认的 `VIEW_DEPTH`（`r32float`）需要设备特性 `float32-blendable`，或覆写为 `r16float` 格式。整数标签目标绝不混合。这与材质自身的 BLEND 策略要求相同。PBR、Standard 和 Node 几何管线创建通过 `_geometryColorTarget` 强制执行该格式契约。在缺少该特性时使用混合的 32 位浮点目标会抛出已有错误：
`Transparent geometry output format "${format}" requires the float32-blendable WebGPU feature or a blendable format override.`
校验同时也会拒绝混合的整数格式；网格混合标签目标明确保持不混合。

淡出的镂空（cutout）会在任何数据或网格混合标签写入之前，丢弃应用不透明度后 `alpha <= 0.4` 的几何片段。因此它们会保留底层标签，而不会透过被抑制的数据采样写入镂空的原始标签。其权衡在于这些采样也不再向额外的发光颜色槽位（emit-colour slot）贡献输出。前向镂空覆盖率保持不变。

PBR 主透明排序权重（order）为 150；Standard 主路径与两条几何路径均使用 200。现有的材质级 alpha-to-coverage 与 `:a2c` 管线标识保留不变；A2C 和混合都会看到最终 alpha。不会修改任何材质 alpha、alpha-test 阈值、alphaBlend 标志或 visible 标志。镜像、VAT、薄实例和透射保持独立。

### Uniform 布局

每个激活的不透明度片段贡献一条结构化声明：

```typescript
{
    _name: "meshOpacity",
    _type: { _kind: "uniform-buffer" },
    _visibility: SS.FRAGMENT,
}
```

Standard 的辅助结构体为 `struct meshOpacityUniforms{value:f32}`；PBR 的为 `struct meshOpacityUniforms{value:f32,policy:f32}`。组合器（composer）会根据声明分配 group-1 绑定索引；绝不可通过解析发出的 WGSL 来获取索引。绑定钩子推入 `{ binding, resource: { buffer } }` 并返回 `binding + 1`。当存在具有相同生命周期数组和设备的记录时会直接复用；否则根据当前网格状态初始化 uniform、记录缓冲区并追加其 disposer。缺失网格/场景或生命周期传输时，会抛出特定于路径的内部不变量错误，而不是静默分配回退集合。

`_bindMeshOpacity` 接受最后一个可选的数字参数 `policy = 0`。仅在创建时初始化两个浮点数；复用的记录绝不会重写它们。PBR 使用与其片段槽位相同的折叠后 `ctx._features & PBR_HAS_ALPHA_BLEND` 判别式来选择分类器。前向绑定使用**被渲染绑定材质自身的 `_renderFeatures`**：即公共材质视图声明的标志，而非其源材质标志。相对地，几何绑定使用 `(material.source ?? material)._renderFeatures`，因为几何视图剥离了混合分支。当且仅当所选特性存在且其折叠前的 `features` 既不包含 `PBR_HAS_ALPHA_BLEND` 也不包含 `PBR_HAS_ALPHA_TEST` 时，将 policy 设为 1；否则设为 0（包括特性缺席的情况）。这仅使用纯类型导入的材质视图和普通字段，不会给仅使用 Standard 不透明度的场景增加运行时模块依赖。

因此，覆写材质使用的是覆写自身的策略，而非 `mesh.material` 的策略。材质切换与可渲染对象重建会通过新的生命周期自有绑定遵循新材质/视图的策略。使用同一生命周期/设备重新绑定时将保留创建时策略，与已准备好的管线变体保持一致。

Standard 前导的 `"0-mesh-opacity"` 扩展/片段 id 使注册表与组合器排序位于 `"0-std-uv-transform"` 之前。PBR 使用 `id: "z-mesh-opacity", phase: "fragment"`；其绑定顺序遵循组合后的片段键。主路径、折射和几何路径各自使用自己组合的布局。

## 着色器逻辑

### Standard

使用槽位 `BC`：

```wgsl
alpha = alpha * meshOpacity.value;
color = vec4<f32>(color.rgb, color.a * meshOpacity.value);
```

原有的 `AT` alpha-test discard 已经执行完毕；雾效 `BA` 尚未执行。几何组合（`features & GEOMETRY_OUTPUT`）会向此 `BC` 追加 `if (mat.aCut > 0.0 && alpha <= 0.4) { discard; }`。`mat` 处于作用域内，且 `alpha` 与几何数据门控所使用的运行值相同。前向 `BC` 保持为上述两条语句不变。颜色路径返回 `color.a`，而几何路径门控检查 `alpha > 0.4`，因此两个 alpha 表示都必须相乘。无颜色/ESM 模板会直接返回，不包含该片段。因此 OPAQUE 与存活的 MASK 片段均可在不改变原有 discard 阈值的前提下淡出。

### PBR

除非设置了网格第 22 位且 features2 既非无颜色也非 ESM，否则不返回片段。前向组合同时包含策略归一化与最终不透明度乘法；几何路径则在单个槽位中合并完成：

| 组合特性 | 槽位 | 语句 |
| ----------------------------------- | ---- | --------------------------------------------------------------------------- |
| 设置了 `PBR_HAS_ALPHA_BLEND`（前向） | `BC` | `if (meshOpacity.policy > 0.5) { alpha = 1.0; }` |
| 同一前向组合 | `FA` | `finalAlpha = finalAlpha * meshOpacity.value;` |
| 剥离混合分支的几何路径 | `BC` | `alpha = select(alpha, 1.0, meshOpacity.policy > 0.5) * meshOpacity.value;` |

**OPAQUE alpha 策略：** 策略 1 将源 alpha 视作 1，即使基础颜色纹理、基础颜色因子或顶点颜色带有 alpha 也是如此。前向 `BC` 在解码/顶点颜色 alpha 之后、`var finalAlpha=` 之前运行。常规的亮度折叠会将归一化后的 alpha 饱和为 1；`FA` **在该折叠之后**相乘。因此最终 alpha 等于网格不透明度，而非不透明度加上亮度。几何路径则在 `alpha > 0.4` 检查之前同时完成归一化与相乘。Gamma-albedo 与 unlit 路径同样声明了 `alpha` 并使用相同策略。

**自有 alpha 策略：** BLEND 以及材质 alpha 低于 1 的情况保留现有的在常规输出 alpha 计算之后执行的前向 `FA` 乘法：`saturate(alpha * materialAlpha + luminanceOverAlpha²) * opacity`。几何路径剥离混合分支并使用策略为 0 的组合 `BC`。MASK 同样使用策略 0，并保持其前向 `FA` / 几何 `BC` 行为。两者均在原有的 `AT` 阈值截断**之后**执行，因此该截断测试的是材质自身的 alpha，而非网格不透明度。前向网格不透明度不会改变哪些 MASK 片段存活。仅在几何路径中，带有 `PBR_HAS_ALPHA_TEST` 的 PBR 变体会在组合不透明度 `BC` 之后、首次数据/标签写入之前追加 `if (alpha <= 0.4) { discard; }`。因此淡出的镂空也服从几何数据门控，而 opacity 为 1 的变体保留其原有的原始 MASK 标签与 Standard aCut 选择。非镂空几何与前向路径不会添加该 discard。不透明度扩展刻意不导入几何附件状态；被拒绝的采样同样省略所有额外的发光颜色输出。

仅阴影（shadow-only）片段拥有并内部导出 `PBR2_HAS_SHADOW_ONLY = 1 << 30`。延迟加载的不透明度片段从 `fragments/shadow-only-fragment.ts` 导入它，而非从共享标志或公共根导入。当设置了该 features2 位时，声明依赖 `["shadow-only"]`；否则省略该依赖。Shadow-only 自身的特性会强制启用 alpha 混合，因此其策略为 0。策略 `BC` 在 shadow-only 的 `BC` 之后运行并保持该遮罩完整；不透明度 `FA` 在 shadow-only 写入最终 alpha 之后运行并缩放该遮罩，既无缺失依赖错误，也不会产生亮度溢出。

折射在 `NI` 中开启条件块并在 `BC` 中闭合。`"z-"` id 将几何 alpha 覆写或乘法置于该闭合大括号之后。透射/折射写入的是颜色而非 alpha。所选不透明度槽位在输出或几何门控之前运行。

**为何不使用变体位？** 混合折叠使得淡出的 OPAQUE 与 BLEND 材质在其余特性相同时共享同一个组合键。若增加区分键位，则需要修改共享传输/键逻辑，并给无关场景增加字节体积。从缓存的网格/材质特性推导的策略也可能过期，或在覆写时描述了错误的材质。相比之下，绑定 uniform 跟随所渲染材质/视图的分类器及其生命周期，无需对共享着色器键或渲染循环做任何修改。

## 状态机与生命周期

| 状态转换 | 标脏（Dirtying） | 已有 uniform 写入 | 缓冲区生命周期 |
| ------------------- | ------------------------------------------------ | --------------------------------------------- | ------------------------------------ |
| 1 → 0.6 | 每次跨越时一次；在每个所属场景中入队 | 将最新因子写入所有仍存活的记录 | 新的生命周期进行分配 |
| 0.6 → 0.4 → 0 → 0.3 | 无 | 每次值变化向每个存活绑定写入 4 字节 | setter 不分配也不销毁 |
| 0.3 → 1 | 每次跨越时一次；在每个所属场景中入队 | 向所有仍存活的记录写入 1 | 旧缓冲区随旧绑定一起退役 |
| 相等的钳制值 | 无 | 无 | 无 |
| 未注册网格 | 无场景入队 | 除非已绑定，否则无记录 | 首次绑定读取存储值 |

标脏使用 `markMeshRenderableDirty` 及现有的逐场景交换队列去重；它绝不会递增可见性纪元。边界入队与直接写入相互独立。

### 显式渲染任务

`autoMirror: false` 的渲染任务通常会保留由 `addMeshToTask` 解析出的可渲染对象。仅当任务在录制前选择启用 `enableRenderTaskMeshRefresh`，且该条目是**未设置**逐任务材质覆写的场景自有网格时，跨越 1 才会改变不透明/透明管线变体。与材质切换一样，所属场景先排空其重建队列；已启用的任务在执行时跟随产生的可渲染对象版本。它会重建自身的辅助可渲染对象，并在已提交的 GPU 工作排空后使旧的生命周期 disposer 退役。参见 [帧图 — 显式任务网格刷新](28-frame-graph.md)。

```typescript
const task = createRenderTask({ name: "fading", rt, autoMirror: false }, engine, scene);
enableRenderTaskMeshRefresh(task);
addMeshToTask(task, mesh);
```

一旦透明绑定成为当前状态，低于 1 的更新以及 0 值跳过均实时生效，无需任务重建。普通的显式任务在跨越边界后会保留旧的可渲染对象，因此若未启用刷新，调用方必须自行显式同步/重新录制任务。不透明列表不检查 opacity-0 标志：这些列表同时服务于阴影任务（不透明度不得移除投射体），且不透明渲染 bundle 会缓存绘制。在那里跳过会破坏阴影门控与缓存 bundle 重放契约。该标志仅在透明/透射颜色列表与几何路径中读取。

### 未注册网格与保留的绑定

未注册到任何场景、但通过显式几何任务 `meshes` 列表绘制的网格，仅在该任务下次同步可渲染对象时才会感知不透明度阈值跨越（`1 ↔ <1`，选择管线/混合变体）。这与此类网格上的材质/拓扑变更契约一致；setter 不会使离屏/场景外几何任务失效。低于 1 的数值更新与 opacity-0 跳过立即生效。恢复为 1 时也会向保留的绑定缓冲区写入 1，因此在等待同步期间不会残留旧的不透明度。

**快速双跨越：** 在异步替换稳定之前发生 `0.3 → 1 → 0.6` 时，尽管已将重建入队，保留的透明绑定仍必须收到 0.6。替换绑定会从最新存储的值初始化。中间向 1 的过渡会向仍存活的缓冲区写入 1。零值/非零小数值之间的变化无需重建，因为循环直接读取同步更新的跳过标志。

对于每次直接写入，均要求 `record._engine._device === record._device`。setter 会跳过设备已过期的记录而不在 setter 中销毁它们。绑定 disposer 会在销毁缓冲区之前移除自身记录，且是幂等的。

折射重绑定会复用与同一可渲染对象生命周期数组及设备关联的不透明度记录与缓冲区，即使其他绑定组条目发生变化亦然。每个新的生命周期或设备都会获得独立缓冲区。不存在新的签名缓存。当网格属于多个场景时，拆解其中一个场景仅移除该场景的记录。现有的“从最后一个场景移除时销毁网格 GPU 资源并标记为已销毁”机制保持不变；不透明度不添加任何网格销毁或退役观察者。

设备恢复（recovery）的材质组重建即使在 opacity 为 1 时也会计算网格特性。当绑定映射存在时，已安装的不透明度特性编码器会退役其引擎当前设备与捕获设备不同的记录。setter 在写入存活记录前也使用同一个辅助函数。退役会在销毁丢失设备的缓冲区前移除该记录；后续旧 disposer 会看到删除已完成而不执行任何操作。恢复过程会清空场景的 disposer 映射而不调用它们，因此即便不透明度被重置为 1 且未创建替换绑定，也必须依赖编码器退役。淡出网格会从最新标量重建绑定；实时更新仅到达设备匹配的记录。不透明度本身不拥有设备作用域缓存。

### 材质替换与目标排除

对于已淡出的已注册网格，链式校验器会在 `mesh.material` 存储值或队列入队前同步拒绝不支持的材质。注册流程会在登记前校验未注册网格待处理的原始赋值。先前的校验器保持其顺序与原子性。

MeshLoD 实例缺乏 `_gpu`，无法传入任一不透明度 API。其资产/实例登记路径也不接受普通 Mesh，因此无论操作顺序如何，都不会将带有不透明度的 Mesh 放入 MeshLoD 批次中。不会添加任何 MeshLoD 钩子、扫描或元数据。与淡出普通 Mesh 共享材质不会修改该材质。

## Babylon.js 等价映射

兼容层 `Mesh.visibility` 静态导入原生 API；没有额外的兼容层启用器。包装器存储原始有限数值，但使用钳制后的原生值渲染。非有限赋值会抛出错误。材质族检查使用兼容层 `unsupported(...)` 辅助函数。

在写入任何对象之前先校验所有拥有的图元；仅在原生写入成功后才发布包装器的原始值。GPU 包装器拥有自身。仅变换的 glTF 节点包装器拥有其直接 GPU 图元子节点，而不包含跨子节点的后代。合成根节点不拥有任何几何体。`_fromLite` 对实际 GPU 包装器读取原生不透明度；仅变换包装器从 1 开始。

原始 getter 属于被赋值的包装器本身，而非继承的父级系数。所有者扇出（fan-out）会改变图元的渲染系数，但不会改变图元包装器各自独立的原始 getter。材质替换时也会检查有效原生不透明度。处于待定（pending）状态的 NodeMaterial 句柄在原生材质存在之前即会在低于 1 时被拒绝。克隆会复制原始值而无需冗余调用 setter。`isVisible` 与 `_syncVisibility` 保持不变。

| 行为 | 等价性 / 差异说明 |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| 无显式 BJS 透明模式的编程式 Standard/PBR | 可见性 / 混合行为对等 |
| 原生 glTF OPAQUE 淡出 | 源 alpha 归一化为 1；最终 alpha 等于不透明度 |
| MASK / shadow-only 淡出 | 保留原有阈值截断 / 阴影遮罩，再按不透明度缩放 |
| 有限超范围数值 | 兼容层 getter 返回原始值，渲染采用钳制值 |
| NaN / Infinity | RangeError 差异 |
| 低于 1 时的节点/着色器材质 | 明确的不支持错误 |
| 阴影 | 即使在零不透明度下仍保持全强度投射 |
| 拾取、层级与克隆 | 拾取不变、无层级继承、复制标量 |
| InstancedMesh / 子网格 | 无新增支持 |

## 依赖项

使用现有的 Standard/PBR 注册表、结构化着色器组合器、材质族标签、场景校验器/标脏注册表、绑定自有生命周期数组以及克隆/恢复路径。运行时材质族代码仅导入通用接缝，绝不导入本特性。内部钩子与 WebGPU 句柄不会通过根声明泄漏。该包仍然仅暴露一个根导出。

即便特性实现体缺席，核心传输与绘制调用点仍可能跨生产 chunk 边界保留。缺少不透明度实现标记并不证明运行时零字节成本。运行时体积检查以仓库现有排除项与 gzip 统计下实际拉取的 JS 为准，而非产物清单。

## 测试规范

- 原生输入/错误原子性、有限值钳制、销毁、克隆隔离、未修改的材质/拾取/可见性、MeshLoD 拒绝以及空材质策略。
- 所有边界/非边界转换计数、多场景记录、幂等销毁、恢复/设备不匹配以及快速双跨越下的缓冲区新鲜度。
- 离屏/场景外保留的几何绑定在重置时收到 1。在相同设备与生命周期上的重复绑定仅分配一个缓冲区/disposer/记录，且每次更新仅写入一次；不同的生命周期数组或设备保持独立。
- 原子性不支持材质切换，以及与真实索引间接借用校验器的两种安装顺序；先入先行的特性/上下文链。
- PBR 逐绑定 OPAQUE 策略覆盖含 alpha 的纹理/因子/顶点颜色、gamma/unlit 前向/几何矩阵、高亮度以及一致的组合键。双向显式覆写均使用被渲染绑定的策略：前向公共视图在添加或剥离混合时使用自身标志，而几何视图使用源标志。普通 OPAQUE 前向绑定保留策略 1；OPAQUE/BLEND/OPAQUE/Standard 切换会创建新绑定。实时写入在仅修改偏移 0 处 4 字节的同时保留策略；同生命周期复用保留创建时策略。Shadow-only 初始化为 `[opacity, 0]` 并保留其遮罩。BLEND/材质 alpha 乘法与 MASK 前向 `FA` / 几何 `BC` 仍位于原始阈值截断之后。Standard 输出 alpha 忽略漫反射纹理 alpha。验证 shadow-only 依赖、折射闭合大括号、几何 `> 0.4` 门控及组合器/绑定索引一致性。
- 透明与几何任务循环在零值时跳过颜色绘制并在标志清除时实时恢复。不透明/直接列表忽略该标志，从而保留无颜色/ESM 投射体。透射与 renderOnTop 检查保留纹理更新顺序。原始绑定保持未包装。孪生 bundle 测试重放同一不透明 bundle 并保留可见性纪元，同时仅改变淡出的透明绘制。
- 场景自有的非覆写显式条目仅在启用网格刷新时跟随不透明度跨越。排空真实场景重建队列并执行真实任务：1 → 0.5 选择透明，0.5 → 0 实时跳过，0.5 → 1 恢复不透明并使辅助生命周期退役。普通显式任务保留其可渲染对象。
- 标志测试覆盖零到小数/一的切换、无效调用原子性、克隆隔离、未改变的公共可见性/可拾取性以及无障碍投影。
- 保留 Standard 的实时材质 alpha 分类、A2C 加混合、镜像/VAT 绑定、PBR 生成标识及组合键一致性。
- 重复调用矩形区域光发射安装器仅注册一个上下文增强器；该增强器转发每次绑定的当前标识与生命周期数组。
- 兼容层原始/钳制值、独立的 isVisible、原子性 glTF 扇出、无继承、clone/_fromLite 以及不支持的材质赋值。
- 构建探针：未使用条目不包含特性主体标记；按需启用的条目保留它们。根声明裁剪与仅根导出成立；MeshLoDInstance 在编译期即为无效的不透明度目标。
- Scene354 提供静态 Standard/PBR 1/0.5/0 与不透明孪生体、归一化 OPAQUE/MASK 用例、全强度阴影以及 A2C。其 BJS 基准图不可变；像素/MAD 覆盖归属于现有场景对等基础设施。

## 文件清单

下文中的 `src/` 指 `packages/babylon-lite/src/`。列出的通用文件仅包含传输或集成代码，不包含特性自有的不透明度比较逻辑。

| 领域 | 文件 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生 API / 特性 | `src/mesh/opacity/mesh-opacity.ts`、`mesh-opacity-standard.ts`、`mesh-opacity-pbr.ts`；`src/index.ts` 中的根导出 |
| 网格传输 | `src/material/mesh-features.ts` |
| Standard 集成 | `src/material/standard/standard-flags.ts`、`standard-renderable.ts`、`standard-geometry-renderable.ts` |
| PBR 集成 | `src/material/pbr/pbr-flags.ts`、`pbr-pipeline.ts`、`pbr-renderable.ts`、`pbr-geometry-renderable.ts`、`pbr-built-variant.ts` |
| Shadow-only 谓词 | `src/material/pbr/fragments/shadow-only-fragment.ts` |
| 绘制过滤 / 校验 | `src/mesh/mesh.ts`、`src/frame-graph/render-task-base.ts`、`transmission.ts`、`geometry-renderer-task.ts`、`src/scene/mesh-scene-registry.ts` |
| 矩形区域光安装器守卫 | `src/material/pbr/fragments/rect-area-light-emission-fragment.ts` |
| 兼容层 | `packages/babylon-lite-compat/src/meshes/meshes.ts`、`README.md`、`COMPAT-STATUS.md` |
| 架构索引 | `docs/lite/architecture/00-overview.md` |
| 原生单元测试 | `tests/lite/unit/mesh-opacity.test.ts`、`mesh-opacity-shader.test.ts`、`render-pass-task.test.ts`、`geometry-renderer-task.test.ts`、`pbr-forward-generation.test.ts` |
| 矩形区域光回归 | `tests/lite/unit/area-light-emission-opt-in.test.ts` |
| 构建测试 | `tests/lite/build/mesh-opacity-treeshake.test.ts`、`public-api-types.test.ts` |
| 兼容层测试 | `packages/babylon-lite-compat/tests/mesh-visibility.test.ts`、`mesh-clone.test.ts` |
| 测试夹具（Fixture） | `lab/lite/scene354.html`、`bundle-scene354.html`、`babylon-ref-scene354.html`、`src/lite/scene354.ts`、`src/bjs/scene354.ts`、`src/shared/scene354-opacity.ts` |
| 注册配置 | `scene-config.json`；HTML 入口、画廊和 bundle 测试会自动发现条目 |
| 对等性 / 资产 | `tests/lite/parity/scenes/scene354-mesh-opacity.spec.ts`、`reference/lite/scene354-mesh-opacity/babylon-ref-golden.png`、`lab/public/thumbnails/scene354.jpg` |
