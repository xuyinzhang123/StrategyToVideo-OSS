/*
 * 东方财富数据接口层端到端验证：证明其产物与手工 CSV 走完全相同的门禁。
 *
 * 与 pytdx 的 E2E 不同，这里分两组：
 *   A. 合成样例（离线、必跑）：确定性地证明规范化/门禁/CSV/validateImport 全链路。
 *   B. 真实样例（可选，存在才跑）：若 datafeed/out/em_600000/stock_ohlc.csv 存在，
 *      额外证明真实东方财富日线也能通过同一门禁；不存在则跳过，不算失败。
 *
 * 运行（仓库根目录）：
 *   node datafeed/tests/verify_eastmoney_e2e.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateImport } = require('../../web/src/import/validate');

const ROOT = path.resolve(__dirname, '..', '..');
let passed = 0;
let skipped = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (e) {
    console.error(`[FAIL] ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
function skip(name, why) {
  skipped += 1;
  console.log(`[SKIP] ${name}  <- ${why}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-eastmoney-e2e-'));
const csvPath = path.join(tmp, 'stock_ohlc.csv');
const metaPath = path.join(tmp, 'meta.json');
const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'datafeed'))})
import eastmoney_fetch as E
raw, dropped = E.parse_klines(E._sample_klines(260), days=260, today='2099-01-01')
csv_text, meta = E.build_package(raw, "600000", "东方财富接口层测试", {"source": "E2E-SYNTHETIC"})
open(${JSON.stringify(csvPath)}, 'w', encoding='utf-8', newline='').write(csv_text)
json.dump(meta, open(${JSON.stringify(metaPath)}, 'w', encoding='utf-8'), ensure_ascii=False)
`;
execFileSync('python', ['-c', py], { cwd: ROOT, stdio: 'inherit' });

const csvText = fs.readFileSync(csvPath, 'utf8');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

check('CSV 文本行数 = 表头1 + 数据260', () => {
  assert.equal(csvText.split('\n').filter((x) => x.length).length, 261);
});
check('元数据 adjust=none / fqt=0 / 不含分红表', () => {
  assert.equal(meta.adjust, 'none');
  assert.equal(meta.dividend, 'NOT_INCLUDED');
});
check('合成产物通过现有 validateImport（stock_ohlc）', () => {
  const r = validateImport({
    dataClass: 'stock_ohlc', csvText, fileName: 'stock_ohlc.csv',
    symbol: '600000', name: '东方财富接口层测试', adjust: 'none',
  });
  assert.equal(r.ok, true, r.code ? `${r.code}: ${r.message}` : '校验失败');
  assert.equal(r.model.bars.length, 260);
});
check('警告恰为 W_NO_DIVIDENDS', () => {
  const r = validateImport({
    dataClass: 'stock_ohlc', csvText, fileName: 'stock_ohlc.csv',
    symbol: '600000', name: '东方财富接口层测试', adjust: 'none',
  });
  assert.deepEqual((r.model.meta.warnings || []).map((w) => w.code), ['W_NO_DIVIDENDS']);
});
check('qfq 口径仍被现有门禁拒绝（G-6 未绕过）', () => {
  const r = validateImport({
    dataClass: 'stock_ohlc', csvText, fileName: 'stock_ohlc.csv',
    symbol: '600000', name: '东方财富接口层测试', adjust: 'qfq',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_ADJUST_UNVERIFIED');
});

// ---- B. 真实样例（存在才跑）----
const realCsv = path.join(ROOT, 'datafeed', 'out', 'em_600000', 'stock_ohlc.csv');
const realMeta = path.join(ROOT, 'datafeed', 'out', 'em_600000', 'meta.json');
if (fs.existsSync(realCsv) && fs.existsSync(realMeta)) {
  const realText = fs.readFileSync(realCsv, 'utf8');
  const realMetaObj = JSON.parse(fs.readFileSync(realMeta, 'utf8'));
  check('真实产物通过现有 validateImport', () => {
    const r = validateImport({
      dataClass: 'stock_ohlc', csvText: realText, fileName: 'stock_ohlc.csv',
      symbol: realMetaObj.symbol || '600000', name: realMetaObj.name || '', adjust: 'none',
    });
    assert.equal(r.ok, true, r.code ? `${r.code}: ${r.message}` : '校验失败');
    assert.equal(r.model.bars.length, realMetaObj.summary.bars);
  });
  check('真实产物不含今天的未收盘 K 线', () => {
    const last = realText.trimEnd().split('\n').pop().split(',')[0];
    const today = new Date().toISOString().slice(0, 10);
    assert.notEqual(last, today, `末行日期 ${last} 不应等于今天（盘中 close 未定）`);
  });
  check('真实产物 meta 记录 fqt=0', () => {
    assert.equal(realMetaObj.fqt, '0');
    assert.equal(realMetaObj.adjust, 'none');
  });
} else {
  skip('真实产物门禁验证', '未找到 datafeed/out/em_600000，先跑 --live');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n东方财富端到端：${passed}/8 通过${skipped ? `，${skipped} 跳过` : ''}`);
if (passed !== 8) process.exitCode = 1;
