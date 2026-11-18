# 模块：Antigravity Racer 演示

> 源码路径：`lab/lite/src/demos/antigravity-racer/`
> 入口：`lab/lite/src/demos/antigravity-racer.ts` + `lab/lite/demo-antigravity-racer.html`
> 参考：Babylon.js Playground 片段 **WVPVWL#0**（895 行）、节点材质 **01HFES#76**（赛道）和 **23KY8X#14**（尾迹）。

## 目的

以其原本的 60 Hz 调校**精确复现 Playground 的观感与手感**，同时保留移植版的现代特性：DOM 菜单/HUD、暂停遮罩、与 QWERTY/AZERTY 布局无关的键盘输入、游戏手柄支持以及显式资产错误提示。

本文档为正式规范。下文列出的每一项常量、公式和着色器清单均是实现必须满足的契约。

**仿真模型。** 原 Playground 将一次仿真步进绑定到一次渲染帧（`scene.beforeRender`）并硬编码了 60 Hz 常量。本移植保留了*精确的逐 tick 公式*，并通过固定 60 Hz 累加器（`FIXED_DT = 1/60`，每个渲染帧最多 `MAX_STEPS_PER_FRAME = 6` 步）驱动。在 60 Hz 下，移植版与原版逐 tick 完全一致；在其他刷新率下，物理运动在真实挂钟时间上保持一致，不再依赖刷新率。没有任何逐 tick 常量会被换算为“每秒”单位——之前移植版中的 `frameWeightToDt` 重缩放已被移除。

相机在固定步长**内部**更新（每次仿真 tick 更新一次相机），因为原版中它们的平滑常量也是逐 tick 物理量。

---

## 公共 API 接口（演示模块）

```ts
// game.ts
export function runAntigravityRacer(canvas: HTMLCanvasElement): Promise<void>;

// constants.ts — original data + original per-tick tuning (see "Constants" below)

// track.ts
export interface TrackFrame {
    pos: Vec3;
    dir: Vec3;
    up: Vec3;
    right: Vec3;
}
/** The session's ONE spline source: no GPU resource, renderers subscribe to it. */
export interface TrackData {
    readonly controlPoints: Vec3[];
    frames: TrackFrame[];
    curveRatios: number[];
    readonly boostRight: boolean[];
    readonly boostLeft: boolean[];
    rebuild(): void;
    onRebuild(cb: (frames: readonly TrackFrame[], curveRatios: readonly number[]) => void): () => void;
}
/** One scene's GPU track: the undeformed piece + the material pair that bends it. */
export interface TrackRender {
    readonly mesh: Mesh;
    readonly material: TrackMaterial;
    dispose(): void;
}
export function buildTrackFrames(points, ringCount?): { frames: TrackFrame[]; curveRatios: number[] };
export function computeTrackRatios(points, ringCount?): { length: number; lengthPerRow: number; ratios: number[] };
export function buildTrackPiece(): { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
export function frameLocalCoords(frame, worldPos): Vec3;
export function frameToWorld(frame, local): Vec3;
export function advanceSegment(frames, seg, worldPos): number;
export function createTrackSource(controlPoints?: readonly Vec3[]): TrackData;
export function computeTrackBoundsInto(frames, min, max): void;
export function buildTrackRender(engine, textures, shadowGenerator, track: TrackData): TrackRender;
export function addTrackToScene(scene, render: TrackRender): void;

// simulation.ts
export interface ShipControls {
    left: boolean;
    right: boolean;
    accelerate: boolean;
}
export interface ShipState {
    /* see "Ship state" */
}
export function createShipState(track, spawnSegment, lateral, index, isAI, playerSlot): ShipState;
export function tickShip(ship, ships, track, controls, simTime): void;
export function tickAllShips(ships, track, controlsForPlayer, simTime): void;
export function shipEmitterPoint(ship): Vec3;
export function shipSpeedRatio(ship): number;

// camera-rig.ts
export class ChaseCamera {
    constructor(scene, ship);
    cycleOffset(): void;
    tick(): void;
}
export class DemoCamera {
    constructor(scene, track, ships);
    tick(): void;
}

// trail.ts
export interface ShipTrail {
    readonly mesh: Mesh;
    push(pos: Vec3, intensity: number): void;
    dispose(): void;
}
export function createShipTrail(engine, startPos: Vec3): ShipTrail;

// world.ts — session-lifetime resources (built ONCE per page, never per mode)
export interface RenderWorld {
    readonly lights: readonly LightBase[];
    readonly sun: DirectionalLight;
    readonly shadowGenerator: ShadowGenerator;
    readonly track: TrackRender;
    readonly rocks: RockField;
    readonly terrain: Mesh;
    readonly baseCasters: readonly Mesh[];
}
export interface RacerWorlds {
    readonly track: TrackData;
    readonly primary: RenderWorld;
    secondary(): RenderWorld;
    readonly worlds: readonly RenderWorld[];
}
export function createRacerWorlds(engine, assets, controlPoints?): Promise<RacerWorlds>;
export function addWorldToScene(scene, world: RenderWorld): void;
export function setWorldCasters(world: RenderWorld, extra: readonly Mesh[]): void;
```

---

## 常量（全部采用原版逐 tick 单位）

