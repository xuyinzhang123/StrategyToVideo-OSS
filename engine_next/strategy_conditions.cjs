/* ============================================================================
 * 组合策略条件模块（V0.3 阶段一）
 * ---------------------------------------------------------------------------
 * 纯函数：只根据已收盘日线计算信号，不读文件、不联网、不触碰资金状态。
 * 四个组件：maCross（入场/退出）、breakout（入场）、
 *           fixedHolding（退出）、returnThreshold（退出）。
 * 所有信号在收盘后确认，成交由 runner 在下一交易日开盘执行。
 * breakout 的回看窗口严格排除当前交易日，禁止未来函数。
 * ==========================================================================*/
'use strict';

const ENTRY_TYPES = ['maCross', 'breakout'];
const EXIT_TYPES = ['maCross', 'fixedHolding', 'returnThreshold'];

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * @param {Array} tradable 仅非停牌日，按日期升序（含预热段）
 * @param {object} composition {entry:{type,params}, exits:[{type,params}]}
 * @returns {{byDate:Map, warmupRequired:number}}
 *   byDate: date -> { entry:{type,reason}|null, exits:[{type,reason}] }
 */
function buildConditions(tradable, composition) {
  if (!composition || typeof composition !== 'object') throw new Error('E_COMPOSITION: 缺少 composition');
  if (!ENTRY_TYPES.includes(composition.entry && composition.entry.type))
    throw new Error('E_COMPOSITION_ENTRY: entry.type 只能是 ' + ENTRY_TYPES.join(' / '));
  if (!Array.isArray(composition.exits) || composition.exits.length < 1 || composition.exits.length > 3)
    throw new Error('E_COMPOSITION_EXITS: exits 需为 1~3 个退出条件');
  for (const e of composition.exits) {
    if (!EXIT_TYPES.includes(e.type)) throw new Error('E_COMPOSITION_EXIT: 未知退出条件 ' + e.type);
  }
  // 同类型最多出现一次，保证 reasons 顺序确定
  const seen = new Set();
  for (const e of composition.exits) {
    if (seen.has(e.type)) throw new Error('E_COMPOSITION_DUP: 退出条件重复 ' + e.type);
    seen.add(e.type);
  }

  const ep = composition.entry.params || {};
  const fastN = ep.fast == null ? 5 : ep.fast;
  const slowN = ep.slow == null ? 20 : ep.slow;
  const lookback = ep.lookback == null ? 20 : ep.lookback;
  if (!Number.isInteger(fastN) || fastN < 2 || !Number.isInteger(slowN) || slowN < 3 || fastN >= slowN)
    throw new Error('E_MA_PARAMS: maCross 需整数 fast>=2、slow>=3 且 fast<slow');
  if (!Number.isInteger(lookback) || lookback < 2)
    throw new Error('E_BREAKOUT_PARAMS: breakout.lookback 需为 >=2 的整数');

  const closes = tradable.map(d => d.close);
  const fast = sma(closes, fastN);
  const slow = sma(closes, slowN);
  const byDate = new Map();
  const exitCfg = new Map(composition.exits.map(e => [e.type, e.params || {}]));

  // maCross 退出用同一组均线参数（如 entry 不是 maCross，则用默认 5/20）
  const exitMa = exitCfg.has('maCross');
  const hp = exitCfg.get('fixedHolding') || {};
  const holdDays = hp.days == null ? 5 : hp.days;
  if (exitCfg.has('fixedHolding') && (!Number.isInteger(holdDays) || holdDays < 1))
    throw new Error('E_HOLD_DAYS: fixedHolding.days 需为正整数');
  const tpCfg = exitCfg.get('returnThreshold') || {};
  const tp = tpCfg.takeProfit === null ? null : (tpCfg.takeProfit == null ? 0.10 : tpCfg.takeProfit);
  const sl = tpCfg.stopLoss === null ? null : (tpCfg.stopLoss == null ? 0.05 : tpCfg.stopLoss);
  if (exitCfg.has('returnThreshold')) {
    if (tp === null && sl === null) throw new Error('E_TPSL_ALL_OFF: 止盈止损不可同时关闭');
    for (const [k, v] of [['takeProfit', tp], ['stopLoss', sl]]) {
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= 1))
        throw new Error('E_TPSL_PARAMS: ' + k + ' 需在 (0,1) 或为 null');
    }
  }

  for (let i = 0; i < tradable.length; i++) {
    const d = tradable[i];
    const rec = { entry: null, exits: [], ma: null, priorHigh: null };
    if (fast[i] !== null && slow[i] !== null) {
      rec.ma = { fast: +fast[i].toFixed(6), slow: +slow[i].toFixed(6) };
      const golden = i > 0 && fast[i - 1] !== null && slow[i - 1] !== null &&
        fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
      const death = i > 0 && fast[i - 1] !== null && slow[i - 1] !== null &&
        fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
      if (composition.entry.type === 'maCross' && golden)
        rec.entry = { type: 'maCross', reason: 'maCross_golden_sameClose' };
      if (exitMa && death)
        rec.exits.push({ type: 'maCross', reason: 'maCross_death_sameClose' });
    }
    if (composition.entry.type === 'breakout' && i >= lookback) {
      // 严格排除当日：窗口 [i-lookback, i-1]
      let hi = -Infinity;
      for (let k = i - lookback; k < i; k++) hi = Math.max(hi, tradable[k].high);
      rec.priorHigh = +hi.toFixed(4);
      if (d.close > hi)
        rec.entry = { type: 'breakout', reason: 'breakout_close_gt_prior_' + lookback + '_high' };
    }
    byDate.set(d.date, rec);
  }

  return {
    byDate,
    warmupRequired: composition.entry.type === 'breakout' ? lookback + 1 : slowN + 1,
    config: {
      entry: { type: composition.entry.type, params: { fast: fastN, slow: slowN, maType: ep.maType || 'SMA', lookback } },
      exits: composition.exits.map(e => ({
        type: e.type,
        params: e.type === 'fixedHolding' ? { days: holdDays }
          : e.type === 'returnThreshold' ? { takeProfit: tp, stopLoss: sl }
            : { fast: fastN, slow: slowN, maType: ep.maType || 'SMA' }
      })),
      reasonOrder: composition.exits.map(e => e.type)
    },
    exitRule: { holdDays, takeProfit: tp, stopLoss: sl, exitMa }
  };
}

module.exports = { ENTRY_TYPES, EXIT_TYPES, sma, buildConditions };

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
