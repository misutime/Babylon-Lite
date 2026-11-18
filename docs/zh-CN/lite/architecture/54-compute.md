# 模块：计算（Compute）

> 包路径：`packages/babylon-lite/src/compute/`、`packages/babylon-lite/src/frame-graph/compute-pass.ts`

## 用途

在不暴露原始 GPU 句柄且不在帧图之外创建第二套调度器的前提下，暴露用户编写的 WebGPU 计算能力。

公共模型分离了以下概念：

- `ComputeShader`：不可变程序、绑定布局、管线变体、异步预准备以及与设备关联的缓存。
- `ComputeBindingSet`：用于单个程序的不可变可复用资源集合。
- `ComputeDispatch`：单次直接或间接派发调用及其动态偏移。
- `ComputeTask`：有序的可复用派发列表及其任务自有的逐派发 uniform 内存区（arena）。
- `ComputePass`：一个帧图 Pass，用于将任务的派发列表录制到引擎当前帧的命令编码器中。

一个 `ComputeTask` 对应一个调度边界以及一个 WebGPU 计算 Pass。仅当相对于渲染、拷贝或其他计算工作的排序需要独立 Pass 时，应用才需要创建多个任务。

### GPU 生成网格契约

`createMeshFromStorageBuffer()` 返回的是一个普通 `Mesh`，而非仅限 ShaderMaterial 的特例。因此，Standard、PBR、Node、Shader 以及几何渲染器 Pass 都必须消费相同的网格自有顶点布局和绘制原点元数据：

- `MeshGPU._vbLayout` 是位置、法线、切线、UV、UV2 和颜色各个流权威的 `arrayStride` 与属性偏移。管线布局编码这些值；每个对应的 slab `GPUBuffer` 均以字节偏移 0 绑定。
- `MeshGPU._baseVertex` 是该槽位权威的顶点原点。直接索引绘制将其作为 WebGPU `drawIndexed` 的第四个参数传入。稳定的薄实例间接参数、GPU 剔除参数以及近/远两个 LOD 桶都将相同的值写入间接字（indirect word）3。
- 存储网格还会发布 `MeshGPU._vertexCount`：其槽位中经过校验的顶点数，独立于共享缓冲区的字节容量。缺失的 Shader/Node 属性使用一个共享的 16 字节零流（顶点步长为 0），而非按 slab 大小分配。零步长即使在非零索引 `baseVertex` 下也能保留常量默认值。着色器管线/绑定组键会区分缺失的属性，包括蒙皮流和薄实例。
- 存储网格工厂在计算所需字节范围前，会将 `baseVertex` 校验为非负有符号 32 位整数。`indexCount` 必须是位于所提供类型化数组长度或共享存储容量范围内的正无符号 32 位整数。类型化索引决定格式；显式指定的格式必须匹配，且已使用前缀中的每个索引必须小于 `vertexCount`。共享的 GPU 生成索引内容仍由生产者负责。
- 必需的 UV 流发布 `hasUv: true`。`hasUv2`、`hasTangent` 和 `hasColor` 描述可选流，使材质特性检测不会从陈旧句柄推断存在性。
- Standard、PBR 与 Node 布局重写以及直接/间接索引绘制参数填充共享 `mesh/mesh-vertex-layout.ts`。ShaderMaterial 将等价逻辑保留在其现有的可选 `shader-vb.ts` 钩子中，从而使仅使用该材质族的场景不会拉取其他材质族的布局适配器。

存储网格以及可写/顶点/索引/间接存储分配不保留任何重建状态。设备丢失后，应用必须重新创建这些分配、重新填充 GPU 生成的数据、重新创建依赖的网格和计算图，之后才能恢复渲染。纯只读的 CPU 后备存储保留其现有的隔离恢复路径。

薄实例 GPU 剔除在可用时使用 CPU 位置，否则围绕有限且有序的对象局部 `boundMin`/`boundMax` 构建保守包围球。解析包围盒按值缓存，因此原地编辑会使包围球失效，而未变更的帧不会重新分配或重新计算。仅当网格既没有可用位置也没有可用包围盒时，才走全量绘制/禁用 LOD 的回退路径。

## 公共 API 接口

### 绑定声明

```ts
export interface ComputeBindingDecl {
    readonly name: string;
    readonly group: number;
    readonly binding: number;
}

export interface ComputeStorageBufferBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly access?: "read" | "read-write";
    readonly dynamicOffset?: boolean;
    readonly minBindingSize?: number;
}

export interface ComputeUniformBufferBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly dynamicOffset?: boolean;
    readonly minBindingSize?: number;
}

export function computeStorageBufferBinding(name: string, options: ComputeStorageBufferBindingOptions): ComputeBindingDecl;
export function computeUniformBufferBinding(name: string, options: ComputeUniformBufferBindingOptions): ComputeBindingDecl;

export interface ComputeTextureBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly sampleType?: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
    readonly multisampled?: boolean;
}

export interface ComputeSamplerBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly type?: "filtering" | "non-filtering" | "comparison";
}

export interface ComputeStorageTextureBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly format: GPUTextureFormat;
}

export function computeTextureBinding(name: string, options: ComputeTextureBindingOptions): ComputeBindingDecl;
export function computeSamplerBinding(name: string, options: ComputeSamplerBindingOptions): ComputeBindingDecl;
export function computeStorageTextureBinding(name: string, options: ComputeStorageTextureBindingOptions): ComputeBindingDecl;
```

调用方提供完整的 WGSL，包括 `@group` / `@binding` 声明。资源专属的辅助函数返回冻结的纯声明数据、通过可 tree-shake 的可选接缝安装其解析器，并为资源赋值提供稳定名称。Babylon Lite 从不解析或重写 WGSL。

