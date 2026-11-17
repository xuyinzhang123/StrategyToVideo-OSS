# 策略引擎交接（Draft 2 · 2026-11-17）

> 分支 `feat/datafeed-pytdx`，基点 `9cf821d` 之后的新提交。本轮**不接 web、不改 V0.2 出片链、不动 main**。
> 目标仍是“用户输入自己的策略就能出回测视频”的第一块地基：把“策略”从代码里抽成策略卡，并让策略卡的关键字段**真正执行**。

## 0. 一句话结论

独立策略引擎已把策略卡翻译成统一 `backtest_result.json`。`macd_cross` 零改动复用 `runMacdStock`，
逐项复现 V0.2 全部锚点；`close_buy_open_sell` 本轮从“骨架”升级为**完整 runner**：
预热段只算指标不交易、`macd_golden` 入场信号真正驱动建仓、9:25 跳空过滤真正影响持有/卖出决策。
封版 `engine_next/lib/` 一个字节都没改。

## 1. 文件清单

| 文件 | 作用 |
|---|---|
| `docs/STRATEGY_SPEC.md` | 策略卡契约：字段、区间/预热、数据口径、两个模板、统一结果、复现规则 |
| `docs/schemas/strategy.schema.json` | 策略卡 JSON Schema（draft-07） |
| `docs/schemas/backtest_result.schema.json` | 统一结果 JSON Schema（draft-07） |
| `engine_next/strategy_engine.cjs` | 策略引擎门面：`runStrategy(card, input, cfg)` + CLI；负责校验、组装、哈希 |
| `engine_next/strategy_runner.cjs` | `close_buy_open_sell` 专用内核，实现预热切分/入场信号/跳空过滤 |
| `engine_next/render_strategy_video.py` | **本轮新增**：只读统一结果的通用策略渲染器（价格/买卖点/资产/指标） |
| `tools/run_strategy_video.cjs` | **本轮新增**：策略卡 → 自动取数 → 回测 → 出片的 CLI 垂直切片 |
| `samples/strategy_cards/` | 策略卡样例（首版：600000 尾盘买/次日开盘卖） |
| `engine_next/tests/verify_strategy_engine.cjs` | **27 项自检**：锚点复现 / 新内核三项能力 / 门禁 / market 对齐 |

## 2. 两个模板与复用关系

- `macd_cross` → `runMacdStock`（`stock_macd_core.cjs`）：金叉买/死叉卖、次日开盘成交。
  **锚点复现**：金叉 12 / 死叉 11 / 23 笔 / 终值 102,918.09 / 持有 117,347.32 /
  费用 1,261.91 / 红利税 490.00 —— 与 V0.2 封版逐位一致（本轮改动后仍 7/7 不变）。

- `close_buy_open_sell` → `runStrategyRunner`（`strategy_runner.cjs`，本轮新增）：
  - 为什么另写 runner 而不改 `runOvernightStock`：后者是封版内核（V0.2 隔夜视频依赖它），
    语义固定为“每天收盘买/次日开盘卖”，没有入场条件、预热切分、跳空过滤。按项目既有惯例
    （`stock_macd_core.cjs` 复制分红三段式而不改 `stock_core.cjs`），新 runner **逐字复制**
    私有辅助函数，资金/费用/红利税/封板口径与封版内核完全一致。
  - 三项本轮真正执行的能力：
    1. **预热切分**（`range.start` 之前）：逐日估值照常产出（`state.warmupExec.mode=prepend-no-trade`），
       但**零成交**；MACD 用“预热+展示”全量计算，保证展示起点指标已热好。
    2. **入场信号**（`params.entrySignal`）：`macd_golden` 时只有金叉确认日才建仓，当日 `close` 买入
       （14:57 收盘竞价结果 = 日线 `close`）；`always` 为旧骨架（每交易日收盘买）；`none` 不建仓。
    3. **9:25 跳空过滤**（`params.auctionFilter`）：持仓期间每个交易日开盘计算
       `gap = open[T] / close[T-1] - 1`（9:25 集合竞价结果 = 日线 `open`）；
       `gap >= holdIfGte` → 产生 `HOLD` 决策、开盘继续持有；否则 `nextOpen` 卖出。
       结果在 `state.auctionFilter.executed=true` 与 `metrics.auction`（holdDays/gapsEvaluated/maxGap/minGap）可观测。

  - **成交口径必须显式披露**：`entryFill=sameClose` 是“尾盘口径”的既定价假设——MACD 交叉由当日
    `close` 计算并在当日 `close` 成交。引擎在 `state.fillAssumption` 写明 `{entry:'sameClose',exit:'nextOpen'}`，
    **不声称消除该假设**，也不把它伪装成无未来函数。若未来要严格规避，可改为“T-1 收盘信号→T 收盘成交”，另出口径。

