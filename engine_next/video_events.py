# -*- coding: utf-8 -*-
"""============================================================================
 video_events · 可复用的「曲线事件可视化」组件（纯逻辑，无渲染副作用）
 ---------------------------------------------------------------------------
 目标：把「什么时候、在谁身上、发生了什么事」抽象成一种中立的事件结构，
       让任意策略视频（分红再投资 / 买入 / 卖出 / 换仓 / 突破阈值）都能复用
       同一套「点锚定曲线 + 分级高亮 + 独立信息区」的表现机制。

 一条事件 = 一个 dict（见 EVENT_FIELDS）：
   id          str   唯一标识，用于去重与追溯
   date        str   交易日 YYYY-MM-DD，必须落在视频的交易日历里（强校验）
   dayIndex    int   该日期在交易日历中的下标（由 date 反查，不手写）
   kind        str   reinvest / trend / split / trade ...（决定图标与文案模板）
   series      str   事件归属的资产代码；曲线锚点用它定位                    ← 关键
   priority    int   1 = 重点事件（慢放 + 光圈 + 引线），0 = 普通事件
   reason      str   为什么选它（首次 / 单笔最大 / 规则阈值 / 人工指定）
   headline    str   信息区第一行（日期 ｜ 资产 ｜ 第 k/N 次）
   detail      str   信息区第二行（金额 → 数量，全部来自真实记录）
   value       float 金额（可选，便于机器校验）
   qty         float 份额（可选）
   price       float 成交价（可选）
   span        [str] 可选：趋势事件的两端资产，用于画「差距」量度线

 本模块只做三件事：
   1) 选事件：select_reinvest_events / detect_trend_events（阈值显式、可审计）
   2) 定锚点：anchor_xy() 用「当日该资产真实 totalAsset」换算像素坐标
   3) 排节奏：build_warp_timeline() 按重点事件做减速，不丢首末日、不破坏单调

 不负责画图；画图由调用方用自己的字号/配色实现，避免组件绑定某一支视觉风格。

 复用示例（中性占位，不代表任何真实标的）：
   ev = make_event(date="2024-03-15", kind="trade", series="DEMO_A",
                   priority=1, reason="阈值触发",
                   headline="2024-03-15 ｜ 示例资产 A ｜ 第 2 次换仓",
                   detail="清仓 178,000 份 → 买入示例资产 B 96,000 份")
   events = validate_events([ev], dates, codes)
   tl = build_warp_timeline(len(dates), 1000, [e["dayIndex"] for e in events if e["priority"]])
============================================================================"""

import math

EVENT_FIELDS = ("id", "date", "dayIndex", "kind", "series", "priority",
                "reason", "headline", "detail")


# ------------------------------------------------------------------ 格式
def fmt_money(v):
    return "{:,.2f}".format(float(v))


def fmt_qty(v):
    return "{:,}".format(int(round(float(v))))


def fmt_price(v):
    s = ("%.3f" % float(v)).rstrip("0").rstrip(".")
    return s


# ------------------------------------------------------------------ 构造
def make_event(date, day_index, kind, series, priority, reason,
               headline, detail, **extra):
    """构造一条事件；多余字段（value/qty/price/span）原样保留。"""
    ev = {
        "date": date, "dayIndex": int(day_index), "kind": kind,
        "series": series, "priority": int(priority), "reason": reason,
        "headline": headline, "detail": detail,
        "id": extra.pop("id", None) or "%s_%s_%s" % (kind, date, series or "all"),
    }
    ev.update(extra)
    return ev


# ------------------------------------------------------------------ 校验
def validate_events(events, dates, codes):
    """强校验：日期在日历内、series 合法、下标与日期一致、优先级合法、id 唯一。

    任何一条不符直接抛 ValueError —— 宁可不渲染，也不让标记落到错误的曲线上。
    """
    idx = {d: i for i, d in enumerate(dates)}
    seen = set()
    for ev in events:
        for k in EVENT_FIELDS:
            if k not in ev:
                raise ValueError("事件缺少字段 %s: %r" % (k, ev))
        if ev["date"] not in idx:
            raise ValueError("事件日期不在交易日历内：%s" % ev["date"])
        if ev["dayIndex"] != idx[ev["date"]]:
            raise ValueError("事件下标与日期不符：%s dayIndex=%s 期望=%d"
                             % (ev["date"], ev["dayIndex"], idx[ev["date"]]))
        if ev["series"] is not None and ev["series"] not in codes:
            raise ValueError("事件归属资产非法：%s" % ev["series"])
        if ev["priority"] not in (0, 1):
            raise ValueError("priority 只能是 0/1：%r" % ev["priority"])
        if ev["id"] in seen:
            raise ValueError("事件 id 重复：%s" % ev["id"])
        seen.add(ev["id"])
        for c in ev.get("span") or []:
            if c not in codes:
                raise ValueError("span 资产非法：%s" % c)
    return sorted(events, key=lambda e: (e["dayIndex"], e["kind"]))


