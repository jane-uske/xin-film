// 壹 · 热 / I · HEAT — one continuous 62 s take (S04–S10):
// molecular cloud -> accretion disk -> ignition -> star -> Earth -> city -> brain -> chip -> datacenter.
// Every frame is a pure function of f.T. All times come from timeline cues.
import { buildCosmos, SUN_R } from './cosmos.js';
import { integrate, norm3, add3, sub3, mul3, len3, dot3, cross3, lerp3 } from './lib.js';
import { buildEarth, EARTH_R } from './earth.js';
import { buildNetwork, BRAIN_C, DIE_Y } from './network.js';
import { buildDatacenter, MM } from './datacenter.js';
import { catmull } from './lib.js';

export default async function create(ctx) {
  const { THREE, util, overlay } = ctx;
  const { clamp, lerp, invLerp, smoothstep, ease } = util;
  const C = (n) => ctx.cue(n);
  const cue = {
    start: C('collapse_start'), implode: C('implode'), ignite: C('ignite'), hud1: C('star_hud_1'), hud2: C('star_hud_2'),
    pull: C('pullback_start'), earth: C('earth_arrive'), sunrise: C('sunrise'), dive: C('city_dive'), brain: C('brain_form'),
    brainHud: C('brain_hud'), snap: C('silicon_snap'), gpuHud: C('gpu_hud'), dc: C('datacenter_reveal'), dcHud: C('datacenter_hud'),
    cardIn: C('card_c1_in'), cardOut: C('card_c1_out'), fade: C('act1_fade'), cut: C('hum_cut'),
  };

  const scene = new THREE.Scene();
  // a geometry sharing another's attribute buffers but drawing only every k-th point
  function strided(geo, k) {
    const g2 = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) g2.setAttribute(name, geo.attributes[name]);
    const n = geo.attributes.position.count, m = Math.floor(n / k);
    const idx = new Uint32Array(m);
    for (let i = 0; i < m; i++) idx[i] = i * k;
    g2.setIndex(new THREE.BufferAttribute(idx, 1));
    return g2;
  }
  const cam = new THREE.PerspectiveCamera(30, ctx.W / ctx.H, 0.1, 30000);
  const cos = buildCosmos(ctx, scene);

  // JS mirror of glsl.blackbody (normalised, linear)
  function blackbody(K) {
    const t = K / 100;
    const r = t <= 66 ? 1 : clamp(1.29293618606 * Math.pow(t - 60, -0.1332047592));
    const g = t <= 66 ? clamp(0.39008157876 * Math.log(t) - 0.63184144378) : clamp(1.12989086089 * Math.pow(t - 60, -0.0755148492));
    const b = t >= 66 ? 1 : t <= 19 ? 0 : clamp(0.54320678911 * Math.log(t - 10) - 1.19625408914);
    return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
  }

  // ------------------------------------------------------------------ cosmic camera (disk / star)
  const rotRate = (t) => (t < cue.ignite ? 0.35 + 1.5 * Math.pow(smoothstep(cue.start + 1, cue.implode, t), 2) : 0.06);
  function diskCam(T) {
    const az = -0.55 + 0.024 * (T - cue.start) + 0.06 * smoothstep(cue.start, cue.ignite, T);
    let d = lerp(62, 37, ease.inOutSine(invLerp(cue.start, cue.implode, T)));
    d = lerp(d, 34, ease.inOutSine(invLerp(cue.implode, cue.ignite, T)));
    d = lerp(d, 30.5, ease.outCubic(invLerp(cue.ignite, cue.pull, T)));
    const el = lerp(0.27, 0.22, smoothstep(cue.start, cue.implode, T)) - 0.14 * ease.inOutSine(invLerp(cue.ignite, cue.ignite + 5, T));
    const p = [Math.cos(az) * Math.cos(el) * d, Math.sin(el) * d, Math.sin(az) * Math.cos(el) * d];
    // camera-right vector in the disk plane, used to push the star right of frame centre
    const right = [-Math.sin(az), 0, Math.cos(az)];
    const off = 3.4 * ease.inOutSine(invLerp(cue.ignite + 0.5, cue.ignite + 4, T)) + 0.6 * smoothstep(cue.ignite + 4, cue.pull, T);
    const lift = -1.2 * (1 - smoothstep(cue.start, cue.implode, T));
    let l = [right[0] * off, lift, right[2] * off];
    // implosion tremor
    const sh = 0.10 * Math.pow(smoothstep(cue.implode, cue.ignite, T), 2) * (T < cue.ignite ? 1 : 0)
      + 0.22 * Math.exp(-Math.max(0, T - cue.ignite) * 3) * (T >= cue.ignite ? 1 : 0);
    if (sh > 0) {
      l = [l[0] + util.noise1(T * 23) * sh, l[1] + util.noise1(T * 19 + 9) * sh, l[2] + util.noise1(T * 21 + 4) * sh];
    }
    return { p, l, u: [0, 1, 0], fov: 30 };
  }

  function applyCam(c) {
    cam.position.set(c.p[0], c.p[1], c.p[2]);
    cam.up.set(c.u[0], c.u[1], c.u[2]);
    cam.lookAt(c.l[0], c.l[1], c.l[2]);
    cam.fov = c.fov;
    cam.near = c.near || 0.1; cam.far = c.far || 30000;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  // prominence footpoints: fixed in world space on the limb as seen from mid-shot
  {
    const c = diskCam((cue.hud1 + cue.pull) / 2);
    const v = new THREE.Vector3(...c.p).normalize();
    const r = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), v).normalize();
    const u = new THREE.Vector3().crossVectors(v, r).normalize();
    const th = THREE.MathUtils.degToRad(48), sp = THREE.MathUtils.degToRad(14);
    const mk = (a) => r.clone().multiplyScalar(Math.cos(a)).add(u.clone().multiplyScalar(Math.sin(a))).add(v.clone().multiplyScalar(0.12)).normalize();
    cos.promU.uF1.value.copy(mk(th - sp));
    cos.promU.uF2.value.copy(mk(th + sp));
    cos.promU.uUp.value.copy(r.clone().multiplyScalar(Math.cos(th)).add(u.clone().multiplyScalar(Math.sin(th))).normalize());
  }

  // ------------------------------------------------------------------ pull-back / Earth geometry
  // Axes: X = sun -> camera at pullback_start (the camera retreats straight back along it, so the star
  // shrinks in place), O = direction the camera rises to graze Earth's limb, L = lateral swing axis.
  const P58 = diskCam(cue.pull);
  const AX = norm3(P58.p);
  const AY = norm3(sub3([0, 1, 0], mul3(AX, AX[1])));
  const AZ = cross3(AX, AY);
  const phiO = THREE.MathUtils.degToRad(-18);
  const AO = norm3(add3(mul3(AY, Math.cos(phiO)), mul3(AZ, Math.sin(phiO))));
  const AL = cross3(AX, AO);
  const EDIST = 800;
  const E = mul3(AX, EDIST);
  // sun elevation above Earth's limb (degrees) for a camera at E + AX*a + AO*h
  function sunElev(a, h) {
    const rel = add3(mul3(AX, a), mul3(AO, h));
    const cp = add3(E, rel);
    const dS = norm3(mul3(cp, -1)), dE = norm3(mul3(rel, -1));
    const beta = Math.acos(clamp(dot3(dS, dE), -1, 1));
    const alpha = Math.asin(clamp(EARTH_R / len3(rel), 0, 1));
    return THREE.MathUtils.radToDeg(beta - alpha);
  }
  function hFor(a, elev) {
    let lo = 0, hi = 30;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (sunElev(a, m) < elev) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  const elevAt = (T) => {
    let e = lerp(-2.0, -0.45, ease.inOutSine(invLerp(cue.earth - 0.5, cue.sunrise, T)));
    e = lerp(e, 0.75, ease.inOutSine(invLerp(cue.sunrise, cue.dive + 0.5, T)));
    return e;
  };
  const aAt = (T) => lerp(33, 29.5, ease.inOutSine(invLerp(cue.earth, cue.dive + 1, T)));
  function earthCam(T) {
    const a = aAt(T), h = hFor(a, elevAt(T));
    const rel = add3(mul3(AX, a), mul3(AO, h));
    const p = add3(E, rel);
    const dS = norm3(mul3(p, -1)), dE = norm3(mul3(rel, -1));
    // frame: Earth a little left of centre and low, the sun high on the upper-right limb
    const look = norm3(add3(lerp3(dS, dE, 0.74), mul3(AL, 0.02)));
    return { p, l: add3(p, look), u: AO, fov: 30 };
  }
  // 58 -> 62: the only fast move of the film: retreat in log-distance, lateral swing, settle behind Earth
  const EC0 = earthCam(cue.earth);
  const endX = dot3(EC0.p, AX), endH = dot3(EC0.p, AO);
  const d58 = norm3(sub3(P58.l, P58.p));
  const sunOff = sub3(d58, norm3(mul3(P58.p, -1)));
  function pullCam(T) {
    const u = invLerp(cue.pull, cue.earth, T);
    const ex = ease.inOutCubic(Math.pow(u, 0.85));
    const x = Math.exp(lerp(Math.log(len3(P58.p)), Math.log(endX), ex));
    const w = Math.pow(u, 0.75);
    const zl = 85 * 16 * w * w * (1 - w) * (1 - w);
    const hh = endH * ease.inOutSine(clamp((u - 0.25) / 0.75));
    const p = add3(add3(mul3(AX, x), mul3(AO, hh)), mul3(AL, zl));
    const dS = norm3(mul3(p, -1));
    const dSun = norm3(add3(dS, mul3(sunOff, 1 - smoothstep(0.1, 0.6, u))));
    const dFin = norm3(sub3(EC0.l, EC0.p));
    const k = ease.inOutSine(clamp((u - 0.45) / 0.55));
    const look = norm3(lerp3(dSun, dFin, k));
    return { p, l: add3(p, look), u: norm3(lerp3([0, 1, 0], AO, k)), fov: 30 };
  }

  // the dive target: a metro on the visible night face, lower-left of the disk centre
  const patchN = (() => {
    const toCam = norm3(sub3(EC0.p, E));
    return norm3(add3(toCam, mul3(AO, -0.36)));
  })();
  const earth = buildEarth(ctx, scene, { E, patchN });
  earth.sunU.value.set(...norm3(mul3(E, -1)));

  // ------------------------------------------------------------------ patch-local frame (city / brain / chip / datacenter)
  const PO = add3(E, mul3(patchN, EARTH_R));
  const yL = patchN;
  const zL = norm3(sub3(sub3(EC0.p, PO), mul3(yL, dot3(sub3(EC0.p, PO), yL))));
  const xL = cross3(yL, zL);
  const ML = new THREE.Matrix4().makeBasis(new THREE.Vector3(...xL), new THREE.Vector3(...yL), new THREE.Vector3(...zL)).setPosition(...PO);
  const MLi = ML.clone().invert();
  const toW = (v) => { const q = new THREE.Vector3(...v).applyMatrix4(ML); return [q.x, q.y, q.z]; };
  const toL = (v) => { const q = new THREE.Vector3(...v).applyMatrix4(MLi); return [q.x, q.y, q.z]; };
  const dirL = (v) => { const q = new THREE.Vector3(...v).transformDirection(MLi); return [q.x, q.y, q.z]; };
  const local = new THREE.Group();
  local.matrixAutoUpdate = false; local.matrix.copy(ML); local.matrixWorldNeedsUpdate = true;
  scene.add(local);
  const net = buildNetwork(ctx, { earthR: EARTH_R });
  local.add(net.points);
  const netFarU = Object.assign({}, net.U, { uGain: { value: 1 } });
  const netFarMat = net.points.material.clone(); netFarMat.uniforms = netFarU;
  const netFar = new THREE.Points(strided(net.points.geometry, 3), netFarMat);
  netFar.frustumCulled = false;
  local.add(netFar);
  const debrisU = Object.assign({}, cos.cloudU, { uGain: { value: 1 } });
  const debrisMat = cos.cloud.material.clone(); debrisMat.uniforms = debrisU;
  const debris = new THREE.Points(strided(cos.cloud.geometry, 3), debrisMat);
  debris.frustumCulled = false;
  scene.add(debris);

  // spherical camera around the brain centre (local coords)
  const orbit = (az, el, D, look = BRAIN_C) => ({ p: [BRAIN_C[0] + D * Math.cos(el) * Math.sin(az), BRAIN_C[1] + D * Math.sin(el), BRAIN_C[2] + D * Math.cos(el) * Math.cos(az)], l: look, u: [0, 1, 0], fov: 30 });
  const DIVE_END = { p: [0.0, 1.3, 1.05], l: [0, 0.0, -0.08], u: [0, 1, 0], fov: 30 };
  const BRAIN_A = orbit(0.30, 0.26, 3.2);
  const brainOrbit = (T) => {
    const k = ease.inOutSine(invLerp(cue.brainHud - 0.5, cue.snap, T));
    return orbit(lerp(0.30, 0.62, k), lerp(0.26, 0.34, k), lerp(3.2, 2.95, k));
  };
  function localCam(T) {
    if (T < cue.brain) {
      // dive: log-distance approach to the metro, tilting down onto it
      const c0 = earthCam(cue.dive);
      const p0 = toL(c0.p), l0d = dirL(norm3(sub3(c0.l, c0.p))), u0 = dirL(c0.u);
      const u = invLerp(cue.dive, cue.brain, T);
      const e = ease.inOutCubic(u);
      const d0 = len3(p0), d1 = len3(DIVE_END.p);
      const dir = norm3(lerp3(norm3(p0), norm3(DIVE_END.p), ease.inOutSine(u)));
      const p = mul3(dir, Math.exp(lerp(Math.log(d0), Math.log(d1), e)));
      const tgtDir = norm3(sub3(DIVE_END.l, p));
      const look = norm3(lerp3(l0d, tgtDir, ease.inOutSine(clamp(u / 0.7))));
      return { p, l: add3(p, look), u: norm3(lerp3(u0, [0, 1, 0], ease.inOutSine(u))), fov: 30, near: Math.max(0.02, len3(p) * 0.01), far: 30000 };
    }
    if (T < cue.brainHud - 0.5) {
      const k = ease.inOutSine(invLerp(cue.brain - 0.2, cue.brainHud - 0.6, T));
      const k2 = ease.inOutSine(invLerp(cue.brain - 0.2, cue.brainHud - 0.6, T));
      return { p: lerp3(DIVE_END.p, BRAIN_A.p, k2), l: lerp3(DIVE_END.l, BRAIN_A.l, k), u: [0, 1, 0], fov: 30 };
    }
    if (T < cue.snap) return brainOrbit(T);
    const k = ease.inOutSine(invLerp(cue.snap, cue.gpuHud + 0.3, T));
    const b = brainOrbit(cue.snap);
    const chip = orbit(1.32, 0.98, 2.3, [0, DIE_Y, 0]);
    return { p: lerp3(b.p, chip.p, k), l: lerp3(b.l, chip.l, k), u: [0, 1, 0], fov: 30, near: 0.02, far: 3000 };
  }
  // ------------------------------------------------------------------ thermal world (datacenter)
  const heatScene = new THREE.Scene();
  const heatLocal = new THREE.Group();
  heatLocal.matrixAutoUpdate = false; heatLocal.matrix.copy(ML);
  heatScene.add(heatLocal);
  const dc = buildDatacenter(ctx);
  dc.group.position.set(0, DIE_Y, 0); dc.group.scale.setScalar(MM);
  heatLocal.add(dc.group);
  const netHeatU = Object.assign({}, net.U, { uThermal: { value: 1 }, uHeat: { value: 1 }, uGain: { value: 1 } });
  const netHeatMat = net.points.material.clone(); netHeatMat.uniforms = netHeatU;
  const netHeat = new THREE.Points(net.points.geometry, netHeatMat);
  netHeat.frustumCulled = false;
  heatLocal.add(netHeat);
  const L = dc.layout;
  const mmToL = (v) => [v[0] * MM, DIE_Y + v[1] * MM, v[2] * MM];
  const BCX = (L.BLD.x0 + L.BLD.x1) / 2, BCZ = (L.BLD.z0 + L.BLD.z1) / 2;
  const HALLC = [L.hall0[0] + L.HALLX / 2, -200, L.hall0[2] + L.HALLZ / 2];
  const T_PO = cue.gpuHud + 0.5; // pull-out start (the cold chip holds for a beat under the HUD)
  const chipOrbitMM = (az, el, D) => [D * Math.cos(el) * Math.sin(az), D * Math.sin(el), D * Math.cos(el) * Math.cos(az)];
  function pullOutMM(T) {
    const e = ease.inOutSine(invLerp(T_PO, cue.dcHud + 1.0, T));
    const D = Math.exp(lerp(Math.log(2.3 / MM), Math.log(60000), e));
    const az = lerp(1.32, 1.62, e), el = lerp(0.98, 1.22, smoothstep(T_PO, cue.dc, T));
    const tgt = lerp3([0, 0, 0], HALLC, smoothstep(T_PO + 1.7, cue.dc + 1.4, T));
    return { p: add3(tgt, chipOrbitMM(az, el, D)), l: tgt };
  }
  // the hall: elevated, over the hot aisle next to our rack, looking down the rows into warm haze
  const HZ = L.rack0[2] - L.PITCHZ / 2;
  function hallMM(T) {
    const d = Math.max(0, T - cue.dc) * 700;
    return { p: [L.rack0[0] - 5200 + d, 2300 + 250 * Math.max(0, T - cue.dc), HZ - 1700], l: [L.rack0[0] + 16000 + d, -1900, HZ + 2300] };
  }
  const T_CR = cue.dc + 0.6;
  const H0 = hallMM(T_CR);
  const CR = [
    H0.p,
    [H0.p[0] + 6000, L.FLOOR + 48000, H0.p[2] - 4000],
    [BCX - 6000, L.FLOOR + 50000, L.BLD.z1 + 125000],
    [BCX - 2000, L.FLOOR + 40000, L.BLD.z1 + 185000],
    [BCX + 4000, L.FLOOR + 44000, L.BLD.z1 + 205000],
  ];
  const CRL = [
    H0.l,
    [BCX - 4000, L.FLOOR, BCZ + 6000],
    [BCX + 8000, L.FLOOR + 6000, BCZ],
    [BCX - 8000, L.FLOOR + 40000, BCZ],
    [BCX - 24000, L.FLOOR + 92000, BCZ - 20000],
  ];
  function craneMM(T) {
    const u = invLerp(T_CR, cue.fade + 1, T);
    const k = 1 - Math.pow(1 - u, 3);
    return { p: catmull(CR, k), l: catmull(CRL, k) };
  }
  function dcCamLocal(T) {
    const a = pullOutMM(T);
    const h = hallMM(T);
    const wH = ease.inOutSine(invLerp(T_PO + 0.9, cue.dc + 0.35, T));
    let p = lerp3(a.p, h.p, wH), l = lerp3(a.l, h.l, wH);
    if (T > T_CR) {
      const c = craneMM(T);
      const wC = ease.inOutSine(invLerp(T_CR, T_CR + 1.8, T));
      p = lerp3(p, c.p, wC); l = lerp3(l, c.l, wC);
    }
    const D = Math.min(len3(sub3(p, l)), Math.max(200, p[1] - L.FLOOR)) * MM;
    return { p: mmToL(p), l: mmToL(l), u: [0, 1, 0], fov: 30, near: Math.max(0.004, D * 0.02), far: Math.max(200, len3(sub3(p, l)) * MM * 400) };
  }

  const camWorld = (c) => ({ p: toW(c.p), l: toW(c.l), u: norm3(new THREE.Vector3(...c.u).transformDirection(ML).toArray()), fov: c.fov, near: c.near, far: c.far });

  // visible fraction of the sun's disc from the actual camera (it sets behind the limb during the dive)
  function sunFrac(T) {
    const c = cosmicCam(T).p;
    const rel = sub3(c, E);
    const dS = norm3(mul3(c, -1)), dE = norm3(mul3(rel, -1));
    const beta = Math.acos(clamp(dot3(dS, dE), -1, 1)), alpha = Math.asin(clamp(EARTH_R / len3(rel), 0, 1));
    return smoothstep(-0.5, 0.4, THREE.MathUtils.radToDeg(beta - alpha));
  }
  function cosmicCam(T) {
    if (T < cue.pull) return diskCam(T);
    if (T < cue.earth) return pullCam(T);
    if (T < cue.dive) return earthCam(T);
    if (T < T_PO) return camWorld(localCam(T));
    return camWorld(dcCamLocal(T));
  }

  // sunspot groups, fixed on the rotating photosphere so they face the camera mid-shot
  {
    const tRef = (cue.hud1 + cue.pull) / 2;
    const c = diskCam(tRef);
    const v = new THREE.Vector3(...c.p).normalize();
    const r = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), v).normalize();
    const u = new THREE.Vector3().crossVectors(v, r).normalize();
    const rot = tRef * 0.012;
    const toQ = (d) => new THREE.Vector3(d.x * Math.cos(rot) - d.z * Math.sin(rot), d.y, d.x * Math.sin(rot) + d.z * Math.cos(rot)).normalize();
    const at = (a, b) => toQ(v.clone().add(r.clone().multiplyScalar(a)).add(u.clone().multiplyScalar(b)).normalize());
    const spots = [
      [at(-0.28, -0.22), 0.075], [at(-0.19, -0.26), 0.045], [at(-0.34, -0.17), 0.024],
      [at(0.22, 0.30), 0.056], [at(0.285, 0.265), 0.03], [at(0.17, 0.345), 0.018],
    ];
    spots.forEach(([d, w], i) => cos.starU.uSpot.value[i].set(d.x, d.y, d.z, w));
  }
  let lastCam = null;

  // ------------------------------------------------------------------ per-beat updates
  function updateCosmos(T) {
    const U = cos.cloudU;
    const sinceIg = T - cue.ignite;
    U.uT.value = T;
    U.uCollapse.value = Math.pow(smoothstep(cue.start + 0.5, cue.implode, T), 1.25);
    U.uG.value = integrate(rotRate, cue.start, Math.min(T, cue.pull + 4), 120);
    const impAt = (t) => (t < cue.implode ? 0 : invLerp(cue.implode, cue.ignite - 0.17, t));
    U.uImp.value = impAt(T);
    // radial streaks during the infall (tail = same motion 70 ms earlier)
    const stOn = T > cue.implode + 0.15 && T < cue.ignite - 0.12;
    cos.streaks.visible = stOn;
    if (stOn) {
      cos.stkU.uImpT.value = impAt(T - 0.07);
      cos.stkU.uGT.value = integrate(rotRate, cue.start, T - 0.07, 120);
      const kk = impAt(T);
      cos.stkU.uStreak.value = 0.16 * smoothstep(0.1, 0.5, kk) * (1 - smoothstep(0.88, 1.0, kk));
    }
    U.uShock.value = sinceIg >= 0 ? sinceIg : -1;
    U.uHeat.value = smoothstep(cue.start + 2, cue.implode, T);
    // overall visibility: dim in the opening, debris fades through the star shot and pull-back
    U.uFade.value = lerp(0.6, 1, smoothstep(cue.start, cue.start + 6, T)) * (1 - 0.8 * smoothstep(cue.ignite + 1, cue.ignite + 6, T)) * (1 - smoothstep(cue.pull + 1, cue.pull + 2.8, T));
    U.uDebris.value = 1;
    const cloudOn = T < cue.pull + 3;
    const wD = smoothstep(cue.ignite + 1.2, cue.ignite + 1.9, T);
    cos.cloud.visible = cloudOn && wD < 1;
    debris.visible = cloudOn && wD > 0;
    U.uGain.value = 1 - wD;
    debrisU.uGain.value = 3 * wD;
    cos.haze.visible = cloudOn;
    cos.embers.visible = T < cue.start + 13;
    cos.emberU.uEm.value = 1;
    {
      const c0 = diskCam(cue.start);
      const p0 = new THREE.Vector3(...c0.p), f0 = new THREE.Vector3(...c0.l).sub(p0).normalize();
      const r0 = new THREE.Vector3().crossVectors(f0, new THREE.Vector3(0, 1, 0)).normalize();
      cos.emberU.uCam0.value.copy(p0); cos.emberU.uCamF.value.copy(f0); cos.emberU.uCamR.value.copy(r0);
    }

    // protostar core: deep red -> orange -> white, pinched by the implosion
    const heat = smoothstep(cue.start + 1, cue.implode, T);
    const imp = T < cue.implode ? 0 : invLerp(cue.implode, cue.ignite - 0.17, T);
    const K = 1100 + 5200 * Math.pow(heat, 1.4) + 4000 * imp;
    const bb = blackbody(K);
    cos.coreU.uCol.value.set(bb[0], bb[1], bb[2]);
    cos.coreU.uI.value = (0.03 + 0.5 * Math.pow(heat, 2.4)) * (1 + 9 * imp * imp) * (sinceIg < 0 ? 1 : Math.exp(-sinceIg * 8));
    cos.coreU.uTight.value = 1 + 14 * imp * imp;
    cos.coreU.uSize.value = 14;
    cos.core.visible = sinceIg < 0.6;

    // ignition flash
    if (sinceIg >= 0 && sinceIg < 3) {
      cos.flash.visible = true;
      const I = sinceIg < 0.09 ? 30 : 30 * Math.exp(-(sinceIg - 0.09) * 24);
      cos.flashU.uI.value = I;
      cos.flashU.uR.value = 0.12 + 0.22 * (1 - Math.exp(-sinceIg * 4));
      cos.flashU.uSize.value = 120;
    } else cos.flash.visible = false;

    // shock ring
    if (sinceIg >= 0 && sinceIg < 6) {
      cos.ring.visible = true;
      const Rs = 46 * (1 - Math.exp(-sinceIg * 1.35)) + sinceIg * 0.6;
      cos.ring.scale.setScalar(Math.max(Rs, 0.01));
      cos.ringU.uI.value = 6 * Math.exp(-sinceIg * 1.1) * smoothstep(0, 0.06, sinceIg);
      cos.ringU.uW.value = 0.025 + 0.05 * (1 - Math.exp(-sinceIg));
    } else cos.ring.visible = false;

    // star
    const starOn = sinceIg >= 0;
    cos.star.visible = starOn; cos.corona.visible = starOn;
    if (starOn) {
      const grow = 0.12 + 0.88 * ease.outCubic(clamp(sinceIg / 1.6));
      cos.star.scale.setScalar(SUN_R * grow);
      cos.starU.uT.value = T;
      cos.starU.uHot.value = 0.8 * Math.exp(-sinceIg * 2.2);
      cos.starU.uTemp.value = 4400 + 7000 * Math.exp(-sinceIg * 0.8);
      cos.starU.uI.value = 1.35 + 0.8 * Math.exp(-sinceIg * 1.5);
      cos.starU.uGran.value = 0.55 + 0.45 * smoothstep(0.2, 1.8, sinceIg);
      cos.coronaU.uT.value = T;
      cos.coronaU.uI.value = smoothstep(0.4, 3.0, sinceIg) * 1.0;
      cos.coronaU.uRin.value = (SUN_R * grow) / (SUN_R * 3.5);
    }
    cos.prom.visible = T > cue.ignite + 1;
    cos.promU.uT.value = T;
    cos.promU.uH.value = 0.12 + 0.4 * ease.inOutSine(invLerp(cue.ignite + 1, cue.pull, T));
    cos.promU.uI.value = smoothstep(cue.ignite + 1.5, cue.ignite + 5, T);
    cos.stars.position.copy(cam.position);
    cos.prom.visible = cos.prom.visible && T < cue.pull + 2.5;
    // Earth beat
    const earthOn = T > cue.pull + 1.0;
    earth.group.visible = earthOn;
    earth.burst.visible = false;
    if (earthOn) {
      earth.surfU.uT.value = T;
      earth.lightU.uI.value = 1.0;
      earth.atmoU.uI.value = 1.0;
      if (T >= cue.earth - 0.5) {
        const frac = sunFrac(T);
        earth.burst.visible = frac > 0.001;
        earth.burst.position.set(0, 0, 0);
        earth.burstU.uI.value = Math.pow(frac, 0.8) * 1.6;
        earth.burstU.uSize.value = 260;
        earth.burstU.uRot.value = 0.25 + T * 0.01;
      }
      earth.lightU.uI.value = 1 - smoothstep(cue.brain, cue.brain + 1.2, T);
      earth.lightU.uFocus.value = smoothstep(cue.dive + 0.1, cue.dive + 1.0, T);
      earth.surfU.uNight.value = 1 - smoothstep(cue.brain, cue.brain + 1.5, T);
      earth.atmoU.uI.value = 1 - smoothstep(cue.brain - 1, cue.brain + 1, T);
      earth.group.visible = T < cue.brain + 1.6;
    }
    // network (city -> brain -> chip)
    const netOn = T > cue.pull + 1.0;
    const wF = 1 - smoothstep(cue.dive + 0.9, cue.dive + 1.6, T);
    net.points.visible = netOn && wF < 1;
    netFar.visible = netOn && wF > 0;
    if (netOn) {
      const U = net.U;
      U.uT.value = T;
      U.uCB.value = ease.inOutSine(invLerp(cue.brain, cue.brainHud, T));
      U.uBC.value = invLerp(cue.snap, cue.snap + 0.6, T);
      U.uPulse.value = smoothstep(cue.brain - 0.3, cue.brain + 0.8, T);
      U.uTurb.value = 0;
      const camL = toL([cam.position.x, cam.position.y, cam.position.z]);
      const d = len3(camL);
      const cityGain = clamp(Math.pow(1.6 / d, 1.3), 0.075, 1.0);
      const gBase = lerp(cityGain * 1.2, 1.0, smoothstep(cue.brain, cue.brain + 1.5, T));
      U.uGain.value = gBase * (1 - wF);
      netFarU.uGain.value = gBase * 3 * wF;
    }
    cos.starsU.uI.value = 0.5 + 0.5 * smoothstep(cue.ignite, cue.pull, T);
  }

  function gradeCosmos(T) {
    const sinceIg = T - cue.ignite;
    const g = { exposure: 1.0, bloom: 0.6, bloomThreshold: 0.8, temperature: 0.1, vignette: 0.4 };
    if (T < cue.ignite) {
      g.exposure = lerp(1.0, 1.15, smoothstep(cue.start, cue.implode, T));
      // brightness pinches as everything falls in
      const imp = invLerp(cue.implode, cue.ignite - 0.17, T);
      g.exposure *= 1 - 0.55 * Math.pow(imp, 2.0);
      g.bloom = 0.6 + 0.3 * imp;
    } else if (T >= T_PO) {
      g.temperature = 0.0; g.saturation = 1.08; g.bloom = 0.35; g.bloomThreshold = 1.1; g.bloomRadius = 0.8; g.vignette = 0.5; g.exposure = 1.0;
    } else if (T >= cue.snap) {
      const kc = smoothstep(cue.snap, cue.snap + 0.6, T);
      g.temperature = lerp(0.08, -0.35, kc); g.bloom = 0.9; g.bloomThreshold = 0.6; g.exposure = 1.2; g.vignette = 0.45;
    } else if (T >= cue.brain - 0.5) {
      const kb = smoothstep(cue.brain - 0.5, cue.brain + 1.5, T);
      g.temperature = lerp(-0.12, 0.08, kb);
      g.bloom = lerp(0.6, 0.95, kb);
      g.bloomThreshold = lerp(1.0, 0.55, kb);
      g.exposure = lerp(1.0, 1.25, kb);
      g.vignette = 0.45;
    } else if (T >= cue.pull) {
      const frac = T > cue.earth - 0.5 ? sunFrac(T) : 0;
      const kk = smoothstep(cue.pull, cue.earth, T);
      g.temperature = lerp(0.22, -0.12, kk);
      g.saturation = lerp(1.12, 1.0, kk);
      g.bloom = 0.6 + 0.25 * frac;
      g.bloomThreshold = 1.0;
      g.streak = 0.55 * frac * (1 - 0.5 * smoothstep(cue.sunrise + 0.5, cue.dive, T));
      g.vignette = 0.45;
    } else {
      const k = Math.exp(-sinceIg * 1.3);
      g.streak = 1.3 * Math.exp(-sinceIg * 1.8) + 0.08 * smoothstep(1.5, 4, sinceIg) * (1 - smoothstep(4, 12, sinceIg)) * 0;
      g.exposure = 1.0 + 0.8 * Math.exp(-sinceIg * 18);
      g.bloom = 0.65 + 0.6 * k;
      g.temperature = 0.22;
      g.saturation = 1.12;
      g.bloomThreshold = 1.0;
    }
    return g;
  }

  const thermalOn = (T) => T >= T_PO - 0.1;
  const scanAt = (T) => ease.inOutSine(invLerp(T_PO, T_PO + 0.7, T));
  function updateThermal(T) {
    dc.U.uT.value = T;
    dc.plU.uT.value = T;
    dc.passU.uT.value = T;
    dc.passU.uScan.value = scanAt(T);
    dc.passU.uExp.value = 1.0;
    netHeatU.uHeat.value = 1.0;
    netHeatU.uGain.value = 0.045 * (1 - smoothstep(T_PO + 1.2, T_PO + 2.4, T));
    netHeat.visible = netHeatU.uGain.value > 0.001;
    dc.plU.uI.value = smoothstep(cue.dc - 1, cue.dc + 2, T);
    dc.U.uFog.value = lerp(1 / (22000 * MM), 1 / (900000 * MM), smoothstep(cue.dc + 0.7, cue.dc + 1.9, T)) * smoothstep(T_PO + 0.8, T_PO + 1.6, T);
  }

  // ------------------------------------------------------------------ main
  return {
    msaa: 0,
    render(f) {
      const T = f.T;
      const c = cosmicCam(T);
      applyCam(c);
      lastCam = c;
      updateCosmos(T);
      const r = ctx.renderer;
      // haze pass (quarter res)
      if (cos.haze.visible) {
        cos.hazeU.uFade.value = cos.cloudU.uFade.value;
        r.setRenderTarget(cos.hazeRT);
        r.setClearColor(0x000000, 1); r.clear(true, true, true);
        r.render(cos.hazeScene, cam);
      }
      const scan = thermalOn(T) ? scanAt(T) : 0;
      if (scan < 1) {
        r.setRenderTarget(f.target);
        r.render(scene, cam);
        if (cos.haze.visible) { r.autoClear = false; ctx.fsq.render(r, cos.hazeComp, f.target); r.autoClear = true; }
      }
      if (thermalOn(T)) {
        updateThermal(T);
        r.setRenderTarget(dc.heatRT);
        r.setClearColor(0x000000, 1); r.clear(true, true, true);
        r.render(heatScene, cam);
        r.autoClear = false; ctx.fsq.render(r, dc.pass, f.target); r.autoClear = true;
      }
      const gr = gradeCosmos(T);
      // fade to black: fully black by hum_cut - 1 frame
      gr.fade = 1 - ease.inOutSine(invLerp(cue.fade, cue.cut - 0.08, T));
      return gr;
    },
    overlay(g, f) {
      const T = f.T, S = f.S;
      // Work-around (still needed with the engine's per-frame canvas reset): when a frame draws nothing,
      // Chromium can keep uploading the previous overlay snapshot. One near-invisible pixel forces a fresh one.
      g.save(); g.fillStyle = 'rgba(0,0,0,0.004)'; g.fillRect(0, 0, 1, 1); g.restore();
      const proj = (v) => ctx.project(new THREE.Vector3(v[0], v[1], v[2]), cam);
      const camR = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const camU = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      // typed extra line under a callout shelf (same geometry as overlay.hudCallout)
      const extraLine = (anchor, dir, len, text, t, alpha) => {
        if (t <= 0) return;
        const dl = Math.hypot(dir[0], dir[1]), ux = dir[0] / dl, uy = dir[1] / dl;
        const ex = anchor[0] + ux * len * S, ey = anchor[1] + uy * len * S;
        const right = ux >= 0;
        const n = Math.min(text.length, Math.floor(t * 38));
        if (n <= 0) return;
        const txt = text.slice(0, n) + (n < text.length ? '▍' : '');
        overlay.hudText(g, txt, ex + (right ? 8 : -8) * S, ey + 8 * S + 16 * S, { size: 11, S, alpha: alpha * 0.6, align: right ? 'left' : 'right', spacing: 0.2 });
      };
      // S06 star: SURFACE / BURNS
      if (T > cue.hud1 && T < cue.pull + 0.2) {
        const a = 1 - smoothstep(cue.pull - 1.6, cue.pull - 0.4, T);
        const R = SUN_R;
        const w = camR.clone().multiplyScalar(-0.62 * R).add(camU.clone().multiplyScalar(0.3 * R));
        const [x, y] = proj([w.x, w.y, w.z]);
        const dir = [-1, -0.62], len = 170;
        overlay.hudCallout(g, { anchor: [x, y], dir, len, lines: [{ text: 'SURFACE  5,778 K' }], t: T - cue.hud1, alpha: a, S });
        extraLine([x, y], dir, len, 'BURNS  4.3 MILLION t / s', T - cue.hud2, a);
      }
      // S07 Earth
      const tE = cue.earth + 0.9;
      if (T > tE && T < cue.dive + 0.3) {
        const a = 1 - smoothstep(cue.dive - 0.6, cue.dive + 0.2, T);
        const w = new THREE.Vector3(...E).add(camR.clone().multiplyScalar(-EARTH_R * 0.96)).add(camU.clone().multiplyScalar(-EARTH_R * 0.25));
        const [x, y] = proj([w.x, w.y, w.z]);
        overlay.hudCallout(g, { anchor: [x, y], dir: [-1, 0.42], len: 120, lines: [{ text: 'EARTH' }], t: T - tE, alpha: a, S });
      }
      // S08 brain
      if (T > cue.brainHud && T < cue.snap) {
        const a = 1 - smoothstep(cue.snap - 0.9, cue.snap - 0.2, T);
        const [x, y] = proj(toW([0.36, 1.2, 0.42]));
        overlay.hudCallout(g, { anchor: [x, y], dir: [1, -0.5], len: 150, lines: [{ text: 'HUMAN BRAIN' }, { text: '86 BILLION NEURONS · 20 W' }], t: T - cue.brainHud, alpha: a, S });
      }
      // S09 GPU
      if (T > cue.gpuHud && T < T_PO + 1.6) {
        const a = 1 - smoothstep(T_PO + 0.6, T_PO + 1.4, T);
        const [x, y] = proj(toW([0.0, DIE_Y, 0.0]));
        overlay.hudCallout(g, { anchor: [x, y], dir: [1, -0.48], len: 170, lines: [{ text: 'GPU · 700 W' }], t: T - cue.gpuHud, alpha: a, S });
      }
      // S09 datacenter
      if (T > cue.dcHud && T < cue.cardIn) {
        const a = 1 - smoothstep(cue.cardIn - 1.2, cue.cardIn - 0.3, T);
        const [x, y] = proj(toW(mmToL([BCX - 12000, L.FLOOR + 7000, BCZ])));
        overlay.hudCallout(g, { anchor: [x, y], dir: [-1, -0.55], len: 150, lines: [{ text: 'DATACENTER · 150 MW' }], t: T - cue.dcHud, alpha: a, S });
      }
    },
  };
}
