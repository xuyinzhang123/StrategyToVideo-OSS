# -*- coding: utf-8 -*-
"""通用策略回测视频验收（20 项）。

验收对象是 `output/<run>/`：
  - 02_backtest/backtest_result.json
  - 04_video/video.mp4
  - 04_video/render_report.json

原则：不重算策略、不改写结果，只核对三类东西
  1) 结果契约自洽（日期对齐、资产恒等式、成交价格来自行情、持股数守恒）；
  2) 视频报告与结果勾稽（指纹、条数、期末值、规格、字节/SHA）；
  3) 画面确实在推进（中间帧与结尾帧主图非空且不同）。

仍不做字体遮挡、标记坐标这类像素级细验——那是独立任务，不与本脚本混。
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
EPS_PRICE = 0.0002      # 成交价按 4 位小数落盘
EPS_MONEY = 0.02        # 金额/资产按 2 位小数落盘


def ck(name, ok, detail=""):
    checks.append((name, bool(ok), detail))


def grab(ff, video_path, sec, out_path):
    subprocess.run([ff, "-y", "-ss", str(sec), "-i", video_path, "-frames:v", "1", out_path],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


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
    bar_by_date = {b["date"]: b for b in market}
    dates = [b["date"] for b in market]

    # ---------------- 1) 结果契约自洽 ----------------
    ck("结果 schemaVersion=1.0", result.get("schemaVersion") == "1.0", str(result.get("schemaVersion")))
    ck("market 与 equity 日期逐日对齐",
       dates == [e["date"] for e in equity],
       "market={} equity={}".format(len(market), len(equity)))
    ck("market 只覆盖展示区间",
       bool(market) and market[0]["date"] >= rng.get("start", "") and market[-1]["date"] <= rng.get("end", ""),
       "{} ~ {}".format(market[0]["date"] if market else "-", market[-1]["date"] if market else "-"))
    ck("market OHLC 自洽",
       all(b["high"] >= max(b["open"], b["close"], b["low"]) and
           b["low"] <= min(b["open"], b["close"], b["high"]) for b in market))
    ck("trades 日期都在 market 内",
       all(t.get("date") in bar_by_date for t in trades),
       "trades={}".format(len(trades)))
    ck("期末资产与最后一日 equity 一致",
       abs(float(result["metrics"]["final"]) - float(equity[-1]["asset"])) <= EPS_MONEY,
       "{} vs {}".format(result["metrics"]["final"], equity[-1]["asset"]))

    # 成交方向：严格交替、以 BUY 开头（空仓买入 → 次日开盘卖出，不允许加仓）
    sides = [t.get("side") for t in trades]
    alternating = all(s == ("BUY" if i % 2 == 0 else "SELL") for i, s in enumerate(sides))
    ck("成交方向严格交替且以 BUY 开头", alternating and (not sides or sides[0] == "BUY"),
       "sides head={}".format(sides[:6]))

    td = [t.get("date") for t in trades]
    ck("trades 成交日期严格递增", all(a < b for a, b in zip(td, td[1:])),
       "dup/逆序 in {}".format(td[:8]))

    # 成交价必须来自行情。两种口径各自严格断言，不删项、不放宽阈值：
    #   旧 close_buy_open_sell：买入=当日 close（尾盘 14:57）
    #   V0.3 组合模式：信号收盘确认，买入=下一交易日 open（nextOpen）
    # 卖出在两种模式下都是当日 open（9:25 次日开盘口径）。
    composed = bool((result.get("state") or {}).get("compositionMode"))
    buy_field = "open" if composed else "close"
    buy_label = "次开盘 open（组合模式 nextOpen）" if composed else "当日 close（尾盘口径）"
    bad_buy = [(t["date"], t["price"], bar_by_date[t["date"]][buy_field])
               for t in trades if t["side"] == "BUY" and t["date"] in bar_by_date
               and abs(t["price"] - bar_by_date[t["date"]][buy_field]) > EPS_PRICE]
    bad_sell = [(t["date"], t["price"], bar_by_date[t["date"]]["open"])
                for t in trades if t["side"] == "SELL" and t["date"] in bar_by_date
                and abs(t["price"] - bar_by_date[t["date"]]["open"]) > EPS_PRICE]
    ck("买入价 = " + buy_label, not bad_buy, "偏差 {}".format(bad_buy[:3]))
    ck("卖出价 = 当日 open（次日开盘口径）", not bad_sell, "偏差 {}".format(bad_sell[:3]))

    bad_amt = [(t["date"], t["amount"], round(t["price"] * t["shares"], 2))
               for t in trades if abs(t["amount"] - t["price"] * t["shares"]) > EPS_MONEY]
    ck("每笔成交金额 = 价格 x 股数", not bad_amt, "偏差 {}".format(bad_amt[:3]))

    # 逐日持股数必须由 trades 净额解释（含送转的日子按 SHARE_ADJ 标记放行）
    delta = {}
    for t in trades:
        delta[t["date"]] = delta.get(t["date"], 0) + (t["shares"] if t["side"] == "BUY" else -t["shares"])
    running, share_adj_days, shares_bad = 0, 0, []
    for e in equity:
        running += delta.get(e["date"], 0)
        if "SHARE_ADJ" in (e.get("flags") or []):
            share_adj_days += 1
            continue
        if abs(int(e.get("shares", 0)) - running) > 0:
            shares_bad.append((e["date"], e.get("shares"), running))
    ck("逐日持股数由 trades 净额解释", not shares_bad,
       "送转日 {} 个；偏差 {}".format(share_adj_days, shares_bad[:3]))

    bad_asset = [(e["date"], e["asset"], round(e["cash"] + e["holdingValue"] + e.get("divReceivable", 0), 2))
                 for e in equity
                 if abs(e["asset"] - (e["cash"] + e["holdingValue"] + e.get("divReceivable", 0))) > EPS_MONEY]
    ck("资产恒等式 asset = cash + 持仓市值 + 应收股息", not bad_asset, "偏差 {}".format(bad_asset[:3]))

    neg_cash = [(e["date"], e["cash"]) for e in equity if e["cash"] < -0.01]
    ck("现金全程不为负（无透支）", not neg_cash, "透支 {}".format(neg_cash[:3]))

    # ---------------- 2) 报告与结果勾稽 ----------------
    ck("报告 resultSha256 与结果一致",
       report.get("resultSha256") == result.get("reproducibility", {}).get("resultSha256"))
    ck("报告条数/期末值/标识与结果一致",
       report.get("marketBars") == len(market)
       and report.get("trades") == len(trades)
       and abs(float(report.get("final", 0)) - float(result["metrics"]["final"])) <= EPS_MONEY
       and report.get("strategyId") == card.get("id")
       and report.get("symbol") == card.get("symbol"),
       "bars {}/{} trades {}/{}".format(report.get("marketBars"), len(market),
                                        report.get("trades"), len(trades)))
    ck("视频规格 1920x1080@30 / 720 帧 / 24s",
       (report.get("width"), report.get("height"), report.get("fps"), report.get("frames")) == (1920, 1080, 30, 720)
       and abs(float(report.get("durationSec", 0)) - 24.0) <= 0.01)
    with open(video_path, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    ck("视频字节数与 SHA 与报告一致",
       os.path.getsize(video_path) == report.get("bytes") and sha == report.get("sha256"),
       "{} bytes".format(os.path.getsize(video_path)))

    # ---------------- 3) 画面确实在推进 ----------------
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    tmp_mid = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_mid.close()
    tmp_end = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_end.close()
    try:
        grab(ff, video_path, 12, tmp_mid.name)
        grab(ff, video_path, 23.9, tmp_end.name)
        crop = (118, 232, 1180, 628)
        im_mid = Image.open(tmp_mid.name).convert("RGB").crop(crop)
        im_end = Image.open(tmp_end.name).convert("RGB").crop(crop)
        c_mid = len(im_mid.getcolors(maxcolors=10 ** 7) or [])
        c_end = len(im_end.getcolors(maxcolors=10 ** 7) or [])
        ck("中间帧主图非空（颜色数>=12）", c_mid >= 12, "colors={}".format(c_mid))
        ck("结尾帧主图非空且与中间帧不同（画面在推进）",
           c_end >= 12 and im_mid.tobytes() != im_end.tobytes(),
           "colors mid/end={}/{}".format(c_mid, c_end))
    finally:
        for p in (tmp_mid.name, tmp_end.name):
            try:
                os.unlink(p)
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
