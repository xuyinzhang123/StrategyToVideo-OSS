/* ============================================================================
 * 组合策略执行器（策略表达层 V0.3 · 阶段一）
 * ---------------------------------------------------------------------------
 * 受控副本：逐字复用 strategy_runner.cjs 的资金/费用/分红/封板口径（见下 VERBATIM），
 * 只替换交易状态机：入场条件 + 多个退出条件（OR），信号收盘确认、次开盘成交。
 * 未选择 composition 的旧策略卡不会进入本文件，旧 resultSha256 不受影响。
 *
 * 与旧 runner 的差异（仅本文件）：
 *   - entry/exit 均由 strategy_conditions.buildConditions 生成；
 *   - fixedHolding 以「买入成交日为第 1 日」计完整交易日，第 N+1 日开盘退出；
 *   - returnThreshold 以实际买入成交价为基准，收盘触及，次开盘成交；
 *   - 同日多退出只成交一次，reasons 按配置顺序完整保留。
 * ==========================================================================*/
'use strict';
const { tradeFee, dividendTax, affordableShares, r2 } = require('./lib/stock_cost.cjs');
const { assertSupportedOptions } = require('./lib/support_guard.cjs');
const { buildConditions } = require('./strategy_conditions.cjs');

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
 * 运行组合策略。
 * @param {Array} days buildTimeline 产出的时间轴（含停牌、含预热）
 * @param {object} opts 与 runStrategyRunner 同基础项 + composition
 */
