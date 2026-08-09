# ppt-harness 完整结构文档

> 一份面向阅读与维护的结构总览：目录、设计思想、生成流水线、模块职责、质检与修订循环、数据产物、运行方式、环境配置。
> 文档反映截至 2026-08-08 的代码状态（含本次「留白核验接入 loop」改动）。

---

## 一、项目概览

**ppt-harness** 是一个**声明式 PPT 生成 harness**：把一份 JSON 形式的「幻灯片规格（slide spec）」渲染成排版精致、经过校验的 `.pptx`，并附带每页 PNG 预览。它在 Anthropic 官方 `pptx` 技能（pptxgenjs）之上做了三件增强：

1. **内容丰满**：用 LLM 做「研究 → 大纲」两步，先做带来源的网络检索、汇总成研究简报，再据此写出有真实数字/案例/趋势、图文并茂的大纲（不依赖模型记忆、不编造图表数据）。
2. **图文并茂**：react-icons 渲染成 PNG 图标 + 开源图库（Pexels/Unsplash/Pixabay）配图，离线时还有 SVG 生成兜底。
3. **版式可信赖**：渲染时捕获每个元素的几何，做确定性的越界/重叠/留白质检；问题页交给 LLM 修订并重建，形成「构建 → 质检 → 修订」的闭环。

入口是一句自然语言（`node chat.js "做一个量子计算的 ppt"`），也能用 `generate.js` 跑大纲/spec，或用 `edit.js` / `beautify.js` 改/重排既有 deck。

**技术栈**：Node.js（>=18，零额外运行时依赖，仅用全局 `fetch`）、pptxgenjs、react-icons、sharp；机器质检走 LibreOffice + PyMuPDF + python-pptx；LLM 走 Anthropic 兼容端点（本项目对接 GLM）。

---

## 二、目录结构

```
ppt-harness/
├── harness.js              声明式 builder：slides[] → .pptx（渲染 + 几何捕获 + 写产物）
├── generate.js             CLI：从 outline 或 spec 构建 deck
├── chat.js                 交互式 REPL / 自然语言入口（主门面）
├── edit.js                 CLI：对既有 deck 施加编辑（spec 模式 / live 模式）
├── beautify.js             CLI：重排既有 deck（含导入任意 .pptx）
├── orchestrator.js          (顶层符号链接/再导出，真正实现在 lib/orchestrator.js)
├── _build_test.js          构建自检脚本
├── _blank_loop_test.js     留白核验接入 loop 的回归测试（本次新增）
├── lib/                    核心库（21 个模块，见 §6）
├── blank-harness/          独立留白检测 harness（9 个模块，见 §6）
├── examples/               大纲/示例 deck（ai-healthcare、brand-launch、ev-industry 等）
├── prompts/                生成相关提示词（generate-deck.md）
├── output/                 生成的 deck + 各类 sidecar + preview PNG（运行产物）
├── package.json            依赖 + npm 脚本
├── .env                    图像 API key（PEXELS/UNSPLASH/PIXABAY）
├── README.md / ARCHITECTURE.md / 改进方案.md   设计与演进文档
└── agent.md                本次「留白核验接入」决策与验证记录
```

| 目录/文件 | 职责 |
|---|---|
| 根目录 `.js` | 各 CLI 入门与 builder 主体 |
| `lib/` | 流水线各阶段的实现：研究、大纲、编译、校验、渲染原语、质检、修订、风格/主题、图标/图像、LLM 客户端 |
| `blank-harness/` | **自包含**的留白检测子系统：几何引擎 + 工具注册表 + 上下文管理器 + agent 循环 + 评测；不 import 顶层 harness，把 deck 当数据读 |
| `examples/` | 手写示例（大纲 JSON、示例 deck 脚本），用于演示与回归 |
| `output/` | 运行时产物：`.pptx` 及其 sidecar、`preview/` 预览 PNG |

---

## 三、核心设计思想

### 3.1 声明式 builder
harness 只负责「把 spec 渲染 + 校验」，不做内容决策。`harness.js::build(slides, opts)` 依次为每张 spec 调用对应渲染器（`RENDERERS[spec.t]`），把元素落到 13.33″×7.5″ 画布上。排版三件套集中在线程里、可被 LLM 重写：

