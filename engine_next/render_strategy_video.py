# -*- coding: utf-8 -*-
"""通用策略回测视频渲染器（V0.1）。

只读一份 `backtest_result.json`，不联网、不读原始 CSV、不认识具体策略实现：
  - market  → 价格曲线与买卖点
  - equity  → 策略资产曲线、回撤与当前资产
  - trades  → 买卖标记与累计费用
  - metrics → 期末指标与买入持有对照
  - strategy/state → 标题、区间、参数与数据口径

设计约束：
  1. 所有数字都来自结果文件，不在渲染阶段重算收益/回撤；
     唯一派生量是“当前时点之前已发生交易的累计费用”，且逐笔相加。
  2. 画面遵循 A 股习惯：买入红、卖出绿。
  3. 不写当前时间；同一份结果重复出片必须逐字节一致。
  4. 页脚必须保留来源、复权口径、结果指纹与免责声明。

用法：
  python engine_next/render_strategy_video.py --result <backtest_result.json> --out <dir>
"""

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for cand in (os.path.join(ROOT, "deps"),):
    if os.path.isdir(cand) and cand not in sys.path:
        sys.path.insert(0, cand)

from PIL import Image, ImageDraw, ImageFont  # noqa: E402
import imageio_ffmpeg  # noqa: E402

W, H = 1920, 1080
FPS = 30
FRAMES = 720  # 24 秒

BG = (13, 17, 23)
PANEL = (18, 23, 30)
PANEL2 = (22, 28, 37)
GRID = (38, 46, 58)
TEXT = (232, 236, 242)
MUTED = (150, 160, 175)
FAINT = (108, 118, 132)
BLUE = (106, 169, 255)
GOLD = (227, 176, 75)
RED = (240, 90, 90)
GREEN = (56, 180, 139)
HOLD_FILL = (24, 37, 52)
PRICE_FILL = (17, 30, 48)
EQUITY_FILL = (38, 33, 22)

# 主图 / 资产图 / 右侧摘要
PX0, PX1 = 118, 1180
PY0, PY1 = 232, 628
EX0, EX1 = 118, 1180
EY0, EY1 = 704, 916
SX0, SX1 = 1240, 1816
SY0, SY1 = 206, 916

FONT_CACHE = {}
FONT_ORDER = ("msyh.ttc", "msyhbd.ttc", "simhei.ttf")


def font(size, bold=False):
    key = (size, bold)
    if key not in FONT_CACHE:
        order = ("msyhbd.ttc", "msyh.ttc", "simhei.ttf") if bold else FONT_ORDER
        for name in order:
            try:
                FONT_CACHE[key] = ImageFont.truetype(name, size, index=0)
                break
            except Exception:
                continue
        if key not in FONT_CACHE:
            try:
                FONT_CACHE[key] = ImageFont.truetype("DejaVuSans.ttf", size)
            except Exception:
                FONT_CACHE[key] = ImageFont.load_default(size=size)
    return FONT_CACHE[key]


def txt(d, xy, s, size, color=TEXT, bold=False, anchor=None):
    d.text(xy, s, font=font(size, bold), fill=color, anchor=anchor)


def fit_text(d, s, size, max_w, suffix="…"):
    if d.textlength(s, font=font(size)) <= max_w:
        return s
    while s and d.textlength(s + suffix, font=font(size)) > max_w:
        s = s[:-1]
    return (s + suffix) if s else ""


def fmt_money(v):
    if v is None:
        return "—"
    return "{:,.2f}".format(v)


def fmt_money_short(v):
    a = abs(v)
    if a >= 100000000:
        return "{:.2f}亿".format(v / 100000000.0)
    if a >= 10000:
        return "{:.1f}万".format(v / 10000.0)
    return "{:,.0f}".format(v)


def fmt_price(v):
    if abs(v) >= 1000:
        return "{:,.0f}".format(v)
    if abs(v) >= 100:
        return "{:.1f}".format(v)
    return "{:.2f}".format(v)


def pct(v, sign=True):
    if v is None:
        return "—"
    return ("{:+.2f}" if sign else "{:.2f}").format(v * 100.0) + "%"


def nice_step(raw):
    if raw <= 0:
        return 1.0
    exp = math.floor(math.log10(raw))
    base = raw / (10 ** exp)
    for m in (1.0, 2.0, 2.5, 5.0, 10.0):
        if base <= m:
            return m * (10 ** exp)
    return 10.0 ** (exp + 1)


