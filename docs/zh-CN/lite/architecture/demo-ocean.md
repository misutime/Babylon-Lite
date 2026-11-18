# 模块：Ocean 演示

> 源码路径：`lab/lite/src/demos/ocean/`
> 入口：`lab/lite/src/demos/ocean.ts` + `lab/lite/demo-ocean.html`
> 参考：Babylon.js Playground `YX6IB8#758`

`lab/lite/demo-ocean-reference.html` 在运行时拉取并转译该精确的 Playground 修订版。它用查询参数控制的时钟替换演示的挂钟时间，因此 `?seekTime=4` 会将频谱时间和 glTF 动画都冻结在 4 秒处，除非同时提供 `&animate=true`。冻结的参考帧还会强制渲染 delta 为零，使时域泡沫历史不会在固定波相下继续演化，随后在设置就绪标记前停止渲染循环。本地参考页面相机在场景创建后施加 180 度偏航，使两个页面采用与 Lite 相同的面向浮标的对比视角；随后参考画布在水平方向镜像翻转，以补偿源场景的右手坐标系与 Lite 左手世界之间的差异。Lite 页面和参考页面相互链接，并在跳转时保留查询字符串。

## 目的

构造过程具有事务性。在分配庞大的 GPU 纹理图之前先下载并解码高斯噪声。纹理构造在每次分配完成后立即取得其所有权；仿真构造则额外持有其任务、着色器、绑定集和存储缓冲区。着色器准备在仿真对象返回前完成。任务释放会销毁其 uniform arena。任何失败都会按逆序回滚所有已完成的分配，并保留原始错误（存在清理错误时也会一并保留）。

`OceanSimulation.dispose()` 是聚合拆卸操作。调用前需先释放渲染消费者并分离其帧图任务。已释放的仿真对象会拒绝后续操作；对挂起初始化的取消会被妥善观测，不会产生未处理的 Promise 拒绝。清理操作具有幂等性，任何因外部所有者尚存而未能释放的资源仍会在后续清理重试时保持可用。演示程序将场景释放与聚合仿真清理相连，并在释放网格消费者和延迟渲染任务之后执行：先停止引擎，等待 `waitForGpuResourceRetirements(engine)`，释放仿真，再释放引擎。单独的 `waitForGpuIdle()` 栅栏无法保证 CPU 侧释放回调已经执行完成。后续演示初始化失败也走同一路径，且若清理同时失败则会保留原始初始化错误。

将 Playground FFT 海洋移植到 Babylon Lite，作为帧图计算的模块化展示。最终演示复现了参考版本的频谱波浪生成、三层频率级联、逆向 FFT、置换裁剪网格（clipmap）几何体、海洋着色、程序化天空、浮力、浮标网格、阴影、辉光（glow）、调试视图以及可编辑参数。

Lite 页面使用参考版本的 FreeCamera 位姿以及匹配的环境与平行光默认值。海洋是一个带有按需启用材质插件的 PBR 材质，镜像了参考版的 `PBRCustomMaterial`：插件负责置换、导数法线、湍流/接触泡沫、距离粗糙度、次表面散射（SSS）颜色以及水体自发光合成，而共享 PBR 管线负责直接光照、点光源衰减、阴影、辐照度（irradiance）、镜面反射 IBL、BRDF LUT、色调映射和伽马输出。此前的独立近似着色器不再保留。

以相机为中心的程序化天空遵循 Babylon.js `SkyMaterial` 的大气模型：Rayleigh 与 Mie 散射、光学消光、Henyey-Greenstein 相位函数、太阳圆盘以及 Uncharted 2 色调映射。天空控件使用与参考版相同的默认值以及倾角/方位角到太阳位置的转换约定。同一套散射函数用于填充一个 128×128 六面的 `rgba16float` 环境立方体贴图。每次更新都会重新生成其常规 mip 链，并根据大气辐射度重算辐照度球谐系数，与参考版的反射探针保持一致，而非采样无关的静态环境。环境加载器直接持有 BRDF LUT 和程序化立方体贴图，而不是下载并保留一个未使用的 `.env` 立方体贴图。运行期辐照度积分按确定性分块让出执行权，且仅发布最新一次完成的参数更新。平行光的漫反射颜色由同一大气状态推导得出。

