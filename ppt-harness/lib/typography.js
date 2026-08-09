// typography.js — central typography config so the LLM can (re)decide fonts & sizes after generation.
// Passed to build({ typography }) and threaded through every renderer; overrides the defaults.
//   build({ typography: { headingFont:'Georgia', bodyFont:'Calibri', sizes:{ slideTitle:34, cardDescMax:16 } } })

const DEFAULT = {
  headingFont: 'Microsoft YaHei',   // titles, eyebrows, big numbers, badges (微软雅黑, default per user pref)
  bodyFont: 'Microsoft YaHei',      // body copy, bullets, descriptions
  sizes: {
    // cover / closing (theme pages)
    coverEyebrow: 15, coverTitle: 50, coverSub: 20, coverMeta: 11,
    closingEyebrow: 15, closingTitle: 48, closingSub: 18,
    // content header band
    slideTitle: 30, sub: 13, eyebrow: 11, lead: 12.5, note: 9,
    // card title/desc auto-fit ranges (min..max) per grid type
    cardTitleMin: 14, cardTitleMax: 18, cardDescMin: 11, cardDescMax: 15,
    agendaTitleMin: 14, agendaTitleMax: 18, agendaDescMin: 11, agendaDescMax: 15,
    quadTitleMin: 14, quadTitleMax: 18, quadDescMin: 11, quadDescMax: 15,
    futureTitleMin: 15, futureTitleMax: 20, futureDescMin: 12, futureDescMax: 18,
    // data
    statBig: 34, statLabel: 12, statSub: 10,
    flowBig: 32, pipeBig: 30,
    chartStatBig: 38,
    // body
    bullets: 13, body: 13,
  },
};

// Merge user overrides over defaults (top-level keys + sizes.*).
function make(user) {
  const t = { headingFont: DEFAULT.headingFont, bodyFont: DEFAULT.bodyFont, sizes: Object.assign({}, DEFAULT.sizes) };
  if (user) {
    if (user.headingFont) t.headingFont = user.headingFont;
    if (user.bodyFont) t.bodyFont = user.bodyFont;
    if (user.sizes) Object.assign(t.sizes, user.sizes);
  }
  return t;
}

const s = (T, key) => (T && T.sizes && T.sizes[key] != null ? T.sizes[key] : DEFAULT.sizes[key]);

module.exports = { DEFAULT, make, s };
