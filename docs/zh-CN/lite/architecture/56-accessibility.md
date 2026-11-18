# 模块：无障碍访问（Accessibility）

> 包路径：`packages/babylon-lite/src/accessibility/`

## 用途

无障碍访问模块用于为场景对象存储描述性元数据，将场景状态投影为一个逻辑无障碍树（accessibility tree），并可将该树挂载为保持同步的 HTML。

逻辑树无需 DOM 即可使用。场景适配器与 HTML twin 是按需选用的根导出。导入 Babylon Lite 的其他特性不会创建任何无障碍状态、观察器或 DOM 节点。

常见的浏览器入口使用场景画布的父元素：

```ts
import { addToScene, createSceneHtmlTwin, setAccessibilityTag } from "@babylonjs/lite";

const twin = createSceneHtmlTwin(scene);

setAccessibilityTag(centerBox, {
    name: "Center box",
    description: "The large blue box between two smaller boxes",
});
addToScene(scene, centerBox);
```

## 公共 API 接口

所有公共状态均使用接口定义。所有行为均采用从包根导出的独立函数。

### 逻辑树类型

```ts
export interface AccessibilityTag {
    name?: string;
    description?: string;
    role?: string;
    /** Remove the object and its descendants from the accessible representation. */
    hidden?: boolean;
    /** Report that the object and its descendants are unavailable. */
    disabled?: boolean;
    aria?: Readonly<Record<`aria-${string}`, string | number | boolean | null | undefined>>;
}

export interface AccessibilityNodeOptions {
    tag?: AccessibilityTag | null;
    parent?: AccessibilityNode | null;
    /** Insert before a sibling; null appends. Omit to preserve the current position. */
    before?: AccessibilityNode | null;
    hidden?: boolean;
    disabled?: boolean;
    /** Application object represented by this node. Accessibility never disposes it. */
    target?: object;
}

export interface AccessibilityNode {
    tag: AccessibilityTag | null;
    parent: AccessibilityNode | null;
    readonly children: readonly AccessibilityNode[];
    hidden: boolean;
    disabled: boolean;
    target?: object;
}

export interface AccessibilityTree {
    readonly roots: readonly AccessibilityNode[];
    readonly disposed: boolean;
}
```

`AccessibilityNode.children` 与 `AccessibilityTree.roots` 将稳定的数组对象暴露为只读视图。树变更函数拥有对应的可变数组。应用不得直接编辑结构数组。

`target` 将逻辑节点链接到应用数据。树在移除节点时会清除该引用，但绝不会销毁目标对象。

### 逻辑树函数

```ts
export function createAccessibilityTree(): AccessibilityTree;

export function batchAccessibilityUpdates(tree: AccessibilityTree, update: () => void): void;

export function onAccessibilityTreeChanged(tree: AccessibilityTree, listener: () => void): () => void;

export function addAccessibilityNode(tree: AccessibilityTree, options: AccessibilityNodeOptions): AccessibilityNode;

export function updateAccessibilityNode(tree: AccessibilityTree, node: AccessibilityNode, patch: AccessibilityNodeOptions): void;

export function removeAccessibilityNode(tree: AccessibilityTree, node: AccessibilityNode): void;

export function disposeAccessibilityTree(tree: AccessibilityTree): void;
```

除非 `before` 指定了兄弟节点，否则 `addAccessibilityNode` 会将节点追加到所选根节点或子节点列表末尾。`updateAccessibilityNode` 在修改元数据、父子关系、顺序、可用性或目标的同时保持节点标识不变。

`removeAccessibilityNode` 会移除节点及其后代。被移除的句柄不再属于该树。之后对同一目标的重新表示将获得一个新节点。

`batchAccessibilityUpdates` 会将观察器通知延迟到最外层同步批处理完成之后。支持嵌套批处理。存在变更的批处理会发出一次通知。即使在批处理内部执行树销毁，也会立即发布其最终的已销毁状态，然后消耗掉待处理的脏状态，从而避免批处理结束时发出第二次通知。

如果一次更新未改变元数据语义、可用性、目标、父节点或兄弟节点位置，则不会将树标记为脏，也不会通知观察器。显式替换元数据仍会存储最新的不可变记录结构，包括省略 `aria` 值与传入空 `aria` 记录之间的区别。

