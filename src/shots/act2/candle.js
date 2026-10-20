// 蜡烛：蜡体（每帧由时间的纯函数重建）、半透明蜡材质（假次表面散射）、蜡泪、底部积蜡、灰烬、
// 烛火（与数据之火共享 flameModel 的密度与闪烁）、光晕、青烟。
import { FLAME, flameGLSL } from './flameModel.js';

export const CANDLE = { R: 2.6, H0: 11.0 };

// ---------- 时间写进蜡烛：全部是 T 的单调函数 ----------
export function candleState(util, cue, T) {
  const { smootherstep, smoothstep, clamp } = util;
  const t0 = cue('flame_catch');
  const dt = Math.max(0, T - t0);
  // 高度：自点燃起单调下降（镜头不在它身上时，时间压缩得更快）
  const H = CANDLE.H0 - 0.012 * dt
    - 2.0 * smootherstep(cue('copy_cascade_start'), cue('candle_return') - 0.5, T)
    - 1.8 * smootherstep(cue('ch3_in') + 1, cue('candle_reenter') - 1, T);
  const lit = smoothstep(t0, t0 + 0.4, T);
  // 熔池：从芯周围的小池逐渐扩大到接近杯沿
  const Rp = 0.55 + 1.05 * smoothstep(t0, cue('card_c2a_out'), T) + 0.45 * smoothstep(cue('copy_2'), cue('candle_return'), T)
    + 0.2 * smoothstep(cue('ch3_in'), cue('candle_reenter'), T);
  const poolDepth = 0.06 + 0.24 * smoothstep(t0, cue('card_c2a_out'), T) + 0.22 * smoothstep(cue('copy_2'), cue('candle_return'), T)
    + 0.1 * smoothstep(cue('ch3_in'), cue('candle_reenter'), T);
  const poolY = H - poolDepth;
  // 底部积蜡
  const basePool = 1.15 * smoothstep(cue('copy_cascade_start') + 4, cue('candle_return'), T) + 0.7 * smoothstep(cue('ch3_in'), cue('candle_reenter'), T);
  return { H, Rp: clamp(Rp, 0.3, CANDLE.R - 0.32), poolDepth, poolY, lit, basePool, wickY: poolY + 0.42 };
}

// 蜡泪表：角度 θ（朝 +z 的摄影机为 π/2），开始时刻，最终长度
export function dripList(cue) {
  const P = Math.PI / 2;
  return [
    { th: Math.PI - 0.42, t: cue('wax_drip'), run: 7.5, len: 2.7, w: 1.0 },
    { th: P - 0.95, t: cue('copy_cascade_start') + 1.5, run: 6, len: 6.4, w: 0.9 },
    { th: P + 1.25, t: cue('copy_cascade_end') + 1.2, run: 5, len: 4.4, w: 1.1 },
    { th: P - 0.32, t: cue('power_off') - 1.5, run: 4, len: 9.5, w: 1.2 },
    { th: P + 0.78, t: cue('ch3_in') + 4, run: 6, len: 3.2, w: 0.85 },
    { th: P - 1.45, t: cue('warm_shift_start'), run: 6, len: 5.5, w: 1.0 },
    { th: P + 0.05, t: cue('card_c4a_in') - 2, run: 5, len: 2.6, w: 0.9 },
    { th: P + 2.1, t: cue('copy_8'), run: 6, len: 5.0, w: 1.0 },
    { th: P - 2.2, t: cue('ch3_in') + 9, run: 6, len: 4.0, w: 1.0 },
  ];
}

