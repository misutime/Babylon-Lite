# 模块：朝向矩阵（Look-Direction Matrices）

> 包路径：
>
> - `packages/babylon-lite/src/math/write-mat4-from-look-direction-into-buffer.ts`
> - `packages/babylon-lite/src/math/write-quat-from-rotation-mat4-into-ref.ts`

## 目的

根据已归一化且正交的前向（forward）和上向（up）向量构建左手系和右手系朝向矩阵。这些辅助函数直接写入调用方拥有的存储中，使 Babylon.js 风格的适配器能够保留输出参数引用身份，而无需重新实现朝向数学逻辑。

配套的矩阵转四元数函数写入调用方拥有的四元数存储中，使适配器能够保留输出引用身份，而无需分配中间四元数对象。

## 公共 API 接口

```ts
function writeMat4FromLookDirectionLHIntoBuffer<T extends Float32Array | Float64Array>(out: T, forward: Vec3, up: Vec3): T;

function writeMat4FromLookDirectionRHIntoBuffer<T extends Float32Array | Float64Array>(out: T, forward: Vec3, up: Vec3): T;

function writeQuatFromRotationMat4IntoRef<T extends Quat>(matrix: Mat4, out: T): T;
```

朝向函数要求输入为已归一化且正交的向量。每个函数均返回其调用方拥有的输出对象。

## 内部架构

这些模块无分配且无状态。朝向写入函数直接根据两个输入向量计算剩余的基轴并写入全部 16 个矩阵元素。四元数写入函数将矩阵基委托给 Lite 共享的 `_quatFromRotationBasis` 转换函数并写入调用方的输出对象。

## 管线配置

不适用。

## 着色器逻辑

不适用。

## 状态机 / 生命周期

无保留状态或生命周期。

## Babylon.js 等价映射

- `writeMat4FromLookDirectionLHIntoBuffer` 对应 `Matrix.LookDirectionLHToRef`：局部 `+Z` 映射到 `forward`，局部 `+Y` 映射到 `up`，且 `right = up × forward`。
- `writeMat4FromLookDirectionRHIntoBuffer` 对应 `Matrix.LookDirectionRHToRef`：局部 `-Z` 映射到 `forward`，局部 `+Y` 映射到 `up`，`back = -forward`，且 `left = up × back`。

两个矩阵的平移分量均为零，齐次右下角元素值为 1。

- `writeQuatFromRotationMat4IntoRef` 对应 `Quaternion.FromRotationMatrixToRef`，将矩阵的旋转分量写入提供的四元数中，不产生分配。

## 依赖关系

- 来自 `math/types.ts` 的 `Vec3`
- 来自 `math/types.ts` 的 `Mat4` 和 `Quat`
- 来自 `math/create-quat-from-rotation-mat4.ts` 的 `_quatFromRotationBasis`

## 测试规范

- 两种手性各自对应的单位朝向。
- 非平凡前向方向将文档指定的局部轴映射到 `forward`。
- 返回调用方提供的存储且重置平移分量。
- 泛型契约同时支持 `Float32Array` 和 `Float64Array` 存储。
- 矩阵转四元数转换返回并原地修改调用方拥有的存储。

## 文件清单

- `packages/babylon-lite/src/math/write-mat4-from-look-direction-into-buffer.ts`
- `packages/babylon-lite/src/math/write-quat-from-rotation-mat4-into-ref.ts`
- `tests/lite/unit/look-direction-matrices.test.ts`
