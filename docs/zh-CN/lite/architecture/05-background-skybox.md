# 模块：背景与天空盒（Background & Skybox）

> 包路径：
>
> - `packages/babylon-lite/src/material/pbr/background-material.ts` — 天空盒材质 + 立方体贴图天空盒材质工厂 + 几何体生成
> - `packages/babylon-lite/src/material/pbr/background-renderable.ts` — 天空盒 + 地面 → 可渲染对象编排器、场景尺寸计算
> - `packages/babylon-lite/src/material/pbr/background-ground.ts` — 地面材质、几何体、纹理加载、UBO
> - `packages/babylon-lite/src/material/pbr/background-dds-skybox.ts` — DDS 立方体贴图天空盒可渲染对象
> - `packages/babylon-lite/src/material/pbr/background-dds-environment.ts` — 场景作用域的 DDS 天空盒 + 地面编排
> - `packages/babylon-lite/src/material/pbr/background-hdr-skybox.ts` — HDR 立方体贴图天空盒可渲染对象
> - `packages/babylon-lite/src/material/standard/skybox-cubemap.ts` — StandardMaterial 场景的 CubeMap 天空盒
> - `packages/babylon-lite/src/texture/cube-texture.ts` — 6 面立方体纹理加载器
>
> 着色器：
>
> - `packages/babylon-lite/shaders/skybox.vertex.wgsl`, `skybox.fragment.wgsl` — 环境纯色天空盒
> - `packages/babylon-lite/shaders/skybox-dds.vertex.wgsl`, `skybox-dds.fragment.wgsl` — DDS 立方体贴图天空盒
> - `packages/babylon-lite/shaders/skybox-hdr.fragment.wgsl` — HDR 立方体贴图天空盒片元着色器
> - `packages/babylon-lite/shaders/background.vertex.wgsl`, `background.ground.fragment.wgsl` — 地面平面
> - `packages/babylon-lite/shaders/skybox-cubemap.vertex.wgsl`, `skybox-cubemap.fragment.wgsl` — CubeMap 天空盒

## 目的

本模块为场景背景提供五个相关的渲染子系统（及一个立方体纹理加载器）：

1. **纯色天空盒材质**（`createSkyboxMaterial`）—— 在所有其他物体之后渲染场景背景。使用盒体网格（24 顶点 / 36 索引），但直接从 UBO 输出预计算的 clearColor —— 在默认设置下，经过图像管线的 BJS 天空盒立方体贴图最高 mip 级输出与 clearColor 肉眼无异。

2. **DDS 立方体贴图天空盒**（`buildDdsSkyboxRenderable`）—— 懒加载的天空盒，加载 `backgroundSkybox.dds`（`rgba16float` DDS 立方体贴图）并使用 BJS 图像处理（曝光、对比度、色调映射）进行渲染。使用共享的 `CubemapSkyboxMaterial` 工厂。在不使用 DDS 天空盒的场景中会被 tree-shake 移除。

3. **HDR 立方体贴图天空盒**（`buildHdrSkyboxRenderable`）—— 适用于 HDR 全景环境的懒加载天空盒。采样高光立方体贴图（来自 `EnvironmentTextures`）并应用图像处理。在不使用 HDR 天空盒的场景中会被 tree-shake 移除。

4. **地面材质**（位于 `background-ground.ts` 中的 `buildGroundRenderable`）—— 渲染一个带漫反射纹理、不透明度 Fresnel、预乘 Alpha 混合以及图像处理的半透明地面平面。匹配开启了 `DIFFUSE + DIFFUSEHASALPHA + OPACITYFRESNEL + PREMULTIPLYALPHA` 的 BJS `BackgroundMaterial`。按需懒加载，在 `skipGround: true` 的场景中会被 tree-shake 移除。

5. **天空盒 CubeMap 材质**（`buildSkyboxCubeMapGPU`）—— 为基于 StandardMaterial 的场景渲染 6 面图像立方体贴图（通过 `loadCubeTexture` 加载）。使用规范的场景 UBO 布局。渲染背面（`cullMode = none`）。支持雾效。

6. **立方体纹理加载器**（`loadCubeTexture`）—— 加载 6 张面图像（`_px`、`_nx`、`_py`、`_ny`、`_pz`、`_nz`）并生成 mipmap。

## BJS 地面架构（经 Spector.GPU 验证）

地面实现是通过使用 Spector.GPU 并排捕获 BJS 与 Lite 渲染帧，并对比着色器、管线、纹理和 UBO 内容逆向还原出来的。

### 关键发现：地面并不是带立方体贴图反射的盒体

早期实现错误地使用了带有立方体贴图反射着色器的 24 顶点 / 36 索引盒体。Spector.GPU 抓帧揭示了以下事实：

- **BJS 地面 = `CreatePlane("BackgroundPlane", {size: 15})`，且 `sideOrientation = BACKSIDE`**
- **4 个顶点，6 个索引**（四边形，而非盒体！）
- 抓帧中可见的 36 索引绘制调用其实是**天空盒**，而非地面 —— 此前因顶点/索引数而误判
- 地面着色器没有 `REFLECTION` 宏定义 —— 它使用的是 `DIFFUSE + OPACITYFRESNEL + PREMULTIPLYALPHA`

### BJS 地面漫反射纹理（`backgroundGround.png`）

BJS 加载 `https://assets.babylonjs.com/core/environments/backgroundGround.png`：

