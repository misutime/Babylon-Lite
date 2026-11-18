# 模块：材质插件（material-plugin）

> 包路径：`packages/babylon-lite/src/material/plugin/`

## 目的

公开、**选装（opt-in）**的材质插件支持 —— Babylon-Lite 中对应 BJS `MaterialPluginBase` 的实现。插件允许在保留完整内置光照 / IBL / 阴影管线的同时，将自定义 WGSL + uniform + 采样器叠加到现有的 **PBR** 或 **Standard** 材质上。插件是纯数据对象（GUIDANCE §4b′），通过 `material.plugins = [plugin]` 按实例附加。

插件支持是**显式选装**：应用程序导入并调用 `enableMaterialPlugins(scene)`（在创建材质/网格之后、`registerScene` 之前）。该调用是唯一会将插件桥接及其 WGSL 拉入场景模块图的入口。共享的 Standard 扩展调用携带材质和场景上下文；可选的变体键钩子提供缓存标识。插件标志、标识编码以及场景局部 UBO 状态属于桥接层。

声明了自定义插值变量（varying）或顶点可见的 uniform、纹理或采样器的 PBR 插件则改用独立的 `enablePbrMaterialPluginVertexData()` 入口点。保持该桥接独立可为现有的片元插件以及所有未选择启用的场景保留字节完全一致的 bundle。

## 公共 API 接口

```ts
// material/plugin/material-plugin.ts (all type-only — erased at build)
export type MaterialPluginPoint =
    | "CUSTOM_FRAGMENT_DEFINITIONS"
    | "CUSTOM_FRAGMENT_MAIN_BEGIN"
    | "CUSTOM_FRAGMENT_UPDATE_ALPHA"
    | "CUSTOM_FRAGMENT_UPDATE_DIFFUSE"
    | "CUSTOM_FRAGMENT_BEFORE_LIGHTS"
    | "CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION"
    | "CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR"
    | "CUSTOM_VERTEX_MAIN_BEGIN"
    | "CUSTOM_VERTEX_UPDATE_WORLDPOS"
    | "CUSTOM_VERTEX_MAIN_END";

export interface PluginUboField {
    readonly name: string;
    readonly type: string;
    readonly visibility?: "vertex" | "fragment" | "vertex-fragment";
} // WGSL type verbatim
export interface PluginVaryingDecl {
    readonly name: string;
    readonly type: "f32" | "vec2f" | "vec3f" | "vec4f" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>";
}
export interface PluginSamplerDecl {
    readonly texture: string;
    readonly sampler: string;
    readonly textureType?: "texture_2d<f32>";
    readonly depthTexture?: boolean; // PBR vertex-resource bridge only
    readonly samplerType?: "sampler" | "sampler_non_filtering";
    readonly visibility?: "vertex" | "fragment" | "vertex-fragment";
}
export interface PluginTextureBinding {
    readonly texture: Texture2D;
} // no GPU handles (§4d)

export interface MaterialPlugin {
    readonly name: string;
    priority?: number; // lower runs first; default 500
    isEnabled?: boolean; // default true when attached
    dynamic?: boolean; // refresh Standard-material UBO values every frame
    defines?: Record<string, boolean | number>;
    getCustomCode?(shaderType: "vertex" | "fragment"): Partial<Record<MaterialPluginPoint, string>> | null;
    getUniforms?(): { ubo?: PluginUboField[] };
    getVaryings?(): PluginVaryingDecl[];
    getSamplers?(): PluginSamplerDecl[];
    writeUbo?(data: Float32Array, offsets: ReadonlyMap<string, number>): void;
    bindTextures?(out: PluginTextureBinding[]): void;
    getActiveTextures?(out: Texture2D[]): void;
}

// material/material.ts
interface Material {
    /* … */ plugins?: MaterialPlugin[];
}
```

公共导出（`index.ts`）：`MaterialPlugin`、`MaterialPluginPoint`、`PluginUboField`、`PluginVaryingDecl`、`PluginSamplerDecl`、`PluginTextureBinding`（全部为 `export type`），加上运行时函数 `enableMaterialPlugins(scene)` 和 `bakeStdPluginMaterial(material, scene)`，以及仅限 PBR 的顶点资源启用器 `enablePbrMaterialPluginVertexData()`。

## PBR 顶点资源选装

