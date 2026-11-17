'use strict';
// web/src/strategyCard.js
// 策略卡（自动取数）通道的共享规格：模板白名单、请求 → 策略卡装配、预热根数。
//
// 设计约束：
//   1. 纯函数：不读写文件、不联网、不调引擎，便于校验层与适配器共用同一口径。
//   2. 客户端只能选模板与少量参数；代码/区间/模板以外的字段一律白名单校验，
//      不把浏览器传来的任意 JSON 直接当策略卡用（避免 additionalProperties 漏网）。
//   3. 策略卡最终形态必须满足 docs/schemas/strategy.schema.json，
//      并在引擎 validateCard 里再过一遍；这里是「更严格的前置白名单」。
//   4. 复权口径固定 none（DATA_SPEC §7.2 / G-6），不接受客户端指定。
//   5. 分母为零的语义不在这里定义：收益/回撤一律由引擎计算，本文件不重算。

const SCHEMA_VERSION = '1.0';
const MAX_WARMUP = 120;
const DEFAULT_WARMUP = 60;
const MIN_CAPITAL = 10000;
const MAX_CAPITAL = 100000000;
const MIN_START = '2015-08-01';
const MAX_DIVIDEND_BYTES = 2 * 1024 * 1024;

// 沪深主板：600/601/603/605（沪）、000/001/002/003（深）。
// 创业板 300/301、科创板 688、北交所 4xx/8xx、B 股 900/200 一律拒绝。
const MAIN_BOARD_PREFIXES = ['600', '601', '603', '605', '000', '001', '002', '003'];

const TEMPLATES = {
  close_buy_open_sell: {
    id: 'close_buy_open_sell',
    name: '尾盘买入 · 次日开盘卖出',
    desc: 'MACD 金叉当日收盘买入，次日开盘卖出；可选 9:25 集合竞价跳空过滤（开盘涨幅达到阈值则继续持有）',
    warmup: 60,
    defaultParams: { entrySignal: 'macd_golden', auctionFilter: null },
  },
  macd_cross: {
    id: 'macd_cross',
    name: 'MACD 金叉买入 · 死叉卖出',
    desc: 'MACD(12,26,9) 金叉次日开盘买入、死叉次日开盘卖出，并与长期持有对照',
    warmup: 60,
    defaultParams: { fast: 12, slow: 26, signal: 9 },
  },
};

const TEMPLATE_IDS = Object.keys(TEMPLATES);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// 严格日历校验：拒绝 2026-02-30 这类不存在的日期
function parseDateStrict(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

function todayIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fail(code, message) {
  return { ok: false, code, message };
}

// 模板参数白名单。params 里出现未登记键直接拒绝，避免「前端传了、引擎静默忽略」。
function normalizeParams(templateId, raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) return fail('E_PARAMS', 'params 必须是对象');

  if (templateId === 'macd_cross') {
    const allowed = new Set(['fast', 'slow', 'signal']);
    for (const k of Object.keys(raw)) {
      if (!allowed.has(k)) return fail('E_PARAMS', `macd_cross 不支持参数：${k}`);
    }
    const fast = raw.fast === undefined ? 12 : raw.fast;
    const slow = raw.slow === undefined ? 26 : raw.slow;
    const signal = raw.signal === undefined ? 9 : raw.signal;
    if (fast !== 12 || slow !== 26 || signal !== 9) {
      return fail('E_PARAMS', 'MACD 参数本轮锁定为 12 / 26 / 9（与封版回测一致），暂不支持修改');
    }
    return { ok: true, value: { fast: 12, slow: 26, signal: 9 } };
  }

  // close_buy_open_sell
  const allowed = new Set(['entrySignal', 'holdIfGte']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return fail('E_PARAMS', `尾盘买入策略不支持参数：${k}`);
  }
  const entrySignal = raw.entrySignal === undefined ? 'macd_golden' : raw.entrySignal;
  if (!['macd_golden', 'always'].includes(entrySignal)) {
    return fail('E_PARAMS', 'entrySignal 只能是 macd_golden（金叉入场）或 always（每个交易日入场）');
  }
  const params = { entrySignal, entryFill: 'sameClose', exitFill: 'nextOpen' };
  if (raw.holdIfGte !== undefined && raw.holdIfGte !== null && raw.holdIfGte !== '') {
    const v = raw.holdIfGte;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return fail('E_PARAMS', '持仓阈值 holdIfGte 必须是数字（小数形式，例如 0.02 表示 2%）');
    }
    if (v < 0 || v > 0.2) {
      return fail('E_PARAMS', '持仓阈值 holdIfGte 需在 0 ~ 0.20（即 0% ~ 20%）之间');
    }
    params.auctionFilter = { basis: 'open_gap_pct', holdIfGte: v, else: 'sellAtOpen' };
  }
  return { ok: true, value: params };
}

