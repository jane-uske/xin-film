// 通用数学与时间工具。所有函数都是纯函数，画面只依赖时间 T，保证任意帧可独立重渲。

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => clamp((x - a) / (b - a));
export const remap = (x, a, b, c, d) => lerp(c, d, invLerp(a, b, x));
export const smoothstep = (a, b, x) => { const t = invLerp(a, b, x); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, x) => { const t = invLerp(a, b, x); return t * t * t * (t * (t * 6 - 15) + 10); };
export const fract = (x) => x - Math.floor(x);

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  inOutExpo: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
};

// 在 [a,b] 区间内从 0 渐变到 1，带缓动
export const ramp = (x, a, b, fn = ease.inOutCubic) => fn(invLerp(a, b, x));
// 进-停-出包络：in 段升到 1，out 段降回 0
export const envelope = (x, inStart, inEnd, outStart, outEnd, fn = ease.inOutSine) =>
  Math.min(fn(invLerp(inStart, inEnd, x)), 1 - fn(invLerp(outStart, outEnd, x)));

// 确定性随机数（mulberry32）
export function rng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * next());
  next.gauss = () => {
    const u = Math.max(1e-9, next()), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.unitVec = () => {
    const z = next() * 2 - 1, p = next() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(p), r * Math.sin(p), z];
  };
  return next;
}

// 平滑一维值噪声（CPU 端，用于摄影机漂移等）
const P = new Uint8Array(512);
{ const r = rng(1337); const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) P[i] = p[i & 255]; }
const grad1 = (h, x) => ((h & 1) ? -x : x) * (1 + (h & 7) / 8);
export function noise1(x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(grad1(P[i & 255], f), grad1(P[(i + 1) & 255], f - 1), u) * 0.9;
}
export function fbm1(x, oct = 4) {
  let a = 0, w = 0.5, s = 1;
  for (let i = 0; i < oct; i++) { a += w * noise1(x * s + i * 17.13); s *= 2; w *= 0.5; }
  return a;
}

// 手持/呼吸感摄影机漂移：返回 [dx, dy, droll]，amp 为幅度
export function handheld(T, amp = 1, speed = 1, seed = 0) {
  const s = T * speed;
  return [fbm1(s * 0.31 + seed) * amp, fbm1(s * 0.27 + 40 + seed) * amp, fbm1(s * 0.19 + 80 + seed) * amp * 0.5];
}
