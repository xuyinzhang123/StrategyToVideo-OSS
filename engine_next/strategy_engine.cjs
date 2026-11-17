/* ============================================================================
 * 策略引擎（契约草案，不接 web、不改 V0.2 出片链）
 *
 * 目标：把「策略卡」（docs/STRATEGY_SPEC.md）翻译成统一回测结果 backtest_result.json。
 * 关键设计：**不重写任何资金/费用/税口径**，全部复用 engine_next/lib 的纯函数：
 *   - buildSchedule / zeroCostConfig / r2        （stock_cost.cjs）
 *   - buildTimeline / runHoldStock / runOvernightStock（stock_core.cjs）
 *   - runMacdStock / computeMacd                 （stock_macd_core.cjs）
 *   - assertSupportedSymbol / assertSupportedActions（support_guard.cjs）
 *
 * 两个模板：
 *   - macd_cross          -> runMacdStock（金叉买/死叉卖，次日开盘成交；V0.2 回归基线）
 *   - close_buy_open_sell -> runOvernightStock（收盘买/次日开盘卖；用户主线策略骨架）
 *
 * 本文件无顶层 I/O、无 process.exit，可作为库 require；CLI 在文件尾 main()。
 * 用法：node engine_next/strategy_engine.cjs --card <策略卡.json> --bars <bars.json> \
 *           [--actions <actions.json>] [--config <config.json>] [--out <结果.json>]
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildSchedule, r2 } = require('./lib/stock_cost.cjs');
const { buildTimeline, runHoldStock } = require('./lib/stock_core.cjs');
const { runMacdStock } = require('./lib/stock_macd_core.cjs');
const { runStrategyRunner } = require('./strategy_runner.cjs');
const { assertSupportedSymbol, assertSupportedActions, UnsupportedError } = require('./lib/support_guard.cjs');

const ENGINE_VERSION = '0.1.0';
const SCHEMA_VERSION = '1.0';
const ROOT = path.dirname(__dirname);
const DEFAULT_CONFIG = path.join(ROOT, 'engine_next', 'config.stock_macd.json');

class StrategyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, msg) => { throw new StrategyError(code, msg); };

/* --------------------------- 策略卡校验 --------------------------- */
function validateCard(card) {
  if (!card || typeof card !== 'object') fail('E_CARD', '策略卡必须是对象');
  if (card.schemaVersion !== SCHEMA_VERSION) fail('E_SCHEMA_VERSION', `schemaVersion 必须为 ${SCHEMA_VERSION}`);
  if (!['macd_cross', 'close_buy_open_sell'].includes(card.id)) fail('E_STRATEGY_UNKNOWN', `未知策略 id：${card.id}`);
  if (!/^[0-9]{6}$/.test(String(card.symbol || ''))) fail('E_SYMBOL', 'symbol 必须是 6 位代码');
  if (!card.range || !/^\d{4}-\d{2}-\d{2}$/.test(card.range.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(card.range.end || ''))
    fail('E_RANGE', 'range.start / range.end 必须是 YYYY-MM-DD');
  if (card.range.start > card.range.end) fail('E_RANGE_ORDER', 'range.start 不能晚于 range.end');
  const d = card.data || {};
  if (d.adjust !== 'none') fail('E_ADJUST_UNVERIFIED', `本版只接受 adjust=none（G-6），收到 ${d.adjust}`);
  if (d.dividendPolicy && !['provided', 'ignored'].includes(d.dividendPolicy))
    fail('E_DIV_POLICY', `dividendPolicy 只能是 provided / ignored，收到 ${d.dividendPolicy}`);
  if (card.execution && card.execution.lotSize && card.execution.lotSize !== 100)
    fail('E_LOT', 'lotSize 当前只支持 100');
  if (card.id === 'close_buy_open_sell') {
    const p = card.params || {};
    if (p.entrySignal && !['macd_golden', 'always', 'none'].includes(p.entrySignal))
      fail('E_ENTRY_SIGNAL', `entrySignal 只能是 macd_golden / always / none，收到 ${p.entrySignal}`);
    if (p.entryFill && p.entryFill !== 'sameClose')
      fail('E_ENTRY_FILL', `close_buy_open_sell 只支持 entryFill=sameClose，收到 ${p.entryFill}`);
    if (p.exitFill && p.exitFill !== 'nextOpen')
      fail('E_EXIT_FILL', `close_buy_open_sell 只支持 exitFill=nextOpen，收到 ${p.exitFill}`);
    if (p.auctionFilter) {
      const af = p.auctionFilter;
      if (af.basis !== 'open_gap_pct' || typeof af.holdIfGte !== 'number')
        fail('E_AUCTION_FILTER', 'auctionFilter 需 {basis:"open_gap_pct", holdIfGte:number}');
      if (af.else && af.else !== 'sellAtOpen')
        fail('E_AUCTION_ELSE', 'auctionFilter.else 当前只支持 sellAtOpen');
    }
  }
  return card;
}

function templates(card) {
  if (card.id === 'macd_cross') {
    const p = card.params || {};
    return {
      readyFrom: (p.slow || 26) - 1 + (p.signal || 9) - 1,
      defaultWarmup: 60,
      execFill: 'nextOpen'
    };
  }
  // close_buy_open_sell：入场为 MACD 金叉时，预热至少覆盖 slow+signal；always 入场则无需预热
  const p = card.params || {};
  const entrySignal = p.entrySignal || 'always';
  const needMacd = entrySignal === 'macd_golden';
  return {
    readyFrom: needMacd ? (p.slow || 26) - 1 + (p.signal || 9) - 1 : 0,
    defaultWarmup: needMacd ? (p.slow || 26) + (p.signal || 9) : 0,
    execFill: 'close_buy_open_sell',
    entrySignal
  };
}

/* --------------------------- 输入准备 --------------------------- */
function prepareInput(card, input, cfg) {
  const bars = input.bars || [];
  if (!bars.length) fail('E_NO_DATA', 'bars 为空');
  if (bars[0].date > card.range.start) fail('E_NO_WARMUP', `bars 起点 ${bars[0].date} 晚于展示起点 ${card.range.start}，无法取预热段`);
  if (bars[bars.length - 1].date < card.range.end) fail('E_NO_END', `bars 终点 ${bars[bars.length - 1].date} 早于展示终点 ${card.range.end}`);
  if (bars[0].date < '2015-08-01') fail('E_DATE_BEFORE_COST_RULES', '起点早于 2015-08-01，费用规则缺失');

  let actions = input.actions || [];
  if (card.data.dividendPolicy === 'ignored') actions = [];
  // payDate 是 buildTimeline 的硬要求；缺失直接拒绝，不猜测。
  for (const a of actions) {
    if (!a.date || !a.recordDate || !a.payDate || typeof a.cashPerShare !== 'number')
      fail('E_DIV_INCOMPLETE', `分红事件三段式不完整：${JSON.stringify(a)}`);
  }
  const symbol = card.symbol;
  const name = card.nameOfSecurity || symbol;
  const board = String(symbol).startsWith('6') ? 'SH_MAIN' : 'SZ_MAIN';
  assertSupportedSymbol({ code: symbol, name, board }, card.id);
  assertSupportedActions(actions, card.id);

  const calendar = bars.map(b => b.date).sort();
  if (new Set(calendar).size !== calendar.length) fail('E_DUP_DATE', 'bars 存在重复日期');
  return { bars: bars.slice().sort((a, b) => a.date.localeCompare(b.date)), calendar, actions };
}

/* --------------------------- 结果归一化 --------------------------- */
function normalizeSignals(raw, tpl) {
  return (raw.signals || []).map(s => ({
    date: s.signalDate || s.date,
    type: s.type,
    indicators: (s.dif !== undefined) ? { dif: s.dif, dea: s.dea, hist: s.hist } : undefined,
    execDate: s.execDate,
    execPrice: s.execPrice,
    executed: !!s.executed,
    blocked: !!s.blocked,
    note: s.note || ''
  }));
}

function normalizeTrades(raw) {
  return (raw.trades || []).map((t, i) => ({
    seq: t.seq != null ? t.seq : i + 1,
    side: t.side,
    date: t.date,
    price: t.price,
    shares: t.shares,
    amount: t.amount,
    fee: t.fee,
    feeBreakdown: {
      commission: t.commission != null ? t.commission : 0,
      stampDuty: t.stampDuty != null ? t.stampDuty : 0,
      transferFee: t.transferFee != null ? t.transferFee : 0
    },
    dividendTax: t.dividendTax || 0,
    holdingDays: t.holdingDays != null ? t.holdingDays : null,
    signalType: t.signalType || null,
    signalDate: t.signalDate || null
  }));
}

function normalizeEquity(daily, initialCapital) {
  let peak = initialCapital;
  return daily.map(d => {
    peak = Math.max(peak, d.asset);
    return {
      date: d.date,
      cash: d.cash,
      shares: d.shares,
      holdingValue: d.holdingValue != null ? d.holdingValue : 0,
      divReceivable: d.divReceivable || 0,
      asset: d.asset,
      drawdown: peak ? +(1 - d.asset / peak).toFixed(6) : 0,
      flags: Array.isArray(d.flags) ? d.flags.slice() : []
    };
  });
}

function normalizeDecisions(raw, card, tpl) {
  if (card.id === 'close_buy_open_sell') {
    return raw.trades.map(t => ({
      date: t.date,
      kind: t.side === 'BUY' ? 'ENTRY' : 'EXIT',
      reason: t.side === 'BUY' ? 'close_buy' : 'next_open_sell',
      openGapPct: null,
      action: t.side === 'BUY' ? 'BUY_AT_CLOSE' : 'SELL_AT_OPEN'
    }));
  }
  return (raw.signals || []).map(s => ({
    date: s.signalDate || s.date,
    kind: s.type === 'GOLDEN' ? 'ENTRY' : 'EXIT',
    reason: s.type === 'GOLDEN' ? 'macd_golden_cross' : 'macd_death_cross',
    openGapPct: null,
    action: s.type === 'GOLDEN' ? 'BUY_NEXT_OPEN' : 'SELL_NEXT_OPEN'
  }));
}

function sha256Of(obj) {
  // 约定：计算前先把 resultSha256 置空，保证「同一结果反复计算得到同一哈希」。
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone && clone.reproducibility) clone.reproducibility.resultSha256 = null;
  return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex');
}

