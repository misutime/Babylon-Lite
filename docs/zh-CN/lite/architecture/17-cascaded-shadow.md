# 模块：级联阴影贴图（Cascaded Shadow Maps / CSM）

> 包路径：
> `packages/babylon-lite/src/shadow/csm-directional-shadow-generator.ts`
> `packages/babylon-lite/src/shadow/csm-shadow-task-hooks.ts`
> `packages/babylon-lite/src/shadow/csm-shadow-cache.ts`
> `packages/babylon-lite/src/shadow/csm-refit-gate.ts`
> `packages/babylon-lite/src/shader/fragments/csm-shadow-fragment-core.ts`
> `packages/babylon-lite/src/material/standard/fragments/std-csm-shadow-fragment.ts`

## 用途

用于**方向光**的级联阴影贴图，与 Babylon.js 中采用默认 5×5 PCF 过滤器（`computeShadowWithCSMPCF5`）的 `CascadedShadowGenerator` 匹配。相机视锥体被划分为 N 个深度切片（级联）；每个级联都拥有一个紧密拟合该切片的正交阴影贴图，并渲染到一张 `depth32float` `texture_2d_array` 的某一个图层面中。接收者根据相机视图空间深度为每个片元选择级联，使用 PCF5 采样该数组层，并可在切片边界附近可选地交叉淡入下一级联。

所有实质性的 CSM 代码都位于上述四个模块以及极少数最小字节的共享修改中（参见“打包体积纪律”），因此 ESM/PCF 场景在字节层面不受任何影响。

## 公共 API 表面

```ts
interface CsmDirectionalShadowGeneratorConfig {
    mapSize?: number; // per-cascade square resolution, default 1024
    numCascades?: number; // default 4 (max 4)
    lambda?: number; // log/uniform split blend 0..1, default 0.5
    cascadeBlendPercentage?: number; // cross-fade fraction, default 0.1 (0 disables)
    stabilizeCascades?: boolean; // bounding-sphere fit (no shimmer), default false
    shadowMaxZ?: number; // max shadow distance, default = camera far plane
    bias?: number; // depth bias, default 0.00005
    worldSpaceBias?: number; // caster depth offset in world units; supplied non-positive/non-finite values disable bias
    darkness?: number; // 0 = black shadow, 1 = no shadow, default 0
    frustumEdgeFalloff?: number; // soft cascade-edge fade 0..1, default 0
    forceRefreshEveryFrame?: boolean; // default false
}

function createCsmDirectionalShadowGenerator(engine: EngineContext, light: DirectionalLight, cfg?: CsmDirectionalShadowGeneratorConfig): ShadowGenerator;

interface CsmStaticCacheOptions {
    refitAngle: number;
    refitMaxIntervalMs?: number;
    staticCascadesPerFrame?: number; // 0 or omitted: every cascade re-renders in the refit frame
    cascadeCoveragePadding?: number; // 0 or omitted: off; otherwise 2 / mapSize through 1, stabilizeCascades only
}

function enableCsmStaticCache(engine: EngineContext, shadowGenerator: ShadowGenerator, options: CsmStaticCacheOptions): Promise<void>;

function getCsmReceiverTexture(shadowGenerator: ShadowGenerator): Texture2D;

function onCsmReceiverUpdate(shadowGenerator: ShadowGenerator, callback: (data: Float32Array) => void): () => void;

function setShadowCasterMaxCascade(mesh: Mesh, maxCascade: number): void;

interface CsmRefitCaster {
    readonly worldMatrixVersion: number;
    readonly thinInstances?: { readonly _version: number } | null;
}

interface CsmRefitGateOptions {
    refitAngle: number;
    refitMaxIntervalMs: number;
    demoteQuietFrames?: number;
}

interface CsmRefitDecision {
    refit: boolean;
    renderDynamic: boolean;
}

interface CsmRefitGate<M extends CsmRefitCaster> {
    syncCasters(casters: readonly M[]): void;
    markDynamic(caster: M): void;
    isDynamic(caster: M): boolean;
    update(
        lightDirX: number,
        lightDirY: number,
        lightDirZ: number,
        nowMs: number,
        cameraChanged: boolean,
        force: boolean,
        onPromote: (caster: M) => void,
        onDemote: (caster: M) => void
    ): CsmRefitDecision;
}

function createCsmRefitGate<M extends CsmRefitCaster>(options: CsmRefitGateOptions): CsmRefitGate<M>;
```

用法与其他方向光生成器一致：

```ts
const light = createDirectionalLight([0, -1, -1], 0.8);
addToScene(scene, light);
light.shadowGenerator = createCsmDirectionalShadowGenerator(engine, light, { mapSize: 1024 });
setShadowTaskCasterMeshes(light.shadowGenerator, casterMeshes);
// receivers: mesh.receiveShadows = true
await registerSceneWithShadowSupport(scene);
```

`setShadowCasterMaxCascade(mesh, maxCascade)` 将投射者限制在级联层 `0..maxCascade`（`0` 为最近层）。默认涵盖所有级联；传入 `Infinity` 可恢复默认。参数值必须为非负整数索引或 `Infinity`。该上限会在 `setShadowTaskCasterMeshes` 提供投射者集合时被快照保存，因此更改运行中的上限需要重新传入一个新的投射者数组实例。CSM 仅更新发生变化投射者的逐级联任务成员资格；ESM 和单贴图 PCF 会忽略该上限。

自定义 `ShaderMaterial` 接收者使用相同的公共生成器，而无需读取其内部 WebGPU 资源：

