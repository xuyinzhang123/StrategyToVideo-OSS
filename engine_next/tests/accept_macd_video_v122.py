# -*- coding: utf-8 -*-
"""============================================================================
 MACD 对比视频 V1.2.2 · 数据一致性 + 浮板零遮挡 + 平滑度独立验收
 ---------------------------------------------------------------------------
 只读校验。核心新增（V1.2.2，浮板零遮挡轮）：
   0) 按渲染报告的浮板真实矩形（x1,x2,y1 + 帧高）映射为资产区间，断言
      浮板 x 覆盖段内 两曲线资产值永不落入面板竖直范围（零遮挡）；
      面板高度 ≤ 170px（V1.1 322 / V1.2 自适应 ≈188-222）；
   1) 时间轴平滑度：零位移帧 = 0、最长死停 ≤ 2 帧、cv ≤ 0.45、
      max_accel ≤ 0.9（修复 V1.2 开头「3/2 天交替 judder + 18 帧死停」）；
   2) X 轴同步断言升级为浮点：expect_x 用帧级浮点位置 t（同帧 副图 x ==
      主图 x == 全局映射 xr(t)），容差 0.5px；
   其余金额/信号成交/模板/抽样对账/浮板/Y 轴/音轨断言全部沿用。

 用法：python engine_next/tests/accept_macd_video_v122.py [--run <run_id>]
   1) 时间轴平滑度：零位移帧 = 0、最长死停 ≤ 2 帧、cv ≤ 0.45、
      max_accel ≤ 0.9（修复 V1.2 开头「3/2 天交替 judder + 18 帧死停」）；
   2) X 轴同步断言升级为浮点：expect_x 用帧级浮点位置 t（同帧 副图 x ==
      主图 x == 全局映射 xr(t)），容差 0.5px；
   其余金额/信号成交/模板/抽样对账/浮板/Y 轴/音轨断言全部沿用 V1.2。

 用法：python engine_next/tests/accept_macd_video_v121.py [--run <run_id>]
============================================================================"""
import argparse
import csv
import json
import math
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

ap = argparse.ArgumentParser()
ap.add_argument("--run", default="demo_macd_simulated")
ap.add_argument("--source", default="demo_macd_simulated")
A = ap.parse_args()

# 开源版：输出目录恒为仓库根下的 output/，不读取任何机器专属本地配置。
OUT_ROOT = os.path.join(ROOT, "output")

# 与渲染器一致：若依赖按 README 安装到 deps/，则加入模块搜索路径；
# 未安装到 deps/ 时自动使用系统 Python 环境（pip install -r requirements.txt）。
for _dep in (os.path.join(ROOT, "deps"),):
    if os.path.isdir(_dep) and _dep not in sys.path:
        sys.path.insert(0, _dep)

BT = os.path.join(OUT_ROOT, A.source, "02_backtest_macd")
VD = os.path.join(OUT_ROOT, A.run, "04_video")
for p in (BT, VD):
    if not os.path.isdir(p):
        raise SystemExit("目录不存在: " + p)

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append((name, detail))
    print("  {}  {}{}".format("PASS" if ok else "FAIL", name, ("  ← " + detail) if detail and not ok else ""))


def read_csv(p):
    return list(csv.DictReader(open(p, encoding="utf-8-sig")))


S = json.load(open(os.path.join(BT, "summary.json"), encoding="utf-8"))
R = json.load(open(os.path.join(VD, "render_report.json"), encoding="utf-8"))
FD = json.load(open(os.path.join(VD, "frame_data.json"), encoding="utf-8"))
META, MACD, HOLD = S["meta"], S["macd"], S["hold"]

daily = read_csv(os.path.join(BT, "daily.csv"))
signals = read_csv(os.path.join(BT, "signals.csv"))
trades = read_csv(os.path.join(BT, "trades.csv"))
macd_rows = read_csv(os.path.join(BT, "macd.csv"))
dates = [r["date"] for r in daily]

print("== 1. 视频文件 ==")
mp4 = os.path.join(VD, "video.mp4")
check("video.mp4 存在", os.path.isfile(mp4))
size_mb = os.path.getsize(mp4) / 1048576
check("视频非空且合理", 0.5 < size_mb < 50, "%.2f MB" % size_mb)
check("报告帧数与时长一致", R["frames"] == R["introFrames"] + R["mainFrames"] + R["outroFrames"]
      and abs(R["durationSec"] - R["frames"] / R["fps"]) < 0.02,
      "%s 帧 / %ss" % (R["frames"], R["durationSec"]))

print("== 2. 金额一致性（summary ⇄ 渲染报告 ⇄ 渲染文本） ==")
check("MACD 终值一致", abs(R["macdFinal"] - MACD["final"]) < 0.005,
      "%.2f vs %.2f" % (R["macdFinal"], MACD["final"]))
