# blank-harness — 独立留白检测 harness

一个**自包含**的留白(空白)检测 harness，与 PPT 生成 harness **不共享代码文件**。它把 .pptx（及其 `.layout.json`/`.spec.json`）当作**数据**读入，自身拥有 LLM 客户端、工具注册表、上下文管理器、几何引擎和评测模块。

## 架构（按 H = (E,T,C,S,L,V) 映射）

| 组件 | 状态 | 位置 | 说明 |
|---|---|---|---|
| **E 执行循环** | ✓ | `llm.js::agent` | 观察-思考-行动的 ReAct 工具调用循环 |
| **T 工具注册表** | ✓ | `tools.js` | `Registry`：JSON-Schema **校验** + 集中注册 + `execute()` 统一入口 |
| **C 上下文管理器** | ✓ | `context.js` | `Context`：字符预算 + 旧 tool 对**压缩/驱逐**（保留 tool_use↔tool_result 配对的有效性）|
| S 状态存储 | — | （未做，按需） | 产物 `.layout.json` 等是数据输入 |
| L 生命周期钩子 | — | （未做，按需） | 仅 onStep/onLog 回调 |
| V 评估接口 | ✓ | `eval.js` + `eval-blanks.js` + `bench-blank.js` | 人工评估表 + 精确率 + 自动基准 |

> 本次按需求只补了 **T 和 C**；S/L 暂不涉及。

## 文件

```
blank-harness/
  geometry.js    纯几何引擎（栅格 + 最大空白矩形 + thin-block + 框合并）
  context.js     C：Context 上下文管理器（预算 + 压缩）
  tools.js       T：Registry + JSON-Schema 校验 + 注册留白检测工具
  llm.js         独立 LLM 客户端 + agent 循环（用 Registry+Context 驱动）
  detect.js      检测主驱动（loadDeck + agent + visualize）
  eval.js        评估表 HTML + 精确率计算
  blankcheck.js  CLI：检测 + 画红框
  eval-blanks.js CLI：人工评估表 / 复算精确率
  bench-blank.js CLI：已知 ground-truth 的自动基准（precision/recall/F1）
```

## 用法

```bash
# 检测一份 deck（agentic：工具 T + LLM 大脑 + 红框标注）
node blank-harness/blankcheck.js output/xxx.pptx
node blank-harness/blankcheck.js output/xxx.pptx --no-llm        # 仅几何 sensor
node blank-harness/blankcheck.js output/xxx.pptx --save r.json

# 人工评估（浏览器逐框判 真留白/误报，实时通过率，导出 JSON）
node blank-harness/eval-blanks.js output/xxx.pptx
node blank-harness/eval-blanks.js --judgments xxx.judgments.json # 复算精确率

# 自动基准（受控集，已知 GT）
node blank-harness/bench-blank.js
```

## T（工具注册表）做了什么

- 工具集中注册：`Registry.register({name, description, input_schema, run})`。
- **执行前校验**：`registry.execute(name, input)` 先用轻量 JSON-Schema 校验器检查 `input`（type/required/enum/minimum/maximum/嵌套），不通过返回 `is_error` + 清晰原因（不再像以前那样把坏参数直接喂进工具导致难懂的运行时报错）。
- 未知工具名 → `is_error: "unknown tool … available: …"`。

## C（上下文管理器）做了什么

- `Context` 持有消息历史，**决定进模型上下文的内容**。
- 超过字符预算（≈ token×4）时，**驱逐最旧的 (assistant tool_use → user tool_result) 配对**：永远成对驱逐（保证每个剩余 tool_use 仍有结果，符合 API 约束），永远从最前驱逐（保持 user→assistant→user 交替有效），并保留最近 `keepLast` 条。
- 驱逐一次插一条系统提示，让模型知道早期工具调用已省略。`compactions` 计数可观测。

## 验证

- **T**：合法入参通过；缺字段/错类型/低于下限/未知工具/enum 违规均被拦截并返回明确信息。
- **C**：8 个 tool 对 + 600 字预算 → 驱逐 6 对、保留最近 2 对、size 回到预算内、tool_use↔tool_result 数量始终匹配（历史有效性保持）。
- **回归基准**：agentic 检测在 12 页受控集上 **精确率 100% / 召回 100% / F1 1.000**（LLM 大脑把几何 sensor 的 FP 全部滤掉）；真实密集 deck 检测 0 误报。
