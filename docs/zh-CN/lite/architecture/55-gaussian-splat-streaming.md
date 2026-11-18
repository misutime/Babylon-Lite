# 模块：WebGPU 原生高斯泼溅流式加载

> 包路径：`packages/babylon-lite/src/loader-splat-stream/`

## 用途

这个可选子系统用于加载空间高斯泼溅（Gaussian-splat）LOD 清单，在第一个共享源文件就绪于 GPU 后立即绘制宽泛的粗糙表示，并在明确的泼溅点数、CPU 内存、GPU 内存、请求数及解码数限制下，将可见叶子区间渐进替换为更精细的替代方案。

初始协议范围刻意保持精简：

- 版本 1 的 `lod-meta.json` 清单；
- 松散 SOG（loose SOG）版本 2 的 `meta.json` 分块；
- 仅限 DC/SH0 颜色；
- 仅限 WebGPU。

加载器拒绝更高阶 SH（`shN`）、打包 `.sog` 归档、SOG v1、未知清单/SOG 版本、不安全相对 URL、无效范围以及格式错误的数据。现有的 `loadSplat`、`loadSOG` 和 `loadSPZ` 行为保持不变。流式路径没有 WebGL 或 CPU 排序回退，也绝不公开暴露 WebGPU 句柄。

清单内部节点是仅含包围盒的层级节点。可渲染表示仅属于叶子节点。每个叶子 LOD 是一个备选的 `(file, offset, count)` 区间。文件按解析后的 URL 进行获取、解码、缓存与淘汰；叶子按区间进行选择与显示。

## 公共 API 接口

所有公共值均为纯数据。行为由独立函数提供。`GaussianSplatStream` 从不引用 `SceneContext`。

```ts
export interface GaussianSplatStreamOptions {
    maxSplats?: number;
    maxCapacitySplats?: number;
    maxGpuBytes?: number;
    maxCpuBytes?: number;
    maxConcurrentRequests?: number;
    maxConcurrentDecodes?: number;
    screenError?: number;
    lodHysteresis?: number;
    lodCooldownMs?: number;
    maxRetries?: number;
    signal?: AbortSignal;
}

export type GaussianSplatStreamPhase = "bootstrap" | "streaming" | "idle" | "budget-limited" | "error" | "disposed";

export interface GaussianSplatStreamStats {
    readonly phase: GaussianSplatStreamPhase;
    readonly visibleLeaves: number;
    readonly coveredLeaves: number;
    readonly targetLeaves: number;
    readonly selectedSplats: number;
    readonly residentFiles: number;
    readonly queuedFiles: number;
    readonly pendingRequests: number;
    readonly residentGpuBytes: number;
    readonly allocatedGpuBytes: number;
    readonly fetchedBytes: number;
    readonly firstFrameMs: number | null;
    readonly error: Error | null;
}

export interface GaussianSplatStream extends SceneNode {
    readonly stats: GaussianSplatStreamStats;
    readonly firstFrameReady: Promise<void>;
    readonly boundMin: readonly [number, number, number];
    readonly boundMax: readonly [number, number, number];
    maxSplats: number;
    screenError: number;
    /** @internal */ /* subsystem-owned mutable state and GPU resources */
}

export function loadGaussianSplatStream(engine: EngineContext, metadataUrl: string, options?: GaussianSplatStreamOptions): Promise<GaussianSplatStream>;

export function attachGaussianSplatStream(scene: SceneContext, stream: GaussianSplatStream): void;

export function disposeGaussianSplatStream(scene: SceneContext, stream: GaussianSplatStream): void;
```

默认值：

| 选项 | 默认值 | 校验 |
| --- | ---: | --- |
| `maxSplats` | 1,000,000 | 大于零的安全整数 |
| `maxCapacitySplats` | maxSplats | 不可变安全整数，至少为 `maxSplats` |
| `maxGpuBytes` | 256 MiB | 大于零的安全整数 |
| `maxCpuBytes` | 64 MiB | 大于零的安全整数 |
| `maxConcurrentRequests` | 6 | 1..32 之间的安全整数 |
| `maxConcurrentDecodes` | 2 | 1..8 之间的安全整数 |
| `screenError` | 2 像素 | 大于零的有限数 |
| `lodHysteresis` | 0.15 | 0..1 之间的有限数 |
| `lodCooldownMs` | 0 毫秒 | 非负有限数 |
| `maxRetries` | 2 | 0..8 之间的安全整数 |

Trogir 流式演示默认使用 0 毫秒冷却时间；误差滞后（hysteresis）在不延迟新需求的情况下稳定细节选择。

加载 Promise 在清单校验完毕且流状态初始化后即兑现，不会等待分块。`attachGaussianSplatStream` 是显式、带幂等保护的，必须在场景注册前或注册期间运行。`firstFrameReady` 仅在非空粗糙间接绘制已提交且 `queue.onSubmittedWorkDone()` 确认完成后才兑现；在引导失败或该绘制前销毁时会拒绝。细化失败会通过 `stats.error` 暴露，而不会拒绝已经兑现的就绪 Promise。

## 协议校验

### 清单

JSON 先按 `unknown` 解析。校验在大型类型化数组或 GPU 分配之前执行。

```ts
interface StreamManifestV1 {
    version: 1;
    asset?: { generator: string; chunkGaussians: number; chunkExtent: number };
    count?: number;
    counts?: number[];
    lodLevels: number;
    filenames: string[];
    environment?: string | null;
    lodErrors?: boolean;
    tree: ManifestBranch | ManifestLeaf;
}

interface ManifestBound {
    min: [number, number, number];
    max: [number, number, number];
}

interface ManifestBranch {
    bound: ManifestBound;
    children: Array<ManifestBranch | ManifestLeaf>;
}

interface ManifestLeaf {
    bound: ManifestBound;
    lods: Record<string, { file: number; offset: number; count: number }>;
    errors?: number[];
}
```

必需的不变量：

- 显式清单 `version` 等于 1；
- 可选的 splat-transform 摘要元数据会进行校验但不影响选择：非空 `asset.generator`、正的 `asset.chunkGaussians`/`asset.chunkExtent`、正的 `count` 以及每个 LOD 对应一个非负安全整数的 `counts`；
- `lodLevels` 是 1..32 之间的安全整数；
- `filenames` 非空且包含安全相对 URL 引用，绝不是 `.sog` 打包归档；
- 每个包围盒包含 6 个有限值且每个轴满足 `min <= max`；
- 树深度最多 64，节点总数最多 1,000,000，遍历检测环与复用对象；
- 每个节点恰好拥有 `children` 或 `lods`；
- 叶子 LOD 键为 `[0, lodLevels)` 范围内的规范十进制整数；
- `file`、`offset`、`count` 以及 `offset + count` 为安全整数；计数 0 为刻意留空，绝不会发起请求；
- 每个保留的叶子至少有一个正数计数的表示；
- 文件引用使用 `new URL(reference, declaringUrl)` 解析，且在运行时仅允许 `http:` 或 `https:`；
- `environment`（若存在）作为独立的松散 SOG 元数据 URL 解析，绝不延迟首个粗糙帧。

仅当 `lodErrors === true` 且其对应误差为有限非负数时，每个正数表示才采用预设误差；否则整个清单使用推导误差。最低的正数原始 LOD 索引是最精细表示；递增的原始索引按变粗顺序访问（包括跨越稀疏缺失索引）。从该最精细正数表示计数 `Nref` 开始，每个更粗糙正数表示的推导误差为：

```text
error[finest] = 0
error[lod] = max(previousError, ln(Nref / count[lod]))
```

表示按计数升序、然后误差升序排序。仅当某表示的误差严格优于所有更廉价的已保留表示时才保留它。即使预设计数非单调，这也能移除被支配（dominated）或同误差的备选项。平局时按原始 LOD 与叶子 ID 稳定排序。

缺失条目和计数为零的条目不消耗误差，也不代表网络失败。缺失层级对应的 `errors` 中的零会被忽略。

### 松散 SOG v2

```ts
interface SogV2Metadata {
    version: 2;
    asset?: { generator: string };
    count: number;
    means: { mins: [number, number, number]; maxs: [number, number, number]; files: [string, string] };
    scales: { codebook: number[]; files: [string] };
    quats: { files: [string] };
    sh0: { codebook: number[]; files: [string] };
    shN?: unknown;
}
```

校验要求：

