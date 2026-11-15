'use strict';
// web/src/engineBridge.js
// 阶段 3 建立、阶段 4A 升级为「通用编排 + 策略路由」。
//
// 本文件只负责与策略无关的事：并发守卫、状态机、真实阶段进度、日志、
// MP4 复制到受控任务目录、错误码落盘、失败提示。策略专属逻辑一律在
// web/src/adapters/<strategy>.cjs，避免把 MACD 专有流程塞进桥接层。
//
// 适配器注册表（只有注册了的策略才能从网页执行）：
//   ratio_band   → adapters/ratioBand.cjs（阶段 3 已验证，行为不变）
//   macd         → adapters/macd.cjs（阶段 4A 新增，离线可复现）
//   dividend_etf → adapters/dividendEtf.cjs（阶段 4B 新增，A 级离线归档 + 独立验收）
// 阶段 4B 起三条策略均已接入，E_STRATEGY_UNSUPPORTED 仅用于未知策略。
//
// 约束：
//   1. child_process.spawn + 参数数组，绝不拼接 shell 命令。
//   2. 引擎在独立子进程运行，HTTP 服务不阻塞。
//   3. 创建任务绝不自动执行；必须用户显式「确认并生成视频」。
//   4. 每个任务唯一安全 runId（web_<uuid 去连字符>），失败任务禁止重跑，避免覆盖/plan 冲突。
//   5. 进度只记录真实可观测阶段，不生成百分比。
//   6. 用户成功生成的视频保留在任务目录，任何自动流程都不删除。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PROJECT_ROOT } = require('./paths');
const TM = require('./taskManager');

const ratioBand = require('./adapters/ratioBand.cjs');
const macd = require('./adapters/macd.cjs');
const dividendEtf = require('./adapters/dividendEtf.cjs');
const genericChart = require('./adapters/genericChart.cjs');

const RUNS_DIR = path.join(PROJECT_ROOT, 'agent', 'runs');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const UNIFIED = ratioBand.UNIFIED; // 兼容阶段 3 导出

// 可执行策略 → 适配器
// V0.2 预览：timeseries / cross_section 走同一个通用图表渲染器，只是数据类不同。
// stock_ohlc 尚未注册（受 DATA_SPEC §7.1 股票通道门禁约束），请求在参数校验阶段即被拒绝。
const ADAPTERS = {
  ratio_band: ratioBand,
  macd,
  dividend_etf: dividendEtf,
  timeseries: genericChart.timeseries,
  cross_section: genericChart.cross_section,
};

// 并发上限 1：当前正在执行的任务 id（同步守卫）
let activeTaskId = null;

// 可注入的 spawn 实现（默认真实 spawn；测试替换为 mock）
let spawnImpl = (cmd, args, opts) => spawn(cmd, args, opts);
function setSpawnImpl(fn) { spawnImpl = fn; }
function getActiveTaskId() { return activeTaskId; }

function runIdForTask(taskId) {
  return 'web_' + String(taskId).replace(/-/g, '');
}

// 兼容阶段 3 导出（ratio_band 专属映射，供既有测试直接调用）
function buildRequestFile(taskId, request) {
  return ratioBand.buildRequestFile(taskId, request);
}

