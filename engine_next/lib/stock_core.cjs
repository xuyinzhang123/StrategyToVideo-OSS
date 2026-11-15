/* ============================================================================
 * S2 个股「隔夜」与「长期持有」资金模拟内核（股数 + 现金逐笔推进）
 *
 * 与 ETF 内核（lib/overnight_core.cjs）的差异（因此另开一份，不改动已验收的 ETF 代码）：
 *   1) 费用按成交当日适用费率计收（印花税/过户费存在费率变更）
 *   2) 涨跌停与「全天封板无法成交」：卖出失败保留持仓、买入失败保留现金，
 *      绝不假设未成交的资金/股份已经变动
 *   3) 股息红利个人所得税：按卖出时持股期限补扣
 *   4) 送转股本：除权日调整股数，与现金分红同源、不重复计算
 *   5) 期末仍无法平仓时明确标记 UNCLOSED，不静默按可卖出处理
 *   6) 分红三段式：登记日收盘确认权益 → 除息日确认应收股息 → 派息日现金到账
 *
 * 统一口径：全程使用未复权真实成交价；公司行为以「现金 + 股数」显式入账，
 *          不使用任何复权价格参与估值，避免复权与分红重复计算。
 *
 * 分红的三段式为什么必须拆开：
 *   - 权益由「股权登记日收盘」的持股决定，不是除息日。若在登记日之后、除息日之前
 *     卖出，仍应享有分红；按「除息日当时持股」记账会把这份权益丢掉。
 *   - 除息日价格已按除息参考价下调，若现金当天没到账又不计应收，账户会出现一段
 *     凭空的下跌（虚假回撤）。因此除息日起把「应收股息」计入总资产。
 *   - 现金按实际派息日到账，未到账前不得用于买入 —— 应收股息不是可用资金。
 * ==========================================================================*/
'use strict';
const { tradeFee, dividendTax, affordableShares, r2 } = require('./stock_cost.cjs');
/* 支持边界在入口处强制校验：加仓/部分卖出/分红再投资等一律抛错，不靠文档提醒 */
const { assertSupportedOptions } = require('./support_guard.cjs');

const EPS = 1e-9;

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/* 涨跌停价：前收盘价（除权日为除权参考价）×(1±比例)，四舍五入至 0.01 */
function limitPrices(refClose, pct) {
  if (refClose === null || refClose === undefined) return { up: null, down: null };
  return {
    up: Math.round(refClose * (1 + pct) * 100 + 1e-9) / 100,
    down: Math.round(refClose * (1 - pct) * 100 + 1e-9) / 100
  };
}

/* 除权除息参考价 =（前收盘 - 每股现金红利 + 配股价×配股比例）/(1+送转比例+配股比例)
 * 首版仅支持现金分红与送转，配股在数据层即被拒绝。 */
function exRefPrice(prevClose, act) {
  if (!act) return prevClose;
  const cash = act.cashPerShare || 0;
  const ratio = act.shareRatio || 0;
  return Math.round(((prevClose - cash) / (1 + ratio)) * 100 + 1e-9) / 100;
}

/* 是否「全天封板」：开=高=低=收 且 该价等于涨停价或跌停价
 * 注意：这是「日线不能证明成交」时的保守判定，不等于事实上必然无法成交 ——
 *      一字板当日成交量可以大于 0（有对手方在限价上成交），日线无法区分
 *      「我的委托排在队尾没成交」与「成交了」。故该判定可由 opts.blockSealed=false 关闭。 */
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

