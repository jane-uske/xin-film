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
  const COLS = 40, ROWS = 14;
  // GPU slot (column 0, row 1) of the server tray holds our die
  const slotU = [0.3, 0.7], slotV = [0.3, 0.42, 0.54, 0.66];
  const rack0 = [-(slotU[0] - 0.5) * RW, -2, -(slotV[1] - 0.5) * RD]; // rack-top centre relative to the die
  const i0 = 20, j0 = 6;
  const hall0 = [rack0[0] - i0 * RW, -RH, rack0[2] - j0 * PITCHZ];
  const HALLX = COLS * RW, HALLZ = ROWS * PITCHZ, GAP = 5000;
  const halls = [[0, 0], [HALLX + GAP, 0], [0, HALLZ + GAP], [HALLX + GAP, HALLZ + GAP]];
  const BLD = { x0: hall0[0] - 2500, x1: hall0[0] + 2 * HALLX + GAP + 2500, z0: hall0[2] - 2500, z1: hall0[2] + 2 * HALLZ + GAP + 2500 };
  const FLOOR = -RH - 2;

  // ---------------------------------------------------------------- racks (instanced)
  const N = halls.length * COLS * ROWS;
  const rackGeo = new THREE.BoxGeometry(1, 1, 1);
  const seeds = new Float32Array(N * 4);
  const U = { uT: { value: 0 }, uLoad: { value: 1 } };
  const rackMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `
      attribute vec4 aR; varying vec3 vN; varying vec2 vUv; varying vec4 vR;
      void main(){ vN = normal; vUv = uv; vR = aR; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uLoad; varying vec3 vN; varying vec2 vUv; varying vec4 vR;
      ${glsl.hash}
      float box(vec2 p, vec2 c, vec2 h){ vec2 d = abs(p - c) - h; return step(max(d.x, d.y), 0.0); }
      // antialias a pattern by blending to its mean once it gets close to pixel size
      float lod(float v, float mean, vec2 uv, float f){ float w = max(fwidth(uv.x * f), fwidth(uv.y * f)); return mix(v, mean, smoothstep(0.25, 0.9, w)); }
      void main(){
        vec3 n = vN; vec2 uv = vUv;
        float h;
        if (n.y > 0.5){
          // open server tray from above: board, 8 GPU packages (die + 6 HBM), front fans, rear PSUs
          vec2 p = vec2(uv.x, 1.0 - uv.y);
          vec2 mm = (p - 0.5) * vec2(600.0, 1100.0);
          float load = (0.75 + 0.35 * vR.z) * uLoad;
          // board with small components (hashed cells) and copper pours
          vec2 cell = floor(mm / 9.0);
          float comp = step(0.82, hash21(cell + vR.x * 31.0)) * 0.06;
          float pk = 0.0, die = 0.0, hbm = 0.0, glow = 0.0, vrm = 0.0;
          for (int i = 0; i < 2; i++) for (int j = 0; j < 4; j++){
            vec2 c = vec2(i == 0 ? 0.3 : 0.7, 0.3 + 0.12 * float(j));
            vec2 cm = (c - 0.5) * vec2(600.0, 1100.0);
            vec2 d = mm - cm;
            pk = max(pk, box(mm, cm, vec2(45.0, 45.0)));
            die = max(die, box(mm, cm, vec2(13.0, 13.0)));
            hbm = max(hbm, box(mm, cm + vec2(-26.0, 0.0), vec2(6.0, 24.0)) + box(mm, cm + vec2(26.0, 0.0), vec2(6.0, 24.0)));
            vrm = max(vrm, box(mm, cm + vec2(0.0, 58.0), vec2(40.0, 6.0)));
            glow += exp(-dot(d, d) / 2600.0);
          }
          float fans = box(p, vec2(0.5, 0.07), vec2(0.46, 0.045)) * (0.6 + 0.4 * sin(p.x * 75.0));
          float psu = box(p, vec2(0.5, 0.93), vec2(0.42, 0.035));
          float fine = comp + pk * 0.12 + hbm * 0.16 * load + die * 0.22 * load + vrm * 0.2 * load - fans * 0.06 + psu * 0.14;
          h = 0.12 + glow * 0.3 * load + lod(fine, 0.05 + 0.02 * load, uv, 60.0);
        } else if (abs(n.z) > 0.5){
          bool back = n.z < 0.0;
          if (!back){
            // cold-aisle front: 42 U of servers, status LEDs
            float U = uv.y * 42.0;
            float row = fract(U);
            float led = step(0.05, uv.x) * step(uv.x, 0.11) * step(0.35, row) * step(row, 0.6);
            float blink = step(0.35, hash21(vec2(floor(U) + vR.x * 97.0, floor(uT * (2.0 + 3.0 * vR.z)))));
            float seam = 1.0 - smoothstep(0.0, 0.08, row) * smoothstep(1.0, 0.92, row);
            h = 0.09 + 0.05 * uv.y + seam * 0.03 + led * blink * 0.55;
            h = lod(h, 0.11 + 0.05 * uv.y, uv, 42.0);
          } else {
            // hot-aisle exhaust
            float U = uv.y * 42.0;
            h = 0.46 + 0.05 * sin(uv.x * 30.0) + 0.05 * step(0.5, fract(U * 0.25)) + 0.1 * uv.y;
            h = lod(h, 0.52, uv, 20.0);
          }
        } else {
          h = 0.12;
        }
        gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
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

  // ---------------------------------------------------------------- flat heat surfaces (floor, walls, yard, ground)
  const flatMat = (frag) => new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `varying vec3 vP; varying vec3 vN; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vP = position; vN = normal; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `uniform float uT; varying vec3 vP; varying vec3 vN; ${glsl.hash} ${glsl.simplex3} ${frag}`,
    side: THREE.DoubleSide,
  });
  // hall floors: hot aisles warm, cold aisles cool
  const floorGeo = new THREE.PlaneGeometry(BLD.x1 - BLD.x0, BLD.z1 - BLD.z0);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, flatMat(/* glsl */ `
    uniform vec3 uH0; uniform float uPZ;
    void main(){
      float z = (vP.z + ${(((BLD.z0 + BLD.z1) / 2) - hall0[2]).toFixed(1)}) / ${PITCHZ.toFixed(1)};
      float hot = step(0.5, fract(z * 0.5 + 0.25));
      float h = 0.06 + 0.2 * hot;
      float w = fwidth(z);
      h = mix(h, 0.12, smoothstep(0.3, 0.9, w));
      gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
    }`));
  floor.position.set((BLD.x0 + BLD.x1) / 2, FLOOR, (BLD.z0 + BLD.z1) / 2);
  group.add(floor);

  // perimeter + interior walls (roofless: a thermal camera sees the heat through)
  const wallMat = flatMat(/* glsl */ `void main(){ float h = 0.1 + 0.03 * snoise(vP * 0.0004) + 0.06 * smoothstep(-3500.0, 3500.0, vP.y); gl_FragColor = vec4(h, 0.0, 0.0, 1.0); }`);
  const WH = 7000;
  const addWall = (x0, z0, x1, z1, th = 600) => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(Math.max(Math.abs(x1 - x0), th), WH, Math.max(Math.abs(z1 - z0), th)), wallMat);
    w.position.set((x0 + x1) / 2, FLOOR + WH / 2, (z0 + z1) / 2);
    group.add(w);
  };
  addWall(BLD.x0, BLD.z0, BLD.x1, BLD.z0); addWall(BLD.x0, BLD.z1, BLD.x1, BLD.z1);
  addWall(BLD.x0, BLD.z0, BLD.x0, BLD.z1); addWall(BLD.x1, BLD.z0, BLD.x1, BLD.z1);
  const midX = hall0[0] + HALLX + GAP / 2, midZ = hall0[2] + HALLZ + GAP / 2;
  addWall(midX, BLD.z0, midX, BLD.z1, 400); addWall(BLD.x0, midZ, BLD.x1, midZ, 400);

  // chiller yard along the long side: hot fan decks — the heat leaves here
  const yard = { x0: BLD.x1 + 6000, x1: BLD.x1 + 22000, z0: BLD.z0 + 4000, z1: BLD.z1 - 4000 };
  const chMat = flatMat(/* glsl */ `
    void main(){
      float h = 0.2;
      if (vN.y > 0.5){
        vec2 c = fract(vP.xz / 2200.0) - 0.5;
        float fan = 1.0 - smoothstep(0.28, 0.36, length(c));
        h = 0.42 + 0.45 * fan;
        h = mix(h, 0.55, smoothstep(0.3, 0.9, fwidth(vP.x / 2200.0)));
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
        float size = 14000.0 + life * 70000.0 + aP.y * 10000.0;
        vec3 c = vec3(${PLX.toFixed(1)} + (aP.z - 0.5) * 9000.0 + sin(life * 5.0 + aP.w * 6.0) * 6000.0 + life * life * 50000.0,
                      ${(FLOOR + 3000).toFixed(1)} + y,
                      ${PLZ.toFixed(1)} + (aP.w - 0.5) * 9000.0);
        vec4 mv = modelViewMatrix * vec4(c, 1.0);
        mv.xy += position.xy * size * ${MM.toFixed(6)};
        vQ = position.xy * 2.0; vP = aP;
        vA = smoothstep(0.0, 0.06, life) * (1.0 - smoothstep(0.45, 1.0, life)) * (1.0 - life * 0.7);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uI; varying vec2 vQ; varying vec4 vP; varying float vA;
      ${glsl.simplex3}
      void main(){
        float r = length(vQ);
        if (r > 1.0) discard;
        float n = snoise(vec3(vQ * 2.1 + vP.yz * 10.0, uT * 0.18 + vP.w * 4.0));
        float d = smoothstep(1.0, 0.15, r) * clamp(0.55 + 0.6 * n, 0.0, 1.0);
        gl_FragColor = vec4(0.0, d * vA * 0.095 * uI, 0.0, 1.0);
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
    layout: { rack0, hall0, BLD, yard, PLX, PLZ, FLOOR, HALLX, HALLZ, GAP, RW, RD, RH },
  };
}
