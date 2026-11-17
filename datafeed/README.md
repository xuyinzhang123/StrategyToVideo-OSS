# 数据接口层（pytdx / 东方财富 → 合规股票 CSV）

这是 V0.2 股票通道的**可选取数工具**，不是新的出片链。它把免费行情源的未复权日线，转成网页 `stock_ohlc` 导入能直接接受的 CSV；转换后的 CSV 与用户手工导出的 CSV 走**完全相同**的校验、回测、渲染与验收链路。

当前有两个接口，输出契约完全相同，`stock_ohlc.csv + meta.json` 可直接互换：

| 接口 | 脚本 | 依赖 | 本机实测（2026-11-17） |
|---|---|---|---|
| 通达信 pytdx | `pytdx_fetch.py` | 可选 pytdx | 控制通道 OK、数据通道空（`CONTROL_OK_DATA_EMPTY`） |
| 东方财富 HTTP | `eastmoney_fetch.py` | 纯标准库 | **可用**：HTTP 200，真实日线 533 根，OHLC 自洽 |

两者共用 `pytdx_fetch.py` 里的规范化与门禁纯函数，**不存在第二份口径**。

设计边界（不可越过）：

- 只取**未复权**（`adjust=none`）。这是 V0.2 唯一接受的口径（DATA_SPEC §7.2 G-6）；qfq/hfq 是合成价，会让成交金额与费用脱离真实账户，接口层不生成、也不接受。
- 只放行**沪深主板**（600/601/603/605 + 000/001/002/003）。创业板/科创板/北交所按 10% 判涨跌停会算错，本地先拒。
- 起点必须 **≥ 2015-08-01**（早于此无过户费费率规则）。
- 至少 **34 个交易日**（MACD 12/26/9 的 `readyFrom=33`）。
- **不自动生成分红表**。这是刻意的：pytdx 的除权数据只有除权日，没有股权登记日与派息日；而 DATA_SPEC §4.3 明确这两个日期不可推导、且必须是交易日历内的交易日。猜日期会做出金额错误的视频。需要计分红时，用 `--dividend-hint` 导出**除权线索**，人工去交易所公告核对登记日/派息日后，再按 §4.3 补一张三段式 `dividend.csv`。不补也可以出片，副标题会诚实标注「未提供分红表」。

## 依赖

只影响本目录，不进主 `requirements.txt`：

```bash
python -m pip install --target deps-datafeed pytdx
# 运行真实取数时：PYTHONPATH=deps-datafeed（Windows 用分号，Linux/Mac 用冒号）
```

`--selftest` 与端到端测试**不需要** pytdx、不需要网络。

## 用法

```bash
# 1) 拿到机器先跑：离线自检（13 项门禁逻辑，不需要 pytdx/网络）
python datafeed/pytdx_fetch.py --selftest

# 2) 诊断本机到行情服务器的数据通道（拿不到数时先跑这个）
PYTHONPATH=deps-datafeed python datafeed/pytdx_fetch.py --probe-connection
#   verdict=DATA_OK               -> 可以取数
#   verdict=CONTROL_OK_DATA_EMPTY -> 控制通道正常但数据为空（代理/免费服务器限流），换 --host 或换网络

# 3) 真实取数：生成合规 CSV 包到 <out>/
PYTHONPATH=deps-datafeed python datafeed/pytdx_fetch.py --live \
    --code 600000 --name 浦发银行 --days 260 --out datafeed/out/600000
#   产出：<out>/stock_ohlc.csv + <out>/meta.json

# 4) 需要分红时，导出除权线索供人工核对（不是可直接上传的 dividend.csv）
PYTHONPATH=deps-datafeed python datafeed/pytdx_fetch.py --live \
    --code 600000 --days 260 --out datafeed/out/600000 --dividend-hint

# 5) 超短线策略的数据可得性探测（9:25 集合竞价逐笔 + 当日分时）
PYTHONPATH=deps-datafeed python datafeed/pytdx_fetch.py --probe-auction \
    --code 600000 --date 2024-12-30

# 6) 端到端验证：接口层产物通过现有校验门禁（node + python，不需要 pytdx/网络）
node datafeed/tests/verify_datafeed_e2e.cjs
```

