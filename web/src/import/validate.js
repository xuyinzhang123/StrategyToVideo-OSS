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
const { CLASS_FIELDS, resolveMapping } = require('./mapping');

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

  // C 类走门禁，不在这里静默跑错（DATA_SPEC §7.1）
  if (dataClass === 'stock_ohlc') {
    return fail(
      'E_CLASS_NOT_IMPLEMENTED',
      '股票日线（stock_ohlc）通道尚未开放：需先通过 DATA_SPEC §7.1 的股票通道门禁'
        + '（G-1 qfq 封板判定、G-2 八段结构转换器等）。当前支持：timeseries（通用时间序列）、cross_section（横向对比）。'
        + '这**不是**你的数据有问题，而是这条通道还不能保证算对。',
    );
  }
  if (!CLASS_FIELDS[dataClass]) {
    return fail('E_CLASS_UNKNOWN', `未知数据类别：${String(dataClass)}（支持：timeseries / cross_section）`);
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
    bySeries.get(seriesName).push({ date: dateRaw, value });
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
      return fail('E_ROW_EMPTY_FIELD', `第 ${rec.line} 行的标签（label）为空。`, { line: rec.line });
    }
    if (seen.has(label)) {
      return fail(
        'E_DUP_LABEL',
        `第 ${rec.line} 行与第 ${seen.get(label)} 行的标签「${label}」重复。本工具不自动合并（合并口径应由你决定），请先处理重复项。`,
        { line: rec.line },
      );
    }
    seen.set(label, rec.line);

    const pn = parseNumber(rec.fields[mp.map.value], `第 ${rec.line} 行的数值`);
    if (pn.code) return fail(pn.code, pn.message, { line: rec.line });
    if (pn.empty) return fail('E_ROW_EMPTY_FIELD', `第 ${rec.line} 行的数值为空。`, { line: rec.line });

    const row = { label, value: pn.value };

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
        `可选列「${f}」部分行为空（第 ${emptyRows.slice(0, 5).join('、')} 行等 ${emptyRows.length} 行）。`
          + '请补齐整列，或删除整列后重传。',
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

module.exports = { validateImport, parseDateStrict, parseNumber };
