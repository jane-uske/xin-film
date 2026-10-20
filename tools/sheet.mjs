// 联系表（看运动/节奏用）：node tools/sheet.mjs --from 30 --to 92 [--n 16] [--cols 4] [--scale 0.5] [--out out/sheets/name.png]
// 也可用 --shot A1 指定镜头区间
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, FFMPEG, timeline, parseArgs, startServer, launch, openFilm } from './lib.mjs';

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
const requestedPort = Number(args.port || 0);
const server = await startServer(requestedPort, async () => {});
const port = server.address().port;
let browser;
try {
const W = Math.round(tl.width * scale), H = Math.round(tl.height * scale);
const launched = await launch({ width: W, height: H });
browser = launched.browser;
const page = launched.page;
await openFilm(page, port, `render=1&scale=${scale}`);
for (let i = 0; i < n; i++) {
  const t = from + ((to - from) * (i + 0.5)) / n;
  const frame = Math.round(t * tl.fps);
  await page.evaluate((f) => window.FILM.renderFrame(f), frame);
  const png = await page.evaluate((time) => {
    const film = document.getElementById('film'), canvas = document.createElement('canvas');
    canvas.width = 480; canvas.height = Math.round(film.height * 480 / film.width);
    const g = canvas.getContext('2d'); g.drawImage(film, 0, 0, canvas.width, canvas.height);
    g.fillStyle = '#0009'; g.fillRect(4, 4, 82, 22);
    g.font = '14px monospace'; g.fillStyle = '#fffd'; g.fillText(time.toFixed(2) + 's', 8, 20);
    return canvas.toDataURL('image/png').split(',')[1];
  }, t);
  fs.writeFileSync(path.join(tmp, `${String(i).padStart(3, '0')}_l.png`), Buffer.from(png, 'base64'));
}
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}
// Time labels were drawn in the browser; no operating-system font path needed.
const rows = Math.ceil(n / cols);
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(tmp, '%03d_l.png'), '-vf', `tile=${cols}x${rows}:padding=4:color=0x202020`, '-frames:v', '1', out]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(out);

