# 功能对比 — Babylon Lite 与 Babylon.js

本页按功能分类逐一梳理 **Babylon Lite** 与 **Babylon.js (BJS)** 之间的功能差异。这里为你呈现一份坦诚、详尽的清单，列明 Lite 当前已支持的功能、部分支持的功能以及刻意不支持的功能，以便你判断 Lite 是否适合你的项目。

> **Babylon Lite 并不是 Babylon.js 的替代品。** 两个引擎并肩前行。Lite 专注于最小打包体积与最高 WebGPU 性能；Babylon.js 则专注于最广泛、最成熟的功能集，并同时支持 WebGL **和** WebGPU。弥补以下功能差距是我们的最高优先级——各项功能均以独立、可 Tree-Shaking 的模块形式合入 `Babylon.lite`，确保引擎成长的同时不会使你的打包体积膨胀。

## 图例

| 符号 | 含义                                           |
| ---- | ---------------------------------------------- |
| ✅   | 已支持                                         |
| ⚡   | 部分支持 — 已实现其中一部分功能；详见备注      |
| —    | 暂未提供                                       |
| 🚫   | 不会支持 — 在设计上超出范围                    |
| ★    | Lite 优势 — Lite 领先于 Babylon.js 的领域      |

---

<!-- AUTOGEN:feature-comparison START — generated from lab/lite/docs/feature-comparison.html by scripts/gen-feature-comparison.ts. Do not edit between these markers by hand. -->

## 渲染 API

| 功能                              | Lite | BJS | 备注                                                                                                         |
| --------------------------------- | :--: | :-: | ------------------------------------------------------------------------------------------------------------ |
| ★ WebGPU                          |  ✅  | ✅  | Lite 仅支持 WebGPU — 零抽象层开销                                                                            |
| WebGL 2.0                         |  🚫  | ✅  | 不在计划内 — 设计上仅支持 WebGPU                                                                             |
| WebGL 1.0                         |  🚫  | ✅  | 不在计划内 — 设计上仅支持 WebGPU                                                                             |
| 4× MSAA                           |  ✅  | ✅  |                                                                                                              |
| 深度 / 模板缓冲区                 |  ✅  | ✅  | depth24plus-stencil8                                                                                         |
| HDR 渲染                          |  ✅  | ✅  |                                                                                                              |
| 色调映射（Tone Mapping）          |  ✅  | ✅  | 图像处理管线                                                                                                 |
| 曝光 / 对比度                     |  ✅  | ✅  | 通过 ImageProcessingConfig 配置                                                                              |
| 画布尺寸调整处理                  |  ✅  | ✅  | 逐帧自动检测                                                                                                 |
| 绘制调用计数                      |  ✅  | ✅  |                                                                                                              |
| EffectRenderer / EffectWrapper    |  ✅  | ✅  | 场景 74-76 — 直接交换链渲染器及 RTT 任务路径                                                                 |
| 全屏效果通道                      |  ✅  | ✅  | 单全屏三角形，无需顶点/索引缓冲区                                                                            |
| 效果渲染目标输出                  |  ✅  | ✅  | 场景 75 — 将效果渲染到纹理，随后在材质中使用                                                                 |
| 效果纹理绑定                      |  ✅  | ✅  | 场景 76 — 通过 setEffectTexture() 绑定 Texture2D + 采样器                                                    |
| 帧图 RTT 材质覆盖                 |  ✅  | ✅  | 场景 110 — 离屏通道使用覆盖材质与相机渲染选定网格，随后在主通道采样该 RTT                                    |

---

## 材质