- **调色板 C**（`lib/palette.js`）：4 套命名主题（healthcare / midnight / charcoal / berry）。
- **字体字号 T**（`lib/typography.js`）：默认 Microsoft YaHei，针对中文调过的字号表。
- **风格 S**（`lib/style.js`）：header/cover/card/decorate 的成套搭配（classic / editorial / minimal / tech / bold）。

### 3.2 Harness 架构映射 H = (E, T, C, S, L, V)
项目把一个 agent harness 的六要素映射到具体实现（`blank-harness` 把 T/C 做得最显式）：

| 要素 | 含义 | 本项目实现 |
|---|---|---|
| **E** 执行循环 | 观察-思考-行动 | `orchestrator.js` 的确定性流水线 + `buildWithReview` 修订循环；`blank-harness/llm.js::agent` 的 ReAct 工具循环 |
| **T** 工具注册表 | 集中注册 + 入参校验 | `lib/elements.js` 的渲染原语工厂；`blank-harness/tools.js::Registry`（JSON-Schema 校验后执行）；freeform 元素注册表 `lib/freeform-tools.js`（`lib/registry.js`，校验+夹坐标） |
| **C** 上下文管理器 | 决定进模型上下文的内容、有界压缩 | 渲染器收到的统一上下文 `{p,E,C,T,s,spec,total,i,img}`；`blank-harness/context.js::Context`（字符预算 + 成对驱逐 tool_use↔tool_result） |
| **S** 状态存储 | 产物与可重放状态 | deck 旁的 sidecar（`.spec/.brief/.outline/.slides/.layout.json`）+ REPL 内存态 |
| **L** 生命周期钩子 | 阶段回调 | `onProgress(stage,detail)` / `onWarn`；构建后 `qa.validate` + `lintContent` + `renderAll` |
| **V** 评估/校验接口 | 多级校验 | `validateSlides`（schema）→ 构建 → `qa.validate`（官方 validate.py）→ `lintContent`（设计元泄漏）→ `layout-qa.analyze`（几何）→ `review` 内容检测器 → `blank-verify`（LLM 留白核验） |

### 3.3 「harness 提供工具，LLM 做决策」(freeform)
`RENDERERS.free`（`lib/freeform.js`）不做任何版式决策——只渲染并校验 LLM 给出的绝对定位元素。LLM 在一个 10 元素 toolbox（`rect/rrect/oval/text/fit/bullets/image/icon/badge/line` + ghost/tag/rotate）里自由排版，每页轮换一种构图原型（hero/magazine/sidebar/numbered/bento/bigquote/comparison/card-grid/asymmetric）打破单调。文本自动适应盒子、按 z-order 计算真实底色并强制 WCAG 对比度。

### 3.4 两条生成路径
- **typed 路径**（`generateDeck`）：固定 12 种版式（cover/divider/agenda/stats/iconGrid/chart/flow/pipeline/twoCol/quadrant/future/table/closing），编译器自动补图标/配图/封面/导览/结语。稳定、可控。
- **freeform 路径**（`generateFreeformDeck`）：每页版式由 LLM 独立设计，最大化多样性；带「构建 → 质检 → 修订」循环收敛到干净。

### 3.5 freeform 路径也已做成 H = (E,T,C,S,L,V) harness 形态
freeform 与 blank-harness 共用同一套六要素架构（此前缺显式 T/C，现已补齐）：

| 要素 | freeform 实现 | 位置 |
|---|---|---|
| **E 执行循环** | `buildWithReview`：build → verify → revise → re-render，到干净或 maxIters | `lib/orchestrator.js` |
| **T 元素注册表** ★ | 通用 `Registry` + 各元素 kind 的 JSON-Schema；`sanitizeFreeElements` 校验输出、坐标夹进画布、丢弃畸形元素 | `lib/registry.js` + `lib/freeform-tools.js` |
| **C 上下文管理器** ★ | `ReviseContext`：按页累计修订历史（issue + 是否被 overlap 护栏拒），有界，喂回 reviseFree，避免重复被拒 | `lib/review.js` |
| S 状态存储 | deck sidecar（`.spec/.layout/.slides.json`） | `harness.js build()` |
| L 生命周期钩子 | `onProgress`/`onWarn`/`onUncertain` + 每轮修订事件 | `lib/orchestrator.js` |
| **V 评估接口** | layout-qa + 内容检测器 + blank-verify（含 ghost/overflow/hidden-image 检测） | `lib/layout-qa.js`+`lib/review.js`+`lib/blank-verify.js` |

