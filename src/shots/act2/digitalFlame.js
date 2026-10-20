// 数据之火：网格上的光点，采样与烛火完全相同的密度函数 flame3/flDensity。
// 分辨率阶跃（学习）、亮度量化、穿过种子时让开、第三幕的变暖与柔化。底座与芯片。
import { flameGLSL } from './flameModel.js';
import { candleFlameGLSL } from './candle.js';
import { fogGLSL } from './floor.js';

export const DIG = {
  X: 8.0,                 // 原初那一团的 x（蜡烛在 x = 0）
  plinthHW: 1.2,          // 底座半宽
  plinthH: 8.6,           // 底座高
  chipHW: 0.45, chipH: 0.22,
  get wickY() { return this.plinthH + this.chipH + 0.36; },
  levels: [[8, 16], [14, 28], [22, 44], [30, 60], [40, 80]],
  box: { x: 0.95, y0: -0.42, y1: 4.45 },
};

export const pointVS = /* glsl */ `
uniform vec4 uF0, uF1;
uniform vec3 uOrigin, uCell;
uniform float uQ, uVox, uGain, uPx, uSoft, uWarm, uFlash, uSize, uMinPx;
uniform vec4 uSeed;
uniform float uFade;
in vec3 iOff;
out vec3 vCol; out float vVox; out float vSoft;
void kill(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vVox = 0.0; vSoft = 0.0; }
void main(){
  vec3 p = position;
  vec3 base = uOrigin + iOff;
  vec3 wp = base + p;
  if (uSeed.w > 0.0) {
    vec3 d = wp - uSeed.xyz; float r2 = dot(d, d);
    p += normalize(d + 1e-4) * uSeed.w * exp(-r2 / 0.16);
  }
  // 朝向观者的"全息"：横向坐标 u 取在摄影机的右方向上，纵深 v 沿视线
  vec2 dv = normalize(cameraPosition.xz - base.xz);
  vec2 right = vec2(dv.y, -dv.x);
  float s = flS(p.y, uF0);
  vec2 c = flCenter(s, p.y, uF0, uF1);
  float w = flHalfW(s, uF0);
  vec2 q = (p.xz - c) / w;
  float u = dot(q, right), v = dot(q, dv);
  float rn3 = length(q);
  float heat;
  float I = flLum(abs(u), s, heat);
  // 量化（亮度阶数随学习提高）：量化的是这一列的值
  float Imax = 4.6;
  float qI = floor(I / Imax * uQ + 0.5) / uQ * Imax;
  I = mix(qI, I, uSoft);
  // 弦长分摊：这一列点的总和 = 烛火同一位置的亮度
  float chord = 2.0 * sqrt(max(1.0 - u * u, 0.0)) * w / uCell.z;
  float lv = rn3 < 1.0 ? I / max(chord, 1.0) : 0.0;
  // 焰尖：沿中心线伸出的一缕（与烛火的焰尖同一个式子），只占中间一层深度
  float wt = max(w, 0.05);
  vec2 dq = p.xz - c;
  float tipI = smoothstep(0.80, 0.97, s) * (1.0 - smoothstep(1.0, 1.14, s)) * smoothstep(0.9, 0.2, abs(dot(dq, right)) / wt) * 0.3;
  float slab = step(abs(dot(dq, dv)), wt);
  lv += floor(tipI / Imax * uQ * 3.0 + 0.5) / (uQ * 3.0) * Imax * slab * uCell.z / (2.0 * wt);
  if (lv < 0.004 || uFade <= 0.0) { kill(); return; }
  vec3 h = hash33(position * 17.31 + 3.1) - 0.5;
  p += h * uCell * uSoft * 1.4;
  wp = base + p;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = uCell.x * uPx / max(-mv.z, 0.1);
  float ps = size * mix(mix(uSize, 0.98, uVox), 2.2, uSoft);
  gl_PointSize = clamp(ps, uMinPx, 80.0);
  vec3 cool = digPalette(heat + 0.25 * (1.0 - step(1.0, rn3)) * 0.0);
  vec3 white = vec3(0.95, 0.95, 0.96);
  vec3 col = uWarm < 0.5 ? mix(cool, white, uWarm * 2.0) : mix(white, warmPalette(heat), uWarm * 2.0 - 1.0);
  float Ep = lv * uGain * uFade;
  // 点比像素还小时，按面积守恒
  Ep *= clamp(ps * ps / (gl_PointSize * gl_PointSize), 0.0, 1.0);
  Ep /= mix(1.0, 14.0, uSoft);
  vCol = col * Ep * (1.0 + uFlash);
  vVox = uVox; vSoft = uSoft;
}`;

