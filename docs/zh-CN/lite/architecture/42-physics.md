# 模块：物理系统（Physics）

> 包路径：`packages/babylon-lite/src/physics/`

> **状态：已实现。**
> 对 **Havok Physics V2**（与 Babylon.js 使用相同的 WASM 引擎）的行为级集成，按照 Lite 惯用法重塑：纯状态 `PhysicsWorld` 句柄外加独立函数、零模块级副作用，以及按需启用的特性模块（碰撞事件、触发器、高度场、空间查询、角色控制器、浮动原点、调试查看器）。**权威 API 以 `packages/babylon-lite/src/physics/` 中导出的 TSDoc 为准。**

---

## 用途

物理模块通过封装 Havok V2 WASM 求解器来驱动刚体模拟。它**不拥有场景图**：它从 Lite `SceneNode` 读取变换以初始化刚体，并在每次步进后将积分得到的变换写回。场景持有一个按需懒创建的所属世界发现列表。逐帧步进由场景的渲染前循环驱动；世界是数据所有者，而场景是时钟源。

本模块是 **100% 按需启用且可 Tree-shake** 的。不从 `physics/` 导入任何内容的场景付出零字节成本，且 Havok WASM 二进制文件由调用方懒加载，仅在 `createHavokWorld` 运行时才会被引用。

---

## 设计：纯状态句柄 + 函数

### 发现与检查

以下所有函数均为 `@babylonjs/lite` 根入口导出的独立函数。

```ts
getPhysicsWorlds(scene: SceneContext): readonly PhysicsWorld[];
getPhysicsBodies(world: PhysicsWorld): readonly PhysicsBody[];
getPhysicsConstraints(world: PhysicsWorld): readonly PhysicsConstraint[];
getPhysicsBodyWorld(body: PhysicsBody): PhysicsWorld;
getPhysicsBodyPrestepType(body: PhysicsBody): PhysicsPrestepType;
getPhysicsBodyShape(body: PhysicsBody): PhysicsShape | null;
getPhysicsBodyMassPropertiesToRef(world: PhysicsWorld, body: PhysicsBody, out: Required<PhysicsMassProperties>, instanceIndex?: number): Required<PhysicsMassProperties>;
getPhysicsBodyLinearVelocityToRef(world: PhysicsWorld, body: PhysicsBody, out: Vec3, instanceIndex?: number): Vec3;
getPhysicsBodyAngularVelocityToRef(world: PhysicsWorld, body: PhysicsBody, out: Vec3, instanceIndex?: number): Vec3;
getPhysicsBodyLinearDamping(world: PhysicsWorld, body: PhysicsBody, instanceIndex?: number): number;
setPhysicsBodyLinearDamping(world: PhysicsWorld, body: PhysicsBody, value: number): void;
getPhysicsBodyAngularDamping(world: PhysicsWorld, body: PhysicsBody, instanceIndex?: number): number;
setPhysicsBodyAngularDamping(world: PhysicsWorld, body: PhysicsBody, value: number): void;
getPhysicsBodyGravityFactor(world: PhysicsWorld, body: PhysicsBody, instanceIndex?: number): number;
setPhysicsBodyGravityFactor(world: PhysicsWorld, body: PhysicsBody, value: number): void;
getPhysicsShapeType(shape: PhysicsShape): PhysicsShapeType;
getPhysicsShapeParameters(shape: PhysicsShape): Readonly<PhysicsShapeParameters> | null;
getPhysicsShapeMaterialToRef(world: PhysicsWorld, shape: PhysicsShape, out: PhysicsShapeMaterial): PhysicsShapeMaterial;
getPhysicsShapeFilterMembershipMask(world: PhysicsWorld, shape: PhysicsShape): number;
getPhysicsShapeFilterCollideMask(world: PhysicsWorld, shape: PhysicsShape): number;
getPhysicsShapeDensity(world: PhysicsWorld, shape: PhysicsShape): number;
getPhysicsShapeChildCount(world: PhysicsWorld, shape: PhysicsShape): number;
isPhysicsConstraintEnabled(world: PhysicsWorld, constraint: PhysicsConstraint): boolean;
setPhysicsConstraintEnabled(world: PhysicsWorld, constraint: PhysicsConstraint, enabled: boolean): void;
getPhysicsConstraintDebug(constraint: PhysicsConstraint): PhysicsConstraintDebug;
hidePhysicsConstraint(viewer: PhysicsViewer, constraint: PhysicsConstraintDebug): boolean;
```

