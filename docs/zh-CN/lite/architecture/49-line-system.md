# 模块：线系统（Line System）

> 包路径：`packages/babylon-lite/src/mesh/create-line-system.ts`、`packages/babylon-lite/src/mesh/create-dashed-lines.ts`、`packages/babylon-lite/src/material/line/`

## 用途

提供 Babylon.js 中 `CreateLines`、`CreateLineSystem` 和 `CreateDashedLines` 的公共、可 tree-shaking 等价实现。
线系统将多条独立的折线拼接为一个带索引的 `Mesh`，将这些索引作为 WebGPU `line-list` 渲染，并可选择为每个点携带一个 RGBA 颜色。

其结果是一个普通的 Babylon Lite `Mesh`，而非 OOP 的 `LinesMesh`。几何体、材质、场景所有权与行为保持分离：

- 网格存储纯几何体与变换状态；
- `LineMaterial` 是一个纯 `ShaderMaterial` 状态对象；
- 独立函数用于创建和更新两者；
- 只有在调用 `addToScene(scene, mesh)` 之后，场景才拥有该网格。

## 公共 API 接口

```ts
export interface LineSystemData {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint32Array;
    readonly colors?: Float32Array;
    readonly linePointCounts: Uint32Array;
}

export interface LineSystemDataOptions {
    readonly lines: readonly (readonly Vec3[])[];
    readonly colors?: readonly (readonly Color4[])[];
}

export interface LineMaterialOptions {
    readonly name?: string;
    readonly color?: Color4;
    readonly useVertexColor?: boolean;
    readonly useVertexAlpha?: boolean;
    readonly useThinInstances?: boolean;
    readonly useThinInstanceColors?: boolean;
    readonly depthWrite?: boolean;
    readonly depthCompare?: GPUCompareFunction;
}

export interface LineMaterial extends ShaderMaterial {
    readonly useVertexColor: boolean;
    readonly useVertexAlpha: boolean;
    readonly useThinInstances: boolean;
    readonly useThinInstanceColors: boolean;
    readonly color: Color4;
}

export interface LineSystemOptions extends LineSystemDataOptions {
    readonly name?: string;
    readonly color?: Color4;
    readonly useVertexAlpha?: boolean;
    readonly useThinInstances?: boolean;
    readonly useThinInstanceColors?: boolean;
    readonly material?: LineMaterial;
}

export interface LinesOptions {
    readonly name?: string;
    readonly points: readonly Vec3[];
    readonly colors?: readonly Color4[];
    readonly color?: Color4;
    readonly useVertexAlpha?: boolean;
    readonly useThinInstances?: boolean;
    readonly useThinInstanceColors?: boolean;
    readonly material?: LineMaterial;
}

export interface LineSystemUpdateOptions extends LineSystemDataOptions {}

export interface DashedLinesOptions {
    readonly name?: string;
    readonly points: readonly Vec3[];
    readonly dashSize?: number;
    readonly gapSize?: number;
    readonly dashNb?: number;
    readonly color?: Color4;
    readonly useVertexAlpha?: boolean;
    readonly material?: LineMaterial;
}

export interface DashedLinesUpdateOptions {
    readonly points: readonly Vec3[];
}

export function createLineSystemData(options: LineSystemDataOptions): LineSystemData;
export function createLineMaterial(options?: LineMaterialOptions): LineMaterial;
export function setLineMaterialColor(material: LineMaterial, color: Color4): void;
export function createLineSystem(engine: EngineContext, options: LineSystemOptions): Mesh;
export function createLines(engine: EngineContext, options: LinesOptions): Mesh;
export function updateLineSystem(engine: EngineContext, mesh: Mesh, options: LineSystemUpdateOptions): void;
export function createDashedLines(engine: EngineContext, options: DashedLinesOptions): Mesh;
export function updateDashedLines(engine: EngineContext, mesh: Mesh, options: DashedLinesUpdateOptions): void;
```

默认值：

