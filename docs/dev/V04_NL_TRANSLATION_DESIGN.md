# V0.4 自然语言 → 策略卡 翻译层设计

状态：**阶段 A、B 已实现并随 v0.4.0 发布**（契约 + 离线确定性解析器 + 网页确认界面）；
阶段 C（可选 LLM 适配器）未开发。

关联文件：

- 契约与解析器：[`engine_next/strategy_nl.cjs`](../../engine_next/strategy_nl.cjs)
- 解析器验收：[`engine_next/tests/verify_nl_parser.cjs`](../../engine_next/tests/verify_nl_parser.cjs)
- 确认层服务：[`web/src/nlPreview.js`](../../web/src/nlPreview.js)（`POST /api/nl/preview`）
- 确认层验收：[`tools/check_nl_preview.cjs`](../../tools/check_nl_preview.cjs)
- 既有组件白名单：[`engine_next/strategy_conditions.cjs`](../../engine_next/strategy_conditions.cjs)
- 既有前置白名单：[`web/src/strategyCard.js`](../../web/src/strategyCard.js)
- 既有卡片 schema：[`docs/schemas/strategy.schema.json`](../schemas/strategy.schema.json)

---

## 一、目标与边界

**目标**：用户用中文说一句策略，系统给出**一张待确认的策略卡**，确认后才回测出片。

**本层只做一件事**：把中文句子翻译成 `params`（组合结构或模板参数）。
它**不取数、不回测、不渲染、不写文件**，也不决定证券代码、日期、本金。

**硬边界**：

1. 只输出既有白名单内的组件与参数，**不新增组件、不新增指标**。
2. 翻译产物必须通过既有 `normalizeParams` 与 `buildConditions` 两道门禁，否则拒绝。
3. 不理解的成分**一律报错**，不"猜一个最接近的"。
4. 没有 AI 也能用：本层默认实现是**确定性规则解析器**，零 API、零依赖、可离线。

---

## 二、三道门禁（顺序不可交换）

```text
中文文本
  → ① 受控词表匹配（只认白名单词）
  → ② 结构校验 normalizeParams（web/src/strategyCard.js，既有）
  → ③ 参数语义校验 buildConditions（engine_next/strategy_conditions.cjs，既有，用空行情数组只跑参数段）
  → 待确认的策略卡 params
```

第 ②③ 步是**既有代码原样调用**，翻译层不复制一份校验逻辑。这样"翻译层能过的，引擎一定也能过"，
不会出现两套口径漂移。

---

## 三、受控词表

### 3.1 入场（有且只有一个）

| 组件 | 中文说法（示例） | 参数 | 默认 |
|---|---|---|---|
| `maCross` | 5 日均线上穿 20 日均线 / MA5 上穿 MA20 / 短期均线上穿长期均线 / 均线金叉 | `fast`, `slow` | 5 / 20 |
| `breakout` | 突破前 20 日最高价 / 创 20 日新高 / 突破前高 | `lookback` | 20 |

### 3.2 退出（1~3 个，任一触发）

| 组件 | 中文说法（示例） | 参数 | 默认 |
|---|---|---|---|
| `fixedHolding` | 持有 5 个交易日 / 持股满 5 日 / 5 天后卖出 | `days` | 5 |
| `returnThreshold` | 止盈 10% / 涨 10% 卖出 / 止损 5% / 跌 5% 卖出 | `takeProfit`, `stopLoss` | 10% / 5% |
| `maCross` | 5 日线下穿 20 日线卖出 / 均线死叉卖出 | 与入场共用均线参数 | — |

### 3.3 模板路由

| 命中特征 | 路由 | 说明 |
|---|---|---|
| 含 `MACD` | `macd_cross` | 参数锁定 12/26/9，与封版回测一致 |
| 含"尾盘/收盘买入" + "次日开盘卖出" | `close_buy_open_sell` | 可选集合竞价跳空过滤 |
| 含均线金叉或突破，且至少一个退出条件 | `composition` | V0.3 组合通道 |
| 只有"金叉"没说指标 | **报错** `E_AMBIGUOUS_ROUTE` | 均线金叉与 MACD 金叉语义不同，不猜 |
| 同时出现组合条件与尾盘语义 | **报错** `E_AMBIGUOUS_ROUTE` | 成交时点不同，不猜 |

