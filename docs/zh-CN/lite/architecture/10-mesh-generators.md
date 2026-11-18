# 模块：网格生成器（Mesh Generators）

> 包路径：`packages/babylon-lite/src/mesh/`

## 用途

为核心 BabylonJS `MeshBuilder` 几何形状集合提供程序化网格生成：地面（支持高度图）、圆环体、UV 球体、立方体、圆柱体/圆锥体、平面、圆盘/圆环、多面体、丝带（ribbon）、管状体（tube）和挤压体（extruded shape）。每个生成器均产出 CPU 侧顶点数据（位置、法线、UV、索引），并在适用的情况下提供配套的 GPU 上传辅助函数。所有生成器的输出均与 Babylon.js `MeshBuilder` 精确一致；像素级一致性由场景 38 严格校验（MAD = 0.000）。

---

## 公共 API 表面

### 地面（`create-ground.ts`）

```typescript
export interface GroundData {
    positions: Float32Array; // vertexCount × 3
    normals: Float32Array; // vertexCount × 3
    uvs: Float32Array; // vertexCount × 2
    indices: Uint32Array; // indexCount
}

export interface GroundOptions {
    width?: number; // Default: 1
    height?: number; // Default: 1
    subdivisions?: number; // Default: 1
    minHeight?: number; // Default: 0
    maxHeight?: number; // Default: 1
}

export interface GroundGPU {
    positionBuffer: GPUBuffer;
    normalBuffer: GPUBuffer;
    uvBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    indexCount: number;
}

export function createFlatGroundData(opts?: GroundOptions): GroundData;

export function applyHeightmap(
    ground: GroundData,
    heightmapData: Uint8ClampedArray,
    hmWidth: number,
    hmHeight: number,
    subdivisions: number,
    minHeight: number,
    maxHeight: number
): void;

export async function createGroundFromHeightMap(heightmapUrl: string, opts?: GroundOptions): Promise<GroundData>;
```

### 圆环体（`create-torus.ts`）

```typescript
export interface TorusData {
    positions: Float32Array; // vertexCount × 3
    normals: Float32Array; // vertexCount × 3
    uvs: Float32Array; // vertexCount × 2
    indices: Uint32Array; // indexCount
}

export interface TorusOptions {
    diameter?: number; // Default: 1
    thickness?: number; // Default: 0.5
    tessellation?: number; // Default: 16
}

export interface TorusGPU {
    positionBuffer: GPUBuffer;
    normalBuffer: GPUBuffer;
    uvBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    indexCount: number;
}

export function createTorusData(opts?: TorusOptions): TorusData;
export function uploadTorusToGPU(device: GPUDevice, data: TorusData): TorusGPU;
```

### 球体（`create-sphere.ts`）

```typescript
export interface SphereMeshData {
    positions: Float32Array; // vertexCount × 3
    normals: Float32Array; // vertexCount × 3
    indices: Uint32Array; // indexCount
    vertexCount: number;
    indexCount: number;
}

export interface SphereOptions {
    segments?: number; // Default: 32 (minimum: 3)
    diameter?: number; // Default: 1
    diameterX?: number; // Default: diameter
    diameterY?: number; // Default: diameter
    diameterZ?: number; // Default: diameter
}

export function createSphereData(options?: SphereOptions): SphereMeshData;

export function uploadSphereToGPU(device: GPUDevice, data: SphereMeshData): { posBuffer: GPUBuffer; normBuffer: GPUBuffer; idxBuffer: GPUBuffer; idxCount: number };
```

### 立方体（`create-box.ts`）

```typescript
export interface BoxData {
    positions: Float32Array; // 24 × 3 = 72 floats
    normals: Float32Array; // 24 × 3 = 72 floats
    indices: Uint32Array; // 36 indices
    vertexCount: number; // always 24
    indexCount: number; // always 36
}

export interface BoxGPU {
    posBuffer: GPUBuffer;
    normBuffer: GPUBuffer;
    idxBuffer: GPUBuffer;
    idxCount: number;
}

export function createBoxData(size?: number): BoxData; // Default: size = 1
export function uploadBoxToGPU(device: GPUDevice, data: BoxData): BoxGPU;
```