```ts
const material = createShaderMaterial({
    // ...sources, attributes, and uniforms...
    samplers: [{ name: "csmShadow", sampleType: "depth", viewDimension: "2d-array", comparison: true }],
});
setShaderTexture(material, "csmShadow", getCsmReceiverTexture(light.shadowGenerator));
onCsmReceiverUpdate(light.shadowGenerator, (data) => {
    // Mirror the documented 80-float receiver layout into the custom material.
});
```

`getCsmReceiverTexture` 仅接受由 `createCsmDirectionalShadowGenerator` 创建的生成器；其他阴影技术将抛出异常。它返回一个借用的 `Texture2D`，其视图显式为 `"2d-array"`，采样器为生成器的比较采样器，采样类型为深度。同一生成器上的每次调用都返回同一个包装对象。它与生成器共享生命周期，不得独立释放或销毁。

同时**接收**与**投射** CSM 阴影的自定义 `ShaderMaterial` 不能通过自身进行投射：纯深度投射者视图共享源材质的绑定组，因此投射通道会采样到它正在渲染写入的级联数组。请为其提供一个无采样器的投射材质（相同的顶点阶段，且可共享同一存储缓冲区以便 GPU 变形几何体投射出真实剪影），并通过公共的 `setShadowCasterMaterial(visibleMaterial, casterMaterial)` 进行绑定。

## 内部架构

### `ShadowGenerator` 扩展（共享接口，仅类型定义）

- `_shadowType` 联合类型从 `"esm" | "pcf"` 拓宽为 `"esm" | "pcf" | "csm"`。
- `_csmCascadeCount?: number` — 级联数量，由接收者可渲染对象读取，用于将级联选择循环上界烘焙进着色器。
- `_csmReceiverTexture?: Texture2D` — 供自定义接收者使用的懒创建借用公共包装器。它恰好创建一个显式 2d-array 视图，缓存在生成器上而非模块状态中，并建立一个生成器拥有的纹理引用，使 ShaderMaterial 的获取/释放周期不会销毁共享的阴影贴图。

### 静态缓存与重拟合门控（Refit Gate）

在场景注册或访问接收者纹理之前 `await enableCsmStaticCache(engine, generator, options)` 可启用静态阴影缓存。投射者最初位于动态叠加层中，连续 120 帧静止后转为静态，一旦其世界矩阵或瘦实例版本发生变化则立即重返动态集合。当灯光偏转超过 `options.refitAngle`、相机发生变化（配置 `options.cascadeCoveragePadding` 时，仅限于下文_相机覆盖重拟合_所列的变更）、投射者成员变化、静态投射者移动或 `options.refitMaxIntervalMs` 到期时，重拟合（refit）会重新计算级联并刷新私有静态深度数组。灯光暂停期间计时器仍然保持活跃，以便由 GPU 时钟驱动动画的静态投射者继续刷新。未显式启用的生成器保留原有的单任务路径，不分配缓存纹理，也不加载缓存实现。

当 `options.staticCascadesPerFrame` 大于零时，仅由灯光漂移触发的重拟合每帧最多按轮询方式重新渲染指定数量的静态级联，从而将周期性刷新均摊到每一帧的一小部分开销中，避免出现单个长耗时帧。每个选中的级联原子推进：其阴影相机与接收者变换一并更新，渲染其静态层，仅将该数组层拷贝到实时阴影贴图，并仅渲染该层的动态叠加层。仍在等待的级联同时保留它们之前的深度与之前的接收者变换，从而确保在整个分摊期间被采样的数据保持连贯。

已发布的级联保留其灯光视图和投射者视图-投影矩阵的独立拷贝。阴影相机持有传入数组的引用，而在部分级联保持已发布状态期间，重拟合会为每个级联重新计算共享的拟合暂存区：分摊刷新会在多帧间逐步发布级联，而覆盖重拟合（见下文）仅重新发布未通过测试的级联。若使用引用，等待中的级联相机（进而其动态叠加层的剔除）就会在静态层使用新拟合渲染完成之前提前采用新拟合结果。

由相机（未启用 `cascadeCoveragePadding` 时；见下文；更换活跃相机按对象身份计入，因为相机变更键是两个相机可能碰巧相同的逐相机计数器之和）、场景内容、投射者集合、提升或降级触发的重拟合会在当帧更新所有级联，行为与未设置该选项时相同。当上一轮分摊尚未排空时若发生新的漂移重拟合，也会立即更新所有级联，防止快速移动的灯光不断替换挂起中的代次。如果在分摊期间有动态投射者发生变化，则会拷贝缓存并为每个级联重绘动态叠加层，同时每个静态层仍与其当前已发布的变换保持配对。

#### 相机覆盖重拟合（`cascadeCoveragePadding`）

默认关闭（`0` 或省略）：每次相机变更都会重拟合并重新渲染所有级联，如上所述。正数必须位于 `2 / mapSize` 到 `1` 之间，且要求 `stabilizeCascades: true`；`enableCsmStaticCache` 会拒绝任何其他值。下限存在的原因在于纹素对齐（texel snapping）会使一次拟合最多偏移其半径的 `sqrt(2) / mapSize`：因此一次全新拟合最多触及自身覆盖圆盘的 `1 / (1 + padding) + sqrt(2) / mapSize`，从 `2 / mapSize` 起该值始终不超过 1。这是一个最坏情况理论界，而非实测阈值。

