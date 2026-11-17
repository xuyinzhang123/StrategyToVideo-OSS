# V0.3 阶段 0 · 竖版「数据解剖」渲染链 spike

这是一个**一次性验证件**，不是产品功能，也不在任何发布节奏里。目的是用最小代价回答一个问题：

> 把一份已经算好的数字（`report.json`），渲染成 1080×1920 竖版「一屏一个数字」的数据解剖片，
> 这条链能不能跑通、能不能被验收、会不会碰到股票回测的出片路径。

结论是可以，且没有碰到（证据见 `ACCEPTANCE.md`）。指标层（怎么从原始数据算出这些数字）
**刻意没有做**——等看完片再定。

## 目录

| 文件 | 作用 |
|---|---|
| `engine_next/render_story_v030.py` | 竖版渲染器（新增文件，约 900 行，Pillow + imageio-ffmpeg） |
| `spike/v03/report.simulated.json` | 纯合成数据的 fixture，用于自检与回归基线 |
| `spike/v03/storyboard.simulated.md` | 由 report 自动生成的分镜表（不手写） |
| `spike/v03/accept_story_v030.py` | 31 项独立验收（结构 8 / 编码 8 / 版式 8 / 容量 7） |
| `spike/v03/ACCEPTANCE.md` | 验收记录：跑分、回归证据、与参考样片的差异清单 |

## 怎么跑

```bash
python engine_next/render_story_v030.py \
  --report spike/v03/report.simulated.json \
  --out output/v03_story/simulated \
  --storyboard spike/v03/storyboard.simulated.md \
  --keyframes output/v03_story/simulated/keyframes

python spike/v03/accept_story_v030.py \
  --report spike/v03/report.simulated.json \
  --render-dir output/v03_story/simulated
```

输出：`video.mp4`（20s / 600 帧）、`render_report.json`（帧数、探针帧 SHA、成片 SHA）、
`keyframes/`（每屏 88% 处一张 PNG）、`ffmpeg.log`。

## 版式词汇

覆盖参考样片的全部 10 种，一一对应：

`hook_number` 巨数字钩子 · `dual_metrics` 双指标 · `dot_matrix` 比例点阵 ·
`dense_grid` 密格孤点 · `bar_scale` 比例条 · `split_bar` 分段条 ·
`progress_sliver` 进度细条 · `decay_bars` 衰退柱 · `row_list` 行列表 · `outro` 收尾

## 三条硬边界（本轮已遵守，后续也必须遵守）

1. **不碰既有出片链**。`render_stock_macd_v122.py`、`render_stock_macd_v123.py`、
   `render_generic_chart.py`、`backtest_stock_macd.cjs`、`web/`、`tools/`、`docs/`
   相对 `main` 零改动（`git diff --stat` 为空）。
2. **画幅与编码是本文件私有常量**。`W/H/FPS/ENC` 不抽成公共默认值，
   改这里不会改变股票回测片或通用图表片的输出。
3. **不加依赖**。只用 `deps/` 里的 Pillow 13.0.0 与 imageio-ffmpeg 0.8.1，不联网。

## 数据诚实性约定

- 每一屏页脚必须带数据来源（`meta.provenance.footer`），验收项 A8 强制检查。
- 比例类图形（点阵亮格数、条长、细条宽度）**由数字算出**，不接受手工像素位置；
  验收 B1–B7 逐项复算。
- 数字滚动（count-up）可用 `meta.motion.countUp=false` 关掉——开启时中间帧会短暂
  显示非终值。需要「任意一帧都能截图当证据」的场合请关掉。

## 已知限制（阶段 0 有意不做）

- 没有指标层：数字全部是手写常量，不来自任何计算。
- 没有接入 web：`server.js` / `app.js` 一行未改，只能命令行跑。
- 没有音频、没有转场、没有背景音乐；只有入场淡入、数字滚动、图形生长。
- 中文字体用 `msyhbd.ttc`，比参考样片的窄体重黑偏宽矮，同一个数字占不满宽度。
- 第三方口述数据的对照 report 未入库（见 `ACCEPTANCE.md` 第 4 节说明）。