// 通用子进程执行：参数数组、无 shell、日志落盘、输出收集
function runCommand(cmd, args, log) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (log) log.write(d); });
    child.stderr.on('data', (d) => { if (log) log.write(d); });
    child.on('error', (e) => reject({ code: 'E_SPAWN_FAILED', message: e.message }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

// 构造真实阶段进度（不提供 percent / 总耗时等虚构量）
function makeInitialProgress(adapter) {
  return {
    phase: adapter.STEPS[0],
    currentStep: adapter.STEPS[0],
    steps: adapter.STEPS.map((name, i) => ({
      name, tool: name, state: i === 0 ? 'running' : 'pending', ok: false,
    })),
  };
}

// 同步守卫：判断能否开始执行（适配器 + 本任务状态 + 全局并发上限 1）。
function tryBeginExecute(taskId) {
  const request = TM.getRequest(taskId);
  const status = TM.getTask(taskId);
  if (!request || !status) {
    return { ok: false, code: 'E_TASK_NOT_FOUND', message: '任务不存在' };
  }
  const adapter = ADAPTERS[status.strategy];
  if (!adapter) {
    return { ok: false, code: 'E_STRATEGY_UNSUPPORTED', message: '该数据类别尚未接入执行链路（当前可执行：macd / timeseries / cross_section）' };
  }
  // 先检查本任务自身状态（精确语义），再做全局并发守卫
  if (status.status === 'running') {
    return { ok: false, code: 'E_ALREADY_RUNNING', message: '任务正在执行，请勿重复点击' };
  }
  if (status.status === 'success') {
    return { ok: false, code: 'E_ALREADY_DONE', message: '任务已完成，无需重复执行' };
  }
  if (status.status === 'failed') {
    // 失败任务一律不重跑：runId 由 taskId 派生，重跑会写同一目录，可能覆盖产物/触发 plan 冲突
    return { ok: false, code: 'E_TASK_FAILED_RETRY', message: '任务已失败，请新建任务重试' };
  }
  if (activeTaskId) {
    return { ok: false, code: 'E_CONCURRENCY', message: '另一任务正在执行（并发上限为 1），请稍后再试' };
  }
  const runId = runIdForTask(taskId);
  activeTaskId = taskId; // 同步占用，防止并发/重复启动
  TM.setRunning(taskId, runId);
  TM.setProgress(taskId, makeInitialProgress(adapter));
  return { ok: true, runId, adapter };
}

// 异步执行主流程：适配器执行真实步骤 → 复制 MP4 → 写结果。全程更新 status.json。
// 返回 Promise（始终 resolve，错误已写入 status.failed）。
function runExecute(taskId, runId, adapter) {
  const taskDir = TM.taskDir(taskId);
  const log = fs.createWriteStream(path.join(taskDir, 'engine.log'), { flags: 'a' });
  const logWrite = (s) => log.write(`[${new Date().toISOString()}] ${s}\n`);

  const progress = makeInitialProgress(adapter);
  const onStep = (idx, state) => {
    const step = progress.steps[idx];
    if (!step) return;
    step.state = state;
    step.ok = state === 'done';
    if (state === 'done') {
      const next = progress.steps[idx + 1];
      if (next) next.state = 'running';
      progress.currentStep = next ? next.name : step.name;
      progress.phase = next ? next.name : '全部阶段完成，正在交付视频';
    } else if (state === 'running') {
      progress.currentStep = step.name;
      progress.phase = step.name;
    }
    TM.setProgress(taskId, JSON.parse(JSON.stringify(progress)));
  };

  const finish = () => {
    log.end();
    activeTaskId = null;
  };

  return Promise.resolve()
    .then(() => {
      logWrite(`execute start runId=${runId} taskId=${taskId} adapter=${adapter.id}`);
      return adapter.execute({
        taskId, runId,
        request: TM.getRequest(taskId),
        taskDir,
        PROJECT_ROOT, RUNS_DIR, OUTPUT_DIR,
        logWrite,
        runCommand: (cmd, args) => runCommand(cmd, args, log),
        onStep,
      });
    })
    .then((out) => {
      // 复制 MP4 到受控任务目录（不覆盖原始产物；成功视频保留在任务目录直到用户明确清理）
      if (!out || !out.mp4 || !fs.existsSync(out.mp4)) {
        throw { code: 'E_VIDEO_MISSING', message: '执行成功但未找到视频文件' };
      }
      const destMp4 = path.join(taskDir, 'video.mp4');
      fs.copyFileSync(out.mp4, destMp4);
      TM.setSuccess(taskId, {
        runId,
        mp4: 'video.mp4',
        result: out.result || null,
        strategySpecific: out.strategySpecific || null,
      });
      logWrite(`success mp4=${destMp4} bytes=${fs.statSync(destMp4).size}`);
      return { ok: true, mp4: 'video.mp4' };
    })
    .catch((err) => {
      const code = err && err.code ? err.code : 'E_ENGINE_FAILED';
      const message = err && err.message ? err.message : '执行失败';
      TM.setFailed(taskId, {
        code, message, runId,
        hint: '请新建任务重试',
        missing: err && Array.isArray(err.missing) ? err.missing : null,
      });
      logWrite(`failed: ${code} ${message}`);
      if (err && err.missing) logWrite('missing files: ' + err.missing.join('、'));
      return { ok: false, code, message };
    })
    .then((v) => { finish(); return v; }, (e) => { finish(); throw e; });
}

// 对外：尝试开始执行。同步守卫通过后，后台异步运行（HTTP 不阻塞）。
function executeTask(taskId) {
  const guard = tryBeginExecute(taskId);
  if (!guard.ok) return { ok: false, code: guard.code, message: guard.message };
  runExecute(taskId, guard.runId, guard.adapter).catch(() => { /* 已处理 */ });
  return { ok: true, runId: guard.runId };
}

// 删除任务的运行目录（output/web_<uuid>）。任务目录本身由 taskManager.deleteTask 负责。
// 路径完全由 taskId 派生，并再次确认父目录就是 OUTPUT_DIR，杜绝越界删除。
function deleteRunDir(taskId) {
  if (!TM.isValidTaskId(taskId)) return { ok: false, code: 'E_TASK_ID_INVALID', message: '非法的任务 ID 格式' };
  if (activeTaskId === taskId) {
    return { ok: false, code: 'E_ALREADY_RUNNING', message: '任务正在执行，请等它结束后再删除' };
  }
  const dir = path.join(OUTPUT_DIR, runIdForTask(taskId));
  if (path.dirname(dir) !== OUTPUT_DIR) {
    return { ok: false, code: 'E_TASK_ID_INVALID', message: '运行目录越界，已拒绝' };
  }
  if (!fs.existsSync(dir)) return { ok: true, removed: false };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, removed: !fs.existsSync(dir) };
}

module.exports = {
  runIdForTask,
  buildRequestFile,
  tryBeginExecute,
  runExecute,
  executeTask,
  getActiveTaskId,
  setSpawnImpl,
  deleteRunDir,
  ADAPTERS,
  UNIFIED,
  RUNS_DIR,
  OUTPUT_DIR,
};
