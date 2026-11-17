'use strict';
// web/src/adapters/strategyCard.cjs
// 策略卡（自动取数）适配器：网页端「陌生人输入策略 → 得到回测视频」的主链路。
//
// 与 stock_ohlc 的区别：用户不再上传 CSV，而是给出「证券代码 + 区间 + 模板 + 少量参数」，
// 由本适配器自动取东方财富未复权日线，再走与 CLI（tools/run_strategy_video.cjs）完全相同的
// 校验 → runStrategy → 通用策略渲染 → 首版验收。
//
// 约束：
//   1. 不重写回测逻辑：一律调用 engine_next/strategy_engine.cjs 的 runStrategy。
//   2. 不改封版链路：stock_ohlc / macd / timeseries / cross_section 一行不动。
//   3. 复权口径固定 none（G-6）；分红必须由用户提供，不自动推导。
//   4. 取数失败不伪造数据：直接把 E_FETCH 抛给上层，任务标 failed，绝不产出空片。
//   5. 原始 CSV 落到任务目录 source.csv 留档，供日后复核；视频页脚印结果指纹。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT } = require('../paths');
const { validateImport } = require('../import/validate');
const { runStrategy, validateCard } = require('../../../engine_next/strategy_engine.cjs');
const sc = require('../strategyCard');
// 溯源构造复用 C 类的纯函数：按行号回读 source.csv，逐字段比对 K 线与分红。
// 单点维护，避免策略卡通道另写一份「看起来差不多」的核对逻辑。
const { buildStockTrace } = require('./stockOhlc.cjs');

const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'datafeed', 'eastmoney_fetch.py');
const RENDER_SCRIPT = path.join(PROJECT_ROOT, 'engine_next', 'render_strategy_video.py');
const ACCEPT_SCRIPT = path.join(PROJECT_ROOT, 'engine_next', 'tests', 'accept_strategy_video.py');

const STEPS = [
  '校验策略卡与区间',
  '自动取数（东方财富未复权日线）',
  '统一门禁校验（DATA_SPEC）',
  '策略回测（统一结果契约）',
  '通用策略视频渲染',
  '首版独立验收（10 项）',
];

// 取数窗口递增：MACD 预热需要 35 根以上，遇到长假/停牌给更大余量。
const FETCH_BACKOFF_DAYS = [180, 365, 730];

