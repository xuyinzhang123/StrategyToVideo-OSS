# -*- coding: utf-8 -*-
"""============================================================================
 第三阶段 · MACD 策略视频渲染器（V1.2.3 · 用户 CSV / USER_IMPORT 档）
 ---------------------------------------------------------------------------
 主题：用户导入的股票日线 CSV · 长期持有 vs MACD 金叉死叉
 视觉基准：与 V1.2.2 完全一致的深色仪表盘（左浮板 / 两条资金曲线 / MACD 副图 /
           金叉死叉与买卖标记），只改「短样本下的布局自适应」。

 V1.2.3 相对 V1.2.2 的改动（只动布局与时间轴，回测 / 事件 / 文案 token 零改动）：
   0) 【时间轴】build_smooth_timeline 的成本域改到「日区间」上（见 video_events.py）：
      n_days 个交易日只有 n_days-1 个区间，旧实现多算一个幻影区间，尾部被钳成
      零位移帧（260 日样本 4 帧、34 日边界 46 帧）。修复后各长度零位移帧均为 0。
   1) 【浮板定位】由「固定 MT+24」改为按本次数据自适应：
      取浮板水平覆盖段内两条曲线的 y 上下界，若曲线之上放得下（含 8px 间隙），
      放上方（V1.2.2 的既有位置）；否则放到曲线之下（下方留白区）。
      判据只用本次资产轨迹与画布几何，不放大资产 Y 轴范围，也不缩小面板字号。
      两条曲线在该段内同时占满上下、两种位置都放不下时，落到 forced-top 并在
      render_report.geometry.panel.anchor 中如实标注，由验收脚本判失败（不静默）。
   2) 【报告】geometry.panel 增加 height（最高形态，含「最近事件」行）与 anchor，
      供验收脚本按真实矩形判定遮挡，而不是写死 152px。

 V0.1 的 SIMULATED 演示仍走 render_stock_macd_v122.py（未改动），本文件只服务于
 用户导入数据；两个渲染器共享 video_events.py 的回测产物与文案 token 表。

 ---------------------------------------------------------------------------
 V1.2.2 基线说明（以下能力全部保留）
 ---------------------------------------------------------------------------
 主题：SIMULATED 模拟演示数据 · 长期持有 vs MACD 金叉死叉（Open Source V0.1）
 视觉基准：深色仪表盘体系；示例数据为确定性合成，不代表任何真实历史行情
 实现：render_stock_macd_v12.py（V1.2，本版本独立演进，不覆盖 V1 / V1.1 / V1.2）

 V1.2.1 相对 V1.2 的改动（只动时间轴与绘制精度，回测与事件逻辑零改动）：
   0) 【核心】修复「开头几秒卡顿不顺畅」——
      V1.2 的时间轴是 build_warp_timeline 的 int 位置。1320 帧要走 2633 个交易日，
      普通区每帧必须跨 2~3 天，int(round()) 让步长在 3/2 之间交替（judder：
      曲线一跳一跳）；慢放区又被四舍五入成十几帧完全相同的值（死停，实测
      最长 18 帧 = 0.60s）；出慢放区速度从 0 瞬间回到 3 天/帧（顿挫）。
      三个关键事件（dayIndex 54/90/118）恰好挤在开头 4 个月，叠出这段卡顿。
      V1.2.1 改用 build_smooth_timeline：
        · 浮点位置 → 每帧位移连续，零位移帧 331→0、最长死停 18→0；
        · 余弦核 (1+cos)/2 → 进出慢放区速度连续，不再有折角；
        · 重叠慢放区按重叠量等比降峰 → 密集事件不再叠成死停。
      绘制侧配合：曲线 trail 仍按整数日累积，render_frame 在副本上补最后一小段
      亚像素插值，末端圆点与播放头用同一个 xr(p) —— 两图 X 轴依旧严格同步。

 V1.2 相对 V1.1 的改动（全部在表现层）：
   1) 【核心】上下两图共用完整历史时间轴：MACD 副图弃用 120 日滚动窗口，
      改用与主图完全相同的全局时间索引 xr() —— 同一交易日在上图的横向相对
      位置与下图严格一致；DIF/DEA/柱从左侧随播放逐步展开，主图推进到哪年
      副图就只到哪年；慢放由同一条时间轴驱动，两图共同减速。
   2) 副图可读性（不改指标数值）：2633 日的柱状图按像素列做 min/max 包络
      聚合（红正/绿负，45% 弱化），DIF/DEA 线宽 2；金叉死叉在真实交叉坐标
      高亮。指标数值仍逐日直读 macd.csv，零重算。
   3) 左浮板缩小：宽度 548→414px，高度按内容自适应；「最近事件」改为近
      5 个交易日内才显示的短提示；缓解 2016-2019 前期曲线遮挡。
   4) 主图 Y 轴刻度 0 / 10万 / 20万 / 30万（网格同步重画，范围仍 0-300000）。
   5) 事件标记缩小一档 + 深色 halo + 10 帧淡出 + 24px 避让网格；事件气泡
      增加避让规则（避开浮板/图例/曲线末端），必要时以细连接线指引。

 沿用 V1.1 已修复能力（不回退）：strict 模板替换与渲染前占位符强校验；
 dip-to-bg 无叠影转场；片尾金额来自 summary；信号/成交分离；数据一致性
 校验；输出目录恒为仓库根下的 output/，不读取任何机器专属配置。

 数据来源（Phase 1 已验收产物；渲染层不计算任何收益指标、不另算指标序列）：
   <source_run_id>/02_backtest_macd/summary.json / daily.csv / signals.csv
                                  / trades.csv / macd.csv

 不修改封版回测算法 / MACD 参数 / 最终收益 / 不新增 K 线组件 /
 不改动第一条视频、红利 ETF 视频与 V1 / V1.1 / V1.2 成片。
============================================================================"""
import argparse
import csv
import hashlib
import json
import math
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

ap = argparse.ArgumentParser()
ap.add_argument("--config", default=os.path.join(HERE, "config.stock_macd_video_v122.json"))
ap.add_argument("--run", default=None)
A = ap.parse_args()

with open(A.config, encoding="utf-8") as f:
    CFG = json.load(f)
RUN = A.run or CFG["run_id"]
SRC_RUN = CFG["source_run_id"]
BT_DIR_NAME = CFG.get("backtest_dir", "02_backtest_macd")


# ---------- ENGINE_ROOT 解析（与 backtest/fetch 一致，机器无关） ----------
def resolve_root(cfg):
    local_path = os.path.join(ROOT, "migration", "local_configs", "config.local.json")
    if os.path.exists(local_path):
        try:
            local = json.load(open(local_path, encoding="utf-8"))
            if local.get("engine", {}).get("root"):
                return local["engine"]["root"]
        except Exception:
            pass
    if os.environ.get("ENGINE_ROOT"):
        return os.environ["ENGINE_ROOT"]
    cfg_root = cfg.get("engine", {}).get("root")
    if cfg_root and os.path.isdir(os.path.join(cfg_root, "output")):
        return os.path.abspath(cfg_root)
    return ROOT  # 仓库根兜底：output 在仓库根下


ROOT_RESOLVED = resolve_root(CFG)
OUT_ROOT = os.path.join(ROOT_RESOLVED, CFG["engine"].get("output_dir", "output"))
SRC_DIR = os.path.join(OUT_ROOT, SRC_RUN)
BT_DIR = os.path.join(SRC_DIR, BT_DIR_NAME)
RUN_DIR = os.path.join(OUT_ROOT, RUN)
OUT_DIR = os.path.join(RUN_DIR, "04_video")
os.makedirs(OUT_DIR, exist_ok=True)

for p in ("summary.json", "daily.csv", "signals.csv", "trades.csv", "macd.csv"):
    if not os.path.exists(os.path.join(BT_DIR, p)):
        raise SystemExit("缺少已验收产物: " + os.path.join(BT_DIR, p))

