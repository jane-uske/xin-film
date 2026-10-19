// 共享星空：序幕（S02/S03）与尾声（S19）都用它，保证首尾呼应时是同一片天空。
// 星点是加法混合的点精灵；星云在 1/4 分辨率离屏渲染后铺满背景。
import * as THREE from 'three';
import { all as GLSL } from '../../engine/glsl.js';
import { rng } from '../../engine/util.js';

const STAR_VS = /* glsl */ `
attribute float aBright, aTemp, aIgnite, aKind, aConnect, aPhase;
uniform float uT, uS, uIntensity, uBoost, uD0, uNodeGain, uMaxPx;
varying vec3 vCol; varying float vSharp;
${GLSL}
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.05);
  float age = uT - aIgnite;
  float on = smoothstep(0.0, 0.06, age);
  float flash = age > 0.0 ? exp(-age * 2.6) * 2.2 : 0.0;
  float tw = 0.86 + 0.14 * sin(uT * (1.3 + aPhase * 2.7) + aPhase * 37.0);
  float b = aBright * tw * on * (1.0 + flash);
  // 星座节点：连线到达时增亮并闪一下
  if (aKind > 0.5) {
    float ca = uT - aConnect;
    float c = smoothstep(0.0, 0.2, ca) * (1.0 + 1.6 * exp(-max(ca, 0.0) * 3.5));
    b *= uNodeGain * (1.0 + c * uBoost);
  }
  float I = b * (uD0 / dist) * (uD0 / dist);
  I = min(I, 60.0) * uIntensity;
  float px = uS * clamp(1.5 + 2.4 * log2(1.0 + I * 2.0), 1.4, uMaxPx);
  gl_PointSize = px;
  gl_Position = projectionMatrix * mv;
  // 小于 1.4 像素时用亮度补偿面积
  vec3 bb = blackbody(aTemp);
  vCol = bb / max(0.2, max(bb.r, max(bb.g, bb.b))) * I;
  vSharp = mix(9.0, 4.0, clamp(I / 20.0, 0.0, 1.0));
  if (I < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const STAR_FS = /* glsl */ `
varying vec3 vCol; varying float vSharp;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  float core = exp(-r2 * vSharp * 2.2);
  float halo = exp(-r2 * 2.2) * 0.08;
  float a = core + halo;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

const NEB_FS = /* glsl */ `
precision highp float; in vec2 vUv; out vec4 o;
uniform mat4 uInvProj, uCamWorld; uniform float uT, uAmount, uSeed;
${GLSL}
void main(){
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 v = uInvProj * ndc; v /= v.w;
  vec3 dir = normalize((uCamWorld * vec4(v.xyz, 0.0)).xyz);
  vec3 p = dir * 2.4 + vec3(uSeed, uSeed * 0.37, uT * 0.004);
  float n = fbm3(p, 5) * 0.5 + 0.5;
  float m = fbm3(p * 1.7 + vec3(5.2, 1.3, 2.8), 3) * 0.5 + 0.5;
  float band = exp(-pow(dir.y * 2.0 + 0.35 * sin(dir.x * 2.3 + uSeed), 2.0) * 1.4);
  float dens = pow(smoothstep(0.38, 0.95, n), 1.5) * (0.25 + 0.75 * band);
  vec3 teal = vec3(0.012, 0.075, 0.10), amber = vec3(0.13, 0.055, 0.016), deep = vec3(0.006, 0.010, 0.028);
  vec3 col = mix(teal, amber, smoothstep(0.5, 0.78, m)) * dens;
  float lane = smoothstep(0.52, 0.78, fbm3(p * 3.1 + 11.0, 3) * 0.5 + 0.5);
  col *= 1.0 - 0.75 * lane;
  col += deep * (0.4 + 0.6 * band);
  o = vec4(col * uAmount, 1.0);
}`;

