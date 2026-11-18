# 模块：音频引擎（Audio Engine）

> 包路径：`packages/babylon-lite/src/audio/`

> **状态：已实现。**
> 本模块是对 Babylon.js AudioV2 引擎（`packages/dev/core/src/AudioV2/`）忠实的**行为级**移植，并按 Babylon Lite 的惯用法重新设计架构：纯状态接口 + 独立函数、零模块级副作用、单一 Web Audio 后端（无抽象/具体层拆分），以及按需启用的特性模块。**Web Audio API 节点图、参数渐变数学与空间声像（spatial panner）数学保持 1:1 完全一致**——变化的只有代码**形态**，而非听觉行为。
>
> 已交付模块与下方最初的一次性设计在少数几处存在差异（最显著的是：特性子节点由**显式的 `enable*`/`set*` 函数**启用，而非依赖选项字段是否存在；且文件布局是**扁平**而非嵌套的）。**权威 API 以 `packages/babylon-lite/src/audio/` 及汇总导出文件 `audio/index.ts` 中导出的 TSDoc 为准**；下方的“实际实现 API 与差异说明”一节记录了相对于本设计文档的变更。

---

## 用途

音频模块封装浏览器的 **Web Audio API**，提供声音播放、混音/路由（总线）、3D 空间音频、立体声声像（stereo panning）、FFT 分析、麦克风采集以及可选的取消静音 UI。它与 WebGPU 渲染栈完全解耦：**不依赖 GPU、场景图或渲染循环**。空间音频可按需读取 Lite `Mesh`/变换的世界位置以使声音跟随对象移动，但音频模块绝不会持有对场景的引用（支柱 4b —— 单向数据所有权）。

本模块是 **100% 按需启用且可 Tree-shake** 的。不从 `audio/` 导入任何内容的场景付出零字节成本。空间音频、流式音频、立体声、分析器、麦克风以及取消静音 UI 各自都是独立的可分离特性模块，仅在调用对应工厂或选项时才会被拉入。

---

## 设计映射：AudioV2 → Lite

| AudioV2 (Babylon.js)                              | Babylon Lite                                         |
| ------------------------------------------------- | ---------------------------------------------------- |
| `abstract AudioEngineV2` + `_WebAudioEngine`      | 单一 `AudioEngine` 状态接口 + 函数                   |
| `abstract AbstractSound` + `_WebAudioStaticSound` | 单一 `StaticSound` 状态接口 + 函数                   |
| 29 个抽象类 + 21 个 `_WebAudio*` 具体类           | 扁平的纯状态接口集合；无继承                         |
| 类方法（`sound.play()`）                          | 独立函数（`playSound(sound)`）                       |
| `new Observable()` 事件字段                       | 状态上的轻量回调集合（`AudioSignal<T>`）             |
| 模块级 `Instances[]`、`OnCreatedObservable`       | **已移除** —— 由调用方持有 `AudioEngine` 句柄        |
| 模块级 `new RegExp`、缓存的 `ExpCurve`            | 函数内懒初始化（无模块副作用）                       |
| `WebRequest.FetchAsync` + 自定义请求头            | 原生 `fetch()`（与 Lite 其他加载器一致）             |
| 来自 core Maths 的 `Vector3`/`Quaternion`         | Lite `math/` 中的 vec3/quat                          |
| `Logger.Warn`                                     | `console.warn`                                       |
| `EngineStore.LastCreatedEngine`（取消静音 UI）    | 显式 `parentElement` 选项                            |
| `PrecisionDate.Now`                               | `performance.now()`                                  |
| `Node` / `AbstractMesh`（空间挂接）               | Lite `Mesh` / `{ worldMatrix }` 变换                 |

### 为什么要合并抽象层

AudioV2 的抽象/具体拆分是为了让 Babylon 能够切换不同的音频后端。Babylon Lite 只面向唯一可能存在的后端（Web Audio），因此这层间接性纯属多余开销，且违背支柱 2 与支柱 4b′。我们只保留一套实现。Web Audio 图的构建忠实沿用原有逻辑，而类脚手架则不再保留。

---

## 公共 API 接口

> **原始设计草图。** 下方代码块为实现前的 API 设计，保留作背景参考；如与实际代码存在出入，以实际代码为准。具体修正请紧接参考其后的**“实际实现 API 与差异说明”**一节。

所有公共类型均为**纯状态**（无方法）。行为均位于函数中。

