# 模块：核心数学（Core Math）

> 包路径：`packages/babylon-lite/src/math/`

## 目的

核心数学模块提供整个 Babylon Lite 中使用的数学类型和独立函数。类型为用于面向数据的 GPU 缓冲区打包的纯接口。分配内存的操作返回新值；`ToRef`、`InPlace` 和缓冲区写入器则就地修改调用者持有的目标对象。该模块使用 **Babylon.js 左手坐标系**以及与 WebGPU/WGSL `mat4x4<f32>` 内存布局匹配的**列主序矩阵**。

## 公共 API 接口

### 类型（`types.ts`）

```typescript
/** 3-component vector (position, direction, color) */
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** 4-component vector (homogeneous coords, quaternion, tangent) */
export interface Vec4 {
    x: number;
    y: number;
    z: number;
    w: number;
}

/** RGB color */
export interface Color3 {
    r: number;
    g: number;
    b: number;
}

/** RGBA color */
export interface Color4 {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** 4x4 column-major matrix (16 elements). Opaque-by-convention: the
 *  underlying storage is `Float32Array` (default) or `Float64Array`
 *  (after an HPM engine is created — see `36-high-precision-matrix.md`).
 *  Layout matches WebGPU/WGSL mat4x4<f32> memory order. */
export interface Mat4 {
    readonly __brand: "Mat4";
    readonly length: 16;
    readonly [index: number]: number;
}

/** @internal Writable backing for Mat4 used by kernels and the GPU packer.
 *  Raw typed-array union (no brand). Not re-exported from the public root API. */
export type Mat4Storage = Float32Array | Float64Array;

/** Quaternion rotation */
export interface Quat {
    x: number;
    y: number;
    z: number;
    w: number;
}
```

### 标量函数

```typescript
export function inverseLerp(a: number, b: number, value: number): number;
```

[有界逆线性插值契约](inverse-lerp.md)定义了端点顺序、饱和、退化区间和兼容性转发规则。

### Vec3 函数（`vec3.ts`）

```typescript
// --- Constructors ---
export function vec3(x: number, y: number, z: number): Vec3;

export const Vec3Up: Readonly<Vec3>; // { x: 0, y: 1, z: 0 }

// --- Arithmetic (all return new objects — no mutation) ---
export function addVec3(a: Vec3, b: Vec3): Vec3;
export function subtractVec3(a: Vec3, b: Vec3): Vec3;
export function scaleVec3(v: Vec3, s: number): Vec3;
export function dotVec3(a: Vec3, b: Vec3): number;
export function crossVec3(a: Vec3, b: Vec3): Vec3;
export function lengthVec3(v: Vec3): number;
export function normalizeVec3(v: Vec3): Vec3;
export function normalizeVec3TupleOrUp(x: number, y: number, z: number, epsilon?: number): Vec3Tuple;
export function negateVec3(v: Vec3): Vec3;
export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3;

/** Write Vec3 into a Float32Array at the given element offset (for uniform buffers). */
export function writeVec3(out: Float32Array, offset: number, v: Vec3): void;
```

### Mat4 函数（`mat4.ts`）