export const pointFS = /* glsl */ `
precision highp float;
in vec3 vCol; in float vVox; in float vSoft; out vec4 o;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float rd = dot(c, c);
  float dotm = exp(-rd * 3.2);
  float sq = max(abs(c.x), abs(c.y));
  float vox = (1.0 - smoothstep(0.80, 0.96, sq)) * (0.7 + 0.3 * smoothstep(0.45, 0.85, sq));
  float sft = exp(-rd * 2.2);
  float m = mix(mix(dotm, vox, vVox), sft, vSoft);
  o = vec4(vCol * m, 0.0);
}`;

export function gridGeometry(THREE, N, NY) {
  const b = DIG.box;
  const cx = (2 * b.x) / N, cy = (b.y1 - b.y0) / NY;
  const pts = new Float32Array(N * N * NY * 3);
  let k = 0;
  for (let j = 0; j < NY; j++) for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const x = -b.x + (ix + 0.5) * cx, z = -b.x + (iz + 0.5) * cx, y = b.y0 + (j + 0.5) * cy;
    // 只保留可能落在火焰包络里的点（半径 0.95 的圆柱）
    if (x * x + z * z > 0.95 * 0.95) continue;
    pts[k++] = x; pts[k++] = y; pts[k++] = z;
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pts.slice(0, k), 3));
  g.instanceCount = 1;
  g.userData.cell = [cx, cy, cx];
  g.userData.N = N;
  return g;
}

export function makePointMaterial(ctx) {
  const { THREE, glsl } = ctx;
  const u = {
    uF0: { value: new THREE.Vector4() }, uF1: { value: new THREE.Vector4() },
    uOrigin: { value: new THREE.Vector3() }, uCell: { value: new THREE.Vector3() },
    uQ: { value: 4 }, uVox: { value: 1 }, uGain: { value: 1 }, uPx: { value: 1000 }, uSoft: { value: 0 }, uWarm: { value: 0 },
    uFlash: { value: 0 }, uSize: { value: 0.42 }, uMinPx: { value: 1.0 },
    uSeed: { value: new THREE.Vector4(0, -100, 0, 0) }, uFade: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: u,
    vertexShader: glsl.hash + flameGLSL + pointVS, fragmentShader: pointFS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return { mat, u };
}

// 一团可以变暖的"连续"火：与烛火同一套着色，只是颜色由 uTint 调到白/琥珀/青
const warmFlameFS = /* glsl */ `
precision highp float;
uniform vec4 uF0, uF1; uniform vec2 uRight; uniform float uGain, uTm, uWarm;
in vec2 vP; out vec4 o;
${candleFlameGLSL}
void main(){
  vec4 c = candleFlame(vP, uF0, uF1, uRight, uGain, 0.0, uTm);
  float l = dot(c.rgb, vec3(0.3, 0.55, 0.15));
  vec3 cool = l * vec3(0.35, 0.85, 1.25);
  vec3 white = l * vec3(1.0, 0.98, 0.95);
  vec3 col = uWarm < 0.5 ? mix(cool, white, uWarm * 2.0) : mix(white, c.rgb, uWarm * 2.0 - 1.0);
  o = vec4(col, 0.0);
}`;

export function makeWarmFlame(ctx, flameVS) {
  const { THREE } = ctx;
  const u = {
    uOrigin: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector2(1, 0) },
    uF0: { value: new THREE.Vector4() }, uF1: { value: new THREE.Vector4() }, uGain: { value: 0 }, uTm: { value: 0 }, uWarm: { value: 0 },
  };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-2.2, -0.75, 0, 2.2, -0.75, 0, 2.2, 6.0, 0, -2.2, 6.0, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: flameVS, fragmentShader: warmFlameFS, uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.frustumCulled = false; m.renderOrder = 12;
  return { mesh: m, u };
}

// 底座：光滑的黑色石柱（被自己的火从上方照亮、被烛火从侧面照亮）
export const plinthVS = /* glsl */ `
out vec3 vW; out vec3 vN; out vec3 vLocal; out vec3 vInst;
void main(){
  #ifdef USE_INSTANCING
    mat4 im = instanceMatrix;
  #else
    mat4 im = mat4(1.0);
  #endif
  vec4 w = modelMatrix * im * vec4(position, 1.0);
  vW = w.xyz; vN = normalize(mat3(modelMatrix) * mat3(im) * normal); vLocal = position;
  vInst = (modelMatrix * im * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const plinthFS = /* glsl */ `
