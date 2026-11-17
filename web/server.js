'use strict';
// 阶段 1（网页脚手架）：本地 HTTP 服务器，仅监听 127.0.0.1。
// 提供：GET / 主页、GET /api/health 环境检查。不接入任何回测/渲染。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PUBLIC_DIR, PROJECT_ROOT, DEPS_DIR, ENGINE_NEXT_DIR } = require('./src/paths');
const { validateTaskRequest } = require('./src/validation');
const {
  createTask, getTask, isValidTaskId, taskDir: taskManagerTaskDir, recoverInterruptedTasks,
  deleteTask, readTaskFile,
} = require('./src/taskManager');
const engineBridge = require('./src/engineBridge');
const { previewNl } = require('./src/nlPreview');

// 请求体上限。
// V0.2 起用户 CSV 随 JSON 一起提交（浏览器 FileReader → csvText），需留出转义余量：
// 文件级上限仍是 DATA_SPEC §1.1 的 2 MiB，由校验器判定；这里是传输层上限。
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB

// 可执行策略（接口自述口径）。V0.2 起股票通道门禁已通过并实装：
//   macd（V0.1 演示，SIMULATED）+ timeseries / cross_section（A/B 用户 CSV）
//   + stock_ohlc（C 类用户 CSV → MACD 回测 → V1.2.3 验收交付）
//   + strategy_card（代码 + 区间 + 模板 → 自动取数 → 统一回测 → 通用策略片）
// 只保留单一真相源 STRATEGY_MODES，executableStrategies / strategies / strategyModes
// 三处都从它派生，避免「前端可执行、health 却宣称不可执行」的口径漂移。
const STRATEGY_MODES = {
  macd: 'executable',
  timeseries: 'executable',
  cross_section: 'executable',
  stock_ohlc: 'executable',
  strategy_card: 'executable',
};
const EXECUTABLE_STRATEGIES = Object.keys(STRATEGY_MODES);

// 修订点 1：仅回环地址，绝不监听 0.0.0.0
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const PORT_RAW = parseInt(process.env.PORT, 10);
const PORT = Number.isInteger(PORT_RAW) && PORT_RAW > 0 && PORT_RAW < 65536 ? PORT_RAW : DEFAULT_PORT;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- 环境检查（独立、容错，不抛异常）----
function runCheck(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { timeout: 8000, encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } catch (e) {
    return { code: null, out: '', error: e.message };
  }
}

function checkPython() {
  for (const cmd of ['python', 'python3']) {
    const r = runCheck(cmd, ['--version']);
    if (r.code === 0 && r.out.trim()) {
      const version = r.out.trim().split('\n').pop().trim();
      return { available: true, command: cmd, version };
    }
  }
  return { available: false, reason: 'python/python3 均未在 PATH 中找到' };
}

function checkFfmpeg(pythonCmd) {
  // 1) 经 imageio_ffmpeg（最贴近真实渲染路径）
  if (pythonCmd) {
    const r = runCheck(pythonCmd, ['-c',
      "import imageio_ffmpeg, os; p=imageio_ffmpeg.get_ffmpeg_exe(); print('FOUND' if os.path.exists(p) else 'MISSING')"]);
    if (r.code === 0 && r.out.includes('FOUND')) return { available: true, source: 'imageio_ffmpeg' };
  }
  // 2) deps 目录 glob
  try {
    const dir = path.join(DEPS_DIR, 'imageio_ffmpeg', 'binaries');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('ffmpeg') && f.endsWith('.exe'));
      if (files.length) return { available: true, source: 'deps-glob' };
    }
  } catch (_) { /* ignore */ }
  // 3) 系统 ffmpeg
  const r2 = runCheck('ffmpeg', ['-version']);
  if (r2.code === 0) return { available: true, source: 'system' };
  return { available: false, reason: 'ffmpeg 不可用（deps / imageio_ffmpeg / 系统均未找到）' };
}