/* --------------------------- 主入口 --------------------------- */
function runStrategy(card, input, cfg) {
  validateCard(card);
  cfg = cfg || JSON.parse(fs.readFileSync(DEFAULT_CONFIG, 'utf8'));
  const tpl = templates(card);
  const prepared = prepareInput(card, input, cfg);

  const schedule = buildSchedule(cfg);
  const baseOpts = {
    lot: (card.execution && card.execution.lotSize) || cfg.backtest.lotSize,
    initialCapital: (card.execution && card.execution.initialCapital) || cfg.backtest.initialCapital,
    parValue: cfg.data.symbol.parValue,
    tradingDaysPerYear: cfg.backtest.tradingDaysPerYear,
    schedule,
    blockSealed: card.execution ? card.execution.sealedLimitBlocks !== false : true
  };

  const days = buildTimeline({
    calendar: prepared.calendar,
    bars: prepared.bars,
    actions: prepared.actions,
    priceLimitPct: cfg.support.priceLimitPct
  });

  let raw;
  if (card.id === 'macd_cross') {
    const p = card.params || {};
    raw = runMacdStock(days, Object.assign({}, baseOpts, {
      macd: { fast: p.fast || 12, slow: p.slow || 26, signal: p.signal || 9 }
    }));
  } else {
    // close_buy_open_sell：走独立 runner（预热切分 / 入场信号 / 9:25 跳空过滤）。
    const p = card.params || {};
    raw = runStrategyRunner(days, Object.assign({}, baseOpts, {
      tradeFrom: card.range.start,
      entrySignal: p.entrySignal || 'always',
      macd: { fast: p.fast || 12, slow: p.slow || 26, signal: p.signal || 9 },
      auctionFilter: p.auctionFilter || null
    }));
  }

  const hold = runHoldStock(days, baseOpts);
  const summary = raw.summary;
  const warnings = [];
  if (card.data.dividendPolicy !== 'provided') warnings.push('W_NO_DIVIDENDS');
  if (card.id === 'close_buy_open_sell')
    warnings.push('W_STRATEGY_INDEPENDENT: 本策略为新增模板，独立验收，不套用 MACD 41 项');

  const state = {
    start: card.range.start,
    end: card.range.end,
    bars: prepared.bars.length,
    warmupBars: card.range.warmupBars != null ? card.range.warmupBars : tpl.defaultWarmup,
    readyFrom: tpl.readyFrom,
    warnings
  };
  if (card.id === 'close_buy_open_sell') {
    const p = card.params || {};
    state.fillAssumption = { entry: 'sameClose', exit: 'nextOpen' };
    state.entrySignal = p.entrySignal || 'always';
    state.auctionFilter = p.auctionFilter ? Object.assign({}, p.auctionFilter, { executed: true }) : null;
    state.warmupExec = {
      mode: 'prepend-no-trade',
      displayTradableDays: summary.displayTradableDays,
      warmupTradableDays: summary.warmupTradableDays
    };
  }

  const result = {
    schemaVersion: SCHEMA_VERSION,
    strategy: JSON.parse(JSON.stringify(card)),
    state,
    signals: normalizeSignals(raw, tpl),
    trades: normalizeTrades(raw),
    equity: normalizeEquity(raw.daily, baseOpts.initialCapital),
    decisions: (card.id === 'close_buy_open_sell' && Array.isArray(raw.decisions) && raw.decisions.length)
      ? raw.decisions.map(d => Object.assign({}, d)) : normalizeDecisions(raw, card, tpl),
    metrics: {
      final: summary.final,
      totalReturn: summary.totalReturn,
      cagr: summary.cagr,
      maxDD: summary.maxDD,
      tradeCount: summary.tradeCount,
      goldenCount: summary.goldenCount != null ? summary.goldenCount : 0,
      deathCount: summary.deathCount != null ? summary.deathCount : 0,
      totalFees: summary.totalFees,
      totalDividendTax: summary.totalDividendTax,
      feeBreakdown: summary.feeBreakdown,
      benchmark: { id: 'hold', final: hold.summary.final },
      ...(card.id === 'close_buy_open_sell' ? {
        entrySignal: summary.entrySignal,
        auction: {
          enabled: !!summary.auctionFilter,
          config: summary.auctionFilter,
          holdDays: summary.auctionHoldDays,
          gapsEvaluated: summary.gapsEvaluated,
          maxGap: summary.maxGap,
          minGap: summary.minGap
        }
      } : {})
    },
    reproducibility: { engineVersion: ENGINE_VERSION, resultSha256: null }
  };
  result.reproducibility.resultSha256 = sha256Of(result);
  return result;
}

