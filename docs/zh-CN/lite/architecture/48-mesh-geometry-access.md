# 模块：网格几何体访问

> 包路径：`packages/babylon-lite/src/mesh/get-mesh-geometry.ts`

## 用途

暴露网格在 CPU 侧已保留的几何体，同时不暴露内部字段或 GPU 资源。每次调用都返回独立的类型化数组副本，因此调用方可以检查或修改结果，而不会影响网格上的拾取、设备丢失恢复或未来的几何体更新。

## 公共 API 接口

```ts
export function getMeshGeometry(mesh: Mesh): {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    uvs?: Float32Array;
    uvs2?: Float32Array;
    tangents?: Float32Array;
    colors?: Float32Array;
} | null;
```

位置、法线和索引是必需的几何体数据。当其中任意一项未在 CPU 上保留时，函数返回 `null`。仅当网格已经保留了 UV、UV2、切线和颜色数组时，才会包含它们。零长度的切线源会被视为缺失，与省略切线的工厂几何体行为一致。该辅助函数不会促使加载器或工厂保留额外数据。

在显式调用 `setMeshDrawRange` 之后，这些副本仅包含所选的顶点窗口和索引范围，且索引相对于该窗口。未激活的已初始化源数据和预留 GPU 容量不会被暴露。完整的几何体更新会清除该选择。请参阅 [exact active draw ranges](46-mesh-geometry-update.md#精确有效绘制范围可选启用)。

## 内部架构

该辅助函数一次性读取网格的内部 CPU 数组，并使用类型化数组的 `slice()` 复制每个可用数组。它绝不返回内部数组引用。读取交错 glTF 网格时可能会调用其现有的惰性 CPU 访问器，该访问器会解交错（de-stride）并缓存一个紧凑的内部数组；但该辅助函数仍会返回第二份由调用方拥有的副本。

除了在编译期会被擦除的 `Mesh` 类型导入外，该模块没有任何运行时导入，也没有模块级状态或副作用。未导入 `getMeshGeometry` 的消费者不会保留该模块的任何代码。

## 管线配置

无。该辅助函数不访问或修改 GPU 缓冲区、bind group、管线、绘制状态、包围盒或材质。

## 着色器逻辑

无。

## 状态机 / 生命周期

1. 加载器或工厂创建一个网格，并保留现有引擎特性所需的任何 CPU 几何体。
2. `getMeshGeometry(mesh)` 检查所需的保留数组。
3. 如果所需数据不可用，则返回 `null`。
4. 否则返回必需数组及所有存在的可选属性的副本；零长度切线会被省略。
5. 调用方可以修改这些副本或将其传递给其他 API，而不会更改源网格。

## Babylon.js 等价映射

用途上等价于通过 Babylon.js 网格顶点数据访问器读取位置、法线、UV 集、切线、颜色和索引，同时以单个可 tree-shaking 的 Lite 辅助函数形式提供。

## 依赖项

- `Mesh`：用于保留的 CPU 几何体。

## 测试规范

- 返回完整保留几何体的精确副本。
- 验证没有任何返回的类型化数组与其内部源产生别名共享。
- 对于不可用的可选属性返回 `undefined`。
- 对于未传入切线数组或传入零长度数组的工厂网格，保留省略切线的语义。
- 当任何必需数组不可用时返回 `null`。
- 测试交错 glTF 网格所使用的惰性 getter 支持数组。

## 文件清单

- `packages/babylon-lite/src/mesh/get-mesh-geometry.ts`：实现。
- `packages/babylon-lite/src/index.ts`：公共导出。
- `tests/lite/unit/get-mesh-geometry.test.ts`：单元测试覆盖。
