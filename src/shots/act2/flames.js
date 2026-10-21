// 贰 · 芯 / 叁 · 心（S11–S18，64.0 s → 181.0 s；S18 是切黑后的黑场，只留分类表的光标）
// 两团火并排在虚空里。蜡烛以自身为薪：连续、温暖、会留下痕迹；镜头像人在屏息呼吸。
// 数据之火以世界为薪：网格上的光点、冷青、精确、可复制、不留痕迹；镜头绝对平稳、匀速、对称。
// 第三幕里，数据之火换用了蜡烛的语言。
//
// 所有画面都是 f.T 的纯函数。"机器时间" Tm 在断电期间停住 —— 来电时火海回到断电前的同一帧；蜡烛不停。
import { flicker, FLAME } from './flameModel.js';
import { makeCandle, candleState, CANDLE, flameVS, haloFS } from './candle.js';
import { makeFloor } from './floor.js';
import { makeDigital, DIG } from './digitalFlame.js';
import { makeLattice, stepAt, LAT } from './lattice.js';
import { makeSeed } from './seed.js';
import { makeParticles } from './particles.js';
import { LABELS } from '../common/labels.js';

export default async function create(ctx) {
  const { THREE, util, overlay, cue } = ctx;
  const { clamp, lerp, invLerp, smoothstep, smootherstep, ease, ramp } = util;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  const scene = new THREE.Scene();
  const FOV = 24;
  const camera = new THREE.PerspectiveCamera(FOV, ctx.W / ctx.H, 0.3, 40000);

  // 共享的光源 uniform（每帧写一次）
  const shared = {
    uFlamePos: { value: V3(0, 12, 0) }, uFlameI: { value: 0 }, uFlameCol: { value: V3(1.0, 0.52, 0.2) },
    uDigPos: { value: V3(DIG.X, 10.5, 0) }, uDigI: { value: 0 }, uDigCol: { value: V3(0.2, 0.75, 1.0) },
    uMatchPos: { value: V3(0, 0, 0) }, uMatchI: { value: 0 },
    uPlinth: { value: new THREE.Vector2(DIG.plinthHW, DIG.plinthH + DIG.chipH) },
    uLat: { value: new THREE.Vector4(DIG.X, LAT.pitch, 0, 0) },
    uLatI: { value: 0 }, uLatCol: { value: V3(0.2, 0.75, 1.0) }, uLatFlameY: { value: DIG.wickY + 1.2 },
    uFogK: { value: 1 / 2500 }, uFogCol: { value: V3(0, 0, 0) },
    uLatFill: { value: 0 },
  };

  const floor = makeFloor(ctx, shared);
  const candle = makeCandle(ctx, shared);
  const digital = makeDigital(ctx, shared, flameVS);
  const lattice = makeLattice(ctx, shared, digital);
  const seed = makeSeed(ctx, shared);
  const parts = makeParticles(ctx);
  // 数据之火的冷光晕
  const dHaloU = { uOrigin: digital.warm.u.uOrigin, uRight: digital.warm.u.uRight, uGain: { value: 0 }, uCol: { value: V3(0.2, 0.7, 1.0) }, uC: { value: new THREE.Vector2(0, 1.3) } };
  const hq = new THREE.BufferGeometry();
  hq.setAttribute('position', new THREE.Float32BufferAttribute([-16, -12, 0, 16, -12, 0, 16, 16, 0, -16, 16, 0], 3));
  hq.setIndex([0, 1, 2, 0, 2, 3]);
  const dHalo = new THREE.Mesh(hq, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: flameVS, fragmentShader: haloFS, uniforms: dHaloU, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
  dHalo.frustumCulled = false; dHalo.renderOrder = 21;

  scene.add(floor.mesh, candle.group, digital.group, lattice.group, seed.pts, parts.glow, parts.bokeh, dHalo);
  // 加法混合的着色器都输出 alpha = 0 的"纯光"：用预乘模式让混合成为 ONE, ONE
  scene.traverse((o) => { if (o.material && o.material.blending === THREE.AdditiveBlending) o.material.premultipliedAlpha = true; });

  // ---------- 时间 ----------
  const tOff = cue('power_off'), tOn = cue('power_on');
  const Tmach = (T) => T - clamp(T - tOff, 0, tOn - tOff);
  const resSteps = [cue('res_step_1'), cue('res_step_2'), cue('res_step_3'), cue('res_step_4')];
  const digOn = cue('track_right') + 2.2;     // 数据之火被"点亮"（机器启动）
  const levelAt = (T) => { let l = 0; for (const s of resSteps) if (T >= s) l++; return l; };
  const LV = [
    { fps: 5, Q: 3, vox: 1.0, size: 0.92, gain: 0.13 },
    { fps: 8, Q: 4, vox: 0.85, size: 0.85, gain: 0.17 },
    { fps: 12, Q: 6, vox: 0.45, size: 0.66, gain: 0.26 },
    { fps: 24, Q: 9, vox: 0.12, size: 0.5, gain: 0.38 },
    { fps: 0, Q: 12, vox: 0.0, size: 0.46, gain: 0.48 },
  ];

  // ---------- 摄影机 ----------
  // 两套语言：烛 = 呼吸（handheld）；芯 = 绝对平稳的匀速运动（无抖动、线性/对数插值）
  const orbit = (tg, dist, az, el) => V3(tg.x + dist * Math.sin(az) * Math.cos(el), tg.y + dist * Math.sin(el), tg.z + dist * Math.cos(az) * Math.cos(el));
  const D2R = Math.PI / 180;
  const logLerp = (a, b, u) => a * Math.pow(b / a, u);
  // 匀速段：起止各留很短的加减速（马达），中间是严格的线性
  const motor = (x, a, b, acc = 0.08) => {
    const u = invLerp(a, b, x);
    const k = acc;
    if (u <= 0) return 0; if (u >= 1) return 1;
    const vmax = 1 / (1 - k);
    if (u < k) return vmax * u * u / (2 * k);
    if (u > 1 - k) return 1 - vmax * (1 - u) * (1 - u) / (2 * k);
    return vmax * (u - k / 2);
  };

  const flameCenterC = (st) => V3(0, st.wickY + 1.35, 0);
  const flameCenterD = () => V3(DIG.X, DIG.wickY + 1.35, 0);
  // 第三幕末：原初那一团的石柱也在燃烧、变矮变细；火海隐去时它滑到蜡烛身边，焰底与烛芯齐平
  const DIG_NEAR = 4.4;
  function digPose(T, st) {
    const k = smootherstep(cue('lattice_fade'), cue('lean_start') - 0.5, T);
    const top = lerp(DIG.plinthH, st.wickY - 0.36 - DIG.chipH, k);
    return { x: lerp(DIG.X, DIG_NEAR, k), top, wickY: top + DIG.chipH + 0.36, sc: lerp(1, 0.7, k), k };
  }

  function poseCandlePush(T, st) {
    const u = ease.inOutSine(invLerp(cue('flame_catch') + 0.3, cue('track_right'), T));
    const c = flameCenterC(st);
    const tg = V3(0, lerp(st.wickY + 0.2, c.y - 1.05, u), 0);
    const dist = logLerp(25, 18.0, u);
    return { tg, dist, az: lerp(-0.035, 0.0, u), el: lerp(5.0, 2.4, u) * D2R, hand: smoothstep(cue('flame_catch'), cue('flame_catch') + 1.5, T) };
  }
  const twoShot = (y) => ({ tg: V3(DIG.X / 2, y, 0), dist: 26, az: 0, el: 2.0 * D2R });

  function camPose(T, st) {
    let P;
    if (T < cue('track_right')) {
      P = poseCandlePush(T, st);
    } else if (T < cue('seed_enter')) {
      // S13：机械平移 → 停在数据之火上 → 拉开成双人镜头
      const a = poseCandlePush(cue('track_right'), candleState(util, cue, cue('track_right')));
      const t1 = cue('track_right'), t2 = t1 + 2.6, t3 = cue('res_step_4') + 0.9, t4 = cue('card_c2b_in') + 0.6;
      const dc = flameCenterD();
      const onD = { tg: V3(DIG.X, dc.y - 0.05, 0), dist: 14.5, az: 0, el: 1.6 * D2R };
      const ts = twoShot(lerp(st.wickY, DIG.wickY, 0.5) + 1.25);
      if (T < t2) {
        const u = motor(T, t1, t2, 0.18);
        P = { tg: a.tg.clone().lerp(onD.tg, u), dist: lerp(a.dist, onD.dist, u), az: lerp(a.az, 0, u), el: lerp(a.el, onD.el, u), hand: 1 - smoothstep(t1, t1 + 0.6, T) };
      } else if (T < t3) {
        // 学习期间：极慢的匀速推近
        const u = (T - t2) / (t3 - t2);
        P = { ...onD, dist: lerp(14.5, 13.2, u), hand: 0 };
      } else {
        const u = motor(T, t3, t4, 0.2);
        P = { tg: onD.tg.clone().lerp(ts.tg, u), dist: logLerp(13.2, ts.dist, u), az: 0, el: lerp(onD.el, ts.el, u), hand: 0 };
      }
    } else if (T < cue('copy_2') - 1.0) {
      // S14：种子。双人镜头；种子飘向蜡烛时，镜头开始轻轻呼吸，略向蜡烛靠
      // 对称的双人镜头，中间留给字幕卡；种子飘向蜡烛时镜头开始轻轻呼吸
      const ts = twoShot(lerp(st.wickY, DIG.wickY, 0.5) + 1.25);
      const u = ease.inOutSine(invLerp(cue('seed_enter'), cue('copy_2') - 1.0, T));
      P = { tg: ts.tg, dist: lerp(26, 20.0, u), az: 0, el: ts.el, hand: 0.55 * smoothstep(cue('seed_through_digital') + 0.5, cue('seed_through_digital') + 2.5, T) };
    } else if (T < cue('candle_return')) {
      P = latticePose(T, st);
    } else if (T < cue('ch3_in') - 0.5) {
      // 切回蜡烛（快速摇移 → 呼吸）
      const tr = cue('candle_return');
      const c = flameCenterC(st);
      // 从蜡烛背后看（火海在画外右后方，只有它的冷光漏进来）；略俯视，看得见熔池、灰与蜡泪
      const ur = ease.inOutSine(invLerp(tr + 0.4, cue('ch3_in'), T));
      const cand = { tg: V3(0.0, lerp(st.H - 2.6, st.wickY + 0.2, ur), 0), dist: lerp(40, 23, ur), az: -0.12, el: lerp(6, 12, ur) * D2R, hand: 1, fov: 18 };
      const posC = orbit(cand.tg, cand.dist, cand.az, cand.el);
      if (T < tr + 0.55) {
        const L = latticePose(tr, st);
        const posL = L.pos || orbit(L.tg, L.dist, L.az, L.el);
        const u = ease.inOutExpo(invLerp(tr, tr + 0.55, T));
        P = { pos: posL.clone().lerp(posC, u), tg: L.tg.clone().lerp(cand.tg, u), hand: u, fov: lerp(FOV, 18, u) };
      } else P = cand;
    } else if (T < cue('lattice_fade')) {
      P = rowGlide(T);
    } else {
      // S17：继续向左平移，蜡烛从左侧回到画面；两焰并排，慢慢推向两焰之间
      const ta = cue('lattice_fade'), tb = cue('candle_reenter'), tc = cue('lean_start') + 0.5, te = cue('cut_black');
      const g = rowGlide(ta);
      const gpos = g.pos;
      const fin = { tg: V3(DIG_NEAR / 2, st.wickY + 1.6, 0), dist: 23, az: 0.0, el: 7 * D2R };
      const posF = orbit(fin.tg, fin.dist, fin.az, fin.el);
      if (T < tc) {
        const u = ease.inOutSine(invLerp(ta, tc, T));
        P = { pos: gpos.clone().lerp(posF, u), tg: g.tg.clone().lerp(fin.tg, ease.inOutSine(invLerp(ta - 0.5, tc, T))), hand: 1 };
      } else {
        const u = ease.inOutSine(invLerp(tc, te + 1.5, T));
        const tg = fin.tg.clone().lerp(V3(DIG_NEAR / 2, st.wickY + 2.15, 0), u);
        const pk = ease.inCubic(invLerp(cue('bridge_start') - 1, te, T));
        P = { tg, dist: lerp(23, 16.0, u) - 1.4 * pk, az: 0.0, el: lerp(7, 5, u) * D2R, hand: 1 };
      }
    }
    if (!P.pos) P.pos = orbit(P.tg, P.dist, P.az, P.el);
    return P;
  }
  // S15：机器时间里的升降臂
  function latticePose(T, st) {
    const Tm = Tmach(T);
    const s0 = cue('copy_2') - 1.0;
    const B = camPoseS14End(st);
    const rowT = cue('copy_8') + 0.6;
    const row = { tg: V3(DIG.X + 3.5 * LAT.pitch, 10.2, -4), dist: 90, az: 0, el: 3.5 * D2R };
    const rowPos = orbit(row.tg, row.dist, row.az, row.el);
    if (Tm < rowT) {
      const u = motor(Tm, s0, rowT, 0.15);
      const tg = B.tg.clone().lerp(row.tg, u);
      const dist = logLerp(B.dist, row.dist, u);
      return { tg, dist, az: lerp(B.az, 0, u), el: lerp(B.el, row.el, u), hand: B.hand * (1 - smoothstep(s0, s0 + 0.7, Tm)) };
    }
    // 升起、越过火海、看向对角线（两组网格线汇聚到左右两个灭点 —— 对称）
    const endT = cue('power_off') + 0.0;
    const u = motor(Tm, rowT, endT + 3.0, 0.12);
    const ue = Math.pow(u, 1.35);
    const fin = { pos: V3(150, 150, -150), tg: V3(150 + 1500, 0, -150 - 1500) };
    const pos = rowPos.clone().lerp(fin.pos, ue);
    pos.y = logLerp(rowPos.y, fin.pos.y, ue);
    const tg = row.tg.clone().lerp(fin.tg, Math.pow(u, 1.1));
    return { pos, tg, hand: 0 };
  }
  function camPoseS14End(st) {
    const ts = twoShot(lerp(st.wickY, DIG.wickY, 0.5) + 1.25);
    return { tg: ts.tg, dist: 20.0, az: 0, el: ts.el, hand: 0.55 };
  }
  // S16：贴地沿一排复制体滑行，最初那一团最近
  function rowGlide(T) {
    // 从左前方、略高于焰心处看：最初那一团在左侧约四分之一处；它身后是一排排退向远处、隐入黑暗的复制体；
    // 蜡烛在画外左后方。镜头匀速滑行，同时匀速微摇，让它始终停在同一处
    const a = cue('ch3_in') - 0.5, b = cue('lattice_fade') + 2.0;
    const u = (T - a) / (b - a);
    const pos = V3(lerp(5.2, 3.2, u), 14.3, lerp(15.5, 14.5, u));
    const bearing = Math.atan2(DIG.X - pos.x, pos.z);
    // 字幕卡 c4a 之前：镜头随呼吸缓缓下俯、偏开，让那团火升到画面左上，下三分之一留给黑暗
    const cardMove = smoothstep(cue('card_c4a_in') - 4.5, cue('card_c4a_in') - 0.3, T);
    const yaw = bearing + (15 + 6.5 * cardMove) * D2R;
    const pitch = (-12 - 1.2 * cardMove) * D2R;
    const dir = V3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    return { pos, tg: pos.clone().add(dir.multiplyScalar(40)), hand: smoothstep(cue('warm_shift_start'), cue('warm_shift_end'), T) * 0.9 };
  }
  function applyCamera(T, st) { setCamera(camera, T, st); }
  function setCamera(camera, T, st) {
    const P = camPose(T, st);
    camera.position.copy(P.pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(P.tg);
    const h = P.hand || 0;
    if (h > 0) {
      const d = P.pos.distanceTo(P.tg);
      const [hx, hy, hr] = util.handheld(T, 1, 1, 3.0);
      const [bx, by] = util.handheld(T * 0.35, 1, 1, 11.0);
      // 呼吸：很慢的上下起伏 + 微小的手持漂移（与距离成比例）
      const amp = 0.0045 * d * h;
      camera.translateX((hx * 0.8 + bx * 1.6) * amp);
      camera.translateY((hy * 0.8 + by * 1.2 + 0.35 * Math.sin(T * 2 * Math.PI / 4.6)) * amp);
      camera.rotateZ(hr * 0.004 * h);
    }
    camera.fov = P.fov || FOV;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  // 火柴划燃的位置：第一幕最后那粒火星停在画面 (0.50, 0.45) —— 硬接（match cut）。
  // S11 里镜头在火苗立住之前是静止的，所以把这个屏幕点从那一刻的镜头反投影到蜡烛前方的一个平面上。
  const M0 = (() => {
    const tS = cue('match_strike');
    const cam = new THREE.PerspectiveCamera(FOV, ctx.W / ctx.H, 0.3, 40000);
    setCamera(cam, tS, candleState(util, cue, tS));
    const p1 = new THREE.Vector3(0.0, 1 - 2 * 0.45, 0.2).unproject(cam);
    const dir = p1.clone().sub(cam.position).normalize();
    const zPlane = CANDLE.R + 0.6;
    const k = (zPlane - cam.position.z) / dir.z;
    const p = cam.position.clone().addScaledVector(dir, k);
    return [p.x, p.y, p.z];
  })();

  // ---------- 每帧 ----------
  const pxScale = () => ctx.H / (2 * Math.tan((camera.fov * D2R) / 2));
  let hud = {};

  // 分类表的锚点：贴在那团变暖的火的右侧（远离两焰尖之间的光桥）
  const scratchCam = new THREE.PerspectiveCamera(FOV, ctx.W / ctx.H, 0.3, 40000);
  const verdictPoint = (dpq) => V3(dpq.x + 0.8, dpq.wickY + 1.55, 0);
  // 切黑前最后一帧的锚点（S18 里光标留在原处）
  function verdictAnchorLast() {
    const Tl = (Math.round(cue('cut_black') * ctx.fps) - 1) / ctx.fps;
    const stl = candleState(util, cue, Tl);
    setCamera(scratchCam, Tl, stl);
    return ctx.project(verdictPoint(digPose(Tl, stl)), scratchCam);
  }
  // 安装日志每打出一行，它就暖一分；随后 warm_shift 段一路转暖到琥珀
  function warmAt(T) {
    let w = 0;
    for (const t of installT()) w += 0.12 * ease.outCubic(clamp((T - t) / 0.45));
    return w + (1 - 0.36) * smoothstep(cue('warm_shift_start'), cue('warm_shift_end'), T);
  }

  function render(f) {
    const T = f.T, S = f.S;
    // S18：硬切全黑（无颗粒），只留光标（由 overlay 画）
    if (T >= cue('cut_black')) {
      hud = { T, verdictAnchor: verdictAnchorLast() };
      return { fade: 0, grain: 0, bloom: 0, vignette: 0, ca: 0, streak: 0 };
    }
    const st = candleState(util, cue, T);
    const dp = digPose(T, st);
    applyCamera(T, st);
    const px = pxScale();
    const Tm = Tmach(T);
    const powerOff = T >= tOff && T < tOn;

    // ---- 烛火 ----
    const catchT = cue('flame_catch');
    const grow = ease.outCubic(clamp((T - catchT) / 1.6));
    const lit = T >= catchT;
    // S17：一阵共同的气流，两焰向彼此倾斜；焰尖伸长
    const lean = smoothstep(cue('lean_start'), cue('lean_start') + 5, T) * 0.55 + smoothstep(cue('bridge_start'), cue('cut_black'), T) * 0.72;
    const stretch = 1 + smoothstep(cue('bridge_start'), cue('cut_black'), T) * 0.12;
    const flC = flicker(util, T, 0, {
      lenMul: (0.25 + 0.75 * grow) * stretch * (st.H < 7 ? 0.97 : 1), widMul: 0.55 + 0.45 * grow,
      flutterAdd: (1 - grow) * 0.8 + lean * 0.15, leanX: lean,
    });
    const cfc = V3(0, st.wickY + 1.2, 0);
    shared.uFlamePos.value.copy(cfc);
    shared.uFlameI.value = lit ? (0.25 + 0.75 * grow) * flC.f1[3] * 1.0 : 0;
    // 全片唯一的高潮：最后三秒，两团火更亮、光晕更满
    const peak = smoothstep(cue('bridge_start'), cue('cut_black'), T);
    candle.update(st, T, camera, flC, { gain: lit ? (0.3 + 0.7 * grow) * (1 + 0.12 * peak) : 0, wick: 1, amb: 0.0006 * (lit ? 1 : 0), smoke: 0.035, halo: 1 + 0.7 * peak });
    candle.flame.visible = lit; candle.halo.visible = lit; candle.smoke.visible = lit && T < cue('lattice_fade') + 30;
    // 种子的灰（S14 之后一直留在蜡上）
    const p0 = seed.update(T, px, S);
    const seedBurnPos = [1.05, 12.75 + (st.wickY - candleState(util, cue, cue('seed_burn')).wickY), 0.0];

    // ---- 数据之火（原初那一团） ----
    const lvl = levelAt(T);
    const L = LV[lvl];
    const inMach = T >= cue('copy_2') - 1.0;
    let tfD = T;
    if (T < resSteps[3] + 0.0 && L.fps > 0) tfD = Math.floor(T * L.fps) / L.fps;
    if (inMach) tfD = Tm;
    // 第三幕：失步。它的闪烁相位从 0.003 s 开始漂移，然后有了自己的噪声
    const dsy = cue('desync_start');
    const delta = T < dsy ? 0 : 0.003 * Math.exp((T - dsy) * 1.25) - 0.003 + 0.003 * smoothstep(dsy, dsy + 0.2, T);
    const own = smoothstep(cue('warm_shift_start'), cue('warm_shift_end'), T);
    const burn = smoothstep(cue('self_burn_start'), cue('cut_black'), T);
    const leanD = -lean;
    const flO = flicker(util, tfD + Math.min(delta, 30), own > 0 ? 0.0 : 0, {
      lenMul: (1 - 0.3 * burn) * (1 + 0.36 * lean / 1.27) * stretch, widMul: (1 - 0.18 * burn) * (1 + 0.1 * lean / 1.27), flutterAdd: 0.25 * burn + 0.1 * own, ripMul: 1 + 0.6 * burn, leanX: leanD,
    });
    // 失步之后，加入它自己的、不可复现的摆动
    if (own > 0) {
      const ex = flicker(util, T * 1.07, 3.3);
      flO.f0[0] = lerp(flO.f0[0], ex.f0[0] * 1.3 + leanD, own); flO.f0[2] = lerp(flO.f0[2], ex.f0[2] * (1 - 0.3 * burn) * (1 + 0.36 * lean / 1.27) * stretch, own * 0.6);
      flO.f1[2] = lerp(flO.f1[2], ex.f1[2], own);
    }
    const digVisible = T >= digOn - 1.8;
    const appear = smoothstep(digOn, digOn + 0.08, T);   // 一帧之内亮起
    const wake = smoothstep(digOn - 1.7, digOn - 1.2, T);  // 芯片先亮一个点（镜头还在平移时）
    const o = digital.orig.u;
    const warm = warmAt(T);
    const soft = smoothstep(cue('warm_shift_start') + 1.0, cue('warm_shift_end') + 0.5, T);
    digital.origPts.forEach((p, k) => { p.visible = digVisible && k === lvl && appear > 0 && soft < 0.999; });
    const geoL = digital.levels[lvl];
    o.uF0.value.fromArray(flO.f0); o.uF1.value.fromArray(flO.f1);
    o.uOrigin.value.set(dp.x, dp.wickY, 0);
    o.uCell.value.fromArray(geoL.userData.cell);
    o.uQ.value = L.Q; o.uVox.value = L.vox; o.uSize.value = L.size;
    // 每个点只覆盖格子的一部分：增益按覆盖率补偿，使平均亮度与烛火一致
    const cov = lerp(0.98 * (L.size * L.size) / 4, 0.8 * L.size * L.size, L.vox);
    o.uGain.value = 0.7 / cov;
    o.uPx.value = px; o.uMinPx.value = 1.0;
    o.uWarm.value = warm; o.uSoft.value = soft;
    let flash = 0;
    for (const s of resSteps) if (T >= s) flash = Math.max(flash, 2.5 * Math.exp(-(T - s) / 0.06));
    for (const s of installT()) if (T >= s) flash = Math.max(flash, 0.9 * Math.exp(-(T - s) / 0.18));
    o.uFlash.value = flash;
    o.uFade.value = appear * (1 - soft);
    // 种子穿过：光点让开
    if (p0) o.uSeed.value.set(p0[0], p0[1] + 0.15, p0[2], 0.42 * smoothstep(1.9, 0.6, Math.hypot(p0[0] - DIG.X, p0[1] - DIG.wickY - 1.4))); else o.uSeed.value.set(0, -100, 0, 0);
    // 连续的暖火（柔化之后接管）
    const wu = digital.warm.u;
    wu.uOrigin.value.set(dp.x, dp.wickY, 0);
    const cdx = camera.position.x - dp.x, cdz = camera.position.z;
    const cl = Math.hypot(cdx, cdz) || 1;
    wu.uRight.value.set(cdz / cl, -cdx / cl);
    wu.uF0.value.fromArray(flO.f0); wu.uF1.value.fromArray(flO.f1);
    wu.uGain.value = soft * (1 - 0.25 * burn) * flO.f1[3] * (1 + 0.12 * peak);
    wu.uTm.value = T; wu.uWarm.value = warm;
    digital.warm.mesh.visible = soft > 0.001;
    // 冷光（照亮底座、地面、蜡烛的右侧、种子）
    const cyan = V3(0.2, 0.75, 1.0), white = V3(0.95, 0.95, 0.95), amber = V3(1.0, 0.5, 0.18);
    const dcol = warm < 0.5 ? cyan.clone().lerp(white, warm * 2) : white.clone().lerp(amber, warm * 2 - 1);
    shared.uDigCol.value.copy(dcol);
    shared.uDigPos.value.set(dp.x, dp.wickY + 1.2, 0);
    shared.uPlinth.value.set(DIG.plinthHW * dp.sc, dp.top + DIG.chipH);
    digital.plinth.position.set(dp.x, 0, 0);
    digital.plinth.scale.set(dp.sc, dp.top / DIG.plinthH, dp.sc);
    digital.chip.position.set(dp.x, dp.top + DIG.chipH / 2, 0);
    digital.plU.uOwnY.value = dp.wickY + 1.2;
    shared.uDigI.value = digVisible ? (wake * 0.12 + appear * (0.35 + 0.15 * lvl) * flO.f1[3]) * (1 - 0.3 * burn) : 0;
    // 复制开始前光晕褪去：原初那一团必须与它的复制品一模一样
    dHaloU.uGain.value = appear * 0.22 * (1 - soft) * flO.f1[3] * (1 - smoothstep(cue('copy_2') - 1.0, cue('copy_2') - 0.3, T));
    dHalo.visible = digVisible;
    digital.chipU.uGlow.value = smoothstep(cue('self_burn_start'), cue('self_burn_start') + 3, T) * (0.8 + 0.2 * Math.sin(T * 7.0));
    digital.chipU.uBurn.value = 0.72 * smoothstep(cue('self_burn_start') + 1.5, cue('cut_black') + 2, T);
    digital.chipU.uTm.value = T;
    digital.plinth.visible = digital.chip.visible = true;

    // 切回蜡烛的那几秒：画面里只有蜡烛（火海在画外，只留一点冷的环境光）
    const away = T >= cue('candle_return') + 0.3 && T < cue('ch3_in') - 0.4;
    shared.uLatFill.value = away ? 0.22 : 0;

    // ---- 火海 ----
    const n = inMach ? stepAt(lattice.times, Tm) : 0;
    const since = Tm - lattice.times[n];
    const fade = 1 - smoothstep(cue('lattice_fade'), cue('lattice_fade') + 2.6, T);
    const flL = flicker(util, Tm, 0, {});
    lattice.group.visible = inMach && n > 0 && fade > 0 && !away;
    digital.group.visible = !away; dHalo.visible = dHalo.visible && !away;
    const [we, de] = (n >= 1) ? latDims(n) : [0, 0];
    shared.uLat.value.set(DIG.X, LAT.pitch, n >= 1 ? we : 0, n >= 1 ? de : 0);
    lattice.update({ n, since, fl: flL, gainA: 0.7 / (0.98 * LV[4].size * LV[4].size / 4), px, fade, latI: 0.6 * flL.f1[3] });
    if (!lattice.group.visible) shared.uLatI.value = 0;
    // 雾：只在火海里
    shared.uFogK.value = inMach && T < cue('cut_black') ? (T < cue('ch3_in') - 0.5 ? 1 / 1100 : 1 / 45) : 0;
    shared.uFogCol.value.set(0.0, 0.0, 0.0);

    // 地面：S11–S12 的微距镜头里看不到地面，省掉它
    // 第三幕里地面在雾与黑暗中已不可见（实测像素差≈0），省掉它
    floor.mesh.visible = T >= cue('track_right') - 0.5 && T < cue('ch3_in') - 0.5;
    // 第三幕末：两团火的光在地面上相遇（地面响应加强）
    const fl17 = smoothstep(cue('candle_reenter'), cue('lean_start') + 3, T);
    floor.u.uDim.value = 1 + 35 * fl17;
    floor.u.uOpen.value = 0.85 * fl17;

    // ---- 粒子 ----
    parts.begin();
    const wick = [0, st.wickY, 0];
    const m = parts.matchAt(T, cue, wick, M0);
    shared.uMatchPos.value.set(m.p[0], m.p[1], m.p[2]);
    shared.uMatchI.value = m.on ? m.I * 0.9 : 0;
    parts.sparks(T, cue, M0);
    parts.match(m);
    parts.burn(T, cue, seedBurnPos, st, candle.waxU.uAsh.value);
    parts.curl(T, cue, seedBurnPos);
    parts.embers(T, cue, [dp.x, dp.wickY, 0], burn > 0 ? smoothstep(cue('self_burn_start'), cue('self_burn_start') + 1.5, T) : 0, flO.f0[2]);
    // 机器醒来：芯片上先亮起一个青色的点
    if (digVisible && !away) {
      const wp = wake * (1 - 0.85 * appear) * (1 - smoothstep(cue('self_burn_start'), cue('self_burn_start') + 2, T));
      if (wp > 0.001) parts.point(dp.x, dp.top + DIG.chipH + 0.04, 0, 0.6 * wp * 22, 2.4 * wp * 22, 3.2 * wp * 22, 7);
    }
    // 光桥
    if (T >= cue('bridge_start')) bridge(T, st, flC, flO, dp);
    parts.end(S);
    // 微尘：只在蜡烛的特写里
    const dustAmt = (1 - smoothstep(cue('track_right'), cue('track_right') + 2.5, T)) * smoothstep(catchT, catchT + 2, T)
      + 0.4 * smoothstep(cue('candle_return') + 0.4, cue('candle_return') + 1.2, T) * (1 - smoothstep(cue('ch3_in') - 1.0, cue('ch3_in'), T))
      + 0.6 * smoothstep(cue('candle_reenter') + 1, cue('lean_start') + 2, T);
    parts.dust(T, camera, [cfc.x, cfc.y, cfc.z], shared.uFlameI.value, clamp(dustAmt), camera.position.distanceTo(cfc), px, S);

    // 断电：一帧之内全黑
    if (powerOff) {
      shared.uLatI.value = 0;
    }

    ctx.renderer.setRenderTarget(f.target);
    ctx.renderer.render(scene, camera);

    // ---- HUD 数据 ----
    hud = { T, Tm, n, powerOff, origScreen: ctx.project(V3(dp.x, dp.wickY + 1.6, 0), camera), lvl,
      chipScreen: ctx.project(V3(dp.x + 0.2, dp.top + DIG.chipH + 0.04, 0), camera),
      origSide: ctx.project(V3(dp.x + 0.62, dp.wickY + 1.15, 0), camera),
      verdictAnchor: ctx.project(verdictPoint(dp), camera),
      origTop: ctx.project(V3(dp.x, dp.wickY + 3.15, 0), camera), origBot: ctx.project(V3(dp.x, dp.wickY - 0.15, 0), camera) };

    // ---- 调色 ----
    return grade(T, powerOff, st);
  }

  function latDims(n) {
    // 与 lattice.dims 相同：转为格子数
    let a, b;
    if (n <= 3) { a = n; b = 0; } else if (n <= 6) { a = 3; b = n - 3; } else { const k = n - 6; a = 3 + Math.ceil(k / 2); b = 3 + Math.floor(k / 2); }
    return [1 << a, 1 << b];
  }

  // 光桥：两焰尖之间，一缕细弱、颤动的光丝正在形成 —— 最后一帧仍差一线，永不接上
  function bridge(T, st, flC, flO, dp) {
    const u = smoothstep(cue('bridge_start'), cue('cut_black'), T);
    const tipC = V3(flC.f0[0] * 1.15, st.wickY + flC.f0[2] * 0.96, flC.f0[1] * 1.15);
    const tipD = V3(dp.x + flO.f0[0] * 1.15, dp.wickY + flO.f0[2] * 0.96, flO.f0[1] * 1.15);
    const mid = tipC.clone().lerp(tipD, 0.5); mid.y += 0.1 + 0.04 * Math.sin(T * 1.7);
    const reach = 0.5 * Math.pow(u, 1.3) * 0.972;
    const N = 90;
    const on = smoothstep(0, 0.12, u);
    for (const side of [0, 1]) {
      const a = side === 0 ? tipC : tipD, b = side === 0 ? tipD : tipC;
      for (let i = 0; i < N; i++) {
        const v = i / (N - 1);
        const t = v * reach;
        const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mid.x + t * t * b.x;
        let y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * mid.y + t * t * b.y;
        const z = (1 - t) * (1 - t) * a.z + 2 * (1 - t) * t * mid.z + t * t * b.z;
        // 颤动：越靠近自由端越抖
        y += (0.03 * Math.sin(T * 9.0 + v * 7.0 + side * 2.1) + 0.015 * Math.sin(T * 23.0 + v * 13.0 + side)) * v;
        // 根部（焰尖）亮，向自由端渐隐；亮度沿丝缓慢游动
        const br = Math.pow(1 - v, 1.4) * (0.65 + 0.35 * Math.sin(T * 11.0 + side * 3.0 - v * 9.0)) * on;
        parts.point(x, y, z, 1.0 * br * 3.2, 0.7 * br * 3.2, 0.36 * br * 3.2, 1.3);
        if (i % 2 === 0) parts.point(x, y, z, 0.42 * br, 0.26 * br, 0.1 * br, 9);
        if (i % 6 === 0) parts.point(x, y, z, 0.05 * br, 0.03 * br, 0.012 * br, 26);
      }
    }
  }

  // 断电前最后几帧的"电压跌落"：亮度按时间线 events.power_sag 逐帧闪烁
  function sagAt(T) {
    const sag = ctx.timeline.events.power_sag;
    const k = Math.floor((T - (tOff - sag.length / ctx.fps)) * ctx.fps + 1e-6);
    return k >= 0 && k < sag.length ? sag[k] : 1;
  }
  function grade(T, powerOff, st) {
    if (powerOff) return { fade: 0, grain: 0, bloom: 0, vignette: 0, ca: 0 };
    const g0 = gradeBase(T, powerOff, st);
    const sg = sagAt(T);
    if (sg < 1) { g0.exposure = (g0.exposure ?? 1) * sg; g0.bloom = (g0.bloom ?? 0.6) * (0.6 + 0.4 * sg); }
    return g0;
  }
  function gradeBase(T, powerOff, st) {
    const g = { bloom: 0.6, bloomThreshold: 1.3, bloomKnee: 0.8, bloomRadius: 1.0, vignette: 0.42, grain: 0.04, saturation: 1.0, contrast: 1.04, exposure: 1.0, temperature: 0, bloomTint: [1, 0.9, 0.82] };
    // S11：黑；火柴之后渐亮
    if (T < cue('track_right')) {
      g.temperature = 0.12; g.exposure = 1.0;
      // 字幕卡 c2a：画面下三分之一压暗 —— 通过整体略降与暗角
      const c = util.envelope(T, cue('card_c2a_in') - 0.5, cue('card_c2a_in') + 0.8, cue('card_c2a_out') - 0.5, cue('card_c2a_out') + 0.3);
      g.exposure *= 1 - 0.12 * c; g.vignette += 0.15 * c;
    } else if (T < cue('seed_enter')) {
      const u = smoothstep(cue('track_right'), cue('track_right') + 2.5, T);
      g.temperature = lerp(0.12, -0.04, u);
      g.bloomTint = [lerp(1, 0.85, u), 0.93, lerp(0.82, 1.0, u)];
      const c = util.envelope(T, cue('card_c2b_in') - 0.5, cue('card_c2b_in') + 0.8, cue('card_c2b_out') - 0.5, cue('card_c2b_out') + 0.3);
      g.exposure *= 1 - 0.1 * c; g.vignette += 0.12 * c;
    } else if (T < cue('copy_2') - 1) {
      g.temperature = 0.0;
    } else if (T < cue('candle_return')) {
      g.temperature = -0.22; g.bloomTint = [0.75, 0.92, 1.0]; g.saturation = 0.95; g.bloom = 0.95;
    } else if (T < cue('ch3_in') - 0.5) {
      g.temperature = 0.14;
      // 快速摇移：一闪而过的暗
      const tr = cue('candle_return');
      g.fade = 1 - 0.85 * util.envelope(T, tr, tr + 0.25, tr + 0.3, tr + 0.6);
      g.fade *= 1 - smoothstep(cue('ch3_in') - 1.1, cue('ch3_in') - 0.5, T);
    } else if (T < cue('lattice_fade')) {
      const w = warmAt(T);
      g.temperature = lerp(-0.22, 0.02, w); g.bloomTint = [lerp(0.75, 1.0, w), 0.92, lerp(1.0, 0.85, w)];
      g.fade = smoothstep(cue('ch3_in') - 0.5, cue('ch3_in') + 1.0, T);
      const c = util.envelope(T, cue('card_c4a_in') - 0.5, cue('card_c4a_in') + 0.8, cue('card_c4a_out') - 0.5, cue('card_c4a_out') + 0.3);
      g.exposure *= 1 - 0.1 * c; g.vignette += 0.12 * c;
    } else {
      g.temperature = 0.1; g.bloomTint = [1.0, 0.9, 0.82];
      const pk = smoothstep(cue('bridge_start'), cue('cut_black'), T);
      g.bloom = lerp(0.85, 1.18, pk); g.exposure = 1 + 0.07 * pk; g.temperature = 0.1 + 0.05 * pk;
    }
    return g;
  }

  // ---------- HUD：机器的目光（只在数据之火上，从不在蜡烛上） ----------
  function fmtInt(x) { return String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  // 逐字打出（与 hudCallout 同一节奏）
  const typed = (text, t, rate = 30) => (t <= 0 ? '' : text.slice(0, Math.floor(t * rate)) + (t * rate < text.length ? '▍' : ''));
  const right = (gg, text, x, y, o) => overlay.hudText(gg, text, x, y, { align: 'right', ...o });

  function drawOverlay(g, f) {
    const { T, n, powerOff, origScreen, lvl } = hud;
    if (T === undefined) return;
    const S = f.S, W = ctx.W, H = ctx.H;
    // S18：切黑之后，只有分类表第二栏的光标还在原处闪
    if (T >= cue('cut_black')) {
      if (T < cue('cursor_end')) drawVerdict(g, f, T, hud.verdictAnchor, true);
      return;
    }
    if (powerOff) {
      // 全黑里只剩角落一行小字，让观众知道这是断电，不是黑屏
      const a = 0.85 * smoothstep(tOff, tOff + 0.12, T);
      right(g, LABELS.power.off, W - 96 * S, 98 * S, { size: 15, alpha: a, S, color: overlay.COLORS.hudWarn, weight: 400, spacing: 0.3 });
      right(g, LABELS.power.offEn, W - 96 * S, 118 * S, { size: 9, alpha: a * 0.55, S, color: overlay.COLORS.hudWarn });
      return;
    }
    g.globalAlpha *= sagAt(T);
    // S13：AI 芯片（第一幕标注过的同一块芯片）+ 模拟的火 · 学习进度
    const s13a = digOn + 0.3, s13b = cue('card_c2b_in') - 0.6;
    if (T > digOn - 1.5 && T < s13b && hud.chipScreen) {
      const tc = digOn - 1.5;
      const a = util.envelope(T, tc, tc + 0.2, s13b - 1.4, s13b - 0.6);
      overlay.hudCallout(g, { anchor: hud.chipScreen, dir: [1, 0.18], len: 85, t: T - tc, alpha: a * 0.9, S,
        lines: [{ text: LABELS.chip.name }, { text: LABELS.chip.en, en: true }] });
    }
    if (T > s13a && T < s13b) {
      const a = util.envelope(T, s13a, s13a + 0.3, s13b - 0.8, s13b);
      const [N, NY] = DIG.levels[lvl];
      const [x, y] = origScreen;
      overlay.hudCallout(g, { anchor: [x + 70 * S, y - 10 * S], dir: [1, -0.55], len: 90, t: T - s13a, alpha: a * 0.85, S,
        lines: [{ text: LABELS.model.name }, { text: LABELS.model.fit(lvl >= 4 ? '99.96' : ((0.62 + lvl * 0.09) * 100).toFixed(0)) },
          { text: LABELS.model.en(N, NY), en: true }] });
    }
    // S15–S16：副本计数（右上角）
    const c0 = cue('copy_2') - 0.6, c1 = cue('hud_glitch') + 1.6;
    const gl = glitchAmt(T);
    if (T > c0 && T < c1 && !(T > cue('candle_return') - 0.1 && T < cue('ch3_in') + 0.8)) {
      const k = Math.min(n, 20);
      const a = smoothstep(c0, c0 + 0.4, T) * (1 - smoothstep(cue('hud_glitch') + 0.6, cue('hud_glitch') + 1.5, T));
      const X = W - 96 * S;
      const drawCounter = (gg) => {
        right(gg, `${LABELS.copies.name}  ${LABELS.copies.en}`, X, 74 * S, { size: 10.5, alpha: 0.6 * a, S });
        right(gg, fmtInt(2 ** k), X, 100 * S, { size: 19, alpha: 0.9 * a, S, weight: 300, spacing: 0.12 });
        gg.save(); gg.strokeStyle = overlay.rgba(overlay.COLORS.hud, 0.5 * a); gg.lineWidth = Math.max(1, S);
        gg.beginPath(); gg.moveTo(X, 82 * S); gg.lineTo(X - 190 * S, 82 * S); gg.stroke(); gg.restore();
        if (T < cue('ch3_in')) {
          // 指数爆发开始后：任何一个都可替换
          const tn = T - (cue('copy_cascade_start') + 0.9);
          if (tn > 0) {
            right(gg, typed(LABELS.copies.note, tn, 14), X, 132 * S, { size: 13, alpha: 0.9 * a, S, weight: 400, spacing: 0.14 });
            right(gg, LABELS.copies.noteEn, X, 152 * S, { size: 9, alpha: 0.45 * a * smoothstep(0.6, 1.2, tn), S });
          }
          // 来电：同一帧原样回来，并标明"毫发无损"
          const ra = smoothstep(tOn + 0.15, tOn + 0.5, T) * (1 - smoothstep(cue('candle_return') - 0.6, cue('candle_return') - 0.15, T));
          if (ra > 0.001) {
            right(gg, typed(LABELS.power.on, T - tOn - 0.15, 22), X, 186 * S, { size: 13, alpha: 0.9 * ra * a, S, spacing: 0.12, weight: 400 });
            right(gg, LABELS.power.onEn, X, 206 * S, { size: 9, alpha: 0.45 * ra * a, S });
          }
        } else {
          right(gg, LABELS.copies.sync, X, 132 * S, { size: 13, alpha: 0.7 * a, S, spacing: 0.12 });
          right(gg, LABELS.copies.syncEn, X, 152 * S, { size: 9, alpha: 0.4 * a, S });
        }
      };
      overlay.withGlitch(g, gl, (f.frame * 7919) % 100000, W, H, drawCounter);
    }
    // S16：安装日志 + 失步框（同一次故障里一起消散）
    drawOriginHud(g, f, gl);
    // S17：分类表最后一次出现
    if (T >= cue('verdict_label')) drawVerdict(g, f, T, hud.verdictAnchor, false);
  }
  function glitchAmt(T) {
    const t = T - cue('hud_glitch');
    if (t < 0) return 0;
    return clamp(0.25 + t * 0.9 + 0.3 * Math.sin(t * 40) * Math.sin(t * 13));
  }
  const installT = () => [cue('install_1'), cue('install_2'), cue('install_3')];
  function drawOriginHud(g, f, gl) {
    const { T, origTop, origBot, origSide } = hud;
    const S = f.S, W = ctx.W, H = ctx.H;
    const it = installT();
    const tg = cue('hud_glitch');
    const lead = 1.4; // 标题行先于第一条打出，第一条仍踩在 install_1 上
    if (T < it[0] - lead || T > tg + 1.6 || !origTop) return;
    const dissolve = 1 - smoothstep(tg + 0.6, tg + 1.5, T);
    if (dissolve <= 0) return;
    const draw = (gg) => {
      // 更新日志：每一样都是为了更好用
      const lines = [{ text: LABELS.installTitle, size: 11, alpha: 0.6, rate: 40 }];
      LABELS.install.forEach((l, k) => {
        lines.push({ text: `${l.add}  ${l.why}`, at: it[k] - it[0] + lead, size: 13.5 });
        lines.push({ text: l.en, en: true, size: 9, rate: 90 }); // 英文小字快打，三条中文各自踩在 install 提示音上
      });
      overlay.hudCallout(gg, { anchor: origSide, dir: [1, 0.1], len: 70, t: T - it[0] + lead, alpha: 0.92 * dissolve, S, lines, charRate: 26 });
      // 失步：红色取景框
      const t0 = cue('desync_start');
      if (T >= t0) {
        // 与备份的差异处数：几秒内从个位数涨到百万
        const diffs = Math.round(3 * Math.exp((T - t0) * 3.3)).toLocaleString('en-US');
        const x = (origTop[0] + origBot[0]) / 2;
        const bh = Math.min(Math.abs(origBot[1] - origTop[1]) * 1.06, H - 60 * S), bw = bh * 0.42;
        const y = (origTop[1] + origBot[1]) / 2;
        overlay.hudBracket(gg, { x, y, w: bw, h: bh, t: T - t0, alpha: dissolve, S, color: overlay.COLORS.hudWarn, corner: 16 });
        if (T - t0 > 0.3) {
          const lx = x + bw / 2 + 14 * S, ly = Math.max(y - bh / 2, 30 * S);
          const tt = T - t0 - 0.3;
          overlay.hudText(gg, typed(LABELS.desync.name(diffs), tt, 40), lx, ly + 16 * S, { size: 14, alpha: 0.95 * dissolve, S, color: overlay.COLORS.hudWarn, weight: 400, spacing: 0.1 });
          overlay.hudText(gg, typed(LABELS.desync.fact, tt - 0.3, 22), lx, ly + 42 * S, { size: 12.5, alpha: 0.85 * dissolve, S, color: overlay.COLORS.hudWarn, weight: 400, spacing: 0.1 });
          overlay.hudText(gg, LABELS.desync.en, lx, ly + 62 * S, { size: 9, alpha: 0.45 * dissolve * smoothstep(0.8, 1.2, tt), S, color: overlay.COLORS.hudWarn });
        }
      }
    };
    overlay.withGlitch(g, gl, (f.frame * 104729) % 100000 + 7, W, H, draw);
  }
  // 分类表：未分类 / 也许会思考 / 熄灭之后，▍
  // 第二句只打出开头，恰好在 verdict_cursor 时刻打完；之后只剩光标在闪（切黑后也在原处闪）
  function drawVerdict(g, f, T, anchor, cursorOnly) {
    if (!anchor) return;
    const tv = cue('verdict_label');
    const V = LABELS.verdict;
    const chars = V.name.length + V.think.length + V.lose.length;
    const rate = chars / Math.max(0.5, cue('verdict_cursor') - tv - 0.75 - 0.24);
    overlay.hudClassify(g, {
      ...V, open: true,
      anchor, dir: [1, -0.42], len: 64, t: T - tv, alpha: 0.95, S: f.S, charRate: rate, cursorOnly,
    });
  }

  return {
    msaa: 0,
    render,
    overlay: drawOverlay,
    dispose() {
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    },
  };
}