```typescript
/** Create a new identity Mat4. */
export function createIdentityMat4(): Mat4;

/** Multiply two Mat4: out = a * b (column-major). */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4;

/** LookAt matrix (left-handed). */
export function createLookAtMat4LH(eye: Vec3, target: Vec3, up: Vec3): Mat4;

/** Camera-to-world matrix for an eye looking at `target` — the inverse of `createLookAtMat4LH`,
 *  written in place. Used by every camera factory for its local world matrix. */
export function writeLookAtWorldMat4LHIntoBuffer(out: Mat4Storage, eye: Vec3, target: Vec3, up: Vec3): void;

/** Perspective projection (left-handed, zero-to-one depth). */
export function createPerspectiveMat4LH(fov: number, aspect: number, near: number, far: number): Mat4;

/** Compute inverse of a Mat4. Returns null if singular. */
export function invertMat4(m: Mat4): Mat4 | null;

/** Create a scaling matrix. */
export function createScalingMat4(x: number, y: number, z: number): Mat4;

/** Create a translation matrix. */
export function createTranslationMat4(x: number, y: number, z: number): Mat4;

/** Create a rotation matrix from a quaternion. */
export function createMat4FromQuat(qx: number, qy: number, qz: number, qw: number): Mat4;

/** Write a rotation matrix from a quaternion into an existing matrix buffer. */
export function writeMat4FromQuatIntoBuffer<T extends Float32Array | Float64Array>(out: T, qx: number, qy: number, qz: number, qw: number): T;

/** Compose TRS (translation * rotation * scale) into a single Mat4. */
export function composeMat4(tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number): Mat4;

/** Decompose a column-major affine Mat4 into translation/rotation(quaternion)/scale.
 *  Shared by setParent(), the gizmo/Gaussian-splat rotation extraction, and the Havok
 *  compound-shape path. **Behaviour change:** earlier versions always returned a
 *  non-negative scale and silently dropped the reflection of a mirrored matrix;
 *  `scale.y` is now negative for one, so callers assuming non-negative components
 *  must take `Math.abs` themselves. Mirrored matrices are preserved by folding the
 *  reflection onto a negative Y scale, matching Babylon.js `Matrix.decompose` —
 *  lossless, but canonical rather than sign-faithful (a negative X scale comes back
 *  as negative Y + a different rotation). Assumes a shear-free TRS matrix; a
 *  degenerate axis (scale below 1e-8) yields a finite but meaningless rotation
 *  rather than an error. */
export function decomposeMat4(m: Mat4): { translation: Vec3; rotation: Quat; scale: Vec3 };

/** Unit quaternion from the rotation part of a column-major Mat4 (Babylon.js
 *  `Quaternion.FromRotationMatrix`). The upper-left 3×3 must be a pure rotation. */
export function createQuatFromRotationMat4(matrix: Mat4): Quat;

/** Unit quaternion orienting local +Z onto `forward` and +Y onto `up`, right-handed
 *  (`right = up × forward`); Babylon.js `Quaternion.FromLookDirectionRH`. Inputs are
 *  orthonormalized, so non-unit / slightly non-orthogonal vectors still give a pure rotation. */
export function createQuatFromLookDirectionRH(forward: Vec3, up: Vec3): Quat;
```

### 颜色函数（`color.ts`）

```typescript
export function linearToSrgbByte(v: number): number;
export function srgbByteToLinear(b: number): number;
export function packedSrgbToLinearRgba(packed: number, alpha?: number): readonly [number, number, number, number];
```

### 汇总导出（`index.ts`）

内部数学汇总导出（`math/index.ts`）聚合了常用的数学函数，包括内部辅助函数如 `Mat4Storage`、`writePerspectiveMat4LHIntoBuffer`、`packMat4IntoF32` 和 `shToPolynomial`。
公共根 API 导出了公共安全子集：向量/矩阵构造函数与运算、AABB 辅助函数、颜色转换辅助函数以及公共数学类型。
两个汇总导出均使用 `normalizeVec3(v)` 处理对象，使用 `normalizeVec3TupleOrUp(x, y, z, epsilon?)` 处理标量输入并返回元组结果。对象归一化（包括使用默认设置的 `ToRef` 和 `InPlace`）在长度小于或等于 `1e-10` 时返回零。元组辅助函数则刻意保留其 `[0, 1, 0]` 回退值。

### 破坏性数学 API 迁移

请从 `@babylonjs/lite` 导入公共 API，而非内部数学路径。旧名称已被移除，不再作为兼容别名保留。