### 圆柱体（`create-cylinder.ts`）

```typescript
export interface CylinderOptions {
    height?: number; // Default: 2
    diameter?: number; // Default: 1 (overrides diameterTop / diameterBottom)
    diameterTop?: number; // Default: 1 (0 → cone)
    diameterBottom?: number; // Default: 1
    tessellation?: number; // Default: 24
    subdivisions?: number; // Default: 1
    arc?: number; // Default: 1 (partial wedge)
}

export function createCylinderData(opts?: CylinderOptions): MeshData;
```

### 平面（`create-plane.ts`）

```typescript
export interface PlaneOptions {
    size?: number; // Default: 1 (shorthand for width + height)
    width?: number;
    height?: number;
}

export function createPlaneData(opts?: PlaneOptions): MeshData;
```

### 圆盘 / 圆环（`create-disc.ts`）

```typescript
export interface DiscOptions {
    radius?: number; // Default: 0.5
    tessellation?: number; // Default: 64
    arc?: number; // Default: 1 (<1 → pie slice / ring)
}

export function createDiscData(opts?: DiscOptions): MeshData;
```

### 多面体（`create-polyhedron.ts`）

```typescript
export interface PolyhedronOptions {
    type?: number; // 0-14 (0=tetra, 3=icosahedron, …)
    size?: number; // Default: 1 (uniform scale)
    sizeX?: number;
    sizeY?: number;
    sizeZ?: number;
    flat?: boolean; // Default: true (duplicate verts per face)
}

export function createPolyhedronData(opts?: PolyhedronOptions): MeshData;
```

### 丝带（`create-ribbon.ts`）

```typescript
export interface RibbonOptions {
    pathArray: Vec3[][];
    closeArray?: boolean; // Default: false
    closePath?: boolean; // Default: false
    offset?: number; // Default: pathArray[0].length / 2
    sideOrientation?: number;
}

export function createRibbonData(opts: RibbonOptions): MeshData;
```

### 管状体（`create-tube.ts`）

```typescript
export const CAP_NONE = 0;
export const CAP_START = 1;
export const CAP_END = 2;
export const CAP_ALL = 3;

export interface TubeOptions {
    path: Vec3[];
    radius?: number; // Default: 1
    tessellation?: number; // Default: 64
    radiusFunction?: (i: number, distance: number) => number;
    cap?: number; // Default: CAP_NONE
    arc?: number; // Default: 1
}

export function createTubeData(opts: TubeOptions): MeshData;
```

### 挤压体（`create-extrude.ts`）

```typescript
export interface ExtrudeShapeOptions {
    shape: Vec3[];
    path: Vec3[];
    scale?: number; // Default: 1
    rotation?: number; // Default: 0 (radians accumulated per path step)
    cap?: number; // Default: CAP_NONE
    closeShape?: boolean;
    closePath?: boolean;
}

export function createExtrudeShapeData(opts: ExtrudeShapeOptions): MeshData;
```

### 共享类型

```typescript
// All new builders return this common shape.
export interface MeshData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}
```

---

## 内部架构

### 地面（Ground）

**网格布局：** `(subdivisions + 1) × (subdivisions + 1)` 个顶点。

**顶点与索引数量：**

- 顶点数：`(subdivisions + 1)²`
- 索引数：`subdivisions² × 6`

**顶点位置公式：**

```
x = -width/2 + (col / subdivisions) * width
y = 0 (flat; displaced by heightmap)
z = -height/2 + (1 - row / subdivisions) * height
```

**UV 公式：**

```
u = col / subdivisions
v = 1 - row / subdivisions
```

**初始法线：** 全部为 `(0, 1, 0)`（朝上）。

**索引生成（每个四边形）：**

```
topLeft     = row * cols + col
topRight    = topLeft + 1
bottomLeft  = (row + 1) * cols + col
bottomRight = bottomLeft + 1

Triangle 1: topLeft, bottomLeft, bottomRight
Triangle 2: topLeft, bottomRight, topRight
```