```ts
material.plugins = [vertexPlugin];
enablePbrMaterialPluginVertexData();
await registerScene(scene);
```

当 PBR 插件使用 `getVaryings()`、顶点可见 UBO 字段或顶点可见采样器时，请使用此入口点代替 `enableMaterialPlugins(scene)`。其专用桥接仅修补该组合 PBR 着色器的材质 UBO 可见性和顶点声明。它不修改通用的着色器组合器。一旦启用，当 `enableMaterialPlugins(scene)` 或 `reconcileMaterialPlugins(scene, material)` 重新注册插件支持时，具备顶点能力的桥接仍保持为活跃的 PBR 插件桥接，因此实时插件变更可保留其顶点资源。两个 PBR 桥接在一个惰性共享注册表中分配标识并存储不可变的着色器片段。因此普通变体和顶点资源变体不会在组合器或绑定缓存中发生冲突，且在顶点桥接启用前创建的片段仍可解析，无需对现有材质重新编号。

## 选装入口点 —— `enableMaterialPlugins(scene)`

```ts
const mat = createStandardMaterial();
mat.plugins = [myPlugin]; // attach (any number of materials)
box.material = mat;
addToScene(scene, box);

enableMaterialPlugins(scene); // ← the ONLY thing that loads plugin code
await registerScene(scene);
```

`enableMaterialPlugins`（`material/plugin/enable-material-plugins.ts`）静态导入两个桥接（这是合理的 —— 仅当应用调用它时它本身才可达），并且：

1. 将 **PBR** 插件扩展（`registerPbrPlugins`）和 **Standard** 插件扩展（`registerStdPlugins`）注册到全局 `_getPbrExts()` / `_getStdExts()` 注册表中。通用可渲染对象钩子循环随后即可在不导入插件实现的情况下调用其片段和绑定回调。
2. 仅针对 **Standard** 插件材质（通过 `_buildGroup === standardGroupBuilder` 过滤，因此绝不会触碰 PBR 材质），遍历 `scene.meshes` 并将逐签名索引预烘焙到 `mat._pi` 中。Standard 的插件扩展仅贡献一个逐可渲染对象的存在标志（第 25 位）；标识本身绝不占用顶点 alpha 或骨骼特性位。PBR 无需遍历 —— 其 `detect` 钩子在特性计算期间分配 `_pi`。
   在此遍历之后创建的 Standard 材质可以使用 `bakeStdPluginMaterial(material, scene)` 显式注册。不带插件的材质保持原样，从而使其正常的惰性特性检测在构建之前保持有效。

插件实现保持在常加载的 PBR/Standard 图之外；仅通用的 Standard 绑定钩子携带场景所有权上下文。

## 注入点 → Lite 槽位映射

| BJS `MaterialPluginPoint` | Lite 槽位 | 说明 |
| -------------------------------------------- | ----------------------- | ------------------------------------ |
| CUSTOM_FRAGMENT_DEFINITIONS | `_helperFunctions` (HF) | 辅助函数 / 结构体 |
| CUSTOM_FRAGMENT_MAIN_BEGIN | SV | 片元作用域变量，位于序言之后 |
| CUSTOM_FRAGMENT_UPDATE_ALPHA | AT | alpha 测试区域 |
| CUSTOM_FRAGMENT_UPDATE_DIFFUSE | AC | Standard 漫反射更新 |
| CUSTOM_FRAGMENT_BEFORE_LIGHTS | MF | f0 之后、光照之前 |
| CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION | NI | IBL / 非 IBL 颜色尾部之后 |
| CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR | BC | 色调映射 + 伽马之后（演示使用此槽位） |
| CUSTOM_VERTEX_MAIN_BEGIN | VR | |
| CUSTOM_VERTEX_UPDATE_WORLDPOS | VW | |
| CUSTOM_VERTEX_MAIN_END | VB | |

仅复用**现有的**模板槽位 —— 不添加新的 `/*XX*/` 标记（那会使每个 PBR/Standard 场景的模板膨胀）。在 `BC` 槽位处，PBR（`vec3<f32>`）和 Standard（`vec4<f32>`）中的颜色变量均命名为 `color`，因此逐分量写入（`color.r = …`）同时适用于两个材质族。

