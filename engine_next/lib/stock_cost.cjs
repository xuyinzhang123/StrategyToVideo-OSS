/* ============================================================================
 * S1 个股费用与税模型（日期感知，独立可测）
 *
 * 为什么单独成模块：
 *   1) 费用不是常数。区间内印花税与过户费各发生过一次费率变更，
 *      每一笔成交必须按「成交当日」适用费率计收，而不是用期末费率回溯。
 *   2) 股息红利个人所得税按「持股期限」在卖出时补扣，与成交费用分属两套规则。
 *   3) 配置里出现的每一条规则都必须真正参与计算：本模块对「某日无适用规则」
 *      直接抛错，不允许静默按 0 处理。
 *
 * 计收精度：A 股三项费用均以「元」为单位保留 2 位小数（四舍五入）后逐项相加。
 * ==========================================================================*/
'use strict';

const EPS = 1e-9;

function r2(x) {
  return Math.round((x + 1e-10) * 100) / 100;
}

function inEffect(date, rule) {
  if (date < rule.effectiveFrom) return false;
  if (rule.effectiveTo && date > rule.effectiveTo) return false;
  return true;
}

/* 校验分段规则：必须有序、不得重叠、最后一段必须开放到未来 */
function validateRules(name, rules) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error(`E_COST_RULE_EMPTY: ${name}`);
  const sorted = [...rules].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  for (let i = 0; i < sorted.length; i++) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sorted[i].effectiveFrom))
      throw new Error(`E_COST_RULE_DATE: ${name}[${i}] effectiveFrom 非法`);
    if (!(sorted[i].rate >= 0)) throw new Error(`E_COST_RULE_RATE: ${name}[${i}] rate 非法`);
    if (i > 0) {
      const prev = sorted[i - 1];
      if (!prev.effectiveTo)
        throw new Error(`E_COST_RULE_OVERLAP: ${name} 第 ${i - 1} 段未设 effectiveTo，却存在后续分段`);
      if (prev.effectiveTo >= sorted[i].effectiveFrom)
        throw new Error(`E_COST_RULE_OVERLAP: ${name} ${prev.effectiveTo} 与 ${sorted[i].effectiveFrom} 重叠`);
    }
  }
  if (sorted[sorted.length - 1].effectiveTo)
    throw new Error(`E_COST_RULE_OPEN_END: ${name} 最后一段必须 effectiveTo=null（覆盖至未来）`);
  return sorted;
}

function buildSchedule(cfg, opt = {}) {
  const allowZero = !!opt.allowZero;
  const c = cfg.costs;
  if (!c || !c.commission) throw new Error('E_COST_CFG: 缺少 costs.commission');
  const comm = c.commission;
  if (allowZero ? !(comm.rate >= 0) : !(comm.rate > 0))
    throw new Error('E_COST_CFG: commission.rate 必须为正');
  if (!(comm.minPerOrder >= 0)) throw new Error('E_COST_CFG: commission.minPerOrder 非法');
  if (comm.statutoryCapRate && comm.rate > comm.statutoryCapRate + EPS)
    throw new Error(`E_COST_CFG: commission.rate ${comm.rate} 超过法定上限 ${comm.statutoryCapRate}`);

  const stampDuty = validateRules('stampDuty', c.stampDuty);
  const transferFee = validateRules('transferFee', c.transferFee);
  for (const x of stampDuty) if (x.side !== 'sell') throw new Error('E_COST_CFG: 证券交易印花税仅对出让方（卖出）征收');
  for (const x of transferFee) if (x.side !== 'both') throw new Error('E_COST_CFG: 过户费为双向收取');

  const dt = c.dividendTax;
  if (!dt || !Array.isArray(dt.brackets) || dt.brackets.length === 0) throw new Error('E_COST_CFG: 缺少 dividendTax.brackets');
  let lastMax = -1;
  for (const b of dt.brackets) {
    if (b.maxHoldingDays !== null) {
      if (!(b.maxHoldingDays > lastMax)) throw new Error('E_COST_CFG: dividendTax 分档必须升序');
      lastMax = b.maxHoldingDays;
    } else if (b !== dt.brackets[dt.brackets.length - 1]) {
      throw new Error('E_COST_CFG: dividendTax 的开放式分档必须位于末尾');
    }
    const expect = (b.includeRatio ?? 0) * 0.2;
    if (Math.abs(expect - b.rate) > 1e-9)
      throw new Error(`E_COST_CFG: dividendTax 分档 rate=${b.rate} 与 includeRatio×20%=${expect} 不一致`);
  }

  return { commission: comm, stampDuty, transferFee, dividendTax: dt };
}