`onAccessibilityTreeChanged` 观察已完成的变更。返回的函数用于移除监听器。观察器抛出的错误会被收集：单个错误直接重新抛出，多个错误则作为 `AggregateError` 重新抛出。

### HTML twin 类型

```ts
export interface HtmlTwinOptions {
    parent: HTMLElement;
    /** Accessible name of the generated region. */
    label?: string;
}

export interface HtmlTwin {
    readonly element: HTMLDivElement;
    readonly tree: AccessibilityTree;
}
```

### HTML twin 函数

```ts
export function createHtmlTwin(tree: AccessibilityTree, options: HtmlTwinOptions): HtmlTwin;

export function updateHtmlTwin(twin: HtmlTwin): void;

export function getHtmlTwinElement(twin: HtmlTwin, node: AccessibilityNode): HTMLElement | undefined;

export function disposeHtmlTwin(twin: HtmlTwin): void;
```

`createHtmlTwin` 在 `options.parent` 下创建一个视觉裁剪的 `div` 区域。该区域具有 `role="region"`，并使用 `options.label`（省略时默认为 `"Scene"`）。

twin 使用 `options.parent.ownerDocument` 创建每个生成的元素。因此来自 iframe 或其他文档的父元素会在对应文档中生成元素。

`getHtmlTwinElement` 返回当前已表示节点对应的生成元素。对于不存在或已被移除的节点，返回 `undefined`。

### 场景投影类型

场景适配器接受 `SceneNode | Camera` 值作为源。该源联合类型涵盖网格、灯光、相机、变换节点以及其他具有逻辑层级的场景节点。

```ts
type SceneSource = SceneNode | Camera;

export interface SceneAccessibilityOptions {
    roots?: readonly SceneSource[];
}

export interface SceneAccessibility {
    readonly tree: AccessibilityTree;
}
```

`roots` 用于提供纯变换或未被场景保留数组持有的源对象。每个显式根都会包含其完整的后代子树以及将其连接起来所需的祖先节点。

子树发现仅沿着当前的 `parent` 链接遍历。源的 `children` 数组中的陈旧条目不会保留 `parent` 已指向别处的子节点。如果显式根或当前相机的子树中存在环，投影会在遍历第二次进入同一源之前拒绝该投影。

### 场景投影函数

```ts
export function createSceneAccessibility(scene: SceneContext, options?: SceneAccessibilityOptions): SceneAccessibility;

export function updateSceneAccessibility(adapter: SceneAccessibility): void;

export function setAccessibilityTag(source: object, tag: AccessibilityTag | null): void;

export function getAccessibilityTag(source: object): AccessibilityTag | null;

export function getAccessibilityNode(adapter: SceneAccessibility, source: SceneSource): AccessibilityNode | undefined;

export function setAccessibilityParent(adapter: SceneAccessibility, source: SceneSource, parent: SceneSource | null | undefined): void;

export function disposeSceneAccessibility(adapter: SceneAccessibility): void;
```

一个场景最多拥有一个 `SceneAccessibility` 投影。`createSceneAccessibility` 会拒绝已销毁的场景，并拒绝已经拥有投影的场景。两项检查都在函数创建逻辑树或注册通用场景订阅之前执行。

`updateSceneAccessibility` 执行一次即时的全量协调。在绕过常规场景辅助函数直接编辑 `scene.meshes`、`scene.lights` 或其他保留状态后，请调用此函数。

`setAccessibilityTag` 会替换整条元数据记录。传入 `null` 会移除该记录。`getAccessibilityTag` 返回存储的不可变快照，而非可变的调用方对象。

`setAccessibilityParent` 仅更改语义层级，不改变源的渲染变换。传入 `null` 使源成为逻辑根节点；传入 `undefined` 恢复自然的源父子关系。

### 通用场景生命周期依赖

场景成员关系通过通用场景接口进行观察：

```ts
export interface SceneChangeEvent {
    readonly type: "added" | "removed";
    readonly entity: SceneEntity;
}

export function onSceneChange(scene: SceneContext, listener: (event: SceneChangeEvent) => void): () => void;

export function onSceneDispose(scene: SceneContext, callback: () => void): () => void;
```