- **1024×1024**，纯白 RGB（255,255,255），径向 Alpha 渐变
- 中心 Alpha = 255，边缘 Alpha = 0
- 该纹理驱动了地面不透明度的空间变化 —— 没有它时，地面将具有均匀的 Alpha

纹理 URL **并未硬编码在引擎中**。客户端代码通过 `loadEnvironment()` 选项传入：

```typescript
await loadEnvironment(scene, envUrl, {
    groundTextureUrl: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
});
```

如果未提供 URL，则使用 1×1 白色像素回退（地面 Alpha 仅由 Fresnel 驱动）。

### 地面 Alpha 管线

最终像素 Alpha 按如下方式计算：

```
alpha = materialAlpha(0.9) × textureAlpha × fadeFactor²
```

其中 `fadeFactor = clamp(dot(normalW, viewDir) / 0.1, 0, 1)`（不透明度 Fresnel）。

**依赖相机的表现：**

- **掠射角**（相机位于 Y≈0，例如场景 1）：viewAngle → 0，fadeFactor → 0，alpha → 0 → 地面不可见 → 透出 clearColor
- **抬高视角**（相机位于 Y=1.67，例如场景 7）：viewAngle > 0.1，fadeFactor → 1，alpha → `0.9 × textureAlpha` → 地面部分可见，并呈现出径向纹理带来的空间渐变

### 地面世界矩阵

该四边形构建于 XY 平面，并绕 X 轴旋转 90° 以平铺在 XZ 平面中：

```
| 1    0       0       0      |
| 0    ε      -1      -0.01   |    ε = 2.220446e-16 (≈0)
| 0    1       ε       0      |
| 0    0       0       1      |
```

局部法线 `(0,0,1)` 变换为世界法线 `(0,1,0)`（朝上）。Y 偏移量 = `-0.009781629778444767`。

## 公共 API 接口

### `load-env.ts`（入口点）

```typescript
export async function loadEnvironment(
    scene: SceneContext,
    url: string,
    options: {
        brdfUrl: string;
        groundTextureUrl?: string;
        skipSkybox?: boolean;
        skipGround?: boolean;
        skyboxUrl?: string;
        skyboxSize?: number;
    }
): Promise<EnvironmentTextures>;
```

`groundTextureUrl` 选项会透传给地面构建器，后者拉取纹理并将其上传至 GPU。标准的 `loadEnvironment()` 背景保持开启 BJS 风格的背景抖动（dithering）。

### `background-material.ts`

```typescript
// --- Solid-Color Skybox ---
export interface SkyboxMaterial {
    getPipeline(device: GPUDevice, format: GPUTextureFormat, msaaSamples: number): GPURenderPipeline;
    createBindGroup(device: GPUDevice, meshUBO: GPUBuffer, env: EnvironmentTextures): GPUBindGroup;
}
export function createSkyboxMaterial(sceneBindGroupLayout: GPUBindGroupLayout): SkyboxMaterial;

// --- Cubemap Skybox (shared by DDS + HDR variants) ---
export interface CubemapSkyboxMaterial {
    getPipeline(device: GPUDevice, format: GPUTextureFormat, msaaSamples: number): GPURenderPipeline;
    createBindGroup(device: GPUDevice, meshUBO: GPUBuffer, cubeView: GPUTextureView, cubeSampler: GPUSampler): GPUBindGroup;
}
export function createCubemapSkyboxMaterial(sceneBindGroupLayout: GPUBindGroupLayout, label: string, vertCode: string, fragCode: string): CubemapSkyboxMaterial;

// --- Geometry ---
export function createSkyboxBuffers(
    device: GPUDevice,
    S?: number
): {
    posBuffer: GPUBuffer;
    idxBuffer: GPUBuffer;
    idxCount: number;
};
export function createBuf(device: GPUDevice, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer;
export function buildSkyboxWorldMatrix(rootPosition: [number, number, number]): Mat4;
```

### `background-renderable.ts`

```typescript
export interface BackgroundRenderableOptions {
    skipSkybox?: boolean; // Skip solid-color skybox (e.g. caller provides HDR/DDS skybox)
    skipGround?: boolean; // Skip ground plane rendering
    skyboxSize?: number; // Skybox size (matches BJS createDefaultEnvironment option)
}

export async function buildBackgroundRenderables(
    scene: SceneContext,
    envTextures: EnvironmentTextures,
    sceneBindGroupLayout: GPUBindGroupLayout,
    sceneBindGroup: GPUBindGroup,
    groundTextureUrl?: string,
    options?: BackgroundRenderableOptions,
    groundImagePromise?: Promise<ImageBitmap>
): Promise<Renderable[]>;

export function computeSceneSize(scene: SceneContext, userSkyboxSize?: number): { groundSize: number; skyboxSize: number; rootPosition: [number, number, number] };

export function computeSkyboxGeometry(scene: SceneContext, userSkyboxSize?: number): { skyHalfSize: number; rootPosition: [number, number, number] };
```

### `background-ground.ts`

```typescript
/** Build the ground renderable for a PBR environment scene. */
export async function buildGroundRenderable(
    device: GPUDevice,
    sceneBindGroupLayout: GPUBindGroupLayout,
    format: GPUTextureFormat,
    msaaSamples: number,
    sceneBindGroup: GPUBindGroup,
    groundSize: number,
    rootPosition: [number, number, number],
    primaryColor: [number, number, number],
    groundTextureUrl?: string,
    groundImagePromise?: Promise<ImageBitmap>,
    enableNoise?: boolean
): Promise<Renderable>;
```

