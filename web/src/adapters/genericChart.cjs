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
const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT } = require('../paths');

const RENDER_SCRIPT = path.join(PROJECT_ROOT, 'engine_next', 'render_generic_chart.py');

const STEPS = [
  '读取并复核归一化数据',
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

function makeAdapter(dataClass) {
  return {
    id: dataClass,
    dataClass,
    STEPS,
    RENDER_SCRIPT,

    async execute(ctx) {
      const { runId, taskDir, runCommand, onStep, logWrite } = ctx;

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

      // ---- 步骤 1：写入运行目录（产物与输入都可定位） ----
      onStep(1, 'running');
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
      onStep(1, 'done');

      // ---- 步骤 2：渲染 ----
      onStep(2, 'running');
      const python = resolvePython();
      if (!python) throw { code: 'E_PYTHON_MISSING', message: '未找到可用的 Python（python / python3），无法渲染视频' };
      const r = await runCommand(python, [RENDER_SCRIPT, '--input', normalizedPath, '--run', runId]);
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
      onStep(2, 'done');

      // ---- 交付（所有数字都可回溯，见 traceability） ----
      const derivations = model.class === 'cross_section' && model.meta.shareBasis === 'all-nonnegative'
        ? ['占比 = 该行 value ÷ 全部 value 合计']
        : [];
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
        },
        verification: {
          script: 'engine_next/render_generic_chart.py（内含报告↔模型勾稽）',
          pass: true,
          fail: 0,
        },
        traceability: {
          source: 'import.json / 01_input/normalized.json',
          fileName: model.meta.fileName,
          importedAt: model.meta.importedAt,
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