> **实测**：新检测器跑 AI 医疗 deck 修订循环，背景大字(ghost) 11→1、文字超框 1→0；slide 4（原 3 个 size=320 巨字）修订后视觉干净。

---

## 四、生成流水线

### 4.1 Typed 路径（`generateDeck` → `buildFromOutline`）
```
topic
  │  research.js   多角度并行检索(概览/数据/应用/趋势/案例/挑战) → 汇总去重 → 研究简报
  ▼
brief.json
  │  outline.js    简报 → 接地大纲（真数字→stats、真案例→table、真趋势→future，来源入 note）
  ▼
outline.json
  │  generate.js   补封面/导览/结语、选图标、生成英文搜图词、编号 eyebrow、分配稳定 id
  ▼
slides[]
  │  schema.js     validateSlides 结构校验（拦截畸形 spec）
  ▼
  │  harness.build 渲染 .pptx + sidecar + 预览；再 validate + lint
  ▼
.pptx (+ .spec/.brief/.outline.json, preview/*.png)
```

### 4.2 Freeform 路径（`generateFreeformDeck` → `buildWithReview` 修订循环）
```
topic → research.js → brief
  │  freeform-deck.js  规划(把意图分配到页) → 每页并行 LLM 设计 elements（轮换原型）→ 失败页重试1次
  ▼
slides[] (t:'free')
  │  buildWithReview 循环（≤ maxIters 轮）：
  │    ┌─ harness.build（renderPreview:false）→ onLayout 拿到 report + deckBoxes
  │    │   - layout-qa.analyze   越界 / 重叠 / 留白（几何）
  │    │   - review 内容检测器    stat-tiles / too-many-blocks / hidden-image /
  │    │                          thin-block / inconsistent-blocks / image-light
  │    │   - blank-verify         ★ LLM 留白核验（替换 layout-qa 的留白 issue）
  │    ├─ 合并 issue → reviewAndRevise（freeform 重排版 / typed 充实内容）→ countOverlaps 护栏
  │    └─ 重建 … 直到干净或用满轮数
  ▼
最终渲染（renderPreview:true）→ .pptx + preview PNG
```

### 4.3 阶段一览

| 阶段 | 主模块 | 产物 |
|---|---|---|
| research | `lib/research.js` | `brief.json` |
| outline | `lib/outline.js` | `outline.json` |
| compile | `lib/generate.js` / `lib/freeform-deck.js` | `slides[]` |
| validate | `lib/schema.js` | 校验报告 |
| build | `harness.js` | `.pptx` + `.spec.json` + `.layout.json` + `preview/` |
| review/revise | `lib/orchestrator.js` + `lib/review.js` + `lib/blank-verify.js` | 收敛后的 `slides[]`（→ `.slides.json`） |
| qa | `lib/qa.js` | validate / lint / 渲染 PNG |

---

## 五、留白检测：思路与框架 ★（重点）

> **核心思想**：留白检测 = 「几何先测 + LLM 后验」。几何引擎用最大空白矩形算法把候选空白**精确测出来**（坐标永远来自测量，绝不靠模型脑补），再让 LLM agent 按版式语义判定哪些是真问题、哪些是刻意留白——从而把几何的「高召回、低精确」变成「高召回 + 高精确」（受控基准上精确率 100%）。

### 5.1 为什么要单独做一套留白检测
大片留白是 AI 生成 PPT 最典型的翻车之一（内容稀、版面空），而单看任一种手段都有短板：

- **纯几何**（最大空白矩形）：能找出空白，但**误报多**——页边距、标题带、卡片间距、封面/结语刻意留白都会被当成问题。
- **纯 LLM「看一眼」**：**坐标不靠谱**，模型爱凭空估坐标；且容易漏判多页。
- **结论**：两者结合——**几何负责测量，LLM 负责判定**。这正是把它做成一个「带工具的 agent」而不是一段固定管线的原因：让模型用工具拿真实坐标，再用语义判断。

