# 矩形面光源（Rectangular Area Lights）

`RectAreaLight` 为 PBR 和 Standard 材质提供纯色或纹理化的矩形面光源。与 Lite 中的其他灯光一样，它是一个独立于场景的状态对象：先创建、修改其属性，然后再将其添加到场景中。

```typescript
import {
    addToScene,
    createEngine,
    createFreeCamera,
    createPbrMaterial,
    createRectAreaLight,
    createSceneContext,
    createSphere,
    enableRectAreaLights,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.camera = createFreeCamera({ x: 0, y: 2, z: -6 }, { x: 0, y: 1, z: 0 });

const sphere = createSphere(engine);
sphere.position.y = 1;
sphere.material = createPbrMaterial({
    baseColorFactor: [0.8, 0.2, 0.1, 1],
    metallicFactor: 0.5,
    roughnessFactor: 0.25,
});
addToScene(scene, sphere);

const light = createRectAreaLight([0, 2, 3], 4, 2, 3);
light.diffuse = [1, 1, 1];
light.specular = [1, 1, 1];
addToScene(scene, light);

await enableRectAreaLights(scene);
await registerScene(scene);
await startEngine(engine);
```

## 朝向、尺寸与材质

- `createRectAreaLight(position, width, height, intensity = 1)` 接收一个 `[x, y, z]` 位置坐标。`width` 和 `height` 是灯光局部 X/Y 平面上的非负**完整尺寸（full dimensions）**，而不是半尺寸或世界空间包围盒范围。宽度或高度为零会产生一个不发光的退化光源。
- 未旋转的发射器会照亮其**局部 −Z** 方向的一侧，+Z 背面不会发光。可通过修改 `light.rotationQuaternion` 来调整照射方向；也可以像其他场景节点一样编辑 `light.position`、`light.scaling` 或 `light.parent`。父节点的旋转和非均匀缩放同样会影响该矩形区域。灯光本身不会绘制出可见面板：如果希望看到光源实体，请单独添加一个自发光网格。
- `diffuse`、`specular`、`intensity`、`width` 和 `height` 均为可变状态。PBR 使用 `metallicFactor`、`roughnessFactor` 和 `baseColorFactor`；Standard 材质则使用 `diffuseColor`、`specularColor` 和 `roughness` 来进行 LTC 查找。Standard 材质的 `specularPower` 仍继续控制普通点光源/聚光灯的高光，不会替代面光源所使用的粗糙度。
- 矩形面光源可与点光源、平行光、聚光灯及半球光共存；常规的灯光选择规则依然适用。

## 纹理化发射（Textured emission）

加载源图像并对其进行处理，然后将**处理后的** `Texture2D` 赋值给 `light.emissionTexture`。这会改变受光材质上的照明分布；仅仅把纹理贴到一个自发光面板上并不会产生光源效果。

```typescript
import { addToScene, createRectAreaLight, enableRectAreaLights, loadTexture2D, processAreaLightTexture, registerScene, startEngine } from "@babylonjs/lite";

// engine, scene, camera, and receiver meshes are set up as in the example above.
const source = await loadTexture2D(engine, "https://raw.githubusercontent.com/SergioRZMasson/TemporaryAssetsRepo/refs/heads/main/Textures/Cyberpunk_AI_Square.png", {
    srgb: false,
});
const processed = await processAreaLightTexture(engine, source);
const light = createRectAreaLight([0, 2, 3], 4, 2, 3);
light.emissionTexture = processed;
addToScene(scene, light);

await enableRectAreaLights(scene);
await registerScene(scene);
await startEngine(engine);
```

`processAreaLightTexture(engine, source): Promise<Texture2D>` 是与 Babylon.js `AreaLightTextureTools.processAsync(source)` 对等的独立函数。它会生成一张单独的 1024×1024 RGBA8 纹理，包含 11 级逐级模糊的 mipmap，并采用三线性钳位（trilinear clamp）采样。它不会修改源纹理的采样器，也不会转移源纹理的所有权。请勿直接赋值原始图像：初始化阶段会拒绝未经处理、无效、已释放或属于其他设备的发射纹理。

