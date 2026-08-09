# ppt-harness

A **general-purpose, declarative PPT generation / editing / layout harness** built on top of Anthropic's official [`pptx` skill](https://github.com/anthropics/skills/tree/main/skills/pptx) (pptxgenjs), **augmented with rich icons (react-icons) and open-source stock images** so decks come out 文图并茂 (rich with text and graphics) instead of plain shapes.

It works for **any topic** — healthcare, automotive, finance, SaaS, education, … The slide types, themes, outline compiler, and edit ops are all domain-agnostic; a CN+EN keyword table auto-picks a relevant icon and stock-photo query per card. Four ways to drive it:

- **🪄 Chat (turnkey, research-driven)**: `node chat.js`, then just say *"请帮我生成一个量子计算的 ppt"* — it **gathers real material from the web first**, aggregates the most valuable points, then writes and renders a grounded, content-rich deck. Best for "I have a topic, make me a deck."
- **Outline → deck** (terse, LLM-friendly): `node generate.js --outline <file>` — write a short `{topic, sections}`, the compiler fills cover/agenda/closing, icons, images, numbering.
- **Spec → deck** (full control): write a `slides` array, `node generate.js --spec <file>`.
- **Edit an existing deck**: `node edit.js --spec <deck>.spec.json --edits <file>` (rebuild) or `--live <any>.pptx` (python-pptx).
- **Beautify a rough deck**: `node beautify.js --import <ugly.pptx>` or `--spec <deck>.spec.json` — re-types slides to fit content, trims, restores structure.

```
slide specs (JSON-ish) ──▶ harness.build() ──▶ .pptx + validate + preview PNGs
                              │
            ┌─────────────────┼──────────────────┐
       elements           icons              images
   (pptxgenjs shapes)  (react-icons→PNG)  (Pexels/Unsplash/Pixabay→image)
```

## Quick start

```bash
cd D:\Proj\Agent\ppt-harness

# generate from a terse outline (any topic) — compiler fills icons/images/cover/agenda/closing
node generate.js --outline examples/ai-healthcare-outline.json   # → output/ai-healthcare-outline.pptx
node generate.js --outline examples/ev-industry-outline.json     # → output/ev-industry-outline.pptx (non-healthcare)

# or hand-write a full deck (the original way)
node examples/ai-healthcare.js          # → examples/output/ai-healthcare.pptx + preview/
node examples/ai-healthcare.js --no-images   # offline (programmatic illustrations instead of photos)
```

Output: `examples/output/ai-healthcare.pptx` (validated) and `examples/output/preview/ai-healthcare-NN.png` (one per slide).

> Deps (`pptxgenjs react react-dom react-icons sharp`) are already installed at the parent `D:\Proj\Agent\node_modules` — no `npm install` needed. If you move this folder out, run `npm install` here.

## Research-driven generation — the `chat` interface (solves "内容不够丰满")

The most turnkey way to get a deck. Launch the assistant and talk to it in natural language — it researches the topic on the web first, so the deck is full of **real data, named examples and cited sources** instead of generic filler.

```bash
node chat.js                # or: npm run chat
ppt> 请帮我生成一个固态电池技术的 ppt
ppt> 换成深色主题            # re-render the current deck, no re-research (seconds)
ppt> 再加一页关于商业化落地的内容
ppt> 去掉配图重新出
ppt> /quit
```

One-shot mode (generate then exit, good for scripts): `node chat.js --once "新能源车行业，深色，详细一点"` · `npm run deck -- "碳中和"`.

**Why it's richer.** A pure "write me a deck on X" prompt leans only on the model's memory. The chat pipeline adds a research stage:

```
topic ──▶ [1] research  ── web search (multi-angle: overview · data · applications · trends · cases · challenges)
         (lib/research.js)   └─▶ aggregate / de-dupe / rank → research brief (stats, examples, trends, sources)
              │
              ▼  [2] outline  ── author a grounded outline (real numbers → stats, real cases → table, …) (lib/outline.js)
              ▼  [3] compile  ── outlineToSlides: auto icons / images / cover / agenda / closing / numbering
              ▼  [4] validate ── validateSlides (catch mal-formed pages before pptxgenjs)
              ▼  [5] build    ── harness.build() → .pptx + spec.json + preview PNGs
```

Every generated deck is saved with its research brief and outline alongside the `.pptx` (`<deck>.brief.json`, `<deck>.outline.json`) so you can see exactly what fed in. Source notes land in slide `note` fields.

