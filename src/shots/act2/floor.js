// 地面：虚空里的一块黑色、微亮的地面。只接收有动机的光：烛火、数据之火、火海里的每一团复制体。
// 阴影是解析的：光源被蜡烛杯沿 / 底座顶面挡住的那一圈地面落在阴影里（软边，蜡体半透）。
export const fogGLSL = /* glsl */ `
uniform float uFogK; uniform vec3 uFogCol;
vec3 applyFog(vec3 col, vec3 P){
  float d = length(P - cameraPosition);
  float f = exp(-max(d - 60.0, 0.0) * uFogK);
  return col * f + uFogCol * (1.0 - f);
}`;

export function makeFloor(ctx, shared) {
  const { THREE } = ctx;
  const u = {
    uFlamePos: shared.uFlamePos, uFlameI: shared.uFlameI, uFlameCol: shared.uFlameCol,
    uDigPos: shared.uDigPos, uDigI: shared.uDigI, uDigCol: shared.uDigCol,
    uMatchPos: shared.uMatchPos, uMatchI: shared.uMatchI,
    uCandleR: { value: 2.6 }, uCandleH: { value: 11 },
    uPlinth: shared.uPlinth,          // x: 半宽, y: 顶高
    uLat: shared.uLat,                // x: 原点 x, y: 间距, z: nx, w: nz
    uLatI: shared.uLatI, uLatCol: shared.uLatCol, uLatFlameY: shared.uLatFlameY,
    uFogK: shared.uFogK, uFogCol: shared.uFogCol,
    uDim: { value: 1 }, uLatFill: shared.uLatFill,
  };
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: u,
    vertexShader: /* glsl */ `out vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
precision highp float;
uniform vec3 uFlamePos; uniform float uFlameI; uniform vec3 uFlameCol;
uniform vec3 uDigPos; uniform float uDigI; uniform vec3 uDigCol;
uniform vec3 uMatchPos; uniform float uMatchI;
uniform float uCandleR, uCandleH, uDim, uLatFill;
uniform vec2 uPlinth; uniform vec4 uLat; uniform float uLatI, uLatFlameY; uniform vec3 uLatCol;
${fogGLSL}
in vec3 vW; out vec4 o;
const float ALB = 0.055;
// 点光照到地面：漫反射 + 宽高光（光滑的黑地面上一条柔和的反光）
vec3 lightAt(vec3 P, vec3 V, vec3 Lp, vec3 col, float I){
  vec3 L = Lp - P; float d2 = dot(L, L); L *= inversesqrt(d2);
  float ndl = max(L.y, 0.0);
  vec3 H = normalize(L + V);
  float sp = pow(max(H.y, 0.0), 90.0) * 0.9 + pow(max(H.y, 0.0), 12.0) * 0.08;
  return col * I * (ndl * ALB + sp * 0.35) / d2;
}
// 圆柱顶（蜡烛）遮挡：光线在杯沿高度处离轴的距离
float occCyl(vec3 P, vec3 Lp, vec2 axis, float R, float Htop){
  float k = (Htop - P.y) / max(Lp.y - P.y, 1e-3);
  if (k >= 1.0) return 1.0;
  vec2 q = mix(P.xz, Lp.xz, k) - axis;
  return smoothstep(R * 0.92, R * 1.12, length(q));
}
float occBox(vec3 P, vec3 Lp, vec2 c, float hw, float Htop){
  float k = (Htop - P.y) / max(Lp.y - P.y, 1e-3);
  if (k >= 1.0) return 1.0;
  vec2 q = abs(mix(P.xz, Lp.xz, k) - c);
  float m = max(q.x, q.y);
  return smoothstep(hw * 0.9, hw * 1.25, m);
}
void main(){
  vec3 P = vW; vec3 V = normalize(cameraPosition - P);
  vec3 col = vec3(0.0);
  if (uFlameI > 0.0) {
    // 用焰体上下两点近似一团有体积的光源，阴影边缘更软
    vec3 L1 = uFlamePos + vec3(0.0, -0.6, 0.0), L2 = uFlamePos + vec3(0.0, 1.0, 0.0);
    float s1 = occCyl(P, L1, vec2(0.0), uCandleR, uCandleH), s2 = occCyl(P, L2, vec2(0.0), uCandleR, uCandleH);
    float sh = 0.22 + 0.78 * (0.5 * s1 + 0.5 * s2);
    col += lightAt(P, V, uFlamePos, uFlameCol, uFlameI) * sh;
  }
  if (uDigI > 0.0) {
    vec3 L1 = uDigPos + vec3(0.0, -0.5, 0.0), L2 = uDigPos + vec3(0.0, 1.2, 0.0);
    float s1 = occBox(P, L1, uDigPos.xz, uPlinth.x, uPlinth.y), s2 = occBox(P, L2, uDigPos.xz, uPlinth.x, uPlinth.y);
    col += lightAt(P, V, uDigPos, uDigCol, uDigI) * (0.5 * s1 + 0.5 * s2);
  }
  if (uMatchI > 0.0) col += lightAt(P, V, uMatchPos, vec3(1.0, 0.55, 0.22), uMatchI);
  // 火海：周围 3×3 个格子逐个算，远处换成平均照度（避免摩尔纹）
  if (uLatI > 0.0 && uLat.z > 0.5) {
    float pitch = uLat.y;
    vec2 g = vec2((P.x - uLat.x) / pitch, -P.z / pitch);
    vec2 g0 = floor(g + 0.5);
    float fw = length(fwidth(g));
    float lod = smoothstep(0.08, 0.3, fw);
    vec3 acc = vec3(0.0);
    if (lod < 1.0) {
      for (int dj = -1; dj <= 1; dj++) for (int di = -1; di <= 1; di++) {
        vec2 c = g0 + vec2(float(di), float(dj));
        if (c.x < 0.0 || c.y < 0.0 || c.x >= uLat.z || c.y >= uLat.w) continue;
        if (c.x < 0.5 && c.y < 0.5) continue; // 原初那一团单独算
        vec3 Lp = vec3(uLat.x + c.x * pitch, uLatFlameY, -c.y * pitch);
        vec3 Lq = Lp + vec3(0.0, 1.2, 0.0);
        float sh = 0.5 * occBox(P, Lp, Lp.xz, uPlinth.x, uPlinth.y) + 0.5 * occBox(P, Lq, Lp.xz, uPlinth.x, uPlinth.y);
        acc += lightAt(P, V, Lp, uLatCol, uLatI) * sh;
      }
    }
    // 平均照度：在格子覆盖范围内为常数
    float inside = step(-0.5, g.x) * step(-0.5, g.y) * step(g.x, uLat.z - 0.5) * step(g.y, uLat.w - 0.5);
    vec3 avg = uLatCol * uLatI * ALB * 0.010 * inside * (1.0 + 2.0 * pow(max(dot(normalize(vec3(0.0, 1.0, 0.0) + V), vec3(0.0, 1.0, 0.0)), 0.0), 30.0));
    col += mix(acc, avg, lod);
  }
  col += vec3(0.2, 0.62, 1.0) * uLatFill * ALB * 0.35 * smoothstep(-40.0, 10.0, P.x);
  col *= uDim;
  col = applyFog(col, P);
  o = vec4(col, 1.0);
}`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(5000, 0, -5000);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;   // 不透明物体之后画：被蜡烛/底座挡住的像素由深度测试提前丢弃
  return { mesh, u };
}