**高度图置换（`applyHeightmap`）：**

1. 对于 `(row, col)` 处的每个顶点：
    - 在像素 `(px, py)` 处采样高度图：
        ```
        u = col / subdivisions
        v = row / subdivisions  (row 0 = top of image)
        px = floor(u * (hmWidth - 1))
        py = floor(v * (hmHeight - 1))
        ```
    - 计算加权亮度：`gradient = r * 0.3 + g * 0.59 + b * 0.11`
    - 置换 Y 坐标：`position.y = minHeight + gradient * (maxHeight - minHeight)`

2. 重新计算法线：
    - 将所有法线重置为零
    - 对每个三角形：通过边向量的叉积计算面法线，对结果**取反**（由于 `1 - row/subdivisions` 引起的 Z 轴翻转），归一化为单位长度，然后累加到该三角形的 3 个顶点上
    - 归一化所有顶点法线

**面法线叉积公式：**

```
e1 = p1 - p0
e2 = p2 - p0
fn = -(e1 × e2)          // negated
fn = fn / |fn|            // normalize before accumulation
```

**异步高度图加载（`createGroundFromHeightMap`）：**

1. 创建平坦地面数据
2. 通过设置 `crossOrigin = 'anonymous'` 的 `new Image()` 加载图像
3. 绘制到 canvas，提取 `ImageData`
4. 调用 `applyHeightmap`

### 圆环体（Torus）

**参数化（与 Babylon.js `Mesh.CreateTorus` 一致）：**

```
R = diameter / 2          // major radius (default: 0.5)
r = thickness / 2         // tube radius (default: 0.25)
stride = tessellation + 1

outerAngle = i * 2π / tessellation - π/2    // around major ring
innerAngle = j * 2π / tessellation + π      // around tube cross-section
```

**顶点与索引数量：**

- 顶点数：`(tessellation + 1)²`
- 索引数：`(tessellation + 1)² × 6`（包含接缝环绕几何体）

**位置公式：**

```
dx = cos(innerAngle)
dy = sin(innerAngle)

x =  (dx * r + R) * cos(outerAngle)
y =  dy * r
z = -(dx * r + R) * sin(outerAngle)
```

**法线公式**（将管截面法线绕 Y 轴旋转）：

```
nx =  dx * cos(outerAngle)
ny =  dy
nz = -dx * sin(outerAngle)
```

**UV 公式：**

```
u = i / tessellation
v = 1 - j / tessellation
```

**索引生成**（带环绕的每个四边形）：

```
nextI = (i + 1) % stride
nextJ = (j + 1) % stride

Triangle 1: (i*stride + j), (i*stride + nextJ), (nextI*stride + j)
Triangle 2: (i*stride + nextJ), (nextI*stride + nextJ), (nextI*stride + j)
```

### 球体（Sphere）

**参数化（与 Babylon.js `MeshBuilder.CreateSphere` 一致）：**

```
totalZRotationSteps = 2 + segments     // vertical rows
totalYRotationSteps = 2 * totalZRotationSteps  // horizontal columns

rx = (diameterX ?? diameter) / 2       // default: 0.5
ry = (diameterY ?? diameter) / 2
rz = (diameterZ ?? diameter) / 2
```

**默认细分：** `segments = 32` → `totalZ = 34, totalY = 68` → `35 × 69 = 2415` 个顶点。

**顶点与索引数量：**

- 顶点数：`(totalZRotationSteps + 1) × (totalYRotationSteps + 1)`
- 索引数：`totalZRotationSteps × totalYRotationSteps × 6`

**位置公式：**

```
angleZ = (zStep / totalZRotationSteps) * π       // polar angle [0, π]
angleY = (yStep / totalYRotationSteps) * 2π      // azimuthal angle [0, 2π]

nx = sin(angleZ) * cos(angleY)
ny = cos(angleZ)
nz = sin(angleZ) * sin(angleY)

position = (rx * nx, ry * ny, rz * nz)
normal   = (nx, ny, nz)
```

**索引生成**（每个四边形）：