导入并调用辅助函数即视为启用该特性，不存在独立的 `enableComputeStorageBuffers()` 调用。

声明不变量由 `createComputeShader` 校验一次：

- 名称是唯一的 WGSL 标识符；
- group 和 binding 索引是非负整数；
- 每个 `(group, binding)` 对唯一；
- group 从 0 到最高声明 group 之间保持稠密；缺失的 group 会收到一个空的内部布局；
- `minBindingSize` 是 4 的非负倍数；
- 动态偏移仅对缓冲区绑定合法。

### 着色器

```ts
export interface ComputeShaderOptions {
    readonly name?: string;
    readonly computeSource: string;
    readonly entryPoint?: string;
    readonly bindings?: readonly ComputeBindingDecl[];
}

export interface ComputeShader {
    readonly name: string;
}

export function createComputeShader(engine: EngineContext, options: ComputeShaderOptions): ComputeShader;
export function prepareComputeShader(shader: ComputeShader): Promise<void>;
export function disposeComputeShader(shader: ComputeShader): void;
```

`ComputeShader` 不拥有任何已绑定资源或派发参数。它可以被同一引擎下的任意数量的绑定集、派发和任务共享。

`prepareComputeShader` 预准备默认管线。覆写常量（override constants）位于独立的 `compute-pipeline-variant` 模块中，且仅被创建了变体的场景保留。

### Uniform 缓冲区

```ts
export interface UniformBuffer {
    readonly byteLength: number;
}

export interface UniformBufferOptions {
    readonly label?: string;
}

export function createUniformBuffer(engine: EngineContext, source: ArrayBufferView | number, options?: UniformBufferOptions): UniformBuffer;
export function updateUniformBuffer(engine: EngineContext, buffer: UniformBuffer, data: ArrayBufferView, byteOffset?: number): void;
export function disposeUniformBuffer(buffer: UniformBuffer): void;
```

`UniformBuffer` 是围绕 `UNIFORM | COPY_DST` 分配的不透明稳定标识包装器。它为部分更新和 uniform 内存区保留 CPU 暂存字节。更新要求 4 字节对齐的偏移与长度，且不得超出 `byteLength`。

构造需要非负安全整数的字节计数。在创建任何 CPU 影子副本或 GPU 分配之前，最小 16 字节且按 16 字节对齐的容量必须保持为安全整数并符合 `maxBufferSize`。Uniform 内存区在调用此构造函数前会校验正安全整数的槽位大小/数量及其对齐步长乘积。内存区可以超过 `maxUniformBufferBindingSize`：该限制适用于单个绑定范围，而非整个分配。

原始字节范围更新仍是基础资源 API。基于 uniform 内存区构建的任务自有类型化 uniform 写入器是一个可选计算模块；它们不会向 `UniformBuffer` 附加方法，也不会将所有权转移到 `ComputeShader`。

### 立即数数据（Immediate data）

```ts
export interface ComputeImmediateShaderOptions extends ComputeShaderOptions {
    readonly immediateByteLength: number;
}

export type ComputeImmediateData = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

export function isComputeImmediatesSupported(): boolean;
export function createComputeImmediateShader(engine: EngineContext, options: ComputeImmediateShaderOptions): ComputeShader;
export function setComputeDispatchImmediates(dispatch: ComputeDispatch, data: ComputeImmediateData): void;
```

该可选立即数模块在不增加绑定或缓冲区的前提下暴露了 WebGPU 的 `var<immediate>` 地址空间。浏览器必须通过 `navigator.gpu.wgslLanguageFeatures` 声明支持 `immediate_address_space`。`immediateByteLength` 是在 `device.limits.maxImmediateSize`（通常为 64 字节）范围内的 4 的正倍数，并烘焙进着色器的显式管线布局中。

每次派发保留一个完整的立即数数据视图。该视图可以在两次执行之间原地修改而无需重建派发，但其字节长度必须精确匹配着色器声明的范围。录制会在每次直接、间接或管线变体派发之前调用 `setImmediates(0, data)`，因为新的 Pass 会重置立即数数据，且 WebGPU 要求所有使用范围都必须初始化。

无需引擎资源模型的 WGSL 原生能力——工作组内存、屏障、原子操作、子组（subgroup）操作以及子组大小控制——仍然直接在 `computeSource` 中编写。受设备特性门控的着色器特性通过可选的 `createEngineWithFeatures` 启用。已调度的计算任务会自动纳入现有的逐帧图任务 GPU 计时 API；立即独立提交则刻意不纳入该帧性能分析器。

### 纹理资源