`PhysicsShapeMaterial` 为 `{ friction: number; staticFriction: number; restitution: number }`。现有的分配型速度读取器与所有现有设置器均保持兼容。

- **世界生命周期（G1–G7）：** `createHavokWorld` 向懒创建的 `scene._physicsWorlds` 追加世界，并注册恰好一个用于清空该列表的场景可释放回调。只读列表实时反映状态、顺序稳定、按插入排序且无重复；若需快照请自行拷贝。空查询不会安装注册表。`disposePhysics` 仅移除其自身对应的世界，具有幂等性，并清空其刚体/约束列表（包括浮动原点世界）。场景销毁会清空发现列表并停止步进，但不会释放原生世界或清理其中的刚体：调用方仍拥有世界销毁的所有权。不支持在场景销毁之后再创建世界。
- **R1 —— 存活性：** 原生检查要求当前仍属于世界/刚体/约束成员；不存在防御性的存活性检查。形状没有注册表：每次刷新请通过存活的刚体重新读取它们，不要跨刷新周期保留引用。无法安全读取用户已释放的形状。`getPhysicsBodyWorld` 即使在移除/销毁后仍保留最初的关联，不能作为存活性信号。没有 `isPhysicsWorldDisposed`。
- **R2 —— 轮询：** ToRef 读取器更新调用方持有的向量/结构体并返回完全相同的输出对象（包括其现有的嵌套向量）。质量回读映射 `[centerOfMass, mass, inertia, inertiaOrientation]`；非 OK 结果会抛出 `Failed to read physics body mass properties.`。旋转锁定会回读原生锁定后的零惯量轴。部分质量属性编辑会保留现有基于形状推导的默认值并重新应用锁定。
- **R3 —— 瘦实例：** 带索引的读取器默认使用实例 0，解析为 `world._thin?.instance(body, instanceIndex) ?? body._hkBody`；越界索引属于未定义行为。设置器会扇出到所有实例。阻尼与重力因子设置器位于热点外观方法列表之外，进行显式循环。瘦实例刚体在列表中只出现一次；实例数请使用 `getPhysicsBodyInstanceCount`。形状回读报告基础形状，而非高级的按实例形状。约束仅绑定实例 0。
- **R4 —— 浮动原点：** 阻尼、重力因子、速度、质量、形状材质和碰撞过滤掩码与区域无关。质心、惯量及惯量方向属于刚体局部坐标，不应用原点偏移。瘦实例刚体与浮动原点仍互斥。
- **R5/R6 —— 打包：** 仅根导出；未使用的读取器会被 Tree-shake 掉。场景注册表字段使用纯类型物理导入，因此非物理场景付出零字节成本。形状参数缓存仅产生成本于形状创建器；约束发现仅产生成本于约束创建器与世界销毁。

| 回读项                                                    | 瘦实例                                | 浮动原点                             |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------ |
| 运动类型/前步进类型/基础形状                              | 单个缓存的刚体值；运动设置器扇出写入  | 相互独立                             |
| 质量、阻尼、重力因子、速度                                | 按索引读取，全实例写入                | 刚体局部/区域无关                    |
| 形状类型/参数/材质/过滤掩码/密度/子形状数量               | 共享形状                              | 刚体局部/区域无关                    |
| 约束                                                      | 仅限实例 0                            | 不支持跨区域约束                     |

基础图元形状参数按引用保留创建参数对象；调用方修改它会改变缓存回读值，但不会改变原生几何体。聚合体参数保留自动计算尺寸后的几何体。`MESH`、`CONVEX_HULL`、`HEIGHTFIELD` 和 `CONTAINER` 返回 `null` 参数。材质回读将原生 `[staticFriction, dynamicFriction, restitution, ...]` 映射到命名字段。编辑共享形状上的材质或过滤掩码会影响使用它的所有刚体。子形状数量仅对容器有意义（其他情况为零）。

约束会被懒追加到 `world._constraints`。释放时会禁用、释放原生句柄、标记为已销毁并从列表中移除一次。移除刚体刻意不将其约束从列表中删除。世界销毁会在释放刚体/世界（包括浮动原点早退路径）之前先释放每一个剩余约束，将每个约束标记为已销毁并清空存活列表。如果某条约束不在列表中，或任一关联刚体不在列表中，检查器（Inspector）必须隐藏该约束。

