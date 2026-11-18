# 模块：Babylon 加载器（Loader Babylon）

> 包路径：`packages/babylon-lite/src/loader-babylon/`

## 目的

解析 Babylon.js `.babylon` 场景文件并返回包含网格、标准材质、点光源和场景级设置的 `AssetContainer`。调用者将结果传给 `addToScene(scene, result)` 以填充 `SceneContext`。为在 Babylon.js 编辑器中创作或从 3ds Max / Unity 导出的场景提供 glTF 之外的另一种加载路径。

## 公共 API 接口

### 函数

```typescript
export async function loadBabylon(engine: Engine, url: string, opts?: LoadBabylonOptions): Promise<AssetContainer>;
```

### 类型

```typescript
export interface LoadBabylonOptions {
    maxMeshes?: number; // maximum meshes to load (default: all)
    loadTextures?: boolean; // whether to load textures (default: true)
}

/** Returned by both loadGltf() and loadBabylon(). Passed to addToScene(). */
export type { AssetContainer } from "../asset-container.js";
```

### 用法

```typescript
const result = await loadBabylon(engine, "https://example.com/scene.babylon");
addToScene(scene, result); // entities[], clearColor, animationGroups dispatched into scene
```

- `entities`：所有已加载的 `Mesh` 和 `LightBase` 对象的扁平数组
- `clearColor`：来自 JSON 字段 `scene.clearColor`（若存在），由 `addToScene()` 应用
- `animationGroups`：对于 `.babylon` 为空（该格式无动画组）

## 内部架构

### .babylon JSON 模式（已解析类型）

```typescript
interface BabylonScene {
    clearColor?: number[];
    ambientColor?: number[];
    cameras?: BabylonCamera[];
    lights?: BabylonLight[];
    materials?: BabylonMaterial[];
    multiMaterials?: BabylonMultiMaterial[];
    meshes?: BabylonMesh[];
    activeCameraID?: string;
}

interface BabylonCamera {
    name: string;
    id: string;
    type: string;
    position: number[];
    rotation?: number[];
    target?: number[];
    fov?: number;
    minZ?: number;
    maxZ?: number;
}

interface BabylonTexture {
    name: string; // filename relative to .babylon URL
    hasAlpha?: boolean;
    getAlphaFromRGB?: boolean;
    level?: number;
    coordinatesIndex?: number; // 0 = UV1, 1 = UV2
    coordinatesMode?: number; // 2 = spherical reflection
    uOffset?: number;
    vOffset?: number;
    uScale?: number;
    vScale?: number;
}

interface BabylonMaterial {
    name: string;
    id: string;
    diffuse?: number[];
    specular?: number[];
    specularPower?: number;
    emissive?: number[];
    ambient?: number[];
    alpha?: number;
    alphaCutOff?: number;
    diffuseTexture?: BabylonTexture | null;
    bumpTexture?: BabylonTexture | null;
    specularTexture?: BabylonTexture | null;
    ambientTexture?: BabylonTexture | null;
    lightmapTexture?: BabylonTexture | null;
    emissiveTexture?: BabylonTexture | null;
    opacityTexture?: BabylonTexture | null;
    reflectionTexture?: BabylonTexture | null;
    backFaceCulling?: boolean;
}

interface BabylonMultiMaterial {
    name: string;
    id: string;
    materials: string[]; // ordered sub-material IDs
}

interface BabylonSubMesh {
    materialIndex: number;
    verticesStart: number;
    verticesCount: number;
    indexStart: number;
    indexCount: number;
}

interface BabylonMesh {
    name: string;
    id: string;
    parentId?: string | null;
    materialId?: string | null;
    position?: number[];
    rotation?: number[];
    scaling?: number[];
    positions?: number[];
    normals?: number[];
    uvs?: number[];
    uvs2?: number[];
    indices?: number[];
    subMeshes?: BabylonSubMesh[];
    isVisible?: boolean;
}

interface BabylonLight {
    name: string;
    id: string;
    type: number; // 0=point, 1=directional, 2=spot, 3=hemispheric
    position?: number[];
    direction?: number[];
    diffuse?: number[];
    specular?: number[];
    intensity?: number;
    range?: number;
    excludedMeshesIds?: string[];
    includedOnlyMeshesIds?: string[];
}
```

### 加载管线

```
fetch(url) → JSON parse → BabylonScene
     │
     ├── Scene settings: clearColor
     │
     ├── Materials: Build Map<id, StandardMaterialProps>
     │   └── For each material: create StandardMaterial, load textures in parallel
     │
     ├── MultiMaterials: Build Map<id, string[]> (sub-material ID arrays)
     │
     ├── Lights: Create point lights (type === 0) with position, intensity, colors, range
     │   └── Support: excludedMeshesIds, includedOnlyMeshesIds
     │
     └── Meshes: For each visible mesh with geometry:
         ├── Upload positions, normals, indices, uvs, uvs2 to GPU
         ├── Resolve material (direct or via multi-material subMesh)
         ├── Split into sub-meshes (each sub-mesh → separate GPU mesh)
         ├── Apply position/rotation/scaling transform
         └── Retain CPU geometry for picking (_cpuPositions, _cpuNormals, etc.)
```

### 材质解析