```ts
export interface ComputeTextureResource {
    readonly texture: Texture2D;
    readonly sampleType: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
    readonly multisampled: boolean;
    readonly viewDimension: GPUTextureViewDimension;
}

export function createComputeTextureResource(
    engine: EngineContext,
    texture: Texture2D,
    options?: {
        sampleType?: ComputeTextureResource["sampleType"];
    }
): Promise<ComputeTextureResource>;

export function invalidateComputeTextureResource(resource: ComputeTextureResource): void;

export function createComputeTextureViewResource(
    engine: EngineContext,
    texture: Texture2D,
    options: {
        viewDimension: GPUTextureViewDimension;
        sampleType?: ComputeTextureResource["sampleType"];
        multisampled?: boolean;
    }
): Promise<ComputeTextureResource>;

export function computeTextureViewBinding(
    name: string,
    options: ComputeTextureBindingOptions & {
        readonly viewDimension: GPUTextureViewDimension;
    }
): ComputeBindingDecl;

export interface ComputeSampler {
    readonly type: "filtering" | "non-filtering" | "comparison";
}

export function createComputeSampler(engine: EngineContext, descriptor?: GPUSamplerDescriptor): ComputeSampler;

export interface ComputeStorageTexture2D {
    readonly width: number;
    readonly height: number;
    readonly format: "rgba8unorm" | "rgba8snorm" | "rgba16float" | "r32float" | "rgba32float";
    readonly sampledTexture: Texture2D;
    readonly computeTexture: ComputeTextureResource;
    readonly computeSampler: ComputeSampler;
}

export function createComputeStorageTexture2D(
    engine: EngineContext,
    options: {
        width: number;
        height: number;
        format: "rgba8unorm" | "rgba8snorm" | "rgba16float" | "r32float" | "rgba32float";
        label?: string;
    }
): ComputeStorageTexture2D;

export function disposeComputeStorageTexture2D(resource: ComputeStorageTexture2D): void;
export function cloneComputeStorageTexture2D(
    resource: ComputeStorageTexture2D,
    transform: Partial<Pick<Texture2D, "uScale" | "vScale" | "uOffset" | "vOffset" | "uAng">>
): Texture2D;

export interface ComputeStorageTexture {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
    readonly viewDimension: "1d" | "2d" | "2d-array" | "3d";
    readonly format: GPUTextureFormat;
    readonly accesses: readonly GPUStorageTextureAccess[];
    readonly sampledTexture: Texture2D | null;
    readonly computeTexture: ComputeTextureResource | null;
    readonly computeSampler: ComputeSampler | null;
}

export interface ComputeStorageTextureOptions {
    readonly width: number;
    readonly height?: number;
    readonly depthOrArrayLayers?: number;
    readonly viewDimension: ComputeStorageTexture["viewDimension"];
    readonly format: GPUTextureFormat;
    readonly access?: GPUStorageTextureAccess | readonly GPUStorageTextureAccess[];
    readonly sampled?: boolean;
    readonly sampler?: GPUSamplerDescriptor;
    readonly mipMaps?: boolean;
    readonly label?: string;
    readonly invertY?: boolean;
}

export function createComputeStorageTexture(engine: EngineContext, options: ComputeStorageTextureOptions): Promise<ComputeStorageTexture>;
export function disposeComputeStorageTexture(resource: ComputeStorageTexture): void;
export function createComputeStorageTextureMipmapsTask(name: string, resources: readonly ComputeStorageTexture[]): Task;
export function computeStorageTextureViewBinding(
    name: string,
    options: {
        readonly group: number;
        readonly binding: number;
        readonly format: GPUTextureFormat;
        readonly access: GPUStorageTextureAccess;
        readonly viewDimension: ComputeStorageTexture["viewDimension"];
    }
): ComputeBindingDecl;
```

`createComputeTextureResource` 通过一个临时 WebGPU 校验错误作用域校验现有的 2D `Texture2D`，从而在不向普通纹理包装器添加所有权元数据的前提下拒绝错误设备的视图。它从真实的 GPU 格式推导浮点/深度/整数采样兼容性。多重采样浮点颜色纹理使用 `unfilterable-float`；深度、有符号整数与无符号整数采样类型保持不变。未显式指定采样类型的多重采样声明默认使用 `unfilterable-float`，而显式指定的滤镜 `float` 会被拒绝。完整或仅模板的深度-模板视图会被拒绝，而显式暴露仅深度视图的包装器会被接受并交由 WebGPU 校验。数组与 3D 视图使用专用的高级辅助函数。替换底层纹理分配的稳定门面会自动使缓存的计算绑定组失效。仅当应用在保留同一 GPU 纹理的同时替换了包装器的 `view` 时，才需要调用 `invalidateComputeTextureResource`。

`createComputeTextureViewResource` 和 `computeTextureViewBinding` 是用于 `1d`、`2d-array`、`cube`、`cube-array` 和 `3d` 视图的高级可选路径。普通 2D 辅助函数不会导入它们。资源辅助函数通过临时绑定组校验调用方选定的视图维度与多重采样状态；Babylon Lite 绝不暴露底层 GPU 视图。

由 `createRenderTargetTexture` 返回的颜色与深度附件可以独立适配。这支持渲染 → 计算 → 呈现管线，而无需使渲染目标成为存储可写的：计算阶段采样已渲染的颜色和深度，写入一个独立的 `ComputeStorageTexture2D`，随后由渲染/特效任务呈现该输出。

`ComputeSampler` 在共享渲染采样器缓存之外拥有自己的采样器，使比较/LOD 语义保持计算局部性。

`ComputeStorageTexture2D` 拥有一个空的 `STORAGE_BINDING | TEXTURE_BINDING | COPY_SRC | COPY_DST` 纹理、计算纹理/采样器资源以及一个稳定的面向渲染的 `Texture2D` 门面。计算 Pass 绑定该资源本身用于存储写入；后续计算 Pass 使用 `computeTexture` 加 `computeSampler`，而渲染材质使用 `sampledTexture`。

`createComputeStorageTexture2D` 仍然是用于只写、可采样 2D 输出的精简同步路径。高级异步版本 `createComputeStorageTexture` 通过 WebGPU 错误作用域校验任意支持存储的格式、`1d` / `2d` / `2d-array` / `3d` 维度以及请求的每一种 `write-only` / `read-only` / `read-write` 访问模式。其可选采样器描述符同时配置面向渲染的采样门面和计算采样器，同时保持一个稳定的采样器标识。独立的 `computeStorageTextureViewBinding` 模块使着色器能够选用这些高级声明。受 WebGPU 特性门控的格式或访问模式必须在引擎创建前通过 `createEngineWithFeatures` 请求（例如 `bgra8unorm-storage`、`texture-formats-tier1` 或 `texture-formats-tier2`）。不支持的特性会在引擎创建期间拒绝；不支持的格式、维度或访问组合会在资源创建期间拒绝，而不是延迟到派发时才失败。

