// Build a self-contained review/export page. No server or external requests are required.
// Usage: node tools/portable.mjs [--no-audio] [--audio out/score.wav] [--out out/XIN_codex_portable.html]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyAudio } from './cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--' + name + ' requires a value');
  return args[i + 1];
};
const output = path.resolve(ROOT, option('out', 'out/XIN_codex_portable.html'));
const timeline = JSON.parse(await fs.readFile(path.join(ROOT, 'timeline.json'), 'utf8'));
timeline.credit ||= { word: 'ASTRA' };
try {
  Object.assign(timeline.credit, JSON.parse(await fs.readFile(path.join(ROOT, 'credit.local.json'), 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const sources = {};
const resolveModule = (from, spec) => {
  if (spec === 'three') return 'film/node_modules/three/build/three.module.js';
  if (!spec.startsWith('.')) throw new Error('Unsupported module dependency: ' + spec);
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (target.startsWith('../')) throw new Error('Module escapes project: ' + spec);
  return 'film/' + target;
};
async function addModule(file) {
  let text = await fs.readFile(path.join(ROOT, file), 'utf8');
  text = text.replace(/^(\s*(?:import|export)\s+[^\n]*?\sfrom\s*)(['"])([^'"]+)\2/gm,
    (_, prefix, quote, spec) => prefix + quote + resolveModule(file, spec) + quote);
  text = text.replace(/^(\s*import\s*)(['"])([^'"]+)\2/gm,
    (_, prefix, quote, spec) => prefix + quote + resolveModule(file, spec) + quote);
  if (file === 'src/engine/engine.js') {
    const original = 'import(`../shots/${path}`)';
    if (!text.includes(original)) throw new Error('Engine module loader changed; update portable bundler.');
    text = text.replace(original, "import('film/src/shots/' + path)");
  }
  sources['film/' + file] = text;
}
async function walk(dir) {
  const entries = await fs.readdir(path.join(ROOT, dir), { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.posix.join(dir, e.name);
    if (e.isDirectory()) await walk(file);
    else if (file.endsWith('.js') && file !== 'src/main.js') await addModule(file);
  }
}
await walk('src');
await addModule('node_modules/three/build/three.module.js');
await addModule('node_modules/three/build/three.core.js');
// Fail at build time if a static dependency did not make it into this page.
for (const [name, source] of Object.entries(sources)) {
  for (const m of source.matchAll(/\bfrom\s+['"](film\/[^'"]+)['"]/g)) {
    if (!sources[m[1]]) throw new Error(name + ': missing dependency ' + m[1]);
  }
}

const glyphs = new Set([...JSON.stringify(timeline), ...Object.values(sources).join('')].map(c => c.codePointAt(0)));
const rangeUsed = (range) => !range || range.split(',').some(token => {
  const m = token.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
  if (!m) throw new Error('Unsupported font unicode range: ' + token);
  const lo = parseInt(m[1].replaceAll('?', '0'), 16);
  const hi = parseInt(m[2] || m[1].replaceAll('?', 'F'), 16);
  for (const cp of glyphs) if (cp >= lo && cp <= hi) return true;
  return false;
});
const fontNotes = new Set();
const fontURLs = new Map();
const htmlSource = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
let fontCSS = '';
for (const m of htmlSource.matchAll(/<link\s+[^>]*href="(node_modules\/@fontsource\/[^"<>]+\.css)"[^>]*>/g)) {
  const cssPath = path.join(ROOT, m[1]);
  const css = await fs.readFile(cssPath, 'utf8');
  if (css.includes('LOCAL PREVIEW FALLBACK')) fontNotes.add('字体为本机预览替代：宋体 / 黑体 / Georgia / JetBrains Mono。正式出片请安装仓库指定字体后重新打包。');
  for (const rule of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const range = rule[1].match(/unicode-range:\s*([^;]+)/)?.[1];
    if (!rangeUsed(range)) continue;
    let face = rule[0];
    for (const url of [...face.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)]) {
      if (/^(?:https?:|\/\/|data:)/i.test(url[2])) throw new Error('Font must be a local file: ' + url[2]);
      const asset = path.resolve(path.dirname(cssPath), url[2]);
      if (!asset.startsWith(path.join(ROOT, 'node_modules') + path.sep)) throw new Error('Font escapes dependencies: ' + asset);
      if (!fontURLs.has(asset)) {
        const bytes = await fs.readFile(asset);
        const mime = asset.endsWith('.woff2') ? 'font/woff2' : asset.endsWith('.woff') ? 'font/woff' : 'font/ttf';
        fontURLs.set(asset, 'data:' + mime + ';base64,' + bytes.toString('base64'));
      }
      face = face.replace(url[0], 'url("' + fontURLs.get(asset) + '")');
    }
    fontCSS += face + '\n';
  }
}
const installedThree = JSON.parse(await fs.readFile(path.join(ROOT, 'node_modules/three/package.json'), 'utf8')).version;
const lockedThree = JSON.parse(await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8')).packages?.['node_modules/three']?.version;
if (lockedThree && installedThree !== lockedThree) fontNotes.add('此预览使用 Three.js ' + installedThree + '；仓库锁定版本为 ' + lockedThree + '。');

let audio = null;
if (!args.includes('--no-audio')) {
  const audioSource = path.resolve(ROOT, option('audio', 'out/score.wav'));
  const exists = await fs.stat(audioSource).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
  if (exists) {
    verifyAudio(audioSource, timeline, ROOT);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const m4a = path.join(path.dirname(output), 'portable-audio.m4a');
    const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', audioSource, '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', m4a], { encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new Error('Audio encoding failed: ' + (r.error?.message || r.stderr));
    audio = { mime: 'audio/mp4', base64: (await fs.readFile(m4a)).toString('base64') };
  } else if (args.includes('--audio')) throw new Error('Requested audio does not exist: ' + audioSource);
}

// This module is embedded verbatim. UI operations are deliberately serialized so
// a seek or export cannot race an in-flight scene render.
const entry = String.raw`
import { Engine } from 'film/src/engine/engine.js';
import { loadFonts } from 'film/src/engine/overlay.js';
import { LABEL_TEXT } from 'film/src/shots/common/labels.js';
const { timeline, audio: audioData, notes } = window.PORTABLE;
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const fmt = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(2).padStart(5, '0');
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
const lastFrame = Math.round(timeline.duration * timeline.fps) - 1;
let engine, engineScale, playing = false, exporting = false, cancelled = false;
let currentTime = 0, lastDownload, renderWork = Promise.resolve(), audio;
function serialize(fn) {
  const task = renderWork.then(fn);
  renderWork = task.catch(() => {});
  return task;
}
const report = e => { console.error(e); status('出错：' + (e?.message || e)); };
window.addEventListener('error', e => report(e.error || e.message));
window.addEventListener('unhandledrejection', e => report(e.reason));
function enabled() {
  for (const id of ['play','render','png','segment','whole','scale','time','from','to']) $(id).disabled = exporting;
  $('cancel').disabled = !exporting;
  $('play').textContent = playing ? '暂停' : '播放';
}
function chosenScale() {
  const value = Number($('scale').value);
  if (![0.25, 0.5, 0.75, 1].includes(value)) throw new Error('请选择有效的渲染比例。');
  return value;
}
async function ensureEngine(scale) {
  if (engine && engineScale === scale) return;
  if (engine) {
    for (const module of engine.modules.values()) module.dispose?.();
    for (const target of engine.targets.values()) target.dispose();
    engine.mixRT.dispose(); engine.ovTex.dispose();
    engine.renderer.dispose(); engine.renderer.forceContextLoss();
  }
  const canvas = document.createElement('canvas'); canvas.id = 'film';
  $('screen').replaceChildren(canvas);
  engine = new Engine(canvas, timeline, { scale }); engineScale = scale;
  window.FILM.engine = engine;
}
async function renderAt(seconds, scale = chosenScale()) {
  if (!Number.isFinite(seconds)) throw new Error('时间必须是秒数。');
  await ensureEngine(scale);
  const frame = Math.max(0, Math.min(lastFrame, Math.round(seconds * timeline.fps)));
  await engine.renderFrame(frame);
  currentTime = frame / timeline.fps;
  $('time').value = currentTime.toFixed(3);
  $('clock').textContent = fmt(currentTime) + ' / ' + fmt(timeline.duration);
  return frame;
}
function pause() { playing = false; audio?.pause(); enabled(); }
async function play() {
  if (playing) return pause();
  if (exporting) return;
  playing = true; enabled();
  const start = performance.now(), offset = currentTime;
  if (audio) { audio.currentTime = offset; try { await audio.play(); } catch { status('声音未启动，可再次点击播放。'); } }
  try {
    while (playing) {
      const seconds = audio && !audio.paused ? audio.currentTime : offset + (performance.now() - start) / 1000;
      if (seconds >= timeline.duration) { pause(); break; }
      await serialize(() => renderAt(seconds));
      await new Promise(requestAnimationFrame);
    }
  } catch (e) { pause(); report(e); }
}
function download(blob, filename) {
  if (lastDownload) URL.revokeObjectURL(lastDownload);
  lastDownload = URL.createObjectURL(blob);
  const link = $('download'); link.href = lastDownload; link.download = filename;
  link.textContent = '下载 ' + filename; link.hidden = false;
  link.click();
}
async function savePNG() {
  pause(); await renderWork;
  await serialize(() => renderAt(Number($('time').value)));
  const blob = await new Promise(resolve => engine.canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG 导出失败。');
  download(blob, 'XIN_codex_' + currentTime.toFixed(3) + '.png');
  status('静帧已生成：' + fmt(currentTime));
}
function ivfHeader(width, height, count) {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  bytes.set([68,75,73,70], 0); // DKIF
  view.setUint16(4, 0, true); view.setUint16(6, 32, true);
  bytes.set([86,80,57,48], 8); // VP90
  view.setUint16(12, width, true); view.setUint16(14, height, true);
  view.setUint32(16, timeline.fps, true); view.setUint32(20, 1, true);
  view.setUint32(24, count, true); view.setUint32(28, 0, true);
  return bytes;
}
async function exportVideo(from, to) {
  if (exporting) return;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > timeline.duration || to <= from) throw new Error('请输入有效范围：0 ≤ 起点 < 终点 ≤ ' + timeline.duration + '。');
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) throw new Error('此浏览器未提供 WebCodecs 视频导出，请使用较新的 Chrome。静帧与预览仍可使用。');
  pause(); await renderWork;
  const scale = chosenScale();
  await ensureEngine(scale);
  const first = Math.round(from * timeline.fps), end = Math.min(lastFrame + 1, Math.round(to * timeline.fps));
  const total = end - first;
  if (total < 1) throw new Error('区间至少需要一帧。');
  const config = { codec: 'vp09.00.41.08', width: engine.W, height: engine.H, framerate: timeline.fps,
    bitrate: Math.max(1000000, Math.round(engine.W * engine.H * timeline.fps * 0.30)), latencyMode: 'quality' };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error('此浏览器不支持当前分辨率的 VP9 编码。请降低比例，或使用仓库的离线渲染命令。');
  const chunks = []; let count = 0, encodedBytes = 0, failure;
  const encoder = new VideoEncoder({
    output(chunk) {
      const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
      const header = new Uint8Array(12), view = new DataView(header.buffer);
      view.setUint32(0, bytes.length, true);
      view.setBigUint64(4, BigInt(Math.round(chunk.timestamp * timeline.fps / 1000000)), true);
      chunks.push(header, bytes); count++; encodedBytes += bytes.length + 12;
    },
    error(error) { failure = error; }
  });
  encoder.configure(support.config);
  exporting = true; cancelled = false; enabled();
  $('progress').max = total; $('progress').value = 0;
  const started = performance.now();
  try {
    for (let i = 0; i < total; i++) {
      if (cancelled) break;
      if (failure) throw failure;
      await engine.renderFrame(first + i);
      const stamp = Math.round(i * 1000000 / timeline.fps);
      const frame = new VideoFrame(engine.canvas, { timestamp: stamp, duration: Math.round((i + 1) * 1000000 / timeline.fps) - stamp, alpha: 'discard' });
      try { encoder.encode(frame, { keyFrame: i % (timeline.fps * 2) === 0 }); } finally { frame.close(); }
      if (encoder.encodeQueueSize >= 6 || i % timeline.fps === timeline.fps - 1) await encoder.flush();
      $('progress').value = i + 1;
      currentTime = (first + i) / timeline.fps;
      $('clock').textContent = fmt(currentTime) + ' / ' + fmt(timeline.duration);
      const elapsed = (performance.now() - started) / 1000;
      status('逐帧导出 ' + (i + 1) + ' / ' + total + ' · ' + Math.round((i + 1) / total * 100) + '% · ' + elapsed.toFixed(0) + ' 秒 · ' + (encodedBytes / 1048576).toFixed(1) + ' MB');
      await yieldUI();
    }
    await encoder.flush();
    if (failure) throw failure;
    if (cancelled) { status('已取消。此次未完成的视频没有导出。'); return; }
    if (count !== total) throw new Error('编码帧数不符：' + count + ' / ' + total);
    const blob = new Blob([ivfHeader(engine.W, engine.H, count), ...chunks], { type: 'video/x-ivf' });
    const filename = 'XIN_codex_f' + String(first).padStart(6, '0') + '-' + String(end).padStart(6, '0') + '_' + engine.W + 'x' + engine.H + '.ivf';
    download(blob, filename);
    status('导出完成：' + count + ' 帧，' + (blob.size / 1048576).toFixed(1) + ' MB。IVF 为无声画面，可与 score.wav 合成为成片。');
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    exporting = false; enabled(); $('time').value = currentTime.toFixed(3);
  }
}
function action(fn) { return () => Promise.resolve().then(fn).catch(report); }
window.FILM = { timeline, get ready() { return Boolean(engine); },
  renderFrame(frame) { pause(); return serialize(() => renderAt(frame / timeline.fps)); },
  exportVideo, get exporting() { return exporting; } };
$('play').addEventListener('click', action(play));
$('render').addEventListener('click', action(() => { pause(); return serialize(() => renderAt(Number($('time').value))); }));
$('png').addEventListener('click', action(savePNG));
$('segment').addEventListener('click', action(() => exportVideo(Number($('from').value), Number($('to').value))));
$('whole').addEventListener('click', action(() => exportVideo(0, timeline.duration)));
$('cancel').addEventListener('click', () => { cancelled = true; status('正在停止…'); });
$('fullscreen').addEventListener('click', action(() => $('screen').requestFullscreen()));
$('scale').addEventListener('change', action(() => { pause(); return serialize(() => renderAt(currentTime)); }));
document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || exporting) return;
  if (e.code === 'Space') { e.preventDefault(); action(play)(); }
  if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') { e.preventDefault(); pause(); action(() => serialize(() => renderAt(currentTime + (e.code === 'ArrowRight' ? 5 : -5))))(); }
});
if (audioData) {
  const bytes = Uint8Array.from(atob(audioData.base64), c => c.charCodeAt(0));
  audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: audioData.mime })));
  audio.preload = 'auto';
  $('audioNote').textContent = '已内嵌配乐 · 点击播放开启声音';
} else $('audioNote').textContent = '静帧检查版 · 未内嵌配乐';
$('notes').textContent = notes.join(' ');
$('notes').hidden = notes.length === 0;
$('time').max = timeline.duration; $('from').max = timeline.duration; $('to').max = timeline.duration;
const params = new URLSearchParams(location.search);
if (params.has('t')) $('time').value = String(Number(params.get('t')) || 0);
if (params.has('scale') && [0.25,0.5,0.75,1].includes(Number(params.get('scale')))) $('scale').value = params.get('scale');
status('正在准备字形与画面…');
await loadFonts(timeline.cards.flatMap(c => [c.zh, c.en, c.zhSource || '', c.enSource || '']).concat([LABEL_TEXT, '芯心艹XINASTRA出品PRESENTS0123456789▍' + timeline.credit.word]));
await serialize(() => renderAt(Number($('time').value)));
enabled(); status('就绪 · 可输入秒数检查镜头，或播放全片');
`;
sources['film/portable-entry.js'] = entry;
const payload = { timeline, sources, audio, notes: [...fontNotes] };
const json = JSON.stringify(payload).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src blob: data:; font-src data:; media-src blob: data:; connect-src 'none'; worker-src blob:">
<title>芯 XIN · Codex 对比版</title>
<style>${fontCSS}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#080a0c;color:#e3dfd8;font:14px system-ui,sans-serif}body{padding:20px 28px 28px}header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:16px}h1{font-size:18px;font-weight:400;letter-spacing:.2em;margin:0}header small{color:#929b9e;font-size:12px}#screen{background:#000;display:grid;place-items:center;min-height:200px;aspect-ratio:1920/804;max-height:72vh;overflow:hidden}#screen canvas{display:block;max-width:100%;max-height:72vh;object-fit:contain}#screen:fullscreen{width:100vw;height:100vh;max-height:none}#screen:fullscreen canvas{max-width:100vw;max-height:100vh}nav,.exports{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:16px}button,input,select{font:inherit;color:inherit;background:#161b1e;border:1px solid #354047;border-radius:5px;padding:8px 12px}button{cursor:pointer}button:hover{border-color:#a4acae}button:disabled{opacity:.4;cursor:default}input{width:95px}label{color:#a7afb1;font-size:12px;display:flex;align-items:center;gap:7px}#clock{font:13px ui-monospace,monospace;color:#c3b394;margin-left:auto}progress{margin-top:14px;width:100%;height:5px;accent-color:#b9a178}#status{font-size:12px;color:#c2c9cb;min-height:18px;margin:8px 0}#download{display:inline-block;color:#e7c389;font-size:13px;margin-top:8px}#download[hidden]{display:none}#notes,.hint{font-size:11px;color:#849094;line-height:1.65;max-width:1000px}.exports{padding-top:12px;border-top:1px solid #252c30}b{font-weight:500;color:#cfbea2}@media(max-width:650px){body{padding:12px}header{align-items:flex-start;flex-direction:column;gap:6px}#clock{margin-left:0;width:100%}}
</style></head><body>
<header><h1>芯 XIN <small>CODEX 对比版</small></h1><small id="audioNote"></small></header>
<div id="screen" aria-label="影片画面"></div>
<nav aria-label="播放控制"><button id="play">播放</button><label>秒 <input id="time" type="number" min="0" step="0.041667" value="37.5"></label><button id="render">渲染该帧</button><button id="png">下载 PNG</button><label>比例 <select id="scale"><option value="0.25">25%</option><option value="0.5" selected>50%</option><option value="0.75">75%</option><option value="1">100%</option></select></label><button id="fullscreen">全屏</button><span id="clock"></span></nav>
<div class="exports"><label>起点 <input id="from" type="number" min="0" step="0.1" value="164"></label><label>终点 <input id="to" type="number" min="0" step="0.1" value="176"></label><button id="segment">逐帧导出短段</button><button id="whole">逐帧导出全片</button><button id="cancel" disabled>取消</button></div>
<progress id="progress" value="0" max="1"></progress><p id="status" role="status" aria-live="polite">正在载入…</p><a id="download" hidden></a>
<p class="hint">空格播放 / 暂停，方向键跳转 5 秒。逐帧导出不受实时播放速度影响，生成无声 VP9 / IVF 文件，保留当前比例；正式出片选择 <b>100%</b>，再与配乐合成。</p><p id="notes"></p>
<script id="portable-data" type="application/json">${json}</script>
<script>
try {
  window.PORTABLE = JSON.parse(document.getElementById('portable-data').textContent);
  const imports = {};
  for (const [name, source] of Object.entries(window.PORTABLE.sources)) imports[name] = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
  delete window.PORTABLE.sources;
  const map = document.createElement('script'); map.type = 'importmap'; map.textContent = JSON.stringify({imports}); document.head.appendChild(map);
  const entry = document.createElement('script'); entry.type = 'module'; entry.textContent = "import 'film/portable-entry.js';";
  entry.onerror = () => {document.getElementById('status').textContent = '模块载入失败，请使用支持 importmap 的较新 Chrome。';};
  document.body.appendChild(entry);
} catch (e) { document.getElementById('status').textContent = '载入失败：' + e.message; }
</script></body></html>`;
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, html);
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(html), modules: Object.keys(sources).length, embeddedAudio: Boolean(audio), fonts: fontURLs.size, notes: [...fontNotes] }, null, 2));