```
a = zStep * (totalYRotationSteps + 1) + yStep
b = a + totalYRotationSteps + 1

Triangle 1: a, b, a+1
Triangle 2: a+1, b, b+1
```

**注意：** 不生成 UV 坐标。球体仅包含位置、法线和索引。

### 立方体（Box）

**静态几何体** — 使用预计算的常量数组。

**顶点数：** 24（每面 4 个 × 6 个面）
**索引数：** 36（每面 2 个三角形 × 3 个索引 × 6 个面）

**面顺序：** +Z, -Z, +X, -X, +Y, -Y

**顶点位置（`size = 1`，半边长 = 0.5）：**

| 面 | V0 | V1 | V2 | V3 | 法线 |
| ---- | -------------- | --------------- | ---------------- | --------------- | -------- |
| +Z | (0.5,-0.5,0.5) | (-0.5,-0.5,0.5) | (-0.5,0.5,0.5) | (0.5,0.5,0.5) | (0,0,1) |
| -Z | (0.5,0.5,-0.5) | (-0.5,0.5,-0.5) | (-0.5,-0.5,-0.5) | (0.5,-0.5,-0.5) | (0,0,-1) |
| +X | (0.5,0.5,-0.5) | (0.5,-0.5,-0.5) | (0.5,-0.5,0.5) | (0.5,0.5,0.5) | (1,0,0) |
| -X | (-0.5,0.5,0.5) | (-0.5,-0.5,0.5) | (-0.5,-0.5,-0.5) | (-0.5,0.5,-0.5) | (-1,0,0) |
| +Y | (-0.5,0.5,0.5) | (-0.5,0.5,-0.5) | (0.5,0.5,-0.5) | (0.5,0.5,0.5) | (0,1,0) |
| -Y | (0.5,-0.5,0.5) | (0.5,-0.5,-0.5) | (-0.5,-0.5,-0.5) | (-0.5,-0.5,0.5) | (0,-1,0) |

**每个面的索引模式：**

```
[base+0, base+1, base+2], [base+0, base+2, base+3]
```

完整索引：

```
[0,1,2], [0,2,3],  [4,5,6], [4,6,7],  [8,9,10], [8,10,11],
[12,13,14], [12,14,15],  [16,17,18], [16,18,19],  [20,21,22], [20,22,23]
```

**缩放：** 当 `size ≠ 1` 时，所有位置坐标乘以 `size`，法线保持不变。当 `size = 1` 时，直接返回预计算的 `BOX_POSITIONS` 常量（零分配）。

### 圆柱体（Cylinder）

移植自 BJS `VertexData.CreateCylinder`。在 `diameterBottom` 和 `diameterTop` 之间插值构建 `subdivisions + 1` 个径向环，并在两端添加 `CAP_ALL` 三角扇形封盖。法线根据倾斜角计算，使圆锥和棱柱能够正确着色。`arc < 1` 会生成带接缝的部分扇形柱体。

### 平面（Plane）

位于 XY 平面的单个四边形；法线 `(0, 0, -1)`；UV `[0,1]`；索引顺序 `(0,1,2),(0,2,3)` → 绕序与 `-Z` 法线下的 `frontFace: "ccw"` 匹配。

### 圆盘 / 圆环（Disc / Ring）

从中心发出的三角扇形，外圈有 `tessellation` 个顶点，覆盖 `2π · arc` 弧度。法线硬编码为 `(0, 0, -1)`。当 `arc < 1` 时，扇形形成扇片；零厚度圆环网格通过在两个半径处采样同一形状（挤压路径）生成。

### 多面体（Polyhedron）

BJS 预设表（`polyhedron-data.ts`）包含 15 种多面体的顶点位置和面索引列表。生成器先按 `sizeX/Y/Z` 缩放，再对每个面进行三角剖分：

- **`flat = true`（默认）：** 每个面提供独立的顶点和单一面法线（两条边向量的叉积），面与面之间不共享顶点。
- **`flat = false`：** 面顶点共享；法线通过 `compute-normals.ts` 进行平均以实现平滑着色。

### 丝带（Ribbon）