`mipMaps: true` 会为 2D、数组和 3D 纹理分配完整的合法 mip 链。与 `viewDimension: "1d"` 的组合会在分配前被拒绝，包括宽度为 1 的情况。Mip 分配并不隐含渲染目标用途：仅针对采样的 2D `rgba8unorm` 和 `rgba16float` 输出（以及当设备具备 `texture-formats-tier1` 时的 `rgba8snorm`）才会添加 `RENDER_ATTACHMENT`。调用方需通过 `createEngineWithFeatures` 显式请求该特性；引擎不会机会性地自动启用它。其他格式/维度或缺少所需特性时会保留其 mip 链但不包含渲染附件用途，且渲染 mip 任务会确定性地拒绝它们。`createComputeStorageTextureMipmapsTask` 仅在一次准备中创建可复用的视图、绑定组和 Pass 描述符，随后在帧图内部重新生成受支持的可过滤浮点 2D 链，而无需逐帧创建 WebGPU 对象。

高级资源接受引擎设备上启用的任何支持存储的格式。可选的 WebGPU 格式层级仍属于设备能力而非计算模块代码；不支持的格式会在资源的校验作用域期间拒绝。

存储纹理创建会根据格式与已启用的设备特性解析一次采样类型。当启用了 `float32-filterable` 时，`r32float`、`rg32float` 和 `rgba32float` 使用 `float`，否则使用 `unfilterable-float`。对于不可过滤的浮点与整数输出，过滤采样器会被拒绝；比较采样器需要深度纹理。最近邻过滤仍然是默认设置，包括精简 2D 构造函数。高级构造函数会对其采样器描述符进行快照，并校验返回资源将实际使用的精确采样视图和采样器。最终构造会复用这些对象以及经过校验的采样类型，而不是在 await 之后重新对格式分类。显式声明为不可过滤的绑定仍然可以通过非过滤采样器消费 `float` 资源。仅存储（storage-only）资源不创建采样对。

当采样门面或计算专属克隆体仍存在外部纹理所有者时，销毁操作会被拒绝。请先释放这些使用方，然后再销毁存储资源。

### 绑定集

```ts
export interface ComputeBufferRange<T> {
    readonly buffer: T;
    readonly offset?: number;
    readonly size?: number;
}

export type ComputeStorageBufferRange = ComputeBufferRange<StorageBuffer>;
export type ComputeUniformBufferRange = ComputeBufferRange<UniformBuffer>;
export function readStorageBuffer(buffer: StorageBuffer, byteOffset?: number, byteLength?: number): Promise<ArrayBuffer>;
export type ComputeBindingResources = Readonly<Record<string, unknown>>;

export interface ComputeBindingSet {
    readonly shader: ComputeShader;
}

export function createComputeBindingSet(shader: ComputeShader, resources: ComputeBindingResources): ComputeBindingSet;
export function disposeComputeBindingSet(bindings: ComputeBindingSet): void;
```

绑定集是不可变的。资源内容可以改变，但改变资源标识需要创建另一个绑定集。这保留了 A/B/A 复用能力，而无需销毁 A 或 B 的绑定组。

缓冲区绑定校验会检查：

- 资源种类与声明匹配；
- 资源属于着色器的引擎且处于存活状态；
- 可写存储声明接收的是可写 `StorageBuffer`；
- 静态偏移和大小已对齐、在边界内并满足 `minBindingSize`；
- uniform 与存储偏移对齐遵循所属设备的限制；
- 动态绑定为所有合法动态偏移保留了足够范围。

每个资源族自行负责声明创建、校验与存活句柄解析。通用绑定集代码仅调用由声明辅助函数安装的解析器。原始 WebGPU 句柄会被拒绝。

`readStorageBuffer` 是用于可写存储分配的显式可选回读路径。它向一个惰性分配的可复用暂存缓冲区提交一次拷贝，并以一个分离的 `ArrayBuffer` 兑现。可选的四字节对齐偏移/长度参数可避免为计数器或诊断信息拷贝整个 GPU slab。完全相同的并发范围共享待处理操作；不同范围则等待当前活跃读取完成。除非导入此辅助函数，否则普通存储用户不会保留任何回读代码。

### 派发

```ts
export interface ComputeDirectDispatch {
    readonly x: number;
    readonly y?: number;
    readonly z?: number;
}

export interface ComputeDispatchOptions {
    readonly size: ComputeDirectDispatch;
    readonly enabled?: boolean;
}

export interface ComputeIndirectDispatchOptions {
    readonly buffer: StorageBuffer;
    readonly byteOffset?: number;
    readonly enabled?: boolean;
}

export interface ComputeDispatch {
    readonly shader: ComputeShader;
    readonly bindings: ComputeBindingSet;
    enabled: boolean;
}

export function createComputeDispatch(shader: ComputeShader, bindings: ComputeBindingSet, options: ComputeDispatchOptions): ComputeDispatch;
export function setComputeDispatchSize(dispatch: ComputeDispatch, size: ComputeDirectDispatch): void;
export function setComputeDispatchDynamicOffset(dispatch: ComputeDispatch, bindingName: string, byteOffset: number): void;
export function createComputeIndirectDispatch(shader: ComputeShader, bindings: ComputeBindingSet, options: ComputeIndirectDispatchOptions): ComputeDispatch;
export function setComputeIndirectDispatch(dispatch: ComputeDispatch, buffer: StorageBuffer, byteOffset?: number): void;
```

直接派发的维度是非负整数，可以为零，这与 WebGPU 合法的空操作派发一致。值不得超过 `maxComputeWorkgroupsPerDimension`。

间接派发需要一个使用 `indirect: true` 创建的同引擎存活 `StorageBuffer`；`byteOffset` 为 4 的非负倍数，且至少保留 12 字节可用空间。