| 名称 | 数值 | Playground 来源 |
| ---- | ---- | --------------- |
| `RING_COUNT` | `256` | `texHeight` |
| `MAX_SPEED` | `0.7` | `maxSpeed`（单位/tick） |
| `MAX_ACCEL` | `0.004` | `maxAccel`（单位/tick²） |
| `VELOCITY_DRAG` | `0.99` | `Ship.velocity *= 0.99`，每 tick 应用 |
| `WALL_HIT_DRAG` | `0.99` | 每次撞墙钳制时额外 `*= 0.99` |
| `BOOST_SPEED_KICK` | `0.3` | `Ship.velocity += 0.3` |
| `BOOST_DEBOUNCE_SEGMENTS` | `10` | `Math.abs(seg - LastBonusSegment) > 10` |
| `LAST_BONUS_SEGMENT_INIT` | `99999` | `LastBonusSegment: 99999` |
| `MAX_STEER_TILT` | `0.8` | `desiredRotx = ±0.8` |
| `MAX_YAW_RATE` | `0.05` | `desiredRotySpeed = ±0.05`（弧度/tick） |
| `UP_BLEND` | `0.1` | `Vector3.Lerp(Ship.up, n, 0.1)` |
| `YAW_BLEND` | `0.1` | `RotYSpeed += (desired - RotYSpeed) * 0.1` |
| `TILT_BLEND` | `0.1` | `rotation.z += (desiredRotx - rotation.z) * 0.1` |
| `INERTIA_SPEED_TERM` | `0.98` | `fakeInertiaFactor = 1 - speedRatio * 0.98` |
| `GRAVITY_NOISE_STRENGTH` | `0.1` | `gravityNoiseStrength` |
| `NOISE_TILT_GAIN` | `3` | `desiredRotx += noise.x * strength * 3` |
| `WOBBLE_Y_OFFSET` | `0.5` | `ShipTransform.position.y = ... + 0.5` |
| `TICK_TIME` | `0.0166` | `time += 0.0166`（噪声时钟，非 `FIXED_DT`） |
| `FIXED_DT` | `1/60` | 仅移植版使用的固定步长累加器 |
| `MAX_STEPS_PER_FRAME` | `6` | 仅移植版使用的卡顿保护上限 |
| `WALL_BASE_SLOPE` | `2.5` | `wallSlope = 2.5 + localY` |
| `FLOOR_DAMP` / `CEIL_DAMP` | `0.45` / `0.9` | `localToSegment.y *= (y < 0) ? 0.45 : 0.9` |
| `AI_AIM_LOOKAHEAD` | `6` | `segmentMatrices[(seg + 6) % 256]` |
| `AI_AVOID_LIMIT` | `6` | `GetFirstNextShip(shipIndex, 6)` |
| `AI_AVOID_TOLERANCE` | `0.1` | `avoidTolerance` |
| `TOTAL_SHIP_COUNT` | `8` | `initPlay(scene, 8, humanCount)` |
| `SPAWN_LATERAL` | `±1.5` 交替 | `(i & 1) ? 1.5 : -1.5` |
| 生成段索引 | `i` (0…7) | `segStart = i` |
| `SHIP_MODEL_YAW` | `Math.PI` | `_ShipTransform.rotation.y = Math.PI` |
| `TRAIL_EMITTER_LOCAL` | `(0.05, 0, 0.85)` | `heater` 局部偏移 |
| `CHASE_CAMERA_OFFSETS` | `(0,3,-5)`, `(0,2,-2.8)` | `CameraRels` |
| `CHASE_TARGET_LOCAL` | `(0, 0, 5)` | `TransformCoordinatesFromFloatsToRef(0,0,5, …)` |
| `CAMERA_FOV` | `0.8` | `fov += (0.8 - fov) * 0.01` → 恒定 0.8 |
| `DEMO_CAMERA_SHIP` | `5` | `Ships[5]` |
| `DEMO_CAMERA_LOOKAHEAD` | `20` | `(currentSegment + 20) % 256` |
| `DEMO_CAMERA_UP` | `2` | `moveUp` |
| `DEMO_CAMERA_MIN/RANGE` | `2` / `2` | `Math.random() * 2 + 2` |
| `EDITOR_CAMERA_FAR` | `1500` | `editorCamera.maxZ = 1500` |
| `TERRAIN_*` | 800 / 600 / 0…25 / -2.05 | 作为画面表现调整将原始范围翻倍 |
| `TERRAIN_UV_SCALE` | `12` | 随尺寸翻倍以保持纹理密度 |
| `SHADOW_MAP_SIZE` | `1024` | `new CascadedShadowGenerator(1024, light)` |
| `SHADOW_CASCADES` | `4` | BJS `CascadedShadowGenerator` 默认值 |
| `SHADOW_LAMBDA` | `1` | `shadowGenerator.lambda = 1` |
| `SHADOW_BIAS` | `0.001` | `shadowGenerator.bias = 0.001` |
| `SHADOW_MAX_Z` | `1500` | `shadowGenerator.shadowMaxZ = 1500` |

远程资产（运行时加载，绝不重新分发）：

```
HEIGHTMAP_URL = "https://playground.babylonjs.com/textures/heightMap.png"
GROUND_TEXTURE_URL = "https://playground.babylonjs.com/textures/ground.jpg"
```

拉取任一资产失败都必须使 `loadRacerAssets`/`createRacerWorlds` 拒绝，并返回一个可读错误以传递到演示的错误遮罩层（`canvas.dataset.error`）。**没有**程序化回退方案。

已提交的资产：

