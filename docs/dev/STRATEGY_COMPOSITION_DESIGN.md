# 策略表达层 V0.3 第一阶段 · 设计（先设计后编码）

状态：Draft 1 · 2026-11-17
基线分支：`feat/datafeed-pytdx` @ `0a85d6d244109acfcf934576874955721de3949b`
基线门禁（改动前实测）：策略引擎 27/27、策略卡接口 36/36、网页端到端 20/20、`resultSha256=5df18d704…`。

## 1. 本轮要解决的问题

验证「不同入场条件 + 不同退出条件及其组合，能否由配置自动形成完整策略，并转成可解释、可复算、可视化的视频」。
不是增加四种选股策略，也不是重做视频风格。目标是把新增策略变成**配置问题**。

## 2. 四个可组合组件（不是四套完整策略）

| 组件 | 角色 | 默认参数 | 规则 | 禁止 |
|---|---|---|---|---|
| `maCross` | 入场 / 退出 | 短 5、长 20、SMA | 金叉买、死叉卖 | 无 |
| `breakout` | 入场 | 回看 20 交易日 | 当日收盘 > 前 20 日最高价 | **计算前 20 日最高价必须排除当日**，禁止未来函数 |
| `fixedHolding` | 退出 | 5 个交易日 | 买入成交日记为第 1 日；持满 N 个完整交易日后，下一交易日开盘退出 | N 必须为正整数 |
| `returnThreshold` | 退出 | 止盈 10%、止损 5% | 以**实际买入成交价**为基准，收盘价触及阈值产生信号，下一交易日开盘成交 | 不使用日内 high/low 假设成交；止盈/止损可分别关闭 |

## 3. 组合结构

`一个入场 + 一个或多个退出`。退出为 **OR**：任一触发即退出。

- 组合 A：maCross 入场 + maCross 退出
- 组合 B：breakout 入场 + fixedHolding 退出
- 组合 C：breakout 入场 + 止盈 10% + 止损 5%
- 组合 D：maCross 入场 + fixedHolding 退出 + 止损 5%

**同一天多个退出同时触发**：只产生一笔 SELL，但 `exitReasons` 数组按组件在配置中的顺序完整保留所有触发原因，顺序 deterministic；`decisions` 里记一条 `kind=EXIT`，`reasons` 同序。不重复扣费用、不重复记账。

暂不支持：任意布尔表达式、多条件入场、加仓、分批止盈。

## 4. 统一交易约束（沿用既有引擎）

- 单一持仓，不加仓；买入 100 股整数倍；沿用 `stock_cost.cjs` 费用模型。
- 所有信号**收盘后确认**，**下一交易日开盘成交**。组合模式 `fillAssumption = {entry:'nextOpen', exit:'nextOpen'}`。
  这与旧 `close_buy_open_sell` 的 `sameClose` 入场不同，因此**只在组合模式生效**。
- 无下一交易日价格时不虚构成交：信号记 `executed:false, blocked:true, note:'无下一交易日'`。
- 预热期只算指标、不交易；预热区间不进 `equity`、`market`、不参与正式回测统计。
- 期末持仓沿用现有引擎规则（不强制平仓，`summary.unclosed=true`）。
- 封板、停牌、一字板、分红三段式、红利税口径全部沿用 `strategy_runner.cjs` 的 verbatim copy。

## 5. 向后兼容（硬约束）

1. 旧策略卡不写任何新字段 → **完全执行旧逻辑**，`resultSha256` 不变。
2. 新组件只有在卡片显式携带 `params.composition` 时才启用。
3. 新组件被选中后才应用其默认参数；未选中的组件参数即使出现也拒绝（白名单）。
4. 新字段不得改变旧策略状态机；不重写旧策略；不改费用/整手/现金/资产计算。
5. **实现方式**：新增独立受控副本 `engine_next/strategy_runner_composed.cjs` + 独立条件解析
   `engine_next/strategy_conditions.cjs`；`strategy_engine.cjs` 只在检测到 `params.composition` 时分发到新分支。
   `strategy_runner.cjs` 一行不改，旧分支路径字节级不变。
6. 视频链路不新增：继续使用 策略卡 → 自动取数 → 统一回测 → 统一结果契约 → 通用策略渲染 → 验收。

## 6. 卡片契约增量

在 `params.composition` 下新增（旧卡片无此字段）：

```json
{
  "composition": {
    "schema": "stv.composition/0.1",
    "entry": { "type": "maCross", "params": { "fast": 5, "slow": 20, "maType": "SMA" } },
    "exits": [
      { "type": "fixedHolding", "params": { "days": 5 } },
      { "type": "returnThreshold", "params": { "takeProfit": 0.1, "stopLoss": 0.05 } }
    ]
  }
}
```

