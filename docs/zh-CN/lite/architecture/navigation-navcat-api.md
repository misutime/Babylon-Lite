# Navcat API 与结果类型

所有符号均为包根命名导出。`Vec3` 是 Lite 的 `{ x, y, z }` 状态类型。可选字段采用所链接契约中的默认值。句柄由工厂函数生成，而非由调用方自行构造。

```ts
interface NavcatManager {
    readonly backend: "navcat";
}
interface NavcatNode {
    readonly nodeRef: number;
    readonly flags: number;
    readonly area: number;
    readonly kind: "polygon" | "connection";
}
interface NavcatFilter {
    includeFlags?: number;
    excludeFlags?: number;
    pass?: (node: Readonly<NavcatNode>) => boolean;
    cost?: (from: Readonly<Vec3>, to: Readonly<Vec3>, current: Readonly<NavcatNode>, previous: Readonly<NavcatNode> | null, next: Readonly<NavcatNode> | null) => number;
}
interface NavcatOptions {
    halfExtents?: Vec3;
    filter?: NavcatFilter;
}
interface NavcatLocation {
    readonly nodeRef: number;
    readonly position: Vec3;
    readonly revision: number;
}
type NavcatNearestResult = { success: false } | { success: true; location: NavcatLocation };
interface NavcatPathPoint {
    position: Vec3;
    nodeRef: number | null;
    offMesh: boolean;
}
interface NavcatPathOptions {
    keepSearch?: boolean;
}
interface NavcatPathResult {
    success: boolean;
    complete: boolean;
    points: NavcatPathPoint[];
    nodeRefs: number[];
    revision: number;
}
interface NavcatRaycastResult {
    hit: boolean;
    fraction: number;
    position: Vec3;
    normal: Vec3;
    nodeRefs: number[];
}
type NavcatMoveResult = { success: false } | { success: true; location: NavcatLocation; visited: number[] };
```

```ts
createNavcatManager(json: string, options?: NavcatOptions): Promise<NavcatManager>;
replaceNavcatMesh(manager: NavcatManager, json: string): void;
exportNavcatMesh(manager: NavcatManager): string;
setNavcatFilter(manager: NavcatManager, filter: NavcatFilter | null): void;
disposeNavcatManager(manager: NavcatManager): void;
findNavcatNearestPoly(manager: NavcatManager, point: Vec3, halfExtents?: Vec3): NavcatNearestResult;
findNavcatPath(manager: NavcatManager, start: Vec3, end: Vec3, halfExtents?: Vec3, options?: NavcatPathOptions): NavcatPathResult;
raycastNavcat(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatRaycastResult;
moveAlongNavcatSurface(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatMoveResult;
```

路径的 `success` 包含部分路径；`complete` 仅在 SDK 返回 COMPLETE_PATH 时为 true，绝不根据点数推断。保留 SDK 的直行点网格外（off-mesh）标志。失败时返回空的点数组与节点数组。默认情况下结果不保留 A* 搜索图。仅当调试叠加层需要私有搜索快照时，才将第五个参数设为 `{ keepSearch: true }`；该快照绝不会进入管理器。

表面射线检测在遍历多边形时忽略目标点 Y 坐标。未命中时使用 `fraction=1`、零法线以及投影到最终多边形上的终点；命中时使用钳制后的 SDK t 值、转换后的向外法线以及投影命中位置。SDK 返回 `Number.MAX_VALUE` / 边 -1 视为未命中。Location 必须标识管理器当前修订版本（revision）中有效且可通过的多边形；当后续过滤器排除了起点时，射线检测/移动会抛出异常。移动返回 SDK 经高度投影后的位置以及一个全新的 location。

```ts
interface NavcatConnectionOptions {
    start: Vec3; end: Vec3; radius: number; bidirectional?: boolean;
    flags?: number; area?: number;
}
interface NavcatConnection { readonly id: number }
addNavcatConnection(manager: NavcatManager, options: NavcatConnectionOptions): Promise<NavcatConnection>;
removeNavcatConnection(manager: NavcatManager, connection: NavcatConnection): Promise<boolean>;
isNavcatConnectionConnected(manager: NavcatManager, connection: NavcatConnection): Promise<boolean>;
```

连接句柄私下存储所属管理器与 SDK 序列号（sequence）。成功的图变更会递增管理器修订版本，使旧的 location/搜索结果失效，而现有连接句柄通过其序列号与网格标识保持有效。重复移除或传入外部/过期连接会返回 false。管理器销毁后的其他操作会抛出异常。选项默认 bidirectional 为 true、flags 为 1、area 为 0。radius 必须为正数。输入在首个异步边界之前完成拷贝；在销毁/替换之后才完成的异步操作会拒绝（reject），而不会修改已过时的网格。

内部状态通过 `@internal` 成员保存在上述同一批接口上：管理器包含 `_mesh`、`_api`、`_filter`、`_queryFilter`、`_halfExtents`、`_halfExtentsTuple`、`_revision`、`_meshVersion`、`_disposed`；location 包含 `_owner`；连接包含 `_owner`、`_meshVersion`、`_sequence`、`_removed`；路径包含 `_owner`、`_search`。`.d.ts` 裁剪会移除这些成员及所有仅限 SDK 的类型导入。没有任何公共/内部伴随接口或附加方法。

过滤器回调接收可复用的左手系（LH）向量/节点视图，仅在同步回调期间有效。如需在之后使用，请拷贝所需值。每个管理器都会缓存其 SDK 过滤器及校验后的半包围尺寸（half-extents）元组；未修改的过滤器直接委托给 SDK 默认过滤器。查询临时元组以及 SDK 最近点/最接近结果在全局重入守卫之后复用，而返回的公共向量与数组保持为调用方自有的快照。
