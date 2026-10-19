// 2D 叠加层：字幕卡、章节标、HUD。Canvas2D 绘制，合成在色调映射之后、颗粒之前。
import { clamp, invLerp, ease, rng } from './util.js';

export const FONTS = {
  zh: '"Noto Serif SC", serif',
  en: '"Cormorant Garamond", serif',
  mono: '"JetBrains Mono", monospace',
};

export const COLORS = {
  paper: [237, 230, 218],
  hud: [214, 232, 255],
  hudWarn: [255, 92, 72],
  ember: [255, 170, 96],
};
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a)})`;

export async function loadFonts(texts) {
  const all = texts.join('');
  const loads = [
    `300 48px ${FONTS.zh}`, `400 48px ${FONTS.zh}`, `200 48px ${FONTS.zh}`,
    `italic 300 32px ${FONTS.en}`, `italic 400 32px ${FONTS.en}`, `300 32px ${FONTS.en}`, `400 32px ${FONTS.en}`,
    `300 14px ${FONTS.mono}`, `400 14px ${FONTS.mono}`,
  ];
  for (const f of loads) {
    try { await document.fonts.load(f, all); } catch (e) { console.warn('font load failed', f, e); }
  }
  await document.fonts.ready;
}

// 一张字幕卡的可见度包络：渐入 1.2s、渐出 1.0s
export function cardEnvelope(T, card, fin = 1.2, fout = 1.0) {
  if (T < card.in || T > card.out) return { a: 0, k: 0, kout: 0 };
  const k = ease.outCubic(invLerp(card.in, card.in + fin, T));
  const kout = ease.inOutSine(invLerp(card.out - fout, card.out, T));
  return { a: Math.min(k, 1 - kout), k, kout };
}

// 带柔光的文字：先画一层模糊的光晕，再画清晰字形
export function glowText(g, text, x, y, { font, color, alpha = 1, glow = 0.35, glowBlur = 10, blur = 0, spacing = '0px', align = 'center', S = 1 }) {
  g.save();
  g.font = font;
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  g.letterSpacing = spacing;
  if (glow > 0) {
    g.filter = `blur(${(glowBlur + blur) * S}px)`;
    g.fillStyle = rgba(color, alpha * glow);
    g.fillText(text, x, y);
  }
  g.filter = blur > 0.05 ? `blur(${blur * S}px)` : 'none';
  g.fillStyle = rgba(color, alpha);
  g.fillText(text, x, y);
  g.restore();
}

// letterSpacing 会在最后一个字后也留空，居中时需要补偿半个字距
const spacingPx = (sp) => parseFloat(sp) || 0;

export function drawCard(g, card, T, W, H, S) {
  const env = cardEnvelope(T, card);
  if (env.a <= 0.001) return;
  const blurIn = (1 - env.k) * 6, blurOut = env.kout * 3;
  const blur = blurIn + blurOut;
  const rise = (1 - env.k) * 8 * S;
  const cx = W / 2;
  if (card.layout === 'center' || card.layout === 'lower') {
    const lower = card.layout === 'lower';
    const zhSize = (lower ? 34 : 44) * S, enSize = (lower ? 23 : 27) * S;
    const zy = lower ? H - 132 * S : H / 2 - 4 * S;
    const ey = zy + (lower ? 44 : 56) * S;
    const zsp = `${(lower ? 0.32 : 0.36) * zhSize}px`;
    glowText(g, card.zh, cx + spacingPx(zsp) / 2, zy + rise, { font: `300 ${zhSize}px ${FONTS.zh}`, color: COLORS.paper, alpha: env.a, glow: 0.28, glowBlur: 14, blur, spacing: zsp, S });
    const esp = `${0.04 * enSize}px`;
    glowText(g, card.en, cx + spacingPx(esp) / 2, ey + rise * 1.3, { font: `italic 300 ${enSize}px ${FONTS.en}`, color: COLORS.paper, alpha: env.a * 0.78, glow: 0.2, glowBlur: 10, blur: blur * 1.2, spacing: esp, S });
  } else if (card.layout === 'chapter') {
    const x = 92 * S, y = H - 92 * S;
    const a = env.a;
    g.save();
    g.strokeStyle = rgba(COLORS.paper, a * 0.6);
    g.lineWidth = Math.max(1, 1 * S);
    const lw = 36 * S * env.k;
    g.beginPath(); g.moveTo(x, y - 7 * S); g.lineTo(x + lw, y - 7 * S); g.stroke();
    g.restore();
    glowText(g, card.zh, x + 52 * S, y, { font: `300 ${22 * S}px ${FONTS.zh}`, color: COLORS.paper, alpha: a, glow: 0.25, blur: blur * 0.6, spacing: `${9 * S}px`, align: 'left', S });
    glowText(g, card.en, x + 52 * S, y + 28 * S, { font: `300 ${11.5 * S}px ${FONTS.mono}`, color: COLORS.paper, alpha: a * 0.62, glow: 0, blur: blur * 0.6, spacing: `${4.2 * S}px`, align: 'left', S });
  }
}

// ---------- HUD ----------
// 机器的目光：细线引出标注，打字机式出现。t 为该标注出现后的本地时间，alpha 为整体透明度。
export function hudCallout(g, { anchor, dir = [1, -0.6], len = 120, lines = [], t = 0, alpha = 1, S = 1, color = COLORS.hud, align = 'auto', charRate = 38 }) {
  if (t <= 0 || alpha <= 0) return;
  const [ax, ay] = anchor;
  const dl = Math.hypot(dir[0], dir[1]);
  const ux = dir[0] / dl, uy = dir[1] / dl;
  const kLine = ease.outCubic(clamp(t / 0.55));
  const ex = ax + ux * len * S * kLine, ey = ay + uy * len * S * kLine;
  const right = align === 'auto' ? ux >= 0 : align === 'right';
  const shelf = 46 * S * ease.outCubic(clamp((t - 0.45) / 0.35));
  g.save();
  g.strokeStyle = rgba(color, alpha * 0.75);
  g.fillStyle = rgba(color, alpha * 0.9);
  g.lineWidth = Math.max(1, 1 * S);
  // 锚点：小方框 + 中心点
  const box = 7 * S * ease.outCubic(clamp(t / 0.3));
  g.strokeRect(ax - box / 2, ay - box / 2, box, box);
  g.fillRect(ax - 1 * S, ay - 1 * S, 2 * S, 2 * S);
  g.beginPath(); g.moveTo(ax + ux * box * 0.7, ay + uy * box * 0.7); g.lineTo(ex, ey);
  g.lineTo(ex + (right ? shelf : -shelf), ey); g.stroke();
  // 文本
  const tx = ex + (right ? 8 * S : -8 * S), ty = ey - 9 * S;
  g.textAlign = right ? 'left' : 'right';
  g.textBaseline = 'alphabetic';
  let shown = Math.max(0, (t - 0.75) * charRate);
  lines.forEach((ln, i) => {
    const n = Math.min(ln.text.length, Math.floor(shown));
    shown -= ln.text.length + 4;
    if (n <= 0) return;
    const size = (ln.size || (i === 0 ? 12.5 : 11)) * S;
    g.font = `${ln.weight || 300} ${size}px ${FONTS.mono}`;
    g.letterSpacing = `${(ln.spacing ?? 0.2) * size}px`;
    g.fillStyle = rgba(ln.color || color, alpha * (ln.alpha ?? (i === 0 ? 0.92 : 0.6)));
    // 第一行在横线之上，其余行在横线之下
    const yy = i === 0 ? ty : ey + 8 * S + i * 16 * S;
    let txt = ln.text.slice(0, n);
    // 打字光标
    if (n < ln.text.length) txt += '▍';
    g.fillText(txt, tx, yy);
  });
  g.restore();
}

// 四角取景框
export function hudBracket(g, { x, y, w, h, t = 1, alpha = 1, S = 1, color = COLORS.hud, corner = 14 }) {
  if (t <= 0 || alpha <= 0) return;
  const k = ease.outCubic(clamp(t / 0.4));
  const c = corner * S * k;
  g.save();
  g.strokeStyle = rgba(color, alpha * 0.85);
  g.lineWidth = Math.max(1, 1 * S);
  const L = x - w / 2, R = x + w / 2, Tp = y - h / 2, B = y + h / 2;
  g.beginPath();
  g.moveTo(L, Tp + c); g.lineTo(L, Tp); g.lineTo(L + c, Tp);
  g.moveTo(R - c, Tp); g.lineTo(R, Tp); g.lineTo(R, Tp + c);
  g.moveTo(R, B - c); g.lineTo(R, B); g.lineTo(R - c, B);
  g.moveTo(L + c, B); g.lineTo(L, B); g.lineTo(L, B - c);
  g.stroke();
  g.restore();
}

export function hudText(g, text, x, y, { size = 11, alpha = 1, S = 1, color = COLORS.hud, align = 'left', weight = 300, spacing = 0.22 } = {}) {
  g.save();
  g.font = `${weight} ${size * S}px ${FONTS.mono}`;
  g.letterSpacing = `${spacing * size * S}px`;
  g.textAlign = align;
  g.fillStyle = rgba(color, alpha);
  g.fillText(text, x, y);
  g.restore();
}

// 对一段 HUD 绘制施加故障效果：水平切片错位 + 偶发消隐
export function withGlitch(g, amount, seed, W, H, draw) {
  if (amount <= 0.001) { draw(g); return; }
  const off = withGlitch._c || (withGlitch._c = document.createElement('canvas'));
  if (off.width !== W || off.height !== H) { off.width = W; off.height = H; }
  const og = off.getContext('2d');
  og.clearRect(0, 0, W, H);
  draw(og);
  const r = rng(seed);
  const slices = 18;
  for (let i = 0; i < slices; i++) {
    const y0 = Math.floor((i / slices) * H), h = Math.ceil(H / slices);
    const dx = (r() < amount ? (r() - 0.5) * 80 * amount : 0) * (W / 1920);
    const vis = r() > amount * 0.55;
    if (!vis) continue;
    g.globalAlpha = 1 - amount * 0.3 * r();
    g.drawImage(off, 0, y0, W, h, dx, y0, W, h);
  }
  g.globalAlpha = 1;
}
