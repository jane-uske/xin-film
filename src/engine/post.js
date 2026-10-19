// 后期管线：HDR 场景 -> 泛光（双重滤波 mip 链）+ 变形宽银幕横向光晕 -> 合成（色调映射、调色、色散、暗角、颗粒、字幕层）
import * as THREE from 'three';

const VS = /* glsl */ `
out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class FSQ {
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.mesh = new THREE.Mesh(g, null);
    this.mesh.frustumCulled = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.cam);
  }
}

export const fsq = new FSQ();

export function passMaterial(frag, uniforms = {}, extra = {}) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VS,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
    ...extra,
  });
}

const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping };

export class Post {
  constructor(renderer, W, H) {
    this.renderer = renderer;
    this.W = W; this.H = H;
    this.levels = 6;
    this.mips = [];
    let w = Math.floor(W / 2), h = Math.floor(H / 2);
    for (let i = 0; i < this.levels; i++) {
      this.mips.push(new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), rtOpts));
      w = Math.floor(w / 2); h = Math.floor(h / 2);
    }
    // 横向光晕：纵向压缩到 1/8，横向逐级加宽
    this.streakA = new THREE.WebGLRenderTarget(Math.floor(W / 4), Math.floor(H / 8), rtOpts);
    this.streakB = new THREE.WebGLRenderTarget(Math.floor(W / 4), Math.floor(H / 8), rtOpts);

    this.prefilter = passMaterial(/* glsl */ `
      precision highp float; in vec2 vUv; out vec4 o;
      uniform sampler2D tSrc; uniform vec2 texel; uniform float threshold, knee;
      vec3 q(vec2 uv){ return texture(tSrc, uv).rgb; }
      float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      // Karis 加权，抑制萤火虫闪烁
      vec3 kw(vec3 c){ return c / (1.0 + lum(c)); }
      void main(){
        vec2 t = texel;
        vec3 a = q(vUv + t * vec2(-1., -1.)), b = q(vUv + t * vec2(1., -1.)), c = q(vUv + t * vec2(-1., 1.)), d = q(vUv + t * vec2(1., 1.));
        vec3 e = q(vUv);
        float wa = 1.0 / (1.0 + lum(a)), wb = 1.0 / (1.0 + lum(b)), wc = 1.0 / (1.0 + lum(c)), wd = 1.0 / (1.0 + lum(d)), we = 1.0 / (1.0 + lum(e));
        vec3 col = (a * wa + b * wb + c * wc + d * wd + e * we * 2.0) / (wa + wb + wc + wd + we * 2.0);
        col = min(col, vec3(64.0));
        float br = max(col.r, max(col.g, col.b));
        float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
        soft = soft * soft / (4.0 * knee + 1e-5);
        float contrib = max(soft, br - threshold) / max(br, 1e-5);
        o = vec4(col * contrib, 1.0);
      }`, { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1 }, knee: { value: 0.5 } });

    this.down = passMaterial(/* glsl */ `
      precision highp float; in vec2 vUv; out vec4 o;
      uniform sampler2D tSrc; uniform vec2 texel;
      vec3 q(vec2 o){ return texture(tSrc, vUv + o * texel).rgb; }
      void main(){
        vec3 a = q(vec2(-2., 2.)), b = q(vec2(0., 2.)), c = q(vec2(2., 2.));
        vec3 d = q(vec2(-2., 0.)), e = q(vec2(0., 0.)), f = q(vec2(2., 0.));
        vec3 g = q(vec2(-2., -2.)), h = q(vec2(0., -2.)), i = q(vec2(2., -2.));
        vec3 j = q(vec2(-1., 1.)), k = q(vec2(1., 1.)), l = q(vec2(-1., -1.)), m = q(vec2(1., -1.));
        vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
        o = vec4(col, 1.0);
      }`, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });

    this.up = passMaterial(/* glsl */ `
      precision highp float; in vec2 vUv; out vec4 o;
      uniform sampler2D tSrc; uniform vec2 texel; uniform float radius, weight;
      vec3 q(vec2 o){ return texture(tSrc, vUv + o * texel * radius).rgb; }
      void main(){
        vec3 col = q(vec2(0.)) * 4.0 + (q(vec2(-1., 0.)) + q(vec2(1., 0.)) + q(vec2(0., -1.)) + q(vec2(0., 1.))) * 2.0
          + q(vec2(-1., -1.)) + q(vec2(1., -1.)) + q(vec2(-1., 1.)) + q(vec2(1., 1.));
        o = vec4(col / 16.0 * weight, 1.0);
      }`, { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, radius: { value: 1 }, weight: { value: 1 } },
      { blending: THREE.AdditiveBlending, transparent: true });

    this.hblur = passMaterial(/* glsl */ `
      precision highp float; in vec2 vUv; out vec4 o;
      uniform sampler2D tSrc; uniform vec2 texel; uniform float stepPx, gain;
      void main(){
        vec3 c = vec3(0.0); float wsum = 0.0;
        for (int i = -7; i <= 7; i++){
          float x = float(i); float w = exp(-x * x / 18.0);
          c += texture(tSrc, vUv + vec2(x * stepPx * texel.x, 0.0)).rgb * w; wsum += w;
        }
        o = vec4(c / wsum * gain, 1.0);
      }`, { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, stepPx: { value: 1 }, gain: { value: 1 } });

    this.mix = passMaterial(/* glsl */ `
      precision highp float; in vec2 vUv; out vec4 o;
      uniform sampler2D tA, tB; uniform float k;
      void main(){ o = vec4(mix(texture(tA, vUv).rgb, texture(tB, vUv).rgb, k), 1.0); }`,
      { tA: { value: null }, tB: { value: null }, k: { value: 0 } });

    this.composite = passMaterial(/* glsl */ `
      precision highp float; in vec2 vUv; out vec4 o;
      uniform sampler2D tScene, tBloom, tStreak, tOverlay;
      uniform vec2 res; uniform float frame;
      uniform float exposure, bloomStrength, streakStrength, saturation, contrast, vignette, ca, grain, fade, overlayOn, temperature;
      uniform vec3 bloomTint, streakTint, lift, gamma, gain;
      vec3 aces(vec3 x){
        const mat3 m1 = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
        const mat3 m2 = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
        vec3 v = m1 * x; vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
        return clamp(m2 * (a / b), 0.0, 1.0);
      }
      vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main(){
        vec2 uv = vUv;
        vec2 dc = uv - 0.5;
        float r2 = dot(dc * vec2(res.x / res.y, 1.0), dc * vec2(res.x / res.y, 1.0));
        // 边缘色散
        vec2 off = dc * ca * (0.4 + r2);
        vec3 col;
        col.r = texture(tScene, uv - off).r;
        col.g = texture(tScene, uv).g;
        col.b = texture(tScene, uv + off).b;
        vec3 bl = texture(tBloom, uv).rgb;
        vec3 st = texture(tStreak, uv).rgb;
        col += bl * bloomStrength * bloomTint;
        col += st * streakStrength * streakTint;
        col *= exposure;
        // 色温微调（>0 偏暖，<0 偏冷）
        col *= vec3(1.0 + temperature * 0.10, 1.0, 1.0 - temperature * 0.12);
        col = aces(col);
        // 调色：lift / gamma / gain
        col = pow(max(gain * (col + lift * (1.0 - col)), 0.0), 1.0 / gamma);
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, saturation);
        col = clamp((col - 0.5) * contrast + 0.5, 0.0, 1.0);
        // 暗角
        float v = 1.0 - vignette * smoothstep(0.15, 1.1, r2 * 1.4);
        col *= v;
        col *= fade;
        vec3 s = toSRGB(col);
        if (overlayOn > 0.5) { vec4 ov = texture(tOverlay, vec2(uv.x, 1.0 - uv.y)); s = s * (1.0 - ov.a) + ov.rgb; }
        // 胶片颗粒（亮度相关，暗部更明显但不抬黑）+ 三角抖动防色带
        vec2 px = uv * res;
        float n1 = h12(px + vec2(frame * 13.1, frame * 7.7));
        float n2 = h12(px * 1.37 + vec2(frame * 3.3, frame * 11.9));
        float g = (n1 + n2 - 1.0);
        float lum = dot(s, vec3(0.299, 0.587, 0.114));
        s += g * grain * (0.35 + 0.65 * smoothstep(0.0, 0.25, lum)) * (1.0 - lum * 0.6);
        s += (h12(px + 91.7 + frame) - 0.5) / 255.0;
        o = vec4(clamp(s, 0.0, 1.0), 1.0);
      }`, {
      tScene: { value: null }, tBloom: { value: null }, tStreak: { value: null }, tOverlay: { value: null },
      res: { value: new THREE.Vector2(W, H) }, frame: { value: 0 },
      exposure: { value: 1 }, bloomStrength: { value: 0.6 }, streakStrength: { value: 0 }, saturation: { value: 1 }, contrast: { value: 1 },
      vignette: { value: 0.35 }, ca: { value: 0.0015 }, grain: { value: 0.05 }, fade: { value: 1 }, overlayOn: { value: 1 }, temperature: { value: 0 },
      bloomTint: { value: new THREE.Vector3(1, 1, 1) }, streakTint: { value: new THREE.Vector3(0.45, 0.65, 1.0) },
      lift: { value: new THREE.Vector3(0, 0, 0) }, gamma: { value: new THREE.Vector3(1, 1, 1) }, gain: { value: new THREE.Vector3(1, 1, 1) },
    });
  }

  mixTargets(a, b, k, out) {
    this.mix.uniforms.tA.value = a.texture; this.mix.uniforms.tB.value = b.texture; this.mix.uniforms.k.value = k;
    fsq.render(this.renderer, this.mix, out);
  }

  run(sceneRT, overlayTex, grade, frame) {
    const r = this.renderer;
    const W = this.W, H = this.H;
    // 1. 阈值预滤到 1/2
    const pf = this.prefilter.uniforms;
    pf.tSrc.value = sceneRT.texture; pf.texel.value.set(1 / W, 1 / H);
    pf.threshold.value = grade.bloomThreshold; pf.knee.value = grade.bloomKnee;
    fsq.render(r, this.prefilter, this.mips[0]);
    // 2. 下采样链
    for (let i = 1; i < this.levels; i++) {
      const src = this.mips[i - 1];
      this.down.uniforms.tSrc.value = src.texture; this.down.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      fsq.render(r, this.down, this.mips[i]);
    }
    // 3. 上采样叠加
    for (let i = this.levels - 1; i > 0; i--) {
      const src = this.mips[i];
      this.up.uniforms.tSrc.value = src.texture; this.up.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      this.up.uniforms.radius.value = grade.bloomRadius; this.up.uniforms.weight.value = 1.0;
      r.autoClear = false;
      fsq.render(r, this.up, this.mips[i - 1]);
      r.autoClear = true;
    }
    // 4. 横向光晕（仅在需要时）
    if (grade.streak > 0) {
      const hb = this.hblur.uniforms;
      hb.texel.value.set(1 / this.streakA.width, 1 / this.streakA.height);
      hb.tSrc.value = this.mips[1].texture; hb.stepPx.value = 1; hb.gain.value = 1;
      fsq.render(r, this.hblur, this.streakA);
      const steps = [3, 9, 27];
      let a = this.streakA, b = this.streakB;
      for (const s of steps) { hb.tSrc.value = a.texture; hb.stepPx.value = s; hb.gain.value = 1.0; fsq.render(r, this.hblur, b); [a, b] = [b, a]; }
      this.streakOut = a;
    }
    // 5. 合成到屏幕
    const u = this.composite.uniforms;
    u.tScene.value = sceneRT.texture; u.tBloom.value = this.mips[0].texture;
    u.tStreak.value = grade.streak > 0 ? this.streakOut.texture : this.mips[this.levels - 1].texture;
    u.tOverlay.value = overlayTex; u.overlayOn.value = overlayTex ? 1 : 0;
    u.frame.value = frame % 997;
    u.exposure.value = grade.exposure; u.bloomStrength.value = grade.bloom; u.streakStrength.value = grade.streak;
    u.saturation.value = grade.saturation; u.contrast.value = grade.contrast; u.vignette.value = grade.vignette;
    u.ca.value = grade.ca; u.grain.value = grade.grain; u.fade.value = grade.fade; u.temperature.value = grade.temperature;
    u.bloomTint.value.fromArray(grade.bloomTint); u.streakTint.value.fromArray(grade.streakTint);
    u.lift.value.fromArray(grade.lift); u.gamma.value.fromArray(grade.gamma); u.gain.value.fromArray(grade.gain);
    fsq.render(r, this.composite, null);
  }
}

export const defaultGrade = () => ({
  exposure: 1.0,
  bloom: 0.55, bloomThreshold: 0.9, bloomKnee: 0.6, bloomRadius: 1.0, bloomTint: [1.0, 0.92, 0.85],
  streak: 0.0, streakTint: [0.45, 0.65, 1.0],
  saturation: 1.0, contrast: 1.0, temperature: 0.0,
  lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
  vignette: 0.35, ca: 0.0012, grain: 0.045,
  fade: 1.0,
});
