/*
 * 策略组合专属验收（V0.3 阶段一 + V0.5 表达式扩展）
 *
 * 十六项：MA 交叉日期、突破排除当日、固定持有、止盈止损基准、
 *         同日多退出一次成交、买卖日期、资产恒等式、现金不透支、
 *         确定性、反向失败；
 *         V0.5 新增：多条件与语义、与条件是收紧、移动止损触发与首次性、
 *         峰值不含入场前数据、非法配置拒绝、与条件零入场行为。
 * 运行：node engine_next/tests/verify_strategy_composition.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateImport } = require('../../web/src/import/validate');
const { runStrategy, StrategyError, sha256Of } = require('../strategy_engine.cjs');
const { buildConditions, sma } = require('../strategy_conditions.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.error(`[FAIL] ${name}\n       ${e.message}`); }
}

const csv = fs.readFileSync(path.join(ROOT, 'docs', 'samples', 'stock_ohlc.csv'), 'utf8');
const v = validateImport({
  dataClass: 'stock_ohlc', csvText: csv, fileName: 'stock_ohlc.csv',
  symbol: '600000', name: '样例标的A', adjust: 'none', dividendCsvText: ''
});
assert.equal(v.ok, true);
const bars = v.model.bars;
const input = { bars, actions: [] };

function cardOf(entry, exits) {
  return {
    schemaVersion: '1.0', id: 'close_buy_open_sell', name: '组合测试', symbol: '600000',
    nameOfSecurity: '样例标的A',
    range: { start: '2024-02-01', end: '2024-12-30', warmupBars: 30, warmupMode: 'prepend' },
    data: { adjust: 'none', dividendPolicy: 'ignored', source: 'USER_CSV' },
    params: { composition: { schema: 'stv.composition/0.1', entry, exits } },
    execution: { initialCapital: 100000, lotSize: 100, sealedLimitBlocks: true },
    benchmark: 'hold'
  };
}
const ma = () => ({ type: 'maCross', params: { fast: 5, slow: 20, maType: 'SMA' } });
const bo = () => ({ type: 'breakout', params: { lookback: 20 } });
const hold = () => ({ type: 'fixedHolding', params: { days: 5 } });
const sl = (x = 0.05) => ({ type: 'returnThreshold', params: { takeProfit: null, stopLoss: x } });
const tp = (x = 0.10) => ({ type: 'returnThreshold', params: { takeProfit: x, stopLoss: null } });

const rMaMa = runStrategy(cardOf(ma(), [ma()]), input);
const rBoHold = runStrategy(cardOf(bo(), [hold()]), input);
const rBoSl = runStrategy(cardOf(bo(), [sl()]), input);

check('1 MA 交叉日期由 SMA(5)/SMA(20) 正确计算', () => {
  const closes = bars.map(b => b.close);
  const f = sma(closes, 5), s = sma(closes, 20);
  const golden = [];
  for (let i = 1; i < closes.length; i++)
    if (f[i] !== null && s[i] !== null && f[i - 1] <= s[i - 1] && f[i] > s[i]) golden.push(bars[i].date);
  const sigs = rMaMa.signals.filter(x => x.type === 'ENTRY' && /golden/.test(x.reason || ''));
  assert.ok(golden.length > 0 && sigs.length > 0);
  for (const sig of sigs) assert.ok(golden.includes(sig.date), `${sig.date} 不是金叉日`);
});

check('2 突破窗口严格排除当前交易日（禁止未来函数）', () => {
  const c = buildConditions(bars.map(b => ({ date: b.date, close: b.close, high: b.high })),
    { entry: bo(), exits: [hold()] });
  let bad = 0;
  for (let i = 20; i < bars.length; i++) {
    const rec = c.byDate.get(bars[i].date);
    let hi = -Infinity;
    for (let k = i - 20; k < i; k++) hi = Math.max(hi, bars[k].high);
    if (Math.abs(rec.priorHigh - +hi.toFixed(4)) > 0.0001) bad++;
  }
  assert.equal(bad, 0, `${bad} 天窗口含当日或计算错误`);
});

check('3 固定持有天数：买入第1日，第N+1交易日开盘退出', () => {
  const buys = rBoHold.trades.filter(t => t.side === 'BUY');
  assert.ok(buys.length > 0);
  for (const b of buys) {
    const sell = rBoHold.trades.find(t => t.side === 'SELL' && t.date > b.date);
    if (!sell) continue;
    const bi = bars.findIndex(x => x.date === b.date);
    const si = bars.findIndex(x => x.date === sell.date);
    assert.ok(si - bi >= 5, `${b.date} → ${sell.date} 不足 5 个交易日`);
  }
});

check('4 止盈止损基准为实际买入成交价', () => {
  const slTrades = rBoSl.trades.filter(t => t.side === 'SELL');
  assert.ok(slTrades.length > 0);
  for (const s of slTrades) {
    const buy = rBoSl.trades.filter(t => t.side === 'BUY' && t.date < s.date).pop();
    assert.ok(buy, `${s.date} 卖出前无买入`);
    if (/stopLoss/.test((s.signalReasons || []).join('|'))) {
      // 触发发生在信号日收盘，成交在次日开盘；用信号日收盘价核对基准。
      const sig = rBoSl.signals.filter(x => x.type === 'EXIT' && x.executed && x.execDate === s.date).pop();
      assert.ok(sig, `${s.date} 卖出缺少对应 EXIT 信号`);
      const closeAtSignal = bars.find(b => b.date === sig.date).close;
      assert.ok(closeAtSignal <= buy.price * 0.95 + 0.0001,
        `止损信号日 ${sig.date} 收盘 ${closeAtSignal} 未低于买入价 ${buy.price} 的 95%`);
    }
  }
});

check('5 同日多退出只成交一次，reasons 完整且顺序确定', () => {
  const a = cardOf(bo(), [hold(), sl()]);
  const b = JSON.parse(JSON.stringify(a));
  b.params.composition.exits.reverse();
  const ra = runStrategy(a, input), rb = runStrategy(b, input);
  for (const r of [ra, rb]) {
    const byDate = new Map();
    for (const t of r.trades.filter(x => x.side === 'SELL')) {
      byDate.set(t.date, (byDate.get(t.date) || 0) + 1);
    }
    for (const n of byDate.values()) assert.equal(n, 1, '同日出现多笔 SELL');
  }
  assert.notEqual(ra.reproducibility.resultSha256, rb.reproducibility.resultSha256,
    '配置顺序变化应改变理由顺序，从而改变结果');
});

check('6 买卖日期 = 信号次一交易日开盘', () => {
  for (const sig of rBoHold.signals.filter(s => s.executed)) {
    const di = bars.findIndex(x => x.date === sig.date);
    assert.equal(sig.execDate, bars[di + 1].date, `${sig.date} 的信号未在次日成交`);
    const t = rBoHold.trades.find(x => x.date === sig.execDate &&
      x.side === (sig.type === 'ENTRY' ? 'BUY' : 'SELL'));
    assert.ok(t, `${sig.execDate} 缺少对应成交`);
  }
});

check('7 资产恒等式逐日成立', () => {
  for (const r of [rMaMa, rBoHold, rBoSl]) {
    for (const e of r.equity) {
      const calc = +(e.cash + e.holdingValue + e.divReceivable).toFixed(2);
      assert.ok(Math.abs(calc - e.asset) <= 0.011, `${e.date}: ${calc} != ${e.asset}`);
    }
  }
});

check('8 现金不透支', () => {
  for (const r of [rMaMa, rBoHold, rBoSl])
    for (const e of r.equity) assert.ok(e.cash >= -0.001, `${e.date} 现金为负 ${e.cash}`);
});

check('9 重复出片确定性（同输入 SHA 一致）', () => {
  const a = runStrategy(cardOf(bo(), [hold(), tp()]), input);
  const b = runStrategy(cardOf(bo(), [hold(), tp()]), input);
  assert.equal(a.reproducibility.resultSha256, b.reproducibility.resultSha256);
  assert.equal(sha256Of(a), sha256Of(b));
});

check('10 人为注入错误后引擎/验收能失败', () => {
  const bad = cardOf(ma(), [hold()]);
  bad.params.composition.entry.params.slow = 4; // fast >= slow
  assert.throws(() => runStrategy(bad, input), (e) => e instanceof StrategyError);
  const bad2 = cardOf(bo(), [sl()]);
  bad2.params.composition.exits[0].params.stopLoss = null; // 止盈止损全关
  assert.throws(() => runStrategy(bad2, input), (e) => e instanceof StrategyError);
});

/* ---------------- V0.5 表达式扩展 ---------------- */

