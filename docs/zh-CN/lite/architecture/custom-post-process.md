# 模块：自定义后处理

> 包路径：`packages/babylon-lite/src/post-process/custom.ts`

## 目的与公共 API

一个构建在[后处理任务](29-post-process.md)之上的公共、按需启用的适配器，用于应用自定义的全屏颜色通道。直接从 `@babylonjs/lite` 导入即可，无需包子路径或底层 GPU 附件访问权限。

```ts
export interface CustomPostProcessTaskConfig extends PostProcessTaskSettings {
    fragmentWGSL: WgslSource;
    uniformWGSL?: WgslSource;
    uniformByteLength?: number;
    writeUniforms?: (data: Float32Array) => void;
    extraTextureWGSL?: WgslSource;
    extraTextures?: readonly RenderTarget[];
}
export function createCustomPostProcessTask(config: CustomPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): PostProcessTask;
```

`WgslSource` 为公共 `wgsl` 标签返回的源码类型。`PostProcessTaskSettings` 提供 `name`、`sourceTexture`、`targetTexture`、`sourceSamplingMode`、`alphaMode`、`viewport` 和 `clear`，默认值与内置后处理一致。返回的任务即为现有的 `PostProcessTask`，包含 `outputTexture` 和 `updateUniforms()`。

## 着色器与绑定契约

- 在 `fragmentWGSL` 中提供 `fn applyPostProcess(color: vec4f, uv: vec2f) -> vec4f`；辅助层会提供顶点阶段和片段入口点。
- `color` 为主源采样值。UV 已归一化，V 沿源图像向下递增；无需额外的渲染目标翻转。
- Group 0 / binding 0 为 `sourceSampler`，binding 1 为 `sourceTextureSampler`。`samplePostProcessSource(uv)` 和 `readPostProcessSource(uv)` 可用，语义遵循共享规范。
- `extraTextures[i]` 使用绑定槽 `2+i`；在 `extraTextureWGSL` 中声明对应的 `texture_2d<f32>`。所有颜色输入都必须是可过滤的、单重采样的 2D 目标且具有纹理绑定用途。多重采样或深度输入需另行解析。
- 当 `uniformByteLength > 0` 时，uniform 绑定槽为 `2 + extraTextures.length`（无额外纹理时为 2）。在 `uniformWGSL` 中声明匹配的 uniform 块。
- Uniform 分配会向上对齐到 16 字节。`writeUniforms` 在录制期间以及调用 `task.updateUniforms()` 时会收到已清零、可复用的浮点存储；修改捕获的状态后调用该方法即可上传新值。WGSL 结构体布局与载荷大小由调用方负责。
- 着色器源码、uniform 布局和额外输入数量在任务生命周期内固定不变。不引入着色器解析、新的 GPU 缓存或导入期注册。

## 生命周期与所有权

1. 创建源生产者及本任务；通过 `addTask` 将所有源/额外输入生产者调度在自定义任务之前。
2. 帧图构建时会先录制生产者，然后共享辅助层绑定它们当前的颜色采样视图（如果存在完整 mip 链则包含之）。未分配或多重采样的主源会通过辅助层现有的诊断机制报错。
3. 传入的 `targetTexture` 为借用关系。未提供时，辅助层会创建一个具有与源相同格式和尺寸描述符的单重采样输出。
4. 在尺寸调整、源/目标变更或附件替换后重建帧图，使绑定使用当前的生产者视图。已注册场景或独立帧图的尺寸调整处理会执行常规重建。
5. 执行阶段复用现有的全屏三角形、采样器过滤、视口/裁剪矩形、混合及清除路径；每帧不产生额外分配或绑定。
6. 释放任务前先停止执行它。释放会销毁其 uniform 缓冲区和内部创建的输出，同时保留所有源/额外目标及调用方传入的输出。调用方拥有这些资源及其生产者的生命周期。禁止在同一个通道中采样正在被写入的附件（禁止反馈环）。

## 示例：合并两张图像

```ts
const merge = createCustomPostProcessTask(
    {
        sourceTexture: blurA.outputTexture,
        extraTextures: [blurB.outputTexture],
        targetTexture: surface.scRT,
        alphaMode: 1,
        clear: false,
        extraTextureWGSL: wgsl`@group(0) @binding(2) var second: texture_2d<f32>;`,
        uniformWGSL: wgsl`@group(0) @binding(3) var<uniform> intensity: vec4f;`,
        uniformByteLength: 16,
        writeUniforms: (data) => {
            data[0] = settings.intensity;
        },
        fragmentWGSL: wgsl`fn applyPostProcess(c:vec4f,uv:vec2f)->vec4f {
        let rgb = (c.rgb + textureSample(second,sourceSampler,uv).rgb) * intensity.x;
        return vec4f(rgb,1);
    }`,
    },
    engine,
    scene
);
addTask(scene, merge); // after both blur producers
```

## 等价关系、依赖与测试

这是 #826/#751 中所请求的原生全屏自定义接缝，而非 `GlowLayer` 或 `SSAO2RenderingPipeline` 包装器。它委托给 `frame-graph/post-process-task.ts`；着色器数学、管线构建、Y 轴朝向以及渲染目标生命周期均保持不变。

测试覆盖生产者优先分配与尺寸调整重绑定、额外输入与 uniform 槽位、显式 uniform 更新、借用输出与自有输出的释放，以及保持零分配的执行路径。严格模式消费方可针对生成的根类型声明编译；Tree-shaking 检查确保未使用的自定义代码不会进入无关打包产物。聚焦场景打包控制保持现有体积上限。

文件清单：`post-process/custom.ts`、根入口 `index.ts`、聚焦单元/构建测试、本规范文档以及共享后处理规范文档。
