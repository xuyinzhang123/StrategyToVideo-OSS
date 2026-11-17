'use strict';
// web/src/adapters/stockOhlc.cjs
// V0.2 · C 类「股票日线 CSV」适配器。
//
// 职责：把任务目录里已校验的归一化模型（import.json）转成 MACD 回测引擎要求的
//       01_data/stock_daily.json + 01_data/dividend_calendar.json，然后复用现有
//       backtest_stock_macd.cjs / render_stock_macd_v124.py / accept_macd_video_v124.py。
//       （V1.2.4 在 V1.2.3 基础上把主图 Y 轴下限改为按本次资产轨迹自适应，解决资金
//        在窄区间波动时下半屏空白；v122/v123 脚本本身零改动，V0.1 演示仍走 v122。）
//
// 约束：
//   1. 不改回测算法、不改 V1.2.2 渲染器、不改验收脚本——只做「数据形状转换 + 文案标注」。
//   2. 生成的两份 JSON 必须同源（actions 与 events 逐条一致），否则 backtest 会报
//      E_RECORD_MISMATCH / E_CASH_MISMATCH。
//   3. 视频文案必须走 USER_IMPORT 档：显示文件名、SHA-256 前 12 位、复权口径、是否含分红、
//      日历缺口数；禁止「真实行情 / 实盘 / 实测」等字样。V0.1 的 SIMULATED 链路不受影响。
//   4. 原始 CSV 留档已由 taskManager 写入 source.csv / dividend.csv；本适配器只读 import.json，
//      并在生成回测输入前核对 source.csv 的 SHA-256 未被改动。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT } = require('../paths');
const { parseCsv } = require('../csv');

const ENGINE_DIR = path.join(PROJECT_ROOT, 'engine_next');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

const SEALED_FILES = {
  backtestConfig: path.join(ENGINE_DIR, 'config.stock_macd.json'),
  videoConfig: path.join(ENGINE_DIR, 'config.stock_macd_video_v122.json'),
  backtestScript: path.join(ENGINE_DIR, 'backtest_stock_macd.cjs'),
  renderScript: path.join(ENGINE_DIR, 'render_stock_macd_v124.py'),
  acceptScript: path.join(ENGINE_DIR, 'tests', 'accept_macd_video_v124.py'),
};

const STEPS = [
  '读取导入数据并核对留档',
  '生成回测输入（八段结构）',
  '真实回测（MACD 12/26/9）',
  '视频渲染 V1.2.4（USER_IMPORT 标注 · 主图 Y 轴下限自适应）',
  'V1.2.4 独立验收（数据一致性 / 零遮挡 / 平滑度）',
];