# ------------------------------------------------------------------ 选事件
def select_reinvest_events(divs_a, trades_a, extra_dates=(), max_key=6):
    """从真实再投资记录里挑选「重点事件」，其余为普通事件。

    选取规则（全部可解释、可审计，不编造）：
      · 首次再投资      —— 全片第一次分红再投资
      · 末次再投资      —— 区间最后一次
      · 单笔金额最大    —— 真实分红金额最大的一笔
      · 该基金首次      —— 每只发生过分红的基金的第一笔
      · 人工指定        —— config.key_events.extra 里显式列出的日期（如本期 2024-10-24）
    结果按日期排序，最多 max_key 条；info 里保留 reason 便于报告逐条说明。
    """
    divs = sorted(divs_a, key=lambda e: (e["reinvestDate"], e["code"]))
    if not divs:
        return [], []
    trade_by = {}
    for t in trades_a:
        trade_by[(t["date"], t["code"])] = t

    total = len(divs)
    order = {e["noticeId"]: k + 1 for k, e in enumerate(divs)}

    picked = {}

    def add(e, reason):
        if e["reinvestDate"] in picked:
            # 已入选：合并原因，不重复计入
            old = picked[e["reinvestDate"]]
            if reason not in old["reason"]:
                old["reason"] += " / " + reason
            return
        picked[e["reinvestDate"]] = {"event": e, "reason": reason}

    add(divs[0], "首次再投资")
    add(divs[-1], "末次再投资")
    add(max(divs, key=lambda e: float(e["amount"])), "单笔金额最大")
    first_by_code = {}
    for e in divs:
        first_by_code.setdefault(e["code"], e)
    for c, e in first_by_code.items():
        add(e, "该基金首次分红")

    for d in extra_dates:
        hit = next((e for e in divs if e["reinvestDate"] == d), None)
        if hit is not None:
            add(hit, "人工指定（本期重点展示）")

    keys = sorted(picked.values(), key=lambda p: p["event"]["reinvestDate"])[:max_key]
    key_dates = {p["event"]["reinvestDate"] for p in keys}

    events = []
    for e in divs:
        t = trade_by.get((e["reinvestDate"], e["code"]))
        if t is None:
            raise ValueError("再投资事件缺少对应成交记录：%s %s"
                             % (e["reinvestDate"], e["code"]))
        k = order[e["noticeId"]]
        is_key = e["reinvestDate"] in key_dates
        reason = picked[e["reinvestDate"]]["reason"] if is_key else "常规分红再投资"
        events.append({
            "date": e["reinvestDate"], "kind": "reinvest", "series": e["code"],
            "priority": 1 if is_key else 0, "reason": reason,
            "value": float(e["amount"]), "qty": float(t["sharesDelta"]),
            "price": float(t["price"]),
            "seq": k, "seqTotal": total,
            "headline": None,   # 由调用方用本地化文案填充
            "detail": None,
            "noticeId": e["noticeId"],
        })
    return events, keys


