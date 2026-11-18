# 模块：Compat SSAO2 场景管线

> 包路径：`packages/babylon-lite/src/post-process/scene-ssao.ts`、`packages/babylon-lite/src/post-process/screen-space-ambient-occlusion.ts`、`packages/babylon-lite/src/frame-graph/post-process-task.ts`

## 目的

提供一个按需启用的原生场景输出管线，使 Babylon.js 兼容包能够将其暴露为 `SSAO2RenderingPipeline`。原生模块负责渲染、渲染目标分配、图排序、尺寸调整行为、MSAA 解析（resolve）行为以及清理。兼容包仅负责转换 Babylon.js 的名称、默认值和相机管理器调用。

该管线有意复用并适配 Babylon Lite 现有的时域基于水平面的环境光遮蔽（temporal HBAO）。它不承诺与 Babylon.js SSAO2 在估计器级别达到像素完全一致。支持的输出路径为每个场景一个全屏活动相机和一个附着的 SSAO 管线。

## 公共 API 接口

```ts
export interface SceneSsaoPipelineOptions {
    name?: string;
    resolutionScale?: number;
    radius?: number;
    intensity?: number;
    base?: number;
    fadeEnd?: number;
    targetTexture?: RenderTarget;
    resolveTexture?: RenderTarget;
}

export interface SceneSsaoPipeline {
    readonly name: string;
    camera: Camera;
    resolutionScale: number;
    radius: number;
    intensity: number;
    base: number;
    fadeEnd: number;
    readonly attached: boolean;
}

export function createSceneSsaoPipeline(options: SceneSsaoPipelineOptions, engine: EngineContext, scene: SceneContext, camera: Camera): SceneSsaoPipeline;
export function attachSceneSsaoPipeline(pipeline: SceneSsaoPipeline, camera?: Camera): void;
export function detachSceneSsaoPipeline(pipeline: SceneSsaoPipeline, camera?: Camera): void;
export function disposeSceneSsaoPipeline(pipeline: SceneSsaoPipeline): void;
```

`createSceneSsaoPipeline` 创建初始处于分离（detached）状态的纯状态对象。独立的附着函数会分配并注册新的任务。分离函数会移除并释放所有自持有的任务与目标。释放函数具有幂等性，且会永久阻止重新附着。场景所有权和任务资源保存在惰性创建的模块私有弱映射（WeakMap）中，而非公共状态对象上。

`ScreenSpaceAmbientOcclusionPostProcessTaskConfig` 和 `ScreenSpaceAmbientOcclusionPostProcessTask` 新增了可变的 `base` 合成强度以及可选的可变 `resolveTexture`。`PostProcessTaskSettings` 和 `PostProcessTask` 新增了可选的可变 `resolveTexture`。

## 内部架构

控制器通过查找颜色目标或解析目标为场景表面交换链目标的渲染任务，来定位场景的默认渲染任务。当 PBR 透射（transmission）已经重定向了场景输出时，控制器会改为选择位于 `transmission-image-processing` 之前的那个渲染任务。控制器会临时重定向该现有任务，并在分离或回滚时精确恢复其原有的颜色/解析目标。

### 无 MSAA

1. `scene-source`：单重采样的表面相对尺寸颜色目标 `C`。
2. 现有场景渲染任务渲染到 `C`，同时保留其原有的深度附件。
3. 原生 SSAO 从 `C` 读取颜色，读取现有场景深度，并直接合成为 `scRT`。

### MSAA

1. 现有场景渲染任务保留其表面相对尺寸的 MSAA 颜色/深度目标 `M1`。
2. `scene-source`：表面相对尺寸的单重采样颜色目标 `C`。
3. 现有场景渲染任务将颜色从 `M1` 解析到 `C`。
4. `scene-depth`：表面相对尺寸的单重采样深度目标 `D`。
5. 现有的深度解析任务将 `M1` 深度的第 0 个采样复制到 `D`。
6. `scene-output-msaa`：表面相对尺寸的 MSAA 颜色目标 `M2`。
7. 原生 SSAO 读取 `C` 和 `D`，合成到 `M2`，并将 `M2` 解析到 `scRT`。

默认渲染任务保留对 `M1` 的所有权。控制器拥有 `C`、`D` 和 `M2`。分离时，控制器将 `M1` 归还给其所有者，从不释放它。在场景销毁期间，在帧图释放被重定向的任务之后，场景生命周期清理会释放被替换下来的任务自持有的 `M1`；诸如 `scRT` 之类的 eager 共享目标仍由外部持有。

