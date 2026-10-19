// 序幕 S02「群星 / 出品方星座」+ S03「薪火（题记）」：同一片星空、同一条摄影机路径，换镜头不换世界。
//   5.0–9.0   星点依次点亮（13 颗主星按 events.astra_star_ignitions 闪亮）
//   9.5–12.5  发丝细线把星连成出品方字标（events.astra_line_ticks；文字见 timeline.credit.word）
//   16–20     连线收回，摄影机加速穿过星座，再减速成缓慢漂移
//   20.6–27   竖排题记逐字被"点亮"；27 起逐字燃成余烬向上飘散
import * as THREE from 'three';
import { createStarfield } from '../common/starfield.js';
import { all as GLSL } from '../../engine/glsl.js';
import { layoutWord } from '../common/astra.js';

// ---- 出品方星座 ----
const LOGO_Z = -40, LOGO_Y0 = -0.9, LOGO_MAX_W = 19.5;

// ---- 摄影机：位置是时间的闭式函数 ----
const V0 = 0.55, VP = 30, B0 = 16, B1 = 20;
function camZ(T) {
  if (T <= 5) return 0;
  if (T <= B0) return -V0 * (T - 5);
  const zb = -V0 * (B0 - 5);
  if (T <= B1) {
    const d = B1 - B0, u = (T - B0) / d;
    return zb - V0 * (T - B0) - VP * d * (u / 2 - Math.sin(2 * Math.PI * u) / (4 * Math.PI));
  }
  const d = B1 - B0;
  return zb - V0 * d - VP * d * 0.5 - V0 * (T - B1);
}

// ---- 题记竖排 ----
const COLS = ['指穷于为薪，火传也，', '不知其尽也。'];
const SOURCE = '  ︽庄子·养生主︾';
const PUNCT = new Set(['，', '。']);

