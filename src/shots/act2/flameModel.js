// 共享火焰模型：蜡烛火（连续）与数据之火（网格点）采样同一个密度函数、同一组闪烁参数。
// 闪烁参数在 CPU 端由"火焰时间" tf 计算（纯函数），以 uniform 传给两种着色器 ——
// 同一个 tf 就是同一帧火焰，这正是"完美同步"的来源；失步 = 给某一团火换一个 tf。

export const FLAME = {
  L: 3.55,     // 焰长（cm，自烛芯顶到焰尖）
  W: 0.50,     // 最大半宽（cm）
  B: 0.36,     // 焰底在芯顶以下的深度（蓝色杯状底包住烛芯）
};

// tf：火焰时间；seed：独立噪声（失步后的火用自己的 seed）；o：额外形变（倾斜、拉伸、缩小、摇曳）
export function flicker(util, tf, seed = 0, o = {}) {
  const { fbm1, smoothstep } = util;
  const s = seed * 37.17;
  // 偶发的"扑动"：静止空气里的烛火大部分时间很稳，偶尔被微风扰动
  const flut = smoothstep(0.12, 0.42, fbm1(tf * 0.19 + 3.1 + s, 3)) * (o.flutterGain ?? 1) + (o.flutterAdd ?? 0);
  const breathe = fbm1(tf * 0.42 + 11.7 + s, 3);
  let len = 1 + 0.055 * breathe + 0.03 * fbm1(tf * 1.7 + 5.3 + s, 2) - 0.07 * flut * (0.5 + 0.5 * Math.sin(tf * 6.2831 * 8.7));
  let wid = 1 - 0.035 * breathe + 0.02 * fbm1(tf * 2.1 + 9.9 + s, 2);
  let leanX = 0.11 * fbm1(tf * 0.31 + 21.3 + s, 3) + 0.05 * flut * Math.sin(tf * 6.2831 * 3.3 + 1.0);
  let leanZ = 0.09 * fbm1(tf * 0.29 + 41.9 + s, 3);
  const ripSlow = 0.022 + 0.012 * Math.abs(fbm1(tf * 0.6 + 2.2 + s, 2));
  const ripFast = 0.006 + 0.05 * flut;
  const bright = 1 + 0.035 * fbm1(tf * 1.1 + 77.1 + s, 3) - 0.10 * flut * (0.5 + 0.5 * Math.sin(tf * 6.2831 * 8.7 + 0.6));
  // 外部形变
  leanX += o.leanX ?? 0; leanZ += o.leanZ ?? 0;
  len *= o.lenMul ?? 1; wid *= o.widMul ?? 1;
  return {
    f0: [leanX, leanZ, FLAME.L * len, FLAME.W * wid],
    f1: [ripSlow * (o.ripMul ?? 1), ripFast * (o.ripMul ?? 1), tf + seed * 13.3, bright * (o.brightMul ?? 1)],
    flut,
  };
}

// GLSL：火焰几何。p 为以芯顶为原点的局部坐标（cm）。
// 返回 vec3(rn, s, inside)，rn = 径向归一化距离（<1 在焰内），s = 0(焰底)…1(焰尖)
export const flameGLSL = /* glsl */ `
#define FL_B ${FLAME.B.toFixed(3)}
float flS(float y, vec4 f0){ return (y + FL_B) / (f0.z + FL_B); }
vec2 flCenter(float s, float y, vec4 f0, vec4 f1){
  float sc = clamp(s, 0.0, 1.3);
  float s2 = sc * sc;
  vec2 c = f0.xy * s2 * 1.15;
  float t = f1.z;
  float ph1 = 6.2831 * (0.55 * y - 1.9 * t);
  float ph2 = 6.2831 * (1.25 * y - 8.6 * t);
  c.x += (f1.x * sin(ph1) + f1.y * sin(ph2)) * s2 * 1.4;
  c.y += (f1.x * cos(ph1 * 0.93 + 1.3) + f1.y * cos(ph2 * 1.07 + 2.1)) * s2;
  return c;
}
float flHalfW(float s, vec4 f0){
  float sc = clamp(s, 0.0, 1.0);
  return f0.w * 2.15 * pow(sc, 0.42) * pow(max(1.0 - sc, 0.0), 0.78) + 1e-4;
}
// 3D：p.xz 横向，p.y 纵向
vec3 flame3(vec3 p, vec4 f0, vec4 f1){
  float s = flS(p.y, f0);
  vec2 c = flCenter(s, p.y, f0, f1);
  float w = flHalfW(s, f0);
  float rn = length(p.xz - c) / w;
  return vec3(rn, s, step(0.0, s) * step(s, 1.0));
}
// 共同的"密度"：发光体的强度场（两团火都用它）
float flDensity(float rn, float s){
  float body = smoothstep(1.0, 0.45, rn);
  float vert = smoothstep(0.02, 0.22, s) * (1.0 - smoothstep(0.78, 1.0, s));
  return body * vert;
}
`;
