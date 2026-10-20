// 庄子题记：竖排逐字"点亮"，到时逐字燃成余烬向上飘散。
// 余烬是挂在摄影机下的点精灵（摄影机坐标系），另可附带一批从画面下方升起的环境余烬。
// 第二版里题记在尾声出现（S19），序幕只用环境余烬。
import * as THREE from 'three';
import { all as GLSL } from '../../engine/glsl.js';
import { TYPE } from '../../engine/overlay.js';

const COLS = ['指穷于为薪，火传也，', '不知其尽也。'];
const SOURCE = '  ︽庄子·养生主︾';
const PUNCT = new Set(['，', '。']);
const EN_LINES = ['The fuel is spent;', 'the fire passes on.', 'No one knows where it ends.'];

// card：timeline 里的题记卡（可为 null，只要环境余烬）；burnStart：开始燃烧的时刻
// ambient：{ count, from, to } 环境余烬的数量与出生时间范围
export function makeEpigraph(ctx, camera, { card = null, burnStart = 0, ambient = null, x0f = 0.79, y0f = 0.2 } = {}) {
  const { util, overlay } = ctx;
  const W = ctx.W, H = ctx.H, S = ctx.S;
  const k = TYPE.card;
  const burnTime = (gl) => burnStart + gl.order * 0.075;

  // ---- 排版 ----
  const glyphs = [];
  if (card) {
    const size = 36 * S * k, adv = 52 * S * k, colGap = 74 * S * k;
    const x0 = W * x0f, y0 = H * y0f;
    let order = 0;
    COLS.forEach((col, ci) => {
      [...col].forEach((ch, j) => {
        const p = PUNCT.has(ch);
        glyphs.push({ ch, x: x0 - ci * colGap + (p ? 0.42 * size : 0), y: y0 + j * adv + size + (p ? -0.58 * size : 0), size, order: order++, kind: 'main' });
      });
    });
    // 出处：第三列，起笔更低，字更小
    const ss = 17 * S * k, sadv = 22 * S * k;
    [...SOURCE].forEach((ch, j) => glyphs.push({ ch, x: x0 - 2 * colGap + 6 * S, y: y0 + 6 * adv + j * sadv + ss, size: ss, order: 100 + j, kind: 'source' }));
  }

  // ---- 文字燃烧生成的余烬：在每个字的笔画像素上取样 ----
  const fromText = [];
  if (card) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    const r = util.rng(12345);
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
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 110) cand.push([x0 + x, y0 + y]);
      const n = Math.min(cand.length, Math.round(260 * S + 40));
      const tb = burnTime(gl);
      for (let j = 0; j < n; j++) {
        const p = cand[Math.floor(r() * cand.length)];
        fromText.push({ x: p[0], y: p[1], t: tb + r() * 0.35 });
      }
    }
  }

  // ---- 余烬点精灵 ----
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const D = 10;
  const screenToCam = (x, y, d = D) => [((x / W) * 2 - 1) * d * tanH * (W / H), (1 - (y / H) * 2) * d * tanH, -d];
  const amb = ambient ? ambient.count : 0, ne = amb + fromText.length;
  const ePos = new Float32Array(ne * 3), eBirth = new Float32Array(ne), eSeed = new Float32Array(ne * 3), eHeat = new Float32Array(ne);
  const er = util.rng(5150);
  for (let i = 0; i < amb; i++) {
    // 环境余烬：从画面下方升起（闭式）
    ePos.set(screenToCam(er() * W, H * (1.05 + er() * 0.1), D * (0.6 + er() * 1.8)), i * 3);
    eBirth[i] = ambient.from + er() * (ambient.to - ambient.from);
    eSeed.set([er(), er(), er()], i * 3);
    eHeat[i] = 0.35 + er() * 0.5;
  }
  fromText.forEach((e, j) => {
    const i = amb + j;
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
  const mat = new THREE.ShaderMaterial({
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
  const embers = new THREE.Points(eg, mat);
  embers.frustumCulled = false;
  camera.add(embers);

  // ---- 文字绘制 ----
  function draw(g, T) {
    if (!card || T < card.in - 0.1 || T > burnStart + 2.0) return;
    const { clamp, ease } = util;
    const paper = overlay.COLORS.paper, ember = overlay.COLORS.ember;
    for (const gl of glyphs) {
      let a;
      if (gl.kind === 'main') {
        const appear = card.in + gl.order * 0.2;
        const kk = clamp((T - appear) / 0.9);
        if (kk <= 0) continue;
        const burn = clamp((T - burnTime(gl)) / 0.32);
        a = ease.outCubic(clamp((T - appear) / 0.35)) * (1 - burn);
        if (a <= 0.001) continue;
        // 先如余烬般发暖光，再沉为纸白；燃烧时再次变热
        const heat = Math.max(1 - ease.outCubic(kk), ease.inQuad(burn) * 1.4, 0.0);
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
        a = util.envelope(T, card.in + 3.4, card.in + 4.3, burnStart - 0.4, burnStart + 0.5) * 0.62;
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
    const ea = util.envelope(T, card.in + 3.7, card.in + 4.9, burnStart - 0.6, burnStart + 0.3);
    if (ea > 0.001) {
      const blur = (1 - ease.outCubic(clamp((T - card.in - 3.7) / 1.2))) * 5;
      const x = W * 0.085, y = H * 0.74;
      const fs = 25 * S * k, lh = 34 * S * k;
      EN_LINES.forEach((ln, i) => overlay.glowText(g, ln, x, y - lh + i * lh, { font: `italic 300 ${fs}px ${overlay.FONTS.en}`, color: paper, alpha: ea * 0.82, glow: 0.18, blur, spacing: `${0.6 * S}px`, align: 'left', S }));
      overlay.glowText(g, card.enSource, x, y + 3.2 * lh, { font: `300 ${11.5 * S * k}px ${overlay.FONTS.mono}`, color: paper, alpha: ea * 0.5, glow: 0, blur, spacing: `${4 * S}px`, align: 'left', S });
    }
  }

  return {
    update(T) { mat.uniforms.uT.value = T; embers.visible = ne > 0; },
    draw,
    dispose() { camera.remove(embers); eg.dispose(); mat.dispose(); },
  };
}