`getPhysicsConstraintDebug` 懒缓存 `constraint._debug`，包含刚体链接、类型以及创建时的轴/枢轴（缺失的枢轴变为零向量）；选项在创建后不可变。查看器以这些稳定的调试对象作为键。平行的 `_constraintKeys`/`_constraintGroups` 将每个键映射到其网格；重复显示返回 `[]`。隐藏时会从场景/扁平网格列表中移除该组网格及其线/圆盘/箭头更新条目，首次返回 true（若不存在则返回 false），并在为空时注销更新回调。销毁会清空所有数组。隐藏/销毁不发起任何原生调用，在约束/刚体/世界释放后仍可安全调用。

检查器会刷新世界、刚体和约束列表，检查两端刚体，重新读取形状，协调查看器可视化元素并使用可复用的 ToRef 存储轮询。只有显示刚体时才需要存活的原生刚体；查看器更新使用 JS 变换。不存在场景级的物理启用开关（仅以世界存在与否为准）、原生约束枢轴回读、材质合并模式 API、休眠状态或已施加冲量读取器、马达/限位编辑、形状/聚合体/控制器发现，或浮动原点跨区域约束支持。

检查覆盖的回归测试：`physics-discovery.test.ts`、`physics-inspection.test.ts`、`physics-viewer.test.ts` 和 `tests/lite/build/public-api-types.test.ts`，以及现有的销毁、约束、旋转锁定、瘦实例、事件与时间步长测试。

| 概念                    | Babylon Lite                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `PhysicsEngine` + 插件  | 单一 `PhysicsWorld` 状态接口 + 独立函数                        |
| `PhysicsBody` 类        | `PhysicsBody` 状态接口 + `createPhysicsBody(...)` 等           |
| `body.applyForce()`     | `applyPhysicsBodyForce(world, body, ...)`                      |
| `PhysicsViewer` 类      | `createPhysicsViewer(...)` + `show*/hide*` 函数                |
| 引擎持有的步进观察者    | 在创建世界时压入 `scene._beforeRender` 的回调函数              |

### 瘦实例刚体

`enableHavokThinInstancePhysics(world)` 会以 `world._hknp` 的形式懒安装一个按世界的 Havok 外观。该懒上下文持有原始 Havok 模块，并将每个瘦实例刚体的主句柄身份映射为模块私有的原生句柄及可复用的矩阵分解暂存值。这个显式启用器拥有全部瘦实例检测、校验、扇出和矩阵同步逻辑，因此普通刚体状态没有任何瘦实例字段，普通物理场景也不会保留该特性模块的任何代码。启用后，`createPhysicsBody(world, mesh, motionType, startsAsleep)` 会为每个激活的矩阵创建一个原生 Havok 刚体，同时只返回一个 Lite `PhysicsBody` 句柄：

- `PhysicsBody._hkBody` 仍保留为第一个原生句柄，以保持向后兼容并服务单刚体消费方。
- 通用刚体设置器、冲量、移除和释放仍保持普通的直接 Havok 调用。该外观仅识别精确的主句柄对象并将其扇出；等同的克隆元组则会单次委托给原始 Havok。
- 主句柄上的读取器调用自然读取原生实例 0。实例解析返回稳定的克隆句柄元组（包括索引 0），从而使控制器接触冲量仅作用于被击中的单个实例。
- 特定特性的消费方可通过懒上下文内部的 `instance(body, index)` 接缝寻址单个原生实例。Playroom 将其带索引的冲量与速度辅助函数保留在演示代码中，以免普通物理场景携带特定游戏的校验和控制 API。
- 事件安全的延迟释放与控制器原生变换数学仍对懒启用器保持私有。
- 每个原生刚体都从渲染器所消费的同一有效变换的刚体分解结果初始化：`mesh.worldMatrix × thinInstanceMatrix`。因此载体变换恰好应用一次；它既不会在创建时被丢弃，也不会被永久乘入实例缓冲区中。
- 针对 Lite 刚体的形状、质量、运动类型、速度、冲量、力、事件掩码、移除和销毁操作会应用于每一个原生实例。本质上仅接收单个原生刚体的读取器和 API 则使用实例 0。
- 约束与单刚体查询排除使用实例 0。射线检测与角色控制器接触解析会查询可选的瘦实例解析器。关注刚体的碰撞和触发器订阅会安装一个共享的懒事件解析器，同时识别普通和瘦实例原生句柄。碰撞类事件载荷返回共享的 Lite 刚体外加基于零的瘦实例索引，与 Babylon.js 的 `colliderIndex` / `collidedAgainstIndex` 语义一致；普通刚体报告索引 `0`。

