# 模块：屏幕空间效果（Screen-Space Effects）

> 包路径：`packages/babylon-lite/src/post-process/screen-space-*`

## 用途

为已经将颜色和深度渲染到单采样离屏目标的 WebGPU 场景，提供可选启用的屏幕空间环境光遮蔽（SSAO）、接触阴影（contact shadows）以及单次反弹屏幕空间全局光照（SSGI）。

该实现共享深度重建、法线重建、时间重投影、深度拒绝以及邻域钳制（neighborhood clamping）。接触阴影和 GI 还共享双表面光线求交。除非应用导入了某个公共任务工厂，否则无需支付任何运行时字节开销。

这些效果均为帧图（frame-graph）任务。它们拥有所有中间渲染目标和 GPU 资源，将效果缓冲区和合成输出暴露为托管的 `RenderTarget` 值，绝不暴露原生 WebGPU 句柄。

## 公共 API 接口

```ts
export interface ScreenSpaceContactShadowsPostProcessTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    depthTexture?: RenderTarget;
    camera: Camera;
    lightDirection: Vec3;
    targetTexture?: RenderTarget | null;
    resolutionScale?: number;
    intensity?: number;
    tint?: readonly [number, number, number];
    stepCount?: number;
    maxDistance?: number;
    thickness?: number;
    bias?: number;
    normalBias?: number;
    temporalWeight?: number;
    temporalSamples?: number;
    spatialRadius?: number;
    resetVersion?: number;
    composition?: "none" | "multiply";
}

export interface ScreenSpaceContactShadowsPostProcessTask extends Task {
    readonly name: string;
    readonly sourceTexture: RenderTarget;
    readonly depthTexture: RenderTarget;
    readonly targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    readonly shadowTexture: RenderTarget;
    enabled: boolean;
    intensity: number;
    tint: readonly [number, number, number];
    stepCount: number;
    maxDistance: number;
    thickness: number;
    bias: number;
    normalBias: number;
    temporalWeight: number;
    spatialRadius: number;
    resetVersion: number;
    readonly lightDirection: Vec3;
}

export function createScreenSpaceContactShadowsPostProcessTask(
    config: ScreenSpaceContactShadowsPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ScreenSpaceContactShadowsPostProcessTask;

export interface ScreenSpaceGlobalIlluminationPostProcessTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    depthTexture?: RenderTarget;
    camera: Camera;
    targetTexture?: RenderTarget | null;
    resolutionScale?: number;
    intensity?: number;
    stepCount?: number;
    rayCount?: number;
    rayLength?: number;
    thickness?: number;
    bias?: number;
    fadeStart?: number;
    fadeEnd?: number;
    edgeFade?: number;
    temporalWeight?: number;
    temporalSamples?: number;
    resetVersion?: number;
    composition?: "none" | "additive" | "color-bleed";
    colorBleedGain?: number;
    colorBleedMax?: number;
}

export interface ScreenSpaceGlobalIlluminationPostProcessTask extends Task {
    readonly name: string;
    readonly sourceTexture: RenderTarget;
    readonly depthTexture: RenderTarget;
    readonly targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    readonly illuminationTexture: RenderTarget;
    enabled: boolean;
    intensity: number;
    stepCount: number;
    rayCount: number;
    rayLength: number;
    thickness: number;
    bias: number;
    fadeStart: number;
    fadeEnd: number;
    edgeFade: number;
    temporalWeight: number;
    colorBleedGain: number;
    colorBleedMax: number;
    resetVersion: number;
}

export function createScreenSpaceGlobalIlluminationPostProcessTask(
    config: ScreenSpaceGlobalIlluminationPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ScreenSpaceGlobalIlluminationPostProcessTask;

export interface ScreenSpaceAmbientOcclusionPostProcessTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    depthTexture?: RenderTarget;
    camera: Camera;
    targetTexture?: RenderTarget | null;
    resolutionScale?: number;
    intensity?: number;
    radius?: number;
    bias?: number;
    power?: number;
    sliceCount?: number;
    stepCount?: number;
    fadeStart?: number;
    fadeEnd?: number;
    temporalWeight?: number;
    temporalSamples?: number;
    resetVersion?: number;
    composition?: "none" | "multiply";
}

export interface ScreenSpaceAmbientOcclusionPostProcessTask extends Task {
    readonly name: string;
    readonly sourceTexture: RenderTarget;
    readonly depthTexture: RenderTarget;
    readonly targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    /** Temporally resolved occlusion amount (`rg16float`: occlusion in `.r`, view distance in `.g`). */
    readonly occlusionTexture: RenderTarget;
    enabled: boolean;
    intensity: number;
    radius: number;
    bias: number;
    power: number;
    sliceCount: number;
    stepCount: number;
    fadeStart: number;
    fadeEnd: number;
    temporalWeight: number;
    resetVersion: number;
}

export function createScreenSpaceAmbientOcclusionPostProcessTask(
    config: ScreenSpaceAmbientOcclusionPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ScreenSpaceAmbientOcclusionPostProcessTask;
```

