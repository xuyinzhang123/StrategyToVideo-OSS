'use strict';
// tools/check_samples.cjs
// 逐份复核 docs/samples/ 的预期结果（DATA_SPEC §9 AC-11 / AC-13 / AC-14）。
//
// 这是「可重复运行」的复现入口，不是单元测试框架：
//   npm run check:samples
//
// 分三部分：
//   A. 类级别判定：A/B 样例走真实校验器；C 类样例必须被门禁拒绝。
//   B. 规则单点：千分位的接受/拒绝（契约 §1.2）、未加引号逗号走列数错误。
//   C. 映射免改码：同一批数据换三种表头，走 mapping 后得到同一模型。

const fs = require('node:fs');
const path = require('node:path');
const { validateImport } = require('../web/src/import/validate');
const { parseCsv } = require('../web/src/csv');
const { parseNumber } = require('../web/src/import/validate');

const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.join(ROOT, 'docs', 'samples');

let pass = 0;
const failures = [];
const notes = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; } else { failures.push(`${name}${detail ? ' → ' + detail : ''}`); }
}

function readSample(file) {
  return fs.readFileSync(path.join(SAMPLES, file), 'utf8');
}

function run(file, dataClass, extra) {
  return validateImport(Object.assign({
    dataClass,
    csvText: readSample(file),
    fileName: file,
  }, extra || {}));
}

// ---------- A. 类级别 ----------

const cases = [
  {
    file: 'timeseries_single.csv', cls: 'timeseries',
    expect: (r) => r.ok && r.model.meta.rowCount === 24 && r.model.series.length === 1,
    desc: '24 行 / 1 条序列 / 通过',
  },
  {
    file: 'timeseries_multi.csv', cls: 'timeseries',
    expect: (r) => r.ok && r.model.meta.rowCount === 36 && r.model.series.length === 3,
    desc: '36 行 / 3 条序列 / 通过',
  },
  {
    file: 'cross_section.csv', cls: 'cross_section',
    expect: (r) => r.ok && r.model.meta.rowCount === 8
      && r.model.rows[0].value === 132.5
      && r.model.meta.shareBasis === 'skipped',
    desc: '8 行 / 降序首行为最大值 / 含负值故不计算占比',
  },
  {
    file: 'warn_timeseries_ragged.csv', cls: 'timeseries',
    // 实际文件：A 10 / B 12 / C 11（A 缺 2025-04、2025-05；C 缺 2025-08）
    expect: (r) => r.ok
      && r.model.meta.pointsPerSeries.A === 10
      && r.model.meta.pointsPerSeries.B === 12
      && r.model.meta.pointsPerSeries.C === 11
      && r.warnings.some((w) => w.code === 'W_RAGGED_SERIES'),
    desc: '33 行 / 点数 10-12-11 / W_RAGGED_SERIES',
  },
  {
    file: 'invalid_timeseries_unordered.csv', cls: 'timeseries',
    expect: (r) => !r.ok && r.code === 'E_DATE_UNORDERED' && r.line === 5,
    desc: 'E_DATE_UNORDERED @ 文件第 5 行（数据第 4 行）',
  },
  {
    file: 'invalid_cross_section_duplicate_label.csv', cls: 'cross_section',
    expect: (r) => !r.ok && r.code === 'E_DUP_LABEL' && /渠道C/.test(r.message),
    desc: 'E_DUP_LABEL 渠道C',
  },
  // C 类：门禁必须先拦住，不能静默算错（AC-14）
  { file: 'stock_ohlc.csv', cls: 'stock_ohlc', expect: (r) => !r.ok && r.code === 'E_CLASS_NOT_IMPLEMENTED', desc: 'E_CLASS_NOT_IMPLEMENTED' },
  { file: 'stock_dividends.csv', cls: 'stock_ohlc', expect: (r) => !r.ok && r.code === 'E_CLASS_NOT_IMPLEMENTED', desc: 'E_CLASS_NOT_IMPLEMENTED' },
  { file: 'warn_stock_calendar_gap.csv', cls: 'stock_ohlc', expect: (r) => !r.ok && r.code === 'E_CLASS_NOT_IMPLEMENTED', desc: 'E_CLASS_NOT_IMPLEMENTED' },
  { file: 'warn_stock_descending.csv', cls: 'stock_ohlc', expect: (r) => !r.ok && r.code === 'E_CLASS_NOT_IMPLEMENTED', desc: 'E_CLASS_NOT_IMPLEMENTED' },
  { file: 'invalid_stock_missing_column.csv', cls: 'stock_ohlc', expect: (r) => !r.ok && r.code === 'E_CLASS_NOT_IMPLEMENTED', desc: 'E_CLASS_NOT_IMPLEMENTED' },
  { file: 'invalid_stock_duplicate_date.csv', cls: 'stock_ohlc', expect: (r) => !r.ok && r.code === 'E_CLASS_NOT_IMPLEMENTED', desc: 'E_CLASS_NOT_IMPLEMENTED' },
  { file: 'invalid_stock_bad_number.csv', cls: 'stock_ohlc', expect: (r) => !r.ok && r.code === 'E_CLASS_NOT_IMPLEMENTED', desc: 'E_CLASS_NOT_IMPLEMENTED' },
];

console.log('=== A. 样例预期结果 ===');
for (const c of cases) {
  const r = run(c.file, c.cls);
  const ok = !!c.expect(r);
  check(c.file, ok, `实际 ${r.ok ? 'through' : r.code}${r.message ? ' / ' + r.message.slice(0, 70) : ''}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.file.padEnd(42)} ${c.desc}`);
}

