'use strict';
// web/src/adapters/dividendEtf.cjs
// ---------------------------------------------------------------------------
// Open Source V0.1 说明：本文件是通用框架占位，网页未注册、不可执行，
// 也不附带任何真实行情数据或归档。文件中出现的历史标的/日期仅为原框架注释，
// 不代表本版支持该策略或含有真实数据。V0.1 仅开放 MACD 模拟数据演示。
// ---------------------------------------------------------------------------
// 通用框架占位：红利 ETF 适配器（本版未开放）。
//
// 数据可靠性优先（任务书 §一~§六）：
//   1. 离线归档 A 级证据链：output/div_etf_ep1_v2_20261110/01_data/ 共 91 个文件，
//      逐项按封版 05_acceptance/FILE_MANIFEST.json 的 SHA256 + bytes 校验，
//      绝不「仅凭文件名相同」认定有效。缺文件 → E_DATA_MISSING；指纹不符 → E_ARCHIVE_HASH_MISMATCH。
//      不联网、不重新抓取行情或公告。
//   2. 规范化输入已存在，故跳过 raw 重建：不调用 fetch_dividend_dataset_v2.cjs
//      （该脚本只读已存档 raw 生成规范数据，名字里的 fetch 不等于联网下载）。
//      此模式在 engine.log 中显式记录。
//   3. CLI 严格按源码真实支持情况：
//        backtest_dividend_v2.cjs  --run <runId>          （无 --config / --capital / --end）
//        render_dividend_v3.py    --config <cfg>          （run_id 写在配置副本里，不传 --run）
//      绝不为不存在的参数传值。
//   4. 参数锁定：512890/515450/515180、每只 100000、2020-02-26~2026-11-06、
//      封版费用与分红再投资口径、V3.4.1、1920x1080@30fps。
//      特别注意：backtest_dividend_v2.cjs 把 capital:100000 写死在源码里，
//      区间由 01_data/price_bars.json 的 meta.start/end 决定，均不接受网页参数。
//      因此网页本金/日期必须双层锁定，绝不「校验允许但回测静默忽略」。
//   5. 封版 V3.4.1 视频配置深拷贝到任务目录，只覆盖 run_id / source_run_id；
//      渲染器要求 summary.meta.run === source_run_id，故两者都设为本次 runId。
//   6. 独立验收走 dividendEtfAccept.cjs（新任务目录），不改固定 run 的原验收脚本。
//   7. 结果数字全部从本次产物读取，不硬编码封版预期值。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT } = require('../paths');
const accept = require('./dividendEtfAccept.cjs');

const ENGINE_DIR = path.join(PROJECT_ROOT, 'engine_next');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const SEALED_RUN = 'div_etf_ep1_v2_20261110';

// 可用 STV_DIV_ETF_ARCHIVE_DIR 指向另一台机器上的 01_data（或它的 run 根目录）；
// 也可用 STV_DIV_ETF_SOURCE_RUN 覆盖归档 run 目录名。提交中不含任何机器专属路径。
function archiveDir() {
  const env = process.env.STV_DIV_ETF_ARCHIVE_DIR;
  const d = env
    ? path.resolve(env)
    : path.join(OUTPUT_DIR, process.env.STV_DIV_ETF_SOURCE_RUN || SEALED_RUN, '01_data');
  // 兼容环境变量指向 run 根目录（而非 01_data）的情况
  if (fs.existsSync(path.join(d, '01_data', 'price_bars.json'))) return path.join(d, '01_data');
  return d;
}

const SEALED_FILES = {
  videoConfig: path.join(ENGINE_DIR, 'config.div_etf_ep1_v3_video.json'),
  backtestScript: path.join(ENGINE_DIR, 'backtest_dividend_v2.cjs'),
  renderScript: path.join(ENGINE_DIR, 'render_dividend_v3.py'),
  manifest: path.join(OUTPUT_DIR, SEALED_RUN, '05_acceptance', 'FILE_MANIFEST.json'),
};