# ---------- deps 加到 sys.path（Windows 原生路径） ----------
for cand in (os.path.join(ROOT, "deps"), os.path.join(ROOT_RESOLVED, "deps")):
    if os.path.isdir(cand) and cand not in sys.path:
        sys.path.insert(0, cand)
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()

V = CFG["video"]
CP, CO, CH, ENC = V["copy"], V["colors"], V["chart"], V["encoder"]
with open(os.path.join(BT_DIR, "summary.json"), encoding="utf-8") as f:
    S = json.load(f)
META, MACD, HOLD, ZF = S["meta"], S["macd"], S["hold"], S.get("zeroFeeMacd")


def read_csv(name):
    with open(os.path.join(BT_DIR, name), encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


rows = read_csv("daily.csv")
SIGNALS = read_csv("signals.csv")
TRADES = read_csv("trades.csv")
MROWS = read_csv("macd.csv")
N = len(rows)

# ---------- 数据勾稽（只读，不重算；任何不一致立即拒绝渲染） ----------
if N != META["tradingDays"]:
    raise SystemExit("daily.csv 行数 %d 与 summary %d 不一致" % (N, META["tradingDays"]))
if abs(float(rows[-1]["macd_asset"]) - MACD["final"]) > 0.02:
    raise SystemExit("MACD 终值不勾稽: %.2f vs %.2f" % (float(rows[-1]["macd_asset"]), MACD["final"]))
if abs(float(rows[-1]["hold_asset"]) - HOLD["final"]) > 0.02:
    raise SystemExit("持有终值不勾稽: %.2f vs %.2f" % (float(rows[-1]["hold_asset"]), HOLD["final"]))
if len(MROWS) != N:
    raise SystemExit("macd.csv 行数 %d 与 daily.csv %d 不一致" % (len(MROWS), N))

dates = [r["date"] for r in rows]
DATE_IDX = {d: i for i, d in enumerate(dates)}
# 浮点插值用的数值序列（只读 daily.csv，不重算）
MACD_A = [float(r["macd_asset"]) for r in rows]
HOLD_A = [float(r["hold_asset"]) for r in rows]

MACD_TRADES = [t for t in TRADES if t["strategy"] == "macd"]
if len(MACD_TRADES) != MACD["tradeCount"]:
    raise SystemExit("trades.csv MACD 笔数 %d 与 summary %d 不一致" % (len(MACD_TRADES), MACD["tradeCount"]))
# 通用勾稽：信号数 == 买入数 + 卖出数 + 本次实际未执行的信号数。
# 旧封版样本恰好有 1 个「起始空仓的首个死叉」未执行，但模拟数据可能没有，
# 因此这里从 signals.csv 动态读取，不写死 +1，也不放宽任何一致性要求。
UNEXECUTED = [s for s in SIGNALS if s["executed"] == "0"]
if len(SIGNALS) != MACD["buyCount"] + MACD["sellCount"] + len(UNEXECUTED):
    raise SystemExit("signals.csv 条数 %d 与 summary 买+卖+未执行(%d) 不一致"
                     % (len(SIGNALS), len(UNEXECUTED)))

# macd.csv 的 cross 列是同一份回测输出里的交叉标记，用作副图与信号表的交叉校验
CROSS_ROWS = [(r["date"], r["cross"]) for r in MROWS if r["cross"] != "none"]
SIG_DATES = [(s["signal_date"], "golden" if s["type"] == "GOLDEN" else "death") for s in SIGNALS]
if CROSS_ROWS != SIG_DATES:
    raise SystemExit("macd.csv 交叉标记与 signals.csv 不一致（副图不可信，拒绝渲染）")

# 指标序列（直接读已验收输出，不做任何二次计算）
DIF = [float(r["dif"]) if r["dif"] else None for r in MROWS]
DEA = [float(r["dea"]) if r["dea"] else None for r in MROWS]
HIST = [float(r["hist"]) if r["hist"] else None for r in MROWS]

# 累计 MACD 成交次数（按日期）
macd_trade_count_by_date = {}
for t in MACD_TRADES:
    macd_trade_count_by_date[t["date"]] = macd_trade_count_by_date.get(t["date"], 0) + 1
cum_trades, acc = [0] * N, 0
for i, d in enumerate(dates):
    acc += macd_trade_count_by_date.get(d, 0)
    cum_trades[i] = acc

DIV_IDX = sorted({DATE_IDX[a["date"]] for a in META.get("corporateActions", []) if a["date"] in DATE_IDX})

# ---------- 事件构造（signal + exec），经 validate_events 强校验 ----------
GOLDEN_COL, DEATH_COL = tuple(CO["extra"]["golden"]), tuple(CO["extra"]["death"])


def build_events():
    evs, n = [], 0
    for s in SIGNALS:
        sd = s["signal_date"]
        if sd not in DATE_IDX:
            raise SystemExit("信号日期不在日历: " + sd)
        si = DATE_IDX[sd]
        stype = s["type"]
        executed = s["executed"] == "1"
        col_tag = "GOLDEN" if stype == "GOLDEN" else "DEATH"
        evs.append({
            "id": "sig_%d_%s" % (n, sd), "date": sd, "dayIndex": si,
            "kind": "macd_signal", "series": "macd", "priority": 0,
            "reason": "金叉信号" if stype == "GOLDEN" else "死叉信号",
            "headline": "%s 信号" % ("金叉" if stype == "GOLDEN" else "死叉"),
            "detail": "signal_close=%.3f" % float(s["signal_close"]),
            "ev_kind": "signal", "ev_type": col_tag,
            "y": float(rows[si]["macd_asset"]),          # 账户资产，不映射股价
            "y_ind": DIF[si] if DIF[si] is not None else 0.0,   # 副图交叉点
            "empty": s["executed"] == "0",
            "key_label": None,
        })
        n += 1
        if executed:
            ed = s["exec_date"]
            if ed not in DATE_IDX:
                raise SystemExit("成交日期不在日历: " + ed)
            ei = DATE_IDX[ed]
            evs.append({
                "id": "exec_%d_%s" % (n, ed), "date": ed, "dayIndex": ei,
                "kind": "macd_trade", "series": "macd", "priority": 0,
                "reason": "成交",
                "headline": "%s 成交" % ("金叉买" if stype == "GOLDEN" else "死叉卖"),
                "detail": "exec_price=%.3f" % float(s["exec_price"]),
                "ev_kind": "exec", "ev_type": col_tag,
                "y": float(rows[ei]["macd_asset"]),
                "y_ind": 0.0,
                "key_label": None,
            })
            n += 1
    return evs


EV = build_events()
SIG_EV = [e for e in EV if e["ev_kind"] == "signal"]
EXEC_EV = [e for e in EV if e["ev_kind"] == "exec"]

# ---------- 重点事件（≤6，priority=1，高亮 + 慢放） ----------
# 全部取自「本次回测实际发生的信号」。旧封版样本必然包含「起始空仓未执行的
# 首个死叉」，模拟数据不一定有；缺失时直接跳过该故事点，绝不虚构事件补足 6 个。
goldens = [s for s in SIGNALS if s["type"] == "GOLDEN"]
deaths = [s for s in SIGNALS if s["type"] == "DEATH"]
exec_goldens = [s for s in goldens if s["executed"] == "1"]
exec_deaths = [s for s in deaths if s["executed"] == "1"]
empty_deaths = [s for s in deaths if s["executed"] == "0"]

KEY_SPEC = []


def _add_key(sig, label):
    if sig is not None:
        KEY_SPEC.append((sig, label))


_add_key(exec_goldens[0] if exec_goldens else None, "首次金叉·次日开盘买入")
_add_key(empty_deaths[0] if empty_deaths else None, "死叉·但空仓未成交")
_add_key(exec_deaths[0] if exec_deaths else None, "首次死叉·次日开盘卖出")
if exec_goldens:
    _add_key(max(exec_goldens, key=lambda s: float(s["hist"])), "最强金叉动能")
    _add_key(exec_goldens[-1], "末次金叉")
if deaths:
    _add_key(deaths[-1], "末次死叉")
KEY_INDEX_SET = set()
for s, label in KEY_SPEC:
    KEY_INDEX_SET.add(DATE_IDX[s["signal_date"]])
    for ev in EV:
        if ev["ev_kind"] == "signal" and ev["date"] == s["signal_date"]:
            ev["priority"] = 1
            ev["key_label"] = label
        if ev["ev_kind"] == "exec" and ev["date"] == s["exec_date"]:
            ev["priority"] = 1
            ev["key_label"] = label   # 主图成交点也带故事标签（信号标签在副图）

try:
    from video_events import validate_events
    validate_events(EV, dates, ["macd"])
except Exception as e:
    raise SystemExit("事件强校验失败，拒绝渲染：" + str(e))

from video_events import build_smooth_timeline, smoothness_report

# 时间轴：浮点位置 + 余弦核 + 密度自适应（V1.2.1 起）
# V1.2 用的是 build_warp_timeline 的 int 位置，在「帧数 < 天数」时普通区每帧跨
# 2~3 天，取整使步长在 2/3 之间交替（judder），慢放区又四舍五入成十几帧同值
# （死停），出慢放区速度瞬间从 0 回到 3 天/帧（顿挫）——观众看到的就是「开头几秒卡」。
TCFG = V.get("timeline", {}) or {}
TL_CFG = {
    "hold_frames": float(TCFG.get("hold_frames", 30)),
    "smooth_days": float(TCFG.get("smooth_days", 5.0)),
    "peak": float(TCFG.get("peak", 18.0)),
    "hold_cap": float(TCFG.get("hold_cap", 0.42)),
    # 与 V1.2.2 的唯一时间轴差异：成本域建在「日区间」上（详见 video_events 注释）。
    # V1.2.2 不传该参数 → 保持封版口径，V0.1 演示逐字节不变。
    "cost_domain": "intervals",
}
POS = build_smooth_timeline(N, V["main_frames"], sorted(KEY_INDEX_SET), **TL_CFG)
SMOOTH = smoothness_report(POS)
SMOOTH["hold"] = [{"dayIndex": int(e),
                   "frames": sum(1 for p in POS if abs(p - e) <= 1.5),
                   "seconds": round(sum(1 for p in POS if abs(p - e) <= 1.5) / float(V["fps"]), 2)}
                  for e in sorted(KEY_INDEX_SET)]


# ---------- 颜色与字体 ----------
BG, PANEL, GRID = tuple(CO["bg"]), tuple(CO["panel"]), tuple(CO["grid"])
TXT, MUTED, FAINT = tuple(CO["text"]), tuple(CO["muted"]), tuple(CO["faint"])
STRAT_C, HOLD_C = tuple(CO["strategy"]), tuple(CO["hold"])
GOLD, WARN = tuple(CO["gold"]), tuple(CO["warn"])
PANEL2 = tuple(CO["panel2"])
EX = {k: tuple(v) for k, v in CO["extra"].items()}
FONT_CACHE = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in FONT_CACHE:
        order = (V["fonts"]["bold"], V["fonts"]["regular"], V["fonts"]["fallback"]) if bold \
            else (V["fonts"]["regular"], V["fonts"]["fallback"])
        for p in order:
            try:
                FONT_CACHE[key] = ImageFont.truetype(p, size, index=0)
                break
            except Exception:
                continue
        if key not in FONT_CACHE:
            # 跨平台兜底：不依赖任何机器专属字体路径
            try:
                FONT_CACHE[key] = ImageFont.truetype("DejaVuSans.ttf", size)
            except Exception:
                FONT_CACHE[key] = ImageFont.load_default(size=size)
    return FONT_CACHE[key]


def text(d, xy, s, size, color=TXT, bold=False, anchor=None):
    d.text(xy, s, font=font(size, bold), fill=color, anchor=anchor)


def fit_text(s, size, max_w, min_size=13):
    """把一行文字压进 max_w：先缩字号，仍放不下才截断并加省略号。
    只用于 V1.2.3 的用户导入文案（文件名 / 来源说明可能很长）；
    V1.2.2 封版演示不经过这里，画面保持逐字节不变。"""
    s = "" if s is None else str(s)
    sz = size
    while sz > min_size and font(sz).getlength(s) > max_w:
        sz -= 1
    if font(sz).getlength(s) <= max_w:
        return s, sz
    f = font(sz)
    cut = s
    while cut and f.getlength(cut + "…") > max_w:
        cut = cut[:-1]
    return cut + "…", sz


def rrect(d, box, fill=None, outline=None, width=2, radius=14):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def money2(v):
    return "{:,.2f}".format(v)


def pct(x, sign=True):
    return ("{:+.2f}%" if sign else "{:.2f}%").format(x * 100).replace("-", "\u2212")


def blend(col, a):
    return tuple(round(col[k] * a + BG[k] * (1 - a)) for k in range(3))


# ---------- 坐标 ----------
W, H = V["design_width"], V["design_height"]
OUT_W, OUT_H = V["width"], V["height"]
FPS = V["fps"]
INTRO, MAIN, OUTRO = V["intro_frames"], V["main_frames"], V["outro_frames"]
F = V["fade"]
FI, FO = F["intro_in"], F["intro_out"]
OO, ODIP = F["outro_in"], F["outro_dip"]
FADE_WINDOW = CH.get("fade_window", 10)
OCC_CELL = CH.get("occ_cell", 24)
PNL = CH.get("panel", {})
RECENT_EVENT_DAYS = PNL.get("recent_event_days", 5)

L, R = CH["left"], CH["right"]
MT, MB = CH["main_top"], CH["main_bottom"]
ST, SB = CH["sub_top"], CH["sub_bottom"]

PEAK = max([MACD["peak"], HOLD["peak"], META["initialCapital"]]
           + [float(r["macd_asset"]) for r in rows] + [float(r["hold_asset"]) for r in rows])


def nice_step(raw):
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 1.5, 2, 2.5, 5, 10):
        if raw <= m * mag:
            return m * mag
    return 10 * mag


