/* ============================================================================
 * N2 核心：单标的「隔夜」与「长期持有」真实资金模拟
 *
 * 与 engine/backtest.cjs 的根本差异（因此不能复用）：
 *   旧内核 asset *= px/pz 的「总资产浮点 × 比例扣费」模型，没有股数、没有现金、
 *   没有最低佣金、没有 100 份整数约束、没有分红现金流。用户已明确禁止套用该模型。
 *
 * 本内核按「份数 + 现金」逐日推进，每一笔都做现金守恒断言：
 *   可买份数 = 满足 shares*price + fee(shares*price) <= cash 的最大 100 整数倍
 *   fee(x) = max(x * commissionRate, minCommission)
 *
 * 隔夜规则：
 *   每个有行情交易日开盘卖出前一日收盘买入的全部份额 → 当日收盘再买入（末日不买）
 *
 * 停牌规则（suspension.mode = carry_and_defer）：
 *   停牌日不成交、现金不变、持仓按前一有效收盘估值；
 *   原定当日的买卖顺延到下一个有行情交易日，逐条记 deferral。
 * ==========================================================================*/
'use strict';

const EPS = 1e-9;

function feeOf(amount, costs) {
  if (amount <= 0) return 0;
  return Math.max(amount * costs.commissionRate, costs.minCommission);
}

/* 给定现金与价格，求可买最大份数（lot 整数倍，且含佣金后不超出现金） */
function affordableShares(cash, price, lot, costs) {
  if (!(price > 0) || !(cash > 0)) return 0;
  let n = Math.floor(cash / (price * (1 + costs.commissionRate)) / lot) * lot;
  while (n > 0) {
    const amount = n * price;
    if (amount + feeOf(amount, costs) <= cash + EPS) break;
    n -= lot;
  }
  return Math.max(0, n);
}

function round2(x) { return Math.round(x * 100) / 100; }