// 回测真正读取的三个规范化输入 + 证据/口径文件（回测只读前三个，其余为证据链完整性）
const REQUIRED_INPUTS = [
  'etf_universe.json',
  'dividend_calendar.json',
  'price_bars.json',
  'corporate_actions.json',
  'dividend_audit.json',
  'dividend_policy.json',
  'feeder_dividends.json',
];

const LOCKED = {
  codes: ['512890', '515450', '515180'],
  principal: 100000,           // 每只 ETF 的初始本金（回测脚本内建）
  startDate: '2020-02-26',     // 三只共同可用起点
  endDate: '2026-11-06',       // 估值日无未确认应收权益
  video: { resolution: '1920x1080', fps: 30 },
  videoVersion: 'V3.4.1',
};

const STEPS = [
  '离线归档校验与配置副本',
  '真实回测（三只红利 ETF · 六账户）',
  '视频渲染（V3.4.1）',
  '网页任务独立验收（本次目录 · 数据/画面/SHA）',
];

const BT_OUTPUTS = accept.BT_FILES;

function runIdForTask(taskId) {
  return 'web_' + String(taskId).replace(/-/g, '');
}

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function resolvePython() {
  for (const cmd of [process.env.STV_PYTHON, 'python', 'python3']) {
    if (!cmd) continue;
    const r = spawnSync(cmd, ['--version'], { timeout: 8000, encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

// 纵深防御：即使绕过前端，网页也只能提交锁定参数。
function assertLockedParams(request) {
  if (!request) throw { code: 'E_PARAM_LOCKED', message: '缺少任务参数，请新建任务重试' };
  if (Number(request.principal) !== LOCKED.principal) {
    throw {
      code: 'E_PARAM_LOCKED',
      message: `红利 ETF 每只初始本金已锁定为 ${LOCKED.principal} 元；回测脚本内建该口径，不接受网页本金参数，也不会静默忽略输入`,
    };
  }
  if (request.startDate !== LOCKED.startDate || request.endDate !== LOCKED.endDate) {
    throw {
      code: 'E_PARAM_LOCKED',
      message: `红利 ETF 区间已锁定为 ${LOCKED.startDate} ~ ${LOCKED.endDate}（由归档交易日决定），暂不支持自定义日期`,
    };
  }
  const v = request.video || {};
  if (v.resolution !== LOCKED.video.resolution || Number(v.fps) !== LOCKED.video.fps) {
    throw { code: 'E_PARAM_LOCKED', message: '红利 ETF 视频规格已锁定为 1920×1080@30fps（V3.4.1）' };
  }
  if (Array.isArray(request.symbols) && JSON.stringify(request.symbols) !== JSON.stringify(LOCKED.codes)) {
    throw { code: 'E_PARAM_LOCKED', message: '标的已锁定为 512890 / 515450 / 515180，不可更改' };
  }
}

// 封版成片执行前快照（用于验收层证明「无既有成片被覆盖」）
function sealedVideoSnapshot(excludeRunId) {
  const out = [];
  if (!fs.existsSync(OUTPUT_DIR)) return out;
  for (const name of fs.readdirSync(OUTPUT_DIR)) {
    if (name === excludeRunId || name.startsWith('web_') || name.startsWith('stv4b_verify_')) continue;
    const p = path.join(OUTPUT_DIR, name, '04_video', 'video.mp4');
    if (!fs.existsSync(p)) continue;
    out.push({ file: p, sha256: sha256(p), bytes: fs.statSync(p).size });
  }
  return out;
}

function manifestEntries() {
  const m = JSON.parse(fs.readFileSync(SEALED_FILES.manifest, 'utf8'));
  const prefix = `output/${SEALED_RUN}/01_data/`;
  const entries = (m.files_detail || []).filter((f) => f.path.startsWith(prefix));
  if (!entries.length) {
    throw { code: 'E_ARCHIVE_MANIFEST', message: '封版验收清单中未找到 01_data 条目，无法校验离线归档真实性' };
  }
  return entries.map((e) => ({
    rel: e.path.slice(prefix.length),
    bytes: e.bytes,
    sha256: e.sha256,
  }));
}

function prepare(ctx) {
  const { runId, request, taskDir, logWrite } = ctx;

  // 1) 封版脚本 / 配置 / 验收清单只读存在
  const missingSealed = Object.keys(SEALED_FILES)
    .filter((k) => !fs.existsSync(SEALED_FILES[k]))
    .map((k) => SEALED_FILES[k]);
  if (missingSealed.length) {
    throw { code: 'E_CONFIG_MISSING', message: '缺少封版配置/脚本/验收清单：' + missingSealed.join('、') };
  }

  // 2) 离线归档必须先存在（缺文件明确列出，不联网补齐）
  const src = archiveDir();
  const missingData = REQUIRED_INPUTS
    .filter((f) => !fs.existsSync(path.join(src, f)))
    .map((f) => path.join(src, f));
  if (!fs.existsSync(path.join(src, 'raw', 'announcements'))) {
    missingData.push(path.join(src, 'raw', 'announcements') + '（A 级公告证据目录）');
  }
  if (missingData.length) {
    throw {
      code: 'E_DATA_MISSING',
      message: '本机缺少红利 ETF 离线归档，无法离线复现。缺少：' + missingData.join('、')
        + '。请按迁移清单从已验证机器复制 01_data（91 个文件）；本轮不自动联网抓取，也不从视频/最终资产数字反推数据。',
      missing: missingData,
    };
  }

  // 3) 按封版清单逐文件校验 SHA256 + bytes（不得仅凭同名认定有效）
  const entries = manifestEntries();
  const bad = [];
  for (const e of entries) {
    const p = path.join(src, ...e.rel.split('/'));
    if (!fs.existsSync(p)) { bad.push(e.rel + '（缺失）'); continue; }
    const b = fs.readFileSync(p);
    const h = crypto.createHash('sha256').update(b).digest('hex');
    if (h !== e.sha256 || b.length !== e.bytes) bad.push(e.rel + '（指纹不符）');
  }
  if (bad.length) {
    throw {
      code: 'E_ARCHIVE_HASH_MISMATCH',
      message: `离线归档与封版验收清单不一致（${bad.length}/${entries.length} 项），拒绝基于可疑数据出片。`
        + ' 前几项：' + bad.slice(0, 6).join('、'),
      missing: bad,
    };
  }

  // 4) 参数锁定（在复制/执行之前）
  assertLockedParams(request);

  // 5) 防覆盖：新 run 目录不得已有产物
  const runDir = path.join(OUTPUT_DIR, runId);
  const collision = [
    path.join(runDir, '02_backtest', 'summary.json'),
    path.join(runDir, '04_video', 'video.mp4'),
  ].filter((f) => fs.existsSync(f));
  if (collision.length) {
    throw { code: 'E_RUN_DIR_EXISTS', message: '该 runId 已有历史产物，为避免覆盖已拒绝执行。请新建任务重试。' };
  }

  // 6) 封版 V3.4.1 配置深拷贝；只覆盖 run_id / source_run_id
  const cfg = JSON.parse(fs.readFileSync(SEALED_FILES.videoConfig, 'utf8'));
  cfg.run_id = runId;
  cfg.source_run_id = runId; // 渲染器 chk: summary.meta.run === source_run_id
  const cfgPath = path.join(taskDir, 'config.video.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  // 7) 按清单精确复制 01_data（含 raw/ 公告证据），不复制任何大缓存
  const destDataDir = path.join(runDir, '01_data');
  fs.mkdirSync(destDataDir, { recursive: true });
  for (const e of entries) {
    const from = path.join(src, ...e.rel.split('/'));
    const to = path.join(destDataDir, ...e.rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  // 8) 记录归档信息（真实区间/来源/模式），并显式写明跳过 raw 重建
  const PX = JSON.parse(fs.readFileSync(path.join(destDataDir, 'price_bars.json'), 'utf8'));
  const UNI = JSON.parse(fs.readFileSync(path.join(destDataDir, 'etf_universe.json'), 'utf8'));
  const CAL = JSON.parse(fs.readFileSync(path.join(destDataDir, 'dividend_calendar.json'), 'utf8'));
  const archiveInfo = {
    sourceDir: src,
    sourceRun: path.basename(path.dirname(src)),
    evidenceLevel: 'A',
    verifiedFiles: entries.length,
    manifest: path.relative(PROJECT_ROOT, SEALED_FILES.manifest),
    codes: UNI.selected,
    start: PX.meta.start,
    end: PX.meta.end,
    tradingDays: PX.meta.tradingDays,
    dividendEvents: (CAL.events || []).length,
    corporateActions: (PX.corporateActions || []).length,
    priceSource: PX.meta.priceSource,
    mode: 'normalized-offline-inputs（跳过 raw 重建，未调用 fetch_dividend_dataset_v2.cjs）',
  };
  fs.writeFileSync(path.join(taskDir, 'archive_manifest.json'), JSON.stringify(archiveInfo, null, 2), 'utf8');

  logWrite(`archive source=${src} level=A verified=${entries.length}/${entries.length} by sealed FILE_MANIFEST.json`);
  logWrite(`archive real period=${archiveInfo.start}~${archiveInfo.end} tradingDays=${archiveInfo.tradingDays} codes=${archiveInfo.codes.join(',')} dividendEvents=${archiveInfo.dividendEvents}`);
  logWrite('mode=normalized-offline-inputs: raw rebuild SKIPPED; fetch_dividend_dataset_v2.cjs NOT invoked; no network access.');
  logWrite('backtest note: backtest_dividend_v2.cjs embeds capital=100000 per ETF and derives start/end from price_bars.meta; it accepts ONLY --run. Web principal/dates are locked, never silently ignored.');
  logWrite(`config copy: ${path.relative(PROJECT_ROOT, cfgPath)} (run_id=source_run_id=${runId}); sealed config untouched`);

  return { runDir, cfgPath, archiveInfo, sealedVideoSnapshot: sealedVideoSnapshot(runId) };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function execute(ctx) {
  const { runId, runCommand, onStep, logWrite, taskDir } = ctx;

  onStep(0, 'running');
  const prep = prepare(ctx);
  const { runDir, cfgPath, archiveInfo, sealedVideoSnapshot: snap } = prep;
  const btDir = path.join(runDir, '02_backtest');
  const videoDir = path.join(runDir, '04_video');
  onStep(0, 'done');

  const python = resolvePython();
  if (!python) throw { code: 'E_PYTHON_MISSING', message: '未找到可用的 Python（python / python3），无法渲染 V3.4.1 视频' };

  // 步骤 1：真实回测。严格只传 --run（脚本不支持 --config / --capital / --end）
  onStep(1, 'running');
  const bt = await runCommand(process.execPath, [SEALED_FILES.backtestScript, '--run', runId]);
  const summaryPath = path.join(btDir, 'summary.json');
  const missingBt = BT_OUTPUTS.filter((f) => !fs.existsSync(path.join(btDir, f)));
  if (bt.code !== 0 || missingBt.length) {
    throw {
      code: 'E_BACKTEST_FAILED',
      message: '红利 ETF 回测失败或未产出完整回测产物（缺少：' + missingBt.join('、') + '；见 engine.log）',
    };
  }
  if (readJson(summaryPath).meta.run !== runId) {
    throw { code: 'E_BACKTEST_FAILED', message: '回测 summary.meta.run 与本次 runId 不一致，拒绝把封版结果当作本次结果' };
  }
  logWrite(`backtest ok: ${path.relative(PROJECT_ROOT, btDir)} (5 files)`);
  onStep(1, 'done');

  // 步骤 2：真实渲染 V3.4.1。只传 --config（run_id 已在配置副本中）
  onStep(2, 'running');
  const rd = await runCommand(python, [SEALED_FILES.renderScript, '--config', cfgPath]);
  const mp4 = path.join(videoDir, 'video.mp4');
  const reportPath = path.join(videoDir, 'render_report.json');
  if (rd.code !== 0 || !fs.existsSync(mp4) || !fs.existsSync(reportPath)) {
    throw { code: 'E_RENDER_FAILED', message: 'V3.4.1 视频渲染失败或未产出 video.mp4 / render_report.json（见 engine.log）' };
  }
  logWrite(`render ok: ${path.relative(PROJECT_ROOT, mp4)} bytes=${fs.statSync(mp4).size}`);
  onStep(2, 'done');

  // 步骤 3：网页任务专用独立验收（依据本次目录，不改固定 run 的原验收脚本）
  onStep(3, 'running');
  const acc = await accept.verify({
    runId, runDir, taskDir, cfgPath,
    sealedVideoSnapshot: snap,
    logWrite, runCommand, python,
  });
  const accPath = path.join(taskDir, 'web_acceptance.json');
  fs.writeFileSync(accPath, JSON.stringify(acc, null, 2), 'utf8');
  if (acc.fail > 0) {
    const first = acc.checks.filter((c) => !c.ok).slice(0, 3).map((c) => c.name).join('；');
    throw {
      code: 'E_VERIFY_FAILED',
      message: `网页任务独立验收未通过：PASS ${acc.pass} / FAIL ${acc.fail}（${first}）。详情见 web_acceptance.json，不为通过验收修改算法或数据。`,
    };
  }
  logWrite(`web-accept ok: PASS ${acc.pass} / FAIL ${acc.fail} -> ${path.relative(PROJECT_ROOT, accPath)}`);
  onStep(3, 'done');

  // 结果全部从「本次」产物动态读取，不写死任何封版数字
  const S = readJson(summaryPath);
  const R = readJson(reportPath);
  const M = S.meta;
  const mp4Sha = sha256(mp4);
  const result = {
    perEtfCapital: M.capital,
    codes: (S.universe || []).map((u) => u.code),
    period: { start: M.start, end: M.end, tradingDays: M.tradingDays },
    accounts: (S.accounts || []).map((a) => ({
      code: a.code, plan: a.plan,
      finalTotalAsset: (a.summary || {}).finalTotalAsset,
      totalReturn: (a.summary || {}).totalReturn,
      dividendCount: (a.summary || {}).dividendCount,
      reinvestCount: (a.summary || {}).reinvestCount,
      cumCashDividend: (a.summary || {}).cumCashDividend,
    })),
    dividendReinvestCount: R.dividendReinvestCount,
    video: {
      width: R.width, height: R.height, fps: R.fps,
      frames: R.frames, durationSec: R.durationSec,
      bytes: fs.statSync(mp4).size,
    },
    verification: {
      layer: 'web/src/adapters/dividendEtfAccept.cjs',
      pass: acc.pass, fail: acc.fail,
    },
  };
  const strategySpecific = {
    videoVersion: LOCKED.videoVersion,
    offlineSourceRun: archiveInfo.sourceRun,
    archive: archiveInfo,
    configCopies: [path.relative(PROJECT_ROOT, cfgPath)],
    mode: archiveInfo.mode,
    mp4Sha256: mp4Sha,
    sealedVideoCount: snap.length,
  };
  fs.writeFileSync(path.join(taskDir, 'run_result.json'), JSON.stringify({ result, strategySpecific }, null, 2), 'utf8');
  return { mp4, result, strategySpecific };
}

module.exports = {
  id: 'dividend_etf',
  STEPS,
  LOCKED,
  SEALED_RUN,
  SEALED_FILES,
  REQUIRED_INPUTS,
  sourceRun: () => process.env.STV_DIV_ETF_SOURCE_RUN || SEALED_RUN,
  archiveDir,
  runIdForTask,
  prepare,
  execute,
};