加载源纹理时请使用 `{ srgb: false }`，以便与 Babylon.js 在显示 RGB 字节空间中的处理保持一致；开启硬件 sRGB 解码会改变灯光发射结果。`loadTexture2D` 对光栅图像的默认参数本身就与 Babylon.js 的 Y 轴方向、线性过滤及 mipmap 生成相匹配。对于参考场景请保持这些默认设置，不要额外叠加 V 轴翻转。处理输出是一份不可变的发射快照：它的 UV 变换字段不会作为发射器变换生效，修改源像素也不会自动更新它。

### 注册后的所有权与变更

- 源纹理和处理结果各自拥有独立的、由调用方持有的纹理引用。不再需要时请使用公开的 `releaseTexture(texture)` 释放该引用；切勿自行销毁底层的 GPU 资源。
- 处理过程不会保留对源纹理的持久引用。如果没有其他地方使用源纹理，你可以在处理完成后将其释放。如果有可见面板也使用了源纹理，则通过该材质的注册来维持其引用即可。
- `light.emissionTexture` 属于**借用（borrowed）**状态，而非所有权转移。多个灯光及克隆灯光可以共享同一个处理后的纹理。成功调用 `enableRectAreaLights(scene)` 后，该场景快照会保留其所选中的处理后纹理，因此调用方随后可以释放自己持有的结果引用。场景销毁时会释放场景持有的引用；不会释放仍由应用或其他场景持有的引用。
- 运行时修改灯光位置、旋转、缩放、尺寸、颜色和强度都会照常实时更新。但若替换或清空 `emissionTexture`，或更改灯光列表/顺序，则需要重新执行准备流程并重建可渲染对象。在进行这些变更前请先暂停正在运行的引擎，避免渲染出灯光槽位与纹理绑定不一致的中间状态：

```typescript
import { enableRectAreaLights, rebuildSceneRenderables, startEngine, stopEngine } from "@babylonjs/lite";

stopEngine(engine);
light.emissionTexture = null; // Return this emitter to solid-color illumination.
await enableRectAreaLights(scene);
await rebuildSceneRenderables(scene);
await startEngine(engine);
```

若要更换发射图像，请重新处理更新后的源纹理、赋上新结果，然后依次 `await` 上述相同的准备与重建流程。请勿直接修改处理后纹理的像素，也不要尝试复用已释放的句柄。每一份由调用方持有的引用（包括替换贴图时）都应成对释放一次。

## 初始化与网络要求

请在 **`registerScene(scene)` 之前调用并 await `enableRectAreaLights(scene)`**。该显式启用步骤会准备好材质支持并上传与 Babylon.js 完全一致的线性变换余弦（LTC）查找表；在初始化以及首帧渲染完成之前，请勿将场景标记为就绪。

首次初始化需要访问以下资源：

```text
https://assets.babylonjs.com/core/areaLights/areaLightsLTC.bin
```

请确保在应用的网络 / CSP 策略中允许该 HTTPS 源以及你的发射图像所在源，并为图像解码开启 CORS。该查找表数据是外部资产，而非发射纹理。加载、预处理或初始化失败时对应的 Promise 会被拒绝（reject）；请直接向上抛出或展示错误，而不要渲染处于半就绪状态的场景。在声明场景就绪前，请务必 await 每一个发射纹理处理操作、LTC 准备、场景注册以及首帧渲染完成。

当前里程碑支持**纯色及经处理的纹理化发射**。尚不支持面光源阴影、发射纹理序列化以及导入序列化的 Babylon.js 场景；有阴影需求时请配合使用受支持的非面光源阴影灯。分层 PBR 材质（Layered PBR materials）暂不支持矩形面光源。带光照的 Node Material 节点图也暂不支持矩形面光源；初始化会直接拒绝此类组合，而不会静默渲染出错误画面。

## 参考场景

