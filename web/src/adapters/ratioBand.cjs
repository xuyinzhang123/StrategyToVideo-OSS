'use strict';
// web/src/adapters/ratioBand.cjs
// ---------------------------------------------------------------------------
// Open Source V0.1 说明：本文件是通用框架占位，网页未注册、不可执行，
// 也不附带任何真实行情数据或归档。文件中出现的历史标的/日期仅为原框架注释，
// 不代表本版支持该策略或含有真实数据。V0.1 仅开放 MACD 模拟数据演示。
// ---------------------------------------------------------------------------
// 通用框架占位：ratio_band 适配器（本版未开放）。
// 阶段 4A 从 engineBridge.js 原样抽出，行为零改变：复用 agent/unified.cjs 两阶段确认，
// 网页参数按统一入口真实契约映射，阈值锁定 0.35/0.65 由 validation.js 保证。
//
// 本文件只含 ratio_band 专属逻辑；通用编排（并发守卫/状态机/日志/MP4 复制）在 engineBridge.js。

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('../paths');
const TM = require('../taskManager');

const UNIFIED = path.join(PROJECT_ROOT, 'agent', 'unified.cjs');

// 真实可观测阶段（不虚构百分比）
const STEPS = ['生成确认单（plan）', '真实回测 / 渲染 / 验收', '读取结果并交付视频'];

function runIdForTask(taskId) {
  return 'web_' + String(taskId).replace(/-/g, '');
}

// 将 web 任务请求映射为统一入口请求文件（写入任务目录）
// 保持阶段 3 的两参数签名，供既有测试与 engineBridge 兼容导出直接调用。
function buildRequestFile(taskId, request) {
  const runId = runIdForTask(taskId);
  const req = {
    runId,
    strategy: 'ratio_band',
    symbol: 'CYB+RED', // 创业板指 ÷ 中证红利（统一入口已验证别名）
    capital: request.principal,
    start: request.startDate,
    end: request.endDate,
    video: `${request.video.resolution}@${request.video.fps}`,
  };
  const reqPath = path.join(TM.taskDir(taskId), 'engine_request.json');
  fs.writeFileSync(reqPath, JSON.stringify(req, null, 2), 'utf8');
  return { runId, reqPath };
}

// 解析统一入口 --json 输出，提取错误码/信息
function extractError(out) {
  if (!out) return null;
  try {
    const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
    for (const l of lines) {
      const j = JSON.parse(l);
      if (j && j.error && j.error.code) return { code: j.error.code, message: j.error.message };
    }
  } catch (_) { /* ignore */ }
  return null;
}

// 执行链。ctx 由 engineBridge 提供：{ taskId, runId, request, taskDir, RUNS_DIR, runCommand, onStep, logWrite }
// 成功返回 { mp4:<源路径>, result, strategySpecific }；失败抛 { code, message }。
async function execute(ctx) {
  const { taskId, runId, request, RUNS_DIR, runCommand, onStep, logWrite } = ctx;
  const { reqPath } = buildRequestFile(taskId, request);

  onStep(0, 'running');
  const plan = await runCommand(process.execPath, [UNIFIED, '--request', reqPath, '--json']);
  const planPath = path.join(RUNS_DIR, runId, 'plan.json');
  if (!fs.existsSync(planPath)) {
    throw extractError(plan.out)
      || { code: 'E_PLAN_FAILED', message: '确认单生成失败（数据/配置/策略检查未通过）' };
  }
  logWrite('plan.json generated');
  onStep(0, 'done');

  onStep(1, 'running');
  const confirm = await runCommand(process.execPath, [UNIFIED, '--request', reqPath, '--confirm', '--json']);
  const resultPath = path.join(RUNS_DIR, runId, 'result.json');
  if (!fs.existsSync(resultPath)) {
    throw extractError(confirm.out)
      || { code: 'E_ENGINE_FAILED', message: '引擎未产出结果（可能异常退出）' };
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (result.status !== 'succeeded') {
    throw (result.error && result.error.code)
      ? { code: result.error.code, message: result.error.message }
      : { code: 'E_ENGINE_FAILED', message: '引擎执行失败' };
  }
  onStep(1, 'done');

  onStep(2, 'running');
  if (!result.mp4 || !fs.existsSync(result.mp4)) {
    throw { code: 'E_VIDEO_MISSING', message: '回测/渲染成功，但视频文件缺失' };
  }
  onStep(2, 'done');
  return {
    mp4: result.mp4,
    result: result.summary || null,
    strategySpecific: result.strategySpecific || null,
  };
}

module.exports = {
  id: 'ratio_band',
  STEPS,
  runIdForTask,
  buildRequestFile,
  extractError,
  execute,
  UNIFIED,
};
