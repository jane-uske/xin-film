// 入口。三种模式：
//   ?render=1           供 tools/render.mjs 驱动的逐帧离线渲染
//   ?t=45.5             渲染单帧静帧
//   （默认）            浏览器实时预览，带配乐，空格暂停，←/→ 跳 5 秒
import { Engine } from './engine/engine.js';
import { loadFonts, TYPE } from './engine/overlay.js';
import { LABEL_TEXT } from './shots/common/labels.js';

const q = new URLSearchParams(location.search);
const scale = parseFloat(q.get('scale') || '1');
// 对比用：?typecard=1&typehud=1 恢复旧字号
if (q.has('typecard')) TYPE.card = parseFloat(q.get('typecard'));
if (q.has('typehud')) TYPE.hud = parseFloat(q.get('typehud'));
if (q.has('zhweight')) TYPE.zhWeight = parseInt(q.get('zhweight'), 10);

const timeline = await (await fetch('timeline.json')).json();
// 出品方署名放在本地配置（不进仓库），缺省为 ASTRA
timeline.credit = { word: 'ASTRA' };
try { const r = await fetch('credit.local.json'); if (r.ok) Object.assign(timeline.credit, await r.json()); } catch (e) { /* 无本地配置 */ }
const texts = timeline.cards.flatMap((c) => [c.zh, c.en, c.zhSource || '', c.enSource || '']).concat([
  '芯心艹XINASTRA出品PRESENTS壹贰叁·热HEATWICKMIND0123456789,.KWMGBt/s→…' + timeline.credit.word,
  LABEL_TEXT,
]);
await loadFonts(texts);

const canvas = document.getElementById('film');
const engine = new Engine(canvas, timeline, { scale });

window.FILM = {
  engine,
  timeline,
  async renderFrame(frame) { return engine.renderFrame(frame); },
  // 渲染后把原始 RGBA 像素 POST 给本地服务，由它写入 ffmpeg
  async sendFrame(frame, url) {
    const px = engine.readPixels();
    const res = await fetch(`${url}?i=${frame}`, { method: 'POST', body: px });
    if (!res.ok) throw new Error(`sink ${res.status}`);
    return true;
  },
};

if (q.has('render')) {
  window.FILM.ready = true;
} else if (q.has('t')) {
  await engine.renderFrame(Math.round(parseFloat(q.get('t')) * timeline.fps));
  window.FILM.ready = true;
} else {
  // 实时预览
  const hud = document.getElementById('hud');
  const audio = new Audio('out/score.wav');
  const lastTime = (Math.round(timeline.duration * timeline.fps) - 1) / timeline.fps;
  const bound = (s) => Math.max(0, Math.min(lastTime, Number.isFinite(s) ? s : 0));
  let t0 = performance.now(), offset = bound(parseFloat(q.get('from') || '0')), playing = true, busy = false;
  let soundOn = false, audioMissing = false;
  // 一旦声音开启，以音轨为时钟；慢帧只影响预览流畅度，不让声画越走越远。
  const now = () => soundOn && !audio.paused ? audio.currentTime : (playing ? offset + (performance.now() - t0) / 1000 : offset);
  const seek = (s) => { offset = bound(s); t0 = performance.now(); if (soundOn) audio.currentTime = offset; };
  const startSound = async () => {
    audio.currentTime = bound(now());
    try { await audio.play(); soundOn = true; }
    catch { soundOn = false; }
  };
  audio.addEventListener('error', () => {
    offset = bound(now()); t0 = performance.now(); soundOn = false; audioMissing = true;
  });
  audio.addEventListener('ended', () => { offset = lastTime; playing = false; });
  addEventListener('keydown', (e) => {
    if (['Space', 'ArrowRight', 'ArrowLeft', 'Home'].includes(e.code)) e.preventDefault();
    if (e.code === 'Space') {
      if (playing) { offset = bound(now()); playing = false; audio.pause(); }
      else { if (offset >= lastTime) offset = 0; t0 = performance.now(); playing = true; if (soundOn) startSound(); }
    }
    if (e.code === 'ArrowRight') seek(now() + 5);
    if (e.code === 'ArrowLeft') seek(now() - 5);
    if (e.code === 'Home') seek(0);
  });
  addEventListener('click', () => { if (!soundOn && playing && !audioMissing) startSound(); });
  const loop = async () => {
    if (!busy) {
      busy = true;
      try {
        const T = bound(now());
        if (T >= lastTime) { offset = lastTime; playing = false; audio.pause(); }
        await engine.renderFrame(Math.floor(T * timeline.fps));
        hud.textContent = `${T.toFixed(2)}s / ${timeline.duration}s  ·  ${audioMissing ? '配乐尚未生成' : soundOn ? '声画同步' : '点击开启声音'}  ·  空格暂停  ·  ←/→ 跳转  ·  Home 从头播放`;
      } finally { busy = false; }
    }
    requestAnimationFrame(loop);
  };
  loop();
}

