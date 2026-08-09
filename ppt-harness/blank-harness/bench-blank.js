#!/usr/bin/env node
// bench-blank.js — automated benchmark with KNOWN ground truth (standalone detection).
// NOTE: only the TEST-FIXTURE generation borrows the PPT-gen harness (../harness); the detection
// under test is fully standalone (./detect, ./geometry, ./tools, ./context, ./llm).
//   node bench-blank.js            # agentic detection, score precision/recall/F1
//   node bench-blank.js --no-llm   # geometry sensor only

const fs = require('fs'), path = require('path');
const { build } = require('../harness');   // test-fixture builder only
const { detect } = require('./detect');
const geo = require('./geometry');

const noLLM = process.argv.includes('--no-llm');

const card = (x, y, w, h, title, desc) => ({ k: 'rrect', x, y, w, h, fill: 'white', shadow: true, _inner: [
  { k: 'fit', x: x + 0.25, y: y + 0.2, w: w - 0.5, h: 0.5, text: title, min: 15, max: 20, bold: true, color: 'ink' },
  { k: 'bullets', x: x + 0.25, y: y + 0.8, w: w - 0.5, h: h - 1.0, items: desc || ['要点一', '要点二', '要点三'], min: 11, max: 14, color: 'slate' },
] });
const ex = (c) => [c, ...c._inner];

const CASES = [
  { name: 'clean-3cards', role: 'content', title: '干净：三张满卡片', eyebrow: 't', els: [...ex(card(0.6,2.3,3.8,4.4,'A')),...ex(card(4.96,2.3,3.8,4.4,'B')),...ex(card(9.32,2.3,3.8,4.4,'C'))], gt: [] },
  { name: 'big-blank-right', role: 'content', title: '右侧大片留白', eyebrow: 't', els: [...ex(card(0.6,2.3,3.5,2.0,'小卡',['一条']))], gt: [{x:4.3,y:2.1,w:8.4,h:4.8}] },
  { name: 'mid-band', role: 'content', title: '中间空带', eyebrow: 't', els: [...ex({...card(0.6,2.3,12.1,1.4,'顶部',['一条'])}),...ex(card(0.6,5.4,3.8,1.4,'1')),...ex(card(4.96,5.4,3.8,1.4,'2')),...ex(card(9.32,5.4,3.8,1.4,'3'))], gt: [{x:0.6,y:3.9,w:12.1,h:1.4}] },
  { name: 'sparse-card', role: 'content', title: '框大字少', eyebrow: 't', els: [{k:'rrect',x:2,y:2.5,w:9,h:4,fill:'white',shadow:true},{k:'fit',x:2.3,y:2.7,w:8.4,h:0.6,text:'只有标题的大方框',min:18,max:24,bold:true,color:'ink'}], gt: [{x:2.2,y:3.5,w:8.6,h:2.9}] },
  { name: 'cover-exempt', role: 'cover', title: '封面', els: [{k:'fit',x:1,y:3,w:8,h:1.5,text:'封面',min:30,max:44,bold:true,color:'dark'}], gt: [] },
  { name: 'closing-exempt', role: 'closing', title: '结语', els: [{k:'fit',x:1,y:3,w:8,h:1.2,text:'谢谢',min:28,max:36,bold:true,color:'dark'}], gt: [] },
  { name: 'two-corners', role: 'content', title: '两侧留白', eyebrow: 't', els: [...ex(card(3.2,2.3,6.9,4.6,'中',['一','二']))], gt: [{x:0.6,y:2.1,w:2.4,h:4.8},{x:10.3,y:2.1,w:2.4,h:4.8}] },
  { name: 'clean-grid-2x2', role: 'content', title: '干净2×2', eyebrow: 't', els: [...ex(card(0.6,2.3,5.9,2.1,'A')),...ex(card(6.8,2.3,5.9,2.1,'B')),...ex(card(0.6,4.6,5.9,2.1,'C')),...ex(card(6.8,4.6,5.9,2.1,'D'))], gt: [] },
  { name: 'right-side-blank', role: 'content', title: '右侧留白', eyebrow: 't', els: [...ex(card(0.6,2.3,6,4.4,'左'))], gt: [{x:6.9,y:2.1,w:5.8,h:4.8}] },
  { name: 'tricky-legit-gap', role: 'content', title: '正常间距', eyebrow: 't', els: [...ex(card(0.6,2.3,5.5,4.4,'左')),...ex(card(7.2,2.3,5.5,4.4,'右'))], gt: [] },
  { name: 'bottom-blank', role: 'content', title: '底部留白', eyebrow: 't', els: [...ex(card(0.6,2.3,12.1,2.6,'顶',['一','二']))], gt: [{x:0.6,y:5.1,w:12.1,h:1.8}] },
  { name: 'dense-full', role: 'content', title: '密集', eyebrow: 't', els: [...ex(card(0.6,2.3,3.8,4.4,'A')),...ex(card(4.96,2.3,3.8,4.4,'B')),...ex(card(9.32,2.3,3.8,4.4,'C'))], gt: [] },
];

