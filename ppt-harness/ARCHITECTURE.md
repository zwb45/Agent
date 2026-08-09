# ppt-harness 框架详解与构造流程

> 本文是对 `ppt-harness` 这个"PPT 生成 harness"的完整架构说明，重点讲清楚**它是怎么从一个 slides 数组，一步步变成一份带图标、配图、自动排版、可校验、可预览的 `.pptx` 的**（即"构造流程"）。
>
> 配套阅读：`README.md`（用法速查）、`harness.js`（主逻辑）、`lib/`（工具层）。

---

## 0. 一句话定位

ppt-harness 是一个**声明式（declarative）的 PPT 生成框架**：你给它一个"幻灯片规格数组（slide specs）"，它负责把每一页渲染成精致的 `.pptx`，再结构化校验、再渲染成 PNG 预览图供人工/视觉 QA。

它建立在 Anthropic 官方的 [`pptx` skill](https://github.com/anthropics/skills/tree/main/skills/pptx)（底层是 `pptxgenjs`）之上，**额外补齐了两件官方 skill 没做的事**：

1. **富图标**：用 `react-icons`（lucide / tabler / phosphor…）把 SVG 图标光栅化成 PNG 嵌进 PPT，而不是只能画几何形状。
2. **真实配图**：接入 Pexels / Unsplash / Pixabay 开源图库（失败再回退到程序化生成的 SVG 插画），让版面"图文并茂"。

```
slide specs (JSON-ish)
        │
        ▼
   harness.build()
        │
        ├─ lib/palette.js     主题配色 (4 套)
        ├─ lib/typography.js  字体 & 字号 (可被 LLM 覆盖)
        ├─ lib/elements.js    pptxgenjs 原语 + 文本自动撑满引擎
        ├─ lib/icons.js       react-icons → PNG (缓存)
        ├─ lib/images.js      图库 → 图片 buffer (缓存)
        │
        ▼
   .pptx  →  lib/qa.js 校验(validate) + 内容 lint  →  渲染 PNG 预览
```

---

## 1. 整体架构（模块地图）

```
ppt-harness/
├── harness.js            # build() 入口 + 12 个页面渲染器(RENDERERS) + 共享辅助函数 (+ 落盘 spec.json)
├── generate.js           # CLI: 大纲/裸 spec → .pptx
├── edit.js               # CLI: apply_edits(spec-mode 重渲染 / live-mode python-pptx)
├── beautify.js           # CLI: 既有 deck 重排版(spec 或 import 任意 pptx)
├── chat.js               # 交互式接口(REPL): 自然语言提需求 → 研究→大纲→渲染; 支持追问/换主题/加页
├── lib/
│   ├── palette.js        # 4 套主题配色 + coerce()(LLM 自定义色板补全)
│   ├── style.js          # 版式四轴(header/cover/card/decorate) + 5 个成套示例风格
│   ├── typography.js     # 字体与字号集中配置, build({typography}) 可覆盖
│   ├── elements.js       # pptxgenjs 布局原语 + 文本自适应(fitText/fitBullets)引擎
│   ├── icons.js          # react-icons → SVG → PNG(sharp), 缓存于 .cache/icons/
│   ├── images.js         # Pexels/Unsplash/Pixabay + local + svgHero, curl 下载, 缓存
│   ├── qa.js             # validate.py(PYTHONUTF8) + LibreOffice→PDF→PyMuPDF→PNG + 内容 lint
│   ├── schema.js         # 12 类页面的字段 schema + validateSlides() 校验器
│   ├── generate.js       # 大纲 → slides 编译器(自动图标/配图/封面/导览/结语/编号)
│   ├── edit.js           # apply_edits: spec-mode(改 spec 再 rebuild) + live-mode(python-pptx)
│   ├── beautify.js       # 美化引擎(按内容重选版式/凑魔法数/裁剪/补结构) + importPptx(任意 pptx)
│   ├── llm.js            # Anthropic 兼容端点(GLM)瘦客户端: ask/askJson + 服务端 web_search + 并发
│   ├── research.js       # 联网研究引擎: 多角度检索 → 聚合去重排序 → 研究简报(数据/案例/趋势/来源)
│   ├── outline.js        # 研究简报 → 内容丰满的 outline JSON(数字→stats, 案例→table, 趋势→future)
│   ├── orchestrator.js   # 编排器: generateDeck / generateFreeformDeck + buildWithReview 闭环 + 颜色归一化
│   ├── layout-qa.js      # 几何校验: E-recorder 捕获每元素 box + analyze(越界/重叠/留白) 纯矩形数学
│   ├── freeform.js       # 自由版式渲染器(RENDERERS.free): 10 种元素工具箱, LLM 决定构图, harness 只渲染 + 对比度护栏
│   ├── freeform-deck.js  # 自由版式 deck 生成: 简报→规划→按 8 种构图原型逐页设计(封面极简/浅色, 失败自动重试)
│   ├── color.js          # WCAG 颜色对比度: lum/contrast/readableOn, 供 freeform 自动修正低对比文字
│   └── review.js         # LLM 审查修订: 拿 layout-qa 报告让 LLM 重排元素/增密内容, 配合 buildWithReview 闭环
├── prompts/generate-deck.md   # 给 LLM 的提示模板(主题 → 大纲/spec)
├── examples/             # 示例 deck + ai-healthcare-outline.json + edits-healthcare.json
├── .cache/               # 图标/图片缓存 (gitignored)
├── .env                  # 图库 API key (gitignored)
└── package.json          # 依赖: pptxgenjs / react / react-dom / react-icons / sharp
```

整个框架可以分为**四层**：

| 层 | 文件 | 职责 |
|---|---|---|
| **入口/编排层** | `harness.js` | 接收 `build(opts)`，遍历 slides，分发到对应渲染器，写出文件，触发 QA |
| **渲染器层** | `harness.js` 里的 `RENDERERS` | 12 种页面类型，每种知道"这一页该怎么摆" |
| **原语层** | `lib/elements.js` | 与 pptxgenjs 对齐的最小积木：圆角矩形、椭圆、文本、图片盒、徽章、页眉页脚 |
| **资源层** | `lib/icons.js` `lib/images.js` | 把"图标规格/搜索词"变成可嵌入的图片 dataURL |
| **质量层** | `lib/qa.js` | 结构校验 + 内容 lint + 预览渲染 |

---

## 2. 三个核心抽象

理解这三件事，就理解了整个框架的设计哲学。

### 2.1 Spec（声明规格） → Renderer（渲染器）的分发模型

每一页幻灯片就是一个普通 JS 对象，**必填字段只有 `t`（页面类型）**：

```js
{ t: 'iconGrid', eyebrow: '03 · 应用', title: '六大核心应用场景',
  cards: [ { icon: 'lu/LuScanLine', title: '医学影像', desc: '...', img: 'x ray ct scan' }, ... ] }
```

`build()` 里就是一张查找表分发：

```js
const fn = RENDERERS[spec.t];   // harness.js:372
if (!fn) { console.warn('unknown slide type:', spec.t); continue; }
const s = p.addSlide();
await fn({ p, E, C, T, s, spec, total, i: k + 1, img });
```

每个渲染器收到一个统一的上下文对象 `{ p, E, C, T, s, spec, ... }`：

- `p` — pptxgenjs 实例（用来取 `ChartType`、`ShapeType` 等枚举）
- `E` — elements 原语工厂（`lib/elements.js` 的产物，绑定好了配色 C 和字体 T）
- `C` — 当前主题配色对象（palette）
- `T` — 当前字体/字号配置（typography）
- `s` — 当前这一页的 slide 对象（pptxgenjs）
- `spec` — 这页的声明规格
- `total` / `i` — 总页数 / 当前页码（页脚用）
- `img` — 图片模块（`useImages:false` 时为 `null`，渲染器据此走"离线纯图标"分支）

**这意味着：加一种新页面 = 写一个 `RENDERERS.新类型 = async ({E,C,T,s,...}) => {...}`，零侵入。**

### 2.2 原语层 E：所有渲染器都只调这一层

渲染器几乎不直接碰 pptxgenjs，而是调 `E.xxx()`。`E` 由 `elements.make(p, C, T)` 工厂生成，把"配色 + 字体"闭包绑死，所以调用点非常干净：

```js
E.bg(s, C.offWhite);                       // 背景填色
E.header(s, i, spec.eyebrow, spec.title, total, spec.sub);  // 统一页眉(眉标+标题+副标题+页脚)
E.rrect(s, x, y, w, h, { fill: C.white, radius: 0.1, shadow: true });  // 圆角卡片
await E.iconBadge(s, x, y, d, 'lu/LuBrain', col, C.white);            // 彩色圆 + 居中图标
E.fitText(s, x, y, w, h, title, { minSize, maxSize, bold:true });      // 自适应字号文本
E.fitBullets(s, x, y, w, h, bullets);                                 // 自适应 + 撑满的项目列表
E.imageBox(s, x, y, w, h, dataUrl, { plain:true });                  // 图片盒(cover 裁剪, 不变形)
```

E 提供的原语（`lib/elements.js`）：

| 原语 | 作用 |
|---|---|
| `bg` | 整页背景色 |
| `rect` / `rrect` | 矩形 / 圆角矩形（可填色、透明度、描边、阴影） |
| `oval` | 椭圆/圆（徽章、装饰光斑） |
| `text` | 普通文本（带默认字体/配色） |
| `fitText` | **自适应字号文本**：在 `[min,max]` 区间挑"能填满盒子且不溢出"的最大字号 |
| `bullets` / `fitBullets` | 项目符号列表；`fitBullets` 还会**放大段间距让短列表撑满盒子** |
| `header` / `footer` | 统一页眉（眉标药丸 + 标题 + 副标题 + 页脚页码） |
| `numBadge` | 编号圆徽章 |
| `iconBadge` | 彩色圆 + 居中 react-icon |
| `imageBox` | 图片盒，默认 `cover` 裁剪（不拉伸），`plain:true` 表示图已按比例预裁 |

### 2.3 资源层：图标/图片都统一成 "dataURL"

pptxgenjs 的 `addImage` 只接受 dataURL 或文件路径。为了让渲染器无差别使用，`icons.js` 和 `images.js` 都把最终产物归一成 `'image/png;base64,...'`：

- **图标**：`react-icons` 组件 → `renderToStaticMarkup` 得到 SVG → `sharp` 光栅化成 PNG → base64。按 `spec|color|size|bg` 做磁盘缓存。
- **图片**：搜索词 → Pexels/Unsplash/Pixabay API → curl 下载 buffer → `sharp` 归一化（>1600px 缩到 1600）→ 缓存 → base64。全部失败时由 `svgHero` 程序化生成一张抽象 SVG 插画兜底（**永远不崩**）。

---

## 3. 构造流程详解（重点）

下面按时间顺序，逐步追踪一次 `build()` 调用的完整生命周期。

### 阶段 0 — 初始化与依赖装配（`build()` 开头，harness.js:351）

```js
const C = typeof theme === 'string' ? palette.get(theme) : theme;  // 配色对象
const T = typography.make(opts.typography);                        // 字体/字号(合并覆盖)
const p = new pptxgen(); p.layout = 'LAYOUT_WIDE';                 // 16:9 (13.33"×7.5")
const E = Efactory.make(p, C, T);                                  // 原语工厂, 绑定 C+T
const img = useImages ? images : null;                             // 关图就是离线模式
```

几个全局常量贯穿所有渲染器（harness.js:14）：

```js
const W = 13.33, H = 7.5, M = 0.6, CW = W - 2 * M;
// 画布宽 / 高 / 左右页边距 / 内容区宽度
```

所有页面都用同一套 16:9 画布 + 0.6" 边距网格，保证视觉一致。

### 阶段 1 — 逐页渲染（harness.js:370 主循环）

```js
for (let k = 0; k < slides.length; k++) {
  const spec = slides[k];
  const fn = RENDERERS[spec.t];            // ① 查渲染器
  const s = p.addSlide();                  // ② 新建一页
  if (spec.notes) s.addNotes(spec.notes);  //    讲者备注
  await fn({ p, E, C, T, s, spec, total, i: k+1, img });  // ③ 渲染
}
```

**单个渲染器内部通常做这 4 件事**（以 `iconGrid` 为例，harness.js:159）：

1. **铺底**：`E.bg(s, C.offWhite)` + `E.header(...)`（眉标药丸 + 标题 + 副标题 + 页脚页码）。
2. **算内容区**：`leadAndTop(E,C,T,s,spec)` 算出"有 lead 引言则下移、有 note 脚注则上收"后的可用内容带 `{y0, bot, ch}`（harness.js:58）。这一步让**每一页都能可选地加引言/脚注而不破坏布局**。
3. **分支**：如果有图片模块且未禁图，走 `imageCards(...)`（每张卡片配一张相关图）；否则走纯图标卡片网格。
4. **逐卡片绘制**：圆角卡 → 图（或图标徽章兜底）→ `fitText` 标题 → `fitText` 描述。字号由 fit 引擎在 `[Min,Max]` 区间自动挑。

> `leadAndTop` 和 `imageCards` 是被多个渲染器复用的共享辅助函数，体现了"通用版式逻辑下沉、渲染器只管特化"的设计。

### 阶段 2 — 文本自动撑满（fit 引擎，lib/elements.js）

这是这个框架**区别于普通 pptxgenjs 脚本**的核心竞争力之一：文本不是写死字号，而是**自适应填满给定的盒子**。

`estLines(text, fsPt, boxWIn)`（elements.js:10）按字符宽度估算换行：

- CJK / 全角字符 ≈ `1.04em`
- 空格 ≈ `0.30em`
- 拉丁/数字/标点 ≈ `0.56em`

`fitText`（elements.js:74）在 `[minSize, maxSize]` 之间以 0.5pt 步长搜索**最大的、且 `行数×行高 ≤ 盒高×92%`** 的字号（92% 是安全余量，保证在真实 LibreOffice/PowerPoint 渲染下也不溢出）。单行文本默认垂直居中。

`fitBullets`（elements.js:102）更进一步：

1. 先按同样逻辑挑最大能放下的字号；
2. 如果列表偏短、盒子还有大片空，就**自动放大段间距**（`paraSpaceAfter`），让几个 bullet 均匀撑满整个盒子——避免"三条短 bullet 挤在顶部，下面空一大片"。

效果：**无论文案长短，版面始终"饱满"且不溢出**。

### 阶段 3 — 弹性写出 `writeResilient`（harness.js:32）

直接 `fs.writeFileSync` 在 Windows 上有个常见坑：**目标 `.pptx` 如果正被 PowerPoint 打开，写入会崩**。框架用三段式兜底：

1. 先写到隐藏临时文件 `.<base>.tmp-<pid>.pptx`；
2. 尝试 `rename` 覆盖目标，失败则重试 3 次（每次间隔 500ms）；
3. 仍失败 → 找一个不存在的 `<name>-2.pptx` / `-3.pptx` … 写入，并打印提示告诉用户"原文件被占用，已改用备用名"。

**结果：构建永远不会因为文件锁而崩溃**，且会明确告诉你它最终写了哪个文件。

### 阶段 4 — QA：结构校验 + 内容 lint（lib/qa.js，harness.js:384）

写完文件后立即做两件事：

**4a. 结构校验 `qa.validate(file)`（qa.js:36）**
- 定位官方 skill 的 `validate.py`（先找克隆仓库，再找插件缓存）。
- 用 `spawnSync` 跑 `python validate.py <file>`，**强制 `PYTHONUTF8=1`**（规避 zh-CN Windows 下 `gbk codec` 崩溃）。
- 解析输出，匹配 `All validations PASSED` 判定通过，打印 `VALIDATE: PASS / ISSUES`。

**4b. 内容 lint `qa.lintContent(file)`（qa.js:80）**
- 用 `python-pptx` 读出每页文本，扫描"设计元信息/自我指涉"的脏文案（不该出现在成品里的词）：
  - 字面量：`配图`、`这一页`、`本页`、`该页`、`这页`、`图文并茂`、`文图并茂`
  - 正则：`每…图`（抓"每个议题配一张相关配图"这类元描述）
- 命中则逐条打印 `slide N [命中词] 片段`，提醒"交付前删除"；干净则打印 `LINT: clean`。

这一步是为了防止 LLM 在生成文案时，把"对设计师的版式说明"误当成正文写进 PPT。

### 阶段 5 — 预览渲染 `qa.renderAll`（qa.js:50，harness.js:396）

```
.pptx  --soffice headless-->  .pdf  --PyMuPDF(150dpi)-->  preview/<base>-NN.png
```

- 定位 LibreOffice（D 盘优先，可 `SOFFICE` 环境变量覆盖），`--headless --convert-to pdf`。
- 用内联 Python 脚本调 PyMuPDF（`fitz`）把每页渲染成 150dpi PNG（本机没装 poppler/`pdftoppm`，故用 PyMuPDF 兜底）。
- 输出到 `<输出目录>/preview/`，一页一张图，供人工或后续"视觉评判"做 QA。

至此一份"可编辑 `.pptx` + 校验报告 + 预览图"的完整交付物就产出了。

---

## 4. 12 种页面类型（RENDERERS）

| `t` | 用途 | 关键字段 | 版式要点 |
|---|---|---|---|
| `cover` | 封面（极简、主题聚焦） | `eyebrow/title/subtitle/img/meta` | 全幅照片 + 半透明遮罩 + 大标题；刻意不堆内容 |
| `divider` | 章节分隔（全幅图） | `eyebrow/title/subtitle/img/points` | 同封面风格，可带最多 3 个圆点要点 |
| `agenda` | 2×3 编号导航卡 | `items:[{title,desc}]` | 编号圆徽章 + 标题 + 描述 |
| `stats` | 大数字行 + 两栏要点 | `stats:[{big,label,sub}]` `cols:[{title,bullets}]` | 上排彩色数字卡，下排两栏 bullet |
| `iconGrid` | 3×2 卡片，**默认每卡一张图** | `cards:[{icon,title,desc,img?}]` | 有图走缩略图卡，无图走图标卡 |
| `chart` | 左文+右原生柱状图（美化） | `lead/bullets/stat/chart:{cats,vals,...}` | pptxgenjs 原生 chart，配色统一 |
| `flow` | 数字行 + N 步流程（图标+箭头） | `stats` `steps:[{icon,title,desc}]` | 步骤间 `→` 连接 |
| `pipeline` | 数字行 + 水平里程碑管线 | `stats` `phases:[{title,desc,accel?}]` | 轨道 + 编号节点，`accel` 标"AI 加速" |
| `twoCol` | 左文卡 + 右图（或右统计卡） | `left:{title,lead,bullets}` `img/caption` 或 `right:[{big,label}]` | 有 `img` 走图文，否则右栏排小统计卡 |
| `quadrant` | 2×2 卡（默认每卡一图） | `cards:[{icon,title,desc,img?}]` | 横排图标+标题+描述 |
| `future` | 3 张高卡（默认每卡一图） | `cards:[{icon,title,desc,img?}]` | 装饰圆光斑 + 图标 + 长描述 |
| `table` | 美化数据表（彩表头/斑马纹/徽章单元格） | `columns:[{header,key,w,align}]` `rows:[{key:值\|{text,color,bold}}]` | 可选右侧配图 |
| `closing` | 深色结语页（极简） | `eyebrow/title/sub/thanks/note` | 与封面呼应，留白突出主题 |

**通用 richness 字段**（多数内容页支持）：`sub`（标题下斜体副标题）、`lead`（引言）、`note`（底部来源/免责声明）、`notes`（讲者备注）。

---

## 5. 配色与字体（可被 LLM 重新决定）

### palette.js — 4 套主题
每套都包含：`dark/primary/mint/mintLt/coral/amber/violet`（语义色）+ `ink/slate/muted`（文字灰阶）+ `offWhite/cardTint/white`（背景）+ `accents[]`（徽章/图标的循环强调色）。hex 不带 `#`，6 位（pptxgenjs 要求）。

- `healthcare`（默认）：可信的青绿 + 薄荷 + 珊瑚活力色
- `midnight`：海军蓝 + 冰蓝
- `charcoal`：高级深灰
- `berry`：暖色莓果 + 奶油

### typography.js — 集中字体/字号
所有字号集中在 `DEFAULT.sizes`，通过 `build({ typography })` 覆盖任意子集，遗漏项保留默认。这**让 LLM 在生成后能"再决定"字体与字号并重新生成**（README 所说的 "LLM-re-decidable"）。

```js
build({ typography: { headingFont:'Cambria', bodyFont:'Calibri',
                      sizes:{ slideTitle:34, cardDescMax:17 } } })
```

字号键覆盖：封面/结语字号、页眉带字号、各网格的卡片 `TitleMin/Max` & `DescMin/Max`（自动 fit 的上下界）、数据字号（`statBig/flowBig/pipeBig/chartStatBig`）、正文 `bullets/body`。

---

## 6. 关键设计决策（为什么这么做）

1. **声明式而非命令式**：用户只描述"要什么"，渲染器负责"怎么摆"。这让 LLM 只需产出一个 slides 数组即可，不必懂 pptxgenjs。
2. **原语层 + fit 引擎**：文本自动撑满盒子，解决"AI 生成的文案长短不一 → 版面空旷或溢出"的核心痛点。
3. **每张卡片一张相关图**：`iconGrid/quadrant/future` 默认给每张卡配独立配图（query = `card.img` ‖ `card.title`），而不是"一张图配一组项"。取不到图的卡片自动回退到图标徽章。
4. **图片永远不变形**：卡片缩略图先用 `sharp` `cover` 裁到精确比例再放置，绝不拉伸。
5. **永远不崩**：图片失败 → `svgHero` 兜底；图标缺失 → 回退成圆点；文件被锁 → 自动备用名；离线 → `--no-images` 走纯 SVG/图标。
6. **环境适配内建**：zh-CN Windows 的 `gbk codec` 问题用 `PYTHONUTF8=1` 绕开；LibreOffice 不在 PATH 就硬编码 D 盘路径；没 poppler 就用 PyMuPDF；HTTP 用 `curl`（本机比 node-fetch 稳）。
7. **内容 lint 防脏文案**：交付前自动扫"设计元信息/自我指涉"文案，防止 LLM 把版式说明当正文。
8. **缓存优先**：图标按 `spec|color|size|bg`、图片按 URL sha1 缓存到 `.cache/`，重复构建零网络。

---

## 7. 扩展指南

### 加一种新页面类型
1. 在 `harness.js` 写 `RENDERERS.新类型 = async ({E,C,T,s,spec,total,i,img}) => {...}`。
2. 用 `E.bg/E.header/E.rrect/E.fitText/...` 拼版式；内容带用 `leadAndTop(...)` 拿到 `{y0,bot,ch}`。
3. 想要"每卡一图"就调现成的 `imageCards(...)`。
4. 在 `typography.js` 加该类型专用的字号键（可选）。
5. README 表格补一行。无需改任何 lib。

### 加一套主题
在 `palette.js` 的 `PALETTES` 加一项，字段齐全即可，`build({theme:'新名'})` 直接可用。

### 加一个图库供应商
在 `images.js` 写一个 `async function xxx(query, opts)`（返回 `{buf,source,url}`）并挂 `.available()`；在 `getImage` 的 provider 链里加上即可。把 key 放进 `.env`，零代码改动即可切换/启用。

---

## 8. 运行方式

```bash
cd D:\Proj\Agent\ppt-harness

# 跑示例（在线，带真实配图）
node examples/ai-healthcare.js

# 离线模式（纯图标/SVG 插画，不联网）
node examples/ai-healthcare.js --no-images
```

产出：`examples/output/<name>.pptx`（已校验）+ `examples/output/preview/<name>-NN.png`（每页一张预览）。

> 依赖（`pptxgenjs react react-dom react-icons sharp`）已装在父目录 `D:\Proj\Agent\node_modules`，无需 `npm install`。把本文件夹移走则需就地 `npm install`。

---

## 9. 生成与编辑（feature: 大纲→PPT / apply_edits）

在"构造流程"之上，框架新增了两个把 LLM 接进来的入口：

### 9.1 大纲 → slides（`lib/generate.js` + `generate.js` CLI + `lib/schema.js`）

让 LLM 只写一份**极简大纲** `{topic, sections:[{kind,title,...}]}`，编译器 `outlineToSlides` 自动补完：

- 自动生成 cover（来自 topic）、agenda（≥3 个内容节时，章节标题汇总）、closing；
- 内容页自动编号眉标 `01 · 背景 / 02 · 应用 …`（`KIND_LABEL` 映射）；
- 每张卡片/步骤用 CN+EN 关键词表 `pickIcon` 选 react-icon；`imgQuery` 把中文标题转成英文图库搜索词；
- 给每页分配稳定 `id`（s1, s2 …）供编辑定位；
- 也支持**直传模式**：`outline.slides` 已是完整 spec 时原样透传。

产出后用 `lib/schema.js` 的 `validateSlides` 做**前置校验**（未知类型 / 类型错 / 必填缺失），错了精确报错再修，不把坏数组喂给 pptxgenjs。`prompts/generate-deck.md` 是给 LLM 的提示模板。

```
主题 + 大纲  ──outlineToSlides──▶  slides[]  ──validateSlides──▶  build()  ──▶  .pptx + spec.json
```

### 9.2 apply_edits（`lib/edit.js` + `edit.js` CLI）

每次 `build()` 都会把源 spec 落盘为 `<deck>.pptx.spec.json`（含自动 id）。编辑就两条路：

- **spec-mode（首选，全功能）**：加载 spec.json → `applyEditsToSpec` 在 slides 数组上做编辑算子 → 再 `build()` 重渲染。算子：`setTitle/set/patch/unset/replace/insert/append/delete/move`（按 `id` 或 1-based 定位）+ spec 级 `theme/typography/footerLabel/title`。本质就是"改源码再重渲染"，任何页面类型都能彻底改。
- **live-mode（任意 pptx，尽力而为）**：`applyEditsLive` 用 python-pptx 直接改文件：`replaceText`（按段落聚合 run 后替换，跨 run 也能命中）/ `deleteSlide`（删 sldIdLst + drop_rel）/ `reorder`。给非本框架生成的 deck 用。

```
既有 deck
   ├─ 有 spec.json ──▶ applyEdits(spec) ──▶ rebuild ──▶ 新 .pptx + 新 spec.json
   └─ 任意 .pptx    ──▶ applyEditsLive(python-pptx) ──▶ 改后 .pptx
```

### 9.3 美化/重排版（`lib/beautify.js` + `beautify.js` CLI）

把"内容对、但版面糙"的 deck 重新走一遍精致版式。两条入口：

- **`beautifySpec(spec, {mode, theme})`**：在 spec 上做多 pass 美化，每步改动写入 `log`（透明可审）：
  1. **裁剪**（`pruneText`）：标题/副标题/卡片描述/bullet 按显示权重（CJK=1, 西文=0.5）截到阈值，优先在标点处断句 + …。
  2. **凑魔法数**（`balanceCounts`）：iconGrid≤6、quadrant≤4、future≤3、flow/pipeline≤6、每列 bullet≤6——多了就删多余的。
  3. **重选版式**（`reType`，aggressive 模式）：抽取出每页的中性内容（items/bullets/stats/table），按内容形状挑最合适的 `t`——5~6 项→`iconGrid`，4 项→`quadrant`，3 项→`iconGrid`，序贯（"第一步/phase/流程"）3~6→`flow`/`pipeline`，大数字→`stats`；2 项或不明确就保留原类型（避免 2 卡片的稀松网格）。bullet 形如 `"标题：描述"` 自动拆成卡片标题+描述。
  4. **删薄页**（`shouldDrop`）：只有标题没有内容、或全空的内容页删除。
  5. **补结构**（`ensureStructure`）：缺封面/结语就补，内容页≥4 缺导览就补。
  6. **归一化**（`normalize`）：补缺失图标/配图词、重编眉标、分配 id。
- **`importPptx(pptx)`**：用 python-pptx 把**任意** .pptx 的每页（按字号最大段判定标题，其余为 bullet；抓取表格）抽成粗 spec，再交给 `beautifySpec` 重排——"丑 PPT → 精致版"。

```
任意 .pptx ──importPptx──▶ 粗 spec ──beautifySpec──▶ 精致 spec ──build──▶ 美化后 .pptx + 预览
本框架 deck.spec.json ─────beautifySpec──▶ 精致 spec ──build──▶ 美化后 .pptx
```

CLI：`node beautify.js --spec <spec.json>` 或 `--import <ugly.pptx>`，`--gentle` 只裁剪不重排，`--import ... --compare` 同时渲染原图 PNG 便于前后对比。审美判断目前是确定性启发式（无视觉模型）；配合 `qa.renderAll` 出预览图做人工/后续 vision-judge 的对照。

### 9.4 视觉设计系统（`lib/style.js` + `palette.coerce`）—— 让 deck 不再"一个模子"

根因：原先只有一套版式 DNA（页眉药丸、全幅图封面、白底阴影卡片），任何主题都长得一样。解决方式不是"给 LLM 几个模板选"，而是把**长相参数化成一套设计词汇，由 LLM 直接当设计师**：

- **配色**：`build({ palette: {dark,primary,mint,...hex} })` 传任意 hex 子集，`palette.coerce()` 用默认值补全缺失字段——LLM 给主色系即可。也可用命名 `theme`（healthcare/midnight/charcoal/berry）。
- **版式四轴**：`header`(pill/bar/center) × `cover`(photo/split/solid) × `card`(shadow/flat/line) × `decorate`(ovals/bars/dots/none)，每轴独立选。5 个**成套示例** `style`(classic/editorial/minimal/tech/bold) 只是起点包，非强制菜单。
- **字体**：`typography`（headingFont/bodyFont + 36 个命名字号），LLM 可重定。
- `elements.js` 的 `header()/card()/decorate()` 按 `S`（解析后的 style）分支；`cover/closing` 渲染器按 `S.cover/S.decorate` 分支。`classic` = 原状（向后兼容）。
- **自动多样性**：大纲未指定 design 时，编译器按主题哈希 `pickStyleForTopic` 确定性挑一套非 classic 风格——不同主题自动不同长相。

```
LLM 当设计师：主题 ──▶ design{palette, typography, header, cover, card, decorate} + sections
                                 │
                                 ▼  build() 解析为 C(配色)/T(字体)/S(版式) ──▶ 渲染
不同主题 → 不同 design → 不同长相（实测：医疗→tech、汽车→bold、品牌→自定义暖色 editorial）
```

---

## 10. 与总体愿景的映射（来自 `PPT_Harness_Design.md`）

| 设计文档组件 | 本框架状态 |
|---|---|
| 工具层 + 渲染 + 校验 | ✅ `lib/`（elements/icons/images/qa） |
| 模板/品牌记忆 | ✅ `lib/palette.js` + 12 个页面渲染器 |
| LLM 主题/大纲 → slides 数组 | ✅ `lib/generate.js`（编译器）+ `lib/schema.js`（校验器）+ `generate.js` CLI + `prompts/generate-deck.md` |
| 编辑既有 deck（Diff 问题） | ✅ `lib/edit.js`（spec-mode 重渲染 + live-mode python-pptx）+ `edit.js` CLI |
| 美化/重排版（排版） | ✅ `lib/beautify.js`（重选版式 + 裁剪 + 凑魔法数 + 补结构 + `importPptx` 任意 pptx）+ `beautify.js` CLI |
| 视觉多样性 / LLM 当设计师 | ✅ `lib/style.js`（版式四轴 + 风格包）+ `palette.coerce`（自定义色板）+ `design` 字段；不同主题自动/手定不同长相 |
| **内容丰满 / 联网研究** | ✅ `lib/llm.js`+`lib/research.js`（多角度联网检索→聚合→研究简报）+`lib/outline.js`（简报→落地大纲）+`lib/orchestrator.js` |
| **交互接口** | ✅ `chat.js` REPL：自然语言提需求→研究→生成；追问/换主题/加页；`--once` 一次性 |
| 混合验证（lint → render → vision） | ⚠️ render + validate + lint 已完成；**视觉评判闭环尚未接**（下一步） |
| 编排器（ReAct agent loop） | ✅（部分）`lib/orchestrator.js` 是确定性管线；`chat.js` 是 LLM 驱动的交互入口 |

**自然的下一步**：接一个 vision-judge，对预览 PNG 打分并把修正反馈回来（混合验证闭环的最后一块）。

---

## 11. 研究驱动生成 + 交互接口（解决"内容不够丰满"）

### 11.1 问题与思路

上面 1–10 节的框架是**纯渲染/编译器**——它从不调用 LLM、从不联网。内容质量完全取决于外部 LLM 凭记忆写的大纲（`prompts/generate-deck.md`），于是常见"内容不够丰满/泛泛而谈/数字不实"。

解法（用户提出）：**先把相关材料从网上找出来，汇总，挑选最有价值的内容再放进 PPT**。新增一层"研究驱动生成"，并配一个**交互接口**让用户启动后直接提需求。

### 11.2 四个新模块 + 一个 REPL

| 文件 | 角色 |
|---|---|
| `lib/llm.js` | Anthropic 兼容端点瘦客户端（本机即 GLM `open.bigmodel.cn/api/anthropic`）。`ask/askJson/askParallel`，带服务端 `web_search_20250305` 工具开关、严格 JSON 提取+修复、并发收敛。零新依赖（Node 内置 fetch）。凭证读环境变量 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_DEFAULT_*_MODEL`。 |
| `lib/research.js` | 联网研究引擎。多角度并行检索（概况·数据·应用·趋势·案例·挑战，`depth` quick/standard/deep 切换）→ 一次聚合调用去重排序 → **研究简报** `{summary, themes[], stats[], examples[], trends[], challenges[], sources[]}`。这是"汇总、挑选最有价值"的核心。 |
| `lib/outline.js` | 把研究简报编译成 `outlineToSlides` 认得的 outline JSON，且**以简报为事实依据**：真实数字→`stats`，真实案例→`table`，真实趋势→`future`，来源写进 `note`。不编造图表数据。 |
| `lib/orchestrator.js` | 单一入口 `generateDeck(topic,opts)`：research→outline→compile→validate→build，带 `onProgress`/`onWarn` 回调；另有 `buildFromOutline`（追问时免重研究秒级重渲染）+ `sanitizeColors`（把 LLM 写的 `green`/`amber` 等颜色名归一成 hex，防 pptxgenjs 报错）。 |
| `chat.js` | **用户接口**。`node chat.js` 进入 REPL，自然语言提需求；解析主题+修饰词（深色/极简/科技/详细/不配图/快速…）；支持追问（换主题/加一页/去配图/重新生成）与 `/help /research /outline /brief /quit`；`--once` 一次性生成后退出（脚本用）。 |

### 11.3 端到端流程

```
用户: "请帮我生成一个固态电池技术的 ppt"
   │  chat.js parseRequest → topic=固态电池技术
   ▼
orchestrator.generateDeck(topic)
   ├─ [1] research    多角度联网检索 → 聚合 → 研究简报 (真实数据/案例/趋势/来源)
   ├─ [2] outline     简报 → 内容丰满的 outline (数字→stats, 案例→table, 趋势→future, note 标来源)
   ├─ [3] compile     outlineToSlides (自动图标/配图/封面/导览/结语/编号) + sanitizeColors
   ├─ [4] validate    validateSlides (喂给 pptxgenjs 前的前置校验)
   └─ [5] build       harness.build() → .pptx + .spec.json + preview PNGs
                                                              + 落盘 .brief.json / .outline.json (可追溯)
```

实测（`固态电池技术`，standard）：5 维度联网检索得 29 条原始信息点 → 9 内容页/12 张幻灯片，stats 全为真实数字（5.3GWh→36GWh 出货量、300–500Wh/kg 能量密度、65% 良率），table 列真实企业（蔚来/丰田/宁德时代/辉能/QuantumScape）与量产节点，每页 `note` 带 EVTank/前瞻产业研究院等来源。`VALIDATE: PASS` · `LINT: clean`。

### 11.4 关键设计决策

1. **研究用模型自带的服务端检索**（GLM `web_search`），不抓网页——避开反爬/网络限制，且结果自带来源链接。
2. **多角度并行 + 单次聚合**：breadth（各维度独立搜）+ aggregation（去重排序挑最有价值）= 用户要的"汇总、挑选"。
3. **简报与 outline 都落盘**（`.brief.json`/`.outline.json`），生成过程完全可追溯、可重跑。
4. **追问免重研究**：换主题色/加页/去配图只走 `buildFromOutline`（秒级），只有"重新生成"才重做研究。
5. **颜色归一化**：LLM 偶尔写 `color:"green"`，`sanitizeColors` 统一映射 hex 或丢弃，杜绝 pptxgenjs 颜色报错。
6. **零新依赖**：全程用 Node 内置 `fetch` + 现有 harness；凭证复用宿主会话环境变量，无需额外配 key。

---

## 12. 版式校验 + 自由版式 + 审查修订（解决"重复/溢出/单调/留白"）

针对第二批四个问题新增一层"几何校验 + LLM 自由设计 + 审查闭环"。

### 12.1 问题与对应

| 用户问题 | 解法 | 模块 |
|---|---|---|
| ① 图片不许重复、内容不许越出 PPT | 每套 deck 维护 `img._used` 去重集合；越界由 layout-qa 的 bounds 检查 | `lib/images.js`（`getImage({used})` 轮询 index 跳过已用 URL）、`lib/layout-qa.js` |
| ② LLM 写完后检查格式：覆盖/重叠/越界 | 渲染时**捕获每个元素的边界框**，再做确定性几何校验 | `lib/layout-qa.js`（E-recorder + `analyze`） |
| ③ 格式单调、要由 LLM 决定、harness 只提供工具 | **自由版式渲染器**：slide = `{t:'free', elements:[{k,x,y,w,h,…}]}`，LLM 决定每个元素位置；harness 只渲染+校验，不做版式决策 | `lib/freeform.js`（10 种元素工具箱）、`lib/freeform-deck.js`（按 8 种构图原型逐页设计） |
| ④ LLM 检查内容、严禁大片留白 | layout-qa 的 coverage 检测大片空区 + **LLM 审查修订闭环**：有问题就让 LLM 修订坐标/补内容，重渲染直到干净 | `lib/review.js`、`orchestrator.buildWithReview` |

### 12.2 几何捕获（E-recorder）

不改 `elements.js`、不改任何渲染器：`build()` 把 `E` 原语对象包一层 recorder（`layoutQA.wrapElements`），每次放置都按语义层级记一条 box `{layer,x,y,w,h}`。层级：`bg/chrome/decor/card/image/text/badge/shape/table/chart`。`s.addChart`/`s.addTable` 另在 slide 对象上打补丁捕获（它们绕过 E）。封面/分隔/结语（含 freeform 的 `role:'cover'/'closing'`）标记为 exempt——它们刻意留白/全幅。

### 12.3 `lib/layout-qa.js` — 确定性版式校验

`analyze(deckBoxes, {exempt})` → `{ok, issues, perSlide}`，三类检查（纯矩形数学，无 LLM）：

- **越界 out-of-bounds**：任一非装饰 box 越出 `[0,W]×[0,H]`。`decor` 层豁免（`decorate()` 故意把圆斑放到 `y:-2.0` 出血）。
- **重叠 overlap**：只判 **容器↔容器**（card/image/table/chart）与 **文字↔文字**。文字/图标压在面板上（text↔shape/card）是 freeform 的刻意叠层，**不算冲突**；近全幅 box（全幅图/遮罩）当背景豁免；一方被另一方包含 ≥70% 视为嵌套（如卡片里的文字）豁免。
- **留白 whitespace**：网格采样（0.25" 格）+ 2D 前缀和求**最大空白矩形**（不是连通域外接框——后者会把"内容四周的护城河"误判成整页空白）。非 exempt 页若最大空区 ≥20% 且最小边 ≥1.3" 即报警。

实测：标准 agenda/cover 出血 bug 被当场抓出（>6 节时 `cardH` 硬编码 /3 导致溢出，已修为按实际行数缩放）。

### 12.4 `lib/freeform.js` + `lib/freeform-deck.js` — 工具箱而非模板

`RENDERERS.free`（`lib/freeform.js`）逐个元素分派到 E 原语，零版式决策：`rect/rrect/oval/text/fit/bullets/image/icon/badge/line`。`fit`/`bullets` 复用自适应字号引擎——LLM 画盒子，引擎把字撑满（防留白的工具）。颜色接受调色板键或 hex，由 `col()` 解析。

`composeFreeformDeck(topic, brief)`（`lib/freeform-deck.js`）：① 规划：把简报分到各页意图；② 并行逐页设计，**每页轮换一种构图原型**（hero-poster / stat-dashboard / sidebar-split / bento / timeline-flow / comparison / card-grid / feature-quote）→ 每份 deck 长得都不一样；失败的页自动重试一遍。

### 12.5 `lib/review.js` + `buildWithReview` — 审查修订闭环

```
freeform 幻灯片（LLM 自由摆放）
   ▼ build（渲染 + 捕获几何）
layout-qa.analyze → 越界 / 重叠 / 留白 报告
   ▼ 有问题？
review.reviewAndRevise：freeform 页交 LLM 重排元素（消除重叠/越界、补元素填留白）；typed 页（仅留白）交 LLM 增密内容
   ▼ 重新 build，循环 ≤ maxIters（默认 2）直到干净
最终带 preview 的 .pptx
```

入口：`orchestrator.generateFreeformDeck(topic, opts)`。chat 里说"创意/自由版式"或在请求里带 `--freeform` 即走此路径。

### 12.6 设计要点

1. **harness 只提供工具不提供决策**：`RENDERERS.free` 不含任何"卡片该怎么排"的逻辑；构图完全由 LLM 决定。原有 12 个 typed 渲染器保留（向后兼容 `generate/edit/beautify`）。
2. **确定性护栏 + LLM 闭环**：几何问题用确定性的 layout-qa 抓（快、稳、可解释），修不动的再交给 LLM 修订（`review.js`），两者分工。
3. **图片去重**：`build()` 起始建 `img._used = new Set()`，`getImage({used})` 命中已用 URL 就轮询下一个 index；同一份 deck 内不会重复用图。
4. **封面/结语豁免**：留白/重叠检查对 hero 页关闭（它们刻意疏朗），但越界检查仍生效。
5. **元素数量约束**：逐页设计 prompt 限制 8–14 个元素（用少量大块面填满，而非堆砌小元素），降低重叠与 JSON 截断风险。

### 12.7 可读性与配色（对比度 + 浅色背景 + 极简封面）

针对"字体看不清/看不见"和"少用深色调"：

- **对比度护栏 `lib/color.js`**：WCAG 亮度/对比度。`freeform` 渲染时追踪每个 solid-fill 面板（z 序），对每个 text/fit/bullets 元素算出其**实际背后背景**（包含它的最上层面板，否则 slide bg），若文字对比度 < 4.5 就自动改写为白或近黑中对比更高者——**文字永远不会看不清**，无论 LLM 选了什么色。实测：深海 deck 3 处低对比（mint 字 on teal 板 2.02、muted 字 on offWhite 2.60…）→ 全部自动修正到 ≥4.5。
- **浅色背景优先**：freeform 封面/结语/内容页 prompt 一律要求浅色 bg（offWhite/white/cardTint），结语不再用 `dark`；typed `closing` 渲染器从深色 `C.dark` 改为浅色 offWhite（深色文字 + primary 点缀），整份 deck 深色背景大幅减少。
- **封面极简**：封面用独立的"极简系统提示"——只放标题(+副标题+小字)，元素 ≤6，浅色背景，大量留白；不再像内容页那样"填满画布"。（封面本就豁免留白检查。）

### 12.8 标题一致 + 案例配图 + 留白收紧

- **统一标题带**：内容页 freeform slide 用 `title`/`eyebrow`/`sub` 字段（而非 element）携带标题；`renderFree` 调 `drawTitleBand` 在顶部统一绘制"眉标 + 标题 + 副标题 + 强调短线 + 页脚页码"，全 deck 标题格式一致。composer 被要求把所有 elements 限制在内容区 `y∈[2.1,6.9] / x∈[0.6,12.7]`，顶部留给标题带。封面/结语不画标题带。
- **案例/示例必须配图**：composer 在含 `cases` 的页面要求为每个案例放一个 `image` 元素（英文搜图词，自动去重）；涉及具体产品/企业的页面也要配图。
- **留白收紧**：layout-qa 留白阈值从 20%/1.3" 收紧到 **14%/1.1"**，原先漏网的"上下两块之间的空带"（如某页 18% 空带）现在会被抓出，交给审查修订闭环填充。typed deck 在新阈值下仍 clean（已回归）。

### 12.9 杜绝"大数字方格"这种 AI 感版式

问题：多页出现"一个大数字 + 一句话单独占一个框"、且一页好几个——典型 AI 生成痕迹。

三道防线：
1. **构图层**：删除 `stat-dashboard`（大数字网格）原型，替换为 `data-story`（把数字写进完整句子/要点，或用图表）。
2. **提示层**：plan 阶段要求"数字写进 points 句子里，不单独成页堆数字"；compose 阶段硬性禁止"大数字+一句话独立方块"，一页最多 1 个突出数字且必须融入正文，数值序列改用 chart/table。
3. **检测+修订层**：`review.detectStatTiles(slides)` 扫描每张内容页——一个含"短数字文本"的 rrect/rect 即记为一个 stat-tile，**一页 ≥2 个就报错**；该问题与 layout-qa 报告合并喂给 `reviewAndRevise`，`reviseFree` 被要求把多方块改写为融入正文的要点或图表。`buildWithReview` 每轮都跑这道检测。

实测：旧 deck（商业航天产业 p3/p5/p6 分别 4/3/2 个方格）被全部检出；新生成 deck 0 个方格簇。

### 12.10 块数约束 + 图片遮挡检测

- **块数约束**：除列举/案例页外，每页**大块面（rect/rrect ≥2.5 平方英寸）≤3 个**，不要用很多小方块堆砌。composer 明确要求；`review.detectTooManyBlocks` 数大块，>3 且非"等大规整网格"（合法的 2×2/2×3 列举）即报错，交修订闭环合并/删减。
- **图片遮挡检测**：`review.detectHiddenImages`——若一个 image 元素被**数组中其后**的不透明 rect/rrect 覆盖 ≥60%（图片在下层、方框在上层 → 图片不可见、方框空白），即报错；`reviseFree` 把图片移到方框之后或删除遮挡方框。
- 两项检测与 stat-tiles、layout-qa 报告合并，`buildWithReview` 每轮都跑。

### 12.11 并列块一致性 + 块内内容饱满度

- **块内饱满 `detectThinBlocks`**：页级留白检测把文本"盒子"当填满，看不见"框大字少"的块内留白。这里改为逐个大块（≥4in² 面板）估算其内部文字的**实际渲染高度**（estLines × 字号 × 行高，含 bullets 条目）对比"可用文字区"（面板高 − 配图高 − 留白），<50% 即报"内容偏少/框内留白"，交修订闭环补充描述或 3-5 条要点。实测 mRNA p4（~39% 填充）被检出。
- **并列块一致 `detectInconsistentBlocks`**：把同一行（y 重叠 ≥50%）的 ≥2 个大块聚类为一组，比较每块的视觉特征（img/icon/无），若组内不一致即报"并列块格式不统一：都配图或都用图标"。composer 也被要求"并列大块结构完全一致"。
- **修订回归护栏 `countOverlaps`**：修订可能把"块过多"改好了却引入新的文字重叠（LLM 合并块时叠字）。`reviseFree` 比较修订前后的 `countOverlaps`（直接按元素几何算 text↔text/容器↔容器 重叠，文字对即使嵌套也算），若变多就**拒绝该次修订、保留原元素**——闭环永远不会把一页改得更差。`maxIters` 默认 3 轮，多给收敛机会。

### 12.12 图文并茂（每页/每块都要有配图）

`review.detectImageLight`：每张内容页必须有真实配图——0 图即报"缺图"；并列 ≥2 个大块但图片数 < 块数即报"并列块未都配图"。composer 硬性要求"每页必配图，多块页每个大块/案例各一张图，图片是版式主体而非可选装饰；并列块优先'都配图'统一结构"。修订闭环给缺图页补 image 元素。

### 12.13 默认微软雅黑 + 创意工具箱

- **默认字体 = 微软雅黑（Microsoft YaHei）**：`lib/typography.js` DEFAULT 的 headingFont/bodyFont 均改为 `Microsoft YaHei`（用户偏好，中文清晰通用），LLM 仍可经 `typography` 覆盖。
- **创意元素**：freeform 工具新增 `ghost`（超大半透明背景字/数字，编辑设计感，记为 `decor` 层不触发重叠）、`tag`（药丸眉标）、以及全元素 `rotate`（倾斜色块/文字/图，elements.js 各原语已转发 `rotate`）。
- **更多构图原型**：`ARCHETYPES` 扩到 9 种——hero-poster / **magazine**（杂志式出血大图+跨边标题）/ sidebar-split / **numbered**（超大序号主轴）/ bento / **bigquote**（金句海报）/ comparison / card-grid / **asymmetric**（非对称张力）。每页轮换，构图更有创意、不雷同。
- composer system/prompt 鼓励大胆用 ghost 背景字、tag 眉标、rotate 倾斜块、oval 光斑等增加设计感。

### 12.14 ghost 变淡 + 并列块填色一致

- **ghost 强制变淡**：`color.lighten(hex,0.72)` 把 ghost 颜色（无论 LLM 给什么）往白混 72%，且字号封顶 200pt——ghost 永远是**淡淡的底层点缀**，不会出现"大字盖住正文"（曾出现 360pt 实色 "03" 压住内容）。
- **并列块填色一致**：`detectInconsistentBlocks` 的特征签名加入**填色类别**（`color.fillCategory`：light/dark/accent；palette 键也有映射）。同一行并列大块若填色类别不同（如两个白底 light + 一个深底 dark）即报"填色不统一：都白底/都浅底/都深底"。composer 也明确要求"并列块填色相同，不要一个白底一个深色/彩色底"。

### 12.15 空白检测 harness（agentic：工具 + LLM 代理）

独立的留白检测工具，体现"harness 提供工具、LLM 决定"的最纯粹形态：**不是固定流水线，而是 LLM 代理按需调用工具**。

- 入口：`node blankcheck.js <deck.pptx>`（`lib/blank-detect.js` + `lib/llm.js::agent` 工具调用循环）。
- harness 暴露的**工具**（坐标都由 harness 精确测量，LLM 只决定用不用/是不是问题）：
  - `list_slides()` — 整体页码/角色/标题；
  - `measure_page(page)` — 某页版面内容概览；
  - `find_empty_regions(page)` — 精确测量候选空白矩形（迭代最大空白矩形，单位英寸）；
  - `find_thin_blocks(page)` — "框大字少"方框；
  - `draw_red_box(page,x,y,w,h,severity,reason)` — 给确认的留白**画红框标注**到 PNG；
  - `finish(blanks)` — 提交结论。
- LLM 代理自主决定流程：`list_slides → 对内容页 find_empty_regions/find_thin_blocks/measure_page → 判断 → draw_red_box → finish`。封面/结语刻意留白由 LLM 据标准排除。
- 输出：每页确认的空白矩形（精确坐标 + severity + 理由）+ 把红框画到 `preview` PNG 上（`<deckDir>/blankcheck/<base>-blank-NN.png`）供**人工核对**（对应"标注出具体的空白矩形框"+ 人工检验/通过率评估的闭环）。
- `--no-llm`：只出几何候选（不做 LLM 判定）；`--save report.json`：存结构化报告。
- 数据来源：优先读 `<deck>.layout.json`（build() 捕获的精确 box）+ `<deck>.spec.json`（页面角色/标题）；都没有则用 python-pptx 从任意 .pptx 抽取几何（fallback）。
- 附带修复：发现并修了 `layout-qa` 的一个隐性 bug——`bg`(整页背景色) 被算作"填满"，导致生产链路里留白检测一直被掩盖；已把 `bg` 移出 fillLayers。
- **人工评估闭环** `eval-blanks.js` + `lib/blank-eval.js`：`node eval-blanks.js <deck.pptx>` 跑检测→生成**评估表 HTML**（每页带红框的图内嵌，逐框 ✓真留白/✗误报，浏览器实时显示通过率，导出带 severity 的判定 JSON）；`node eval-blanks.js --judgments x.json` 复算精确率（TP/FP、分 severity、是否 ≥90%）。这就是"检测→人工检验→通过率"的可量化闭环。