- `lab/public/antigravity-racer/rhs-x.glb` — "RHS-X" by Hassan Bassassi (alone5), CC BY 4.0。
- `lab/public/antigravity-racer/rock.glb` — "Obj_Nat_Rock_01" by SaschaHenrichs, CC BY 4.0。
- `lab/public/antigravity-racer/track/*.png` — 道路美术贴图由 Patrick Ryan 创作，经其许可重新分发。

模型 GLB 均已自包含所有内容；无需资产下载器或外部模型纹理。所有署名均显示在启动界面上。

---

## 赛道管线（沿用现有移植版——为完整起见重述）

1. 七个控制点 `DEFAULT_CONTROL_POINTS` 定义一条闭合 Hermite 环路；`sampleLoop` 镜像了 `GetDescToRef`，包括其 `i += 1; i %= 1` 折叠逻辑。
2. `computeControlUps` 复现 `computeDefaultTrackUps`，包含符号连续性修正。
3. `computeTrackRatios` 复现两遍扫描的 `computeTrackLength`（256 弦长估算，随后按每弦发出 `floor(localLength / lengthPerRow)` 个比例值）。
4. `buildTrackFrames` 复现 `createTrackTexture`：标架 `i` 的**原点**是 `ratios[i-1]` 处的采样点，其前向轴指向 `ratios[i]` 处的采样点；`right = normalize(dir × up)`，`up = normalize(right × dir)`。`curveRatios[i] = dot(prevDir, dir)`。
5. `buildTrackPiece` 是合并后的 256 × 40 顶点挤出体：10,240 个顶点，15,360 个索引。
6. `track-material.ts` 在 GPU 上通过一个 `RING_COUNT × 4` 的 `vec4` 存储缓冲区对其弯折，缓冲区各行依次为分段矩阵的列 `(m0,m4,m8,0) (m1,m5,m9,0) (m2,m6,m10,0) (m12,m13,m14,1)`。
7. 赛道信息行：`r = curveRatio > 0.9996 ? 0 : 1`，`g = (i & 31) === 2`，`b = (i & 31) === 6`。

`TrackData.rebuild()` 根据实时控制点重新计算标架，并原地重新上传**同一个**存储缓冲区；可见材质、其阴影投射材质以及物理仿真都会直接感知变化，不产生任何资源抖动。

---

## 飞船状态

```ts
interface ShipState {
    readonly index: number; // == spawn segment; also the noise phase offset ("Index")
    readonly isAI: boolean;
    readonly playerSlot: number; // 0/1 for humans, -1 for AI
    worldPos: Vec3;
    velocity: number; // units per tick
    velocityDirection: Vec3; // steered heading (unit)
    velocityDirectionEffective: Vec3; // drifting heading — DELIBERATELY NOT normalized
    up: Vec3;
    rotYSpeed: number;
    currentSegment: number;
    lastBonusSegment: number;
    tiltZ: number; // ShipTransform.rotation.z
    wobble: Vec3; // ShipTransform.position
    orientationQuat: Quat; // basis (right, up, direction)
    cameraOffsetIndex: 0 | 1;
}
```

`createShipState(track, segStart, lateral, index, isAI, playerSlot)` 镜像了 `CreateShip`：

```
frame     = track.frames[segStart]
worldPos  = frameToWorld(frame, (lateral, 0, 0))
velocity  = 0
velocityDirection = velocityDirectionEffective = frame.dir
up        = frame.up
rotYSpeed = 0, tiltZ = 0, wobble = (0, 0.5, 0)
currentSegment  = segStart
lastBonusSegment = 99999
```

---

## `tickShip` — 精确的逐 tick 仿真

每个固定 60 Hz tick 按飞船顺序执行一次。

### 1. 分段推进、侧墙钳制与吸附

```
loop:
  next   = (currentSegment + 1) % 256
  local  = frameLocalCoords(frames[next], worldPos)      // == TransformCoordinates(worldPos, invMat[next])
  if local.z > 0: currentSegment = next; continue
  frame  = frames[currentSegment]
  local  = frameLocalCoords(frame, worldPos)
  local.y *= (local.y < 0) ? 0.45 : 0.9                  // vertical adhesion — WRITTEN BACK
  wallSlope = 2.5 + local.y
  if local.x < -wallSlope: local.x = -wallSlope; velocity *= 0.99
  if local.x >  wallSlope: local.x =  wallSlope; velocity *= 0.99
  interpolatedUp = lerp(frame.up, frames[next].up, local.z)   // RAW, UNCLAMPED z, componentwise
  worldPos = frameToWorld(frame, local)                       // damped y + clamped x + raw z
  break
```

先前移植版做错且由测试锁定的两点：

- **`local.y` 必须写回**：衰减后的 Y 值是重构世界位置的一部分。正是它把飞船吸附在路面上（也造成了顶面/底面阻尼的非对称效果）。
- **`local.z` 在插值 up 向量时不进行钳制**：在 `[0, 1]` 区间之外该插值会进行*外推*，这正是原 Playground 中 `Matrix.Lerp(M[i], M[i+1], z)` 的行为（逐分量、不钳制）。

由于只读取插值后矩阵的 up 列，移植版仅插值 up 向量，而无需物化整个 4×4 矩阵。

### 2. 加速带

```
hit = |currentSegment - lastBonusSegment| > 10 AND
      ((local.x > 1 AND boostRight[currentSegment]) OR (local.x < -1 AND boostLeft[currentSegment]))
if hit: lastBonusSegment = currentSegment; velocity += 0.3
```

