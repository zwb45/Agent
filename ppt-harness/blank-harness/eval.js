// eval.js — human-evaluation harness for the whitespace detector (standalone).
// makeEvalHTML: a self-contained HTML review sheet (each flagged slide shown, TP/FP per box,
//   live precision, export judgments with severity).
// computePrecision: precision/recall-ish stats (TP/FP/skipped, per severity, ≥90%) from exported judgments.

const fs = require('fs');
const path = require('path');
const geo = require('./geometry');

const b64 = (f) => { try { return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'); } catch (e) { return ''; } };

function makeEvalHTML(report, pngDir, base) {
  const slides = report.slides.filter((s) => s.blanks.length);
  const items = [];
  const sevMap = {};
  slides.forEach((s) => {
    const png = path.join(pngDir, `${base}-blank-${String(s.n).padStart(2, '0')}.png`);
    const img = b64(png);
    const rows = s.blanks.map((b, i) => {
      sevMap[`${s.n}-${i + 1}`] = b.severity || 'medium';
      const pct = (b.area / (geo.W * geo.H) * 100).toFixed(0);
      return `<tr data-id="${s.n}-${i + 1}"><td><b>#${i + 1}</b></td><td>${b.severity}</td><td>x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} ${b.w.toFixed(1)}×${b.h.toFixed(1)}" (${pct}%)</td><td>${(b.reason || '').replace(/</g, '&lt;')}</td><td class="vote"><button onclick="vote('${s.n}-${i + 1}','tp')">✓ 真留白</button><button onclick="vote('${s.n}-${i + 1}','fp')">✗ 误报</button><span class="mark"></span></td></tr>`;
    }).join('');
    items.push(`<div class="slide"><h3>第 ${s.n} 页 (${s.role}) — ${s.blanks.length} 个框</h3>${img ? `<img src="${img}"/>` : '<p class=warn>(找不到标注图)</p>'}<table><tr><th>#</th><th>severity</th><th>坐标/大小</th><th>理由</th><th>人工判定</th></tr>${rows}</table></div>`);
  });
  const total = slides.reduce((n, s) => n + s.blanks.length, 0);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>留白检测·评估 — ${base}</title>
<style>body{font-family:"Microsoft YaHei",Arial,sans-serif;margin:20px;background:#f6f6f4;color:#222}h1{font-size:20px}h3{margin:18px 0 6px;border-left:5px solid #EF6F6C;padding-left:10px}.bar{position:sticky;top:0;background:#fff;border:1px solid #ddd;padding:12px 16px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.06);margin-bottom:16px}.big{font-size:28px;font-weight:bold;color:#157F8B}.sub{color:#666}img{max-width:100%;border:1px solid #ccc;border-radius:6px;display:block;margin:8px 0}table{border-collapse:collapse;width:100%;background:#fff;margin:6px 0 18px;border-radius:6px;overflow:hidden}td,th{border:1px solid #eee;padding:7px 9px;text-align:left;font-size:13px;vertical-align:top}th{background:#f0f0ee}button{padding:4px 9px;margin-right:4px;border:1px solid #bbb;border-radius:4px;background:#fff;cursor:pointer;font-size:12px}button:hover{background:#eef}tr.tp{background:#e6f7ed}tr.fp{background:#fdecec}.mark{font-weight:bold;margin-left:6px}.warn{color:#a00}.ok{color:#2DBE9E;font-weight:bold}.bad{color:#E0353B;font-weight:bold}</style></head><body>
<div class="bar"><div class="big" id="pct">— %</div><div class="sub">通过率(精确率) · 目标 ≥90% · 共 ${total} 框 · 已判定 <b id="done">0</b></div><div style="margin-top:8px"><button onclick="exportJ()">⬇ 导出判定(JSON)</button><span id="verdict" class="sub"></span></div></div>
<h1>留白检测·评估 — ${base}</h1><p class="sub">对每个红框判定 ✓真留白 / ✗误报。</p>
${items.join('\n')}
<script>const J={},SEV=${JSON.stringify(sevMap)};
function vote(id,v){J[id]=v;const tr=document.querySelector('[data-id="'+id+'"]');tr.classList.remove('tp','fp');tr.classList.add(v);tr.querySelector('.mark').textContent=v==='tp'?'✓ 真留白':'✗ 误报';const vs=Object.values(J),tp=vs.filter(x=>x==='tp').length;const p=vs.length?tp/vs.length*100:0;document.getElementById('pct').textContent=p.toFixed(0)+' %';document.getElementById('done').textContent=vs.length;if(vs.length===${total})document.getElementById('verdict').innerHTML=p>=90?'<span class="ok">✓ 达标</span>':'<span class="bad">✗ 未达90%</span>';}
function exportJ(){const d={deck:${JSON.stringify(base)},judgments:Object.entries(J).map(([k,v])=>({id:k,verdict:v,severity:SEV[k]||'medium'}))};const b=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='${base}.judgments.json';a.click();}
</script></body></html>`;
}

function computePrecision(judgments) {
  let tp = 0, fp = 0, skipped = 0; const per = {};
  for (const j of judgments) {
    const sev = j.severity || 'unknown'; per[sev] = per[sev] || { tp: 0, fp: 0 };
    if (j.verdict === 'tp') { tp++; per[sev].tp++; }
    else if (j.verdict === 'fp') { fp++; per[sev].fp++; }
    else skipped++;
  }
  const decided = tp + fp, p = decided ? tp / decided : null;
  return { tp, fp, skipped, decided, precision: p == null ? null : +p.toFixed(4), precisionPct: p == null ? null : +(p * 100).toFixed(1), pass90: p == null ? null : p >= 0.9, perSeverity: per };
}

module.exports = { makeEvalHTML, computePrecision };