| 旧 API | 替代 API |
| --- | --- |
| `normalizeVec3Object(v)` | `normalizeVec3(v)` |
| `normalizeVec3(x, y, z, epsilon?)` | `normalizeVec3TupleOrUp(x, y, z, epsilon?)` |
| `subVec3`、`subVec3ToRef`、`subVec3InPlace` | `subtractVec3`、`subtractVec3ToRef`、`subtractVec3InPlace` |
| `mat4Identity` | `createIdentityMat4` |
| `mat4Translation` | `createTranslationMat4` |
| `mat4Scale` | `createScalingMat4` |
| `mat4LookAtLH` | `createLookAtMat4LH` |
| `mat4PerspectiveLH` | `createPerspectiveMat4LH` |
| `mat4Compose`、`mat4Decompose` | `composeMat4`、`decomposeMat4` |
| `mat4Multiply`、`mat4Invert` | `multiplyMat4`、`invertMat4` |
| `mat4FromQuat` | `createMat4FromQuat` |
| `mat4FromQuatInto` | `writeMat4FromQuatIntoBuffer` |
| `quatFromRotationMatrix` | `createQuatFromRotationMat4` |
| `quatFromLookDirectionRH` | `createQuatFromLookDirectionRH` |
| `eulerToQuat` | `eulerXYZToQuatTuple` |
| `quatToEulerXYZ` | `quatToEulerXYZTuple` |

四元数转换保留标量输入和元组结果。`createMat4FromQuat` 保留四个标量输入。缓冲区内核保留目标参数在前的调用方式，直接操作 F32/F64 存储；矩阵构造函数继续使用配置的分配器。此前名为 `ToRef` 的内部矩阵写入器现显式使用 `IntoBuffer`，不提供包装器，也不更改参数顺序。

`maximizeMat4InPlace` 既接受分配器持有的 `Mat4` 值，也接受现有的原始缓冲区调用者，直接返回同一目标而不进行拷贝或降低 F64 精度。`scaleBoundsFromCenterToRef` 现返回 `void`；请读取其两个输出向量，而非依赖分配的返回包装对象。

公共 `ToRef` 的输入参数位于目标参数和可选设置之前。`InPlace` 会就地修改其第一个参数。不会仅仅为了形式统一而引入额外的内存分配变体或对象适配器。Bundle 中立性必须在迁移前后针对相同的重点生产场景进行测量，使用运行时加载的字节数，而不仅仅是检查体积上限。

## 内部架构

### Mat4 内存布局（列主序）

```
Index:  [0]  [4]  [8]  [12]
        [1]  [5]  [9]  [13]
        [2]  [6]  [10] [14]
        [3]  [7]  [11] [15]

Column:  0    1    2    3

Logical matrix:
  | m[0]  m[4]  m[8]   m[12] |
  | m[1]  m[5]  m[9]   m[13] |
  | m[2]  m[6]  m[10]  m[14] |
  | m[3]  m[7]  m[11]  m[15] |
```

这与按列连续存储的 WGSL `mat4x4<f32>` 一致。`Mat4` 值通过单一打包辅助函数 `packMat4IntoF32`（参见 `36-high-precision-matrix.md`）写入 GPU uniform 缓冲区 —— 绝不直接通过 `Float32Array.set(mat)` 写入，因为在启用 HPM 时底层存储可能是 `Float64Array`，必须在上传边界进行向下类型转换。

### 品牌化不透明类型

`Mat4` 是一个不透明接口，而非类型化数组：

```typescript
export interface Mat4 {
    readonly __brand: "Mat4";
    readonly length: 16;
    readonly [index: number]: number;
}
```

这可防止调用者在预期 `Mat4` 的地方传入原始 `Float32Array`（或长度错误的数组、任意缓冲区）——他们必须通过 `as unknown as Mat4` 进行转换，从而表明明确意图。`readonly` 索引器还可防止对引擎返回的矩阵进行意外写入。

内部内核（`multiplyMat4`、`invertMat4`、`packMat4IntoF32`、分配器）操作的是 `Mat4Storage = Float32Array | Float64Array` —— 一个无品牌标记的原始类型化数组联合类型，以便内核自由写入。这两种类型描述同一块内存；在信任边界处通过 `as unknown as Mat4Storage` / `as unknown as Mat4` 进行转换。