`local.x` 是**钳制后**的值。原 Playground 此处还写了 `camera.fov = 0.9`，但飞船对象上从未存在过 `camera` 参数（`Ship.activeCamera`），因此该语句属于死代码——移植版不复现它，任何地方都没有 FOV 冲击效果。

### 3. 朝向标架

```
n         = normalize(lerp(up, interpolatedUp, 0.1))
right     = normalize(cross(n, direction))
direction = normalize(cross(right, n))
up        = normalize(cross(direction, right))
orientationQuat = basis(right, up, direction)          // == BJS Vector3.RotationFromAxis(right, up, direction)
```

### 4. 噪声、速度比与转向意图

```
localTime = simTime + index                            // simTime advances by 0.0166 per tick
noise = (cos(localTime), sin(1.67 * localTime) * cos(localTime * 0.37), sin(localTime * 2.14))
speedRatio = min(1, velocity / 0.7)                    // computed BEFORE acceleration
```

AI（每艘 AI 飞船使用完全相同的调校参数——没有速度差异，也没有个性差异）：

```
aim   = normalize(frames[(currentSegment + 6) % 256].pos - worldPos)
d     = dot(right, aim)
other = nearest ship strictly ahead within 6 segments   // (otherSeg - selfSeg + 256) % 256 < 6
if other:
    ds = dot(right, normalize(other.worldPos - worldPos))
    if |d - ds| < 0.1: d = (ds > d) ? ds + 0.1 : ds - 0.1
desiredTilt = 0.8 * d
desiredYaw  = 0.05 * d
go = true
```

人类玩家（二值输入，与 Playground 的按键映射完全一致——**同时按住左右时向右优先**）：

```
if (left)  { desiredTilt = -0.8; desiredYaw = -0.05 }
if (right) { desiredTilt =  0.8; desiredYaw =  0.05 }
go = accelerate
```

模拟摇杆输入由输入层转换为此二值意图（`|axis| >= GAMEPAD_STEER_THRESHOLD` ⇒ 该方向处于“按住”状态）；物理系统永远不会看到小数转向值。

### 5. 加速、阻力、漂移与积分

```
if (go AND velocity < 0.7): velocity += 0.004 * (1 - speedRatio)
velocity *= 0.99
fakeInertia = 1 - speedRatio * 0.98
velocityDirectionEffective = lerp(velocityDirectionEffective, velocityDirection, fakeInertia)   // NOT normalized
worldPos += velocityDirectionEffective * velocity
rotYSpeed += (desiredYaw - rotYSpeed) * 0.1
velocityDirection = normalize(rotateAroundAxis(velocityDirection, up, rotYSpeed))
```

`velocityDirectionEffective` 保持不归一化是核心机制：过弯时其长度会降到 1 以下，因此飞船在转向时会自然失去地面推进速度。对其进行归一化（如之前移植版所做的那样）会彻底破坏过弯减速的手感。

### 6. 视觉变换

```
desiredTilt += noise.x * 0.1 * 3
tiltZ  += (desiredTilt - tiltZ) * 0.1
wobble  = (noise.x * 0.1, noise.y * 0.1 + 0.5, noise.z * 0.1)
```

### 7. 飞船层级结构与尾迹发射器

精确复现 Playground 的双节点层级结构：

```
ShipMesh      : position = worldPos, rotation = basis(right, up, direction)
ShipTransform : position = wobble,   rotation = BJS Euler (0, π, tiltZ)  [yaw-pitch-roll → Ry·Rx·Rz]
instanceMatrix = ShipMesh · ShipTransform         (applied above the glTF root)
```

尾迹发射器为 `TransformCoordinates((0.05, 0, 0.85), ShipTransform.worldMatrix)`。在 `Rx = I` 的条件下，这可精确化简为：

```
p     = ( wobble.x - 0.05 * cos(tiltZ),
          wobble.y + 0.05 * sin(tiltZ),
          wobble.z - 0.85 )
emit  = worldPos + right * p.x + up * p.y + direction * p.z
```

（`Ry(π)` 对 x 和 z 取反；`Rz(tiltZ)` 将 `(0.05, 0, 0.85)` 映射到 `(0.05·cos, 0.05·sin, 0.85)`。）
`shipEmitterPoint(ship)` 实现了该化简形式；单元测试证明了其在随机倾角/晃动下与矩阵复合完全等价。

---

## 相机

### `ChaseCamera`（每艘人类飞船一个）

创建为**可倾斜（banked）**自由相机（`createBankedFreeCamera`，见下文），使其能够随赛道侧倾。恒定 `fov = 0.8`，BJS 默认裁剪面（`nearPlane = 1`，`farPlane = 10000`）。

每个 tick 中，令 `W` 为飞船的 `ShipMesh` 世界矩阵（位置 `worldPos`，基向量 `right/up/direction`）：

```
desiredTarget   = worldPos + direction * 5
desiredPosition = worldPos + right*rel.x + up*rel.y + direction*rel.z     // rel ∈ CameraRels
speedRatio      = min(1, velocity / 0.7)
k               = 0.1 + speedRatio * 0.7
position = lerp(position, desiredPosition, k)
target   = lerp(target,   desiredTarget,   k)
upVector = lerp(upVector, ship.up,         k)
```

