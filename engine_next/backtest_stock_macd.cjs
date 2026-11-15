/* ============================================================================
 * S5 个股回测执行器（MACD 金叉买入 / 死叉卖出 vs 买入持有）
 * 调用：node engine_next/backtest_stock_macd.cjs --config engine_next/config.stock_macd.json [--run <id>]
 *
 * 输入：01_data/stock_daily.json（SIMULATED 模拟日线、模拟分红）
 *       01_data/dividend_calendar.json（SIMULATED 模拟派息日）
 * 输出：02_backtest_macd/
 *        summary.json      两策略全部指标 + MACD 参数 + 信号事件 + 自检
 *        daily.csv         逐日账户（MACD 与持有对照）+ 当日 MACD 值
 *        trades.csv        逐笔成交（MACD / 持有，含信号类型与信号日）
 *        macd.csv          逐日 DIF/DEA/HIST/交叉
 *        signals.csv       金叉/死叉信号（信号日收盘 vs 成交日开盘，禁止未来函数）
 *        events.csv        停牌顺延 / 涨跌停无法成交 / 未平仓等异常
 *
 * 约束：复用 stock_core.runHoldStock（买入持有对照）、stock_cost、support_guard；
 *       数据由 tools/gen_demo_data.cjs 确定性生成，不代表任何真实历史行情。
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { buildSchedule, zeroCostConfig, r2 } = require('./lib/stock_cost.cjs');
const { buildTimeline, runHoldStock } = require('./lib/stock_core.cjs');
const { runMacdStock } = require('./lib/stock_macd_core.cjs');
const { assertSupportedSymbol, assertSupportedActions, UnsupportedError } = require('./lib/support_guard.cjs');

const ROOT = path.dirname(__dirname);
const args = (() => {
  const o = {};
  process.argv.slice(2).forEach((a, i, arr) => {
    if (a.startsWith('--')) o[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
  });
  return o;
})();
const CFG = JSON.parse(fs.readFileSync(path.resolve(args.config || path.join(ROOT, 'engine_next', 'config.stock_macd.json')), 'utf8'));

/* engine.root 解析优先级：本地覆盖 > 环境变量 > config > 仓库根兜底。
   开源版配置不写任何机器专属路径，直接回退到仓库根下的 output/，
   保证任何机器解压即用、不依赖私人项目目录。 */
function resolveRoot(cfg) {
  const localPath = path.join(ROOT, 'migration', 'local_configs', 'config.local.json');
  if (fs.existsSync(localPath)) {
    try { const local = JSON.parse(fs.readFileSync(localPath, 'utf8')); if (local.engine && local.engine.root) return local.engine.root; } catch (e) {}
  }
  if (process.env.ENGINE_ROOT) return process.env.ENGINE_ROOT;
  const cfgRoot = cfg.engine.root;
  if (cfgRoot && fs.existsSync(path.join(cfgRoot, 'output'))) return path.resolve(cfgRoot);
  return ROOT; // 仓库根兜底：output 在仓库根下，家里/工厂通用
}

const RUN = String(args.run || CFG.run_id);
const ROOT_RESOLVED = path.resolve(resolveRoot(CFG));
const RUN_DIR = path.join(ROOT_RESOLVED, CFG.engine.output_dir || 'output', RUN);
const BT_DIR = path.join(RUN_DIR, '02_backtest_macd');
fs.mkdirSync(BT_DIR, { recursive: true });

const dataPath = path.join(RUN_DIR, '01_data', 'stock_daily.json');
if (!fs.existsSync(dataPath)) throw new Error('E_NO_STOCK_DATA: 缺少 ' + dataPath + '（请先运行 node tools/gen_demo_data.cjs 生成模拟数据）');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const CAL_PATH = path.join(RUN_DIR, '01_data', 'dividend_calendar.json');
if (!fs.existsSync(CAL_PATH)) throw new Error('E_NO_PAY_CALENDAR: 缺少 01_data/dividend_calendar.json，请重新运行 node tools/gen_demo_data.cjs');
const payCal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));

