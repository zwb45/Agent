# 把空白检测（blank-harness）作为 verify 接入 PPT 生成 loop —— 决策与实现记录

## 目标
把独立的 `blank-harness/` 空白检测能力，接入顶层 PPT 生成 harness 的「生成 → 检查 → 修订」循环，
作为其中一步 **verify（留白核验）**。

## 现状
- **循环**：`lib/orchestrator.js` 的 `buildWithReview()`。每轮 `build()`（写出 `.pptx` + `.layout.json` + `.spec.json`）
  → layout-qa + 内容检测 → `reviewAndRevise()` LLM 修订 → 重建，最多 `maxIters` 轮。
- **blank-harness**：`detect(file)` 把上述两个 JSON 当**数据**读入（不需 python-pptx），返回每页经 LLM 核验的留白
  （基准精确率 100%）。几何与 layout-qa 同源（最大空白矩形），多一个 **LLM 大脑**滤误报。

---

## 已确认的决策（终端选择结果）

| 决策 | 选择 | 说明 |
|---|---|---|
| 一、与 layout-qa 留白检测的关系 | **A. 替换** ✅ | blank-harness 成为 loop 里权威留白核验器；layout-qa 只留越界+重叠 |
| 二、每轮检测模式 | **A. 默认 LLM agentic** ✅ | 每轮完整 LLM 核验（100% 精确）；`blankLLM=false` 关闭；API 报错自动回退几何 |
| 三、verify 的作用 | **A. 驱动修订** ✅ | 留白发现转成 issue 喂给 `reviewAndRevise()`，LLM 重排/充实该页再重建 |
| 四、作用范围 | **A. 仅 freeform loop** ✅ | 只接 `buildWithReview()`；typed 路径维持现状 |
| 五、快速重建 | **同意：`maxIters<1` 自动跳过** ✅ | chat.js 的 `rebuild`（`maxIters:0`）不被拖慢；想核验可显式传 `blankCheck:true` |

---

## 已实现内容

### 1. 新增 `lib/blank-verify.js`（桥接，不改 blank-harness）
- `verifyBlanks(file, { useLLM, model, onLog, maxChars })`
  - `useLLM:true`（默认）→ 调 `blank-harness/detect.detect()`（几何 + LLM 滤误报）
  - `useLLM:false` → `detectGeometryOnly()`：用导出的 `loadDeck + candidatesFor + mergeOverlapping` 重实现几何快路径
- `blankIssues(result)` → 把留白转成 layout-qa 形态 issue：
  - `severity`：high/medium→`error`（驱动修订）；low/info→`warn`
  - `kind`：统一 `whitespace`（满足 typed densify 门控 `issues.every(kind==='whitespace')`）
  - **hero 页（cover/closing/divider）一律豁免**，无论哪种模式（对齐 layout-qa 的 `exempt` 与 LLM 大脑的判定）
  - `msg` 带坐标/占比/具体修法（大片留白 / 框大字少）

### 2. 改 `lib/orchestrator.js` 的 `buildWithReview()`
- 每轮 `build()` 后：跑 `verifyBlanks`，用其结果**替换** layout-qa 的 `whitespace` issue（保留越界/重叠），
  再拼上内容检测器（stat-tiles 等），整体喂给 `reviewAndRevise()`。
- `maxIters < 1` 时自动跳过（快速重建不受影响）；核验异常 → 回退 layout-qa 留白 + `onWarn`。
- 进度：新增 `blankcheck` 阶段汇报；`layout-qa` 汇总改用合并后的 issue 集。
- `generateFreeformDeck()` 透传 `blankCheck / blankLLM / blankModel`。

### 调用方控制
```js
generateFreeformDeck(topic, {
  maxIters: 3,            // 默认开 blankCheck（每轮 LLM 核验）
  blankLLM: true,         // 默认 true；false=纯几何（快但噪）
  blankCheck: true,       // 显式开关
  blankModel: 'sonnet',   // 默认随 aggModel；opus 会被强制降为 sonnet
})
```

