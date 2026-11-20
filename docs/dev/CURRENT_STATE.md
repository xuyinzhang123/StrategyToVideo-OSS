# 当前状态与接续指南（2026-11-17）

> 唯一权威来源：公开仓库 https://github.com/xuyinzhang123/StrategyToVideo-OSS
> 本文件在分支 `feat/datafeed-pytdx` 上。回家从这里接续，不需要工厂电脑传任何文件。

## 0. 一句话结论

已发布 V0.2（tag `v0.2.0`，main=`5884e0f`）；方向确认**专注股票策略可视化**，暂停其它视频形式。
本主线已完成八件事：① 双数据接口（`pytdx` + `eastmoney`）打通到校验门禁；② **东方财富在工厂电脑已取到真实 260 日数据并通过 validateImport**（pytdx 仍 `CONTROL_OK_DATA_EMPTY`）；③ 策略卡契约 + 独立策略引擎（`macd_cross` 复现封版锚点、`close_buy_open_sell` 的预热切分/金叉入场/9:25 跳空过滤已真正执行，27/27 自检）；④ **真实数据已走完整出片并通过 41/41 验收、两次独立出片 SHA 逐字节一致**（详见 §A3）；⑤ **主图 Y 轴自适应渲染档 V1.2.4 已作为默认出片版本接入**，解决"下半屏很空"，三条数据各 41/41、端到端两次 SHA 一致（详见 §A4）；⑥ **A 类多序列对比片已跑通**：黄金 vs 黄金股ETF 真实归一化双序列出 24s 对比片、两次 SHA 一致（详见 §A5）；⑦ **策略卡直出片垂直切片已跑通**：策略卡 → 自动取数 → 统一回测 → 通用策略视频，真实 600000 两次独立出片 SHA 一致（详见 §A6）；⑧ **策略卡通道已接进网页**：填代码+区间+模板即可出片，无需 CSV；网页路径实测 20/20 验收、815/815 溯源（详见 §A7）。
注意：策略链路已接网页，但**只有两个模板**；**通用策略片验收为 20 项（结果契约自洽 + 报告勾稽 + 画面推进）**，
不含 MACD 的 41 项像素级细验；**未做公开部署**（仍只监听 127.0.0.1）。这些是下一步，不得宣称已完成。

## 1. 分支与指针（以 GitHub 为准）

| 分支/标签 | commit | 用途 |
|---|---|---|
| `main` | `5884e0f` | 已发布基线，**不要改动、不要强推** |
| tag `v0.2.0` | `70f4918` | V0.2 正式发布点 |
| `feat/datafeed-pytdx` | 见本节末实际指针 | **当前主线**：pytdx + 东方财富双接口 + 策略卡契约/引擎（详见 STRATEGY_ENGINE_HANDOFF.md） |
| `feat/v0.3-phase0-storyboard` | `fb9d91d` | 竖版"数据解剖片"渲染器，**已按方向决定暂停**，成果保留不删 |

没有 PR（V0.2 的 PR #1 已合并关闭）。
> 历史说明：上面这句与 §4/§5/§9 中「本轮不合并 main、不开 PR、不发版」属于功能开发轮的旧边界；
> **已被本轮发布收口取代**，以文末 §A10 为准（本轮明确授权合并 main、发 v0.3.0）。

## 2. 本轮完成的事

### A2. 东方财富数据接口（2026-11-17 追加，主线）
- `datafeed/eastmoney_fetch.py`：纯标准库走东方财富公开 kline HTTP 接口，`fqt=0` 强制未复权，
  输出与 pytdx 完全同契约的 `stock_ohlc.csv + meta.json`；规范化/门禁复用 `pytdx_fetch.py`
  单一事实源；默认剔除当天未收盘 K 线（`meta.excludedUnclosedDate`），`--include-today` 显式放开。
- **工厂电脑实测接口可用**：HTTP 200，600000 日线 533 根（2024-09-02 ~ 2026-11-17），OHLC 自洽 0 异常；
  真实取 260 交易日（2025-10-22 ~ 2026-11-16，剔除未收盘日 2026-11-17），
  通过 `validateImport`（仅 `W_NO_DIVIDENDS`），qfq 仍 `E_ADJUST_UNVERIFIED`。
- 测试：`eastmoney_fetch.py --selftest` **20/20**；`verify_eastmoney_e2e.cjs` **8/8**（含真实产物门禁）。
- pytdx 仍是 `CONTROL_OK_DATA_EMPTY`，两个接口并存、互不替换；既有四链 `git diff 5884e0f` 为空。

### A3. 真实数据完整出片（2026-11-17 中午追加，里程碑）
- **用东方财富真实 600000 未复权日线（260 日）走完整链路，通过 V1.2.3 全部 41/41 验收**。
  这是"合成样例全绿"升级为"真实数据也成立"的实证，非合成、非造数。
- 工具：`tools/render_real_600000.cjs`（新增，复用封版 `web/src/adapters/stockOhlc.cjs` 的 `execute()`，
  不启网页、不重写任何转换/回测/渲染/验收逻辑；样板来自 `tools/check_determinism.cjs`）。
  命令：`node tools/render_real_600000.cjs --run real_600000_A`（第二次换 `_B` 做对拍）。
- 实测结果：
  - 输入 CSV sha256 `382c9f72cf5d…`，260 bars、分红 0；警告 `W_NO_DIVIDENDS` + `W_CALENDAR_GAP`
    （7 处假期缺口，CSV 无法区分停牌/休市/漏行，按连续交易日处理，如实标注）。
  - 回测（2025-10-22 ~ 2026-11-16）：MACD 终值 **108,717.48** vs 持有 **80,296.97**；
    金叉 6 / 死叉 6 / 11 笔；费用 580.52 / 红利税 0（无分红表）。
  - 视频：1920×1080@30fps、1584 帧、52.8s；`accept_macd_video_v123.py` **PASS 41 / FAIL 0**；
    溯源 260/260。
  - **两次独立出片（real_600000_A / _B）MP4 逐字节一致**，SHA-256
    `593fd21234e5916930a7a460ba45d5e2cc8515377a593990aa2f04be870ec54a`（系统 sha256sum 独立核验）。
- 产物全部按 `.gitignore` 忽略（`datafeed/out/`、`output/*/01_data/`、`output/*/02_backtest_macd/`、
  `output/*/04_video/`、`output/_work_*/`），真实行情数据不入库。

### A4. 主图 Y 轴自适应渲染档 V1.2.4（2026-11-17 下午追加，默认出片版本已切换）
- **问题**：用户反馈 V1.2.3 的"下半屏很空"——主图 Y 轴下限硬编码 0
  （`ya = v/AMAX`），资金只在窄区间波动时（如真实 600000 落在 7~11 万）曲线全挤在上半部，
  0~6 万大片空白。这是刻度策略问题，不是数据问题。
- **方案（受控副本，V1.2.3 脚本一字未改）**：新增
  `engine_next/render_stock_macd_v124.py` + `engine_next/tests/accept_macd_video_v124.py`。
  下限改为按本次两条资金序列 + 初始资金自适应：步长由数据跨度决定，`AMIN=floor(谷值-0.3步)`（≥0），
  `AMAX` 由峰值留白决定，刻度从 AMIN 起等距。浮板选位改为两级（152px→126px），事件行在
  空间不足时让位并在报告 `suppressed.panel_event_row` 如实计数；零遮挡判据不放宽。
