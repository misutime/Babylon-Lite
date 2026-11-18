# 模块：资源池（Resource Pool）

> 包路径：`packages/babylon-lite/src/resource/`

## 用途

提供 GPU 资源生命周期管理：基于引用计数的纹理所有权、去重的采样器创建，以及聚焦的 GPU 缓冲区创建工具。无副作用的外观（facade）模块保留了现有 API，同时通过独立的实现模块使打包仅保留实际使用到的操作组。

## 公共 API 接口

### 纹理引用计数

```typescript
/** Increment ref count on a Texture2D. First acquire sets count to 1. */
export function acquireTexture(tex: Texture2D): void;

/** Decrement ref count. Calls tex.texture.destroy() when count reaches 0.
 *  Returns true if the texture was destroyed. */
export function releaseTexture(tex: Texture2D): boolean;

/** Increment ref count on a raw GPUTexture (for env textures). */
export function acquireGPUTexture(tex: GPUTexture): void;

/** Decrement ref count on a raw GPUTexture. Destroys at 0.
 *  Returns true if the texture was destroyed. */
export function releaseGPUTexture(tex: GPUTexture): boolean;
```

### 内部纹理状态与捕获接缝

```typescript
/** Install the opaque release notification used by opt-in resource capture. */
export function _setTextureReleaseHook(hook: (tex: Texture2D) => void): void;

/** True only when the current GPUTexture has a retained zero-count entry. */
export function _isTextureReleased(tex: Texture2D): boolean;

/** Return the current GPUTexture owner count, or 0 when no entry exists. */
export function _textureOwners(tex: Texture2D): number;
```

### 采样器去重

```typescript
/** Get or create a deduplicated sampler. Same config → same GPUSampler.
 *  Default: all nearest, clamp-to-edge, anisotropy 1. */
export function getOrCreateSampler(engine: EngineContext, desc?: GPUSamplerDescriptor): GPUSampler;

/** Clear sampler cache for a device. */
export function clearSamplerCache(engine: EngineContext): void;
```

## 内部架构

### 模块边界

- `gpu-pool.ts` 是无副作用的重新导出外观模块。现有导入路径与包根 API 保持不变。
- `texture-references.ts` 是 `Texture2D` 所有权操作的无副作用外观模块。
- `texture-acquire.ts` 负责外观获取，并在读取或更新计数前一次性捕获 `texture.texture`。
- `texture-release.ts` 将捕获的分配对象及其外观转发给共享的释放记账逻辑。
- `gpu-texture-references.ts` 是用于独立原始获取与释放模块的兼容性外观。
- `gpu-texture-acquire.ts` 负责共享的自增操作；外观获取会转发一次捕获的分配对象。
- `gpu-texture-release.ts` 转发不带外观元数据的原始释放调用。
- `texture-allocation-release.ts` 负责共享的递减/销毁/保留零计数操作及可选的外观通知。钩子可以重新定向外观，而不会改变被捕获分配对象的保留零计数更新目标。
- `texture-owner-state.ts` 负责面向恢复机制的已释放状态/所有者查询。
- `texture-reference-store.ts` 提供唯一共享、懒分配的纹理计数 `WeakMap`。
- `texture-sampler-pool.ts` 负责共享的设备本地缓存以及强类型的普通纹理采样标识。
- `sampler-pool.ts` 是通用公共边界。它在使用同一缓存之前补充比较（comparison）与 LOD 标识，从而使普通纹理加载器不必保留这些未使用的特性。

不存在任何模块初始化时的分配操作。纹理计数与采样器缓存的 `WeakMap` 实例，以及每个设备的采样器 `Map`，均仅在首次使用时创建。

### 缓冲区操作边界

- `gpu-buffers.ts` 是保留现有缓冲区工具导出的无副作用外观模块。
- `buffer-alignment.ts` 负责通用的 `align(n, to)` 操作。
- `empty-uniform-buffer.ts` 负责不带初始上传的对齐 `UNIFORM | COPY_DST` 分配。
- `uniform-buffer.ts` 将空 Uniform 分配与初始队列上传组合在一起，并在上传失败时销毁尚未发布的缓冲区。
- `mapped-buffer.ts` 负责创建时即映射（mapped-at-creation）的顶点/索引/存储上传，包括最小尺寸和 4 字节对齐。

这些边界可防止精灵（sprite）及其他聚焦的消费方通过兼容性外观保留无关的缓冲区上传策略。

### 纹理引用计数

使用 `WeakMap<GPUTexture, number>` 维护引用计数：