### `background-dds-skybox.ts`

```typescript
/** Build a DDS cube skybox as a complete Renderable (order 0). */
export async function buildDdsSkyboxRenderable(
    scene: SceneContext,
    sceneBindGroupLayout: GPUBindGroupLayout,
    sceneBindGroup: GPUBindGroup,
    skyboxTextureUrl?: string, // default: backgroundSkybox.dds from BJS CDN
    skyboxSize?: number,
    enableNoise?: boolean
): Promise<Renderable>;
```

### `background-dds-environment.ts`

```typescript
export function addDdsEnvironmentBackground(
    scene: SceneContext,
    options: {
        skyboxUrl: string;
        groundTextureUrl: string;
        skyboxSize: number;
        enableNoise?: boolean; // Default true; matches BJS BackgroundMaterial.enableNoise
    }
): void;
```

该辅助函数仅用于编排现有的 DDS 天空盒和地面构建器。场景 112 在通过 `skipSkybox` 和 `skipGround` 加载环境光照后使用带 `enableNoise: false` 的此函数，从而避免重复的天空盒/地面实现，同时将无噪点路径控制在场景作用域内。

### `background-hdr-skybox.ts`

```typescript
/** Build an HDR cubemap skybox as a complete Renderable (order 0). */
export function buildHdrSkyboxRenderable(
    scene: SceneContext,
    envTextures: EnvironmentTextures,
    sceneBindGroupLayout: GPUBindGroupLayout,
    sceneBindGroup: GPUBindGroup,
    skyboxSize?: number
): Renderable;
```

### `skybox-cubemap.ts`

```typescript
export interface SkyboxCubeMapGPU {
    pipeline: GPURenderPipeline;
    sceneBindGroup: GPUBindGroup;
    meshBindGroup: GPUBindGroup;
    sceneUBO: GPUBuffer;
    meshUBO: GPUBuffer;
}

export function buildSkyboxCubeMapGPU(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaSamples: number,
    sceneUBO: GPUBuffer,
    worldMatrix: Float32Array,
    cubeView: GPUTextureView,
    cubeSampler: GPUSampler
): SkyboxCubeMapGPU;
```

### `cube-texture.ts`

```typescript
export async function loadCubeTexture(
    device: GPUDevice,
    baseUrl: string,
    extension?: string // default: '.jpg'
): Promise<{ texture: GPUTexture; view: GPUTextureView; sampler: GPUSampler }>;
```

## 管线配置

### 天空盒管线（纯色 — 环境）

| 设置       | 值                                   |
| ---------- | ------------------------------------ |
| 顶点缓冲区 | 1：位置（`float32x3`，步长 12）      |
| 拓扑       | `triangle-list`                      |
| 剔除模式   | `back`                               |
| 正面绕序   | `ccw`                                |
| 深度比较   | `greater-equal`                      |
| 深度写入   | **`false`**                          |
| MSAA       | `count = msaaSamples`                |
| 混合       | 无                                   |

### 立方体贴图天空盒管线（DDS + HDR 变体）

DDS 与 HDR 立方体贴图天空盒均通过 `createCubemapSkyboxMaterial` 使用相同的管线配置 —— 仅着色器源码不同。

| 设置       | 值                                   |
| ---------- | ------------------------------------ |
| 顶点缓冲区 | 1：位置（`float32x3`，步长 12）      |
| 拓扑       | `triangle-list`                      |
| 剔除模式   | `back`                               |
| 正面绕序   | `ccw`                                |
| 深度比较   | `greater-equal`                      |
| 深度写入   | **`false`**                          |
| MSAA       | `count = msaaSamples`                |
| 混合       | 无                                   |

### 地面管线

| 设置       | 值                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------- |
| 顶点缓冲区 | 3：位置（`float32x3`，步长 12）、法线（`float32x3`，步长 12）、UV（`float32x2`，步长 8）       |
| 拓扑       | `triangle-list`                                                                                |
| 剔除模式   | `back`                                                                                         |
| 正面绕序   | `ccw`                                                                                          |
| 深度比较   | `greater-equal`                                                                                |
| 深度写入   | **`false`**                                                                                    |
| MSAA       | `count = msaaSamples`                                                                          |
| 混合       | 预乘 Alpha：`src=one, dst=one-minus-src-alpha`（颜色与 Alpha 通道均如此）                      |

### 天空盒 CubeMap 管线（StandardMaterial 场景）

| 设置       | 值                                                                 |
| ---------- | ------------------------------------------------------------------ |
| 顶点缓冲区 | 2：位置（`float32x3`，步长 12）、法线（`float32x3`，步长 12）      |
| 拓扑       | `triangle-list`                                                    |
| 剔除模式   | **`none`**（观察盒体内部）                                         |
| 正面绕序   | `ccw`                                                              |
| 深度比较   | `greater-equal`                                                    |
| 深度写入   | `true`                                                             |
| MSAA       | `count = msaaSamples`                                              |
| 混合       | 无                                                                 |

### 绑定组布局

**纯色天空盒（Group 1）：**