新矩阵通过 `_matrix-allocator.ts` 中的 `allocateMat4()` 分配，默认返回 `Float32Array(16)`，在页面上启用 `useHighPrecisionMatrix: true` 后返回 `Float64Array(16)`（参见 `36-high-precision-matrix.md`）。

## 着色器逻辑（精确数学公式）

### Vec3 运算

| 函数 | 公式 |
| ------------------------ | ---------------------------------------------------------------------- |
| `addVec3(a, b)` | `{ x: a.x+b.x, y: a.y+b.y, z: a.z+b.z }` |
| `subtractVec3(a, b)` | `{ x: a.x-b.x, y: a.y-b.y, z: a.z-b.z }` |
| `scaleVec3(v, s)` | `{ x: v.x*s, y: v.y*s, z: v.z*s }` |
| `dotVec3(a, b)` | `a.x*b.x + a.y*b.y + a.z*b.z` |
| `crossVec3(a, b)` | `{ x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x }` |
| `lengthVec3(v)` | `√(v.x² + v.y² + v.z²)` |
| `normalizeVec3(v)` | `v * (1/length)`，若 `length <= 1e-10` 则返回零向量 |
| `negateVec3(v)` | `{ x: -v.x, y: -v.y, z: -v.z }` |
| `lerpVec3(a, b, t)` | `{ x: a.x+(b.x-a.x)*t, y: a.y+(b.y-a.y)*t, z: a.z+(b.z-a.z)*t }` |
| `writeVec3(out, off, v)` | `out[off]=v.x; out[off+1]=v.y; out[off+2]=v.z` |

### multiplyMat4(a, b)

标准列主序 4×4 矩阵乘法：

```
for col in 0..3:
  for row in 0..3:
    out[col*4+row] = a[row]*b[col*4] + a[4+row]*b[col*4+1] + a[8+row]*b[col*4+2] + a[12+row]*b[col*4+3]
```

### createLookAtMat4LH(eye, target, up)

左手系观察矩阵（look-at）：

```
zAxis = normalize(target - eye)     // forward (into screen in LH)
xAxis = normalize(cross(up, zAxis)) // right
yAxis = cross(zAxis, xAxis)         // true up

out = | xAxis.x  xAxis.y  xAxis.z  -dot(xAxis, eye) |
      | yAxis.x  yAxis.y  yAxis.z  -dot(yAxis, eye) |
      | zAxis.x  zAxis.y  zAxis.z  -dot(zAxis, eye) |
      | 0        0        0         1                |
```

列主序存储：

```
out[0]=xAxis.x  out[4]=xAxis.y  out[8]=xAxis.z   out[12]=-dot(xAxis,eye)
out[1]=yAxis.x  out[5]=yAxis.y  out[9]=yAxis.z   out[13]=-dot(yAxis,eye)
out[2]=zAxis.x  out[6]=zAxis.y  out[10]=zAxis.z  out[14]=-dot(zAxis,eye)
out[3]=0        out[7]=0        out[11]=0         out[15]=1
```

若 `|target - eye| < 1e-10` 或 `|cross(up, zAxis)| < 1e-10`，则返回单位矩阵。

### writeLookAtWorldMat4LHIntoBuffer(out, eye, target, up)

`createLookAtMat4LH` 的**逆矩阵**——相机到世界（camera-to-world）矩阵——就地写入，使用相同的基向量和相同的退化回退行为：

```
out[0]=xAxis.x  out[4]=yAxis.x  out[8]=zAxis.x   out[12]=eye.x
out[1]=xAxis.y  out[5]=yAxis.y  out[9]=zAxis.y   out[13]=eye.y
out[2]=xAxis.z  out[6]=yAxis.z  out[10]=zAxis.z  out[14]=eye.z
out[3]=0        out[7]=0        out[11]=0        out[15]=1
```