/* ---------- 隔夜策略 ---------- */
function runOvernight(days, opts) {
  const { lot, initialCapital, costs, dividends = [] } = opts;
  const divMap = new Map(dividends.map(d => [d.exDate, d.perShare]));
  let cash = initialCapital, shares = 0, lastClose = null;
  const daily = [], trades = [];
  let seq = 0, fees = 0, divTotal = 0, peak = initialCapital, maxDD = 0, peakDate = days[0] && days[0].date;
  let pendingSell = false, pendingBuy = false, pendingSince = null;

  const tradable = days.filter(d => !d.suspended);
  const lastTradableDate = tradable.length ? tradable[tradable.length - 1].date : null;

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const row = {
      date: d.date, suspended: !!d.suspended,
      open: d.open, close: d.close, mark: null,
      shares: null, cash: null, holdingValue: null, asset: null,
      actions: [], fee: 0, dividend: 0, note: ''
    };

    if (d.suspended) {
      /* 停牌：不成交、不估值重算，按前一有效收盘 */
      row.mark = lastClose;
      if (shares > 0) { row.note = '停牌：本应开盘卖出，顺延至下一有行情交易日'; pendingSell = true; pendingSince = d.date; }
      else if (pendingBuy) { row.note = '停牌：本应收盘买入，顺延至下一有行情交易日'; }
      row.shares = shares; row.cash = round2(cash);
      row.holdingValue = round2(shares * lastClose);
      row.asset = round2(cash + shares * lastClose);
      daily.push(row);
      if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
      maxDD = Math.max(maxDD, 1 - row.asset / peak);
      continue;
    }

    /* 除息：开盘前现金到账（除息日价格已下调，现金补偿回落） */
    const div = divMap.get(d.date);
    if (div && shares > 0) {
      const amt = shares * div;
      cash += amt; divTotal += amt; row.dividend = round2(amt);
      row.actions.push('DIV');
    }

    /* 1) 开盘卖出（每个有行情日开盘都卖，含停牌顺延） */
    if (shares > 0) {
      const amount = shares * d.open;
      const fee = round2(feeOf(amount, costs));
      const cashBefore = cash;
      cash += amount - fee;
      fees += fee;
      seq++;
      trades.push({
        seq, side: 'SELL', date: d.date, price: d.open, shares,
        amount: round2(amount), fee,
        cashBefore: round2(cashBefore), cashAfter: round2(cash), sharesAfter: 0,
        note: pendingSell ? `停牌顺延（原定 ${pendingSince} 开盘卖出）` : ''
      });
      row.actions.push('SELL'); row.fee += fee; shares = 0; pendingSell = false;
    }

    /* 2) 收盘买入（末日不再买入） */
    if (d.date !== lastTradableDate) {
      const n = affordableShares(cash, d.close, lot, costs);
      if (n > 0) {
        const amount = n * d.close;
        const fee = round2(feeOf(amount, costs));
        const cashBefore = cash;
        cash -= amount + fee;
        fees += fee;
        shares = n;
        seq++;
        trades.push({
          seq, side: 'BUY', date: d.date, price: d.close, shares: n,
          amount: round2(amount), fee,
          cashBefore: round2(cashBefore), cashAfter: round2(cash), sharesAfter: n,
          note: ''
        });
        row.actions.push('BUY'); row.fee += fee;
      } else {
        row.note = '现金不足以买入 1 手（' + lot + ' 份）';
        pendingBuy = true;
      }
    } else {
      row.note = '最后有效交易日：开盘卖出后不再买入';
    }
    pendingBuy = false;

    /* 3) 日终估值：现金 + 份额 × 未复权收盘 */
    row.mark = d.close;
    row.shares = shares; row.cash = round2(cash);
    row.holdingValue = round2(shares * d.close);
    row.asset = round2(cash + shares * d.close);
    if (Math.abs((cash + shares * d.close) - row.asset) > 0.01) throw new Error(`E_CASH_BREAK ${d.date}`);
    lastClose = d.close;
    if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
    maxDD = Math.max(maxDD, 1 - row.asset / peak);
    daily.push(row);
  }

  const final = daily[daily.length - 1].asset;
  return {
    daily, trades,
    summary: {
      final, totalReturn: final / initialCapital - 1,
      cagr: Math.pow(final / initialCapital, opts.tradingDaysPerYear / tradable.length) - 1,
      maxDD, peak, peakDate,
      tradingDays: days.length, tradableDays: tradable.length,
      buyCount: trades.filter(t => t.side === 'BUY').length,
      sellCount: trades.filter(t => t.side === 'SELL').length,
      tradeCount: trades.length,
      totalFees: round2(fees), totalDividends: round2(divTotal),
      finalShares: shares, finalCash: round2(cash),
      lastTradableDate
    }
  };
}