function getHealthInfo() {
  const node = { available: true, version: process.version };
  const py = checkPython();
  const ffmpeg = checkFfmpeg(py.available ? py.command : null);
  const depsDir = { exists: fs.existsSync(DEPS_DIR) };
  const projectRoot = { resolved: true, valid: fs.existsSync(ENGINE_NEXT_DIR) || fs.existsSync(path.join(PROJECT_ROOT, 'engine')) };
  const renderReady = py.available && ffmpeg.available && depsDir.exists;
  return {
    ok: true, // 服务器可运行（本端点已响应即说明）
    mode: 'plan-only', // 阶段 2：已开放任务创建/查询，但仍未接入回测/渲染执行
    server: { host: HOST, port: PORT, nodeVersion: process.version },
    renderEnv: { ready: renderReady },
    // 阶段 4A 建立、4B 更新：capabilities 准确反映当前可执行策略，不再恒显示 execution:false。
    // autoExecution=false 表示「绝不自动执行」；execution 描述显式确认后可用的真实执行能力。
    capabilities: {
      taskPlanning: true, // 可创建/查询 plan-only 任务
      autoExecution: false, // 创建任务绝不自动执行（阶段 1/2 起的核心约束，不变）
      execution: {
        available: true,
        mode: 'explicit-confirm', // 仅用户点击「确认并生成视频」后执行
        strategies: EXECUTABLE_STRATEGIES.slice(),
        concurrency: 1,
      },
      executableStrategies: EXECUTABLE_STRATEGIES.slice(),
      strategyModes: Object.assign({}, STRATEGY_MODES),
      strategies: EXECUTABLE_STRATEGIES.slice(),
    },
    checks: { node, python: py, ffmpeg, depsDir, projectRoot },
  };
}

// ---- 静态文件服务（限制在 PUBLIC_DIR 内，防穿越）----
function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function handler(req, res) {
  const pathname = (() => {
    try { return new URL(req.url, `http://${HOST}:${PORT}`).pathname; } catch (_) { return '/'; }
  })();

  if (pathname === '/api/health') {
    const info = getHealthInfo();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(info, null, 2));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/nl/preview') {
    return handleNlPreview(req, res);
  }
  if (req.method === 'POST' && pathname === '/api/tasks') {
    return handleCreateTask(req, res);
  }
  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (req.method === 'GET' && taskMatch) {
    return handleGetTask(req, res, taskMatch[1]);
  }
  // 删除任务：同时清掉任务目录（含 source.csv / video.mp4）与运行目录 output/web_<uuid>
  if (req.method === 'DELETE' && taskMatch) {
    return handleDeleteTask(req, res, taskMatch[1]);
  }
  const traceMatch = /^\/api\/tasks\/([^/]+)\/traceability$/.exec(pathname);
  if (req.method === 'GET' && traceMatch) {
    return handleTraceability(req, res, traceMatch[1]);
  }
  const sourceMatch = /^\/api\/tasks\/([^/]+)\/source$/.exec(pathname);
  if (req.method === 'GET' && sourceMatch) {
    return handleSource(req, res, sourceMatch[1]);
  }
  const execMatch = /^\/api\/tasks\/([^/]+)\/execute$/.exec(pathname);
  if (req.method === 'POST' && execMatch) {
    return handleExecute(req, res, execMatch[1]);
  }
  const videoMatch = /^\/api\/tasks\/([^/]+)\/video$/.exec(pathname);
  if (req.method === 'GET' && videoMatch) {
    return handleVideo(req, res, videoMatch[1]);
  }
  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'unknown_api', path: pathname }));
    return;
  }
  serveStatic(req, res);
}

// 严格同源/同端口校验（CSRF 防护）：仅放行「无 Origin/Referer 的本地工具/简单请求」
// 或「Origin 与本站完全一致（scheme+host+port）」的请求。其他端口或外部来源一律拒绝，
// 避免其他本地网页或跨站页面触发任务创建/执行。
// 回环主机集合：服务器仅监听 127.0.0.1，但用户可能用 localhost / [::1] 访问，
// 三者都到达同一本地服务，应视为同源。远程主机（含局域网 IP）一律视为跨站。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isSameLoopback(u) {
  try {
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return LOOPBACK_HOSTS.has(u.hostname) && port === String(PORT);
  } catch (_) {
    return false;
  }
}