刻意**不**实现来自 BJS 的 `RegisterMaterialPlugin` 全局自动附加 —— 它会引入模块级副作用（禁止，GUIDANCE §4）。请使用按实例的 `material.plugins = [...]`。

## 内部架构（桥接数据流）

```
material.plugins ──► enableMaterialPlugins(scene) ──► {pbr,std}-plugin-bridge ──► PbrExt / StdExt
                                                        │
                                  plugin-bridge-shared.ts
                                  ├─ pluginSignature(plugins)  → stable cache key string
                                  ├─ buildPluginFragment(plugins, idx, forStandard) → { _fragment, _stdUboSpec }
                                  │     getCustomCode → _fragmentSlots / _vertexSlots / _helperFunctions
                                  │     getUniforms.ubo → _uboFields (PBR) | self-managed fragment `pluginUbo` binding (Standard)
                                  │     getSamplers → fragment texture+sampler bindings
                                  ├─ writePluginUbo  → plugin.writeUbo(data, offsets)
                                  └─ bindPluginTextures → plugin.bindTextures → GPU entries

material.plugins ──► enablePbrMaterialPluginVertexData()
                  └─► pbr-plugin-vertex-bridge.ts
                      └─► pbr-plugin-vertex-data.ts
                          ├─ custom varyings and vertex-visible resources
                          └─ `_pc` patch for the opted-in PBR material UBO only
```

每个材质在烘焙其插件签名时按稳定的优先级顺序缓存已启用的插件。逐帧 UBO 写入直接遍历该准备好的列表；过滤和排序保留为构建期工作，而非动画材质热路径工作。

单个桥接扩展处理材质上的所有插件。每个不同的插件**签名**（所有已附加插件的名称 + 优先级 + isEnabled + defines + 自定义代码 + uniform + 采样器）会被分配一个小的**索引**。PBR 将该索引单独存储在 `Material._pi` 上，Standard 也同样如此，因此两者的标识都不会与原生材质或网格特性位冲突。两个材质族都在其组合/管线缓存键中包含该索引，因此任何插件更改——包括启用/禁用——都会生成不同的着色器变体。签名注册表是只追加（append-only）的：启用另一个场景、重建或更换设备绝不会重新分配仍被活跃材质引用的标识。注册表条目保留编译后的片段数据，而非材质实例或逐实例 UBO 回调。

### PBR（`pbr-plugin-bridge.ts`）

通过 `_registerPbrExt` 注册的 `PbrExt { id: "plugin", phase: "fragment" }`：

- `detect(mat)` 惰性分配 `mat._pi`，不贡献原生特性位。
- `frag(ctx)` 解析 `ctx._pi` 对应的片段。
- `writeUbo(data, mat, offsets)` → 将插件 UBO 切片写入**材质 UBO**（PBR 模板具有 `_baseMaterialUboFields`，因此片段 `_uboFields` 以它为目标；WGSL 访问方式为 `material.<field>`）。
- `bind` / `textures` → 采样器 + 获取/释放。
  所有五个钩子都已由核心通过全局 `_getPbrExts()` 注册表迭代调用（detect 在 `_computePbrMaterialFeatures`、frag 在 `pbr-compose`、writeUbo 在 `writeMaterialData`、bind 在 `createPbrMeshBindGroup`、textures 在 `collectPbrBoundTextures`），因此**完全无需修改任何核心 PBR 文件** —— `enableMaterialPlugins` 只需在构建运行前注册该扩展即可。

### Standard（`std-plugin-bridge.ts`）

通过 `_registerStdExt` 注册的 `StdExt { _id: "plugin", _phase: "mesh", _feature: 1 << 25 }`。Standard 具有固定布局的材质 UBO，因此桥接执行以下操作：

- 将签名索引预烘焙到每个插件材质的 `_pi` 中，仅针对 Standard 材质在 `registerStdPlugins` 中完成。`_meshFeatures` 从当前标识推导存在位，而不是将其缓存在材质视图上。`_frag` 与特性掩码分开接收材质。普通/阴影着色器键和几何体视图变体键均包含 `_pi`，
- 通过**自管理的 uniform 缓冲区**（而非网格 UBO）传递插件 uniform。`buildPluginFragment(plugins, idx, /*forStandard*/ true)` 发出专用的 `var<uniform> pluginUbo : pluginUboUniforms;` 片元绑定（结构体声明在 `_helperFunctions` 中），而不是将 `_uboFields` 追加到网格 UBO。桥接为每个材质构建一个 `GPUBuffer`，因此具有相同着色器签名的材质可以保留不同的 uniform 值，并从 `StdExt._bind` 推入其绑定条目——位于纹理条目**之前**，匹配绑定声明顺序——随后是 `bindPluginTextures`。

