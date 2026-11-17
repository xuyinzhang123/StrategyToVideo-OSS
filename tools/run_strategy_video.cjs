'use strict';
/*
 * 策略卡直出片（CLI 垂直切片）
 * ---------------------------------------------------------------------------
 * 目标：验证最终产品的最短闭环——
 *   用户给一张策略卡（标的 + 区间 + 模板 + 参数）
 *     → 自动取真实未复权日线（东方财富）
 *     → 走统一校验门禁
 *     → runStrategy 生成 backtest_result.json
 *     → 通用策略渲染器出 MP4
 * 不启网页、不改 V0.2 封版链路；数据与产物都落在 output/<run>/（gitignore）。
 *
 * 用法：
 *   node tools/run_strategy_video.cjs --card samples/strategy_cards/close_buy_open_sell_600000.json --run strategy_600000_A
 *   node tools/run_strategy_video.cjs --card ... --run ... --dividends <分红表.csv>
 *
 * 退出码：0 成功；1 取数/校验/回测/渲染失败；2 参数错误。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { validateImport } = require(path.join(ROOT, 'web', 'src', 'import', 'validate'));
const { runStrategy } = require(path.join(ROOT, 'engine_next', 'strategy_engine.cjs'));

function parseArgs(argv) {
  const out = { card: '', run: '', dividends: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--card') out.card = path.resolve(argv[i + 1]);
    if (argv[i] === '--run') out.run = argv[i + 1];
    if (argv[i] === '--dividends') out.dividends = path.resolve(argv[i + 1]);
  }
  return out;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function sha256Text(s) {
  return crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

function isoMinusDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function runPython(args) {
  const r = spawnSync('python', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function requiredWarmup(card) {
  const explicit = Number((card.range && card.range.warmupBars) || 0);
  let need = 1;
  if (card.id === 'macd_cross') need = 34;
  if (card.id === 'close_buy_open_sell') {
    need = (card.params && card.params.entrySignal === 'macd_golden') ? 35 : 1;
  }
  return Math.max(need, Math.min(explicit, 120));
}

function fetchAndValidate(card, dataDir, dividendsText) {
  const need = requiredWarmup(card);
  const attempts = [180, 365, 730];
  let last = null;
  for (const back of attempts) {
    const start = isoMinusDays(card.range.start, back);
    const r = runPython([
      path.join('datafeed', 'eastmoney_fetch.py'),
      '--live', '--code', card.symbol,
      '--name', card.nameOfSecurity || '',
      '--start', start,
      '--end', card.range.end,
      '--out', dataDir,
    ]);
    if (r.code !== 0) {
      last = { stage: 'fetch', code: r.code, message: r.out.trim() };
      continue;
    }
    const csvPath = path.join(dataDir, 'stock_ohlc.csv');
    if (!fs.existsSync(csvPath)) {
      last = { stage: 'fetch', code: 1, message: '取数成功但未生成 stock_ohlc.csv' };
      continue;
    }
    const csvText = fs.readFileSync(csvPath, 'utf8');
    const v = validateImport({
      dataClass: 'stock_ohlc',
      csvText,
      fileName: 'stock_ohlc.csv',
      symbol: card.symbol,
      name: card.nameOfSecurity || card.symbol,
      adjust: (card.data && card.data.adjust) || 'none',
      dividendCsvText: dividendsText || '',
    });
    if (!v.ok) {
      return { ok: false, stage: 'validate', code: v.code, message: v.message };
    }
    const pre = v.model.bars.filter((b) => b.date < card.range.start).length;
    const post = v.model.bars.filter((b) => b.date >= card.range.start && b.date <= card.range.end).length;
    if (pre < need) {
      last = { stage: 'warmup', code: 'E_WARMUP', message: `预热仅 ${pre} 根，需要 ${need} 根；将扩大取数区间重试` };
      continue;
    }
    if (post < 2) {
      return { ok: false, stage: 'range', code: 'E_NO_RANGE', message: '展示区间内不足 2 个交易日' };
    }
    return {
      ok: true,
      csvText,
      csvPath,
      model: v.model,
      pre,
      post,
      fetchStart: start,
      fetchAttempts: back,
      warnings: v.model.meta.warnings || [],
    };
  }
  return { ok: false, stage: last ? last.stage : 'fetch', code: last ? last.code : 'E_FETCH', message: last ? last.message : '取数失败' };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.card || !a.run) {
    console.error('用法：node tools/run_strategy_video.cjs --card <策略卡.json> --run <runId> [--dividends <分红表.csv>]');
    return 2;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(a.run)) {
    console.error('E_ARGS: --run 只能包含字母/数字/下划线/点/短横线');
    return 2;
  }
  if (!fs.existsSync(a.card)) {
    console.error(`找不到策略卡：${a.card}`);
    return 2;
  }
  const card = JSON.parse(fs.readFileSync(a.card, 'utf8'));
  const runDir = path.join(ROOT, 'output', a.run);
  const dataDir = path.join(runDir, '01_data');
  const btDir = path.join(runDir, '02_backtest');
  const videoDir = path.join(runDir, '04_video');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(btDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });

  const dividendsText = a.dividends ? fs.readFileSync(a.dividends, 'utf8') : '';
  if (dividendsText) {
    card.data = Object.assign({}, card.data, { dividendPolicy: 'provided' });
  } else if (card.data && card.data.dividendPolicy === 'provided') {
    console.error('策略卡声明 dividendPolicy=provided，但未传 --dividends；拒绝静默忽略分红。');
    return 2;
  }

  console.log(`[strategy] run=${a.run}`);
  console.log(`[strategy] card=${a.card}`);
  console.log(`[strategy] ${card.symbol} ${card.nameOfSecurity || ''} ${card.range.start} → ${card.range.end} (${card.id})`);

  const fetched = fetchAndValidate(card, dataDir, dividendsText);
  if (!fetched.ok) {
    console.error(`[strategy] ${fetched.stage} 失败（${fetched.code}）：${fetched.message}`);
    return 1;
  }
  console.log(`[strategy] 取数成功：${fetched.model.bars.length} 根（预热 ${fetched.pre} / 展示 ${fetched.post}），` +
    `取数起点 ${fetched.fetchStart}`);
  if (fetched.warnings.length) console.log(`[strategy] 校验警告：${fetched.warnings.map((w) => w.code || w).join(', ')}`);

  fs.writeFileSync(path.join(runDir, '00_card.json'), JSON.stringify(card, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'source.csv'), fetched.csvText, 'utf8');

  const input = { bars: fetched.model.bars, actions: fetched.model.actions || [] };
  let result;
  try {
    result = runStrategy(card, input);
  } catch (e) {
    console.error(`[strategy] 回测失败（${e.code || e.name}）：${e.message}`);
    return 1;
  }
  const resultPath = path.join(btDir, 'backtest_result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`[strategy] 回测完成：${result.market.length} 交易日 / ${result.trades.length} 笔 / ` +
    `期末 ${result.metrics.final} / 收益 ${(result.metrics.totalReturn * 100).toFixed(2)}% / ` +
    `回撤 ${(result.metrics.maxDD * 100).toFixed(2)}%`);
  console.log(`[strategy] resultSha256=${result.reproducibility.resultSha256}`);

  const rr = runPython([
    path.join('engine_next', 'render_strategy_video.py'),
    '--result', path.relative(ROOT, resultPath),
    '--out', path.relative(ROOT, videoDir),
  ]);
  if (rr.code !== 0) {
    console.error(`[strategy] 渲染失败（${rr.code}）：\n${rr.out.trim()}`);
    return 1;
  }
  console.log(rr.out.trim().split(/\r?\n/).map((s) => `  [render] ${s}`).join('\n'));

  const videoPath = path.join(videoDir, 'video.mp4');
  const reportPath = path.join(videoDir, 'render_report.json');
  const summary = {
    ok: true,
    run: a.run,
    card: a.card,
    data: {
      source: 'eastmoney-push2his',
      adjust: 'none',
      bars: fetched.model.bars.length,
      warmupBars: fetched.pre,
      displayBars: fetched.post,
      fetchStart: fetched.fetchStart,
      csvSha256: sha256Text(fetched.csvText),
      warnings: fetched.warnings,
    },
    backtest: {
      result: resultPath,
      resultSha256: result.reproducibility.resultSha256,
      final: result.metrics.final,
      totalReturn: result.metrics.totalReturn,
      maxDD: result.metrics.maxDD,
      trades: result.trades.length,
    },
    video: {
      path: videoPath,
      report: reportPath,
      sha256: sha256File(videoPath),
      bytes: fs.statSync(videoPath).size,
    },
  };
  fs.writeFileSync(path.join(runDir, 'run_result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log('\n=== 完成 ===');
  console.log(JSON.stringify(summary.video, null, 2));
  return 0;
}

process.exit(main());
