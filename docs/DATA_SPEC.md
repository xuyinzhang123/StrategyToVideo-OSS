# 用户数据契约（V0.2 · Draft 4）

> 状态：**A / B / C 三类均已实现并跑通出片，含原始 CSV 留档、SHA-256 指纹与行号溯源；C 类（股票日线）走 V1.2.3 并通过 41 项独立验收交付，复权口径仅支持 `adjust=none`（§7.2）**。
> 适用范围：Open Source V0.1 之后新增的「用户导入 CSV」通道（V0.2）。
> 上游依据：**Issue #1「v0.2 / 1：用户 CSV 输入到本地视频的端到端流程」**（open）。该 Issue 位于私人主仓库，未随开源包公开，故此处不写链接；`AC-01 ~ AC-20`（§9）即对应该 Issue 的验收标准。
>
> **Draft 1 → Draft 2 变更记录（均为修正，非扩展）**
> 1. 修正千分位数字的接受/拒绝规则：新增 `E_THOUSANDS_SEPARATOR`，并把「引号内严格千分位」与「其他含逗号形态」分开；补上 RFC 4180 引号规则（否则千分位判定不可达，见 §1.1 / §1.2）。
> 2. 新增 §1.7 字段映射：明确列名不固定，映射由参数提供——这是 Issue #1「只通过映射即可出片、无需改源码」的落地依据。
> 3. 把 C 类 `qfq` 封板验证（V-01）单列为「股票通道门禁」（§7.1），明确**不阻塞 A/B 通用 CSV**。
> 4. 状态从「尚未实现」更正为「A/B 已实现、C 未实现」；Issue #1 存在性的事实更正。
>
> **Draft 2 → Draft 3 变更记录（补齐 Issue #1 的追溯与复现条件）**
> 1. 新增 §1.8：原始 CSV 留档为 `source.csv`、SHA-256 指纹、`line` 源行号、`traceability.json`、按行号回读核对。
> 2. 新增 §1.9：确定性（同输入 → 逐字节相同 MP4）与任务删除语义（连原始 CSV 与视频一起删除）。
> 3. 页脚不再显示导入时间，改显示源文件 SHA-256 前 12 位——时间戳会破坏确定性。
> 4. §6.1 新增 `E_SOURCE_MISSING` / `E_TRACE_MISMATCH` / `E_TRACE_FAILED` / `E_TRACE_MISSING`；§9 新增 AC-15 ~ AC-18。
>
> **Draft 3 → Draft 4 变更记录（发布前代码审查的三处口径修正，不扩展功能）**
> 1. **C 类补齐溯源**：股票通道此前只留档 + SHA，不写 `traceability.json`，网页溯源面板对股票任务为空。现与 A/B 同契约：逐根 K 线的日期与 OHLC、逐条分红的除息日与每股现金红利 → `source.csv` / `dividend.csv` 行号；渲染前回读核对，不符即 `E_TRACE_FAILED`（§1.8）。
> 2. **页脚兑现「来源说明」**：表单写明「会写进视频页脚」，但股票通道的 `copy.footer_left` 未使用 `sourceNote`。现写入页脚，并对页脚左段与页头副标题做宽度自适应（缩字号→省略号），避免长文件名/长来源压到右侧免责声明。
> 3. **`/api/health` 与实际可执行能力对齐**：`executableStrategies` / `execution.strategies` / `strategyModes` 统一由 `STRATEGY_MODES` 派生并包含 `stock_ohlc`，消除「前端可执行、接口宣称不可执行」的矛盾；新增 `npm run check:api` 守这条口径（AC-20）。
> 4. `check:samples` 增至 30 项（新增股票溯源：无分红 260/260、含分红 262/262、篡改一行即拒绝）；§9 新增 AC-19 / AC-20。

---

## 0. 一句话说清这份文档在解决什么

V0.1 只有一条数据通道：随包的 SIMULATED 模拟日线 → MACD 回测 → 视频。V0.2 要新增「用户自己的 CSV」，但**用户数据不止一种形状**：有人要传一条时间序列，有人要传一组横向对比，有人要传一只股票的 OHLC。

所以本契约先做一件最容易被跳过的事：**把数据类型分开，而不是把所有 CSV 都塞进股票回测的八段结构**。

```text
用户 CSV
├── A. timeseries      通用时间序列（date, value）
├── B. cross_section   横向对比快照（label, value）
└── C. stock_ohlc      股票日线（date, open, high, low, close）→ 唯一可复用现有 MACD 链路
```

三条不可动摇的原则：

1. **A / B 类不得被要求补出股票回测的八段内部结构**（`meta/bars/calendar/suspensions/actions/actionsOutOfRange/exChecks/checks`）。它们各有自己的轻量归一化结构。
2. **不是所有 CSV 都导向 MACD**。只有 C 类走现有回测与 V1.2.3 渲染器。A / B 类走通用图表渲染，与策略、回测、费用、分红无关。
3. **不自动生成新结论**。画面只呈现数据里存在的事实；收益率、回撤、年化、归因等需要口径的指标，通用类一律不计算。

---

## 1. 通用规则（三类共用）

### 1.1 文件与编码

| 项 | 规定 | 违反时 |
|---|---|---|
| 编码 | UTF-8，允许带 BOM | 非 UTF-8（含 GBK/GB18030、UTF-16）→ `E_ENCODING` |
| 分隔符 | 英文逗号 `,` | 分号/制表符 → `E_DELIMITER` |
| 引号 | RFC 4180 子集：字段可用 `"` 包裹；`""` 表示一个引号；**引号内允许逗号与换行** | 引号未闭合 → `E_QUOTE_UNCLOSED` |
| 引号外的 `"` | 按普通字符处理，不报错（避免误伤纯文本列） | — |
| 换行 | LF、CRLF、CR 均可 | — |
| 表头 | 必须有，第 1 行 | 缺表头 → `E_HEADER_MISSING` |
| 大小写 | 列名不区分大小写，前后空白忽略 | — |
| 空行 | 跳过 | 记 `W_BLANK_ROW` |
| 文件大小 | ≤ 2 MiB | 超限 → `E_FILE_TOO_LARGE` |
| 数据行数 | 2 ~ 20,000 行（不含表头） | 越界 → `E_ROW_COUNT` |
| 列数 | ≤ 20 列 | 超限 → `E_COLUMN_COUNT` |

> GBK 一律拒绝而不是自动转码：Node 内置 `TextDecoder` 虽支持 `gbk`，但服务端当前是零依赖纯 Node，**静默转码会掩盖「用户以为传的是 UTF-8」的真实错误**，且转码失败时错误更难定位。拒绝时提示「请用记事本/Excel 另存为 UTF-8」。
>
> **引号规则为什么必须写进契约**：`"1,234.50"` 能被当成「一个字段」，前提是解析器遵守引号。若按逗号裸切，这份样例只会报 `E_ROW_FIELD_COUNT`（多出一列），永远走不到 §1.2 的千分位判定。规则在 §1.1，判定在 §1.2，两者缺一不可。

### 1.2 数值

| 情形 | 判定 | 说明 |
|---|---|---|
| `100`、`-3.5`、`+2`、`0.001`、`1.5e3` | ✅ 接受 | 十进制或科学计数法 |
| 前后空白 | ✅ 接受 | 先 `trim()` 再解析 |
| **引号内的严格千分位**：`"1,234"`、`"1,234.5"`、`"-12,345.50"` | ❌ 拒绝 `E_THOUSANDS_SEPARATOR` | 报「检测到千分位逗号，请删除逗号后重传」+ 行号 + 列名 + 原文 |
| 引号内其他含逗号形态：`"1,23.4"`、`"1,234,5"` | ❌ 拒绝 `E_BAD_NUMBER` | 连千分位都不成立，属格式非法 |
| **未加引号的** `1,234.5` | ❌ 拒绝 `E_ROW_FIELD_COUNT` | 未引号字段里的逗号就是分隔符，该行必然多出一列。这是唯一可确定的判定，不假装能识别 |
| 货币符号（`¥1,234`）、百分号（`12%`）、中文数字、空字符串占位 | ❌ 拒绝 `E_BAD_NUMBER` | 单位由表单元数据 `unit` 声明，不写进单元格 |