`SceneEntity` 与 `addToScene` 和 `removeFromScene` 接受的联合类型相同。通知描述针对递归层级成员、资源容器内容以及纯变换节点的可观察已提交成员变更。每次订阅都有自己的注册标识，因此重复的回调可以独立移除。返回的回调用于注销注册且是幂等的。

场景变更监听器在最外层的添加或移除操作完成后运行。可重入的变更会将更多事件追加到同一次派发中。监听器移除会在下一个回调或事件之前生效。即使出现失败，所有剩余监听器仍会运行；单次失败直接重新抛出，多次失败使用 `AggregateError`。

首次场景变更订阅会从场景保留的网格、灯光、阴影生成器、当前相机以及通过匹配的子到父链接可达的当前后代初始化一个弱成员集合。它不会向上遍历祖先。后续的添加和移除通知会更新该集合，并仅发布可观察到的成员身份进出转换。因此重复移除不会产生通知，而移除再重新添加的循环会发布每次观察到的转换。每个场景拥有独立状态，当最后一个订阅者离开时状态被释放。

纯变换根节点和资源容器包装器标识不由场景保留。在添加这些值之后才创建的订阅无法发现更早添加的标识，除非该标识本身被保留或是某被保留对象的当前后代。未保留的变换根节点不会仅因为是某个被保留网格的祖先而被发现。移除一个不可发现的值会执行规范清理，但不会发布移除事件。

成员注册和销毁注册安装各自独立的可选核心接缝。仅使用 `onSceneDispose` 的使用方不会保留场景变更事件的创建、队列或派发代码。

场景生命周期接口不包含任何无障碍语义。其他独立的使用方可以订阅同一场景而无需共享特性状态。

### 托管场景 HTML twin 类型

```ts
export interface SceneHtmlTwinOptions extends Omit<HtmlTwinOptions, "parent">, SceneAccessibilityOptions {
    /** Host for the generated region. Defaults to the DOM canvas's parent element. */
    parent?: HTMLElement;
}

export interface SceneHtmlTwin {
    readonly accessibility: SceneAccessibility;
    readonly view: HtmlTwin;
}
```

### 托管场景 HTML twin 函数

```ts
export function createSceneHtmlTwin(scene: SceneContext, options?: SceneHtmlTwinOptions): SceneHtmlTwin;

export function disposeSceneHtmlTwin(twin: SceneHtmlTwin): void;
```

当省略 `options.parent` 时，`createSceneHtmlTwin` 要求存在带有父元素的 DOM 画布，并挂载到该画布旁。空引擎（null-engine）场景或 `OffscreenCanvas` 场景必须显式提供 `parent`。

该函数在安装场景投影之前解析 DOM 父节点。如果父节点解析失败，场景保持未绑定状态。如果投影安装后 HTML 创建失败，函数会在重新抛出错误前销毁该投影。

## 校验与快照语义

无障碍元数据在发布前会经过校验：

- 每个 `aria` 键必须匹配 `aria-[a-z-]+`。
- ARIA 值可以是字符串、有限数字、布尔值、`null` 或 `undefined`。
- `hidden` 不得与 `aria-hidden` 冲突。
- `disabled` 不得与 `aria-disabled` 冲突。
- 父节点与排序引用必须属于同一棵存活的树。
- `before` 必须指定所选父节点下的兄弟节点。
- 更改父节点不得形成环。
- 显式根与当前相机的子节点遍历不得包含环。
- 树变更函数拒绝已销毁的树。
- 场景语义父节点覆写会同步拒绝环。

`setAccessibilityTag`、`addAccessibilityNode` 以及标签更新会对标签进行浅冻结拷贝，并对其 `aria` 记录单独进行浅冻结拷贝。后续对调用方原始对象的写入不会改变已发布的元数据。

底层树独立存储显式编写的 `hidden` / `disabled` 值与从标签推导出的状态。有效状态遵循以下优先级：

```text
explicit node option
    ?? matching AccessibilityTag field
    ?? matching aria-hidden / aria-disabled value
    ?? false
```

如果多个显式来源提供了同一状态，所有提供的值必须一致。

## 内部架构

