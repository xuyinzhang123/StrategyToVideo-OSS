#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""============================================================================
 StrategyToVideo · V0.3 阶段 0 · 竖版「数据解剖」渲染器（spike）
 ---------------------------------------------------------------------------
 定位
   report.json（已算好的数字 + 版式意图）→ 1080x1920@30fps 帧 → MP4。
   渲染器只负责「把给定的数字摆到画面上」，不做任何统计、不连接网络。

 边界（V0.3 阶段 0 硬约束，违反即视为回归）
   1. 本文件是新增文件。不 import、不修改 render_stock_macd_v122.py /
      render_stock_macd_v123.py / render_generic_chart.py，四条出片链互不影响。
   2. 画幅、帧率、编码参数是本文件私有常量，不进任何公共默认值，
      改这里不会改变股票回测（v123）或通用图表（generic）的出片结果。
   3. 仅依赖 deps/ 里的 Pillow 13.0.0 + imageio-ffmpeg 0.8.1，不联网。

 版式词汇（阶段 0 覆盖样片全部 10 种）
   hook_number / dual_metrics / dot_matrix / dense_grid / bar_scale /
   split_bar / progress_sliver / decay_bars / row_list / outro

 用法
   python engine_next/render_story_v030.py --report spike/v03/report.simulated.json \
          --out output/v03_story/simulated
   可选：--storyboard <md>   生成分镜表
         --keyframes <dir>  导出每屏关键帧 PNG（供人工核对）
