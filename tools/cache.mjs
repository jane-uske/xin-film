// A render belongs to its source snapshot, never just to a filename.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './lib.mjs';

export const CHUNK = 240;
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const timelineHash = (root = ROOT) => sha256(fs.readFileSync(path.join(root, 'timeline.json')));

export function sourceHash(root = ROOT) {
  const files = ['timeline.json', 'index.html', 'package-lock.json'];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const name = path.posix.join(dir, ent.name);
      if (ent.isDirectory()) walk(name); else if (ent.isFile()) files.push(name);
    }
  };
  walk('src');
  if (fs.existsSync(path.join(root, 'credit.local.json'))) files.push('credit.local.json');
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}

export function renderConfig(tl, { scale = 1, step = 1 } = {}, root = ROOT) {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 2) throw new Error('scale must be in (0, 2]');
  if (!Number.isInteger(step) || step < 1 || CHUNK % step || tl.fps % step) throw new Error('step must divide both 240 frames and timeline fps');
  const width = Math.round(tl.width * scale), height = Math.round(tl.height * scale);
  if (width % 2 || height % 2) throw new Error('render dimensions must be even');
  const total = Math.round(tl.duration * tl.fps);
  if (total % step) throw new Error('frame step must divide the full film length');
  return { version: 1, sourceHash: sourceHash(root), timelineHash: timelineHash(root), width, height, scale, step, fps: tl.fps, duration: tl.duration, total };
}

export function expectedChunks(tl) {
  const total = Math.round(tl.duration * tl.fps);
  return Array.from({ length: Math.ceil(total / CHUNK) }, (_, k) => ({ k, from: k * CHUNK, to: Math.min(total, (k + 1) * CHUNK) }));
}

export const chunkName = ({ k }) => `c${String(k).padStart(3, '0')}.mkv`;
export const metaName = (c) => chunkName(c).replace(/\.mkv$/, '.json');

export function chunkStatus(dir, c, config) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, metaName(c)), 'utf8'));
    for (const [key, value] of Object.entries(config)) if (meta[key] !== value) return { valid: false, reason: `${key} differs` };
    if (meta.from !== c.from || meta.to !== c.to || meta.frames !== (c.to - c.from) / config.step) return { valid: false, reason: 'frame range differs' };
    const bytes = fs.statSync(path.join(dir, chunkName(c))).size;
    if (!bytes || bytes !== meta.bytes || !meta.complete) return { valid: false, reason: 'incomplete chunk' };
    return { valid: true, meta };
  } catch (e) { return { valid: false, reason: e.code === 'ENOENT' ? 'missing chunk or metadata' : e.message }; }
}

export function verifyChunks(dir, tl, config) {
  const chunks = expectedChunks(tl);
  const names = new Set(chunks.map(chunkName));
  const extras = fs.readdirSync(dir).filter((f) => /^c\d+\.mkv$/.test(f) && !names.has(f));
  if (extras.length) throw new Error(`unexpected render chunks: ${extras.join(', ')}; use a clean output directory`);
  for (const c of chunks) {
    const status = chunkStatus(dir, c, config);
    if (!status.valid) throw new Error(`${chunkName(c)}: ${status.reason}; render this source snapshot before building`);
  }
  return chunks;
}

export function verifyAudio(audio, tl, root = ROOT) {
  if (!fs.existsSync(audio)) throw new Error('score.wav is missing; generate the score first, or use --silent for an intentional picture-only check');
  const metaFile = audio.replace(/\.wav$/, '.meta.json');
  if (!fs.existsSync(metaFile)) throw new Error('score.meta.json is missing; regenerate the score for this timeline');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  if (meta.timelineHash !== timelineHash(root)) throw new Error('score timeline is stale; regenerate audio');
  if (!Number.isFinite(meta.duration) || !Number.isFinite(meta.sampleRate) || meta.sampleRate <= 0 || Math.abs(meta.duration - tl.duration) > 1 / meta.sampleRate || meta.frames !== Math.round(tl.duration * meta.sampleRate)) throw new Error('score duration does not match timeline');
  const wav = wavInfo(audio);
  if (wav.sampleRate !== meta.sampleRate || wav.frames !== meta.frames || wav.channels !== 2) throw new Error('score WAV header does not match metadata');
  return meta;
}

// Validate the actual file even on machines without ffprobe. Read headers only.
export function wavInfo(file) {
  const fd = fs.openSync(file, 'r'), bytes = fs.fstatSync(fd).size;
  const read = (offset, count) => {
    const b = Buffer.alloc(count);
    if (fs.readSync(fd, b, 0, count, offset) !== count) throw new Error('truncated WAV');
    return b;
  };
  try {
    const riff = read(0, 12);
    if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE' || riff.readUInt32LE(4) + 8 !== bytes) throw new Error('invalid or truncated WAV');
    let sampleRate, blockAlign, channels, dataBytes;
    for (let offset = 12; offset + 8 <= bytes;) {
      const header = read(offset, 8), kind = header.toString('ascii', 0, 4), size = header.readUInt32LE(4);
      if (offset + 8 + size > bytes) throw new Error('truncated WAV chunk');
      if (kind === 'fmt ') {
        if (size < 16) throw new Error('invalid WAV format');
        const f = read(offset + 8, 16);
        if (![1, 3].includes(f.readUInt16LE(0))) throw new Error('unsupported WAV format');
        channels = f.readUInt16LE(2); sampleRate = f.readUInt32LE(4); blockAlign = f.readUInt16LE(12);
      } else if (kind === 'data') dataBytes = size;
      offset += 8 + size + size % 2;
    }
    if (!blockAlign || !sampleRate || dataBytes === undefined || dataBytes % blockAlign) throw new Error('incomplete WAV header');
    return { sampleRate, channels, frames: dataBytes / blockAlign };
  } finally { fs.closeSync(fd); }
}