### 逻辑树所有权

每棵 `AccessibilityTree` 拥有：

- 一个作为 `roots` 暴露的有序可变根数组；
- 一个用于拒绝外来和已移除节点的成员 `Set`；
- 一个变更监听器 `Set`；
- 一个销毁标志；
- 同步批处理深度与脏状态。

每个 `AccessibilityNode` 拥有：

- 一个作为 `children` 暴露的有序可变子数组；
- 其当前的逻辑父节点；
- 一份不可变的标签快照；
- 有效的 hidden 与 disabled 值；
- 可选的显式可用性覆写；
- 仅由场景投影使用的内部运行时自可见性（self-visibility）标志；
- 可选的调用方自有目标引用。

重新设置父节点时，会在插入新数组之前先从旧兄弟数组中分离节点。移除后代时，会在删除成员关系前清空子数组、父节点、标签、显式状态及目标引用。

### 场景源发现

一个 `SceneAccessibility` 适配器拥有以下源集合：

- 场景保留的网格与灯光；
- 当前相机及其子树；
- 通过通用 `onSceneChange` 接口报告的源；
- 显式 `roots` 及其子树；
- 连接任意所需源所需的自然祖先节点。

网格与灯光在每次协调期间都会从 `scene.meshes` 和 `scene.lights` 重新发现。适配器创建后添加的纯变换节点从通用场景变更事件中保留。适配器创建前添加的纯变换节点必须仍可通过其他所需源到达，或通过 `roots` 传入。

适配器为每个所需源存储一个稳定的 `AccessibilityNode` 绑定。现有绑定会就地更新。不再需要的源会被取消观察、从绑定映射表中移除并从逻辑树中删除。

现有绑定按最终父节点顺序进行协调。适配器会在其后代之前更新每个目标父节点，因此合并后的层级反转不会遇到上一棵树留下的临时环。

### 逻辑层级

自然源父子关系提供默认的逻辑父节点。有效的显式语义父节点覆写优先。仅当源和父节点都在所需源集合中时，父节点才参与层级。

如果源或其语义父节点离开了所需集合，协调过程会移除存储的覆写。因此重新添加该源时会使用其当前自然父子关系，直到应用设置新的覆写。

环检查会沿着有效父链遍历，包括现有的覆写和自然父节点。绑定创建时会重复执行环保护，以防格式错误的源数据导致无限递归。

### 源元数据投影

适配器读取存储的显式标签，并创建节点专属快照：

1. 如果标签既没有 `name` 也没有 `description`，源当前的 `name` 将成为无障碍名称。
2. 如果标签有 `description` 但没有 `name`，`description` 仍作为 HTML 投影的名称来源。
3. `_disposed === true` 的源会变为子树隐藏（subtree-hidden）。
4. `visible === false` 的源会变为自隐藏（self-hidden）。其逻辑节点仍保留为结构容器，但 HTML 投影会抑制该节点自身的名称、描述、角色、描述性 ARIA 以及可读文本，同时为后代保留结构容器和显式编写的 disabled 状态。
5. 显式编写的 `hidden` 或 `aria-hidden="true"` 保持作用于整个子树。
6. disabled 状态来自显式编写的元数据，独立于运行时自可见性。

仅针对销毁场景，投影快照会将显式编写的 `hidden: false` 或 `aria-hidden="false"` 规范化为 `true`，以便逻辑树接受运行时的子树隐藏状态。`getAccessibilityTag` 继续返回显式编写的快照。运行时推导的名称与可见性仅存在于投影树节点上。运行时隐藏绝不会修改存储的显式标签，因此重新显示源时会恢复相同的元数据快照。

### 观察与合并

适配器观察以下内容：

- 场景的 `camera` 属性；
- 每个保留源的 `name`、`visible`、`_disposed` 和 `parent` 属性；
- 通过 `setAccessibilityTag` 执行的元数据替换；
- 通过 `onSceneChange` 报告的场景添加与移除；
- 显式语义父节点变更。

直接的受观察写入会调度一个微任务。在该微任务运行前的后续写入会复用该待处理更新。销毁操作通过将适配器标记为已销毁来取消待处理的协调。

