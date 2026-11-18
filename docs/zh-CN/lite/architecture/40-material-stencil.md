# 模块：材质模板测试（Material Stencil）

> 包路径：`packages/babylon-lite/src/material/`
> 文件：`material.ts`（`StencilState`）、`stencil-state.ts`、`enable-material-stencil.ts`，以及位于 `pbr-pipeline.ts`、`standard-pipeline.ts`、`shader-pipeline.ts`、`pbr-renderable.ts`、`standard-renderable.ts`、`engine/engine.ts` 中的模板接缝。

## 用途

可选的按材质**模板测试（stencil test）**，直接烘焙进材质的主通道管线中。允许一种材质在其绘制的位置**写入**模板缓冲区（作为遮罩），而另一种材质在已写入模板的位置**丢弃**片元——无需动态模板参考值（stencil reference）。典型用途：传送门、贴花以及镜面/裁剪遮罩。

所有具体材质类型（Standard、PBR、Shader）共享该能力，因此彼此之间互不依赖。模板测试仅在支持模板的深度目标（主颜色通道）上生效，在纯深度/阴影目标上会被忽略。

## 公共 API 接口

```typescript
interface StencilState {
    readonly compare?: GPUCompareFunction; // default "always"
    readonly passOp?: GPUStencilOperation; // default "keep"
    readonly failOp?: GPUStencilOperation; // default "keep"
    readonly depthFailOp?: GPUStencilOperation; // default "keep"
    readonly readMask?: number; // default 0xFF
    readonly writeMask?: number; // default 0xFF
}

// Attach to a material (post-creation optional property on all three kinds):
//   StandardMaterialProps.stencil?: StencilState
//   PbrMaterialProps.stencil?: StencilState
//   ShaderMaterial.stencil?: StencilState

function enableMaterialStencil(): void; // opt-in, process-global, before registerScene
```

无需动态参考值的遮罩/测试用法：**写入方**使用 `compare: "always"` + `passOp: "increment-clamp"`（绘制处模板值由 0 → 1）；**测试方**使用 `compare: "equal"`，仅在模板值仍为渲染通道默认参考值 `0`（即**未**被写入）的位置通过测试。

## 内部架构 —— 零开销按需启用

模板测试采用**显式按需启用（explicit opt-in）**，从而确保未使用模板的场景与完全不包含该特性的构建产物保持**逐字节一致**（与 `enableMaterialPlugins` 模式一致）。模板描述符的构造逻辑位于独立模块（`stencil-state.ts`）中，各管线构建器仅通过一个**模块局部解析器钩子**引用它，当未启用该特性时，Tree-shaker 与压缩器可将其完全折叠消除。

- `pbr-pipeline.ts`、`standard-pipeline.ts`、`shader-pipeline.ts` 各自声明一个模块局部变量 `let _stencilResolver: ((s: StencilState) => ResolvedStencil) | null = null` 以及一个导出的设置函数（`_installPbrStencilResolver` / `_installStandardStencilResolver` / `_installShaderStencilResolver`）。
- `stencil-state.ts` → `_resolveStencil(stencil)` 返回 `ResolvedStencil { _desc, _key }`：
    - `_desc`：部分 `GPUDepthStencilState`（`stencilFront`/`stencilBack` 共享同一个操作对象，外加 `stencilReadMask`/`stencilWriteMask`），默认值填充在此处完成，从而避免这些对象字面量落入始终拉取的依赖图中。
    - `_key`：管线缓存键后缀，确保仅模板状态不同的两个材质绝不会共享同一条管线。
- `enable-material-stencil.ts` → `enableMaterialStencil()` 导入 `_resolveStencil` 及上述三个设置函数，并将解析器安装到三条管线中。它是**唯一**导入该重型解析器的模块；因此当应用从不调用它时，`stencil-state.ts` 与 `enable-material-stencil.ts` 均不会进入依赖图，三个设置函数成为未使用的导出并被 Tree-shake 掉，而每个 `_stencilResolver` 都可被证明恒为 `null`。随后压缩器将 `stencil && _stencilResolver ? … : null` 折叠为 `null`，下游所有 `_stencil` / `_desc` 分支全部消失——Standard/PBR/Shader chunk 保持逐字节一致。
- 可渲染构建器（`buildPbrRenderables`、`buildStandardMeshRenderables`）将原始的 `mat.stencil ?? null` 传入 `getOrCreate{Pbr,Standard}Bindings`，后者通过钩子进行解析，将 `_key` 纳入绑定缓存键并保存 `_desc`。`getOrCreate{Pbr,Standard}Pipeline` 仅在 `sig._depthStencilFormat.includes("stencil")` 时才将 `bindings._stencil` 展开到深度模板描述符中。`shader-pipeline.ts` 则在 `getOrCreateShaderPipeline` 中通过自己的钩子完成解析并展开得到的 `_desc`。

## 管线配置

`depthStencil.{stencilFront,stencilBack}` = `{ compare, passOp, failOp, depthFailOp }`；`depthStencil.{stencilReadMask,stencilWriteMask}` = 对应掩码。仅应用于主颜色通道（`*-stencil8` 格式）；同一个材质在 `depth32float` 阴影/深度通道中仍保持纯深度状态，因此不会出现深度模板格式不匹配问题。

## Babylon.js 对照表

| Babylon.js                                       | Babylon Lite                                            |
| ------------------------------------------------ | ------------------------------------------------------- |
| `material.stencil.func` / `funcMask`             | `StencilState.compare` / `readMask`                     |
| `material.stencil.opStencilDepthPass`            | `StencilState.passOp`                                   |
| `material.stencil.opStencilFail` / `opDepthFail` | `StencilState.failOp` / `depthFailOp`                   |
| `material.stencil.mask`                          | `StencilState.writeMask`                                |
| 始终启用的模板状态                               | 按需启用 `enableMaterialStencil()`（未使用时零打包体积开销） |

## 依赖项

`material/material.ts`（`StencilState`）、`material/stencil-state.ts`（`_resolveStencil`），以及三个材质管线与可渲染对象模块。不引入新的运行时依赖；解析器仅在按需启用时才可达。

## 文件清单

- `material/material.ts` —— `StencilState` 接口（公共）。
- `material/stencil-state.ts` —— `ResolvedStencil`、`_resolveStencil`（内部；仅随按需启用链接）。
- `material/enable-material-stencil.ts` —— `enableMaterialStencil()`（公共按需启用入口；安装解析器）。
- `material/{pbr,standard,shader}/*pipeline.ts` —— 模块局部 `_stencilResolver` + `_install*StencilResolver` 设置函数 + 钩子门控模板接缝。
- `material/{pbr,standard}/*renderable.ts` —— 将原始 `mat.stencil` 传入绑定构建。