// ---------- B. 规则单点 ----------

console.log('\n=== B. 千分位规则（契约 §1.2）===');

// B1: 引号内的严格千分位 → E_THOUSANDS_SEPARATOR（在解析层就能识别）
const quoted = parseCsv('date,close\n2024-01-02,"1,234.50"\n');
check('csv: quoted thousands becomes one field',
  quoted.ok && quoted.records[1].fields.length === 2 && quoted.records[1].fields[1].quoted === true,
  quoted.ok ? `fields=${quoted.records[1].fields.length}` : quoted.code);
const numField = quoted.ok ? quoted.records[1].fields[1] : { text: '', quoted: false };
const pn = parseNumber(numField, '第 2 行的数值');
check('number: strict thousands -> E_THOUSANDS_SEPARATOR', pn.code === 'E_THOUSANDS_SEPARATOR', String(pn.code));
console.log(`  ${pn.code === 'E_THOUSANDS_SEPARATOR' ? 'PASS' : 'FAIL'}  引号内 "1,234.50" → E_THOUSANDS_SEPARATOR`);

// B2: 未加引号的千分位 → 列数错误（唯一可确定的判定，不假装识别）
const bare = run('invalid_timeseries_unordered.csv', 'timeseries'); // 占位：先确认正常解析
void bare;
const bareText = 'date,value\n2024-01-31,1,234.5\n2024-02-29,102.4\n';
const bareRes = validateImport({ dataClass: 'timeseries', csvText: bareText, fileName: 'bare.csv' });
check('bare comma -> E_ROW_FIELD_COUNT', !bareRes.ok && bareRes.code === 'E_ROW_FIELD_COUNT', bareRes.code);
console.log(`  ${!bareRes.ok && bareRes.code === 'E_ROW_FIELD_COUNT' ? 'PASS' : 'FAIL'}  未加引号 1,234.5 → E_ROW_FIELD_COUNT`);

// B3: 非严格千分位（1,23.4）在引号内 → E_BAD_NUMBER
const weird = validateImport({
  dataClass: 'timeseries',
  csvText: 'date,value\n2024-01-31,"1,23.4"\n2024-02-29,102.4\n',
  fileName: 'weird.csv',
});
check('quoted 1,23.4 -> E_BAD_NUMBER', !weird.ok && weird.code === 'E_BAD_NUMBER', weird.code);
console.log(`  ${!weird.ok && weird.code === 'E_BAD_NUMBER' ? 'PASS' : 'FAIL'}  引号内 "1,23.4" → E_BAD_NUMBER`);

// B4: 合法科学计数法仍被接受
const sci = validateImport({
  dataClass: 'timeseries',
  csvText: 'date,value\n2024-01-31,1.5e3\n2024-02-29,+2\n',
  fileName: 'sci.csv',
});
check('scientific notation accepted', sci.ok && sci.model.series[0].points[0].value === 1500, sci.ok ? 'ok' : sci.code);
console.log(`  ${sci.ok ? 'PASS' : 'FAIL'}  1.5e3 / +2 仍被接受`);

// ---------- C. 映射免改码 ----------

console.log('\n=== C. 换表头免改源码（契约 §1.7 / AC-13）===');
const rawMulti = readSample('timeseries_multi.csv');
const baseModel = validateImport({ dataClass: 'timeseries', csvText: rawMulti, fileName: 'a.csv' });
check('baseline multi parse', baseModel.ok, baseModel.ok ? '' : baseModel.code);

// 同一批数据的三种表头形态：改列名、改列序都必须只靠 mapping 解决
const rawLines = rawMulti.trimEnd().split(/\r?\n/);
const body = rawLines.slice(1);

const variants = [
  {
    name: '中文表头 + 显式映射',
    head: '成交日期,产品线,销量',
    rows: body,
    mapping: { date: '成交日期', value: '销量', series: '产品线' },
  },
  {
    name: '英文别名 + 无映射',
    head: 'date,series,value',
    rows: body,
    mapping: undefined,
  },
  {
    name: '列顺序不同 + 显式映射',
    head: '销量,成交日期,产品线',
    // 原列序 date,series,value → 新列序 value,date,series
    rows: body.map((l) => { const [d, s, v] = l.split(','); return `${v},${d},${s}`; }),
    mapping: { date: '成交日期', value: '销量', series: '产品线' },
  },
];

for (const v of variants) {
  const text = [v.head].concat(v.rows).join('\n') + '\n';
  const r = validateImport({ dataClass: 'timeseries', csvText: text, fileName: 'v.csv', mapping: v.mapping });
  const same = r.ok && baseModel.ok
    && JSON.stringify(r.model.meta.pointsPerSeries) === JSON.stringify(baseModel.model.meta.pointsPerSeries)
    && r.model.series.map((s) => s.name).join('|') === baseModel.model.series.map((s) => s.name).join('|')
    && JSON.stringify(r.model.series.map((s) => s.points)) === JSON.stringify(baseModel.model.series.map((s) => s.points));
  check(`variant: ${v.name}`, same, r.ok ? 'model differ' : r.code);
  console.log(`  ${same ? 'PASS' : 'FAIL'}  ${v.name}`);
}

// ---------- 汇总 ----------

const total = pass + failures.length;
console.log(`\n=== 汇总：PASS ${pass} / FAIL ${failures.length}（共 ${total} 项）===`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exitCode = 1;
} else {
  notes.push('全部样例与规则单点符合 DATA_SPEC Draft 2。');
  for (const n of notes) console.log('  ' + n);
}