动态偏移按 WebGPU 绑定顺序预展开为每绑定组一个保留的数值数组。设置偏移会原地修改保留槽位，不执行任何分配。

直接派发是核心路径。导入 `setComputeDispatchDynamicOffset` 会启用动态偏移存储；导入 `createComputeIndirectDispatch` 会启用间接派发。直接、静态偏移的场景不会保留这两个模块中的任何一个。

### 管线变体

```ts
export type ComputePipelineConstants = Readonly<Record<string, number>>;

export interface ComputePipelineVariant {
    readonly shader: ComputeShader;
    readonly constants: ComputePipelineConstants;
}

export function createComputePipelineVariant(shader: ComputeShader, constants: ComputePipelineConstants): ComputePipelineVariant;
export function prepareComputePipelineVariant(variant: ComputePipelineVariant): Promise<void>;
export function createComputeVariantDispatch(variant: ComputePipelineVariant, bindings: ComputeBindingSet, options: ComputeVariantDispatchOptions): ComputeDispatch;
```

管线常量及其缓存属于可选的变体对象。键可以是符号化的 WGSL override 名称，或针对使用 `@id(...)` 声明的 override 的 `0` 到 `65535` 之间的规范十进制标识符。符号名称原样传递给 WebGPU，由 WebGPU 在管线创建期间执行权威的 WGSL 版本特定校验。默认 `ComputeShader` 仅存储一个管线和一个待处理预准备 Promise。

### 计算任务

```ts
export interface ComputeTask extends Task {
    readonly dispatches: readonly ComputeDispatch[];
    executionEnabled: boolean;
}

export function createComputeTask(engine: EngineContext, name?: string): ComputeTask;
export function addComputeDispatch(task: ComputeTask, dispatch: ComputeDispatch): void;
export function removeComputeDispatch(task: ComputeTask, dispatch: ComputeDispatch): void;
export function prepareComputeTask(task: ComputeTask): Promise<void>;
export function submitComputeTasks(tasks: readonly ComputeTask[]): void;
```

`addComputeDispatch` 保留插入顺序。现有派发可以更改维度、偏移、启用状态、uniform 内容和存储内容，而无需重建帧图。

如果在注册后添加了一个管线变体尚未预准备的派发，则必须在启用它之前调用 `prepareComputeTask(task)`。启动注册会自动调用任务的 `_preload()`。

`submitComputeTasks` 会在单个命令缓冲区中立即执行已录制且启用执行的同引擎任务，而无需获取或渲染到交换链纹理。它旨在用于确定的离屏预热以及已注册帧之间的显式纯计算工作；任务顺序会被保留。在引擎正在录制当前帧的帧回调期间调用它会抛出异常，因为独立的立即提交否则可能会抢先于已编码进未完成帧的命令执行。当传入的每个任务都满足 `executionEnabled === false` 时，不会创建命令编码器或提交。

单次触发（one-shot）的完成状态绑定于命令编码器作用域。录制会将已待命的代次与当前编码器关联，仅当同一编码器成功提交后才能禁用并兑现它。导致帧或直接编码器中止的异常会让单次触发保持待命状态以便后续重试；无关的提交无法兑现从未到达 GPU 的工作。

任务拥有其派发数组和已录制的 `ComputePass`；它不拥有着色器、绑定集或已绑定资源。

可选的 `compute-one-shot` 模块提供仅启动一次的执行能力，而无需添加第二条提交路径：

```ts
export interface ComputeOneShot {
    readonly task: ComputeTask;
    completion: Promise<void>;
}

export function createComputeOneShot(task: ComputeTask): ComputeOneShot;
export function armComputeOneShot(oneShot: ComputeOneShot): Promise<void>;
export function disposeComputeOneShot(oneShot: ComputeOneShot): void;
```

创建会立即使任务待命。仅当其 Pass 实际被访问后，录制才会标记单次触发；零工作的 Pass 会标记一次已提交的空操作，而不会开启计算 Pass。当单次触发存在时，该模块会安装一个可选的引擎提交后钩子。一次成功的 `queue.submit()` 会调用该钩子，在下一动画帧之前禁用每一个已录制的触发，并在 `queue.onSubmittedWorkDone()` 之后兑现每个待命 Promise。如果后续的渲染上下文在提交前中止了帧，该钩子不会被调用，单次触发仍保持待命以供重试。不会添加额外的命令提交。

### 任务自有 uniform 内存区

```ts
export interface ComputeUniformArena {
    readonly buffer: UniformBuffer;
    readonly slotByteLength: number;
    readonly slotStride: number;
    readonly slotCount: number;
}

export function createComputeUniformArena(task: ComputeTask, slotByteLength: number, slotCount: number, options?: UniformBufferOptions): ComputeUniformArena;

export function getComputeUniformSlotOffset(arena: ComputeUniformArena, slot: number): number;
export function updateComputeUniformSlot(arena: ComputeUniformArena, slot: number, data: ArrayBufferView, byteOffset?: number): void;
```

内存区将每个槽位按 `minUniformBufferOffsetAlignment` 对齐，保留一个 CPU 暂存分配，并在任务开启其计算 Pass 之前上传一个包含所有脏区域的范围。通过动态 uniform 声明绑定 `arena.buffer`，并为每个派发使用 `getComputeUniformSlotOffset`。

### 类型化 uniform 写入器

