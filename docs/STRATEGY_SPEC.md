# 策略卡契约（Draft 1 · 2026-11-17）

> 状态：**契约定义阶段**。本文件定义「用户描述一个策略 → 统一回测 → 统一结果」的边界，
> 尚未接入网页。现有 V0.2 的 MACD 出片链（校验 / 八段结构 / 封版内核 / V1.2.3 / 41 项验收）
> 是已发布基线，**本契约不修改、不替代它**；策略引擎以独立模块存在，复用其纯函数。

## 0. 为什么需要这份契约

V0.2 已经能把「一份合规股票 CSV」变成一条可验收的 MACD 回测视频，但策略是写死在链路里的：
金叉买、死叉卖、次日开盘成交。要让开源用户「输入自己的策略」，必须先把“策略”从代码里抽出来，
变成一份**可校验、可复现、可审计**的描述——这就是「策略卡」。

契约设计遵循三条原则：

1. **策略是声明，不是代码**：用户填模板 + 参数 + 区间，不写 JS/Python，不开放任意代码执行。
2. **结果有统一形状**：任何策略都产出同一份 `backtest_result.json`，渲染器只读它，不认识策略细节。
3. **不绕过既有门禁**：数据仍走 `validateImport`（`adjust=none`、主板、≥34 根、G-6 复权拒绝）。

## 1. 策略卡（strategy card）

### 1.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | string | 是 | 契约版本，当前 `1.0` |
| `id` | string | 是 | 策略模板 id，如 `macd_cross` / `close_buy_open_sell` |
| `name` | string | 否 | 展示名 |
| `symbol` | string(6) | 是 | 沪深主板 6 位代码；其余板块在门禁阶段拒绝 |
| `nameOfSecurity` | string | 否 | 标的名称，仅用于展示 |
| `range` | object | 是 | 回测区间，见 §1.2 |
| `data` | object | 是 | 数据口径，见 §1.3 |
| `params` | object | 是 | 策略参数，由 `id` 对应的模板定义，见 §2 |
| `execution` | object | 否 | 成交假设，缺省取模板默认，见 §1.4 |
| `benchmark` | string | 否 | 对照策略，当前仅 `hold`（买入持有） |
| `reproducibility` | object | 否 | 复现标记，引擎写入结果，用户可不填 |

### 1.2 区间与预热（`range`）

```json
{
  "start": "2024-01-02",
  "end": "2024-12-30",
  "warmupBars": 60,
  "warmupMode": "prepend"
}
```

- `start` / `end`：用户想看的**展示区间**。
- `warmupBars`：为了让指标在 `start` 当天就已经“热好”，引擎额外向前取的交易日数。
- `warmupMode`：当前只支持 `prepend`（前面补数据）；预热段只算指标、不产生交易。
- **边界**：预热前的日期仍必须 ≥ `2015-08-01`（费用规则起点）；预热后可用交易日必须
  大于该策略的 `readyFrom`（MACD 为 33，即至少 34 根），否则 `E_TOO_FEW_BARS`。
- 用户不填 `warmupBars` 时，引擎按 `id` 的模板默认值取；`data.start` 若早于
  `start - warmupBars`，以数据实际起点为准并在结果里记 `warnings`。

### 1.3 数据口径（`data`）

```json
{
  "adjust": "none",
  "dividendPolicy": "provided",
  "source": "eastmoney-push2his",
  "sourceSha256": "<原始 CSV 的 sha256>"
}
```

- `adjust`：**只接受 `none`**。这是 V0.2 的 G-6 门禁；`qfq`/`hfq` 是合成价，会让费用与
  成交金额脱离真实账户，策略引擎同样拒绝 `E_ADJUST_UNVERIFIED`。
- `dividendPolicy`：`provided`（有分红表，三段式齐全）或 `ignored`（明确忽略，结果须标注
  “不含现金分红”，对应现有 `W_NO_DIVIDENDS`）。**禁止推导登记日/派息日**。
- `source`：数据来源标识（`eastmoney-push2his` / `pytdx-TdxHq` / `USER_CSV`）。
- `sourceSha256`：原始输入留档哈希，用于复现。