动态瘦实例刚体在每次步进后将 Havok 变换直接同步回现有的矩阵缓冲区，然后通过 `flushThinInstances(mesh)` 一次性标记矩阵范围为脏。刚体创建时会保留每个有效渲染矩阵的规范有符号缩放（包括负行列式）。写回时在世界空间用保留的缩放重新组合原生平移/旋转，随后乘以载体当前世界矩阵的逆，以还原载体局部实例矩阵。因此 `mesh.worldMatrix × thinInstanceMatrix` 能够保留authored 缩放、行列式及变换后顶点，而原生 Havok 仅接收刚体姿态。启用 `TELEPORT` 前步进时，每个当前有效矩阵都会被分解并拷贝回匹配的 Havok 刚体；其最新的有符号缩放将成为后续写回使用的缩放。

碰撞形状始终是刚体局部几何体。共同的非刚体模板缩放必须在刚体构建前烘焙进共享几何体/形状中。当有效瘦实例矩阵仍带有非单位缩放时，懒瘦实例上下文会将调用方的形状包装在一个缩放容器中，由具有相同有符号缩放的实例共享。单位缩放实例则直接使用调用方的形状。这既保留了原始编写的形状中心与凸包/网格几何体，又不会修改共享源形状或将刚体变换视为缩放。该包装器归属于瘦实例上下文，并在被替换或刚体释放时一并释放。

由形状推导的瘦实例质量属性是根据每个原生刚体实际挂载的形状独立评估的。因此不同缩放的包装器各自保留自己的缩放后质心、惯量与惯量方向；实例 0 不会充当这些推导值的模板。随后按照与普通刚体相同的公共契约，将调用方的显式质量/质心/惯量覆盖以及激活的角锁定掩码应用到每个实例。

原生形状推导与显式覆盖应用位于一个供普通刚体和瘦实例刚体共享的无副作用质量属性叶子模块中。克隆与旋转锁定变换位于另一个独立叶子模块中，因此导入质量推导不会把轴锁定机制一起带入。每个调用方仅保留其调用的模块。懒瘦实例 chunk 直接导入这些叶子模块，而不回绕经过 `havok.ts`，从而避免仅限瘦实例的锁定机制进入普通物理入口 chunk。

广义质量属性设置器同样是一个按需叶子模块。核心刚体创建与标量质量便捷 API 保留其窄小的基于形状推导的路径，而覆盖惯量或其方向的调用方才加载广义合并辅助函数。瘦实例物理在其现有的懒 chunk 中导入该合并辅助函数；标量质量则显式提供其与质量成正比的无形状惯量回退逻辑。

旋转锁定 API 本身负责瘦实例刚体的锁定持久化。它使用瘦实例上下文现有的计数与按索引原生句柄访问，在刚体上为每个实例存储一个未锁定质量源，并安装与普通刚体相同的质量重建变换接缝。因此基础瘦实例上下文除非调用方导入旋转锁定 API，否则不会保留锁定/解锁循环或惯量轴数学逻辑。

载体求逆与形状缩放依然实现在懒瘦实例 chunk 内部。载体合成复用了数学层的带偏移乘法辅助函数，而求逆保留在局部，使普通场景不会保留原本未使用的求逆内核。可选物理模块仅在调用 `enableHavokThinInstancePhysics` 之后才为这些矩阵运算付费。

矩阵写回仅在相对于受影响基向量列幅值的微小机器舍入倍数内将乘法残差规范化为精确零。它绝不能使用固定的世界空间阈值：合法的小幅原始旋转与基分量必须保持可表示性。同样，单位缩放仅在矩阵存储格式的 1 个 ULP 内规范化；这能消除量化旋转基带来的范数误差，同时不会把可表示的非单位缩放变成单位缩放。
`TELEPORT` 是默认模式。`ACTION` 保留 Babylon.js 行为，将载体节点的单一目标变换发送给所有实例。公共刚体变换设置会通过外观扇出，并重写/刷新所有瘦实例矩阵。核心步进仅保留三个可选的同步钩子（`TELEPORT`、`ACTION` 以及动态刚体到矩阵的同步），其算法则留在懒加载模块中。

