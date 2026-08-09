// _blank_loop_test.js — regression test for the blank-verify step in buildWithReview().
//
// Two layers:
//   A. UNIT (deterministic, no LLM): blankIssues() / uncertainBlanks() routing — the new
//      content-aware plumbing (skip 'uncertain' + hero; collect 'uncertain' for human confirm).
//   B. E2E (real GLM LLM): drive a freeform .slides.json back through buildWithReview() and watch
//      the content-aware agent: clean deck (expect pass), injected thin page (expect flagged +
//      revised), injected quote-like page (expect kept, not flagged).

const fs = require('fs');
const path = require('path');
const { buildWithReview } = require('./lib/orchestrator');
const blankVerify = require('./lib/blank-verify');

const SRC = process.argv[2] || 'output/脑机接口技术.pptx.slides.json';
const OUT = 'output/_blanktest.pptx';
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------- A. UNIT: routing of severity → issues / uncertain ----------------
function unitBlankRouting() {
  console.log('\n========== UNIT: blankIssues / uncertainBlanks routing ==========');
  const SLIDE_AREA = 13.33 * 7.5;
  const synth = { slides: [
    { n: 1, role: 'cover', title: 'C', text: 't', blanks: [{ x: 0, y: 2, w: 10, h: 4, area: 40, severity: 'high', kind: 'blank-rect' }] }, // hero → dropped
    { n: 2, role: 'content', title: 'P', text: 't', blanks: [
      { x: 0, y: 3, w: 8, h: 3, area: 24, severity: 'high', kind: 'blank-rect' },     // → error
      { x: 0, y: 3, w: 6, h: 2, area: 12, severity: 'medium', kind: 'thin-block' },    // → error (thin)
      { x: 0, y: 6, w: 4, h: 1, area: 4, severity: 'low', kind: 'blank-rect' },        // → warn
      { x: 5, y: 3, w: 5, h: 3, area: 15, severity: 'uncertain', kind: 'blank-rect' }, // → uncertain, NOT an issue
    ] },
  ] };
  const issues = blankVerify.blankIssues(synth);
  const uncertain = blankVerify.uncertainBlanks(synth);
  const errs = issues.filter((i) => i.severity === 'error').map((i) => i.slide);
  const warns = issues.filter((i) => i.severity === 'warn').map((i) => i.slide);
  const uncPages = uncertain.map((u) => u.slide);
  let ok = true;
  ok &= eq(errs.sort(), [2, 2]);          // high + medium on page 2 (cover's high dropped)
  ok &= eq(warns, [2]);                    // low on page 2
  ok &= eq(uncPages, [2]);                 // uncertain collected for page 2
  ok &= !issues.some((i) => i.severity === 'uncertain'); // uncertain never becomes an issue
  ok &= !issues.some((i) => i.slide === 1) && !uncertain.some((u) => u.slide === 1); // hero exempt both
  console.log('  issues slides:', issues.map((i) => i.slide + ':' + i.severity).join(', '));
  console.log('  uncertain slides:', uncPages.join(', '));
  console.log(ok ? '  ✓ routing correct (hero exempt; high/medium→error; low→warn; uncertain→separate)' : '  ✗ ROUTING WRONG');
  return !!ok;
}

// ---------------- B. E2E helpers ----------------
function loadSlides(f) { return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); }

async function run(label, slides, opts) {
  console.log('\n========== ' + label + ' ==========');
  const t0 = Date.now();
  let blankLines = 0, uncertainCalled = 0;
  const res = await buildWithReview(slides, Object.assign({
    out: OUT, useImages: false, renderPreview: false,
    title: 'blank-test', maxIters: 1,
    onProgress: (stage, detail) => {
      if (stage.startsWith('blankcheck')) { blankLines++; if (stage === 'blankcheck') console.log('  [blankcheck] ' + detail); }
      else if (stage === 'blankcheck:tick' && /finish|draw_red_box/.test(detail)) console.log('  ' + detail);
    },
    onWarn: (d) => console.log('  ⚠ ' + d),
    onUncertain: async (items) => { uncertainCalled = items.length; console.log('  [onUncertain] ' + items.length + ' uncertain item(s) — auto-keeping all'); return items.map((i) => Object.assign({}, i, { keep: true })); },
  }, opts));
  console.log(`--> done in ${((Date.now() - t0) / 1000).toFixed(1)}s; blankcheck fired ${blankLines}×; onUncertain called ${uncertainCalled}×`);
  return { res, blankLines, uncertainCalled };
}

(async () => {
  const unitOk = unitBlankRouting();

  if (!fs.existsSync(SRC)) { console.log('\n(no ' + SRC + ' — skipping E2E; UNIT only)'); process.exit(unitOk ? 0 : 1); }
  const orig = loadSlides(SRC);
  console.log('\nloaded ' + orig.length + ' slides from ' + SRC);

  // Stage 1: clean deck — content-aware agent should pass (0 content blanks).
  const s1 = await run('STAGE 1: clean deck (expect blankcheck pass)', orig);

  // Stage 2: inject a thin page (1 small top-left element) — expect flagged + revised.
  const thin = JSON.parse(JSON.stringify(orig));
  const iThin = thin.findIndex((s) => s.t === 'free' && !['cover', 'closing', 'divider'].includes(s.role));
  if (iThin >= 0) {
    thin[iThin].elements = (thin[iThin].elements || []).slice(0, 1).map((e) => Object.assign({}, e, { x: 0.6, y: 2.2, w: 3.0, h: 0.6, text: '一句话要点' }));
    console.log('\ninjected THIN page: slide ' + (iThin + 1));
    const s2 = await run('STAGE 2: injected thin page (expect flagged)', thin);
    if (!s2.blankLines) console.error('!! STAGE 2: blankcheck never fired');
  }

  // Stage 3: inject a quote-like page (single big centered quote + attribution) — content-aware
  // judge should read the text and KEEP it (no issue). Best-effort: logged, not hard-asserted.
  const quote = JSON.parse(JSON.stringify(orig));
  const iQ = quote.findIndex((s) => s.t === 'free' && !['cover', 'closing', 'divider'].includes(s.role));
  if (iQ >= 0) {
    quote[iQ].elements = [
      { k: 'fit', x: 1.5, y: 3.0, w: 10.3, h: 1.6, text: '预测未来最好的方式，就是创造它。', size: 44, bold: true, color: 'ink', align: 'center' },
      { k: 'text', x: 1.5, y: 4.8, w: 10.3, h: 0.5, text: '— Alan Kay', size: 16, color: 'muted', align: 'center' },
    ];
    quote[iQ].title = '一句金句';
    console.log('\ninjected QUOTE-like page: slide ' + (iQ + 1) + ' (大段留白 + 单句金句)');
    const s3 = await run('STAGE 3: quote-like page (content-aware judge should KEEP, not flag)', quote);
    console.log(s3.blankLines ? '  (note: blankcheck ran; whether it kept the quote is in the log above)' : '  ✗ blankcheck never fired');
  }

  console.log('\n========== RESULT ==========');
  console.log('UNIT routing: ' + (unitOk ? 'PASS' : 'FAIL'));
})().catch((e) => { console.error('TEST FAIL:', e); process.exit(1); });
