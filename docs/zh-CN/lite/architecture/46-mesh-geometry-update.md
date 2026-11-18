# 模块：原地网格几何体更新

> 包路径：`packages/babylon-lite/src/mesh/mesh-factories.ts`

## 用途

在现有紧凑打包（tightly-packed）的程序化网格保持顶点/索引数量与属性布局不变的前提下，更新其每个属性和索引数据。GPU 缓冲区标识保持稳定，因此缓存的渲染和阴影 bundle 依然有效。CPU 几何体、包围盒、精细拾取（detailed picking）以及设备丢失恢复（device-loss recovery）会与 GPU 内容原子性地同步更新。

拓扑扩容或缩容可使用以下方式之一：`resizeMeshGeometry`（替换为精确大小的缓冲区并安全地使缓存 bundle 失效）、`resizeSharedMeshGeometry`（执行一次上传并让整个克隆族系共享同一个引用计数的几何体对象），或 `updateMeshGeometryCapacity`（预留只增不减的容量，并将未激活的索引尾部保持为退化三角形，使实时程序化编辑保持稳定的缓冲区标识和绘制拓扑）。

## 公共 API 接口

### 精确有效绘制范围（可选启用）

```ts
export interface MeshDrawRange {
    readonly vertices: MeshGeometryRange;
    readonly indices: MeshGeometryRange;
}
export function setMeshDrawRange(engine: EngineContext, mesh: Mesh, range: MeshDrawRange): void;
```

`setMeshDrawRange` 用于在自有的、未共享的、紧凑打包的 uint32 缓冲区中选择已初始化并保留的几何体范围。它不会上传、分配、退役或替换 GPU 缓冲区。偏移量和计数均以元素为单位，而非字节：`indices.offset` 为 WebGPU 的 `firstIndex`，`indices.count` 为精确的 `drawIndexed` 计数，`vertices.offset` 为 `baseVertex`。所选索引必须相对于所选顶点窗口（`0 <= index < vertices.count`）。两个范围都必须是显式、有限、非负的整数，且位于保留的源数据长度和物理容量之内；`baseVertex` 必须能容纳于 int32。计数为零是有效的；非空索引要求非空顶点。计数不必是 3 的倍数，因此点列表（point-list）和线列表（line-list）材质也可使用同一个 API。网格几何体始终是有索引的，包括点列表在内；此 API 不引入非索引网格。非索引程序化绘制仍属于独立的 RenderDraw API。

CPU 快照和精细拾取仅使用所选顶点和索引的视图，并采用局部索引编号。包围盒仅覆盖所选顶点窗口，绝不覆盖未激活的源数据尾部。空索引范围没有包围盒，且会被排除在 CPU 射线拾取之外。`pickWithRay` 仍为 AABB 测试，而非三角形/点相交测试。三角形精确拾取仍保留其仅限三角形的契约；点/线材质可以改用 AABB 拾取或调用方谓词。更改范围会刷新 CPU 位置数组标识、将投射器（caster）包围盒标记为脏，并使主通道/深度/阴影渲染 bundle 失效，同时不改变世界变换。重复相同的选择是空操作（no-op）。GPU 拾取、材质几何体通道、thin-instance 直接绘制以及引擎管理的间接索引绘制参数都会使用相同的精确范围。

精细 GPU 拾取在异步回读后，会在常规路径和高级路径中验证其绘制时的 CPU 几何体视图。如果在精细拾取挂起期间更改有效范围，该结果会失效（返回空拾取），而不会将旧图元与新索引或新 UV 混用。随后的拾取将使用新范围；不需要自动重试或复制几何体。

完整的源数据数组会独立于所选 CPU 视图而保留，从而允许在不重新上传的情况下重新扩容选择。设备丢失恢复会恢复完整已初始化的源数据以及所选范围；未使用的预留容量可能会像现有容量更新一样被收缩。克隆会共享所选几何体，并在几何体解除共享之前禁止后续范围变更。几何体替换（`updateMeshGeometry`、容量更新或调整大小）会清除当前选择，恢复该 API 原有的完整几何体契约，并使捕获了该选择的命令失效。`updateMeshGeometry` 要求完整的已初始化源数据长度，而非选定快照的长度；容量更新和调整大小可以用不同长度替换该完整源数据。与之前一样，仅 GPU 侧的属性写入不会刷新 CPU 几何体。骨骼、变形目标（morph）和 VAT 网格会被拒绝：它们的变形/拾取缓冲区具有单独的顶点寻址契约。

示例（一次初始上传，后续精确提交）：

```ts
const mesh = createMeshFromData(engine, "card", positions, normals, indices);
setMeshDrawRange(engine, mesh, { vertices: { offset: 0, count: 3 }, indices: { offset: 0, count: 3 } });
setMeshDrawRange(engine, mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 6 } });
setMeshDrawRange(engine, mesh, { vertices: { offset: 0, count: 0 }, indices: { offset: 0, count: 0 } });
```

