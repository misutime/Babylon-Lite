# 模块：flow-graph

> 包路径：`packages/babylon-lite/src/flow-graph/`
>
> 状态：**已实现 / 当前兼容性基线已完成**。本文档是 Babylon Lite 的 `FlowGraph` 运行时、稳定版 glTF `KHR_interactivity` 支持以及 Babylon.js Flow Graph Editor JSON 兼容性的正式规范。

---

## 用途

流图（flow graph）是 Babylon 的**可视化脚本 / 行为运行时**：一个由节点（“块 / blocks”）组成的有向图，用于响应引擎事件并驱动场景行为（属性动画、播放声音、条件分支、数学运算）。其最主要的现实消费者是 glTF **`KHR_interactivity`** 扩展，它将交互图嵌入 `.glb` 中并期望引擎在运行时执行它。

**本次移植的目标：** 加载并运行交互式 glTF 资产，并执行由 Babylon.js Flow Graph Editor 保存的 JSON。两种格式是在同一套纯状态运行时之上的独立解析器前端：

1. 一个最小化的**纯状态运行时**（图 + 上下文 + 连接模型），
2. `KHR_interactivity` 所映射到的**块（blocks）**，
3. **`loader-gltf` 扩展**，用于将交互性 JSON 解析为 Lite 图并将 JSON 指针解析为场景访问器，以及
4. 一个 **editor-JSON 适配器**，将 Babylon.js 序列化的块图翻译为同一套 Lite 图表示。

调试器一致性以及 Lite 支持的块注册表之外的仅编辑器块留待后续工作。加载编辑器的协调器（coordinator）与遗留单图 JSON 格式在本次范围内；不支持的仅编辑器块类会给出精确的诊断信息并失败，而不会被静默丢弃。

> **规范稳定性说明（修改 `flow-graph/gltf/` 前必读）：**
> `KHR_interactivity` 已达到 Khronos 发布候选（release-candidate）状态并于 2026 年 7 月提交批准，但经检查的源尚未确认最终批准。Babylon.js 已替换了本次移植最初镜像的实现。因此，本移植继续将所有依赖规范的代码隔离在 `flow-graph/gltf/` 中，并记录精确的参考提交，以便未来的修订保持局部化。

---

## 架构决策：纯状态，而非类

Babylon.js 的 `FlowGraph` 是一个深层的 OOP 类层次结构（`FlowGraphBlock` → `FlowGraphExecutionBlock` → `FlowGraphAsyncExecutionBlock` → `FlowGraphEventBlock`），每个节点上都有方法，使用**全局类注册表**（`RegisterClass`）进行反序列化，并在模块作用域分配 `new RichType(...)`。这些在 Lite 中均不被允许（GUIDANCE §4b′ 纯状态接口、§4 零模块级副作用、100% 可 tree-shaking）。

**Lite 将相同语义重构为数据 + 函数：**

| 关注点           | Babylon.js (OOP)                                     | Babylon Lite (纯状态)                                                                                 |
|---|---|---|
| 节点             | 带方法的 `class FooBlock extends FlowGraphBlock`     | `FgBlock` **纯数据** + 一组**纯函数**记录 `FgBlockDef`                                                |
| 节点行为         | `block._execute(ctx)` 方法                           | `def.execute(block, ctx, env, signal)` 独立函数                                                       |
| 数据输出计算     | `block._updateOutputs(ctx)` 方法                     | `def.updateOutputs(block, ctx, env)` 独立函数                                                         |
| 类型信息         | 模块作用域的 `class RichType` 实例                   | `FgType` const 对象字符串标签 + 纯函数 `defaultForType()`                                             |
| className → 构造 | 全局 `RegisterClass` 注册表（副作用）                | 可 tree-shaking 的 `getBlockDef(type)` 动态导入 switch                                                |
| 每次运行状态     | `FlowGraphContext` 实例上的字段                      | 由独立函数变更的 `FgContext` **纯数据**                                                               |
| 场景访问         | 块持有/查询 `Scene`                                  | 块**仅接触**由加载器连接好的访问器/句柄；场景**拥有并驱动**该图                                       |

使这一重构简洁的关键洞察在于：**BJS 已经将逐实例状态按键（块的 `uniqueId`）保存在 `FlowGraphContext` 中，而不是保存在块自身上。** 块本身几乎已经是一个无状态定义了。Lite 完成了最后一步——块成为*描述拓扑的纯数据*，所有行为全部移入纯函数注册表。这也意味着**移植一个块 = 编写一个小数据记录 + 一两个纯函数**，使未来的块移植保持机械化（参见配套技能 `port-flow-graph-block.md`）。

这镜像了 Lite 中既有的两个模式：

- **`loader-gltf/gltf-feature-registry.ts`** —— `[trigger, () => import(...)]` 元组，仅在需要时动态导入。块注册表采用相同思路。
- **BJS 自身的 `blockFactory`** —— 已经是一个可 tree-shaking 的动态导入 `switch`（无全局副作用）。我们保留这一形式，仅去掉其背后的类主体。

---

## 单向所有权与场景驱动模型（关键）

GUIDANCE §4b 禁止组件引用场景。流图显然需要读取/写入节点变换、在场景事件上触发并播放动画——因此其连线方式与动画子系统完全一致，采用控制反转：

- **场景拥有**这些图，通过一个**可选的** `scene._flowGraphs?: FgRuntime[]` 字段（纯数据）。对于非交互场景它保持为 `undefined`，并**由 `attachFlowGraph()` 惰性创建**——因此在未附着流图时，核心体积逐字节保持完全一致（已验证：逐场景 bundle 清单未受本子系统存在的影响）。
- 图通过场景现有的通用接缝**驱动**，而非在 `scene-core.ts` 中硬编码循环（GUIDANCE §4c′）：`attachFlowGraph()` 注册一个 `onBeforeRender(scene, cb)` 驱动器（与动画组的驱动方式完全相同）和一个 `onSceneDispose(scene, cb)` 清理函数。因此，流图驱动完全存在于 `flow-graph/scene-flow-graph.ts` 中，仅当有代码导入它（glTF 交互特性或用户代码）时才会被打包进 bundle。
- 块**绝不会看到场景**。任何依赖场景的内容都会由**加载器**预先解析为存储在 `FgEnv` 中的纯能力对象：
  - **对象访问器**（`FgAccessor { get, set?, target }`）—— 围绕已加载 Lite 场景对象的闭包，在解析 glTF JSON 指针时生成。`pointer/get` 块只需调用 `accessor.get()`。
  - **动画句柄** —— 指向 glTF 加载器已创建的 `AnimationGroup` 纯数据对象的引用。
  - **事件源** —— 由场景驱动器投喂的 `FgEventBus`（tick、start、pointer、key）。事件块订阅总线，而非订阅场景。