---

## 验证状态
- ✅ `lib/blank-verify.js` / `lib/orchestrator.js` `node --check` 语法通过。
- ✅ 桥接在 11 个真实 deck（带 `.layout.json`）上跑通：几何 only + `blankIssues` 正常；hero 页无泄漏；
  真实内容页留白被正确标记（如 `_test_eval.pptx` 第 3 页 55% 留白）。
- ✅ **完整 loop 端到端实测通过**（`_blank_loop_test.js`，对真实 freeform `.slides.json` 跑 `buildWithReview`）：
  - Stage 1 干净 deck：blankcheck agent 完整跑工具链（list_slides / find_empty_regions / find_thin_blocks /
    measure_page / finish）→ `[blankcheck] 留白核验通过：未发现需要处理的留白（LLM 核验）`（无误报）。
  - Stage 2 注入留白：LLM 精确检出（`draw_red_box page2 severity=high`，坐标准确）→ 转成 whitespace issue →
    进入 `reviewAndRevise`（`slide 2 (free)：whitespace，no-image`）。验证 detect→issue→revise 全链路。
  - Stage 1 第 2 轮还捕获到上一轮修订引入的新留白（slide 7）→ 证明每轮 verify 能抓回归。
- ✅ **LLM 不可用时优雅降级**：blankcheck 报错自动回退 layout-qa 几何留白 + `onWarn`，loop 不中断。

### 实测发现的环境问题（与本次改动无关，但影响所有 sonnet 级 LLM 调用）
- 当前 shell 的 `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1m]`，其中 `[1m]` 是 Claude Code 内部别名，
  GLM 原生 API 不认 → 所有 sonnet 级调用（含 review 修订）报 `HTTP 400 [1214][modelCode 不存在]`。
- 探测确认有效模型码：`glm-5.2` / `glm-4.7` / `glm-4.6` / `glm-4.5`（均 200）。实测需用：
  `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2 node _blank_loop_test.js`
- 建议：独立运行 harness 时，在 shell/`.env` 设 `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2`（去掉 `[1m]`）。

## 第二轮：内容感知判定 + 「拿不准就问用户」（已完成）

**动机**：原 LLM 评委的工具全是几何的，看不到页面文字 → 无法区分「内容过少（真留白）」与「刻意极简（引用/金句，应保留）」。把每页文字喂给 LLM，让它综合判断。

**做法**（核心原则：几何触发，内容判定，互补不替换）：
- `blank-harness/detect.js`：`loadDeck` 用 `slideText(sp)` 抽每页文字（递归收集字符串，跳过坐标/样式键）+ deck 上下文；`AGENT_SYS` 重写为**内容感知**（判定前先 `read_page_text`，三分类 keep / thin / uncertain）。
- `blank-harness/tools.js`：新增 `read_page_text`；`list_slides` 增 arch + 文字摘要；`draw_red_box`/`finish` 的 severity enum 加 `uncertain`。
- `lib/blank-verify.js`：`blankIssues` 跳过 uncertain；新增 `uncertainBlanks` 收集待确认项。
- `lib/orchestrator.js`：每轮收 uncertain → 有 `onUncertain` 则问用户（「不保留」转 issue 驱动修订），无则默认保留 + `onWarn`（保守，不误改）。
- `chat.js`：加 `ask()`（readline 一次性提问，'line' handler 顶部拦截）；仅交互模式注入 `onUncertain`，`--once`/`rebuild(maxIters:0)` 不注入 → 走默认保留。

**实测**（`_blank_loop_test.js`，真实 GLM）：
- UNIT 路由单测全过：high/medium→error、low→warn、uncertain→单独收集、hero 豁免。
- E2E 三场景（关键对比）：
  - 注入**内容过少**页（文字「一句话要点」）→ 几何 57% 空白，LLM 读文字后**判 thin 并报**。
  - 注入**金句页**（「预测未来最好的方式，就是创造它。— Alan Kay」）→ 几何 24% 空白，LLM 读文字后**判 keep，不报**（覆盖几何误报，未误改）。
  - → 同样的几何、相反的结论，差别只在读了文字。干净 deck 仍 0 误报。
  - `onUncertain` 这几例模型都很笃定，未触发（其路由由 UNIT 单测覆盖；orchestrator 的调用点为同一代码路径）。