程序化探针计算着色器按标准的 WebGPU 立方体贴图层顺序 `+X, -X, +Y, -Y, +Z, -Z` 写入。它保留全景投影既定的逐面朝向，仅将其源面索引重排为该标准层序；直接替换投影本身会改变探针颜色。采样方向还包含 Ocean PBR 路径所用的反射探针 Y 轴补偿。若保留旋转后的源序而不重排，地平线太阳会落入错误的立方体面；头顶光照会掩盖该错误，因为头顶方向在水平面是对称的。

当环境光和平行光强度为零时，水体保留参考版的深蓝水体自发光项，而泡沫呈黑色，因为它依赖光照且距离雾化会收敛到深水颜色而非明亮的天空地平线。浮标没有环境半球光。其黄色点光源使用参考版的父节点相对位置、线性漫反射颜色、物理衰减和强度。该点光源同样为自定义海洋材质贡献平方反比漫反射与镜面反射光照，使浮标周围的水面能够接收相同的局部暖光，而非仅计算环境和平行太阳光。

代码按职责拆分。没有任何单个源文件包揽整个演示，WGSL 代码也存放在专用着色器模块中，而非内嵌在编排入口里。

## 范围与分阶段交付

### 第 1 阶段：频谱计算基础（已实现）

- 单一初始 JONSWAP 级联，采用参考版的默认局部风浪和涌浪频谱。
- GPU 初始频谱生成。
- GPU 随时间变化的复振幅。
- 预计算 FFT 旋转因子（twiddle factors）。
- 水平与垂直逆向 FFT 阶段。
- 最终的置换纹理与导数纹理。
- 使用专用海洋着色器渲染的置换网格。

该阶段在后续阶段扩展之前，率先确立了可见且连续动画化的数值计算基础。

### 第 2 阶段：完整参考波浪系统（已实现）

- 默认分辨率为 `256 x 256`。
- 参考长度尺度为 `250`、`17` 和 `5`。
- 在各级联之间应用频率截断（cutoff）。
- 添加乒乓（ping-pong）湍流累积以及生成的导数/湍流 mip 链。
- 添加无需重新分配仿真图的运行时频谱控件。

### 第 3 阶段：渲染与世界一致性（已实现）

- 带中心块、环、过渡条（trim）和裙边（skirt）的相机相对同心裁剪网格（clipmap）几何体。
- 采样对应级联子集的三种材质 LOD。
- 参考版的水体颜色、菲涅尔、粗糙度、次表面散射、泡沫和接触泡沫。
- 场景深度输入、平行光、阴影、程序化天空/反射近似、泛光（bloom）以及最终帧 SMAA。

### 第 4 阶段：美术资产与控制面板（已实现）

