# 模块：打包体积工具链（Bundle Size Tooling）

> 包路径：`scripts/bundle-scenes-core.ts`、`scripts/build-bundle-scenes.ts`、`scripts/build-master-bundle-info.ts`、`scripts/report-bundle-size-deltas.ts`、`lab/index.html`

## 用途

打包体积工具链为每个 lab 场景构建生产环境 Vite bundle，测量运行时实际拉取的 JavaScript 体积，并在 lab 的 Bundle 标签页中展示本地与 master 的体积对比。

该工具链包含两个独立的数据层：

1. **运行时体积清单（Runtime size manifests）** —— 每个场景的原始/gzip 总大小以及运行时加载的 chunk 名称。
2. **文件/模块明细（File/module breakdowns）** —— 供 Bundle 标签页 Files 弹窗使用的每个场景的 Rollup chunk 及压缩后源模块归因数据。

所有生成的本地与 master bundle 数据均已加入 gitignore；master 基线由 CI 发布，而非在仓库中跟踪。

## 清单语义

每个场景的 bundle 数据存储在 `lab/public/bundle/manifest/` 下的单个 JSON 文件中，并聚合为一个 `manifest.json`，供运行时消费者（lab UI、bundle-size 测试、报告脚本、静态 lab 站点）读取。**这些文件均不受版本控制**——整个 `lab/public/bundle/` 目录树都是构建生成产物。

| 文件                                      | 生成方式                                                         | 是否受控 | 含义                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `lab/public/bundle/manifest/<scene>.json` | `pnpm build:bundle-scenes`                                       | 否       | 本次构建的按场景运行时测量结果。                                                                                         |
| `lab/public/bundle/manifest.json`         | `pnpm build:bundle-scenes`（由各场景文件聚合而成）               | 否       | 所有场景文件的聚合，在运行时被消费。这就是 master 发布的基线文件。                                                       |
| `lab/public/bundle/master-manifest.json`  | `pnpm build:bundle-scenes` 与 `pnpm build:bundle-master-info`    | 否       | master 基线，从公开 URL（或显式指定 git ref 时从该引用）拉取，用于生成增量报告。                                         |

`local-manifest.json` 不属于该架构，严禁使用。

### 基线来源

它会在每次 master 构建时测量一次，并发布到一个稳定的公开 URL：

```
https://snapshots-cvgtc2eugrd3cgfd.z01.azurefd.net/lite/bundle-baseline/manifest.json
```

`pnpm build:bundle-scenes` 会拉取该文件并写入 `master-manifest.json`。

这取代了原先在 git 中跟踪、由 PR 作者刷新的约 227 个 JSON 文件基线。由于几乎任何共享模块的改动都会让约 230 个场景中的大部分发生字节变动，原有方案同时从两个方面破坏了仓库体验：

- **CI 变红** —— 一旦任意共享代码 PR 合入，其他所有未合入 PR 提交的清单立即过期，其 Bundle Size 任务就会因为与该 PR 无关的原因失败，只能通过 rebase 外加非常耗时的本地全量重构建来修复，而下一次合入后又会重演。
- **合并冲突** —— 两个都重新生成过清单的分支会重写相同的约 200 个受控文件并在 git 中发生冲突。这曾是仓库最主要的冲突来源：在一个典型 PR 中，169 个冲突路径里有 168 个是清单文件，而源码文件为**零**。

两种症状根源相同：由构建生成的文件留在 git 中，出现在本不该携带它的分支上。改为发布而非提交消除了这个根源——不再有会过期的受控文件，两个分支之间也不会再因此冲突。

采用发布而非推送回 master 的方式，也避免了 CI 进入仓库写入路径。`master` 受分支保护（要求至少一项审批，以及带有必选状态检查的规则集），且 CI 身份刻意不持有绕过权限，因此在不削弱该保护的前提下，由机器人向 master 提交基线的方案无法成立。

这种设计是安全的，因为该基线**不充当任何门禁**：

- 体积**门禁**读取 `scene-config.json`（`maxRawKB`），由 `pnpm build:bundle-scenes` 按精确字节强制校验；
- 基线仅用于给出建议性的“相对 master 变化量（increased vs master）”参考。

因此，基线缺失或不可达只会降级为“无增量报告”，绝不会导致构建失败。`bundle-size.spec.ts` 会跳过其建议性警告，`report-bundle-size-deltas.ts` 则会设置 `POST_BUNDLE_COMMENT=false` 并以退出码 0 结束。