function isCrossOrigin(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (origin) {
    try {
      const u = new URL(origin);
      // 仅接受「回环主机 + 同端口」视为同源；其余（不同端口 / 远程主机）一律跨站
      return !isSameLoopback(u);
    } catch (_) {
      return true;
    }
  }
  if (referer) {
    try {
      const u = new URL(referer);
      return !isSameLoopback(u);
    } catch (_) {
      return true;
    }
  }
  return false; // 无 Origin/Referer（本地 curl、同端口简单请求）
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

// 读取并校验请求体（大小上限 + Content-Type + JSON 解析）
// opts.allowEmpty=true 时允许空请求体，解析为 {}（用于 execute 端点）
function readJsonBody(req, res, cb, opts) {
  const allowEmpty = !!(opts && opts.allowEmpty);
  const ct = req.headers['content-type'] || '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    return sendJson(res, 415, { ok: false, code: 'E_CONTENT_TYPE', message: '仅接受 application/json 请求体' });
  }
  let size = 0;
  const chunks = [];
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { ok: false, code: 'E_BODY_TOO_LARGE', message: '请求体过大' });
      // 排空剩余请求体，避免客户端 ECONNRESET；不 destroy 连接
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length === 0) {
      if (allowEmpty) return cb({});
      return sendJson(res, 400, { ok: false, code: 'E_JSON_INVALID', message: '空请求体' });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return sendJson(res, 400, { ok: false, code: 'E_JSON_INVALID', message: 'JSON 解析失败' });
    }
    cb(parsed);
  });
  req.on('error', () => {
    if (!aborted) sendJson(res, 400, { ok: false, code: 'E_JSON_INVALID', message: '请求读取失败' });
  });
}

// 自然语言 → 策略卡草案（V0.4 阶段 B）。
// 纯预览端点：不建任务、不取数、不落库、不联网；用户改参后回到这里重走同一套门禁，
// 保证「界面展示的规则串」与「最终提交的参数」同源。
// 解析不通过不是服务器错误，因此统一 200 + ok:false，前端按 issues 展示。
function handleNlPreview(req, res) {
  if (isCrossOrigin(req)) {
    return sendJson(res, 403, { ok: false, code: 'E_CROSS_ORIGIN', message: '拒绝跨站请求' });
  }
  readJsonBody(req, res, (body) => {
    const draft = previewNl(body);
    return sendJson(res, 200, { ok: !!draft.ok, draft });
  });
}

function handleCreateTask(req, res) {
  if (isCrossOrigin(req)) {
    return sendJson(res, 403, { ok: false, code: 'E_CROSS_ORIGIN', message: '拒绝跨站请求' });
  }
  readJsonBody(req, res, (body) => {
    const result = validateTaskRequest(body);
    if (!result.ok) {
      // 校验失败：4xx + 错误码（不创建任何任务目录）
      return sendJson(res, 400, {
        ok: false, code: result.code, message: result.message,
        line: result.line !== undefined ? result.line : undefined,
      });
    }
    const { taskId, status } = createTask(result.value);
    return sendJson(res, 201, {
      ok: true,
      taskId,
      status: status.status,
      mode: status.mode,
      note: status.note,
      strategy: result.value.strategy,
      // 用户 CSV 的「通过但有警告」必须让用户在生成视频前就看到
      warnings: status.warnings && status.warnings.length ? status.warnings : undefined,
    });
  });
}

