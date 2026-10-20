// 火海：1 → 2 → 4 → 8 → … → 1,048,576 团一模一样的数据之火。
// 每个格子 (i, j) 在第 n 次倍增时出现；按出现顺序排好，任一时刻可见的集合正好是前缀 —— 绘制就是 setDrawRange / instanceCount。
// LOD：近处（第 0 排 i<8）是真实的点云火；中距离（32×32）是同一密度函数的网点公告板；远处是单个点；再远是雾里的辉光。
import { flameGLSL } from './flameModel.js';
import { DIG, gridGeometry, makePointMaterial, plinthVS, plinthFS } from './digitalFlame.js';
import { fogGLSL } from './floor.js';

export const LAT = { pitch: 10.0, maxExp: 10, farCells: 320 };

// 第 n 次倍增后的 (宽指数, 深指数)
export function dims(n) {
  if (n <= 3) return [n, 0];
  if (n <= 6) return [3, n - 3];
  const k = n - 6;
  return [3 + Math.ceil(k / 2), 3 + Math.floor(k / 2)];
}
export function birthStep(i, j) {
  for (let n = 0; n <= 20; n++) { const [a, b] = dims(n); if (i < (1 << a) && j < (1 << b)) return n; }
  return 99;
}
// 每一步的时刻（机器时间）
export function stepTimes(cue) {
  const t = [-1e9, cue('copy_2'), cue('copy_4'), cue('copy_8')];
  const a = cue('copy_cascade_start'), b = cue('copy_cascade_end');
  for (let n = 4; n <= 20; n++) t.push(a + (b - a) * Math.pow((n - 4) / 16, 0.62));
  return t;
}
export function stepAt(times, Tm) { let n = 0; for (let k = 0; k < times.length; k++) if (Tm >= times[k]) n = k; return n; }

const tierBVS = /* glsl */ `
uniform vec4 uLat; uniform float uWickY;
in vec2 iCell; in float iBirth;
out vec2 vP; out vec2 vRight; out vec3 vW; out float vNew;
uniform float uStep, uSince;
void main(){
  vec3 org = vec3(uLat.x + iCell.x * uLat.y, uWickY, -iCell.y * uLat.y);
  vec2 d = normalize(cameraPosition.xz - org.xz);
  vec2 right = vec2(d.y, -d.x);
  vec3 w = org + vec3(right.x, 0.0, right.y) * position.x + vec3(0.0, position.y, 0.0);
  vP = position.xy; vRight = right; vW = w;
  vNew = (iBirth > uStep - 0.5) ? exp(-uSince / 0.07) : 0.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const tierBFS = /* glsl */ `
