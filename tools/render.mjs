// 离线渲染农场。把全片按 10 秒切块，多个无头 Chromium 并行，原始像素直送 ffmpeg。
//   node tools/render.mjs                       渲染所有缺失的块
//   node tools/render.mjs --jobs 3              并行数
//   node tools/render.mjs --shots A1,S12 --force   只重渲与这些镜头重叠的块
//   node tools/render.mjs --from 30 --to 92     只渲染此时间区间内的块
//   node tools/render.mjs --preview --scale 0.5 --step 2   低清预览（12fps），输出到 out/preview/
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, timeline, parseArgs, startServer, launch, openFilm, fmt } from './lib.mjs';

const args = parseArgs();
const tl = timeline();
const CHUNK = 240; // 帧
const total = Math.round(tl.duration * tl.fps);
const preview = !!args.preview;
const scale = parseFloat(args.scale || (preview ? '0.5' : '1'));
const step = parseInt(args.step || (preview ? '2' : '1'), 10);
const jobs = parseInt(args.jobs || '2', 10);
const outDir = path.join(ROOT, 'out', preview ? 'preview' : 'chunks');
fs.mkdirSync(outDir, { recursive: true });

let chunks = [];
for (let k = 0; k * CHUNK < total; k++) chunks.push({ k, from: k * CHUNK, to: Math.min(total, (k + 1) * CHUNK) });
const overlaps = (c, a, b) => c.from / tl.fps < b && c.to / tl.fps > a;
if (args.shots) {
  const ids = String(args.shots).split(',');
  const ranges = tl.shots.filter((s) => ids.includes(s.id)).map((s) => [s.start, s.end]);
  chunks = chunks.filter((c) => ranges.some(([a, b]) => overlaps(c, a, b)));
}
if (args.from !== undefined || args.to !== undefined) {
  const a = parseFloat(args.from ?? 0), b = parseFloat(args.to ?? tl.duration);
  chunks = chunks.filter((c) => overlaps(c, a, b));
}
const fileOf = (c) => path.join(outDir, `c${String(c.k).padStart(3, '0')}.mkv`);
if (!args.force) chunks = chunks.filter((c) => !fs.existsSync(fileOf(c)));
if (!chunks.length) { console.log('nothing to render'); process.exit(0); }
console.log(`rendering ${chunks.length} chunk(s) with ${jobs} job(s), scale ${scale}, step ${step}`);

const W = Math.round(tl.width * scale), H = Math.round(tl.height * scale);
const queue = [...chunks];
const t0 = Date.now();
let framesDone = 0;
const framesTotal = chunks.reduce((s, c) => s + Math.ceil((c.to - c.from) / step), 0);

async function worker(w) {
  const port = 9400 + w + Math.floor(Math.random() * 50) * 10;
  let ff = null, pending = Promise.resolve();
  const server = await startServer(port, (i, buf) => {
    if (buf.length !== W * H * 4) throw new Error(`frame ${i}: got ${buf.length} bytes`);
    return new Promise((res, rej) => { if (!ff.stdin.write(buf)) ff.stdin.once('drain', res); else res(); });
  });
  const { browser, page } = await launch({ width: W, height: H });
  await openFilm(page, port, `render=1&scale=${scale}`);
  while (queue.length) {
    const c = queue.shift();
    const file = fileOf(c);
    const tmp = file + '.part.mkv';
    ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(tl.fps / step), '-i', '-',
      '-vf', 'vflip', '-c:v', 'libx264', '-preset', preview ? 'veryfast' : 'medium', '-crf', preview ? '20' : '8', '-pix_fmt', preview ? 'yuv420p' : 'yuv444p', '-g', '48', tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((res, rej) => ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)))));
    const c0 = Date.now();
    for (let f = c.from; f < c.to; f += step) {
      await page.evaluate(async ({ f, url }) => { await window.FILM.renderFrame(f); await window.FILM.sendFrame(f, url); }, { f, url: `http://127.0.0.1:${port}/frame` });
      framesDone++;
      if (framesDone % 24 === 0) {
        const el = (Date.now() - t0) / 1000;
        process.stdout.write(`  [w${w}] ${(f / tl.fps).toFixed(1)}s  ${framesDone}/${framesTotal}  ${(el / framesDone * 1000 * jobs).toFixed(0)} ms/frame/job  ETA ${fmt(el / framesDone * (framesTotal - framesDone))}\n`);
      }
    }
    ff.stdin.end();
    await done;
    fs.renameSync(tmp, file);
    console.log(`  [w${w}] chunk ${c.k} done in ${fmt((Date.now() - c0) / 1000)}`);
  }
  await browser.close();
  server.close();
}

await Promise.all(Array.from({ length: Math.min(jobs, chunks.length) }, (_, i) => worker(i)));
console.log(`all done in ${fmt((Date.now() - t0) / 1000)}`);
