# 可选 Navcat 导航

## 用途与需求

Issue [411](https://github.com/BabylonJS/Babylon-Lite/issues/411) 在保持 Recast 不变的同时新增了一个纯 JavaScript 备选方案。约定的演示消费离线烘焙的 JSON；生成功能则是独立可选的。不声称与 Babylon.js API 对等。

MVP 覆盖最近多边形、完整/部分路径、表面射线检测/移动、自定义可通过性/代价、独立生成、网格外连接、调试几何体、替换与确定性拆解。群体（crowd）模拟、Worker、动态障碍物与分块生成均不在本版本范围内。

## 契约

- 公共句柄为纯状态对象；所有行为均作为独立的包根导出函数提供。任何 SDK 类型、GPU 句柄或额外包入口都不会进入公共声明。
- 公共位置/方向采用 Lite 左手 Y 轴向上坐标系。原始 JSON 与生成输入采用 Navcat 右手 Y 轴向上/逆时针（CCW）坐标系。在边界处仅对 Z 轴执行一次取反转换。
- 每个管理器独占一个经 JSON 解析的网格。查询结果与调试数组均为调用方自有的快照，绝非借用的 SDK 缓冲区。
- 节点引用 0 与连接 ID 0 均有效。在网格替换、销毁或图修改后引用会失效；location/连接句柄会拒绝外部管理器与过期修订版本。
- 查询回调为同步调用。从回调中发起嵌套查询或修改会抛出明确错误，并通过 `finally` 恢复；SDK 临时存储是共享的，无法支持重入。
- 管理器内绝不持有场景、引擎、DOM 元素、Worker、定时器、事件钩子或 GPU 分配。

## 架构

`navcat.ts` 包含异步工厂与生命周期函数。它动态导入 `navcat-runtime.ts`，而后者仅静态导入具名的 SDK 查询导出。`navcat-queries.ts` 通过已初始化的运行时委托执行同步查询。`navcat-state.ts` 负责校验、生命周期/重入检查以及坐标转换，在运行时不导入 SDK。

`navcat-generation.ts` 在导入 `navcat-generation-runtime.ts` 与 `navcat/blocks` 之前先拷贝并校验输入。`navcat-connections.ts` 独立导入连接运行时。`navcat-debug.ts` 独立导入调试运行时。仅查询的消费方绝不会保留这些可选实现。无需修改渲染循环或 Recast 后端。

原生库构建会将 SDK 代码打包进普通 chunk；查询与生成必须保持可分离。两个打包的 MIT 许可证（Navcat 0.4.1 与 mathcat 0.0.12）均由现有的 NOTICE 管线收录。mathcat 已显式声明以便进行归属解析。两者都不会成为发布的运行时依赖或公共类型依赖。未使用 Three。

## 规范链接

- [API 与结果类型](navigation-navcat-api.md)
- [所有权、JSON 与过滤器](navigation-navcat-data.md)
- [几何体提取与独立生成](navigation-navcat-generation.md)
- [调试与演示](navigation-navcat-demo.md)

## 验证与任务

1. 使用原始夹具验证精确版本 SDK 的 JSON/查询/过滤器/连接/绕序及打包可行性。
2. 实现指定模块与包根导出，随后实现原始离线烘焙演示。
3. 真实 SDK 单元测试覆盖非对称坐标转换、零引用、完整/部分路径、射线未命中/命中、移动、过滤器、无效输入、过期句柄、回调重入及拆解/重新加载。
4. 生成测试覆盖物理选项转换、输入所有权以及变换/镜像/glTF 地面。调试测试覆盖自有数组与过期搜索结果。
5. 发布包根探针检查干净的声明/元数据、无 WebGPU 的 Node 环境以及正向查询运行时行为。Bundle 探针证明未使用后端被消除，且仅查询包排除了生成/群体/调试/修改/Recast/WASM，并满足固定的仅查询原始/gzip 字节守卫与正向生成对照。
6. 仅构建/运行新演示与现有对照场景 165、213 及 Recast 170。统计所有 Navcat/mathcat 运行时字节；不得修改阈值、基线数据或基准图。现有场景字节数必须保持不变。
7. 运行格式化、lint、全部六个类型项目、原生构建、限定范围测试以及与相关未合并 PR 的组合测试。提交与发起 PR 前检查代码/来源/隐私合规性。

## 管线 / 着色器配置

无：这是纯 CPU 导航。调试几何体为调用方自有数据，使用现有网格/线条工厂渲染；不引入任何着色器或管线变体。

## 文件清单

原生代码 `navigation/navcat*.ts`；架构文档 `navigation-navcat*.md`；真实 SDK 单元/构建测试；`lab/lite/src/demos/navcat.ts`、`lab/lite/demo-navcat.html`、原始 JSON 资产/配方、演示目录及 JPG 缩略图；原生依赖/锁文件/许可证列表更新。

## 用法

```ts
import { createNavcatManager, findNavcatPath, disposeNavcatManager } from "@babylonjs/lite";
const manager = await createNavcatManager(bakedNavMeshJson); // 适用于 Navcat 0.4.1 的带版本号 RH 资产
const path = findNavcatPath(manager, { x: -4, y: 0, z: 2 }, { x: 4, y: 0, z: -2 });
// path.points 为左手系（LH）快照；path.success 可能表示一条部分路径。
disposeNavcatManager(manager);
```

## 已验证行为

真实 SDK 测试套件覆盖导航查询、带版本号资产损坏/重新加载、分配生命周期以及 27 个现有 Recast 用例。发布包根检查涵盖无外部 SDK 的声明、完整的根 API 以及两份 MIT 许可文本。发布库正向对照执行了仅查询与生成 bundle；未使用的后端已被消除。6 个故意植入的坐标、部分状态、保留引用、过期引用、绕序和重入变异体均被检出。原始演示在桌面/移动端控件、替换、销毁与重新加载下运行，无页面/网络错误。不做对等性或性能声明。
