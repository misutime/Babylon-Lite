# 模块：阴影生成器（Shadow Generator）

> 包路径：`packages/babylon-lite/src/shadow/`

## 用途

为不同灯光类型实现两种阴影贴图技术：

1. **带双通道高斯模糊的指数阴影贴图（ESM）**，用于**方向光** — 生成一张模糊后的阴影纹理供主材质通道采样。每帧管线：(1) 从灯光视角将阴影投射者渲染到 ESM 深度纹理，(2) 水平高斯模糊，(3) 垂直高斯模糊。

2. **百分比渐近过滤（PCF）**，用于**聚光灯与方向光** — 将投射者渲染到纯深度纹理中；主通道片元着色器使用硬件比较采样器（5×5 双线性 PCF）进行采样。无需模糊通道——相比 ESM 节省 2 次绘制调用与 2 张 GPU 纹理。

两种生成器返回相同的 `ShadowGenerator` 接口，使下游渲染管线与阴影技术无关。投射网格作为场景拥有的 `ShadowTask` 输入进行注册，而非存储在 `ShadowGenerator` 上。阴影贴图由场景的帧图调度：阴影场景通过调用 `registerSceneWithShadowSupport()` 选择启用内部的 `ShadowTask`，因此普通的 `registerScene()` 打包产物不会保留阴影调度代码。PCF 与 ESM 投射者均使用逐源材质的 Standard/PBR/Node 阴影材质视图，从而保留材质与网格的顶点特性。

### Babylon.js 配置等价性

**ESM 生成器**匹配：

- `useBlurExponentialShadowMap = true`，`useKernelBlur = true`，`blurKernel = 64`
- `mapSize = 1024`，`depthScale = 50`，`bias = 0.00005`

**PCF 生成器**匹配：

- `usePercentageCloserFiltering = true`（SM_PCF / shadow5 质量）
- `mapSize = 512`，`bias = 0.00005`

---

## 公共 API 表面

### 运行时启停（`shadow-enabled.ts`）

```typescript
export function setShadowGeneratorEnabled(generator: ShadowGenerator, enabled: boolean): void;
```

运行时启停会保留生成器的挂载关系以及所有接收者的绑定组。禁用时会向现有的接收者 UBO 写入有效暗度 `1`，在纹理采样前直接返回完全受光状态，并跳过阴影贴图渲染。重新启用时会恢复所配置的暗度，并在场景通道之前恢复现有生成器的渲染。仅当导入并调用此 setter 时，才会安装该特性状态。

### 共享基础库（`shadow-base.ts`）

```typescript
/** Write shadow generator state into a Float32Array(24) for UBO upload.
 *  Layout: [_lightMatrix(16), _depthValues.x, _depthValues.y, 0, 0, _shadowsInfo(4)] */
export function writeShadowUboFields(out: Float32Array, sg: { _lightMatrix: Float32Array; _depthValues: Float32Array; _shadowsInfo: Float32Array }): void;

export function buildLightViewMatrix(dirX: number, dirY: number, dirZ: number, px: number, py: number, pz: number): Float32Array;
export function multiply4x4(a: Float32Array, b: Float32Array): Float32Array;
export function createShadowParamsUBO(engine: EngineContextInternal, bias: number, depthScale: number): GPUBuffer;
export function createSharedShadowUBO(
    engine: EngineContextInternal,
    _lightMatrix: Float32Array,
    _depthValues: Float32Array,
    _shadowsInfo: Float32Array
): { ubo: GPUBuffer; data: Float32Array };
```

### ShadowTask 输入（`frame-graph/shadow-inputs.ts`）

```typescript
export interface ShadowTaskInputs {
    readonly casterMeshes: readonly Mesh[];
}

export function setShadowTaskCasterMeshes(shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]): void;

export function setShadowCasterMaxCascade(mesh: Mesh, maxCascade: number): void;
```

投射网格属于任务输入。场景初始化阶段创建特定过滤类型的 `ShadowGenerator`，将其赋值给灯光，调用 `setShadowTaskCasterMeshes()` 提供投射者列表，然后调用 `registerSceneWithShadowSupport()`（而非 `registerScene()`）以安装场景拥有的阴影任务。

`setShadowCasterMaxCascade()` 为 CSM 专用：它将某个投射者限制在级联层 `0..maxCascade`，接受非负整数或 `Infinity`，并在传入新的投射者数组实例时生效。ESM 和单贴图 PCF 会忽略它。

### 通用 ShadowGenerator 接口（`shadow-generator.ts`）

```typescript
export interface ShadowGenerator {
    /** Shadow technique: 'esm' (exponential) or 'pcf' (percentage closer filtering). */
    _shadowType: "esm" | "pcf";
    /** The light that owns this shadow generator. */
    _light: LightBase;
    _depthTexture: GPUTexture; // Receiver-facing map: ESM final blurred rgba16float, PCF depth32float
    _depthSampler: GPUSampler; // Receiver-facing sampler: ESM linear sampler, PCF comparison sampler
    _lightMatrix: Float32Array; // 16-element light view-projection
    _shadowsInfo: Float32Array; // ESM: [darkness, 0, depthScale, frustumEdgeFalloff]
    // PCF: [darkness, mapSize, 1/mapSize, 0]
    _depthValues: Float32Array; // Directional PCF/ESM: [0, 1]; spot PCF: [0, far]
    _shadowParamsUBO: GPUBuffer; // Shared shadow parameters UBO
    _shadowUBO: GPUBuffer; // Receiver-side shadow info UBO
    _config: ShadowGeneratorRuntimeConfig; // minimal normalized fields read by shadow task hooks
    /** Monotonically increasing version — bumped each time _lightMatrix changes.
     *  Consumers compare against a stashed version to skip redundant UBO uploads. */
    _version: number;
}
```

### ESM 工厂函数（`esm-directional-shadow-generator.ts`）

```typescript
export interface EsmDirectionalShadowGeneratorConfig {
    mapSize?: number; // Default: 1024
    depthScale?: number; // Default: 50
    bias?: number; // Default: 0.00005
    blurScale?: number; // Default: 2
    darkness?: number; // Default: 0
    frustumEdgeFalloff?: number; // Default: 0
    orthoMinZ?: number; // Default: 1  — ortho projection near Z
    orthoMaxZ?: number; // Default: 10000 — ortho projection far Z
    forceRefreshEveryFrame?: boolean; // Default: false — regenerate every frame for GPU-driven/deforming casters
}

export function createEsmDirectionalShadowGenerator(engine: Engine, light: DirectionalLight, cfg?: EsmDirectionalShadowGeneratorConfig): ShadowGenerator;
```

### PCF 聚光灯工厂函数（`pcf-spotlight-shadow-generator.ts`）

```typescript
export interface PcfSpotlightShadowGeneratorConfig {
    mapSize?: number; // Default: 512
    bias?: number; // Default: 0.00005
    darkness?: number; // Default: 0
    normalBias?: number; // Default: 0
    near?: number; // Default: 1 (camera near)
    far?: number; // Default: light.range or 10000
    forceRefreshEveryFrame?: boolean; // Default: false — regenerate every frame for GPU-driven/deforming casters
}

export function createPcfSpotlightShadowGenerator(engine: Engine, light: SpotLight, cfg?: PcfSpotlightShadowGeneratorConfig): ShadowGenerator;
```

