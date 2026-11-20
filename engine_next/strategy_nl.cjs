/* ============================================================================
 * V0.4 阶段 A：自然语言 → 策略卡参数（确定性翻译层）
 * ---------------------------------------------------------------------------
 * 本模块只做一件事：把一句中文策略翻译成既有白名单内的 params。
 * 它不取数、不回测、不渲染、不写文件，也不决定证券代码/日期/本金。
 *
 * 三道门禁（顺序不可交换）：
 *   ① 受控词表匹配 —— 只认白名单词，不认识的直接报错
 *   ② normalizeParams —— 既有前置白名单（web/src/strategyCard.js，原样调用）
 *   ③ buildConditions —— 既有引擎参数校验（空行情数组只跑参数段，原样调用）
 * ②③ 不复刻，保证「翻译层能过的，引擎一定也能过」，不会出现两套口径。
 *
 * 两条不可让渡的规则：
 *   - 参数可以填默认值，但必须列进 defaults 让用户确认；
 *   - 条件不可以补全（没说出场就不许默认一个出场，没提止损就不许补止损）。
 * ==========================================================================*/
'use strict';

const { normalizeParams, MAIN_BOARD_PREFIXES } = require('../web/src/strategyCard.js');
const { buildConditions } = require('./strategy_conditions.cjs');

const DRAFT_SCHEMA = 'stv.nl-draft/0.1';

// 参数默认值：宁可显式列出让用户确认，也不隐式生效
const DEFAULTS = {
  fast: 5,
  slow: 20,
  lookback: 20,
  holdDays: 5,
  takeProfit: 0.10,
  stopLoss: 0.05,
  trailing: 0.08,
};

// 非白名单指标/玩法：命中即拒绝，绝不做「最接近的猜测」
const UNSUPPORTED_TERMS = [
  { term: 'KDJ', label: 'KDJ 指标' },
  { term: 'RSI', label: 'RSI 指标' },
  { term: 'BOLL', label: '布林带' },
  { term: '布林', label: '布林带' },
  { term: 'BIAS', label: '乖离率' },
  { term: '乖离', label: '乖离率' },
  { term: 'MACD柱', label: 'MACD 柱状线' },
  { term: '红柱', label: 'MACD 柱状线' },
  { term: '绿柱', label: 'MACD 柱状线' },
  { term: '量比', label: '量比' },
  { term: '换手', label: '换手率' },
  { term: '成交量', label: '成交量条件' },
  { term: '放量', label: '放量条件' },
  { term: '缩量', label: '缩量条件' },
  { term: '涨停', label: '涨停板' },
  { term: '跌停', label: '跌停板' },
  { term: '打板', label: '打板' },
  { term: '龙头', label: '龙头股' },
  { term: '板块', label: '板块轮动' },
  { term: '大盘', label: '大盘择时' },
  { term: '指数', label: '指数择时' },
  { term: '融资', label: '融资融券' },
  { term: '融券', label: '融资融券' },
  { term: '做T', label: '日内做 T' },
  { term: '加仓', label: '加减仓' },
  { term: '补仓', label: '加减仓' },
  { term: '减仓', label: '加减仓' },
  { term: '网格', label: '网格交易' },
  { term: '海龟', label: '海龟交易法' },
  { term: '唐奇安', label: '唐奇安通道' },
  { term: '背离', label: '指标背离' },
  { term: '缠论', label: '缠论' },
  { term: '波浪', label: '波浪理论' },
  { term: '斐波那契', label: '斐波那契' },
];

/* ------------------------------ 归一化 ------------------------------ */

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(s) {
  if (s === '十') return 10;
  if (!s.includes('十')) {
    let v = 0;
    for (const ch of s) {
      if (CN_DIGITS[ch] === undefined) return NaN;
      v = v * 10 + CN_DIGITS[ch];
    }
    return v;
  }
  const [a, b] = s.split('十');
  const tens = a === '' ? 1 : CN_DIGITS[a];
  const ones = b === '' ? 0 : CN_DIGITS[b];
  if (tens === undefined || ones === undefined) return NaN;
  return tens * 10 + ones;
}