属性观察保持原有的属性形态。最后一次取消订阅会恢复自有属性描述符、暴露最终的普通数据值，或移除临时包装器以使继承的访问器重新可见。

### HTML 同步

每个逻辑节点映射为一个带有 `data-lite-accessibility-node` 的 `div` 以及一个带有 `data-lite-accessibility-text` 的子 `span`。

每次更新时，渲染器会将生成的属性、文本、父节点及兄弟位置与目标状态进行比较。它仅写入发生变更的值，且仅在父节点或顺序变化时才移动元素。通用属性清理会排除反射属性 `hidden`；渲染器仅通过现有的 `element.hidden` 属性比较来更新可见性。

| 源状态 | HTML 结果 |
| --- | --- |
| `tag.role` | `role` |
| `tag.name` | `aria-label` |
| 仅有描述无名称 | 描述成为 `aria-label` |
| 同时有名称与描述 | 名称成为 `aria-label`；描述成为 `aria-description` |
| `node.hidden` | 元素的 `hidden` 属性 |
| `node.disabled` | `aria-disabled="true"` |
| `tag.aria` 条目 | 属性字符串值 |
| `null` 或 `undefined` ARIA 值 | 移除属性 |
| 运行时自隐藏的场景源 | 结构性 `div`；抑制语义/文本；保留 disabled 状态 |

显式编写的 ARIA 记录在推导的描述性 ARIA 属性之后应用，因此通用编写可以覆写或移除这些值。随后渲染器将 `node.disabled` 强制设置为 `aria-disabled="true"`，使逻辑 disabled 状态即使在显式记录包含空值 `aria-disabled` 时依然具有权威性。校验确保布尔型 `aria-hidden` 与 `aria-disabled` 值与显式编写的可用性字段保持一致。当运行时自隐藏节点被禁用时，其结构容器上仍保留 `aria-disabled="true"`，以使暴露的后代保持不可用状态。渲染器依然抑制该节点自身的角色、名称、描述、角色描述与可读文本。

可读文本通过 `textContent` 赋值。当名称和描述同时存在时，使用 `". "` 连接。诸如 `<three>` 的文本将保留为纯文本而非标记语言。

子节点会相对于当前 DOM 游标按逻辑顺序插入。已经处于正确父节点和位置的元素保持不动。非活动节点的元素会被移除，并从节点到元素的映射表中删除。

生成的区域通过内联样式进行视觉裁剪，同时仍保留在文档的无障碍表示中。

## 状态机与生命周期

### 无障碍树

```text
created -> mutated/batched -> disposed
```

- 创建操作返回一棵空的存活树。
- 变更操作在发布状态前进行校验。
- 销毁操作递归释放每个节点、将树标记为已销毁、发出一次最终变更通知并清空监听器。
- 重复销毁为空操作。

### HTML twin

```text
tree live + mounted -> synchronized -> tree disposed or explicit disposal -> removed
```

- 创建操作在首次更新前完成订阅、追加区域并渲染当前根节点。
- 树通知会调用 `updateHtmlTwin`。
- 如果树已销毁，更新操作会销毁 twin。
- 销毁操作会取消订阅、清空条目映射、移除区域，且是幂等的。

### 场景投影

```text
live scene -> projection installed -> reconciled as scene changes -> scene or projection disposed
```

- 创建操作会在树创建、属性观察或订阅之前拒绝 `scene._z`。
- 创建操作会在树创建或订阅之前检查由特性拥有的惰性 `WeakMap<SceneContext, SceneAccessibility>`。
- 这些守卫检查通过后，创建操作会将适配器存入该映射，并在初始协调之前订阅 `onSceneChange` 和 `onSceneDispose`。
- 如果初始协调失败，创建操作会在重新抛出前销毁所有已安装的状态。
- 显式投影销毁会移除两个场景订阅、移除观察与绑定、清空源和父节点集合、移除特性自有的映射条目并销毁树。
- `disposeScene` 会尝试执行所有已注册的清理回调，然后清空规范场景集合。无障碍拆卸只是其中一个普通的通用清理订阅者。
- 场景销毁会在清理回调运行前清空场景变更监听器与排队事件。在场景变更监听器执行期间触发销毁会停止该场景后续的监听器与排队事件，且不影响其他场景。
- 清理失败不会阻止后续回调或规范集合清理。单个失败直接重新抛出，多个失败则按回调顺序使用 `AggregateError`。
- 在规范清理期间排队的属性变更无法在销毁后进行协调，因为投影销毁会在微任务运行前将适配器标记为已销毁。
- 重复投影销毁为空操作。