### PCF 方向光工厂函数（`pcf-directional-shadow-generator.ts`）

```typescript
export interface PcfDirectionalShadowGeneratorConfig {
    mapSize?: number; // Default: 1024
    bias?: number; // Default: 0.00005
    darkness?: number; // Default: 0
    normalBias?: number; // Default: 0
    orthoMinZ?: number; // Default: 1
    orthoMaxZ?: number; // Default: 10000
    forceRefreshEveryFrame?: boolean; // Default: false — regenerate every frame for GPU-driven/deforming casters
}

export function createPcfDirectionalShadowGenerator(engine: Engine, light: DirectionalLight, cfg?: PcfDirectionalShadowGeneratorConfig): ShadowGenerator;
```

### 导入（ESM 生成器）

```typescript
import type { DirectionalLight } from "../light/directional-light.js";
import type { Engine, EngineInternal } from "../engine/engine.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
import { createSharedShadowUBO, createShadowParamsUBO } from "./shadow-base.js";
import blurVertSrc from "../../shaders/shadow-blur.vertex.wgsl?raw";
import blurFragSrc from "../../shaders/shadow-blur.fragment.wgsl?raw";
```

### 导入（PCF 生成器）

```typescript
import type { SpotLight } from "../light/spot-light.js";
import type { Engine, EngineInternal } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import { createSharedShadowUBO, createShadowParamsUBO } from "./shadow-base.js";
import { ensurePcfShadowTaskState, preloadPcfShadowTaskState, renderPcfShadowMap } from "./pcf-shadow-task-hooks.js";
```

---

## 内部架构

### Shadow Base 共享基础设施（`shadow-base.ts`）

阴影生成器之间仅共享数学运算与 UBO 打包辅助函数。投射者所有权位于 `ShadowTaskInputs`：

- **`setShadowTaskCasterMeshes()`** — 在惰性任务拥有的输入状态中为生成器注册投射网格列表。
- **`setShadowCasterMaxCascade()`** — 存储惰性的逐网格 CSM 级联上限；`Infinity` 会清除该限制。
- **`writeShadowUboFields()`** — 将 `ShadowGenerator` 的灯光矩阵（16 个 float）、深度值（2 个 float + 2 个填充）以及 shadowsInfo（4 个 float）打包进一个 24 元素的 float 数组供下游 UBO 上传。
- **`buildLightViewMatrix()` / `multiply4x4()`** — 用于 ESM 与 PCF 任务路径的共享灯光空间矩阵数学运算。
- **`createShadowParamsUBO()` / `createSharedShadowUBO()`** — 为生成器拥有的接收者资源提供共享 GPU 缓冲区初始化。

### Standard/PBR 接收者代码生成

Standard 与 PBR 在其现有的异步材质构建边界处准备接收者代码，然后保留一个场景局部的同步片段工厂，供管线组合与后续逐网格重建使用：

1. 在组合前对不可变的场景阴影槽位进行分类。
2. 如果任意槽位为 CSM，则 CSM 保持优先级：仅将 CSM 槽位转发给已注册的 CSM 接收者工厂。不会调用回退加载器，从而保留现有的不支持混合 CSM+ESM/PCF 的行为。
3. 否则动态导入的 `shadow-fragment-builder.ts` 会使用 `shadow-algorithms.ts` 仅加载槽位中实际存在的算法：
    - 仅 ESM：构建器 + `shadow-fragment-esm.ts`
    - 仅 PCF：构建器 + `shadow-fragment-pcf.ts`
    - 混合 ESM+PCF：构建器 + 两个算法模块
4. Standard 将准备好的工厂存储在不可变的 `StandardShadowContext` 中；PBR 将准备好的闭包传入 `createPbrComposer`。因此同步材质切换、几何体视图以及管线缓存未命中永远不会触发代码导入。

`shadow-fragment-builder.ts` 通过共享的 `shadow-algorithms.ts` 加载器准备单遍 Standard/PBR 组装。每个算法模块提供一个只读描述符，其中包含其不可变纹理/采样器绑定类型以及仅有的两个方法：采样表达式与 WGSL 辅助函数体。构建器拥有所有公共的绑定/发射脚手架，避免可变追加适配器与重复的描述符构建。不可变的绑定类型对象在槽位间复用。对于每个槽位，构建器追加 varying、特定于算法的纹理/采样器绑定、共享的阴影信息 UBO 绑定、顶点计算、采样调用以及辅助函数。不可变的 `shadowInfo_NUniforms` 声明字符串为每个槽位创建一次，并在顶点与片元辅助列表中复用。返回的绑定/varying 顺序与发射的 WGSL 在字节上与之前的分三遍生成器完全一致。

`shadow-fragment-core.ts` 保持作为同步组合的内部兼容性入口，并刻意同时导入两种回退算法。材质包装器改用按需准备的加载器，因此旧入口不会把未使用的 PCF 拉入 ESM 场景、不会把未使用的 ESM 拉入 PCF 场景，也不会把任一回退算法拉入纯 CSM 场景。PBR 继续将共享构建器的 `AD` 片元槽位重映射为 `AS`；Standard 保留 `AD`。

PCF 代码生成在两个坐标轴之间共享偏移向量公式，并按行优先顺序（行在外层，列在内层，各 `0..2`）生成九条采样语句。这些循环仅在准备着色器源码时运行：生成的 GPU 着色器保持完全展开，在字节上与捕获的参考完全一致，乘法与累加顺序均未改变。

`shadow-algorithms.ts` 向 ESM 和 PCF 辅助函数提供相同的裁剪空间转换、UV 转换以及视锥外剔除逻辑。相同的准备与采样实现也服务于 Node 接收者，而无需导入 Standard/PBR 片段组装逻辑。

Node 解析会在管线编译前等待 `prepareNodeShadowEmitter`。其场景局部的同步发射器仅保留所需算法，保留 Group-1 绑定、去重的 varying、Node 世界位置注入以及 `_sf` 调度器。共享辅助生成保留所有着色器词法单元与算术运算；仅 Node 原有的缩进有所变化。`node-shadow.ts` 是组合的同步兼容性入口，而非解析器依赖。Node 发射器在单遍中组装声明、varying 成员资格、绑定与调度，复用每个灯光生成的阴影信息符号。

### ESM 生成器 — GPU 纹理

| 标签 | 尺寸 | 格式 | 用途 |
| ------------------ | ------------------- | -------------- | ------------------------------------ |
| `shadow-esm` | mapSize × mapSize | `rgba16float` | RENDER_ATTACHMENT \| TEXTURE_BINDING |
| `shadow-depth-buf` | mapSize × mapSize | `depth32float` | RENDER_ATTACHMENT |
| `shadow-blur-h` | blurSize × blurSize | `rgba16float` | RENDER_ATTACHMENT \| TEXTURE_BINDING |
| `shadow-blur-v` | blurSize × blurSize | `rgba16float` | RENDER_ATTACHMENT \| TEXTURE_BINDING |

其中 `blurSize = mapSize / blurScale`（默认：1024 / 2 = 512）。

### PCF 生成器 — GPU 纹理

