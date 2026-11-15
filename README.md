# StrategyToVideo

**把交易策略回测，变成动态视频。**  
*Turn Trading Strategy Backtests into Animated Videos.*

StrategyToVideo 是一个**开源、本地运行**的策略数据视频生成项目：从数据和回测结果出发，自动绘制资金曲线、交易信号与指标面板，并输出 MP4。你可以把它下载到自己的 Windows 电脑，通过**本地网页**操作；计算、渲染和视频保存都在本机完成。

> **English TL;DR:** StrategyToVideo runs entirely on your own Windows machine — it turns a strategy backtest into an animated MP4 through a local web page, with no cloud service and **no external AI API** required at runtime. V0.1 is a runnable reference implementation built on **SIMULATED data**: it ships one fixed MACD demo, does not accept custom market data or custom strategies, and its figures are not real investment returns.

**为什么选择本地运行？** 尽可能减少对云服务和付费 API 的依赖，降低重复制作视频的成本，并让数据、流程和生成结果更容易复现。**V0.1 运行时不需要 AI 模型、外部 AI API 或在线行情 API**；首次安装依赖通常需要联网。本地网页使用的 HTTP API 只在本机提供服务，并非云端网站。

> **当前版本 V0.1：** 一个可下载、可运行的参考实现。它使用**模拟数据**运行一套固定 MACD 策略，对比“MACD 金叉买入、死叉卖出”和“买入后长期持有”，并生成演示视频。**暂不支持用户导入自己的行情或自定义策略。**

## 看看它能生成什么

![StrategyToVideo V0.1 使用模拟数据生成的真实视频画面：资产曲线、买卖事件、MACD 指标与当日快照](assets/preview.png)

*图为 V0.1 实际生成的视频画面，使用 SIMULATED 模拟数据，不是真实证券行情或投资收益。视频采用 1920×1080、30fps，约 52.8 秒；MP4 不随源码包附带，可在本地自行生成。*

## 现在能做什么（V0.1）

- **本地安装、本地网页操作：** 下载 ZIP 或克隆代码，在 Windows 上启动 `http://127.0.0.1:8080/`，无需部署在线服务。
- **回测与对比：** 使用随包提供的可复现模拟数据，运行固定的 MACD(12,26,9) 策略，并与长期持有进行对比。
- **自动生成视频：** 展示资产曲线、金叉/死叉与买卖事件、MACD 指标、当日快照和期末结果。
- **预览与导出：** 在本地网页查看任务进度，预览、下载 MP4；服务重启后可查询已有任务。
- **结果校验：** 自动执行数据与视频的一致性验收，检查金额、信号、日期和画面等关键内容。

这是一套**完整流程演示**，不是已支持任意策略的量化交易平台。当前标的、时间区间、本金和策略参数均为固定配置。

## 下载与本地运行

**系统要求：** Windows、Node.js ≥18、Python ≥3.11。网页不需要额外安装 npm 第三方依赖；Python 依赖见 [`requirements.txt`](requirements.txt)。目前提供的是**源码安装**，不是双击即用的 `.exe` 安装包。

1. 在 GitHub 点击 **Code → Download ZIP**，解压；或使用 `git clone` 下载仓库。
2. 在终端进入解压后的**项目根目录**（包含 `README.md`、`package.json` 和 `requirements.txt`）。
3. 执行：

```powershell
python -m pip install --target deps -r requirements.txt
npm start
```

4. 在浏览器打开 **http://127.0.0.1:8080/**。
5. 选择 **MACD 演示策略（模拟数据）** → **创建任务** → **确认并生成视频**。完成后即可在本地网页预览或下载 MP4。

安装时会从 PyPI 获取 Pillow 和 imageio-ffmpeg；**依赖安装完成后，回测、渲染和视频生成均可离线进行**。渲染器会通过 `imageio_ffmpeg.get_ffmpeg_exe()` 查找编码器，无需手工配置 FFmpeg 的 PATH。建议按上述命令将依赖装入项目内的 `deps/`，否则 `/api/health` 的 `renderEnv.ready` 状态可能显示 `false`。

