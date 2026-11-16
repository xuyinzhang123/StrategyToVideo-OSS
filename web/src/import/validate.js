'use strict';
// web/src/import/validate.js
// 用户 CSV 校验与归一化（DATA_SPEC §1 / §2 / §3）。
//
// 只做两件事：
//   1. 按契约逐条判定（拒绝 / 警告），错误必须带行号与可执行的修复建议；
//   2. 输出 §2.2 / §3.2 的归一化结构，供渲染器消费。
//
// 明确不做的事：
//   - 不推断统计量（收益率、回撤、同比一律不算，只有 B 类的「占比」这一条纯算术事实）；
//   - 不为缺失值插值、不前向填充、不补零；
//   - 不读任何具体列名（列名由 mapping 决定，见 import/mapping.js）。

const { parseCsv, MAX_FILE_BYTES } = require('../csv');
const { CLASS_FIELDS, resolveMapping, labelOf } = require('./mapping');

// 复用引擎侧的支持边界（板块 / 公司行为），不重复实现一套规则。
// 目录：web/src/import → 仓库根 → engine_next/lib/support_guard.cjs
let guard = null;
try {
  // eslint-disable-next-line import/no-dynamic-require
  guard = require(require('node:path').join(__dirname, '..', '..', '..', 'engine_next', 'lib', 'support_guard.cjs'));
} catch (_) {
  guard = null; // 独立测试环境缺少引擎目录时降级为「不做 support_guard 校验」
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 严格千分位：同时满足才算「可识别的千分位」（DATA_SPEC §1.2）
const THOUSANDS_RE = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const MAX_ROWS = 20000;
const MAX_COLS = 20;
const MAX_SERIES = 6;
const MAX_CS_ROWS = 60;
const MAX_LABEL_CHARS = 24;
const MAX_TITLE_CHARS = 80;

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {});
}
function warn(code, message) {
  return { code, message };
}

// 与 web/src/validation.js 的 parseDateStrict 同一语义（拒绝 2026-02-30 这类不存在日期）
function parseDateStrict(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d, iso: s };
}

// 数值解析：千分位单独成码（§1.2）
function parseNumber(field, where) {
  const raw = field.text;
  const t = raw.trim();
  if (t === '') return { empty: true };
  if (THOUSANDS_RE.test(t)) {
    return {
      code: 'E_THOUSANDS_SEPARATOR',
      message: `${where}「${t}」含千分位逗号。请删除逗号后重传——工具不做自动清洗，因为逗号在部分区域是小数点，自动处理会对一半用户是错的。`,
    };
  }
  if (!NUMBER_RE.test(t)) {
    return {
      code: 'E_BAD_NUMBER',
      message: `${where}不是合法数值：「${t}」。允许 100 / -3.5 / +2 / 1.5e3；不接受货币符号、百分号或中文数字（单位请在表单里填）。`,
    };
  }
  const v = Number(t);
  if (!Number.isFinite(v)) {
    return { code: 'E_BAD_NUMBER', message: `${where}数值超出可表示范围：「${t}」` };
  }
  return { ok: true, value: v };
}

