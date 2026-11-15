# Third-party notices · 第三方组件与许可证说明

本包主体代码采用 **MIT**（见 `LICENSE`）。V0.1 **不随包附带任何第三方二进制、wheel 或字体文件**；
运行时依赖由使用者按 `requirements.txt` 自行安装。

> **重要**：安装方式**不改变**任何组件的许可证。把 FFmpeg 二进制从「随包附带」改为
> 「使用者 pip 安装」，只改变了**本包是否再分发该二进制**，不改变该二进制本身是 GPLv3
> 构建这一事实，也不免除该二进制发行方或使用者的相应许可义务。
> 本包以命令行方式调用 FFmpeg 可执行文件，未修改其源码、未链接其程序库。

## 1. 运行时依赖（由使用者安装，不随本包分发）

| 组件 | 固定版本 | 用途 | 许可证 | Python 要求 |
| --- | --- | --- | --- | --- |
| Pillow (PIL) | 13.0.0 | 视频逐帧绘图、字体渲染 | **MIT-CMU**（随 wheel 的 `LICENSE` 全文；PyPI METADATA 为 `License-Expression: MIT-CMU`） | ≥ 3.11 |
| imageio-ffmpeg | 0.8.1 | 定位 FFmpeg 可执行文件 | **BSD 2-Clause**（随 wheel 的 `LICENSE` 全文；METADATA 为 `License: BSD-2-Clause`） | ≥ 3.10 |
| FFmpeg 可执行程序 | 由 imageio-ffmpeg wheel 提供 | MP4 编码（libx264）、静音音轨、验收时的音轨检测 | **GPL-3.0-or-later** | — |

固定版本见 `requirements.txt`。安装后各组件自带的 `LICENSE` 全文位于 wheel 安装目录内，
使用者可在安装完成后自行查阅。

### FFmpeg 许可证更正说明

`imageio-ffmpeg==0.8.1` 的 Windows wheel 内嵌的是
`ffmpeg 9.0.2-essentials_build-www.gyan.dev`（gyan.dev 构建），其 `-version` 输出明确包含
`--enable-gpl --enable-version3`，并启用 `--enable-libx264`、`--enable-libx265`：

- 该二进制是 **GPLv3（或更高版本）** 构建，**不是 LGPL-2.1**。
- 上一版说明将 `imageio-ffmpeg`（Python 包，BSD 2-Clause）与其内嵌的 FFmpeg 二进制
  （GPLv3）混为一谈，标注为 LGPL-2.1，属于错误，现已更正。
- 本包**不再分发**该二进制，因此本包自身不包含 GPL 组件副本，也不涉及随附 GPL
  全文或源码要约的义务；该二进制由使用者从 PyPI 安装时取得，相关分发义务由
  该 wheel 的发行方承担。
- 若第三方将本包与该 FFmpeg 二进制**一并打包再分发**，需自行评估并履行 GPLv3 义务。
- 本说明为事实性记录，不构成法律意见；正式公开发布前请自行复核所用构建许可条款。

## 2. 运行时引用但不随包分发

| 组件 | 说明 |
| --- | --- |
| Node.js ≥ 18 | 仅使用 Node 内置模块（`http` / `fs` / `path` / `child_process` / `crypto`），**无 npm 第三方依赖** |
| Python ≥ 3.11 | 使用者本机系统 Python 及标准库 |
| Windows 中文字体 | `engine_next/config.stock_macd_video_v122.json` 的 `video.fonts` 以**文件名**（`msyh.ttc` / `msyhbd.ttc` / `simhei.ttf`）引用 Windows 系统自带的微软雅黑与黑体，**不随本包分发**，也不复制字体文件。V0.1 只正式支持 Windows；其它平台需自备中文字体并修改该配置 |

## 3. 示例数据

`output/demo_macd_simulated/01_data/` 下的行情、交易日历与分红数据由本包
`tools/gen_demo_data.cjs` 用固定种子确定性合成，属于本包自产内容（MIT），
**不含任何第三方行情数据、公告文本或接口响应**，也不代表任何真实证券的历史行情。

## 4. 输出产物

使用者生成的 MP4 由本包渲染器逐帧绘制后编码产出，画面素材全部由代码绘制，
不含第三方图片、音频、字体文件或视频片段。
