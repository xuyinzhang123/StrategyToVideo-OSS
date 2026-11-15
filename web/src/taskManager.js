'use strict';
// web/src/taskManager.js
// 任务管理：阶段 2（plan-only 创建）+ 阶段 3（执行状态机）。
//
// 约束：
//   - taskId 一律由服务端用 crypto.randomUUID() 生成，客户端不可指定。
//   - 受控目录：web/tasks/<taskId>/，所有文件操作限制在此目录内。
//   - 每个任务保存 request.json 与 status.json。
//   - 状态机：queued / running / success / failed。
//       · queued：已创建、等待用户明确「确认并生成视频」。
//       · running：实际引擎执行中（阶段 3 起由 engineBridge 写入）。
//       · success：回测+渲染+验收全部成功，MP4 已复制到任务目录。
//       · failed：任一必要步骤失败，携带 E_* 错误，绝不误标 success。
//   - 原子写入（临时文件 + rename），避免异常中断产生不完整 JSON。
//   - taskId 仅接受 UUID 格式，天然杜绝路径穿越。
//   - 服务器重启时，任何处于 running 的任务视为异常中断 → 转 failed（E_INTERRUPTED）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 与 server.js 同级的 web 目录：<root>/web
const WEB_DIR = path.resolve(__dirname, '..');
// 任务目录默认可被环境变量 WEB_TASKS_DIR 覆盖。用途：自动化测试并行运行时，
// 每个测试文件（独立子进程）使用各自独立的临时目录，避免共享 web/tasks 导致
// 目录计数类断言出现跨进程竞态。生产/默认仍指向 web/tasks。
const TASKS_DIR = process.env.WEB_TASKS_DIR
  ? path.resolve(process.env.WEB_TASKS_DIR)
  : path.join(WEB_DIR, 'tasks');

// 仅接受标准 UUID v4（大小写不敏感）。非法则不可能命中任何子目录。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function taskDir(taskId) {
  return path.join(TASKS_DIR, taskId);
}

function isValidTaskId(taskId) {
  return typeof taskId === 'string' && UUID_RE.test(taskId);
}

// 原子写入：先写 .tmp 再 rename，保证目标文件要么完整要么不存在
function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

// 通用读取：task 目录下任意 JSON 文件（不存在/解析失败返回 null）
function readTaskFile(taskId, name) {
  if (!isValidTaskId(taskId)) return null;
  const p = path.join(taskDir(taskId), name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

// 通用原子更新：合并 patch 到 status.json（保留原字段），更新 updatedAt
function updateStatus(taskId, patch) {
  const status = getTask(taskId);
  if (!status) return null;
  const next = Object.assign({}, status, patch, { updatedAt: new Date().toISOString() });
  atomicWriteJson(path.join(taskDir(taskId), 'status.json'), next);
  return next;
}

// ---- 阶段 3 状态机写入 ----

// 标记 running：记录 runId、startedAt、模式转 executed
function setRunning(taskId, runId) {
  return updateStatus(taskId, {
    status: 'running',
    mode: 'executed',
    runId,
    startedAt: new Date().toISOString(),
    progress: { phase: 'plan', steps: [], currentStep: null },
    error: null,
    result: null,
  });
}

// 刷新进度（由 engineBridge 在引擎运行期间周期性调用）
function setProgress(taskId, progress) {
  return updateStatus(taskId, { progress });
}

// 标记 success：写入回测摘要、MP4 文件名、runId、完成时间
function setSuccess(taskId, info) {
  return updateStatus(taskId, {
    status: 'success',
    finishedAt: new Date().toISOString(),
    mp4: info.mp4,
    runId: info.runId,
    result: info.result || null,
    strategySpecific: info.strategySpecific || null,
    error: null,
  });
}

// 标记 failed：绝不直接标 success；记录 E_* 错误码与中文说明
function setFailed(taskId, info) {
  const error = {
    code: info.code || 'E_ENGINE_FAILED',
    message: info.message || '执行失败',
    // 阶段 4A：失败任务禁止重跑，统一提示用户新建任务（避免重复 runId 覆盖 / plan 冲突）
    hint: info.hint || '请新建任务重试',
  };
  if (Array.isArray(info.missing) && info.missing.length) error.missing = info.missing;
  return updateStatus(taskId, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    error,
  });
}

// 列出所有任务目录名（仅合法 UUID）
function listTaskIds() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs.readdirSync(TASKS_DIR).filter((d) => isValidTaskId(d) && fs.existsSync(path.join(taskDir(d), 'status.json')));
}