// 请求体 → 策略卡。只接受这一组字段，其余由调用方白名单拦截。
function buildCard(body) {
  if (!isPlainObject(body)) return fail('E_REQUEST_INVALID', '请求体必须是 JSON 对象');

  const templateId = body.templateId;
  if (typeof templateId !== 'string' || !TEMPLATES[templateId]) {
    return fail('E_TEMPLATE_UNSUPPORTED', `暂不支持的策略模板：${String(templateId)}（可选：${TEMPLATE_IDS.join(' / ')}）`);
  }
  const tpl = TEMPLATES[templateId];

  const symbol = String(body.symbol || '').trim();
  if (!/^\d{6}$/.test(symbol)) return fail('E_SYMBOL', '证券代码必须是 6 位数字');
  if (!MAIN_BOARD_PREFIXES.some((p) => symbol.startsWith(p))) {
    return fail('E_UNSUPPORTED_BOARD', '本版只支持沪深主板（600/601/603/605、000/001/002/003）；创业板 300/301、科创板 688、北交所与 B 股不支持');
  }

  const nameOfSecurity = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';

  const start = parseDateStrict(body.startDate);
  if (!start) return fail('E_DATE_FORMAT', `开始日期格式非法：${String(body.startDate)}（应为 YYYY-MM-DD）`);
  const end = parseDateStrict(body.endDate);
  if (!end) return fail('E_DATE_FORMAT', `结束日期格式非法：${String(body.endDate)}（应为 YYYY-MM-DD）`);
  if (start >= end) return fail('E_DATE_ORDER', '开始日期必须早于结束日期');
  if (start < MIN_START) {
    return fail('E_DATE_OUT_OF_RANGE', `开始日期不能早于 ${MIN_START}（更早的交易费用规则未验证）`);
  }
  const today = todayIso();
  if (end > today) {
    return fail('E_DATE_OUT_OF_RANGE', `结束日期不能晚于今天（${today}）；今天未收盘的 K 线不会参与回测`);
  }

  const cap = body.initialCapital === undefined ? 100000 : body.initialCapital;
  if (typeof cap !== 'number' || !Number.isFinite(cap)) {
    return fail('E_PRINCIPAL_INVALID', '初始资金必须是数字');
  }
  if (cap < MIN_CAPITAL || cap > MAX_CAPITAL) {
    return fail('E_PRINCIPAL_INVALID', `初始资金需在 ${MIN_CAPITAL} ~ ${MAX_CAPITAL} 元之间`);
  }

  const pv = normalizeParams(templateId, body.params);
  if (!pv.ok) return pv;

  const hasDividends = typeof body.dividendCsvText === 'string' && body.dividendCsvText.trim() !== '';
  if (hasDividends && Buffer.byteLength(body.dividendCsvText, 'utf8') > MAX_DIVIDEND_BYTES) {
    return fail('E_DIVIDEND_TOO_LARGE', '分红表超过 2 MiB 上限');
  }

  const card = {
    schemaVersion: SCHEMA_VERSION,
    id: templateId,
    name: tpl.name,
    symbol,
    nameOfSecurity: nameOfSecurity || symbol,
    range: {
      start,
      end,
      warmupBars: tpl.warmup,
      warmupMode: 'prepend',
    },
    data: {
      adjust: 'none',
      dividendPolicy: hasDividends ? 'provided' : 'ignored',
      source: 'eastmoney-push2his',
    },
    params: pv.value,
    execution: {
      initialCapital: cap,
      lotSize: 100,
      sealedLimitBlocks: true,
    },
    benchmark: 'hold',
  };

  return {
    ok: true,
    value: {
      card,
      templateId,
      templateName: tpl.name,
      templateDesc: tpl.desc,
      dividendSourceText: hasDividends ? body.dividendCsvText : '',
    },
  };
}

// 预热根数：MACD 类信号需要 slow+signal 的窗口；与 tools/run_strategy_video.cjs 同口径。
function requiredWarmup(card) {
  const explicit = Number((card && card.range && card.range.warmupBars) || 0);
  let need = 1;
  if (card.id === 'macd_cross') need = 34;
  if (card.id === 'close_buy_open_sell') {
    need = (card.params && card.params.entrySignal === 'macd_golden') ? 35 : 1;
  }
  return Math.max(need, Math.min(explicit || DEFAULT_WARMUP, MAX_WARMUP));
}

module.exports = {
  SCHEMA_VERSION,
  MIN_CAPITAL,
  MAX_CAPITAL,
  MIN_START,
  MAIN_BOARD_PREFIXES,
  TEMPLATES,
  TEMPLATE_IDS,
  buildCard,
  normalizeParams,
  requiredWarmup,
  parseDateStrict,
  todayIso,
};
