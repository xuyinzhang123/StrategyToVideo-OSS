# V0.3 阶段 0 · 验收记录

| 项 | 值 |
|---|---|
| 日期 | 2026-11-16（阶段 0 建立）· 2026-11-17（容量校验 + 纵向自适应重排） |
| 分支 | `feat/v0.3-phase0-storyboard`（自 `origin/main` @ `5884e0f` 切出） |
| 本轮性质 | spike / 阶段 0，不进发布节奏，不合并 main |
| 环境 | Windows · Python 3.13.14 · Pillow 13.0.0 · imageio-ffmpeg 0.8.1（ffmpeg 9.0.2）· Node v22.22.2 |
| 真实数据 | 无。所有数字为手写常量或用户提供的参考样片口述值 |

> **2026-11-17 增量**：修复阶段 0 遗留的「版式纵向步长写死」缺陷。原实现 `bar_scale` 3 条以上压结论、
> `row_list` 6 行压页脚、`decay_bars` 3 根因 `xs` 只有两个位置直接 `IndexError`、`dual_metrics` 3 项节奏散。
> 本轮做两件事：① 容量门禁 `E_CAPACITY`（宁可报错不许叠字）；② 纵向步长改为「可用高度 ÷ 条目数」，
> 结论块固定在安全区。验收从 24 项扩到 **31 项**（新增 D 组 7 项容量用例）。既有四条出片链零改动。

## 1. 交付物

| 文件 | 说明 | 指纹 |
|---|---|---|
| `output/v03_story/reference/video.mp4` | 与参考样片同结构、同数字的对照片，42.9s / 1287 帧 / 1,717,388 B | SHA-256 `7a5fa3de…39b04ada` |
| `output/v03_story/simulated/video.mp4` | 纯合成 fixture 自检片，20.0s / 600 帧 / 1,140,731 B | SHA-256 `d1130354…20d692729` |
| `output/v03_story/reference/report.json` | 对照片的数据源（**未入库**，见第 5 节） | — |
| `output/v03_story/*/storyboard.md` | 分镜表，由 report 自动生成 | — |
| `spike/v03/report.simulated.json` | 入库的合成 fixture | — |
| `spike/v03/storyboard.simulated.md` | 入库的分镜表 | — |
| `engine_next/render_story_v030.py` | 渲染器（新增） | — |
| `spike/v03/accept_story_v030.py` | 24 项验收（新增） | — |

两条片子的 `render_report.json` 都记录了帧数、探针帧 SHA、成片 SHA。
对照片连续渲染两次（不同时刻、同一环境）得到**同一个 SHA-256**，确定性成立。

## 2. 验收结果

### 2.1 对照片（42.9s，10 屏）

```
通过 22 项，警告 2 项，失败 0 项
```

### 2.2 自检片（20.0s，10 屏）

```
通过 31 项，警告 0 项，失败 0 项
```

> 2026-11-16 阶段 0 建立时为 24 项；2026-11-17 扩为 31 项（D 组容量用例）。
> 自检片重渲后帧数 600 / 20.0s 不变；因纵向布局几何调整，探针帧与成片 SHA 变化属预期，不是回归。
> 当前 `probe_frame_sha256=ce50b0ed…`、`video_sha256=07307b95…`（本机 msyh 字体，跨机器会变）。

### 2.3 31 项都验了什么

