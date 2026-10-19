// Act I shared helpers: deterministic CPU noise for init-time generation, point-sprite shader chunks,
// camera-state interpolation. Everything here is pure; nothing keeps cross-frame state.

// ---------- CPU gradient noise (seeded, deterministic) ----------
export function makeNoise3(rng) {
  const p = new Uint8Array(512);
  const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const G = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (g, x, y, z) => g[0] * x + g[1] * y + g[2] * z;
  const lerp = (a, b, t) => a + (b - a) * t;
  function noise(x, y, z) {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[xi] + yi, AA = p[A] + zi, AB = p[A + 1] + zi, B = p[xi + 1] + yi, BA = p[B] + zi, BB = p[B + 1] + zi;
    const g = (h) => G[h % 12];
    return lerp(
      lerp(lerp(dot(g(p[AA]), x, y, z), dot(g(p[BA]), x - 1, y, z), u), lerp(dot(g(p[AB]), x, y - 1, z), dot(g(p[BB]), x - 1, y - 1, z), u), v),
      lerp(lerp(dot(g(p[AA + 1]), x, y, z - 1), dot(g(p[BA + 1]), x - 1, y, z - 1), u), lerp(dot(g(p[AB + 1]), x, y - 1, z - 1), dot(g(p[BB + 1]), x - 1, y - 1, z - 1), u), v),
      w);
  }
  noise.fbm = (x, y, z, oct = 4) => { let a = 0, w = 0.5, s = 1; for (let i = 0; i < oct; i++) { a += w * noise(x * s + i * 7.1, y * s + i * 3.3, z * s + i * 5.7); s *= 2.02; w *= 0.5; } return a; };
  noise.ridged = (x, y, z, oct = 4) => { let a = 0, w = 0.5, s = 1; for (let i = 0; i < oct; i++) { a += w * (1 - Math.abs(noise(x * s + i * 7.1, y * s + i * 3.3, z * s + i * 5.7))); s *= 2.02; w *= 0.5; } return a; };
  return noise;
}

// ---------- GLSL chunks ----------
// Energy-preserving point size: below minPx the sprite stays minPx wide and fades by area instead,
// so sub-pixel particles do not shimmer and preview scales keep the same overall brightness.
export const POINT_VS = /* glsl */ `
uniform float uS;
float vAlphaK;
float pointSize(float px){
  px *= uS;
  vAlphaK = 1.0;
  float m = 1.4;
  if (px < m){ vAlphaK = (px * px) / (m * m); px = m; }
  return px;
}
`;

export const POINT_FS = /* glsl */ `
float spriteMask(float sharp){
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  return exp(-r2 * sharp) * (1.0 - r2);
}
`;

// ---------- Camera states ----------
// A camera state is { p:[x,y,z], l:[x,y,z] (look target), u:[x,y,z] (up), fov }
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function mixCam(a, b, t) {
  return { p: lerp3(a.p, b.p, t), l: lerp3(a.l, b.l, t), u: norm3(lerp3(a.u, b.u, t)), fov: a.fov + (b.fov - a.fov) * t };
}

// Catmull-Rom through an array of points at parameter u ∈ [0,1] (uniform knots)
export function catmull(pts, u) {
  const n = pts.length - 1;
  const x = Math.min(Math.max(u, 0), 1) * n;
  const i = Math.min(Math.floor(x), n - 1);
  const t = x - i;
  const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, n)];
  const t2 = t * t, t3 = t2 * t;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  }
  return out;
}

// Integrate a scalar rate function r(t) from a to b with a fixed-step Simpson rule (pure function of b)
export function integrate(r, a, b, steps = 96) {
  if (b <= a) return 0;
  const h = (b - a) / steps;
  let s = r(a) + r(b);
  for (let i = 1; i < steps; i++) s += r(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}