```typescript
// ─── Engine ──────────────────────────────────────────────────────────
export interface AudioEngineOptions {
    /** Provide an existing context. Pass an `OfflineAudioContext` for deterministic,
     *  headless, faster-than-real-time rendering to PCM (Tier-2/3 tests, parity).
     *  Default: new AudioContext(). */
    audioContext?: BaseAudioContext;
    /** Ramp smoothing for all parameter changes, in seconds. Default 0.01 (10 ms). */
    parameterRampDuration?: number;
    /** Initial master output volume. Default 1. */
    volume?: number;
    /** Resume the context on the first user gesture (click). Default true. */
    resumeOnInteraction?: boolean;
    /** Periodically retry resume() while suspended/interrupted. Default true. */
    resumeOnPause?: boolean;
    /** Retry period for resumeOnPause, in ms. Default 1000. */
    resumeOnPauseRetryInterval?: number;
    /** Spatial listener defaults (position/orientation). */
    listener?: Partial<SpatialListenerOptions>;
}

export type AudioEngineState = "closed" | "interrupted" | "running" | "suspended";

/** Handle to the audio engine. Pure state. GPU-style internals are @internal. */
export interface AudioEngine {
    readonly state: AudioEngineState;
    /** Fires on every state transition. */
    readonly onStateChanged: AudioSignal<AudioEngineState>;
    /** @internal */ readonly _ctx: BaseAudioContext;
    /** @internal */ readonly _mainOut: GainNode;
    /** @internal */ readonly _mainBus: MainBus;
    /** @internal */ readonly _listener: SpatialListener | null;
    /** @internal */ _rampDuration: number;
    /** @internal */ readonly _disposers: Array<() => void>;
}

export function createAudioEngineAsync(options?: AudioEngineOptions): Promise<AudioEngine>;
export function disposeAudioEngine(engine: AudioEngine): void;
/** Resume a suspended/interrupted context (e.g. from a user-gesture handler). */
export function unlockAudioEngineAsync(engine: AudioEngine): Promise<void>;
export function setMasterVolume(engine: AudioEngine, value: number, options?: RampOptions): void;

// ─── Sounds (static) ─────────────────────────────────────────────────
export type SoundSource = string | string[] | ArrayBuffer | AudioBuffer | SoundBuffer;

export interface StaticSoundOptions {
    autoplay?: boolean; // default false
    loop?: boolean; // default false
    startOffset?: number; // seconds, default 0
    maxInstances?: number; // default Infinity
    volume?: number; // default 1
    outBus?: AudioBus | MainBus; // default engine main bus
    // feature opt-ins (presence triggers the sub-node):
    spatial?: Partial<SpatialSoundOptions>;
    stereo?: { pan: number };
    analyzer?: { fftSize: number };
}

export interface StaticSound {
    readonly name: string;
    readonly state: SoundState;
    loop: boolean;
    startOffset: number;
    maxInstances: number;
    readonly onEnded: AudioSignal<StaticSound>;
    /** @internal */ readonly _engine: AudioEngine;
    /** @internal */ readonly _buffer: AudioBuffer;
    /** @internal */ readonly _graph: SoundSubGraph;
    /** @internal */ readonly _instances: Set<StaticSoundInstance>;
    /** @internal */ readonly _options: StaticSoundOptions;
}

export function createSoundAsync(engine: AudioEngine, source: SoundSource, options?: StaticSoundOptions): Promise<StaticSound>;
export function createSoundBufferAsync(engine: AudioEngine, source: SoundSource): Promise<SoundBuffer>;
export function playSound(sound: StaticSound, options?: PlaySoundOptions): void;
export function pauseSound(sound: StaticSound): void;
export function resumeSound(sound: StaticSound, options?: PlaySoundOptions): void;
export function stopSound(sound: StaticSound): void;
export function disposeSound(sound: StaticSound): void;

// ─── Streaming sounds (HTMLAudioElement path) ───────────────────────
export interface StreamingSoundOptions extends Omit<StaticSoundOptions, "maxInstances"> {
    preloadCount?: number; // default 1
}
export interface StreamingSound {
    /* mirrors StaticSound, no loopStart/pitch/playbackRate */
}
export function createStreamingSoundAsync(engine: AudioEngine, source: string | string[] | HTMLAudioElement, options?: StreamingSoundOptions): Promise<StreamingSound>;
export function preloadStreamingInstanceAsync(sound: StreamingSound): Promise<void>;
// play/pause/resume/stop/dispose share the StaticSound functions via a common SoundLike union.

// ─── Buses (routing / mixing) ───────────────────────────────────────
export interface AudioBusOptions {
    volume?: number;
    outBus?: AudioBus | MainBus;
    spatial?: Partial<SpatialSoundOptions>;
    stereo?: { pan: number };
}
export interface AudioBus {
    readonly name: string;
    /** @internal */ _graph: SoundSubGraph;
    /** @internal */ _in: GainNode;
}
export interface MainBus {
    readonly name: string;
    /** @internal */ _gain: GainNode;
}
export function createAudioBusAsync(engine: AudioEngine, name: string, options?: AudioBusOptions): Promise<AudioBus>;
export function createMainBusAsync(engine: AudioEngine, name: string, options?: { volume?: number }): Promise<MainBus>;
export function setBusVolume(bus: AudioBus | MainBus, value: number, options?: RampOptions): void;

// ─── Spatial (3D) ───────────────────────────────────────────────────
export interface SpatialSoundOptions {
    position: Vec3;
    orientation: Vec3;
    rotationQuaternion?: Quat;
    panningEnabled: boolean; // default true
    panningModel: "equalpower" | "HRTF"; // default "equalpower"
    distanceModel: "linear" | "inverse" | "exponential"; // default "inverse"
    minDistance: number;
    maxDistance: number;
    rolloffFactor: number;
    coneInnerAngle: number;
    coneOuterAngle: number;
    coneOuterVolume: number;
    /** Follow a Lite mesh/transform's world position (and optionally rotation). */
    attachedTo?: SpatialTarget;
    attachmentType?: "position" | "rotation" | "positionAndRotation";
    useBoundingBox?: boolean;
}
export interface SpatialListenerOptions {
    position: Vec3;
    orientation: Vec3;
    rotationQuaternion?: Quat;
    attachedTo?: SpatialTarget;
}
/** Anything exposing a world transform — typically a Lite Mesh or camera. */
export interface SpatialTarget {
    readonly worldMatrix: Mat4;
    readonly onDispose?: AudioSignal<unknown>;
}
export function setSpatialPosition(sound: StaticSound | AudioBus, p: Vec3): void;
export function attachSpatialTarget(soundOrListener: StaticSound | AudioBus | AudioEngine, target: SpatialTarget, type?: SpatialSoundOptions["attachmentType"]): void;
export function detachSpatialTarget(soundOrListener: StaticSound | AudioBus | AudioEngine): void;
/** Pump per-frame spatial updates. Call from your render loop OR enable auto-RAF. */
export function updateSpatialAudio(engine: AudioEngine): void;
export function setSpatialAutoUpdate(engine: AudioEngine, enabled: boolean, minUpdateMs?: number): void;

// ─── Analyzer ───────────────────────────────────────────────────────
export interface AudioAnalyzer {
    /** @internal */ _node: AnalyserNode;
}
export function getByteFrequencyData(sound: StaticSound | AudioBus, out: Uint8Array): void;
export function getFloatFrequencyData(sound: StaticSound | AudioBus, out: Float32Array): void;

// ─── Microphone source ──────────────────────────────────────────────
export interface MicrophoneSound {
    readonly name: string;
    /** @internal */ _stream: MediaStream;
}
export function createMicrophoneSoundSourceAsync(engine: AudioEngine, name: string, options?: { outBus?: AudioBus | MainBus }): Promise<MicrophoneSound>;

// ─── Unmute UI ──────────────────────────────────────────────────────
export interface UnmuteUiOptions {
    parentElement?: HTMLElement;
}
export function createUnmuteUi(engine: AudioEngine, options?: UnmuteUiOptions): { dispose(): void };

// ─── Parameter ramps ────────────────────────────────────────────────
export type AudioRampShape = "none" | "linear" | "exponential" | "logarithmic";
export interface RampOptions {
    shape?: AudioRampShape;
    duration?: number;
}

// ─── Shared signal (replaces core Observable) ───────────────────────
export interface AudioSignal<T> {
    add(cb: (v: T) => void): () => void;
    addOnce(cb: (v: T) => void): () => void;
}

// ─── Enums (re-exported, identical semantics) ───────────────────────
export const enum SoundState {
    Stopped,
    Starting,
    Started,
    Stopping,
    Paused,
    FailedToStart,
}
```

