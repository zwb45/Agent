// _build_test.js — builds a 12-page test deck with varying whitespace for human eval.
const { build } = require('./harness');

const slides = [
  // 1. CLEAN: 3 full cards with images
  { t:'free', role:'content', bg:'offWhite', title:'三大核心技术方向', eyebrow:'01', elements:[
    {k:'rrect',x:0.6,y:2.3,w:3.8,h:4.4,fill:'white',shadow:true},
    {k:'image',x:0.6,y:2.3,w:3.8,h:1.6,q:'large language model AI brain'},
    {k:'fit',x:0.85,y:4.05,w:3.3,h:0.5,text:'大语言模型',min:16,max:20,bold:true,color:'ink'},
    {k:'bullets',x:0.85,y:4.6,w:3.3,h:1.9,items:['GPT-5 多模态推理','参数效率提升10倍','开源追赶'],min:11,max:14,color:'slate'},
    {k:'rrect',x:4.96,y:2.3,w:3.8,h:4.4,fill:'white',shadow:true},
    {k:'image',x:4.96,y:2.3,w:3.8,h:1.6,q:'robot embodied AI automation'},
    {k:'fit',x:5.21,y:4.05,w:3.3,h:0.5,text:'具身智能',min:16,max:20,bold:true,color:'ink'},
    {k:'bullets',x:5.21,y:4.6,w:3.3,h:1.9,items:['人形机器人量产','工厂场景落地','成本降至20万'],min:11,max:14,color:'slate'},
    {k:'rrect',x:9.32,y:2.3,w:3.8,h:4.4,fill:'white',shadow:true},
    {k:'image',x:9.32,y:2.3,w:3.8,h:1.6,q:'AI chip semiconductor computing'},
    {k:'fit',x:9.57,y:4.05,w:3.3,h:0.5,text:'算力基础设施',min:16,max:20,bold:true,color:'ink'},
    {k:'bullets',x:9.57,y:4.6,w:3.3,h:1.9,items:['国产GPU突破','算力成本下降40%','边缘推理普及'],min:11,max:14,color:'slate'},
  ]},
  // 2. CLEAN: text + image two columns
  { t:'free', role:'content', bg:'offWhite', title:'市场规模与增长', eyebrow:'02', elements:[
    {k:'rrect',x:0.6,y:2.3,w:6.5,h:4.4,fill:'white',shadow:true},
    {k:'fit',x:0.9,y:2.55,w:5.8,h:0.6,text:'全球AI市场预测',min:18,max:24,bold:true,color:'ink'},
    {k:'bullets',x:0.9,y:3.3,w:5.8,h:3.2,items:['2025年全球AI市场规模4500亿美元','年复合增长率37%，远超传统软件','中国份额从12%提升至20%','企业级应用支出增长52%','生成式AI占比超40%'],min:12,max:15,color:'slate'},
    {k:'image',x:7.4,y:2.3,w:5.3,h:4.4,q:'artificial intelligence market growth chart'},
  ]},
  // 3. BLANK: small card, rest empty
  { t:'free', role:'content', bg:'offWhite', title:'技术挑战', eyebrow:'03', elements:[
    {k:'rrect',x:0.6,y:2.3,w:3.0,h:1.5,fill:'white',shadow:true},
    {k:'fit',x:0.8,y:2.5,w:2.6,h:0.4,text:'算力瓶颈',min:14,max:18,bold:true,color:'ink'},
    {k:'fit',x:0.8,y:2.9,w:2.6,h:0.7,text:'训练成本高',min:11,max:14,color:'slate'},
  ]},
  // 4. BLANK: top content, bottom empty
  { t:'free', role:'content', bg:'offWhite', title:'产业生态', eyebrow:'04', elements:[
    {k:'rrect',x:0.6,y:2.3,w:12.1,h:2.0,fill:'white',shadow:true},
    {k:'fit',x:0.9,y:2.5,w:11,h:0.5,text:'从模型到应用的完整生态',min:18,max:22,bold:true,color:'ink'},
    {k:'bullets',x:0.9,y:3.1,w:11,h:1.0,items:['模型层：OpenAI / Google / 百度','平台层：Hugging Face / ModelScope','应用层：Cursor / Copilot / 钉钉'],min:11,max:14,color:'slate'},
  ]},
  // 5. BLANK: left content, right empty
  { t:'free', role:'content', bg:'offWhite', title:'政策监管', eyebrow:'05', elements:[
    {k:'rrect',x:0.6,y:2.3,w:5.5,h:4.4,fill:'white',shadow:true},
    {k:'fit',x:0.85,y:2.55,w:5,h:0.5,text:'全球AI监管框架',min:16,max:20,bold:true,color:'ink'},
    {k:'bullets',x:0.85,y:3.2,w:5,h:3.2,items:['欧盟AI Act分级监管','美国行政令安全测试','中国生成式AI管理办法','各国聚焦隐私透明'],min:12,max:14,color:'slate'},
  ]},
  // 6. SUBTLE: big card only title (thin block)
  { t:'free', role:'content', bg:'offWhite', title:'标杆案例', eyebrow:'06', elements:[
    {k:'rrect',x:2,y:2.8,w:9,h:3.5,fill:'white',shadow:true},
    {k:'fit',x:2.3,y:3.1,w:8,h:0.6,text:'ChatGPT月活突破5亿',min:20,max:28,bold:true,color:'ink'},
  ]},
  // 7. COVER
  { t:'cover', title:'2025 AI发展趋势', subtitle:'技术突破 产业变革', meta:'2025 行业洞察' },
  // 8. CLOSING
  { t:'closing', title:'AI重塑千行百业', thanks:'谢谢观看' },
  // 9. CLEAN: 2x2 grid
  { t:'free', role:'content', bg:'offWhite', title:'四大应用场景', eyebrow:'07', elements:[
    {k:'rrect',x:0.6,y:2.3,w:5.9,h:2.1,fill:'white',shadow:true},
    {k:'icon',x:0.9,y:2.55,d:0.6,spec:'lu/LuBrain',bg:'primary',color:'white'},
    {k:'fit',x:1.7,y:2.5,w:4.5,h:0.5,text:'智能客服',min:15,max:18,bold:true,color:'ink'},
    {k:'fit',x:1.7,y:3.0,w:4.5,h:1.2,text:'7x24多语言，准确率95%',min:11,max:13,color:'slate',valign:'top'},
    {k:'rrect',x:6.8,y:2.3,w:5.9,h:2.1,fill:'white',shadow:true},
    {k:'icon',x:7.1,y:2.55,d:0.6,spec:'lu/LuFileText',bg:'mint',color:'white'},
    {k:'fit',x:7.9,y:2.5,w:4.5,h:0.5,text:'文档生成',min:15,max:18,bold:true,color:'ink'},
    {k:'fit',x:7.9,y:3.0,w:4.5,h:1.2,text:'合同报告自动撰写，效率10倍',min:11,max:13,color:'slate',valign:'top'},
    {k:'rrect',x:0.6,y:4.6,w:5.9,h:2.1,fill:'white',shadow:true},
    {k:'icon',x:0.9,y:4.85,d:0.6,spec:'lu/LuCode2',bg:'coral',color:'white'},
    {k:'fit',x:1.7,y:4.8,w:4.5,h:0.5,text:'代码辅助',min:15,max:18,bold:true,color:'ink'},
    {k:'fit',x:1.7,y:5.3,w:4.5,h:1.2,text:'AI结对编程，效率提升55%',min:11,max:13,color:'slate',valign:'top'},
    {k:'rrect',x:6.8,y:4.6,w:5.9,h:2.1,fill:'white',shadow:true},
    {k:'icon',x:7.1,y:4.85,d:0.6,spec:'lu/LuImage',bg:'amber',color:'white'},
    {k:'fit',x:7.9,y:4.8,w:4.5,h:0.5,text:'创意设计',min:15,max:18,bold:true,color:'ink'},
    {k:'fit',x:7.9,y:5.3,w:4.5,h:1.2,text:'文生图视频，分钟级产出',min:11,max:13,color:'slate',valign:'top'},
  ]},
  // 10. SUBTLE: two cards with gap (medium gap between top, empty bottom)
  { t:'free', role:'content', bg:'offWhite', title:'投资融资', eyebrow:'08', elements:[
    {k:'rrect',x:0.6,y:2.3,w:5.5,h:2.0,fill:'white',shadow:true},
    {k:'fit',x:0.85,y:2.5,w:5,h:0.5,text:'2024融资概况',min:16,max:20,bold:true,color:'ink'},
    {k:'bullets',x:0.85,y:3.1,w:5,h:1.0,items:['全球AI融资1200亿','生成式AI占比60%'],min:11,max:14,color:'slate'},
    {k:'rrect',x:7.2,y:2.3,w:5.5,h:2.0,fill:'white',shadow:true},
    {k:'fit',x:7.45,y:2.5,w:5,h:0.5,text:'估值TOP5',min:16,max:20,bold:true,color:'ink'},
    {k:'bullets',x:7.45,y:3.1,w:5,h:1.0,items:['OpenAI 1570亿','Anthropic 400亿'],min:11,max:14,color:'slate'},
  ]},
  // 11. BLANK: one small image in corner
  { t:'free', role:'content', bg:'offWhite', title:'未来展望', eyebrow:'09', elements:[
    {k:'image',x:9.5,y:5.5,w:3.2,h:1.4,q:'futuristic AI concept technology'},
  ]},
  // 12. CLEAN: dense 3-column cards
  { t:'free', role:'content', bg:'offWhite', title:'总结建议', eyebrow:'10', elements:[
    {k:'rrect',x:0.6,y:2.3,w:3.8,h:4.4,fill:'white',shadow:true},
    {k:'icon',x:0.9,y:2.55,d:0.55,spec:'lu/LuTarget',bg:'primary',color:'white'},
    {k:'fit',x:1.65,y:2.5,w:2.5,h:0.5,text:'战略聚焦',min:14,max:18,bold:true,color:'ink'},
    {k:'bullets',x:0.85,y:3.2,w:3.3,h:3.3,items:['选定1-2个场景','构建数据飞轮','组建AI团队'],min:11,max:13,color:'slate'},
    {k:'rrect',x:4.96,y:2.3,w:3.8,h:4.4,fill:'white',shadow:true},
    {k:'icon',x:5.26,y:2.55,d:0.55,spec:'lu/LuRocket',bg:'coral',color:'white'},
    {k:'fit',x:6.01,y:2.5,w:2.5,h:0.5,text:'快速验证',min:14,max:18,bold:true,color:'ink'},
    {k:'bullets',x:5.21,y:3.2,w:3.3,h:3.3,items:['MVP两周上线','AB测试优化','ROI追踪'],min:11,max:13,color:'slate'},
    {k:'rrect',x:9.32,y:2.3,w:3.8,h:4.4,fill:'white',shadow:true},
    {k:'icon',x:9.62,y:2.55,d:0.55,spec:'lu/LuShieldCheck',bg:'mint',color:'white'},
    {k:'fit',x:10.37,y:2.5,w:2.5,h:0.5,text:'风险管控',min:14,max:18,bold:true,color:'ink'},
    {k:'bullets',x:9.57,y:3.2,w:3.3,h:3.3,items:['数据合规','模型安全审计','人工复核'],min:11,max:13,color:'slate'},
  ]},
];

build({ slides, out: './output/_test_eval.pptx', theme: 'healthcare', useImages: true, renderPreview: true })
  .then(() => console.log('DONE: output/_test_eval.pptx (12 pages)'))
  .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