- **带边距拟合。** 缓存生成器的每次拟合都会向 `_computeCsmCascades` 传入 `radiusScale = 1 + padding`，在执行 1/16 取整前将每个稳定后的包围球按该系数放大。纹素尺寸大致按相同系数增大。
- **覆盖测试。** 在相机变换版本发生变化的每一帧，都会针对每个级联的**已发布**贴图测试该级联当前切片的覆盖情况：其八个角点（来自与拟合共享切片几何体的 `_csmSliceCornersInto`，使用已发布的分割距离）必须位于该级联阴影裁剪空间（从接收者 UBO 读取）的单位圆盘内，且位于灯光深度范围 `[0, 2R]`（从收紧投射者深度边界之前的已发布灯光视图读取）内。
- **同帧重拟合。** 未通过测试的级联会在当帧立即单独重拟合与重新渲染：计算全新拟合，每个失败级联的相机、接收者 UBO 槽位、静态层、数组层拷贝及动态叠加层一并推进，方式与分摊相同。仍通过测试的级联保持其贴图、相机与变换不变。
- **全量重拟合。** 活跃相机更换（按对象身份，从上次拟合所针对的相机 `CsmTaskState._lastCamera` 读取：`_projRev` 是逐相机计数器，两个相机可能拥有相同修订号）、相机投影修订号变更（fov、near/far、正交边界）或有效宽高比变更都会重拟合所有级联，因为分割或切片形状已改变。灯光、内容、投射者及定时间隔触发的原因不变。
- **分摊发布。** 由分摊重拟合在拟合后一两帧才发布的级联，若期间相机移动过则会先重新拟合，确保相机移动期间发布的每个级联都与其展示时的相机姿态相拟合。
- **调度器。** 在分摊仍等待渲染某个级联时若该级联覆盖测试失败，则会超出每帧预算立即重新渲染它，并通过内部调度器的 `claim()` 将其从待处理集合中移除，避免分摊流程二次渲染该级联。
- **浮动原点（Floating origin）。** 在浮动原点模式下，相机视图-投影矩阵是相对于眼睛的（`getViewMatrix`），因此纯平移不会移动任何切片角点；此时该选项回退为在每次相机变化时重拟合所有级联。
- **接收者回调。** `onCsmReceiverUpdate` 回调保持与未开启该选项时相同的每帧触发节奏：每当相机的变更键变化时，都会使用当前接收者数据调用回调，即使该帧未重绘任何级联（消费方据此重新上传其自身依赖相机的项）。静止相机仅在发布级联的帧调用回调，与未开启该选项时一致。

此机制保证的范围：在每帧结束后，按上述规则每个级联的贴图都包含相机当前该级联切片的八个角点，从而包含整个（凸）切片。这与一次全新的无边距稳定拟合所达到的水平一致（纹素对齐会使其到达圆盘约 1.0005 处），而非更严格的水平。它不保证覆盖圆盘边缘的 5×5 PCF 采样足迹，也不保证覆盖交叉淡入淡出带：位于切片最后 `cascadeBlendPercentage` 区间内的片元会采样该切片之外的下一级联，启用此选项时该过渡带会比全新拟合时更深入地伸入下一级联的贴图中。

`createCsmRefitGate` 暴露了纯 CPU 的分区/重拟合状态机，供需要相同策略而不依赖引擎或 WebGPU 的消费方使用。分摊调度器及其漂移分类属于内部缓存编排细节。重新传入一个包含相同投射者成员的新数组不会使缓存失效。

### 接收者 UBO 布局（`_shadowUBO`，320 字节 / 80 f32）

| 偏移 (f32) | 字段 | 类型 |
| ------------ | ------------------- | -------------------------------------------------------------- |
| 0..63 | `cascadeTransforms` | `array<mat4x4, 4>` |
| 64..67 | `viewFrustumZ` | `vec4<f32>` |
| 68..71 | `frustumLengths` | `vec4<f32>` |
| 72..75 | `shadowsInfo` | `vec4<f32>`（darkness, mapSize, 1/mapSize, frustumEdgeFalloff） |
| 76..79 | `csmParams` | `vec4<f32>`（cascadeCount, cascadeBlendFactor, 0, 0） |

`cascadeBlendFactor = cascadeBlendPercentage === 0 ? 10000 : 1 / cascadeBlendPercentage`。
未使用的级联槽位（当 `numCascades < 4` 时）永远不会被读取——WGSL 循环上界是烘焙进着色器的级联数量。

### 阴影贴图纹理

`depth32float`，尺寸为 `mapSize × mapSize × numCascades`，用途为 `RENDER_ATTACHMENT | TEXTURE_BINDING`，启用静态缓存时附加 `COPY_DST`。私有静态缓存使用 `RENDER_ATTACHMENT | COPY_SRC`。接收者视图：`dimension:"2d-array"`。逐级联投射者渲染目标使用单层视图（`createView({dimension:"2d", baseArrayLayer:i, arrayLayerCount:1})`）。比较采样器：`compare:"less"`，线性过滤。

内建材质接收者通过各自材质管线绑定生成器的内部纹理和采样器。自定义 `ShaderMaterial` 接收者仅通过 `getCsmReceiverTexture` 获取等价的借用 `Texture2D`；原始 `GPUTexture`、`GPUTextureView` 和 `GPUSampler` 句柄绝不会越过该公共边界。

## 管线配置