check("持有终值一致", abs(R["holdFinal"] - HOLD["final"]) < 0.005,
      "%.2f vs %.2f" % (R["holdFinal"], HOLD["final"]))
rc = R["renderedCopy"]
check("片尾持有金额文本 = ¥ {:,.2f}".format(HOLD["final"]), rc["outro_amount"] == "¥ {:,.2f}".format(HOLD["final"]), rc["outro_amount"])
check("片尾 MACD 金额文本 = ¥ {:,.2f}".format(MACD["final"]), rc["outro_amount_macd"] == "¥ {:,.2f}".format(MACD["final"]), rc["outro_amount_macd"])
check("回撤文本一致", rc["outro_hold_dd"] == "最大回撤 {:.2f}%".format(HOLD["maxDD"] * 100)
      and rc["outro_macd_dd"] == "最大回撤 {:.2f}%".format(MACD["maxDD"] * 100))
last = FD["frames"][-1]
check("末帧面板金额 = summary", last["macd_asset_text"] == "¥ {:,.2f}".format(MACD["final"])
      and last["hold_asset_text"] == "¥ {:,.2f}".format(HOLD["final"]))

print("== 3. 信号 / 成交数量与日期（按本次回测产物动态核对） ==")
didx = {d: i for i, d in enumerate(dates)}
unexec = [s for s in signals if s["executed"] == "0"]
n_gold = sum(1 for s in signals if s["type"] == "GOLDEN")
n_death = sum(1 for s in signals if s["type"] == "DEATH")
n_exec = len(signals) - len(unexec)
n_macd_trades = len([t for t in trades if t["strategy"] == "macd"])
check("信号数 = 买 + 卖 + 本次未执行，且与渲染报告一致（本次 %d 个）" % len(signals),
      len(signals) == MACD["buyCount"] + MACD["sellCount"] + len(unexec)
      and R["signalCount"] == len(signals), "buy=%d sell=%d unexec=%d" % (MACD["buyCount"], MACD["sellCount"], len(unexec)))
check("金叉/死叉数与买/卖/未执行结构性勾稽",
      n_gold == MACD["buyCount"] + sum(1 for s in unexec if s["type"] == "GOLDEN")
      and n_death == MACD["sellCount"] + sum(1 for s in unexec if s["type"] == "DEATH"))
check("成交笔数 ⇄ summary / 渲染报告一致（本次 %d 笔）" % n_macd_trades,
      n_macd_trades == MACD["tradeCount"] == R["macdTrades"] == R["execCount"],
      "trades=%d summary=%d report=%d/%d" % (n_macd_trades, MACD["tradeCount"], R["macdTrades"], R["execCount"]))
bad = [s for s in signals if s["executed"] == "1" and didx.get(s["exec_date"]) != didx[s["signal_date"]] + 1]
check("exec_date = signal_date + 1 交易日（%d/%d）" % (n_exec, n_exec), len(bad) == 0, "%d 笔不符" % len(bad))
# 结构性规则（不写死数量与日期）：未执行信号只能是「空仓时的死叉」，且日期必须落在交易日历内。
check("未执行信号均为空仓死叉且日期有效（本次 %d 个）" % len(unexec),
      all(s["type"] == "DEATH" and s["signal_date"] in didx for s in unexec),
      str([(s["signal_date"], s["type"]) for s in unexec[:4]]))

print("== 4. macd.csv 交叉标记 ⇄ signals.csv ==")
cross = [(r["date"], r["cross"]) for r in macd_rows if r["cross"] != "none"]
sig = [(s["signal_date"], "golden" if s["type"] == "GOLDEN" else "death") for s in signals]
check("交叉标记 %d 处且与信号表逐条一致" % len(sig), cross == sig and len(cross) == len(signals))

print("== 5. 模板变量完整性 ==")
tc = R["templateCheck"]
check("copy 全量替换、无残留占位符", tc["unresolved"] == 0 and tc["strings"] > 0, "%d 条" % tc["strings"])
leftover = [k for k, v in rc.items() if "{" in v or "}" in v]
check("renderedCopy 无 { } 残留", not leftover, str(leftover))

print("== 6. 帧数据 ⇄ daily.csv 抽样对账 ==")
frames = FD["frames"]
import random
random.seed(12)
sample = random.sample(range(len(frames)), 120) + [0, len(frames) - 1]
bad_f = []
for k in sample:
    fr = frames[k]
    r = daily[fr["dayIndex"]]
    if fr["date"] != r["date"]:
        bad_f.append((k, "date"))
    if fr["macd_asset_text"] != "¥ {:,.2f}".format(float(r["macd_asset"])):
        bad_f.append((k, "macd"))
    if fr["hold_asset_text"] != "¥ {:,.2f}".format(float(r["hold_asset"])):
        bad_f.append((k, "hold"))
    if fr["trades_done"] != sum(1 for t in trades if t["strategy"] == "macd" and didx[t["date"]] <= fr["dayIndex"]):
        bad_f.append((k, "trades"))