## 3. 统一结果 `backtest_result.json`

字段见 `docs/STRATEGY_SPEC.md §3` 与 schema。`signals/trades/equity` 来自内核，
`metrics` 来自 `summary`；`decisions` 在 `close_buy_open_sell` 下由 runner 直接产出
（含 `openGapPct` / `HOLD` 决策），`macd_cross` 仍由门面归一化生成。
`market` 是展示区间行情副本（不参与回测），供渲染器画价格与买卖点，必须与 `equity` 日期逐日对齐。
`reproducibility.resultSha256` 按“先置空再算”约定，可重复计算。

## 4. 自检结果（2026-11-17）

| 项目 | 结果 |
|---|---|
| `node engine_next/tests/verify_strategy_engine.cjs` | **27/27**（含锚点 7/7、新内核 8/8、market 对齐 1/1） |
| `python engine_next/tests/accept_strategy_video.py --run strategy_600000_A` | **20/20**（日期对齐/成交价来自行情/持股守恒/资产恒等式/报告勾稽/规格 SHA/画面推进） |
| `python tools/check_accept_negative.py` | **PASS** 反向验证（注入 3 处故障 → 15/20、退出码 1） |
| `python datafeed/eastmoney_fetch.py --selftest` | 20/20 |
| `node datafeed/tests/verify_eastmoney_e2e.cjs` | 8/8 |
| `python datafeed/pytdx_fetch.py --selftest` | 13/13 |
| `node datafeed/tests/verify_datafeed_e2e.cjs` | 5/5 |
| `npm run check:samples` | 30/30 |
| `python engine_next/tests/test_timeline_bounds.py` | 封版口径逐位冻结 |
| `git diff 5884e0f -- engine_next/lib/ web/ tools/ docs/DATA_SPEC.md docs/samples/ ...` | 空（既有四链零改动） |

## 5. 已知边界 / 待办

1. ~~未接网页~~ **已接网页**（2026-11-17 傍晚）：`strategy_card` 通道，填代码+区间+模板即可出片，
   见 `docs/dev/CURRENT_STATE.md §A7`；本文件只讲引擎层。
2. **`auctionFilter` 的持有语义**：HOLD 后会在**后续每个交易日**开盘重新评估跳空，
   一旦 `gap < holdIfGte` 即卖出；展示区间最后交易日无条件开盘平仓。这是首版口径，
   若用户想要“HOLD 后固定持有 N 日”或“只判断一次”，需新增字段（如 `maxHoldDays`），不改默认。
3. **`warmupBars` 与真实数据的关系**：门面只校验 bars 起点不晚于展示起点；预热日数不足时，
   `macd_golden` 入场会因 MACD 未热好而无信号（结果诚实为空），不伪造交易。取数端应多取预热段。
4. **sameClose 的尾盘假设**：见 §2，已显式披露，未消除。
5. **自然语言 / 任意代码策略**：明确不做（见 SPEC §5 非目标）。
6. 不使用分钟/逐笔/竞价量数据；若将来要用“竞价情绪”的量级判断，另开 `basis` 与数据契约。

## 6. 下一步建议

1. ~~网页接入策略卡表单~~ **已完成**（§A7：自动取数 + 任务通道 + 表单 + 预览下载）。
2. ~~通用策略片独立验收~~ **已完成 20 项**（§A8：成交价来自行情、持股守恒、资产恒等式、
   报告勾稽、画面推进；`tools/check_accept_negative.py` 证明会失败，不是空跑）。
   剩余像素级细验（买卖标记坐标、字体遮挡）另立任务，不塞进这 20 项。
3. **增加 3~5 个可组合模板**（下一个最高优先）：均线交叉、突破、固定持有天数、涨跌幅阈值。
   改 `strategy_runner.cjs` 的退出条件前先设计；改完必须复跑 `verify_strategy_engine.cjs`
   27/27、600000 的 46 笔锚点与 20 项验收，`resultSha256` 应保持不变（新增可选参数默认关闭）。
4. 自然语言只作为“生成策略卡”的翻译层，必须人工确认后才执行；不做任意代码策略。
5. 如需更细的竞价情绪，另立数据契约（竞价量/未匹配量/逐笔委托），不塞进日线策略卡。

## 7. 硬边界（继续遵守）

不合并 main、不建 Release、不碰私人仓库、不强制推送、不把新策略塞进 MACD 41 项验收、
不造数据、不宣称“已接网页”、不修改 `engine_next/lib/` 任何封版文件。