**Requests understand modifiers** — just write them in the sentence:

| Want | Say |
|---|---|
| Dark / serious look | `深色` · `暗色` · `严肃` · `商务` |
| Style | `极简` · `科技感` · `杂志` · `大胆` |
| More / fewer pages | `详细` / `丰富` (≈12) · `简短` / `精简` (≈6) |
| Images off/on | `不配图` / `离线` · `带配图` |
| Research depth | `快速` (quick) · `深度` (deep); default `standard` |
| Explicit flags | `--theme midnight --style tech --pages 10 --depth deep --no-images` |

**Follow-ups** operate on the current deck without redoing research (fast): `换成深色` · `用极简风格` · `加一页关于 X` · `去掉配图` · `加配图` · `重新生成` (re-research). Slash commands: `/help` · `/research <topic>` (brief only) · `/outline` · `/brief` · `/quit`.

**Prerequisites.** The chat interface calls an LLM. It reads the same env the host session uses — `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (+ `ANTHROPIC_DEFAULT_HAIKU/SONNET_MODEL`). Web gathering uses the model's built-in server-side search, so no separate search API key is needed. Programmatic entry point: `require('./lib/orchestrator').generateDeck(topic, opts)`.

## Layout QA + freeform design (no repeats / no overflow / no monotony / no whitespace)

Four long-standing quality problems are solved by a geometry-capture layer, a freeform renderer, and an LLM review loop:

| Problem | Fix |
|---|---|
| **Repeated images / content off-slide** | Per-deck image dedup (`getImage({used})` skips already-used URLs) + bounds check |
| **No overlap / overflow check after generation** | Every placed element's box is captured (`layout-qa` E-recorder); deterministic checks for out-of-bounds, overlap, and whitespace |
| **Decks all look the same** | **Freeform mode** — the LLM decides every element's position; the harness only renders + validates (no hardcoded layout). Each slide uses a different composition archetype |
| **Large whitespace** | Whitespace detection (largest-empty-rectangle) + an LLM review/revise loop that re-places elements until clean |
| **Unreadable text / too much dark** | Freeform renderer auto-overrides any low-contrast text color (WCAG ≥4.5 against its real background — `lib/color.js`); covers are minimal (just the theme); backgrounds default to light tones, not dark |

**Every build now runs layout QA** (typed decks too): `LAYOUT-QA: …` prints bounds/overlap/whitespace findings, saved to `<deck>.layout.json`. It already caught and fixed a real bug (agenda overflowed with >6 sections).

**Freeform mode** — say `创意` / `自由版式` / `--freeform`, or `generateFreeformDeck()`:

```
node chat.js
ppt> 做一个深海探测的 ppt，创意版式
```

The LLM composes each slide from a 10-element toolbox (`rect/rrect/oval/text/fit/bullets/image/icon/badge/line`) on the 13.33×7.5 canvas, cycling 8 composition archetypes (hero-poster, stat-dashboard, sidebar-split, bento, timeline-flow, comparison, card-grid, feature-quote) so consecutive slides never share a layout. A build → layout-qa → review → revise loop polishes overlaps/overflow/whitespace (≤2 rounds). `fit`/`bullets` auto-size text to fill the boxes the LLM drew — the anti-whitespace tool.

```
topic ─▶ research(brief) ─▶ composeFreeformDeck (plan → per-slide freeform design) ─▶
         ┌─▶ build (+capture geometry) ─▶ layout-qa ─▶ clean? ─▶ .pptx + previews
         └──── else ──── review.reviewAndRevise (LLM re-places / densifies) ────┘
