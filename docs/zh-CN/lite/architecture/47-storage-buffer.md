# 模块：存储缓冲区（Storage Buffer）

> 包路径：`packages/babylon-lite/src/resource/storage-buffer.ts`

## 用途

暴露着色器可读的存储分配资源，同时不在公共 API 中暴露原生 WebGPU 句柄。该资源具有稳定的标识，因此可以在不重建材质 bind group 的情况下更改其内容。

## 公共 API 接口

```ts
interface StorageBuffer {
    readonly byteLength: number;
}

interface StorageBufferOptions {
    readonly label?: string;
    readonly writable?: boolean;
    readonly vertex?: boolean;
    readonly index?: boolean;
    readonly indirect?: boolean;
}

function createStorageBuffer(engine: EngineContext, source: ArrayBufferView | number, labelOrOptions?: string | StorageBufferOptions): StorageBuffer;
function updateStorageBuffer(engine: EngineContext, buffer: StorageBuffer, data: ArrayBufferView, byteOffset?: number): void;
function readStorageBuffer(buffer: StorageBuffer, byteOffset?: number, byteLength?: number): Promise<ArrayBuffer>;
function disposeStorageBuffer(buffer: StorageBuffer): void;
```

`setShaderStorageBuffer(material, name, buffer)` 为 `createShaderMaterial` 创建的存储声明接受 `StorageBuffer | null`。

这取代了之前的原生 `GPUBuffer` 参数。迁移方式为：使用 `createStorageBuffer` 包装初始数据，通过 `updateStorageBuffer` 更新数据，并在调用 `disposeStorageBuffer` 之前解除绑定。

数值源指定一个有限、非负的安全整数字节数。零依然有效，并保留最小的四字节分配。数值源和类型化视图源都会通过 `Math.ceil(Math.max(requestedBytes, 4) / 4) * 4` 向上取整，绝不使用 32 位按位算术。填充后的容量必须保持为安全整数，且不得超过 `device.limits.maxBufferSize`；校验会在创建 CPU 影子副本、分配 GPU 内存或注册资源之前执行。对于类型化视图，适用的是视图的字节长度和偏移量，而非整个底层缓冲区。

## 内部架构

`StorageBuffer` 是名义品牌化（nominally branded）的纯状态对象，包含一个公共的对齐字节容量和一个内部 `GPUBuffer`。普通只读存储保留 CPU 影子副本，并使用映射创建（mapped-at-creation）的 `STORAGE | COPY_DST` 分配。可写、顶点、索引和间接分配不保留 CPU 影子副本；可写分配还会额外添加 `COPY_SRC`。数值型的 GPU 角色源直接在 GPU 上分配。类型化视图的 GPU 角色源使用映射创建初始化，仅将视图的字节复制到已填充且零初始化的分配中。因此，奇数字节数不会到达 `queue.writeBuffer`（其上传长度必须是 4 的倍数）。
可选的 vertex/index/indirect 用途标志描述该分配的能力。更新使用 `queue.writeBuffer`，并要求 4 字节对齐的偏移量和长度。ShaderMaterial 存储该资源对象；可渲染对象仅在构建 bind group 时解包内部句柄。
内部标识/生命周期字段是不可枚举的，并且每条变更/绑定路径都会校验该精确包装对象是否仍注册在其所属引擎中；浅拷贝无法冒充存活的分配。

引擎拥有一个惰性的存活存储缓冲区集合。其既有的基于 CPU 备份的存储重建会从保留的字节恢复普通只读 `STORAGE | COPY_DST` 分配。该路径会重新请求旧设备的存储限制。限制收集与重建例程保留在仅用于恢复的模块中，因此普通存储用户不会加载恢复代码或创建恢复回调。
仅当存在存储分配时，恢复流程才会加载该模块。它在等待替换设备请求之后会再次检查，以免遗漏在 await 期间新增的分配。
创建 bind group 时会重新检查资源存活状态和引擎归属。引擎销毁时会销毁所有剩余的存活存储缓冲区、释放 CPU 字节并清空注册表。

GPU 角色存储分配和存储支持（storage-backed）网格的自动恢复有意推迟到即将进行的恢复重构中。这些分配没有 CPU 镜像，不会被现有的钩子重新分配或重新填充。存储网格不保留重建源或弱引用注册，其借用句柄和私有索引缓冲区在设备丢失后也不会被重新绑定或重建。使用这些特性的应用必须在恢复渲染前自行重建受影响的分配和网格。遗留的普通存储重建不涵盖这些较新角色，也不修复现有的存储网格。

可选启用的 `setMeshIndexedIndirect(mesh, args, byteOffset)` 消费者接受位于 INDIRECT 分配中的 20 字节 GPU 生成索引绘制记录。有关 ABI、借用语义、未知计数诊断、缓存 bundle 失效以及生产者重运行要求，请参阅 [plain storage indexed indirect draws](mesh-indexed-indirect.md)。
设备恢复会清除 GPU 角色分配的旧设备句柄（它们没有可供重建的 CPU 影子副本），因此在替换设备上绑定此类资源会被拒绝，而不会提交来自已丢失设备的句柄。

## 管线配置

该模块不创建管线。ShaderMaterial 的存储声明继续创建只读存储 bind-group-layout 条目。重新绑定同一个资源是空操作，而绑定不同资源会使材质资源版本递增一次。

### 存储支持网格布局边界

