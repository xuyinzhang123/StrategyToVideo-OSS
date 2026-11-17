'use strict';
// web/src/nlPreview.cjs
// V0.4 阶段 B：网页端「自然语言 → 策略卡」的预览/改参服务层。
//
// 设计约束：
//   1. 纯函数：不读写文件、不联网、不建任务，只把文本 + 用户改动算成一份可确认的草案。
//   2. 用户改完参数必须重走同一套门禁（normalizeParams → buildConditions），
//      不许出现「界面显示了 A、实际提交 B」。规则串永远由结构化字段重新生成。
//   3. 只允许改数值参数，不允许借此新增/删除条件、换组件——那等于绕过确认。
//   4. 未经确认的草案不落库：本模块不产生任何副作用，确认动作由前端显式发起。

const { parseStrategyText, describeDraft, DRAFT_SCHEMA } = require('../../engine_next/strategy_nl.cjs');
const { normalizeParams } = require('./strategyCard.js');
const { buildConditions } = require('../../engine_next/strategy_conditions.cjs');

const MAX_TEXT_CHARS = 300;

// 允许用户在确认页手改的字段（只限数值旋钮，不含条件增删）
const OVERRIDE_KEYS = ['fast', 'slow', 'lookback', 'days', 'takeProfit', 'stopLoss', 'holdIfGte'];
const INTEGER_KEYS = new Set(['fast', 'slow', 'lookback', 'days']);