遗留的 `updateMeshGeometryCapacity` 调用方除非在之后显式选择精确范围，否则仍保留其填充三角形列表（padded triangle-list）的行为。范围选择受已初始化 CPU 源数据长度的约束，而不仅仅是备用分配空间：未初始化的预留尾部不能被设为可见。

```ts
export function updateMeshGeometry(
    engine: EngineContext,
    mesh: Mesh,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array
): void;

export interface MeshGeometryCapacityResult {
    readonly stable: boolean;
    readonly vertexCapacity: number;
    readonly indexCapacity: number;
}

export function updateMeshGeometryCapacity(
    engine: EngineContext,
    mesh: Mesh,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array,
    reserveFactor?: number
): MeshGeometryCapacityResult;

export function resizeSharedMeshGeometry(
    engine: EngineContext,
    meshes: readonly Mesh[],
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array
): void;
```

`resizeSharedMeshGeometry` 要求提供一个非空、密集且互不相同的存活网格列表，这些网格共享同一份自有的、紧凑打包的 GPU 几何体。它会在分配缓冲区或修改引用计数之前拒绝重复、已销毁、缺失或属于不同几何体的条目。该列表可以只选择克隆族系的一部分；被省略的所有者保留旧的分配。

现有的单属性更新辅助函数也接受可选的源/目标顶点范围：

```ts
export function updateMeshPositions(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshNormals(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshColors(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshUvs(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshUv2(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshTangents(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
```

这些辅助函数直接将原始 `ArrayBuffer` 加上字节偏移量/长度传递给 `GPUQueue.writeBuffer`；它们绝不分配 `subarray`。无效的紧凑打包范围会在任何 GPU 或影子状态更改之前抛出异常，而有效的空范围则是空操作。

网格必须源自 `createMeshFromData` 或使用相同紧凑缓冲区布局的工厂函数。替换数组必须与当前几何体具有相同的长度和可选属性存在性。交错加载器（interleaved loader）几何体和共享克隆几何体会被拒绝。当任何计数或布局不同时，请使用 `resizeMeshGeometry`。

`updateMeshGeometryCapacity` 允许在非实例化网格上更改顶点/索引数量，但不允许更改可选属性的存在性。索引必须描述一个三角形列表（3 的倍数）。`reserveFactor` 默认为 `1.25`，必须为有限值且至少为 `1`。首次使用时，当前缓冲区长度为最小容量。扩容会将每个所需容量按该因子向上取整；缩容绝不重新分配。返回值报告此次调用是否保留了当前缓冲区以及当前有效容量。空的可选数组仍保持缺失状态，而不会在扩容期间启用新的顶点属性。

## 内部架构

`updateMeshGeometry` 在发出写入之前会校验所有输入。然后，它使用 `GPUQueue.writeBuffer` 写入现有的位置、法线、索引、UV、UV2、切线和颜色缓冲区。它不会分配、替换、退役或暴露任何 GPU 资源。

GPU 写入完成后，网格保留的 CPU 数组会被替换，其 AABB 会根据新位置重新计算，设备丢失恢复捕获记录也会接收新的可选数组和索引数据。GPU thin-instance 剔除会观察到替换后的 CPU/包围盒引用，并在不替换绘制缓冲区的情况下刷新其局部剔除球体。几何体写入仅递增所属网格的内部世界版本，因此缓存的 ESM、PCF 和 CSM 阴影贴图仅在其实际投射器发生更改时才重绘，并且除非完整更新清除了显式绘制选择，否则不会替换渲染 bundle。几何体变更和绘制范围选择会拒绝克隆共享几何体，因为单个网格不能使所有别名引用同一 GPU 缓冲区的兄弟网格失效。

容量路径在 `MeshGPU` 上存储内部顶点/索引容量以及一个可复用的填充索引数组。扩容会分配填充的类型化数组并复制有效值。容量内更新会将未激活尾部清零后，写入有效属性前缀以及完整的填充索引数组。主通道、阴影、拾取和 thin-instance 路径保持其常规的直接绘制命令；预留尾部仅由退化三角形组成。保留的 Mesh CPU 数组始终保持为精确的有效数组，绝不包含填充预留部分。

在没有显式绘制选择的情况下，设备丢失恢复会从这些精确保留的数组重建，并折叠消除任何预留空间。如果有效几何体随后超出恢复后的缓冲区，下一次容量更新会重新建立只增不减的容量。

`setMeshDrawRange` 将完整的已初始化源数组保留在内部 `MeshGPU._drawRangeSource` 中，独立于所选 CPU 视图。该状态还拥有可变的当前有效索引计数。现有的公共 `MeshGPU.indexCount` 保持只读：启用器会在该计数上安装一个 getter，当完整几何体更新清除选择时，回退到原始预留计数。普通几何体保留其原有的数值计数属性，不会安装该访问器。首索引（first-index）和基顶点（base-vertex）偏移量与物理缓冲区容量分开存储。

