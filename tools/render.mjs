// Deterministic frame rendering with source-aware, atomic chunk caching.
// node tools/render.mjs --jobs 4
// node tools/render.mjs --preview --scale 0.5 --step 2
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, FFMPEG, timeline, parseArgs, startServer, launch, openFilm, fmt } from './lib.mjs';
import { sourceHash, renderConfig, expectedChunks, chunkName, metaName, chunkStatus } from './cache.mjs';

const args = parseArgs(), tl = timeline(), preview = !!args.preview;
const config = renderConfig(tl, { scale: Number(args.scale || (preview ? 0.5 : 1)), step: Number(args.step || (preview ? 2 : 1)) });
const { width: W, height: H, scale, step } = config;
const jobs = Number(args.jobs || 2);
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) throw new Error('jobs must be an integer from 1 to 16');
if (!preview && (scale !== 1 || step !== 1)) throw new Error('use --preview for reduced resolution or frame rate');
const outDir = path.resolve(ROOT, args.out || path.join('out', preview ? 'preview' : 'chunks'));
fs.mkdirSync(outDir, { recursive: true });
let chunks = expectedChunks(tl);
const overlaps = (c, a, b) => c.from / tl.fps < b && c.to / tl.fps > a;
if (args.shots) {
  const ids = String(args.shots).split(',');
  for (const id of ids) if (!tl.shots.some((s) => s.id === id)) throw new Error(`unknown shot ${id}`);
  const ranges = tl.shots.filter((s) => ids.includes(s.id)).map((s) => [s.start, s.end]);
  chunks = chunks.filter((c) => ranges.some(([a, b]) => overlaps(c, a, b)));
}
if (args.from !== undefined || args.to !== undefined) {
  const a = Number(args.from ?? 0), b = Number(args.to ?? tl.duration);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > tl.duration || a >= b) throw new Error('invalid render time range');
  chunks = chunks.filter((c) => overlaps(c, a, b));
}
if (!args.force) chunks = chunks.filter((c) => !chunkStatus(outDir, c, config).valid);
if (!chunks.length) { console.log('all requested chunks match the current source'); process.exit(0); }
console.log(`rendering ${chunks.length} chunks with ${jobs} jobs, scale ${scale}, step ${step}; source ${config.sourceHash.slice(0, 12)}`);
const queue = [...chunks], t0 = Date.now();
let framesDone = 0, cancelled = false;
const framesTotal = chunks.reduce((n, c) => n + (c.to - c.from) / step, 0);

async function worker(w) {
  let server, browser, ff, encoderError, expectedFrame;
  try {
    server = await startServer(0, async (i, buf) => {
      if (encoderError) throw encoderError;
      if (!ff || i !== expectedFrame || buf?.length !== W * H * 4) throw new Error(`unexpected frame ${i}, expected ${expectedFrame}`);
      await new Promise((resolve, reject) => ff.stdin.write(buf, (e) => e ? reject(e) : resolve()));
      expectedFrame += step;
    });
    const port = server.address().port;
    const launched = await launch({ width: W, height: H });
    browser = launched.browser;
    const page = launched.page;
    await openFilm(page, port, `render=1&scale=${scale}`);
    while (queue.length && !cancelled) {
      const c = queue.shift(), file = path.join(outDir, chunkName(c)), tmp = file + '.part.mkv';
      const meta = path.join(outDir, metaName(c));
      expectedFrame = c.from; encoderError = null;
      ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(tl.fps / step), '-i', '-',
        '-vf', 'vflip', '-c:v', 'libx264', '-preset', preview ? 'veryfast' : 'medium', '-crf', preview ? '20' : '8', '-pix_fmt', preview ? 'yuv420p' : 'yuv444p', '-g', '48', tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
      const done = new Promise((resolve, reject) => {
        ff.once('error', reject);
        ff.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      });
      // Keep failures observed even while the browser is preparing its next frame.
      done.catch((e) => { encoderError = e; });
      ff.stdin.on('error', (e) => { encoderError = e; });
      const c0 = Date.now();
      for (let f = c.from; f < c.to; f += step) {
        if (cancelled) throw new Error('render cancelled after another worker failed');
        if (encoderError) throw encoderError;
        await page.evaluate(async ({ f, url }) => { await window.FILM.renderFrame(f); await window.FILM.sendFrame(f, url); }, { f, url: `http://127.0.0.1:${port}/frame` });
        framesDone++;
        if (framesDone % 24 === 0) {
          const elapsed = (Date.now() - t0) / 1000;
          console.log(`[w${w}] ${(f / tl.fps).toFixed(1)}s ${framesDone}/${framesTotal}, ETA ${fmt(elapsed / framesDone * (framesTotal - framesDone))}`);
        }
      }
      ff.stdin.end();
      await done; ff = null;
      if (expectedFrame !== c.to) throw new Error('incomplete frame delivery');
      if (sourceHash() !== config.sourceHash) throw new Error('source changed during rendering; rerun after edits finish');
      const bytes = fs.statSync(tmp).size;
      fs.writeFileSync(meta + '.part', JSON.stringify({ ...config, ...c, frames: (c.to - c.from) / step, bytes, complete: true }, null, 2));
      fs.renameSync(tmp, file);
      fs.renameSync(meta + '.part', meta);
      console.log(`[w${w}] chunk ${c.k} done in ${fmt((Date.now() - c0) / 1000)}`);
    }
  } catch (e) { cancelled = true; throw e; }
  finally {
    if (ff) { ff.stdin.destroy(); ff.kill('SIGTERM'); }
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }
}
const results = await Promise.allSettled(Array.from({ length: Math.min(jobs, chunks.length) }, (_, i) => worker(i)));
const failure = results.find((r) => r.status === 'rejected');
if (failure) throw failure.reason;
console.log(`all done in ${fmt((Date.now() - t0) / 1000)}`);
