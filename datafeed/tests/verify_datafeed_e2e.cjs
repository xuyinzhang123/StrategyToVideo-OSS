/*
 * 数据接口层端到端验证：证明「接口层生成的 CSV」与「手工导出的 CSV」走完全相同的门禁。
 *
 * 不依赖 pytdx、不依赖网络、不依赖真实行情：用 pytdx_fetch 的确定性合成样例走完整
 * 规范化 -> 本地门禁 -> 输出 CSV -> web/src/import/validate.js 校验，断言全部通过。
 *
 * 运行（仓库根目录）：
 *   node datafeed/tests/verify_datafeed_e2e.cjs
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

// 让 Python 用同样的 build_package 生成 CSV 到临时文件（单一事实源，不在 JS 重造逻辑）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-datafeed-e2e-'));
const csvPath = path.join(tmp, 'stock_ohlc.csv');
const metaPath = path.join(tmp, 'meta.json');
const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'datafeed'))})
import pytdx_fetch as P
raw = P._sample_raw(260)
csv_text, meta = P.build_package(raw, "600000", "数据接口层测试", "E2E-SYNTHETIC")
open(${JSON.stringify(csvPath)}, 'w', encoding='utf-8', newline='').write(csv_text)
json.dump(meta, open(${JSON.stringify(metaPath)}, 'w', encoding='utf-8'), ensure_ascii=False)
`;
execFileSync('python', ['-c', py], { cwd: ROOT, stdio: 'inherit' });

const csvText = fs.readFileSync(csvPath, 'utf8');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

check('CSV 文本行数 = 表头1 + 数据260', () => {
  assert.equal(csvText.split('\n').filter((x) => x.length).length, 261);
});
check('元数据 adjust=none / 不含分红表', () => {
  assert.equal(meta.adjust, 'none');
  assert.equal(meta.dividend, 'NOT_INCLUDED');
});
check('接口层产物通过现有 validateImport（stock_ohlc）', () => {
  const r = validateImport({
    dataClass: 'stock_ohlc', csvText, fileName: 'stock_ohlc.csv',
    symbol: '600000', name: '数据接口层测试', adjust: 'none',
  });
  assert.equal(r.ok, true, r.code ? `${r.code}: ${r.message}` : '校验失败');
  assert.equal(r.model.bars.length, 260);
});
check('警告恰为 W_NO_DIVIDENDS（诚实标注未计分红）', () => {
  const r = validateImport({
    dataClass: 'stock_ohlc', csvText, fileName: 'stock_ohlc.csv',
    symbol: '600000', name: '数据接口层测试', adjust: 'none',
  });
  const codes = (r.model.meta.warnings || []).map((w) => w.code);
  assert.deepEqual(codes, ['W_NO_DIVIDENDS']);
});
check('接口层产物喂给 qfq 口径仍被现有门禁拒绝（G-6 未被绕过）', () => {
  const r = validateImport({
    dataClass: 'stock_ohlc', csvText, fileName: 'stock_ohlc.csv',
    symbol: '600000', name: '数据接口层测试', adjust: 'qfq',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_ADJUST_UNVERIFIED');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n数据接口层端到端：${passed}/5 通过`);
if (passed !== 5) process.exitCode = 1;