驱动 `tube` 和 `extrude` 的基础图元。给定 `pathArray`（由等长 3D 路径构成的行）：

1. 将所有行串联为一个位置缓冲区（行优先）。
2. 在相邻路径之间拼接并输出每个四边形的两个三角形。
3. 沿每行和每列的累积边长归一化 UV（与 BJS 一致）。
4. 通过 `compute-normals.ts` 计算逐顶点法线。
5. 如果启用 `closePath`，在每行末尾复制第一个顶点并平均接缝法线。
6. 如果启用 `closeArray`，将最后一条路径缝合回第一条路径，并平均这些接缝法线。

### 管状体（Tube）

构建一条丝带，其中每行是围绕 `path[i]` 的包含 `tessellation` 个顶点的圆环，半径为 `radius`（或 `radiusFunction(i, distance)`）：

1. 计算 Path3D 标架 → `tangents[i]`、`normals[i]`、`binormals[i]`。
2. 对每个 `path[i]`，从 `normals[i] * radius` 出发，通过罗德里格斯（Rodrigues）旋转公式绕 `tangents[i]` 旋转 `2π · arc / tessellation` 来构建圆环。
3. 始终设置 `closePath = true` 以闭合圆环。
4. `cap` 在起点/终点插入额外的行：一个重心顶点加一个零缩放的重复圆环（与 BJS 封盖几何体一致）。

### 挤压体（Extrude Shape）

将二维 `shape`（XY 平面）沿三维 `path` 扫掠：

1. 计算 Path3D 标架。
2. 对每个 `path[i]`，变换每个 `shape[k]`：`p = tangent[i] * sz + normal[i] * sx + binormal[i] * sy`（将形状的 Z 重解释为切线方向偏移）。
3. 绕 `tangent[i]` 应用累积 `rotation`（罗德里格斯公式）和 `scale`。
4. 平移至 `path[i]`。
5. 从变换后的环构建丝带行，并可通过重心 + 零缩放重复环添加可选的起点/终点封盖。

### Path3D（`path3d.ts`）

移植自 BJS 的平行输运（parallel-transport）标架计算：

- 首个切线：`normalize(curve[1] - curve[0])`（或针对前导重复点的首个非零差值）。
- 首个法线：通过 `_normalVector(tangent, null)` 获取的任意垂直向量——选择最稳定的坐标轴叉积。
- 后续标架：`tangent[i] = normalize(curve[i+1] - curve[i])`，然后 `normal[i] = normalize(cross(binormal[i-1], tangent[i]))`，`binormal[i] = cross(tangent[i], normal[i])`。这使标架沿曲线平行输运，避免摆动或翻滚不连续。
- 最后一点复制前一个切线。
- `distances[i]` 为累积弧长，用于 UV 归一化。

### GPU 上传模式

所有生成器均遵循相同的 GPU 上传模式：

```typescript
// Per-attribute buffer creation
const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true, // (ground, torus, sphere)
    // OR: writeBuffer after creation (box)
});
new Float32Array(buffer.getMappedRange()).set(data);
buffer.unmap();
```

**索引缓冲区** 使用 `GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST` 及 `Uint32Array`。

**立方体变体：** 使用 `device.queue.writeBuffer()` 而非 `mappedAtCreation`。

### 顶点数据布局

所有生成器均使用**分离缓冲区**（非交错布局）：

| 缓冲区 | 步长 | 格式 | 内容 |
| -------- | ------ | --------- | ---------- |
| 位置 | 12B | float32x3 | xyz 坐标 |
| 法线 | 12B | float32x3 | xyz 法线 |
| UV | 8B | float32x2 | uv 坐标 |
| 索引 | 4B | uint32 | 索引 |

**例外：** 球体与立方体不生成 UV 坐标。

---

## 管线配置

网格生成器不创建管线。它们生成原始顶点数据，供材质管线（例如 `standard-textured-material.ts`）消费。预期的管线顶点布局如下：

| 槽位 | 步长 | 位置（Location） | 格式 | 缓冲区 |
| ---- | ------ | -------- | --------- | -------- |
| 0 | 12B | 0 | float32x3 | 位置 |
| 1 | 12B | 1 | float32x3 | 法线 |
| 2 | 8B | 2 | float32x2 | uv |