标记为 `dynamic: true` 的 Standard 插件在每帧之前重写其逐材质 UBO 值。动态跟踪和 UBO 所有权限定在启用该插件的场景作用域内，因此启用第二个场景不会替换第一个场景的刷新状态。Standard 绑定构建器将所属场景传入插件扩展，因此由多个场景共享的同一个材质会解析各自场景的独立 UBO；销毁任一场景都不会使另一个场景的绑定失效。静态插件保留注册时上传的值。重新烘焙材质会将每个受影响的网格排入材质切换重建队列。旧 UBO 的释放会附加到这些可渲染对象现有的销毁器数据包上。异步逐网格和全组重建会暴露它们临时从 `scene._meshDisposables` 移除的数据包，因此任一窗口期间的重新烘焙都可以附加到同一个待处理清理上。只要切换队列或异步组构建被阻塞，旧缓冲区就保持有效。仅当每个受影响的替换绑定组都已提交后，旧缓冲区才会在后续 GPU 栅栏后退役。销毁场景会销毁其所有剩余的插件 UBO，并释放桥接持有的材质引用。

场景成员资格和材质 setter 事件在选装桥接中维护逐材质的网格使用者列表。移除或替换最后一个使用者会立即停止动态上传；不使用帧时间网格扫描。绑定所有者还会通过销毁器回调保留其精确的 UBO 代次，包括显式覆写和几何体视图。当网格的主材质更改时，覆写仍保持活跃。一旦场景使用者和辅助绑定所有者都消失，材质就会离开活跃映射表；GPU 释放会等待未完成的绑定销毁器和提交退役栅栏。

烘焙未附加的材质会准备其签名，而不分配无主 UBO。第一个场景使用者或自有绑定会分配该缓冲区。重新添加先前已退役的材质会创建新的分配，而同一场景中的多个网格共享它。

重新烘焙具有失败原子性（failure-atomic）。提议的已启用插件列表、签名、原生特性位、uniform 内容以及替换 GPU 状态会先在本地准备好。抛异常的插件回调或分配/上传失败会保持先前的材质标识、已准备列表、特性缓存、场景状态和绑定所有者不变。失败的临时上传会销毁其新缓冲区。仅当准备成功时才会发布新代次并调度前一版本的退役；不会回滚调用者编写的 `material.plugins`。

决定性的优势：这条路径不会向 Standard 可渲染对象添加任何 `_writeUbo` 钩子或插件 UBO 循环。`standard-pipeline.ts` / `collect-std-bound-textures.ts` 中预先存在的 `StdExt._bind` / `_textures` 循环以及 `standard-renderable.ts` 中的 `_frag` 循环承载了插件；绑定钩子接收所属场景以便选择场景局部 UBO 状态。WGSL 访问 Standard 插件 uniform 的方式为 `pluginUbo.<field>`（PBR 访问方式为 `material.<field>`）。

## 管线配置 / 缓存编键

- PBR 组合、绑定和几何输出缓存键包含 `Material._pi`，它无需消耗原生特性位即可区分插件变体。
- PBR 管线 + 绑定还包含 `_fragmentKey`（排序后的片段 ID）；插件片段 ID 为 `plugin-<index>`，在 `createPbrMeshBindGroup` 中通过 `fid.startsWith("plugin-")` 匹配回扩展。
- Standard 主/阴影和几何体键通过选装的 `_stdMaterialVariantKey` 解析器包含 `_pi`。插件桥接拥有签名编码；当它不存在时，空解析器及其编键分支会被 tree-shake 移除。

## 着色器逻辑（演示：BlackAndWhite 灰度）

在 `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` → `BC`（色调映射 + 伽马之后）注入：

```wgsl
let bwLuma = dot(color.rgb, vec3<f32>(0.3, 0.59, 0.11));
color.r = bwLuma; color.g = bwLuma; color.b = bwLuma;
```

