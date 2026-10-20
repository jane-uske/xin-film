// 尾声：S19 星海（开场推镜的镜像：后拉）、S20 片名「芯」、S21 片尾字幕。同一片星空贯穿。
//   S19  两点暖光并排像火焰般闪烁；继续后拉，越来越多成对、成簇的小火出现
//   S20  余烬笔尖按笔顺写出「心」，灯芯草般的「艹」自上落下合成「芯」，整体一亮，下方浮出 XIN
//   S21  星座出品方字标与"每一帧画面、每一个音符，皆由代码生成"
import * as THREE from 'three';
import { createStarfield } from '../common/starfield.js';
import { all as GLSL } from '../../engine/glsl.js';
import { layoutWord } from '../common/astra.js';
import { LABELS } from '../common/labels.js';

// 「芯」在 600×600 画布上（200 字重，440px，居中）的「心」部笔画中心线
const G = 600;
const HEART_STROKES = [
  { pts: [[163, 305], [152, 365], [128, 412], [106, 436]], key: 'title_xin_heart_start', d0: 0.0, d1: 0.75 },
  { pts: [[240, 279], [238, 380], [239, 452], [252, 475], [330, 480], [398, 476], [416, 466], [411, 432], [409, 398]], key: null, d0: 0.95, d1: 2.45 },
  { pts: [[287, 241], [318, 290], [344, 344]], key: null, d0: 2.65, d1: 3.2 },
  { pts: [[412, 298], [458, 350], [489, 424]], key: null, d0: 3.4, d1: 4.0 },
];
const BRUSH = 21;

function polyLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
function polyAt(pts, s) {
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (s <= l || i === pts.length - 1) { const k = Math.min(1, s / l); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]; }
    s -= l;
  }
  return pts[pts.length - 1];
}

