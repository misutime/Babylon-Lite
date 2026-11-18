# Babylon Lite 双语文档站

英文原文位于 [`docs/lite`](../lite/00-welcome.md)，中文译文位于 [`docs/zh-CN/lite`](../zh-CN/lite/00-welcome.md)。两套正文使用相同的相对路径。独立站首页 `/` 显示中文，`/en/` 显示英文，页面顶部可切换到对应语言。

在 Babylon Lite 仓库根目录运行：

```sh
pnpm --dir docs/local-site install --frozen-lockfile
pnpm --dir docs/local-site dev
pnpm --dir docs/local-site build
pnpm --dir docs/local-site preview
```

静态构建产物位于 `docs/local-site/.vitepress/dist/`。站点依赖由本目录的 `pnpm-lock.yaml` 管理。

## 同步译文

同步上游后，运行以下命令查看英文源的变化以及缺失或多出的中文页面。检测到差异时检查会返回非零状态。

```sh
pnpm --dir docs/local-site translations:check
```

以 [`translation-base.txt`](translation-base.txt) 记录的提交为基准，用 `git diff <基准 SHA> -- docs/lite` 阅读英文差异。更新同路径的中文文档，随上游文档的新增、重命名和删除调整中文目录。运行文档构建，确认两套页面和链接可用后，将基准更新为已同步的英文源提交完整 SHA，再运行一次检查。检查根据源文件变化和中英文文件路径判断同步状态，具体译文以本次英文差异为准。
