# 模块：USD 命令缓冲加载器（USD command-buffer loader）

> 包路径：`packages/babylon-lite/src/loader-usd/`

## 目的

使用与 Babylon.js 相同的预构建 OpenUSD WebAssembly 提取器加载 USD、USDA、USDC 和 USDZ。没有 GLB 或 Babylon JSON 中间格式，也不依赖 Babylon.js。C++ 实现与 protocol-v5 运行时和来自 https://github.com/BabylonJS/babylon-usd-importer 的 Babylon.js 共用。Lite 不分叉或重新编译该提取器。

该加载器创建普通的 Lite 场景节点、网格和 PBR 材质。它从不直接修改场景：调用方负责调用 `addToScene(scene, result)`。公共结果为纯状态对象，所有操作均为独立函数。

## 公共 API 接口

```typescript
loadUsd(engine: EngineContext, source: string | UsdBinaryInput,
        options?: LoadUsdOptions): Promise<UsdAssetContainer>;
disposeUsd(container: UsdAssetContainer): void;
```

`LoadUsdOptions` 接受 `rootFileName`、将相对虚拟路径映射到 ArrayBuffer/ArrayBufferView/Blob 数据的 `files` 映射表、`resolveByFileName`（默认为 true）、`runtimeBaseUrl`（默认为 `https://cdn.babylonjs.com/babylonUsdImporter/5/`）、`AbortSignal`、`onProgress` 和 `onLog`。根文件名会从 URL/File 名称推断；无扩展名的二进制输入通过 USDZ ZIP 或 USDC crate 魔数识别。源缓冲区在传输前会被复制，绝不从其所有者处分离（detach）。路径保留大小写和目录结构；拒绝绝对路径和 `..`。附属文件（sidecars）需显式提供，绝不会静默从任意 URL 拉取。

`UsdAssetContainer` 扩展了 `AssetContainer`，增加了导入诊断信息（Worker 耗时、统计数据、缺失资源和实例化耗时）以及内部所有权状态。`disposeUsd` 幂等地释放容器的 GPU 资源；请先将其从所有场景中移除。它不会销毁引擎，也不会改变场景全局的材质/纹理缓存。

## 内部架构

### Worker 边界

每次加载启动一个 module Worker，发送 ID 为 1 的 `extract` 请求，并在提取完成后或任何失败/取消时终止该 Worker。随附的 Worker 在其自身的 Emscripten 文件系统中暂存文件，打开组合后的 stage（不进行展平），并返回两个可传输的 ArrayBuffer。日志/进度事件会被转发。Worker 异常和 `messageerror` 会使加载 Promise 拒绝。跨域 Worker URL 使用可撤销的同源模块引导 URL。

默认的 Worker、JS 胶水代码、WASM 和数据文件与 Babylon.js 使用的不可变 protocol-v5 资源完全相同。它们是运行时下载的资源，而非从 Lite 根入口导入或内联的 JS 资源。应用可将这四个文件一起自托管并设置 `runtimeBaseUrl`；混用协议版本会在分配任何 GPU 资源前拒绝。

### 协议

小端序命令头：魔数 `0x42445355`、uint16 版本号 5、uint16 保留字段、uint32 命令数量、uint32 保留字段（共 16 字节）。每条命令包含 uint16 操作码、uint16 标志位、uint32 载荷长度，随后是载荷数据。未知版本/操作码、错误的载荷长度、截断、尾部多余字节、无效 ID 以及越界/未对齐引用均会被拒绝。缺失引用的哨兵值为 `0xffffffff`。字符串为 UTF-8 切片。数值与矩阵引用原始数据缓冲区中对齐的跨度。OpenUSD `GfMatrix` 使用行向量，原生写入器按行顺序序列化。Lite 使用列向量和列主序存储，因此同一段连续的 16 个浮点数序列天然就是所需的数学转置：在两种表示中平移分量都位于索引 12–14。因此节点、骨骼关节、动画和薄实例矩阵均使用零拷贝视图；重新排列行列反而会导致二次转置。

| 操作码           | 载荷字节数 | 内容                                                                                                            |
| ---------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| 1 Scene          | 12         | Z-up 标志、每单位米数、每秒时间码                                                                               |
| 2 Texture        | 48         | ID、名称切片、MIME、图像切片、UV 集、UV 变换、U/V 寻址模式、源色彩空间与 float4 缩放/偏移                       |
| 3 Material       | 96         | ID、名称、系数与标志，后接七个独立纹理 ID 与输出通道                                                            |
| 4 Node           | 20         | ID、父节点 ID、名称切片、仿射局部矩阵偏移                                                                       |
| 5 Skeleton       | 20         | ID、名称、关节数量及六字关节记录偏移（父级、骨骼 ID、名称、静止矩阵、绑定矩阵）                                 |
| 6 Geometry       | 60         | ID、计数、标志、位置/法线/切线/UV/颜色、两套蒙皮流、索引、权重影响                                              |
| 7 Mesh           | 40         | ID、节点、几何体、材质、名称、标志、骨骼、子集记录                                                              |
| 8 Instance       | 16         | 源网格 ID、放置节点 ID、名称                                                                                    |
| 9 Animation      | 32         | 目标类型/ID/属性、分组、关键帧数、时间/值偏移、步长                                                             |
| 10 Analytic      | 44         | ID、节点、形状、材质、名称、标志、轴向、半径/尺寸、高度、细分度                                                 |
| 11 ThinInstances | 12         | 源网格 ID、连续矩阵偏移与实例数                                                                                 |
| 12 MorphTarget   | 32         | ID、源网格、名称、顶点数、位置/法线偏移与初始权重                                                               |

