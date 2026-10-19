// 联系表（看运动/节奏用）：node tools/sheet.mjs --from 30 --to 92 [--n 16] [--cols 4] [--scale 0.5] [--out out/sheets/name.png]
// 也可用 --shot A1 指定镜头区间
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, timeline, parseArgs, startServer, launch, openFilm } from './lib.mjs';

const args = parseArgs();
const tl = timeline();
let from = parseFloat(args.from ?? 0), to = parseFloat(args.to ?? tl.duration);
if (args.shot) { const s = tl.shots.find((x) => x.id === args.shot); from = s.start; to = s.end; }
const n = parseInt(args.n || '16', 10), cols = parseInt(args.cols || '4', 10);
const scale = parseFloat(args.scale || '0.5');
const out = path.resolve(ROOT, args.out || `out/sheets/${args.shot || `${from}-${to}`}.png`);
const tmp = path.join(ROOT, 'out', '.sheet-tmp-' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
const port = parseInt(args.port || String(9300 + Math.floor(Math.random() * 600)), 10);
const server = await startServer(port, async () => {});
const W = Math.round(tl.width * scale), H = Math.round(tl.height * scale);
const { browser, page } = await launch({ width: W, height: H });
await openFilm(page, port, `render=1&scale=${scale}`);
for (let i = 0; i < n; i++) {
  const t = from + ((to - from) * (i + 0.5)) / n;
  const frame = Math.round(t * tl.fps);
  await page.evaluate((f) => window.FILM.renderFrame(f), frame);
  await page.locator('#film').screenshot({ path: path.join(tmp, `${String(i).padStart(3, '0')}.png`) });
  fs.writeFileSync(path.join(tmp, `${String(i).padStart(3, '0')}.txt`), `${t.toFixed(2)}s`);
}
await browser.close();
server.close();
// 每张图打上时间戳再拼
const font = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
for (let i = 0; i < n; i++) {
  const b = path.join(tmp, String(i).padStart(3, '0'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${b}.png`, '-vf', `scale=480:-1,drawtext=fontfile=${font}:textfile=${b}.txt:x=6:y=6:fontsize=14:fontcolor=white@0.85:box=1:boxcolor=black@0.5`, `${b}_l.png`]);
}
const rows = Math.ceil(n / cols);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(tmp, '%03d_l.png'), '-vf', `tile=${cols}x${rows}:padding=4:color=0x202020`, '-frames:v', '1', out]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(out);