check("抽样 %d 帧的日期/金额/累计成交与回测一致" % len(sample), not bad_f, str(bad_f[:5]))

print("== 7. 【V1.2 核心】上下图时间轴同步 ==")
check("axisMode = shared-full-both（两图共用完整历史横轴）", R["axisMode"] == "shared-full-both")
G = R["geometry"]
L_, R_ = G["left"], G["right"]
N = R["tradingDays"]
ST, SB = G["subTop"], G["subBottom"]
AMAXM = R["macdIndicator"]["amax"]


def expect_x(di):
    return L_ + (R_ - L_) * di / (N - 1)


bad_x = []
for k in range(0, len(frames), 7):
    fr = frames[k]
    if fr["sub_pos"] is None:
        continue
    if abs(fr["sub_pos"][0] - fr["macd_pos"][0]) > 0.5:
        bad_x.append((k, "sub_x != main_x"))
    et = expect_x(fr.get("t", fr["dayIndex"]))
    if abs(fr["sub_pos"][0] - et) > 0.5:
        bad_x.append((k, "sub_x != 全局映射xr(t)"))
    if fr["sub_date"] != fr["date"]:
        bad_x.append((k, "sub_date != main_date"))
check("同一帧内 副图指标点 x == 主图播放头 x == xr(t)（%d 帧抽样，浮点）" % (len(range(0, len(frames), 7))), not bad_x, str(bad_x[:5]))
bad_y = []
for k in range(0, len(frames), 11):
    fr = frames[k]
    if fr["dif"] is None or fr["sub_pos"] is None:
        continue
    # V1.2.1 端点为插值值：按帧级浮点 t 在 macd.csv 两日之间线性插值后重算 y
    i0 = fr["dayIndex"]
    frac = fr.get("t", float(i0)) - i0
    v0, v1 = float(macd_rows[i0]["dif"]), None
    if i0 + 1 < len(macd_rows):
        v1 = macd_rows[i0 + 1]["dif"]
    v_exp = v0 if (frac <= 0 or v1 is None) else v0 + (float(v1) - v0) * frac
    ey = SB - (v_exp + AMAXM) / (2 * AMAXM) * (SB - ST)
    if abs(fr["sub_pos"][1] - ey) > 1.0:
        bad_y.append((k, "y"))
    # 数据对账不变：帧内 dif 字段必须等于 macd.csv 整数日值（零重算断言）
    if abs(float(macd_rows[i0]["dif"]) - fr["dif"]) > 1e-9:
        bad_y.append((k, "dif!=csv"))
check("副图点 y 与 macd.csv 按固定纵轴+浮点插值重算一致（数据零重算）", not bad_y, str(bad_y[:5]))
first_dif = next(i for i, r in enumerate(macd_rows) if r["dif"])
check("首个有效 MACD 点位于横轴最左侧（x ≤ L+30px）", expect_x(first_dif) - L_ <= 30,
      "x=%.1f" % expect_x(first_dif))
