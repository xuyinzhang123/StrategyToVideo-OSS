# V0.5 策略表达式扩展（阶段一：多条件入场 + 移动止损）

状态：**阶段一已实现**（分支 `feat/v0.5-expression`）。
只扩展**策略表达能力**，不改变回测口径、不改渲染器、不改验收体系。

关联文件：

- 条件计算：[`engine_next/strategy_conditions.cjs`](../../engine_next/strategy_conditions.cjs)
- 交易执行：[`engine_next/strategy_runner_composed.cjs`](../../engine_next/strategy_runner_composed.cjs)
- 前置白名单：[`web/src/strategyCard.js`](../../web/src/strategyCard.js)
- 卡片 schema：[`docs/schemas/strategy.schema.json`](../schemas/strategy.schema.json)
- 翻译层：[`engine_next/strategy_nl.cjs`](../../engine_next/strategy_nl.cjs)
- 验收：[`engine_next/tests/verify_strategy_composition.cjs`](../../engine_next/tests/verify_strategy_composition.cjs)

---

## 一、为什么要做

V0.3/V0.4 的管道已经打通（代码 → 取数 → 回测 → 视频 → 一句话描述），但**能穿过管道的策略太窄**：

- 入场只能选**一个**条件，真实策略里最常见的「金叉 **且** 放量/突破」进不来；
- 退出只有固定止盈止损（以买入价为基准），没有「跟着最高价上移」的移动止损。

这两点属于**表达式问题，不是 AI 问题**——词表再大、模型再强，白名单里没有对应组件就只能拒绝。
所以先补表达式，再谈语言层。

## 二、新增能力（两项）

### 2.1 多条件入场（AND）

```json
"entry": {
  "type": "all",
  "items": [
    { "type": "maCross",  "params": { "fast": 5, "slow": 20 } },
    { "type": "breakout", "params": { "lookback": 20 } }
  ]
}
```

- `items` 长度 2~3，元素只能是 `ENTRY_TYPES` 里的原子条件，**同类型不可重复**。
- 语义：同一交易日收盘时，**所有**子条件同时成立才算入场信号；仍然「收盘确认、次日开盘成交」。
- 旧写法 `entry: { type: 'maCross' | 'breakout', params }` **完全不变**，行为逐字节等价。
- 预热根数取各子条件的**最大值**。

### 2.2 移动止损（`trailingStop`）

```json
{ "type": "trailingStop", "params": { "drawdown": 0.08 } }
```

- 自**买入成交日**起，逐日跟踪持仓期**收盘价**的最高值 `peakClose`；
- 某日收盘价 ≤ `peakClose × (1 − drawdown)` → 该日收盘确认退出，**次一交易日开盘**卖出；
- `drawdown` 取 (0,1)，缺省 0.08；与 `returnThreshold` 的区别是基准跟着最高收盘上移，而不是钉在买入价。

**禁止未来函数的两条约束**：

1. `peakClose` 只用**已收盘**的收盘价更新，买入当日从成交价起步；
2. 判定使用「含当日收盘」的峰值——若当日创出新高，`close ≤ peak×(1−dd)` 必然为假，等价于使用「当日之前的峰值」，不会用当日数据反推当日信号。

## 三、向后兼容（硬约束）

| 关注点 | 处理 |
| --- | --- |
| 旧卡（无 `composition`） | 不进组合 runner，一行未改 |
| 旧组合卡（`entry` 为单个原子） | `buildConditions` 走同一分支，信号/成交/资产逐字节不变 |
| 退出数量上限 | 仍是 1~3（新增第 4 种类型后，用户从 4 种里选最多 3 种） |
| 成交价与成交日 | 全部维持「收盘确认 → 次开盘成交」，不引入盘中成交 |

验收方式不是「看代码觉得没问题」，而是：旧样例卡的 `resultSha256`、交易笔数、期末资产必须与 V0.4.0 **完全一致**。

## 四、不做的事

- 不做 OR 入场（`type: 'any'`）——先只补最常用的 AND，避免组合爆炸；
- 不做指标参数化（MACD 仍锁 12/26/9）——属于另一条独立改动；
- 不做选股/股票池（见 §5）；
- 不改渲染器与 20 项验收；
- 不改 `docs/DATA_SPEC.md` 的行情与复权口径。

## 五、遗留分叉（必须由产品决定，本阶段不碰）

当前系统是**单标的**：一个代码、一条资金曲线。真实世界的「策略」常含**选股**（扫一个池子挑出信号股）。
支持选股会改变数据契约（多标的行情）、回测模型（资金分配）、视频结构（榜单 vs 单标的复盘），
属于产品定义级改动。本阶段新增的组件与 AND 表达式在两种形态下都成立，因此先做不会白做。

## 六、验收

- `node engine_next/tests/verify_strategy_composition.cjs`：原有 10 项 + 新增项（AND 语义、AND 空集、移动止损触发与峰值、禁止未来函数、反向拒绝）全部通过；
- 旧链回归：引擎 27/27、策略卡 36/36、`check:api` 6/6、`check:samples` 30/30；
- 旧组合样例卡 `resultSha256` / 笔数 / 期末资产与 V0.4.0 一致；
- 新增样例卡一张，走真实取数端到端出片并通过 20 项独立验收。