/* --------------------------- CLI --------------------------- */
function main(argv) {
  const args = {};
  argv.slice(2).forEach((a, i, arr) => {
    if (a.startsWith('--')) args[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
  });
  if (!args.card || !args.bars) {
    console.error('用法：node engine_next/strategy_engine.cjs --card <策略卡.json> --bars <bars.json> [--actions <actions.json>] [--out <结果.json>]');
    return 2;
  }
  try {
    const card = JSON.parse(fs.readFileSync(args.card, 'utf8'));
    const input = { bars: JSON.parse(fs.readFileSync(args.bars, 'utf8')) };
    if (args.actions) input.actions = JSON.parse(fs.readFileSync(args.actions, 'utf8'));
    const cfg = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : undefined;
    const result = runStrategy(card, input, cfg);
    const text = JSON.stringify(result, null, 2) + '\n';
    if (args.out) {
      fs.writeFileSync(args.out, text, 'utf8');
      console.log(`已生成 ${args.out}（${result.state.bars} 根，final=${result.metrics.final}）`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  } catch (e) {
    const code = e.code || e.name || 'E_UNKNOWN';
    console.error(`${code}: ${e.message}`);
    return 1;
  }
}

module.exports = { runStrategy, validateCard, ENGINE_VERSION, StrategyError, sha256Of };
if (require.main === module) process.exit(main(process.argv));
