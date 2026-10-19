// 共享 GLSL 片段。镜头模块用模板字符串拼进自己的 shader。

export const hash = /* glsl */ `
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
`;

// Ashima simplex noise 3D
export const simplex3 = /* glsl */ `
vec3 _m289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _m289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _perm(vec4 x){ return _m289(((x * 34.0) + 10.0) * x); }
vec4 _tis(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = _m289(i);
  vec4 p = _perm(_perm(_perm(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = _tis(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float fbm3(vec3 p, int oct){
  float a = 0.0, w = 0.5;
  for (int i = 0; i < 8; i++){ if (i >= oct) break; a += w * snoise(p); p = p * 2.03 + vec3(17.1, 9.2, 3.7); w *= 0.5; }
  return a;
}
// 旋度噪声：无散度的流场，适合烟、尘、余烬
vec3 curl3(vec3 p){
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 px0 = vec3(snoise(p - dx), snoise(p - dx + 31.4), snoise(p - dx + 71.7));
  vec3 px1 = vec3(snoise(p + dx), snoise(p + dx + 31.4), snoise(p + dx + 71.7));
  vec3 py0 = vec3(snoise(p - dy), snoise(p - dy + 31.4), snoise(p - dy + 71.7));
  vec3 py1 = vec3(snoise(p + dy), snoise(p + dy + 31.4), snoise(p + dy + 71.7));
  vec3 pz0 = vec3(snoise(p - dz), snoise(p - dz + 31.4), snoise(p - dz + 71.7));
  vec3 pz1 = vec3(snoise(p + dz), snoise(p + dz + 31.4), snoise(p + dz + 71.7));
  float x = (py1.z - py0.z) - (pz1.y - pz0.y);
  float y = (pz1.x - pz0.x) - (px1.z - px0.z);
  float z = (px1.y - px0.y) - (py1.x - py0.x);
  return vec3(x, y, z) / (2.0 * e);
}
`;

// 黑体辐射近似：温度(K) -> 线性 RGB（相对亮度归一）
export const blackbody = /* glsl */ `
vec3 blackbody(float K){
  float t = K / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
  c.g = t <= 66.0 ? clamp(0.39008157876 * log(t) - 0.63184144378, 0.0, 1.0) : clamp(1.12989086089 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.54320678911 * log(t - 10.0) - 1.19625408914, 0.0, 1.0));
  return pow(c, vec3(2.2));
}
`;

// inferno 色阶（热成像），x ∈ [0,1]
export const inferno = /* glsl */ `
vec3 inferno(float t){
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.00021894, 0.00165100, -0.01948089);
  const vec3 c1 = vec3(0.10651341, 0.56395643, 3.93271239);
  const vec3 c2 = vec3(11.60249308, -3.97285397, -15.94239411);
  const vec3 c3 = vec3(-41.70399613, 17.43639889, 44.35414520);
  const vec3 c4 = vec3(77.16293570, -33.40235894, -81.80730926);
  const vec3 c5 = vec3(-71.31942824, 32.62606426, 73.20951986);
  const vec3 c6 = vec3(25.13112622, -12.24266895, -23.07032500);
  return max(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0);
}
`;

// 粒子精灵：柔和高斯核 + 星芒（可选）
export const sprite = /* glsl */ `
float softDot(vec2 pc, float sharp){ float d = length(pc - 0.5) * 2.0; return exp(-d * d * sharp); }
`;

export const all = hash + simplex3 + blackbody + inferno + sprite;