> 注：`[1m]` 后缀鲁棒性已修——`lib/llm.js` + `blank-harness/llm.js` 的 `resolveModel` 加了 `stripVariantTag`，`glm-5.2[1m]`→`glm-5.2`，故不再需要手动覆盖环境变量。

## 第三轮：真实场景审查与加固（已完成）

逐项审查真实使用场景下的边界问题并修复：

- **「页面文字」被污染**（已修，`detect.js::slideText`）：原本会把 freeform 的 `ghost` 背景大字、image 搜图词（`q`）、来源 `note`/`footerLabel`、以及旧格式里的 `spec`/`url` 等非正文当「内容」喂给 LLM → 误导内容感知判定。已：整对象跳过 `k==='ghost'` 与 `_layer==='decor'`；`TEXT_SKIP_KEYS` 增 `q/query/search/note/footerLabel/spec/url/href/ref/alt`。
- **末轮空跑浪费**（已修，`orchestrator.js::buildWithReview`）：`isFinal` 轮也跑 blankcheck agent，但随后立即 break（无修订）→ 纯烧 LLM，还可能在末轮触发无意义的「问用户」。已改为 `blankCheck && !isFinal`，省约 1/N 的检测开销。
- **大 deck 截断**（已修，`detect.js`）：agent `maxSteps` 16→24，避免 8–12 页内容 deck 检测中途到顶、返回部分结果。
- **实测**：① 真实 `composeFreeformDeck → buildWithReview + 内容感知 blankcheck`（固态电池，3 页，98.7s）全链路无报错，干净 deck 核验通过；② 当前格式 image 查询（`q`）已确认被 `slideText` 排除；③ UNIT 路由单测无回归；④ `_blank_loop_test.js`（干净/内容过少/金句三场景）复跑通过。

**已知残留（按需，非 bug）**：
- typed 路径（`generateDeck`）仍未接 blankcheck（决策四 A）。
- blankcheck 每轮跑 LLM agent，大 deck + 多轮时较慢/费 token；可用 `blankLLM:false`（纯几何）或 `blankCheck:false`（关闭）调节。
- `chat.js` 的交互 `ask()` 只在真实 REPL 触发；此处靠代码审查 + orchestrator 的 `onUncertain` 回调路径已被 e2e 走通来保证。

## 第四轮：freeform 路径做成 H = (E,T,C,S,L,V) harness 形态 + 3 个真实问题检测

把 freeform 路径补齐成与 blank-harness 一致的六要素 harness（此前缺显式的 T、C），并针对真实生成里的 3 个问题加了 verify→revise 闭环。

### freeform 的 H = (E,T,C,S,L,V) 映射
| 要素 | 实现 | 位置 |
|---|---|---|
| **E 执行循环** | `buildWithReview` 有界循环：build → verify → revise → re-render，到干净或 maxIters | `lib/orchestrator.js` |
| **T 工具/元素注册表** ★新 | 通用 `Registry` + 各元素 kind 的 JSON-Schema；`validateFreeElement`/`sanitizeFreeElements` 校验 LLM 输出、坐标夹进画布、丢弃畸形元素 | `lib/registry.js` + `lib/freeform-tools.js` |
| **C 上下文管理器** ★新 | `ReviseContext`：按页累计修订历史（每轮 issue + 是否被 overlap 护栏拒及原因），有界(keep N)，喂回 reviseFree prompt，避免重复被拒 | `lib/review.js` |
| S 状态存储 | deck sidecar：`.spec/.layout/.slides.json` | `harness.js build()` |
| L 生命周期钩子 | `onProgress`/`onWarn`/`onUncertain` + 每轮修订事件 | `lib/orchestrator.js` |
| **V 评估接口** | layout-qa(越界/重叠/留白) + 内容检测器 + blank-verify；★本轮新增 3 检测器 | `lib/layout-qa.js`+`lib/review.js`+`lib/blank-verify.js` |

