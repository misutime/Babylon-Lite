# 模块：普通存储网格索引间接绘制（Plain storage mesh indexed indirect draw）

## 目的与公共 API

```ts
function setMeshIndexedIndirect(mesh: Mesh, buffer: StorageBuffer | null, byteOffset?: number): void;
interface MeshIndexedDrawInfo {
    readonly mode: "direct" | "indirect";
    readonly indexCapacity: number;
    readonly indexCount: number | null;
    readonly instanceCount: number | null;
}
function getMeshIndexedDrawInfo(mesh: Mesh): MeshIndexedDrawInfo;
```

面向普通存储缓冲支撑的 ShaderMaterial 网格的可选、网格局部借用机制。使用 `createStorageBuffer(engine, 20, { writable: true, indirect: true })` 创建参数缓冲，并通过 `setMeshIndexedIndirect(mesh, args, byteOffset)` 进行绑定。传入 null 将恢复现有的 CPU 绘制。不支持薄实例（thin instances）和其他材质系列。克隆网格一如既往共享几何体所有权，但不会继承该借用；若克隆体也需使用相同参数，须显式为其绑定。

## ABI 与生产者契约

源范围严格为 20 字节，按 4 字节对齐：`u32 indexCount`、`u32 instanceCount`、`u32 firstIndex`、`i32 baseVertex`、`u32 firstInstance`。生产者拥有全部五个字（包括有符号的 baseVertex 和精确的 firstIndex）。Lite 从不初始化、读取、复制或修补它们。GPU 计数为零是合法的空操作。生产者必须确保索引和顶点访问保持在已初始化的几何体范围内，且除非设备支持 `indirect-first-instance`，否则将 firstInstance 设为零。绑定操作仅校验字节范围，不校验 GPU 数值。

使用 Lite 的计算 API 在消费该参数的渲染通道之前提交计算着色器。同一缓冲区既可作为计算存储绑定，也可作为间接参数源，但不能在消费它的渲染通道中作为可写存储绑定（存在 WebGPU 用途冲突）。解析网格包围盒必须包含所有生成的绘制；CPU 拾取和 CPU 准入不会从 GPU 数据重建。

## 所有权、替换与恢复

参数缓冲、借用的顶点缓冲和共享索引缓冲仍归调用方所有。绑定将外部条目存储在 WeakMap 中，而不会在 Mesh 上持有场景引用。解绑或替换会释放旧借用；网格退役时删除该条目但不销毁底层分配。非销毁性质的场景分离会保留该借用。仅在所有消费者和已提交工作全部使用完该资源后再释放它。释放仍处于绑定状态的分配会在下次更新/绘制（包括缓存包执行前的更新）时报错；不存在 CPU 计数回退路径。

绑定操作会在发生变更前校验注册状态、引擎/设备一致性、INDIRECT 用途标志、安全且非负的 4 字节对齐偏移量以及 `offset + 20 <= byteLength`。存储几何体仍必须引用同一设备上的有效顶点/索引分配。替换/解绑会触发所有已订阅场景的常规重建队列并使其渲染包失效。退役旧的合并 Shader 数据包必须立即停止其绘制，而 UBO/纹理的销毁则走常规延迟退役流程。现有的可见性/资源 epoch 同样会使独立拥有的任务包（包括材质覆盖任务）失效。参数替换不需要 `enableRenderTaskMeshRefresh`；该策略仍适用于无关的几何体/材质变更。切换到其他材质系列或启用薄实例前请先解绑。帧编码器处于活动状态时不要修改借用。

普通只读存储在恢复时会从 CPU 影子副本重建其句柄。GPU 角色存储没有 CPU 影子副本；恢复会清除其旧设备句柄，因此所有绑定路径（计算、ShaderMaterial 存储、顶点/索引/间接消费者）都会显式拒绝它。设备丢失后，在替换设备上重新创建顶点、索引和间接分配以及存储网格，重新绑定计算与绘制消费者，并在渲染前重新运行生产者。重新绑定旧的 GPU 角色分配无法使其数据在新设备上有效。

## 渲染与诊断

仅绑定 API 会安装可选的 Shader 绘制/更新解析器。未使用的消费者保留现有的 `drawIndexed(indexCount, 1, firstIndex, baseVertex)`。间接消费者在与直接消费者相同的数据包位置、管线、透明排序、相机和通道中记录 `drawIndexedIndirect(handle, byteOffset)`。纯 GPU 内容可以在不重新录制渲染包的情况下变更；绑定对象身份/偏移量变更会触发重建。CPU 诊断报告物理索引容量以及为 null 的 GPU 索引/实例计数，绝不将容量报告为准入/已提交几何体数。现有的绘制调用计数器统计已记录的绘制命令数，而非非零 GPU 准入数。

## 测试规范与文件

单元测试回归：`tests/lite/unit/mesh-indexed-indirect.test.ts`，覆盖精确范围转发、不写入参数、默认恢复、无效输入、场景失效、调用方所有权、克隆、分离、退役以及恢复拒绝。原生验收测试必须向参数分配中派发计算着色器，并在不读取参数字节或不修改 CPU indexCount 的情况下观察到渲染像素的变化。根 API 声明与 tree-shaking 测试覆盖公共入口与可选边界。

实现位于 `packages/babylon-lite/src/mesh/mesh-indexed-indirect-borrow.ts`（与薄实例路径静态导入的 `mesh-indexed-indirect.ts` ABI 写入器分离）；Shader 解析器边界：`material/shader/shader-renderable.ts`；旧设备拒绝：`resource/storage-buffer-recovery.ts` 与 `resource/storage-buffer.ts`；退役边界：`mesh/mesh-dispose.ts`；场景失效：`scene/mesh-scene-registry.ts`。