存储网格和交错 glTF 网格发布一个以属性名（`position`、`normal`、`uv`、`uv2`、`tangent`、`color`）为键的无原型（null-prototype）布局字典。材质在生成 GPU 布局时直接读取打包方式；不需要全局激活或名称到槽位的转换。未知名称无法通过 `Object.prototype` 解析。
材质属性和 WGSL 类型保持不变；实例级（instance-rate）属性保留其材质定义的打包方式。glTF 解码器的 CPU 访问器记录保留各自的表述形式。

Node 材质通过同一属性循环生成规范布局和打包 GPU 布局。解析发生在绑定时，而不是材质解析时，因此在其首个存储网格之前编译的材质仍能获得正确的变体。变体归属于其编译结果，绝不跨设备使用。不透明 Node 分组会在分配分区映射之前检查是否存在异构布局键；几何体创建绝不会导入或安装 Node 后端。
打包变体复用基础描述符的管线布局、着色器模块和片元状态；仅更改其顶点缓冲区布局。这同样适用于几何体 MRT 输出。
编译结果保留其原始 `UboSpec`，而非平行的大小/偏移量元数据；没有节点 uniform 的图不会保留空的布局映射。

对于缺失的切线、UV2 和颜色流，网格布局会包含零步幅（zero-stride）条目。这些条目描述常量回退缓冲区，而非共享 slab。它们的缓存键槽位保持为 `-`，以区别于位于偏移量零处的显式编写 slab 属性。因此，材质不需要第二次布局重写来支持缺失流。

`MeshFromStorageOptions.attributeOffsets` 仅接受位置、法线、UV、UV2、切线和颜色的自有属性（own properties）。未知名称（包括蒙皮流）、非整数或负偏移量、超出顶点步幅的偏移量以及超出设备限制的步幅都会在索引缓冲区分配之前被拒绝。材质准备阶段还会额外校验每个被消费格式的字节范围和对齐要求；材质声明绝不会重新打包规范 CPU 几何体。

直接绘制将 `baseVertex` 传递给 WebGPU，无需转发包装器。五字间接 ABI 共享于 `mesh-indexed-indirect.ts`，仅由间接消费者加载。绘制网格不得导入属性转换或默认流分配代码。共享零流分配仍仅由存储几何体安装，作为一个引擎拥有的 `_getVertexDefaultBuffer` 回调。其闭包拥有当前的设备/缓冲区对，在设备变更后替换缓冲区，并为每个存活代际精确注册一个销毁器。
核心渲染器仅包含可选回调调用，而非全局默认缓冲区注册表。遗留的 Node/Shader 缺失属性缓冲区会在考虑紧凑打包 `float32x3` 缓冲区大小启发式之前，先使用交错位置访问器的元素计数。空几何体保持有效的四字节最小值。存储支持网格仍优先走常量缓冲区路径，绝不分配与共享 slab 成比例的默认缓冲区。

## 着色器逻辑

无。声明的 WGSL 类型仍由 `ShaderStorageBufferDecl` 拥有。

## 状态机 / 生命周期

创建、可选地更新任意越界内的范围、绑定到一个或多个 ShaderMaterial、解除绑定，然后销毁。销毁是幂等的。更新或重新绑定已销毁的资源会抛出异常；范围内的零长度更新是空操作。

当所属引擎存在活动的帧编码器时，`readStorageBuffer` 会在暂存缓冲区分配或提交之前拒绝调用。请在生成帧提交后再读取；独立的拷贝绝不能越过已录制到该帧中的计算写入。
仅可写分配支持回读。可选的偏移量和长度值必须是 4 字节对齐的非负安全整数，且保持在分配范围内。这使调用方无需拷贝整个 slab 即可读取 GPU 计数器或诊断信息。相同的并发范围共享同一个挂起的 Promise；不同范围则排队等待当前活动读取完成。单个惰性暂存分配会被复用，仅在需要时扩容，并且每次完成的读取都会返回一个独立的 `ArrayBuffer` 拷贝。当有读取挂起时发生设备变更会被拒绝，之后的读取会替换在旧设备上分配的暂存缓冲区。如果映射范围提取或拷贝失败，暂存缓冲区仍会在复用前取消映射，且读取 Promise 会保留该失败。对可写缓冲区的更新不会创建 CPU 影子视图。

## Babylon.js 等价映射

角色上等价于 Babylon.js 的 `StorageBuffer`：围绕 WebGPU 存储分配的高级生命周期包装器，采用符合 Lite 纯状态 API 约定的独立函数。

## 依赖项

`EngineContext`、内部 GPU 标志别名，以及内部映射缓冲区上传辅助函数。

## 测试规范

单元测试验证创建标志与对齐、初始映射上传、有界对齐更新、隐藏句柄标识、幂等销毁，以及销毁后使用的拒绝。
大小覆盖测试包括负数/小数/非有限/非安全值、零字节与奇数字节数、填充后的设备限制边界、类型化子数组，以及在不产生大宿主机分配的情况下跨越 2 GiB/4 GiB 的值。共享对齐辅助函数也会在这些边界上接受测试。

## 文件清单

- `packages/babylon-lite/src/resource/storage-buffer.ts`
- `packages/babylon-lite/src/resource/storage-buffer-recovery.ts`：仅包含既有的普通存储恢复。
- `tests/lite/unit/storage-buffer.test.ts`
- `docs/lite/architecture/47-storage-buffer.md`