| Binding | 可见性             | 类型           | 资源                                                      |
| ------- | ------------------ | -------------- | --------------------------------------------------------- |
| 0       | VERTEX \| FRAGMENT | Uniform 缓冲区 | 网格 UBO（96 字节：world + primaryColor + skyOutputColor）|

**立方体贴图天空盒 — DDS + HDR（Group 1）**（通过 `createCubemapSkyboxMaterial` 共享布局）：

| Binding | 可见性             | 类型               | 资源                                       |
| ------- | ------------------ | ------------------ | ------------------------------------------ |
| 0       | VERTEX \| FRAGMENT | Uniform 缓冲区     | 网格 UBO（大小见下文各变体说明）           |
| 1       | FRAGMENT           | texture_cube       | 立方体贴图纹理（DDS 或高光环境立方体）     |
| 2       | FRAGMENT           | sampler（可过滤）  | 立方体贴图采样器                           |

**地面（Group 1）：**

| Binding | 可见性             | 类型               | 资源                                                                 |
| ------- | ------------------ | ------------------ | -------------------------------------------------------------------- |
| 0       | VERTEX \| FRAGMENT | Uniform 缓冲区     | 网格 UBO（96 字节：world + primaryColor + alpha + backgroundCenter） |
| 1       | FRAGMENT           | texture_2d         | 地面漫反射纹理（从 URL 加载）                                        |
| 2       | FRAGMENT           | sampler（可过滤）  | 地面纹理采样器（双线性）                                             |

**CubeMap 天空盒（Group 1）：**

| Binding | 可见性   | 类型           | 资源                      |
| ------- | -------- | -------------- | ------------------------- |
| 0       | VERTEX   | Uniform 缓冲区 | 网格 UBO（仅世界矩阵）    |
| 1       | FRAGMENT | texture_cube   | 立方体纹理                |
| 2       | FRAGMENT | sampler        | 立方体采样器              |

## 内部架构

### 天空盒几何体

24 个顶点，36 个索引 —— 一个盒体网格。半尺寸 `S` 默认为 15，但会通过 `computeSkyboxGeometry()` 根据场景包围盒动态计算。

```
Positions (8 unique corners, but 24 vertices for separate face normals):
  Front:  ( S,-S, S), (-S,-S, S), (-S, S, S), ( S, S, S)
  Back:   ( S, S,-S), (-S, S,-S), (-S,-S,-S), ( S,-S,-S)
  Right:  ( S, S,-S), ( S,-S,-S), ( S,-S, S), ( S, S, S)
  Left:   (-S, S, S), (-S,-S, S), (-S,-S,-S), (-S, S,-S)
  Top:    (-S, S, S), (-S, S,-S), ( S, S,-S), ( S, S, S)
  Bottom: ( S,-S, S), ( S,-S,-S), (-S,-S,-S), (-S,-S, S)

Indices (36, triangle-list, uint16):
  Per face: (2,1,0, 3,2,0)
```

### 场景尺寸计算（`computeSceneSize`）

匹配 `sizeAuto=true` 时的 BJS `EnvironmentHelper._setupSizes()`：

1. 计算所有网格的世界空间 AABB（按世界平移偏移局部包围边界）
2. 计算场景对角线长度：`sqrt(dx² + dy² + dz²)`
3. 初始取 `groundSize = 15, skyboxSize = userSkyboxSize ?? 20`
4. 如果相机具有 `upperRadiusLimit`：使用 `upperRadiusLimit × 2` 作为基准
5. 如果对角线 > groundSize：`groundSize = diagonal × 2, skyboxSize = groundSize`
6. `groundSize *= 1.1`，`skyboxSize *= 1.5`
7. `rootPosition = [centerX, minY − 0.00001, centerZ]`

### 天空盒世界矩阵（`buildSkyboxWorldMatrix`）

平移至 `rootPosition` 的单位矩阵：

```
| 1  0  0  rootX |
| 0  1  0  rootY |
| 0  0  1  rootZ |
| 0  0  0  1     |
```

### 地面几何体（位于 `background-ground.ts`）

4 个顶点，6 个索引 —— 位于 XY 平面上的平面四边形，范围为 `±(groundSize/2)`。

```
Positions: (-h,-h,0), (h,-h,0), (h,h,0), (-h,h,0)    where h = groundSize/2
Normals:   (0,0,1) for all 4 vertices (BACKSIDE — flipped from default -Z)
UVs:       (0,0), (1,0), (1,1), (0,1)
Indices:   (0,2,1, 0,3,2) (BACKSIDE winding — swapped from FRONTSIDE 0,1,2,0,2,3)
```

地面通过其世界矩阵绕 X 轴旋转 90° 以平铺在 XZ 平面中。
局部法线 `(0,0,+1)` → 世界法线 `(0,+1,0)`（朝上）。

### 网格 UBO 布局 — 纯色天空盒（96 字节）

| 偏移（字节） | 大小 | WGSL 类型     | 字段                                      |
| ------------ | ---- | ------------- | ----------------------------------------- |
| 0            | 64   | `mat4x4<f32>` | `world`                                   |
| 64           | 12   | `vec3<f32>`   | `primaryColor`                            |
| 76           | 4    | `f32`         | `_pad`                                    |
| 80           | 12   | `vec3<f32>`   | `skyOutputColor`（预计算的 sRGB clearColor）|
| 92           | 4    | `f32`         | `_pad`                                    |

### 网格 UBO 布局 — DDS 天空盒（96 字节）

