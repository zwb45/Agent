// qa.js — machine-adapted QA pipeline: structural validation (PYTHONUTF8=1) + render (D-drive soffice -> pdf -> PyMuPDF -> PNG).
// Finds the pptx skill scripts (validate.py) from the cloned repo or plugin cache.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

function findValidatePy() {
  const candidates = [
    path.join(__dirname, '..', '..', 'anthropics-skills', 'skills', 'pptx', 'scripts', 'office', 'validate.py'),
    path.join(os.homedir(), '.claude', 'plugins', 'cache', 'anthropic-agent-skills', 'document-skills', 'b29e7cf65e5c', 'skills', 'pptx', 'scripts', 'office', 'validate.py'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function findSoffice() {
  if (process.env.SOFFICE && fs.existsSync(process.env.SOFFICE)) return process.env.SOFFICE;
  const cands = [
    'D:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function findPython() {
  for (const p of ['python', 'python3']) {
    try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return p; } catch (e) { /* next */ }
  }
  return 'python';
}

/** Structural validation. Returns {ok, output}. */
function validate(pptxPath) {
  const vp = findValidatePy();
  const abs = path.resolve(pptxPath);
  if (!vp) return { ok: false, output: 'validate.py not found (clone anthropics/skills or set path).' };
  const out = spawnSync(findPython(), [vp, abs], {
    env: { ...process.env, PYTHONUTF8: '1' },
    encoding: 'utf8', timeout: 120000,
  });
  const text = (out.stdout || '') + (out.stderr || '');
  const ok = /All validations PASSED/.test(text);
  return { ok, output: text.trim().split('\n').slice(-12).join('\n') };
}

/** Convert pptx -> pdf (soffice) then render every page to PNG (PyMuPDF). Returns {pdf, pngs}. */
function renderAll(pptxPath, outDir) {
  const abs = path.resolve(pptxPath);
  outDir = path.resolve(outDir || path.dirname(abs));
  fs.mkdirSync(outDir, { recursive: true });
  const soffice = findSoffice();
  if (!soffice) return { error: 'soffice not found (set SOFFICE env to your LibreOffice soffice.exe).' };
  // 1. pptx -> pdf
  const conv = spawnSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, abs], { encoding: 'utf8', timeout: 180000 });
  const base = path.basename(abs, path.extname(abs));
  const pdf = path.join(outDir, base + '.pdf');
  if (!fs.existsSync(pdf)) return { error: 'PDF conversion failed.\n' + (conv.stderr || '') };
  // 2. pdf -> pngs via PyMuPDF
  const py = findPython();
  const script = `
import fitz, sys, os
doc=fitz.open(sys.argv[1])
out=sys.argv[2]; prefix=sys.argv[3]
pngs=[]
for i,page in enumerate(doc):
    p=os.path.join(out, f"{prefix}-{i+1:02d}.png")
    page.get_pixmap(matrix=fitz.Matrix(150/72,150/72)).save(p); pngs.append(p)
print("\\n".join(pngs))
`;
  const res = spawnSync(py, ['-c', script, pdf, outDir, base], { env: { ...process.env, PYTHONUTF8: '1' }, encoding: 'utf8', timeout: 120000 });
  const pngs = (res.stdout || '').trim().split('\n').filter(Boolean);
  return { pdf, pngs, error: pngs.length ? null : ('render failed: ' + (res.stderr || '')) };
}

// Content lint: flag design-meta / self-referential copy that shouldn't ship in a real deck
// (e.g. "每个议题配一张相关配图", "这一页", "图文并茂"). Returns [{slide, hits, snippet}].
function lintContent(pptxPath) {
  const abs = path.resolve(pptxPath);
  const py = findPython();
  const script = `
import sys, re
from pptx import Presentation
p = Presentation(sys.argv[1])
literals = ["配图", "这一页", "本页", "该页", "这页", "图文并茂", "文图并茂"]
rx = re.compile(u"每[^\\u3002\\n]{0,10}图")
out = []
for i, slide in enumerate(p.slides, start=1):
    txt = " ".join(sh.text_frame.text for sh in slide.shapes if sh.has_text_frame)
    hits = [w for w in literals if w in txt]
    if rx.search(txt): hits.append("每…图")
    if hits:
        out.append(f"{i}\\t{','.join(dict.fromkeys(hits))}\\t{txt[:50]}")
print("\\n".join(out))
`;
  const r = spawnSync(py, ['-c', script, abs], { env: { ...process.env, PYTHONUTF8: '1' }, encoding: 'utf8', timeout: 60000 });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  return lines.map((l) => {
    const [slide, hits, snippet] = l.split('\t');
    return { slide: Number(slide), hits, snippet };
  });
}

module.exports = { validate, renderAll, lintContent, findValidatePy, findSoffice, findPython };