/* —— 支持边界前置校验：不支持的标的/公司行为直接拒绝并明确报告 —— */
try {
  assertSupportedSymbol({ code: data.meta.symbol, name: data.meta.name, board: data.meta.board }, 'MACD');
  assertSupportedActions(data.actions, 'MACD');
} catch (e) {
  if (e instanceof UnsupportedError) {
    console.error('[MACD] 不支持的标的/公司行为，已拒绝执行：');
    console.error('  ' + e.message);
    process.exit(4);
  }
  throw e;
}

const payByEx = new Map(payCal.events.map(e => [e.date, e]));
const actions = data.actions.map(a => {
  const p = payByEx.get(a.date);
  if (!p) throw new Error(`E_MISSING_PAY_DATE: ${a.date} 无派息日记录`);
  if (p.recordDate !== a.recordDate) throw new Error(`E_RECORD_MISMATCH: ${a.date} 登记日 ${p.recordDate} vs 公告 ${a.recordDate}`);
  if (Math.abs(p.cashPerShare - a.cashPerShare) > 1e-9) throw new Error(`E_CASH_MISMATCH: ${a.date}`);
  return Object.assign({}, a, { payDate: p.payDate });
});

const SCH = buildSchedule(CFG);
const ZSCH = buildSchedule(zeroCostConfig(CFG), { allowZero: true });

const days = buildTimeline({
  calendar: data.calendar,
  bars: data.bars,
  actions,
  priceLimitPct: CFG.support.priceLimitPct
});

const baseOpts = (schedule) => Object.assign(
  { lot: CFG.backtest.lotSize, initialCapital: CFG.backtest.initialCapital, parValue: CFG.data.symbol.parValue, tradingDaysPerYear: CFG.backtest.tradingDaysPerYear },
  { schedule }
);
const macdOpts = Object.assign(baseOpts(SCH), { macd: CFG.macd || { fast: 12, slow: 26, signal: 9 } });

const macd = runMacdStock(days, macdOpts);
const zf = runMacdStock(days, Object.assign(baseOpts(ZSCH), { macd: CFG.macd || { fast: 12, slow: 26, signal: 9 } }));
const hd = runHoldStock(days, baseOpts(SCH));

/* ---------------- 期末资金勾稽 ---------------- */
function reconcile(res) {
  const sum = (arr, f) => r2(arr.reduce((s, x) => s + f(x), 0));
  const initial = CFG.backtest.initialCapital;
  const sellAmount = sum(res.trades.filter(t => t.side === 'SELL'), t => t.amount);
  const buyAmount = sum(res.trades.filter(t => t.side === 'BUY'), t => t.amount);
  const fee = sum(res.trades, t => t.fee);
  const tax = sum(res.trades, t => t.dividendTax);
  const divPaid = r2(res.summary.totalDividendPaid);
  const computedCash = r2(initial + sellAmount - buyAmount - fee - tax + divPaid);
  const last = res.daily[res.daily.length - 1];
  return {
    initialCapital: initial, plusSellProceeds: sellAmount, minusBuyCost: buyAmount,
    minusTradingFees: fee, minusDividendTax: tax, plusDividendsReceived: divPaid,
    computedCash, actualCash: r2(res.summary.finalCash), diff: r2(computedCash - res.summary.finalCash),
    receivable: r2(res.summary.finalReceivable), shares: res.summary.finalShares,
    holdingValue: r2(res.summary.finalShares * (last.mark || 0)), finalAsset: r2(res.summary.final),
    assetDiff: r2(res.summary.final - (res.summary.finalCash + res.summary.finalShares * (last.mark || 0) + res.summary.finalReceivable))
  };
}
const reconMacd = reconcile(macd), reconHd = reconcile(hd), reconZf = reconcile(zf);

/* ---------------- 自检 ---------------- */
const checks = [];
const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });
const assetIdentity = d => Math.abs(d.asset - (d.cash + d.shares * d.mark + d.divReceivable)) < 0.011;
const lot = CFG.backtest.lotSize;
const suspSet = new Set(data.suspensions.map(s => s.date));

