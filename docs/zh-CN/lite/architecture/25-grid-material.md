# 模块：网格材质（Grid Material）

> 包路径：`packages/babylon-lite/src/material/grid/`

## 目的

GridMaterial 模块提供了 Lite 中对应 Babylon.js `GridMaterial`（来自 `@babylonjs/materials`）的实现：一个可包裹任意网格的**无光照、程序化、物体空间网格材质**。它是完全构建在 [ShaderMaterial](24-shader-material.md) 之上的轻量工厂函数——根据强类型选项组合最小空白字符的 WGSL，并构造一个 `ShaderMaterial`。它不引入新的管线、可渲染对象或组构建器，而是端到端复用着色器材质基础设施，因此保持完全可 tree-shake，且对从不导入它的场景零开销。

网格数学计算运行在**物体空间**中：顶点阶段将物体空间位置和法线作为插值变量（varying）传递，片元阶段根据物体空间位置的屏幕空间导数（`dpdx`/`dpdy`）推导各轴向的线条贡献，并按表面法线加权。这与 Babylon 的 `grid.vertex`/`grid.fragment` WGSL 数学逻辑一致（重新移植，而非直接拷贝）。

## 公共 API 接口

### 工厂函数

```typescript
export function createGridMaterial(options?: GridMaterialOptions): ShaderMaterial;
```

`createGridMaterial` 是同步的，并返回一个配置好的 `ShaderMaterial`。像其他任何 Lite 材质一样将结果赋值给 `mesh.material`。由于它_本质上就是_一个 `ShaderMaterial`，其 uniform 可在运行时通过 `setShaderUniform()` / `setShaderVector3()` 等更新（例如 `setShaderVector3(grid, "lineColor", [...])`）。

### 选项

```typescript
export type GridVec3 = readonly [number, number, number];

export interface GridMaterialOptions {
    readonly name?: string;
    readonly mainColor?: GridVec3; // background between lines.  default [0,0,0]
    readonly lineColor?: GridVec3; // grid line color.           default [0,0.5,0.5] (teal)
    readonly gridRatio?: number; // unit spacing.              default 1
    readonly gridOffset?: GridVec3; // object-space offset.       default [0,0,0]
    readonly majorUnitFrequency?: number; // every Nth line is major (Math.round). default 10
    readonly minorUnitVisibility?: number; // 0..1 minor-line visibility. default 0.33
    readonly opacity?: number; // <1 enables transparent path. default 1
    readonly antialias?: boolean; // cosine AA vs hard cutoff.  default true
    readonly preMultiplyAlpha?: boolean; // rgb *= alpha (transparent path only). default false
    readonly useMaxLine?: boolean; // combine axes with max() vs sum. default false
    readonly opacityTexture?: Texture2D; // .a multiplies final opacity (adds uv attribute + sampler)
    readonly visibility?: number; // final-alpha multiplier.    default 1
    readonly backFaceCulling?: boolean; // default true
}
```

所有字段均回退到 Babylon `GridMaterial` 的默认值。

## 着色器组合

该工厂针对 ShaderMaterial 序言（`shaderSystem` = world/view/projection、`shaderUniforms` = 自定义 UBO、可选的 `opacitySampler`）组合两个 WGSL 阶段：

- **顶点阶段**（`mainVertex`）：`clip = projection * view * world * position`；输出 `vPosition`（物体空间位置）、`vNormal`（物体空间法线），仅当提供透明度纹理时才输出 `vUv`。
- **片元阶段**（`mainFragment`）：`gridPos = (vPosition + gridOffset) / gridRatio`；计算每个轴向的 `gridContrib`（基于导数的线宽、动态主/次线可见性、各向异性衰减），按 `normalImpact = clamp(1 - 3·|n³|)` 为各轴向加权，合并各轴，并按网格值将 `mainColor → lineColor` 混合。

编译期开关会**按条件烘焙**进组合后的字符串（绝不作为针对未声明资源的死代码引用）：

| 选项 | 对 WGSL 的影响 |
| ------------------ | ------------------------------------------------------------------- |
| `antialias` | 在 `gridIsOnLine` 中采用余弦衰减还是硬性 `SQRT2/4` 截断 |
| `useMaxLine` | `grid = max(x,y,z)` 还是 `grid = x + y + z` |
| `opacity < 1` | 透明路径：`opacity = clamp(grid, 0.08, gridControl.w·grid)` |
| `preMultiplyAlpha` | 仅透明路径：`rgb *= opacity` |
| `opacityTexture` | 声明 `uv` 属性 + `opacitySampler` 并乘以 `.a` |

### Uniform 打包

单个 `gridControl` vec4 打包了动态标量，与 Babylon 匹配：

```
gridControl = (gridRatio, round(majorUnitFrequency), minorUnitVisibility, opacity)
```

其他自定义 uniform：`mainColor` (vec3)、`lineColor` (vec3)、`gridOffset` (vec3)、`visibility` (f32)。系统 uniform：`world`、`view`、`projection`。

## 渲染状态

- `needAlphaBlending = (opacity < 1) || opacityTexture` → 标准 `"alpha"`（src-over）混合；混合期间自动禁用深度写入（ShaderMaterial 管线行为）。
- `backFaceCulling` 默认为 `true`；`depthCompare` 继承 ShaderMaterial 默认值（`"greater-equal"`，反向 Z）。

## 移植说明

Babylon 的 `GridMaterial` 读取 `mesh.visibility`；Lite 改为在材质上将同一乘数暴露为 `visibility` 选项（单向数据所有权 —— 材质不反向触及网格）。Babylon `@babylonjs/materials` ≥ 9.10 将经典的仅线条透明度（`clamp(grid, 0.08, opacity·grid)`）移至其 `linesOnly` 标志之后；Lite 在透明路径中直接实现了该公式。

## 参考场景

场景 213（`scene213-gridmaterial`）针对 `@babylonjs/materials` `GridMaterial` 基准验证了所有特性：一个不透明抗锯齿青色地面、一个 `useMaxLine` 球体、一个透明 alpha 混合盒子（`opacity 0.6`）以及一个硬截断（`antialias:false`）盒子。

## 文件清单

| 文件 | 职责 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/material/grid/grid-material.ts` | `createGridMaterial()` + `GridMaterialOptions` / `GridVec3`；组合 WGSL 并构建 `ShaderMaterial` |
