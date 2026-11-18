# 模块：Lights

> 包路径：`packages/babylon-lite/src/light/`

## 目的

为**半球光（hemispheric）**、**方向光（directional）**、**点光源（point）**和**聚光灯（spot）**提供纯数据灯光定义，以及共享基础设施层（`light-base.ts`、`types.ts`）和由场景拥有的灯光 UBO 打包系统（`render/lights-ubo.ts`、`scene/scene-light-state.ts`）。遵循 Babylon Lite 的“支柱 4b”原则，灯光是不持有场景引用的无状态数据对象。

工厂函数创建带有合理默认值的灯光对象；调用方将其添加到场景或传递给材质搭建函数。每个灯光具备：

- 通过 `ObservableVec3` 实现对位置/方向的基于推送的脏追踪
- 支持父级的世界矩阵状态（继承自 `light-base.ts`）
- 面向场景灯光 UBO 系统的共享 UBO 写入器（`_writeLightUbo`）
- 版本追踪（`_lightVersion` 外加 `worldMatrixVersion`），使标量和变换变更（包括继承的父级变换）能够刷新共享灯光 UBO

PBR 不再使用逐灯光扩展注册或 `SceneUniforms` 中的灯光字段。Standard、PBR 和 NodeMaterial 均消费位于 `@group(0) @binding(1)` 的场景所属 `LightsUniforms` UBO。逐网格 UBO 携带与材质无关的灯光选择列表（`lc` 外加打包的 `li: array<vec4<u32>, ceil(MAX_LIGHTS / 4)>`），该列表根据 `LightBase.includedOnlyMeshes` / `excludedMeshes` 和 `includedOnlyMeshIds` / `excludedMeshIds` 计算得出（见[逐网格灯光过滤](#逐网格灯光过滤)）；着色器通过这些网格索引来寻址场景灯光数组。仅有一个符合条件的非阴影 PBR 灯光时使用 `material/pbr/fragments/singlelight-wgsl.ts`；多灯光或任何阴影接收体则使用 `material/pbr/fragments/multilight-wgsl.ts`。

---

## 公共 API 接口

### 共享类型（`types.ts`）

```typescript
/** Shared base for all light types. Provides pipeline integration callbacks. */
export interface LightBase extends IWorldMatrixProvider, IParentable {
    readonly lightType: string;
    children: SceneNode[];
    excludedMeshes?: ReadonlySet<Mesh>;
    includedOnlyMeshes?: ReadonlySet<Mesh>;
    excludedMeshIds?: ReadonlySet<string>;
    includedOnlyMeshIds?: ReadonlySet<string>;
    shadowGenerator?: ShadowGenerator;
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

/** @internal */
export interface LightBaseInternal extends LightBase {
    readonly _writeLightUbo?: (data: Float32Array, offset: number) => void;
    readonly _lightVersion: number;
}

export let MAX_LIGHTS = 16;
export function setMaxLights(n: number): void;
export const LIGHT_ENTRY_FLOATS = 16; // 4 × vec4 = 64 bytes per light
```

### 运行时强度更新（`set-light-intensity.ts`）

```typescript
export function setLightIntensity(light: LightBase & { intensity: number }, intensity: number): void;
export function setLightDiffuseColor(light: LightBase & { diffuse: [number, number, number] }, color: readonly [number, number, number]): void;
```

更新有限的标量强度并递增仅限灯光的版本计数器，使共享灯光 UBO 得以刷新而无需使灯光的世界矩阵失效。在初始场景搭建期间直接赋值强度依然有效，因为首次 UBO 上传会读取最终值；运行时修改请使用此 setter。`setLightDiffuseColor()` 为方向光、点光源和聚光灯的漫反射 RGB 变更提供相同的失效机制。

### 灯光基类（`light-base.ts`）

```typescript
/** Create the SceneNode transform and version state shared by all light types. */
export function createLightBase(position: readonly [number, number, number]): {
    node: SceneNode;
    lvs: LightVersionState;
};

/** Add light-specific state to a SceneNode and return the same object. */
export function applyLightBase<R>(node: SceneNode, target: object, lvs?: LightVersionState): R;

export { ObservableVec3 } from "../math/observable-vec3.js";
```

灯光是完整的 `SceneNode`，具有与网格和变换节点完全相同的位置、旋转、缩放、父级、子级和世界矩阵行为。局部 `direction` 会通过该世界矩阵进行变换，因此直接写入四元数或欧拉角可以调整渲染出的灯光朝向，同时保留现有的 `direction` API。因此 `setParent` 使用标准的 `SceneNode` 路径，无需针对灯光的运行时分支。UBO 写入器会对世界方向进行归一化，使父级缩放不会改变方向光强度或聚光灯圆锥角测试。`_lightVersion` 包含世界矩阵版本，因此祖先节点的运动会刷新 GPU 灯光数据。阴影构建器同样从 `worldMatrix` 推导灯光位置/方向。

### 方向光（`directional-light.ts`）

```typescript
export interface DirectionalLight extends LightBase {
    readonly lightType: "directional";
    direction: ObservableVec3;
    position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
}

export function createDirectionalLight(
    direction: [number, number, number],
    intensity?: number // Default: 1
): DirectionalLight;
```

**默认值：**

| 属性      | 默认值                            |
| --------- | --------------------------------- |
| lightType | `'directional'`                   |
| direction | *（参数）*                        |
| position  | `(0, 0, 0)`（通过 ObservableVec3）|
| diffuse   | `[1, 1, 1]`                       |
| specular  | `[1, 1, 1]`                       |
| intensity | `1`                               |

### 点光源（`point-light.ts`）

```typescript
export interface PointLight extends LightBase {
    readonly lightType: "point";
    position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

export function createPointLight(
    position: [number, number, number],
    intensity?: number // Default: 1.0
): PointLight;
```

**默认值：**

| 属性      | 默认值                            |
| --------- | --------------------------------- |
| lightType | `'point'`                         |
| position  | *（参数）*（通过 ObservableVec3） |
| diffuse   | `[1, 1, 1]`                       |
| specular  | `[1, 1, 1]`                       |
| intensity | `1.0`                             |
| range     | `Number.MAX_VALUE`                |

**局部矩阵**：`createTranslationMat4(position.x, position.y, position.z)` —— 仅包含位置，无朝向。

### 半球光（`hemispheric.ts`）

```typescript
export interface HemisphericLight extends LightBase {
    readonly lightType: "hemispheric";
    direction: ObservableVec3;
    intensity: number;
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor: [number, number, number];
}

export function createHemisphericLight(
    direction?: [number, number, number], // Default: [0, 1, 0]
    intensity?: number // Default: 1.0
): HemisphericLight;
```

**默认值：**

| 属性          | 默认值                            |
| ------------- | --------------------------------- |
| lightType     | `'hemispheric'`                   |
| direction     | `(0, 1, 0)`（通过 ObservableVec3）|
| intensity     | `1.0`                             |
| diffuseColor  | `[1, 1, 1]`                       |
| specularColor | `[1, 1, 1]`                       |
| groundColor   | `[0, 0, 0]`                       |

### 聚光灯（`spot-light.ts`）

```typescript
export interface SpotLight extends LightBase {
    readonly lightType: "spot";
    position: ObservableVec3;
    direction: ObservableVec3;
    /** Full cone angle in radians. */
    angle: number;
    /** Falloff exponent — higher = sharper spotlight. */
    exponent: number;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

export function createSpotLight(
    position: [number, number, number],
    direction: [number, number, number],
    angle: number,
    exponent: number,
    intensity?: number // Default: 1.0
): SpotLight;
```

**默认值：**

| 属性      | 默认值                            |
| --------- | --------------------------------- |
| lightType | `'spot'`                          |
| position  | *（参数）*（通过 ObservableVec3） |
| direction | *（参数）*（通过 ObservableVec3） |
| angle     | *（参数）*                        |
| exponent  | *（参数）*                        |
| diffuse   | `[1, 1, 1]`                       |
| specular  | `[1, 1, 1]`                       |
| intensity | `1.0`                             |
| range     | `Number.MAX_VALUE`                |

**局部矩阵**：使用 `localMatrixFromDirection(direction, position)` —— 同时包含朝向和位置。

---

## 内部架构

### 数据结构

所有灯光都是带有基于 `Object.defineProperties` 的世界矩阵访问器的普通 JavaScript 对象（POJO）—— 没有类，没有 GPU 资源。场景为 `scene.lights` 拥有一个 GPU `LightsUniforms` 缓冲区；材质仅声明并读取固定的 group-0 绑定。

### 灯光基类基础设施（`light-base.ts`）

每个灯光工厂函数：

1. 调用 `createLightBase(getLocalMatrix)`，返回 `{ wm, onDirty }`：
    - `wm`：`WorldMatrixAccessors` —— 提供 `getWorldMatrix()`、`getWorldMatrixVersion()`、`markLocalDirty()` 以及 `parent` 的 get/set
    - `onDirty`：调用 `wm.markLocalDirty()` 的回调 —— 传给 `ObservableVec3` 构造函数
2. 构建带有 `_writeLightUbo` 回调的灯光数据对象
3. 调用 `applyWorldMatrixAccessors(target, wm)`，通过 `Object.defineProperties` 将 `parent`、`worldMatrix` 和 `worldMatrixVersion` 添加为 getter/setter

该模式消除了所有灯光类型之间重复的世界矩阵样板代码。

### 灯光类型判别（Standard 材质）

每个灯光在 `_writeLightUbo` 中于 `data[offset + 3]` 写入其类型标志：

| `vLightData.w` | 灯光类型    | 位置/方向来源                          |
| -------------- | ----------- | -------------------------------------- |
| `0`            | Point       | xyz = 世界位置（worldMatrix 第 3 列）  |
| `1`            | Directional | xyz = 世界方向（worldMatrix 第 2 列）  |
| `2`            | Spot        | xyz = 世界位置（worldMatrix 第 3 列）  |
| `3`            | Hemispheric | xyz = 世界方向（worldMatrix 第 2 列）  |

### Lights UBO 布局（`render/lights-ubo.ts`）

Standard、PBR 和 NodeMaterial 管线使用共享的场景灯光 UBO，默认最多支持 `MAX_LIGHTS = 16` 个打包的场景灯光。在管线/UBO 创建前可通过 `setMaxLights(n)` 调整上限。与 Babylon.js 每个材质默认 `maxSimultaneousLights = 4` 不同，Babylon Lite 的 `MAX_LIGHTS` 是整个场景范围的打包灯光容量上限。

帧/通道的绑定组布局为：

| Group | Binding | 所有者                                             | 内容                                                        |
| ----- | ------- | -------------------------------------------------- | ----------------------------------------------------------- |
| 0     | 0       | `RenderTask`                                       | 逐通道 `SceneUniforms`（相机、雾效、图像处理、环境）        |
| 0     | 1       | `SceneContextInternal`（通过 `scene-light-state.ts`）| 从 `scene.lights` 打包的场景级 `LightsUniforms`             |

材质/网格绑定组从不包含灯光缓冲区。网格 UBO 追加以下字段：

```wgsl
lc: u32,
li: array<vec4<u32>, ceil(MAX_LIGHTS / 4)>,
```

每个打包索引寻址场景级 UBO 中的 `lights.lights[index]`（`li[i / 4u][i % 4u]`）。`render/mesh-light-selection.ts` 使用 `lightAffectsMesh(light, mesh)` 为每个网格计算此列表，跳过被任一对过滤列表排除的灯光（见[逐网格灯光过滤](#逐网格灯光过滤)）。

**默认总 UBO 大小**：`getLightsUboSize() = 16 + MAX_LIGHTS × 64` 字节（当 `MAX_LIGHTS = 16` 时为 1040 字节）

**布局：**

| 偏移（字节） | 大小 | 内容                                   |
| ------------ | ---- | -------------------------------------- |
| 0–3          | 4B   | `count` (u32) —— 活跃灯光数量          |
| 4–15         | 12B  | 填充（3 × u32）                        |
| 16–79        | 64B  | 灯光 0 条目（4 × vec4）                |
| 80–143       | 64B  | 灯光 1 条目（4 × vec4）                |
| 144–207      | 64B  | 灯光 2 条目（4 × vec4）                |
| 208–271      | 64B  | 灯光 3 条目（4 × vec4）                |

**逐灯光条目布局（LIGHT_ENTRY_FLOATS = 16，64 字节）：**

| 浮点索引 | Directional (w=1) | Point (w=0)       | Spot (w=2)        | Hemispheric (w=3)        |
| -------- | ----------------- | ----------------- | ----------------- | ------------------------ |
| [0–2]    | direction (col2)  | position (col3)   | position (col3)   | direction (col2)         |
| [3]      | 1（类型标志）     | 0（类型标志）     | 2（类型标志）     | 3（类型标志）            |
| [4–6]    | diffuse × intensity | diffuse × intensity | diffuse × intensity | diffuseColor × intensity |
| [7]      | MAX_VALUE (range) | range             | range             | *（未使用）*             |
| [8–10]   | specular × intensity | specular × intensity | specular × intensity | specularColor × intensity |
| [11]     | *（未使用）*      | *（未使用）*      | exponent          | *（未使用）*             |
| [12–14]  | *（未使用）*      | *（未使用）*      | direction (col2)  | groundColor × intensity  |
| [15]     | *（未使用）*      | *（未使用）*      | cos(angle/2)      | *（未使用）*             |

### UBO 函数（`lights-ubo.ts`）

```typescript
/** Fill a Float32Array with standard light data. */
export function fillLightsData(data: Float32Array, lights: readonly LightBase[]): void;

/** Current lights UBO byte size for the active MAX_LIGHTS value. */
export function getLightsUboSize(): number;

/** Create a new lights UBO from all compatible lights. */
export function writeLightsUBO(engine: EngineContextInternal, lights: readonly LightBase[]): GPUBuffer;

/** Refresh an existing lights UBO with current light state. */
export function refreshLightsUBO(engine: EngineContextInternal, buffer: GPUBuffer, lights: readonly LightBase[], scratch: Float32Array): void;
```

**`fillLightsData` 算法：**

1. 将整个 Float32Array 清零
2. 遍历灯光，跳过没有 `_writeLightUbo` 的灯光，达到 `MAX_LIGHTS` 时停止
3. 调用每个灯光的 `_writeLightUbo(data, headerFloats + count * LIGHT_ENTRY_FLOATS)`
4. 通过 `Uint32Array` 视图将 `count` 写入第一个 u32 槽位

### 逐网格灯光过滤

`LightBase` 上的两对列表限制灯光可以照射到哪些网格。`render/mesh-light-selection.ts` 导出了打包选择逻辑和材质特性镜像共同使用的单一谓词：

```typescript
export function lightAffectsMesh(light: LightBase, mesh: Mesh): boolean;
```

**对象标识列表。** `excludedMeshes` 和 `includedOnlyMeshes` 为 `ReadonlySet<Mesh>`。两者都会生效：非空的 `includedOnlyMeshes` 将灯光限制在这些网格上，随后再从中减去 `excludedMeshes`。这与 Babylon.js 的 `Light.canAffectMesh` 一致。

**ID 列表。** `excludedMeshIds` 和 `includedOnlyMeshIds` 为 `ReadonlySet<string>`，用于匹配仅由 `.babylon` 加载器写入的 `Mesh.id`。它们的优先级有所不同，这是刻意设计的：非空的 `includedOnlyMeshIds` 直接胜出，不会从中减去排除项。

**优先级。** 优先求值对象列表。当 `includedOnlyMeshes` 非空时完全不查阅 ID 列表；否则对象级排除为最终结果，只有未被对象列表排除的网格才会继续回退到 ID 列表判断。未设置任何列表的灯光走无内存分配的快速路径。

仅靠 ID 本身无法唯一标识一个网格，这正是对象列表存在的原因：将同一资产加载两次会产生携带相同资产局部 ID 的不同网格，而克隆体从其源对象展开复制，因此会带着源对象的 ID 出现。Compat 层会出于这个原因清除网格克隆体上的 `id`。

**克隆。** `light/light-clone.ts` 中的 `copyLightBase` 会将全部四个集合带到克隆体上，因此克隆出的灯光会保留其过滤设置而非变成无限制。这些集合按引用共享，而非深拷贝。

**与着色器选择的一致性。** 灯光选择会在构建可渲染对象时烘焙：进入着色器的光照模式变体排列、进入网格 UBO 的打包索引，以及进入任何镜像该选择状态的材质特性位（如矩形面光源使用的 `SceneLightingExtension._pbrFeatures(mesh)`）。因此 `buildPbrRenderables` 会交替扫描选择集并加载缺失项，直到某次扫描未发现缺失项为止，从而保证所组合的光照 WGSL 始终是最终选择集所需内容的超集。该循环以扫描而非 await 结束，从而确保即使在加载过程中发生编辑也能保持该保证成立，且由于加载操作只会在有限路径集合上做增量添加，循环必定终止。

**生命周期。** 逐帧更新器仅在灯光数量或网格世界矩阵变化时才重新检查选择集，因此灯光数量稳定时的列表编辑需要重建可渲染对象。Compat 层负责驱动该流程：

1. `Light.excludedMeshes` / `includedOnlyMeshes` 交出灯光自身带有 `push` 和 `splice` 钩子的活跃数组，这正是 Babylon.js 所钩住的两个方法。每个数组仅挂载一个钩子并读取订阅者集合，因此多个灯光共享同一数组时只携带单个包装器。
2. 发布操作合并到微任务队列上，重建操作则按场景合并。空列表发布 `undefined`。
3. `Scene._hasStarted` 会在 `registerScene` 设置 `_built` 之前的数个 await 期间变为 true，而在此之前 `rebuildSceneRenderables` 是文档明确定义的空操作。落在该窗口期内的编辑会被保存在引擎的延迟工作队列上，待注册完成后立即应用，从而能触及已构建完成的组。
4. 当灯光的列表被替换、灯光被销毁以及其场景被销毁时（通过 `onSceneDispose`），该灯光会从数组中释放，同时保留该数组上的其他存活消费者处于订阅状态。场景注册在交出或编辑列表时同步完成，而非由排在其后的发布微任务完成，因此同一 tick 内销毁的场景仍能释放该灯光，且从一个灯光共享到另一个场景灯光的数组不会使前一个灯光的场景一直保持可达。在场景已销毁后触碰列表会立即释放，因为此时注册的销毁回调永远不会运行。
5. 退役网格时会将其从场景中所有灯光的两个列表中剪接移除，正如 Babylon.js 在其 `AbstractMesh.dispose` 中所做的那样。若将已死网格留在包含列表中，会使该限制继续存在并导致所有存活网格都无法被该灯光照亮。该剪接操作经过上述钩子，因此重新发布和重建会遵循常规编辑路径，并在多个灯光共享同一列表时通知所有相关灯光。该机制挂载在包装器退役而非节点销毁上，因此由 `AssetContainer` 拆除的网格同样会被清理。
6. 对于由分簇容器持有的灯光会跳过重建，因为它处于逐网格灯光路径之外。Babylon.js 出于同样原因跳过其自身的重同步。

### PBR 光照着色器路径

PBR 材质消费与 Standard 材质相同的打包 `LightEntry` 布局。PBR 可渲染对象构建器每个场景决定一次需要导入哪个 WGSL 辅助模块：

| 条件                                      | WGSL 辅助模块                                | 行为                                                                                     |
| ----------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 网格恰好有一个符合条件的灯光且无阴影接收路径 | `material/pbr/fragments/singlelight-wgsl.ts` | 针对该灯光 `lightType` 特化的无循环直接光照代码；读取 `lights.lights[mli(0u)]`            |
| 网格有多个符合条件的灯光，或存在任何阴影接收路径 | `material/pbr/fragments/multilight-wgsl.ts`  | 通用的 `computePbrLight()` + 遍历 `mesh.lc` 的循环；阴影片元写入逐场景灯光的阴影因子       |

受支持的 PBR 灯光类型为半球光、方向光、点光源和聚光灯。PBR 材质默认采用物理平方反比点光源/聚光灯衰减。将 `usePhysicalLightFalloff: false` 的材质则改用 Babylon 的 Standard 风格衰减：线性距离衰减加上聚光灯圆锥指数衰减。

### 着色器光照数学（Standard 材质）

（定义于 `standard-textured.fragment.wgsl`，通过 lights UBO 消费）

**点光源衰减：**

```
direction = lightPosition - fragmentPosition
attenuation = max(0, 1 - length(direction) / range)
lightVector = normalize(direction)
```

**方向光：**

```
lightVector = normalize(-lightDirection)
attenuation = 1.0
```

**聚光灯衰减：**

```
lightVector = normalize(lightPosition - fragmentPosition)
attenuation = max(0, 1 - length(lightPosition - fragmentPosition) / range)
cosAngle = dot(normalize(lightDirection), -lightVector)
spotFalloff = max(0, cosAngle - cosHalfAngle) ^ exponent
attenuation *= spotFalloff
```

**半球光：**

```
lightVector = normalize(lightDirection)
NdotL = dot(normal, lightVector) * 0.5 + 0.5  // wrapped diffuse
diffuse = mix(groundColor, diffuseColor, NdotL) * intensity
```

**漫反射（Lambertian）：**

```
ndl = max(0, dot(normal, lightVector))
diffuse = ndl * lightDiffuseColor * attenuation
```

**镜面反射（Blinn-Phong）：**

```
halfVector = normalize(viewDir + lightVector)
specComp = pow(max(0, dot(normal, halfVector)), max(1, glossiness))
specular = specComp * lightSpecularColor * attenuation
```

---

## 管线配置

灯光模块不创建 GPU 管线。它们仅生成供材质管线消费的纯数据。

灯光 UBO（`render/lights-ubo.ts`）创建一个用法为 `UNIFORM | COPY_DST` 的单个 `GPUBuffer`。`SceneContextInternal._lightGpuState` 将其存储在场景上，每帧通过 `refreshSceneLightsUBO()` 刷新，并在活跃 `MAX_LIGHTS` 大小发生变化时重新创建。默认大小为 1040 字节，但实际大小随 `MAX_LIGHTS` 变化。

---

## 着色器逻辑

灯光模块不包含着色器。光照计算位于材质着色器模块中：Standard 和 NodeMaterial 通过 `mesh.lc` / `mli(i)` 循环索引 group-0 灯光 UBO，而 PBR 则从 `material/pbr/fragments/` 动态导入 `singlelight-wgsl.ts` 或 `multilight-wgsl.ts`。

---

## 状态机 / 生命周期

### 灯光创建

```typescript
// Directional
const light = createDirectionalLight([0, -1, 0], 1.5);
light.position.set(10, 20, 10); // triggers onDirty → markLocalDirty

// Point
const point = createPointLight([5, 3, 0], 2.0);
point.range = 100;

// Hemispheric
const hemi = createHemisphericLight([0, 1, 0], 0.7);
hemi.groundColor = [0.1, 0.1, 0.1];

// Spot
const spot = createSpotLight([0, 10, 0], [0, -1, 0], Math.PI / 3, 2.0, 1.5);
spot.angle = Math.PI / 4;
```

### 修改与脏追踪

- 在任何 `ObservableVec3` 上设置 `direction.x`、`direction.y`、`direction.z` 或调用 `direction.set(x,y,z)` 会触发 `onDirty()` → `wm.markLocalDirty()` → 递增 `worldMatrixVersion`
- `worldMatrix` getter 在变脏时从 `getLocalMatrix()` 和父级链惰性重算
- `_writeLightUbo` 从 `worldMatrix` 读取数据（其会自动解析父级变换）

### Lights UBO 生命周期

1. **创建**：`ensureSceneLightState(engine, scene)` 分配一个大小为 `getLightsUboSize()` 的 UBO 并将其存储在 `SceneContextInternal._lightGpuState` 上。
2. **Group-0 绑定**：每个 `RenderTask` 在 binding 0 绑定任务所属的场景 UBO，在 binding 1 绑定场景所属的灯光 UBO。
3. **逐帧刷新**：`refreshSceneLightsUBO(engine, scene)` 比对聚合灯光版本号和灯光数量，仅在需要时写入共享 UBO。
4. **灯光过滤**：仅打包定义了 `_writeLightUbo` 的灯光；上限为 `MAX_LIGHTS`。
5. **容量变更调整大小**：如果 `MAX_LIGHTS` 变化且 UBO 字节大小变化，`ensureSceneLightState()` 会销毁/重建场景灯光缓冲区，渲染通道任务则重建其 group-0 绑定组。
6. **网格选择**：材质可渲染对象将逐网格的 `lc` 和打包的 `li` 索引写入网格 UBO；此选择同时遵守对象标识列表和 ID 列表。

**灯光模块不创建任何 GPU 资源。** 灯光打包与场景所属的 GPU 状态位于 `lights-ubo.ts` 中；材质仅拥有着色器、网格/材质 UBO、纹理和绑定组。

---

## Babylon.js 等价对照表

| Babylon Lite                                  | Babylon.js                                                    |
| --------------------------------------------- | ------------------------------------------------------------- |
| `createDirectionalLight(dir, intensity)`      | `new DirectionalLight(name, dir, scene)`                      |
| `DirectionalLight.direction` (ObservableVec3) | `DirectionalLight.direction` (Vector3)                        |
| `DirectionalLight.position` (ObservableVec3)  | `DirectionalLight.position` (Vector3)                         |
| `DirectionalLight.diffuse`                    | `DirectionalLight.diffuse`                                    |
| `DirectionalLight.specular`                   | `DirectionalLight.specular`                                   |
| `DirectionalLight.intensity`                  | `DirectionalLight.intensity`                                  |
| `createPointLight(pos, intensity)`            | `new PointLight(name, pos, scene)`                            |
| `PointLight.range = Number.MAX_VALUE`         | `PointLight.range`（默认极大值）                              |
| `createHemisphericLight(dir, intensity)`      | `new HemisphericLight(name, dir, scene)`                      |
| `HemisphericLight.diffuseColor`               | `HemisphericLight.diffuse`                                    |
| `HemisphericLight.specularColor`              | `HemisphericLight.specular`                                   |
| `HemisphericLight.groundColor`                | `HemisphericLight.groundColor`                                |
| `createSpotLight(pos, dir, angle, exp, int)`  | `new SpotLight(name, pos, dir, angle, exp, scene)`            |
| `SpotLight.angle`                             | `SpotLight.angle`                                             |
| `SpotLight.exponent`                          | `SpotLight.exponent`                                          |
| `SpotLight.range`                             | `SpotLight.range`                                             |
| `LightBase.lightType` 字符串判别式            | 类继承体系 + `getTypeID()`（内部）                            |
| `LightBase.excludedMeshes`                    | `Light.excludedMeshes`                                        |
| `LightBase.includedOnlyMeshes`                | `Light.includedOnlyMeshes`                                    |
| `LightBase.excludedMeshIds`                   | `.babylon` 加载器灯光列表（Babylon.js 无等价物）              |
| `LightBase.includedOnlyMeshIds`               | `.babylon` 加载器灯光列表（Babylon.js 无等价物）              |
| `LightBase.shadowGenerator`                   | `Light.getShadowGenerator()`                                  |
| `LightBase.parent` (IWorldMatrixProvider)     | `Light.parent` (TransformNode)                                |
| 纯数据对象（无场景引用）                      | 持有场景引用的类实例                                          |
| 带脏回调的 `ObservableVec3`                   | `Vector3` + `_markAsDirty()` 模式                             |
| `localMatrixFromDirection()`                  | `Light._buildUniformLayout()`（内部）                         |
| 灯光类型 `w` 标志（0/1/2/3）                  | 内部类型系统（`LIGHTTYPEID_*`）                               |
| `MAX_LIGHTS = 16` 场景级上限                  | `maxSimultaneousLights`（每材质默认 4）                       |
| `fillLightsData()` / `writeLightsUBO()`       | Babylon 内部灯光 UBO 构建                                     |
| `refreshLightsUBO()`                          | 逐帧灯光 uniform 更新                                         |
| `singlelight-wgsl.ts` / `multilight-wgsl.ts`  | PBR 着色器包含文件（`pbrDirectLightingSetupFunctions` 等）    |

### 与 Babylon.js 的主要差异

1. **无场景引用** —— Babylon Lite 灯光是带有世界矩阵访问器的 POJO；Babylon.js 灯光是会向 Scene 注册的类实例。
2. **`lightType` 字符串判别式** —— 不使用类继承层次，每个灯光都带有一个 `lightType` 字符串字面量（`'directional'`、`'point'`、`'spot'`、`'hemispheric'`）。
3. **`ObservableVec3`** —— 方向/位置使用带脏回调的可观察向量，取代了 Babylon 的 `Vector3` + 手动脏追踪。
4. **共享灯光 UBO** —— Standard 和 PBR 将最多 `MAX_LIGHTS` 个场景灯光打包进同一个 UBO；Babylon.js 使用材质作用域的灯光宏定义/uniform，默认每材质同时最多 4 个灯光。
5. **可 Tree-shake 的 PBR 光照代码** —— PBR 仅在需要时动态导入单灯光或多灯光 WGSL 辅助模块；Babylon.js 则包含广泛的灯光着色器支持。
6. **灯光或生成器上无阴影投射体列表** —— 阴影投射体是为某个生成器注册的场景/帧图 `ShadowTask` 输入。灯光仅通过 `shadowGenerator` 属性引用其阴影生成器。

---

## 依赖关系

### types.ts

- `../math/types.js` —— `Mat4`
- `../scene/parentable.js` —— `IWorldMatrixProvider`、`IParentable`
- `../shadow/shadow-generator.js` —— `ShadowGenerator`（仅类型导入）

### light-base.ts

- `../math/types.js` —— `Mat4`
- `../scene/parentable.js` —— `IWorldMatrixProvider`
- `../scene/world-matrix-state.js` —— `createWorldMatrixState`、`WorldMatrixAccessors`
- `../math/observable-vec3.js` —— `ObservableVec3`（重导出）

### light-matrix.ts

- `../math/types.js` —— `Mat4`

### directional-light.ts

- `./types.js` —— `LightBase`
- `./light-base.js` —— `createLightBase`、`applyWorldMatrixAccessors`、`ObservableVec3`
- `./light-matrix.js` —— `localMatrixFromDirection`

### point-light.ts

- `./types.js` —— `LightBase`
- `../math/mat4.js` —— `createTranslationMat4`
- `./light-base.js` —— `createLightBase`、`applyWorldMatrixAccessors`、`ObservableVec3`

### hemispheric.ts

- `./types.js` —— `LightBase`
- `./light-base.js` —— `createLightBase`、`applyWorldMatrixAccessors`、`ObservableVec3`
- `./light-matrix.js` —— `localMatrixFromDirection`

### spot-light.ts

- `./types.js` —— `LightBase`
- `./light-base.js` —— `createLightBase`、`applyWorldMatrixAccessors`、`ObservableVec3`
- `./light-matrix.js` —— `localMatrixFromDirection`

### lights-ubo.ts

- `../light/types.js` —— `LightBase`、`LightBaseInternal`、`MAX_LIGHTS`、`LIGHT_ENTRY_FLOATS`

---

## 测试规范

1. **方向光默认值** —— `createDirectionalLight([0, -1, 0])` 返回 `lightType: 'directional'`、direction `(0,-1,0)`、position `(0,0,0)`、diffuse `[1,1,1]`、specular `[1,1,1]`、intensity `1`。
2. **点光源默认值** —— `createPointLight([5, 3, 0])` 返回 `lightType: 'point'`、position `(5,3,0)`、diffuse `[1,1,1]`、specular `[1,1,1]`、intensity `1`、range `Number.MAX_VALUE`。
3. **半球光默认值** —— `createHemisphericLight()` 返回 `lightType: 'hemispheric'`、direction `(0,1,0)`、intensity `1`、diffuseColor `[1,1,1]`、specularColor `[1,1,1]`、groundColor `[0,0,0]`。
4. **聚光灯默认值** —— `createSpotLight([0,10,0], [0,-1,0], PI/3, 2)` 返回 `lightType: 'spot'`、diffuse `[1,1,1]`、specular `[1,1,1]`、intensity `1`、range `Number.MAX_VALUE`。
5. **自定义强度** —— `createDirectionalLight([1,0,0], 2.5).intensity` 应为 `2.5`。
6. **可变性** —— 所有属性均应可直接赋值。`ObservableVec3` 属性支持 `.x`、`.y`、`.z` setter 以及 `.set(x,y,z)`。
7. **脏追踪** —— 设置 `direction.x = 5` 应递增 `worldMatrixVersion`。
8. **世界变换** —— 方向光的局部方向经其世界矩阵变换后应进行归一化。
9. **父级支持** —— 设置 `light.parent` 应影响 `worldMatrix` 计算。
10. **灯光类型标志** —— `_writeLightUbo` 应设置 w=0（点光源）、w=1（方向光）、w=2（聚光灯）、w=3（半球光）。
11. **聚光灯 UBO 打包** —— 聚光灯将 exponent 写入 `[11]`、direction 写入 `[12–14]`、cos(angle/2) 写入 `[15]`。
12. **灯光 UBO 打包** —— 对于方向光：`lightData.w = 1`，颜色预先乘以强度。
13. **灯光 UBO 打包** —— 对于点光源：`lightData.w = 0`，`lightDiffuse.a = range`。
14. **Lights UBO 大小** —— 默认情况下 `getLightsUboSize() = 272` 字节（16 字节头部 + 4 × 64）。
15. **fillLightsData 计数** —— 传入 6 个灯光时，仅打包前 4 个带有 `_writeLightUbo` 的灯光。
16. **PBR 单灯光选择** —— 单个非阴影灯光导入 `singlelight-wgsl.ts`，而不导入通用多灯光循环。
17. **PBR 多灯光选择** —— 多灯光或阴影接收体导入 `multilight-wgsl.ts`。

---

## 文件清单

| 文件                             | 职责                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/light/types.ts`             | `LightBase`、`LightBaseInternal` 接口；`MAX_LIGHTS`、`setMaxLights()`、`LIGHT_ENTRY_FLOATS`              |
| `src/light/light-base.ts`        | `createLightBase()`、`applyWorldMatrixAccessors()` —— 共享世界矩阵状态工厂；重导出 `ObservableVec3`     |
| `src/light/light-matrix.ts`      | `localMatrixFromDirection()` —— 根据方向和位置构建局部 4×4 矩阵                                          |
| `src/light/directional-light.ts` | `DirectionalLight` 接口 + `createDirectionalLight()` 工厂函数                                            |
| `src/light/point-light.ts`       | `PointLight` 接口 + `createPointLight()` 工厂函数                                                        |
| `src/light/hemispheric.ts`       | `HemisphericLight` 接口 + `createHemisphericLight()` 工厂函数                                            |
| `src/light/spot-light.ts`        | `SpotLight` 接口 + `createSpotLight()` 工厂函数                                                          |
| `src/render/lights-ubo.ts`       | 共享灯光 UBO 系统 —— `getLightsUboSize()`、场景灯光 GPU 状态、网格灯光选择；打包最多 `MAX_LIGHTS` 个灯光 |
