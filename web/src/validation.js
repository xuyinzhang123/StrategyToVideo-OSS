'use strict';
// web/src/validation.js
// 参数白名单校验（纯函数，不调用引擎、不读写文件）。
//
// 设计约束（来自 WEB_MVP_V01_PLAN.md 与阶段 2 任务书）：
//   1. Open Source V0.1 仅支持一个策略标识：macd（模拟数据演示）。
//   2. 每个策略使用独立参数白名单；拒绝未知字段、非法类型、危险路径。
//   3. 标的不可由客户端指定；V0.1 仅接受 macd（模拟标的，代码为格式占位）。
//   4. 本金：有限正数，处于合理范围。
//   5. 日期：严格 YYYY-MM-DD、真实日历日期、start<end、落在已验证覆盖窗口。
//   6. 视频规格：只接受现有明确支持的配置（1920x1080 @ 30fps）。
//   7. MACD 参数使用已验证 12/26/9，暂不开放任意组合（不接受 macd 相关字段）。
//   8. 比值轮动阈值已锁定为 0.35/0.65（与封版一致），仅接受该值，禁止客户端改阈值。
//   9. 禁止客户端指定 taskId 或任意输出目录（字段黑名单）。
//  10. 错误码沿用 web 层 E_* 体系；其中 E_STRATEGY_UNSUPPORTED 与统一调度层一致。
//  11. 阶段 4A：MACD 网页执行参数全部锁定（本金/区间/视频规格），显式提交其他值
//      返回 E_PARAM_LOCKED。回测区间实际由离线归档 bars 决定，不宣称支持任意日期/本金。
//  12. 阶段 4B：红利 ETF 参数同样锁定（三只标的/每只本金/区间/V3.4.1 规格）。
//      backtest_dividend_v2.cjs 内建 capital=100000 且区间由 price_bars.meta 决定，
//      不接受网页参数，故必须显式拒绝其他值，绝不静默忽略输入。
//
// 窗口来源（详见 WEB_MVP_V01_PLAN.md「引擎 CLI 核查」）：
//   ratio_band   : agent/unified/registry.cjs sealed {start:2018-01-01,end:2026-11-06,low:0.35,high:0.65}
//   dividend_etf : output/div_etf_ep1_v2_20261110/02_backtest/daily.csv 实测区间 2020-02-26→2026-11-06
//   macd         : agent/unified/registry.cjs stock_overnight sealed {start:2016-01-04,end:2026-11-06}; 代码 601398

const { validateImport } = require('./import/validate');
const strategyCard = require('./strategyCard');

// strategy_card：V0.2 之后的「自动取数」通道——用户只给代码/区间/模板，
// 由后端取东方财富未复权日线后走统一回测与出片（不需要用户准备 CSV）。
const STRATEGY_IDS = ['macd', 'timeseries', 'cross_section', 'stock_ohlc', 'strategy_card'];

// 用户 CSV 通道（V0.2）：A/B 两类 + C 类股票日线。
// C 类门禁（DATA_SPEC §7.1）已通过：G-1 qfq 无二次调整、G-4 amount 无下游依赖。
const USER_CLASSES = ['timeseries', 'cross_section', 'stock_ohlc'];

// 用户 CSV 请求允许的字段（与引擎侧 createTask 写入 request.json 的字段一一对应）
// C 类额外需要：symbol（必填）、name、adjust、dividendCsvText（可选分红表原文）
const USER_ALLOWED_FIELDS = new Set([
  'strategy', 'title', 'unit', 'asOf', 'sourceNote', 'mapping', 'csvText', 'fileName', 'sortByValue',
  'symbol', 'name', 'adjust', 'dividendCsvText',
]);