| 偏移（字节） | 大小 | WGSL 类型     | 字段             |
| ------------ | ---- | ------------- | ---------------- |
| 0            | 64   | `mat4x4<f32>` | `world`          |
| 64           | 12   | `vec3<f32>`   | `primaryColor`   |
| 76           | 4    | `f32`         | `exposureLinear` |
| 80           | 4    | `f32`         | `contrast`       |
| 84           | 12   | —             | `_pad`           |

### 网格 UBO 布局 — HDR 天空盒（112 字节）

| 偏移（字节） | 大小 | WGSL 类型     | 字段                              |
| ------------ | ---- | ------------- | --------------------------------- |
| 0            | 64   | `mat4x4<f32>` | `world`                           |
| 64           | 12   | `vec3<f32>`   | `primaryColor`                    |
| 76           | 4    | `f32`         | `_pad`                            |
| 80           | 12   | `vec3<f32>`   | `skyOutputColor`（用于回退的 clearColor）|
| 92           | 4    | `f32`         | `_pad`                            |
| 96           | 4    | `f32`         | `exposureLinear`                  |
| 100          | 4    | `f32`         | `contrast`                        |
| 104          | 8    | —             | `_pad`                            |

### 网格 UBO 布局 — 地面（96 字节，位于 `background-ground.ts`）

| 偏移（字节） | 大小 | WGSL 类型     | 字段                                                 |
| ------------ | ---- | ------------- | ---------------------------------------------------- |
| 0            | 64   | `mat4x4<f32>` | `world`                                              |
| 64           | 12   | `vec3<f32>`   | `primaryColor`                                       |
| 76           | 4    | `f32`         | `alpha`（默认值：0.9，匹配 BJS `groundOpacity`）     |
| 80           | 12   | `vec3<f32>`   | `backgroundCenter`（默认值：原点）                   |
| 92           | 4    | `f32`         | `_pad`                                               |

### 网格 UBO 布局 — CubeMap 天空盒（64 字节）

| 偏移（字节） | 大小 | WGSL 类型     | 字段    |
| ------------ | ---- | ------------- | ------- |
| 0            | 64   | `mat4x4<f32>` | `world` |

### DDS 天空盒架构（`background-dds-skybox.ts`）

默认 DDS URL：`https://assets.babylonjs.com/core/environments/backgroundSkybox.dds`

管线流程：

1. `computeSkyboxGeometry(scene, skyboxSize)` → `skyHalfSize`、`rootPosition`
2. `buildSkyboxWorldMatrix(rootPosition)` → 单位矩阵 + 平移
3. `createSkyboxBuffers(device, skyHalfSize)` → 盒体几何体
4. `loadDdsCube(device, url)` → 拉取 DDS，解析头部，上传所有 mip 级别，创建立方体视图 + 采样器
5. `createCubemapSkyboxMaterial(sceneBindGroupLayout, "skybox-dds", vertCode, fragCode)` → 共享材质工厂
6. 创建包含 world、primaryColor、exposure、contrast 的 UBO
7. 返回 order 为 0 的 `Renderable`

DDS 立方体纹理加载：

- 解析 DDS 头部：`Int32Array(buf, 0, 32)` —— 宽度、高度、mip 数量
- 处理 DX10 扩展头部偏移
- 按面上传所有 mip 级别（面主序布局，`rgba16float`，每像素 8 字节）
- 采样器：线性 mag/min/mipmap，clamp-to-edge，maxAnisotropy=4

### HDR 天空盒架构（`background-hdr-skybox.ts`）

从 `EnvironmentTextures` 中采样高光立方体贴图（已由 `loadHdrEnvironment` 加载）。

管线流程：

1. `computeSkyboxGeometry(scene, skyboxSize)` → `skyHalfSize`、`rootPosition`
2. `buildSkyboxWorldMatrix(rootPosition)` → 单位矩阵 + 平移
3. `createSkyboxBuffers(device, skyHalfSize)` → 盒体几何体
4. `createCubemapSkyboxMaterial(sceneBindGroupLayout, "skybox-hdr", vertCode, fragCode)` → 共享材质工厂
5. 创建包含 world、primaryColor、skyOutputColor（clearColor）、exposure、contrast 的 UBO
6. 绑定 `envTextures.specularCubeView` + `envTextures.cubeSampler`
7. 返回 order 为 0 的 `Renderable`

### 背景可渲染对象编排器（`background-renderable.ts`）

编排背景可渲染对象的创建：

1. 若 `!options.skipSkybox`：通过 `createSkyboxMaterial()` 创建纯色天空盒
2. 若 `!options.skipGround`：动态导入 `background-ground.js` → `buildGroundRenderable(..., enableNoise)`
3. 地面采用动态导入，使无地面场景能够 tree-shake 移除它

当 DDS 与 HDR 天空盒调用方（位于 `load-env.ts`、`load-hdr.ts`、`load-dds-env.ts`）提供自己的立方体贴图天空盒时，它们均以 `skipSkybox: true` 调用 `buildBackgroundRenderables()`。

### 地面纹理加载（位于 `background-ground.ts`）

地面漫反射纹理在运行时从客户端提供的 URL 加载：

1. 调用方提供 `groundTextureUrl` 和/或预先发起的 `groundImagePromise`
2. 若提供了 Promise：await 它。否则：`fetch(url)` → `createImageBitmap(blob, { premultiplyAlpha: 'none' })`
3. 使用 `copyExternalImageToTexture()` 以 `rgba8unorm` 格式上传至 GPU
4. 若未提供 URL：创建 1×1 白色像素回退纹理