---

## 着色器逻辑

无着色器。网格生成器仅为纯 CPU 几何体生产者。

---

## 状态机 / 生命周期

### 地面生命周期

```
Option A: Flat ground
  createFlatGroundData(opts) → GroundData

Option B: Heightmap ground
  createGroundFromHeightMap(url, opts) → GroundData  (async)
    ├─ createFlatGroundData(opts)
    ├─ Load image via HTMLImageElement
    ├─ Draw to canvas, extract ImageData
    └─ applyHeightmap(ground, imageData, ...)

Option C: Manual heightmap
  createFlatGroundData(opts) → GroundData
  applyHeightmap(ground, pixelData, ...)
```

### 其他形状

```
createTorusData(opts) → TorusData → uploadTorusToGPU(device, data) → TorusGPU
createSphereData(opts) → SphereMeshData → uploadSphereToGPU(device, data) → {posBuffer, normBuffer, idxBuffer, idxCount}
createBoxData(size) → BoxData → uploadBoxToGPU(device, data) → BoxGPU
```

除异步的 `createGroundFromHeightMap` 外，其余均为单次调用的同步生成器。

---

## Babylon.js 等价映射表

| Babylon Lite | Babylon.js |
| -------------------------------------- | --------------------------------------------------------------- |
| `createFlatGroundData(opts)` | `MeshBuilder.CreateGround(name, opts, scene)` |
| `createGroundFromHeightMap(url, opts)` | `MeshBuilder.CreateGroundFromHeightMap(name, url, opts, scene)` |
| `applyHeightmap()` | 内部方法：`GroundMesh._applyDisplacementMap()` |
| 亮度公式：`r*0.3 + g*0.59 + b*0.11` | 与 Babylon 相同的亮度公式 |
| `createTorusData(opts)` | `MeshBuilder.CreateTorus(name, opts, scene)` |
| 圆环外角偏移 `-π/2` | Babylon 的圆环起始于 -π/2 旋转角 |
| 圆环内角偏移 `+π` | Babylon 的管截面起始于 +π |
| `createSphereData(opts)` | `MeshBuilder.CreateSphere(name, opts, scene)` |
| `totalZ = 2 + segments` | Babylon 的球体细分公式 |
| `totalY = 2 * totalZ` | Babylon 的球体方位角步数 |
| `createBoxData(size)` | `MeshBuilder.CreateBox(name, { size }, scene)` |
| 面顺序：+Z,-Z,+X,-X,+Y,-Y | 与 Babylon 相同的面顺序 |
| `createCylinderData(opts)` | `MeshBuilder.CreateCylinder(name, opts, scene)` |
| `createPlaneData(opts)` | `MeshBuilder.CreatePlane(name, opts, scene)` |
| `createDiscData(opts)` | `MeshBuilder.CreateDisc(name, opts, scene)` |
| `createPolyhedronData(opts)` | `MeshBuilder.CreatePolyhedron(name, opts, scene)` |
| `createRibbonData(opts)` | `MeshBuilder.CreateRibbon(name, opts, scene)` |
| `createTubeData(opts)` | `MeshBuilder.CreateTube(name, opts, scene)` |
| `createExtrudeShapeData(opts)` | `MeshBuilder.ExtrudeShape(name, opts, scene)` |
| `CAP_NONE/CAP_START/CAP_END/CAP_ALL` | `Mesh.NO_CAP/CAP_START/CAP_END/CAP_ALL` |
| 分离的 pos/normal/uv 缓冲区 | Babylon 对每种类型使用独立的 `VertexBuffer` |

---

## 依赖项

- 无（所有生成器均自包含）
- WebGPU API 类型（`GPUDevice`、`GPUBuffer`）
- 浏览器 API：`Image`、`HTMLCanvasElement`、`CanvasRenderingContext2D`（仅地面高度图）

---

## 测试规范

### 地面