function sha256File(p) {
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

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function countCsvLines(p) {
  const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
  return txt ? txt.split(/\r?\n/).length - 1 : 0;
}

function parseAcceptResult(out) {
  const m = /验收结果：PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/.exec(out || '');
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
}

// 验收脚本对失败项打印两种行：过程中「  FAIL  <检查项>  ← <实际值>」（无实际值时省略箭头段），
// 以及末尾汇总区再重复一遍（名称与实际值之间只有两个空格，无法可靠切分）。
// 因此只取「验收结果：PASS …」汇总行**之前**的过程行，名称与实际值切分可靠，逐条落盘。
function parseAcceptFailures(out) {
  const lines = String(out || '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('验收结果：PASS'));
  const items = [];
  for (const l of (start >= 0 ? lines.slice(0, start) : lines)) {
    const m = /^\s*FAIL\s{2,}(.+?)(?:\s{2,}←\s*(.*))?$/.exec(l);
    if (m) items.push({ name: m[1].trim(), detail: (m[2] || '').trim() });
  }
  return items;
}

// ---- 溯源（DATA_SPEC §1.8）：每根 K 线的 OHLC、每条分红记录 → 源文件物理行号 ----
// 与 A/B 类的 traceability 同一契约：渲染前重新解析留档，按行号回读逐字段比对，
// 任一处对不上就拒绝交付。视频里的金额是回测按这些价格计算出来的，不是 CSV 原始数字，
// 所以这里核对的是「输入」——价格与分红确实来自这一行；金额的推导写在 derivations。
function toNum(s) {
  const t = String(s == null ? '' : s).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > (n || 160) ? t.slice(0, (n || 160) - 1) + '…' : t;
}

function buildStockTrace(model, sourceText, dividendText) {
  const parsed = parseCsv(sourceText);
  if (!parsed.ok) {
    return { ok: false, message: `原始 CSV 留档无法解析（${parsed.code}），无法核对溯源` };
  }
  const header = parsed.records[0];
  if (!header) return { ok: false, message: '原始 CSV 留档没有表头，无法核对溯源' };
  const byLine = new Map();
  for (const rec of parsed.records) byLine.set(rec.line, rec);

  const mapping = model.meta.mapping || {};
  const colOf = (field) => {
    const name = mapping[field];
    if (!name) return -1;
    return header.fields.findIndex((f) => f.text.trim().toLowerCase() === String(name).trim().toLowerCase());
  };
  const cols = { date: colOf('date'), open: colOf('open'), high: colOf('high'), low: colOf('low'), close: colOf('close') };
  for (const f of ['date', 'open', 'high', 'low', 'close']) {
    if (cols[f] < 0) return { ok: false, message: `留档表头里找不到「${f}」列（映射：${mapping[f] || '未提供'}）` };
  }

  const trace = [];
  const problems = [];
  for (const b of model.bars || []) {
    const rec = byLine.get(b.line);
    if (!rec) { problems.push(`K线 ${b.date} 标注第 ${b.line} 行，但留档里没有这一行`); continue; }
    const d = rec.fields[cols.date].text.trim();
    const prices = ['open', 'high', 'low', 'close'].map((k) => toNum(rec.fields[cols[k]].text));
    const same = d === b.date && ['open', 'high', 'low', 'close'].every((k, i) => (
      prices[i] !== null && Math.abs(prices[i] - b[k]) < 1e-9
    ));
    if (!same) {
      problems.push(`第 ${b.line} 行回读不一致（期望 ${b.date} O/H/L/C=${b.open}/${b.high}/${b.low}/${b.close}）`);
      continue;
    }
    trace.push({
      kind: 'bar',
      label: `K线 ${b.date}`,
      date: b.date,
      value: b.close,
      sourceLine: b.line,
      sourceFile: 'source.csv',
      sourceText: clip(rec.fields.map((f) => f.text).join(',')),
    });
  }

  // 分红表：行号属于 dividend.csv（独立文件），因此逐条带 sourceFile，避免与行情行号混淆
  const actions = model.actions || [];
  if (actions.length) {
    if (!dividendText) {
      problems.push('模型含分红事件，但缺少分红表留档，无法核对');
    } else {
      const dp = parseCsv(dividendText);
      if (!dp.ok || !dp.records.length) {
        problems.push(`分红表留档无法解析（${dp.ok ? '无表头' : dp.code}）`);
      } else {
        const dh = dp.records[0].fields.map((f) => f.text.trim().toLowerCase());
        const exCol = dh.indexOf('ex_date');
        const cashCol = dh.indexOf('cash_per_share');
        if (exCol < 0 || cashCol < 0) {
          problems.push('分红表留档缺少 ex_date / cash_per_share 列');
        } else {
          const divByLine = new Map();
          for (const rec of dp.records) divByLine.set(rec.line, rec);
          for (const a of actions) {
            const rec = divByLine.get(a.line);
            if (!rec) { problems.push(`分红 ${a.date} 标注分红表第 ${a.line} 行，但留档里没有这一行`); continue; }
            const ex = rec.fields[exCol].text.trim();
            const cash = toNum(rec.fields[cashCol].text);
            if (ex !== a.date || cash === null || Math.abs(cash - a.cashPerShare) > 1e-9) {
              problems.push(`分红表第 ${a.line} 行回读不一致（期望 ${a.date} / ${a.cashPerShare}）`);
              continue;
            }
            trace.push({
              kind: 'bar',
              label: `分红 ${a.date}`,
              date: a.date,
              value: a.cashPerShare,
              sourceLine: a.line,
              sourceFile: 'dividend.csv',
              sourceText: clip(rec.fields.map((f) => f.text).join(',')),
            });
          }
        }
      }
    }
  }

  const expected = (model.bars || []).length + actions.length;
  if (problems.length || trace.length !== expected) {
    return {
      ok: false,
      message: `溯源核对失败（${problems.length || expected - trace.length} 处）：${problems.slice(0, 3).join('；') || '记录数不符'}`,
    };
  }
  return {
    ok: true,
    data: {
      mapping,
      trace,
      verification: {
        points: expected,
        verified: trace.length,
        ok: true,
        method: '解析任务目录 source.csv / dividend.csv，按行号回读并逐字段比对（K 线日期与 OHLC、分红除息日与每股现金红利）',
      },
      derivations: [
        '视频中的资产金额 = 回测按上述 CSV 价格、分红与费用规则计算，不是 CSV 里的原始数字；本清单核对的是输入价格与分红的源行',
      ],
    },
  };
}

// ---- 归一化模型 → 引擎八段结构（DATA_SPEC §4.4） ----
function buildStockDaily(model, fileName) {
  const m = model.meta;
  return {
    meta: {
      symbol: m.symbol,
      market: m.board === 'SH_MAIN' ? 1 : 0,
      name: m.name,
      fullName: m.name,
      board: m.board,
      listingDate: null,
      parValue: 1,
      adjust: m.adjust,
      sources: {
        daily: `USER_IMPORT · ${fileName}`,
        corporateActions: m.hasDividends ? 'USER_IMPORT · dividend.csv' : 'NONE',
        calendar: `USER_IMPORT · ${fileName}`,
      },
      endpoints: null,
      requestedStart: m.first,
      requestedEnd: m.last,
      first: m.first,
      last: m.last,
      count: m.rowCount,
      calendarCount: m.calendarCount,
      upstreamTotal: m.rowCount,
      preKPrice: null,
      fetchedAt: null,
      simulated: false,
      disclaimer: '用户导入数据，不构成投资建议',
      securityStatus: {
        declared: 'user-declared',
        declaredBasis: '用户提供证券代码与名称；风险警示状态未由行情独立核验',
        evidence: 'USER_IMPORT',
        stPeriods: [],
      },
    },
    // bars 只保留引擎需要的字段；line 是给溯源面板用的，不写进回测输入
    bars: (model.bars || []).map((b) => {
      const o = {
        date: b.date,
        open: b.open,
        close: b.close,
        high: b.high,
        low: b.low,
        volume: b.volume === undefined ? 0 : b.volume,
      };
      if (b.amount !== undefined) o.amount = b.amount;
      return o;
    }),
    calendar: model.calendar || [],
    suspensions: [], // CSV 无法表达停牌（DATA_SPEC §5.3）
    actions: (model.actions || []).map((a) => ({
      date: a.date,
      recordDate: a.recordDate,
      reportDate: null,
      cashPerShare: a.cashPerShare,
      shareRatio: a.shareRatio || 0,
      sendRatio: 0,
      itRatio: 0,
      plan: a.plan || '',
      source: 'USER_IMPORT · dividend.csv',
    })),
    actionsOutOfRange: [],
    exChecks: [],
    checks: {
      imported: true,
      simulated: false,
      rowCount: (model.bars || []).length,
      calendarGaps: m.calendarGaps || [],
      totalGapWorkdays: m.totalGapWorkdays || 0,
    },
  };
}

// 与 stock_daily.actions 同源生成，保证 backtest 的逐条比对（recordDate / cashPerShare）成立
function buildDividendCalendar(model) {
  return {
    meta: {
      symbol: model.meta.symbol,
      simulated: false,
      source: 'USER_IMPORT · dividend.csv',
      disclaimer: '用户导入数据，不构成投资建议',
      eventCount: (model.actions || []).length,
    },
    events: (model.actions || []).map((a) => ({
      date: a.date,
      recordDate: a.recordDate,
      payDate: a.payDate,
      cashPerShare: a.cashPerShare,
      shareRatio: a.shareRatio || 0,
      plan: a.plan || '',
      fiscalYear: null,
      payDateSource: 'USER_IMPORT',
      recordDateSource: 'USER_IMPORT',
    })),
    checks: { simulated: false },
  };
}

// V1.2.3 布局：演示配置把浮板 y1 固定成 182（按 2633 日样例标定）。用户样本的资产
// 轨迹不同，固定值会压住曲线，所以这里解掉 y1，交给渲染器按本次数据选位
// （x1/x2/最近事件窗口沿用，视觉风格不变）。
function applyUserImportLayout(vidCfg) {
  const chart = vidCfg && vidCfg.video && vidCfg.video.chart;
  if (chart && chart.panel && Object.prototype.hasOwnProperty.call(chart.panel, 'y1')) {
    delete chart.panel.y1;
    return true;
  }
  return false;
}

// USER_IMPORT 文案（DATA_SPEC §5.5）。只替换来源相关字段，不动版式与数字 token。
function applyUserImportCopy(vidCfg, model, fileName, sha12) {
  const m = model.meta;
  const adjustLabel = m.adjust === 'none' ? '未复权' : (m.adjust === 'qfq' ? '前复权 qfq' : '后复权 hfq');
  const divDesc = m.hasDividends ? `含现金分红 ${m.dividendCount} 次`
    : '未提供分红表（除权跳空按价格下跌处理，结果不含现金分红）';
  const gapCount = (m.calendarGaps && m.calendarGaps.length) || 0;
  const gapDesc = gapCount > 0 ? `日历缺口 ${gapCount} 处` : '无日历缺口';
  const feeDesc = m.hasDividends ? '含佣金、印花税、过户费与红利税'
    : '含佣金、印花税、过户费（无红利税）';
  const copy = vidCfg.video.copy;
  copy.header_title = '用户导入：MACD 金叉买入、死叉卖出 vs 长期持有';
  copy.header_sub = `USER_IMPORT ${adjustLabel} · ${divDesc} · ${gapDesc} · 100 股整数倍 · ${feeDesc}`;
  if (!m.hasDividends) {
    // 片尾总述同样不能笼统写「已扣除红利税」；有分红时保留封版文案不动。
    copy.outro_top = '同样 10 万元 · {start} → {end} · 已扣除交易费用（未提供分红表，无红利税）';
  }
  copy.footer_left = `数据：用户导入 · ${fileName} · SHA ${sha12} · ${adjustLabel}`
    + ((m.sourceNote || '').trim() ? ` · 来源：${String(m.sourceNote).trim()}` : '');
  copy.intro_disclaimer = `本视频使用用户导入数据（${fileName}），不代表真实行情或实盘交易，不预示未来收益，不构成投资建议`;
  copy.outro_risk = `本视频使用用户导入数据（${fileName}），不代表真实行情，不构成投资建议。`;
  vidCfg.video.encoder = Object.assign({}, vidCfg.video.encoder, {
    title: '用户导入数据 · MACD 金叉死叉 vs 长期持有（USER_IMPORT）',
  });
}

async function execute(ctx) {
  const { taskId, runId, request, taskDir, runCommand, onStep, logWrite } = ctx;

  // ---- 0) 读取归一化模型 + 核对留档 ----
  onStep(0, 'running');
  const importPath = path.join(taskDir, 'import.json');
  if (!fs.existsSync(importPath)) {
    throw { code: 'E_IMPORT_MISSING', message: '任务目录缺少 import.json（归一化数据），请新建任务重试' };
  }
  const model = readJson(importPath);
  if (!model || model.class !== 'stock_ohlc') {
    throw { code: 'E_IMPORT_MISMATCH', message: `import.json 类别（${model && model.class}）不是 stock_ohlc，请新建任务重试` };
  }

  const sourcePath = path.join(taskDir, 'source.csv');
  if (!fs.existsSync(sourcePath)) {
    throw { code: 'E_SOURCE_MISSING', message: '任务目录缺少原始 CSV 留档（source.csv），无法核对来源，已停止。请新建任务重试。' };
  }
  const srcSha = sha256File(sourcePath);
  const expected = model.meta && model.meta.sourceSha256;
  if (expected && srcSha !== expected) {
    throw { code: 'E_TRACE_MISMATCH', message: 'source.csv 的 SHA-256 与创建任务时记录的不一致（留档被改动），已停止交付。' };
  }
  logWrite(`import class=stock_ohlc symbol=${model.meta.symbol} bars=${(model.bars || []).length} dividends=${(model.actions || []).length} srcSha=${srcSha.slice(0, 12)}`);

  // 分红表留档（可选）：仅当模型声明含分红时要求存在
  const divPath = path.join(taskDir, 'dividend.csv');
  if (model.meta.hasDividends && !fs.existsSync(divPath)) {
    throw { code: 'E_SOURCE_MISSING', message: '模型含分红事件，但任务目录缺少 dividend.csv 留档，已停止。' };
  }
  if (fs.existsSync(divPath)) {
    const divSha = sha256File(divPath);
    if (model.meta.dividendSha256 && divSha !== model.meta.dividendSha256) {
      throw { code: 'E_TRACE_MISMATCH', message: 'dividend.csv 的 SHA-256 与创建任务时记录的不一致，已停止交付。' };
    }
    logWrite(`dividend.csv sha256=${divSha.slice(0, 12)}`);
  }

  // 溯源核对（§1.8）：按行号回读 source.csv / dividend.csv，逐字段比对 K 线与分红。
  // 必须放在渲染之前——对不上就不该浪费一次渲染，更不该交付无法回溯的视频。
  const divTextForTrace = fs.existsSync(divPath) ? fs.readFileSync(divPath, 'utf8') : '';
  const tr = buildStockTrace(model, fs.readFileSync(sourcePath, 'utf8'), divTextForTrace);
  if (!tr.ok) {
    throw { code: 'E_TRACE_FAILED', message: `${tr.message}（已停止交付，未生成可下载视频）` };
  }
  logWrite(`trace ok: ${tr.data.verification.verified} 条记录（K线+分红）全部定位到留档行号`);
  onStep(0, 'done');

  // ---- 1) 生成 01_data（八段结构 + 分红日历） ----
  onStep(1, 'running');
  const runDir = path.join(OUTPUT_DIR, runId);
  const dataDir = path.join(runDir, '01_data');
  fs.mkdirSync(dataDir, { recursive: true });
  const fileName = (model.meta.fileName || request.fileName || 'source.csv');
  const stockDaily = buildStockDaily(model, fileName);
  const payCal = buildDividendCalendar(model);
  fs.writeFileSync(path.join(dataDir, 'stock_daily.json'), JSON.stringify(stockDaily, null, 2), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'dividend_calendar.json'), JSON.stringify(payCal, null, 2), 'utf8');
  fs.writeFileSync(path.join(taskDir, 'conversion_manifest.json'), JSON.stringify({
    class: 'stock_ohlc',
    symbol: model.meta.symbol,
    name: model.meta.name,
    adjust: model.meta.adjust,
    first: model.meta.first,
    last: model.meta.last,
    bars: stockDaily.bars.length,
    calendar: stockDaily.calendar.length,
    dividends: stockDaily.actions.length,
    calendarGaps: model.meta.calendarGaps || [],
    sourceSha256: srcSha,
    dividendSha256: model.meta.dividendSha256 || null,
    note: '原始 CSV 按 DATA_SPEC §4.4 转换为引擎八段结构；未改写任何价格或分红数值',
  }, null, 2), 'utf8');
  logWrite(`converted: bars=${stockDaily.bars.length} calendar=${stockDaily.calendar.length} actions=${stockDaily.actions.length}`);
  onStep(1, 'done');

  // ---- 配置副本（仅覆盖 run_id / source_run_id + USER_IMPORT 文案） ----
  const btCfg = readJson(SEALED_FILES.backtestConfig);
  const vidCfg = readJson(SEALED_FILES.videoConfig);
  btCfg.run_id = runId;
  // C 类由用户 CSV 决定代码/名称/复权口径，须同步进回测配置，供 summary 与文案引用
  btCfg.data.symbol = Object.assign({}, btCfg.data.symbol, {
    code: model.meta.symbol,
    name: model.meta.name,
    board: model.meta.board,
  });
  btCfg.data.adjust = model.meta.adjust;
  vidCfg.run_id = runId;
  vidCfg.source_run_id = runId;
  applyUserImportLayout(vidCfg);
  applyUserImportCopy(vidCfg, model, fileName, srcSha.slice(0, 12));
  const btCfgPath = path.join(taskDir, 'config.backtest.json');
  const vidCfgPath = path.join(taskDir, 'config.video.json');
  fs.writeFileSync(btCfgPath, JSON.stringify(btCfg, null, 2), 'utf8');
  fs.writeFileSync(vidCfgPath, JSON.stringify(vidCfg, null, 2), 'utf8');

  const python = resolvePython();
  if (!python) throw { code: 'E_PYTHON_MISSING', message: '未找到可用的 Python（python / python3），无法渲染视频' };

  // ---- 2) 回测 ----
  onStep(2, 'running');
  const btDir = path.join(runDir, '02_backtest_macd');
  const bt = await runCommand(process.execPath, [SEALED_FILES.backtestScript, '--config', btCfgPath, '--run', runId]);
  const summaryPath = path.join(btDir, 'summary.json');
  if (bt.code !== 0 || !fs.existsSync(summaryPath)) {
    throw { code: 'E_BACKTEST_FAILED', message: 'MACD 回测失败或未产出 summary.json（见 engine.log）' };
  }
  logWrite(`backtest ok: ${path.relative(PROJECT_ROOT, summaryPath)}`);
  onStep(2, 'done');

  // ---- 3) 渲染 ----
  onStep(3, 'running');
  const videoDir = path.join(runDir, '04_video');
  const rd = await runCommand(python, [SEALED_FILES.renderScript, '--config', vidCfgPath, '--run', runId]);
  const mp4 = path.join(videoDir, 'video.mp4');
  const reportPath = path.join(videoDir, 'render_report.json');
  if (rd.code !== 0 || !fs.existsSync(mp4) || !fs.existsSync(reportPath)) {
    throw { code: 'E_RENDER_FAILED', message: 'MACD 视频渲染失败或未产出 video.mp4 / render_report.json（见 engine.log）' };
  }
  logWrite(`render ok: ${path.relative(PROJECT_ROOT, mp4)} bytes=${fs.statSync(mp4).size}`);
  onStep(3, 'done');

  // ---- 4) 验收 ----
  onStep(4, 'running');
  const ac = await runCommand(python, [SEALED_FILES.acceptScript, '--run', runId, '--source', runId]);
  const acceptCounts = parseAcceptResult(ac.out);
  const acceptFailures = parseAcceptFailures(ac.out);
  fs.writeFileSync(path.join(taskDir, 'accept_failures.json'), JSON.stringify({
    runId,
    script: path.relative(PROJECT_ROOT, SEALED_FILES.acceptScript),
    exitCode: ac.code,
    pass: acceptCounts ? acceptCounts.pass : null,
    fail: acceptCounts ? acceptCounts.fail : null,
    items: acceptFailures,
      note: 'V1.2.4 主图 Y 轴下限按本次资产轨迹自适应（V1.2.3 固定 0）；'
        + '若仍失败，说明本次数据在 V1.2.4 判据下确有缺陷（如浮板两级位都放不下 → forced-top）。',
  }, null, 2), 'utf8');
  if (ac.code !== 0 || (acceptCounts && acceptCounts.fail > 0)) {
    const brief = acceptFailures.slice(0, 3).map((f) => f.name).join('；');
    throw {
      code: 'E_VERIFY_FAILED',
      message: `V1.2.4 独立验收未通过（PASS ${acceptCounts ? acceptCounts.pass : '?'} / FAIL ${acceptCounts ? acceptCounts.fail : '?'}）`
        + (brief ? `：${brief}${acceptFailures.length > 3 ? ' 等' : ''}` : '')
        + '。明细见任务目录 accept_failures.json 与 engine.log。'
        + '本版不为通过验收修改回测结果，也不删除任何校验项。',
      acceptance: acceptCounts,
      failures: acceptFailures,
    };
  }
  logWrite(`accept ok: ${acceptCounts ? `PASS ${acceptCounts.pass} / FAIL ${acceptCounts.fail}` : 'exit 0'}`);
  onStep(4, 'done');

  // ---- 结果（全部取自本次产物） ----
  const S = readJson(summaryPath);
  const R = readJson(reportPath);
  const signalsPath = path.join(btDir, 'signals.csv');

  // 溯源清单（与 A/B 类同契约）：源文件指纹 + 逐条 {位置, 数值, sourceLine, sourceText} + 视频指纹。
  // request.source 是创建任务时落盘的留档元数据（SHA / 行数 / 字节数），不在此重算，保证三处一致。
  const videoSha = sha256File(mp4);
  const videoBytes = fs.statSync(mp4).size;
  const traceability = Object.assign({
    taskId,
    generatedAt: new Date().toISOString(),
    source: Object.assign({}, request.source || {}, { archivedAs: 'source.csv' }),
    dividend: request.dividend || null,
    video: {
      file: 'video.mp4',
      sha256: videoSha,
      bytes: videoBytes,
      frames: R.frames || null,
      fps: R.fps || null,
      durationSec: R.durationSec || null,
      width: R.width || null,
      height: R.height || null,
    },
  }, tr.data);
  fs.writeFileSync(path.join(taskDir, 'traceability.json'), JSON.stringify(traceability, null, 2), 'utf8');
  logWrite(`video sha256=${videoSha}`);

  const result = {
    initialCapital: S.meta.initialCapital,
    holdFinal: S.hold.final,
    macdFinal: S.macd.final,
    tradingDays: S.meta.tradingDays,
    signals: fs.existsSync(signalsPath) ? countCsvLines(signalsPath) : null,
    trades: S.macd.tradeCount,
    period: { start: S.meta.start, end: S.meta.end },
    source: {
      kind: 'USER_IMPORT',
      fileName,
      sha256: srcSha,
      adjust: model.meta.adjust,
      hasDividends: model.meta.hasDividends,
      dividendCount: model.meta.dividendCount,
      calendarGaps: model.meta.calendarGaps || [],
    },
    video: {
      width: R.width || (R.video && R.video.width) || null,
      height: R.height || (R.video && R.video.height) || null,
      fps: R.fps || null,
      frames: R.frames || null,
      durationSec: R.durationSec || null,
      sha256: videoSha,
      bytes: videoBytes,
    },
    trace: tr.data.verification,
    verification: {
      script: 'engine_next/tests/accept_macd_video_v123.py',
      pass: acceptCounts ? acceptCounts.pass : null,
      fail: acceptCounts ? acceptCounts.fail : null,
    },
    traceability: {
      file: 'traceability.json',
      sourceLines: (request.source && request.source.lines) || null,
      mapping: model.meta.mapping,
      derivations: tr.data.derivations,
    },
  };
  const strategySpecific = {
    stock: S.meta.symbol,
    name: S.meta.name,
    board: S.meta.board,
    adjust: model.meta.adjust,
    macdParams: S.macd.macdParams || { fast: 12, slow: 26, signal: 9 },
    videoVersion: 'V1.2.4',
    panelAnchor: (R.geometry && R.geometry.panel && R.geometry.panel.anchor) || null,
    sourceKind: 'USER_IMPORT',
    archive: {
      fileName, sourceSha256: srcSha,
      dividendSha256: model.meta.dividendSha256 || null,
      bars: stockDaily.bars.length,
      dividends: stockDaily.actions.length,
    },
    configCopies: [
      path.relative(PROJECT_ROOT, btCfgPath),
      path.relative(PROJECT_ROOT, vidCfgPath),
    ],
  };
  fs.writeFileSync(path.join(taskDir, 'run_result.json'), JSON.stringify({ result, strategySpecific }, null, 2), 'utf8');
  return { mp4, result, strategySpecific };
}

module.exports = {
  id: 'stock_ohlc',
  STEPS,
  SEALED_FILES,
  buildStockDaily,
  buildDividendCalendar,
  buildStockTrace,
  applyUserImportCopy,
  applyUserImportLayout,
  execute,
};