| 功能                                       | Lite | BJS | 备注                                                                                                                                                                                                    |
| ------------------------------------------ | :--: | :-: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PBR 金属度-粗糙度                          |  ✅  | ✅  | 完整 GGX / Smith / Schlick BRDF                                                                                                                                                                         |
| PBR 镜面-光泽度                            |  ✅  | ✅  | KHR_materials_pbrSpecularGlossiness                                                                                                                                                                     |
| Standard Material（Blinn-Phong）           |  ✅  | ✅  | 漫反射、高光、环境光、自发光                                                                                                                                                                            |
| 网格顶点色                                 |  ✅  | ✅  | PBR 自动支持；Standard 需显式调用 enableStandardVertexColors() 启用（场景 267）                                                                                                                         |
| 背景材质                                   |  ✅  | ✅  | 地面平面 + 天空盒渲染                                                                                                                                                                                   |
| 法线贴图                                   |  ✅  | ✅  | 余切空间（Cotangent frame）、invertNormalMapX                                                                                                                                                           |
| 自发光纹理                                 |  ✅  | ✅  |                                                                                                                                                                                                         |
| 环境光遮蔽（AO）贴图                       |  ✅  | ✅  | ORM 纹理通道打包                                                                                                                                                                                        |
| 金属反射率贴图                             |  ✅  | ✅  | 支持 metallicReflectanceTexture                                                                                                                                                                         |
| 镜面抗锯齿                                 |  ✅  | ✅  | 存在法线贴图时使用 getAARoughnessFactors                                                                                                                                                                |
| Alpha 混合 / Alpha 测试                    |  ✅  | ✅  | OPAQUE、BLEND、MASK 模式                                                                                                                                                                                |
| 双面渲染                                   |  ✅  | ✅  |                                                                                                                                                                                                         |
| 透明贴图（Opacity Textures）               |  ✅  | ✅  | 透明物体关闭深度写入                                                                                                                                                                                    |
| 凹凸 / 高度贴图                            |  ✅  | ✅  |                                                                                                                                                                                                         |
| 光照贴图纹理                               |  ✅  | ✅  | Standard 材质使用 UV2；PBR 通过显式启用 enablePbrLightmap() + setPbrLightmap()                                                                                                                          |
| 环境光纹理（Ambient Textures）             |  ✅  | ✅  |                                                                                                                                                                                                         |
| 反射纹理                                   |  ✅  | ✅  | 球面与平面坐标模式                                                                                                                                                                                      |
| UV 缩放 / 偏移                             |  ✅  | ✅  |                                                                                                                                                                                                         |
| UV2 通道                                   |  ✅  | ✅  | 用于光照贴图与 AO                                                                                                                                                                                       |
| 节点材质（Node Material）                  |  ✅  | ✅  | NME 片段解析器，支持经过实验验证的核心、兼容、PBR、数学/模式、颜色、UV/纹理/程序化、法线/屏幕/深度/矩阵/场景状态、循环及存储块（场景 60-89）                                                            |
| 着色器材质（Shader Material）              |  ✅  | ✅  | 仅支持 WGSL 的 ShaderMaterial，具备类型化 Uniform、采样器、宏定义、Alpha 混合/测试；显式调用 enableShaderMaterialVisiblePacketUpdates() 可延迟隐藏对象的系统/资源更新（含分组不透明成员）；普通存储网格可显式复用 GPU 生成的索引间接绘制参数而无需计数回读（场景 159-163） |
| 材质插件（Material Plugins）               |  ✅  | ✅  | 显式启用 enableMaterialPlugins() — 向 PBR/Standard 注入自定义 WGSL，未使用时零打包体积开销（场景 217）                                                                                                  |
| 材质模板测试（Material Stencil）           |  ✅  | ✅  | 显式启用 enableMaterialStencil() — Standard/PBR/Shader 上的逐材质模板读写/测试（遮罩与丢弃），未使用时零打包体积开销                                                                                    |
| PBR 清漆（Clear Coat）                     |  ✅  | ✅  | 场景 19                                                                                                                                                                                                 |
| PBR 光泽层（Sheen）                        |  ✅  | ✅  | 场景 21                                                                                                                                                                                                 |
| PBR 各向异性（Anisotropy）                 |  ✅  | ✅  | 场景 23                                                                                                                                                                                                 |
| PBR 次表面 / 半透明                        |  ✅  | ✅  | 场景 26 — 厚度贴图、半透光、染色                                                                                                                                                                        |
| 材质变体（KHR_materials_variants）         |  ✅  | ✅  | 场景 27 — 运行时切换变体                                                                                                                                                                                |
| PBR 虹彩（Iridescence）                    |  ✅  | ✅  | 原生 PBR 薄膜干涉虹彩（场景 177）；NME 虹彩由场景 87 单独覆盖                                                                                                                                           |
| 网格线材质（Grid Material）                |  ✅  | ✅  | 程序化 GridMaterial，与 @babylonjs/materials 对等（场景 213）                                                                                                                                           |