命令按单遍读取为不可变记录，随后构建资源映射表。核心模块将可选命令分发给延迟导入的特性模块：纹理/材质特性、解析几何体、经典实例、薄实例、骨骼、变形目标（morph targets）和动画。静态无纹理网格不会拉取这些特性模块。

### 几何体与层级结构

节点矩阵使用 `createSceneNodeFromMatrix` 以保留切变（shear）。一个合成根节点精确地应用一次每单位米数、USD Z-up 旋转以及右手到左手坐标系转换。网格是放置节点的单位变换子节点。包围盒保持在几何体局部空间。绕序一次性转换为 Lite 现有的 CCW 管线约定，而不是通过全局禁用背面剔除来掩盖。

几何体数组在可能时使用类型化视图。单材质网格走直接上传路径。材质子集成为子网格，使用紧凑的索引流而非为每个子集重复上传整个源网格。重复放置共享同一份不可变的 MeshGPU 和 CPU 流，并遵循 Lite 现有的 retain/release 所有权机制。每个放置保留其自身的变换和名称。点实例化器（Point-instancer）批次直接通过 `setThinInstances` 附加提取器的连续 float4x4 跨度，为每个原型生成一次实例化绘制，而非为每个点创建一个 Lite 网格。

解析立方体、球体、圆柱体和圆锥体记录使用 Lite 的几何体构建器；轴向修正仅局部应用于形状本身，不传递给其子节点。Lite 的构建器是左手系的，因此仅针对协议默认的右手系图元记录反转其索引顺序。

### 材质与纹理

直接创建 Lite PBR 金属/粗糙度属性。可选的 Alpha 测试、自发光、无光照（unlit）和 UV 变换通过现有的按需启用 setter 处理。图像解码为异步执行，使用非预乘（straight）Alpha 和显式源色彩空间，并在完成后关闭已解码的位图。纹理对象按协议 ID 共享。USD 的七个独立 Preview Surface 绑定由加载器自有的 PBR 材质插件表示。该插件独立采样每个已创作的输出通道，应用其 float4 缩放/偏移和 UV 变换，并在光照计算前覆盖基础色、不透明度、金属度、粗糙度、遮挡和自发光值。遮挡覆盖在原生 PBR 路径初始化其可变遮挡值（包括金属反射率变体）之后运行，因此插件组合绝不会在声明前赋值。法线绑定在 Lite 的余切帧（cotangent-frame）法线路径中应用其已创作的变换。仅当已加载的 USD 材质需要时才注册插件，因此非 USD 场景和无纹理 USD 场景不会保留任何插件桥接代码。进程级的插件签名表只增不减：注册 USD 插件不会使其他场景已渲染材质的缓存签名失效。缓存条目仅保留生成的着色器片段，绝不保留材质自有的插件实例或其提取缓冲区视图，从而使已销毁的容器可被垃圾回收，同时签名索引保持可重用。正的不透明度截断值会禁用 Alpha 混合并走 Alpha 测试路径，与 Babylon.js 的深度写入行为一致。

### 蒙皮与动画

关节记录存储父索引、全局协议骨骼 ID、名称、局部静止矩阵和局部绑定矩阵。父节点位于子节点之前。加载器在求逆前先累积局部绑定层级，因此逆绑定矩阵来自已创作的绑定姿势，而非从静止姿势推断；网格蒙皮流通过子集重映射得以保留。

提取器将每个蒙皮网格的 `geomBindTransform` 应用于其顶点，并将网格的放置节点更改为所绑定的 Skeleton prim。因此关节世界矩阵处于 Skeleton 对象空间中，着色器计算 `skeletonNodeWorld * (jointObject * inverseBind) * position`。应用通用的 glTF `inverse(meshWorld)` 项会错误地抵消已创作的 Skeleton prim 放置变换。

变形（Morph）记录包含绝对目标位置/法线。加载器通过每个紧凑材质子集对它们进行重映射，将其转换为 Lite 增量（delta），并创建现有的基于存储缓冲区的 `MorphTargetData`。目标数量没有固定上限。经典实例保留源骨骼和变形缓冲区；点实例在原型绘制上保留它们。

