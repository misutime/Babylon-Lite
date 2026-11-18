# 模块：Loaders（glTF + OpenUSD + .env + HDR + .babylon + 天空盒 + 高斯泼溅）

> 包路径：
>
> - `packages/babylon-lite/src/loader-gltf/load-gltf.ts` — GLB 2.0 加载器
> - `packages/babylon-lite/src/loader-gltf/gltf-feature-camera.ts` — glTF `camera` 节点属性（核心规范，非扩展）
> - `packages/babylon-lite/src/loader-gltf/gltf-ext-basisu.ts` — glTF `KHR_texture_basisu` 功能模块
> - `packages/babylon-lite/src/loader-gltf/gltf-feature-meshopt.ts` + `meshopt-decode.ts` — `EXT_meshopt_compression` 功能模块 + 解码器
> - `packages/babylon-lite/src/loader-gltf/gltf-ext-quantization.ts` — `KHR_mesh_quantization` 功能模块
> - `packages/babylon-lite/src/loader-gltf/gltf-feature-xmp.ts` — `KHR_xmp_json_ld` 元数据功能模块
> - `packages/babylon-lite/src/loader-gltf/gltf-feature-extras.ts` — `ExtrasAsMetadata` 功能模块
> - `packages/babylon-lite/src/loader-gltf/gltf-interleave.ts` — 动态原生交错顶点缓冲区支持（按需惰性构建去步长 CPU 副本）
> - `packages/babylon-lite/src/loader-gltf/gltf-share.ts` — 重复图元 CPU/GPU 几何体共享
> - `packages/babylon-lite/src/loader-usd/` — OpenUSD 命令缓冲区加载器（见 [loader-usd.md](loader-usd.md)）
> - `packages/babylon-lite/src/loader-env/load-env.ts` — Babylon .env 环境加载器
> - `packages/babylon-lite/src/loader-env/load-dds-env.ts` — DDS 立方体贴图环境加载器
> - `packages/babylon-lite/src/loader-env/env-helpers.ts` — 共享环境组装辅助函数
> - `packages/babylon-lite/src/loader-env/rgbd-decode.ts` — 共享 RGBD PNG/立方体贴图解码（GPU 计算）
> - `packages/babylon-lite/src/loader-hdr/load-hdr.ts` — HDR 全景图环境加载器
> - `packages/babylon-lite/src/loader-hdr/hdr-parser.ts` — RGBE CPU 解析器 + 球谐系数提取
> - `packages/babylon-lite/src/loader-hdr/hdr-ibl-pipeline.ts` — GPU 计算 IBL 管线
> - `packages/babylon-lite/src/loader-babylon/load-babylon.ts` — .babylon 场景格式加载器
> - `packages/babylon-lite/src/loader-skybox/load-skybox.ts` — 立方体纹理天空盒加载器
> - `packages/babylon-lite/src/loader-skybox/skybox-renderable.ts` — 天空盒可渲染对象构建器
> - `packages/babylon-lite/src/loader-splat/` — 高斯泼溅加载器（`.ply`、`.splat`、`.sog`、`.spz`）

## 目的

Loaders 模块提供资产加载管线以及动态 glTF 功能模块：

1. **glTF 加载器** —— 解析 `.glb` / `.gltf` 2.0 文件，根据 `extensionsUsed` 和材质/图元内容动态导入功能模块，提取网格几何体（位置、法线、切线、UV、索引），解析节点层级以计算带 RH→LH 转换的世界矩阵，提取 PBR 金属-粗糙度材质数据（纹理 + 因子），并将全部内容上传至 GPU 缓冲区和带 mipmap 的纹理。诸如 `KHR_texture_basisu` 等可选功能位于独立的动态模块中，因此未使用它们的资产无需付出任何运行时字节开销。

2. **环境加载器（.env）** —— 解析 Babylon.js `.env` 文件，将 RGBD 编码的高光立方体贴图各个面解码为 `rgba16float`，通过 GPU 计算从 RGBD 编码的 PNG 解码预烘焙的 BRDF 积分 LUT，提取球谐（SH）辐照度系数，并将所有数据上传至 GPU 纹理。

3. **DDS 环境加载器** —— 加载预过滤的 DDS 立方体贴图环境（`rgba16float`）。直接上传所有 mip 级别，从 mip 0 面数据计算球谐系数，并通过 GPU 计算从 PNG 解码预烘焙的 BRDF LUT。

4. **HDR 环境加载器** —— 加载 Radiance `.hdr`（RGBE）等距柱状全景图。在 CPU 上解析 RGBE 数据并计算球谐系数，通过 GPU 计算将等距柱状图转换为立方体贴图，通过 GPU 计算使用重要性采样 GGX 进行预过滤，并通过 GPU 计算生成 BRDF LUT。

5. **.babylon 格式加载器** —— 解析 Babylon.js `.babylon` 场景文件。支持 Standard 材质（漫反射、凹凸、镜面、环境光、光照贴图、不透明度、反射纹理）、内联顶点数据、点光源、场景清除颜色以及子网格 / 多材质处理。

6. **天空盒加载器** —— 为 StandardMaterial 场景加载 6 面立方体纹理天空盒。注册一个延迟构建器，在引擎启动时创建管线。

7. **高斯泼溅加载器** —— 将 `.ply`、`.splat`、`.sog` 和 `.spz` 泼溅资产加载为 `GaussianSplattingMesh` 实例。SOG 处理 ZIP 打包的 WebP 载荷；SPZ 处理 gzip 封装的二进制流。变换烘焙辅助函数和材质着色器片段分别暴露，因此非泼溅场景零运行时开销。

8. **OpenUSD 加载器** —— 通过 Babylon.js 使用的同一 protocol-v5 OpenUSD WebAssembly 提取器加载合成的 `.usd`、`.usda`、`.usdc` 和 `.usdz` 舞台（stage）。Worker 返回命令/数据缓冲区，经校验后直接物化为 Lite 场景节点、PBR 材质、共享几何体、精简实例、骨骼、变形目标和动画组。有关虚拟文件与所有权契约，请参阅专门的 [USD 加载器架构](loader-usd.md)。

## 公共 API 接口

### `asset-container.ts`

```typescript
/** Unified result returned by both loadGltf() and loadBabylon(). */
export interface AssetContainer {
    /**
     * Scene entities with world transforms (meshes, transform nodes, lights).
     * - glTF: single-element [root TransformNode]; meshes live in its hierarchy.
     * - .babylon: root SceneNodes + LightBase objects in the file.
     */
    entities: Array<SceneNode | LightBase>;

    /** Animation groups from the file. addToScene() auto-ticks them each frame. */
    animationGroups?: AnimationGroup[];

    /** Scene clear color from the file. addToScene() applies it to ctx.clearColor. */
    clearColor?: GPUColorDict;

    /** Camera parsed from the file. addToScene() sets it as scene.camera when present. */
    camera?: Camera;

    /** Every camera declared by the glTF `cameras` array and referenced by a `node.camera`
     *  index, in node-encounter order. See "glTF `camera` Node Property" below. Unlike
     *  `camera`, addToScene() never auto-activates one of these — pick one explicitly and
     *  assign it to `scene.camera`. */
    cameras?: Camera[];

    /** KHR_materials_variants data. Use selectVariant() / getVariantNames() to interact. */
    materialVariants?: MaterialVariantData;

    /** Bone-control handles (one per glTF skin). Populated only after enableBoneControl();
     *  drive bones via getBoneByName() + setBone*(). See module 13 (Skeleton). */
    skeletons?: Skeleton[];
}
```

### 压缩几何体解码器基础 URL（`draco-decode.ts`、`meshopt-decode.ts`）

```typescript
/** Override where draco_decoder.js / draco_decoder.wasm are fetched (default: site root "/"). */
export function setDracoBaseUrl(url: string): void;
/** Override where meshopt_decoder.js is fetched (default: site root "/"). */
export function setMeshoptBaseUrl(url: string): void;
```

两个解码器均在首次使用时通过注入 `<script>` 标签延迟加载其胶水脚本/WASM，因此非 Draco / 非 meshopt 场景开销为零字节。在加载触发对应编解码器的资产之前调用相应的 setter 即可自托管解码器（例如避免跨域 CDN）。等价于 KTX2 的 `setKtx2DecoderUrl`。

