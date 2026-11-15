'use strict';
/* ============================================================================
 * Strategy to Video · Open Source V0.1
 * tools/gen_demo_data.cjs — 生成「模拟演示行情」（SIMULATED DATA）
 *
 * 重要声明：
 *   本脚本生成的数据是确定性伪随机合成的，不代表任何真实证券的历史行情，
 *   不包含任何从私人项目迁移的真实 K 线、分红公告或接口响应。
 *   仅用于让开源用户在本机跑通「回测 → 渲染 → 验收 → 预览/下载」全链路。
 *
 * 输出：output/demo_macd_simulated/01_data/
 *         stock_daily.json          模拟日线 + 交易日历 + 模拟现金分红
 *         dividend_calendar.json    模拟派息日历
 *         DEMO_DATA_MANIFEST.json   生成参数 / 文件字节数 / SHA256
 *
 * 用法：node tools/gen_demo_data.cjs
 * ==========================================================================*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'output', 'demo_macd_simulated', '01_data');
const START = '2016-01-04';
const END = '2026-11-06';
const REQUESTED_START = '2016-01-01';
const BASE_PRICE = 5.00;
const SEED = 20261114;

/* 固定种子 LCG：任何机器、任何时间生成结果逐字节一致（可复现，非随机抓数） */
let state = SEED >>> 0;
function rnd() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
}
/* 近似正态（4 个均匀分布之和），用于温和的日内噪声 */
function noise() { return (rnd() + rnd() + rnd() + rnd() - 2) * 0.5; }
const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* ---------- 1. 交易日历：区间内所有工作日（模拟市场，不含真实节假日表） ---------- */
function tradingDays(startIso, endIso) {
  const out = [];
  const d = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso + 'T00:00:00Z');
  while (d <= end) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const dates = tradingDays(START, END);
if (dates[0] !== START || dates[dates.length - 1] !== END) {
  throw new Error('模拟区间端点必须是工作日: ' + dates[0] + ' / ' + dates[dates.length - 1]);
}
const dateSet = new Set(dates);
const prevTradingDay = (i) => dates[i - 1];
const nextTradingDay = (i, k) => dates[i + k];

/* ---------- 2. 模拟日线：趋势 + 双周期波动 + 温和噪声 ---------- */
/* 双周期使 MACD(12,26,9) 自然产生多次金叉/死叉；不硬编码任何信号数或日期。 */
const bars = [];
let prevClose = BASE_PRICE;
for (let i = 0; i < dates.length; i++) {
  const cycleSlow = 0.0022 * Math.sin(i / 41.0 + 0.7);
  const cycleFast = 0.0015 * Math.sin(i / 13.7 + 1.9);
  const drift = 0.00017;
  /* 噪声主导（约为周期信号的 3 倍）：MACD 择时不构成「完美套利」，
     资产曲线与真实演示量级相当，便于观察合理的 Y 轴自适应刻度。 */
  const ret = clamp(drift + cycleSlow + cycleFast + 0.011 * noise(), -0.035, 0.035);
  const open = round2(Math.max(0.5, prevClose * (1 + 0.0018 * noise())));
  const close = round2(Math.max(0.5, open * (1 + ret)));
  const high = round2(Math.max(open, close) * (1 + 0.002 + 0.001 * rnd()));
  const low = round2(Math.min(open, close) * (1 - 0.002 - 0.001 * rnd()));
  const volume = Math.round(900000 + rnd() * 1400000 + 300000 * Math.abs(ret) / 0.035);
  bars.push({
    date: dates[i],
    open, close, high,
    low: Math.min(low, Math.min(open, close)),
    volume,
    amount: Math.round(volume * close * 100) / 100,
  });
  prevClose = close;
}