---

## 灯光

| 功能                     | Lite | BJS | 备注                                                                                                  |
| ------------------------ | :--: | :-: | ----------------------------------------------------------------------------------------------------- |
| 半球光                   |  ✅  | ✅  |                                                                                                       |
| 平行光                   |  ✅  | ✅  |                                                                                                       |
| 点光源                   |  ✅  | ✅  |                                                                                                       |
| 聚光灯                   |  ✅  | ✅  | 支持圆锥角与指数衰减                                                                                  |
| 多光源（N 盏灯）         |  ✅  | ✅  | 动态 UBO 打包                                                                                         |
| 逐网格灯光包含           |  ✅  | ✅  | 场景 111 — 类似 includedOnlyMeshIds 的灯光筛选，覆盖 Standard、PBR、NME 及受支持的阴影生成器          |
| 灯光强度 / 颜色          |  ✅  | ✅  | 每个光源独立的漫反射与高光颜色                                                                        |
| 面光源（Area Lights）    |  —   | ✅  |                                                                                                       |

---

## 相机

| 功能                      | Lite | BJS | 备注                                                                                                       |
| ------------------------- | :--: | :-: | ---------------------------------------------------------------------------------------------------------- |
| 弧形旋转相机              |  ✅  | ✅  | 轨道旋转 / 缩放 / 平移 / 惯性                                                                              |
| 自动取景（fitToScene）    |  ✅  | ✅  | 加载模型时的默认相机                                                                                       |
| 自由相机                  |  ✅  | ✅  | 场景 18、24、25 — WASD/方向键控制                                                                          |
| 地理空间相机              |  ✅  | ✅  | 球面轨道相机（中心点/偏航/俯仰/半径），支持飞往目标（fly-to）与输入控制（场景 225）                        |
| 正交投影                  |  ✅  | ✅  | 任意相机通过 enableOrthographicCamera() 显式启用；支持实时/可动画边界、按宽高比推导或偏心边界（场景 268）  |
| 跟随相机（Follow Camera） |  —   | ✅  |                                                                                                            |
| 通用相机                  |  —   | ✅  |                                                                                                            |
| VR / XR 相机              |  —   | ✅  |                                                                                                            |
| 设备方向相机              |  —   | ✅  |                                                                                                            |

---

## 网格与几何体

| 功能                     | Lite | BJS | 备注                                                                                     |
| ------------------------ | :--: | :-: | ---------------------------------------------------------------------------------------- |
| 球体                     |  ✅  | ✅  | 可配置分段数                                                                             |
| 立方体                   |  ✅  | ✅  |                                                                                          |
| 圆环（Torus）            |  ✅  | ✅  | 可配置管径/细分度                                                                        |
| 地面平面                 |  ✅  | ✅  |                                                                                          |
| 高度图地面               |  ✅  | ✅  | GPU 纹理 → 顶点位移                                                                      |
| Thin Instances           |  ✅  | ✅  | add / remove / set / flush API                                                           |
| 可观察变换（Observable） |  ✅  | ✅  | ObservableVec3 在修改时自动标脏                                                          |
| 变换层级                 |  ✅  | ✅  | 基于版本号的惰性世界矩阵，所有实体均实现 IWorldMatrixProvider                            |
| 克隆 TransformNode       |  ✅  | ✅  |                                                                                          |
| 圆柱体                   |  ✅  | ✅  | 通过 diameterTop/Bottom 生成圆柱 / 圆锥 / 棱柱                                           |
| 平面                     |  ✅  | ✅  | 支持 size 或 width/height                                                                |
| 圆盘 / 圆环面            |  ✅  | ✅  | 可配置弧度与细分度                                                                       |
| 多面体                   |  ✅  | ✅  | 15 种 BJS 预设，支持平面法线与平滑法线                                                   |
| 条带 / 管道 / 挤出       |  ✅  | ✅  | Path3D 平行传输标架、closePath/closeArray、封盖模式                                      |
| CSG / CSG2（布尔运算）   |  ✅  | ✅  | 场景 90/91 — 传统网格 CSG 以及基于 Manifold 的 CSG2 差集、交集与并集/加法运算            |
| 实例化网格（Instanced）  |  🚫  | ✅  | 不会支持 BJS InstancedMesh API；请改用 thin instances                                    |