- **接入**：`web/src/adapters/stockOhlc.cjs` 的 `SEALED_FILES.renderScript/acceptScript` 已切到 v124，
  STEP 文案 / 错误消息 / `videoVersion` 同步更新。V0.1 演示仍走 v122；v122/v123 脚本本身零改动。
- **实测（三条数据各 41/41）**：
  - 真实 600000：刻度 `[6万,7.5万,9万,10.5万,12万]`（旧为 0~12 万），曲线铺满主图、下方空白消失。
  - 含分红样例（web_fix_withdiv）：`[9万…13万]` 41/41；无分红横盘样例：`[9万…12万]` 41/41。
  - 端到端走适配器（`node tools/render_real_600000.cjs --run real_600000_v124_e2e`）**PASS 41/41**，
    **两次独立出片 MP4 逐字节一致**，SHA-256 `59a4ce3d2284a794e0dbc6716baecb454d823b8238cb2dedb832278331d5d7e4`，
    与手工 v124 渲染 SHA 相同（网页路径 ≡ 手工路径）。
- 旧片 `real_600000_A/_B` 是 v1.2.3 旧刻度（SHA `593fd212…`），保留作对照；新片看 `*_v124_e2e`。

### A5. A 类多序列对比片：黄金 vs 黄金股ETF（2026-11-17 下午追加）
- **需求**：用户想做"近六年黄金价格走势 vs 黄金股价格走势对比"视频。判定为 A 类 `timeseries`
  多序列折线（不是 C 类 MACD 回测）——链路早已跑通，无需改封版渲染器。
- **口径取舍**：金价用 COMEX 黄金 `101.GC00Y`；黄金股用户选了黄金股ETF `517400`，
  但**该 ETF 仅 2024-05-08 起有数据，覆盖不了六年**。按两源共同交易日取交集，
  实际区间 **2024-05-08 ~ 2026-11-16，610 个交易日**，已在视频副标题如实标注；
  用户若坚持六年需改用黄金个股（600547/601899/600489，均有 2020 起数据）。
- **数据**：两条真实收盘价序列各自归一化到起点=100（金 100→166.62、ETF 100→124.23），
  源文件 `datafeed/out/gold_compare/`（gitignore 不入库）；今天 2026-11-17 未收盘 K 线已剔除。
- **出片**：新增 `tools/render_gold_compare.cjs`，复用封版 `genericChart.timeseries.execute()`，
  不启网页、不重写校验/渲染/溯源。出 720 帧 / 24s / 1920×1080@30fps 对比片，
  **两次独立出片 SHA 逐字节一致**，系统 `sha256sum` 核验 `f740456d…`；
  溯源 1220/1220 行回读通过、报告↔模型勾稽 pass。
- **画面确认**：双折线（蓝=金、黄=ETF）+ 图例末值 + 四条标注（首/末/最大/最小，仅第一条序列，
  A 类渲染器既有设计）+ Y 轴 50~300 自适应（不强制从 0 起）+ 来源/免责声明齐全，无重叠。
- **A 类边界**：无独立像素级验收脚本（不像 C 类 41 项），验收=溯源回读+报告勾稽；
  时长固定 24s 不随数据长度变；已加 `.gitignore` 忽略 `output/*/01_input/`（含真实归一化数据点）。
- **换标的复用（同日追加）**：用户要求换成山东黄金 `600547`，数据仍取东方财富未复权日线，
  同一 610 日共同区间；归一化后金 100→166.62、山东黄金 100→79.79（除权缺口未回填，来源行已标注未复权）。
  `tools/render_gold_compare.cjs` 新增 `--note` 以传入来源说明，默认文案不变；两次独立出片 SHA 一致
  `0f1e1e7941765d9…`（产出在 `output/gold_vs_shandong_A|B/`，gitignore 不入库）。

### A6. 策略卡直出片垂直切片（2026-11-17 下午追加）
- **目标**：验证最终产品的最短闭环——用户只给「标的 + 区间 + 模板 + 参数」，不碰 CSV，
  自动取真实未复权日线 → 统一门禁 → `runStrategy` → 通用策略视频。
- **契约补齐**：`backtest_result.json` 新增 `market`（展示区间 OHLC，可选 volume），
  只供渲染器画价格/买卖点，不参与回测；与 `equity` 日期逐日对齐，预热段不入片。
  schema 与 `STRATEGY_SPEC §3` 已同步；策略引擎自检 27/27（新增 market 对齐断言）。
- **新增**：
  - `engine_next/render_strategy_video.py`：只读 `backtest_result.json` 的通用策略渲染器，
    画价格曲线、买卖标记、持仓区间、资产曲线、当前/期末指标、来源与免责声明；
    720 帧 / 24s / 1920×1080@30fps，固定画面文案不含时间戳。
  - `tools/run_strategy_video.cjs`：策略卡 → 东方财富区间取数（自动补预热，最多回溯 730 天）
    → `validateImport` → `runStrategy` → 写 `00_card.json / 01_data / 02_backtest / 04_video / run_result.json`。
  - `datafeed/eastmoney_fetch.py` 新增 `--start/--end` 区间取数（`--days` 模式保留不变）。
  - 样例卡 `samples/strategy_cards/close_buy_open_sell_600000.json`。
- **实测**：600000 / 2024-01-02~2026-11-16，取数 815 根（预热 121、展示 694），
  46 笔、期末 96,652.73、收益 -3.35%、最大回撤 3.35%（未提供分红表，结果不含现金分红）。
  两次独立取数 + 出片：`resultSha256=d3240313…`、MP4 SHA `22b1705201f0…` 均逐字节一致；
  `engine_next/tests/accept_strategy_video.py --run strategy_600000_A` **20/20**。
- **契约修正**：验收发现 `equity` 原先把预热段也纳入，导致与 `market` 日期不一致；已在引擎层改为
  只保留展示区间（预热仅用于指标热身），并同步改预热测试断言。渲染器不再需要猜哪一段是预热。
- **边界**：首版只支持 `close_buy_open_sell` / `macd_cross` 两张卡；分红仍需用户提供三段式表；
  通用策略片是首版视觉，不套 MACD 的 41 项像素级验收；网页接入见 §A7、验收加厚见 §A8。

### A7. 策略卡通道接入网页（2026-11-17 傍晚追加，P0 完成）
- **目标**：把 §A6 的 CLI 垂直切片搬进网页，让陌生人不需要 CSV、不需要命令行，
  只填「证券代码 + 区间 + 模板 + 少量参数」就能出片。