这使依赖箭头始终保持 **scene → flow-graph**，绝不反向，从而确保零循环依赖和完全的可 tree-shaking 性。

---

## 公共 API 接口

全部从 `packages/babylon-lite/src/flow-graph/index.ts` 导出，并从包 `index.ts` 重导出。所有内容均为纯数据 + 独立函数。

### 核心数据类型（`flow-graph/types.ts`）

```typescript
/** A value that can flow along a data edge. */
export type FgValue =
    | number | boolean | string
    | Vec2 | Vec3 | Vec4 | Quat | Mat4
    | FgInteger        // tagged 32-bit int (see CustomTypes below)
    | FgMatrix2D | FgMatrix3D
    | Color3 | Color4
    | null | undefined;

/** Type tags. */
export const FgType = {
    Any: "any",
    Number: "number",
    Boolean: "boolean",
    String: "string",
    Integer: "FlowGraphInteger",
    Vector2: "Vector2",
    Vector3: "Vector3",
    Vector4: "Vector4",
    Quaternion: "Quaternion",
    Matrix: "Matrix",
    Matrix2D: "Matrix2D",
    Matrix3D: "Matrix3D",
    Color3: "Color3",
    Color4: "Color4",
    /** glTF JSON Pointer string. The empty string is the null reference. */
    Reference: "ref",
} as const;
export type FgType = (typeof FgType)[keyof typeof FgType];

/** A data input/output port — plain data. */
export interface FgDataSocket {
    readonly name: string;
    readonly type: FgType;
    /** wired source (for inputs): producing block id + its output socket name */
    source?: { blockId: string; socket: string };
    /** literal fallback used when `source` is undefined */
    defaultValue?: FgValue;
}

/** A control-flow (signal) port — plain data. Push model. */
export interface FgSignalSocket {
    readonly name: string;
    /** wired targets (for outputs): consuming block id + its input signal name */
    readonly targets: { blockId: string; socket: string }[];
}

/** A node instance — PURE DATA describing topology + config only. */
export interface FgBlock {
    readonly id: string;
    readonly type: string;                 // FgBlockType value or "module/Name"
    readonly config?: Readonly<Record<string, unknown>>;
    readonly dataIn: readonly FgDataSocket[];
    readonly dataOut: readonly FgDataSocket[];
    readonly signalIn: readonly FgSignalSocket[];
    readonly signalOut: readonly FgSignalSocket[];
    /** declared by event blocks; which bus event activates them */
    readonly event?: FgEventType;
}

/** A parsed graph — pure data. */
export interface FgGraph {
    readonly blocks: readonly FgBlock[];
    /** id → block index, for O(1) edge resolution (built by the parser) */
    readonly byId: Readonly<Record<string, number>>;
    /** declared graph variables: name → { type, initialValue } */
    readonly variables: Readonly<Record<string, { type: FgType; value: FgValue }>>;
}
```

### 行为定义（`flow-graph/block-def.ts`）

```typescript
/** The shape a def declares when a block is instantiated. */
export interface FgBlockShape {
    dataIn?: FgDataSocket[];
    dataOut?: FgDataSocket[];
    signalIn?: FgSignalSocket[];
    signalOut?: FgSignalSocket[];
    event?: FgEventType;
}

/**
 * Pure behaviour record for one block type. No classes, no `this`.
 * Exactly ONE of these per block kind; this is what a porter writes.
 */
export interface FgBlockDef {
    readonly type: string;

    /** Declare sockets/signals from config (called once at instantiation). */
    readonly build: (config: Readonly<Record<string, unknown>> | undefined) => FgBlockShape;

    /** DATA blocks: compute outputs from inputs (PULL). Pure-ish: writes via setDataValue. */
    readonly updateOutputs?: (block: FgBlock, ctx: FgContext, env: FgEnv) => void;

    /** EXECUTION blocks: run when an input signal fires (PUSH). For async blocks
     *  this is also where a task is started, via addPending(ctx, block). */
    readonly execute?: (block: FgBlock, ctx: FgContext, env: FgEnv, incomingSignal: string) => void;

    /** ASYNC blocks: advance one outstanding task each frame (e.g. delay countdown,
     *  animation progress). The tick loop passes the specific FgPendingTask. */
    readonly onTick?: (block: FgBlock, ctx: FgContext, env: FgEnv, deltaMs: number, task: FgPendingTask) => void;
    /** ASYNC blocks: teardown hook called on dispose/cancel; mark tasks canceled. */
    readonly cancelPending?: (block: FgBlock, ctx: FgContext, env: FgEnv) => void;
}
```

### 执行上下文与环境（`flow-graph/context.ts`）

```typescript
/** Per-execution-instance MUTABLE state — plain data. */
export interface FgContext {
    /** data transport slots: `${blockId}:${socket}` → last value the producer wrote.
     *  NOT a validity cache — producers recompute on every pull (see execution model). */
    readonly connectionValues: Record<string, FgValue>;
    /** per-block scratch: `${blockId}:${key}` → value (counter state, async tokens, resolving guard) */
    readonly executionVariables: Record<string, unknown>;
    /** live graph variable values (seeded from FgGraph.variables) */
    readonly userVariables: Record<string, FgValue>;
    /** async task records, ticked each frame (deduped; carry cancel tokens) */
    readonly pending: FgPendingTask[];
    /** glTF graphs are right-handed; drives Z/handedness coercion on read */
    readonly rightHanded: boolean;
    /** @internal monotonic token source for addPending (unique task tokens) */
    _tokenSeq: number;
}

/** One outstanding async task (a delay, an animation). Token enables precise cancel. */
export interface FgPendingTask {
    readonly blockId: string;
    readonly token: number;    // unique per task; a block may own several concurrently
    canceled: boolean;
    /** set by onTick when finished; compacted out after the frame's pending loop */
    done: boolean;
    state: Record<string, unknown>; // e.g. remainingMs, delayIndex, animation handle
}

/** Per-graph RESOLVED capabilities, wired by the loader. Read-mostly. */
export interface FgEnv {
    readonly graph: FgGraph;
    /** block defs resolved up-front (awaited dynamic imports), type → def */
    readonly defs: Record<string, FgBlockDef>;
    /** scene-object accessors resolved from JSON pointers, keyed by pointer id */
    readonly accessors: Record<string, FgAccessor>;
    /** animation handles by glTF animation index */
    readonly animations: readonly AnimationGroup[];
    /** scene-owned capabilities blocks may invoke WITHOUT a scene reference:
     *  play/stop animation, create a temp interpolation group, subscribe to
     *  animation-end, etc. Provided by the loader/animation subsystem. */
    readonly caps: FgCapabilities;
    /** event bus the scene driver feeds */
    readonly events: FgEventBus;
}

export interface FgAccessor {
    readonly type: FgType;
    readonly get: () => FgValue;
    readonly set?: (value: FgValue) => void;
    readonly target?: unknown;
}
```

