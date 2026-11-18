# 模块：大世界渲染（Large World Rendering / LWR / 浮动原点）

> 包路径：`packages/babylon-lite/src/large-world/floating-origin.ts`

## 目的

大世界渲染（Large World Rendering，LWR）使引擎能够渲染远离世界原点（约 1e5 米及以上，直至行星尺度）的坐标，而不会出现该量级下顶点变换管线中常见的 F32 抖动。当引擎上设置了 `useFloatingOrigin: true` 时，每一帧都会捕获活动相机的世界位置作为“浮动原点”偏移量，所有 GPU 上传都会在隐式存储为 F32 *之前* 从世界空间平移中减去该偏移量。随后顶点着色器在 F32 精度绰绰有余的小量级相对视点坐标上运算，而引擎在 CPU 端以 F64 维护精确的世界位置。

LWR 依赖于高精度矩阵基底（`36-high-precision-matrix.md`）：从已经退化为 F32 的世界平移中减去一个 F64 精度的视点偏移量无法恢复任何精度——低位精度在上游已经丢失。因此 `useFloatingOrigin: true` 要求同一引擎上必须同时启用 `useHighPrecisionMatrix: true`；若违反此先决条件，`createEngine` 会同步抛出异常。

## 公共 API 接口

### 引擎选项（`engine/engine.ts`）

```typescript
export interface EngineOptions {
    /** When true, every scene on this engine uses the floating-origin
     *  (eye-relative upload) trick to render large-world coordinates without
     *  F32 jitter. Requires `useHighPrecisionMatrix: true` — throws
     *  synchronously if set without it. Defaults to false.
     *
     *  LWR is engine-wide: all scenes created against this engine inherit
     *  the mode. The LWR runtime module (`large-world/floating-origin.js`)
     *  is dynamically imported during `createEngine` only when this flag is
     *  true, so non-LWR engines never pull the module into their bundle. */
    useFloatingOrigin?: boolean;
}
```

### 只读偏移量访问器（`large-world/floating-origin.ts`）

```typescript
/** Read the current floating-origin offset from a scene as a `Vec3`.
 *  Returns the live offset (camera world position when FO is on).
 *  For non-LWR engines this function is never reachable because the
 *  module is not imported. */
export function getFloatingOriginOffset(scene: SceneContext): Vec3;
```

## 内部架构

### 动态导入门控

`createEngine` 仅在 `useFloatingOrigin: true` 时导入 `floating-origin.ts`：

```typescript
if (useFO) {
    const [{ wrapRenderableForFO, lightFoVersion, applyLightFoOffset }, { makePackMeshWorld }] = await Promise.all([
        import("../large-world/floating-origin.js"),
        import("../large-world/pack-mat4-with-offset.js"),
    ]);
    _wrapRenderableForFO = wrapRenderableForFO;
    _makePackMeshWorld = makePackMeshWorld;
    _lightFoVersion = lightFoVersion;
    _applyLightFoOffset = applyLightFoOffset;
}
```

每个引用都保存在引擎上（`engine._wrapRenderableForFO`、`_makePackMeshWorld`、`_lightFoVersion`、`_applyLightFoOffset`）。使用方通过带非 FO 回退的可选链访问它们，例如 `engine._makePackMeshWorld?.(scene) ?? packMat4IntoF32`。非 LWR 引擎让所有这些字段保持 `undefined`，因此 FO 运行时的任何使用方都不会静态导入该模块。Tree-shaker 会将其从非 LWR 打包产物中完全剔除。该行为由 `tests/parity/bundle-size.spec.ts` 体积上限验证。

### 读取偏移量（`getFloatingOriginOffset`）

浮动原点偏移量**就是**活动相机的世界位置；场景侧没有它的镜像副本。每个使用方在需要使用时推导它：

```typescript
export function getFloatingOriginOffset(scene: SceneContext): Vec3 {
    const cam = scene.camera;
    if (!cam) {
        return { x: 0, y: 0, z: 0 };
    }
    const w = cam.worldMatrix;
    return { x: w[12]!, y: w[13]!, z: w[14]! };
}
```