/* ---------- 长期持有对照 ---------- */
function runHold(days, opts) {
  const { lot, initialCapital, costs, dividends = [] } = opts;
  const divMap = new Map(dividends.map(d => [d.exDate, d.perShare]));
  const tradable = days.filter(d => !d.suspended);
  if (!tradable.length) throw new Error('E_NO_DATA');
  const firstDate = tradable[0].date, lastDate = tradable[tradable.length - 1].date;

  let cash = initialCapital, shares = 0, lastClose = null;
  let fees = 0, divTotal = 0, peak = initialCapital, maxDD = 0;
  const daily = [], trades = [];
  let seq = 0;

  for (const d of days) {
    const row = {
      date: d.date, suspended: !!d.suspended,
      open: d.open, close: d.close, mark: null,
      shares: null, cash: null, holdingValue: null, asset: null,
      actions: [], fee: 0, dividend: 0, note: ''
    };

    if (d.suspended) {
      row.mark = lastClose; row.shares = shares; row.cash = round2(cash);
      row.holdingValue = round2(shares * lastClose);
      row.asset = round2(cash + shares * lastClose);
      daily.push(row);
      peak = Math.max(peak, row.asset);
      maxDD = Math.max(maxDD, 1 - row.asset / peak);
      continue;
    }

    const div = divMap.get(d.date);
    if (div && shares > 0) {
      const amt = shares * div;
      cash += amt; divTotal += amt; row.dividend = round2(amt); row.actions.push('DIV');
    }

    if (d.date === firstDate) {
      const n = affordableShares(cash, d.close, lot, costs);
      if (n <= 0) throw new Error('E_INSUFFICIENT_CAPITAL: 本金不足以买入 1 手');
      const amount = n * d.close, fee = round2(feeOf(amount, costs)), cb = cash;
      cash -= amount + fee; fees += fee; shares = n; seq++;
      trades.push({ seq, side: 'BUY', date: d.date, price: d.close, shares: n,
        amount: round2(amount), fee, cashBefore: round2(cb), cashAfter: round2(cash),
        sharesAfter: n, note: '建仓（与隔夜策略首个买入日同价同日）' });
      row.actions.push('BUY'); row.fee += fee;
    } else if (d.date === lastDate && shares > 0) {
      const amount = shares * d.open, fee = round2(feeOf(amount, costs)), cb = cash;
      cash += amount - fee; fees += fee; seq++;
      trades.push({ seq, side: 'SELL', date: d.date, price: d.open, shares,
        amount: round2(amount), fee, cashBefore: round2(cb), cashAfter: round2(cash),
        sharesAfter: 0, note: '最后有效交易日开盘平仓' });
      row.actions.push('SELL'); row.fee += fee; shares = 0;
    }

    row.mark = d.close; row.shares = shares; row.cash = round2(cash);
    row.holdingValue = round2(shares * d.close);
    row.asset = round2(cash + shares * d.close);
    lastClose = d.close;
    peak = Math.max(peak, row.asset);
    maxDD = Math.max(maxDD, 1 - row.asset / peak);
    daily.push(row);
  }

  const final = daily[daily.length - 1].asset;
  return {
    daily, trades,
    summary: {
      final, totalReturn: final / initialCapital - 1,
      cagr: Math.pow(final / initialCapital, opts.tradingDaysPerYear / tradable.length) - 1,
      maxDD, peak: Math.max(...daily.map(r => r.asset)),
      tradingDays: days.length, tradableDays: tradable.length,
      buyCount: trades.filter(t => t.side === 'BUY').length,
      sellCount: trades.filter(t => t.side === 'SELL').length,
      tradeCount: trades.length,
      totalFees: round2(fees), totalDividends: round2(divTotal),
      finalShares: shares, finalCash: round2(cash),
      firstDate, lastDate
    }
  };
}

/* ---------- B 策略：收盘买 / 次日收盘卖（同日收盘卖出并同价买回） ----------
 * 规则：
 *   首个可交易日收盘建仓；
 *   之后每个可交易日收盘：先卖出全部份额（按当日收盘价），再于同一收盘价买回，
 *   卖出与买入分别计费、分别重算可买份额、均预留佣金（不允许负现金）；
 *   最后一个可交易日收盘卖出后不再买入（期末平仓）；
 *   停牌日不成交，持仓按前一有效收盘估值，顺延至下一可交易日收盘执行。
 *
 * 注意：同价卖出再买入是理想化假设（现实中同一时点不能既卖又买），
 *      仅用于隔离「价格敞口」与「每日费用」两个因素，不代表可实际复现。
 * ------------------------------------------------------------------------- */
