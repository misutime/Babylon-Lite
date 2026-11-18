# 模块：右手坐标系

> 包路径：
>
> - `packages/babylon-lite/src/engine/coordinate-system.ts`（默认变体，左手坐标系）
> - `packages/babylon-lite/src/engine/coordinate-system-rh.ts`（`babylon-lite-rh` 变体）

## 目的

让应用能够在 Babylon.js 的右手坐标系（`scene.useRightHandedSystem = true`）下进行渲染，以替代 Lite 默认的左手坐标系，同时不让左手坐标系应用付出任何额外字节或运行时判断开销（配合像 Rolldown 这样能内联导入常量的压缩器；参见[为什么选择构建期配置](#为什么选择构建期配置)）。

包含各打包器配置说明的用户指南：[Right-Handed Coordinate System](../07-right-handed-system.md)。

## 选择坐标系手性

引擎模块从包导入路径 `#coordinate-system` 读取单个标志 `_rightHanded`（`true` 或 `null`）。`package.json` 中的 `imports` 映射会根据**打包器解析条件（resolve condition）**来解析它：

| 条件 | 变体 | 坐标系手性 |
| ---- | ---- | ---------- |
| _（无）_ | `coordinate-system.ts` | 左手坐标系 |
| `babylon-lite-rh` | `coordinate-system-rh.ts` | 右手坐标系 |

```ts
// vite.config.ts — the application is right-handed; it keeps calling createEngine.
export default defineConfig({ resolve: { conditions: [...defaultClientConditions, "babylon-lite-rh"] } });
```

其他打包器使用各自的 condition 选项：webpack 使用 `resolve.conditionNames`，esbuild 使用 `--conditions`，Rollup `@rollup/plugin-node-resolve` 使用 `exportConditions`。Vite 的 `resolve.conditions` 会覆盖默认条件，因此需要保留 `defaultClientConditions`。

整个打包产物的手性是固定的：由它创建的每一个引擎都具有相同的坐标系手性。

预打包的 CDN 文件（`dist/index.js`）使用默认变体构建，仅支持左手坐标系。

### 为什么选择构建期配置

两个变体都将 `_rightHanded` 导出为 `const`（`null` 或 `true`）。场景打包器**不会**跨模块折叠导入的常量：打包产物中仍然会保留 `_rightHanded ? … : …`，只有能看到实际值的逐 chunk 压缩器才会剔除死分支。死分支虽然会被消除，但它所*导入*的任何模块在压缩前就已经被链接进打包产物中了。左手坐标系打包产物之所以能与引入此特性前的产物字节完全一致，全靠右手分支不引入任何自身独有的导入（参见[编写依赖坐标系手性的代码](#编写依赖坐标系手性的代码)）。

这一点对 lab 使用的打包器 Rolldown 成立，因为它的压缩器会内联导入的常量；并且会逐场景进行检查。esbuild 的压缩器（0.28）不会内联它：它的左手坐标系产物会保留 `_rightHanded` 判断以及同模块内的小型右手辅助函数（`_toRightHandedCameraWorld` 等）。它们的行为完全相同，只是并非字节级完全一致。

发布版 `lib/` 模块导入的是裸标识符 `#coordinate-system`，因此需要能读取 `package.json` `imports` 字段的打包器；原生浏览器 ESM 无法解析它。预打包的 `dist/index.js` 不包含此类导入。

运行时标志无法做到这一点：在代码分包（code-split）的产物中，标志位于一个 chunk 中并被延迟加载的 chunk（PBR 管线、背景地面等）导入，没有任何打包器能证明导入的 `let` 变量永远不会被重新赋值。在 18 个 lab 场景上的实测表明，运行时标志会在每个场景增加 0–0.4 KB 原始体积（gzip 后 ≤ 0.1 KB），因此决定将选择权交给应用的打包器。

## 模型

右手坐标系引擎渲染世界的方式与左手坐标系引擎渲染沿 Z 轴镜像后的世界完全等价。令 `Sz = diag(1, 1, -1)`：

- **视图矩阵（View）** — `getViewMatrix` 返回 `Sz·V_RH`（第三行取反）。投影矩阵保持左手坐标系形式；由于 Babylon.js 的右手投影矩阵等于左手投影矩阵乘以 `Sz`，裁剪空间与 Babylon.js 的 `P_RH·V_RH` 完全一致。所有着色器看到的依然是熟悉的左手视图空间（+X 向右，+Y 向上，+Z 向前）。
- **相机世界矩阵** — 弧形旋转相机（arc-rotate）、自由相机（free）和地理空间相机（geospatial）先构建其左手 look-at 矩阵，然后原地对其 X 和 Z 基向量列取反：`W_RH = W_LH·diag(-1, 1, -1)`，使相机像 Babylon.js 中一样朝向局部 -Z，且 +X 向右。相机输入、gizmo 和 XR 也相应地将相机的前方向视为局部 -Z。
- **绕序（Winding）** — 镜像后的视图会在屏幕上反转三角形绕序，因此相机通道管线会翻转 `frontFace`：普通网格使用 `"cw"`（遵循 Babylon.js 的右手规则），并且 `std-mirrored-support.ts` 中的镜像网格规则也会反相。保留了 glTF 原生绕序（见下文）的 glTF 网格保持 `"ccw"`：图元特性用网格特性位 11（`_primitiveFeatures`）标记每个此类网格，所有材质路径都会读取该逐网格标记——PBR 通过其逐网格绕序、Standard 通过其网格特性键的第 11 位、Node 通过 `_pipelineForCcwMesh`（其可渲染对象绝不会将已标记与未标记的网格分组到一起，即使它们共享同一份几何体），而着色器材质则通过将 glTF 网格与程序化网格拆分到不同绕序的管线中（`|ccw` 变体键）来处理。该标记存储在网格自身而非共享的 GPU 几何体上：对同一 glTF 网格进行负缩放实例化的节点不会被标记并保持 `"cw"`，且几何体在设备丢失重建后仍会保留该标记。每当构建 PBR 或 Standard 可渲染对象时，按需启用的 `enableMirroredMeshes()` 会在左手构建中清除该位；在右手构建中，它会改用实时行列式重算并写入该位，从而确保从 PBR 或 Standard 迁移到 Node 或着色器材质的 glTF 网格仍保留 `"ccw"`。由于 Node 和着色器材质构建时不经过该编码器，在右手构建中该功能还会在安装时以及监视器检测到世界矩阵变化时（在同帧材质切换之前）刷新标记，并重建标记过时的网格。未启用该功能时，它们与左手构建一样直接读取加载时的标记。深度和阴影通道使用与颜色通道相同的绕序，因为光源视图也会像相机一样进行镜像。
- **glTF** — 加载器保留 glTF 原生的右手空间：`__root__` 节点不添加 X 轴镜像，`computeNodeWorldMatrix` 去掉根节点转换，骨骼和动画混合器根变换（`skeleton-pose.ts`、`skeleton-updater.ts`、`weighted-gltf-mixer.ts`）相应变为单位矩阵，glTF 相机修正保持 +X，且图元特性模块（逐网格绕序）始终加载。`Mesh._authoredSign` 保持为 `-1`：它是相对于左手规则而言的，而 `std-mirrored-support.ts` 中的右手绕序已经对其进行了反转。来自 `KHR_gaussian_splatting` 的高斯泼溅将左手体系下的 `rotation.z = π`（与根镜像组合等价于 Y 轴镜像）替换为 `scaling.y = -1`，因为此时不再有根镜像可与之组合。
- **环境光照** — PBR IBL 辅助函数（以及 mesh-LoD 拷贝）中的 `rotateY` 在旋转后对 Z 取反，类似于 Babylon.js 的 `REFLECTIONMAP_OPPOSITEZ`，作用于 radiance、irradiance、clearcoat 和局部立方体贴图。
- **无切线的法线贴图** — PBR 余切空间标架（基础法线贴图、清漆法线贴图、弯曲法线贴图、mesh-LoD 拷贝）同时反转其切线和副切线，与 Babylon.js 的 glTF 加载器一致（该加载器将 `invertNormalMapX/Y` 绑定到坐标系手性）。Standard 和 Node 材质保留各自的标架：Babylon.js 仅在显式选项下才会翻转它们。
- **其他所有模块** — 凡是从 Lite 特性可达的 Babylon.js `useRightHandedSystem` 分支都有对应实现：阴影贴图和级联阴影（cascades）的光源视图、线性深度通道、Standard 天空盒与反射（`REFLECTIONMAP_OPPOSITEZ`、球面映射）、PBR 立方体贴图天空盒（包含 IBL 天空盒模式 `IBL_SKYBOX_CALCULATION`）与背景地面、着色器材质系统 uniform（`view`、`viewProjection` 等以 Babylon.js 右手矩阵形式传给用户着色器）、导数法线视图、Node 材质的 `View`/`Projection` 输入与 PBR 辅助函数、公告牌（billboard）及公告牌拾取纹理 U 坐标、相机输入、gizmo、地理空间相机、`.babylon` 相机、glTF 相机、交互性（interactivity）相机路径、程序化天空、CSG2、Havok 网格形状、USD 根节点与法线贴图、接触阴影和 SSGI 背后的屏幕空间光线步进法线重建（其 `cross` 操作数互换，类似 cavity 背后的导数法线视图）、网格混合（mesh-blending）逆视图与投影矩阵（其深度解码对投影矩阵的 Z 列取反，使 View 深度与 Screen 深度重建出相同的引擎视图坐标点），以及 WebXR（姿态、指针、传送、手部网格、控制器模型，保持在 WebXR 原生右手空间中而不进行 Z 镜像）。
- **几何缓冲区深度** — `VIEW_DEPTH` 像 Babylon.js 的右手视图 Z 一样带有符号（相机前方为负），但 `NORMALIZED_VIEW_DEPTH` 在两种构建中均保持在 [0, 1] 区间：引擎的视图 Z 取正距离，与其用来归一化的正近/远裁剪面边界一致。（Babylon.js 右手模式返回负的归一化深度，而消费方期望 [0, 1]。）库自身的 `VIEW_DEPTH` 消费方会将有符号深度转回距离：网格混合通过其投影矩阵实现，而景深（`depthNotNormalized`）背后的弥散圆则通过对其取反实现。
- **尚未移植：`EXT_lights_image_based`** — `envYawFromQuaternion` 在两种构建中均返回左手偏航角 −A，因此右手构建沿 `Sz·Ry(−A)·d` 采样环境贴图。Babylon.js 的加载器仅在左手模式下对扩展旋转取反，即右手模式下沿 `Sz·Ry(A)·d` 采样：两者仅在 A = 0° 或 180° 时一致。仅翻转符号也未能复现 Babylon.js 在场景 265 上的右手渲染结果（irradiance 仍有差异），因此该移植保持待定，孪生场景 342（A = 90°）目前与场景 265 的左手参考结果对比（`BJS_RH_BROKEN`）。

代码对坐标系手性敏感但无需接缝的文件及其原因，列在 `tests/lite/unit/handedness-guard.test.ts` 的 `HANDEDNESS_EXEMPT` 中（正交投影、文本、glTF 图元绕序、Node 和 Standard 凹凸标架、PBR 各向异性方向——两个切线轴会同时反向，而波瓣对其呈二次关系——以及朝向观察者重新定向的平面法线）。

## 编写依赖坐标系手性的代码

- 始终从 `#coordinate-system` 导入该标志，绝不使用相对路径。
- 优先使用 `_rightHanded ? a : b`、`...(_rightHanded && { … })` 和 `if (_rightHanded !== null) { … }`。
- **右手分支绝不能导入当前文件左手代码尚未使用的任何符号。** 压缩器是在打包器链接完导入之后才移除死分支的：若引入了新符号，导入的辅助函数仍会残留在左手打包产物中（当调用方与辅助函数落在不同 chunk 时，会作为共享 chunk 的导出残留）。请将右手逻辑内联编写，或写成同一模块内的函数。否则 `right-handed-drift.test.ts` 会报错失败。
- 在 `wgsl` 标签模板内部，该标签仅压缩静态文本：请将插值的 WGSL 变体预先写成压缩格式，否则左手着色器文本会发生变化。
- 使用过滤后的场景打包检查变更：每个左手场景在 `lab/public/bundle/master-manifest.json` 中的 `rawBytes` 必须保持与 master 一致。
- 为新分支在 `right-handed-pairs.test.ts` 中添加配对测试（或添加孪生场景）；否则下方的覆盖率守卫会失败。

## 测试

四个守卫确保右手变体不会随着其他测试、场景和黄金标准图持续运行左手变体而腐化：

- **漂移守卫（Drift）** — `tests/lite/unit/right-handed-drift.test.ts` 将每个 `_rightHanded` 决策点归约为右手与左手代码之间的 token 差异，并与提交的快照比对。同步以相同方式修改两个分支会保持测试通过；仅修改左手分支则会失败并指出具体位置。对右手移植的有意修改需经审查后通过 `vitest -u` 接受。同一文件还包含泄漏守卫：不允许任何右手分支导入当前文件左手代码未使用的符号。
- **行为配对（Behavior pairs）** — `tests/lite/unit/right-handed-pairs.test.ts` 将相同输入分别送入左手和右手引擎构建（`right-handed-builds.ts` 会替换 `#coordinate-system` 模块），并断言两者结果之间满足文档规定的关系：相同拖拽后的镜像相机路径、相同的 gizmo 旋转、恰好相差所移植表达式的着色器文本、沿 X 轴镜像的骨骼世界矩阵。未同步到右手路径的左手修改会破坏这种关系。
- **覆盖率守卫（Coverage）** — `tests/lite/unit/handedness-guard.test.ts` 在以下情况报错：引擎文件包含对坐标系手性敏感的代码（`frontFace`、左手矩阵构建函数、glTF 根镜像、基于导数的切线标架）却既未导入 `#coordinate-system` 也未列入豁免；或者导入了 `#coordinate-system` 的文件既未被 `right-handed-*.test.ts` 导入，也未被 `RH_TWIN_COVERAGE` 所列的孪生场景渲染，也未在 `RH_DRIFT_ONLY` 中声明为已知缺口。
- **右手孪生场景（Right-handed twin scenes）**（`scene-config.json` 中 `"rightHanded": true`，编号 321–347） — 与开启 `useRightHandedSystem = true` 的 Babylon.js 进行一致性比对。它们的 Lite 包装器和 Babylon.js 参考仅导入源场景（参考端通过 `lab/lite/src/bjs/right-handed-twin.ts`），因此它们会随源场景的所有改动同步变化，且 CI 的影响范围筛选会将其与源场景一并运行。守卫检查它们必须保持纯粹的重跑包装。参考端规避了一个 Babylon.js 9.28 的右手 bug：`right-handed-twin.ts` 替换了未旋转 `CubeTexture` 的零折射矩阵（孪生场景 334）。孪生场景 342 暂时保留场景 265 的左手参考（`BJS_RH_BROKEN`），因为 Lite 尚未移植 `EXT_lights_image_based`（见上文）。与所有一致性 spec 一样，它们与提交的 `babylon-ref-golden.png` 比对，运行期间绝不会重新生成它（`RECAPTURE_GOLDEN` 为显式开启选项）。这些黄金图是在 CI 的 BrowserStack macOS 浏览器（即一致性任务实际渲染所用的 GPU）上从右手 Babylon.js 参考端一次性捕获的。有两个孪生场景像其源场景一样保留了源场景的黄金图：336（场景 159 的参考写入 0.10，某些 GPU 舍入为 26/255，Lite 为 25/255）和 342（其参考为场景 265 的参考，因此黄金图是 265 的副本）。
- 有两个孪生场景基于实测结果设置了比源场景更宽松的 `maxMad`：323（0.01，对比场景 13 的 0.008）实测为 0.0089，其中 Babylon.js 右手与左手差异为 0.779，Lite 为 0.782，即属于噪声差异；328（6.4，对比场景 250 的 6.1）实测为 6.21。场景 250 没有天空盒，但其 PBR 窗户会反射环境贴图，且场景 250 已知的 Lite 差异（窗户反射过亮，Babylon.js 中无此现象）随镜像视图转移到了较大的右侧塔楼上：Lite 右手与左手差异为 7.5，Babylon.js 为 5.3。

此外还有：

- `tests/lite/unit/right-handed-system.test.ts` 与 `right-handed-seams.test.ts` — 将视图矩阵与 Babylon.js `LookAtRH` 比对，并测试相机世界矩阵及各接缝值（包括着色器材质系统 uniform）。glTF 与程序化几何体在 Standard、Node 和着色器材质上的正面绕序由 `right-handed-pairs.test.ts` 中的 "glTF winding on non-PBR materials" 配对测试断言。
- `tests/lite/unit/coordinate-system-variants.test.ts` — 测试两个变体及 `imports` 映射。
- `build` 测试项目会打包已发布的 `build/lib`，其中 `#coordinate-system` 仍为裸标识符。裸 Rollup 不读取 `imports`，因此其测试夹具使用 `packageImportsPlugin()`（`tests/lite/build/bundler-harness.ts`）解析该标识符，就像 `@rollup/plugin-node-resolve` 为消费方所做的那样；webpack 则原生读取该映射。