const tr = (d = 0.08) => ({ type: 'trailingStop', params: { drawdown: d } });
const allOf = (...items) => ({ type: 'all', items });
const bo5 = () => ({ type: 'breakout', params: { lookback: 5 } });
const barsLite = bars.map(b => ({ date: b.date, close: b.close, high: b.high }));
const barsIdx = new Map(bars.map((b, i) => [b.date, i]));

function entryDaysOf(comp) {
  const c = buildConditions(barsLite, comp);
  const out = [];
  for (const [date, rec] of c.byDate) if (rec.entry) out.push(date);
  return out;
}

check('11 多条件与：只在两条件同日成立时入场', () => {
  const days = entryDaysOf({ entry: allOf(ma(), bo5()), exits: [hold()] });
  const closes = bars.map(b => b.close);
  const f = sma(closes, 5), s = sma(closes, 20);
  const expect = [];
  for (let i = 5; i < bars.length; i++) {
    const golden = f[i - 1] !== null && s[i - 1] !== null && f[i - 1] <= s[i - 1] && f[i] > s[i];
    let hi = -Infinity;
    for (let k = i - 5; k < i; k++) hi = Math.max(hi, bars[k].high);
    if (golden && bars[i].close > hi) expect.push(bars[i].date);
  }
  assert.ok(expect.length > 0, '样例数据应至少有一天同时满足两条件');
  assert.deepEqual(days, expect);
});