| 组 | 项 | 判据 |
|---|---|---|
| A 结构 | A1 屏数 = 10 | 与参考样片一致（钩子 + 8 章 + 收尾） |
| | A2 版式顺序 | 十种版式与样片逐屏对齐 |
| | A3 帧数 | = Σ(时长 × 30)，且与 render_report 一致 |
| | A4 时长 | ffmpeg 实测 vs 计算值，容差 0.05s |
| | A5/A6 画幅/帧率 | 1080×1920 / 30fps |
| | A7 无音轨 | 与样片一致（样片本身无音轨） |
| | A8 来源页脚 | 每屏 `provenance.footer` 非空 |
| B 编码 | B1 点阵亮格 | `lit == round(命中率 × 1000)` |
| | B2 密格 | 亮格数 > 0 且 ≤ 2 |
| | B3 细条 | 宽度比例 = 左侧百分比 |
| | B4 | 左右百分比合计 = 100 |
| | B5 分段条 | 段占比 = 屏上主百分比 |
| | B6 比例条 | 满格取组内最大值 |
| | B7 衰退柱 | 跌幅（或留存）与文案一致 |
| | B8 行列表 | 底部数字与引导文案同源 |
| C 版式 | C1 | 12 帧抽样，亮像素包围盒不越左右安全边距 |
| | C2 | 文字不压到底部 |
| | C3 | 十屏均非空 |
| | C4 | 顶部进度条随播放推进（0 → 满宽） |
| | C5 | 关键帧数量 = 屏数 |
| | C6 | 背景非纯黑（径向渐变存在） |
| | C7 | 探针帧 SHA 可复现 |
| | C8 | 成片 SHA 与 render_report 一致 |
| D 容量 | D1–D3 | 三条压力片（5 条比例条 / 6 行列表 / 3 根柱）渲染不崩、不越界 |
| | D4 | 3 根柱横向位置互不重叠 |
| | D5–D6 | 条目区底边 ≤ 结论块（底块）顶边，客观几何断言 |
| | D7 | 超几何上限抛 `E_CAPACITY`，不硬挤 |

**B 组是关键**：它不允许图形「看着差不多」，只允许「由 report 里的数字算出来」。
点阵亮格、条长、细条宽度、分段占比，全部可独立复算。
**D 组是本次新增的关键**：它不允许「超容量时叠字或崩溃」，只允许「排得下就排、排不下就明确报错」。

## 2.4 容量表与纵向自适应（2026-11-17）

步长从写死常量改为 `step = (结论块顶边 − 起始 y) ÷ 条目数`。结论块顶边固定在安全区，
不随条目数上浮；行高下限 `MIN_ROW=96px`、条目上限 `MAX_ITEMS=8`。超限抛 `E_CAPACITY`、非 0 退出。

| 版式 | 起始 y → 结论块顶边 | 可用高度 | 本轮放宽后上限 | 阶段 0 旧上限 |
|---|---|---|---|---|
| `dual_metrics` | 640 → 1150 | 510px | **5** | 3（3 项节奏散）|
| `bar_scale` | 600 → 1130 | 530px | **5** | 3（5 条压结论）|
| `row_list` | 660 → 1300 | 640px | **6** | 4（6 行压页脚）|
| `decay_bars` | 660 → 1180 | 520px | **5** | 2（3 根 IndexError）|
| `split_bar` | 560 → 1180 | 620px | **6**（横向分段，另有宽度约束）| 6 |
| `dot_matrix` / `dense_grid` | — | — | 不限（固定 cols×rows 点阵）| 不限 |

上限公式统一为 `min(MAX_ITEMS, floor(可用高度 / MIN_ROW))`，与 `adaptive_step()` 同一口径，
load_report 的 `BASE_CAPS` 由该公式派生，不留第二份过时表。

### 三条压力片实测（逐帧肉眼核对）

| 压力片 | 条目数 | 渲染 | 肉眼结论 | SHA-256（本机）|
|---|---|---|---|---|
| `bar_scale` | 5 条比例条 | 成功 | 5 条标签 + 条 + 数值齐全，结论「6 分钟，出一条」不被压，均在画面内 | `ca1c316c…` |
| `row_list` | 6 行列表 | 成功 | 6 行名称 + 标签齐全；底块「可回溯到源文件的比例：100%」与第 6 行、页脚均有间距，不叠字 | `f2c64c22…`（初次）→ 终版见下 |
| `decay_bars` | 3 根柱 | 成功 | 3 根柱 + 数值 + 标签 + 逐段衰减虚线齐全，结论不遮挡 | `98a1a033…` |

> `row_list` 首版底块压住第 5/6 行、随后又与页脚贴得过近，两次调整（底块锚点改为「最后一行分隔线之后」、
> 字号 116 / 偏移 +138）后复渲，终版 31 项验收 D 组全过。终版压力片渲染在
> `output/probe_v03_stress/`（已 gitignore，不入库），命令见第 6 节。