const WINDOWS = {
  ratio_band: {
    start: '2018-01-01',
    end: '2026-11-06',
    principalDefault: 500000,
    fixedCodes: ['399006', '000922'], // 未开放策略的历史框架占位常量（不参与 V0.1 校验）
    extra: { thresholdLow: 0.35, thresholdHigh: 0.65 },
  },
  dividend_etf: {
    start: '2020-02-26',
    end: '2026-11-06',
    principalDefault: 100000,
    fixedCodes: ['512890', '515450', '515180'], // 未开放策略的历史框架占位常量（不参与 V0.1 校验）
    extra: {},
  },
  macd: {
    start: '2016-01-04',
    end: '2026-11-06',
    principalDefault: 100000,
    fixedCodes: ['601398'], // 主板 6 位代码格式占位，用于复用内核证券代码校验；非真实证券标识
    extra: {},
    macdFixed: { fast: 12, slow: 26, signal: 9 },
  },
};

// 视频规格白名单（现有明确支持的配置）
const VIDEO_RESOLUTIONS = ['1920x1080'];
const VIDEO_FPS = [30];

// 本金合理范围
const PRINCIPAL_MIN = 1000;
const PRINCIPAL_MAX = 100000000; // 1 亿

// 阶段 4A：MACD 网页执行锁定参数（与封版 config.stock_macd.json / V1.2.2 一致）。
// startDate 用「真实首个交易日」2016-01-04；封版配置里的 2016-01-01 只是请求值。
const MACD_LOCKED = {
  principal: 100000,
  startDate: '2016-01-04',
  endDate: '2026-11-06',
  resolution: '1920x1080',
  fps: 30,
  macd: { fast: 12, slow: 26, signal: 9 },
};

// 阶段 4B：红利 ETF 网页执行锁定参数。
// 关键（任务书 §四）：backtest_dividend_v2.cjs 把每只本金 100000 写死在源码里，
// 且区间由 01_data/price_bars.json 的 meta.start/end 决定，均不接受网页参数。
// 因此这里必须显式拒绝其他值，杜绝「校验允许、回测静默忽略」。
const DIVIDEND_ETF_LOCKED = {
  principal: 100000, // 每只 ETF
  startDate: '2020-02-26',
  endDate: '2026-11-06',
  resolution: '1920x1080',
  fps: 30,
  codes: ['512890', '515450', '515180'],
  videoVersion: 'V3.4.1',
};

// 客户端禁止指定的字段（标识 / 路径 / 输出目录等）
const FORBIDDEN_FIELDS = [
  'taskId', 'task_id', 'taskID',
  'outputDir', 'output_dir', 'outDir', 'output',
  'runId', 'run_id', 'run',
  'config', 'configPath', 'config_path',
  'path', 'dir', 'directory', 'filePath', 'file_path', 'filename',
];

// 原型链注入键
const PROTO_KEYS = ['__proto__', 'prototype', 'constructor'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// 严格解析 YYYY-MM-DD，要求与输入完全一致（拒绝 2026-02-30 这类不存在日期）
function parseDateStrict(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d, iso: s };
}

// 拒绝字符串中的危险路径特征（纵深防御）。
// 仅拦截真实穿越/绝对路径模式；不拦截含内部 '/' 的普通值（如日期 2016/01/04）。
function looksLikePath(s) {
  if (typeof s !== 'string') return false;
  if (s.includes('..')) return true;          // 父目录回溯
  if (s.includes('\\')) return true;           // Windows 分隔符
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;  // 盘符绝对路径
  if (s.startsWith('~')) return true;          // home 展开
  if (s.startsWith('/')) return true;          // 绝对路径
  return false;
}

// 遍历所有字符串叶子，发现危险路径即返回 true
function anyStringLooksLikePath(obj) {
  if (typeof obj === 'string') return looksLikePath(obj);
  if (Array.isArray(obj)) return obj.some(anyStringLooksLikePath);
  if (isPlainObject(obj)) return Object.values(obj).some(anyStringLooksLikePath);
  return false;
}

function allowedKeysFor(strategy) {
  const base = ['strategy', 'principal', 'startDate', 'endDate', 'video'];
  const extra = Object.keys(WINDOWS[strategy].extra); // e.g. thresholdLow/thresholdHigh
  return new Set([...base, ...extra]);
}

