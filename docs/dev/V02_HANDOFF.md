# V0.2 开发交接（跨电脑）

> 本文件是 V0.2 的唯一交接入口。只依赖公开仓库 GitHub，不含私有仓库路径、账号凭据或个人数据。
> 代码基线 commit：`3c76975`（发布前代码审查 + 文档一致性修正）；本轮 PR 审查的三项修复提交在其之上（见第 4 节）。本文件所在提交为分支最新 HEAD，请以 GitHub 分支页显示为准。

## 1. 当前版本 / 分支 / 提交

| 项 | 值 |
|---|---|
| 已发布版本 | V0.1（SIMULATED 固定 MACD 演示，视频 V1.2.2）、**V0.2.0（用户 CSV 导入，Release `v0.2.0`）** |
| 分支 | `feat/v0.2-stock-ohlc-csv` |
| 远端 | `https://github.com/xuyinzhang123/StrategyToVideo-OSS.git` |
| 代码基线 | `3c76975`（此前 UX 修复为 `bd180aa`）；本轮 PR 审查修复见第 4 节表格 |
| 公开 main | 未改动，仍指向 V0.1 基线 `32418a7` |

## 2. V0.2 已完成

- 用户 CSV · **时间序列**：折线生长动画，多序列对比。
- 用户 CSV · **分类对比**：条形动画，负值 / 分组 / 第二数值列。
- 用户 CSV · **股票日线 OHLC**：校验 → 八段结构 → MACD(12,26,9) 回测 → **V1.2.3** 渲染 → 41 项独立验收 → MP4；未通过验收即失败落盘，不交付半成品。
- 数据留档与溯源：原始 CSV / 分红 CSV 原样留档 + SHA-256；页脚显示文件名与指纹前 12 位；文本行数与数据记录数分别显示，源行号从 2 起。**C 类已补齐 `traceability.json`**：逐根 K 线的日期与 OHLC、逐条分红的除息日与每股现金红利 → `source.csv` / `dividend.csv` 行号；渲染前按行回读，任一行被改动即 `E_TRACE_FAILED` 拒绝交付。
- 用户可见文案：股票页脚兑现表单承诺的「数据来源说明（会写进视频页脚）」；页脚左段与页头副标题做宽度自适应（缩字号→省略号），长文件名/长来源不会压到右侧免责声明。
- `/api/health` 能力自述与实际可执行一致：`executableStrategies` / `execution.strategies` / `strategyModes` 由同一份 `STRATEGY_MODES` 派生，包含 `stock_ohlc`；`npm run check:api` 守住这条口径。
- V0.1 兼容：V1.2.2 封版时间轴与画面逐字节保持；V0.2 股票单独使用 V1.2.3。
- 发布前五项体验修复：V1.2.3 文案分离、任务终态步骤显示、缺列/未映射提示、行数口径、无分红副标题与片尾费用口径。

## 3. 已通过的测试与验收（可复用，不必重跑）

