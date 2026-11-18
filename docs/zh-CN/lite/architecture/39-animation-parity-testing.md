# 模块：动画一致性测试——确定性帧同步

> 范围：`lab/`、`scripts/capture-golden.ts`、`tests/lite/parity/`

## 用途

带动画的场景（骨骼、变形目标）必须在 Babylon.js 参考实现与 Babylon Lite 中捕获于**完全相同的动画帧**。若无同步机制，帧率差异会导致姿态不一致，从而产生误报的一致性测试失败。本文档记录了消除此类测试抖动的确定性帧同步协议。

---

## 问题

每台机器和 GPU 都以不同的原生帧率渲染。Babylon.js 会根据真实帧间隔时间（delta time）调整动画时间步长，因此 144 Hz 显示器与 60 Hz 显示器在经过相同的挂钟时间（wall-clock duration）后会呈现不同的姿态。除非双方就**捕获哪一动画帧**达成一致并使用**完全相同的时间步长**推进到该帧，否则截图对比必然产生虚假的像素差异。

---

## 解决方案：在第 N 帧冻结 + 恒定时间步长

该协议包含两部分：

1. **恒定时间步长** —— 无论真实间隔时间是多少，两个引擎每帧都精确地将动画推进 16 ms。
2. **帧冻结** —— 在预设的帧数（例如第 300 帧），两个引擎都暂停所有动画但继续保持渲染。通过 DOM 信号通知测试框架，表明冻结帧已准备就绪、可以截图。

---

## 恒定时间步长（双端）

### BJS 参考实现（`babylon-ref-sceneN.html`）

```javascript
engine.getDeltaTime = function () {
    return 16;
};
scene.useConstantAnimationDeltaTime = true;
```

### Lite（`sceneN.ts`）

```typescript
engine._fixedDeltaMs = 16.0;
```

此时双端均以固定的 16 ms / 帧推进。经过 N 帧后的动画状态是完全确定性的。

---

## 帧冻结

在指定帧数时，两个引擎暂停动画但继续渲染。

### BJS 参考实现

```javascript
let frameCount = 0;
scene.registerBeforeRender(() => {
    frameCount++;
    if (frameCount === 300) {
        scene.animationGroups.forEach((g) => g.pause());
        canvas.dataset.animationFrozen = "true";
    }
});
```

### Lite（受 `?freeze` 查询参数门控）

```typescript
if (new URLSearchParams(location.search).has("freeze")) {
    let frameCount = 0;
    engine._beforeRender.push(() => {
        frameCount++;
        if (frameCount === 300) {
            engine.pauseAnimations();
            canvas.dataset.animationFrozen = "true";
        }
    });
}
```

`?freeze` 查询参数门控确保交互式浏览不受影响——只有测试和基准图捕获脚本会附加该参数。

---

## 信号协议

`canvas.dataset.animationFrozen = 'true'` 是供以下两处消费的 DOM 信号：

1. **基准图捕获**（`scripts/capture-golden.ts`）—— 在截取参考图像之前等待此信号。
2. **一致性测试**（`tests/lite/parity/sceneN-*.spec.ts`）—— 在与基准图进行像素对比之前，在 Lite 页面上等待此信号。

---

## 一致性测试模式

```typescript
test("Scene N — Animated model matches reference", async ({ page }) => {
    // Load Lite scene with freeze param
    await page.goto("/sceneN.html?freeze");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    // Wait for exact animation frame
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    // Screenshot and compare against golden
    const screenshot = await page.screenshot({/* … */});
    // … pixel comparison …
});
```

---

## 基准图捕获

### 场景启动可靠性（场景 112 与 121）

场景 112 从 `/models/FlightHelmetKTX/` 提供 Flight Helmet KTX2 模型。`pnpm fetch:flight-helmet` 会从 BabylonJS/Assets 提交 `183f26290601abe1d5282eed00c306f4c8228307` 恢复该模型、缓冲区及 15 张纹理。每个文件在写入或复用前都会校验其 Git blob 摘要。下载设有超时上限，失败时会停止准备流程并报告资产 URL 和 HTTP 状态码。生成的资产目录已加入 gitignore；二进制文件保留在 BabylonJS/Assets 中，而不放入 Lite 包。启动 lab、构建静态 lab 或筛选了场景 112 的 bundle 构建都会在提供服务前先准备好这些文件。