选择操作在更改状态之前会校验两个范围、WebGPU 限制、所有权、变形状态、每个已上传可选属性的保留存在性/完整源长度，以及每个所选索引。它会创建属性/索引的 subarray 视图，根据所选位置重新计算包围盒，将所属网格的世界修订版标记为脏，并在不进行 GPU 写入或分配的情况下使缓存 bundle 失效。空索引范围没有 AABB，也无法被射线拾取。CPU 快照会复制所选视图；精确拾取仅访问所选三角形。当提供 UV2 和颜色源数组时，几何体会将其保留，以便每个已上传的可选属性都能被选择和恢复。创建捕获接缝接收原始可选数组；其现有实现负责将缺失属性规范化为 `null`，而无需在通用工厂中重复该工作。

恢复操作上传的是完整的已初始化源数据，而非所选视图，并恢复有效计数和偏移量。它会为独立重建的几何体复制选择状态，从而使其计数不会发生别名冲突。未使用的预留空间可能会折叠为已初始化源长度；选择仍可在该源数据范围内重新扩容。完整更新和调整大小操作会清除显式选择，并恢复到其文档化的遗留绘制行为。

## 管线配置

当更新保持在容量范围内时，缓冲区标识、顶点布局、索引格式、材质、管线和 bind group 均保持不变。普通的同缓冲区几何体写入不会使 bundle 失效。容量扩容会一次性替换缓冲区，并通过现有的调整大小生命周期使 bundle 失效。

显式绘制选择更改的是绘制参数，而非管线状态。直接索引绘制通过 Standard、PBR 和 Node 材质、ShaderMaterial 及其 thin-instance 路径、GPU 拾取、高级拾取以及调试线绘制的常规与几何体可渲染对象，转发 `indexCount`、实例计数、`firstIndex`（默认为零）和 `baseVertex`。几何体可渲染对象还服务于深度和阴影通道。间接索引绘制（indexed-indirect）ABI 为五个 uint32 字：索引计数、实例计数、首索引、有符号基顶点和首实例。当计数或任一偏移量发生变化时，缓存的 thin-instance、GPU 剔除和 LOD 参数会同步刷新。当选择发生变化或完整更新将其清除时，即使缓冲区标识和计数在其他方面保持不变，也必须使 bundle 失效。

## 着色器逻辑

无。着色器在相同的位置和格式下消费相同的属性。

## 状态机 / 生命周期

1. 使用 `createMeshFromData` 创建一个紧凑的程序化网格。
2. 对于同布局编辑，调用 `updateMeshGeometry`。
3. 对于属性存在性稳定的反复实时拓扑更改，调用 `updateMeshGeometryCapacity`。
4. 对于一次性的精确大小拓扑或可选属性布局更改，调用 `resizeMeshGeometry`。
5. 当所有传入的克隆体都必须继续共享同一份重建后的分配时，调用 `resizeSharedMeshGeometry`。
6. 基于存储缓冲区（storage-backed）/交错（interleaved）/借用（borrowed）的几何体会拒绝这些紧凑打包变更 API；请改为更新其源 `StorageBuffer`。
7. 后续的拾取和设备丢失恢复会观察到最新的完整有效几何体。
8. 可选地使用 `setMeshDrawRange` 选择已初始化几何体，包括零计数和奇数点列表计数。后续选择会复用完整保留的源数据。完整更新会清除选择；恢复操作会保留选择。

校验会在发生任何变更之前抛出异常，因此失败的调用不会改变 CPU/GPU 状态。

## Babylon.js 等价映射

几何体写入对应于更新 Babylon.js 的顶点/索引缓冲区并刷新包围信息。精确绘制选择对应于在不更改缓冲区内容的情况下选择索引子网格（submesh）窗口，使用显式的首索引和基顶点偏移量，而非填充或退化索引。

## 依赖项

- `EngineContext`：用于内部 GPU 队列和可选的设备丢失捕获。
- `Mesh`：用于现有的不透明 GPU 缓冲区和保留的 CPU 几何体。
- `computeAabb`：用于刷新包围盒。

## 测试规范

