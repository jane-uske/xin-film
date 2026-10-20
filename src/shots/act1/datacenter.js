// Act I · datacenter in a thermal camera. Objects write a scalar temperature into a half-res heat
// buffer (R = solids, G = rising heat plume); a full-screen pass maps it through `inferno` and uses
// the plume channel to drive heat-shimmer refraction. Units here are millimetres; the die sits at the
// origin (its top at y = 0), centred on one GPU of one rack of one hall.
import { POINT_VS, POINT_FS } from './lib.js';

export const MM = 1 / 18.57; // local units per mm (die 26 mm == network die 1.4 units)

export function buildDatacenter(ctx) {
  const { THREE, util, glsl } = ctx;
  const rng = util.rng(2718);
  const group = new THREE.Group();

  // ---------------------------------------------------------------- layout (mm)
  const RW = 600, RD = 1100, RH = 2000, AISLE = 1200, PITCHZ = RD + AISLE;
  const COLS = 64, ROWS = 14;
  // GPU slot (column 0, row 1) of the server tray holds our die
  const slotU = [0.3, 0.7], slotV = [0.3, 0.42, 0.54, 0.66];
  const rack0 = [-(slotU[0] - 0.5) * RW, -2, -(slotV[1] - 0.5) * RD]; // rack-top centre relative to the die
  const i0 = 14, j0 = 6;
  const hall0 = [rack0[0] - i0 * RW, -RH, rack0[2] - j0 * PITCHZ];
  const HALLX = COLS * RW, HALLZ = ROWS * PITCHZ, GAP = 2 * PITCHZ;
  const halls = [[0, 0], [HALLX + GAP, 0], [0, HALLZ + GAP], [HALLX + GAP, HALLZ + GAP]];
  const BLD = { x0: hall0[0] - 2500, x1: hall0[0] + 2 * HALLX + GAP + 2500, z0: hall0[2] - 2500, z1: hall0[2] + 2 * HALLZ + GAP + 2500 };
  const FLOOR = -RH - 2;

  // shared: heat fog by view distance (warm air hanging in the hall)
  const U = { uT: { value: 0 }, uLoad: { value: 1 }, uFog: { value: 0 }, uFogH: { value: 0.13 } };
  const FOG_VS = /* glsl */ `varying float vDist;`;
  const FOG_FS = /* glsl */ `uniform float uFog, uFogH; varying float vDist;
    float fogged(float h){ return mix(h, uFogH, 1.0 - exp(-vDist * uFog)); }`;

  // ---------------------------------------------------------------- racks (instanced)
  const N = halls.length * COLS * ROWS;
  const rackGeo = new THREE.BoxGeometry(1, 1, 1);
  const seeds = new Float32Array(N * 4);
  const rackMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `
      attribute vec4 aR; varying vec3 vN; varying vec2 vUv; varying vec4 vR; ${FOG_VS}
      void main(){ vN = normal; vUv = uv; vR = aR; vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uLoad; varying vec3 vN; varying vec2 vUv; varying vec4 vR;
      ${FOG_FS}
      ${glsl.hash}
      float box(vec2 p, vec2 c, vec2 h){ vec2 d = abs(p - c) - h; return step(max(d.x, d.y), 0.0); }
      // fade a pattern to its mean as it approaches pixel size (no shimmering at distance)
      float aa(vec2 uv, float f){ float w = max(fwidth(uv.x * f), fwidth(uv.y * f)); return 1.0 - smoothstep(0.25, 0.9, w); }
      void main(){
        vec3 n = vN; vec2 uv = vUv;
        float load = (0.7 + 0.45 * vR.z) * uLoad;
        float h;
        if (n.y > 0.5){
          // open GPU tray seen from above: 8 packages (die, HBM), VRMs, rear PSUs
          vec2 p = vec2(uv.x, 1.0 - uv.y);
          vec2 mm = (p - 0.5) * vec2(600.0, 1100.0);
          float pk = 0.0, die = 0.0, hbm = 0.0, glow = 0.0, vrm = 0.0;
          for (int i = 0; i < 2; i++) for (int j = 0; j < 4; j++){
            vec2 cm = (vec2(i == 0 ? 0.3 : 0.7, 0.3 + 0.12 * float(j)) - 0.5) * vec2(600.0, 1100.0);
            vec2 d = mm - cm;
            pk = max(pk, box(mm, cm, vec2(45.0, 45.0)));
            die = max(die, box(mm, cm, vec2(13.0, 13.0)));
            hbm = max(hbm, box(mm, cm + vec2(-26.0, 0.0), vec2(6.0, 24.0)) + box(mm, cm + vec2(26.0, 0.0), vec2(6.0, 24.0)));
            vrm = max(vrm, box(mm, cm + vec2(0.0, 58.0), vec2(40.0, 6.0)));
            glow += exp(-dot(d, d) / 3000.0);
          }
          float comp = step(0.84, hash21(floor(mm / 9.0) + vR.x * 31.0));
          float psu = box(p, vec2(0.5, 0.93), vec2(0.42, 0.035));
          float fans = box(p, vec2(0.5, 0.07), vec2(0.46, 0.045));
          float fine = pk * 0.18 + hbm * 0.3 * load + die * 0.42 * load + vrm * 0.3 * load + comp * 0.05 + psu * 0.55 - fans * 0.04;
          float k = aa(uv, 60.0);
          h = 0.035 + glow * 0.5 * load + mix(0.08 + 0.04 * load, fine * 1.3, k);
        } else if (abs(n.z) > 0.5){
          // 21 x 2U server units
          float Uf = uv.y * 21.0;
          float ui = floor(Uf), ur = fract(Uf);
          float hu = hash21(vec2(ui, vR.x * 113.0));
          float gpuSled = step(13.0, ui) * step(ui, 18.0);            // hot GPU sleds in the upper middle
          float slot = smoothstep(0.0, 0.05, ur) * smoothstep(1.0, 0.95, ur);
          float kU = aa(uv, 21.0), kV = aa(uv, 140.0);
          bool back = n.z < 0.0;
          if (!back){
            // cold-aisle intake: dark bezels, perforated grille, status LEDs
            float grille = step(0.14, uv.x) * step(uv.x, 0.86) * step(0.18, ur) * step(ur, 0.82);
            vec2 g = fract(vec2(uv.x * 70.0, Uf * 7.0)) - 0.5;
            float hole = 1.0 - smoothstep(0.18, 0.3, length(g));
            float led = (box(vec2(uv.x, ur), vec2(0.06, 0.5), vec2(0.012, 0.09)) + box(vec2(uv.x, ur), vec2(0.09, 0.5), vec2(0.012, 0.09)));
            float blink = step(0.4, hash21(vec2(ui + vR.x * 97.0, floor(uT * (1.5 + 3.0 * hu)))));
            float base = 0.08 + 0.05 * hu + 0.05 * gpuSled * load;
            float v = base + grille * mix(0.02, hole * 0.08, kV);
            v = mix(base * 0.5, v, mix(1.0, slot, kU));
            h = mix(base + 0.01, v, kU) + led * blink * 0.6 * kU;
          } else {
            // hot-aisle exhaust: two fans per unit + a PSU column; each unit breathes on its own
            float breathe = 0.07 * sin(uT * (0.35 + 0.5 * hu) + hu * 31.0) + 0.04 * sin(uT * 1.3 + hu * 11.0);
            float ex = 0.56 + 0.2 * hu + 0.2 * gpuSled * load + breathe;
            vec2 f1 = vec2((uv.x - 0.28) * 3.0, ur - 0.5), f2 = vec2((uv.x - 0.6) * 3.0, ur - 0.5);
            float fr = min(length(f1), length(f2));
            float fan = (1.0 - smoothstep(0.32, 0.4, fr)) * (0.7 + 0.3 * smoothstep(0.0, 0.25, fr));
            float psu = step(0.82, uv.x) * step(uv.x, 0.95) * step(0.2, ur) * step(ur, 0.8);
            float v = ex * (0.62 + 0.38 * fan) + psu * (0.25 + 0.15 * hu);
            v = mix(ex * 0.45, v, mix(1.0, slot, kU));
            h = mix(ex * 0.82, v, kU);
            h += 0.05 * (1.0 - uv.y);
          }
        } else {
          h = 0.035 + 0.03 * uv.y;
        }
        gl_FragColor = vec4(fogged(h), 0.0, 0.0, 1.0);
      }`,
  });
  const racks = new THREE.InstancedMesh(rackGeo, rackMat, N);
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(RW * 0.97, RH, RD), pos = new THREE.Vector3();
    let k = 0;
    for (const [hx, hz] of halls) {
      for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        const facing = j % 2 === 0 ? 1 : -1;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing > 0 ? 0 : Math.PI);
        pos.set(hall0[0] + hx + i * RW, FLOOR + RH / 2, hall0[2] + hz + j * PITCHZ);
        m.compose(pos, q, s);
        racks.setMatrixAt(k, m);
        seeds.set([rng(), facing, rng(), 0], k * 4);
        k++;
      }
    }
    racks.instanceMatrix.needsUpdate = true;
    rackGeo.setAttribute('aR', new THREE.InstancedBufferAttribute(seeds, 4));
  }
  racks.frustumCulled = false;
  group.add(racks);

  // ---------------------------------------------------------------- flat heat surfaces
  const flatMat = (frag) => new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `varying vec3 vP; varying vec3 vN; ${FOG_VS} void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vP = position; vN = normal; vec4 mv = viewMatrix * w; vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform float uT; varying vec3 vP; varying vec3 vN; ${FOG_FS} ${glsl.hash} ${glsl.simplex3} ${frag}`,
    side: THREE.DoubleSide,
  });
  // hall floor: warm hot aisles, cold perforated tiles in the cold aisles
  const floorGeo = new THREE.PlaneGeometry(BLD.x1 - BLD.x0, BLD.z1 - BLD.z0);
  floorGeo.rotateX(-Math.PI / 2);
  const fz0 = ((BLD.z0 + BLD.z1) / 2 - hall0[2]), fx0 = ((BLD.x0 + BLD.x1) / 2 - hall0[0]);
  const floor = new THREE.Mesh(floorGeo, flatMat(/* glsl */ `
    void main(){
      float z = (vP.z + ${fz0.toFixed(1)}) / ${PITCHZ.toFixed(1)};
      float zf = fract(z);
      // rows sit at integer z (+-RD/2); aisles in between alternate cold (after even rows) and hot
      float inAisle = smoothstep(0.235, 0.26, zf) * smoothstep(0.765, 0.74, zf);
      float hot = step(0.5, fract(floor(z) * 0.5));
      vec2 tile = fract(vec2(vP.x + ${fx0.toFixed(1)}, vP.z + ${fz0.toFixed(1)}) / 600.0);
      float seam = 1.0 - (smoothstep(0.0, 0.02, tile.x) * smoothstep(1.0, 0.98, tile.x) * smoothstep(0.0, 0.02, tile.y) * smoothstep(1.0, 0.98, tile.y));
      vec2 pf = fract(vec2(vP.x, vP.z) / 60.0) - 0.5;
      float perf = 1.0 - smoothstep(0.15, 0.25, length(pf));
      float w = fwidth(vP.x / 600.0);
      float k = 1.0 - smoothstep(0.25, 0.9, w), kp = 1.0 - smoothstep(0.25, 0.9, w * 10.0);
      float cold = 0.025 - 0.012 * perf * kp + 0.015 * seam * k;
      float warm = 0.4 + 0.04 * seam * k;
      float h = mix(0.05, mix(cold, warm, hot), inAisle);
      gl_FragColor = vec4(fogged(h), 0.0, 0.0, 1.0);
    }`));
  floor.position.set((BLD.x0 + BLD.x1) / 2, FLOOR, (BLD.z0 + BLD.z1) / 2);
  group.add(floor);

  // cable trays over every cold aisle (ladder trays, faintly warm cables)
  const trayMat = flatMat(/* glsl */ `
    void main(){
      float rung = step(0.85, fract(vP.x / 300.0));
      float w = fwidth(vP.x / 300.0);
      float h = mix(0.16 + 0.07 * rung, 0.17, smoothstep(0.25, 0.9, w));
      gl_FragColor = vec4(fogged(h), 0.0, 0.0, 1.0);
    }`);
  for (const [hx, hz] of halls) {
    for (let j = 0; j < ROWS - 1; j += 2) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(HALLX, 110, 420), trayMat);
      t.position.set(hall0[0] + hx + HALLX / 2 - RW / 2, FLOOR + RH + 650, hall0[2] + hz + j * PITCHZ + PITCHZ / 2);
      group.add(t);
    }
  }

  // hot-aisle air: an additive heat volume over every hot aisle (exhaust air pooling and rising)
  const airMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `varying vec3 vP; ${FOG_VS} void main(){ vP = position; vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform float uT; varying vec3 vP; ${FOG_FS} ${glsl.simplex3}
      void main(){
        float y = vP.y / ${(RH + 1400).toFixed(1)} + 0.5;           // 0 at floor, 1 at the top of the volume
        float n = snoise(vec3(vP.x * 0.0006, vP.y * 0.001 - uT * 0.5, vP.z * 0.002));
        float h = 0.14 * (1.0 - smoothstep(0.55, 1.0, y)) * (0.75 + 0.35 * n);
        gl_FragColor = vec4(h * exp(-vDist * uFog * 0.5), 0.0, 0.0, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  });
  for (const [hx, hz] of halls) {
    for (let j = 1; j < ROWS - 1; j += 2) {
      const a = new THREE.Mesh(new THREE.BoxGeometry(HALLX, RH + 1400, AISLE * 0.96), airMat);
      a.position.set(hall0[0] + hx + HALLX / 2 - RW / 2, FLOOR + (RH + 1400) / 2, hall0[2] + hz + j * PITCHZ + PITCHZ / 2);
      a.renderOrder = 5;
      group.add(a);
    }
  }

  // perimeter walls only (no partitions, so the hall runs on); roofless — the thermal camera sees through
  const wallMat = flatMat(/* glsl */ `void main(){ float h = 0.09 + 0.03 * snoise(vP * 0.0004) + 0.07 * smoothstep(-3500.0, 3500.0, vP.y); gl_FragColor = vec4(fogged(h), 0.0, 0.0, 1.0); }`);
  const WH = 7000;
  const addWall = (x0, z0, x1, z1, th = 600) => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(Math.max(Math.abs(x1 - x0), th), WH, Math.max(Math.abs(z1 - z0), th)), wallMat);
    w.position.set((x0 + x1) / 2, FLOOR + WH / 2, (z0 + z1) / 2);
    group.add(w);
  };
  addWall(BLD.x0, BLD.z0, BLD.x1, BLD.z0); addWall(BLD.x0, BLD.z1, BLD.x1, BLD.z1);
  addWall(BLD.x0, BLD.z0, BLD.x0, BLD.z1); addWall(BLD.x1, BLD.z0, BLD.x1, BLD.z1);

  // chiller yard along the long side: fan decks blow the hottest air of the site
  const yard = { x0: BLD.x1 + 6000, x1: BLD.x1 + 22000, z0: BLD.z0 + 4000, z1: BLD.z1 - 4000 };
  const chMat = flatMat(/* glsl */ `
    void main(){
      float h = 0.3;
      if (vN.y > 0.5){
        vec2 c = fract(vP.xz / 2200.0) - 0.5;
        float r = length(c);
        float fan = 1.0 - smoothstep(0.26, 0.36, r);
        h = 0.45 + 0.52 * fan * (0.85 + 0.15 * sin(uT * 2.0 + floor(vP.x / 2200.0) * 3.0));
        h = mix(h, 0.72, smoothstep(0.3, 0.9, fwidth(vP.x / 2200.0)));
      } else {
        h = 0.26 + 0.1 * smoothstep(-1500.0, 1500.0, vP.y);
      }
      gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
    }`);
  const CH = 18;
  for (let k = 0; k < CH; k++) {
    const row = k % 2, idx = Math.floor(k / 2);
    const z = yard.z0 + (idx + 0.5) * ((yard.z1 - yard.z0) / (CH / 2));
    const m = new THREE.Mesh(new THREE.BoxGeometry(6600, 3000, 4400), chMat);
    m.position.set(yard.x0 + 4000 + row * 8500, FLOOR + 1500, z);
    group.add(m);
  }
  // substation / generators: a few warm blocks
  for (let k = 0; k < 6; k++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(3000, 2600, 9000), wallMat);
    m.position.set(BLD.x0 - 9000, FLOOR + 1300, BLD.z0 + 6000 + k * 11000);
    group.add(m);
  }

  // landscape: cold ground, a warm road, faint scattered houses
  const groundGeo = new THREE.PlaneGeometry(4.0e7, 4.0e7, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeo, flatMat(/* glsl */ `
    void main(){
      vec2 p = vP.xz;
      float n = snoise(vec3(p * 0.00002, 0.0)) * 0.5 + snoise(vec3(p * 0.00009, 3.0)) * 0.25;
      float h = 0.03 + 0.015 * n;
      // field parcels (slightly different night temperatures)
      vec2 pc = floor((p + vec2(snoise(vec3(p * 0.00001, 1.0)) * 20000.0)) / vec2(90000.0, 60000.0));
      float parcel = hash21(pc) - 0.5;
      float pw = fwidth(p.x / 90000.0);
      h += 0.018 * parcel * (1.0 - smoothstep(0.2, 0.8, pw));
      // a river: water keeps the day's heat, so it reads warm at night
      float rv = p.x - (0.0 + 160000.0 * sin(p.y * 0.0000045) + 60000.0 * sin(p.y * 0.000013 + 1.0) - 260000.0);
      float rw = fwidth(rv);
      h += 0.09 * (1.0 - smoothstep(4000.0, 4000.0 + rw * 1.5 + 2000.0, abs(rv)));
      // road: a gently curving warm line leading to the campus
      float rz = p.y - (2000.0 * sin(p.x * 0.00002) + ${((BLD.z0 + BLD.z1) / 2 + 12000).toFixed(1)});
      float road = 1.0 - smoothstep(0.0, 9000.0, abs(rz));
      float wr = fwidth(rz);
      h += 0.07 * road * smoothstep(0.0, 1.0, 1.0 - min(wr / 9000.0, 1.0));
      // distance fade toward the horizon: atmosphere at night is cold
      gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
    }`));
  ground.position.set((BLD.x0 + BLD.x1) / 2, FLOOR - 5, (BLD.z0 + BLD.z1) / 2);
  group.add(ground);

  // scattered warm dots (houses, a town on the horizon): instanced small boxes would alias, use points
  const NHd = 2600;
  const hp = new Float32Array(NHd * 3), hv = new Float32Array(NHd);
  for (let k = 0; k < NHd; k++) {
    const town = k < 1800;
    const a = rng() * Math.PI * 2, r = town ? 300000 + rng.gauss() * 40000 : 40000 + rng() * 900000;
    const ang = town ? -0.6 + rng.gauss() * 0.18 : a;
    hp.set([BLD.x1 + Math.cos(ang) * r, FLOOR + 400, (BLD.z0 + BLD.z1) / 2 + Math.sin(ang) * r], k * 3);
    hv[k] = 0.25 + 0.35 * rng();
  }
  const housesGeo = new THREE.BufferGeometry();
  housesGeo.setAttribute('position', new THREE.BufferAttribute(hp, 3));
  housesGeo.setAttribute('aH', new THREE.BufferAttribute(hv, 1));
  const houses = new THREE.Points(housesGeo, new THREE.ShaderMaterial({
    uniforms: { uS: { value: ctx.S / 2 } },
    vertexShader: /* glsl */ `attribute float aH; ${POINT_VS} varying float vH; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = pointSize(2.0); vH = aH * vAlphaK; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `${POINT_FS} varying float vH; void main(){ gl_FragColor = vec4(vH * spriteMask(2.0), 0.0, 0.0, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  houses.frustumCulled = false;
  group.add(houses);

  // ---------------------------------------------------------------- heat plume (G channel), rising over the chiller yard
  const NPL = 52;
  const plU = { uT: { value: 0 }, uI: { value: 1 } };
  const plGeo = new THREE.InstancedBufferGeometry();
  plGeo.index = new THREE.PlaneGeometry(1, 1).index;
  plGeo.setAttribute('position', new THREE.PlaneGeometry(1, 1).getAttribute('position'));
  const pa = new Float32Array(NPL * 4);
  for (let k = 0; k < NPL; k++) pa.set([k / NPL, rng(), rng(), rng()], k * 4);
  plGeo.setAttribute('aP', new THREE.InstancedBufferAttribute(pa, 4));
  plGeo.instanceCount = NPL;
  const PLX = (yard.x0 + yard.x1) / 2, PLZ = (yard.z0 + yard.z1) / 2;
  const plume = new THREE.Mesh(plGeo, new THREE.ShaderMaterial({
    uniforms: plU,
    vertexShader: /* glsl */ `
      attribute vec4 aP; uniform float uT; varying vec2 vQ; varying vec4 vP; varying float vA;
      void main(){
        float life = fract(aP.x + uT * 0.035);
        float y = life * 260000.0;
        float size = 12000.0 + life * 80000.0 + aP.y * 10000.0;
        vec3 c = vec3(${PLX.toFixed(1)} + (aP.z - 0.5) * 9000.0 + sin(life * 5.0 + aP.w * 6.0) * 6000.0 + life * life * 50000.0,
                      ${(FLOOR + 3000).toFixed(1)} + y,
                      ${PLZ.toFixed(1)} + (aP.w - 0.5) * 9000.0);
        vec4 mv = modelViewMatrix * vec4(c, 1.0);
        mv.xy += position.xy * size * ${MM.toFixed(6)};
        vQ = position.xy * 2.0; vP = aP;
        vA = smoothstep(0.0, 0.04, life) * (1.0 - smoothstep(0.5, 1.0, life)) * 0.3 * pow(1.0 - life, 2.2);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uI; varying vec2 vQ; varying vec4 vP; varying float vA;
      ${glsl.simplex3}
      void main(){
        float r = length(vQ);
        if (r > 1.0) discard;
        float n = snoise(vec3(vQ * 2.1 + vP.yz * 10.0, uT * 0.18 + vP.w * 4.0));
        float core = exp(-r * r * 4.0) * smoothstep(1.0, 0.6, r);
        float d = core * clamp(0.5 + 0.7 * n, 0.0, 1.0);
        gl_FragColor = vec4(0.0, d * vA * uI, 0.0, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  }));
  plume.frustumCulled = false;
  plume.renderOrder = 10;
  group.add(plume);

  // ---------------------------------------------------------------- thermal mapping pass
  const W2 = Math.round(ctx.W / 2), H2 = Math.round(ctx.H / 2);
  const heatRT = ctx.makeTarget(W2, H2, { depth: true });
  const passU = { tH: { value: heatRT.texture }, uT: { value: 0 }, uScan: { value: 1 }, uExp: { value: 1 }, uShim: { value: 1 }, uRes: { value: new THREE.Vector2(W2, H2) } };
  const pass = ctx.passMaterial(/* glsl */ `
    precision highp float; in vec2 vUv; out vec4 o;
    uniform sampler2D tH; uniform float uT, uScan, uExp, uShim; uniform vec2 uRes;
    ${glsl.simplex3}
    ${glsl.inferno}
    void main(){
      vec2 uv = vUv;
      float g0 = texture(tH, uv).g;
      vec2 off = vec2(0.0);
      if (g0 > 0.002){
        vec2 q = uv * vec2(22.0, 9.0);
        off = vec2(snoise(vec3(q, uT * 1.3)), snoise(vec3(q + 7.3, uT * 1.3 - 4.0))) * min(g0, 0.6) * 0.012 * uShim;
      }
      vec2 px = 1.0 / uRes;
      vec4 h = texture(tH, uv + off) * 0.5 + (texture(tH, uv + off + vec2(px.x, 0.0)) + texture(tH, uv + off - vec2(px.x, 0.0)) + texture(tH, uv + off + vec2(0.0, px.y)) + texture(tH, uv + off - vec2(0.0, px.y))) * 0.125;
      float heat = h.r + h.g * 0.85;
      heat = clamp(heat * uExp, 0.0, 1.05);
      vec3 col = inferno(heat) * (0.8 + 2.2 * pow(heat, 6.0));
      // scan-in from the top edge (the machine switches to thermal)
      float edge = 1.0 - uScan * 1.1 + 0.05;
      float m = smoothstep(edge - 0.004, edge + 0.004, uv.y);
      float line = exp(-pow((uv.y - edge) / 0.006, 2.0)) * (1.0 - smoothstep(0.95, 1.0, uScan));
      o = vec4(col * m + vec3(0.6, 0.9, 1.0) * line * 1.5, max(m, line));
    }`, passU, { blending: THREE.NormalBlending, transparent: true });

  return {
    group, racks, U, plU, plume, heatRT, pass, passU,
    layout: { rack0, hall0, BLD, yard, PLX, PLZ, FLOOR, HALLX, HALLZ, GAP, RW, RD, RH, PITCHZ },
  };
}