function sha256Text(s) {
  return crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function isoMinusDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function resolvePython() {
  for (const cmd of [process.env.STV_PYTHON, 'python', 'python3']) {
    if (!cmd) continue;
    const r = spawnSync(cmd, ['--version'], { timeout: 8000, encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

// 验收脚本输出：`[PASS] 名称` / `[FAIL] 名称  <- 详情` / 末行「策略视频验收：10/10 通过」
function parseAccept(out) {
  const text = String(out || '');
  const m = /策略视频验收：(\d+)\s*\/\s*(\d+)\s*通过/.exec(text);
  const failures = [];
  for (const line of text.split(/\r?\n/)) {
    const f = /^\s*\[FAIL\]\s*(.+?)(?:\s{2,}<-?\s*(.*))?$/.exec(line);
    if (f) failures.push({ name: f[1].trim(), detail: (f[2] || '').trim() });
  }
  return {
    pass: m ? Number(m[1]) : null,
    total: m ? Number(m[2]) : null,
    failures,
  };
}

async function execute(ctx) {
  const { taskId, runId, request, taskDir, runCommand, onStep, logWrite } = ctx;
  const card = request && request.card;
  if (!card) {
    throw { code: 'E_CARD_MISSING', message: '任务缺少策略卡（request.card），请新建任务重试' };
  }

  // ---- 0) 策略卡二次校验 ----
  onStep(0, 'running');
  try {
    validateCard(card);
  } catch (e) {
    throw { code: e.code || 'E_CARD', message: e.message || '策略卡校验失败' };
  }
  if (card.range.start < sc.MIN_START) {
    throw { code: 'E_DATE_OUT_OF_RANGE', message: `开始日期不能早于 ${sc.MIN_START}` };
  }
  const need = sc.requiredWarmup(card);
  logWrite(`card id=${card.id} symbol=${card.symbol} ${card.range.start}~${card.range.end} warmupNeed=${need} ` +
    `dividendPolicy=${card.data.dividendPolicy}`);
  onStep(0, 'done');

  const python = resolvePython();
  if (!python) throw { code: 'E_PYTHON_MISSING', message: '未找到可用的 Python（python / python3），无法取数与渲染视频' };

  const runDir = path.join(OUTPUT_DIR, runId);
  const dataDir = path.join(runDir, '01_data');
  const btDir = path.join(runDir, '02_backtest');
  const videoDir = path.join(runDir, '04_video');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(btDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });

  // 分红表：创建任务时已留档为 dividend.csv，这里只读，不改写
  const divPath = path.join(taskDir, 'dividend.csv');
  const dividendText = fs.existsSync(divPath) ? fs.readFileSync(divPath, 'utf8') : '';
  if (card.data.dividendPolicy === 'provided' && !dividendText) {
    throw { code: 'E_DIVIDEND_MISSING', message: '策略卡声明 dividendPolicy=provided，但任务目录没有分红表留档' };
  }

  // ---- 1) 自动取数 ----
  onStep(1, 'running');
  let fetched = null;
  let lastError = null;
  for (const back of FETCH_BACKOFF_DAYS) {
    const fetchStart = isoMinusDays(card.range.start, back);
    logWrite(`fetch attempt: ${fetchStart} ~ ${card.range.end} (back=${back})`);
    const r = await runCommand(python, [
      FETCH_SCRIPT, '--live',
      '--code', card.symbol,
      '--name', card.nameOfSecurity || '',
      '--start', fetchStart,
      '--end', card.range.end,
      '--out', dataDir,
    ]);
    if (r.code !== 0) {
      lastError = {
        stage: 'fetch',
        code: 'E_FETCH',
        message: `东方财富取数失败（退出码 ${r.code}）：${String(r.err || r.out || '').trim().slice(0, 300) || '无输出'}`,
      };
      continue;
    }
    const csvPath = path.join(dataDir, 'stock_ohlc.csv');
    if (!fs.existsSync(csvPath)) {
      lastError = { stage: 'fetch', code: 'E_FETCH_EMPTY', message: '取数命令成功但未生成 stock_ohlc.csv' };
      continue;
    }
    const csvText = fs.readFileSync(csvPath, 'utf8');
    const v = validateImport({
      dataClass: 'stock_ohlc',
      csvText,
      fileName: 'stock_ohlc.csv',
      symbol: card.symbol,
      name: card.nameOfSecurity || card.symbol,
      adjust: 'none',
      dividendCsvText: dividendText,
    });
    if (!v.ok) {
      throw { code: v.code || 'E_VALIDATE', message: `取到的数据未通过统一门禁：${v.message}` };
    }
    const pre = v.model.bars.filter((b) => b.date < card.range.start).length;
    const post = v.model.bars.filter((b) => b.date >= card.range.start && b.date <= card.range.end).length;
    if (pre < need) {
      lastError = {
        stage: 'warmup',
        code: 'E_WARMUP',
        message: `预热仅 ${pre} 根，需要 ${need} 根；将扩大取数区间重试`,
      };
      continue;
    }
    if (post < 2) {
      throw { code: 'E_NO_RANGE', message: `展示区间内不足 2 个交易日（实际 ${post} 个），请调整起止日期` };
    }
    fetched = {
      csvText,
      model: v.model,
      pre,
      post,
      fetchStart,
      warnings: (v.warnings || []).map((w) => ({ code: w.code, message: w.message })),
    };
    break;
  }
  if (!fetched) {
    throw {
      code: lastError ? lastError.code : 'E_FETCH',
      message: (lastError ? lastError.message : '取数失败')
        + '。本版依赖东方财富公开日线接口，请确认本机网络可访问（代理/防火墙可能拦截）。',
    };
  }

  // 原始 CSV 留档到任务目录，供 /api/tasks/<id>/source 下载与日后复核
  const csvBuf = Buffer.from(fetched.csvText, 'utf8');
  fs.writeFileSync(path.join(taskDir, 'source.csv'), csvBuf);
  const csvSha = sha256Text(fetched.csvText);
  const metaPath = path.join(dataDir, 'meta.json');
  const fetchMeta = fs.existsSync(metaPath) ? readJson(metaPath) : {};
  fs.writeFileSync(path.join(taskDir, 'data_manifest.json'), JSON.stringify({
    kind: 'EASTMONEY_PUSH2HIS',
    symbol: card.symbol,
    name: card.nameOfSecurity,
    fetchStart: fetched.fetchStart,
    fetchEnd: card.range.end,
    bars: fetched.model.bars.length,
    warmupBars: fetched.pre,
    displayBars: fetched.post,
    adjust: 'none',
    csvSha256: csvSha,
    excludedUnclosedDate: fetchMeta.excludedUnclosedDate || null,
    fetchedAt: fetchMeta.fetchedAt || null,
    source: '东方财富公开日线接口（klt=101, fqt=0 未复权）',
    note: '取数窗口自动向前扩展以保证 MACD 预热；展示区间与预热区间以 strategy card range 为准',
  }, null, 2), 'utf8');
  logWrite(`fetch ok: bars=${fetched.model.bars.length} warmup=${fetched.pre} display=${fetched.post} sha=${csvSha.slice(0, 12)}`);
  onStep(1, 'done');

  // ---- 2) 统一门禁已通过，落策略卡与输入 ----
  onStep(2, 'running');
  fs.writeFileSync(path.join(runDir, '00_card.json'), JSON.stringify(card, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'source.csv'), csvBuf);

  // 溯源核对：按行号回读刚取到的 CSV，逐字段比对 K 线与分红。
  // 放在回测/渲染之前——对不上就不该浪费一次渲染，更不该交付无法回溯的视频。
  const traceBuild = buildStockTrace(fetched.model, fetched.csvText, dividendText);
  if (!traceBuild.ok) {
    throw { code: 'E_TRACE_FAILED', message: `${traceBuild.message}（已停止交付，未生成可下载视频）` };
  }
  logWrite(`trace ok: ${traceBuild.data.verification.verified} 条记录行号回读一致`);
  logWrite(`gate ok: ${fetched.warnings.length} warning(s)`);
  onStep(2, 'done');

  // ---- 3) 回测（统一结果契约） ----
  onStep(3, 'running');
  let result;
  try {
    result = runStrategy(card, { bars: fetched.model.bars, actions: fetched.model.actions || [] });
  } catch (e) {
    throw { code: e.code || 'E_BACKTEST_FAILED', message: `策略回测失败：${e.message}` };
  }
  const resultPath = path.join(btDir, 'backtest_result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  logWrite(`backtest ok: market=${result.market.length} trades=${result.trades.length} ` +
    `final=${result.metrics.final} resultSha=${result.reproducibility.resultSha256.slice(0, 12)}`);
  onStep(3, 'done');

  // ---- 4) 渲染 ----
  onStep(4, 'running');
  const rd = await runCommand(python, [
    RENDER_SCRIPT,
    '--result', path.relative(PROJECT_ROOT, resultPath),
    '--out', path.relative(PROJECT_ROOT, videoDir),
  ]);
  const mp4 = path.join(videoDir, 'video.mp4');
  const reportPath = path.join(videoDir, 'render_report.json');
  if (rd.code !== 0 || !fs.existsSync(mp4) || !fs.existsSync(reportPath)) {
    throw {
      code: 'E_RENDER_FAILED',
      message: `策略视频渲染失败（退出码 ${rd.code}）：${String(rd.err || rd.out || '').trim().slice(0, 300)}`,
    };
  }
  logWrite(`render ok: bytes=${fs.statSync(mp4).size}`);
  onStep(4, 'done');

  // ---- 5) 首版验收 ----
  onStep(5, 'running');
  const ac = await runCommand(python, [ACCEPT_SCRIPT, '--run', runId]);
  const acc = parseAccept(ac.out + '\n' + (ac.err || ''));
  fs.writeFileSync(path.join(taskDir, 'accept_failures.json'), JSON.stringify({
    runId,
    script: 'engine_next/tests/accept_strategy_video.py',
    exitCode: ac.code,
    pass: acc.pass,
    total: acc.total,
    items: acc.failures,
    note: '首版 10 项：结果契约自洽 + 报告勾稽 + 主图非空；像素级细验为后续独立任务',
  }, null, 2), 'utf8');
  if (ac.code !== 0 || (acc.total !== null && acc.pass !== acc.total)) {
    throw {
      code: 'E_VERIFY_FAILED',
      message: `策略视频首版验收未通过（PASS ${acc.pass === null ? '?' : acc.pass} / 共 ${acc.total === null ? '?' : acc.total}）`
        + (acc.failures.length ? `：${acc.failures.slice(0, 3).map((f) => f.name).join('；')}` : '')
        + '。明细见任务目录 accept_failures.json 与 engine.log。',
      acceptance: { pass: acc.pass, fail: acc.total === null ? null : acc.total - acc.pass },
      failures: acc.failures,
    };
  }
  logWrite(`accept ok: ${acc.pass}/${acc.total}`);
  onStep(5, 'done');

  const R = readJson(reportPath);
  const videoSha = sha256File(mp4);
  const videoBytes = fs.statSync(mp4).size;

  const resultPayload = {
    templateId: card.id,
    templateName: card.name,
    symbol: card.symbol,
    name: card.nameOfSecurity,
    period: { start: result.market[0].date, end: result.market[result.market.length - 1].date },
    initialCapital: result.metrics.initialCapital,
    final: result.metrics.final,
    totalReturn: result.metrics.totalReturn,
    maxDD: result.metrics.maxDD,
    trades: result.trades.length,
    marketDays: result.market.length,
    holdFinal: result.metrics.benchmark ? result.metrics.benchmark.final : null,
    totalFees: result.metrics.totalFees,
    totalDividendTax: result.metrics.totalDividendTax,
    resultSha256: result.reproducibility.resultSha256,
    source: {
      kind: 'EASTMONEY_PUSH2HIS',
      adjust: 'none',
      fetchStart: fetched.fetchStart,
      fetchEnd: card.range.end,
      bars: fetched.model.bars.length,
      warmupBars: fetched.pre,
      displayBars: fetched.post,
      csvSha256: csvSha,
      excludedUnclosedDate: fetchMeta.excludedUnclosedDate || null,
      fetchedAt: fetchMeta.fetchedAt || null,
      warnings: fetched.warnings,
      note: '东方财富公开日线接口，未复权；分红表由用户提供，未提供则不含现金分红',
    },
    video: {
      width: R.width || null,
      height: R.height || null,
      fps: R.fps || null,
      frames: R.frames || null,
      durationSec: R.durationSec || null,
      sha256: videoSha,
      bytes: videoBytes,
    },
    verification: {
      script: 'engine_next/tests/accept_strategy_video.py',
      pass: acc.pass,
      total: acc.total,
    },
    trace: traceBuild.data.verification,
  };

  const strategySpecific = {
    templateId: card.id,
    templateName: card.name,
    card,
    dataArchive: {
      file: 'source.csv',
      sha256: csvSha,
      bytes: csvBuf.length,
      bars: fetched.model.bars.length,
      warmupBars: fetched.pre,
      displayBars: fetched.post,
      fetchStart: fetched.fetchStart,
      fetchEnd: card.range.end,
    },
    videoVersion: 'strategy-video-v0.1',
  };

  // 溯源清单（与 A/B/C 类同契约）：源文件指纹 + 逐条 {位置, 数值, sourceLine, sourceText} + 视频指纹。
  const traceability = Object.assign({
    taskId,
    generatedAt: new Date().toISOString(),
    source: {
      fileName: 'source.csv',
      archivedAs: 'source.csv',
      sha256: csvSha,
      bytes: csvBuf.length,
      bars: fetched.model.bars.length,
      fetchedAt: fetchMeta.fetchedAt || null,
      kind: 'EASTMONEY_PUSH2HIS',
      adjust: 'none',
    },
    dividend: request.dividend || null,
    video: {
      file: 'video.mp4',
      sha256: videoSha,
      bytes: videoBytes,
      frames: R.frames || null,
      fps: R.fps || null,
      durationSec: R.durationSec || null,
      width: R.width || null,
      height: R.height || null,
    },
  }, traceBuild.data);
  fs.writeFileSync(path.join(taskDir, 'traceability.json'), JSON.stringify(traceability, null, 2), 'utf8');

  fs.writeFileSync(path.join(taskDir, 'run_result.json'), JSON.stringify({
    result: resultPayload,
    strategySpecific,
  }, null, 2), 'utf8');

  logWrite(`video sha256=${videoSha} bytes=${videoBytes}`);
  return { mp4, result: resultPayload, strategySpecific };
}

module.exports = {
  id: 'strategy_card',
  STEPS,
  execute,
  parseAccept,
};