- **投射者通道：** N 个纯深度渲染任务（每个级联层一个），各自通过材质家族的_无颜色_视图渲染每个投射者，将层清除为深度 1.0 并设置 `depthCompare:"less-equal"`。逐级联相机外观携带级联视图矩阵 + **经偏移调整**的 ortho·view 变换。传统 `bias` 提供既有的归一化投影偏移。当存在 `worldSpaceBias` 时，它先将拟合远平面延长该距离，再将编写的世界空间距离转换为逐级联裁剪偏移 `worldSpaceBias / (paddedFar-near)`。当移动的灯光或投射者改变拟合的级联深度范围时，物理分离距离保持恒定，且远界处的投射者在偏移后仍留在裁剪体内。
- **静态缓存投射者通道：** 调用 `enableCsmStaticCache` 后，每个级联拥有一个针对私有缓存的清零静态任务以及一个针对实时贴图的非清零动态任务。重拟合帧渲染静态任务，将完整的缓存数组拷贝至实时贴图，随后将动态叠加层深度测试写入该拷贝之上。仅叠加层变更的帧在绘制动态投射者之前会重复该拷贝，以确保移动后的阴影不会残留过期深度。既无重拟合也无动态变更的帧既不执行通道也不执行拷贝。
- **接收者通道：** 每个 CSM 灯光对应一个 Group-2 绑定组 = `[arrayDepthView, comparisonSampler, csmUBO]`（绑定顺序 0,1,2）。2d-array 视图维度由着色器组合器生成（`bglEntry` 将包含 `"array"` 的 `_textureType` 映射为 `viewDimension:"2d-array"`）。

## 着色器逻辑（WGSL 概览）

接收者，每个 CSM 灯光（后缀 `_<lightIndex>`，`N` = 烘焙的级联数）：

```wgsl
// cascade select from camera-view-space depth, LH
let viewZ = (scene.view * vec4(vp, 1.0)).z;
var idx = -1; var diff = 0.0;
for (var i = 0; i < N; i++) {
    diff = csmInfo.viewFrustumZ[i] - viewZ;
    if (diff >= 0.0) { idx = i; break; }
}
if (idx < 0) { idx = N - 1; }

var shadow = csmSample(idx, vec4(vp, 1.0));      // PCF5 on layer idx
// optional cross-fade into next cascade
let ratio = clamp(diff / csmInfo.frustumLengths[idx], 0.0, 1.0) * csmInfo.csmParams.y;
if (idx < N - 1 && ratio < 1.0) {
    shadow = mix(csmSample(idx + 1, vec4(vp, 1.0)), shadow, ratio);
}
shadowFactors[lightIndex] = shadow;
```

`csmSample(layer, worldPos)`：

```wgsl
let p = csmInfo.cascadeTransforms[layer] * worldPos;
let clip = p.xyz / p.w;
let uv = vec2(0.5*clip.x + 0.5, 0.5 - 0.5*clip.y);   // Lite Y-flip convention
let depthRef = clamp(clip.z, 0.0, 0.99999994);        // GREATEST_LESS_THAN_ONE
// 5×5 PCF (9 textureSampleCompareLevel taps, /144 weighting)
// textureSampleCompareLevel(csmTex, csmComp, base + offset, layer, depthRef)
return computeFallOff(mix(darkness, 1.0, sh), clip.xy, frustumEdgeFalloff);
```

`0.99999994` 的钳位非常关键：投影到某级联远平面之外的片元必须严格**小于**已清零的阴影贴图值（1.0），才能被判定为**受光**而非处于阴影中。

`vp` 是既有的世界位置 varying。Standard CSM 在片元着色器中直接从 `scene.view × vec4(vp, 1)` 推导相机视图空间深度。它不能依赖仅用于雾效的 `vf` varying，从而使无雾 CSM 材质在组合时无需保留雾效 WGSL 或要求雾效生成的顶点输出。同时 CSM 也避免了发射 N 个逐级联的灯光空间 varying。

## CSM 数学（`csm-shadow-task-hooks.ts`）

### 分割（`_computeCsmCascades`）

`near = camera.near`，`far = camera.far`，`cameraRange = far - near`，
`maxDistance = shadowMaxZ < far && shadowMaxZ >= near ? min((shadowMaxZ-near)/cameraRange, 1) : 1`，
`minZ = near`，`maxZ = near + maxDistance*cameraRange`，`range = maxZ-minZ`，`ratio = maxZ/minZ`。
对于 `p = (i+1)/N`：`log = minZ*ratio^p`，`uniform = minZ + range*p`，
`d = lambda*(log-uniform) + uniform`。
`viewFrustumZ[i] = d`；`breakDist[i] = (d-near)/cameraRange`；
`frustumLengths[i] = (breakDist[i]-prevBreak)*cameraRange`。

### 逐级联矩阵

1. 求**反向 Z（reverse-Z）**相机视图-投影矩阵（`getViewProjectionMatrix`）的逆矩阵。将 8 个反向 Z NDC 视锥角点（**近平面 z=1，远平面 z=0**）变换到世界空间。
2. 切片 `[prevSplit, split]`：`corner[k] = near + ray*prevSplit`，`corner[k+4] = near + ray*split`，其中每条边 `ray = far - near`。
3. 质心（Centroid）= 8 个切片角点的平均值。
4. 拟合灯光空间 AABB：从质心沿 `lightDir` 构建临时 `LookAtLH`（`buildLightViewMatrix`），变换角点，取最小/最大边界范围。（若启用 `stabilizeCascades` 则改用 `ceil(radius*16)/16` 的包围球。）
5. 阴影相机视点 = `centroid + lightDir * minExtents.z`；级联视图 = `buildLightViewMatrix(lightDir, eye)`。
6. Z 范围：`viewMinZ = 0`，`viewMaxZ = extents.z`，随后收紧至投射者在级联视图空间中的世界 AABB Z 范围（`depthClamp=false` 行为：当 `castersMinZ <= viewMaxZ` 时，`viewMinZ = min(0, castersMinZ)`，`viewMaxZ = min(extents.z, castersMaxZ)`）。v1 使用 `depthClamp = false`，因此不需要 GPU depth-clip 特性。若存在正的 `worldSpaceBias`，则将 `viewMaxZ` 延长相同距离，使最远处的已拟合投射者在偏移后不被裁剪。
7. `ortho = OrthoOffCenterLH(minX,maxX,minY,maxY, viewMinZ, viewMaxZ)`（列主序，半 Z，近→0 远→1 — 与 PCF 生成器的阴影正交投影约定一致）。
8. `transform = ortho · view`。**纹素对齐（始终应用）：** 投影世界原点（`transform[12], transform[13]`），乘以 `mapSize/2`，四舍五入，构建取整偏移量的 XY 平移矩阵，`transform = (T·ortho) · view`。
9. 接收者 `cascadeTransforms[i] = transform`（未偏移）。投射者相机视图-投影在其 Z 行加上 `clipOffset·w`，其中对于传统归一化偏移 `clipOffset = bias·0.5`，对于世界空间偏移则为 `worldSpaceBias / (paddedViewMaxZ-viewMinZ)`。即使投射者 AABB 拟合改变了深度范围，后者在世界单位上依然保持恒定不变。

