/*
 * V0.4 阶段 A：自然语言翻译层验收
 *
 * 二十项：三类路由、中文数字/全角归一化、默认值标注、
 *         只给止盈不补止损、缺条件/多入场/参数冲突/非白名单指标拒绝、
 *         产物必须过既有 normalizeParams 与 buildConditions、
 *         产物必须能组装成合法策略卡并真正跑出回测、
 *         反向验证、确定性、证据偏移。
 *
 * 运行：node engine_next/tests/verify_nl_parser.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseStrategyText } = require('../strategy_nl.cjs');
const { buildConditions } = require('../strategy_conditions.cjs');
const { normalizeParams, buildCard } = require('../../web/src/strategyCard.js');
const { validateImport } = require('../../web/src/import/validate');
const { runStrategy } = require('../strategy_engine.cjs');

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
const input = { bars: v.model.bars, actions: [] };

const parse = (t) => parseStrategyText(t);
const errorCodes = (d) => d.issues.filter(i => i.level === 'error').map(i => i.code);

/* 用于「可执行产物必须能真正跑起来」的一组句子 */
const RUNNABLE = [
  '5日均线上穿20日均线买入，持有5个交易日卖出',
  '突破前20日最高价买入，涨10%止盈，跌5%止损',
  '5日均线上穿20日均线买入，5日线下穿20日线卖出',
  '均线金叉买入，持有3天卖出，止盈20%',
  'MACD金叉买入，死叉卖出',
  '尾盘买入，次日开盘卖出',
  '尾盘买入，次日开盘卖出，开盘涨幅超过2%就继续持有',
];

check('1 均线金叉 + 固定持有 → 组合策略，参数正确', () => {
  const d = parse('5日均线上穿20日均线买入，持有5个交易日卖出');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  assert.equal(d.route.templateId, 'composition');
  assert.equal(d.params.composition.schema, 'stv.composition/0.1');
  assert.equal(d.params.composition.entry.type, 'maCross');
  assert.equal(d.params.composition.entry.params.fast, 5);
  assert.equal(d.params.composition.entry.params.slow, 20);
  assert.equal(d.params.composition.exits[0].type, 'fixedHolding');
  assert.equal(d.params.composition.exits[0].params.days, 5);
});

check('2 突破 + 止盈止损 → 参数落到引擎字段', () => {
  const d = parse('突破前20日最高价买入，涨10%止盈，跌5%止损');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  assert.equal(d.params.composition.entry.type, 'breakout');
  assert.equal(d.params.composition.entry.params.lookback, 20);
  const rt = d.params.composition.exits.find(e => e.type === 'returnThreshold');
  assert.equal(rt.params.takeProfit, 0.1);
  assert.equal(rt.params.stopLoss, 0.05);
});

check('3 显式均线死叉可作退出条件，且按原文顺序排列', () => {
  const d = parse('5日均线上穿20日均线买入，持有3天卖出，5日线下穿20日线卖出');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  const types = d.params.composition.exits.map(e => e.type);
  assert.deepEqual(types, ['fixedHolding', 'maCross']);
});

check('4 MACD → macd_cross 模板，参数锁定 12/26/9', () => {
  const d = parse('MACD金叉买入，死叉卖出');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  assert.equal(d.route.templateId, 'macd_cross');
  assert.deepEqual(d.params, { fast: 12, slow: 26, signal: 9 });
  assert.ok(d.defaults.some(x => String(x.value).includes('12/26/9')), '锁定参数必须列进默认值清单');
});

check('5 尾盘买/次日开盘卖 → 老模板 close_buy_open_sell', () => {
  const d = parse('尾盘买入，次日开盘卖出');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  assert.equal(d.route.templateId, 'close_buy_open_sell');
  assert.equal(d.params.entrySignal, 'always');
  assert.equal(d.params.exitFill, 'nextOpen');
});

check('6 集合竞价跳空过滤被识别为 holdIfGte', () => {
  const d = parse('尾盘买入，次日开盘卖出，开盘涨幅超过2%就继续持有');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  assert.equal(d.params.auctionFilter.holdIfGte, 0.02);
  assert.equal(d.params.auctionFilter.basis, 'open_gap_pct');
});