| 标签 | 尺寸 | 格式 | 用途 |
| ------------------ | ----------------- | -------------- | ------------------------------------ |
| `shadow-pcf-depth` | mapSize × mapSize | `depth32float` | RENDER_ATTACHMENT \| TEXTURE_BINDING |

无颜色附件，无模糊纹理。深度纹理在主通道中直接通过比较采样器采样。

### 统一缓冲区（ESM）

#### 场景 UBO（depthSceneUBO）— 64 字节

| 偏移 | 大小 | 内容 |
| ------ | ---- | ------------------------------------------ |
| 0 | 64B | 灯光视图-投影矩阵（`mat4x4<f32>`） |

#### 阴影参数 UBO（shadowParamsUBO）— 32 字节

| 偏移（字节） | Float32 索引 | 内容 |
| -------------- | ------------- | ---------------------------------------- |
| 0 | [0] | bias（默认：0.00005） |
| 4 | [1] | _（未使用）_ |
| 8 | [2] | depthScale（默认：50） |
| 12 | [3] | _（未使用）_ |
| 16 | [4] | depthMinZ = 0（WebGPU 方向光） |
| 20 | [5] | depthMinZ + depthMaxZ = 1 |
| 24 | [6] | _（未使用）_ |
| 28 | [7] | _（未使用）_ |

#### 逐投射者网格 UBO — 64 字节

| 偏移 | 大小 | 内容 |
| ------ | ---- | -------------------------- |
| 0 | 64B | 世界矩阵（`mat4x4<f32>`） |

#### 水平模糊 UBO — 16 字节

| 偏移 | 内容 |
| ------ | ------------------------------------- |
| 0–7 | `delta = (1.0 / blurSize, 0)`（vec2） |
| 8–15 | 填充（0, 0） |

#### 垂直模糊 UBO — 16 字节

| 偏移 | 内容 |
| ------ | ------------------------------------- |
| 0–7 | `delta = (0, 1.0 / blurSize)`（vec2） |
| 8–15 | 填充（0, 0） |

### 统一缓冲区（PCF）

#### 场景 UBO（depthSceneUBO）— 64 字节

与 ESM 相同：灯光视图-投影矩阵。

#### 阴影参数 UBO — 32 字节

| 偏移（字节） | Float32 索引 | 内容 |
| -------------- | ------------- | ------------------------------------------------ |
| 0 | [0] | bias（默认：0.00005） |
| 4 | [1] | _（未使用）_ |
| 8 | [2] | 1 / mapSize（纹素尺寸，复用 depthScale 槽位） |
| 12 | [3] | _（未使用）_ |
| 16 | [4] | depthMinZ = 0 |
| 20 | [5] | depthMinZ + depthMaxZ = 1 |
| 24 | [6] | _（未使用）_ |
| 28 | [7] | _（未使用）_ |

### shadowsInfo 布局差异

| 字段索引 | ESM | PCF |
| ----------- | ------------------ | ----------- |
| [0] | darkness | darkness |
| [1] | 0（未使用） | mapSize |
| [2] | depthScale | 1 / mapSize |
| [3] | frustumEdgeFalloff | 0（未使用） |

### 灯光视图-投影矩阵计算

#### 方向光阴影：矩阵计算（正交投影）

```typescript
function computeDirectionalLightMatrix(
    light: DirectionalLight,
    casterMeshes: readonly Mesh[],
    orthoMinZ: number,
    orthoMaxZ: number,
    offX?: number,
    offY?: number,
    offZ?: number
): { _view: Float32Array; _viewProj: Float32Array; _near: number; _far: number };
```

**算法：**

1. 用灯光世界矩阵变换局部方向并归一化：`dir = normalize(light.worldMatrix * vec4(light.direction, 0))`
2. 选择 up 向量：`(0, 1, 0)`，除非 `|dirY| > 0.99`，此时改用 `(0, 0, 1)`
3. 构建标准正交基：
    - `right = normalize(cross(up, dir))`
    - `up' = cross(dir, right)`
4. 构建视图矩阵（列主序，forward = dir）：
    ```
    V = | rx  ux  dirX  0 |
        | ry  uy  dirY  0 |
        | rz  uz  dirZ  0 |
        | -dot(r,P) -dot(u,P) -dot(dir,P) 1 |
    ```
    其中 `P = light.worldMatrix[12..14]`
5. 对于普通投射网格，将几何局部 AABB（`mesh.boundMin`/`boundMax`，默认单位立方体）的 8 个角点依次通过 `worldMatrix` 和 `view` 变换，得到灯光空间 X/Y 边界。对于薄实例，先对每个活跃实例用 `worldMatrix × instanceMatrix` 变换原型角点，合并为世界空间 AABB，再通过 `view` 变换该包围盒。只计入线性变换非零的活跃实例，活跃数量以上传的矩阵缓冲区容量为上限。实例集合为空时没有边界贡献。
6. 按 10% 扩展边界（`shadowOrthoScale = 0.1`）：`lMinX -= (lMaxX - lMinX) * 0.1` 等
7. 从 `orthoMinZ`/`orthoMaxZ`（相机近/远平面）获取 Z 边界
8. 构建正交投影矩阵（列主序，WebGPU z=[0,1]）：
    ```
    P[0]  = 2 / (lMaxX - lMinX)
    P[5]  = 2 / (lMaxY - lMinY)
    P[10] = 1 / (far - near)
    P[12] = -(lMaxX + lMinX) / (lMaxX - lMinX)
    P[13] = -(lMaxY + lMinY) / (lMaxY - lMinY)
    P[14] = -near / (far - near)
    P[15] = 1
    ```
9. 相乘：`viewProj = proj * view`（标准 4×4 乘法）

方向光 ESM 和 PCF 共用 `shadow/shadow-base.ts` 中的 `computeDirectionalLightMatrix()`。投射者异步预加载时调用 `preloadDirectionalShadowBounds(casterMeshes)`，仅在存在薄实例投射者时导入 `shadow/thin-instance-shadow-bounds.ts`。CSM 直接导入同一个包围盒辅助模块。

重新拟合方向光边界前，`prepareDirectionalShadowBounds(generator, casterMeshes)` 会检测已注册的普通投射网格是否转为薄实例，即使投射者数组本身的引用保持不变。辅助模块尚未就绪时，`frame-graph/shadow-inputs.ts` 中的 `_preloadRegisteredShadowCasters(generator)` 从注册表重新提供原始投射者集合，材质家族的等待路径也调用同一个辅助函数。这样可避免对形变目标或骨骼包围盒重复应用变换，并集中处理源列表和等待状态。现有阴影任务预加载器会暂停生成器、报告导入失败，并在预加载成功后恢复。PCF 的矩阵回调可返回 `null` 延后拟合，ESM 则在拟合前返回。等待期间，两条路径均保留先前的阴影贴图及脏状态跟踪版本，静态帧沿用原有的扫描频率。

实际拟合通过合成后的灯光视图与世界仿射变换投影局部包围盒区间，结果与变换八个角点后取极值完全等价。每个投影行以双精度标量极值拟合，将灯光视图缩放和平移后直接写入 F32 输出，省去临时包围盒存储和稀疏 4×4 投影矩阵的分配及乘法。`getShadowLightView(light, offX, offY, offZ)` 统一处理方向光和聚光灯拟合中的节点方向到世界方向和浮动原点转换。共享的 `multiply4x4()` 复用已有的无分配 `multiplyMat4IntoBuffer()` 内核。私有缓存字段沿用阴影模块的 `_` 前缀约定。

