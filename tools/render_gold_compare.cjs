'use strict';
/*
 * 黄金 vs 黄金股ETF 归一化走势对比视频（A 类 timeseries 多序列）
 * ---------------------------------------------------------------------------
 * 目的：不启网页、不重写任何校验/渲染/溯源逻辑，直接复用封版适配器
 *       web/src/adapters/genericChart.cjs 的 timeseries.execute()，把一份
 *       真实数据归一化后的双序列 CSV 走完「校验 → 留档 → 溯源 → 渲染 → 出片」。
 * 样板：tools/check_determinism.cjs 的 runOnce（A 类）与 render_real_600000.cjs 的留档范式。
 *
 * 不修改封版链路任何文件；产物落在 output/<run>/（真实行情数据不入库）。
 *
 * 用法：
 *   node tools/render_gold_compare.cjs --run gold_vs_stock_A
 *   node tools/render_gold_compare.cjs --run gold_vs_stock_B   # 第二次独立出片做 SHA 对拍
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { validateImport } = require(path.join(ROOT, 'web', 'src', 'import', 'validate'));
const { countTextLines } = require(path.join(ROOT, 'web', 'src', 'csv'));
const genericChart = require(path.join(ROOT, 'web', 'src', 'adapters', 'genericChart.cjs'));

const FIXED_IMPORTED_AT = '2026-11-17T00:00:00.000Z'; // 固化时间，保证同输入逐字节一致

function parseArgs(argv) {
  const out = {
    run: 'gold_vs_stock_A',
    csv: path.join(ROOT, 'datafeed', 'out', 'gold_compare', 'gold_vs_goldstock.csv'),
    title: 'COMEX黄金 vs 黄金股ETF 走势对比',
    unit: '归一化指数（起点=100）',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--run') out.run = argv[i + 1];
    if (argv[i] === '--csv') out.csv = path.resolve(argv[i + 1]);
    if (argv[i] === '--title') out.title = argv[i + 1];
    if (argv[i] === '--unit') out.unit = argv[i + 1];
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
    console.error(`找不到归一化 CSV：${a.csv}`);
    process.exit(1);
  }
  const csvText = fs.readFileSync(a.csv, 'utf8');
  const fileName = path.basename(a.csv);
  const taskDir = path.join(ROOT, 'output', `_work_${a.run}`);
  fs.mkdirSync(taskDir, { recursive: true });

  console.log(`[gold] run=${a.run}`);
  console.log(`[gold] CSV=${a.csv} (${Buffer.byteLength(csvText, 'utf8')} 字节)`);

  // 1) 复用封版门禁校验（A 类 timeseries，series 列显式映射）
  const v = validateImport({
    dataClass: 'timeseries', csvText, fileName,
    title: a.title, unit: a.unit, importedAt: FIXED_IMPORTED_AT,
    sourceNote: '东方财富真实日线收盘价，各自归一化到起点=100；金价 COMEX GC00Y，黄金股ETF 517400',
    mapping: { date: 'date', series: 'series', value: 'value' },
  });
  if (!v.ok) {
    console.error(`[gold] 校验未通过（${v.code}）：${v.message}`);
    process.exit(1);
  }
  const seriesInfo = (v.model.series || []).map((s) => `${s.name}:${s.points.length}点`).join(' / ');
  console.log(`[gold] 校验通过：${v.model.meta.seriesNames.length} 条序列（${seriesInfo}），` +
    `记录 ${v.model.meta.rowCount}，警告 ${JSON.stringify(v.model.meta.warnings || [])}`);

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
  });
  fs.writeFileSync(path.join(taskDir, 'import.json'), JSON.stringify(model, null, 2), 'utf8');
  console.log(`[gold] 留档 source.csv sha256=${sourceSha256.slice(0, 12)}`);

  const request = {
    fileName,
    source: {
      fileName, sha256: sourceSha256, bytes: buf.length, lines: countTextLines(csvText),
    },
  };

  // 3) 复用封版 A 类适配器完整串联（溯源 + 渲染 + 勾稽）
  try {
    const out = await genericChart.timeseries.execute({
      taskId: path.basename(taskDir),
      runId: a.run,
      request,
      taskDir,
      PROJECT_ROOT: ROOT,
      OUTPUT_DIR: path.join(ROOT, 'output'),
      runCommand: (cmd, args) => Promise.resolve(runCommandSync(cmd, args)),
      onStep: (i, st) => console.log(`[gold] step ${i} ${st}`),
      logWrite: (line) => console.log(`  [engine] ${line}`),
    });
    const result = JSON.parse(fs.readFileSync(path.join(taskDir, 'run_result.json'), 'utf8'));
    console.log('\n=== 出片结果 ===');
    console.log(JSON.stringify({
      run: a.run,
      mp4: out.mp4,
      video: result.result.video,
      verification: result.result.verification,
      source: result.result.source,
    }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(`\n[gold] 出片失败：${e && e.message ? e.message : e}`);
    const logPath = path.join(taskDir, 'engine.log');
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
      console.error('--- engine.log 末尾 40 行 ---');
      console.error(lines.slice(-40).join('\n'));
    }
    process.exit(1);
  }
}

main();
