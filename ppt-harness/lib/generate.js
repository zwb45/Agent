// generate.js — outline → slides compiler.
// Lets an LLM (or a human) write a SHORT outline ({topic, sections}) and get back a
// complete, valid slides array that build() accepts. The compiler does the tedious parts:
//   - auto-generates cover / agenda / closing from the topic when not given explicitly
//   - picks a react-icon for every card/step from a CN+EN keyword table
//   - derives an English stock-photo query for every card image (Pexels likes English)
//   - numbers content-page eyebrows (01 ·, 02 · …) and assigns stable ids for apply_edits
// Full pre-written slide specs are also accepted (pass-through) so terse + detailed can mix.

const schema = require('./schema');

// ---- keyword tables (ordered; first substring match wins) ----
// Each row: [ [keywords...], value ]. Keywords are matched case-insensitively against the
// concatenated title+desc text. CN and EN both supported.
const ICON_KEYS = [
  [['影像', '放射', 'x光', 'x射线', 'ct', 'mri', 'scan', 'xray', 'radiolog', '扫描', '超声', '病理切片', '筛查', '早筛', '诊断', '检测', '识别'], 'lu/LuScanLine'],
  [['听诊', '医师', '临床', '诊疗', '问诊', 'doctor', 'physician', 'clinical', 'stethoscope', 'hospital', '医院'], 'lu/LuStethoscope'],
  [['药', '制药', '靶点', '化合物', '试剂', 'drug', 'pharma', 'medic', 'flask', 'lab', '实验室'], 'lu/LuFlaskConical'],
  [['基因', 'dna', '基因组', '测序', '蛋白', 'gene', 'genom', 'protein', '生物'], 'lu/LuDna'],
  [['数据集', '大数据', '数据库', '数据', '存储', 'database', 'dataset', 'storage'], 'lu/LuDatabase'],
  [['大脑', '智能', '认知', 'ai', '人工智能', '模型', '深度学习', '机器学习', 'brain', 'neural', 'llm', 'gpt', 'intelligence', '算法'], 'lu/LuBrain'],
  [['机器人', '助手', '自动化', '智能体', 'bot', 'robot', 'agent', 'assistant'], 'lu/LuBot'],
  [['安全', '隐私', '加密', '合规', 'security', 'privacy', 'lock', 'shield', 'compliance', '加密'], 'lu/LuShieldCheck'],
  [['目标', '指标', 'kpi', 'goal', 'target', 'aim', '精准', '个体化', '定制'], 'lu/LuTarget'],
  [['增长', '趋势', '上升', '投资', '收入', 'trend', 'growth', 'invest', 'revenue'], 'lu/LuTrendingUp'],
  [['健康', '心率', '可穿戴', '医疗保健', 'heart', 'health', 'wellness', 'wearable'], 'lu/LuHeartPulse'],
  [['检查', '审核', '清单', '质检', 'check', 'audit', 'review', 'inspect'], 'lu/LuClipboardCheck'],
  [['眼', '视觉', '眼科', 'eye', 'vision', 'sight'], 'lu/LuEye'],
  [['语言', '翻译', '多语言', '自然语言', 'language', 'nlp', 'translation'], 'lu/LuLanguages'],
  [['活动', '运动', 'activity', 'motion'], 'lu/LuActivity'],
  [['原子', '分子', '物理', 'atom', 'molecule', 'science', '科学'], 'lu/LuAtom'],
  [['芯片', '算力', 'cpu', 'gpu', '计算', 'chip', 'compute', 'processor'], 'lu/LuCpu'],
  [['电路', '硬件', '主板', 'circuit', 'hardware', 'board'], 'lu/LuCircuitBoard'],
  [['创新', '火花', '亮点', 'spark', 'innovation', 'creative'], 'lu/LuSparkles'],
  [['公平', '天平', '平衡', '伦理', 'scale', 'fair', 'balance', 'ethics'], 'lu/LuScale'],
  [['消息', '沟通', '聊天', '对话', 'message', 'chat', 'communic'], 'lu/LuMessageSquare'],
  [['文件', '报告', '文档', 'report', 'file', 'document'], 'lu/LuFileText'],
  [['发射', '火箭', '启动', 'rocket', 'launch', 'start'], 'lu/LuRocket'],
  [['想法', '灯泡', '建议', '提示', 'lightbulb', 'idea', 'tip'], 'lu/LuLightbulb'],
  [['用户', '人群', '团队', '客户', 'user', 'people', 'team', 'customer'], 'lu/LuUsers'],
  [['全球', '世界', '国际化', 'globe', 'global', 'world'], 'lu/LuGlobe'],
  [['时间', '时钟', '效率', '时效', 'clock', 'time', 'schedule'], 'lu/LuClock'],
  [['图表', '分析', 'chart', 'analytic'], 'lu/LuChartLine'],
  [['奖项', '荣誉', '奖杯', 'award', 'honor', 'reward'], 'lu/LuAward'],
  [['闪电', '能量', '快速', 'zap', 'energy', 'fast'], 'lu/LuZap'],
  [['设置', '配置', '工具', 'gear', 'setting', 'config'], 'lu/LuSettings'],
  [['王冠', '旗舰', '高级', 'crown', 'premium'], 'lu/LuCrown'],
  [['网络', '连接', '链接', 'network', 'connect', 'link'], 'lu/LuNetwork'],
  [['层', '架构', 'stack', 'layer', 'architect'], 'lu/LuLayers'],
  [['公文', '商务', '办公', '工作', 'briefcase', 'business', 'work'], 'lu/LuBriefcase'],
  [['教育', '学习', '学院', '培训', 'edu', 'learn', 'training', 'student'], 'lu/LuGraduationCap'],
  [['钱', '成本', '价格', '金融', 'dollar', 'money', 'cost', 'price', 'finance'], 'lu/LuDollarSign'],
  [['仪表', '监控', '性能', 'gauge', 'monitor', 'metric'], 'lu/LuGauge'],
  // ---- general business / industry domains (keeps the harness topic-agnostic) ----
  [['汽车', '车辆', '新能源车', '电动车', '驾驶', '出行', '交通', 'car', 'vehicle', 'auto', 'driv'], 'lu/LuCar'],
  [['自动驾驶', '无人驾驶', 'autonomous', 'self-driving'], 'lu/LuCpu'],
  [['电池', '续航', '充电', '快充', '高压', '储能', 'battery', 'charge'], 'lu/LuBatteryCharging'],
  [['碳排放', '环保', '绿色', '低碳', '可持续', 'carbon', 'green', 'sustain', 'esg'], 'lu/LuLeaf'],
  [['太阳能', '光伏', '风能', '风电', '清洁能源', 'solar', 'wind'], 'lu/LuSun'],
  [['供应链', '物流', '仓储', '配送', 'supply', 'logistic', 'warehouse'], 'lu/LuTruck'],
  [['制造', '工厂', '生产', '产线', 'manufact', 'factory', '生产'], 'lu/LuFactory'],
  [['电机', '电驱', '驱动', '引擎', '机械', '齿轮', 'engine', 'motor', 'gear'], 'lu/LuCog'],
  [['营销', '品牌', '推广', '广告', 'marketing', 'brand', 'advertis'], 'lu/LuMegaphone'],
  [['市场', '份额', '竞争', '格局', 'market', 'share', 'compet'], 'lu/LuChartPie'],
  [['融资', '估值', '资本', '上市', '注资', 'fund', 'valuation', 'ipo'], 'lu/LuLandmark'],
  [['销售', '营收', '收入', '利润', '毛利', 'sales', 'revenue', 'profit', 'margin'], 'lu/LuDollarSign'],
  [['战略', '规划', '路线图', 'strategy', 'roadmap'], 'lu/LuCompass'],
  [['质量', '品质', 'quality', '卓越'], 'lu/LuAward'],
];
const DEFAULT_ICON = 'lu/LuSparkles';