生成器持有的 `_lightMatrix` 和拟合后的 `_viewProj` 各是一份连续存放的 F32 矩阵，可直接使用原生 `TypedArray.set()` 复制。ESM 的比较复制辅助函数在发现分量不同后更新矩阵，再递增生成器版本。UBO 打包依然显式将填充字段置零。

`preloadPcfShadowTaskState(casterMeshes, loads = [])` 将材质家族的导入追加到预加载批次并等待整批完成。方向光 PCF 传入 `[preloadDirectionalShadowBounds(casterMeshes)]` 作为该批次，使包围盒与材质导入并行，且共用一层异步等待。聚光灯 PCF 和 CSM 使用默认的空批次。

ESM 直接选择最接近的成对采样核。设 `v = round(max(requested, 1))`，核大小为 `max(floor(v / 4) * 4 + 1, 3)`。结果与原先从五个候选值搜索的 `4k+1` 选择一致，距离相同时取较小的核，且省去候选数组及扫描。高斯权重和双线性采样点配对保持原样。

`getShadowCasterWorldBounds(mesh)` 返回普通或薄实例投射者的缓存世界空间 AABB `{ min: [x,y,z], max: [x,y,z] }`，没有活跃实例贡献时返回 `null`。CSM 对所有投射者使用它，省去普通包围盒的独立角点循环，且仅相机变动触发拟合时可复用变换结果。惰性 `WeakMap<Mesh, ...>` 缓存依据实例版本、矩阵数组引用、截断后的活跃数量、网格世界矩阵版本和六个几何边界坐标判断是否有效。实例路径对仿射变换求中心与半径对应的极值，可保留带符号缩放和剪切效果。稳定条目复用输出存储，缓存仅占用 CPU 资源。

惰性适配器 `getDirectionalShadowCaster(mesh)` 原样返回普通网格。对于薄实例，它复用缓存的普通包围盒视图，其中 `boundMin`/`boundMax` 直接引用缓存的世界极值，`worldMatrix` 使用单位矩阵。实例集合为空时返回 `null`。适配器及其单位矩阵只位于按需加载的模块内，拟合器以同一套矩阵及包围盒接口处理两类投射者，调用方通过预加载确保辅助模块就绪。`getThinInstanceWorldBounds(mesh)` 仍用于内部仅查询包围盒的场景，对普通网格返回 `undefined`。共享的方向光拟合器在计算世界包围盒后仅减去一次浮动原点偏移。

`Mesh.boundMin`/`boundMax` 始终表示任何实例或世界变换前的原型几何包围盒，包括使用方为形变提供保守边界的情况。精确拾取、裁剪和物理继续使用原型包围盒。阴影拟合单独推导汇总边界，保留这些字段及现有公开的包围盒和投影配置。

#### 聚光灯 PCF：`_computeSpotLightMatrix`（透视投影）

```typescript
function _computeSpotLightMatrix(light: SpotLight, near: number, far: number): { viewProj: Float32Array; near: number; far: number };
```

**算法：**

1. 用灯光世界矩阵变换局部方向并归一化：`dir = normalize(light.worldMatrix * vec4(light.direction, 0))`
2. 选择 up 向量：`(0, 1, 0)`，除非 `|dirY| > 0.99`，此时改用 `(0, 0, 1)`
3. 构建标准正交基（与 ESM 相同）：`right = cross(up, dir)`、`up' = cross(dir, right)`
4. 从 `light.worldMatrix[12..14]` 构建视图矩阵（列主序）
5. 构建**透视**投影矩阵（列主序，WebGPU z=[0,1]）：
    - FOV = `light.angle`（完整锥角，弧度制）
    - 宽高比 = 1:1（正方形阴影贴图）
    ```
    f = 1 / tan(FOV * 0.5)
    P[0]  = f          // aspect = 1
    P[5]  = f
    P[10] = far / (far - near)
    P[11] = 1          // perspective divide
    P[14] = -(far * near) / (far - near)
    ```
6. 相乘：`viewProj = proj * view`

聚光灯矩阵辅助函数从 `shadow/pcf-spotlight-shadow-generator.ts` 中作为内部函数 `_computeSpotLightMatrix()` 导出。

---

## 管线配置

### ESM 阴影深度管线

**顶点缓冲区：**

| 槽位 | 步长 | 属性 | 位置（Location） | 格式 |
| ---- | ------ | --------- | -------- | --------- |
| 0 | 12B | position | 0 | float32x3 |

**绑定组布局：**

Group 0 — `shadow-depth-scene`：

| 绑定 | 可见性 | 类型 | 内容 |
| ------- | ---------- | ------- | -------------------------------- |
| 0 | VERTEX | uniform | 灯光视图-投影（64 字节） |

Group 1 — `shadow-depth-mesh`：

| 绑定 | 可见性 | 类型 | 内容 |
| ------- | --------------- | ------- | ------------------------ |
| 0 | VERTEX | uniform | 世界矩阵（64 字节） |
| 1 | VERTEX+FRAGMENT | uniform | 阴影参数（32 字节） |

**管线状态：**

- 图元：`triangle-list`，剔除：`back`，正面：`ccw`
- 深度/模板：`depth32float`，写入：`true`，比较：`less-equal`
- 颜色目标：`rgba16float`（1 个目标）
- 无多重采样

### ESM 模糊管线

**顶点缓冲区：** 无（由 `vertex_index` 生成全屏三角形）

**绑定组布局** — `shadow-blur`：

| 绑定 | 可见性 | 类型 | 内容 |
| ------- | --------------- | ------- | ------------------------ |
| 0 | VERTEX+FRAGMENT | uniform | BlurParams（16 字节） |
| 1 | FRAGMENT | texture | 源纹理（float） |
| 2 | FRAGMENT | sampler | 线性过滤采样器 |

**管线状态：**

- 图元：`triangle-list`，剔除：`none`
- 无深度/模板
- 颜色目标：`rgba16float`（1 个目标）

**模糊采样器：**

- `minFilter: 'linear'`，`magFilter: 'linear'`
- `addressModeU: 'clamp-to-edge'`，`addressModeV: 'clamp-to-edge'`

最终的垂直模糊目标存储在 `ShadowGenerator._depthTexture` 中；接收者直接绑定 `sg._depthTexture` 和 `sg._depthSampler`，与 PCF 一致。

### PCF 阴影深度管线

PCF 深度渲染使用常规的材质可渲染对象路径并配以通道专用的无颜色阴影材质视图。活跃的材质家族（Standard、PBR 或 Node）提供顶点缓冲区、网格绑定组和管线；该视图仅更改渲染特性位，以选择一个片元阶段不写入颜色的变体。

**管线状态：**

- 图元/剔除/顶点布局：继承自 Standard/PBR 材质管线
- 深度/模板：`depth32float`，写入：`true`，比较：`less-equal`
- 偏移处理：`ShadowTask` 将 Babylon 风格的裁剪空间线性偏移（针对 WebGPU 半 Z 深度的 `bias * 0.5`）烘焙到阴影通道的视图-投影矩阵中。PCF **不**使用 WebGPU 管线 `depthBias` / `depthBiasSlopeScale`。
- **无颜色目标**（纯深度通道）
- **需要时保留片元阶段**，带有 void 入口点，以便材质的 `discard` / alpha 测试逻辑在不写入颜色的情况下更新深度附件
- 无多重采样

