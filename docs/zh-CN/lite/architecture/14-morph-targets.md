# 模块：变形目标（Morph Targets / Blend Shapes）

> 包路径：`packages/babylon-lite/src/`（跨模块：loader、animation、material）

## 用途

变形目标（又称混合形状 / blend shapes）允许在运行时通过逐顶点的位置与法线增量来使网格变形，由 glTF 动画中的权重值驱动。常用于面部动画、口型同步以及其他精细网格变形。权重每帧从 glTF 动画通道中求值并上传到统一缓冲区（UBO）；顶点着色器在骨骼变形之前完成变形增量的混合。

---

## 公共 API 表面

### 变形集合发现与名称

```typescript
interface MorphTargetData {
    readonly count: number;
    readonly targets: readonly { positions: Float32Array; normals: Float32Array | null }[];
    readonly weights: Float32Array<ArrayBuffer>;
    readonly names?: readonly string[];
}

function createMorphTargets(
    engine: EngineContext,
    targets: { positions: Float32Array; normals: Float32Array | null }[],
    vertexCount: number,
    morphWeights: number[] | null,
    names?: readonly string[]
): MorphTargetData;

function setMorphTargetWeights(engine: EngineContext, data: MorphTargetData, weights: ArrayLike<number>): void;
```

枚举 `scene.meshes[*].morphTargets`，由于克隆体共享引用计数数据，因此按对象身份去重。名称与目标及权重按索引对齐：glTF 仅当 `mesh.extras.targetNames` 是一个恰好为每个目标包含一个字符串的数组时才复用它；格式错误或不匹配的资产元数据将被忽略。USD 会转发其目标名称。手工编写的调用方可以传入可选的末尾数组而不做数量校验。名称按引用保留而不进行拷贝。使用 `data.count` 枚举目标，读取 `data.names?.[i]`，并为缺失名称使用基于索引的标签；多余的名称并不代表额外的目标。调用方必须保持索引对齐。

工厂仅在传入了名称时才赋予自身 `names` 属性。因此，恢复机制使用重建后的无名称 GPU 数据执行 `Object.assign` 时，能够保留原始元数据与对象身份。可选的名称引用仅在命名集合上增加存储；源校验与转发仅增加少量的特性相关运行时开销。

对于 `i < data.count` 读取 `data.weights[i]`。编辑时请复制全部权重，修改目标槽位，然后调用 `setMorphTargetWeights(scene.surface.engine, data, copy)`；未提供的槽位将填零。活跃的变形动画可能会每帧覆写权重。最终销毁后的写入将抛出异常。测试覆盖了匹配与不匹配数量的自定义名称、缺失自身属性、有效与格式错误的 glTF 元数据、USD 转发以及恢复式赋值。发现功能不会引入任何着色器或渲染改动。

### 接口

```typescript
/** Morph binding — links a node to its morph target weights buffer. */
export interface MorphBinding {
    nodeIdx: number; // glTF node index this binding belongs to
    targetCount: number; // number of morph targets (max 4)
    weightsBuffer: GPUBuffer; // 32-byte UBO: vec4<f32> weights + u32 count + u32 texWidth + u32 rowsPerBand + u32 pad
}
```

### 已有类型上的数据

```typescript
// GltfAnimationData (animation/types.ts) — extended with:
export interface GltfAnimationData {
    // ...existing fields...
    morphBindings: MorphBinding[]; // alongside skeletons
}

// MeshGPU (mesh/mesh.ts) — extended with morph fields:
interface MeshGPU {
    // ...existing fields...
    morphTexture?: GPUTexture; // rgba32float tiled texture with all deltas
    morphTextureView?: GPUTextureView;
    morphWeightsBuffer?: GPUBuffer; // 32-byte UBO
    morphTargetCount?: number;
}
```

### 特性标志

```typescript
// mesh-features.ts
export const MSH_HAS_MORPH_TARGETS = 1 << 3;
```

---

## 内部架构

### 数据流

```
glTF file
  ↓
load-gltf.ts: parse primitive.targets[]
  ├── Each target has POSITION + NORMAL accessors → Float32Array deltas
  ├── Initial weights from mesh.weights[]
  ├── Pack all deltas into a single rgba32float 2D texture (tiled layout)
  └── Create 32-byte weights UBO with initial values
  ↓
MeshGPU.morphTexture + MeshGPU.morphWeightsBuffer
  ↓
skeleton-updater.ts: per-frame PATH_WEIGHTS evaluation
  └── Writes to first 16 bytes of weights UBO (vec4 weights)
  ↓
pbr-shader.ts: vertex shader blends deltas before skeletal deformation
```

### 分块（Tiled）纹理布局

为了支持顶点数超过 WebGPU 最大纹理尺寸（默认 8192）的网格，变形纹理采用二维分块布局：

| 参数 | 公式 |
| ------------- | ----------------------------------------------------------------------- |
| `texWidth` | `min(vertexCount, 2048)` |
| `rowsPerBand` | `ceil(vertexCount / texWidth)` |
| 条带顺序 | target0-position, target0-normal, target1-position, target1-normal, ... |
| 总高度 | `numTargets × 2 × rowsPerBand` |
| 顶点查找 | `col = v % texWidth`, `row = bandBase + floor(v / texWidth)` |

