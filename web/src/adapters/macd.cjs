'use strict';
// web/src/adapters/macd.cjs
// Open Source V0.1：SIMULATED 模拟数据「长期持有 vs MACD 金叉死叉」视频 V1.2.2 适配器。
//
// 设计要点（任务书 §一~§五）：
//   1. 全部 MACD 专属逻辑在本文件，engineBridge.js 只做通用编排与策略路由。
//   2. 参数锁定：模拟标的 / 本金 100000 / 区间 2016-01-04~2026-11-06 / MACD 12-26-9 /
//      V1.2.2 / 1920x1080@30。不宣称支持任意本金、任意日期或任意标的。
//      模拟归档的 data.start 请求值为 2016-01-01，首个模拟交易日为 2016-01-04；本适配器不改写日期。
//   3. 离线可复现：只读取「随包附带的模拟演示归档」output/demo_macd_simulated/01_data，
//      绝不联网取数，也不附带任何真实历史行情。
//      缺少归档 → E_DATA_MISSING 并列出缺失文件，不联网补齐。
//   4. 所有运行配置从封版配置「深拷贝」生成到任务目录，仅覆盖 run_id /
//      source_run_id，绝不修改封版配置文件本身。
//   5. 回测输出目录与视频 source_run_id 的关系（已读源码核实）：
//        backtest_stock_macd.cjs --run <runId>  → output/<runId>/02_backtest_macd/
//        render_stock_macd_v122.py 读 CFG.source_run_id → output/<runId>/02_backtest_macd/
//                             --run <runId>      → output/<runId>/04_video/
//        accept_macd_video_v122.py --run <runId> --source <runId>
//      故把视频配置的 source_run_id 也设为同一个新 runId，所有产物自洽且不覆盖封版。
//   6. 结果数字一律从本次回测/渲染产物读取，不硬编码任何封版预期值。
//   7. 不修改封版回测算法、V1.2.2 渲染逻辑、baselines 与历史视频。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT } = require('../paths');

const ENGINE_DIR = path.join(PROJECT_ROOT, 'engine_next');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

// 开源演示版默认读取随包附带的「模拟数据」run（由 tools/gen_demo_data.cjs 生成）。
// 仍可用 STV_MACD_SOURCE_RUN 指向其他离线归档 run；本版不附带任何真实行情归档。
const SOURCE_RUN = 'demo_macd_simulated';

function sourceRun() {
  return process.env.STV_MACD_SOURCE_RUN || SOURCE_RUN;
}

// 每次执行时动态解析，便于缺失检测；默认指向随包生成的确定性模拟数据。
function archiveRequired() {
  const base = path.join(OUTPUT_DIR, sourceRun(), '01_data');
  return [
    path.join(base, 'stock_daily.json'),
    path.join(base, 'dividend_calendar.json'),
  ];
}

const SEALED_FILES = {
  backtestConfig: path.join(ENGINE_DIR, 'config.stock_macd.json'),
  videoConfig: path.join(ENGINE_DIR, 'config.stock_macd_video_v122.json'),
  backtestScript: path.join(ENGINE_DIR, 'backtest_stock_macd.cjs'),
  renderScript: path.join(ENGINE_DIR, 'render_stock_macd_v122.py'),
  acceptScript: path.join(ENGINE_DIR, 'tests', 'accept_macd_video_v122.py'),
};

// 离线复现必需的两个归档文件（raw/ 下的原始接口响应不是回测输入，不复制大缓存）
// 保留默认常量导出，供迁移清单与既有代码引用；实际检测走 archiveRequired()。
const ARCHIVE_REQUIRED = archiveRequired();

// 本轮网页锁定参数（与封版配置一致；区间展示用真实首个交易日）
const LOCKED = {
  symbol: '601398',
  principal: 100000,
  startDate: '2016-01-04', // 模拟归档首日；配置请求值为 2016-01-01
  endDate: '2026-11-06',
  macd: { fast: 12, slow: 26, signal: 9 },
  video: { resolution: '1920x1080', fps: 30 },
};

// 真实可观测阶段（前端据此展示，不虚构百分比）
const STEPS = [
  '离线归档检查与配置副本',
  '真实回测（MACD 12/26/9）',
  '视频渲染（V1.2.2）',
  'V1.2.2 独立验收（数据一致性 / 遮挡 / 平滑度）',
];