| 构建类型          | 是否测量 | 是否强制校验上限 | 是否发布基线 |
| ----------------- | -------- | ---------------- | ------------ |
| PR 验证           | 是       | 是               | **否**       |
| Master（已合入）  | 是       | 是               | 是           |

因此 PR 验证的 Bundle Size 任务会执行以下步骤：

1. 测量每个场景（`pnpm build:bundle-scenes`），当某个场景超出其 `scene-config.json` 上限时**判定任务失败**——这是确定性、永不过期的门禁；
2. 将相对已发布基线的体积变化作为 PR 评论发布（`report-bundle-size-deltas.ts`），以便审阅者查看体积影响。

`azure-pipelines-bundle-manifest.yml` 会在每次推送到 master 时重新测量，将 `manifest.json` 上传至部署服务器，然后刷新 CDN 缓存以便新基线及时可见。它会拒绝发布空清单或缺失的清单，因此失败的构建不会清空基线；而且上限检查会最先运行，确保突破上限的构建绝不会被发布为新的正常基线。

若要在本地覆盖基线来源，可将 `BUNDLE_MASTER_MANIFEST_FILE` 设为已下载的清单文件路径，或将 `BUNDLE_MASTER_MANIFEST_URL` 置空以跳过拉取。

场景 bundle 是基于包编译后的 **`build/lib`** 产物构建的（即 `@babylonjs/lite` 真实消费方解析的模块粒度目录树），而非 TypeScript 源码——从而确保测量出的体积与下游打包器产物完全一致。`pnpm build:bundle-scenes` 会先执行 `build:lib`；若缺少 `build/lib` 则快速失败。（lab 开发应用与用于 master 对比的 bundle-info 为了快速开发迭代循环仍直接解析 `babylon-lite` 源码；两者体积可能略有差异，但场景打包体积测试才是防止体积漂移的权威守卫。）

每个场景的运行时测量结果都会减去其自身的**忽略字节数（ignored bytes）**，该数值由本次构建自身的 `bundle-info` 计算得出。忽略集合包含（a）本地 `*-nme.ts` NME 数据载荷，以及（b）按需打包的第三方 WASM/字形整形运行时——`text-shaper`（默认排版文本）、`manifold-3d`（CSG2）和 `@recast-navigation`（导航网格）——它们各自仅由需要它的特性加载，使引擎体积上限专门追踪我们自己的运行时代码。上限检查始终使用当前构建自身的统计口径；`master-manifest.json` 仅用于计算建议性的“相对 master 变化量”，绝不参与受门禁约束的 `rawKB` 计算。

## 文件/模块明细语义

| 文件                                                | 生成方式                        | 是否受控 | 含义                                                                                  |
| --------------------------------------------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `lab/public/bundle/bundle-info/<scene>.json`        | `pnpm build:bundle-scenes`      | 否       | 当前/本地 Rollup chunk 列表，包含压缩后模块字节归因及存活的导出符号。                 |
| `lab/public/bundle/master-bundle-info/<scene>.json` | `pnpm build:bundle-master-info` | 否       | 从选定 master ref 的归档中生成的同类明细。                                            |

`build-master-bundle-info.ts` 按 `MASTER_BUNDLE_REF`、`upstream/master`、`origin/master`、`master` 的顺序解析 master 引用。它会在构建 `master-bundle-info` 之前从同一引用写入 `master-manifest.json`，以确保 master 文件对比与运行时 chunk 过滤使用一致的基线。

## 构建命令

```text
pnpm build:bundle-scenes
```

构建选定的本地场景（通过 `BUNDLE_SCENES=scene1,scene75` 指定子集），写入本地场景 bundle，写入 `bundle-info/<scene>.json`，写入/更新生成的按场景 `manifest/<scene>.json` 文件及聚合 `manifest.json`，并从 master 刷新 `master-manifest.json`。所有这些输出产物均已加入 gitignore。

```text
pnpm build:bundle-master-info
```

从选定的 master 引用（可通过 `MASTER_BUNDLE_REF=...` 覆盖）为选定场景（`BUNDLE_SCENES=...`）构建 master 文件/模块明细，写入 `master-bundle-info/<scene>.json`，并从同一引用刷新 `master-manifest.json`。

## PR 场景影响范围筛选

完整的 master bundle 构建会在体积基线旁一并发布 `impact-manifest.json`。它由每个场景静态可达的所有 Rollup chunk 生成，并将仓库源码文件映射到可能消费它们的场景。这里刻意包含单次基线测量时未拉取的懒加载 chunk，从而防止后续交互和非确定性运行时分支导致漏选场景。本地源码依赖（如原始 WGSL 导入）也包含在该映射中。该文件是生成的部署产物，而非受控源码。

