# Navcat 几何体提取与独立生成

```ts
interface NavcatGeometry { positions: Float64Array; indices: Uint32Array }
interface NavcatBuildOptions {
    cellSize?: number; cellHeight?: number;
    agentRadius?: number; agentHeight?: number; maxClimb?: number; maxSlope?: number;
    minRegionArea?: number; mergeRegionArea?: number;
    maxSimplificationError?: number; maxEdgeLength?: number; maxVerticesPerPoly?: number;
    detailSampleDistance?: number; detailSampleMaxError?: number;
}
extractNavcatGeometry(meshes: readonly Mesh[]): NavcatGeometry;
generateNavcatMesh(geometry: NavcatGeometry, options?: NavcatBuildOptions): Promise<string>;
```

## 源几何体

提取函数返回调用方自有的右手/逆时针（RH/CCW）CPU 三角形。读取保留的 `_cpuPositions`、`_cpuIndices` 以及最新的 `worldMatrix`；不拷贝法线，也不要求着色数据。先统计总长度，一次性分配精确大小的 Float64Array/Uint32Array 缓冲区，随后通过顶点/索引偏移填充数据，不使用装箱临时数组。拒绝缺失/畸形/非有限几何体、无效索引、非三角形拓扑、奇异/非仿射变换、已退役网格以及实时骨骼/变形目标（morph）/VAT/薄实例几何体。该操作代表所选的静态几何体，而非动画帧或实例展开。调用方可在提取前自行烘焙/展开此类几何体。

将每个局部点乘以列主序仿射世界矩阵，然后对世界 Z 取反。全程保持 Float64 精度。设行列式符号为 `s`，原始创作符号为 `a = mesh._authoredSign ?? 1`，当且仅当 `s !== a` 时交换每个三角形的后两个索引。这与 Lite 渲染的原始创作正面一致：程序化地面具有左手绕序，而 glTF 的右手几何体在其根节点 Z 翻转下被标记为创作符号 -1。不要在 Z 反射后无条件反转绕序。

零/负缩放、平移、非均匀缩放与父级变换均通过当前世界矩阵覆盖。空网格列表明确失败。该辅助函数既不修改源几何体也不改变任何网格状态，且不引用场景/引擎。

## 生成

`generateNavcatMesh` 消费右手/逆时针（RH/CCW）几何体，而非 Lite 局部数组。在任何导入 await 之前，同步拷贝所有位置/索引与归一化后的选项。在进行类型化转换前校验完整的三元组、有限位置以及范围内的整数索引。保留 float64 位置精度。

延迟导入生成运行时后，从 `navcat/blocks` 调用锁定的 SDK `generateSoloNavMesh`；将其 `navMesh` 包装进带版本号的资产信封中。中间产物为局部对象并随后丢弃。不创建任何管理器、Worker、定时器、Three、Recast 或 WASM。空/不可行走的生成网格仍然是有效 JSON，其查询会返回失败。在异步导入之后，生成属于同步 CPU 工作，适用于离线工具或显式的应用调用。

默认选项为 cellSize .15、cellHeight .1、agentRadius .3、agentHeight 1.8、maxClimb .4、maxSlope 45 度、minRegionArea 1、mergeRegionArea 20、maxSimplificationError 1.3、maxEdgeLength 12、maxVerticesPerPoly 6、detailSampleDistance .9、detailSampleMaxError .1。

使用 `ceil(world/cell)` 推导 SDK 体素半径/高度，使用 `floor(world/cell)` 推导攀爬高度；SDK 的世界空间字段则原样传入物理值。borderSize 为 0（独立网格）。其余区域/边长/细节设置原样传递给对应的命名 SDK 选项。体素尺寸与高度为正数；半径/攀爬/区域/误差/边长/细节值为非负数；坡度位于 `[0,90]`；maxVerticesPerPoly 为 `[3,6]` 内的整数。

## 原始夹具与来源

已检入的配方使用独立创作的单位四边形构建一个带有中央 2×4 矩形孔洞的 12×8 地面，并使用默认物理选项生成带版本号的 Navcat 资产。源位置为右手/逆时针（RH/CCW）。配方将下方中央通道标记为 area 2，用于可通过性/代价演示。仅查询演示加载此 JSON，且不导入该配方或生成器。其中不包含任何第三方几何体、演示源码或复制的导航算法。

## 测试

生成并查询真实的平坦地面，随后测试镜像及 glTF 创作的等效地面。断言平移/缩放后的坐标以及未改变的源数组。明确拒绝不支持的几何体。验证在开始生成后修改输入无法影响结果，自定义构建参数保留在 JSON 中，无效选项在 SDK 执行前即失败，并且通过可观测的生成正向对照确认仅查询生产 bundle 中不包含生成代码。