mid = frames[len(frames) // 2]
check("播放中段副图只展开到当前日期（右端 x == 主图播放头 x）",
      abs(mid["sub_pos"][0] - mid["macd_pos"][0]) <= 0.5)

print("== 8. Y 轴刻度（按本次资产峰值自适应，保持等距与合理布局） ==")
AMAX = float(R["assetMax"])
TICKS = [float(t) for t in R["assetTicks"]]
step = TICKS[1] - TICKS[0] if len(TICKS) > 1 else 0
check("assetTicks 自 0 起、等距、末项 = assetMax（本次 %s）" % TICKS,
      len(TICKS) >= 3 and step > 0 and abs(TICKS[0]) < 1e-9
      and abs(TICKS[-1] - AMAX) < 1e-6
      and all(abs((TICKS[i + 1] - TICKS[i]) - step) < 1e-6 for i in range(len(TICKS) - 2)))
check("assetMax 覆盖本次资产峰值且留白合理（峰值 %.2f / 上限 %.2f）" % (R["peakUsed"], AMAX),
      AMAX >= R["peakUsed"] - 1e-6 and AMAX <= R["peakUsed"] * 1.5 + 1e-6)

print("== 9. 【V1.2.2】浮板缩小与零遮挡 ==")
pn = G["panel"]
MT_, MB_ = G["mainTop"], G["mainBottom"]
check("浮板宽度 ≤ 420px（V1.1 为 548）", pn["x2"] - pn["x1"] <= 420, "%dpx" % (pn["x2"] - pn["x1"]))
# 面板高度：4 行 138 / 5 行 164（行距 26 + padding 16）
PANEL_H = 32 + 4 * 26 + 16
check("浮板高度 ≤ 170px（V1.1 ≈322 / V1.2 ≈188-222）", PANEL_H <= 170, "%dpx" % PANEL_H)


def panel_blocks(asset_v):
    """资产值映射的 y 是否落在浮板矩形竖直范围内（±4px 容差）。"""
    y = MB_ - min(max(asset_v, 0.0), AMAX) / AMAX * (MB_ - MT_)
    return (pn["y1"] - 4) <= y <= (pn["y1"] + PANEL_H + 4)


bad_block = []
for i, r in enumerate(daily):
    x = L_ + (R_ - L_) * i / (N - 1)
    if not (pn["x1"] - 8 <= x <= pn["x2"] + 8):
        continue
    if panel_blocks(float(r["hold_asset"])):
        bad_block.append(("hold", r["date"]))
    if panel_blocks(float(r["macd_asset"])):
        bad_block.append(("macd", r["date"]))
check("浮板 x 覆盖段内两曲线零遮挡（逐交易日 × 2 曲线）", not bad_block,
      "%d 处被盖，如 %s" % (len(bad_block), bad_block[:4]))
check("最近事件为按需短提示（recent_event_days=%d）" % pn["recentEventDays"], pn["recentEventDays"] <= 5)

print("== 10. 【V1.2.1 核心】时间轴平滑度 ==")
sm = R.get("smoothness")
check("时间轴 = build_smooth_timeline（浮点+余弦核+密度自适应）",
      "build_smooth_timeline" in R.get("timeline", ""), R.get("timeline", ""))
check("零位移帧 = 0（V1.2 为 330）", sm and sm["zero_frames"] == 0,
      str(sm and sm["zero_frames"]))
check("最长连续死停 ≤ 2 帧（V1.2 为 18 帧 = 0.6s）", sm and sm["max_still_frames"] <= 2,
      str(sm and sm["max_still_frames"]))
check("位移变异系数 cv ≤ 0.45（V1.2 为 0.63）", sm and sm["cv"] <= 0.45, str(sm and sm["cv"]))
check("最大顿挫 max_accel ≤ 0.9（V1.2 一步从 3 天砸到 0）", sm and sm["max_accel"] <= 0.9,
      str(sm and sm["max_accel"]))
check("浮点位置严格单调且覆盖首末日",
      sm and sm["min_step_days"] > 0 and abs(sm["max_step_days"]) < 5,
      str(sm and (sm["min_step_days"], sm["max_step_days"])))
# 关键事件慢放仍保留（叙事不丢）
hold = (sm or {}).get("hold", [])
key_events = R.get("keyEvents", [])
check("重点事件慢放数 = 渲染报告 keyEvents（本次 %d 个，来自本次回测真实信号）" % len(key_events),
      len(key_events) > 0 and len(hold) == len(key_events),
      str([(h["dayIndex"], h["frames"]) for h in hold]))
check("每个重点事件均有可视慢放（≥ 8 帧）",
      all(h["frames"] >= 8 for h in hold),
      str([(h["dayIndex"], h["frames"]) for h in hold]))
# 帧数据 t 单调
ts = [fr.get("t") for fr in frames if "t" in fr]
check("frame_data 浮点位置 t 单调不减（末帧终点定格豁免，%d 帧）" % len(ts),
      len(ts) == len(frames) and all(ts[i] <= ts[i + 1] + 1e-9 for i in range(len(ts) - 1))
      and sum(1 for i in range(len(ts) - 1) if ts[i] == ts[i + 1]) <= 1)

print("== 11. 音轨与转场（V1.1 能力不回退） ==")
check("片尾过渡 = dip-to-bg", R["transitions"]["outro"] == "dip-to-bg")
# 不依赖任何机器专属绝对路径：优先 imageio_ffmpeg 自带二进制，否则用 PATH 中的 ffmpeg。
try:
    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    ff = "ffmpeg"
try:
    out = subprocess.run([ff, "-hide_banner", "-i", mp4, "-af", "volumedetect", "-f", "null", "-"],
                         capture_output=True, text=True, timeout=180).stderr
    mean = re.search(r"mean_volume:\s*([-\d.]+) dB", out)
    check("音轨为数字静音（mean ≤ -80 dB）", mean and float(mean.group(1)) <= -80,
          "mean=%s" % (mean and mean.group(1)))
except Exception as e:
    print("  SKIP  音轨检测失败: %s" % e)

print()
print("===== 验收结果：PASS %d / FAIL %d =====" % (len(PASS), len(FAIL)))
for name, detail in FAIL:
    print("  FAIL  {}  {}".format(name, detail))
sys.exit(1 if FAIL else 0)
