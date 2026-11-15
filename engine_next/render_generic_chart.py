# -*- coding: utf-8 -*-
"""通用图表渲染器（V0.2 预览）。

把用户导入的 CSV 归一化结果渲染成 MP4：
  - class=timeseries    → 折线随横轴生长（20~35s）
  - class=cross_section → 横向条形逐条生长（15~25s）

约束（与 DATA_SPEC / Issue #1 对齐）：
  1. 只读 --input 指向的 normalized.json，所有数字都来自该文件，不做统计推断；
     唯一允许的派生量是 cross_section 的「占比」（该行 ÷ 合计），且必须在画面上写出式子。
  2. 不联网、不读机器专属路径；仅用 deps/ 里的 Pillow 与 imageio-ffmpeg。
  3. 不使用 A 股红涨绿跌语义（本工具画的不是涨跌）。
  4. 页脚必须显示来源（文件名 / 导入时间）与免责声明，不删除。

用法：
  python engine_next/render_generic_chart.py --input <normalized.json> --run <runId> [--out <dir>]
"""

import argparse
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
DUR = {"timeseries": 24.0, "cross_section": 18.0}

BG = (13, 17, 23)
PANEL = (20, 26, 34)
GRID = (38, 46, 58)
TEXT = (232, 236, 242)
MUTED = (150, 160, 175)
FAINT = (108, 118, 132)
WARN = (227, 176, 75)
BLUE = (106, 169, 255)
SERIES_COLORS = [
    (106, 169, 255), (227, 176, 75), (155, 140, 255),
    (79, 195, 200), (192, 200, 212), (217, 139, 176),
]

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


def fmt(v):
    if v is None:
        return "—"
    a = abs(v)
    if a >= 1000:
        s = "{:,.2f}".format(v)
    elif a >= 100:
        s = "{:.1f}".format(v)
    elif a >= 1:
        s = "{:.2f}".format(v)
    else:
        s = "{:.3f}".format(v)
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def nice_step(raw):
    if raw <= 0:
        return 1.0
    exp = math.floor(math.log10(raw))
    base = raw / (10 ** exp)
    for m in (1.0, 2.0, 2.5, 5.0, 10.0):
        if base <= m:
            return m * (10 ** exp)
    return 10.0 ** (exp + 1)


def make_axis(vmin, vmax, target=6):
    if vmin == vmax:
        vmin -= 1.0
        vmax += 1.0
    span = vmax - vmin
    lo = vmin - span * 0.10
    hi = vmax + span * 0.10
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


def blend(c1, c2, a):
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * a)) for i in range(3))


def fit_text(d, s, size, max_w, suffix="…"):
    """按可用像素宽度截断，避免用户填的长文件名/来源说明溢出画面。"""
    if d.textlength(s, font=font(size)) <= max_w:
        return s
    while s and d.textlength(s + suffix, font=font(size)) > max_w:
        s = s[:-1]
    return (s + suffix) if s else ""


# ---------------- 公共版式 ----------------

def draw_header(d, meta, subtitle_left, subtitle_right):
    txt(d, (140, 66), meta.get("title") or "用户数据", 56, TEXT, bold=True)
    if subtitle_left:
        txt(d, (140, 150), subtitle_left, 28, MUTED)
    if subtitle_right:
        txt(d, (1780, 152), subtitle_right, 26, MUTED, anchor="ra")

    badge = "用户导入"
    bw = d.textlength(badge, font=font(22, True)) + 34
    d.rounded_rectangle([1780 - bw, 62, 1780, 106], radius=22, fill=(28, 52, 78), outline=(52, 96, 140), width=2)
    txt(d, (1780 - bw / 2, 84), badge, 22, (150, 200, 245), bold=True, anchor="mm")

    d.line([140, 196, 1780, 196], fill=GRID, width=2)