check('7 中文数字与全角标点归一化', () => {
  const d = parse('五日均线上穿二十日均线买入，持有十天卖出');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  assert.equal(d.params.composition.entry.params.fast, 5);
  assert.equal(d.params.composition.entry.params.slow, 20);
  assert.equal(d.params.composition.exits[0].params.days, 10);
});

check('8 只说止盈时不补止损（最容易悄悄改变语义的地方）', () => {
  const d = parse('5日均线上穿20日均线买入，涨10%卖出');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  const rt = d.params.composition.exits.find(e => e.type === 'returnThreshold');
  assert.equal(rt.params.takeProfit, 0.1);
  assert.equal(rt.params.stopLoss, null, '不得自动补一个止损');
  assert.ok(!d.ruleText.includes('止损'), '规则串不得出现用户没说的止损');
});

check('9 说了止盈止损但没给数字 → 双默认值且全部标注', () => {
  const d = parse('突破前20日最高价买入，止盈止损');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  const rt = d.params.composition.exits.find(e => e.type === 'returnThreshold');
  assert.equal(rt.params.takeProfit, 0.10);
  assert.equal(rt.params.stopLoss, 0.05);
  const fields = d.defaults.map(x => x.field).join('|');
  assert.ok(/takeProfit/.test(fields) && /stopLoss/.test(fields), '两条默认值都必须标注');
});

check('10 定性描述（没说周期）必须记录默认值来源', () => {
  const d = parse('均线金叉买入，持有5天卖出');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  assert.equal(d.params.composition.entry.params.fast, 5);
  assert.equal(d.params.composition.entry.params.slow, 20);
  assert.ok(d.defaults.some(x => x.field.startsWith('entry.params')));
  for (const x of d.defaults) assert.ok(x.field && x.value !== undefined && x.why, '默认值条目必须含 field/value/why');
});

check('11 非白名单指标拒绝，且不产出任何 params', () => {
  const d = parse('KDJ金叉买入，持有5天卖出');
  assert.equal(d.executable, false);
  assert.equal(d.params, null);
  assert.equal(d.cardRequest, null);
  assert.ok(errorCodes(d).includes('E_NOT_SUPPORTED'));
  assert.ok(d.unsupported.some(u => /KDJ/.test(u.term)));
});

check('12 只有入场没有出场 → E_NO_EXIT，绝不默认出场', () => {
  const d = parse('5日均线上穿20日均线买入');
  assert.equal(d.executable, false);
  assert.equal(d.params, null);
  assert.ok(errorCodes(d).includes('E_NO_EXIT'));
});

check('13 两个入场条件 → E_MULTI_ENTRY', () => {
  const d = parse('5日均线上穿20日均线买入，突破前20日最高价买入，持有5天卖出');
  assert.equal(d.executable, false);
  assert.ok(errorCodes(d).includes('E_MULTI_ENTRY'));
});

check('14 均线参数倒置（10 上穿 5）被引擎挡下', () => {
  const d = parse('10日均线上穿5日均线买入，持有5天卖出');
  assert.equal(d.executable, false);
  assert.ok(errorCodes(d).includes('E_MA_PARAMS'), errorCodes(d).join(','));
});

check('15 只说「金叉」不说指标 → E_AMBIGUOUS_ROUTE', () => {
  const d = parse('金叉买入，死叉卖出');
  assert.equal(d.executable, false);
  assert.ok(errorCodes(d).includes('E_AMBIGUOUS_ROUTE'));
});

check('16 空输入 → E_TEXT_EMPTY', () => {
  for (const t of ['', '   ', null, undefined]) {
    const d = parse(t);
    assert.equal(d.executable, false);
    assert.ok(errorCodes(d).includes('E_TEXT_EMPTY'));
  }
});

check('17 持有 0 天 → 引擎报 E_HOLD_DAYS', () => {
  const d = parse('5日均线上穿20日均线买入，持有0天卖出');
  assert.equal(d.executable, false);
  assert.ok(errorCodes(d).includes('E_HOLD_DAYS'), errorCodes(d).join(','));
});