```ts
export type ComputeUniformScalarType = "f32" | "u32" | "i32" | "f16";
export type ComputeUniformVectorType = `vec${2 | 3 | 4}<${ComputeUniformScalarType}>`;
export type ComputeUniformMatrixType = `mat${2 | 3 | 4}x${2 | 3 | 4}<${"f32" | "f16"}>`;
export type ComputeUniformType = ComputeUniformScalarType | ComputeUniformVectorType | ComputeUniformMatrixType;

export interface ComputeUniformField {
    readonly name: string;
    readonly type: ComputeUniformType;
}

export interface ComputeUniformLayout {
    readonly byteLength: number;
}

export interface ComputeUniformWriter {
    readonly arena: ComputeUniformArena;
    readonly slot: number;
    readonly layout: ComputeUniformLayout;
}

export function createComputeUniformLayout(fields: readonly ComputeUniformField[]): ComputeUniformLayout;
export function createComputeUniformWriter(arena: ComputeUniformArena, slot: number, layout: ComputeUniformLayout): ComputeUniformWriter;
export function isComputeF16Supported(): Promise<boolean>;
export function isComputeF16Supported(engine: EngineContext): boolean;
export function createComputeUniformF16Writer(arena: ComputeUniformArena, slot: number, layout: ComputeUniformLayout): ComputeUniformWriter;
export function setComputeUniformF32(writer: ComputeUniformWriter, name: string, value: number): void;
export function setComputeUniformU32(writer: ComputeUniformWriter, name: string, value: number): void;
export function setComputeUniformI32(writer: ComputeUniformWriter, name: string, value: number): void;
export function setComputeUniformF16(writer: ComputeUniformWriter, name: string, value: number): void;
export function setComputeUniformVector(writer: ComputeUniformWriter, name: string, value: ArrayLike<number>): void;
export function setComputeUniformMatrix(writer: ComputeUniformWriter, name: string, value: ArrayLike<number>): void;
export function setComputeUniform(writer: ComputeUniformWriter, name: string, value: number | ArrayLike<number>): void;
```

布局创建校验非空字段名与类型、拒绝重复名称，并一次性计算 uniform 地址空间偏移。写入器创建一次性解析一个内存区槽位，并在内存区的暂存分配上保留 `Float32Array`、`Uint32Array` 和 `Int32Array` 视图。

专用设置器执行一次预计算的名称查找、校验设置器类别和精确元素数量、直接写入保留视图，并扩大内存区的脏范围。它们不分配内存、不搜索声明、不转换形状、不比较先前值，也不单独上传。矩阵输入为列主序且连续；写入器会将任何 WGSL 列填充直接插入目标内存。

`setComputeUniform` 是用于初始化和非关键路径的通用已校验便捷 API。热路径应使用与声明字段匹配的专用标量、向量或矩阵设置器。

Binary16 需要显式启用，因为 WebGPU 特性必须在设备创建前请求：

```ts
if (!(await isComputeF16Supported())) {
    throw new Error("This application requires shader-f16.");
}
const engine = await createEngineWithFeatures(canvas, { requiredFeatures: ["shader-f16"] });
```

在创建引擎之前调用 `isComputeF16Supported()` 会使用与 `createEngine` 相同的适配器选项查询所选适配器。传入现有引擎则会检查其设备是否实际启用了该特性。通过 `createEngineWithFeatures(canvas, { requiredFeatures: ["shader-f16"] })` 为每个引擎请求 `shader-f16`；如果在能力查询与创建之间适配器可用性发生变化，引擎创建会通过 WebGPU 拒绝。

`compute-uniform-f16` 模块拥有能力查询、转换代码以及保留的暂存 `DataView`。包含 f16 字段的布局使用 `createComputeUniformF16Writer`。从未导入这些 API 的场景不会保留任何转换实现；显式设备特性选择仍保留在可选引擎工厂之后。

## 内部架构

### `ComputeShader`

内部字段：

```ts
interface ComputeShader {
    /** @internal */ readonly _engine: EngineContext;
    /** @internal */ readonly _source: string;
    /** @internal */ readonly _entryPoint: string;
    /** @internal */ readonly _decls: readonly ComputeBindingDecl[];
    /** @internal */ readonly _slots: Map<string, ComputeBindingSlot>;
    /** @internal */ _device: GPUDevice | null;
    /** @internal */ _module: GPUShaderModule | null;
    /** @internal */ _layouts: GPUBindGroupLayout[] | null;
    /** @internal */ _pipelineLayout: GPUPipelineLayout | null;
    /** @internal */ _pipeline: GPUComputePipeline | null;
    /** @internal */ _pending: Promise<GPUComputePipeline> | null;
    /** @internal */ _destroyed: boolean;
}
```

每个着色器在创建时捕获其所属 `GPUDevice`。与 `engine._device` 不匹配时会抛出异常，并要求应用重新创建其计算图；设备自有的对象绝不会被静默重建。

异步预准备在等待前捕获设备。仅当着色器依然存活且其引擎仍拥有所捕获的设备时，才会发布结果。针对同一变体的并发预准备共享同一个 Promise。

### `ComputeBindingSet`

内部字段：

```ts
interface ComputeBindingSet {
    /** @internal */ readonly _shader: ComputeShader;
    /** @internal */ readonly _resources: readonly ComputeResolvedResource[];
    /** @internal */ _device: GPUDevice | null;
    /** @internal */ _groups: GPUBindGroup[] | null;
    /** @internal */ _destroyed: boolean;
}
```

解析后的资源数组按 group 再按 binding 排序。每个条目存储公共包装器与静态范围，而非原始句柄。绑定组在惰性阶段或预准备阶段从当前句柄构建。如果着色器的引擎设备发生变更，后续使用会显式失败，而不是重建部分状态。

### `ComputeDispatch`

内部字段包含：

- 规范化的管线常量键与保留描述符；
- 直接维度或间接包装器/偏移；
- 每个绑定组一个保留的动态偏移数组；
- 对不可变绑定集的直接引用；
- 启用状态。

在 Pass 执行期间不会发生任何映射表查找、描述符规范化、数组创建或资源名搜索。