def draw_footer(d, meta, note_right):
    d.line([140, 906, 1780, 906], fill=GRID, width=2)

    fn = meta.get("fileName") or "（未记录文件名）"
    imported = (meta.get("importedAt") or "")[:10]
    left = "数据：用户导入 · {} · 导入于 {}".format(fn, imported or "（未知）")
    txt(d, (140, 926), fit_text(d, left, 24, 1160), 24, MUTED)

    unit = meta.get("unit") or "未声明"
    right = "单位：{}".format(unit)
    if note_right:
        right = right + " · " + note_right
    txt(d, (1780, 926), right, 24, MUTED, anchor="ra")

    # 来源说明（表单里「数据来源说明」承诺写进页脚，不能只存进 meta 不显示）
    y = 962
    src = (meta.get("sourceNote") or "").strip()
    if src:
        txt(d, (140, y), fit_text(d, "来源：{}".format(src), 22, 1630), 22, MUTED)
        y += 34

    ws = meta.get("warnings") or []
    if ws:
        msg = "数据提示（{} 项）：{}".format(len(ws), "；".join(w.get("message", w.get("code", "")) for w in ws[:2]))
        if len(msg) > 96:
            msg = msg[:95] + "…"
        txt(d, (140, y), msg, 22, WARN)
        y += 34

    # 免责声明必须完整可见：多一行时上移，但不超过 1030（再低会被画面下边缘裁掉）
    dy = 1014 if y <= 996 else min(1030, y + 6)
    txt(d, (140, dy), "本视频由 StrategyToVideo 在本地生成 · 全部数字来自用户导入的 CSV · 不构成投资建议",
        22, FAINT)


# ---------------- A 类：折线 ----------------

def build_ts_state(model):
    meta = model["meta"]
    series = model.get("series") or []
    all_dates = sorted({p["date"] for s in series for p in s["points"]})
    idx = {dt: i for i, dt in enumerate(all_dates)}
    n = len(all_dates)

    prepared = []
    for k, s in enumerate(series):
        pts = [(idx[p["date"]], p["value"]) for p in s["points"] if p["date"] in idx]
        pts.sort(key=lambda x: x[0])
        last_val = next((v for _, v in reversed(pts) if v is not None), None)
        prepared.append({
            "name": s.get("name") or "序列{}".format(k + 1),
            "pts": pts,
            "last": last_val,
            "color": SERIES_COLORS[k % len(SERIES_COLORS)],
        })

    vals = [v for s in prepared for _, v in s["pts"] if v is not None]
    vmin, vmax = (min(vals), max(vals)) if vals else (0.0, 1.0)

    L, R, T, B = 210, 1780, 330, 845
    lo, hi, ticks = make_axis(vmin, vmax)

    def x_of(i):
        if n <= 1:
            return L
        return L + (R - L) * (i / (n - 1.0))

    def y_of(v):
        if hi == lo:
            return (T + B) / 2.0
        return B - (v - lo) / (hi - lo) * (B - T)

    # 预渲染整条曲线（只含折线），逐帧按宽度裁切，避免每帧重画上万段
    trail = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    td = ImageDraw.Draw(trail)
    for s in prepared:
        seg = []
        for i, v in s["pts"]:
            if v is None:
                if len(seg) > 1:
                    td.line(seg, fill=s["color"] + (255,), width=4, joint="curve")
                seg = []
            else:
                seg.append((x_of(i), y_of(v)))
        if len(seg) > 1:
            td.line(seg, fill=s["color"] + (255,), width=4, joint="curve")
        elif len(seg) == 1:
            td.ellipse([seg[0][0] - 3, seg[0][1] - 3, seg[0][0] + 3, seg[0][1] + 3], fill=s["color"] + (255,))

    marks = []
    if prepared and prepared[0]["pts"]:
        pts = [(i, v) for i, v in prepared[0]["pts"] if v is not None]
        if pts:
            first_i, first_v = pts[0]
            last_i, last_v = pts[-1]
            max_i, max_v = max(pts, key=lambda p: p[1])
            min_i, min_v = min(pts, key=lambda p: p[1])
            # 首值/末值必然要标；若同时是极小/极大，就把结论合并进标签，
            # 不再在同一坐标上叠两个标签（数据单调时 max 就是末值，硬标四个只会互相遮挡）
            marks.append(("首值" + ("（最低）" if min_i == first_i else ""), (first_i, first_v), -48, "left"))
            marks.append(("末值" + ("（最高）" if max_i == last_i else ""), (last_i, last_v), -48, "right"))
            if max_i not in (first_i, last_i):
                marks.append(("最大", (max_i, max_v), -94, "left"))
            if min_i not in (first_i, last_i):
                marks.append(("最小", (min_i, min_v), 32, "left"))

    return {
        "meta": meta, "prepared": prepared, "dates": all_dates, "n": n,
        "L": L, "R": R, "T": T, "B": B, "lo": lo, "hi": hi, "ticks": ticks,
        "x_of": x_of, "y_of": y_of, "trail": trail, "marks": marks,
    }


