# 右手坐标系

> 🧪 **实验性。** 右手坐标系构建目前已经覆盖核心渲染路径（见[支持范围](#支持范围)）；其余特性正逐项跟进。

Babylon Lite 与 Babylon.js 一样，默认采用**左手坐标系（left-handed）**。Babylon.js 在运行时通过 `scene.useRightHandedSystem = true` 切换到右手坐标系。而 Lite 则在**编译你的应用时**做出同样的选择：只需向打包工具添加一个解析条件 `babylon-lite-rh`，该构建产物中的每一个引擎便都是右手坐标系。

你的业务代码无需任何修改：依然照常调用 `createEngine`、`createArcRotateCamera`、`loadGltf`……类型定义也完全相同。

为什么放在编译期？因为这样可以做到零开销。坐标系手性是一个常量，代码压缩器会直接将其折叠消除：右手坐标系包里只保留右手坐标系代码；在 Rolldown（lab 场景使用的打包工具，已逐场景核对）下，左手坐标系包更是与引入该特性之前字节级完全一致。如果压缩器不会内联导入的常量（例如 esbuild），则会保留手性判断分支和几个小型辅助函数：左手渲染结果不变，只是包体积略微大一点。而如果是运行时开关，无论你是否使用左手坐标系，每个场景都会多出一份代码体积。

---

## 1. 编译为右手坐标系

将 `babylon-lite-rh` 条件添加到你的打包工具的 resolve conditions 中。选择你使用的打包工具：

### Vite（6 及更高版本）

```ts
// vite.config.ts
import { defineConfig, defaultClientConditions } from "vite";

export default defineConfig({
    resolve: {
        conditions: [...defaultClientConditions, "babylon-lite-rh"],
    },
});
```

`resolve.conditions` 会**替换** Vite 的默认条件，因此请保留 `...defaultClientConditions`。如果你同时使用服务端渲染（SSR），也请连同 `defaultServerConditions` 一起将该条件添加到 `ssr.resolve.conditions` 中。

### Vite 5 及更早版本

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
    resolve: {
        conditions: ["babylon-lite-rh"],
    },
});
```

### webpack 5

```js
// webpack.config.js
module.exports = {
    resolve: {
        conditionNames: ["babylon-lite-rh", "..."], // "..." keeps webpack's defaults
    },
};
```

### esbuild

```bash
esbuild app.ts --bundle --conditions=babylon-lite-rh,module --outfile=out.js
```

```js
await esbuild.build({ entryPoints: ["app.ts"], bundle: true, conditions: ["babylon-lite-rh", "module"], outfile: "out.js" });
```

设置 `conditions` 会替换 esbuild 默认的 `module` 条件，因此需要把 `module` 一并列出来。

### Rollup

```js
// rollup.config.js
import { nodeResolve } from "@rollup/plugin-node-resolve";

export default {
    input: "app.ts",
    plugins: [nodeResolve({ exportConditions: ["babylon-lite-rh"] })],
};
```

### Rolldown

```js
// rolldown.config.js
export default {
    input: "app.ts",
    resolve: { conditionNames: ["babylon-lite-rh", "import", "module", "browser", "default"] },
};
```

### 实现原理

`@babylonjs/lite` 在其 `package.json` 中声明了一个私有包导入 `#coordinate-system`：

```json
"imports": {
    "#coordinate-system": {
        "babylon-lite-rh": "./lib/engine/coordinate-system-rh.js",
        "default": "./lib/engine/coordinate-system.js"
    }
}
```

引擎中每个依赖手性的模块都会从 `#coordinate-system` 导入对应的标志位。你的打包工具会根据你配置的条件对该导入进行一次解析：存在 `babylon-lite-rh` 时选中右手版本的文件，否则选中左手版本。任何支持 `package.json` `imports` 与自定义条件的打包工具都按同样的方式工作。

由于使用了这一导入，`lib/` 下的模块需要由支持读取 `package.json` `imports` 的打包工具来解析（上述工具均支持；原生 Rollup 需要配合 `@rollup/plugin-node-resolve`）。浏览器原生 ESM 自身无法解析 `#coordinate-system`：如直接使用浏览器原生加载，请改用预构建的 `dist/index.js`（该构建默认为左手坐标系）。