在步进后回调排空期间被移除的刚体在所有回调完成前仍可解析。关注刚体的碰撞或触发器注册会安装一个按世界的懒事件生命周期接缝，其 begin/end 钩子将排空过程括起，并延迟普通刚体与瘦实例刚体的原生释放。排空之外的移除操作则立即释放。

同一个懒接缝还为每一个受追踪的普通刚体和每一个原生瘦实例刚体维护一份原生 ID 索引。每条记录存储一个稳定的 `[PhysicsBody, nativeHandle, instanceIndex]` 标识，包括为瘦实例刚体单独分配的实例 0 句柄。安装首个关注刚体的事件监听器时会索引已存在的刚体；之后创建的刚体会直接添加标识。排空之外的移除会在原生释放前删除标识。排空期间的移除会保留标识与原生句柄直至匹配的 `end()`，然后再删除并释放。世界销毁时清空该索引。因此原生 ID 仅在旧标识彻底消失后才可能被复用，且不同世界绝不共享索引状态。碰撞及关注刚体的触发器解析只需对每位参与者执行一次 `Map.get`；它们从不遍历瘦实例状态、普通刚体或延迟移除列表。

碰撞订阅共享一个由模块持有的按世界分发器。首次订阅安装一次步进后排空；后续订阅仅追加观察者，而不添加新的原生流迭代器。每条原生事件仅解码一次，并按原生顺序分发给该步进之前已注册的每一个观察者。`STARTED`、`CONTINUED`、`FINISHED` 以及重复的同对事件均完整保留。每条原生事件拥有一个全新的顶层信息对象与全新的接触向量，因此保留某条事件不会受到后续事件变更的影响。从观察者内销毁世界会在下一次原生世界调用前停止迭代；世界销毁后，拷贝出来的其余步进后回调同样会被跳过。

`getPhysicsBodyInstanceCount(body)` 报告原生实例数量（普通刚体为 `1`）。激活的瘦实例数量在刚体创建时固定：调用方必须在构建刚体前填充矩阵并显式启用瘦实例物理。若未调用启用器，核心刚体创建不执行任何瘦实例检测，走普通单刚体路径。
Playroom 自行管理其重置检查点与恢复辅助函数。它们保留刚体的局部矩阵、载体变换与原生变换，而不在核心瘦实例模块中添加重置语义。恢复时复用现有的网格缓冲区与原生刚体，清零速度，使每个刚体休眠，并一次性将保留的矩阵缓冲区标记为脏。
在能够为每个原生实例追踪各自区域之前，浮动原点多区域模拟会显式拒绝瘦实例刚体。

原生句柄顺序在构建时固定并与渲染实例顺序一致。与所有后续索引一样，索引 0 拥有自己独立的稳定克隆原生句柄，因此带索引的冲量、速度、射线检测与碰撞事件绝不会传递主外观句柄，也绝不会意外广播。现有的非索引设置器与冲量刻意保留通用的广播行为。仅当游戏逻辑或接触逻辑持有具体的射线检测/碰撞实例标识时，才应调用带索引的操作。

### 模块文件

| 文件                                                   | 职责                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `havok.ts`                                             | 核心：世界创建/步进/销毁、刚体、形状、聚合体、力                      |
| `havok-mass-properties.ts`                             | 共享的原生质量推导与显式覆盖                                          |
| `havok-rotation-locks.ts`                              | 质量克隆与共享的刚体轴惯量锁定变换                                    |
| `havok-thin-instances.ts`                              | 瘦实例的懒原生刚体扇出与矩阵同步                                      |
| `havok-instance-access.ts`                             | 针对单个刚体实例的带校验按需冲量/速度访问                             |
| `havok-events.ts`                                      | 懒刚体解析与事件安全的延迟释放                                        |
| `havok-collision.ts`                                   | 按需碰撞开始/持续/结束事件（`onPhysicsCollision`）                    |
| `havok-trigger.ts`                                     | 按需触发器体积进入/离开事件                                           |
| `havok-heightfield.ts`                                 | 高度场碰撞形状                                                        |
| `havok-queries.ts`                                     | 射线检测、形状投射、形状邻近查询                                      |
| `havok-floating-origin.ts`                             | 面向大世界渲染的多区域模拟（按需加载）                                |
| `character-controller.ts`                              | 运动学角色控制器（投射并滑动 cast-and-slide）                         |
| `physics-viewer.ts` + `physics-debug-line-material.ts` | 碰撞体形状的调试线框叠加层                                            |