---

## 骨骼与动画

| 功能                         | Lite | BJS | 备注                                                                                                  |
| ---------------------------- | :--: | :-: | ----------------------------------------------------------------------------------------------------- |
| 骨骼动画                     |  ✅  | ✅  | GPU 骨骼纹理（rgba32float）                                                                           |
| 4 骨骼蒙皮                   |  ✅  | ✅  | JOINTS_0 / WEIGHTS_0                                                                                  |
| 8 骨骼蒙皮                   |  ✅  | ✅  | JOINTS_1 / WEIGHTS_1                                                                                  |
| 变形目标（Morph Targets）    |  ✅  | ✅  | 最多支持 4 个目标，位置 + 法线增量                                                                    |
| 动画组（Animation Groups）   |  ✅  | ✅  | play / pause / stop / seek / loop / speed                                                             |
| 线性插值                     |  ✅  | ✅  |                                                                                                       |
| 阶跃插值                     |  ✅  | ✅  |                                                                                                       |
| 三次样条插值                 |  ✅  | ✅  |                                                                                                       |
| 确定性跳转（Seek）           |  ✅  | ✅  | 用于一致性测试的固定时间步长                                                                          |
| 动画混合                     |  ✅  | ✅  | 加权混合、交叉淡入淡出（cross-fade）与叠加动画组（场景 155-158）                                      |
| 动画遮罩                     |  ✅  | ✅  | AnimationGroupMask 包含/排除目标名称过滤；显式启用，未使用时零打包体积开销（场景 251）                |
| 动画事件                     |  —   | ✅  |                                                                                                       |
| 动画权重                     |  ✅  | ✅  | 通过 AnimationManager 控制 AnimationGroup 权重                                                        |
| 顶点动画纹理（VAT）          |  ✅  | ✅  | 在 GPU 上播放烘焙的骨骼动画，含逐实例 thin-instanced VAT（场景 218-219）                              |

---

## 环境与 IBL

| 功能                    | Lite | BJS | 备注                                        |
| ----------------------- | :--: | :-: | ------------------------------------------- |
| Babylon .env 文件       |  ✅  | ✅  | RGBD 立方体贴图解码                         |
| HDR 全景图（.hdr）      |  ✅  | ✅  | 等距柱状投影 → 立方体贴图 → 预滤波 IBL      |
| 基于图像的光照（IBL）   |  ✅  | ✅  | Split-sum 近似                              |
| BRDF 查找表             |  ✅  | ✅  | 预烘焙 PNG，RGBD 计算解码                   |
| 球谐函数（SH）          |  ✅  | ✅  | 从环境提取辐照度                            |
| DDS 立方体天空盒        |  ✅  | ✅  |                                             |
| 立方体贴图天空盒        |  ✅  | ✅  | 6 面立方体纹理                              |
| HDR 天空盒              |  ✅  | ✅  |                                             |
| 地面 + 天空盒背景       |  ✅  | ✅  | 菲涅尔地面不透明度、预乘 Alpha              |
| 雾效（线性/指数/指数²） |  ✅  | ✅  |                                             |
| 环境旋转                |  ✅  | ✅  |                                             |
| 环境天空盒模糊          |  ✅  | ✅  | 连续小数立方体贴图 LOD                      |
| 反射探针                |  —   | ✅  |                                             |

---

## 阴影