目标点滤波：BJS 的 `TargetCamera.target` 返回 `_currentTarget = position + forward·focal`，在使用*已更新*位置调用 `setTarget(t)` 之后它就精确等于 `t`。因此存储并线性插值目标点等价于 Playground 的 `Vector3.Lerp(camera.target, …)`，移植版直接存储该目标点。

`cycleOffset()` 按 `CameraRels` 轮换 `rel`（C 键 / 手柄肩键），复现 `CameraIndex`/`CameraIndexArmed`。

### `DemoCamera`（吸引模式 / 菜单背景 — 无人类飞船）

带有 `farPlane = 1500`（Playground 中的 `editorCamera.maxZ`）的可倾斜自由相机。每个 tick：

```
demoCameraTime -= 0.0166
if (demoCameraTime < 0):
    demoCameraTime = random() * 2 + 2
    F = frames[(ships[5].currentSegment + 20) % 256]
    dirFactor = 3 * (random() > 0.5 ? 1 : -1)
    demoCameraDir = F.dir * dirFactor
    translate = F.pos + F.right*(random() - 0.5) + F.up*(random()*2 - 1) + F.dir*(random()*2 - 1)
    translate *= random() * 0.014
    position = F.pos + F.up * 2 - translate * demoCameraTime
    target   = F.pos + demoCameraDir * 3
    upVector = F.up
else:
    translateBy(translate * 0.0166)      // position AND target move together → fixed orientation dolly
```

`TransformCoordinatesFromFloatsToRef` 包含了标架的平移分量，因此 `translate` 是乘以 `random()*0.014` 后的*世界坐标点*——这是原版行为，予以原样保留。在锚点切换之间相机只做推轨平移：BJS 在不调用 `setTarget` 而仅移动 `position` 时会保持朝向固定，移植版通过以相同增量同时平移 `position` 和 `target` 来复现该行为。

---

## 尾迹渲染

Playground 为每艘飞船分配一个克隆的节点材质（23KY8X#14）外加一个包含 256 个样本的 `RawTexture` RGBA-float 历史纹理，并使用 `MeshBuilder.CreateGround({width:0.1, height:0.01, subdivisionsY:256})` 绘制——其自身的顶点位置从未被使用，只有它的 UV 起作用。

### 历史缓冲区

每艘飞船：`Float32Array(256 * 4)`，每行 `[x, y, z, intensity]`，索引 `0` = **最旧**，`255` = **最新**。每个 tick：

```
history.copyWithin(0, 4)                        // == data.shift() ×4
history.set([emit.x, emit.y, emit.z, speedRatio], 1020)   // row 255 = (256 - 1) * 4
updateStorageBuffer(engine, buffer, history)    // exactly one upload per tick
```

`speedRatio` 是 tick 第 4 步中计算的**加速前**速度比。生成时用出生位置和 `intensity = 0` 填充缓冲区，从而在不依赖原版 `new Array(1024)` → `NaN` 裁剪的情况下复现原版的“从无到有生长”效果。

### 几何体（静态，每艘飞船构建一次）

原版地面网格有 257 行（`v = 1 - row/256`）× 2 列（`u ∈ {0,1}`）。历史纹理是一个在两个轴上均采用 **clamp** 寻址模式的 `RawTexture`，因此第 `0` 行和第 `256` 行在 `v` 和 `v + 0.001` 处采样到同一个纹素 ⇒ `normalize(0)` ⇒ `NaN` ⇒ 这些三角形会被丢弃。实际绘制的永远只有第 `1…255` 行。因此移植版精确构建这几行：

- 255 行 × 2 列 = **510 个顶点**
- 254 个四边形 = **1,524 个索引**
- 第 `j` 行（0…254）携带 `v = (255 - j) / 256` 和 `u ∈ {0, 1}`
- 每个四边形的索引模式与 `CreateGround` 匹配，以确保绕序（及背面剔除）完全一致：

```
(j+1,1) (j,1) (j,0)      (j+1,0) (j+1,1) (j,0)
```

所有顶点位置均为零（由顶点着色器定位所有顶点）；网格发布 Playground 的显式超大包围盒（`±1000`），使其永不被视锥剔除。

### 材质

每艘飞船一个 `ShaderMaterial`（Playground 为每艘飞船克隆节点材质），配置如下：

- 顶点属性 `["position", "uv"]`
- 系统 uniform `viewProjection`、`cameraPosition`
- 存储缓冲区 `trailHistory : array<vec4<f32>>`
- `needAlphaBlending: true`、`blendMode: "alpha"`、`depthWrite: false`、`backFaceCulling: true`

`sampleHistory(v)` 复现了钳制且线性过滤的 1×256 浮点纹理采样：

```wgsl
fn sampleHistory(v: f32) -> vec4<f32> {
  let t  = clamp(v * 256.0 - 0.5, 0.0, 255.0);
  let i0 = u32(floor(t));
  let i1 = min(i0 + 1u, 255u);
  return mix(trailHistory[i0], trailHistory[i1], t - floor(t));
}
```

顶点阶段（与节点图完全一致）：

```wgsl
let v  = input.uv.y;
let sx = (input.uv.x - 0.5) * 2.0;              // -1 … +1
let s0 = sampleHistory(v);
let s1 = sampleHistory(v + 0.001);              // slightly NEWER sample
let tangent = normalize(s0.xyz - s1.xyz);       // older − newer
let view    = normalize(s0.xyz - shaderSystem.cameraPosition);
let right   = normalize(cross(view, tangent));
let world   = s0.xyz + right * (sx * 0.1);
out.position  = shaderSystem.viewProjection * vec4<f32>(world, 1.0);
out.vv        = v;
out.sx        = sx;
out.intensity = s0.w;
```