- `version === 2`，正安全整数 `count`，无 `shN`；
- 可选 `asset.generator` 为非空来源字符串；
- 有限且有序的三分量均值包围盒；
- 缩放与 SH0 码本精确包含 256 个有限条目；
- 精确五个安全相对图像引用；
- 所有解码图像具有相同的正维度；
- 维度与 `width * height * 4` 为安全整数且在 `maxCpuBytes` 下获准；
- 图像容量至少为 `count`，且以 `count + max(width, 4096)` 为上限以拒绝畸形超大源；
- 清单中引用该文件的每个区间均满足 `offset + count <= metadata.count`；
- 图像响应 MIME 为 `image/webp` 或具有 `.webp` URL 路径，且无需缩放即可成功解码。

`createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" })` 保留原始字节。上传使用 `rgba8unorm`、无 mipmap、无 Y 翻转以及 `copyExternalImageToTexture`。位图在 `finally` 中关闭，包括取消、过期代次及部分失败情况。

## 坐标与解码数学

对于泼溅点索引 `i`，图像坐标为 `(i % width, i / width)`（采用整数除法）。第 0 行保持为第 0 行。

对于每个均值轴：

```text
u16 = lowByte + 256 * highByte
t = u16 / 65535
signedLog = min + (max - min) * t
sourcePosition = sign(signedLog) * (exp(abs(signedLog)) - 1)
```

缩放图像的 RGB 字节独立索引同一个标量码本：

```text
scale = exp(scaleCodebook[byte])
```

四元数字节：

```text
a,b,c = (byte / 255 - 0.5) * sqrt(2)
d = sqrt(max(0, 1 - a*a - b*b - c*c))
selector = alphaByte - 252
```

精确的源 XYZW 查找表为：

| 选择器 | XYZW |
| ---: | --- |
| 0 | `(a,b,c,d)` |
| 1 | `(d,b,c,a)` |
| 2 | `(b,d,c,a)` |
| 3 | `(b,c,d,a)` |

超出 0..3 的选择器会使泼溅点失效并产生投影哨兵值。整个元数据范围内的无效选择器比率会在测试中作为错误暴露；运行时不回读计数。

颜色与不透明度：

```text
rgb = 0.5 + 0.28209479177387814 * sh0Codebook[sh0.rgbByte]
opacity = sh0.alphaByte / 255
```

RGB 保持全精度，绝不被钳制到 UNORM。HDR 与负 DC 值均合法。

设四元数矩阵为 `R`，并令 Lite 高斯物理轴矩阵使用解码缩放的两倍：

```text
M = R * diag(2*sx, 2*sy, 2*sz)
Csource = M * transpose(M)
S = diag(1, 1, -1)
centerLite = S * centerSource
Clite = S * Csource * transpose(S)
```

同一个 `S` 通过变换所有八个角点并重新计算最小/最大值来变换叶子/根包围盒。不应用静态加载器的 Y 取反或 X 旋转。

数据集预设的场景摆放与该格式转换保持分离。已发布的 Trogir 查看器为其高斯实体设置了绕 Z 轴 180 度旋转，因此 Trogir 演示在挂载前设置 `stream.rotation.z = Math.PI` 并以相同摆放变换公共包围盒。这个普通场景节点变换同时被 GPU 中心/协方差投影和 CPU 世界包围盒规划所消费。它不是 SOG 解码的一部分，不得替换为屏幕 Y、相机上方向、WebP 行或通用加载器翻转。

## 内部架构

### 不可变清单数据

```ts
interface StreamRepresentation {
    readonly leafId: number;
    readonly lod: number;
    readonly fileId: number;
    readonly offset: number;
    readonly count: number;
    readonly error: number;
}

interface StreamLeaf {
    readonly id: number;
    readonly boundMin: Float32Array;
    readonly boundMax: Float32Array;
    readonly center: Float32Array;
    readonly radius: number;
    readonly alternatives: readonly StreamRepresentation[]; // cheap/coarse to costly/fine
}

interface StreamSource {
    readonly id: number;
    readonly url: string;
    readonly consumers: readonly StreamRepresentation[];
}
```

深度优先遍历分配稳定的叶子 ID。内部树节点仅保留用于 CPU 视锥遍历；它们绝不接收表示。

### 可变文件状态

```text
unrequested -> queued -> fetching-metadata -> fetching-images
             -> decoding -> uploading -> resident
queued/fetching/decoding/uploading -> cancelled
network failure -> retry-wait -> queued
terminal protocol/decode failure -> failed
any nonterminal state -> disposed
resident -> evicting -> unrequested
```

每个文件状态存储代次、尝试次数、需求计数、引导固定（bootstrap pin）、已显示引用、待处理引用、最后使用帧、编码字节数、解码字节数、GPU 字节数、错误、中止控制器以及源纹理/码本缓冲区。仅当流、文件代次和选择需求仍然匹配时，完成结果才会发布。

### 可变叶子状态

```ts
interface StreamLeafState {
    visible: boolean;
    target: StreamRepresentation;
    displayed: StreamRepresentation | null;
    pending: StreamRepresentation | null;
    lastVisibleFrame: number;
    selectionGeneration: number;
    lodCooldownUntil: number;
    cooldownHeld: boolean;
}
```

`target`、`resident`、`displayed` 和 `pending` 相互独立。目标变更绝不会移除 `displayed`。在帧边界处，待处理替换会针对完整的当前已显示前景代次和环境预留进行评估。仅当生成的总量符合容量时，替换才会发布；在同一边界内，降级可以为后续升级腾出空间。任何溢出路径都不会截断区间或丢弃有效的已显示覆盖。一个活动代次中每个叶子最多包含一个区间。

仅当 `setSplatStreamGpuIntervals` 接受了一个将已显示叶子替换为不同表示的代次后，才会从注入的单调时钟为 `lodCooldownUntil` 打上时间戳。`cooldownHeld` 记录当前共享求解是否实际准许了该截止期限的保留；发布与压力分类都会参考该决定，而不是将每个未过期的时钟戳都视为可负担的。初始覆盖不会打上时间戳。首次从粗到细的替换是即时的，并启动第一个截止期限；相同、被拒绝、仅待处理和重新定位目标的工作不会更改该截止期限。零 `lodCooldownMs` 会禁用该策略。

`displayed` 独立于相机可见性记录叶子最近一次成功的回退表示。首次相机选择后，活动范围代次仅包含当前可见的已显示叶子。不可见的历史叶子在另有用途时保留缓存驻留，但不贡献活动区间、不提供已显示保护/引用，也不向间接绘制贡献泼溅点。重新进入该区域可以无需请求直接重新激活保留的回退表示；在不可见且未固定的情况下，淘汰依然合法。

### 流阶段

```text
load/validate -> bootstrap
bootstrap source queued + pipelines compiling
bootstrap source resident -> coarse active generation
coarse draw submitted/completed -> streaming
no queued/pending useful work -> idle
delayed desired LOD waiting for its deadline -> streaming
new camera/budget/residency change -> streaming
unmet refinement waits for protected-aware GPU retirement -> budget-limited
terminal bootstrap/runtime failure -> error
dispose from any phase -> disposed
```

在一次性引导拷贝的 GPU 写入间接参数报告 `instanceCount > 0` 之前，精细细化调度处于禁用状态。如果初始相机未看到被主引导源覆盖的叶子，则会在这个屏障之前请求其可见的最廉价源，以免就绪状态在不可见引导文件上死锁。16 字节 `MAP_READ` 缓冲区在投影后编码，仅在帧提交后映射，并立即销毁且从账本释放。零不透明度、无效选择器、被剔除以及其他仅哨兵的规范输入无法满足就绪条件。稳态下不存在任何回读。管线编译与引导 I/O 重叠执行。就绪之后，未覆盖的叶子会先请求其最廉价源再请求更精细目标，以防不可负担的精细文件阻碍粗糙覆盖。环境仅在粗糙提交之后才入队。从那时起直至驻留或销毁，它持有一个独立于叶子可见性/LOD 需求的持久需求；重复的选择更新无法取消或重复其排队/进行中的请求。

强制的 16 字节引导回读在任何源可获准之前即拥有受保护的账本余量。第一个录制非空引导投影的 Pass 会将该保留转换为回读分配；其他 Pass 绑定无法消费第二个保留。如果无法准许该保留，流创建会在源请求开始前显式失败。销毁会释放未使用的保留，而已录制的回读在映射和销毁完成之前仍保持记账。

