// CPU 端闭式粒子：每帧由 T 直接算出位置与颜色（不累积状态）。
// 火柴火星（带运动拖尾）、火柴火苗、微尘焦外光斑、种子的灰、自燃的余烬、青烟一缕。
const MAXG = 4096;

export function makeParticles(ctx) {
  const { THREE } = ctx;
  // 发光点
  const gp = new Float32Array(MAXG * 3), gc = new Float32Array(MAXG * 3), gs = new Float32Array(MAXG);
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(gp, 3));
  gg.setAttribute('col', new THREE.BufferAttribute(gc, 3));
  gg.setAttribute('size', new THREE.BufferAttribute(gs, 1));
  const uG = { uS: { value: 1 } };
  const glow = new THREE.Points(gg, new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: uG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `in vec3 col; in float size; uniform float uS; out vec3 vC;
      void main(){ vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        float ps = max(size * uS, 1.0); gl_PointSize = ps; vC = col * min(1.0, size * uS * size * uS / (ps * ps) * 1.0); }`,
    fragmentShader: /* glsl */ `precision highp float; in vec3 vC; out vec4 o;
      void main(){ vec2 c = gl_PointCoord * 2.0 - 1.0; float r = dot(c, c); o = vec4(vC * exp(-r * 3.0), 0.0); }`,
  }));
  glow.frustumCulled = false; glow.renderOrder = 16;
  // 焦外光斑：屏幕尺寸 = 弥散圆
  const MB = 160;
  const bp = new Float32Array(MB * 3), bc = new Float32Array(MB * 3);
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(bp, 3));
  bg.setAttribute('col', new THREE.BufferAttribute(bc, 3));
  const uB = { uFocus: { value: 15 }, uAp: { value: 0.85 }, uPx: { value: 1000 }, uS: { value: 1 } };
  const bokeh = new THREE.Points(bg, new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: uB, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `in vec3 col; uniform float uFocus, uAp, uPx, uS; out vec3 vC; out float vR;
      void main(){ vec4 mv = viewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        float z = -mv.z;
        if (z < 0.6) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vC = vec3(0.0); vR = 0.0; return; }
        float coc = uAp * uPx * abs(1.0 / uFocus - 1.0 / z) + 1.5 * uS;
        coc = min(coc, 220.0 * uS);
        gl_PointSize = coc; vR = coc;
        vC = min(col * 1500.0 * uS * uS / (coc * coc + 6.0 * uS * uS), vec3(3.0)); }`,
    fragmentShader: /* glsl */ `precision highp float; in vec3 vC; in float vR; out vec4 o;
      void main(){ vec2 c = gl_PointCoord * 2.0 - 1.0; float r = length(c);
        float aa = 1.5 / max(vR, 1.0);
        float disc = 1.0 - smoothstep(1.0 - aa * 2.0, 1.0, r);
        float ring = 0.75 + 0.25 * smoothstep(0.5, 0.95, r);
        o = vec4(vC * disc * ring, 0.0); }`,
  }));
  bokeh.frustumCulled = false; bokeh.renderOrder = 30;

  let n = 0;
  const push = (x, y, z, r, g, b, s) => {
    if (n >= MAXG) return;
    gp[n * 3] = x; gp[n * 3 + 1] = y; gp[n * 3 + 2] = z;
    gc[n * 3] = r; gc[n * 3 + 1] = g; gc[n * 3 + 2] = b; gs[n] = s; n++;
  };
  const { util } = ctx;
  const R = util.rng(9001);
  const sparkL = Array.from({ length: 34 }, () => {
    const th = R.range(-2.6, 0.9), ph = R.range(-0.6, 0.6);
    const sp = R.range(12, 48);
    return { tb: R.range(0, 0.14), v: [Math.cos(th) * Math.cos(ph) * sp, Math.abs(Math.sin(th)) * sp * 0.8 + R.range(-6, 14), Math.sin(ph) * sp * 0.7],
      life: R.range(0.3, 1.15), heat: R.range(0.6, 1.2), wob: R.range(0, 100) };
  });
  const dustL = Array.from({ length: MB }, () => ({
    p: [R.range(-7, 7), R.range(-3, 5.5), R.range(6, 30)], ph: R.range(0, 100), b: R.range(0.3, 1.0),
  }));
  const ash = Array.from({ length: 5 }, (_, k) => ({
    land: [R.range(-1.6, 1.8), R.range(-0.4, 1.4)], dt: R.range(0.5, 1.15), ph: R.range(0, 10), sz: R.range(0.05, 0.1),
  }));
  const embers = Array.from({ length: 260 }, () => ({
    u: Math.pow(R(), 0.7), y: R.range(-0.2, 2.6), a: R.range(0, Math.PI * 2), sp: R.range(1.4, 4.2), out: R.range(0.3, 1.6),
    life: R.range(1.6, 3.8), ph: R.range(0, 100), heat: R.range(0.6, 1.3), chip: R() < 0.35,
  }));

  // 火柴：从右前方划燃，火苗移向烛芯，点着后撤出画面
  function matchAt(T, cue, wick) {
    const ts = cue('match_strike'), tc = cue('flame_catch');
    const M0 = [3.2, wick[1] + 1.3, 3.0];
    if (T < ts || T > tc + 1.4) return { I: 0, p: M0, on: false };
    const flash = Math.exp(-Math.max(0, T - ts) / 0.07) * 1.6;
    const approach = util.ease.inOutCubic(util.invLerp(ts + 0.15, tc, T));
    const leave = util.ease.inCubic(util.invLerp(tc + 0.1, tc + 1.3, T));
    const tgt = [wick[0] + 0.55, wick[1] + 0.35, wick[2] + 0.25];
    const p = [util.lerp(M0[0], tgt[0], approach) + leave * 9, util.lerp(M0[1], tgt[1], approach) + leave * 4, util.lerp(M0[2], tgt[2], approach) + leave * 5];
    const I = (0.7 + flash) * util.smoothstep(ts, ts + 0.03, T) * (1 - leave * 0.7);
    return { I, p, on: true, flash };
  }

  return {
    glow, bokeh, uG, uB, matchAt,
    begin() { n = 0; },
    end(S) {
      gg.setDrawRange(0, n);
      gg.attributes.position.needsUpdate = true; gg.attributes.col.needsUpdate = true; gg.attributes.size.needsUpdate = true;
      uG.uS.value = S;
      glow.visible = n > 0;
    },
    // 火星（S11）
    sparks(T, cue, origin) {
      const ts = cue('match_strike');
      if (T < ts || T > ts + 1.6) return;
      for (const s of sparkL) {
        const t = T - ts - s.tb;
        if (t < 0 || t > s.life) continue;
        const k = 3.2, gy = -70;
        for (let j = 0; j < 30; j++) {
          const tt = Math.max(0, t - j * 0.0048);
          const e = (1 - Math.exp(-k * tt)) / k;
          const x = origin[0] + s.v[0] * e + 0.3 * Math.sin(tt * 30 + s.wob);
          const y = origin[1] + s.v[1] * e + (gy / k) * (tt - e);
          const z = origin[2] + s.v[2] * e;
          const age = t / s.life;
          const heat = (1 - age) * s.heat;
          const a = (1 - j / 30) * (1 - age * age) * 5 * heat;
          push(x, y, z, a, a * (0.35 + 0.45 * heat), a * 0.12 * heat, j === 0 ? 2.6 : 1.8);
        }
      }
    },
    // 火柴火苗：一团小的暖光
    match(m) {
      if (!m.on || m.I <= 0) return;
      const [x, y, z] = m.p;
      push(x, y, z, 10 * m.I, 5.2 * m.I, 1.6 * m.I, 26);
      push(x, y + 0.3, z, 6 * m.I, 3.0 * m.I, 0.8 * m.I, 16);
      if (m.flash > 0.02) push(x, y, z, 30 * m.flash, 22 * m.flash, 12 * m.flash, 70 * m.flash + 10);
    },
    // 微尘光斑：被烛火照亮的漂浮微尘
    dust(T, cam, flamePos, I, amount, focus, px, S) {
      uB.uFocus.value = focus; uB.uPx.value = px; uB.uS.value = S;
      let k = 0;
      for (const d of dustL) {
        const x = d.p[0] + 0.9 * Math.sin(T * 0.11 + d.ph) + 0.5 * Math.sin(T * 0.23 + d.ph * 1.7);
        const y = flamePos[1] + d.p[1] + 0.7 * Math.sin(T * 0.09 + d.ph * 2.3) + ((T * 0.06 + d.ph) % 6) * 0.15;
        const z = d.p[2] + 0.8 * Math.sin(T * 0.07 + d.ph * 0.6);
        const dx = x - flamePos[0], dy = y - flamePos[1], dz = z - flamePos[2];
        const L = I * d.b * amount * 0.5 / (1 + (dx * dx + dy * dy + dz * dz) * 0.02);
        // 微尘只在火光照亮的一侧可见；稍偏暖
        bp[k * 3] = x; bp[k * 3 + 1] = y; bp[k * 3 + 2] = z;
        bc[k * 3] = L; bc[k * 3 + 1] = L * 0.72; bc[k * 3 + 2] = L * 0.46;
        k++;
      }
      bg.setDrawRange(0, k);
      bg.attributes.position.needsUpdate = true; bg.attributes.col.needsUpdate = true;
      bokeh.visible = amount > 0.001;
    },
    // 种子燃尽的闪光 + 落下的灰（落地后交给蜡材质画成灰斑）
    burn(T, cue, p0, st, ashOut) {
      const tB = cue('seed_burn');
      for (let i = 0; i < 6; i++) ashOut[i].set(0, 0, 0.1, 0);
      if (T < tB) return;
      const f = Math.exp(-(T - tB) / 0.06) * util.smoothstep(tB, tB + 0.02, T);
      if (f > 0.01) { push(p0[0] - 0.4, p0[1], p0[2], 22 * f, 15 * f, 6 * f, 12); push(p0[0] - 0.4, p0[1], p0[2], 2.5 * f, 1.2 * f, 0.4 * f, 38); }
      ash.forEach((a, k) => {
        const t = T - tB - 0.2 - k * 0.07;
        if (t < 0) return;
        const u = util.clamp(t / a.dt, 0, 1);
        const lx = a.land[0], lz = a.land[1];
        if (u < 1) {
          const x = util.lerp(p0[0] - 0.4, lx, u) + 0.12 * Math.sin(t * 9 + a.ph);
          const y = util.lerp(p0[1] - 0.2, st.poolY + 0.02, u * u * (3 - 2 * u));
          const z = util.lerp(p0[2], lz, u);
          const hot = Math.exp(-t / 0.35);
          push(x, y, z, 3 * hot + 0.01, 1.0 * hot + 0.008, 0.2 * hot + 0.006, 2.2);
        }
        // 落在熔池上，慢慢漂向池边
        const drift = util.clamp((T - tB - 1.5) / 40, 0, 1);
        const r = Math.hypot(lx, lz) || 1;
        const tr = util.lerp(r, Math.max(r, st.Rp - 0.25), drift);
        ashOut[k].set(lx / r * tr, lz / r * tr, a.sz, util.smoothstep(0.9, 1.0, u));
      });
    },
    // 青烟一缕（种子燃尽后）
    curl(T, cue, p0) {
      const tB = cue('seed_burn');
      const t = T - tB;
      if (t < 0.05 || t > 4.5) return;
      for (let i = 0; i < 90; i++) {
        const v = i / 89;
        const age = v * Math.min(t, 3.2);
        const y = p0[1] + age * 2.2;
        const ang = age * 3.4 + 1.0;
        const rad = 0.15 + age * 0.35;
        const x = p0[0] - 0.4 + Math.cos(ang) * rad * 0.9 + age * 0.35;
        const z = p0[2] + Math.sin(ang) * rad * 0.5;
        const a = 0.05 * Math.exp(-age * 0.7) * util.smoothstep(4.5, 2.5, t) * (1 - v * 0.3);
        push(x, y, z, a, a * 0.85, a * 0.75, 7 + age * 6);
      }
    },
    // 自燃的余烬：从芯片和自己的焰体上剥落，飘进黑暗
    embers(T, cue, org, gain, flameLen) {
      const a0 = cue('self_burn_start'), a1 = cue('cut_black');
      if (T < a0 || gain <= 0) return;
      for (const e of embers) {
        const tb = a0 + e.u * (a1 - a0);
        const t = T - tb;
        if (t < 0 || t > e.life) continue;
        const age = t / e.life;
        const y0 = e.chip ? -0.32 : e.y * flameLen / 3.5;
        for (let j = 0; j < 3; j++) {
          const tt = Math.max(0, t - j * 0.03);
          const x = org[0] + Math.cos(e.a) * (0.25 + e.out * tt * 0.9) + 0.35 * Math.sin(tt * 2.3 + e.ph);
          const y = org[1] + y0 + e.sp * tt + 0.25 * Math.sin(tt * 3.1 + e.ph * 0.7);
          const z = org[2] + Math.sin(e.a) * (0.25 + e.out * tt * 0.6) + 0.3 * Math.cos(tt * 1.9 + e.ph);
          const heat = (1 - age) * e.heat;
          const b = gain * heat * (1 - j / 3) * 5.0 * util.smoothstep(0, 0.1, t);
          push(x, y, z, b, b * (0.25 + 0.3 * heat), b * 0.05, j === 0 ? 2.2 : 1.6);
        }
      }
    },
    point(x, y, z, r, g, b, s) { push(x, y, z, r, g, b, s); },
  };
}
