# Babylon Lite — 架构规范（单文档全景）

> **目的**：本文档是 Babylon Lite 架构的正式规范。
> 它必须足够完整，以至于即便删除所有源代码，大语言模型（LLM）仅凭本文档也能完整重构出整个引擎。请将其视为唯一真实基准（ground truth）。
>
> **修订范围**：场景 1–175（BoomBox PBR、球体+平行光、雾效+立方体+天空盒、阴影+ESM、
> Alien PBR+骨骼、PBR 金球、ChibiRex 动画、HDR 玻璃球、Sponza、PBR 粗糙球体、
> Shark GLB、PBR 着色器球、PBR 球体网格、Flight Helmet、聚光灯+地面、Thin Instances、
> PBR+Standard Thin Instances、聚光灯硬阴影 (PCF)、PBR 清漆、PBR 自发光球体网格、
> PBR 光泽布料、PBR 阴影、PBR 各向异性、Hill Valley (.babylon)、KTX 纹理、PBR 次表面、
> 材质变体 (KHR_materials_variants)、CSG/CSG2、基于 `KHR_texture_basisu` 的 FlightHelmetKTX、
> 高斯泼溅、ShaderMaterial、GridMaterial、设备丢失恢复、Havok 物理 V2 以及 Recast V2 导航）。
> 各模块的详细规范位于下方列出的配套文档中。

## 强制性 PR 验收规则：显式帧图输出

**每一个渲染帧图任务（frame-graph task）都必须将其实际渲染写入的纹理显式暴露为输出。这是一项阻塞性的架构硬性要求，而非建议。** 在 GPU 操作允许的情况下，输出既可以是与输入相同的纹理，也可以是不同的纹理。消费方绝不应该靠猜测来判断结果保存在哪张纹理中。

**并不普遍要求将目标纹理作为输入传入。** 任务既可以接收调用方提供的目标，也可以自行分配并拥有其输出纹理。`GeometryRendererTask` 自行分配其 G-buffer 附件并通过强类型输出对外发布，就是一个合法的任务自持分配示例。

无论采用哪种分配模型，所有权与输出选择都必须遵循既定的任务契约。调用方提供的目标必须被尊重。去搜索其他任务或依据注册顺序猜测目标，绝不能替代显式的输出发布。此规则同等适用于原生任务、后处理、叠加层以及兼容层适配器。

**任何新增或修改任务/输出连线却未显式发布实际产出纹理的 PR，即使截图或测试全部通过，也必须予以拒绝。** Babylon.js 兼容性与开发便利性均不能作为豁免理由。现存缺失输出契约的任务属于历史迁移债务，不可作为效仿先例；任务自行分配输出纹理并不违规。其余存量任务的迁移将在单独的 PR 中完成。