### `load-gltf.ts`

```typescript
/** Parsed mesh data ready for GPU upload. */
export interface GltfMeshData {
    positions: Float32Array;
    normals: Float32Array;
    tangents: Float32Array | null;
    uvs: Float32Array;
    indices: Uint16Array | Uint32Array;
    vertexCount: number;
    indexCount: number;
    worldMatrix: Mat4;
    material: GltfMaterialData;
}

/** Parsed PBR material data. */
export interface GltfMaterialData {
    baseColorFactor: [number, number, number, number];
    metallicFactor: number;
    roughnessFactor: number;
    emissiveFactor: [number, number, number];
    baseColorImage: ImageBitmap | null;
    metallicRoughnessImage: ImageBitmap | null;
    normalImage: ImageBitmap | null;
    occlusionImage: ImageBitmap | null;
    emissiveImage: ImageBitmap | null;
}

/** Load a glTF/GLB asset from a URL, ArrayBuffer, or Blob; parse it, upload to GPU. Returns an AssetContainer. */
export async function loadGltf(engine: EngineContext, source: string | ArrayBuffer | Blob): Promise<AssetContainer>;

/** Enable camera import for subsequent loadGltf calls. */
export function enableGltfCameras(): void;
```

> **注意**：`loadGltf` 接收的是 `Engine`（而非 `SceneContext`）并返回一个 `AssetContainer`。结果的 `entities` 数组包含根场景实体；glTF 网格通常挂载在一个根 `TransformNode` 层级下。将该结果传入 `addToScene(scene, result)` —— 它会遍历层级结构、注册动画更新并将所有内容集成到场景中。网格采用标准的 `Mesh` 类型，GPU 数据位于 `_gpu` 字段，包围盒位于 `Mesh.boundMin`/`Mesh.boundMax`。若源 glTF 存在 `mesh.name`，可渲染网格名称会予以保留；父变换节点名称仍保留 glTF 的 `node.name`。
>
> **本地数据**：`source` 可以是 URL `string`，也可以是已加载资产的 `ArrayBuffer`/`Blob`（拖放、OPFS、`fetch` 响应体等）。GLB 与 glTF 通过数据的魔数（magic bytes）探测，**而非**通过 URL 扩展名，因此对象 URL（`blob:…`）与无扩展名来源都能正常加载。`ArrayBuffer`/`Blob` 输入以及不透明的 `blob:`/`data:` URL 字符串没有目录基准，因此必须是自包含的（GLB，或缓冲区/图像使用 `data:` URI 的 glTF）；通过相对路径引用外部 `.bin`/图像文件的 glTF 必须从具有可解析基址的 URL 加载。

### `load-env.ts`

```typescript
/** GPU-resident environment textures. */
export interface EnvironmentTextures {
    specularCube: GPUTexture;
    specularCubeView: GPUTextureView;
    brdfLut: GPUTexture;
    brdfLutView: GPUTextureView;
    cubeSampler: GPUSampler;
    brdfSampler: GPUSampler;
    irradianceSH: Float32Array;
    sphericalHarmonics: {
        l00: Float32Array;
        l1_1: Float32Array;
        l10: Float32Array;
        l11: Float32Array;
        l2_2: Float32Array;
        l2_1: Float32Array;
        l20: Float32Array;
        l21: Float32Array;
        l22: Float32Array;
    };
}

/** Load a Babylon.js .env file, upload cubemap + BRDF LUT to GPU. */
export async function loadEnvironment(
    scene: SceneContext,
    url: string,
    options: {
        brdfUrl: string; // Required: URL of pre-baked BRDF LUT PNG (RGBD-encoded)
        groundTextureUrl?: string; // Optional: URL of ground texture
        skipSkybox?: boolean; // Default: false — skip skybox renderable
        skipGround?: boolean; // Default: false — skip ground plane
        skyboxUrl?: string; // Override skybox texture URL
        skyboxSize?: number; // Default: 1000 — skybox cube half-size
    }
): Promise<EnvironmentTextures>;
```

### `procedural-sky-environment.ts`

```typescript
export interface ProceduralSkyEnvironmentOptions {
    readonly sunDirection: readonly [number, number, number];
    readonly luminance: number;
    readonly turbidity: number;
    readonly rayleigh: number;
    readonly mieCoefficient: number;
    readonly mieDirectionalG: number;
}

export interface ProceduralSkyEnvironmentLoadOptions extends ProceduralSkyEnvironmentOptions {
    readonly brdfUrl: string;
}

export interface ProceduralSkyEnvironment {
    // GPU state is internal and removed from the public declaration.
}

export function computeProceduralSkySunColor(options: ProceduralSkyEnvironmentOptions): [number, number, number];
export function loadProceduralSkyEnvironment(scene: SceneContext, options: ProceduralSkyEnvironmentLoadOptions): Promise<ProceduralSkyEnvironment>;
export function updateProceduralSkyEnvironment(environment: ProceduralSkyEnvironment, options: ProceduralSkyEnvironmentOptions): Promise<boolean>;
```

这个可选加载器在场景注册前创建场景的初始环境，且仅加载由 `brdfUrl` 提供的 BRDF LUT；它会拒绝已有环境的场景和已注册的场景，而不是静默替换已绑定的立方体视图。它将 Babylon.js `SkyMaterial` 的大气辐射度渲染到一个 128×128 六面 `rgba16float` 反射探针立方体中，生成常规面 mipmap，设置 `lodGenerationScale = 0`，并使用与 Babylon.js 完全相同的立方体贴图立体角积分、渲染目标行朝向、余弦卷积、Lambert 归一化以及多项式转换来计算探针的球谐多项式。由于反射目标具有 `gammaSpace = false`，探针像素在存储前会转换到线性空间。

更新操作保留环境对象、立方体视图和球谐数组的引用标识。辐照度积分会在固定每八行分块后让出控制权，并使用“最新胜出（latest-wins）”的版本号取消机制；只有完整跑完的当前计算才会原子提交立方体更新并发布匹配的漫反射系数。当更新被更新的调用取代时，布尔返回值为 `false`。
加载操作在首个 await 之前会预留一个场景局部世代号；并发的第二次加载会被拒绝。在异步辐照度/BRDF 工作以及延迟解码器导入之后，都会检查世代号与场景状态。销毁、场景注册或竞争环境会取消挂起的加载。其位图及局部申请的纹理/缓冲区都会被释放，包括在另一操作已失败后才到达的位图。失败的加载会移除其预留占位，使存活场景可以重试。

挂起的清理回调在加载开始前注册，并成为已提交环境的清理回调，而不会追加到已销毁的场景上。清理操作在释放资源前会将返回的句柄标记为已销毁。更新操作会同时拒绝已销毁的句柄以及不再拥有该场景环境的句柄（包括在辐照度积分期间被销毁）；仅被更新一次的更新取消时仍返回 `false`。每次操作都会对其选项进行快照，使 GPU 参数与辐照度始终描述同一个请求，即使调用方拥有的输入随后被修改。
Henyey-Greenstein 求值将其方向参数限幅到 `[-0.999, 0.999]`，并将其余弦输入限幅到 `[-1, 1]`，从而在 CPU 和 WGSL 两条路径中都保持公共 `±1` 端点的有限性。

## 内部架构

### glTF 加载器管线