BJS 参考插件在 `finalColor`（PBR）/ `color`（Standard）的相同位置注入等价代码。由于灰度化之前的颜色已经达成一致性匹配，且灰度化是线性缩减，结果保持像素级一致。

## 状态机 / 生命周期

1. 用户设置 `material.plugins = [plugin]`，调用 `enableMaterialPlugins(scene)`，然后调用 `registerScene`。
2. `enableMaterialPlugins` 将 PBR + Standard 插件扩展注册到全局注册表（Standard 还会为其材质预烘焙独立的着色器标识并构建任何自管理插件 UBO）。
3. 逐网格：detect（PBR）/ 预烘焙的 `_pi`（Standard）提供签名索引 → 组合器使用插件片段构建 WGSL → 创建管线/绑定组 → 绑定 UBO + 纹理。
4. **切换 / 重新烘焙**：设置 `plugin.isEnabled`，然后调用 `bakeStdPluginMaterial(material, scene)`。新的签名索引产生全新的管线；受影响的绑定通过场景的材质切换队列重建，且被替换的插件 UBO 安全退役。移除最后一个插件仅当该场景确实存在已有插件状态时才清除缓存的 Standard 特性；无插件的材质绝不会被 `enableMaterialPlugins` 急切缓存。
5. **销毁**：`disposeScene(scene)` 销毁该场景拥有的每个剩余 Standard 插件 UBO，并丢弃其逐材质刷新状态。

## Babylon.js 等价映射

| BJS | Lite |
| ------------------------------------- | --------------------------------------------- |
| `MaterialPluginBase`（类） | `MaterialPlugin`（纯对象） |
| `getCustomCode(type, lang)` | `getCustomCode(type)`（仅 WGSL） |
| `prepareDefinesBeforeAttributes` 等 | `defines`（折叠进缓存键） |
| `getUniforms()` / `bindForSubMesh` | `getUniforms()` / `writeUbo()` / `bindTextures` |
| `RegisterMaterialPlugin`（全局） | （省略 —— 仅按实例附加） |

## 依赖项

- `shader/fragment-types.ts`（ShaderFragment、槽位、UboField、BindingDecl）
- `material/pbr/pbr-flags.ts`（PbrExt）、`material/standard/standard-flags.ts`（StdExt）
- `texture/texture-2d.ts`（Texture2D）

## 测试规范

- 场景 217（`scene217-material-plugin`）：一个 PBR 球体**和**一个 Standard 盒子，各自启用 BlackAndWhite 插件，针对使用等价 `MaterialPluginBase` BlackAndWhite 插件的 BJS 基准进行验证。MAD ≤ `scene-config.maxMad`。
- 单元测试验证跨两个场景的独立动态刷新状态、场景销毁清理、共享材质的场景隔离、惰性无插件特性检测，以及当材质切换队列被阻塞时再次烘焙 Standard 材质时的替换 UBO 重绑定/退役（包括 `_meshDisposables` 临时无数据包的逐网格和全组异步构建窗口）。
- 标识回归覆盖包括超过 127 个 Standard 签名、顶点 alpha、四/八骨骼蒙皮、阴影/几何体视图、插件移除以及在共享或独立设备上同时运行多个 PBR 场景随后进行重建/恢复。
- Bundle 体积：`bundle-size.spec.ts` 保护通用场景上下文传播，并验证插件实现在无插件场景图中保持缺席。

## 文件清单

- `material/plugin/material-plugin.ts` —— 公共类型。
- `material/plugin/plugin-bridge-shared.ts` —— 签名 + 片段构建器（`forStandard` 选择网格 UBO `_uboFields` 与自管理 `pluginUbo` 绑定）+ UBO/纹理辅助函数。
- `material/plugin/pbr-plugin-bridge.ts` —— PBR `PbrExt`。
- `material/plugin/std-plugin-bridge.ts` —— Standard `StdExt` + 自管理 UBO。
- `material/plugin/enable-material-plugins.ts` —— 选装入口点。
- 共享 Standard 钩子：`standard-flags.ts`、`standard-pipeline.ts`、`standard-renderable.ts` 和 `standard-geometry-renderable.ts` 将材质上下文传播到片段选择，并将 `SceneContext` 传播到绑定。可选的变体键解析器贡献缓存标识；核心中不存在任何特定于插件的绑定循环或签名注册表。