- **新增**：
  - `web/src/strategyCard.js`：模板白名单（`close_buy_open_sell` / `macd_cross`）、
    请求 → 策略卡装配、预热根数口径。纯函数，校验层与适配器共用，避免两处漂移。
    客户端**不能直接投递 card 对象**，只接受 9 个字段，装配后再由引擎 `validateCard` 过一遍。
  - `web/src/adapters/strategyCard.cjs`：6 步执行——校验卡 → 东方财富区间取数（180/365/730 天
    逐级回溯补预热）→ `validateImport` 统一门禁 + 溯源回读 → `runStrategy` → 通用策略渲染 →
    20 项验收。原始 CSV 落到任务目录 `source.csv`，`traceability.json` 逐行可回读。
  - **区间终点收敛**：表单默认「结束日期 = 今天」，而今天未收盘的 K 线按 DATA_SPEC 被剔除。
    适配器按**实际可得的最后交易日**收敛展示终点，并在结果/工作区标注「请求 2026-11-17 →
    实际 2026-11-16」；任务目录 `card.json` 仍保留用户原始输入，`00_card.json` 与结果里是收敛后的卡。
  - `web/src/validation.js` / `taskManager.js` / `engineBridge.js` / `server.js`：新增
    `strategy_card` 策略标识、任务装配（`request.card` + `card.json`）、适配器注册、health 能力自述。
  - 前端 `index.html` / `app.js`：新增「策略回测视频（自动取数）」入口与专用表单
    （代码 / 名称 / 模板 / 区间 / 初始资金 / 入场信号 / 跳空阈值 / 可选分红表），
    工作区展示期末资产、持有对照、数据口径、视频指纹、独立验收与溯源条数，并可下载留档 CSV。
  - `tools/check_strategy_card_api.cjs`（离线回归 36/36）、`tools/e2e_strategy_card_web.cjs`
    （真起服务走 HTTP 全链路）。
- **实测**（网页路径，非直接调适配器）：600000 / 2024-01-02~2026-11-16，
  取数 815 根（预热 121、展示 694），46 笔，期末 **96,652.73**、收益 -3.35%、最大回撤 3.35%，
  同期长期持有 **144,564.35**；`resultSha256=5df18d70…`、MP4 SHA `1db24925…`、708,939 字节；
  独立验收 **20/20**（§A8 加厚后；加厚前后指纹完全一致）、溯源 **815/815**。
- **边界**：仍只支持两张模板；分红表需用户提供；20 项不是 MACD 的 41 项像素级验收；
  取数依赖东方财富公开接口（离线/被代理拦截时任务直接 failed，不产出空片）；
  仍只监听 127.0.0.1，未做公开部署。

### A8. 通用策略片验收加厚（2026-11-17 傍晚追加，10 项 → 20 项）
- **动机**：原 10 项只验「结果自洽 + 报告勾稽 + 主图非空」，无法发现「买卖点价格与行情脱钩」
  这类致命错误——视频画得漂漂亮亮，但买入价不是当天收盘价。加厚是扩模板的前提。
- **新增 10 项**（`engine_next/tests/accept_strategy_video.py`，纯增量、不动内核与渲染器）：
  1. 成交方向严格交替且以 BUY 开头（空仓买入→次日开盘卖出，不允许加仓）；
  2. `trades` 成交日期严格递增（无重复、无逆序）；
  3. 买入价 = 当日 `market.close`（尾盘 14:57 口径），容差 2e-4；
  4. 卖出价 = 当日 `market.open`（次日 9:25 口径），容差 2e-4；
  5. 每笔成交金额 = 价格 × 股数，容差 0.02；
  6. 逐日持股数由 `trades` 净额解释（含送转日按 `equity.flags` 的 `SHARE_ADJ` 放行）；
  7. 资产恒等式 `asset = cash + holdingValue + divReceivable`；
  8. 现金全程不为负（无透支）；
  9. 报告 `marketBars / trades / final / strategyId / symbol` 与结果一致；
  10. 结尾帧主图非空且与中间帧不同（画面确实在推进，防「静态帧循环」）。
- **反向验证**（不是空跑）：把一份结果人为改坏三处（买入价 +1%、某日持股 -100、末日现金 -5000），
  验收 **15/20**、退出码 1，且恰好 5 项按预期失败（买入价、金额、持股守恒、资产恒等式、现金透支）。
- **兼容性**：既有两次出片 `strategy_600000_A/B` 均 **20/20**；网页路径重跑 HTTP 全链路仍
  `resultSha256=5df18d70…`、MP4 `1db24925…` **逐字节不变**——验收只是变严，没有改动任何产出。
- **仍未覆盖**（下一步独立任务）：像素级买卖标记坐标与遮挡检查、旁白文案与实际决策逐条对齐。

### A. 数据接口层 `datafeed/`（主线）
- `datafeed/pytdx_fetch.py`：从 pytdx 拉未复权日线，生成 `stock_ohlc.csv` + `meta.json`。
  - 强制 `adjust=none`；主板代码段；起点 ≥ 2015-08-01；≥34 交易日；OHLC 自洽。
  - **不自动生成分红表**：pytdx 无登记日/派息日，契约禁止推导；`--dividend-hint` 只导线索供人工补。
  - pytdx 是可选依赖（延迟导入）；`--selftest` 离线可跑。
  - `--probe-connection` 诊断"连不上" vs "连上但数据为空"；`--probe-auction` 探测 9:25 集合竞价/分时。
  - 用户口径修正（11:13）：对日线策略，9:25 集合竞价结果即 `open`、14:57 收盘竞价结果即 `close`；
    「尾盘买/次日开盘卖」首版只需未复权日线 OHLC，**不再把竞价/分钟数据当前置条件**。
- `datafeed/tests/verify_datafeed_e2e.cjs`：证明接口层产物通过 `web/src/import/validate.js` 的同一套门禁。
- `datafeed/README.md`：依赖、命令、边界、本机实测状态。
- 既有四条出片链（v122/v123/generic/backtest 与 web/tools/docs/package/README/requirements）**零改动**（已用 `git diff 5884e0f` 核对为空）。

### B. V0.3 竖版片成果保留（暂停，不删）
- `fb9d91d`：容量校验 + 纵向自适应重排，独立验收从 24 扩到 31 项。当时 31/31 通过，压力片（5 条比例条 / 6 行列表 / 3 根柱）无叠字无崩溃。
- 按方向决定暂停，不再推进竖版片；保留分支，随时可回看。

## 3. 测试与验收结果（本轮实测）