### 新增 V 检测器（针对真实 3 个问题：verify → 返回 LLM 修订）
- `detectGhostDominance`：「浮动的无用大字」——过大的 ghost 背景字(size>120)或压住内容 → 缩到 ≤80 或删。
- `detectTextOverflow`：「文字超出方框」——text/fit/bullets 估算行高超出方框 → 缩字/加高方框/精简。
- `detectHiddenImages`（既有，阈值 0.6→0.5）：「图片被全填充方框遮挡」——image 早于不透明 panel 被覆盖 → 图片移到方框之后。

### 实测
- 用新检测器跑 AI 医疗 deck 的修订循环：**BEFORE ghost=11 / overflow=1 → AFTER ghost=1 / overflow=0**；slide 4（原 3 个 size=320 巨字）修订后视觉干净、巨字消失。
- UNIT：`detectGhostDominance` 只报 size=300 不报 size=40 ✓；`detectTextOverflow` 报超框 ✓；`ReviseContext` 压缩/摘要正常 ✓。

### 新增/改动文件
- 新：`lib/registry.js`、`lib/freeform-tools.js`（T）。
- 改：`lib/freeform.js`（接入 sanitize + 重导出 TOOLBOX）、`lib/review.js`（`ReviseContext` + 2 检测器 + hiddenImage 阈值 + reviseFree 带 ctx）、`lib/orchestrator.js`（`revCtx` + 新检测器接线 + E/S/L/V 注释）。

## 第五轮：渲染器确定性修复（z-order / 文字溢出 / 浮动大字）

第四轮的「检测器→LLM 修订」对内容质量有效，但对**结构性**问题（图片被矩形盖住、矩形盖数字、文字溢出框、浮动大字）不可靠——overlap 护栏常拒绝修订，问题原样留下。改为在**渲染器里做确定性修复**（不依赖 LLM）：

- **z-order 修复**（`freeform-tools.js::fixZOrder`，`renderFree` 渲染前调用）：装饰(ghost/oval)→底层、不透明面板(rect/rrect fill, 无透明度)→中层、内容(text/image/icon/badge/…)→顶层。**面板永远盖不住它上面的图片/文字**。`_preview.js` 同步使用。
- **文字超框自动缩字号**（`renderFree` 的 `text` 分支）：固定字号文字用 `estLines` 估算超框时，循环缩字号直到装下（floor 9pt）——文字不再溢出方框/椭圆。
- **ghost 清理**（`renderFree` 的 `ghost` 分支）：含数字（如 "98.7%" 这种浮动数字，读起来像错误）/ size>100 / 压住正文的 ghost **直接不渲染**。

**实测**（重渲 AI 医疗 deck，逐页图像分析确认）：
- 第 2 页：图片不再被矩形完全覆盖 ✓（z-order）
- 第 4 页：01/02/03 数字不再被矩形盖住 ✓（z-order）
- 第 5 页：椭圆内文字不再溢出 ✓（自动缩字号）
- 第 6 页：浮动的 "98.7%" 大字消失 ✓（ghost 清理）

> 这层确定性修复与第四轮的检测器/修订循环互补：结构问题由渲染器兜底保证，内容质量由检测器+LLM 修订打磨。修好的 deck：`output/AI医疗发展.pptx`。

## 可选后续（未做，按需）
- 最终轮把红框（`detect.visualize`）画到预览 PNG，产出可视化留白标注。
- 给 typed 路径（`generateDeck`）也加一轮留白核验/修订。
- 上游预测：`freeform-deck.js` compose 后做「文字量 vs 构图原型」预判（目前 in-loop 内容感知已覆盖）。