### 托管场景 HTML twin

`SceneHtmlTwin` 同时拥有场景投影和已挂载的 HTML 视图。显式销毁会先移除视图，再销毁投影。场景销毁会销毁投影树；树的最终通知会移除已挂载的 HTML 视图。

## 管线配置

不适用。无障碍子系统不创建渲染管线、绑定组、深度或模板状态，也不创建 GPU 资源。

## 着色器逻辑

不适用。无障碍子系统不包含任何 WGSL，也不执行任何着色器工作。

## Babylon.js 等价映射

| Babylon Lite | Babylon.js | 关系 |
| --- | --- | --- |
| `AccessibilityTag` | `IAccessibilityTag` | 两者都描述场景对象语义。Lite 增加了独立的 `name`、可用性字段、不可变快照以及类型化的 `aria-*` 值。 |
| `setAccessibilityTag(source, tag)` / `getAccessibilityTag(source)` | `Node.accessibilityTag` | Lite 使用独立函数与惰性元数据存储，而非附加的可变属性。 |
| `createSceneHtmlTwin(scene)` | `HTMLTwinRenderer.Render(scene)` | 两者都为场景语义创建 HTML 表示。Lite 返回自有的纯数据句柄，并使用原生 DOM 同步而无需 React 根。 |
| `SceneAccessibility` | Babylon.js HTML twin 节点适配 | Lite 将场景发现与 DOM 渲染分离，从而使逻辑树也能在无头环境下工作。 |
| `setAccessibilityParent` | 由 Babylon.js HTML twin 消费的场景节点层级 | Lite 可以覆写语义分组而不改变渲染变换。 |

## 依赖关系

运行时依赖仅限于：

- `Camera`、`SceneNode` 与 `SceneContext` 类型和状态；
- 通用 `onSceneChange` 与 `onSceneDispose` 订阅；
- 用于默认宿主解析的 `isDomCanvas`；
- 特性拥有的惰性 `WeakMap`、`Map` 与 `Set` 状态，加上原生的 `Object.freeze` 和 `queueMicrotask`；
- 创建 HTML twin 时使用的原生 DOM 接口。

元数据映射与观察映射均惰性初始化。任何无障碍模块都不会在导入时创建模块级集合或执行工作。

根包从其单一的 `"."` 入口点重新导出所有公共类型与函数。未使用的无障碍导入会被 tree-shake 移除，且 DOM 投影仅在使用 HTML twin 导出时才会被保留。

## 测试规范

### 单元测试

`tests/lite/unit/accessibility-tree.test.ts` 覆盖：

- 不可变标签与 ARIA 快照；
- 逻辑根节点与子节点层级；
- 跨更新的稳定节点标识；
- 重新设置父节点与元数据移除；
- hidden 与 disabled 的推导；
- 格式错误的 ARIA 与冲突可用性的拒绝；
- 未变更更新通知的抑制；
- 批处理通知；
- 批处理期间的最终销毁通知，包括观察器失败清理；
- 子树移除与树销毁。

`tests/lite/unit/scene-accessibility.test.ts` 覆盖：

- 场景销毁后无钩子安装的拒绝；
- 缺失默认 DOM 宿主时无钩子安装的拒绝；
- 重复投影拒绝以及显式销毁后的替换；
- 未投影场景共存时多个已投影场景之间的路由；
- 发布前的标签校验；
- 源名称回退以及无多余语义通知的元数据记录形态替换；
- 场景成员、相机、灯光、显式根以及直接数组协调；
- 从显式根与当前相机遍历中排除已分离的子节点；
- 自可见性、子树可见性、名称、父子关系与标签的微任务更新；
- 稳定的源绑定；
- 语义父节点覆写、最终顺序反转、恢复、移除与环拒绝；
- 树观察器抛出异常时的场景清理；
- 规范场景销毁器抛出异常后的无障碍拆卸；
- 多个场景清理抛出异常时的有序聚合；
- 规范场景清理期间排队属性变更的取消；
- 显式投影销毁期间通用场景订阅的移除；
- 可逆的属性观察。

