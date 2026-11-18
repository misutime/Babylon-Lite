# 模块：高斯点泼溅兼容辅助函数（Gaussian Point Splatting Compat Helpers）

> 包路径：`packages/babylon-lite/src/math/gaussian-point-splatting-compat-helpers.ts`

## 目的

提供 Babylon.js 的高斯点泼溅（Gaussian Point Splatting）渲染器所使用的两个确定性 CPU 计算函数，使兼容层包可以转发其公共根导出而无需持有渲染器行为。

## 内部 API 接口

```ts
function _hasGaussianPointSplattingProjectedDepth(projection: Mat4): boolean;
function _getGaussianPointSplattingPackedShBytesPerSplat(shDegree: number): number;
```

这两个导出均标记为 `@internal`，并在发布的 Lite 声明文件中移除。它们仍通过单一根入口点在运行时提供给单独发布的兼容层包使用。

## 内部架构

该模块无状态且零分配。投影深度检测读取将裁剪空间深度或齐次 W 与视图空间 X/Y 耦合的四个投影矩阵元素。打包球谐函数（SH）大小计算将阶数 1–4 映射到系数维度 3、8、15 和 24，随后将每个系数的三个 8 位颜色通道向上对齐到 4 字节边界。0 阶及负值不需要 SH 存储空间。

## 管线配置

不适用。

## 着色器逻辑

不适用。

## 状态机 / 生命周期

无保留状态或生命周期。

## Babylon.js 等价映射

- `_hasGaussianPointSplattingProjectedDepth` 对应 `_HasGaussianPointSplattingProjectedDepth`。
- `_getGaussianPointSplattingPackedShBytesPerSplat` 对应 `_GetPackedShBytesPerSplat`。

## 依赖关系

- 来自 `math/types.ts` 的 `Mat4`

## 测试规范

- 标准透视投影报告无依赖 X/Y 的投影深度。
- 离轴深度和 W 项报告存在投影深度。
- SH 阶数 0–4 返回精确的打包字节数。

## 文件清单

- `packages/babylon-lite/src/math/gaussian-point-splatting-compat-helpers.ts`
- `tests/lite/unit/gaussian-point-splatting-compat-helpers.test.ts`