### 1.4 成交假设（`execution`）

```json
{
  "entryFill": "nextOpen",
  "exitFill": "nextOpen",
  "sealedLimitBlocks": true,
  "lotSize": 100,
  "initialCapital": 100000
}
```

- `entryFill` / `exitFill`：成交价取值，当前支持 `nextOpen`（信号次日开盘）与
  `sameClose`（信号当日收盘，即用户所说的“尾盘竞价买入”）。
- `sealedLimitBlocks`：一字封板是否阻断成交，缺省 `true`（与既有内核一致）。
- 资金、费用、红利税、停牌顺延口径**全部复用现有内核**，策略卡不得覆盖。

## 2. 首版策略模板

### 2.1 `macd_cross`（回归基线）

参数：

```json
{ "fast": 12, "slow": 26, "signal": 9 }
```

语义：金叉买入、死叉卖出，`nextOpen` 成交，与现有 V0.2 完全一致。  
**验收硬约束**：260 日样例（600000 + 2 次分红）必须逐项复现锚点——
金叉 12 / 死叉 11 / 23 笔 / 终值 102,918.09 / 持有 117,347.32 / 费用 1,261.91 / 红利税 490.00。  
这是“策略卡等价于旧链路”的证明，任何漂移都视为回归失败。

### 2.2 `close_buy_open_sell`（用户主线，新增策略）

参数：

```json
{
  "entrySignal": "macd_golden",
  "entryFill": "sameClose",
  "exitFill": "nextOpen",
  "auctionFilter": { "basis": "open_gap_pct", "holdIfGte": 0.02, "else": "sellAtOpen" },
  "warmupBars": 60
}
```

语义：

- 信号日尾盘按 `close` 买入（用户口径：14:57 收盘集合竞价结果即日线 `close`）；
- 次日按 `open` 卖出（用户口径：9:25 集合竞价结果即日线 `open`）；
- `auctionFilter` 是**可选的 9:25 情绪判断的价格版**：只用 `open` 与前一交易日 `close`
  计算的跳空幅度，不依赖竞价量/未匹配量/逐笔委托；若以后要用量级数据，另开 `basis`。
- 该模板是新策略，**独立验收**，不塞进 MACD 的 41 项验收，也不改 V0.2 数值。

> 执行状态（2026-11-17 更新）：本模板由 `engine_next/strategy_runner.cjs` 执行，三项声明字段均已真正生效——
> ① `range.start` 前为预热段，只算指标、逐日估值照常产出但**零成交**；
> ② `entrySignal=macd_golden` 时只有金叉确认日才建仓、当日 `close` 买入；
> ③ `auctionFilter` 在持仓期间每个交易日开盘计算 `gap=open[T]/close[T-1]-1`，`gap>=holdIfGte` → `HOLD`
> （开盘继续持有），否则 `nextOpen` 卖出，最后展示交易日无条件开盘平仓。
>
> 边界声明：`entryFill=sameClose` 是“尾盘口径”的既定价假设——MACD 交叉由当日 `close` 计算并在当日
> `close` 成交。引擎在 `state.fillAssumption` 写明 `{entry:'sameClose',exit:'nextOpen'}`，**不声称消除该假设**。
> 它不与 V0.2 视频链绑定（封版 `engine_next/lib/` 零改动），需有自己的独立验收与确定性验证。

## 3. 统一回测结果（`backtest_result.json`）

任何策略都产出同一结构；渲染器只读这个文件：