### 独立运行时函数（`flow-graph/runtime.ts`）

```typescript
/** PULL a data input: resolve source, run its def.updateOutputs, read cache. */
export function getDataValue(ctx: FgContext, env: FgEnv, block: FgBlock, socket: string): FgValue;
/** Write a data output into the cache (called from def.updateOutputs). */
export function setDataValue(ctx: FgContext, block: FgBlock, socket: string, value: FgValue): void;
/** PUSH a signal: for each target, dispatch into its def.execute. */
export function activateSignal(ctx: FgContext, env: FgEnv, block: FgBlock, socket: string): void;

/** Instantiate runtime state for a parsed graph. */
export function createFgContext(graph: FgGraph, opts?: { rightHanded?: boolean }): FgContext;
/** Build the resolved env (await needed defs, attach accessors/animations/bus).
 *  Editor-authored unknown block types fail loudly. KHR unsupported operations
 *  are translated to registered typed no-op blocks before this boundary. */
export function createFgEnv(graph: FgGraph, wiring?: FgWiring): Promise<FgEnv>;

/** One graph runtime = graph + context + env, owned by the scene. */
export interface FgRuntime {
    readonly graph: FgGraph;
    readonly context: FgContext;
    readonly env: FgEnv;
    started: boolean;
    /** @internal bus unsubscribe fns registered at start, called on dispose */
    _unsub: (() => void)[];
}

/** Convenience: build env (awaiting defs) + context in one call. */
export function createFgRuntime(graph: FgGraph, wiring?: FgWiring, opts?: { rightHanded?: boolean }): Promise<FgRuntime>;

/** Start the graph: subscribe ALL non-start receivers first (init-priority
 *  order), THEN fire `onStart` event blocks once. Idempotent. */
export function startFlowGraph(rt: FgRuntime): void;
/** Per-frame drive: pump tick events + advance pending async blocks. */
export function tickFlowGraph(rt: FgRuntime, deltaMs: number): void;
/** Tear down: cancel pending, clear caches, detach bus listeners. */
export function disposeFlowGraph(rt: FgRuntime): void;

// Pending-task helpers used by async block defs and the tick loop:
export function addPending(ctx: FgContext, block: FgBlock, state?: Record<string, unknown>): FgPendingTask;
export function stillPending(ctx: FgContext, task: FgPendingTask): boolean;
export function cancelPendingForBlock(ctx: FgContext, block: FgBlock): void;
export function compactPending(ctx: FgContext): void;
```

### 场景附着（`flow-graph/scene-flow-graph.ts`）

```typescript
/** Attach a runtime to a scene: starts on the first frame, ticks every frame,
 *  auto-disposed on scene dispose. Lazily creates `scene._flowGraphs`. Uses the
 *  generic onBeforeRender/onSceneDispose seams (no scene-core loop). */
export function attachFlowGraph(scene: SceneContext, rt: FgRuntime): void;
/** Detach + dispose a previously attached runtime. */
export function detachFlowGraph(scene: SceneContext, rt: FgRuntime): void;
```

### 块类型名称与注册表（`flow-graph/block-type.ts`、`block-registry.ts`）

```typescript
/** Lite block type identifiers. */
export const FgBlockType = {
    // Events
    SceneStart: "SceneReadyEvent",
    SceneTick: "SceneTickEvent",
    SendCustomEvent: "SendCustomEvent",
    ReceiveCustomEvent: "ReceiveCustomEvent",
    // Control flow
    Branch: "Branch",
    Sequence: "Sequence",
    Switch: "Switch",
    ForLoop: "ForLoop",
    WhileLoop: "WhileLoop",
    DoN: "DoN",
    MultiGate: "MultiGate",
    WaitAll: "WaitAll",
    Throttle: "Throttle",
    SetDelay: "SetDelay",
    CancelDelay: "CancelDelay",
    // Data / math (subset; see block list)
    Constant: "Constant",
    Add: "Add",
    Subtract: "Subtract" /* … */,
    // Pointer / variable / animation
    GetProperty: "GetProperty",
    SetProperty: "SetProperty",
    JsonPointerParser: "JsonPointerParser",
    GetVariable: "GetVariable",
    SetVariable: "SetVariable",
    ValueInterpolation: "ValueInterpolation",
    PlayAnimation: "PlayAnimation",
    StopAnimation: "StopAnimation",
    // Debug
    ConsoleLog: "ConsoleLog",
} as const;
export type FgBlockType = (typeof FgBlockType)[keyof typeof FgBlockType];

/**
 * Tree-shakable, side-effect-free. Returns a lazy loader for one def.
 * Unused cases are code-split and never fetched — zero bytes for scenes
 * without interactivity. Mirrors BJS blockFactory + Lite gltf-feature-registry.
 */
export function getBlockDef(type: string): () => Promise<FgBlockDef> {
    switch (type) {
        case FgBlockType.Branch:
            return async () => (await import("./blocks/control-flow/branch.js")).branchDef;
        case FgBlockType.Add:
            return async () => (await import("./blocks/math/add.js")).addDef;
        // … one case per supported block …
        default:
            return null; // unknown type — caller decides (see note)
    }
}
```