- **`_textureReferences`**：将 `GPUTexture` 映射为引用计数（数字）
- `acquireTexture(tex)` / `acquireGPUTexture(tex)`：递增计数（若不存在则默认为 0，因此首次获取变为 1）
- `releaseTexture(tex)` / `releaseGPUTexture(tex)`：递减计数（若不存在则默认为 1，因此首次释放变为 0 并触发销毁）
- 计数为 0 时：调用 `tex.texture.destroy()`（Texture2D）或 `tex.destroy()`（原始 GPUTexture），随后在 WeakMap 中保留一条零计数条目
- `releaseTexture` 的执行顺序严格固定：销毁 GPU 纹理、通知可选的外观释放钩子，最后写入计数 0
- `releaseGPUTexture` 绝不调用外观钩子；它先销毁纹理，再写入计数 0
- 若已销毁返回 `true`，若仍有引用返回 `false`

**WeakMap 设计理由**：避免内存泄漏——如果 `GPUTexture` 对象本身被垃圾回收（存活期间不可能发生），该条目会自动清理。更重要的是，WeakMap 免去了对追踪映射表的显式清理需求。

保留的零计数条目用于区分“曾经释放过的分配”和“从未拥有所有者的纹理”。两者都会报告 `_textureOwners(tex) === 0`，但只有已释放的分配才会报告 `_isTextureReleased(tex) === true`。

两种 API 变体：

- `acquireTexture` / `releaseTexture`：接收 `Texture2D`（公共 API 类型）并在函数入口处捕获 `.texture` 快照。释放钩子可能会替换外观上的分配对象，但销毁与保留零计数写入仍针对最初捕获的分配对象。
- `acquireGPUTexture` / `releaseGPUTexture`：直接接收原始 `GPUTexture`（内部用于环境立方体贴图、BRDF LUT 等）。

### 采样器去重

使用 `WeakMap<GPUDevice, Map<string, GPUSampler>>` 实现按设备缓存：

- **`samplerCaches`**：将设备映射为 描述符键 → 采样器
- 一张带类型的不可变默认值表覆盖普通纹理采样参数。键生成按该固定表顺序遍历，而非调用方传入的属性顺序。
- 基础键格式：`":minFilter:magFilter:mipmapFilter:addressModeU:addressModeV:addressModeW:maxAnisotropy"`。当任意相关参数与 WebGPU 默认值不同时，公共边界会在前面加上 `"compare:lodMinClamp:lodMaxClamp"` 前缀。
    - 默认 LOD 键示例：`":linear:linear:nearest:clamp-to-edge:clamp-to-edge:clamp-to-edge:1"`
    - 比较采样器键示例：`"less:0:32:nearest:nearest:nearest:clamp-to-edge:clamp-to-edge:clamp-to-edge:1"`
    - 应用的默认值：各过滤模式为 nearest，寻址模式为 clamp-to-edge，各向异性为 1，无比较函数，LOD 最小值为 0，LOD 最大值为 32
    - `label` 不影响采样行为，因此排除在标识之外。比较函数和 LOD 钳位会影响行为；比较采样器绝不能与普通采样器发生别名冲突。
- 首次使用新键调用时创建采样器；后续调用直接返回缓存实例
- `getOrCreateSampler(engine, desc)` 读取 `engine._device`，将原始描述符原封不动传给 `device.createSampler`，并将结果缓存在计算出的键下
- `clearSamplerCache(engine)` 移除 `engine._device` 的全部缓存采样器

glTF 非 mipmap 采样器（`lodMaxClamp: 0`）复用同一套缓存；如今所有采样参数均参与标识构建，不再需要单独的绕过分配逻辑。

普通纹理加载器构造 `TextureSamplerDescriptor` 值，即使通过更宽泛类型的变量传递也禁止覆盖比较和 LOD 参数。它们使用受限的双参数缓存入口。只有通用采样器边界才能同时传入完整描述符及其规范化后的额外键。两个边界共享默认行为采样器标识与设备局部驱逐机制；设备恢复和 glTF 自定义采样器则使用完整的公共边界。

**`WeakMap<GPUDevice>`** 确保设备丢失或销毁时缓存会自动失效，无需显式清理。

采样器缓存的所有权归属于设备级，而非场景级或材质组级。`GPUSampler` 对象是不可变的且没有显式销毁操作，多个场景也可能共享同一个引擎/设备缓存。因此标准/PBR 材质组释放时仅清理其自身的管线缓存，绝不得调用 `clearSamplerCache(engine)`。`clearSamplerCache` 仍然作为显式操作保留，供明确希望驱逐单个设备完整缓存的调用方使用；随后的查找会按需重新创建条目。

### 内存布局

不管理缓冲区或 GPU 内存。本模块仅通过 JavaScript 侧的数据结构追踪所有权：

```
_textureReferences: WeakMap<GPUTexture, number>
  └── Key: GPUTexture instance
  └── Value: integer ref count, including retained 0 after destruction

_samplerCache: WeakMap<GPUDevice, Map<string, GPUSampler>>
  └── Key: GPUDevice instance
  └── Value: Map from descriptor string key → GPUSampler
```

## 管线配置

不适用 —— 无 GPU 管线。本模块管理纹理生命周期与采样器创建。

## 着色器逻辑

不适用 —— 无着色器。

## 状态机 / 生命周期

