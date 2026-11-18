# 从 Babylon.js 迁移到 Babylon Lite

本指南展示如何将 Babylon.js (BJS) 场景逐项转换为 Babylon Lite。Babylon Lite 使用**工厂函数**取代构造函数，使用**纯数据**取代类实例，并使用显式的 `addToScene()` 取代自动注册。

> **还没准备好全面重写？可以先从 `@babylonjs/lite-compat` 开始。**
> [`@babylonjs/lite-compat`](https://www.npmjs.com/package/@babylonjs/lite-compat)
> 是一个可选的、**保持 Babylon.js 形态**的兼容层，构建在下方介绍的原生 Lite API 之上。它保留了熟悉的基于类的接口（`new WebGPUEngine`、`new Scene`、`new ArcRotateCamera`、`MeshBuilder`、`StandardMaterial`……），使现有的 BJS 场景几乎无需修改代码即可运行在 Lite 的 WebGPU 渲染器上——其打包插件（Vite / Rollup / Webpack / esbuild）甚至可以在**构建时自动重写你原有的 `@babylonjs/core`、`@babylonjs/loaders`、`@babylonjs/addons` 和 `@babylonjs/materials` 导入路径**，让你一行 import 都不用改。对于尚未支持的功能，它会抛出 `LiteCompatError`，而不会静默渲染出错。推荐的演进路径如下：
>
> ```
> @babylonjs/core  →  @babylonjs/lite-compat  →  @babylonjs/lite (native)
> ```
>
> 你可以先用 `lite-compat` 快速跑起来，再按照自己的节奏逐步迁移到本指南介绍的原生工厂函数 API（获得更小的打包体积和完整的 Tree-Shaking）。

---

## 快速参考

| Babylon.js                                                          | Babylon Lite                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `new WebGPUEngine(canvas); await engine.initAsync()`                | `const engine = await createEngine(canvas)`                                                                 |
| `new Scene(engine)`                                                 | `createSceneContext(engine)`                                                                                |
| `engine.runRenderLoop(() => scene.render())`                        | `await startEngine(engine)`                                                                                 |
| `new ArcRotateCamera("cam", α, β, r, target, scene)`                | `createArcRotateCamera(α, β, r, target)`                                                                    |
| `new FreeCamera("cam", position, scene)`                            | `createFreeCamera(position, target)`                                                                        |
| `scene.createDefaultCamera(true, true, true)`                       | `createDefaultCamera(scene)`                                                                                |
| `camera.attachControl(canvas, true)`                                | `attachControl(camera, canvas, scene)` _（弧形旋转）_ / `attachFreeControl(camera, canvas, scene)` _（自由）_ |
| `camera.mode = Camera.ORTHOGRAPHIC_CAMERA`                          | `enableOrthographicCamera(camera, { halfHeight })`                                                          |
| `Vector3.Project(point, world, scene.getTransformMatrix(), viewport)` | `projectWorldToScreen(point, view, viewProjection, options)`                                              |
| `new HemisphericLight("h", new Vector3(0,1,0), scene)`              | `createHemisphericLight([0,1,0], 1.0)`                                                                      |
| `new DirectionalLight("d", new Vector3(0,-1,0), scene)`             | `createDirectionalLight([0,-1,0])`                                                                          |
| `new SpotLight("s", pos, dir, angle, exp, scene)`                   | `createSpotLight(pos, dir, angle, exp)`                                                                     |
| `MeshBuilder.CreateSphere("s", {}, scene)`                          | `createSphere(engine)`                                                                                      |
| `MeshBuilder.CreateBox("b", {}, scene)`                             | `createBox(engine)`                                                                                         |
| `MeshBuilder.CreateGround("g", {}, scene)`                          | `createGround(engine, opts)`                                                                                |
| `new StandardMaterial("mat", scene)`                                | `createStandardMaterial()`                                                                                  |
| `new PBRMaterial("pbr", scene)`                                     | `createPbrMaterial()`                                                                                       |
| `new GridMaterial("grid", scene)` _(@babylonjs/materials)_          | `createGridMaterial(opts)`                                                                                  |
| `SceneLoader.ImportMeshAsync("", url, file, scene)`                 | `addToScene(scene, await loadGltf(engine, url))`                                                            |
| `new CubeTexture(url, scene)` + `createDefaultEnvironment()`        | `await loadEnvironment(scene, url, opts)`                                                                   |
| `new Texture(url, scene)`                                           | `await loadTexture2D(engine, url)`                                                                          |
| 从已解码图像新建纹理                                                | `await createTexture2DFromExternalImage(engine, source, options)`                                           |
| KTX1 压缩 2D 纹理                                                   | `await loadKtxTexture2D(engine, baseUrl, suffixes)`                                                         |
| glTF KTX2 / `KHR_texture_basisu` 纹理源                             | `addToScene(scene, await loadGltf(engine, ktx2GltfUrl))` _（自动检测）_                                     |
| Basis Universal (.basis) 2D 纹理                                    | `await loadBasisTexture2D(engine, url)`                                                                     |
| `new ShadowGenerator(size, light)`（平行光 + ESM）                  | `createEsmDirectionalShadowGenerator(engine, light, opts)`                                                  |
| `sg.usePercentageCloserFiltering = true`（聚光灯）                  | `createPcfSpotlightShadowGenerator(engine, light, opts)`                                                    |
| `sg.usePercentageCloserFiltering = true`（平行光）                  | `createPcfDirectionalShadowGenerator(engine, light, opts)`                                                  |
| `mesh.thinInstanceSetBuffer("matrix", data, 16)`                    | `setThinInstances(mesh, data, count)`                                                                       |
| `mesh.thinInstanceSetBuffer("color", data, 4)`                      | `setThinInstanceColors(mesh, data)`                                                                         |
| `new Vector3(x, y, z)`                                              | `{ x, y, z }` 或 `[x, y, z]`                                                                                |
| `new Color3(r, g, b)`                                               | `[r, g, b]`                                                                                                 |
| `Matrix.Identity()`                                                 | `createIdentityMat4()`                                                                                      |
| `mesh.dispose()`                                                    | `removeFromScene(scene, mesh)`                                                                              |
| `scene.onBeforeRenderObservable.add(fn)`                            | `onBeforeRender(scene, fn)`                                                                                 |

---

## 核心差异

对于矩形发射器，请参阅[矩形面光源](06-area-lights.md)。
使用 `createRectAreaLight(position, width, height)` 创建灯光，将其添加到场景中，并在 `registerScene(scene)` 之前 await `enableRectAreaLights(scene)`。
尺寸为局部空间完整边长；光线沿局部 **-Z** 方向发射。

### 1. 构造函数中不再传入 Scene

BJS 对象会在构造函数中接收 `scene` 并自动注册。Lite 对象则是纯数据——先创建，再显式调用 `addToScene()`。

```typescript
// ❌ Babylon.js
const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);

// ✅ Babylon Lite
const light = createHemisphericLight([0, 1, 0], 1.0);
addToScene(scene, light);
```

### 2. 引擎与渲染循环

BJS 使用带回调函数的 `runRenderLoop`。Lite 使用单个 `startEngine(engine)`，返回一个在首帧渲染完成后 resolve 的 Promise。

```typescript
// ❌ Babylon.js
const engine = new WebGPUEngine(canvas);
await engine.initAsync();
const scene = new Scene(engine);
// ... setup ...
engine.runRenderLoop(() => scene.render());

// ✅ Babylon Lite
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
// ... setup ...
await startEngine(engine);
```

### 3. 纯数据，而非类

Lite 使用普通对象、数组和 `Float32Array`，而不是 `Vector3`、`Color3`、`Matrix` 等 BJS 类。

```typescript
// ❌ Babylon.js
light.direction = new Vector3(0, -1, 0);
light.diffuse = new Color3(1, 0, 0);

// ✅ Babylon Lite
const light = createDirectionalLight([0, -1, 0]);
light.diffuse = [1, 0, 0];
```

### 4. 相机控制相互分离

BJS 相机将 `attachControl` 作为实例方法提供。Lite 将相机数据与输入处理解耦。

```typescript
// ❌ Babylon.js
const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 5, Vector3.Zero(), scene);
camera.attachControl(canvas, true);

// ✅ Babylon Lite
const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
scene.camera = camera;
attachControl(camera, canvas, scene);
```

#### 将世界坐标点投影到画布或 CSS 像素

Babylon.js 的 `Vector3.Project` 返回渲染像素，把可见性检查与 CSS 缩放留给调用方处理。Lite 的通用辅助函数直接返回后备缓冲区像素、CSS 像素、反向 Z（reverse-Z）NDC 深度，以及明确的 behind/clipped/offscreen 标志：

```typescript
import {
    getFloatingOriginOffset,
    getEffectiveAspectRatio,
    getViewMatrix,
    getViewProjectionMatrix,
    projectWorldToScreen,
    resolveCameraViewport,
} from "@babylonjs/lite";

const backingWidth = canvas.width;
const backingHeight = canvas.height;
const projection = projectWorldToScreen(
    worldPoint,
    getViewMatrix(camera),
    getViewProjectionMatrix(camera, getEffectiveAspectRatio(camera, backingWidth, backingHeight)),
    {
        viewport: resolveCameraViewport(camera, backingWidth, backingHeight),
        backingWidth,
        backingHeight,
        worldOrigin: engine.useFloatingOrigin ? getFloatingOriginOffset(scene) : undefined,
        cssWidth: canvas.clientWidth,
        cssHeight: canvas.clientHeight,
    }
);

if (!projection.clipped) {
    overlay.style.transform = `translate(${projection.cssX}px, ${projection.cssY}px)`;
}
```

该投影辅助函数本身不依赖 DOM。使用 `OffscreenCanvas` 时，请传入可见宿主画布的 CSS 尺寸。开启大世界渲染（Large World Rendering）时，`worldOrigin` 会将绝对 CPU 坐标重基准化到相机矩阵所使用的眼相对坐标系中。若每帧需要投影大量点位，请配合复用的结果对象使用 `projectWorldToScreenToRef`。

鼠标按键行为也可以直接迁移，无需应用自行编写轨道旋转或平移计算。默认配置依然为主键旋转、次键平移；当应用采用不同的交互习惯时，可以分别设置任意按键映射：

```typescript
attachControl(camera, canvas, scene, {
    pointerMappings: {
        primaryButton: "pan",
        secondaryButton: "rotate",
    },
});
```

该映射同时适用于鼠标与手写笔按键。触控仍保持单指旋转与双指捏合缩放，滚轮输入仍保持缩放。

### 5. 加载器与场景注册

`loadEnvironment()` 会在内部直接将环境数据/可渲染对象添加到场景。`loadGltf()` 则返回一个资产容器；将其传入 `addToScene()`，即可显式注册其中的变换节点层级、网格和动画组。

```typescript
// ❌ Babylon.js
await SceneLoader.ImportMeshAsync("", baseUrl, "model.glb", scene);
scene.environmentTexture = new CubeTexture(envUrl, scene);
scene.createDefaultEnvironment({ createSkybox: true, skyboxSize: 1000 });

// ✅ Babylon Lite
addToScene(scene, await loadGltf(engine, "model.glb"));
await loadEnvironment(scene, envUrl, {
    skyboxUrl: "skybox.dds",
    skyboxSize: 1000,
    groundTextureUrl: "ground.png",
    brdfUrl: "/brdf-lut.png",
});
```

资产容器会完整保留 glTF 节点层级：每个 glTF 节点对应一个变换节点（TransformNode），每个图元（primitive）是挂在其下的一个网格；而 Babylon.js 对单图元节点会合并返回一个 `Mesh`。通过 `@babylonjs/lite-compat` 访问时，`ImportMeshAsync(...).meshes` 是该层级的扁平化视图，因此重新挂接已加载网格的父级时请使用 `setParent()`，不要直接给每一项赋值 `.parent`，否则从 glTF 节点继承的变换将会丢失。详见[glTF 导入层级与重新设父节点](https://github.com/BabylonJS/Babylon-Lite/blob/master/packages/babylon-lite-compat/README.md#gltf-import-hierarchy-and-reparenting)。

### 6. 阴影挂载在灯光上

BJS 单独创建一个 `ShadowGenerator`。Lite 则直接把它赋值给灯光。

```typescript
// ❌ Babylon.js
const sg = new ShadowGenerator(1024, light);
sg.addShadowCaster(mesh);
sg.useBlurExponentialShadowMap = true;
ground.receiveShadows = true;

// ✅ Babylon Lite
light.shadowGenerator = createEsmDirectionalShadowGenerator(engine, light, {
    mapSize: 1024,
    depthScale: 50,
    blurScale: 2,
});
setShadowTaskCasterMeshes(light.shadowGenerator, [mesh]);
ground.receiveShadows = true;
await registerSceneWithShadowSupport(scene);
```

对于 PCF 阴影：

```typescript
// ❌ Babylon.js
const sg = new ShadowGenerator(1024, spotLight);
sg.usePercentageCloserFiltering = true;

// ✅ Babylon Lite
spotLight.shadowGenerator = createPcfSpotlightShadowGenerator(engine, spotLight, {
    mapSize: 1024,
});
setShadowTaskCasterMeshes(spotLight.shadowGenerator, [mesh]);
await registerSceneWithShadowSupport(scene);
```

### 7. Thin Instances 使用原始数组

无需 `Matrix` 类。直接传入每个实例占 16 个浮点数的原始 `Float32Array`。

```typescript
// ❌ Babylon.js
const matrices = new Float32Array(count * 16);
// ... fill with Matrix values ...
mesh.thinInstanceSetBuffer("matrix", matrices, 16);
mesh.thinInstanceSetBuffer("color", colors, 4);

// ✅ Babylon Lite
const matrices = new Float32Array(count * 16);
// ... fill directly (column-major 4x4) ...
setThinInstances(mesh, matrices, count);
setThinInstanceColors(mesh, colors);
addToScene(scene, mesh);
```

### 8. 网格工厂接收 Engine，而非 Scene

BJS 的网格构建器接收 `scene`。Lite 的网格工厂接收 `engine`（用于创建 GPU 缓冲区）并返回纯网格数据。

```typescript
// ❌ Babylon.js
const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2 }, scene);
sphere.material = new StandardMaterial("mat", scene);

// ✅ Babylon Lite
const sphere = createSphere(engine);
sphere.material = createStandardMaterial();
addToScene(scene, sphere);
```

### 9. StandardMaterial 顶点色需要显式启用

PBR 材质会自动使用网格顶点色。Standard 材质则采用显式启用机制，使不使用顶点色的场景不保留任何相关特性代码。传入紧密打包的 RGBA 缓冲区（每个顶点四个浮点数），调用一次 `enableStandardVertexColors()`，然后再注册场景。

```typescript
import { enableStandardVertexColors } from "babylon-lite";

const vertexCount = positions.length / 3;
const colors = new Float32Array(vertexCount * 4);
for (let i = 0; i < vertexCount; i++) {
    const offset = i * 4;
    colors[offset] = 1;
    colors[offset + 3] = 1;
}

const mesh = createMeshFromData(engine, "colored", positions, normals, indices, undefined, undefined, undefined, colors);
mesh.material = createStandardMaterial();
addToScene(scene, mesh);

enableStandardVertexColors();
await registerScene(scene);
```

### 10. StandardMaterial 可选纹理需要显式启用

`StandardMaterialProps` 中仅内建了 `diffuseTexture`。其余八个纹理槽位均位于 `setStandardXTexture()` 函数之后，以便未使用它们的场景不保留对应的着色器代码。直接给底层字段赋值会触发编译错误——这些字段被标记为 `@internal`（以下划线开头），正是因为直接写入会跳过扩展注册并导致静默渲染失败。

```typescript
// ❌ Babylon.js
const mat = new StandardMaterial("mat", scene);
mat.bumpTexture = new Texture("normal.png", scene);
mat.emissiveTexture = new Texture("glow.png", scene);

// ✅ Babylon Lite
import { createStandardMaterial, setStandardBumpTexture, setStandardEmissiveTexture } from "@babylonjs/lite";

const mat = createStandardMaterial();
setStandardBumpTexture(mat, await loadTexture2D(engine, "normal.png"));
setStandardEmissiveTexture(mat, await loadTexture2D(engine, "glow.png"));
```

| Babylon.js 属性                     | Babylon Lite 设置器                           |
| ----------------------------------- | --------------------------------------------- |
| `material.bumpTexture`              | `setStandardBumpTexture(mat, tex)`            |
| `material.emissiveTexture`          | `setStandardEmissiveTexture(mat, tex)`        |
| `material.specularTexture`          | `setStandardSpecularTexture(mat, tex)`        |
| `material.ambientTexture`           | `setStandardAmbientTexture(mat, tex)`         |
| `material.lightmapTexture`          | `setStandardLightmapTexture(mat, tex)`        |
| `material.opacityTexture`           | `setStandardOpacityTexture(mat, tex)`         |
| `material.reflectionTexture` (2D)   | `setStandardReflectionTexture(mat, tex)`      |
| `material.reflectionTexture` (cube) | `setStandardReflectionCubeTexture(mat, cube)` |

配套标量属性（`bumpLevel`、`lightmapCoordIndex`、`opacityFromRGB`、`reflectionLevel`……）依然是普通可赋值属性，与设置器调用的先后顺序无关——特性检测发生在构建可渲染对象时，而非调用设置器时。如果在材质已经构建*之后*再设置纹理，仍像之前一样需要调用 `rebuildMaterial()`。

立方体反射接收一个 `CubeTexture`，只能由 `loadCubeTexture()` 生成：

```typescript
import { loadCubeTexture, setStandardReflectionCubeTexture } from "@babylonjs/lite";

setStandardReflectionCubeTexture(mat, await loadCubeTexture(engine, "textures/skybox", ".jpg"));
```

通过 `loadBabylon()` 加载 `.babylon` 文件时会自动连接以上所有纹理——加载器只会导入给定文件实际需要的设置器。

### 11. 镜像（负缩放）网格需要显式启用

当网格的世界矩阵行列式变为负值时，Babylon 会自动翻转 `sideOrientation`。Lite 的 glTF 加载器在加载时已经会为负缩放节点反转绕序，但其余情况则通过显式启用开关处理，使从不进行镜像的场景不携带绕序翻转代码。当你对 Standard 材质网格、程序化网格做镜像缩放，或在加载后更改镜像状态时，请在添加资产之后、`registerScene()` 之前调用一次 `await enableMirroredMeshes(scene)`。

```typescript
import { enableMirroredMeshes } from "babylon-lite";

const box = createBox(engine, 2);
box.scaling.set(-1, 1, 1); // mirrored — winding is reversed for you
addToScene(scene, box);

await enableMirroredMeshes(scene);
await registerScene(scene);
```

当镜像状态在运行时发生变化时它同样有效：每帧监听器只会检查世界矩阵确实发生变化（通过整数版本号比较）的网格，仅针对这些网格计算行列式，并且只有在符号真正翻转时才重建管线。

只有该运行时监听器是绑定到你传入的单个场景的——管线侧的绕序解析会在首次调用时以进程级安装，因此在多场景应用中，其他场景也会停止把镜像网格渲染成内外翻转；不过，除非你也为它们调用该方法，否则它们不会跟踪可渲染对象构建完成之后的镜像状态变更。

### 12. 移除与销毁实体

BJS 在单个对象上调用 `mesh.dispose()`。Lite 则使用 `removeFromScene()` 将网格从场景移除并销毁其全部 GPU 资源（缓冲区、纹理、骨骼数据）。

```typescript
// ❌ Babylon.js
sphere.dispose();

// ✅ Babylon Lite
removeFromScene(scene, sphere);
```

完整销毁清理：

```typescript
// ✅ Babylon Lite — tear down everything
disposeScene(scene); // releases all meshes, renderables, disposables
disposeEngine(engine); // destroys GPU device, render targets, swapchain
```

---

## 完整示例：迁移一个 PBR 场景

### Babylon.js

```typescript
const engine = new WebGPUEngine(canvas);
await engine.initAsync();
const scene = new Scene(engine);
scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

const light = new HemisphericLight("h", new Vector3(0, 1, 0), scene);
light.intensity = 1.0;

await SceneLoader.ImportMeshAsync("", baseUrl, "BoomBox.glb", scene);
const envTex = new CubeTexture(envUrl, scene);
scene.environmentTexture = envTex;
scene.createDefaultCamera(true, true, true);
scene.createDefaultEnvironment({ skyboxSize: 1000 });

engine.runRenderLoop(() => scene.render());
```

### Babylon Lite

```typescript
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);

addToScene(scene, await loadGltf(engine, "BoomBox.glb"));
await loadEnvironment(scene, envUrl, {
    skyboxUrl: "skybox.dds",
    skyboxSize: 1000,
    groundTextureUrl: "ground.png",
    brdfUrl: "/brdf-lut.png",
});

const cam = createDefaultCamera(scene);
attachControl(cam, canvas, scene);
addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

await startEngine(engine);
```

---

## 常见注意事项

| 注意事项              | 详情                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **不会自动加入场景**  | 网格、灯光、变换节点以及 `loadGltf()` 返回的资产容器都必须显式调用 `addToScene()` 添加。`loadEnvironment()` 则会在内部自动添加其环境数据与可渲染对象。 |
| **不使用 `new` 关键字** | 所有对象都通过工厂函数创建，而非构造函数。                                                                                                |
| **显式指定相机**      | 使用 `createDefaultCamera(scene)`（会自动赋值）或手动设置 `scene.camera = myCamera`。                                                     |
| **材质为纯属性对象**  | `createStandardMaterial()` / `createPbrMaterial()` 返回属性对象，赋值给 `mesh.material` 即可。                                            |
| **Standard 顶点色**   | 为每个顶点提供 4 个浮点数（RGBA），并在 `registerScene()` 前调用 `enableStandardVertexColors()`。PBR 顶点色依然自动生效。                 |
| **镜像网格**          | 当给网格（或其祖先节点）设置负缩放时，请在 `registerScene()` 前调用 `await enableMirroredMeshes(scene)` 以反转三角形绕序。glTF 负缩放节点在加载时已自动处理。 |
| **右手坐标系场景**    | `scene.useRightHandedSystem = true` 变为构建选项：向打包工具添加 `babylon-lite-rh` 解析条件。详见[右手坐标系](07-right-handed-system.md)。 |
| **仅限 WebGPU**       | 无 WebGL 回退。若浏览器不支持 WebGPU，`createEngine()` 会直接抛出异常。                                                                   |
| **网格没有 `dispose()`** | 使用 `removeFromScene(scene, mesh)` 移除单个网格并销毁其 GPU 资源；使用 `disposeScene(scene)` + `disposeEngine(engine)` 销毁全部资源。    |
| **可 Tree-Shaking 导入** | 只导入你使用的部分，未使用的特性会从打包产物中剔除。                                                                                      |
| **KTX2 仅限 glTF**    | KTX1 提供直接调用的 `loadKtxTexture2D()` 辅助函数。KTX2/BasisU 纹理源则在 `loadGltf()` 中通过 glTF `KHR_texture_basisu` 自动处理，因此不使用 KTX2 的场景无需承担任何运行时打包开销。 |
| **材质属性动画**      | 在运行时修改材质属性后需要标记材质为脏。详见下方“材质动画”一节。                                                                          |

---

## 材质动画

Babylon Lite 支持在运行时动态修改材质属性（例如逐帧调整颜色、透明度和各向异性强度），并提供两种方案：

### 手动标记（默认——零额外开销）

修改属性后，调用 `markMaterialUboDirty()`：

```typescript
import { markMaterialUboDirty } from "@babylonjs/lite";

onBeforeRender(scene, () => {
    material.alpha = Math.sin(time) * 0.5 + 0.5;
    markMaterialUboDirty(material);
});
```

此方式同时适用于 PBR 和 Standard 材质。在属性未发生变化时没有任何运行时开销。

### 自动追踪（显式启用）

在材质上调用一次 `enableMaterialTracking()`，即可安装自动检测变更的属性 setter——甚至包括原地修改数组元素（如 `material.diffuseColor[0] = 0.5`）：

```typescript
import { enableMaterialTracking, setPbrAnisotropy, setPbrEmissive } from "@babylonjs/lite";

const mat = createPbrMaterial({});
setPbrAnisotropy(mat, { isEnabled: true, intensity: 1.0 });
setPbrEmissive(mat, [0, 0, 0]);
enableMaterialTracking(mat);

// Now mutations auto-mark the material UBO dirty — no manual call needed:
onBeforeRender(scene, () => {
    mat._anisotropy!.intensity = Math.cos(a) * 0.5 + 0.5; // auto-dirty
    mat._emissiveColor![0] = 0.5; // auto-dirty (index write)
});
```

可选特性均隐藏在 `setPbrX()` 函数背后，从而确保未使用的着色器代码可以被 Tree-Shaking 剔除；它们写入的属性标记为 `@internal`（下划线前缀），正是为了让直接赋值（会跳过扩展注册并导致静默渲染异常）成为编译期错误。一旦设置器执行完毕，就可以对写入后的值进行原地修改。

`enableMaterialTracking` 完全支持 Tree-Shaking——未导入它的场景不产生任何打包体积开销。

| 特性                    | `markMaterialUboDirty` | `enableMaterialTracking`      |
| ----------------------- | ---------------------- | ----------------------------- |
| 打包体积开销            | 约 50 字节             | 约 1.5 KB（仅在导入时计入）   |
| 每帧开销                | 零（手动调用）         | 零（仅在属性变更时触发 setter） |
| 捕获 `color[0] = x`     | ❌（必须手动调用）     | ✅                            |
| 捕获 `mat.alpha = x`    | ❌（必须手动调用）     | ✅                            |

---

## 材质模板测试（Material Stencil，显式启用）

Babylon Lite 支持烘焙进主颜色通道的逐材质模板测试——用于传送门（portals）与贴花遮罩等效果（一个材质在绘制区域**写入**模板缓冲区，另一个材质则在已写入模板的位置**丢弃**片元）。它采用显式启用，从而确保不使用模板测试的场景打包体积几乎逐字节保持不变：

```typescript
import { createStandardMaterial, enableMaterialStencil, registerScene } from "@babylonjs/lite";

// Writer: stamp the stencil buffer (0 → 1) everywhere it draws.
const mask = createStandardMaterial();
mask.stencil = { passOp: "increment-clamp" };

// Tester: draw only where the stencil is still the pass's default reference of 0
// (i.e. where the writer did NOT draw). No dynamic stencil reference needed.
const masked = createStandardMaterial();
masked.stencil = { compare: "equal" };

enableMaterialStencil(); // ← opt-in, BEFORE registerScene
await registerScene(scene);
```

`StencilState` 接受 `compare`、`passOp`、`failOp`、`depthFailOp`、`readMask` 和 `writeMask`（均为可选；默认值为 `"always"` / `"keep"` / `0xff`）。模板测试仅应用于支持模板的目标（主颜色通道），在纯深度/阴影通道上会被忽略。如果不调用 `enableMaterialStencil`，材质上的 `stencil` 字段不会生效，且管线构建器中也不包含任何模板代码——`enableMaterialStencil` 完全支持 Tree-Shaking，未导入它的场景不承担任何打包开销。

---

## glTF / PBR 扩展

Babylon Lite 的 glTF 加载器与 PBR 材质支持以下扩展。每一项特性均可 Tree-Shaking：未使用它的场景不承担任何打包开销。

| 扩展 / 特性                       | 支持状态 | 备注                                                                                                                                                 |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KHR_materials_pbrSpecularGlossiness` | ✅   | `loadGltf()` 自动检测                                                                                                                                |
| `KHR_materials_clearcoat`         | ✅       | 自动检测；或 `createPbrMaterial({ clearCoat: { ... } })`                                                                                             |
| `KHR_materials_sheen`             | ✅       | 自动检测（glTF 按 BJS 规范缩放反照率）；或 `createPbrMaterial({ sheen: { ... } })`                                                                   |
| `KHR_materials_anisotropy`        | ✅       | 自动检测；或 `createPbrMaterial({ anisotropy: { ... } })`                                                                                            |
| `KHR_materials_variants`          | ✅       | `selectVariant(scene, name)`、`getVariantNames(scene)`、`resetVariant(scene)`                                                                        |
| `KHR_materials_ior`               | ✅       | 自动检测；电介质折射率（场景 30）                                                                                                                    |
| `KHR_materials_specular`          | ✅       | 自动检测；电介质镜面反射强度 + 颜色（场景 30）                                                                                                       |
| `KHR_materials_volume`            | ✅       | 自动检测；衰减颜色/距离 + 厚度（场景 30）                                                                                                            |
| `KHR_materials_transmission`      | ✅       | 面向透射型 glTF 材质的帧图场景纹理透射（场景 30/33/112）。屏幕空间场景纹理折射；像素一致性达 100% 像素误差在 5 以内。                                  |
| `KHR_texture_transform`           | ✅       | 加载时自动解析（材质级 UV 变换）                                                                                                                     |
| `KHR_texture_basisu`              | ✅       | 自动检测；仅为声明该扩展的 glTF 资产动态加载 KTX2 解码/上传路径（场景 112）                                                                          |
| `EXT_texture_webp`                | ✅       | 通过纹理源选择自动检测；使用浏览器原生图像解码（场景 37）                                                                                            |
| `KHR_draco_mesh_compression`      | ✅       | 自动检测；按需从站点根目录加载 `draco_decoder.js` + `.wasm`（可通过 `setDracoBaseUrl()` 覆盖）                                                       |
| `KHR_materials_emissive_strength` | ✅       | 自动检测；倍增自发光输出（场景 31）                                                                                                                  |
| `KHR_materials_unlit`             | ✅       | 自动检测；直接输出基础色，无光照计算（场景 32）                                                                                                      |
| `KHR_lights_punctual`             | ✅       | 自动检测；从 glTF 节点烘焙点光源 / 聚光灯 / 平行光（场景 33）                                                                                        |
| `KHR_node_visibility`             | ✅       | 自动检测；渲染时遵循逐节点可见性标志（场景 34）                                                                                                      |
| `KHR_animation_pointer`           | ✅       | 自动检测；为任意 JSON 指针（例如节点可见性、材质 UBO 字段）做动画（场景 34）                                                                         |
| `EXT_mesh_gpu_instancing`         | ✅       | 自动检测；将逐节点 TRS 访问器展开为 thin instances（场景 35）                                                                                        |
| `EXT_meshopt_compression`         | ✅       | 自动检测；通过动态导入的解码器对顶点/索引缓冲区进行 meshopt 解码（场景 211）                                                                         |
| `KHR_mesh_quantization`           | ✅       | 自动检测；将归一化/量化顶点属性以原生类型化格式上传（场景 211）                                                                                      |
| `KHR_xmp_json_ld`                 | ✅       | 自动检测；将 JSON-LD 元数据包挂载到 `AssetContainer.xmpMetadata`，零渲染性能影响（场景 210）                                                         |
| `ExtrasAsMetadata`                | ✅       | 将 glTF 节点、网格、图元及材质的 `extras` 提升至 `metadata.gltf.extras`                                                                              |
| 交错顶点缓冲区                    | ✅       | 真正的 GPU 级交错：带步长的 `bufferView` 只上传一次，并通过 `arrayStride`/offset 绑定到各属性槽位——无需 CPU 解交错或重写资产（场景 210）              |
| 次表面半透 + 厚度                 | ✅       | `createPbrMaterial({ subsurface: { translucency, thickness } })`                                                                                     |
| 镜面抗锯齿                        | ✅       | glTF 默认开启；手动配置：`createPbrMaterial({ enableSpecularAA: true })`                                                                             |
| 变形目标（Morph targets）         | ✅       | 仅支持 PBR 网格（不支持 `StandardMaterial`）                                                                                                         |
| 骨骼动画（4 或 8 骨骼）           | ✅       | 由 `createAnimationController(scene)` 驱动                                                                                                           |
| 动画混合 / 权重 / 叠加片段        | ✅       | `AnimationManager` 提供 `setAnimationWeight()`、`crossFadeAnimationGroups()` 与 `setAnimationAdditive()`（场景 155-158）                             |
| ShaderMaterial                    | ✅       | 仅 WGSL 的 `createShaderMaterial()`，支持类型化 Uniform、采样器、宏定义、Alpha 混合/测试；显式启用 `enableShaderMaterialInstanceWorld()` 与 `enableShaderMaterialFinalColor()` 可支持常规/thin-instance 共用的顶点着色器（场景 159-163） |
| GridMaterial                      | ✅       | 通过 `createGridMaterial()` 生成程序化无光照对象空间网格：mainColor/lineColor、gridRatio、gridOffset、major/minor units、opacity、antialias、useMaxLine、preMultiplyAlpha、opacityTexture、visibility（场景 213） |
| 节点材质（Node Material）         | ✅       | NME 片段解析器，覆盖核心、PBR、数学、纹理、程序化、法线、屏幕/深度、矩阵、循环与存储块（场景 60-89）                                                 |
| 精灵 / 广告牌                     | ⚡       | 2D 图层、支持深度的精灵、朝向/锁轴/镂空广告牌；非完整 BJS SpriteManager API（场景 50-57）                                                            |
| 高斯泼溅（Gaussian splatting）    | ✅       | `.ply`、`.splat`、`.sog`、`.spz`、变换烘焙、材质插件片段（场景 120-126）                                                                             |
| CSG / CSG2                        | ✅       | 网格布尔差集/交集/并集/加法 API（场景 90-91）                                                                                                        |
| 物理                              | ⚡       | Havok Physics V2 子集（场景 40）                                                                                                                     |
| 导航 / Recast                     | ⚡       | Recast V2 导航网格、人群寻路、瓦片缓存障碍物、离网连接、射线检测（场景 170-175）                                                                     |
| 设备丢失恢复                      | ✅       | 通过对应的 `enableDeviceLost*Recovery` API 为 SceneContext、SpriteRenderer 与 TextRenderer 显式启用恢复（场景 164 覆盖 SceneContext）                 |
| 屏幕空间 SSS（PrePass）           | ❌       | 未实现 — 仅支持 BRDF 层半透效果                                                                                                                      |

对于包含隐藏网格的 `ShaderMaterial` 场景，请调用 `enableShaderMaterialVisiblePacketUpdates(material)` 以延迟隐藏数据包（包括分组不透明绑定中的成员）的系统 Uniform 与资源更新。共享自定义 Uniform 与透明排序仍保持激活状态。请始终使用 `setMeshVisible(mesh, visible)` 进行隐藏和恢复，以确保缓存的渲染束（bundles）被正确失效；待处理的变更会在恢复绘制前自动刷新。默认更新策略保持不变。

请参考 `lab/lite/src/lite/scene*.ts` 查看每项扩展在实际场景中的端到端示例。

## 原始游戏输入

`DeviceSourceManager` 风格的游戏逻辑轮询可以使用独立的原生输入辅助函数。相机 `attachControl` 仍保持独立。请使用物理按键码代替 Babylon.js 数字按键常量，使用 DOM 按键掩码代替指针枚举，并在解析摇杆轴/按钮前检查手柄的 `mapping`。

```ts
import { createKeyboardInput, createPointerInput, isKeyboardKeyDown, readGamepad, resetPointerInput, disposeKeyboardInput, disposePointerInput } from "@babylonjs/lite";

canvas.tabIndex = 0; // The application decides when the canvas receives focus.
const keyboard = createKeyboardInput(canvas);
const pointer = createPointerInput(canvas);
// In your frame callback:
const forward = isKeyboardKeyDown(keyboard, "KeyW");
const lookX = pointer.deltaX;
const gamepad = readGamepad(0);
const stickX = gamepad?.mapping === "standard" ? (gamepad.axes[0] ?? 0) : 0;
resetPointerInput(pointer); // Clear accumulated deltas after reading the frame.
// During application teardown:
disposeKeyboardInput(keyboard);
disposePointerInput(pointer);
```

滚轮增量在 `wheelDeltaMode` 中保留其 DOM 单位；请在应用层自行对像素、行或页进行归一化。如果在帧读取状态前单位模式发生变化，则仅保留最近一次连续同模式的批次。没有任何输入辅助函数会自动捕获指针、阻止浏览器默认行为或注册场景回调。请显式销毁输入对象，或通过 `onSceneDispose` 注册销毁器。手柄数据为拷贝快照；`null` 表示槽位不可用、已断开连接或访问被拒绝。

Playground 中的 **Input — Keyboard, pointer and gamepad** 示例结合了 WASD 移动、指针视角控制以及标准手柄输入。有关焦点、iframe、主触控、重置与清理契约，请参阅[设备输入规范](architecture/60-device-input.md)。该原生 API 不会向 `lite-compat` 添加 `DeviceSourceManager` 类，也不承诺支持 Babylon Native。