当启用原生 PBR 透射时，透射会通过可选的 `_outputPipelineChange` 接缝将其场景输出变更包裹起来。SSAO 会在透射重定向之前恢复渲染任务，随后围绕生成的线性 HDR 目标重建其任务链。其合成通道写入一个通过 `scene._outputTexture` 暴露的单重采样 HDR 输出；尾随的透射图像处理任务解析该 getter，并继续作为最终的交换链写入者。在已注册的场景上，更改或恢复 `_outputTexture` 会立即重新录制该尾随任务，确保其绑定组绝不会滞留先前的目标。这同时支持在 1x 和 4x MSAA 下的任意附着顺序，包括运行期动态附着与分离。

任务按生产者顺序紧跟在默认任务之后插入。当场景已注册时，每个插入的任务都会通过 `buildFrameGraphTask` 单独构建；现有任务不会被重建。表面相对尺寸的描述符在尺寸调整期间保持目标对象身份不变，同时其底层 GPU 分配由现有的渲染目标逻辑重建。

## 管线配置

`PostProcessTask.resolveTexture` 仅当 `outputTexture` 为多重采样且 `resolveTexture` 为单重采样时才有效。它不能与主采样输入或额外采样输入别名冲突；该校验会在重建解析目标之前执行。格式和物理尺寸必须匹配。渲染通道将 `outputTexture._colorView` 绑定为 `view`，并将当前的 `resolveTexture._colorView` 绑定为 `resolveTarget`。每次执行都会重新读取交换链视图。

### 显式叠加层输出（破坏性变更）

原生控制器接受调用方自持有的可选 `targetTexture` 和 `resolveTexture` 目标。指定解析目标时必须同时提供目标纹理；该目标纹理不能与多重采样的场景生产者相同，因为重建别名冲突的目标会导致其深度/解析消费者失效。传入的目标由合成通道构建，但绝不会被管线分离释放。默认配置保留独立的 SSAO 呈现路径。

若要添加 gizmo，请分配最终的 MSAA 颜色目标，将其作为 `targetTexture` 传入，并将同一个目标作为 `rt` 传给 `createUtilityLayer` 或 `createOverlayScene`。将屏幕作为对应的解析目标传入。后续的合成通道必须延续该显式颜色链。不使用任何任务输出访问器或活动解析器搜索。如果链路更改了目标或采样数，请显式重建/重新连线其叠加层消费者。

**显式 SSAO 目标不能与自动场景透射组合使用。** 在该模式下，产生最终显示颜色的是尾随的图像处理任务，而非 AO 合成通道。将显式 AO 目标复用为最终显示颜色可能导致交换链反馈环，或让叠加层用线性颜色覆盖后处理后的颜色。将显式输出的 SSAO 附着到启用了自动透射的场景会在修改帧图之前抛出异常。在显式输出的 SSAO 之后启用自动透射同样会在淘汰其资源之前抛出异常；透射事务会恢复材质标志。请改用显式连线的线性/图像处理链。不使用显式目标的现有独立 SSAO/透射集成保持不变。

Compat 的 `UtilityLayerRenderer(scene, targets)` 和 `GizmoManager(scene, targets)` 同样需要显式的原生 `{ rt, rst? }` 目标（破坏性变更）。它们绝不会从场景或管线中推断目标。Compat SSAO 构造函数接受相同的目标作为其可选的第七个参数，这是 Lite 特有的扩展。目标引用不会被序列化；调用方在重建管线时必须再次提供它们。不支持在 SSAO 附着/分离时自动重定向工具层；当输出链变化时请重建工具层。对 Babylon.js 的兼容性遵循尽力而为原则，不会为此引入任务扫描或交换链拷贝。

```ts
const rt = engine.msaaSamples > 1 ? createRenderTarget({ format: engine.format, samples: engine.msaaSamples, size: engine }) : engine.scRT;
const targets = { rt, rst: engine.msaaSamples > 1 ? engine.scRT : undefined };
const ao = createSceneSsaoPipeline({ targetTexture: rt, resolveTexture: targets.rst }, engine, scene, camera);
attachSceneSsaoPipeline(ao);
const utility = createUtilityLayer(scene, targets);
// Add gizmos, register the scene and utility layer normally.
// Detaching AO requires rewiring/recreating the utility layer against its new producer.
```

## 着色器逻辑

现有的 SSAO 估计器、降噪器和时域重建保持不变。仅乘法合成增加了一个 `base` 项：

