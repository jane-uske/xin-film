// 蒲公英种子：瘦果 + 喙（细柄）+ 冠毛（放射状细丝，每根带细小侧毛）。
// 用一串串柔光点画成细丝：抗锯齿、半透明、会被两种光交替照亮。燃烧时细丝卷曲、发红、消失。
export function seedPath(util, cue) {
  const t0 = cue('seed_enter'), tD = cue('seed_through_digital'), tB = cue('seed_burn');
  // 关键帧：[时刻, x, y, z]
  return [
    [t0 - 1.0, -14.0, 18.5, 2.5],
    [t0, -10.5, 17.2, 2.0],
    [t0 + 1.6, -4.6, 15.6, 1.4],
    [tD - 1.1, 3.2, 13.6, 0.6],
    [tD, 8.0, 10.75, 0.0],
    [tD + 1.0, 10.6, 10.4, 0.5],
    [tD + 2.0, 9.4, 12.2, 1.0],
    [tD + 3.0, 5.4, 13.6, 0.8],
    [tB - 0.9, 2.5, 13.2, 0.35],
    [tB - 0.45, 1.9, 13.75, 0.2],
    [tB, 1.05, 12.75, 0.0],
    [tB + 0.6, 0.7, 13.6, 0.0],
  ];
}

export function seedAt(util, keys, T) {
  // 时间参数化的 Catmull-Rom（Hermite，切线用差分）
  let k = 0;
  while (k < keys.length - 2 && T > keys[k + 1][0]) k++;
  const a = keys[Math.max(0, k - 1)], b = keys[k], c = keys[k + 1], d = keys[Math.min(keys.length - 1, k + 2)];
  const u = util.clamp((T - b[0]) / (c[0] - b[0]), 0, 1);
  const out = [0, 0, 0];
  for (let i = 1; i <= 3; i++) {
    const m1 = (c[i] - a[i]) / Math.max(c[0] - a[0], 1e-3) * (c[0] - b[0]);
    const m2 = (d[i] - b[i]) / Math.max(d[0] - b[0], 1e-3) * (c[0] - b[0]);
    const u2 = u * u, u3 = u2 * u;
    out[i - 1] = (2 * u3 - 3 * u2 + 1) * b[i] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * c[i] + (u3 - u2) * m2;
  }
  // 气流里的细微抖动
  out[0] += 0.12 * util.fbm1(T * 0.9 + 4.0, 2);
  out[1] += 0.10 * util.fbm1(T * 1.1 + 9.0, 2);
  out[2] += 0.08 * util.fbm1(T * 0.7 + 2.0, 2);
  return out;
}

const VS = /* glsl */ `
uniform mat4 uSeedM; uniform float uBurn, uPx, uS, uAlive;
uniform vec3 uFlamePos; uniform float uFlameI; uniform vec3 uFlameCol;
uniform vec3 uDigPos; uniform float uDigI; uniform vec3 uDigCol;
in float kind; in float tpar;
out vec3 vCol;
void main(){
  vec3 p = position;
  // 燃烧：冠毛从外向内卷曲、缩短
  float b = uBurn;
  if (kind > 1.5) {
    float curl = b * (0.4 + 0.6 * tpar);
    float r = length(p.xz);
    float ang = curl * 1.9;
    vec2 dir = p.xz / max(r, 1e-4);
    float nr = r * (1.0 - 0.55 * curl);
    p.xz = dir * nr * cos(ang * 0.6);
    p.y = p.y + r * sin(ang * 0.6) * 0.9 - curl * 0.1;
  }
  vec4 w = uSeedM * vec4(p, 1.0);
  vec4 mv = viewMatrix * w;
  gl_Position = projectionMatrix * mv;
  float z = max(-mv.z, 0.5);
  gl_PointSize = max(1.0, (kind < 0.5 ? 0.07 : kind < 1.5 ? 0.026 : 0.02) * uPx / z + 0.9 * uS);
  // 光照：前向散射的半透明细丝
  vec3 V = normalize(cameraPosition - w.xyz);
  vec3 Lw = uFlamePos - w.xyz; float dw = dot(Lw, Lw); Lw = normalize(Lw);
  vec3 Lc = uDigPos - w.xyz; float dc = dot(Lc, Lc); Lc = normalize(Lc);
  float fw = 0.35 + 1.3 * pow(max(dot(-Lw, V), 0.0), 3.0) + 0.3 * max(dot(Lw, V), 0.0);
  float fc = 0.35 + 1.3 * pow(max(dot(-Lc, V), 0.0), 3.0) + 0.3 * max(dot(Lc, V), 0.0);
  float alb = kind < 0.5 ? 0.25 : kind < 1.5 ? 0.6 : 1.0;
  vec3 col = (uFlameCol * uFlameI * fw / (1.0 + 0.04 * dw) + uDigCol * uDigI * fc / (1.0 + 0.04 * dc)) * alb * 0.5;
  // 余烬：燃烧前沿沿细丝向内推进
  float front = smoothstep(0.0, 0.25, b) * (1.0 - smoothstep(0.55, 1.0, b));
  float along = kind > 1.5 ? tpar : 0.0;
  float ember = front * smoothstep(1.0 - b * 1.4 - 0.15, 1.0 - b * 1.4 + 0.05, along);
  col += vec3(1.0, 0.36, 0.06) * ember * 2.6;
  col *= (1.0 - smoothstep(0.55, 0.95, b)) * uAlive;
  vCol = col;
}`;
const FS = /* glsl */ `
precision highp float;
in vec3 vCol; out vec4 o;
void main(){ vec2 c = gl_PointCoord * 2.0 - 1.0; o = vec4(vCol * exp(-dot(c, c) * 2.4), 0.0); }`;