```
fetch(url) → ArrayBuffer
  ↓
parseGlbContainer(buffer)
  ↓
{ json, binChunk: DataView }
  ↓
loadFeatureModules(json)              // dynamic imports, e.g. KHR_texture_basisu
  ├── preMesh hooks                   // Draco, KTX2 strided FLOAT accessor decode, etc.
  └── material hooks                  // feature-owned texture/material/metadata overrides
  ↓
extractAllMeshes(json, binChunk)       // for each node with mesh
  ├── resolveAccessor() × N             // positions, normals, tangents, UVs, indices
  ├── extractMaterial()                 // PBR factors + textures
  │     └── resolveImage() × 5         // parallel image decode
  └── computeNodeWorldMatrix()         // recursive parent chain + RH→LH root
  ↓
GltfMeshData[]
  ↓
uploadMeshes(device, meshDatas)
  ├── repeated-primitive gate           // dynamically imports gltf-share only when needed
  │     ├── canonicalize CPU geometry   // repeated active nodes retain the same arrays
  │     └── primitive GPU cache         // one MeshGPU upload retained by every active owner
  ├── shared mesh builders              // identical instance assembly on normal/shared paths
  ├── uploadTexture() × 4              // → Texture2D objects (cached per bitmap + sRGB)
  ├── runMatExts()                     // feature-owned material overrides, e.g. KTX2 textures
  ├── createBufferFromData() × 5       // pos, norm, tan, uv, idx
  ├── computeWorldBounds()             // world-space AABB
  └── assemble PbrMaterialProps        // { baseColorTexture, normalTexture, ormTexture, emissiveTexture?, _buildGroup: pbrGroupBuilder }
  ↓
Mesh[] + root TransformNode
  ↓
createAnimationGroups(json, ...)       // extract glTF animations → AnimationGroup[]
  ↓
AssetContainer { entities: [root], animationGroups }
  → returned to caller; addToScene() dispatches entities + registers animation ticks
```

**纹理缓存**：纹理按位图标识 + sRGB 标志进行缓存，以避免重复的 GPU 上传。热路径缓存使用数字键（`bitmapId * 2 + +srgb`），使普通图像 glTF 资产无需承担字符串键开销。功能模块可为扩展拥有的图像源维护各自的缓存。

**几何体共享**：同一个 glTF 网格可能被多个节点实例化。加载器为每对节点/图元创建独立的 Lite `Mesh`，使变换、包围边界、元数据、绕序、蒙皮和变形状态各自独立。普通路径与重复图元路径使用相同的内部网格构建器；延迟加载的 `gltf-share` 模块仅负责规范化不可变几何体、管理所有权以及安装共享恢复逻辑。当从所选/默认 glTF 场景可达的多个实例引用同一不可变图元时，它们共享同一份 `MeshGPU` 和同一份保留的 CPU 属性数组。仅从非活动场景可达的节点会被排除在该共享所有权组之外，因此不会增加活跃几何体的 `_refCount` 或钉住其缓冲区。`MeshGPU` 所有权采用引用计数，因此移除一个活跃实例不会销毁仍被另一实例使用的缓冲区；设备丢失恢复仅重建每份共享几何体一次并保留其所有权计数。

**动画支持**：`loadGltf` 提取 glTF 动画，通过 `createAnimationGroups()` 创建 `AnimationGroup[]`，并在 `AssetContainer.animationGroups` 中返回它们。`addToScene()` 将回放注册到场景所属的动画管理器中。每个组暴露 `currentTime`（秒）、用于按帧跳转的 `goToFrame()`，以及用于检视受影响节点/路径对的轻量级 `targetedAnimations` 元数据。

**glTF 元数据**：`ExtrasAsMetadata` 将源节点、网格、图元和材质的 `extras` 载荷提升到受支持运行时对象的 `metadata.gltf.extras` 上。它作为 glTF 功能模块实现，使不包含元数据的场景无需为元数据拷贝代码付费。

**PBR 材质**：上传期间创建的每个 `PbrMaterialProps` 都包含从 `pbr-material.ts` 导入的 `_buildGroup: pbrGroupBuilder`。

### GLB 容器格式

```
Offset 0:  Header (12 bytes)
  [0..3]   magic: 0x46546C67 ("glTF" LE)
  [4..7]   version: 2
  [8..11]  total length

Offset 12: JSON Chunk
  [0..3]   chunkLength
  [4..7]   chunkType: 0x4E4F534A ("JSON" LE)
  [8..]    UTF-8 JSON

Offset 12+8+jsonLength: BIN Chunk
  [0..3]   chunkLength
  [4..7]   chunkType: 0x004E4942 ("BIN\0" LE)
  [8..]    Binary data
```

### 访问器解析

支持的分量类型：

| 常量             | 值   | TypedArray     |
| ---------------- | ---- | -------------- |
| `FLOAT`          | 5126 | `Float32Array` |
| `UNSIGNED_SHORT` | 5123 | `Uint16Array`  |
| `UNSIGNED_INT`   | 5125 | `Uint32Array`  |
| `UNSIGNED_BYTE`  | 5121 | `Uint8Array`   |

类型 → 分量数：

| 类型     | 分量数 |
| -------- | ------ |
| `SCALAR` | 1      |
| `VEC2`   | 2      |
| `VEC3`   | 3      |
| `VEC4`   | 4      |
| `MAT4`   | 16     |

字节偏移 = `bufferView.byteOffset + accessor.byteOffset`（两者均默认为 0）。

### RH→LH 坐标转换

glTF 使用右手坐标系。Babylon Lite 使用左手坐标系。转换通过根世界矩阵左乘完成（而非在顶点数据中对 Z 取反）：

```typescript
// Root matrix: diag(-1, 1, 1, 1) — negates X axis (left-handed build; the identity in a right-handed build)
const GLTF_ROOT: Mat4 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
```

对于顶层节点：`worldMatrix = GLTF_ROOT × localMatrix`。
对于子节点：`worldMatrix = parentWorldMatrix × localMatrix`。

局部矩阵由 glTF 的 TRS 计算：`composeMat4(translation, rotation, scale)`，或若存在 `node.matrix` 则直接读取。

父节点查找通过线性扫描（`findParent`）完成：遍历所有节点检查 `children` 数组。

### glTF `camera` 节点属性（`gltf-feature-camera.ts`）

属于核心 glTF 2.0 规范 §5.20（并非扩展）—— 节点可以通过 `node.camera` 引用 `cameras[i]`。
功能 ID 为 `_camera`，仅当调用方调用 `enableGltfCameras()` 后才注册，并在资产声明了相机时触发。通用的 `gltf-feature-hooks.ts` 接缝让核心加载器无需理解相机语义即可询问是否有任何显式启用的功能匹配；当未导入启用器时，Rollup 会将该接缝折叠消除。
这填补了 cx20 gltf-test 中 Babylon Lite 的 `:warning: embedded camera` 空白：在此功能之前，`loadGltf` 会静默丢弃 `node.camera`，且无法选择资产的任意内嵌相机。每个被 `node.camera` 索引引用的相机都会被实例化并通过 `AssetContainer.cameras`（按节点遍历遇到顺序）返回，命名取自 glTF 相机定义或未命名时的 `camera{index}`；`AssetContainer.camera`（单数）保持不动。

**对于每个包含 `node.camera !== undefined` 的节点，针对每个相机：**

1. **`fixupNode`** —— 一个插在源节点与相机之间的 `TransformNode`（`createTransformNode`）（绝不修改共享的源节点 —— 同一个 glTF 节点上的兄弟网格若有的话必须保留自身的绕序/缩放）：
    - **手性（Handedness）。** 合成的 `__root__` 节点的 `scale.x = -1`（上述 RH→LH 转换）会翻转相机的手性 —— 镜像的（负行列式）相机世界矩阵会渲染出里外翻转的视图。Babylon.js 自身的 glTF 加载器也遇到同样的问题，并通过在托管相机的 `TransformNode` 上设置 `scaling.x = -1` 来修复（`glTFLoader.ts` 的 `loadNodeAsync`）。
    - `fixupNode` 的缩放为 `(-1/s, 1/s, 1/s)`，其中 `s` 是累计的静态均匀静息姿态缩放。这会在保留实时平移/旋转的同时抵消继承的缩放。
