/*
 * V0.4 阶段 B：网页确认层（/api/nl/preview 背后的服务层）验收
 *
 * 十二项：无改参时与解析层一致、改参生效且规则串同步、倒置参数被引擎挡下、
 *         无目标条件改参被拒、补止损后规则串同步、MACD 锁定、非白名单字段、
 *         类型校验、超长文本、不可执行时 params 恒为 null、可执行产物能过 buildCard、确定性。
 *
 * 运行：node tools/check_nl_preview.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const { previewNl, MAX_TEXT_CHARS } = require('../web/src/nlPreview');
const { parseStrategyText } = require('../engine_next/strategy_nl.cjs');
const { buildCard } = require('../web/src/strategyCard.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.error(`[FAIL] ${name}\n       ${e.message}`); }
}

const TEXT = '5日均线上穿20日均线买入，持有5个交易日卖出，涨10%止盈';
const codes = (d) => (d.issues || []).filter((i) => i.level === 'error').map((i) => i.code);

check('1 不改参数时与服务端解析结果一致（不多不少）', () => {
  const p = previewNl({ text: TEXT });
  const raw = parseStrategyText(TEXT);
  assert.equal(p.ok, true, JSON.stringify(codes(p)));
  assert.equal(JSON.stringify(p.cardRequest.params), JSON.stringify(raw.cardRequest.params));
  assert.equal(p.ruleText, raw.ruleText);
});

check('2 改快线周期后参数与规则串同步变化', () => {
  const p = previewNl({ text: TEXT, overrides: { fast: 10 } });
  assert.equal(p.ok, true, JSON.stringify(codes(p)));
  assert.equal(p.params.composition.entry.params.fast, 10);
  assert.ok(p.ruleText.indexOf('MA10') >= 0, '规则串必须反映改动：' + p.ruleText);
  assert.ok(p.ruleText.indexOf('MA5') < 0);
});

check('3 倒置均线（fast 10 / slow 8）被引擎挡下，不产生参数', () => {
  const p = previewNl({ text: TEXT, overrides: { fast: 10, slow: 8 } });
  assert.equal(p.ok, false);
  assert.equal(p.params, null);
  assert.equal(p.cardRequest, null);
  assert.ok(codes(p).includes('E_MA_PARAMS'), codes(p).join(','));
});

check('4 没有「固定持有」却改持有天数 → E_OVERRIDE_NO_TARGET', () => {
  const p = previewNl({ text: '突破前20日最高价买入，涨10%止盈', overrides: { days: 3 } });
  assert.equal(p.ok, false);
  assert.ok(codes(p).includes('E_OVERRIDE_NO_TARGET'));
});

check('5 没有「止盈止损」却改止盈 → 拒绝（不许借改参新增条件）', () => {
  const p = previewNl({ text: '均线金叉买入，持有5天卖出', overrides: { takeProfit: 0.2 } });
  assert.equal(p.ok, false);
  assert.ok(codes(p).includes('E_OVERRIDE_NO_TARGET'));
});

check('6 用户显式补止损后，规则串出现止损且参数一致', () => {
  const p = previewNl({ text: TEXT, overrides: { stopLoss: 0.03 } });
  assert.equal(p.ok, true, JSON.stringify(codes(p)));
  const rt = p.params.composition.exits.find((e) => e.type === 'returnThreshold');
  assert.equal(rt.params.stopLoss, 0.03);
  assert.ok(p.ruleText.indexOf('止损 -3%') >= 0, '规则串未反映止损：' + p.ruleText);
});

check('7 MACD 模板参数锁定，改任一项都被拒', () => {
  const p = previewNl({ text: 'MACD金叉买入，死叉卖出', overrides: { fast: 10 } });
  assert.equal(p.ok, false);
  assert.ok(codes(p).includes('E_OVERRIDE_LOCKED'));
});

check('8 非白名单字段被拒', () => {
  const p = previewNl({ text: TEXT, overrides: { magic: 1 } });
  assert.equal(p.ok, false);
  assert.ok(codes(p).includes('E_OVERRIDE_UNKNOWN'));
});

check('9 类型校验：非数字、非整数都被拒', () => {
  assert.ok(codes(previewNl({ text: TEXT, overrides: { fast: '10' } })).includes('E_OVERRIDE_TYPE'));
  assert.ok(codes(previewNl({ text: TEXT, overrides: { days: 1.5 } })).includes('E_OVERRIDE_TYPE'));
  assert.ok(codes(previewNl({ text: TEXT, overrides: { fast: null } })).includes('E_OVERRIDE_TYPE'));
});

check('10 超长文本与空文本被拒', () => {
  const long = previewNl({ text: new Array(MAX_TEXT_CHARS + 2).join('金') });
  assert.ok(codes(long).includes('E_TEXT_TOO_LONG'));
  assert.ok(codes(previewNl({ text: '   ' })).includes('E_TEXT_EMPTY'));
});

check('11 不可执行时 params / cardRequest 恒为 null', () => {
  const bads = [
    { text: 'KDJ金叉买入，持有5天卖出' },
    { text: '5日均线上穿20日均线买入' },
    { text: TEXT, overrides: { fast: 10, slow: 8 } },
    { text: TEXT, overrides: { magic: 1 } },
    { text: '' },
  ];
  for (const b of bads) {
    const p = previewNl(b);
    assert.equal(p.executable, false, JSON.stringify(b));
    assert.equal(p.params, null, JSON.stringify(b));
    assert.equal(p.cardRequest, null, JSON.stringify(b));
    assert.equal(p.ruleText, '', JSON.stringify(b));
  }
});

check('12 可执行产物的 params 能直接创建策略卡', () => {
  for (const ov of [{}, { fast: 10 }, { days: 3 }, { stopLoss: 0.03 }]) {
    const p = previewNl({ text: TEXT, overrides: ov });
    assert.equal(p.ok, true, JSON.stringify(codes(p)));
    const r = buildCard({
      templateId: p.cardRequest.templateId, symbol: '600000',
      startDate: '2024-02-01', endDate: '2024-12-30', initialCapital: 100000,
      params: p.cardRequest.params,
    });
    assert.equal(r.ok, true, JSON.stringify(ov) + ' → ' + r.message);
  }
});

check('13 同一输入两次调用结果逐字节一致', () => {
  const a = JSON.stringify(previewNl({ text: TEXT, overrides: { fast: 10 } }));
  const b = JSON.stringify(previewNl({ text: TEXT, overrides: { fast: 10 } }));
  assert.equal(a, b);
});

console.log(`\n自然语言确认层验收：${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
