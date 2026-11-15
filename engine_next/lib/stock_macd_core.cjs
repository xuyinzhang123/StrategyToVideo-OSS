/* ============================================================================
 * S4 个股「MACD 金叉买入 / 死叉卖出」回测内核
 * --------------------------------------------------------------------------
 * 设计原则（与已封版核心 backtest_stock.cjs / lib/stock_core.cjs 的关系）：
 *   · 本文件【不修改】stock_core.cjs 任何既有权重与算法；runOvernightStock /
 *     runHoldStock 字节不变，已封版的两套视频与 stock_601398_r2 回测结果不受影响。
 *   · 复用 stock_core.cjs / stock_cost.cjs / support_guard.cjs 的【已导出】API：
 *       buildTimeline, runHoldStock（买入持有对照）, tradeFee, dividendTax,
 *       affordableShares, r2, buildSchedule, zeroCostConfig, assertSupportedOptions。
 *   · 个股分红三段式、涨跌停封板判定、持股天数等【内部】辅助函数（stock_core.cjs
 *     未导出）在本文件内逐字复制（见下方「VERBATIM COPY」标注），以保证资金/税务
 *     口径与已封版实现完全一致、不引入漂移。复制段与 stock_core.cjs 同源同义。
 *
 * MACD 定义（标准，可被 config.macd 覆盖，默认 12/26/9）：
 *   EMA(p) 以「前 p 日 SMA」为种子，之后递归 EMA[i]=price*k+EMA[i-1]*(1-k), k=2/(p+1)。
 *   DIF = EMA(fast) - EMA(slow)；DEA = EMA(signal) of DIF；HIST = DIF - DEA。
 *   金叉 = DIF 上穿 DEA；死叉 = DIF 下穿 DEA。
 *
 * 执行口径（禁止未来函数）：
 *   信号在「交易日 j-1 收盘」由 DIF/DEA 交叉确认（signalDate=close of j-1）；
 *   对应成交在「下一交易日 j 开盘」执行（execDate=open of j）。
 *   信号日与成交日严格分离：观众不会误以为交叉出现的那一刻已按该价成交。
 *   起始空仓；持仓期间保留现金；单一批次（买入一次、卖出一次，不补仓/不部分卖出）。
 * ==========================================================================*/
'use strict';
const { tradeFee, dividendTax, affordableShares, r2 } = require('./stock_cost.cjs');
const { assertSupportedOptions } = require('./support_guard.cjs');

const EPS = 1e-9;

/* =========================== VERBATIM COPY ============================ */
/* 以下函数逐字复制自 lib/stock_core.cjs（stock_core.cjs 未导出，故复制以保证
 * 分红/涨跌停/持股天数口径与已封版内核完全一致）。复制段不构成对 stock_core.cjs
 * 的修改；若未来 stock_core.cjs 更新，需同步此处。 */
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
/* ========================= END VERBATIM COPY ========================== */

/* ----------------------------- MACD 指标 ------------------------------ */
/**
 * 计算 MACD（标准定义，EMA 用前 p 日 SMA 作种子）。
 * @param {number[]} closes 连续交易日收盘价（不含停牌日；停牌日由调用方跳过）
 * @param {{fast?:number, slow?:number, signal?:number}} params 默认 12/26/9
 * @returns {{dif:Array<number|null>, dea:Array<number|null>, hist:Array<number|null>,
 *            crosses:Array<'none'|'golden'|'death'|null>, readyFrom:number}}
 *   dif/dea/hist 预热期（含种子期）为 null；crosses[i] 仅当 dif[i]、dea[i] 均非 null 且 i>=1 时有意义。
 */
function computeMacd(closes, params) {
  const fast = (params && params.fast) || 12;
  const slow = (params && params.slow) || 26;
  const signal = (params && params.signal) || 9;
  const n = closes.length;
  const kF = 2 / (fast + 1), kS = 2 / (slow + 1), kD = 2 / (signal + 1);
  const mean = (arr, from, to) => {
    let s = 0; for (let i = from; i <= to; i++) s += arr[i]; return s / (to - from + 1);
  };

  const emaFast = new Array(n).fill(null);
  const emaSlow = new Array(n).fill(null);
  const dif = new Array(n).fill(null);
  const dea = new Array(n).fill(null);
  const hist = new Array(n).fill(null);

  if (n >= fast) {
    emaFast[fast - 1] = mean(closes, 0, fast - 1);
    for (let i = fast; i < n; i++) emaFast[i] = closes[i] * kF + emaFast[i - 1] * (1 - kF);
  }
  if (n >= slow) {
    emaSlow[slow - 1] = mean(closes, 0, slow - 1);
    for (let i = slow; i < n; i++) emaSlow[i] = closes[i] * kS + emaSlow[i - 1] * (1 - kS);
  }
  const difStart = slow - 1;
  for (let i = difStart; i < n; i++) dif[i] = emaFast[i] - emaSlow[i];

  const deaStart = difStart + (signal - 1);
  if (n > deaStart) {
    dea[deaStart] = mean(dif, difStart, deaStart);
    for (let i = deaStart + 1; i < n; i++) dea[i] = dif[i] * kD + dea[i - 1] * (1 - kD);
  }
  for (let i = deaStart; i < n; i++) hist[i] = dif[i] - dea[i];

  const crosses = new Array(n).fill(null);
  for (let i = deaStart + 1; i < n; i++) {
    const a = dif[i - 1], b = dea[i - 1], c = dif[i], e = dea[i];
    if (a === null || b === null || c === null || e === null) { crosses[i] = 'none'; continue; }
    if (a <= b && c > e) crosses[i] = 'golden';
    else if (a >= b && c < e) crosses[i] = 'death';
    else crosses[i] = 'none';
  }
  return { dif, dea, hist, crosses, readyFrom: deaStart };
}