```

Programmatic: `require('./lib/orchestrator').generateFreeformDeck(topic, {pages, maxIters, …})`. Details: `ARCHITECTURE.md` §12.



## Visual design — the LLM decides what the deck looks like

Decks do **not** come out looking stamped from one template. The look is authored per-deck through a small design vocabulary; the LLM (or you) decides every axis, and may even define a custom color palette:

```jsonc
// inside an outline, or pass to build():
"design": {
  "palette":   { "dark":"2E1B2E", "primary":"B5335A", "mint":"E08FA3", "coral":"F2784B", "ink":"2A1320", "offWhite":"FBF2F0", "cardTint":"F6E2DF" },
  "typography":{ "headingFont":"Cambria", "bodyFont":"Calibri" },
  "header": "pill | bar | center",     // title-band treatment
  "cover":  "photo | split | solid",   // cover-slide treatment
  "card":   "shadow | flat | line",    // content-card treatment
  "decorate":"ovals | bars | dots | none"
}
```

- **Custom palette**: give any subset of hexes (`palette.coerce` fills the rest from defaults). This is the biggest lever for making a deck feel bespoke to its topic. Or use a named `theme`: `healthcare | midnight | charcoal | berry`.
- **Layout axes**: `header` (pill/bar/center), `cover` (photo/split/solid), `card` (shadow/flat/line), `decorate` (ovals/bars/dots/none) — pick each independently. Five **example bundles** via `"style": "classic | editorial | minimal | tech | bold"` set all four at once (they're starting points, not a mandatory menu).
- **Auto-variety**: if an outline specifies no design, the compiler picks a style deterministically from the topic hash — so two different topics come out visually different with zero hand-tuning.
- `--style <name>` / `--theme <name>` on `generate.js` override; `build({ palette, style, header, cover, card, decorate, typography })` programmatically. `prompts/generate-deck.md` instructs an LLM to act as the designer (choose palette + axes to match the topic's tone, then write content).



## Write your own deck

```js
const path = require('path');
const { build } = require('../harness');

build({
  theme: 'healthcare',          // healthcare | midnight | charcoal | berry
  footerLabel: 'My Deck',
  out: path.join(__dirname, 'output', 'mine.pptx'),
  useImages: true,              // false = offline (svg illustrations only)
  slides: [
    { t: 'cover', title: '...', subtitle: '...', img: 'search query for the photo', chips:[...] },
    { t: 'agenda', items: [{ title, desc }, ...] },
    { t: 'iconGrid', cards: [{ icon: 'lu/LuBrain', title, desc }, ...] },
    { t: 'chart', lead, bullets, stat:{big,desc}, chart:{title,cats,vals,suffix} },
    { t: 'closing', title:'...', take:[{title,desc}], thanks:'谢谢' },
    // ... see below for all types
  ],
});
```

### Slide types

| `t` | Purpose | Key fields |
|---|---|---|
| `cover` | Title slide, full-bleed photo + overlay (**minimal, theme-focused**) | `eyebrow, title, subtitle, img, meta` |
| `divider` | Full-bleed image section break | `eyebrow, title, subtitle, img, points:[]` |
| `agenda` | 2×3 numbered nav cards | `items:[{title,desc}]` |
| `stats` | Big-number row + two bullet columns | `stats:[{big,label,sub?}], cols:[{title,bullets:[]}]` |
| `iconGrid` | 3×2 cards; **each card gets its own image by default** (query: `card.img` ‖ `card.title`); icon-only when images off | `cards:[{icon,title,desc,img?}]` |
| `chart` | Left text/stat + right native column chart (**beautified**) | `lead, bullets, stat:{big,desc}, chart:{title,cats,vals,suffix\|dataLabelFmt,color,max,step,xTitle?,yTitle?}` |
| `flow` | Stat row + N-step process with **icons** + arrows | `stats:[...], heading, steps:[{icon,title,desc}]` |
| `pipeline` | Stat row + horizontal milestone pipeline | `stats:[...], heading, phases:[{title,desc,accel?}]` |
| `twoCol` | Left text card + right **image** (or stat cards) | `left:{title,lead,bullets}, img, caption` *or* `right:[{big,label}]` |
| `quadrant` | 2×2 cards; **per-card images by default** | `cards:[{icon,title,desc,img?}]` |
| `future` | 3 tall cards; **per-card images by default** | `cards:[{icon,title,desc,img?}]` |
| `table` | **Beautified data table** (colored header, zebra, badge cells) | `columns:[{header,key,w?,align?}], rows:[{key: value \| {text,color?,bold?}}]` |
| `closing` | Dark closing, big theme statement (**minimal, theme-focused**) | `eyebrow, title, sub, thanks, note` |

**Richness fields (most content slides accept these):**
- `sub` — italic subtitle line under the title (every slide).
- `lead` — intro sentence under the header (agenda/stats/iconGrid/quadrant/future/twoCol).
- `note` — small source/disclaimer line at the bottom (every content slide).
- **Cover & closing are intentionally minimal** — eyebrow + big title + (subtitle/sub) + meta/thanks; they highlight the theme with whitespace, they don't pack content. (`intro`/`chips` on cover and `take` on closing are ignored.)
- **Per-card images (default for grids):** `iconGrid`/`quadrant`/`future` give **each card its own relevant image** automatically — query = `card.img` (preferred, English) ‖ `card.title`. Set `card.img` to control each card's picture; a card whose image can't be fetched falls back to its icon. There is deliberately **no "one side image for many items"** mode for these grids.
- `img` (slide-level) — on `cover`/`divider`/`twoCol` it's the main image; on `table` an optional side image.
- `images: false` on a grid slide → icon-only cards (also happens automatically when running with `useImages:false`).
- Card `desc` fields wrap to 2–3 lines — write fuller copy.
- **Text auto-fills its box (饱满) and matches it:** card titles & descriptions are sized by `E.fitText` to the largest font that fills the box **without overflowing**, and **bullet lists** are sized by `E.fitBullets` — which also grows the paragraph spacing to spread bullets so they fill the box (no big empty gap under a short list). The fit engine uses a realistic CJK width (~1.04em) + line-height (1.3) + a 92% safety margin (so it matches the box in real LibreOffice/PowerPoint rendering), and single-line text is vertically centered.
- Table cells: a plain string, or `{text, color, bold}` for emphasis (e.g. status badges).
- **No image distortion:** card thumbnails are center-cropped to the exact box ratio (`sharp` cover) before placement, so they're never stretched or squished.
- **Robust output:** if the target `.pptx` is locked (e.g. you left it open in PowerPoint), `build()` writes a temp file then renames; on a lock it retries, then auto-falls back to `<name>-2.pptx`, `<name>-3.pptx`… and prints which file it wrote — it never crashes the build.
- **Content lint:** after each build, `qa.lintContent` scans the deck text and warns if **design-meta / self-referential copy** leaked in — phrases like `配图`, `每…图`, `这一页/本页/该页`, `图文并茂` (e.g. a subtitle that says "每个议题配一张相关配图" instead of real content). Prints `LINT: clean` when none found.

### Typography (LLM-re-decidable)

All fonts & font sizes live in `lib/typography.js` and are passed via `build({ typography })` — so after generating, the LLM can re-decide them and regenerate. Override any subset; omitted keys keep defaults.

```js
build({
  typography: {
    headingFont: 'Cambria',          // titles, eyebrows, numbers (default 'Arial')
    bodyFont: 'Calibri',             // body, bullets, descs (default 'Calibri')
    sizes: { slideTitle: 34, coverTitle: 54, cardDescMax: 17, statBig: 40 /* ... */ },
  }, ... });