### 浏览器管线（plumbing）测试

`tests/lite/plumbing/accessibility.spec.ts` 与 `lab/lite/src/accessibility.ts` 覆盖：

- 默认画布父节点挂载；
- 自定义宿主挂载；
- iframe 中的 owner-document 行为；
- 层级、名称、描述、角色与任意 ARIA 值；
- 仅描述命名；
- 通过 `textContent` 进行的文本转义；
- 元数据替换与属性移除；
- 单节点更新不触发无关的属性、文本或移动变更，包括未变更的隐藏节点；
- 运行时隐藏的父节点为可见后代保留显式编写的子树禁用状态，同时不暴露父节点自身的角色、描述性元数据或可读文本；
- 显式编写的子树隐藏以及原始运行时隐藏元数据和稳定 DOM 元素的恢复；
- 无树通知或 DOM 变更的空操作场景刷新；
- 可见性、重新设置父节点、场景移除与场景销毁；
- 场景销毁发生在树批处理内部时托管 HTML 的移除；
- 规范场景销毁器抛出异常时 HTML 与观察的拆卸；
- 场景销毁后无泄漏 DOM 或残留场景绑定的拒绝。

### 构建与声明测试

`tests/lite/build/accessibility-treeshake.test.ts` 覆盖：

- 生成声明中的根导出可用性；
- 默认与显式父节点签名；
- 从公共声明中移除内部字段；
- 未使用的无障碍导入不会导致打包体积变化；
- 仅在请求时才保留 DOM 同步代码。

`tests/lite/build/accessibility-core-boundary.test.ts` 覆盖通用场景生命周期声明、无无障碍代码的通用订阅者打包、无成员派发的仅销毁发出库打包，以及核心场景打包中无障碍实现的缺失验证。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `packages/babylon-lite/src/accessibility/accessibility-tree.ts` | 公共元数据契约、逻辑树所有权、校验、变更、批处理与销毁 |
| `packages/babylon-lite/src/accessibility/html-twin.ts` | 原生 DOM 区域创建、节点到元素映射、同步与销毁 |
| `packages/babylon-lite/src/accessibility/observe-property.ts` | 场景适配器使用的可逆直接属性观察 |
| `packages/babylon-lite/src/accessibility/scene-accessibility.ts` | 惰性对象元数据、特性自有场景绑定状态、逻辑投影、合并、语义父节点覆写与生命周期订阅 |
| `packages/babylon-lite/src/accessibility/scene-html-twin.ts` | 默认/自定义宿主解析以及托管场景加 HTML 的便捷 API |
| `packages/babylon-lite/src/scene/scene-change.ts` | 独立安装的通用场景变更与销毁订阅、弱成员跟踪、派发、取消订阅、状态释放与错误聚合 |
| `packages/babylon-lite/src/scene/scene-core.ts` | 规范场景变更与销毁，加上独立的可选通用生命周期接缝 |
| `packages/babylon-lite/src/scene/scene-remove.ts` | 规范移除，加上通用的已提交场景移除通知 |
| `packages/babylon-lite/src/index.ts` | 单一根公共导出 |
| `tests/lite/unit/accessibility-tree.test.ts` | 逻辑树单元测试覆盖 |
| `tests/lite/unit/scene-accessibility.test.ts` | 场景适配器与观察单元测试覆盖 |
| `tests/lite/plumbing/accessibility.spec.ts` | 浏览器 DOM 与生命周期测试覆盖 |
| `tests/lite/build/accessibility-treeshake.test.ts` | 声明与 tree-shaking 测试覆盖 |
| `tests/lite/build/accessibility-core-boundary.test.ts` | 核心生命周期 tree-shaking 与特性边界测试覆盖 |
| `lab/lite/accessibility.html` | 浏览器管线夹具页面 |
| `lab/lite/src/accessibility.ts` | 浏览器管线夹具行为 |
| `docs/lite/architecture/56-accessibility.md` | 一次性（one-shot）子系统参考文档 |