def make_axis(vmin, vmax, target=5, margin=0.10):
    if vmin == vmax:
        vmin -= 1.0
        vmax += 1.0
    span = vmax - vmin
    lo = vmin - span * margin
    hi = vmax + span * margin
    step = nice_step((hi - lo) / target)
    lo = math.floor(lo / step) * step
    hi = math.ceil(hi / step) * step
    ticks = []
    v = lo
    while v <= hi + step * 1e-6:
        ticks.append(round(v, 10))
        v += step
    return lo, hi, ticks


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


def rrect(d, box, fill=None, outline=None, width=2, radius=14):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def dashed_line(d, xy, fill, width=2, dash=10, gap=8):
    x0, y0, x1, y1 = xy
    if y0 == y1:
        x = x0
        while x < x1:
            d.line([x, y0, min(x + dash, x1), y0], fill=fill, width=width)
            x += dash + gap
    else:
        y = y0
        while y < y1:
            d.line([x0, y, x0, min(y + dash, y1)], fill=fill, width=width)
            y += dash + gap


def source_label(source):
    return {
        "eastmoney-push2his": "东方财富",
        "pytdx-TdxHq": "通达信（pytdx）",
        "USER_CSV": "用户 CSV",
    }.get(source, source or "未声明")


def strategy_label(card):
    sid = card.get("id")
    if sid == "close_buy_open_sell":
        return "尾盘买入 · 次日开盘卖出"
    if sid == "macd_cross":
        return "MACD 金叉 / 死叉"
    return card.get("name") or sid or "自定义策略"


def params_label(card):
    p = card.get("params") or {}
    if card.get("id") == "macd_cross":
        return "MACD {} / {} / {}".format(p.get("fast", 12), p.get("slow", 26), p.get("signal", 9))
    if card.get("id") == "close_buy_open_sell":
        entry = {"macd_golden": "MACD 金叉入场", "always": "每交易日入场", "none": "不新开仓"}.get(
            p.get("entrySignal", "always"), str(p.get("entrySignal")))
        af = p.get("auctionFilter")
        if af and af.get("basis") == "open_gap_pct":
            return "{} · 开盘跳空≥{:.0%} 继续持有".format(entry, float(af.get("holdIfGte", 0)))
        return entry
    return ""


def load_and_align(path):
    with open(path, encoding="utf-8") as f:
        r = json.load(f)
    for key in ("strategy", "state", "market", "equity", "trades", "metrics", "reproducibility"):
        if key not in r:
            raise SystemExit("结果缺少字段：{}".format(key))
    market = r["market"]
    equity = r["equity"]
    if not market:
        raise SystemExit("market 为空：旧结果不含行情序列，请用当前策略引擎重新生成。")
    eq_by_date = {}
    for e in equity:
        eq_by_date[e["date"]] = e
    bars, eq = [], []
    for b in sorted(market, key=lambda x: x["date"]):
        if b["date"] in eq_by_date:
            bars.append(b)
            eq.append(eq_by_date[b["date"]])
    if len(bars) < 2:
        raise SystemExit("market 与 equity 没有足够的共同日期。")

    initial = None
    ex = (r.get("strategy") or {}).get("execution") or {}
    if isinstance(ex.get("initialCapital"), (int, float)):
        initial = float(ex["initialCapital"])
    if initial is None:
        initial = float(eq[0]["asset"])

    trades = []
    by_date = {b["date"]: i for i, b in enumerate(bars)}
    for t in r.get("trades") or []:
        idx = by_date.get(t.get("date"))
        if idx is None:
            continue
        trades.append({
            "seq": t.get("seq"),
            "side": t.get("side"),
            "date": t["date"],
            "price": float(t["price"]),
            "fee": float(t.get("fee") or 0.0) + float(t.get("dividendTax") or 0.0),
            "idx": idx,
        })
    trades.sort(key=lambda x: (x["idx"], x["seq"] or 0))
    return r, bars, eq, trades, initial