/* ---------- 3. 模拟现金分红：每年一次，登记日 / 除息日 / 派息日均为交易日 ---------- */
const actions = [];
const payEvents = [];
for (let year = 2016; year <= 2026; year++) {
  const target = year + '-07-08';
  let idx = dates.findIndex((d) => d >= target);
  if (idx < 3 || idx + 4 >= dates.length) continue;
  if (!dateSet.has(dates[idx])) continue;
  const exDate = dates[idx];
  const recordDate = prevTradingDay(idx);
  const payDate = nextTradingDay(idx, 3);
  const cashPerShare = round2(0.180 + (year - 2016) * 0.008);
  const plan = `模拟分红 10派${(cashPerShare * 10).toFixed(3)}元（含税）`;
  actions.push({
    date: exDate,
    recordDate,
    reportDate: (year - 1) + '-12-31',
    cashPerShare,
    shareRatio: 0,
    sendRatio: 0,
    itRatio: 0,
    plan,
    source: 'SIMULATED · tools/gen_demo_data.cjs（非真实公告）',
  });
  payEvents.push({
    date: exDate,
    recordDate,
    payDate,
    cashPerShare,
    shareRatio: 0,
    plan,
    fiscalYear: (year - 1) + '年（模拟）',
    payDateSource: 'SIMULATED',
    recordDateSource: 'SIMULATED',
  });
}

/* ---------- 4. 组装归档（字段与真实归档同构，但所有内容标记为模拟） ---------- */
const DISCLAIMER = 'SIMULATED DEMO DATA — 本文件为确定性合成的模拟演示数据，不代表任何真实证券的历史行情，不可用于投资分析。';
const daily = {
  meta: {
    symbol: '601398',
    market: 1,
    name: '演示标的',
    fullName: 'Strategy to Video 开源演示用模拟标的（非真实证券）',
    board: 'SH_MAIN',
    listingDate: '2006-10-27',
    parValue: 1,
    adjust: 'none（模拟未复权价格）',
    sources: {
      daily: 'SIMULATED · tools/gen_demo_data.cjs 确定性伪随机合成',
      corporateActions: 'SIMULATED · 合成现金分红',
      calendar: 'SIMULATED · 周一至周五工作日',
    },
    endpoints: {},
    requestedStart: REQUESTED_START,
    requestedEnd: END,
    first: dates[0],
    last: dates[dates.length - 1],
    count: bars.length,
    calendarCount: dates.length,
    upstreamTotal: bars.length,
    preKPrice: BASE_PRICE,
    fetchedAt: 'SIMULATED',
    simulated: true,
    disclaimer: DISCLAIMER,
    securityStatus: { declared: 'normal', declaredBasis: '模拟标的，无风险警示', evidence: 'SIMULATED', stPeriods: [] },
  },
  bars,
  calendar: dates.slice(),
  suspensions: [],
  actions,
  actionsOutOfRange: [],
  exChecks: [],
  checks: { simulated: true, generator: 'tools/gen_demo_data.cjs', seed: SEED },
};
const payCal = {
  meta: {
    symbol: '601398',
    simulated: true,
    source: 'SIMULATED · tools/gen_demo_data.cjs（非发行人公告）',
    disclaimer: DISCLAIMER,
    eventCount: payEvents.length,
  },
  events: payEvents,
  checks: { simulated: true },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const dailyPath = path.join(OUT_DIR, 'stock_daily.json');
const calPath = path.join(OUT_DIR, 'dividend_calendar.json');
fs.writeFileSync(dailyPath, JSON.stringify(daily, null, 2) + '\n', 'utf8');
fs.writeFileSync(calPath, JSON.stringify(payCal, null, 2) + '\n', 'utf8');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = {
  notice: DISCLAIMER,
  generatedBy: 'tools/gen_demo_data.cjs',
  seed: SEED,
  interval: { first: dates[0], last: dates[dates.length - 1], requestedStart: REQUESTED_START, requestedEnd: END },
  tradingDays: dates.length,
  cashDividendEvents: actions.length,
  priceModel: 'deterministic LCG noise + dual sine cycles + capped daily return ±3.5%; no real market data',
  files: [
    { file: 'stock_daily.json', bytes: fs.statSync(dailyPath).size, sha256: sha(dailyPath) },
    { file: 'dividend_calendar.json', bytes: fs.statSync(calPath).size, sha256: sha(calPath) },
  ],
};
fs.writeFileSync(path.join(OUT_DIR, 'DEMO_DATA_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('[gen_demo_data] SIMULATED demo data written to ' + path.relative(ROOT, OUT_DIR));
console.log('  trading days : ' + dates.length + '  (' + dates[0] + ' -> ' + dates[dates.length - 1] + ')');
console.log('  dividends    : ' + actions.length);
for (const f of manifest.files) console.log('  ' + f.file + '  ' + f.bytes + ' B  sha256=' + f.sha256);
