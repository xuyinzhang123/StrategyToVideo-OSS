'use strict';
// tools/check_strategy_card_api.cjs
// 策略卡通道（自动取数）的离线回归：校验 / 任务装配 / 能力自述。
// 不联网、不渲染、不执行回测，只验证「网页能收到什么、会被拒什么、落盘成什么」。
//
//   node tools/check_strategy_card_api.cjs

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 独立临时任务目录，避免污染 web/tasks（必须在 require taskManager 之前设置）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-card-'));
process.env.WEB_TASKS_DIR = TMP;

const { validateTaskRequest } = require('../web/src/validation');
const TM = require('../web/src/taskManager');
const { getHealthInfo } = require('../web/server');
const sc = require('../web/src/strategyCard');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); } else {
    failures.push(name + (detail ? ' → ' + detail : ''));
    console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`);
  }
}

function base(over) {
  return Object.assign({
    strategy: 'strategy_card',
    templateId: 'close_buy_open_sell',
    symbol: '600000',
    name: '浦发银行',
    startDate: '2024-01-02',
    endDate: '2026-11-16',
    initialCapital: 100000,
  }, over || {});
}

console.log('=== 1) 校验：合法请求 ===');
{
  const r = validateTaskRequest(base({ params: { entrySignal: 'macd_golden', holdIfGte: 0.02 } }));
  check('合法请求通过', r.ok, r.message);
  const card = r.ok ? r.value.card : {};
  check('schemaVersion=1.0', card.schemaVersion === '1.0', String(card.schemaVersion));
  check('id 来自模板', card.id === 'close_buy_open_sell', card.id);
  check('adjust 固定 none', card.data && card.data.adjust === 'none', JSON.stringify(card.data));
  check('dividendPolicy 无分红表时 ignored', card.data && card.data.dividendPolicy === 'ignored', JSON.stringify(card.data));
  check('auctionFilter 正确装配',
    card.params && card.params.auctionFilter && card.params.auctionFilter.holdIfGte === 0.02
      && card.params.auctionFilter.basis === 'open_gap_pct',
    JSON.stringify(card.params));
  check('execution 100 股整数倍 + 资金',
    card.execution && card.execution.lotSize === 100 && card.execution.initialCapital === 100000,
    JSON.stringify(card.execution));
  check('标题含证券名与模板名', typeof r.value.title === 'string' && r.value.title.includes('浦发银行'), r.value.title);
}

console.log('=== 2) 校验：必须拒绝的输入 ===');
const bad = [
  ['创业板 300750', base({ symbol: '300750' }), 'E_UNSUPPORTED_BOARD'],
  ['科创板 688981', base({ symbol: '688981' }), 'E_UNSUPPORTED_BOARD'],
  ['非 6 位代码', base({ symbol: '60000' }), 'E_SYMBOL'],
  ['未知模板', base({ templateId: 'grid_trade' }), 'E_TEMPLATE_UNSUPPORTED'],
  ['日期格式错', base({ startDate: '2024/01/02' }), 'E_DATE_FORMAT'],
  ['日期倒序', base({ startDate: '2025-01-02', endDate: '2024-01-02' }), 'E_DATE_ORDER'],
  ['早于 2015-08-01', base({ startDate: '2014-01-02' }), 'E_DATE_OUT_OF_RANGE'],
  ['资金低于下限', base({ initialCapital: 5000 }), 'E_PRINCIPAL_INVALID'],
  ['未知字段', base({ outputDir: '/tmp/x' }), 'E_FORBIDDEN_FIELD'],
  ['未知顶层字段', base({ foo: 1 }), 'E_UNKNOWN_FIELD'],
  ['MACD 参数被改', base({ templateId: 'macd_cross', params: { fast: 5 } }), 'E_PARAMS'],
  ['跳空阈值越界', base({ params: { holdIfGte: 0.5 } }), 'E_PARAMS'],
  ['策略不匹配的字段', base({ templateId: 'macd_cross', params: { entrySignal: 'always' } }), 'E_PARAMS'],
];
for (const [name, body, expectCode] of bad) {
  const r = validateTaskRequest(body);
  check(`拒绝：${name}`, !r.ok && r.code === expectCode, r.ok ? '意外通过' : `${r.code} / ${r.message}`);
}

console.log('=== 3) 任务落盘 ===');
{
  const v = validateTaskRequest(base({ params: { holdIfGte: 0.02 } }));
  const created = TM.createTask(v.value);
  const dir = TM.taskDir(created.taskId);
  check('任务目录已建立', fs.existsSync(dir));
  check('request.json 存在且含 card', fs.existsSync(path.join(dir, 'request.json'))
    && TM.getRequest(created.taskId).card.symbol === '600000');
  check('card.json 与 request.card 一致',
    JSON.stringify(TM.readTaskFile(created.taskId, 'card.json')) === JSON.stringify(TM.getRequest(created.taskId).card));
  const st = TM.getTask(created.taskId);
  check('status=queued 且 strategy=strategy_card', st.status === 'queued' && st.strategy === 'strategy_card',
    `${st.status}/${st.strategy}`);
  check('摘要字段可用于工作区', st.symbol === '600000' && st.startDate === '2024-01-02' && st.initialCapital === 100000,
    JSON.stringify({ symbol: st.symbol, startDate: st.startDate, cap: st.initialCapital }));
  check('queued 阶段不伪造 source.csv', !fs.existsSync(path.join(dir, 'source.csv')));
}

console.log('=== 4) 分红表留档 ===');
{
  const div = 'ex_date,record_date,pay_date,cash_per_share\n2024-07-01,2024-07-02,2024-07-10,0.3\n';
  const v = validateTaskRequest(base({ dividendCsvText: div }));
  check('有分红表时 dividendPolicy=provided', v.ok && v.value.card.data.dividendPolicy === 'provided',
    v.ok ? v.value.card.data.dividendPolicy : v.message);
  const created = TM.createTask(v.value);
  const p = path.join(TM.taskDir(created.taskId), 'dividend.csv');
  check('dividend.csv 按原文留档', fs.existsSync(p) && fs.readFileSync(p, 'utf8') === div);
  check('status.dividend 记录 sha256', !!TM.getTask(created.taskId).dividend.sha256);
}

console.log('=== 5) 能力自述 ===');
{
  const h = getHealthInfo();
  const list = h.capabilities.executableStrategies || [];
  check('health 列出 strategy_card', list.includes('strategy_card'), list.join(','));
  check('strategyModes 与 executableStrategies 同源',
    JSON.stringify(Object.keys(h.capabilities.strategyModes)) === JSON.stringify(list));
}

console.log('=== 6) 预热根数口径 ===');
{
  // 口径：max(模板最低需求, 声明 warmupBars)，上限 120；声明值只作下限以上的加码
  check('macd_cross 声明 10 根时抬到 34',
    sc.requiredWarmup({ id: 'macd_cross', range: { warmupBars: 10 } }) === 34,
    String(sc.requiredWarmup({ id: 'macd_cross', range: { warmupBars: 10 } })));
  check('金叉入场声明 10 根时抬到 35',
    sc.requiredWarmup({ id: 'close_buy_open_sell', params: { entrySignal: 'macd_golden' }, range: { warmupBars: 10 } }) === 35,
    String(sc.requiredWarmup({ id: 'close_buy_open_sell', params: { entrySignal: 'macd_golden' }, range: { warmupBars: 10 } })));
  check('默认策略卡（warmupBars=60）取 60',
    sc.requiredWarmup({ id: 'macd_cross', range: { warmupBars: 60 } }) === 60);
  check('声明过大时封顶 120',
    sc.requiredWarmup({ id: 'macd_cross', range: { warmupBars: 2000 } }) === 120,
    String(sc.requiredWarmup({ id: 'macd_cross', range: { warmupBars: 2000 } })));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n策略卡通道回归：${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.log('未通过：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