| 功能                        | Lite | BJS | 备注                                                                                                  |
| --------------------------- | :--: | :-: | ----------------------------------------------------------------------------------------------------- |
| ESM 阴影（平行光）          |  ✅  | ✅  | 深度通道 + 高斯模糊通道                                                                               |
| 阴影贴图尺寸配置            |  ✅  | ✅  |                                                                                                       |
| 阴影偏移 / 暗度             |  ✅  | ✅  |                                                                                                       |
| 视锥体边缘衰减              |  ✅  | ✅  |                                                                                                       |
| PCF 阴影                    |  ✅  | ✅  | 聚光灯 + 平行光 PCF（场景 18、111）                                                                   |
| 级联阴影贴图（CSM）         |  ✅  | ✅  | 平行光 CSM，最多 4 级联，PCF5，支持 Standard + PBR 接收者（场景 214-215）                             |
| 点光源阴影                  |  —   | ✅  |                                                                                                       |
| 聚光灯阴影                  |  ✅  | ✅  | 场景 18（PCF）                                                                                        |
| 材质感知的阴影深度          |  ✅  | ✅  | 针对 Standard、PBR 和 NodeMaterial 的阴影材质视图及 Alpha 丢弃投射体（场景 116、140、141）            |
| 接触硬化阴影                |  —   | ✅  |                                                                                                       |

---

## 加载器

| 功能                     | Lite | BJS | 备注                                                                                      |
| ------------------------ | :--: | :-: | ----------------------------------------------------------------------------------------- |
| glTF 2.0 / GLB           |  ✅  | ✅  | 网格、材质、蒙皮、变形目标、动画                                                          |
| .babylon 格式            |  ✅  | ✅  | 网格、Standard 材质、灯光                                                                 |
| 环境贴图 .env            |  ✅  | ✅  |                                                                                           |
| HDR 全景图 .hdr          |  ✅  | ✅  |                                                                                           |
| 天空盒立方体纹理         |  ✅  | ✅  |                                                                                           |
| 2D 纹理加载              |  ✅  | ✅  | 支持 mipmap 生成                                                                          |
| OBJ / MTL                |  —   | ✅  |                                                                                           |
| STL                      |  —   | ✅  |                                                                                           |
| FBX                      |  —   | ✅  |                                                                                           |
| KTX1 压缩纹理            |  ✅  | ✅  | 场景 25 — ASTC / BC / ETC2 自动选择格式 + PNG 回退                                        |
| KTX2 纹理                |  ✅  | ✅  | 场景 112 — KHR_texture_basisu glTF 纹理源                                                 |
| Basis Universal (.basis) |  ✅  | ✅  | 场景 36 — 从 BJS CDN 获取转码器；自动选择 BC7 / ASTC / ETC2 / BC3 + RGBA32 回退           |

---

## glTF 2.0 扩展（Khronos + 厂商扩展）