function runComposedRunner(days, opts) {
  assertSupportedOptions(opts, 'runComposedRunner');
  const { lot, initialCapital, schedule, parValue, tradingDaysPerYear, composition } = opts;
  if (!composition) throw new Error('E_COMPOSITION: 缺少 composition');
  const blockSealed = opts.blockSealed !== false;

  const tradable = days.filter(d => !d.suspended);
  if (tradable.length < 2) throw new Error('E_NO_DATA: 可交易日不足 2 天');
  const tradeFrom = opts.tradeFrom || tradable[0].date;
  const displayTradable = tradable.filter(d => d.date >= tradeFrom);
  if (!displayTradable.length) throw new Error('E_NO_DISPLAY_BARS: tradeFrom 之后无交易日');
  const lastTradableDate = displayTradable[displayTradable.length - 1].date;

  const cond = buildConditions(tradable, composition);
  const byDate = cond.byDate;
  const tIdx = new Map(tradable.map((d, i) => [d.date, i]));

  const st = { cash: initialCapital, shares: 0, lotOpenDate: null, buyPrice: null, buyIndex: null,
    lastClose: null, divReceivable: 0, divTaxBase: 0, oddLotDropped: 0, events: [], entitlements: [] };
  const daily = [], trades = [], signals = [], decisions = [];
  let seq = 0, fees = { commission: 0, stampDuty: 0, transferFee: 0 };
  let divTaxTotal = 0, divGrossTotal = 0, divPaidTotal = 0;
  let peak = initialCapital, peakDate = displayTradable[0].date, maxDD = 0;
  let pendingEntry = null, pendingExit = null, pendingSince = null;
  let blockedSellCount = 0, blockedBuyCount = 0, deferredSellDays = 0, noNextDayCount = 0;
  const reasonCounts = {};

  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const d = days[dayIdx];
    const row = emptyRow(d);
    recognizeExDate(d, st, row);
    settlePayDate(d, st, row);
    applyShareDividend(d, st, row);

    if (d.suspended) {
      row.mark = st.lastClose;
      if (st.shares > 0 && pendingExit) {
        row.flags.push('SELL_DEFERRED');
        row.note = '停牌：本应开盘卖出，顺延至下一有行情交易日';
        deferredSellDays++;
      }
      recordEntitlement(d, st, row);
      divGrossTotal += row.grossDividend; divPaidTotal += row.dividendPaid;
      row.shares = st.shares; row.cash = r2(st.cash); row.divReceivable = r2(st.divReceivable);
      row.holdingValue = r2(st.shares * (st.lastClose || 0));
      row.asset = r2(st.cash + st.shares * (st.lastClose || 0) + st.divReceivable);
      if (st.shares > 0 && st.lotOpenDate)
        row.divTaxUnsettled = dividendTax(st.divTaxBase, daysBetween(st.lotOpenDate, d.date), schedule).tax;
      daily.push(row);
      if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
      maxDD = Math.max(maxDD, 1 - row.asset / peak);
      continue;
    }

    const j = tIdx.get(d.date);
    const rec = byDate.get(d.date) || { entry: null, exits: [] };

    /* ---------- 开盘：执行上一交易日收盘确认的信号 ---------- */
    if (pendingExit && st.shares > 0) {
      const sealed = sealedSide(d);
      if (blockSealed && sealed === 'DOWN') {
        blockedSellCount++;
        row.flags.push('SELL_BLOCKED');
        row.note = '一字跌停（开=高=低=收=跌停价），开盘无法卖出，持仓保留';
        decisions.push({ date: d.date, kind: 'EXIT', reasons: pendingExit.reasons,
          action: 'SELL_AT_OPEN_BLOCKED', detail: row.note });
      } else {
        sellAtOpen(d, pendingExit.reasons, pendingExit.signalDate);
        pendingExit = null; pendingSince = null;
      }
    } else if (pendingEntry && st.shares === 0) {
      const sealed = sealedSide(d);
      if (blockSealed && sealed === 'UP') {
        blockedBuyCount++;
        row.flags.push('BUY_BLOCKED');
        row.note = '一字涨停，开盘无法买入，现金保留';
        signals.push({ signalDate: pendingEntry.signalDate, type: 'ENTRY', component: pendingEntry.type,
          reason: pendingEntry.reason, execDate: d.date, execPrice: +d.open.toFixed(4),
          executed: false, blocked: true, note: '封板无法成交' });
        pendingEntry = null;
      } else {
        buyAtOpen(d, pendingEntry);
        pendingEntry = null;
      }
    }

    /* ---------- 收盘：确认新信号（不在此成交） ---------- */
    const inDisplay = d.date >= tradeFrom;
    if (inDisplay && d.date !== lastTradableDate) {
      const hasNext = dayIdx + 1 < days.length;
      if (st.shares === 0 && !pendingEntry) {
        if (rec.entry) {
          pendingEntry = Object.assign({}, rec.entry, { signalDate: d.date });
          signals.push({ signalDate: d.date, type: 'ENTRY', component: rec.entry.type,
            reason: rec.entry.reason, execDate: null, execPrice: null,
            executed: false, blocked: false,
            note: '收盘确认，待下一交易日开盘成交' + (hasNext ? '' : '（无下一交易日，不会成交）') });
          if (!hasNext) { noNextDayCount++; pendingEntry = null; signals[signals.length - 1].blocked = true; }
        }
      } else if (st.shares > 0 && !pendingExit) {
        const reasons = [];
        // maCross 死叉（配置顺序在前/后均按 reasonOrder 排）
        for (const r of rec.exits) reasons.push({ type: r.type, reason: r.reason });
        // 固定持有：买入成交日为第 1 日，持满 N 个完整交易日后下一个交易日开盘退出
        const rule = cond.exitRule;
        if (cond.config.reasonOrder.includes('fixedHolding') && st.buyIndex !== null && j !== undefined) {
          const held = j - st.buyIndex; // 已过去的交易日数；held=N 表示已持满 N 日
          if (held >= rule.holdDays) reasons.push({ type: 'fixedHolding', reason: 'fixedHolding_' + rule.holdDays + '_days' });
        }
        // 止盈止损：以实际买入成交价为基准，收盘确认
        if (cond.config.reasonOrder.includes('returnThreshold') && st.buyPrice !== null) {
          if (rule.takeProfit !== null && d.close >= st.buyPrice * (1 + rule.takeProfit))
            reasons.push({ type: 'returnThreshold', reason: 'takeProfit_' + Math.round(rule.takeProfit * 1000) / 10 + 'pct' });
          else if (rule.stopLoss !== null && d.close <= st.buyPrice * (1 - rule.stopLoss))
            reasons.push({ type: 'returnThreshold', reason: 'stopLoss_' + Math.round(rule.stopLoss * 1000) / 10 + 'pct' });
        }
        // 按配置顺序去重排序，同一类型只保留一条（同日多触发只成交一次）
        if (reasons.length) {
          const uniq = new Map();
          for (const r of reasons) if (!uniq.has(r.type)) uniq.set(r.type, r);
          const ordered = cond.config.reasonOrder.filter(t => uniq.has(t)).map(t => uniq.get(t));
          pendingExit = { signalDate: d.date, reasons: ordered };
          for (const r of ordered) reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
          signals.push({ signalDate: d.date, type: 'EXIT', component: ordered.map(x => x.type).join('+'),
            reason: ordered.map(x => x.reason).join('|'), execDate: null, execPrice: null,
            executed: false, blocked: false, note: '收盘确认，待下一交易日开盘成交' + (hasNext ? '' : '（无下一交易日，不会成交）') });
          if (!hasNext) { noNextDayCount++; pendingExit = null; signals[signals.length - 1].blocked = true; }
        }
      }
    }

    recordEntitlement(d, st, row);
    divGrossTotal += row.grossDividend; divPaidTotal += row.dividendPaid;
    row.mark = d.close; row.shares = st.shares; row.cash = r2(st.cash);
    row.divReceivable = r2(st.divReceivable); row.holdingValue = r2(st.shares * d.close);
    row.asset = r2(st.cash + st.shares * d.close + st.divReceivable);
    if (Math.abs(st.cash + st.shares * d.close + st.divReceivable - row.asset) > 0.011)
      throw new Error('E_ASSET_BREAK ' + d.date);
    if (st.shares > 0 && st.lotOpenDate)
      row.divTaxUnsettled = dividendTax(st.divTaxBase, daysBetween(st.lotOpenDate, d.date), schedule).tax;
    st.lastClose = d.close;
    if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
    maxDD = Math.max(maxDD, 1 - row.asset / peak);
    daily.push(row);

    function buyAtOpen(day, sig) {
      const n = affordableShares(st.cash, day.open, lot, day.date, parValue, schedule);
      if (n <= 0) {
        row.flags.push('INSUFFICIENT_CASH');
        row.note = '现金不足以买入 1 手（' + lot + ' 股）';
        return;
      }
      const amount = n * day.open;
      const f = tradeFee({ date: day.date, side: 'buy', amount, shares: n, price: day.open, parValue, schedule });
      const cashBefore = st.cash;
      st.cash = r2(st.cash - amount - f.total);
      fees.commission += f.commission; fees.stampDuty += f.stampDuty; fees.transferFee += f.transferFee;
      st.shares = n; st.lotOpenDate = day.date; st.buyPrice = day.open; st.buyIndex = tIdx.get(day.date);
      seq++;
      trades.push({ seq, side: 'BUY', date: day.date, price: +day.open.toFixed(4), shares: n,
        amount: r2(amount), commission: f.commission, stampDuty: f.stampDuty, transferFee: f.transferFee,
        fee: f.total, dividendTax: 0, divTaxRate: 0, holdingDays: 0, divTaxBase: 0,
        signalType: sig.type, signalDate: sig.signalDate,
        cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: n, rates: f.rates,
        note: sig.type + ' 信号 ' + sig.signalDate + ' 收盘确认，次日开盘成交（nextOpen）' });
      row.actions.push('BUY'); row.fee += f.total;
      for (let k = signals.length - 1; k >= 0; k--) {
        if (signals[k].signalDate === sig.signalDate && signals[k].type === 'ENTRY' && signals[k].execDate === null) {
          signals[k].execDate = day.date; signals[k].execPrice = +day.open.toFixed(4);
          signals[k].executed = true; break;
        }
      }
      decisions.push({ date: day.date, kind: 'ENTRY', reasons: [{ type: sig.type, reason: sig.reason }],
        action: 'BUY_AT_OPEN', signalDate: sig.signalDate, detail: '收盘确认 → 次开盘成交' });
    }

    function sellAtOpen(day, reasons, signalDate) {
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
        ? '持股 ' + holdingDays + ' 天，红利税 ' + (dt.rate * 100).toFixed(0) + '% 于卖出时补扣 ' + dt.tax + ' 元'
        : '退出信号 ' + signalDate + ' 收盘确认，次日开盘成交（nextOpen）';
      seq++;
      trades.push({ seq, side: 'SELL', date: day.date, price: +day.open.toFixed(4), shares: sharesSold,
        amount: r2(amount), commission: f.commission, stampDuty: f.stampDuty, transferFee: f.transferFee,
        fee: f.total, dividendTax: dt.tax, divTaxRate: dt.rate, holdingDays,
        divTaxBase: r2(st.divTaxBase), signalType: 'EXIT',
        signalReasons: reasons.map(r => r.reason), signalDate,
        cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: 0, rates: f.rates, note });
      row.actions.push('SELL'); row.fee += f.total; row.dividendTax += dt.tax;
      st.divTaxBase = 0; st.lotOpenDate = null; st.buyPrice = null; st.buyIndex = null;
      for (let k = signals.length - 1; k >= 0; k--) {
        if (signals[k].signalDate === signalDate && signals[k].type === 'EXIT' && signals[k].execDate === null) {
          signals[k].execDate = day.date; signals[k].execPrice = +day.open.toFixed(4);
          signals[k].executed = true; break;
        }
      }
      decisions.push({ date: day.date, kind: 'EXIT', reasons: reasons.map(r => Object.assign({}, r)),
        signalDate, action: 'SELL_AT_OPEN', detail: note });
    }
  }

  const last = daily[daily.length - 1];
  const final = last.asset;
  const totalFees = r2(fees.commission + fees.stampDuty + fees.transferFee);
  return {
    daily, trades, signals, decisions, events: st.events, entitlements: st.entitlements,
    composition: cond.config, reasonCounts,
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
      finalShares: st.shares, finalCash: r2(st.cash), finalReceivable: r2(st.divReceivable),
      finalUnsettledDivEvents: st.entitlements.filter(e => !e.paid).length,
      finalUnsettledTax: r2(st.divTaxBase), unclosed: st.shares > 0,
      blockedSellCount, blockedBuyCount, deferredSellDays, noNextDayCount,
      lastTradableDate, reasonCounts,
      composition: cond.config,
      compositionSummary: { warmupRequired: cond.warmupRequired, reasonCounts },
      compositionCounts: reasonCounts
    }
  };
}

module.exports = { runComposedRunner, daysBetween, sealedSide, touchedLimit };