---

## 世界生命周期

```ts
import HavokPhysics from "@babylonjs/havok";

const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
const world = createHavokWorld(scene, hknp); // world step defaults to 0 (follows the scene)
// ... create bodies/aggregates ...
disposePhysics(world); // stops stepping, releases native world
```

`createHavokWorld` 通过**向 `scene._beforeRender` 头部插入（unshift）回调**来注册逐帧步进，并将移除函数保存在 `world._stopStep` 中。`disposePhysics` 会在释放原生世界**之前**先调用该移除函数并清空 `world._afterStep`——否则仍处于注册状态的回调会对一个已释放的 Havok 世界执行步进（并读取碰撞事件），这既会造成内存泄漏，又会导致 WASM 堆中的释放后使用（use-after-free）。参见 `tests/lite/unit/physics-dispose.test.ts`。

### 发现

`getPhysicsWorlds(scene)`、`getPhysicsBodies(world)` 和 `getPhysicsConstraints(world)` 按创建顺序暴露实时的只读列表。世界创建时会注册一次懒场景清理；场景销毁仅清空世界列表，而不释放原生世界或其刚体。世界销毁会注销自身，在释放原生世界前释放剩余约束，并在普通和浮动原点路径上同时清空刚体和约束列表。空发现查询不安装任何内容。若需快照请拷贝列表，并在执行原生读取前重新检查成员资格。形状、聚合体与角色控制器不可单独发现。关于 G1–G7、R1–R6、函数签名、瘦实例规则及检查器刷新契约，参见上文**发现与检查**。

---

## 时间步长与增量时间传播

物理按照 **Lite 中每个基于时间的子系统都遵循的同一套增量时间契约**推进：场景每帧解析出一个有效增量时间，各子系统可使用自身的固定覆盖值对其重新门控。

### 第 1 阶段 —— 场景每帧解析一个增量时间

`scene-core.ts` 挑选一次增量时间，并将其传递给每个渲染前回调（动画、精灵、**物理**）：

```ts
// scene-core.ts (buildScene render step)
const d = ctx.fixedDeltaMs > 0 ? ctx.fixedDeltaMs : eng._currentDelta;
for (const cb of ctx._beforeRender) cb(d);
```

`scene.fixedDeltaMs`（单位毫秒，默认 `0`）是确定性旋钮：将其设为固定值（如 `1000 / 60`）以实现可复现回放，或保持 `0` 以使用真实的 `requestAnimationFrame` 增量（`engine._currentDelta`）。

### 第 2 阶段 —— 世界使用自身的固定步长重新门控

世界存储自身的 **`_fixedDeltaMs`（毫秒）**，它**独立于场景**——创建时默认为 `0`，仅能通过访问器设置。`_stepWorld` 应用与动画及精灵管理器完全相同的 `> 0 ? fixed : delta` 规则：

```ts
// havok.ts _stepWorld(world, deltaMs)
const stepMs = world._fixedDeltaMs > 0 ? world._fixedDeltaMs : deltaMs;
if (!Number.isFinite(stepMs) || stepMs <= 0) return; // reject NaN / non-positive
const dt = Math.min(stepMs / 1000, 0.1); // → seconds, clamped (see below)
hknp.HP_World_Step(hkWorld, dt);
```

由于世界步长默认为 `0`，在常见情况下（无覆盖）世界会**跟随场景**：它每帧收到的 `deltaMs` 即渲染循环已在第 1 阶段解析为 `scene.fixedDeltaMs > 0 ? scene.fixedDeltaMs : engine._currentDelta` 的值。因此物理与动画保持**步调锁定**——当场景确定性步进时两者解析为同一固定值，否则均回退到真实帧增量——并且**运行期对 `scene.fixedDeltaMs` 的任何修改都会在下一帧生效**（不存在构造时快照过期的问题）。

### 单位