动画模块将时间码转换为秒，保留目标 ID 和局部仿射矩阵，并返回普通的 AnimationGroup。每个动画组保留其已创作的首尾采样时间，包括正的非零区间和负区间；直接播放和管理器驱动播放均在该区间内启动、钳制和循环。单关键帧轨道拥有零长度区间，并在已创作的起始时间求值其唯一采样，而不是变成空操作。`goToFrame` 仍按已创作的时间码寻址。USD 通道还暴露具有稳定目标身份和名称的 Lite 属性混合器轨道，因此 `AnimationGroupMask`、零/部分权重以及现有的 `enableAnimationBlending` 管理器路径均可正常工作。原生 16 浮点矩阵轨道相对于已创作的姿势混合所有仿射分量，并对超重总和进行归一化。这既保留了精确的满权重矩阵（包括切变），又确保部分权重矩阵保持仿射性。如果通过公共重新设父级 API 后再进行 TRS 编辑使矩阵动画目标交回 TRS 控制，其下一次矩阵采样会重新创建原始矩阵存储并使世界矩阵及受影响的骨骼失效。轨道写入器先更新 CPU 状态；去重后的写后发布步骤在所有动画组求值完成后，为每个受影响的骨骼和变形缓冲区执行一次 GPU 上传。当动画组离开管理器时释放混合器临时缓冲，从而确保长期存活且已清空的管理器不会滞留已销毁的 USD 上下文。采样未发生变化的暂停动画组不执行 GPU 上传。安装 USD 的加权属性集成不会改变普通满权重属性组的行为：无竞争轨道保留直接控制器行为、暂停帧行为以及相对于 glTF 动画组的注册顺序最后写入语义，即使同一动画组中的另一条轨道正在参与混合。仅当存在小数权重轨道真正竞争同一目标属性时，满权重轨道才加入加权累积，以防止小数桶覆盖其贡献。加载器不会自动播放动画组。

## 管线配置与着色器逻辑

不引入 USD 专用的渲染器或管线系列。Lite 现有的 PBR、蒙皮、变形和实例化构建器负责管线创建。带纹理的 Preview Surface 材质附加加载器自有的 `MaterialPlugin`；其生成的 WGSL 仅采样已创作的通道，且其签名参与现有的材质管线缓存。无纹理 USD 资源不加载任何插件桥接或插件着色器代码。

## 状态机 / 生命周期

拉取/暂存 -> Worker 提取 -> 校验命令 -> 实例化 -> 返回。每个异步边界都会响应取消操作。发生中止或错误时，终止 Worker、撤销引导/图像 URL、关闭已解码图像，并释放所有部分创建的网格、蒙皮资源和纹理。延迟完成的解码必须释放其结果，而不能将资源附加到已放弃的加载任务上。成功的结果将所有权转移给调用方。

## Babylon.js 等价映射

TransformNode -> 带原始矩阵的 Lite SceneNode；Mesh/InstancedMesh -> 共享几何体的独立 Lite Mesh 节点；MultiMaterial/SubMesh -> 每个材质子集对应的子 Mesh；PBRMaterial -> 原生 PbrMaterialProps；Skeleton/AnimationGroup -> 原生 Lite 骨骼数据和动画组。不复制任何 Babylon.js TypeScript 类或场景注册机制。

## 依赖关系

现有的 Lite 场景、网格、PBR、纹理、数学和资源辅助模块。可选特性模块依赖于各自对应的 Lite 子系统。OpenUSD 二进制文件为带原始许可声明的外部运行时资源。无需新增运行时包依赖或包子路径导出。

## 测试规范

单元测试覆盖命令校验、类型化数组边界、层级/单位/上轴、绕序、材质子集、独立材质通道、共享几何体与所有权、解析形状、薄实例、绑定/静止骨骼、变形目标与遮罩/加权混合动画、取消操作、畸形 Worker 消息以及虚拟文件集。浏览器管道测试使用真实的共用 Worker 配合公开的合成 USDA、USDC 和 USDZ 测试夹具。

一组对照实验室场景通过 Babylon.js 和 Lite 加载同一个点实例化 USD。其机器可读计数器断言语义一致性（源网格、实例、平移和三角形数），同时现有的 Lite-vs-Babylon.js RAF 基准测试收集同一场景的初始化耗时、帧耗时、绘制调用数和 JS 堆内存占用。配对运行时截图测试直接对比 Lite 与 Babylon.js 在独立 Preview Surface 纹理通道、左右手解析体绕序以及带姿势的蒙皮动画上的表现。此等价 MAD 覆盖不会新增或修改已提交的黄金基准。根入口构建测试证明无关导入不会保留 USD 加载器或外部运行时。

## 文件清单

`load-usd.ts`（公共入口与生命周期）、`usd-types.ts`（公共状态）、`usd-worker-client.ts`（提取传输）、`usd-protocol.ts`（带校验的二进制读取器）、`usd-materialize.ts`（核心场景组装）、可选的 `usd-*.ts` 特性模块、`tests/lite/unit/` 下的单元测试、`tests/lite/plumbing/` 下的浏览器对比测试，以及 `lab/lite/src/` 下的配对实验室场景。