export default async function create(ctx) {
  const { util, overlay } = ctx;
  const { clamp, invLerp, ease, smoothstep, envelope } = util;
  const W = ctx.W, H = ctx.H, S = ctx.S;
  const T0 = ctx.cue('stars_return');
  const heart0 = ctx.cue('title_xin_heart_start');
  const grass0 = ctx.cue('title_xin_grass_start'), grass1 = ctx.cue('title_xin_grass_end');
  const glowT = ctx.cue('title_glow'), latinT = ctx.cue('title_latin'), titleOut = ctx.cue('title_out');
  const credits = ctx.card('credits');
  const logo = layoutWord(ctx.timeline.credit?.word || 'ASTRA');

  const scene = new THREE.Scene();
  const field = createStarfield(ctx, { seed: 7 });
  scene.add(field.bg, field.points);
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 6000);
  scene.add(camera);
  const camZ = (T) => -200 + 26 * ease.inOutSine(clamp((T - T0) / 16)) + 0.5 * Math.max(0, T - (T0 + 16));

  // ---- 宇宙里的小火：成对、成簇，像火焰般闪烁 ----
  const r = util.rng(2026);
  const fires = [];
  const pairAt = (x, y, z, t, sep, gain) => {
    fires.push([x - sep / 2, y, z, t, r(), gain]);
    fires.push([x + sep / 2, y + (r() - 0.5) * sep * 0.3, z, t + 0.05, r(), gain]);
  };
  pairAt(0.0, -0.2, -226, -1e4, 0.55, 1.0); // 中央那一对：就是那两团火
  const NF = 150;
  for (let k = 0; k < NF; k++) {
    const t = T0 + 3.0 + 12.5 * Math.pow(k / NF, 0.55);
    let x, y;
    do { x = (r() - 0.5) * 160; y = (r() - 0.5) * 64; } while (Math.hypot(x, y * 1.6) < 5);
    const z = -182 - r() * 420;
    if (r() < 0.75) pairAt(x, y, z, t, 0.5 + r() * 0.8, 0.5 + r() * 0.6);
    else for (let j = 0; j < 3 + Math.floor(r() * 3); j++) fires.push([x + (r() - 0.5) * 1.6, y + (r() - 0.5) * 1.0, z + (r() - 0.5) * 2, t + j * 0.08, r(), 0.4 + r() * 0.4]);
  }
  const fp = new Float32Array(fires.length * 3), fi = new Float32Array(fires.length * 3);
  fires.forEach((f, i) => { fp.set(f.slice(0, 3), i * 3); fi.set(f.slice(3, 6), i * 3); });
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
  fg.setAttribute('aInfo', new THREE.BufferAttribute(fi, 3));
  const fireMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aInfo; uniform float uT, uS, uGain; varying vec3 vCol;
      ${GLSL}
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = -mv.z;
        float age = uT - aInfo.x;
        float on = smoothstep(0.0, 1.2, age);
        float ph = aInfo.y * 40.0;
        float fl = 0.72 + 0.18 * snoise(vec3(uT * 2.3, ph, 0.0)) + 0.1 * sin(uT * 13.0 + ph);
        float I = aInfo.z * on * fl * pow(55.0 / dist, 1.25) * 1.7 * uGain;
        vCol = blackbody(1850.0 + 250.0 * aInfo.y) * I;
        gl_PointSize = uS * clamp(3.0 + 3.0 * log2(1.0 + I), 2.0, 22.0);
        gl_Position = projectionMatrix * mv;
        if (I < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main(){ vec2 d = gl_PointCoord - 0.5; float r2 = dot(d, d) * 4.0; float a = exp(-r2 * 7.0) + exp(-r2 * 1.6) * 0.12; gl_FragColor = vec4(vCol * a, 1.0); }`,
    uniforms: { uT: { value: 0 }, uS: { value: S }, uGain: { value: 1 } },
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const firePts = new THREE.Points(fg, fireMat);
  firePts.frustumCulled = false;
  scene.add(firePts);

  // ---- 片名「芯」----
  const strokes = HEART_STROKES.map((s) => ({ ...s, t0: heart0 + s.d0, t1: heart0 + s.d1, L: polyLen(s.pts) }));
  const strokeHead = (T) => {
    for (const s of strokes) {
      if (T >= s.t0 && T <= s.t1) return polyAt(s.pts, s.L * ease.inOutSine((T - s.t0) / (s.t1 - s.t0)));
    }
    return null;
  };
  const mkCanvas = () => { const c = document.createElement('canvas'); c.width = G; c.height = G; return c; };
  const drawGlyph = (g) => { g.font = `200 440px ${overlay.FONTS.zh}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.fillText('芯', G / 2, G / 2); };
  const heartC = mkCanvas(), grassC = mkCanvas(), revealC = mkCanvas();
  { const g = heartC.getContext('2d'); g.beginPath(); g.rect(0, 243, G, G - 243); g.rect(268, 228, 67, 15); g.clip(); drawGlyph(g); }
  { const g = grassC.getContext('2d'); g.beginPath(); g.rect(0, 0, G, 243); g.rect(268, 228, 67, 15); g.clip('evenodd'); drawGlyph(g); }
  // 每个像素第一次被笔刷扫到的时间，编码进灰度（白 = 从未）
  {
    const g = revealC.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, G, G);
    g.globalCompositeOperation = 'darken';
    const span = 12;
    for (const s of strokes) {
      for (let t = s.t0; t <= s.t1 + 1e-6; t += 0.004) {
        const [x, y] = polyAt(s.pts, s.L * ease.inOutSine(clamp((t - s.t0) / (s.t1 - s.t0))));
        const v = Math.round(clamp((t - heart0 + 1) / span) * 254);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.beginPath(); g.arc(x, y, BRUSH, 0, Math.PI * 2); g.fill();
      }
    }
  }
  const tex = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; return t; };
  const heartT = tex(heartC), grassT = tex(grassC), revealT = tex(revealC);
  const D = 330 * S; // 屏幕上的方框边长
  const cy = H * 0.455;
  const titleMat = ctx.passMaterial(/* glsl */ `
    precision highp float; in vec2 vUv; out vec4 o;
    uniform sampler2D tHeart, tGrass, tReveal;
    uniform vec2 uRes, uCenter; uniform float uSize, uT, uHeart0, uSpan, uGrassOff, uGrassA, uGlow, uFade, uHeadOn;
    uniform vec2 uHead;
    ${GLSL}
    void main(){
      vec2 px = vUv * uRes;
      vec2 uv = (px - uCenter) / uSize + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < -0.3 || uv.y > 1.0) { o = vec4(0.0); return; }
      float rv = texture(tReveal, uv).r;
      float tReveal = uHeart0 - 1.0 + rv * uSpan;
      float age = uT - tReveal;
      float shown = rv < 0.999 ? smoothstep(0.0, 0.05, age) : 0.0;
      float heart = texture(tHeart, uv).a * shown;
      vec2 guv = uv + vec2(0.0, uGrassOff);
      float grass = (guv.y >= 0.0 && guv.y <= 1.0) ? texture(tGrass, guv).a * uGrassA : 0.0;
      // 新写出的笔画是热的，随后冷却为纸白
      float heat = rv < 0.999 ? exp(-max(age, 0.0) * 2.2) : 0.0;
      vec3 paper = vec3(0.93, 0.90, 0.85);
      vec3 col = heart * mix(paper * 1.05, blackbody(2300.0) * 5.0, heat) + grass * paper * 1.05;
      // 整体一亮
      float a = max(heart, grass);
      col += a * blackbody(2600.0) * uGlow * 3.2;
      // 笔尖：一点余烬
      vec2 d = (uv - uHead) * vec2(1.0, 1.0) * 600.0;
      float tip = exp(-dot(d, d) / 260.0) * 6.0 + exp(-dot(d, d) / 2600.0) * 0.6;
      col += blackbody(2100.0) * tip * uHeadOn;
      o = vec4(col * uFade, 1.0);
    }`, {
    tHeart: { value: heartT }, tGrass: { value: grassT }, tReveal: { value: revealT },
    uRes: { value: new THREE.Vector2(W, H) }, uCenter: { value: new THREE.Vector2(W / 2, H - cy) }, uSize: { value: D },
    uT: { value: 0 }, uHeart0: { value: heart0 }, uSpan: { value: 12 }, uGrassOff: { value: 0 }, uGrassA: { value: 0 }, uGlow: { value: 0 }, uFade: { value: 1 }, uHeadOn: { value: 0 },
    uHead: { value: new THREE.Vector2() },
  }, { transparent: true, blending: THREE.AdditiveBlending });

  // 片名阶段落下的几粒余烬（笔尖掉落的火星）
  return {
    render(f) {
      const T = f.T;
      camera.position.set(0.2 * Math.sin(T * 0.05), 0.1 * Math.sin(T * 0.04), camZ(T));
      camera.rotation.set(0.003 * Math.sin(T * 0.07), 0.004 * Math.sin(T * 0.05), THREE.MathUtils.degToRad(0.4 * Math.sin(T * 0.04)));
      camera.updateMatrixWorld();
      const titlePhase = smoothstep(heart0 - 2.0, heart0, T);
      const creditPhase = smoothstep(credits.in - 1.5, credits.in, T);
      const dim = 1 - 0.55 * titlePhase - 0.1 * creditPhase;
      field.update(T, camera, { intensity: dim, nebula: 0.85 * dim, nodeGain: 1 });
      fireMat.uniforms.uT.value = T;
      fireMat.uniforms.uGain.value = 1 - 0.6 * titlePhase;
      ctx.renderer.setRenderTarget(f.target);
      ctx.renderer.render(scene, camera);

      if (T > heart0 - 0.2 && T < titleOut + 1.2) {
        const u = titleMat.uniforms;
        u.uT.value = T;
        u.uGrassA.value = ease.outCubic(invLerp(grass0, grass1, T));
        u.uGrassOff.value = -0.16 * (1 - ease.outCubic(invLerp(grass0, grass1, T)));
        u.uGlow.value = Math.exp(-Math.pow((T - glowT) / 0.32, 2)) + 0.12 * smoothstep(glowT, glowT + 0.6, T);
        u.uFade.value = 1 - ease.inOutSine(invLerp(titleOut, titleOut + 1.0, T));
        const head = strokeHead(T);
        u.uHeadOn.value = head ? 1 : 0;
        if (head) u.uHead.value.set(head[0] / G, 1 - head[1] / G);
        const ac = ctx.renderer.autoClear; ctx.renderer.autoClear = false;
        ctx.fsq.render(ctx.renderer, titleMat, f.target);
        ctx.renderer.autoClear = ac;
      }
      return {
        exposure: 1.0, bloom: 0.8, bloomThreshold: 0.6, bloomKnee: 0.5, bloomRadius: 1.05,
        streak: 0.1 + 0.35 * Math.exp(-Math.pow((T - glowT) / 0.4, 2)), streakTint: [1.0, 0.62, 0.35],
        vignette: 0.45, grain: 0.04, ca: 0.0006, saturation: 0.95, temperature: 0.1,
        fade: ease.inOutSine(invLerp(T0, T0 + 3.0, T)) * (1 - ease.inOutSine(invLerp(credits.out - 0.6, credits.out + 1.0, T))),
      };
    },

    overlay(g, f) {
      const T = f.T;
      // XIN
      const la = envelope(T, latinT, latinT + 1.4, titleOut, titleOut + 0.9);
      if (la > 0.001) {
        const blur = (1 - ease.outCubic(clamp((T - latinT) / 1.4))) * 4;
        overlay.glowText(g, 'XIN', W / 2 + 9 * S, cy + D * 0.5 + 34 * S, { font: `300 ${19 * S}px ${overlay.FONTS.en}`, color: overlay.COLORS.paper, alpha: la * 0.8, glow: 0.25, blur, spacing: `${18 * S}px`, S });
      }
      // 「芯」的三层意思，晚半拍浮现
      const sa = envelope(T, latinT + 0.9, latinT + 2.1, titleOut, titleOut + 0.9);
      if (sa > 0.001) {
        const blur = (1 - ease.outCubic(clamp((T - latinT - 0.9) / 1.2))) * 4;
        const y0 = cy + D * 0.5 + 72 * S;
        overlay.glowText(g, LABELS.title.zh, W / 2 + 4 * S, y0, { font: `300 ${15 * S}px ${overlay.FONTS.zh}`, color: overlay.COLORS.paper, alpha: sa * 0.72, glow: 0.15, blur, spacing: `${8 * S}px`, S });
        overlay.glowText(g, LABELS.title.en, W / 2 + 3 * S, y0 + 24 * S, { font: `300 ${9.5 * S}px ${overlay.FONTS.mono}`, color: overlay.COLORS.paper, alpha: sa * 0.45, glow: 0, blur, spacing: `${5 * S}px`, S });
      }
      // 片尾
      const ca = envelope(T, credits.in, credits.in + 1.3, credits.out - 1.0, credits.out);
      if (ca > 0.001) drawCredits(g, T, ca, credits, logo, W, H, S, overlay);
    },

    dispose() { field.dispose(); fg.dispose(); fireMat.dispose(); heartT.dispose(); grassT.dispose(); revealT.dispose(); titleMat.dispose(); },
  };
}