生成 CSV 后，在网页选择「导入 CSV · 股票日线」，上传 `<out>/stock_ohlc.csv`，按 `meta.json` 填 symbol / name / `adjust=none`；若人工补齐了分红表，再一并上传。

## 本机（工厂电脑）实测状态 · 2026-11-17

- pytdx 1.72 安装成功；`--selftest` 13/13、端到端验证 5/5 通过。
- 行情服务器可连接（多台），`securityCount(SH)=27881`，即**控制通道正常**；
  但 `get_security_bars` / `get_security_quotes` / 指数 / 集合竞价 / 分时**全部返回空**
  → `verdict=CONTROL_OK_DATA_EMPTY`。判定为**本机经 HTTP 代理访问免费行情服务器的数据通道受限**，不是脚本错误。
- 因此本轮**未取得真实行情数据**，也未据此出片；所有验证用的是确定性合成样例。
- 家里电脑若网络直连，先跑第 2 步诊断；若 `DATA_OK`，再跑第 3 步取真实数据。若仍为
  `CONTROL_OK_DATA_EMPTY`，可用 `--host` 指定其它可用服务器，或换网络；不要在接口层造数据绕过。

## 东方财富接口（推荐）

纯标准库，**不需要安装 pytdx**；`fqt=0` 强制未复权，URL 里没有复权参数可调。

```bash
# 1) 离线自检（20 项，不需网络）
python datafeed/eastmoney_fetch.py --selftest

# 2) 诊断日线通道
python datafeed/eastmoney_fetch.py --probe-connection --code 600000
#   verdict=DATA_OK -> 可以取数

# 3) 真实取数：默认取最近 260 个【已收盘】交易日
python datafeed/eastmoney_fetch.py --live \
    --code 600000 --name 浦发银行 --days 260 --out datafeed/out/em_600000

# 3b) 指定区间取数（策略卡直出片/网页任务用；给区间后不再按 --days 截取）
python datafeed/eastmoney_fetch.py --live \
    --code 600000 --name 浦发银行 --start 2023-07-01 --end 2024-12-30 \
    --out datafeed/out/range_600000

# 4) 端到端验证（合成 5 项 + 若真实产物存在再 3 项）
node datafeed/tests/verify_eastmoney_e2e.cjs
```

**盘中保护**：东方财富日线接口在交易时段会返回当天的动态 K 线，其 `close` 尚未定，
脚本默认剔除该日并在 `meta.json.excludedUnclosedDate` 记录；只有收盘后确认要用当天，
才显式加 `--include-today`。这是为避免“同一天盘中/收盘出片结果不同”破坏确定性。

**接口行为注意**：东方财富公开 kline 接口的 `lmt` 参数不可靠（实测给 `lmt=5` 仍返回
533 根），所以脚本拉全 `beg~end` 后在本地按 `--days` 截取；`beg` 从 2015-08-01 起，
保证不越过费率规则起点。

### 本机（工厂电脑）实测状态 · 2026-11-17

- 公开接口 `push2his.eastmoney.com` HTTP 200，600000 未复权日线 533 根，
  OHLC 自洽 0 异常；字段顺序 f52=开 / f53=收 / f54=高 / f55=低，已按此映射。
- 真实取数：260 交易日（2025-10-22 ~ 2026-11-16），自动剔除未收盘日 2026-11-17。
- `eastmoney_fetch.py --selftest` 20/20；`verify_eastmoney_e2e.cjs` 8/8；
  真实 CSV 通过 `validateImport`（`W_NO_DIVIDENDS`），`adjust=qfq` 仍被 G-6 拒绝。
- 既有四链回归未变：pytdx 自检 13/13、pytdx E2E 5/5、`check:samples` 30/30、
  `test_timeline_bounds.py` 3 组冻结 SHA 不变；`git diff 5884e0f` 对既有链路为空。

## 与 super-short 策略（下一步）的关系

`--probe-auction` 只回答「pytdx 能不能拿到 9:25 集合竞价成交与当日分时」，**不代表策略已实现**。
尾盘竞价买入 / 次日早盘卖出的策略、指标层、自动选版式、web 接入，均不在本接口层范围内。
