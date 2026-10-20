# 《芯》XIN

4′12″ 的全代码生成短片：画面由 Three.js / WebGL 逐帧渲染，音乐与音效由 numpy/scipy 合成，脚本自动剪辑成片。剧本与分镜见 [`SCRIPT.md`](SCRIPT.md)，写镜头模块前读 [`ENGINE.md`](ENGINE.md)。

## 出片

```bash
npm install   # 在本目录下执行
python3 audio/score.py                 # 配乐 -> out/score.wav（约 2–3 分钟）
node tools/render.mjs --jobs 4         # 逐帧渲染 -> out/chunks/（无 GPU 约 1 小时，已完成的块会跳过）
node tools/build.mjs                   # 拼接 + 2.39:1 遮幅 + 混入配乐 -> out/XIN.mp4
```

只改了某个镜头时，用 `node tools/render.mjs --shots S12,S13 --force` 重渲与之重叠的块，再 `build`。

## 出品方署名

开场星座与片尾的出品方字标默认是 `ASTRA`。在本目录的 `credit.local.json` 写入 `{ "word": "你的署名" }` 即可替换（该文件不进仓库；星座字体支持的字符见 `src/shots/common/astra.js`）。

## 目录

| 路径 | 内容 |
|---|---|
| `timeline.json` | 唯一的时间来源：镜头、cue、字幕卡、同步事件。画面与配乐都从这里读 |
| `src/engine/` | 镜头调度、HDR 后期（泛光、变形宽银幕光晕、ACES、颗粒）、字幕层与 HUD |
| `src/shots/` | 镜头模块：`prologue/`（星空、星座、题记）、`act1/`（热）、`act2/`（芯·心）、`epilogue/`（星海、片名、片尾） |
| `audio/` | 配乐与音效合成、母带处理（BS.1770 响度、真峰值限幅） |
| `tools/` | 渲染农场、静帧、联系表、性能测试、成片拼接 |

## 实时预览

有 GPU 的机器上，在本目录执行 `npx serve .`，打开 `index.html?from=30`（点击开声音，空格暂停，←/→ 跳 5 秒）。