**增量式 PCF 投射者。** 任务、目标、阴影相机及 UBO 在投射者集合与材质变更期间保持存活。状态缓存无颜色视图，并与 `_casterMeshes` 分开维护实际已入队网格的持久化快照（因为可变形投射者包装器会临时将 `_casterMeshes` 替换为应用程序的源数组）。每条投射者记录存储其接收材质、终端材质和可渲染代数（null 条目表示被暂挂或无材质的投射者）。以终端材质为键的单一缓存存储每个无颜色视图及其代数与捕获的特性。因此共享同一终端的覆盖链既不需要重复的缓存条目，也不需要单独的链清理。仅当投射者入队时其记录才会更新，因此新加入的投射者可共享仍然有效的视图，而无需重新入队其同侪或重建并行数组。单次稳定压缩会丢弃已移除/已变更的数据包并一次性重新选择绘制批次。数据包资源在帧栅栏后退役。新增/变更的投射者在未绑定的情况下入队，然后 `_recordedVersion = -1` 使调度器一次性解析并绑定全部变更。`_lastCasterVersion = -1` 强制贴图重绘；仅当成员发生变化时才会使任务渲染束/版本缓存失效。重新排序或重新传入相同成员会保留数据包与渲染束。在构建任何新视图之前，会先使过时的终端视图失效，并清理没有任何活跃数据包可达的缓存终端。被替换的生成器深度纹理或贴图尺寸仍会在帧栅栏后使整个任务退役并创建新目标。

**投射者材质变更。** PCF 状态会对每个投射者的终端材质、其 `_csmGen` 与 `_renderFeatures` 以及投射者的 `_renderableGen` 做快照。新的投射者数组、被切换或重指向的投射者材质、重建过的材质、重新计算了渲染特性的终端材质，或自身可渲染对象被重建的投射者，都会使下一次 ensure 仅重新入队受影响的投射者。当终端材质仅通过投射者集合之外的网格被重建时，特性同样重要——例如一个同时作为不投射阴影网格材质的覆盖材质：那次重建只推进该网格的代数，而投射者的视图仍保留构建它时的特性（alpha 测试、剔除）。被丢弃但尚未重新计算的特性不计入，与 CSM 一致：此时构建的视图不会读取它们。无法立即构建视图的投射者会以 null 投射者快照留在该任务之外，采用与 CSM 协调相同的 `holdShadowCaster` 检查：其材质家族的无颜色视图工厂尚未导入（会重新提供已注册集合，从而在导入期间使生成器暂停一次），或者它投射所通过的材质自身在此场景中尚无已完成的组构建。在被暂挂的投射者保持暂挂期间，ensure 直接返回现有任务；一旦暂挂解除或变更被撤销，下一次 ensure 会将该投射者入队到同一任务中。这也适用于首次构建，因为在注册预加载导入期间，投射者可能会切换材质家族。

### PCF 主通道集成

Standard、PBR 与 Node 阴影接收者使用异步准备好的采样算法。Node 保留自身的 Group-1 绑定与调度器组装。生成器侧没有 PCF 着色器注册路径；生成器仅暴露面向接收者的纹理/采样器/UBO 资源。

**主通道的接收者绑定组条目：**

| 绑定 | 类型 | 内容 |
| ------- | -------------------- | ------------------------------------------------------ |
| 0 | `texture_depth_2d` | 阴影深度纹理 |
| 1 | `sampler_comparison` | 比较采样器（compare: `less`，线性过滤） |

**接收者着色器片段：**

- **声明：** `@group(2) @binding(0) var shadowTex: texture_depth_2d; @group(2) @binding(1) var shadowCompSampler: sampler_comparison;`
- **函数：** `computeShadowWithPCF(posFromLight, depthMetric, darkness, mapSize, invMapSize) → f32`
- **调用点：** `shadow = computeShadowWithPCF(input.vPositionFromLight, input.vDepthMetric, shadowInfo.shadowsInfo.x, shadowInfo.shadowsInfo.y, shadowInfo.shadowsInfo.z);`

---

## 着色器逻辑

### ESM 材质阴影视图顶点路径

```wgsl
struct SceneUniforms { viewProjection: mat4x4<f32> };            // @group(0) @binding(0)
struct MeshUniforms  { world: mat4x4<f32> };                     // @group(1) @binding(0)
struct ShadowParams  {
  biasAndScale: vec4<f32>,  // x=bias, y=unused, z=depthScale, w=unused
  depthValues: vec4<f32>,   // Directional x=0,y=1; spot PCF receiver x=0,y=far
};                                                                // @group(1) @binding(1)

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) vDepthMetricSM: f32,
};

@vertex fn main(@location(0) position: vec3<f32>) -> VertexOutput {
  worldPos = mesh.world * vec4(position, 1.0)
  clipPos  = scene.viewProjection * worldPos
  vDepthMetricSM = (clipPos.z + depthValues.x) / depthValues.y + bias
}
```

**深度度量公式：**

```
vDepthMetricSM = (clipPos.z + 0) / 1 + 0.00005
               = clipPos.z + bias
```

对于 WebGPU 方向光，`depthValues = (0, 1)`。对于聚光灯 PCF 接收者采样，`depthValues = (0, far)`，与 Babylon.js 在 WebGPU 半 Z 模式下的 `SpotLight.getDepthMinZ()/getDepthMaxZ()` 一致。

### ESM 材质阴影视图片元输出

