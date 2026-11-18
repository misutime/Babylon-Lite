# 模块：动画曲线编辑

> 包内路径：`packages/babylon-lite/src/animation/animation-curve-editing.ts`

## 用途

检查和编辑驱动动画组的现有关键帧采样器，普通动画播放仍沿用原有代码和状态。模块无副作用，通过根入口各自独立导出的函数访问。

## 公共 API 接口

```ts
interface AnimationCurveKey {
    readonly time: number;
    readonly value: readonly number[];
    readonly inTangent?: readonly number[];
    readonly outTangent?: readonly number[];
}
interface AnimationCurveTrack {
    readonly target: TargetedAnimation;
    readonly interpolation: string;
    readonly componentCount: number;
    readonly quaternion: boolean;
    readonly keys: readonly AnimationCurveKey[];
}
function getAnimationGroupTracks(group: AnimationGroup): readonly AnimationCurveTrack[];
function setAnimationTrackKeys(group: AnimationGroup, trackIndex: number, keys: readonly AnimationCurveKey[]): void;
```

轨道顺序与 `group.targetedAnimations` 一致。读取函数返回的关键帧和分量数组都是独立快照。时间单位为秒，值和三次插值切线均采用采样器空间的分量，切线单位为每秒的值变化量。四元数采用 xyzw 顺序。属性轨道的缓动继续生效，编辑范围仅覆盖关键帧。

写入函数以原子方式替换采样器的关键帧，支持插入和删除，且至少需要一个关键帧。时间必须为有限的非负数，转换为 Float32 后必须严格递增，并位于剪辑的原始时间范围内。值和切线必须与原始分量数相同，各分量必须能表示为有限的 Float32 值。三次插值轨道的每个关键帧都需要入切线和出切线，其余轨道传入切线会报错。无效轨道索引、不支持的动画组、格式错误的采样器和无效关键帧都会抛出异常。

插值方式、绑定、目标、剪辑时长和动画组播放范围保持原样。编辑在下一次播放求值或显式跳转时生效。共享同一个采样器对象的动画组和通道都会看到改动。替换数组可避免改写其他采样器共用的 glTF 底层缓冲区。

## 内部架构

glTF 动画组通过内部 `_gltfMixer` 提供剪辑通道。按目标顺序解析通道的采样器索引，以输出长度除以关键帧数和三次插值倍率推导分量数，并从通道识别四元数。属性动画组使用 `_propertyMixer` 的运行时轨道，轨道直接持有采样器和步长。支持具有这两种表示之一的动画组，带有创作时起始时间混合器标记的 USD 动画组除外。

直接替换现有采样器的两个数组，使控制器和两个加权混合器仍可使用原有对象引用，剪辑和控制器也可复用。编辑器由根入口按需引入，独立于运行时播放模块。

## 管线配置与着色器逻辑

无。

## 状态机与生命周期

读取函数分配独立快照。写入函数先完成验证并构建两份完整的 Float32 数组，再赋值。暂停的动画组需显式跳转才会重新求值。骨骼及形变动画求值仍需要常规的引擎参数。此前烘焙的顶点动画纹理继续使用生成时的数据。

## Babylon.js 对照

这是 Lite 原生的采样器编辑器。glTF 平移、旋转、缩放、形变权重、指针通道和手动属性轨道的分量值与相应的运行时采样器一致。

## 依赖

仅依赖动画组和动画类型的类型导入，以及插值和路径的数值常量。

## 测试规范

覆盖替换后的属性动画及 glTF 运行时播放、共享剪辑及重叠的源缓冲区、三次插值切线、形变与指针通道的分量数、输入校验、不支持的动画组、关键帧插入和删除，以及快照隔离。打包测试比较普通动画使用方在导入但不调用编辑器时的打包结果，并确认显式调用的编辑器会保留在产物中。

## 文件清单

`animation-curve-editing.ts`、根入口 `index.ts` 的导出，以及专项单元和构建测试。