- Babylon 浮标 glTF、点光源、泛光辉光以及 GPU 位移探针浮力采样。
- DOM 控制面板，替代参考版运行时加载的 dat.GUI 依赖。
- 提供与参考版相同的 General、Sky、Waves Generator、Ocean Geometry、Ocean Shader 和 Buoyancy 设置，不包含其 Glow Layer 开关（因为 Lite 使用 bloom 而非 glow layer）。
- 阴影开关使用 `setShadowGeneratorEnabled()`，使已附着的接收端绑定保持稳定，同时在禁用时停止渲染阴影贴图。
- 由于计算纹理尺寸不可变，分辨率更改通过查询参数持久化并重建页面。长度尺度、顶点密度、裁剪层级、裙边尺寸、线框模式和材质 LOD 仅原地重建裁剪网格；显式的 Ocean 渲染任务启用了 `enableRenderTaskMeshRefresh()`，使这些运行期网格/材质重建能够刷新其绑定。其他所有控件均为实时更新。
- 在顶点密度或线框重建后，环和过渡条的克隆家族依然保持 GPU 共享：`resizeSharedMeshGeometry()` 对每个家族仅上传一次，并将替换后的分配以引用计数所有权重新指派给每个克隆体。
- 固定 256×256 的 EXR 噪声资产在较低的可选分辨率下，采用参考实现的线性源前缀进行解码。这保证了与参考输出一致，尽管该前缀跨越了完整的 256 宽源行，而非构成一个正方形裁剪区域。
- 不透明采样深度目标为表面尺寸，并在帧图尺寸调整重建期间保持稳定的纹理外观，因此接触泡沫会跟随画布和设备像素比的变化。
- 可选的计算纹理调试器。
- 用于诊断的确定性 `seekTime` 支持（接受小写别名 `seektime`）。参考页面在暂停时仍保持渲染，并通过 `P` 键切换仿真时钟与动画组，因此控件在冻结的对比帧上依然可用。定位（seek）会在暂停前以固定 60 Hz 从零开始重放参考仿真，因为湍流/泡沫是一个会对帧 delta 进行积分的有状态乒乓纹理；仅跳转到绝对频谱时间会使该纹理保持为零并导致海洋泡沫过曝泛白。预热（warmup）直接调用三级联的计算更新，而非渲染场景，因此不会复用浏览器交换链纹理。在最终计算步之后，它会执行一次 await 的位移回读，并确定性地收敛浮力状态。12 秒以内的 seek 会重放精确的 60 Hz 历史。更长的 seek 最多使用 720 个均匀间隔的步长（仅当需要保证每步 delta 不超过参考版 0.5 秒上限时才增加步数），避免诸如 `seekTime=50` 这类长 URL 将数千个完整 FFT 帧塞入队列。参考页面在预热运行期间会显示进度。即使在 `animate=true` 时，Lite 和参考版也会执行相同的重放；仅当确定性状态和浮标姿态建立完毕后才会恢复动画。Lite 的就绪标记也仅在该稳定姿态渲染完毕后才设置。暂停会在该次求解之后禁用后续浮力回读；恢复后重新启用。Lite 通过 `submitComputeTasks()` 对其频谱、FFT 和合并任务执行相同重放，并在首次合并前初始化浮标探针坐标。因此最后一次预热合并会为启动后的回读留下有效的浮标采样缓冲区。最终姿态求解器会重复执行 `numSteps * 2 + 2` 次仅探针提交，根据每次新更新的浮标姿态变换三个探针点，并使用参考版未偏移的双线性纹素坐标。每个探针仅采样其原始点一次，与参考实现匹配（参考版看似四步的位移修正每次都在重新采样原始位置）。随后 Lite 在首个渲染帧上重新生成最终的导数/湍流 mipmap。

上述精确的四元数衰减求解器仅用于定位特定时间帧的收敛。实时 Lite 动画保留最新的异步 GPU 采样结果，但在每个渲染帧上插值位置和欧拉倾角，避免浮标回读之间出现明显的 6 帧阶梯感。

自由相机的垂直移动使用 Space/PageUp 向上、C/PageDown 向下。由于镜像后的参考画布反转了可见的水平移动方向，其键盘输入将 D/右箭头映射为内部向左，将 A/Q/左箭头映射为内部向右。包装器直接替换参考版的 `_setCameraKeys()` 方法，因此切换其 ZQSD 复选框也会保留这些映射。其水平指针增量在 Babylon.js 应用之后再反转，以在不改变垂直鼠标视角的前提下补偿 CSS 画布镜像。

在 Lite 演示中，按 F8 可切换徽章、GPU 计时面板和参数控件。浏览器控制台函数 `getOceanCameraParameters()` 会返回可复制的实时相机位置、欧拉旋转和目标值。

## 模块边界

```text
ocean.ts                         page entry and loading/error lifecycle
ocean/buoy.ts                    buoy asset, light, and displacement-driven buoyancy
ocean/controls.ts                DOM controls and debug selector
ocean/debug.ts                   orthographic live compute-texture overlay
ocean/demo.ts                    engine, scene, camera, task ordering
ocean/lifecycle.ts               fenced retirement drain and simulation/engine teardown
ocean/constants.ts               fixed defaults and workgroup dimensions
ocean/spectrum.ts                JONSWAP CPU parameter packing
ocean/resources.ts               owned compute texture allocation
ocean/fft.ts                     twiddle and ordered inverse-FFT dispatch construction
ocean/simulation.ts              initial and per-frame compute task assembly
ocean/geometry.ts                center/ring/trim/skirt clipmap mesh generation
ocean/material.ts                three PBR LOD variants and live plugin-state updates
ocean/material-plugin.ts         reference PBRCustomMaterial displacement/shading injections
ocean/shaders.ts                 compute WGSL
ocean/sky.ts                     camera-centered procedural sky
ocean/timing.ts                  opt-in task GPU timings and smoothed FPS panel
```

不允许存在模块级注册表或急切分配的映射。

## 计算资源

每个级联分配如下资源：

