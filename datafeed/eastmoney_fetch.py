#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""V0.2 股票通道的第二个「数据接口层」：从东方财富公开行情 HTTP 接口拉未复权日线。

定位（与 pytdx_fetch.py 完全平行，不替换旧接口）：
  * 本脚本只做「取数 + 规范化 + 前置校验」，输出两个文件：
      - <out>/stock_ohlc.csv    列 date,open,high,low,close,volume,amount（amount 可空）
      - <out>/meta.json         symbol/name/adjust=none/来源/抓取参数（不进 CSV 列）
  * 所有规范化与门禁逻辑直接复用 pytdx_fetch.py 的纯函数，不重写第二份口径；
    生成的 CSV 与用户手工导出的 CSV 走**完全相同**的校验、回测、渲染与验收链路。
  * 纯标准库（urllib.request），不引入新运行依赖；--selftest / E2E 不需要网络。

关键口径（与 pytdx_fetch.py 一致）：
  * 只取未复权：东方财富 fqt=0（fqt=1 前复权 / 2 后复权一律不生成，G-6）。
  * 板块只放行沪深主板 600/601/603/605 + 000/001/002/003。
  * 起点 >= 2015-08-01（早于此无费率规则）。
  * OHLC 自洽：high >= max(open,close,low)，low <= min(open,close,high)，价 > 0。
  * 至少 34 个交易日（MACD 12/26/9 的 readyFrom = 33，需 34 根）。
  * **默认剔除「今天」的盘中未收盘 K 线**：东方财富日线接口在交易时段会返回当日动态
    bar，其 close 不是最终收盘价，直接入回测会破坏确定性。要包含今天请显式加
    --include-today（仅在收盘后使用）。
  * **分红不强造**：东方财富该接口只给不复权价与方案字段，不提供股权登记日与派息日；
    DATA_SPEC §4.3 明确这两个日期不可推导。本脚本不生成 dividend.csv。

东方财富 kline 接口字段（fields2=f51..f61）：
  f51=日期 f52=开 f53=收 f54=高 f55=低 f56=成交量(手) f57=成交额(元)
  f58=振幅 f59=涨跌幅 f60=涨跌额 f61=换手率
注意 f53 是**收盘**、f54 是**最高**，顺序与 pytdx 不同，映射时不可按位置硬套。

用法：
  # 1) 离线自检（无需网络）
  python datafeed/eastmoney_fetch.py --selftest

  # 2) 连通性诊断（拉最近几天日线，判断数据通道）
  python datafeed/eastmoney_fetch.py --probe-connection --code 600000

  # 3) 真实取数（默认取最近 260 个已收盘交易日）
  python datafeed/eastmoney_fetch.py --live \
      --code 600000 --name 浦发银行 --days 260 --out datafeed/out/em_600000

  # 4) 收盘后确认要包含今天
  python datafeed/eastmoney_fetch.py --live --code 600000 --days 260 \
      --out datafeed/out/em_600000 --include-today
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

import pytdx_fetch as P

ENDPOINT = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
UT = "fa5fd1943c7b386f172d6893dbfba10b"
FIELDS1 = "f1,f2,f3,f4,f5,f6"
FIELDS2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
KLT_DAY = "101"
FQT_NONE = "0"  # 0=不复权；1=前复权；2=后复权（本脚本永远发 0）
END_FUTURE = "20500101"
HTTP_TIMEOUT = 25
UA = "Mozilla/5.0 (compatible; StrategyToVideo-OSS-datafeed/0.2)"


def secid_of(code: str) -> str:
    """A 股代码 -> 东方财富 secid：1=沪市，0=深市。非主板由 board_of 统一拒绝。"""
    board = P.board_of(code)
    if board == "SH_MAIN":
        return f"1.{code}"
    if board == "SZ_MAIN":
        return f"0.{code}"
    raise P.DatafeedError(
        "E_UNSUPPORTED_BOARD",
        f"代码 {code} 不在沪深主板（600/601/603/605/000/001/002/003）；本版不支持。",
    )


def build_url(code: str, beg: str, end: str = END_FUTURE) -> str:
    """构造日线 URL；fqt 恒为 0，调用方无法请求复权价。"""
    params = {
        "secid": secid_of(code),
        "ut": UT,
        "fields1": FIELDS1,
        "fields2": FIELDS2,
        "klt": KLT_DAY,
        "fqt": FQT_NONE,
        "beg": beg,
        "end": end,
    }
    return ENDPOINT + "?" + urllib.parse.urlencode(params)