- `name`：`"lineSystem"`（`createLines` 为 `"lines"`）
- 虚线 `name`：`"dashedLines"`
- `dashSize`：`3`
- `gapSize`：`1`
- `dashNb`：`200`
- `color`：不透明白色
- `useVertexColor`：由 `createLineSystem` 根据 `colors` 推断
- `useVertexAlpha`：`true`，与 Babylon.js `LinesMesh` 一致
- `useThinInstances`：`false`
- `useThinInstanceColors`：`false`
- 深度比较：普通的反向深度（reverse-depth）ShaderMaterial 默认值
- 深度写入：ShaderMaterial 默认值（Alpha 混合线为 `false`，否则为 `true`）

当调用方提供 `material` 时，其 `useVertexColor` 设置必须与几何体是否具有颜色缓冲区相匹配。`useThinInstances` 和 `useThinInstanceColors` 是材质编译期选择：材质必须在 `registerScene` 之前针对网格预期的绘制路径创建。

## 内部架构

### 几何体布局

所有点按线的顺序拼接。

对于具有 `N` 个点的线 `l`：

- 追加全部 `N` 个 XYZ 位置；
- 当存在 `colors` 时，追加全部 `N` 个 RGBA 颜色；
- 为 `i = 1..N-1` 追加索引对 `(base + i - 1, base + i)`；
- 绝不将一条线的最后一个点连接到下一条线的第一个点。

数量计算：

- 顶点数：`sum(line.length)`
- 索引数：`sum(max(0, line.length - 1) * 2)`
- 法线：每个顶点一个零值 XYZ 元组，因为共享网格上传器要求法线缓冲区，而线着色器从不绑定或读取它。

`linePointCounts` 存储每条折线的点数。网格在内部将其作为 `Mesh._linePointCounts` 保留；更新操作会比较每一项，从而防止调用方在保持总顶点数不变的情况下静默更改线段连通性。

`Mesh._topology = 2` 记录了与 glTF 图元特性相同的内部拓扑索引（`2 = line-list`）。这使得程序化线图元与加载的线图元尽管材质使用不同渲染路径，却能共享同一套网格状态表示。

### 虚线生成与更新

`createDashedLines` 测量完整输入折线的长度，将该长度划分为 `dashNb` 步，并在每个源线段上为每一个完整步长发射一条独立的双点线段。每步的可见部分比例为 `dashSize / (dashSize + gapSize)`。源线段边界会重新启动步长相位，与 Babylon.js 一致。

网格在 `Mesh._dashedLineOptions` 中保留其创建时的虚线/间隙比例；其实际发射的虚线段数量已由 `Mesh._linePointCounts` 保留。`updateDashedLines` 会根据新的总长度和既有虚线段数量重新计算间距，将写入上限控制在固定容量内，并用位于终点处的退化线段填充未使用的尾部。因此，网格标识、顶点/索引计数和 GPU 缓冲区均保持稳定。

### 校验

创建时若满足以下任一条件，将在 GPU 分配前抛出异常：

- 整个系统不包含任何点；
- 任何位置分量为非有限数；
- `colors.length !== lines.length`；
- 某一行颜色长度与其对应的线不同；
- 任何颜色分量为非有限数。

更新时若满足以下任一条件，将在任何 GPU 写入前抛出异常：

- 线数量或任意单条线的点数发生改变；
- 位置数量发生改变；
- 网格并非由 `createLineSystem` 创建；
- 为没有颜色缓冲区的网格传入了颜色；
- 颜色维度无效。

虚线创建还额外要求至少两个点和至少一条生成的虚线。虚线更新要求网格由 `createDashedLines` 创建；退化的替换点是有效的，会将所有保留的虚线段折叠到终点处。

更新时省略 `colors` 会保留现有的颜色缓冲区。创建时没有颜色的网格在不创建/调整新线系统的情况下无法新增颜色。

### 材质状态

`LineMaterial` 由 `createShaderMaterial` 生成，并保留其常规的渲染组、UBO、thin-instance、模板测试（stencil）、排序、销毁和设备丢失行为。

ShaderMaterial 拥有一个内部的 `_topology = "line-list"` 字段。着色器管线将该拓扑纳入本地和跨材质管线缓存键中，并输出：

```ts
primitive: {
    topology: material._topology ?? "triangle-list",
    cullMode: "none",
    frontFace: "ccw",
}
```

不引入特定于线的注册表或模块级分配。