早期设计曾通过每帧调用 `updateFloatingOriginOffset` 来同步 `scene._floatingOriginOffset` / `_floatingOriginVersion` / `_eyePosition`。该设计因有净成本却无收益而被移除：这个镜像不仅每帧都要写入，读取还要经过额外一层间接访问，仅仅是为了保存一个相机本身已经携带的值。现在失效机制直接搭载在相机自身的 `worldMatrixVersion` 上（见下文）。

### 应用偏移量的四个位置

1. **`getViewMatrix(camera)`**（`camera/camera.ts`）：当设置了 `camera._useFloatingOrigin` 时，在 `-(R_inv * cameraPos)` 计算产生视图平移之前，相机位置分量会被替换为零（`const cx = useFO ? 0 : w[12]!`，`cy`/`cz` 同理）。这里不做减法——偏移量本身*就是*相机位置，因此在 FO 下视图平移按构造就精确为零。因此视图矩阵通过纯精度打包器 `packMat4IntoF32` 上传；若让它走带偏移的打包器反而会把平移错误地偏移两次。

2. **网格世界矩阵 UBO 上传**（`material/{standard,pbr,node}-renderable.ts`）：每个 renderable 在构造时通过 `engine._makePackMeshWorld?.(scene) ?? packMat4IntoF32` 解析一次其打包器，之后无论哪种情况都以相同的四个参数调用它——`(view, mat, offsetFloats, srcOffsetFloats)`。在 FO 下它解析为 `makePackMeshWorld(scene)`（`large-world/pack-mat4-with-offset.ts`），其 `packMat4IntoF32WithOffset` 从平移列 `[12..14]` 中减去由相机推导出的偏移量。减法在 JS 数值精度（F64）下于隐式 F32 存储之前执行，从而以完整精度保留了小余数。

3. **`vEyePosition` uniform**（`frame-graph/scene-uniforms-pack.ts`）：由 `_writePassSceneUBO` 调用的 `_packSceneUniforms` 在设置了 `engine.useFloatingOrigin` 时向 `data[32..34]` 写入字面零，否则写入原始相机世界位置。它不执行减法，也不读取偏移辅助函数。零是正确的视点位置，因为网格世界平移已经由第 (2) 步重新定基，因此 `vEyePosition - input.worldPos` 形式的着色器表达式在双方都处于小量级坐标系时能以全精度产生相对视点向量。

4. **ShaderMaterial 系统 uniform**（`material/shader/shader-renderable.ts`）：ShaderMaterial 写入自己的 UBO，而不经过 `packMat4IntoF32`，因此无法继承第 (2) 步的减法。取而代之的是 `_shaderWorldMatrix(mesh, camera, out?)` 来执行该减法，返回 `mesh.worldMatrix` 的一个相机相对副本，而 `world`、`worldView` 和 `worldViewProjection` 均由此衍生——它们必须共享同一个坐标系，否则读取不同 uniform 的通道会发生撕裂。基于与第 (3) 步中 `vEyePosition` 相同的原因，`cameraPosition` 写入为零。两个写入路径共享该辅助函数，因此启用 `enable-shader-material-uniform-caching.ts` 只会改变 UBO 序列化的频率，而不会改变其内容。`LineMaterial` 底层是 ShaderMaterial，也走同一条路径。

    这一处以 `camera._useFloatingOrigin` 而非引擎标志作为判断依据，从而使这里的测试与 `getViewMatrix` 对*同一台*相机应用的逻辑逐位一致。使用非场景相机进行绘制的渲染目标任务随后会同时获得未平移的视图**以及**绝对世界矩阵，保持自洽。

### 逐 renderable 版本跟踪

网格 UBO 编码的是 `worldMatrix - foOffset`。其内容取决于**两个独立输入**：网格移动（递增 `mesh.worldMatrixVersion`）或者相机移动（导致偏移量变化）。与其在每个 renderable 闭包中内联第二个版本检查，不如把相机检查放在一个仅在 FO 开启时应用的包装器中：