在非空粗糙绘制屏障结算之前，所有发布路径均仅限粗糙级别：相机选择可以保留更精细的期望 `target`，但驻留目标暂存、源完成、回退恢复与汇总提交仅可发布每个可见叶子的最廉价表示。这种刻意的引导等待并非代次压力，也绝不会触发冷却时间。屏障结算时，已经驻留的期望目标会立即暂存并提交；随后第一次被接受的从粗到细替换将从该屏障后发布时间开始计算其冷却时间。

## 选择与调度

选择使用通过 `DrawUpdateContext` 传入的实际 Pass 相机、投影、流世界变换及目标尺寸。每个绘制绑定为当前帧和紧邻上一帧保留其自身的可见性、最近包围盒距离及投影半径快照。新快照按叶子以最小相机距离和最大投影半径合并，随后针对流容量运行一次共享的粗糙保底分配。因此总和不会包含各自独立可负担但并集超出容量的相机方案；单相机排序保持不变。取消与缓存保护消费合并后的结果，因此来自一个相机的更新无法取消另一个相机仍需要的延迟工作。初始仅支持透视相机。正交相机会设置可见且可操作的流错误，并保留上一已显示代次。

保守地变换叶子包围盒。对于任意仿射世界变换，变换八个 AABB 角点；半径为距变换后中心的最大距离。视锥测试使用六个规范化的世界空间平面。当前视锥外的包围盒不会收到新的细化请求，但已驻留的源仍可缓存。

CPU 选中的泼溅点数与驻留源文件数是规划/缓存指标，并非 GPU 可见绘制数量。共享文件可能保持驻留，所选范围在单个相机后方剔除后可能包含哨兵记录；仅由每次投影重置的间接实例计数指定的有效已排序前缀才会被光栅化。

对于叶子球半径 `r`、相机到 AABB 最近距离 `d`、目标高度 `h` 以及投影矩阵元素 `p11`：

```text
focalScale = h * abs(p11) / 2
projectedRadius = focalScale * r / max(r + d, near)
errorProxy = projectedRadius * representation.error
```

这是一个以像素为单位的误差加权投影半径代理，而非度量几何误差界限。

规划器从每个可见叶子的最廉价正数表示开始，并在相机、视口、变换或目标变更时从该底线重新计算分配。如果该基线超过 `maxSplats`，选择会显式失败；绝不静默丢弃可见叶子。屏幕误差决定后继表示是否合理。在合理且可负担的后继中，距当前相机最近的叶子包围盒优先升级；距离相同时优先当前投影屏幕误差代理更大者，然后按稳定叶子 ID 排序：

```text
currentErrorProxy = projectedRadiusPx * current.error
```

仅有具有正误差降幅的帕累托链后继才作为候选；泼溅点成本是准入约束，而非效率除数。按距离排序将稀缺细节集中在包含相机及邻近的体积内，而不是把有限预算花在许多廉价的远距离叶子上。当没有可负担升级仍高于阈值、所有叶子均满足 `screenError` 或不再有正降幅时停止。

先前目标不会在求解前预留预算。取而代之，滞后机制对每个候选阈值施加偏置：

- 达到或低于先前目标的步骤使用 `screenError * (1 - lodHysteresis)`，在仍赢得当前距离排序时将已显示细节保留在较低带宽内；
- 超出先前目标的步骤使用 `screenError * (1 + lodHysteresis)`；
- 没有先前目标的步骤以及硬压力下的每一步均使用 `screenError`；
- 任何滞后值（包括 0）都无法在移动相机使另一个可见叶子的屏幕误差恶化时锁定旧区域的分配。

未持有冷却的汇总求解首先确定当前期望细节。在每叶冷却激活期间，第二次共享求解会将该可见叶子固定在其已显示备选项上，并禁止该叶子进一步细化。被固定表示与其他所有可见叶子的粗糙底线作为一个整体准入。如果该完整基线超过有效前景预算，则不应用任何固定并运行常规求解。代次/准入压力、覆盖缺失、源淘汰、可见性移除以及由环境驱动或显式的预算缩减同样会绕过或清除固定。单独的冷却等待绝不是代次压力，也绝不会引起请求/取消循环。驻留完成与回退发布都经过同一策略，因此异步到达无法替换被固定的可见 LOD。过期截止期限在常规更新期间从单调时钟检测，无需浏览器定时器即可使汇总缓存失效；被延迟的期望工作使阶段保持为 `streaming` 直至重新评估。销毁会清除所有待处理冷却状态。

逐绑定几何指标仅在数值输入逐字节完全相同时缓存：拷贝后的视图投影与世界矩阵内容、相机位置、投影缩放与近平面、有效目标尺寸、透视模式、容量、屏幕误差及滞后。公共选项校验仍在缓存命中前运行。可变数组按内容而非引用标识比较。仅当有序绑定计划标识、有效限额、策略设置、压力/准入状态、源/发布代次以及冷却过期代次均未变更时，才复用共享汇总结果。源到达或淘汰、引导释放、环境限额变更、已接受发布、压力变更、缓存准入变更、绑定增减及冷却过期均会使对应缓存失效。退役、完成处理、重试、源调度、保护和统计在缓存命中帧上仍继续执行。

文件请求优先级为：

1. 主引导源；
2. 尚无已显示表示的可见未覆盖叶子；
3. 按最近请求叶子距离排序的可见升级，按文件去重；
4. 环境；
5. 仅当所有更高优先级类别均获准时，可选的邻近预取。

引导源选择按文件聚合每个叶子的最廉价表示，依次选择叶子覆盖最多、泼溅总数最少、稳定文件 ID 最小者。这无需文件名或索引特例即可选中 Trogir 的 `6_0/meta.json`。它将在流生命周期内固定。未被它覆盖的稀疏叶子不会延迟首帧；越过屏障后，它们的最廉价源属于第 2 类。

## 传输、CPU 准入与重试

优先级队列以文件 URL 和代次为键。每个 URL 最多存在一个文件预准备任务。来自多个叶子的需求会增加共享所有权，绝不重复获取/解码/上传。

`maxConcurrentRequests` 同时限制并发源预准备数量以及全局 HTTP 响应信号量。`maxConcurrentDecodes` 单独限制活跃的 `createImageBitmap` 调用数。每个并发预准备在获取元数据前获得固定准入限额 `floor(maxCpuBytes / maxConcurrentRequests)`。实际编码和解码字节仍记入全局账本。每个源按顺序获取并解码其图像，同时其他源独立推进。限额总和不会超过 CPU 预算，从而防止保留负载之间出现循环等待。

峰值超过其共享限额的预准备会释放其资源，并重新入队一次以争取独占完整 CPU 预算的准入。位于优先级队列头部的独占作业会等待活跃预准备排空，并阻止低排名作业启动。合法的大源仍能访问完整预算。超过完整预算则属于终止错误。准入重试保留原始优先级与 FIFO 序号；销毁、取消和代次替换绝不重启作业。

当活跃槽位已满或独占预准备阻塞准入时，排队的严格更高优先级工作会协作式抢占较低优先级的活跃预准备。每次调度传递在评估剩余队列的抢占前先填满可用槽位，因此一次被抢占尝试的清理可以准入紧急工作并回收下一个所需槽位，而无需等待需求变化或另一请求完成。需求从细化升级为未覆盖覆盖的源会在原地提升其现有的同代次调度作业：Promise、代次、FIFO 序号、请求所有权及预准备处理器均保持不变。同一优先级类别内，源按最近请求叶子距离、然后按 FIFO 序号排序。相机距离变更与排队取消共享每次同步批次一次的延迟调度传递。直接或通过其信号取消排队的独占作业，可使符合条件的工作在下一个微任务使用空闲槽位，而无需等待活跃预准备完成。同级更新绝不中止活跃工作。严格优先级提升会立即调度。任何立即调度传递都会消耗待处理更新并抑制多余的延迟传递。运行时提供的预准备钩子保留其自身所有权，绝不会仅仅为了提升优先级而再次调用。

抢占会立即中止可中断的元数据/图像传输。不假设 `createImageBitmap` 可中止：抢占在活跃解码期间锁存，仅当该解码实际结算后才变更所有者，关闭其迟到的位图并释放所有计数器和预留。低优先级尝试的 `finally` 清理会在同一未决作业以其原始 FIFO 序号重新入队之前，释放每个响应体、位图、CPU 预留和预准备槽位。外部中止、代次替换、销毁、重试耗尽以及终止错误绝不重新入队。同等优先级不能抢占。这让新近可见的粗糙覆盖能在停滞的可中止精细传输之前取得有界进展，同时保留整体预准备峰值记账与唯一所有权；不可中止的平台解码停滞仍是不可避免的安全边界限制。