// 重启恢复：任何处于 running 的任务视为异常中断（服务器重启/崩溃），
// 转 failed 并记录 E_INTERRUPTED，避免被误认为 success。
function recoverInterruptedTasks() {
  let recovered = 0;
  for (const id of listTaskIds()) {
    const st = getTask(id);
    if (st && st.status === 'running') {
      setFailed(id, { code: 'E_INTERRUPTED', message: '服务器重启时任务仍在运行，已标记为中断（需重新执行）' });
      recovered += 1;
    }
  }
  return recovered;
}

// 创建任务（已通过校验的 normalized 请求）
function createTask(normalized) {
  const taskId = crypto.randomUUID();
  const dir = taskDir(taskId);
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();

  // 用户 CSV（A/B 类）：没有本金 / 区间 / 视频规格参数，一切由数据决定。
  // 归一化模型随之落盘为 import.json —— 执行阶段只读它，不再碰 CSV 原文，
  // 这样「校验失败」与「执行失败」不会互相掩盖，产物也可回溯（Issue #1 要求）。
  if (normalized.importModel) {
    const request = {
      taskId,
      strategy: normalized.strategy,
      dataClass: normalized.dataClass,
      title: normalized.title,
      unit: normalized.unit,
      asOf: normalized.asOf,
      sourceNote: normalized.sourceNote,
      fileName: normalized.fileName,
      mapping: normalized.mapping,
      warnings: normalized.warnings,
      mode: 'plan-only',
    };
    const status = {
      taskId,
      strategy: normalized.strategy,
      dataClass: normalized.dataClass,
      title: normalized.title,
      status: 'queued',
      mode: 'plan-only',
      createdAt: now,
      updatedAt: now,
      warnings: normalized.warnings,
      note: '任务已创建（计划态），请点击「确认并生成视频」显式执行。',
      result: null,
      error: null,
    };
    atomicWriteJson(path.join(dir, 'request.json'), request);
    atomicWriteJson(path.join(dir, 'import.json'), normalized.importModel);
    atomicWriteJson(path.join(dir, 'status.json'), status);
    return { taskId, status };
  }

  const request = {
    taskId,
    strategy: normalized.strategy,
    principal: normalized.principal,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
    video: normalized.video,
    symbols: normalized.symbols,
    mode: 'plan-only',
  };
  if (normalized.strategy === 'ratio_band') {
    request.thresholdLow = normalized.thresholdLow;
    request.thresholdHigh = normalized.thresholdHigh;
  }
  if (normalized.strategy === 'macd') {
    request.macd = normalized.macd;
  }

  const status = {
    taskId,
    strategy: normalized.strategy,
    status: 'queued', // 已创建但未执行
    mode: 'plan-only', // 阶段 2 明确标记：仅计划，未接入引擎
    createdAt: now,
    updatedAt: now,
    note: '任务已创建（计划态），请点击「确认并生成视频」显式执行。',
    result: null,
    error: null,
  };

  atomicWriteJson(path.join(dir, 'request.json'), request);
  atomicWriteJson(path.join(dir, 'status.json'), status);

  return { taskId, status };
}

// 查询任务状态；taskId 非法返回 null（调用方据此返回 404）
function getTask(taskId) {
  if (!isValidTaskId(taskId)) return null;
  const statusPath = path.join(taskDir(taskId), 'status.json');
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

// 仅读取 request.json（用于展示已创建参数）
function getRequest(taskId) {
  if (!isValidTaskId(taskId)) return null;
  const p = path.join(taskDir(taskId), 'request.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

module.exports = {
  TASKS_DIR,
  UUID_RE,
  isValidTaskId,
  taskDir,
  createTask,
  getTask,
  getRequest,
  readTaskFile,
  updateStatus,
  setRunning,
  setProgress,
  setSuccess,
  setFailed,
  listTaskIds,
  recoverInterruptedTasks,
};