> **关于副作用的说明：** `switch` 函数体是纯函数（无模块级分配），因此注册表模块完全可 tree-shaking。
>
> **未知操作：** `getBlockDef` 返回 `null`；由各个解析器选择策略。稳定版 `KHR_interactivity` 要求将不受支持的声明转换为显式的**类型化空操作（typed no-op）**，以便该图的其余部分仍可执行。解析器会报告不受支持的操作，并在空操作上保留该声明所声明的插槽。无效的图结构则不同：仅拒绝该图并继续加载资产中的其他图。Editor JSON 是专门针对 Babylon 块编写的，因此未知的 `className` 会携带其块 id 和类名显式失败。

---

## 内部架构

### 执行模型（拉取数据、推送信号）

语义与 BJS 完全相同，以函数式重新表达：

- **数据边采用拉取（PULL）模式，并在每次拉取时重新计算。** 当某个块需要输入时，`getDataValue` 会查看插槽的 `source`。如果已连线，它会找到生产块并**每次都调用该块的 `def.updateOutputs`**（匹配 BJS 的 `FlowGraphDataConnection.getValue`，后者在每次读取时调用所有者的 `_updateOutputs`）。`ctx.connectionValues` 是生产者写入、消费者读回的**传输槽位**——**而非**有效性缓存。**切勿**基于缓存值跳过重新计算：诸如 `pointer/get`、`GetVariable`、`random` 和事件载荷输出等非纯生产者在同一次级联中若经历过 `pointer/set`/`SetVariable` 后会返回过期数据。（未来的优化可以加入带级联 ID 的显式脏跟踪，但必须排除所有非纯生产者；MVP 版本总是重新计算。）
- **环路。** 数据拉取假定数据子图为无环图（正如 glTF 交互性所要求的那样）。`getDataValue` 携带一个进行中守卫（`ctx.executionVariables["${id}:resolving"]`），用于打断意外的数据环路并返回插槽默认值，而不是无限递归。
- **读取时的类型强制转换。** `getDataValue` 会依次应用 (a) 由声明映射器声明的任何插槽/端口 `dataTransformer`，然后应用 (b) 针对消费者插槽 `FgType` 的 `coerceValue`——这正是 BJS 的 RichType `typeTransformer` 所在之处（尤其是 `Vector4`/`Matrix` → `Quaternion`）。强制转换发生在边界处，因此块主体保持类型干净。
- **信号边采用推送（PUSH）模式。** `activateSignal` 遍历 `signalSocket.targets`；对每个目标，它查找目标块的定义并调用 `def.execute`，同时传入输入信号名称。执行块在其自身输出上调用 `activateSignal` 以继续级联。
- **事件块**声明 `event: FgEventType`。场景驱动器在收到总线事件时，找到匹配的事件块并触发其输出信号（`out` / `done`），从而启动一次级联。**监听器注册顺序至关重要：** `startFlowGraph` 首先订阅/初始化*所有*事件接收器（按初始化优先级顺序——`ReceiveCustomEvent` 先于场景启动类事件，匹配 BJS 的 `initPriority`），*然后*才触发 `onStart` 级联。否则类似 `onStart → SendCustomEvent → ReceiveCustomEvent` 的图会因为接收器尚未监听而丢弃事件。自定义事件是**场景/协调器作用域**的，而非按图隔离，因此同一资产中的多个 `KHR_interactivity` 图可以互相通信。
- **异步块**（`SetDelay`、`PlayAnimation`）通过 `addPending(ctx, block)` 注册一个 `FgPendingTask`（该函数会分配唯一令牌并**去重**，以免已处于挂起状态的块被重入时重复 tick），每帧接收 `onTick`，完成后触发完成信号（`done`），然后移除任务。单个块可以拥有**多个并发任务**（BJS 支持每个块同时存在多个在途延迟，按索引跟踪）——状态存储在任务记录上，而非块上。`cancelPending` 将匹配的任务标记为 `canceled`；tick 循环会跳过已取消/已移除的任务（见下文）。

### 异步任务生命周期（顺序隐患）

每帧挂起任务循环必须具备取消安全性。在循环**期间**，另一个块的信号级联可能会取消任务或添加新任务。规则：

```
for task of ctx.pending.slice():          // snapshot
  if task.canceled: continue              // skip if canceled this frame
  if !stillPending(ctx, task): continue   // skip if already removed
  env.defs[blockOf(task)].onTick(task, …) // may add/cancel further tasks
ctx.pending = ctx.pending.filter(t => !t.canceled && !t.done)  // compact after
```

在循环中途添加的任务将在下一帧被拾取（不会在当帧补 tick），与 BJS 一致。每个 `FgContext` 拥有自己的 `pending` 列表，因此多个上下文（多角色）互不干扰。

### 每帧流程

```
scene._beforeRender(deltaMs)               // existing Lite hook
  └─ for rt of scene._flowGraphs:
       if !rt.started:
         registerEventListeners(rt)         // subscribe ALL receivers first (init-priority order)
         startFlowGraph(rt)                  // THEN fire onStart event blocks once
       tickFlowGraph(rt, deltaMs):
         resetCustomEventRecursionCounters(rt.context)   // guard against runaway re-entrancy
         env.events.pump("tick", { deltaTime: deltaMs/1000 })  // → onTick blocks
         for task of ctx.pending.slice():   // cancellation-safe (see async lifecycle)
           if task.canceled || !stillPending(ctx, task): continue
           env.defs[blockOf(task)].onTick?.(task, ctx, env, deltaMs)
         compactPending(ctx.context)
```

指针/按键事件由拾取/输入层投喂进 `env.events`；事件块只需订阅相应的总线通道。指针选择是一项显式能力：当场景使用指针事件块时，请调用 `enableFlowGraphPointerPicking(scene)`。这使 GPU 拾取器远离非交互式 glTF bundle。拾取分派与可选取性均限定在拥有被拾取网格的 glTF 资产范围内，因此同一场景中的不同资产可以安全地复用相同的节点索引。

### 自定义数学与类型保留在子系统内部（bundle 纪律）

Lite 的核心 `math/` 模块有意保持极简（以 Vec3 为中心；**没有 Vec2，没有通用四元数/矩阵代数**）。流图数学块需要 Vec2、四元数乘法/共轭/球面插值、矩阵转置/行列式/求逆/组合/分解、整数位运算等。根据 GUIDANCE §4c′（始终作为扩展，绝不使核心膨胀），这些辅助函数位于 **`flow-graph/` 内部**（例如 `flow-graph/fg-math.ts`、`flow-graph/custom-types/`），由使用它们的块惰性导入。没有交互性的场景支付**零字节**。当核心 `math/` 已经满足需求时予以复用（`addVec3`、`dotVec3`、`crossVec3`、`multiplyMat4`、`invertMat4`、`composeMat4`、`decomposeMat4`、`createMat4FromQuat`）。