---

## 实际实现 API 与差异说明

最终交付的接口由汇总文件 `audio/index.ts` 导出。它在理念上与上述设计一致，具体差异如下：

**特性启用是显式的，而非依赖选项字段存在。** `StaticSoundOptions`、`StreamingSoundOptions` 或 `AudioBusOptions` 上没有 `spatial?`/`stereo?`/`analyzer?` 字段。相反，每个特性都通过宿主对象（`AudioGraphHost = StaticSound | StreamingSound | AudioBus | AudioInputSource`）上的独立函数开启，这些函数会按需懒构建/重建子图：

```typescript
// Stereo
export function enableStereo(host: AudioGraphHost, options?: StereoSoundOptions): void;
export function setStereoPan(host: AudioGraphHost, pan: number, options?: RampOptions): void;

// Spatial (3D)
export function enableSpatial(host: AudioGraphHost, options?: SpatialSoundOptions): void;
export function setSpatialPosition(host: AudioGraphHost, position: Vec3): void;
export function setSpatialOrientation(host: AudioGraphHost, orientation: Vec3): void;
export function attachSpatialTarget(target: AudioGraphHost | AudioEngine, worldTarget: SpatialTarget, type?: SpatialAttachmentType): void;
export function detachSpatialTarget(target: AudioGraphHost | AudioEngine): void;
export function setSpatialListener(engine: AudioEngine, options?: SpatialListenerOptions): void;
export function setSpatialListenerPosition(engine: AudioEngine, position: Vec3): void;
export function updateSpatialAudio(engine: AudioEngine): void;
export function setSpatialAutoUpdate(engine: AudioEngine, enabled: boolean, minUpdateMs?: number): void;

// Analyzer — frequency AND time-domain readback
export function enableAnalyzer(host: AudioGraphHost, options?: AudioAnalyzerOptions): void;
export function getByteFrequencyData(host: AudioGraphHost, out: Uint8Array): void;
export function getFloatFrequencyData(host: AudioGraphHost, out: Float32Array): void;
export function getByteTimeDomainData(host: AudioGraphHost, out: Uint8Array): void;
export function getFloatTimeDomainData(host: AudioGraphHost, out: Float32Array): void;
```