const area = (r) => r.w * r.h;
const inter = (a, b) => { const x0=Math.max(a.x,b.x),y0=Math.max(a.y,b.y),x1=Math.min(a.x+a.w,b.x+b.w),y1=Math.min(a.y+a.h,b.y+b.h); return (x1>x0&&y1>y0)?{x:x0,y:y0,w:x1-x0,h:y1-y0}:null; };
const iou = (a,b) => { const k=inter(a,b); if(!k)return 0; const u=area(a)+area(b)-area(k); return u>0?area(k)/u:0; };
const detTP = (d,gts) => gts.some((g)=>{const k=inter(d,g);return k&&(area(k)/area(d)>=0.4||iou(d,g)>=0.15);});
const gtFound = (g,dets) => dets.some((d)=>{const k=inter(d,g);return k&&(area(k)/area(g)>=0.4||iou(d,g)>=0.15);});

async function main() {
  const slides = CASES.map((c) => ({ t: 'free', role: c.role, bg: 'offWhite', title: c.title, eyebrow: c.eyebrow, elements: c.els }));
  const out = path.join(process.cwd(), 'output', '_bench.pptx');
  console.log(`构建评测集: ${CASES.length} 页 (含 ${CASES.reduce((n,c)=>n+c.gt.length,0)} 个已知留白)…`);
  await build({ slides, out, theme: 'healthcare', useImages: false, renderPreview: false, runQA: false, saveSpec: true });

  console.log(`\n运行检测 ${noLLM ? '(几何 only)' : '(tools+LLM)'}…`);
  let res;
  if (noLLM) {
    // geometry-only path (no LLM): all candidates as blanks
    const { loadDeck } = require('./detect');
    const deck = loadDeck(out);
    res = { slides: deck.slides.map((s) => { const c = geo.candidatesFor(s); const bl = c.regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, area: r.area })).concat(c.thin.map((t) => ({ x: t.panel.x, y: t.panel.y, w: t.panel.w, h: t.panel.h, area: t.panel.w * t.panel.h }))); return { n: s.n, role: s.role, blanks: geo.mergeOverlapping(bl) }; }) };
  } else {
    res = await detect(out, { onLog: () => {} });
  }

  let TP = 0, FP = 0, FN = 0; const per = [];
  for (let i = 0; i < CASES.length; i++) {
    const gt = CASES[i].gt, det = ((res.slides.find((s) => s.n === i + 1) || {}).blanks || []).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
    let tp = 0, fp = 0; for (const d of det) (detTP(d, gt) ? tp++ : fp++);
    const fn = gt.filter((g) => !gtFound(g, det)).length;
    TP += tp; FP += fp; FN += fn;
    per.push({ name: CASES[i].name, gt: gt.length, det: det.length, tp, fp, fn });
  }
  const P = TP + FP ? TP / (TP + FP) : null, R = TP + FN ? TP / (TP + FN) : null, F = (P != null && R != null && P + R > 0) ? 2 * P * R / (P + R) : 0;
  console.log('\n═══════════ 留白检测 评测结果 ═══════════');
  console.log(`样本 ${CASES.length} 页 | GT ${CASES.reduce((n,c)=>n+c.gt.length,0)} | TP=${TP} FP=${FP} FN=${FN}`);
  console.log(`精确率 = ${P==null?'—':(P*100).toFixed(1)+'%'}${P!=null?(P>=0.9?' ✓≥90%':' ✗<90%'):''}  召回率 = ${R==null?'—':(R*100).toFixed(1)+'%'}  F1=${F.toFixed(3)}`);
  if (!noLLM) console.log(`(agent: steps=${res.steps}, toolCalls=${res.toolCalls}, repeats=${res.repeatedCalls}, compactions=${res.compactions})`);
  for (const c of per) console.log(`  ${c.name.padEnd(20)} GT=${c.gt} 检出=${c.det} TP=${c.tp} FP=${c.fp} FN=${c.fn}`);

  fs.readdirSync(path.dirname(out)).filter((f) => f.startsWith('_bench')).forEach((f) => fs.rmSync(path.join(path.dirname(out), f)));
  fs.rmSync(path.join(path.dirname(out), 'blankcheck'), { recursive: true, force: true });
}
main().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