```wgsl
amount = clamp(occlusion * intensity - base, 0.0, 1.0);
output = vec4(color.rgb * (1.0 - amount), color.a);
```

`base = 0` 完全保留现有输出。`base` 每帧由合成 uniform 采样，不会使时域历史失效。

## 状态机 / 生命周期

- **已分离（Detached）：** 默认任务保留其原始颜色/解析目标；不存在自持有的任务或目标。
- **已附着 + 相机激活：** 执行被重定向的默认渲染任务、可选深度解析任务以及启用的 SSAO 合成任务。
- **已附着 + 相机未激活：** 渲染任务和 SSAO 恒等合成仍会执行以保留其他相机的颜色输出，同时未使用的深度解析任务被禁用。
- **分离（Detach）：** 移除自持有任务，按消费者逆序释放它们，释放控制器自持有目标，恢复默认任务的目标，并清除引用。
- **重新附着（Reattach）：** 分配全新的任务链和时域历史。
- **失败：** 回滚执行与分离相同的清理步骤，并在重新抛出异常前恢复捕获的默认目标。
- **释放（Dispose）：** 执行分离、标记为已释放，并使后续的附着调用失败。

同一时间一个场景只能附着一个原生场景 SSAO 控制器。第二次附着会在修改帧图状态之前抛出异常。

## Babylon.js 等价映射

| Babylon.js 接口 | 原生映射 |
| --------------- | -------- |
| `SSAO2RenderingPipeline.radius` | `SceneSsaoPipeline.radius` |
| `totalStrength` | `intensity` |
| `base` | 合成项 `base` |
| `maxZ` | `fadeEnd`；衰减从该值的 75% 处开始 |
| `ratio.ssaoRatio` | `resolutionScale` |
| 管理器 attach/detach | `attach` / `detach` |
| `dispose()` | 原生控制器释放及管理器移除 |

没有原生语义的估计器专用 Babylon.js 控件（`samples`、`epsilon`、`minZAspect`、`expensiveBlur` 以及独立的模糊比例）由兼容包装器保留用于回读，并在被赋予非默认值时仅警告一次。它们不会改变原生渲染。

## 依赖关系

- 依赖现有的渲染任务、深度解析任务、渲染目标、帧图插入/移除以及原生屏幕空间环境光遮蔽。
- 除兼容包装器外，没有任何模块导入此特性。对于所有非兼容层消费方，根桶文件（barrel）的重新导出会被 Tree-shaking 移除。
- 当后续单重采样自定义合成通道在活动 MSAA 解析器之后写入 `scRT` 时，该通用场景仍位于本模块范围之外：在之后再解析叠加层的 MSAA 附件会覆盖该后续写入者的结果。调用方必须将叠加层连线到最终目标；不存在隐式兼容回退。

## 测试规范

- 后处理解析校验：分配前的采样输入别名拒绝、采样数、格式、尺寸以及实时交换链解析视图。
- SSAO 合成：`base` 出现在 uniform 契约中；调用方自持有的显式颜色/解析目标在分离后得以保留。
- 叠加层选择：最后一个活动 MSAA 解析器胜出；已禁用/禁用执行/单重采样任务被忽略。
- 场景管线：无 MSAA 和 MSAA 任务拓扑、生产者顺序、默认目标捕获/恢复、相机门控变更、两种附着顺序下的透射合成、已注册场景的增量构建、回滚、分离/重新附着新资源以及幂等释放。
- 兼容层：稳定的惰性管理器身份、事务性构造函数注册、add/attach/detach/dispose 转发、Babylon.js 默认值与属性映射、不支持设置的单次警告，以及无头环境下的惰性构造。

## 文件清单

- `packages/babylon-lite/src/post-process/scene-ssao.ts` — 原生纯状态及独立生命周期函数。
- `packages/babylon-lite/src/post-process/screen-space-ambient-occlusion.ts` — `base` 与解析转发。
- `packages/babylon-lite/src/frame-graph/post-process-task.ts` — 通用 MSAA 输出解析支持及输出描述符。
- `packages/babylon-lite/src/frame-graph/task.ts` — 内部任务输出描述符类型。
- `packages/babylon-lite/src/scene/overlay-scene.ts` — 显式借用的颜色/解析目标及独立深度。
- `packages/babylon-lite-compat/src/post-processes/post-process-render-pipeline-manager.ts` — Babylon 风格的注册表与相机转发。
- `packages/babylon-lite-compat/src/post-processes/ssao2-rendering-pipeline.ts` — Babylon 风格的 SSAO2 适配器。
