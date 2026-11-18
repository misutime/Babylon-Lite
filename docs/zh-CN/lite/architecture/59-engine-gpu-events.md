# 模块：引擎 GPU 事件与能力查询

> 包路径：`packages/babylon-lite/src/engine/engine-gpu-events.ts`

## 目的

在不要求应用获取引擎底层原生 `GPUDevice` 的前提下，暴露未捕获的 GPU 错误、设备丢失（device loss）、已启用的特性以及当前设备限制。订阅为按需启用（opt-in），并会自动跟踪由设备丢失恢复流程安装的新设备。

## 公共 API 接口

```typescript
export type EngineGpuErrorCallback = (error: GPUError) => void;
export type EngineDeviceLostCallback = (info: GPUDeviceLostInfo) => void;

export function onEngineGpuError(
    engine: EngineContext,
    callback: EngineGpuErrorCallback
): () => void;

export function onEngineDeviceLost(
    engine: EngineContext,
    callback: EngineDeviceLostCallback
): () => void;

export function getEngineLimits(engine: EngineContext): GPUSupportedLimits;
export function hasEngineFeature(engine: EngineContext, feature: GPUFeatureName): boolean;
```

两个订阅函数均返回一个取消订阅函数。错误回调接收未被应用错误作用域（error scope）处理的验证错误、内存不足或内部错误。设备丢失回调也会接收主动销毁事件（`info.reason === "destroyed"`）。能力查询函数读取引擎的当前设备，而非适配器或缓存的旧设备。

## 内部架构

首次订阅会惰性创建 `engine._gpuEvents`，其中包含 `_errors` 和 `_lost` 两个回调集合、`_device = null` 以及一个稳定的 `_onError` 处理函数，同时安装不透明的 `engine._attachGpuEvents` 接缝（seam）。不存在模块级注册表、额外分配或全局注册。

对于同一设备，附着操作是幂等的。在设备替换时，从旧设备上移除错误处理函数，记录新设备，为其添加 `"uncapturederror"` 监听器，并订阅其 `lost` Promise。丢失回调延续在通知订阅者之前会比较其捕获的设备与注册表当前记录的设备；来自过时设备的延迟通知将被忽略。

错误处理函数将事件的 `error` 转发给错误回调集合。每个丢失延续会遍历丢失回调集合。取消订阅会从对应集合中移除回调函数；重复移除无副作用。回调身份判定遵循标准的 `Set` 语义。

## 管线配置

无。错误订阅不会替代 WebGPU 错误作用域，也不会修改管线行为。特性查询仅报告当前设备上实际启用的特性。

## 着色器逻辑

无。

## 状态机 / 生命周期

1. 没有任何订阅时，注册表和恢复接缝均不存在。
2. 首次订阅时初始化注册表并附着到当前设备。
3. 后续订阅共享同一个事件处理函数和丢失延续。
4. 取消订阅仅移除回调成员，不重置注册表。
5. 设备恢复流程安装替换设备，并在重建资源前调用 `_attachGpuEvents?.(engine)`。注册表解除对旧设备的附着并跟踪替换设备。

设备销毁会作为设备丢失事件上报，而非静默过滤。Promise 和事件投递均为异步；本模块不会吞掉回调函数抛出的异常。

## Babylon.js 等价映射

这些函数承担了面向应用层的引擎错误与设备丢失 Observable 的角色。Lite 使用独立的订阅函数和惰性纯状态，而非挂载在引擎上的 Observable 方法。

## 依赖关系

`engine.ts` 提供仅限类型的注册表与接缝字段。`device-lost-recovery-run.ts` 在设备替换后调用该可选接缝。根入口 `index.ts` 重新导出四个函数和两个回调类型；不新增包子路径导出。

## 测试规范

`tests/lite/unit/engine-gpu-events.test.ts` 覆盖了未捕获错误转发、取消订阅、主动设备销毁、每个设备仅附着一次、替换设备事件投递、过时设备丢失抑制、当前设备限制/特性查询以及按需启用状态。替换设备回归测试先等待手动恢复完成，然后在兑现任一设备的丢失 Promise 前禁用自动恢复。`finally` 块确保即使断言失败也会禁用恢复，从而避免额外的异步恢复超出测试全局桩的生命周期。验证回调成员和设备代际行为的测试均不需要真实 GPU。

## 文件清单

- `engine/engine-gpu-events.ts`：订阅与能力查询。
- `engine/engine.ts`：仅限类型的注册表与可选附着接缝。
- `engine/device-lost-recovery-run.ts`：替换设备的重新附着。
- `tests/lite/unit/engine-gpu-events.test.ts`：事件与能力测试覆盖。