2. **父级。** 当节点可从场景根到达时设置 `fixupNode.parent = nodeMap[nodeIdx]`（常见情况 —— 节点 TRS 动画，无论是经典通道还是 `KHR_animation_pointer`，随后都会通过正常的父级链每帧驱动相机）。不可达时则回退为 `createSceneNodeFromMatrix(name, restWorld)`，镜像了 `KHR_lights_punctual` 在相同情况下的回退逻辑。
3. **相机。** `createFreeCamera({0,0,0}, {0,0,-1})`，父节点设为 `fixupNode`。glTF 相机沿其局部 -Z 轴观察且 +Y 向上；`writeLookAtWorldMat4LHIntoBuffer` 的“+Z 从观察点指向目标点”约定对于位于原点且朝向 `(0,0,-1)` 的观察点正好复现了该局部朝向。fixup 还会抵消静态均匀祖先缩放，使共享的刚体视图逆矩阵依然精确。投影参数保持源 glTF 单位，与 Babylon.js 一致。零缩放、非均匀缩放或带动画的祖先缩放将被拒绝/不支持，而不是以静默错误的视图进行渲染。
4. **投影。** `perspective.yfov → fov`、`.znear → nearPlane`、`.zfar → farPlane`（省略 `zfar` 时以大哨兵值 `1e6` 替代 —— 即 glTF 的“无限远”约定）。正交相机仅在 `def.type === "orthographic"` 时懒加载 `import()` `enableOrthographicCamera`（使纯透视资产无需承担其开销），并将 `xmag`/`ymag` 映射为对称边界 `{ left: -xmag, right: xmag, bottom: -ymag, top: ymag }`。

**已知限制**：一旦启用相机加载，该功能会处理资产中声明的每一个相机。因此包含正交相机的资产即使消费者选用了另一个透视相机，也会拉入 `camera/orthographic.js`。针对 glTF 相机属性的动画（如 `KHR_animation_pointer` 指向 `/cameras/{}/perspective/yfov` 等）尚未接入 —— 仅托管节点的变换会执行动画；相机自身的内参（fov/near/far/正交边界）在加载时固定。

### 纹理上传

`uploadTexture(device, bitmap, srgb, sampler)` 返回一个 `Texture2D`（包含 `texture`、`view`、`sampler`、`width`、`height`）。

| 纹理        | sRGB | 格式              | 创建时机                     |
| ----------- | ---- | ----------------- | ---------------------------- |
| `baseColor` | 是   | `rgba8unorm-srgb` | 始终创建（回退为 1×1 白色）  |
| `normal`    | 否   | `rgba8unorm`      | 始终创建（回退为 1×1 白色）  |
| `ORM`       | 否   | `rgba8unorm`      | 始终创建（回退为 1×1 白色）  |
| `emissive`  | 是   | `rgba8unorm-srgb` | 仅当 glTF 含有自发光图像时   |

sRGB 纹理使用 `rgba8unorm-srgb` 格式，以便 GPU 在采样时执行精确的 sRGB→线性转换。所有纹理均通过 `generateMipmaps()` 生成完整 mip 链。

**静态纹理化基础色因子所有权。** 对于 PNG/JPG 基础色图像，快速与慢速 PBR 组装器均通过 `baseColorFactor = [r, g, b, 1]` 应用线性 RGB 因子；即使源 Alpha 非默认值，白色 RGB 也会省略该可选 uniform。BLEND 与 MASK 仅将源因子 Alpha 保存在材质的 `alpha` 中，因此在 Alpha 之上计算镜面反射之前的不透明度为 `textureAlpha * factorAlpha`，而非 `textureAlpha * factorAlpha²`。MASK 将这单一乘积与 `alphaCutoff` 比较。这镜像了 KTX2 基础色扩展，并同样适用于带采样器的加载、UV 变换和材质变体。

`KHR_materials_unlit` 仅启用无光照着色器；它不得通过 `_unlitColor` 再次应用 glTF 因子。基础色采样已经接收了图像的 RGB uniform、无纹理材质烘焙进现有 1×1 回退纹理中的因子，或 KTX2 扩展提供的因子。用户显式调用的 `setPbrUnlit(material, tint)` 仍作为独立、显式的额外染色存在。

无纹理的静态基础色回退纹理将 RGB 因子存储为 sRGB 字节，但保持其 Alpha 字节为 255。由于 BLEND/MASK 已通过材质应用因子 Alpha，将其烘焙进该回退纹理同样会导致应用两次。因子 0、0.5 和 1 必须产生精确的材质不透明度而不经过 8 位 Alpha 量化；其 RGB 回退字节与纹理所有权保持不变。

`gltf-displaced-fallback-texture.test.ts` 测试了全部四条路径的已加载材质状态，包括真实的非单位 UV 变换、白色/默认因子、BLEND 不透明度、MASK 裁剪阈值以及无光照 PNG/KTX2/纯因子材质。这些 CPU 测试不能替代 GPU 抓帧或场景一致性认证；参考图像与阈值保持不变。

对于每个带有动画 `baseColorFactor` 的材质，`animation-pointer-basecolor.ts` 在材质组装期间提供其因子槽位，包括白色 RGB 以及仅由变体使用的材质。这在渲染计算 PBR 特性之前运行。GLB 回归测试检查该特性位、跨关键帧的同一数组引用、插值、`_uboVersion` 以及生产环境的材质 UBO 写入。
动画化因子同样遵循单一 Alpha 所有权：其 uniform 存储 `[r, g, b, 1]`，而 BLEND/MASK 将当前关键帧/插值 Alpha 存储在 `material.alpha` 中。OPAQUE 保持该属性缺失并忽略因子 Alpha。指针写入器会一并更新每个运行时副本的现有因子数组和材质 Alpha，然后递增该副本的 `_uboVersion` 一次。

带有动画的材质定义拥有以弱引用为键的运行时材质副本分组。动画功能在解析后的材质数据上安装一个可选的 `_onMaterialCreated` 回调；共享的 PBR 后组装辅助函数会同时为默认材质和变体材质调用它。指针通道捕获的是活跃分组，而非单个默认材质。变体组装与动画解析并发运行，因此当仅用于变体的指针解析时该分组可能仍为空，并在返回已加载资产前完成填充。后续的变体选择会使用当前的动画值，而已选中的副本在每次动画写入时都会收到 UBO 失效通知。原始 glTF 因子元组既不与运行时槽位共享，也不会被修改。

`animation-pointer-basecolor.ts` 为无纹理的动画化因子提供白色回退。在将解析出的因子替换为白色之前，它先将原始 RGB 与 BLEND/MASK Alpha 保存在扩展层中，因此无论是初始加载还是后续帧都不会出现颜色加倍或重置不透明度的情况。缺失的纹理槽位同样以 Alpha 1 而非源 Alpha 初始化。

真实 GLB 测试覆盖 PNG、KTX2 和无纹理回退、OPAQUE/BLEND/MASK、有色/白色初始 RGB、加载时刻值、关键帧与插值，包括所有运行时副本以及推进前后的实际变体选择。因子 Alpha 遍历 0、0.5 和 1 而不会改变 RGB 槽位标识或绕过生产 UBO 写入器。这些测试仅验证 CPU 状态，不验证渲染像素。

ORM 打包遵循 glTF 约定：

- **R** = 环境光遮蔽（Ambient Occlusion）
- **G** = 粗糙度（Roughness）
- **B** = 金属度（Metallic）

如果仅存在 `metallicRoughnessImage` 或 `occlusionImage` 之一，则直接将其用作 ORM 纹理（在 glTF 中它们可能是同一张图像）。

### `KHR_texture_basisu` / KTX2 纹理源

`KHR_texture_basisu` 实现是一个 glTF 功能模块，而非核心加载器逻辑：

```
extensionsUsed includes "KHR_texture_basisu"
  ↓
dynamic import("./gltf-ext-basisu.js")
  ↓
preMesh(json, binChunk, baseUrl)
  ├─ marks materials that reference KTX2 images
  ├─ strips KTX2 textureInfos before core image parsing
  └─ deinterleaves strided FLOAT vertex accessors when needed by the KTX2 asset
  ↓
core material parse runs with non-KTX2 textureInfos only
  ↓
applyMaterial(mat, ctx)
  ├─ fetches KTX2 bytes from image.uri or bufferView
  ├─ uploadKtx2Texture2D(ctx.engine, bytes, sRGB)
  ├─ composes ORM when metallic-roughness and occlusion are distinct KTX2 images
  └─ returns Partial<PbrMaterialProps> with feature-owned Texture2D values
```

设计约束：