`setLineMaterialColor` 将 RGBA 值拷贝到 `material.color` 中，并更新 `lineColor` ShaderMaterial uniform。仅当既没有顶点颜色也没有 thin-instance 颜色替代它时，该 uniform 才存在。

### Thin Instances

普通线材质使用 `shaderSystem.world`。

使用 `useThinInstances: true` 创建的材质会读取由现有 ShaderMaterial thin-instance 路径动态注入的矩阵属性：

```wgsl
let instanceWorld = mat4x4<f32>(input.world0, input.world1, input.world2, input.world3);
let finalWorld = shaderSystem.world * instanceWorld;
```

`useThinInstanceColors: true` 会额外读取 `input.instanceColor`。它要求 `useThinInstances: true` 以及一个 thin-instance 颜色缓冲区。

颜色优先级匹配 Babylon.js 的颜色着色器：

- 仅顶点颜色：输出顶点颜色；
- 仅实例颜色：输出实例颜色；
- 两者皆有：将顶点和实例 RGBA 相乘；
- 两者皆无：输出 uniform 线颜色。

`useVertexAlpha` 控制 Alpha 混合，而不控制着色器是否转发 Alpha。当为 false 时，会写入相同的 RGBA 值但不启用混合状态，与 Babylon.js 一致。

## 管线配置

顶点属性：

| 特性                 | 属性                                      |
| -------------------- | ----------------------------------------- |
| Uniform 颜色         | `position: float32x3`                     |
| 顶点颜色             | `position: float32x3`, `color: float32x4` |
| Thin instances       | 额外四个 `float32x4` 矩阵行               |
| Thin-instance 颜色   | 额外一个 `float32x4` 颜色                 |

图元状态：

```ts
{
    topology: "line-list",
    cullMode: "none",
    frontFace: "ccw",
}
```

当 `useVertexAlpha` 为 true 时的混合状态：

```ts
{
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
}
```

现有的 ShaderMaterial 深度、模板、MSAA、渲染排序和渲染目标签名规则仍具权威性。

## 着色器逻辑

Uniform 颜色顶点着色器：

```wgsl
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.viewProjection
        * shaderSystem.world
        * vec4<f32>(input.position, 1.0);
    return out;
}
```

顶点/实例颜色变体会添加一个 `vColor: vec4<f32>` varying，并按上文定义的颜色优先级赋值。片元阶段原样返回 `vColor` 或 `lineColor` uniform。线条无光照，也不采样纹理。

## 状态机 / 生命周期

1. `createLineSystemData` 校验并展平 CPU 数据。
2. `createLineSystem` 通过 `createMeshFromData` 上传数据。
3. 网格记录 `_topology`、`_linePointCounts`、保留的 CPU 几何体，以及由调用方提供或生成的 `LineMaterial`。
4. 调用方可配置变换、渲染顺序、模板和 thin instances。
5. `addToScene` 将所有权转移给场景。
6. `registerScene` 构建常规的 ShaderMaterial 可渲染对象。
7. `updateLineSystem` 校验拓扑、原地更新位置/颜色缓冲区、刷新保留的 CPU 数组、重新计算包围盒，并刷新设备丢失恢复数据。
8. `createDashedLines` 构建常规的双点线系统行并保留其创建时的虚线/间隙比例；`updateDashedLines` 精确重新生成现有的行数。
9. 常规的场景/网格销毁会释放所有 GPU 资源。

## Babylon.js 等价映射

| Babylon.js                                            | Babylon Lite                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `CreateLineSystemVertexData`                          | `createLineSystemData`                                         |
| `MeshBuilder.CreateLineSystem` / `CreateLineSystem`   | `createLineSystem`                                             |
| `MeshBuilder.CreateLines` / `CreateLines`             | `createLines`                                                  |
| `MeshBuilder.CreateDashedLines` / `CreateDashedLines` | `createDashedLines`                                            |
| `LinesMesh` 几何体                                    | 带有 `_topology = 2` 的普通 `Mesh`                             |
| `LinesMesh` 默认颜色着色器                            | `LineMaterial`                                                 |
| `LinesMesh.color` + `.alpha`                          | `setLineMaterialColor`                                         |
| `options.instance` 更新                               | `updateLineSystem(engine, mesh, options)`                      |
| 虚线 `options.instance` 更新                          | `updateDashedLines(engine, mesh, options)`                     |
| `useVertexAlpha`                                      | `LineMaterial.useVertexAlpha`                                  |
| 线 thin instances                                     | 使用 thin-instance 线材质配合现有的 `setThinInstances`         |