function cleanText(v, maxLen) {
  const s = String(v == null ? '' : v).trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function mappingToNames(map, headerFields) {
  const out = {};
  for (const k of Object.keys(map)) out[k] = headerFields[map[k]].text;
  return out;
}

// 主入口：返回 { ok:true, model, warnings } 或 { ok:false, code, message, line? }
function validateImport(input) {
  const req = input || {};
  const dataClass = req.dataClass;

  if (!CLASS_FIELDS[dataClass]) {
    return fail('E_CLASS_UNKNOWN', `未知数据类别：${String(dataClass)}（支持：timeseries / cross_section / stock_ohlc）`);
  }

  // ---- 1. 文本与编码 ----
  const csvText = req.csvText;
  if (typeof csvText !== 'string' || csvText.length === 0) {
    return fail('E_FILE_EMPTY', 'CSV 内容为空。请在页面上选择文件后重试。');
  }
  const bytes = Buffer.byteLength(csvText, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    return fail('E_FILE_TOO_LARGE', `文件 ${(bytes / 1048576).toFixed(2)} MiB 超过上限 2 MiB。请先截取需要的日期区间。`);
  }
  if (csvText.indexOf('\uFFFD') >= 0) {
    return fail(
      'E_ENCODING',
      '检测到无法按 UTF-8 解码的字符（常见于 GBK/GB18030 编码的文件）。请用记事本「另存为 → 编码：UTF-8」，'
        + '或在 Excel「另存为 → CSV UTF-8（逗号分隔）」后重传。',
    );
  }

  // ---- 2. 解析 ----
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return fail(parsed.code, parsed.message, { line: parsed.line });
  if (parsed.delimiter !== ',') {
    const name = parsed.delimiter === '\t' ? '制表符' : parsed.delimiter;
    return fail('E_DELIMITER', `检测到分隔符「${name}」，本工具只接受英文逗号（,）。请另存为「CSV（逗号分隔）」。`);
  }

  const warnings = [];
  const records = parsed.records.filter((r) => {
    const f0 = r.fields[0];
    const blank = r.fields.length === 1 && !f0.quoted && f0.text.trim() === '';
    if (blank) {
      warnings.push(warn('W_BLANK_ROW', `第 ${r.line} 行为空行，已跳过`));
      return false;
    }
    return true;
  });
  if (records.length === 0) {
    return fail('E_HEADER_MISSING', '文件为空或只有空行，未找到表头。');
  }

  // ---- 3. 表头与规模 ----
  const headerFields = records[0].fields;
  const dataRecords = records.slice(1);
  const firstCell = headerFields[0].text.trim();
  if (DATE_RE.test(firstCell)) {
    return fail('E_HEADER_MISSING', `第 1 行看起来是数据（「${firstCell}」）而不是表头。请在首行写明列名。`);
  }
  if (dataRecords.length === 0) {
    return fail('E_ROW_COUNT', '只有表头、没有数据行（至少需要 2 行数据）。');
  }
  if (headerFields.length > MAX_COLS) {
    return fail('E_COLUMN_COUNT', `表头有 ${headerFields.length} 列，超过上限 ${MAX_COLS} 列。请只保留需要的列。`);
  }
  if (dataRecords.length < 2) {
    return fail('E_ROW_COUNT', `只有 ${dataRecords.length} 行数据，至少需要 2 行。`);
  }

  // ---- 4. 每行列数 ----
  for (const rec of dataRecords) {
    if (rec.fields.length !== headerFields.length) {
      return fail(
        'E_ROW_FIELD_COUNT',
        `第 ${rec.line} 行有 ${rec.fields.length} 列，表头是 ${headerFields.length} 列。`
          + '最常见的原因是某个数值里带了未加引号的逗号（如 1,234.5）：请删除千分位逗号，或给该字段加英文引号。',
        { line: rec.line },
      );
    }
  }

  // ---- 5. 字段映射 ----
  const mp = resolveMapping(dataClass, headerFields, req.mapping);
  if (!mp.ok) return mp;
  if (mp.extra.length) {
    warnings.push(warn('W_EXTRA_COLUMN', `已忽略 ${mp.extra.length} 列未参与映射的列：${mp.extra.map((e) => e.text).join('、')}`));
  }

  const title = cleanText(req.title, MAX_TITLE_CHARS) || cleanText(req.fileName, MAX_TITLE_CHARS) || '用户数据';
  const unit = cleanText(req.unit, 16);
  const importedAt = typeof req.importedAt === 'string' && req.importedAt ? req.importedAt : new Date().toISOString();
  const fileName = cleanText(req.fileName, 120);

  const base = {
    title, unit, importedAt, fileName,
    sourceNote: cleanText(req.sourceNote, 120),
    mapping: mappingToNames(mp.map, headerFields),
    warnings,
  };

  // C 类：股票日线。DATA_SPEC §7.1 门禁已通过（G-1 qfq 无二次调整、G-4 amount 无下游依赖），
  // 走 §4 的转换器生成八段结构；用户不接触内部结构。
  // 注意：必须放在文本校验 / 解析 / 映射 / base 装配之后，才能复用同一套 CSV 解析与错误码。
  if (dataClass === 'stock_ohlc') {
    return buildStockOhlc({ dataRecords, headerFields, mp, base, req });
  }

  if (dataClass === 'timeseries') {
    return buildTimeseries({ dataRecords, headerFields, mp, base });
  }
  return buildCrossSection({ dataRecords, headerFields, mp, base, asOf: req.asOf, sortByValue: req.sortByValue });
}

function buildTimeseries(ctx) {
  const { dataRecords, headerFields, mp, base } = ctx;
  let records = dataRecords;

  // ---- 排序：升序通过 / 整体降序反转 / 其他拒绝 ----
  const dateOf = (r) => r.fields[mp.map.date].text.trim();
  let dates = records.map(dateOf);
  let asc = true;
  let desc = true;
  for (let i = 0; i < dates.length - 1; i += 1) {
    if (dates[i] > dates[i + 1]) asc = false;
    if (dates[i] < dates[i + 1]) desc = false;
  }
  if (!asc) {
    if (desc) {
      records = records.slice().reverse();
      dates = dates.slice().reverse();
      base.warnings.push(warn('W_DESC_ORDER', '原始文件为日期降序，已自动反转为升序'));
    } else {
      let i = 0;
      while (i < dates.length - 1 && dates[i] <= dates[i + 1]) i += 1;
      return fail(
        'E_DATE_UNORDERED',
        `第 ${records[i + 1].line} 行日期 ${dates[i + 1]} 早于上一行 ${dates[i]}，且整个文件不是「整体降序」。`
          + '请按日期升序排列后重传（按契约只有整体降序会被自动反转；部分乱序通常意味着数据被拼接过）。',
        { line: records[i + 1].line },
      );
    }
  }

  // ---- 逐行解析 ----
  const order = [];
  const bySeries = new Map();
  const dupSeen = new Map();
  let nullCount = 0;

  for (const rec of records) {
    const dateRaw = dateOf(rec);
    if (!parseDateStrict(dateRaw)) {
      return fail(
        'E_DATE_FORMAT',
        `第 ${rec.line} 行日期「${dateRaw}」格式非法：只接受 YYYY-MM-DD（不接受 2024/01/31、2024-1-5 或 Excel 序列号）。`,
        { line: rec.line },
      );
    }
    let seriesName = base.title;
    if (mp.map.series !== undefined) {
      const sn = rec.fields[mp.map.series].text.trim();
      if (!sn) {
        return fail('E_ROW_EMPTY_FIELD', `第 ${rec.line} 行的序列名为空。`, { line: rec.line });
      }
      seriesName = sn;
    }
    const numField = rec.fields[mp.map.value];
    const pn = parseNumber(numField, `第 ${rec.line} 行的数值`);
    if (pn.code) return fail(pn.code, pn.message, { line: rec.line });
    const value = pn.empty ? null : pn.value;
    if (value === null) nullCount += 1;

    const key = `${seriesName}\u0000${dateRaw}`;
    if (dupSeen.has(key)) {
      return fail(
        'E_DUP_DATE',
        `第 ${rec.line} 行与第 ${dupSeen.get(key)} 行重复：序列「${seriesName}」在 ${dateRaw} 出现了两次。请删除其中一条。`,
        { line: rec.line },
      );
    }
    dupSeen.set(key, rec.line);

    if (!bySeries.has(seriesName)) {
      bySeries.set(seriesName, []);
      order.push(seriesName);
    }
    // line 是源文件里的物理行号（1 起），用于「视频里的数字 → CSV 具体行」的追溯；
    // 渲染器不读它，traceability.json 与页面溯源面板读它。
    bySeries.get(seriesName).push({ date: dateRaw, value, line: rec.line });
  }

  if (order.length > MAX_SERIES) {
    return fail('E_TOO_MANY_SERIES', `共有 ${order.length} 条序列，超过上限 ${MAX_SERIES} 条（同图折线超过 6 条已不可读）。`);
  }
  for (const name of order) {
    const pts = bySeries.get(name);
    if (pts.length < 2) {
      return fail('E_SERIES_TOO_FEW', `序列「${name}」只有 ${pts.length} 个数据点，至少需要 2 个。`);
    }
  }

  // ---- 参差检测 ----
  const datesBySeries = {};
  const allDates = new Set();
  for (const name of order) {
    const set = new Set(bySeries.get(name).map((p) => p.date));
    datesBySeries[name] = set;
    set.forEach((d) => allDates.add(d));
  }
  const missing = {};
  let ragged = false;
  for (const name of order) {
    const miss = [...allDates].filter((d) => !datesBySeries[name].has(d)).sort();
    if (miss.length) {
      ragged = true;
      missing[name] = { count: miss.length, first: miss[0], last: miss[miss.length - 1] };
    }
  }
  if (ragged) {
    base.warnings.push(warn('W_RAGGED_SERIES', '各序列的日期集合不一致，渲染时缺处断线（不补齐、不插值）'));
  }
  if (nullCount) {
    base.warnings.push(warn('W_NULL_VALUE', `存在 ${nullCount} 处空数值，渲染为断点（不插值、不前向填充、不补零）`));
  }

  const model = {
    class: 'timeseries',
    meta: Object.assign({}, base, {
      rowCount: records.length,
      seriesNames: order,
      pointsPerSeries: order.reduce((acc, n) => { acc[n] = bySeries.get(n).length; return acc; }, {}),
      missingDates: missing,
    }),
    series: order.map((name) => ({ name, points: bySeries.get(name) })),
  };
  return { ok: true, model, warnings: base.warnings };
}

function buildCrossSection(ctx) {
  const { dataRecords, headerFields, mp, base, asOf, sortByValue } = ctx;

  if (dataRecords.length > MAX_CS_ROWS) {
    return fail('E_TOO_MANY_ROWS', `共 ${dataRecords.length} 行，超过上限 ${MAX_CS_ROWS} 行（横向条形超过 60 项无法阅读）。`);
  }

  const optionalMapped = ['group', 'value2'].filter((f) => mp.map[f] !== undefined);
  const emptyByOptional = {};
  optionalMapped.forEach((f) => { emptyByOptional[f] = []; });

  const seen = new Map();
  const rows = [];

  for (const rec of dataRecords) {
    const label = rec.fields[mp.map.label].text.trim();
    if (!label) {
      return fail('E_ROW_EMPTY_FIELD', `第 ${rec.line} 行的「名称」为空。`, { line: rec.line });
    }
    if (seen.has(label)) {
      return fail(
        'E_DUP_LABEL',
        `第 ${rec.line} 行与第 ${seen.get(label)} 行重复：名称都是「${label}」。本工具不自动合并（合并口径应由你决定），请先处理重复项。`,
        { line: rec.line },
      );
    }
    seen.set(label, rec.line);

    const pn = parseNumber(rec.fields[mp.map.value], `第 ${rec.line} 行的数值`);
    if (pn.code) return fail(pn.code, pn.message, { line: rec.line });
    if (pn.empty) return fail('E_ROW_EMPTY_FIELD', `第 ${rec.line} 行的数值为空。`, { line: rec.line });

    // line：源文件物理行号，供「画面数字 → CSV 行」追溯
    const row = { label, value: pn.value, line: rec.line };

    if (mp.map.group !== undefined) {
      const g = rec.fields[mp.map.group].text.trim();
      if (!g) emptyByOptional.group.push(rec.line); else row.group = g;
    }
    if (mp.map.value2 !== undefined) {
      const f2 = rec.fields[mp.map.value2];
      const p2 = parseNumber(f2, `第 ${rec.line} 行的对照值`);
      if (p2.code) return fail(p2.code, p2.message, { line: rec.line });
      if (p2.empty) emptyByOptional.value2.push(rec.line); else row.value2 = p2.value;
    }
    rows.push(row);
  }

  // 可选列必须整列有值或整列全空（§1.5）
  for (const f of optionalMapped) {
    const emptyRows = emptyByOptional[f];
    if (emptyRows.length > 0 && emptyRows.length < rows.length) {
      return fail(
        'E_PARTIAL_COLUMN',
        `「${labelOf(f)}」这一列有的行有值、有的行是空的（第 ${emptyRows.slice(0, 5).join('、')} 行等 ${emptyRows.length} 行）。`
          + '请补齐整列，或删掉这一列后重传。',
      );
    }
  }

  if (rows.some((r) => r.label.length > MAX_LABEL_CHARS)) {
    base.warnings.push(warn('W_LABEL_TOO_LONG', `存在超过 ${MAX_LABEL_CHARS} 字符的标签，画面会截断显示`));
  }

  const doSort = sortByValue !== false; // 默认按 value 降序（§3.3）
  if (doSort) rows.sort((a, b) => b.value - a.value);

  // 占比：仅在「全部非负且合计 > 0」时计算（纯算术，不含推断）
  const sum = rows.reduce((s, r) => s + r.value, 0);
  const canShare = rows.every((r) => r.value >= 0) && sum > 0;
  if (canShare) {
    rows.forEach((r) => { r.share = (r.value / sum) * 100; });
  }

  const model = {
    class: 'cross_section',
    meta: Object.assign({}, base, {
      rowCount: rows.length,
      asOf: cleanText(asOf, 10) || '',
      sortedByValue: doSort,
      shareBasis: canShare ? 'all-nonnegative' : 'skipped',
      hasValue2: mp.map.value2 !== undefined,
      hasGroup: mp.map.group !== undefined,
    }),
    rows,
  };
  return { ok: true, model, warnings: base.warnings };
}

/* ==========================================================================
 * C 类：股票日线 stock_ohlc（DATA_SPEC §4）
 *   行情 CSV（date/open/high/low/close[+volume][+amount]）
 *     → bars / calendar（升序去重）；suspensions 恒为空（CSV 无法表达停牌）
 *   可选分红 CSV（ex_date/record_date/pay_date/cash_per_share[+share_ratio][+plan]）
 *     → actions + dividendEvents（同源，供 backtest 逐条比对）
 * 输出归一化模型，由适配器写成 01_data/stock_daily.json 与 dividend_calendar.json。
 * ========================================================================*/

const MIN_TRADING_DAYS = 34;            // stock_macd_core readyFrom=33，要求 tradable > 33
const COST_RULES_START = '2015-08-01';  // 过户费最早生效日；更早无费率规则
const DIV_REQUIRED = ['ex_date', 'record_date', 'pay_date', 'cash_per_share'];

function boardOf(code) {
  if (/^(600|601|603|605)/.test(code)) return 'SH_MAIN';
  if (/^(000|001|002|003)/.test(code)) return 'SZ_MAIN';
  return null;
}

// 两个交易日之间缺失的周一至周五数（不含两端）
function missingWorkdays(prev, next) {
  const p = Date.parse(prev + 'T00:00:00Z');
  const n = Date.parse(next + 'T00:00:00Z');
  let count = 0;
  for (let t = p + 86400000; t < n; t += 86400000) {
    const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5) count += 1;
  }
  return count;
}

