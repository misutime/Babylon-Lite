# 模块：Device Context（设备上下文）

> 包路径：`packages/babylon-lite/src/engine/`

## 目的

将与画布无关的 WebGPU 获取逻辑与引擎初始化分离。小型引导包可以在下载应用代码的同时调用 `createDevice`，然后将生成的上下文传递给将拥有该上下文的引擎。不公开任何原生 GPU 句柄。

## 公共 API 接口

```typescript
interface DeviceOptions {
    requiredLimits?: Record<string, GPUSize64 | undefined>;
}
interface DeviceContext {} // opaque branded handle
function createDevice(options?: DeviceOptions): Promise<DeviceContext>;
function disposeDevice(device: DeviceContext): void;
interface EngineDeviceOptions extends Omit<EngineOptions, "requiredLimits" | "device"> {
    device: DeviceContext;
    requiredLimits?: never;
    requiredFeatures?: never;
}
function createEngine(canvas: RenderCanvas, options: EngineDeviceOptions): Promise<EngineContext>;
function createEngine(canvas: RenderCanvas, options?: EngineOptions): Promise<EngineContext>;
```

`EngineContext.device` 暴露其设备上下文。传统 `EngineOptions` 禁止包含 device 属性，并保留其现有的设备限制与表面/精度选项。`createEngineWithFeatures` 保留其现有签名和内部特性解析器。显式特性刻意未作为 `DeviceOptions` 的字段，且上下文不暴露任何特性/限制能力快照；这两者都会增加每个 `createEngine` 打包产物的字节数。能力信息仍可通过现有的引擎辅助函数查询。

## 内部架构

设备模块在运行时不依赖引擎、画布、渲染或恢复逻辑。它包含适配器选项安装（保留现有的 XR 启用器）、机会性特性列表、仅由 `createEngineWithFeatures` 安装的特性解析器钩子，以及设备获取逻辑。从未安装这两个钩子的打包产物可让打包器将钩子检查折叠消除。`disposeDevice` 位于独立模块中，因此只有导入它的调用方才需承担其体积开销。

内部字段保存原生设备、创建选项和一个 `_claimed` 标志。所有内部字段均使用 `@internal` 标记，并在生成的公共声明中移除。一个在类型擦除后消失的 unique-symbol 品牌标识可防止原生设备及结构相似的对象满足公共上下文类型。引擎 `_device` 仍是现有 GPU 子系统使用的内部别名。

特性为 Lite 现有的七个机会性特性，或已安装解析器的选择结果。功耗偏好仍如以往固定为 `high-performance`。

## 管线配置

无变化。表面创建时使用上下文的原生设备配置其画布。

## 着色器逻辑

无变化。

## 状态机 / 生命周期

一个设备上下文恰好对应支持一个引擎。未传入 `device` 的 `createEngine` 会自行调用 `createDevice`，并完整转发其选项对象（它携带 `requiredLimits`，对于 `createEngineWithFeatures` 还携带解析器的 `requiredFeatures`），从而使两条路径共享同一套获取实现。当传入 `device` 时，引擎跳过获取步骤；引擎级的特性/限制选项由 `EngineDeviceOptions` 类型而非运行时来拒绝。

`createEngine` 会在配置画布前拒绝已被某个引擎拥有或已被释放的上下文。只有在初始化成功后，它才会认领该上下文。如果初始化失败，传入的上下文仍由调用方负责：可使用 `disposeDevice` 释放，或用于另一次尝试。`disposeDevice` 具有幂等性，在引擎拥有该上下文后调用为空操作；`disposeEngine` 会销毁其所拥有的设备。

失败不会自动取消配置已部分初始化的画布，也不会销毁内部获取的设备，这与现有的引擎初始化行为一致。已配置的画布可以保留设备，直到画布取消配置、重新配置或被释放。丢弃未使用的上下文而不主动释放，会在不再存在引用后交由垃圾回收器回收。

仅当启用恢复功能时才会协调设备丢失处理，与设备上下文引入之前完全一致：引擎使用其已启用的特性、上下文的原始限制以及任何存储恢复限制来请求替换设备。成功后会同时更新 `engine._device` 和上下文的原生设备，使 `engine.device` 保持最新。若未启用恢复，传入一个在应用包下载期间已丢失的设备，其行为与 `createEngine` 在竞态下遇到设备丢失相同：引擎会在已丢失的设备上创建。

## Babylon.js 等价映射

`createEngine` 仍然是便捷的完整初始化路径。`createDevice` 是 Lite 特有的纯状态获取步骤。

## 依赖关系

设备获取：仅依赖浏览器 WebGPU 与类型擦除后的引擎类型导入。
恢复：依赖现有的可选恢复模块、存储恢复模块和引擎生命周期。

## 测试规范

- 仅创建设备时绝不触及画布或导入引擎运行时代码。
- 机会性特性选择、已安装的适配器选项、适配器缺失、适配器/设备拒绝以及限制参数。
- 引擎使用传入的设备而不再发起额外的适配器/设备请求，并在销毁时将其销毁；未传入设备的 `createEngine` 会使用引擎选项对象通过 `createDevice` 获取设备。
- 已被引擎拥有或已通过 `disposeDevice` 释放的上下文会在配置画布之前被拒绝。
- 初始化失败时，传入的设备仍可供释放或重试；拒绝已被拥有的上下文时，原引擎的设备保持完好。
- 引擎级获取选项（包括非字面量的 `requiredFeatures`）以及 `createDevice({ requiredFeatures })` 会被生成的类型探测测试拒绝。
- 恢复流程重用上下文的限制并更新该上下文。

## 文件清单

- `device.ts`：上下文、获取、所有权认领、适配器选项和特性解析器钩子。
- `device-dispose.ts`：针对从未交付给引擎的上下文的清理逻辑。
- `engine.ts`、`engine-dispose.ts`：获取、所有权与销毁。
- `device-lost-recovery-run.ts`：恢复逻辑读取创建选项并更新上下文。
- `compute/compute-engine-features.ts`、`compute/compute-uniform-f16.ts`、`xr/xr-adapter.ts`：特性/适配器选择集成。
- `index.ts`：仅根入口导出。
- 专项单元/构建测试及引擎架构文档。