```typescript
export function wrapRenderableForFO(inner: () => void, scene: SceneContext, invalidate: () => void): () => void {
    let _lastCameraVersion = -1;
    let _lastCamera: Camera | null | undefined;
    return (): void => {
        const cam = scene.camera;
        const cv = cam ? cam.worldMatrixVersion : -1;
        if (cv !== _lastCameraVersion || cam !== _lastCamera) {
            invalidate();
            _lastCameraVersion = cv;
            _lastCamera = cam;
        }
        inner();
    };
}
```

`invalidate()` 将 renderable 的 `_lastWorldVersion` 重置为 -1，强制内部更新中的“worldMatrix 已更改”分支触发并使用新的偏移量重新打包。Renderable 通过 `engine._wrapRenderableForFO?.(_baseUpdate, scene, _invalidate) ?? _baseUpdate` 选择加入，因此非 LWR 引擎直接透传裸更新函数，既无包装器开销，也不会把 FO 版本跟踪打包进共享闭包。

如果没有这个机制，相机移动（会改变偏移量但*不会*改变 `mesh.worldMatrixVersion`）就会使每个网格 UBO 继续保留过时的 `world - oldOffset` 字节，表现为所有网格每帧出现位移错乱。

相机对象身份也是键的一部分，因为 `worldMatrixVersion` 是逐相机的计数器：将 `scene.camera`（直接赋值或通过 `addToScene(scene, camera)`）替换为处于另一位置的未修改相机时，可能会报告相同的版本号。所有从活动相机偏移量派生的缓存都遵循同一规则——每当相机身份或版本变化时，`lightFoVersion` 都会推进一个逐场景的单调计数器（单调键不会与累加的灯光版本号相互抵消），并且 PCF/ESM 阴影门控也会连同版本一起存储浮动原点相机。

### 场景状态

LWR 不在 `SceneContext` 上存储镜像字段：偏移量就是活动相机的世界位置，按需读取，而失效机制搭载在该相机的身份和 `worldMatrixVersion` 上。因此非 LWR 场景不携带任何惰性的全零偏移/版本状态。

`scene/scene-core.ts` 确实保留了 LWR 生命周期，并且是其唯一写入方。在 `_update` 内部，`syncCameraFloatingOrigin` 会在两个时机双向同步活动相机的标志与引擎设置：一次在 `onBeforeRender` 回调之前，使它们针对已安装相机所读取的 `getViewMatrix`/`getViewProjectionMatrix` 处于引擎渲染的坐标系中；另一次在回调之后（回调可能会安装新相机），在任何预通道、uniform 更新器或录制读取视图之前：

```typescript
const cam = scene.camera;
if (cam && !cam._useFloatingOrigin !== !fo) {
    cam._useFloatingOrigin = fo;
    cam._viewVer = -1;
    cam._projFov = undefined;
}
```

一台相机可能是全新进入场景（标志未设置），也可能是从模式相反的引擎迁移而来（`removeFromScene` + `addToScene`，或直接赋值），因此该模式属于目标场景的属性，而非相机历史的属性。标志翻转会重置视图缓存并清除投影快照，这与全新相机一样会重新武装 `_cameraChangeKey`：其下一次调用会推进 `_projRev`，从而使视图-投影缓存以及每一个变化键消费者——场景 UBO、文本 MVP、CSM、TAA——在同一帧内重写，而不是复用在另一坐标系下打包的条目。位于关闭 FO 的引擎上的新相机始终保持该标志未设置，因此非 LWR 场景不会触发翻转。

## 验证

