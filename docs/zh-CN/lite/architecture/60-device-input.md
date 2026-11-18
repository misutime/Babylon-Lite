# 模块：独立设备输入

> 包路径：`packages/babylon-lite/src/input/`

## 目的与所有权

用于相机控制器之外的游戏玩法按需浏览器输入（issue #410）。应用拥有状态及其生命周期；不持有引擎或场景引用、渲染钩子、设备注册表、外部依赖，也没有导入期的 DOM 访问。所有函数与类型均为根路径命名导出；各设备家族相互独立。

## 公共 API

```ts
interface KeyboardInput { readonly keys: ReadonlySet<string> }
createKeyboardInput(target: HTMLElement | Window): KeyboardInput;
isKeyboardKeyDown(input: KeyboardInput, code: string): boolean;
disposeKeyboardInput(input: KeyboardInput): void;

interface PointerInput {
    x: number; y: number;
    deltaX: number; deltaY: number;
    wheelX: number; wheelY: number; wheelZ: number; wheelDeltaMode: number;
    buttons: number; pointerId: number | null; pointerType: string;
}
createPointerInput(element: HTMLElement): PointerInput;
resetPointerInput(input: PointerInput): void;
disposePointerInput(input: PointerInput): void;

interface GamepadButtonState { value: number; pressed: boolean; touched: boolean }
interface GamepadState {
    id: string; index: number; mapping: GamepadMappingType; timestamp: number;
    axes: number[]; buttons: GamepadButtonState[];
}
readGamepad(index?: number): GamepadState | null;
```

实现在键盘和指针状态上保留了一个可选的 `@internal _dispose` 回调。公共状态对象不附带任何行为方法。

## 键盘生命周期

通过物理 `KeyboardEvent.code` 值（例如 `KeyW`）标识按下的键。在传入的 target 上监听 `keydown`，并在其所属窗口上监听 `keyup`。在目标/后代元素/窗口失焦（blur）、文档隐藏（hidden）或释放时清空状态。重复按键事件具有幂等性。从目标解析对应的文档和窗口，支持 iframe 目标。工厂函数要求目标具有关联窗口的文档；由调用方负责使元素可聚焦。释放操作移除所有监听器、清空状态且幂等。

## 指针生命周期与单位

在捕获阶段监听所属窗口的指针事件，但不执行指针捕获（capture）、不阻止默认行为、不修改焦点或样式，也不阻止事件传播。相机监听器仍负责处理自身的手势与浏览器默认行为。接收元素上的主指针，或元素外部当前处于按下状态的指针。处于按下状态的指针移入时成为跟踪触点；如果此前漏掉了释放事件，按键掩码为零的移动事件会释放该指针。其他主设备无法接管正在进行的拖拽。

位置坐标为相对于 `getBoundingClientRect()` 左上角的 CSS 像素，而非绘图缓冲区像素。增量（delta）累计客户端坐标系的位移；首个事件或指针身份切换时会初始化基线。指针锁定（Pointer Lock）使用 `movementX/Y`。进入或退出指针锁定（包括在其他元素上）会清空按住/瞬态状态并重新初始化客户端基线。应用可根据需要自行转换位置以用于拾取。`buttons` 遵循 DOM 位掩码：主按键 1、次按键 2、辅助按键 4。

滚轮数值保留 DOM delta 单位：mode 0 为像素，1 为行，2 为页。相同 mode 的事件会累加；mode 变化时开启新的滚轮批次，确保绝不会将不兼容的单位相加。较早的未消费批次会被丢弃；例如像素 +10 之后紧跟行 +1 时，仅暴露行 +1。消费方可根据需要自行归一化单位，或直接监听滚轮事件以无损获取混合模式。`resetPointerInput` 在一帧读取完输入后清除移动和滚轮增量/模式，同时保留位置和按住的按键状态。元素外部的释放同样可被观测到。取消（cancel）、丢失捕获、失焦、文档隐藏以及释放都会清除按下的指针身份及瞬态输入。无关指针的取消不会影响当前活动指针。普通释放会保留最后一次的指针身份、位置以及累计位移，同时将 `buttons` 置零。释放操作移除所有监听器。对于触控游戏玩法，调用方需在自己的元素上设置 `touch-action`。

## 游戏手柄与浏览器限制

每次调用 `readGamepad` 会轮询请求的 navigator 槽位（默认为 0）。非法的负数或非整数槽位会抛出 `RangeError`。当 Gamepad API 缺失、权限被拒或槽位缺失/未连接时返回 `null`。返回结果会拷贝 `axes` 和每个按钮对象，因此后续浏览器更新不会篡改早先的快照。不强加死区、Nintendo/Xbox 键位猜测、设备事件、震动或 XR 策略。仅当 `mapping === "standard"` 时才保证标准的按钮/摇杆轴布局。

## 验证与文件清单

- `input/keyboard-input.ts`、`pointer-input.ts`、`gamepad-input.ts`：各输入设备家族实现。
- `tests/lite/unit/*-input.test.ts`：身份标识、清理、单位以及独立快照测试。
- `tests/lite/plumbing/device-input.spec.ts`：真实浏览器输入与相机共存测试。
- `tests/lite/build/device-input.test.ts`：根类型声明与 Tree-shaking 隔离测试。
- `lab/lite/device-input.html` 与 `lab/lite/src/device-input.ts`：纯 DOM 测试夹具。
- `playground/examples/device-input.ts`：WASD/指针/手柄渲染循环示例。
- 迁移指南：[Porting guide](../03-porting-guide.md#原始游戏输入)。