// 全角转半角 + 中文数字转阿拉伯数字（只处理紧邻「日/天/交易日/%」的情形，避免误伤普通用词）
function normalizeText(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\u3000/g, ' ');
  s = s.replace(/百分之([零一二三四五六七八九十两]+)/g, (_, n) => String(cnNumber(n)) + '%');
  s = s.replace(/[零一二三四五六七八九十两]{1,4}(?=\s*(?:个)?\s*(?:交易日|天|日|%))/g, (m) => {
    const v = cnNumber(m);
    return Number.isFinite(v) ? String(v) : m;
  });
  return s;
}

/* ------------------------------ 小工具 ------------------------------ */

function issue(level, code, message, extra) {
  return Object.assign({ level, code, message }, extra || {});
}

function toRate(pct) {
  return Math.round((Number(pct) / 100) * 1e6) / 1e6;
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m;
  }
  return null;
}

/* --------------------------- 词表匹配 --------------------------- */

function matchMaCrossEntry(t) {
  // 显式周期：5日均线上穿20日均线 / MA5上穿MA20 / 5日线上穿20日线
  let m = firstMatch(t, [
    /(?:MA\s*)?(\d{1,3})\s*(?:日|天)?\s*(?:均线|线)?\s*(?:上穿|上叉|金叉|穿越|穿过)\s*(?:MA\s*)?(\d{1,3})\s*(?:日|天)?\s*(?:均线|线)?/i,
  ]);
  if (m) return { fast: Number(m[1]), slow: Number(m[2]), explicit: true, text: m[0], index: m.index };
  // 定性描述：短期均线上穿长期均线
  m = firstMatch(t, [/(?:短期|快线|快速)\s*均线\s*(?:上穿|上叉|金叉)\s*(?:长期|慢线|慢速)?\s*均线/]);
  if (m) return { fast: DEFAULTS.fast, slow: DEFAULTS.slow, explicit: false, text: m[0], index: m.index };
  // 均线金叉（无周期）
  m = firstMatch(t, [/均线\s*(?:金叉|上穿|上叉)/, /MA\s*(?:金叉|上穿)/i]);
  if (m) return { fast: DEFAULTS.fast, slow: DEFAULTS.slow, explicit: false, text: m[0], index: m.index };
  return null;
}

function matchBreakoutEntry(t) {
  let m = firstMatch(t, [
    /(?:突破|创|站上|越过)\s*(?:最近|过去|前)?\s*(\d{1,3})\s*(?:个)?\s*(?:交易日|日|天)?\s*(?:的)?\s*(?:最高价|新高|高点|最高点)/,
  ]);
  if (m) return { lookback: Number(m[1]), explicit: true, text: m[0], index: m.index };
  m = firstMatch(t, [/(?:突破|创|站上|越过)\s*(?:前高|前期高点|最近高点|历史新高)/]);
  if (m) return { lookback: DEFAULTS.lookback, explicit: false, text: m[0], index: m.index };
  return null;
}

function matchDeathCross(t) {
  let m = firstMatch(t, [
    /(?:MA\s*)?(\d{1,3})\s*(?:日|天)?\s*(?:均线|线)?\s*(?:下穿|死叉|下叉)\s*(?:MA\s*)?(\d{1,3})/i,
  ]);
  if (m) return { fast: Number(m[1]), slow: Number(m[2]), text: m[0], index: m.index };
  m = firstMatch(t, [/均线\s*(?:死叉|下穿)/, /MA\s*(?:死叉|下穿)/i]);
  if (m) return { fast: null, slow: null, text: m[0], index: m.index };
  m = firstMatch(t, [/(?:跌破|下破)\s*(\d{1,3})\s*(?:日|天)\s*(?:均线|线)/]);
  if (m) return { fast: null, slow: Number(m[1]), text: m[0], index: m.index };
  return null;
}