- 单元测试：`tests/unit/floating-origin.test.ts` 覆盖偏移读取与生命周期——`getFloatingOriginOffset` 返回活动相机的世界位置并在无相机时返回零，以及 `scene._update` 仅在引擎开启 FO 时为 `camera._useFloatingOrigin` 打上标记。
- 单元测试：`tests/unit/camera-floating-origin-mode.test.ts` 驱动真实的 `_update`、`addToScene`/`removeFromScene` 和 `_writePassSceneUBO`：已安装的远距离相机在其首个 `onBeforeRender` 回调内就暴露出相对视点的视图和视图-投影矩阵；从 `onBeforeRender` 中安装的全新远距离相机在第一帧和后续帧都上传 FO 视图；从开启 FO 的场景移动到关闭 FO 的场景的相机上传绝对视图；而切回开启 FO 时即使相机变换和投影均未改变也会重写场景 UBO。
- 单元测试：`tests/unit/floating-origin-upload.test.ts` 覆盖置零与精度恢复路径——`getViewMatrix` 在 `_useFloatingOrigin` 下将视图平移置零（配合关闭 FO 的大量级对照组），`packMat4IntoF32WithOffset` 将位于世界坐标 `1e6 + delta` 的网格的 `delta` 精确写入 F32 视图，以及相对视点为零的 `vEyePosition` 写入。
- 单元测试：`tests/unit/shader-material-floating-origin.test.ts` 在行为层面覆盖偏移点 (4)——将相机朝固定网格移动时，投影深度和屏幕跨度必须按真实距离比例变化，`world`/`worldView`/`worldViewProjection` 必须保持在同一坐标系，且视点在 FO 下位于原点而在无 FO 时位于其真实位置。关闭 FO 的用例作为对照：若没有对照，仅把平移置零的错误实现也会通过测试。
- 一致性测试：`tests/parity/scenes/scene200-fo-off.spec.ts` 和 `scene201-fo-on.spec.ts` 在关闭 FO 与开启 FO 下渲染同一个远离原点的场景。两次捕获**必须存在差异**（跨基准图 MAD ≥ 5.0），证明偏移路径已介入并显著改变了像素结果。
- 打包体积：关闭 HPM 的打包产物不包含 LWR 模块；开启 LWR 的打包产物为每个场景增加约 1-2 KB 的 FO 逻辑。

## Tree-shaking 证明

该模块在源码树中只有一条静态边：`index.ts` 从中重新导出 `getFloatingOriginOffset`。这条边是可 tree-shake 的——从未导入该访问器的场景会丢弃它——且该导出仅包含访问器本身，不包含 FO 运行时。

其余所有部分均通过动态路径到达。运行时的消费者访问的是关闭 FO 时保持 `undefined` 的引擎字段（`engine._wrapRenderableForFO?.(...)`、`engine._makePackMeshWorld?.(...)`），这些是属性访问而非模块导入；而 `createEngine` 中的 `await import(...)` 位于 `if (useFO)` 分支内部，当任何可达场景中都未将 `useFloatingOrigin` 设为 true 时，打包器即可证明其不可达。因此非 LWR 打包产物既不包含该访问器，也不包含运行时。这已通过打包体积上限得到验证。

## 文件 / 体积

| 文件                                                                               | 用途                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `large-world/floating-origin.ts` (~70 行)                                          | `getFloatingOriginOffset` 公共读取、`wrapRenderableForFO`、灯光 FO 辅助函数 |
| `engine/engine.ts`（`createEngine` 中的 FO 代码块）                                | 动态导入门控、`useFO && !useHpm` 校验                                       |
| `large-world/pack-mat4-with-offset.ts`                                             | `makePackMeshWorld` —— 在 F32 存储时减去偏移量的网格世界矩阵打包器          |
| `camera/camera.ts`（`_useFloatingOrigin?` 标志、`getViewMatrix` 置零）             | FO 下将视图平移置零                                                         |
| `scene/scene-core.ts`（`syncCameraFloatingOrigin`，位于回调前后）                  | 双向同步 `camera._useFloatingOrigin`；重置 `_viewVer`，重新武装 `_projRev`  |
| `material/{standard,pbr,node}-renderable.ts`（打包器选择、FO 包装器）              | 相机移动时使网格 UBO 失效                                                   |
| `frame-graph/scene-uniforms-pack.ts`（`_packSceneUniforms`）                      | FO 下写入 `vEyePosition = (0, 0, 0)`                                        |
| `math/pack-mat4-into-f32.ts`（`packMat4IntoF32`）                                  | 纯精度打包器；非 FO 回退路径以及视图矩阵路径                                |

