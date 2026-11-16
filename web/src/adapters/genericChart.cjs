'use strict';
// web/src/adapters/genericChart.cjs
// 用户 CSV（A/B 两类）适配器：归一化模型 → 通用图表渲染器 → MP4。
//
// 与 macd.cjs 的分工一致：本文件只做这一类数据的编排，engineBridge 只做通用调度。
//
// 关键约束：
//   1. 不读 CSV 原文、不重新校验、不重算任何数字——归一化在「创建任务」时已完成，
//      本适配器只消费任务目录里的 import.json。这样「校验失败」与「执行失败」不会互相掩盖。
//   2. 渲染器只用 deps/ 里的 Pillow + imageio-ffmpeg，不联网。
//   3. runId 目录已存在产物时拒绝执行，避免覆盖历史视频。
//   4. 渲染后做一次「报告 ↔ 模型」勾稽；不一致就判失败，不把可疑视频交付给用户。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT } = require('../paths');
const { parseCsv, countTextLines, countDataRecords } = require('../csv');

const RENDER_SCRIPT = path.join(PROJECT_ROOT, 'engine_next', 'render_generic_chart.py');

const STEPS = [
  '读取并复核归一化数据',
  '对照原始 CSV 核对每个数字的行号',
  '写入运行目录输入',
  '渲染视频（通用图表）',
];

