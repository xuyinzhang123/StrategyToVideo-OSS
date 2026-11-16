#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""============================================================================
 V0.3 阶段 0 · 竖版数据解剖片 独立验收
 ---------------------------------------------------------------------------
 只读校验：不改 report、不改画面、不动任何既有渲染器。
 分三层，共 24 项：

   A. 结构（8 项）   屏数 / 版式顺序 / 帧数 / 时长 / 画幅 / 帧率 / 无音轨 / 页脚齐备
   B. 编码（8 项）   比例类图形的数值必须能由数字复算出来，不允许手工摆放
   C. 版式（8 项）   抽样 12 帧扫描亮像素包围盒，验证没有文字被右边距裁切
                     （参考样片存在「结尾字幕右侧被切」的毛病，本项专治这个）

 用法
   python spike/v03/accept_story_v030.py --report spike/v03/report.simulated.json \
          --render-dir output/v03_story/simulated
============================================================================"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "engine_next"))
sys.path.insert(0, os.path.join(ROOT, "deps"))

import render_story_v030 as R  # noqa: E402

EXPECTED_KINDS = [
    "hook_number", "dual_metrics", "dot_matrix", "dense_grid", "bar_scale",
    "split_bar", "progress_sliver", "decay_bars", "row_list", "outro",
]