| 项目 | 结果 |
|---|---|
| `python datafeed/pytdx_fetch.py --selftest` | **13/13** |
| `node datafeed/tests/verify_datafeed_e2e.cjs` | **5/5**（含 G-6 qfq 仍被拒） |
| 接口层产物喂 `validateImport` | `ok=true`，260 bars，警告仅 `W_NO_DIVIDENDS` |
| `--probe-connection 115.238.90.165:7709`（pytdx） | `CONTROL_OK_DATA_EMPTY`：`securityCountSH=27881`，`bars600000=0` |
| `node engine_next/tests/verify_strategy_engine.cjs` | **27/27**（锚点 7/7 + 新内核预热/金叉/跳空 8/8 + 门禁 + market 对齐） |
| `node tools/render_real_600000.cjs --run real_600000_v124_e2e`（v124 端到端） | **PASS 41/41**，SHA `59a4ce3d…` |
| v124 第二次独立出片 `--run real_600000_v124_e2e2` | **PASS 41/41**，MP4 SHA 逐字节一致 |
| `node engine_next/tests/accept_macd_video_v124.py`（真实/含分红/无分红三条） | 各 **PASS 41/41** |
| `node tools/render_gold_compare.cjs --run gold_vs_stock_A`（A 类真实对比片） | **出片成功**，720 帧 / 24s，溯源 1220/1220，SHA `f740456d…` |
| 第二次独立出片 `--run gold_vs_stock_B` | MP4 SHA 逐字节一致（`sha256sum` 核验） |
| `node tools/check_strategy_card_api.cjs` | **36/36**（校验拒绝 13 类 + 任务装配 + 能力自述 + 预热口径） |
| `node tools/e2e_strategy_card_web.cjs` | **PASS**：网页创建→执行→出片，20/20 验收、溯源 815/815、MP4 708,939 字节；请求终点=今天时自动收敛到 2026-11-16，指纹与固定终点一致 |
| `python engine_next/tests/accept_strategy_video.py --run strategy_600000_A` / `_B` | 各 **20/20**（加厚后：成交价来自行情、持股守恒、资产恒等式、画面推进） |
| `python tools/check_accept_negative.py` | **PASS** 反向验证：注入 3 处故障 → 15/20、退出码 1，命中预期失败项 |
| `npm run check:api` | **6/6**（health 三处派生字段含 `strategy_card`） |
| `git diff 5884e0f -- engine_next/lib/ engine_next/render_stock_macd_v122.py engine_next/render_stock_macd_v123.py engine_next/tests/accept_macd_video_v123.py engine_next/backtest_stock_macd.cjs tools/check_*.cjs docs/DATA_SPEC.md docs/samples/ ...` | 空（封版脚本零改动，新增 v124/工具与适配器脚本指向不计） |

数据状态按接口区分，不要混为一谈：
- **东方财富接口已取得真实数据**：600000 未复权日线 260 交易日，通过 `validateImport`，且已走完整出片（见 §A3/§A4）。
- **pytdx 仍是 `CONTROL_OK_DATA_EMPTY`**：连得上、股票数正常，但 K 线数据空洞。不要写成"pytdx 已验证真实数据"。
- 按用户 11:13 口径，日线策略用 `open/close` 即可表达尾盘买/次日开盘卖，`--probe-auction`（竞价/分钟量级）
  **不再是前置条件**；只有要用竞价量/未匹配量/逐笔委托时才需要，那时另立数据契约。

## 4. 尚未解决 / 已知限制

**阻断项**：无（当前不存在卡住发布的问题）。

**非阻断项 / 待办**：
1. **真实行情取数**：东方财富 HTTP 通道在本机可用（§A2/A6 已多次取到真实日线）；pytdx 仍 `CONTROL_OK_DATA_EMPTY`，只作为家里直连的备用通道。
2. **分红表**：真实股票多数有分红，接口层不自动补。要算准分红必须人工核对公告补三段式 `dividend.csv`（登记日/派息日缺一不可）。
3. **V0.3 竖版片**：方向已定为暂停，分支保留，不合并 main。
4. Draft PR：仍无。本轮不建；如要建，用 V02_HANDOFF 里的标题与 `docs/dev/V02_PR_BODY.md` 正文。
5. **策略卡网页通道的边界**：只支持 `close_buy_open_sell` / `macd_cross` 两张模板；无分红表则结果不含现金分红；
   独立验收为 20 项结构检查（成交价、持股守恒、资产恒等式、报告勾稽、画面推进），不含像素级标记坐标/遮挡检查；
   取数依赖东方财富公开接口（离线或被代理拦截时任务 failed，不产出空片）；
   服务仍只监听 127.0.0.1，陌生人访问不到（公开部署未做）。

## 5. 下一阶段最值得优先做的任务

主线是"股票策略可视化"，建议顺序：

1. ~~真实数据走完整出片~~ **已完成**（§A3：41/41 + 两次 SHA 一致）。不必重做。
2. ~~策略卡 → 自动取数 → 回测 → 视频~~ **垂直切片已完成**（§A6：600000 两次 SHA 一致）。
3. ~~Web 接策略卡~~ **已完成**（§A7：网页路径 20/20 验收、815/815 溯源、可直接下载留档 CSV）。
   下一步在它之上做体验与厚度，不重做通道。
4. ~~通用策略片独立验收~~ **已加厚到 20 项**（§A8：成交价/持股守恒/资产恒等式/画面推进；反向验证可失败）。
   仍缺像素级买卖标记坐标与遮挡检查、旁白逐条勾稽——那是后续独立任务，不与 20 项混做。
5. **策略表达层（下一个最高优先）**：当前只有两张卡。先做 3~5 个可组合模板（均线交叉、突破、
   固定持有天数、涨跌幅阈值），并把“自然语言 → 策略卡”作为**待确认的翻译层**
   （LLM 只生成卡、必须用户确认后才执行）。模板新增时同步补 `web/src/strategyCard.js`
   与前端表单，不要另开一条链路；**改 `strategy_runner.cjs` 前先设计，改完必须复跑 46 笔锚点与 20 项验收**。
6. **公开部署**：本机服务只监听 127.0.0.1，陌生人无法访问；需要任务队列、并发限制、磁盘清理、
   行情缓存与失败重试、合规免责声明，才谈“开源用户在线生成”。

## 6. 家里电脑接续步骤

```powershell
# 1) 克隆（匿名即可，无需凭据）
git clone https://github.com/xuyinzhang123/StrategyToVideo-OSS.git
cd StrategyToVideo-OSS

# 2) 切到本轮主线分支
git checkout -b feat/datafeed-pytdx --track origin/feat/datafeed-pytdx

# 3) 主程序依赖（渲染/网页，与工厂一致）
python -m pip install --target deps -r requirements.txt
npm install

# 4) 数据接口层依赖（可选，仅取真数时需要）
python -m pip install --target deps-datafeed pytdx

# 5) 最小验证（不需要网络、不需要 pytdx）
python datafeed/pytdx_fetch.py --selftest          # 期望 13/13
node datafeed/tests/verify_datafeed_e2e.cjs       # 期望 5/5
npm run check:samples                              # 期望 30/30
node engine_next/tests/verify_strategy_engine.cjs  # 期望 27/27
python engine_next/tests/test_timeline_bounds.py  # 时间轴冻结

# 5b) 策略卡直出片（需要东方财富网络）
node tools/run_strategy_video.cjs --card samples/strategy_cards/close_buy_open_sell_600000.json --run strategy_600000_A

# 5c) 策略卡网页通道回归（5c-1 不需要网络；5c-2 需要东方财富网络）
node tools/check_strategy_card_api.cjs             # 期望 36/36
node tools/e2e_strategy_card_web.cjs               # 期望 PASS（20/20 验收 + 815/815 溯源）
python engine_next/tests/accept_strategy_video.py --run strategy_600000_A   # 期望 20/20
python tools/check_accept_negative.py              # 反向验证：期望 PASS（注入故障后 15/20 且退出码 1）
#   没有本地出片时：先跑 5b 再跑上面两条

# 6) 启动网页并验证本机数据通道
npm start                                          # http://127.0.0.1:8080/
$env:PYTHONPATH='deps-datafeed'
python datafeed/pytdx_fetch.py --probe-connection  # 看 verdict
#   DATA_OK               -> 继续第 7 步
#   CONTROL_OK_DATA_EMPTY -> 换 --host 或换网络；不要在接口层造数据

# 7) 取真实数据（仅 DATA_OK 时）
python datafeed/pytdx_fetch.py --live --code 600000 --name 浦发银行 --days 260 --out datafeed/out/600000
#   网页导入 datafeed/out/600000/stock_ohlc.csv，symbol=600000 / adjust=none
```