其他差异：

- **单声音量辅助函数。** 实际提供了 `setSoundVolume(sound, value, options?)` 与 `setStreamingSoundVolume(...)`（设计草图仅列出了主音量/总线音量）。
- **总线。** `MainBus` 由引擎创建并持有；**不存在公共的 `createMainBusAsync`**。`disposeAudioBus(bus)` 为公共函数。`PrimaryAudioBus` 是用于 `outBus`/空间/立体声宿主的公共联合类型（`AudioBus | MainBus`）。
- **音源与麦克风。** 通用输入音源通过 `createSoundSourceAsync(engine, node, options?)`、`createMicrophoneSoundSourceAsync(engine, options?)`、`setSoundSourceVolume(...)` 和 `disposeSoundSource(...)` 暴露，返回 `AudioInputSource` 句柄（设计中的 `MicrophoneSound` 已并入该类型）。
- **取消静音 UI。** `createUnmuteUI(engine, { parentElement? })` 外加 `setUnmuteUIEnabled(ui, enabled)` 与 `disposeUnmuteUI(ui)`（大写的 `UI`，且返回比 `{ dispose() }` 更丰富的句柄）。
- **媒体流输出（Lite 独有）。** 最终经主总线混合后的输出可以镜像接入浏览器媒体管线，而不影响扬声器输出：

  ```typescript
  export interface AudioEngineMediaStream {
      readonly stream: MediaStream;
      /** @internal */ readonly _engine: AudioEngine;
      /** @internal */ readonly _source: GainNode;
      /** @internal */ readonly _destination: MediaStreamAudioDestinationNode;
      /** @internal */ readonly _engineDisposer: () => void;
      /** @internal */ _registered: boolean;
      /** @internal */ _disposed: boolean;
      /** @internal */ _dispose(): void;
  }

  export function createAudioEngineMediaStream(engine: AudioEngine): AudioEngineMediaStream;
  export function disposeAudioEngineMediaStream(output: AudioEngineMediaStream): void;
  ```

  创建时需要实时 `AudioContext`，将 `MediaStreamAudioDestinationNode` 与可听目标节点并联，并注册幂等的引擎级清理回调。释放时仅断开该分路、停止其流中的所有音轨并注销引擎清理闭包，使反复录制会话不会累积残留句柄。
- **可视化器（Lite 独有，无 AudioV2 对应物）。** 为演示和手动使用提供了一个轻量的 Canvas 2D 波形/柱状图辅助工具：`createAudioVisualizer(host, canvas, options?)`、`renderAudioVisualizerFrame(viz)`、`startAudioVisualizer(viz)`、`stopAudioVisualizer(viz)`、`disposeAudioVisualizer(viz)`。记录为有意为之的适配（运行时可视化器属于展示胶水代码，而非听觉行为移植）。
- **空间默认值与 AudioV2 `_SpatialAudioDefaults` 一致** —— 注意 `distanceModel` 的默认值是 **`"linear"`**（设计草图中的注释曾误写为 `"inverse"`）。
- **流式音频**同时暴露 `preloadStreamingInstanceAsync` 和 `preloadStreamingInstancesAsync`，以及专用的 `play/pause/resume/stop/disposeStreamingSound` 函数（未与静态音频函数合并）。
- **`createSoundBufferAsync(engine, source, options?)`** 以及 `SoundBuffer` / `SoundSource` / `SoundBufferOptions` 类型均为公共导出。