## 状态机 / 生命周期

`createShadowTask`（场景拥有）驱动通用钩子：
`_preloadShadowTask` → 加载无颜色材质视图工厂。
`_ensureShadowTaskState` → 一次性构建 N 个逐层渲染目标 + 相机 + 任务；它们与生成器同寿命，后续投射者变更会被协调合并进去（参见下方投射者协调）。
`_renderShadowMap` → 每帧基于 `casterVersion + lightVersion + cameraVersion`、宽高比以及相机身份（`CsmTaskState._lastCamera`，因为两个相机可以共享同一变更键）进行脏检查；重新计算分割与矩阵，写入 320 字节 UBO（递增 `_version`），更新每个级联相机，并执行所有级联任务。

启用静态缓存后，动态导入的 `csm-shadow-cache.ts` 拥有 GPU 任务拆分，而 `csm-refit-gate.ts` 拥有投射者分区与重拟合决策。仅在重新渲染某个级联静态层并重绘其叠加层的帧中，该级联的矩阵、接收者 UBO 槽位与阴影相机版本号才会改变：包括重拟合帧中的每个级联（对于漂移重拟合则分摊在后续几帧中），以及在启用 `cascadeCoveragePadding` 且门控决定不重拟合的帧中，其贴图不再覆盖相机的那些级联。纯动态帧复用已发布的相机，使缓存深度与叠加层深度保持在同一坐标系中。静止的动态投射者仅在重拟合期间降级。发生变化的静态投射者会立即提升并强制触发该次重拟合。已解析的可渲染对象在任务集合之间转移时无需重建其逐网格数据包。缓存状态（任务、缓存纹理、门控）在首次 ensure 时创建（或替换在缓存分包加载前构建的默认状态）并保留至生成器生命周期结束；其初始相机键强制新缓存纹理在使用前先被填充。投射者变更会像默认状态一样协调合并到缓存状态中。缓存还会从其静态任务中移除已删除和被暂挂的投射者，并将每个门控判定为静态的重新入队投射者从动态叠加层移回静态任务，因此材质被重建或重指向、或级联上限改变的静态投射者仍保持静态。离开集合后又返回的投射者对门控而言是全新的（门控会遗忘离开的投射者），因此它会像任何新投射者一样从动态集合起步。任何移除或重新入队都会强制触发一次全量重拟合，使所有静态级联在不保留旧深度的情况下重新渲染（被重新限制级联上限的投射者其深度会立即从超过新上限的级联中消失）；当有投射者入队时，调度器的记录还会重新绑定每个静态任务。除了重新入队投射者自身的数据包外，该次重拟合与重绑定即为投射者变更的全部开销：没有任何任务、目标、缓存纹理或保留的投射者数据包会被重新创建。

自定义接收者纹理包装器是惰性且作用域限定于生成器的。首次调用 `getCsmReceiverTexture` 会校验 CSM 技术、创建数组视图并缓存包装器。它同时在共享引用计数池中锚定生成器的纹理所有权；接收者材质可以获取和释放该包装器而不会销毁生成器拥有的深度数组。后续调用保留对象与视图身份。当前固定的生成器配置不支持阴影贴图重建；因此该包装器在生成器的 GPU 资源随场景销毁之前始终有效。

一旦至少完成过一次级联更新，`onCsmReceiverUpdate` 会立即向后来的订阅者重放最近发布的 80-float UBO。这在缓存模式下是必需的，因为下一次重拟合可能发生在很远的未来。

每个 CSM 任务状态还会对每个投射者的最大级联数与可渲染代数（`Mesh._renderableGen`），以及对每个接收材质的终端投射材质、该材质的 `_csmGen` 及其 `_renderFeatures` 对象做快照。每次 ensure 都会通过 `_reconcileCsmCasters` 将它们与实时投射者进行协调：

