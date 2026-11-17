'use strict';
/*
 * 真实数据完整出片（600000 · 东方财富未复权日线）
 * ---------------------------------------------------------------------------
 * 目的：不启网页、不重写任何转换/回测/渲染/验收逻辑，直接复用封版适配器
 *       web/src/adapters/stockOhlc.cjs 的 execute()，把一份真实 stock_ohlc CSV
 *       走完「校验 → 留档 → 八段结构 → 回测 → V1.2.3 渲染 → 41 项验收 → 溯源」。
 * 样板：tools/check_determinism.cjs 的 runOnce（同一套 glue，仅换成 stockOhlc 适配器）。
 *
 * 不修改封版链路任何文件；产物落在 output/<run>/（真实行情数据不入库）。
 *
 * 用法：
 *   node tools/render_real_600000.cjs --run real_600000_A
 *   node tools/render_real_600000.cjs --run real_600000_B   # 第二次独立出片做 SHA 对拍
 * 可选：--csv <path> --symbol 600000 --name 浦发银行 --task <taskDir>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { validateImport } = require(path.join(ROOT, 'web', 'src', 'import', 'validate'));
const { countTextLines } = require(path.join(ROOT, 'web', 'src', 'csv'));
const stockOhlc = require(path.join(ROOT, 'web', 'src', 'adapters', 'stockOhlc.cjs'));

function parseArgs(argv) {
  const out = {
    run: 'real_600000_A',
    csv: path.join(ROOT, 'datafeed', 'out', 'em_600000', 'stock_ohlc.csv'),
    symbol: '600000',
    name: '浦发银行',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--run') out.run = argv[i + 1];
    if (argv[i] === '--csv') out.csv = path.resolve(argv[i + 1]);
    if (argv[i] === '--symbol') out.symbol = argv[i + 1];
    if (argv[i] === '--name') out.name = argv[i + 1];
    if (argv[i] === '--task') out.task = path.resolve(argv[i + 1]);
  }
  return out;
}

function runCommandSync(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(a.csv)) {
    console.error(`找不到真实 CSV：${a.csv}`);
    process.exit(1);
  }
  const csvText = fs.readFileSync(a.csv, 'utf8');
  const fileName = path.basename(a.csv);
  const taskDir = a.task || path.join(ROOT, 'output', `_work_${a.run}`);
  fs.mkdirSync(taskDir, { recursive: true });

  console.log(`[real] run=${a.run}`);
  console.log(`[real] CSV=${a.csv} (${Buffer.byteLength(csvText, 'utf8')} 字节)`);

  // 1) 复用封版门禁校验（无分红表 → W_NO_DIVIDENDS，不推导、不造数据）
  const v = validateImport({
    dataClass: 'stock_ohlc', csvText, fileName,
    symbol: a.symbol, name: a.name, adjust: 'none',
  });
  if (!v.ok) {
    console.error(`[real] 校验未通过（${v.code}）：${v.message}`);
    process.exit(1);
  }
  console.log(`[real] 校验通过：${v.model.bars.length} 根 K 线，` +
    `分红 ${(v.model.actions || []).length}，` +
    `警告 ${JSON.stringify(v.warnings || (v.model.meta && v.model.meta.warnings) || [])}`);

  // 2) 与 taskManager.createTask 同一处理：原样留档 + 指纹注入归一化模型
  const buf = Buffer.from(csvText, 'utf8');
  const sourceSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(path.join(taskDir, 'source.csv'), buf);
  const model = JSON.parse(JSON.stringify(v.model));
  model.meta = Object.assign({}, model.meta, {
    fileName,
    sourceSha256,
    sourceBytes: buf.length,
    sourceLines: countTextLines(csvText),
    sourceNote: '东方财富 push2his 未复权日线',
  });
  fs.writeFileSync(path.join(taskDir, 'import.json'), JSON.stringify(model, null, 2), 'utf8');
  console.log(`[real] 留档 source.csv sha256=${sourceSha256.slice(0, 12)}`);

  // 3) request.source 元数据（溯源用，不在此重算）
  const request = {
    fileName,
    source: {
      fileName,
      sha256: sourceSha256,
      bytes: buf.length,
      lines: countTextLines(csvText),
    },
    dividend: null,
  };

  // 4) 复用封版适配器完整串联（转换/回测/渲染/验收/溯源）
  try {
    const out = await stockOhlc.execute({
      taskId: path.basename(taskDir),
      runId: a.run,
      request,
      taskDir,
      runCommand: (cmd, args) => Promise.resolve(runCommandSync(cmd, args)),
      onStep: (i, st) => console.log(`[real] step ${i} ${st}`),
      logWrite: (line) => console.log(`  [engine] ${line}`),
    });
    const result = JSON.parse(fs.readFileSync(path.join(taskDir, 'run_result.json'), 'utf8'));
    console.log('\n=== 出片结果 ===');
    console.log(JSON.stringify({
      run: a.run,
      mp4: out.mp4,
      video: result.result.video,
      verification: result.result.verification,
      period: result.result.period,
      source: result.result.source,
    }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(`\n[real] 出片失败：${e && e.message ? e.message : e}`);
    const logPath = path.join(taskDir, 'engine.log');
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
      console.error('--- engine.log 末尾 40 行 ---');
      console.error(lines.slice(-40).join('\n'));
    }
    const failPath = path.join(taskDir, 'accept_failures.json');
    if (fs.existsSync(failPath)) {
      console.error('--- accept_failures.json ---');
      console.error(fs.readFileSync(failPath, 'utf8'));
    }
    process.exit(1);
  }
}

main();
