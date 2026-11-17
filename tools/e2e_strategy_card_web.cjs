'use strict';
// tools/e2e_strategy_card_web.cjs
// 策略卡网页链路端到端：起本地服务 → POST /api/tasks → POST /execute → 轮询 → 校验视频。
// 这是「陌生人不用命令行」的关键回归：走的是浏览器同一条路径（不直接调适配器）。
//
// 前置：本机可访问东方财富日线接口；Python + deps 已就绪。
// 用法：node tools/e2e_strategy_card_web.cjs [--port 8123] [--keep]
// 退出码：0 成功；1 失败。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PORT = Number(arg('port', '8123'));
const KEEP = process.argv.includes('--keep');
const TMP_TASKS = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-card-e2e-'));

// 故意把结束日期设成「今天」：验证区间会自动收敛到最新已收盘交易日，
// 而不是因为「今天未收盘 K 线被剔除」直接失败（这是网页表单的默认行为）。
function isoToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const payload = {
  strategy: 'strategy_card',
  templateId: 'close_buy_open_sell',
  symbol: '600000',
  name: '浦发银行',
  startDate: '2024-01-02',
  endDate: isoToday(),
  initialCapital: 100000,
  params: { entrySignal: 'macd_golden', holdIfGte: 0.02 },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status, body };
}

async function main() {
  const srv = spawn(process.execPath, [path.join(ROOT, 'web', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), WEB_TASKS_DIR: TMP_TASKS }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d; });
  srv.stderr.on('data', (d) => { srvOut += d; });

  const base = `http://127.0.0.1:${PORT}`;
  let taskId = null;
  try {
    // 1) 等待服务就绪
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const h = await jsonFetch(base + '/api/health');
        if (h.status === 200 && h.body && h.body.ok) { ready = true; break; }
      } catch (_) { /* 还没起来 */ }
      await sleep(250);
    }
    if (!ready) throw new Error('服务未就绪：\n' + srvOut);
    console.log('[e2e] 服务已就绪 →', base);

    // 2) 创建任务
    const created = await jsonFetch(base + '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (created.status !== 201 || !created.body.ok) {
      throw new Error(`创建任务失败 ${created.status}：${JSON.stringify(created.body)}`);
    }
    taskId = created.body.taskId;
    console.log('[e2e] 任务已创建', taskId, 'status=', created.body.status);

    // 3) 显式执行
    const exec = await jsonFetch(base + '/api/tasks/' + taskId + '/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (exec.status !== 202 || !exec.body.ok) {
      throw new Error(`启动执行失败 ${exec.status}：${JSON.stringify(exec.body)}`);
    }
    console.log('[e2e] 已开始执行 runId=', exec.body.runId);

    // 4) 轮询（渲染 720 帧，给足时间）
    let task = null;
    const deadline = Date.now() + 15 * 60 * 1000;
    let lastStep = '';
    while (Date.now() < deadline) {
      const g = await jsonFetch(base + '/api/tasks/' + taskId);
      if (g.status !== 200 || !g.body.ok) throw new Error('查询任务失败：' + JSON.stringify(g.body));
      task = g.body.task;
      const step = (task.progress && task.progress.currentStep) || '';
      if (step !== lastStep) {
        console.log('[e2e] 阶段：', step || task.status);
        lastStep = step;
      }
      if (task.status === 'success' || task.status === 'failed') break;
      await sleep(2000);
    }
    if (!task) throw new Error('轮询超时，未取到任务状态');
    if (task.status !== 'success') {
      throw new Error(`任务未成功：${task.status}\n${JSON.stringify(task.error, null, 2)}`);
    }

    // 5) 视频可下载 + 结果可读
    const v = await fetch(base + '/api/tasks/' + taskId + '/video');
    const buf = Buffer.from(await v.arrayBuffer());
    const isMp4 = v.status === 200 && buf.length > 1000 && buf.slice(4, 8).toString() === 'ftyp';
    if (!isMp4) throw new Error(`视频不可用：status=${v.status} bytes=${buf.length}`);
    const trace = await jsonFetch(base + '/api/tasks/' + taskId + '/traceability');

    const r = task.result || {};
    console.log('\n=== 结果 ===');
    console.log('  证券        ：', r.symbol, r.name);
    console.log('  模板        ：', r.templateName);
    console.log('  区间        ：', r.period && r.period.start, '→', r.period && r.period.end, `(${r.marketDays} 日)`);
    if (r.rangeAdjust) {
      console.log('  区间收敛    ：', r.rangeAdjust.requestedEnd, '→', r.rangeAdjust.effectiveEnd);
      if (r.rangeAdjust.effectiveEnd !== r.period.end) {
        throw new Error('区间收敛结果与实际区间终点不一致');
      }
    } else if (payload.endDate !== r.period.end) {
      throw new Error(`请求终点 ${payload.endDate} 未收敛却与实际终点 ${r.period.end} 不同`);
    }
    console.log('  期末资产    ：', r.final, '收益', (Number(r.totalReturn) * 100).toFixed(2) + '%',
      '回撤', (Number(r.maxDD) * 100).toFixed(2) + '%', '交易', r.trades, '笔');
    console.log('  持有对照    ：', r.holdFinal);
    console.log('  数据        ：', r.source && r.source.kind, r.source && r.source.adjust,
      '取数', r.source && r.source.fetchStart, '→', r.source && r.source.fetchEnd,
      `${r.source && r.source.bars} 根`);
    console.log('  结果指纹    ：', String(r.resultSha256).slice(0, 16) + '…');
    console.log('  视频        ：', r.video && `${r.video.width}x${r.video.height}@${r.video.fps} ${r.video.durationSec}s ${r.video.frames} 帧`,
      `${buf.length} 字节`);
    console.log('  视频 SHA    ：', String(r.video && r.video.sha256).slice(0, 16) + '…');
    console.log('  独立验收    ：', r.verification && `PASS ${r.verification.pass}/${r.verification.total}`);
    if (trace.status !== 200 || !trace.body || !trace.body.ok) {
      throw new Error(`溯源接口不可用：HTTP ${trace.status} ${JSON.stringify(trace.body)}`);
    }
    const tr = trace.body.traceability;
    console.log('  溯源        ：', `${tr.verification.verified}/${tr.verification.points} 条记录按行号回读一致`);

    if (r.verification && r.verification.pass !== r.verification.total) {
      throw new Error('独立验收未全通过');
    }
    console.log('\n[e2e] 策略卡网页链路 PASS');

    if (!KEEP) {
      const del = await jsonFetch(base + '/api/tasks/' + taskId, { method: 'DELETE' });
      console.log('[e2e] 清理任务：', del.status === 200 ? 'ok' : JSON.stringify(del.body));
      taskId = null;
    }
    return 0;
  } finally {
    srv.kill();
    await sleep(300);
    if (!KEEP) {
      try { fs.rmSync(TMP_TASKS, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    } else {
      console.log('[e2e] --keep：任务目录保留在', TMP_TASKS, '运行目录见输出');
    }
  }
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error('\n[e2e] FAIL：' + (e && e.message ? e.message : e));
  try { fs.rmSync(TMP_TASKS, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exitCode = 1;
});
