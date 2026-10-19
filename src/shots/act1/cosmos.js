// Act I · cosmos: molecular cloud -> accretion disk -> implosion -> ignition -> newborn star.
// All particle motion is a closed-form function of uniforms derived from T (see heat.js).
import { makeNoise3, POINT_VS, POINT_FS } from './lib.js';

export const SUN_R = 7.0;

export function buildCosmos(ctx, scene) {
  const { THREE, util, glsl } = ctx;
  const rng = util.rng(4242);
  const noise = makeNoise3(util.rng(77));

  // ---------------------------------------------------------------- cloud / disk particles
  const N = 210000;
  const aCyl = new Float32Array(N * 3), aDisk = new Float32Array(N * 3), aRnd = new Float32Array(N * 4);
  // Filaments: streamlines traced through a smooth noise vector field (like Herschel cloud maps),
  // with particles scattered around them; plus a thin diffuse component.
  let n = 0;
  const field = (x, y, z) => {
    const fx = noise.fbm(x * 0.035, y * 0.035, z * 0.035, 2), fy = noise.fbm(x * 0.035 + 5.2, y * 0.035 + 1.3, z * 0.035 + 7.7, 2) * 0.35, fz = noise.fbm(x * 0.035 + 9.1, y * 0.035 + 4.4, z * 0.035 + 2.8, 2);
    const l = Math.hypot(fx, fy, fz) || 1; return [fx / l, fy / l, fz / l];
  };
  const push = (x, y, z, dusty) => {
    const Rc = Math.hypot(x, z), phi = Math.atan2(z, x);
    let Rd = 1.4 + 21 * Math.pow(Math.min(Rc, 36) / 36, 1.15) * (0.82 + 0.36 * rng());
    if (rng() < 0.05) Rd = 0.9 + 4 * Math.pow(rng(), 1.3); // dense inner disk
    Rd = Math.min(Rd, 27);
    const yd = rng.gauss() * (0.03 + 0.03 * Rd) * 0.7;
    const om = 0.12 * Math.pow(Math.max(Rd, 1.8) / 10, -1.5);
    aCyl.set([Rc, phi, y], n * 3);
    aDisk.set([Rd, yd, om], n * 3);
    aRnd.set([rng(), rng(), rng(), dusty ? 1 : 0], n * 4);
    n++;
  };
  const NF = 520;
  for (let fi = 0; fi < NF && n < N; fi++) {
    let x, y, z;
    do { x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1; } while (x * x + y * y + z * z > 1);
    x *= 32; y *= 13; z *= 32;
    const steps = 30 + Math.floor(rng() * 40);
    const pts = [];
    const dir = rng() < 0.5 ? 1 : -1;
    for (let k = 0; k < steps; k++) {
      pts.push([x, y, z]);
      const v = field(x, y, z);
      x += v[0] * 0.9 * dir; y += v[1] * 0.9 * dir; z += v[2] * 0.9 * dir;
    }
    const per = Math.floor(((N * 0.86) / NF) * (0.4 + 1.2 * rng()));
    const w0 = 0.25 + 1.1 * rng() * rng();
    const dusty = rng() < 0.35;
    for (let k = 0; k < per && n < N; k++) {
      const a = rng() * (pts.length - 1), i0 = Math.floor(a), fr = a - i0;
      const P0 = pts[i0], P1 = pts[i0 + 1];
      const wv = w0 * (0.5 + Math.sin((a / pts.length) * Math.PI)) ;
      const px = P0[0] + (P1[0] - P0[0]) * fr + rng.gauss() * wv;
      const py = P0[1] + (P1[1] - P0[1]) * fr + rng.gauss() * wv * 0.7;
      const pz = P0[2] + (P1[2] - P0[2]) * fr + rng.gauss() * wv;
      const e = (px / 36) ** 2 + (py / 16) ** 2 + (pz / 36) ** 2;
      if (e > 1) continue;
      push(px, py, pz, dusty ? rng() < 0.7 : rng() < 0.15);
    }
  }
  while (n < N) {
    const u = rng() * 2 - 1, v = rng() * 2 - 1, w = rng() * 2 - 1;
    if (u * u + v * v + w * w > 1) continue;
    push(u * 34, v * 14, w * 34, rng() < 0.25);
  }
  const NC = n;
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NC * 3), 3));
  cloudGeo.setAttribute('aCyl', new THREE.BufferAttribute(aCyl.subarray(0, NC * 3), 3));
  cloudGeo.setAttribute('aDisk', new THREE.BufferAttribute(aDisk.subarray(0, NC * 3), 3));
  cloudGeo.setAttribute('aRnd', new THREE.BufferAttribute(aRnd.subarray(0, NC * 4), 4));
  cloudGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  const cloudU = {
    uT: { value: 0 }, uCollapse: { value: 0 }, uG: { value: 0 }, uImp: { value: 0 }, uShock: { value: -1 },
    uHeat: { value: 0 }, uFade: { value: 1 }, uS: { value: ctx.S }, uSize: { value: 1 }, uGain: { value: 1 }, uDebris: { value: 1 },
  };

  const CLOUD_FN = /* glsl */ `
  uniform float uT, uCollapse, uG, uImp, uShock, uHeat, uFade, uSize, uGain, uDebris;
  ${glsl.simplex3}
  ${glsl.blackbody}
  // returns world position; writes heat colour terms
  vec3 cloudPos(vec3 cyl, vec3 dsk, vec4 rnd, out vec3 col, out float vis){
    float stagger = clamp(cyl.x / 34.0, 0.0, 1.0) * 0.42;
    float c = clamp((uCollapse - stagger) / (1.0 - stagger), 0.0, 1.0);
    float cY = smoothstep(0.0, 0.7, c);
    float cR = smoothstep(0.08, 1.0, c);
    float R = mix(cyl.x, dsk.x, cR);
    float y = mix(cyl.z, dsk.y, cY);
    float phi = cyl.y + dsk.z * uG;
    // implosion: inner disk falls all the way, outer disk is dragged part-way
    float k = uImp * uImp * uImp;
    float w = mix(1.0, 0.45, smoothstep(5.0, 24.0, dsk.x));
    phi += uImp * uImp * 2.2 * pow(10.0 / max(dsk.x, 1.5), 0.5);
    R *= 1.0 - 0.975 * k * w;
    y *= 1.0 - 0.95 * k;
    // ignition shock: snowplough -> particles pile up just behind the expanding front
    float front = 0.0, shocked = 0.0;
    if (uShock > 0.0){
      float Rs = 46.0 * (1.0 - exp(-uShock * 1.35)) + uShock * 0.6;
      float f = 0.25 + 0.75 * pow(rnd.y, 0.3);
      float Rp = Rs * f;
      if (Rp > R){
        shocked = 1.0;
        front = exp(-pow((1.0 - f) * 9.0, 2.0)) * exp(-uShock * 0.9);
        R = Rp;
        y = y * (1.0 + 2.5 * (1.0 - exp(-uShock))) + (rnd.z - 0.5) * (0.3 + uShock * 0.35) * (0.4 + f);
      }
    }
    vec3 p = vec3(cos(phi) * R, y, sin(phi) * R);
    // turbulent drift of the cold cloud, damped as the disk organises
    float turb = (1.0 - cR) * 2.4 + shocked * min(uShock, 4.0) * 0.5;
    vec3 q = p * 0.06 + vec3(0.0, uT * 0.035, rnd.x * 0.4);
    p += vec3(snoise(q), snoise(q + 31.4), snoise(q + 71.7)) * turb;

    // ---- colour: cold gas (teal) / dust (amber) + thermal emission of the heating disk
    float Rn = max(R, 0.7);
    vec3 gas = mix(vec3(0.010, 0.050, 0.075), vec3(0.030, 0.13, 0.17), rnd.z);
    vec3 dust = mix(vec3(0.28, 0.11, 0.035), vec3(0.55, 0.25, 0.07), rnd.x);
    vec3 base = rnd.w > 0.5 ? dust * 0.55 : gas;
    base *= 0.7 + 0.6 * cR; // dust lanes brighten as the disk compresses
    float K = 800.0 + uHeat * 7800.0 * pow(1.3 / Rn, 0.8) + k * w * 5000.0;
    float em = uHeat * uHeat * 1.6 * pow(1.6 / Rn, 1.35) + k * w * (1.0 + 3.0 * k);
    em *= (1.0 - shocked);
    vec3 hot = blackbody(K) * em;
    // shock-heated material: blue-white at the front, cooling to orange / dull red behind it
    float Ks = 2200.0 + 11000.0 * front;
    vec3 sh = blackbody(Ks) * (front * 9.0 + shocked * 0.18 * exp(-uShock * 0.6));
    col = (base + hot) * (1.0 - shocked) + (base * 0.7 * uDebris + sh) * shocked;
    vis = 1.0;
    return p;
  }`;

  const cloudMat = new THREE.ShaderMaterial({
    uniforms: cloudU,
    vertexShader: /* glsl */ `
      attribute vec3 aCyl; attribute vec3 aDisk; attribute vec4 aRnd;
      ${POINT_VS}
      ${CLOUD_FN}
      varying vec3 vCol;
      void main(){
        vec3 col; float vis;
        vec3 p = cloudPos(aCyl, aDisk, aRnd, col, vis);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        float px = uSize * (1.1 + 1.6 * aRnd.x * aRnd.x) * clamp(34.0 / dist, 0.5, 3.0);
        gl_PointSize = pointSize(px);
        // particles close to the lens are pulled out of focus and faded instead of becoming blobs
        float near = smoothstep(1.5, 9.0, dist);
        vCol = col * vAlphaK * uFade * uGain * near * (aRnd.w > 0.5 ? 1.3 : 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${POINT_FS}
      varying vec3 vCol;
      void main(){ float m = spriteMask(3.0); gl_FragColor = vec4(vCol * m, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  });
  const cloud = new THREE.Points(cloudGeo, cloudMat);
  cloud.frustumCulled = false;
  scene.add(cloud);

  // haze: a random subset re-drawn with large soft sprites into a quarter-res target
  const hazeScene = new THREE.Scene();
  const hazeU = Object.assign({}, cloudU, { uS: { value: ctx.S / 4 }, uSize: { value: 30 }, uGain: { value: 0.03 } });
  const hazeMat = cloudMat.clone();
  hazeMat.uniforms = hazeU;
  hazeMat.depthTest = false;
  const haze = new THREE.Points(cloudGeo, hazeMat);
  haze.frustumCulled = false;
  hazeScene.add(haze);
  const NH = Math.min(NC, 26000); // haze uses every k-th particle via its own index buffer
  const hazeRT = ctx.makeTarget(Math.round(ctx.W / 4), Math.round(ctx.H / 4), { depth: false });
  const hazeComp = ctx.passMaterial(/* glsl */ `
    precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D tH; uniform float k;
    void main(){ o = vec4(texture(tH, vUv).rgb * k, 1.0); }`,
    { tH: { value: hazeRT.texture }, k: { value: 1 } }, { blending: THREE.AdditiveBlending, transparent: true });

  // ---------------------------------------------------------------- embers (from the epigraph)
  const NE = 2600;
  const eA = new Float32Array(NE * 4), eCyl = new Float32Array(NE * 3), eDisk = new Float32Array(NE * 3), eRnd = new Float32Array(NE * 4);
  for (let i = 0; i < NE; i++) {
    const j = Math.floor(rng() * NC);
    eCyl.set(aCyl.subarray(j * 3, j * 3 + 3), i * 3);
    eDisk.set(aDisk.subarray(j * 3, j * 3 + 3), i * 3);
    eRnd.set(aRnd.subarray(j * 4, j * 4 + 4), i * 4);
    // start: across the frame, low, between camera and the cloud
    eA.set([rng() * 2 - 1, rng(), rng(), rng()], i * 4);
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NE * 3), 3));
  emberGeo.setAttribute('aE', new THREE.BufferAttribute(eA, 4));
  emberGeo.setAttribute('aCyl', new THREE.BufferAttribute(eCyl, 3));
  emberGeo.setAttribute('aDisk', new THREE.BufferAttribute(eDisk, 3));
  emberGeo.setAttribute('aRnd', new THREE.BufferAttribute(eRnd, 4));
  const emberU = Object.assign({}, cloudU, { uSize: { value: 1 }, uGain: { value: 1 }, uCamR: { value: new THREE.Vector3(1, 0, 0) }, uCamF: { value: new THREE.Vector3(0, 0, -1) }, uCam0: { value: new THREE.Vector3() }, uEm: { value: 1 } });
  const emberMat = new THREE.ShaderMaterial({
    uniforms: emberU,
    vertexShader: /* glsl */ `
      attribute vec4 aE; attribute vec3 aCyl; attribute vec3 aDisk; attribute vec4 aRnd;
      uniform vec3 uCamR, uCamF, uCam0; uniform float uEm;
      ${POINT_VS}
      ${CLOUD_FN}
      varying vec3 vCol;
      void main(){
        vec3 col; float vis;
        vec3 target = cloudPos(aCyl, aDisk, aRnd, col, vis);
        float t = uT - 30.0;
        // free rise in front of the opening camera
        float depth = mix(16.0, 46.0, aE.z);
        vec3 up = vec3(0.0, 1.0, 0.0);
        vec3 s = uCam0 + uCamF * depth + uCamR * aE.x * depth * 0.62 + up * (-0.34 * depth + aE.y * depth * 0.3);
        float rise = (0.9 + 1.4 * aE.w) * (t + 2.0);
        vec3 q = vec3(aE.x * 3.0, aE.y * 3.0 + t * 0.12, aE.w * 5.0);
        s += up * rise + vec3(snoise(q), 0.3 * snoise(q + 11.0), snoise(q + 23.0)) * 2.2;
        // drawn into the cloud
        float t0 = 31.0 + 5.5 * aE.w * aE.w + 1.5 * aE.z;
        float k = smoothstep(t0, t0 + 5.0, uT);
        k = k * k * (3.0 - 2.0 * k);
        vec3 p = mix(s, target, k);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        float px = (2.0 + 2.0 * aE.y) * mix(1.0, 0.6, k);
        gl_PointSize = pointSize(px);
        // amber -> ember red as it cools, flickering; fades into the cloud's own dust colour
        float fl = 0.65 + 0.35 * sin(uT * (5.0 + 7.0 * aE.w) + aE.x * 40.0);
        vec3 amber = mix(vec3(1.0, 0.42, 0.14), vec3(1.0, 0.16, 0.03), smoothstep(0.0, 0.9, k + aE.z * 0.3));
        float I = mix(2.2, 0.35, k) * fl * (1.0 - smoothstep(0.85, 1.0, k));
        vCol = amber * I * vAlphaK * uEm * smoothstep(2.0, 6.0, dist);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${POINT_FS}
      varying vec3 vCol;
      void main(){ float m = spriteMask(2.2); gl_FragColor = vec4(vCol * m, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
  const embers = new THREE.Points(emberGeo, emberMat);
  embers.frustumCulled = false;
  scene.add(embers);

  // ---------------------------------------------------------------- billboard helper
  const BILL_VS = /* glsl */ `
    uniform float uSize; varying vec2 vP;
    void main(){ vP = position.xy * 2.0; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); mv.xy += position.xy * uSize; gl_Position = projectionMatrix * mv; }`;
  const plane = new THREE.PlaneGeometry(1, 1);

  // protostar core glow
  const coreU = { uSize: { value: 10 }, uCol: { value: new THREE.Vector3(1, 0.4, 0.1) }, uI: { value: 0 }, uTight: { value: 1 } };
  const core = new THREE.Mesh(plane, new THREE.ShaderMaterial({
    uniforms: coreU, vertexShader: BILL_VS,
    fragmentShader: /* glsl */ `
      uniform vec3 uCol; uniform float uI, uTight; varying vec2 vP;
      void main(){
        float r = length(vP);
        if (r > 1.0) discard;
        float g = exp(-r * r * 60.0 * uTight) * 6.0 + exp(-r * r * 9.0 * uTight) * 0.6 + 0.08 / (1.0 + r * r * 400.0 * uTight);
        g *= smoothstep(1.0, 0.6, r);
        gl_FragColor = vec4(uCol * g * uI, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  core.frustumCulled = false; core.renderOrder = 5;
  scene.add(core);

  // ignition flash (camera-facing, huge)
  const flashU = { uSize: { value: 200 }, uI: { value: 0 }, uR: { value: 0.3 } };
  const flash = new THREE.Mesh(plane, new THREE.ShaderMaterial({
    uniforms: flashU, vertexShader: BILL_VS,
    fragmentShader: /* glsl */ `
      uniform float uI, uR; varying vec2 vP;
      void main(){
        float r = length(vP);
        if (r > 1.0) discard;
        float g = exp(-r * r / (uR * uR)) + 0.25 * exp(-r * r / (uR * uR * 12.0));
        g *= smoothstep(1.0, 0.7, r);
        gl_FragColor = vec4(vec3(0.85, 0.93, 1.0) * g * uI, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  flash.frustumCulled = false; flash.renderOrder = 10;
  scene.add(flash);

  // shockwave ring in the disk plane
  const ringGeo = new THREE.RingGeometry(0.7, 1.08, 256, 1);
  ringGeo.rotateX(-Math.PI / 2);
  const ringU = { uI: { value: 0 }, uW: { value: 0.05 } };
  const ring = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
    uniforms: ringU,
    vertexShader: /* glsl */ `varying float vR; varying vec3 vW; void main(){ vR = length(position.xz); vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uI, uW; varying float vR; varying vec3 vW;
      void main(){
        float d = (vR - 1.0) / uW;
        float g = exp(-d * d) + 0.35 * exp(-max(-d, 0.0) * 0.35) * step(vR, 1.0) * smoothstep(0.7, 0.95, vR);
        float a = atan(vW.z, vW.x);
        g *= 0.8 + 0.2 * sin(a * 23.0) * sin(a * 7.0 + 1.3);
        gl_FragColor = vec4(vec3(0.75, 0.88, 1.0) * g * uI, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
  }));
  ring.frustumCulled = false;
  scene.add(ring);

  // ---------------------------------------------------------------- the star
  const starU = { uT: { value: 0 }, uTemp: { value: 5778 }, uI: { value: 4 }, uHot: { value: 0 }, uGran: { value: 1 } };
  const starMat = new THREE.ShaderMaterial({
    uniforms: starU,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vVN; varying vec3 vVP;
      void main(){ vN = normal; vVN = normalMatrix * normal; vec4 mv = modelViewMatrix * vec4(position, 1.0); vVP = mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uTemp, uI, uHot, uGran;
      varying vec3 vN; varying vec3 vVN; varying vec3 vVP;
      ${glsl.hash}
      ${glsl.simplex3}
      ${glsl.blackbody}
      // animated Worley F1/F2 (3x3x3): bright convective cells, dark intergranular lanes
      vec2 worley(vec3 p, float t){
        vec3 i = floor(p), f = fract(p);
        float d1 = 8.0, d2 = 8.0;
        for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
          vec3 g = vec3(float(x), float(y), float(z));
          vec3 h = hash33(i + g);
          vec3 o = 0.5 + 0.42 * sin(t * (0.5 + h.yzx) + 6.2831 * h);
          vec3 r = g + o - f;
          float d = dot(r, r);
          if (d < d1){ d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
        return sqrt(vec2(d1, d2));
      }
      void main(){
        vec3 n = normalize(vN);
        float mu = clamp(dot(normalize(vVN), normalize(-vVP)), 0.0, 1.0);
        float t = uT;
        // slow differential rotation of the photosphere
        float rot = t * 0.012;
        vec3 q = vec3(n.x * cos(rot) - n.z * sin(rot), n.y, n.x * sin(rot) + n.z * cos(rot));
        vec3 wp = q * 3.0;
        vec3 warp = vec3(snoise(wp + t * 0.05), snoise(wp + 13.0 - t * 0.04), snoise(wp + 27.0));
        vec2 w1 = worley(q * 26.0 + warp * 0.9, t * 0.55);
        float cell = smoothstep(0.0, 0.42, w1.y - w1.x);
        float sup = snoise(q * 5.0 + warp * 0.6 + t * 0.02) * 0.5 + snoise(q * 11.0 - t * 0.03) * 0.25;
        float gran = mix(1.0, 0.62 + 0.48 * cell, uGran) * (1.0 + 0.12 * sup * uGran);
        // faculae: bright magnetic network near the limb
        float fac = smoothstep(0.35, 0.8, snoise(q * 7.0 + 3.1)) * (1.0 - mu) * 0.6;
        // limb darkening (quadratic law) and limb reddening
        float om = 1.0 - mu;
        float limb = 1.0 - 0.62 * om - 0.22 * om * om;
        float K = uTemp * (0.78 + 0.22 * pow(mu, 0.5)) * (0.94 + 0.07 * cell);
        vec3 c = blackbody(K);
        c /= max(c.r, max(c.g, c.b));
        c = mix(c, vec3(0.75, 0.88, 1.0), uHot);
        float I = uI * limb * gran * (1.0 + fac) * (1.0 + uHot * 3.0);
        gl_FragColor = vec4(c * I, 1.0);
      }`,
  });
  const star = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 110), starMat);
  star.frustumCulled = false;
  scene.add(star);

  // corona + chromosphere
  const coronaU = { uSize: { value: SUN_R * 7 }, uT: { value: 0 }, uI: { value: 1 }, uRin: { value: 1 / 3.5 } };
  const corona = new THREE.Mesh(plane, new THREE.ShaderMaterial({
    uniforms: coronaU, vertexShader: BILL_VS,
    fragmentShader: /* glsl */ `
      uniform float uT, uI, uRin; varying vec2 vP;
      ${glsl.simplex3}
      void main(){
        float rr = length(vP);
        if (rr > 1.0) discard;
        float r = rr / uRin;              // in stellar radii
        float a = atan(vP.y, vP.x);
        float x = max(r - 1.0, 0.0);
        vec2 ca = vec2(cos(a), sin(a));
        float st = snoise(vec3(ca * 2.2, x * 0.35 - uT * 0.015)) * 0.6 + snoise(vec3(ca * 6.0, x * 0.8 + 3.0 - uT * 0.02)) * 0.4;
        float streamer = 0.55 + 0.45 * st;
        float chromo = exp(-x * 55.0) * 2.4;
        float inner = exp(-x * 7.5) * 1.1 * (0.7 + 0.3 * streamer);
        float outer = exp(-x * 1.6) * 0.22 * streamer * streamer;
        vec3 cc = vec3(1.0, 0.36, 0.22) * chromo + vec3(1.0, 0.78, 0.55) * inner + vec3(0.9, 0.82, 0.75) * outer;
        cc *= smoothstep(1.0, 0.75, rr) * step(1.0, r + 0.02);
        gl_FragColor = vec4(cc * uI, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  }));
  corona.frustumCulled = false; corona.renderOrder = 2;
  scene.add(corona);

  // prominence: plasma flowing along a twisted magnetic loop
  const NP = 26000;
  const pA = new Float32Array(NP * 4);
  for (let i = 0; i < NP; i++) {
    const strand = Math.floor(rng() * 7);
    pA.set([rng(), strand / 7 + rng() * 0.02, rng.gauss(), rng()], i * 4);
  }
  const promGeo = new THREE.BufferGeometry();
  promGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NP * 3), 3));
  promGeo.setAttribute('aP', new THREE.BufferAttribute(pA, 4));
  const promU = { uT: { value: 0 }, uH: { value: 0.3 }, uI: { value: 1 }, uS: { value: ctx.S }, uF1: { value: new THREE.Vector3(1, 0, 0) }, uF2: { value: new THREE.Vector3(0, 1, 0) }, uUp: { value: new THREE.Vector3(0, 0, 1) } };
  const promMat = new THREE.ShaderMaterial({
    uniforms: promU,
    vertexShader: /* glsl */ `
      attribute vec4 aP; uniform float uT, uH, uI; uniform vec3 uF1, uF2, uUp;
      ${POINT_VS}
      ${glsl.simplex3}
      varying vec3 vCol;
      void main(){
        float s = fract(aP.x + uT * 0.018 * (aP.y > 0.5 ? 1.0 : -1.0));
        float ang = 3.14159 * s;
        // footpoints at the limb, loop rises outward along uUp
        vec3 base = normalize(mix(uF1, uF2, s)) * ${SUN_R.toFixed(2)};
        float h = sin(ang);
        vec3 tang = normalize(uF2 - uF1);
        vec3 side = normalize(cross(tang, uUp));
        float tw = aP.y * 6.2831 + s * 9.0 + uT * 0.15;
        float rad = (0.035 + 0.05 * h) * ${SUN_R.toFixed(2)} * (0.5 + 0.5 * abs(aP.z));
        vec3 p = base + uUp * h * uH * ${SUN_R.toFixed(2)} + (side * cos(tw) + uUp * sin(tw) * 0.5) * rad;
        vec3 q = p * 0.9 + vec3(0.0, 0.0, uT * 0.08);
        p += vec3(snoise(q), snoise(q + 7.0), snoise(q + 13.0)) * 0.09 * ${SUN_R.toFixed(2)} * h;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = pointSize(1.6 + 1.2 * aP.w);
        float ends = smoothstep(0.0, 0.08, s) * smoothstep(1.0, 0.92, s);
        vec3 c = mix(vec3(1.0, 0.25, 0.10), vec3(1.0, 0.62, 0.35), aP.w * aP.w);
        vCol = c * (0.9 + 0.8 * aP.w) * uI * ends * vAlphaK;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${POINT_FS}
      varying vec3 vCol;
      void main(){ float m = spriteMask(2.5); gl_FragColor = vec4(vCol * m, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  });
  const prom = new THREE.Points(promGeo, promMat);
  prom.frustumCulled = false;
  scene.add(prom);

  // ---------------------------------------------------------------- starfield (infinitely far, follows camera)
  const NS = 9000;
  const sP = new Float32Array(NS * 3), sC = new Float32Array(NS * 4);
  for (let i = 0; i < NS; i++) {
    const [x, y, z] = rng.unitVec();
    sP.set([x * 9000, y * 9000, z * 9000], i * 3);
    const m = Math.pow(rng(), 6.0);           // most stars faint
    const temp = rng();
    const c = temp < 0.25 ? [1.0, 0.78, 0.6] : temp < 0.7 ? [1.0, 0.95, 0.9] : [0.75, 0.85, 1.0];
    sC.set([c[0], c[1], c[2], m], i * 4);
  }
  const starsGeo = new THREE.BufferGeometry();
  starsGeo.setAttribute('position', new THREE.BufferAttribute(sP, 3));
  starsGeo.setAttribute('aC', new THREE.BufferAttribute(sC, 4));
  const starsU = { uI: { value: 1 }, uS: { value: ctx.S } };
  const stars = new THREE.Points(starsGeo, new THREE.ShaderMaterial({
    uniforms: starsU,
    vertexShader: /* glsl */ `
      attribute vec4 aC; uniform float uI; ${POINT_VS} varying vec3 vCol;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = pointSize(1.2 + 2.2 * aC.w); vCol = aC.rgb * (0.05 + 2.2 * aC.w) * uI * vAlphaK; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `${POINT_FS} varying vec3 vCol; void main(){ gl_FragColor = vec4(vCol * spriteMask(3.0), 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  }));
  stars.frustumCulled = false; stars.renderOrder = -1;
  scene.add(stars);

  return {
    cloud, cloudU, embers, emberU, haze, hazeU, hazeScene, hazeRT, hazeComp, NH, NC,
    core, coreU, flash, flashU, ring, ringU, star, starU, corona, coronaU, prom, promU, stars, starsU,
  };
}
