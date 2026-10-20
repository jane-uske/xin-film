// Act I · Earth: night-side planet with procedural continents, warm city-light clusters joined by road
// filaments, a thin Rayleigh rim and a sunrise starburst. Land mask is a CPU texture shared by the
// surface shader and the city-light generator, so lights always sit on land.
import { makeNoise3, POINT_VS, POINT_FS } from './lib.js';

export const EARTH_R = 6.0;

export function buildEarth(ctx, scene, { E, patchN }) {
  const { THREE, util, glsl } = ctx;
  const rng = util.rng(9091);
  const noise = makeNoise3(util.rng(313));
  const pn = new THREE.Vector3(...patchN).normalize();

  // ---------------------------------------------------------------- land mask (equirectangular)
  const TW = 512, TH = 256;
  const land = new Float32Array(TW * TH);
  const dirOf = (u, v) => { const lon = (u - 0.5) * Math.PI * 2, lat = (0.5 - v) * Math.PI; return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]; };
  const landAt = (d) => {
    const f = noise.fbm(d[0] * 1.6 + 3, d[1] * 1.6, d[2] * 1.6 - 2, 5);
    const near = d[0] * pn.x + d[1] * pn.y + d[2] * pn.z;
    const bump = 0.32 * Math.exp(-Math.pow((1 - near) / 0.05, 2) * 0.5) ; // make sure the metro sits on a continent
    return f + bump - 0.04 - 0.12 * Math.pow(Math.abs(d[1]), 6);
  };
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) land[j * TW + i] = landAt(dirOf((i + 0.5) / TW, (j + 0.5) / TH));
  const data = new Uint8Array(TW * TH * 4);
  for (let k = 0; k < TW * TH; k++) { const v = util.clamp(land[k] * 2.5 + 0.5); data[k * 4] = v * 255; data[k * 4 + 1] = 0; data[k * 4 + 2] = 0; data[k * 4 + 3] = 255; }
  const landTex = new THREE.DataTexture(data, TW, TH, THREE.RGBAFormat);
  landTex.wrapS = THREE.RepeatWrapping; landTex.minFilter = THREE.LinearFilter; landTex.magFilter = THREE.LinearFilter; landTex.needsUpdate = true;
  const landLookup = (d) => {
    const lon = Math.atan2(d[2], d[0]), lat = Math.asin(util.clamp(d[1], -1, 1));
    const u = lon / (Math.PI * 2) + 0.5, v = 0.5 - lat / Math.PI;
    const i = Math.min(TW - 1, Math.floor(u * TW)), j = Math.min(TH - 1, Math.floor(v * TH));
    return land[j * TW + i];
  };

  const group = new THREE.Group();
  group.position.set(E[0], E[1], E[2]);
  scene.add(group);

  const sunU = { value: new THREE.Vector3(-1, 0, 0) }; // direction Earth -> Sun (world)

  // ---------------------------------------------------------------- surface
  const surfU = { uSun: sunU, uLand: { value: landTex }, uT: { value: 0 }, uNight: { value: 1 } };
  const surf = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 128, 96), new THREE.ShaderMaterial({
    uniforms: surfU,
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(position); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform sampler2D uLand; uniform float uT, uNight;
      varying vec3 vN; varying vec3 vW;
      ${glsl.simplex3}
      void main(){
        vec3 n = normalize(vN);
        vec2 uv = vec2(atan(n.z, n.x) / 6.28318 + 0.5, 0.5 - asin(clamp(n.y, -1.0, 1.0)) / 3.14159);
        float l = texture(uLand, uv).r;
        float isLand = smoothstep(0.49, 0.53, l);
        float ndl = dot(n, uSun);
        float day = smoothstep(-0.08, 0.25, ndl);
        vec3 V = normalize(cameraPosition - vW);
        // day side (only a crescent is ever seen): ocean, land, clouds
        float cl = 0.0;
        if (day > 0.001) cl = smoothstep(0.05, 0.55, snoise(n * 4.0 + vec3(0.0, 0.0, uT * 0.01)) * 0.6 + snoise(n * 9.0) * 0.4);
        vec3 ocean = vec3(0.01, 0.035, 0.09);
        vec3 ground = mix(vec3(0.07, 0.07, 0.035), vec3(0.11, 0.085, 0.05), l);
        vec3 alb = mix(ocean, ground, isLand);
        alb = mix(alb, vec3(0.55), cl * 0.8);
        float spec = pow(max(dot(reflect(-uSun, n), V), 0.0), 40.0) * (1.0 - isLand) * (1.0 - cl);
        vec3 dayCol = alb * max(ndl, 0.0) * 2.2 + vec3(1.0, 0.8, 0.6) * spec * 1.5 * day;
        // night side: faint airglow/earthshine so the continents read as shapes against the black ocean
        vec3 nightCol = mix(vec3(0.0015, 0.003, 0.007), vec3(0.004, 0.0045, 0.006), isLand) * uNight;
        // warm terminator band
        float term = exp(-pow(ndl / 0.06, 2.0)) * 0.15;
        vec3 col = mix(nightCol, dayCol, day) + vec3(1.0, 0.35, 0.1) * term * 0.05;
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  group.add(surf);

  // ---------------------------------------------------------------- city lights + roads
  const pts = [], cols = [];
  const cities = [];
  const exclude = (d) => (d[0] * pn.x + d[1] * pn.y + d[2] * pn.z) > Math.cos(0.135);
  let guard = 0;
  while (cities.length < 520 && guard++ < 200000) {
    const d = rng.unitVec();
    const l = landLookup(d);
    if (l < 0.02) continue;
    if (Math.abs(d[1]) > 0.86) continue;
    if (exclude(d)) continue;
    // cities prefer coasts and the metro's continent
    const coast = Math.exp(-Math.pow((l - 0.05) / 0.08, 2));
    if (rng() > 0.25 + coast * 0.75) continue;
    const size = Math.pow(rng(), 3.2);
    cities.push({ d, size });
  }
  const tan = (d) => { const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; const t1 = new THREE.Vector3(...d).cross(new THREE.Vector3(...a)).normalize(); const t2 = new THREE.Vector3(...d).cross(t1).normalize(); return [t1, t2]; };
  const R1 = EARTH_R * 1.0015;
  const pushPt = (v, c) => { pts.push(v.x * R1, v.y * R1, v.z * R1); cols.push(c[0], c[1], c[2], c[3]); };
  for (const c of cities) {
    const [t1, t2] = tan(c.d);
    const nP = Math.floor(8 + 260 * c.size);
    const sig = 0.004 + 0.022 * Math.sqrt(c.size);
    for (let k = 0; k < nP; k++) {
      const r = Math.abs(rng.gauss()) * sig * (rng() < 0.2 ? 2.2 : 1), a = rng() * Math.PI * 2;
      const v = new THREE.Vector3(...c.d).addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).normalize();
      const core = Math.exp(-r / sig);
      pushPt(v, [1.0, 0.62 + 0.2 * core, 0.3 + 0.2 * core, (0.25 + 0.75 * core) * (0.5 + c.size)]);
    }
  }
  // roads: great-circle filaments to the two nearest neighbours
  for (let i = 0; i < cities.length; i++) {
    const a = cities[i];
    const nb = cities.map((b, j) => [j, b.d[0] * a.d[0] + b.d[1] * a.d[1] + b.d[2] * a.d[2]]).filter(([j]) => j !== i).sort((x, y) => y[1] - x[1]).slice(0, 2);
    for (const [j, dt] of nb) {
      if (j < i || dt < Math.cos(0.32)) continue;
      const b = cities[j];
      const A = new THREE.Vector3(...a.d), B = new THREE.Vector3(...b.d);
      const ang = A.angleTo(B);
      const n = Math.floor(ang * 900);
      for (let k = 0; k < n; k++) {
        const s = rng();
        const v = A.clone().lerp(B, s).normalize();
        const [t1] = tan([v.x, v.y, v.z]);
        v.addScaledVector(t1, Math.sin(s * Math.PI * 3 + i) * 0.006 + rng.gauss() * 0.0012).normalize();
        if (landLookup([v.x, v.y, v.z]) < 0.0) continue;
        pushPt(v, [1.0, 0.55, 0.22, 0.12 + 0.1 * rng()]);
      }
    }
  }
  const NL = pts.length / 3;
  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  lightGeo.setAttribute('aC', new THREE.BufferAttribute(new Float32Array(cols), 4));
  const lightU = { uSun: sunU, uI: { value: 1 }, uS: { value: ctx.S }, uPx: { value: 1.6 } };
  const lights = new THREE.Points(lightGeo, new THREE.ShaderMaterial({
    uniforms: lightU,
    vertexShader: /* glsl */ `
      attribute vec4 aC; uniform vec3 uSun; uniform float uI, uPx; ${POINT_VS} varying vec3 vCol;
      void main(){
        vec3 n = normalize(position);
        float night = smoothstep(0.12, -0.1, dot(n, uSun));
        vec4 w = modelMatrix * vec4(position, 1.0);
        vec3 V = normalize(cameraPosition - w.xyz);
        float facing = smoothstep(0.0, 0.25, dot(normalize((modelMatrix * vec4(n, 0.0)).xyz), V));
        vec4 mv = viewMatrix * w;
        gl_PointSize = pointSize(uPx * (0.8 + aC.a * 0.6));
        vCol = aC.rgb * aC.a * uI * night * facing * vAlphaK * 1.6;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `${POINT_FS} varying vec3 vCol; void main(){ gl_FragColor = vec4(vCol * spriteMask(2.5), 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  }));
  lights.frustumCulled = false;
  group.add(lights);

  // ---------------------------------------------------------------- atmosphere (analytic rim)
  const RA = EARTH_R * 1.035;
  const atmoU = { uSun: sunU, uI: { value: 1 }, uE: { value: new THREE.Vector3(...E) } };
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(RA, 128, 96), new THREE.ShaderMaterial({
    uniforms: atmoU,
    vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun, uE; uniform float uI; varying vec3 vW;
      void main(){
        vec3 ro = cameraPosition - uE;
        vec3 rd = normalize(vW - cameraPosition);
        float tc = -dot(ro, rd);
        vec3 pc = ro + rd * tc;
        float b = length(pc);
        float Re = ${EARTH_R.toFixed(3)}, Ra = ${RA.toFixed(3)};
        float H = (Ra - Re) * 0.22;
        float hit = step(b, Re);
        // path length through the shell at closest approach (grazing rays are long)
        float h = max(b - Re, 0.0);
        float dens = exp(-h / H);
        float path = sqrt(max(Ra * Ra - b * b, 0.0)) * (1.0 - hit * 0.85);
        float od = dens * path / (2.0 * sqrt(Ra * Ra - Re * Re));
        vec3 nc = hit > 0.5 ? normalize(vW - uE) : pc / max(b, 1e-3);
        float lit = smoothstep(-0.32, 0.12, dot(nc, uSun));
        float mu = dot(rd, uSun);
        float fwd = pow(max(mu, 0.0), 12.0) * 2.0 + pow(max(mu, 0.0), 300.0) * 6.0;
        vec3 ray = vec3(0.16, 0.38, 1.0);
        vec3 sunset = vec3(1.0, 0.42, 0.14);
        // reddened low layer near the terminator, blue above
        float low = exp(-h / (H * 0.35));
        vec3 c = mix(ray, sunset, low * smoothstep(0.35, -0.1, dot(nc, uSun)) * 0.9);
        vec3 col = c * od * lit * (0.35 + fwd) + ray * od * 0.01;
        gl_FragColor = vec4(col * uI, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  }));
  group.add(atmo);

  // ---------------------------------------------------------------- sunrise starburst (lens element: not depth-tested)
  const burstU = { uI: { value: 0 }, uSize: { value: 40 }, uRot: { value: 0 } };
  const burst = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: burstU,
    vertexShader: /* glsl */ `uniform float uSize; varying vec2 vP; void main(){ vP = position.xy * 2.0; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); mv.xy += position.xy * uSize; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform float uI, uRot; varying vec2 vP;
      void main(){
        float r = length(vP);
        if (r > 1.0) discard;
        float a = atan(vP.y, vP.x) + uRot;
        float spikes = pow(abs(cos(a * 3.0)), 60.0) * 0.9 + pow(abs(cos(a * 3.0 + 0.5236)), 200.0) * 0.4 + pow(abs(cos(a * 9.0 + 0.3)), 30.0) * 0.15;
        float core = exp(-r * r * 2500.0) * 40.0 + exp(-r * r * 260.0) * 2.5 + exp(-r * 9.0) * 0.25;
        float ray = spikes * exp(-r * 4.5) * 1.6;
        float g = (core + ray) * smoothstep(1.0, 0.8, r);
        gl_FragColor = vec4(vec3(1.0, 0.9, 0.78) * g * uI, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  burst.frustumCulled = false; burst.renderOrder = 20;
  scene.add(burst);

  return { group, surf, surfU, lights, lightU, atmo, atmoU, burst, burstU, sunU, NL, landLookup };
}