若要看竖版片暂停前的成果：`git checkout -b feat/v0.3-phase0-storyboard --track origin/feat/v0.3-phase0-storyboard`。

### 接续提示词（回家直接粘贴给助手）

```text
StrategyToVideo OSS｜接续 feat/datafeed-pytdx（已推送到 95bbaa9）

已完成：策略卡 → 东方财富自动取数 → 统一回测 → 通用策略视频，已接网页
（填代码+区间+模板即可出片，无需 CSV）；网页路径 20/20 验收、815/815 溯源。

现在请做「策略表达层」：新增 3~5 个可组合模板（均线交叉、突破、固定持有天数、涨跌幅阈值）。
硬要求：
1) 先设计再改 strategy_runner.cjs，新增参数默认关闭，不得改变现有 46 笔锚点；
2) 改完必须复跑 verify_strategy_engine.cjs(27/27)、check:card(36/36)、
   e2e:card（期望 20/20 + resultSha256 不变）；
3) 新模板同步补 web/src/strategyCard.js 白名单与前端表单，不另开链路；
4) 每加一个模板补一条验收与一张样例卡，出片后跑 check:accept 与 check:accept:neg；
5) 推送同名分支 feat/datafeed-pytdx，不动 main / Release / 私人仓库。
```

## 7. 不需要重复验证的已有成果

- V0.2 的 41/41 股票验收、V0.1 演示 40/40、V1.2.3 41/41、时间轴冻结 SHA、determinism 对拍——都已通过且本轮零改动，不要重跑。
- `npm run check:samples` 30/30、`check:api` 6/6——本轮未改相关文件，回归即可，无需深挖。
- 接口层自身的 13+5 项自检——本轮已通过，改 `datafeed/` 时才需重跑。

## 8. V0.2 合并 main / 正式发布还缺什么

V0.2 **已发布**（tag `v0.2.0`）。本轮成果（数据接口层 + 策略引擎 + 真实数据出片）若要进入正式版，缺的是：
1. ~~真实行情取数成功并出一条真实数据片~~ **已完成**（§A3）。
2. 团队/用户评审是否接受"可选 pytdx/东方财富依赖 + 不自动生成分红表 + 新策略独立验收"这些边界。
3. 如要合入 main，需要先开 PR 并评审——本轮不做。

## 9. 硬边界（继续遵守）

不合并 main、不建 Release、不碰私人仓库、不强制推送、不新增策略/AI API/复杂视觉功能、不做无关的双电脑同步排障。
遇到阻断先保留已推送成果并如实报告，不要编造数据或强行宣称验收通过。

## A9. 策略表达层 · 四组件组合（2026-11-17 晚 · 本轮完成）

设计先行：`docs/dev/STRATEGY_COMPOSITION_DESIGN.md`（提交 `b6ced13`），实现提交 `8005f22`。

**实现**：四个可组合组件 `maCross`（入场/退出）、`breakout`（入场）、`fixedHolding`（退出）、`returnThreshold`（退出）。
一个入场 + 1~3 个退出（OR）；信号收盘确认、下一交易日开盘成交。
同日多退出只成交一次，`reasons` 按配置顺序完整保留；未选中的组件不产生信号。

**隔离**：`strategy_runner.cjs` 一行未改；新增 `strategy_conditions.cjs` +
`strategy_runner_composed.cjs`（受控副本）；`strategy_engine.cjs` 仅在
`params.composition` 存在时分发。前端在现有策略卡通道内加模板，未新建出片链路。

**四张样例卡**（`samples/strategy_cards/composition_*.json`）均已真实联网取数出片并验收：

| run | 组合 | 交易 | 期末资产 | 视频 SHA（前 16） | 验收 |
|---|---|---|---|---|---|
| composition_ma_ma_A | MA 入 + MA 出 | 23 | 101,774.36 | f5b46020e36cdfab | 20/20 |
| composition_breakout_hold | 突破 + 固定持有5日 | 15 | 91,213.97 | 0553610416f6f47a | 20/20 |
| composition_breakout_tpsl | 突破 + 止盈10/止损5 | 5 | 96,308.59 | dcf724df70347abe | 20/20 |
| composition_ma_hold_sl | MA + 持有5日 + 止损5 | 20 | 106,446.29 | cdf462e4fbfbad82 | 20/20 |

产物在 `output/composition_*/`，按 gitignore 不入库（含真实行情数据）。

**验收**：
- 新增 `verify_strategy_composition.cjs` 10/10（含突破排除当日、止盈基准为买入成交价、
  同日多退出一次成交、资产恒等式、确定性、注入失败）。
- 通用验收脚本按 `state.compositionMode` 分流买入价断言：旧卡=当日 close，组合=次开盘 open；
  **项数不变、阈值不变**，旧卡 20/20、四张组合卡 20/20。
- 反向验证 `check_accept_negative.py` PASS。

**旧门禁（改动后复跑）**：27/27、36/36、20/20；网页 e2e `resultSha256=5df18d704…` 不变；
CLI 重建旧卡 46 笔、期末 96,652.73、`resultSha256=d3240313…`（CLI 链历史锚点，与网页锚点不同源，均验到）。

## A10. V0.3.0 发布收口（2026-11-17 晚 · 家里电脑）

**任务性质**：发布收口，不新增功能。目标是把 `feat/datafeed-pytdx` 经审查后合并 main 并发布 v0.3.0。

**核查的指针**：本地公开仓库 `G:/stv-oss-v01`，remote=公开 OSS 仓库；功能分支 `6424ba0`（与远端一致、工作区干净）；
main（远端）`5884e0f`；已发布 tag `v0.2.0`=`70f4918`。PR 全量列表：仅已合并关闭的 #1，无待处理 V0.3 PR，不重复创建。

**发布前代码审查（无 P0/P1）**：
- 能力注册真实存在：四组件 `ENTRY_TYPES=[maCross,breakout]` / `EXIT_TYPES=[maCross,fixedHolding,returnThreshold]`；
  两模板白名单、四张 `composition_*.json` 样例卡、取数/渲染/验收脚本均已跟踪。
- 未来函数：breakout 窗口 `[i-lookback,i)` 严格排除当日；maCross 用 i-1/i；止盈止损以实际买入成交价为基准。
- 成交口径：组合模式买入/卖出均取次日开盘 `day.open`；同日多退出由 `pendingExit` 单次成交、reasons 按配置序去重；
  `reasonOrder.includes()` 确保未选组件不生效；资产恒等式逐日断言。
- 旧策略隔离：`engine_next/lib/`、`render_stock_macd_v122/v123.py`、`accept_macd_video_v123.py`、
  `docs/DATA_SPEC.md`、`docs/samples/` 相对 main 零改动；`strategy_runner.cjs` 为本分支新增（main 无此文件）。
- 安全：无私钥/token/凭据，代码无硬编码本机绝对路径，无 >1MB 跟踪文件；`xuyinzhang` 命中均为公开仓库链接。

**README 修正（对外描述）**：区分三种数据来源（SIMULATED / USER_IMPORT / 自动取数），
纠正"运行时不需要在线行情 API"的过时声明（自动取数需联网、非实时行情、不依赖付费 AI API）；
V0.3 由"开发中"改为已发布；补组合组件、安装第 8 步、策略卡验收入口；package.json 版本 0.2.0→0.3.0。