function runCloseToClose(days, opts) {
  const { lot, initialCapital, costs, dividends = [] } = opts;
  const divMap = new Map(dividends.map(d => [d.exDate, d.perShare]));
  const tradable = days.filter(d => !d.suspended);
  if (!tradable.length) throw new Error('E_NO_DATA');
  const firstDate = tradable[0].date, lastDate = tradable[tradable.length - 1].date;

  let cash = initialCapital, shares = 0, lastClose = null;
  let seq = 0, fees = 0, divTotal = 0, peak = initialCapital, maxDD = 0, peakDate = firstDate;
  let pendingCycle = false, pendingSince = null;
  const daily = [], trades = [];

  for (const d of days) {
    const row = {
      date: d.date, suspended: !!d.suspended,
      open: d.open, close: d.close, mark: null,
      shares: null, cash: null, holdingValue: null, asset: null,
      actions: [], fee: 0, dividend: 0, note: ''
    };

    if (d.suspended) {
      row.mark = lastClose;
      row.note = shares > 0
        ? '停牌：本应收盘卖出并买回，顺延至下一可交易日'
        : '停牌：无法成交';
      pendingCycle = shares > 0; pendingSince = d.date;
      row.shares = shares; row.cash = round2(cash);
      row.holdingValue = round2(shares * lastClose);
      row.asset = round2(cash + shares * lastClose);
      daily.push(row);
      if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
      maxDD = Math.max(maxDD, 1 - row.asset / peak);
      continue;
    }

    /* 除息：收盘前现金到账（除息日价格已下调） */
    const div = divMap.get(d.date);
    if (div && shares > 0) {
      const amt = shares * div;
      cash += amt; divTotal += amt; row.dividend = round2(amt); row.actions.push('DIV');
    }

    if (d.date === firstDate) {
      /* 建仓：与 A 策略同一天、同一收盘价、同一份数口径 */
      const n = affordableShares(cash, d.close, lot, costs);
      if (n <= 0) throw new Error('E_INSUFFICIENT_CAPITAL: 本金不足以买入 1 手');
      const amount = n * d.close, fee = round2(feeOf(amount, costs)), cb = cash;
      cash -= amount + fee; fees += fee; shares = n; seq++;
      trades.push({ seq, side: 'BUY', date: d.date, price: d.close, shares: n,
        amount: round2(amount), fee, cashBefore: round2(cb), cashAfter: round2(cash),
        sharesAfter: n, note: '建仓（与 A 策略同日同价同日收盘买入）' });
      row.actions.push('BUY'); row.fee += fee;
    } else {
      /* 1) 收盘卖出全部份额 */
      if (shares > 0) {
        const amount = shares * d.close;
        const fee = round2(feeOf(amount, costs));
        const cb = cash;
        cash += amount - fee; fees += fee; seq++;
        trades.push({ seq, side: 'SELL', date: d.date, price: d.close, shares,
          amount: round2(amount), fee, cashBefore: round2(cb), cashAfter: round2(cash),
          sharesAfter: 0,
          note: pendingCycle ? `停牌顺延（原定 ${pendingSince} 收盘卖出）` : '收盘卖出' });
        row.actions.push('SELL'); row.fee += fee; shares = 0; pendingCycle = false;
      }
      /* 2) 同一收盘价买回（末日不再买入） */
      if (d.date !== lastDate) {
        const n = affordableShares(cash, d.close, lot, costs);
        if (n > 0) {
          const amount = n * d.close;
          const fee = round2(feeOf(amount, costs));
          const cb = cash;
          cash -= amount + fee; fees += fee; shares = n; seq++;
          trades.push({ seq, side: 'BUY', date: d.date, price: d.close, shares: n,
            amount: round2(amount), fee, cashBefore: round2(cb), cashAfter: round2(cash),
            sharesAfter: n, note: '同一收盘价买回' });
          row.actions.push('BUY'); row.fee += fee;
        } else {
          row.note = '现金不足以买入 1 手（' + lot + ' 份）';
        }
      } else {
        row.note = '最后有效交易日：收盘卖出后不再买入';
      }
    }

    /* 日终估值：现金 + 份额 × 未复权收盘 */
    row.mark = d.close;
    row.shares = shares; row.cash = round2(cash);
    row.holdingValue = round2(shares * d.close);
    row.asset = round2(cash + shares * d.close);
    if (Math.abs((cash + shares * d.close) - row.asset) > 0.01) throw new Error(`E_CASH_BREAK ${d.date}`);
    lastClose = d.close;
    if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
    maxDD = Math.max(maxDD, 1 - row.asset / peak);
    daily.push(row);
  }

  const final = daily[daily.length - 1].asset;
  return {
    daily, trades,
    summary: {
      final, totalReturn: final / initialCapital - 1,
      cagr: Math.pow(final / initialCapital, opts.tradingDaysPerYear / tradable.length) - 1,
      maxDD, peak, peakDate,
      tradingDays: days.length, tradableDays: tradable.length,
      buyCount: trades.filter(t => t.side === 'BUY').length,
      sellCount: trades.filter(t => t.side === 'SELL').length,
      tradeCount: trades.length,
      totalFees: round2(fees), totalDividends: round2(divTotal),
      finalShares: shares, finalCash: round2(cash),
      firstDate, lastDate
    }
  };
}

module.exports = { runOvernight, runCloseToClose, runHold, affordableShares, feeOf, round2 };