precision highp float;
uniform vec4 uF0, uF1; uniform float uGain, uFade, uN, uK;
${fogGLSL}
${flameGLSL}
in vec2 vP; in vec2 vRight; in vec3 vW; in float vNew; out vec4 o;
void main(){
  // 提前退出：完全没入雾里的、以及在火焰包络之外的像素
  float dcam = length(vW - cameraPosition);
  if (uFogK > 0.0 && exp(-max(dcam - 60.0, 0.0) * uFogK) < 0.01) discard;
  {
    float s0 = flS(vP.y, uF0);
    if (s0 < -0.02 || s0 > 1.02) discard;
    float c0 = dot(flCenter(s0, vP.y, uF0, uF1), vRight);
    if (abs(vP.x - c0) > flHalfW(s0, uF0) * 1.08 + 0.06) discard;
  }
  float cx = ${(2 * DIG.box.x).toFixed(3)} / uN, cy = ${(DIG.box.y1 - DIG.box.y0).toFixed(3)} / (2.0 * uN);
  vec2 q = vec2((vP.x + ${DIG.box.x.toFixed(3)}) / cx, (vP.y - (${DIG.box.y0.toFixed(3)})) / cy);
  vec2 qc = floor(q) + 0.5;
  vec2 pc = vec2(qc.x * cx - ${DIG.box.x.toFixed(3)}, qc.y * cy + (${DIG.box.y0.toFixed(3)}));
  float fw = max(fwidth(vP.x) / cx, fwidth(vP.y) / cy);
  // 远了以后点阵小于像素：用连续场（避免摩尔纹）
  float lod = smoothstep(0.35, 0.8, fw);
  vec2 pp = mix(pc, vP, lod);
  float s = flS(pp.y, uF0);
  vec2 c2 = flCenter(s, pp.y, uF0, uF1);
  float cu = dot(c2, vRight);
  float w = flHalfW(s, uF0);
  float rn = abs(pp.x - cu) / w;
  float heat;
  float I = flLum(rn, s, heat);
  float E = mix(floor(I / 4.6 * 12.0 + 0.5) / 12.0 * 4.6, I, lod);
  vec2 f = (q - qc) * 2.0;
  float dotm = exp(-dot(f, f) * 9.0) * uK;
  float m = mix(dotm, 1.0, lod);
  vec3 col = digPalette(heat);
  vec3 e = col * E * m * uGain * (1.0 + vNew * 3.0);
  e = applyFog(e, vW) * uFade;
  o = vec4(e, 0.0);
}`;

const tierCVS = /* glsl */ `
uniform vec4 uLat; uniform float uWickY, uPx, uGain, uFade, uBright;
uniform vec3 uFogCol; uniform float uFogK;
in vec3 position;
out vec3 vCol;
void main(){
  vec3 org = vec3(uLat.x + position.x * uLat.y, uWickY + 1.3, -position.y * uLat.y);
  vec4 mv = viewMatrix * vec4(org, 1.0);
  gl_Position = projectionMatrix * mv;
  float z = max(-mv.z, 1.0);
  float wpx = 1.0 * uPx / z, hpx = 3.4 * uPx / z;
  float ps = max(1.0, max(wpx, hpx * 0.5));
  gl_PointSize = ps;
  float cover = clamp(wpx * hpx * 0.45 / (ps * ps), 0.0, 1.0);
  float d = length(org - cameraPosition);
  float fog = exp(-max(d - 60.0, 0.0) * uFogK);
  vCol = vec3(0.30, 0.82, 1.0) * uGain * 1.6 * cover * fog * uFade * uBright;
}`;
const tierCFS = /* glsl */ `
precision highp float;
in vec3 vCol; out vec4 o;
void main(){ vec2 c = gl_PointCoord * 2.0 - 1.0; o = vec4(vCol * exp(-dot(c, c) * 1.5), 0.0); }`;

export function makeLattice(ctx, shared, digital) {
  const { THREE } = ctx;
  const P = LAT.pitch;
  const group = new THREE.Group();
  const A = [], B = [], C = [];
  const N = 1 << LAT.maxExp;
  // 雾在约 30 m 处已经吞没一切；更远的格子只存在于计数器里（与地面的平均辉光里）
  const NF = LAT.farCells;
  for (let j = 0; j < NF; j++) for (let i = 0; i < NF; i++) {
    if (i === 0 && j === 0) continue;
    if (j === 0 && i < 4) A.push([i, j]);
    else if (i < 32 && j < 32) B.push([i, j]);
    else C.push([i, j]);
  }
  const sortB = (arr) => arr.map((c) => [c[0], c[1], birthStep(c[0], c[1])]).sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  const As = sortB(A), Bs = sortB(B);
  // C 很大：按出现步骤做计数排序
  const Cbuckets = Array.from({ length: 21 }, () => []);
  for (const c of C) Cbuckets[birthStep(c[0], c[1])].push(c);
  const prefix = (arr) => { const p = new Array(22).fill(0); for (const c of arr) p[c[2] + 1]++; for (let k = 1; k < 22; k++) p[k] += p[k - 1]; return p; };
  const pA = prefix(As), pB = prefix(Bs);
  const pC = new Array(22).fill(0);
  for (let k = 0; k < 21; k++) pC[k + 1] = pC[k] + Cbuckets[k].length;
  const countAt = (p, n) => p[Math.min(n + 1, 21)];

  // A：真实点云（与原初那一团同一个几何、同一套着色器）
  const lvl = DIG.levels[DIG.levels.length - 1];
  const gA = gridGeometry(THREE, lvl[0], lvl[1]);
  const offA = new Float32Array(As.length * 3);
  As.forEach((c, k) => { offA[k * 3] = c[0] * P; offA[k * 3 + 2] = -c[1] * P; });
  gA.setAttribute('iOff', new THREE.InstancedBufferAttribute(offA, 3));
  const matA = makePointMaterial(ctx);
  const ptsA = new THREE.Points(gA, matA.mat);
  ptsA.frustumCulled = false; ptsA.renderOrder = 13;

  // B：网点公告板
  const qg = new THREE.InstancedBufferGeometry();
  qg.setAttribute('position', new THREE.Float32BufferAttribute([-0.8, -0.42, 0, 0.8, -0.42, 0, 0.8, 4.3, 0, -0.8, 4.3, 0], 3));
  qg.setIndex([0, 1, 2, 0, 2, 3]);
  const cellB = new Float32Array(Bs.length * 2), birthB = new Float32Array(Bs.length);
  Bs.forEach((c, k) => { cellB[k * 2] = c[0]; cellB[k * 2 + 1] = c[1]; birthB[k] = c[2]; });
  qg.setAttribute('iCell', new THREE.InstancedBufferAttribute(cellB, 2));
  qg.setAttribute('iBirth', new THREE.InstancedBufferAttribute(birthB, 1));
  qg.instanceCount = 0;
  const uB = {
    uLat: shared.uLat, uWickY: { value: DIG.wickY }, uF0: { value: new THREE.Vector4() }, uF1: { value: new THREE.Vector4() },
    uGain: { value: 1 }, uFade: { value: 1 }, uN: { value: lvl[0] }, uK: { value: 11.5 }, uStep: { value: 0 }, uSince: { value: 10 },
    uFogK: shared.uFogK, uFogCol: shared.uFogCol,
  };
  const meshB = new THREE.Mesh(qg, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: tierBVS, fragmentShader: tierBFS, uniforms: uB, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  meshB.frustumCulled = false; meshB.renderOrder = 14;

  // C：远处的点（按出现顺序）
  const posC = new Float32Array(C.length * 3);
  let k = 0;
  for (let n = 0; n < 21; n++) for (const c of Cbuckets[n]) { posC[k++] = c[0]; posC[k++] = c[1]; posC[k++] = 0; }
  const gC = new THREE.BufferGeometry();
  gC.setAttribute('position', new THREE.BufferAttribute(posC, 3));
  gC.setDrawRange(0, 0);
  const uC = {
    uLat: shared.uLat, uWickY: { value: DIG.wickY }, uPx: { value: 1000 }, uGain: { value: 1 }, uFade: { value: 1 }, uBright: { value: 1 },
    uFogK: shared.uFogK, uFogCol: shared.uFogCol,
  };
  const ptsC = new THREE.Points(gC, new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: uC,
    vertexShader: 'precision highp float;\nuniform mat4 viewMatrix, projectionMatrix; uniform vec3 cameraPosition;\n' + tierCVS,
    fragmentShader: tierCFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  ptsC.frustumCulled = false; ptsC.renderOrder = 14;

  // 底座（A + B 范围）
  const plCells = [...As, ...Bs];
  const plGeo = new THREE.BoxGeometry(DIG.plinthHW * 2, DIG.plinthH, DIG.plinthHW * 2);
  plGeo.translate(0, DIG.plinthH / 2, 0);
  const chipGeo = new THREE.BoxGeometry(DIG.chipHW * 2, DIG.chipH, DIG.chipHW * 2);
  chipGeo.translate(0, DIG.plinthH + DIG.chipH / 2, 0);
  const mergedGeo = mergeBoxes(THREE, plGeo, chipGeo);
  const plU = {
    uFlamePos: shared.uFlamePos, uFlameI: { value: 0 }, uFlameCol: shared.uFlameCol,
    uOwnCol: shared.uLatCol, uOwnI: shared.uLatI, uOwnY: { value: DIG.wickY + 1.2 }, uOwnOff: { value: new THREE.Vector3() },
    uFogK: shared.uFogK, uFogCol: shared.uFogCol, uFade: { value: 1 },
    uLat: shared.uLat, uLatI: shared.uLatI, uLatCol: shared.uLatCol,
  };
  const plinths = new THREE.InstancedMesh(mergedGeo, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: plinthVS, fragmentShader: plinthFS, uniforms: plU }), plCells.length);
  // 实例顺序：先 A 再 B，各自按出现顺序；计数时分两段 —— 为了前缀性质，按出现步骤重新合并
  const plSorted = plCells.slice().sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  const m4 = new THREE.Matrix4();
  plSorted.forEach((c, kk) => { m4.makeTranslation(DIG.X + c[0] * P, 0, -c[1] * P); plinths.setMatrixAt(kk, m4); });
  plinths.instanceMatrix.needsUpdate = true;
  const pPl = prefix(plSorted);
  plinths.count = 0;
  plinths.frustumCulled = false;

  group.add(plinths, ptsA, meshB, ptsC);
  const times = stepTimes(ctx.cue);

  return {
    group, matA, uB, uC, plU, ptsA, meshB, ptsC, plinths, times,
    // n：当前倍增步；since：距本步开始的秒数
    update({ n, since, fl, gainA, px, fade, latI }) {
      gA.instanceCount = countAt(pA, n);
      qg.instanceCount = countAt(pB, n);
      gC.setDrawRange(0, countAt(pC, n));
      plinths.count = countAt(pPl, n);
      ptsA.visible = gA.instanceCount > 0;
      meshB.visible = qg.instanceCount > 0;
      ptsC.visible = countAt(pC, n) > 0;
      plinths.visible = plinths.count > 0;
      const u = matA.u;
      u.uF0.value.fromArray(fl.f0); u.uF1.value.fromArray(fl.f1);
      u.uOrigin.value.set(DIG.X, DIG.wickY, 0);
      u.uCell.value.fromArray(gA.userData.cell);
      u.uQ.value = 12; u.uVox.value = 0; u.uMinPx.value = 1.0; u.uGain.value = gainA; u.uPx.value = px; u.uSize.value = 0.46;
      u.uFade.value = fade; u.uFlash.value = 0;
      uB.uF0.value.fromArray(fl.f0); uB.uF1.value.fromArray(fl.f1);
      uB.uGain.value = 0.7; uB.uFade.value = fade; uB.uStep.value = n; uB.uSince.value = since;
      uC.uPx.value = px; uC.uGain.value = 1; uC.uFade.value = fade; uC.uBright.value = fl.f1[3];
      plU.uFade.value = fade;
      shared.uLatI.value = latI * fade;
    },
  };
}

function mergeBoxes(THREE, a, b) {
  const g = new THREE.BufferGeometry();
  const ga = a.toNonIndexed(), gb = b.toNonIndexed();
  const pos = new Float32Array(ga.attributes.position.count * 3 + gb.attributes.position.count * 3);
  pos.set(ga.attributes.position.array, 0); pos.set(gb.attributes.position.array, ga.attributes.position.count * 3);
  const nor = new Float32Array(pos.length);
  nor.set(ga.attributes.normal.array, 0); nor.set(gb.attributes.normal.array, ga.attributes.normal.count * 3);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}