function stampDutyRate(date, schedule) {
  const rule = schedule.stampDuty.find(x => inEffect(date, x));
  if (!rule) throw new Error(`E_COST_RULE_MISSING: ${date} 无适用印花税规则`);
  return rule.rate;
}

function transferFeeRate(date, schedule) {
  const rule = schedule.transferFee.find(x => inEffect(date, x));
  if (!rule) throw new Error(`E_COST_RULE_MISSING: ${date} 无适用过户费规则`);
  return rule;
}

/* 单笔成交费用：commission + stampDuty(仅卖) + transferFee(双向) */
function tradeFee({ date, side, amount, shares, price, parValue, schedule }) {
  if (!(amount >= 0)) throw new Error('E_COST_INPUT: amount 非法');
  if (side !== 'buy' && side !== 'sell') throw new Error('E_COST_INPUT: side 非法');
  const comm = schedule.commission;

  let commission = amount * comm.rate;
  /* 法定 3‰ 是「费率上限」，与「每笔最低 5 元」并列：小额成交按最低 5 元收取时，
   * 其占成交额比例可以高于 3‰，这是规则本身的结果，不属于越界。
   * 费率上限在 buildSchedule 阶段已对配置做过校验，此处不再重复拦截。 */
  if (commission < comm.minPerOrder) commission = comm.minPerOrder;

  const sdRate = stampDutyRate(date, schedule);
  const stampDuty = side === 'sell' ? amount * sdRate : 0;

  const tf = transferFeeRate(date, schedule);
  const transferFee = tf.basis === 'par'
    ? shares * (parValue || 1) * tf.rate
    : amount * tf.rate;

  const C = r2(commission), S = r2(stampDuty), T = r2(transferFee);
  return {
    commission: C, stampDuty: S, transferFee: T, total: r2(C + S + T),
    rates: { commissionRate: comm.rate, stampDutyRate: sdRate, transferFeeRate: tf.rate, transferFeeBasis: tf.basis }
  };
}

/* 股息红利个税：按「卖出时」的持股期限确定档位，对持有期内已收到的税前红利总额补扣 */
function dividendTaxRate(holdingDays, schedule) {
  const dt = schedule.dividendTax;
  for (const b of dt.brackets) {
    if (b.maxHoldingDays === null || holdingDays <= b.maxHoldingDays) return b.rate;
  }
  throw new Error(`E_DIVTAX_BRACKET: 持股 ${holdingDays} 天无适用档位`);
}

function dividendTax(grossDividend, holdingDays, schedule) {
  if (!(grossDividend > 0)) return { tax: 0, rate: 0, holdingDays };
  const rate = dividendTaxRate(holdingDays, schedule);
  return { tax: r2(grossDividend * rate), rate, holdingDays };
}

/* 给定现金、价格与成交日，求可买最大股数（lot 整数倍，含全部买入费用后不超出现金）。
 * 初值用「只计比例佣金」的成本反解，是对真实可买股数的上界，再逐手回退校验。 */
function affordableShares(cash, price, lot, date, parValue, schedule) {
  if (!(price > 0) || !(cash > 0)) return 0;
  let n = Math.floor(cash / (price * (1 + schedule.commission.rate)) / lot) * lot;
  while (n > 0) {
    const amount = n * price;
    const f = tradeFee({ date, side: 'buy', amount, shares: n, price, parValue, schedule });
    if (amount + f.total <= cash + EPS) break;
    n -= lot;
  }
  return Math.max(0, n);
}

/* 零费用对照：费率全部置 0，但保留同一套日期分段，
 * 使「零费用」只剥离费用本身，不改变任何时点口径与份额约束。 */
function zeroCostConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg.costs));
  c.commission.rate = 0;
  c.commission.minPerOrder = 0;
  c.stampDuty = c.stampDuty.map(x => Object.assign({}, x, { rate: 0 }));
  c.transferFee = c.transferFee.map(x => Object.assign({}, x, { rate: 0 }));
  c.dividendTax = Object.assign({}, c.dividendTax, {
    brackets: c.dividendTax.brackets.map(b => Object.assign({}, b, { includeRatio: 0, rate: 0 }))
  });
  return { costs: c };
}

module.exports = {
  r2, buildSchedule, tradeFee, stampDutyRate, transferFeeRate,
  dividendTax, dividendTaxRate, affordableShares, zeroCostConfig
};
