// 占位镜头：在真正的镜头完成前，让时间线可以端到端跑通
export default function stub(label, color = 0x101820) {
  return async function create(ctx) {
    const { THREE } = ctx;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(color);
    const cam = new THREE.PerspectiveCamera(35, ctx.W / ctx.H, 0.1, 100);
    return {
      render(f) { ctx.renderer.render(scene, cam); return { bloom: 0 }; },
      overlay(g, f) {
        ctx.overlay.hudText(g, `${label} · ${f.shot.id} ${f.shot.name} · ${f.T.toFixed(2)}s`, 40 * f.S, 60 * f.S, { size: 14, S: f.S, alpha: 0.8 });
      },
    };
  };
}