其余部分（引擎生命周期、渐变、`AudioSignal`、`SoundState`、纯状态接口、单向空间数据所有权）均与原设计一致。

### 声音子图（信号流）

忠实复现 `_WebAudioBusAndSoundSubGraph`。每个声音/总线都拥有一个 `SoundSubGraph`——一条按需懒构建的 Web Audio 节点链。只有请求对应特性时才会创建对应节点：

```
source/instance ─▶ [root Gain (only if spatial+stereo both present)]
                      ├─▶ Spatial (PannerNode [+ attenuation GainNode])
                      └─▶ Stereo  (StereoPannerNode)
                            ▼
                          Volume (GainNode)            ← always present
                            ▼
                          [Analyzer (AnalyserNode)]    ← only if fftSize given
                            ▼
                          out → outBus.in → … → mainBus → mainOut → ctx.destination
```

`SoundSubGraph` 为纯状态：

```typescript
interface SoundSubGraph {
    readonly _ctx: BaseAudioContext;
    _volume: GainNode; // always
    _stereo: StereoPannerNode | null;
    _spatial: SpatialSubNode | null;
    _analyzer: AnalyserNode | null;
    _root: GainNode | null; // only when spatial+stereo coexist
    _in: AudioNode; // current head of chain (where instances connect)
    _out: AudioNode; // tail (volume or analyzer)
}
```

当添加或移除特性节点时，`rebuildSubGraph(graph)` 会重新连接节点（对应 `_onSubNodesChanged`）。添加特性是扩展节点图的**唯一**方式——核心声音代码中没有任何硬编码的 `if (spatial)`；每个特性模块都暴露一个由选项解析器调用的 `ensureXSubNode(graph, opts)`（应用于音频子节点的支柱 4c′ 扩展模式）。

### 参数渐变组件

`audio-param.ts` —— 纯净、无副作用。`applyRamp(param, ctx, value, shape, duration, rampDuration)`：

- `"none"`：`param.value = value`。
- `"linear"`：`param.setValueCurveAtTime([from, to], ctx.currentTime, duration)`。
- `"exponential"` / `"logarithmic"`：通过 `getRampCurve(shape, from, to)` 构建 100 点曲线并调用 `param.setValueCurveAtTime(curve, …)`。低于 `MIN_RAMP_DURATION = 1e-6` 秒时回退到 `setValueAtTime`。
- 在调度之前总是先调用 `param.cancelScheduledValues(0)`。

指数/对数归一化曲线通过**懒初始化**缓存（`let expCurve: Float32Array | null = null; function getExpCurve() {…}`）——绝不在模块作用域创建。数学公式逐字抄自 `audioUtils.ts`（`Math.exp(-11.512925464970227 * (1 - x))`、`1 + Math.log10(x)/Math.log10(100)`）。

### 声音实例

每次调用 `playSound`，`StaticSound` 都会生成一个 `StaticSoundInstance`，各自包装一个新的 `AudioBufferSourceNode`（`start(when, offset)` / `stop(when)`），并遵循 `loop`、`loopStart`/`loopEnd`、`startOffset`、音高（音分 → `detune`）和 `playbackRate`。`maxInstances` 会裁掉最早开始的实例。暂停会记录已播放时间并停止源节点；恢复时在记录的偏移位置创建新的源节点。流式实例包装一个 `HTMLAudioElement` + `MediaElementAudioSourceNode`，并支持 `preloadCount` 个预加载前瞻实例。

---

## 状态机 / 生命周期

### 引擎

```
createAudioEngineAsync
  → new AudioContext (or use provided)
  → build mainOut GainNode → ctx.destination
  → build default MainBus → mainOut
  → build SpatialListener (lazy; only if spatial used)
  → wire "statechange" listener → onStateChanged signal
  → if resumeOnInteraction: document.addEventListener("click", resumeOnce)   [disposer registered]
  → if resumeOnPause: setInterval(retryResume, interval) while !running       [disposer registered]
disposeAudioEngine
  → run every fn in engine._disposers (removes listeners, clears interval/RAF)
  → close ctx unless it was provided/offline

createAudioEngineMediaStream
  → require a real-time AudioContext
  → create MediaStreamAudioDestinationNode
  → connect mainOut GainNode → media-stream destination (speaker path remains connected)
  → register idempotent tap disposal in engine._disposers
disposeAudioEngineMediaStream
  → disconnect only the media-stream destination
  → stop every MediaStreamTrack owned by the tap
```