function matchHoldDays(t) {
  let m = firstMatch(t, [
    /(?:持有|持股|持仓)\s*(?:满|够|超过|至少)?\s*(\d{1,3})\s*(?:个)?\s*(?:交易日|天|日)/,
  ]);
  if (m) return { days: Number(m[1]), text: m[0], index: m.index };
  m = firstMatch(t, [/(\d{1,3})\s*(?:个)?\s*(?:交易日|天|日)\s*(?:后|之后)\s*(?:就)?\s*(?:卖出|清仓|平仓|卖掉)/]);
  if (m) return { days: Number(m[1]), text: m[0], index: m.index };
  return null;
}

function matchTakeProfit(t) {
  return firstMatch(t, [
    /(?:止盈|盈利|浮盈|收益|赚|涨)\s*(?:到|超过|达到|达|了)?\s*(\d{1,3}(?:\.\d+)?)\s*%/,
  ]);
}

function matchStopLoss(t) {
  return firstMatch(t, [
    /(?:止损|亏损|浮亏|回撤|跌|亏)\s*(?:到|超过|达到|达|了)?\s*(\d{1,3}(?:\.\d+)?)\s*%/,
  ]);
}

// 移动止损：必须明确说「移动/跟踪/从最高回撤」，否则仍按固定止损处理
function matchTrailingStop(t) {
  let m = firstMatch(t, [
    /(?:移动止损|移动止盈|跟踪止损|跟踪止盈|回撤止盈)\s*(?:到|超过|达到|达|为|设为)?\s*(\d{1,3}(?:\.\d+)?)\s*%/,
    /(?:从)?\s*(?:最高|峰值)\s*(?:点|价|收盘|收盘价)?\s*(?:回撤|回落)\s*(?:到|超过|达到|达|为)?\s*(\d{1,3}(?:\.\d+)?)\s*%/,
    /(?:回撤|回落)\s*(\d{1,3}(?:\.\d+)?)\s*%\s*(?:止盈|卖出|清仓|平仓)/,
  ]);
  if (m) return { drawdown: toRate(m[1]), text: m[0], index: m.index };
  m = firstMatch(t, [/(?:移动止损|跟踪止损|回撤止盈)/]);
  if (m) return { drawdown: null, text: m[0], index: m.index };
  return null;
}

function matchAuctionHold(t) {
  return firstMatch(t, [
    /(?:开盘)?\s*(?:涨幅|高开|上涨)\s*(?:达到|超过|大于|高于|>=?)?\s*(\d{1,3}(?:\.\d+)?)\s*%[^,。;]*?(?:继续持有|不卖|继续拿|持有|留着)/,
  ]);
}

/* --------------------------- 规则串 --------------------------- */

function pct(v) {
  if (v === null || v === undefined) return null;
  const n = Math.round(v * 1000000) / 10000;
  return (n >= 0 ? '+' : '') + n + '%';
}

const ENTRY_LABEL = {
  maCross: (p) => `MA${p.fast} 上穿 MA${p.slow} 金叉`,
  breakout: (p) => `收盘价突破前 ${p.lookback} 个交易日最高价`,
};