function handleGetTask(req, res, rawId) {
  let id;
  try { id = decodeURIComponent(rawId); } catch (_) { id = rawId; }
  if (!isValidTaskId(id)) {
    return sendJson(res, 400, { ok: false, code: 'E_TASK_ID_INVALID', message: '非法的任务 ID 格式' });
  }
  const status = getTask(id);
  if (!status) {
    return sendJson(res, 404, { ok: false, code: 'E_TASK_NOT_FOUND', message: '任务不存在' });
  }
  return sendJson(res, 200, { ok: true, task: status });
}

// 删除任务：先删运行目录，再删任务目录（任务目录里有 status.json，最后删掉它，
// 这样中途失败仍能用任务 ID 查到残留）。执行中的任务拒绝删除。
function handleDeleteTask(req, res, rawId) {
  if (isCrossOrigin(req)) {
    return sendJson(res, 403, { ok: false, code: 'E_CROSS_ORIGIN', message: '拒绝跨站请求' });
  }
  let id;
  try { id = decodeURIComponent(rawId); } catch (_) { id = rawId; }
  if (!isValidTaskId(id)) {
    return sendJson(res, 400, { ok: false, code: 'E_TASK_ID_INVALID', message: '非法的任务 ID 格式' });
  }
  const status = getTask(id);
  if (!status) {
    return sendJson(res, 404, { ok: false, code: 'E_TASK_NOT_FOUND', message: '任务不存在' });
  }
  if (engineBridge.getActiveTaskId() === id) {
    return sendJson(res, 409, { ok: false, code: 'E_ALREADY_RUNNING', message: '任务正在执行，请等它结束后再删除' });
  }
  const run = engineBridge.deleteRunDir(id);
  if (!run.ok) {
    return sendJson(res, 400, { ok: false, code: run.code, message: run.message });
  }
  const del = deleteTask(id);
  if (!del.ok) {
    return sendJson(res, del.code === 'E_TASK_NOT_FOUND' ? 404 : 400,
      { ok: false, code: del.code, message: del.message });
  }
  return sendJson(res, 200, {
    ok: true,
    taskId: id,
    removed: { taskDir: true, sourceCsv: true, video: true, runDir: !!run.removed },
  });
}

// 溯源清单：读取任务目录里的 traceability.json（渲染成功时由适配器写入）
function handleTraceability(req, res, rawId) {
  let id;
  try { id = decodeURIComponent(rawId); } catch (_) { id = rawId; }
  if (!isValidTaskId(id)) {
    return sendJson(res, 400, { ok: false, code: 'E_TASK_ID_INVALID', message: '非法的任务 ID 格式' });
  }
  const status = getTask(id);
  if (!status) {
    return sendJson(res, 404, { ok: false, code: 'E_TASK_NOT_FOUND', message: '任务不存在' });
  }
  const tr = readTaskFile(id, 'traceability.json');
  if (!tr) {
    return sendJson(res, 404, {
      ok: false,
      code: 'E_TRACE_MISSING',
      message: '该任务还没有溯源清单（尚未生成视频，或任务创建于本功能之前）',
    });
  }
  return sendJson(res, 200, { ok: true, traceability: tr });
}

