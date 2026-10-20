// Assemble only complete chunks and a score matching the current timeline.
// node tools/build.mjs [--preview] [--silent] [--out out/XIN_codex.mp4]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, FFMPEG, FFPROBE, timeline, parseArgs } from './lib.mjs';
import { renderConfig, verifyChunks, verifyAudio, chunkName } from './cache.mjs';

const args = parseArgs(), tl = timeline(), preview = !!args.preview;
const config = renderConfig(tl, { scale: Number(args.scale || (preview ? 0.5 : 1)), step: Number(args.step || (preview ? 2 : 1)) });
const dir = path.resolve(ROOT, args.chunks || path.join('out', preview ? 'preview' : 'chunks'));
const chunks = verifyChunks(dir, tl, config);
const audio = path.join(ROOT, 'out', 'score.wav');
if (!args.silent) {
  verifyAudio(audio, tl);
  try {
    const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', audio], { encoding: 'utf8' }));
    if (Math.abs(Number(probe.format.duration) - tl.duration) > 0.01) throw new Error('audio file length does not match the timeline');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const list = path.join(dir, 'list.txt');
fs.writeFileSync(list, chunks.map((c) => `file '${chunkName(c)}'`).join('\n'));
const out = path.resolve(ROOT, args.out || path.join('out', preview ? 'XIN_codex_preview.mp4' : 'XIN_codex.mp4'));
fs.mkdirSync(path.dirname(out), { recursive: true });
const tmp = out.replace(/\.mp4$/, '') + '.part.mp4';
const crf = Number(args.crf || (preview ? 23 : 18));
if (!Number.isInteger(crf) || crf < 0 || crf > 51) throw new Error('crf must be an integer from 0 to 51');
const frameHeight = Math.ceil((config.width * 9 / 16) / 2) * 2;
const vf = `pad=${config.width}:${frameHeight}:0:(${frameHeight}-ih)/2:black,setsar=1`;
let credit = { word: 'ASTRA' };
if (fs.existsSync(path.join(ROOT, 'credit.local.json'))) credit = { ...credit, ...JSON.parse(fs.readFileSync(path.join(ROOT, 'credit.local.json'), 'utf8')) };
const a = ['-y', '-loglevel', 'error', '-stats', '-f', 'concat', '-safe', '0', '-i', list];
if (!args.silent) a.push('-i', audio);
a.push('-map', '0:v:0');
if (!args.silent) a.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '256k');
a.push('-vf', vf, '-c:v', 'libx264', '-preset', preview ? 'fast' : 'slow', '-crf', String(crf), '-tune', 'grain', '-pix_fmt', 'yuv420p',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart',
  '-metadata', 'title=芯 XIN — Codex cut', '-metadata', `artist=${credit.word}`, '-t', String(tl.duration), tmp);
execFileSync(FFMPEG, a, { stdio: 'inherit' });
fs.renameSync(tmp, out);
fs.writeFileSync(out.replace(/\.mp4$/, '.json'), JSON.stringify({ ...config, audio: !args.silent, title: '芯 XIN — Codex cut' }, null, 2));
console.log(`${out} ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