| 检查 | 结果 |
|---|---|
| `npm run check:samples` | 30/30 PASS（新增 D 段：股票溯源 260/260、262/262、篡改一行即拒绝） |
| `npm run check:api` | 6/6 PASS（health 三处口径同源且含 `stock_ohlc`） |
| `python engine_next/tests/test_timeline_bounds.py` | 180 组边界 + 3 组封版 POS SHA 冻结 PASS |
| 股票 CSV 独立验收 V1.2.3（含分红 260 日样例） | 41/41 PASS，MP4 SHA `12a4946cf79b0a36…`；溯源 262/262（含 2 条分红行） |
| 股票 CSV 独立验收 V1.2.3（无分红 260 日样例） | 41/41 PASS，两次独立出片 SHA 均 `1177046d55f2d6f7…`；溯源 260/260（首行=第 2 行） |
| 重复出片一致性 | 股票无分红两次网页出片 MP4 SHA 逐字节一致；A/B 由 `check:determinism` 覆盖 |
| 回测自检 | 21/21 PASS；金叉 12 / 死叉 11 / 23 笔（无分红 macdFinal 101,043.87 / hold 113,477.32；含分红 102,918.09 / 117,347.32） |
| V0.1 成片逐字节兼容 | 历史验收 SHA `6c556f297adc379d…` 与公开提交 `32418a7` 工作树一致；V1.2.2 渲染器 / 回测脚本相对 `main` 零改动（diff 仅 V1.2.3、适配器、`video_events.py` 的显式口径开关），时间轴封版 SHA 冻结仍为 `58065a263f9744ad` / `6d8321f0017d5738` / `0baf5d3be1b189f6` |
| V0.1 演示在本机复渲（2026-11-16 终审） | 40/40 PASS，2830 日 / 1584 帧 / 52.8s / macdFinal 419,269.11；两次独立出片 SHA 均 `47a66f8dc3dbbefc…`（2,150,435 B）——**与基线 `6c556f29…` 不同**。判定为跨机器像素差异（Pillow 固定 13.0.0，差异来源是本机 Windows 字体 `msyh.ttc` 版本），**不是代码回归**：同机两次逐字节一致、验收全过。README 已把「逐字节一致」改为「同机同依赖」口径 |
| 无分红副标题目视 | 实测未被截断：副标题右边界 1285/1920，与右侧日期无重叠；页脚含「来源：」且与右侧免责声明间隔 646px，不重叠 |
| 失败路径 | 留档被改一行 → `E_TRACE_MISMATCH`，任务 failed，`/video` 返回 404，页面不展示视频 |

> 说明：股票 MP4 SHA 从旧值（`bcc1ee5a…` / `6c67b43e…`）变为新值，是**页脚新增来源说明**这一步文案变更导致的预期变化；确定性指「同一版本、同一输入两次出片一致」，本轮已复验（无分红两次均 `1177046d…`）。

## 4. 未解决问题

**阻断项（P0）：无。** 本轮按 A（可用性）/ B（数据与回测可靠性）/ C（发布内容准确性）三个角度做了实际代码审查与针对性测试，未发现数据错误、安全风险或核心功能不可用。

**本轮审查发现并已修复（P1 两项 + P2 一项）：**

| 级别 | 问题 | 证据 | 修复 |
| --- | --- | --- | --- |
| P1 | 股票任务不写 `traceability.json`，`GET /api/tasks/:id/traceability` 返回 404，页面无溯源面板——与 DATA_SPEC §1.8、README「可溯源」承诺不一致 | 出片后 `ls web/tasks/<id>/` 无 `traceability.json`；直接请求该端点 404 | 新增 `buildStockTrace()`，渲染前按行回读 `source.csv` / `dividend.csv` 逐字段比对，不符即 `E_TRACE_FAILED` 拒绝交付；结果写入 `traceability.json` |
| P1 | 股票表单承诺「来源说明会写进视频页脚」，实际 `copy.footer_left` 未使用 `sourceNote`，该字段被丢弃 | 实测 `sourceNote` 不出现在任何 `copy` 字段中 | 页脚左侧改为 `数据：用户导入 · <文件名> · SHA <前12位> · <复权口径> · 来源：<sourceNote>` |
| P2 | `/api/health` 的 `capabilities.execution.executableStrategies` 未列 `stock_ohlc`，与前端实际可执行能力矛盾 | 直接调用 `getHealthInfo()` 返回数组缺 `stock_ohlc` | 改由单一 `STRATEGY_MODES` 常量派生三处字段；新增 `npm run check:api` 守护 |

本轮另外做了一处**最小视觉防溢出**：为页头副标题和页脚左侧加 `fit_text()` 宽度自适应（只在超宽时缩号/截断加省略号）。这只在极端长文本下生效，正常样例画面不变。

**非阻断项 / 后续可做（P2，不阻断发布）：**