// 下载留档的原始 CSV（source.csv），仅供本机核对
function handleSource(req, res, rawId) {
  let id;
  try { id = decodeURIComponent(rawId); } catch (_) { id = rawId; }
  if (!isValidTaskId(id)) {
    return sendJson(res, 400, { ok: false, code: 'E_TASK_ID_INVALID', message: '非法的任务 ID 格式' });
  }
  const status = getTask(id);
  if (!status) {
    return sendJson(res, 404, { ok: false, code: 'E_TASK_NOT_FOUND', message: '任务不存在' });
  }
  const p = path.join(taskManagerTaskDir(id), 'source.csv');
  fs.stat(p, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'E_SOURCE_MISSING', message: '该任务没有原始 CSV 留档' }));
      return;
    }
    const orig = (status.source && status.source.fileName) || 'source.csv';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="source.csv"; filename*=UTF-8''${encodeURIComponent(orig)}`,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(p).pipe(res);
  });
}

// 显式「确认并生成视频」：同步守卫防重复/并发，后台异步执行，立即返回。
function handleExecute(req, res, rawId) {
  if (isCrossOrigin(req)) {
    return sendJson(res, 403, { ok: false, code: 'E_CROSS_ORIGIN', message: '拒绝跨站请求' });
  }
  let id;
  try { id = decodeURIComponent(rawId); } catch (_) { id = rawId; }
  if (!isValidTaskId(id)) {
    return sendJson(res, 400, { ok: false, code: 'E_TASK_ID_INVALID', message: '非法的任务 ID 格式' });
  }
  // 读取请求体（允许空），但执行不依赖 body 内容（参数已在创建时锁定）
  readJsonBody(req, res, () => {
    const r = engineBridge.executeTask(id);
    if (!r.ok) {
      const conflict = ['E_ALREADY_RUNNING', 'E_ALREADY_DONE', 'E_CONCURRENCY', 'E_TASK_FAILED_RETRY'];
      return sendJson(res, conflict.includes(r.code) ? 409 : 400,
        { ok: false, code: r.code, message: r.message, hint: r.code === 'E_TASK_FAILED_RETRY' ? '请新建任务重试' : undefined });
    }
    return sendJson(res, 202, {
      ok: true,
      taskId: id,
      status: 'running',
      runId: r.runId,
      message: '已开始执行，请轮询任务状态。',
    });
  }, { allowEmpty: true });
}

// 视频预览/下载：仅服务 web/tasks/<taskId>/video.mp4，支持 HTTP Range（拖动进度）。
function handleVideo(req, res, rawId) {
  let id;
  try { id = decodeURIComponent(rawId); } catch (_) { id = rawId; }
  if (!isValidTaskId(id)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, code: 'E_TASK_ID_INVALID', message: '非法的任务 ID 格式' }));
    return;
  }
  const status = getTask(id);
  if (!status || status.status !== 'success' || !status.mp4) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, code: 'E_VIDEO_NOT_READY', message: '视频尚未生成或任务未完成' }));
    return;
  }
  const mp4Path = path.join(taskManagerTaskDir(id), status.mp4);
  fs.stat(mp4Path, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'E_VIDEO_MISSING', message: '视频文件缺失' }));
      return;
    }
    const total = stat.size;
    const range = req.headers.range;
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      let start = Number(m[1]);
      let end = m[2] ? Number(m[2]) : total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      end = Math.min(end, total - 1);
      const chunk = end - start + 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      headers['Content-Length'] = chunk;
      res.writeHead(206, headers);
      fs.createReadStream(mp4Path, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = total;
      res.writeHead(200, headers);
      fs.createReadStream(mp4Path).pipe(res);
    }
  });
}

function createServer() {
  return http.createServer(handler);
}

function start(port, host) {
  const srv = createServer();
  srv.listen(port, host, () => {
    const addr = srv.address();
    // 启动即恢复：任何遗留的 running 任务标记为中断（防止误显 success）
    try {
      const n = recoverInterruptedTasks();
      if (n > 0) console.log(`[STV-web] recovered ${n} interrupted task(s) → failed`);
    } catch (_) { /* 忽略恢复错误 */ }
    // 仅输出绑定地址与端口，绝不打印机器专属绝对路径
    console.log(`[STV-web] listening on http://${addr.address}:${addr.port}  (mode=plan-only, 显式确认后可执行: ${EXECUTABLE_STRATEGIES.join(', ')})`);
    console.log(`[STV-web] open: http://127.0.0.1:${addr.port}/`);
  });
  return srv;
}

if (require.main === module) {
  start(PORT, HOST);
}

module.exports = {
  createServer,
  start,
  getHealthInfo,
  handler,
  handleCreateTask,
  handleGetTask,
  handleExecute,
  handleVideo,
  handleDeleteTask,
  handleTraceability,
  handleSource,
  isCrossOrigin,
  readJsonBody,
  HOST,
  PORT,
  MAX_BODY_BYTES,
};
