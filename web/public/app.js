'use strict';
(function () {
  var serverPill = document.getElementById('env-server');
  var renderPill = document.getElementById('env-render');
  var hint = document.getElementById('strategy-hint');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.strategy-card'));
  var paramsForm = document.getElementById('params-form');
  var createBtn = document.getElementById('create-btn');
  var createResult = document.getElementById('create-result');
  var queryInput = document.getElementById('query-id');
  var queryBtn = document.getElementById('query-btn');
  var queryResult = document.getElementById('query-result');

  var ws = document.getElementById('workspace');
  var wsBadge = document.getElementById('ws-badge');
  var wsSummary = document.getElementById('ws-summary');
  var wsActions = document.getElementById('ws-actions');
  var wsProgress = document.getElementById('ws-progress');
  var wsStatusText = document.getElementById('ws-status-text');
  var wsSteps = document.getElementById('ws-steps');
  var wsVideo = document.getElementById('ws-video');
  var wsVideoEl = document.getElementById('ws-video-el');
  var wsDownload = document.getElementById('ws-download');
  var wsTrace = document.getElementById('ws-trace');
  var wsError = document.getElementById('ws-error');

  var selected = null;
  var currentTaskId = null;
  var pollTimer = null;

  // 用户 CSV 通道（V0.2 预览）：文件内容只在浏览器内存里，不落盘、不上传云端
  var csvState = { text: null, name: '', headers: [] };
  var divState = { text: null, name: '' }; // C 类可选分红表原文（只在内存里）
  var paramsBadge = document.getElementById('params-badge');

  // 各策略表单元数据（默认值来自已验证 sealed 配置）
  var META = {
    strategy_card: {
      name: '策略回测视频（自动取数）',
      cardMode: true,
      executable: true,
      badge: '策略卡 · 自动取数 · 无需 CSV'
    },
    ratio_band: {
      name: '本版未开放（框架占位）',
      symbols: '本版未开放 · 开源 V0.1 仅提供 MACD 模拟演示，不含任何真实行情标的',
      principal: 500000,
      start: '2018-01-01',
      end: '2026-11-06',
      executable: true
    },
    dividend_etf: {
      name: '本版未开放（框架占位）',
      symbols: '本版未开放 · 开源 V0.1 仅提供 MACD 模拟演示，不含任何真实行情标的',
      principal: 100000,
      start: '2020-02-26',
      end: '2026-11-06',
      executable: true,
      locked: true // 阶段 4B：标的/本金/日期/模板全部只读，后端同样锁定
    },
    macd: {
      name: 'MACD 演示策略（SIMULATED 模拟数据）',
      symbols: '模拟演示标的（固定） · MACD(12,26,9) · 非真实行情',
      principal: 100000,
      start: '2016-01-04',
      end: '2026-11-06',
      executable: true,
      locked: true // 阶段 4A：全部参数只读，后端同样锁定
    },
    timeseries: {
      name: '通用时间序列（自己的 CSV）',
      userCsv: true,
      dataClass: 'timeseries',
      executable: true,
      badge: 'V0.2 预览 · 用户 CSV · 折线'
    },
    cross_section: {
      name: '横向对比（自己的 CSV）',
      userCsv: true,
      dataClass: 'cross_section',
      executable: true,
      badge: 'V0.2 预览 · 用户 CSV · 条形'
    },
    stock_ohlc: {
      name: '股票日线（自己的 CSV）',
      userCsv: true,
      dataClass: 'stock_ohlc',
      executable: true,
      badge: 'V0.2 · 用户 CSV · 股票日线 · MACD(12,26,9) → V1.2.3'
    }
  };

  // 目标字段 → 页面标签；alias 只用于「自动猜一次」，用户可随时改
  var CSV_FIELDS = {
    timeseries: [
      { key: 'date', label: '日期（必填）', alias: ['date', '日期', '时间', '交易日', '月份', '年月'] },
      { key: 'value', label: '数值（必填）', alias: ['value', '数值', '值', '金额', '数量', '指标值'] },
      { key: 'series', label: '序列名（可空）', alias: ['series', '序列', '系列', '名称', 'name'] }
    ],
    cross_section: [
      { key: 'label', label: '名称（必填）', alias: ['label', '名称', '标签', '项目', '对象', '渠道', 'name'] },
      { key: 'value', label: '数值（必填）', alias: ['value', '数值', '值', '金额', '数量', '指标值'] },
      { key: 'group', label: '分组（可空）', alias: ['group', '分组', '组别', '类别'] },
      { key: 'value2', label: '对照值（可空）', alias: ['value2', '对照', '上期', '对比值', '第二数值'] }
    ],
    // 股票日线：open/high/low/close 必须映射；volume/amount 可省略（内核不依赖 amount）
    stock_ohlc: [
      { key: 'date', label: '日期（必填）', alias: ['date', '日期', '时间', '交易日'] },
      { key: 'open', label: '开盘价（必填）', alias: ['open', '开盘', '开盘价'] },
      { key: 'high', label: '最高价（必填）', alias: ['high', '最高', '最高价'] },
      { key: 'low', label: '最低价（必填）', alias: ['low', '最低', '最低价'] },
      { key: 'close', label: '收盘价（必填）', alias: ['close', '收盘', '收盘价'] },
      { key: 'volume', label: '成交量（可空）', alias: ['volume', 'vol', '成交量', '量'] },
      { key: 'amount', label: '成交额（可空）', alias: ['amount', 'turnover', '成交额', '成交金额'] }
    ]
  };

  // 策略卡模板（与 web/src/strategyCard.js 的 TEMPLATES 同源；前端只用于展示与表单）
  var CARD_TEMPLATES = {
    close_buy_open_sell: {
      name: '尾盘买入 · 次日开盘卖出',
      desc: 'MACD 金叉当日收盘买入，次日开盘卖出；可选集合竞价跳空过滤（开盘涨幅达到阈值则继续持有）'
    },
    macd_cross: {
      name: 'MACD 金叉买入 · 死叉卖出',
      desc: 'MACD(12,26,9) 金叉次日开盘买入、死叉次日开盘卖出，并与长期持有对照'
    }
  };

  function isoToday() {
    var d = new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }

  function isoYearsAgo(years) {
    var d = new Date();
    d.setFullYear(d.getFullYear() - years);
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setServer(text, cls) {
    serverPill.textContent = text;
    serverPill.className = 'env-pill ' + cls;
  }
  function setRender(text, cls) {
    renderPill.textContent = text;
    renderPill.className = 'env-pill ' + cls;
  }

  function updateEnv(info) {
    if (!info || !info.ok) { setServer('服务器：异常', 'env-bad'); return; }
    var nodeVer = (info.server && info.server.nodeVersion) || '';
    setServer('服务器：运行中 (Node ' + nodeVer + ')', 'env-ok');
    var c = info.checks || {};
    var missing = [];
    if (!c.python || !c.python.available) missing.push('Python');
    if (!c.ffmpeg || !c.ffmpeg.available) missing.push('FFmpeg');
    if (!c.depsDir || !c.depsDir.exists) missing.push('deps');
    if (info.renderEnv && info.renderEnv.ready) setRender('渲染环境：就绪', 'env-ok');
    else setRender('渲染环境：未就绪（缺 ' + missing.join('、') + '）', 'env-warn');
  }

  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  // 一次插入多个并列元素。el() 只返回第一个子节点，把多个 .field 拼在一段 HTML 里
  // 会导致第二个之后的字段被静默丢弃（曾使「结束日期」「单位」等控件整块消失）。
  function els(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    var frag = document.createDocumentFragment();
    while (d.firstChild) frag.appendChild(d.firstChild);
    return frag;
  }

  function buildForm(strategy) {
    var m = META[strategy];
    if (m.userCsv) { buildCsvForm(strategy); return; }
    if (m.cardMode) { buildCardForm(strategy); return; }
    if (paramsBadge) paramsBadge.textContent = 'Open Source V0.1 · 仅 MACD 演示 · 参数锁定';
    var locked = !!m.locked;
    paramsForm.innerHTML = '';
    paramsForm.appendChild(el('<p class="field-note">标的：' + m.symbols + '</p>'));

    if (locked) {
      var lockedNote = strategy === 'macd'
        ? '本轮 MACD 参数已锁定，仅展示不可修改：模拟标的 / 本金 100000 元 / '
          + '2016-01-04 ~ 2026-11-06 / MACD(12,26,9) / 视频 V1.2.2 / 1920×1080@30fps。'
        : '该策略在开源 V0.1 中未开放，仅为通用框架占位，不含任何数据与模板。';
      paramsForm.appendChild(el('<p class="locked-note">' + lockedNote + '</p>'));
    }

    paramsForm.appendChild(el(
      '<div class="field"><label>本金（元）</label>' +
      '<input type="number" id="f-principal" value="' + m.principal + '"'
      + (locked ? ' disabled' : ' min="1000" step="1000"') + ' />' +
      '<span class="field-hint">' + (locked
        ? (strategy === 'dividend_etf' ? '已锁定：每只 100000 元（回测脚本内建）' : '已锁定：100000 元')
        : '有限正数，范围 1000 ~ 100000000') + '</span></div>'
    ));

    paramsForm.appendChild(els(
      '<div class="field"><label>开始日期</label>' +
      '<input type="date" id="f-start" value="' + m.start + '"' + (locked ? ' disabled' : '') + ' /></div>' +
      '<div class="field"><label>结束日期</label>' +
      '<input type="date" id="f-end" value="' + m.end + '"' + (locked ? ' disabled' : '') + ' /></div>'
    ));

    // 比值轮动阈值已锁定（与封版一致），仅展示不可编辑
    if (strategy === 'ratio_band') {
      paramsForm.appendChild(el(
        '<div class="field"><label>信号阈值（比值）</label>' +
        '<input type="text" value="0.35 / 0.65（已锁定）" disabled />' +
        '<span class="field-hint">该策略在开源 V0.1 中未开放</span></div>'
      ));
    }

    if (locked && strategy === 'macd') {
      paramsForm.appendChild(els(
        '<div class="field"><label>MACD 参数</label>' +
        '<input type="text" value="12 / 26 / 9 · 次日开盘成交（已锁定）" disabled /></div>' +
        '<div class="field"><label>视频版本</label>' +
        '<input type="text" value="V1.2.2（封版，已锁定）" disabled /></div>' +
        '<p class="field-hint">示例数据为 SIMULATED 模拟行情（非真实历史数据）。'
        + '区间按随包模拟归档的交易日历解释：2016-01-04 ~ 2026-11-06，'
        + '交易日数量与生成参数见 output/demo_macd_simulated/01_data/DEMO_DATA_MANIFEST.json。</p>'
      ));
    }
    if (locked && strategy === 'dividend_etf') {
      paramsForm.appendChild(el(
        '<p class="field-hint">该策略在开源 V0.1 中未开放，仅为通用框架占位，不含任何行情数据或归档。</p>'
      ));
    }

    paramsForm.appendChild(el('<div class="field"><label>视频规格</label>' +
      '<input type="text" value="1920×1080 @ 30fps（固定）" disabled /></div>'));

    createBtn.disabled = false;
  }

  // 策略卡表单：用户只需要「代码 + 区间 + 模板」，数据由后端自动取。
  // 前端只做「一眼就知道不完整」的拦截（代码位数、日期顺序、资金下限），
  // 主板/参数/门禁的真实校验一律在服务端（strategyCard.buildCard + validateImport）。
  function buildCardForm(strategy) {
    var m = META[strategy];
    csvState = { text: null, name: '', headers: [], encodingBad: false };
    divState = { text: null, name: '' };
    if (paramsBadge) paramsBadge.textContent = m.badge;
    paramsForm.innerHTML = '';
    paramsForm.appendChild(el(
      '<p class="field-note">填好证券与区间，执行时自动从东方财富取<b>未复权</b>日线并回测出片，不需要你准备 CSV。'
      + '本版只支持沪深主板；不提供分红表时，视频会明确标注「不含现金分红」。</p>'
    ));

    paramsForm.appendChild(els(
      '<div class="field"><label>证券代码（必填 · 6 位）</label>' +
      '<input type="text" id="f-symbol" maxlength="6" inputmode="numeric" autocomplete="off" placeholder="例如 600000" />' +
      '<span class="field-hint">仅沪深主板：600/601/603/605、000/001/002/003。创业板 300/301、科创板 688、北交所与 B 股会直接报错。</span></div>' +
      '<div class="field"><label>证券名称（可空）</label>' +
      '<input type="text" id="f-stockname" maxlength="40" placeholder="例如 浦发银行" /></div>'
    ));

    var opts = Object.keys(CARD_TEMPLATES).map(function (k) {
      return '<option value="' + k + '">' + escapeHtml(CARD_TEMPLATES[k].name) + '</option>';
    }).join('');
    paramsForm.appendChild(el(
      '<div class="field field-wide"><label>策略模板</label>' +
      '<select id="f-template">' + opts + '</select>' +
      '<span class="field-hint" id="f-template-desc"></span></div>'
    ));

    paramsForm.appendChild(els(
      '<div class="field"><label>开始日期</label>' +
      '<input type="date" id="f-start" value="' + isoYearsAgo(2) + '" /></div>' +
      '<div class="field"><label>结束日期</label>' +
      '<input type="date" id="f-end" value="' + isoToday() + '" /></div>'
    ));

    paramsForm.appendChild(el(
      '<div class="field"><label>初始资金（元）</label>' +
      '<input type="number" id="f-capital" value="100000" min="10000" step="10000" />' +
      '<span class="field-hint">10000 ~ 100000000；按 100 股整数倍下单，含佣金、印花税、过户费。</span></div>'
    ));

    paramsForm.appendChild(el('<div id="tpl-params"></div>'));

    paramsForm.appendChild(el(
      '<div class="field field-wide"><label>分红表（可空）</label>' +
      '<div class="file-row"><input type="file" id="f-div" accept=".csv,text/csv,text/plain" /></div>' +
      '<span class="field-hint">列：ex_date,record_date,pay_date,cash_per_share[,share_ratio,plan]。'
      + '三个日期不可缺省也不可推导；不传则除权跳空按普通下跌处理并在视频里标注。</span></div>'
    ));

    findEl('f-div').addEventListener('change', onDividendChosen);
    findEl('f-template').addEventListener('change', renderCardTemplateParams);
    renderCardTemplateParams();
    createBtn.disabled = false;
    hint.textContent = '已选择：' + m.name + '。填代码与区间即可创建任务。';
  }

  // 模板参数区随模板切换重绘：不把两套参数混在一张表单里，避免提交无用字段。
  function renderCardTemplateParams() {
    var box = findEl('tpl-params');
    if (!box) return;
    var tpl = findEl('f-template').value;
    var desc = findEl('f-template-desc');
    if (desc) desc.textContent = CARD_TEMPLATES[tpl].desc;
    if (tpl === 'close_buy_open_sell') {
      box.innerHTML = '';
      box.appendChild(els(
        '<div class="field"><label>入场信号</label>' +
        '<select id="f-entry">' +
        '<option value="macd_golden" selected>MACD 金叉当日收盘买入</option>' +
        '<option value="always">每个交易日收盘买入（对照用）</option>' +
        '</select></div>' +
        '<div class="field"><label>开盘跳空持仓阈值（%）</label>' +
        '<input type="number" id="f-hold" min="0" max="20" step="0.1" value="2" />' +
        '<span class="field-hint">次日开盘涨幅 ≥ 阈值时继续持有，否则开盘卖出'
        + '（9:25 集合竞价结果即当日开盘价）。</span></div>'
      ));
    } else {
      box.innerHTML = '<div class="field"><label>MACD 参数</label>'
        + '<input type="text" value="12 / 26 / 9（已锁定）" disabled /></div>';
    }
  }

  function findEl(id) {
    var node = document.getElementById(id);
    return node;
  }

  function buildCsvForm(strategy) {
    var m = META[strategy];
    var isStock = strategy === 'stock_ohlc';
    csvState = { text: null, name: '', headers: [], encodingBad: false };
    divState = { text: null, name: '' };
    if (paramsBadge) paramsBadge.textContent = m.badge || 'V0.2 预览 · 用户 CSV';
    paramsForm.innerHTML = '';
    paramsForm.appendChild(el('<p class="field-note">' + (isStock
      ? '选择一份你自己的股票日线 CSV。工具只做「MACD 金叉买入 / 死叉卖出」回测与出片，'
        + '不推断任何行情、不补缺失交易日、不把缺行当成停牌。'
      : '选择一份你自己的 CSV。数值会被原样画进视频，'
        + '工具不推断收益率、同比等任何统计量。列名不固定——下面把文件里的列名映射到字段即可。') + '</p>'));

    paramsForm.appendChild(el(
      '<div class="field field-wide"><label>' + (isStock ? '日线 CSV' : 'CSV 文件')
      + '（≤ 2 MiB · UTF-8 · 逗号分隔）</label>' +
      '<div class="file-row"><input type="file" id="f-csv" accept=".csv,text/csv,text/plain" />' +
      '<button type="button" id="f-csv-reset" class="ghost-btn" disabled>重新选择</button></div>' +
      '<span class="field-hint">首行必须是表头。文件只在本机读取，不上传云端；创建任务后原文件会留档在任务目录里，供日后核对。</span></div>'
    ));

    if (isStock) {
      // 证券信息：内核按 10% 算涨跌停并判定一字板，不知道代码就无法保证结果可信，
      // 所以代码必填；板块限制与后端 support_guard 同源，前端只做同款提示。
      paramsForm.appendChild(els(
        '<div class="field"><label>证券代码（必填 · 6 位）</label>' +
        '<input type="text" id="f-symbol" maxlength="6" inputmode="numeric" autocomplete="off" placeholder="例如 600000" />' +
        '<span class="field-hint">仅沪深主板：600/601/603/605、000/001/002/003。创业板 300/301、科创板 688、北交所与 B 股会直接报错。</span></div>' +
        '<div class="field"><label>证券名称（可空）</label>' +
        '<input type="text" id="f-stockname" maxlength="40" placeholder="例如 我的标的" /></div>'
      ));
      paramsForm.appendChild(els(
        '<div class="field"><label>价格复权口径</label>' +
        '<select id="f-adjust">' +
        '<option value="none" selected>未复权（唯一支持）</option>' +
        '<option value="qfq" disabled>前复权 qfq（暂不支持）</option>' +
        '<option value="hfq" disabled>后复权 hfq（暂不支持）</option>' +
        '</select><span class="field-hint">复权价是合成价：回测会把它当真实成交价算金额、佣金、印花税和整手股数，'
        + '得到的金额与收益率不对应真实账户，所以本版只接受未复权行情 + 分红表。'
        + '复权口径要等成交价口径单独验收通过后才放开。</span></div>' +
        '<div class="field"><label>分红表（可空）</label>' +
        '<div class="file-row"><input type="file" id="f-div" accept=".csv,text/csv,text/plain" /></div>' +
        '<span class="field-hint">列：ex_date,record_date,pay_date,cash_per_share[,share_ratio,plan]。三个日期不可缺省也不可推导；不传则除权跳空按普通下跌处理并在视频里标注。</span></div>'
      ));
      paramsForm.appendChild(el(
        '<div class="field field-wide"><label>数据来源说明（可空，会写进视频页脚）</label>' +
        '<input type="text" id="f-srcnote" maxlength="120" placeholder="例如：券商客户端导出 / 内部整理" /></div>'
      ));
      findEl('f-div').addEventListener('change', onDividendChosen);
    } else {
      paramsForm.appendChild(els(
        '<div class="field"><label>视频标题</label>' +
        '<input type="text" id="f-title" maxlength="80" placeholder="例如：月度产能利用率" /></div>' +
        '<div class="field"><label>单位（可空）</label>' +
        '<input type="text" id="f-unit" maxlength="16" placeholder="例如：% 或 元" /></div>'
      ));
      if (strategy === 'cross_section') {
        paramsForm.appendChild(el('<div class="field"><label>数据时点（可空）</label><input type="date" id="f-asof" /></div>'));
      }
      paramsForm.appendChild(el(
        '<div class="field field-wide"><label>数据来源说明（可空，会写进视频页脚）</label>' +
        '<input type="text" id="f-srcnote" maxlength="120" placeholder="例如：内部测算 / 公开月报" /></div>'
      ));
    }

    paramsForm.appendChild(el('<p class="warn-box" id="csv-warn" hidden></p>'));
    paramsForm.appendChild(el('<div class="mapping-grid" id="map-grid" hidden><p class="mapping-title">列映射（文件里的列名 → 字段）</p><p class="map-status" id="map-status"></p></div>'));
    paramsForm.appendChild(el('<pre class="csv-preview" id="csv-preview" hidden></pre>'));

    findEl('f-csv').addEventListener('change', onCsvChosen);
    findEl('f-csv-reset').addEventListener('click', resetCsvChoice);
    if (isStock) {
      findEl('f-symbol').addEventListener('input', updateMappingState);
      updateMappingState();
    }
    createBtn.disabled = true;
    hint.textContent = '已选择：' + m.name + '。请先选择 CSV 文件。';
  }

  // 分红表：单独读一遍，只保留原文；真正的列校验在服务端（要带行号报错）
  function onDividendChosen(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) { divState = { text: null, name: '' }; return; }
    if (file.size > 2 * 1024 * 1024) {
      divState = { text: null, name: '' };
      ev.target.value = '';
      showResult(createResult, false, '分红表 ' + (file.size / 1048576).toFixed(2) + ' MiB 超过 2 MiB 上限。');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      if (text.indexOf('\uFFFD') >= 0) {
        divState = { text: null, name: '' };
        showResult(createResult, false, '分红表不是 UTF-8 编码，请另存为 UTF-8 后重新选择。');
        return;
      }
      divState = { text: text, name: file.name };
      showResult(createResult, true, '已读取分红表 ' + file.name + '，将在创建任务时一并校验。');
    };
    reader.readAsText(file, 'utf-8');
  }

  // 「重新选择」：清掉文件与映射状态，但保留标题/单位/来源等已填内容，
  // 让用户不必因为选错一个文件就从头填一遍。
  function resetCsvChoice() {
    csvState = { text: null, name: '', headers: [], encodingBad: false };
    divState = { text: null, name: '' };
    var file = findEl('f-csv');
    if (file) file.value = '';
    var divFile = findEl('f-div');
    if (divFile) divFile.value = '';
    var grid = findEl('map-grid');
    if (grid) { grid.hidden = true; grid.innerHTML = '<p class="mapping-title">列映射（文件里的列名 → 字段）</p>' + '<p class="map-status" id="map-status"></p>'; }
    var pre = findEl('csv-preview');
    if (pre) { pre.hidden = true; pre.textContent = ''; pre.className = 'csv-preview'; }
    var warn = findEl('csv-warn');
    if (warn) { warn.hidden = true; warn.textContent = ''; }
    var reset = findEl('f-csv-reset');
    if (reset) reset.disabled = true;
    createBtn.disabled = true;
    showResult(createResult, true, '已清除所选文件，请重新选择。');
  }

  function parseHeaderLine(text) {
    var line = String(text || '').split(/\r\n|\n|\r/)[0] || '';
    if (line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
    var out = [];
    var cur = '';
    var q = false;
    for (var i = 0; i < line.length; i += 1) {
      var ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i += 1; } else { q = false; }
        } else { cur += ch; }
      } else if (ch === '"') { q = true; }
      else if (ch === ',') { out.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    out.push(cur.trim());
    return out.filter(function (x) { return x !== ''; });
  }

  function guessColumn(headers, aliases) {
    var lower = headers.map(function (h) { return h.trim().toLowerCase(); });
    for (var i = 0; i < aliases.length; i += 1) {
      var idx = lower.indexOf(String(aliases[i]).toLowerCase());
      if (idx >= 0) return headers[idx];
    }
    return '';
  }

  // 区分「文件表头里根本没有这类列」与「文件里有可识别的列但用户还没映射」。
  // 用同一份 alias 表判断，保证前端提示与后端 resolveMapping 的判定一致。
  function hasAliasColumn(fieldKey) {
    var fields = CSV_FIELDS[selected] || [];
    var field = fields.filter(function (f) { return f.key === fieldKey; })[0];
    if (!field) return false;
    return !!guessColumn(csvState.headers, field.alias);
  }

  function buildMappingUI(strategy) {
    var grid = findEl('map-grid');
    if (!grid) return;
    grid.innerHTML = '<p class="mapping-title">列映射（文件里的列名 → 字段）</p>'
      + '<p class="map-status" id="map-status"></p>';
    var fields = CSV_FIELDS[strategy] || [];
    fields.forEach(function (f) {
      var guess = guessColumn(csvState.headers, f.alias);
      var opts = ['<option value="">（不指定）</option>'].concat(csvState.headers.map(function (h) {
        return '<option value="' + escapeHtml(h) + '"' + (h === guess ? ' selected' : '') + '>' + escapeHtml(h) + '</option>';
      })).join('');
      var box = el('<div class="field"><label>' + f.label + '</label>'
        + '<select data-field="' + f.key + '" data-required="' + (f.label.indexOf('必填') >= 0 ? '1' : '0') + '">'
        + opts + '</select></div>');
      var sel = box.querySelector('select');
      sel.addEventListener('change', updateMappingState);
      grid.appendChild(box);
    });
    grid.hidden = false;
    updateMappingState();
  }

  // 映射的即时反馈：必填没选 / 同一列被用两次 / 有列没用上，都在这里当场说清楚，
  // 不用等提交后才看到一条错误（旧版要点了「创建任务」才知道漏选）。
  function updateMappingState() {
    var status = findEl('map-status');
    var selects = Array.prototype.slice.call(document.querySelectorAll('#map-grid select'));
    if (!selects.length) { if (status) status.textContent = ''; return; }
    var unmapped = [];  // 文件里有常用列名，但用户还没把它选给这个字段
    var absent = [];    // 文件表头里找不到这类列名（也没有可自动识别的同义列）
    var used = {};
    var dup = [];
    selects.forEach(function (s) {
      var label = s.parentNode.querySelector('label').textContent.replace('（必填）', '').replace('（可空）', '');
      s.classList.remove('field-bad');
      if (!s.value) {
        if (s.getAttribute('data-required') === '1') {
          (hasAliasColumn(s.getAttribute('data-field')) ? unmapped : absent).push(label);
          s.classList.add('field-bad');
        }
        return;
      }
      if (used[s.value]) {
        dup.push('「' + s.value + '」被「' + used[s.value] + '」和「' + label + '」同时选中');
        s.classList.add('field-bad');
      } else {
        used[s.value] = label;
      }
    });
    var extra = csvState.headers.filter(function (h) { return !used[h]; });
    var stockErr = selected === 'stock_ohlc' ? stockMetaError() : '';

    var msgs = [];
    if (csvState.encodingBad) {
      msgs.push('文件编码不是 UTF-8，已暂停创建（见上方提示）。');
    } else {
      if (absent.length) {
        msgs.push('文件表头里没有识别到：' + absent.join('、') + '。请检查导出的列是否齐全；'
          + '如果用了别的列名，也可以直接在上方映射里选它。');
      }
      if (unmapped.length) {
        msgs.push('文件里有对应列但还没映射：' + unmapped.join('、') + '。请在上方为它选中一列。');
      }
      if (dup.length) {
        msgs.push(dup.join('；') + '。一列只能当一个字段用。');
      }
      if (!absent.length && !unmapped.length && !dup.length) {
        msgs.push('映射完整，可以创建任务。');
        if (extra.length) msgs.push('未使用的列会被忽略：' + extra.join('、'));
      }
    }
    if (stockErr) msgs.push(stockErr);
    if (status) {
      status.textContent = msgs.join(' ');
      status.className = 'map-status '
        + (absent.length || unmapped.length || dup.length || csvState.encodingBad || stockErr ? 'bad' : 'ok');
    }
    createBtn.disabled = !csvState.text || !!csvState.encodingBad
      || absent.length > 0 || unmapped.length > 0 || dup.length > 0 || !!stockErr;
  }

  // 股票日线的前置元数据：代码必填且必须是 6 位数字。板块/复权/分红的真实校验在服务端，
  // 这里只拦「一眼就知道不完整」的输入，免得多跑一次请求。
  function stockMetaError() {
    var sym = findEl('f-symbol');
    if (!sym) return '';
    var v = String(sym.value || '').trim();
    sym.classList.remove('field-bad');
    if (!v) { sym.classList.add('field-bad'); return '请填写 6 位证券代码（内核要用它算涨跌停）。'; }
    if (!/^\d{6}$/.test(v)) { sym.classList.add('field-bad'); return '证券代码必须是 6 位数字。'; }
    return '';
  }

  function onCsvChosen(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var warn = findEl('csv-warn');
    var reset = findEl('f-csv-reset');
    if (reset) reset.disabled = false;
    if (file.size > 2 * 1024 * 1024) {
      csvState = { text: null, name: '', headers: [], encodingBad: false };
      createBtn.disabled = true;
      if (warn) {
        warn.hidden = false;
        warn.textContent = '文件 ' + (file.size / 1048576).toFixed(2)
          + ' MiB 超过 2 MiB 上限。请先截取需要的区间后重传。';
      }
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      // FileReader 按 UTF-8 解码；GBK/GB18030 文件会得到 U+FFFD 替换符。
      // 这是中文 Windows 上 Excel「另存为 CSV」的默认编码，属于最高频的真实入口，
      // 所以必须在预览阶段就说清楚，而不是等提交后返回 E_ENCODING。
      var encodingBad = text.indexOf('\uFFFD') >= 0;
      csvState = {
        text: text,
        name: file.name,
        headers: encodingBad ? [] : parseHeaderLine(text),
        encodingBad: encodingBad
      };
      var lines = text.split(/\r\n|\n|\r/);
      var pre = findEl('csv-preview');
      if (pre) {
        pre.hidden = false;
        pre.className = 'csv-preview' + (encodingBad ? ' garbled' : '');
        pre.textContent = lines.slice(0, 4).join('\n') + (lines.length > 4 ? '\n…' : '');
      }
      if (warn) {
        if (encodingBad) {
          warn.hidden = false;
          warn.textContent = '这份文件不是 UTF-8 编码（很可能是 GBK，中文 Windows 上 Excel「另存为 CSV」的默认格式），'
            + '上面的预览已经是乱码，继续下去只会得到乱码标题。请在 Excel 里选「另存为 → CSV UTF-8（逗号分隔）」，'
            + '或用记事本「另存为 → 编码：UTF-8」后重新选择文件。';
        } else {
          warn.hidden = true;
          warn.textContent = '';
        }
      }
      if (encodingBad) {
        if (findEl('map-grid')) findEl('map-grid').hidden = true;
        createBtn.disabled = true;
        showResult(createResult, false, '已暂停：文件编码不是 UTF-8，请按上方提示另存后重试。');
        return;
      }
      buildMappingUI(selected);
      // 不要把按钮直接置为可用：buildMappingUI 内部已按「必填是否选全」算过一次
      showResult(createResult, true, '已读取 ' + file.name + '（' + (file.size / 1024).toFixed(1)
        + ' KB，' + csvState.headers.length + ' 列）。请确认下方列映射后创建任务。');
    };
    reader.onerror = function () { showResult(createResult, false, '读取文件失败，请重试。'); };
    reader.readAsText(file, 'utf-8');
  }

  function selectStrategy(strategy) {
    selected = strategy;
    cards.forEach(function (c) {
      c.classList.toggle('selected', c.getAttribute('data-strategy') === strategy);
    });
    hint.textContent = '已选择：' + META[strategy].name + '。填写参数后点击「创建任务」。';
    buildForm(strategy);
    createResult.textContent = '';
  }

  function collectRequest() {
    var m = META[selected];
    if (m && m.cardMode) {
      var symEl0 = findEl('f-symbol');
      var symbol = String(symEl0 && symEl0.value || '').trim();
      if (!/^\d{6}$/.test(symbol)) throw new Error('请填写 6 位证券代码');
      var tpl = findEl('f-template').value;
      var start = findEl('f-start').value;
      var end = findEl('f-end').value;
      if (!start || !end) throw new Error('请填写开始与结束日期');
      if (start >= end) throw new Error('开始日期必须早于结束日期');
      var cap = Number(findEl('f-capital').value);
      if (!isFinite(cap) || cap < 10000) throw new Error('初始资金需不少于 10000 元');
      var req0 = {
        strategy: 'strategy_card',
        templateId: tpl,
        symbol: symbol,
        startDate: start,
        endDate: end,
        initialCapital: cap
      };
      var nmEl = findEl('f-stockname');
      if (nmEl && nmEl.value.trim()) req0.name = nmEl.value.trim();
      var params = {};
      if (tpl === 'close_buy_open_sell') {
        var entryEl = findEl('f-entry');
        if (entryEl) params.entrySignal = entryEl.value;
        var holdEl = findEl('f-hold');
        if (holdEl && String(holdEl.value).trim() !== '') {
          var hv = Number(holdEl.value);
          if (!isFinite(hv) || hv < 0 || hv > 20) throw new Error('开盘跳空阈值需在 0 ~ 20% 之间');
          params.holdIfGte = hv / 100;
        }
      }
      if (Object.keys(params).length) req0.params = params;
      if (divState.text) req0.dividendCsvText = divState.text;
      return req0;
    }
    if (m && m.userCsv) {
      if (csvState.encodingBad) throw new Error('文件编码不是 UTF-8，请先另存为 UTF-8 再选择');
      if (!csvState.text) throw new Error('请先选择 CSV 文件');
      var req = { strategy: selected, csvText: csvState.text, fileName: csvState.name };
      var t = findEl('f-title');
      if (t && t.value.trim()) req.title = t.value.trim();
      var u = findEl('f-unit');
      if (u && u.value.trim()) req.unit = u.value.trim();
      var a = findEl('f-asof');
      if (a && a.value) req.asOf = a.value;
      var sn = findEl('f-srcnote');
      if (sn && sn.value.trim()) req.sourceNote = sn.value.trim();
      var mapping = {};
      Array.prototype.forEach.call(document.querySelectorAll('#map-grid select'), function (s) {
        if (s.value) mapping[s.getAttribute('data-field')] = s.value;
      });
      if (Object.keys(mapping).length) req.mapping = mapping;

      // 股票日线：代码 / 名称 / 复权口径 / 可选分红表
      if (selected === 'stock_ohlc') {
        var symEl = findEl('f-symbol');
        var symbol = String(symEl && symEl.value || '').trim();
        if (!/^\d{6}$/.test(symbol)) throw new Error('请填写 6 位证券代码');
        req.symbol = symbol;
        var nameEl = findEl('f-stockname');
        if (nameEl && nameEl.value.trim()) req.name = nameEl.value.trim();
        var adjEl = findEl('f-adjust');
        req.adjust = adjEl ? adjEl.value : 'none';
        if (divState.text) req.dividendCsvText = divState.text;
      }
      return req;
    }
    var req2 = {
      strategy: selected,
      principal: Number(document.getElementById('f-principal').value),
      startDate: document.getElementById('f-start').value,
      endDate: document.getElementById('f-end').value
    };
    return req2;
  }

  function showResult(node, ok, text) {
    node.className = 'result ' + (ok ? 'ok' : 'bad');
    node.textContent = text;
  }

  function onCreate() {
    if (!selected) return;
    var req;
    try { req = collectRequest(); }
    catch (e) { showResult(createResult, false, e.message || '表单读取失败'); return; }

    createBtn.disabled = true;
    createResult.className = 'result';
    createResult.textContent = '提交中…';

    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 201 && res.body.ok) {
          var msg = '任务已创建 ✓\n任务 ID：' + res.body.taskId + '\n状态：' + res.body.status;
          // 「通过但有警告」必须在生成视频前就让用户看到（契约 §6.2）
          if (res.body.warnings && res.body.warnings.length) {
            msg += '\n\n数据提示（' + res.body.warnings.length + ' 项，视频里也会标注）：\n'
              + res.body.warnings.map(function (w) { return '· ' + w.message; }).join('\n');
          }
          showResult(createResult, true, msg);
          loadTaskIntoWorkspace(res.body.taskId);
        } else {
          // 用户能读懂的部分放最前，英文错误码只作为「反馈时提供」的技术标识，
          // 不再把内部字段名（date / value）当成给用户看的提示。
          var parts = ['没能生成任务：' + (res.body.message || '未知错误')];
          if (res.body.line) parts.push('定位：文件第 ' + res.body.line + ' 行');
          if (res.body.code) parts.push('技术代码 ' + res.body.code + '（反馈时请提供）');
          showResult(createResult, false, parts.join('\n'));
          if (res.body.missing && res.body.missing.length) highlightMissing(res.body.missing);
        }
      })
      .catch(function () { showResult(createResult, false, '无法连接服务器'); })
      .finally(function () {
        // 恢复按钮状态时必须重新走一遍映射校验，否则「必填没选」的按钮会被重新点亮
        if (META[selected] && META[selected].userCsv) updateMappingState();
        else createBtn.disabled = false;
      });
  }

  function highlightMissing(fields) {
    Array.prototype.forEach.call(document.querySelectorAll('#map-grid select'), function (s) {
      if (fields.indexOf(s.getAttribute('data-field')) >= 0) s.classList.add('field-bad');
    });
  }

  // ---- 工作区渲染 ----

  function loadTaskIntoWorkspace(taskId) {
    currentTaskId = taskId;
    ws.hidden = false;
    fetch('/api/tasks/' + encodeURIComponent(taskId))
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 200 && res.body.ok) {
          renderWorkspace(res.body.task);
        } else {
          wsBadge.textContent = '查询失败';
          showWsError('查询失败（' + (res.body.code || res.status) + '）：' + (res.body.message || ''));
        }
      })
      .catch(function () { showWsError('无法连接服务器'); });
  }

  function renderWorkspace(task) {
    var m = META[task.strategy] || { name: task.strategy, executable: false };
    wsBadge.textContent = task.status;

    if (task.strategy === 'strategy_card') {
      var r0 = task.result || null;
      var h0 = '<div><b>任务 ID</b>：' + task.taskId + '</div>'
        + '<div><b>策略模板</b>：' + escapeHtml(task.templateName || task.templateId || '') + '</div>'
        + '<div><b>证券</b>：' + escapeHtml(task.name || '') + '（' + escapeHtml(task.symbol || '') + '）</div>'
        + '<div><b>区间</b>：' + escapeHtml(task.startDate || '') + ' → ' + escapeHtml(task.endDate || '') + '</div>'
        + '<div><b>初始资金</b>：¥ ' + Number(task.initialCapital || 0).toLocaleString('en-US') + '</div>'
        + '<div><b>状态</b>：' + task.status + '</div>';
      if (task.dividend) {
        h0 += '<div><b>分红表</b>：已提供 · sha256:' + String(task.dividend.sha256 || '').slice(0, 12) + '…</div>';
      }
      if (r0) {
        if (r0.period) {
          h0 += '<div><b>实际区间</b>：' + r0.period.start + ' → ' + r0.period.end
            + '（' + r0.marketDays + ' 个交易日）</div>';
        }
        if (r0.rangeAdjust) {
          h0 += '<div><b>区间收敛</b>：请求终点 ' + escapeHtml(r0.rangeAdjust.requestedEnd)
            + ' → 实际 ' + escapeHtml(r0.rangeAdjust.effectiveEnd)
            + '（' + escapeHtml(r0.rangeAdjust.reason) + '）</div>';
        }
        if (r0.final != null) {
          h0 += '<div><b>期末资产</b>：¥ ' + Number(r0.final).toLocaleString('en-US', { maximumFractionDigits: 2 })
            + ' · 收益 ' + (Number(r0.totalReturn || 0) * 100).toFixed(2) + '%'
            + ' · 最大回撤 ' + (Number(r0.maxDD || 0) * 100).toFixed(2) + '%'
            + ' · ' + r0.trades + ' 笔交易</div>';
        }
        if (r0.holdFinal != null) {
          h0 += '<div><b>同期长期持有</b>：¥ ' + Number(r0.holdFinal).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '</div>';
        }
        if (r0.source) {
          h0 += '<div><b>数据</b>：' + (r0.source.kind === 'EASTMONEY_PUSH2HIS' ? '东方财富未复权日线' : escapeHtml(r0.source.kind || ''))
            + ' · 取数 ' + r0.source.fetchStart + ' → ' + r0.source.fetchEnd
            + ' · ' + r0.source.bars + ' 根（预热 ' + r0.source.warmupBars + ' / 展示 ' + r0.source.displayBars + '）'
            + ' · csv sha256:' + String(r0.source.csvSha256 || '').slice(0, 12) + '…</div>';
          if (r0.source.excludedUnclosedDate) {
            h0 += '<div><b>已剔除未收盘日</b>：' + r0.source.excludedUnclosedDate + '</div>';
          }
          if (r0.source.warnings && r0.source.warnings.length) {
            h0 += '<div><b>数据提示</b>：' + r0.source.warnings.map(function (w) {
              return escapeHtml(w.message);
            }).join('；') + '</div>';
          }
        }
        if (r0.video) {
          h0 += '<div><b>视频</b>：' + r0.video.width + '×' + r0.video.height + ' @ ' + r0.video.fps
            + 'fps · ' + r0.video.durationSec + 's · ' + r0.video.frames + ' 帧</div>';
          if (r0.video.sha256) {
            h0 += '<div><b>视频指纹</b>：sha256:' + r0.video.sha256.slice(0, 12)
              + '…（同一份数据重复出片应完全一致）</div>';
          }
        }
        if (r0.verification && r0.verification.pass != null) {
          h0 += '<div><b>独立验收</b>：' + escapeHtml(r0.verification.script || '')
            + ' · PASS ' + r0.verification.pass + ' / ' + r0.verification.total + '</div>';
        }
        if (r0.trace) {
          h0 += '<div><b>溯源</b>：' + r0.trace.verified + ' / ' + r0.trace.points
            + ' 个数据点已回读核对到留档 CSV 的具体行号</div>';
        }
      }
      if (task.status === 'success') {
        h0 += '<div><b>留档</b>：<a href="/api/tasks/' + encodeURIComponent(task.taskId)
          + '/source">下载本次实际使用的日线 CSV</a></div>';
      }
      wsSummary.innerHTML = h0;
    } else if (task.dataClass) {
      // 用户 CSV：没有本金/区间，展示数据类别、标题、来源文件指纹、行数与数据提示
      var clsNames = { timeseries: '通用时间序列', cross_section: '横向对比', stock_ohlc: '股票日线（USER_IMPORT）' };
      var clsName = clsNames[task.dataClass] || task.dataClass;
      var html = '<div><b>任务 ID</b>：' + task.taskId + '</div>'
        + '<div><b>数据类别</b>：' + clsName + '</div>'
        + '<div><b>' + (task.dataClass === 'stock_ohlc' ? '证券' : '标题') + '</b>：'
        + escapeHtml(task.title || '（未命名）') + '</div>'
        + '<div><b>状态</b>：' + task.status + '</div>';
      if (task.source) {
        html += '<div><b>源文件</b>：' + escapeHtml(task.source.fileName || '（未命名）')
          + ' · 文本 ' + task.source.lines + ' 行（含表头'
          + (task.source.dataLines != null ? '，' + task.source.dataLines + ' 条数据记录' : '') + '）'
          + ' · ' + task.source.bytes + ' 字节'
          + ' · sha256:' + String(task.source.sha256 || '').slice(0, 12) + '…</div>';
      }
      if (task.dividend) {
        html += '<div><b>分红表</b>：' + escapeHtml(task.dividend.fileName || 'dividend.csv')
          + ' · 文本 ' + task.dividend.lines + ' 行（含表头'
          + (task.dividend.dataLines != null ? '，' + task.dividend.dataLines + ' 条数据记录' : '') + '）'
          + ' · sha256:'
          + String(task.dividend.sha256 || '').slice(0, 12) + '…</div>';
      }
      if (task.warnings && task.warnings.length) {
        html += '<div><b>数据提示</b>：' + task.warnings.map(function (w) {
          return escapeHtml(w.message);
        }).join('；') + '</div>';
      }
      if (task.result) {
        if (task.result.rowCount != null) html += '<div><b>数据行数</b>：' + task.result.rowCount + '</div>';
        if (task.result.source && task.result.source.kind === 'USER_IMPORT') {
          var src = task.result.source;
          html += '<div><b>来源</b>：USER_IMPORT · ' + escapeHtml(src.fileName || '')
            + ' · 复权口径 ' + escapeHtml(src.adjust || 'none')
            + ' · ' + (src.hasDividends ? ('现金分红 ' + src.dividendCount + ' 次') : '未含分红')
            + ' · 日历缺口 ' + ((src.calendarGaps || []).length) + ' 处</div>';
        }
        if (task.result.trace) {
          html += '<div><b>溯源</b>：' + task.result.trace.verified + ' / ' + task.result.trace.points
            + ' 个数据点已回读核对到 source.csv 的具体行号</div>';
        }
        if (task.result.video) {
          html += '<div><b>视频</b>：' + task.result.video.width + '×' + task.result.video.height
            + ' @ ' + task.result.video.fps + 'fps · ' + task.result.video.durationSec
            + 's · ' + task.result.video.frames + ' 帧</div>';
          if (task.result.video.sha256) {
            html += '<div><b>视频指纹</b>：sha256:' + task.result.video.sha256.slice(0, 12) + '…'
              + '（同一份数据重复出片应完全一致）</div>';
          }
        }
        if (task.result.verification && task.result.verification.pass != null) {
          html += '<div><b>独立验收</b>：' + escapeHtml(task.result.verification.script || '')
            + ' · PASS ' + task.result.verification.pass + ' / FAIL ' + task.result.verification.fail + '</div>';
        }
      }
      wsSummary.innerHTML = html;
    } else {
      wsSummary.innerHTML =
        '<div><b>任务 ID</b>：' + task.taskId + '</div>' +
        '<div><b>策略</b>：' + m.name + '</div>' +
        '<div><b>本金</b>：¥ ' + Number(task.principal || 0).toLocaleString('en-US') + '</div>' +
        '<div><b>区间</b>：' + task.startDate + ' → ' + task.endDate + '</div>' +
        '<div><b>状态</b>：' + task.status + '</div>';
    }

    // 失败统一提示「请新建任务重试」（避免重复 runId 覆盖 / plan 冲突）
    if (task.status === 'failed' && task.error) {
      var msg = '执行失败（' + task.error.code + '）：' + task.error.message;
      if (task.error.missing && task.error.missing.length) {
        msg += '\n缺少文件：' + task.error.missing.join('、');
      }
      if (task.error.failures && task.error.failures.length) {
        msg += '\n未通过的检查项（明细见任务目录 accept_failures.json）：\n'
          + task.error.failures.map(function (f) {
            return '· ' + f.name + (f.detail ? '（' + f.detail + '）' : '');
          }).join('\n');
      }
      msg += '\n' + (task.error.hint || '请新建任务重试');
      showWsError(msg);
    } else {
      hideWsError();
    }

    // 动作区
    wsActions.innerHTML = '';
    if (task.status === 'queued' && m.executable) {
      var btn = el('<button id="exec-btn" type="button">确认并生成视频</button>');
      btn.addEventListener('click', onExecute);
      wsActions.appendChild(btn);
    } else if (task.status === 'queued' && !m.executable) {
      wsActions.appendChild(el('<p class="reserved-note">该策略当前仅支持计划创建，暂不可执行。</p>'));
    } else if (task.status === 'failed') {
      wsActions.appendChild(el('<p class="reserved-note">此任务已失败，请新建任务重试。</p>'));
    } else if (task.status === 'running') {
      wsActions.appendChild(el('<p class="reserved-note">正在执行，请稍候…</p>'));
    } else if (task.status === 'success') {
      wsActions.appendChild(el('<p class="ok-note">✓ 视频已生成，可在下方预览 / 下载。</p>'));
    }
    // 删除任务：会同时删掉任务目录（source.csv / 视频 / 日志）与运行目录，需两次点击确认
    if (task.status !== 'running') wsActions.appendChild(makeDeleteButton(task.taskId));

    // 进度 / 视频：终态也要保留步骤清单，只是按成功/失败改标签，避免残留「进行中」
    if (task.status === 'running') {
      showProgress(task, 'running');
      startPolling();
    } else {
      stopPolling();
      if (task.status === 'success' || task.status === 'failed') {
        showProgress(task, task.status);
      } else {
        hideProgress();
      }
      if (task.status === 'success' && task.mp4) showVideo(task);
      else hideVideo();
    }

    renderTrace(task);
  }

  // 删除任务：第一次点击变成「确认删除」，第二次才真正请求 DELETE。
  // 不用 window.confirm —— 原生弹窗在无头/自动化环境里会阻塞，也不好写一致文案。
  function makeDeleteButton(taskId) {
    var btn = el('<button class="danger-btn" type="button">删除任务</button>');
    var armed = false;
    btn.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        btn.textContent = '再点一次确认删除（含原始 CSV 与视频）';
        btn.classList.add('armed');
        return;
      }
      btn.disabled = true;
      btn.textContent = '删除中…';
      fetch('/api/tasks/' + encodeURIComponent(taskId), { method: 'DELETE' })
        .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
        .then(function (res) {
          if (res.status === 200 && res.body.ok) {
            ws.hidden = true;
            wsTrace.hidden = true;
            wsTrace.innerHTML = '';
            hideVideo();
            hideProgress();
            currentTaskId = null;
            showResult(createResult, true,
              '任务已删除。任务目录（原始 CSV、视频、日志）与运行目录都已清理，磁盘上没有残留。');
          } else {
            btn.disabled = false;
            armed = false;
            btn.classList.remove('armed');
            btn.textContent = '删除任务';
            showWsError('删除失败：' + (res.body.message || res.body.code || res.status));
          }
        })
        .catch(function () {
          btn.disabled = false;
          armed = false;
          btn.classList.remove('armed');
          btn.textContent = '删除任务';
          showWsError('无法连接服务器，删除未执行');
        });
    });
    return btn;
  }

  // 溯源面板：列出「画面上的数字 ← 源文件第几行」，并给出原始 CSV 下载入口
  function renderTrace(task) {
    wsTrace.hidden = true;
    wsTrace.innerHTML = '';
    // 策略卡任务同样有留档 CSV 与逐行溯源，只是没有 dataClass 字段
    if (task.status !== 'success') return;
    if (!task.dataClass && task.strategy !== 'strategy_card') return;
    fetch('/api/tasks/' + encodeURIComponent(task.taskId) + '/traceability')
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (!body.ok || !body.traceability) return;
        var tr = body.traceability;
        var v = tr.verification || {};
        var rows = (tr.trace || []).slice(0, 8).map(function (t) {
          var pos = t.kind === 'bar' ? t.label : (t.series + ' · ' + t.date);
          var at = t.sourceFile === 'dividend.csv' ? '分红表第 ' : '第 ';
          return '<tr><td>' + at + t.sourceLine + ' 行</td><td>' + escapeHtml(pos) + '</td><td>'
            + escapeHtml(fmtNum(t.value)) + '</td><td>' + escapeHtml(t.sourceText || '') + '</td></tr>';
        }).join('');
        var more = (tr.trace || []).length > 8
          ? '<p class="trace-foot">仅显示前 8 行，共 ' + (tr.trace || []).length + ' 行；完整清单见任务目录 traceability.json。</p>'
          : '';
        wsTrace.innerHTML = '<details open><summary>数据溯源：' + (v.verified || 0) + ' / ' + (v.points || 0)
          + ' 个数据点已按行号回读核对（源文件 sha256:' + String(tr.source.sha256).slice(0, 12) + '…）</summary>'
          + '<table class="trace-table"><thead><tr><th>源文件位置</th><th>位置</th><th>数值</th><th>该行原文</th></tr></thead>'
          + '<tbody>' + rows + '</tbody></table>' + more
          + '<p class="trace-foot"><a href="/api/tasks/' + encodeURIComponent(task.taskId)
          + '/source">下载留档的原始 CSV</a> · 视频 sha256:' + String(tr.video.sha256).slice(0, 16) + '…</p></details>';
        wsTrace.hidden = false;
      })
      .catch(function () { /* 溯源面板失败不影响视频预览 */ });
  }

  function fmtNum(v) {
    if (v === null || v === undefined) return '—';
    return String(v);
  }

  // 阶段 4A：只展示真实可观测的阶段状态，不计算/展示任何百分比或虚构进度。
  // 终态由页面按 task.status 映射：不改写后端 progress 里的真实记录。
  //  success：所有已登记步骤都显示「已完成」；
  //  failed ：最后一个 running 步骤改为「失败」，其余保留已完成 / 待执行。
  function showProgress(task, terminalStatus) {
    wsProgress.hidden = false;
    var p = task.progress || {};
    var terminal = terminalStatus || task.status;
    if (terminal === 'success') {
      wsStatusText.textContent = '已完成：全部步骤通过';
    } else if (terminal === 'failed') {
      wsStatusText.textContent = '执行失败：' + ((task.error && task.error.message) || '请查看下方错误说明');
    } else {
      wsStatusText.textContent = '执行中：' + (p.currentStep || p.phase || '准备中');
    }
    var steps = p.steps || [];
    if (!steps.length && (terminal === 'success' || terminal === 'failed')) {
      steps = [{ name: terminal === 'success' ? '任务完成' : '任务执行', state: terminal }];
    }
    wsSteps.innerHTML = '';
    steps.forEach(function (s) {
      var name = typeof s === 'string' ? s : (s.name || s.tool || '阶段');
      var state = typeof s === 'string' ? 'pending' : (s.state || (s.ok ? 'done' : 'pending'));
      if (terminal === 'success') state = 'done';
      else if (terminal === 'failed' && state === 'running') state = 'failed';
      var label = state === 'done' ? ' ✓ 已完成'
        : state === 'running' ? ' … 进行中'
          : state === 'failed' ? ' ✗ 失败' : ' · 待执行';
      wsSteps.appendChild(el('<li class="' + state + '">' + escapeHtml(name) + label + '</li>'));
    });
  }
  function hideProgress() { wsProgress.hidden = true; }

  function showVideo(task) {
    wsVideo.hidden = false;
    var url = '/api/tasks/' + encodeURIComponent(task.taskId) + '/video';
    wsVideoEl.src = url;
    wsDownload.href = url;
    wsDownload.setAttribute('download', task.strategy + '_' + task.taskId + '.mp4');
  }
  function hideVideo() { wsVideo.hidden = true; wsVideoEl.removeAttribute('src'); }

  function showWsError(text) { wsError.hidden = false; wsError.textContent = text; }
  function hideWsError() { wsError.hidden = true; }

  function onExecute() {
    if (!currentTaskId) return;
    var btn = document.getElementById('exec-btn');
    if (btn) btn.disabled = true;
    fetch('/api/tasks/' + encodeURIComponent(currentTaskId) + '/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 202 && res.body.ok) {
          wsBadge.textContent = 'running';
          hideWsError();
          startPolling();
        } else {
          showWsError('无法启动执行（' + (res.body.code || res.status) + '）：' + (res.body.message || ''));
          if (btn) btn.disabled = false;
        }
      })
      .catch(function () { showWsError('无法连接服务器'); if (btn) btn.disabled = false; });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (!currentTaskId) return;
      fetch('/api/tasks/' + encodeURIComponent(currentTaskId))
        .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
        .then(function (res) {
          if (res.status === 200 && res.body.ok) {
            var task = res.body.task;
            wsBadge.textContent = task.status;
            if (task.status === 'running') { showProgress(task); }
            else if (task.status === 'success') { renderWorkspace(task); stopPolling(); }
            else if (task.status === 'failed') { renderWorkspace(task); stopPolling(); }
          }
        })
        .catch(function () { /* 忽略轮询瞬时错误 */ });
    }, 1500);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function onQuery() {
    var id = (queryInput.value || '').trim();
    if (!id) { showResult(queryResult, false, '请输入任务 ID'); return; }
    queryResult.className = 'result';
    queryResult.textContent = '查询中…';
    fetch('/api/tasks/' + encodeURIComponent(id))
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 200 && res.body.ok) {
          showResult(queryResult, true, '已加载任务到工作区。');
          loadTaskIntoWorkspace(res.body.task.taskId);
        } else {
          showResult(queryResult, false,
            '查询失败（' + (res.body.code || res.status) + '）：' + (res.body.message || '未知错误'));
        }
      })
      .catch(function () { showResult(queryResult, false, '无法连接服务器'); });
  }

  function init() {
    cards.forEach(function (card) {
      card.addEventListener('click', function () {
        selectStrategy(card.getAttribute('data-strategy'));
      });
    });
    createBtn.addEventListener('click', onCreate);
    queryBtn.addEventListener('click', onQuery);
    fetch('/api/health')
      .then(function (r) { return r.json(); })
      .then(updateEnv)
      .catch(function () { setServer('服务器：无法连接', 'env-bad'); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