- 核心材质解析器或 PBR 渲染器中没有任何 `KHR_texture_basisu` 分支。
- 仅通过 `gltf-ext-basisu.ts` 访问 `ktx2-loader.ts`。
- 仅在遇到 KTX2 资产后才懒加载 Babylon KTX2 解码器脚本。
- 核心纹理缓存键仍基于 ImageBitmap；KTX2 功能模块按 glTF 纹理索引和 sRGB 标志缓存。
- 场景 112（`FlightHelmetKTX`）验证了该路径，且在存在 KTX2 支持时现有场景的运行时包体积增量为零。

### 交错顶点缓冲区（`gltf-interleave.ts`）

glTF 允许多个顶点属性共享同一个带有非零 `byteStride` 的 `bufferView`（交错布局）。Babylon Lite **在 GPU 层面**支持这一特性，而不是在加载时重写资产：

```
primitive has a strided (byteStride > 0), non-decoded accessor
  ↓
dynamic import("./gltf-interleave.js")   // never fetched by tight-only scenes
  ↓
buildInterleavedPartial(json, binChunk, attrs)
  ├─ records each strided attribute's { bufferView slice, offset, stride }
  └─ resolves tight attributes directly
  ↓
uploadMeshes binds the ONE raw bufferView slice to every attribute slot at the
attribute's byte offset with pipeline arrayStride = byteStride
```

设计约束：

- **无 CPU 去交错 / 资产重写。** 原始交错字节仅上传一次，并绑定到每个属性槽位 —— 由 GPU 负责按步长读取。
- **去步长的 CPU 副本是惰性的。** `installLazyCpu()` 将 `_cpuPositions/_cpuNormals/_cpuUvs` 定义为带缓存的 getter，仅在首次访问时才执行去步长；从未执行过拾取 / CSG / 导航的网格永远不会物化这些副本。
- **对非交错场景零开销。** 整个模块按需动态导入，且仅当遇到真正带步长且未经过解码的图元时才会加载。已解码路径（Draco、`KHR_texture_basisu` 去步长）会绕过它。
- 由场景 210（`XmpMetadataRoundedCube`，真正交错存储）验证。

逐属性正确性（每一项都曾是真实的一致性 bug —— 场景 246/247）：

- **`COLOR_0`** 不能直接在 GPU 上按步长读取：glTF 允许 VEC3/VEC4 以及/或归一化的 `UNSIGNED_BYTE`/`SHORT`，但管线仅绑定单一的 `float32x4` 布局。将 ubyte/VEC3 源绑定为 `float32x4` 会把相邻字节当作浮点数读取（产生彩虹噪点）。`resolveColorVec4` 始终将 `COLOR_0` 去步长并归一化为紧凑的 `float32x4`（rgb 调制基础色，**a 调制片元 Alpha** —— 顶点颜色 Alpha 裁剪/混合；VEC3 源则补 `a = 1`）。
- **缺失的 `NORMAL`** 必须合成生成，绝不能填零 —— 零法线会导致 `normalize(0)` = NaN → 纯黑光照片元。`buildInterleavedPartial` 调用调用方提供的 `computeSmoothNormals`（仅在缺失 NORMAL 时懒加载导入）。网格还会被标记为 `_flatNormal`，使 PBR 着色器通过屏幕空间 `worldPos` 导数对其进行平面着色（glTF 规范：无 `NORMAL` → 平面着色），与 BJS 一致 —— 见 `material/pbr/fragments/flat-normal-wgsl.ts`（懒加载；否则零字节）。
- **`JOINTS_0`/`WEIGHTS_0`** 由 `gltf-feature-skeleton.ts` 而非本模块通过 `resolveAccessor` 读取 —— 该函数假定紧凑打包。若蒙皮骨架将其与 `byteStride` 交错存放，需在那里通过 `resolveAttr` 去步长，否则半数关节索引/权重会读到填充字节导致网格炸裂或姿态错乱。

### `EXT_meshopt_compression` + `KHR_mesh_quantization`（`gltf-feature-meshopt.ts`、`gltf-ext-quantization.ts`）

`EXT_meshopt_compression` 的 bufferView 在访问器解析之前由动态导入的 meshopt 解码器（`meshopt-decode.ts`）解码；`KHR_mesh_quantization` 允许归一化/量化属性格式直接原生上传。两者均为动态功能模块，因此非 meshopt 场景零运行时字节开销。已由场景 211（`BrainStem` glTF-Meshopt-EXT，带蒙皮与动画）验证。

**未归一化的量化 `TEXCOORD_n`/`POSITION`（场景 220，`Duck` `glTF-Quantized`）。**
`KHR_mesh_quantization` 允许 `TEXCOORD_n`（VEC2）和 `POSITION`（VEC3）作为**未归一化的**无符号整数访问器（没有 `normalized: true`）—— 根据扩展规范，未归一化整数 `2` 意味着字面值 `2.0`，而非 `2/65535`；资产随后通过节点 TRS（`POSITION`）或材质上的 `KHR_texture_transform`（`TEXCOORD_n`；gltfpack 的标准量化 UV 输出）将其缩回真实单位。核心加载器的紧凑/交错 UV 和顶点路径始终假定无符号整数源意味着“除以 255/65535”，因此绝不能让此类访问器未经转换就进入这些路径。

该修复完全位于 `gltf-ext-quantization.ts` 的 `preParse` 重写逻辑内（不改动核心 UV/颜色解码器）：触发谓词从“无符号未归一化整数、非 VEC4、且带步长”放宽为“无符号未归一化整数 VEC2/VEC3，紧凑或带步长均可”—— 根据该扩展的属性表，未归一化无符号整数存储仅对这两种形状有效，因此 SCALAR（索引）与 VEC4（`JOINTS_n`）无论如何都会被正确排除。这正好捕获了量化版 Duck 的 `TEXCOORD_0`：一个**紧凑的** `UNSIGNED_SHORT` VEC2 访问器（`byteStride` 等于其自身紧凑尺寸），此前基于步长门控的谓词将其未转换地放行了。由于重写发生在 `preParse` 阶段 —— 早于任何访问器读取 —— 到达 `load-gltf.ts`、`gltf-color-normalize.ts`、`gltf-interleave.ts` 和 `gltf-uv-denorm.ts` 时，所有未归一化整数 `TEXCOORD`/`POSITION` 都已转换为 `FLOAT`，因此这些核心/共享模块完全无需了解 `normalized`：它们保留了原有的“整数 ⇒ 已归一化”假设，而现在该假设对流入其中的任何整数数据都成立。这将修复的全部字节占用保持在已经按需动态导入的 `KHR_mesh_quantization` 功能模块内 —— 不使用该扩展的场景所获取的任何模块均零字节新增。已由场景 220（`Duck` `glTF-Quantized`，未归一化 `UNSIGNED_SHORT` VEC2 `TEXCOORD_0` 结合 `KHR_texture_transform`）以及 `gltf-ext-quantization.test.ts` 验证，后者直接针对紧凑未归一化、步长未归一化、保持归一化、SCALAR 索引以及 VEC4 关节等情况测试了 `preParse` 钩子。

### `KHR_xmp_json_ld` 元数据（`gltf-feature-xmp.ts`）

纯元数据，无任何渲染效果：该功能的 `applyAsset` 钩子将文档级 JSON-LD 数据包（以及 `asset` 引用的数据包）暴露在 `AssetContainer.xmpMetadata = { packets, assetPacket }` 上。仅当 `extensionsUsed` 列出 `KHR_xmp_json_ld` 时才动态导入。已由场景 210 验证。

### 包围盒计算

通过将每个顶点位置乘以世界矩阵来计算世界空间 AABB：

```
for each vertex (lx, ly, lz):
  wx = world[0]*lx + world[4]*ly + world[8]*lz  + world[12]
  wy = world[1]*lx + world[5]*ly + world[9]*lz  + world[13]
  wz = world[2]*lx + world[6]*ly + world[10]*lz + world[14]
  update min/max
```

### 共享采样器

在单次 `uploadMeshes()` 调用内创建并在所有 `Texture2D` 对象间共享一个采样器：`magFilter: linear, minFilter: linear, mipmapFilter: linear, addressMode: repeat`（U 和 V 均为 repeat）。采样器存储在每个 `Texture2D.sampler` 中。

---