所有全局钩子（`document` 点击监听器、`setInterval`、空间 `requestAnimationFrame`）都注册在 `engine._disposers` 中，从而保证释放无泄漏。**模块加载时不注册任何东西**——一切均由引擎句柄持有。

### 声音

`Stopped → Starting → Started → (Stopping) → Stopped`，并带有 `Paused` 和 `FailedToStart` 分支——与 `soundState.ts` 完全相同。当最后一个实例结束时（非循环完整播放或显式停止）触发 `onEnded`。

---

## Babylon.js 对照表

| Lite 函数/类型                     | AudioV2 来源                                                 |
| ---------------------------------- | ------------------------------------------------------------ |
| `createAudioEngineAsync`           | `CreateAudioEngineAsync` + `_WebAudioEngine` 构造/初始化     |
| `AudioEngine.state`                | `AudioEngineV2.state`（映射 `ctx.state`）                    |
| `unlockAudioEngineAsync`           | `_WebAudioEngine.unlockAsync` / `resumeAsync`                |
| `createSoundAsync`                 | `CreateSoundAsync` + `_WebAudioStaticSound._initAsync`       |
| `createSoundBufferAsync`           | `CreateSoundBufferAsync`（`decodeAudioData`）                |
| `playSound`/`stopSound`/…          | `AbstractSound.play/stop/pause/resume`                       |
| `SoundSubGraph` + 重建             | `_WebAudioBusAndSoundSubGraph` + `_onSubNodesChanged`        |
| `applyRamp` / `getRampCurve`       | `_WebAudioParameterComponent` + `_GetAudioParamCurveValues`  |
| `SpatialSubNode` / 声像器          | `_SpatialWebAudioSubNode`（`PannerNode` 配置）               |
| `SpatialListener`                  | `_SpatialWebAudioListener(+Fallback)`                        |
| `attachSpatialTarget`              | `_SpatialAudioAttacherComponent.attach`                      |
| `updateSpatialAudio` / RAF         | `_WebAudioUpdaterComponent` / `_SpatialWebAudioUpdaterComponent` |
| `createStreamingSoundAsync`        | `CreateStreamingSoundAsync` + `_WebAudioStreamingSound`      |
| `createMicrophoneSoundSourceAsync` | `_WebAudioSoundSource`（`getUserMedia`）                     |
| `createUnmuteUi`                   | `_WebAudioUnmuteUI`（注入 `parentElement`，无 `EngineStore`）|
| `createAudioEngineMediaStream`     | Lite 独有 `MediaStreamAudioDestinationNode` 主总线后分路     |

行为（节点类型、参数映射、渐变曲线、声像器/听者数学）完全一致。变化的只有所有权、副作用时机和调用语法。

---

## 依赖项

- **Web Audio API**（`AudioContext`、`GainNode`、`PannerNode`、`StereoPannerNode`、`AnalyserNode`、`AudioBufferSourceNode`、`MediaElementAudioSourceNode`、`MediaStreamAudioSourceNode`、`MediaStreamAudioDestinationNode`）。
- **Lite `math/`** —— `Vec3`、`Quat`、`Mat4`（仅空间音频需要；静态/流式/总线不拉入任何数学库）。
- **`fetch()`** —— 与 Lite 所有其他加载器一致的原生模式（无 `WebRequest`）。
- 不依赖 GPU、场景或渲染循环。

---

## Tree-Shaking / 打包策略

- `audio/index.ts` 仅重新导出无副作用模块；导入时不执行任何逻辑。
- 特性模块（`spatial/`、`streaming/`、`analyzer/`、`microphone/`、`media-stream-output/`、`unmute-ui/`）仅通过各自的工厂函数可达，因此只使用 `createSoundAsync` + `playSound` 的应用会丢弃其余全部模块。
- 子节点的 `ensureXSubNode` 注册通过选项解析器接线，而非全局注册表——未使用的子节点会被消除。
- 所有缓存（渐变曲线、文件扩展名正则）均采用懒初始化。**禁止在模块级执行 `new Map`/`Set`/`Observable`/`RegExp`。**

---

## 测试规范