function failIssue(code, message) {
  return { level: 'error', code, message };
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function filterDefaults(list, overrides) {
  return (list || []).filter((d) => {
    if ((overrides.fast !== undefined || overrides.slow !== undefined) && String(d.field).startsWith('entry.params')) return false;
    if (overrides.lookback !== undefined && String(d.field).startsWith('entry.params')) return false;
    if (overrides.takeProfit !== undefined && /takeProfit/.test(String(d.field))) return false;
    if (overrides.stopLoss !== undefined && /stopLoss/.test(String(d.field))) return false;
    if (overrides.holdIfGte !== undefined && /holdIfGte/.test(String(d.field))) return false;
    if (overrides.days !== undefined && /fixedHolding|days/.test(String(d.field))) return false;
    return true;
  });
}

// 把用户改动写进「重建卡片的最小请求参数」，不直接改 draft.params。
function applyOverrides(draft, overrides, issues) {
  const tid = draft.route && draft.route.templateId;
  const req = clone(draft.cardRequest.params || {});

  if (tid === 'composition') {
    const comp = req.composition;
    const findExit = (t) => comp.exits.find((e) => e.type === t);

    if (overrides.fast !== undefined || overrides.slow !== undefined) {
      if (comp.entry.type !== 'maCross') {
        issues.push(failIssue('E_OVERRIDE_NO_TARGET', '当前入场条件不是均线金叉，没有 fast/slow 可改。'));
      } else {
        if (overrides.fast !== undefined) comp.entry.params.fast = overrides.fast;
        if (overrides.slow !== undefined) comp.entry.params.slow = overrides.slow;
      }
    }
    if (overrides.lookback !== undefined) {
      if (comp.entry.type !== 'breakout') {
        issues.push(failIssue('E_OVERRIDE_NO_TARGET', '当前入场条件不是区间突破，没有 lookback 可改。'));
      } else {
        comp.entry.params.lookback = overrides.lookback;
      }
    }
    if (overrides.days !== undefined) {
      const e = findExit('fixedHolding');
      if (!e) issues.push(failIssue('E_OVERRIDE_NO_TARGET', '当前策略没有「固定持有」退出条件，无法改持有天数。'));
      else e.params.days = overrides.days;
    }
    if (overrides.takeProfit !== undefined || overrides.stopLoss !== undefined) {
      const e = findExit('returnThreshold');
      if (!e) {
        issues.push(failIssue('E_OVERRIDE_NO_TARGET', '当前策略没有「止盈止损」退出条件，请重新描述策略而不是在这里加条件。'));
      } else {
        if (overrides.takeProfit !== undefined) e.params.takeProfit = overrides.takeProfit;
        if (overrides.stopLoss !== undefined) e.params.stopLoss = overrides.stopLoss;
      }
    }
    return { templateId: 'composition', params: req };
  }

  if (tid === 'close_buy_open_sell') {
    if (overrides.holdIfGte !== undefined) {
      if (overrides.holdIfGte === null) delete req.holdIfGte;
      else req.holdIfGte = overrides.holdIfGte;
    }
    const others = Object.keys(overrides).filter((k) => k !== 'holdIfGte');
    if (others.length) {
      issues.push(failIssue('E_OVERRIDE_NO_TARGET', '该模板只支持修改集合竞价跳空阈值：' + others.join('、')));
    }
    return { templateId: 'close_buy_open_sell', params: req };
  }

  // macd_cross：参数与封版回测一致，锁定不可改
  if (Object.keys(overrides).length) {
    issues.push(failIssue('E_OVERRIDE_LOCKED', 'MACD 参数锁定为 12/26/9（与封版回测一致），不可修改。'));
  }
  return { templateId: 'macd_cross', params: req };
}

function revalidate(templateId, reqParams, issues) {
  const pv = normalizeParams(templateId, reqParams);
  if (!pv.ok) {
    issues.push(failIssue(pv.code || 'E_PARAMS', pv.message));
    return null;
  }
  if (templateId === 'composition') {
    try {
      buildConditions([], pv.value.composition);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const code = (msg.split(':')[0] || 'E_ENGINE_REJECT').trim();
      issues.push(failIssue(code, '引擎参数校验未通过：' + msg));
      return null;
    }
  }
  return pv.value;
}

/**
 * @param {{text?:string, overrides?:object}} input
 * @returns 草案（executable=false 时 params/cardRequest 恒为 null）
 */
function previewNl(input) {
  const body = input && typeof input === 'object' ? input : {};
  const text = typeof body.text === 'string' ? body.text : '';
  const rawOv = body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides) ? body.overrides : {};

  if (text.length > MAX_TEXT_CHARS) {
    return {
      ok: false, schema: DRAFT_SCHEMA, executable: false, params: null, cardRequest: null,
      issues: [failIssue('E_TEXT_TOO_LONG', `策略描述最多 ${MAX_TEXT_CHARS} 字，请精简后再试。`)],
      defaults: [], evidence: [], unsupported: [], suggestedSymbol: null, ruleText: '', requiresConfirmation: true,
    };
  }

  const issues = [];
  // 只允许白名单字段，避免「前端多传一个键就悄悄改了语义」
  const unknown = Object.keys(rawOv).filter((k) => OVERRIDE_KEYS.indexOf(k) < 0);
  if (unknown.length) issues.push(failIssue('E_OVERRIDE_UNKNOWN', '不支持修改的字段：' + unknown.join('、')));
  for (const k of Object.keys(rawOv)) {
    if (OVERRIDE_KEYS.indexOf(k) < 0) continue;
    const v = rawOv[k];
    if (v === null && (k === 'takeProfit' || k === 'stopLoss' || k === 'holdIfGte')) continue; // null = 关闭该阈值
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      issues.push(failIssue('E_OVERRIDE_TYPE', `参数 ${k} 必须是数字。`));
    } else if (INTEGER_KEYS.has(k) && !Number.isInteger(v)) {
      issues.push(failIssue('E_OVERRIDE_TYPE', `参数 ${k} 必须是整数。`));
    }
  }
  const overrides = {};
  for (const k of Object.keys(rawOv)) {
    if (OVERRIDE_KEYS.indexOf(k) >= 0 && issues.length === 0) overrides[k] = rawOv[k];
  }

  const draft = parseStrategyText(text);

  // 解析就没过：原样返回（含原始错误），不叠加改参逻辑
  if (!draft.executable || !draft.cardRequest) {
    return {
      ok: false,
      schema: DRAFT_SCHEMA,
      source: draft.source,
      route: draft.route,
      executable: false,
      params: null,
      cardRequest: null,
      defaults: draft.defaults,
      evidence: draft.evidence,
      unsupported: draft.unsupported,
      suggestedSymbol: draft.suggestedSymbol,
      ruleText: '',
      requiresConfirmation: true,
      issues: issues.concat(draft.issues),
    };
  }

  if (issues.length) {
    return {
      ok: false, schema: DRAFT_SCHEMA, source: draft.source, route: draft.route,
      executable: false, params: null, cardRequest: null,
      defaults: draft.defaults, evidence: draft.evidence, unsupported: draft.unsupported,
      suggestedSymbol: draft.suggestedSymbol, ruleText: '', requiresConfirmation: true,
      issues: issues.concat(draft.issues),
    };
  }

  const hasOverrides = Object.keys(overrides).length > 0;
  const applied = hasOverrides ? applyOverrides(draft, overrides, issues) : {
    templateId: draft.route.templateId,
    params: clone(draft.cardRequest.params),
  };

  let params = null;
  if (!issues.some((i) => i.level === 'error')) {
    params = revalidate(applied.templateId, applied.params, issues);
  }

  const out = {
    ok: false,
    schema: DRAFT_SCHEMA,
    source: draft.source,
    route: { templateId: applied.templateId, reason: draft.route.reason },
    executable: false,
    params,
    cardRequest: params ? { templateId: applied.templateId, symbol: draft.suggestedSymbol, params: applied.params } : null,
    defaults: filterDefaults(draft.defaults, overrides),
    evidence: draft.evidence,
    unsupported: draft.unsupported,
    suggestedSymbol: draft.suggestedSymbol,
    ruleText: '',
    requiresConfirmation: true,
    edited: hasOverrides,
    issues: issues.concat(draft.issues),
  };

  const hasError = out.issues.some((i) => i.level === 'error');
  if (hasError || !params) {
    out.params = null;
    out.cardRequest = null;
    out.ruleText = '';
    out.executable = false;
  } else {
    out.ruleText = describeDraft(out);
    out.ok = true;
    out.executable = true;
  }
  return out;
}

module.exports = { previewNl, MAX_TEXT_CHARS, OVERRIDE_KEYS };