def build_state(r, bars, eq, trades, initial):
    closes = [float(b["close"]) for b in bars]
    assets = [float(e["asset"]) for e in eq]
    pmin, pmax = min(float(b["low"]) for b in bars), max(float(b["high"]) for b in bars)
    plo, phi, pticks = make_axis(pmin, pmax, target=5, margin=0.06)
    elo, ehi, eticks = make_axis(min(assets), max(assets), target=4, margin=0.10)
    if elo > initial:
        elo = initial - (ehi - elo) * 0.1
    if ehi < initial:
        ehi = initial + (ehi - elo) * 0.1
    elo, ehi, eticks = make_axis(elo, ehi, target=4, margin=0.04)

    n = len(bars)

    def x_at(i):
        if n <= 1:
            return PX0
        return PX0 + (PX1 - PX0) * (i / float(n - 1))

    def y_price(v):
        if phi == plo:
            return (PY0 + PY1) / 2.0
        return PY1 - (v - plo) / (phi - plo) * (PY1 - PY0)

    def y_equity(v):
        if ehi == elo:
            return (EY0 + EY1) / 2.0
        return EY1 - (v - elo) / (ehi - elo) * (EY1 - EY0)

    # 持仓区间（连续 shares>0 的段），用于主图底色
    runs = []
    start = None
    for i, e in enumerate(eq):
        held = float(e.get("shares") or 0) > 0
        if held and start is None:
            start = i
        elif not held and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, n - 1))

    return {
        "r": r,
        "bars": bars,
        "eq": eq,
        "trades": trades,
        "initial": initial,
        "n": n,
        "closes": closes,
        "assets": assets,
        "plo": plo, "phi": phi, "pticks": pticks,
        "elo": elo, "ehi": ehi, "eticks": eticks,
        "x": x_at,
        "yp": y_price,
        "ye": y_equity,
        "runs": runs,
    }


def draw_base(st):
    r = st["r"]
    card = r["strategy"]
    state = r["state"]
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)

    # 顶部
    title = card.get("name") or strategy_label(card)
    txt(d, (100, 54), fit_text(d, title, 46, 1320), 46, TEXT, bold=True)
    sub = "{} {} · {} → {} · {} 个交易日".format(
        card.get("symbol", ""), card.get("nameOfSecurity", ""),
        state.get("start", ""), state.get("end", ""), st["n"])
    txt(d, (102, 124), fit_text(d, sub, 25, 1360), 25, MUTED)

    badge = "策略回测"
    bw = d.textlength(badge, font=font(22, True)) + 36
    rrect(d, [1816 - bw, 58, 1816, 104], fill=(28, 52, 78), outline=(52, 96, 140), radius=22)
    txt(d, (1816 - bw / 2, 81), badge, 22, (150, 200, 245), bold=True, anchor="mm")

    d.line([100, 174, 1816, 174], fill=GRID, width=2)

    # 主图面板
    rrect(d, [PX0 - 18, PY0 - 30, PX1 + 18, PY1 + 46], fill=PANEL, outline=(30, 39, 51), radius=16)
    txt(d, (PX0, PY0 - 20), "股价走势（未复权）", 22, MUTED)
    txt(d, (PX1, PY0 - 20), "▲ 买入    ▼ 卖出", 19, FAINT, anchor="ra")

    # 主图网格与刻度
    for v in st["pticks"]:
        y = st["yp"](v)
        d.line([PX0, y, PX1, y], fill=GRID, width=1)
        txt(d, (PX0 - 12, y), fmt_price(v), 19, FAINT, anchor="rm")

    # 资产图面板
    rrect(d, [EX0 - 18, EY0 - 32, EX1 + 18, EY1 + 44], fill=PANEL, outline=(30, 39, 51), radius=16)
    txt(d, (EX0, EY0 - 22), "策略资产", 22, MUTED)
    txt(d, (EX1, EY0 - 22), "初始资金 " + fmt_money(st["initial"]), 19, FAINT, anchor="ra")
    for v in st["eticks"]:
        y = st["ye"](v)
        d.line([EX0, y, EX1, y], fill=GRID, width=1)
        txt(d, (EX0 - 12, y), fmt_money_short(v), 19, FAINT, anchor="rm")

    # X 轴日期（主图与资产图共用同一索引映射；只在最下方画一次）
    n = st["n"]
    for k in range(5):
        i = int(round((n - 1) * k / 4.0))
        x = st["x"](i)
        label = st["bars"][i]["date"][:7]
        anchor = "mt"
        if k == 0:
            anchor = "lt"
        elif k == 4:
            anchor = "rt"
        txt(d, (x, EY1 + 16), label, 18, FAINT, anchor=anchor)

    # 右侧摘要面板
    rrect(d, [SX0, SY0, SX1, SY1], fill=PANEL2, outline=(32, 42, 56), radius=18)
    txt(d, (SX0 + 26, SY0 + 22), "策略摘要", 22, MUTED)

    # 页脚
    d.line([100, 962, 1816, 962], fill=GRID, width=2)
    src = source_label((card.get("data") or {}).get("source"))
    adjust = (card.get("data") or {}).get("adjust", "none")
    div = (card.get("data") or {}).get("dividendPolicy", "ignored")
    sha = (r.get("reproducibility") or {}).get("resultSha256") or ""
    left = "数据：{} · adjust={} · {} · 结果 sha256:{}".format(
        src, adjust, "含分红表" if div == "provided" else "不含现金分红", sha[:12])
    txt(d, (100, 978), fit_text(d, left, 21, 1710), 21, MUTED)
    txt(d, (100, 1014),
        "历史回测不代表未来收益，不构成投资建议；画面数字均来自同一份 backtest_result.json。",
        19, FAINT)
    txt(d, (1816, 1014), "StrategyToVideo", 19, FAINT, anchor="ra")
    return im