绑定契约、示例与审查清单请参阅[帧图：显式输出纹理](28-frame-graph.md#强制性显式输出纹理pr-准入门槛)。

## 架构文档索引

文档按 Babylon Lite 用户最常查阅的顺序排列——从场景、相机和灯光开始，接着加载并渲染模型（加载器、背景、材质）、添加动画，最后是更底层的渲染内部机制与工具链。

| 文档                                                               | 模块             | 范围                                                                                                       |
| ------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| [00-overview.md](00-overview.md)                                   | 概览             | 仓库结构、公共 API                                                                                         |
| [01-scene.md](01-scene.md)                                         | 场景             | SceneContext、单向所有权                                                                                   |
| [02-camera.md](02-camera.md)                                       | 相机             | ArcRotateCamera + FreeCamera、输入控制                                                                     |
| [03-lights.md](03-lights.md)                                       | 灯光             | 半球光、平行光、点光源、聚光灯 + Standard/PBR 共用的灯光 UBO                                               |
| [04-loaders.md](04-loaders.md)                                     | 加载器           | glTF 2.0、动态 glTF 特性、.env、.hdr、.babylon、天空盒、高斯泼溅                                           |
| [05-background-skybox.md](05-background-skybox.md)                 | 背景/天空盒      | DDS/HDR/立方体贴图天空盒、地面、背景材质                                                                   |
| [06-pbr-material.md](06-pbr-material.md)                           | PBR 材质         | ShaderFragment 组合、GGX/IBL、清漆、光泽层                                                                 |
| [07-animation.md](07-animation.md)                                 | 动画             | AnimationGroup、关键帧求值、glTF 集成                                                                      |
| [08-standard-material.md](08-standard-material.md)                 | Standard 材质    | ShaderFragment 组合、Blinn-Phong                                                                           |
| [09-texture-2d.md](09-texture-2d.md)                               | Texture2D        | 图像上传、KTX1/KTX2、mipmap 生成、invertY                                                                  |
| [10-mesh-generators.md](10-mesh-generators.md)                     | 网格生成器       | 地面/高度图、圆环、球体、立方体、圆柱、平面、圆盘、多面体、条带、管道、挤出                                |
| [11-scene-hierarchy-parenting.md](11-scene-hierarchy-parenting.md) | 场景层级         | TransformNode、父子关系、世界矩阵传播                                                                      |
| [12-thin-instances.md](12-thin-instances.md)                       | Thin Instances   | 逐实例矩阵 + 颜色、PBR + Standard                                                                          |
| [mesh-opacity.md](mesh-opacity.md)                                 | 网格不透明度     | 原生显式启用的 Standard/PBR 不透明度、自动兼容可见性、绑定自持 Uniform 与全强度阴影                        |
| [13-skeleton.md](13-skeleton.md)                                   | 骨骼             | 骨骼纹理、4/8 骨骼蒙皮                                                                                     |
| [14-morph-targets.md](14-morph-targets.md)                         | 变形目标         | 顶点扩展、GPU 纹理权重                                                                                     |
| [15-vertex-animation-texture.md](15-vertex-animation-texture.md)   | 顶点动画纹理     | VAT 烘焙、基于纹理的蒙皮、逐实例 + 双片段混合实例化、阴影投射                                              |
| [16-shadow-generator.md](16-shadow-generator.md)                   | 阴影生成器       | ESM + PCF 阴影、深度通道、高斯模糊                                                                         |
| [17-cascaded-shadow.md](17-cascaded-shadow.md)                     | 级联阴影贴图     | 平行光 CSM：视锥分割、逐级联正交适配、深度数组、PCF5 接收器                                                |
| [18-picking.md](18-picking.md)                                     | 拾取             | GPU ID 通道、CPU 射线/三角形求交                                                                           |
| [19-loader-hdr.md](19-loader-hdr.md)                               | HDR 加载器       | RGBE 解析、SH 提取、GPU 计算 IBL                                                                           |
| [20-loader-babylon.md](20-loader-babylon.md)                       | .babylon 加载器  | .babylon 格式解析                                                                                          |
| [loader-usd.md](loader-usd.md)                                     | OpenUSD 加载器   | 共享 protocol-v5 WASM 提取、Lite 原生命令缓冲区实例化                                                      |
| [21-core-math.md](21-core-math.md)                                 | 核心数学         | Vec3、Mat4、Quat、ObservableVec3/Quat                                                                      |
| [22-engine.md](22-engine.md)                                       | 引擎             | GPU 初始化、MSAA、渲染循环、交换链                                                                         |
| [23-shader-composition.md](23-shader-composition.md)               | 着色器组合       | ShaderFragment 系统、组合器、槽位注入                                                                      |
| [24-shader-material.md](24-shader-material.md)                     | 着色器材质       | 仅 WGSL 的 ShaderMaterial：类型化 Uniform、采样器、宏定义、Alpha 混合/测试                                 |
| [25-grid-material.md](25-grid-material.md)                         | 网格线材质       | 构建在 ShaderMaterial 之上的程序化无光照对象空间网格线                                                     |
| [26-material-plugin.md](26-material-plugin.md)                     | 材质插件         | 显式启用的 PBR/Standard 材质插件、自注册、零影响扩展接缝                                                   |
| [27-render-pipeline.md](27-render-pipeline.md)                     | 可渲染对象架构   | Renderable 接口、实体自持管线                                                                              |
| [28-frame-graph.md](28-frame-graph.md)                             | 帧图             | 任务排序、RenderTask、通道、渲染目标、RTT 纹理流                                                           |
| [29-post-process.md](29-post-process.md)                           | 后处理           | 帧图全屏后处理辅助工具与具体后处理任务                                                                     |
| [30-effect-renderer.md](30-effect-renderer.md)                     | 效果渲染器       | EffectRenderer/EffectWrapper、全屏通道、RTT 输出、纹理绑定                                                 |
| [31-geometry-renderer.md](31-geometry-renderer.md)                 | 几何渲染器       | 帧图法线/深度/位置 G-buffer 纹理                                                                           |
| [32-sprites.md](32-sprites.md)                                     | 精灵             | 2D 精灵、支持深度的精灵、精灵可渲染对象                                                                    |
| [33-text.md](33-text.md)                                           | 文本             | Slug GPU 字体：GlyphStorage + TextData + TextRenderable (3D) / TextRenderer (2D) + 默认配置                |
| [34-geospatial-camera.md](34-geospatial-camera.md)                 | 地理空间相机     | 球面轨道相机（中心/偏航/俯仰/半径），支持飞往目标与控制                                                    |
| [35-large-world-rendering.md](35-large-world-rendering.md)         | LWR / 浮动原点   | `useFloatingOrigin` 引擎标志、眼相对上传、FO 版本追踪                                                      |
| [36-high-precision-matrix.md](36-high-precision-matrix.md)         | 高精度矩阵       | `useHighPrecisionMatrix` 引擎标志、F64 底层存储、`allocateMat4` 单例、`packMat4IntoF32`                    |
| [37-resource-pool.md](37-resource-pool.md)                         | 资源池           | GPU 缓冲区/纹理池化                                                                                        |
| [38-bundle-size-tooling.md](38-bundle-size-tooling.md)             | 打包体积工具     | 逐场景打包体积分析、体积上限、树状图                                                                       |
| [39-animation-parity-testing.md](39-animation-parity-testing.md)   | 动画一致性       | 动画场景测试方法论                                                                                         |
| [40-material-stencil.md](40-material-stencil.md)                   | 材质模板测试     | 显式启用 `enableMaterialStencil`，Standard/PBR/Shader 上的逐材质模板遮罩/测试，零影响钩子                  |
| [41-audio-engine.md](41-audio-engine.md)                           | 音频引擎         | Web Audio 播放、总线、3D 空间音频、声像、分析器、麦克风、取消静音 UI                                       |
| [42-physics.md](42-physics.md)                                     | 物理             | Havok V2 世界、刚体/形状/聚合体、时间步长与增量传播、碰撞/触发器/查询/角色控制器                           |
| [49-error-handling.md](49-error-handling.md)                       | 错误处理         | 默认编码错误；`enableErrorDecoding`（常开）对比 `decodeError`（按需解码，如遥测上报）                      |
| [50-device-lost-recovery.md](50-device-lost-recovery.md)           | 设备丢失恢复     | WebGPU 设备丢失后 Scene、SpriteRenderer 与 TextRenderer 的显式启用恢复机制                                 |
| [51-flow-graph.md](51-flow-graph.md)                               | 流图（Flow Graph） | 纯状态可视化脚本、稳定的 glTF `KHR_interactivity` 与编辑器 JSON 兼容性                                     |
| [61-right-handed-system.md](61-right-handed-system.md)             | 右手坐标系       | 编译期 `babylon-lite-rh` 解析条件；常量标志在打包时折叠消除，两种模式下均零额外开销                        |

---

## 1. 仓库结构

```
babylon-lite/
├── GUIDANCE.md                    # Immutable core pillars & workflow (anti-amnesia)
├── package.json                   # pnpm workspace root
├── pnpm-workspace.yaml            # packages: [packages/*, apps/*]
├── tsconfig.base.json             # Shared TS config
├── vitest.config.ts               # Root test config
│
├── packages/babylon-lite/         # The engine library
│   ├── package.json               # name: "babylon-lite", type: "module"
│   ├── tsconfig.json              # extends ../../tsconfig.base.json
│   ├── vite.config.ts             # lib mode build
│   ├── src/
│   │   ├── index.ts               # Public API barrel (tree-shakable)
│   │   ├── vite-env.d.ts          # Declares ?raw WGSL imports
│   │   ├── math/                   # Math primitives
│   │   │   ├── types.ts           # Vec3, Vec4, Color3, Color4, Mat4, Quat
│   │   │   ├── vec3.ts            # Pure Vec3 functions
│   │   │   ├── mat4.ts            # Pure Mat4 functions (LH, column-major)
│   │   │   ├── observable-vec3.ts # ObservableVec3 (reactive position/target)
│   │   │   ├── observable-quat.ts # ObservableQuat (reactive rotation)
│   │   │   └── index.ts           # Math barrel
│   │   ├── engine/
│   │   │   └── engine.ts          # createEngine(), GPUDevice, swapchain, render loop
│   │   ├── scene/
│   │   │   ├── scene.ts           # createSceneContext(), flat data struct, add()
│   │   │   ├── scene-core.ts      # Core scene logic
│   │   │   ├── scene-camera.ts    # Camera management
│   │   │   ├── scene-remove.ts    # removeFromScene()
│   │   │   ├── set-parent.ts      # setParent() — parent/child transforms
│   │   │   ├── parentable.ts      # IWorldMatrixProvider, IParentable interfaces
│   │   │   ├── transform-node.ts  # TransformNode — hierarchy node without mesh
│   │   │   └── world-matrix-state.ts # Version-based world matrix propagation
│   │   ├── camera/
│   │   │   ├── camera.ts          # Camera interface
│   │   │   ├── arc-rotate.ts      # createArcRotateCamera(), ArcRotateCamera
│   │   │   ├── arc-rotate-controls.ts  # attachControl() for orbit
│   │   │   ├── free-camera.ts     # createFreeCamera(), FreeCamera
│   │   │   └── free-camera-controls.ts # attachFreeControl() for WASD/arrow
│   │   ├── light/
│   │   │   ├── light-base.ts      # Shared light base
│   │   │   ├── types.ts           # LightBase type, LightBaseInternal, MAX_LIGHTS
│   │   │   ├── light-matrix.ts    # Light view-projection for shadows
│   │   │   ├── hemispheric.ts     # createHemisphericLight()
│   │   │   ├── point-light.ts     # createPointLight()
│   │   │   ├── directional-light.ts # createDirectionalLight()
│   │   │   └── spot-light.ts      # createSpotLight()
│   │   ├── material/
│   │   │   ├── material.ts          # Shared Material / MaterialView interfaces
│   │   │   ├── material-view.ts     # createMaterialView(), source normalization
│   │   │   ├── material-dirty.ts    # markMaterialUboDirty()
│   │   │   ├── material-rebuild.ts  # rebuildMaterial()
│   │   │   ├── pbr/               # PBR metallic-roughness material
│   │   │   │   ├── pbr-material.ts      # PbrMaterialProps + createPbrMaterial()
│   │   │   │   ├── pbr-template.ts      # PBR shader template (WGSL generation)
│   │   │   │   ├── pbr-flags.ts         # PBR feature flag bitmask
│   │   │   │   ├── pbr-pipeline.ts      # Pipeline cache + feature flags
│   │   │   │   ├── pbr-renderable.ts    # buildPbrRenderables() + single-mesh rebuild closure
│   │   │   │   ├── no-color-view.ts # PBR no-color MaterialView helper
│   │   │   │   ├── fragments/singlelight-wgsl.ts # Non-looping one-light WGSL
│   │   │   │   ├── fragments/multilight-wgsl.ts  # Generic multi-light WGSL
│   │   │   │   ├── background-material.ts    # Skybox + Ground material factories
│   │   │   │   ├── background-renderable.ts  # Skybox + Ground → Renderables
│   │   │   │   ├── background-dds-skybox.ts  # DDS environment skybox
│   │   │   │   ├── background-hdr-skybox.ts  # HDR environment skybox
│   │   │   │   ├── background-ground.ts      # Background ground plane
│   │   │   │   └── fragments/          # PBR ShaderFragment modules
│   │   │   │       ├── clearcoat-fragment.ts
│   │   │   │       ├── emissive-fragment.ts
│   │   │   │       ├── ibl-fragment.ts
│   │   │   │       ├── morph-fragment.ts
│   │   │   │       ├── pbr-shadow-fragment.ts
│   │   │   │       ├── reflectance-fragment.ts
│   │   │   │       ├── sheen-fragment.ts
│   │   │   │       └── skeleton-fragment.ts
│   │   │   └── standard/          # Standard Blinn-Phong material
│   │   │       ├── standard-material.ts    # Types, factory, texture collection
│   │   │       ├── standard-group-builder.ts # Dynamic imports + group builder
│   │   │       ├── standard-template.ts    # Standard shader template (WGSL generation)
│   │   │       ├── standard-pipeline.ts    # Pipeline cache + feature flags
│   │   │       ├── standard-renderable.ts  # buildStandardMeshRenderables() + single-mesh rebuild closure
│   │   │       ├── no-color-view.ts # Standard no-color MaterialView helper
│   │   │       ├── skybox-cubemap.ts       # CubeMap skybox for StandardMaterial scenes
│   │   │       └── fragments/             # Standard ShaderFragment modules
│   │   │           ├── normal-map-fragment.ts
│   │   │           ├── std-ambient-fragment.ts
│   │   │           ├── std-emissive-fragment.ts
│   │   │           ├── std-lightmap-fragment.ts
│   │   │           ├── std-opacity-fragment.ts
│   │   │           ├── std-reflection-fragment.ts
│   │   │           ├── std-shadow-fragment.ts
│   │   │           └── std-specular-fragment.ts
│   │   ├── grid/                  # Procedural grid material
│   │   │   └── grid-material.ts   # createGridMaterial() + GridMaterialOptions (on ShaderMaterial)
│   │   ├── shader/                # Shader composition system
│   │   │   ├── shader-composer.ts # ShaderFragment composer engine
│   │   │   ├── fragment-types.ts  # ShaderFragment interface definitions
│   │   │   ├── ubo-layout.ts     # UBO layout helpers
│   │   │   ├── wgsl-helpers.ts   # WGSL code-gen utilities
│   │   │   └── fragments/        # Shared shader fragments
│   │   │       └── thin-instance-fragment.ts
│   │   ├── render/
│   │   │   ├── renderable.ts      # Renderable, PrePassRenderable, SceneUniformUpdater
│   │   │   ├── scene-helpers.ts   # Shared helper utilities
│   │   │   └── lights-ubo.ts     # Multi-light UBO packing
│   │   ├── effect/
│   │   │   └── effect-renderer.ts # EffectWrapper fullscreen passes + RenderTarget output
│   │   ├── mesh/
│   │   │   ├── mesh.ts            # Mesh type and GPU upload
│   │   │   ├── mesh-factories.ts  # High-level createSphere/Box/Torus/Ground/Cylinder/Plane/Disc/Polyhedron/Ribbon/Tube/Extrude
│   │   │   ├── path3d.ts          # Path3D parallel-transport frames (used by tube/extrude)
│   │   │   ├── thin-instance.ts   # Thin instance CPU data model + public API
│   │   │   ├── thin-instance-gpu.ts # GPU buffer sync (lazy-loaded by renderable)
│   │   │   ├── create-sphere.ts   # Sphere geometry generator
│   │   │   ├── create-box.ts      # Box geometry generator
│   │   │   ├── create-torus.ts    # Torus geometry generator
│   │   │   └── create-ground.ts   # Ground/heightmap geometry generator
│   │   ├── skeleton/
│   │   │   ├── create-skeleton.ts   # Skeleton data creation from glTF
│   │   │   └── skeleton-updater.ts  # Joint matrix computation for skinned meshes
│   │   ├── animation/
│   │   │   ├── animation-manager.ts   # Generic AnimationTask scheduler
│   │   │   ├── animation-group.ts     # AnimationGroup state and playback helpers
│   │   │   ├── animation-group-task.ts # AnimationGroup → AnimationTask adapter
│   │   │   ├── property-animation.ts  # User-authored property animation clips
│   │   │   ├── evaluate.ts           # Keyframe interpolation (step, linear, cubic)
│   │   │   └── types.ts              # Animation type definitions
│   │   ├── morph/
│   │   │   └── create-morph-targets.ts # Morph target data + GPU texture
│   │   ├── picking/
│   │   │   ├── gpu-picker.ts        # createGpuPicker() — GPU ID-pass picking
│   │   │   ├── picking-pipeline.ts  # Picking render pipeline
│   │   │   ├── picking-shader.ts    # Picking WGSL shaders
│   │   │   ├── picking-helpers.ts   # getPickedNormal(), getPickedUV()
│   │   │   ├── picking-info.ts      # PickingInfo type
│   │   │   ├── detailed-picking.ts  # enableDetailedPicking() — CPU ray/triangle
│   │   │   └── ray.ts              # Ray intersection math
│   │   ├── resource/
│   │   │   └── gpu-pool.ts         # GPU buffer/texture pooling
│   │   ├── shadow/
│   │   │   ├── shadow-base.ts       # Shared shadow logic
│   │   │   ├── shadow-generator.ts  # ShadowGenerator contract
│   │   │   ├── esm-directional-shadow-generator.ts # Directional ESM shadow generator
│   │   │   ├── pcf-spotlight-shadow-generator.ts # Spot PCF shadow generator
│   │   │   └── pcf-directional-shadow-generator.ts # Directional PCF shadow generator
│   │   ├── frame-graph/
│   │   │   ├── task.ts              # Frame-graph task interface
│   │   │   ├── frame-graph.ts       # Ordered task list
│   │   │   ├── frame-graph-actions.ts # addTask helpers
│   │   │   └── render-task.ts  # Render-pass task + per-pass scene UBO
│   │   ├── texture/
│   │   │   ├── texture-2d.ts      # 2D texture loader
│   │   │   ├── solid-texture.ts   # 1×1 solid-color texture factory
│   │   │   ├── cube-texture.ts    # 6-face cube texture loader
│   │   │   ├── rtt.ts             # Eager render-target texture helper
│   │   │   ├── ktx2-loader.ts      # KTX2/BasisU upload for KHR_texture_basisu
│   │   │   ├── mip-count.ts        # Biased mip-count helper
│   │   │   └── generate-mipmaps.ts # GPU mipmap generation
│   │   ├── loader-gltf/
│   │   │   ├── load-gltf.ts       # GLB parser, GPU upload
│   │   │   ├── gltf-parser.ts     # glTF JSON parsing helpers
│   │   │   ├── gltf-material.ts   # glTF material → PbrMaterialProps
│   │   │   ├── gltf-ext-basisu.ts # KHR_texture_basisu dynamic feature
│   │   │   ├── gltf-interleave.ts # native interleaved VB support (lazy de-stride)
│   │   │   ├── gltf-feature-meshopt.ts # EXT_meshopt_compression dynamic feature
│   │   │   ├── gltf-ext-quantization.ts # KHR_mesh_quantization dynamic feature
│   │   │   ├── gltf-feature-xmp.ts # KHR_xmp_json_ld metadata dynamic feature
│   │   │   └── gltf-animation.ts  # glTF animation extraction
│   │   ├── loader-env/
│   │   │   ├── load-env.ts        # .env parser, RGBD decode, cubemap upload
│   │   │   ├── load-dds-env.ts    # DDS environment loading
│   │   │   ├── env-helpers.ts     # Environment helper utilities
│   │   │   └── rgbd-decode.ts     # RGBD decode helpers
│   │   ├── loader-hdr/
│   │   │   ├── load-hdr.ts        # loadHdrEnvironment() — HDR environment pipeline
│   │   │   ├── hdr-parser.ts      # RGBE file parser
│   │   │   └── hdr-ibl-pipeline.ts # GPU compute IBL from HDR
│   │   ├── loader-babylon/
│   │   │   └── load-babylon.ts    # loadBabylon() — .babylon format parser
│   │   └── loader-skybox/
│   │       ├── load-skybox.ts     # High-level skybox loader
│   │       └── skybox-renderable.ts # Skybox → deferred Renderable builder
│   │
├── lab/               # Dev sandbox (Scenes 1–175)
│   ├── index.html
│   ├── src/lite/scene1.ts          # Scene 1: BoomBox PBR
│   ├── src/lite/scene2.ts          # Scene 2: Sphere + DirectionalLight
│   ├── ...                         # Scenes 3–175
│   ├── src/lite/scene74.ts         # Scene 74: EffectRenderer fullscreen pass
│   ├── src/lite/scene75.ts         # Scene 75: EffectWrapper render-to-texture sphere
│   ├── src/lite/scene76.ts         # Scene 76: EffectWrapper texture binding
│   ├── src/lite/scene112.ts        # Scene 112: FlightHelmetKTX / KHR_texture_basisu
│   ├── src/lite/scene120.ts        # Scene 120: Gaussian splatting
│   ├── src/lite/scene159.ts        # Scene 159: ShaderMaterial basic
│   ├── src/lite/scene164.ts        # Scene 164: device-loss recovery
│   ├── src/lite/scene175.ts        # Scene 175: navigation raycast
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
│
├── reference/lite/                     # Per-scene reference data
│   ├── scene1-boombox/            # Scene 1 reference data
│   ├── scene2-sphere/             # Scene 2 reference data
│   ├── ...                        # Scenes 3–175
│   ├── scene74-effect-renderer/   # EffectRenderer fullscreen golden
│   ├── scene75-effect-rtt-sphere/ # EffectWrapper RTT golden
│   ├── scene76-effect-texture/    # EffectWrapper texture-binding golden
│   ├── scene112-khr-texture-basisu/ # KHR_texture_basisu golden
│   ├── scene120-gaussian-splatting/ # Gaussian splatting golden
│   ├── scene164-device-lost-recovery/ # Device-loss recovery golden
│   ├── scene175-navigation-raycast/ # Navigation raycast golden
│   └── (each contains golden screenshots for parity tests)
│
└── docs/lite/architecture/
    └── 00-overview.md             # THIS FILE
```

---

## 2. 公共 API 界面

均导出自 `packages/babylon-lite/src/index.ts`。该 API 在体感上应尽量贴近 Babylon.js，但完全由纯函数和普通数据类型组成。

> 本节是对最常用入口点的**精选签名级导览**。如需查阅涵盖每一个导出项（函数、类型与完整签名）的**完整且实时更新的 API 参考**，请访问自动生成的 TypeDoc 站点：**<https://doc.babylonjs.com/lite/typedoc>**。

### 函数

```typescript
// Engine lifecycle
createEngine(canvas: HTMLCanvasElement): Promise<Engine>

// Scene
createSceneContext(engine: Engine): SceneContext
createDefaultCamera(scene: SceneContext): ArcRotateCamera
removeFromScene(scene: SceneContext, entity: Mesh | ...): void
setEnvironmentRotation(scene: SceneContext, rotation: number): void
setEnvironmentLightingRotation(scene: SceneContext, rotation: number): void
setEnvironmentSkyboxRotation(scene: SceneContext, rotation: number): void

// Camera — pure data; controls can register per-frame updates on a scene
createArcRotateCamera(alpha: number, beta: number, radius: number, target: Vec3): ArcRotateCamera
attachControl(camera: ArcRotateCamera, canvas: HTMLCanvasElement, scene?: SceneContext, options?: AttachControlOptions): () => void
createFreeCamera(position: Vec3, target: Vec3): FreeCamera
attachFreeControl(camera: FreeCamera, canvas: HTMLCanvasElement, scene?: SceneContext): () => void

// Loaders — note: loadGltf and loadBabylon take Engine, not SceneContext
loadGltf(engine: Engine, source: string | ArrayBuffer | Blob): Promise<AssetContainer>
loadEnvironment(scene: SceneContext, url: string, options: {
    brdfUrl: string;
    groundTextureUrl?: string;
    skipSkybox?: boolean;
    skipGround?: boolean;
    skyboxUrl?: string;
    skyboxSize?: number;
}): Promise<EnvironmentTextures>
loadHdrEnvironment(scene: SceneContext, url: string, options?: HdrLoadOptions): Promise<EnvironmentTextures>
loadBabylon(engine: Engine, url: string, opts?: LoadBabylonOptions): Promise<AssetContainer>
loadTexture2D(engine: Engine, url: string, options?: Texture2DOptions): Promise<Texture2D>
loadSkybox(scene: SceneContext, baseUrl: string, ext: string, size?: number): Promise<void>

// Texture factories
createSolidTexture2D(engine: Engine, r: number, g: number, b: number, a?: number): Texture2D

// EffectRenderer-style fullscreen passes
createEffectWrapper(engine: Engine, options: EffectWrapperOptions): EffectWrapper
setEffectUniforms(wrapper: EffectWrapper, data: ArrayBuffer | ArrayBufferView | Record<string | number, ArrayBuffer | ArrayBufferView>): void
setEffectTexture(wrapper: EffectWrapper, bindingNameOrIndex: string | number, texture: Texture2D): void
createEffectRenderer(engine: Engine, effect: EffectWrapper, options?: EffectRendererOptions): EffectRenderer
registerEffectRenderer(renderer: EffectRenderer): void
unregisterEffectRenderer(renderer: EffectRenderer): void
disposeEffectRenderer(renderer: EffectRenderer): void
createEffectRenderTask(config: EffectRenderTaskConfig, engine: Engine, scene: SceneContext): EffectRenderTask
disposeEffectWrapper(wrapper: EffectWrapper): void
createUniformEffectWrapper(engine: Engine, options: UniformEffectWrapperOptions): UniformEffectWrapper
setUniformEffectUniforms(wrapper: UniformEffectWrapper, data: ArrayBuffer | ArrayBufferView): void
createUniformEffectRenderTask(config: UniformEffectRenderTaskConfig, engine: Engine, scene?: SceneContext): UniformEffectRenderTask
disposeUniformEffectWrapper(wrapper: UniformEffectWrapper): void

// Lights
createHemisphericLight(direction?: [number,number,number], intensity?: number): HemisphericLight
createPointLight(position: [number,number,number], intensity?: number): PointLight
createDirectionalLight(direction: [number,number,number], intensity?: number): DirectionalLight
createSpotLight(
    position: [number,number,number],
    direction: [number,number,number],
    angle: number,
    exponent: number,
    intensity?: number,
): SpotLight

// Mesh factories
createSphere(engine: Engine, options?: SphereOptions): Mesh
createBox(engine: Engine, size?: number): Mesh
createTorus(engine: Engine, options?: TorusOptions): Mesh
createCylinder(engine: Engine, options?: CylinderOptions): Mesh
createPlane(engine: Engine, options?: PlaneOptions): Mesh
createDisc(engine: Engine, options?: DiscOptions): Mesh
createPolyhedron(engine: Engine, options?: PolyhedronOptions): Mesh
createRibbon(engine: Engine, options: RibbonOptions): Mesh
createTube(engine: Engine, options: TubeOptions): Mesh
createExtrudeShape(engine: Engine, options: ExtrudeShapeOptions): Mesh
createGround(engine: Engine, options?: GroundOptions): Mesh
createGroundFromHeightMap(engine: Engine, url: string, options: GroundOptions): Promise<Mesh>
getMeshGeometry(mesh: Mesh): {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    uvs?: Float32Array;
    uvs2?: Float32Array;
    tangents?: Float32Array;
    colors?: Float32Array;
} | null

// Materials
createStandardMaterial(): StandardMaterialProps
createPbrMaterial(props?: Partial<PbrMaterialProps>): PbrMaterialProps

// Shadows — generators own GPU resources; caster lists are ShadowTask inputs
registerSceneWithShadowSupport(engine: Engine, scene: SceneContext): Promise<void>
createEsmDirectionalShadowGenerator(engine: Engine, light: DirectionalLight, config?: EsmDirectionalShadowGeneratorConfig): ShadowGenerator
createPcfSpotlightShadowGenerator(engine: Engine, light: SpotLight, config?: PcfSpotlightShadowGeneratorConfig): ShadowGenerator
createPcfDirectionalShadowGenerator(engine: Engine, light: DirectionalLight, config?: PcfDirectionalShadowGeneratorConfig): ShadowGenerator
setShadowTaskCasterMeshes(shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]): void
setShadowCasterMaxCascade(mesh: Mesh, maxCascade: number): void

// Animation
createAnimationController(skeleton, scene): AnimationController
createAnimationGroups(gltfData, meshes, scene): AnimationGroup[]
goToFrame(group: AnimationGroup, frame: number, engine?: EngineContext): void

// Hierarchy
setParent(child: IParentable, parent: IWorldMatrixProvider | null, scene: SceneContext): void
createTransformNode(name: string, scene: SceneContext): TransformNode
cloneTransformNode(node: TransformNode, scene: SceneContext): TransformNode
collectMeshes(node: TransformNode): Mesh[]

// Math
createTranslationMat4(x: number, y: number, z: number): Mat4
createIdentityMat4(): Mat4
createScalingMat4(sx: number, sy: number, sz: number): Mat4
composeMat4(tx,ty,tz, qx,qy,qz,qw, sx,sy,sz): Mat4

// Thin Instances
addThinInstance(mesh: Mesh, matrix: Mat4): number
removeThinInstance(mesh: Mesh, index: number): void
setThinInstanceMatrix(mesh: Mesh, index: number, matrix: Mat4): void
setThinInstances(mesh: Mesh, matrices: Mat4[]): void
flushThinInstances(mesh: Mesh): void
setThinInstanceColors(mesh: Mesh, colors: Float32Array): void

// Picking
createGpuPicker(engine: Engine, scene: SceneContext): GpuPicker
enableDetailedPicking(mesh: Mesh): void
getPickedNormal(info: PickingInfo): Vec3
getPickedUV(info: PickingInfo): [number, number]
```

### 类型

```typescript
// ─── Engine ──────────────────────────────────────────────────────────
// Note: GPU internals (device, context, format) are @internal and not exposed.
interface EngineContext {
    readonly canvas: HTMLCanvasElement;
    readonly msaaSamples: number; // always 4
    drawCallCount: number; // GPU draw calls in latest renderFrame call, across its selected surfaces
}

// ─── Scene ───────────────────────────────────────────────────────────
interface SceneContext {
    readonly engine: Engine;
    clearColor: GPUColorDict;
    camera: ArcRotateCamera | FreeCamera | null;
    lights: LightBase[]; // All light types (HemisphericLight, PointLight, etc.)
    meshes: Mesh[];
    animationGroups: AnimationGroup[];
    fog: FogConfig | null;
    shadowGenerators: ShadowGenerator[];
    imageProcessing: ImageProcessingConfig;
    environmentPrimaryColor?: [number, number, number];
    fixedDeltaMs: number; // Fixed delta for deterministic animation (0 = real time)

    // Internal renderable lists
    _renderables: Renderable[];
    _opaqueRenderables: Renderable[];
    _transparentRenderables: Renderable[];
    _prePasses: PrePassRenderable[];
    _uniformUpdaters: SceneUniformUpdater[];
    _fixedDeltaMs: number;
    _beforeRender: ((deltaMs: number) => void)[];
    _deferredBuilders: (() => void | Promise<void>)[];
}

// ─── Cameras ─────────────────────────────────────────────────────────
interface ArcRotateCamera {
    alpha: number; // Horizontal rotation (azimuth)
    beta: number; // Vertical angle from top pole (0=top, π=bottom)
    radius: number; // Distance from target
    target: Vec3; // Look-at point (ObservableVec3 at runtime)
    fov: number; // Vertical FOV in radians
    nearPlane: number; // Near clip plane
    farPlane: number; // Far clip plane
    inertia: number; // Rotation + zoom inertia (0=instant, 0.9=default)
    panningInertia: number; // Panning inertia
    inertialAlphaOffset: number;
    inertialBetaOffset: number;
    inertialRadiusOffset: number;
    inertialPanningX: number;
    inertialPanningY: number;
}

interface FreeCamera {
    position: ObservableVec3; // Camera world position
    target: ObservableVec3; // Look-at target
    speed: number; // Movement speed (default 2.0, matches BJS)
    angularSensitivity: number; // Mouse rotation sensitivity (default 2000)
    inertia: number; // Damping factor (0=instant, 0.9=default)
    fov: number;
    nearPlane: number;
    farPlane: number;
}

interface Camera {
    /* Union: ArcRotateCamera | FreeCamera */
}

function getViewMatrix(camera: Camera): Mat4;
function getProjectionMatrix(camera: Camera, aspectRatio: number): Mat4;
function getViewProjectionMatrix(camera: Camera, aspectRatio: number): Mat4;
function getCameraPosition(camera: Camera): Vec3;

// ─── Lights ──────────────────────────────────────────────────────────
interface LightBase {
    readonly lightType: string;
    intensity: number;
    excludedMeshIds?: ReadonlySet<string>;
    includedOnlyMeshIds?: ReadonlySet<string>;
    shadowGenerator?: ShadowGenerator;
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

interface HemisphericLight extends LightBase {
    readonly lightType: "hemispheric";
    direction: ObservableVec3;
    intensity: number;
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor: [number, number, number];
}

interface PointLight extends LightBase {
    readonly lightType: "point";
    position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

interface DirectionalLight extends LightBase {
    readonly lightType: "directional";
    direction: ObservableVec3;
    position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
}

interface SpotLight extends LightBase {
    readonly lightType: "spot";
    position: ObservableVec3;
    direction: ObservableVec3;
    angle: number;
    exponent: number;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

// ─── Materials ───────────────────────────────────────────────────────
interface PbrMaterialProps {
    baseColorTexture?: Texture2D;
    normalTexture?: Texture2D;
    ormTexture?: Texture2D; // R=occ, G=rough, B=metal
    emissiveTexture?: Texture2D;
    _emissiveColor?: [number, number, number]; // Linear RGB emissive — set via setPbrEmissive()
    specGlossTexture?: Texture2D; // KHR_materials_pbrSpecularGlossiness
    doubleSided?: boolean;
    alpha?: number; // Overall material alpha (default 1.0)
    alphaBlend?: boolean; // Enable alpha blending (glTF BLEND)
    environmentIntensity?: number; // IBL contribution scale (default 1.0)
    directIntensity?: number; // Direct light contribution scale (default 1.0)
    usePhysicalLightFalloff?: boolean; // Direct point/spot inverse-square falloff (default true)
    reflectance?: number; // Dielectric F0 (default 0.04)
    occlusionStrength?: number; // AO strength from ORM R channel (default 1.0)
    metallicF0Factor?: number; // Dielectric F0 scale (default 1.0)
    metallicReflectanceColor?: [number, number, number]; // Tints dielectric reflectance (default [1,1,1])
    metallicReflectanceTexture?: Texture2D; // RGB=reflectance tint, A=F0 scalar
    reflectanceTexture?: Texture2D; // RGB=reflectance tint only
    useOnlyMetallicFromMetallicReflectanceTexture?: boolean;
    enableSpecularAA?: boolean; // Specular anti-aliasing on IBL alphaG
    gammaAlbedo?: boolean; // Apply pow(2.2) sRGB→linear in shader
    clearCoat?: ClearCoatProps;
    sheen?: SheenProps;
}

interface ClearCoatProps {
    isEnabled?: boolean;
    intensity?: number;
    roughness?: number;
    indexOfRefraction?: number; // Default 1.5
}

interface SheenProps {
    isEnabled: boolean;
    color?: [number, number, number];
    roughness?: number;
    intensity?: number;
    texture?: Texture2D; // Sheen tint texture (modulates color)
}

interface StandardMaterialProps {
    diffuseColor: [number, number, number];
    alpha: number;
    specularColor: [number, number, number];
    specularPower: number;
    emissiveColor: [number, number, number];
    ambientColor: [number, number, number];
    diffuseTexture: Texture2D | null;
    diffuseCoordIndex: 0 | 1;
    _emissiveTexture?: Texture2D | null; // set via setStandardEmissiveTexture()
    _bumpTexture?: Texture2D | null; // set via setStandardBumpTexture()
    bumpLevel: number;
    _specularTexture?: Texture2D | null; // set via setStandardSpecularTexture()
    specularCoordIndex: 0 | 1;
    _ambientTexture?: Texture2D | null; // set via setStandardAmbientTexture()
    ambientTexLevel: number;
    ambientCoordIndex: 0 | 1;
    _lightmapTexture?: Texture2D | null; // set via setStandardLightmapTexture()
    lightmapLevel: number;
    lightmapCoordIndex: 0 | 1;
    _opacityTexture?: Texture2D | null; // set via setStandardOpacityTexture()
    opacityLevel: number;
    opacityFromRGB: boolean;
    alphaCutOff: number;
    _reflectionTexture?: Texture2D | null; // set via setStandardReflectionTexture()
    _reflectionCubeTexture?: CubeTexture | null; // set via setStandardReflectionCubeTexture()
    reflectionLevel: number;
    reflectionCoordMode: 1 | 2;
    uvScale: [number, number];
    backFaceCulling: boolean;
    disableLighting: boolean;
}

interface FogConfig {
    mode: 0 | 1 | 2 | 3; // 0=off, 1=exp, 2=exp2, 3=linear (matches BJS Scene.FOGMODE_*)
    density: number;
    start: number;
    end: number;
    color: [number, number, number];
}

interface ImageProcessingConfig {
    exposure: number;
    contrast: number;
    toneMappingEnabled: boolean;
}

// ─── Mesh ────────────────────────────────────────────────────────────
interface Mesh {
    boundMin?: Vec3;
    boundMax?: Vec3;
    name?: string;
    material: StandardMaterialProps | PbrMaterialProps | null;
    receiveShadows: boolean;
}
interface MeshGPU {
    /* internal GPU state */
}

// ─── Textures ────────────────────────────────────────────────────────
interface Texture2D {
    texture: GPUTexture;
    view: GPUTextureView;
    sampler: GPUSampler;
    width: number;
    height: number;
}
interface Texture2DOptions {
    mipMaps?: boolean; // Generate mipmaps (default true)
    addressModeU?: GPUAddressMode; // Default 'repeat'
    addressModeV?: GPUAddressMode; // Default 'repeat'
    minFilter?: GPUFilterMode; // Default 'linear'
    magFilter?: GPUFilterMode; // Default 'linear'
    invertY?: boolean; // Flip Y axis (default true, matches BJS)
    srgb?: boolean; // Use rgba8unorm-srgb format (default false)
}

// ─── Shadows ─────────────────────────────────────────────────────────
interface ShadowGenerator {
    _shadowType: "esm" | "pcf";
    _light: LightBase;
    _config: ShadowGeneratorRuntimeConfig;
}
interface EsmDirectionalShadowGeneratorConfig {
    mapSize?: number; // Shadow map size (default 1024)
    depthScale?: number; // ESM depth exponent scale (default 50)
    bias?: number; // Shadow bias (default 0.00005)
    blurScale?: number; // Gaussian blur downscale factor (default 2)
    darkness?: number; // Shadow darkness 0–1 (default 0 = full black)
    frustumEdgeFalloff?: number;
    orthoMinZ?: number; // Ortho projection near Z (default 1)
    orthoMaxZ?: number; // Ortho projection far Z (default 10000)
    forceRefreshEveryFrame?: boolean;
}
interface PcfSpotlightShadowGeneratorConfig {
    mapSize?: number; // Shadow map size (default 512)
    bias?: number;
    darkness?: number;
    normalBias?: number;
    near?: number; // Near plane for shadow projection
    far?: number; // Far plane for shadow projection
    forceRefreshEveryFrame?: boolean;
}
interface PcfDirectionalShadowGeneratorConfig {
    mapSize?: number; // Shadow map size (default 1024)
    bias?: number;
    darkness?: number;
    normalBias?: number;
    orthoMinZ?: number; // Ortho projection near Z (default 1)
    orthoMaxZ?: number; // Ortho projection far Z (default 10000)
    forceRefreshEveryFrame?: boolean;
}

// ─── Loaders ─────────────────────────────────────────────────────────
// Unified result returned by both loadGltf() and loadBabylon()
interface AssetContainer {
    // glTF: [root TransformNode]. .babylon: flat [...meshes, ...lights]
    entities: Array<Mesh | TransformNode | LightBase>;
    animationGroups?: AnimationGroup[]; // auto-ticked by addToScene()
    clearColor?: GPUColorDict; // applied to scene.clearColor by addToScene()
}

interface EnvironmentTextures {
    specularCube: GPUTexture;
    specularCubeView: GPUTextureView;
    brdfLut: GPUTexture;
    brdfLutView: GPUTextureView;
    cubeSampler: GPUSampler;
    brdfSampler: GPUSampler;
    irradianceSH: Float32Array; // 27 floats (9 vec3 SH coefficients)
    sphericalHarmonics: {
        // Pre-scaled SH bands for shader (L00…L22)
        l00: Float32Array;
        l1_1: Float32Array;
        l10: Float32Array;
        l11: Float32Array;
        l2_2: Float32Array;
        l2_1: Float32Array;
        l20: Float32Array;
        l21: Float32Array;
        l22: Float32Array;
    };
    lodGenerationScale: number; // LOD scale for specular IBL sampling (default 0.8)
}

interface HdrLoadOptions {
    faceSize?: number; // Cubemap face size in pixels (default 256)
    useCubemapSkybox?: boolean; // Render HDR cubemap as skybox background
    skipGround?: boolean; // Skip the background ground plane
    skyboxSize?: number; // Skybox mesh size (matches BJS skyboxSize)
}

// ─── Animation ───────────────────────────────────────────────────────
interface AnimationController {
    update(deltaMs: number): void;
}
interface AnimationGroup {
    name: string;
    duration: number; // seconds
    currentTime: number; // seconds
    targetedAnimations: readonly TargetedAnimation[];
    isPlaying: boolean;
    speedRatio: number;
    loopAnimation: boolean;
    weight: number;
}
interface TargetedAnimation {
    target?: object;
    targetName?: string;
    nodeIndex?: number;
    path: string;
}
interface AnimationClip {
    /* keyframe data */
}
interface GltfAnimationData {
    /* parsed glTF animation channels */
}

// ─── Hierarchy ───────────────────────────────────────────────────────
interface TransformNode {
    name: string;
    position: ObservableVec3;
    rotation: ObservableQuat;
    scaling: ObservableVec3;
}
interface IWorldMatrixProvider {
    getWorldMatrix(): Mat4;
}
interface IParentable extends IWorldMatrixProvider {
    parent: IWorldMatrixProvider | null;
}

// ─── Thin Instances ──────────────────────────────────────────────────
interface ThinInstanceData {
    matrices: Mat4[];
    colors?: Float32Array;
}

// ─── Math ────────────────────────────────────────────────────────────
class ObservableVec3 {
    x: number;
    y: number;
    z: number;
}
class ObservableQuat {
    x: number;
    y: number;
    z: number;
    w: number;
}

// ─── Picking ─────────────────────────────────────────────────────────
interface GpuPicker {
    pick(x: number, y: number): Promise<PickingInfo | null>;
}
interface PickingInfo {
    mesh: Mesh;
    faceId: number;
    worldPosition: Vec3;
}

// ─── Low-level (advanced/custom rendering) ───────────────────────────
interface DrawUpdateContext {
    targetWidth: number;
    targetHeight: number;
    _camera?: Camera | null;
}
interface Renderable {
    order: number;
    isTransparent: boolean;
    _transmissive?: boolean;
    _direct?: boolean;
    bind(engine: Engine, target: RenderTargetSignature): DrawBinding;
}
interface DrawBinding {
    pipeline: GPURenderPipeline;
    update?(context: DrawUpdateContext): void;
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, engine: Engine): number;
}
interface PrePassRenderable {
    execute(encoder: GPUCommandEncoder, engine: Engine): number;
}
interface SceneUniformUpdater {
    update(engine: Engine): void;
}

// ─── Mesh factory options ────────────────────────────────────────────
interface SphereOptions {
    diameter?: number;
    segments?: number;
}
interface TorusOptions {
    diameter?: number;
    thickness?: number;
    tessellation?: number;
}
interface GroundOptions {
    width?: number;
    height?: number;
    subdivisions?: number;
}
```

---

## 3. 模块规范

### 3.1 核心数学（`math/`）

**坐标系**：左手坐标系（LH），与 Babylon.js 和 WebGPU 一致。

**Mat4 内存布局**：列主序（column-major），16 个连续 `f32` 值。
索引 `[col*4+row]` — 与 WGSL `mat4x4<f32>` 存储布局一致。

```
[0]  [4]  [8]  [12]     col0  col1  col2  col3
[1]  [5]  [9]  [13]  =  (X)   (Y)   (Z)   (Translation)
[2]  [6]  [10] [14]
[3]  [7]  [11] [15]
```

**关键函数**：

| 函数                                              | 签名             | 说明                                           |
| ------------------------------------------------- | ---------------- | ---------------------------------------------- |
| `createIdentityMat4()`                            | `→ Mat4`         | 16 浮点数单位矩阵                              |
| `multiplyMat4(a, b)`                              | `→ Mat4`         | 列主序 `a * b`                                 |
| `createLookAtMat4LH(eye, target, up)`             | `→ Mat4`         | 左手观察矩阵，`zAxis = normalize(target - eye)` |
| `createPerspectiveMat4LH(fov, aspect, near, far)` | `→ Mat4`         | 0 到 1 深度范围，`tan = 1/tan(fov/2)`          |
| `invertMat4(m)`                                   | `→ Mat4 \| null` | 通过代数余子式求 4x4 矩阵逆                    |
| `composeMat4(tx,ty,tz, qx,qy,qz,qw, sx,sy,sz)`    | `→ Mat4`         | TRS 组合                                       |
| `createMat4FromQuat(qx,qy,qz,qw)`                 | `→ Mat4`         | 四元数转旋转矩阵                               |
| `writeMat4FromQuatIntoBuffer(out, qx,qy,qz,qw)`   | `→ out`          | 零分配四元数转旋转矩阵                         |

**LookAtLH 公式**（与 Babylon.js `Matrix.LookAtLHToRef` 一致）：

```
zAxis = normalize(target - eye)          // forward
xAxis = normalize(cross(up, zAxis))      // right
yAxis = cross(zAxis, xAxis)              // up
M = | xAxis.x  yAxis.x  zAxis.x  0 |    (stored column-major)
    | xAxis.y  yAxis.y  zAxis.y  0 |
    | xAxis.z  yAxis.z  zAxis.z  0 |
    | -dot(x,eye)  -dot(y,eye)  -dot(z,eye)  1 |
```

**PerspectiveLH 公式**（0 到 1 深度范围，与 `Matrix.PerspectiveFovLHToRef` 一致）：

```
f = 1 / tan(fov / 2)
M = | f/aspect  0  0              0 |
    | 0         f  0              0 |
    | 0         0  far/(far-near) 1 |
    | 0         0  -far*near/(far-near) 0 |
```

### 3.2 引擎（`engine/engine.ts`）

**职责**：获取 GPUDevice、配置交换链（swapchain）、管理 MSAA 渲染目标、驱动渲染循环。

**初始化序列**：

1. `navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })`
2. `adapter.requestDevice({ requiredFeatures })` — 普通创建会启用 Lite 的机会性（opportunistic）特性集；`createEngineWithFeatures` 则会添加显式要求开启的特性。使用已准备好的 `DeviceContext` 调用 `createEngine(canvas, { device })` 时，会跳过上述两步设备获取步骤。
3. `canvas.getContext('webgpu')` → 使用 `options?.alphaMode ?? 'opaque'` 进行配置
4. 存储引擎渲染状态（`msaaSamples`、已注册上下文、临时命令编码器/交换链视图）

**MSAA 配置**：

- 颜色目标：`format = navigator.gpu.getPreferredCanvasFormat()`（通常为 `bgra8unorm`），`sampleCount = 4`
- 深度目标：`depth24plus-stencil8`，`sampleCount = 4`
- 画布渲染目标由帧图 `RenderTask` 拥有。若 `sampleCount > 1`，任务会持有 MSAA 颜色纹理，并在每帧解析（resolve）到交换链纹理。

**渲染循环**（在 `registerScene(scene)` 之后调用 `startEngine(engine)` —— 异步，返回 `Promise<void>`）：

```
registerScene runs deferred builders → requestAnimationFrame → resize() → renderFrame() → requestAnimationFrame ...
```

**`renderFrame(engine, delta, surfaces?)`**：

- 省略 `surfaces`：按注册顺序渲染 `engine.surfaces` 中的每一个 surface
- 传入非空只读元组：在同一个命令编码器/提交中严格按调用方顺序仅渲染这些 surfaces
- 在创建命令编码器之前先校验显式元组的所有权，因为跨设备渲染否则会在稍后才触发晦涩的 WebGPU 验证错误；默认的引擎自持列表无需所有权校验
- 显式元组中的成员在调用返回前必须保持已注册状态，且已注册与唯一性仍作为调用方前置条件，以避免热路径上的注册扫描、重复处理及归一化分配；可缓存一个单元素元组来实现无逐帧分配的单 surface 渲染
- 默认的 `engine.surfaces` 列表是实时动态的：如果前面的 surface 回调销毁了后续的 surface，则在剩余的帧渲染与截帧循环中会跳过该后续 surface

1. 创建命令编码器并将其暴露为 `engine._currentEncoder`
2. 对所选 surfaces 上的每个渲染上下文执行 `_update()`：
    - 渲染前回调、材质热切换、阴影生成器、传统预通道、共享 Uniform 更新器
3. 对所选 surfaces 上的每个渲染上下文执行 `_record()`：
    - `scene._frameGraph.execute()` 依次排空并执行其有序任务

- 每个 `RenderTask` 获取/修补交换链或 RTT 视图，写入其逐通道场景 Uniform Buffer（UBO），调用 `DrawBinding.update({ targetWidth, targetHeight, _camera })`，并绘制按桶分组的 `DrawBinding`

4. 提交命令缓冲区

**尺寸调整（Resize）**：检查 `canvas.clientWidth * devicePixelRatio`，若发生变化则更新画布后备存储尺寸，随后通知已注册上下文重建依赖画布尺寸的帧图渲染目标。

### 3.3 场景（`scene/scene.ts`）

一个包含可渲染对象数组的扁平数据结构。没有层级结构，没有回调逻辑。

```typescript
{
  engine,                        // readonly ref to Engine
  clearColor: {r:0.2, g:0.2, b:0.3, a:1.0},
  camera: null,                  // set by caller
  lights: [],                    // LightBase[] — all light types
  meshes: [],                    // Mesh[] — all meshes (standard + PBR)
  animationGroups: [],           // AnimationGroup[] — glTF animation groups
  fog: null,                     // FogConfig | null
  shadowGenerators: [],          // ShadowGenerator[]
  imageProcessing: { exposure: 1.0, contrast: 1.0, toneMappingEnabled: false },
  _renderables: [],              // Renderable[] — all renderables (combined)
  _opaqueRenderables: [],        // Renderable[] — sorted by order
  _transparentRenderables: [],   // Renderable[] — sorted back-to-front each frame
  _prePasses: [],                // PrePassRenderable[] — shadow passes etc.
  _uniformUpdaters: [],          // SceneUniformUpdater[] — per-frame UBO updates
  _deferredBuilders: [],         // (() => void | Promise<void>)[] — drained by buildScene() during registerScene()
  _fixedDeltaMs: 0,              // fixed delta for animation (0 = use real time)
  _beforeRender: [],             // ((deltaMs: number) => void)[] — per-frame callbacks
}
```

**注册**：`addToScene(scene, entity)` 按类型分发——`Mesh`、`LightBase`、`ShadowGenerator` 或 `TransformNode`（会递归添加其包含的所有网格）。
**延迟构建器**：在 `startEngine()` 时运行一次以创建管线和绑定组。

### 3.4 相机（`camera/arc-rotate.ts`）

**ArcRotateCamera** — 使用球面坐标绕目标点旋转。

**位置公式**（与 Babylon.js `ArcRotateCamera._getViewMatrix` 一致）：

```
position = target + Vector3(
  radius * cos(alpha) * sin(beta),
  radius * cos(beta),
  radius * sin(alpha) * sin(beta)
)
```

**`createDefaultCamera(scene)`** 自动对已加载网格取景：

1. 根据所有 `scene.meshes[].boundMin/boundMax` 计算世界 AABB 包围盒
2. `target = center of AABB`
3. `worldSize = max - min`
4. `radius = length(worldSize) * 1.5`
5. `alpha = -π/2`, `beta = π/2`（与 Babylon 的 `createDefaultCameraOrLight` 一致）
6. `fov = 0.8`（Babylon 默认值）
7. `nearPlane = 0.1`, `farPlane = 1000`

Playground 随后会覆盖设置：`camera.alpha = 1.77538207638442`

### 3.5 灯光（`light/hemispheric.ts`）

纯数据工厂。返回一个包含以下字段的 `HemisphericLight`：

- `direction: ObservableVec3(0, 1, 0)`（朝上）
- `intensity: 1.0`
- `diffuseColor: [1, 1, 1]`（天空/顶部）
- `specularColor: [1, 1, 1]`（高光颜色）
- `groundColor: [0, 0, 0]`（底部）

着色器中的半球光模型：

```
hemiNdotL = dot(N, lightDir) * 0.5 + 0.5    // remap [-1,1] → [0,1]
hemiColor = mix(groundColor, diffuseColor, hemiNdotL)
contribution = hemiColor * intensity
```

### 3.6 材质（`material/pbr/`、`material/standard/`）

**设计原则**：材质拥有着色器。引擎绝不导入 WGSL 或材质代码——它只遍历抽象的 `Renderable` 接口。

**动态着色器组合**：PBR 与 Standard 材质均采用组合器（composer）模式——由 TypeScript 函数根据特性标志拼装 WGSL 字符串。只会生成给定网格所需特性的代码块。没有超级着色器（uber shader），PBR/Standard 也没有原始 `.wgsl` 文件。

**PBR 特性标志**：`PBR_HAS_NORMAL_MAP` (1<<0)、`PBR_HAS_EMISSIVE` (1<<1)、`PBR_HAS_ENV` (1<<2)。

**Standard 特性标志**：`HAS_DIFFUSE_TEXTURE` (1<<0)、`HAS_EMISSIVE_TEXTURE` (1<<1)、`RECEIVE_SHADOWS` (1<<2)。

**管线缓存**：两种材质均按 `(features, format, msaaSamples)` 元组缓存渲染管线。具有相同特性的网格共享同一条管线。

**材质视图（Material views）**：`MaterialView` 是基于源材质构建的轻量级、通道特定的材质兼容对象。它仅拥有材质渲染特性位（`features`、可选的 `features2`），保留指向源材质的 `source` 指针，并通过原型链从源材质继承纹理、UBO 数据/版本号、采样器、Alpha/剔除状态、扩展数据以及 `_buildGroup`。渲染任务可以将材质视图传入 `addMeshToTask(task, mesh, { material })`，从而用不同的材质特性集（例如阴影深度生成）绘制同一个网格，而无需修改 `mesh.material` 或复制整个材质。常规渲染路径直接读取材质，不保留任何材质视图解包分支。

**材质变更**：仅涉及标量/向量 UBO 的变更调用 `markMaterialUboDirty(materialOrView)`，它会递增源材质的 `_uboVersion`，使所有可渲染对象/视图都能独立感知更新。涉及特性/布局的变更调用 `rebuildMaterial(scene, materialOrView)`，它会重建受影响的网格可渲染对象，并在默认情况下同步重建由同一源材质派生的视图。

**绑定组布局（场景 group 0）**：binding 0 为 `RenderTask` 持有的逐通道 `SceneUniforms` UBO；binding 1 为场景持有的 `LightsUniforms` UBO。

**绑定组布局（PBR group 1）**：按顺序分配绑定槽位——网格 UBO（世界矩阵 + 逐网格灯光索引）、baseColor、[normal]、ORM、[emissive]、[BRDF LUT, IBL cube]。绑定数量随启用特性而变化。

**绑定组布局（Standard group 1）**：网格 UBO（世界矩阵 + 逐网格灯光索引）、材质 UBO、[diffuse texture]、[shadow/UV UBO]、[emissive texture]。Group 2 = 阴影贴图（若启用阴影）。

### 3.7 可渲染对象架构（`render/renderable.ts`）

**实体自持管线**：每个材质/实体自行创建管线并返回 `Renderable` 对象。场景持有的 `RenderTask` 调用 `renderable.bind(engine, target)` 创建与目标匹配的 `DrawBinding`；引擎与帧图从不导入材质代码。

```typescript
interface DrawUpdateContext {
    targetWidth: number;
    targetHeight: number;
    _camera?: Camera | null;
}
interface Renderable {
    order: number;
    isTransparent: boolean;
    _transmissive?: boolean;
    _direct?: boolean;
    bind(engine, target): DrawBinding;
}
interface MaterialView {
    source: Material;
    _renderFeatures: { features: number; features2?: number };
}
interface DrawBinding {
    pipeline: GPURenderPipeline;
    update?(context: DrawUpdateContext): void;
    draw(pass, engine): number;
}
interface PrePassRenderable {
    execute(encoder, engine): number;
}
interface SceneUniformUpdater {
    update(engine): void;
}
```

**绘制顺序**：天空盒/背景 (0) → 不透明渲染束 (100) → 非透明直接绘制（动态深度写入批次） → 透明 + 透射（按相机空间深度从后向前排序）。

**延迟构建**：实体将构建器注册到 `scene._deferredBuilders`。`registerScene()` 在场景注册前调用 `buildScene()` 排空这些构建器，随后构建场景帧图。

### 3.8 glTF 加载器（`loader-gltf/load-gltf.ts`）

解析 GLB/glTF 容器（glTF 2.0）。并非大而全的通用加载器——针对参考场景中遇到的网格进行了高度优化。返回一个资产容器，其根节点可直接传入 `addToScene()`。

可选的 glTF 能力以动态特性模块（`gltf-ext-*.ts` / `gltf-feature-*.ts`）形式组织。`load-gltf.ts` 会检查 `extensionsUsed`、材质和图元，仅动态导入当前资产实际需要的模块。`KHR_texture_basisu` 由 `gltf-ext-basisu.ts` 处理，它会在核心图像解析前剥离 KTX2 textureInfos，并通过 `texture/ktx2-loader.ts` 上传；不使用该扩展的场景不会下载任何相关代码块。

**纹理缓存**：纹理按位图标识 + sRGB 标志缓存，避免重复上传 GPU。热路径使用数值键（`bitmapId * 2 + +srgb`）；特性模块可维护各自扩展数据源的缓存。

**动画提取**：通过 `createAnimationGroups()` 从 glTF 动画创建 `AnimationGroup[]`。`addToScene()` 会注册场景逐帧回调进行播放；独立工作流可通过 `addAnimationGroups()` 将同样的动画组注册到 `AnimationManager`。

**GLB 容器格式**：

```
[Header: 12B]  magic=0x46546c67, version=2, totalLength
[JSON chunk]   type=0x4E4F534A, length, UTF-8 JSON payload
[BIN chunk]    type=0x004E4942, length, binary blob
```

**访问器（Accessor）解析**：

```
byteOffset = bufferView.byteOffset + accessor.byteOffset
TypedArray = new T(binChunk.buffer, binChunk.byteOffset + byteOffset, count * componentCount)
```

**组件类型**：FLOAT=5126、UNSIGNED_SHORT=5123、UNSIGNED_INT=5125、UNSIGNED_BYTE=5121

**网格提取流程**：

1. 发现动态特性模块（`KHR_texture_basisu`、Draco、variants、skins、morphs 等）
2. 运行特性的 `preMesh` 钩子以解码由特性持有的图元数据（例如 FlightHelmetKTX 使用的跨步 FLOAT 访问器）
3. 遍历节点 → 找到带有 `mesh` 属性的节点
4. 通过节点 TRS + 父级链计算世界矩阵
5. 解析访问器：POSITION、NORMAL、TANGENT、TEXCOORD_0、indices
6. 解析材质：pbrMetallicRoughness 纹理 → ImageBitmap（带 `colorSpaceConversion: 'none'`）以及扩展持有的覆盖项

**GPU 上传**：

- 顶点/索引缓冲区：`mappedAtCreation`，拷贝字节，取消映射
- 纹理：`copyExternalImageToTexture`（`premultipliedAlpha: false`，`rgba8unorm` 或 `rgba8unorm-srgb`）
- KTX2 纹理：针对 `KHR_texture_basisu`，由 `uploadKtx2Texture2D()` 上传解码器提供的 mip 链
- Mipmap：普通图像纹理通过 GPU blit 生成；KTX2 纹理直接保留解码器输出的 mip 链
- 空纹理 → 1×1 不透明白色回退纹理
- 包围盒：上传期间由位置乘以世界矩阵计算得出

**BoomBox.glb 规格（场景 1）**：

- 1 个网格图元：18,108 个索引，3,575 个顶点
- 4 个顶点属性：position (f32x3)、normal (f32x3)、tangent (f32x4)、uv (f32x2)
- 4 张纹理：baseColor (2048²)、normal (2048²)、metallicRoughness (2048²)、emissive (2048²)
- 来自 glTF 节点的世界矩阵：`[-1,0,0,0, 0,1,0,0, 0,0,-1,0, 0,0,0,1]`（绕 Y 轴旋转 180°）
- ORM 打包：metallicRoughness 纹理的通道为 R=遮蔽，G=粗糙度，B=金属度

### 3.9 环境加载器（`loader-env/load-env.ts`）

**Babylon.js `.env` 格式**：

```
[Magic: 8B]  0x86 0x16 0x87 0x96 0xF6 0xD6 0x96 0x36
[JSON manifest: variable]  UTF-8, null-terminated
[Binary image data: rest]  Concatenated PNG/WebP face images
```

**Manifest 结构**（相关字段）：

```json
{
  "width": 256,
  "imageType": "image/png",
  "irradiance": { "x": [...], "y": [...], ... "xy": [...] },
  "specular": {
    "lodGenerationScale": 0.8,
    "mipmaps": [ { "position": 0, "length": 12345 }, ... ]
  }
}
```

**面图像**：`mipmaps` 数组是扁平排列的：`[mip0_face0, mip0_face1, ..., mip0_face5, mip1_face0, ...]`。
每个条目包含 `position`（相对二进制起始位置的偏移量）和 `length`（字节数）。

**RGBD 编码**：各面采用 RGBD 编码（8 位中的 HDR）。解码方式：`hdr.rgb = rgbd.rgb / max(rgbd.a, ε)`。
在片元着色器中解码，而非上传期间解码。

**立方体贴图上传**：`rgba8unorm`，完整 mip 链。所有面均通过 `copyExternalImageToTexture` 上传，设置 `premultiplyAlpha: false`、`colorSpaceConversion: 'none'`。

**BRDF LUT 生成**：初始化时在 CPU 计算（无 CDN 依赖）。

- 256×256 `rgba8unorm` 纹理
- Split-sum BRDF 积分：Hammersley 准随机采样 + 重要性采样 GGX
- 每个纹素 64 次采样
- Smith-GGX 几何项（IBL 变体：`k = a²/2`，其中 `a = roughness²`）
- 输出：`R = scale`，`G = bias`（用法为 `specular = F0 * scale + bias`）

**辐照度 SH**：从 manifest 提取 9 个 Vec3 系数，存储为 `Float32Array(27)`。

### 3.10 着色器

PBR 与 Standard 材质着色器通过 `pbr-template.ts` 和 `standard-template.ts` 中的 ShaderFragment 组合系统根据特性标志**动态组合生成**。这两种材质不存在原始 `.wgsl` 文件。

以下模块仍使用原始 `.wgsl` 着色器文件：

- 背景材质（天空盒、地面）
- 阴影通道（深度、模糊）
- 立方体贴图天空盒

所有着色器均为 WGSL。原始文件由对应的材质模块通过 Vite `?raw` 导入。

#### Scene Uniforms（共享结构体）

```wgsl
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  view: mat4x4<f32>,
  vEyePosition: vec4<f32>,
  envRotationY: f32,
  /* SH irradiance + image processing + fog fields */
};                                // Total: 352B
```

直接光照数据存储在独立的灯光 UBO 中，不在 `SceneUniforms` 内。

#### PBR 顶点着色器（由 `composePbrVertex` 组合）

**输入**：position (loc 0, f32x3)、normal (loc 1, f32x3)、tangent (loc 2, f32x4，若有 HAS_NORMAL_MAP)、uv (loc 2 或 3, f32x2)
**输出**：clipPos (builtin)、worldPos、worldNormal、[worldTangent, worldBitangent]、uv

**逻辑**：

```
worldPos = mesh.world * vec4(position, 1.0)
clipPos = scene.viewProjection * worldPos
normalW = normalize((mesh.world * vec4(normal, 0)).xyz)
tangentW = normalize((mesh.world * vec4(tangent.xyz, 0)).xyz)
bitangentW = cross(normalW, tangentW) * tangent.w
```

#### PBR 片元着色器（由 `composePbrFragment` 组合）

**BRDF 函数**（全部匹配标准微表面模型）：

1. **GGX/Trowbridge-Reitz 法线分布函数（NDF）**：

    ```
    D(NdotH, α) = α⁴ / (π · (NdotH² · (α⁴ - 1) + 1)²)
    where α = roughness²
    ```

2. **Smith-GGX 高度相关几何遮蔽函数**：

    ```
    G(NdotL, NdotV, α) = 0.5 / (NdotL·√(NdotV²·(1-α⁴)+α⁴) + NdotV·√(NdotL²·(1-α⁴)+α⁴))
    ```

3. **Schlick 菲涅尔近似**：

    ```
    F(cosθ, F0) = F0 + (1 - F0) · (1 - cosθ)⁵
    ```

4. **sRGB → 线性**：`pow(c, 2.2)`（应用于 baseColor 与 emissive 纹理）

**片元逻辑**：

```
1. Sample textures (baseColor, ORM, normal, emissive)
2. Linearize sRGB (baseColor, emissive)
3. Normal mapping: TBN * (normalMap * 2 - 1)
4. Compute vectors: V, L, H, NdotL, NdotV, NdotH, VdotH
5. Material: F0 = mix(0.04, baseColor, metallic), diffuseColor = baseColor * (1 - metallic)
6. Direct lighting:
   - Cook-Torrance specular: D * G * F
   - Hemispheric diffuse: mix(groundColor, diffuseColor, dot(N,L)*0.5+0.5) / π
   - Combined: (diffuse * hemiColor + specular * lightColor * NdotL) * intensity
7. IBL:
   - Diffuse: textureSampleLevel(cubemap, N, maxMip) — RGBD decoded
   - Specular: textureSampleLevel(cubemap, reflect(-V,N), roughness*maxMip) — RGBD decoded
   - BRDF LUT: textureSample(brdfLUT, vec2(NdotV, roughness)).rg
   - Combined: (iblDiffuse * diffuseColor + iblSpecular * (F0 * brdf.x + brdf.y)) * occlusion
8. Final: direct + indirect + emissive
```

---

## 4. 场景 1 渲染规范（来自 Spector.GPU 抓帧）

**来源**：`playground.babylonjs.com/full.html?webgpu=1#QCU8DJ#800`

### 渲染通道配置

- 1 个渲染通道，3 次绘制调用
- 颜色：`bgra8unorm`，4x MSAA → 解析到交换链
- 深度：`depth24plus-stencil8`，4x MSAA
- 清屏颜色：`{r:0.2, g:0.2, b:0.3, a:1.0}`
- 视口：1280×720（取决于窗口尺寸）

### 绘制调用 1：BoomBox

- 18,108 个索引 (uint16)，3,575 个顶点
- 4 个顶点缓冲区：position (42900B)、normal (42900B)、tangent (57200B)、uv (28600B)
- PBR 管线，背面剔除，开启深度写入

### 绘制调用 2：地面平面

- 36 个索引，24 个顶点
- 2 个顶点缓冲区：position、normal
- 背景材质着色器

### 绘制调用 3：天空盒

- 6 个索引，4 个顶点
- 3 个顶点缓冲区：position、normal、uv
- 天空盒材质，**禁用**深度写入

### 纹理（共 10 张）

- 4× BoomBox PBR (2048×2048)：baseColor、normal、metallicRoughness、emissive
- 1× BRDF LUT（256×256 或 128×128）
- 1× 地面纹理 (1024×1024)
- 2× 立方体贴图（镜面预滤波，带 mip）
- 2× 渲染目标（MSAA + 深度）

### 相机

- ArcRotateCamera，alpha = 1.77538207638442
- Beta、radius、target：由 `createDefaultCameraOrLight(true,true,true)` 根据网格包围盒自动计算

### 灯光

- 半球光，direction = [0, 1, 0]，intensity = 0.7

---

## 5. 数据流图

```
main.ts (e.g. scene1.ts)
  │
  ├─→ createEngine(canvas)           → Engine { device, context, format, msaaSamples }
  ├─→ createSceneContext(engine)      → SceneContext { engine, clearColor, camera:null, ... }
  │
  ├─→ loadGltf(engine, url)          → Fetches glTF/GLB, parses, uploads to GPU
  │     Returns AssetContainer          addToScene(scene, container) registers deferred builders
  │
  ├─→ loadEnvironment(scene, url)    → Fetches .env, generates BRDF LUT, uploads cubemap
  │     Sets scene._envTextures         Registers deferred builder → buildBackgroundRenderables()
  │
  ├─→ createDefaultCamera(scene)     → Reads mesh bounds → auto-frames
  │     scene.camera = camera
  │
  ├─→ createHemisphericLight()       → Returns plain HemisphericLight data
  │     scene.lights.push(light)
  │
  └─→ registerScene(scene); startEngine(engine)
        Runs deferred builders (creates pipelines + renderables)
        Builds scene._frameGraph       → begins requestAnimationFrame loop
        Each frame:
          _update(): callbacks, swaps, shadows, pre-passes, uniform updaters
          _record(): scene._frameGraph.execute()
            RenderTask writes pass scene UBO and draws bound buckets
          submit
```

---

## 6. Babylon.js 等价映射表

| Babylon.js                           | Babylon Lite                                              | 说明                           |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------ |
| `new Engine(canvas)`                 | `createEngine(canvas)`                                    | 异步，返回 Promise             |
| `new Scene(engine)`                  | `createSceneContext(engine)`                              | 扁平结构体，无 observables     |
| `SceneLoader.Append(url)`            | `addToScene(scene, await loadGltf(engine, url))`          | 支持按需扩展模块的 glTF/GLB    |
| `scene.createDefaultEnvironment()`   | `loadEnvironment(scene, url)`                             | 需显式传入 URL                 |
| `scene.createDefaultCameraOrLight()` | `createDefaultCamera(scene)` + `createHemisphericLight()` | 拆分为独立函数                 |
| `new HemisphericLight(...)`          | `createHemisphericLight(dir, intensity)`                  | 返回纯数据                     |
| `new ArcRotateCamera(...)`           | `createDefaultCamera(scene)`                              | 自动取景，返回纯数据           |
| `PBRMaterial`                        | `getOrCreatePbrPipeline()` + composer                     | 基于特性标志的管线             |
| `StandardMaterial`                   | `getOrCreatePipeline()` + composer                        | 基于特性标志的管线             |
| `scene._prepareFrame()`              | `startEngine()` runs deferred builders                    | 惰性创建管线                   |
| `engine.runRenderLoop(...)`          | `registerScene(scene)` + `startEngine(engine)`            | 支持一个或多个已注册渲染上下文 |

---

## 7. 构建与开发配置

### TypeScript（`tsconfig.base.json`）

```json
{
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["@webgpu/types"]
}
```

### Vite（引擎库构建）

```typescript
// packages/babylon-lite/vite.config.ts
export default defineConfig({
    build: {
        lib: { entry: "src/index.ts", formats: ["es"] },
        rollupOptions: { external: [] },
    },
});
```

### 包解析

开发阶段，`package.json` 的 exports 指向源码：`"main": "./src/index.ts"`。
生产构建时切换为 `"./dist/index.js"`。

---

## 8. 测试规范

### 单元测试（按模块）

- **core/mat4**：Identity、multiply、lookAtLH、perspectiveLH、invert — 与 Babylon.js `Matrix` 类输出对比
- **core/vec3**：全部运算 — dot、cross、normalize、length
- **camera**：由 alpha/beta/radius 计算的位置与 Babylon 公式一致
- **loader-gltf**：解析已知 GLB → 校验顶点数、索引数、包围盒
- **loader-env**：解析已知 .env → 校验 SH 系数、面数、mip 层数
- **BRDF LUT**：生成值在参考值容差范围内

### 集成测试（Playwright + 像素对比）

- 渲染场景 1 → 截图 → 与参考图计算 RMSE < 阈值
- 在 CI 中通过有头模式（headed）Chrome 自动运行（WebGPU 需要 GPU）

### 回归要求

- 每个新增场景都必须通过此前全部已有场景的测试
- 像素差异阈值：RMSE < 1.0（满分 255）

---

## 9. 已知限制

- **无后处理** — 图像处理直接在着色器内完成，无独立后处理通道
- **无 LOD** — 无论距离远近，网格均以全分辨率渲染

---

## 10. 文件清单

| 文件                                             | 用途                                               | 行数（约） |
| ------------------------------------------------ | -------------------------------------------------- | ---------- |
| `src/index.ts`                                   | 公共 API 出口汇总                                  | 95         |
| `src/math/types.ts`                              | 数学类型定义                                       | 45         |
| `src/math/vec3.ts`                               | Vec3 纯函数                                        | 68         |
| `src/math/mat4.ts`                               | Mat4 纯函数                                        | 185        |
| `src/math/observable-vec3.ts`                    | 响应式 Vec3（位置/目标）                           | —          |
| `src/math/observable-quat.ts`                    | 响应式 Quat（旋转）                                | —          |
| `src/engine/engine.ts`                           | WebGPU 设备 + 渲染循环                             | 150        |
| `src/scene/scene.ts`                             | 场景上下文结构体 + add()                           | 130        |
| `src/scene/scene-core.ts`                        | 核心场景逻辑                                       | —          |
| `src/scene/scene-camera.ts`                      | 相机管理                                           | —          |
| `src/scene/scene-remove.ts`                      | removeFromScene()                                  | —          |
| `src/scene/set-parent.ts`                        | setParent() — 父子变换                             | —          |
| `src/scene/parentable.ts`                        | IWorldMatrixProvider、IParentable                  | —          |
| `src/scene/transform-node.ts`                    | TransformNode 工厂 + collectMeshes                 | —          |
| `src/scene/world-matrix-state.ts`                | 基于版本号的世界矩阵传播                           | —          |
| `src/camera/camera.ts`                           | Camera 接口                                        | —          |
| `src/camera/arc-rotate.ts`                       | ArcRotateCamera                                    | 85         |
| `src/camera/arc-rotate-controls.ts`              | 轨道控制                                           | 70         |
| `src/camera/free-camera.ts`                      | FreeCamera                                         | —          |
| `src/camera/free-camera-controls.ts`             | WASD/方向键控制                                    | —          |
| `src/light/light-base.ts`                        | 共享灯光基类结构                                   | —          |
| `src/light/types.ts`                             | LightBase 类型、LightBaseInternal、MAX_LIGHTS      | —          |
| `src/light/light-matrix.ts`                      | 用于阴影的灯光视图投影矩阵                         | —          |
| `src/light/hemispheric.ts`                       | 半球光工厂                                         | 16         |
| `src/light/point-light.ts`                       | 点光源工厂                                         | 20         |
| `src/light/directional-light.ts`                 | 平行光工厂                                         | 20         |
| `src/light/spot-light.ts`                        | 聚光灯工厂                                         | —          |
| `src/material/pbr/pbr-material.ts`               | PBR 材质属性 + 工厂                                | 25         |
| `src/material/pbr/pbr-template.ts`               | PBR 着色器模板（WGSL 生成）                        | 230        |
| `src/material/pbr/pbr-flags.ts`                  | PBR 特性标志位掩码                                 | —          |
| `src/material/pbr/pbr-pipeline.ts`               | PBR 管线缓存                                       | 170        |
| `src/material/pbr/pbr-renderable.ts`             | PBR 可渲染对象构建器 + 单网格重建闭包              | 140        |
| `src/material/pbr/no-color-view.ts`              | PBR 无颜色材质视图辅助工具                         | —          |
| `src/material/pbr/fragments/singlelight-wgsl.ts` | 非循环单光源 PBR WGSL                              | —          |
| `src/material/pbr/fragments/multilight-wgsl.ts`  | 通用多光源 PBR WGSL                                | —          |
| `src/material/pbr/background-material.ts`        | 天空盒 + 地面材质工厂                              | 217        |
| `src/material/pbr/background-renderable.ts`      | 背景可渲染对象构建器                               | 96         |
| `src/material/pbr/background-dds-skybox.ts`      | DDS 环境天空盒                                     | —          |
| `src/material/pbr/background-hdr-skybox.ts`      | HDR 环境天空盒                                     | —          |
| `src/material/pbr/background-ground.ts`          | 背景地面平面                                       | —          |
| `src/material/pbr/fragments/`                    | PBR ShaderFragment 模块                            | —          |
| `src/material/standard/standard-material.ts`     | Standard 类型 + 工厂                               | 93         |
| `src/material/standard/standard-template.ts`     | Standard 着色器模板（WGSL 生成）                   | 230        |
| `src/material/standard/standard-pipeline.ts`     | Standard 管线缓存                                  | 280        |
| `src/material/standard/standard-renderable.ts`   | Standard 可渲染对象构建器 + 单网格重建闭包         | 115        |
| `src/material/standard/no-color-view.ts`         | Standard 无颜色材质视图辅助工具                    | —          |
| `src/material/standard/skybox-cubemap.ts`        | CubeMap 天空盒管线                                 | 104        |
| `src/material/standard/fragments/`               | Standard ShaderFragment 模块                       | —          |
| `src/material/grid/grid-material.ts`             | GridMaterial 工厂 + 选项（在 ShaderMaterial 上组合 WGSL） | —          |
| `src/shader/shader-composer.ts`                  | ShaderFragment 组合引擎                            | —          |
| `src/shader/fragment-types.ts`                   | ShaderFragment 接口定义                            | —          |
| `src/shader/ubo-layout.ts`                       | UBO 布局辅助工具                                   | —          |
| `src/shader/wgsl-helpers.ts`                     | WGSL 代码生成工具                                  | —          |
| `src/render/renderable.ts`                       | Renderable/PrePass/Updater 接口                    | 20         |
| `src/render/scene-helpers.ts`                    | 共享辅助工具                                       | —          |
| `src/render/lights-ubo.ts`                       | 多光源 UBO 打包                                    | —          |
| `src/mesh/mesh.ts`                               | 网格类型与 GPU 上传                                | 80         |
| `src/mesh/mesh-factories.ts`                     | 高层网格工厂函数                                   | 50         |
| `src/mesh/thin-instance.ts`                      | Thin instance CPU 数据 + 公共 API                  | —          |
| `src/mesh/thin-instance-gpu.ts`                  | Thin instance GPU 同步                             | —          |
| `src/skeleton/create-skeleton.ts`                | 从 glTF 创建骨骼数据                               | —          |
| `src/skeleton/skeleton-updater.ts`               | 关节矩阵计算                                       | —          |
| `src/animation/animation-manager.ts`             | 通用 AnimationTask 调度器                          | —          |
| `src/animation/animation-group.ts`               | AnimationGroup 状态与播放辅助函数                  | —          |
| `src/animation/animation-group-task.ts`          | AnimationGroup 任务适配器                          | —          |
| `src/animation/property-animation.ts`            | 用户编写的属性动画片段                             | —          |
| `src/animation/evaluate.ts`                      | 关键帧插值                                         | —          |
| `src/animation/types.ts`                         | 动画类型定义                                       | —          |
| `src/morph/create-morph-targets.ts`              | 变形目标数据 + GPU 纹理                            | —          |
| `src/picking/gpu-picker.ts`                      | GPU ID 通道拾取                                    | —          |
| `src/picking/picking-pipeline.ts`                | 拾取渲染管线                                       | —          |
| `src/picking/picking-shader.ts`                  | 拾取 WGSL 着色器                                   | —          |
| `src/picking/picking-helpers.ts`                 | getPickedNormal()、getPickedUV()                   | —          |
| `src/picking/picking-info.ts`                    | PickingInfo 类型                                   | —          |
| `src/picking/detailed-picking.ts`                | CPU 射线/三角形求交                                | —          |
| `src/picking/ray.ts`                             | 射线求交数学                                       | —          |
| `src/resource/gpu-pool.ts`                       | GPU 缓冲区/纹理池化                                | —          |
| `src/shadow/shadow-base.ts`                      | 共享阴影逻辑                                       | —          |
| `src/shadow/shadow-generator.ts`                 | ShadowGenerator 契约                               | —          |
| `src/shadow/esm-directional-shadow-generator.ts` | 平行光 ESM 阴影生成器                              | 150        |
| `src/shadow/pcf-spotlight-shadow-generator.ts`   | 聚光灯 PCF 阴影生成器                              | —          |
| `src/shadow/pcf-directional-shadow-generator.ts` | 平行光 PCF 阴影生成器                              | —          |
| `src/frame-graph/task.ts`                        | 帧图任务接口                                       | —          |
| `src/frame-graph/frame-graph.ts`                 | 有序帧图任务列表                                   | —          |
| `src/frame-graph/frame-graph-actions.ts`         | 任务插入辅助函数                                   | —          |
| `src/frame-graph/render-pass-task.ts`            | 渲染通道任务、逐通道场景 UBO、绘制桶               | —          |
| `src/texture/texture-2d.ts`                      | 2D 纹理加载器                                      | 60         |
| `src/texture/solid-texture.ts`                   | 1×1 纯色纹理工厂                                   | —          |
| `src/texture/cube-texture.ts`                    | 6 面立方体纹理加载器                               | 141        |
| `src/texture/rtt.ts`                             | 渲染目标纹理辅助工具                               | —          |
| `src/texture/ktx2-loader.ts`                     | 面向 `KHR_texture_basisu` 的 KTX2/BasisU 上传      | —          |
| `src/texture/mip-count.ts`                       | 带偏移的 mip 计数辅助函数                          | —          |
| `src/texture/generate-mipmaps.ts`                | GPU mipmap 生成与编码器局部 mipmap 录制            | —          |
| `src/loader-gltf/load-gltf.ts`                   | GLB 解析器 + GPU 上传                              | 390        |
| `src/loader-gltf/gltf-parser.ts`                 | glTF JSON 解析辅助函数                             | —          |
| `src/loader-gltf/gltf-material.ts`               | glTF 材质 → PbrMaterialProps                       | —          |
| `src/loader-gltf/gltf-ext-basisu.ts`             | `KHR_texture_basisu` 动态特性                      | —          |
| `src/loader-gltf/gltf-interleave.ts`             | 原生交错 VB 支持（惰性 CPU 解步长）                | —          |
| `src/loader-gltf/gltf-feature-meshopt.ts`        | `EXT_meshopt_compression` 动态特性                 | —          |
| `src/loader-gltf/gltf-ext-quantization.ts`       | `KHR_mesh_quantization` 动态特性                   | —          |
| `src/loader-gltf/gltf-feature-xmp.ts`            | `KHR_xmp_json_ld` 元数据动态特性                   | —          |
| `src/loader-gltf/gltf-animation.ts`              | glTF 动画提取                                      | —          |
| `src/loader-env/load-env.ts`                     | .env 解析器 + RGBD 解码                            | 240        |
| `src/loader-env/load-dds-env.ts`                 | DDS 环境加载                                       | —          |
| `src/loader-env/env-helpers.ts`                  | 环境辅助工具                                       | —          |
| `src/loader-env/rgbd-decode.ts`                  | 共享 RGBD 解码辅助函数                             | —          |
| `src/loader-hdr/load-hdr.ts`                     | HDR 环境管线                                       | —          |
| `src/loader-hdr/hdr-parser.ts`                   | RGBE 文件解析器                                    | —          |
| `src/loader-hdr/hdr-ibl-pipeline.ts`             | 从 HDR 进行 GPU 计算 IBL                           | —          |
| `src/loader-babylon/load-babylon.ts`             | .babylon 格式解析器                                | —          |
| `src/loader-skybox/load-skybox.ts`               | 高层天空盒加载器                                   | —          |
| `src/loader-skybox/skybox-renderable.ts`         | 天空盒 → 可渲染对象构建器                          | —          |
| `lab/lite/src/lite/scene1.ts`                    | 场景 1：BoomBox PBR                                | 44         |
| `lab/lite/src/lite/scene*.ts`                    | 场景 1–112（开发沙箱）                             | —          |