### `ComputeTask` 与 `ComputePass`

`ComputeTask.record()` 创建一个 `ComputePass`。Pass 的执行回调：

1. 遍历任务保留的派发数组；
2. 跳过禁用的派发；
3. 解析已预准备的管线变体；
4. 在本次任务执行中对每个唯一绑定集仅校验一次，即使有多个派发复用它；
5. 仅当管线与上一次派发不同时才调用 `setPipeline`；
6. 仅当绑定组或该组的动态偏移不同时才调用 `setBindGroup`；
7. 发出 `dispatchWorkgroups` 或 `dispatchWorkgroupsIndirect`。

Pass 只开启一次并结束一次。它使用 `engine._currentEncoder`；从不创建或提交命令编码器。

共享的底层录制器也可服务于内部薄实例剔除，但公共资源抽象不得向剔除的热路径增加内存分配或通用绑定扫描。如果测量显示精简的 group-0 直接派发快速路径更小或更快，则会保留该路径。

## 管线配置

着色器源码原封不动地传递给 `GPUDevice.createShaderModule`。

每个声明的 group 创建一个按 binding 排序的 `GPUBindGroupLayout`。管线布局的 group 位置与 WGSL group 编号精确匹配。

管线描述符：

```ts
{
    label: shader.name,
    layout: shader._pipelineLayout,
    compute: {
        module: shader._module,
        entryPoint: shader._entryPoint,
        constants,
    },
}
```

没有任何渲染状态、材质、场景绑定组或渲染目标签名参与计算管线标识。

## 着色器逻辑

Babylon Lite 不注入声明或辅助代码。着色器即完整的 WGSL：

```wgsl
struct Params {
    count: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x < params.count) {
        output[id.x] = vec4<f32>(f32(id.x), 0.0, 0.0, 1.0);
    }
}
```

## 状态机与生命周期

### 着色器

1. 创建不可变 CPU 描述符。
2. 异步预准备零个或多个管线变体，或在任务预准备时同步构建。
3. 在绑定集/任务之间共享。
4. 如果引擎设备变更，后续使用抛出异常，由应用重建计算图。
5. 销毁；后续预准备或使用抛出异常。

### 绑定集

1. 校验并保留包装器/范围。
2. 针对着色器当前布局构建绑定组。
3. 在派发/任务之间共享。
4. 如果着色器的引擎设备变更，后续使用抛出异常。
5. 销毁而不销毁底层资源。

### 派发

1. 校验着色器/绑定集标识、维度、间接源、常量与偏移。
2. 添加到一个或多个兼容任务。
3. 仅变更启用状态、维度、间接偏移以及保留的动态偏移值。
4. 从任务移除不会销毁派发。

### 任务

1. 创建并添加有序派发。
2. 将任务添加到场景或独立帧图。
3. `_preload()` 预准备唯一的着色器变体与绑定集。
4. `record()` 创建一个 Pass。
5. 每个启用的帧执行一次计算 Pass。
6. 仅销毁 Pass 与任务自有的 uniform 存储。

## 设备丢失

自动重建计算状态刻意不在支持范围内。GPU 生成的缓冲区、间接参数、存储纹理、模拟状态以及时序数据可能没有权威的 CPU 副本，因此重新创建句柄无法透明地恢复正确内容。如果引擎设备变更，计算着色器和变体会显式失败。应用自行决定是否重新加载或重新创建其引擎、资源、任务以及领域状态。

## 刻意不提供的特性

- 着色器仓库注册、URL/DOM 源码加载、文本 include 预处理以及序列化仍由应用负责。Lite 接受完整 WGSL，并保持包内无全局注册表和导入时副作用。
- 可变的着色器自有绑定以及影响正确性的 `fastMode` 开关是不必要的。可复用的不可变绑定集与资源纪元失效机制在不禁用校验的情况下提供相同的性能。
- 原始 `GPUBuffer`、`GPUTextureView`、`GPUSampler` 以及引擎内部缓冲区/纹理包装器绝不作为公共绑定输入。
- 不向计算暴露 `GPUExternalTexture` / `texture_external`。Babylon Lite 的视频和外部图像 API 会拷贝到普通 `Texture2D` 分配中，它们是合法的计算输入且在各 WebGPU 实现间可移植。
- 不在多派发任务内部暴露逐派发时间戳查询，因为标准 WebGPU 时间戳写入包裹的是 Pass 而非单个命令。请在有意义的性能分析/排序边界使用独立的具名计算任务以及现有的任务 GPU 性能分析器。

## 热路径要求

在预准备之后，单帧不得分配任何：

- 每次派发的命令编码器或命令缓冲区；
- 派发描述符对象；
- 临时单元素数组；
- 资源映射表；
- 绑定组条目数组；
- 动态偏移数组；
- `DataView` 或转换后的 uniform 数组；
- 管线键字符串。

稳态循环基于索引执行，并直接操作保留的派发、管线、绑定组及偏移数据。

## Tree-Shaking

计算模块仅通过显式导入的公共工厂函数可达。没有任何引擎、场景、渲染任务、材质或加载器模块导入公共计算 API。

共享核心更改仅限于 `Pass` 已预期的具体 `ComputePass` 支持，以及仅在计算单次触发安装其钩子时才会使用的一个可选提交后短路路径。在未导入计算模块的场景中，它们不得保留计算实现代码。

所有缓存均为对象自有或惰性初始化。不存在模块级的 `Map`、`Set` 或 `WeakMap` 分配。

仅当调用 `createComputeImmediateShader` 或 `setComputeDispatchImmediates` 时，才会安装立即数数据钩子。未导入该可选模块的计算场景不会保留任何立即数数据实现。

## 错误处理

