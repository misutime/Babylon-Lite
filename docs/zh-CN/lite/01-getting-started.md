# Babylon Lite 快速开始

本指南将带你从 `npm install` 一直走到渲染出第一个 3D 场景，并且同样重要的是——帮助你建立对 Babylon Lite 设计方式的**心智模型**，让后续使用其余 API 时感到自然且可预测。

> 初次接触？请先阅读**[欢迎页](00-welcome.md)**，了解整体概览以及“我该用哪个引擎？”决策树。本页默认你已决定使用 Lite 进行构建。

> 🛝 **想先试玩再安装？** **[Lite Playground](https://liteplayground.babylonjs.com)** 可以直接在浏览器中运行本页的每一个示例——无需任何本地配置。完整功能请查看 **[Playground 指南](04-playground.md)**。

---

## 1. 安装

Babylon Lite 作为单个 npm 包发布：

```bash
npm install @babylonjs/lite
```

这就是全部的运行时。无需插件注册，没有全局副作用，也不需要单独的 loaders 包——每一个可选功能都是普通的 `import`，打包工具**只会在你实际使用它时**才将其包含进去。

**环境要求：**

- **WebGPU。** Lite 仅支持 WebGPU——Chrome/Edge 113+，以及较新版本的 Firefox 与 Safari。在设计上不提供 WebGL 回退。
- **打包工具（Bundler）。** Lite 基于并围绕 [Vite](https://vitejs.dev/) 设计，使用 Vite 是最顺畅的路径，但任何现代 ESM 打包工具均可工作。

---

## 2. 心智模型（请先阅读此节）

Babylon Lite 看起来与 Babylon.js 颇为相似，但它建立在几条明确的规则之上。掌握下面四个理念后，整个 API 都会变得直观且可预期。

### 纯数据，而非类

相机、灯光、网格和材质都是**普通的状态对象**——没有方法，没有隐藏引用。你通过工厂函数来创建它们：

```typescript
const light = createHemisphericLight([0, 1, 0], 1.0); // just returns data
```

行为逻辑位于**独立函数**中，并将对象作为第一个参数传入：

```typescript
addToScene(scene, light);
getViewMatrix(camera);
```

这正是 Lite 能够实现 **Tree-Shaking** 的关键：你从未调用过的函数会从打包产物中被完全剔除，不会因为某个类而拖带进一大堆你根本用不到的方法。

### 场景是唯一的所有者

灯光不知道场景的存在，网格也不知道场景的存在。**只有场景知道自己包含哪些内容。** 你先将各个组件作为独立数据构建出来，然后再交给场景：

```typescript
const light = createHemisphericLight([0, 1, 0], 1.0);
addToScene(scene, light); // the scene now owns it
```

这种单向所有权（one-way ownership）意味着零循环引用、极简序列化以及可预测的生命周期——只要不在场景中，它就不会被渲染。

### 显式的生命周期

每一个 Lite 应用都按顺序遵循相同的四个阶段：

1. **创建引擎** — `await createEngine(canvas)`（获取 GPU 设备）。
2. **构建场景** — 创建一个 `SceneContext`，然后通过 `addToScene()` 将相机、灯光、网格和已加载的资产添加到场景中。
3. **注册场景** — `await registerScene(scene)` 会执行延迟的 GPU 初始化工作（构建管线、划分可渲染对象）。请在所有对象都添加完毕**之后**调用它。
4. **启动渲染** — `await startEngine(engine)` 启动渲染循环，并在首帧完成后 resolve。

如果某个物体没有显示出来，几乎总是因为它在 `registerScene()` **之后**才被添加，或者根本没有被添加到场景中。

### 只为触及的功能付费

每一个可选功能——glTF 扩展、清漆（clearcoat）、HDR 加载、阴影——都是一个独立的模块，仅在场景实际需要时才被动态导入。一个极简场景只需几 KB；一个完整的 PBR + IBL 场景也只会为其实际走到的代码路径付费。你无需手动管理这一切，只需按需要编写场景代码，打包工具会自动完成剩下的工作。

---

## 3. 你的第一个场景

下面是一个完整且极简的应用：包含引擎、相机、灯光以及一个带有 PBR 材质的球体。

```typescript
import {
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    attachControl,
    createHemisphericLight,
    createSphere,
    createPbrMaterial,
    addToScene,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

// 1. Engine
const engine = await createEngine(canvas);

// 2. Scene
const scene = createSceneContext(engine);

// Camera (plain data) — set it on the scene, then attach input handling
const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 4, { x: 0, y: 0, z: 0 });
scene.camera = camera;
attachControl(camera, canvas, scene);

// Light
addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

// A sphere with a simple PBR material
const sphere = createSphere(engine, { segments: 16, diameter: 2 });
sphere.material = createPbrMaterial({ baseColorFactor: [0.9, 0.1, 0.1, 1], metallicFactor: 0.1, roughnessFactor: 0.4 });
addToScene(scene, sphere);

// 3. Register (after everything is added)
await registerScene(scene);

// 4. Start the render loop
await startEngine(engine);
```

```html
<canvas id="renderCanvas" style="width: 100%; height: 100%"></canvas>
```

这就是一个完整的 Lite 应用。请留意它的流程形态：**create → add → register → start**（创建 → 添加 → 注册 → 启动）。

---

## 4. 加载模型与环境

大多数实际项目都是从加载一个 glTF/GLB 模型并使用基于图像的环境光（IBL）对其进行照明开始的。`loadGltf()` 会返回一个**资产容器（asset container）**——即描述所加载层级结构的纯数据。你可以像其他任何组件一样，将该容器直接传递给 `addToScene()`。

```typescript
import {
    createEngine,
    createSceneContext,
    createDefaultCamera,
    attachControl,
    createHemisphericLight,
    loadGltf,
    loadEnvironment,
    addToScene,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const engine = await createEngine(canvas);
const scene = createSceneContext(engine);

addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

// Load a model — returns an AssetContainer; addToScene registers its
// meshes, transform hierarchy, and animation groups for you.
addToScene(scene, await loadGltf(engine, "https://playground.babylonjs.com/scenes/BoomBox.glb"));

// Image-based lighting + skybox + ground. loadEnvironment adds its own
// renderables to the scene internally.
await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
    skyboxUrl: "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds",
    skyboxSize: 1000,
});

// Frame the loaded model automatically
const camera = createDefaultCamera(scene);
attachControl(camera, canvas, scene);

await registerScene(scene);
await startEngine(engine);
```

这就是**[欢迎页](00-welcome.md)**中的 BoomBox 场景——相同的模型、灯光与 IBL，只需寥寥数行代码。

---

## 5. 如何处理常见任务

以下是几个与 Babylon.js 有差异的模式指引。这里只提供快速定位思路，而非完整参考——如需深入了解请点击对应链接。

- **添加与移除对象。** `addToScene(scene, entity)` 负责注册；`removeFromScene(scene, entity)` 则对应 BJS 的 `dispose()`。场景掌控生命周期——移除某个实体后它便停止渲染。
- **在大量对象间复用几何体。** Lite **没有**实现传统的 `InstancedMesh` API。取而代之的是使用 **thin instances（精简实例化）** 在单次 GPU 绘制调用中渲染同一网格的大量副本——通过 `setThinInstances(mesh, data, count)` 传入扁平的 `Float32Array` 实例矩阵（以及可选的逐实例颜色）。这是在场景中高效填充重复道具的惯用方式。详见 **[Thin Instances](architecture/12-thin-instances.md)**。
- **父子层级关系。** 使用 `createTransformNode()` 构建变换层级，并将节点设为它的子节点；世界矩阵会按需惰性传播。`cloneTransformNode()` 可复制整个节点子树。详见**[场景层级与父子关系](architecture/11-scene-hierarchy-parenting.md)**。
- **隐藏对象。** 使用 `setSubtreeVisible(node, false)` 来切换节点及其子孙节点的可见性，而不是直接销毁——非常适合对象池以及无需重新上传 GPU 资源的显示/隐藏切换。
- **动画。** glTF 动画片段会作为 **animation groups（动画组）** 挂载在资产容器上，`addToScene()` 会自动完成注册；你可以对其进行播放、暂停、跳转（seek）和循环控制。详见**[动画](architecture/07-animation.md)**。
- **查看错误消息。** 为保持打包体积精简，Lite 的错误默认只包含数字错误码（`error.message` 为 `#<code>`）。调用 `enableErrorDecoding()` 可在全局启用完整错误文本（开发阶段非常实用，但建议在生产环境避免），或者使用 `decodeError(err)` 按需还原单个捕获错误的完整文本——例如在 `catch` 中动态导入以向遥测系统上报生产错误。详见**[错误处理](architecture/49-error-handling.md)**。

---

## 6. 下一步

现在你已经掌握了核心心智模型，并跑通了第一个场景。接下来可以继续探索：

- 🛝 **[Lite Playground](04-playground.md)** — 直接在浏览器中运行并调试这些场景，还能保存并生成链接分享。
- 🔁 **[迁移指南](03-porting-guide.md)** — 逐项对照将 Babylon.js 场景转换为 Lite 的 API 映射表。
- 📊 **[功能对比](02-feature-comparison.md)** — 准确查看 Lite 目前已覆盖、部分支持和尚未具备的能力。
- 🧱 **[架构文档](architecture/00-overview.md)** — 按从最常用到更底层顺序排列的各子系统深度解析。
- 🧪 **[无头模式（Null Engine）](05-headless-null-engine.md)** — 在没有 GPU 的环境中运行场景，用于服务端物理与确定性模拟。
- 🫱 **[右手坐标系](07-right-handed-system.md)** — 将你的应用编译为右手坐标系，对应 Babylon.js 的 `useRightHandedSystem`。
- 🌐 **[github.com/BabylonJS/Babylon-Lite](https://github.com/BabylonJS/Babylon-Lite)** — 浏览源码与场景画廊。

发现缺失或令人困惑的地方？欢迎**[提交 Issue](https://github.com/BabylonJS/Babylon-Lite/issues)**——早期反馈将直接决定路线图的方向。💙
