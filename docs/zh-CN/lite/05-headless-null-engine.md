# 无头模式（Null Engine）—— 无渲染模拟

> 🧪 **实验性 / 原型阶段。** Null Engine 是一项较新的特性。模拟路径（物理、动画、逐帧回调）已通过端到端验证，但 API 界面仍可能调整，且**渲染功能有意不在此范围内**（参见[限制说明](#限制说明)）。非常欢迎提供反馈。

Babylon Lite 可以在**没有 GPU 且没有画布（canvas）**的环境下运行。**Null Engine** 是 Lite 中与 Babylon.js `NullEngine` 对应的实现：它只驱动引擎的*模拟*部分——物理步进、动画求值、`onBeforeRender` 回调以及变换矩阵更新——完全不进行任何渲染。

这使它非常适合**在服务端或无头进程中**运行场景：

- 用于多人游戏或模拟后端的权威**服务端物理**。
- 可在 CI 或自动化测试中运行的**确定性、固定步长**模拟。
- 离线计算变换 / 动画状态，之后再发送给渲染客户端。
- 任何根本没有浏览器和 GPU 的运行环境。

> **不确定你需要它还是普通引擎？** 如果你需要把像素绘制到屏幕上，请使用 [`createEngine`](01-getting-started.md)——那是 WebGPU 渲染路径。仅当你明确需要*不带*渲染的纯模拟时，才选择 Null Engine。

---

## 心智模型

普通的 Lite 应用会连接一个 GPU 设备并启动 `requestAnimationFrame` 循环：

```ts
const engine = await createEngine(canvas); // acquires a WebGPU device
const scene = createSceneContext(engine);
await registerScene(scene);
await startEngine(engine);                 // drives frames via requestAnimationFrame
```

Null Engine 会替换这两部分：

```ts
const engine = createNullEngine();                                  // no device, no canvas
const scene = createSceneContext(engine, { defaultRenderTask: false }); // no render task
for (let i = 0; i < steps; i++) stepScene(engine, scene, 1000 / 60);    // you drive the loop
```

有两点发生了变化，而你构建场景其余部分的方式完全不变：

1. **`createNullEngine()`** 返回一个无设备的引擎。它是同步的——没有需要 await 的适配器。
2. **时钟由你掌控。** 不再使用 `startEngine`，而是每个时间步（tick）手动调用一次 **`stepScene(engine, scene, deltaMs)`**。每次调用都会设置帧间隔并执行场景的逐帧更新，从而触发所有 `onBeforeRender(scene, …)` 回调（物理和动画正是通过这种方式向前推进）。

`createSceneContext(engine, { defaultRenderTask: false })` 非常关键：它会跳过创建帧图渲染任务（frame-graph render task），从而保证**永远不会创建交换链（swapchain）或任何 GPU 资源**。

---

## 快速入门

```ts
import { createNullEngine, stepScene, createSceneContext, onBeforeRender, createTransformNode } from "@babylonjs/lite";

const engine = createNullEngine();
const scene = createSceneContext(engine, { defaultRenderTask: false });

// A node whose transform we want to simulate.
const node = createTransformNode("mover", 0, 10, 0);

// Simple hand-rolled gravity via a per-frame callback — the same hook physics uses.
const stepMs = 1000 / 60;
const dt = stepMs / 1000; // seconds per step
let velocityY = 0;
onBeforeRender(scene, () => {
    velocityY += -9.81 * dt;
    node.position.set(node.position.x, node.position.y + velocityY * dt, node.position.z);
});

for (let i = 0; i < 180; i++) {
    stepScene(engine, scene, stepMs); // advance 3 seconds, no rendering
}

console.log("final y:", node.position.y);
```

此外还有一个便捷驱动函数 `runHeadlessSteps(engine, scene, steps, deltaMs?)`，等价于在循环中调用 `stepScene`：

```ts
import { runHeadlessSteps } from "@babylonjs/lite";

runHeadlessSteps(engine, scene, 180); // 180 steps at the default 1000/60 ms
```

---

## 真实物理 —— 无头运行 Havok

Null Engine 最主要的用例是物理模拟。在 Lite 中，Havok 完全运行在 CPU 上（通过 `onBeforeRender` 步进），因此在 Null Engine 上无需修改即可正常工作。下面的示例演示一个 1 kg 的立方体落到静态地面上并最终静止：

```ts
import {
    createNullEngine, stepScene, createSceneContext, createTransformNode,
    createHavokWorld, createPhysicsAggregate, PhysicsShapeType,
} from "@babylonjs/lite";
import HavokPhysics from "@babylonjs/havok";

const engine = createNullEngine();
const scene = createSceneContext(engine, { defaultRenderTask: false });

const hk = await HavokPhysics();
const world = createHavokWorld(scene, hk, { x: 0, y: -9.81, z: 0 });

// Static ground (mass 0) and a dynamic box, both with explicit box extents.
const ground = createTransformNode("ground", 0, 0, 0);
createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0, extents: { x: 100, y: 0.2, z: 100 } });

const box = createTransformNode("box", 0, 10, 0);
createPhysicsAggregate(world, box, PhysicsShapeType.BOX, { mass: 1, extents: { x: 1, y: 1, z: 1 }, restitution: 0.3 });

for (let i = 0; i < 180; i++) stepScene(engine, scene, 1000 / 60); // 3 s

console.log("box rests at y =", box.position.y.toFixed(3)); // ≈ 0.600
```

这一完整场景已在 Node 和 Deno 中通过端到端验证：首次触地时间与解析自由落体时间（~1.384 s）一致，且立方体最终稳定在 `y = 0.600`。

> **请显式提供碰撞体几何尺寸。** 在 Null Engine 上没有渲染通道可以用来推导包围盒，因此请直接为**基本体（primitive）**形状指定 `extents`/`radius`（如上所示），或者手动设置 `node.boundMin` / `node.boundMax`。目前尚不支持网格与凸包碰撞体——参见[限制说明](#限制说明)。

---

## 固定时间步长与确定性

`stepScene` 会**原样**使用你传入的时间增量——不存在任何与真实墙钟（wall-clock）的耦合。传入恒定的 `deltaMs`（例如 `1000 / 60`）即可获得**固定时间步长**，这正是你在服务端或测试中实现确定性、可复现模拟所需要的。要模拟 *N* 秒，只需运行 `N * 1000 / deltaMs` 步。

如果你对接的是实时服务端循环，请将经过的时间累加起来，再按固定步长消费，而不是直接把可变时间增量透传进去——经典的固定时间步长模式能够保证物理模拟稳定且可复现。

---

## 运行时环境

Null Engine **不需要 WebGPU，也不需要浏览器**，因此它可以在任何运行 JavaScript 的地方工作。运行时是否支持 WebGPU 对该路径毫无影响。

| 运行时                   | Null Engine（模拟）  | 说明                                                                                                  |
| ------------------------ | :------------------: | ----------------------------------------------------------------------------------------------------- |
| **Node.js**              | ✅ **推荐**          | 无需额外启动参数，无需 WebGPU。服务端模拟最简单、最推荐的宿主环境。                                   |
| **Deno**                 | ✅                   | 可直接运行，已配合真实 Havok WASM 验证。在 pnpm workspace 中运行时请加上 `--node-modules-dir=auto`，以确保 `npm:` 标识符能正确解析。 |
| **Web Worker**           | ✅                   | 在主线程之外运行——非常适合浏览器应用中的独立模拟 Worker。                                             |
| **CI / 测试运行器**      | ✅                   | 非常适用于确定性、固定步长的回归测试（Lite 自身的 `no-webgpu` 测试工程正是通过这种方式运行 Null Engine）。 |
| **浏览器（渲染）**       | —                    | 若需将像素渲染到屏幕上，请使用 [`createEngine`](01-getting-started.md)（WebGPU），不要使用 Null Engine。 |

> **Deno 并不是必需的。** Node 才是无头模拟的推荐宿主环境。只有在你另外探索无头*渲染*时才需要关注 Deno——而 Null Engine 本身并不做渲染。

---

## 限制说明

Null Engine 有意只实现模拟路径。以下功能**不受支持**，调用它们会抛出异常或解引用缺失的 GPU 设备：

- **任何渲染功能。** `startEngine`、`renderFrame`、`captureScreenshot`、surfaces 以及 render-to-texture 均不可用。
- **带材质的网格。** 它们的延迟 GPU 构建器会访问（不存在的）设备。请添加普通的 TransformNode 或物理刚体，不要添加带材质的可渲染网格。
- **网格 / 凸包碰撞体。** 这些碰撞体依赖渲染侧的世界矩阵通道。目前请使用带有显式几何尺寸的**基本体**形状（box / sphere / capsule / cylinder）。_（后续跟进支持。）_
- **高精度 / 浮动原点矩阵。** 它们依赖真实 `createEngine` 安装的 F64 分配器。_（后续跟进支持。）_

在底层实现上，原型会构造一个**部分填充的** `EngineContext`，仅包含模拟/更新路径会读取的字段（`_device` 有意缺省）。将 `EngineContext` 与其 GPU/surface 成员彻底解耦是一项规模更大、单独跟踪的后续重构任务——但由于在 Null Engine 上所有渲染代码路径均不可达，这些缺失的 GPU 字段永远不会被解引用。

---

## API 参考

| 导出函数                                           | 说明                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `createNullEngine(options?)`                       | 创建一个无设备、无 surface 的引擎。同步执行。`options` 保留供未来扩展。                                     |
| `stepScene(engine, scene, deltaMs)`                | 推进一个固定模拟步长：设置帧时间增量并运行场景的逐帧更新（触发所有 `onBeforeRender` 回调）。不录制任何 GPU 工作。 |
| `runHeadlessSteps(engine, scene, steps, deltaMs?)` | 便捷方法：连续调用 `stepScene` 共 `steps` 次（`deltaMs` 默认值为 `1000 / 60`）。                           |

将上述接口与常规场景 API 配合使用即可——如 `createSceneContext(engine, { defaultRenderTask: false })`、`onBeforeRender`、`createTransformNode` 以及各类物理工厂函数。

---

## 下一步

- 🚀 **[快速开始](01-getting-started.md)** — 完整（渲染版）引擎以及 Lite 的心智模型。
- 🧱 **[动画](architecture/07-animation.md)** — 动画组同样会在 `stepScene` 下正常推进。
- 🌐 **[github.com/BabylonJS/Babylon-Lite](https://github.com/BabylonJS/Babylon-Lite)** — 源码、Issue 与场景画廊。

在无头运行 Lite 时遇到瓶颈？欢迎**[提交 Issue](https://github.com/BabylonJS/Babylon-Lite/issues)**——该特性的演进方向将直接由社区用户的实际需求决定。💙