# 主图 Y 轴：V1.2 起用配置显式刻度（0/10万/20万/30万），范围仍 0-300000
_cfg_ticks = CH.get("asset_ticks")
if _cfg_ticks:
    AMAX = max(_cfg_ticks)
    if PEAK > AMAX:
        raise SystemExit("asset_ticks 上限 %s 低于资产峰值 %.2f" % (AMAX, PEAK))
    TICKS = [float(t) for t in _cfg_ticks]
else:
    STEP = nice_step(PEAK * 1.08 / 6)
    AMAX = math.ceil(PEAK * 1.08 / STEP) * STEP
    TICKS, _v = [], 0
    while _v <= AMAX + 1e-6:
        TICKS.append(_v)
        _v += STEP

# 副图纵轴：全样本对称、固定刻度（完整横轴内不跳刻度）
_MVAL = max([abs(v) for v in DIF + DEA + HIST if v is not None] + [0.001])
_MSTEP = nice_step(_MVAL * 1.15 / 2)
MAMAX = math.ceil(_MVAL * 1.15 / _MSTEP) * _MSTEP
MTICKS = [-MAMAX, -MAMAX / 2.0, 0.0, MAMAX / 2.0, MAMAX]


def xr(i):
    """全局时间索引 → 横向坐标；上下两图共用同一映射（V1.2 核心约定）。"""
    return L + (R - L) * i / (N - 1)


def ya(v):
    return MB - min(max(v, 0), AMAX) / AMAX * (MB - MT)


def sy(v):
    return SB - (v + MAMAX) / (2 * MAMAX) * (SB - ST)


YEAR_EVERY = CH.get("year_tick_every", 2)
YEAR_IDX, seen = [], set()
for i, r in enumerate(rows):
    y = int(r["date"][:4])
    if y not in seen and y % YEAR_EVERY == 0:
        seen.add(y)
        YEAR_IDX.append((i, y))