严格千分位的判定式（同时满足才算「可识别的千分位」）：

```text
^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$
```

> **为什么千分位不自动清洗**：逗号在不同区域既可能是千分位（`1,234` = 一千二百三十四），也可能是小数点（德语区的 `1,234` = 1.234）。任何自动清洗规则都会对一半用户是错的，而且错得**不会报错**。所以这里只做可判定的事：把「严格千分位」与「格式非法」拆成两个错误码，让用户一眼知道该删逗号还是该改写法。
>
> **为什么不静默放过**：`"1,234"` 与 `"1234"` 混在一列时，即使清洗成功，也无法判断那处逗号是导出格式还是笔误。宁可让用户改一次，也不让一个错误数字混进视频。

### 1.3 日期

- 只接受 `YYYY-MM-DD`。
- 拒绝 `YYYY/MM/DD`、`MM/DD/YYYY`、`2024-1-5`、Excel 序列号（`45292`）。
- 违反 → `E_DATE_FORMAT`。

> `03/04/2024` 在不同地区分别指 3 月 4 日和 4 月 3 日，自动猜测必然有一半用户是错的，因此不做兼容。

### 1.4 排序

| 情形 | 处理 |
|---|---|
| 严格升序 | 通过 |
| **整体降序**（完全逆序） | 自动反转为升序，记 `W_DESC_ORDER`（很多导出默认最新在前，属常见无害情形） |
| 其他任何无序（部分乱序、重复交错） | 拒绝 `E_DATE_UNORDERED` |

> 只对「整体降序」放行：这是一种可判定、无歧义的导出习惯；部分乱序则多半意味着数据被拼接过，静默重排会掩盖问题。

### 1.5 空值与可选列

- 必填列为空 → `E_ROW_EMPTY_FIELD`。
- 可选列：**必须整列有值或整列全空**；只有部分行有值 → `E_PARTIAL_COLUMN`（不做「有值就用、没值就猜」）。
- A 类的 `value` 允许空（表示该时点无观测）→ 记 `W_NULL_VALUE`，渲染为断点，**不插值、不前向填充、不补零**。
- 未声明的多余列 → 忽略，记 `W_EXTRA_COLUMN`（不拒绝，便于用户保留自己的备注列）。

### 1.6 元数据由表单提供，不写进 CSV

以下字段一律通过网页表单/请求字段传递，不允许塞进 CSV 列，也不从文件名猜测：

`class`（数据类别）、`title`、`unit`、`as_of`、`symbol`、`name`、`adjust`、`source_note`。

> 理由：这些是「这批数据是什么」的声明，属于用户主张，必须与文件内容分离并可追溯；混进 CSV 会让同一份数据在不同列名下产生不同含义。

### 1.7 字段映射：列名不固定，映射由参数提供

CSV 的列名**不要求**叫 `date` / `value` / `label`。解析器只认「映射参数」，不认硬编码列名：

```json
{ "mapping": { "date": "成交日期", "value": "销量", "series": "产品线" } }
```

| 项 | 规定 |
|---|---|
| 映射方向 | `目标字段 → 源列名`。不用列序号，避免插列后整列错位 |
| 必填映射 | A 类：`date`、`value`；B 类：`label`、`value` |
| 可选映射 | A 类：`series`；B 类：`group`、`value2` |
| 缺省行为 | 未提交的映射项按 §1.7.1 别名表兜底匹配一次；必填项仍匹配不到 → `E_MAPPING_COLUMN` |
| 源列不存在 | `E_MAPPING_COLUMN`，报「目标字段 + 期望列名 + 文件实际表头」 |
| 目标字段非法 | `E_MAPPING_FIELD`，报非法字段 + 允许清单 |
| 同一源列被两个目标字段占用 | `E_MAPPING_DUP`（不允许一列既当 `value` 又当 `value2`） |
| 未参与映射的列 | 忽略，记 `W_EXTRA_COLUMN` |
| 列名比较 | 先 `trim()` 再转小写 |

> **这条规则就是 Issue #1 的验收口**：「换一份符合约定的用户 CSV，只通过界面或参数映射字段即可生成 MP4，无需改源码」。落到实现上就是——映射只存在于请求参数里，校验器与渲染器读的是「目标字段」，从不读取具体列名。§11 有实测：同一批数据换三种表头，走映射后产出同一张图。

#### 1.7.1 别名表（仅在「未显式提交映射」时兜底一次）

| 目标字段 | 别名（`trim` + 小写后比较） |
|---|---|
| `date` | `date`、`日期`、`时间`、`交易日`、`月份`、`年月` |
| `value` | `value`、`数值`、`值`、`金额`、`数量`、`指标值` |
| `series` | `series`、`序列`、`系列`、`名称`、`name` |
| `label` | `label`、`名称`、`标签`、`项目`、`对象`、`渠道`、`name` |
| `group` | `group`、`分组`、`组别`、`类别` |
| `value2` | `value2`、`对照`、`上期`、`对比值`、`第二数值` |

> 别名表只是「省一次点击」，不算契约的一部分。若一个列名同时命中两个目标字段（歧义），**要求用户显式提交映射**，不做猜测。

### 1.8 原始文件留档、指纹与行号溯源

Issue #1 的第四条要求是「视频里的数字能回溯到原始数据」。只记录文件名和列名不够——那只能说明「大概来自这份表」。因此从本版起：