音频不产生**任何像素**，因此 Playwright 截图/MAD 一致性框架**无法**直接套用。取而代之的是**四层分级测试**。第 1 层（Mock Web Audio）是始终运行的确定性 CI 门禁；第 2–3 层通过**真实的** `OfflineAudioContext` 渲染并采用**按需运行**模式（见下文）；第 4 层为手动展示。核心基石是 **`OfflineAudioContext`**：整个 Web Audio 图可以以超实时速度、**无需用户手势且无需扬声器**地渲染成可复现的 `AudioBuffer`。这使我们能够直接对**实际渲染出的 PCM 采样**做断言——这是比任何截图都更强的保障——并且还可以选择将该 PCM 绘制到画布上以构成确定性的**视觉**门禁。

> **实际实现（第 2–3 层后端）。** 这些测试并不在浏览器中运行；它们在 vitest 中无头运行于原生 **`node-web-audio-api`** 包之上——这是一个提供真实 `OfflineAudioContext` 和 Web Audio 节点构造函数的**纯开发依赖**。测试套件在渲染期间将这些类安装为全局对象，并将离线上下文传递给 `createAudioEngineAsync({ audioContext })`。由于某些平台上可能缺少原生预编译二进制文件，**每条第 2/3 层用例都会通过 `describe.skipIf(!realWebAudioAvailable)` 自动跳过**，确保安装或 CI 绝不会硬性失败。这两层位于各自独立的按需 vitest 项目 `audio-offline`（`pnpm test:audio-offline`）中，与 `unit` 项目分离。
>
> `createAudioEngineAsync` 的 `audioContext` 选项接收 `BaseAudioContext`，因此传入 `OfflineAudioContext` 是受支持的离线渲染入口。引擎会检测离线上下文并跳过其上的 `close()`/手势解锁路径（对应 AudioV2 的 `_isUsingOfflineAudioContext`）。

### 第 1 层 —— 单元测试 / 行为测试（Mock Web Audio API），确定性 —— 始终启用的 CI 门禁

**实际位置：** `tests/lite/unit/audio/*.test.ts`（Mock Web Audio，运行于 `unit` vitest 项目；无原生依赖）。

1. **图连接拓扑** —— 断言每种特性组合（仅音量；+立体声；+空间；+空间+立体声带根增益节点；+分析器）的 `connect()` 拓扑正确，并验证增删特性后的重建。
2. **渐变** —— 断言 `setValueCurveAtTime` 被调用时传入精确的 2 点线性数组与 100 点指数/对数曲线（按逐字 BJS 数学对曲线值做快照校验）；断言此前先调用了 `cancelScheduledValues(0)`。
3. **生命周期** —— 状态转换；最后一个实例结束时 `onEnded` 触发一次；`maxInstances` 裁掉最旧实例；暂停/恢复偏移量正确性。
4. **空间接线** —— 从伪造的 `SpatialTarget.worldMatrix` 设置声像器的 `positionX/Y/Z`、`orientationX/Y/Z`、距离/圆锥参数；听者 9 参数路径 + 旧版 `setPosition`/`setOrientation` 回退；`updateSpatialAudio` 节流。
5. **无副作用** —— 导入 `audio/` 下每一个模块并断言导入时没有全局状态修改、没有 `document`/`setInterval`/`new AudioContext` 调用（守护零副作用支柱）。
6. **释放** —— `disposeAudioEngine` 移除点击监听器、清除重试定时器/RAF、停止已注册的媒体流输出音轨，并仅关闭由自己创建的上下文。`disposeAudioEngineMediaStream` 仅断开自身分路、停止其音轨，且具备幂等性。

### 第 2 层 —— 输出正确性（`OfflineAudioContext` → PCM），按需运行（原生）★ 主要正确性层级

通过真实的（离线）Web Audio 图渲染真实声音，并对返回的采样做断言。这验证的是实际可听行为，而不仅仅是节点连接。**实际位置：** `tests/lite/audio/offline/*.test.ts`（15 项测试）。

7. **播放** —— 渲染已知缓冲区（440 Hz 正弦波）并断言峰值/RMS、按窗口静音以及总时长。循环播放会渲染出预期重复次数；`startOffset` 会推移首个非零采样位置。
8. **音量 / 渐变** —— 渲染声音音量渐变并断言 PCM 包络遵循线性淡入/淡出（跨窗口单调变化）。
9. **立体声** —— 断言左/右声道能量比与声像值匹配（在默认声像渐变稳定后测量）。
10. **空间音频** —— 渲染声源偏左/偏右时的声音并断言声道间电平差异，以及线性距离衰减模型的衰减（远距离声源显著弱于近距离声源）。
11. **总线路由** —— 经由总线链的衰减与直接输出之间的预期比例一致。