1. **平坦地面尺寸** — 当 `width=10, height=10, subdivisions=4` 时：25 个顶点，96 个索引。
2. **位置范围** — 顶点 X 在 `[-width/2, width/2]` 内，Z 在 `[-height/2, height/2]` 内，Y = 0。
3. **UV 范围** — 所有 UV 在 [0, 1] 内。
4. **高度图亮度** — 像素 `(255, 0, 0)` → gradient = `0.3`。当 minHeight=0、maxHeight=10 时：Y = 3.0。
5. **法线重算** — 应用高度图后：所有法线应为单位长度，在缓坡上以 Y 分量为主。
6. **绕序** — 逆时针（CCW）正面（与管线中的 `frontFace: 'ccw'` 一致）。

### 圆环体

7. **顶点数** — 当 `tessellation=16` 时：`(17)² = 289` 个顶点，`289 × 6 = 1734` 个索引。
8. **对称性** — 圆环体应关于 Y 轴对称。
9. **主半径** — 顶点到 Y 轴的距离应约等于 `R ± r`。
10. **UV 环绕** — UV 应配合环绕索引正确平铺。

### 球体

11. **默认细分** — `segments=32`：`35 × 69 = 2415` 个顶点，`34 × 68 × 6 = 13872` 个索引。
12. **单位半径** — 当 `diameter=1` 时：所有顶点位置的模长应约等于 0.5。
13. **极点** — 顶部极点位于 `(0, ry, 0)`，底部极点位于 `(0, -ry, 0)`。
14. **法线方向** — 每条法线应从原点径向向外指出。
15. **椭球体** — 当 `diameterX=2, diameterY=1, diameterZ=1` 时：位置非均匀缩放，但法线仍保持在单位球面上。

### 立方体

16. **数量** — 无论尺寸大小，始终为 24 个顶点、36 个索引。
17. **Size=1 优化** — 直接返回预计算的常量数组。
18. **尺寸缩放** — `size=2`：所有位置乘以 2，法线不变。
19. **面法线** — 每个面有 4 条完全相同的轴对齐法线。
20. **无 UV** — 立方体不生成 UV 坐标。

---

## 文件清单

| 文件 | 职责 |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/mesh/create-ground.ts` | 带高度图的地面平面：平坦生成、置换、法线重算、GPU 上传 |
| `src/mesh/create-torus.ts` | 圆环体：参数化圆环网格生成、GPU 上传 |
| `src/mesh/create-sphere.ts` | UV 球体：参数化球体生成、GPU 上传 |
| `src/mesh/create-box.ts` | 立方体：从常量数组生成的静态 6 面几何体、GPU 上传 |
| `src/mesh/create-cylinder.ts` | 圆柱体 / 圆锥体 / 棱柱：height、diameterTop/Bottom、tessellation、subdivisions、CAP_ALL |
| `src/mesh/create-plane.ts` | 平面：位于 XY 平面带 -Z 法线的四边形（size 或 width/height） |
| `src/mesh/create-disc.ts` | 圆盘 / 扇片 / 圆环：可配置弧度的扇形圆盘，-Z 法线 |
| `src/mesh/create-polyhedron.ts` | 15 种 BJS 多面体预设（四面体/立方体/八面体/十二面体/二十面体等），平面与平滑法线 |
| `src/mesh/polyhedron-data.ts` | 15 种多面体的顶点/面数据表（从 BJS `polyhedronData.js` 自动生成） |
| `src/mesh/create-ribbon.ts` | 参数化丝带图元：pathArray、closePath、closeArray、offset、sideOrientation |
| `src/mesh/create-tube.ts` | 管状体：沿 3D 路径的闭合圆环丝带；CAP_NONE/START/END/ALL；罗德里格斯旋转 |
| `src/mesh/create-extrude.ts` | ExtrudeShape：使用 Frenet 标架（切线/法线/副法线）沿 3D 路径扫掠 2D 形状 |
| `src/mesh/path3d.ts` | Path3D 移植：切线、法线、副法线、累积距离（平行输运标架） |
| `src/mesh/compute-normals.ts` | 等价于 BJS 的法线累加器（Float64Array），用于构建后计算法线的形状 |
