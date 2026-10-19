// 性能测试：node tools/bench.mjs --from 46 --to 58 [--n 12] [--scale 1]
// 输出该区间平均每帧耗时（渲染 + 读像素，和正式渲染一致）
import { timeline, parseArgs, startServer, launch, openFilm } from './lib.mjs';

const args = parseArgs();
const tl = timeline();
let from = parseFloat(args.from ?? 0), to = parseFloat(args.to ?? from + 2);
if (args.shot) { const s = tl.shots.find((x) => x.id === args.shot); from = s.start; to = s.end; }
const n = parseInt(args.n || '12', 10);
const scale = parseFloat(args.scale || '1');
const port = 9300 + Math.floor(Math.random() * 600);
const server = await startServer(port, async () => {});
const { browser, page } = await launch({ width: Math.round(tl.width * scale), height: Math.round(tl.height * scale) });
await openFilm(page, port, `render=1&scale=${scale}`);
// 预热（着色器编译、模块初始化）
await page.evaluate((f) => window.FILM.renderFrame(f), Math.round(from * tl.fps));
const res = await page.evaluate(async ({ from, to, n, fps }) => {
  const times = [];
  for (let i = 0; i < n; i++) {
    const f = Math.round((from + ((to - from) * (i + 0.5)) / n) * fps);
    const t0 = performance.now();
    await window.FILM.renderFrame(f);
    window.FILM.engine.readPixels();
    times.push(performance.now() - t0);
  }
  return times;
}, { from, to, n, fps: tl.fps });
const avg = res.reduce((a, b) => a + b, 0) / res.length;
console.log(`${from}s–${to}s  avg ${avg.toFixed(0)} ms/frame  max ${Math.max(...res).toFixed(0)} ms  (${res.map((x) => x.toFixed(0)).join(' ')})`);
await browser.close();
server.close();