- **重新入队（Requeue）。** 离开集合或被修改上限的投射者、自身可渲染对象被重建的投射者以及无颜色视图已过时的投射者，会以每个任务单遍的方式从所有级联任务中移除，其数据包在帧栅栏后退役。仍在集合中的投射者会重新入队：视图过时的投射者通过新视图入队，仅被修改上限或重建的投射者通过其材质的缓存视图入队。当投射者的 `_renderableGen` 移动时即表示其可渲染对象被重建：每条重建网格可渲染对象并退役其逐网格资源的路径都会推进它（材质切换排空、运行时构建、材质或组重建），而投射者的数据包可能引用这些资源。仅该投射者会重新入队：新增一个使用共享材质的网格或替换单个网格的几何体，都不会触及该材质其他投射者的数据包。当投射者的材质自快照以来被重建（`_csmGen` 递增）、重新计算了 `_renderFeatures`（材质插件会丢弃它们并逐个重建网格；已丢弃但尚未重新计算的特性保留当前视图）或被重指向（`setShadowCasterMaterial`），或者当投射者的材质在快照中缺失时（因为它切换了材质、首次获得材质或以未见过的新材质加入），该视图即视为过时。新加入的投射者同样计入：另一个投射者的链可能在终端材质重建前缓存过其视图，且该投射者可能在同一 ensure 中离开或被重指向，从而使清理保留了那个视图（见下文）。其所属材质家族没有无颜色视图的投射者，会像首次构建时那样直接通过其自身材质入队。所有其他数据包均被保留，任务、目标与相机（在静态缓存模式下还有缓存纹理与重拟合门控）亦均保留。
- **暂挂（Hold）。** 发生变更的投射者在其视图尚无法构建时会处于等待状态：其材质家族的无颜色视图工厂尚未导入（对于重新提供的集合，生成器在导入期间暂停一次），或它投射所通过的材质自身在此场景中尚无已完成的组构建（其切换排空或运行时构建会提供一个）。暂挂按投射者独立生效：其他变更的投射者会立即重新入队（仅材质被重建的投射者通过新视图入队），且投射者集合变更在此期间照常生效。`setShadowCasterMaterial` 覆盖材质不会为其组而暂挂；录制它时会与此前一样抛出异常。协调器会保留被暂挂的投射者（`_held`）：只要它们未发生变化，使用相同投射者数组且无过时材质的 ensure 会直接返回而不触碰任何任务。当数组发生变化、投射者材质被重建或重指向、或者暂挂状态变化或解除时（即便没有场景版本号递增，如工厂导入到达或变更被撤销），协调器会再次运行。仅可渲染版本或材质纪元移动本身不改变任何状态：已重建的投射材质会推进其 `_csmGen`，已重建的投射者会推进其 `_renderableGen`，扫描逻辑会读取这两个值。
- **被暂挂的投射者绘制什么。** 什么都不绘制。它会离开所有级联任务（以及静态缓存任务），其数据包在帧栅栏后一次性退役。那些数据包是通过其先前的材质构建的，可能引用已随该材质退役的逐网格资源——这可能发生在生成器暂停期间阴影任务未观测到的帧里。已注册的被暂挂投射者保留其上限条目，且其材质不被写入快照，因此它仍被视作已变更：一旦暂挂解除，它会通过新视图重新入队；若其变更被撤销，则会重新加入。新加入的投射者保持在任务外直到可以加入为止。暂挂按材质判定，因此使用被暂挂材质的所有投射者都会等待：若让其中一个新的入队，就会把该材质写入快照，从而导致共享该材质的已注册投射者永远无法重新入队。移除操作会强制触发重绘，使被暂挂投射者上次渲染的深度在下次绘制时从贴图中清除。它仅在进入暂挂状态时被移除一次：后续仍将其保持在暂挂状态的协调无需再次移除。
- **无材质的投射者。** 没有数据包的无材质投射者像被暂挂的投射者一样等待：包括暂挂解除后变成无材质的、无材质加入的或首次构建时即无材质的投射者（在入队前它不会获得上限条目；首次构建会以它们初始化 `_held`）。在无材质状态下被重新设置上限的投射者同样等待：由于其上限已改变，其数据包在此时被移除。一旦被分配了材质——哪怕是快照已经认识的材质（否则会被误判为未变化并在重复提供同一投射者数组期间永久遗漏）——它就会立即入队。已有数据包的投射者在其材质变为 `null` 且上限未变时，会保留其数据包（见下文）。
- **未覆盖情况。** 遗忘过时链的视图可能会留下某个未变环节的两个视图：另一个通过它绘制的活跃投射者（重指向材质的新目标，或新加入投射者链中的某个环节）会将数据包保留在旧视图上，而过时链上的投射者会获得一个新视图。两者皆合法。已注册但材质变为 `null` 的投射者会继续通过其旧数据包投射。从未完成构建的组会使投射者保持暂挂并被排除在级联之外，直到其材质被重新分配或离开集合：例如在失败的运行时构建之后（该构建会自行报告错误），或对于位于场景之外的投射网格（它不会得到构建）。在生成器暂停期间切换材质又切换回来的投射者，若切回操作仍排队在某个进行中的运行时构建之后，则会保留其数据包：扫描会看到相同的材质和 `_csmGen`（无暂挂时也会发生此情况）。

阴影调度器在其下一次 record 中解析已入队的投射者，每个级联执行一次事务，在不重建保留数据包的情况下重新绑定它们。由于无论是新的投射者数组还是重指向都不会递增场景版本号，协调器会在有投射者被移除或入队时强制重绘（`_lastCasterVersion = -1`），并仅在有投射者入队时强制录制（`_recordedVersion = -1`）：仅移除操作本身已经过滤了绑定列表。如果该次录制抛出异常，被替换的投射者将缺席级联，直到后续录制成功。在同一变更路径上，材质快照与视图会被清理至仅保留活跃投射者可达的对象（它们的接收材质及 `_shadowCasterMaterial` 链上的每一环），因此状态不会滞留已离开投射者的材质。清理在入队之后运行，并保留活跃链可达的每个视图，因此全新视图依赖于过时规则：若某个材质之后再次参与投射（期间可能通过非投射网格被重建），它在快照中缺失，因此其链上的视图会先被遗忘。带有相同成员、上限与未变材质的新数组——即便同时有投射者保持暂挂——仅被直接采纳：绑定列表不变，因此所有级联渲染束与绑定版本均被保留，且没有投射者使用的已重建材质不会引起任何变化。