function numOr(field, where, dflt) {
  const r = parseNumber(field, where);
  if (r.code) return { err: r };
  if (r.empty) return { val: dflt };
  return { val: r.value };
}

// 分红 CSV：列名固定（§4.3），大小写不敏感；计划列用于拒绝不支持的方案
function parseDividendFile(csvText, calendarSet) {
  if (!csvText || !String(csvText).trim()) return { ok: true, actions: [] };
  const bytes = Buffer.byteLength(csvText, 'utf8');
  if (bytes > MAX_FILE_BYTES) return { ok: false, code: 'E_FILE_TOO_LARGE', message: '分红文件超过 2 MiB。' };
  if (csvText.indexOf('\uFFFD') >= 0) {
    return { ok: false, code: 'E_ENCODING', message: '分红文件不是 UTF-8 编码，请另存为 UTF-8 后重传。' };
  }
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message, line: parsed.line };
  if (parsed.delimiter !== ',') return { ok: false, code: 'E_DELIMITER', message: '分红文件必须使用英文逗号分隔。' };

  const records = parsed.records.filter((r) => {
    const f0 = r.fields[0];
    return !(r.fields.length === 1 && !f0.quoted && f0.text.trim() === '');
  });
  if (records.length === 0) return { ok: true, actions: [] };

  const header = records[0].fields.map((f) => f.text.trim().toLowerCase());
  const idx = {};
  for (const k of ['ex_date', 'record_date', 'pay_date', 'cash_per_share', 'share_ratio', 'plan']) {
    idx[k] = header.indexOf(k);
  }
  const missing = DIV_REQUIRED.filter((k) => idx[k] < 0);
  if (missing.length) {
    return {
      ok: false, code: 'E_MISSING_COLUMN',
      message: `分红文件缺少列：${missing.join('、')}（必需：${DIV_REQUIRED.join('、')}；可选：share_ratio、plan）。`,
    };
  }

  const actions = [];
  const seenEx = new Map();
  for (const rec of records.slice(1)) {
    if (rec.fields.length !== header.length) {
      return { ok: false, code: 'E_ROW_FIELD_COUNT', message: `分红文件第 ${rec.line} 行有 ${rec.fields.length} 列，表头是 ${header.length} 列。`, line: rec.line };
    }
    const get = (k) => (idx[k] >= 0 ? rec.fields[idx[k]].text.trim() : '');
    const ex = get('ex_date');
    const rd = get('record_date');
    const pd = get('pay_date');
    for (const [v, label] of [[ex, 'ex_date（除权除息日）'], [rd, 'record_date（股权登记日）'], [pd, 'pay_date（派息日）']]) {
      if (!v) return { ok: false, code: 'E_DIV_MISSING_DATE', message: `分红文件第 ${rec.line} 行缺少 ${label}。登记日与派息日不可推导，必须提供。`, line: rec.line };
      if (!parseDateStrict(v)) return { ok: false, code: 'E_DATE_FORMAT', message: `分红文件第 ${rec.line} 行 ${label} 格式非法：${v}（只接受 YYYY-MM-DD）。`, line: rec.line };
    }
    if (pd < rd) return { ok: false, code: 'E_DIV_PAY_BEFORE_RECORD', message: `分红 ${ex}：派息日 ${pd} 早于登记日 ${rd}。`, line: rec.line };
    for (const [d, label] of [[rd, '登记日'], [ex, '除息日'], [pd, '派息日']]) {
      if (!calendarSet.has(d)) return { ok: false, code: 'E_DIV_DATE_NOT_TRADING', message: `分红 ${ex} 的${label} ${d} 不在行情 CSV 的交易日历内，无法入账。`, line: rec.line };
    }
    if (seenEx.has(ex)) return { ok: false, code: 'E_DUP_DATE', message: `分红文件 ${ex} 出现两次（第 ${seenEx.get(ex)} 行与第 ${rec.line} 行）。`, line: rec.line };
    seenEx.set(ex, rec.line);

    const cp = numOr(rec.fields[idx.cash_per_share], `分红文件第 ${rec.line} 行每股现金红利`, 0);
    if (cp.err) return { ok: false, code: cp.err.code, message: cp.err.message, line: rec.line };
    const sr = idx.share_ratio >= 0
      ? numOr(rec.fields[idx.share_ratio], `分红文件第 ${rec.line} 行送转比例`, 0)
      : { val: 0 };
    if (sr.err) return { ok: false, code: sr.err.code, message: sr.err.message, line: rec.line };
    if (cp.val < 0 || sr.val < 0) return { ok: false, code: 'E_BAD_NUMBER', message: `分红文件第 ${rec.line} 行现金红利/送转比例不能为负。`, line: rec.line };
    if (cp.val === 0 && sr.val === 0) return { ok: false, code: 'E_DIV_EMPTY_EVENT', message: `分红 ${ex} 现金红利与送转比例同时为 0，无实际事件。`, line: rec.line };

    const plan = get('plan');
    if (guard) {
      try {
        guard.assertSupportedActions([{ date: ex, cashPerShare: cp.val, shareRatio: sr.val, plan }], '分红文件');
      } catch (e) {
        return { ok: false, code: e.code || 'E_UNSUPPORTED_ACTION', message: e.message, line: rec.line };
      }
    }
    actions.push({
      date: ex, recordDate: rd, payDate: pd,
      cashPerShare: cp.val, shareRatio: sr.val, plan, line: rec.line,
    });
  }
  return { ok: true, actions };
}

