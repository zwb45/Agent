// v2: AI × 医疗 —— 技术驱动，临床落地 (midnight palette, tech+pilots angle).
// Run: node examples/ai-healthcare-v2.js

const path = require('path');
const { build } = require('../harness');
const out = path.join(__dirname, 'output', 'ai-healthcare-v2.pptx');

const slides = [
  {
    t: 'cover',
    eyebrow: 'AI × MEDICINE',
    title: 'AI × 医疗：技术驱动，临床落地',
    subtitle: '六大技术支柱 · 标志性场景 · 从验证到规模化',
    img: 'artificial intelligence medicine futuristic blue',
    chips: [{ k: '技术', d: '六大支柱' }, { k: '场景', d: '标志应用' }, { k: '落地', d: '五步闭环' }],
    meta: '2026 · 深度洞察',
  },
  {
    t: 'agenda', eyebrow: '导览', title: '内容导航',
    items: [
      { title: 'AI 医疗的关键数字', desc: '规模 · 效率 · 渗透' },
      { title: '六大技术支柱', desc: 'CV · NLP · 大模型 · 预测 · 机器人 · 多模态' },
      { title: '医学影像与大模型', desc: 'AI 的主战场' },
      { title: '标志性应用案例', desc: 'AlphaFold · 影像筛查 · 手术机器人' },
      { title: '临床落地路径', desc: '从模型到床旁的闭环' },
      { title: '治理挑战与未来', desc: '隐私 · 公平 · 监管 · 趋势' },
    ],
  },
  {
    t: 'stats', eyebrow: '01 · 现状', title: 'AI 医疗的关键数字',
    stats: [
      { big: '2 亿+', label: 'AlphaFold 预测的蛋白质结构数' },
      { big: '>95%', label: '影像 AI 筛查敏感度' },
      { big: '+40%', label: 'AI 辅助下医生读片效率' },
    ],
    cols: [
      { title: '技术驱动', bullets: ['深度学习与算力突破', '多模态医疗大模型兴起', '医疗数据持续爆发'] },
      { title: '价值释放', bullets: ['诊断更快、更准', '研发周期与成本下降', '优质医疗触达基层'] },
    ],
  },
  {
    t: 'divider', eyebrow: '02 · 技术', title: '六大技术支柱',
    subtitle: '从感知、理解到决策与执行，AI 在医疗的每个环节都有支柱技术。',
    img: 'neural network abstract blue technology',
  },
  {
    t: 'iconGrid', eyebrow: '02 · 技术', title: '六大技术支柱',
    cards: [
      { icon: 'lu/LuScanLine', title: '计算机视觉', desc: '影像与病理识别' },
      { icon: 'lu/LuFileText', title: '自然语言处理', desc: '病历理解与抽取' },
      { icon: 'lu/LuBrainCircuit', title: '大语言模型', desc: '诊疗助手与问答' },
      { icon: 'lu/LuTrendingUp', title: '预测建模', desc: '风险预测与早筛' },
      { icon: 'lu/LuCircuitBoard', title: '机器人技术', desc: '精准微创手术' },
      { icon: 'lu/LuLanguages', title: '语音与多模态', desc: '医患交互与融合' },
    ],
  },
  {
    t: 'twoCol', eyebrow: '03 · 影像', title: '医学影像：AI 的主战场',
    img: 'ct mri brain scan radiology doctor',
    caption: '计算机视觉让 AI 成为放射科与病理科的"第二双眼睛"。',
    left: {
      title: '计算机视觉 × 医学影像',
      lead: 'AI 自动识别 X 光、CT、MRI 与病理切片中的异常，承担检出、分割、量化与排序工作。',
      bullets: ['肺结节、眼底、乳腺病灶自动检出', '器官与病灶分割与定量测量', '按紧急度排序，优先处理危重病例', '降低漏诊、缓解医生读片负荷'],
    },
  },
  {
    t: 'chart', eyebrow: '03 · 分布', title: 'AI 医疗应用领域分布',
    lead: '医学影像是 AI 在医疗最大的应用领域，药物研发与临床决策紧随其后；数据为行业综合估算，仅供示意。',
    stat: { big: '34%', desc: '医学影像占据 AI 医疗最大份额' },
    chart: { title: 'AI 医疗各领域应用占比（%）', cats: ['医学影像', '药物研发', '临床决策', '健康管理', '手术机器人'], vals: [34, 22, 18, 16, 10], suffix: '%', color: '5C8DEF' },
  },
  {
    t: 'divider', eyebrow: '04 · 案例', title: '标志性应用案例',
    subtitle: '从科研突破到临床产品，这些案例定义了 AI 医疗的版图。',
    img: 'surgical robot operating room',
  },
  {
    t: 'iconGrid', eyebrow: '04 · 案例', title: '标志性应用案例',
    cards: [
      { icon: 'lu/LuDna', title: 'AlphaFold', desc: '蛋白质结构预测' },
      { icon: 'lu/LuEye', title: '影像 AI 筛查', desc: '肺结节与眼底早筛' },
      { icon: 'lu/LuCircuitBoard', title: '手术机器人', desc: '达芬奇微创系统' },
      { icon: 'lu/LuMessageSquare', title: 'AI 诊疗助手', desc: '大模型问诊决策' },
      { icon: 'lu/LuFlaskConical', title: 'AI 药物发现', desc: '靶点与分子设计' },
      { icon: 'lu/LuHeartPulse', title: '健康管理', desc: '可穿戴与慢病随访' },
    ],
  },
  {
    t: 'flow', eyebrow: '05 · 落地', title: '临床落地五步闭环',
    stats: [{ big: '5 步', label: '从模型到床旁的标准化路径' }, { big: '三类证', label: 'NMPA 高风险 AI 医械审批门槛' }],
    heading: '从模型到床旁的闭环',
    steps: [
      { icon: 'lu/LuDatabase', title: '数据治理', desc: '合规多中心数据' },
      { icon: 'lu/LuBrainCircuit', title: '模型训练', desc: '领域微调与验证' },
      { icon: 'lu/LuClipboardCheck', title: '临床验证', desc: '多中心对比试验' },
      { icon: 'lu/LuShieldCheck', title: '审批准入', desc: '监管认证与合规' },
      { icon: 'lu/LuActivity', title: '部署监测', desc: '持续监测与迭代' },
    ],
  },
  {
    t: 'quadrant', eyebrow: '06 · 治理', title: '治理与挑战',
    cards: [
      { icon: 'lu/LuLock', title: '数据隐私', desc: '患者数据敏感，需脱敏与授权治理' },
      { icon: 'lu/LuScale', title: '算法公平', desc: '跨人群、跨机构的性能一致性' },
      { icon: 'lu/LuEye', title: '可解释性', desc: '黑箱决策影响临床信任与采纳' },
      { icon: 'lu/LuShieldCheck', title: '监管合规', desc: '准入标准与责任归属待完善' },
    ],
  },
  {
    t: 'future', eyebrow: '07 · 展望', title: '未来三大趋势',
    cards: [
      { icon: 'lu/LuSparkles', title: '医疗大模型', desc: '多模态通用医学智能，一次训练多场景复用。' },
      { icon: 'lu/LuBot', title: 'AI 医生伙伴', desc: '从单点辅助走向全流程诊疗协作。' },
      { icon: 'lu/LuAtom', title: 'AI × 生命科学', desc: '蛋白质设计与新药发现的范式重构。' },
    ],
  },
  {
    t: 'closing',
    eyebrow: '结语',
    title: 'AI 正在把医疗带入新范式',
    take: [
      { title: '技术就绪', desc: '六大支柱日趋成熟' },
      { title: '场景落地', desc: '从影像到药物的标志案例' },
      { title: '治理护航', desc: '隐私、公平、监管并进' },
    ],
    note: '2026 · AI × Healthcare',
  },
];

build({ theme: 'midnight', title: 'AI × 医疗：技术驱动，临床落地', footerLabel: 'AI × 医疗', slides, out, useImages: true })
  .catch((e) => { console.error('BUILD FAILED:', e); process.exit(1); });