```

Size keys (all overridable): `coverTitle/coverSub/coverEyebrow/coverMeta`, `closingTitle/closingSub/closingEyebrow`, `slideTitle/sub/eyebrow/lead/note`, `cardTitleMin/Max` `cardDescMin/Max` (iconGrid), `agenda*`, `quad*`, `future*` (same pattern per grid), `statBig/statLabel/statSub`, `flowBig/pipeBig`, `chartStatBig`, `bullets/body`. Card text auto-fits within its `Min..Max` range, so raising `Max` lets short text grow fuller; `fitText` never lets it overflow.

Demo: `node examples/typography-demo.js` rebuilds the v5 deck with serif headings + larger sizes → `output/ai-healthcare-v5-serif.pptx`.

### Icons

Icons use **react-icons** with format `pack/Name`. Packs: `lu` (lucide), `tb` (tabler), `pi` (phosphor), `si` (simple-icons), `fa6`, `hi2`, `md`.

- Example: `'lu/LuStethoscope'`, `'tb/TbMedicalCrossFilled'`, `'lu/LuDna'`.
- Find a name: `node -e "const i=require('./lib/icons'); console.log(i.search('lu','heart'))"` → lists matches.
- Missing icons fall back to a dot (never crash). Brand icons churn (e.g. `SiOpenai` is gone) — prefer generic ones (`lu/LuSparkles`).
- Icons are rasterized to PNG via `sharp` and cached in `.cache/icons/`.

### Images (open-source stock, prioritized)

Image providers tried in order, keys read from `.env`:

1. **Pexels** (`PEXELS_API_KEY`) — ✅ configured, working. Free key: <https://www.pexels.com/api/>
2. **Unsplash** (`UNSPLASH_ACCESS_KEY`) — add to enable. <https://unsplash.com/developers>
3. **Pixabay** (`PIXABAY_API_KEY`) — add to enable. <https://pixabay.com/api/docs/>
4. `local` — drop files in `assets/`, reference by prefix.
5. `svg` — programmatic illustration (always works, offline).

All three platforms are free, commercial-use, no attribution. To switch/add a provider, just put the key in `.env` — no code change. Downloads are cached in `.cache/images/`. HTTP uses `curl` (more reliable than node-fetch on this machine).

## Generate a deck from an outline (LLM-friendly)

Instead of hand-writing every slide spec, give the harness a **terse outline** (`{topic, sections}`) and the compiler fills the rest: auto cover/agenda/closing, eyebrow numbering, per-card icon picking (CN+EN keyword table), and English stock-photo queries.

```bash
node generate.js --outline examples/ai-healthcare-outline.json
node generate.js --outline mine.json --out output/mine.pptx --no-images
```

Each section is `{kind, title, ...}`. Terse fields expand automatically — e.g. an `iconGrid` takes `items: ["医学影像", "药物研发", ...]` (strings) and each becomes a card with an auto-picked icon + image query:

```jsonc
{
  "topic": "AI 在医疗领域的应用", "theme": "healthcare",
  "sections": [
    { "kind": "iconGrid", "title": "六大场景", "items": ["医学影像", "药物研发", "基因测序", "健康管理"] },
    { "kind": "chart",    "title": "准确率",   "cats": ["肺结节","眼底"], "vals": [96,94], "suffix": "%" }
  ]
}
```

- `kind` ∈ `cover / divider / agenda / stats / iconGrid / chart / flow / pipeline / twoCol / quadrant / future / table / closing` (same 12 types).
- Cover, agenda (when ≥3 content sections), and closing are auto-added if you don't write them.
- **Validation is built in**: `generate.js` runs `validateSlides` before building and prints exact errors if the LLM emitted a malformed array. `--spec file.json` builds from a full pre-written `slides` array (pass-through mode).
- **LLM prompt**: `prompts/generate-deck.md` — feed it to any LLM to turn a topic into an outline or full spec.

## Edit an existing deck (apply_edits)

Two modes. The deck's source spec is saved automatically as `<deck>.pptx.spec.json` on every `build()`, so spec-mode works on anything this harness generated.

```bash
# spec-mode: rebuild from the saved spec with edits applied (full power — any slide type)
node edit.js --spec examples/output/deck.pptx.spec.json --edits my-edits.json