| 功能                                | Lite | BJS | 备注                                                                   |
| ----------------------------------- | :--: | :-: | ---------------------------------------------------------------------- |
| KHR_materials_pbrSpecularGlossiness |  ✅  | ✅  | 已归档扩展 — 映射至金属度-粗糙度（场景 6）                             |
| KHR_materials_variants              |  ✅  | ✅  | 场景 27 — 运行时变体选择                                               |
| KHR_materials_unlit                 |  ✅  | ✅  | 场景 32 — 直接输出基础色，无光照                                       |
| KHR_materials_clearcoat             |  ✅  | ✅  | 场景 28 — glTF 加载器自动连接清漆 + 粗糙度 + 法线纹理                  |
| KHR_materials_sheen                 |  ✅  | ✅  | 场景 29 — glTF 加载器按 BJS 规范进行反照率缩放                         |
| KHR_materials_anisotropy            |  ✅  | ✅  | glTF 加载器自动连接强度 + 旋转（手动 API 见场景 23）                   |
| KHR_materials_volume                |  ✅  | ✅  | glTF 加载器自动连接衰减 + 厚度（场景 30）；手动 API 见场景 26          |
| KHR_materials_transmission          |  ✅  | ✅  | 基于帧图场景纹理的透射效果（场景 30/33/112）                           |
| KHR_materials_ior                   |  ✅  | ✅  | 折射率覆盖（场景 30）                                                  |
| KHR_materials_specular              |  ✅  | ✅  | 电介质镜面反射强度/颜色（场景 30）                                     |
| KHR_materials_iridescence           |  ✅  | ✅  | glTF 加载器自动连接系数/IOR/厚度及打包纹理通道（场景 178）             |
| KHR_materials_emissive_strength     |  ✅  | ✅  | HDR 自发光倍增（场景 31）                                              |
| KHR_materials_dispersion            |  ✅  | ✅  | 场景 212 — 体积玻璃上与波长相关的（色散）折射                          |
| KHR_lights_punctual                 |  ✅  | ✅  | 场景 33 — 来自 glTF 的点光源 / 聚光灯 / 平行光                         |
| KHR_texture_transform               |  ✅  | ✅  | 加载时解析材质级 UV 偏移 / 缩放 / 旋转（场景 29）                      |
| KHR_texture_basisu                  |  ✅  | ✅  | 场景 112 — 来自 BabylonJS/Assets 的 FlightHelmetKTX                    |
| KHR_draco_mesh_compression          |  ✅  | ✅  | Draco 压缩网格几何体（场景 30）                                        |
| KHR_mesh_quantization               |  ✅  | ✅  | 场景 211 — 加载时对 8/16 位量化顶点属性进行反量化                      |
| KHR_animation_pointer               |  ✅  | ✅  | 场景 34 — 对任意 JSON 指针（如节点可见性）进行动画                     |
| KHR_node_visibility                 |  ✅  | ✅  | 场景 34 — 逐节点可见性标志                                             |
| KHR_audio / KHR_audio_emitter       |  —   | ✅  | 空间 / 环境音频                                                        |
| KHR_xmp_json_ld                     |  ✅  | ✅  | 场景 210 — 解析并暴露 XMP JSON-LD 元数据                               |
| EXT_mesh_gpu_instancing             |  ✅  | ✅  | 场景 35 — 逐节点实例变换（TRS 访问器 → thin instances）                |
| EXT_meshopt_compression             |  ✅  | ✅  | 场景 211 — meshoptimizer 比特流解码（BrainStem 蒙皮 + 动画）           |
| EXT_texture_webp                    |  ✅  | ✅  | 场景 37 — EXT_texture_webp 纹理源选择，使用浏览器原生解码              |
| EXT_texture_avif                    |  —   | ✅  | AVIF 纹理源                                                            |
| EXT_lights_image_based              |  —   | ✅  | glTF 资产内指定的 IBL                                                  |
| MSFT_lod                            |  —   | ✅  | 离散细节层次（LOD）                                                    |
| MSFT_minecraftMesh                  |  —   | ✅  | Minecraft 风格体素网格                                                 |
| MSFT_audio_emitter                  |  —   | ✅  | 传统空间音频                                                           |
| ExtrasAsMetadata                    |  ✅  | ✅  | 将 glTF `extras` 提升至 `metadata.gltf.extras`                         |

---

## 纹理

| 功能                   | Lite | BJS | 备注                                                                            |
| ---------------------- | :--: | :-: | ------------------------------------------------------------------------------- |
| 2D 纹理                |  ✅  | ✅  |                                                                                 |
| 立方体纹理             |  ✅  | ✅  |                                                                                 |
| 纯色纹理               |  ✅  | ✅  | 程序化 1×1 填充                                                                 |
| GPU Mipmap 生成        |  ✅  | ✅  | 计算着色器生成 mipmap                                                           |
| sRGB 处理              |  ✅  | ✅  | 基于纹理格式的伽马校正                                                          |
| 采样器配置             |  ✅  | ✅  | 过滤、寻址模式、各向异性                                                        |
| InvertY 控制           |  ✅  | ✅  |                                                                                 |
| 程序化纹理             |  —   | ✅  |                                                                                 |
| 视频纹理               |  —   | ✅  |                                                                                 |
| 动态纹理               |  —   | ✅  |                                                                                 |
| 渲染目标纹理（RTT）    |  ✅  | ✅  | 帧图 RTT + 可采样的 Texture2D，含通道局部材质覆盖（场景 75、110）               |
| 多重渲染目标（MRT）    |  —   | ✅  |                                                                                 |

---

## 数学工具