- `entry.type` 只能是 `maCross` / `breakout`；`exits` 非空，长度 ≤ 3。
- `maCross` 作为退出时产生死叉信号。
- 每个组件的参数按白名单校验；`returnThreshold` 的 `takeProfit`/`stopLoss` 可设为 `null` 表示关闭，但不得同时关闭。
- 前端展示最终组合的人类可读规则串，创建任务时把完整 `composition` 存进卡片。
- `docs/schemas/strategy.schema.json` 增加 `composition` 定义，`additionalProperties:false` 不变。

## 7. 结果契约增量（只在新模式出现）

- `state.composition`：回显实际使用的组合与解析后的参数。
- `state.fillAssumption`：`{entry:'nextOpen', exit:'nextOpen'}`。
- `signals[]`：每条带 `type`（`ENTRY`/`EXIT`）、`component`、`reason`、`signalDate`、`execDate`、`executed`、`note`。
- `decisions[]`：`EXIT` 记录带 `reasons` 数组（同日多触发按配置顺序）。
- `trades[]`：新增 `signalType`（组件名）、`signalReasons`（退出时同 `reasons`）。
- `metrics.composition`：各组件触发次数统计（确定性）。

旧模式结果**不新增这些字段**，保持 `resultSha256` 稳定。

## 8. 验收方案

### 8.1 策略专属（新增 `engine_next/tests/verify_strategy_composition.cjs`）

1. MA 交叉日期由 `SMA(5)/SMA(20)` 正确计算，金叉/死叉方向正确。
2. 突破的 20 日窗口不包含当日（构造「当日最高价虚高」用例，确认不影响窗口）。
3. 固定持有天数：买入日为第 1 日，第 N+1 个交易日开盘卖出。
4. 止盈止损基准为实际买入成交价，不是信号日收盘价。
5. 同日多退出触发只成交一次，`reasons` 完整且顺序确定。
6. 买卖日期与实际成交日期一致（信号 T → 成交 T+1 开盘）。
7. 视频买卖标记与 `trades` 对应（复用 `accept_strategy_video.py` 的勾稽）。
8. 资产恒等式逐日成立、现金不透支（`asset = cash + shares*close + receivable`）。
9. 重复出片逐字节一致（两次独立 render，MP4 SHA 相同）。
10. 人为注入错误（改关键字段/破坏资产）后验收失败（`tools/check_accept_negative.py`）。

### 8.2 通用验收与反向验收

每张样例卡：`accept_strategy_video.py --run <run>`（20 项）+ `check_accept_negative.py`。
样例卡放 `samples/strategy_cards/`，四张分别覆盖任务书列举的四个组合。

### 8.3 旧策略门禁（必须全绿，不得改基准）

- `node engine_next/tests/verify_strategy_engine.cjs` → 27/27
- `node tools/check_strategy_card_api.cjs` → 36/36
- `npm run e2e:card` → 20/20
- 600000 锚点：46 笔、期末 96,652.73、`resultSha256=5df18d704…`
- `python engine_next/tests/accept_strategy_video.py --run strategy_600000_A` 结果不变
- `python tools/check_accept_negative.py` 反向验证仍有效

## 9. 文件清单（预期）

新增：
- `engine_next/strategy_conditions.cjs`
- `engine_next/strategy_runner_composed.cjs`
- `engine_next/tests/verify_strategy_composition.cjs`
- `samples/strategy_cards/composition_{ma_ma,breakout_hold,breakout_tpsl,ma_hold_sl}.json`
- 本设计文档

修改（只加分支，不改旧路径语义）：
- `engine_next/strategy_engine.cjs`（分发 + 结果契约增量）
- `web/src/strategyCard.js`（模板白名单、参数校验、规则串）
- `web/public/app.js`（入场选择、退出多选、参数显隐）
- `docs/schemas/strategy.schema.json`
- `docs/dev/CURRENT_STATE.md`（进度记录）
- 必要的后端适配器与校验文件

不改：`strategy_runner.cjs`、`engine_next/lib/*`、`render_strategy_video.py`、任何封版 V0.2 文件、`main` 分支。

## 10. 停止条件

- 基线无法解释地变化 → 立即停止并报告。
- 旧门禁任一项掉数 → 停止，回退本轮改动。
- 若今晚无法全部完成：提交已完成部分，如实更新 `CURRENT_STATE.md`，列出未完成项。
