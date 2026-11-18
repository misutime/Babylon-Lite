# 节点材质块选择（Node Material block selection）

默认的节点材质（Node Material）加载器支持任意序列化图。对于固定图，`createNodeMaterialBlockLoader` 仅选择已知的块类型，从而避开通用注册表，同时保留发射器（emitter）的延迟加载特性。

## API 与所有权

所有导出均来自 `babylon-lite` / `@babylonjs/lite`，绝不通过包子路径导出：

```ts
import { createNodeMaterialBlockLoader, nodeInputBlock, nodeFragmentOutputBlock, parseNodeMaterialFromSnippet } from "@babylonjs/lite";

const blockLoader = createNodeMaterialBlockLoader([nodeInputBlock, nodeFragmentOutputBlock]);
// 传入实际图中的所有类，包括未连接的块。
const material = await parseNodeMaterialFromSnippet(engine, "", { json, blockLoader });
```

`NodeMaterialBlock` 暴露只读的 `className`。其内部 `_load` 回调会从公共声明中剥离。每个回调动态导入一个现有发射器；导入包根不会急切执行所有块实现。不存在模块级注册表或注册副作用。该工厂在每次调用时创建一个私有映射，拒绝畸形描述符与重复类，并返回现有的异步 `ParseNodeMaterialOptions.blockLoader` 契约。请使用导出的描述符值：仅构造包含 `className` 的对象无法提供加载器，会被立即拒绝。遇到未选中的类时会显式拒绝，绝不回退到完整注册表。

`nodePbrMetallicRoughnessBlock` 是核心实现。`nodePbrMetallicRoughnessBlockFull` 具有相同的类名并实现了高级 PBR 输入/高光抗锯齿。请勿同时选择两者。生成器会解析与默认加载器相同的实现，而非重复其特性检测逻辑。`nodeGeometryTextureOutputBlock` 提供按需启用的几何输出终端。着色器、材质输入、纹理更新、阴影变体及重建所有权仍归属于现有的解析器、发射器、管线与可渲染对象实现。

## 生成

`scripts/generate-node-block-catalog.ts` 使用 TypeScript AST 读取现有的基础/扩展注册表，并生成 `node-blocks.ts` 与包根命名导出。分组的 case 会继承共享的延迟导入，包括由命名辅助函数返回的导入。若任意注册表 case 缺少实现，生成将失败，而非静默忽略受支持的块。添加注册表条目后请运行该脚本；`--check` 可检测偏移（drift）。

从 JSON 生成图加载器：

```powershell
pnpm exec tsx scripts\generate-node-material-loader.mts --json graph.json --output graph-block-loader.ts
```

仓库内的图可改用 `--module path.ts --export name`。无参导出函数可异步返回图；当结果将其包装起来时，`--property json` 用于选择图。模块输入会执行受信任的构建期代码。`--package babylon-lite` 指定工作区导入名称。默认会保护现有输出文件；`--force` 强制重新生成，`--check` 仅比对而不写入。仅当序列化的块类或 PBR 特性需求发生变化时才需重新生成，仅更新实时材质 uniform/纹理值时无需重新生成。

生成的模块导出 `createBlockLoader()`。它属于**计入体积的运行时代码**，而非排除在外的图数据负载。CLI 会拒绝以 `-nme.ts` 或 `-npe.ts` 结尾的输出文件名。

## 覆盖范围

`node-block-loader.test.ts` 将每种选择与现有注册表实现进行比对，比对纹理、完整 NME、PBR、循环及几何图所发出的着色器/状态，并覆盖畸形/重复/缺失选择以及核心/完整 PBR。它独立枚举默认注册表 case 以检查目录完整性，并为全部四个共享矩阵块 case 生成加载器。发布声明覆盖率测试确保调用方仅使用根导出且无法访问 `_load`。默认加载器对照仍属于限定范围的 bundle 战役的一部分。

图预编译属于独立事项：当前构建状态包含 Map 与特性回调，且几何视图会从保留的图/发射器重新发射代码。安全的 AOT 格式必须编码这些需求并保留实时输入；单纯序列化 `emitGraph()` 会丢失它们。此处不添加任何 AOT 运行时或格式。