片段阶段：

```wgsl
let alpha = max(0.0, sin(input.sx * 3.14) * sin(input.vv * 1.57) * input.intensity);
return vec4<f32>(1.0 / 255.0, 213.0 / 255.0, 253.0 / 255.0, alpha);
```

颜色为节点材质的 `color` 输入 `(0.00392156862745098, 0.8352941176470589, 0.9921568627450981)` = `rgb(1, 213, 253)`，所有飞船（AI 和人类皆同）完全一致。`max(0, …)` 钳制替代了原版中的负 alpha 半区，该半区在原版 alpha 混合下没有可见贡献。

`dispose()` 释放单飞船的存储缓冲区；网格的 GPU 几何体由 `disposeScene` 释放。

---

## 世界、光照、天空与阴影

### 生命周期：每个会话一个世界，而非每个模式一个世界

Playground 在 `createScene` 中构建其世界，每个模式都复用它。移植版保持这一生命周期：**`createRacerWorlds(engine, assets)` 每个页面生命周期仅运行一次**，其资源——600 细分的高程图地面、巨石池、赛道分段、灯光和 CSM 深度纹理数组——一直存活到页面关闭。模式仅拥有其自身的场景、相机、HUD 和飞船阵列，`addWorldToScene(scene, world)` 将相同的网格实例重新注册到每个新模式场景中（Lite 网格可同时存在于多个场景中）。切换模式时不重新请求资源，也不重新分配阴影贴图。

由于 Lite 会在网格离开其**最后一个**场景时释放该网格的共享 GPU 缓冲区，世界将它的网格保存在一个**驻留场景（residency scene）**中：一个从未注册到引擎、不渲染任何内容的 `createSceneContext(engine, { defaultRenderTask: false })`，它的唯一作用是让模式场景可以安全销毁而不会连带销毁整个世界。

`RacerWorlds` 为每个分屏窗口暴露一个 `RenderWorld`：

| 按世界（分屏窗口）独立 | 所有世界共享 |
| ---------------------- | ------------ |
| 半球光 + 平行光 | 地形网格 |
| CSM 生成器（自有的 1024²×4 深度数组） | 巨石池（`RockField`） |
| `TrackRender`：赛道网格 + 接收/投射材质对 | `TrackData` 样条数据源、飞船模型 |

一个 CSM 生成器会将其级联贴合到**单个**相机并持有一套阴影任务状态，因此两个分屏窗口无法共享同一个：无论哪个窗口最后渲染都会抢占级联，导致另一名玩家的阴影出错或缺失。自定义赛道材质也必须按窗口独立，原因相同——它绑定了对应生成器的级联数组与接收端数据载荷。所有与相机无关的内容（地形、巨石、飞船）均共享：当它们同时被添加到两个窗口的场景中时，Lite 会构建**逐场景**的可渲染对象，绑定对应场景自己的生成器。`worlds.secondary()` 会在首次进入双人竞赛时惰性构建第 2 个窗口并记忆结果，因此单窗口会话永远不会分配第二个深度数组。

`setWorldCasters(world, ships)` 为一个世界的级联重新提供其自身的投射物（其赛道网格 + 巨石）以及当前模式的飞船；模式销毁时用 `[]` 调用它，确保级联绝不引用已释放的飞船网格。一个世界的投射物列表绝不包含另一个窗口的赛道网格。

```
scene.clearColor      = pure black (0, 0, 0, 1)      // fallback while the HDR sky loads
hemisphericLight      = createHemisphericLight([1, 1, 0], 0.5)    // white diffuse, black ground (defaults)
directionalLight      = createDirectionalLight([-1, -2, -1], 1)
directionalLight.position = (120, 50, 100)
```

作为一项有意的超越一致性画质提升，每个模式都会加载 Playground `CGA05F#831` 所使用的精确原始 `https://playground.babylonjs.com/textures/environment.hdr`。Babylon-Lite 将其转换为 512 像素的立方体贴图，同时用于漫反射/镜面反射 IBL 和一个 1000 单位的可见天空盒，不启用色调映射，曝光/对比度均为 `1`。

同一视觉表现层还添加了线性蓝色雾（`start=120`，`end=500`，`color=(0.08, 0.16, 0.30)`）以增强大气纵深，并在保持纹理密度的前提下将地形面积翻倍。地形将这些距离用作 alpha 渐隐，从而使其地平线透出 HDR 环境，而非变成一条不透明的雾色带：

地形：

```
createGroundFromHeightMap(engine, HEIGHTMAP_URL, {
    width: 800, height: 800, subdivisions: 600,
    minHeight: 0, maxHeight: 25, uvScale: [12, 12],
})
terrain.position.y   = -2.05
terrain.material     = standard material + camera-distance alpha plugin
                       diffuseTexture = GROUND_TEXTURE_URL, specularColor = (0,0,0)
terrain.receiveShadows = true
```

阴影（每个世界独立）：

```
sun.shadowGenerator = createCsmDirectionalShadowGenerator(engine, sun, {
    mapSize: 1024, numCascades: 4, lambda: 1, bias: 0.001, shadowMaxZ: 1500,
})   // Lite's CSM receiver is PCF5, matching BJS usePercentageCloserFiltering
setShadowTaskCasterMeshes(shadowGenerator, [thisWorldTrackMesh, ...rockPoolMeshes, ...shipPoolMeshes])
await registerSceneWithShadowSupport(scene)
```