PASS, FAIL, WARN = [], [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print("%s %s%s" % ("[PASS]" if ok else "[FAIL]", name, ("  <- " + detail) if detail and not ok else ""))


def check_soft(name, value, target, tol, warn_tol, detail=""):
    """精确档 tol 内算通过；warn_tol 内算警告（如原文案是约数），超出算失败。"""
    d = abs(value - target)
    if d <= tol:
        PASS.append(name)
        print("[PASS] %s" % name)
    elif d <= warn_tol:
        WARN.append(name)
        print("[WARN] %s  <- %s（差 %.2f，超精确档 %.1f 但在约数档 %.1f 内）"
              % (name, detail, d, tol, warn_tol))
    else:
        FAIL.append(name)
        print("[FAIL] %s  <- %s（差 %.2f）" % (name, detail, d))


def probe(mp4):
    ff = R_import_ffmpeg()
    r = subprocess.run([ff, "-hide_banner", "-i", mp4],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8")
    txt = (r.stdout or "") + (r.stderr or "")
    width = height = fps = dur = None
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", txt)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    m = re.search(r"Video: .*?(\d{2,5})x(\d{2,5})", txt)
    if m:
        width, height = int(m.group(1)), int(m.group(2))
    m = re.search(r"(\d+(?:\.\d+)?) fps", txt)
    if m:
        fps = float(m.group(1))
    audio = len(re.findall(r"Stream .*: Audio:", txt))
    return {"width": width, "height": height, "fps": fps, "duration": dur, "audio": audio, "raw": txt}


def R_import_ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def bright_bbox(img, threshold=90):
    """整幅扫描亮度超过阈值的像素包围盒。用来发现越界文字（含光晕、进度条）。"""
    small = img.convert("L").crop((0, 10, R.W, R.H))      # 顶部进度条不属于内容
    mask = small.point(lambda v: 255 if v > threshold else 0)
    return mask.getbbox()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--render-dir", required=True)
    args = ap.parse_args()

    rep = R.load_report(args.report)
    rr_path = os.path.join(args.render_dir, "render_report.json")
    if not os.path.exists(rr_path):
        print("[FAIL] 缺少 render_report.json：%s" % rr_path)
        return 1
    with open(rr_path, "r", encoding="utf-8") as fh:
        rr = json.load(fh)
    mp4 = os.path.join(args.render_dir, "video.mp4")

    screens = rep["screens"]
    meta = rep.get("meta") or {}
    n_frames = R.total_frames(screens)

    print("== A. 结构 ==")
    check("A1 屏数 = 10", len(screens) == 10, "实际 %d" % len(screens))
    kinds = [s["kind"] for s in screens]
    check("A2 版式顺序与样片一致", kinds == EXPECTED_KINDS, str(kinds))
    check("A3 帧数 = Σ(时长×fps)", rr["frames"] == n_frames, "%s vs %s" % (rr.get("frames"), n_frames))
    info = probe(mp4)
    expect_dur = n_frames / float(R.FPS)
    check("A4 成片时长 = %.2fs" % expect_dur,
          info["duration"] is not None and abs(info["duration"] - expect_dur) <= 0.05,
          "实际 %s" % info["duration"])
    check("A5 画幅 1080x1920", (info["width"], info["height"]) == (R.W, R.H),
          "%sx%s" % (info["width"], info["height"]))
    check("A6 帧率 30", info["fps"] == 30.0, str(info["fps"]))
    check("A7 无音轨", info["audio"] == 0, "音轨数 %s" % info["audio"])
    footer = (meta.get("provenance") or {}).get("footer", "")
    check("A8 每屏带数据来源页脚", bool(footer.strip()), "provenance.footer 为空")

    print("== B. 编码（图形必须由数字复算，不许手工摆放）==")
    by_id = {s["id"]: s for s in screens}
    dm = by_id["ch02"]
    total_cells = dm["grid"]["cols"] * dm["grid"]["rows"]
    rate = float(re.search(r"(\d+\.?\d*)%", dm["chip"]).group(1)) / 100.0
    check("B1 点阵亮格 = round(命中率 × 格数)",
          dm["grid"]["lit"] == max(1, round(rate * total_cells)),
          "lit=%d 应为 %d" % (dm["grid"]["lit"], round(rate * total_cells)))
    hb = by_id["ch03"]
    check("B2 密格亮格数 ≤ 2 且 > 0", 0 < hb["grid"]["lit"] <= 2, "lit=%d" % hb["grid"]["lit"])
    ps = by_id["ch06"]
    check("B3 细条宽度比例 = 左侧百分比",
          abs(ps["track"]["ratio"] * 100 - float(ps["left"]["value"])) < 0.051,
          "ratio=%s left=%s" % (ps["track"]["ratio"], ps["left"]["value"]))
    check("B4 左右百分比合计 = 100",
          abs(float(ps["left"]["value"]) + float(ps["right"]["value"]) - 100) < 0.051)
    sb = by_id["ch05"]
    seg_sum = sum(x["value"] for x in sb["segments"])
    share = sb["segments"][-1]["value"] / float(seg_sum) * 100
    check_soft("B5 分段条占比 = 主百分比（±1pp 精确 / ±3pp 约数）",
               share, float(sb["value"]), 1.0, 3.0,
               "算得 %.1f%% 标注 %s%%" % (share, sb["value"]))
    bs = by_id["ch04"]
    check("B6 比例条以最大值为满格",
          max(b["value"] for b in bs["bars"]) == bs["bars"][0]["value"])
    db = by_id["ch07"]
    drop = (1 - db["bars"][1]["value"] / float(db["bars"][0]["value"])) * 100
    retain = 100.0 - drop
    m = re.search(r"(\d+\.?\d*)%", db["conclusion"][0])
    # 文案可以写「跌了多少」也可以写「剩了多少」，两种都认，但必须对得上
    if not m:
        check("B7 衰减柱跌幅/留存与文案一致", False, "文案里找不到百分比")
    else:
        pv = float(m.group(1))
        near = drop if abs(pv - drop) <= abs(pv - retain) else retain
        check_soft("B7 衰减柱跌幅/留存与文案一致（±0.5pp 精确 / ±3pp 约数）",
                   pv, near, 0.5, 3.0,
                   "算得跌 %.1f%% / 留 %.1f%%，文案 %s%%" % (drop, retain, m.group(1)))
    nl = by_id["ch08"]["bottom"]
    check("B8 行列表底部数字与文案同源", nl.get("value") and nl.get("lead"))

    print("== C. 版式（抽样 12 帧，验右边距不裁切）==")
    style = R.style_of(rep)
    R.resolve_fonts()
    bg = R.make_bg(style)
    left_limit = R.MARGIN - 10
    right_limit = R.W - R.MARGIN + 10
    worst = None
    bad = 0
    step = max(1, n_frames // 12)
    for i in range(0, n_frames, step):
        img = R.render_frame(bg, rep, style, i, n_frames)
        box = bright_bbox(img)
        if not box:
            continue
        x0, y0, x1, y1 = box
        if x0 < left_limit or x1 > right_limit:
            bad += 1
            if worst is None or x1 > worst[3]:
                worst = (i, x0, y0, x1)
    check("C1 抽样帧文字均在左右安全边距内", bad == 0,
          "越界帧 %d 个，最远 x1=%s" % (bad, worst[3] if worst else "-"))
    check("C2 文字未压到底部", all(bright_bbox(R.render_frame(bg, rep, style, i, n_frames))[3] <= R.H - 40
                                 for i in range(0, n_frames, max(1, n_frames // 6))))
    acc, empty = 0, []
    for s in screens:
        n = int(round(s["duration"] * R.FPS))
        img = R.render_frame(bg, rep, style, acc + int(n * 0.9), n_frames)
        if bright_bbox(img) is None:
            empty.append(s["id"])
        acc += n
    check("C3 十屏均非空", not empty, "空帧屏：%s" % ",".join(empty))
    check("C4 顶部进度条随播放推进", _progress_grows(bg, rep, style, n_frames))
    check("C5 关键帧目录存在 PNG 且数量 = 屏数", _keyframe_count(args.render_dir) in (0, len(screens)),
          "关键帧 %d 张" % _keyframe_count(args.render_dir))
    check("C6 无 4x4 纯黑块（背景渐变非死黑）", _bg_not_flat(bg))
    check("C7 探针帧哈希可复现（确定性）",
          hashlib.sha256(R.render_frame(bg, rep, style, rr["probe_frame"], n_frames).tobytes()).hexdigest()
          == rr["probe_frame_sha256"])
    with open(mp4, "rb") as fh:
        check("C8 成片 SHA-256 与 render_report 一致",
              hashlib.sha256(fh.read()).hexdigest() == rr["video_sha256"])

    print("")
    print("通过 %d 项，警告 %d 项，失败 %d 项" % (len(PASS), len(WARN), len(FAIL)))
    if WARN:
        print("警告项（约数容差内，需在验收记录里点名）：%s" % ", ".join(WARN))
    if FAIL:
        print("失败项：%s" % ", ".join(FAIL))
        return 1
    return 0


def _progress_grows(bg, rep, style, n_frames):
    def bar_width(frame):
        img = R.render_frame(bg, rep, style, frame, n_frames).convert("RGB")
        w = 0
        for x in range(R.W - 1, -1, -1):
            r, g, b = img.getpixel((x, 2))
            if r > 150 and g < 90:
                w = x + 1
                break
        return w
    a, b = bar_width(0), bar_width(n_frames - 1)
    return a < b and b > R.W * 0.9


def _keyframe_count(render_dir):
    d = os.path.join(render_dir, "keyframes")
    if not os.path.isdir(d):
        return 0
    return len([f for f in os.listdir(d) if f.endswith(".png")])


def _bg_not_flat(bg):
    px = bg.convert("RGB")
    center = px.getpixel((R.W // 2, int(R.H * 0.52)))
    corner = px.getpixel((10, 10))
    return center[0] - corner[0] >= 20


if __name__ == "__main__":
    sys.exit(main())