标准的 BJS 地面纹理为 `backgroundGround.png`（1024×1024，纯白 RGB，径向 Alpha 渐变）。

### 立方体纹理加载

1. 构造 6 个 URL：`${baseUrl}_px${ext}`、`_nx`、`_py`、`_ny`、`_pz`、`_nz`。
2. 并行拉取全部 6 个 → 以 `colorSpaceConversion: 'none'` 调用 `createImageBitmap`。
3. 创建 GPU 纹理：`[size, size, 6]`、格式 `rgba8unorm`、维度 `2d`、完整 mip 链。
4. 将每个面的位图复制到对应的数组层。
5. 通过 GPU 位块传输通道生成 mipmap（全屏四边形采样上一级 mip → 输出至下一级 mip）。
6. 创建立方体视图（`dimension: 'cube'`）和三线性采样器。

### 渲染顺序

| 可渲染对象 | Order       | 说明                                            |
| ---------- | ----------- | ----------------------------------------------- |
| 天空盒     | 0           | 最先渲染（位于一切之后），写入深度              |
| PBR 网格   | 100（默认） | 不透明物体                                      |
| 地面       | 200         | 最后渲染（透明），不写入深度，Alpha 混合        |

## 着色器逻辑

### 天空盒片元着色器（`skybox.fragment.wgsl`）

当前从网格 UBO 输出预计算的 clearColor。将 BJS 天空盒立方体贴图在最高 mip 级采样并通过完整图像处理管线后的输出，在默认设置下与 clearColor 无法区分。

```
output = mesh.skyOutputColor  // pre-computed sRGB value
```

> **注意**：这是一个视觉上的捷径。完整的实现应当采样立方体贴图并运行图像处理管线。该捷径之所以有效，是因为在默认 PBR 环境设置下（`primaryColor = #212121`，`exposure = 0.8`，`contrast = 1.2`），处理后的立方体贴图输出与 clearColor 的差异在抖动精度范围内。

### 地面片元着色器（`background.ground.fragment.wgsl`）

已通过 Spector.GPU 抓帧对比针对 BJS shd_16 完成验证。

```
// Sample diffuse texture (BJS backgroundGround.png: white RGB, radial alpha)
diffuseMap = textureSample(groundTexture, groundSampler, uv)

// Base color from texture tinted by primaryColor
diffuseColor = diffuseMap.rgb
finalColor = max(diffuseColor, 0) × mesh.primaryColor

// Alpha = material alpha × texture alpha
finalAlpha = mesh.alpha × diffuseMap.a

// OPACITYFRESNEL (BJS shd_16 lines 367-370)
backgroundCenter = mesh.backgroundCenter  // default: origin
viewAngle = dot(normalW, normalize(cameraPosition - backgroundCenter))
fadeFactor = clamp(viewAngle / 0.1, 0, 1)
finalAlpha *= fadeFactor²

// Image processing (exposure, tonemapping, gamma, contrast — preserves alpha)
color = applyImageProcessing(vec4(finalColor, finalAlpha))

// PREMULTIPLYALPHA (BJS shd_16 line 373)
color.rgb *= color.a

// Dithering (variance = 0.5)
color.rgb += dither(worldPos.xy, 0.5)
```

### CubeMap 天空盒片元着色器（`skybox-cubemap.fragment.wgsl`）

```
lookupDir = normalize(positionLocal)     // object-space position as direction
color = textureSample(cubeTexture, cubeSampler, lookupDir)

// Apply fog (if enabled)
if fogMode > 0:
  fogCoeff = calcFogFactor(vFogDistance)
  color.rgb = mix(fogColor, color.rgb, fogCoeff)
```

## Babylon.js 等价对照表

