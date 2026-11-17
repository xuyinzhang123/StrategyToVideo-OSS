#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""V0.2 股票通道的「数据接口层」：从 pytdx 拉未复权日线，生成合规 CSV 包。

定位（严格边界）：
  * 本脚本只做「取数 + 规范化 + 前置校验」，输出两个文件：
      - <out>/stock_ohlc.csv    列 date,open,high,low,close,volume,amount（amount 可空）
      - <out>/meta.json         symbol/name/adjust=none/来源/抓取参数（不进 CSV 列）
  * 不碰 web/、不碰引擎、不碰回测、不碰渲染、不写 output/。生成的 CSV 拿到网页
    按 stock_ohlc 导入即可，和手工导出的 CSV 走完全相同的校验与出片链路。
  * pytdx 是**可选依赖**：仅 --live 真实取数时才 import；--selftest 离线模式
    不需要 pytdx、不需要网络，用内置样例验证规范化与门禁逻辑。

关键口径（来自 docs/DATA_SPEC.md，逐条对齐）：
  * 只取未复权（adjust=none）。pytdx 的 get_security_bars 返回的是交易所原始价，
    正好是 V0.2 唯一接受的口径；qfq/hfq 一律不生成（G-6）。
  * 板块只放行沪深主板 600/601/603/605 + 000/001/002/003；其余本地先拒。
  * 起点 >= 2015-08-01（早于此无费率规则）。
  * OHLC 自洽：high >= max(open,close,low)，low <= min(open,close,high)，价 > 0。
  * 至少 34 个交易日（MACD 12/26/9 的 readyFrom = 33，需 34 根）。
  * **分红不强造**：pytdx 的除权数据只有除权日，没有股权登记日与派息日；
    DATA_SPEC §4.3 明确登记日/派息日不可推导、且必须是交易日历内的交易日。
    因此本脚本不生成 dividend.csv。需要计分红的股票，请用 --dividend-hint
    导出「除权线索」供人工去交易所公告核对登记日/派息日后再补表，绝不猜。

用法：
  # 1) 离线自检（无需 pytdx/网络）——拿到新机器先跑这个确认脚本本身可用
  python datafeed/pytdx_fetch.py --selftest

  # 2) 真实取数（已装 pytdx 且能连通行情服务器）
  PYTHONPATH=<pytdx安装目录> python datafeed/pytdx_fetch.py --live \
      --code 600000 --name 浦发银行 --days 260 --out datafeed/out/600000

  # 3) 导出除权线索（供人工补分红表，不是可直接上传的 dividend.csv）
  PYTHONPATH=<pytdx安装目录> python datafeed/pytdx_fetch.py --live \
      --code 600000 --days 260 --out datafeed/out/600000 --dividend-hint

  # 4) 集合竞价数据可得性探测（验证 pytdx 能否拿到 9:25 成交，供超短线策略评估）
  PYTHONPATH=<pytdx安装目录> python datafeed/pytdx_fetch.py --probe-auction \
      --code 600000 --date 2024-12-30
"""

from __future__ import annotations

import argparse
import csv
import datetime as _dt
import hashlib
import io
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

COST_RULES_START = "2015-08-01"
MIN_BARS = 34
BOARD_PREFIXES = ("600", "601", "603", "605", "000", "001", "002", "003")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# pytdx 公开行情服务器（多个备用，逐个尝试；均为免费通达信行情端口 7709）
DEFAULT_SERVERS = [
    ("119.147.212.81", 7709),
    ("123.125.108.80", 7709),
    ("115.238.90.165", 7709),
    ("180.153.18.170", 7709),
    ("218.108.98.244", 7709),
]

CATEGORY_DAY = 9  # pytdx: 日 K 线


class DatafeedError(Exception):
    """数据接口层的所有可预期失败，统一带 E_ 错误码。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# --------------------------------------------------------------------------
