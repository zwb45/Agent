// typography-demo.js — same content as v5, but the LLM re-decides fonts & sizes via build({typography}).
// Demonstrates that typography is fully overridable after generation. Run: node examples/typography-demo.js

const path = require('path');
const { build } = require('../harness');
const { slides } = require('./ai-healthcare-v5');

build({
  theme: 'healthcare',
  title: 'AI 在医疗领域的应用 (衬线/大字版)',
  footerLabel: 'AI 在医疗领域的应用',
  slides,
  out: path.join(__dirname, 'output', 'ai-healthcare-v5-serif.pptx'),
  useImages: true,
  typography: {
    headingFont: 'Cambria',   // serif headings (was Arial)
    bodyFont: 'Calibri',
    sizes: {
      slideTitle: 34, coverTitle: 54, closingTitle: 50,
      cardTitleMin: 16, cardTitleMax: 22, cardDescMin: 12, cardDescMax: 17,
      statBig: 40, statLabel: 14,
    },
  },
}).catch((e) => { console.error('BUILD FAILED:', e); process.exit(1); });
