# -*- coding: utf-8 -*-
"""验收反向验证：故意改坏一份结果，确认 20 项验收会失败。

为什么需要：如果验收项写错（键名不对、容差过宽），它会永远 PASS，
「20/20」就变成空跑。本脚本用「注入故障 → 必须报错」证明检查真的有效。

用法：
    python tools/check_accept_negative.py                       # 默认取 output/strategy_600000_A
    python tools/check_accept_negative.py --run strategy_600000_B
    python tools/check_accept_negative.py --dir output/<run>

流程：复制结果目录 → 注入 3 处故障 → 跑验收 → 断言「未全通过、退出码非 0、
指定检查项失败」→ 清理临时目录。全程不改动原 run。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ACCEPT = os.path.join(ROOT, "engine_next", "tests", "accept_strategy_video.py")

# 注入的故障 -> 期望失败的检查项名称（与 accept_strategy_video.py 的文案保持一致）
EXPECT = [
    ("买入价被抬高 1%", "买入价 = 当日 close"),
    ("某日持股数被改 -100", "逐日持股数由 trades 净额解释"),
    ("末日现金改为 -5000", "现金全程不为负"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="strategy_600000_A", help="作为基线的 output/<run>")
    ap.add_argument("--dir", default="", help="直接指定基线目录")
    args = ap.parse_args()

    src = args.dir or os.path.join(ROOT, "output", args.run)
    result_src = os.path.join(src, "02_backtest", "backtest_result.json")
    if not os.path.isfile(result_src):
        print("E_MISSING: {}".format(result_src), file=sys.stderr)
        return 2

    dst = os.path.join(ROOT, "output", "_neg_accept")
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    try:
        p = os.path.join(dst, "02_backtest", "backtest_result.json")
        result = json.load(open(p, encoding="utf-8"))

        for t in result["trades"]:
            if t["side"] == "BUY":
                t["price"] = round(t["price"] * 1.01, 4)
                break
        for e in result["equity"]:
            if e["shares"] > 0:
                e["shares"] = e["shares"] - 100
                break
        result["equity"][-1]["cash"] = -5000.0
        json.dump(result, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

        proc = subprocess.run([sys.executable, ACCEPT, "--dir", dst],
                              capture_output=True, text=True, encoding="utf-8")
        out = proc.stdout or ""
        fails = [ln.split("]", 1)[1].strip() for ln in out.splitlines() if ln.startswith("[FAIL]")]
        summary = [ln for ln in out.splitlines() if "策略视频验收：" in ln]

        passed = 0
        total = 0
        if summary:
            num = summary[-1].split("：", 1)[1].replace("通过", "").strip()
            passed, total = (int(x) for x in num.split("/"))

        ok = True
        print("注入故障：{} 处".format(len(EXPECT)), "-> 验收结果：{}/{}".format(passed, total))
        if total != 20:
            print("[FAIL] 验收项数不是 20（脚本可能没更新）")
            ok = False
        else:
            print("[PASS] 验收项数为 20")
        if passed >= total:
            print("[FAIL] 注入故障后仍然全通过 —— 验收项可能是空跑")
            ok = False
        else:
            print("[PASS] 注入故障后未全通过（{} 项失败）".format(len(fails)))
        for label, name in EXPECT:
            hit = any(name in f for f in fails)
            print("[{}] {} -> 期望失败项命中：{}".format("PASS" if hit else "FAIL", label, name))
            ok = ok and hit
        if proc.returncode == 0:
            print("[FAIL] 退出码为 0，失败未被传递")
            ok = False
        else:
            print("[PASS] 退出码非 0（{}）".format(proc.returncode))

        print("\n反向验证：{}".format("PASS" if ok else "FAIL"))
        if not ok:
            print("---- 验收原始输出 ----")
            print(out)
        return 0 if ok else 1
    finally:
        if os.path.isdir(dst):
            shutil.rmtree(dst)


if __name__ == "__main__":
    sys.exit(main())