当存在 `Content-Length` 时，将其解析为规范安全整数并在获取响应体读取器前完成预留。声明超出预算的响应体会在不进行应用侧缓冲的情况下被拒绝。未知长度的响应体从 `ReadableStream` 分块读取；每个保留块在保留前先准入。传输层绝不会对未记账的完整响应体调用 `response.blob()`。

对于 WebP 图像，在不改变编码负载的情况下检查有界的 RIFF/VP8X、VP8L 或 VP8 帧头。当第一个编码体仍处于记账状态时，在首次 `createImageBitmap` 调用前预留已校验的 `width * height * 4 * imageCount` 解码容量。后续每个编码体除该完整解码保留外还会额外准入，并在其解码结算前保持记账。这计入了所有保留的先前位图、当前编码 `Blob` 以及解码可能在同一瞬间创建的位图分配。竞争的预准备可以彼此等待预留，但自身保留解码容量加上下一个响应体就已超过 `maxCpuBytes` 的预准备会立即拒绝，而不是自我死锁。后续图像头必须在解码前匹配。CPU 准入等待者在中止时立即拒绝。编码与解码预留在成功、取消、过期代次及失败路径下的 `finally` 中独立释放。

CPU 记账包括 JSON/编码响应字节、解码位图容量（每张位图 `width * height * 4`）、排队上传负载以及临时校验缓冲区。预留在 `finally` 中释放。

初始清单与所有源元数据/图像应用相同策略：瞬态状态 408、425、429 和 5xx 以及网络失败最多重试 `maxRetries` 次，采用感知中止的延迟：

```text
delayMs = min(2000, 125 * 2^attempt) + deterministicJitter(fileId, attempt, 0..63)
```

协议、JSON、图像解码、不支持格式、不安全 URL、除上述状态外的 4xx 以及永远无法装入显式限制的 CPU 负载均为终止错误。取消不算作失败尝试。暂时无法预留 GPU 字节的有效细化源并非源失败：释放解码/编码 CPU 预留，其需求变为 `budget-limited`，已显示的回退保持激活。被阻塞的请求会记录其所需字节数，仅当释放了字节、源保护资格发生变化足以回收缺口，或需求离开后重新进入时才重试；仅分配增长绝不会触发重试，未变更帧绝不会再次获取/解码。预留回调与其匹配账本构成单一依赖契约，确保每次成功预留都有有效清理路径。终止性细化失败会记录错误并保留回退显示。终止性引导失败会进入 `error` 状态并拒绝 `firstFrameReady`。

## 源缓存与 GPU 内存

每个驻留源拥有：

- 五张 `rgba8unorm` 纹理；
- 一个 2,048 字节的元数据/码本存储缓冲区：256 个缩放 `f32` 加上 256 个 SH0 `f32`；
- 维度、计数、已校验区间、代次、固定/引用计数以及最后使用帧。

源纹理字节数为 `5 * width * height * 4`。GPU 记账使用单个流级全局账本，包含活动规范图集、投影记录、两个键/索引数组、两个间接缓冲区、基数直方图/扫描、uniform、源元数据、待处理替换代次以及排队等待退役的资源。`residentGpuBytes` 是当前有用且已分配缓冲区/纹理的精确字节总和；`allocatedGpuBytes` 额外保留等待退役的字节，直至其栅栏销毁器运行。准入保留（占用预算但尚未分配）不计为已分配字节。在创建源纹理之前，全局账本准入在计入已排队退役的源字节后计算字节缺口，仅选择足够使该预留在退役后成立的额外未受保护最远优先源受害者，并使它们退役。在提交栅栏销毁器运行前，它们的已分配字节仍保持记账，因此尝试会等待，而不是在先前的受害者仍在退役时淘汰额外的源。源上传预留一次并将该预留转移给缓存；缓存准入绝不会再次授予它。

规范容量受设备限制约束，并且对于一个规范代次加上一个 Pass 局部工作代次，上限为 `maxGpuBytes` 的 75%，为源保留余量。`maxCapacitySplats` 将该不可变分配上限与可变的 `maxSplats` 选择目标分开。环境驻留会从当前前景规划限额中扣除，但不会使未变更的合法 `maxSplats` 值失效；仅将 `maxSplats` 修改为高于不可变容量才是错误。如果设备限制或工作预算无法精确准入所请求的容量，加载会携带请求容量与准入容量显式失败，而非静默钳制并在稍后显示时失败。精确的首个 Pass 局部配额在源请求能消耗其预算前先行保留，随后在构建绑定时转为已分配字节。额外的目标绑定需要独立准入。每个清单叶子对应的一个 256 字节收集描述符加上可选环境描述符在任何源请求之前受到保护。若无法预留该初始保留，刚创建的规范状态会退役，并在加载拒绝前释放所有账本记账。录制仅将所需的受保护保留转换为已分配且统计可见的提交局部缓冲区；退役会原子性地恢复该保留，因此源准入无法在代次之间窃取该余量。当较早的收集描述符提交仍在执行中时，变更的代次会保持先前显示完整并等待。替换采用先建后断（make-before-break），旧代次在 `retireGpuResources` 运行前保持记账。

淘汰仅考虑零已显示引用、零待处理引用、零活动区间引用且无引导固定的驻留源。内存压力下，合格源按到最近活跃相机的距离降序排列，其次为最久未使用、最大 GPU 分配及 URL。源距离是所有使用该文件的叶子（包括屏幕外叶子和共享文件）到相机的世界 AABB 最小距离。每个绑定保留其最新相机位置快照；超过现有单帧宽限期的绑定不影响淘汰。仅当准入需要受害者时，才使用当前流世界变换对每个候选评估一次距离，而不是在未变更帧上重扫包围盒。在没有活跃相机或叶子包围盒时，无限距离回退到最近使用排序。活动描述符（包括环境区间、待处理替换及已提交代次）保护对应资源。当叶子可见性/引用或已发布区间代次变化时，流会增量维护逐源的已显示、待处理与活动计数。脏代次在一次源遍历中将这些计数应用到驻留缓存条目；未变更帧不重扫叶子层级或驻留区间列表。仅活动源会收到廉价的逐帧最近使用更新。因此仅当源参与活动区间代次时，`lastUsedFrame` 才推进；仅保持热缓存不会刷新它。

淘汰会在退役前同步移除缓存条目并清除其源运行时以及所有匹配的已显示和待处理叶子引用，因此陈旧描述符绝不会错误满足目标相等性或覆盖检查。如果该叶子再次变得可见，会立即显示不高于其目标的最佳已驻留备选项，同时再次请求未变更的目标源。主引导回退保持固定。稀疏叶子回退区间在后续替换显示后可拷贝到规范活动存储中，而无需继续固定其整个其余部分未使用的庞大源。

可选环境存储显式的源状态标识。当其解析后的 URL 与某个叶子源别名相同时，它复用完全相同的运行时、请求、解码纹理、缓存条目及 GPU 分配；绝不会创建重复源。环境需求在粗糙屏障后添加一个持久所有者，前景限额仅扣除一次共享源计数，发布则从同一源标识追加环境区间。叶子显示与环境使用可针对同一个缓存条目共存，淘汰/重载/销毁会遵守它们的组合保护。非别名环境获得一个具有相同生命周期规则的专用源状态。

当发生临时细化压力时，准入选择失败或推迟，而不是淘汰唯一已显示的表示。它保留当前覆盖并报告 `budget-limited`（且 `stats.error === null`）；移动的需求可使较旧源具备淘汰资格，其退役栅栏完成后会恢复被阻塞的需求。无法装入引导源加最小工作缓冲区的显式用户限制会在加载时以预算错误拒绝。

## GPU 缓冲区布局

所有字段均采用 WebGPU 存储缓冲区对齐。

### 规范泼溅点，64 字节

```wgsl
struct CanonicalSplat {
    centerOpacity: vec4<f32>, // 0: Lite center xyz, opacity
    covarianceA: vec4<f32>,  // 16: c00, c01, c02, c11
    covarianceB: vec4<f32>,  // 32: c12, c22, 0, 0
    color: vec4<f32>,        // 48: linear DC rgb, reserved
}
```

### 活动范围描述符，32 字节