============================================================================"""
import argparse
import hashlib
import json
import math
import os
import random
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

# ---- 本文件私有画幅参数（不得抽成公共默认值）----
W, H = 1080, 1920
FPS = 30
MARGIN = 84                      # 左右安全边距
SAFE_TOP, SAFE_BOTTOM = 96, H - 150

# ---- 版式纵向锚点（基线 / 顶部）----
Y_LABEL = 330
Y_LEAD = 408
Y_CONC = 1330
Y_FOOT = 1500

DEFAULT_STYLE = {
    "bg_base": [16, 9, 12],
    "bg_glow": [62, 6, 9],
    "accent": [255, 34, 46],
    "accent2": [244, 186, 74],
    "text": [252, 249, 251],
    "text_dim": [152, 150, 155],
    "text_faint": [116, 114, 120],
    "block_light": [226, 225, 227],
    "track": [40, 34, 39],
}

FONT_CANDIDATES = {
    "bold": ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/simhei.ttf",
             "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc"],
    "reg": ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"],
}

_FONT_CACHE = {}
_FONT_PATHS = {}


# --------------------------------------------------------------------------
# 基础设施
# --------------------------------------------------------------------------
def resolve_fonts():
    """定位字体；找不到中文粗体就直接失败，不做静默降级（否则会出豆腐块）。"""
    for key, cands in FONT_CANDIDATES.items():
        for p in cands:
            if os.path.exists(p):
                _FONT_PATHS[key] = p
                break
        if key not in _FONT_PATHS:
            raise SystemExit("E_FONT_MISSING: 找不到 %s 字体，候选=%s" % (key, cands))


def F(kind, size):
    key = (kind, size)
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = ImageFont.truetype(_FONT_PATHS[kind], size)
    return _FONT_CACHE[key]


def text_w(font, s):
    box = font.getbbox(s)
    return box[2] - box[0]


def fit(s, kind, max_w, size, min_size=18, step=2):
    """把文字塞进 max_w：从 size 往下压字号，返回能放下的字体。"""
    sz = size
    while sz > min_size:
        f = F(kind, sz)
        if text_w(f, s) <= max_w:
            return f, sz
        sz -= step
    return F(kind, min_size), min_size


def fit_lines(lines, kind, max_w, size, min_size=18):
    """多行取最小可用字号，保证各行同一字号。"""
    sz = size
    while sz > min_size:
        f = F(kind, sz)
        if all(text_w(f, s) <= max_w for s in lines):
            return f, sz
        sz -= 2
    return F(kind, min_size), min_size


def make_bg(style):
    """径向红光 + 暗底。四分之一分辨率生成再放大，避免逐帧重复计算。
    光心位置与衰减幂按参考样片实测像素反推（峰值 ≈ (78,14,21) @ (540,1000)）。"""
    sw, sh = W // 4, H // 4
    small = Image.new("RGB", (sw, sh), tuple(style["bg_base"]))
    px = small.load()
    cx, cy = sw * 0.5, sh * 0.52
    radius = (W * 0.56) / 4.0
    base = style["bg_base"]
    glow = style["bg_glow"]
    for y in range(sh):
        for x in range(sw):
            d = math.hypot(x - cx, y - cy) / radius
            k = max(0.0, 1.0 - d) ** 2.2
            px[x, y] = (
                min(255, int(base[0] + glow[0] * k)),
                min(255, int(base[1] + glow[1] * k)),
                min(255, int(base[2] + glow[2] * k)),
            )
    return small.resize((W, H), Image.BICUBIC)


def ease(p):
    p = max(0.0, min(1.0, p))
    return 1.0 - (1.0 - p) ** 3


def seg(t, a, b):
    """把整屏进度 t 映射到 [a,b] 区间的局部进度。"""
    if b <= a:
        return 1.0
    return max(0.0, min(1.0, (t - a) / (b - a)))


_COUNT_UP = True


def anim_number(display, p):
    """数字滚动。保留 <、>、逗号位、小数位等原始格式，只缩放数值部分。

    report.meta.motion.countUp=false 时直接返回终值——滚动过程中画面会短暂
    出现不等于终值的数字，需要「任何一帧都可截图当证据」时就关掉它。
    """
    if not _COUNT_UP or p >= 1.0:
        return display
    m = re.search(r"(\d[\d,]*(?:\.\d+)?)", display)
    if not m:
        return display
    raw = m.group(1)
    target = float(raw.replace(",", ""))
    dec = len(raw.split(".")[1]) if "." in raw else 0
    has_comma = "," in raw
    cur = target * ease(p)
    if dec == 0:
        out = str(int(round(cur)))
    else:
        out = ("%." + str(dec) + "f") % cur
    if has_comma and dec == 0:
        out = "{:,}".format(int(out))
    return display[: m.start()] + out + display[m.end():]


def draw_text(dr, xy, s, font, fill, anchor="ls"):
    dr.text(xy, s, font=font, fill=tuple(fill), anchor=anchor)


def hline(dr, x0, x1, y, fill, width=2):
    dr.line([(x0, y), (x1, y)], fill=tuple(fill), width=width)


def rrect(dr, box, r, fill):
    dr.rounded_rectangle(box, radius=r, fill=tuple(fill))


# --------------------------------------------------------------------------
# 共用积木
# --------------------------------------------------------------------------
def footer(dr, sc, meta, style):
    text = (meta.get("provenance") or {}).get("footer", "")
    if not text:
        return
    f, _ = fit(text, "reg", W - 2 * MARGIN, 24, 15)
    draw_text(dr, (MARGIN, Y_FOOT), text, f, style["text_faint"])


def chapter_label(dr, sc, style, p=1.0):
    """'01 · 池子'：左侧竖条 + 序号红 + 标题白。"""
    if not sc.get("label"):
        return
    a = ease(p)
    x = MARGIN
    dr.rectangle([x, Y_LABEL - 26, x + 5, Y_LABEL + 4], fill=tuple(style["accent"]))
    f_num = F("bold", 30)
    draw_text(dr, (x + 20, Y_LABEL), sc["label"], f_num, style["accent"])
    if sc.get("title"):
        f_t = F("bold", 30)
        ox = x + 20 + text_w(f_num, sc["label"]) + 14
        draw_text(dr, (ox, Y_LABEL), "· " + sc["title"], f_t,
                  [int(c * a) for c in style["text"]])


def lead_line(dr, sc, style, p=1.0):
    if not sc.get("lead"):
        return
    text = sc["lead"]
    f, _ = fit(text, "reg", W - 2 * MARGIN, 38)
    draw_text(dr, (MARGIN, Y_LEAD), text, f, style["text"])


def big_number(dr, cx, cy, value, unit, style, size=170, color=None, unit_size=None,
               p=1.0, anchor="ms", unit_color=None):
    """巨数字 + 单位。value 先滚动，单位跟着数字末尾排。"""
    if color is None:
        color = style["text"]
    if unit_color is None:
        unit_color = color
    shown = anim_number(value, p)
    fs = size
    fu = unit_size or int(size * 0.42)
    fv = F("bold", fs)
    fn = F("bold", fu)
    total = text_w(fv, shown) + (text_w(fn, unit) + 12 if unit else 0)
    limit = W - 2 * MARGIN
    while total > limit and fs > 40:
        fs -= 4
        fu = int(fs * 0.42)
        fv = F("bold", fs)
        fn = F("bold", fu)
        total = text_w(fv, shown) + (text_w(fn, unit) + 12 if unit else 0)
    x = cx - total / 2 if anchor == "ms" else cx
    draw_text(dr, (x, cy), shown, fv, color, anchor="ls")
    if unit:
        draw_text(dr, (x + text_w(fv, shown) + 12, cy), unit, fn, unit_color, anchor="ls")
    return total


def conclusion_block(dr, sc, style, y=Y_CONC, size=52, accent_line=None, p=1.0):
    lines = sc.get("conclusion") or []
    if not lines:
        return
    a = ease(p)
    f, _ = fit_lines(lines, "bold", W - 2 * MARGIN, size)
    lh = int(f.size * 1.42)
    if accent_line is None:
        accent_line = sc.get("conclusionAccentLine")
    for i, s in enumerate(lines):
        color = style["accent"] if i == accent_line else style["text"]
        color = [min(255, int(c * (0.35 + 0.65 * a))) for c in color]
        draw_text(dr, (MARGIN, y + i * lh), s, f, color)


def grid_visual(dr, sc, style, top, p=1.0):
    """1000 格点阵：亮格数量严格按比例算（不放大、不装饰性夸张）。"""
    g = sc.get("grid") or {}
    cols, rows = int(g.get("cols", 40)), int(g.get("rows", 25))
    lit = int(g.get("lit", 0))
    gap = (W - 2 * MARGIN) / cols
    cell = max(6.0, gap * 0.60)
    rng = random.Random(hashlib.md5(sc["id"].encode("utf-8")).hexdigest()[:8])
    lit_idx = set(rng.sample(range(cols * rows), min(lit, cols * rows)))
    total = cols * rows
    for i in range(total):
        cx = MARGIN + (i % cols + 0.5) * gap
        cy = top + (i // cols + 0.5) * gap
        frac = i / float(total)
        appear = ease(seg(p, frac * 0.35, frac * 0.35 + 0.35))
        if i in lit_idx:
            glow_p = ease(seg(p, 0.45, 1.0))
            if glow_p > 0:
                # 三层同心椭圆近似径向衰减，避免一整块实心红球
                for scale, tone in ((3.2, (30, 10, 14)), (2.2, (62, 11, 16)),
                                    (1.5, (120, 15, 24))):
                    r = cell * scale * (0.55 + 0.45 * glow_p)
                    dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tone)
            s = cell * (1.05 + 0.35 * glow_p)
            dr.rectangle([cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2],
                         fill=tuple(style["accent"]))
        else:
            v = 34 + int(16 * appear)
            dr.rectangle([cx - cell / 2, cy - cell / 2, cx + cell / 2, cy + cell / 2],
                         fill=(v, v - 2, v + 1))


# --------------------------------------------------------------------------
# 10 种版式
# --------------------------------------------------------------------------
def k_hook_number(img, dr, sc, style, t, meta):
    p = t
    if sc.get("eyebrow"):
        f, _ = fit(sc["eyebrow"], "reg", W - 2 * MARGIN - 40, 30)
        s = sc["eyebrow"]
        width = text_w(f, s)
        x = (W - (width + 30)) / 2
        dr.ellipse([x, 358, x + 9, 367], fill=tuple(style["accent"]))
        draw_text(dr, (x + 30, 372), s, f, style["text"])
    if sc.get("headline"):
        f, _ = fit(sc["headline"], "reg", W - 2 * MARGIN, 56)
        draw_text(dr, (W / 2, 660), sc["headline"], f, style["text"], anchor="ms")
    big_number(dr, W / 2, 952, sc.get("value", ""), sc.get("unit", ""), style,
               size=320, color=style["accent"], unit_size=118, p=seg(p, 0.05, 0.55))
    rule_p = ease(seg(p, 0.5, 0.95))
    if rule_p > 0:
        hw = int(200 * rule_p)
        hline(dr, W / 2 - hw, W / 2 + hw, 1082, style["accent"], 4)
    lines = sc.get("conclusion") or []
    if lines:
        f, _ = fit_lines(lines, "bold", W - 2 * MARGIN, 92)
        for i, s in enumerate(lines):
            draw_text(dr, (W / 2, 1190 + i * int(f.size * 1.2)), s, f,
                      style["text"], anchor="ms")


def k_dual_metrics(img, dr, sc, style, t, meta):
    chapter_label(dr, sc, style, seg(t, 0.0, 0.25))
    items = sc.get("items") or []
    base_y = 640
    step = 350
    for i, it in enumerate(items):
        cy = base_y + i * step
        vcol = it.get("valueColor")
        ucol = it.get("unitColor")
        if not vcol and not ucol:
            vcol = style["accent"] if it.get("accent") else style["accent2"]
            ucol = vcol
        big_number(dr, W / 2, cy, it.get("value", ""), it.get("unit", ""), style,
                   size=158, color=vcol or style["text"], unit_color=ucol,
                   unit_size=64, p=seg(t, 0.12 + i * 0.18, 0.5 + i * 0.18))
        if it.get("label"):
            f = F("reg", 34)
            draw_text(dr, (W / 2, cy + 60), it["label"], f, style["text_dim"],
                      anchor="ms")
        if i == 0 and len(items) > 1:
            hline(dr, W / 2 - 120, W / 2 + 120, cy + 160, [92, 40, 46], 2)


def k_dot_matrix(img, dr, sc, style, t, meta):
    chapter_label(dr, sc, style, seg(t, 0.0, 0.2))
    lead_line(dr, sc, style, seg(t, 0.05, 0.25))
    shown = anim_number(sc.get("value", ""), seg(t, 0.1, 0.5))
    fv = F("bold", 118)
    fu = F("bold", 44)
    fs = F("reg", 30)
    x = MARGIN
    draw_text(dr, (x, 545), shown, fv, style["text"])
    xx = x + text_w(fv, shown) + 14
    draw_text(dr, (xx, 545), sc.get("unit", ""), fu, style["text"])
    if sc.get("suffix"):
        draw_text(dr, (xx + text_w(fu, sc.get("unit", "")) + 14, 545), sc["suffix"],
                  fs, style["text_dim"])
    chip_p = ease(seg(t, 0.3, 0.6))
    if sc.get("chip") and chip_p > 0:
        fc = F("reg", 28)
        cw = text_w(fc, sc["chip"]) + 44
        cx1 = W - MARGIN
        cx0 = cx1 - cw
        rrect(dr, [cx0, 497, cx1, 545], 24, (46, 12, 17))
        draw_text(dr, ((cx0 + cx1) / 2, 531), sc["chip"], fc, style["accent"],
                  anchor="ms")
    grid_visual(dr, sc, style, 600, seg(t, 0.15, 1.0))
    b = sc.get("bottom") or {}
    if b:
        val = anim_number(b.get("value", ""), seg(t, 0.45, 0.78))
        fb = F("bold", 74)
        draw_text(dr, (MARGIN, 1272), val, fb, style["accent"])
        xx = MARGIN + text_w(fb, val) + 14
        fbu = F("bold", 36)
        draw_text(dr, (xx, 1272), b.get("unit", ""), fbu, style["text"])
        if b.get("label"):
            fbl = F("reg", 32)
            draw_text(dr, (xx + text_w(fbu, b.get("unit", "")) + 16, 1268),
                      b["label"], fbl, style["text_dim"])


def k_dense_grid(img, dr, sc, style, t, meta):
    chapter_label(dr, sc, style, seg(t, 0.0, 0.2))
    lead_line(dr, sc, style, seg(t, 0.05, 0.25))
    big_number(dr, MARGIN, 610, sc.get("value", ""), sc.get("unit", ""), style,
               size=168, color=style["accent"], unit_size=70,
               p=seg(t, 0.1, 0.5), anchor="ls")
    note = sc.get("note") or []
    if note:
        f, _ = fit_lines(note, "reg", 320, 30)
        lh = int(f.size * 1.4)
        for i, s in enumerate(note):
            draw_text(dr, (W - MARGIN, 590 + i * lh), s, f, style["text_dim"],
                      anchor="rs")
    grid_visual(dr, sc, style, 690, seg(t, 0.15, 1.0))


def k_bar_scale(img, dr, sc, style, t, meta):
    chapter_label(dr, sc, style, seg(t, 0.0, 0.15))
    if sc.get("headline"):
        f, _ = fit(sc["headline"], "bold", W - 2 * MARGIN - 220, 52)
        draw_text(dr, (MARGIN, 470), sc["headline"], f, style["text"])
    if sc.get("note"):
        f, _ = fit(sc["note"], "reg", 300, 24)
        draw_text(dr, (W - MARGIN, 468), sc["note"], f, style["text_faint"], anchor="rs")
    bars = sc.get("bars") or []
    maxv = max([b.get("value", 0) for b in bars] + [1])
    value_col = 210                                   # 右侧数值列，条长只在剩余宽度里伸缩
    track_w = W - 2 * MARGIN - value_col - 16
    y = 600
    for i, b in enumerate(bars):
        f, _ = fit(b.get("label", ""), "reg", track_w + value_col, 34)
        draw_text(dr, (MARGIN, y), b.get("label", ""), f,
                  style["accent"] if b.get("accent") else style["text"])
        ty = y + 22
        rrect(dr, [MARGIN, ty, MARGIN + track_w, ty + 46], 23, style["track"])
        w = max(8.0, track_w * b.get("value", 0) / maxv * ease(seg(t, 0.12 + i * 0.1, 0.6 + i * 0.1)))
        tone = style["accent"] if b.get("accent") else style["block_light"]
        rrect(dr, [MARGIN, ty, MARGIN + w, ty + 46], 23, tone)
        fb, _ = fit(b.get("display", ""), "bold", value_col, 38)
        label = b.get("display", "")
        draw_text(dr, (W - MARGIN, ty + 40), label, fb,
                  style["accent"] if b.get("accent") else style["block_light"],
                  anchor="rs")
        y += 148
    conclusion_block(dr, sc, style, y=1130, size=64, p=seg(t, 0.55, 0.9))


def k_split_bar(img, dr, sc, style, t, meta):
    chapter_label(dr, sc, style, seg(t, 0.0, 0.15))
    lead_line(dr, sc, style, seg(t, 0.05, 0.25))
    segs = sc.get("segments") or []
    total = sum(s.get("value", 0) for s in segs) or 1
    x = MARGIN
    track_w = W - 2 * MARGIN
    grow = ease(seg(t, 0.1, 0.6))
    for i, s in enumerate(segs):
        w = track_w * s.get("value", 0) / total * grow
        tone = style["block_light"] if s.get("tone") == "light" else style["accent"]
        if w > 2:
            rrect(dr, [x, 560, x + w, 660], 10, tone)
            f, _ = fit(s.get("label", ""), "bold", w - 32, 34)
            if text_w(f, s.get("label", "")) <= w - 32:
                draw_text(dr, (x + w / 2, 624), s.get("label", ""), f,
                          [18, 14, 16] if s.get("tone") == "light" else style["text"],
                          anchor="ms")
        x += w
    big_number(dr, W / 2, 900, sc.get("value", ""), sc.get("unit", ""), style,
               size=280, color=style["accent"], unit_size=108,
               p=seg(t, 0.35, 0.8))
    if sc.get("valueLabel"):
        f, _ = fit(sc["valueLabel"], "reg", W - 2 * MARGIN, 32)
        draw_text(dr, (W / 2, 968), sc["valueLabel"], f, style["text_dim"], anchor="ms")
    conclusion_block(dr, sc, style, y=1180, size=50, p=seg(t, 0.55, 0.9))


def k_progress_sliver(img, dr, sc, style, t, meta):
    chapter_label(dr, sc, style, seg(t, 0.0, 0.15))
    lead_line(dr, sc, style, seg(t, 0.05, 0.22))
    if sc.get("headline"):
        f, _ = fit(sc["headline"], "bold", W - 2 * MARGIN, 78)
        draw_text(dr, (MARGIN, 500), sc["headline"], f, style["text"])
    left = sc.get("left") or {}
    right = sc.get("right") or {}
    big_number(dr, MARGIN, 720, left.get("value", ""), left.get("unit", ""), style,
               size=178, color=style["accent"], unit_size=76,
               p=seg(t, 0.15, 0.55), anchor="ls")
    if right:
        rs = anim_number(right.get("value", ""), seg(t, 0.3, 0.7))
        fr = F("bold", 96)
        fu = F("bold", 44)
        total = text_w(fr, rs) + text_w(fu, right.get("unit", "")) + 10
        x = W - MARGIN - total
        draw_text(dr, (x, 720), rs, fr, style["text_dim"])
        draw_text(dr, (x + text_w(fr, rs) + 10, 720), right.get("unit", ""), fu,
                  style["text_dim"])
        if right.get("label"):
            fl = F("reg", 30)
            draw_text(dr, (W - MARGIN, 762), right["label"], fl, style["text_faint"],
                      anchor="rs")
    track_w = W - 2 * MARGIN
    rrect(dr, [MARGIN, 862, MARGIN + track_w, 886], 12, [58, 52, 58])
    ratio = (sc.get("track") or {}).get("ratio", 0)
    w = max(14.0, track_w * ratio) * ease(seg(t, 0.4, 0.9))
    if w > 2:
        rrect(dr, [MARGIN, 862, MARGIN + w, 886], 12, style["accent"])
    if left.get("label"):
        f = F("reg", 30)
        draw_text(dr, (MARGIN, 940), left["label"] + " " + left.get("value", "") + left.get("unit", ""),
                  f, style["accent"])
    if right.get("label"):
        f = F("reg", 30)
        draw_text(dr, (W - MARGIN, 940), right["label"] + " " + right.get("value", "") + right.get("unit", ""),
                  f, style["text_dim"], anchor="rs")
    conclusion_block(dr, sc, style, y=1090, size=60, p=seg(t, 0.6, 0.95))


def k_decay_bars(img, dr, sc, style, t, meta):
    chapter_label(dr, sc, style, seg(t, 0.0, 0.15))
    lead_line(dr, sc, style, seg(t, 0.05, 0.22))
    bars = sc.get("bars") or []
    if len(bars) < 2:
        return
    base_y, top_y = 1060, 660
    maxv = max(b.get("value", 0) for b in bars) or 1
    bw = 200
    xs = [W * 0.24 - bw / 2, W * 0.72 - bw / 2]
    for i, b in enumerate(bars):
        h = (base_y - top_y) * b.get("value", 0) / maxv * ease(seg(t, 0.15 + i * 0.2, 0.7 + i * 0.2))
        tone = style["accent"] if b.get("accent") else style["block_light"]
        if h > 2:
            dr.rectangle([xs[i], base_y - h, xs[i] + bw, base_y], fill=tuple(tone))
        fb, _ = fit(b.get("display", ""), "bold", bw + 60, 88)
        draw_text(dr, (xs[i] + bw / 2, base_y - h - 24), b.get("display", ""), fb, tone,
                  anchor="ms")
    # 衰减虚线：从高柱右上角跌向低柱顶端
    h0 = (base_y - top_y) * bars[0].get("value", 0) / maxv
    h1 = (base_y - top_y) * bars[1].get("value", 0) / maxv
    x0, y0 = xs[0] + bw, base_y - h0
    x1, y1 = xs[1], base_y - h1
    dp = ease(seg(t, 0.5, 0.95))
    n = 9
    for i in range(n):
        u = i / (n - 1.0) * dp
        px = x0 + (x1 - x0) * u
        py = y0 + (y1 - y0) * (u ** 1.6)
        r = 4.0
        dr.ellipse([px - r, py - r, px + r, py + r], fill=tuple(style["accent"]))
    hline(dr, MARGIN, W - MARGIN, base_y, [82, 44, 50], 2)
    for i, b in enumerate(bars):
        f, _ = fit(b.get("label", ""), "reg", 380, 28)
        draw_text(dr, (xs[i] + bw / 2, base_y + 46), b.get("label", ""), f,
                  style["text_dim"], anchor="ms")
    conclusion_block(dr, sc, style, y=1180, size=48, p=seg(t, 0.6, 0.95))


def k_row_list(img, dr, sc, style, t, meta):
    chapter_label(dr, sc, style, seg(t, 0.0, 0.15))
    if sc.get("headline"):
        f, _ = fit(sc["headline"], "bold", W - 2 * MARGIN, 82)
        draw_text(dr, (MARGIN, 520), sc["headline"], f, style["text"])
    rows = sc.get("rows") or []
    y = 660
    for i, r in enumerate(rows):
        a = ease(seg(t, 0.15 + i * 0.12, 0.45 + i * 0.12))
        fl, _ = fit(r.get("label", ""), "bold", 560, 52)
        dr.rectangle([MARGIN, y + 12, MARGIN + int(6 * a), y + 50],
                     fill=tuple(style["accent"] if r.get("accent") else style["track"]))
        draw_text(dr, (MARGIN + 22, y + 50), r.get("label", ""), fl,
                  style["accent"] if r.get("accent") else style["text"])
        ft, _ = fit(r.get("tag", ""), "reg", 380, 34)
        draw_text(dr, (W - MARGIN, y + 46), r.get("tag", ""), ft,
                  style["accent"] if r.get("accent") else style["text_faint"],
                  anchor="rs")
        hline(dr, MARGIN, W - MARGIN, y + 92, [64, 42, 46], 2)
        y += 150
    b = sc.get("bottom") or {}
    if b:
        if b.get("lead"):
            f, _ = fit(b["lead"], "reg", W - 2 * MARGIN, 34)
            draw_text(dr, (MARGIN, y + 56), b["lead"], f, style["text"])
        big_number(dr, MARGIN, y + 220, b.get("value", ""), b.get("unit", ""), style,
                   size=120, color=style["accent"], unit_size=56,
                   p=seg(t, 0.5, 0.8), anchor="ls")


def k_outro(img, dr, sc, style, t, meta):
    chapter_label(dr, sc, style, seg(t, 0.0, 0.15))
    if sc.get("lead"):
        f, _ = fit(sc["lead"], "reg", W - 2 * MARGIN, 44)
        draw_text(dr, (MARGIN, 470), sc["lead"], f, style["text"])
    big_number(dr, W / 2, 760, sc.get("value", ""), sc.get("unit", ""), style,
               size=300, color=style["accent"], unit_size=112,
               p=seg(t, 0.1, 0.6))
    lines = sc.get("statement") or []
    if lines:
        f, _ = fit_lines(lines, "bold", W - 2 * MARGIN - 60, 62)
        lh = int(f.size * 1.5)
        for i, s in enumerate(lines):
            draw_text(dr, (W / 2, 900 + i * lh), s, f, style["text"], anchor="ms")
        hline(dr, W / 2 - 190, W / 2 + 190, 900 + len(lines) * lh - 24, [104, 44, 50], 2)
    sup = sc.get("support") or []
    if sup:
        f, _ = fit_lines(sup, "reg", W - 2 * MARGIN - 120, 40)
        lh = int(f.size * 1.5)
        base = 900 + len(lines) * lh + 60
        for i, s in enumerate(sup):
            draw_text(dr, (W / 2, base + i * lh), s, f, style["text_dim"], anchor="ms")


KINDS = {
    "hook_number": k_hook_number,
    "dual_metrics": k_dual_metrics,
    "dot_matrix": k_dot_matrix,
    "dense_grid": k_dense_grid,
    "bar_scale": k_bar_scale,
    "split_bar": k_split_bar,
    "progress_sliver": k_progress_sliver,
    "decay_bars": k_decay_bars,
    "row_list": k_row_list,
    "outro": k_outro,
}


# --------------------------------------------------------------------------
# 装载 / 校验
# --------------------------------------------------------------------------
def load_report(path):
    with open(path, "r", encoding="utf-8") as fh:
        rep = json.load(fh)
    if rep.get("schema") != "stv.story/0.1":
        raise SystemExit("E_SCHEMA: 期望 schema=stv.story/0.1，实际 %r" % rep.get("schema"))
    screens = rep.get("screens") or []
    if not screens:
        raise SystemExit("E_SCREENS: report 里没有 screens")
    for i, sc in enumerate(screens):
        if sc.get("kind") not in KINDS:
            raise SystemExit("E_KIND: 第 %d 屏 kind=%r 不在支持列表 %s"
                             % (i + 1, sc.get("kind"), sorted(KINDS)))
        if not isinstance(sc.get("duration"), (int, float)) or sc["duration"] <= 0:
            raise SystemExit("E_DURATION: 第 %d 屏 duration 非法" % (i + 1))
    if (rep.get("meta") or {}).get("width", W) != W or (rep.get("meta") or {}).get("height", H) != H:
        raise SystemExit("E_CANVAS: 阶段 0 只支持 %dx%d" % (W, H))
    if (rep.get("meta") or {}).get("fps", FPS) != FPS:
        raise SystemExit("E_FPS: 阶段 0 只支持 %d fps" % FPS)
    return rep


def style_of(rep):
    st = dict(DEFAULT_STYLE)
    st.update((rep.get("meta") or {}).get("style") or {})
    return st


def screen_at(screens, frame):
    """帧号 → (屏幕, 屏内进度)。"""
    acc = 0.0
    for sc in screens:
        n = int(round(sc["duration"] * FPS))
        if frame < acc + n:
            return sc, (frame - acc) / max(1.0, n - 1)
        acc += n
    return screens[-1], 1.0


def total_frames(screens):
    return sum(int(round(sc["duration"] * FPS)) for sc in screens)


def render_frame(bg, rep, style, frame, total=None):
    img = bg.copy()
    dr = ImageDraw.Draw(img)
    sc, t = screen_at(rep["screens"], frame)
    KINDS[sc["kind"]](img, dr, sc, style, t, rep.get("meta") or {})
    footer(dr, sc, rep.get("meta") or {}, style)
    if total:
        # 顶部进度条：宽度严格等于已播比例（参考样片的观看预期提示）
        w = int(W * (frame + 1) / float(total))
        if w > 0:
            dr.rectangle([0, 0, w, 4], fill=tuple(style["accent"]))
    return img


# --------------------------------------------------------------------------
# 分镜表
# --------------------------------------------------------------------------
KIND_CN = {
    "hook_number": "巨数字钩子",
    "dual_metrics": "双指标",
    "dot_matrix": "比例点阵",
    "dense_grid": "密格孤点",
    "bar_scale": "比例条",
    "split_bar": "分段条",
    "progress_sliver": "进度细条",
    "decay_bars": "衰退柱",
    "row_list": "行列表",
    "outro": "收尾",
}


def _screen_main_text(sc):
    if sc.get("value"):
        return ("%s %s" % (sc["value"], sc.get("unit", ""))).strip()
    for key in ("items", "bars", "rows", "segments"):
        if sc.get(key):
            out = []
            for x in sc[key]:
                if x.get("display"):
                    out.append(str(x["display"]))
                elif x.get("value") is not None:
                    out.append(("%s%s" % (x["value"], x.get("unit", ""))).strip())
                else:
                    out.append(str(x.get("label", "")))
            return " / ".join(out)
    if sc.get("left") and sc.get("right"):
        return ("%s%s / %s%s" % (sc["left"].get("value", ""), sc["left"].get("unit", ""),
                                 sc["right"].get("value", ""), sc["right"].get("unit", "")))
    return sc.get("headline") or "—"


def _screen_conclusion_text(sc):
    for key in ("conclusion", "statement"):
        if sc.get(key):
            return " ".join(sc[key])
    b = sc.get("bottom") or {}
    if b:
        return ("%s%s %s" % (b.get("value", ""), b.get("unit", ""), b.get("label", ""))).strip()
    if sc.get("note"):
        return " ".join(sc["note"])
    return sc.get("lead") or "—"


def write_storyboard(rep, path):
    lines = []
    meta = rep.get("meta") or {}
    prov = meta.get("provenance") or {}
    lines.append("# 分镜表 · %s" % meta.get("title", "(未命名)"))
    lines.append("")
    lines.append("- 画幅：%dx%d @ %d fps" % (W, H, FPS))
    lines.append("- 总时长：%.1f s / %d 帧" % (
        sum(s["duration"] for s in rep["screens"]), total_frames(rep["screens"])))
    lines.append("- 数据来源：%s（核验状态：%s）" % (prov.get("type", "-"), prov.get("verification", "-")))
    lines.append("- 生成方式：`python engine_next/render_story_v030.py --report <report> --storyboard <md>`，由 report 直接生成，不手写")
    lines.append("")
    lines.append("| # | 时间码 | 时长 | 版式 | 主数字 | 结论 / 要点 | 图形编码 |")
    lines.append("|---|--------|------|------|--------|-------------|----------|")
    acc = 0.0
    for i, sc in enumerate(rep["screens"], 1):
        start = acc
        acc += sc["duration"]
        name = KIND_CN.get(sc["kind"], sc["kind"])
        tag = ("%s %s" % (sc.get("label", ""), sc.get("title", ""))).strip()
        enc = _encoding_note(sc)
        lines.append("| %d | %05.1f–%05.1f | %.1fs | %s%s | %s | %s | %s |"
                     % (i, start, acc, sc["duration"], name,
                        ("（%s）" % tag) if tag else "",
                        _screen_main_text(sc), _screen_conclusion_text(sc), enc))
    lines.append("")
    lines.append("图形编码说明：点阵/密格的亮格数 = round(比例 × 格数)；条长与细条宽度 = 数值 / 最大值 × 轨道宽；")
    lines.append("三者都由 report 里的数字算出，不接受手工指定的像素位置。")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def _encoding_note(sc):
    k = sc["kind"]
    if k in ("dot_matrix", "dense_grid"):
        g = sc.get("grid") or {}
        return "点阵 %d 格 / 亮 %d 格" % (g.get("cols", 0) * g.get("rows", 0), g.get("lit", 0))
    if k == "bar_scale":
        bars = sc.get("bars") or []
        mx = max([b.get("value", 0) for b in bars] + [1])
        return "满格 = %s（最大值）" % mx
    if k == "split_bar":
        segs = sc.get("segments") or []
        t = sum(x.get("value", 0) for x in segs) or 1
        return "分段占比 " + " / ".join("%.0f%%" % (x.get("value", 0) * 100.0 / t) for x in segs)
    if k == "progress_sliver":
        return "细条 = %.1f%% 轨道宽" % ((sc.get("track") or {}).get("ratio", 0) * 100)
    if k == "decay_bars":
        bars = sc.get("bars") or []
        mx = max(b.get("value", 0) for b in bars) or 1
        return "柱高比 " + " : ".join("%.2f" % (b.get("value", 0) / float(mx)) for b in bars)
    return "—"


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--storyboard", default=None, help="分镜表 markdown 路径")
    ap.add_argument("--keyframes", default=None, help="每屏关键帧 PNG 目录")
    ap.add_argument("--no-video", action="store_true")
    args = ap.parse_args()

    rep = load_report(args.report)
    global _COUNT_UP
    _COUNT_UP = bool(((rep.get("meta") or {}).get("motion") or {}).get("countUp", True))
    style = style_of(rep)
    resolve_fonts()
    os.makedirs(args.out, exist_ok=True)

    screens = rep["screens"]
    n_frames = total_frames(screens)
    bg = make_bg(style)

    if args.storyboard:
        write_storyboard(rep, args.storyboard)

    # 关键帧：每屏 60% 处的画面（不含滚动中间态，便于核对版式）
    if args.keyframes:
        os.makedirs(args.keyframes, exist_ok=True)
        acc = 0
        for i, sc in enumerate(screens, 1):
            n = int(round(sc["duration"] * FPS))
            f = acc + int(n * 0.88)
            render_frame(bg, rep, style, f, n_frames).save(
                os.path.join(args.keyframes, "%02d_%s.png" % (i, sc["kind"])))
            acc += n

    if args.no_video:
        print("frames=%d (no video)" % n_frames)
        return

    mp4 = os.path.join(args.out, "video.mp4")
    ff = None
    try:
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover
        raise SystemExit("E_FFMPEG: 无法定位 ffmpeg（%s）" % exc)

    log_path = os.path.join(args.out, "ffmpeg.log")
    cmd = [
        ff, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "pipe:0",
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        mp4,
    ]
    with open(log_path, "wb") as logf:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=logf, stderr=logf)
        try:
            for i in range(n_frames):
                proc.stdin.write(render_frame(bg, rep, style, i, n_frames).tobytes())
        finally:
            proc.stdin.close()
            proc.wait()
    if proc.returncode != 0:
        raise SystemExit("E_FFMPEG: 退出码 %d，见 %s" % (proc.returncode, log_path))

    # 探针帧哈希：与编码器无关的确定性锚点
    probe_frame = int(n_frames * 0.42)
    probe = hashlib.sha256(render_frame(bg, rep, style, probe_frame, n_frames).tobytes()).hexdigest()
    with open(mp4, "rb") as fh:
        mp4_sha = hashlib.sha256(fh.read()).hexdigest()

    report = {
        "schema": "stv.story.render/0.1",
        "report": os.path.relpath(os.path.abspath(args.report)).replace("\\", "/"),
        "canvas": {"width": W, "height": H, "fps": FPS},
        "frames": n_frames,
        "duration_s": round(n_frames / float(FPS), 3),
        "screens": len(screens),
        "kinds": [sc["kind"] for sc in screens],
        "probe_frame": probe_frame,
        "probe_frame_sha256": probe,
        "video_sha256": mp4_sha,
        "video_bytes": os.path.getsize(mp4),
        "fonts": _FONT_PATHS,
        "renderers_touched": ["engine_next/render_story_v030.py"],
        "renderers_untouched": [
            "engine_next/render_stock_macd_v122.py",
            "engine_next/render_stock_macd_v123.py",
            "engine_next/render_generic_chart.py",
        ],
    }
    with open(os.path.join(args.out, "render_report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    print("frames=%d duration=%.1fs video=%s" % (n_frames, n_frames / float(FPS), mp4))
    print("probe_frame_sha256=%s" % probe)
    print("video_sha256=%s bytes=%d" % (mp4_sha, report["video_bytes"]))


if __name__ == "__main__":
    main()