def _interp(vals, i):
    n = len(vals)
    if i <= 0:
        return vals[0]
    if i >= n - 1:
        return vals[-1]
    k = int(math.floor(i))
    a = i - k
    return vals[k] + (vals[k + 1] - vals[k]) * a


def _polyline(d, st, vals, yfunc, p, color, width=3, x0=None, x1=None):
    n = st["n"]
    i = p * (n - 1)
    k = int(math.floor(i))
    pts = []
    for j in range(0, k + 1):
        pts.append((st["x"](j), yfunc(vals[j])))
    if k < n - 1:
        pts.append((st["x"](i), yfunc(_interp(vals, i))))
    if len(pts) >= 2:
        d.line(pts, fill=color, width=width, joint="curve")
    return pts


def draw_marker(d, x, y, side, scale=1.0):
    r = 11 * scale
    if side == "BUY":
        pts = [(x, y - r), (x - r * 0.9, y + r * 0.55), (x + r * 0.9, y + r * 0.55)]
        fill = RED
    else:
        pts = [(x, y + r), (x - r * 0.9, y - r * 0.55), (x + r * 0.9, y - r * 0.55)]
        fill = GREEN
    d.polygon(pts, fill=fill, outline=(250, 250, 250))


def draw_callout(d, st, trade, p):
    if trade is None:
        return
    x = st["x"](trade["idx"])
    y = st["yp"](trade["price"])
    label = "{} {} · {}".format("买入" if trade["side"] == "BUY" else "卖出",
                               trade["date"], fmt_price(trade["price"]))
    size = 19
    tw = d.textlength(label, font=font(size))
    bw, bh = tw + 26, 38
    if x + 18 + bw < PX1:
        bx = x + 18
    else:
        bx = x - bw - 18
    if y - 58 > PY0:
        by = y - 58
    else:
        by = y + 22
    bx = max(PX0 + 4, min(bx, PX1 - bw - 4))
    by = max(PY0 + 4, min(by, PY1 - bh - 4))
    rrect(d, [bx, by, bx + bw, by + bh], fill=(30, 38, 50), outline=(64, 78, 96), radius=9)
    txt(d, (bx + 13, by + 19), label, size,
        RED if trade["side"] == "BUY" else GREEN, bold=True, anchor="lm")
    # 指向标记的短线
    mx = max(bx, min(x, bx + bw))
    my = by + bh if by < y else by
    d.line([mx, my, x, y], fill=(92, 106, 124), width=1)