# live-mode: edit ANY .pptx in place via python-pptx (text replace / delete / reorder)
node edit.js --live some-other-deck.pptx --edits my-edits.json
```

`my-edits.json` is a JSON array of ops. Address slides by **stable id** (`"s3"`, preferred) or **1-based number**. Spec-mode ops:

```jsonc
[
  { "op": "setTitle",  "id": "s1",  "title": "新标题" },
  { "op": "patch",     "id": "s4",  "patch": { "sub": "更新副标题" } },   // deep-merge
  { "op": "set",       "slide": 5,  "field": "note", "value": "数据来源…" },
  { "op": "insert",    "after": "s2", "spec": { "t": "twoCol", "title": "…", "left": {…} } },
  { "op": "delete",    "slide": 8 },
  { "op": "move",      "id": "s9",  "after": "s6" },
  { "op": "append",    "spec": { "t": "closing", "title": "…" } },
  { "op": "theme",     "theme": "midnight" },
  { "op": "typography","typography": { "headingFont": "Cambria" } }
]
```

(`op` also includes `replace` / `unset` / `footerLabel` / `title`; see `examples/edits-healthcare.json`.) The edited spec is re-validated before rebuild. Live-mode ops: `{op:"replaceText", slide?, find, replace}` (`slide` omitted = all slides), `{op:"deleteSlide", slide}`, `{op:"reorder", order:[3,1,2,…]}` — best-effort, no layout awareness.

## Beautify / re-layout an existing deck

Take a deck that's content-correct but visually rough and re-flow it through the polished layouts: re-type each slide to the layout that fits its content, snap card counts to "magic" grid numbers (3/4/6), trim over-long text, drop thin/empty slides, and restore cover/agenda/closing.

```bash
# from a harness deck's saved spec
node beautify.js --spec examples/output/deck.pptx.spec.json --out deck-v2.pptx