```wgsl
struct ActiveRange {
    sourceOffset: u32,
    count: u32,
    destinationOffset: u32,
    leafId: u32,
    fileGeneration: u32,
    lod: u32,
    _pad0: u32,
    _pad1: u32,
}
```

描述符按稳定叶子 ID 排序。环境（当驻留时）以叶子 ID `0xffffffff` 追加一次。

### 投影泼溅点，64 字节

```wgsl
struct ProjectedSplat {
    clipCenter: vec4<f32>, // clip xyzw
    axis0: vec4<f32>,      // clip-space xy offset at unit corner; zw reserved
    axis1: vec4<f32>,
    color: vec4<f32>,      // rgb and opacity
}
```

投影将每个存活记录写入其确定性的活动输入索引处。被剔除的记录及其稀疏键槽位保持未指定，并获得有效性 0。

### 排序与间接记录

```wgsl
struct KeyIndex { key: u32, index: u32 } // 8 bytes
struct DrawIndirectArgs {
    vertexCount: u32,   // always 6
    instanceCount: u32, // GPU survivor count
    firstVertex: u32,   // 0
    firstInstance: u32, // 0
}
```

投影在每个活动规范索引处写入一个有效性标志和一个稀疏 `(key, canonicalIndex)` 对。有效正视图深度使用 `~bitcast<u32>(depth)`，使升序无符号顺序对应从远到近。无效投影写入标志 0，无需初始化其稀疏对。64 字节的投影缓存仍按规范 ID 索引；从不对其进行物理压缩，因此在 400 万容量下不需要第二个 256 MiB 缓存。

投影之后，稳定的 GPU 压缩按原始规范顺序扫描有效性标志，并将存活的键/索引对分散写入稠密前缀。该扫描是一个分层的 256 通道独占 Blelloch 扫描：第 0 层扫描标志，每个更高层扫描前一层的块和，反向加法 Pass 传播父偏移。位于规范索引 `i` 的存活者写入 `exclusivePrefix[i]`，因此排序前顺序严格按工作组间规范索引升序排列。相等的深度键因而保留与先前全池稳定基数排序相同的确定性原始 ID 平局顺序。压缩从不重写投影记录；稠密对继续引用其原始投影/规范 ID。

一个固定的单调用设置读取紧凑扫描的根总计并写入：

```text
runtime[0] = survivorCount
drawIndirect = { vertexCount: 6, instanceCount: survivorCount, firstVertex: 0, firstInstance: 0 }
dispatch[0] = { x: ceil(survivorCount / 256), y: 1, z: 1 } // histogram and scatter
dispatch[1 + level] = { x: max(1, ceil(levelItemCount / 256)), y: 16, z: 1 } // radix scans
dispatch[1 + levelCount + childLevel] = { x: ceil(childCount / 256), y: 16, z: 1 } // radix adds
```

`levelCount` 从 `ceil(survivorCount / 256)` 开始，并递归应用 `ceil(n / 256)`。扫描派发至少使用一个工作组，使零存活者将每个根总计覆写为零；当 GPU 推导计数为零时，直方图、加法与分散派发均派发零工作。运行时/派发缓冲区具有 `STORAGE | INDIRECT | COPY_SRC | COPY_DST` 用途且为 Pass 局部；`COPY_DST` 允许显式的投影前重置，使空活动池无法复用上一帧计数。生产环境绝不映射或读取存活者计数。

压缩为每个已准入 Pass 容量精确增加两个 `u32` 数组：一个有效性标志数组和一个独占前缀数组，即每容量条目 8 字节（在演示的 4,010,000 泼溅容量下为 32,080,000 字节）。一个 128 字节的存活者/派发缓冲区及一个 64 字节的非别名绑定占位符构成了新增的固定分配。分层压缩扫描在直方图覆写之前复用基数暂存区。全部 32,080,192 字节均参与初始 Pass 保留、分配准入、部分失败回滚以及带栅栏退役。独立的强制 16 字节引导回读保留也在源驻留前准入；现有的 1 GiB 演示账本仍然准入不变的 4,010,000 容量及可变的 4,000,000 启动目标。

## 计算管线

### 收集（Gather）

每个活动源/范围组执行一次派发，读取五张源纹理和码本并写入规范记录。256 线程工作组每调用处理一个泼溅点。派发数量受限并在设备限制需要时拆分。仅当已显示选择/驻留代次变更时才运行收集。

收集参数在每次已录制派发中使用独立的 256 字节动态 uniform 槽位。严禁在已编码派发之间覆写同一个 uniform 位置。

着色器应用上文精确的 SOG 解码、协方差及手性数学。无效四元数选择器或非有限结果写入零不透明度；投影随后会输出有效性 0。

### 投影、椭圆、剔除与键

当以下任一代次变更时运行投影：规范内容、相机视图、投影、流世界矩阵、目标宽度或目标高度。

对每个规范泼溅点：

1. 通过流世界矩阵与当前视图矩阵变换中心和协方差；
2. 拒绝非有限值、不透明度 `<= 0`、视图深度 `<= near` 或零裁剪 `w`；在 Lite 左手视图空间中，眼睛后方的泼溅点具有非正深度，无论椭圆多大都不能增加间接计数；
3. 在评估透视雅可比矩阵前，应用现有的 Lite 高斯投影域守卫：以 `bounds = 1.2 * clip.w`，拒绝裁剪 X 或 Y 落在 `[-bounds, bounds]` 之外的中心。这可在近眼远偏轴中心的一阶协方差近似产生覆盖全屏的椭圆前将其拒绝；
4. 从实际投影与视口推导透视雅可比矩阵；
5. 计算 2D 协方差并向两个对角项加上 `0.3`；
6. 稳健求解对称 2x2 特征值问题：

```text
trace = a + c
disc = sqrt(max(0, (a-c)^2 + 4*b^2))
lambda0 = max(0.1, (trace + disc) / 2)
lambda1 = max(0.1, (trace - disc) / 2)
```

当 `abs(b) + abs(lambda0-a) > epsilon` 时，归一化 `(b, lambda0-a)`；否则当 `a >= c` 时取 `(1,0)`，否则取 `(0,1)`。垂线为 `(-y,x)`。

椭圆轴独立对长轴和短轴使用 `min(sqrt(2 * lambda), 1024)` 像素，匹配 Lite 现有的饱和约定。它们按 `pixelAxis * clip.w / viewport` 转换为裁剪偏移；视口归一化没有额外的因子 2。在保守的屏幕外剔除包含其组合范围前，两个裁剪轴必须均保持有限。中心域守卫与轴饱和是已确立 Lite 高斯投影的参考等价限制，而非特定数据集的解码器或协方差更改。

7. 将投影记录写入活动索引处；
8. 在同一稀疏索引处写入 `(depthKey, activeIndex)` 与有效性 1。

随后的投影后压缩生成稠密存活键前缀及 GPU 存活者计数。投影仍然评估每个活动规范记录，不改变可见性、不透明度、裁剪、协方差或深度键数学。

光栅化核保持 Lite 兼容：生成的广告牌角点跨越 `[-2,2]`；片元 alpha 为 `exp(-dot(corner,corner)) * opacity`；半径 2 之外的片元被丢弃。协方差因子、0.3 核、`sqrt(2*lambda)` 轴、角点范围与指数构成单一约定，不得与其他引擎的焦距/核归一化混用。

### 可移植的稳定 32 位基数排序

排序仅消费压缩后的存活前缀。没有无效哨兵进入基数输入，也没有早先更大帧留下的陈旧后缀能影响直方图总计、分散目标或绘制顺序。

每趟 4 位、16 个数字、8 趟最低有效数字、每工作组 256 项：

1. **直方图：** 每个间接派发的存活组写入 16 个数字计数。仅允许对计数使用工作组原子操作。
2. **分层扫描：** 在工作组内存中使用 Blelloch 上扫/下扫以 256 元素块独占扫描每个数字的组计数。递归扫描块和直至仅剩一个块，然后在下行路径加上已扫描的块基址。非 2 的幂次尾部加载零。对数字总计执行 16 元素扫描提供全局数字基址。在每一层级，数字行均使用分配容量步长，而非活动计数步长。运行时大小的块和逐数字拷贝到下一层的容量步长行中。数字基址 Pass 在 `digit * root.blocks` 处读取每个根总计，其中即使活动层级折叠到第 0 层，`root.blocks` 也是所选层级的分配容量和行步长。当容量远超当前活动计数时（无论活动扫描使用一层还是多层），这都是必需的。
3. **稳定分散：** 工作组内存包含 16 个数字行，每行 8 个 `atomic<u32>` 字（512 字节）。所有 256 个通道统一清零这些字并同步，随后每个有效通道原子地将其唯一通道位按位或入其数字行。第二次屏障后，有效通道通过对最多 7 个前置字加上当前字在其通道位以下的掩码执行 `countOneBits` 计算其稳定排名。无效尾部通道参与两次屏障后直接返回。写入位置为：