## Babylon.js 等价映射表

| Babylon.js | Babylon Lite |
| --------------------------------------- | ------------------------------------------- |
| `CascadedShadowGenerator._splitFrustum` | `_computeCsmCascades`（分割部分） |
| `_computeFrustumInWorldSpace` | 反向 Z 视锥角点提取 + 切片 |
| `_computeCascadeFrustum` | 质心 + 灯光空间 AABB / 包围球拟合 |
| `_computeMatrices`（ortho + snap） | `orthoOffCenterLH` + 纹素对齐块 |
| `computeShadowWithCSMPCF5` | `csmSample_<i>`（PCF5，数组层） |
| `lightFragment.fx` 中的级联选择 | `computeShadowCSM_<i>` 循环 + 混合 |
| `GREATEST_LESS_THAN_ONE` | `0.99999994` depthRef 钳位 |

为使一致性成立，对 BJS 参考场景对称地应用了两项刻意偏离默认 BJS 的设定：**反向 Z（reverse-Z）** NDC（Lite 的投影约定）与 **depthClamp = false**（避免依赖可选的 `depth-clip-control` WebGPU 特性）。两者均体现在参考场景中（`sg.depthClamp = false`）。结果：全图 MAD = 0.000。

## 打包体积纪律（不影响无关场景）

共享修改严格控制到最小字节数：

- `shadow-generator.ts`、`standard-renderable.ts` 中的 TS 联合类型拓宽 `"esm" | "pcf"` → 添加 `"csm"`（仅类型层面，0 运行时字节）；PBR/Node 可渲染对象过滤掉 CSM 灯光（v1 中它们忽略 CSM）。
- 三个接收者可渲染对象中的 `_depthView` 字段切换（函数调用 → 字段读取）。
- `standard-group-builder.ts` 中一处受 `hasCsm` 门控的 `std-csm-shadow-fragment.ts` 动态导入。
- `shader-composer.ts` 的 `bglEntry` 新增 `"array"` → `"2d-array"` 视图维度支持（在共享材质分包中仅占几个字节；远低于上限）。

所有级联数学逻辑与 WGSL 均位于四个新模块中，仅由创建了 CSM 生成器的场景动态导入。

静态缓存编排与重拟合门控位于 `enableCsmStaticCache` 执行的动态导入之后。因此默认 CSM 场景不会拉取缓存任务拆分、转移辅助函数或门控代码。

## 依赖项

`shadow-base`（`buildLightViewMatrix`、`multiply4x4`、`createShadowCamera`、`updateShadowCameraBase`、`createShadowParamsUBO`、`casterVersionSum`）、`pcf-shadow-task-hooks`（`getNoColorView`、`preloadPcfShadowTaskState`）、`math/invert-mat4`、`camera`（`getViewProjectionMatrix`）、`frame-graph/render-task`、`csm-refit-gate`。

## 测试规范

`tests/lite/parity/scenes/scene214-cascaded-shadows.spec.ts` — 捕获 BJS CSM 参考图像（`captureGolden({ force: true })`）并与 `scene214.html`（6×6 Standard 立方体投射者 + Standard 地面接收者，4 级联 CSM）的 Lite 渲染结果进行对比。阈值为 `scene-config.json` 中的 `maxMad`（实测达成 MAD = 0.000）。

`tests/lite/unit/csm-world-space-bias.test.ts` 验证逐级联裁剪偏移在不同拟合深度范围内能映射回相同的编写世界空间距离、在投影预留偏移余量后仍保留紧密拟合的远端投射者，且对无效或退化输入不产生偏移。

`tests/lite/unit/csm-receiver-texture.test.ts` 验证公共自定义接收者适配器创建一个显式的 2d-array 深度包装器、复用生成器纹理与比较采样器而不将其暴露在签名中、保留包装器身份、在 ShaderMaterial 获取/释放周期后依然有效，并拒绝 ESM/PCF 生成器。

`tests/lite/unit/shadow-caster-max-cascade.test.ts` 校验上限输入、默认与重置行为，以及在实时修改上限后将现有投射者原地重新分配到各级联任务中（入队，伴随一次强制录制）。

`tests/lite/unit/csm-caster-material-switch.test.ts` 使用每个用例独立的新鲜模块（防止视图工厂在用例间泄漏）驱动真实的阴影任务、`mesh.material` setter、切换排空、`rebuildMaterial` 与任务事务。对于默认与静态缓存钩子，它证明：已注册投射者切换到（或首次获得）未见过的材质时，会在相同级联任务中通过该材质重新入队，仅退役其旧数据包并保留缓存纹理与重拟合门控；带有未见过材质的新投射者直接入队；被暂挂的投射者既不抛错也不创建任何资源并使生成器暂停一次；在暂挂期间集合变更与其他投射者的重新入队照常生效，同时被暂挂投射者保持在所有任务之外并保留其上限；当暂挂随版本号或不随版本号解除、或变更被撤销时（在上限未变时回到另一投射者仍在绘制的材质缓存视图上），被暂挂投射者重新加入。组未构建的覆盖材质仍会抛出异常。对于拥有资源且其逐网格资源被 `rebuildMaterial` 或切换排空退役的数据包，它证明：当另一个投射者被暂挂时，被重建的投射者会在栅栏后一次性退役其旧数据包并通过新视图立即重新投射——哪怕历经多帧构建从未到达的暂挂，也不会有任何绘制提交已释放资源或触碰任何渲染束；先前材质被重建的被暂挂投射者同样会被移除；在暂挂期间切换又撤销的投射者会重新以旧材质投射；对于在生成器暂停期间切换了材质的被暂挂投射者，无论它随后是在等待视图工厂（使其 ensure 再次暂停生成器的那次通道仍正常绘制）还是在等待其组，都不会有绘制提交其已释放资源。未解决的暂挂帧不会改动任何任务的渲染束与绑定版本，也不退役任何资源；待处理的投射者或上限会在组构建到达或（无版本递增的）工厂导入到达时一次性应用。

