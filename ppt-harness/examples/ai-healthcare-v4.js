// v4: systemic image model — every multi-item grid (iconGrid/quadrant/future) gives EACH card
// its own relevant image by default (query from card.img || card.title); no more "one side image
// for many items". Images are center-cropped to exact ratio (never stretched/squished).
// Run: node examples/ai-healthcare-v4.js

const path = require('path');
const { build } = require('../harness');
const out = path.join(__dirname, 'output', 'ai-healthcare-v4.pptx');

const slides = [
  {
    t: 'cover',
    eyebrow: 'AI × HEALTHCARE',
    title: 'AI 在医疗领域的应用',
    subtitle: '技术驱动 · 精准诊疗 · 守护健康',
    intro: '从医学影像到药物研发，从精准医疗到健康管理，AI 正在重塑诊疗的每一个环节。',
    img: 'medical artificial intelligence technology',
    chips: [{ k: '更准', d: '诊断与疗效' }, { k: '更快', d: '研发与响应' }, { k: '更普惠', d: '触达更多患者' }],
    meta: '2026 · 行业洞察报告',
  },
  {
    t: 'agenda', eyebrow: '01 · 导览', title: '内容导航',
    sub: '六个章节，看清 AI 如何渗透医疗的全流程。',
    items: [
      { title: '行业背景与关键数字', desc: '市场规模、效率提升与渗透率' },
      { title: '六大核心应用场景', desc: '从影像、研发到健康管理的版图' },
      { title: '医学影像 × 计算机视觉', desc: 'AI 的主战场与准确率' },
      { title: '代表性产品与案例', desc: '已落地的明星项目一览表' },
      { title: '临床落地路径', desc: '从数据到床旁的五步闭环' },
      { title: '挑战、治理与未来', desc: '隐私、公平与下一程趋势' },
    ],
  },
  {
    t: 'stats', eyebrow: '02 · 背景', title: 'AI 医疗的关键数字',
    sub: '一组数字看清 AI 在医疗行业中的位置。',
    stats: [
      { big: '$450亿', label: '2025 全球 AI 医疗市场', sub: '十年间规模增长超 10 倍' },
      { big: '>95%', label: '影像 AI 筛查敏感度', sub: '肺结节、眼底等主力任务' },
      { big: '+40%', label: '医生读片效率提升', sub: 'AI 辅助下的平均增益' },
    ],
    cols: [
      { title: '核心驱动力', bullets: ['医疗数据持续爆发式增长', '算力与深度学习突破', '医疗资源不均与效率压力'] },
      { title: '释放的价值', bullets: ['诊断更快、更准、更一致', '研发周期与成本双下降', '优质医疗下沉到基层'] },
    ],
    note: '数据为行业综合估算，仅供示意。',
  },
  {
    t: 'iconGrid', eyebrow: '03 · 应用', title: '六大核心应用场景',
    sub: 'AI 在医疗的六个主力场景，覆盖诊前、诊中与诊后。',
    cards: [
      { icon: 'lu/LuScanLine', title: '医学影像', desc: 'X 光 / CT / MRI / 病理自动识别与量化', img: 'x ray ct scan medical imaging' },
      { icon: 'lu/LuStethoscope', title: '疾病早筛', desc: '风险建模与大规模早期筛查', img: 'medical health checkup screening' },
      { icon: 'lu/LuFlaskConical', title: '药物研发', desc: '靶点发现与虚拟化合物筛选', img: 'pharmaceutical drug research laboratory' },
      { icon: 'lu/LuDna', title: '精准医疗', desc: '基因组解读与个体化治疗方案', img: 'dna genome sequencing lab' },
      { icon: 'lu/LuBot', title: '辅助诊疗', desc: '临床决策支持与虚拟问诊', img: 'doctor computer clinical decision support' },
      { icon: 'lu/LuHeartPulse', title: '健康管理', desc: '可穿戴设备与慢病持续随访', img: 'smartwatch fitness health tracking' },
    ],
  },
  {
    t: 'chart', eyebrow: '04 · 影像', title: '医学影像：AI 的准确率表现',
    sub: '在主力影像任务上，AI 已达到或超过专家平均水平。',
    lead: 'AI 通过深度学习自动识别影像中的异常征象，承担检出、分割、量化与排序，显著降低漏诊。',
    bullets: ['肺结节、眼底、乳腺病灶自动检出', '病理切片自动分级与定量', '按紧急度排序，危重病例优先'],
    stat: { big: '> 95%', desc: '肺结节检出敏感度，读片效率显著提升' },
    chart: { title: 'AI 在主要影像任务中的准确率', cats: ['肺结节', '眼底', '乳腺', '皮肤', '病理'], vals: [96, 94, 93, 91, 95], suffix: '%', color: '2DBE9E', max: 100, step: 20, yTitle: '准确率 (%)' },
    note: '数据为公开研究综合示意，具体数值因数据集而异。',
  },
  {
    t: 'twoCol', eyebrow: '04 · 影像', title: '医学影像 × 计算机视觉',
    sub: '计算机视觉让 AI 成为医生的"第二双眼睛"。',
    img: 'ct mri radiology brain scan',
    caption: '影像 AI 已在肺结节、眼底、乳腺、病理等任务上达到或超过专家水平。',
    left: {
      title: '从检出到决策支持',
      lead: 'AI 自动完成检出、分割、量化与优先级排序，把医生从海量读片中解放出来。',
      bullets: ['病灶自动检出与定位', '器官与病灶分割及定量', '紧急度排序，危重优先', '降低漏诊、缓解读片负荷'],
    },
  },
  {
    t: 'table', eyebrow: '05 · 案例', title: '代表性 AI 医疗产品与案例',
    sub: '一批已落地或接近落地的明星项目，勾勒 AI 医疗的真实版图。',
    columns: [
      { header: '产品 / 项目', key: 'name', w: 0.26 },
      { header: '领域', key: 'field', w: 0.16 },
      { header: '核心能力', key: 'cap', w: 0.38 },
      { header: '状态', key: 'status', w: 0.20, align: 'center' },
    ],
    rows: [
      { name: { text: 'AlphaFold', bold: true, color: '157F8B' }, field: '结构/药物', cap: '蛋白质结构预测，2 亿+ 结构', status: { text: '开源', color: '2DBE9E', bold: true } },
      { name: { text: 'IDx-DR', bold: true, color: '157F8B' }, field: '眼科', cap: '糖尿病视网膜病变自主筛查', status: { text: 'FDA 批准', color: '2DBE9E', bold: true } },
      { name: { text: '达芬奇', bold: true, color: '157F8B' }, field: '外科', cap: '机器人辅助微创手术系统', status: '临床广泛应用' },
      { name: { text: '肺结节 AI', bold: true, color: '157F8B' }, field: '影像', cap: 'CT 肺结节自动检出与分级', status: 'NMPA 三类证' },
      { name: { text: 'Watson Oncology', bold: true, color: '157F8B' }, field: '肿瘤', cap: '循证治疗方案推荐', status: '多中心部署' },
      { name: { text: 'Med-PaLM 2', bold: true, color: '157F8B' }, field: '大模型', cap: '医学问答与临床推理', status: { text: '研究中', color: 'F2B05E', bold: true } },
    ],
    note: '信息为公开资料整理，截至 2026 年。',
  },
  {
    t: 'flow', eyebrow: '06 · 落地', title: '临床落地五步闭环',
    sub: '从模型到床旁的标准化路径，决定 AI 能否真正进入临床。',
    stats: [{ big: '5 步', label: '从研发到临床的标准路径' }, { big: '三类证', label: 'NMPA 高风险 AI 医械门槛' }],
    heading: '从模型到床旁的闭环',
    steps: [
      { icon: 'lu/LuDatabase', title: '数据治理', desc: '合规、多中心、高质量数据' },
      { icon: 'lu/LuBrainCircuit', title: '模型训练', desc: '领域微调与鲁棒性验证' },
      { icon: 'lu/LuClipboardCheck', title: '临床验证', desc: '多中心前瞻性对比试验' },
      { icon: 'lu/LuShieldCheck', title: '审批准入', desc: '监管认证与责任界定' },
      { icon: 'lu/LuActivity', title: '部署监测', desc: '持续监测、迭代与召回' },
    ],
    note: '不同风险等级对应不同的审批路径与周期。',
  },
  {
    t: 'quadrant', eyebrow: '07 · 治理', title: '挑战与治理',
    sub: '技术之外，治理决定 AI 医疗能走多远。',
    cards: [
      { icon: 'lu/LuLock', title: '数据隐私', desc: '患者数据高度敏感，需脱敏、授权与安全治理', img: 'cybersecurity data protection lock' },
      { icon: 'lu/LuScale', title: '算法公平', desc: '训练偏倚导致跨人群、跨机构性能不一', img: 'diverse people team inclusion' },
      { icon: 'lu/LuEye', title: '可解释性', desc: '黑箱决策影响医生信任与临床采纳', img: 'magnifying glass analysis research' },
      { icon: 'lu/LuShieldCheck', title: '监管合规', desc: '准入标准、临床路径与责任归属待完善', img: 'legal compliance law document' },
    ],
  },
  {
    t: 'future', eyebrow: '08 · 展望', title: '未来三大趋势',
    sub: '三个方向，重塑医疗的下一个十年。',
    cards: [
      { icon: 'lu/LuSparkles', title: '医疗大模型', desc: '多模态通用医学智能，一次训练、多场景复用，大幅降低落地成本。', img: 'artificial intelligence neural network' },
      { icon: 'lu/LuBot', title: 'AI 医生伙伴', desc: '从单点辅助走向覆盖诊前、诊中、诊后的全流程诊疗协作。', img: 'robot medical assistant doctor' },
      { icon: 'lu/LuAtom', title: 'AI × 生命科学', desc: '与蛋白质设计、基因编辑、新药发现深度融合，重构科研范式。', img: 'dna molecule biology science' },
    ],
  },
  {
    t: 'closing',
    eyebrow: '结语',
    title: 'AI 正在把医疗带入新范式',
    sub: '技术就绪、场景落地、治理护航——三者并举，AI 才能真正惠及每一个人。',
    take: [
      { title: '更准', desc: '诊断准确度与疗效持续提升' },
      { title: '更快', desc: '研发与临床响应全面提速' },
      { title: '更普惠', desc: '优质医疗触达更多患者' },
    ],
    note: '2026 · AI × Healthcare',
  },
];

build({ theme: 'healthcare', title: 'AI 在医疗领域的应用', footerLabel: 'AI 在医疗领域的应用', slides, out, useImages: true })
  .catch((e) => { console.error('BUILD FAILED:', e); process.exit(1); });