**发布前回归实测（本机，2026-11-17 18:49–18:5x）**：

| 项目 | 结果 |
|---|---|
| `verify_strategy_engine.cjs` | 27/27 |
| `check_strategy_card_api.cjs` | 36/36 |
| `verify_strategy_composition.cjs` | 10/10 |
| `check:api` | 6/6 |
| `check:samples` | 30/30 |
| `e2e_strategy_card_web.cjs --keep`（联网） | PASS：20/20 + 815/815 溯源 |
| `accept_strategy_video.py --run strategy_600000_A` | 20/20 |
| `check_accept_negative.py` | PASS（注入 3 处→15/20、退出码 1） |
| 两次独立出片 A/B | resultSha256 + 视频 SHA 逐字节一致 |
| 组合卡 composition_ma_ma CLI 出片 + 验收 | 20/20 |

**联网取数记录**：东方财富 push2his 未复权日线；取数区间 `2023-07-06 → 2026-11-17`（815 根，含预热 121）；
展示区间 `2024-01-02 → 2026-11-16`（694 交易日）；请求终点=今天时自动收敛到最新已收盘日 2026-11-16。
锚点：网页 `resultSha256=5df18d704…`，CLI `resultSha256=d3240313…`、46 笔、期末 96,652.73、收益 -3.35%、回撤 3.35%，
持有对照 144,564.35。组合卡 ma+ma：11 笔、期末 132,462.05、视频 SHA `f5b46020…`（与历史记录一致）。

**跨机视频 SHA 说明**：旧模板卡的本机现场出片视频 SHA/字节数与历史文档记录不同（网页 `0781c5b0…` vs 文档 `1db24925…`；
CLI `6b49eda0…` vs 文档 `22b17052…`），但 resultSha256 与全部验收项一致、本机两次出片逐字节一致，
组合卡视频 SHA 亦与历史一致——属编码字节/环境的跨机差异，不影响回测结果与验收，非 P0/P1。

---

## A11. V0.4 阶段 A：自然语言翻译层（分支 `feat/v0.4-nl-layer`，未合并）

**范围**：只做「中文 → 策略卡参数」的翻译层契约与离线解析器；**不改引擎、不改验收体系、不接任何 LLM**。
配套设计文档：`docs/dev/V04_NL_TRANSLATION_DESIGN.md`。

**新增文件（三个，均为纯函数，零第三方依赖）**

- `engine_next/strategy_nl.cjs`：受控词表匹配 + 路由 + `stv.nl-draft/0.1` 产物 + `describeDraft()` 规则串。
- `engine_next/tests/verify_nl_parser.cjs`：24 项验收。
- `docs/dev/V04_NL_TRANSLATION_DESIGN.md`：契约与阶段划分。
- `package.json` 增加 `check:nl` 脚本；其余文件零改动。

**三道门禁（顺序不可交换）**：受控词表 → `normalizeParams`（既有前端白名单，原样调用）→
`buildConditions`（既有引擎参数校验，传空行情数组只跑参数段，原样调用）。翻译层不复刻校验逻辑，
保证「翻译层能过的，引擎一定也能过」。

**两条不可让渡的规则**：参数可填默认值但必须列进 `defaults` 并在确认页展示；
条件不可补全——没说出场就报 `E_NO_EXIT`，只提止盈就不补止损（`stopLoss=null`），
没指明标的就报 `E_AMBIGUOUS_ROUTE`（均线金叉 vs MACD 金叉语义不同）。

**本轮实测发现（重要，供阶段 B 参考）**：`normalizeParams('close_buy_open_sell', …)` 会补
`entryFill` / `exitFill`，而 `buildCard` 不接受这两个键（它按模板自己补）——即该函数对老模板
**不幂等**。因此 `params`（卡片最终参数）与 `cardRequest.params`（重建卡片的最小请求参数）
在老模板上必须不同；最初把 `params` 原样喂回 `buildCard` 时验收第 19/20 项直接失败，
已按此修正并写进设计文档。`composition` / `macd_cross` 两个模板两者同一份对象。

**验收**：`node engine_next/tests/verify_nl_parser.cjs` → **24/24**。
其中第 19/20 项不是结构断言，而是把每条可执行产物真的经 `buildCard` 组装成卡、再 `runStrategy`
跑完回测并校验逐日资产恒等式；第 21 项反向验证非白名单组件在 `normalizeParams` / `buildCard` /
`buildConditions` 三处均被拒绝。

**回归（本机，2026-11-17）**：引擎 27/27、组合 10/10、策略卡接口 36/36、`check:api` 6/6、
`check:samples` 30/30；`git diff main` 对 `strategy_conditions.cjs`、`strategy_runner_composed.cjs`、
`strategy_engine.cjs`、v122/v123 渲染器、`accept_strategy_video.py`、`docs/DATA_SPEC.md` 全为空。

**未做（阶段 B/C）**：网页确认界面、LLM 适配器、把翻译结果接入 `buildCard` 的实际请求链。

---

## A12. V0.4 阶段 B：网页确认界面（分支 `feat/v0.4-nl-layer`，未合并）

**范围**：把阶段 A 的解析器接到本机网页，让用户能看见规则、能改参数、必须显式确认。
仍然**不接任何 LLM、不联网取数、不改引擎与验收体系**。

**新增/改动**

- `web/src/nlPreview.js`（新增）：`previewNl({text, overrides})`，纯函数，无副作用。
  用户改参后**重走同一套门禁**（`normalizeParams` → `buildConditions`），并用同一份结构化字段
  重新生成 `ruleText`，保证「界面显示的规则」与「最终提交的 params」同源。
- `web/server.js`：新增 `POST /api/nl/preview`（同源校验 + 请求体上限复用既有 readJsonBody）。
  解析不通过不是服务器错误，统一 `200 + ok:false`，前端按 `issues` 展示。
- `web/public/app.js`：策略卡表单顶部新增「用一句话描述策略」区块（textarea / 解析 / 确认并填入 /
  参数编辑 / 默认值勾选）。确认后 `nlState.confirmed` 固化 params，`buildCardRequest` 优先使用它；
  文本、模板、入场/退出条件的任何手工改动都会调用 `invalidateNl()` 作废确认状态。
- `web/public/styles.css`：`.nl-*` 样式。
- `tools/check_nl_preview.cjs`（新增）+ `package.json` 的 `check:nl-preview`。

**只允许改数值参数**：`fast / slow / lookback / days / takeProfit / stopLoss / holdIfGte`。
不允许借改参新增或删除条件——没有「固定持有」就改天数、没有「止盈止损」就改止盈，
一律 `E_OVERRIDE_NO_TARGET`；MACD 模板改参一律 `E_OVERRIDE_LOCKED`。
唯一的例外是 `stopLoss` 从 `null` 改成数值：那是用户显式补的，界面上会立刻反映在规则串里并需重新确认。

**验收**