function runIdForTask(taskId) {
  return 'web_' + String(taskId).replace(/-/g, '');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function resolvePython() {
  for (const cmd of [process.env.STV_PYTHON, 'python', 'python3']) {
    if (!cmd) continue;
    const r = spawnSync(cmd, ['--version'], { timeout: 8000, encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

// 纵深防御：即使绕过前端，网页也只能提交锁定参数
function assertLockedParams(request) {
  if (!request) throw { code: 'E_PARAM_LOCKED', message: '缺少任务参数，请新建任务重试' };
  if (Number(request.principal) !== LOCKED.principal) {
    throw { code: 'E_PARAM_LOCKED', message: `MACD 本金已锁定为 ${LOCKED.principal} 元，本轮不支持其他本金` };
  }
  if (request.startDate !== LOCKED.startDate || request.endDate !== LOCKED.endDate) {
    throw { code: 'E_PARAM_LOCKED', message: `MACD 区间已锁定为 ${LOCKED.startDate} ~ ${LOCKED.endDate}，本轮不支持自定义日期` };
  }
  const v = request.video || {};
  if (v.resolution !== LOCKED.video.resolution || Number(v.fps) !== LOCKED.video.fps) {
    throw { code: 'E_PARAM_LOCKED', message: 'MACD 视频规格已锁定为 1920×1080@30fps' };
  }
}

// 准备阶段：检查依赖 → 生成配置副本 → 复制离线归档到新 run 目录
function prepare(ctx) {
  const { taskId, runId, request, taskDir, logWrite } = ctx;

  // 1) 封版配置与脚本必须存在（只读，不修改）
  const missingSealed = Object.keys(SEALED_FILES)
    .filter((k) => !fs.existsSync(SEALED_FILES[k]))
    .map((k) => SEALED_FILES[k]);
  if (missingSealed.length) {
    throw { code: 'E_CONFIG_MISSING', message: '缺少封版配置或脚本：' + missingSealed.join('、') };
  }

  // 2) 离线归档必须存在；缺失即明确返回 E_DATA_MISSING（不联网）
  const required = archiveRequired();
  const missingData = required.filter((f) => !fs.existsSync(f));
  if (missingData.length) {
    throw {
      code: 'E_DATA_MISSING',
      message: '本机缺少 MACD 离线行情/分红归档，无法离线复现。缺少文件：' + missingData.join('、')
        + '。请按迁移清单从已验证机器复制；本轮不自动联网抓取。',
      missing: missingData,
    };
  }

  // 3) 锁定参数校验
  assertLockedParams(request);

  // 4) 防覆盖：新 run 目录不得已有产物（避免重复 runId 覆盖 / plan 冲突）
  const runDir = path.join(OUTPUT_DIR, runId);
  const collision = [
    path.join(runDir, '02_backtest_macd', 'summary.json'),
    path.join(runDir, '04_video', 'video.mp4'),
  ].filter((f) => fs.existsSync(f));
  if (collision.length) {
    throw {
      code: 'E_RUN_DIR_EXISTS',
      message: '该 runId 已有历史产物，为避免覆盖已拒绝执行。请新建任务重试。',
    };
  }

  // 5) 深拷贝封版配置，仅覆盖 run_id / source_run_id，写入任务目录
  const btCfg = JSON.parse(fs.readFileSync(SEALED_FILES.backtestConfig, 'utf8'));
  const vidCfg = JSON.parse(fs.readFileSync(SEALED_FILES.videoConfig, 'utf8'));
  btCfg.run_id = runId;
  vidCfg.run_id = runId;
  vidCfg.source_run_id = runId; // 关键：回测产物就在这个新 run 目录下
  const btCfgPath = path.join(taskDir, 'config.backtest.json');
  const vidCfgPath = path.join(taskDir, 'config.video.json');
  fs.writeFileSync(btCfgPath, JSON.stringify(btCfg, null, 2), 'utf8');
  fs.writeFileSync(vidCfgPath, JSON.stringify(vidCfg, null, 2), 'utf8');

  // 6) 复制离线归档（仅两个回测输入文件，不复制 raw/ 大缓存）
  const destDataDir = path.join(runDir, '01_data');
  fs.mkdirSync(destDataDir, { recursive: true });
  const manifest = [];
  for (const src of required) {
    const dst = path.join(destDataDir, path.basename(src));
    fs.copyFileSync(src, dst);
    manifest.push({ file: path.relative(PROJECT_ROOT, src), sha256: sha256(src) });
  }

  // 记录归档真实区间（按真实数据解释，不用配置请求值冒充）
  const daily = JSON.parse(fs.readFileSync(required[0], 'utf8'));
  const payCal = JSON.parse(fs.readFileSync(required[1], 'utf8'));
  const archiveInfo = {
    sourceRun: sourceRun(),
    requestedStart: daily.meta.requestedStart,
    requestedEnd: daily.meta.requestedEnd,
    firstTradingDay: daily.meta.first,
    lastTradingDay: daily.meta.last,
    bars: daily.bars.length,
    calendarCount: (daily.calendar || []).length,
    corporateActions: (daily.actions || []).length,
    payEntries: Array.isArray(payCal.events) ? payCal.events.length : null,
    files: manifest,
  };
  fs.writeFileSync(path.join(taskDir, 'archive_manifest.json'), JSON.stringify(archiveInfo, null, 2), 'utf8');
  logWrite(`archive offline source=${archiveInfo.sourceRun} first=${archiveInfo.firstTradingDay} last=${archiveInfo.lastTradingDay} bars=${archiveInfo.bars}`);
  for (const m of manifest) logWrite(`archive ${m.file} sha256=${m.sha256}`);

  return { runDir, btCfgPath, vidCfgPath, archiveInfo };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function countCsvLines(p) {
  const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
  return txt ? txt.split(/\r?\n/).length - 1 : 0; // 去掉表头
}

// 解析验收脚本输出（PASS n / FAIL m）；仅用于记录，不作为硬编码预期
function parseAcceptResult(out) {
  const m = /验收结果：PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/.exec(out || '');
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
}

// 执行链。ctx 由 engineBridge 提供。
// 成功返回 { mp4:<源路径>, result, strategySpecific }；失败抛 { code, message }。
async function execute(ctx) {
  const { runId, runCommand, onStep, logWrite, taskDir } = ctx;

  onStep(0, 'running');
  const prep = prepare(ctx);
  const { runDir, btCfgPath, vidCfgPath, archiveInfo } = prep;
  const btDir = path.join(runDir, '02_backtest_macd');
  const videoDir = path.join(runDir, '04_video');
  onStep(0, 'done');

  const python = resolvePython();
  if (!python) throw { code: 'E_PYTHON_MISSING', message: '未找到可用的 Python（python / python3），无法渲染视频' };

  // 步骤 1：真实回测（只读离线归档，输出本次 summary/daily/signals/trades/macd）
  onStep(1, 'running');
  const bt = await runCommand(process.execPath, [SEALED_FILES.backtestScript, '--config', btCfgPath, '--run', runId]);
  const summaryPath = path.join(btDir, 'summary.json');
  if (bt.code !== 0 || !fs.existsSync(summaryPath)) {
    throw { code: 'E_BACKTEST_FAILED', message: 'MACD 回测失败或未产出 summary.json（见 engine.log）' };
  }
  logWrite(`backtest ok: ${path.relative(PROJECT_ROOT, summaryPath)}`);
  onStep(1, 'done');

  // 步骤 2：真实渲染 V1.2.2（source_run_id 已指向新 runId）
  onStep(2, 'running');
  const rd = await runCommand(python, [SEALED_FILES.renderScript, '--config', vidCfgPath, '--run', runId]);
  const mp4 = path.join(videoDir, 'video.mp4');
  const reportPath = path.join(videoDir, 'render_report.json');
  if (rd.code !== 0 || !fs.existsSync(mp4) || !fs.existsSync(reportPath)) {
    throw { code: 'E_RENDER_FAILED', message: 'MACD 视频渲染失败或未产出 video.mp4 / render_report.json（见 engine.log）' };
  }
  logWrite(`render ok: ${path.relative(PROJECT_ROOT, mp4)} bytes=${fs.statSync(mp4).size}`);
  onStep(2, 'done');

  // 步骤 3：现有 V1.2.2 的 38 项独立验收（只读，不改算法）
  onStep(3, 'running');
  const ac = await runCommand(python, [SEALED_FILES.acceptScript, '--run', runId, '--source', runId]);
  const acceptCounts = parseAcceptResult(ac.out);
  if (ac.code !== 0 || (acceptCounts && acceptCounts.fail > 0)) {
    throw {
      code: 'E_VERIFY_FAILED',
      message: 'V1.2.2 独立验收未通过（见 engine.log）。按任务书要求停止，不为通过验收修改算法。',
    };
  }
  logWrite(`accept ok: ${acceptCounts ? `PASS ${acceptCounts.pass} / FAIL ${acceptCounts.fail}` : 'exit 0（未解析到计数）'}`);
  onStep(3, 'done');

  // 结果全部从「本次」产物读取，绝不写入封版预期数字
  const S = readJson(summaryPath);
  const R = readJson(reportPath);
  const signalsPath = path.join(btDir, 'signals.csv');
  const result = {
    initialCapital: S.meta.initialCapital,
    holdFinal: S.hold.final,
    macdFinal: S.macd.final,
    tradingDays: S.meta.tradingDays,
    signals: fs.existsSync(signalsPath) ? countCsvLines(signalsPath) : null,
    trades: S.macd.tradeCount,
    period: { start: S.meta.start, end: S.meta.end },
    video: {
      width: R.width || (R.video && R.video.width) || null,
      height: R.height || (R.video && R.video.height) || null,
      fps: R.fps || null,
      frames: R.frames || null,
      durationSec: R.durationSec || null,
    },
    verification: {
      script: 'engine_next/tests/accept_macd_video_v122.py',
      pass: acceptCounts ? acceptCounts.pass : null,
      fail: acceptCounts ? acceptCounts.fail : null,
    },
  };
  const strategySpecific = {
    stock: S.meta.symbol || '601398',
    macdParams: S.macd.macdParams || LOCKED.macd,
    videoVersion: 'V1.2.2',
    offlineSourceRun: sourceRun(),
    archive: archiveInfo,
    configCopies: [
      path.relative(PROJECT_ROOT, btCfgPath),
      path.relative(PROJECT_ROOT, vidCfgPath),
    ],
  };
  fs.writeFileSync(path.join(taskDir, 'run_result.json'), JSON.stringify({ result, strategySpecific }, null, 2), 'utf8');
  return { mp4, result, strategySpecific };
}

module.exports = {
  id: 'macd',
  STEPS,
  LOCKED,
  SOURCE_RUN,
  SEALED_FILES,
  ARCHIVE_REQUIRED,
  sourceRun,
  archiveRequired,
  runIdForTask,
  prepare,
  execute,
};
