// Cheap preflight: catch interrupted timeline migrations before a long render.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, timeline } from './lib.mjs';
const tl = timeline(), failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
check(Number.isInteger(tl.fps) && tl.fps > 0, 'invalid frame rate');
check(tl.duration > 0 && Number.isInteger(tl.duration * tl.fps), 'duration must end on a frame');
const ids = new Set();
let end = 0;
for (const shot of tl.shots) {
  check(!ids.has(shot.id), `duplicate shot ${shot.id}`); ids.add(shot.id);
  check(shot.start === end && shot.end > shot.start, `gap, overlap or inverted range at ${shot.id}`);
  check(fs.existsSync(path.join(ROOT, 'src/shots', shot.module)), `missing module for ${shot.id}`);
  end = shot.end;
}
check(end === tl.duration, 'shots do not cover the full duration');
for (const [name, value] of Object.entries(tl.cues)) check(Number.isFinite(value) && value >= 0 && value <= tl.duration, `invalid cue ${name}`);
for (const card of tl.cards) check(card.in >= 0 && card.out > card.in && card.out <= tl.duration, `invalid card ${card.id}`);
const question = tl.cards.find((c) => c.id === 'c4b'), black = tl.shots.find((s) => s.id === 'S18');
check(black?.start === tl.cues.cut_black, 'climax cut must coincide with S18');
check(question?.in === tl.cues.cursor_end && question.in > tl.cues.cut_black, 'question must replace the isolated cursor after the cut');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const sources = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'audio'))].filter((f) => /\.(js|py)$/.test(f));
for (const file of sources) {
  const text = fs.readFileSync(file, 'utf8'), name = path.relative(ROOT, file);
  const refs = [...text.matchAll(/\b(?:cue|C)\(\s*['"]([^'"]+)['"]|\bC\[['"]([^'"]+)['"]\]/g)].map((m) => m[1] || m[2]);
  for (const ref of new Set(refs)) check(ref in tl.cues, `${name}: missing cue ${ref}`);
  for (const m of text.matchAll(/\bshots\[['"]([^'"]+)['"]\]/g)) check(tl.shots.some((s) => s.name === m[1]), `${name}: missing named shot ${m[1]}`);
  if (file.endsWith('.js')) {
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (e) { failures.push(`${name}: ${e.stderr}`); }
    for (const m of text.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) check(fs.existsSync(path.resolve(path.dirname(file), m[1])), `${name}: missing import ${m[1]}`);
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`preflight passed: ${tl.duration}s, ${tl.duration * tl.fps} frames, ${tl.shots.length} shots, ${sources.length} source files`);