阴影接收方：地形（Standard 材质，内置 CSM 接收器）、岩石和飞船（PBR 材质，内置接收器）以及赛道（自定义接收器，见下文）。内置接收器在构建场景可渲染对象时从 `scene.lights` 解析各自对应的生成器，这也是共享的地形/岩石网格能在分屏模式下各自接收正确窗口级联阴影的原因。

glTF 模型的投射网格为 `HierarchyInstancePool.meshes` 数组——即瘦实例（thin-instanced）载体网格——因此全部 8 艘飞船 / 7 块巨石仅需针对每个源图元登记一个投射项。CSM 投射路径会为这些网格计算瘦实例世界 AABB，使级联贴合能看到每一个实例。

Playground 在赋予每个作者预设的 TRS 之前替换了岩石 glTF 的根变换。移植版采用相同做法：在应用 7 组字面位置、欧拉旋转和非均匀缩放三元组之前清除克隆出来的手性转换根节点，而不是镜像岩石几何体。

### 赛道：投射与接收阴影

赛道的可见材质会采样级联数组，因此**不能**被用作其自身的阴影投射材质：仅深度的投射通道将绑定它自身正在渲染写入的同一张纹理。取而代之的是，赛道拥有第二个不含采样器的 `ShaderMaterial`，具有*相同的*顶点源码和*相同的* `trackFrames` 存储缓冲区，并通过公共的 `setShadowCasterMaterial(visible, caster)` 关联。由于两个材质共享该 GPU 缓冲区，赛道重建会同时作用于双方，因此编辑控制点会在同一帧内同时移动可见几何体及其阴影，不产生任何资源抖动。不存在由 CPU 变形的重复网格。

未变形的顶点缓冲区无法描述道路的世界包围盒，因为顶点着色器是根据 `trackFrames` 来放置每一行的。因此，`computeTrackBoundsInto` 会在每次样条重建后将变形后的横截面拟合到调用方持有的稳定数组中。同一个紧凑包围盒同时驱动渲染剔除和 CSM 投射深度贴合。这避免了 Playground 保守的 `[-1000, 1000]` 剔除盒将近处级联拉大到约 2,000 世界单位——否则归一化的 `0.001` 偏移会导致飞船与路面之间出现明显的阴影悬浮分离。更新包围盒还会递增网格的 bounds revision，从而使静止的编辑器相机依然能重新贴合并重绘级联。

样条本身保存在 `TrackData` 中，不持有任何 GPU 资源；每个窗口的 `TrackRender` 通过 `TrackData.onRebuild` 订阅并原地重新上传各自的帧缓冲区。因此，编辑器拖拽只需重算一次 256 个标架，就能刷新**所有**窗口的可见和投射缓冲区——零内存分配——并且编辑后的赛道会像 Playground 的全局单赛道一样延续到后续的游戏模式中。

阴影接收通过公共的 CSM 接收器接缝连线：

```ts
setShaderTexture(material, "csmShadow", getCsmReceiverTexture(shadowGenerator));
const stop = onCsmReceiverUpdate(shadowGenerator, (data) => updateStorageBuffer(engine, csmBuffer, data));
```

`csmShadow` 声明为 `{ sampleType: "depth", viewDimension: "2d-array", comparison: true }`；80 个浮点数的接收器数据载荷被镜像到一个 `csmReceiver : array<vec4<f32>>` 存储缓冲区中（20 个 `vec4`：4 个 `mat4x4` 级联变换、`viewFrustumZ`、`frustumLengths`、`shadowsInfo`、`csmParams`）。片段着色器复现了 `csm-shadow-fragment-core` 的级联选择 + 5×5 PCF 核 + 级联混合逻辑，并将平行光项乘以所得的阴影因子。在 `onCsmReceiverUpdate`（而非 `onBeforeRender`）内部同步，避免了已知的一帧级联滞后问题。纹理和数据载荷均隶属于单个生成器，这也是每个分屏窗口都构建各自材质副本的原因。

---

## 模式

| 模式 | Playground 调用 | 移植版 |
| ---- | --------------- | ------ |
| Edit Track（编辑赛道） | `initEditing(scene)` | 标记球体 + 位移 Gizmo + 实时 `rebuild()` |
| Test Track（试跑赛道） | `initPlay(scene, 1, 1)` | 1 人类玩家，**无 AI**，追踪相机 |
| 1P Race（单人竞赛） | `initPlay(scene, 8, 1)` | 1 人类玩家 + 7 AI |
| 2P split Race（双人分屏竞赛） | `initPlay(scene, 8, 2)` | 2 人类玩家 + 6 AI，每名玩家独立表面 |
| Demo（演示） | `initPlay(scene, 8, 0)` | 8 AI + `DemoCamera` |