- `node tools/check_nl_preview.cjs` → **13/13**。
- UI 用无头 Edge（`--headless=new --dump-dom`）真实点过两遍完整流程，未留测试钩子：
  1. 选策略卡 → 输入描述 → 解析 → 规则串与 5 个参数框渲染 → 确认后模板切到 `composition`、状态显示已确认；
  2. 「均线金叉」这类未给周期的输入 → `apply` 在勾选「我已核对默认值」前保持禁用；
     勾选后可确认；把快线改成 10 → 规则串同步变成 `MA10 上穿 MA20`；
     再改成 fast=10/slow=8 → 界面报 `E_MA_PARAMS` 且确认按钮重新禁用。
- 端到端缝隙验证：把 `previewNl` 产出的 `cardRequest.params` 直接 POST `/api/tasks`，
  服务端接受并创建任务（`queued`，仍是「创建 → 人工确认执行」两步），验证后已删除该任务。

**回归（本机，2026-11-17 22:xx）**：引擎 27/27、组合 10/10、翻译层 24/24、确认层 13/13、
策略卡接口 36/36、`check:api` 6/6。

**已知限制（阶段 C 再处理）**

- 只允许改数值，不允许在确认页增删条件；要换条件得改描述重新解析。
- 一次只解析一句策略，不做多轮对话式澄清。
- 网页端仍只服务 `127.0.0.1`，未公开部署。

---

## A13. V0.3.0 → V0.4.0 发布收口（2026-11-17）

**范围**：把阶段 A（离线解析器）+ 阶段 B（网页确认界面）合并进 main 并发布 v0.4.0。
**只发布既有实现，不新增功能**；引擎、组合 runner、渲染器、验收脚本、`docs/DATA_SPEC.md`、`samples/` 相对 main **零改动**。

**发布前实测（本机 2026-11-17 22:14）**

| 项 | 结果 |
| --- | --- |
| 策略引擎契约 | 27/27 |
| 组合组件 | 10/10 |
| 自然语言解析器 | 24/24 |
| 确认层 | 13/13 |
| 策略卡接口 | 36/36 |
| `check:api` | 6/6 |
| `check:samples` | 30/30 |
| `e2e:card` 网页全链路 | PASS（20/20 验收 + 815/815 溯源） |

联网取数（e2e）：东方财富未复权日线，取数 **2023-07-06 → 2026-11-17（815 根）**，
展示区间 **2024-01-02 → 2026-11-16（694 日）**；46 笔、期末 96,652.73、收益 -3.35%、回撤 3.35%；
`resultSha256=5df18d704…` 与 V0.3.0 锚点一致；视频 1920×1080@30、720 帧、706,088 字节、
SHA `0781c5b098ca5fa6…`（与 V0.3.0 发布时同机实测一致）。前端改动未影响原策略卡通道。

**对外描述修正（发布门禁）**

- 版本状态、Roadmap、能力边界、安装第 9 步、验收入口：把「自然语言只在开发分支、未发布」
  改为 **v0.4.0 已发布**，并同时写明它是**受限词表、完全离线、不接 LLM**，不是通用策略理解。
- `package.json`：`0.3.0` → `0.4.0`；新增 `check:composition` 脚本（对应既有 10 项验收，之前只有文件没挂 npm 脚本）。

**不变的两条红线（V0.4 依然遵守）**

1. 解析/确认只产出参数，**回测仍由确定性代码执行**，翻译层拿不到行情、不能调 `runStrategy`。
2. **条件不可补全**：缺退出报 `E_NO_EXIT`，只提止盈不补止损，路由不明报 `E_AMBIGUOUS_ROUTE`。

**未做（阶段 C 及以后）**：LLM 适配器、多轮澄清、确认页增删条件、公开部署。

---

## A14. V0.5 阶段一：策略表达式扩展（分支 `feat/v0.5-expression`，未合并未发版）

**范围**：只扩展**策略表达能力**两项——多条件入场（AND）与移动止损。
引擎口径、渲染器、20 项验收、`docs/DATA_SPEC.md` 均未改变成交与复权语义。
设计文档：`docs/dev/V05_EXPRESSION_DESIGN.md`。

**1) 多条件入场（AND）**

```json
"entry": { "type": "all", "items": [ {"type":"maCross","params":{"fast":5,"slow":20}},
                                     {"type":"breakout","params":{"lookback":5}} ] }
```

- 同一交易日收盘时全部子条件成立才入场；仍是「收盘确认 → 次一交易日开盘成交」。
- `items` 2~3 个，只能是 `maCross` / `breakout`，同类型不可重复（`E_COMPOSITION_ENTRY_*`）。
- 旧写法（单个原子）走同一分支，**逐字节等价**。

**2) 移动止损（`trailingStop`）**

- `params.drawdown` ∈ (0,1)，缺省 0.08；自买入成交日起跟踪持仓期**收盘价**最高值 `peakClose`，
  收盘价回撤达阈值 → 该日收盘确认、次开盘卖出。
- 峰值只用已收盘价更新；当日创新高时 `close ≤ peak×(1−dd)` 必为假，
  等价于「用当日之前的峰值」，不存在未来函数。

**关键回归证据（不是「看代码没问题」）**

- 四张既有组合样例卡，在**旧实现（main）与新实现**下逐卡对拍：
  `resultSha256` 完全相同，笔数与期末资产完全相同
  （15/91,213.97、5/96,308.59、20/106,446.29、23/101,774.36）。
- `e2e:card` 网页全链路 PASS，指纹与 V0.4.0 发布时一致
  （`resultSha256=5df18d704…`、46 笔、96,652.73、815/815 溯源、视频 SHA `0781c5b0…`）。

**验收数量变化**

| 脚本 | 之前 | 现在 | 新增内容 |
| --- | --- | --- | --- |
| `verify_strategy_composition.cjs` | 10 | **16** | AND 语义、AND 严格收紧、移动止损首次触发、峰值不含入场前高点、非法配置、**AND 零入场行为** |
| `verify_nl_parser.cjs` | 24 | **30** | 「且」才合成 AND、未说明与/或时拒绝猜、移动止损识别与默认值、回撤不被劫持、新组件真跑回测、反向拒绝 |
| `check_nl_preview.cjs` | 13 | **16** | 多条件与下改均线参数、移动止损可改、混合策略组装成卡 |

其余回归全绿：引擎 27/27、策略卡接口 36/36、`check:api` 6/6、`check:samples` 30/30。
新样例卡 `samples/strategy_cards/composition_all_trail_600000.json` 真实取数出片：
340 根（预热 121 / 展示 219）、5 笔、期末 131,744.72、收益 31.74%、回撤 8.33%、
`resultSha256=dff6d500…`、20/20 验收通过、两次独立出片视频 SHA 逐字节一致 `54df1914…`；
成交里同时出现 `takeProfit_20pct` 与 `trailingStop_8pct`，两种退出都被真实触发。

**必须知道的产品事实（实测发现）**

→ **AND 很容易把交易压到 0 笔**：MA5/20 金叉 与 lookback=20 突破在该样例上从不同日发生，
交集为 0。此时引擎不报错、不伪造信号、期末资产恒本金（已固化为第 16 项验收）。
界面上必须让用户预期到这一点，否则会被当成 bug。

**已知限制**

- 退出仍最多 3 个（现有 4 种类型，选其中最多 3 种）。
- 只做 AND，不做 OR 入场；仍不做选股/股票池。
- 前端表单入场参数固定 5/20 与 lookback 20，确认页可改数值但不能增删条件。
- **README 仍按 v0.4.0 描述，未提及本次能力**——等发版时再改，避免"未上线写成已上线"。

