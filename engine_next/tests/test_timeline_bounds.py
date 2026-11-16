# -*- coding: utf-8 -*-
"""============================================================================
 build_smooth_timeline 边界矩阵（V1.2.3 回归锚点）
 ---------------------------------------------------------------------------
 背景：V1.2.1/V1.2.2 把 n_days 个「日密度」直接当区间成本，末日后多出一个
 幻影区间，反解被钳成同一位置 → 尾部零位移帧（260 日样本 4 帧、34 日 46 帧）。
 V1.2.3 修复后，本脚本对「交易日数 × 帧数 × 事件分布」全矩阵断言四条硬性
 不变量；任何一条不成立即退出码 1：

   I1 首末覆盖      POS[0]=0 且 POS[-1]=n_days-1（不虚构、不裁剪交易日）
   I2 单调          逐帧位置不减（末帧终点定格豁免）
   I3 零位移 = 0    除末帧外无 <1e-6 的位移帧
   I4 最长死停 = 0  无连续静止段（重点事件靠密度慢放，不靠钳制静止）

 cv / max_accel 随事件密度与帧密度变化，不设样本特定阈值，仅打印供比对；
 V1.2.3 验收脚本对成片仍沿用 cv ≤ 0.45 / max_accel ≤ 0.9（2633 日演示样例标定）。

 用法：python engine_next/tests/test_timeline_bounds.py
============================================================================"""
import itertools
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from video_events import build_smooth_timeline, smoothness_report  # noqa: E402

EVENT_LAYOUTS = [
    ("单事件@末尾", lambda n: [n - 1]),
    ("单事件@预热后", lambda n: [min(33, n - 1)]),
    ("早期密集(相邻+重叠)", lambda n: [k for k in (35, 36, 40, 41, 45) if k < n]),
    ("均匀5点", lambda n: [int(n * p) for p in (0.13, 0.31, 0.5, 0.72, 0.9)]),
    ("相邻对", lambda n: [n // 2, n // 2 + 1] if n > 4 else [0]),
    ("首末各一", lambda n: [0, n - 1]),
]
LENGTHS = [34, 35, 45, 60, 260, 660, 1320, 2000, 2633, 5000]
FRAME_COUNTS = [300, 660, 1320]

failures = []
for (lname, fn), n, frames in itertools.product(EVENT_LAYOUTS, LENGTHS, FRAME_COUNTS):
    keys = sorted({min(max(k, 0), n - 1) for k in fn(n)})
    pos = build_smooth_timeline(n, frames, keys, smooth_days=5.0, hold_frames=30.0)
    tag = "%s N=%d F=%d" % (lname, n, frames)

    if abs(pos[0]) > 1e-9 or abs(pos[-1] - (n - 1)) > 1e-9:
        failures.append("%s I1 首末覆盖 (%.4f, %.4f)" % (tag, pos[0], pos[-1]))
    if any(pos[i] > pos[i + 1] + 1e-9 for i in range(len(pos) - 1)):
        failures.append("%s I2 单调" % tag)
    sm = smoothness_report(pos)
    if sm["zero_frames"] != 0:
        failures.append("%s I3 零位移=%d" % (tag, sm["zero_frames"]))
    if sm["max_still_frames"] != 0:
        failures.append("%s I4 最长死停=%d" % (tag, sm["max_still_frames"]))

print("用例数：%d（事件分布 %d × 交易日 %d × 帧数 %d）"
      % (len(EVENT_LAYOUTS) * len(LENGTHS) * len(FRAME_COUNTS),
         len(EVENT_LAYOUTS), len(LENGTHS), len(FRAME_COUNTS)))
if failures:
    print("不达标 %d 项：" % len(failures))
    for f in failures:
        print("  FAIL", f)
    sys.exit(1)
print("全部达标：首末覆盖 / 单调 / 零位移=0 / 最长死停=0")
print("（cv 与 max_accel 随事件密度变化，见 acceptance 对成片的独立断言）")