export function makeSeed(ctx, shared) {
  const { THREE, util } = ctx;
  const r = util.rng(4242);
  const P = [], K = [], Tp = [];
  const add = (x, y, z, k, t) => { P.push(x, y, z); K.push(k); Tp.push(t); };
  // 瘦果：纺锤形，带纵棱
  for (let i = 0; i < 60; i++) {
    const t = i / 59, y = -1.32 + t * 0.36;
    const rr = 0.045 * Math.sin(Math.PI * t) ** 0.7;
    for (let a = 0; a < 6; a++) { const ph = (a / 6) * Math.PI * 2; add(rr * Math.cos(ph), y, rr * Math.sin(ph), 0, 0); }
  }
  // 喙：细长的柄
  for (let i = 0; i < 110; i++) { const t = i / 109; add(0.004 * Math.sin(t * 9), -0.96 + t * 0.96, 0, 1, 0); }
  // 冠毛
  const nF = 84;
  for (let f = 0; f < nF; f++) {
    const az = (f / nF) * Math.PI * 2 + r.range(-0.03, 0.03);
    const el = r.range(0.22, 0.62); // 仰角
    const len = r.range(0.62, 0.8);
    const steps = 34;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const e = el + t * t * 0.35; // 末端微微上卷
      const rr = t * len * Math.cos(e), y = t * len * Math.sin(e) * 0.85 + t * 0.04;
      add(rr * Math.cos(az), y, rr * Math.sin(az), 2, t);
      // 侧毛
      if (s > 6 && s % 3 === 0) {
        for (const side of [-1, 1]) {
          for (let h = 1; h <= 3; h++) {
            const hl = h * 0.018 * (1.1 - t * 0.5);
            const az2 = az + side * hl / Math.max(rr, 0.05);
            add((rr + hl * 0.5) * Math.cos(az2), y + hl * 0.6, (rr + hl * 0.5) * Math.sin(az2), 2, t);
          }
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('kind', new THREE.Float32BufferAttribute(K, 1));
  g.setAttribute('tpar', new THREE.Float32BufferAttribute(Tp, 1));
  const u = {
    uSeedM: { value: new THREE.Matrix4() }, uBurn: { value: 0 }, uPx: { value: 1000 }, uS: { value: 1 }, uAlive: { value: 1 },
    uFlamePos: shared.uFlamePos, uFlameI: shared.uFlameI, uFlameCol: shared.uFlameCol,
    uDigPos: shared.uDigPos, uDigI: shared.uDigI, uDigCol: shared.uDigCol,
  };
  const pts = new THREE.Points(g, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  pts.frustumCulled = false; pts.renderOrder = 15;
  const keys = seedPath(util, ctx.cue);
  const q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(1.3, 1.3, 1.3), pv = new THREE.Vector3();
  return {
    pts, u, keys,
    // 返回种子中心（冠毛根部）的世界坐标
    update(T, px, S) {
      const { cue } = ctx;
      const t0 = cue('seed_enter') - 1.0, tB = cue('seed_burn');
      const alive = T >= t0 && T < tB + 0.9;
      pts.visible = alive;
      if (!alive) return null;
      const p = seedAt(util, keys, T);
      // 姿态：冠毛朝上，随气流轻轻倾斜、缓慢自转
      e.set(0.22 * util.fbm1(T * 0.5 + 1, 2) + 0.1, T * 0.35 + 0.8, 0.25 * util.fbm1(T * 0.43 + 7, 2) - 0.05);
      q.setFromEuler(e);
      pv.set(p[0], p[1], p[2]);
      u.uSeedM.value.compose(pv, q, sc);
      u.uBurn.value = util.clamp((T - tB) / 0.75, 0, 1);
      u.uPx.value = px; u.uS.value = S;
      u.uAlive.value = util.smoothstep(t0, t0 + 0.8, T);
      return p;
    },
  };
}