// CN keyword → English photo search query (Pexels/Unsplash return better results in English).
const IMG_KEYS = [
  [['影像', '放射', 'ct', 'mri', 'x光', '超声', '病理'], 'x ray ct mri medical imaging'],
  [['医生', '医院', '临床', '诊疗', '听诊', '问诊'], 'doctor hospital medical care'],
  [['疾病', '早筛', '筛查', '诊断', '检测', '患病'], 'disease medical screening diagnosis'],
  [['精准', '个体化', '医疗', '治疗', '诊疗', '康复'], 'precision medicine treatment healthcare'],
  [['药', '制药', '靶点', '化合物', '研发', '试剂'], 'pharmaceutical drug research laboratory'],
  [['基因', 'dna', '基因组', '测序', '蛋白'], 'dna genome sequencing biotech'],
  [['数据', '大数据', '数据库'], 'data server technology'],
  [['智能', 'ai', '人工智能', '模型', '算法'], 'artificial intelligence technology'],
  [['健康', '心率', '可穿戴', '保健'], 'health wellness fitness wearable'],
  [['安全', '隐私', '加密', '合规'], 'cybersecurity lock privacy'],
  [['眼', '眼科', '视觉'], 'eye vision ophthalmology'],
  [['机器人', '自动化', '智能体'], 'robotics automation technology'],
  [['芯片', '算力', '计算', 'gpu'], 'microchip cpu computing'],
  [['用户', '团队', '客户', '人群'], 'team people office meeting'],
  [['全球', '世界', '国际'], 'earth globe global network'],
  [['教育', '学习', '培训', '学生'], 'education learning students'],
  [['钱', '成本', '收入', '金融', '投资'], 'finance money business chart'],
  [['创新', '创意'], 'innovation creative abstract'],
  [['网络', '连接', '物联网'], 'network connection technology'],
  [['能源', '电力', '光伏', '风能'], 'renewable energy power'],
  // ---- general business / industry domains (English queries for better stock results) ----
  [['汽车', '车辆', '电动车', '新能源车', '出行', '驾驶', 'car', 'vehicle', 'ev '], 'electric car automotive industry'],
  [['电池', '续航', '充电', '快充', '高压', '储能', 'battery', 'charge'], 'battery charging energy storage'],
  [['自动驾驶', '无人驾驶', 'autonomous', 'self-driving'], 'autonomous self driving car technology'],
  [['碳排放', '环保', '绿色', '低碳', '可持续', 'carbon', 'green', 'esg'], 'green sustainability nature environment'],
  [['太阳能', '光伏', '风能', '风电', 'solar', 'wind'], 'solar panel wind turbine renewable energy'],
  [['供应链', '物流', '仓储', '配送', 'supply', 'logistic', 'warehouse'], 'supply chain logistics warehouse'],
  [['制造', '工厂', '生产', '产线', '制造', '驱动', '电机', 'manufact', 'factory'], 'factory manufacturing production line'],
  [['营销', '品牌', '推广', '广告', 'marketing', 'brand', 'advertis'], 'marketing brand strategy business'],
  [['市场', '份额', '竞争', '格局', 'market', 'share', 'compet'], 'business market growth chart'],
  [['融资', '估值', '资本', '上市', '注资', 'fund', 'valuation', 'ipo'], 'finance investment business meeting'],
  [['销售', '营收', '收入', '利润', 'sales', 'revenue', 'profit'], 'business revenue sales growth'],
  [['战略', '规划', '路线图', 'strategy', 'roadmap'], 'business strategy planning whiteboard'],
  [['航空', '航班', '飞机', 'airline', 'flight', 'aviation'], 'airplane aviation airport'],
  [['零售', '门店', '电商', '购物', 'retail', 'shop', 'ecommerce'], 'retail store shopping'],
];
const DEFAULT_IMG = 'abstract technology background';