可变字段会在每一帧编码之前立即采样。应用可以在不重建帧图的情况下调整或开关这些效果。递增 `resetVersion` 会使历史记录失效并重启有界时间采样窗口。

合成目标必须不同于 `sourceTexture`；在同一个 WebGPU 通道中对同一纹理既采样又渲染是无效的。串联效果时，调用方应使用两个渲染目标。

环境光遮蔽任务直接读取场景深度，并从最近的有效深度邻域重建法线。它不需要应用管理的法线预通道或网格注册列表。其纹理用 `0` 存储未遮蔽像素、用 `1` 存储完全遮蔽，因此时间所有者的清零标识是正确的。

### 默认值与钳制范围

| 设置                        | 接触阴影        | 全局光照            | 钳制范围                     |
| --------------------------- | --------------: | ------------------: | ---------------------------: |
| `resolutionScale`           |             `1` |               `0.5` |                  `[0.25, 1]` |
| `intensity`                 |           `0.6` |                 `1` |                     `[0, 4]` |
| `stepCount`                 |             `8` |                 `8` |            整数 `[1, 64]`    |
| `maxDistance` / `rayLength` |           `0.3` |                 `2` |              `[0.001, 1000]` |
| `thickness`                 |          `0.35` |              `0.45` |              `[0.001, 1000]` |
| `bias`                      |          `0.03` |              `0.05` |                   `[0, 100]` |
| `normalBias`                |         `0.035` |                 不适用 |            `[0.001, 100]` |
| `temporalWeight`            |        `1 / 32` |            `1 / 64` |                     `[0, 1]` |
| `temporalSamples`           |            `32` |                `64` |           整数 `[1, 256]`   |
| `spatialRadius`             |           `1.5` |                 不适用 |                  `[0, 4]` |
| `rayCount`                  |             不适用 |              `1` |             整数 `[1, 8]`    |
| `fadeStart`                 |             不适用 |             `20` |                `[0, 100000]` |
| `fadeEnd`                   |             不适用 |             `60` | 至少 `fadeStart + 0.001`     |
| `edgeFade`                  |             不适用 |            `0.1` |               `[0.001, 0.5]` |
| `colorBleedGain`            |             不适用 |              `1` |                    `[0, 16]` |
| `colorBleedMax`             |             不适用 |           `0.45` |                     `[0, 1]` |

默认接触阴影色调（tint）为 `[0.35, 0.38, 0.48]`。接触阴影和环境光遮蔽的默认合成为 `"multiply"`，全局光照的默认合成为 `"additive"`。

### 环境光遮蔽默认值与钳制范围

