'use strict';
// web/src/adapters/dividendEtfAccept.cjs
// ---------------------------------------------------------------------------
// Open Source V0.1 说明：本文件是通用框架占位，网页未注册、不可执行，
// 也不附带任何真实行情数据或归档。文件中出现的历史标的/日期仅为原框架注释，
// 不代表本版支持该策略或含有真实数据。V0.1 仅开放 MACD 模拟数据演示。
// ---------------------------------------------------------------------------
// 通用框架占位：红利 ETF 验收适配层（本版未开放）。
//
// 为什么需要新的一层（任务书 §六）：
//   engine_next/tests/accept_div_etf_ep1_v2.py 把 RUN 写死为 "div_etf_ep1_v2_20261110"，
//   engine_next/tests/check_div_v3_events.py 也固定读封版 v2/v3 目录；两者均无 CLI 参数。
//   直接复用会把「封版结果」误当成「本次任务结果」。故本层不改原验收脚本，
//   完全依据新任务实际目录 output/<web_taskId>/ 动态读取本次回测与渲染产物。
//
// 核心证据链（不读封版结果冒充成功）：
//   1. summary.meta.run === runId                  → 回测确实在本次 run 生成
//   2. render_report.run / sourceRun === runId     → 渲染确实指向本次 run
//   3. render_report.backtestSha256 五项 === 本次 02_backtest 实际 SHA
//                                                  → 视频确实基于本次回测
//   4. render_report.sha256 === 本次 MP4 实际 SHA  → 视频与报告一致
//   5. render_report.series 金额 === 本次 summary A 账户；再投资笔数 === 本次 dividend_events.csv
//                                                  → 金额 / 事件与画面一致
//   6. 封版成片执行前后 SHA 不变                  → 无既有成片被覆盖
//
// 所有断言值来自「本次产物」或「配置副本」，不写死任何封版结果数字。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BT_FILES = ['summary.json', 'daily.csv', 'trades.csv', 'dividend_events.csv', 'corporate_events.csv'];

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function csvText(p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
}

function csvRowCount(p) {
  const t = csvText(p);
  return t ? t.split(/\r?\n/).length - 1 : 0;
}

