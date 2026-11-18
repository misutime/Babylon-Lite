# 模块：视差遮蔽贴图（Parallax Occlusion Mapping）

> 包路径：`packages/babylon-lite/src/material/parallax/`、
> `material/pbr/fragments/parallax-occlusion-fragment.ts`、
> `material/standard/fragments/std-parallax-occlusion-fragment.ts`

## 用途

为 PBR 与 Standard 材质提供按需启用的高度图 UV 位移效果，在 WGSL 中独立实现，采用自适应粗步进（coarse marching）结合接触精化（contact refinement）与插值。本实现**并非 Tore Lervik 的 FPOM 实现**，也不声称具有相同的算法、画质或性能。

所链接的 [FPOM 1.2 视频](https://www.youtube.com/watch?v=X0eRzccNnPw) 指向[一个付费 Unreal 材质函数资产](https://www.fab.com/listings/f56aea7a-337f-4b6a-8333-9e4739574370)。其[公开文档](https://github.com/hallatore/fpom-docs/blob/main/Settings.md)描述了接口，但未披露其加速算法。下文独立规范化的求解器遵循 [Andrea Riccardi 的接触精化文章](https://www.artstation.com/blogs/andreariccardi/3VPo/a-new-approach-for-parallax-mapping-presenting-the-contact-refinement-parallax-mapping-technique)中描述的两阶段原理。未从上述任一产品或 Babylon.js 复制任何实现代码。

初版特性刻意保留现有法线贴图，不生成法线、不写入片段深度、不添加自阴影、不修改顶点位置、不影响拾取/碰撞，也不改变轮廓。它是一种材质纹理坐标效果，而非几何位移。

## 公共 API 接口

所有导出均来自包根：

```ts
export interface ParallaxOcclusionProps {
    readonly heightTexture: Texture2D;
    readonly heightScale?: number; // 世界空间高度范围；默认 0.05
    readonly heightCenter?: number; // [0, 1]；默认 0
    readonly heightChannel?: "r" | "g" | "b" | "a"; // 默认 "r"
    readonly minSteps?: number; // 整数 [1, 64]；默认 8；正视角下的粗步进预算
    readonly maxSteps?: number; // 整数 [minSteps, 64]；默认 32；掠射角下的粗步进预算
    readonly refinementSteps?: number; // 整数 [1, 32]；默认 8；最大二分细分数
}

export function setPbrParallaxOcclusion(material: PbrMaterialProps, props: ParallaxOcclusionProps | null): void;

export function setStandardParallaxOcclusion(material: StandardMaterialProps, props: ParallaxOcclusionProps | null): void;
```

传入 `null` 可禁用该特性。请在 `registerScene()` 之前调用 setter。材质构建完成之后，更改高度纹理或 POM 是否拥有激活着色器变体（包括跨越零高度缩放）需要调用 `rebuildMaterial(scene, material)`。Standard 独立的特性 UBO 在参数更新时同样需要重建。而在已激活且保持相同高度纹理的 PBR 变体上，标量/质量及高度 UV 变换更新可改用 `markMaterialUboDirty(material)`。setter 会拷贝设置项；修改原选项对象不会影响材质。纹理句柄本身保持共享。

```ts
const heightTexture = await loadTexture2D(engine, "/textures/bricks-height.png", {
    srgb: false,
    mipMaps: true,
});

setPbrParallaxOcclusion(material, {
    heightTexture,
    heightScale: 0.04,
    heightCenter: 0,
    minSteps: 8,
    maxSteps: 32,
    refinementSteps: 8,
});
```

`heightCenter = 0` 将整个高度范围置于网格表面下方；`1` 置于上方；`0.5` 均分上下范围。采样高度 `h` 对应的世界高度为 `heightScale * (h - 1 + heightCenter)`。

高度纹理必须是可过滤的颜色纹理，不能是深度、整数或 32 位浮点纹理。RGB 高度通道必须使用线性纹理格式；alpha 通道可以来自 sRGB 纹理，因为 sRGB 解码不改变 alpha。高度采样值会被钳制到 `[0, 1]`。寻址模式与放大/缩小/Mip 过滤遵循纹理现有的采样器。求解器在每个像素上为其高度读取选择一个 mip 级别，因此采样器的各向异性仅作用于发生位移后的表面纹理采样。

无效的缩放、中心点、通道、步数或纹理类型会在修改材质状态或扩展注册表之前抛出异常。缩放必须为有限、非负且可表示为 `f32`；步数必须为上述范围内的整数。零缩放会禁用该特性的着色器组合。

## 内部架构

每个材质都有一个可选的 `@internal _parallaxOcclusion` 状态字段，类型为 `ParallaxOcclusionProps`。没有任何工厂初始化它，也没有任何核心构建器导入该特性。每个 setter 仅导入其所属材质族的扩展。注册发生在调用 setter 时，绝不在模块导入时发生。

PBR 片段拥有材质 `features` 第 5 位。这不会与 `PBR_HAS_FOG` 冲突：该常量仅用于独立的 `sceneFeatures` 银行。该预留记录在 `pbr-flag-bits.ts` 中；材质特性常量仅在按需启用的片段中定义。Standard 拥有第 31 位，同样仅在其按需启用的片段中定义。第 28 和第 29 位仍预留给现有的矩形区域光接收与发射扩展；第 30 位属于网格不透明度。按位特性检测会保留 Standard 带符号第 31 位的数值。投影使用协变世界导数并将法线朝向眼睛定向，因此不需要坐标手性接缝。

Standard 仅在存在至少一个使用 UV 映射的表面纹理时才检测该特性：diffuse、emissive、bump、specular、ambient、lightmap 或 opacity。没有表面纹理时就没有可位移的目标，因此不会组合求解器、绑定或额外 varying。仅存在反射贴图不会激活它。

四个 `vec4<f32>` 字段描述该特性：

| 字段 | 分量 |
| ------------------ | ------------------------------------------------------ |
| `parallaxHeight` | heightScale, heightCenter, 0, 0 |
| `parallaxSampling` | minSteps, maxSteps, refinementSteps, 通道索引 0-3 |
| `parallaxUVm` | m00, m01, m10, m11 |
| `parallaxUVt` | offsetU, offsetV, 0, 0 |

PBR 将这些字段追加到其材质 UBO 中。Standard 拥有一个独立的 64 字节、片段可见的 uniform 缓冲区，并通过绑定现有的 disposer 列表释放。两者均绑定一个 `texture_2d<f32>` 与一个过滤采样器，并通过现有的 acquire/release 钩子枚举高度纹理。

公共的 `getMaterialTextures()` 枚举也会在现有槽位之后追加激活的高度纹理。PBR 即使对于仅含因子的材质也会包含它。Standard 仅在有 UV 映射表面纹理激活 POM 时才包含它，并使用与其片段检测及所有权收集器相同的特性自有访问器。省略高度缩放时两个材质族均使用默认值 `0.05`，而在零缩放或移除设置后则排除高度槽位。材质视图会枚举其源材质；共用的法线/高度贴图保留两个槽位条目而不去重。该枚举不导入任何 POM 着色器或扩展注册表。

高度纹理使用网格的第一套 UV。其矩阵遵循现有的纹理约定：

```text
c = cos(uAng); s = sin(uAng)
M = [ c*uScale, s*vScale; -s*uScale, c*vScale ]
T = [ uOffset, vOffset ]
```

高度方向遵循实际材质族的表面约定：

- PBR 在组合高度纹理矩阵时不进行 `invertY` 调整，与其普通及逐纹理变换的表面采样一致。
- 默认 Standard 复用 `writeStandardUvTransformData` 处理基础变换。这尊重 `enableStandardUvOffset()` 门控，并在材质缩放/偏移之前应用高度纹理的编解码翻转：`baseV = scaleV * (1 - v) + offsetV`。随后应用高度纹理自身的矩阵。
- 逐纹理变换的 Standard 如同其表面通道写入器一样，在高度矩阵之前无条件组合材质缩放与偏移。如果高度纹理开启了 `invertY`，则对最终矩阵的第二行取反，并将最终 V 平移替换为 `1 - translationV`。

共享写入器接受作为四个标量条目的基础变换，并在写入输出前捕获它们，从而允许 Standard 复用其现有的特性 UBO 数组作为临时存储而无需额外分配。

PBR 已携带原始 `input.uv`。Standard 新增一个 `parallaxBaseUV` varying，从现有的原始顶点 `uv` 属性赋值，避免依赖由哪个表面纹理提供其历史共享 UV 反转。

## 管线配置

扩展使用现有的材质自有着色器组合器与 `_pc` 后组合钩子。它们不改变渲染管线、目标签名、顶点缓冲区布局、光栅状态、深度状态、混合或渲染器。

前向与几何/MRT 材质视图使用相同的位移纹理坐标。几何位置、深度、速度以及现有法线贴图坐标架构建保持不变。无颜色/仅深度与 ESM 投射体视图省略求解器、额外绑定及 Standard varying：阴影投射仍基于原始网格与原始 alpha 遮罩坐标。

仅对原生 UV 映射的表面纹理采样进行变换。PBR 包括基础颜色、ORM、法线、自发光、高光/光泽度、独立遮蔽、光照贴图、清漆贴图、光泽（sheen）贴图、反射率贴图、各向异性、虹彩贴图、厚度/半透贴图及原生弯曲法线（bent normals）。Standard 包括漫反射、自发光、凹凸、高光、环境光、光照贴图与不透明度。环境/BRDF/反射贴图、屏幕空间折射、阴影贴图及任意插件自有采样器均不进行 UV 位移。

后组合器变换的是采样表达式，而非着色器声明或布局元数据。它必须能够处理嵌套的坐标表达式以及去除空白压缩后的 WGSL。布局与字段仍保持为类型化的组合器数据。

Standard 的法线辅助函数接收额外的屏幕偏移参数。仅其纹理查找发生变化；其余切线空间导数仍使用原始 UV，以保留原有的法线贴图朝向。UV 变换扩展的后组合器在视差后组合器之前运行。

Standard 几何路径的 MRT 写入在材质后组合之前，通过一个类型化着色器几何片段的 BA 槽位贡献。这使得原生高光 RGB/alpha 查找位于常规着色器组合生命周期内部，因此 UV 变换与视差都能看见它们，无需任何全局采样钩子。同一片段拥有可选的几何 UBO/varying、输出结构体以及对现有材质片段的依赖，因此它能够观测到最终颜色/alpha，无需第二个片段或采样钩子。之后仅修补其返回签名与终止 return 语句；不会在后期追加纹理查找。

## 着色器逻辑

### 方向感知投影

在光线步进之前、在统一的片段入口控制流处计算世界位置与高度 UV 的导数。透视投影使用 `eye - P` 作为视线方向。正交投影通过现有场景视图投影矩阵齐次 W 行中的零 XYZ 分量识别；其 Z 行是反向 Z（reverse-Z）深度的世界空间梯度，指向相机方向。使用该平行方向替代点到眼睛的向量，使正视角下没有横向偏移，且轴向相机移动不会改变浮雕效果。这不需要新的场景 uniform 或相机/渲染器特性钩子，并兼容现有的左/右手视图约定。

对几何法线与选定的视线向量进行归一化；对于双面表面，使法线朝向眼睛。

对于 `Px = dpdx(P)`、`Py = dpdy(P)`、法线 `N` 以及视线方向 `V`：

```text
X = cross(Py, N)
Y = cross(N, Px)
D = dot(Px, X)
A = dot(N, V)
screenRay = heightScale * [dot(V, X), dot(V, Y)] / (D * A)
heightRay = heightDx * screenRay.x + heightDy * screenRay.y
```

这种基于导数的协变标架无需网格切线即可保留非均匀世界/UV 缩放、旋转/翻转的纹理坐标以及倾斜表面。零缩放、零视线/法线长度、退化导数标架、完全正视角射线或近切线视角（`A <= 0.0001`）均返回零位移。导数标架退化检查是相对的：`abs(D) <= 0.000001 * max(dot(Px, Px), dot(Py, Py))`。

### 接触精化搜索

高度读取在每个像素上使用单一显式 mip 级别，而非梯度采样。设 `T = textureDimensions(heightTexture)`、`fx = |heightDx * T|²`、`fy = |heightDy * T|²`：

```text
lod = clamp(0.5 * log2(max(max(fx, fy) / 4, min(fx, fy))), 0, mipLevelCount - 1)
height(uv) = clamp(dot(textureSampleLevel(heightTexture, sampler, uv, lod), channelMask), 0, 1)
```

这正是 2x 各向异性过滤器会选择的级别：采样足迹的主轴在该级别上最多跨越两个纹素。因此每次步进读取都是一次单一的三线性采样，没有梯度负载也没有多点各向异性过滤；步进本身在掠射角下沿主轴遍历。通道掩码在每个像素上从 uniform 通道索引构建一次，避免了循环内的动态向量索引。

在归一化射线深度 `t` 处，使用：

```text
uv(t) = heightUV + heightRay * (heightCenter - t)
error(t) = t + height(uv(t)) - 1
rayPixels = |screenRay|
rayTexels = |heightRay * T| * 2^-lod
coarseSteps = clamp(ceil(rayTexels), 1, ceil(mix(minSteps, maxSteps, 1 - clamp(A, 0, 1))))
```

在 `t = 0` 处的第一次读取若误差非负，则为立即命中顶表面。如果 `rayPixels < 0.5`，整个视差偏移小于半个像素，直接返回该次读取的偏移受限估计值 `hitDepth = 1 - height`。否则按 `t = k / coarseSteps`（`k = 1..coarseSteps`）搜索，记录最后一个负误差采样点与第一个非负误差采样点。比所选级别单纹素更细的步长不会增加高度场细节，因此视角预算充当的是上限而非固定次数。

对首个接触区间进行二分，并复用其端点：

```text
bisections = clamp(ceil(log2(rayPixels / coarseSteps)), 0, ceil(log2(refinementSteps)))
```

精化预算 `ceil(log2(refinementSteps))` 通过整数前导零计数精确计算。一旦区间跨度不超过一个像素，二分便停止，随后对最终区间进行插值：

```text
weight = clamp(-aboveError / (belowError - aboveError), 0, 1)
hitDepth = mix(aboveDepth, belowDepth, weight)
screenOffset = screenRay * (heightCenter - hitDepth)
```

求解器最多读取 `1 + coarseSteps + ceil(log2(refinementSteps))` 次高度：默认设置下为 36 次，最大设置下为 70 次。除非跨度已不超过一个像素，否则其接触区间宽度绝不超过 `1 / (coarseSteps * refinementSteps)`。这**并不**等价于整条射线上的精细搜索：被粗搜索跨过的窄峰仍可能被漏掉，且二分收敛至首个粗区间内的某一次相交。对于尖锐/高频高度图，请提高粗步进预算。Mipmap 依然是经过过滤的高度场，而非保守可见性层级结构。

### 性能验证

该求解器是通过对实际 WGSL 辅助函数进行相对 WebGPU 时间戳查询 A/B 微基准测试选出的，而非依赖帧捕获：在 NVIDIA RTX 5070 Ti 上每个 pass 执行 4 次全屏 2560x1440 绘制、取 7 个 pass 的中位数，涵盖两个 Scene 349 Playground 资产、正面/45°/70° 视角、深度 0.03/0.06/0.16 以及 Low/Medium/High 预算（共 54 种配置）。先前设计（4x 各向异性梯度读取、基于角度的固定粗步数及线性精化）在表面采样基准之上累计产生 9.39 ms 的 POM 开销；本设计仅耗时 3.34 ms（降低至 1/2.8）。各配置开销中位数在正面视角下降 2.2 倍、45° 视角下降 1.8 倍、70° 视角下降 3.1 倍，掠射角 High 配置最高下降 8.1 倍；在深浮雕的 Low 预算下（本就几乎没有可削减的读取）则在噪声范围内保持不变。采用相同步进逻辑时，70° 下 4x 各向异性 `textureSampleGrad` 读取的开销是单级别读取的 1.5-1.9 倍。

对照 45° 与 70° Medium/High 配置的 4x4 超采样密集参考，本设计的最终颜色 RMSE 为 12.70 个 8-bit 色阶（先前设计为 12.79），偏差超过 16 个色阶的像素占比为 17.3%（先前为 16.8%）。4x 各向异性级别规则达到了更低的 12.38 RMSE，但大误差像素更多（17.9%）且开销增加 10%，因此保留了 2x 规则。

### 表面纹理采样

对于每个受影响、具有现有坐标 `uv` 的表面查找：

```text
dx = dpdx(uv); dy = dpdy(uv)
displacedUV = uv + dx * screenOffset.x + dy * screenOffset.y
textureSampleGrad(texture, sampler, displacedUV, dx, dy)
```

每个通道保留各自的 UV 集、变换、朝向及梯度。复用原始梯度可避免从不连续的射线交点推导 mip/各向异性足迹。辅助函数绝不对光线步进结果求导，也绝不在发散搜索内部使用隐式导数采样。

## 状态机 / 生命周期

1. setter 校验/拷贝设置并注册所属扩展。
2. 材质特性检测仅选中匹配的材质。
3. 首次可渲染对象构建时，通过正常材质生命周期钩子组合/缓存匹配的着色器，并绑定 uniform 与高度纹理。
4. 现有几何视图继承源设置但保留网格深度输出；投射体视图抑制视差着色器/绑定贡献。
5. 重建会应用更改或移除效果。旧的可渲染对象资源通过现有所有权释放高度纹理引用与 Standard UBO。
6. 设备恢复/重建复用现有的纹理/uniform 缓冲区恢复机制；不存在特性自有的设备缓存或场景引用。

## Babylon.js 等价映射

此特性增加了独立规范化的视差遮蔽贴图，而非对 Babylon.js `useParallaxOcclusion` 着色器进行像素级移植。在未显式调用 setter 时，原生 PBR/Standard 行为与 bundle 必须保持不变。法线贴图、UV 约定、材质视图及纹理所有权均复用 Lite 的现有契约。

## 依赖项

公共属性仅依赖 `Texture2D` 类型。setter 依赖各自材质族的扩展注册表及共享校验模块。片段依赖类型化着色器片段契约、共享 WGSL/投影/后组合辅助函数以及现有纹理/uniform 所有权。不需要任何渲染器、加载器、外部着色器包、预计算锥形图或引擎特性标志。

## 测试规范

- 在修改状态/注册之前，校验公共默认值、拷贝设置、null/零缩放移除、全部四个通道、无效数值范围、线性/sRGB-alpha 规则以及无效纹理类型。
- 验证两个材质族的前向与几何组合、原生可选通道、UV1/UV2、变换后的 UV、法线贴图及生产压缩源码。确保 BRDF、环境、屏幕空间与阴影采样器保持未受影响。
- 验证无颜色/ESM 变体省略视差代码/绑定，且 Standard UBO 销毁与纹理 acquire/release 枚举保持平衡。
- 验证两个材质族在使用独立高度贴图、默认/显式/零缩放、材质视图及共用法线/高度槽位时的公共纹理枚举。覆盖仅含因子的 PBR 以及无 UV 映射表面纹理的未激活 Standard 材质（包括仅反射材质）。仅导入 `getMaterialTextures` 不得保留 POM 着色器或扩展。
- 针对编解码翻转纹理、非整数缩放/偏移与旋转、默认与变换路径以及缺失/存在的 Standard 偏移启用器，将高度 UV 与实际 PBR/Standard 表面 UBO 写入器进行比对。
- 将原生弯曲法线（bent normals）与所有受支持的法线标架变体进行组合，并验证其查找同样发生位移。
- 编译带有变换凹凸/反射率采样且同时输出几何法线/速度的 Standard POM，保留上一帧姿态绑定及未位移的几何速度。
- 数值检验离轴正交正视角以及正视角/斜视角轴向相机移动不变性，并覆盖透视用例。
- 对于经过滤的斜坡/山脊，在实际查找坐标处测量设备采样器相对理想高度场的误差，要求保持在一个 8-bit 编码高度单位以内，并将其传播至参考射线的接触方程。保留现有的求解器/精化容差及精确采样次数上限，而非放宽全局 UV 容差。仅限测试的 FP16 采样用例必须能够复现旧理想过滤器断言的失败，同时满足该实测不确定性模型。生产着色器采样保持不变。
- 在 WebGPU 上编译实际组合的顶点/片段着色器，无需截图。针对常量与线性斜坡高度场、中心/缩放/视线方向用例、变换后的高度 UV、有界采样次数及有限退化输入行为执行数值着色器预言机（oracle）。
- 断言精确的高度读取次数（其中零高度场会强制完整步进）：顶面命中、亚半像素单次读取、纹素上限、相对单层纹理的 mip 级别选择、三个视角下的角度预算、精化预算以及在不重新采样端点的情况下进行二分的底面命中。
- 对于具有多个射线交点的非线性山脊，与独立密集搜索参考进行比对，验证首次接触、精化误差界限以及相较于仅粗插值的精度提升。显式验证精化无法找回被粗搜索漏掉的山脊。
- 验证发布包的根导出/tree-shaking，以及未使用的另一材质族片段不存在。
- 将非视觉运行时 bundle 字节数与同步后的公共 master 提交的已发布基线进行比较，而不仅限于对比场景上限。先从 scene1/scene282/scene145 开始，仅在明确要求时扩展到全部场景。保留所有现有上限。

场景打包器保持标识符缓存为 chunk 局部，仅共享属性缓存。它从 Rolldown 已分配的短 ESM 导出名中为局部标识符名称做种子，从而避免冗余的 `local as export` 别名。这防止生成名变化为无关场景每个可避免别名增加 5 字节。打包工具测试覆盖绑定冲突、同一绑定的多个导出名、命名空间访问及跨 chunk 属性一致性。

对于这项独立特性，用户已明确授权使用数学/着色器/非视觉验证替代不可用的 Spector.GPU 捕获。视觉/对等性与性能验证仍由用户/CI 负责；不更改任何基准图或上限。

现有的 WebGPU 集成 CI 作业会显式选择 `parallax-occlusion.spec.ts`，以及两个点泼溅（point-splatting）测试与 SSAO 深度有效性检查。它编译实际压缩后的材质/几何/投射体着色器并执行数值高度场回读；截图、视频、trace 与性能运行在该作业中保持禁用。基于图像的比对/UI 测试与该数值/管线测试集相互独立。

## 文件清单

- `material/parallax/parallax-occlusion.ts`：属性、校验、uniform 写入与特性自有的高度纹理访问器。
- `material/parallax/parallax-occlusion-wgsl.ts`：共享 WGSL 求解器与采样器。
- `material/parallax/parallax-occlusion-shader.ts`：着色器采样变换。
- `material/pbr/set-parallax-occlusion.ts`：公共 PBR setter。
- `material/pbr/fragments/parallax-occlusion-fragment.ts`：PBR 扩展。
- `material/standard/set-std-parallax-occlusion.ts`：公共 Standard setter。
- `material/standard/fragments/std-parallax-occlusion-fragment.ts`：Standard 扩展。
- 现有材质类型模块及包根 `index.ts`：类型化状态与导出。
- `material/material-textures.ts`：激活高度槽位的公共枚举。
- 专项单元/构建测试：API、组合、生命周期、GPU 预言机、tree-shaking。

## Lab 比对：Scene 349

Scene 349 将现有独立实现的 Lite 求解器与 Babylon.js **原生**的 `useParallax` + `useParallaxOcclusion` 进行对比，而非替换成自定义 Babylon.js 着色器或修改 Lite 求解器去匹配它。用户明确选择了视觉/行为比对，而非像素级对等。

匹配页面为 `/scene349.html` 与 `/babylon-ref-scene349.html`。`/lite/compare-scene349.html` 以相同设置嵌入两者并在两个画布间转发轨道/缩放状态。仅接收来自已知对等帧或父帧的同源消息；相机数值必须有限且位于场景正面朝向的轨道限制之内。两个渲染器均不为此 UI 暴露 GPU 句柄或引擎实例。

控件就地更新这些持久场景：无论是工具栏变更还是滑块输入，都不会导航页面、替换画布或重新赋值 iframe 的 `src`。URL 通过 `history.replaceState` 保持可分享性。内嵌深度（inset）滑块在拖动时使用 `input` 事件，并合并到动画帧执行。每个渲染器串行化异步更新并仅保留最新待定设置，使纹理加载与材质重建不会产生竞态。

比对页面通过同源消息向两个已知帧窗口发送经过校验的设置查询。当帧完成初始加载时，就绪握手会重新应用最新控件。已应用/错误回复使更新状态可观测并呈现失败信息，而非静默重置场景。独立页面直接使用同一更新器。

启动与实时失败使用相同的 `reportScene349Error` 报告器：记录画布错误、显示无障碍状态、打印原因并通知比对父页面。lab 加载器接收携带字符串消息的 `scene-load-error` 自定义事件，停止其就绪轮询/观察器，并将加载动画替换为错误展示。比对状态保留两个渲染器各自的错误；成功更新仅清除对应渲染器的错误。无效的比对 URL 会在任何渲染器启动前即被报告。

显式切换视角预设会更新相机角度/半径；其余所有设置均保留当前自定义轨道与缩放。资产对会被缓存以便后续切换。Babylon.js 修改其现有材质属性，并仅在纹理或特性状态变化时等待就绪。Lite 对现有的 PBR 视差标量/质量 uniform 使用 `markMaterialUboDirty`，对 Standard 独立特性 UBO 使用 `rebuildMaterial`，并在纹理或 POM/零深度特性状态变化时重建相应的可渲染对象。相机、场景、设备、网格与材质实例均保持存活。无需任何核心渲染器接缝或着色器算法更改。

两个场景均包含四个朝向 -Z 方向的 2.4 单位正方形平面，中心位于 `(-1.35, 1.35, 0)`、`(1.35, 1.35, 0)`、`(-1.35, -1.35, 0)` 与 `(1.35, -1.35, 0)`。Standard 材质位于顶行，PBR 位于底行。左列为未位移的法线贴图对照；仅右列启用 POM。两个引擎使用来自 [Babylon Playground 10I31V 第 408 版](https://playground.babylonjs.com/#10I31V#408) 的完全相同资产：

| 资产 | 漫反射（Diffuse） | 法线 RGB + 高度 A |
| --------------- | ------------------------------------------- | ------------------------------------------- |
| Stone（默认） | `https://i.imgur.com/VSbN3Fc.png` (256x256) | `https://i.imgur.com/zVGaZNi.png` (256x256) |
| Brick wall | `https://i.imgur.com/Rkh1uFK.png` (512x512) | `https://i.imgur.com/GtIUsWW.png` (256x256) |

图像直接从原始 URL 加载，不重新生成也不转存。所有场景/参考/比对入口页面均设置 `no-referrer` 策略：Imgur 对带有 localhost referrer 的请求返回 HTTP 403，但在省略 referrer 时会正常返回原始 PNG。保留原始创作的法线 RGB 与 alpha 高度；移除先前的程序化纹理与平面/烘焙倒角变体。Stone/Wall 选择器可同时切换两个渲染器。现有的轨道、POM、深度及 Lite 质量控件继续可用。

两个加载器均采用既定的光栅上传 Y 翻转、重复寻址、线性/三线性过滤、mipmap 以及 4 倍各向异性。法线/高度数据为线性且不得进行 alpha 预乘。漫反射值保留其原始 gamma 编码供 Standard 着色使用；PBR 启用匹配的 gamma-2.2 反照率解码（Lite 中为 `setPbrGammaAlbedo`，Babylon.js 中为 `gammaSpace = true`）。两个纹理均会等待加载完成，加载错误保持显式可见。

设置支持 URL 参数寻址并由两个引擎共享：

| 查询参数 | 默认值 | 支持的值 |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pom` | `on` | `on`、`off`；仅控制右列 |
| `depth` | `0.06` | `[0, 0.16]` 内的有限 UV 空间内嵌深度比 |
| `view` | `grazing` | `front`、`oblique`、`grazing` 相机预设 |
| `asset` | `stone` | `stone`、`wall`；选择原始漫反射/法线-高度纹理对 |
| `quality` | `medium` | 仅限 Lite 的 `low` (4/8/4)、`medium` (8/32/8)、`high` (16/64/16) 正视/掠射粗步进预算及精化细分 |
| `embed` | off | `1` 隐藏独立工具栏以便比对/截图 |

在每个正方形平面 UV 重复 1 次的前提下，Lite 的 `heightScale` 为 `2.4 * depth`，`heightCenter = 0`，`heightChannel = "a"`。Babylon.js 的左手系原生 POM 使用 `parallaxScaleBias = depth`，与 Playground 保持相同的正号。此前的负号参考偏移反转了表观浮雕；那是场景配置错误，而非应由对等容差掩盖的差异。UI 会同时显示两个数值，而非假装它们具有相同单位。Babylon.js 原生的固定循环/采样选择与隐式纹理导数保持不变。其输出可能与 Lite 的接触精化、显式 mip 选择以及几何世界空间投影有所不同，尤其在较粗设置与掠射角下。由于 Lite 的预算是上限，当射线跨越的纹素少于 Medium 预算时，Medium 与 High 的结果一致。

一项限定范围的回归测试会在原始资产 URL 处替换为 UV 渐变颜色纹理与带有恒定 alpha 高度的平坦法线贴图。在正面视角相机与正深度下，两个引擎中右列 Standard 与 PBR 中心采样点必须沿相同的实测 UV 方向移动。检查有符号的红/绿通道变化，而不只是 POM 开关差异幅度，可在不要求像素级一致步进算法的前提下捕获反转偏移错误。

场景使用一盏平行光与半球环境补光，无 IBL、无色调映射、相同的清除色、相机近/远裁剪面/FOV 以及匹配的纹理资产/过滤设置。轨道/缩放可交互；禁用平移以使同步拥有固定目标。窗口大小调整行为保持引擎原生。

实时更新控制器在失败时保留上一次成功应用的设置。当存在错误时再次请求该同一选择仍会重新应用并发布它，从而在不重新加载任一文档的情况下于恢复后清除渲染器及比对页面错误。

新的 BJS 基准图及其 1280x720 JPG 缩略图从 Grazing 嵌入视图（`?embed=1&view=grazing`）捕获一次，与交互默认视图一致，以便更清晰地展示浮雕效果。已保存参考的比对测试显式选择 Grazing 并校验其实际相机姿态。这些属于视觉比对资产，并非对 POM 像素等价性的声明。`scene-config.json` 以明确原因将严格像素对等标记为跳过，而场景专用浏览器测试仍验证两个页面均正常渲染、两个材质族均响应 POM/深度、控件未被遮挡位移、设置应用一致以及比对相机保持同步。该测试绝不会重新生成基准图。截图比对产出供人工检视的产物，而非使用宽松的 MAD 阈值去掩盖算法差异。

Vite 现有的 HTML 入口发现机制会自动识别新场景/参考/比对页面。画廊与参数化 bundle 体积测试会从 `scene-config.json` 读取场景卡片/上限；无需硬编码场景注册。BJS bundle 发现机制使用现有的 `bjsSceneEntry` 解析器，而非假定迁移前的 `lab/src/bjs` 目录，因此新的打包参考同样适用于 `lab/lite/src/bjs`。仅构建/测量 Scene 349 的 Lite 与 BJS bundle。BJS 打包尊重上游包的 `sideEffects` 元数据：将所有模块覆写为无副作用会移除必需的原始纹理原型、着色器/include 注册以及文件加载支持，导致新参考无法渲染。这不会改变 Lite 打包方式，也不会在无关场景中保留任何新增引擎字节。截图前会等待 Lite 的加载遮罩淡出完成；仅凭 `ready` 不足以避免合成半透明遮罩。

附加文件：

- `lab/lite/src/shared/scene349-parallax.ts`：常量、设置及原始 Playground 资产 URL。
- `lab/lite/src/shared/scene349-parallax-ui.ts`：独立控件与有界相机同步。
- `lab/lite/src/lite/scene349.ts`：Lite PBR/Standard 按需启用配置。
- `lab/lite/src/bjs/scene349.ts`：原生 Babylon.js PBR/Standard POM 配置。
- `lab/lite/src/scene349-comparison.ts`：同步双栏比对页面。
- `lab/lite/scene349.html`、`lab/lite/babylon-ref-scene349.html`、`lab/lite/compare-scene349.html`、`lab/lite/bundle-scene349.html`、`lab/lite/bundle-bjs-scene349.html`、`lab/lite/scene349.css`：源码/参考/比对/生产入口页面及共享 UI 样式。
- `tests/lite/parity/scenes/scene349-parallax-occlusion.spec.ts`：限定范围的行为/渲染比对。
- `tests/lite/integration/scene349-comparison.spec.ts`：两种原生算法的 POM/深度行为、原始资产选择及双向相机同步。
- `tests/lite/integration/scene349-errors.spec.ts`：可见的源码/生产/比对启动错误、联合渲染器失败报告以及仅清除成功渲染器错误的恢复测试，不含截图。
- `tests/lite/unit/scene349-parallax.test.ts`：确定性输入/设置测试。

实时控件回归测试会保留文档/画布标识，统计文档请求与设备创建次数，并在拖动深度滑块以及更改质量、POM 和资产时检查实际渲染变化。测试断言非视角变更后自定义相机姿态得以保留、快速连续输入稳定到最新设置、以及显式预设仍能同步。这些测试不刷新已保存的参考、不修改现有上限、不运行耗时基准测试，也不将验证扩展到其他场景。