| 设置              | 默认值  | 钳制范围                             |
| ----------------- | ------: | -----------------------------------: |
| `resolutionScale` | `0.5`   | `[0.25, 1]`                          |
| `intensity`       | `1`     | `[0, 4]`                             |
| `radius`          | `0.5`   | `[0.01, 20]` 场景单位                |
| `bias`            | `0.05`  | `[0, 0.99]` 余弦地平线截止值         |
| `power`           | `1.5`   | `[0.1, 8]`                           |
| `sliceCount`      | `3`     | 整数 `[1, 8]`                        |
| `stepCount`       | `4`     | 整数 `[1, 8]`                        |
| `fadeStart`       | `20`    | `[0, 100000]` 场景单位               |
| `fadeEnd`         | `60`    | 至少 `fadeStart + 0.001`             |
| `temporalWeight`  | `1/32`  | `[0, 1]`                             |
| `temporalSamples` | `64`    | 整数 `[1, 256]`                      |

默认合成为 `"multiply"`。生产器和时间历史存储原始遮蔽度；`intensity` 由合成阶段应用。配合 `composition: "none"`，调用方可以自行合成原始的 `occlusionTexture`。

## 内部架构

### 共享着色器所有者

`screen-space-raymarch-wgsl.ts` 拥有屏幕空间效果共享的 WGSL 函数：

- 反向 Z（reverse-Z）深度加载与清除深度拒绝；
- 从逆视图投影矩阵重建世界坐标；
- 从世界坐标投影到纹理 UV；
- 最近邻深度法线重建；
- 手动双线性连续深度；
- 双表面求交：要求光线同时位于离散深度和连续深度之后，且处于配置的厚度片（thickness slab）之内；
- 去相关的屏幕空间哈希噪声与回绕相位旋转。

该源码是一个纯字符串工厂。它不执行模块级分配，也没有副作用。

深度法线对屏幕向右和屏幕向下的世界坐标导数 `pH` 和 `pV` 求叉积（对于右手系场景交换操作数）。世界向上（world-up）回退仅保留给角度退化情况：`dot(n,n) <= 1e-12 * dot(pH,pH) * dot(pV,pV)`，其中 `n` 为其叉积。这比较的是正弦平方，而非绝对世界空间像素面积，从而在相机接近表面或深度分辨率提高时保留有效的平面法线；零长度或共线导数仍走回退分支。

### 环境光遮蔽生产器与模糊

深度地平线（depth-horizon）生产器同时将场景深度用作接收器数据和遮挡物数据。它重建接收器位置和最近邻几何法线，将两者变换到视图空间，然后采样 `sliceCount` 个方位角方向。世界空间半径沿 U 和 V 独立转换，以跨纵横比保持其范围。每个方向在正反两个方向各步进 `stepCount` 次采样，保留接收器法线与采样方向之间最大的归一化正余弦值，并按 `1 - (distance / radius)^2` 加权。空间偏移的逐像素哈希旋转切片并抖动采样步进。两个哈希共享相同的加性时间相位，因此它们的差值模 1 对每个像素保持固定；它们在时间上并非相互独立。距离接收器小于一个深度纹素的采样点会被跳过，以避免在较远半径下重复采样中心深度。

世界空间 `radius` 通过在接收器深度处反投影一个深度纹素来转换为 UV 距离，因此投影不需要特定于相机的 FOV 公式。已清除的深度产生零遮蔽。生产器在 `fadeStart` 与 `fadeEnd` 之间淡出遮蔽，然后将原始遮蔽度写入 `r8unorm`。

水平和垂直双边模糊通道对低切片估计值进行降噪。空间权重随采样距离减小；深度权重比较重建后的视图距离以防止跨越轮廓边缘溢色。共享标量时间所有者通过相机重投影累积模糊后的遮蔽度，并将接受的历史钳制到当前原始邻域内。

### 共享时间所有者

`screen-space-temporal.ts` 创建用于每个生产器之后的两个内部通道：

1. **解析（Resolve）：** 重建当前世界坐标，在解析标量数据时从经过深度验证的时间圆盘中选择接触阴影采样点，通过上一帧视图投影矩阵进行重投影，拒绝越界或深度不匹配的历史，将接受的历史钳制到当前 3x3 邻域内，并与当前估计值混合。
2. **历史拷贝（History copy）：** 将解析后的稳定目标拷贝到下一帧使用的历史目标中。

