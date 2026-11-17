# -*- coding: utf-8 -*-
"""通用策略回测视频验收（首版，10 项）。

验收对象是 `output/<run>/`：
  - 02_backtest/backtest_result.json
  - 04_video/video.mp4
  - 04_video/render_report.json

原则：不重算回测，只核对「结果契约自洽 + 视频报告勾稽 + 画面非空」。
像素级细验（标记坐标、字体遮挡）暂不做；那是后续独立验收任务。
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
for cand in (os.path.join(ROOT, "deps"),):
    if os.path.isdir(cand) and cand not in sys.path:
        sys.path.insert(0, cand)

from PIL import Image  # noqa: E402
import imageio_ffmpeg  # noqa: E402

checks = []


def ck(name, ok, detail=""):
    checks.append((name, bool(ok), detail))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="", help="output/<run> 目录名")
    ap.add_argument("--dir", default="", help="直接指定 output/<run> 绝对/相对路径")
    args = ap.parse_args()

    run_dir = args.dir or (os.path.join(ROOT, "output", args.run) if args.run else "")
    if not run_dir or not os.path.isdir(run_dir):
        print("E_ARGS: 需要 --run 或 --dir 指向存在的 output/<run> 目录", file=sys.stderr)
        return 2

    result_path = os.path.join(run_dir, "02_backtest", "backtest_result.json")
    video_dir = os.path.join(run_dir, "04_video")
    video_path = os.path.join(video_dir, "video.mp4")
    report_path = os.path.join(video_dir, "render_report.json")
    for p in (result_path, video_path, report_path):
        if not os.path.isfile(p):
            print("E_MISSING: {}".format(p), file=sys.stderr)
            return 2

    result = json.load(open(result_path, encoding="utf-8"))
    report = json.load(open(report_path, encoding="utf-8"))
    market = result.get("market") or []
    equity = result.get("equity") or []
    trades = result.get("trades") or []
    card = result.get("strategy") or {}
    rng = card.get("range") or {}

    ck("结果 schemaVersion=1.0", result.get("schemaVersion") == "1.0", str(result.get("schemaVersion")))
    ck("market 与 equity 日期逐日对齐",
       [b["date"] for b in market] == [e["date"] for e in equity],
       "market={} equity={}".format(len(market), len(equity)))
    ck("market 只覆盖展示区间",
       bool(market) and market[0]["date"] >= rng.get("start", "") and market[-1]["date"] <= rng.get("end", ""),
       "{} ~ {}".format(market[0]["date"] if market else "-", market[-1]["date"] if market else "-"))
    ck("market OHLC 自洽",
       all(b["high"] >= max(b["open"], b["close"], b["low"]) and
           b["low"] <= min(b["open"], b["close"], b["high"]) for b in market))
    ck("trades 日期都在 market 内",
       all(t.get("date") in {b["date"] for b in market} for t in trades),
       "trades={}".format(len(trades)))
    ck("期末资产与最后一日 equity 一致",
       abs(float(result["metrics"]["final"]) - float(equity[-1]["asset"])) <= 0.01,
       "{} vs {}".format(result["metrics"]["final"], equity[-1]["asset"]))
    ck("报告 resultSha256 与结果一致",
       report.get("resultSha256") == result.get("reproducibility", {}).get("resultSha256"))
    ck("视频规格 1920x1080@30 / 720 帧 / 24s",
       (report.get("width"), report.get("height"), report.get("fps"), report.get("frames")) == (1920, 1080, 30, 720)
       and abs(float(report.get("durationSec", 0)) - 24.0) <= 0.01)
    with open(video_path, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    ck("视频字节数与 SHA 与报告一致",
       os.path.getsize(video_path) == report.get("bytes") and sha == report.get("sha256"),
       "{} bytes".format(os.path.getsize(video_path)))

    # 抽中间帧，检查主图区域确实有内容（不是纯色/空白）
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp.close()
    try:
        subprocess.run([ff, "-y", "-ss", "12", "-i", video_path, "-frames:v", "1", tmp.name],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        im = Image.open(tmp.name).convert("RGB").crop((118, 232, 1180, 628))
        colors = im.getcolors(maxcolors=10 ** 7) or []
        ck("中间帧主图非空（颜色数≥12）", len(colors) >= 12, "colors={}".format(len(colors)))
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    passed = sum(1 for _, ok, _ in checks if ok)
    for name, ok, detail in checks:
        print("[{}] {}".format("PASS" if ok else "FAIL", name) +
              ("  <- {}".format(detail) if detail and not ok else ""))
    print("\n策略视频验收：{}/{} 通过".format(passed, len(checks)))
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