def draw_ts_frame(st, t):
    meta = st["meta"]
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    L, R, T, B = st["L"], st["R"], st["T"], st["B"]
    dates, n = st["dates"], st["n"]

    first_date, last_date = dates[0], dates[-1]
    draw_header(d, meta, "{} → {} · 共 {} 个观测点".format(first_date, last_date, n), None)

    # 纵向进度：按索引推进。动画占前 82%，剩下留在末值上停顿——
    # 否则「末值」标注只在最后一帧闪一下，等于没有。
    p = ease(min(1.0, t / 0.82)) * (n - 1)
    cur_i = int(math.floor(p))
    cur_date = dates[cur_i]

    # 当前读数（右上角，随动画更新）
    cur_vals = []
    for s in st["prepared"]:
        v = None
        for i, val in s["pts"]:
            if i <= cur_i:
                v = val
            else:
                break
        cur_vals.append(v)
    readout = "当前 {} · {}".format(cur_date, " / ".join(fmt(v) for v in cur_vals))
    txt(d, (1780, 150), readout, 26, TEXT, anchor="ra")

    # 网格与 Y 轴
    for tk in st["ticks"]:
        y = st["y_of"](tk)
        if y < T - 1 or y > B + 1:
            continue
        d.line([L, y, R, y], fill=GRID, width=1)
        txt(d, (L - 16, y), fmt(tk), 24, MUTED, anchor="rm")

    # X 轴标签（最多 7 个；与末点过近时丢弃，避免两个日期挤在一起）
    step = max(1, int(math.ceil(n / 7.0)))
    dw = d.textlength(dates[0], font=font(22))
    last_x = -1e9
    for i in range(0, n, step):
        x = st["x_of"](i)
        txt(d, (x, B + 16), dates[i], 22, MUTED, anchor="ma")
        last_x = x
    # 阈值必须按实际字宽算：日期标签是居中对齐的，间距小于「字宽 + 余量」就会叠字
    if (n - 1) % step != 0 and st["x_of"](n - 1) - last_x > dw + 18:
        txt(d, (R, B + 16), dates[-1], 22, MUTED, anchor="ma")

    # 图例（顶部一行）
    lx = L
    for s in st["prepared"]:
        d.rounded_rectangle([lx, 258, lx + 26, 268], radius=5, fill=s["color"])
        label = "{}  {}".format(s["name"], fmt(s["last"]))
        txt(d, (lx + 36, 263), label, 24, TEXT, anchor="lm")
        lx += 36 + d.textlength(label, font=font(24)) + 46
        if lx > R - 260:
            break

    # 曲线：按当前横坐标裁切预渲染轨迹
    xcut = int(round(st["x_of"](p))) + 3
    if xcut > 0:
        im.paste(st["trail"].crop((0, 0, min(xcut, W), H)), (0, 0), st["trail"].crop((0, 0, min(xcut, W), H)))

    # 定点标注（到达后才出现）。文字加底衬，避免压在曲线上读不清。
    d2 = ImageDraw.Draw(im)
    f_ann = font(22)
    for label, (mi, mv), dy, side in st["marks"]:
        if mi > cur_i:
            continue
        x, y = st["x_of"](mi), st["y_of"](mv)
        d2.ellipse([x - 6, y - 6, x + 6, y + 6], fill=BG, outline=BLUE, width=3)
        text = "{} {} ({})".format(label, fmt(mv), dates[mi])
        if side == "right":
            anchor = "rs" if dy < 0 else "ra"
            tx = x - 14
        else:
            anchor = "ls" if dy < 0 else "la"
            tx = x + 14
        ty = y + dy
        bb = d2.textbbox((tx, ty), text, font=f_ann, anchor=anchor)
        d2.rounded_rectangle([bb[0] - 8, bb[1] - 5, bb[2] + 8, bb[3] + 5],
                             radius=7, fill=(24, 31, 41), outline=(52, 64, 78), width=1)
        d2.text((tx, ty), text, font=f_ann, fill=(210, 220, 232), anchor=anchor)

    # 当前点
    x = st["x_of"](p)
    d2.line([x, T, x, B], fill=(70, 84, 100), width=2)
    for s in st["prepared"]:
        v = cur_vals[st["prepared"].index(s)]
        if v is None:
            continue
        d2.ellipse([x - 8, st["y_of"](v) - 8, x + 8, st["y_of"](v) + 8], fill=s["color"])

    draw_footer(d2, meta, "折线 · 不外推")
    return im