初始限制：

- 仅支持单像素硬件线条；
- 不支持线段距离拾取 / `intersectionThreshold`；
- 更新不能更改线数量、点数或颜色缓冲区的存在性；
- 线系统不启用特定于三角形的阴影、几何体和精细拾取通道。

## 依赖项

- `EngineContext`
- `Mesh`、`createMeshFromData`、`updateMeshPositions`、`updateMeshColors`
- `computeAabb`
- `Vec3`、`Color4`
- `ShaderMaterial`、`createShaderMaterial`、`setShaderUniform`
- 现有的 ShaderMaterial thin-instance 和模板可选启用功能

## 测试规范

单元测试：

- 展平多条线而不产生跨线索引；
- 按顶点顺序保留 RGBA 值；
- 保持空/单点折线互不相连，并拒绝全空系统、不匹配的颜色和非有限输入；
- 使用正确的颜色/Alpha/thin-instance 变体创建 line-list 材质；
- 在不替换 GPU 缓冲区的情况下更新位置/颜色；
- 在 GPU 变更前拒绝发生改变的线拓扑；
- 当更新省略颜色时保留现有颜色；
- 使用默认和显式虚线/间隙/数量值生成符合 BJS 间距的虚线段；
- 在不改变保留的虚线拓扑的情况下更新虚线位置；
- 将未使用的虚线更新槽位折叠到终点；
- 验证 ShaderMaterial 管线缓存在三角形拓扑和线拓扑之间的隔离。

视觉一致性场景：

- 使用 uniform 颜色和逐顶点颜色的静态多折线系统，包含半透明线段；
- 通过带有逐实例 RGBA 颜色的 thin instances 渲染的更新后线系统；
- Babylon.js 参考页面使用 `MeshBuilder.CreateLineSystem`；
- Lite 页面使用 `createLineSystem`、`updateLineSystem` 和现有的 thin-instance API。

Bundle 检查：

- 未导入线模块的场景不保留任何线生成器或线着色器代码；
- 每个线场景保持在其显式 `maxRawKB` 上限之下；
- 提交重新生成的逐场景运行时清单。

## 文件清单

- `packages/babylon-lite/src/mesh/create-line-system.ts`：几何体创建与更新。
- `packages/babylon-lite/src/mesh/create-dashed-lines.ts`：虚线几何体创建与固定拓扑更新。
- `packages/babylon-lite/src/material/line/line-material.ts`：线着色器/材质。
- `packages/babylon-lite/src/material/shader/shader-material.ts`：内部拓扑状态。
- `packages/babylon-lite/src/material/shader/shader-pipeline.ts`：拓扑感知管线创建。
- `packages/babylon-lite/src/material/shader/shader-pipeline-cache.ts`：拓扑缓存键。
- `packages/babylon-lite/src/mesh/mesh.ts`：内部拓扑与线点数状态。
- `packages/babylon-lite/src/index.ts`：公共导出。
- `packages/babylon-lite-compat/src/meshes/meshes.ts`：`LinesMesh`、`CreateLines`、`CreateLineSystem` 和 `CreateDashedLines` 包装器。
- `packages/babylon-lite-compat/COMPAT-STATUS.md`：兼容性状态。
- `lab/lite/src/bjs/scene278.ts`、`lab/lite/src/lite/scene278.ts`：静态一致性场景。
- `lab/lite/src/bjs/scene279.ts`、`lab/lite/src/lite/scene279.ts`：更新 + thin-instance 一致性场景。
- `tests/lite/unit/create-line-system.test.ts`：单元测试覆盖。
- `tests/lite/unit/create-dashed-lines.test.ts`：虚线创建与更新覆盖。
- `tests/lite/parity/scenes/scene278-line-system.spec.ts`：静态视觉一致性。
- `tests/lite/parity/scenes/scene279-line-system-update-instances.spec.ts`：动态/实例视觉一致性。
