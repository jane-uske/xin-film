// 序幕 S02「群星 / 出品方星座」+ S03「漂流」：同一片星空、同一条摄影机路径，换镜头不换世界。
//   5.0–9.0   星点依次点亮（13 颗主星按 events.astra_star_ignitions 闪亮）
//   9.5–12.5  发丝细线把星连成出品方字标（events.astra_line_ticks；文字见 timeline.credit.word）
//   16–20     连线收回，摄影机加速穿过星座，再减速成缓慢漂移
//   20–24     减速漂流，零星余烬从下方升起，交叉淡入第一幕（第二版：庄子题记移到尾声）
import * as THREE from 'three';
import { createStarfield } from '../common/starfield.js';
import { all as GLSL } from '../../engine/glsl.js';
import { makeEpigraph } from '../common/epigraph.js';
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

  // ---- 余烬：从画面下方升起，交叉淡入第一幕时被卷进分子云 ----
  const embers = makeEpigraph(ctx, camera, { ambient: { count: 340, from: 17.5, to: 26.0 } });

  return {
    render(f) {
      const T = f.T;
      // 摄影机
      const z = camZ(T);
      camera.position.set(0.25 * Math.sin(T * 0.07), 0.12 * Math.sin(T * 0.05 + 1.0), z);
      camera.rotation.set(0.004 * Math.sin(T * 0.09), 0.006 * Math.sin(T * 0.06 + 2.0), THREE.MathUtils.degToRad(-0.5 + 0.5 * Math.sin(T * 0.045)));
      camera.updateMatrixWorld();
      // 漂流段星空略收暗，让余烬成为主体
      const dim = 1 - 0.35 * smoothstep(18.5, 22.0, T);
      const nebula = (0.35 + 0.65 * smoothstep(5.5, 12, T)) * (1 - 0.25 * smoothstep(18.5, 22.0, T));
      field.update(T, camera, { intensity: dim, nebula, boost: 1.4, nodeGain: 1.0 });
      lineMat.uniforms.uT.value = T;
      lineMat.uniforms.uRetract.value = ease.inOutCubic(invLerp(15.8, 17.2, T));
      lineMat.uniforms.uGain.value = 0.9 * (1 - smoothstep(16.6, 17.4, T));
      lines.visible = T > 9.4 && T < 17.5;
      flareMat.uniforms.uT.value = T;
      flareMat.uniforms.uGain.value = 1 - smoothstep(15.5, 17.0, T);
      flares.visible = T > 4.9 && T < 17.2;
      embers.update(T);
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
        temperature: -0.15 + 0.3 * smoothstep(18.5, 23.0, T),
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
        overlay.glowText(g, '出 品', x - 22 * S, y, { font: `${overlay.TYPE.zhWeight} ${17 * S * overlay.TYPE.card}px ${overlay.FONTS.zh}`, color: overlay.COLORS.paper, alpha: a * 0.85, glow: 0.3, blur, spacing: `${6 * S}px`, align: 'right', S });
        overlay.glowText(g, '·', x, y - 1 * S, { font: `400 ${18 * S}px ${overlay.FONTS.en}`, color: overlay.COLORS.paper, alpha: a * 0.75, glow: 0, blur, align: 'center', S });
        overlay.glowText(g, 'PRESENTS', x + 22 * S, y - 1 * S, { font: `300 ${11.5 * S * overlay.TYPE.card}px ${overlay.FONTS.mono}`, color: overlay.COLORS.paper, alpha: a * 0.7, glow: 0, blur, spacing: `${5.5 * S}px`, align: 'left', S });
      }
    },

    dispose() { field.dispose(); lg.dispose(); lineMat.dispose(); fg.dispose(); flareMat.dispose(); embers.dispose(); },
  };
}