### 5.2 判定标准（什么算 / 什么不算）
- **算问题**：内容页里占页面 ≥10% 的大块空白；两块内容之间夹着的空带；大方框里内容很少（「框大字少」）。
- **不算问题**：封面/结语/分隔页（刻意留白）；页边距（约 0.6″）与卡片正常间距；标题带；小面积呼吸空间。

### 5.3 几何引擎（`blank-harness/geometry.js`，纯函数、零依赖）
画布 13.33″×7.5″。核心算法链：

- **栅格化**：按 0.2″ 网格离散页面，标记被「填充层」（card/image/text/badge/shape/table/chrome）覆盖的格子。
- **最大空白矩形**：用二维前缀和，在 O(rows²·cols) 内求出「不含任何填充格子的最大轴对齐矩形」。这是关键——「连通分量外接框」会因页边距/卡间细缝把整页并成一个超大框，严重高估。
- **迭代 top-N**：找到最大空白后将其标记为填充，再找下一个，得到若干互不重叠的候选空白。
- **thin-block**：大方框（≥4in²）内有效内容占比 <25% → 「框大字少」。
- **框合并**：模型可能把同一片空白画成两个框，重叠 ≥40% 则合并为一个。
- **hero/标题/页脚豁免**：封面/结语/分隔页不报 thin；标题带（y<2.0）与页脚（y≥7.0）过滤掉。

### 5.4 框架 H = (E, T, C, S, L, V)（blank-harness 把 T/C 做得最显式）

| 要素 | 实现 | 位置 |
|---|---|---|
| **E 执行循环** | ReAct 工具调用循环（观察-思考-行动），带重复调用检测与防卡死 | `llm.js::agent` |
| **T 工具注册表** | `Registry`：JSON-Schema **入参校验** + 集中注册 + `execute()` 统一入口 | `tools.js` |
| **C 上下文管理器** | `Context`：字符预算 + **成对驱逐** tool_use↔tool_result（保持 API 历史始终有效） | `context.js` |
| S 状态存储 | 把 deck 的 `.layout.json`/`.spec.json` 当**数据**读入 | （外部产物） |
| L 生命周期钩子 | `onStep`/`onLog` 回调 | （按需） |
| **V 评估接口** | 人工评估表 + 精确率复算 + 已知 GT 自动基准 | `eval.js`/`eval-blanks.js`/`bench-blank.js` |

> **自包含**：blank-harness 不 import 顶层 PPT harness，自带 LLM 客户端、工具表、上下文管理器与几何引擎；任何 builder 产出的 `.pptx`（带 sidecar）都能直接当输入。

### 5.5 七个工具（T：模型只能通过工具拿坐标 / 读文字）