function describeDraft(draft) {
  if (!draft || !draft.params) return '';
  const tid = draft.route && draft.route.templateId;

  if (tid === 'composition') {
    const c = draft.params.composition;
    const labelOf = (node) => ENTRY_LABEL[node.type](node.params || {});
    const entryText = c.entry.type === 'all'
      ? c.entry.items.map(labelOf).join(' 且 ')
      : labelOf(c.entry);
    const exitTexts = c.exits.map((e) => {
      if (e.type === 'fixedHolding') return `持有满 ${e.params.days} 个交易日`;
      if (e.type === 'returnThreshold') {
        const seg = [];
        if (e.params.takeProfit != null) seg.push(`止盈 ${pct(e.params.takeProfit)}`);
        if (e.params.stopLoss != null) seg.push(`止损 ${pct(e.params.stopLoss).replace('+', '-')}`);
        return seg.join(' 或 ');
      }
      if (e.type === 'trailingStop') {
        return `从持仓最高收盘回撤 ${pct(e.params.drawdown).replace('+', '')} 卖出`;
      }
      return '均线死叉';
    });
    return `入场：${entryText}（收盘确认）。出场（任一触发）：${exitTexts.join(' / ')}。`
      + '全部信号在收盘后确认，次一交易日开盘成交；未复权、不含分红。';
  }

  if (tid === 'macd_cross') {
    return '入场：MACD(12,26,9) 金叉（收盘确认）。出场：MACD 死叉（收盘确认）。'
      + '两次成交均为次一交易日开盘；未复权、不含分红。';
  }

  // close_buy_open_sell
  const p = draft.params || {};
  const entry = p.entrySignal === 'macd_golden' ? 'MACD 金叉当日收盘价买入' : '每个交易日收盘价买入';
  let tail = '次日开盘卖出';
  if (p.auctionFilter && p.auctionFilter.holdIfGte != null) {
    tail += `；若次日开盘涨幅 ≥ ${pct(p.auctionFilter.holdIfGte)} 则继续持有，否则开盘卖出`;
  }
  return `入场：${entry}。出场：${tail}。未复权、不含分红。`;
}

/* --------------------------- 主流程 --------------------------- */