标量历史使用 `rg16float`：`.r` 为效果值，`.g` 为当前视图距离。
颜色历史使用 `rgba16float`：`.rgb` 为间接光照颜色，`.a` 为当前视图距离。

标量解析首先应用一个深度感知 3x3 滤波器，使第一帧不暴露生产器的原始采样模式。接触阴影随后在半径为 `spatialRadius` 个效果像素的圆盘内连续旋转该滤波采样点；环境光遮蔽将该半径设为零，因为其生产器已经应用了双边滤波。仅当采样点的重建视图距离与时间历史处于同一 4% 阈值之内时才被接受，从而防止轮廓边缘溢色。

时间状态拥有两个独立的计数器：

- **累积计数（Accumulation count）** 控制 `max(configuredWeight, 1 / accumulatedSamples)` 并钳制在 `temporalSamples`，即使 `temporalWeight` 为零时也能保留动画源和运行时参数变化。仅在首次分配、目标重新分配、从禁用切换到启用、奇异逆矩阵或 `resetVersion` 更改后重置。相机移动不会重置它。
- **相位索引（Phase index）** 连续旋转生产器采样。历史失效会将其重启为零；相机移动会保留有效的重投影历史并继续推进序列。

任务同时存储上一帧视图投影矩阵和上一帧视图矩阵。当前世界坐标经由上一帧视图矩阵变换得到期望的上一帧视图距离，经由上一帧视图投影矩阵变换得到历史 UV。当满足以下条件时拒绝历史：

```text
abs(expectedPreviousViewDistance - storedPreviousViewDistance)
    / max(expectedPreviousViewDistance, 0.001) > 0.04
```

这种相对比较在半精度浮点历史下于近处和远处距离均保持有意义。

相机移动不会丢弃有效历史。世界空间重投影会保留匹配的表面。首帧、目标重新分配、奇异逆矩阵、禁用转启用或显式重置会使用当前帧权重 `1`。

### 重置矩阵

| 事件                       | 使历史失效         | 重启相位序列 |
| -------------------------- | -----------------: | -----------: |
| 首次分配                   | 是                 | 是           |
| 自有目标重新分配           | 是                 | 是           |
| 源/深度纹理标识变更        | 是                 | 是           |
| 相机移动                   | 否                 | 否           |
| `resetVersion` 变更        | 是                 | 是           |
| 禁用 → 启用                | 是                 | 是           |
| 启用 → 禁用                | 写入一次单位值     | 否           |
| 无关帧图重建               | 否                 | 否           |

### 任务所有权

每个公共任务都是一个帧图节点，其 `record` 和 `execute` 函数编排内部的生产器、时间解析、拷贝和可选合成通道。因此公共图只排序一个对象，而任务保持对所有目标的严格所有权。

生产器目标和时间目标的尺寸由源渲染目标乘以钳制在 `[0.25, 1]` 的 `resolutionScale` 推导得出。仅当这些尺寸发生变化时才会重建它们。

生产器和时间着色器分别携带效果缓冲区尺寸和源深度尺寸。在加载对应的全分辨率深度纹素之前，每个效果纹素都会转换为 UV，从而使半分辨率 GI 覆盖完整画面，而非仅覆盖左上角深度象限。

该实现使用专用管线而非 `createPostProcessTask`，因为它必须通过仅深度视图将深度附件绑定为 `texture_depth_2d`。`depthTexture` 指的是所提供渲染目标的深度附件；省略时，任务读取 `sourceTexture` 的深度附件。如果该附件缺失或为多重采样，创建将会失败。

在执行时，任务将源颜色和深度的 `GPUTexture` 标识与其 bind group 所使用的标识进行比较。因此，同尺寸的设备恢复或所有者重建会重建受影响的 bind group，而不是保留已销毁的纹理引用。

没有任何通用渲染任务、相机、材质或场景模块导入这些特性。根索引重导出保持可 tree-shaking。

## 管线配置

### 接触阴影