/* ---------- 统一时间轴：交易日 + 停牌日 + 涨跌停价 + 分红三日期 ---------- */
function buildTimeline({ calendar, bars, actions, priceLimitPct }) {
  const barMap = new Map(bars.map(b => [b.date, b]));
  const calSet = new Set(calendar);

  const byEx = new Map(), byRec = new Map(), byPay = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const a of actions || []) {
    if (!a.recordDate) throw new Error(`E_DIV_NO_RECORD_DATE: ${a.date} 缺股权登记日，无法确认权益`);
    if (!a.payDate) throw new Error(`E_DIV_NO_PAY_DATE: ${a.date} 缺派息日，拒绝按除息日默认到账`);
    if (a.payDate < a.recordDate) throw new Error(`E_DIV_PAY_BEFORE_RECORD: ${a.date} 派息日 ${a.payDate} 早于登记日 ${a.recordDate}`);
    for (const [k, label] of [[a.recordDate, '股权登记日'], [a.date, '除息日'], [a.payDate, '派息日']])
      if (!calSet.has(k)) throw new Error(`E_DIV_DATE_NOT_TRADING: ${a.date} 的${label} ${k} 不在交易日历内，需人工核对`);
    push(byEx, a.date, a); push(byRec, a.recordDate, a); push(byPay, a.payDate, a);
  }

  const days = [];
  let prevClose = null;
  for (const date of calendar) {
    const b = barMap.get(date);
    const exActs = byEx.get(date) || [];
    const act = exActs.length ? exActs[0] : null;
    const common = { divEx: exActs, divRecord: byRec.get(date) || [], divPay: byPay.get(date) || [] };
    if (!b) {
      days.push(Object.assign({
        date, suspended: true, open: null, close: null, high: null, low: null,
        refClose: prevClose, limitUp: null, limitDown: null,
        cashPerShare: act ? act.cashPerShare : 0, shareRatio: act ? act.shareRatio : 0, action: act
      }, common));
      continue;
    }
    const ref = exRefPrice(prevClose, act);
    const lim = limitPrices(ref, priceLimitPct);
    days.push(Object.assign({
      date, suspended: false, open: b.open, close: b.close, high: b.high, low: b.low,
      volume: b.volume, refClose: ref, limitUp: lim.up, limitDown: lim.down,
      cashPerShare: act ? act.cashPerShare || 0 : 0,
      shareRatio: act ? act.shareRatio || 0 : 0,
      action: act
    }, common));
    prevClose = b.close;
  }
  return days;
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

/* ---------- 分红三段式 ---------- */

/* ① 除息日：确认应收股息（价格已除息，用应收补上，避免虚假回撤） */
function recognizeExDate(d, st, row) {
  for (const e of st.entitlements) {
    if (e.recognized || e.exDate !== d.date) continue;
    e.recognized = true;
    st.divReceivable = r2(st.divReceivable + e.gross);
    row.grossDividend = r2(row.grossDividend + e.gross);
    row.actions.push('DIV_EX');
  }
}

/* ② 派息日：现金真正到账，应收转现金 */
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

/* ③ 送转股本：除权日按持股调整股数（现金分红与送转同源，不重复计） */
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

/* ④ 股权登记日收盘：按当日收盘持股确认权益，并计入该笔持仓的红利税基 */
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