### 纹理生命周期

```
Texture created (loadTexture2D, createSolidTexture2D, etc.)
     │
     ▼
acquireTexture(tex) ──► refCount = 1
     │
     ├── acquireTexture(tex) ──► refCount++
     │
     ├── releaseTexture(tex) ──► refCount--
     │         │
     │         ├── refCount > 0: keep alive
     │         │
     │         └── refCount <= 0:
     │               tex.texture.destroy()
     │               optional facade release hook
     │               retain refCount = 0
     │               return true
     │
     └── (GPUTexture GC'd if all JS refs gone — WeakMap entry auto-cleaned)
```

### 采样器生命周期

```
getOrCreateSampler(engine, desc)
     │
     ├── Cache hit: return existing GPUSampler
     │
     └── Cache miss: engine._device.createSampler(desc), cache, return

clearSamplerCache(engine)
     └── Explicitly delete all entries for engine._device

Scene/material-group disposal
     └── Leave the shared device sampler cache intact
```

## Babylon.js 对照表

| Babylon.js                                          | Babylon Lite                                    |
| --------------------------------------------------- | ----------------------------------------------- |
| `ThinEngine._samplerCache`                          | `_samplerCache` WeakMap + `getOrCreateSampler()` |
| `Texture.dispose()` + `InternalTexture._references` | `acquireTexture()` / `releaseTexture()` 引用计数 |
| `BaseTexture.releaseInternalTexture()`              | `releaseGPUTexture()`                           |

## 依赖项

- `../texture/texture-2d.js` —— 用于外观所有权和查询的纯类型 `Texture2D` 依赖
- `../engine/engine.js` —— 用于采样器操作的纯类型 `EngineContext` 依赖
- `texture-reference-store.ts` —— 供原始模块、外观模块与查询模块使用的共享懒计数存储

## 测试规范

1. **基础获取/释放**：获取一次、释放一次 → 纹理被销毁，返回 true
2. **多次获取**：获取 3 次、释放 2 次 → 未销毁；第 3 次释放 → 销毁
3. **默认释放**：未经获取直接释放 → 视作计数 1，执行销毁
4. **采样器去重**：相同描述符返回相同的 `GPUSampler` 实例
5. **不同描述符采样器**：不同描述符返回不同的 `GPUSampler`
6. **采样器键**：验证键包含带默认值的全部 7 个描述符字段
7. **清空采样器缓存**：验证缓存已清空；下次调用创建新采样器
8. **设备隔离**：两个设备维护各自独立的采样器缓存
9. **`GPUTexture` 变体**：验证 `acquireGPUTexture`/`releaseGPUTexture` 对原始纹理表现一致
10. **混合所有权**：原始所有者与外观所有者共享同一计数
11. **释放顺序**：外观释放先销毁，在仍可观测到旧计数时调用钩子，最后记录零计数
12. **无主对象**：原始释放与外观释放均默认存在 1 个隐式所有者并执行销毁
13. **描述符透传**：采样器创建原样接收原始描述符
14. **释放重定位**：释放钩子可替换 `texture.texture`；仅被捕获的旧分配对象被销毁并标记为零
15. **获取捕获**：外观获取仅读取一次 `texture.texture` 并仅递增该分配对象的计数

## 文件清单

| 文件                            | 用途                                               |
| ------------------------------- | -------------------------------------------------- |
| `gpu-pool.ts`                   | 保留全部现有导出的无副作用外观                     |
| `texture-reference-store.ts`    | 共享懒分配的 `GPUTexture` 引用计数 `WeakMap`       |
| `texture-references.ts`         | `Texture2D` 所有权操作的无副作用外观               |
| `texture-acquire.ts`            | 捕获分配对象后的外观获取                           |
| `texture-release.ts`            | 捕获分配对象后的外观释放                           |
| `gpu-texture-references.ts`     | 无副作用的原始所有权外观                           |
| `gpu-texture-acquire.ts`        | 共享分配对象引用自增                               |
| `gpu-texture-release.ts`        | 不带外观通知的原始分配对象释放                     |
| `texture-allocation-release.ts` | 共享递减、销毁、通知顺序及保留零计数               |
| `texture-owner-state.ts`        | 已释放状态与所有者计数查询                         |
| `sampler-pool.ts`               | 包含比较与 LOD 规范化的通用采样器边界              |
| `texture-sampler-pool.ts`       | 共享按设备缓存及类型受限的普通纹理采样器标识       |
| `gpu-buffers.ts`                | 缓冲区创建工具的无副作用外观                       |
| `buffer-alignment.ts`           | 通用对齐操作                                       |
| `empty-uniform-buffer.ts`       | 空对齐 Uniform 缓冲区分配                          |
| `uniform-buffer.ts`             | 带初始化的 Uniform 缓冲区分配与上传回滚            |
| `mapped-buffer.ts`              | 创建时即映射（mapped-at-creation）的缓冲区上传     |
