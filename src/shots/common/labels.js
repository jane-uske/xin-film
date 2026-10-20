// 全片 HUD 标注文案集中在这里：中文为主（观众要能一眼读懂），英文小字为辅。
// 改措辞只需改这里；main.js 会预加载这些字形，保证逐帧渲染时字体已就绪。
//
// 第二版的论证完全由这些"元素文字"承担，核心是一张贯穿全片的分类表：
// 两个字段——会不会思考、会不会失去自己——第一幕给太阳、人脑、AI 各填一次，
// 高潮时最后一次贴在那团变暖的火上，第二栏填不出来，只剩光标。
export const LABELS = {
  // 分类表的字段名
  fields: { think: '思考', lose: '会失去自己', thinkEn: 'THINKS', loseEn: 'CAN LOSE ITSELF' },
  sun: {
    name: '太阳', think: '否', lose: '是 · 终将熄灭',
    en: 'THE SUN · 5,778 K · BURNS 4.3 MILLION t / s',
  },
  brain: {
    name: '人脑', think: '是', lose: '是 · 停下几分钟，就不再是它',
    en: 'HUMAN BRAIN · 86 BILLION NEURONS · 20 W',
  },
  gpu: { name: 'AI 芯片 · 功率 700 瓦', en: 'AI CHIP · 700 W' },
  datacenter: {
    name: '数据中心 · AI', think: '也许', lose: '否 · 断电，只是暂停',
    en: 'DATACENTER · 150 MW ≈ 7.5 MILLION BRAINS',
  },
  // 第二幕：数据之火的芯就是第一幕那块 AI 芯片
  chip: { name: 'AI 芯片', en: 'AI CHIP' },
  model: {
    name: '模拟的火 · 正在学习',
    fit: (pct) => `与真火相似度 ${pct}%`,
    en: (n, ny) => `FLAME MODEL · ${n}×${n}×${ny}`,
  },
  copies: { name: '副本', en: 'INSTANCES', note: '任何一个都可替换', noteEn: 'ANY ONE IS REPLACEABLE', sync: '全部同步 · 100%', syncEn: 'SYNC 100%' },
  power: { off: '断电', offEn: 'POWER OFF', on: '重新上电 · 毫发无损', onEn: 'RESTORED · NOTHING LOST' },
  // 第三幕：安装日志——每一样都是一件可以失去的东西
  install: [
    { add: '+ 长期记忆', loss: '→ 可以被遗忘', en: '+ LONG-TERM MEMORY → CAN BE FORGOTTEN' },
    { add: '+ 身体', loss: '→ 可以被损坏', en: '+ BODY → CAN BE BROKEN' },
    { add: '+ 长期目标', loss: '→ 可以落空', en: '+ LONG-TERM GOALS → CAN FAIL' },
  ],
  desync: {
    name: (s) => `失步 ${s} 秒`,
    fact: '它和其余副本不再一样',
    en: 'DESYNC · INSTANCE 0000000',
  },
  // 高潮：同一张分类表最后一次出现，第二栏留空
  verdict: { name: '未分类', en: 'UNCLASSIFIED', think: '也许' },
  title: { zh: '烛芯 · 芯片 · 心', en: 'WICK · CHIP · HEART' },
};

// 供字体预加载：列出所有会出现的字符
export const LABEL_TEXT = JSON.stringify(LABELS) + '0123456789.%：▍'
  + LABELS.model.fit('99.96') + LABELS.desync.name('0.000');