```json
{
  "schemaVersion": "1.0",
  "strategy": { "<策略卡原样，含 id / params / range / data / execution>" },
  "state": {
    "start": "2024-01-02", "end": "2024-12-30", "bars": 260,
    "warmupBars": 60, "readyFrom": 33, "warnings": []
  },
  "market": [
    { "date": "2024-01-02", "open": 8.10, "high": 8.20, "low": 8.02, "close": 8.15, "volume": 120000 }
  ],
  "signals": [
    { "date": "2024-03-05", "type": "GOLDEN", "indicators": { "dif": 0.12, "dea": 0.09, "hist": 0.03 },
      "execDate": "2024-03-06", "execPrice": 8.42, "executed": true, "blocked": false, "note": "" }
  ],
  "trades": [
    { "seq": 1, "side": "BUY", "date": "2024-03-06", "price": 8.42, "shares": 11800,
      "amount": 99356.00, "fee": 29.81, "feeBreakdown": { "commission": 29.81, "stampDuty": 0, "transferFee": 0.99 },
      "dividendTax": 0, "holdingDays": null, "signalType": "GOLDEN", "signalDate": "2024-03-05" }
  ],
  "equity": [
    { "date": "2024-01-02", "cash": 100000, "shares": 0, "holdingValue": 0,
      "divReceivable": 0, "asset": 100000, "drawdown": 0, "flags": [] }
  ],
  "decisions": [
    { "date": "2024-03-06", "kind": "ENTRY", "reason": "macd_golden", "openGapPct": null, "action": "BUY_AT_CLOSE" }
  ],
  "metrics": {
    "final": 102918.09, "totalReturn": 0.02918, "cagr": 0.0, "maxDD": 0.0987,
    "tradeCount": 23, "goldenCount": 12, "deathCount": 11,
    "totalFees": 1261.91, "totalDividendTax": 490.00,
    "feeBreakdown": { "commission": 689.36, "stampDuty": 549.57, "transferFee": 22.98 },
    "benchmark": { "id": "hold", "final": 117347.32 }
  },
  "reproducibility": {
    "engineVersion": "0.1.0", "resultSha256": "<结果 JSON 去掉该字段后的 sha256>"
  }
}
```

字段来源（不重算、不改写）：`signals/trades/equity` 直接来自内核的
`runMacdStock().signals / .trades / .daily`（其中 `daily.asset` 即 `equity.asset`，
`daily.mark` 即收盘估值）；`metrics` 来自内核 `summary`；`decisions` 是策略卡新增的
“为什么这么做”的说明层，用于视频旁白与审计。

`market` 是展示区间的行情副本（`date/open/high/low/close`，可选 `volume`），只为渲染器
画价格与买卖点提供数据，**不参与回测计算**，也不改变任何资金/费用口径。加入它是为了兑现
“渲染器只读 `backtest_result.json`”这条约束：渲染阶段不再回头读原始 CSV 或重新取数。
它必须与 `equity` 的日期逐日对齐，且只覆盖 `range.start ~ range.end`（预热段不入片）。

## 4. 复现与版本

- 同一份「策略卡 + 原始输入 CSV + 引擎版本」必须产出逐字节相同的 `backtest_result.json`。
- `resultSha256` 的计算：先把 `reproducibility.resultSha256` 置空，序列化（键排序、
  无缩进），取 SHA-256，再写回字段。
- 引擎版本变更若改变数值语义，必须升 `engineVersion`，并为旧模板保留回归锚点。

## 5. 非目标（首版明确不做）

- 自然语言直接生成策略并执行；
- 任意 JS/Python 代码作为策略；
- 多标的组合、加仓、部分卖出、做空、再投资（受 `support_guard` 限制）；
- 分钟 / 逐笔 / 集合竞价量级数据（日线 OHLC 足以表达首版两个模板）；
- 接入网页或改动已发布视频链。

## 6. 与现有资产的关系

| 资产 | 关系 |
|---|---|
| `engine_next/lib/stock_macd_core.cjs` | `macd_cross` 直接复用 `runMacdStock`，零改动 |
| `engine_next/lib/stock_core.cjs` | 复用 `buildTimeline` / `runHoldStock` |
| `engine_next/lib/stock_cost.cjs` | 复用 `buildSchedule` / `tradeFee` / `dividendTax` / `affordableShares` |
| `engine_next/backtest_stock_macd.cjs` | 不改：它是 CLI，顶层即执行，不能当库 |
| `web/src/import/validate.js` | 复用同一门禁（CSV 仍要过 `validateImport`） |
| V1.2.3 视频链 | 不改：未来渲染器只读 `backtest_result.json` |