| 项 | 规定 |
|---|---|
| 留档位置 | 任务目录 `web/tasks/<taskId>/source.csv`，内容是**本次校验所依据的那份 UTF-8 文本**（浏览器 `FileReader` 按 UTF-8 解码后的结果，BOM 已在解码阶段处理） |
| 指纹 | `sha256(source.csv 的字节)` 全 64 位，写入任务记录（`status.source.sha256`）、归一化模型（`meta.sourceSha256`）与溯源清单 |
| 画面呈现 | 视频页脚显示 `文件名 + sha256 前 12 位`。**页脚不显示导入时间**：时间戳会让同一份数据在不同日期出片得到不同字节，破坏确定性（见 §1.9） |
| 源行号 | 归一化模型里每个数据点/条目带 `line`（源文件物理行号，1 起，表头是第 1 行） |
| 行数口径 | `source.lines` / `meta.sourceLines` 是**源文件文本行数**（含表头，文件末尾换行不额外计一行）；`source.dataLines` 是**实际数据记录数**（不含表头，跳过空行），与 `meta.rowCount` 同义。两者在网页任务详情分别展示，行号溯源仍按物理行号，不因统计口径变化而改写 |
| 溯源清单 | 渲染成功后写 `web/tasks/<taskId>/traceability.json`：源文件指纹、映射、逐条 `{位置, 数值, sourceLine, sourceFile, sourceText}`、视频 sha256。A/B 类逐数据点；C 类逐根 K 线（日期 + OHLC）与逐条分红（除息日 + 每股现金红利，`sourceFile=dividend.csv`） |
| 回读核对 | 渲染前**重新解析** `source.csv`（C 类另加 `dividend.csv`），按行号取回该行，逐字段比对：A/B 比对日期/名称/数值，C 比对 K 线日期与 OHLC、分红除息日与每股现金红利；任一处不符 → `E_TRACE_FAILED`，**拒绝交付** |
| 推导量 | 视频里的资产金额、收益率、信号标签由回测按输入计算，**不是 CSV 原始数字**；`traceability.json.derivations` 明写这层关系，清单只声称「输入来自这一行」，不假装画面数字能逐字反查 CSV |
| 留档被改动 | `source.csv` 的 SHA-256 与创建时记录的不一致 → `E_TRACE_MISMATCH`，拒绝交付 |
| 留档缺失 | 任务目录没有 `source.csv` → `E_SOURCE_MISSING`，拒绝交付（宁可不给视频，也不给一份无法追溯的视频） |
| 隐私边界 | 留档只在本机任务目录，`.`gitignore` 已排除 `web/tasks/`；不上传、不进版本控制。删除任务即删除留档 |

### 1.9 确定性与任务删除

- **确定性**：同一份 CSV + 同一组元数据，两次独立出片（不同任务、不同运行目录、不同进程）必须得到**逐字节相同**的 MP4。画面内容只取决于数据与表单字段，不取决于时间、机器路径或随机量。仓库提供 `npm run check:determinism` 做两次独立对拍。
- **删除语义**：`DELETE /api/tasks/<taskId>` 会删除任务目录（`source.csv`、`import.json`、`status.json`、`video.mp4`、`engine.log`、`traceability.json`）与运行目录（`output/web_<uuid>`）。执行中的任务拒绝删除（`E_ALREADY_RUNNING`）；删除后任务 ID 不可再查询。
- 删除是**用户显式操作**，不做自动清理：任何自动流程都不会删掉用户已生成的视频。

---

## 2. 数据类 A：通用时间序列 `timeseries`

### 2.1 最小字段

下表的列名是**目标字段名**，不是 CSV 里必须出现的字面列名——实际列名由 §1.7 的映射参数指向。

| 列 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `date` | ✅ | `YYYY-MM-DD` | 观测时点 |
| `value` | ✅ | 数值 | 该时点的数值；允许负值、允许 0、允许空（断点） |
| `series` | ⬜ | 文本 | 序列名；缺省时整个文件视为单序列，名称取表单 `title` |

约束：

- 1 ~ 6 条序列。超过 6 条 → `E_TOO_MANY_SERIES`（同图折线超过 6 条已不可读）。
- 每条序列有效点 ≥ 2，否则 `E_SERIES_TOO_FEW`。
- `(series, date)` 唯一；重复 → `E_DUP_DATE`。
- 各序列日期集合**可以不一致**（参差）→ 记 `W_RAGGED_SERIES`，渲染时缺处断线，不补齐。

### 2.2 归一化结构（**不是**股票八段结构）

```json
{
  "class": "timeseries",
  "meta": {
    "title": "月度产能利用率",
    "unit": "%",
    "source": "user-import",
    "fileName": "capacity.csv",
    "importedAt": "2026-11-15T12:00:00Z",
    "seriesNames": ["A", "B"],
    "rowCount": 36,
    "gaps": [{ "series": "B", "from": "2025-04-30", "to": "2025-06-30", "missingPoints": 2 }]
  },
  "series": [
    { "name": "A", "points": [{ "date": "2025-01-31", "value": 71.2 }] }
  ]
}
```

这张结构里**没有** `bars`、`calendar`、`actions`、`suspensions`、`meta.symbol`。不要求用户提供交易日历、不复权、不算费用。

`meta` 另有两个字段用于回溯（Issue #1 要求「保留原始字段、转换规则及来源」）：`mapping`（目标字段 → 源列名）与 `warnings[]`（本文件命中的全部 `W_*`）。

### 2.3 预期视频

| 项 | 规定 |
|---|---|
| 时长 | 20 ~ 35 s |
| 规格 | 1920×1080 @ 30fps（沿用现有唯一已验证规格，暂不新增竖屏） |
| 主视觉 | 折线随横轴推进生长，线宽 ≥ 4px |
| 读数 | 当前时点数值 + 日期，随动画更新 |
| 标注 | 首值、末值、最大值、最小值四处定点标注（附日期） |
| 图例 | 顶部，序列名 + 末值 |
| Y 轴 | 自适应数据域 + `nice_step`，**必须标注轴范围**，不强制从 0 起 |
| 缺口 | 断线，不连接、不插值；画面标注「N 处断点」 |
| 派生指标 | **不显示**收益率、回撤、年化、同比——通用类不计算需要口径的指标 |
| 配音/字幕 | 无（V0.1 无配音能力，不虚构） |
| 色板 | 中性（蓝/灰系），**不使用 A 股红涨绿跌**，避免被误读为涨跌 |
| 页脚 | `用户导入 · <文件名> · <导入时间> · 单位：<unit 或「未声明」>` + 「不构成投资建议」 |
| 当前状态 | **未实现**，需新增通用折线渲染器 |

---

## 3. 数据类 B：横向对比 `cross_section`

### 3.1 最小字段

`label` / `value` / `group` / `value2` 同样是**目标字段名**，实际列名由 §1.7 映射指定。

| 列 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `label` | ✅ | 文本 | 对比对象名称；唯一、非空、≤ 24 字符（超长记 `W_LABEL_TOO_LONG`） |
| `value` | ✅ | 数值 | 对比数值；允许负值 |
| `group` | ⬜ | 文本 | 分组，用于配色 |
| `value2` | ⬜ | 数值 | 第二数值（如「上期」），用于并列条形 |

约束：

- 2 ~ 60 行。>60 → `E_TOO_MANY_ROWS`（横向条形超过 60 项无法阅读；Top-N 截取属后续版本，不在本契约内）。
- `label` 重复 → `E_DUP_LABEL`（不自动合并：合并口径应由用户决定，不该由工具猜）。
- `value2` 若提供，必须整列有值（见 1.5）。

### 3.2 归一化结构

```json
{
  "class": "cross_section",
  "meta": {
    "title": "各渠道单部获客成本",
    "unit": "元",
    "asOf": "2026-06-30",
    "source": "user-import",
    "fileName": "cac.csv",
    "importedAt": "2026-11-15T12:00:00Z",
    "rowCount": 8
  },
  "rows": [
    { "label": "渠道A", "value": 132.5, "value2": 118.0, "group": "线上" }
  ]
}
```

### 3.3 预期视频

| 项 | 规定 |
|---|---|
| 时长 | 15 ~ 25 s |
| 主视觉 | 横向条形逐条生长，按 `value` 降序（可由表单关闭排序） |
| 标注 | 每条右侧标数值 + 占比；占比口径固定为「该行 ÷ 合计」，画面必须写明该式 |
| 负值 | 条形从零轴向左延伸；零轴显式画出 |
| `value2` | 并列第二根条形，图例标「当前 / 对照」 |
| 排序提示 | 若有排序，页脚写「按 value 降序」；无排序写「按文件顺序」 |
| 派生指标 | 只允许「占比」这一条纯算术事实；增长率须提供 `value2` 且画面写明 `(当前−对照)/对照` |
| 配音/字幕 | 无 |
| 色板 | 中性 + 分组色；正值/负值以方向与明度区分，不用红绿 |
| 页脚 | `用户导入 · <文件名> · 时点：<asOf 或「未声明」>` + 「不构成投资建议」 |
| 当前状态 | **未实现**，需新增通用条形渲染器 |

---

## 4. 数据类 C：股票日线 `stock_ohlc`（扩展契约）

这是三类中**唯一**会进入现有 MACD 回测与 V1.2.3 渲染器的类别。它的契约最严，因为回测内核有一批不可让步的假设。

### 4.1 最小字段（行情 CSV）

| 列 | 必填 | 类型 | 约束 |
|---|---|---|---|
| `date` | ✅ | `YYYY-MM-DD` | 同日唯一 |
| `open` | ✅ | 数值 | > 0 |
| `high` | ✅ | 数值 | ≥ max(open, close, low) |
| `low` | ✅ | 数值 | ≤ min(open, close, high)，> 0 |
| `close` | ✅ | 数值 | > 0 |
| `volume` | ⬜ | 整数 | ≥ 0；缺列不影响封板判定（见 6.3） |
| `amount` | ⬜ | 数值 | ≥ 0；仅记录，不参与计算 |

### 4.2 必填元数据（表单）

| 字段 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `symbol` | ✅ | 6 位代码 | **必填**，否则 `E_SYMBOL_REQUIRED`；用于主板校验与涨跌停比例 |
| `name` | ⬜ | 文本 | 画面显示名；缺省用代码 |
| `adjust` | ✅ | `none` / `qfq` / `hfq` | 价格是否已复权；决定分红规则（见 5.2） |

> `symbol` 为什么必须填：内核按 10% 计算涨跌停并做「一字板无法成交」判定（`limitPrices`、`sealedSide`）。若用户数据来自创业板（20%），用 10% 去判定会把普通交易日误判成封板，或漏判真封板。**不知道板块就无法保证结果可信**，因此不接受「未声明代码」的股票数据。

### 4.3 分红 CSV（可选文件，独立于行情文件）

| 列 | 必填 | 说明 |
|---|---|---|
| `ex_date` | ✅ | 除权除息日 |
| `record_date` | ✅ | 股权登记日 |
| `pay_date` | ✅ | 派息日 |
| `cash_per_share` | ✅ | 每股现金红利（税前），≥ 0 |
| `share_ratio` | ⬜ | 每股送转比例（如 10 送 3 → 0.3）；缺省 0 |
| `plan` | ⬜ | 方案原文，用于拒绝不支持的方案类型 |

约束（全部来自现有代码，不是设计偏好）：

- `record_date`、`pay_date` **不可缺省、不可推导**。缺 → `E_DIV_MISSING_DATE`。
  `stock_core.cjs` 明确拒绝「按除息日默认到账」：`E_DIV_NO_RECORD_DATE` / `E_DIV_NO_PAY_DATE`。分红必须三段式（登记日确认权益 → 除息日计应收 → 派息日到账），缺任一日都无法正确入账。
- `pay_date >= record_date`，否则 `E_DIV_PAY_BEFORE_RECORD`。
- 三个日期必须都出现在行情 CSV 的日期集合内，否则 `E_DIV_DATE_NOT_TRADING`。
- `plan` 含「配股 / 缩股 / 换股 / 分拆」→ `E_UNSUPPORTED_ACTION`（内核仅支持现金分红与送转）。
- `cash_per_share` 与 `share_ratio` 不可同时为 0 → `E_DIV_EMPTY_EVENT`。

### 4.4 映射到现有八段结构

**只有本类需要八段结构**，且由转换器自动合成，用户不接触：

| 内部字段 | 来源 |
|---|---|
| `meta.symbol / name / board` | 表单 `symbol` / `name`；`board` 由代码前缀推导（主板） |
| `meta.adjust` | 表单 `adjust` |
| `meta.sources` | `USER_IMPORT · <文件名>`（逐项标注 daily / corporateActions / calendar） |
| `meta.simulated` | `false` |
| `meta.disclaimer` | 固定「用户导入数据，不构成投资建议」 |
| `bars` | 行情 CSV 逐行 |
| `calendar` | 行情 CSV 的日期集合（升序去重） |
| `suspensions` | **恒为空数组**（CSV 无法表达停牌，见 6.3） |
| `actions` | 分红 CSV：`date`←`ex_date`、`recordDate`←`record_date`、`payDate`←`pay_date`、`cashPerShare`←`cash_per_share`、`shareRatio`←`share_ratio`、`plan`←`plan` |
| `actionsOutOfRange` | 区间外分红，仅登记不参与计算 |
| `exChecks` | 空数组 |
| `checks` | `{ imported: true, simulated: false, rowCount, calendarGaps: [...] }` |

同时生成 `01_data/dividend_calendar.json`（`events[]` 与 `actions` 同源；`meta.simulated=false`）。注意 `backtest_stock_macd.cjs` 会逐条比对 `payCal.events` 与 `actions` 的 `recordDate` 与 `cashPerShare`，二者必须由同一份输入生成，不得分别维护。

### 4.5 预期视频

**复用 V1.2.3 模板**（以 V1.2.2 为基准，只改短样本时间轴与浮板定位），不新增版式：

| 项 | 值 |
|---|---|
| 规格 | 1920×1080 @ 30fps，intro 84 + main 1320 + outro 180 = 1584 帧 = 52.8 s |
| 版式 | 主图资产曲线（策略 vs 持有）+ 副图 MACD(12,26,9) + 当日快照面板 + 页脚 |
| 数字来源 | 本次回测的 `summary.json` 实算值，不硬编码 |
| 来源标注 | 由 `config.copy` 逐条替换（`header_sub`、`footer_left`、`intro_disclaimer`、`outro_risk`、`encoder.title`），**无需改渲染器代码**。已逐行核实：渲染器绘制的文字全部取自配置，代码中的中文字面量只出现在 `SystemExit` 报错与两个从未被读取的字段（`headline` / `reason`）里，不进入画面 |
| 画面必须显示 | 复权口径、是否含现金分红、日历缺口数、费率生效区间 |
| 最小数据量 | **> 33 个交易日**，否则 `E_NO_DATA`（MACD 预热 `readyFrom = 26−1 + 9−1 = 33`） |
| 当前状态 | **已实现**（V0.1 即为此链路），V0.2 只需新增 CSV → 八段结构的转换与来源标注 |

---

## 5. 专项规则

以下每节统一按「数据不足时能做什么 / 必须拒绝什么 / 还需验证什么」写。

### 5.1 分红

| 情形 | 能做 | 必须拒绝 | 画面标注 |
|---|---|---|---|
| `adjust=none`，提供分红 CSV | 完整三段式入账（权益/应收/到账），计红利税 | 缺 `record_date`/`pay_date`；日期不在行情日历内 | 「含现金分红 N 次」+「含佣金、印花税、过户费与红利税」；各项金额见片尾费用明细 |
| `adjust=none`，**不提供**分红 CSV | 可跑，但除权跳空按普通下跌处理，收益少计分红 | 不拒绝，记 `W_NO_DIVIDENDS` | 副标题显示「未提供分红表（除权跳空按价格下跌处理，结果不含现金分红）」+「含佣金、印花税、过户费（无红利税）」；片尾总述不写「已扣除红利税」 |
| `adjust=qfq/hfq`（无论是否提供分红 CSV） | — | **拒绝** `E_ADJUST_UNVERIFIED`（V0.2 起，见 §7.2）：复权是合成价，回测把它当真实成交价算金额与费用，收益不对应真实账户 | — |
| `adjust=qfq/hfq` 且提供分红 CSV | — | **拒绝** `E_DIV_CONFLICT`：复权价已含分红，再入账即重复计算（当前被上一条先拦，保留以防将来放开复权口径） | — |
| `adjust=qfq/hfq`，不提供分红 | **不可跑**：V0.2 起一律拒绝（见上一行与 §7.2 G-6） | `E_ADJUST_UNVERIFIED` | —（不产出视频） |

**待验证**

| 规则 | 验证方法 | 判定标准 |
|---|---|---|
| 未提供分红时的偏差幅度 | 用 `demo_macd_simulated` 复制一份，清空 `actions` 后重跑 | 输出终值差额与回撤差额，写入报告；只报告数值，不改结论 |
| 除权日前后是否出现「伪信号」 | 对比含分红与不含分红两版的 `signals.csv`，看金叉/死叉日期是否新增 | 若差异显著，需在画面提示「未计分红可能影响信号」 |

> 「方案含配股/缩股即拒绝」不属于待验证——`assertSupportedActions` 已用正则实现，见 §6.3。

### 5.2 复权

| 口径 | 语义 | 允许 | 禁止 |
|---|---|---|---|
| `none` | 原始成交价（未复权） | 可配分红 CSV；无分红则标注 | — |
| `qfq` | 前复权 | V0.2 一律拒绝（`E_ADJUST_UNVERIFIED`，见 §7.2 G-6） | 配分红 CSV（重复计算）；当前先被上一条拒绝 |
| `hfq` | 后复权 | V0.2 一律拒绝（`E_ADJUST_UNVERIFIED`，见 §7.2 G-6） | 配分红 CSV（重复计算）；当前先被上一条拒绝 |

必须写进画面的两条风险提示：

1. **前复权序列会随每次新的除权而整体重算**，同一只股票在不同时间点导出的 qfq 数据，历史值不同，两段拼接会产生伪跳变。
2. 复权价可能为负（老数据长期前复权），价格 `<= 0` → `E_PRICE_NONPOSITIVE`。

**原待验证项已关闭**：`qfq` 数据在除权日附近的涨跌停判定是否被 `exRefPrice` 二次调整，已用同一行情的 `none + 分红` 与 `qfq + 无分红` 对拍证明无二次调整（涨跌停换算最大偏差 0.0099 元、超差 0 天），见 §7.1 G-1 与 §11。**但该结论只覆盖封板判定，不足以放开 qfq/hfq**：成交价、整手仓位与费用口径仍未证明，故 V0.2 一律拒绝（§7.2 G-6）。上面两条风险提示在将来放开复权口径时仍然适用。

### 5.3 交易日历与缺口

**核心限制：CSV 无法表达停牌。**

V0.1 的停牌是「日历里有该日、但 bars 里没有该日」。用户 CSV 只有一份日期列，缺的那天既可能是停牌、也可能是休市、也可能是漏行，**三者无法从数据本身区分**。

因此：

| 项 | 决定 |
|---|---|
| 日历来源 | 行情 CSV 的日期集合 |
| `suspensions` | 恒为 `[]` |
| 「停牌顺延」语义 | **不可用**（不会有 `SELL_DEFERRED` 等事件） |
| 缺口检测 | 相邻两行之间缺失的工作日（周一至周五）计入 `calendarGaps` |
| 缺口处理 | **一律不拒绝**，只记录并标注。因为无法区分长假与漏行 |
| 升级阈值 | 单处缺失 > 10 个工作日 → `W_CALENDAR_GAP_LARGE`，校验报告中提示核对 |
| 画面标注 | 「区间含 N 处缺失工作日（最长 M 天），按连续交易日处理」 |

**为什么必须标注**：MACD 按「bar 序号」推进，不是按日历天数。漏掉 10 天会让 EMA 的等效回看窗口从 26 天变成 36 天，指标数值偏移，但**不会报错**。这是「静默错误」，只能靠画面声明让用户知道结果口径。

**待验证**

| 规则 | 方法 | 判定 |
|---|---|---|
| 缺口对 MACD 的实际影响 | 取 `demo_macd_simulated`，人为删除 5/10/20 个连续交易日各生成一份 | 记录信号数、终值、回撤变化幅度，写入报告作为「已知偏差」基线 |
| 缺口阈值 10 天是否合理 | 同上，观察 1~10 天缺口的偏差是否可忽略 | 若 5 天缺口已显著改变信号，则把阈值下调并在画面强调 |

### 5.4 手续费

| 项 | 规定 |
|---|---|
| 适用范围 | **仅 C 类**。A/B 类无交易、无费用、无本金概念 |
| 费率 | 固定沿用 `config.stock_macd.json`：佣金 0.03%（每笔最低 5 元）、印花税卖出 1‰（2023-08-28 起 0.5‰）、过户费双向 0.02‰（2022-04-29 起 0.01‰）、红利税按持股期限 20%/10%/0% |
| 是否可改 | **V0.2 不开放**。开放费率属于参数配置，归 V0.3 |
| 本金/手数 | 固定 100,000 元 / 100 股整数倍；不开放 |
| 起点下限 | 数据首个交易日 **< 2015-08-01 → 拒绝** `E_DATE_BEFORE_COST_RULES` |

> 起点下限不是产品限制，是代码事实：`transferFee` 分段规则最早一条 `effectiveFrom = 2015-08-01`，`tradeFee` 在找不到适用规则时直接抛 `E_COST_RULE_MISSING`，不会静默按 0 处理。若用户数据跨越更早年份，必须扩展费率表——那是独立工作量，不在 V0.2。

**待验证**：用户区间的**结束日**是否需要在费率最后一段的开放区间内（当前是 `effectiveTo: null`，覆盖未来，因此无需限制结束日）。这一点代码已可证，不需实测。

### 5.5 来源标注与免责

三档，互斥，不得混用：

| 档 | 触发 | 画面文案 |
|---|---|---|
| `SIMULATED` | 随包演示数据 | 「数据：SIMULATED 模拟演示行情（非真实历史行情）· 由 tools/gen_demo_data.cjs 确定性生成」 |
| `USER_IMPORT` | 用户导入 | 「数据：用户导入 · <文件名> · <导入时间> · 用户声明：<adjust/分红说明>」 |
| — | 任何情况 | 「仅用于演示软件流程 · 不构成投资建议」 |

硬规则：

- **不得**因为用户导入就写「真实行情」「实测数据」「实盘」。工具无法验证数据真伪，只能转述用户声明。
- **不得**删除免责句。
- `USER_IMPORT` 档必须同时显示：文件名、导入时间、复权口径、是否含分红、日历缺口数。

---

## 6. 错误码与警告码总表

### 6.1 拒绝（阻断，不产出视频）

| 码 | 触发 | 报错必含 |
|---|---|---|
| `E_ENCODING` | 非 UTF-8 | 检测到的编码猜测 + 转存建议 |
| `E_DELIMITER` | 非逗号分隔 | 检测到的分隔符 |
| `E_HEADER_MISSING` | 无表头 | — |
| `E_MISSING_COLUMN` | 缺必填列 | 缺失列名 + 该类要求的完整列清单 |
| `E_FILE_TOO_LARGE` | > 2 MiB | 实际大小 |
| `E_ROW_COUNT` | 行数越界 | 实际行数 + 允许区间 |
| `E_COLUMN_COUNT` | 列数 > 20 | 实际列数 |
| `E_ROW_FIELD_COUNT` | 某行列数与表头不符 | 行号 + 期望/实际 |
| `E_DATE_FORMAT` | 日期格式非法 | 行号 + 原始文本 |
| `E_DATE_UNORDERED` | 非整体降序的无序 | 首个乱序行号 |
| `E_DUP_DATE` | 同序列重复日期 | 重复日期 + 两个行号 |
| `E_BAD_NUMBER` | 数值格式非法 | 行号 + 列名 + 原始文本 |
| `E_THOUSANDS_SEPARATOR` | 引号内严格千分位数字（见 §1.2） | 行号 + 列名 + 原文 + 「删除逗号后重传」 |
| `E_QUOTE_UNCLOSED` | 引号未闭合 | 起始行号 + 建议检查 Excel 另存 |
| `E_ROW_EMPTY_FIELD` | 必填列为空 | 行号 + 列名 |
| `E_PARTIAL_COLUMN` | 可选列部分为空 | 列名 + 空值行号列表 |
| `E_MAPPING_FIELD` | 映射目标字段非法 | 非法字段 + 允许清单 |
| `E_MAPPING_COLUMN` | 映射指向的源列不存在，或表头缺少必填列且没有可识别的同义列 | 目标字段 + 实际表头；界面另区分「文件里没有这类列」与「有列但尚未映射」 |
| `E_MAPPING_DUP` | 两个目标字段映射到同一源列 | 列名 |
| `E_PRICE_NONPOSITIVE` | 价格 ≤ 0 | 行号 + 列名 + 值 |
| `E_OHLC_INCONSISTENT` | high/low 与 open/close 矛盾 | 行号 + 四个价格 |
| `E_DUP_LABEL` | B 类 label 重复 | 重复 label |
| `E_TOO_MANY_ROWS` | B 类 > 60 行 | 实际行数 |
| `E_TOO_MANY_SERIES` | A 类 > 6 条序列 | 实际条数 |
| `E_SERIES_TOO_FEW` | 某序列有效点 < 2 | 序列名 + 点数 |
| `E_SYMBOL_REQUIRED` | C 类未填代码 | — |
| `E_UNSUPPORTED_BOARD` | 非沪深主板 / ST / 退市 | 代码 + 判定依据 |
| `E_DATE_BEFORE_COST_RULES` | 起点 < 2015-08-01 | 实际起点 |
| `E_ADJUST_INVALID` | `adjust` 不是 none/qfq/hfq | 实际值 |
| `E_ADJUST_UNVERIFIED` | `adjust=qfq/hfq`（V0.2 只接受未复权，见 §7.2） | 实际值 + 拒绝原因（合成价不参与金额/费用口径） |
| `E_DIV_CONFLICT` | 已复权 + 提供分红 | 复权口径 |
| `E_DIV_MISSING_DATE` | 分红缺 record/pay date | 分红日期 |
| `E_DIV_DATE_NOT_TRADING` | 分红日期不在行情日历 | 日期 + 缺失原因 |
| `E_DIV_PAY_BEFORE_RECORD` | 派息日早于登记日 | 两个日期 |
| `E_DIV_EMPTY_EVENT` | 现金与送转同时为 0 | 分红日期 |
| `E_UNSUPPORTED_ACTION` | 配股/缩股/换股/分拆 | 方案原文 |
| `E_NO_DATA` | C 类 ≤ 33 个交易日 | 实际交易日数 |
| `E_CLASS_NOT_IMPLEMENTED` | 请求的类别尚未实现（当前为 `stock_ohlc`） | 类别 + 已支持清单（`timeseries` / `cross_section`） |
| `E_SOURCE_MISSING` | 任务目录缺少原始 CSV 留档（§1.8） | 提示新建任务 |
| `E_TRACE_MISMATCH` | `source.csv` 的 SHA-256 与创建时记录不一致（留档被改动） | 拒绝交付 |
| `E_TRACE_FAILED` | 按行号回读 `source.csv` 时对不上（§1.8） | 前 3 处不一致 + 行号 |
| `E_TRACE_MISSING` | 查询溯源清单但任务尚未生成视频 | 提示先出片 |

### 6.2 警告（通过，但必须显示在页面与视频上）

| 码 | 触发 | 画面必须显示 |
|---|---|---|
| `W_DESC_ORDER` | 整体降序，已自动反转 | 「原始文件为降序，已反转」 |
| `W_NULL_VALUE` | A 类存在空值 | 「N 处断点，未插值」 |
| `W_RAGGED_SERIES` | A 类各序列日期不一致 | 「各序列区间不一致」 |
| `W_CALENDAR_GAP` | C 类存在缺失工作日 | 「N 处缺失工作日，最长 M 天」 |
| `W_CALENDAR_GAP_LARGE` | 单处缺失 > 10 个工作日 | 同上 + 「请核对是否漏行」 |
| `W_NO_DIVIDENDS` | C 类未复权且未提供分红 | 「未计现金分红」 |
| `W_EXTRA_COLUMN` | 存在未声明列 | 「忽略 N 列」 |
| `W_BLANK_ROW` | 存在空行 | — |
| `W_LABEL_TOO_LONG` | B 类 label > 24 字符 | 截断显示 |

### 6.3 已由代码或实测证实、无需再议的规则

| 结论 | 依据 |
|---|---|
| 封板判定不依赖 `volume` | `stock_core.cjs: sealedSide()` 只用 open/high/low/close 与涨跌停价比较 |
| 印花税/过户费按成交当日费率计收 | `stock_cost.cjs: tradeFee()` 通过 `inEffect(date, rule)` 逐笔取费率 |
| MACD 最少需要 34 个交易日 | `stock_macd_core.cjs: readyFrom = (26−1)+(9−1) = 33`，要求 `tradable.length > 33` |
| 方案含配股/缩股/换股/分拆一律拒绝 | `support_guard.cjs: assertSupportedActions()` 对 `plan` 做正则匹配，不做降级 |
| 分红缺登记日/派息日一律拒绝，不允许「按除息日默认到账」 | `stock_core.cjs: buildTimeline()` 抛 `E_DIV_NO_RECORD_DATE` / `E_DIV_NO_PAY_DATE`；注释明确否定默认到账 |
| 分红三日期必须都在交易日历内 | 同上：`E_DIV_DATE_NOT_TRADING` |
| 用户 CSV 符合本契约时，转换后可跑通现有链路 | 见 §11 实测：样例 C 自检 21/21 通过 |

---

## 7. 待验证清单（汇总，须在 Step 1–3 用现有代码与样例逐条验证）

| # | 待验证项 | 方法 | 阻塞什么 |
|---|---|---|---|
| V-01 | ~~`qfq` 下除权参考价是否被二次调整，影响封板判定~~ | **已关闭（2026-11-16）**：同一行情分别以 `none+分红`、`qfq+无分红` 构造对拍，`limitUp/limitDown` 换算回真实水平最大偏差 0.0099 元（< 0.02 容差，超差 0 天）；除权日 `refClose` 与 qfq 前收一致，含一字板用例 | ~~仅股票通道门禁 G-1~~ |
| V-02 | 日历缺口对 MACD 信号的偏差幅度 | 删除 5/10/20 个连续交易日，记录信号数与终值变化 | 缺口阈值是否从 10 天下调 |
| V-03 | 未提供分红时除权跳空的误判幅度 | 清空 `actions` 重跑，比较终值与信号数 | `W_NO_DIVIDENDS` 是否足够，还是应升级为拒绝 |
| V-04 | 2 MiB 上限对目标数据集是否够用 | 用已验收模拟数据转 CSV 实测（约 49.8 B/行 → 2 MiB ≈ 42,000 行） | Step 1 的服务端 body 上限取值 |
| V-05 | ~~60 个交易日样本能否稳定出片~~ | **已关闭**：样例 C 给到 260 个交易日，实测 12 次金叉 / 11 次死叉 / 23 笔成交 | 无需加长 |
| V-06 | ~~用户 CSV 缺 `amount` 时下游是否有字段依赖~~ | **已关闭（2026-11-16）**：全仓检索确认回测/渲染/验收链路不读 CSV 的 `amount` 列；`sealedSide()` 只用 open/high/low/close | ~~C 类是否可把 `amount` 降为可省略~~ → 已降为可省略 |
| V-07 | B 类 60 行上限是否满足真实用途 | 收集真实对比表规模 | 是否放开上限或引入 Top-N |
| **V-08** | ~~V1.2.2 独立验收（40 项）按 2633 交易日演示样例标定，对短样本用户导入是否适用~~ | **已关闭（2026-11-16，V1.2.3）**：260 日样例实测 34/40，6 项不达标全部归因——①首个 MACD 点 30px 阈值（= 演示样例像素密度换算，260 日时 25 个预热日 = 161px，任何 N<1838 都不可能满足）；②浮板固定 y1=182 压住贴 10 万起点的曲线（132 处）；③④⑤⑥`build_smooth_timeline` 把 n_days 个日密度当 n_days 个区间成本，末日后多出幻影区间被钳成零位移帧（4 帧，34 日边界 46 帧）。修复见 §7.1 G-5 | ~~G-5~~ → 已由 V1.2.3 关闭 |

> V-05 已在样例设计时规避：`stock_ohlc.csv` 给到 **260 个交易日**（> 33），足以产生多次金叉/死叉，不需要靠「刚好够预热」的数据赌出片。已实测确认（见 §11）。

### 7.1 股票通道门禁（C 类专用，**不阻塞 A/B**）

C 类在下列门禁全部通过前不开放。**2026-11-16 更新：G-1 ~ G-6 已全部通过验证/实现**（验证记录见 §11）；出片交付由 V1.2.3 渲染与验收链路承担——独立验收未通过的任务一律失败落盘（`E_VERIFY_FAILED`），不产出「看起来成功」的视频。

| 门禁 | 内容 | 关联 | 现状 |
|---|---|---|---|
| **G-1** | `qfq` 数据在除权日附近，涨跌停价与封板判定不被 `exRefPrice` 二次调整 | V-01 | ✅ 已验证（260 交易日 / 2 分红 / 涨跌停换算最大偏差 0.0099 元 < 0.02，超差 0 天；除权日 `refClose` 与 qfq 前收逐日一致） |
| G-2 | CSV → 八段结构转换器（含「空分红日历」分支，避免 `E_NO_PAY_CALENDAR`） | §4.4 | ✅ 已实现（`web/src/import/validate.js: buildStockOhlc` + `web/src/adapters/stockOhlc.cjs`） |
| G-3 | 起点早于 2015-08-01 的费率缺口处理 | §5.4 | ✅ 规则已定（拒绝，`E_DATE_BEFORE_COST_RULES`） |
| G-4 | `amount` 缺省时下游链路无字段依赖 | V-06 | ✅ 已验证（全仓检索：回测/summary/daily/macd/signals 生成链路不读 CSV 的 `amount` 列；`sealedSide()` 只用 OHLC） |
| **G-5** | V1.2.2 独立验收（40 项）对用户导入样本的适用性 | §7 V-08 | ✅ **已解决（V1.2.3）**：V1.2.3 显式选 `cost_domain="intervals"`（180 组边界矩阵全达标），V1.2.2 默认封版 `cost_domain="days"`（SHA 逐位冻结、成片与原公开版本逐字节一致）；首个 MACD 点阈值改为与长度无关的两条不变量；浮板高度/定位改读渲染报告并按本次资产轨迹自适应。260 日样例独立验收 **41/41 通过**并交付 MP4；V0.1 演示仍走 V1.2.2 且 40/40 保持通过 |
| **G-6** | 复权（qfq/hfq）行情能否用于准确的成交价/仓位/收益计算 | §7.2 | ✅ **已验证并落为门禁**：不能。V0.2 只接受 `adjust=none`，qfq/hfq → `E_ADJUST_UNVERIFIED`（证据见 §7.2） |

#### 7.2 复权口径门禁（G-6，2026-11-16）

回测把 CSV 价格**直接当真实成交价**：`amount = shares × price`，佣金/印花税/过户费/红利税全部按该金额计，买入按 100 股整手对 `price` 取整（`stock_core.cjs: affordableShares` / `tradeFee`）。因此只要价格不是真实成交价，金额与收益率就不是真实账户的结果。qfq/hfq 是**合成价**，且复权因子随时间变化，实测影响：

| 口径 | 信号 / 日期 | MACD 终值 | 持有终值 | 最大回撤 |
|---|---|---|---|---|
| `none` + 分红表（正口径） | 23 笔 | ¥102,918.09 | ¥117,347.32 | 12.70% |
| 真实 qfq 因子、无分红表 | 23 笔，**其中 5 笔日期不同**（如金叉 2024-07-10 → 2024-07-03） | ¥105,472.69（+2,554.60） | ¥118,120.47（+773.15） | 10.82% |
| 整体 ×0.96 等比缩放 | 23 笔，日期相同 | ¥102,930.88（+12.79） | ¥117,319.56（−27.76） | 12.70% |

结论：即使 G-1 证明涨跌停参考价在 qfq 下无二次调整，也只覆盖「封板判定」这一个点；**成交价、仓位（整手取整）、费用（最低 5 元/笔）与收益金额在 qfq/hfq 下均无法证明与真实账户一致**，且复权价已含分红、不能再叠加分红表。因此 V0.2 股票通道只接受 `adjust=none`（未复权行情 + 分红表），qfq/hfq 明确拒绝（`E_ADJUST_UNVERIFIED`）；放开复权口径需要先单独验收「成交价口径」一致性。

> 为什么单列而不再混在 A/B 的待验证清单里：两类数据的风险结构不同。A/B 画错一眼能看出来（线画歪、条长短）；C 类算错则看不出来（手续费少算、封板误判、分红重复计算），只能靠前置证明。**因此 A/B 可以先上，C 必须等门禁。**

---

## 8. 与现有代码的映射（避免实现时二次猜测）

| 现有文件 | 与契约的关系 |
|---|---|
| `engine_next/backtest_stock_macd.cjs` | 只读 `01_data/stock_daily.json` + `01_data/dividend_calendar.json`；缺任一 → `E_NO_STOCK_DATA` / `E_NO_PAY_CALENDAR` |
| `engine_next/lib/stock_core.cjs` | `buildTimeline` 要求分红三日期齐全且都在 calendar 内；bars 缺失日 = 停牌 |
| `engine_next/lib/support_guard.cjs` | 代码段白名单、ST/退市拒绝、公司行为白名单（CASH_DIV/SHARE_DIV） |
| `engine_next/lib/stock_cost.cjs` | 费率分段与「无适用规则即抛错」 |
| `engine_next/lib/stock_macd_core.cjs` | `readyFrom = 33`，最少 34 个交易日 |
| `engine_next/config.stock_macd_video_v122.json` | 所有用户可见文案在 `copy` 段；来源标注只需替换此处，**不改渲染器**。V0.2 起 `chart.panel.y1` 只约束 V1.2.2 演示路径；用户导入路径由适配器解掉该键，交 V1.2.3 自适应 |
| `engine_next/render_stock_macd_v123.py` | 用户 CSV 专用渲染器（V1.2.3）：在 V1.2.2 基础上只改「短样本时间轴成本域（`video_events.py` 的 `cost_domain="intervals"` 显式开关）+ 浮板按本次资产轨迹自适应定位 + 报告真实浮板矩形」；V0.1 演示继续用 `render_stock_macd_v122.py`（不传开关 → 封版 `cost_domain="days"`），两者共享回测产物与文案 token 表 |
| `engine_next/tests/accept_macd_video_v123.py` | 用户 CSV 独立验收（41 项）：与 V1.2.2 逐条同源，仅三处按本次数据推导的适配（首个 MACD 点不变量 / 浮板矩形读报告 / anchor≠forced-top）；演示验收仍用 `accept_macd_video_v122.py`（40 项） |
| `engine_next/tests/test_timeline_bounds.py` | 时间轴回归：① V1.2.3 口径 6 种事件分布 × 10 种交易日数 × 3 种帧数 = 180 组，断言首末覆盖/单调/零位移=0/最长死停=0；② 封版口径（默认 `cost_domain="days"`）3 组参数的 POS 序列 SHA 逐位冻结，防止修短样本时把 V0.1 已发布画面改掉 |
| `web/server.js` | 传输上限：`MAX_BODY_BYTES = 5 MiB`（含 JSON 转义余量），**文件级**上限仍是本契约的 2 MiB，由校验器判定；`/api/health` 的能力自述由 `STRATEGY_MODES` 单一真相源派生（含 `stock_ohlc`），与前端可执行能力一致（AC-20） |
| `web/src/validation.js` | 已注册 `macd` / `timeseries` / `cross_section` / `stock_ohlc`（V0.2 起）；C 类额外放行 `symbol` / `name` / `adjust` / `dividendCsvText` |
| `web/src/csv.js` | RFC 4180 子集解析：引号、`""` 转义、BOM、CRLF/LF/CR、分隔符检测；返回「原始文本 + 是否带引号 + 行号」；另提供 `countTextLines`（末尾换行不虚增）与 `countDataRecords`（不含表头/跳过空行）两个行数口径 |
| `web/src/import/mapping.js` | §1.7 映射解析、别名兜底、冲突检测；错误文案使用中文标签（日期/数值/名称…），不把内部键名抛给用户 |
| `web/src/import/validate.js` | 通用规则 + A/B/C 三类校验，输出 §2.2 / §3.2 / §4.4 结构；C 类 `buildStockOhlc` 做 OHLC 合法性与分红三日期校验 |
| `web/src/adapters/genericChart.cjs` | A/B 适配器：归一化模型 → 通用渲染器 → MP4；写 `traceability.json`，按行号回读 `source.csv`（§1.8） |
| `engine_next/render_generic_chart.py` | 通用图表渲染器（折线 / 条形），仅用 `deps/` 中的 Pillow + imageio-ffmpeg；页脚打源文件 SHA-256 指纹 |
| `tools/check_determinism.cjs` | 两次独立出片 SHA-256 对拍（`npm run check:determinism`），对应 AC-17 |
| `web/src/adapters/stockOhlc.cjs` | C 类适配器（V0.2）：`import.json` → 八段结构 + 分红日历 → 复用封版回测 + **V1.2.3 渲染/验收**；核对 `source.csv` / `dividend.csv` SHA；按行号回读 K 线与分红并写 `traceability.json`（§1.8）；解掉演示配置的浮板固定 y1；写 `conversion_manifest.json` 与 `accept_failures.json`；视频文案走 USER_IMPORT 档（页脚含 `sourceNote`） |
| `tools/check_samples.cjs` | 逐份样例的预期结果复核（`npm run check:samples`），对应 AC-11；含 D 段股票溯源（无分红 / 含分红 / 篡改一行即拒绝） |
| `tools/check_api_contract.cjs` | `/api/health` 能力口径断言（`npm run check:api`），对应 AC-20：`executableStrategies` / `execution.strategies` / `strategyModes` 同源且包含 `stock_ohlc`，未开放的框架占位不在清单内 |
| `web/src/taskManager.js` | 创建任务时写 `source.csv` + `status.source`；`deleteTask` 删除任务目录（§1.9） |
| `web/server.js` | `DELETE /api/tasks/:id`、`GET /api/tasks/:id/traceability`、`GET /api/tasks/:id/source` |

---

## 9. 验收项（可直接回填 Issue #1）

| 编号 | 验收项 | 对应样例 |
|---|---|---|
| **AC-01** | 三类数据的命名、边界、归一化结构固定；A/B 类**不得**产出股票八段结构 | 全部 |
| **AC-02** | 通用规则（编码/分隔符/表头/数值/日期/排序/空值/上限）逐条可执行，错误码与本文一致 | 全部 |
| **AC-03** | `timeseries` 最小字段为 `date,value`，`series` 可选；支持 1~6 条序列与断点 | `timeseries_single.csv`、`timeseries_multi.csv` |
| **AC-04** | `cross_section` 最小字段为 `label,value`；`label` 唯一；2~60 行 | `cross_section.csv` |
| **AC-05** | `stock_ohlc` 最小字段为 `date,open,high,low,close`；`symbol`/`adjust` 为必填元数据 | `stock_ohlc.csv` |
| **AC-06** | 分红契约：未复权+分红需三日期齐全；已复权+分红必须拒绝 | `stock_dividends.csv`；冲突用例见 §5.1 |
| **AC-07** | 日历缺口只警告不拒绝；停牌不可表达；画面必须标注缺口 | `warn_stock_calendar_gap.csv` |
| **AC-08** | 手续费仅适用 C 类；费率固定；起点 < 2015-08-01 拒绝 | `stock_ohlc.csv`（起点 2024 合规） |
| **AC-09** | 来源标注三档互斥；禁止「真实行情」字样；`SIMULATED` 与 `USER_IMPORT` 可切换 | `stock_ohlc.csv`（USER_IMPORT） |
| **AC-10** | 预期视频规格按类别固定（A：20–35 s 折线；B：15–25 s 条形；C：52.8 s V1.2.3） | 全部 |
| **AC-11** | 每份样例的预期结果（通过/警告/拒绝 + 错误码 + 首错位置）可复现 | `docs/samples/README.md`；由 `npm run check:samples` 逐份断言 |
| **AC-12** | 待验证清单列明方法与判定标准，未验证项不得写成已成立 | §7 |
| **AC-13** | 字段映射只存在于参数中：换一份列名完全不同的 CSV，只需给映射即可出片，**不改源码** | `timeseries_single.csv` / `timeseries_multi.csv` / `cross_section.csv` + §11「换表头」实测 |
| **AC-14** | C 类不静默跑错：独立验收未通过的任务必须失败落盘（`E_VERIFY_FAILED` + 逐条失败明细），不产出「看起来成功」的视频；复权口径只放行 `adjust=none`（qfq/hfq → `E_ADJUST_UNVERIFIED`，§7.2） | `stock_ohlc.csv`（通过样例 41/41 可复现；qfq 样例被拒可复现） |
| **AC-15** | 原始 CSV 留档：任务目录下有 `source.csv`，其 SHA-256 与任务记录、归一化模型、溯源清单三处一致 | 任一 A/B 样例走完网页全流程后的 `status.source.sha256` |
| **AC-16** | 行号溯源：每个数据点都能定位到 `source.csv` 的物理行号，且按该行号回读的字段值与画面数字一致 | `traceability.json` 的 `trace[].sourceLine` / `verification` |
| **AC-17** | 确定性：同一 CSV 两次独立出片得到逐字节相同的 MP4 | `npm run check:determinism` |
| **AC-18** | 删除任务即删除原始 CSV 与视频（任务目录 + 运行目录），不残留 | `DELETE /api/tasks/<id>` 后目录检查 |
| **AC-19** | C 类同样可溯源：`traceability.json` 逐根 K 线（日期 + OHLC）与逐条分红（除息日 + 每股现金红利）定位到 `source.csv` / `dividend.csv` 行号；留档任一行被改动即 `E_TRACE_FAILED` | `stock_ohlc.csv`（260/260）、`stock_ohlc.csv + stock_dividends.csv`（262/262）；`npm run check:samples` D 段 |
| **AC-20** | `/api/health` 的能力自述与实际可执行策略一致：`executableStrategies` / `execution.strategies` / `strategyModes` 同源且包含 `stock_ohlc`，未开放的框架占位不在清单内 | `npm run check:api` |

---

## 10. 什么叫契约破坏性变更

以下任一项发生，必须升版本号并在变更记录中说明，不得静默调整：

- 必填列增删，或列名改名；
- 错误码语义变化（同一场景从警告升级为拒绝，或反之）；
- 归一化结构的字段增删；
- 预期视频的规格/时长/必要标注变化；
- 分红、复权、缺口、费用的判定规则变化。

以下不算破坏性变更：新增可选列、新增警告码、错误信息文案优化、渲染细节（配色/字号/动画曲线）。

---

## 11. 本轮边界（务必如实对待）

- 本文档与 `docs/samples/*.csv` 是契约与素材。**A / B 类已有实现并跑通出片**（`web/src/import/*` 校验、`engine_next/render_generic_chart.py` 渲染）。**C 类在 V0.2 开发分支已实装并交付出片**：校验/转换器（`buildStockOhlc`）、适配器（`stockOhlc.cjs`，走 V1.2.3 渲染/验收）、网页入口均已接入，260 日样例端到端通过独立验收并交付 MP4（见 §7.1 G-5 / §7.2 G-6）。
- `npm run check:samples` 是仓库自带的样例断言入口：三类样例的通过/警告/拒绝与代码一一对应（当前 **27/27**）。`npm run check:determinism` 做两次独立出片的 SHA-256 对拍（V1.2.3 改动后复测 PASS）。
- A / B 类的「预期视频」已由实现产出，时长/尺寸/标注可实测；但它们仍是**演示规格**，不代表任何真实业务的呈现标准。
- C 类端到端实测（2026-11-16，本仓库内）：样例 4/5 走「校验 → 八段结构 → 封版回测 → V1.2.3 渲染 → 独立验收」全链路，回测**自检 21/21 通过**，渲染产出 1584 帧 52.8 s MP4，视频文案经抽帧核对为 USER_IMPORT 档（页脚含文件名与 SHA 前 12 位、免责声明齐全、期末金额与 summary 逐位一致）；独立验收 **41/41 通过**，任务成功并交付视频。
- 复权口径边界：V0.2 只接受 `adjust=none`；qfq/hfq 在请求阶段即被拒绝（`E_ADJUST_UNVERIFIED`），不允许产出可能失真的收益视频（证据见 §7.2）。
- 用户导入的原始 CSV 与视频留在本机任务目录（`web/tasks/`，已被 `.gitignore` 排除），**不进入仓库**。

**实测记录（可复核）**

| 项 | 值 |
|---|---|
| 输入 | `docs/samples/stock_ohlc.csv`（260 条数据记录 + 表头 = 文本 261 行）+ `stock_dividends.csv`（2 事件） |
| 表单元数据 | `symbol=600000`、`adjust=none`、`name=样例标的A` |
| 命令 | `node engine_next/backtest_stock_macd.cjs --config <临时配置> --run spec_sample_c` |
| 结果 | 交易日 260（停牌 0）· 金叉 12 / 死叉 11 · 成交 23 笔 · 策略终值 102,918.09 · 持有 117,347.32 · 费用 1,261.91 · 红利税 490.00 · **自检 21/21** |
| 渲染（V1.2.3 实测） | 1584 帧 / 52.8 s / 1920×1080@30fps · 片尾 ¥117,347.32 vs ¥102,918.09 与 summary 一致 · 页脚 `数据：用户导入 · stock_ohlc.csv · SHA 0ff3d04350ab · 未复权` · 浮板 anchor=bottom（y1=331，曲线之上零遮挡） |
| 独立验收 | **PASS 41 / FAIL 0**（`accept_macd_video_v123.py`；平滑度 zero=0/still=0/cv=0.2458/accel=0.198）→ 任务成功并交付 MP4 |
| 时间轴边界 | `python engine_next/tests/test_timeline_bounds.py`：180 组（事件分布 × 交易日 34~5000 × 帧数 300/660/1320）全部首末覆盖、单调、零位移=0、最长死停=0 |
| V0.1 演示回归 | `render_stock_macd_v122.py` + `accept_macd_video_v122.py`：回测自检 21/21，验收 **40/40 PASS**（版本隔离后复测） |
| V0.1 逐字节兼容性 | 用公开提交 `32418a7` 的工作树、同一份演示数据独立渲染：基线 SHA `6c556f297adc379d3a7f2c511b8f99ffae27d82c225c5fb805bbf2919196ab1f`；隔离后当前实现 SHA 与其**完全相同**。作为反证，把 V1.2.3 的 `cost_domain="intervals"` 直接共享给 V1.2.2 时 SHA 为 `31cf7a5fc13cf36b4788da349ac94c39923dadc62ac6392e8ebc01a7a897f538`（解析层 403/1320 帧取整像素漂移、最大 0.59px）→ 确认变化来自共享时间轴函数，故采用显式口径隔离 |