---

## 四、翻译产物契约 `stv.nl-draft/0.1`

```json
{
  "schema": "stv.nl-draft/0.1",
  "source": { "text": "原始输入", "normalized": "归一化后文本" },
  "route": { "templateId": "composition", "reason": "命中均线金叉 + 固定持有" },
  "params": { "composition": { "schema": "stv.composition/0.1", "entry": {}, "exits": [] } },
  "cardRequest": { "templateId": "composition", "symbol": "600000", "params": {} },
  "defaults":   [{ "field": "entry.params.fast", "value": 5, "why": "文本未给均线周期" }],
  "evidence":   [{ "slot": "entry", "type": "maCross", "text": "5日均线上穿20日均线", "start": 0, "end": 11 }],
  "unsupported": [],
  "issues":     [{ "level": "error", "code": "E_NOT_SUPPORTED", "message": "当前只支持…" }],
  "suggestedSymbol": "600000",
  "ruleText": "入场：MA5 上穿 MA20…",
  "requiresConfirmation": true,
  "executable": true
}
```

关键字段语义：

- `params`：解析后的**卡片最终参数**（老模板会含引擎补出的 `entryFill` / `exitFill`），已过 ②③ 门禁。
- `cardRequest`：**重建卡片的最小请求参数**，日期/本金/分红表由表单补齐后一并交给 `buildCard`。
  > 两者对 `composition` / `macd_cross` 是同一份对象；对老模板 `close_buy_open_sell` **必须不同**：
  > `normalizeParams` 会补 `entryFill` / `exitFill`，而 `buildCard` 不接受这两个键（它按模板自己补）。
  > 把 `params` 原样喂回 `buildCard` 会被 `E_PARAMS` 拒绝——这个不对称由验收第 19、20 项守住。
- `defaults`：**所有被填了默认值的位置都必须在这里列出**，确认页必须显示。参数可默认，条件不可默认。
- `evidence`：每个识别到的成分对应原文片段与偏移，用于确认页高亮与"我说的是这句"核对。
- `unsupported`：命中的非白名单词（KDJ、涨停板等）。
- `executable`：仅当 `issues` 中无 error 时为 true。**false 时 `params` 恒为 null**。

---

## 五、缺参与冲突的处理规则

### 5.1 参数缺失：可默认，但必须标注

用户说"均线金叉"没给周期 → 填 5/20，同时在 `defaults` 里记一条，确认页显示
"你没说均线周期，按 5/20 处理，可修改"。

### 5.2 条件缺失：不可补全

用户说"均线金叉买入"没说出场条件 → **报错 `E_NO_EXIT`**，绝不默认"持有一天"或"死叉卖出"。

用户说"止盈 10%"没提止损 → `takeProfit=0.10`、`stopLoss=null`，
**不会补一个 5% 止损**。这是最容易悄悄改变策略语义的地方，单独写进验收断言。

用户说"止盈止损"但没给数字 → 两个都用默认值，两条 `defaults` 都列出，请用户确认。

### 5.3 冲突：拒绝，不"修正"

| 情况 | 错误码 |
|---|---|
| 两个以上入场条件 | `E_MULTI_ENTRY` |
| 同一退出条件出现两次 | `E_DUP_EXIT` |
| 退出条件超过 3 个 | `E_TOO_MANY_EXITS` |
| `fast >= slow`（如 10 日线上穿 5 日线） | `E_MA_PARAMS` |
| 持有天数 ≤ 0 | `E_HOLD_DAYS` |
| 止盈止损同时关闭 | `E_TPSL_ALL_OFF` |
| 价格阈值不在 (0, 1) | `E_TPSL_PARAMS` |
| 出现非白名单指标（KDJ/RSI/布林/涨停板…） | `E_NOT_SUPPORTED` |
| 部分句子没解析出来 | `E_UNPARSED` |