# from ANY .pptx (import its text + tables, then re-layout) — --compare renders before PNGs too
node beautify.js --import some-ugly-deck.pptx --out beautified.pptx --compare
```

The re-layout is a deterministic taste engine (no vision model) and **logs every decision**:

```
BEAUTIFY (aggressive re-layout) — 4 change(s):
  • trim iconGrid.cards 7→6 (3×2 grid)
  • re-type iconGrid(5 items) → flow        # detected 第一步…第五步 = sequential
  • add cover (missing)
  • add agenda (≥4 content slides)
```

Re-type rules (content shape → layout): a flat list of 5–6 short items → `iconGrid`; 4 → `quadrant`; 3 → `iconGrid`; sequential ("第一步/phase/流程…") 3–6 → `flow`/`pipeline`; a big number + context → `stats`. `--gentle` skips re-typing and only prunes/balances/normalizes (respects the author's chosen layouts). Imported text bullets of the form `"标题：描述"` are split into card title + desc automatically.



```
ppt-harness/
  harness.js            # build() + 12 slide-type renderers (+ saves <deck>.spec.json)
  generate.js           # CLI: outline/spec → .pptx
  edit.js               # CLI: apply_edits (spec-mode rebuild / live-mode python-pptx)
  beautify.js           # CLI: re-layout an existing deck (spec or import any .pptx)
  lib/
    palette.js          # 4 palettes + coerce() for LLM-authored custom palettes
    style.js            # visual design axes (header/cover/card/decorate) + 5 named style bundles
    typography.js       # fonts & sizes (LLM-re-decidable)
    elements.js         # pptxgenjs primitives + fit-text/fit-bullets engine
    icons.js            # react-icons → PNG → dataURL (cached)
    images.js           # Pexels/Unsplash/Pixabay + local + svgHero, curl-based
    qa.js               # validate.py (PYTHONUTF8) + LibreOffice→PDF→PyMuPDF + lint
    schema.js           # slide-type schema + validateSlides()
    generate.js         # outline → slides compiler (icons/imgs/cover/agenda/closing auto)
    edit.js             # applyEdits (spec-mode) + applyEditsLive (python-pptx)
    beautify.js         # beautifySpec (re-type/prune/balance) + importPptx (any .pptx)
  prompts/generate-deck.md   # LLM prompt template (topic → outline/spec)
  examples/             # ai-healthcare*.js + ai-healthcare-outline.json + edits-healthcare.json
  .env                  # image API keys (gitignored)
```

## Machine-specific notes (this Windows box)

- **LibreOffice** lives at `D:\Program Files\LibreOffice\program\soffice.exe` (not in PATH). `qa.js` finds it automatically; override with `SOFFICE` env.
- The skill's Python scripts crash with `gbk codec` errors on zh-CN Windows — `qa.js` runs them with `PYTHONUTF8=1`.
- No `pdftoppm`/poppler — preview rendering uses **PyMuPDF** (`pip install pymupdf`).
- **Proxy `127.0.0.1:7892` is often down**. npmjs / Pexels / Unsplash are reachable *directly*; do NOT set `https_proxy` unless the proxy is actually up (it makes requests hang).

## How this maps to the bigger vision (`PPT_Harness_Design.md`)

This harness is the **usable, demonstrable core** of the design doc's plan — it delivers the "generate a polished deck end-to-end" flow with a clean, extensible tool layer:

| Design-doc component | Status here |
|---|---|
| Tool layer + render + validate | ✅ `lib/` (elements/icons/images/qa) |
| Template/brand memory | ✅ `lib/palette.js` + slide-type renderers |
| LLM topic/outline → slides array | ✅ `lib/generate.js` (outline compiler) + `lib/schema.js` (validator) + `generate.js` CLI + `prompts/generate-deck.md` |
| Edit existing deck (Diff Problem) | ✅ `lib/edit.js` (spec-mode rebuild + live-mode python-pptx) + `edit.js` CLI |
| Beautify / re-layout (排版) | ✅ `lib/beautify.js` (re-type + prune + balance + `importPptx` for any .pptx) + `beautify.js` CLI |
| Hybrid verification (lint → render → vision) | ⚠️ render+validate+lint done; **vision-judge loop not yet wired** (next step) |
| Orchestrator (ReAct agent loop) | ⚠️ declarative `build()`/`generate`/`edit` for now; an LLM can drive them |

Natural next step: add a vision-judge that scores the preview PNGs and feeds fixes back (the remaining piece of the hybrid-verification loop).