### 环境加载器管线

```
fetch(url) → ArrayBuffer
  ↓
parseEnvFile(buffer)
  ├── Validate 8-byte magic: [0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36]
  ├── Parse JSON manifest (UTF-8, null-terminated after magic)
  ├── Extract irradiance SH (9 vec3 = 27 floats from manifest.irradiance)
  └── Extract face image blobs (mip0_face0..5, mip1_face0..5, ...)
  ↓
{ faceBlobs[], irradianceSH, width, mipCount }
  ↓
createImageBitmap() × N faces (parallel, premultiplyAlpha:'none', colorSpaceConversion:'none')
  ↓
uploadCubemapRGBD(device, images, width, mipCount)
  ↓
GPUTexture (rgba16float cubemap)
  ↓
fetch(options.brdfUrl) + decodeBrdfPng(device, png) → 256×256 rgba16float BRDF LUT (GPU compute)
  ↓
polynomialToPreScaledHarmonics(irradianceSH) → pre-scaled SH for shader
  ↓
EnvironmentTextures → stored on scene._envTextures
```

### .env 文件格式

```
[0..7]     Magic: 86 16 87 96 F6 D6 96 36
[8..N]     JSON manifest (UTF-8, null terminated)
[N+1..]    Binary image data (PNG/JPEG face images)
```

JSON 清单字段：

- `width`：基础立方体贴图面尺寸
- `irradiance`：包含键 `x,y,z,xx,yy,zz,yz,zx,xy` 的对象 → 每个键值为 `[r,g,b]`
- `specular.mipmaps`：`{ position, length }` 字节范围数组
- `imageType`：MIME 类型（默认 `"image/png"`）

### RGBD 解码

每个面图像均为 RGBD 编码。解码为线性 HDR：

```
r_linear = pow(r_srgb, 2.2) / max(alpha, 1/255)
g_linear = pow(g_srgb, 2.2) / max(alpha, 1/255)
b_linear = pow(b_srgb, 2.2) / max(alpha, 1/255)
a_out    = 1.0
```

该过程使用 GPU 暂存以避免 Canvas 2D 预乘 Alpha 破坏数据：

1. 上传 `ImageBitmap` → 临时 `rgba8unorm` 纹理
2. 将纹理复制到暂存缓冲区（256 字节行对齐）
3. 映射暂存缓冲区供 CPU 读取
4. 在 CPU 上执行 RGBD 解码并进行 Y 轴翻转（Babylon 以 `invertY=true` 上传）
5. 将解码后的 `float16` 数据上传至最终的 `rgba16float` 立方体贴图对应层

### Float16 转换（`floatToHalf`）

通过位操作实现 IEEE 754 binary16 转换：

```
sign     = (float32_bits >>> 16) & 0x8000
exponent = ((float32_bits >>> 23) & 0xFF) - 127 + 15
mantissa = (float32_bits >>> 13) & 0x03FF
```

处理非规格化数、溢出（→ 无穷大）和 NaN。

### BRDF LUT 生成

> **关于 `.env` 和 DDS 加载器的说明**：环境加载器不再通过 CPU 计算 BRDF LUT。它们使用 `rgbd-decode.ts` 中的 GPU 计算从通过 `options.brdfUrl` 提供的 RGBD 编码 PNG 解码预烘焙的 BRDF LUT。下述 CPU/GPU 计算算法仅适用于 **HDR 加载器**（`hdr-ibl-pipeline.ts`）。

GPU 计算 Split-Sum 积分（256×256，`rgba16float`，HDR 路径）：

对于每个纹素 `(x, y)`：

```
NdotV     = max((x + 0.5) / 256, 0.001)
roughness = max((y + 0.5) / 256, 0.04)
[A, B]    = integrateBRDF(NdotV, roughness, 1024 samples)
```

输出约定（Babylon）：

- **R** = `B`（Fresnel 偏置项）
- **G** = `A + B`（缩放 + 偏置）
- 着色器用法：`F0 × A + B = F0 × (brdf.g - brdf.r) + brdf.r`

#### `integrateBRDF` 算法

Hammersley 序列 + 重要性采样 GGX：

```
for i in 0..1024:
  xi0 = i / sampleCount
  xi1 = radicalInverseVdC(i)          // Van der Corput
  H = importanceSampleGGX(xi0, xi1, roughness⁴)
  VdotH = max(V·H, 0)
  Lz = 2 × VdotH × H.z - V.z          // reflect(-V, H).z = NdotL
  NdotL = max(Lz, 0)
  NdotH = max(H.z, 0)

  if NdotL > 0 and NdotH > 0:
    // Smith height-correlated visibility
    GGXV = NdotL × √(NdotV² × (1-a2) + a2)
    GGXL = NdotV × √(NdotL² × (1-a2) + a2)
    V_Vis = 0.5 / max(GGXV+GGXL, 1e-6) × NdotL × 4×VdotH/NdotH
    Fc = (1 - VdotH)⁵
    A += (1 - Fc) × V_Vis
    B += Fc × V_Vis

return [A/1024, B/1024]
```

#### `importanceSampleGGX`

```
phi = 2π × xi0
cosTheta = √((1 - xi1) / (1 + (a2 - 1) × xi1))
sinTheta = √(1 - cosTheta²)
return [cos(phi) × sinTheta, sin(phi) × sinTheta, cosTheta]
```

#### `radicalInverseVdC`

Van der Corput 基反演（位反转）：

```
bits = input >>> 0
bits = ((bits << 16) | (bits >>> 16)) >>> 0
bits = ((bits & 0x55555555) << 1) | ((bits & 0xAAAAAAAA) >>> 1)   // swap odd/even
bits = ((bits & 0x33333333) << 2) | ((bits & 0xCCCCCCCC) >>> 2)   // swap pairs
bits = ((bits & 0x0F0F0F0F) << 4) | ((bits & 0xF0F0F0F0) >>> 4)   // swap nibbles
bits = ((bits & 0x00FF00FF) << 8) | ((bits & 0xFF00FF00) >>> 8)   // swap bytes
return bits × 2.3283064365386963e-10                               // / 2^32
```

### 球谐系数转换

从 Babylon.js 多项式表示（27 个浮点数：x,y,z,xx,yy,zz,yz,zx,xy）转换为着色器使用的预缩放球谐系数。

**第 1 步：`FromPolynomial`**（匹配 Babylon.js `SphericalHarmonics.FromPolynomial()`）：

```
K00 = 0.376127,  K1 = 0.977204,  K2 = 1.16538
K20_zz = 1.34567, K20_xy = 0.672834

L00   = (xx×K00 + yy×K00 + zz×0.376126) × π
L1_-1 = y × (-K1) × π
L10   = z × K1 × π
L11   = x × (-K1) × π
L2_-2 = xy × K2 × π
L2_-1 = yz × (-K2) × π
L20   = (zz×K20_zz - xx×K20_xy - yy×K20_xy) × π
L21   = zx × (-K2) × π
L22   = (xx - yy) × K2 × π
```

**第 2 步：`preScaleForRendering`**（SH 基函数系数）：

```
B00  = √(1/(4π)),      B1m = -√(3/(4π)),     B1p = √(3/(4π))
B21  = -√(15/(4π)),     B22 = √(15/(16π))

output_L00   = raw_L00 × B00
output_L1_-1 = raw_L1_-1 × B1m
...etc
```

## Babylon.js 等价对照表