| 通道     | 目标         | 格式          | 采样方式                             |
| -------- | ------------ | ------------- | ------------------------------------ |
| 生产器   | raw contact  | `r8unorm`     | 最近邻深度                           |
| 时间解析 | stable contact | `rg16float` | 最近邻原始/深度，线性历史            |
| 历史拷贝 | contact history | `rg16float` | 最近邻                              |
| 可选合成 | 配置的目标   | 源格式        | 线性源/接触                          |

生产器默认以全分辨率运行。

### 全局光照

| 通道     | 目标                 | 格式          | 采样方式                              |
| -------- | -------------------- | ------------- | ------------------------------------- |
| 生产器   | raw illumination     | `rgba16float` | 最近邻深度，线性场景颜色              |
| 时间解析 | stable illumination  | `rgba16float` | 最近邻深度，线性原始/历史             |
| 历史拷贝 | illumination history | `rgba16float` | 最近邻                                |
| 可选合成 | 配置的目标           | 源格式        | 线性源/光照                           |

生产器默认以半线性分辨率运行。

### 环境光遮蔽

| 通道         | 目标              | 格式        | 采样方式                              |
| ------------ | ----------------- | ----------- | ------------------------------------- |
| AO 深度生产器| raw occlusion     | `r8unorm`   | 最近邻场景深度                        |
| 水平模糊     | temporary AO      | `r8unorm`   | 最近邻原始 AO 与场景深度              |
| 垂直模糊     | blurred AO        | `r8unorm`   | 最近邻临时 AO 与深度                  |
| 时间解析     | stable occlusion  | `rg16float` | 最近邻 AO/深度，线性历史              |
| 历史拷贝     | occlusion history | `rg16float` | 最近邻                                |
| 可选合成     | 配置的目标        | 源格式      | 线性源/遮蔽                           |

生产器和模糊目标按 `resolutionScale` 运行；默认半分辨率路径仅着色四分之一的全分辨率像素。

环境光遮蔽目前要求全屏相机视口：省略 `camera.viewport` 或使用 `{ x: 0, y: 0, width: 1, height: 1 }`。工厂函数、`record` 和 `execute` 会以描述性错误拒绝任何其他视口，包括创建后原地的视口变更以及效果处于禁用状态时的情况。此限制使重建与时间重投影保持在同一全目标坐标系中，直到支持子视口为止。

全局光照时间解析对当前原始估计值应用一个融合的五点十字滤波器。邻域权重结合固定的空间权重与相对视图深度一致度。这无需分配额外目标或通道即可消除独立像素噪声。

## 着色器逻辑

### 接触阴影生产器

1. 加载接收器深度。已清除的深度返回零遮蔽。
2. 重建接收器世界坐标和基于深度推导的世界法线。
3. 沿法线偏移光线起点 `bias`。
4. 朝 `-lightDirection` 方向步进覆盖 `maxDistance` 的 `stepCount` 个区间。
5. 投影每个光线点，并在屏幕外停止。
6. 求值共享的双表面求交。
7. 通过切平面净空测试拒绝接收器表面的延续自遮挡。
8. 按步进距离、穿透置信度和切平面净空加权被接受的命中。
9. 将遮蔽度存储于 `[0, 1]`。

乘法合成为：

```wgsl
let amount = shadow * intensity;
result.rgb = source.rgb * mix(vec3f(1), tint, amount);
```

### 环境光遮蔽生产器

