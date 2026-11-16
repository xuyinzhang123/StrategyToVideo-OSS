'use strict';
// tools/check_api_contract.cjs
// 校验 /api/health 的能力自述与实际可执行策略一致（V0.2 · PR #1 审查项）。
//
// 背景：V0.2 实装 stock_ohlc 后，health 的 executableStrategies 一度仍只列
// macd / timeseries / cross_section，造成「前端能执行、接口却说不可执行」的口径矛盾。
// 这里直接调用 getHealthInfo()（不启 HTTP 服务），断言三处派生字段同源且包含 C 类。
//
//   npm run check:api

const { getHealthInfo } = require('../web/server');

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) pass += 1;
  else failures.push(`${name}${detail ? ' → ' + detail : ''}`);
}

const h = getHealthInfo();
const caps = h.capabilities || {};
const exec = caps.execution || {};
const list = caps.executableStrategies || [];
const modeKeys = Object.keys(caps.strategyModes || {});

const REQUIRED = ['macd', 'timeseries', 'cross_section', 'stock_ohlc'];
const PRODUCT_EXCLUDED = ['ratio_band', 'dividend_etf']; // V0.1 框架占位，未对用户开放

console.log('=== /api/health 能力口径 ===');
console.log('  executableStrategies:', list.join(', '));
console.log('  execution.strategies :', (exec.strategies || []).join(', '));
console.log('  strategyModes        :', modeKeys.join(', '));

check('health: stock_ohlc in executableStrategies', list.includes('stock_ohlc'), list.join(','));
check('health: execution.strategies == executableStrategies',
  JSON.stringify(exec.strategies || []) === JSON.stringify(list),
  `exec=${(exec.strategies || []).join(',')} | top=${list.join(',')}`);
check('health: strategyModes keys == executableStrategies',
  JSON.stringify(modeKeys) === JSON.stringify(list),
  `modes=${modeKeys.join(',')} | top=${list.join(',')}`);
check('health: all required strategies executable',
  REQUIRED.every((s) => list.includes(s) && caps.strategyModes[s] === 'executable'),
  list.join(','));
check('health:未开放的框架占位不在可执行清单',
  PRODUCT_EXCLUDED.every((s) => !list.includes(s)),
  list.join(','));
check('health: execution.available=true & explicit-confirm',
  exec.available === true && exec.mode === 'explicit-confirm', String(exec.mode));

console.log(`\n=== 汇总：PASS ${pass} / FAIL ${failures.length}（共 ${pass + failures.length} 项）===`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exitCode = 1;
} else {
  console.log('  /api/health 的能力自述与实际可执行策略一致。');
}