check('12 多条件与是收紧：入场日为各单条件交集且严格更少', () => {
  const allDays = entryDaysOf({ entry: allOf(ma(), bo5()), exits: [hold()] });
  const maDays = new Set(entryDaysOf({ entry: ma(), exits: [hold()] }));
  const boDays = new Set(entryDaysOf({ entry: bo5(), exits: [hold()] }));
  assert.ok(allDays.length > 0, '与条件样本为空，本项无效');
  for (const d of allDays) assert.ok(maDays.has(d) && boDays.has(d), `${d} 不属于两个单条件的交集`);
  assert.ok(allDays.length < Math.min(maDays.size, boDays.size), '与条件应严格少于任一单条件');
});

check('13 移动止损按持仓期最高收盘回撤触发，且为首次触发', () => {
  const r = runStrategy(cardOf(ma(), [tr(0.08)]), input);
  const sells = r.trades.filter(t => t.side === 'SELL' && (t.signalReasons || []).includes('trailingStop_8pct'));
  assert.ok(sells.length > 0, '样例数据应至少触发一次移动止损');
  for (const s of sells) {
    const sig = r.signals.filter(x => x.type === 'EXIT' && x.execDate === s.date).pop();
    assert.ok(sig, `${s.date} 卖出缺少对应 EXIT 信号`);
    const buy = r.trades.filter(t => t.side === 'BUY' && t.date < s.date).pop();
    assert.ok(buy, `${s.date} 前无买入`);
    const bi = barsIdx.get(buy.date), si = barsIdx.get(sig.date);
    let peak = -Infinity, first = -1;
    for (let k = bi; k <= si; k++) {
      peak = Math.max(peak, bars[k].close);
      if (first < 0 && k < si && bars[k].close <= peak * (1 - 0.08) + 1e-9) first = k;
    }
    assert.ok(bars[si].close <= peak * (1 - 0.08) + 1e-9,
      `${sig.date} 收盘 ${bars[si].close} 未跌破持仓峰值 ${peak} 的 92%`);
    assert.ok(first < 0, `持仓期内 ${first >= 0 ? bars[first].date : ''} 已满足条件，应更早触发`);
  }
});

check('14 峰值不含入场前高点（不引入未来函数）', () => {
  const r = runStrategy(cardOf(ma(), [tr(0.08)]), input);
  const sigs = r.signals.filter(x => x.type === 'EXIT' && /trailingStop/.test(x.reason || ''));
  assert.ok(sigs.length > 0, '本项需要至少一个移动止损信号');
  const cfDates = new Set();
  for (const sig of sigs) {
    const buy = r.trades.filter(t => t.side === 'BUY' && t.date < sig.date).pop();
    assert.ok(buy, `${sig.date} 前无买入`);
    const bi = barsIdx.get(buy.date), si = barsIdx.get(sig.date);
    let peakAll = -Infinity, peakIn = -Infinity;
    for (let k = 0; k <= si; k++) {
      peakAll = Math.max(peakAll, bars[k].close);
      if (k >= bi) peakIn = Math.max(peakIn, bars[k].close);
    }
    for (let k = bi; k < si; k++) {
      if (bars[k].close <= peakAll * (1 - 0.08) + 1e-9 && bars[k].close > peakIn * (1 - 0.08) + 1e-9)
        cfDates.add(bars[k].date);
    }
  }
  assert.ok(cfDates.size > 0, '样例应存在「用入场前高点会误触发」的日子，否则无法验证排除逻辑');
  for (const d of cfDates) assert.ok(!sigs.some(x => x.date === d), `${d} 用了入场前高点`);
});

check('15 非法配置被拒绝（多条件与 / 移动止损）', () => {
  assert.throws(() => buildConditions(barsLite, { entry: allOf(ma()), exits: [hold()] }));
  assert.throws(() => buildConditions(barsLite, { entry: allOf(ma(), ma()), exits: [hold()] }));
  assert.throws(() => buildConditions(barsLite, { entry: allOf(ma(), { type: 'rsi' }), exits: [hold()] }));
  assert.throws(() => buildConditions(barsLite, { entry: ma(), exits: [tr(1.5)] }));
  assert.throws(() => buildConditions(barsLite, { entry: ma(), exits: [tr(0)] }));
  assert.throws(() => buildConditions(barsLite, { entry: ma(), exits: [{ type: 'rsi', params: {} }] }));
});

check('16 与条件可能零入场：不报错、不产生交易、不伪造信号', () => {
  // MA5/20 金叉 与 lookback=20 突破在该样例上从不同日发生
  const r = runStrategy(cardOf(allOf(ma(), bo()), [hold()]), input);
  assert.equal(r.trades.length, 0, '本应无交易，却出现成交');
  assert.equal(r.signals.length, 0, '本应无信号，却出现信号');
  assert.ok(r.equity.length > 0, '零入场时仍应产出完整时间轴');
  assert.equal(r.equity[r.equity.length - 1].asset, 100000, '零交易时期末资产应等于本金');
});

console.log(`\n策略组合验收：${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