GPU 格式：`rgba32float`，不可过滤浮点采样类型（`unfilterable-float`，与骨骼纹理方案相同）。

### 权重 UBO 布局 — 32 字节

| 偏移（字节） | 大小 | 内容 |
| -------------- | ---- | ----------------------------------------------------- |
| 0 | 16B | `vec4<f32> weights` — 变形目标权重（最多 4 个） |
| 16 | 4B | `u32 count` — 活跃变形目标数量 |
| 20 | 4B | `u32 texWidth` — 纹理行宽（以纹素计） |
| 24 | 4B | `u32 rowsPerBand` — 每个（目标，属性）条带所占行数 |
| 28 | 4B | `u32 pad` — 填充至 32 字节对齐 |

逐帧更新仅写入前 16 字节（权重）。`count`、`texWidth` 和 `rowsPerBand` 字段在创建后不可变。

---

## 管线配置

### 特性标志作用（`MSH_HAS_MORPH_TARGETS = 1 << 3`）

当设置该标志时：

1. **着色器组合** — 向顶点着色器添加变形结构体定义、变形纹理绑定以及混合代码。
2. **绑定组布局** — 向逐网格绑定组布局添加变形纹理条目（`unfilterable-float`、`2d`）和变形权重 UBO 条目。
3. **绑定组创建** — 将变形纹理视图与变形权重缓冲区添加到逐网格绑定组中。

### 绑定组集成（Group 1 — 逐网格）

| 绑定槽 | 资源 | 条件 |
| ------- | ----------------- | ---------------- |
| 0 | 网格 UBO | 始终存在 |
| 1 | 骨骼纹理 | 若有骨骼 |
| 2 | 变形纹理 | 若有变形目标 |
| 3 | 变形权重 UBO | 若有变形目标 |
| 4+ | 材质纹理 | 紧随其后 |

具体的绑定槽位索引会根据实际存在的可选条目顺延移动。

### NodeMaterial 可选路径

NodeMaterial 将其变形目标实现保留在懒加载触及的 `material/node/node-morph.ts` 特性模块中。内建的 `MorphTargetsBlock` 发射器安装了一个类型化的编译器/绑定接缝，保留 Node 绑定顺序：节点 UBO 与声明纹理在前，变形增量与权重存储缓冲区紧随其后，然后是环境与阴影资源。该特性还拥有当兼容网格没有 `morphTargets` 数据时使用的逐引擎零目标回退分配。由于零计数阻止了任何增量读取，两个变形绑定可以安全地共享同一块包含 `(count=0, vertexCount=1)` 的 24 字节只读存储缓冲区。

`ParseNodeMaterialOptions.blockLoader` 可能会返回一个针对早期纯标志契约编写的自定义发射器。如果该发射器设置了 `NodeBuildState.usesMorphTargets` 而未安装私有特性接缝，`parseNodeMaterialFromSnippet()` 会在编译前动态加载并安装同一变形特性。静态节点图不会执行该导入，也不会保留任何变形 WGSL、绑定构建或回退分配代码。

---

## 着色器逻辑

### WGSL 变形结构体

```wgsl
struct MorphUniforms {
  weights: vec4<f32>,
  count: u32,
  texWidth: u32,
  rowsPerBand: u32,
  pad: u32,
};
```

### 顶点着色器变形混合

在骨骼变形**之前**应用：

```wgsl
var morphedPos = position;
var morphedNorm = normal;
let vid = vertexIndex;  // @builtin(vertex_index) — returns index buffer value
let col = i32(vid % morph.texWidth);
let rowInBand = i32(vid / morph.texWidth);
for (var i = 0u; i < morph.count; i = i + 1u) {
    let w = morph.weights[i];
    let posRow = i32(i * 2u) * i32(morph.rowsPerBand) + rowInBand;
    let normRow = i32(i * 2u + 1u) * i32(morph.rowsPerBand) + rowInBand;
    morphedPos += w * textureLoad(morphTargets, vec2<i32>(col, posRow), 0).xyz;
    morphedNorm += w * textureLoad(morphTargets, vec2<i32>(col, normRow), 0).xyz;
}
// Then proceed with skeletal deformation on morphedPos / morphedNorm
```

**关键细节**：对于索引绘制，`@builtin(vertex_index)` 返回索引缓冲区的值，因此 `vid` 能准确映射到纹理中存储的逐顶点变形增量。

---

## 状态机 / 生命周期

### 初始化（位于 `load-gltf.ts`）

1. 解析 `primitive.targets[]` — 每个目标包含 POSITION 与 NORMAL 访问器
2. 从 `mesh.weights[]` 读取初始权重（默认全零）
3. 计算分块布局：`texWidth`、`rowsPerBand`、总高度
4. 分配 `rgba32float` 二维纹理（`texWidth × totalHeight`）
5. 逐行填充纹理：对每个目标依次写入位置条带和法线条带
6. 创建 32 字节权重 UBO，写入初始权重 + 不可变布局参数
7. 存储到 `MeshGPU`：`morphTexture`、`morphTextureView`、`morphWeightsBuffer`、`morphTargetCount`
8. 为动画系统创建 `MorphBinding` 条目