| 资源 | 格式 | 访问方式 | 用途 |
| ---- | ---- | -------- | ---- |
| `h0k` | `rg32float` | storage + sampled | 高斯初始复振幅 |
| `h0` | `rgba32float` | storage + sampled | `h0(k)` 与共轭 `h0(-k)` |
| `wavesData` | `rgba32float` | storage + sampled | 波矢、逆模长、频率 |
| 四个振幅纹理 | `rg32float` | storage + sampled | 复位移/导数频谱 |
| 四个 FFT 暂存纹理 | `rg32float` | storage + sampled | 最终空间域场 |
| `displacement` | `rgba16float` | storage + sampled | XYZ 位移 |
| `derivatives` | `rgba16float` | storage + sampled | 表面斜率与水平导数 |
| 两个湍流纹理 | `rgba16float` | storage + sampled | 乒乓泡沫历史 |

位移纹理使用无 mipmap 的双线性过滤。导数和湍流输出使用三线性 mip 过滤、重复寻址以及 `maxAnisotropy = 4`，与参考版的 `RawTexture` 默认值匹配，并在掠射视角下保留高频细节。

三个级联共享一张 `rgba32float` 旋转因子纹理。资源具有稳定的对象身份。为每个乒乓方向预先创建不可变的绑定集；派发执行阶段绝不交换资源句柄或重建绑定组。

初始频谱的高斯值取自与参考版相同的固定 `https://assets.babylonjs.com/environments/noise.exr` 的 R/G 通道。Lite 按参考版的字节布局提取该资产，并将其作为只读 `vec2<f32>` 存储缓冲区上传。切勿用 `Math.random()` 或程序化哈希替换它：两者都会产生不同的海洋随机实现，导致相同的 `seekTime` 不再对应相同的位移场。

## 任务顺序

场景帧图包含以下任务：

1. `ocean-initialize`，配置为一次性任务：
    - 生成初始频谱和波浪元数据；
    - 生成共轭频谱；
    - 预计算 FFT 旋转因子。
2. `ocean-spectrum`，在每个活动帧执行，更新随时间演化的频谱。
3. `ocean-fft`，对每个级联的四个复数场执行水平和垂直 FFT 阶段，并对结果执行重排和符号修正。
4. `ocean-merge`，写入位移、导数和湍流纹理，并将三个第一级联的采样点写入一个 48 字节的浮力缓冲区。
5. 不透明深度预通道（depth prepass）提供接触泡沫所需的深度。
6. 场景渲染任务绘制程序化天空、浮标和海洋。
7. Bloom 和 SMAA 生成最终的交换链图像。

一个任务对应一个 WebGPU 计算通道。初始化与仿真拆分为独立任务，以便一次性任务能在首次成功提交后禁用自身，同时在循环仿真之前保留有序边界。

## Uniform 布局

初始化任务持有：

```ts
struct SpectrumParams {
    size: u32,
    lengthScale: f32,
    cutoffHigh: f32,
    cutoffLow: f32,
    gravity: f32,
    depth: f32,
}
```

两条 `SpectrumParameter` 记录保存在同一个只读存储缓冲区中：

```ts
struct SpectrumParameter {
    scale: f32,
    angle: f32,
    spreadBlend: f32,
    swell: f32,
    alpha: f32,
    peakOmega: f32,
    gamma: f32,
    shortWavesFade: f32,
}
```

仿真任务持有：

- 一个时间 uniform 槽位；
- 一个合并（merge）uniform 槽位；
- 每个 FFT 阶段一个动态 FFT uniform 槽位。

所有槽位均使用强类型的无分配写入器。FFT 派发保留指向同一个 arena 的动态偏移量；该 arena 在计算通道之前执行一次统一上传。

## 频谱数学

实现保留了参考版公式：

```text
omega(k)       = sqrt(g * k * tanh(min(k * depth, 20)))
alpha          = 0.076 * (g * fetch / windSpeed²)^-0.22
peakOmega      = 22 * (windSpeed * fetch / g²)^-0.33
JONSWAP        = scale * TMA * alpha * g² * omega^-5
                 * exp(-1.25 * (peakOmega / omega)^4)
                 * gamma^r
directionality = mix(cos² distribution, cosine-2s distribution, spreadBlend)
```

移植版始终加载参考配置所使用的同一份固定 `noise.exr` R/G 场，并将这些高斯值上传至初始频谱计算着色器。这保留了确定性 `seekTime` 一致性所需的精确随机实现。

## FFT