一律**返回错误 + 原文片段**，不静默丢掉那半句再执行剩下的。

---

## 六、规则串展示

`describeDraft()` 把产物渲染成一句中文，确认页只读展示：

> 入场：MA5 上穿 MA20 金叉（收盘确认）。
> 出场（任一触发）：持有满 5 个交易日 / 止盈 +10% / 止损 -5%。
> 全部信号在收盘后确认，次一交易日开盘成交；不含分红，未复权。

规则串由**结构化字段生成**，不是让模型自由发挥，保证"展示的规则"与"执行的规则"同源。

---

## 七、确认与修改流程（阶段 B，已实现）

```text
输入中文 → POST /api/nl/preview → 确认卡片
   ├─ 规则串（只读，由结构化字段生成）
   ├─ 参数表（可编辑：fast/slow/lookback/days/tp/sl/holdIfGte）
   ├─ 默认值清单（有默认值时必须勾选「我已核对」才能点确认）
   └─ [解析]  [确认并填入策略卡]
```

- 改任一参数 → 重新 `POST /api/nl/preview` → 服务端用**同一套门禁**重算参数**和规则串**。
- 确认后 `nlState.confirmed` 成为唯一提交来源；描述文本、模板、入场/退出条件的任何手工改动
  都会立刻作废该确认，界面提示需重新解析。**未确认的草案永远不参与提交。**
- 只允许改数值，不允许借改参新增或删除条件：没有「固定持有」就改天数、没有「止盈止损」就改止盈，
  一律 `E_OVERRIDE_NO_TARGET`；MACD 改参 `E_OVERRIDE_LOCKED`；非白名单字段 `E_OVERRIDE_UNKNOWN`；
  类型不对 `E_OVERRIDE_TYPE`。唯一例外是 `stopLoss` 从 `null` 改为数值——那是用户显式补的，
  会同时反映在规则串里，并需要重新确认。

---

## 八、AI 边界（阶段 C）

若将来接入 LLM：

1. LLM 只允许输出 `stv.nl-draft/0.1`，**输出后走完全相同的 ②③ 门禁**，没有特权通道。
2. LLM 进程内**没有行情数据**、不能调用回测与渲染函数。
3. LLM 不得产出白名单外的组件；产出即被 `normalizeParams` 拒绝。
4. 关掉 LLM 时，阶段 A 的规则解析器与手动选组件仍然完整可用。

也就是说：**换掉翻译实现，不换执行契约**。这是"AI 只翻译、回测由确定性代码负责"的落地方式。

---

## 九、阶段 A 验收口径

`node engine_next/tests/verify_nl_parser.cjs`，覆盖：

1. 三类模板路由各自命中。
2. 中文数字（五日均线 / 持有十天）与全角标点归一化。
3. 参数默认值全部进入 `defaults`。
4. **只给止盈时不得补止损**。
5. 缺退出条件、多入场、参数冲突、非白名单指标一律 `executable=false` 且 `params=null`。
6. 每条可执行产物都能被 `normalizeParams` 与 `buildConditions` 接受。
7. 每条可执行产物都能被 `buildCard` 组装成合法策略卡（含日期与本金）。
8. 反向验证：把 `executable` 强行置 true 的错误产物必须被 `buildCard` 拒绝。

---

## 十、明确不做的事

- 不接任何 LLM / 外部 API（阶段 C；接的时候必须复用同一份 draft 契约与同一套门禁）。
- 不做多轮对话式澄清：一次只解析一句策略。
- 不在确认页增删条件：要换条件就改描述重新解析。
- 不解析证券代码以外的业务字段：日期、本金、分红表仍由表单提供。
- 不改 `strategy_conditions.cjs`、`strategy_runner_composed.cjs`、验收脚本与任何封版文件。