这正是每个相机工厂所需的（引擎存储相机的世界矩阵，并在 `getViewMatrix` 中从中推导出视图矩阵），因此直接构建该矩阵可避免分配视图矩阵、计算随后立即被丢弃的三次点积平移列以及再将旋转转置出来。当 `|target - eye| < 1e-10` 或 `|cross(up, zAxis)| < 1e-10` 时，保留带相机位置平移的单位旋转矩阵。

### createPerspectiveMat4LH(fov, aspect, near, far)

左手系透视投影，深度范围 [0, 1]：

```
tan = 1 / Math.tan(fov * 0.5)
range = far - near

out[0]  = tan / aspect
out[5]  = tan
out[10] = far / range
out[11] = 1                    // LH: w_clip = +z_eye
out[14] = -(far * near) / range
out[15] = 0
```

所有其余元素均为 0。

### invertMat4(m)

使用 12 个中间 2×2 行列式（`b00`–`b11`）进行完整代数余子式展开。若 `|det| < 1e-10`，则返回 `null`。

行列式：

```
det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06
```

逆矩阵的每个元素为对应的余子式除以 `det`。

### createScalingMat4(x, y, z)

```
out = diag(x, y, z, 1) → out[0]=x, out[5]=y, out[10]=z, out[15]=1
```

### createTranslationMat4(x, y, z)

```
out = identity with out[12]=x, out[13]=y, out[14]=z
```

### createMat4FromQuat(qx, qy, qz, qw)

`writeMat4FromQuatIntoBuffer(out, qx, qy, qz, qw)` 将相同的 16 个值写入已有矩阵缓冲区并返回 `out`。

```
xx=qx*qx  yy=qy*qy  zz=qz*qz
xy=qx*qy  xz=qx*qz  yz=qy*qz
wx=qw*qx  wy=qw*qy  wz=qw*qz

out[0]  = 1 - 2*(yy+zz)    out[4]  = 2*(xy-wz)       out[8]  = 2*(xz+wy)
out[1]  = 2*(xy+wz)         out[5]  = 1 - 2*(xx+zz)   out[9]  = 2*(yz-wx)
out[2]  = 2*(xz-wy)         out[6]  = 2*(yz+wx)        out[10] = 1 - 2*(xx+yy)
out[15] = 1
```

### composeMat4(tx,ty,tz, qx,qy,qz,qw, sx,sy,sz)

一步计算 `Translation × Rotation × Scale`：

1. 通过 `createMat4FromQuat` 从四元数构建旋转矩阵。
2. 缩放旋转列：`col0 *= sx`，`col1 *= sy`，`col2 *= sz`。
3. 设置平移：`rot[12]=tx`，`rot[13]=ty`，`rot[14]=tz`。

```
result[0..2]  = rotCol0 * sx    // column 0 (X axis)
result[4..6]  = rotCol1 * sy    // column 1 (Y axis)
result[8..10] = rotCol2 * sz    // column 2 (Z axis)
result[12..14] = (tx, ty, tz)   // column 3 (translation)
result[15] = 1
```

## Babylon.js 等价映射