首先运行投射材质的正常片元逻辑，包括 alpha 测试、`DiscardBlock` 和裁剪平面丢弃。与无颜色视图类似，ESM 阴影视图会剔除仅用于着色的法线贴图、高光-光泽度特性以及折射（参见 [06-pbr-material.md](06-pbr-material.md#材质视图与重建)）。随后 ESM 阴影视图将最终颜色输出替换为固定的 ESM 编码：

```wgsl
@fragment fn main(@location(0) vDepthMetricSM: f32) -> @location(0) vec4<f32> {
  depthSM = clamp(exp(-min(87.0, depthScale * vDepthMetricSM)), 0.0, 1.0)
  return vec4(depthSM, 1.0, 1.0, 1.0)
}
```

**ESM 编码公式：**

```
output.r = clamp(exp(-min(87.0, 50.0 * depth)), 0, 1)
```

`min(87.0, ...)` 用于防止 `exp()` 发生浮点溢出。结果存储在红色通道中。较近的片元（depth ≈ 0）产出接近 1.0 的值；较远的片元产出接近 0.0 的值。

### 阴影深度顶点着色器 — PCF

PCF 不再拥有自定义的纯位置深度顶点着色器。`ShadowTask` 通过 Standard/PBR/Node 无颜色阴影材质视图渲染投射者，因此正常的材质顶点路径能够处理变形目标、骨骼、瘦实例、依赖 UV 的 alpha 测试以及未来的材质顶点扩展。当需要丢弃逻辑时，无颜色阴影变体会发射一个 void 片元阶段；不绑定颜色附件或占位纹理。偏移被烘焙在任务场景 UBO 的灯光空间视图-投影矩阵中；PCF 不使用 WebGPU 管线深度偏移状态。

### PCF 采样函数（注入主通道片元着色器）

```wgsl
fn computeShadowWithPCF(
  posFromLight: vec4<f32>,
  depthMetric: f32,
  darkness: f32,
  mapSize: f32,
  invMapSize: f32,
) -> f32 {
  // Project to shadow UV
  let clipSpace = posFromLight.xyz / posFromLight.w;
  let uv = vec2(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
  if (uv out of [0,1]) { return 1.0; }  // outside shadow map → fully lit

  let depthRef = clamp(clipSpace.z, 0.0, 1.0);

  // 5×5 optimised bilinear PCF (9 taps via 3×3 grid with fractional offsets)
  var tc = uv * mapSize + 0.5;
  let st = fract(tc);
  let base = (floor(tc) - 0.5) * invMapSize;

  // Bilinear weights from sub-texel position
  let uvw0 = 4.0 - 3.0 * st;
  let uvw1 = vec2(7.0);
  let uvw2 = 1.0 + 3.0 * st;

  // Optimised sample offsets (3 per axis)
  let u = vec3((3.0 - 2.0*st.x)/uvw0.x - 2.0, (3.0+st.x)/uvw1.x, st.x/uvw2.x + 2.0) * invMapSize;
  let v = vec3((3.0 - 2.0*st.y)/uvw0.y - 2.0, (3.0+st.y)/uvw1.y, st.y/uvw2.y + 2.0) * invMapSize;

  // 9 comparison samples (3×3 grid), weight sum = 144
  var sh = 0.0;
  for each (ui, vi) in 3×3 grid:
    sh += uvw_u * uvw_v * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2(u[ui], v[vi]), depthRef);
  sh /= 144.0;

  return mix(darkness, 1.0, sh);
}
```

### 阴影模糊顶点着色器（`shadow-blur.vertex.wgsl`）

```wgsl
struct BlurParams {
  delta: vec2<f32>,   // texel step direction
  _pad: vec2<f32>,
};                    // @group(0) @binding(0)

@vertex fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle (oversized, clipped by rasterizer)
  positions = [(-1, -1), (3, -1), (-1, 3)]
  clipPos = vec4(positions[vertexIndex], 0, 1)
  sampleCenter = p * vec2(0.5, -0.5) + 0.5   // clip → UV
}
```

### 阴影模糊片元着色器（`shadow-blur.fragment.wgsl`）

实现一个 33 抽头高斯模糊，与 Babylon 在 `blurKernel = 64` 下的 `kernelBlur` 后处理一致。

**抽头结构：** 26 个双线性抽头 + 7 个依赖抽头 = 共 33 个抽头。

**双线性抽头偏移量（26 个值，对称成对）：**

```
±31.43122487, ±29.43554136, ±27.43986765, ±25.44420309,
±23.44854704, ±21.45289886, ±19.45725789, ±17.46162348,
±15.46599496, ±13.47037167, ±11.47475294, ±9.4791381,
±7.48352647
```

**双线性抽头权重（26 个值，对称成对）：**

```
0.00096573, 0.00096573, 0.00164886, 0.00164886,
0.0027182,  0.0027182,  0.00432655, 0.00432655,
0.00664916, 0.00664916, 0.00986638, 0.00986638,
0.01413558, 0.01413558, 0.01955395, 0.01955395,
0.02611683, 0.02611683, 0.03367998, 0.03367998,
0.04193613, 0.04193613, 0.05041622, 0.05041622,
0.05852177, 0.05852177
```

**依赖抽头偏移量（7 个值，对称成对 + 中心）：**

```
-5.48791739, 5.48791739, -3.49231018, 3.49231018,
-1.49670415, 1.49670415, 0.0
```

**依赖抽头权重（7 个值）：**

```
0.06558884, 0.06558884, 0.0709754, 0.0709754,
0.07415683, 0.07415683, 0.0374872
```

**片元算法：**

```wgsl
@fragment fn main(@location(0) sampleCenter: vec2<f32>) -> @location(0) vec4<f32> {
  var blend = vec4(0.0);

  // 26 bilinear taps
  for (i in 0..26) {
    coord = sampleCenter + params.delta * OFFSETS[i]
    blend += textureSample(srcTex, srcSampler, coord) * WEIGHTS[i]
  }

  // 7 dependent taps
  for (i in 0..7) {
    coord = sampleCenter + params.delta * DEP_OFFSETS[i]
    blend += textureSample(srcTex, srcSampler, coord) * DEP_WEIGHTS[i]
  }

  return blend;
}
```

---

## 状态机 / 生命周期

### 帧图调度

`registerSceneWithShadowSupport(scene)` 在默认的交换链场景渲染任务之前安装一个内部帧图 `ShadowTask`。阴影纹理由每个 `ShadowGenerator` 拥有；阴影渲染由 `ShadowTask` 拥有。在每一帧中，`ShadowTask.execute()` 读取 `engine._currentEncoder`，遍历 `scene.lights`，并渲染每个灯光的阴影生成器。返回的绘制次数会由 `FrameGraph.execute()` 与场景渲染任务一同汇总。

ESM 生成器向 `ShadowTask` 暴露其深度/模糊资源。投射网格注册为 `ShadowTask` 输入。在 `record()` 期间，PCF 基于生成器的深度纹理创建一个纯深度 `RenderTask`；ESM 基于其任务资源创建一个 ESM 颜色+深度 `RenderTask`。两条路径都会为每个唯一的投射材质创建一个阴影材质视图。

每个生成器状态拥有一个聚合的 `_recordedVersion`。`ShadowTask` 在录制前对 `scene._renderableVersion` 做快照，并仅在所有内部通道都成功录制后才发布该快照。因此部分级联失败会保留旧值以供重试，而在录制期间发生场景变更则会留下一个刻意过时的快照，迫使下一帧重新录制。阴影相机外观同样自行携带其已安装的缓存版本号，因此 PCF、ESM 和 CSM 更新直接推进 `camera.worldMatrixVersion`，而无需在任务状态中维护第二个计数器。

ESM 的水平与垂直模糊通道共享一个内部录制辅助函数。它们各自仍创建当前目标视图、清除为透明黑色、存储结果、绑定同一模糊管线及其轴向特定的绑定组，并绘制三个顶点。水平输出馈送垂直输入；报告的绘制次数仍为投射者数量加二。

### ESM 初始化（一次）

1. 创建阴影参数 UBO（bias、depthScale、depthValues）
2. 创建 4 个 GPU 纹理：ESM 目标、深度缓冲、水平模糊目标、垂直模糊目标
3. 创建模糊管线、模糊 UBO 与模糊绑定组
4. 创建共享的接收者阴影 UBO
5. 通过内部资源映射存储仅限 ESM 的任务资源
6. 返回 `_shadowType: 'esm'` 的 `ShadowGenerator`

场景配置单独通过 `setShadowTaskCasterMeshes()` 将投射网格注册为 `ShadowTask` 输入。

### PCF 初始化

1. 创建单个纯深度纹理（`depth32float`，`RENDER_ATTACHMENT + TEXTURE_BINDING`）
2. 创建比较采样器（`compare: 'less'`，线性过滤）
3. 创建阴影参数 UBO（bias、纹素尺寸、depthValues）
4. 将投射网格注册为 `ShadowTask` 输入；任务将生成器的深度纹理包装进一个纯深度渲染目标中
5. 返回 `shadowType: 'pcf'` 的 `ShadowGenerator`

### 逐帧渲染 — ESM（`ShadowTask`）

```
Recompute light matrix → update shared receiver shadow UBO if dirty

Pass 1: Shadow Depth
  ├─ Clear esmTexture to (0,0,0,0), depthBuf to 1.0
  ├─ Build/record a material-view RenderTask from ShadowTask caster inputs
  └─ Draw each caster through the material renderable path

Pass 2: Blur Horizontal
  ├─ Clear blurTexH to (0,0,0,0)
  ├─ Set blurPipeline
  ├─ Set group(0) = blurHBG (delta=(1/blurSize, 0), source=esmTexture)
  └─ draw(3)  // fullscreen triangle

Pass 3: Blur Vertical
  ├─ Clear blurTexV to (0,0,0,0)
  ├─ Set blurPipeline
  ├─ Set group(0) = blurVBG (delta=(0, 1/blurSize), source=blurTexH)
  └─ draw(3)  // fullscreen triangle

Returns: casters.length + 2  (depth draws + 2 blur passes)
```

### 逐帧渲染 — PCF（`ShadowTask`）

```
ShadowTask.record()
  ├─ Create one Standard/PBR/Node no-color shadow MaterialView per unique caster material
  ├─ Create a depth-only RenderTask targeting the generator's depth texture
  └─ Add each caster mesh to the task with its no-color shadow material view

ShadowTask.execute()
  ├─ Recompute spot or directional light matrix if the light/caster state is dirty
  ├─ Update the shared receiver shadow UBO
  └─ Execute the depth-only RenderTask

Pass 1: Shadow Depth (single pass, depth-only)
  ├─ colorAttachments: []  (no color output)
  ├─ Clear depthTexture to 1.0
  ├─ Set group(0) = task scene UBO (biased light viewProjection)
  └─ Draw each caster through the material renderable path

Returns: casters.length  (depth draws only — no blur passes)
```

## Babylon.js 等价映射表

| Babylon Lite | Babylon.js |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `createEsmDirectionalShadowGenerator()` | 带方向光 ESM 配置的 `new ShadowGenerator(mapSize, light)` |
| `createPcfSpotlightShadowGenerator()` | 带聚光灯 PCF 配置的 `new ShadowGenerator(mapSize, light)` |
| `createPcfDirectionalShadowGenerator()` | 带方向光 PCF 配置的 `new ShadowGenerator(mapSize, light)` |
| `ShadowGenerator._shadowType === 'esm'` | `ShadowGenerator.useBlurExponentialShadowMap = true` |
| `ShadowGenerator._shadowType === 'pcf'` | `ShadowGenerator.usePercentageCloserFiltering = true` |
| `EsmDirectionalShadowGeneratorConfig.mapSize` | `ShadowGenerator.mapSize` |
| `EsmDirectionalShadowGeneratorConfig.depthScale` | `ShadowGenerator.depthScale` |
| `EsmDirectionalShadowGeneratorConfig.bias` | `ShadowGenerator.bias` |
| `EsmDirectionalShadowGeneratorConfig.blurScale` | `ShadowGenerator.blurScale` |
| `EsmDirectionalShadowGeneratorConfig.darkness` | `ShadowGenerator.darkness` |
| `EsmDirectionalShadowGeneratorConfig.frustumEdgeFalloff` | `ShadowGenerator.frustumEdgeFalloff` |
| `EsmDirectionalShadowGeneratorConfig.forceRefreshEveryFrame` | 针对动态/变形投射者强制每帧渲染阴影贴图 |
| `PcfSpotlightShadowGeneratorConfig.normalBias` / `PcfDirectionalShadowGeneratorConfig.normalBias` | `ShadowGenerator.normalBias` |
| ESM 编码（`exp(-depthScale*d)`） | `ShadowGenerator.useBlurExponentialShadowMap = true` |
| 33 抽头高斯模糊（kernel=64） | `ShadowGenerator.useKernelBlur = true; .blurKernel = 64` |
| PCF 5×5 双线性（9 个优化抽头） | `ShadowGenerator.filteringQuality = SM_PCF` |
| `computeDirectionalLightMatrix()` | `DirectionalLight._setDefaultAutoExtendShadowProjectionMatrix()` |
| `_computeSpotLightMatrix()` | `SpotLight._setDefaultShadowProjectionMatrix()` |
| `shadowOrthoScale = 0.1`（扩展比例） | `DirectionalLight.shadowOrthoScale = 0.1` |
| 方向光 `depthValues = [0, 1]` | `DirectionalLight.getDepthMinZ()=0`, `getDepthMaxZ()=1`（WebGPU 半 Z） |
| 聚光灯 PCF `depthValues = [0, far]` | `SpotLight.getDepthMinZ()=0`, `getDepthMaxZ()=far`（WebGPU 半 Z） |
| `setShadowTaskCasterMeshes()` | 等价于 `ShadowGenerator.addShadowCaster(mesh)` 的渲染列表输入 |
| `ShadowTask.execute()` | 接收者渲染前的场景/帧编排 |
| ESM `ShadowGenerator._depthTexture` | `ShadowGenerator.getShadowMap()`（模糊通道之后） |
| `_lightMatrix` | `ShadowGenerator.getTransformMatrix()` |
| `writeShadowUboFields()` | Babylon 阴影系统中的内部 UBO 打包 |
| `ShadowGenerator._version` | 无直接等价物 — Lite 使用版本号进行脏追踪 |

---

## 依赖项

### shadow-base.ts

- `../mesh/mesh.js` — `Mesh`、`MeshInternal` 接口

### esm-directional-shadow-generator.ts（ESM）

- `../light/directional-light.js` — `DirectionalLight` 接口
- `../engine/engine.js` — `Engine`、`EngineInternal`
- `./shadow-base.js` — 共享阴影参数与接收者 UBO 辅助函数
- `../../shaders/shadow-blur.vertex.wgsl` — 模糊顶点着色器（raw 导入）

### pcf-spotlight-shadow-generator.ts（PCF）

- `../light/spot-light.js` — `SpotLight` 接口
- `../engine/engine.js` — `Engine`、`EngineInternal`
- `./shadow-base.js` — 共享灯光矩阵、矩阵乘法、阴影 UBO/参数辅助函数
- `./shadow-generator.js` — `ShadowGenerator` 类型
- `./pcf-shadow-task-hooks.js` — 共享 PCF 任务预加载/状态/渲染辅助函数

### pcf-directional-shadow-generator.ts（方向光 PCF）

- `../light/directional-light.js` — `DirectionalLight` 接口
- `../mesh/mesh.js` — 用于投射者 AABB 拟合的 `Mesh` 接口
- `../engine/engine.js` — `Engine`、`EngineInternal`
- `./shadow-base.js` — 共享灯光矩阵、矩阵乘法、阴影 UBO/参数辅助函数
- `./shadow-generator.js` — `ShadowGenerator` 类型
- `./pcf-shadow-task-hooks.js` — 共享 PCF 任务预加载/状态/渲染辅助函数及 PCF 任务状态类型

### pcf-shadow-task-hooks.ts

- `../frame-graph/render-task.js` — 用于 PCF 深度通道的内部材质视图渲染任务
- `./shadow-base.js` — 共享投射者版本、相机、渲染目标与接收者 UBO 辅助函数
- `./shadow-generator.js` — `ShadowGenerator` 与任务状态契约

### frame-graph/shadow-task.ts

- `../engine/engine.js` — `EngineContext`、`EngineContextInternal`
- `../scene/scene-core.js` — `SceneContext`、`SceneContextInternal`
- `./task.js` — `Task`
- `./shadow-inputs.js` — 任务拥有的投射网格输入访问器

---

## 测试规范

1. **ESM 灯光矩阵计算** — 给定方向为 `(-1, -3, 2)` 的方向光与投射网格，验证计算出的视图-投影矩阵为已知世界坐标点生成正确的 NDC 坐标。
2. **ESM 编码** — 对于深度值 0.5 与 depthScale 50：`exp(-min(87, 50 * 0.5)) = exp(-25) ≈ 1.389e-11 ≈ 0`（钳位）。对于深度 0.01：`exp(-0.5) ≈ 0.6065`。
3. **模糊权重归一化** — 所有 33 个权重（26 个双线性 + 7 个依赖）之和应约等于 1.0。
4. **ESM 渲染通道数** — `ShadowTask` 应编码恰好 3 个 ESM 渲染通道；返回值 = `casters.length + 2`。
5. **PCF 渲染通道数** — `ShadowTask` 应对每张脏 PCF 阴影贴图执行恰好 1 个纯深度渲染任务；返回值 = `casters.length`。
6. **纹理尺寸** — 当 `mapSize=1024, blurScale=2` 时，ESM 纹理为 1024²，模糊纹理为 512²。当 `mapSize=512` 时，PCF 深度纹理为 512²。
7. **UBO 尺寸** — 场景：64B，阴影参数：32B，网格：64B，模糊：16B。
8. **ESM 默认配置** — 验证：`mapSize=1024, depthScale=50, bias=0.00005, blurScale=2, darkness=0, frustumEdgeFalloff=0, orthoMinZ=1, orthoMaxZ=10000, forceRefreshEveryFrame=false`。
9. **PCF 默认配置** — 验证：`mapSize=512, bias=0.00005, darkness=0, normalBias=0, near=1, far=10000 or light.range, forceRefreshEveryFrame=false`。
10. **PCF 聚光灯矩阵** — 验证透视投影使用 `light.angle` 作为 FOV、1:1 宽高比以及正确的 near/far。
11. **PCF shadowsInfo 打包** — `[darkness, mapSize, 1/mapSize, 0]`。
12. **投射者脏追踪** — 修改某个网格的 `worldMatrixVersion` 后，`ShadowTask` 检测到任务拥有的投射者输入版本号变化并重新执行材质视图渲染任务。
    12b. **强制刷新** — 当 `forceRefreshEveryFrame=true` 时，即使灯光与投射者世界矩阵版本号未变，`ShadowTask` 仍重新执行 PCF 材质视图渲染任务，以覆盖变形目标及其他 GPU 驱动的形变。
13. **writeShadowUboFields** — 输出 `Float32Array(24)` 匹配预期布局：`[lightMatrix×16, depthValues.x, depthValues.y, 0, 0, shadowsInfo×4]`。
14. **接收者输出稳定性** — 空、仅 ESM、仅 PCF、混合及非连续的 Standard/PBR 槽位列表复现字节完全一致的片段对象，包括绑定顺序与 PBR `AD` → `AS` 重映射。
15. **接收者特性隔离** — 构建后的 Standard/PBR 包装器没有静态回退核心或算法导入；ESM 与 PCF 辅助模块仅包含各自自身的 WGSL 代码生成。
16. **已准备算法守卫** — 仅 ESM 的已准备工厂拒绝 PCF 槽位，仅 PCF 的工厂拒绝 ESM 槽位，而不是静默发射无效的接收者代码。
17. **CSM 优先级** — 包含 CSM 的列表仅将 CSM 灯光索引转发给已注册的接收者工厂，且不准备回退算法。

---

## 文件清单

| 文件 | 职责 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shadow/shadow-base.ts` | 共享阴影数学、方向光矩阵拟合、参数 UBO、接收者 UBO 与 `writeShadowUboFields()` 辅助函数 |
| `src/shadow/thin-instance-shadow-bounds.ts` | 薄实例世界包围盒缓存和方向光拟合适配器 |
| `src/shadow/shadow-generator.ts` | 共享 `ShadowGenerator` 契约 |
| `src/shadow/esm-directional-shadow-generator.ts` | 方向光 ESM 生成器 — 阴影参数 UBO、ESM/深度/模糊纹理、模糊管线、接收者 UBO 与任务资源访问器 |
| `src/shadow/pcf-spotlight-shadow-generator.ts` | 聚光灯 PCF 阴影生成器 — 工厂函数、聚光灯矩阵辅助函数、深度纹理/比较采样器所有权与聚光灯接收者深度值 |
| `src/shadow/pcf-directional-shadow-generator.ts` | 方向光 PCF 阴影生成器 — 工厂函数、深度纹理/比较采样器所有权与方向光接收者深度值 |
| `src/frame-graph/shadow-inputs.ts` | 阴影任务的公共投射网格输入注册 |
| `src/frame-graph/shadow-task.ts` | 内部帧图任务，在接收者渲染前调度阴影并通过 Standard/PBR/Node 阴影材质视图渲染 PCF/ESM 投射者 |
| `src/shadow/pcf-shadow-task-hooks.ts` | 由聚光灯和方向光 PCF 生成器共用的 PCF 预加载/状态/渲染钩子 |
| `src/shader/fragments/shadow-fragment-core.ts` | 面向直接内部调用方的组合同步兼容性入口 |
| `src/shader/fragments/shadow-algorithms.ts` | 所有材质家族共享的算法准备、描述符类型与投影源码 |
| `src/shader/fragments/shadow-fragment-builder.ts` | 算法中立的单遍 Standard/PBR 接收者片段组装器 |
| `src/shader/fragments/shadow-fragment-esm.ts` | 仅限 ESM 的接收者绑定、采样调用与 WGSL 辅助函数 |
| `src/shader/fragments/shadow-fragment-pcf.ts` | 仅限 PCF 的接收者绑定、采样调用与 WGSL 辅助函数 |
| `src/material/node/node-shadow-emitter.ts` | 已准备的 Node Group-1 声明、varying、绑定与阴影因子调度 |
| `src/material/node/node-shadow.ts` | 组合的同步 Node 兼容性入口 |
| `src/material/standard/fragments/std-shadow-fragment.ts` | Standard 接收者准备、CSM 优先级、场景局部缓存与片段 ID |
| `src/material/pbr/fragments/pbr-shadow-fragment.ts` | PBR 接收者准备、CSM 优先级、片段 ID 与 `AD` → `AS` 重映射 |
| `shaders/shadow-blur.vertex.wgsl` | 模糊顶点着色器：全屏三角形生成 + UV 计算 |

聚光灯矩阵辅助函数位于 `shadow/pcf-spotlight-shadow-generator.ts`。
