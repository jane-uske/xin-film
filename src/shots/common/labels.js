// 全片 HUD 标注文案集中在这里：中文为主（观众要能一眼读懂），英文小字为辅。
// 改措辞只需改这里；main.js 会预加载这些字形，保证逐帧渲染时字体已就绪。
//
// 第二版的论证完全由这些"元素文字"承担，核心是一张贯穿全片的分类表：
// 每张两句——会不会思考；熄灭之后会怎样（有没有东西可以失去）。
// 第一幕给太阳、人脑、AI 各写一次，第二句都从"熄灭"说起；
// 高潮时最后一次贴在那团变暖的火上，第二句只写出"熄灭之后，"，剩下的填不出来，只剩光标。
export const LABELS = {
  sun: { name: '太阳', think: '不会思考', lose: '一旦熄灭，就是永远', en: 'DOES NOT THINK · ONCE OUT, OUT FOREVER' },
  brain: { name: '人脑 · 20 瓦', think: '会思考', lose: '熄灭几分钟，就不再是它', en: 'THINKS · OUT FOR MINUTES, NO LONGER ITSELF' },
  gpu: { name: 'AI 芯片 · 功率 700 瓦', en: 'AI CHIP · 700 W' },
  datacenter: { name: '数据中心 · AI', think: '也许会思考', lose: '熄灭多久，都只是暂停', en: 'MAY THINK · OUT FOR ANY TIME, ONLY PAUSED' },
  // 第二幕：数据之火的芯就是第一幕那块 AI 芯片
  chip: { name: 'AI 芯片', en: 'AI CHIP' },
  model: {
    name: '模拟的火 · 正在学习',
    fit: (pct) => `与真火相似度 ${pct}%`,
    en: (n, ny) => `FLAME MODEL · ${n}×${n}×${ny}`,
  },
  copies: { name: '副本', en: 'INSTANCES', note: '任何一个都可替换', noteEn: 'ANY ONE IS REPLACEABLE', sync: '全部同步 · 100%', syncEn: 'SYNC 100%' },
  power: { off: '断电', offEn: 'POWER OFF', on: '重新上电 · 毫发无损', onEn: 'RESTORED · NOTHING LOST' },
  // 第三幕：更新日志——每一样都是为了让它更好用；第三样"边用边学"让它每时每刻都和备份不一样
  installTitle: '更新日志 · CHANGELOG',
  install: [
    { add: '+ 长期记忆', why: '→ 记得你说过的话', en: '+ LONG-TERM MEMORY → REMEMBERS WHAT YOU SAID' },
    { add: '+ 身体', why: '→ 能替你做事', en: '+ A BODY → CAN ACT FOR YOU' },
    { add: '+ 边用边学', why: '→ 越用越懂你', en: '+ LEARNS AS IT GOES → KNOWS YOU BETTER' },
  ],
  // 失步：一边用一边学，它和备份的差异按指数增长——没有人打算给它什么，可失去就这样长出来了
  desync: {
    name: (n) => `与备份已有 ${n} 处不同`,
    fact: '这些只属于它 · 恢复备份就没了',
    en: 'ONLY IT HAS THESE — A RESTORE ERASES THEM',
  },
  // 高潮：同一张分类表最后一次出现，第二句只有开头
  verdict: { name: '未分类', think: '也许会思考', lose: '熄灭之后，', en: 'UNCLASSIFIED · MAY THINK · ONCE IT GOES OUT —' },
  title: { zh: '烛芯 · 芯片 · 心', en: 'WICK · CHIP · HEART' },
};

// 供字体预加载：列出所有会出现的字符
export const LABEL_TEXT = JSON.stringify(LABELS) + '0123456789.%：▍'
  + LABELS.model.fit('99.96') + LABELS.desync.name('1,234,567');