| 功能                        | Lite | BJS | 备注                                                                                                                    |
| --------------------------- | :--: | :-: | ----------------------------------------------------------------------------------------------------------------------- |
| Vec3 / Vec4                 |  ✅  | ✅  | add, sub, scale, dot, cross, normalize, lerp                                                                            |
| Mat4（4×4 矩阵）            |  ✅  | ✅  | Multiply, inverse, lookAt, perspective, compose                                                                         |
| 四元数（Quaternion）        |  ✅  | ✅  | Slerp, toMatrix, from Euler                                                                                             |
| Color3 / Color4             |  ✅  | ✅  |                                                                                                                         |
| ObservableVec3              |  ✅  |  —  | 修改时自动标脏（Lite 特有）                                                                                             |
| 左手列主序内存布局          |  ✅  | ✅  | 与 WGSL/WebGPU 约定对齐                                                                                                 |
| ★ 高精度 / 浮动原点矩阵     |  ✅  | ⚡  | 场景 200/201 — F64 矩阵缓存 + 相机相对浮动原点上传，消除约 5e6 世界单位处的抖动；BJS 提供 useHighPrecisionMatrix 但无相机相对浮动原点路径 |

---

## 架构与开发体验

| 功能                    | Lite | BJS | 备注                                                                                            |
| ----------------------- | :--: | :-: | ----------------------------------------------------------------------------------------------- |
| ★ 100% 可 Tree-Shaking  |  ✅  | ⚡  | Lite 中零模块级副作用                                                                           |
| ★ 极小打包体积          |  ✅  |  —  | 同一场景下体积远小于 BJS                                                                        |
| ★ 零副作用              |  ✅  |  —  | 导入时无 register*()，无 globalThis                                                             |
| ★ 单向数据所有权        |  ✅  |  —  | 组件是纯数据；场景是唯一所有者                                                                  |
| ★ 材质持有着色器        |  ✅  |  —  | 自包含的材质 + 管线单元                                                                         |
| TypeScript              |  ✅  | ✅  | 全程严格类型检查                                                                                |
| 原生支持 Vite           |  ✅  | ⚡  | 一流的 Vite 集成                                                                                |
| 熟悉的类 BJS API        |  ✅  | ✅  | 便于 BJS 开发者迁移                                                                             |
| 热切换材质              |  ✅  | ✅  | Object.defineProperty setter + 重建队列                                                         |
| 销毁 / 清理             |  ✅  | ✅  | 销毁时完整释放 GPU 资源                                                                         |
| GPU 帧计时器            |  ✅  | ✅  | 通过 WebGPU timestamp queries 提供零默认开销的 GPU 帧剖析（setGpuTimingEnabled）                |
| 多画布 / 多场景         |  ✅  | ✅  | 单个引擎通过 createSurface 驱动多个画布/场景；GPU 资源归属于设备作用域（场景 227-228）          |

---

## 高级特性

