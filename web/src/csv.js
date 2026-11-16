'use strict';
// web/src/csv.js
// 零依赖 CSV 解析（RFC 4180 子集），仅供「用户导入 CSV」通道使用。
//
// 遵守 DATA_SPEC §1.1：
//   - 允许 BOM；LF / CRLF / CR 均可；
//   - 字段可用 " 包裹，"" 表示一个引号，引号内允许逗号与换行；
//   - 引号外的 " 按普通字符处理（不报错），避免误伤纯文本列；
//   - 引号未闭合 → E_QUOTE_UNCLOSED（带起始行号）。
//
// 返回的每个字段都带 `quoted` 标记：DATA_SPEC §1.2 的千分位判定必须先知道
// 「逗号是引号内的字面量」还是「分隔符」，这个标记就是依据。

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB，契约 §1.1

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// 只看第一行（引号外）的候选分隔符计数，用于 E_DELIMITER 判定
function detectDelimiter(text) {
  let inQuotes = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    if (!inQuotes && Object.prototype.hasOwnProperty.call(counts, ch)) counts[ch] += 1;
  }
  let delimiter = ',';
  let best = counts[','];
  for (const cand of [';', '\t']) {
    if (counts[cand] > best) { delimiter = cand; best = counts[cand]; }
  }
  return { delimiter, counts };
}

function parseCsv(rawText) {
  const text = stripBom(String(rawText == null ? '' : rawText));
  const detected = detectDelimiter(text);

  const records = [];
  let fields = [];
  let buf = '';
  let quoted = false;
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let quoteStartLine = 0;

  const endField = () => {
    fields.push({ text: buf, quoted });
    buf = '';
    quoted = false;
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { buf += '"'; i += 1; } else { inQuotes = false; }
      } else {
        if (ch === '\n') line += 1;
        buf += ch;
      }
      continue;
    }

    if (ch === '"' && buf.length === 0 && !quoted) {
      inQuotes = true;
      quoted = true;
      quoteStartLine = line;
      continue;
    }
    if (ch === ',') { endField(); continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
      continue;
    }
    if (ch === '\n') {
      endRecord();
      line += 1;
      recordLine = line;
      continue;
    }
    buf += ch;
  }

  if (inQuotes) {
    return {
      ok: false,
      code: 'E_QUOTE_UNCLOSED',
      line: quoteStartLine,
      message: `第 ${quoteStartLine} 行存在未闭合的引号（"）。请检查该行，或用 Excel 重新另存为 UTF-8 CSV。`,
    };
  }
  if (buf.length > 0 || fields.length > 0 || quoted) endRecord();

  return { ok: true, delimiter: detected.delimiter, counts: detected.counts, records };
}

// 源文件「文本行数」：按物理换行计数，文件末尾的换行符不算多出一行。
// 与 parseCsv 的 record.line 保持同一套行号语义（第 1 行是表头），不参与留档字节改动。
function countTextLines(rawText) {
  const text = stripBom(String(rawText == null ? '' : rawText));
  if (text === '') return 0;
  const normalized = text.replace(/\r\n|\r/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body === '' ? 0 : body.split('\n').length;
}

// 实际数据记录数 = CSV 记录数 - 表头；空行与 validate.js 一样跳过。
function countDataRecords(rawText) {
  const parsed = parseCsv(rawText);
  if (!parsed.ok) return 0;
  const records = parsed.records.filter((r) => {
    const f0 = r.fields[0];
    return !(r.fields.length === 1 && !f0.quoted && f0.text.trim() === '');
  });
  return Math.max(0, records.length - 1);
}

module.exports = { parseCsv, detectDelimiter, stripBom, countTextLines, countDataRecords, MAX_FILE_BYTES };