PR 任务会针对确切的 merge-base 提交所对应的不可变影响清单运行 `pnpm select:affected-scenes -- --azure`。选择器将该映射与直接命名的场景文件及变更的 `scene-config.json` 条目结合，随后分别为 bundle-size、parity 和 performance 场景设置独立的 Azure 变量。新增文件会继承导入它的已变更受映射模块所关联的场景。

筛选策略采用故障闭合（fail-closed）：

- 影响清单不可用或不匹配时，运行时代码的变更将触发全量场景运行；
- 存在未映射或未分类的运行时文件时，运行全量场景；
- 文档、缩略图、多数单元测试、compat 以及仅限 playground 的改动会跳过 WebGPU 场景任务；
- bundle 内容单元测试会显式筛选其基于 bundle 的断言所需的场景固件；
- 云端场景测试取决于是否存在 Playwright 场景 spec 文件，与 `skipParity` 是否禁用该场景的 Babylon/基准图对比无关；
- 主动退出 bundle-size 或 performance 检查的场景仅会从对应任务中移除。

每次 master 构建仍会测量全部场景，并重新发布体积清单与影响清单。这会在每次合入后刷新依赖映射，在保持全仓库覆盖的同时避免让生成的元数据成为合并冲突源。

## 压缩后归因

`bundle-scenes-core.ts` 使用隐藏 sourcemap 进行构建，并对最终压缩产物执行模块归因：

- chunk `bytes` 为最终输出的 UTF-8 JavaScript 字节数
- module `bytes` 为压缩后经 sourcemap 归因的字节数
- 归因压缩字节数为零的模块会被省略
- lab 的 Files 弹窗会为无法归因到任何源模块的字节添加一行 `(chunk overhead)`

即使独立源码或输出模块代码未变，单个模块的微小字节变动也可能是 sourcemap 归因漂移所致。chunk 总量始终是权威的输出体积。

## Lab Bundle 标签页

Bundle 标签页加载以下数据：

- `/bundle/manifest.json` 用于当前/本地场景总计
- `/bundle/master-manifest.json` 用于 master 场景总计
- `/bundle/bundle-info/<scene>.json` 用于本地文件/模块明细
- `/bundle/master-bundle-info/<scene>.json` 用于 master 文件/模块明细

场景卡片与摘要会将本地 `manifest.json` 数值与 `master-manifest.json` 进行对比。

当两份明细均可用时，Files 弹窗会对比本地与 master 的 chunk/模块字节数：

- 匹配 chunk 名称时忽略 Rollup 哈希后缀。
- 仅本地存在的 chunk/模块显示正增量。
- 仅 master 存在的 chunk/模块在本地显示为 `0 B`，增量为负值。
- 零增量条目会被隐藏。
- 排序时保留对比分组（共有、仅本地、仅 master），并在各分组内部应用 Size/Path 与升序/降序。
- 运行时 chunk 过滤使用各自数据源自身的清单（本地使用 `manifest.json`，master 使用 `master-manifest.json`）。

## CI 评论脚本

`scripts/report-bundle-size-deltas.ts` 对比以下两者：

- 当前构建：`lab/public/bundle/manifest.json` 或 `BUNDLE_SIZE_CURRENT_MANIFEST`
- master：`lab/public/bundle/master-manifest.json` 或 `BUNDLE_SIZE_MASTER_MANIFEST`

它会输出取整到 KB 的 Markdown 摘要，以及用于控制是否发送 PR 评论的 Azure 变量。

## 文件清单

| 文件                                   | 用途                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `scripts/bundle-scenes-core.ts`        | 共享的 bundle 构建、运行时测量、清单生成、压缩归因及 bundle-info 写入逻辑。            |
| `scripts/build-bundle-scenes.ts`       | 本地/当前 bundle 构建入口。                                                            |
| `scripts/build-master-bundle-info.ts`  | master 引用归档提取与 master 文件/模块明细生成。                                       |
| `scripts/report-bundle-size-deltas.ts` | 基于当前清单与 master 清单生成 PR 评论增量报告。                                       |
| `azure-pipelines-bundle-manifest.yml`  | 由 master 触发的流水线，重新测量所有场景并发布基线清单。                               |
| `lab/index.html`                       | Bundle 标签页摘要、场景卡片与 Files 弹窗对比界面。                                     |
| `lab/vite.config.ts`                   | 面向当前/master bundle 清单的 lab 开发服务器重载签名。                                 |