const KIND_LABEL = {
  stats: '背景', iconGrid: '应用', chart: '数据', flow: '流程', pipeline: '路径',
  twoCol: '详解', quadrant: '维度', future: '展望', table: '案例', divider: '章节',
};
const CONTENT_KINDS = ['stats', 'iconGrid', 'chart', 'flow', 'pipeline', 'twoCol', 'quadrant', 'future', 'table'];

function pickIcon(text, fallback) {
  const t = String(text || '').toLowerCase();
  for (const [keys, icon] of ICON_KEYS) if (keys.some((k) => t.includes(k.toLowerCase()))) return icon;
  return fallback || DEFAULT_ICON;
}
function imgQuery(text, topicImg) {
  const t = String(text || '');
  const tl = t.toLowerCase();
  for (const [keys, q] of IMG_KEYS) if (keys.some((k) => tl.includes(k.toLowerCase()))) return q;
  // strip punctuation as a last resort; fall back to the deck-level topic image query
  const cleaned = t.replace(/[，。、·:：；；,—–\-\s]+/g, ' ').trim();
  return cleaned || topicImg || DEFAULT_IMG;
}

// Expand a terse item (string | {title,desc?,icon?,img?,color?,n?}) into a full card/step.
function expandItem(it, topicImg, defaultIcon) {
  if (it == null) return null;
  if (typeof it === 'string') it = { title: it };
  const title = it.title || '';
  const out = {
    icon: it.icon || pickIcon(title + ' ' + (it.desc || ''), defaultIcon),
    title,
    desc: it.desc != null ? it.desc : '',
  };
  if (it.img != null) out.img = it.img;
  else out.img = imgQuery(title, topicImg);
  if (it.color != null) out.color = it.color;
  if (it.n != null) out.n = it.n;
  return out;
}