/* ---------- 隔夜策略 ---------- */
function runOvernightStock(days, opts) {
  assertSupportedOptions(opts, 'runOvernightStock');
  const { lot, initialCapital, schedule, parValue } = opts;
  const blockSealed = opts.blockSealed !== false;
  const tradable = days.filter(d => !d.suspended);
  if (tradable.length < 2) throw new Error('E_NO_DATA: 可交易日不足 2 天');
  const lastTradableDate = tradable[tradable.length - 1].date;

  const st = {
    cash: initialCapital, shares: 0, lotOpenDate: null, lastClose: null,
    divReceivable: 0, divTaxBase: 0, oddLotDropped: 0, events: [], entitlements: []
  };
  const daily = [], trades = [];
  let seq = 0, fees = { commission: 0, stampDuty: 0, transferFee: 0 };
  let divTaxTotal = 0, divGrossTotal = 0, divPaidTotal = 0;
  let peak = initialCapital, peakDate = tradable[0].date, maxDD = 0;
  let pendingSell = false, pendingSellSince = null;
  let blockedSellCount = 0, blockedBuyCount = 0, touchCount = 0;
  let insufficientCashCount = 0, lastBuyDate = null, lastSellDate = null;
  let deferredSellDays = 0;

  for (const d of days) {
    const row = emptyRow(d);

    /* 1) 分红三段式（先除息确认应收，再派息到账；停牌日同样处理） */
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
      /* 停牌日也可能是股权登记日：权益照常确认，不能因为没行情就丢失 */
      recordEntitlement(d, st, row);
      divGrossTotal += row.grossDividend;
      divPaidTotal += row.dividendPaid;
      row.shares = st.shares;
      row.cash = r2(st.cash);
      row.divReceivable = r2(st.divReceivable);
      row.holdingValue = r2(st.shares * st.lastClose);
      row.asset = r2(st.cash + st.shares * st.lastClose + st.divReceivable);
      if (st.shares > 0 && st.lotOpenDate)
        row.divTaxUnsettled = dividendTax(st.divTaxBase, daysBetween(st.lotOpenDate, d.date), schedule).tax;
      daily.push(row);
      if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
      maxDD = Math.max(maxDD, 1 - row.asset / peak);
      continue;
    }

    const tk = touchedLimit(d);
    if (tk) { row.flags.push('T_LIMIT_TOUCH_' + tk); touchCount++; }

    /* 2) 开盘卖出 */
    if (st.shares > 0) {
      const sealed = sealedSide(d);
      if (blockSealed && sealed === 'DOWN') {
        blockedSellCount++;
        pendingSell = true;
        if (!pendingSellSince) pendingSellSince = d.date;
        row.flags.push('SELL_BLOCKED');
        row.note = '一字跌停（开=高=低=收=跌停价），开盘无法卖出，持仓保留、资金未到账';
      } else {
        const amount = st.shares * d.open;
        const f = tradeFee({ date: d.date, side: 'sell', amount, shares: st.shares, price: d.open, parValue, schedule });
        const holdingDays = st.lotOpenDate ? daysBetween(st.lotOpenDate, d.date) : 0;
        const dt = dividendTax(st.divTaxBase, holdingDays, schedule);
        const cashBefore = st.cash;
        st.cash = r2(st.cash + amount - f.total - dt.tax);
        fees.commission += f.commission; fees.stampDuty += f.stampDuty; fees.transferFee += f.transferFee;
        divTaxTotal += dt.tax;
        const sharesSold = st.shares;
        st.shares = 0;
        const note = dt.tax > 0
          ? `持股 ${holdingDays} 天，红利税 ${(dt.rate * 100).toFixed(0)}% 于卖出时补扣 ${dt.tax} 元`
          : (pendingSell ? `顺延卖出（原定 ${pendingSellSince} 开盘）` : '');
        seq++;
        trades.push({
          seq, side: 'SELL', date: d.date, price: d.open, shares: sharesSold,
          amount: r2(amount), commission: f.commission, stampDuty: f.stampDuty, transferFee: f.transferFee,
          fee: f.total, dividendTax: dt.tax, divTaxRate: dt.rate, holdingDays,
          divTaxBase: r2(st.divTaxBase),
          cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: 0,
          rates: f.rates, note
        });
        row.actions.push('SELL');
        row.fee += f.total;
        row.dividendTax += dt.tax;
        lastSellDate = d.date;
        st.divTaxBase = 0;
        st.lotOpenDate = null;
        pendingSell = false; pendingSellSince = null;
      }
    }

    /* 3) 收盘买入（最后有效交易日不再建仓；持仓未卖出时不得加仓） */
    if (st.shares > 0) {
      row.flags.push('NO_REBUY_WHILE_HOLDING');
      if (!row.note) row.note = '持仓未能卖出，当日不再建仓';
    } else if (d.date !== lastTradableDate) {
      const sealed = sealedSide(d);
      if (blockSealed && sealed === 'UP') {
        blockedBuyCount++;
        row.flags.push('BUY_BLOCKED');
        row.note = '一字涨停（开=高=低=收=涨停价），收盘无法买入，现金保留';
      } else {
        /* 可用资金只含现金：应收股息未到账，不得用于买入 */
        const n = affordableShares(st.cash, d.close, lot, d.date, parValue, schedule);
        if (n > 0) {
          const amount = n * d.close;
          const f = tradeFee({ date: d.date, side: 'buy', amount, shares: n, price: d.close, parValue, schedule });
          const cashBefore = st.cash;
          st.cash = r2(st.cash - amount - f.total);
          fees.commission += f.commission; fees.stampDuty += f.stampDuty; fees.transferFee += f.transferFee;
          st.shares = n;
          st.lotOpenDate = d.date;
          seq++;
          trades.push({
            seq, side: 'BUY', date: d.date, price: d.close, shares: n,
            amount: r2(amount), commission: f.commission, stampDuty: f.stampDuty, transferFee: f.transferFee,
            fee: f.total, dividendTax: 0, divTaxRate: 0, holdingDays: 0, divTaxBase: 0,
            cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: n,
            rates: f.rates, note: ''
          });
          row.actions.push('BUY');
          row.fee += f.total;
          lastBuyDate = d.date;
        } else {
          insufficientCashCount++;
          row.note = `现金不足以买入 1 手（${lot} 股）`;
          row.flags.push('INSUFFICIENT_CASH');
        }
      }
    } else {
      row.note = '最后有效交易日：开盘卖出后不再建仓';
      row.flags.push('LAST_DAY_NO_BUY');
    }

    /* 4) 股权登记日收盘：确认分红权益（在当日买入之后，收盘持股即为登记持股） */
    recordEntitlement(d, st, row);
    divGrossTotal += row.grossDividend;
    divPaidTotal += row.dividendPaid;

    /* 5) 日终估值：总资产 = 现金 + 持仓市值 + 应收股息 */
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
  }

  const last = daily[daily.length - 1];
  const final = last.asset;
  const totalFees = r2(fees.commission + fees.stampDuty + fees.transferFee);
  const unsettled = st.entitlements.filter(e => !e.paid);
  return {
    daily, trades, events: st.events, entitlements: st.entitlements,
    summary: {
      final, totalReturn: final / initialCapital - 1,
      cagr: Math.pow(final / initialCapital, opts.tradingDaysPerYear / tradable.length) - 1,
      maxDD, peak, peakDate,
      tradingDays: days.length, tradableDays: tradable.length,
      suspendedDays: days.length - tradable.length,
      buyCount: trades.filter(t => t.side === 'BUY').length,
      sellCount: trades.filter(t => t.side === 'SELL').length,
      tradeCount: trades.length,
      totalFees, feeBreakdown: { commission: r2(fees.commission), stampDuty: r2(fees.stampDuty), transferFee: r2(fees.transferFee) },
      totalGrossDividends: r2(divGrossTotal), totalDividendPaid: r2(divPaidTotal), totalDividendTax: r2(divTaxTotal),
      oddLotDropped: st.oddLotDropped,
      finalShares: st.shares, finalCash: r2(st.cash),
      finalReceivable: r2(st.divReceivable),
      finalUnsettledDivEvents: unsettled.length,
      finalUnsettledTax: r2(st.divTaxBase),
      unclosed: st.shares > 0,
      blockedSellCount, blockedBuyCount, limitTouchCount: touchCount, deferredSellDays,
      insufficientCashCount, lastBuyDate, lastSellDate,
      lastTradableDate,
      composition: {
        cash: r2(st.cash), shares: st.shares, holdingValue: r2(st.shares * last.mark),
        receivable: r2(st.divReceivable), pendingTax: r2(st.divTaxBase),
        note: '期末总资产 = 现金 + 持仓市值 + 应收股息；期末已无未结算红利税（有平仓成交时税已扣）'
      }
    }
  };
}