def detect_trend_events(by, dates, codes, cfg):
    """识别少量真实走势事件（不凑数）。

    cfg:
      sustained_lead: {min_run_days, min_gap_abs}   首次「此后一直领先」
      gap_milestone:  {abs_gap}                     首位与末位差距首次达到阈值
    返回事件草案（不含 headline/detail 文案）。
    """
    n = len(dates)
    out = []

    sl = (cfg or {}).get("sustained_lead")
    if sl:
        best = None
        for c in codes:
            # 该资产「从 i 起一直是第一」的最早 i
            first = None
            for i in range(n):
                if all(max((by[x][dates[j]], x) for x in codes)[1] == c for j in range(i, n)):
                    first = i
                    break
            if first is None or n - first < sl["min_run_days"]:
                continue
            if best is None or n - first > best[1]:
                best = (c, n - first, first)
        if best:
            c, run, i = best
            top = max((by[x][dates[i]], x) for x in codes)
            out.append({"date": dates[i], "kind": "trend", "series": c,
                        "priority": 1, "reason": "首次持续领先（此后未再让出第一）",
                        "trend": "sustained_lead", "run_days": run,
                        "gap_abs": top[0] - min(by[x][dates[i]] for x in codes)})

    gm = (cfg or {}).get("gap_milestone")
    if gm:
        for i in range(n):
            vals = sorted(((by[c][dates[i]], c) for c in codes), reverse=True)
            gap = vals[0][0] - vals[-1][0]
            if gap >= gm["abs_gap"]:
                out.append({"date": dates[i], "kind": "trend", "series": vals[0][1],
                            "priority": 0, "reason": "首位与末位差距首次达到阈值",
                            "trend": "gap_milestone", "gap_abs": gap,
                            "span": [vals[0][1], vals[-1][1]]})
                break
    return out


# ------------------------------------------------------------------ 锚点
def anchor_xy(series_asset, x_of_index, y_of_asset, day_index):
    """把「某日某资产的真实总资产」换算成像素锚点。

    刻意要求调用方传入 x_of_index / y_of_asset 两个换算函数，组件不持有坐标系，
    这样同一份事件数据可以复用到不同画幅、不同纵轴上限的视频里。
    """
    return x_of_index(day_index), y_of_asset(series_asset)


# ------------------------------------------------------------------ 节奏
def build_warp_timeline(n_days, main_frames, key_indices, hold_frames=24,
                        slow_days=3.0, peak=16.0, guard=None):
    """按重点事件做「减速停留」的时间轴，保持帧数不变、不跳日。

    原理（成本域构造，事件落点天然确定，无需迭代）：
      给每个交易日一个「成本」，普通日成本 1；重点事件附近成本按三角峰抬高
      （峰宽 slow_days 天、峰值 peak 倍）。帧在成本轴上均匀铺开，再反解出
      每帧对应的交易日 → 成本高的区域一天被摊到更多帧，即曲线在该处减速；
      成本函数连续 → 位置函数连续且严格单调，曲线不会跳、日期与金额始终同步。
      事件日的成本最高 → 事件日必然成为采样点（且被重复采样多次）。

    :param hold_frames: 语义为「单个重点事件的目标慢放时长（帧）」，用于按
                        事件数量自动标定峰值，使总慢放时长接近 hold_frames×事件数。
    :param guard:       可选 callable(TL)，复用 kd001_timeline.validate_timeline
                        做 I1..I6 后置断言（首末日、单调、关键帧不丢失）。
    """
    from bisect import bisect_right

    if n_days < 2 or main_frames < 4:
        raise ValueError("n_days/main_frames 非法")
    last = n_days - 1
    key_indices = sorted({int(k) for k in key_indices})

    # 按事件数量标定峰值：extra_cost × (main_frames/total_cost) ≈ hold_frames
    # 用两轮估算即可足够准确
    peak_eff = float(peak)
    for _ in range(3):
        cost = [1.0] * n_days
        for e in key_indices:
            lo, hi = max(0, e - int(slow_days) - 1), min(n_days - 1, e + int(slow_days) + 1)
            for d in range(lo, hi + 1):
                t = abs(d - e) / float(slow_days)
                if t < 1.0:
                    cost[d] += peak_eff * (1.0 - t)
        total = sum(cost)
        extra_per = peak_eff * slow_days / 2.0
        # 目标：每个事件慢放区占用 hold_frames 帧 → extra_per * fpc ≈ hold_frames
        fpc = main_frames / total
        peak_eff = max(1.0, (hold_frames / fpc) * 2.0 / slow_days)

    cost = [1.0] * n_days
    for e in key_indices:
        lo, hi = max(0, e - int(slow_days) - 1), min(n_days - 1, e + int(slow_days) + 1)
        for d in range(lo, hi + 1):
            t = abs(d - e) / float(slow_days)
            if t < 1.0:
                cost[d] += peak_eff * (1.0 - t)
    C = [0.0]
    for x in cost:
        C.append(C[-1] + x)
    total = C[-1]

    TL = []
    for f in range(main_frames):
        p = f * total / (main_frames - 1)
        k = bisect_right(C, p) - 1
        k = max(0, min(n_days - 1, k))
        seg = C[k + 1] - C[k]
        frac = (p - C[k]) / seg if seg > 0 else 0.0
        TL.append(int(round(k + frac)))
    TL[0] = 0
    TL[-1] = last
    # 钳制：round(k+frac) 在末段可能越界到 n_days（= last+1），必须夹回 [0, last]
    TL = [max(0, min(last, v)) for v in TL]
    TL[0], TL[-1] = 0, last

    for e in key_indices:
        if e not in TL:
            raise ValueError("重点事件日 %d 未成为采样点（成本峰标定失败）" % e)
        if TL.count(e) < 2:
            raise ValueError("重点事件日 %d 停留不足（仅 1 帧）" % e)

    for p_ in range(main_frames - 1):
        if TL[p_] > TL[p_ + 1]:
            raise ValueError("时间轴非单调：%d > %d" % (TL[p_], TL[p_ + 1]))
    if TL[-1] != last:
        raise ValueError("末日常丢失：%r" % (TL[-1],))
    if guard:
        guard(TL)
    return TL