- 拒绝 `updateMeshGeometry` 中发生变化的顶点或索引计数。
- 拒绝可选属性存在性/长度的变化。
- 拒绝交错或共享克隆几何体。
- 在执行任何上传或所有权变更之前，拒绝重复、已销毁或缺失的共享调整大小所有者。
- 确认共享调整大小的子集调用会使被省略的克隆所有者保留在原有的存活分配上。
- 拒绝容量路径上的无效容量因子以及可选属性存在性的变化。
- 确认同大小更新保持每个 GPU 缓冲区标识不变。
- 确认容量内的缩容/扩容保持每个 GPU 缓冲区标识和 GPU 绘制索引容量不变。
- 确认缩容/扩容会将预留索引尾部清零，以便直接绘制仅产生有效三角形。
- 确认容量溢出时仅扩容一次、报告 `stable:false`，并至少按请求的因子预留容量。
- 确认保留的 CPU 数组、AABB、拾取和设备丢失恢复使用替换后的数据。
- 确认 GPU 剔除和 CSM 包围盒缓存在同缓冲区几何体更新后刷新。
- 确认静态阴影任务在几何体修订版更改后重绘。
- 确认精确选择能够以独立的顶点/索引偏移量提交 0、3、6 以及奇数点计数。
- 在发生变更之前拒绝小数、负数、非有限数、溢出、超出源范围的值以及超出窗口的索引值。
- 拒绝借用的、已销毁的、交错的、共享的、非 uint32 的、变形的或缺失保留几何体的网格。
- 在 CPU/GPU 状态或 bundle 版本更改之前，拒绝缺失或过小的保留 UV、UV2、切线或颜色数组。
- 确认范围更改不会分配/上传 GPU 几何体并保留缓冲区标识。
- 确认选定 CPU 快照为独立副本、所有可选属性均被选择、未激活三角形无法被拾取、选定顶点窗口决定包围盒，且空索引范围没有包围盒。
- 确认空操作选择保留 bundle 版本，而更改的选择和完整更新重置会使 bundle 失效。
- 确认直接材质路径转发有效计数和两个偏移量，且间接路径保留五字 ABI，包括计数不变时的偏移量更改和遗留零默认值。
- 确认恢复操作上传完整源数据、保留空/非空选择、允许源数据范围内重新扩容，并隔离独立恢复克隆体的状态。
- 确认发布的计数声明保持只读，且根级绘制范围 API 为增量添加。
- 针对 ShaderMaterial、Standard 和 PBR，验证实际的原生 WebGPU 提交、bundle 执行、稳定资源以及无 GPU 校验错误。
- 由于渲染数学和管线状态均未改变，现有视觉一致性（visual parity）保持不变。

## 文件清单

- `packages/babylon-lite/src/mesh/mesh-factories.ts`：实现。
- `packages/babylon-lite/src/mesh/mesh.ts`：不透明计数、偏移量、源数据与容量状态。
- `packages/babylon-lite/src/mesh/mesh-draw-range-state.ts`：可选启用的只读计数访问器。
- `packages/babylon-lite/src/mesh/get-mesh-geometry.ts`：独立的有效 CPU 快照。
- `packages/babylon-lite/src/mesh/mesh-indexed-indirect.ts`：间接索引绘制 ABI。
- `packages/babylon-lite/src/mesh/thin-instance-gpu.ts`：缓存间接参数同步。
- `packages/babylon-lite/src/mesh/thin-instance-gpu-culling.ts`：GPU 剔除和 LOD 参数同步。
- `packages/babylon-lite/src/mesh/thin-instance-cull-binding.ts`：直接剔除回退绘制。
- `packages/babylon-lite/src/engine/recovery-rebuild.ts`：完整源上传与选择恢复。
- `packages/babylon-lite/src/material/{standard,pbr,node}/*-renderable.ts`：常规与几何体绘制参数。
- `packages/babylon-lite/src/material/shader/{shader-renderable,shader-thin-instance}.ts`：ShaderMaterial 绘制参数。
- `packages/babylon-lite/src/picking/{ray-pick,gpu-picker,picking-advanced-draw}.ts`：选定/空范围拾取语义。
- `packages/babylon-lite/src/physics/physics-debug-line-material.ts`：调试线绘制参数。
- `packages/babylon-lite/src/index.ts`：公共导出。
- `tests/lite/unit/{mesh-draw-range,base-vertex-draw-paths,shader-vb-module-isolation}.test.ts`：范围与直接路径契约。
- `tests/lite/unit/mesh-geometry-update.test.ts`：未改变的遗留更新/容量行为。
- `tests/lite/unit/get-mesh-geometry.test.ts`：CPU 快照与可选属性行为。
- `tests/lite/unit/{thin-instance-gpu,thin-instance-gpu-culling}.test.ts`：间接/剔除偏移量同步。
- `tests/lite/build/public-api-types.test.ts`：只读公共声明与根导出。
- `tests/lite/plumbing/mesh-draw-range.spec.ts`：原生 WebGPU 计数、偏移量、资源与 bundle 一致性。
- `lab/lite/{mesh-draw-range-test.html,src/mesh-draw-range-test.ts}`：通用卡片/点一致性测试夹具。
- `docs/lite/architecture/48-mesh-geometry-access.md`：选定 CPU 快照契约。