---

## 2. 验证配置是否生效

把一个立方体放在 **+X** 侧，并从 **−Z** 方向观察它：

```ts
const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 }); // camera at -Z
const box = createBox(engine);
box.position.x = 2;
```

- 左手构建：立方体位于画布**右侧**。
- 右手构建：立方体位于画布**左侧**，与 Babylon.js 中设置 `useRightHandedSystem = true` 时完全一致。

如果立方体依然显示在右侧，说明条件尚未传递到打包工具：请检查你修改的配置是否正是当前构建使用的配置；如果使用 Vite，请使用 `--force` 重启开发服务器以重建依赖缓存。

---

## 3. 右手引擎中的变化

行为与 Babylon.js 设置 `scene.useRightHandedSystem = true` 一致：

- **相机**沿局部 **−Z** 轴观察；在相同位置与目标点下，画面是左手模式的镜像。
- **glTF** 资产保持 glTF 原生的右手坐标空间：与 Babylon.js 一样，不再添加用于镜像的根节点。
- **三角形绕序**：正面判定遵循 Babylon.js 的右手规则，因此背面剔除在 glTF 与程序化网格上均可正常工作，适用于 PBR、Standard、Node 与 Shader 材质——包括启用 `enableMirroredMeshes()` 后从 PBR 切换为 Node 或 Shader 材质的 glTF 网格。
- **环境光照**（IBL）的朝向与 Babylon.js 右手场景一致（glTF `EXT_lights_image_based` 的偏航角除外，见[限制](#限制)）。

迁移一个右手坐标系的 Babylon.js 场景时，只需原样保留其位置、旋转和相机角度数值：相同的数字会得到相同的画面。

## 支持范围

已覆盖 Lite 中所有受 Babylon.js `useRightHandedSystem = true` 影响的功能：相机及其键鼠与触控输入（弧形旋转、自由、正交、地理空间、glTF 与 `.babylon` 相机）、glTF 加载（蒙皮、动画、变形目标、内嵌相机、负缩放节点、高斯泼溅、交互性相机路径）、PBR/Standard/Node/Shader 材质、基于图像的光照（IBL）、天空盒与反射、阴影与级联阴影、基于深度重建法线的屏幕空间效果（接触阴影、SSGI、空腔效应）及网格混合、程序化网格、CSG2、精灵与广告牌（及其拾取）、Gizmo 操纵器、Havok 网格碰撞形状、USD 以及 WebXR（姿态、指针、传送、手部与控制器模型）。

下方列出的实验室场景已经将其中的大多数能力与 Babylon.js 进行了对比验证。高斯泼溅、屏幕空间效果（接触阴影、SSGI、空腔效应）以及网格混合暂未建立专门的右手实验室场景：目前仅通过单元测试对，将其右手结果与左手结果进行对照校验。无论哪种情况，只要修改了左手代码却未同步修改对应的右手代码，测试套件都会直接报错（参见[架构文档](architecture/61-right-handed-system.md#测试)）。

## 限制

- **每个构建包只能有一种手性。** 同一打包产物中创建的每个引擎都具有相同的手性。如果两个页面需要不同的手性，就需要产出两份构建。
- **`EXT_lights_image_based` 尚未移植。** 右手构建仍以左手符号应用该扩展的环境旋转，因此只要旋转角度不是 0° 或 180°，环境旋转方向就会与 Babylon.js 的右手场景不同。因此 Twin 342（旋转 90°）目前对照的是其左手源场景的参考图，而非 Babylon.js 右手参考图。
- **CDN 构建版与 [Lite Playground](04-playground.md) 为左手坐标系。** 它们均使用默认条件预先构建。

## 在实验室中查看效果

实验室画廊中的场景 321 至 347 分别是场景 2、5、13、28、38、11、25、250、266、268、270、4、214、72、60、159、54、94、223、225、91、265、24、143、103、149 和 9 的右手孪生版本：使用完全相同的 Lite 代码，通过 `babylon-lite-rh` 编译，并与开启了 `useRightHandedSystem = true` 的同一 Babylon.js 参考实现进行像素比对。
具体实现细节请参阅[右手坐标系架构文档](architecture/61-right-handed-system.md)。