def _http_json(url: str) -> Dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            if resp.status != 200:
                raise P.DatafeedError("E_HTTP_STATUS", f"东方财富接口返回 HTTP {resp.status}")
            text = resp.read().decode("utf-8")
    except P.DatafeedError:
        raise
    except Exception as exc:  # noqa: BLE001 - 网络异常统一带错误码
        raise P.DatafeedError(
            "E_NETWORK",
            f"请求东方财富接口失败：{type(exc).__name__}: {exc}。检查网络/代理后重试。",
        ) from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise P.DatafeedError("E_BAD_JSON", f"东方财富返回不是合法 JSON：{exc}") from exc


def fetch_klines(code: str, beg: str = P.COST_RULES_START.replace("-", ""),
                 end: str = END_FUTURE) -> List[str]:
    """拉取 [beg, end] 区间全部不复权日线字符串（东方财富 lmt 不可靠，本地再截取）。"""
    url = build_url(code, beg, end)
    data = _http_json(url)
    rc = data.get("rc")
    if rc not in (0, None):
        raise P.DatafeedError("E_API_RC", f"东方财富接口 rc={rc}：{data.get('rt') or data.get('msg') or ''}")
    payload = data.get("data") or {}
    klines = payload.get("klines") or []
    if not klines:
        raise P.DatafeedError(
            "E_NO_DATA",
            f"东方财富未返回 {code} 的日线数据（beg={beg}, end={end}）。检查代码与网络。",
        )
    return [str(x) for x in klines]


def parse_klines(klines: List[str], days: Optional[int] = None,
                 today: Optional[str] = None, include_today: bool = False
                 ) -> Tuple[List[Dict[str, Any]], List[str]]:
    """东方财富 kline 字符串 -> pytdx_fetch.normalize_bars 可接受的 raw；返回 (raw, 剔除日期)。"""
    local_today = today or _dt.date.today().isoformat()
    dropped: List[str] = []
    raw: List[Dict[str, Any]] = []
    for i, line in enumerate(klines):
        parts = line.split(",")
        if len(parts) < 7:
            raise P.DatafeedError("E_BAD_FORMAT", f"第 {i + 1} 根 K 线字段不足 7：{line!r}")
        date = parts[0].strip()[:10].replace("/", "-")
        if not P.DATE_RE.match(date):
            raise P.DatafeedError("E_DATE_FORMAT", f"第 {i + 1} 根 K 线日期非法：{date!r}")
        if date == local_today and not include_today:
            dropped.append(date)
            continue
        try:
            o, c, h, l = (float(parts[k]) for k in (1, 2, 3, 4))  # f52开 f53收 f54高 f55低
            vol = int(float(parts[5] or 0))                       # f56 成交量(手)
            amt = float(parts[6]) if parts[6] != "" else ""        # f57 成交额(元)
        except (TypeError, ValueError) as exc:
            raise P.DatafeedError("E_BAD_NUMBER", f"{date} 的行情数值非法：{exc}") from exc
        raw.append({
            "datetime": date,
            "open": o, "high": h, "low": l, "close": c,
            "vol": vol, "amount": amt,
        })
    if days is not None:
        if days < P.MIN_BARS:
            raise P.DatafeedError("E_TOO_FEW_BARS", f"--days={days} 小于最低 {P.MIN_BARS}")
        raw = raw[-days:]
    return raw, dropped