需要离线安装依赖时，请先自行从 PyPI 下载与 `requirements.txt` 版本一致、且匹配本机 Windows 与 Python 版本的 wheel 文件（Pillow 13.0.0、imageio-ffmpeg 0.8.1），放到项目根目录下自行建立的本地目录（例如 `wheels/`），然后执行：

```powershell
python -m pip install --target deps --no-index --find-links wheels -r requirements.txt
```

`wheels` 请换成你实际存放 wheel 文件的目录名。

模拟数据已经随包提供。若想按固定种子重新生成：

```powershell
node tools/gen_demo_data.cjs
```

## 接下来准备做什么

| 阶段 | 方向 | 状态 |
| --- | --- | --- |
| **V0.1** | 本地网页 + 固定 MACD 回测 + 模拟数据自动出片 | 已发布 |
| **V0.2** | 允许导入自己的 CSV 行情数据，沿用现有模板生成视频 | 计划中 |
| **后续** | 开放策略参数和扩展接口；按需引入 AI 辅助理解、编写策略 | 探索中 |

**长期方向：** 逐步把“运行内置演示策略 → 读取随包数据 → 执行回测 → 生成视频”做成易用、可复现的工作流；**自定义行情与自定义策略属于未来功能，V0.1 尚未支持**。AI 可以在未来帮助理解策略或组织流程，但不应成为每次生成视频都必须调用的收费环节。上述路线图不是已上线功能，也不承诺发布时间。

## 数据说明与当前限制

**SIMULATED 模拟数据声明：** V0.1 的行情、交易日历和现金分红由 [`tools/gen_demo_data.cjs`](tools/gen_demo_data.cjs) 使用固定种子生成，存放在 `output/demo_macd_simulated/01_data/`。它们**不是任何真实证券的历史数据**；视频中的收益、日期、金额及交易信号均不代表真实投资结果，不能用于投资分析或策略评价，也不构成投资建议。

目前**不支持**导入真实或自定义行情、修改或新增策略、自然语言生成策略，以及其他策略模板。V0.1 **只正式支持 Windows**；Linux/macOS 的字体和编码环境尚未完成适配验证。

## 项目如何工作

```text
本地浏览器（127.0.0.1:8080）
  → 创建任务、人工确认执行
  → 本地任务管理与策略适配器
  → MACD 回测（Node.js）
  → 视频逐帧渲染与编码（Python / FFmpeg）
  → 独立一致性验收
  → 本地预览与 MP4 下载
```

这里的任务编排是确定性代码，**不是运行中的 AI Agent**。本地 HTTP 接口（如 `/api/tasks`）可供二次开发使用，但 V0.1 不调用外部 AI 或行情服务。

- **数据示例：** `output/demo_macd_simulated/01_data/`
- **回测、渲染与验收：** `engine_next/`
- **本地网页：** `web/`
- **模拟数据生成器：** `tools/gen_demo_data.cjs`
- **任务产物：** `output/web_<taskId>/`；任务状态与视频副本：`web/tasks/<taskId>/`

网页生成视频时会自动调用独立验收脚本；也可以对已完成任务手动复核：

```powershell
python engine_next/tests/accept_macd_video_v122.py --run web_<taskId> --source web_<taskId>
```

校验包括回测金额与视频结果、交易信号与成交、T+1 执行日期、时间轴、抽样帧对账及画面布局等。项目目前未随包提供 `node --test` 测试套件；上述脚本是 V0.1 的独立验收入口。

## 开源许可与第三方组件

项目主体代码采用 **MIT License**，见 [`LICENSE`](LICENSE)。第三方依赖与许可说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)：Pillow 13.0.0（MIT-CMU）、imageio-ffmpeg 0.8.1（BSD-2-Clause），以及由其 wheel 提供的 **GPLv3 构建的 FFmpeg**。

仓库不随附 FFmpeg 二进制、wheel 或字体。用户通过 pip 安装第三方程序**不会改变其自身许可证**；如将相关二进制重新打包分发，应自行核查和遵守对应许可义务。上述说明不构成法律意见。