### 容量矩阵（0–8 项，验证「能排就排、排不下明确拒绝、绝不崩溃」）

| 版式 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| bar_scale | OK | OK | OK | OK | OK | OK | E_CAP | E_CAP | E_CAP |
| row_list | OK | OK | OK | OK | OK | OK | OK | E_CAP | E_CAP |
| decay_bars | OK | OK | OK | OK | OK | OK | E_CAP | E_CAP | E_CAP |
| dual_metrics | OK | OK | OK | OK | OK | OK | E_CAP | E_CAP | E_CAP |
| split_bar | OK | OK | OK | OK | OK | OK | OK | OK | OK |

无任何 `CRASH`（含原 `decay_bars` 的 `IndexError`）；全部越界都以 `E_CAPACITY` 非 0 退出。

## 3. 回归证据：股票回测出片没被碰到

| 检查 | 结果 |
|---|---|
| `git diff --stat origin/main -- engine_next/render_stock_macd_v122.py render_stock_macd_v123.py render_generic_chart.py backtest_stock_macd.cjs engine_next/lib web/ tools/ docs/ package.json README.md` | **空**（零改动） |
| `npm run check:samples` | PASS 30 / FAIL 0 |
| `npm run check:api`（PORT=8099） | PASS 6 / FAIL 0，`executableStrategies` 仍为 macd / timeseries / cross_section / stock_ohlc |
| `python engine_next/tests/test_timeline_bounds.py`（带 `PYTHONPATH=deps`） | 全部达标；封版口径 `58065a26…` / `6d8321f0…` / `0baf5d3b…` 逐位冻结未变 |
| 既有 V0.1 演示重渲 + V1.2.2 验收 | 1584 帧 / 52.8s 出片成功；`accept_macd_video_v122.py` **PASS 40 / FAIL 0** |

### 3.1 V1.2.3 的 41 项：本轮未复跑（原因与替代证据）

**本轮未复跑 `accept_macd_video_v123.py` 的 41 项，原因：它依赖一条 `stock_ohlc` 的网页运行产物
（`web/tasks/<id>/` 与 `output/web_<id>/`），这两个目录不入库，全新 clone 里没有该 run 数据。**
2026-11-16 阶段 0 建立时曾复跑过一次（41/41，见旧记录），那是当时本地残留的 run；2026-11-17
这次是干净分支接续，没有该 run，故如实跳过，不声称「41/41 通过」。

替代证据（两条，均为本轮实测）：

1. **静态零 diff**：`git diff --stat origin/main(5884e0f) -- <既有出片链路径>` 输出为空 ——
   `render_stock_macd_v122.py` / `render_stock_macd_v123.py` / `render_generic_chart.py` /
   `backtest_stock_macd.cjs` / `web/` / `tools/` / `docs/` / `package.json` / `README.md` 全部零改动。
   本轮只改 `engine_next/render_story_v030.py` 与 `spike/v03/accept_story_v030.py`。
2. **动态同基建**：V0.1 演示片在本轮重新渲染并跑 V1.2.2 验收 40/40；它与 V1.2.3 共用同一套
   时间轴（`video_events.py`）与渲染基建，时间轴 3 组冻结 SHA 本轮也未变。

如需本轮补跑 41 项：起服务 → `POST /api/tasks`（传 `docs/samples/stock_ohlc.csv`，
`dataClass=stock_ohlc`）→ `POST /api/tasks/<id>/execute` → 对生成的 run 跑 v123 验收。
本轮按边界未做（超过 30 分钟不值得，且非任务书必跑项）。

## 4. 与参考样片的差异（如实列出）

