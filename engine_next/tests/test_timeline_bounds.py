# -*- coding: utf-8 -*-
"""============================================================================
 build_smooth_timeline 边界矩阵 + 封版口径冻结（V1.2.3 回归锚点）
 ---------------------------------------------------------------------------
 背景：V1.2.1/V1.2.2 把 n_days 个「日密度」直接当区间成本，末日后多出一个
 幻影区间，反解被钳成同一位置 → 尾部零位移帧（260 日样本 4 帧、34 日 46 帧）。
 V1.2.3 修复后成本域建在「日区间」上。两套口径并存（cost_domain）：

   cost_domain="days"       封版口径，V1.2.2 默认；V0.1 演示用它，
                            必须与原公开版本逐字节一致 → 由 FROZEN 摘要锁定
   cost_domain="intervals"  V1.2.3 口径，用户 CSV 视频用它 → 全矩阵断言不变量

 第一部分（不变量，仅 intervals 口径）：对「交易日数 × 帧数 × 事件分布」全矩阵
 断言四条硬性不变量；任何一条不成立即退出码 1：

   I1 首末覆盖      POS[0]=0 且 POS[-1]=n_days-1（不虚构、不裁剪交易日）
   I2 单调          逐帧位置不减（末帧终点定格豁免）
   I3 零位移 = 0    除末帧外无 <1e-6 的位移帧
   I4 最长死停 = 0  无连续静止段（重点事件靠密度慢放，不靠钳制静止）

 第二部分（冻结，days 口径）：三组参数的 POS 序列 SHA-256 与封版实现逐位一致，
 防止「修短样本」时把 V0.1 已发布的画面悄悄改了。

 cv / max_accel 随事件密度与帧密度变化，不设样本特定阈值，仅打印供比对；
 V1.2.3 验收脚本对成片仍沿用 cv ≤ 0.45 / max_accel ≤ 0.9（2633 日演示样例标定）。

 用法：python engine_next/tests/test_timeline_bounds.py
============================================================================"""
import hashlib
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

# 封版（32418a7）build_smooth_timeline 在下列参数下的 POS 序列摘要。
# 这些值不是估算：由提交 32418a7 的实现逐位算出并冻结，改一行即失败。
FROZEN = [
    ("V0.1 演示 2830 日 / 5 事件", 2830, 1320, [60, 100, 215, 2791, 2806],
     "58065a263f9744ad9c23045fa28196802d0eea9c6c977b5da453c06f2d997bb0"),
    ("260 日用户样本 / 5 事件", 260, 1320, [35, 36, 166, 237, 255],
     "6d8321f0017d5738bfa4ad83781f7dc6c09e2a21085b96e13a96ddcb48c7b27e"),
    ("34 日边界 / 1 事件", 34, 300, [33],
     "0baf5d3be1b189f6fc0c46df69a52b3b8b69ba482fdfb514c7363d9d77f0d311"),
]


def digest(pos):
    return hashlib.sha256("\n".join("%.10f" % v for v in pos).encode()).hexdigest()


failures = []

# ---------- 第一部分：intervals 口径的不变量矩阵 ----------
for (lname, fn), n, frames in itertools.product(EVENT_LAYOUTS, LENGTHS, FRAME_COUNTS):
    keys = sorted({min(max(k, 0), n - 1) for k in fn(n)})
    pos = build_smooth_timeline(n, frames, keys, smooth_days=5.0, hold_frames=30.0,
                                cost_domain="intervals")
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

# ---------- 第二部分：封版口径冻结（V1.2.2 / V0.1 演示不得漂移） ----------
for name, n, frames, keys, want in FROZEN:
    pos = build_smooth_timeline(n, frames, keys, hold_frames=30.0, smooth_days=5.0)
    got = digest(pos)
    ok = got == want
    print("封版口径 %-28s %s  %s" % (name, "OK " if ok else "FAIL", got[:16]))
    if not ok:
        failures.append("封版口径漂移：%s（期望 %s…，实得 %s…）" % (name, want[:16], got[:16]))

# 口径确实不同（否则说明开关没接上，用户 CSV 的短样本修复等于没生效）
demo_days = build_smooth_timeline(260, 1320, [35, 36, 166, 237, 255],
                                  hold_frames=30.0, smooth_days=5.0)
demo_iv = build_smooth_timeline(260, 1320, [35, 36, 166, 237, 255],
                                hold_frames=30.0, smooth_days=5.0,
                                cost_domain="intervals")
z_days = smoothness_report(demo_days)["zero_frames"]
z_iv = smoothness_report(demo_iv)["zero_frames"]
print("260 日样本零位移帧：封版口径 %d / V1.2.3 口径 %d" % (z_days, z_iv))
if not (z_days > 0 and z_iv == 0):
    failures.append("口径隔离失效：封版=%d、V1.2.3=%d（预期 >0 与 ==0）" % (z_days, z_iv))

if failures:
    print("不达标 %d 项：" % len(failures))
    for f in failures:
        print("  FAIL", f)
    sys.exit(1)
print("全部达标：首末覆盖 / 单调 / 零位移=0 / 最长死停=0；封版口径逐位冻结")
print("（cv 与 max_accel 随事件密度变化，见 acceptance 对成片的独立断言）")
