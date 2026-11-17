# 当前状态与接续指南（2026-11-17）

> 唯一权威来源：公开仓库 https://github.com/xuyinzhang123/StrategyToVideo-OSS
> 本文件在分支 `feat/datafeed-pytdx` 上。回家从这里接续，不需要工厂电脑传任何文件。

## 0. 一句话结论

已发布 V0.2（tag `v0.2.0`，main=`5884e0f`）；方向确认**专注股票策略可视化**，暂停其它视频形式。
本主线已完成三件事：① 双数据接口（`pytdx` + `eastmoney`）打通到校验门禁；② **东方财富在工厂电脑已取到真实 260 日数据并通过 validateImport**（pytdx 仍 `CONTROL_OK_DATA_EMPTY`）；③ 策略卡契约 + 独立策略引擎 Draft（`macd_cross` 复现封版锚点、`close_buy_open_sell` 跑通）。
注意：**真实数据尚未走完整出片**（导入→回测→V1.2.3→41 项）；策略引擎**尚未接网页**。二者是下一步，不得宣称已完成。

## 1. 分支与指针（以 GitHub 为准）

| 分支/标签 | commit | 用途 |
|---|---|---|
| `main` | `5884e0f` | 已发布基线，**不要改动、不要强推** |
| tag `v0.2.0` | `70f4918` | V0.2 正式发布点 |
| `feat/datafeed-pytdx` | 见本节末实际指针 | **当前主线**：pytdx + 东方财富双接口 + 策略卡契约/引擎（详见 STRATEGY_ENGINE_HANDOFF.md） |
| `feat/v0.3-phase0-storyboard` | `fb9d91d` | 竖版"数据解剖片"渲染器，**已按方向决定暂停**，成果保留不删 |

没有 PR（V0.2 的 PR #1 已合并关闭）。本轮不合并 main、不开 PR、不发版。

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
| `node engine_next/tests/verify_strategy_engine.cjs` | **26/26**（锚点 7/7 + 新内核预热/金叉/跳空 8/8 + 门禁） |
| `git diff 5884e0f -- engine_next/lib/ web/ tools/ docs/DATA_SPEC.md docs/samples/ ...` | 空（封版出片链零改动） |

数据状态按接口区分，不要混为一谈：
- **东方财富接口已取得真实数据**：600000 未复权日线 260 交易日，通过 `validateImport`（见 §A2）。
  但**尚未用这批真实数据走完整出片**（导入→回测→V1.2.3→41 项）。
- **pytdx 仍是 `CONTROL_OK_DATA_EMPTY`**：连得上、股票数正常，但 K 线数据空洞。不要写成"pytdx 已验证真实数据"。
- 按用户 11:13 口径，日线策略用 `open/close` 即可表达尾盘买/次日开盘卖，`--probe-auction`（竞价/分钟量级）
  **不再是前置条件**；只有要用竞价量/未匹配量/逐笔委托时才需要，那时另立数据契约。

## 4. 尚未解决 / 已知限制

**阻断项**：无（当前不存在卡住发布的问题）。

**非阻断项 / 待办**：
1. **真实行情取数**：本机经代理访问免费行情服务器，控制通道正常但数据通道为空。家里网络直连若 `DATA_OK` 即可取真数；否则换 `--host` 或换网络。
2. **分红表**：真实股票多数有分红，接口层不自动补。要算准分红必须人工核对公告补三段式 `dividend.csv`（登记日/派息日缺一不可）。
3. **V0.3 竖版片**：方向已定为暂停，分支保留，不合并 main。
4. Draft PR：仍无。本轮不建；如要建，用 V02_HANDOFF 里的标题与 `docs/dev/V02_PR_BODY.md` 正文。

## 5. 下一阶段最值得优先做的任务

主线是"股票策略可视化"，建议顺序：

1. **用已取到的东方财富真实数据走完整出片**：拿 600000 的 260 日未复权 CSV，走网页导入 → 回测 → V1.2.3 → 41 项验收。把"合成样例全绿"升级为"真实数据也成立"。这一步不需等家里网络（工厂已取到真数）。
2. **Web 接入策略卡**：选模板 + 填参数 + 选区间 + 导入 CSV（复用 `validateImport`）。策略引擎本轮已把预热切分 / `macd_golden` 入场 / 9:25 跳空过滤真正执行（26/26 自检），接口就绪，待前端表单。
3. **渲染器改读 `backtest_result.json`**：先做 MACD 模板等价替换保持 41/41，再支持 `close_buy_open_sell` 独立验收。
4. **超短线策略**：`close_buy_open_sell` 已具备首版内核（尾盘买/次日开盘卖 + 跳空情绪过滤），但**尚未独立验收、未出片、未接网页**，按新增策略单独定义口径，不塞进 MACD 41 项。若将来要用竞价量级数据，另立契约。

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
python engine_next/tests/test_timeline_bounds.py  # 时间轴冻结

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

## 7. 不需要重复验证的已有成果

- V0.2 的 41/41 股票验收、V0.1 演示 40/40、V1.2.3 41/41、时间轴冻结 SHA、determinism 对拍——都已通过且本轮零改动，不要重跑。
- `npm run check:samples` 30/30、`check:api` 6/6——本轮未改相关文件，回归即可，无需深挖。
- 接口层自身的 13+5 项自检——本轮已通过，改 `datafeed/` 时才需重跑。

## 8. V0.2 合并 main / 正式发布还缺什么

V0.2 **已发布**（tag `v0.2.0`）。本轮成果（数据接口层）若要进入正式版，缺的是：
1. 数据接口层在真实行情下取数成功并出一条真实数据片（当前只到合成样例 + 门禁层）。
2. 团队/用户评审是否接受"可选 pytdx 依赖 + 不自动生成分红表"这一边界。
3. 如要合入 main，需要先开 PR 并评审——本轮不做。

## 9. 硬边界（继续遵守）

不合并 main、不建 Release、不碰私人仓库、不强制推送、不新增策略/AI API/复杂视觉功能、不做无关的双电脑同步排障。
遇到阻断先保留已推送成果并如实报告，不要编造数据或强行宣称验收通过。