1. 将效果像素映射到整数场景深度坐标并加载其深度。已清除的深度返回零遮蔽。
2. 在该深度纹素的中心 UV（而非未对齐的效果 UV）处重建世界坐标，并将其变换到视图空间。立即计算 `fade = 1 - smoothstep(fadeStart, fadeEnd, abs(viewPos.z))`；若为零，则在重建法线或步进之前直接返回零。否则，重建最近邻世界法线并将其变换到视图空间。使用同一深度 UV 处反投影反向 Z 深度 `0.5` 与 `1` 之间的向量（作为方向变换到视图空间）来使其朝向观察者。该射线指向透视视点或沿着平行正交观察方向（包括离轴正交视景体）；这些深度值避免了反投影无穷远平面。
3. 在接收器深度处从对齐后的接收器 UV 反投影一个深度纹素的偏移，以将世界空间半径转换为屏幕空间步进半径。
4. 使用独立的水平/垂直每 UV 世界单位缩放比例将半径转换为 UV 向量。对于每个旋转并步进抖动的切片及两个方向，在各自深度纹素的中心 UV 处重建每个加载的采样点。保留高于 `bias` 的最大归一化正法线/采样点余弦值，并乘以 `1 - (distance / radius)^2` 衰减；对这些方向遮蔽估计值求平均。对接收器和采样位置都进行网格对齐，可使斜平面在较低效果分辨率下保持共面，而不会产生虚假的地平线遮挡。
5. 用 `pow(averageOcclusion, power)` 塑造平均遮蔽度，并乘以先前计算的淡出因子，保留平滑过渡区间。
6. 应用水平和垂直深度感知双边模糊，然后进行时间重投影、拒绝和邻域钳制。

乘法合成为：

```wgsl
let amount = clamp(occlusion * intensity, 0.0, 1.0);
result.rgb = source.rgb * (1.0 - amount);
```

### 全局光照生产器

1. 加载接收器深度并重建接收器世界坐标与法线。
2. 从像素噪声和时间相位生成 `rayCount` 个独立播种的余弦加权半球方向。
3. 使用共享的双表面求交在 `rayLength` 上步进每条光线。
4. 每次命中时，在命中 UV 处采样已经光照过的 `sourceTexture`。
5. 应用接收器距离和屏幕边缘淡出。
6. 存储平均间接颜色；未命中贡献零。

加法合成会加上 `illumination * intensity`。

可选的 `color-bleed` 合成按亮度归一化光照，并将源色度向该色调相乘：

```wgsl
let luminance = dot(illumination, vec3f(0.2126, 0.7152, 0.0722));
let amount = min(intensity * min(luminance * colorBleedGain, 1), colorBleedMax);
result.rgb = source.rgb * mix(vec3f(1), illumination / max(luminance, 1e-4), amount);
```

`composition: "none"` 会跳过合成通道并将 `outputTexture` 设为稳定效果目标。这支持应用自行接管合成而无需为未使用的通道付费。禁用任一效果都会将其稳定目标和历史目标清零一次；零表示无接触遮蔽和无间接光照。

### 坐标约定

全屏 UV 面向存储坐标，`(0, 0)` 位于左上角。重建与重投影使用：

```wgsl
let ndc = vec3f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth);
let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
```

不应用针对特定渲染目标的 Y 轴翻转。

## 状态机 / 生命周期

### 创建

- 校验源/深度采样数为 `1`。
- 将数值设置钳制到安全范围。
- 仅分配纯任务状态；GPU 目标推迟到 `record`。

### Record

- 解析源尺寸。
- 仅当解析尺寸发生变化时分配或调整自有目标的大小。
- 针对存活目标视图构建管线和 bind group。
- 仅当分配或源/深度纹理标识实际更改时才重置时间累积。

### Execute

- 读取可变设置。
- 计算当前逆视图投影矩阵和视图矩阵。
- 检测相机、源版本和尺寸变化。
- 上传生产器和时间 uniform。
- 运行生产器、时间解析、历史拷贝和可选合成。
- 保存当前视图投影矩阵供下一帧使用。

当 `enabled` 为 false 时，跳过生产器。已配置的合成会原样拷贝源；`"none"` 在禁用转换时将稳定输出清零。时间历史失效，以便重新启用时从当前帧重新开始。

### Dispose

- 销毁所有自有目标、uniform 缓冲区和管线引用。
- 绝不销毁调用方拥有的源、深度或目标纹理。

## 依赖项

- `camera/camera.ts`：用于视图与投影矩阵。
- `math/invert-mat4.ts`。
- `engine/render-target.ts`。
- `frame-graph/task.ts`。
- `resource/samplers.ts`。
- `engine/gpu-flags.ts`。

这些效果不依赖几何体渲染器、透射、深度金字塔、阴影或材质。