/** 单点交叉判定（供测试与外部复用） */
function macdCrossAt(dif, dea, i) {
  if (i < 1) return 'none';
  const a = dif[i - 1], b = dea[i - 1], c = dif[i], e = dea[i];
  if (a === null || b === null || c === null || e === null) return 'none';
  if (a <= b && c > e) return 'golden';
  if (a >= b && c < e) return 'death';
  return 'none';
}

/* --------------------------- MACD 策略运行 ---------------------------- */
/**
 * 运行「MACD 金叉买入 / 死叉卖出」策略。
 * @param {Array} days buildTimeline 产出的时间轴（含停牌日）
 * @param {object} opts { lot, initialCapital, schedule, parValue, tradingDaysPerYear,
 *                         macd?:{fast,slow,signal}, blockSealed?:boolean }
 * @returns {{daily, trades, signals, events, entitlements, summary}}
 */
function runMacdStock(days, opts) {
  assertSupportedOptions(opts, 'runMacdStock');
  const { lot, initialCapital, schedule, parValue, tradingDaysPerYear } = opts;
  const macdP = Object.assign({ fast: 12, slow: 26, signal: 9 }, opts.macd || {});
  const blockSealed = opts.blockSealed !== false;

  const tradable = days.filter(d => !d.suspended);
  if (tradable.length < 2) throw new Error('E_NO_DATA: 可交易日不足 2 天');

  const m = computeMacd(tradable.map(d => d.close), macdP);
  if (tradable.length <= m.readyFrom) throw new Error('E_NO_DATA: 可交易日不足 MACD 预热所需（需 > ' + m.readyFrom + ' 天）');

  /* orders[j] = 在交易日 j 开盘执行的操作，由交易日 j-1 收盘的交叉确认得出（次日开盘成交） */
  const orders = new Array(tradable.length).fill(null);
  for (let j = 1; j < tradable.length; j++) {
    const c = m.crosses[j - 1];
    if (c === 'golden') orders[j] = 'BUY';
    else if (c === 'death') orders[j] = 'SELL';
  }
  const tIdxByDate = new Map(tradable.map((d, i) => [d.date, i]));
  const lastTradableDate = tradable[tradable.length - 1].date;

  const st = {
    cash: initialCapital, shares: 0, lotOpenDate: null, lastClose: null,
    divReceivable: 0, divTaxBase: 0, oddLotDropped: 0, events: [], entitlements: []
  };
  const daily = [], trades = [], signals = [];
  let seq = 0, fees = { commission: 0, stampDuty: 0, transferFee: 0 };
  let divTaxTotal = 0, divGrossTotal = 0, divPaidTotal = 0;
  let peak = initialCapital, peakDate = tradable[0].date, maxDD = 0;
  let pendingSell = false, pendingSellSince = null;
  let blockedSellCount = 0, blockedBuyCount = 0, touchCount = 0;
  let insufficientCashCount = 0, lastBuyDate = null, lastSellDate = null;
  let deferredSellDays = 0;

  for (const d of days) {
    const row = emptyRow(d);

    /* 分红三段式（停牌日同样处理） */
    recognizeExDate(d, st, row);
    settlePayDate(d, st, row);
    applyShareDividend(d, st, row);

    if (d.suspended) {
      row.mark = st.lastClose;
      if (st.shares > 0) {
        row.note = '停牌：原定开盘卖出顺延至下一有行情交易日';
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

    const j = tIdxByDate.get(d.date);

    /* —— 开盘成交阶段（信号来自上一交易日收盘，禁止未来函数）—— */
    if (j !== undefined) {
      /* 优先重试被封板阻挡的卖出（必须退出） */
      if (pendingSell && st.shares > 0) {
        const sealed = sealedSide(d);
        if (blockSealed && sealed === 'DOWN') {
          /* 仍封死跌停，继续顺延 */
        } else {
          executeSell(d, '顺延卖出（原定 ' + pendingSellSince + ' 开盘）');
          pendingSell = false; pendingSellSince = null;
        }
      }
      /* 再处理当日信号订单（仅在该订单与当前持仓不冲突时生效） */
      const ord = orders[j];
      if (ord === 'BUY' && st.shares === 0) {
        const sealed = sealedSide(d);
        if (blockSealed && sealed === 'UP') {
          blockedBuyCount++;
          row.flags.push('BUY_BLOCKED');
          row.note = '一字涨停（开=高=低=收=涨停价），开盘无法买入，现金保留';
        } else {
          executeBuy(d);
        }
      } else if (ord === 'SELL' && st.shares > 0) {
        const sealed = sealedSide(d);
        if (blockSealed && sealed === 'DOWN') {
          blockedSellCount++;
          pendingSell = true;
          if (!pendingSellSince) pendingSellSince = d.date;
          row.flags.push('SELL_BLOCKED');
          row.note = '一字跌停（开=高=低=收=跌停价），开盘无法卖出，持仓保留、资金未到账';
        } else {
          executeSell(d, '死叉卖出');
        }
      }
      /* 信号事件记录（无论是否实际成交，均留痕信号日/成交日/价） */
      if (ord) {
        const ci = j - 1;
        const executed = (ord === 'BUY' && st.shares > 0 && lastBuyDate === d.date) ||
                         (ord === 'SELL' && st.shares === 0 && lastSellDate === d.date);
        const blocked = row.flags.includes('BUY_BLOCKED') || row.flags.includes('SELL_BLOCKED');
        signals.push({
          signalDate: tradable[ci].date, signalClose: +tradable[ci].close.toFixed(4),
          type: ord === 'BUY' ? 'GOLDEN' : 'DEATH',
          dif: m.dif[ci] === null ? null : +m.dif[ci].toFixed(6),
          dea: m.dea[ci] === null ? null : +m.dea[ci].toFixed(6),
          hist: m.hist[ci] === null ? null : +m.hist[ci].toFixed(6),
          execDate: d.date, execPrice: +d.open.toFixed(4),
          executed: !!executed, blocked: !!blocked,
          note: blocked ? '当日封板无法成交，信号已记录但本笔未执行' : (executed ? '' : '信号出现但持仓状态不允许（如已持仓的金叉/已空仓的死叉）')
        });
      }
    }

    /* —— 收盘阶段：股权登记日确认权益 —— */
    recordEntitlement(d, st, row);
    divGrossTotal += row.grossDividend;
    divPaidTotal += row.dividendPaid;

    /* —— 日终估值 —— */
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

    /* —— 本地成交辅助 —— */
    function executeBuy(day) {
      const n = affordableShares(st.cash, day.open, lot, day.date, parValue, schedule);
      if (n > 0) {
        const amount = n * day.open;
        const f = tradeFee({ date: day.date, side: 'buy', amount, shares: n, price: day.open, parValue, schedule });
        const cashBefore = st.cash;
        st.cash = r2(st.cash - amount - f.total);
        fees.commission += f.commission; fees.stampDuty += f.stampDuty; fees.transferFee += f.transferFee;
        st.shares = n; st.lotOpenDate = day.date;
        seq++;
        trades.push({
          seq, side: 'BUY', date: day.date, price: +day.open.toFixed(4), shares: n,
          amount: r2(amount), commission: f.commission, stampDuty: f.stampDuty, transferFee: f.transferFee,
          fee: f.total, dividendTax: 0, divTaxRate: 0, holdingDays: 0, divTaxBase: 0,
          signalType: 'GOLDEN', signalDate: tIdxByDate.has(day.date) ? tradable[tIdxByDate.get(day.date) - 1].date : null,
          cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: n,
          rates: f.rates, note: '金叉次日开盘买入'
        });
        row.actions.push('BUY'); row.fee += f.total; lastBuyDate = day.date;
      } else {
        insufficientCashCount++;
        row.note = row.note ? row.note : `现金不足以买入 1 手（${lot} 股）`;
        row.flags.push('INSUFFICIENT_CASH');
      }
    }
    function executeSell(day, why) {
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
        signalType: 'DEATH', signalDate: tIdxByDate.has(day.date) ? tradable[tIdxByDate.get(day.date) - 1].date : null,
        cashBefore: r2(cashBefore), cashAfter: r2(st.cash), sharesAfter: 0,
        rates: f.rates, note
      });
      row.actions.push('SELL'); row.fee += f.total; row.dividendTax += dt.tax;
      lastSellDate = day.date;
      st.divTaxBase = 0; st.lotOpenDate = null;
    }
  }

  const last = daily[daily.length - 1];
  const final = last.asset;
  const totalFees = r2(fees.commission + fees.stampDuty + fees.transferFee);
  const unsettled = st.entitlements.filter(e => !e.paid);
  return {
    daily, trades, signals, events: st.events, entitlements: st.entitlements,
    macd: m,
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
      goldenCount: signals.filter(s => s.type === 'GOLDEN').length,
      deathCount: signals.filter(s => s.type === 'DEATH').length,
      macdParams: { fast: macdP.fast, slow: macdP.slow, signal: macdP.signal, readyFrom: m.readyFrom },
      composition: {
        cash: r2(st.cash), shares: st.shares, holdingValue: r2(st.shares * last.mark),
        receivable: r2(st.divReceivable), pendingTax: r2(st.divTaxBase),
        note: '期末总资产 = 现金 + 持仓市值 + 应收股息；期末仍持仓则计入未平仓标识'
      }
    }
  };
}

module.exports = { computeMacd, macdCrossAt, runMacdStock, daysBetween, sealedSide, touchedLimit };