def build_smooth_timeline(n_days, frames, key_indices, hold_frames=30,
                          smooth_days=4.0, peak=18.0, hold_cap=0.42,
                          min_step=1e-6, guard=None):
    """「浮点 + 余弦核 + 密度自适应」的平滑时间轴（build_warp_timeline 的严选替代）。

    为什么需要它：build_warp_timeline 返回 int(round(k+frac))，当「帧数 < 天数」
    时普通区每帧要跨 2~3 天，取整会让步长在 2/3 之间交替（judder：曲线一跳一跳），
    慢放区则因四舍五入出现十几帧完全相同的值（死停），出慢放区后速度瞬间从 0
    回到 3 天/帧（顿挫）。V1.2 开头几秒的「卡顿感」正是这样来的。

    与旧函数的三点差别：
      1) 返回 float 位置（0..n_days-1），渲染端可做亚像素推进 → 每帧位移连续；
      2) 慢放核用余弦窗 (1+cos(πt))/2 取代三角峰 → 速度在一、二阶都连续，
         进出慢放区不再有折角；
      3) 密度自适应：相邻重点事件的慢放区重叠时按重叠量等比削减峰值，
         避免 3 个事件在 4 个月内叠成 0.6 秒死停（V1.2 开头即此情形）。

    成本域构造不变：帧在成本轴上均匀铺开再反解，位置单调、事件日被多次采样。
    峰值一次解出（核是线性的，extra = peak × Σshape），无需迭代。

    :param hold_frames: 单个重点事件的**目标**慢放帧数（实际受重叠削减与 hold_cap 约束）
    :param hold_cap:    慢放帧数占总帧数比例的上限（防止事件过多时把影片拖成慢动作）
    :param min_step:    相邻帧最小推进量（保证严格单调，浮点下几乎不会触发）
    :param guard:       可选 callable(POS) 后置断言
    """
    from bisect import bisect_right

    if n_days < 2 or frames < 4:
        raise ValueError("n_days/frames 非法")
    last = n_days - 1
    key_indices = sorted({int(k) for k in key_indices})
    if smooth_days <= 1:
        raise ValueError("smooth_days 必须 > 1")

    half = int(math.ceil(smooth_days))

    # ---------- 1) 密度自适应：重叠的慢放区按比例降峰，避免叠加成死停 ----------
    eff_scale = {}
    for e in key_indices:
        near = [abs(e - o) for o in key_indices if o != e]
        dmin = min(near) if near else float("inf")
        if dmin < 2.0 * smooth_days:
            w = dmin / (2.0 * smooth_days)        # 0 = 完全重叠，1 = 刚好不重叠
            eff_scale[e] = max(0.28, w ** 0.6)  # 中度重叠仍保留大部分强度
        else:
            eff_scale[e] = 1.0

    # ---------- 2) 核形状（与 peak 无关），一次解出峰值 ----------
    shape = [0.0] * n_days
    for e in key_indices:
        lo, hi = max(0, e - half), min(n_days - 1, e + half)
        for d in range(lo, hi + 1):
            t = abs(d - e) / float(smooth_days)
            if t < 1.0:
                shape[d] += 0.5 * (1.0 + math.cos(math.pi * t)) * eff_scale[e]
    s_shape = sum(shape)

    # 目标慢放占比：hold_frames × 事件数 / 总帧，再受 hold_cap 约束
    want = hold_frames * len(key_indices) / float(frames)
    ratio = min(want, hold_cap)
    extra_target = ratio * n_days / max(1e-9, (1.0 - ratio))
    peak_eff = (extra_target / s_shape) if s_shape > 0 else 0.0
    peak_eff = max(0.0, min(float(peak), peak_eff))

    cost = [1.0 + peak_eff * shape[d] for d in range(n_days)]
    C = [0.0]
    for x in cost:
        C.append(C[-1] + x)
    total = C[-1]

    # ---------- 3) 反解为浮点位置 ----------
    POS = []
    for f in range(frames):
        p = f * total / (frames - 1)
        k = bisect_right(C, p) - 1
        k = max(0, min(n_days - 1, k))
        seg = C[k + 1] - C[k]
        frac = (p - C[k]) / seg if seg > 0 else 0.0
        POS.append(min(float(last), max(0.0, k + frac)))

    POS[0], POS[-1] = 0.0, float(last)
    # 严格单调（浮点下冗余，但避免极端参数造成平台）
    for f in range(1, frames):
        if POS[f] - POS[f - 1] < min_step:
            POS[f] = POS[f - 1] + min_step
    if POS[-1] < last:                       # 单调修正后回填末帧，并等比压缩尾部
        drift = POS[-1] - last
        if drift > 0:
            span = POS[-1] - POS[0]
            if span > 0:
                for f in range(frames):
                    POS[f] = POS[0] + (POS[f] - POS[0]) * (1.0 - drift / span)
        POS[-1] = float(last)

    if guard:
        guard(POS)
    return POS