// Ensure every slide has a stable id (s1, s2, …) so apply_edits can target it.
function assignIds(slides) {
  let n = 0;
  const seen = new Set();
  for (const s of slides) {
    if (!s.id || seen.has(s.id)) { n++; s.id = 's' + n; }
    seen.add(s.id);
  }
  return slides;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Compile an outline into a full slides array.
 * outline: {
 *   topic, subtitle?, meta?, theme?, footerLabel?, coverImg?, closingTitle?, closingSub?, closingThanks?,
 *   sections: [ {kind, title, ...} | "divider title" ]   // OR
 *   slides:  [ {full slide spec}, ... ]                   // pass-through mode
 * }
 */
function outlineToSlides(outline) {
  outline = outline || {};
  const topic = outline.topic || '演示文稿';
  const topicImg = outline.coverImg || imgQuery(topic, DEFAULT_IMG);

  // ---- pass-through mode: full specs already given ----
  if (Array.isArray(outline.slides)) return assignIds(outline.slides.map((s) => Object.assign({}, s)));

  const sections = Array.isArray(outline.sections) ? outline.sections : [];

  // Build slides from sections (auto agenda + eyebrow numbering happen after the map).
  const built = sections.map((sec) => {
    if (typeof sec === 'string') sec = { kind: 'divider', title: sec };
    const kind = sec.kind || 'iconGrid';
    const title = sec.title != null ? sec.title : (kind === 'closing' ? '' : topic);
    const slide = Object.assign({}, sec);
    slide.t = kind;
    delete slide.kind;
    if (title != null) slide.title = title;

    if (kind === 'cover') {
      if (!slide.title || slide.title === topic) slide.title = topic;
      if (slide.img == null && outline.coverImg == null) slide.img = topicImg;
    } else if (kind === 'closing') {
      if (!slide.title) slide.title = outline.closingTitle || (topic + ' · 总结');
      if (slide.thanks == null) slide.thanks = outline.closingThanks || '谢谢观看 · Thank You';
      if (slide.sub == null && outline.closingSub) slide.sub = outline.closingSub;
    } else if (kind === 'agenda') {
      // items filled below (need sibling titles) — leave a marker
      slide._autoAgenda = !Array.isArray(slide.items);
      if (slide.title == null) slide.title = '内容导航';
    } else if (kind === 'iconGrid' || kind === 'quadrant' || kind === 'future') {
      const src = Array.isArray(slide.items) ? slide.items : (Array.isArray(slide.cards) ? slide.cards : []);
      slide.cards = src.map((it) => expandItem(it, topicImg));
      delete slide.items;
    } else if (kind === 'flow') {
      const src = Array.isArray(slide.items) ? slide.items : (Array.isArray(slide.steps) ? slide.steps : []);
      slide.steps = src.map((it) => expandItem(it, topicImg));
      delete slide.items;
    } else if (kind === 'pipeline') {
      const src = Array.isArray(slide.items) ? slide.items : (Array.isArray(slide.phases) ? slide.phases : []);
      slide.phases = src.map((it) => {
        const e = expandItem(it, topicImg); delete e.img; return e; // phases have no image
      });
      delete slide.items;
    } else if (kind === 'chart') {
      // hoist cats/vals/suffix/etc into a chart{} sub-object if given flat.
      // NOTE: the slide title and the chart's own title are distinct — slide.title stays,
      // a flat `chartTitle` becomes chart.title.
      if (!slide.chart) {
        slide.chart = {};
        for (const k of ['cats', 'vals', 'suffix', 'dataLabelFmt', 'color', 'max', 'min', 'step', 'gap', 'xTitle', 'yTitle', 'seriesName']) {
          if (slide[k] != null) { slide.chart[k] = slide[k]; delete slide[k]; }
        }
        if (slide.chartTitle != null) { slide.chart.title = slide.chartTitle; delete slide.chartTitle; }
      }
    }
    // stats / table / twoCol / divider / explicit agenda pass through unchanged
    return slide;
  });

  // ---- auto cover (if first section isn't one) ----
  if (!built.length || built[0].t !== 'cover') {
    built.unshift({ t: 'cover', title: topic, subtitle: outline.subtitle || '', img: topicImg, meta: outline.meta || '' });
  } else if (built[0].subtitle == null && outline.subtitle) built[0].subtitle = outline.subtitle;
  if (built[0].meta == null && outline.meta) built[0].meta = outline.meta;

  // ---- auto agenda (first agenda section with no items, or none at all) ----
  const titlesForAgenda = built.filter((s) => CONTENT_KINDS.includes(s.t)).map((s) => ({
    title: s.title || '',
    desc: (s.sub || s.lead || '').toString().slice(0, 40),
  }));
  let agenda = built.find((s) => s.t === 'agenda');
  if (!agenda && titlesForAgenda.length >= 3) {
    agenda = { t: 'agenda', title: '内容导航', _autoAgenda: true };
    built.splice(1, 0, agenda); // right after cover
  }
  if (agenda && agenda._autoAgenda) {
    agenda.items = titlesForAgenda;
    delete agenda._autoAgenda;
  }

  // ---- auto closing (if last section isn't one) ----
  if (!built.length || built[built.length - 1].t !== 'closing') {
    built.push({ t: 'closing', title: outline.closingTitle || (topic + ' · 总结'), thanks: outline.closingThanks || '谢谢观看 · Thank You' });
  }

  // ---- number content-page eyebrows ----
  let n = 0;
  for (const s of built) {
    if (!CONTENT_KINDS.includes(s.t)) continue;
    if (s.eyebrow == null) {
      n++;
      s.eyebrow = `${pad2(n)} · ${s.tag || KIND_LABEL[s.t] || s.t}`;
    }
    delete s.tag;
  }

  return assignIds(built);
}

module.exports = { outlineToSlides, pickIcon, imgQuery, expandItem, assignIds, ICON_KEYS, IMG_KEYS, KIND_LABEL, CONTENT_KINDS };