| # | 项 | 参考样片 | 本轮实现 | 处理 |
|---|---|---|---|---|
| 1 | 屏数 | **10 屏**（98.7% 钩子 + 01–08 章 + 收尾），42.9s | 同 10 屏，同顺序，同时长 | 已对齐 |
| 2 | 点阵编码 | 02 屏 13 亮格 / 273 格 ≈ 4.8%，而文案写 0.47%（装饰性放大 ~10×） | 1000 格，亮格数 = round(比例 × 1000) = 5 | **按比例实现**，接受视觉冲击变弱 |
| 3 | 05 屏占比 | 文案「70%」，但「制作 2万 : 投流 5万+」= 71.4% | 图按 2:5 画，屏上仍写 70% | 记 WARN，不改原文案 |
| 4 | 07 屏跌幅 | 文案「接近90%」，实测 100→8 = −92.0% | 同 | 记 WARN，不改原文案 |
| 5 | 字体 | 窄体重黑，数字又高又窄，几乎满宽 | `msyhbd.ttc`，数字偏宽矮，同字号占不满宽度 | 阶段 0 不引入字体授权问题，接受 |
| 6 | 07 屏结句 | 以「，」结尾，语义接到下一屏 | 原样保留换行 | 保持 |
| 7 | 收尾字幕右侧裁切 | 参考样片存在边缘挤压 | 亮像素包围盒 12 帧扫描，最右 996px（安全线 1006px） | 已消除 |

第 2 条是本轮唯一「主动不如样片」的地方：样片的点阵把 0.47% 画出了 4.8% 的存在感。
本实现选择可复算，代价是画面更空。**这个取舍要不要反过来，等你看了片再定**——
如果决定要「视觉放大」，必须先加一条 `grid.encoding: "amplified"` 并在屏上标注倍率，
不允许悄悄放大。

## 5. 未做 / 边界

- **没有指标层**：report.json 里的数字全部手写，`derived` 字段留空。怎么从原始 CSV 算出这些
  数字（覆盖率、口径、缺失值），是阶段 1 的事，等你看完片再定要不要做。
- **没有接入 web**：`server.js` 的 `STRATEGY_MODES`、`app.js` 的模式选择、`taskManager.js`
  的任务归一化，本轮一行未改。命令行跑得通，网页里看不到这个入口——这是有意的，
  避免为了一个还没被认可的版式去动共用前端。
- **对照 report 未入库**：`output/v03_story/reference/report.json` 里的数字来自用户提供的参考
  样片口述（DataEye / 艾媒咨询 / 公开行业访谈），未独立核验。公开仓库不传播未经核验的
  行业数字，所以只留本地、不提交；入库的是 `report.simulated.json`（纯合成，页脚写 SIMULATED）。
  想看同一条链跑真实结构，把任意 report.json 传 `--report` 即可。
- 无音频、无转场、无配乐；动画只有淡入、数字滚动、图形生长。
- 数字滚动开启时中间帧会显示非终值；`meta.motion.countUp=false` 可关。

## 6. 复现命令

```bash
# 所有 Python 渲染命令都带 PYTHONPATH=deps（依赖装在 deps/ 下）
# 自检片（入库 fixture）
PYTHONPATH=deps python engine_next/render_story_v030.py --report spike/v03/report.simulated.json \
  --out output/v03_story/simulated --storyboard spike/v03/storyboard.simulated.md \
  --keyframes output/v03_story/simulated/keyframes
PYTHONPATH=deps python spike/v03/accept_story_v030.py --report spike/v03/report.simulated.json \
  --render-dir output/v03_story/simulated

# 对照片（本地，需自备 report.json）
PYTHONPATH=deps python engine_next/render_story_v030.py --report output/v03_story/reference/report.json \
  --out output/v03_story/reference --storyboard output/v03_story/reference/storyboard.md
```

三条压力片在 `accept_story_v030.py` 的 D 组里由内存构造、无需外部文件；若要单独肉眼看帧，
可在 Python 里 `copy.deepcopy` 基线 report 的对应屏，分别塞入 5 bars / 6 rows / 3 bars 后调用渲染器，
输出放到 `output/probe_v03_stress/`（已 gitignore）。D1–D7 已覆盖同样的断言，是必跑的一部分。

跨机器注意：同机同依赖两次出片逐字节相同；换机器因 `msyh.ttc`/`msyhbd.ttc` 版本差异，
成片 SHA 会不同（与 V0.2 的结论一致，探针帧 SHA 也一样会变）。