def draw_frame(st, base, p, f):
    im = base.copy()
    d = ImageDraw.Draw(im)
    r = st["r"]
    n = st["n"]
    i = p * (n - 1)
    k = int(math.floor(i))

    # 持仓区间底色（先画，避免盖住曲线）
    for a, b in st["runs"]:
        if a > i:
            continue
        xa = st["x"](a)
        xb = st["x"](min(b, i))
        if xb > xa:
            d.rectangle([xa, PY0, xb, PY1], fill=HOLD_FILL)

    # 价格曲线填充与折线
    if i > 0:
        pts = []
        for j in range(0, k + 1):
            pts.append((st["x"](j), st["yp"](st["closes"][j])))
        pts.append((st["x"](i), st["yp"](_interp(st["closes"], i))))
        if len(pts) >= 2:
            area = [(st["x"](0), PY1)] + pts + [(st["x"](i), PY1)]
            d.polygon(area, fill=PRICE_FILL)
    _polyline(d, st, st["closes"], st["yp"], p, BLUE, width=3)

    # 资产曲线
    if i > 0:
        pts = []
        for j in range(0, k + 1):
            pts.append((st["x"](j), st["ye"](st["assets"][j])))
        pts.append((st["x"](i), st["ye"](_interp(st["assets"], i))))
        if len(pts) >= 2:
            area = [(st["x"](0), EY1)] + pts + [(st["x"](i), EY1)]
            d.polygon(area, fill=EQUITY_FILL)
    dashed_line(d, (EX0, st["ye"](st["initial"]), EX1, st["ye"](st["initial"])),
                (94, 82, 52), width=1, dash=8, gap=7)
    _polyline(d, st, st["assets"], st["ye"], p, GOLD, width=3)

    # 买卖标记
    shown = [t for t in st["trades"] if t["idx"] <= i]
    for t in shown:
        draw_marker(d, st["x"](t["idx"]), st["yp"](t["price"]), t["side"])

    # 当前点
    cx = st["x"](i)
    cprice = _interp(st["closes"], i)
    cy = st["yp"](cprice)
    d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=BLUE, outline=(235, 245, 255), width=2)
    casset = _interp(st["assets"], i)
    ey = st["ye"](casset)
    d.ellipse([cx - 6, ey - 6, cx + 6, ey + 6], fill=GOLD, outline=(255, 245, 220), width=2)

    # 当前价标签
    tag = fmt_price(cprice)
    tw = d.textlength(tag, font=font(18, True)) + 18
    tx = cx + 12 if cx + 12 + tw < PX1 else cx - tw - 12
    ty = max(PY0 + 2, min(cy - 30, PY1 - 30))
    rrect(d, [tx, ty, tx + tw, ty + 28], fill=(20, 34, 52), outline=(66, 100, 140), radius=7)
    txt(d, (tx + tw / 2, ty + 14), tag, 18, (190, 220, 255), bold=True, anchor="mm")

    # 顶部当前日期
    cur_date = st["bars"][min(k, n - 1)]["date"]
    txt(d, (1816, 124), "当前 " + cur_date, 23, MUTED, anchor="ra")

    # 最近一次买卖说明
    draw_callout(d, st, shown[-1] if shown else None, p)

    # 进度条（贴近主图下沿，避免压到资产图标题）
    bar_y = 634
    d.line([PX0, bar_y, PX1, bar_y], fill=(34, 42, 54), width=4)
    d.line([PX0, bar_y, PX0 + (PX1 - PX0) * p, bar_y], fill=BLUE, width=4)
    txt(d, (PX0, bar_y + 7), "第 {} / {} 个交易日".format(min(k + 1, n), n), 18, FAINT)
    txt(d, (PX1, bar_y + 7), "持仓区间以浅蓝底色标出", 18, FAINT, anchor="ra")

    draw_side_panel(d, st, i, p)
    return im


