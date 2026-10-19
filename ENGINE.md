# 《芯》引擎说明（写镜头模块的人必读）

先读 `SCRIPT.md`（剧本、分镜、视觉圣经），再读本文件。时间以 `timeline.json` 为准。

## 运行环境

无 GPU。无头 Chromium 用 SwiftShader（CPU 软件 WebGL2，4 核）渲染。画面要好看，也必须算得动。
- **预算**：正式分辨率（1920×804）下平均每帧 ≤ 1500 ms（渲染 + 读像素）。用 `node tools/bench.mjs --from A --to B` 测。全片约 6000 帧，超预算意味着整片渲染要好几个小时。
- 全屏多次采样的光线步进非常贵。体积效果应在 1/2 或 1/4 分辨率的离屏 target 里做再合成（用 `ctx.makeTarget`、`ctx.fsq`、`ctx.passMaterial`）。
- 粒子（加法混合点精灵）很便宜，几十万个没问题；大点精灵的填充率是主要开销。

## 镜头模块

文件放在 `src/shots/<dir>/<name>.js`，由 `timeline.json` 中 `shots[].module` 引用。同一模块可以服务多个连续镜头（如 `act2/flames.js` 负责 S11–S17），引擎只创建一个实例。

```js
export default async function create(ctx) {
  const { THREE, util, glsl, overlay } = ctx;
  // 在这里建场景、几何体、材质（一次性）
  return {
    msaa: 0,               // 可选：场景 target 的 MSAA 采样数（0 或 4）。有硬边几何体/细线时用 4，会更慢
    render(f) {            // 每帧调用。必须是 f.T 的纯函数
      // f = { T 全片秒数, t 镜头内秒数, shot 时间线条目, frame, dt, target 当前 HDR target, W, H, S }
      ctx.renderer.setRenderTarget(f.target);
      ctx.renderer.render(scene, camera);
      return { exposure: 1.0, bloom: 0.6, streak: 0.0 /* ...见下 */ };   // 本帧调色，可省略
    },
    overlay(g, f) { },     // 可选：Canvas2D 叠加层（HUD）。g 是 1920*S 宽的 2D context
    dispose() { },         // 可选：释放 GPU 资源
  };
}
```

### 铁律

1. **确定性**：每帧只依赖 `f.T`，以便多进程分块并行渲染、任意帧可单独重渲。
   - 禁用 `Math.random`，用 `util.rng(seed)`。
   - 禁止跨帧累积状态。粒子运动写成时间的闭式函数：位置 = 初值 + 时间的函数 + 噪声场(时间)。
2. **场景渲染到 `f.target`**（HalfFloat HDR，线性色彩）。不要自己做色调映射或 sRGB 转换，引擎会做。
   - 允许亮度远大于 1：火焰芯、恒星可到 5–50，泛光会处理。
3. **时间点从 cue 读**：`ctx.cue('ignite')`，不要硬编码秒数，这样剪辑改时间线时画面和配乐一起走。
4. **字幕卡由引擎统一画**（`timeline.cards`），镜头模块不要画卡片文字。
   - 镜头要在卡片出现时让出空间：画面变暗、主体偏离中心，或降低细节。
5. **HUD 只出现在机器的目光里**：第一幕的数据标注、机器之火的复制计数与失步框。永远不要出现在蜡烛上。
6. 不要修改 `src/engine/`、`timeline.json`、`SCRIPT.md`。需要引擎能力或时间调整时，在最终报告里提出，由导演统一改。

## ctx 提供

| 名称 | 说明 |
|---|---|
| `THREE` | three.js r186 模块 |
| `renderer` | 共享 WebGLRenderer |
| `W, H, S` | 画布尺寸；`S = W/1920`，所有像素尺寸（点大小、线宽、字号）都要乘 `S`，以支持低清预览 |
| `cue(name)` | 时间线 cue 的绝对秒数 |
| `shot(id)` / `card(id)` | 时间线条目 |
| `util` | `clamp lerp invLerp remap smoothstep smootherstep ease.* ramp(x,a,b,fn) envelope(x,a,b,c,d) rng(seed) noise1 fbm1 handheld(T,amp,speed,seed)` |
| `glsl` | GLSL 片段字符串：`hash`、`simplex3`（`snoise`、`fbm3`、`curl3`）、`blackbody(K)`、`inferno(t)`、`sprite`、`all` |
| `overlay` | HUD 工具：`hudCallout(g,{anchor,dir,len,lines,t,alpha,S})`、`hudBracket`、`hudText`、`withGlitch(g,amount,seed,W,H,draw)`、`FONTS`、`COLORS`、`rgba`、`glowText` |
| `project(vec3, camera)` | 世界坐标投影到叠加层像素 `[x, y, visible]` |
| `makeTarget(w,h,{samples,depth,type})` | 自建离屏 target |
| `fsq.render(renderer, material, target)` / `passMaterial(frag, uniforms, extra)` | 全屏 pass（GLSL3：`in vec2 vUv; out vec4 o;`） |

## 每帧调色参数（render 返回值，缺省见 `src/engine/post.js` 的 `defaultGrade`）

`exposure`、`bloom`（强度，约 0.3–1.2）、`bloomThreshold`、`bloomKnee`、`bloomRadius`、`bloomTint`、`streak`（变形宽银幕横向光晕强度，0 = 关；只在关键时刻用）、`streakTint`、`saturation`、`contrast`、`temperature`（−1 冷 … +1 暖）、`lift/gamma/gain`（vec3）、`vignette`、`ca`（色散）、`grain`、`fade`（画面淡入淡出 0–1，不影响字幕卡）。

## 工具

```bash
node tools/still.mjs 45.5 60 S12 [--scale 0.5]           # 静帧 -> out/stills/，用 Read 工具看 PNG
node tools/sheet.mjs --shot A1 --n 16 [--scale 0.5]       # 联系表 -> out/sheets/，看运动与节奏
node tools/sheet.mjs --from 44 --to 47 --n 12             # 细看某个瞬间
node tools/bench.mjs --from 46 --to 58                    # 测每帧耗时
node tools/render.mjs --preview --from 30 --to 92         # 低清预览视频块（out/preview/）
```

浏览器预览：在 `film/` 下起静态服务（`npx serve .`），打开 `index.html?from=30`，实时播放（有 GPU 时）并带配乐。