# ---------------- B 类：横向条形 ----------------

def build_cs_state(model):
    meta = model["meta"]
    rows = model.get("rows") or []
    L, R, T, B = 140, 1780, 330, 845
    label_right = 500
    vals = [r["value"] for r in rows] + [r.get("value2") for r in rows if r.get("value2") is not None]
    vmin = min([0.0] + vals)
    vmax = max([0.0] + vals)
    if vmin == vmax:
        vmax = vmin + 1.0
    pad = (vmax - vmin) * 0.12
    lo = vmin - (pad if vmin < 0 else 0)
    hi = vmax + pad
    if lo == hi:
        hi = lo + 1.0

    def x_of(v):
        return label_right + 40 + (v - lo) / (hi - lo) * (R - label_right - 40)

    # 分组色：图例与条形必须用同一套映射，否则图例说的和画出来的不一致。
    # 顺序按「在文件里首次出现」，不按字典序——后者会把用户的分组次序打乱。
    groups = []
    for r in rows:
        g = r.get("group")
        if g and g not in groups:
            groups.append(g)

    def color_of(group):
        if not group or group not in groups:
            return BLUE
        return SERIES_COLORS[(groups.index(group) + 2) % len(SERIES_COLORS)]

    return {"meta": meta, "rows": rows, "L": L, "R": R, "T": T, "B": B,
            "label_right": label_right, "x_of": x_of, "lo": lo, "hi": hi,
            "groups": groups, "color_of": color_of}


def draw_cs_frame(st, t):
    meta = st["meta"]
    rows = st["rows"]
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    L, R, T, B = st["L"], st["R"], st["T"], st["B"]

    n = len(rows)
    sort_note = "按 value 降序" if meta.get("sortedByValue") else "按文件顺序"
    subtitle = "共 {} 项".format(n)
    if meta.get("asOf"):
        subtitle += " · 时点 {}".format(meta["asOf"])
    draw_header(d, meta, subtitle, sort_note)

    has2 = bool(meta.get("hasValue2"))
    # 图例：有分组就按分组配色（否则「当前=蓝」与画面实际颜色对不上）
    lx = L
    if st["groups"]:
        for g in st["groups"][:6]:
            d.rounded_rectangle([lx, 258, lx + 26, 268], radius=5, fill=st["color_of"](g))
            txt(d, (lx + 36, 263), g, 24, TEXT, anchor="lm")
            lx += 36 + d.textlength(g, font=font(24)) + 46
        note_legend = "每行上条=当前、下条=对照" if has2 else "按分组着色"
        txt(d, (lx + 10, 263), "（{}）".format(note_legend), 20, MUTED, anchor="lm")
    else:
        for label, col in (("当前", BLUE), ("对照", (227, 176, 75)))[: (2 if has2 else 1)]:
            d.rounded_rectangle([lx, 258, lx + 26, 268], radius=5, fill=col)
            txt(d, (lx + 36, 263), label, 24, TEXT, anchor="lm")
            lx += 36 + d.textlength(label, font=font(24)) + 46

    zero_x = st["x_of"](0.0)
    d.line([zero_x, T - 10, zero_x, B + 6], fill=(86, 96, 112), width=2)
    txt(d, (zero_x, B + 20), "0", 20, MUTED, anchor="ma")

    row_h = (B - T) / max(1, n)
    fsize = max(13, min(30, int(row_h * 0.50)))
    gap = max(3, row_h * 0.26)
    # 条目少时不要把条形拉成整块色板，封顶 64px
    bar_h = min(64.0, max(6.0, row_h - gap))
    if has2:
        bar_h = max(5.0, bar_h / 2 - 2)

    grow = ease(min(1.0, t / 0.72))

    for i, r in enumerate(rows):
        cy = T + row_h * (i + 0.5)
        # 标签
        lab = r["label"]
        if len(lab) > 24:
            lab = lab[:23] + "…"
        txt(d, (st["label_right"], cy), lab, fsize, TEXT, anchor="rm")

        frac = max(0.0, min(1.0, (grow * n - i) / 1.0))
        if frac <= 0:
            continue

        col = st["color_of"](r.get("group"))

        def bar(value, color, y0, h):
            x2 = st["x_of"](value * frac)
            x1 = zero_x
            xa, xb = min(x1, x2), max(x1, x2)
            if xb - xa < 1:
                xb = xa + 1
            d.rounded_rectangle([xa, y0, xb, y0 + h], radius=min(6, h / 2), fill=color)

        y0 = cy - bar_h if has2 else cy - bar_h / 2
        bar(r["value"], col, y0, bar_h)

        txt_col = TEXT if frac > 0.85 else MUTED
        vt = fmt(r["value"])
        if r.get("share") is not None:
            vt += "（{}%）".format("{:.1f}".format(r["share"]))
        vx = st["x_of"](r["value"] * frac)
        if r["value"] >= 0:
            txt(d, (vx + 12, y0 + bar_h / 2), vt, max(14, fsize - 2), txt_col, anchor="lm")
        else:
            txt(d, (vx - 12, y0 + bar_h / 2), vt, max(14, fsize - 2), txt_col, anchor="rm")

        if has2 and r.get("value2") is not None:
            y1 = cy + 2
            bar(r["value2"], (227, 176, 75), y1, bar_h)
            vx2 = st["x_of"](r["value2"] * frac)
            txt(d, (vx2 + 12 if r["value2"] >= 0 else vx2 - 12, y1 + bar_h / 2),
                fmt(r["value2"]), max(13, fsize - 3), MUTED,
                anchor="lm" if r["value2"] >= 0 else "rm")

    # 页脚只说「占比」这件事；排序信息在标题右侧，不重复
    note = ""
    if meta.get("shareBasis") == "skipped":
        note = "含负值或合计为 0，不计算占比"
    elif any(r.get("share") is not None for r in rows):
        note = "占比 = 该行 ÷ 合计"
    draw_footer(d, meta, note)
    return im