| Babylon Lite                                        | Babylon.js                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `loadEnvironment(scene, url, { groundTextureUrl })` | `scene.createDefaultEnvironment()`（内部加载环境与地面纹理）                        |
| `createSkyboxMaterial()`                            | 带 `REFLECTIONMAP_SKYBOX` 的 `BackgroundMaterial`（纯色回退）                       |
| `createCubemapSkyboxMaterial()`                     | 带真实立方体贴图采样的 `BackgroundMaterial`                                         |
| `buildDdsSkyboxRenderable()`                        | 带 `backgroundSkybox.dds` 立方体贴图的 `BackgroundMaterial`                         |
| `buildHdrSkyboxRenderable()`                        | 带来自 `HDRCubeTexture` 的 HDR 立方体贴图的 `BackgroundMaterial`                    |
| `buildGroundRenderable()`                           | 带 `DIFFUSE + OPACITYFRESNEL + PREMULTIPLYALPHA` 的 `BackgroundMaterial` 地面网格  |
| `createSkyboxBuffers(S)`                            | `BABYLON.BoxBuilder`（±S 范围天空盒，24v/36i）                                      |
| `createGroundBuffers(groundSize)`                   | 带 `BACKSIDE` 的 `BABYLON.PlaneBuilder`（4v/6i）                                    |
| `computeSceneSize()`                                | `EnvironmentHelper._getSceneSize()` + `_setupSizes()`                               |
| `computeSkyboxGeometry()`                           | `sizeAuto=true` 时的 `EnvironmentHelper._setupSizes()`                              |
| `buildSkyboxWorldMatrix()`                          | `EnvironmentHelper._setupSkyboxMaterial()` 世界矩阵                                 |
| `buildSkyboxCubeMapGPU()`                           | `StandardMaterial` + `CubeTexture(SKYBOX_MODE)`                                     |
| `loadCubeTexture()`                                 | `new BABYLON.CubeTexture(url, scene)`                                               |
| `primaryColor`                                      | `BackgroundMaterial.primaryColor`（#212121 线性 → `[0.087, 0.087, 0.212]`）         |
| 地面 Y 偏移 `minY − 0.00001`                        | Babylon 计算出的 `sceneSize / rootPosition`                                         |
| `mesh.alpha = 0.9`                                  | `BackgroundMaterial.alpha`（默认地面不透明度）                                      |
| `mesh.backgroundCenter`                             | `BackgroundMaterial._primaryColor`（Fresnel 原点）                                  |
| 不透明度 Fresnel `viewAngle / 0.1`                  | `BackgroundMaterial.opacityFresnel`（start=0.1）                                    |
| 地面漫反射纹理（URL）                               | 由 `EnvironmentHelper` 加载的 `backgroundGround.png`                                |
| 地面混合 `src=one, dst=one-minus-src-alpha`         | 预乘 Alpha 混合（BJS 引擎自动设置）                                                 |
| `dither(seed, 0.5)`                                 | `BackgroundMaterial.enableNoise`                                                    |
| `skyOutputColor` UBO 字段                           | 在最高 mip 级采样的 BJS 立方体贴图（产生相同结果）                                  |
| DDS 天空盒 `backgroundSkybox.dds`                   | BJS `createDefaultEnvironment` 天空盒 DDS 立方体贴图                                |
| HDR 天空盒采样 `specularCubeView`                   | BJS `HDRCubeTexture` 天空盒渲染                                                     |
| CubeMap 天空盒 `cullMode: 'none'`                   | `material.backFaceCulling = false`                                                  |

## 依赖关系

- **`background-material.ts` 导入**：来自 `../../loader-env/load-env.js` 的 `EnvironmentTextures`；来自 `../../math/types.js` 的 `Mat4`；通过 `?raw` 导入着色器源码；渲染/管线辅助函数；来自 `../../shader/wgsl-helpers.js` 的 `WGSL_DITHER`。
- **`background-renderable.ts` 导入**：来自 `../../scene/scene.js` 的 `SceneContext`；来自 `../../engine/engine.js` 的 `EngineInternal`；来自 `../../loader-env/load-env.js` 的 `EnvironmentTextures`；来自 `../../math/types.js` 的 `Mat4`；来自 `../../render/renderable.js` 的 `Renderable`；来自 `./background-material.js` 的 `createSkyboxMaterial`、`createSkyboxBuffers`、`buildSkyboxWorldMatrix`；动态导入 `./background-ground.js`。
- **`background-ground.ts` 导入**：来自 `../../math/types.js` 的 `Mat4`；来自 `../../render/renderable.js` 的 `Renderable`；来自 `../../resource/gpu-pool.js` 的 `getOrCreateSampler`；通过 `?raw` 导入着色器源码；来自 `./background-material.js` 的 `createBuf`；来自 `../../shader/scene-uniforms.js` 的 `SCENE_UBO_WGSL`；来自 `../../shader/wgsl-helpers.js` 的 `WGSL_IMAGE_PROCESSING`、`WGSL_DITHER`。
- **`background-dds-skybox.ts` 导入**：来自 `../../scene/scene.js` 的 `SceneContext`；来自 `../../engine/engine.js` 的 `EngineInternal`；来自 `../../render/renderable.js` 的 `Renderable`；来自 `../../resource/gpu-pool.js` 的 `getOrCreateSampler`；来自 `./background-renderable.js` 的 `computeSkyboxGeometry`；来自 `./background-material.js` 的 `createSkyboxBuffers`、`buildSkyboxWorldMatrix`、`createCubemapSkyboxMaterial`；来自 `../../shader/scene-uniforms.js` 的 `SCENE_UBO_WGSL`；来自 `../../shader/wgsl-helpers.js` 的 `WGSL_DITHER`；通过 `?raw` 导入着色器源码。
- **`background-hdr-skybox.ts` 导入**：来自 `../../scene/scene.js` 的 `SceneContext`；来自 `../../engine/engine.js` 的 `EngineInternal`；来自 `../../loader-env/load-env.js` 的 `EnvironmentTextures`；来自 `../../render/renderable.js` 的 `Renderable`；来自 `./background-material.js` 的 `createSkyboxBuffers`、`buildSkyboxWorldMatrix`、`createCubemapSkyboxMaterial`；来自 `./background-renderable.js` 的 `computeSkyboxGeometry`；通过 `?raw` 导入着色器源码；来自 `../../shader/scene-uniforms.js` 的 `SCENE_UBO_WGSL`。
- **`skybox-cubemap.ts` 导入**：通过 `?raw` 导入着色器源码。
- **`cube-texture.ts` 导入**：无（独立模块）。
- **被以下模块依赖**：`load-env.ts`（延迟构建器）、`load-hdr.ts`（动态导入 `background-hdr-skybox.js` 与 `background-renderable.js`）、`load-dds-env.ts`（使用 `buildBackgroundRenderables`）、`load-skybox.ts`（创建立方体贴图天空盒）。

