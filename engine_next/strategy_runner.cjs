/* ============================================================================
 * 策略内核（close_buy_open_sell 专用 runner，策略引擎的受控副本）
 * ---------------------------------------------------------------------------
 * 为什么另开一份而不改 runOvernightStock：
 *   runOvernightStock 是封版内核（V0.2 隔夜策略视频依赖它），语义固定为
 *   「每个交易日收盘买 / 次日开盘卖」，没有入场条件、预热切分、跳空过滤。
 *   策略卡的 close_buy_open_sell 需要三样它不支持的能力：
 *     1) 预热段只算指标、不交易（tradeFrom 之前不建仓）；
 *     2) 可注入入场信号（entrySignal: macd_golden / always / none）；
 *     3) 9:25 跳空情绪过滤（auctionFilter: 次日开盘跳空 >= 阈值则继续持有）。
 *   按项目既有惯例（stock_macd_core.cjs 复制分红三段式而不改 stock_core.cjs），
 *   本文件逐字复制私有辅助函数，资金/费用/红利税/封板口径与封版内核完全一致。
 *
 * 不修改任何 lib 文件；本文件被 strategy_engine.cjs 调用，不接 web、不出片。
 *
 * 成交口径（必须显式披露，不伪装成无未来函数）：
 *   - entryFill = sameClose：信号日收盘（14:57 收盘集合竞价结果 = 日线 close）买入；
 *     MACD 交叉由当日 close 计算并在当日 close 成交，属于「尾盘口径」的既定价假设，
 *     结果里以 state.fillAssumption = 'sameClose' 标注，不声称消除该假设。
 *   - exitFill  = nextOpen ：次日 9:25 集合竞价结果 = 日线 open 卖出。
 * ==========================================================================*/
'use strict';
const { tradeFee, dividendTax, affordableShares, r2 } = require('./lib/stock_cost.cjs');
const { assertSupportedOptions } = require('./lib/support_guard.cjs');
const { computeMacd } = require('./lib/stock_macd_core.cjs');

const EPS = 1e-9;

/* ============ VERBATIM COPY（来自 lib/stock_core.cjs，口径零漂移） ============ */
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
function sealedSide(d) {
  if (d.suspended || d.open === null) return null;
  const flat = d.open === d.high && d.high === d.low && d.low === d.close;
  if (!flat) return null;
  if (d.limitUp !== null && Math.abs(d.close - d.limitUp) < 0.005) return 'UP';
  if (d.limitDown !== null && Math.abs(d.close - d.limitDown) < 0.005) return 'DOWN';
  return null;
}
function touchedLimit(d) {
  if (d.suspended || d.open === null) return null;
  const up = d.limitUp !== null && (Math.abs(d.high - d.limitUp) < 0.005 || Math.abs(d.close - d.limitUp) < 0.005);
  const dn = d.limitDown !== null && (Math.abs(d.low - d.limitDown) < 0.005 || Math.abs(d.close - d.limitDown) < 0.005);
  if (up && dn) return 'BOTH';
  if (up) return 'UP';
  if (dn) return 'DOWN';
  return null;
}
function emptyRow(d) {
  return {
    date: d.date, suspended: !!d.suspended,
    open: d.open, close: d.close, high: d.high, low: d.low,
    refClose: d.refClose, limitUp: d.limitUp, limitDown: d.limitDown,
    mark: null, shares: 0, cash: 0, holdingValue: 0, divReceivable: 0, asset: 0,
    grossDividend: 0, dividendPaid: 0, dividendTax: 0, fee: 0, divTaxUnsettled: 0,
    actions: [], flags: [], note: ''
  };
}
function recognizeExDate(d, st, row) {
  for (const e of st.entitlements) {
    if (e.recognized || e.exDate !== d.date) continue;
    e.recognized = true;
    st.divReceivable = r2(st.divReceivable + e.gross);
    row.grossDividend = r2(row.grossDividend + e.gross);
    row.actions.push('DIV_EX');
  }
}
function settlePayDate(d, st, row) {
  for (const e of st.entitlements) {
    if (e.paid || e.payDate !== d.date) continue;
    e.paid = true;
    st.cash = r2(st.cash + e.gross);
    st.divReceivable = r2(st.divReceivable - e.gross);
    row.dividendPaid = r2(row.dividendPaid + e.gross);
    row.actions.push('DIV_PAID');
  }
}
function applyShareDividend(d, st, row) {
  for (const e of st.entitlements) {
    if (e.sharesAdjusted || e.exDate !== d.date || !(e.shareRatio > 0)) continue;
    if (st.shares <= 0) throw new Error(`E_SHARE_DIV_NO_POSITION: ${d.date} 送转日无持仓，无法调整股数`);
    const exact = st.shares * (1 + e.shareRatio);
    const after = Math.floor(exact + EPS);
    const oddLot = Math.round((exact - after) * 10000) / 10000;
    st.events.push({
      date: d.date, type: 'SHARE_DIV', before: st.shares, ratio: e.shareRatio,
      after, oddLotDropped: oddLot, plan: e.plan || ''
    });
    st.oddLotDropped += oddLot;
    st.shares = after;
    e.sharesAdjusted = true;
    row.actions.push('SHARE_DIV');
    row.flags.push('SHARE_ADJ');
  }
}
function recordEntitlement(d, st, row) {
  for (const act of d.divRecord || []) {
    if (st.shares <= 0) { row.flags.push('DIV_NO_POSITION'); continue; }
    const gross = r2(st.shares * act.cashPerShare);
    const e = {
      exDate: act.date, recordDate: act.recordDate, payDate: act.payDate,
      plan: act.plan || '', shares: st.shares, perShare: act.cashPerShare,
      gross, shareRatio: act.shareRatio || 0,
      recognized: false, paid: false, sharesAdjusted: false
    };
    st.entitlements.push(e);
    st.divTaxBase = r2(st.divTaxBase + gross);
    row.actions.push('DIV_RECORD');
    st.events.push({
      date: act.recordDate, type: 'DIV_ENTITLED', shares: e.shares, perShare: e.perShare,
      gross, exDate: e.exDate, payDate: e.payDate, plan: e.plan
    });
  }
}
/* ==================== END VERBATIM COPY ==================== */