function csvRows(p) {
  const t = csvText(p);
  if (!t) return [];
  const lines = t.split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    head.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function finalize(checks, logWrite) {
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.length - pass;
  if (logWrite) {
    logWrite(`web-accept: PASS ${pass} / FAIL ${fail}`);
    for (const c of checks) if (!c.ok) logWrite(`web-accept FAIL: ${c.name} ${c.detail}`);
  }
  return { checks, pass, fail };
}

// ctx: { runId, runDir, taskDir, cfgPath, sealedVideoSnapshot, logWrite, runCommand, python }
async function verify(ctx) {
  const {
    runId, runDir, cfgPath, sealedVideoSnapshot, logWrite, runCommand, python,
  } = ctx;
  const checks = [];
  const ck = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail === undefined || detail === null ? '' : String(detail) });
  };

  const btDir = path.join(runDir, '02_backtest');
  const videoDir = path.join(runDir, '04_video');
  const mp4 = path.join(videoDir, 'video.mp4');
  const reportPath = path.join(videoDir, 'render_report.json');
  const summaryPath = path.join(btDir, 'summary.json');

  // --- 0. 本次任务目录必须自包含全部产物 ---
  const missing = BT_FILES.map((f) => path.join(btDir, f))
    .concat([mp4, reportPath])
    .filter((p) => !fs.existsSync(p));
  ck('本次任务产物齐全（回测5件 + MP4 + 渲染报告）', missing.length === 0,
    missing.length ? '缺少：' + missing.map((p) => path.relative(runDir, p)).join('、') : '7/7');
  ck('MP4 非空', fs.existsSync(mp4) && fs.statSync(mp4).size > 0,
    fs.existsSync(mp4) ? fs.statSync(mp4).size + ' bytes' : 'missing');
  if (missing.length || !fs.existsSync(summaryPath)) return finalize(checks, logWrite);

  const S = readJson(summaryPath);
  const R = readJson(reportPath);
  const CFG = readJson(cfgPath);
  const pxPath = path.join(runDir, '01_data', 'price_bars.json');
  const uniPath = path.join(runDir, '01_data', 'etf_universe.json');
  const PX = fs.existsSync(pxPath) ? readJson(pxPath) : null;
  const UNI = fs.existsSync(uniPath) ? readJson(uniPath) : null;
  const M = S.meta || {};

  // --- 1. 回测确实在本次 run 生成，而不是复制封版结果 ---
  ck('本次回测 summary.meta.run === runId', M.run === runId, `run=${M.run} / runId=${runId}`);
  ck('初始本金与锁定值一致', Number(M.capital) === 100000, String(M.capital));
  if (PX && PX.meta) {
    ck('区间/交易日由本次 01_data 归档决定且与 summary 一致',
      M.start === PX.meta.start && M.end === PX.meta.end && M.tradingDays === PX.meta.tradingDays,
      `${M.start}~${M.end} / ${M.tradingDays} 日`);
  } else {
    ck('本次 01_data/price_bars.json 存在', false, '缺少归档');
  }
  const summaryCodes = (S.universe || []).map((u) => u.code);
  const cfgCodes = (CFG.series || []).map((s) => s.code);
  ck('三只 ETF 代码及顺序一致（归档/回测/模板）',
    JSON.stringify(summaryCodes) === JSON.stringify(cfgCodes)
      && (!UNI || JSON.stringify(summaryCodes) === JSON.stringify(UNI.selected))
      && summaryCodes.length === 3,
    summaryCodes.join(','));
  ck('summary 内置前置校验全部通过',
    Array.isArray(S.preflight) && S.preflight.length > 0 && S.preflight.every((p) => p.ok),
    (S.preflight || []).length + ' 项');
  ck('大幅价格跳变均有已登记公司行为解释',
    Array.isArray(S.priceJumps) && S.priceJumps.every((j) => j.explained),
    (S.priceJumps || []).length + ' 条');
  const accounts = S.accounts || [];
  ck('六账户结果齐全（3 标的 × A/B）', accounts.length === 6, accounts.length + ' 个');

  // --- 2. 视频确实来自本次回测（渲染器写入的回测输入指纹） ---
  ck('render_report.run === runId', R.run === runId, `${R.run} / ${runId}`);
  ck('render_report.sourceRun === runId', R.sourceRun === runId, String(R.sourceRun));
  ck('render_report.backtestDir 指向本次任务目录',
    !!R.backtestDir && path.resolve(String(R.backtestDir)) === path.resolve(btDir),
    String(R.backtestDir));
  ck('render_report.output 指向本次 MP4',
    !!R.output && path.resolve(String(R.output)) === path.resolve(mp4), String(R.output));
  const btSha = R.backtestSha256 || {};
  const shaDiff = BT_FILES.filter((f) => btSha[f] !== sha256(path.join(btDir, f)));
  ck('render_report.backtestSha256 与本次回测产物逐项一致',
    BT_FILES.every((f) => typeof btSha[f] === 'string') && shaDiff.length === 0,
    shaDiff.length ? '不一致：' + shaDiff.join('、') : '5/5（视频来自本次回测）');
  const mp4Sha = sha256(mp4);
  ck('render_report.sha256 与本次 MP4 一致', R.sha256 === mp4Sha, mp4Sha.slice(0, 16));

  // --- 3. 渲染器内部自检 / V3.4.1 模板完整性 ---
  const rChecks = R.checks || {};
  ck('渲染曲线/账本/占位符/版面自检全部通过',
    Object.keys(rChecks).length > 0 && Object.values(rChecks).every(Boolean),
    JSON.stringify(rChecks));
  ck('渲染前置校验无失败项',
    !!R.preflight && Array.isArray(R.preflight.failed) && R.preflight.failed.length === 0,
    `passed=${R.preflight && R.preflight.passed}`);
  const layoutChecks = R.layoutChecks || {};
  ck('版面不变量全部成立',
    Object.keys(layoutChecks).length > 0 && Object.values(layoutChecks).every(Boolean)
      && Array.isArray(R.layoutFailed) && R.layoutFailed.length === 0 && R.timelineValidated === true,
    Object.keys(layoutChecks).length + ' 项');
  ck('模板版本为 V3.4.1（配置副本 _revision）',
    typeof CFG._revision === 'string' && CFG._revision.includes('V3.4.1'), String(CFG._revision || '').slice(0, 60));
  const V = CFG.video || {};
  ck('画幅与帧率 1920×1080@30fps',
    V.width === R.width && V.height === R.height && V.fps === R.fps
      && R.width === 1920 && R.height === 1080 && R.fps === 30,
    `${R.width}x${R.height}@${R.fps}`);
  const framesFromCfg = Number(V.intro_frames || 0) + Number(V.main_frames || 0) + Number(V.outro_frames || 0);
  ck('段落帧数与渲染报告一致', framesFromCfg === R.frames, `${framesFromCfg} / ${R.frames}`);
  ck('时长与帧数/帧率自洽',
    Number(R.durationSec) === Number((Number(R.frames) / Number(R.fps)).toFixed(2)),
    `${R.durationSec}s / ${R.frames}帧`);
  const guardCodes = (CFG.guard && CFG.guard.requiredCodes) || [];
  ck('模板 guard 标的三只且顺序一致',
    JSON.stringify(guardCodes) === JSON.stringify(cfgCodes) && guardCodes.length === 3, guardCodes.join(','));
  ck('模板 guard 要求 A 方案',
    Array.isArray(CFG.guard && CFG.guard.requiredPlans) && CFG.guard.requiredPlans.includes('A'));
  const ticks = R.assetTicks || [];
  ck('V3.4.1 纵轴三档刻度完整',
    ticks.length >= 4 && Math.max(...ticks) === R.assetMax,
    `max=${R.assetMax} ticks=${ticks.join('/')}`);

  // --- 4. 金额 / 事件 / 日期 与画面一致（读本次 summary + 本次 CSV） ---
  const aMap = new Map(accounts.filter((a) => a.plan === 'A').map((a) => [a.code, a.summary || {}]));
  const seriesMismatch = (R.series || []).filter((s) => {
    const a = aMap.get(s.code);
    return !a || Number(s.finalTotalAsset) !== Number(a.finalTotalAsset);
  });
  ck('画面期末金额与本次回测 A 方案逐项一致',
    (R.series || []).length === 3 && seriesMismatch.length === 0,
    seriesMismatch.length ? '不一致：' + seriesMismatch.map((s) => s.code).join(',') : '3/3');
  const divRows = csvRows(path.join(btDir, 'dividend_events.csv'));
  const reinvestRows = divRows.filter((r) => r.plan === 'A' && r.state === 'REINVESTED');
  ck('画面分红再投资笔数与本次 dividend_events.csv 一致',
    Number(R.dividendReinvestCount) === reinvestRows.length,
    `report=${R.dividendReinvestCount} / csv=${reinvestRows.length}`);
  ck('画面首末日期/交易日与本次回测一致',
    R.firstDate === M.start && R.lastDate === M.end && Number(R.tradingDays) === Number(M.tradingDays),
    `${R.firstDate}~${R.lastDate} / ${R.tradingDays}`);
  const corpText = csvText(path.join(btDir, 'corporate_events.csv'));
  ck('512890 份额拆分事件已登记',
    corpText.includes('512890') && corpText.toUpperCase().includes('SHARE_SPLIT'));
  const tradesFromCsv = csvRowCount(path.join(btDir, 'trades.csv'));
  const tradesFromSummary = accounts.reduce((n, a) => n + Number((a.summary || {}).tradeCount || 0), 0);
  ck('交易记录条数与本次六账户汇总一致', tradesFromCsv === tradesFromSummary,
    `csv=${tradesFromCsv} / summary=${tradesFromSummary}`);
  const dailyRows = csvRowCount(path.join(btDir, 'daily.csv'));
  ck('日度资产记录覆盖全部账户与交易日',
    dailyRows === accounts.length * Number(M.tradingDays),
    `csv=${dailyRows} / 期望=${accounts.length * Number(M.tradingDays)}`);

  // --- 5. MP4 容器结构 + 真实可解码（可播放） ---
  const head = fs.readFileSync(mp4).subarray(0, 64).toString('latin1');
  ck('MP4 容器结构有效（ftyp）', head.includes('ftyp'));
  if (runCommand && python) {
    let ffmpeg = null;
    try {
      const probe = await runCommand(python, ['-c', 'import imageio_ffmpeg,sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())']);
      const out = String((probe && probe.out) || '').trim().split(/\r?\n/).pop();
      if (probe && probe.code === 0 && out) ffmpeg = out;
    } catch (_) { /* 由下方断言统一报告 */ }
    if (ffmpeg) {
      const dec = await runCommand(ffmpeg, ['-v', 'error', '-i', mp4, '-map', '0:v:0', '-f', 'null', '-']);
      ck('MP4 可完整解码（ffmpeg 逐帧播放检查）', dec && dec.code === 0,
        dec ? `exit=${dec.code}` : 'no result');
    } else {
      ck('MP4 可完整解码（ffmpeg 逐帧播放检查）', false, '未能定位 ffmpeg');
    }
  } else {
    ck('MP4 可完整解码（ffmpeg 逐帧播放检查）', false, '缺少 runCommand / python');
  }

  // --- 6. 无既有成片被覆盖（执行前快照 SHA 逐项复核） ---
  const snap = Array.isArray(sealedVideoSnapshot) ? sealedVideoSnapshot : [];
  const changed = snap.filter((s) => !fs.existsSync(s.file) || sha256(s.file) !== s.sha256);
  ck('既有封版成片未被覆盖', changed.length === 0,
    `${snap.length} 条封版视频，变化 ${changed.length} 条`);

  return finalize(checks, logWrite);
}

module.exports = { verify, BT_FILES, sha256 };