菜单背景复用了 Demo 模式（带有 `isMenuBackground: true` 的 `buildRace`）。Test Track、1P、2P 分屏、Demo 和菜单背景共用同一个 `buildRace` 编排函数，负责管理场景、固定步长累加器（`driveFixedStep`）、暂停处理、输入边沿清零以及销毁；每次调用仅提供 `RaceConfig`（人类/AI 数量、菜单背景标志），并据此构建发车阵列/相机/HUD。Edit Track 不是 `buildRace` 的变体：它没有需要固定步长运行的逐 tick 仿真，因此 `buildEditor` 通过自身的可变步长 `onBeforeRender` 回调驱动样条编辑器、HUD 和 gizmo（`deltaMs` 经钳制后直接转为秒，不使用累加器）。单窗口 `buildRace` 调用（Test Track、1P、Demo、菜单背景）仅使用主世界；2P 则将次世界添加到第二个表面的场景中。销毁过程释放当前模式的场景、HUD、相机和飞船阵列，并从所用每个世界的投射物集合中清除飞船——绝不销毁世界本身。

编辑器在工具层之前注册其由 ArcRotate 控制的主场景，确保位移 gizmo 的交换链叠加层在共享同一台相机的前提下渲染在赛道上方。编辑器本地的指针路由器将空闲时的 gizmo 悬停回读限制为最多一个在途拾取请求外加最新指针位置；共享的引擎 gizmo 分发器保持不变。编辑器相机立即开始轨道旋转，仅在确认 gizmo 拖拽后才让出控制权，因此 GPU 拾取和首次使用时的管线编译不会阻塞普通的相机输入。

作为非原版内容已被移除的特性：圈数计数、排名、排名 HUD 读数、加速闪光计时器、逐 AI 速度系数以及 FOV 冲击。

---

## 本演示所需的引擎新增功能

### `createBankedFreeCamera`（`src/camera/banked-free-camera.ts`）

```ts
export interface BankedFreeCamera extends FreeCamera {
    /** Mutable world-space up vector used to build the look-at basis. */
    readonly upVector: ObservableVec3;
}
export function createBankedFreeCamera(position: Vec3, target: Vec3, up?: Vec3): BankedFreeCamera;
```

`createFreeCamera` 和 `createBankedFreeCamera` 在 `free-camera.ts` 中共享同一个工厂函数（`_createFreeCamera(position, target, up: Vec3)`），它始终使用传入的 `up` 向量，并且没有“banked”的概念——没有分支判断，也没有 `upVector` 属性。`createFreeCamera` 传入共享常量 `Vec3Up`，因此从未导入可倾斜构造函数的场景与修改前的代码在字节上完全一致。`createBankedFreeCamera` 构建自己的 `ObservableVec3` 上向量，将其脏回调连线到相机的世界矩阵失效逻辑，并定义公共的 `upVector` 属性——全部逻辑均位于 `banked-free-camera.ts` 内部——从而使写入 `upVector` 像写入 `position` / `target` 一样触发世界矩阵失效。

### `setShadowCasterMaterial`（`src/material/set-shadow-caster-material.ts`）

```ts
export function setShadowCasterMaterial(material: Material, casterMaterial: Material | null): void;
```

针对现有内部 `Material._shadowCasterMaterial` 接缝的公共、可 Tree-shaking 的设置器，PCF 和 CSM 投射路径均已遵循该接缝。它允许通过与阴影贴图存在别名冲突的资源来*接收*阴影的材质，改用备用材质来投射阴影。在赋值前会沿着 `casterMaterial` 自身的 `_shadowCasterMaterial` 链（与 `getNoColorView` 递归遍历的链相同）检查，从而拒绝任何会循环回到 `material` 的投射器环路——而不仅仅是直接自引用。

---

## 文件清单

| 文件 | 用途 |
| ---- | ---- |
| `antigravity-racer.ts` | 演示入口：加载进度 + 错误遮罩层 |
| `antigravity-racer/game.ts` | 引擎/输入/菜单所有权、模式切换、`buildRace`/`buildEditor` |
| `antigravity-racer/constants.ts` | Playground 数据 + 逐 tick 调校常量 |
| `antigravity-racer/assets.ts` | GLB 模型、道路贴图、远程地形资产 |
| `antigravity-racer/track.ts` | 样条数学、标架、程序化分段、`TrackData` + `TrackRender` |
| `antigravity-racer/track-material.ts` | 变形 + 道路合成 + CSM 接收器 + 投射材质 |
| `antigravity-racer/simulation.ts` | 精确的逐 tick 物理 + AI |
| `antigravity-racer/spawn.ts` | 飞船阵列、逐 tick 视觉同步 |
| `antigravity-racer/ship-fleet.ts` | 实例化飞船模型、`ShipMesh · ShipTransform` |
| `antigravity-racer/rocks.ts` | 按精确变换摆放的实例化巨石 |
| `antigravity-racer/terrain.ts` | 由 Playground 纹理生成的高程图地面 |
| `antigravity-racer/trail.ts` | 存储缓冲区尾迹条带 + WGSL |
| `antigravity-racer/camera-rig.ts` | `ChaseCamera`、`DemoCamera` |
| `antigravity-racer/world.ts` | 会话生命周期世界：灯光、逐窗口 CSM、驻留场景、投射物 |
| `antigravity-racer/editor.ts` | 控制点标记、gizmo、实时重建 |
| `antigravity-racer/input.ts` | 键盘（物理键码）+ 手柄 → 二值飞船控制 |
| `antigravity-racer/menu.ts`, `hud.ts` | DOM 菜单、HUD、暂停遮罩、编辑器工具栏 |
| `antigravity-racer/gamepad-list-nav.ts` | 共享按钮列表导航 |
| `antigravity-racer/bjs-euler.ts` | Babylon yaw-pitch-roll 欧拉角 → 四元数 |
