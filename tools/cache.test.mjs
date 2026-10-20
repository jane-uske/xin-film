import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceHash, timelineHash, renderConfig, expectedChunks, chunkName, metaName, chunkStatus, verifyChunks, verifyAudio } from './cache.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'chunks'));
  const tl = { fps: 24, duration: 20, width: 1920, height: 804 };
  for (const [f, data] of Object.entries({ 'timeline.json': JSON.stringify(tl), 'index.html': '<canvas/>', 'package-lock.json': '{}', 'src/scene.js': 'export const value=1;' })) fs.writeFileSync(path.join(root, f), data);
  const config = renderConfig(tl, {}, root), dir = path.join(root, 'chunks');
  const save = (c) => {
    fs.writeFileSync(path.join(dir, chunkName(c)), 'fake-encoded-data');
    fs.writeFileSync(path.join(dir, metaName(c)), JSON.stringify({ ...config, ...c, frames: c.to - c.from, bytes: 17, complete: true }));
  };
  return { root, dir, tl, config, save };
}

test('resume requires a matching source snapshot and complete chunk', (t) => {
  const { root, dir, tl, config, save } = fixture(t), c = expectedChunks(tl)[0];
  assert.equal(chunkStatus(dir, c, config).valid, false);
  save(c); assert.equal(chunkStatus(dir, c, config).valid, true);
  fs.writeFileSync(path.join(root, 'src/scene.js'), 'export const value=2;');
  assert.notEqual(sourceHash(root), config.sourceHash);
  assert.equal(chunkStatus(dir, c, renderConfig(tl, {}, root)).valid, false);
  fs.writeFileSync(path.join(dir, chunkName(c)), 'truncated');
  assert.equal(chunkStatus(dir, c, config).valid, false);
});

test('build rejects missing indices and stale leftover v1 chunks', (t) => {
  const { dir, tl, config, save } = fixture(t), chunks = expectedChunks(tl);
  save(chunks[0]); assert.throws(() => verifyChunks(dir, tl, config), /c001/);
  save(chunks[1]); assert.equal(verifyChunks(dir, tl, config).length, 2);
  fs.writeFileSync(path.join(dir, 'c002.mkv'), 'old');
  assert.throws(() => verifyChunks(dir, tl, config), /unexpected render chunks/);
});

test('preview parameters and credits invalidate cached renders', (t) => {
  const { root, dir, tl, config, save } = fixture(t), c = expectedChunks(tl)[0];
  save(c);
  assert.equal(chunkStatus(dir, c, renderConfig(tl, { scale: 0.5, step: 2 }, root)).valid, false);
  fs.writeFileSync(path.join(root, 'credit.local.json'), '{"word":"XIN"}');
  assert.notEqual(sourceHash(root), config.sourceHash);
  assert.throws(() => renderConfig(tl, { step: 7 }, root), /step/);
});

test('audio must belong to the current timeline and have the full duration', (t) => {
  const { root, tl } = fixture(t), audio = path.join(root, 'score.wav');
  assert.throws(() => verifyAudio(audio, tl, root), /missing/);
  const header = Buffer.alloc(44), bytes = 960000 * 6;
  header.write('RIFF', 0); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(48000 * 6, 28); header.writeUInt16LE(6, 32); header.writeUInt16LE(24, 34);
  header.write('data', 36); header.writeUInt32LE(bytes, 40);
  fs.writeFileSync(audio, header); fs.truncateSync(audio, 44 + bytes);
  const metadata = { timelineHash: timelineHash(root), duration: 20, sampleRate: 48000, frames: 960000 };
  const write = (meta) => fs.writeFileSync(path.join(root, 'score.meta.json'), JSON.stringify(meta));
  write(metadata); assert.equal(verifyAudio(audio, tl, root).duration, 20);
  write({ ...metadata, timelineHash: 'old' }); assert.throws(() => verifyAudio(audio, tl, root), /stale/);
  write({ ...metadata, frames: 950000 }); assert.throws(() => verifyAudio(audio, tl, root), /duration/);
  write(metadata); fs.truncateSync(audio, 44); assert.throws(() => verifyAudio(audio, tl, root), /truncated/);
});