对于 2 的幂次纹理尺寸 `N`，旋转因子预计算会写入一张 `log2(N) x N` 的 `rgba32float` 纹理。每行包含：

```text
(twiddle.real, twiddle.imaginary, inputIndex0, inputIndex1)
```

每个复数场执行 `log2(N)` 个水平阶段和 `log2(N)` 个垂直阶段。不可变的 A/B 和 B/A 绑定集选择乒乓方向。最终的棋盘格符号重排将空间域结果写入该场的专用输出纹理。

派发计数由显式导出的工作组常量推导而来。运行时代码绝不解析 WGSL 源码来探测工作组维度。

## 渲染

最终渲染器使用相机相对的同心裁剪网格（clipmap）：

- 中心块、环、过渡条和裙边网格按参考几何规则吸附在相机周围；
- 顶点着色器按视距混合三个位移级联；
- PBR 材质插件混合导数和湍流、重建法线，并从与活动画布尺寸一致的不透明深度预通道中添加接触泡沫。片段着色器按帧缓冲像素坐标除以实时画布尺寸来采样深度，并计算 `backgroundViewDepth - waterViewDepth`。反转该减法会将水面后方水下的浮标误判为接触区域，并将其投影轮廓变成白色泡沫条纹；
- 材质使用公共 PBR 材质插件和 `Texture2D` API。

渲染器绝不直接访问原生的 `GPUTexture`、`GPUTextureView`、采样器、设备或命令编码器。

## 生命周期

- 演示一次性创建所有资源。
- 初始化在首次成功提交帧后运行一次。
- 仿真仅修改保留的 uniform 字节与派发启用状态。
- 尺寸调整不会重建仿真纹理。
- 未实现计算任务的设备丢失重建；更广泛的设备丢失子系统正在单独重新设计。

## 热路径要求

- 每帧不创建任何数组、Map、绑定集、着色器、管线、纹理或闭包。
- 时间更新仅向保留的 uniform 存储写入一个标量。
- FFT 阶段偏移量和绑定集在构造时即固定。
- 派发维度预先计算好。
- 渲染纹理绑定保持稳定。
- 浮力仅通过可复用的暂存缓冲区读取三个 `vec4<f32>` 样本，并将请求节流为每六个渲染帧一次。实时 before-render 回调将读取推迟一个微任务，使同步帧提交先于独立的暂存拷贝；录制期间直接调用 `readStorageBuffer` 会被拒绝。`seekTime` 探针提交本身就运行在帧录制之外，并保持显式排列在其读取之前。
- GPU 计时面板在场景注册后按需启用逐任务时间戳查询。它在不阻塞 GPU 的前提下报告独立的频谱演化、逆向 FFT 与合并/探针计算通道、它们的合计计算耗时、计算输出 mip 任务、总计时任务耗时以及指数平滑后的 FPS 值。一次性初始化任务被排除在外，因为面板显示的是循环的最新帧耗时，而非保留历史任务样本。

## 测试规范

- 单元测试覆盖频谱参数打包、网格拓扑、FFT 阶段顺序、乒乓选择以及 2 的幂次校验。
- 演示构建必须能够作为单个过滤后的演示打包产物成功构建。
- 浏览器冒烟测试观测暂停与动画化的 seek 均能到达 `canvas.dataset.ready === "true"`，验证恢复播放，并拒绝任何 WebGPU 验证错误。
- 视觉参考比对工作仅在三级联渲染器完成后开始。

## 文件清单

- `docs/lite/architecture/demo-ocean.md`
- `lab/lite/demo-ocean.html`
- `lab/lite/demo-ocean-reference.html`
- `lab/lite/src/demos/ocean.ts`
- `lab/lite/src/demos/ocean/buoy.ts`
- `lab/lite/src/demos/ocean/constants.ts`
- `lab/lite/src/demos/ocean/controls.ts`
- `lab/lite/src/demos/ocean/demo.ts`
- `lab/lite/src/demos/ocean/lifecycle.ts`
- `lab/lite/src/demos/ocean/fft.ts`
- `lab/lite/src/demos/ocean/geometry.ts`
- `lab/lite/src/demos/ocean/material.ts`
- `lab/lite/src/demos/ocean/resources.ts`
- `lab/lite/src/demos/ocean/shaders.ts`
- `lab/lite/src/demos/ocean/simulation.ts`
- `lab/lite/src/demos/ocean/sky.ts`
- `lab/lite/src/demos/ocean/spectrum.ts`