## 已接入的特性

除基础部分（网格世界矩阵、视图矩阵、视点位置）外，以下特性也会减去活动相机偏移量，从而在远离原点的尺度下保持精度。每个特性都有成对的一致性测试场景（Lite `useFloatingOrigin` 对比 BJS `useLargeWorldRendering`）：

- 点光源 + 聚光灯位置（灯光 UBO 偏移烘焙）—— 场景 202、203。
- 精简实例（Thin-instance）逐实例世界矩阵 —— 场景 204。
- 精灵 / 公告板精灵（两条上传路径上的锚点偏移烘焙）—— 场景 205（面向透明）、206（镂空/不透明）。
- 阴影光照空间矩阵（PCF 方向光/聚光灯 + ESM 方向光生成器以相对视点方式构建灯光视图/投影矩阵，使投射通道和接收器着色器与相对视点的网格世界矩阵保持一致）—— 场景 207。
- NodeMaterial 网格世界变换（NME 将 `worldViewProjection` 解析为 `sceneU.viewProjection * meshU.world`，其中 `meshU.world` 按 FO 打包为相对视点矩阵）—— 场景 208。
- Havok 物理：**多区域浮动原点**（显式启用）。调用 `enableHavokFloatingOrigin(world)`（按需加载）会使 `physics/havok.ts` 在以刚体附近为中心的区域（局部坐标接近零）中模拟刚体，使 float32 Havok 求解器在远离原点尺度下保持精度；节点变换仍保持真实世界坐标，相对视点渲染路径不变。当刚体跨越区域边界时会在区域间迁移（保留速度并带有 20% 的滞回余量），镜像了 Babylon.js 的 `scene.floatingOriginMode` + Havok 插件 `floatingOriginWorldRadius`。通过 `setPhysicsGravity` 的可选 `worldPosition` 参数支持逐区域重力 —— 场景 209。

## 超出范围

有三个特性在 `useLargeWorldRendering` 下的 **Babylon.js 本身就是退化的**，因此没有正确的远离原点参考可供对齐，Lite 有意不接入它们：

- 裁剪平面（Clip planes）：Babylon.js `BindClipPlane`（`Materials/clipPlaneMaterialHelper`）通过普通的 `setFloat4` 上传平面（没有偏移偏置），而着色器针对相对视点的 `worldPos` 计算 `dot(worldPos, n) + d`。原始世界空间的 `d`（≈ −offset·n）会裁剪掉整个场景——Babylon.js 在远离原点时渲染结果全黑。
- 分簇点光源（Clustered point lights）：`Lights/Clustered/clusteredLightContainer` 将原始世界光源位置打包进灯光数据纹理而不做偏移；着色器用它们与相对视点的 `posW` 作差，因此每个分簇光源都变得等效于无穷远而没有任何贡献。
- 背景地面 / 天空盒材质：Babylon.js 在 `useLargeWorldRendering` 下使 `vEyePosition` 变为相对视点（≈0），但针对 OPACITYFRESNEL 路径仍把 `BackgroundMaterial.sceneCenter`（→ `vBackgroundCenter`）留在世界原点（仅对 REFLECTIONFRESNEL 做了偏移）。地面衰减项 `dot(normalW, normalize(vEyePosition - vBackgroundCenter))` 退化为 `normalize(0)`，导致地面渐隐至完全透明。（`createDefaultEnvironment` 用户应将环境保持在原点附近。）

- 粒子：不适用 —— Lite 没有粒子系统。
- 矩形面光源、级联阴影贴图、边缘/包围盒渲染器、工具层/Gizmo：不适用 —— Lite 尚未实现这些特性。Babylon.js 为它们接入了浮动原点；当其中任意特性移植到 Lite 时，浮动原点偏移**必须**随之一起移植（见 `GUIDANCE.md` → "Large World Rendering — Feature Parity"）。

这些扩展会直接接入已由上述特性使用的同一套基底（逐帧版本跟踪、打包器偏移路径、场景状态）。