export default async function create(ctx) {
  const { util, overlay } = ctx;
  const { clamp, invLerp, ease, smoothstep } = util;
  const W = ctx.W, H = ctx.H, S = ctx.S;
  const ign = ctx.timeline.events.astra_star_ignitions;
  const ticks = ctx.timeline.events.astra_line_ticks;
  const TICK_DUR = 0.21;

  // 节点：每个字形每个节点一颗星
  const logo = layoutWord(ctx.timeline.credit?.word || 'ASTRA');
  const LOGO_SCALE = Math.min(3.8, LOGO_MAX_W / logo.width);
  const toWorld = (x, y) => [(x - logo.width / 2) * LOGO_SCALE, LOGO_Y0 + y * LOGO_SCALE, LOGO_Z];
  const r = util.rng(99);
  const nodes = logo.nodes.map((n) => ({ pos: toWorld(n.x, n.y), bright: 0.55 + r() * 0.25, temp: 6500 + r() * 4000, ignite: 6.0 + r() * 3.0, connect: 1e4 }));
  // 13 颗主星：第一颗是首字最高的节点，其余均匀取样后打乱
  const N = nodes.length;
  const firstGlyph = logo.nodes.filter((n) => n.li === logo.nodes[0].li);
  const first = logo.nodes.indexOf(firstGlyph.reduce((m, n) => (n.y > m.y ? n : m), firstGlyph[0]));
  const pool = [...new Set(Array.from({ length: 13 }, (_, k) => Math.round((k * (N - 1)) / 12)))].filter((i) => i !== first);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const heroes = [first, ...pool].slice(0, ign.length);
  heroes.forEach((ni, k) => { const nd = nodes[ni]; nd.ignite = ign[k]; nd.bright = k === 0 ? 1.6 : 1.05; nd.temp = k === 0 ? 9000 : nd.temp; });

  // 线段：按顺序平均分进 14 个 tick；每段 4 个顶点（屏幕空间加宽的细线，抗锯齿）
  const segs = [];
  const NS = logo.segs.length;
  ticks.forEach((t0, ti) => {
    const grp = logo.segs.slice(Math.floor((ti * NS) / ticks.length), Math.floor(((ti + 1) * NS) / ticks.length));
    grp.forEach((sg, gi) => {
      const ts = t0 + (TICK_DUR * gi) / grp.length, te = t0 + (TICK_DUR * (gi + 1)) / grp.length;
      const na = logo.nodes[sg.a], nb = logo.nodes[sg.b];
      segs.push({ a: toWorld(na.x, na.y), b: toWorld(nb.x, nb.y), ts, te });
      // 线到达时点亮节点
      nodes[sg.a].connect = Math.min(nodes[sg.a].connect, ts); nodes[sg.b].connect = Math.min(nodes[sg.b].connect, te);
    });
  });
  // 没有连线的节点（如小数点）跟随前一个节点点亮
  nodes.forEach((nd, i) => { if (nd.connect > 1e3) nd.connect = i > 0 ? nodes[i - 1].connect + 0.08 : ticks[0]; });

  const field = createStarfield(ctx, { seed: 7, igniteFrom: 5.25, igniteTo: 9.6, nodes });
  // 第一颗星之前，天空里没有任何东西
  const scene = new THREE.Scene();
  scene.add(field.bg);
  scene.add(field.points);

  const lp = [], lo = [], ls = [], la = [], lt = [], idx = [];
  segs.forEach((s, k) => {
    const v = [[s.a, s.b, -1, 0], [s.a, s.b, 1, 0], [s.b, s.a, -1, 1], [s.b, s.a, 1, 1]];
    v.forEach(([p, q, side, along]) => { lp.push(...p); lo.push(...q); ls.push(side); la.push(along); lt.push(s.ts, s.te); });
    const o = k * 4; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  });
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lg.setAttribute('aOther', new THREE.Float32BufferAttribute(lo, 3));
  lg.setAttribute('aSide', new THREE.Float32BufferAttribute(ls, 1));
  lg.setAttribute('aAlong', new THREE.Float32BufferAttribute(la, 1));
  lg.setAttribute('aTime', new THREE.Float32BufferAttribute(lt, 2));
  lg.setIndex(idx);
  const lineMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aOther; attribute float aSide, aAlong; attribute vec2 aTime;
      uniform vec2 uRes; uniform float uWidth;
      varying float vSide, vAlong; varying vec2 vTime;
      void main(){
        vec4 a = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 b = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
        vec2 sa = a.xy / a.w * uRes, sb = b.xy / b.w * uRes;
        vec2 dir = normalize(sb - sa) * (aAlong > 0.5 ? -1.0 : 1.0);
        vec2 nrm = vec2(-dir.y, dir.x);
        a.xy += nrm * aSide * uWidth / uRes * a.w;
        gl_Position = a; vSide = aSide; vAlong = aAlong; vTime = aTime;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uRetract, uGain;
      varying float vSide, vAlong; varying vec2 vTime;
      void main(){
        float p = clamp((uT - vTime.x) / max(vTime.y - vTime.x, 1e-3), 0.0, 1.0);
        float head = p;
        if (vAlong > head || vAlong < uRetract) discard;
        float edge = 1.0 - smoothstep(0.15, 1.0, abs(vSide));
        // 笔头更亮，像正在被画出
        float tip = 1.0 + 3.0 * exp(-pow((head - vAlong) * 18.0, 2.0)) * step(p, 0.999);
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.82) * edge * tip * uGain, 1.0);
      }`,
    uniforms: { uRes: { value: new THREE.Vector2(W / 2, H / 2) }, uWidth: { value: 1.7 * S }, uT: { value: 0 }, uRetract: { value: 0 }, uGain: { value: 0.9 } },
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const lines = new THREE.Mesh(lg, lineMat);
  lines.frustumCulled = false;
  scene.add(lines);

  // 主星的变形宽银幕横向光晕：屏幕空间细长四边形
  const fp = [], fc = [], ft = [], fi = [];
  heroes.forEach((ni, k) => {
    const nd = nodes[ni];
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([cx, cy]) => { fp.push(...nd.pos); fc.push(cx, cy); ft.push(nd.ignite, k === 0 ? 1.0 : 0.38); });
    const o = k * 4; fi.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  });
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
  fg.setAttribute('aCorner', new THREE.Float32BufferAttribute(fc, 2));
  fg.setAttribute('aInfo', new THREE.Float32BufferAttribute(ft, 2));
  fg.setIndex(fi);
  const flareMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec2 aCorner, aInfo; uniform vec2 uRes, uSize; varying vec2 vC; varying vec2 vInfo;
      void main(){
        vec4 c = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        c.xy += aCorner * uSize / uRes * c.w;
        gl_Position = c; vC = aCorner; vInfo = aInfo;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uGain; varying vec2 vC; varying vec2 vInfo;
      void main(){
        float age = uT - vInfo.x;
        if (age < 0.0) discard;
        float env = (mix(0.08, 0.22, step(0.9, vInfo.y)) + 1.6 * exp(-age * 1.5)) * vInfo.y * smoothstep(0.0, 0.05, age);
        float x = abs(vC.x), y = vC.y;
        float line = (exp(-x * 5.0) * 0.7 + exp(-x * x * 40.0) * 0.8) * exp(-y * y * 9.0);
        gl_FragColor = vec4(vec3(0.42, 0.62, 1.0) * line * env * uGain, 1.0);
      }`,
    uniforms: { uRes: { value: new THREE.Vector2(W / 2, H / 2) }, uSize: { value: new THREE.Vector2(560 * S, 4.5 * S) }, uT: { value: 0 }, uGain: { value: 1 } },
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const flares = new THREE.Mesh(fg, flareMat);
  flares.frustumCulled = false;
  scene.add(flares);

  const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 6000);
  scene.add(camera);

  // ---- 余烬：挂在摄影机下（摄影机坐标系），环境余烬 + 文字燃烧生成的余烬 ----
  const tanH = Math.tan(THREE.MathUtils.degToRad(15));
  const D = 10; // 余烬所在深度
  const screenToCam = (x, y, d = D) => [((x / W) * 2 - 1) * d * tanH * (W / H), (1 - (y / H) * 2) * d * tanH, -d];

  const glyphs = layoutEpigraph(W, H, S);
  const emberSrc = sampleGlyphs(glyphs, W, H, S);
  const amb = 340, ne = amb + emberSrc.length;
  const ePos = new Float32Array(ne * 3), eBirth = new Float32Array(ne), eSeed = new Float32Array(ne * 3), eHeat = new Float32Array(ne);
  const er = util.rng(5150);
  for (let i = 0; i < amb; i++) {
    // 环境余烬：从画面下方升起，循环出现（闭式）
    const p = screenToCam(er() * W, H * (1.05 + er() * 0.1), D * (0.6 + er() * 1.8));
    ePos.set(p, i * 3);
    eBirth[i] = 19.0 + er() * 13.0;
    eSeed.set([er(), er(), er()], i * 3);
    eHeat[i] = 0.35 + er() * 0.5;
  }
  emberSrc.forEach((e, k) => {
    const i = amb + k;
    ePos.set(screenToCam(e.x, e.y), i * 3);
    eBirth[i] = e.t;
    eSeed.set([er(), er(), er()], i * 3);
    eHeat[i] = 1.0;
  });
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
  eg.setAttribute('aBirth', new THREE.BufferAttribute(eBirth, 1));
  eg.setAttribute('aSeed', new THREE.BufferAttribute(eSeed, 3));
  eg.setAttribute('aHeat', new THREE.BufferAttribute(eHeat, 1));
  const emberMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute float aBirth, aHeat; attribute vec3 aSeed;
      uniform float uT, uS, uGain;
      varying vec3 vCol;
      ${GLSL}
      void main(){
        float age = uT - aBirth;
        float life = mix(3.2, 6.5, aSeed.x) * mix(1.0, 0.75, aHeat);
        vec3 p = position;
        bool fromText = aHeat > 0.99;
        float rise = fromText ? (0.10 * age + 0.07 * age * age) : (0.22 + 0.25 * aSeed.y) * age;
        p.y += rise;
        p += curl3(position * 0.35 + vec3(0.0, age * 0.18, aSeed.z * 9.0)) * 0.05 * age * (fromText ? 1.3 : 0.9);
        p.x += sin(age * (1.0 + aSeed.y) + aSeed.z * 6.28) * 0.03 * age;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float k = age / life;
        float alive = step(0.0, age) * (1.0 - smoothstep(0.7, 1.0, k));
        float flick = 0.75 + 0.25 * sin(uT * (9.0 + aSeed.x * 7.0) + aSeed.y * 30.0);
        float temp = mix(fromText ? 2600.0 : 2000.0, 1100.0, clamp(k * 1.2, 0.0, 1.0));
        float I = (fromText ? 2.6 : 1.1) * aHeat * exp(-k * 2.2) * flick * alive * uGain;
        I *= fromText ? (0.6 + 2.5 * exp(-age * 5.0)) : smoothstep(0.0, 0.6, age);
        vCol = blackbody(temp) * I;
        gl_PointSize = uS * (fromText ? 2.4 : 2.0 + 1.4 * aSeed.x) * (10.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
        if (I < 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main(){ vec2 d = gl_PointCoord - 0.5; float a = exp(-dot(d, d) * 14.0); gl_FragColor = vec4(vCol * a, 1.0); }`,
    uniforms: { uT: { value: 0 }, uS: { value: S }, uGain: { value: 1 } },
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const embers = new THREE.Points(eg, emberMat);
  embers.frustumCulled = false;
  camera.add(embers);

  const ep = ctx.card('epigraph');

  return {
    render(f) {
      const T = f.T;
      // 摄影机
      const z = camZ(T);
      camera.position.set(0.25 * Math.sin(T * 0.07), 0.12 * Math.sin(T * 0.05 + 1.0), z);
      camera.rotation.set(0.004 * Math.sin(T * 0.09), 0.006 * Math.sin(T * 0.06 + 2.0), THREE.MathUtils.degToRad(-0.5 + 0.5 * Math.sin(T * 0.045)));
      camera.updateMatrixWorld();
      // 题记期间星空收暗，让位给文字
      const dimEpi = 1 - 0.45 * util.envelope(T, 19.5, 21.5, 28.5, 31.5);
      const nebula = (0.35 + 0.65 * smoothstep(5.5, 12, T)) * (1 - 0.3 * util.envelope(T, 19.5, 21.5, 28.5, 31.5));
      field.update(T, camera, { intensity: dimEpi, nebula, boost: 1.4, nodeGain: 1.0 });
      lineMat.uniforms.uT.value = T;
      lineMat.uniforms.uRetract.value = ease.inOutCubic(invLerp(15.8, 17.2, T));
      lineMat.uniforms.uGain.value = 0.9 * (1 - smoothstep(16.6, 17.4, T));
      lines.visible = T > 9.4 && T < 17.5;
      flareMat.uniforms.uT.value = T;
      flareMat.uniforms.uGain.value = 1 - smoothstep(15.5, 17.0, T);
      flares.visible = T > 4.9 && T < 17.2;
      emberMat.uniforms.uT.value = T;
      embers.visible = T > 19.0;
      ctx.renderer.setRenderTarget(f.target);
      ctx.renderer.render(scene, camera);

      // 调色：第一颗星之后才有光；首星与连线时有变形宽银幕光晕
      const firstStar = Math.exp(-Math.max(0, T - ign[0]) * 1.4) * (T >= ign[0] ? 1 : 0);
      return {
        exposure: 1.0,
        bloom: 0.75, bloomThreshold: 0.55, bloomKnee: 0.5, bloomRadius: 1.05,
        streak: 0.12 + 0.9 * firstStar + 0.18 * util.envelope(T, 9.4, 10, 12.6, 13.8),
        streakTint: [0.38, 0.6, 1.0],
        vignette: 0.42, grain: 0.04, ca: 0.0006, saturation: 0.95,
        temperature: -0.15 + 0.35 * util.envelope(T, 19.5, 22, 28, 31.5),
        fade: T < ign[0] - 0.05 ? 0 : 1,
      };
    },

    overlay(g, f) {
      const T = f.T;
      // 「出品 · PRESENTS」：跟随星座底部
      const a = util.envelope(T, 12.7, 13.9, 15.4, 16.3);
      if (a > 0.001) {
        const [x, y] = ctx.project(new THREE.Vector3(0, LOGO_Y0 - 1.25, LOGO_Z), camera);
        const blur = (1 - Math.min(1, ease.outCubic(invLerp(12.7, 13.9, T)))) * 5;
        overlay.glowText(g, '出 品', x - 22 * S, y, { font: `300 ${17 * S}px ${overlay.FONTS.zh}`, color: overlay.COLORS.paper, alpha: a * 0.85, glow: 0.3, blur, spacing: `${6 * S}px`, align: 'right', S });
        overlay.glowText(g, '·', x, y - 1 * S, { font: `400 ${18 * S}px ${overlay.FONTS.en}`, color: overlay.COLORS.paper, alpha: a * 0.75, glow: 0, blur, align: 'center', S });
        overlay.glowText(g, 'PRESENTS', x + 22 * S, y - 1 * S, { font: `300 ${11.5 * S}px ${overlay.FONTS.mono}`, color: overlay.COLORS.paper, alpha: a * 0.7, glow: 0, blur, spacing: `${5.5 * S}px`, align: 'left', S });
      }
      if (T > ep.in - 0.1 && T < 28.6) drawEpigraph(g, T, glyphs, ep, util, overlay, S, W, H);
    },

    dispose() { field.dispose(); lg.dispose(); lineMat.dispose(); fg.dispose(); flareMat.dispose(); eg.dispose(); emberMat.dispose(); },
  };
}

// ---- 题记排版与绘制 ----
function layoutEpigraph(W, H, S) {
  const size = 36 * S, adv = 52 * S, colGap = 74 * S;
  const x0 = W * 0.79, y0 = H * 0.21;
  const glyphs = [];
  let order = 0;
  COLS.forEach((col, ci) => {
    [...col].forEach((ch, k) => {
      const p = PUNCT.has(ch);
      glyphs.push({ ch, x: x0 - ci * colGap + (p ? 0.42 * size : 0), y: y0 + k * adv + size + (p ? -0.58 * size : 0), size, order: order++, kind: 'main' });
    });
  });
  // 出处：第三列，起笔更低，字更小
  const ss = 17 * S, sadv = 22 * S;
  [...SOURCE].forEach((ch, k) => glyphs.push({ ch, x: x0 - 2 * colGap + 6 * S, y: y0 + 6 * adv + k * sadv + ss, size: ss, order: 100 + k, kind: 'source' }));
  return glyphs;
}

// 文字燃烧时间：主文逐字自上而下
const burnTime = (gl) => 27.0 + gl.order * 0.075;

function sampleGlyphs(glyphs, W, H, S) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  const out = [];
  const r = (() => { let a = 12345; return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  for (const gl of glyphs) {
    if (gl.kind !== 'main') continue;
    g.clearRect(0, 0, W, H);
    g.font = `300 ${gl.size}px "Noto Serif SC"`;
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(gl.ch, gl.x, gl.y);
    const x0 = Math.max(0, Math.floor(gl.x - gl.size)), y0 = Math.max(0, Math.floor(gl.y - gl.size * 1.2));
    const w = Math.min(W - x0, Math.ceil(gl.size * 2)), h = Math.min(H - y0, Math.ceil(gl.size * 1.6));
    const d = g.getImageData(x0, y0, w, h).data;
    const cand = [];
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (d[(y * w + x) * 4 + 3] > 110) cand.push([x0 + x, y0 + y]);
    const n = Math.min(cand.length, Math.round(260 * S + 40));
    const tb = burnTime(gl);
    for (let k = 0; k < n; k++) {
      const p = cand[Math.floor(r() * cand.length)];
      out.push({ x: p[0], y: p[1], t: tb + r() * 0.35 });
    }
  }
  return out;
}

function drawEpigraph(g, T, glyphs, ep, util, overlay, S, W, H) {
  const { clamp, invLerp, ease } = util;
  const paper = overlay.COLORS.paper, ember = overlay.COLORS.ember;
  for (const gl of glyphs) {
    let appear, a;
    if (gl.kind === 'main') {
      appear = ep.in + gl.order * 0.2;
      const k = clamp((T - appear) / 0.9);
      if (k <= 0) continue;
      const tb = burnTime(gl);
      const burn = clamp((T - tb) / 0.32);
      a = ease.outCubic(clamp((T - appear) / 0.35)) * (1 - burn);
      if (a <= 0.001) continue;
      // 先如余烬般发暖光，再沉为纸白；燃烧时再次变热
      const heat = Math.max(1 - ease.outCubic(k), ease.inQuad(burn) * 1.4, 0.0);
      const col = paper.map((c, i) => Math.round(c + (ember[i] - c) * clamp(heat)));
      g.save();
      g.font = `300 ${gl.size}px ${overlay.FONTS.zh}`;
      g.textAlign = 'center';
      g.filter = `blur(${(10 + 6 * heat) * S}px)`;
      g.fillStyle = overlay.rgba(col, a * (0.22 + 0.55 * heat));
      g.fillText(gl.ch, gl.x, gl.y);
      g.filter = 'none';
      g.fillStyle = overlay.rgba(col, a);
      g.fillText(gl.ch, gl.x, gl.y);
      g.restore();
    } else {
      appear = 24.0;
      a = util.envelope(T, appear, appear + 0.9, 26.6, 27.5) * 0.62;
      if (a <= 0.001) continue;
      g.save();
      g.fillStyle = overlay.rgba(paper, a);
      if (gl.order === 100) {
        // 竖排破折号：两字高的一条细线
        g.fillRect(gl.x - 0.5 * S, gl.y - gl.size * 0.95, Math.max(1, 1 * S), gl.size * 2.1);
      } else if (gl.ch.trim()) {
        g.font = `300 ${gl.size}px ${overlay.FONTS.zh}`;
        g.textAlign = 'center';
        g.fillText(gl.ch, gl.x, gl.y);
      }
      g.restore();
    }
  }
  // 英文：左下
  const ea = util.envelope(T, 24.3, 25.5, 26.4, 27.3);
  if (ea > 0.001) {
    const blur = (1 - ease.outCubic(clamp((T - 24.3) / 1.2))) * 5;
    const x = W * 0.085, y = H * 0.77;
    const enLines = ['The fuel is spent;', 'the fire passes on.', 'No one knows where it ends.'];
    enLines.forEach((ln, i) => overlay.glowText(g, ln, x, y - 34 * S + i * 34 * S, { font: `italic 300 ${25 * S}px ${overlay.FONTS.en}`, color: paper, alpha: ea * 0.82, glow: 0.18, blur, spacing: `${0.6 * S}px`, align: 'left', S }));
    overlay.glowText(g, ep.enSource, x, y + 108 * S, { font: `300 ${11.5 * S}px ${overlay.FONTS.mono}`, color: paper, alpha: ea * 0.5, glow: 0, blur, spacing: `${4 * S}px`, align: 'left', S });
  }
}