function parseStrategyText(text) {
  const sources = typeof text === 'string' ? text : '';
  const t = normalizeText(sources);
  const issues = [];
  const defaults = [];
  const evidence = [];
  const unsupported = [];

  const draft = {
    schema: DRAFT_SCHEMA,
    source: { text: sources, normalized: t },
    route: null,
    params: null,
    cardRequest: null,
    defaults,
    evidence,
    unsupported,
    issues,
    suggestedSymbol: null,
    ruleText: '',
    requiresConfirmation: true,
    executable: false,
  };

  function finish() {
    const hasError = issues.some((i) => i.level === 'error');
    draft.issues = issues;
    // 契约：只要存在 error，params / cardRequest 恒为 null，绝不输出半成品
    draft.ruleText = hasError || !draft.params ? '' : describeDraft(draft);
    if (hasError) {
      draft.params = null;
      draft.cardRequest = null;
    }
    draft.executable = !hasError && draft.params !== null;
    return draft;
  }

  if (!t.trim()) {
    issues.push(issue('error', 'E_TEXT_EMPTY',
      '输入为空。请用一句中文描述策略，例如「5日均线上穿20日均线买入，持有5个交易日卖出」。'));
    return finish();
  }

  // ①-a 非白名单词：先扫，命中即拒绝（避免「KDJ 金叉」被当成 MACD 金叉）
  const upper = t.toUpperCase();
  for (const item of UNSUPPORTED_TERMS) {
    const idx = upper.indexOf(item.term.toUpperCase());
    if (idx >= 0) {
      unsupported.push({ term: item.label, text: t.slice(idx, idx + item.term.length), start: idx, end: idx + item.term.length });
    }
  }
  if (unsupported.length) {
    issues.push(issue('error', 'E_NOT_SUPPORTED',
      `当前只支持『均线金叉 / N 日突破 / 固定持有 / 止盈止损 / 移动止损』五类条件；以下内容暂不支持：${unsupported.map((u) => u.term).join('、')}。`,
      { unsupported: unsupported.map((u) => u.term) }));
    // 只报根因：已有非白名单成分时不再追加「没识别到入场」之类的派生报错，避免误导
    return finish();
  }

  // ①-b 证券代码（可选，只作建议）
  const sym = /(?<!\d)(\d{6})(?!\d)/.exec(t);
  if (sym) {
    const code = sym[1];
    if (MAIN_BOARD_PREFIXES.some((p) => code.startsWith(p))) draft.suggestedSymbol = code;
    else {
      issues.push(issue('error', 'E_UNSUPPORTED_BOARD',
        `本版只支持沪深主板（600/601/603/605、000/001/002/003）；${code} 属于创业板/科创板/北交所/B 股，不支持。`));
    }
  }

  // ①-c 指标与成交语义识别
  const hasMacd = /MACD/i.test(t);
  const hasMaWords = /均线|MA\s*\d|日线|周线/i.test(t);
  const bareCross = /金叉|死叉/.test(t) && !hasMacd && !hasMaWords;

  const maEntry = matchMaCrossEntry(t);
  const boEntry = matchBreakoutEntry(t);
  const death = matchDeathCross(t);
  const hold = matchHoldDays(t);
  // 先识别移动止损，把它的文字从「固定止盈止损」的识别范围内挖掉，
  // 否则「从最高点回撤 8%」会被同时当成固定止损，凭空多出一个退出条件。
  const trailM = matchTrailingStop(t);
  const tExit = trailM
    ? (t.slice(0, trailM.index) + ' '.repeat(trailM.text.length) + t.slice(trailM.index + trailM.text.length))
    : t;
  const tpM = matchTakeProfit(tExit);
  const slM = matchStopLoss(tExit);
  const tpKw = /止盈/.test(tExit);
  const slKw = /止损/.test(tExit);
  const auctionM = matchAuctionHold(t);

  const tailBuy = /(?:尾盘|收盘前|临近收盘|收盘价?)\s*(?:买入|买|建仓)/.test(t);
  const nextOpenSell = /(?:次日|第二天|隔日|下个交易日)\s*(?:开盘|开盘价)\s*(?:卖出|卖|清仓)/.test(t);
  const isLegacy = tailBuy && nextOpenSell;

  const compEntries = [maEntry && { type: 'maCross', m: maEntry }, boEntry && { type: 'breakout', m: boEntry }].filter(Boolean);

  /* ---- 路由 ---- */
  if (bareCross) {
    issues.push(issue('error', 'E_AMBIGUOUS_ROUTE',
      '只看到「金叉/死叉」但没说是哪种指标。均线金叉与 MACD 金叉的买卖点不同，请明确写成「均线上穿」或「MACD 金叉」。'));
  }

  if (isLegacy) {
    if (compEntries.length) {
      issues.push(issue('error', 'E_AMBIGUOUS_ROUTE',
        '「尾盘买入、次日开盘卖出」与均线/突破条件混在一起：前者按收盘价成交，后者按次一交易日开盘成交，两者不能混。请二选一。'));
    }
    draft.route = { templateId: 'close_buy_open_sell', reason: '命中尾盘买入 + 次日开盘卖出' };
  } else if (hasMacd) {
    if (compEntries.length) {
      issues.push(issue('error', 'E_AMBIGUOUS_ROUTE', 'MACD 与均线/突破条件同时出现，本版不支持混用，请只保留一种入场条件。'));
    }
    if (hold || tpM || slM || tpKw || slKw) {
      issues.push(issue('error', 'E_AMBIGUOUS_ROUTE',
        'MACD 模板只支持金叉买、死叉卖，不支持叠加固定持有或止盈止损；如需组合条件请改用均线/突破入场。'));
    }
    draft.route = { templateId: 'macd_cross', reason: '命中 MACD 关键字' };
  } else if (compEntries.length) {
    draft.route = { templateId: 'composition', reason: '命中 ' + compEntries.map((e) => e.type).join(' + ') + '，走组合策略' };
  } else {
    issues.push(issue('error', 'E_NO_ENTRY',
      '没识别到入场条件。当前支持：均线金叉（如「5日均线上穿20日均线」）、N 日突破（如「突破前20日最高价」）、MACD 金叉、尾盘买入。'));
    return finish();
  }

  /* ---- 入场冲突 ---- */
  // 两个入场条件只在明确说「且 / 同时」时才按「同时成立」处理，
  // 否则「金叉、突破」到底是与还是或并不清楚，不能替用户猜。
  const hasConjunction = /(?:且|并且|而且|同时|一并|一起)/.test(t);
  if (compEntries.length > 2) {
    issues.push(issue('error', 'E_MULTI_ENTRY', '识别到 3 个以上入场条件，本版最多支持 2 个同时成立。'));
    return finish();
  } else if (compEntries.length === 2 && !hasConjunction) {
    issues.push(issue('error', 'E_MULTI_ENTRY',
      '识别到多个入场条件（' + compEntries.map((e) => e.type).join(' / ') + '），但没说清是「同时成立」还是「任一成立」。'
      + '本版只支持同时成立：请写成「A 且 B」；若只想保留一个，请删掉另一个。'));
    return finish();
  } else if (compEntries.length >= 1) {
    for (const e of compEntries) {
      evidence.push({ slot: 'entry', type: e.type, text: e.m.text, start: e.m.index, end: e.m.index + e.m.text.length });
    }
  }

  /* ---- 各路由的 params ---- */
  if (draft.route.templateId === 'composition') {
    if (!compEntries.length) return finish(); // 已被 E_NO_ENTRY 处理
    const atomOf = (raw) => {
      const m = raw.m;
      const params = raw.type === 'maCross' ? { fast: m.fast, slow: m.slow } : { lookback: m.lookback };
      if (!m.explicit) {
        defaults.push({
          field: `entry.params.${raw.type === 'maCross' ? 'fast/slow' : 'lookback'}`,
          value: raw.type === 'maCross' ? `${DEFAULTS.fast}/${DEFAULTS.slow}` : DEFAULTS.lookback,
          why: '文本未给出具体周期，按组件默认值处理',
        });
      }
      return { type: raw.type, params };
    };
    const entrySpec = compEntries.length > 1
      ? { type: 'all', items: compEntries.map(atomOf) }
      : atomOf(compEntries[0]);
    // 均线出场与入场共用一组参数；多条件与时取其中的 maCross 子条件
    const entryParams = entrySpec.type === 'maCross' ? entrySpec.params
      : entrySpec.type === 'all'
        ? ((entrySpec.items.find((it) => it.type === 'maCross') || { params: {} }).params)
        : { lookback: entrySpec.params.lookback };

    // 退出条件：按出现位置排序，保证 reasons 顺序与原文一致
    const exits = [];
    if (hold) {
      exits.push({ type: 'fixedHolding', params: { days: hold.days }, index: hold.index, text: hold.text });
    }
    if (tpM || slM || tpKw || slKw) {
      let takeProfit = null;
      let stopLoss = null;
      if (tpM) takeProfit = toRate(tpM[1]);
      else if (tpKw) {
        takeProfit = DEFAULTS.takeProfit;
        defaults.push({ field: 'exits.returnThreshold.takeProfit', value: DEFAULTS.takeProfit, why: '提到了止盈但没给百分比，按 10% 处理' });
      }
      if (slM) stopLoss = toRate(slM[1]);
      else if (slKw) {
        stopLoss = DEFAULTS.stopLoss;
        defaults.push({ field: 'exits.returnThreshold.stopLoss', value: DEFAULTS.stopLoss, why: '提到了止损但没给百分比，按 5% 处理' });
      }
      // 关键：只说了止盈就不补止损（补了就是悄悄改变策略语义）
      const anchor = (tpM || slM);
      exits.push({
        type: 'returnThreshold',
        params: { takeProfit, stopLoss },
        index: anchor ? anchor.index : 0,
        text: (tpM || slM || tpKw || slKw) ? (tpM && tpM[0]) || (slM && slM[0]) || '止盈止损' : '',
      });
    }
    if (trailM) {
      let dd = trailM.drawdown;
      if (dd == null) {
        dd = DEFAULTS.trailing;
        defaults.push({
          field: 'exits.trailingStop.drawdown', value: DEFAULTS.trailing,
          why: '提到了移动止损但没给百分比，按 8% 处理',
        });
      }
      exits.push({ type: 'trailingStop', params: { drawdown: dd }, index: trailM.index, text: trailM.text });
    }
    if (death) {
      if (death.fast != null && (death.fast !== entryParams.fast || death.slow !== entryParams.slow)) {
        issues.push(issue('warning', 'W_MA_SHARED',
          `出场死叉写的是 ${death.fast}/${death.slow} 日均线，但引擎的均线出场与入场共用一组参数（${entryParams.fast}/${entryParams.slow}），实际按入场参数执行。`));
      }
      exits.push({ type: 'maCross', params: {}, index: death.index, text: death.text });
    }

    exits.sort((a, b) => a.index - b.index);
    for (const e of exits) {
      evidence.push({ slot: 'exit', type: e.type, text: e.text, start: e.index, end: e.index + String(e.text).length });
    }

    if (!exits.length) {
      issues.push(issue('error', 'E_NO_EXIT',
        '只识别到入场条件，没有出场条件。本版不会替你默认一个出场（那会改变策略语义）；请补充「持有 N 个交易日」或「止盈 X% / 止损 Y%」或「移动止损 X%」或「均线死叉卖出」。'));
      return finish();
    }
    if (exits.length > 3) {
      issues.push(issue('error', 'E_TOO_MANY_EXITS', `退出条件最多 3 个，当前 ${exits.length} 个。`));
      return finish();
    }

    const composition = {
      schema: 'stv.composition/0.1',
      entry: entrySpec,
      exits: exits.map((e) => ({ type: e.type, params: e.params })),
    };

    // ② 既有前置白名单（原样调用）
    const pv = normalizeParams('composition', { composition });
    if (!pv.ok) {
      issues.push(issue('error', pv.code || 'E_PARAMS', pv.message));
      return finish();
    }

    // ③ 既有引擎参数校验（空行情数组只跑参数段）
    try {
      buildConditions([], pv.value.composition);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const code = (msg.split(':')[0] || 'E_ENGINE_REJECT').trim();
      issues.push(issue('error', code, '引擎参数校验未通过：' + msg));
      return finish();
    }

    draft.params = pv.value;
    draft.cardRequest = { templateId: 'composition', symbol: draft.suggestedSymbol, params: pv.value };
    return finish();
  }

  if (draft.route.templateId === 'macd_cross') {
    const pv = normalizeParams('macd_cross', {});
    if (!pv.ok) {
      issues.push(issue('error', pv.code || 'E_PARAMS', pv.message));
      return finish();
    }
    defaults.push({ field: 'params.fast/slow/signal', value: '12/26/9', why: 'MACD 参数与封版回测一致，本版锁定不可改' });
    draft.params = pv.value;
    draft.cardRequest = { templateId: 'macd_cross', symbol: draft.suggestedSymbol, params: pv.value };
    return finish();
  }

  // close_buy_open_sell
  const raw = { entrySignal: hasMacd ? 'macd_golden' : 'always' };
  if (auctionM) raw.holdIfGte = toRate(auctionM[1]);
  else if (/集合竞价|竞价/.test(t) && /继续持有/.test(t)) {
    raw.holdIfGte = 0.02;
    defaults.push({ field: 'params.holdIfGte', value: 0.02, why: '提到了竞价后继续持有但没给涨幅阈值，按 2% 处理' });
  }
  const pv = normalizeParams('close_buy_open_sell', raw);
  if (!pv.ok) {
    issues.push(issue('error', pv.code || 'E_PARAMS', pv.message));
    return finish();
  }
  if (!hasMacd) {
    defaults.push({ field: 'params.entrySignal', value: 'always', why: '未提到入场信号，按「每个交易日收盘买入」处理' });
  }
  draft.params = pv.value;
  // 注意：老模板的 normalizeParams 会补出 entryFill/exitFill，而 buildCard 不接受这两个键
  // （它自己按模板补），所以重建卡片必须回填最小请求参数，不能把 pv.value 原样喂回去。
  draft.cardRequest = { templateId: 'close_buy_open_sell', symbol: draft.suggestedSymbol, params: Object.assign({}, raw) };
  return finish();
}

module.exports = {
  DRAFT_SCHEMA,
  DEFAULTS,
  UNSUPPORTED_TERMS,
  ENTRY_LABEL,
  normalizeText,
  describeDraft,
  parseStrategyText,
};