| Babylon Lite | Babylon.js |
| ------------------------------- | ---------------------------------------------------- |
| `Vec3` 接口 | `BABYLON.Vector3` 类 |
| `Vec4` 接口 | `BABYLON.Vector4` 类 |
| `Color3` 接口 | `BABYLON.Color3` 类 |
| `Color4` 接口 | `BABYLON.Color4` 类 |
| `Mat4` (Float32Array) | `BABYLON.Matrix` (Float32Array `_m`) |
| `Quat` 接口 | `BABYLON.Quaternion` 类 |
| `vec3(x,y,z)` | `new BABYLON.Vector3(x,y,z)` |
| `addVec3(a,b)` | `a.add(b)` |
| `subtractVec3(a,b)` | `a.subtract(b)` |
| `crossVec3(a,b)` | `BABYLON.Vector3.Cross(a,b)` |
| `normalizeVec3(v)` | `BABYLON.Vector3.Normalize(v)` |
| `createIdentityMat4()` | `BABYLON.Matrix.Identity()` |
| `multiplyMat4(a,b)` | `a.multiply(b)` |
| `createLookAtMat4LH(eye,target,up)` | `BABYLON.Matrix.LookAtLH(eye,target,up)` |
| `createPerspectiveMat4LH(fov,ar,n,f)` | `BABYLON.Matrix.PerspectiveFovLH(fov,ar,n,f)` |
| `invertMat4(m)` | `m.invert()` / `BABYLON.Matrix.Invert(m)` |
| `createMat4FromQuat(qx,qy,qz,qw)` | `BABYLON.Matrix.FromQuaternion(q)` |
| `writeMat4FromQuatIntoBuffer(out,...)` | `BABYLON.Matrix.FromQuaternionToRef(q,out)` |
| `composeMat4(t,r,s)` | `BABYLON.Matrix.Compose(scale,rotation,translation)` |
| 列主序布局 | 列主序布局（相同） |
| 左手系 | 左手系（相同） |
| 深度 [0,1] | 深度 [0,1]（WebGPU） |

## 依赖项

- **无内部依赖** —— 核心数学模块是一个叶模块。
- **被以下模块依赖**：所有其他模块（相机、场景、加载器、管线、材质）。

## 测试规范

| 测试 | 描述 |
| -------------------------------------- | ------------------------------------------------------- |
| `createIdentityMat4` | 所有对角线元素 = 1，其余 = 0 |
| `multiplyMat4 identity` | `A × I = A` |
| `multiplyMat4 associativity` | 在误差范围内 `(A×B)×C ≈ A×(B×C)` |
| `createLookAtMat4LH basic` | 视点在 (0,0,-5)，目标 (0,0,0)：验证 zAxis = (0,0,1) |
| `writeLookAtWorldMat4LHIntoBuffer ≡ inverse` | 与其替代的 look-at 转置路径逐元素匹配，包括两种退化回退 |
| `createPerspectiveMat4LH` | 验证 `m[0] = tan/aspect`，`m[10] = far/(far-near)` |
| `invertMat4 × m = identity` | 验证 `m × m⁻¹ ≈ I` |
| `invertMat4 returns null for singular` | 零矩阵 → null |
| `createMat4FromQuat identity` | 四元数 (0,0,0,1) → 单位矩阵 |
| `createMat4FromQuat 90° around Y` | 验证旋转正确 |
| `writeMat4FromQuatIntoBuffer` | 直接写入已有存储而不替换对象 |
| `composeMat4 T×R×S` | 与分立矩阵手动相乘结果对比 |
| `normalizeVec3 zero` | 对零向量返回 (0,0,0) |
| `crossVec3 X×Y=Z` | (1,0,0) × (0,1,0) = (0,0,1) |
| `lerpVec3 t=0 and t=1` | 分别返回 a 和 b |
| `writeVec3` | 验证 Float32Array 写入到正确偏移量 |
| `Mat4 brand` | 确保类型为长度为 16 的 Float32Array |

## 文件清单

| 文件 | 大小 | 职责 |
| ------------------------------ | ---------- | --------------------------------------------------------- |
| `src/core/types.ts` | ~44 行 | 类型定义（Vec3、Vec4、Color3、Color4、Mat4、Quat） |
| `src/core/vec3.ts` | ~68 行 | Vec3 构造函数、常量、算术运算 |
| `src/core/mat4.ts` | ~185 行 | Mat4 单位矩阵、乘法、lookAt、透视投影、求逆、TRS |
| `src/core/index.ts` | ~11 行 | 汇总重导出 |
| `src/core/generate-mipmaps.ts` | ~141 行 | GPU mipmap 生成（由加载器使用，非数学模块） |
