const { generateFreeformDeck } = require('./lib/orchestrator');

const topic = 'AI 医疗的发展与前景';
generateFreeformDeck(topic, {
  pages: 8,            // 8 内容页 + 封面 + 结语 ≈ 10 页
  depth: 'standard',
  useImages: true,     // 从 .env 读 Pexels key
  maxIters: 2,         // build → blankcheck → review/revise 循环 2 轮
  cwd: process.cwd(),
  out: 'output/AI医疗发展.pptx',
  onProgress: (p, d) => console.log('  [' + p + '] ' + (d || '')),
  onWarn: (d) => console.log('  ⚠ ' + d),
}).then((res) => console.log('DONE ->', res.file, '| slides:', res.slides.length))
  .catch((e) => { console.error('FAIL', e); process.exit(1); });