function validateVideo(video) {
  // 缺省 → 使用受支持默认规格
  if (video === undefined || video === null) {
    return { ok: true, value: { resolution: '1920x1080', fps: 30 } };
  }
  if (!isPlainObject(video)) {
    return { ok: false, code: 'E_VIDEO_SPEC', message: 'video 必须是对象' };
  }
  const allowed = new Set(['resolution', 'fps']);
  for (const k of Object.keys(video)) {
    if (!allowed.has(k)) {
      return { ok: false, code: 'E_VIDEO_SPEC', message: `不支持的视频参数：${k}` };
    }
  }
  const resolution = video.resolution === undefined ? '1920x1080' : video.resolution;
  const fps = video.fps === undefined ? 30 : video.fps;
  if (!VIDEO_RESOLUTIONS.includes(resolution)) {
    return { ok: false, code: 'E_VIDEO_SPEC', message: `不支持的分辨率：${resolution}` };
  }
  if (!VIDEO_FPS.includes(fps)) {
    return { ok: false, code: 'E_VIDEO_SPEC', message: `不支持的帧率：${fps}` };
  }
  return { ok: true, value: { resolution, fps } };
}

function validateRatioThreshold(obj) {
  // 阶段 3 锁定：比值轮动阈值已验证为 0.35 / 0.65（与 demo_pending_confirm/manifest.json
  // 及 agent/unified/registry.cjs 完全一致）。封版配置由统一入口逐字节复制，不消费网页阈值，
  // 故严禁客户端提交其他阈值，杜绝“网页改了阈值、实际回测仍用默认”。
  const def = WINDOWS.ratio_band.extra;
  const low = obj.thresholdLow;
  const high = obj.thresholdHigh;
  if (low === undefined && high === undefined) {
    // 缺省 → 使用锁定的封版值
    return { ok: true, value: { thresholdLow: def.thresholdLow, thresholdHigh: def.thresholdHigh } };
  }
  // 若显式提交，必须精确等于锁定值，否则拒绝
  if (typeof low !== 'number' || !Number.isFinite(low) ||
      typeof high !== 'number' || !Number.isFinite(high)) {
    return { ok: false, code: 'E_THRESHOLD_LOCKED', message: '比值轮动阈值必须是数值' };
  }
  if (low !== def.thresholdLow || high !== def.thresholdHigh) {
    return {
      ok: false,
      code: 'E_THRESHOLD_LOCKED',
      message: `比值轮动阈值已锁定为 ${def.thresholdLow} / ${def.thresholdHigh}，不接受其他值`,
    };
  }
  return { ok: true, value: { thresholdLow: def.thresholdLow, thresholdHigh: def.thresholdHigh } };
}

function validatePrincipal(p) {
  if (p === undefined) return { ok: true, value: undefined }; // 用默认值
  if (typeof p !== 'number' || !Number.isFinite(p)) {
    return { ok: false, code: 'E_PRINCIPAL_INVALID', message: '本金必须是有限数字' };
  }
  if (p <= 0) {
    return { ok: false, code: 'E_PRINCIPAL_INVALID', message: '本金必须为正数' };
  }
  if (p < PRINCIPAL_MIN || p > PRINCIPAL_MAX) {
    return {
      ok: false,
      code: 'E_PRINCIPAL_INVALID',
      message: `本金超出合理范围（${PRINCIPAL_MIN} ~ ${PRINCIPAL_MAX}）`,
    };
  }
  return { ok: true, value: p };
}

