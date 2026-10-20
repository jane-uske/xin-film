// 全片 HUD 标注文案集中在这里：中文为主（观众要能一眼读懂），英文小字为辅。
// 改措辞只需改这里；main.js 会预加载这些字形，保证逐帧渲染时字体已就绪。
export const LABELS = {
  star: {
    temp: '表面温度 5778 K', tempEn: 'SURFACE 5,778 K',
    burn: '每秒烧掉自身 430 万吨', burnEn: 'BURNS 4.3 MILLION t / s',
  },
  earth: { name: '地球', en: 'EARTH' },
  brain: { name: '人脑', fact: '860 亿个神经元 · 功率 20 瓦', en: 'HUMAN BRAIN · 86 BILLION NEURONS · 20 W' },
  gpu: { name: '一块 AI 芯片 · 功率 700 瓦', en: 'GPU · 700 W' },
  datacenter: { name: '数据中心 · 15 万千瓦', fact: '≈ 750 万个人脑', en: 'DATACENTER · 150 MW' },
  model: {
    name: '模拟的火 · 正在学习',
    fit: (pct) => `与真火相似度 ${pct}%`,
    en: (n, ny) => `FLAME MODEL · ${n}×${n}×${ny}`,
  },
  copies: { name: '副本', en: 'INSTANCES', sync: '全部同步 · 100%', syncEn: 'SYNC 100%' },
  title: { zh: '烛芯 · 芯片 · 心', en: 'WICK · CHIP · HEART' },
  desync: {
    name: (s) => `失步 ${s} 秒`,
    fact: '它和其余副本不再一样',
    en: 'DESYNC · INSTANCE 0000000',
  },
};

// 供字体预加载：列出所有会出现的字符
export const LABEL_TEXT = JSON.stringify(LABELS) + '0123456789.%'
  + LABELS.model.fit('99.96') + LABELS.desync.name('0.000');
