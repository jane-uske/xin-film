// 入口。三种模式：
//   ?render=1           供 tools/render.mjs 驱动的逐帧离线渲染
//   ?t=45.5             渲染单帧静帧
//   （默认）            浏览器实时预览，带配乐，空格暂停，←/→ 跳 5 秒
import { Engine } from './engine/engine.js';
import { loadFonts } from './engine/overlay.js';

const q = new URLSearchParams(location.search);
const scale = parseFloat(q.get('scale') || '1');

const timeline = await (await fetch('timeline.json')).json();
// 出品方署名放在本地配置（不进仓库），缺省为 ASTRA
timeline.credit = { word: 'ASTRA' };
try { const r = await fetch('credit.local.json'); if (r.ok) Object.assign(timeline.credit, await r.json()); } catch (e) { /* 无本地配置 */ }
const texts = timeline.cards.flatMap((c) => [c.zh, c.en, c.zhSource || '', c.enSource || '']).concat([
  '芯心艹XINASTRA出品PRESENTS壹贰叁·热HEATWICKMIND0123456789,.KWMGBt/s→…' + timeline.credit.word,
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
  let t0 = performance.now(), offset = parseFloat(q.get('from') || '0'), playing = true, busy = false;
  const now = () => (playing ? offset + (performance.now() - t0) / 1000 : offset);
  const seek = (s) => { offset = Math.max(0, Math.min(timeline.duration, s)); t0 = performance.now(); audio.currentTime = offset; };
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { if (playing) { offset = now(); audio.pause(); } else { t0 = performance.now(); audio.currentTime = offset; audio.play().catch(() => {}); } playing = !playing; }
    if (e.code === 'ArrowRight') seek(now() + 5);
    if (e.code === 'ArrowLeft') seek(now() - 5);
  });
  addEventListener('click', () => { audio.currentTime = now(); audio.play().catch(() => {}); }, { once: true });
  const loop = async () => {
    if (!busy) {
      busy = true;
      const T = now() % timeline.duration;
      await engine.renderFrame(Math.floor(T * timeline.fps));
      hud.textContent = `${T.toFixed(2)}s  ·  click for sound  ·  space pause  ·  ←/→ seek`;
      busy = false;
    }
    requestAnimationFrame(loop);
  };
  loop();
}
