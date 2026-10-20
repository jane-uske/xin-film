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
// 共同的发光模型：投影到画面上的亮度（rn 为横向归一化距离）。烛火直接用它着色；
// 数据之火的每一列光点按弦长分摊同一个值 —— 一列点叠起来，正好是同一幅火焰。
float flLum(float rn, float s, out float heat){
  float vin = step(0.0, s) * step(s, 1.0);
  float thick = sqrt(max(1.0 - rn * rn, 0.0));
  float lumV = smoothstep(0.10, 0.34, s) * (1.0 - smoothstep(0.72, 1.0, s));
  float edge = smoothstep(1.0, 0.62, rn);
  float lum = lumV * edge * (0.25 + 0.75 * thick);
  float dark = smoothstep(0.34, 0.10, s) * smoothstep(0.75, 0.15, rn);
  heat = clamp(lumV * edge * (1.0 - 0.8 * rn * rn) * (1.08 - 0.62 * s), 0.0, 1.0);
  return lum * (0.65 + 3.9 * pow(heat, 2.2)) * (1.0 - 0.8 * dark) * vin;
}
float flMantle(float rn, float s){
  float m = smoothstep(1.7, 0.7, rn) * smoothstep(0.05, 0.3, s) * (1.0 - smoothstep(0.8, 1.15, s)) * step(0.0, s) * step(s, 1.0);
  return m * m * 0.16;
}
float flBlue(float rn, float s){
  float b = smoothstep(0.27, 0.03, s) * smoothstep(0.45, 0.9, rn) * smoothstep(1.2, 0.95, rn) * step(-0.02, s);
  return b + smoothstep(0.2, 0.0, s) * smoothstep(0.8, 0.0, rn) * 0.2 * step(-0.02, s);
}
vec3 digPalette(float heat){
  // 与暖色调同样的亮度阶梯：深蓝（≈深红）→ #39C6FF（≈橙）→ #7FE8FF（≈黄）→ 白（≈芯）
  vec3 col = mix(vec3(0.015, 0.10, 0.55), vec3(0.04, 0.56, 1.0), smoothstep(0.0, 0.25, heat));
  col = mix(col, vec3(0.21, 0.81, 1.0), smoothstep(0.2, 0.55, heat));
  return mix(col, vec3(0.86, 0.97, 1.0), smoothstep(0.62, 0.95, heat));
}
vec3 warmPalette(float heat){
  vec3 col = mix(vec3(1.0, 0.16, 0.02), vec3(1.0, 0.36, 0.07), smoothstep(0.0, 0.25, heat));
  col = mix(col, vec3(1.0, 0.60, 0.20), smoothstep(0.2, 0.55, heat));
  return mix(col, vec3(1.0, 0.86, 0.62), smoothstep(0.62, 0.95, heat));
}
// 体密度（用于判断一个点是否在火焰体内）
float flDensity(float rn, float s){
  float body = smoothstep(1.0, 0.45, rn);
  float vert = smoothstep(0.02, 0.22, s) * (1.0 - smoothstep(0.78, 1.0, s));
  return body * vert;
}
`;