### 第 3 层 —— 视觉一致性（离线 PCM → 波形画布），按需运行（原生）

12. 将第 2 层渲染出的 PCM 绘制成图像（确定性波形栅格图）并与已提交的基准图比对。由于离线渲染完全可复现，图像也是确定性的——这就是“看见波形”的门禁。**实际位置：** `tests/lite/audio/visual/waveform-golden.test.ts` 通过一个依赖轻量的 **pngjs** 栅格化器（`_shared/waveform-png.ts`）进行渲染——用于替代 DOM Canvas，因为 Node 在没有额外原生依赖的情况下不提供 DOM Canvas。波形条带绘制得**较粗**且对比采用**位置容错**（只要 2 px 半径内存在容差范围内的基准像素即视为匹配），因此跨平台细微的亚像素包络偏移不会导致门禁抖动；配套的 `golden-robustness.test.ts` 断言 2 px 偏移可通过而 12 px 偏移仍会被捕获。基准图位于 `reference/lite/audio/<case>.png`，仅在显式请求时重新生成（`UPDATE_AUDIO_GOLDENS=1`）。

### 第 4 层 —— 实时演示可视化器，非门禁

13. 交互式演示使用实时 `AnalyserNode` 绘制波形 + 频谱柱状可视化图。它需要用户手势来解锁上下文且具有非确定性，因此**仅作手动展示**——绝不作为 CI 检查。

### 相对于 Babylon.js 的行为一致性（可选，确定性）

将同一段声音同时通过 BJS AudioV2 和 Lite 在 `OfflineAudioContext` 上渲染，然后比对 PCM。无需人耳即可实现真正的行为一致性验证。适用于移植过程中验证空间/渐变数学；不作为常驻 CI 门禁。

---

## 文件清单

实际布局采用**扁平**结构（无按特性划分的子目录）：

```
packages/babylon-lite/src/audio/
  index.ts                  # pure barrel
  audio-engine.ts           # createAudioEngineAsync, dispose, unlock, master volume, offline detect
  audio-signal.ts           # AudioSignal<T> (Observable replacement)
  audio-param.ts            # ramp shapes + curve math (lazy-init caches)
  audio-fetch.ts            # decode helpers over plain fetch()
  sound-buffer.ts           # createSoundBufferAsync (decodeAudioData) + SoundBuffer
  static-sound.ts           # StaticSound + instance lifecycle
  streaming-sound.ts        # StreamingSound (HTMLAudioElement path)
  sound-sub-graph.ts        # SoundSubGraph build/rebuild (core chain)
  bus.ts                    # MainBus (engine-owned)
  audio-bus.ts              # AudioBus (createAudioBusAsync / dispose)
  spatial.ts                # PannerNode + listener (+ legacy fallback) + attach/RAF updater
  stereo.ts                 # StereoPannerNode sub-node
  analyzer.ts               # AnalyserNode (frequency + time-domain readback)
  sound-source.ts           # createSoundSourceAsync / microphone (getUserMedia)
  media-stream-output.ts    # post-master MediaStream tap (recording / WebRTC)
  unmute-ui.ts              # DOM button (parentElement injected)
  visualizer.ts             # runtime canvas waveform/bars (demo + manual; Lite-only)
  host-types.ts             # AudioGraphHost union + shared sub-graph host plumbing
docs/lite/architecture/41-audio-engine.md      # this doc
tests/lite/unit/audio/*.test.ts                # Tier-1 vitest (mocked Web Audio; unit project)
tests/lite/audio/offline/*.test.ts             # Tier-2 vitest (real OfflineAudioContext → PCM; audio-offline project)
tests/lite/audio/visual/*.test.ts              # Tier-3 (offline PCM → pngjs waveform → golden diff)
tests/lite/audio/_shared/real-web-audio.ts     # node-web-audio-api harness (globals + renderOffline)
tests/lite/audio/_shared/waveform-png.ts       # pngjs rasterizer + position-tolerant golden compare
reference/lite/audio/<case>.png                # Tier-3 golden waveform images (flat)
lab/lite/...                                    # Tier-4 interactive showcase (real-time visualizer)
```

> 第 3 层栅格化器（`tests/lite/audio/_shared/waveform-png.ts`）是运行时画布 `visualizer.ts` 的**测试专用** pngjs 替代品；它存在的原因是 Node 没有 DOM Canvas。第 2/3 层在 vitest 中无头运行于原生 **`node-web-audio-api`** 开发依赖（真实 `OfflineAudioContext`）之上，并在预编译二进制不可用时**自动跳过**；第 4 层则使用屏幕上的运行时可视化器。
