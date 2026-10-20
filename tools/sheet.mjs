// 联系表（看运动/节奏用）：node tools/sheet.mjs --from 30 --to 92 [--n 16] [--cols 4] [--scale 0.5] [--out out/sheets/name.png]
// 也可用 --shot A1 指定镜头区间
// 时间戳与拼图在浏览器里完成，不依赖 ffmpeg 的 drawtext（Homebrew 版 ffmpeg 不带 freetype）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, timeline, parseArgs, startServer, launch, openFilm } from './lib.mjs';

const args = parseArgs();
const tl = timeline();
let from = parseFloat(args.from ?? 0), to = parseFloat(args.to ?? tl.duration);
if (args.shot) { const s = tl.shots.find((x) => x.id === args.shot); from = s.start; to = s.end; }
const n = parseInt(args.n || '16', 10), cols = parseInt(args.cols || '4', 10);
const scale = parseFloat(args.scale || '0.5');
const out = path.resolve(ROOT, args.out || `out/sheets/${args.shot || `${from}-${to}`}.png`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const port = parseInt(args.port || String(9300 + Math.floor(Math.random() * 600)), 10);
const server = await startServer(port, async () => {});
const W = Math.round(tl.width * scale), H = Math.round(tl.height * scale);
const { browser, page } = await launch({ width: W, height: H });
await openFilm(page, port, `render=1&scale=${scale}`);
const cells = [];
for (let i = 0; i < n; i++) {
  const t = from + ((to - from) * (i + 0.5)) / n;
  const frame = Math.round(t * tl.fps);
  await page.evaluate((f) => window.FILM.renderFrame(f), frame);
  const png = await page.locator('#film').screenshot();
  cells.push({ src: `data:image/png;base64,${png.toString('base64')}`, label: `${t.toFixed(2)}s` });
}
// 每格 480 宽、打上时间戳，格间 4px 深灰
const CW = 480, CH = Math.round((CW * H) / W), PAD = 4;
const rows = Math.ceil(n / cols);
const SW = cols * CW + (cols - 1) * PAD, SH = rows * CH + (rows - 1) * PAD;
const sheet = await browser.newPage({ viewport: { width: SW, height: SH }, deviceScaleFactor: 1 });
await sheet.setContent(`<!doctype html><html><body style="margin:0;background:#202020">
  <div style="display:grid;grid-template-columns:repeat(${cols},${CW}px);gap:${PAD}px">
  ${cells.map((c) => `<div style="position:relative;width:${CW}px;height:${CH}px">
    <img src="${c.src}" style="display:block;width:${CW}px;height:${CH}px">
    <span style="position:absolute;left:6px;top:6px;padding:1px 3px;font:14px Menlo,'DejaVu Sans Mono',monospace;color:rgba(255,255,255,.85);background:rgba(0,0,0,.5)">${c.label}</span>
  </div>`).join('')}
  </div></body></html>`);
await sheet.waitForFunction(() => [...document.images].every((im) => im.complete));
await sheet.screenshot({ path: out });
await browser.close();
server.close();
console.log(out);