ok('每日资产恒等（MACD：现金+市值+应收股息）', macd.daily.every(assetIdentity), 'asset == cash + shares×close + receivable');
ok('每日资产恒等（持有：现金+市值+应收股息）', hd.daily.every(assetIdentity), '同上');
ok('现金始终非负', macd.daily.every(d => d.cash >= -1e-9) && hd.daily.every(d => d.cash >= -1e-9), '无透支');
ok('应收股息全程非负', macd.daily.every(d => d.divReceivable >= -1e-9) && hd.daily.every(d => d.divReceivable >= -1e-9), '无透支');
ok('买入股数均为 100 股整数倍', macd.trades.concat(hd.trades).filter(t => t.side === 'BUY').every(t => t.shares % lot === 0), 'lot=' + lot);
ok('每笔买入均预留全部买入费用（现金 >= 成交额 + 费用）',
  macd.trades.concat(hd.trades).filter(t => t.side === 'BUY').every(t => t.cashBefore + 1e-6 >= t.amount + t.fee), '现金约束');
ok('费用合计与逐笔三项拆分一致', (() => {
  const sum = t => ({ c: r2(t.reduce((s, x) => s + x.commission, 0)), s: r2(t.reduce((s, x) => s + x.stampDuty, 0)), f: r2(t.reduce((s, x) => s + x.transferFee, 0)) });
  const a = sum(macd.trades), b = sum(hd.trades);
  return ['commission', 'stampDuty', 'transferFee'].every((k, i) =>
    Math.abs([a.c, a.s, a.f][i] - macd.summary.feeBreakdown[k]) < 0.02 &&
    Math.abs([b.c, b.s, b.f][i] - hd.summary.feeBreakdown[k]) < 0.02);
})(), '佣金/印花税/过户费分别对账');
ok('印花税逐笔按成交当日费率计收', macd.trades.concat(hd.trades).every(t => {
  const expect = t.date >= '2023-08-28' ? 0.0005 : 0.001;
  return t.rates.stampDutyRate === expect && (t.side === 'BUY' ? t.stampDuty === 0 : true);
}), '2023-08-28 分界');
ok('过户费逐笔按成交当日费率计收', macd.trades.concat(hd.trades).every(t => {
  const expect = t.date >= '2022-04-29' ? 0.00001 : 0.00002;
  return t.rates.transferFeeRate === expect;
}), '2022-04-29 分界');
ok('停牌日无成交', macd.trades.concat(hd.trades).every(t => !suspSet.has(t.date)), '停牌日 ' + suspSet.size + ' 天');
ok('每日最多一笔买入、一笔卖出',
  macd.trades.every((t, i, arr) => i === 0 || arr[i - 1].date !== t.date || arr[i - 1].side !== t.side), '无同日重复同向成交');
ok('金叉信号均对应一笔 GOLDEN 买入（或封板未成交）',
  macd.signals.filter(s => s.type === 'GOLDEN').every(s => s.executed || s.blocked || s.note.includes('已持仓')), '信号-成交对应');
ok('死叉信号均对应一笔 DEATH 卖出（或封板未成交/已空仓）',
  macd.signals.filter(s => s.type === 'DEATH').every(s => s.executed || s.blocked || s.note.includes('已空仓')), '信号-成交对应');
/* 禁止未来函数：成交日必须严格晚于信号日（次日开盘），不得同日 */
ok('禁止未来函数：成交日严格晚于信号日', macd.trades.every(t =>
  (t.signalType !== 'GOLDEN' && t.signalType !== 'DEATH') || (t.signalDate && t.date > t.signalDate)), 'execDate > signalDate');
ok('无成交出现在信号当日（非次日）', macd.trades.every(t =>
  (t.signalType !== 'GOLDEN' && t.signalType !== 'DEATH') || t.date !== t.signalDate), '不为信号当日成交');