### 自定义类型（`flow-graph/custom-types/`）

- `FgInteger` —— glTF 区分 `int` 与 `float`；表示为带标签的纯对象 `{ value: number; __fgInt: true }`（无类），使类型强转与位运算能够工作。提供纯辅助函数 `fgInt(n)`、`isFgInt(v)`。
- `FgMatrix2D` / `FgMatrix3D` —— 基于纯 `Float32Array`（`{ m: Float32Array }`），用于 `float2x2` / `float3x3` glTF 类型，附带纯运算辅助函数。
- `Vec2` —— 添加到 `flow-graph/types.ts`（或小型局部模块），因为核心数学库缺少它。

### 不使用 RichType 实例实现 Rich-type 行为（`flow-graph/rich-type.ts`）

BJS 的 `RichType` 携带三项内容，Lite 虽去掉了该类但必须保留这三项行为：**默认值（default value）**、**typeTransformer** 和 **animationType**。

- `defaultForType(t: FgType): FgValue` —— 返回该类型默认值的纯 switch（例如 `0`、`false`、新构造的 `Vec3.zero`、单位四元数）。取代 `RichType.defaultValue`。在**函数内部**构造值（无模块级分配）。
- `coerceValue(value, target: FgType): FgValue` —— BJS 的 `typeTransformer` 所在之处。关键包括 **`Vector4`/`Matrix` → `Quaternion`** 以及数值↔整数强转。读取时由 `getDataValue` 调用（上文步骤 (b)），当配置/插槽声明了不同于其 `gltfType` 的 `flowGraphType` 时也由映射器调用。
- `animationTypeForFgType(t: FgType): number` —— 取代 `RichType.animationType`，由 `ValueInterpolation`/动画块用于选择正确的关键帧插值方式（浮点/向量/四元数/颜色/矩阵）。四元数目标必须解析为 slerp；映射器的 `useSlerp` 标志会强制使用 `FgType.Quaternion`。

这三个纯函数完全替代了 `RichType` 类及其实例。

---

## glTF `KHR_interactivity` 加载器扩展

> 包路径：`packages/babylon-lite/src/loader-gltf/gltf-feature-interactivity.ts`
> 外加用于解析器 + 声明映射器的 `flow-graph/gltf/`。

### 发布候选规范 —— 保持翻译层隔离