export function createStarfield(ctx, { seed = 7, count = 34000, box = [110, 46, 520], zMin = -480, zMax = 40, skyCount = 9000, skyRadius = 2600, igniteFrom = null, igniteTo = null, nodes = [], clearRadius = 4.5, maxPx = 26 } = {}) {
  const r = rng(seed);
  const n = count + skyCount + nodes.length;
  const pos = new Float32Array(n * 3), bright = new Float32Array(n), temp = new Float32Array(n), ignite = new Float32Array(n), kind = new Float32Array(n), connect = new Float32Array(n), phase = new Float32Array(n);
  const tempOf = () => { const u = r(); return u < 0.55 ? 3200 + r() * 2600 : u < 0.85 ? 5800 + r() * 2500 : 8500 + r() * 9000; };
  const igniteOf = () => (igniteFrom === null ? -1e4 : igniteFrom + (igniteTo - igniteFrom) * Math.sqrt(r()));
  let i = 0;
  for (; i < count; i++) {
    let x, y;
    do { x = (r() - 0.5) * box[0] * 2; y = (r() - 0.5) * box[1] * 2; } while (Math.hypot(x, y * 1.6) < clearRadius);
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = zMin + r() * (zMax - zMin);
    bright[i] = 0.015 + 0.9 * Math.pow(r(), 9) + 0.05 * Math.pow(r(), 3);
    temp[i] = tempOf(); ignite[i] = igniteOf(); kind[i] = 0; connect[i] = 1e4; phase[i] = r();
  }
  for (let k = 0; k < skyCount; k++, i++) {
    const [x, y, z] = r.unitVec();
    pos[i * 3] = x * skyRadius; pos[i * 3 + 1] = y * skyRadius * 0.8; pos[i * 3 + 2] = z * skyRadius;
    bright[i] = (0.02 + 1.6 * Math.pow(r(), 7)) * (skyRadius / 60) * (skyRadius / 60) * 0.004;
    temp[i] = tempOf(); ignite[i] = igniteOf(); kind[i] = 0; connect[i] = 1e4; phase[i] = r();
  }
  for (const nd of nodes) {
    pos.set(nd.pos, i * 3);
    bright[i] = nd.bright ?? 1.0; temp[i] = nd.temp ?? 7000; ignite[i] = nd.ignite ?? -1e4; kind[i] = 1; connect[i] = nd.connect ?? 1e4; phase[i] = r();
    i++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  g.setAttribute('aTemp', new THREE.BufferAttribute(temp, 1));
  g.setAttribute('aIgnite', new THREE.BufferAttribute(ignite, 1));
  g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  g.setAttribute('aConnect', new THREE.BufferAttribute(connect, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: STAR_VS, fragmentShader: STAR_FS,
    uniforms: { uT: { value: 0 }, uS: { value: ctx.S }, uIntensity: { value: 1 }, uBoost: { value: 1.2 }, uD0: { value: 60 }, uNodeGain: { value: 1 }, uMaxPx: { value: maxPx } },
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;

  // 星云：1/4 分辨率
  const nebRT = ctx.makeTarget(Math.ceil(ctx.W / 4), Math.ceil(ctx.H / 4), { depth: false });
  const nebMat = ctx.passMaterial(NEB_FS, { uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uT: { value: 0 }, uAmount: { value: 1 }, uSeed: { value: seed * 0.731 } });
  const bgMat = new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D tNeb; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tNeb, vUv).rgb, 1.0); }`,
    uniforms: { tNeb: { value: nebRT.texture } }, depthTest: false, depthWrite: false,
  });
  const bgGeo = new THREE.BufferGeometry();
  bgGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const bg = new THREE.Mesh(bgGeo, bgMat);
  bg.frustumCulled = false; bg.renderOrder = -10;

  return {
    points, bg, nodeOffset: count + skyCount,
    // 每帧在渲染主场景之前调用
    update(T, camera, { intensity = 1, nebula = 1, boost = 1.2, nodeGain = 1 } = {}) {
      mat.uniforms.uT.value = T; mat.uniforms.uIntensity.value = intensity; mat.uniforms.uBoost.value = boost; mat.uniforms.uNodeGain.value = nodeGain;
      camera.updateMatrixWorld();
      nebMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
      nebMat.uniforms.uCamWorld.value.copy(camera.matrixWorld);
      nebMat.uniforms.uT.value = T; nebMat.uniforms.uAmount.value = nebula;
      bg.visible = nebula > 0.001;
      if (bg.visible) ctx.fsq.render(ctx.renderer, nebMat, nebRT);
    },
    dispose() { g.dispose(); mat.dispose(); nebRT.dispose(); nebMat.dispose(); bgMat.dispose(); bgGeo.dispose(); },
  };
}
