# 模块：矩形面光源（Rectangular area lights）

> 包路径：`packages/babylon-lite/src/light/`，材质侧扩展位于 `src/material/{pbr,standard}/fragments/`。

## 目的

可选启用的单面矩形面光源（支持可选纹理贴图），精确采用 Babylon.js 的 LTC 查找表与光照方程。不使用点光源替代、自定义烘焙 LUT、光度学换算或面阴影贴图。灯光对象对场景和 GPU 资源一无所知。

本规范编写于实现之前。源码审查涵盖 Babylon.js PR [16078](https://github.com/BabylonJS/Babylon.js/pull/16078)、[16123](https://github.com/BabylonJS/Babylon.js/pull/16123)、[16577](https://github.com/BabylonJS/Babylon.js/pull/16577)、[16723](https://github.com/BabylonJS/Babylon.js/pull/16723) 和 [18605](https://github.com/BabylonJS/Babylon.js/pull/18605)。当前环境中 Spector.GPU 不可用：因此由源码推导的数学公式与专项测试并不声称为真实 GPU 抓帧结果。新场景的视觉验证属于集成测试职责。

## 公共 API 接口

所有导出均来自现有的包根入口：

```typescript
interface RectAreaLight extends LightBase {
    readonly lightType: "rectArea";
    width: number;
    height: number;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    emissionTexture: Texture2D | null;
}
function createRectAreaLight(position: [number, number, number], width: number, height: number, intensity?: number): RectAreaLight;
function enableRectAreaLights(scene: SceneContext): Promise<void>;
function processAreaLightTexture(engine: EngineContext, source: Texture2D): Promise<Texture2D>;
```

默认值：漫反射/镜面反射颜色为白色，强度为 1。宽高尺寸必须为有限的非负数；为零时不产生光照贡献。强度必须为有限的非负数。位置使用常规 `SceneNode` 局部坐标。发射方向沿**局部 -Z**。旋转、四元数、缩放、父子层级、可见性、元数据以及网格包含/排除列表均为常规 `SceneNode`/`LightBase` 状态。尺寸、强度和颜色的修改（包括对元组元素的写入）都会递增灯光版本号。

```typescript
const light = createRectAreaLight([0, 3, 0], 4, 2, 1);
light.rotation.x = Math.PI / 2;
addToScene(scene, light);
await enableRectAreaLights(scene);
await registerScene(scene);
```

请在注册场景之前启用，即使首个面光源会在之后才添加到场景中。Promise 会在完成经过校验的 LUT 解码、当前设备纹理上传以及材质扩展注册后兑现。若发生网络、HTTP、载荷、上传、加载期间销毁或不支持的光照错误，Promise 将被拒绝。重复或并发调用启用函数是幂等的。当设备替换发生后，材质组准备阶段会针对替换设备重新校验并上传资源。

`StandardMaterialProps.roughness?: number` 提供 LTC 粗糙度（默认 0），独立于 Blinn-Phong 的 `specularPower`。普通的非面光源 Standard 光照保持不变。

## 内部架构与内存布局

每个灯光保持现有的四个 vec4 **64 字节**条目以及现有可配置的 `MAX_LIGHTS` 容量。在浮点偏移 `o` 处：

| 条目                       | 数值                                   |
| -------------------------- | -------------------------------------- |
| `data` / `o..o+3`          | 世界中心 X, Y, Z, 类型 **4**           |
| `diffuse` / `o+4..o+7`     | 漫反射 RGB × 强度, 半宽 X              |
| `specular` / `o+8..o+11`   | 镜面反射 RGB × 强度, 半宽 Y            |
| `direction` / `o+12..o+15` | 半宽 Z, 半高 X, Y, Z                   |

对于列主序世界矩阵 W，中心为 `W[12..14]`；半宽为 `(W[0],W[1],W[2]) × width/2`；半高为 `(W[4],W[5],W[6]) × height/2`。切勿对任一轴进行归一化：非均匀缩放、父级旋转和剪切变换必须影响四边形几何形态。镜像变换遵循变换后的顶点绕序。浮动原点路径可以仅从中心点减去当前相机偏移。

工厂函数会安装标准的 `_cloneNode` 回调。`cloneTransformNode(source: SceneNode): SceneNode` 针对特化节点调用该回调并深克隆子节点。克隆体会先根据实际的局部位置、宽度、高度和强度重建，再复制通用的变换/过滤状态。颜色元组在追踪前会拷贝调用方输入，使克隆体之间彼此独立。发射图像包装器由灯光克隆体借用/共享，而不会获取场景专有的资源所有权。被克隆的子树会将每个克隆子节点重新挂载到其克隆父节点下；单独克隆的节点没有父节点。Lite 中不存在针对此功能的场景序列化框架；也不额外发明序列化器。通过保留状态并直接使用强度值，避免了 PR18605 中的位置回归与零光度学缩放回归。

### 可选材质接缝

一个内部的、强类型的、由场景拥有的光照贡献对象负责承载准备工作、单光源源码解析、多光源源码解析、场景特性位、Standard 着色器上下文以及节点校验。通用模块仅调用此可选接缝或传输其不透明数据；它们从不比较面光源类型、解码坐标轴、拉取 LTC 数据或导入面光源模块。

PBR 通过单光源选择路径保留真实的 `lightType`。在回退到现有的动态单光源导入之前，会先解析可选源码。混合光照使用显式 WGSL 注入参数来增强现有的精确光源循环，而不是对已生成的 WGSL 做文本解析/替换。由功能模块拥有的包装器会为面光源返回中性别名，使普通精确光源辅助函数绝不会将打包的半轴误解为照射范围或圆锥角值。已注册的 `PbrExt` 共同拥有共享的 LTC 辅助函数以及全部纹理/采样器声明，并由场景特性位 `1<<6` 与非零光照模式共同门控。资源准备复用现有的、会被 await 的 `_registerPbrSceneHook` 注册表：该钩子以功能模块的场景所有权 WeakMap 为门控，并在材质组合/绑定之前准备好当前设备的 LTC 资源。无需额外增加通用的 PBR 准备调用。

场景中由功能模块拥有的 `_pbrFeatures(meshId)` 解析器同样仅当某个面光源属于该网格的实际选择集合时才返回场景位 `1<<7`。它镜像了打包灯光上限、跳过没有写入器的灯光，并使用与网格灯光打包完全相同的包含/排除谓词。只有这个“已选面光源位”才会触发对分层 BRDF 的拒绝；仅仅启用面光源支持，或将某个面光源从分层精确光源接收体中排除，不得拒绝该材质。前向和几何 PBR 构建器会传入已经计算好的网格 ID 标量，在组合前合并该不透明贡献，并将其纳入缓存键。它们绝不解析这些位，也不接收任何材质/网格分支门控对象。

Standard 通过其场景着色器上下文提供由功能模块拥有的光照函数。它通过显式的额外提前返回代码块复用普通的 Standard 函数。其 `StdExt` 声明 LTC 绑定/辅助函数，并通过可选的材质 UBO 写入器将粗糙度写入现有的材质第 22 个浮点数（`mat._0`）。材质位 `1<<28` 门控该扩展；Standard 场景位 `1<<1` 区分缓存变体，并与雾效位 `1<<0` 组合。异步组构建器会 await 可选的场景准备回调。特性位仅在延迟加载的功能模块中声明，并在共享标志文件中保留注释占位。

前向构建器和 `createStandardGeometryMaterialView` 构建器都会在枚举扩展和构造缓存键之前合并 `_materialFeatures`。即使几何输出的颜色未被使用，它仍会复用 Standard 光照代码，因此同样需要匹配的 LTC 辅助函数、声明和绑定条目。`enableMaterialTracking(material)` 会追踪可选的 Standard 粗糙度（即使其初始值为 `undefined`）；赋值操作会递增源 `_uboVersion` 并更新前向与几何材质 UBO 中的第 22 个浮点数。

节点光照会在场景构建期间进行显式校验。初始实现会在启用了面光源且包含面光源的场景中拒绝节点光照块，而不是静默地将类型 4 当作点光源解释。无光照节点图依然受支持。完整的 Node/PBR-MR LTC 组合留待后续扩展；共享辅助函数/绑定布局依然适用于未来的该项扩展。

## 管线配置

不改变顶点阶段、光栅化、拓扑结构、深度、混合、渲染通道或场景灯光布局。现有材质管线继续拥有各自的着色器。每个活跃的面光源材质扩展会在片元阶段贡献两个 `texture_2d<f32>` 绑定和两个过滤采样器。绑定描述符顺序与条目顺序完全一致：先是 LTC1 纹理/采样器，接着是 LTC2 纹理/采样器。绑定与辅助函数作为同一个片元发射，从而避免 PR16577 中缺少 NME 采样器的回归问题。

LUT 纹理为 64×64、单级 mip、`rgba16float` 格式、`TEXTURE_BINDING | COPY_DST` 用途，采用线性 min/mag 过滤和 U/V/W clamp-to-edge 寻址。不进行翻转、Gamma 转换、mip 生成或 Float32 扩展。上传采用每行 512 字节、共 64 行。

## 着色器逻辑

从打包的六个标量重建坐标轴 A 和 B。按顺序，四个角点分别为 `C+A-B`、`C-A-B`、`C-A+B`、`C+A+B`。它们的叉积指向局部 -Z。当 `dot(cross(corner1-corner0,corner3-corner0),P-corner0)<0` 时剔除背面。退化坍缩的坐标轴返回零。

使用从表面指向观察点的归一化向量 `V` 和材质扰动后的单位法线 `N`。查找 UV 为 `(roughness,sqrt(1-clamp(dot(N,V),0,1))) × 63/64 + 0.5/64`。在 mip 0 级采样 t1/t2。逆 LTC 矩阵的各列为 `(t1.x,0,t1.y)`、`(0,1,0)`、`(t1.z,0,t1.w)`。

由 `V-N*dot(V,N)` 构造切线 `T1`，并令 `T2=-cross(N,T1)`，保留 Babylon 的手性约定。在完全法线视角下，选择一个确定性的垂直切线而不是对零向量归一化。这是连续的各向同性极限，而非替代 BRDF。将每个角点差向量乘以 `inverseLtc × transpose(mat3(T1,T2,N))`，然后归一化。

对于归一化边向量 u、v，令 `x=dot(u,v)` 且 `y=abs(x)`。形状因子为：

```text
a = 0.8543985 + (0.4965155 + 0.0145206*y)*y
b = 3.4175940 + (4.1616724 + y)*y
q = a/b
k = x>0 ? q : 0.5/sqrt(max(1-x*x,1e-8))-q
edge = cross(u,v)*k
```

将四条边的向量求和得到 f。地平线裁剪后的标量形状因子为 `max((dot(f,f)+f.z)/(length(f)+1),0)`。这是 Babylon 指定的 LTC 近似算法，使用完全相同的系数和纹理，而非新引入的近似。分别使用 LTC 矩阵求值一次（S），以及使用单位矩阵求值一次（D）。

PBR 使用现有材质工作流中已计算好的 `surfaceAlbedo` 和 `colorF0`/`colorF90`：

```text
diffuse += surfaceAlbedo * light.diffuse.rgb * D * material.directIntensity
F = colorF0 * light.specular.rgb * t2.x
  + (1-light.specular.rgb) * t2.y * colorF90
specular += light.specular.rgb * F * S * material.directIntensity
```

不额外应用 `1/PI`、平方反比衰减、精确光源的 NdotL 或光度学缩放。这里重复乘以镜面反射颜色是有意复现 Babylon PR16723 的行为，包括在强度大于 1 时的表现。Standard 使用 `F=light.specular.rgb*t2.x+(1-light.specular.rgb)*t2.y`，返回 `light.diffuse.rgb*D` 和 `light.specular.rgb*F*S`，并保留材质现有的最终漫反射限幅/反照率/镜面反射颜色乘法。

初始的 PBR 面光源路径涵盖普通的金属-粗糙度（metallic-roughness）与镜面-光泽度（specular-glossiness）表面漫反射/镜面反射。当与面光源一起使用时，可选的分层直接光照 BRDF 会被显式拒绝而非近似计算。

## 状态机与生命周期

CPU 载荷缓存是惰性的：共享同一个飞行中的网络请求，在成功后保留解码得到的 `Uint16Array`，并在请求被拒绝时移除缓存条目以便重试。读取前校验**长度恰好为 65,536 字节**。使用 `DataView` 按小端序读取字（word）。对于纹素 `i` 和通道 `c`，LTC1 的字位于 `input[i*8+c]`，LTC2 位于 `input[i*8+4+c]`。保留原始半精度浮点比特位，包括带符号与次正规编码。

GPU 资源也是惰性的：按 `GPUDevice` 缓存，并由启用的场景通过引用所有权持有。使用现有的纹理获取/释放与采样器池。使用缓存的视图前必须检查设备标识。场景在任何 `await` 之前注册一个幂等的销毁闭包；如果场景在加载期间销毁，则不会安装任何句柄。当设备变更时，释放旧分配的所有权并获取替换设备上的资源。最后一次释放会销毁两张纹理并移除该缓存条目；其他场景保留各自的所有权。部分上传失败会销毁已分配的纹理并抛出错误。每次分配都携带一个用于 WebGPU 验证错误作用域的就绪 Promise；验证失败会拒绝准备流程并释放所有等待中场景的分配声明。在该 Promise 期间销毁场景会销毁其所有权并导致准备流程被拒绝。在验证期间发生设备替换则会针对替换设备重试准备流程。不暴露任何公共 GPU 句柄，无顶层 Map/WeakMap 分配，也无导入时注册行为。

不支持面光源阴影。包含面光源的场景会拒绝节点光照。只有当为某网格选中了面光源时，才会拒绝分层 PBR 直接光照 BRDF。错误信息均具备可操作性。任意自定义 `ShaderMaterial` 代码仍由调用方自行管理。变更场景光照拓扑需要走现有的场景重建/注册路径。当引擎设备变化时，材质组准备阶段会替换特定于设备的 LTC 分配；跨设备替换不存在任何有效的旧绑定组。

## 纹理化发射规范

### 预处理、朝向与所有权

`processAreaLightTexture(engine, source)` 是独立、异步、无场景依赖且从根入口导出的函数。它接收位于引擎当前设备上的、存活的、单采样的、可采样的彩色 `Texture2D`。深度纹理、整数格式、不可过滤格式、数组/3D 纹理、异常尺寸、已释放资源以及错误设备上的资源均会显式拒绝。普通光栅纹理应使用 `srgb:false`：Babylon 的预处理在采样得到的 RGB 字节域中进行，不进行额外的 Gamma 转换。不应用源 UV 变换，与上游全屏处理器一致。对于原点在顶部的编解码/像素来源，会遵循 `invertY`；常规的光栅上传翻转已经提供了 Babylon Y 轴向上的纹素。

创建一个 1024×1024 的 `rgba8unorm` 渲染附件，具备 `COPY_SRC | COPY_DST | TEXTURE_BINDING` 用途和 11 级 mip。绘制一个全屏三角形，使其存储第 0 行采样 Y 轴向上的源纹理 V=0，使用 UV `(uv-0.125)/0.75`、镜像重复（mirror-repeat）的 U/V 寻址模式，并通过像素导数隐式计算源纹理 LOD。保留源纹理池化的 min/mag/mip/各向异性设置；普通光栅源为三线性过滤。现有采样器池的规范描述符键直接提供这些设置，无需第二个常驻元数据缓存；未知采样器则回退为三线性过滤。这会产生与上游特效渲染接原始纹理更新完全一致的朝向：处理后的存储行直接被采样，LTC 辅助函数中无需额外执行 V 翻转。处理器自行拥有其采样器，而非修改源对象的任何字段。

通过 `MAP_READ` 暂存缓冲区读回缩放后的第 0 级字节。对于每个输出像素 `(x,y)`，外部距离为 `max(128-x,128-y,x-896,y-896,0)`。可分离高斯核的长度为 `7+2*distance`，sigma 为 `length/4`，半长为 `floor(length/2)`。在双精度下计算每个指数项并存入 Float32，将原始双精度值求和，再将已存储的 Float32 系数除以该总和并存回 Float32。每个轴都在双精度下对 RGB 进行卷积，用 `Math.round` 四舍五入到最近字节，限幅到 `[0,255]`，并原样复制 Alpha 通道。超出边界时围绕边界纹素中心反射索引（小于零为 `-i`，大于 1023 为 `2046-i`）。第二轴读取第一轴四舍五入后的字节。上传最终字节并使用现有的 GPU mipmap 位块传输器生成完整 mip 链。返回的采样器采用线性 min/mag/mip 过滤与 clamp-to-edge 寻址。

源纹理的所有权仍归调用方所有。源纹理仅在同步缩放提交阶段（位于处理器的首个 await 之前）被借用；WebGPU 会为该已提交工作保留资源引用。处理器不会创建任何可能被设备恢复错误迁移到替换门面（facade）上的临时普通所有权声明。它会快照源分配信息，并在任意 await 期间若该分配被释放或门面/设备被替换时直接拒绝，而不会释放或触碰替换资源。完成后不保留任何源对象、GPU 管线、卷积核库或 Promise。返回的包装器持有一个普通的调用方引用（`releaseTexture(result)`）；它具有由 `cloneTexture2D` 共享的内部设备溯源与已处理图像标识。赋值与灯光克隆体仅借用/共享该包装器，从不获取或释放 GPU 资源。场景准备阶段会获取其快照中已处理图像的引用，因此调用方在启用成功后可以释放其持有的结果引用。在启用前释放或赋值一个未经过处理的普通纹理都会报出可操作的错误。在 await 期间销毁源纹理的最后一个调用方引用声明会拒绝本次操作，而非发布一个被遗弃的结果。在预处理期间发生设备替换也会拒绝操作并清理暂存区/部分输出；请在新设备上重新处理。WebGPU 验证错误、回读失败以及上传失败均会拒绝。没有任何新的公共 API 暴露原始 GPU 句柄。

### 紧凑绑定与同步

成功预处理会安装一个模块局部的准备接缝；只有场景启用器会调用它。当未使用预处理时，setter、准备接缝以及完整的发射导入图谱都会从纯色面光源消费者中 tree-shake 掉。延迟场景搭建逻辑会检测是否存在打包的发射贴图，并仅在存在此类贴图时才动态导入纹理化运行时/材质模块。赋值未经预处理的普通纹理会在启用阶段被拒绝，而不会静默降级为纯色着色器。纯色面光源场景绝不会加载预处理或发射采样模块。它们保留原有的着色器、四个 LTC 绑定以及 64 字节灯光条目。

发射运行时持有一个场景快照：当前 `GPUDevice`、打包灯光标识（仅包含有写入器的灯光，上限为 `MAX_LIGHTS`）、去重后的已处理 `GPUTexture` 图像、一个紧凑的 1024×1024×N 2D 纹理数组（含 11 级 mip）以及一个映射 uniform。将每张已处理图像的所有 mip 级别直接复制到各自独立的数组层中；不进行重采样或修改采样器。共享同一图像的多个包装器共享同一数组层；位于相同灯光位置的不同图像仍各自占用不同层。映射按打包后的场景槽位索引，而不是按网格选择顺序、世界位置或可变的逐灯光场景字段。槽位映射到 `layer+1`，其中 0 表示纯色/精确光源。该 uniform 是一个 `vec4<u32>` 数组，填充对齐到 `ceil(MAX_LIGHTS/4)` 个向量。选定的单光源和多光源着色器使用现有的 `mli` 打包索引来解析它，因此过滤器和槽位顺序变更依然保持正确。

快照同时捕获当前活跃的灯光容量和打包列表。即使灯光标识和图像未变，容量变化也会使分配复用失效，包括在相同填充向量数量内的容量变化。根据捕获到的容量分配映射缓冲区，并在材质组合时生成其 WGSL 声明，绝不在模块导入时生成。因此，初始以 16 启用、随后在首次管线编译前由 glTF 自动提升容量的场景，能够正常支持位于打包槽位 16 及之后的纹理化发射体。在异步上传期间发生容量变化会拒绝操作并清理候选资源；绑定为不同当前容量准备的快照会拒绝并报出需要启用/重建的诊断错误，而不会将不匹配的着色器与缓冲区大小强行配对。现有的 `setMaxLights` 契约仍要求在管线编译前完成容量调整；不支持编译后任意修改。

仅为纹理化变体额外绑定三个条目：`texture_2d_array<f32>`、一个过滤采样器以及映射 uniform。因此无论有多少纹理化灯光，都只消耗一组额外的纹理和采样器，而不是 `MAX_LIGHTS` 对。PBR 通过通用的标量场景绑定 ID 和可选的销毁集合进行绑定；Standard 则已接收其场景和销毁器集合。该 ID 在共享模块中不具备任何功能含义。绑定所有者独立于场景所有权保留快照分配：在替换版本构建期间，旧的前向/几何材质保持有效。最后一个分配所有者负责销毁其纹理数组和映射缓冲区，并释放获取的图像快照。已销毁的场景会删除其标量 ID 注册表条目；不会无限期保留任何 Promise 或场景引用。

异步准备钩子同时针对 PBR 和 Standard 组运行。当打包标识或赋值发生变化时，它们会校验图像溯源/当前设备并重建快照。启用流程检测是否需要纹理化变体，并且仅在准备成功后才原子发布新的场景着色器接缝；缓存变体区分纯色与纹理化特性位。跨场景快照绝不共享映射或可变索引。初始使用流程为：预处理 → 赋值 → await 启用 → 注册。对于注册后的赋值/清除/添加/移除/重排操作，需停止渲染、修改状态、`await enableRectAreaLights(scene)`，然后 `await rebuildSceneRenderables(scene)`，再恢复渲染。这一现有的全组重建路径可同步前向、几何、选择列表和着色器上下文。不要在异步重建中途修改光照拓扑。若准备过程在 await 期间观测到拓扑已变化，会拒绝并报出“请再次重建”的诊断信息，而不会安装过期快照。清除回纯色会释放场景的发射所有者，而旧的已绑定材质则会通过正常的重建/销毁路径释放各自的所有权。

Standard 场景准备/上下文解析通过模块局部的通用接缝显式安装：当缺少启用器时，这些可选调用会被折叠消除，从而避免 PR806 scene103 的包体积回归。Standard 光照源码传输以及额外的辅助函数参数/实参同样具有可空安装器；在缺少对应启用器时不会读取任何额外字符串字段。发射 Standard 模块会为其确切的辅助函数标识提供打包索引标量。它仅比对已知的辅助函数字符串常量，绝不解析已生成的 WGSL，也绝不传递分支门控对象。PBR 也仅通过延迟安装的回调来传输其标量场景绑定 ID 和绑定拥有的销毁器集合；在缺少绑定扩展时绝不会分配辅助所有权集合。场景/材质核心不包含任何发射语义。纹理化扩展 ID `rect-area-emission` 不与纯色 `rect-area-light` ID 重叠：PBR 现有的层级前缀绑定分发绝不能误将纯色绑定器选中给纹理化片元。

在创建 LTC/发射所有者或注册任何销毁器之前拒绝已销毁的场景，并在每次异步资源阶段之后重新检查场景是否已销毁。在首次启用前调用公共的 `disposeScene(scene)` 必须不创建任何资源且不安装任何所有者。

### 纹理化 LTC 数学

沿用现有的背面/退化检查、法线视角切线回退、LTC 查找表以及修正后的漫反射/F0/镜面反射颜色乘法。纹理化结果将漫反射/镜面反射从标量变为 RGB 向量。对于每次漫反射单位基变换和每次镜面反射逆 LTC 变换，先变换四个角点；在对角点方向归一化之前先采样发射贴图。纯色槽位返回 RGB 全 1 乘以现有形状因子。

对于变换后的角点 `q0,q1,q2,q3`，取坐标轴 `X=q1-q0` 和 `Y=q3-q0`、法线 `n=cross(X,Y)`、平方微元面积 `a=dot(n,n)` 以及 `h=dot(n,q0)`。将原点投影到灯光平面上：`p=h*n/a-q0`。去除 `Y` 沿 `X` 的分量：`Y'=Y-X*dot(X,Y)/dot(X,X)`。解出 `v=dot(Y',p)/dot(Y',Y')`，`u=dot(X,p)/dot(X,X)-dot(X,Y)/dot(X,X)*v`。这显式地处理了非正交的变换坐标轴。UV 为 `0.125+0.75*(u,v)` 且 X 轴翻转。距离 `d=abs(h)/pow(a,0.75)`；`LOD=log(2048*d)/log(3)`。将零距离情况限幅为 LOD 零，而不是计算 `log(0)`。退化的变换坐标轴返回零；有限的合法矩形使用精确的参考方程。三线性 clamp 采样提供 RGB 值。分别计算漫反射和镜面反射采样；绝不将漫反射投影复用于镜面反射。

### 专项验证

基于上游独立表达的数值预言机验证了 Float32 卷积核归一化、边界反射、外部半径选择、逐轴字节四舍五入、保持不变的 Alpha、非对称图像朝向、完整 mip 描述符以及非正交坐标轴下的投影/LOD 计算。模拟设备测试覆盖了采样器非可变性、无效/未处理/已释放/错误设备图像、GPU/映射失败、await 期间的销毁/设备/容量变更、清理以及重试。映射/绑定测试覆盖了相同位置的多张贴图、共享贴图/克隆体、精确/纯色/纹理化混合灯光、过滤器、`MAX_LIGHTS`、槽位重排、清除/重绑定、跨场景隔离以及前向/几何路径。真实的 Standard 与混合 PBR 组构建器测试验证了以 16 初始准备并在注册/首次管线编译前增长容量的场景，发射体位于打包槽位 16 且声明/上传/绑定尺寸精确匹配。列表不变时的容量增长/收缩会使分配失效，同时保留旧代绑定直至其最后所有者释放它们。构建测试确保纯色/无面光源消费者仅保留根声明并成功 tree-shake 掉发射模块。集成测试负责真实 GPU 对比及作用域内运行时字节测量；现有上限与基准图像保持不变。

分配替换与清理已使用不同的模拟 GPUDevice 进行单元测试，常规原生 WebGPU 渲染已进行集成测试。完整的可选设备丢失恢复编排器尚未针对面光源进行端到端演练；因此不宣称已验证完整的设备恢复。

## Babylon.js 等价对照表

| 参考实现                                         | Lite 职责                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `rectAreaLight.pure.ts`                          | 局部 -Z 矩形、变换后中心与缩放半轴                                                  |
| `LTC/ltcTextureTool.ts`                          | 精确交错、小端序 rgba16float 数据                                                   |
| WGSL `ltcHelperFunctions.fx`                     | 切线基、矩阵朝向、边向量、裁剪、Fresnel 查找                                        |
| `pbrDirectLighting{SetupFunctions,Functions}.fx` | 材质 F0/F90 与面光源漫反射/镜面反射                                                 |
| `lightFragment.fx`, `lightsFragmentFunctions.fx` | Standard 粗糙度与材质乘法                                                           |
| PR16078                                          | 无纹理/无阴影的初始支持范围                                                         |
| PR16123                                          | 变换缩放与独立的漫反射/镜面反射，显式节点契约                                       |
| PR16577                                          | 与共享辅助函数耦合的声明                                                            |
| PR16723                                          | 金属度/反照率/F0 正确的光照贡献                                                     |
| PR18605                                          | 保留位置/尺寸/强度、单位光度学缩放、共享发射图像的克隆体                            |
| `areaLightsTextureTools.ts`, WGSL 处理           | 精确缩放/镜像重复、可变高斯核、字节量化、完整 mip 链                                |
| WGSL `FetchDiffuseFilteredTexture`               | 非正交平面投影、X 翻转、基于距离的 mip 选择                                         |

## 依赖关系

现有的 `SceneNode` 变换/克隆、共享网格灯光选择、着色器组合与材质注册表、纹理所有权与采样器池、原生 fetch、WebGPU。无包依赖变更。

## 测试规范

专项单元测试覆盖打包边界、尺寸/颜色/强度脏追踪、父级缩放/旋转、克隆/重建、混合网格过滤、精确端序解交错、异常长度、HTTP/重试/去重、上传描述符、共享场景销毁、await 期间销毁、部分分配失败、设备替换、PBR 单光源/混合着色器输出、Standard 粗糙度、声明/绑定以及显式节点拒绝。保持现有的精确单光源/多光源材质测试全部通过。仅运行限定范围的 Vitest、ESLint/Prettier 和包类型检查。集成测试负责运行新的视觉测试固件和作用域内包体积测量，而不修改现有基准图像或体积极限。

## 文件清单

- `light/rect-area-light.ts`：状态、受追踪属性、打包、克隆。
- `light/enable-rect-area-lights.ts`：公共可选启用入口与通用接缝安装。
- `light/area-light-ltc.ts`：二进制解码、请求与 GPU 所有权。
- `light/area-light-wgsl.ts`：共享 LTC 数学与绑定声明。
- `light/process-area-light-texture.ts`、`light/area-light-blur.ts`、`light/area-light-image.ts`：独立预处理、精确 CPU 高斯数学以及已处理图像校验/溯源。
- `light/area-light-emission.ts`、`light/area-light-emission-wgsl.ts`：场景快照、紧凑数组所有权/映射、变换后投影与发射采样。
- `light/area-light-emission-setup.ts`：由成功预处理安装的延迟场景准备/扩展注册。
- `texture/read-texture-pixels.ts`、`effect/effect-renderer.ts`：通用独立全屏录制与保留 Alpha 的纹理回读；复用现有 mipmap 生成。
- `resource/texture-sampler-pool.ts`：恢复普通池化采样器设置而无需第二套缓存。
- `material/{pbr,standard}/fragments/rect-area-light-emission-fragment.ts`：延迟加载的纹理化材质声明/绑定与标量选中槽位传输。
- `light/lighting-extension.ts`：仅包含通用内部接缝类型。
- `material/pbr/fragments/rect-area-light-fragment.ts`：`PbrExt` 与光源贡献。
- `material/standard/fragments/rect-area-light-fragment.ts`：`StdExt` 与面光源 Standard 光照。
- 现有场景/材质构建器与标志文件：仅包含通用传输/可选调用与位预留。
- `index.ts`：根导出。
- `tests/lite/unit/rect-area-light*.test.ts`：专项状态、生命周期、着色器测试。
- `tests/lite/unit/area-light-{texture-processing,texture-lifetime,emission-runtime,emission-opt-in}.test.ts`：精确预处理数学、失败清理、真实纹理恢复与全新运行时可选启用拒绝、真实前向/几何/全场景重建绑定生命周期。
- `tests/lite/build/rect-area-light-treeshake.test.ts`：通过 Rollup 内存消费已发布的 ESM 并对裁剪后的公共声明进行 AST 验证；不创建临时目录或构建场景。