/* ---------- 长期持有对照 ---------- */
function runHoldStock(days, opts) {
  assertSupportedOptions(opts, 'runHoldStock');
  const { lot, initialCapital, schedule, parValue } = opts;
  const blockSealed = opts.blockSealed !== false;
  const tradable = days.filter(d => !d.suspended);
  if (!tradable.length) throw new Error('E_NO_DATA');
  const firstDate = tradable[0].date, lastDate = tradable[tradable.length - 1].date;

  const st = {
    cash: initialCapital, shares: 0, lotOpenDate: null, lastClose: null,
    divReceivable: 0, divTaxBase: 0, oddLotDropped: 0, events: [], entitlements: []
  };
  const daily = [], trades = [];
  let seq = 0, fees = { commission: 0, stampDuty: 0, transferFee: 0 };
  let divTaxTotal = 0, divGrossTotal = 0, divPaidTotal = 0;
  let peak = initialCapital, peakDate = firstDate, maxDD = 0;
  let blockedSellCount = 0, unclosed = false;

  for (const d of days) {
    const row = emptyRow(d);

    recognizeExDate(d, st, row);
    settlePayDate(d, st, row);
    applyShareDividend(d, st, row);

    if (d.suspended) {
      row.mark = st.lastClose;
      recordEntitlement(d, st, row);
      divGrossTotal += row.grossDividend;
      divPaidTotal += row.dividendPaid;
      row.shares = st.shares; row.cash = r2(st.cash);
      row.divReceivable = r2(st.divReceivable);
      row.holdingValue = r2(st.shares * st.lastClose);
      row.asset = r2(st.cash + st.shares * st.lastClose + st.divReceivable);
      if (st.shares > 0 && st.lotOpenDate)
        row.divTaxUnsettled = dividendTax(st.divTaxBase, daysBetween(st.lotOpenDate, d.date), schedule).tax;
      row.flags.push('SUSPENDED');
      daily.push(row);
      if (row.asset > peak) { peak = row.asset; peakDate = row.date; }
      maxDD = Math.max(maxDD, 1 - row.asset / peak);
      continue;
    }

    if (d.date === firstDate) {
      const n = affordableShares(st.cash, d.close, lot, d.date, parValue, schedule);
      if (n <= 0) throw new Error('E_INSUFFICIENT_CAPITAL: 本金不足以买入 1 手');
      const amount = n * d.close;
      const f = tradeFee({ date: d.date, side: 'buy', amount, shares: n, price: d.close, parValue, schedule });
      const cashBefore = st.cash;
      st.cash = r2(st.cash - amount - f.total);
      fees.commission += f.commission; fees.stampDuty += f.stampDuty; fees.transferFee += f.transferFee;
      st.shares = n; st.lotOpenDate = d.date;
      seq++;
      trades.push({
        seq, side: 'BUY', date: d.date, price: d.close, shares: n, amount: r2(amount),
        commission: f.commission, stampDuty: f.stampDuty, transferFee: f.transferFee, fee: f.total,
        dividendTax: 0, divTaxRate: 0, holdingDays: 0, divTaxBase: 0,
        cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: n,
        rates: f.rates, note: '建仓（与隔夜策略首个买入日同日同价）'
      });
      row.actions.push('BUY'); row.fee += f.total;
    } else if (d.date === lastDate && st.shares > 0) {
      const sealed = sealedSide(d);
      if (blockSealed && sealed === 'DOWN') {
        blockedSellCount++; unclosed = true;
        row.flags.push('SELL_BLOCKED', 'UNCLOSED');
        row.note = '最后交易日一字跌停，无法平仓，按收盘价估值并标记未平仓';
      } else {
        const amount = st.shares * d.open;
        const f = tradeFee({ date: d.date, side: 'sell', amount, shares: st.shares, price: d.open, parValue, schedule });
        const holdingDays = st.lotOpenDate ? daysBetween(st.lotOpenDate, d.date) : 0;
        const dt = dividendTax(st.divTaxBase, holdingDays, schedule);
        const cashBefore = st.cash;
        st.cash = r2(st.cash + amount - f.total - dt.tax);
        fees.commission += f.commission; fees.stampDuty += f.stampDuty; fees.transferFee += f.transferFee;
        divTaxTotal += dt.tax;
        const sharesSold = st.shares;
        const taxBaseSold = st.divTaxBase;
        st.shares = 0; st.divTaxBase = 0;
        seq++;
        trades.push({
          seq, side: 'SELL', date: d.date, price: d.open, shares: sharesSold, amount: r2(amount),
          commission: f.commission, stampDuty: f.stampDuty, transferFee: f.transferFee, fee: f.total,
          dividendTax: dt.tax, divTaxRate: dt.rate, holdingDays, divTaxBase: r2(taxBaseSold),
          cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: 0,
          rates: f.rates, note: `最后交易日开盘平仓；持股 ${holdingDays} 天，红利税 ${(dt.rate * 100).toFixed(0)}%`
        });
        row.actions.push('SELL'); row.fee += f.total; row.dividendTax += dt.tax;
      }
    }

    recordEntitlement(d, st, row);
    divGrossTotal += row.grossDividend;
    divPaidTotal += row.dividendPaid;

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
  }

  const last = daily[daily.length - 1];
  const final = last.asset;
  const totalFees = r2(fees.commission + fees.stampDuty + fees.transferFee);
  return {
    daily, trades, events: st.events, entitlements: st.entitlements,
    summary: {
      final, totalReturn: final / initialCapital - 1,
      cagr: Math.pow(final / initialCapital, opts.tradingDaysPerYear / tradable.length) - 1,
      maxDD, peak, peakDate,
      tradingDays: days.length, tradableDays: tradable.length,
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
      unclosed, blockedSellCount,
      firstDate, lastDate, lastTradableDate: lastDate,
      composition: {
        cash: r2(st.cash), shares: st.shares, holdingValue: r2(st.shares * last.mark),
        receivable: r2(st.divReceivable), pendingTax: r2(st.divTaxBase),
        note: '期末总资产 = 现金 + 持仓市值 + 应收股息'
      }
    }
  };
}

module.exports = {
  buildTimeline, runOvernightStock, runHoldStock,
  limitPrices, exRefPrice, sealedSide, touchedLimit, daysBetween
};
