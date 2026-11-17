# 策略引擎交接（Draft 1 · 2026-11-17）

> 分支 `feat/datafeed-pytdx`，基点 `faa3d02`。本轮**不接 web、不改 V0.2 出片链、不动 main**。
> 这是“用户输入自己的策略就能出回测视频”这条目标的第一块地基：把“策略”从代码里抽成策略卡。

## 0. 一句话结论

新增了独立策略引擎：策略卡 → 统一 `backtest_result.json`。两个模板都**零改动复用**已封版内核
的纯函数；`macd_cross` 逐项复现 V0.2 全部锚点（证明等价于旧链路），`close_buy_open_sell`
（尾盘买/次日开盘卖）作为新增策略独立跑通。

## 1. 本轮新增

| 文件 | 作用 |
|---|---|
| `docs/STRATEGY_SPEC.md` | 策略卡契约 Draft 1：字段、区间/预热、数据口径、两个模板、统一结果、复现规则 |
| `docs/schemas/strategy.schema.json` | 策略卡 JSON Schema（draft-07） |
| `docs/schemas/backtest_result.schema.json` | 统一结果 JSON Schema（draft-07） |
| `engine_next/strategy_engine.cjs` | 策略引擎：`runStrategy(card, input, cfg)` + CLI，无顶层 I/O |
| `engine_next/tests/verify_strategy_engine.cjs` | 18 项自检：锚点复现 / 新模板 / 门禁 |

## 2. 两个模板与复用关系

- `macd_cross` → `runMacdStock`（`stock_macd_core.cjs`）：金叉买/死叉卖、次日开盘成交。
  **锚点复现**：金叉 12 / 死叉 11 / 23 笔 / 终值 102,918.09 / 持有 117,347.32 /
  费用 1,261.91 / 红利税 490.00 —— 与 V0.2 封版逐位一致。
- `close_buy_open_sell` → `runOvernightStock`（`stock_core.cjs`）：收盘买（用户口径：14:57
  收盘竞价结果即日线 `close`）/ 次日开盘卖（9:25 集合竞价结果即日线 `open`）。
  复用同一套费用、红利税、分红三段式、涨跌停封板、停牌顺延口径；**独立验收**，不套 MACD 41 项。

关键发现：`runOvernightStock` 本就是“收盘买/次日开盘卖”的完整内核，无需新增资金口径，
也无需等分钟/逐笔/竞价量数据（用户 11:13 口径修正：日线 `open/close` 已足够）。

## 3. 统一结果 `backtest_result.json`

字段见 `docs/STRATEGY_SPEC.md §3` 与 schema。`signals/trades/equity` 直接来自内核
（`daily.asset` 即 `equity.asset`），`metrics` 来自 `summary`，`decisions` 是新增的“为什么这么做”
说明层（供未来视频旁白与审计）。`reproducibility.resultSha256` 按“先置空再算”约定生成，可重复计算。

## 4. 自检结果（2026-11-17）

| 项目 | 结果 |
|---|---|
| `node engine_next/tests/verify_strategy_engine.cjs` | **18/18** |
| `python datafeed/eastmoney_fetch.py --selftest` | 20/20 |
| `node datafeed/tests/verify_eastmoney_e2e.cjs` | 8/8 |
| `npm run check:samples` | 30/30 |
| `git diff 5884e0f -- engine_next/lib/ web/ tools/ docs/DATA_SPEC.md docs/samples/ ...` | 空（既有四链零改动） |

## 5. 已知边界 / 待办

1. **未接网页**：网页仍是 V0.2 固定 MACD 链路。策略卡目前通过 CLI/库调用，下一步才做 Web 表单。
2. **预热区间是“契约声明”，引擎按整段跑**：自检用完整 260 日样例；`range.warmupBars` 目前只写入
   state 与门禁（bars 起点不能晚于展示起点），尚未做“预热段只算指标不交易、展示段才交易”的切分。
   这是下一步 web 接入前要补的语义。
3. **`close_buy_open_sell` 的 `auctionFilter`（9:25 跳空过滤）是声明字段，引擎尚未执行**：
   目前跑的是“每天收盘买/次日开盘卖”骨架，`auctionFilter` 只记录在策略卡与 schema 里。
   执行它需要给 `runOvernightStock` 增加可注入的入场条件（不改默认口径），列为下一步。
4. **自然语言 / 任意代码策略**：明确不做（见 SPEC §5 非目标）。
5. 不使用分钟/逐笔/竞价量数据；若将来要用“竞价情绪”的量级判断，另开 `basis` 与数据契约。

## 6. 下一步建议

1. 补 `warmupBars` 的真实切分语义（预热段不交易）。
2. 给隔夜内核加可注入的入场条件，让 `entrySignal` / `auctionFilter` 真正生效。
3. 网页接入策略卡表单：选模板 + 填参数 + 选区间 + 导入 CSV（复用现有 `validateImport`）。
4. 渲染器改为读 `backtest_result.json`（先做 MACD 模板的等价替换，保持 41/41）。

## 7. 硬边界（继续遵守）

不合并 main、不建 Release、不碰私人仓库、不强制推送、不把新策略塞进 MACD 41 项验收、
不造数据、不宣称“已接网页”。
