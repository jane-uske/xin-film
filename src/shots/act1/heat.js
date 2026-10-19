// 壹 · 热 / I · HEAT — one continuous 62 s take (S04–S10):
// molecular cloud -> accretion disk -> ignition -> star -> Earth -> city -> brain -> chip -> datacenter.
// Every frame is a pure function of f.T. All times come from timeline cues.
import { buildCosmos, SUN_R } from './cosmos.js';
import { integrate } from './lib.js';

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
    const el = lerp(0.2, 0.105, smoothstep(cue.start, cue.implode, T)) - 0.02 * smoothstep(cue.ignite, cue.pull, T);
    const p = [Math.cos(az) * Math.cos(el) * d, Math.sin(el) * d, Math.sin(az) * Math.cos(el) * d];
    // camera-right vector in the disk plane, used to push the star right of frame centre
    const right = [-Math.sin(az), 0, Math.cos(az)];
    const off = 3.4 * ease.inOutSine(invLerp(cue.ignite + 0.5, cue.ignite + 4, T)) + 0.6 * smoothstep(cue.ignite + 4, cue.pull, T);
    const lift = -1.2 * (1 - smoothstep(cue.start, cue.implode, T));
    let l = [-right[0] * off, lift, -right[2] * off];
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
    if (cam.fov !== c.fov) { cam.fov = c.fov; }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  // prominence footpoints: fixed in world space on the limb as seen from mid-shot
  {
    const c = diskCam((cue.hud1 + cue.pull) / 2);
    const v = new THREE.Vector3(...c.p).normalize();
    const r = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), v).normalize();
    const u = new THREE.Vector3().crossVectors(v, r).normalize();
    const th = THREE.MathUtils.degToRad(48), sp = THREE.MathUtils.degToRad(11);
    const mk = (a) => r.clone().multiplyScalar(Math.cos(a)).add(u.clone().multiplyScalar(Math.sin(a))).add(v.clone().multiplyScalar(0.12)).normalize();
    cos.promU.uF1.value.copy(mk(th - sp));
    cos.promU.uF2.value.copy(mk(th + sp));
    cos.promU.uUp.value.copy(r.clone().multiplyScalar(Math.cos(th)).add(u.clone().multiplyScalar(Math.sin(th))).normalize());
  }

  let lastCam = null;

  // ------------------------------------------------------------------ per-beat updates
  function updateCosmos(T) {
    const U = cos.cloudU;
    const sinceIg = T - cue.ignite;
    U.uT.value = T;
    U.uCollapse.value = Math.pow(smoothstep(cue.start + 0.5, cue.implode, T), 1.25);
    U.uG.value = integrate(rotRate, cue.start, Math.min(T, cue.pull + 4), 120);
    U.uImp.value = T < cue.implode ? 0 : T < cue.ignite ? invLerp(cue.implode, cue.ignite, T) : 1;
    U.uShock.value = sinceIg >= 0 ? sinceIg : -1;
    U.uHeat.value = smoothstep(cue.start + 2, cue.implode, T);
    // overall visibility: dim in the opening, debris fades through the star shot and pull-back
    U.uFade.value = lerp(0.35, 1, smoothstep(cue.start, cue.start + 6, T)) * (1 - 0.8 * smoothstep(cue.ignite + 1, cue.ignite + 6, T)) * (1 - smoothstep(cue.pull + 1, cue.pull + 2.8, T));
    U.uDebris.value = 1;
    const cloudOn = T < cue.pull + 3;
    cos.cloud.visible = cloudOn;
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
    const imp = T < cue.implode ? 0 : T < cue.ignite ? invLerp(cue.implode, cue.ignite, T) : 1;
    const K = 1100 + 5200 * Math.pow(heat, 1.4) + 4000 * imp;
    const bb = blackbody(K);
    cos.coreU.uCol.value.set(bb[0], bb[1], bb[2]);
    cos.coreU.uI.value = (0.05 + 1.2 * Math.pow(heat, 2.2)) * (1 + 6 * imp * imp) * (sinceIg < 0 ? 1 : Math.exp(-sinceIg * 8));
    cos.coreU.uTight.value = 1 + 5 * imp * imp;
    cos.coreU.uSize.value = 14;
    cos.core.visible = sinceIg < 0.6;

    // ignition flash
    if (sinceIg >= 0 && sinceIg < 3) {
      cos.flash.visible = true;
      const I = sinceIg < 0.125 ? 40 : 40 * Math.exp(-(sinceIg - 0.125) * 4.2);
      cos.flashU.uI.value = I;
      cos.flashU.uR.value = 0.18 + 0.4 * (1 - Math.exp(-sinceIg * 3));
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
      cos.starU.uHot.value = Math.exp(-sinceIg * 1.6);
      cos.starU.uTemp.value = 5778 + 6000 * Math.exp(-sinceIg * 0.8);
      cos.starU.uI.value = 3.2;
      cos.starU.uGran.value = smoothstep(0.3, 2.5, sinceIg);
      cos.coronaU.uT.value = T;
      cos.coronaU.uI.value = smoothstep(0.4, 3.0, sinceIg) * 1.0;
      cos.coronaU.uRin.value = (SUN_R * grow) / (SUN_R * 3.5);
    }
    cos.prom.visible = T > cue.ignite + 1;
    cos.promU.uT.value = T;
    cos.promU.uH.value = 0.1 + 0.32 * ease.inOutSine(invLerp(cue.ignite + 1, cue.pull, T));
    cos.promU.uI.value = smoothstep(cue.ignite + 1.5, cue.ignite + 5, T);
    cos.stars.position.copy(cam.position);
    cos.starsU.uI.value = 0.5 + 0.5 * smoothstep(cue.ignite, cue.pull, T);
  }

  function gradeCosmos(T) {
    const sinceIg = T - cue.ignite;
    const g = { exposure: 1.0, bloom: 0.6, bloomThreshold: 0.8, temperature: 0.1, vignette: 0.4 };
    if (T < cue.ignite) {
      g.exposure = lerp(1.0, 1.15, smoothstep(cue.start, cue.implode, T));
      // brightness pinches as everything falls in
      const imp = invLerp(cue.implode, cue.ignite, T);
      g.exposure *= 1 - 0.35 * Math.pow(imp, 3);
      g.bloom = 0.6 + 0.3 * imp;
    } else {
      const k = Math.exp(-sinceIg * 1.3);
      g.streak = 1.6 * Math.exp(-sinceIg * 1.0) + 0.08 * smoothstep(1.5, 4, sinceIg) * (1 - smoothstep(4, 12, sinceIg)) * 0;
      g.exposure = 1.0 + 1.5 * Math.exp(-sinceIg * 6);
      g.bloom = 0.65 + 0.6 * k;
      g.temperature = 0.18;
      g.bloomThreshold = 1.0;
    }
    return g;
  }

  // ------------------------------------------------------------------ main
  return {
    msaa: 0,
    render(f) {
      const T = f.T;
      const c = diskCam(T);
      applyCam(c);
      lastCam = c;
      updateCosmos(T);
      const r = ctx.renderer;
      // haze pass (quarter res)
      if (cos.haze.visible) {
        cos.hazeU.uFade.value = cos.cloudU.uFade.value;
        cos.haze.geometry.setDrawRange(0, cos.NH);
        r.setRenderTarget(cos.hazeRT);
        r.setClearColor(0x000000, 1); r.clear(true, true, true);
        r.render(cos.hazeScene, cam);
        cos.haze.geometry.setDrawRange(0, Infinity);
      }
      r.setRenderTarget(f.target);
      r.render(scene, cam);
      if (cos.haze.visible) { r.autoClear = false; ctx.fsq.render(r, cos.hazeComp, f.target); r.autoClear = true; }
      return gradeCosmos(T);
    },
    overlay(g, f) {},
  };
}