ok('红利税 = 税前红利 × 持股期限档位', macd.trades.concat(hd.trades).every(t => t.dividendTax === 0 ||
  Math.abs(t.dividendTax - r2(t.divTaxBase * t.divTaxRate)) <= 0.02), '税 = 税基 × 档位费率');
ok('零费用：MACD 逐笔费用恒为 0', zf.trades.every(t => t.fee === 0 && t.dividendTax === 0), 'fee==0');
ok('零费用：现金始终非负', zf.daily.every(d => d.cash >= -1e-9), '无透支');
ok('期末资金勾稽（MACD）', Math.abs(reconMacd.diff) <= 0.02 && Math.abs(reconMacd.assetDiff) <= 0.02, `差额 ${reconMacd.diff}/${reconMacd.assetDiff}`);
ok('期末资金勾稽（持有）', Math.abs(reconHd.diff) <= 0.02 && Math.abs(reconHd.assetDiff) <= 0.02, `差额 ${reconHd.diff}/${reconHd.assetDiff}`);
ok('期末无未结算红利税（MACD 卖出后）', macd.summary.unclosed ? true : macd.summary.finalUnsettledTax === 0, `unclosed=${macd.summary.unclosed} 未结税=${macd.summary.finalUnsettledTax}`);

/* ---------------- 收益率结构 ---------------- */
const cmp = {
  finalDiff: r2(macd.summary.final - hd.summary.final),
  finalDiffVsHoldPct: +((macd.summary.final / hd.summary.final - 1) * 100).toFixed(4),
  feeDiff: r2(macd.summary.totalFees - hd.summary.totalFees),
  ddDiffPct: +((macd.summary.maxDD - hd.summary.maxDD) * 100).toFixed(4)
};
const feeBridge = {
  zeroFeeFinal: r2(zf.summary.final), realFinal: r2(macd.summary.final),
  totalFees: r2(macd.summary.totalFees), totalDividendTax: r2(macd.summary.totalDividendTax),
  gap: r2(zf.summary.final - macd.summary.final),
  note: '零手续费为独立重算（佣金/印花税/过户费/红利税同时置 0）。'
};
const summary = {
  meta: {
    runId: RUN, symbol: data.meta.symbol, name: data.meta.name, board: data.meta.board,
    sources: data.meta.sources, adjust: data.meta.adjust,
    start: data.bars[0].date, end: data.bars[data.bars.length - 1].date,
    tradingDays: days.length, tradableDays: days.filter(d => !d.suspended).length,
    suspendedDays: days.length - days.filter(d => !d.suspended).length,
    corporateActions: actions, initialCapital: CFG.backtest.initialCapital, lot,
    costs: CFG.costs, securityStatus: data.meta.securityStatus,
    dataChecks: data.checks, payCalendar: payCal.meta, payChecks: payCal.checks,
    generatedAt: new Date().toISOString(), macdParams: macd.summary.macdParams,
    fillAssumption: CFG.backtest.fillAssumption
  },
  macd: macd.summary, hold: hd.summary, zeroFeeMacd: zf.summary,
  comparison: cmp, feeBridge, reconciliation: { macd: reconMacd, hold: reconHd, zeroFeeMacd: reconZf },
  activity: {
    macdLastBuyDate: macd.summary.lastBuyDate, macdLastSellDate: macd.summary.lastSellDate,
    macdUnclosed: macd.summary.unclosed, macdGoldenCount: macd.summary.goldenCount, macdDeathCount: macd.summary.deathCount,
    note: 'MACD 策略在账户买不起 1 手后无法再建仓，余额滞留现金；这不是数据缺口，是费用与价格路径的真实结果。'
  },
  checks
};
fs.writeFileSync(path.join(BT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

/* ---------------- 逐日账户（MACD 与持有对照 + 当日 MACD） ---------------- */
const m = macd.macd;
const tIdxByDate = new Map(days.filter(d => !d.suspended).map((d, i) => [d.date, i]));
const f2 = x => (x === null || x === undefined ? '' : (Math.round(x * 100) / 100).toFixed(2));
const f6 = x => (x === null || x === undefined ? '' : x.toFixed(6));
const macdAtDay = [];
for (let i = 0; i < days.length; i++) {
  const ti = tIdxByDate.get(days[i].date);
  macdAtDay.push(ti === undefined ? null : ti);
}
const dhead = ['date', 'suspended', 'open', 'close', 'macd_dif', 'macd_dea', 'macd_hist', 'macd_cross',
  'macd_shares', 'macd_cash', 'macd_asset', 'hold_shares', 'hold_cash', 'hold_asset', 'flags'];
const dlines = [dhead.join(',')];
for (let i = 0; i < days.length; i++) {
  const a = macd.daily[i], b = hd.daily[i], ti = macdAtDay[i];
  const cross = ti === null ? '' : (m.crosses[ti] || 'none');
  dlines.push([
    a.date, a.suspended ? 1 : 0, f2(a.open), f2(a.close),
    ti === null ? '' : f6(m.dif[ti]), ti === null ? '' : f6(m.dea[ti]), ti === null ? '' : f6(m.hist[ti]), cross,
    a.shares, f2(a.cash), f2(a.asset), b.shares, f2(b.cash), f2(b.asset), a.flags.join('|')
  ].join(','));
}
fs.writeFileSync(path.join(BT_DIR, 'daily.csv'), dlines.join('\n'), 'utf8');

/* ---------------- 逐笔成交 ---------------- */
const th = ['strategy', 'seq', 'side', 'date', 'signal_type', 'signal_date', 'price', 'shares', 'amount',
  'commission', 'stamp_duty', 'transfer_fee', 'fee_total', 'dividend_tax', 'div_tax_rate', 'holding_days',
  'cash_before', 'cash_after', 'shares_after', 'note'];
const tl = [th.join(',')];
for (const [tag, res] of [['macd', macd], ['hold', hd], ['zeroFeeMacd', zf]]) {
  for (const t of res.trades) {
    tl.push([tag, t.seq, t.side, t.date, t.signalType || '', t.signalDate || '', t.price, t.shares, f2(t.amount),
      f2(t.commission), f2(t.stampDuty), f2(t.transferFee), f2(t.fee), f2(t.dividendTax), t.divTaxRate === undefined ? '' : t.divTaxRate, t.holdingDays,
      f2(t.cashBefore), f2(t.cashAfter), t.sharesAfter, (t.note || '').replace(/,/g, '；')].join(','));
  }
}
fs.writeFileSync(path.join(BT_DIR, 'trades.csv'), tl.join('\n'), 'utf8');

/* ---------------- 逐日 MACD 序列 ---------------- */
const mhead = ['date', 'close', 'dif', 'dea', 'hist', 'cross'];
const ml = [mhead.join(',')];
for (let i = 0; i < days.length; i++) {
  const ti = macdAtDay[i];
  if (ti === null) { ml.push([days[i].date, f2(days[i].close), '', '', '', ''].join(',')); continue; }
  ml.push([days[i].date, f2(days[i].close), f6(m.dif[ti]), f6(m.dea[ti]), f6(m.hist[ti]), m.crosses[ti] || 'none'].join(','));
}
fs.writeFileSync(path.join(BT_DIR, 'macd.csv'), ml.join('\n'), 'utf8');

/* ---------------- 信号事件（信号日收盘 vs 成交日开盘） ---------------- */
const shead = ['type', 'signal_date', 'signal_close', 'dif', 'dea', 'hist', 'exec_date', 'exec_price', 'executed', 'blocked', 'note'];
const sl = [shead.join(',')];
for (const s of macd.signals) {
  sl.push([s.type, s.signalDate, f2(s.signalClose), s.dif === null ? '' : f6(s.dif), s.dea === null ? '' : f6(s.dea),
    s.hist === null ? '' : f6(s.hist), s.execDate, f2(s.execPrice), s.executed ? 1 : 0, s.blocked ? 1 : 0,
    (s.note || '').replace(/,/g, '；')].join(','));
}
fs.writeFileSync(path.join(BT_DIR, 'signals.csv'), sl.join('\n'), 'utf8');

/* ---------------- 异常事件 ---------------- */
const ehead = ['strategy', 'event', 'start_date', 'end_date', 'days', 'detail'];
const evRows = [];
for (const [tag, res] of [['macd', macd], ['hold', hd]]) {
  res.daily.forEach((d, idx) => {
    for (const fl of d.flags) {
      if (['SELL_BLOCKED', 'BUY_BLOCKED', 'SELL_DEFERRED', 'INSUFFICIENT_CASH', 'UNCLOSED'].includes(fl) || fl.startsWith('T_LIMIT_TOUCH_'))
        evRows.push({ tag, event: fl, date: d.date, idx, detail: d.note || '' });
    }
  });
}
const grouped = [];
for (const r of evRows) {
  const last = grouped[grouped.length - 1];
  if (last && last.tag === r.tag && last.event === r.event && last.idx === r.idx - 1) {
    last.end = r.date; last.days++; last.idx = r.idx; last.detail = r.detail;
  } else grouped.push({ tag: r.tag, event: r.event, start: r.date, end: r.date, days: 1, idx: r.idx, detail: r.detail });
}
const el = [ehead.join(',')];
for (const g of grouped)
  el.push([g.tag, g.event, g.start, g.end, g.days, (g.detail || '').replace(/,/g, '；')].join(','));
if (grouped.length === 0) el.push(',,,,0,区间内无停牌、无涨跌停封板、无未平仓');
fs.writeFileSync(path.join(BT_DIR, 'events.csv'), el.join('\n'), 'utf8');

/* ---------------- 控制台 ---------------- */
const failed = checks.filter(c => !c.pass);
const pct = x => (x * 100).toFixed(2) + '%';
const money = x => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
console.log(`[MACD] ${data.meta.name}(${data.meta.symbol}) ${summary.meta.start} → ${summary.meta.end} | MACD ${macd.summary.macdParams.fast}/${macd.summary.macdParams.slow}/${macd.summary.macdParams.signal}`);
console.log(`[MACD] 交易日 ${summary.meta.tradingDays}（可交易 ${summary.meta.tradableDays}，停牌 ${summary.meta.suspendedDays}）| 本金 ${money(CFG.backtest.initialCapital)} | 每手 ${lot} 股`);
console.log(`[MACD] 金叉 ${macd.summary.goldenCount} 次 / 死叉 ${macd.summary.deathCount} 次 | 成交 ${macd.summary.tradeCount} 笔`);
console.log(`[MACD] 策略  终值 ${money(macd.summary.final)} | 收益 ${pct(macd.summary.totalReturn)} | 年化 ${pct(macd.summary.cagr)} | 回撤 ${pct(macd.summary.maxDD)} | 费用 ${money(macd.summary.totalFees)} | 红利税 ${money(macd.summary.totalDividendTax)}${macd.summary.unclosed ? ' | 期末未平仓' : ''}`);
console.log(`[MACD] 持有  终值 ${money(hd.summary.final)} | 收益 ${pct(hd.summary.totalReturn)} | 年化 ${pct(hd.summary.cagr)} | 回撤 ${pct(hd.summary.maxDD)} | 成交 ${hd.summary.tradeCount} 笔`);
console.log(`[MACD] 零费用 终值 ${money(zf.summary.final)} | 收益 ${pct(zf.summary.totalReturn)} | 成交 ${zf.summary.tradeCount} 笔`);
console.log(`[MACD] 差额 策略−持有 ${money(cmp.finalDiff)}（相对持有 ${cmp.finalDiffVsHoldPct}%）`);
if (failed.length) {
  console.error('[MACD] 自检失败：');
  failed.forEach(f => console.error(`  FAIL ${f.name} | ${f.detail}`));
  process.exit(3);
}
console.log(`[MACD] 自检 ${checks.length}/${checks.length} 通过 | 输出 ${BT_DIR}`);