const waxCommon = /* glsl */ `
uniform vec3 uFlamePos; uniform float uFlameI; uniform vec3 uFlameCol;
uniform vec3 uDigPos; uniform float uDigI; uniform vec3 uDigCol;
uniform vec3 uMatchPos; uniform float uMatchI; uniform float uLatFill;
uniform float uH, uR, uRp, uPoolY, uAmb;
uniform vec4 uAsh[6];
in vec3 vW; in vec3 vN; in float vZone; in float vWet;
out vec4 o;
vec3 waxLight(vec3 P, vec3 N, vec3 V){
  float drip = step(3.5, vZone);
  float zn = drip > 0.5 ? 0.0 : vZone;
  // 1) 次表面：火光从熔池进入，沿蜡体向下扩散、衰减并变红；壁越薄（熔池越大）越透
  float depthTop = max(uH - P.y, 0.0);
  float wall = max(uR - uRp, 0.12);
  float dF = length(uFlamePos - P);
  float sss = uFlameI / (1.0 + 0.06 * dF * dF);
  float side = 1.0 - smoothstep(0.25, 0.9, zn);
  float rim = pow(1.0 - abs(dot(N, V)), 2.0);
  // 杯沿最薄：透光最强；向下指数衰减，颜色由黄白变为橙红
  vec3 trans = exp(-depthTop * vec3(2.0, 2.9, 4.0));
  float thin = 0.45 + 0.55 * exp(-wall * 0.8);
  vec3 col = trans * sss * thin * (0.75 + 0.6 * rim) * vec3(1.0, 0.56, 0.26) * 0.66;
  // 杯沿唇口：一圈亮边
  float lip = smoothstep(0.2, 0.55, zn) * (1.0 - smoothstep(0.9, 1.1, zn));
  col += vec3(1.0, 0.72, 0.42) * sss * lip * 0.32;
  // 蜡泪是一道凸起的棱：棱脊更透更亮，两侧边缘更暗
  col *= mix(1.0, mix(0.45, 1.35, pow(max(dot(N, V), 0.0), 1.3)), drip);
  // 蜡本身是白的：一层很淡的漫散射，让形体在暗处仍可读
  col += vec3(1.0, 0.82, 0.66) * uFlameI * 0.008 * exp(-depthTop * 0.6) / (1.0 + 0.02 * dF * dF);
  // 2) 直接光（顶部肩面、熔池、蜡泪顶面）
  vec3 L = normalize(uFlamePos - P);
  float ndl = max(dot(N, L), 0.0);
  float wrap = max((dot(N, L) + 0.35) / 1.35, 0.0);
  col += uFlameCol * uFlameI * mix(wrap * 0.4, ndl, 0.6) * 0.75 / (1.0 + dF * dF);
  // 3) 镜面：液态熔池与新鲜蜡泪是湿的
  vec3 Hh = normalize(L + V);
  float gloss = mix(0.15, 1.0, max(step(1.5, zn), vWet));
  float sp = pow(max(dot(N, Hh), 0.0), mix(18.0, 220.0, gloss)) * mix(0.12, 2.6, gloss);
  col += uFlameCol * uFlameI * sp * 3.0 / (1.0 + dF * dF);
  // 4) 数据之火的冷光（只照到朝向它的一面）
  vec3 Ld = uDigPos - P; float dd = length(Ld); Ld /= dd;
  float ndd = max(dot(N, Ld), 0.0);
  vec3 Hd = normalize(Ld + V);
  col += uDigCol * uDigI * (ndd * 0.9 + pow(max(dot(N, Hd), 0.0), 40.0) * 0.6) / (1.0 + dd * dd * 0.6);
  // 冷光也透进蜡里一点
  col += uDigCol * uDigI * 0.12 * pow(max(dot(N, Ld), 0.0), 0.5) / (1.0 + dd * dd);
  // 5) 划火柴的瞬间光
  vec3 Lm = uMatchPos - P; float dm = length(Lm); Lm /= dm;
  col += vec3(1.0, 0.55, 0.22) * uMatchI * (max(dot(N, Lm), 0.0) * 0.8 + 0.15) / (1.0 + dm * dm * 0.4);
  col += vec3(0.6, 0.5, 0.42) * uAmb;
  // 画外火海的冷光（从右后方）
  col += vec3(0.2, 0.62, 1.0) * uLatFill * (pow(max(dot(N, normalize(vec3(1.0, 0.25, -0.6))), 0.0), 1.5) * 0.5 + 0.02);
  return col;
}
`;

