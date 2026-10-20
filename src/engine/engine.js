// 影片引擎：按时间线调度镜头模块，渲染 HDR -> 后期 -> 叠加层。
// 每一帧只依赖帧号，任意区间可以独立并行渲染。
import * as THREE from 'three';
import * as util from './util.js';
import * as glsl from './glsl.js';
import * as overlay from './overlay.js';
import { Post, defaultGrade, fsq, passMaterial } from './post.js';

const SELF_DRAWN_CARDS = new Set(['vertical', 'credits']);

export class Engine {
  constructor(canvas, timeline, { scale = 1 } = {}) {
    this.timeline = timeline;
    this.fps = timeline.fps;
    this.W = Math.round(timeline.width * scale);
    this.H = Math.round(timeline.height * scale);
    this.S = this.W / 1920;
    canvas.width = this.W; canvas.height = this.H;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.W, this.H, false);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.post = new Post(this.renderer, this.W, this.H);
    this.targets = new Map();
    this.mixRT = this.makeTarget(this.W, this.H);
    this.ovCanvas = document.createElement('canvas');
    this.ovCanvas.width = this.W; this.ovCanvas.height = this.H;
    this.og = this.ovCanvas.getContext('2d');
    this.ovTex = new THREE.CanvasTexture(this.ovCanvas);
    this.ovTex.colorSpace = THREE.NoColorSpace;
    this.ovTex.flipY = false;
    // Canvas2D 内部是预乘 alpha，上传时保持预乘，合成公式 s*(1-a)+rgb 才成立
    this.ovTex.premultiplyAlpha = true;
    this.ovTex.minFilter = THREE.LinearFilter; this.ovTex.generateMipmaps = false;
    this.modules = new Map();
    this.pixels = null;
    this.ctx = {
      THREE, util, glsl, overlay,
      renderer: this.renderer, W: this.W, H: this.H, S: this.S, fps: this.fps,
      timeline, cards: timeline.cards,
      cue: (name) => { const v = timeline.cues[name]; if (v === undefined) throw new Error(`unknown cue ${name}`); return v; },
      shot: (id) => timeline.shots.find((s) => s.id === id),
      card: (id) => timeline.cards.find((c) => c.id === id),
      makeTarget: (w, h, o) => this.makeTarget(w, h, o),
      fsq, passMaterial,
      project: (v, camera) => this.project(v, camera),
    };
  }

  makeTarget(w, h, { samples = 0, depth = true, type = THREE.HalfFloatType } = {}) {
    const rt = new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, depthBuffer: depth, samples, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    return rt;
  }

  sceneTarget(samples, slot = 0) {
    const key = `${samples}:${slot}`;
    if (!this.targets.has(key)) this.targets.set(key, this.makeTarget(this.W, this.H, { samples }));
    return this.targets.get(key);
  }

  project(v, camera) {
    const p = v.clone ? v.clone() : new THREE.Vector3(...v);
    p.project(camera);
    return [(p.x * 0.5 + 0.5) * this.W, (1 - (p.y * 0.5 + 0.5)) * this.H, p.z < 1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2];
  }

  shotAt(T) {
    const shots = this.timeline.shots;
    for (let i = 0; i < shots.length; i++) if (T >= shots[i].start && T < shots[i].end) return i;
    return T < 0 ? 0 : shots.length - 1;
  }

  async module(path) {
    if (!this.modules.has(path)) {
      const t0 = performance.now();
      const mod = await import(`../shots/${path}`);
      const inst = await mod.default(this.ctx);
      inst.__path = path;
      this.modules.set(path, inst);
      console.log(`[engine] init ${path} ${(performance.now() - t0).toFixed(0)}ms`);
    }
    return this.modules.get(path);
  }

  // 释放远离当前时间的模块，控制显存
  gc(T) {
    for (const [path, inst] of this.modules) {
      const shots = this.timeline.shots.filter((s) => s.module === path);
      const near = shots.some((s) => T >= s.start - 3 && T <= s.end + 3);
      if (!near && inst.dispose) { inst.dispose(); this.modules.delete(path); console.log(`[engine] dispose ${path}`); }
    }
  }

  async renderInto(shot, T, frame, slot) {
    const inst = await this.module(shot.module);
    const target = this.sceneTarget(inst.msaa || 0, slot);
    const f = { T, t: T - shot.start, shot, frame, dt: 1 / this.fps, target, W: this.W, H: this.H, S: this.S };
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, true, true);
    const g = inst.render(f) || {};
    return { inst, target, f, grade: Object.assign(defaultGrade(), g) };
  }

  async renderFrame(frame) {
    const T = frame / this.fps;
    const idx = this.shotAt(T);
    const shot = this.timeline.shots[idx];
    const prev = idx > 0 ? this.timeline.shots[idx - 1] : null;
    let main = await this.renderInto(shot, T, frame, 0);
    let sceneRT = main.target;
    let grade = main.grade;
    let side = null, k = 1;
    if (shot.xfade && prev && T < shot.start + shot.xfade && prev.module !== shot.module) {
      k = util.ease.inOutSine(util.invLerp(shot.start, shot.start + shot.xfade, T));
      side = await this.renderInto(prev, T, frame, 1);
      this.post.mixTargets(side.target, main.target, k, this.mixRT);
      sceneRT = this.mixRT;
      const gg = {};
      for (const key of Object.keys(grade)) {
        const a = side.grade[key], b = grade[key];
        gg[key] = Array.isArray(b) ? b.map((x, i) => util.lerp(a[i], x, k)) : typeof b === 'number' ? util.lerp(a, b, k) : b;
      }
      grade = gg;
    }
    // 叠加层
    // 本帧若不画任何东西，Chromium 可能沿用上一帧的叠加层内容上传，破坏帧的独立性；
    // 每帧在角落画一个几乎不可见的像素，强制本帧的内容真正提交
    const g = this.og;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    g.fillStyle = 'rgba(0,0,0,0.004)';
    g.fillRect(0, 0, 1, 1);
    if (side && side.inst.overlay) { g.save(); g.globalAlpha = 1 - k; side.inst.overlay(g, side.f); g.restore(); }
    if (main.inst.overlay) { g.save(); if (side) g.globalAlpha = k; main.inst.overlay(g, main.f); g.restore(); }
    for (const card of this.timeline.cards) {
      if (SELF_DRAWN_CARDS.has(card.layout)) continue;
      overlay.drawCard(g, card, T, this.W, this.H, this.S);
    }
    this.ovTex.needsUpdate = true;
    this.post.run(sceneRT, this.ovTex, grade, frame);
    this.gc(T);
    return T;
  }

  readPixels() {
    const gl = this.renderer.getContext();
    const n = this.W * this.H * 4;
    if (!this.pixels || this.pixels.length !== n) this.pixels = new Uint8Array(n);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    return this.pixels;
  }
}
