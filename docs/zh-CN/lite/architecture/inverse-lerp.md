# 模块：有界逆线性插值（Bounded inverse interpolation）

> 包路径：`packages/babylon-lite/src/math/inverse-lerp.ts`

## 目的与公共 API

```ts
export function inverseLerp(a: number, b: number, value: number): number;
```

从 `@babylonjs/lite` 导入 `inverseLerp`。它计算 `value` 在端点 `a` 与 `b` 之间的插值参数并钳制到 [0, 1]，与 Babylon.js 的 `Scalar.InverseLerp` 保持一致。同时支持递增区间与递减区间。

## 算法与状态

如果 `a === b`，则返回 0。否则计算 `(value - a) / (b - a)` 并使用 `Math.min(1, Math.max(0, parameter))` 进行钳制。第一个端点产生 0，第二个端点产生 1；区间外的值按端点顺序饱和。非有限输入遵循普通 JavaScript 算术规则，包括不确定比值产生的 NaN 传播。

该函数为纯函数且不产生任何内存分配。它没有依赖项、导入时初始化、缓存、所有权或生命周期。GPU 管线与着色器不适用。现有的 `Lerp` 与 `Normalize` 语义保持不变。

## 兼容性与隔离性

兼容层的 `Scalar.InverseLerp(a, b, value)` 直接转发到原生根辅助函数，而不重新实现数学逻辑。保留了公共名称与签名；仅修正了此前在区间外错误外推的问题。未使用的原生导入必须从使用方打包产物中完全消除。

## 测试规范

- 直接原生测试覆盖双向区间、区间内部/端点、区间外饱和以及退化区间。
- 兼容层回归/对照用例对照预期输出验证 Babylon.js 风格的转发 API。
- 移除任一边界约束都必须使对应的回归测试失败。
- 根导入无需引擎或 GPU 入口点即可暴露该辅助函数；未使用的导入应生成完全相同的代码。
- 完整声明、代码检查/类型检查以及重点原生场景字节数控制均保持现有的公共接口与体积契约。

## 文件清单

`math/inverse-lerp.ts`、原生根入口 `index.ts`、兼容层 `math/scalar.ts`、原生单元/构建测试、兼容层数学测试、本契约文档以及 Scalar 支持行记录。