function resolvePython() {
  for (const cmd of [process.env.STV_PYTHON, 'python', 'python3']) {
    if (!cmd) continue;
    const r = spawnSync(cmd, ['--version'], { timeout: 8000, encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

function sha256OfFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// 逐点回读 source.csv：按行号取回原始记录，确认「画面上的这个数」确实来自这一行。
// 任何一处对不上即整体失败——宁可不交付，也不交付一个无法回溯的视频。
function buildTrace(model, sourceText, sourceMeta) {
  const parsed = parseCsv(sourceText);
  if (!parsed.ok) {
    return { ok: false, message: `原始 CSV 留档无法解析（${parsed.code}），无法核对溯源` };
  }
  const byLine = new Map();
  for (const rec of parsed.records) byLine.set(rec.line, rec);

  const header = parsed.records[0];
  if (!header) return { ok: false, message: '原始 CSV 留档没有表头，无法核对溯源' };
  const colOf = (fieldName) => {
    const name = (model.meta.mapping || {})[fieldName];
    if (!name) return -1;
    return header.fields.findIndex((f) => f.text.trim() === name);
  };
  const dateCol = colOf('date');
  const valueCol = colOf('value');
  const seriesCol = colOf('series');
  const labelCol = colOf('label');
  const groupCol = colOf('group');
  const value2Col = colOf('value2');

  const trace = [];
  const problems = [];

  const numMatches = (raw, value) => {
    const t = String(raw == null ? '' : raw).trim();
    if (t === '') return value === null || value === undefined;
    const n = Number(t);
    return Number.isFinite(n) && Math.abs(n - value) < 1e-9;
  };

  if (model.class === 'timeseries') {
    for (const s of model.series || []) {
      for (const p of s.points || []) {
        const rec = byLine.get(p.line);
        if (!rec) { problems.push(`序列「${s.name}」${p.date} 标注第 ${p.line} 行，但留档里没有这一行`); continue; }
        const dOk = dateCol >= 0 && rec.fields[dateCol] && rec.fields[dateCol].text.trim() === p.date;
        const vOk = valueCol >= 0 && rec.fields[valueCol] && numMatches(rec.fields[valueCol].text, p.value);
        if (!dOk || !vOk) {
          problems.push(`第 ${p.line} 行回读不一致（期望 ${p.date} / ${p.value}）`);
          continue;
        }
        trace.push({
          kind: 'point',
          series: s.name,
          date: p.date,
          value: p.value,
          sourceLine: p.line,
          sourceText: clip(rec.fields.map((f) => f.text).join(',')),
        });
      }
    }
  } else {
    for (const r of model.rows || []) {
      const rec = byLine.get(r.line);
      if (!rec) { problems.push(`「${r.label}」标注第 ${r.line} 行，但留档里没有这一行`); continue; }
      const lOk = labelCol >= 0 && rec.fields[labelCol] && rec.fields[labelCol].text.trim() === r.label;
      const vOk = valueCol >= 0 && rec.fields[valueCol] && numMatches(rec.fields[valueCol].text, r.value);
      if (!lOk || !vOk) {
        problems.push(`第 ${r.line} 行回读不一致（期望 ${r.label} / ${r.value}）`);
        continue;
      }
      const item = {
        kind: 'bar',
        label: r.label,
        value: r.value,
        sourceLine: r.line,
        sourceText: clip(rec.fields.map((f) => f.text).join(',')),
      };
      if (r.share !== undefined) item.share = r.share;
      if (groupCol >= 0 && r.group !== undefined) item.group = r.group;
      if (value2Col >= 0 && r.value2 !== undefined) item.value2 = r.value2;
      trace.push(item);
    }
  }

  if (problems.length) {
    return { ok: false, message: `溯源核对失败（${problems.length} 处）：${problems.slice(0, 3).join('；')}` };
  }

  return {
    ok: true,
    data: {
      source: sourceMeta,
      mapping: model.meta.mapping || {},
      trace,
      verification: {
        points: trace.length,
        verified: trace.length,
        ok: true,
        method: '解析任务目录 source.csv，按行号回读并逐字段比对（日期/名称/数值）',
      },
    },
  };
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > (n || 160) ? t.slice(0, (n || 160) - 1) + '…' : t;
}

function makeAdapter(dataClass) {
  return {
    id: dataClass,
    dataClass,
    STEPS,
    RENDER_SCRIPT,

    async execute(ctx) {
      const { runId, taskId, taskDir, runCommand, onStep, logWrite } = ctx;

      // ---- 步骤 0：读取归一化模型 ----
      onStep(0, 'running');
      const importPath = path.join(taskDir, 'import.json');
      if (!fs.existsSync(importPath)) {
        throw { code: 'E_IMPORT_MISSING', message: '任务目录缺少 import.json（归一化数据），请新建任务重试' };
      }
      const model = JSON.parse(fs.readFileSync(importPath, 'utf8'));
      if (!model || model.class !== dataClass) {
        throw {
          code: 'E_IMPORT_MISMATCH',
          message: `import.json 的类别（${model && model.class}）与任务类别（${dataClass}）不一致，请新建任务重试`,
        };
      }
      onStep(0, 'done');

      // ---- 步骤 1：溯源核对（每个数字 → source.csv 的具体行） ----
      // 留档缺失即停止：没有原始文件的视频无法被追溯，不该交付。
      onStep(1, 'running');
      const sourcePath = path.join(taskDir, 'source.csv');
      if (!fs.existsSync(sourcePath)) {
        throw {
          code: 'E_SOURCE_MISSING',
          message: '任务目录缺少原始 CSV 留档（source.csv），无法核对数字来源。请新建任务重试。',
        };
      }
      const sourceBuf = fs.readFileSync(sourcePath);
      const sourceSha = crypto.createHash('sha256').update(sourceBuf).digest('hex');
      if (model.meta.sourceSha256 && model.meta.sourceSha256 !== sourceSha) {
        throw {
          code: 'E_TRACE_MISMATCH',
          message: 'source.csv 的 SHA-256 与创建任务时记录的不一致（留档被改动过），已停止交付。',
        };
      }
      const sourceMeta = {
        fileName: model.meta.fileName || '',
        archivedAs: 'source.csv',
        sha256: sourceSha,
        bytes: sourceBuf.length,
        lines: countTextLines(sourceBuf.toString('utf8')),
        dataLines: countDataRecords(sourceBuf.toString('utf8')),
        importedAt: model.meta.importedAt || '',
      };
      const tr = buildTrace(model, sourceBuf.toString('utf8'), sourceMeta);
      if (!tr.ok) {
        throw { code: 'E_TRACE_FAILED', message: `${tr.message}（已停止交付，未生成可下载视频）` };
      }
      logWrite(`trace ok: ${tr.data.verification.verified} 个数据点全部定位到 source.csv 行号 sha256=${sourceSha.slice(0, 12)}`);
      onStep(1, 'done');

      // ---- 步骤 2：写入运行目录（产物与输入都可定位） ----
      onStep(2, 'running');
      const runDir = path.join(ctx.OUTPUT_DIR, runId);
      const videoDir = path.join(runDir, '04_video');
      if (fs.existsSync(path.join(videoDir, 'video.mp4'))) {
        throw { code: 'E_RUN_DIR_EXISTS', message: '该 runId 下已有历史视频，为避免覆盖已拒绝执行。请新建任务重试。' };
      }
      const inputDir = path.join(runDir, '01_input');
      fs.mkdirSync(inputDir, { recursive: true });
      const normalizedPath = path.join(inputDir, 'normalized.json');
      fs.writeFileSync(normalizedPath, JSON.stringify(model, null, 2), 'utf8');
      logWrite(`input normalized class=${model.class} rows=${model.meta.rowCount} -> ${normalizedPath}`);
      onStep(2, 'done');

      // ---- 步骤 3：渲染 ----
      onStep(3, 'running');
      const python = resolvePython();
      if (!python) throw { code: 'E_PYTHON_MISSING', message: '未找到可用的 Python（python / python3），无法渲染视频' };
      // 显式传 --out：不依赖渲染器默认的 <repo>/output/<runId>，
      // 否则运行目录一旦被指定到别处（测试/临时目录），产物会写到与 ctx.OUTPUT_DIR 无关的地方。
      const r = await runCommand(python, [RENDER_SCRIPT, '--input', normalizedPath, '--run', runId, '--out', videoDir]);
      const mp4 = path.join(videoDir, 'video.mp4');
      const reportPath = path.join(videoDir, 'render_report.json');
      if (r.code !== 0 || !fs.existsSync(mp4) || !fs.existsSync(reportPath)) {
        throw {
          code: 'E_RENDER_FAILED',
          message: '通用图表渲染失败或未产出 video.mp4 / render_report.json（详见任务目录 engine.log）',
        };
      }
      const R = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

      // ---- 勾稽：报告与模型必须一致，防止把可疑视频交付给用户 ----
      if (R.class !== model.class) {
        throw { code: 'E_VERIFY_FAILED', message: `渲染报告类别（${R.class}）与输入（${model.class}）不一致` };
      }
      if (Number(R.rowCount) !== Number(model.meta.rowCount)) {
        throw {
          code: 'E_VERIFY_FAILED',
          message: `渲染报告行数（${R.rowCount}）与归一化数据（${model.meta.rowCount}）不一致，已停止交付`,
        };
      }
      if (model.class === 'timeseries' && Number(R.seriesCount) !== (model.series || []).length) {
        throw { code: 'E_VERIFY_FAILED', message: '渲染报告序列数与输入不一致，已停止交付' };
      }
      if (model.class === 'cross_section' && Number(R.barCount) !== (model.rows || []).length) {
        throw { code: 'E_VERIFY_FAILED', message: '渲染报告条目数与输入不一致，已停止交付' };
      }
      if (!(R.outputBytes > 0) || fs.statSync(mp4).size !== R.outputBytes) {
        throw { code: 'E_VERIFY_FAILED', message: '视频文件大小与渲染报告不一致，已停止交付' };
      }
      logWrite(`render ok: ${mp4} bytes=${R.outputBytes} frames=${R.frames} duration=${R.durationSec}s`);
      onStep(3, 'done');

      // ---- 交付（所有数字都可回溯，见 traceability.json） ----
      const derivations = model.class === 'cross_section' && model.meta.shareBasis === 'all-nonnegative'
        ? ['占比 = 该行 value ÷ 全部 value 合计']
        : [];
      const videoSha = sha256OfFile(mp4);
      const traceability = Object.assign({
        taskId,
        generatedAt: new Date().toISOString(),
        derivations,
        video: {
          file: 'video.mp4',
          sha256: videoSha,
          bytes: R.outputBytes,
          frames: R.frames,
          fps: R.fps,
          durationSec: R.durationSec,
          width: R.width,
          height: R.height,
        },
      }, tr.data);
      fs.writeFileSync(path.join(taskDir, 'traceability.json'), JSON.stringify(traceability, null, 2), 'utf8');
      logWrite(`video sha256=${videoSha}`);

      const result = {
        title: model.meta.title,
        dataClass: model.class,
        rowCount: model.meta.rowCount,
        period: model.class === 'timeseries' && (model.series || []).length
          ? {
            start: model.series[0].points[0].date,
            end: model.series[0].points[model.series[0].points.length - 1].date,
          }
          : null,
        seriesCount: model.class === 'timeseries' ? (model.series || []).length : null,
        barCount: model.class === 'cross_section' ? (model.rows || []).length : null,
        warnings: model.meta.warnings || [],
        video: {
          width: R.width, height: R.height, fps: R.fps,
          frames: R.frames, durationSec: R.durationSec,
          sha256: videoSha,
          bytes: R.outputBytes,
        },
        source: {
          fileName: sourceMeta.fileName,
          archivedAs: sourceMeta.archivedAs,
          sha256: sourceMeta.sha256,
          bytes: sourceMeta.bytes,
          lines: sourceMeta.lines,
          dataLines: sourceMeta.dataLines,
        },
        trace: tr.data.verification,
        verification: {
          script: 'engine_next/render_generic_chart.py（报告↔模型勾稽）+ source.csv 逐行回读',
          pass: true,
          fail: 0,
        },
        traceability: {
          file: 'traceability.json',
          sourceLines: sourceMeta.lines,
          mapping: model.meta.mapping,
          derivations,
        },
      };
      const strategySpecific = {
        dataClass: model.class,
        renderer: 'engine_next/render_generic_chart.py',
        inputFile: path.relative(ctx.PROJECT_ROOT, normalizedPath),
        reportFile: path.relative(ctx.PROJECT_ROOT, reportPath),
      };
      fs.writeFileSync(path.join(taskDir, 'run_result.json'), JSON.stringify({ result, strategySpecific }, null, 2), 'utf8');
      return { mp4, result, strategySpecific };
    },
  };
}

module.exports = {
  STEPS,
  RENDER_SCRIPT,
  makeAdapter,
  timeseries: makeAdapter('timeseries'),
  cross_section: makeAdapter('cross_section'),
};