function buildStockOhlc(ctx) {
  const { dataRecords, mp, base, req } = ctx;
  const symbol = String((req && req.symbol) || '').trim();
  const name = cleanText((req && req.name) || '', 40) || symbol;
  const adjust = (req && req.adjust) || 'none';
  const dividendCsvText = (req && req.dividendCsvText) || '';

  if (!/^\d{6}$/.test(symbol)) {
    return fail('E_SYMBOL_REQUIRED', '股票日线必须填写 6 位证券代码：内核按 10% 计算涨跌停并判定一字板，不知道代码就无法保证结果可信。');
  }
  if (!['none', 'qfq', 'hfq'].includes(adjust)) {
    return fail('E_ADJUST_INVALID', `复权口径非法：${String(adjust)}（只能是 none / qfq / hfq）。`);
  }

  // ---- 排序：升序通过 / 整体降序反转 / 其他拒绝 ----
  const dateOf = (r) => r.fields[mp.map.date].text.trim();
  let records = dataRecords;
  let dates = records.map(dateOf);
  let asc = true;
  let desc = true;
  for (let i = 0; i < dates.length - 1; i += 1) {
    if (dates[i] > dates[i + 1]) asc = false;
    if (dates[i] < dates[i + 1]) desc = false;
  }
  if (!asc) {
    if (desc) {
      records = records.slice().reverse();
      dates = dates.slice().reverse();
      base.warnings.push(warn('W_DESC_ORDER', '原始文件为日期降序，已自动反转为升序'));
    } else {
      let i = 0;
      while (i < dates.length - 1 && dates[i] <= dates[i + 1]) i += 1;
      return fail('E_DATE_UNORDERED', `第 ${records[i + 1].line} 行日期 ${dates[i + 1]} 早于上一行 ${dates[i]}，且整体不是降序。请按日期升序排列后重传。`, { line: records[i + 1].line });
    }
  }

  // ---- 逐行解析行情 ----
  const hasVol = mp.map.volume !== undefined;
  const hasAmt = mp.map.amount !== undefined;
  const bars = [];
  const seenDates = new Map();
  let volEmpty = 0;
  let amtEmpty = 0;

  for (const rec of records) {
    const d = dateOf(rec);
    if (!parseDateStrict(d)) return fail('E_DATE_FORMAT', `第 ${rec.line} 行日期「${d}」格式非法：只接受 YYYY-MM-DD。`, { line: rec.line });
    if (seenDates.has(d)) return fail('E_DUP_DATE', `第 ${rec.line} 行与第 ${seenDates.get(d)} 行重复：日期 ${d} 出现了两次。`, { line: rec.line });
    seenDates.set(d, rec.line);

    const v = {};
    for (const f of ['open', 'high', 'low', 'close']) {
      const r = parseNumber(rec.fields[mp.map[f]], `第 ${rec.line} 行${labelOf(f)}`);
      if (r.code) return fail(r.code, r.message, { line: rec.line });
      if (r.empty) return fail('E_ROW_EMPTY_FIELD', `第 ${rec.line} 行${labelOf(f)}为空。`, { line: rec.line });
      if (r.value <= 0) return fail('E_PRICE_NONPOSITIVE', `第 ${rec.line} 行${labelOf(f)}=${r.value}，价格必须 > 0（复权价可能为负，请检查口径）。`, { line: rec.line });
      v[f] = r.value;
    }
    if (v.high < Math.max(v.open, v.close, v.low) - 1e-9 || v.low > Math.min(v.open, v.close, v.high) + 1e-9) {
      return fail('E_OHLC_INCONSISTENT', `第 ${rec.line} 行价格矛盾：高=${v.high} 应 ≥ max(开,收,低)，低=${v.low} 应 ≤ min(开,收,高)。`, { line: rec.line });
    }

    const bar = { date: d, open: v.open, high: v.high, low: v.low, close: v.close, line: rec.line };
    if (hasVol) {
      const t = rec.fields[mp.map.volume].text.trim();
      if (t === '') { volEmpty += 1; } else {
        const r = parseNumber(rec.fields[mp.map.volume], `第 ${rec.line} 行成交量`);
        if (r.code) return fail(r.code, r.message, { line: rec.line });
        if (r.value < 0) return fail('E_BAD_NUMBER', `第 ${rec.line} 行成交量为负。`, { line: rec.line });
        bar.volume = r.value;
      }
    }
    if (hasAmt) {
      const t = rec.fields[mp.map.amount].text.trim();
      if (t === '') { amtEmpty += 1; } else {
        const r = parseNumber(rec.fields[mp.map.amount], `第 ${rec.line} 行成交额`);
        if (r.code) return fail(r.code, r.message, { line: rec.line });
        if (r.value < 0) return fail('E_BAD_NUMBER', `第 ${rec.line} 行成交额为负。`, { line: rec.line });
        bar.amount = r.value;
      }
    }
    bars.push(bar);
  }

  // 可选列必须整列有值或整列全空（§1.5）
  if (hasVol && volEmpty > 0 && volEmpty < bars.length) {
    return fail('E_PARTIAL_COLUMN', `「成交量」列有的行有值、有的为空（${volEmpty}/${bars.length} 行为空）。请补齐整列或删掉该列。`);
  }
  if (hasAmt && amtEmpty > 0 && amtEmpty < bars.length) {
    return fail('E_PARTIAL_COLUMN', `「成交额」列有的行有值、有的为空（${amtEmpty}/${bars.length} 行为空）。请补齐整列或删掉该列。`);
  }
  if (hasVol && volEmpty === bars.length) bars.forEach((b) => { b.volume = 0; });

  // ---- 规模与起点 ----
  if (bars.length < MIN_TRADING_DAYS) {
    return fail('E_NO_DATA', `只有 ${bars.length} 个交易日，MACD 至少需要 ${MIN_TRADING_DAYS} 个（指标预热 33 天）。请补足数据。`);
  }
  if (bars[0].date < COST_RULES_START) {
    return fail('E_DATE_BEFORE_COST_RULES', `数据起点 ${bars[0].date} 早于 ${COST_RULES_START}，该时段缺少费率规则，本版无法计算。请截取 ${COST_RULES_START} 之后的数据。`);
  }

  // ---- 板块 / 风险警示（复用 support_guard） ----
  const board = boardOf(symbol);
  if (!board) {
    return fail('E_UNSUPPORTED_BOARD', `代码 ${symbol} 不在沪深主板代码段内（支持 600/601/603/605 与 000/001/002/003）。创业板/科创板/北交所/B 股暂不支持。`);
  }
  if (guard) {
    try {
      guard.assertSupportedSymbol({ code: symbol, name, board }, '股票 CSV');
    } catch (e) {
      return fail('E_UNSUPPORTED_BOARD', e.message);
    }
  }

  // ---- 交易日历缺口（只警告不拒绝：CSV 无法区分停牌/休市/漏行） ----
  const calendar = bars.map((b) => b.date);
  const calendarSet = new Set(calendar);
  const gaps = [];
  let totalGap = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const m = missingWorkdays(bars[i - 1].date, bars[i].date);
    if (m > 0) {
      gaps.push({ from: bars[i - 1].date, to: bars[i].date, missingWorkdays: m });
      totalGap += m;
    }
  }
  if (gaps.length) {
    const maxGap = Math.max(...gaps.map((g) => g.missingWorkdays));
    const base_msg = `区间含 ${gaps.length} 处缺失工作日（共 ${totalGap} 天，最长 ${maxGap} 天），按连续交易日处理；CSV 无法区分停牌、休市与漏行。`;
    base.warnings.push(warn(maxGap > 10 ? 'W_CALENDAR_GAP_LARGE' : 'W_CALENDAR_GAP', maxGap > 10 ? base_msg + ' 请核对是否漏行。' : base_msg));
  }

  // ---- 分红 ----
  let actions = [];
  if (dividendCsvText) {
    if (adjust !== 'none') {
      return fail('E_DIV_CONFLICT', `价格已声明为 ${adjust}（复权），再提供分红表会重复计算。请二选一：传未复权价格 + 分红表，或传复权价格且不传分红表。`);
    }
    const dv = parseDividendFile(dividendCsvText, calendarSet);
    if (!dv.ok) return fail(dv.code, dv.message, { line: dv.line });
    actions = dv.actions;
  } else if (adjust === 'none') {
    base.warnings.push(warn('W_NO_DIVIDENDS', '未提供分红表：除权跳空按普通价格下跌处理，结果不含现金分红。'));
  }

  // ---- 归一化模型（供适配器写 stock_daily.json / dividend_calendar.json） ----
  const meta = Object.assign({}, base, {
    title: name,
    symbol, name, board, adjust, parValue: 1,
    simulated: false,
    sourceKind: 'USER_IMPORT',
    disclaimer: '用户导入数据，不构成投资建议',
    rowCount: bars.length,
    first: bars[0].date,
    last: bars[bars.length - 1].date,
    calendarCount: calendar.length,
    hasDividends: actions.length > 0,
    dividendCount: actions.length,
    calendarGaps: gaps,
    totalGapWorkdays: totalGap,
  });

  return {
    ok: true,
    model: {
      class: 'stock_ohlc',
      meta,
      bars,
      calendar,
      actions,
      dividendEvents: actions,
    },
    warnings: base.warnings,
  };
}

module.exports = { validateImport, parseDateStrict, parseNumber };
