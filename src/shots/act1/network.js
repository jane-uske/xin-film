// Act I · city -> brain -> chip. One graph (somata, dendritic trees, axons) generated on a cortical
// surface and embedded three ways — flat city (azimuthal projection of the cortex), brain (3D), chip
// (orthographic squash + Manhattan routing on a grid). The same particles morph between embeddings,
// so city and brain are literally the same topology. Coordinates are patch-local: y = surface normal.
import { makeNoise3, POINT_VS, POINT_FS } from './lib.js';

export const BRAIN_C = [0, 0.72, 0];
export const DIE_Y = 0.72;
export const DIE_HALF = 0.7;
export const GRID = (DIE_HALF * 2) / 128;

export function buildNetwork(ctx, { earthR }) {
  const { THREE, util, glsl } = ctx;
  const rng = util.rng(5150);
  const noise = makeNoise3(util.rng(808));
  const [cx, cy, cz] = BRAIN_C;
  const A = 0.84, B = 0.56, Cz = 0.68; // half extents (anterior-posterior x, height y, width z)

  // ---------------------------------------------------------------- cortical surface
  function brainR(dx, dy, dz) {
    // egg-shaped ellipsoid, narrower frontal pole, flattened base
    const c = Cz * (1 - 0.1 * Math.max(dx, 0));
    let r = 1 / Math.sqrt((dx / A) ** 2 + (dy / B) ** 2 + (dz / c) ** 2);
    if (dy < -0.25) r *= 1 - 0.32 * (-dy - 0.25);
    // lift the occipital base to make room for the cerebellum (tentorium)
    r *= 1 - 0.38 * util.smoothstep(-0.15, -0.65, dx) * util.smoothstep(-0.1, -0.6, dy);
    // temporal lobes hang below the Sylvian fissure
    for (const s of [-1, 1]) {
      const ex = dx - 0.22, ey = dy + 0.5, ez = dz - s * 0.72;
      r += 0.13 * Math.exp(-(ex * ex * 0.6 + ey * ey + ez * ez) / 0.09);
    }
    // longitudinal fissure between the hemispheres
    r *= 1 - 0.16 * Math.exp(-((dz / 0.07) ** 2)) * util.smoothstep(-0.25, 0.35, dy);
    // lateral (Sylvian) sulcus
    const sy = dy - (-0.12 + 0.35 * (0.3 - dx));
    r *= 1 - 0.11 * Math.exp(-((sy / 0.045) ** 2)) * util.smoothstep(0.35, 0.7, Math.abs(dz)) * util.smoothstep(0.6, 0.0, dx) * util.smoothstep(-0.5, -0.1, dx);
    return r;
  }
  // gyri: crest lines = zero crossings of one warped noise octave (a winding maze, like cortical folds)
  const gyri = (dx, dy, dz) => {
    const wx = noise(dx * 1.7 + 4, dy * 1.7, dz * 1.7) * 0.35, wy = noise(dx * 1.7, dy * 1.7 + 9, dz * 1.7) * 0.35;
    return 1 - Math.abs(noise(dx * 4.4 + wx + 1.3, dy * 5.2 + wy, (dz + Math.sign(dz) * 0.2) * 4.4 - 2.1)) * 1.6;
  };
  function surf(dx, dy, dz, inset = 0) {
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    const g = gyri(dx, dy, dz);
    const r = brainR(dx, dy, dz) * (1 + 0.045 * (g - 0.75)) - inset;
    return [cx + dx * r, cy + dy * r, cz + dz * r, g];
  }

  // ---------------------------------------------------------------- embeddings
  const cityR = 0.78;
  const hsh = (x, y, z) => { const v = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return v - Math.floor(v); };
  function cityOf(p) {
    if (p[0] < cx - 0.22 && p[1] < cy - 0.2) {
      // cerebellum / brainstem become scattered satellite towns (their folia would print rings otherwise)
      const h1 = hsh(Math.floor(p[0] * 60), Math.floor(p[1] * 60), Math.floor(p[2] * 60));
      const h2 = hsh(Math.floor(p[2] * 60) + 3.1, Math.floor(p[0] * 60), Math.floor(p[1] * 60));
      const rho = cityR * (0.62 + 0.4 * h1), ps = h2 * Math.PI * 2;
      const jx = (hsh(p[0] * 999, p[1] * 999, p[2] * 999) - 0.5) * 0.03, jz = (hsh(p[1] * 999, p[2] * 999, p[0] * 999) - 0.5) * 0.03;
      return [rho * Math.cos(ps) + jx, -(rho * rho) / (2 * earthR) + 0.002, rho * Math.sin(ps) + jz];
    }
    const dx = (p[0] - cx) / A, dy = (p[1] - cy) / B, dz = (p[2] - cz) / Cz;
    const l = Math.hypot(dx, dy, dz) || 1;
    const th = Math.acos(util.clamp(dy / l, -1, 1)), ps = Math.atan2(dz, dx);
    const rho = cityR * Math.pow(th / Math.PI, 1.15);
    return [rho * Math.cos(ps), -(rho * rho) / (2 * earthR) + 0.002, rho * Math.sin(ps)];
  }
  // die floorplan: 6x6 tiles separated by routing gutters
  const NT = 6, PITCH = (DIE_HALF * 2) / NT, GUT = PITCH * 0.12;
  const tileSnap = (u) => {
    const k = Math.min(NT - 1, Math.max(0, Math.floor((u + DIE_HALF) / PITCH)));
    const t0 = -DIE_HALF + k * PITCH;
    return Math.min(Math.max(u, t0 + GUT), t0 + PITCH - GUT);
  };
  const gutterNear = (u) => { const k = Math.round((u + DIE_HALF) / PITCH); return -DIE_HALF + Math.min(NT - 1, Math.max(1, k)) * PITCH; };
  function chipXZ(p) {
    let u = (p[0] - cx) / (A * 1.02), v = (p[2] - cz) / (Cz * 1.02);
    const r = Math.hypot(u, v), m = Math.max(Math.abs(u), Math.abs(v));
    if (m > 1e-6) { const k = r / m; u *= k; v *= k; }
    u = util.clamp(u, -1, 1) * DIE_HALF * 0.94; v = util.clamp(v, -1, 1) * DIE_HALF * 0.94;
    u = tileSnap(u); v = tileSnap(v);
    return [Math.round(u / GRID) * GRID, Math.round(v / GRID) * GRID];
  }

  // ---------------------------------------------------------------- graph -> particles
  const P = { city: [], brain: [], chip: [], info: [], morph: [] };
  // morph delay: a wave from downtown outward. Whole edges share one delay so fibres stay lines in flight.
  let edgeDelay = null;
  const delayOf = (c) => Math.pow(util.clamp(Math.hypot(c[0], c[2]) / cityR), 0.85) * 0.9 + rng() * 0.04;
  const push = (brain, chip, type, s, phase, bright) => {
    const c = cityOf(brain);
    const dl = edgeDelay !== null ? edgeDelay : delayOf(c);
    P.city.push(c[0], c[1], c[2]);
    P.brain.push(brain[0], brain[1], brain[2]);
    P.chip.push(chip[0], DIE_Y, chip[1]);
    P.info.push(type, s, phase, bright);
    P.morph.push(dl, rng(), rng(), rng());
  };
  // Manhattan route between two snapped die points
  const route = (a, b, hFirst, s) => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.abs(dx) + Math.abs(dz) || 1;
    const d = s * L;
    if (hFirst) return Math.abs(dx) >= d ? [a[0] + Math.sign(dx) * d, a[1]] : [b[0], a[1] + Math.sign(dz) * (d - Math.abs(dx))];
    return Math.abs(dz) >= d ? [a[0], a[1] + Math.sign(dz) * d] : [a[0] + Math.sign(dx) * (d - Math.abs(dz)), b[1]];
  };
  const pushC = (city, brain, chip, type, s, phase, bright) => {
    P.city.push(city[0], city[1], city[2]);
    P.brain.push(brain[0], brain[1], brain[2]);
    P.chip.push(chip[0], DIE_Y, chip[1]);
    P.info.push(type, s, phase, bright);
    P.morph.push(edgeDelay !== null ? edgeDelay : delayOf(city), rng(), rng(), rng());
  };
  // bus: A -> nearest horizontal gutter -> across -> down to B (Z route), on its own track
  const busRoute = (a, b, gz, track, s) => {
    const z = gz + track;
    const L1 = Math.abs(z - a[1]), L2 = Math.abs(b[0] - a[0]), L3 = Math.abs(b[1] - z), L = L1 + L2 + L3 || 1;
    let d = s * L;
    if (d <= L1) return [a[0], a[1] + Math.sign(z - a[1]) * d];
    d -= L1; if (d <= L2) return [a[0] + Math.sign(b[0] - a[0]) * d, z];
    d -= L2; return [b[0], z + Math.sign(b[1] - z) * d];
  };
  const segment = (a, b, n, type, bright, curveIn = 0) => {
    const ca = chipXZ(a), cb = chipXZ(b);
    const hFirst = rng() < 0.5;
    const phase = rng();
    edgeDelay = delayOf(cityOf(a));
    if (type === 2) {
      // axons: straight highways in the city, white-matter arcs in the brain, gutter buses on the die
      const cA = cityOf(a), cB = cityOf(b);
      const gz = gutterNear((ca[1] + cb[1]) / 2), track = (Math.floor(rng() * 7) - 3) * GRID * 0.5;
      for (let k = 0; k < n; k++) {
        const s = (k + rng()) / n;
        let p = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
        const d = Math.sin(Math.PI * s) * curveIn;
        p = [p[0] + (cx - p[0]) * d + rng.gauss() * 0.003, p[1] + (cy - p[1]) * d + rng.gauss() * 0.003, p[2] + (cz - p[2]) * d + rng.gauss() * 0.003];
        const c = [cA[0] + (cB[0] - cA[0]) * s, (cA[1] + cB[1]) / 2 + 0.001, cA[2] + (cB[2] - cA[2]) * s];
        pushC(c, p, busRoute(ca, cb, gz, track, s), 2, s, phase, bright * (0.6 + 0.4 * rng()));
      }
      edgeDelay = null;
      return;
    }
    for (let k = 0; k < n; k++) {
      const s = (k + rng()) / n;
      let p = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
      if (curveIn) {
        // axons dip into the white matter
        const d = Math.sin(Math.PI * s) * curveIn;
        p = [p[0] + (cx - p[0]) * d, p[1] + (cy - p[1]) * d, p[2] + (cz - p[2]) * d];
      }
      const j = 0.004;
      p = [p[0] + rng.gauss() * j, p[1] + rng.gauss() * j, p[2] + rng.gauss() * j];
      push(p, route(ca, cb, hFirst, s), type, s, phase, bright * (0.6 + 0.4 * rng()));
    }
    edgeDelay = null;
  };

  // somata on gyral crowns (cortex) + cerebellum + brainstem
  const somata = [];
  let guard = 0;
  while (somata.length < 1500 && guard++ < 400000) {
    const [dx, dy, dz] = rng.unitVec();
    const g = gyri(dx, dy, dz);
    if (rng() > Math.pow(util.clamp((g - 0.8) / 0.2), 3)) continue;
    const s = surf(dx, dy, dz, 0.01);
    if (Math.abs(dz) < 0.03 && dy > 0) continue;
    somata.push({ p: [s[0], s[1], s[2]], n: [dx, dy, dz], size: 0.5 + rng() });
  }
  // cerebellum: fine parallel folia behind and below
  const cb0 = [cx - 0.5, cy - 0.4, cz];
  for (let i = 0; i < 230; i++) {
    let [dx, dy, dz] = rng.unitVec();
    if (dy > 0.5) dy = 0.5;
    const fol = 0.5 + 0.5 * Math.cos(dy * 38);
    if (rng() > fol) { i--; continue; }
    const p = [cb0[0] + dx * 0.26, cb0[1] + dy * 0.17, cb0[2] + dz * 0.46];
    somata.push({ p, n: [dx, dy, dz], size: 0.35 + 0.4 * rng(), cereb: true });
  }
  // brainstem
  for (let i = 0; i < 60; i++) {
    const t = rng();
    const p = [cx - 0.16 - 0.1 * t + rng.gauss() * 0.035, cy - 0.3 - 0.5 * t, cz + rng.gauss() * 0.05];
    somata.push({ p, n: [-0.2, -1, 0], size: 0.4, stem: true });
  }

  const tangentBasis = (n) => {
    const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let t1 = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
    const l1 = Math.hypot(...t1); t1 = t1.map((x) => x / l1);
    const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
    return [t1, t2];
  };
  const reproject = (p, inset) => {
    if (p.cereb) return p;
    const s = surf(p[0] - cx, p[1] - cy, p[2] - cz, inset);
    return [s[0], s[1], s[2]];
  };

  for (const so of somata) {
    // soma blob
    const nb = Math.floor(10 + 10 * so.size);
    const ca = chipXZ(so.p);
    edgeDelay = delayOf(cityOf(so.p));
    for (let k = 0; k < nb; k++) {
      const r = 0.008 * so.size;
      const p = [so.p[0] + rng.gauss() * r, so.p[1] + rng.gauss() * r, so.p[2] + rng.gauss() * r];
      // pad: 3x3 grid of vias around the snapped soma
      const px = ca[0] + (Math.floor(rng() * 3) - 1) * GRID * 0.5, pz = ca[1] + (Math.floor(rng() * 3) - 1) * GRID * 0.5;
      push(p, [px, pz], 0, 0, rng(), 1.0);
    }
    edgeDelay = null;
    // dendritic trees in the cortical tangent plane, re-projected onto the folded surface
    const [t1, t2] = tangentBasis(so.n);
    const nBr = so.stem ? 1 : 3;
    for (let b = 0; b < nBr; b++) {
      const a0 = (b / nBr) * Math.PI * 2 + rng() * 1.2;
      const grow = (from, ang, len, depth) => {
        const dir = [t1[0] * Math.cos(ang) + t2[0] * Math.sin(ang), t1[1] * Math.cos(ang) + t2[1] * Math.sin(ang), t1[2] * Math.cos(ang) + t2[2] * Math.sin(ang)];
        let to = [from[0] + dir[0] * len, from[1] + dir[1] * len, from[2] + dir[2] * len];
        if (!so.cereb && !so.stem) to = reproject(to, 0.012 + depth * 0.004);
        const n = Math.max(3, Math.round(len * 150));
        segment(from, to, n, 1, 0.75 - depth * 0.12);
        if (depth < 2) {
          const sp = 0.35 + rng() * 0.35;
          grow(to, ang + sp, len * 0.72, depth + 1);
          grow(to, ang - sp, len * 0.72, depth + 1);
        }
      };
      grow(so.p, a0, (0.03 + 0.03 * rng()) * (so.cereb ? 0.6 : 1), 0);
    }
  }
  // axons: each soma to a nearby soma (short association fibres), plus long commissural fibres
  const NS = somata.length;
  for (let i = 0; i < NS; i += 1) {
    const a = somata[i];
    let best = -1, bd = 1e9;
    for (let t = 0; t < 40; t++) {
      const j = Math.floor(rng() * NS);
      if (j === i) continue;
      const d = Math.hypot(a.p[0] - somata[j].p[0], a.p[1] - somata[j].p[1], a.p[2] - somata[j].p[2]);
      if (d > 0.08 && d < bd) { bd = d; best = j; }
    }
    if (best >= 0 && bd < 0.42) segment(a.p, somata[best].p, Math.round(bd * 70) + 4, 2, 0.5, 0.18);
  }
  for (let i = 0; i < 260; i++) {
    const a = somata[Math.floor(rng() * NS)], b = somata[Math.floor(rng() * NS)];
    if (Math.sign(a.p[2] - cz) === Math.sign(b.p[2] - cz)) continue; // cross the midline (corpus callosum)
    const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
    segment(a.p, b.p, Math.round(d * 60) + 6, 2, 0.35, 0.45);
  }

  // cortical crest points: make the gyri legible (dim streets in the city, fine logic fill on the die)
  for (let i = 0, made = 0; made < 75000 && i < 2000000; i++) {
    const [dx, dy, dz] = rng.unitVec();
    const g = gyri(dx, dy, dz);
    if (g < 0.9 + 0.07 * rng()) continue;
    const sp = surf(dx, dy, dz, 0.004 + rng() * 0.01);
    if (Math.abs(dz) < 0.035 && dy > 0) continue;
    push([sp[0], sp[1], sp[2]], chipXZ(sp), 3, rng(), rng(), 0.5 + 0.5 * util.clamp((g - 0.6) / 0.2));
    made++;
  }
  // cerebellar folia
  for (let i = 0; i < 40000; i++) {
    let [dx, dy, dz] = rng.unitVec();
    if (dy > 0.6) continue;
    const fol = Math.pow(0.5 + 0.5 * Math.cos(dy * 46 + dz * 3), 8);
    if (rng() > fol) continue;
    const p = [cb0[0] + dx * 0.26, cb0[1] + dy * 0.17, cb0[2] + dz * 0.46];
    push(p, chipXZ(p), 3, rng(), rng(), 0.8);
  }
  // brainstem: tapered column with longitudinal tracts
  for (let i = 0; i < 4500; i++) {
    const t = rng(), a = rng() * Math.PI * 2, rr = 0.075 * (1 - 0.3 * t);
    const p = [cx - 0.16 - 0.1 * t + Math.cos(a) * rr * 0.8, cy - 0.3 - 0.5 * t, cz + Math.sin(a) * rr];
    push(p, chipXZ(p), 3, rng(), rng(), 0.6);
  }
  const N = P.info.length / 4;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P.city), 3));
  geo.setAttribute('aBrain', new THREE.BufferAttribute(new Float32Array(P.brain), 3));
  geo.setAttribute('aChip', new THREE.BufferAttribute(new Float32Array(P.chip), 3));
  geo.setAttribute('aInfo', new THREE.BufferAttribute(new Float32Array(P.info), 4));
  geo.setAttribute('aMorph', new THREE.BufferAttribute(new Float32Array(P.morph), 4));

  const U = {
    uT: { value: 0 }, uCB: { value: 0 }, uBC: { value: 0 }, uGain: { value: 1 }, uS: { value: ctx.S },
    uSizeK: { value: 1 }, uPulse: { value: 0 }, uTurb: { value: 0 }, uCityLift: { value: 0 }, uThermal: { value: 0 }, uHeat: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `
      attribute vec3 aBrain, aChip; attribute vec4 aInfo, aMorph;
      uniform float uT, uCB, uBC, uGain, uSizeK, uPulse, uThermal, uHeat, uTurb;
      ${POINT_VS}
      ${glsl.simplex3}
      ${glsl.hash}
      varying vec3 vCol;
      void main(){
        float type = aInfo.x;
        // city -> brain: staggered, lifting arc, a little turbulence mid-flight
        float d1 = aMorph.x * 0.6;
        float k1 = smoothstep(d1, d1 + 0.4, uCB);
        vec3 p = mix(position, aBrain, k1);
        float mid = sin(3.14159 * k1);
        p.y += mid * 0.16;
        if (uTurb > 0.0){
          vec3 q = p * 3.0 + vec3(0.0, uT * 0.25, aMorph.w * 3.0);
          p += vec3(snoise(q), snoise(q + 17.0), snoise(q + 41.0)) * 0.05 * mid;
        }
        // brain -> chip: squash onto the die plane, then snap sideways onto the routing grid
        float d2 = aMorph.y * 0.62;
        float k2 = clamp((uBC - d2) / 0.38, 0.0, 1.0);
        float ky = smoothstep(0.0, 0.55, k2);
        float kx = smoothstep(0.45, 1.0, k2);
        kx = kx < 1.0 ? kx * kx * (1.0 + 0.6 * (1.0 - kx)) : 1.0;
        vec3 w = vec3(mix(p.x, aChip.x, kx), mix(p.y, aChip.y, ky), mix(p.z, aChip.z, kx));
        vec4 mv = modelViewMatrix * vec4(w, 1.0);
        float dist = -mv.z;

        // ---- light
        float soma = step(type, 0.5), axon = step(1.5, type) * step(type, 2.5), cortex = step(2.5, type), dend = 1.0 - soma - axon - cortex;
        // action potentials: a bright packet running along each fibre, gated per cycle
        float speed = mix(0.9, 0.45, axon);
        float cyc = uT * speed + aInfo.z * 7.0;
        float sp = fract(cyc);
        float on = step(0.55, hash11(floor(cyc) * 1.37 + aInfo.z * 91.0));
        float pulse = exp(-pow((aInfo.y - sp) * 14.0, 2.0)) * on * (1.0 - soma) * (1.0 - cortex);
        float somaFlash = soma * on * exp(-sp * 6.0);
        // city: warm sodium dots; brain: bio-luminescent warm white; chip: cold cyan
        float rho = length(position.xz);
        float downtown = 0.25 + 1.6 * exp(-rho / 0.16) + 0.4 * exp(-rho / 0.4);
        vec3 cityC = vec3(1.0, 0.58, 0.26) * (soma * 1.0 + dend * 0.36 + axon * 0.55 + cortex * 0.14) * downtown;
        cityC *= 0.25 + 0.75 * smoothstep(0.86, 0.5, rho);
        vec3 brainC = vec3(1.0, 0.80, 0.60) * (soma * 1.3 + dend * 0.13 + axon * 0.16 + cortex * 0.85)
                    + vec3(1.0, 0.92, 0.8) * (pulse * 2.8 + somaFlash * 2.0) * uPulse;
        vec3 chipC = mix(vec3(0.22, 0.75, 1.0), vec3(0.6, 0.93, 1.0), soma) * (soma * 1.2 + dend * 0.45 + axon * 0.9 + cortex * 0.12)
                   + vec3(0.8, 0.97, 1.0) * pulse * 2.2 * uPulse;
        // brain shell: dim the far side so the folds read in depth
        vec3 nrm = normalize((aBrain - vec3(${BRAIN_C.join(',')})) * vec3(1.0, 1.4, 1.2));
        vec3 vdir = normalize(cameraPosition - (modelMatrix * vec4(w, 1.0)).xyz);
        float face = mix(0.1, 1.0, smoothstep(-0.35, 0.25, dot(normalize((modelMatrix * vec4(nrm, 0.0)).xyz), vdir)));
        float faceK = mix(1.0, face, k1 * (1.0 - kx) * step(0.5, 1.0 - axon));
        vec3 c = mix(cityC, brainC, k1) * faceK;
        c = mix(c, chipC, kx);
        // thermal mode: write heat (r channel) instead of colour
        float heat = (0.55 + 0.45 * soma) * (0.7 + 0.3 * aInfo.w) * uHeat;
        c = mix(c, vec3(heat), uThermal);
        float px = (1.2 + 1.3 * aMorph.z) * (1.0 + soma * 0.6) * uSizeK * clamp(1.6 / dist, 0.55, 2.2);
        gl_PointSize = pointSize(px);
        vCol = c * aInfo.w * uGain * vAlphaK * smoothstep(0.03, 0.12, dist);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `${POINT_FS} varying vec3 vCol; void main(){ gl_FragColor = vec4(vCol * spriteMask(2.6), 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, U, N, somata: NS };
}