---

## A15. V0.5.0 工厂电脑收口（2026-11-18）：跨机对拍 + 0 笔提示 + 发版准备

### 1) 跨机基线（工厂电脑 Windows / Node v22.22.2 / npm 10.9.7 / Python 3.13.14）

| 门禁 | 命令 | 实测 | 与家里一致 |
| --- | --- | --- | --- |
| 策略引擎 | `node engine_next/tests/verify_strategy_engine.cjs` | 27/27 | 一致 |
| MACD 封版自检 | `node engine_next/backtest_stock_macd.cjs` | 21/21 | 一致（提示词里把这条写成 27/27，实际 21/21 的是 MACD 封版锚点；27/27 属于 `verify_strategy_engine.cjs`，两条都跑过） |
| 组合 | `npm run check:composition` | 16/16 | 一致 |
| 翻译层 | `npm run check:nl` | 30/30 | 一致 |
| 确认层 | `npm run check:nl-preview` | 16/16 | 一致 |
| 策略卡接口 | `npm run check:card` | 36/36 | 一致 |
| API 契约 | `npm run check:api` | 6/6 | 一致 |
| 样例数据 | `npm run check:samples` | 30/30 | 一致 |
| 视频验收 | `npm run check:accept` | 20/20 | 一致 |
| 反向验证 | `npm run check:accept:neg` | PASS（注入故障 15/20、退出码 1） | 一致 |

**四张旧组合卡向后兼容（与 main `19cc32f` 双跑对拍）**

| 卡 | main | feat/v0.5-expression | 笔数 / 期末 |
| --- | --- | --- | --- |
| breakout_hold | `d2514d6d1a3ce97b` | `d2514d6d1a3ce97b` | 15 / 91,213.97 |
| breakout_tpsl | `4706aefd1a504e4b` | `4706aefd1a504e4b` | 5 / 96,308.59 |
| ma_hold_sl | `716f555562a5724e` | `716f555562a5724e` | 20 / 106,446.29 |
| ma_ma | `0cf071f6c2b75d26` | `0cf071f6c2b75d26` | 23 / 101,774.36 |

对拍方式：把四张卡分别喂给 main 工作树与分支的 `runStrategy`，同一份 `docs/samples/stock_ohlc.csv`（SIMULATED），
打印 `reproducibility.resultSha256` 前 16 位；四张逐字节相同，笔数与期末一致。

**端到端 `e2e:card`：跨机确定性的口径说明（重要）**

同一条命令在不同日期跑，结果**不可能**同指纹，因为脚本用「今天」当区间终点：

- 2026-11-17（家里 / 昨天工厂）：终点收敛到 2026-11-16 → 694 展示日 / 815 根 / 46 笔 / 期末 96,652.73 /
  持有 144,564.35 / `resultSha256=5df18d704dc3a8a3…` / MP4 `1db24925749a88fb…`。
- 2026-11-18（今天工厂）：终点收敛到 2026-11-17 → 695 展示日 / 816 根 / 46 笔 / 期末 96,652.73 /
  持有 149,114.66 / `resultSha256=2be9df9c57f2c994…` / MP4 `941bf548ccecc395…`，20/20、溯源 816/816。
- **把终点钉回 2026-11-16 用同一 HTTP 路径重跑，逐项复现家里的数**：694 日 / 815 根 / 46 笔 /
  96,652.73 / 144,564.35 / `5df18d704…` / MP4 `1db24925…` / 708,939 字节 / 20/20 / 815/815。
  结论：**resultSha 与 MP4 SHA 在两台机器上都能逐字节复现**，差异只来自「多了一根 K 线」，不是环境漂移。
  （家里 V0.4.0 记录的 MP4 `0781c5b0…` 属于另一次含不同收敛终点的运行，不作为本次对拍基准。）

### 2) 0 笔交易的显式提示（本轮唯一代码改动）

- 位置：`web/public/app.js`，`renderWorkspace()` 里 `if (r0.final != null)` 分支内，`+10` 行。
- 行为：`Number(r0.trades) === 0` 时追加一条 `.warn-box`（琥珀色中性提示，非红色报错样式），
  内容含三点：本区间内没有任何一笔交易成立 / 这不是运行失败、期末资产等于初始资金 / 入场条件太严，
  多条件「与」尤其容易，建议放宽或去掉一个条件后重跑。非 0 笔不输出该行。
- 未改后端返回结构、未改 `trades` 语义、未改引擎。
- **真实 DOM 证据**（不是只改代码就宣称完成）：起本机服务 → 建真实任务
  （`composition` / 600000 / 2025-01-02~2025-12-31 / 入场 `maCross(5,20) AND breakout(250)` / 退出 `fixedHolding(5)`）
  → 得到 `trades=0`、`final=100000`、243 展示日、20/20 验收 → 用本机 Edge 无头 + CDP 打开页面、
  在「查询任务」填入 taskId，读取真实 `#ws-summary` innerHTML：

```html
<div><b>期末资产</b>：¥ 100,000 · 收益 0.00% · 最大回撤 0.00% · 0 笔交易</div>
<p class="warn-box"><b>本区间内没有任何一笔交易成立</b>：这不是运行失败，期末资产等于初始资金（¥ 100,000），
资金没有被交易消耗。通常是因为入场条件太严——多条件「与」尤其容易一次都不触发；
可以放宽参数，或去掉一个入场条件后重新创建任务。</p>
```

  探针脚本用完即删，仓库里没有留任何测试钩子（`git status` 只有 `web/public/app.js` 一处改动）。
- 组合验收第 16 项（严格 AND 零入场：不报错、不产生交易、不伪造信号、期末恒本金）保持原样未放宽。

### 3) 发版完成（**已发布 v0.5.0**）

- `package.json` 版本 `0.5.0`；`main` 已通过 Squash Merge PR #4 前进到 `cac1ab89d42558ef96cb07bdf859b67ee06ba71d`。
- PR #4：https://github.com/xuyinzhang123/StrategyToVideo-OSS/pull/4 ，`merged=true`，6 提交 / 15 文件 / +890 -101，`mergeable_state=clean`，无 review comments 与 issue comments。
- tag `v0.5.0` 为 annotated tag，指向同一合并提交 `cac1ab89…`；Release 已发布（非 draft、非 prerelease）：https://github.com/xuyinzhang123/StrategyToVideo-OSS/releases/tag/v0.5.0 。
- README 与本文件的「待发布」已统一改为「已发布 v0.5.0」；能力边界未弱化（仍强调不做通用策略理解、不保证收益、不做「或」入场与选股池）。
- 门禁沿用已验收 HEAD `6852245` 的记录（引擎 27/27、MACD 21/21、组合 16/16、翻译 30/30、确认 16/16、卡接口 36/36、API 6/6、样例 30/30、策略视频 20/20、反向验证 PASS），按任务书未重跑；GitHub 侧未配置 CI，无 check-runs。
- 凭据插曲：09:38 首次合并因系统 token 过期返回 `Bad credentials`；用户批准官方授权刷新后于 09:53 重试成功。未索要 PAT、未写 token 入库、未直推 main。