1. 在 `multiMatMap` 中查找 `mesh.materialId`
2. 若找到：它是一个多重材质 → 使用子材质 ID 数组
3. 若未找到：将 `materialId` 视为单一材质 ID
4. 对每个子网格：将 `matIds[subMesh.materialIndex]` 在 `materialMap` 中查找
5. 回退：`createStandardMaterial()`（默认白色材质）

### 环境色处理

BJS 将 `material.ambient` 乘以 `scene.ambientColor`。加载器会预先相乘：

```typescript
mat.ambientColor = [md.ambient[0] * sceneAmbient[0], md.ambient[1] * sceneAmbient[1], md.ambient[2] * sceneAmbient[2]];
```

### 纹理加载

纹理通过 `Promise.all(texturePromises)` 并行加载：

- URL 解析：`baseUrl + texture.name`，其中 `baseUrl = url.substring(0, lastIndexOf("/") + 1)`
- 支持的纹理槽位：diffuse、bump、specular、ambient、lightmap、emissive、opacity、reflection
- 映射的逐纹理属性：`level` → 材质特定级别、`coordinatesIndex` → 坐标索引、`uScale`/`vScale` → `uvScale`、`getAlphaFromRGB` → `opacityFromRGB`、`coordinatesMode === 2` → `reflectionCoordMode = 2`（球面）
- 销毁时通过 `clearTexture2DCache(device)` 清理纹理缓存

### 子网格处理

每个 `BabylonSubMesh` 成为一个独立的 GPU 网格，具备：

- 共享顶点缓冲区（引用父级的位置、法线）
- 切片索引缓冲区：`allIndices.slice(sub.indexStart, sub.indexStart + sub.indexCount)`
- 来自多重材质数组的独立材质分配
- 名称：对于多子网格网格为 `meshName_sub{materialIndex}`

### 与 glTF 加载路径的差异

| 方面 | glTF 加载器 | .babylon 加载器 |
| ------------------ | ------------------------------- | --------------------------------- |
| 格式 | 二进制 GLB 或 JSON + .bin | 单个 JSON 文件 |
| 材质系统 | PBR（金属度-粗糙度） | Standard（Blinn-Phong） |
| 坐标系 | 右手 → 左手转换 | 已是左手系 |
| 骨骼/动画 | 完整支持 | 不支持 |
| 变形目标 | 支持 | 不支持 |
| 多重材质 | 不适用（逐图元） | SubMesh → 多重材质映射 |
| 顶点数据 | 二进制访问器 + 缓冲视图 | 内联 JSON 数字数组 |
| 纹理引用 | URI 或缓冲区内嵌 | 相对于 `.babylon` URL 的文件名 |
| 灯光 | 不在 glTF 核心中 | 带包含/排除列表的点光源 |

## 管线配置

不适用 —— 本模块不创建任何 GPU 管线。网格上传使用来自网格模块的 `uploadMeshToGPU()`。

## 着色器逻辑

不适用 —— 使用 Standard 材质着色器（不由本加载器管理）。

## 状态机 / 生命周期

一次性异步加载器。无持久化状态。向场景注册 `clearTexture2DCache` 可销毁对象。

## Babylon.js 等价映射

| Babylon.js | Babylon Lite |
| ------------------------------ | ---------------------------------------------------- |
| `SceneLoader.Load(".babylon")` | `addToScene(scene, await loadBabylon(engine, url))` |
| `StandardMaterial` | `createStandardMaterial()` → `StandardMaterialProps` |
| `MultiMaterial` | `multiMatMap: Map<id, string[]>` |
| `Mesh.subMeshes` | 按子网格拆分为独立 GPU 网格 |
| `PointLight` | `createPointLight()` |
| `Light.excludedMeshes` | `pl.excludedMeshIds: Set<string>` |
| `Light.includedOnlyMeshes` | `pl.includedOnlyMeshIds: Set<string>` |

## 依赖项

- `../scene/scene.js` —— `SceneContext`、`SceneContextInternal`
- `../engine/engine.js` —— `EngineInternal`（访问设备）
- `../material/standard/standard-material.js` —— `createStandardMaterial`、`StandardMaterialProps`
- `../mesh/mesh.js` —— `uploadMeshToGPU`、`initMeshTransform`、`MeshInternal`
- `../light/point-light.js` —— `createPointLight`
- `../texture/texture-2d.js` —— `loadTexture2D`、`clearTexture2DCache`

## 测试规范

1. **场景清除颜色**：验证从 JSON 设置 `scene.clearColor`
2. **材质解析**：验证漫反射/镜面反射/自发光颜色、specularPower、alpha
3. **纹理加载**：验证使用正确 URL 加载纹理并映射属性
4. **多重材质**：验证子网格分配到多重材质数组中正确的材质
5. **网格变换**：验证通过 `initMeshTransform` 应用位置/旋转/缩放
6. **点光源**：验证位置、强度、漫反射/镜面反射颜色、范围
7. **灯光过滤**：验证创建了 `excludedMeshIds` 和 `includedOnlyMeshIds` 集合
8. **不可见网格**：验证跳过 `isVisible: false` 的网格
9. **maxMeshes**：验证遵守网格数量上限
10. **保留 CPU 几何**：验证为拾取设置了 `_cpuPositions`、`_cpuNormals`、`_cpuIndices`

## 文件清单

| 文件 | 职责 |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `load-babylon.ts` | 完整的 `.babylon` 格式加载器：JSON 解析、材质/纹理创建、网格上传、灯光创建 |
