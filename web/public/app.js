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
  var wsError = document.getElementById('ws-error');

  var selected = null;
  var currentTaskId = null;
  var pollTimer = null;

  // 各策略表单元数据（默认值来自已验证 sealed 配置）
  var META = {
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
    }
  };

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

  function buildForm(strategy) {
    var m = META[strategy];
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

    paramsForm.appendChild(el(
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
      paramsForm.appendChild(el(
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
    var req = {
      strategy: selected,
      principal: Number(document.getElementById('f-principal').value),
      startDate: document.getElementById('f-start').value,
      endDate: document.getElementById('f-end').value
    };
    return req;
  }

  function showResult(node, ok, text) {
    node.className = 'result ' + (ok ? 'ok' : 'bad');
    node.textContent = text;
  }

  function onCreate() {
    if (!selected) return;
    var req;
    try { req = collectRequest(); }
    catch (e) { showResult(createResult, false, '表单读取失败'); return; }

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
          showResult(createResult, true,
            '任务已创建 ✓\n任务 ID：' + res.body.taskId + '\n状态：' + res.body.status);
          loadTaskIntoWorkspace(res.body.taskId);
        } else {
          showResult(createResult, false,
            '创建失败（' + (res.body.code || res.status) + '）：' + (res.body.message || '未知错误'));
        }
      })
      .catch(function () { showResult(createResult, false, '无法连接服务器'); })
      .finally(function () { createBtn.disabled = false; });
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
    wsSummary.innerHTML =
      '<div><b>任务 ID</b>：' + task.taskId + '</div>' +
      '<div><b>策略</b>：' + m.name + '</div>' +
      '<div><b>本金</b>：¥ ' + Number(task.principal || 0).toLocaleString('en-US') + '</div>' +
      '<div><b>区间</b>：' + task.startDate + ' → ' + task.endDate + '</div>' +
      '<div><b>状态</b>：' + task.status + '</div>';

    // 失败统一提示「请新建任务重试」（避免重复 runId 覆盖 / plan 冲突）
    if (task.status === 'failed' && task.error) {
      var msg = '执行失败（' + task.error.code + '）：' + task.error.message;
      if (task.error.missing && task.error.missing.length) {
        msg += '\n缺少文件：' + task.error.missing.join('、');
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

    // 进度 / 视频
    if (task.status === 'running') {
      showProgress(task);
      startPolling();
    } else {
      stopPolling();
      if (task.status === 'success' && task.mp4) {
        showVideo(task);
      } else {
        hideProgress();
        hideVideo();
      }
    }
  }

  // 阶段 4A：只展示真实可观测的阶段状态，不计算/展示任何百分比或虚构进度
  function showProgress(task) {
    wsProgress.hidden = false;
    var p = task.progress || {};
    wsStatusText.textContent = '执行中：' + (p.currentStep || p.phase || '准备中');
    var steps = p.steps || [];
    wsSteps.innerHTML = '';
    steps.forEach(function (s) {
      var name = typeof s === 'string' ? s : (s.name || s.tool || '阶段');
      var state = typeof s === 'string' ? 'pending' : (s.state || (s.ok ? 'done' : 'pending'));
      var label = state === 'done' ? ' ✓ 已完成' : state === 'running' ? ' … 进行中' : ' · 待执行';
      wsSteps.appendChild(el('<li class="' + state + '">' + name + label + '</li>'));
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