// 用户 CSV 通道（V0.2 预览）：A/B 两类。
// 与 macd 的差别：没有本金、没有区间、没有视频规格参数——一切由 CSV 内容决定。
// 契约细节全部在 web/src/import/validate.js，这里只做「请求字段白名单 + 归一化装配」。
function validateUserCsvRequest(body, dataClass) {
  for (const k of Object.keys(body)) {
    if (!USER_ALLOWED_FIELDS.has(k)) {
      return { ok: false, code: 'E_UNKNOWN_FIELD', message: `用户 CSV 通道不支持的字段：${k}` };
    }
  }
  const fileName = body.fileName;
  if (typeof fileName === 'string' && /[\\/]|\.\./.test(fileName)) {
    return { ok: false, code: 'E_FORBIDDEN_FIELD', message: 'fileName 只能是文件名本身，不能包含路径' };
  }

  const r = validateImport({
    dataClass,
    csvText: body.csvText,
    mapping: body.mapping,
    title: body.title,
    unit: body.unit,
    asOf: body.asOf,
    sourceNote: body.sourceNote,
    fileName,
    sortByValue: body.sortByValue,
    // C 类专用：证券代码 / 显示名 / 复权口径 / 可选分红表原文
    symbol: body.symbol,
    name: body.name,
    adjust: body.adjust,
    dividendCsvText: body.dividendCsvText,
  });
  if (!r.ok) {
    return { ok: false, code: r.code, message: r.message, line: r.line };
  }

  return {
    ok: true,
    value: {
      strategy: dataClass,
      dataClass,
      title: r.model.meta.title,
      unit: r.model.meta.unit || '',
      asOf: r.model.meta.asOf || '',
      sourceNote: r.model.meta.sourceNote || '',
      fileName: r.model.meta.fileName || '',
      mapping: r.model.meta.mapping || {},
      warnings: (r.warnings || []).map((w) => ({ code: w.code, message: w.message })),
      importModel: r.model,
      // 原始 CSV 文本：由 taskManager 原样落到任务目录 source.csv 并算 SHA-256（留档 + 溯源）。
      // 不进 request.json、不进视频模型之外的任何对外响应。
      sourceText: body.csvText,
      // C 类可选分红表：同样留档为 dividend.csv（独立文件，便于复核）
      dividendSourceText: dataClass === 'stock_ohlc' && typeof body.dividendCsvText === 'string'
        ? body.dividendCsvText : '',
      mode: 'plan-only',
    },
  };
}

// 策略卡通道：把「模板 + 代码 + 区间 + 少量参数」装配成标准策略卡。
// 所有业务校验（模板白名单、主板、日期、资金、参数）在 strategyCard.buildCard 内完成，
// 这里只负责字段白名单与把结果映射成任务层需要的 normalized 结构。
function validateStrategyCardRequest(body) {
  for (const k of Object.keys(body)) {
    if (!STRATEGY_CARD_ALLOWED_FIELDS.has(k)) {
      return { ok: false, code: 'E_UNKNOWN_FIELD', message: `策略卡通道不支持的字段：${k}` };
    }
  }
  const r = strategyCard.buildCard(body);
  if (!r.ok) return r;
  const v = r.value;
  return {
    ok: true,
    value: {
      strategy: 'strategy_card',
      templateId: v.templateId,
      templateName: v.templateName,
      card: v.card,
      // 标题用于工作区摘要；不含任何路径或用户可控输出位置
      title: `${v.card.nameOfSecurity} · ${v.templateName}`,
      startDate: v.card.range.start,
      endDate: v.card.range.end,
      initialCapital: v.card.execution.initialCapital,
      // 可选分红表原文：由 taskManager 留档为 dividend.csv
      dividendSourceText: v.dividendSourceText,
      mode: 'plan-only',
    },
  };
}

// 策略卡通道（自动取数）允许的字段。策略卡本身由 strategyCard.buildCard 装配，
// 不接受客户端直接投递任意 card 对象——避免 additionalProperties 漏网后进入引擎。
const STRATEGY_CARD_ALLOWED_FIELDS = new Set([
  'strategy', 'templateId', 'symbol', 'name', 'startDate', 'endDate',
  'initialCapital', 'params', 'dividendCsvText',
]);

