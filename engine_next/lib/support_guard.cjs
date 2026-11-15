/* ============================================================================
 * 支持边界的「运行期拒绝」模块
 *
 * 目的：把文档里的限制变成会抛异常的校验。凡是本版内核不具备的能力，
 *      调用时必须在入口处直接失败，而不是靠注释或报告提醒使用者。
 *
 * 本版明确不支持（因此拒绝）：
 *   · 加仓 / 分批建仓            —— 内核只做「一次买入、一次卖出」的批次，
 *                                   多批次会使红利税无法按单一批次税率结算
 *   · 部分卖出                   —— 同上，且会引入零碎股与成本分摊
 *   · 分红再投资                 —— 口径要求现金分红计入现金后不再投资
 *   · 次日收盘卖出再买回（B 方案）—— 已取消，不再开发
 *   · 融资融券 / 做空            —— 无资金与券源约束模型
 *   · 非沪深主板 / 风险警示 / 退市 / 配股缩股 —— 见 config.support
 *
 * 该模块对所有现有调用都是空操作（现有 opts 不含上述字段），
 * 因此引入它不改变任何既有结果。
 * ==========================================================================*/
'use strict';

/** 选项级不支持能力：opts 中出现该键且为真值即拒绝 */
const UNSUPPORTED_OPTS = {
  addPosition: '加仓/分批建仓（本版仅支持单一批次：一次买入、一次卖出）',
  pyramid: '加仓/金字塔建仓（本版仅支持单一批次）',
  partialSell: '部分卖出（会使红利税无法按单一批次结算）',
  sellPartial: '部分卖出（会使红利税无法按单一批次结算）',
  rebalance: '定期再平衡/调仓（本版不支持中途调整持仓）',
  reinvestDividend: '分红再投资（口径要求现金分红计入现金后不再投资）',
  drip: '分红再投资（口径要求现金分红计入现金后不再投资）',
  closeToClose: '次日收盘卖出再买回（B 方案已取消，不再开发）',
  margin: '融资融券（本版无杠杆与保证金模型）',
  short: '做空（本版无券源与借券成本模型）',
  multiBatchTax: '按批次 FIFO 计税（当前实现为单一批次单一税率）'
};

/** 证券级不支持类型：命中即拒绝，不做降级 */
const UNSUPPORTED_BOARDS = {
  GEM: '创业板（300/301）',
  STAR: '科创板（688/689）',
  BSE: '北交所（8/4/92 开头）',
  B_SHARE: 'B 股（900/200 开头）'
};

class UnsupportedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UnsupportedError';
    this.code = code;
  }
}

/**
 * 校验运行选项。返回被忽略的空数组（无问题时），有问题直接抛错。
 * @param {object} opts 传给 runOvernightStock / runHoldStock 的选项
 * @param {string} where 调用点标识，用于报错定位
 */
function assertSupportedOptions(opts, where) {
  if (!opts || typeof opts !== 'object') throw new UnsupportedError('E_OPTS_INVALID', `${where}: 选项缺失`);
  const hits = [];
  for (const [k, label] of Object.entries(UNSUPPORTED_OPTS)) {
    const v = opts[k];
    if (v === undefined || v === null || v === false) continue;
    /* 显式声明为 false 视为「不启用」；其余任何真值一律拒绝 */
    hits.push(`opts.${k} → ${label}`);
  }
  if (hits.length) {
    throw new UnsupportedError('E_UNSUPPORTED_MODE',
      `${where}: 请求了本版不支持的能力，已拒绝执行\n  ` + hits.join('\n  '));
  }
  return true;
}

/**
 * 校验标的是否落在支持范围内（主板、非风险警示、非退市整理）。
 * @param {{code:string, name?:string, board?:string}} sym
 */
function assertSupportedSymbol(sym, where) {
  if (!sym || !sym.code) throw new UnsupportedError('E_SYMBOL_INVALID', `${where}: 缺少证券代码`);
  const code = String(sym.code);
  if (sym.board && UNSUPPORTED_BOARDS[sym.board])
    throw new UnsupportedError('E_UNSUPPORTED_BOARD', `${where}: ${code} 属于${UNSUPPORTED_BOARDS[sym.board]}，本版不支持`);
  if (/^(300|301)/.test(code)) throw new UnsupportedError('E_UNSUPPORTED_BOARD', `${where}: ${code} 属于创业板，本版不支持`);
  if (/^(688|689)/.test(code)) throw new UnsupportedError('E_UNSUPPORTED_BOARD', `${where}: ${code} 属于科创板，本版不支持`);
  if (/^(8|4|92)/.test(code)) throw new UnsupportedError('E_UNSUPPORTED_BOARD', `${where}: ${code} 属于北交所，本版不支持`);
  if (/^(900|200)/.test(code)) throw new UnsupportedError('E_UNSUPPORTED_BOARD', `${where}: ${code} 属于 B 股，本版不支持`);
  if (!/^(600|601|603|605|000|001|002|003)/.test(code))
    throw new UnsupportedError('E_UNSUPPORTED_BOARD', `${where}: ${code} 不在沪深主板代码段内，本版不支持`);
  const nm = String(sym.name || '');
  if (/(^|\*)ST|退$|退市/.test(nm))
    throw new UnsupportedError('E_UNSUPPORTED_STATUS', `${where}: ${code} 简称「${nm}」属风险警示/退市整理，本版不支持`);
  return true;
}

/**
 * 校验公司行为类型：只接受现金分红与送转，其余（配股/缩股/换股/分拆）拒绝。
 * @param {Array<{type?:string, plan?:string, shareRatio?:number}>} actions
 */
function assertSupportedActions(actions, where) {
  const SUPPORTED = new Set(['CASH_DIV', 'SHARE_DIV']);
  const bad = [];
  for (const a of actions || []) {
    const t = a.type || (a.shareRatio > 0 ? 'SHARE_DIV' : 'CASH_DIV');
    if (!SUPPORTED.has(t)) bad.push(`${a.date || '?'} ${t}`);
    if (/配\s*\d*\s*股|缩股|换股|分拆/.test(String(a.plan || '')))
      bad.push(`${a.date || '?'} 方案含不支持的公司行为：${a.plan}`);
  }
  if (bad.length)
    throw new UnsupportedError('E_UNSUPPORTED_ACTION',
      `${where}: 存在本版不支持的公司行为，已拒绝执行\n  ` + bad.join('\n  '));
  return true;
}

module.exports = {
  UNSUPPORTED_OPTS, UNSUPPORTED_BOARDS, UnsupportedError,
  assertSupportedOptions, assertSupportedSymbol, assertSupportedActions
};