| 工具 | 作用 |
|---|---|
| `list_slides` | 列页码/角色/构图原型/**文字摘要**，决定查哪些页 |
| `read_page_text` | ★读某页**完整文字**——内容感知判定的关键（区分刻意极简 vs 内容过少） |
| `measure_page` | 看某页内容概览（元素数、大块位置） |
| `find_empty_regions` | **精确测量**某页候选空白矩形（坐标 / 占比 / 方位） |
| `find_thin_blocks` | 找「框大字少」的方框 |
| `draw_red_box` | 给**已确认**的留白画红框（severity：high/medium/uncertain） |
| `finish` | 提交结论（汇总确认的留白，含坐标） |

工具入参先过 JSON-Schema 校验（type/required/enum/min/max/嵌套）；不合法返回清晰错误，而不是把坏参数直接喂进工具导致难懂的运行时报错。

### 5.6 agent 工作流

```
list_slides（看整体）
  → 对每个内容页：find_empty_regions（+ 必要时 measure_page / find_thin_blocks）
  → 判断：真问题？→ 是：draw_red_box 标出
  → finish（提交全部确认的留白）
```

防卡死：相同参数重复调用会被识别并提示模型改换做法；连续两轮无进展则停止。`Context` 超预算时成对驱逐最旧的 tool_use↔tool_result，并插一条系统提示告知模型早期工具调用已省略。

### 5.7 评测（V）
- **人工评估**（`eval-blanks.js`）：浏览器逐框判 真留白/误报，实时通过率，导出 judgments 后可复算精确率。
- **自动基准**（`bench-blank.js`）：受控集 + 已知 ground-truth，算 precision / recall / F1。
- **结果**：agentic 检测在 12 页受控集上 **精确率 100% / 召回 100% / F1 1.000**（LLM 把几何的 FP 全部滤掉）；真实密集 deck 检测 0 误报。

### 5.8 接入顶层生成 loop（本次改动）
blank-harness 作为 **verify 步骤**接入 freeform 的 `buildWithReview` 修订循环（决策详见 `agent.md`）：

- **桥接** `lib/blank-verify.js`：`verifyBlanks` 封装 `detect`；`blankIssues` 把留白转成 `{slide,severity,kind:'whitespace',msg}`；**封面/结语/分隔页一律豁免**；几何 only 路径用导出的 `loadDeck/candidatesFor/mergeOverlapping` 重实现，不改动 blank-harness。
- **替换**：每轮 blank-harness 的 LLM 核验结果**替换** layout-qa 自带的留白 issue（同源几何 + LLM 滤误报，更权威；layout-qa 仍管越界/重叠）。
- **驱动修订**：留白 issue 喂给 `reviewAndRevise`，LLM 重排/充实该页再重建。
- **鲁棒**：LLM 不可用 → 回退 layout-qa 几何 + `onWarn`；`maxIters<1`（快速 rebuild）跳过。
- **实测**（`_blank_loop_test.js`，真实 GLM LLM）：干净 deck 0 误报；注入留白被 LLM 精确检出（severity/坐标准确）并驱动修订；LLM 不可用时优雅回退。

### 5.9 内容感知判定 + 「拿不准就问用户」★（本轮升级）
几何只告诉你「哪里空、空多大」，不知道「这片留白该补还是该留」。补上 LLM 对**文字**的理解：

- **读文字再判**：`loadDeck` 用 `slideText(sp)` 抽每页文字（递归收集字符串，跳过坐标/样式键）+ deck 上下文；agent 对候选空白页**先 `read_page_text` 再判**，三分类：
  - **keep**：引用/金句/极简强调（单句大字、居中短句）→ 刻意留白，**不报**；
  - **thin**：内容对版式明显过少 → 报 high/medium，驱动修订；
  - **uncertain**：实在分不清 → 报 uncertain + 理由，**交人确认，不瞎改**。
- **拿不准就问用户**：`uncertainBlanks` 单独收集（不进 issue）；`buildWithReview` 每轮若有 `opts.onUncertain`（交互模式）→ `await` 逐项问用户（chat.js 的 `ask()`：回车=保留 / n=补充），「补充」的转 issue 驱动修订；无 `onUncertain`（`--once` / 程序化）→ 默认保留 + `onWarn`（保守，绝不误改一页可能刻意的留白）。

> **实测对比**（真实 GLM，同几何不同文字）：内容过少页（文字「一句话要点」）→ 几何 57% 空白，**判 thin 报**；金句页（「预测未来最好的方式，就是创造它。— Alan Kay」）→ 几何 24% 空白，**判 keep 不报**。同样的几何、相反的结论，差别只在读了文字。

---

## 六、模块说明

### 6.1 顶层文件

| 文件 | 角色 | 关键导出/命令 |
|---|---|---|
| `harness.js` | 声明式 builder 主体 | `build(opts)`、`RENDERERS`、`W/H/M/CW` |
| `generate.js` | 构建 CLI | `--outline` / `--spec` / `--out` / `--no-images` / `--theme` / `--style` |
| `chat.js` | REPL / 自然语言门面 | `App`、`parseRequest`、`detectHints`、意图检测、`/help /outline /brief /research /quit` |
| `edit.js` | 编辑 CLI | `--spec`（重建）/ `--live`（python-pptx 原地改） |
| `beautify.js` | 重排 CLI | `--spec` / `--import` / `--gentle` / `--compare` |
| `orchestrator.js` | 再导出 `lib/orchestrator.js` | — |

### 6.2 `lib/`（21 个模块）

**编排与 LLM**
| 模块 | 职责 | 关键导出 |
|---|---|---|
| `orchestrator.js` | 流水线总驱动（topic→.pptx） | `generateDeck` / `generateFreeformDeck` / `buildFromOutline` / `buildWithReview` |
| `llm.js` | Anthropic 兼容端点客户端：JSON 抽取、web_search、ReAct agent 循环 | `ask` / `askJson` / `agent` / `raw` / `resolveModel`（已剥 `[1m]`） |

**内容生成（typed）**
| 模块 | 职责 | 关键导出 |
|---|---|---|
| `research.js` | 多角度并行检索 + 汇总成研究简报 | `research` / `ANGLES` / `DEPTH` |
| `outline.js` | 简报 → 接地 typed 大纲 | `composeOutline` |
| `generate.js` | 大纲 → slides 编译（补图标/图/封面/结语） | `outlineToSlides` / `pickIcon` / `imgQuery` |
| `schema.js` | 各版式字段规格 + 校验 | `validateSlides` / `FIELDS` / `TYPES` |

**渲染**
| 模块 | 职责 | 关键导出 |
|---|---|---|
| `elements.js` | pptxgenjs 版式原语工厂（含中文自适应） | `make(pptx,C,T,S)` → 原语集合 |
| `freeform.js` | freeform 渲染器（渲染前 T 校验 + 夹坐标） | `renderFree` / `TOOLBOX` / `sanitizeFreeElements` |
| `freeform-tools.js` ★ | freeform 元素注册表（T）：各 kind schema + 校验/夹坐标 | `sanitizeFreeElements` / `TOOLBOX` / `FREE` |
| `registry.js` ★ | 通用工具/元素注册表 + JSON-Schema 校验 | `Registry` / `validateInput` |
| `freeform-deck.js` | freeform deck 组队（规划 + 并行设计） | `composeFreeformDeck` / `ARCHETYPES` |

**质检与修订**
| 模块 | 职责 | 关键导出 |
|---|---|---|
| `layout-qa.js` | 几何捕获 + 越界/重叠/留白（最大空白矩形） | `analyze` / `LayoutLog` / `wrapElements` / `intersect/area/containment` |
| `review.js` | LLM 修订（C: `ReviseContext`）+ 内容检测器（V）+ 重叠护栏 | `reviewAndRevise` / `reviseFree` / `ReviseContext` / `detect*`（含 ghost/overflow/hidden）/ `countOverlaps` |
| `blank-verify.js` ★ | 留白核验桥接（替换 layout-qa 留白） | `verifyBlanks` / `blankIssues` / `detectGeometryOnly` |
| `qa.js` | 机器质检：validate.py / 渲染 PNG / 内容 lint | `validate` / `renderAll` / `lintContent` |
| `color.js` | WCAG 对比度（按 z-order 取真实底色） | `contrast` / `readableOn` / `fillCategory` |

**编辑 / 重排**
| 模块 | 职责 | 关键导出 |
|---|---|---|
| `edit.js` | 对 deck 施加编辑（spec 重建 / live 原地） | `applyEdits` / `applyEditsLive` |
| `beautify.js` | 确定性「品味引擎」重排 + 导入 .pptx | `beautifySpec` / `importPptx` |

**资源（图标 / 图像）**
| 模块 | 职责 | 关键导出 |
|---|---|---|
| `icons.js` | react-icons → PNG（sharp，磁盘缓存）→ dataURL | `resolve` / `rasterize` / `dataUrl` |
| `images.js` | 图库链（Pexels→Unsplash→Pixabay）+ 去重 + SVG 兜底；自带 .env 加载 | `getImage` / `svgHero` / `cover` |

**风格 / 主题**
| 模块 | 职责 | 关键导出 |
|---|---|---|
| `palette.js` | 4 套命名调色板 + 规整/强制补全 | `PALETTES` / `get` / `coerce` |
| `style.js` | 5 套成套风格 + 按主题确定性自动挑选 | `STYLES` / `resolveStyle` / `pickStyleForTopic` |
| `typography.js` | 字体字号表（默认 Microsoft YaHei） | `make` / `DEFAULT` |

### 6.3 `blank-harness/`（独立留白检测，9 个模块 + README）

自包含、不 import 顶层 harness，把 `.pptx` 及其 `.layout.json`/`.spec.json` 当**数据**读。

| 模块 | 职责 | 架构映射 |
|---|---|---|
| `geometry.js` | 纯几何引擎：栅格 + 最大空白矩形 + thin-block + 框合并 | — |
| `context.js` | 上下文管理器：字符预算 + 成对驱逐 | **C** |
| `tools.js` | 工具注册表：JSON-Schema 校验 + 注册 6 个留白工具 | **T** |
| `llm.js` | 独立 LLM 客户端 + agent 循环（Registry+Context 驱动） | **E** |
| `detect.js` | 检测主驱动：loadDeck + agent + visualize | — |
| `blankcheck.js` | CLI：检测 + 画红框（`--no-llm` / `--save`） | — |
| `eval.js` | 人工评估表 HTML + 精确率计算 | **V** |
| `eval-blanks.js` | CLI：人工评估 / 复算精确率 | **V** |
| `bench-blank.js` | CLI：已知 GT 的自动基准（precision/recall/F1） | **V** |

工具集：`list_slides` / `measure_page` / `find_empty_regions` / `find_thin_blocks` / `draw_red_box` / `finish`。

---

## 七、版式质检与修订循环

```
harness.build —— 用 wrapElements 包裹 E 原语，每个落点记录为 {layer,x,y,w,h}（LayoutLog）
      │
      ▼
layout-qa.analyze(deckBoxes)
   ├─ 越界 (out-of-bounds)        元素超出 [0,W]×[0,H]
   ├─ 重叠 (overlap)              容器↔容器 / 文本↔文本 真实碰撞（装饰/嵌套豁免）
   └─ 留白 (whitespace)           最大空白矩形 ≥ 阈值  ← 被 blank-verify 替换
      │  ＋ review 内容检测器（基于 slides，几何看不到的层面）
      │     stat-tiles / too-many-blocks / hidden-image / thin-block / inconsistent-blocks / image-light
      │  ＋ blank-verify（LLM 核验留白，权威）
      ▼
合并 issue → reviewAndRevise
   ├─ freeform 页：reviseFree 重排版（消除重叠/越界/留白）
   ├─ typed 页：densifyTyped 充实内容（仅当问题全是 whitespace）
   └─ countOverlaps 护栏：修订若新增重叠则回退（loop 永不让页面变差）
      │
      ▼
重建 → 再质检 … 直到干净或 maxIters
```

两套留白传感器并存是有意为之：`layout-qa`（纯几何，快但噪）与 `blank-verify`（几何 + LLM 滤误报，权威）；在修订循环里 blank-verify 接管留白判定，layout-qa 继续负责越界 + 重叠。

---

## 八、数据产物（写在 deck 旁）

| 产物 | 内容 | 谁读它 |
|---|---|---|
| `<deck>.spec.json` | 构建用的 slide-spec 数组（含稳定 id、自动封面/导览/结语、设计字段） | `edit.js --spec`、`beautify.js --spec` 重建；`blankcheck` 读页角色/标题 |
| `<deck>.brief.json` | 研究简报（stats/examples/trends/sources） | 复跑/追溯；chat `/brief` |
| `<deck>.outline.json` | 接地大纲 | `buildFromOutline` 快速后续（换主题/加页/切图，免重检索） |
| `<deck>.slides.json` | 最终 slides 数组（freeform 的已放置 elements） | freeform 重建；修订循环 |
| `<deck>.layout.json` | 每个元素的捕获几何 + layout-qa 结论 | `layout-qa`、`review`、`blankcheck`（首选坐标源） |
| `preview/<base>-NN.png` | 每页 PNG（LibreOffice→PDF→PyMuPDF @150dpi） | 人工 QA；`blankcheck`/`eval-blanks` 在其上画红框 |
| `<dir>/blankcheck/` | 标注了红框的 PNG | 人工核验 / 精确率评估 |

---

## 九、运行方式

### CLI / npm 脚本

| 命令 | 作用 |
|---|---|
| `node chat.js` / `npm run chat` | 交互式 REPL（主门面） |
| `node chat.js --once "<topic>"` / `npm run deck -- "<topic>"` | 一次性生成后退出 |
| `node generate.js --outline <file>` | 从大纲构建（`--spec` 走预写 slides） |
| `node edit.js --spec <deck>.spec.json --edits <file>` | spec 模式编辑（重建，全功能） |
| `node edit.js --live <any>.pptx --edits <file>` | live 模式原地改（python-pptx，尽力） |
| `node beautify.js --spec <deck>.spec.json` | 重排（`--import <ugly.pptx>` 导入；`--compare` 出 before 图） |
| `node blank-harness/blankcheck.js <deck.pptx>` / `npm run blankcheck` | 留白检测（`--no-llm` / `--save`） |
| `npm run eval` / `npm run bench-blank` | 人工评估 / 自动基准 |
| `npm run demo` / `npm run demo:light` | 示例 deck（带/不带配图） |
| `npm run qa` | 跑 `lib/qa.js` CLI |

chat.js 常用 flag：`--theme --style --pages --depth quick|standard|deep --no-images --freeform`。

### 程序化入口
```js
const { generateDeck, generateFreeformDeck, buildWithReview } = require('./lib/orchestrator');
const { build } = require('./harness');
```

---

## 十、环境与配置

| 变量 | 用途 | 来源 |
|---|---|---|
| `ANTHROPIC_BASE_URL` | LLM 端点（本项目对接 GLM） | shell/`.env` |
| `ANTHROPIC_AUTH_TOKEN` | 鉴权 | shell/`.env` |
| `ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL` | 模型别名→具体模型 id | shell/`.env` |
| `PEXELS_API_KEY` / `UNSPLASH_ACCESS_KEY` / `PIXABAY_API_KEY` | 图库 key | `.env`（`lib/images.js` 自带加载） |

**模型别名鲁棒性（本次修复）**：某些运行时把上下文窗口变体写成后缀，如 Claude Code 的 `glm-5.2[1m]`；GLM 原生端点不认 `[...]` 后缀（报 `HTTP 400 modelCode 不存在`），会让**所有** sonnet 级调用（含 review 修订）失败。已在 `lib/llm.js` 与 `blank-harness/llm.js` 的 `resolveModel` 加 `stripVariantTag`，自动剥离尾部 `[...]`，故 `glm-5.2[1m]` → `glm-5.2`。独立运行时建议在 shell/`.env` 直接设 `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2`。

**机器质检依赖**：`qa.renderAll` 需要 LibreOffice（`soffice`）+ PyMuPDF + python-pptx；`qa.validate` 需要 `validate.py`（来自 anthropics/skills）。缺失时相应步骤会降级（打印提示但不阻断构建）。留白检测首选读 deck 的 `.layout.json`，缺失才回退 python-pptx。

---

## 十一、依赖

`package.json` 运行时依赖：`pptxgenjs`、`react` / `react-dom`（图标渲染）、`react-icons`、`sharp`（图标栅格化 / 红框标注）。Node 内置 `fetch` 做 LLM 调用，零额外 HTTP 依赖。机器质检另需 Python 侧的 `python-pptx` / `PyMuPDF` 与 LibreOffice。

---

## 十二、近期改动与后续

**本次（留白核验接入）**
- 新增 `lib/blank-verify.js`；改 `lib/orchestrator.js::buildWithReview`（每轮留白核验替换 layout-qa 留白、驱动修订、`maxIters<1` 跳过、失败回退）。
- 修 `lib/llm.js` + `blank-harness/llm.js`：`resolveModel` 剥离 `[1m]` 等变体后缀。
- 新增 `_blank_loop_test.js` 回归测试；决策与验证记录见 `agent.md`。

**可选后续（未做）**
- 最终轮把红框（`detect.visualize`）画到预览 PNG，产出可视化留白标注。
- 给 typed 路径（`generateDeck`）也加一轮留白核验/修订（目前仅 freeform loop 接入）。
- README 提到的「对预览 PNG 的 vision-judge 闭环」尚未接入。