存储的步长**处处均为毫秒**（与 `scene.fixedDeltaMs` 及动画/精灵管理器一致）。物理仅在 Havok 边界处转换为**秒**，因为 `HP_World_Step` 以及力→冲量 / 位移→速度换算需要以秒为单位。步进后回调（`onPhysicsAfterStep`）接收的也是这一以秒为单位的每步 `dt`。

### 覆盖步长

`setPhysicsTimestepMs(world, fixedDeltaMs)` / `getPhysicsTimestepMs(world)` 以**毫秒**读写 `_fixedDeltaMs`，与 `SceneContext.fixedDeltaMs` 一致。传入 `0`（默认）可解除世界级固定步长，恢复跟随场景每帧增量：

```ts
setPhysicsTimestepMs(world, 1000 / 30); // force a 30 fps physics step
setPhysicsTimestepMs(world, 0); // back to following the scene's delta
```

`setPhysicsTimestep(world, seconds)` / `getPhysicsTimestep(world)` 是等价的**基于秒的**访问器（`setPhysicsTimestep(world, 1 / 30)` 等同于 `setPhysicsTimestepMs(world, 1000 / 30)`）；新代码建议优先使用毫秒版本，以便单位与引擎其余部分的增量约定对齐。

这在物理上类比于为动画或精灵管理器赋值 `manager.fixedDeltaMs`。参见 `tests/lite/unit/physics-timestep.test.ts`。

### 循环外调用方：`worldStepSeconds`

某些物理操作运行在逐帧 `_stepWorld` 回调**之外**，因此收不到渲染循环的 `deltaMs` 参数——例如 `applyPhysicsBodyForce`（在一步内将力转换为冲量）以及角色控制器的 `moveWithCollisions`（将位移转换为速度）。它们调用共享的 `worldStepSeconds(world)` 辅助函数，该函数解析出与步进一致的有效增量并以**秒**为单位返回：

1. 若设置了固定步长，则为 `world._fixedDeltaMs`，否则
2. 若场景处于固定步长模式，则为 `scene.fixedDeltaMs`，否则
3. 引擎的真实每帧增量（`scene.surface.engine._currentDelta`）。

这让力和角色运动无论在世界运行固定步长还是跟随真实帧增量时，都始终与世界积分所使用的增量保持锁定。在首帧（尚未测得任何增量）该辅助函数可能返回 `0`；调用方会防范零/负步长。

### 为什么需要 `Math.min(dt, 0.1)`

步长被钳位在 **100 ms 上限（即 10 fps 下限）**。否则，一次长时间卡顿——后台标签页、GC 停顿、命中调试断点——会把一个巨大的 `dt` 交给 Havok。积分一个超大步长会让高速刚体**穿透（tunnel）**薄几何体（它们在两次求解器采样之间瞬移穿过碰撞体），并可能使约束求解器失稳。上限钳位将卡顿转化为短暂的慢动作，而不是物理爆炸。Babylon.js 对其物理子步进也采用相同的上限。这里的钳位刻意**不是**子步进循环：Lite 每帧执行单次固定步进，以完美的追赶性换取简洁性与稳定的打包体积。

### 与其他基于时间的子系统的一致性

| 子系统 | 门控条件                                         | 源码                    |
| ------ | ------------------------------------------------ | ----------------------- |
| 场景   | `fixedDeltaMs > 0 ? fixedDeltaMs : currentDelta` | `scene-core.ts`         |
| 动画   | `fixedDeltaMs > 0 ? fixedDeltaMs : deltaMs`      | `animation-manager.ts`  |
| 精灵   | `fixedDeltaMs > 0 ? fixedDeltaMs : deltaMs`      | `sprite-animation.ts`   |
| 物理   | `_fixedDeltaMs > 0 ? _fixedDeltaMs : deltaMs`    | `havok.ts` `_stepWorld` |

物理特有的差异仅在于 Havok 边界处的毫秒→秒转换以及 100 ms 防穿透钳位；针对非有限值/负步长的保护逻辑与动画和精灵管理器完全一致。

---

## 刚体角锁定