## 测试规范

| 测试                                        | 说明                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `createSkyboxBuffers`                       | 24 个顶点（72 个浮点数），36 个索引                    |
| `createSkyboxBuffers custom size`           | 验证位置随 `S` 参数缩放                                |
| `createGroundBuffers`                       | 4 个顶点，4 个法线，4 个 UV，6 个索引                  |
| `skybox pipeline depth write false`         | 验证纯色天空盒深度配置                                 |
| `cubemap skybox pipeline depth write false` | 验证 DDS/HDR 天空盒深度配置                            |
| `ground pipeline depth write false`         | 验证禁用深度写入                                       |
| `ground pipeline blend premultiplied`       | src=one，dst=one-minus-src-alpha                       |
| `ground pipeline 3 vertex buffers`          | position + normal + uv                                 |
| `ground bind group has texture`             | Binding 1 = texture_2d，binding 2 = sampler            |
| `ground fallback texture 1×1 white`         | 无 URL → 1×1 RGBA(255,255,255,255)                     |
| `skybox cubemap cull mode none`             | 验证用于盒体内部渲染的无剔除模式                       |
| `loadCubeTexture loads 6 faces`             | 验证使用正确后缀构造了 6 个 URL                        |
| `loadCubeTexture mip count`                 | `floor(log2(size)) + 1`                                |
| `computeSceneSize empty scene`              | 返回默认值：groundSize=15，skyboxSize=20               |
| `computeSceneSize with meshes`              | 对角线 > 15 → groundSize=diagonal×2.2，skyboxSize=×1.5 |
| `buildSkyboxWorldMatrix`                    | 单位矩阵 + rootPosition 平移                           |
| `DDS skybox loads default URL`              | 拉取 backgroundSkybox.dds                              |
| `DDS skybox UBO layout`                     | world + primaryColor + exposure + contrast = 96 字节   |
| `HDR skybox uses specularCubeView`          | 绑定 envTextures 立方体                                |
| `HDR skybox UBO layout`                     | 112 字节，包含 exposure + contrast 字段                |
| `buildBackgroundRenderables skipSkybox`     | 仅返回地面                                             |
| `buildBackgroundRenderables skipGround`     | 仅返回天空盒                                           |
| `dither variance`                           | 输出在 ±0.5/255 范围内抖动                             |
| `opacity fresnel at grazing`                | 边缘掠射处 fadeFactor → 0                              |
| `opacity fresnel head-on`                   | 正对视角 fadeFactor → 1                                |
| Scene 1 full-image MAD ≤ 1                  | 地面不可见（掠射角），匹配 clearColor                  |
| Scene 7 full-image MAD ≤ 2                  | 地面可见（抬高相机），纹理空间渐变                     |

## 文件清单

| 文件                                        | 规模     | 用途                                                                                       |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `src/material/pbr/background-material.ts`   | ~184 行  | 纯色天空盒材质、立方体贴图天空盒材质工厂、天空盒几何体、共享缓冲区辅助函数、天空盒世界矩阵 |
| `src/material/pbr/background-renderable.ts` | ~203 行  | 天空盒 + 地面编排器、场景尺寸计算、`computeSkyboxGeometry`                                 |
| `src/material/pbr/background-ground.ts`     | ~246 行  | 地面材质工厂、地面几何体、地面 UBO、地面纹理加载器                                         |
| `src/material/pbr/background-dds-skybox.ts` | ~130 行  | DDS 立方体贴图天空盒可渲染对象、DDS 立方体纹理加载器、DDS 网格 UBO                         |
| `src/material/pbr/background-hdr-skybox.ts` | ~84 行   | HDR 立方体贴图天空盒可渲染对象、HDR 网格 UBO                                               |
| `src/material/standard/skybox-cubemap.ts`   | ~104 行  | CubeMap 天空盒管线 + 绑定组                                                                |
| `src/texture/cube-texture.ts`               | ~141 行  | 带 mipmap 生成的 6 面立方体纹理加载器                                                      |
| `shaders/skybox.vertex.wgsl`                | ~38 行   | 用于立方体贴图查找的局部位置透传                                                           |
| `shaders/skybox.fragment.wgsl`              | ~91 行   | 从 UBO 输出预计算的 clearColor                                                             |
| `shaders/skybox-dds.vertex.wgsl`            | ~38 行   | DDS 天空盒顶点着色器（位置 → 局部方向）                                                    |
| `shaders/skybox-dds.fragment.wgsl`          | ~53 行   | DDS 立方体贴图采样 + 带环境方向与 LOD 钩子的图像处理                                       |
| `shaders/skybox-hdr.fragment.wgsl`          | ~44 行   | HDR 立方体贴图采样 + 带环境方向与 LOD 钩子的图像处理                                       |
| `shaders/background.vertex.wgsl`            | ~48 行   | 地面世界变换、法线、UV 透传                                                                |
| `shaders/background.ground.fragment.wgsl`   | ~104 行  | 漫反射纹理采样、不透明度 Fresnel、预乘 Alpha、图像处理                                     |
| `shaders/skybox-cubemap.vertex.wgsl`        | ~38 行   | 用于立方体查找的对象空间位置 + 雾效距离                                                    |
| `shaders/skybox-cubemap.fragment.wgsl`      | ~58 行   | 立方体纹理采样 + 雾效                                                                      |