const waxVS = /* glsl */ `
in float zone; in float wet;
out vec3 vW; out vec3 vN; out float vZone; out float vWet;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); vZone = zone; vWet = wet;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const waxFS = /* glsl */ `
precision highp float;
uniform vec4 uF0, uF1; uniform vec2 uRight; uniform vec3 uOrigin; uniform float uTmW, uFGain;
${waxCommon}
${'' /* 烛火函数 */}
__FLAME__
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  if (!gl_FrontFacing) N = -N;
  // 蜡面的细微起伏与斑驳（液态熔池除外）
  float solid = 1.0 - step(1.5, vZone) * (1.0 - step(3.5, vZone));
  vec3 q = vW * vec3(2.3, 1.1, 2.3);
  N = normalize(N + solid * 0.07 * vec3(snoise(q * 1.7), snoise(q * 1.7 + 7.1), snoise(q * 1.7 + 13.3)));
  float mott = snoise(vW * vec3(1.3, 0.45, 1.3)) * 0.6 + snoise(vW * 6.0) * 0.25 + snoise(vW * 19.0) * 0.15;
  vec3 col = waxLight(vW, N, V) * (1.0 + solid * 0.16 * mott);
  // 熔池：液态的蜡，更透、更亮
  float dF = length(uFlamePos - vW);
  if (vZone > 1.5 && vZone < 2.5) {
    // 液态熔池：像一面暗的镜子，映出火焰
    vec3 I = normalize(vW - cameraPosition);
    vec3 R = reflect(I, vec3(0.0, 1.0, 0.0));
    vec3 pn = vec3(uRight.y, 0.0, -uRight.x);  // 公告板平面的法线（朝向摄影机方向的水平分量）
    float den = dot(R, pn);
    if (abs(den) > 1e-3) {
      float tt = dot(uOrigin - vW, pn) / den;
      if (tt > 0.0) {
        vec3 h = vW + R * tt - uOrigin;
        vec2 bp = vec2(dot(h.xz, uRight), h.y);
        float fres = 0.04 + 0.5 * pow(1.0 - abs(I.y), 5.0);
        col *= 0.55;
        col += candleFlame(bp, uF0, uF1, uRight, uFGain, 0.0, uTmW).rgb * (fres + 0.22);
      }
    }
  }
  if (vZone > 0.7 && vZone < 2.5) {
    // 顶部：光直接从熔池里透出来（最亮），肩部次之
    float pool = step(1.5, vZone);
    col += vec3(1.0, 0.62, 0.30) * uFlameI * (0.22 + 0.3 * pool) / (1.0 + 0.22 * dF * dF);
  }
  // 灰烬：种子的灰落在蜡上
  for (int i = 0; i < 6; i++) {
    vec4 a = uAsh[i];
    if (a.w <= 0.0) continue;
    float d = length(vW.xz - a.xy) / a.z;
    float m = smoothstep(1.0, 0.45, d) * a.w * step(0.6, N.y);
    col = mix(col, col * 0.12 + vec3(0.004), m);
  }
  o = vec4(col, 1.0);
}`;

// ---------- 烛火：面向摄影机的公告板，按 flameModel 的同一个场着色 ----------
export const flameVS = /* glsl */ `
uniform vec3 uOrigin; uniform vec2 uRight;
out vec2 vP;
void main(){
  vP = position.xy;
  vec3 w = uOrigin + vec3(uRight.x, 0.0, uRight.y) * position.x + vec3(0.0, position.y, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

export const candleFlameGLSL = /* glsl */ `
${flameGLSL}
// 返回 rgb 发光与 a（烛芯遮挡）
vec4 candleFlame(vec2 p, vec4 f0, vec4 f1, vec2 right, float gain, float wick, float tm){
  // 上部热扰动（热浪）
  float hz = smoothstep(1.6, 3.6, p.y);
  p.x += hz * 0.025 * sin(p.y * 7.0 - tm * 17.0) * sin(p.y * 2.3 + tm * 3.1);
  float s = flS(p.y, f0);
  vec2 c2 = flCenter(s, p.y, f0, f1);
  float cu = dot(c2, right);
  float w = flHalfW(s, f0);
  float rn = abs(p.x - cu) / w;
  float heat;
  float I = flLum(rn, s, heat);
  vec3 col = warmPalette(heat);
  vec3 cDeep = vec3(1.0, 0.16, 0.02), cOr = vec3(1.0, 0.36, 0.07);
  vec3 e = col * I + cOr * flMantle(rn, s);
  // 焰尖：拉长的暗红尾巴
  float tipS = flS(p.y, f0);
  float tip = smoothstep(0.82, 0.97, tipS) * (1.0 - smoothstep(1.0, 1.12, tipS)) * smoothstep(0.9, 0.2, abs(p.x - cu) / max(w, 0.05));
  e += cDeep * tip * 0.18;
  e += vec3(0.12, 0.28, 1.0) * flBlue(rn, s) * 0.95;
  // 芯：一根细的、略弯的黑线，顶端一粒红
  float a = 0.0;
  if (wick > 0.0) {
    float wy = p.y;
    float bend = 0.07 * smoothstep(-0.1, 0.32, wy) * smoothstep(-0.1, 0.32, wy);
    float dx = abs(p.x - bend);
    float inW = smoothstep(0.042, 0.028, dx) * step(-0.6, wy) * (1.0 - smoothstep(0.26, 0.34, wy));
    a = inW * wick;
    float emb = exp(-pow(length(vec2(p.x - 0.075, wy - 0.3)) / 0.035, 2.0));
    e = e * (1.0 - a * 0.7) + vec3(1.0, 0.25, 0.04) * emb * 4.0 * wick;
  }
  return vec4(e * gain, a);
}
`;

const _flameFS = 0;
const flameFS = /* glsl */ `
precision highp float;
uniform vec4 uF0, uF1; uniform vec2 uRight; uniform float uGain, uWick, uTm;
in vec2 vP; out vec4 o;
${candleFlameGLSL}
void main(){
  vec4 c = candleFlame(vP, uF0, uF1, uRight, uGain, uWick, uTm);
  o = vec4(c.rgb, c.a);
}`;

// 光晕：大气与镜头里的散射，不做深度测试
export const haloFS = /* glsl */ `
precision highp float;
uniform float uGain; uniform vec3 uCol; uniform vec2 uC;
in vec2 vP; out vec4 o;
void main(){
  vec2 d = (vP - uC) * vec2(1.0, 0.78);
  float r = length(d);
  float h = 0.045 / (1.0 + r * r * 2.2) + 0.007 * exp(-r * 0.3);
  o = vec4(uCol * h * uGain, 0.0);
}`;

// 青烟：一缕向上飘的细丝（闭式行波，确定性）
const smokeFS = /* glsl */ `
precision highp float;
uniform float uGain, uTm, uY0; uniform vec2 uLean;
in vec2 vP; out vec4 o;
${'' /* 共享噪声在主文件注入 */}
float sn(float x){ return sin(x) * 0.6 + sin(x * 2.13 + 1.7) * 0.3 + sin(x * 4.7 + 0.4) * 0.1; }
void main(){
  float y = vP.y - uY0;
  if (y < 0.0) { o = vec4(0.0); return; }
  float amp = 0.04 + 0.11 * y;
  float cx = uLean.x * 1.4 + amp * sn(0.85 * y - 1.25 * uTm) + 0.4 * amp * sn(1.9 * y - 2.6 * uTm + 3.0);
  float wdt = 0.025 + 0.05 * y;
  float d = abs(vP.x - cx) / wdt;
  float fil = exp(-d * d);
  float cx2 = cx + amp * 0.5 * sn(1.3 * y - 1.7 * uTm + 5.0);
  fil += 0.5 * exp(-pow(abs(vP.x - cx2) / (wdt * 1.6), 2.0));
  float fade = smoothstep(0.0, 0.8, y) * exp(-y * 0.32);
  float lit = 1.0 / (1.0 + y * 0.6);
  o = vec4(vec3(1.0, 0.72, 0.5) * fil * fade * lit * uGain, 0.0);
}`;

export function makeCandle(ctx, shared) {
  const { THREE } = ctx;
  const group = new THREE.Group();
  const A = 112; // 环向分段
  // 剖面点数（从底到中心）
  const PROF = 22;
  const nV = A * PROF + 1; // +1：熔池中心
  const pos = new Float32Array(nV * 3), zone = new Float32Array(nV), wet = new Float32Array(nV);
  const idx = [];
  for (let j = 0; j < PROF - 1; j++) for (let i = 0; i < A; i++) {
    const a = j * A + i, b = j * A + ((i + 1) % A), c = (j + 1) * A + i, d = (j + 1) * A + ((i + 1) % A);
    idx.push(a, c, b, b, c, d);
  }
  const center = A * PROF;
  for (let i = 0; i < A; i++) idx.push((PROF - 1) * A + i, center, (PROF - 1) * A + ((i + 1) % A));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('zone', new THREE.BufferAttribute(zone, 1));
  geo.setAttribute('wet', new THREE.BufferAttribute(wet, 1));
  geo.setIndex(idx);

  const flameU = {
    uOrigin: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector2(1, 0) },
    uF0: { value: new THREE.Vector4() }, uF1: { value: new THREE.Vector4() }, uGain: { value: 1 }, uWick: { value: 1 }, uTm: { value: 0 },
  };
  const waxU = {
    uF0: flameU.uF0, uF1: flameU.uF1, uRight: flameU.uRight, uOrigin: flameU.uOrigin, uTmW: flameU.uTm, uFGain: flameU.uGain,
    uFlamePos: shared.uFlamePos, uFlameI: shared.uFlameI, uFlameCol: shared.uFlameCol,
    uDigPos: shared.uDigPos, uDigI: shared.uDigI, uDigCol: shared.uDigCol,
    uMatchPos: shared.uMatchPos, uMatchI: shared.uMatchI, uLatFill: shared.uLatFill,
    uH: { value: 11 }, uR: { value: CANDLE.R }, uRp: { value: 1 }, uPoolY: { value: 10.8 }, uAmb: { value: 0 },
    uAsh: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0.1, 0)) },
  };
  const waxMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: waxVS, fragmentShader: waxFS.replace('__FLAME__', ctx.glsl.simplex3 + candleFlameGLSL), uniforms: waxU, side: THREE.DoubleSide });
  const body = new THREE.Mesh(geo, waxMat);
  body.frustumCulled = false;
  group.add(body);

  // 蜡泪：每条一根贴着蜡体的半管
  const DL = 40, DC = 9;
  const drips = dripList(ctx.cue).map(() => {
    const n = DL * DC;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('zone', new THREE.BufferAttribute(new Float32Array(n).fill(4.0), 1));
    g.setAttribute('wet', new THREE.BufferAttribute(new Float32Array(n), 1));
    const ii = [];
    for (let j = 0; j < DL - 1; j++) for (let i = 0; i < DC - 1; i++) {
      const a = j * DC + i, b = a + 1, c = a + DC, d = c + 1;
      ii.push(a, b, c, b, d, c);
    }
    g.setIndex(ii);
    const m = new THREE.Mesh(g, waxMat);
    m.frustumCulled = false; m.visible = false;
    group.add(m);
    return m;
  });

  // 底部积蜡：一圈不规则的低矮蜡饼
  const BP = 10;
  const bpPos = new Float32Array(A * BP * 3);
  const bpGeo = new THREE.BufferGeometry();
  bpGeo.setAttribute('position', new THREE.BufferAttribute(bpPos, 3));
  bpGeo.setAttribute('zone', new THREE.BufferAttribute(new Float32Array(A * BP).fill(1.0), 1));
  bpGeo.setAttribute('wet', new THREE.BufferAttribute(new Float32Array(A * BP), 1));
  const bpi = [];
  for (let j = 0; j < BP - 1; j++) for (let i = 0; i < A; i++) {
    const a = j * A + i, b = j * A + ((i + 1) % A), c = (j + 1) * A + i, d = (j + 1) * A + ((i + 1) % A);
    bpi.push(a, c, b, b, c, d);
  }
  bpGeo.setIndex(bpi);
  const basePool = new THREE.Mesh(bpGeo, waxMat);
  basePool.frustumCulled = false;
  group.add(basePool);

  // 烛火公告板
  const quad = (x0, x1, y0, y1) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  };
  const blendPM = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation };
  const flame = new THREE.Mesh(quad(-1.7, 1.7, -0.75, 5.6), new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: flameVS, fragmentShader: flameFS, uniforms: flameU, ...blendPM }));
  flame.frustumCulled = false; flame.renderOrder = 10;
  const haloU = { uOrigin: flameU.uOrigin, uRight: flameU.uRight, uGain: { value: 1 }, uCol: { value: new THREE.Vector3(1.0, 0.5, 0.2) }, uC: { value: new THREE.Vector2(0, 1.4) } };
  const halo = new THREE.Mesh(quad(-16, 16, -12, 16), new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: flameVS, fragmentShader: haloFS, uniforms: haloU, ...blendPM, depthTest: false }));
  halo.frustumCulled = false; halo.renderOrder = 20;
  const smokeU = { uOrigin: flameU.uOrigin, uRight: flameU.uRight, uGain: { value: 0.05 }, uTm: { value: 0 }, uY0: { value: 3.4 }, uLean: { value: new THREE.Vector2() } };
  const smoke = new THREE.Mesh(quad(-3, 3, 3.0, 16), new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: flameVS, fragmentShader: smokeFS, uniforms: smokeU, ...blendPM }));
  smoke.frustumCulled = false; smoke.renderOrder = 11;
  group.add(flame, halo, smoke);

  const rimNoise = (th, H) => {
    const { noise1 } = ctx.util;
    return 0.05 * noise1(th * 2.1 + 3.0) + 0.028 * noise1(th * 5.3 + H * 0.7) + 0.01 * noise1(th * 11.0 + 7.0);
  };
  const drL = dripList(ctx.cue);

  function updateBody(st, T) {
    const R = CANDLE.R, { H, Rp, poolY } = st;
    const shoulder = Math.max(R - 0.22 - Rp, 0.0);
    // 剖面：r, y, zone, rimWeight
    const prof = [];
    const sideN = 9;
    for (let k = 0; k < sideN; k++) {
      const u = k / (sideN - 1);
      const y = (H - 0.32) * (1 - Math.pow(1 - u, 1.6));
      prof.push([R, y, 0, 0]);
    }
    prof.push([R - 0.01, H - 0.12, 0.3, 0.6]);
    prof.push([R - 0.06, H - 0.02, 0.5, 1.0]);
    prof.push([R - 0.14, H, 0.8, 1.0]);
    prof.push([R - 0.24, H - 0.05, 1.0, 0.9]);
    for (let k = 1; k <= 4; k++) {
      const u = k / 5;
      const r = R - 0.24 - shoulder * u;
      const y = H - 0.05 - (H - 0.05 - poolY - 0.02) * Math.pow(u, 1.35);
      prof.push([r, y, 1.0, 0.8 * (1 - u)]);
    }
    prof.push([Rp + 0.04, poolY + 0.012, 1.2, 0]);
    prof.push([Rp, poolY, 2, 0]);
    prof.push([Rp * 0.7, poolY, 2, 0]);
    prof.push([Rp * 0.4, poolY, 2, 0]);
    prof.push([Rp * 0.15, poolY, 2, 0]);
    while (prof.length < PROF) prof.push([0.02, poolY, 2, 0]);
    for (let i = 0; i < A; i++) {
      const th = (i / A) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const rn = rimNoise(th, H);
      // 蜡泪处杯沿有一道缺口
      let notch = 0;
      for (const d of drL) {
        if (T < d.t) continue;
        let da = Math.atan2(Math.sin(th - d.th), Math.cos(th - d.th));
        notch += 0.07 * Math.exp(-(da * da) / 0.02) * ctx.util.smoothstep(d.t, d.t + 1.2, T);
      }
      for (let j = 0; j < PROF; j++) {
        const [r, y, z, rw] = prof[j];
        const yy = y + rw * (rn - notch);
        const v = j * A + i;
        pos[v * 3] = r * c; pos[v * 3 + 1] = Math.max(yy, j < sideN ? y : poolY + 0.005); pos[v * 3 + 2] = r * s;
        zone[v] = z;
      }
    }
    pos[center * 3] = 0; pos[center * 3 + 1] = poolY; pos[center * 3 + 2] = 0; zone[center] = 2;
    geo.attributes.position.needsUpdate = true; geo.attributes.zone.needsUpdate = true;
    geo.computeVertexNormals();
    waxU.uH.value = H; waxU.uRp.value = Rp; waxU.uPoolY.value = poolY;
  }

  function updateDrips(st, T) {
    const { smoothstep, ease, clamp } = ctx.util;
    drL.forEach((d, k) => {
      const m = drips[k];
      if (T < d.t) { m.visible = false; return; }
      m.visible = true;
      const p = m.geometry.attributes.position.array, wt = m.geometry.attributes.wet.array;
      const form = smoothstep(d.t, d.t + 1.6, T);
      const run = ease.outCubic(clamp((T - d.t - 1.6) / d.run));
      const y0 = candleState(ctx.util, ctx.cue, d.t).H - 0.02;
      const len = 0.28 * form + (d.len - 0.28) * run;
      const wetv = 1 - smoothstep(d.t + d.run * 0.6, d.t + d.run + 8, T);
      const yTop = Math.min(y0, st.H - 0.1);
      const R = CANDLE.R;
      for (let j = 0; j < DL; j++) {
        const v = j / (DL - 1);
        let y = y0 - len * v;
        const yc = Math.min(y, yTop);
        // 宽度：顶部薄膜，末端水滴
        const bulb = Math.exp(-Math.pow((1 - v) * len / 0.22, 2));
        let w = (0.075 + 0.045 * v + 0.12 * bulb) * d.w * (0.4 + 0.6 * form);
        if (v > 0.985) w *= (1 - v) / 0.015;
        if (yc < 0.05) w *= 1.6;
        const h = w * (0.8 + 0.6 * bulb);
        const th = d.th + 0.018 * Math.sin(y * 1.4 + k) + 0.01 * Math.sin(y * 3.7 + k * 2);
        const nx = Math.cos(th), nz = Math.sin(th), tx = -nz, tz = nx;
        const yy = Math.max(yc, 0.02);
        for (let i = 0; i < DC; i++) {
          const ph = -Math.PI / 2 + (i / (DC - 1)) * Math.PI;
          const rr = R - 0.02 + h * Math.cos(ph);
          const q = (j * DC + i) * 3;
          p[q] = nx * rr + tx * w * Math.sin(ph);
          p[q + 1] = yy;
          p[q + 2] = nz * rr + tz * w * Math.sin(ph);
          wt[j * DC + i] = wetv;
        }
      }
      m.geometry.attributes.position.needsUpdate = true; m.geometry.attributes.wet.needsUpdate = true;
      m.geometry.computeVertexNormals();
    });
  }

  function updateBasePool(st) {
    const R = CANDLE.R, e = st.basePool;
    basePool.visible = e > 0.01;
    if (!basePool.visible) return;
    const { noise1 } = ctx.util;
    for (let i = 0; i < A; i++) {
      const th = (i / A) * Math.PI * 2;
      const ext = e * (0.75 + 0.5 * noise1(th * 1.7 + 2.0) + 0.3 * noise1(th * 4.1 + 9.0));
      for (let j = 0; j < BP; j++) {
        const u = j / (BP - 1);
        const r = R - 0.05 + ext * u;
        const y = (0.06 + 0.22 * e) * Math.pow(1 - u * u, 0.6) + 0.003;
        const q = (j * A + i) * 3;
        bpPos[q] = r * Math.cos(th); bpPos[q + 1] = y; bpPos[q + 2] = r * Math.sin(th);
      }
    }
    bpGeo.attributes.position.needsUpdate = true;
    bpGeo.computeVertexNormals();
  }

  return {
    group, body, flame, halo, smoke, waxU, flameU, haloU, smokeU,
    update(st, T, cam, fl, o = {}) {
      updateBody(st, T);
      updateDrips(st, T);
      updateBasePool(st);
      flameU.uOrigin.value.set(0, st.wickY, 0);
      const dx = cam.position.x, dz = cam.position.z;
      const l = Math.hypot(dx, dz) || 1;
      flameU.uRight.value.set(dz / l, -dx / l);
      flameU.uF0.value.fromArray(fl.f0); flameU.uF1.value.fromArray(fl.f1);
      flameU.uGain.value = o.gain ?? 1;
      flameU.uWick.value = o.wick ?? 1;
      flameU.uTm.value = T;
      haloU.uGain.value = (o.gain ?? 1) * (o.halo ?? 1) * fl.f1[3];
      smokeU.uGain.value = (o.smoke ?? 0.05) * Math.min(1, o.gain ?? 1);
      smokeU.uTm.value = T;
      smokeU.uY0.value = fl.f0[2] * 0.93;
      smokeU.uLean.value.set(fl.f0[0] * flameU.uRight.value.x + fl.f0[1] * flameU.uRight.value.y, 0);
      waxU.uAmb.value = o.amb ?? 0;
    },
  };
}
