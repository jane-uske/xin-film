// 成片：拼接所有渲染块 -> 加 2.39:1 遮幅到 1920×1080 -> 混入配乐 -> out/XIN.mp4
//   node tools/build.mjs [--crf 18] [--preview]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, timeline, parseArgs } from './lib.mjs';

const args = parseArgs();
const tl = timeline();
const preview = !!args.preview;
const dir = path.join(ROOT, 'out', preview ? 'preview' : 'chunks');
const chunks = fs.readdirSync(dir).filter((f) => /^c\d{3}\.mkv$/.test(f)).sort();
const expected = Math.ceil((tl.duration * tl.fps) / 240);
if (chunks.length !== expected) { console.error(`expected ${expected} chunks in ${dir}, found ${chunks.length}`); process.exit(1); }
const list = path.join(dir, 'list.txt');
fs.writeFileSync(list, chunks.map((f) => `file '${f}'`).join('\n'));
const audio = path.join(ROOT, 'out', 'score.wav');
const out = path.join(ROOT, 'out', preview ? 'XIN_preview.mp4' : 'XIN.mp4');
const crf = String(args.crf || (preview ? 23 : 18));
const vf = preview ? 'pad=960:540:0:(540-ih)/2:black,setsar=1' : 'pad=1920:1080:0:(1080-ih)/2:black,setsar=1';
const a = ['-y', '-loglevel', 'error', '-stats', '-f', 'concat', '-safe', '0', '-i', list];
if (fs.existsSync(audio)) a.push('-i', audio);
a.push('-map', '0:v:0');
if (fs.existsSync(audio)) a.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '256k');
a.push('-vf', vf, '-c:v', 'libx264', '-preset', preview ? 'fast' : 'slow', '-crf', crf, '-tune', 'grain', '-pix_fmt', 'yuv420p',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart',
  '-metadata', 'title=芯 XIN', '-metadata', 'artist=ASTRA', '-t', String(tl.duration), out);
execFileSync('ffmpeg', a, { stdio: 'inherit' });
const size = fs.statSync(out).size / 1e6;
console.log(`${out}  ${size.toFixed(1)} MB`);