def draw_side_panel(d, st, i, p):
    r = st["r"]
    card = r["strategy"]
    metrics = r["metrics"]
    n = st["n"]
    idx = max(0, min(int(math.floor(i)), n - 1))
    is_end = i >= n - 1 - 1e-9
    eq = st["eq"][idx]
    asset = float(eq["asset"])
    ret = asset / st["initial"] - 1.0
    shown_trades = [t for t in st["trades"] if t["idx"] <= i]
    fees = sum(t["fee"] for t in shown_trades)
    maxdd = float(eq.get("drawdown") or 0.0)

    x = SX0 + 26
    xr = SX1 - 26
    txt(d, (x, SY0 + 58), "期末资产" if is_end else "当前资产", 21, MUTED)
    txt(d, (x, SY0 + 84), fmt_money(asset), 40, TEXT, bold=True)
    col = RED if ret > 0 else (GREEN if ret < 0 else MUTED)
    txt(d, (x, SY0 + 142), "累计收益 " + pct(ret), 24, col, bold=True)
    txt(d, (xr, SY0 + 142), "{} 笔交易".format(len(shown_trades)), 21, MUTED, anchor="ra")

    d.line([x, SY0 + 184, xr, SY0 + 184], fill=(40, 50, 64), width=1)

    rows = [
        ("最大回撤", pct(-maxdd, sign=False)),
        ("累计费用", fmt_money(fees)),
        ("初始资金", fmt_money(st["initial"])),
        ("买入持有（期末）", fmt_money((metrics.get("benchmark") or {}).get("final"))),
    ]
    y = SY0 + 206
    for label, value in rows:
        txt(d, (x, y), label, 20, MUTED)
        txt(d, (xr, y), value, 20, TEXT, anchor="ra")
        y += 42

    d.line([x, y + 4, xr, y + 4], fill=(40, 50, 64), width=1)

    y += 24
    txt(d, (x, y), "策略设置", 21, MUTED)
    y += 32
    items = [
        ("标的", "{} {}".format(card.get("symbol", ""), card.get("nameOfSecurity", ""))),
        ("区间", "{} → {}".format((card.get("range") or {}).get("start", ""),
                                  (card.get("range") or {}).get("end", ""))),
        ("策略", strategy_label(card)),
        ("参数", params_label(card)),
        ("数据", "{} · {}".format(source_label((card.get("data") or {}).get("source")),
                                  "含分红" if (card.get("data") or {}).get("dividendPolicy") == "provided" else "不含分红")),
        ("指纹", ((r.get("reproducibility") or {}).get("resultSha256") or "")[:12]),
    ]
    for label, value in items:
        txt(d, (x, y), label, 18, FAINT)
        txt(d, (x + 62, y), fit_text(d, value, 18, xr - x - 62), 18, TEXT)
        y += 31


def main(argv=None):
    ap = argparse.ArgumentParser(description="通用策略回测视频渲染器")
    ap.add_argument("--result", required=True, help="backtest_result.json")
    ap.add_argument("--out", required=True, help="输出目录（写 video.mp4 / render_report.json）")
    ap.add_argument("--title", default="", help="可选标题覆盖")
    args = ap.parse_args(argv)

    r, bars, eq, trades, initial = load_and_align(args.result)
    if args.title:
        r["strategy"]["name"] = args.title
    st = build_state(r, bars, eq, trades, initial)
    base = draw_base(st)

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "video.mp4")
    log_path = os.path.join(args.out, "ffmpeg.log")
    ff = imageio_ffmpeg.get_ffmpeg_exe()

    cmd = [
        ff, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "{}x{}".format(W, H), "-r", str(FPS), "-i", "pipe:0",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart",
        "-metadata", "title=StrategyToVideo 策略回测 · {}".format(r["strategy"].get("name", "")),
        out_path,
    ]
    logf = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=logf)

    for f in range(FRAMES):
        # 前 30 帧为静止起手，最后 60 帧保留完整画面；中间 630 帧完成生长。
        p = ease((f - 30) / 630.0)
        im = draw_frame(st, base, p, f)
        proc.stdin.write(im.tobytes())
        if f % 120 == 0:
            print("  frame {}/{}".format(f, FRAMES), flush=True)

    proc.stdin.close()
    rc = proc.wait()
    logf.close()
    if rc != 0:
        print(open(log_path, encoding="utf-8").read()[-2000:])
        raise SystemExit("ffmpeg 退出码 {}".format(rc))

    with open(out_path, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    report = {
        "version": "strategy-video-v0.1",
        "resultSha256": (r.get("reproducibility") or {}).get("resultSha256"),
        "title": r["strategy"].get("name"),
        "strategyId": r["strategy"].get("id"),
        "symbol": r["strategy"].get("symbol"),
        "range": [r["state"].get("start"), r["state"].get("end")],
        "marketBars": len(bars),
        "trades": len(trades),
        "final": r["metrics"].get("final"),
        "totalReturn": r["metrics"].get("totalReturn"),
        "maxDD": r["metrics"].get("maxDD"),
        "width": W, "height": H, "fps": FPS,
        "frames": FRAMES, "durationSec": round(FRAMES / float(FPS), 3),
        "bytes": os.path.getsize(out_path),
        "sha256": sha,
        "encodings": {"video": "H.264 (libx264)", "audio": "AAC (静音轨)"},
    }
    with open(os.path.join(args.out, "render_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("完成 {} 帧 / {:.1f}s / {:.2f} MB".format(FRAMES, FRAMES / float(FPS), report["bytes"] / 1048576.0))
    print("sha256", sha)
    print("输出", out_path)


if __name__ == "__main__":
    main()
