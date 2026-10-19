// 纯黑镜头（开场、断问、片终）。字幕卡由引擎统一绘制。
export default async function create(ctx) {
  return {
    render(f) { return { bloom: 0, grain: 0.018, vignette: 0 }; },
  };
}
