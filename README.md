# 《芯》XIN

3′47″ 的全代码生成短片：画面由 Three.js / WebGL 逐帧渲染，音乐与音效由 numpy/scipy 合成，脚本自动剪辑成片。剧本与分镜见 [`SCRIPT.md`](SCRIPT.md)，写镜头模块前读 [`ENGINE.md`](ENGINE.md)。

本分支 `codex/xin-v2-interpretation` 从 Opus 的第二版制作中提交 `558e608` 接续，供两版独立对比。保留原剧本、视觉资产、无旁白形式和空栏结尾；接续与验证记录见 [`CODEX_CUT.md`](CODEX_CUT.md)。

## 出片

```bash
npm ci
npx playwright install chromium
python3 -m pip install -r audio/requirements.txt
npm test                              # 时间线、源码引用、缓存与混流检查
python3 audio/score.py --validate      # 检查音乐时点与静默窗口
python3 audio/score.py --no-plots      # 配乐、数值QA、签名 -> out/
node tools/render.mjs --jobs 4         # 逐帧渲染 -> out/chunks/
node tools/build.mjs                   # 拼接、遮幅、配乐 -> out/XIN_codex.mp4
```

需预先安装 FFmpeg（含 ffprobe）。绘图报告为可选项，安装 matplotlib 后去掉 `--no-plots` 即可生成。

渲染块记录当前画面源码、时间线、依赖锁文件和署名配置的签名。源码变化后旧块会失效；`build` 会拒绝混用旧版块。用 `--shots S12,S13 --force` 可先检查局部，正式出片前再运行一次完整 `render`，补齐所有失效块。音轨也必须与当前时间线对应；无声检查版须显式传 `--silent`。

本机 Chrome 可通过 `CHROMIUM_EXECUTABLE_PATH` 指定，`FILM_GPU=1` 启用硬件渲染；`FFMPEG_PATH`、`FFPROBE_PATH` 可指定媒体工具。默认仍使用软件渲染，耗时取决于设备。支持 `FILM_TRANSPORT=route` 的无服务器离线传输。

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

```bash
node tools/render.mjs --preview --jobs 2
node tools/build.mjs --preview         # 960×540 / 12 fps 完整有声审片版
node tools/portable.mjs                # 自包含HTML，可在本机浏览器打开、跳帧和导出
```