该移植最初针对 **[PR #18455](https://github.com/BabylonJS/Babylon.js/pull/18455)** 尚未合并时的 Babylon.js 提交 `8f728b23ea`。该目标已过时。兼容性刷新针对：

- Khronos glTF 仓库提交 `fdb8ce0e2e0b7ecf3466f8dacb9f1385257b8276`。
- Babylon.js 提交 `bd3837eed0890e590fdd6aeb6cc4d605e4eb8ac7`。

该发布候选版已于 2026 年 7 月提交批准；在记录这些提交时最终批准尚未确认。因此，操作集、对象模型和校验规则仍可能演进。

**设计规则（强制）：** 易变的规范相关接口必须**隔离在 `flow-graph/gltf/` 中**并单向依赖运行时，绝不允许反向依赖。运行时核心（`runtime.ts`、`block-def.ts`、`context.ts`、各块）必须包含**零** glTF/`KHR_interactivity` 知识，因此规范修订绝不会触及引擎——只影响 `gltf/` 翻译层：

- `interactivity-parser.ts` —— nodes/declarations/variables/flows 的 JSON 结构。
- `declaration-mapper.ts` —— op→block 表（最容易变动的部分）。
- `path-converter.ts` + `object-model-mapping.ts` —— JSON 指针语义。
- 在映射器文件头及测试中记录精确的 Khronos/Babylon.js 参考提交。

**降低未来规范变更成本的实用护栏：**
- 将 op→block 映射保持为**纯数据表**而非代码，使修改体现为数据 diff（也使未来“导入 BJS 表”保持机械化）。
- 更新任一参考时，对照记录的 Babylon.js 提交重新 diff `declaration-mapper.ts`。保留一个操作覆盖率测试，对比所有已知原生操作与已注册映射。
- 不要发明资产级版本开关：发布候选扩展没有此类区分符。如果未来修订添加了版本开关，再在此翻译边界处分支。
- 未知操作会产生结构化诊断信息和类型化空操作块。结构/模式违规仅拒绝受影响的图。
- 配套技能（`port-flow-graph-block.md`）是随着规范和 BJS PR 演进吸收新增/变更操作的标准流程。

### 注册（无副作用，惰性）

向 `gltf-feature-registry.ts` 添加一个元组，与其他所有特性一致：

```typescript
["KHR_interactivity", () => import("./gltf-feature-interactivity.js")],
```

该特性实现 `GltfFeature.applyAsset(meshes, root, ctx)`：

1. 读取 `ctx._json.extensions.KHR_interactivity`。`graphs` 为必填；可选的 `graph` 选择默认图。
2. 对每个图运行 **interactivity parser** → `FgGraph`（纯数据）。按图捕获解析/校验错误，使单个无效图不会导致整个资产无效。
3. 通过路径转换器（Lite 中对应 BJS 的 `gltfPathToObjectConverter` + `objectModelMapping`）将图中的 **JSON 指针解析**为针对已构建 Lite 场景对象（节点/网格/相机/材质/动画）的 `FgAccessor`。
4. 构建 `FgEnv`（等待所需的块定义、附着访问器/动画/事件总线）。
5. 在 `AssetContainer` 中返回成功解析的图，并贡献一个延迟的 `_sceneSetup` 钩子。`addToScene` 使用目标场景的共享事件总线解析运行时，将其推入 `scene._flowGraphs`，并注册配对清理。调用方无需手动调用 `runFlowGraphs`。

> 加载器会设置等价于 BJS 的 `_skipStartAnimationStep` —— 被交互性引用的动画**不得**自动播放；由图控制它们。

### 交互性解析器（`flow-graph/gltf/interactivity-parser.ts`）

纯翻译每个 glTF 交互图（`types`、`declarations`、`variables`、`events` 和 `nodes`）为 `FgGraph`。各阶段镜像 BJS 的 `InteractivityGraphToFlowGraphParser`：`parseTypes → parseDeclarations → parseVariables → parseEvents → parseNodes → parseConnections`。输出为纯数据——**没有块实例，没有类注册表**。

glTF→Lite 类型表（来自 BJS，原样保留）：

| glTF 类型  | 长度   | FgType    | 元素                              |
|---|---|---|---|
| `float`    | 1      | Number    | number                            |
| `bool`     | 1      | Boolean   | boolean                           |
| `int`      | 1      | Integer   | number                            |
| `float2`   | 2      | Vector2   | number                            |
| `float3`   | 3      | Vector3   | number                            |
| `float4`   | 4      | Vector4   | number                            |
| `float2x2` | 4      | Matrix2D  | number                            |
| `float3x3` | 9      | Matrix3D  | number                            |
| `float4x4` | 16     | Matrix    | number                            |
| `ref`      | 1      | Reference | JSON Pointer 字符串（`""` = null）|

发布候选解析器语义：

- 类型/默认值校验遵循 Khronos schema。在规范指定的地方，数值、向量和矩阵默认值保留规范的 NaN 默认值。
- `events` 声明自定义事件 id 和类型化载荷字段。Send/receive 块使用这些声明确定插槽类型和默认值。
- 事件接收器暴露一个不透明的事件引用。`event/stopPropagation` 会消耗它，并阻止同一次分派中后续的接收器运行。
- glTF 自定义事件投递默认是异步的。协调器的 editor-JSON `dispatchEventsSynchronously` 选项仍可独立配置。
- 已连接的动画时间输入在运行时从秒转换为帧；常量可以预先转换。
- 指针模板校验所有占位符并支持动态段。虚拟/对象模型指针包括发布候选的 active-camera、capability/limit、event-reference、delay 和 animation-state 接口。

### 声明映射器（`flow-graph/gltf/declaration-mapper.ts`）

最大的单个工件（当前 BJS = **135 个原生操作**）。它是一张**数据表**，将每个 glTF 操作（`"math/add"`、`"flow/branch"`、`"pointer/set"` 等）映射到：目标 Lite 块类型、插槽重命名、配置翻译、值转换器（例如动画时间的秒→帧），以及多块展开（例如 `pointer/set` → 通过块间连接器相连的 `SetProperty` + `JsonPointerParser`）。这是纯数据 + 小型纯转换器函数——没有类。移植条目是持续工作的主体，也正是配套**技能**自动化的内容。

```typescript
export interface FgDeclMapping {
    blocks: FgBlockType[];
    inputs?: { values?: Record<string, FgPortMap>; flows?: Record<string, FgPortMap> };
    outputs?: { values?: Record<string, FgPortMap>; flows?: Record<string, FgPortMap> };
    configuration?: Record<string, FgPortMap>;
    interBlockConnectors?: { input: string; output: string; inBlock: number; outBlock: number }[];
    extraProcessor?: (gltfBlock: unknown, /* … */) => FgBlock[];
}
export function getMappingForOp(op: string, extension?: string): FgDeclMapping | undefined;
```

---

## 块覆盖范围（`KHR_interactivity`）

`KHR_interactivity` 通过配置将 135 个原生操作映射到更少的 Lite 块类型上。本次刷新补齐了原 126 操作目标中缺失的十个操作：`event/stopPropagation`、`math/Tau`、`math/smoothStep`、`math/rgbToOkLCh`、`math/rgbFromOkLCh`、`math/quatSlerp`、`math/slerp`、`ref/eq`、`math/quatFromUpForward` 和 `math/quatFromAngles`。

- **事件（4）：** `onStart`→SceneStart、`onTick`→SceneTick、`event/send`→SendCustomEvent、`event/receive`→ReceiveCustomEvent。
- **流控制（11）：** branch、sequence、switch、while、for、doN、multiGate、waitAll、throttle、setDelay、cancelDelay。
- **数学常量/算术/比较/三角/指数（约 60 个操作 → 约 40 个块）：** E、Pi、Inf、NaN、random；abs/sign/trunc/floor/ceil/round/fract/neg；add/sub/mul/div/rem/min/max/clamp/saturate/mix；eq/lt/le/gt/ge/select；sin…atanh；exp/log/log2/log10/sqrt/cbrt/pow；isNaN/isInf；rad/deg。
- **向量/矩阵/四元数（约 25 个操作）：** length、normalize、dot、cross、rotate2D/3D、transform、transpose、determinant、inverse、matMul、matCompose/Decompose、combineN/extractN、quat 操作。
- **整数位运算（9）：** not/and/or/xor/asr/lsl/clz/ctz/popcnt。
- **类型转换（6）：** bool/int/float 交叉转换。
- **变量（3）：** get、set、interpolate。
- **指针（3）：** get、set、interpolate（+ JsonPointerParser）。
- **动画（3）：** start、stop、stopAt（+ ArrayIndex / 数据提供器）。
- `flow/log` 是 Babylon 扩展操作而非原生 KHR 操作。`event/onSelect` 继续通过 `KHR_node_selectability` 保持扩展命名空间。

每个块都是 `flow-graph/blocks/<category>/<name>.ts` 下的一个小文件，导出一个 `FgBlockDef`。确切的文件模板请参阅技能文档。

---

## 状态机 / 生命周期

```
load .glb with KHR_interactivity
  └─ gltf-feature-interactivity.applyAsset
       ├─ interactivity-parser → FgGraph (pure data)
       ├─ path-converter → FgAccessor map
       ├─ createFgEnv (await needed defs, wire bus/accessors/animations)
       ├─ createFgContext (seed userVariables)
       └─ return { flowGraphs:[ FgRuntime ] }
addToScene
  └─ scene._flowGraphs.push(rt); onBeforeRender(scene, drive); onSceneDispose(scene, () => disposeFlowGraph(rt))
first frame
  └─ registerEventListeners(rt)   // subscribe ALL receivers first, init-priority order
  └─ startFlowGraph(rt)           // THEN fire onStart cascade once
each frame
  └─ tickFlowGraph(rt, deltaMs)   // reset recursion counters → pump tick → advance pending async
dispose
  └─ disposeFlowGraph(rt)         // cancel pending tasks, clear ctx, detach bus listeners
```

---

## Babylon.js 等价映射

| Babylon.js                                         | Babylon Lite                                                          |
|---|---|
| `FlowGraphBlock`（类）                             | `FgBlock`（数据）+ `FgBlockDef`（函数）                               |
| `FlowGraphExecutionBlock._execute`                 | `FgBlockDef.execute`                                                  |
| `FlowGraphBlock._updateOutputs`                    | `FgBlockDef.updateOutputs`                                            |
| `FlowGraphAsyncExecutionBlock`                     | `FgBlockDef.execute`（启动任务）+ `onTick(task)` + `cancelPending`    |
| `FlowGraphEventBlock`                              | `FgBlock.event` + 场景驱动的总线分派                                  |
| `FlowGraphDataConnection.getValue/setValue`        | `getDataValue` / `setDataValue`                                       |
| `FlowGraphSignalConnection._activateSignal`        | `activateSignal`                                                      |
| `FlowGraphContext`                                 | `FgContext`（数据）+ `FgEnv`（已解析能力）                            |
| `FlowGraphCoordinator`（多图）                     | `scene._flowGraphs` + 场景驱动器                                      |
| `FlowGraphSceneEventCoordinator`                   | 由场景/输入层投喂的 `FgEventBus`                                      |
| `RichType` 实例                                    | `FgType` const 对象 + `defaultForType()`                              |
| `RegisterClass` 全局注册表                         | `getBlockDef` 动态导入 switch                                         |
| `blockFactory`（已是惰性的）                       | `getBlockDef`（相同形状，无类）                                       |
| `gltfPathToObjectConverter` + `objectModelMapping` | `flow-graph/gltf/path-converter.ts` → `FgAccessor`                    |
| `InteractivityGraphToFlowGraphParser`              | `flow-graph/gltf/interactivity-parser.ts`                             |
| `declarationMapper.ts` 表                          | `flow-graph/gltf/declaration-mapper.ts` 表                            |
| `KHR_interactivity` 加载器扩展                     | `loader-gltf/gltf-feature-interactivity.ts`                           |

---

## 依赖项

- **核心数学**（`src/math/`）：复用 `addVec3`、`dotVec3`、`crossVec3`、`multiplyMat4`、`invertMat4`、`composeMat4`、`decomposeMat4`、`createMat4FromQuat`。
- **动画**（`src/animation/`）：用于动画块的 `AnimationGroup` 句柄；`ValueInterpolation` 尽可能复用插值/缓动机制。
- **场景**（`src/scene/`）：`onBeforeRender`、`onSceneDispose`、`addToScene` 分派，以及 `_flowGraphs` 数组（新增字段）。
- **Loader-gltf**（`src/loader-gltf/`）：`GltfFeature` 钩子 + 注册表元组；供路径转换器解析的节点/材质/相机映射。
- **拾取/输入**：将指针与按键事件转发至 `FgEventBus`；GPU 指针桥接通过 `enableFlowGraphPointerPicking` 显式启用。
- **新增子系统局部模块：** `flow-graph/fg-math.ts`、`flow-graph/custom-types/`。

---

## 测试规范

- **单元测试（vitest）：** 逐块定义测试——输入测试数据，断言输出/信号（纯函数，极易测试）。运行时：**拉取重算**（验证生产者每次读取都重新运行，无过期缓存）、推送级联、带**tick 中途取消**和**每块多并发延迟**的异步延迟倒计时、带**先监听器后 onStart 顺序**的事件分派（从 `onStart` 触发的自定义事件能够被接收）。
- **数学一致性测试（聚焦）：** 四元数乘法/共轭/球面插值、矩阵组合/分解/转置/求逆、`math/transform`，以及**访问器边界手性**（右手系 glTF 值 → Lite 左手系）——这些是最容易在乘法顺序或行/列主序布局上产生分歧的地方。
- **强转测试：** 通过 `coerceValue` 进行 `Vector4`/`Matrix` → `Quaternion` 转换；`animationTypeForFgType` 为四元数目标选择 slerp。
- **解析器单元测试：** 代表性交互性 JSON → 期望的 `FgGraph` 拓扑；声明映射器条目 → 期望的块/插槽/配置；不支持的操作 → 类型化空操作 + 诊断；格式错误的图 → 仅拒绝该图。
- **Editor JSON 测试：** 由当前 Babylon.js Flow Graph Editor 保存的协调器与遗留单图夹具；富值/默认值/上下文恢复；按 connection-point id 重建连接；执行解析后的图；未知编辑器块 → 精确诊断。
- **集成 / 一致性：** 在 Lite 中加载一个 `KHR_interactivity` 示例 `.glb`（例如 Khronos 示例，如点击时产生动画的按钮，或 `onStart`→旋转）；断言被驱动的属性随帧变化。在需要视觉基准图的地方，遵循 §2c 动画场景基准约定（`?seekTime=` 冻结）。仅当添加一致性场景时，才添加 `scene-config.json` 条目 + bundle 体积上限。
- **Bundle 体积守卫：** 验证非交互性场景的 bundle **逐字节不变**（未使用时子系统必须被完全 tree-shake 掉）。

---

## 文件清单（目标）

```
packages/babylon-lite/src/flow-graph/
  index.ts                       # public exports
  types.ts                       # FgValue, FgType, FgBlock, FgGraph, sockets
  block-def.ts                   # FgBlockDef, FgBlockShape
  block-type.ts                  # FgBlockType const object + value-union type
  block-registry.ts              # getBlockDef() dynamic-import switch
  context.ts                     # FgContext, FgEnv, FgAccessor
  runtime.ts                     # getDataValue/setDataValue/activateSignal, FgRuntime, start/tick/dispose
  event-bus.ts                   # FgEventBus, FgEventType, subscribe/pump/clear
  fg-math.ts                     # Vec2 + quaternion/matrix/bitwise helpers (lazy)
  rich-type.ts                   # defaultForType(), coerceValue(), animationTypeForFgType()
  scene-flow-graph.ts            # attachFlowGraph/detachFlowGraph (onBeforeRender/onSceneDispose seams)
  graph-builder.ts               # imperative builder shared by parser adapters
  editor-serialization.ts        # coordinator/single-graph editor JSON → FgGraph
  custom-types/
    fg-integer.ts
    fg-matrix.ts
  blocks/
    events/{scene-start,scene-tick,send-custom-event,receive-custom-event}.ts
    control-flow/{branch,sequence,switch,for-loop,while-loop,do-n,multi-gate,wait-all,throttle,set-delay,cancel-delay}.ts
    math/{add,subtract,…}.ts
    data/{constant,get-variable,set-variable,get-property,set-property,json-pointer-parser}.ts
    animation/{play-animation,stop-animation,value-interpolation}.ts
    debug/console-log.ts
    no-op.ts
  gltf/
    interactivity-parser.ts
    declaration-mapper.ts
    path-converter.ts
    object-model-mapping.ts
packages/babylon-lite/src/loader-gltf/
  gltf-feature-interactivity.ts  # GltfFeature.applyAsset
  gltf-feature-registry.ts       # + ["KHR_interactivity", () => import(...)]
packages/babylon-lite/src/scene/
  scene-core.ts                  # + optional `_flowGraphs?` field (type-only; zero runtime cost)
```

> 注意：场景驱动器未硬编码在 `scene-core.ts` 中。`scene-flow-graph.ts` 通过现有的 `onBeforeRender`/`onSceneDispose` 接缝附着，因此非交互性场景逐字节保持一致（已对照 bundle 清单验证）。

---

## 分阶段实施计划

> 每个阶段均可独立合并；涉及引擎变更的阶段必须通过 `pnpm build:bundle-scenes` + `pnpm test:parity` 并提交重新生成的 `lab/public/bundle/manifest.json`（GUIDANCE §0c）。

**Phase 0 —— 规范与技能（本文档 + `port-flow-graph-block.md`）。** ✅ 完成 —— 无代码。

**Phase 1 —— 核心运行时，无块。** ✅ **完成。** `types.ts`、`block-def.ts`、`context.ts`、`runtime.ts`、`event-bus.ts`、`rich-type.ts`、`block-type.ts`、`custom-types/{fg-integer,fg-matrix}.ts`、`scene-flow-graph.ts` 以及一个空的 `block-registry.ts`。仅纯函数。24 个单元测试覆盖拉取重算、推送级联、分支路由、异步挂起（倒计时、去重、tick 中途取消、无回溯 tick）、事件分派 + 启动期间自定义事件顺序、tick 驱动、销毁、变量播种、未知操作显式失败以及 rich-type 默认值/强转。场景驱动通过 `onBeforeRender`/`onSceneDispose` 接缝连接。**守卫达成：** 非交互性 bundle 清单逐字节一致。

**Phase 2 —— 垂直切片（尽早端到端打通）。** 在编写长尾块库之前，实现证明整条管线的*最小*集合：`SceneStart`、`SceneTick`、`Branch`、`Sequence`、一个数学操作（`Add`）、`GetProperty`/`SetProperty` + `JsonPointerParser`、`PlayAnimation`/`StopAnimation`；加上一个**最小化**解析器 + 声明映射器（仅这些操作）+ 路径转换器 + `gltf-feature-interactivity.ts` 加载器钩子；再加上**一个** Khronos `KHR_interactivity` 示例作为一致性场景端到端运行。这可以立即暴露映射器/访问器/运行时/手性不匹配问题，而不必等到整个块库写完之后。

**Phase 3 —— 扩充块库。** 补齐剩余约 60 个块（完整数学/三角/指数、向量/矩阵/四元数、整数位运算、类型转换、变量、插值、控制流其余部分）+ `fg-math.ts` + `custom-types/**`；将每一项注册到 `block-registry.ts`。为每个定义编写单元测试。

**Phase 4 —— 完成原声明映射器。** ✅ 旧版 126 操作目标已完成。其他一致性场景仍为可选覆盖工作。

**Phase 5a —— 命令式构建器与场景协调器。** ✅ 完成。构建器创建与解析器前端相同的 `FgGraph` 纯数据。协调器拥有多个图、一个场景事件总线以及同步/异步自定义事件策略。

**Phase 5b —— 发布候选 KHR 刷新。** ✅ 当前 Lite 宿主接口已完成。基于记录的 Khronos 和 Babylon.js 提交重新确立解析器/映射器行为。添加十个操作缺口、`ref`、已声明事件/载荷、事件引用与传播、类型化空操作、逐图隔离、异步事件分派、动态指针段、扩展的对象模型指针，以及运行时动画时间转换。

**Phase 5c —— Babylon.js Flow Graph Editor JSON。** ✅ 已移植到 Lite 的序列化块类已完成。在 `gltf/interactivity-parser.ts` 旁添加第二个解析器前端。支持的输入形式：

```typescript
// Coordinator form
{ _flowGraphs: SerializedFlowGraph[], activeGraphIndex,
  dispatchEventsSynchronously, sceneSnippetId?, flowGraphSnippetId? }

// Legacy form
{ allBlocks: SerializedBlock[], executionContexts: SerializedContext[],
  name?, uniqueId?, rightHanded?, editorData? }
```

`SerializedBlock` 包含 `className`、`type`、`config`、`uniqueId`、数据/信号输入输出以及元数据。连接从连接点的 `uniqueId`/`connectedPointIds` 重建。值可来自连接的 `defaultValue` 或上下文的 `_connectionValues`；富值使用 `{ value, className }`。适配器将 Babylon 块类名映射到 Lite `FgBlockType`，恢复用户变量，并为每个序列化的执行上下文返回一个图/上下文记录。它还识别嵌入在 Babylon 专属 `BABYLON_flow_graph` glTF 扩展中的序列化 JSON。不支持的仅编辑器块会明确失败；它们不是类型化空操作。

**Phase 6+ —— 仅编辑器块一致性与调试器钩子。** 按需使用配套技能移植块。当前仅编辑器缺口包括输入、插值动画构造、防抖/触发器（debounce/flip-flop）、坐标变换、缓动/上下文/数组/代码、物理和音频块。

---

## 开放问题 / 风险

- **发布候选版变动。** 在记录参考提交时最终批准尚未确认。缓解措施仍为结构性的：所有依赖规范的代码均隔离在 `flow-graph/gltf/` 中，并严格对照精确的 Khronos/Babylon.js 提交；运行时核心保持与规范无关。
- **编辑器格式变动。** Editor JSON 是 Babylon.js 的序列化契约，而非 Khronos 格式。将其隔离在 `flow-graph/editor-serialization.ts` 中，测试当前官方夹具，并在序列化类未知时显式失败。
- **宿主对象模型广度。** 指针支持受限于 Lite 所暴露的概念。随着 Lite 增加更多 glTF 宿主对象，在 `path-converter.ts` 中补充访问器；不支持的指针保持为运行时无效，而非崩溃。