# ---------------- 编码 ----------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as f:
        model = json.load(f)

    cls = model.get("class")
    if cls not in DUR:
        raise SystemExit("不支持的 class：%r" % cls)

    out_dir = args.out or os.path.join(ROOT, "output", args.run, "04_video")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "video.mp4")
    log_path = os.path.join(out_dir, "ffmpeg.log")

    dur = DUR[cls]
    frames = int(round(dur * FPS))
    ff = imageio_ffmpeg.get_ffmpeg_exe()

    if cls == "timeseries":
        st = build_ts_state(model)
        render = lambda t: draw_ts_frame(st, t)  # noqa: E731
        counts = {"seriesCount": len(st["prepared"]), "observations": st["n"]}
    else:
        st = build_cs_state(model)
        render = lambda t: draw_cs_frame(st, t)  # noqa: E731
        counts = {"barCount": len(st["rows"])}

    cmd = [
        ff, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "{}x{}".format(W, H), "-r", str(FPS), "-i", "pipe:0",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart",
        "-metadata", "title=Strategy to Video 用户导入 · {}".format(model["meta"].get("title", "")),
        out_path,
    ]
    logf = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=logf)

    for f in range(frames):
        im = render(f / float(frames - 1))
        proc.stdin.write(im.tobytes())
        if f % 120 == 0:
            print("  frame {}/{}".format(f, frames), flush=True)

    proc.stdin.close()
    rc = proc.wait()
    logf.close()
    if rc != 0:
        print(open(log_path, encoding="utf-8").read()[-2000:])
        raise SystemExit("ffmpeg 退出码 %d" % rc)

    report = {
        "class": cls,
        "title": model["meta"].get("title"),
        "fileName": model["meta"].get("fileName"),
        "width": W, "height": H, "fps": FPS,
        "frames": frames,
        "durationSec": round(frames / float(FPS), 3),
        "rowCount": model["meta"].get("rowCount"),
        "warnings": model["meta"].get("warnings") or [],
        "outputBytes": os.path.getsize(out_path),
        "encodings": {"video": "H.264 (libx264)", "audio": "AAC (静音轨)"},
    }
    report.update(counts)
    with open(os.path.join(out_dir, "render_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print("ok {} bytes={} frames={} duration={}s".format(out_path, report["outputBytes"], frames, report["durationSec"]))


if __name__ == "__main__":
    main()