公共创建/变更边界针对无效声明、未知名称、重复绑定、错误资源种类、错误引擎、已销毁资源、无效范围、无效偏移以及无效派发维度抛出异常。

没有任何 API 会静默丢弃绑定、钳制维度、替换回退资源或将失败的预准备视为成功。

## Babylon.js 等价映射

| Babylon.js | Babylon Lite |
| --- | --- |
| `ComputeShader` 源码/管线状态 | `ComputeShader` |
| `ComputeShader` 资源设置器 | 不可变 `ComputeBindingSet` |
| 直接派发 | `ComputeDispatch` 直接尺寸 |
| 间接派发 | `ComputeDispatch` 间接尺寸 |
| 帧图计算任务/Pass | `ComputeTask` / `ComputePass` |
| `UniformBuffer` | 不透明 `UniformBuffer` 加上独立函数 |
| 带顶点/索引/间接标志的存储缓冲区 | 扩展的 `StorageBufferOptions` |

Lite 刻意不效仿 Babylon.js 的可变着色器自有绑定模型。

## 测试规范

专项单元测试必须证明：

1. 声明校验与稳定的绑定排序；
2. A/B/A 不可变绑定集复用；
3. 多组绑定与多个 uniform 缓冲区；
4. 静态缓冲区子范围与动态偏移；
5. 直接、零尺寸与间接派发校验；
6. 200 个不同参数化的派发录制到单个计算 Pass 中；
7. 管线与绑定组去重；
8. 重复执行不产生初始化期分配或名称扫描；
9. 异步预准备去重、拒绝清理、销毁竞争以及设备变更拒绝；
10. 错误引擎与已销毁资源失败处理；
11. 计算/渲染/计算任务排序；
12. 任务销毁不会销毁共享着色器/绑定集/资源；
13. 混合存储缓冲区、UBO、采样纹理、采样器与存储纹理绑定组；
14. 纹理采样类型、多重采样、采样器类型、格式、维度、所有权及销毁校验；
15. 立即数数据能力、大小、全量初始化、管线布局与派发录制校验；
16. 对齐范围存储回读、暂存区增长/复用、同范围合并以及不同范围串行化。

集成测试覆盖：

- 来自 PR #583 的仅存储场景从单个 CPU 填充的支持顶点的存储分配中渲染多个 `baseVertex` 槽位；
- 场景 169 将蜡烛渲染到可采样颜色/深度附件，使用类型化无分配 uniform 设置器驱动深度感知的动画计算火焰写入独立存储纹理，并在后续帧图任务中呈现该纹理；
- 场景 188 使用单次触发计算任务填充支持顶点的存储 slab，由渲染直接消费，无回读或拷贝；
- 场景 189 使用一个计算 Pass 生成间接工作组计数，并由后续 Pass 通过 `dispatchWorkgroupsIndirect` 消费，结果直接从 GPU 生成的存储渲染。

## 文件清单

- `docs/lite/architecture/54-compute.md`
- `packages/babylon-lite/src/compute/compute-shader.ts`
- `packages/babylon-lite/src/compute/compute-binding.ts`
- `packages/babylon-lite/src/compute/compute-bindings.ts`
- `packages/babylon-lite/src/compute/compute-buffer-binding.ts`
- `packages/babylon-lite/src/compute/compute-dispatch.ts`
- `packages/babylon-lite/src/compute/compute-dynamic-offset.ts`
- `packages/babylon-lite/src/compute/compute-indirect-dispatch.ts`
- `packages/babylon-lite/src/compute/compute-immediates.ts`
- `packages/babylon-lite/src/texture/mipmap-preparation.ts`
- `packages/babylon-lite/src/compute/compute-pipeline-variant.ts`
- `packages/babylon-lite/src/compute/compute-sampler-binding.ts`
- `packages/babylon-lite/src/compute/compute-sampler-resource.ts`
- `packages/babylon-lite/src/compute/compute-storage-buffer-binding.ts`
- `packages/babylon-lite/src/compute/compute-storage-texture-binding.ts`
- `packages/babylon-lite/src/compute/compute-storage-texture-view-binding.ts`
- `packages/babylon-lite/src/compute/compute-task.ts`
- `packages/babylon-lite/src/compute/compute-texture-binding.ts`
- `packages/babylon-lite/src/compute/compute-texture-resource.ts`
- `packages/babylon-lite/src/compute/compute-texture-view-binding.ts`
- `packages/babylon-lite/src/compute/compute-texture-view-resource.ts`
- `packages/babylon-lite/src/compute/compute-one-shot.ts`
- `packages/babylon-lite/src/compute/compute-uniform-arena.ts`
- `packages/babylon-lite/src/compute/compute-uniform-buffer-binding.ts`
- `packages/babylon-lite/src/compute/compute-uniform-f16.ts`
- `packages/babylon-lite/src/compute/compute-engine-features.ts`
- `packages/babylon-lite/src/frame-graph/compute-pass.ts`
- `packages/babylon-lite/src/frame-graph/pass.ts`
- `packages/babylon-lite/src/frame-graph/frame-graph-actions.ts`
- `packages/babylon-lite/src/mesh/mesh-from-storage.ts`
- `packages/babylon-lite/src/mesh/mesh-vertex-layout.ts`
- `packages/babylon-lite/src/compute/compute-uniform-buffer.ts`
- `packages/babylon-lite/src/resource/storage-buffer.ts`
- `packages/babylon-lite/src/resource/compute-storage-texture.ts`
- `packages/babylon-lite/src/resource/compute-storage-texture-view.ts`
- `packages/babylon-lite/src/resource/managed-resource-hooks.ts`
- `packages/babylon-lite/src/engine/engine.ts`
- `packages/babylon-lite/src/index.ts`
- `tests/lite/unit/` 下的专项测试
- `lab/lite/src/` 下的计算集成场景