# 预计算：MACD 指标折线（与主图同一 xr 映射）与柱状图像素包络
DIF_PTS = [(xr(j), sy(v)) for j, v in enumerate(DIF) if v is not None]
DEA_PTS = [(xr(j), sy(v)) for j, v in enumerate(DEA) if v is not None]
HIST_ENV = {}   # 像素列 -> [min, max]（由真实逐日 hist 聚合，不改数值）
for j, h in enumerate(HIST):
    if h is None:
        continue
    px = int(round(xr(j)))
    e = HIST_ENV.get(px)
    if e is None:
        HIST_ENV[px] = [h, h]
    else:
        e[0] = min(e[0], h)
        e[1] = max(e[1], h)
HIST_ENV_XS = sorted(HIST_ENV)

# ---------- token ----------
TOKENS = {
    "start": META["start"], "end": META["end"],
    "stock_name": META["name"], "stock_code": META["symbol"],
    "tradingDays": META["tradingDays"], "suspendedDays": META["suspendedDays"],
    "divCount": len(META.get("corporateActions", [])),
    "initialCapital": money2(META["initialCapital"]),
    "macd_final": money2(MACD["final"]),
    "hd_final": money2(HOLD["final"]),
    "hold_final": money2(HOLD["final"]),          # ← V1 片尾漏替换的根因：缺这个别名
    "macd_ret": pct(MACD["totalReturn"]), "hd_ret": pct(HOLD["totalReturn"]),
    "macd_dd": pct(MACD["maxDD"], False), "hd_dd": pct(HOLD["maxDD"], False),
    "macd_trades": "{:,}".format(MACD["tradeCount"]),
    "macdTrades": "{:,}".format(MACD["tradeCount"]),   # 兼容 V1 文案的驼峰写法
    "macdBuys": "{:,}".format(MACD["buyCount"]), "macdSells": "{:,}".format(MACD["sellCount"]),
    "signals": "{:,}".format(len(SIGNALS)),
    "comm": money2(MACD["feeBreakdown"]["commission"]),
    "stamp": money2(MACD["feeBreakdown"]["stampDuty"]),
    "transfer": money2(MACD["feeBreakdown"]["transferFee"]),
    "total_fee": money2(MACD["totalFees"]),
    "divtax": money2(MACD["totalDividendTax"]),
    "zf_final": money2(ZF["final"]) if ZF else "N/A",
    "gap": money2(HOLD["final"] - MACD["final"]),
    "ratio": "{:.2f}".format(HOLD["final"] / MACD["final"]),
    "done": "{:,}".format(cum_trades[-1]), "macdDone": "{:,}".format(cum_trades[-1]),
}

PAT = re.compile(r"\{(\w+)(?::([^}]*))?\}")
USED_TOKENS = set()


class UnknownToken(KeyError):
    pass


def cp(template, **extra):
    t = dict(TOKENS)
    t.update(extra)

    def sub(m):
        k, spec = m.group(1), m.group(2)
        if k not in t:
            raise UnknownToken(k)
        USED_TOKENS.add(k)
        try:
            return format(t[k], spec) if spec else str(t[k])
        except Exception:
            return str(t[k])

    return PAT.sub(sub, str(template))


def iter_strings(obj, path=""):
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from iter_strings(v, (path + "." if path else "") + k)
    elif isinstance(obj, (list, tuple)):
        for idx, v in enumerate(obj):
            yield from iter_strings(v, "%s[%d]" % (path, idx))


# ---------- 模板变量完整性检查（渲染前，零容忍） ----------
def check_templates():
    rendered, problems = {}, []
    for path, s in iter_strings(CP):
        try:
            out = cp(s)
        except UnknownToken as e:
            problems.append("%s → 未定义变量 {%s}" % (path, e.args[0]))
            continue
        rendered[path] = out
        if "{" in out or "}" in out:
            problems.append("%s → 替换后仍残留占位符: %r" % (path, out))
    if problems:
        print("模板变量检查失败：")
        for p in problems:
            print("  · " + p)
        raise SystemExit("拒绝渲染：copy 中存在未替换的占位符（共 %d 处）" % len(problems))
    # 关键金额必须来自 summary
    if rendered.get("outro_amount") != "¥ " + money2(HOLD["final"]):
        raise SystemExit("片尾金额与 summary 不一致: %r" % rendered.get("outro_amount"))
    if rendered.get("outro_amount_macd") != "¥ " + money2(MACD["final"]):
        raise SystemExit("片尾 MACD 金额与 summary 不一致: %r" % rendered.get("outro_amount_macd"))
    return rendered


RENDERED = check_templates()
TEMPLATE_CHECK = {"strings": len(RENDERED), "unresolved": 0,
                  "tokens": sorted(USED_TOKENS)}

# ---------- 静态底图 ----------
def build_base():
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    hh = CH["header_height"]
    d.rectangle([0, 0, W, hh], fill=PANEL)
    d.line([0, hh, W, hh], fill=GRID, width=2)
    text(d, (48, 16), cp(CP["header_title"]), 34, TXT, True)
    sub_s, sub_sz = fit_text(cp(CP["header_sub"]), 18, W - 96)
    text(d, (48, 62), sub_s, sub_sz, MUTED)
    text(d, (W - 48, 38), cp(CP["header_dates"]), 24, MUTED, anchor="rm")

    # 主图图例行
    ly = CH["legend_y"]
    text(d, (L, ly), cp(CP["asset_title"]), 18, MUTED)
    d.line([L + 400, ly + 10, L + 444, ly + 10], fill=STRAT_C, width=4)
    text(d, (L + 456, ly), cp(CP["legend_strategy"]), 18, MUTED)
    d.line([L + 830, ly + 10, L + 874, ly + 10], fill=HOLD_C, width=4)
    text(d, (L + 886, ly), cp(CP["legend_hold"]), 18, MUTED)
    text(d, (L + 1330, ly), cp(CP["legend_trade"]), 18, MUTED)

    # 主图面板
    rrect(d, [L, MT, R, MB], fill=PANEL, outline=GRID, radius=8)
    for v in TICKS:
        y = ya(v)
        d.line([L, y, R, y], fill=GRID, width=1)
        text(d, (L - 16, y), ("0" if v == 0 else "{:.0f}万".format(v / 10000)), 17, FAINT, anchor="rm")
    for i, y in YEAR_IDX:
        x = xr(i)
        d.line([x, MT, x, MB], fill=GRID, width=1)
        text(d, (x, MB + 8), str(y), 16, FAINT, anchor="mt")
    for di in DIV_IDX:
        x = xr(di)
        d.line([x, MB - 14, x, MB], fill=EX["div_tick"], width=2)

    # 副图标题行
    sy_ = CH["sub_header_y"]
    text(d, (L, sy_), cp(CP["sub_title"]), 18, MUTED)
    x = L + 330
    d.line([x, sy_ + 10, x + 34, sy_ + 10], fill=EX["dif"], width=3)
    text(d, (x + 44, sy_), cp(CP["sub_legend_dif"]), 17, MUTED)
    x = L + 470
    d.line([x, sy_ + 10, x + 34, sy_ + 10], fill=EX["dea"], width=3)
    text(d, (x + 44, sy_), cp(CP["sub_legend_dea"]), 17, MUTED)
    x = L + 620
    d.rectangle([x, sy_ + 3, x + 10, sy_ + 17], fill=blend(EX["hist_pos"], 0.55))
    d.rectangle([x + 12, sy_ + 3, x + 22, sy_ + 17], fill=blend(EX["hist_neg"], 0.55))
    text(d, (x + 32, sy_), cp(CP["sub_legend_hist"]), 17, MUTED)
    x = L + 880
    d.ellipse([x + 8, sy_ + 3, x + 22, sy_ + 17], outline=GOLDEN_COL, width=2)
    text(d, (x + 32, sy_), cp(CP["sub_legend_cross"]), 17, MUTED)
    text(d, (R, sy_), cp(CP["sub_note"]), 16, FAINT, anchor="ra")

    # 副图面板（与主图同一 xr 映射：年刻度线两图对齐，强化"同一时间轴"）
    rrect(d, [L, ST, R, SB], fill=PANEL, outline=GRID, radius=8)
    for i, y in YEAR_IDX:
        x = xr(i)
        d.line([x, ST, x, SB], fill=GRID, width=1)
    for v in MTICKS:
        y = sy(v)
        if v == 0:
            continue
        lab = "{:.2f}".format(v).replace("-", "\u2212")
        text(d, (L - 16, y), lab, 15, FAINT, anchor="rm")

    fy = CH["footer_y"]
    # 左侧可能含很长的文件名 / 来源说明：给右侧免责声明留出实测宽度，再压左侧。
    right_s = cp(CP["footer_right"])
    right_w = font(17).getlength(right_s) + 24
    left_s, left_sz = fit_text(cp(CP["footer_left"]), 17, (R - L) - right_w)
    text(d, (L, fy), left_s, left_sz, FAINT)
    text(d, (R, fy), right_s, 17, EX["disclaimer"], anchor="ra")
    return im