`lockPhysicsBodyRotationAxes(world, body, axes)` 在碰撞形状与质量属性配置完成后锁定选定的刚体局部轴。Havok 使用零惯量分量来表示被锁定的角自由度。其基于形状推导出的惯量表达在旋转后的主轴坐标系中，因此该辅助函数会在刚体空间内计算 `R · diag(inertia) · Rᵀ`，并将请求的 `"x"`、`"y"` 或 `"z"` 分量置零。单轴锁定通过绕锁定轴的旋转在剩余自由平面中保留精确的耦合惯量；多轴锁定则使用单位惯量方向。质量与质心保持不变。激活的锁定掩码及最新的未锁定质量属性会保存在刚体上，并在 `setPhysicsBodyMass` 和 `setPhysicsBodyMassProperties` 重建基于形状的质量属性时重新应用。`unlockPhysicsBodyRotationAxes(world, body, axes)` 会从这些未锁定属性中选择性地恢复指定轴，并在最后一个轴解锁后移除内部持久化接缝。

---

## 特性模块（按需启用）

- **碰撞事件**（`havok-collision.ts`）：`setPhysicsBodyCollisionEventsEnabled`
    - `onPhysicsCollision` 在 `world._afterStep` 上注册一个步进后排空函数。每个事件标明 `collider`、`colliderIndex`、`collidedAgainst` 与 `collidedAgainstIndex`，除接触点、法线和冲量外还报告接触距离。所有观察者共享同一次排空，并按顺序接收每条原生事件，包括重复的碰撞对/阶段事件。
- **触发器**（`havok-trigger.ts`）：`setPhysicsShapeIsTrigger`、`onPhysicsTrigger` 以及关注刚体的 `onPhysicsTriggerBodies`；两种订阅均返回释放器。关注刚体的事件包含 `bodyAIndex` / `bodyBIndex`（当事件指向不再受追踪的刚体时为 `-1`）。
- **空间查询**（`havok-queries.ts`）：`physicsRaycast`、`shapeCast`、`shapeProximity`。射线检测返回共享的 Lite `body` 外加 `bodyIndex`——从原生命中句柄解析出的基于零的瘦实例索引（普通刚体为 `0`，无法解析出受追踪刚体时为 `-1`），与 Babylon.js 一致。形状投射接收单个 `ignoreBody`，对应 Havok 的单个可选忽略刚体 ID，从而允许调用方扫描刚体自身形状而不立即命中自身。
- **高度场**（`havok-heightfield.ts`）：`createHeightFieldShape`。
- **角色控制器**（`character-controller.ts`）：运动学投射并滑动（cast-and-slide）移动；`moveWithCollisions` 使用 `worldStepSeconds(world)`（世界步长，未设置固定步长时则为场景每帧增量）将请求的位移转换为速度。`getPhysicsCharacterControllerBody` 暴露底层刚体以供查询和事件匹配。
- **浮动原点**（`havok-floating-origin.ts`）：`enableHavokFloatingOrigin` 让世界开启面向大世界渲染的多区域模拟（参见 [35-large-world-rendering.md](35-large-world-rendering.md)）。其 `step(world, dt)` 接收与单区域路径相同的经钳位的每步秒数。
- **调试查看器**（`physics-viewer.ts`）：碰撞体形状的线框叠加层。

---

## 测试

- `tests/lite/unit/physics-dispose.test.ts` —— 步进 / 步进后回调在创建时注册，并在销毁时彻底拆解（无泄漏、无释放后使用）。
- `tests/lite/unit/physics-timestep.test.ts` —— 世界步长默认为 `0`（独立于 `scene.fixedDeltaMs`），未设置时跟随场景每帧增量（响应运行期修改），传给 `HP_World_Step` 时转换为秒，且可通过 `setPhysicsTimestep` / `setPhysicsTimestepMs` 设置。
- `tests/lite/unit/physics-rotation-axis-locks.test.ts` —— 将非单位主惯量坐标系变换到刚体空间后将选定的刚体局部惯量分量置零；单轴锁定保留自由平面耦合，质量更新保留激活锁定，选择性解锁恢复最新的未锁定属性，且空输入/原生读取失败不会写入质量属性。
- `tests/lite/unit/physics-thin-instances.test.ts` —— 按矩阵顺序创建原生刚体、共享形状/质量传播、步进后矩阵同步、单次脏范围发布、完整原生刚体销毁，以及原生碰撞与角色控制器事件中与 Babylon.js 兼容的非零实例刚体及实例索引报告。
- 一致性场景（物理下落/堆叠/约束场景）设置 `scene.fixedDeltaMs = 1000 / 60`，使 Lite 与 Babylon.js 以完全一致的步长运行。