场景 121 使用仓库中已检入的 `/splats/Halo_Believe.splat`。其 BJS 参考实现会构造一个未加载的网格并调用一次 `loadFileAsync`。两个场景都会同时通过 `canvas.dataset.error` 和 `console.error` 上报初始化失败。它们的一致性测试使用 `waitForCanvasReady`，从 Node 侧进行轮询以保持 BrowserStack 连接活跃，并在出现 `data-error` 时立即拒绝。150 秒的就绪预算适合 180 秒的测试总时限，从而保留真实的启动错误信息，而非出现因拆毁导致的 `"browser closed"` 错误。

这两个一致性测试仅将 Lite 输出与已提交的基准图进行对比；它们从不在测试时打开在线 BJS 参考页或替换基准图。场景 112 的基准图保持不变。场景 121 的基准图取自其在 [CI build 60995 / 20261019.6](https://snapshots-cvgtc2eugrd3cgfd.z01.azurefd.net/lite/20261019.6/testResults/parity/index.html) 中通过测试的 `reference` 附件：`data/37dcbe75cd41caf80e7133f2cb2675fa1e91e9b1.png`。它由 Babylon.js 而非 Lite 捕获，该次运行报告的 MAD 为 0.014。

针对性的非视觉启动测试会屏蔽 jsDelivr、覆盖两条本地资产路径，并注入资产故障以验证错误能够传达到就绪等待器。下载器单元测试覆盖了校验复用、HTTP 错误与损坏下载场景。现有的 MAD 与打包体积上限均保持不变。

`scripts/capture-golden.ts` 是用于捕获基准参考 PNG 的 CLI 工具：

```bash
pnpm exec tsx scripts/capture-golden.ts 5   # Capture scene 5 golden
```

对于带动画的场景，它会执行：

1. 打开 BJS 参考 HTML。
2. 等待 `canvas.dataset.animationFrozen === 'true'`。
3. 截图并保存为 `reference/lite/sceneN-*/babylon-ref-golden.png`。

---

## 关键设计决策

| 决策                                  | 理由                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **精确帧（`=== N`），而非 `>= N`**   | BJS 与 Lite 必须冻结在完全相同的动画姿态。使用不等式可能引入差一帧的偏移。                                                             |
| **恒定 16 ms 增量**                   | 若不固定，BJS 会自适应真实帧率，导致不同硬件下的姿态具有非确定性。                                                                     |
| **查询参数门控（`?freeze`）**         | 交互式浏览保持不受影响。仅测试和基准图捕获会附加该参数。                                                                               |
| **第 300 帧**                         | 足够靠后，确保所有资产已加载且动画处于周期中段（具有代表性的姿态）；又足够靠前，使测试运行迅速（60 fps 下约 5 秒）。                   |

---

## 文件清单

| 文件                                        | 角色                               |
| ------------------------------------------- | ---------------------------------- |
| `lab/lite/babylon-ref-scene5.html`          | 带帧同步的 BJS 参考页              |
| `lab/lite/babylon-ref-scene7.html`          | 带帧同步的 BJS 参考页              |
| `lab/lite/src/lite/scene5.ts`               | 支持冻结的 Lite 场景               |
| `lab/lite/src/lite/scene7.ts`               | 支持冻结的 Lite 场景               |
| `scripts/capture-golden.ts`                 | 基准图捕获 CLI                     |
| `tests/lite/parity/scene5-alien.spec.ts`    | 动画一致性测试                     |
| `tests/lite/parity/scene7-chibirex.spec.ts` | 动画一致性测试                     |

---

## 应用于新的动画场景

添加新的动画场景时：

1. **BJS 参考页** —— 添加 `getDeltaTime = () => 16`、`useConstantAnimationDeltaTime`、帧计数器、冻结逻辑与 DOM 信号。
2. **Lite 场景** —— 添加 `_fixedDeltaMs = 16`，在 `?freeze` 参数控制下执行冻结并发出信号。
3. **一致性测试** —— 在截图前同时等待 `ready` 和 `animationFrozen` 信号。
4. **capture-golden.ts** —— 将场景添加到注册表，并标注 `animated: true` 及冻结帧数。