`tests/lite/unit/csm-caster-reconcile.test.ts` 证明：被重建或重指向的投射材质保留级联任务（在静态缓存下也保留缓存纹理），仅使用在覆盖链间共享的一个新视图重新入队该材质的投射者；将新增投射者直接入队到已录制的级联中而无需逐投射者重新绑定任务；在同一协调中既重新入队已重建投射者又暂挂组未构建的新加入投射者（并在构建到达时使用同一投射者数组将其入队）；以每个任务单次批次选择移除过时投射者（未包含它们的任务保持不动）；仅移除操作只强制重绘；遗忘没有任何活跃投射者可达的材质与视图（因此重指向后重建的原覆盖终端材质在有投射者携其加入时会获得新视图）；当曾缓存终端视图的链在同一 ensure 中失去其投射者或被重指向时，为携已重建覆盖终端材质加入的投射者提供新视图（在两套钩子中均如此）；忽略非投射材质与相同成员的重复传入（包括当加入中或已注册投射者保持暂挂时：在两套钩子中均无录制、重绘或静态重拟合）；将被重指向且缺少家族工厂的投射者保持在所有任务之外（保留其他数据包，且暂挂不变时不再次触碰任何任务）；将静态缓存投射者（被重建或重设上限）重新入队到其当前类别的任务集合中同时保留其他数据包；将所属家族无无颜色视图的投射者通过其自身材质重新入队；在最后一个被暂挂投射者加入或其变更被撤销后，对同一投射者数组恢复静默（在两套钩子中均无渲染束清除、退役或新视图）；并且通过真实阴影调度器在阴影贴图渲染前发布替换数据包。

`tests/lite/unit/csm-refit-gate.test.ts` 校验稳定重传、版本和冲突处理、提升/降级时机、角度漂移以及定时间隔重拟合。

`tests/lite/unit/csm-static-refit-scheduler.test.ts` 校验分摊预算、轮询顺序与最大滞后，以及 `claim()` 仅移除一个待处理级联并使下一轮分摊维持预算。

`tests/lite/unit/enable-csm-static-cache.test.ts` 进一步校验 `cascadeCoveragePadding` 默认为 0、有效时正确存储，以及在 `[0, 1]` 之外、低于 `2 / mapSize` 或未启用 `stabilizeCascades` 时被拒绝。

`tests/lite/unit/csm-camera-coverage-refit.test.ts` 驱动真实的缓存渲染、级联拟合、弧形旋转相机与方向光（仅桩化 GPU 任务）并统计静态重渲染次数。它证明：未开启该选项时绕轨旋转每帧重渲染全部级联，开启后相同旋转的重渲染次数显著减少；每帧结束后已发布的贴图均满足覆盖规则（通过从接收者 UBO 与阴影相机重新实现该规则来校验，从而能捕获被绕过的测试而非错误规则），覆盖有无定时间隔下限、沿灯光方向滑动的相机，以及带随机种子的往复偏航跳跃（延迟发布分摊级联）；纹素按边距系数加宽；静止相机仅承担定时间隔下限开销；覆盖未命中仅重渲染未命中的级联一次，其余保留其相机矩阵；视场角变化、切换到与前一个相机共享投影修订号的相机或浮动原点都会重拟合所有级联，且未开启该选项时切换到与前一个相机共享变更键的相机仍会重拟合所有级联一次。它还检查接收者回调在与无该选项时一致的每个相机键变化帧触发，且静止相机不会在默认路径之外额外触发回调。

`tests/lite/unit/csm-default-camera-swap.test.ts` 驱动真实的默认（未缓存）`renderCsmShadowMap`，并证明切换到与前一个相机共享变更键和宽高比的相机时，会将所有级联重新拟合至新相机的分割位置一次。

`tests/lite/unit/csm-static-spread-camera-ownership.test.ts` 驱动真实缓存完成跨越多帧的漂移分摊重拟合，并证明尚未重新渲染的级联保留渲染其静态层时所用的相机矩阵，且在分摊排空期间每个动态叠加层都使用其静态层的矩阵进行绘制。

`tests/lite/unit/light-version.test.ts` 校验直接的标量灯光变更可以在不弄脏世界矩阵的情况下递增灯光 UBO 版本号。

## 文件清单

- `shadow/csm-directional-shadow-generator.ts` — 公共工厂函数、自定义接收者 `Texture2D` 适配器、更新订阅以及纹理/UBO/采样器所有权。
- `shadow/csm-shadow-task-hooks.ts` — 级联数学 + N 层投射者渲染钩子。
- `shadow/csm-shadow-cache.ts` — 动态加载的静态缓存 GPU 编排。
- `shadow/csm-refit-gate.ts` — 不依赖 GPU 的静态/动态分区与重拟合策略。
- `shader/fragments/csm-shadow-fragment-core.ts` — 接收者 WGSL 代码生成。
- `material/standard/fragments/std-csm-shadow-fragment.ts` — Standard 家族包装器。
- `lab/lite/src/lite/scene214.ts`、`lab/lite/scene214.html` — Lite 演示场景。
- `lab/lite/src/bjs/scene214.ts`、`lab/lite/babylon-ref-scene214.html` — BJS 参考场景。
- `reference/lite/scene214-cascaded-shadows/babylon-ref-golden.png` — Golden 参考图。