| 功能                                    | Lite | BJS | 备注                                                                                                                                         |
| --------------------------------------- | :--: | :-: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 物理引擎                                |  ⚡  | ✅  | Havok Physics V2 子集（场景 40）；无 Ammo.js/Cannon.js/Oimo 兼容层                                                                           |
| 粒子系统                                |  —   | ✅  | CPU + GPU 粒子                                                                                                                               |
| 后处理管线                              |  ✅  | ✅  | 帧图任务包含通用全屏通道、泛光（Bloom）、景深（DoF）、TAA、SMAA 以及最终图像处理/色调映射。场景 187 覆盖 SMAA。                                |
| GUI（2D / 3D UI）                       |  —   | ✅  |                                                                                                                                              |
| 精灵 / SpriteManager                    |  ⚡  | ✅  | 2D 图层、支持深度的精灵、朝向/锁轴/镂空广告牌（场景 50-57）；并非完整的 BJS SpriteManager API                                                |
| 高斯泼溅（Gaussian Splatting）          |  ✅  | ✅  | .ply / .splat / .sog / .spz 加载器、变换烘焙、材质插件片段、深度渲染与 GPU 拾取（场景 120-129）                                              |
| 八叉树 / 视锥剔除                       |  —   | ✅  |                                                                                                                                              |
| 细节层次（LOD）                         |  —   | ✅  |                                                                                                                                              |
| 射线检测 / 拾取                         |  ✅  | ✅  | GPU ID 通道 + CPU 射线/三角形求交细节、法线/UV 辅助函数、thin-instance 与形变网格覆盖（场景 113-115）                                        |
| WebXR / VR / AR                         |  —   | ✅  |                                                                                                                                              |
| 辉光 / 高亮层                           |  —   | ✅  |                                                                                                                                              |
| 屏幕空间反射（SSR）                     |  —   | ✅  |                                                                                                                                              |
| SSAO                                    |  —   | ✅  |                                                                                                                                              |
| 镜头光晕                                |  —   | ✅  |                                                                                                                                              |
| 体积光散射                              |  —   | ✅  |                                                                                                                                              |
| 贴花（Decals）                          |  —   | ✅  |                                                                                                                                              |
| 实体粒子系统（SPS）                     |  —   | ✅  |                                                                                                                                              |
| 流体渲染                                |  —   | ✅  |                                                                                                                                              |
| 骨骼逆运动学（IK）                      |  —   | ✅  |                                                                                                                                              |
| 导航网格（Navigation Mesh）             |  ⚡  | ✅  | 支持人群、障碍物、连接与射线检测的 Recast V2（场景 170-175）；可选纯 JS Navcat 查询、独立生成、连接与调试（Navcat 演示）                     |
| 设备丢失恢复                            |  ✅  | ✅  | 通过 enableDeviceLost*Recovery API 按类型显式启用 WebGPU 设备丢失恢复（场景 164：Scene）                                                     |
| OffscreenCanvas / Worker 渲染           |  ✅  | ✅  | 引擎无需修改即可运行在 DOM 画布或转移至 Web Worker 的 OffscreenCanvas 上（Offscreen 演示）                                                   |
| 文本渲染                                |  ✅  | ✅  | 支持分层布局 + 编辑器的 GPU 文本渲染器（场景 180-181）                                                                                       |
| 操纵器（Gizmos）                        |  ✅  | ✅  | 位于辅助图层上的位置 / 旋转 / 缩放、包围盒、相机与灯光 Gizmo（场景 221-224）                                                                 |
| 几何缓冲区渲染器                        |  ✅  | ✅  | 生成法线 / 深度 / 位置纹理的帧图几何渲染器；为 DoF + CoC 提供输入（场景 145-149）                                                            |
| 大世界渲染（浮动原点）                  |  ✅  | ✅  | 相机相对渲染 + 面向超大世界坐标的多区域物理（场景 200-209）                                                                                  |
| 场景优化器                              |  —   | ✅  |                                                                                                                                              |
| 资产管理器                              |  —   | ✅  |                                                                                                                                              |
| 场景序列化                              |  —   | ✅  |                                                                                                                                              |

<!-- AUTOGEN:feature-comparison END -->

---

## 如何解读这些差异

- **两侧均为 ✅** 表示该功能在 Lite 中已实现与 Babylon.js 对等的能力——并在存在对应一致性场景的情况下通过了与 Babylon.js 的像素比对验证。
- **Lite 为 ⚡** 表示当前已可用一个有意义的子集；备注中写明了具体已覆盖与未覆盖的部分。这些通常是接下来最优先补齐完整的功能。
- **Lite 为 —** 表示该功能暂未提供。如果你的项目强依赖其中某项，当前选择 Babylon.js 会更合适——也请告诉我们，因为你的反馈将直接帮助规划 Lite 的路线图。
- **Lite 为 🚫** 表示该功能被有意排除在支持范围之外（例如 WebGL、经典的 `InstancedMesh` API）。这些都是为了换取 Lite 的体积与速度而刻意做出的架构权衡；请使用备注中提到的替代方案（例如 thin instances）。

此表用于跟踪当前状态，并会随着 `Babylon.lite` 与 Babylon.js 之间差距的缩小而定期更新。

## 下一步

- 🚀 **[快速开始](01-getting-started.md)** — 安装 Lite、了解心智模型，并渲染你的第一个场景。
- 🛝 **[Lite Playground](04-playground.md)** — 直接在浏览器中体验已支持的特性，无需本地配置。
- 🔁 **[迁移指南](03-porting-guide.md)** — 逐项对照将 Babylon.js 场景转换为 Babylon Lite。
- 🧱 **[架构文档](architecture/00-overview.md)** — 深入引擎内部实现细节。
- 🏠 **[欢迎页](00-welcome.md)** — 整体介绍与“我该用哪个引擎？”决策树。