| 场景                                                                | 来源 / 覆盖范围                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [316 PBR](https://github.com/BabylonJS/Babylon-Lite/blob/master/lab/lite/src/lite/scene316.ts)                      | 上游 `areaLightsPBRMaterial`，Playground [`#T7FXR8#12`](https://playground.babylonjs.com/#T7FXR8#12)。                           |
| [317 Standard](https://github.com/BabylonJS/Babylon-Lite/blob/master/lab/lite/src/lite/scene317.ts)                 | 上游 `areaLightsStandardMaterial`，Playground [`#T7FXR8#67`](https://playground.babylonjs.com/#T7FXR8#67)。                      |
| [318 Transforms and Materials](https://github.com/BabylonJS/Babylon-Lite/blob/master/lab/lite/src/lite/scene318.ts) | 缩放/旋转的父节点、灯光局部旋转、混合灯光、背面剔除，以及白色/带色调的电介质与金属对比组。                                       |
| [319 Textured Standard](https://github.com/BabylonJS/Babylon-Lite/blob/master/lab/lite/src/lite/scene319.ts)        | 上游 `Textured - Area Lights - Standard Material`，Playground [`#T7FXR8#103`](https://playground.babylonjs.com/#T7FXR8#103)。    |
| [320 Textured PBR](https://github.com/BabylonJS/Babylon-Lite/blob/master/lab/lite/src/lite/scene320.ts)             | 上游 `Textured - Area Lights - PBR`，Playground [`#T7FXR8#102`](https://playground.babylonjs.com/#T7FXR8#102)。                  |

其中的金属/反照率对比组覆盖了 [Babylon.js PR #16723](https://github.com/BabylonJS/Babylon.js/pull/16723) 所修复的回归问题。

场景 316/317 完整保留了上游的相机姿态、受光几何体、材质参数、彩色发射器变换以及面板父子关系。仅在**两个**引擎中对称省略了用于诊断的 `AxesViewer` 坐标轴箭头。Lite 的自由相机与上游 FlyCamera 的初始视角一致；交互式漫游不在对比范围内。Standard 材质会忽略原片段中动态赋值的 `metallic`，因此这些无实际作用的赋值未作移植。在场景 318 中，Babylon.js 参考实现为发射器的局部偏航角使用了一个子 TransformNode，因为其灯光本身没有局部四元数属性；Lite 则直接将该旋转存储在灯光的 `SceneNode` 上。参考面板也直接继承该子变换，而非 Babylon.js 灯光未平移的子坐标系；其世界空间位置与 Lite 中挂载在灯光下的面板完全一致。

场景 319/320 保留了上游值为 2 的面板缩放、灯光尺寸与强度、父变换、受光几何体、相机姿态以及原始图像 URL。它们的源码片段对应当前 Babylon.js 可视化测试项（参考图分别为 `textureAreaLightStandard.png` 和 `texturedAreaLightsPBR.png`）。场景 319 使用 `Cyberpunk_AI_Square.png`；场景 320 则分别使用了来自[上游资产目录](https://github.com/SergioRZMasson/TemporaryAssetsRepo/tree/main/Textures)的 `White.png`、`Cyberpunk3_AI_Square.png` 和 `Grey.png` 贴图。同样仅对称省略了诊断坐标轴。Standard 片段中动态赋值的 `metallic` 和 `albedoColor` 在 Babylon.js 中本就没有效果，因此两个引擎都保留了默认的白色漫反射色；其实际粗糙度值仍为 0.2 和 0.9。

对应的 Babylon.js 参考实现位于 `lab/lite/src/bjs/scene316.ts` 至 `scene320.ts`。这五个场景均为静态场景，并在初始化完成后设置 `canvas.dataset.ltcReady`，在首帧完成后设置 `canvas.dataset.ready`。纹理化场景还会在所有发射贴图处理完成后设置 `canvas.dataset.emissionReady`。它们的一致性测试只读取已提交的不可变黄金截图；测试运行时绝不会跳转访问 Babylon.js 参考页面或重新生成图片。

在 [Lite Playground](https://liteplayground.babylonjs.com) 中，选择 **Lights — Textured area light** 即可运行一个使用根级 API 的精简示例，其中包含彩色发光效果以及可选的源图像面板。