仅相机的重投影无法为独立移动的物体保留历史。深度拒绝和邻域钳制限制了拖尾，但不能替代运动矢量。未来可选的速度输入可以使用 `GeometryTextureType.LINEAR_VELOCITY`，同时不改变默认的无依赖路径。

## 测试规范

### 单元测试

- 反向 Z 重建正确映射已知的近/远深度；
- 双表面求交同时需要两个深度估计值并遵守 bias/thickness；
- 切平面净空拒绝平滑自相交并接受分离几何体；
- 时间混合遵循滑动平均斜坡与配置的下限；
- 累积重置与相位重启遵循上方的重置矩阵；
- 重投影将历史与上一帧相机的视图距离进行比较；
- UV → 世界 → UV 往返符合文档记录的左上角约定；
- 深度法线着色器契约要求与尺度相关的角度退化守卫，而非将近距离相机下的有效法线替换为世界向上的绝对叉积阈值；
- 公共工厂钳制无效的分辨率、步数和时间设置；
- 生成的 WGSL 包含标量/颜色历史布局以及双表面/切平面契约；
- 环境光遮蔽默认值、仅深度要求、目标别名拒绝、禁用恒等输出、深度绑定替换、目标调整大小和默认乘法合成均由单元/模拟生命周期测试覆盖；
- AO 在创建、record 和 execute 时拒绝非全屏相机视口，包括随后的原地变更和禁用状态下的执行；
- 数值斜坡平面回归检查四分之一、半分辨率和全分辨率下的最近邻深度纹素中心重建；配对的着色器契约断言将接收器和步进重建均绑定到这些坐标；
- 数值投影射线回归涵盖透视和离轴正交法线朝向、倾斜接收器以及前景遮挡。着色器契约将朝向绑定到反投影射线，而非相机原点向量；
- 淡出契约要求在法线重建和地平线采样之前执行零淡出早退，同时在过渡区间保留 smoothstep 乘数；
- AO WGSL 断言仅检查源码契约；纵横比一致性、抖动质量、轮廓光晕、模糊质量以及移动物体拖尾需要 WebGPU 渲染验证。

### Demo 验证

`demo-screen-space-effects` 将本地存储的来自 `zuuhr/GlobalIlumination-BabylonJS` 的 Cornell Box GLB 加载到离屏颜色/深度目标中。按钮独立切换接触阴影、环境光遮蔽、全局光照和自动轨道旋转。接触阴影馈送给 GI，随后 AO 将组合颜色相乘输出到屏幕目标，使新增的间接光也受到遮蔽。初始相机朝向打开的盒子内部；自动旋转默认关闭以便时间累积效果能从稳定视角收敛。

该 Demo 必须：

- 到达 `canvas.dataset.ready = "true"`；
- 不产生任何 WebGPU 校验错误；
- 显示非零的接触、遮蔽和光照缓冲区；
- 在切换各项效果与自动旋转时保持交互响应；
- 拥有生成的 Demo bundle 清单和 1280x720 JPG 缩略图。

### Bundle 验证

- 针对性的 Demo 构建记录该特性的开销。
- 代表性非特性场景字节数保持不变；scene1 严格保持 88,861 原始字节。
- 不更改任何 bundle 上限。

## 文件清单

```text
packages/babylon-lite/src/post-process/screen-space-raymarch-wgsl.ts
packages/babylon-lite/src/post-process/screen-space-temporal.ts
packages/babylon-lite/src/post-process/screen-space-contact-shadows.ts
packages/babylon-lite/src/post-process/screen-space-ambient-occlusion.ts
packages/babylon-lite/src/post-process/screen-space-global-illumination.ts
packages/babylon-lite/src/index.ts
tests/lite/unit/screen-space-effects.test.ts
lab/lite/src/demos/screen-space-effects.ts
lab/lite/demo-screen-space-effects.html
lab/public/screen-space-effects/cornellBox.glb
lab/public/thumbnails/demo-screen-space-effects.jpg
lab/public/bundle/demos-manifest.json
demos-config.json
scripts/bundle-demos-core.ts
docs/lite/architecture/52-screen-space-effects.md
```