check('18 非主板代码 → E_UNSUPPORTED_BOARD，且不静默接受', () => {
  const d = parse('300750 5日均线上穿20日均线买入，持有5天卖出');
  assert.equal(d.executable, false);
  assert.ok(errorCodes(d).includes('E_UNSUPPORTED_BOARD'));
  assert.equal(d.suggestedSymbol, null);
});

check('19 每条可执行产物都能组装成合法策略卡', () => {
  for (const text of RUNNABLE) {
    const d = parse(text);
    assert.equal(d.executable, true, `${text} → ${JSON.stringify(errorCodes(d))}`);
    const r = buildCard({
      templateId: d.cardRequest.templateId,
      symbol: d.suggestedSymbol || '600000',
      startDate: '2024-02-01',
      endDate: '2024-12-30',
      initialCapital: 100000,
      params: d.cardRequest.params,
    });
    assert.equal(r.ok, true, `${text} → buildCard 失败：${r.message}`);
    assert.equal(r.value.card.symbol, '600000');
    assert.equal(r.value.card.data.adjust, 'none');
  }
});

check('20 每条可执行产物都能真正跑完回测（不只是结构合法）', () => {
  for (const text of RUNNABLE) {
    const d = parse(text);
    const r = buildCard({
      templateId: d.cardRequest.templateId,
      symbol: '600000', startDate: '2024-02-01', endDate: '2024-12-30',
      initialCapital: 100000, params: d.cardRequest.params,
    });
    assert.equal(r.ok, true, `${text} → ${r.message}`);
    const res = runStrategy(r.value.card, input);
    assert.ok(Array.isArray(res.trades), `${text} 未返回 trades`);
    assert.ok(/^[0-9a-f]{64}$/.test(res.reproducibility.resultSha256), `${text} 缺少结果指纹`);
    for (const e of res.equity) {
      const calc = +(e.cash + e.holdingValue + e.divReceivable).toFixed(2);
      assert.ok(Math.abs(calc - e.asset) <= 0.011, `${text} ${e.date} 资产恒等式不成立`);
    }
  }
});

check('21 反向验证：非白名单组件过不了既有门禁', () => {
  const bad = normalizeParams('composition', {
    composition: { schema: 'stv.composition/0.1', entry: { type: 'kdjCross', params: {} }, exits: [{ type: 'fixedHolding', params: { days: 5 } }] }
  });
  assert.equal(bad.ok, false);
  const badCard = buildCard({
    templateId: 'composition', symbol: '600000', startDate: '2024-02-01', endDate: '2024-12-30',
    params: { composition: { schema: 'stv.composition/0.1', entry: { type: 'rsiCross', params: {} }, exits: [{ type: 'fixedHolding', params: {} }] } }
  });
  assert.equal(badCard.ok, false);
  assert.throws(() => buildConditions([], {
    entry: { type: 'rsiCross', params: {} }, exits: [{ type: 'fixedHolding', params: {} }]
  }));
});

check('22 同一文本两次解析逐字节一致（确定性）', () => {
  for (const text of RUNNABLE) {
    assert.equal(JSON.stringify(parse(text)), JSON.stringify(parse(text)));
  }
});

check('23 证据偏移能在归一化文本中精确切回原片段', () => {
  const d = parse('5日均线上穿20日均线买入，持有5个交易日卖出');
  assert.ok(d.evidence.length >= 2);
  for (const e of d.evidence) {
    assert.equal(d.source.normalized.slice(e.start, e.end), e.text, `偏移不匹配：${e.type}`);
  }
});

check('24 规则串由结构化字段生成，覆盖入场与全部出场', () => {
  const d = parse('突破前20日最高价买入，持有5天卖出，止盈15%');
  assert.equal(d.executable, true, JSON.stringify(d.issues));
  assert.ok(d.ruleText.includes('突破'));
  assert.ok(d.ruleText.includes('5 个交易日'));
  assert.ok(d.ruleText.includes('+15%'));
  assert.ok(d.ruleText.includes('次一交易日开盘成交'));
});

console.log(`\n自然语言翻译层验收：${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