```text
digitBase[digit] + scannedGroupCount[group,digit] + localStableRank
```

这种有界的 8 次 popcount 局部操作取代了整组二次方的 32,640 次前驱比较，同时避免了非确定性原子分散、子组假设、工作组间自旋等待以及单线程全局扫描。第 31 位掩码使用无符号移位且不会溢出通道掩码。乒乓缓冲区在每趟交替。全部 8 趟 4 位排序保持完整，因此任意 32 位键均保留稳定的压缩规范 ID 平局顺序和不变的排序语义。

每趟在独立的 256 字节 uniform 偏移处拥有一个不可变参数记录。直方图、每个层级扫描、每个反向加法以及分散均使用带 GPU 产生存活者计数的 `dispatchWorkgroupsIndirect`；仅对已知活动投影池的压缩、单调用运行时设置以及 16 通道数字基址 Pass 使用直接派发。直方图与扫描缓冲区大小由准入容量推导，并针对设备派发和存储限制进行校验。零、单元素、部分、非 256 倍数以及全存活计数走同一条路径。零存活者重置绘制参数和扫描根，而可见到零再到可见的转换不会复用陈旧行或陈旧间接维度。

## 渲染管线配置

流式特性拥有自己的 WGSL、布局、管线缓存、绑定组及更新批次。通用引擎/渲染/场景代码不包含任何流式专属分支。

- 场景绑定组：group 0；
- 流投影/排序/间接资源：group 1；
- 拓扑：`triangle-list`；
- 生成的非索引顶点：每实例 6 个，无四边形缓冲区；
- 为所有前景叶子和环境执行一次 `drawIndirect(indirectBuffer, 0)`；
- 颜色混合：与现有高斯渲染匹配的常规有序 alpha 混合；
- 深度比较：目标现有的反向 Z 约定；
- 深度写入：禁用；
- 剔除模式：none；
- 多重采样计数与目标格式：目标签名；
- 渲染顺序：现有的透明高斯顺序。

顶点索引映射到角点：

```text
0=(-2,-2), 1=(2,-2), 2=(2,2), 3=(-2,-2), 4=(2,2), 5=(-2,2)
```

实例索引读取已排序索引，随后读取投影记录，并将 `axis0 * corner.x + axis1 * corner.y` 加到裁剪中心。

## 绘制批次集成

每个目标专属的 `DrawBinding.update(context)` 消费 `context._camera`、`context.targetWidth` 和 `context.targetHeight`。它对实际的视图、投影、世界矩阵、视口及内容代次做哈希，绝不闭包捕获 `scene.camera` 或引擎主目标。

绑定通过 `_updateBatches` 暴露一个特性自有的 `DrawUpdateBatch`。目标构建调用 `enableDrawBatchCollection(signature)`。一个惰性弱缓存仅针对相同的流 GPU 状态和相同的 `RenderTargetSignature` 对象复用未退役的流式批次。因此调整大小后重建单个渲染任务会在旧绑定代次与候选绑定代次之间共享其 Pass 局部投影/基数代次，而不同的任务/签名对象即使格式匹配也保持隔离。候选回滚与已提交退役继续通过现有的保留批次状态协议执行。渲染器现有排序保持不变：

```text
batch.reset()
binding.update(actual pass context) queues requested work
batch.flush(engine) encodes upload/gather/project/radix work on engine._currentEncoder
render pass begins
one indirect draw
```

批次绝不保留、结束或单独提交活动编码器。不同的相机/目标绑定拥有各自的投影缓存、有效性/前缀缓冲区、压缩/基数暂存区、存活者/运行时派发参数和绘制参数，因此一个 Pass 无法覆写另一个 Pass 的待处理记录。收集参数是不可变的提交局部映射缓冲区，按最多 4,096 条动态偏移记录分块并在引用提交完成后退役；录制另一个 Pass 或编码器无法重写较早派发的快照，且超过 4,096 的合法活动区间数量仍受支持。共享源纹理与规范内容仍归流所有。每个新增的 Pass 局部缓冲区均纳入准入记账，在部分分配失败时销毁，并随所属 Pass 精确退役一次。

发布是针对汇总显示的单一事务。每个 GPU 就绪的缩减都在没有中间逐叶适配门控的情况下暂存，并在检查容量前应用到暂存计数，即使没有单次缩减能使已经超容量的中间状态降到限制以下。仅当完整缩减后的代次符合容量时，才准许负担得起的升级。逻辑已显示描述符仅针对已准入集合变更。被容量拒绝的驻留精细目标会从待处理缓存保护中移除，即使已显示了粗糙表示。对于未覆盖的叶子，回退搜索遍历每个依次更廉价的驻留备选项，并发布第一个在已提交缩减后能装入实际总量的表示；驻留但仍不可负担的中间回退无法遮蔽更廉价的合法表示。最终准入 Pass 之后，所有未发布的被容量拒绝升级都会失去待处理保护。当缺失的降级前置条件正在加载时，活动规范源保持受保护。未满足的驻留汇总目标会独立于待处理缓存保护设置持久的代次压力，报告为 `budget-limited`，直到目标发布或相机需求撤回，即使当前显示本身低于容量也是如此。

资源代次采用先建后断（make-before-break）。一旦没有任何保留的绑定/批次引用旧代次，即通过 `retireGpuResources(engine, disposer)` 调度销毁。销毁是幂等的，每个 GPU 句柄精确销毁一次。

## 生命周期与错误策略

挂载（Attach）在不让 `addToScene`、场景核心、渲染任务或引擎感知流式加载的前提下注册延迟场景可渲染对象与场景销毁清理。流节点的普通 TRS/父节点状态参与世界变换。显式流销毁会注销其场景回调；场景驱动的销毁会标记挂载已销毁而不会在 `_disposables` 实时迭代中对其进行 splice，从而确保相邻流与应用回调各运行一次。

销毁流程：

1. 在挂载时立即注册场景生命周期清理，随后在销毁时将阶段标记为 `disposed` 并递增流/文件代次；
2. 中止排队/获取中的工作并清除重试定时器；
3. 关闭保留位图并释放 CPU 预留；
4. 分离/停用可渲染对象和批次；
5. 拒绝未决的 `firstFrameReady`；
6. 退役已提交的 GPU 资源并直接销毁从未提交的资源；
7. 移除场景销毁注册；
8. 重复调用安全。

错误为带有稳定子系统前缀和 URL/上下文的 `Error` 对象。没有任何畸形输入会作为空流兑现。细化错误保留已显示代次。由可变公共输入（`maxSplats`、`screenError`）引起的选型校验失败归流所有且可恢复：显示保持完整，随后的合法输入仅清除该精确的瞬态错误（即使复用了精确输入规划器缓存），并重新计算阶段。真正的源/引导失败绝不会被成功的选择所掩盖。

在 `firstFrameReady` 结算之前，不支持的投影模式或内部选择/更新失败属于终止错误：阶段变为 `error`，就绪 Promise 以可操作原因精确拒绝一次，排队/请求的源工作通过常规销毁所有权取消，且迟到的源/GPU 回调无法重新启用引导。每个异步粗糙信号延续（包括在其内部执行的同步发布或队列栅栏设置）都将失败路由到同一终止路径。就绪之后，同样的不支持可变相机输入仍属于可恢复的可见选择错误，保留当前显示。引导源/解码失败及 GPU 空粗糙投影仍属于终止错误。

选择错误仅拥有其自己发布的错误对象。它们不会替换现有的源/引导错误，且合法的可变输入仅在该同一对象仍为当前错误时才清除选择错误。当瞬态选择错误可见时到达的源错误会替换它，并在随后合法选择后依然保持当前状态。可变 `maxSplats` 失败（包括预算低于当前可见粗糙基线）属于范围错误，在首帧就绪前仍可恢复；修正预算可使粗糙绘制与就绪栅栏继续进行。不支持的投影模式与内部规划器失败在就绪前仍属于终止错误。运行时错误会更新 `stats.phase` 与 `stats.error`，并使用仓库标准的警告/错误诊断。

## Trogir 演示

### 碰撞导航