### 逐帧（位于 `skeleton-updater.ts`）

```
For each PATH_WEIGHTS animation channel:
  1. Evaluate weight sampler at current time → vec4 weights
  2. Look up MorphBinding[] by nodeIdx
  3. Write first 16 bytes of weightsBuffer (vec4 weights only)
```

### 渲染（位于 `pbr-shader.ts` 顶点阶段）

```
1. Read morphedPos = base position
2. Read morphedNorm = base normal
3. For each active morph target (i < count):
   a. Compute texture coordinates from vertex_index + tiled layout
   b. textureLoad position delta, accumulate weighted
   c. textureLoad normal delta, accumulate weighted
4. Pass morphedPos/morphedNorm to skeletal deformation (if any)
5. Continue with standard vertex transform
```

---

## Babylon.js 等价映射表

| Babylon Lite | Babylon.js |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `MorphBinding` 接口 | `MorphTargetManager` 类 |
| `morphTexture`（rgba32float 分块纹理） | `MorphTargetManager._textureFloat` |
| `morphWeightsBuffer`（32B UBO） | `MorphTargetManager._influences` uniform |
| 顶点着色器 `textureLoad` 循环 | `morphTargets.vertex.fx` 着色器包含片段 |
| `MSH_HAS_MORPH_TARGETS` 标志 | 着色器宏定义 `#define MORPHTARGETS` |
| `skeleton-updater.ts` 中的 PATH_WEIGHTS | `Animation.AllowMatricesInterpolation` + `MorphTargetManager.getTarget().influence` |
| 最多 4 个目标（vec4 权重） | 可通过 `MorphTargetManager.numTargets` 配置 |
| 扁平数据 + 函数 | 完整的类继承体系（`MorphTarget`、`MorphTargetManager`） |

**相同的数学逻辑，极简的代码。** 没有类继承体系——只有一张纹理、一个 UBO 和一段着色器循环。

---

## 依赖项

- WebGPU `rgba32float` 纹理支持（`unfilterable-float`）
- WGSL 中的 `@builtin(vertex_index)`（在索引绘制中返回索引缓冲区值）
- 现有的骨骼纹理模式（相同的不可过滤浮点方案、相同的绑定组槽位策略）
- glTF 2.0 变形目标规范（`primitive.targets[]`、`mesh.weights[]`）

---

## 测试规范

| 测试 | 描述 |
| -------------------- | ------------------------------------------------------------------------------ |
| 分块布局数学 | `vertexCount=5000, texWidth=2048, rowsPerBand=3` — 验证维度 |
| 纹理尺寸 | 2 个目标、5000 个顶点 → width=2048、height=2×2×3=12 |
| 顶点查找 | 顶点 4097 → col=1, rowInBand=2（对于 texWidth=2048） |
| 条带排序 | 目标 1 的法线条带起始行位于 `(1×2+1)×rowsPerBand` |
| UBO 布局 | 总计 32 字节：16B weights + 4B count + 4B texWidth + 4B rowsPerBand + 4B pad |
| 初始权重 | `mesh.weights = [0.5, 0.3]` → UBO 字节 0–15 包含 `[0.5, 0.3, 0, 0]` |
| 不可变字段 | 逐帧更新仅写入前 16 字节，不修改 count/texWidth/rowsPerBand |
| 特性标志 | `MSH_HAS_MORPH_TARGETS = 1 << 3 = 8` |
| 纯变形动画 | 仅有 PATH_WEIGHTS 而无骨骼的动画正常播放 |
| 最大目标数 | glTF 中超过 4 个目标 → 仅使用前 4 个 |

---

## 文件清单

| 文件 | 职责 |
| ------------------------------------ | ------------------------------------------------------------------- |
| `src/animation/types.ts` | `MorphBinding` 接口定义 |
| `src/mesh/mesh.ts` | `MeshGPU` 变形字段（`morphTexture`、`morphWeightsBuffer` 等） |
| `src/loader-gltf/load-gltf.ts` | 解析 `primitive.targets[]`，创建分块纹理 + 权重 UBO |
| `src/animation/skeleton-updater.ts` | `PATH_WEIGHTS` 求值、逐帧权重上传 |
| `src/animation/animation-group.ts` | 纯变形动画支持（无需骨骼） |
| `src/material/pbr/pbr-shader.ts` | 顶点着色器中的变形混合、特性标志、WGSL 生成 |
| `src/material/pbr/pbr-pipeline.ts` | 绑定组布局与绑定组中的变形条目 |
| `src/material/pbr/pbr-renderable.ts` | 可渲染对象创建期间的变形检测与接线 |

---

## 限制

- **每个网格最多 4 个变形目标** — 受限于 UBO 中的 `vec4<f32>` 权重。
- **仅支持 POSITION 与 NORMAL 增量** — 忽略 glTF 中的 TANGENT 增量。
- **仅限 PBR 管线** — Standard 材质管线不支持变形目标。