// 主入口：返回 { ok:true, value:{...normalized} } 或 { ok:false, code, message }
function validateTaskRequest(body) {
  if (!isPlainObject(body)) {
    return { ok: false, code: 'E_REQUEST_INVALID', message: '请求体必须是 JSON 对象' };
  }

  // 1) 原型链注入防护
  for (const k of Object.keys(body)) {
    if (PROTO_KEYS.includes(k)) {
      return { ok: false, code: 'E_FORBIDDEN_FIELD', message: `禁止的字段：${k}` };
    }
  }

  // 2) 禁止字段（标识 / 输出目录 / 路径）
  for (const k of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.includes(k)) {
      return { ok: false, code: 'E_FORBIDDEN_FIELD', message: `禁止由客户端指定的字段：${k}` };
    }
  }

  // 3) 危险路径字符串（纵深防御）
  //    csvText 是 CSV 原文，可能合法包含 / \ .. 等字符（例如列值里带路径），
  //    不参与路径扫描——否则一份正常 CSV 会被误判成路径注入。
  const pathScanTarget = Object.assign({}, body);
  delete pathScanTarget.csvText;
  delete pathScanTarget.dividendCsvText; // 分红表原文同理，可能合法含 / \ .. 等字符
  if (anyStringLooksLikePath(pathScanTarget)) {
    return { ok: false, code: 'E_FORBIDDEN_FIELD', message: '请求中包含非法路径字符' };
  }

  // 4) 策略标识（stock_ohlc 已注册，走下面的用户 CSV 分支）
  const strategy = body.strategy;
  if (typeof strategy !== 'string' || !STRATEGY_IDS.includes(strategy)) {
    return {
      ok: false,
      code: 'E_STRATEGY_UNSUPPORTED',
      message: `不支持的策略：${String(strategy)}（可选：${STRATEGY_IDS.join(' / ')}）`,
    };
  }

  // 4.0) 策略卡通道（自动取数）：字段白名单 + 卡片装配
  if (strategy === 'strategy_card') {
    return validateStrategyCardRequest(body);
  }

  // 4.1) 用户 CSV 通道：字段白名单与契约校验都在 validateUserCsvRequest 内完成
  //      （它们的必填项与 macd 完全不同，不能走下面的通用分支）
  if (USER_CLASSES.includes(strategy)) {
    return validateUserCsvRequest(body, strategy);
  }

  // 5) 未知字段（按策略白名单严格比对）
  const allowed = allowedKeysFor(strategy);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) {
      return {
        ok: false,
        code: 'E_UNKNOWN_FIELD',
        message: `策略 ${strategy} 不支持的字段：${k}（当前策略标的已固定，不可指定代码/参数）`,
      };
    }
  }

  // 6) 本金
  const pv = validatePrincipal(body.principal);
  if (!pv.ok) return pv;
  const principal = pv.value !== undefined ? pv.value : WINDOWS[strategy].principalDefault;

  // 7) 日期
  const sd = parseDateStrict(body.startDate);
  if (!sd) {
    return { ok: false, code: 'E_DATE_FORMAT', message: `开始日期格式非法：${String(body.startDate)}（应为 YYYY-MM-DD）` };
  }
  const ed = parseDateStrict(body.endDate);
  if (!ed) {
    return { ok: false, code: 'E_DATE_FORMAT', message: `结束日期格式非法：${String(body.endDate)}（应为 YYYY-MM-DD）` };
  }
  if (body.startDate >= body.endDate) {
    return { ok: false, code: 'E_DATE_ORDER', message: '开始日期必须早于结束日期' };
  }
  const win = WINDOWS[strategy];
  if (body.startDate < win.start || body.endDate > win.end) {
    return {
      ok: false,
      code: 'E_DATE_OUT_OF_RANGE',
      message: `日期超出 ${strategy} 已验证覆盖范围（${win.start} ~ ${win.end}）`,
    };
  }

  // 8) 视频规格
  const vv = validateVideo(body.video);
  if (!vv.ok) return vv;

  // 9) 策略专属
  const normalized = {
    strategy,
    principal,
    startDate: body.startDate,
    endDate: body.endDate,
    video: vv.value,
    symbols: WINDOWS[strategy].fixedCodes.slice(),
    mode: 'plan-only',
  };
  if (strategy === 'ratio_band') {
    const tv = validateRatioThreshold(body);
    if (!tv.ok) return tv;
    normalized.thresholdLow = tv.value.thresholdLow;
    normalized.thresholdHigh = tv.value.thresholdHigh;
  }
  if (strategy === 'macd') {
    // 阶段 4A 参数锁定：放在通用校验之后，保证非法值仍返回原有的精确错误码。
    // 合法但与锁定值不同的参数 → E_PARAM_LOCKED（不宣称支持任意本金/日期）。
    if (principal !== MACD_LOCKED.principal ||
        body.startDate !== MACD_LOCKED.startDate ||
        body.endDate !== MACD_LOCKED.endDate ||
        vv.value.resolution !== MACD_LOCKED.resolution ||
        vv.value.fps !== MACD_LOCKED.fps) {
      return {
        ok: false,
        code: 'E_PARAM_LOCKED',
        message: `MACD 本轮参数已锁定：本金 ${MACD_LOCKED.principal} 元、区间 ${MACD_LOCKED.startDate} ~ ${MACD_LOCKED.endDate}、`
          + `MACD(${MACD_LOCKED.macd.fast},${MACD_LOCKED.macd.slow},${MACD_LOCKED.macd.signal})、`
          + `${MACD_LOCKED.resolution}@${MACD_LOCKED.fps}fps；暂不支持修改`,
      };
    }
    normalized.macd = WINDOWS.macd.macdFixed; // 记录已验证固定参数，供网页展示
  }
  if (strategy === 'dividend_etf') {
    // 阶段 4B 参数锁定：同样放在通用校验之后，保证非法值仍返回原有的精确错误码。
    if (principal !== DIVIDEND_ETF_LOCKED.principal ||
        body.startDate !== DIVIDEND_ETF_LOCKED.startDate ||
        body.endDate !== DIVIDEND_ETF_LOCKED.endDate ||
        vv.value.resolution !== DIVIDEND_ETF_LOCKED.resolution ||
        vv.value.fps !== DIVIDEND_ETF_LOCKED.fps) {
      return {
        ok: false,
        code: 'E_PARAM_LOCKED',
        message: `红利 ETF 本轮参数已锁定：三只 ${DIVIDEND_ETF_LOCKED.codes.join('/')}、每只本金 ${DIVIDEND_ETF_LOCKED.principal} 元、`
          + `区间 ${DIVIDEND_ETF_LOCKED.startDate} ~ ${DIVIDEND_ETF_LOCKED.endDate}、`
          + `${DIVIDEND_ETF_LOCKED.videoVersion} ${DIVIDEND_ETF_LOCKED.resolution}@${DIVIDEND_ETF_LOCKED.fps}fps；`
          + '回测脚本内建该本金且区间由离线归档决定，不会静默忽略网页输入，故暂不支持修改',
      };
    }
    normalized.dividendEtf = {
      codes: DIVIDEND_ETF_LOCKED.codes.slice(),
      perEtfCapital: DIVIDEND_ETF_LOCKED.principal,
      videoVersion: DIVIDEND_ETF_LOCKED.videoVersion,
    };
  }

  return { ok: true, value: normalized };
}

module.exports = {
  STRATEGY_IDS,
  USER_CLASSES,
  WINDOWS,
  VIDEO_RESOLUTIONS,
  VIDEO_FPS,
  PRINCIPAL_MIN,
  PRINCIPAL_MAX,
  MACD_LOCKED,
  DIVIDEND_ETF_LOCKED,
  FORBIDDEN_FIELDS,
  parseDateStrict,
  validateUserCsvRequest,
  validateStrategyCardRequest,
  validateTaskRequest,
};