`packages/babylon-lite/src/collision/splat-voxel-collision.ts` 通过包根提供可选的碰撞查询：

```typescript
interface SplatVoxelCollision {
    readonly min: [number, number, number];
    readonly max: [number, number, number];
    readonly resolution: number;
    readonly depth: number;
    readonly nodes: Uint32Array;
    readonly masks: Uint32Array;
}
function parseSplatVoxelCollision(metadata: unknown, buffer: ArrayBuffer): SplatVoxelCollision;
function loadSplatVoxelCollision(metadataUrl: string, signal?: AbortSignal): Promise<SplatVoxelCollision>;
function moveSplatVoxelCamera(collision: SplatVoxelCollision, from: [number, number, number], to: [number, number, number], radius?: number): [number, number, number];
```

加载器接受 HTTP(S) `.voxel.json` URL，并通过替换路径名后缀并保留查询参数来推导其同级 `.voxel.bin`。元数据上限为 64 KiB，解码后的二进制上限为 128 MiB。解析仅接受体素格式 1.1：有限递增网格边界、正分辨率、四体素叶子、深度 1..20 以及精确的小端节点/掩码计数。在导航前检查每个子范围、混合叶子索引、深度与唯一父节点。字 `0xff000000` 表示实心；零高字节索引一对 32 位占用掩码；其他字编码 8 位子掩码和 24 位首子索引。子序为 X/Y/Z Morton 序；混合掩码位使用 `x + 4*y + 16*z`。查询使用数据集坐标系、要求净空起点、阻挡网格边界，并提供无重力的沿墙滑动。该模块无渲染器或 GPU 依赖，导出未使用时会被移除。

体素网格已处于原始查看器的世界坐标系中。Trogir 碰撞查询仅使用 `(x,y,-z)` 转换 Lite 世界位置。相机移动使用线段/板片求交将半长 0.15 单位的包围盒扫过占用的八叉树体积，随后移除受阻法向分量并重复最多三次滑动接触。较小的接触偏移可防止重复边界相交。网格外移动被阻挡。连续扫描即使在长帧下也能防止隧穿；不从部分加载的泼溅点推断几何体。

碰撞获取与场景初始化并行启动。控件在碰撞数据就绪前保持未挂载；导航加载期间粗糙场景即可显示。失败会使导航保持禁用并显示明确的 HUD 错误。页面销毁会中止碰撞请求并阻止迟到的控件挂载。默认清单与体素对托管于 `https://assets.babylonjs.com/splats/Trogir/`。所有资源根都使用同级体素文件，并为两个体素请求保留其查询参数。非空 `?collisionUrl=` 选择带有自身查询参数的独立 HTTP(S) 体素元数据 URL；空覆写则使用资源根默认值。数据集 URL 与 Trogir 坐标适配器保留在演示代码中。碰撞修正运行在自由相机输入之后、渲染之前，同时平移位置与目标并在分离时移除其回调。

文件：

- `lab/lite/demo-trogir-streaming.html`；
- `lab/lite/src/demos/trogir-streaming.ts`；
- `demos-config.json`；
- `lab/vite.config.ts`。

当设置了 `GS_STREAM_ASSET_ROOT` 时，Vite 插件仅将配置的数据集根目录挂载到 `/local-gs/trogir/`。它：

- 仅接受 GET/HEAD；
- 安全解码相对 URL；
- 拒绝 NUL、反斜杠、绝对路径以及 `..` 片段；
- 使用 `realpath` 规范化配置的根目录和请求的文件；
- 校验 `relative(realRoot, realFile)` 不发生逃逸；
- 要求是常规文件；
- 流式传输而非缓冲响应；
- 将 `.json` 作为 `application/json`、`.webp` 作为 `image/webp`，其他支持的二进制文件作为 `application/octet-stream` 提供；
- 返回有用的 404/405 错误和 `Cache-Control: no-cache`；
- 绝不向客户端代码暴露宿主机路径。

客户端元数据 URL 优先级：

1. 相对于 `location.href` 解析的 `?assetRoot=<dataset-root-or-full-lod-meta.json-url>`；
2. Babylon 托管的公共源清单 `https://assets.babylonjs.com/splats/Trogir/lod-meta.json`。

公共源无需本地配置。要显式选择可选的本地挂载：

```text
GS_STREAM_ASSET_ROOT="<dataset-directory>" pnpm --dir lab dev
http://localhost:5174/demo-trogir-streaming.html?assetRoot=/local-gs/trogir/
```

以 `/lod-meta.json` 结尾的 `assetRoot` 直接用作清单 URL；其他值保持目录根行为并追加 `lod-meta.json`。如果无法加载所选源，页面会报告错误并同时显示本地配置与托管覆写表单，而不是挂起。

根查询参数保留仅涵盖清单和演示的同级体素对。流分块元数据与 WebP 引用使用常规相对 URL 解析：它们保留各自的查询字符串，不继承声明文档的查询参数。私有数据集必须独立授权每个相对资源引用（或使用适当的宿主鉴权）；仅带签名的 `assetRoot` 不会授权整个数据集。体素宿主必须对体素对的双方接受相同的查询参数。

该演示提供画质、细节误差和泼溅预算控件、第一人称鼠标/键盘控件，以及用于阶段、首帧时间、已选泼溅数、可见/已覆盖叶子、驻留/已分配 GPU 字节、驻留文件和待处理请求的非阻塞 HUD。其视口允许浏览器缩放，且减弱动态效果偏好会禁用加载旋转动画。画质在设备创建前由 `?quality=low|high` 选择；缺失或未知值选择低内存档。更改画质选择器会重载页面并保留资源覆写，从而重新创建不可变分配。泼溅预算滑块初始化并封顶于该档位的前景目标；单独拖动它不会缩小固定缓冲区。

| 档位 | 前景泼溅数 | 不可变容量 | GPU 账本 | CPU 准入 | 所需缓冲区大小 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 低内存（默认） | 1,000,000 | 1,010,000 | 256 MiB | 64 MiB | 64,640,000 字节 |
| 高细节 | 4,000,000 | 4,010,000 | 1 GiB | 192 MiB | 256,640,000 字节 |

每个档位为 9,237 个泼溅点的环境预留 10,000 个槽位，并为 `maxBufferSize` 和 `maxStorageBufferBindingSize` 请求其缓冲区大小。固定流/Pass 存储占用在低内存档约 147 MiB，在高细节档约 583 MiB；源驻留额外计算且受 GPU 账本限制。碰撞数据不计入 CPU 准入预算：Trogir 体素对保留 18,275,664 字节（17.4 MiB），解析期间约需 37.2 MiB。引擎目标、浏览器解码及驱动分配也不在这些账本内。无法暴露所选档位限制的适配器会在启动时显式失败。

相机起始于世界视点 `(-33.03, 0.24, -65.76)`，HUD 偏航角 `27.70°`、向上为正的俯仰角 `6.62°`、翻滚角 `0.00°`、近平面 `0.1`、远平面 `1500`。相机速度为 `0.8`，惯性为 `0.6`。启动时直接创建该 `FreeCamera` 姿态，并在碰撞数据加载后精确挂载一次第一人称控件；不存在轨道相机、相机模式状态或相机模式 UI。

页面将引擎、场景、流、控件、HUD 回调及异步启动作为一个幂等生命周期统一拥有。`pagehide` 或引擎创建、流加载、场景注册、引擎启动或首帧就绪期间的任何失败都会在显示错误前销毁所有已获取的资源。一旦获得流结果所有权，页面就会对其原始就绪 Promise 安装拒绝观察器；之后等待该原始 Promise 仍会报告真正的就绪失败，而注册/启动失败或 `pagehide` 可以销毁流而不会产生第二个未处理的就绪拒绝。每次 await 完成都会检查销毁是否已经触发；迟到的引擎或流结果会被观察并立即销毁，而不是逃逸所有权。仅成功路径的就绪标志与遮罩层移除不会在销毁后运行。

