# V0.2 开发交接（跨电脑）

> 本文件是 V0.2 的唯一交接入口。只依赖公开仓库 GitHub，不含私有仓库路径、账号凭据或个人数据。
> 代码基线 commit：`3c76975`（发布前代码审查 + 文档一致性修正）。本文件所在提交为分支最新 HEAD，请以 GitHub 分支页显示为准。

## 1. 当前版本 / 分支 / 提交

| 项 | 值 |
|---|---|
| 已发布版本 | V0.1（SIMULATED 固定 MACD 演示，视频 V1.2.2） |
| 开发中版本 | V0.2（源码可用，尚未发布 Release） |
| 分支 | `feat/v0.2-stock-ohlc-csv` |
| 远端 | `https://github.com/xuyinzhang123/StrategyToVideo-OSS.git` |
| 代码基线 | `3c76975`（此前 UX 修复为 `bd180aa`） |
| 公开 main | 未改动，仍指向 V0.1 基线 `32418a7` |

## 2. V0.2 已完成

- 用户 CSV · **时间序列**：折线生长动画，多序列对比。
- 用户 CSV · **分类对比**：条形动画，负值 / 分组 / 第二数值列。
- 用户 CSV · **股票日线 OHLC**：校验 → 八段结构 → MACD(12,26,9) 回测 → **V1.2.3** 渲染 → 41 项独立验收 → MP4；未通过验收即失败落盘，不交付半成品。
- 数据留档与溯源：原始 CSV / 分红 CSV 原样留档 + SHA-256；页脚显示文件名与指纹前 12 位；文本行数与数据记录数分别显示，源行号从 2 起。
- V0.1 兼容：V1.2.2 封版时间轴与画面逐字节保持；V0.2 股票单独使用 V1.2.3。
- 发布前五项体验修复：V1.2.3 文案分离、任务终态步骤显示、缺列/未映射提示、行数口径、无分红副标题与片尾费用口径。

## 3. 已通过的测试与验收（可复用，不必重跑）

| 检查 | 结果 |
|---|---|
| `npm run check:samples` | 27/27 PASS |
| `python engine_next/tests/test_timeline_bounds.py` | 180 组边界 + 3 组封版 POS SHA 冻结 PASS |
| 股票 CSV 独立验收 V1.2.3（含分红 260 日样例） | 41/41 PASS，MP4 SHA `bcc1ee5a9629cf9b…` |
| 股票 CSV 独立验收 V1.2.3（无分红 260 日样例） | 41/41 PASS，两次独立出片 SHA 均 `6c67b43ee95fae2731…` |
| 重复出片一致性 | 两次 MP4 SHA 逐字节一致 |
| 回测自检 | 21/21 PASS；金叉 12 / 死叉 11 / 23 笔 |
| V0.1 成片逐字节兼容 | SHA `6c556f297adc379d…` 与公开提交 `32418a7` 工作树一致 |
| 无分红副标题目视 | 已抽帧确认页头副标题与片尾总述完整、无遮挡、未越界 |

## 4. 未解决问题

**阻断项：无。** 代码审查未发现阻断性代码错误；仅做了一处文档一致性修正（见提交 `3c76975`）。

**非阻断项 / 待处理：**

1. **Draft PR 尚未创建**：工厂电脑没有 GitHub API Token、`gh` CLI 或已登录浏览器，SSH 只能传输 Git 对象，不能调用 PR API。按授权边界未继续排障。家里电脑可直接按第 9 节创建。
2. 横盘行情 Y 轴幅度较小：按约定暂不处理，优先保证真实刻度、零遮挡和金额准确。
3. `DATA_SPEC.md` 的 2 万行上限常量在代码中未单独使用；实际由 2 MiB 文件大小上限兜底。这是 V0.1 既有实现，非 V0.2 回归。
4. V1.2.3 是 V1.2.2 的受控副本；将来若修改 V1.2.2，需人工同步 V1.2.3 并复跑 41 项验收。
5. 工厂本机临时验证脚本未入仓库；正式测试套件是否收纳由评审决定。
6. qfq/hfq 明确不支持（设计决策，非缺陷）；非 Windows 平台尚未正式验证。

## 5. 下一阶段优先级

1. 在家里电脑创建第 9 节的 Draft PR，交给正式代码评审。
2. 按评审意见做最小修复；任何影响视频画面或金额的改动，都要重跑 V1.2.3 41 项验收与 V0.1 SHA 冻结检查。
3. 评审通过后再讨论合并 main 与发布 Release（本轮不做）。

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
python engine_next/tests/test_timeline_bounds.py
```

手动走通股票链路：网页选择「导入 CSV · 股票日线」，用 `docs/samples/stock_ohlc.csv` + `docs/samples/stock_dividends.csv`，代码填 `600000`，复权口径选 `none`，确认映射后创建任务并生成视频。

## 8. 不需要重复验证的成果

- 260 日含分红 / 无分红两次出片的 41/41 验收与 SHA 对拍。
- V0.1 演示 V1.2.2 的 40/40 验收、逐字节 SHA 冻结。
- 时间轴 180 组边界矩阵与封版冻结。
- 五项 UX 修复的前端桩测试、缺列/未映射提示、行数口径与无分红文案抽帧。
- G-1 / G-4 / G-6 门禁证据与 qfq 失真数据对照。
- 只有在改动回测、渲染、文案或映射语义时，才需要重新出片；改文档不需要。

## 9. Draft PR（待创建）

**状态**：创建受阻，原因见第 4 节。远程功能分支已完整推送，PR 可随时补建。
**链接**：暂无。创建后请把真实 URL 回填这里并同步给评审者。

标题：

```text
feat(v0.2): Import user CSV data and generate animated backtest videos
```

建议正文（可直接粘贴，Base `main` / Head `feat/v0.2-stock-ohlc-csv` / Draft）：

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
# 方式 A：网页打开下面的 URL，选择 Draft pull request，粘贴上面的标题与正文
Start-Process 'https://github.com/xuyinzhang123/StrategyToVideo-OSS/compare/main...feat:v0.2-stock-ohlc-csv'

# 方式 B：本机已安装 GitHub CLI 并登录时
gh pr create --draft --base main --head feat/v0.2-stock-ohlc-csv --title 'feat(v0.2): Import user CSV data and generate animated backtest videos' --body-file <写有上面正文的文件路径>
```

## 10. 合并 main / 发布 V0.2 前还缺什么

1. Draft PR 创建并完成正式评审，阻断意见全部关闭。
2. 在评审确认的干净工作树上复跑第 3 节的关键验收，确认结果未漂移。
3. 确认所有交付物只含公开仓库已有内容；`deps/`、任务目录、渲染视频、临时脚本不得入库。
4. 维护者手动合并 main；合并后单独打 Release 与发布说明。
5. 发布前再确认 V0.1 演示仍为 V1.2.2 且成片 SHA 未变。

本文件不涉及、也不应触发 V0.3、新策略、AI API 或新的双电脑同步工程。