/**
 * 运行「尾盘收盘买入 / 次日开盘卖出（可选 9:25 跳空过滤）」策略。
 * @param {Array} days buildTimeline 产出的时间轴（含停牌日、含预热段）
 * @param {object} opts
 *   lot, initialCapital, schedule, parValue, tradingDaysPerYear, blockSealed
 *   tradeFrom     展示起点（含）；早于此日只算指标不建仓；缺省 = 首个可交易日
 *   entrySignal   'macd_golden' | 'always' | 'none'
 *   macd          { fast, slow, signal }
 *   auctionFilter null | { basis:'open_gap_pct', holdIfGte:number }（0.02 = +2%）
 * @returns {{daily, trades, signals, decisions, events, entitlements, summary, macd}}
 */
function runStrategyRunner(days, opts) {
  assertSupportedOptions(opts, 'runStrategyRunner');
  const {
    lot, initialCapital, schedule, parValue, tradingDaysPerYear
  } = opts;
  const blockSealed = opts.blockSealed !== false;
  const entrySignal = opts.entrySignal || 'always';
  if (!['macd_golden', 'always', 'none'].includes(entrySignal))
    throw new Error('E_ENTRY_SIGNAL: entrySignal 只能是 macd_golden / always / none');
  const af = opts.auctionFilter || null;
  if (af && (af.basis !== 'open_gap_pct' || !(typeof af.holdIfGte === 'number')))
    throw new Error('E_AUCTION_FILTER: auctionFilter 需 {basis:"open_gap_pct", holdIfGte:number}');

  const tradable = days.filter(d => !d.suspended);
  if (tradable.length < 2) throw new Error('E_NO_DATA: 可交易日不足 2 天');
  const tradeFrom = opts.tradeFrom || tradable[0].date;
  const displayTradable = tradable.filter(d => d.date >= tradeFrom);
  if (!displayTradable.length) throw new Error('E_NO_DISPLAY_BARS: tradeFrom 之后无交易日');
  const lastTradableDate = displayTradable[displayTradable.length - 1].date;

  /* MACD 用「预热段 + 展示段」全量计算，保证展示起点指标已热好；
   * 预热段的交叉信号因 tradeFrom 门禁不会触发建仓（见 close phase）。 */
  const macdP = Object.assign({ fast: 12, slow: 26, signal: 9 }, opts.macd || {});
  const m = computeMacd(tradable.map(d => d.close), macdP);
  if (entrySignal === 'macd_golden' && tradable.length <= m.readyFrom)
    throw new Error('E_NO_DATA: 可交易日不足 MACD 预热所需（需 > ' + m.readyFrom + ' 天）');

  const tIdx = new Map(tradable.map((d, i) => [d.date, i]));

  const st = {
    cash: initialCapital, shares: 0, lotOpenDate: null, lastClose: null,
    divReceivable: 0, divTaxBase: 0, oddLotDropped: 0, events: [], entitlements: []
  };
  const daily = [], trades = [], signals = [], decisions = [];
  let seq = 0, fees = { commission: 0, stampDuty: 0, transferFee: 0 };
  let divTaxTotal = 0, divGrossTotal = 0, divPaidTotal = 0;
  let peak = initialCapital, peakDate = displayTradable[0].date, maxDD = 0;
  let pendingSell = false, pendingSellSince = null;
  let blockedSellCount = 0, blockedBuyCount = 0, touchCount = 0;
  let insufficientCashCount = 0, lastBuyDate = null, lastSellDate = null;
  let deferredSellDays = 0;
  let auctionHoldDays = 0, gapsEvaluated = 0, maxGap = null, minGap = null;

  for (const d of days) {
    const row = emptyRow(d);

    recognizeExDate(d, st, row);
    settlePayDate(d, st, row);
    applyShareDividend(d, st, row);

    if (d.suspended) {
      row.mark = st.lastClose;
      if (st.shares > 0) {
        row.note = '停牌：本应开盘卖出，顺延至下一有行情交易日';
        pendingSell = true;
        if (!pendingSellSince) pendingSellSince = d.date;
        row.flags.push('SELL_DEFERRED');
        deferredSellDays++;
      }
      recordEntitlement(d, st, row);
      divGrossTotal += row.grossDividend;
      divPaidTotal += row.dividendPaid;
      row.shares = st.shares; row.cash = r2(st.cash);
      row.divReceivable = r2(st.divReceivable);
      row.holdingValue = r2(st.shares * (st.lastClose || 0));
      row.asset = r2(st.cash + st.shares * (st.lastClose || 0) + st.divReceivable);
      if (st.shares > 0 && st.lotOpenDate)
        row.divTaxUnsettled = dividendTax(st.divTaxBase, daysBetween(st.lotOpenDate, d.date), schedule).tax;
      daily.push(row);
      if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
      maxDD = Math.max(maxDD, 1 - row.asset / peak);
      continue;
    }

    const tk = touchedLimit(d);
    if (tk) { row.flags.push('T_LIMIT_TOUCH_' + tk); touchCount++; }
    const j = tIdx.get(d.date);

    /* ---------- 开盘阶段：卖出（nextOpen）+ 9:25 跳空过滤 ---------- */
    if (st.shares > 0) {
      let gapPct = null;
      if (st.lastClose) gapPct = +(d.open / st.lastClose - 1).toFixed(6);
      let wantSell = true;
      let holdReason = null;
      if (af && gapPct !== null && d.date !== lastTradableDate) {
        gapsEvaluated++;
        maxGap = maxGap === null ? gapPct : Math.max(maxGap, gapPct);
        minGap = minGap === null ? gapPct : Math.min(minGap, gapPct);
        if (gapPct >= af.holdIfGte) {
          wantSell = false;
          auctionHoldDays++;
          holdReason = `9:25 跳空 ${(gapPct * 100).toFixed(2)}% >= 阈值 ${(af.holdIfGte * 100).toFixed(2)}%，情绪偏强，开盘继续持有`;
          row.flags.push('AUCTION_HOLD');
          row.note = holdReason;
          decisions.push({
            date: d.date, kind: 'HOLD', reason: 'auction_gap_strong',
            openGapPct: gapPct, threshold: af.holdIfGte,
            action: 'KEEP', detail: holdReason
          });
        }
      }
      if (wantSell) {
        const sealed = sealedSide(d);
        if (blockSealed && sealed === 'DOWN') {
          blockedSellCount++;
          pendingSell = true;
          if (!pendingSellSince) pendingSellSince = d.date;
          row.flags.push('SELL_BLOCKED');
          row.note = '一字跌停（开=高=低=收=跌停价），开盘无法卖出，持仓保留、资金未到账';
          decisions.push({
            date: d.date, kind: 'EXIT', reason: 'next_open_sell_blocked',
            openGapPct: gapPct, action: 'SELL_AT_OPEN', detail: row.note
          });
        } else {
          const why = gapPct === null ? 'next_open_sell'
            : (af ? `9:25 跳空 ${(gapPct * 100).toFixed(2)}% 未达阈值，开盘卖出` : 'next_open_sell');
          sellAtOpen(d, why, gapPct);
        }
      }
    }
    /* 被封板顺延的卖出：本日开盘重试 */
    if (pendingSell && st.shares > 0 && !(row.flags.includes('SELL_BLOCKED'))) {
      const sealed = sealedSide(d);
      if (!(blockSealed && sealed === 'DOWN')) {
        let gapPct = st.lastClose ? +(d.open / st.lastClose - 1).toFixed(6) : null;
        sellAtOpen(d, '顺延卖出（原定 ' + pendingSellSince + ' 开盘）', gapPct);
        pendingSell = false; pendingSellSince = null;
      }
    }

    /* ---------- 收盘阶段：入场（sameClose）---------- */
    const inDisplay = d.date >= tradeFrom;
    if (st.shares > 0) {
      row.flags.push('NO_REBUY_WHILE_HOLDING');
      if (!row.note) row.note = '持仓未卖出，当日不再建仓';
    } else if (!inDisplay) {
      row.flags.push('WARMUP_NO_TRADE');
      row.note = '预热段：只参与指标计算，不建仓';
    } else if (d.date === lastTradableDate) {
      row.note = '展示区间最后交易日：开盘卖出后不再建仓';
      row.flags.push('LAST_DAY_NO_BUY');
    } else if (entrySignal !== 'none') {
      let fire = entrySignal === 'always';
      let sigType = 'ALWAYS';
      let sigIdx = null;
      let dif = null, dea = null, hist = null;
      if (entrySignal === 'macd_golden' && j !== undefined && m.crosses[j] === 'golden') {
        fire = true; sigType = 'GOLDEN'; sigIdx = j;
        dif = m.dif[j] === null ? null : +m.dif[j].toFixed(6);
        dea = m.dea[j] === null ? null : +m.dea[j].toFixed(6);
        hist = m.hist[j] === null ? null : +m.hist[j].toFixed(6);
      }
      if (fire) {
        const sealed = sealedSide(d);
        if (blockSealed && sealed === 'UP') {
          blockedBuyCount++;
          row.flags.push('BUY_BLOCKED');
          row.note = '一字涨停（开=高=低=收=涨停价），尾盘无法买入，现金保留';
          signals.push({
            signalDate: d.date, type: sigType, dif, dea, hist,
            execDate: d.date, execPrice: +d.close.toFixed(4),
            executed: false, blocked: true, note: '封板无法成交'
          });
        } else {
          const n = affordableShares(st.cash, d.close, lot, d.date, parValue, schedule);
          if (n > 0) {
            const amount = n * d.close;
            const f = tradeFee({ date: d.date, side: 'buy', amount, shares: n, price: d.close, parValue, schedule });
            const cashBefore = st.cash;
            st.cash = r2(st.cash - amount - f.total);
            fees.commission += f.commission; fees.stampDuty += f.stampDuty; fees.transferFee += f.transferFee;
            st.shares = n; st.lotOpenDate = d.date;
            seq++;
            trades.push({
              seq, side: 'BUY', date: d.date, price: +d.close.toFixed(4), shares: n,
              amount: r2(amount), commission: f.commission, stampDuty: f.stampDuty, transferFee: f.transferFee,
              fee: f.total, dividendTax: 0, divTaxRate: 0, holdingDays: 0, divTaxBase: 0,
              signalType: sigType, signalDate: d.date,
              cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: n,
              rates: f.rates, note: sigType === 'GOLDEN' ? 'MACD 金叉日尾盘收盘买入（sameClose）' : '尾盘收盘买入（sameClose）'
            });
            row.actions.push('BUY'); row.fee += f.total; lastBuyDate = d.date;
            signals.push({
              signalDate: d.date, type: sigType, dif, dea, hist,
              execDate: d.date, execPrice: +d.close.toFixed(4),
              executed: true, blocked: false, note: 'sameClose 尾盘口径'
            });
            decisions.push({
              date: d.date, kind: 'ENTRY', reason: sigType === 'GOLDEN' ? 'macd_golden_sameClose' : 'close_buy',
              openGapPct: null, action: 'BUY_AT_CLOSE', detail: '日线 close = 14:57 收盘集合竞价结果'
            });
          } else {
            insufficientCashCount++;
            row.note = `现金不足以买入 1 手（${lot} 股）`;
            row.flags.push('INSUFFICIENT_CASH');
          }
        }
      }
    }

    /* 股权登记日收盘确认权益（在当日买入之后） */
    recordEntitlement(d, st, row);
    divGrossTotal += row.grossDividend;
    divPaidTotal += row.dividendPaid;

    /* 日终估值 */
    row.mark = d.close;
    row.shares = st.shares; row.cash = r2(st.cash);
    row.divReceivable = r2(st.divReceivable);
    row.holdingValue = r2(st.shares * d.close);
    row.asset = r2(st.cash + st.shares * d.close + st.divReceivable);
    if (Math.abs(st.cash + st.shares * d.close + st.divReceivable - row.asset) > 0.011)
      throw new Error(`E_ASSET_BREAK ${d.date}`);
    if (st.shares > 0 && st.lotOpenDate)
      row.divTaxUnsettled = dividendTax(st.divTaxBase, daysBetween(st.lotOpenDate, d.date), schedule).tax;
    st.lastClose = d.close;
    if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
    maxDD = Math.max(maxDD, 1 - row.asset / peak);
    daily.push(row);

    /* ---- 本地卖出辅助（开盘价成交）---- */
    function sellAtOpen(day, why, gapPct) {
      const amount = st.shares * day.open;
      const f = tradeFee({ date: day.date, side: 'sell', amount, shares: st.shares, price: day.open, parValue, schedule });
      const holdingDays = st.lotOpenDate ? daysBetween(st.lotOpenDate, day.date) : 0;
      const dt = dividendTax(st.divTaxBase, holdingDays, schedule);
      const cashBefore = st.cash;
      st.cash = r2(st.cash + amount - f.total - dt.tax);
      fees.commission += f.commission; fees.stampDuty += f.stampDuty; fees.transferFee += f.transferFee;
      divTaxTotal += dt.tax;
      const sharesSold = st.shares;
      st.shares = 0;
      const note = dt.tax > 0
        ? `持股 ${holdingDays} 天，红利税 ${(dt.rate * 100).toFixed(0)}% 于卖出时补扣 ${dt.tax} 元`
        : why;
      seq++;
      trades.push({
        seq, side: 'SELL', date: day.date, price: +day.open.toFixed(4), shares: sharesSold,
        amount: r2(amount), commission: f.commission, stampDuty: f.stampDuty, transferFee: f.transferFee,
        fee: f.total, dividendTax: dt.tax, divTaxRate: dt.rate, holdingDays,
        divTaxBase: r2(st.divTaxBase),
        signalType: 'EXIT', signalDate: st.lotOpenDate,
        cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: 0,
        rates: f.rates, note
      });
      row.actions.push('SELL'); row.fee += f.total; row.dividendTax += dt.tax;
      lastSellDate = day.date;
      st.divTaxBase = 0; st.lotOpenDate = null;
      pendingSell = false; pendingSellSince = null;
      decisions.push({
        date: day.date, kind: 'EXIT', reason: why.startsWith('9:25') ? 'auction_gap_weak' : 'next_open_sell',
        openGapPct: gapPct, action: 'SELL_AT_OPEN', detail: note
      });
    }
  }

  const last = daily[daily.length - 1];
  const final = last.asset;
  const totalFees = r2(fees.commission + fees.stampDuty + fees.transferFee);
  return {
    daily, trades, signals, decisions, events: st.events, entitlements: st.entitlements,
    macd: m,
    summary: {
      final, totalReturn: final / initialCapital - 1,
      cagr: Math.pow(final / initialCapital, opts.tradingDaysPerYear / displayTradable.length) - 1,
      maxDD, peak, peakDate,
      tradingDays: days.length, tradableDays: tradable.length,
      displayTradableDays: displayTradable.length,
      warmupTradableDays: tradable.length - displayTradable.length,
      suspendedDays: days.length - tradable.length,
      buyCount: trades.filter(t => t.side === 'BUY').length,
      sellCount: trades.filter(t => t.side === 'SELL').length,
      tradeCount: trades.length,
      totalFees, feeBreakdown: { commission: r2(fees.commission), stampDuty: r2(fees.stampDuty), transferFee: r2(fees.transferFee) },
      totalGrossDividends: r2(divGrossTotal), totalDividendPaid: r2(divPaidTotal), totalDividendTax: r2(divTaxTotal),
      oddLotDropped: st.oddLotDropped,
      finalShares: st.shares, finalCash: r2(st.cash),
      finalReceivable: r2(st.divReceivable),
      finalUnsettledDivEvents: st.entitlements.filter(e => !e.paid).length,
      finalUnsettledTax: r2(st.divTaxBase),
      unclosed: st.shares > 0,
      blockedSellCount, blockedBuyCount, limitTouchCount: touchCount, deferredSellDays,
      insufficientCashCount, lastBuyDate, lastSellDate, lastTradableDate,
      entrySignal, auctionFilter: af ? { basis: af.basis, holdIfGte: af.holdIfGte } : null,
      auctionHoldDays, gapsEvaluated, maxGap, minGap,
      composition: {
        cash: r2(st.cash), shares: st.shares, holdingValue: r2(st.shares * last.mark),
        receivable: r2(st.divReceivable), pendingTax: r2(st.divTaxBase),
        note: '期末总资产 = 现金 + 持仓市值 + 应收股息'
      }
    }
  };
}

module.exports = { runStrategyRunner, daysBetween, sealedSide, touchedLimit };