| Babylon Lite                                                          | Babylon.js                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `addToScene(scene, await loadGltf(engine, url))`                      | `BABYLON.SceneLoader.Append(url, scene)`                                            |
| `Mesh`（带 `_gpu` 字段）                                              | 内部网格表示                                                                        |
| `GLTF_ROOT`                                                           | 根节点旋转 `[0,1,0,0]` + 缩放 `[1,1,-1]`                                            |
| `loadEnvironment(scene, url, { brdfUrl })`                            | `scene.environmentTexture = new BABYLON.CubeTexture.CreateFromPrefilteredData(url)` |
| `.env` 文件格式                                                       | Babylon 专有环境文件                                                                |
| RGBD 解码                                                             | Babylon 中的 `FromRGBD` 着色器                                                      |
| `generateBrdfLut()`（GPU 计算，RGBD PNG 解码，位于 rgbd-decode.ts）   | Babylon 自带预烘焙 BRDF LUT（也支持运行时生成）                                     |
| `polynomialToPreScaledHarmonics()`                                    | `SphericalHarmonics.FromPolynomial()` + `preScaleForRendering()`                    |
| `uploadCubemapRGBD()`                                                 | `HDRCubeTexture` 中的内部立方体贴图处理                                             |
| `KHR_texture_basisu` 功能 + `uploadKtx2Texture2D()`                   | BJS `KHR_texture_basisu` 加载器 + `KTX2Decoder` 纹理上传                            |
| 暂存缓冲区 RGBD 解码                                                  | 避免 Canvas 2D 预乘问题                                                             |
| `loadDdsEnvironment(scene, url, opts)`                                | 使用 DDS 文件的 `BABYLON.CubeTexture.CreateFromPrefilteredData(url)`                |
| `computeSH()`（从 DDS mip 0）                                         | 立方体贴图上的 BJS `SphericalPolynomial.FromHarmonics`                              |
| `decodeBrdfPng()`                                                     | BJS 内嵌 `environmentBRDFTexture`（RGBD PNG）                                       |
| `loadHdrEnvironment(scene, url, opts)`                                | `new BABYLON.HDRCubeTexture(url, scene)`                                            |
| `parseRGBE()`                                                         | BJS `HDRTools.GetCubeMapTextureData()`                                              |
| `computeSHFromEquirect()`                                             | BJS `SphericalPolynomial.FromEquirectangular()`                                     |
| `equirectToCubemapGPU()`                                              | BJS `panoramaToCubemap.ts` CPU 转换                                                 |
| `prefilterCubemapGPU()`                                               | BJS `hdrFiltering.ts` GPU 预过滤                                                    |
| `generateBrdfLut()`（GPU 计算，位于 hdr-ibl-pipeline.ts）             | BJS 基于计算的 BRDF LUT                                                             |
| `loadBabylon(engine, url)`                                            | `BABYLON.SceneLoader.Load("", url, engine)`                                         |
| `createStandardMaterial()`                                            | `new BABYLON.StandardMaterial("mat", scene)`                                        |
| `loadTexture2D()`                                                     | `new BABYLON.Texture(url, scene)`                                                   |
| `createPointLight()`                                                  | `new BABYLON.PointLight("light", pos, scene)`                                       |
| SubMesh + multiMaterial                                               | `BABYLON.SubMesh` + `BABYLON.MultiMaterial`                                         |
| `loadSkybox(scene, baseUrl, ext, size)`                               | `new BABYLON.CubeTexture(url, scene)` + 天空盒网格                                  |
| `buildSkyboxRenderable()`                                             | BJS `EnvironmentHelper` 中的 `skyboxMaterial` + `skyboxMesh`                        |

## 依赖关系

- **`load-gltf.ts` 导入**：来自 `../engine/engine.js` 的 `EngineContext`；来自 `../math/types.js` 的 `Mat4`；来自 `../math/mat4.js` 的 `composeMat4`、`multiplyMat4`；来自 `../texture/generate-mipmaps.js` 的 `generateMipmaps`、`mipLevelCount`；来自 `../texture/texture-2d.js` 的 `Texture2D`；来自 `../material/pbr/pbr-material.js` 的 `PbrMaterialProps`、`pbrGroupBuilder`；来自 `../animation/animation-group.js` 的 `createAnimationGroups`；来自 `../asset-container.js` 的 `AssetContainer`；包含 `gltf-ext-basisu.ts` 在内的动态 glTF 功能导入。
- **`gltf-ext-basisu.ts` 导入**：来自 `../texture/ktx2-loader.js` 的 `decodeKtx2ImageBitmapFromBuffer`、`uploadKtx2Texture2D`；来自 `./gltf-parser.js` 的 `resolveAccessor`；PBR 与 Texture2D 类型。
- **`load-env.ts` 导入**：来自 `../scene/scene.js` 的 `SceneContext`。
- **`load-dds-env.ts` 导入**：来自 `../scene/scene.js` 的 `SceneContext`、`SceneContextInternal`；来自 `../engine/engine.js` 的 `EngineInternal`；来自 `./load-env.js` 的 `EnvironmentTextures`；来自 `../resource/gpu-pool.js` 的 `acquireGPUTexture`、`releaseGPUTexture`；来自 `./env-helpers.js` 的 `assembleEnvironmentTextures`；动态导入 `./rgbd-decode.js`。
- **`env-helpers.ts` 导入**：来自 `./load-env.js` 的 `EnvironmentTextures`、`polynomialToPreScaledHarmonics`；来自 `../resource/gpu-pool.js` 的 `getOrCreateSampler`。
- **`rgbd-decode.ts` 导入**：来自 `../engine/engine.js` 的 `EngineContextInternal`。
- **`load-hdr.ts` 导入**：来自 `../loader-env/load-env.js` 的 `EnvironmentTextures`；来自 `../scene/scene.js` 的 `SceneContext`、`SceneContextInternal`；来自 `../engine/engine.js` 的 `EngineInternal`；来自 `../resource/gpu-pool.js` 的 `acquireGPUTexture`、`releaseGPUTexture`；来自 `../loader-env/env-helpers.js` 的 `assembleEnvironmentTextures`；来自 `./hdr-parser.js` 的 `parseRGBE`、`computeSHFromEquirect`；来自 `./hdr-ibl-pipeline.js` 的 `equirectToCubemapGPU`、`prefilterCubemapGPU`、`generateBrdfLut`；动态导入 `../material/pbr/background-hdr-skybox.js`、`../material/pbr/background-renderable.js`。
- **`hdr-parser.ts` 导入**：无（独立 CPU 代码）。
- **`hdr-ibl-pipeline.ts` 导入**：来自 `./hdr-parser.js` 的 `HdrImage`；来自 `../resource/gpu-pool.js` 的 `getOrCreateSampler`。
- **`load-babylon.ts` 导入**：来自 `../engine/engine.js` 的 `EngineContext`、`EngineInternal`；来自 `../material/standard/standard-material.js` 的 `createStandardMaterial`、`StandardMaterialProps`；来自 `../mesh/mesh.js` 的 `uploadMeshToGPU`、`initMeshTransform`、`MeshInternal`；来自 `../light/point-light.js` 的 `createPointLight`；来自 `../texture/texture-2d.js` 的 `loadTexture2D`；来自 `../asset-container.js` 的 `AssetContainer`。
- **`load-skybox.ts` 导入**：来自 `../scene/scene.js` 的 `SceneContext`、`SceneContextInternal`；来自 `../engine/engine.js` 的 `EngineInternal`；来自 `../texture/cube-texture.js` 的 `loadCubeTexture`；来自 `../mesh/create-box.js` 的 `createBoxData`；动态导入 `./skybox-renderable.js`。
- **`skybox-renderable.ts` 导入**：来自 `../scene/scene.js` 的 `SceneContext`；来自 `../engine/engine.js` 的 `EngineInternal`；来自 `./load-skybox.js` 的 `SkyboxData`；来自 `../render/renderable.js` 的 `Renderable`；来自 `../material/standard/skybox-cubemap.js` 的 `buildSkyboxCubeMapGPU`。
- **被以下模块依赖**：`pbr-renderable.ts`（消费 `Mesh`）、`index.ts`（类型导出）、场景搭建文件。

## 测试规范

