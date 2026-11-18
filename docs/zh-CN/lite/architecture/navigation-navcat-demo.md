# Navcat 调试与仅查询演示

```ts
interface NavcatDebugGeometry {
    kind: "triangles" | "lines" | "points";
    positions: Float32Array; colors: Float32Array; indices?: Uint32Array;
}
interface NavcatDebugOptions { navMesh?: boolean; connections?: boolean; search?: NavcatPathResult }
createNavcatDebugGeometry(manager: NavcatManager, options?: NavcatDebugOptions): Promise<NavcatDebugGeometry[]>;
```

## 调试行为

可选的调试运行时使用具名 Navcat 辅助函数来生成网格、网格外连接及保留的路径搜索节点。默认值为 mesh 为 true、connections 为 true、无 search。路径搜索保留通过 keepSearch 按需开启；演示仅在勾选调试开关时启用它。传入的 search 必须属于当前管理器及当前图修订版本。在导入后以及读取搜索结果前，均会再次检查存活状态/网格版本。

返回经拷贝的左手系（LH）CPU 三角形/线段/点图元，使用 Float32 位置与并行的 RGB 颜色，且不创建基于展开语法（spread）的中间数组。对 Z 轴取反；三角形在取反后采用 Lite 绕序。SDK 辅助结果当前包含三角形、线段和点；对于不支持的图元类型会直接拒绝，而非静默丢弃几何体。适配器不存储也不创建任何 GPU 缓冲区、材质、场景引用或钩子。调用方拥有渲染权，并负责释放自己创建的任何网格。演示会从场景中移除退役的叠加层，并使用当前 main 的 `removeFromScene` 延迟 GPU 退役机制（在已提交工作完成后调用 `disposeMeshGpu`），并在多次查询间复用路径线、调试线和三角形材质，以保持材质自有的 uniform 缓冲区有界。路径本身已作为调用方自有的折线存储在 `NavcatPathResult.points` 中。

## 演示

开发者故事：加载一个小型离线烘焙导航资产，选择路径起终点，查看完整/部分路径，应用可通过性或代价过滤器，检查调试几何体，销毁并重新加载后端。无需下载 Wasm 或在浏览器内生成导航网格。

使用现有的 lab 引擎/相机/灯光/标准材质/线条工厂。围绕中央孔洞的程序化地面与原始夹具一致；起终点标记和一条路径在 Lite 坐标系中可视化查询结果。下拉选择控件提供非对称起终点预设。按钮支持查询、替换/重新加载、销毁与重置后端。过滤器选择器演示封闭区域与加权遍历；调试复选框显示已烘焙的网格。状态栏通过 `role=status`/aria-live 播报就绪/失败/路径完整性以及当前路径点数。控件保持键盘可访问、响应式且带有标签。页面链接至锁定的上游 SDK 与文档，为开发者提供背景参考。

默认运行时路径仅导入管理器/查询及可选的 CPU 调试代码；演示中不调用生成或连接修改启用器。如需的话，夹具可以包含一个烘焙连接；单元测试独立验证动态修改。通过清空调试/路径几何体并报告销毁状态来直观展示图拆解；重复重新加载/查询必须正常工作。

不得修改基准图参考或 scene-config 阈值：维护者明确要求为该新 API 制作独立演示。在 `demos-config.json` 中注册 `navcat`，并创建其 HTML/脚本、原始 JSON + 生成配方，以及位于 `lab/public/thumbnails/demo-navcat.jpg` 的 1280×720 JPG 缩略图。演示通过现有的生产 bundle 机制加载，独立于对等性场景注册。

## 验证

构建原生包与单个演示，在 Chrome 中操作各控件，检查实际的 JS/WASM 网络请求及生成的 chunk 图。仅查询运行时不得拉取生成器、群体（crowd）、Recast、Three 或 WASM。压缩后的仅查询发布库体积探针上限为原始 35 KiB、gzip 12 KiB，且所有 Navcat/mathcat 代码均计入其中。全部 Navcat/mathcat 字节均计入运行时体积；它们不适用 Recast/vendor 统计排除规则。验证销毁/重新加载、无控制台/页面错误以及具有代表性的缩略图。渲染使用现有 API，不修改着色器也不做对等性声明。