# 纯函数：规范化与门禁（离线可测，不依赖 pytdx）
# --------------------------------------------------------------------------
def board_of(code: str) -> Optional[str]:
    if not re.fullmatch(r"\d{6}", code or ""):
        return None
    if code.startswith(("600", "601", "603", "605")):
        return "SH_MAIN"
    if code.startswith(("000", "001", "002", "003")):
        return "SZ_MAIN"
    return None


def market_of(code: str) -> int:
    """pytdx market: 0=深圳, 1=上海。"""
    board = board_of(code)
    if board == "SH_MAIN":
        return 1
    if board == "SZ_MAIN":
        return 0
    raise DatafeedError("E_UNSUPPORTED_BOARD", f"代码 {code} 不在沪深主板代码段内")


def _fmt(v: Any, nd: int = 2) -> str:
    """把 pytdx 的数值格式化成定点小数，避免科学计数法与浮点尾数。"""
    return f"{float(v):.{nd}f}"


def normalize_bars(raw: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """pytdx 原始 bar -> 合规行。pytdx 日线字段：datetime/YYYY-MM-DD, open, high, low, close, vol, amount。"""
    out: List[Dict[str, str]] = []
    seen = set()
    for i, b in enumerate(raw):
        dt = str(b.get("datetime") or b.get("date") or "")[:10].replace("/", "-")
        if not DATE_RE.match(dt):
            raise DatafeedError("E_DATE_FORMAT", f"第 {i + 1} 条 bar 日期非法：{dt!r}")
        if dt in seen:
            raise DatafeedError("E_DUP_DATE", f"日期 {dt} 重复（pytdx 返回了重复交易日）")
        seen.add(dt)
        try:
            o, h, l, c = (float(b[k]) for k in ("open", "high", "low", "close"))
        except (KeyError, TypeError, ValueError) as exc:
            raise DatafeedError("E_BAD_NUMBER", f"第 {i + 1} 条 bar 的 OHLC 缺失或非法：{exc}")
        for label, val in (("open", o), ("high", h), ("low", l), ("close", c)):
            if not (val > 0) or val != val or val in (float("inf"), float("-inf")):
                raise DatafeedError("E_PRICE_NONPOSITIVE", f"{dt} 的 {label} 不是正的有限数：{val}")
        if h < max(o, c, l) or l > min(o, c, h):
            raise DatafeedError("E_OHLC_INCONSISTENT", f"{dt} OHLC 矛盾：开{o}/高{h}/低{l}/收{c}")
        vol_raw = b.get("vol", b.get("volume", 0))
        amt_raw = b.get("amount", "")
        try:
            vol = int(float(vol_raw or 0))
        except (TypeError, ValueError):
            raise DatafeedError("E_BAD_NUMBER", f"{dt} 成交量非法：{vol_raw!r}")
        if vol < 0:
            raise DatafeedError("E_BAD_NUMBER", f"{dt} 成交量为负：{vol}")
        amt = "" if amt_raw in (None, "") else _fmt(amt_raw)
        if amt and float(amt) < 0:
            raise DatafeedError("E_BAD_NUMBER", f"{dt} 成交额为负：{amt_raw!r}")
        out.append({
            "date": dt, "open": _fmt(o), "high": _fmt(h), "low": _fmt(l),
            "close": _fmt(c), "volume": str(vol), "amount": amt,
        })
    out.sort(key=lambda r: r["date"])
    return out


def check_gates(rows: List[Dict[str, str]], code: str) -> Dict[str, Any]:
    """本地复刻网页校验的硬门禁；返回 meta 摘要。任何不满足直接抛 DatafeedError。"""
    board = board_of(code)
    if board is None:
        raise DatafeedError(
            "E_UNSUPPORTED_BOARD",
            f"代码 {code} 不在沪深主板（600/601/603/605/000/001/002/003）；"
            "创业板/科创板/北交所/B股按 10% 判涨跌停会算错，本版不支持。",
        )
    if len(rows) < MIN_BARS:
        raise DatafeedError("E_TOO_FEW_BARS", f"仅 {len(rows)} 个交易日，MACD(12,26,9) 至少需要 {MIN_BARS} 根")
    if rows[0]["date"] < COST_RULES_START:
        raise DatafeedError(
            "E_DATE_BEFORE_COST_RULES",
            f"起点 {rows[0]['date']} 早于 {COST_RULES_START}，该时段无费率规则；请用 --days 截取更近的数据。",
        )
    return {"symbol": code, "board": board, "adjust": "none",
            "start": rows[0]["date"], "end": rows[-1]["date"], "bars": len(rows)}


def render_csv(rows: List[Dict[str, str]]) -> str:
    """生成最终 CSV 文本：固定表头顺序、单个末尾换行（行数统计不虚增）。"""
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=["date", "open", "high", "low", "close", "volume", "amount"],
                       lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


def build_package(raw: List[Dict[str, Any]], code: str, name: str, source: str,
                  extra_meta: Optional[Dict[str, Any]] = None) -> Tuple[str, Dict[str, Any]]:
    rows = normalize_bars(raw)
    summary = check_gates(rows, code)
    csv_text = render_csv(rows)
    meta = {
        "symbol": code,
        "name": name or code,
        "adjust": "none",
        "source": source,
        "fetchedAt": extra_meta.get("fetchedAt") if extra_meta else None,
        "server": extra_meta.get("server") if extra_meta else None,
        "days": extra_meta.get("days") if extra_meta else None,
        "dividend": "NOT_INCLUDED",
        "dividendNote": (
            "pytdx 除权数据缺股权登记日与派息日，DATA_SPEC §4.3 禁止推导；"
            "本包不含 dividend.csv。需要计现金分红时请人工核对交易所公告后补三段式分红表。"
        ),
        "summary": summary,
        "csvSha256": hashlib.sha256(csv_text.encode("utf-8")).hexdigest(),
    }
    return csv_text, meta


def write_package(csv_text: str, meta: Dict[str, Any], out_dir: str) -> Dict[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    csv_path = os.path.join(out_dir, "stock_ohlc.csv")
    meta_path = os.path.join(out_dir, "meta.json")
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        f.write(csv_text)
    with open(meta_path, "w", encoding="utf-8", newline="") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return {"csv": csv_path, "meta": meta_path}


# --------------------------------------------------------------------------
# 可选：pytdx 真实取数（延迟导入，离线路径永不触发）
# --------------------------------------------------------------------------
def _import_pytdx():
    try:
        from pytdx.hq import TdxHq_API  # type: ignore
    except ImportError as exc:
        raise DatafeedError(
            "E_PYTDX_MISSING",
            "未安装 pytdx。请执行 python -m pip install --target deps-datafeed pytdx，"
            "运行时加 PYTHONPATH=deps-datafeed；或先用 --selftest 离线验证。",
        ) from exc
    return TdxHq_API


def _connect_api(TdxHq_API, host: Optional[str], port: int):
    api = TdxHq_API(heartbeat=True, auto_retry=True)
    candidates = [(host, port)] if host else DEFAULT_SERVERS
    errors = []
    for h, p in candidates:
        try:
            if api.connect(h, p, time_out=8):
                return api, h, p
        except Exception as exc:  # noqa: BLE001 - 服务器不可达属预期，逐个尝试
            errors.append(f"{h}:{p} {type(exc).__name__}")
    raise DatafeedError("E_SERVER_UNREACHABLE",
                        "所有行情服务器均不可达：" + "; ".join(errors) + "。可试 --host 指定可用服务器。")


def fetch_live(code: str, days: int, host: Optional[str], port: int):
    TdxHq_API = _import_pytdx()
    market = market_of(code)
    api, h, p = _connect_api(TdxHq_API, host, port)
    try:
        # pytdx 一次最多 800 根，260 根直接用 count 取；start=0 表示从最新往前
        raw = api.get_security_bars(CATEGORY_DAY, market, code, 0, min(days, 800))
    finally:
        try:
            api.disconnect()
        except Exception:  # noqa: BLE001
            pass
    if not raw:
        raise DatafeedError(
            "E_NO_DATA",
            f"pytdx 未返回 {code} 的日线数据。注意：服务器 {h}:{p} 已连接成功，"
            "若怀疑是网络/服务器限流而非代码错误，请跑 --probe-connection 自检："
            "若 securityCount>0 但 bars=0，说明本机到行情数据通道受限（代理/免费服务器限流），"
            "换 --host 其它服务器或换网络（如家里宽带）重试。",
        )
    return list(raw), {"server": f"{h}:{p}", "fetchedAt": _dt.datetime.now().isoformat(timespec="seconds"),
                       "days": days}


def fetch_dividend_hint(code: str, host: Optional[str], port: int) -> List[Dict[str, str]]:
    """导出除权线索（仅除权日 + 方案文本），供人工补登记日/派息日。不是可分发的分红表。"""
    TdxHq_API = _import_pytdx()
    market = market_of(code)
    api, h, p = _connect_api(TdxHq_API, host, port)
    try:
        raw = api.get_xdxr_info(market, code)
    finally:
        try:
            api.disconnect()
        except Exception:  # noqa: BLE001
            pass
    hints = []
    for it in raw or []:
        # category 1=除权除息；其它（送配股上市等）也列出，交由人工判断
        d = str(it.get("year_date") or it.get("date") or "")[:10].replace("/", "-")
        fenhong = it.get("fenhong")
        song = it.get("songzhuangu")
        peigu = it.get("peigu")
        if not DATE_RE.match(d):
            continue
        hints.append({
            "ex_date": d,
            "cash_per_share_hint": _fmt(fenhong / 10.0) if fenhong is not None else "",
            "share_ratio_hint": _fmt(song / 10.0) if song is not None else "",
            "peigu_hint": _fmt(peigu) if peigu is not None else "",
            "note": "仅线索：登记日/派息日缺失，必须人工从公告核对；含配股则本版内核不支持",
        })
    return hints


def probe_connection(host: Optional[str], port: int) -> Dict[str, Any]:
    """连通性诊断：区分「服务器不可达」与「控制通道正常但数据通道为空」。"""
    TdxHq_API = _import_pytdx()
    api, h, p = _connect_api(TdxHq_API, host, port)
    result: Dict[str, Any] = {"server": f"{h}:{p}"}
    try:
        try:
            result["securityCountSH"] = api.get_security_count(1)
        except Exception as exc:  # noqa: BLE001
            result["securityCountError"] = type(exc).__name__
        try:
            bars = api.get_security_bars(CATEGORY_DAY, 1, "600000", 0, 5)
            result["bars600000"] = len(bars) if bars else 0
        except Exception as exc:  # noqa: BLE001
            result["barsError"] = type(exc).__name__
    finally:
        try:
            api.disconnect()
        except Exception:  # noqa: BLE001
            pass
    cnt = result.get("securityCountSH") or 0
    bars = result.get("bars600000") or 0
    if cnt > 0 and bars == 0:
        result["verdict"] = "CONTROL_OK_DATA_EMPTY"
        result["advice"] = "控制通道正常、数据通道为空：通常是本机代理或免费服务器限流，不是脚本错误。换 --host 或换网络重试。"
    elif bars > 0:
        result["verdict"] = "DATA_OK"
        result["advice"] = "数据通道正常，可 --live 取数。"
    else:
        result["verdict"] = "UNKNOWN"
        result["advice"] = "未取得有效响应，请检查网络。"
    return result


def probe_auction(code: str, date: str, host: Optional[str], port: int) -> Dict[str, Any]:
    """探测 pytdx 能否拿到 9:25 集合竞价成交（逐笔），用于评估超短线策略数据可得性。"""
    TdxHq_API = _import_pytdx()
    market = market_of(code)
    api, h, p = _connect_api(TdxHq_API, host, port)
    try:
        raw = api.get_history_transaction_data(market, code, date, 0, 2000)
    finally:
        try:
            api.disconnect()
        except Exception:  # noqa: BLE001
            pass
    rows = list(raw or [])
    auction = [r for r in rows if str(r.get("time", "")).startswith("09:25")]
    minute = []
    try:
        api2 = TdxHq_API(heartbeat=False, auto_retry=True)
        if api2.connect(h, p, time_out=8):
            try:
                minute = list(api2.get_history_minute_time_data(market, code, date) or [])
            finally:
                api2.disconnect()
    except Exception:  # noqa: BLE001 - 分时探测失败不影响集合竞价结论
        pass
    return {
        "symbol": code, "date": date, "server": f"{h}:{p}",
        "transactionCount": len(rows),
        "auctionTicks": [
            {"time": str(r.get("time")), "price": r.get("price"), "vol": r.get("vol")}
            for r in auction[:5]
        ],
        "auctionAvailable": bool(auction),
        "minuteBars": len(minute),
        "minuteAvailable": bool(minute),
        "note": "集合竞价=09:25 逐笔成交；分时=当日分钟线。两者可得不代表策略已实现，仅证明数据源可达。",
    }


# --------------------------------------------------------------------------
# 离线自检：不依赖 pytdx / 网络
# --------------------------------------------------------------------------
def _sample_raw(n: int = 40) -> List[Dict[str, Any]]:
    """构造确定性样例（合成，仅用于自检；不入库为真实行情）。"""
    start = _dt.date(2024, 1, 2)
    raw = []
    px = 10.0
    d = start
    while len(raw) < n:
        if d.weekday() < 5:
            px = round(px + 0.01, 2)
            raw.append({"datetime": d.isoformat(), "open": px - 0.03, "high": px + 0.05,
                        "low": px - 0.06, "close": px, "vol": 1000 + len(raw), "amount": px * 1000})
        d += _dt.timedelta(days=1)
    return raw


def selftest() -> int:
    checks = []

    def ck(name: str, cond: bool, detail: str = "") -> None:
        checks.append((name, bool(cond), detail))

    raw = _sample_raw()
    csv_text, meta = build_package(raw, "600000", "测试银行", "SELFTEST-SYNTHETIC")
    ck("正常样例生成 CSV", csv_text.startswith("date,open,high,low,close,volume,amount\n"))
    ck("行数=表头1+数据N", len(csv_text.rstrip("\n").split("\n")) == 1 + len(raw))
    ck("单个末尾换行", csv_text.endswith("\n") and not csv_text.endswith("\n\n"))
    ck("adjust=none", meta["adjust"] == "none")
    ck("不含分红表", meta["dividend"] == "NOT_INCLUDED")
    ck("SHA 是 64 位十六进制", bool(re.fullmatch(r"[0-9a-f]{64}", meta["csvSha256"])))

    # 门禁：板块
    try:
        build_package(raw, "300750", "", "SELFTEST")
        ck("创业板被拒", False)
    except DatafeedError as e:
        ck("创业板被拒", e.code == "E_UNSUPPORTED_BOARD", e.code)
    try:
        build_package(raw, "688001", "", "SELFTEST")
        ck("科创板被拒", False)
    except DatafeedError as e:
        ck("科创板被拒", e.code == "E_UNSUPPORTED_BOARD", e.code)

    # 门禁：起点
    early = [dict(b, datetime="2014-12-01") for b in raw[:1]] + raw[1:]
    try:
        build_package(early, "600000", "", "SELFTEST")
        ck("早于2015-08-01被拒", False)
    except DatafeedError as e:
        ck("早于2015-08-01被拒", e.code == "E_DATE_BEFORE_COST_RULES", e.code)

    # 门禁：条数
    try:
        build_package(raw[:10], "600000", "", "SELFTEST")
        ck("不足34根被拒", False)
    except DatafeedError as e:
        ck("不足34根被拒", e.code == "E_TOO_FEW_BARS", e.code)

    # 门禁：OHLC 矛盾
    bad = [dict(b) for b in raw]
    bad[0]["high"] = bad[0]["close"] - 5
    try:
        build_package(bad, "600000", "", "SELFTEST")
        ck("OHLC矛盾被拒", False)
    except DatafeedError as e:
        ck("OHLC矛盾被拒", e.code == "E_OHLC_INCONSISTENT", e.code)

    # 门禁：重复日期
    dup = [dict(b) for b in raw]
    dup[1]["datetime"] = dup[0]["datetime"]
    try:
        build_package(dup, "600000", "", "SELFTEST")
        ck("重复日期被拒", False)
    except DatafeedError as e:
        ck("重复日期被拒", e.code == "E_DUP_DATE", e.code)

    # 降序输入应被排成升序
    asc_csv, _ = build_package(raw, "600000", "", "SELFTEST")
    desc_csv, _ = build_package(list(reversed(raw)), "600000", "", "SELFTEST")
    ck("降序输入等价升序", asc_csv == desc_csv)

    passed = sum(1 for _, ok, _ in checks if ok)
    for name, ok, detail in checks:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  <- {detail}" if detail and not ok else ""))
    print(f"\n自检：{passed}/{len(checks)} 通过")
    return 0 if passed == len(checks) else 1


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="pytdx -> 合规 stock_ohlc CSV（V0.2 数据接口层）")
    ap.add_argument("--selftest", action="store_true", help="离线自检，不需 pytdx/网络")
    ap.add_argument("--live", action="store_true", help="从 pytdx 真实取数")
    ap.add_argument("--probe-auction", action="store_true", help="探测集合竞价/分时数据可得性")
    ap.add_argument("--probe-connection", action="store_true", help="诊断行情服务器连通性与数据通道")
    ap.add_argument("--dividend-hint", action="store_true", help="导出除权线索（非可分发的分红表）")
    ap.add_argument("--code", default="", help="6 位证券代码（仅主板）")
    ap.add_argument("--name", default="", help="股票名称，可选")
    ap.add_argument("--days", type=int, default=260, help="取最近 N 个交易日，默认 260")
    ap.add_argument("--date", default="", help="--probe-auction 用的交易日 YYYY-MM-DD")
    ap.add_argument("--out", default="", help="输出目录")
    ap.add_argument("--host", default="", help="pytdx 服务器地址，缺省用内置列表逐个尝试")
    ap.add_argument("--port", type=int, default=7709, help="pytdx 服务器端口，默认 7709")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    if args.probe_connection:
        try:
            result = probe_connection(args.host or None, args.port)
        except DatafeedError as e:
            print(f"{e.code}: {e.message}", file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.probe_auction:
        if not re.fullmatch(r"\d{6}", args.code) or not DATE_RE.match(args.date):
            print("E_ARGS: --probe-auction 需要 --code 6位代码 与 --date YYYY-MM-DD", file=sys.stderr)
            return 2
        try:
            result = probe_auction(args.code, args.date, args.host or None, args.port)
        except DatafeedError as e:
            print(f"{e.code}: {e.message}", file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if not args.live:
        ap.print_help()
        return 0

    if not re.fullmatch(r"\d{6}", args.code) or not args.out:
        print("E_ARGS: --live 需要 --code 6位代码 与 --out 输出目录", file=sys.stderr)
        return 2
    try:
        raw, fetch_meta = fetch_live(args.code, args.days, args.host or None, args.port)
        csv_text, meta = build_package(raw, args.code, args.name, "pytdx-TdxHq", fetch_meta)
        paths = write_package(csv_text, meta, args.out)
        print(f"已生成 {paths['csv']}（{meta['summary']['bars']} 交易日，"
              f"{meta['summary']['start']} ~ {meta['summary']['end']}）")
        print(f"元数据 {paths['meta']}（adjust=none；不含分红表）")
        if args.dividend_hint:
            hints = fetch_dividend_hint(args.code, args.host or None, args.port)
            hint_path = os.path.join(args.out, "dividend_hint.csv")
            with open(hint_path, "w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=["ex_date", "cash_per_share_hint", "share_ratio_hint",
                                                  "peigu_hint", "note"], lineterminator="\n")
                w.writeheader()
                for h in hints:
                    w.writerow(h)
            print(f"除权线索 {hint_path}（{len(hints)} 条，仅供人工核对，不可直接上传）")
    except DatafeedError as e:
        print(f"{e.code}: {e.message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