precision highp float;
uniform vec3 uFlamePos; uniform float uFlameI; uniform vec3 uFlameCol;
uniform vec3 uOwnCol; uniform float uOwnI, uOwnY;
uniform vec3 uOwnOff;
uniform float uFade;
uniform vec4 uLat; uniform float uLatI; uniform vec3 uLatCol;
${fogGLSL}
in vec3 vW; in vec3 vN; in vec3 vLocal; in vec3 vInst; out vec4 o;
vec3 lit(vec3 P, vec3 N, vec3 V, vec3 Lp, vec3 col, float I){
  vec3 L = Lp - P; float d2 = dot(L, L); L *= inversesqrt(d2);
  float ndl = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float fr = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  float sp = pow(max(dot(N, H), 0.0), 160.0) * 3.0 + pow(max(dot(N, H), 0.0), 20.0) * 0.12;
  return col * I * (ndl * 0.025 + sp * (0.25 + fr)) / d2;
}
void main(){
  if (uFogK > 0.0 && exp(-max(length(vW - cameraPosition) - 60.0, 0.0) * uFogK) < 0.01) { o = vec4(uFogCol, 1.0); return; }
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
  vec3 own = vec3(vInst.x, uOwnY, vInst.z) + uOwnOff;
  vec3 col = lit(vW, N, V, own, uOwnCol, uOwnI);
  // 顶面边缘的细高光（倒角感）
  float top = smoothstep(0.7, 0.95, N.y);
  vec2 q = abs(vLocal.xz);
  float bev = smoothstep(0.88, 1.0, max(q.x, q.y) / ${DIG.plinthHW.toFixed(3)}) * top;
  col += uOwnCol * uOwnI * bev * 0.06;
  if (uFlameI > 0.0) {
    vec3 Lc = uFlamePos - vW; float dc = dot(Lc, Lc);
    col += lit(vW, N, V, uFlamePos, uFlameCol, uFlameI) + uFlameCol * uFlameI * max(dot(N, normalize(Lc)), 0.0) * 0.10 / dc;
  }
  // 火海里：四周邻居的火把这根石柱的侧面照亮（一片冷光的柱廊）
  if (uLatI > 0.0) {
    vec2 g = vec2((vInst.x - uLat.x) / uLat.y, -vInst.z / uLat.y);
    for (int k = 0; k < 4; k++) {
      vec2 o = k == 0 ? vec2(1.0, 0.0) : k == 1 ? vec2(-1.0, 0.0) : k == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
      vec2 c = g + o;
      if (c.x < 0.0 || c.y < 0.0 || c.x >= uLat.z || c.y >= uLat.w) continue;
      vec3 Lp = vec3(uLat.x + c.x * uLat.y, uOwnY, -c.y * uLat.y);
      vec3 L = Lp - vW; float d2 = dot(L, L);
      col += uLatCol * uLatI * max(dot(N, normalize(L)), 0.0) * 0.09 / d2;
    }
  }
  col *= uFade;
  o = vec4(applyFog(col, vW), 1.0);
}`;

// 芯片：黑硅上的细网格电路，可以发红、燃烧、剥落
const chipFS = /* glsl */ `
precision highp float;
uniform vec3 uOwnCol; uniform float uOwnI, uGlow, uBurn, uTm, uFade; uniform vec3 uOwnPos;
uniform vec3 uFlamePos; uniform float uFlameI; uniform vec3 uFlameCol;
in vec3 vW; in vec3 vN; in vec3 vLocal; in vec3 vInst; out vec4 o;
${'' /* snoise 注入 */}
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
  // 烧蚀：噪声阈值 + 自边缘向内
  float edgeD = ${DIG.chipHW.toFixed(3)} - max(abs(vLocal.x), abs(vLocal.z));
  float n = snoise(vLocal * 9.0 + vec3(0.0, uTm * 0.05, 0.0)) * 0.5 + 0.5;
  float burnField = n * 0.55 + clamp(edgeD / ${DIG.chipHW.toFixed(3)}, 0.0, 1.0) * 0.45 + (vLocal.y + ${(DIG.chipH / 2).toFixed(3)}) * 0.4;
  if (uBurn > 0.0 && burnField < uBurn) discard;
  float rim = uBurn > 0.0 ? 1.0 - smoothstep(0.0, 0.09, burnField - uBurn) : 0.0;
  vec3 L = uOwnPos - vW; float d2 = dot(L, L); L *= inversesqrt(d2);
  vec3 H = normalize(L + V);
  vec3 col = uOwnCol * uOwnI * (max(dot(N, L), 0.0) * 0.04 + pow(max(dot(N, H), 0.0), 60.0) * 0.8) / d2;
  // 电路网格（顶面）
  vec2 g = abs(fract(vLocal.xz * 11.0) - 0.5);
  float line = (1.0 - smoothstep(0.02, 0.07, min(g.x, g.y))) * step(0.9, N.y);
  vec2 g2 = abs(fract(vLocal.xz * 3.0 + 0.5) - 0.5);
  line += (1.0 - smoothstep(0.03, 0.06, min(g2.x, g2.y))) * step(0.9, N.y) * 0.6;
  col += uOwnCol * line * 0.35 * uOwnI * 0.05;
  // 侧面的细边光
  col += uOwnCol * uOwnI * 0.01 * (1.0 - step(0.9, N.y));
  if (uFlameI > 0.0) { vec3 Lc = uFlamePos - vW; float dc = dot(Lc, Lc); col += uFlameCol * uFlameI * max(dot(N, normalize(Lc)), 0.0) * 0.03 / dc; }
  // 发红：先是暗红的热，再是燃烧前沿的亮橙
  // 热：暗红的斑驳，裂纹处更亮
  float crack = 1.0 - smoothstep(0.0, 0.08, abs(snoise(vLocal * 22.0 + 3.0)));
  vec3 hot = vec3(1.0, 0.14, 0.02) * uGlow * (0.02 + 0.12 * n * n + 0.45 * crack);
  col += hot + vec3(1.0, 0.42, 0.08) * rim * 1.2;
  col *= uFade;
  o = vec4(col, 1.0);
}`;

export function makeDigital(ctx, shared, flameVS) {
  const { THREE, glsl } = ctx;
  const group = new THREE.Group();
  const levels = DIG.levels.map(([n, ny]) => gridGeometry(THREE, n, ny));
  // 原初那一团（单实例）
  const orig = makePointMaterial(ctx);
  const origPts = levels.map((g) => {
    const gg = g.clone();
    gg.instanceCount = 1;
    gg.setAttribute('iOff', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0]), 3));
    gg.userData = g.userData;
    const p = new THREE.Points(gg, orig.mat);
    p.frustumCulled = false; p.visible = false; p.renderOrder = 13;
    group.add(p);
    return p;
  });
  // 底座 + 芯片
  const plU = {
    uFlamePos: shared.uFlamePos, uFlameI: shared.uFlameI, uFlameCol: shared.uFlameCol,
    uOwnCol: shared.uDigCol, uOwnI: shared.uDigI, uOwnY: { value: DIG.wickY + 1.2 }, uOwnOff: { value: new THREE.Vector3() },
    uFogK: shared.uFogK, uFogCol: shared.uFogCol, uFade: { value: 1 },
    uLat: shared.uLat, uLatI: shared.uLatI, uLatCol: shared.uLatCol,
  };
  const plMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: plinthVS, fragmentShader: plinthFS, uniforms: plU });
  const plGeo = new THREE.BoxGeometry(DIG.plinthHW * 2, DIG.plinthH, DIG.plinthHW * 2, 1, 1, 1);
  plGeo.translate(0, DIG.plinthH / 2, 0);
  const plinth = new THREE.Mesh(plGeo, plMat);
  plinth.position.set(DIG.X, 0, 0);
  const chipU = {
    uOwnCol: shared.uDigCol, uOwnI: shared.uDigI, uOwnPos: shared.uDigPos,
    uFlamePos: shared.uFlamePos, uFlameI: shared.uFlameI, uFlameCol: shared.uFlameCol,
    uGlow: { value: 0 }, uBurn: { value: 0 }, uTm: { value: 0 }, uFade: { value: 1 },
  };
  const chipGeo = new THREE.BoxGeometry(DIG.chipHW * 2, DIG.chipH, DIG.chipHW * 2);
  const chip = new THREE.Mesh(chipGeo, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: plinthVS, fragmentShader: chipFS.replace("${'' /* snoise 注入 */}", '').replace('in vec3 vW;', glsl.simplex3 + '\nin vec3 vW;'), uniforms: chipU }));
  chip.position.set(DIG.X, DIG.plinthH + DIG.chipH / 2, 0);
  group.add(plinth, chip);
  const warm = makeWarmFlame(ctx, flameVS);
  group.add(warm.mesh);
  // 冷光晕
  const haloU = { uOrigin: warm.u.uOrigin, uRight: warm.u.uRight, uGain: { value: 0 }, uCol: { value: new THREE.Vector3(0.25, 0.75, 1.0) }, uC: { value: new THREE.Vector2(0, 1.3) } };
  return { group, levels, origPts, orig, plinth, plU, chip, chipU, warm, haloU };
}