def fetch_live(code: str, days: int, include_today: bool = False
               ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """真实取数：返回 (raw, 注入 meta 的 extra 字段)。"""
    board = P.board_of(code)
    if board is None:
        raise P.DatafeedError("E_UNSUPPORTED_BOARD", f"代码 {code} 不在沪深主板，本版不支持。")
    klines = fetch_klines(code)
    raw, dropped = parse_klines(klines, days=days, include_today=include_today)
    if not raw:
        raise P.DatafeedError("E_NO_DATA", "剔除未收盘日后没有可用交易日，请检查 --days。")
    extra = {
        "fetchedAt": _dt.datetime.now().isoformat(timespec="seconds"),
        "days": days,
        "source": "eastmoney-push2his",
        "secid": secid_of(code),
        "endpoint": ENDPOINT,
        "fqt": FQT_NONE,
        "includeToday": bool(include_today),
        "excludedUnclosedDate": dropped[-1] if dropped else None,
    }
    return raw, extra


def build_package(raw: List[Dict[str, Any]], code: str, name: str, extra_meta: Optional[Dict[str, Any]] = None
                  ) -> Tuple[str, Dict[str, Any]]:
    """复用 pytdx_fetch 的规范化/门禁/CSV 生成，仅覆盖来源说明字段。"""
    csv_text, meta = P.build_package(
        raw, code, name, (extra_meta or {}).get("source") or "eastmoney-push2his", extra_meta
    )
    # pytdx_fetch.build_package 只透传 fetchedAt/server/days；东方财富特有字段在此补齐。
    for key in ("secid", "endpoint", "fqt", "includeToday", "excludedUnclosedDate"):
        if extra_meta and key in extra_meta:
            meta[key] = extra_meta[key]
    meta["dividendNote"] = (
        "东方财富该接口只提供不复权价，不提供股权登记日与派息日；DATA_SPEC §4.3 禁止推导；"
        "本包不含 dividend.csv。需要计现金分红时请人工核对交易所公告后补三段式分红表。"
    )
    return csv_text, meta


def probe_connection(code: str) -> Dict[str, Any]:
    """连通性诊断：拉最近一段日线，区分「HTTP 不可达」与「有数据」。"""
    today = _dt.date.today()
    beg = (today - _dt.timedelta(days=30)).strftime("%Y%m%d")
    end = (today - _dt.timedelta(days=1)).strftime("%Y%m%d")
    klines = fetch_klines(code, beg=beg, end=end)
    raw, dropped = parse_klines(klines, days=None, include_today=True)
    result: Dict[str, Any] = {
        "endpoint": ENDPOINT,
        "secid": secid_of(code),
        "httpStatus": 200,
        "bars": len(raw),
        "firstDate": raw[0]["datetime"] if raw else None,
        "lastDate": raw[-1]["datetime"] if raw else None,
        "excludedUnclosedDate": dropped[-1] if dropped else None,
    }
    if raw:
        result["verdict"] = "DATA_OK"
        result["advice"] = "东方财富日线通道正常，可 --live 取数。"
    else:
        result["verdict"] = "CONTROL_OK_DATA_EMPTY"
        result["advice"] = "接口可达但日线为空，检查代码/区间或稍后重试。"
    return result


# --------------------------------------------------------------------------
# 离线自检：纯逻辑，不依赖网络
# --------------------------------------------------------------------------
def _sample_klines(n: int = 40) -> List[str]:
    """构造确定性样例（合成，仅用于自检；不入库为真实行情）。"""
    d = _dt.date(2024, 1, 2)
    px = 10.0
    out = []
    while len(out) < n:
        if d.weekday() < 5:
            px = round(px + 0.01, 2)
            o, h, l, c = round(px - 0.03, 2), round(px + 0.05, 2), round(px - 0.06, 2), px
            out.append(f"{d.isoformat()},{o:.2f},{c:.2f},{h:.2f},{l:.2f},"
                       f"{1000 + len(out)},{(px * 1000):.2f},1.00,0.10,0.01,0.20")
        d += _dt.timedelta(days=1)
    return out


def selftest() -> int:
    checks: List[Tuple[str, bool, str]] = []

    def ck(name: str, cond: bool, detail: str = "") -> None:
        checks.append((name, bool(cond), detail))

    ks = _sample_klines()
    raw, dropped = parse_klines(ks, days=None, today="2099-01-01")
    ck("K线字段映射 f53=收/f54=高", raw[0]["close"] > 0 and raw[0]["high"] >= raw[0]["close"])
    ck("不误剔历史日", len(dropped) == 0 and len(raw) == len(ks))

    today_ks = list(ks)
    today_ks[-1] = "2099-01-01,10.00,10.10,10.20,9.90,1000,10000.00,1.00,1.00,0.10,0.20"
    r2, d2 = parse_klines(today_ks, days=None, today="2099-01-01")
    ck("默认剔除今天未收盘K线", len(d2) == 1 and len(r2) == len(ks) - 1)
    r3, d3 = parse_klines(today_ks, days=None, today="2099-01-01", include_today=True)
    ck("--include-today 保留今天", len(d3) == 0 and len(r3) == len(ks))

    r4, _ = parse_klines(ks, days=P.MIN_BARS, today="2099-01-01")
    ck("--days 本地截取最后N根", len(r4) == P.MIN_BARS and r4[0]["datetime"] == raw[-P.MIN_BARS]["datetime"]
       and r4[-1]["datetime"] == raw[-1]["datetime"])

    ck("沪市 secid=1.", secid_of("600000") == "1.600000")
    ck("深市 secid=0.", secid_of("000001") == "0.000001")
    try:
        secid_of("300750")
        ck("创业板被拒", False)
    except P.DatafeedError as e:
        ck("创业板被拒", e.code == "E_UNSUPPORTED_BOARD", e.code)
    try:
        secid_of("688001")
        ck("科创板被拒", False)
    except P.DatafeedError as e:
        ck("科创板被拒", e.code == "E_UNSUPPORTED_BOARD", e.code)

    url = build_url("600000", "20150801")
    ck("URL 强制 fqt=0（未复权）", "fqt=0" in url and "fqt=1" not in url and "fqt=2" not in url)
    ck("URL 使用日线 klt=101", "klt=101" in url)

    csv_text, meta = build_package(raw, "600000", "测试银行", {"source": "SELFTEST-SYNTHETIC"})
    ck("CSV 表头正确", csv_text.startswith("date,open,high,low,close,volume,amount\n"))
    ck("行数=表头1+数据N", len(csv_text.rstrip("\n").split("\n")) == 1 + len(raw))
    ck("单个末尾换行", csv_text.endswith("\n") and not csv_text.endswith("\n\n"))
    ck("adjust=none", meta["adjust"] == "none")
    ck("不含分红表", meta["dividend"] == "NOT_INCLUDED")
    ck("SHA 是64位十六进制", bool(re.fullmatch(r"[0-9a-f]{64}", meta["csvSha256"])))

    try:
        build_package(raw[:10], "600000", "", {"source": "SELFTEST"})
        ck("不足34根被拒", False)
    except P.DatafeedError as e:
        ck("不足34根被拒", e.code == "E_TOO_FEW_BARS", e.code)

    early = parse_klines(ks, days=None, today="2099-01-01")[0]
    early[0]["datetime"] = "2014-12-01"
    try:
        build_package(early, "600000", "", {"source": "SELFTEST"})
        ck("早于2015-08-01被拒", False)
    except P.DatafeedError as e:
        ck("早于2015-08-01被拒", e.code == "E_DATE_BEFORE_COST_RULES", e.code)

    bad = [dict(x) for x in raw]
    bad[0]["high"] = bad[0]["close"] - 5
    try:
        build_package(bad, "600000", "", {"source": "SELFTEST"})
        ck("OHLC矛盾被拒", False)
    except P.DatafeedError as e:
        ck("OHLC矛盾被拒", e.code == "E_OHLC_INCONSISTENT", e.code)

    passed = sum(1 for _, ok, _ in checks if ok)
    for name, ok, detail in checks:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  <- {detail}" if detail and not ok else ""))
    print(f"\n自检：{passed}/{len(checks)} 通过")
    return 0 if passed == len(checks) else 1


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="东方财富 -> 合规 stock_ohlc CSV（V0.2 数据接口层）")
    ap.add_argument("--selftest", action="store_true", help="离线自检，不需网络")
    ap.add_argument("--live", action="store_true", help="从东方财富真实取数")
    ap.add_argument("--probe-connection", action="store_true", help="诊断东方财富日线数据通道")
    ap.add_argument("--code", default="600000", help="6 位证券代码（仅主板），默认 600000")
    ap.add_argument("--name", default="", help="股票名称，可选")
    ap.add_argument("--days", type=int, default=260, help="取最近 N 个已收盘交易日，默认 260")
    ap.add_argument("--out", default="", help="输出目录")
    ap.add_argument("--include-today", action="store_true",
                    help="包含今天的盘中 K 线（仅收盘后使用；默认剔除以免 close 未定）")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    if not re.fullmatch(r"\d{6}", args.code or ""):
        print("E_ARGS: --code 必须是 6 位证券代码", file=sys.stderr)
        return 2

    if args.probe_connection:
        try:
            print(json.dumps(probe_connection(args.code), ensure_ascii=False, indent=2))
        except P.DatafeedError as e:
            print(f"{e.code}: {e.message}", file=sys.stderr)
            return 1
        return 0

    if not args.live:
        ap.print_help()
        return 0

    if not args.out:
        print("E_ARGS: --live 需要 --out 输出目录", file=sys.stderr)
        return 2
    try:
        raw, extra = fetch_live(args.code, args.days, args.include_today)
        csv_text, meta = build_package(raw, args.code, args.name, extra)
        paths = P.write_package(csv_text, meta, args.out)
        print(f"已生成 {paths['csv']}（{meta['summary']['bars']} 交易日，"
              f"{meta['summary']['start']} ~ {meta['summary']['end']}）")
        print(f"元数据 {paths['meta']}（adjust=none；不含分红表；fqt=0）")
        if meta.get("excludedUnclosedDate"):
            print(f"注意：已剔除未收盘日 {meta['excludedUnclosedDate']}，如需包含请在收盘后加 --include-today")
    except P.DatafeedError as e:
        print(f"{e.code}: {e.message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