同一面板中默认折叠的原生 `details` 区域报告相机的世界位置与以度为单位的偏航/俯仰/翻滚角。它从 `scene.camera.worldMatrix` 推导：平移为矩阵元素 12–14，前向为归一化的第三基列，偏航角为绕世界 +Y 的旋转，仰视时俯仰角为正，翻滚角为第一基列绕前向轴相对于零翻滚右向量的有符号旋转。接近垂直前向方向时，偏航角回退到投影右/上基向量，以使所有合法显示值保持有限；精确与舍入后的负零格式化为零。纯姿态读取器会以 `RangeError` 拒绝非有限、零长度或奇异相机基；HUD 仅捕获该预期校验类型，显示其具体消息及不可用字段而非代入看似合理的零值，并重新抛出无关失败。展开 details 元素会立即刷新数值，而折叠时渲染回调跳过所有姿态推导与格式化。HUD 保持现有内容宽度，但将其总框体限制在视口边距内，并在展开内容超出较矮视口时垂直滚动。阻塞遮罩层在 `firstFrameReady` 时消失，而非等待收敛。

署名信息始终可见：“Get lost in the alleys of historical Trogir, Croatia”，作者 Paolo Tosolini，来源 `https://superspl.at/scene/14bac5b2`，CC BY 4.0 许可。

核心流修正不变量比诊断策略更严格。CPU 准入在解码期间保留编码字节并同时预留编码加解码峰值；如果不等待自身保留资源就无法推进的源预准备会干净地拒绝并释放所有预留。环境驻留减少规划器限额，但绝不使未变更的合法公共 `maxSplats` 失效；仅将可变目标提高到不可变前景容量之上才是错误。提交局部收集描述符在源准入前拥有受保护账本余量，并在重叠的退役栅栏期间保持记账。选择快照与需求是逐绘制绑定维护并在源取消前聚合的，因此不相交的相机无法抹除彼此的请求。场景销毁器在 `disposeScene` 期间绝不修改实时的销毁数组。

待处理发布是事务性的。所有缩减都针对暂存汇总执行（即使中间总计仍高于容量），校验完整缩减后的代次，仅在此之后才准许负担得起的升级。被汇总容量拒绝的精细候选无法压制可用的粗糙表示；当待处理保护阻塞了所需覆盖或降级前置条件时，未发布的精细源失去待处理保护，而规范源保持活动保护。代次准入压力是 `updateStats` 消费的显式持久状态，仅在成功发布后清除。

不提交任何数据集字节、个人路径、伪造缩略图或黄金参考图。

## Babylon.js 等价映射

这是一条仅限 Lite 的全新流式传输/所有权路径。它复用了 Lite 现有的高斯数学核、透明混合/深度约定、场景节点变换、渲染目标签名、绘制更新批处理、活动帧编码器以及 GPU 退役机制。不声称 Babylon.js 具有等价的流式 API。现有静态高斯场景仅作为共享数学的兼容性参照基准。

## 依赖关系

- 现有的 `EngineContext`、`SceneContext`、`SceneNode`、延迟可渲染对象及渲染目标签名；
- 现有的 `DrawBinding`、`DrawUpdateContext`、`DrawUpdateBatch` 与 `enableDrawBatchCollection`；
- 现有的 `retireGpuResources`；
- 浏览器 Fetch、AbortController、`createImageBitmap` 与 WebGPU；
- 无 Worker、WebGL、画布回读、外部运行时包或模块级可变集合。

所有缓存均为惰性且按设备索引。导入根导出不执行任何工作。

## 校验要求

### 单元测试

- 清单 v1 解析、未知版本、畸形包围盒/树、环/深度/节点限制；
- 共享文件区间、任意文件名顺序、无效索引/范围、缺失/稀疏 LOD；
- 忽略缺失 LOD 的零误差；推导误差；非单调/相等/被支配备选项；
- 使用 Lite 真实反向 Z 透视的视锥平面、完全位于后方与保守跨界包围盒、包围盒内相机、变换后包围盒、FOV/调整大小、滞后与预算失败；
- Trogir 实际演示摆放辅助函数、非对称公共包围盒以及由同一场景节点旋转变换的非对角协方差；
- 精确的 Trogir 第一人称启动格式化为指定的六字段 HUD 姿态、保留其 FOV/near/far 设置、精确挂载一次第一人称控件并幂等分离它们；
- 在精细请求之前按广泛覆盖选择引导文件；
- 请求去重、并发 HTTP/解码限制、内存限额与独占大源回退、邻近文件队列排序、取消、有界重试、乱序过期代次及销毁；
- 严格优先级预准备抢占，证明停滞精细工作完全回滚、新近可见粗糙覆盖完成，然后原始作业恢复且不超过 HTTP/解码/CPU 上限；
- 别名与非别名环境源分别共享或独占一个运行时/缓存分配，保留组合的叶子/环境需求、前景限额、发布、淘汰/重载及销毁；
- 引导前正交选择拒绝就绪状态并阻止迟到回调；可变选择错误在有效缓存和重算输入上恢复而不掩盖源失败；
- 保护计数在可见性、待处理、发布、环境与淘汰变更时确定性更新；未变更帧不执行叶子/区间保护重扫，而活动最近使用计数仍推进；
- 跨延迟/失败/取消替换、逐步更廉价驻留准入以及低于容量驻留目标压力时保留已显示回退；
- 模拟时钟逐叶冷却，覆盖即时初始覆盖/细化、低于/精确截止期限转换、震荡、异步到达、共享视图、压力/预算绕过、缺失覆盖、销毁、零兼容性及选项校验；
- 精确输入缓存复用与规划器计数器，覆盖可变矩阵/相机/视口/世界变更以及所有源、准入、绑定、压力、发布、环境及冷却过期失效，同时生命周期调度继续；
- 缓存记账、固定/引用保护、带确定性最近使用平局决胜的最远优先准入、移动/多相机、变换及共享源包围盒、部分上传清理与退役。

### 数值/GPU 行为

- 精确均值端点/符号跨越及末尾/填充纹素行为；
- 所有四种四元数选择器与协方差 `S*C*S`；
- 单次缩放指数运算、直接 alpha、负/HDR SH0 颜色；
- 保留字节的 RGBA8 上传，包括低 alpha/高 RGB 与首/末行；
- 收集区间偏移映射与同文件多叶子；
- 使用 Lite 真实反向 Z 透视的投影：负/视点/近边界/正深度、视点后方大椭圆、相机/世界平移与旋转、哨兵排序以及全剔除帧后的间接重置；
- 基数排序计数 0、1、相等键、哨兵、近似相同深度、非 2 的幂次尾部、全部 16 个数字、通道/字边界 0/31/32/63/255、任意随机 32 位键、255/256/257 项、65,536 层级边界、500,000 容量下的活动计数折叠、陈旧行恢复及全部八趟；
- 存活者压缩验证无无效哨兵的稠密前缀、GPU 计数驱动的派发维度、跨工作组严格的等深度规范 ID 平局顺序以及零到多到一到零转换；
- 实际材质 `bind` 调用为不同视图保留各自稳定的选择标识；
- WGSL 管线必须在 WebGPU 实现上编译通过，且诊断回读绝不得进入生产渲染路径。

## 文件清单

```text
packages/babylon-lite/src/loader-splat-stream/
  splat-stream-types.ts
  splat-stream-meta.ts
  splat-stream-selection.ts
  splat-stream-requests.ts
  splat-stream-cache.ts
  splat-stream-gather.wgsl
  splat-stream-project.wgsl
  splat-stream-radix.wgsl
  splat-stream-render.wgsl
  splat-stream-gpu.ts
  splat-stream-material.ts
  load-gaussian-splat-stream.ts

packages/babylon-lite/src/index.ts
docs/lite/architecture/55-gaussian-splat-streaming.md
lab/lite/demo-trogir-streaming.html
lab/lite/src/demos/trogir-camera.ts
lab/lite/src/demos/trogir-assets.ts
lab/lite/src/demos/trogir-collision.ts
packages/babylon-lite/src/collision/splat-voxel-collision.ts
lab/lite/src/demos/trogir-quality.ts
lab/lite/src/demos/trogir-camera-pose.ts
lab/lite/src/demos/trogir-streaming-placement.ts
lab/lite/src/demos/trogir-streaming.ts
lab/vite.config.ts
demos-config.json
tests/lite/unit/splat-stream-meta.test.ts
tests/lite/unit/splat-stream-selection.test.ts
tests/lite/unit/splat-stream-requests.test.ts
tests/lite/unit/splat-stream-cache.test.ts
tests/lite/unit/splat-stream-orchestration.test.ts
tests/lite/unit/trogir-camera.test.ts
tests/lite/unit/trogir-quality.test.ts
tests/lite/unit/splat-voxel-collision.test.ts
tests/lite/unit/trogir-streaming-placement.test.ts
tests/lite/build/public-api-types.test.ts
tests/lite/build/splat-voxel-treeshake.test.ts
```
