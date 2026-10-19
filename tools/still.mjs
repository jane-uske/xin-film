// 渲染静帧：node tools/still.mjs 45.5 60 70 [--scale 0.5] [--out out/stills] [--port 9301]
// 时间可写成秒数或镜头 id（取镜头中点），如 S12
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, timeline, parseArgs, startServer, launch, openFilm } from './lib.mjs';

const args = parseArgs();
const tl = timeline();
const scale = parseFloat(args.scale || '1');
const outDir = path.resolve(ROOT, args.out || 'out/stills');
fs.mkdirSync(outDir, { recursive: true });
const port = parseInt(args.port || String(9300 + Math.floor(Math.random() * 600)), 10);
const times = args._.map((x) => { const s = tl.shots.find((sh) => sh.id === x); return s ? (s.start + s.end) / 2 : parseFloat(x); });

const server = await startServer(port, async () => {});
const W = Math.round(tl.width * scale), H = Math.round(tl.height * scale);
const { browser, page } = await launch({ width: W, height: H });
await openFilm(page, port, `render=1&scale=${scale}`);
for (const t of times) {
  const frame = Math.round(t * tl.fps);
  const t0 = Date.now();
  await page.evaluate((f) => window.FILM.renderFrame(f), frame);
  const ms = Date.now() - t0;
  const file = path.join(outDir, `t${t.toFixed(2).padStart(7, '0')}.png`);
  await page.locator('#film').screenshot({ path: file });
  console.log(`${file}  (${ms} ms)`);
}
await browser.close();
server.close();