def smoothness_report(POS, drop_last=1):
    """时间轴平滑度体检：抖动（judder）、死停、速度突变的三项量化指标。

    判定口径（末帧 = 终点定格，天然可静止，按 drop_last 排除）：
      zero_frames    相邻帧位移 < 1e-6 的帧数（旧 int 时间轴在 V1.2 中为 331/1319）
      max_still      最长连续零位移帧数（旧 V1.2 = 18 帧 = 0.60s，观感即「卡住」）
      cv             位移的变异系数（标准差/均值），越小越顺；旧 V1.2 = 0.63
      max_accel      相邻两步位移的最大变化 ÷ 中位步长 —— 真正衡量「顿挫」的指标；
                     旧 V1.2 在慢放入口处为 3.0/3 ≈ 1.0（一步之内从 3 天砸到 0 天）
    """
    P = POS[:-drop_last] if drop_last and len(POS) > drop_last + 2 else POS
    if len(P) < 3:
        raise ValueError("帧数过少")
    d = [P[i + 1] - P[i] for i in range(len(P) - 1)]
    mean = sum(d) / len(d)
    var = sum((x - mean) ** 2 for x in d) / len(d)
    sd = math.sqrt(var)
    zero = sum(1 for x in d if abs(x) < 1e-6)
    mx = cur = 0
    for x in d:
        cur = cur + 1 if abs(x) < 1e-6 else 0
        mx = max(mx, cur)
    srt = sorted(d)
    med = srt[len(srt) // 2]
    acc = max((abs(d[k + 1] - d[k]) for k in range(len(d) - 1)), default=0.0)
    return {
        "frames": len(d),
        "zero_frames": zero,
        "max_still_frames": mx,
        "mean_step_days": round(mean, 4),
        "median_step_days": round(med, 4),
        "cv": round(sd / mean, 4) if mean > 0 else 0.0,
        "max_accel": round(acc / med, 3) if med > 1e-9 else float("inf"),
        "min_step_days": round(min(d), 5),
        "max_step_days": round(max(d), 4),
    }


def hold_report(TL, key_indices, tol=1):
    """统计每个重点事件的慢放规模：±tol 日内被采样的帧数（可视停留时长）。"""
    out = []
    for e in key_indices:
        n = sum(1 for x in TL if abs(x - e) <= tol)
        out.append({"dayIndex": int(e), "frames": n, "seconds": round(n / 30.0, 2)})
    return out
