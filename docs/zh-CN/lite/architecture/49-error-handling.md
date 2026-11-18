# 模块：错误处理

> 包路径：`packages/babylon-lite/src/lite-error.ts`、`packages/babylon-lite/src/enable-error-decoding.ts`、
> `packages/babylon-lite/src/error-messages.ts`、`scripts/lite-error-plugin.ts`
> 公共导出：`enableErrorDecoding`、`decodeError`

## 用途

将面向开发者的冗长错误文本**排除在每一个发布的 bundle 之外**，同时在真正需要时仍能还原出完整信息。

长段可读的错误字符串开销出人意料地大：哪怕绝大多数应用从未读取过它们，每句 `throw new Error("…detailed message…")` 都会把其字面文本打包进生产环境 bundle。Babylon Lite 将这些文本移入一个独立的、按需懒加载的 `code → message` 查找表中，使发布出去的运行时仅携带紧凑的数字代码——并提供两种显式方式来还原真实消息。

## 默认行为：错误仅表现为代码

在构建时，一个 Vite 插件（`scripts/lite-error-plugin.ts`）会将内部每一处 `throw new Error("…")` 重写为 `ThrowLiteError(code, …args)`。在运行时，抛出的 Babylon Lite 错误携带：

- **`error.message`** —— 纯代码，格式为 `#<code>`（例如 `#12`）。
- **`error.lite`** —— 一个数组，包含原始消息本应插值的运行时值（出错的网格名称、无效尺寸等）。

冗长的消息文本存放在一个**默认不加载**的表中。一个从不解码错误的场景无需为这些消息字符串支付任何体积代价——这正是设计的初衷，也是 bundle 体积缩减的来源。

```text
// What you see by default when a Lite error is thrown:
Error: #12
```

这是有意为之。只要你不主动启用，就无需为文本体积买单。当你*确实*需要消息时，请选择下面两种 API 之一。

## 选项 1 —— `enableErrorDecoding()`：始终显示完整消息

导入它并调用一次（通常在开发环境中，或在全局错误处理器中）。导入该函数本身会将消息表 chunk 拉入你的 bundle；调用本身仅用于安装解码器。从这一刻起，**之后抛出的每一个错误**——无论是否被捕获——都会像普通 `Error` 一样通过 `error.message` 报告完整的可读文本。

```typescript
import { enableErrorDecoding } from "@babylonjs/lite";

// e.g. during development, or behind a debug flag
enableErrorDecoding();

// Any Lite error thrown after this point self-describes:
//   Error: Mesh "hull" has no position data
```

由于导入该函数会将消息表 chunk 拉入 bundle，**请尽量不要将其包含在生产构建中**——包含它会让每位从未遇到错误的用户白白失去体积优化收益。如果你只想在开发时启用，请将其放在开发/调试标志或动态导入之后。

## 选项 2 —— `decodeError(error)`：按需即时解码

`decodeError` 能够从**单个被捕获的错误**中重建完整消息，并且**即使从未调用过 `enableErrorDecoding()` 也能工作**。它会从 `#<code>` 消息中读回代码并从 `error.lite` 中读取参数，然后查表生成最终字符串。

```typescript
import { decodeError } from "@babylonjs/lite";

try {
    // …some Lite call…
} catch (err) {
    const message = decodeError(err); // full human-readable message
    telemetry.report(message);
}
```

如果该错误已经被解码（抛出时已启用解码）或不是 Babylon Lite 编码错误，`decodeError` 会原样返回其消息，因此随时调用它都是安全的。

### 生产环境遥测用例

这正是 `decodeError` 的设计目标。在生产环境中，你刻意**不调用** `enableErrorDecoding()`（使消息表远离发布 bundle），但当意外错误真的触发时，你仍需要其详细信息用于日志或遥测。此时**仅在该时刻**通过动态导入加载解码器，这样消息表的成本就会延迟支付——且仅在错误实际发生时才会加载：

```typescript
try {
    // …
} catch (err) {
    const { decodeError } = await import("@babylonjs/lite");
    telemetry.report(decodeError(err)); // full message, reconstructed after the fact
}
```

只有当 `decodeError`（或 `enableErrorDecoding`）被实际引用时，才会获取消息表 chunk，因此从未导入这两者的构建产物不会携带任何错误消息文本。

## 如何选择

| 你的需求…                                                             | 使用方式                     | Bundle 开销                                              |
| --------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| 始终在**每个**错误上显示完整消息（开发 / 调试）                       | `enableErrorDecoding()` | 在导入它的位置拉入消息表                                |
| 从**特定被捕获的**错误获取完整消息，无需全局设置                      | `decodeError(error)`    | 在导入它的位置拉入消息表                                |
| 最小化生产 bundle，仅在错误触发时懒加载解码                           | 在 `catch` 内通过 `await import(...)` 使用 `decodeError` | 仅当实际解码错误时才拉取消息表 |
| 无需求 —— 你从不读取 Lite 错误文本                                    | *(默认)*                | **零** —— 不附带任何消息文本                            |

> 插值参数附加在错误对象上，而不是提前序列化进消息中。这让每个场景的 bundle 更小、为解码保留完整的保真度，并保证错误构造本身绝不会抛出异常。