function drawCredits(g, T, a, card, logo, W, H, S, overlay) {
  const paper = overlay.COLORS.paper;
  // 小号星座字标
  const sc = Math.min(30, 150 / logo.width) * S, ox = W / 2 - (logo.width * sc) / 2, oy = H * 0.40;
  const P = (n) => [ox + n.x * sc, oy - n.y * sc];
  g.save();
  g.lineWidth = Math.max(1, 0.9 * S);
  g.strokeStyle = overlay.rgba(paper, a * 0.42);
  g.beginPath();
  logo.segs.forEach((sg) => { const p = P(logo.nodes[sg.a]), q = P(logo.nodes[sg.b]); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); });
  g.stroke();
  logo.nodes.forEach((n) => {
    const [x, y] = P(n);
    const rg = g.createRadialGradient(x, y, 0, x, y, 5 * S);
    rg.addColorStop(0, overlay.rgba([255, 250, 240], a)); rg.addColorStop(0.35, overlay.rgba([220, 230, 255], a * 0.35)); rg.addColorStop(1, overlay.rgba([200, 220, 255], 0));
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, 5 * S, 0, Math.PI * 2); g.fill();
  });
  g.restore();
  overlay.glowText(g, card.zh, W / 2 + 4 * S, H * 0.57, { font: `300 ${21 * S}px ${overlay.FONTS.zh}`, color: paper, alpha: a * 0.88, glow: 0.2, spacing: `${7 * S}px`, S });
  overlay.glowText(g, card.en, W / 2, H * 0.57 + 38 * S, { font: `italic 300 ${19 * S}px ${overlay.FONTS.en}`, color: paper, alpha: a * 0.66, glow: 0.12, spacing: `${0.8 * S}px`, S });
}