BASE = build_base()


def intro_card():
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 10], fill=STRAT_C)
    text(d, (W // 2, 196), cp(CP["intro_title"]), 76, TXT, True, anchor="mm")
    text(d, (W // 2, 288), cp(CP["intro_sub"]), 36, MUTED, anchor="mm")
    text(d, (W // 2, 352), cp(CP["intro_tagline"]), 24, FAINT, anchor="mm")
    cw, gap = 510, 40
    x0 = (W - (3 * cw + 2 * gap)) // 2
    for k, (a, b) in enumerate(CP["intro_cards"]):
        x = x0 + k * (cw + gap)
        c = STRAT_C if k == 0 else (HOLD_C if k == 1 else GOLD)
        rrect(d, [x, 452, x + cw, 632], fill=PANEL2, outline=c, width=2, radius=18)
        d.rectangle([x, 452, x + 6, 632], fill=c)
        text(d, (x + 34, 486), cp(a), 38, c, True)
        text(d, (x + 34, 560), cp(b), 22, TXT)
    text(d, (W // 2, 700), cp(CP["intro_method"]), 22, MUTED, anchor="mm")
    text(d, (W // 2, 754), cp(CP["intro_scale"]), 24, TXT, anchor="mm")
    text(d, (W // 2, 820), cp(CP["intro_tax"]), 19, MUTED, anchor="mm")
    text(d, (W // 2, 950), cp(CP["intro_disclaimer"]), 20, EX["disclaimer"], anchor="mm")
    return im


def outro_card():
    """片尾：两栏大额即第一视觉重点，费用/风险降为小字低对比。"""
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 10], fill=GOLD)
    text(d, (W // 2, 76), cp(CP["outro_top"]), 24, MUTED, anchor="mm")

    # 左：长期持有（主视觉）
    text(d, (200, 168), cp(CP["outro_hold_label"]), 26, MUTED)
    text(d, (200, 208), cp(CP["outro_amount"]), 100, HOLD_C, True)
    text(d, (204, 340), cp(CP["outro_hold_pct"]), 40, HOLD_C, True)
    text(d, (470, 356), cp(CP["outro_hold_dd"]), 22, FAINT)

    d.line([990, 168, 990, 392], fill=GRID, width=2)

    # 右：MACD 策略（次视觉，字号降一档）
    text(d, (1040, 176), cp(CP["outro_macd_label"]), 24, MUTED)
    text(d, (1040, 214), cp(CP["outro_amount_macd"]), 72, STRAT_C, True)
    text(d, (1044, 312), cp(CP["outro_macd_pct"]), 32, STRAT_C, True)
    text(d, (1044, 360), cp(CP["outro_macd_dd"]), 20, FAINT)
    text(d, (1044, 392), cp(CP["outro_macd_trades"]), 20, FAINT)

    text(d, (W // 2, 470), cp(CP["outro_gap"]), 30, TXT, anchor="mm")

    # 低视觉权重的口径区
    d.line([200, 540, W - 200, 540], fill=GRID, width=1)
    text(d, (200, 556), cp(CP["outro_notes_title"]), 17, FAINT)
    for k, s in enumerate(CP["outro_notes"]):
        text(d, (200, 590 + k * 32), cp(s), 16, FAINT)
    text(d, (200, 730), cp(CP["outro_risk"]), 18, EX["disclaimer"])
    text(d, (W // 2, 980), cp(CP["outro_footer"]), 15, FAINT, anchor="mm")
    return im


INTRO_IMG = intro_card()
OUTRO_IMG = outro_card()
BLACK = Image.new("RGB", (W, H), (0, 0, 0))
DIP = Image.new("RGB", (W, H), BG)

KF_DIR = os.path.join(OUT_DIR, "frames")
os.makedirs(KF_DIR, exist_ok=True)
INTRO_IMG.save(os.path.join(KF_DIR, "00_intro.png"))
OUTRO_IMG.save(os.path.join(KF_DIR, "99_outro.png"))
KEY_IDX, DUMPED = {}, set()
_kf_cfg = list(V.get("keyframes", []) or [])
if not _kf_cfg and SIG_DATES:
    # 配置未给固定日期时，从「本次回测实际发生的信号日」均匀取样，
    # 不虚构任何日期，也不沿用旧封版样本的固定日期。
    _picks = sorted({int(round(k * (len(SIG_DATES) - 1) / 5.0)) for k in range(6)})
    _kf_cfg = [SIG_DATES[j][0] for j in _picks]
for dd in _kf_cfg:
    if dd not in DATE_IDX:
        print("  注意：关键帧日期不在交易日中: " + dd)
        continue
    KEY_IDX[DATE_IDX[dd]] = dd

# ---------- 左侧悬浮面板（当日快照，V1.2 缩小版） ----------
CARD_X1 = PNL.get("x1", 152)
CARD_X2 = PNL.get("x2", 566)

PANEL_ROW_H, PANEL_PAD = 26, 16
PANEL_MAX_ROWS = 4            # 两资产行 + 持仓·成交行 (+ 最近事件行)
PANEL_H_MAX = 32 + PANEL_MAX_ROWS * PANEL_ROW_H + PANEL_PAD   # 152px
PANEL_GAP = 8                 # 面板与曲线之间的最小间隙（px）
PANEL_EDGE = 6                # 面板与绘图区边界的最小间隙（px）


def panel_curve_span():
    """浮板水平覆盖段内两条资金曲线的 y 上下界（含线宽/圆点半径余量）。"""
    x_lo, x_hi = CARD_X1 - PANEL_GAP, CARD_X2 + PANEL_GAP
    ys = []
    for k in range(N):
        x = xr(k)
        if x_lo <= x <= x_hi:
            ys.append(ya(MACD_A[k]))
            ys.append(ya(HOLD_A[k]))
    if not ys:
        return MT, MB
    return min(ys) - 2.0, max(ys) + 2.0


def choose_panel_y1():
    """V1.2.3：按本次资产轨迹给浮板选位（不放大 Y 轴、不缩小字号）。

    1) 曲线之上放得下 → 贴曲线放（长样本的既有位置走这条分支，与 V1.2.2 一致）；
    2) 否则曲线之下放得下 → 放到下方留白区（短样本资金曲线贴在 10 万起点时）；
    3) 都放不下 → 退回 V1.2.2 固定位置，并在报告里标 forced-top，
       由验收脚本如实判失败（宁可不出片，也不交付被遮挡的画面）。
    """
    y_top, y_bot = panel_curve_span()
    above = int(math.floor(y_top - PANEL_GAP - PANEL_H_MAX))
    if above >= MT + PANEL_EDGE:
        return above, "top"
    below = int(math.ceil(y_bot + PANEL_GAP))
    if below + PANEL_H_MAX <= MB - PANEL_EDGE:
        return below, "bottom"
    return MT + 24, "forced-top"


if PNL.get("y1") is not None:
    CARD_Y1, PANEL_ANCHOR = int(PNL["y1"]), "config"
else:
    CARD_Y1, PANEL_ANCHOR = choose_panel_y1()
PANEL_RECT = None   # 每帧由 info_card 更新，供事件气泡避让


def last_event_at(i):
    le = None
    for ev in EV:
        if ev["dayIndex"] <= i:
            le = ev
    return le


def info_card(d, i):
    """紧凑浮板（V1.2.2 再压缩高度：行距 34→26，持仓与成交合并一行）。

    高度预算（4 行 =126px / 5 行 =152px）。y1 由 choose_panel_y1() 按本次资产
    轨迹决定（V1.2.3）：长样本曲线高、面板贴顶放其上方；短样本曲线贴 10 万起点、
    面板改放曲线下方的留白区，两种情况都保证曲线不穿过面板矩形。
    """
    global PANEL_RECT
    r = rows[i]
    x1, x2, y1 = CARD_X1, CARD_X2, CARD_Y1
    pad = 16
    ha, ma = float(r["hold_asset"]), float(r["macd_asset"])
    holding = int(float(r["macd_shares"])) > 0
    ha_ret = ha / META["initialCapital"] - 1
    ma_ret = ma / META["initialCapital"] - 1

    # 最近事件：按需显示（距上一事件 ≤ recent_event_days 个交易日才出现）
    le = last_event_at(i)
    show_ev = le is not None and (i - le["dayIndex"]) <= RECENT_EVENT_DAYS
    rows_n = 3 + (1 if show_ev else 0)      # 两资产行 + 持仓·成交合并行 (+事件行)
    h = 32 + rows_n * 26 + 16
    y2 = y1 + h
    rrect(d, [x1, y1, x2, y2], fill=EX["info_bg"], outline=EX["info_border"], width=2, radius=12)
    text(d, (x1 + pad, y1 + 8), cp(CP["info_title"]), 13, MUTED)
    text(d, (x2 - pad, y1 + 6), r["date"], 20, TXT, True, anchor="ra")
    d.line([x1 + 10, y1 + 32, x2 - 10, y1 + 32], fill=GRID, width=1)

    y = y1 + 40
    for name, val, col, ret in [(CP["info_labels"][1], "¥ " + money2(ha), HOLD_C, ha_ret),
                                (CP["info_labels"][2], "¥ " + money2(ma), STRAT_C, ma_ret)]:
        text(d, (x1 + pad, y + 3), name, 13, FAINT)
        text(d, (x1 + pad + 62, y + 2), pct(ret), 12, col if ret >= 0 else WARN, True)
        text(d, (x2 - pad, y), val, 19, col, True, anchor="ra")
        y += 26
    status_col = GOLDEN_COL if holding else FAINT
    text(d, (x1 + pad, y + 2), CP["info_labels"][3], 13, FAINT)
    text(d, (x2 - pad, y + 1),
         (CP["status_hold"] if holding else CP["status_flat"]) + "  ·  累计成交 %d 次" % cum_trades[i],
         15, status_col, True, anchor="ra")
    y += 26
    if show_ev:
        if le["ev_kind"] == "signal":
            st = "金叉信号" if le["ev_type"] == "GOLDEN" else "死叉信号"
        else:
            st = "金叉·次日买入" if le["ev_type"] == "GOLDEN" else "死叉·次日卖出"
        if le.get("empty"):
            st = "死叉·空仓未成交"
        col = GOLDEN_COL if le["ev_type"] == "GOLDEN" else DEATH_COL
        text(d, (x1 + pad, y + 2), "最近事件", 12, FAINT)
        text(d, (x2 - pad, y + 1), st, 14, col, True, anchor="ra")
    PANEL_RECT = (x1, y1, x2, y2)
    return ma, ha


# ---------- 事件标记（屏幕空间防重叠 + 深色 halo） ----------
SUPPRESS = {"main": 0, "sub": 0}
PENDING_LABELS = []   # 本帧待画的关键事件标签（在浮层面板之上最后画，避免被面板盖住）


def claim(occ, x, y, key):
    """返回是否占到格子；key 事件按 3×3 占位，普通事件 1 格。"""
    cx, cy = int(x // OCC_CELL), int(y // OCC_CELL)
    span = (-1, 0, 1) if key else (0,)
    cells = [(cx + a, cy + b) for a in span for b in span]
    if any(c in occ for c in cells):
        return False
    occ.update(cells)
    return True


def marker(d, x, y, col, a, hollow, r=7, width=3):
    """先铺一圈底色 halo（把曲线切干净），再画本体 —— 保证标记完整可辨。"""
    hr = r + 3
    d.ellipse([x - hr, y - hr, x + hr, y + hr], fill=blend(EX["halo"], a))
    if hollow:
        d.ellipse([x - r, y - r, x + r, y + r], outline=blend(col, a), width=width)
    else:
        d.ellipse([x - r, y - r, x + r, y + r], fill=blend(col, a))


def draw_main_markers(d, i, occ):
    cands = []
    for ev in EXEC_EV:                       # 主图只画「实际成交」实心圆
        if ev["dayIndex"] > i:
            continue
        is_key = ev["priority"] == 1
        age = i - ev["dayIndex"]
        a = 1.0 if is_key else max(0.0, 1.0 - age / FADE_WINDOW)
        if a <= 0.04 and not is_key:
            continue
        cands.append((ev, a, is_key, age))
    cands.sort(key=lambda t: (-t[2], -t[0]["dayIndex"]))
    for ev, a, is_key, age in cands:
        x, y = xr(ev["dayIndex"]), ya(ev["y"])
        if not claim(occ, x, y, is_key):
            if not is_key:
                SUPPRESS["main"] += 1
            continue
        col = GOLDEN_COL if ev["ev_type"] == "GOLDEN" else DEATH_COL
        marker(d, x, y, col, a, hollow=False, r=5 if not is_key else 7, width=2)
        if is_key:
            rr = 13
            d.ellipse([x - rr, y - rr, x + rr, y + rr], outline=blend(col, min(1.0, a + 0.15)), width=2)
            if age <= 70 and ev.get("key_label"):
                PENDING_LABELS.append((x, y, col, ev["key_label"], 17))


def interp_series(arr, p):
    """浮点位置 p 处的序列取值（线性插值；空值断线处返回 None）。

    V1.2.1 的曲线末端用它对最后不足 1 个交易日的余量做插值，
    这样末端每帧都在移动，而不是「跨 2~3 天跳一次」。
    """
    i0 = int(math.floor(p))
    if i0 < 0 or i0 >= len(arr):
        return None
    v0 = arr[i0]
    if v0 is None:
        return None
    fr_ = p - i0
    if fr_ > 1e-9 and i0 + 1 < len(arr) and arr[i0 + 1] is not None:
        return v0 + (arr[i0 + 1] - v0) * fr_
    return v0


def draw_sub(d, p, occ):
    """MACD 副图（V1.2.2）：与主图共用完整历史横轴，从左向右随播放展开（浮点位置）。

    柱状图：2633 日的逐日柱在像素级过密，按像素列聚合为 min/max 包络
    （红正/绿负，45% 弱化）—— 数值仍逐日来自 macd.csv，只是绘制聚合。
    端点：按浮点 p 插值，与主图播放头严格同一 x。
    """
    zero = sy(0.0)
    # 柱状包络（只画已发生的日期）
    x_now = xr(p)
    from bisect import bisect_right
    k = bisect_right(HIST_ENV_XS, int(round(x_now)))
    for px in HIST_ENV_XS[:k]:
        mn, mx = HIST_ENV[px]
        if mx > 0:
            d.rectangle([px - 0.5, sy(mx), px + 0.5, zero], fill=blend(EX["hist_pos"], 0.45))
        if mn < 0:
            d.rectangle([px - 0.5, zero, px + 0.5, sy(mn)], fill=blend(EX["hist_neg"], 0.45))
    # 零轴
    d.line([L, zero, R, zero], fill=EX["zero_axis"], width=2)
    # DIF / DEA：预计算折线截断到当前 x（遇空值天然断线，因 None 不入表）
    n_dif = bisect_right([q[0] for q in DIF_PTS], x_now) if DIF_PTS else 0
    n_dea = bisect_right([q[0] for q in DEA_PTS], x_now) if DEA_PTS else 0
    if n_dif > 1:
        d.line(DIF_PTS[:n_dif], fill=EX["dif"], width=2)
    if n_dea > 1:
        d.line(DEA_PTS[:n_dea], fill=EX["dea"], width=2)
    # 末端亚像素补线（末端 - 上一个已到达的整数日）
    i0 = int(math.floor(p))
    for arr, pts, col, nn in ((DIF, DIF_PTS, EX["dif"], n_dif),
                              (DEA, DEA_PTS, EX["dea"], n_dea)):
        v = interp_series(arr, p)
        if v is None or arr[i0] is None or nn < 1:
            continue
        x0, y0 = xr(i0), sy(arr[i0])
        d.line([x0, y0, x_now, sy(v)], fill=col, width=2)
    # 当前值端点（与主图播放头同 x）
    vd, va_ = interp_series(DIF, p), interp_series(DEA, p)
    if vd is not None:
        d.ellipse([x_now - 4, sy(vd) - 4, x_now + 4, sy(vd) + 4], fill=EX["dif"])
    if va_ is not None:
        d.ellipse([x_now - 4, sy(va_) - 4, x_now + 4, sy(va_) + 4], fill=EX["dea"])


def draw_sub_markers(d, i, occ):
    """副图交叉信号：金叉/死叉在真实交叉坐标（同一 xr 映射）高亮。"""
    cands = []
    for ev in SIG_EV:
        di = ev["dayIndex"]
        if di > i:
            continue
        is_key = ev["priority"] == 1
        age = i - di
        a = 1.0 if is_key else max(0.0, 1.0 - age / FADE_WINDOW)
        if a <= 0.04 and not is_key:
            continue
        cands.append((ev, a, is_key, age))
    cands.sort(key=lambda t: (-t[2], -t[0]["dayIndex"]))
    for ev, a, is_key, age in cands:
        x, y = xr(ev["dayIndex"]), sy(ev["y_ind"])
        if not claim(occ, x, y, is_key):
            if not is_key:
                SUPPRESS["sub"] += 1
            continue
        col = GOLDEN_COL if ev["ev_type"] == "GOLDEN" else DEATH_COL
        d.line([x, sy(0.0), x, y], fill=blend(col, a * 0.5), width=1)
        marker(d, x, y, col, a, hollow=True, r=5, width=2)
        if is_key:
            rr = 11
            d.ellipse([x - rr, y - rr, x + rr, y + rr], outline=blend(col, min(1.0, a + 0.15)), width=2)
            if age <= 70 and ev.get("key_label") and ev.get("empty"):
                PENDING_LABELS.append((x, y, col, ev["key_label"], 15, "sub"))


LEGEND_RECT = (0, CH["legend_y"] - 6, W, MT - 6)   # 主图图例行禁入区


def _inter(a, b):
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def draw_key_labels(d):
    """关键事件标签：浮层面板之上最后绘制，并做避让——

    禁入区：左浮板（金额/日期）、主图图例行、画布左右边缘、副图下边界。
    候选位依次尝试 右上/左上/右下/左下；位移超过 60px 时画细连接线指回锚点。
    """
    for item in PENDING_LABELS:
        x, y, col, lab, size = item[:5]
        zone = item[5] if len(item) > 5 else "main"
        tw = d.textlength(lab, font=font(size, True))
        bw, bh = tw + 24, size + 18
        if zone == "main":
            bounds = (MT + 4, MB - bh - 4)
        else:
            bounds = (ST + 4, SB - bh - 4)
        cands = [(x + 18, y - bh - 6), (x - bw - 18, y - bh - 6),
                 (x + 18, y + 12), (x - bw - 18, y + 12)]
        best, best_d = None, None
        for lx, ly in cands:
            lx = min(max(lx, L + 4), R - bw - 4)
            ly = min(max(ly, bounds[0]), bounds[1])
            box = (lx, ly, lx + bw, ly + bh)
            d0 = math.hypot(lx - cands[0][0], ly - cands[0][1])
            hit_panel = PANEL_RECT and _inter(box, PANEL_RECT)
            hit_legend = zone == "main" and _inter(box, LEGEND_RECT)
            if not hit_panel and not hit_legend:
                if best is None:
                    best, best_d = (lx, ly), 0
                break
            if best is None or d0 < best_d:
                best, best_d = (lx, ly), d0
        lx, ly = best
        box = (lx, ly, lx + bw, ly + bh)
        moved = math.hypot(lx - cands[0][0], ly - cands[0][1]) > 60
        if moved:
            d.line([x, y, lx + bw / 2.0, ly + bh], fill=blend(col, 0.6), width=1)
        rrect(d, [lx, ly, lx + bw, ly + bh], fill=EX["bubble_bg"], outline=col, width=1, radius=8)
        text(d, (lx + 12, ly + 8), lab, size, col, True)
    PENDING_LABELS.clear()


def progress(d, i):
    y = CH["progress_y"]
    text(d, (L, CH["fee_line_y"]), cp(CP["fee_line"], done=cum_trades[i], macdDone=cum_trades[i]), 17, FAINT)
    text(d, (R, CH["fee_line_y"]), cp(CP["axis_line"]), 16, FAINT, anchor="ra")
    d.rounded_rectangle([L, y, R, y + 10], radius=5, fill=GRID)
    x = xr(i)
    d.rounded_rectangle([L, y, max(x, L + 6), y + 10], radius=5, fill=STRAT_C)
    d.ellipse([x - 8, y - 3, x + 8, y + 13], fill=TXT)


FRAME_DATA = []


def render_frame(trail, p):
    """绘制第 p（浮点）个交易日对应的画面。

    trail 只累积「整数交易日」的曲线段，这里在副本上补最后一小段亚像素插值，
    使曲线末端与播放头一起连续移动（V1.2.1 消除 judder 的关键）。
    """
    i = int(math.floor(p))
    im = trail.copy()
    d = ImageDraw.Draw(im)
    occ = set()
    draw_sub(d, p, occ)            # 1) 副图（曲线级，与主图同一 xr）
    draw_main_markers(d, i, occ)   # 2) 主图成交标记
    draw_sub_markers(d, i, occ)    # 3) 副图交叉标记
    ax = xr(p)
    ay = ya(interp_series(MACD_A, p))
    hx = ax
    hy = ya(interp_series(HOLD_A, p))
    # 末端亚像素补线（trail 里最后一点 → 浮点位置）
    d.line([xr(i), ya(MACD_A[i]), ax, ay], fill=STRAT_C, width=3)
    d.line([xr(i), ya(HOLD_A[i]), ax, hy], fill=HOLD_C, width=3)
    d.ellipse([ax - 7, ay - 7, ax + 7, ay + 7], fill=STRAT_C)
    d.ellipse([hx - 7, hy - 7, hx + 7, hy + 7], fill=HOLD_C)
    d.ellipse([ax - 7, ay - 7, ax + 7, ay + 7], fill=STRAT_C)
    d.ellipse([hx - 7, hy - 7, hx + 7, hy + 7], fill=HOLD_C)
    info_card(d, i)                # 4) 浮层面板最后画（悬浮语义，永不被涂抹）
    draw_key_labels(d)             # 5) 关键事件标签（避让浮板/图例）最后画
    progress(d, i)
    # 副图当前指标点（与主图播放头同一 x —— 供 X 轴同步验收断言）
    vd, va_ = interp_series(DIF, p), interp_series(DEA, p)
    sub_pos = [round(ax, 3), round(sy(vd), 3)] if vd is not None else None
    sub_dea_pos = [round(ax, 3), round(sy(va_), 3)] if va_ is not None else None
    FRAME_DATA.append({
        "dayIndex": i, "t": round(p, 4), "date": rows[i]["date"],
        "macd_asset_text": "¥ " + money2(float(rows[i]["macd_asset"])),
        "hold_asset_text": "¥ " + money2(float(rows[i]["hold_asset"])),
        "holding": int(float(rows[i]["macd_shares"])) > 0,
        "trades_done": cum_trades[i],
        "macd_pos": [round(ax, 3), round(ay, 3)], "hold_pos": [round(hx, 3), round(hy, 3)],
        "sub_pos": sub_pos, "sub_dea_pos": sub_dea_pos, "sub_date": rows[i]["date"],
        "dif": DIF[i], "dea": DEA[i], "hist": HIST[i],
    })
    return im


# ---------- 编码 ----------
OUT = os.path.join(OUT_DIR, "video.mp4")
LOG = os.path.join(OUT_DIR, "_ffmpeg.log")
cmd = [
    FF, "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "{}x{}".format(OUT_W, OUT_H), "-r", str(FPS), "-i", "pipe:0",
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate={}".format(ENC["sample_rate"]),
    "-c:v", "libx264", "-preset", ENC["preset"], "-crf", str(ENC["crf"]),
    "-pix_fmt", ENC["pixel_format"],
    "-c:a", "aac", "-b:a", ENC["audio_bitrate"], "-shortest", "-movflags", "+faststart",
    "-metadata", "title=" + ENC["title"], OUT,
]
logf = open(LOG, "w", encoding="utf-8")
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=logf)


def push(im):
    if (OUT_W, OUT_H) != (W, H):
        s = min(OUT_W / W, OUT_H / H)
        nw, nh = max(1, round(W * s)), max(1, round(H * s))
        im = im.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new("RGB", (OUT_W, OUT_H), (0, 0, 0))
        canvas.paste(im, ((OUT_W - nw) // 2, (OUT_H - nh) // 2))
        im = canvas
    proc.stdin.write(im.tobytes())


trail = BASE.copy()
td = ImageDraw.Draw(trail)
total = 0
first_frame = last_frame = None

for f in range(INTRO):
    if f < FI:
        push(Image.blend(BLACK, INTRO_IMG, f / FI))
    elif f >= INTRO - FO:
        push(Image.blend(INTRO_IMG, BASE, (f - (INTRO - FO) + 1) / (FO + 1)))
    else:
        push(INTRO_IMG)
    total += 1

last = -1
for fi in range(MAIN):
    p = POS[fi]                     # 浮点位置（V1.2.2）
    i = int(math.floor(p))
    if last < 0:
        for x0, y0, c in [(xr(0), ya(MACD_A[0]), STRAT_C),
                          (xr(0), ya(HOLD_A[0]), HOLD_C)]:
            td.ellipse([x0 - 5, y0 - 5, x0 + 5, y0 + 5], fill=c)
    else:
        # trail 只累积整数交易日段；不足 1 日的余量由 render_frame 补亚像素插值
        for k in range(last + 1, i + 1):
            td.line([xr(k - 1), ya(MACD_A[k - 1]), xr(k), ya(MACD_A[k])], fill=STRAT_C, width=3)
            td.line([xr(k - 1), ya(HOLD_A[k - 1]), xr(k), ya(HOLD_A[k])], fill=HOLD_C, width=3)
    fr = render_frame(trail, p)
    if i in KEY_IDX and i not in DUMPED:
        fr.save(os.path.join(KF_DIR, "kf_%s.png" % KEY_IDX[i]))
        DUMPED.add(i)
    push(fr)
    if first_frame is None:
        first_frame = fr
    last_frame = fr
    last = i
    total += 1
    if fi % 200 == 0:
        print("  主段 {}/{}  t={:.2f} 第 {} 天 {}".format(fi, MAIN, p, i, rows[i]["date"]), flush=True)

# 片尾：先淡到底色（曲线与文字同时消失，杜绝叠影），再淡入结果页
for f in range(OUTRO):
    if f < ODIP:
        push(Image.blend(last_frame, DIP, (f + 1) / (ODIP + 1)))
    elif f < ODIP + OO:
        push(Image.blend(DIP, OUTRO_IMG, (f - ODIP + 1) / (OO + 1)))
    else:
        push(OUTRO_IMG)
    total += 1

proc.stdin.close()
rc = proc.wait()
logf.close()
print("ffmpeg 退出码", rc)
if rc != 0:
    print(open(LOG, encoding="utf-8").read()[-2000:])
    sys.exit(1)

size = os.path.getsize(OUT) / 1048576
sha = hashlib.sha256(open(OUT, "rb").read()).hexdigest()
report = {
    "run": RUN, "sourceRun": SRC_RUN, "backtestDir": BT_DIR_NAME, "output": OUT,
    "version": "v1.2.3",
    "frames": total, "durationSec": round(total / FPS, 2),
    "width": OUT_W, "height": OUT_H, "fps": FPS, "fileMB": round(size, 3), "sha256": sha,
    "introFrames": INTRO, "mainFrames": MAIN, "outroFrames": OUTRO,
    "tradingDays": N, "assetMax": AMAX, "assetTicks": TICKS, "peakUsed": PEAK,
    "axisMode": "shared-full-both",
    "geometry": {"left": L, "right": R, "mainTop": MT, "mainBottom": MB,
                 "subTop": ST, "subBottom": SB,
                 "subAxis": "full-history (same xr mapping as main, no rolling window)",
                 "panel": {"x1": CARD_X1, "x2": CARD_X2, "y1": CARD_Y1,
                           "height": PANEL_H_MAX, "anchor": PANEL_ANCHOR,
                           "rowHeight": PANEL_ROW_H, "pad": PANEL_PAD,
                           "recentEventDays": RECENT_EVENT_DAYS},
                 "occCell": OCC_CELL, "fadeWindow": FADE_WINDOW},
    "macdFinal": MACD["final"], "holdFinal": HOLD["final"], "zeroFeeFinal": (ZF or {}).get("final"),
    "macdMaxDD": MACD["maxDD"], "holdMaxDD": HOLD["maxDD"],
    "macdTrades": MACD["tradeCount"], "macdBuys": MACD["buyCount"], "macdSells": MACD["sellCount"],
    "signalCount": len(SIGNALS), "execCount": len(EXEC_EV),
    "macdIndicator": {"source": "02_backtest_macd/macd.csv", "amax": MAMAX,
                      "ticks": MTICKS, "emptyLeading": sum(1 for v in DIF if v is None),
                      "histogram": "per-pixel min/max envelope (values untouched)"},
    "templateCheck": TEMPLATE_CHECK,
    "renderedCopy": RENDERED,
    "suppressed": SUPPRESS,
    "transitions": {"outro": "dip-to-bg", "dipFrames": ODIP, "inFrames": OO},
    "labelAvoid": ["panel", "legend-row", "canvas-edges"],
    "keyEvents": sorted(KEY_INDEX_SET),
    "timeline": "video_events.build_smooth_timeline (float + cosine kernel + density-adaptive)",
    "timelineCfg": TL_CFG,
    "smoothness": SMOOTH,
}
with open(os.path.join(OUT_DIR, "render_report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
with open(os.path.join(OUT_DIR, "frame_data.json"), "w", encoding="utf-8") as f:
    json.dump({"geometry": report["geometry"], "assetMax": AMAX, "tradingDays": N,
               "frames": FRAME_DATA}, f, ensure_ascii=False, indent=1)

print("完成: {} 帧 / {:.1f} 秒 @{}fps / {:.2f} MB".format(total, total / FPS, FPS, size))
print("主图刻度 {}（上限 {:.0f}）；副图 ±{:.3f}（对称、全域横轴）".format(TICKS, AMAX, MAMAX))
print("模板检查：{} 条 copy 全部替换成功".format(TEMPLATE_CHECK["strings"]))
print("防重叠抑制：主图 {} 次 / 副图 {} 次（数据侧未删除任何事件）".format(SUPPRESS["main"], SUPPRESS["sub"]))
print("MACD ¥{:.2f} vs 持有 ¥{:.2f}；信号 {} / 成交 {}；重点事件 {} 个慢放".format(
    MACD["final"], HOLD["final"], len(SIGNALS), len(EXEC_EV), len(KEY_INDEX_SET)))
print("输出:", OUT)