| 测试                                                | 说明                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **glTF**                                            |                                                                                                                                                                          |
| `parseGlbContainer validates magic`                 | 非 GLB 输入抛出异常                                                                                                                                                      |
| `parseGlbContainer extracts JSON + BIN`             | 验证块解析正确                                                                                                                                                           |
| `resolveAccessor FLOAT`                             | 返回具有正确元素数量的 Float32Array                                                                                                                                      |
| `resolveAccessor UNSIGNED_SHORT`                    | 返回 Uint16Array                                                                                                                                                         |
| `GLTF_ROOT negates X`                               | 验证 diag(-1,1,1,1)                                                                                                                                                      |
| `computeNodeWorldMatrix top-level`                  | 左乘 GLTF_ROOT                                                                                                                                                           |
| `computeNodeWorldMatrix child`                      | 父级世界矩阵 × 子级局部矩阵                                                                                                                                              |
| `extractMaterial defaults`                          | 缺失材质 → baseColorFactor [1,1,1,1]，metallic 1，roughness 1                                                                                                            |
| `uploadTexture sRGB format`                         | baseColor 使用 rgba8unorm-srgb                                                                                                                                           |
| `uploadTexture null fallback`                       | 1×1 白色纹理                                                                                                                                                             |
| `computeWorldBounds`                                | 已知位置 × 单位矩阵 → 正确的 AABB                                                                                                                                        |
| `KHR_texture_basisu`                                | 场景 112 FlightHelmetKTX 加载 KTX2 纹理源并在 `maxMad: 0.02` 内匹配 Babylon.js                                                                                           |
| `KHR_texture_basisu bundle isolation`               | 存在 KTX2 支持时，现有场景无正向运行时加载 JS 增量                                                                                                                       |
| `Interleaved vertex buffers`                        | 带步长访问器解析为 GPU 偏移/步长；`gltf-interleave.test.ts` 覆盖步长检测 + 惰性去步长                                                                                    |
| `KHR_xmp_json_ld`                                   | 场景 210 XmpMetadataRoundedCube（真实交错）在 `maxMad: 0.2` 内匹配 Babylon.js；元数据暴露于 `AssetContainer.xmpMetadata`                                               |
| `EXT_meshopt_compression` + `KHR_mesh_quantization` | 场景 211 BrainStem (glTF-Meshopt-EXT) 在 `maxMad: 0.2` 内匹配 Babylon.js                                                                                                 |
| `glTF feature bundle isolation`                     | 非交错 / 非 meshopt / 非 XMP 场景绝不加载对应的动态分块（通过 `coverage:scene` 验证）                                                                                    |
| `glTF camera node property`                         | `gltf-feature-camera.test.ts` —— 显式启用、透视/正交映射、源命名、节点层级挂载、手性修复、继承缩放修复、不可达节点回退。场景 250 VirtualCity 启用相机加载并选择 `camera6`，在 `maxMad: 6.1` 内匹配 Babylon.js；若无此功能则会失败（视图严重畸变或镜像）。 |
| **.env**                                            |                                                                                                                                                                          |
| `.env magic validation`                             | 错误魔数 → 抛出异常                                                                                                                                                      |
| `RGBD decode`                                       | 已知 RGBD 值 → 正确的线性 HDR                                                                                                                                            |
| `floatToHalf`                                       | 1.0 → 0x3C00，0.0 → 0x0000                                                                                                                                               |
| `BRDF LUT dimensions`                               | 256×256，rgba16float                                                                                                                                                     |
| `integrateBRDF NdotV=1 roughness=0.04`              | 已知近似值                                                                                                                                                               |
| `radicalInverseVdC(0)`                              | 返回 0                                                                                                                                                                   |
| `SH conversion roundtrip`                           | 多项式 → 球谐系数匹配 Babylon 参考值                                                                                                                                     |
| **DDS env**                                         |                                                                                                                                                                          |
| `DDS header parsing`                                | 正确提取 width、height、mipCount、dataOffset                                                                                                                             |
| `float16ToFloat32`                                  | 0x3C00 → 1.0，0x0000 → 0.0                                                                                                                                               |
| `computeSH from DDS`                                | 已知立方体贴图数据 → SH 系数匹配 BJS 参考值                                                                                                                              |
| `decodeBrdfPng RGBD`                                | 已知 PNG RGBD 值 → 正确的 rgba16float 输出                                                                                                                               |
| **HDR**                                             |                                                                                                                                                                          |
| `parseRGBE validates signature`                     | 缺少 `#?` → 抛出异常                                                                                                                                                     |
| `parseRGBE unsupported format`                      | 非 `32-bit_rle_rgbe` → 抛出异常                                                                                                                                          |
| `parseRGBE resolution parsing`                      | 正确提取宽高                                                                                                                                                             |
| `rgbeToFloat e=0`                                   | 返回 (0,0,0)                                                                                                                                                             |
| `rgbeToFloat known values`                          | `[128, 128, 128, 136]` → `(128, 128, 128)`                                                                                                                               |
| `computeSHFromEquirect`                             | 已知等距柱状图数据 → SH 匹配参考值                                                                                                                                       |
| `equirectToCubemapGPU output format`                | rgba16float，faceSize × faceSize × 6                                                                                                                                     |
| `prefilterCubemapGPU mip count`                     | floor(log2(faceSize)) + 1 级 mip                                                                                                                                         |
| `generateBrdfLut dimensions`                        | 256×256，rgba16float                                                                                                                                                     |
| **.babylon**                                        |                                                                                                                                                                          |
| `loadBabylon clearColor`                            | 从 JSON 设置场景 clearColor                                                                                                                                              |
| `loadBabylon materials`                             | 正确提取 Standard 材质属性                                                                                                                                               |
| `loadBabylon textures`                              | 纹理 URL 相对于基 URL 解析                                                                                                                                               |
| `loadBabylon multiMaterial`                         | SubMesh materialIndex 映射到正确的子材质                                                                                                                                 |
| `loadBabylon point lights`                          | 位置、强度、漫反射、镜面反射、照射范围                                                                                                                                   |
| `loadBabylon mesh transform`                        | 通过 initMeshTransform 应用位置/旋转/缩放                                                                                                                                |
| `loadBabylon maxMeshes`                             | 遵守网格数量上限                                                                                                                                                         |
| `loadBabylon invisible mesh`                        | isVisible=false 时跳过                                                                                                                                                   |
| **Skybox**                                          |                                                                                                                                                                          |
| `loadSkybox registers SkyboxData`                   | 填充 scene.\_skybox                                                                                                                                                      |
| `loadSkybox deferred builder`                       | UBO 尚未就绪时重新入队构建器                                                                                                                                             |
| `buildSkyboxRenderable order 0`                     | 渲染于所有物体之后                                                                                                                                                       |

## 文件清单

| 文件                                     | 规模     | 用途                                                                   |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `src/loader-gltf/load-gltf.ts`           | ~413 行  | GLB 解析、网格提取、纹理上传、世界矩阵计算                             |
| `src/loader-gltf/gltf-feature-camera.ts` | ~110 行  | glTF `camera` 节点属性 —— 透视/正交导入、手性 + 缩放修正               |
| `src/loader-env/load-env.ts`             | ~470 行  | .env 解析、RGBD 解码、BRDF LUT 上传、SH 转换                           |
| `src/loader-env/load-dds-env.ts`         | ~286 行  | DDS 立方体贴图加载器、float16 SH 提取、BRDF PNG 解码编排               |
| `src/loader-env/env-helpers.ts`          | ~34 行   | 共享采样器创建、`EnvironmentTextures` 组装                             |
| `src/loader-env/rgbd-decode.ts`          | ~125 行  | 共享 GPU 计算 RGBD PNG/立方体贴图 → rgba16float 解码                   |
| `src/loader-hdr/load-hdr.ts`             | ~102 行  | HDR 环境加载器编排器、延迟背景构建器                                   |
| `src/loader-hdr/hdr-parser.ts`           | ~218 行  | RGBE CPU 解析器、RLE 扫描线解码器、等距柱状图 SH 计算                  |
| `src/loader-hdr/hdr-ibl-pipeline.ts`     | ~400 行  | GPU 计算：等距柱状图→立方体贴图、GGX 预过滤、BRDF LUT 生成             |
| `src/loader-babylon/load-babylon.ts`     | ~428 行  | .babylon JSON 解析器、Standard 材质、灯光、网格上传                    |
| `src/loader-skybox/load-skybox.ts`       | ~96 行   | 立方体纹理加载器 + 延迟天空盒注册                                      |
| `src/loader-skybox/skybox-renderable.ts` | ~32 行   | 包装 skybox-cubemap 材质的天空盒可渲染对象构建器                       |
| `src/texture/generate-mipmaps.ts`        | ~141 行  | GPU mipmap 位块传输（共享工具）                                        |