1. ~~**Draft PR 尚未创建**~~ **已创建（2026-11-16）**：PR [#1](https://github.com/xuyinzhang123/StrategyToVideo-OSS/pull/1)，Draft / open，base `main` ← head `feat/v0.2-stock-ohlc-csv`，正文取自 `docs/dev/V02_PR_BODY.md`。创建时 head SHA 为 `890d881ff41d7d7abe9501117b6006797de3ca28`；后续提交会自动进入本 PR。
2. 横盘行情 Y 轴幅度较小：按约定暂不处理，优先保证真实刻度、零遮挡和金额准确。
3. `DATA_SPEC.md` 的 2 万行上限常量在代码中未单独使用；实际由 2 MiB 文件大小上限兜底。这是 V0.1 既有实现，非 V0.2 回归。
4. V1.2.3 是 V1.2.2 的受控副本；将来若修改 V1.2.2，需人工同步 V1.2.3 并复跑 41 项验收。
5. 工厂本机临时验证脚本未入仓库；正式测试套件是否收纳由评审决定。
6. qfq/hfq 明确不支持（设计决策，非缺陷）；非 Windows 平台尚未正式验证。
7. 页脚/副标题的 `fit_text` 是「保证不溢出」的兜底，不是排版优化；将来若要更精致的多行排版，随输出样式多样化一起做。
8. **跨机器成片逐字节一致未验证**：本机复渲 V0.1 演示得到 `47a66f8d…`，与工厂机基线 `6c556f29…` 不同，但 40/40 通过、同机两次完全一致（见 §3）。差异来源是本机 Windows 字体版本，`requirements.txt` 固定 Pillow 13.0.0 也无法消除。
9. `web/src/engineBridge.js:105` 的兜底错误文案仍写着「当前可执行：ratio_band / macd / dividend_etf / …」，而 `web/src/validation.js` 的 `STRATEGY_IDS` 只有 4 个、真正可执行的也只有这 4 个。该分支实际不可达，属文案不一致。
10. ST / 退市整理过滤读的是用户填写的证券名称（留空时回退成代码，过滤被跳过）。README 已如实写成「按你填写的证券名称判断」，未做代码改动。
11. 股票任务的分红 CSV 已留档为 `dividend.csv`，但没有单独下载入口（只有 `source.csv` 可下载）；溯源面板仍逐条显示分红来源行。
12. `MAX_ROWS = 20000` 常量未被引用，实际只有 2 MiB 文件上限生效；README 已删去「≤ 2 万行」的硬性说法。

**已确认无问题的审查点（留档，避免重复排查）：**

- 删除任务确实清空 `web/tasks/<id>/`（含 `source.csv`、`traceability.json`、`video.mp4`）与 `output/web_<uuid>`；删除后 `GET /api/tasks/:id` 与 `/video` 均 404；运行中删除返回 409。
- 任务失败（如留档被改导致 `E_TRACE_MISMATCH`）后 `/video` 返回 404，页面不展示视频，不会把失败任务当成功展示。
- 不同任务互不覆盖：输入留档与输出目录都按 taskId / uuid 隔离。
- 视频结果对应本次输入：渲染前按行回读逐字段比对 + `sourceSha256` 三处一致，不符即拒绝交付。
- A 类（24/24）、B 类（8/8）溯源条目数量与数据点一致。
- `stock_ohlc` 已在前端卡片、`ADAPTERS`、`STRATEGY_IDS`、`USER_CLASSES` 全部注册，三个入口均可用。

## 5. 下一阶段优先级

1. 由人工评审 PR #1（Draft），按评审意见做最小修复；任何影响视频画面或金额的改动，都要重跑 V1.2.3 41 项验收、`check:samples`、`check:api` 与 V0.1 SHA 冻结检查。
2. 评审通过后再讨论合并 main（本轮不做，且不改 `main`）与创建正式 Release。
3. 合并前最后确认三件事：README/DATA_SPEC 与实现口径仍一致；`check:samples` 30/30 + `check:api` 6/6 + 时间轴 180 组全绿；股票样例出片可播放且金额与溯源清单一致。

## 5.1 未来版本方向（仅记录，不在 V0.2 实现）

用户希望输出形式更多元：**同一份数据可以生成不同视频风格、画面布局、动画节奏和叙事方式**，而不只是目前的折线图、条形图和 MACD 视频。

考虑方式（供后续版本设计参考，不承诺时间）：

- 把「数据 → 归一化模型」与「模型 → 视频」彻底分开：前者已由三类适配器完成，后者需要一层可选择的「渲染风格」配置（style / layout / pacing / narrative）。
- 风格以配置或模板表达，不改回测与金额计算；同一模型换风格后金额、事件标签、溯源必须保持一致。
- 新风格必须自带验收项，且不降低既有 41 项验收标准。

这一方向不进入 V0.2 范围，也不影响本次发布候选评审。

## 6. 家里电脑获取功能分支

```powershell
git clone https://github.com/xuyinzhang123/StrategyToVideo-OSS.git
cd StrategyToVideo-OSS
git fetch origin
git checkout -b feat/v0.2-stock-ohlc-csv --track origin/feat/v0.2-stock-ohlc-csv
git log -1 --oneline
```

已克隆过则跳过 `clone`：

```powershell
git fetch origin
git checkout feat/v0.2-stock-ohlc-csv
git pull --ff-only origin feat/v0.2-stock-ohlc-csv
```

## 7. 依赖、启动与最小测试

```powershell
python -m pip install --target deps -r requirements.txt
npm start
# 浏览器打开 http://127.0.0.1:8080/
```

最小验证（不需要重新渲染历史视频）：

```powershell
npm run check:samples
npm run check:api
python engine_next/tests/test_timeline_bounds.py
```

`check:samples` 覆盖 A/B/C 三类样例的数据正确性与溯源（30 项）；`check:api` 覆盖 `/api/health` 能力自述与实现是否一致（6 项）；时间轴脚本覆盖 180 组边界矩阵与 V0.1 封版 SHA 冻结。

**家里环境预演（已在工厂电脑用公开仓库 HTTPS 全新克隆代跑）：** 克隆 → 切到本功能分支 → 上述测试全部通过（当时样例检查为 27/27，本轮新增 3 项股票溯源断言后为 30/30，已在本机复验）；`npm start` 返回 HTTP 200。未安装 `deps` 时 `/api/health` 的 `renderEnv.ready=false` 属预期，按上面命令装完依赖即可出片。家里只需执行本节命令，不依赖工厂电脑的任何隐藏状态。

手动走通股票链路：网页选择「导入 CSV · 股票日线」，用 `docs/samples/stock_ohlc.csv` + `docs/samples/stock_dividends.csv`，代码填 `600000`，复权口径选 `none`，确认映射后创建任务并生成视频。

## 8. 不需要重复验证的成果

- 260 日含分红 / 无分红两次出片的 41/41 验收与 SHA 对拍。
- V0.1 演示 V1.2.2 的 40/40 验收、逐字节 SHA 冻结。
- 时间轴 180 组边界矩阵与封版冻结。
- 五项 UX 修复的前端桩测试、缺列/未映射提示、行数口径与无分红文案抽帧。
- G-1 / G-4 / G-6 门禁证据与 qfq 失真数据对照。
- 只有在改动回测、渲染、文案或映射语义时，才需要重新出片；改文档不需要。

## 9. Draft PR（已创建）

**状态**：已创建，Draft / open，等待正式代码评审（本轮不合并、不发布 Release）。
**链接**：https://github.com/xuyinzhang123/StrategyToVideo-OSS/pull/1
**编号**：#1 ｜ **Base**：`main` ｜ **Head**：`feat/v0.2-stock-ohlc-csv`
**标题**：feat(v0.2): Import user CSV data and generate animated backtest videos
**正文**：`docs/dev/V02_PR_BODY.md`（已核对与 PR 描述逐字节一致）
**创建时间**：2026-11-16 ｜ 创建方式：GitHub REST API（本机 git 凭据认证，仅公开仓库）
**备注**：创建时 head 为 `890d881ff41d7d7abe9501117b6006797de3ca28`。之后本分支又追加了两类提交：回填 PR 链接的文档提交，以及本轮 PR 审查的修复提交（见第 4 节表格）。这些提交都会自动追加到本 PR 的提交列表，**PR 保持 Draft，不标记 Ready for Review，不合并**。

标题：

```text
feat(v0.2): Import user CSV data and generate animated backtest videos
```

建议正文（Base `main` / Head `feat/v0.2-stock-ohlc-csv` / Draft）。**可直接用于 `--body-file` 的正文文件：`docs/dev/V02_PR_BODY.md`（内容与下方一致，以该文件为准）：**

````markdown
## V0.2 相对 V0.1 新增

V0.1 只提供 SIMULATED 模拟数据的固定 MACD 演示（V1.2.2）。V0.2 增加用户 CSV 导入：本地网页选文件、界面映射字段、留档原始文件与 SHA-256、生成视频与数据溯源，无需修改源码。

## 三类 CSV 的区别

- 时间序列：日期 + 数值（可多序列）→ 折线生长动画；不进入回测。
- 分类对比：名称 + 数值（可分组 / 第二数值）→ 条形动画；不进入回测。
- 股票日线 OHLC：日期 + 开高低收（可选成交量 / 成交额）→ 八段结构 → MACD(12,26,9) 回测 → V1.2.3 视频 → 41 项独立验收。可选分红 CSV；无分红时标注结果不含现金分红且不扣红利税。

## 已完成的验收与复现命令

- `npm run check:samples`：27/27 PASS
- `python engine_next/tests/test_timeline_bounds.py`：180 组边界 + 封版 POS SHA 冻结 PASS
- 股票 260 日样例：回测自检 21/21，独立验收 41/41 PASS，两次出片 SHA 一致
- `npm run check:determinism`：重复出片 SHA 逐字节一致

## V0.1 兼容性

V1.2.2 的默认时间轴成本域保持封版口径，V0.1 演示成片 SHA 与公开版本 `32418a7` 逐字节一致；V1.2.3 通过显式 `cost_domain="intervals"` 与自适应浮板隔离，仅服务用户 CSV。

## 为什么只支持未复权

回测把 CSV 价格当真实成交价计算金额、整手仓位与费用。真实 qfq 因子实测 5/23 笔信号日期改变、终值差约 +2,554.60 元，因此 qfq/hfq 一律 `E_ADJUST_UNVERIFIED`；未复权 + 分红表是当前唯一可证明的口径。

## 已知限制

仅沪深主板；不支持 qfq/hfq；数据起点不早于 2015-08-01；CSV 无法表达停牌；横盘 Y 轴幅度暂不优化；非 Windows 未正式验证；自定义策略 / AI API 不在本 PR。

## 合并与发布前检查清单

- [ ] 本 PR 通过评审，无未解决的阻断意见
- [ ] 在干净工作树复跑 `check:samples`、时间轴回归、V1.2.3 41 项验收
- [ ] 确认 main 未被本分支改动、无私有数据 / 渲染视频 / deps 入库
- [ ] 抽帧复核 USER_IMPORT 文案与无分红副标题
- [ ] 由维护者合并并单独发布 Release（本 PR 不执行）
````

创建方式（任选其一）：

```powershell
# 方式 A：网页打开下面的 URL，选择 Draft pull request，粘贴标题与 docs/dev/V02_PR_BODY.md 的内容
Start-Process 'https://github.com/xuyinzhang123/StrategyToVideo-OSS/compare/main...feat:v0.2-stock-ohlc-csv'

# 方式 B：本机已安装 GitHub CLI 并登录时（在仓库根目录执行）
gh pr create --draft --base main --head feat/v0.2-stock-ohlc-csv --title 'feat(v0.2): Import user CSV data and generate animated backtest videos' --body-file docs/dev/V02_PR_BODY.md
```

## 10. 合并 main / 发布 V0.2 前还缺什么

1. Draft PR 创建并完成正式评审，阻断意见全部关闭。
2. 在评审确认的干净工作树上复跑第 3 节的关键验收，确认结果未漂移。
3. 确认所有交付物只含公开仓库已有内容；`deps/`、任务目录、渲染视频、临时脚本不得入库。
4. 维护者手动合并 main；合并后单独打 Release 与发布说明。
5. 发布前再确认 V0.1 演示仍为 V1.2.2 且成片 SHA 未变。

本文件不涉及、也不应触发 V0.3、新策略、AI API 或新的双电脑同步工程。
