/**
 * 东方财富大盘资金流分时监控
 * content script - 在 dpzjlx.html 页面注入浮窗,定时拉取接口数据
 */
(function () {
  'use strict';

  if (document.getElementById('em-dpzjlx-panel')) return;

  // ===== 市场配置 =====
  const MARKETS = {
    hssj: { name: '沪深', secid: '1.000001', secid2: '0.399001' },
    shsj: { name: '沪市', secid: '1.000001', secid2: '' },
    szsj: { name: '深市', secid: '0.399001', secid2: '' },
    cyb:  { name: '创业板', secid: '0.399006', secid2: '' }
  };

  // 分时接口返回的逗号分隔字段(klt=1, fields2=f51..f58):
  // f51:时间 f52:主力净流入 f53:小单净流入 f54:中单净流入 f55:大单净流入 f56:超大净流入
  // f57:主力净占比 f58:?(根据 fields1 决定,通常是指数收盘价)
  // 完整字段拉 f51..f65 可得到上证收盘价/涨跌幅/深证收盘价/涨跌幅
  const FFLOW_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65';

  const STORAGE_KEY = 'em_dpzjlx_state_v1';

  // ===== 状态 =====
  const state = {
    currentMarket: 'hssj',
    panelPos: { top: 80, right: 20 },
    collapsed: false,
    klines: [],           // 分时数据数组
    snapshot: null,       // 实时快照
    lastUpdate: null,
    pollingHandles: { snap: null, kline: null },
    isMarketOpen: false
  };

  // ===== 工具函数 =====
  function fmtBillion(num) {
    // 接口单位是元,转亿元保留 2 位
    if (num === null || num === undefined || isNaN(num)) return '--';
    const yi = num / 1e8;
    const sign = yi >= 0 ? '+' : '';
    return sign + yi.toFixed(2);
  }

  function fmtPercent(num) {
    if (num === null || num === undefined || isNaN(num)) return '--';
    const sign = num >= 0 ? '+' : '';
    return sign + num.toFixed(2) + '%';
  }

  function fmtPrice(num) {
    if (num === null || num === undefined || isNaN(num)) return '--';
    return num.toFixed(2);
  }

  function signClass(num) {
    if (num === null || num === undefined || isNaN(num) || num === 0) return 'zero';
    return num > 0 ? 'up' : 'down';
  }

  function nowStr() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function isTradeTime() {
    const d = new Date();
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const mins = d.getHours() * 60 + d.getMinutes();
    // 9:15 - 11:30, 13:00 - 15:05
    return (mins >= 555 && mins <= 690) || (mins >= 780 && mins <= 905);
  }

  // ===== 持久化 =====
  function saveState() {
    try {
      chrome.storage.local.set({
        [STORAGE_KEY]: {
          currentMarket: state.currentMarket,
          panelPos: state.panelPos,
          collapsed: state.collapsed
        }
      });
    } catch (e) { /* ignore */ }
  }

  function loadState(cb) {
    try {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        const s = res[STORAGE_KEY];
        if (s) {
          state.currentMarket = s.currentMarket || 'hssj';
          state.panelPos = s.panelPos || { top: 80, right: 20 };
          state.collapsed = !!s.collapsed;
        }
        cb && cb();
      });
    } catch (e) { cb && cb(); }
  }

  // ===== 数据接口 =====
  async function fetchKline(marketKey) {
    const m = MARKETS[marketKey];
    const params = new URLSearchParams({
      lmt: '0',
      klt: '1',
      fields1: 'f1,f2,f3,f7',
      fields2: FFLOW_FIELDS2,
      ut: 'b2884a393a59ad64002292a3e90d46a5',
      secid: m.secid,
      _: Date.now()
    });
    if (m.secid2) params.set('secid2', m.secid2);

    // 注意:用 push2(实时域)而不是 push2his(历史域)。
    // push2 在休市期间会保留最近交易日的分时快照,非交易日打开也能拿到数据;
    // push2his 反而要求严格当日,周末返回空。
    const url = 'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?' + params.toString();
    const resp = await fetch(url, { credentials: 'omit' });
    const json = await resp.json();
    const klines = (json && json.data && json.data.klines) || [];
    return klines.map(parseKlineRow);
  }

  function parseKlineRow(line) {
    // 逗号分隔: time, 主力净流入, 小单, 中单, 大单, 超大, 主力净占比, 小单净占比,
    //   中单净占比, 大单净占比, 超大净占比, 上证收盘, 上证涨跌幅, 深证收盘, 深证涨跌幅
    const parts = line.split(',');
    const a = parts.map(v => v === '-' ? null : parseFloat(v));

    // 时间字段接口返回的可能是 "HH:mm" 或 "YYYY-MM-DD HH:mm",统一只保留 HH:mm
    let t = parts[0] || '';
    const m = t.match(/(\d{2}:\d{2})/);
    if (m) t = m[1];

    // 接口的净比字段(f57..f61)在盘中阶段经常返回 null/'-',这里做兜底:
    // 净比 = 净流入 / 五档绝对值之和 * 100,作为粗略口径
    let mainPct = a[6], smallPct = a[7], midPct = a[8], bigPct = a[9], superBigPct = a[10];
    if (mainPct == null || smallPct == null) {
      const denom = (Math.abs(a[5] || 0) + Math.abs(a[4] || 0) +
                     Math.abs(a[3] || 0) + Math.abs(a[2] || 0));
      // 分母用 4 档(超大+大+中+小)的绝对值和,因为主力本身=超大+大,不能放进分母重复算
      if (denom > 0) {
        if (mainPct == null && a[1] != null) mainPct = a[1] / denom * 100;
        if (superBigPct == null && a[5] != null) superBigPct = a[5] / denom * 100;
        if (bigPct == null && a[4] != null) bigPct = a[4] / denom * 100;
        if (midPct == null && a[3] != null) midPct = a[3] / denom * 100;
        if (smallPct == null && a[2] != null) smallPct = a[2] / denom * 100;
      }
    }

    return {
      time: t,
      mainFlow: a[1],
      smallFlow: a[2],
      midFlow: a[3],
      bigFlow: a[4],
      superBigFlow: a[5],
      mainPct: mainPct,
      smallPct: smallPct,
      midPct: midPct,
      bigPct: bigPct,
      superBigPct: superBigPct,
      shPrice: a[11],
      shChange: a[12],
      szPrice: a[13],
      szChange: a[14]
    };
  }

  async function fetchSnapshot(marketKey) {
    const m = MARKETS[marketKey];
    const secids = m.secid2 ? `${m.secid},${m.secid2}` : m.secid;
    const params = new URLSearchParams({
      fltt: '2',
      secids: secids,
      fields: 'f1,f2,f3,f12,f13,f14,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87',
      ut: 'b2884a393a59ad64002292a3e90d46a5',
      _: Date.now()
    });
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?' + params.toString();
    const resp = await fetch(url, { credentials: 'omit' });
    const json = await resp.json();
    return (json && json.data && json.data.diff) || [];
  }

  // ===== 渲染 =====
  function render() {
    if (state.collapsed) {
      renderCollapsed();
      return;
    }
    renderKPI();
    renderTable();
    renderFooter();
  }

  function renderCollapsed() {
    // 折叠态由 CSS 控制,这里只更新 DOM 结构
  }

  function renderKPI() {
    const k = state.klines.length ? state.klines[state.klines.length - 1] : null;
    if (!k) return;

    const grid = document.getElementById('em-kpi-grid');
    if (!grid) return;

    const mainCls = signClass(k.mainFlow);
    const shChCls = signClass(k.shChange);
    const szChCls = signClass(k.szChange);

    grid.innerHTML = `
      <div class="em-kpi-card">
        <div class="em-kpi-label">主力净流入</div>
        <div class="em-kpi-value ${mainCls}">${fmtBillion(k.mainFlow)} 亿</div>
        <div class="em-kpi-sub">净比 <span class="${signClass(k.mainPct)}">${fmtPercent(k.mainPct)}</span></div>
      </div>
      <div class="em-kpi-card">
        <div class="em-kpi-label">上证 / 深证</div>
        <div class="em-kpi-value">${fmtPrice(k.shPrice)} <span class="em-kpi-sub-inline ${shChCls}" style="font-size:11px;">${fmtPercent(k.shChange)}</span></div>
        <div class="em-kpi-sub">${fmtPrice(k.szPrice)} <span class="${szChCls}">${fmtPercent(k.szChange)}</span></div>
      </div>
    `;
  }

  function renderTable() {
    const body = document.getElementById('em-table-body');
    if (!body) return;

    if (!state.klines.length) {
      body.innerHTML = '<div class="em-empty">暂无数据,等待开盘或检查网络</div>';
      return;
    }

    // 倒序显示,最新在顶
    const rows = state.klines.slice().reverse();
    const latestTime = rows[0].time;

    body.innerHTML = rows.map((k, idx) => {
      const isLatest = k.time === latestTime;
      return `
        <div class="em-table-row ${isLatest ? 'latest' : ''}">
          <div>${k.time}</div>
          <div class="em-cell ${signClass(k.mainFlow)}">${fmtBillion(k.mainFlow)}</div>
          <div class="em-cell ${signClass(k.superBigFlow)}">${fmtBillion(k.superBigFlow)}</div>
          <div class="em-cell ${signClass(k.bigFlow)}">${fmtBillion(k.bigFlow)}</div>
          <div class="em-cell ${signClass(k.midFlow)}">${fmtBillion(k.midFlow)}</div>
          <div class="em-cell ${signClass(k.smallFlow)}">${fmtBillion(k.smallFlow)}</div>
          <div class="em-cell ${signClass(k.mainPct)}">${fmtPercent(k.mainPct)}</div>
        </div>
      `;
    }).join('');
  }

  function renderFooter() {
    const t = document.getElementById('em-footer-time');
    const m = document.getElementById('em-footer-meta');
    if (t) t.textContent = state.lastUpdate ? '更新于 ' + state.lastUpdate : '等待数据';
    if (m) m.textContent = `${state.klines.length} 条 · ${state.isMarketOpen ? '盘中' : '休市'}`;

    const dot = document.querySelector('#em-dpzjlx-panel .em-status-dot');
    if (dot) {
      dot.classList.remove('live', 'error');
      if (state.isMarketOpen) dot.classList.add('live');
    }
  }

  // ===== 数据拉取调度 =====
  async function refreshKline() {
    try {
      const data = await fetchKline(state.currentMarket);
      state.klines = data;
      state.lastUpdate = nowStr();
      render();
    } catch (e) {
      console.warn('[em-dpzjlx] fetchKline failed', e);
      const dot = document.querySelector('#em-dpzjlx-panel .em-status-dot');
      if (dot) { dot.classList.remove('live'); dot.classList.add('error'); }
    }
  }

  function startPolling() {
    stopPolling();
    refreshKline();
    state.isMarketOpen = isTradeTime();

    // 盘中每 6 秒拉一次分时,休市每 60 秒拉一次(防止刚收盘最后一条没拿到)
    const interval = state.isMarketOpen ? 6000 : 60000;
    state.pollingHandles.kline = setInterval(() => {
      state.isMarketOpen = isTradeTime();
      refreshKline();
    }, interval);
  }

  function stopPolling() {
    if (state.pollingHandles.kline) {
      clearInterval(state.pollingHandles.kline);
      state.pollingHandles.kline = null;
    }
  }

  // ===== CSV 导出 =====
  function exportCSV() {
    if (!state.klines.length) {
      alert('暂无数据');
      return;
    }
    const headers = ['时间', '主力净流入(元)', '超大单净流入(元)', '大单净流入(元)', '中单净流入(元)', '小单净流入(元)',
      '主力净占比(%)', '超大净占比(%)', '大单净占比(%)', '中单净占比(%)', '小单净占比(%)',
      '上证收盘', '上证涨跌幅(%)', '深证收盘', '深证涨跌幅(%)'];
    const rows = state.klines.map(k => [
      k.time, k.mainFlow, k.superBigFlow, k.bigFlow, k.midFlow, k.smallFlow,
      k.mainPct, k.superBigPct, k.bigPct, k.midPct, k.smallPct,
      k.shPrice, k.shChange, k.szPrice, k.szChange
    ].map(v => v === null || v === undefined ? '' : v).join(','));
    const csv = '\ufeff' + headers.join(',') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `大盘资金流_${MARKETS[state.currentMarket].name}_${dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ===== DOM 构建 =====
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'em-dpzjlx-panel';
    if (state.collapsed) panel.classList.add('collapsed');
    panel.style.top = state.panelPos.top + 'px';
    panel.style.right = state.panelPos.right + 'px';

    panel.innerHTML = `
      <div class="em-panel-header" id="em-header">
        <span class="em-collapsed-label">
          <span class="em-status-dot"></span>
          <span>资金流分时</span>
        </span>
        <span class="em-panel-title">
          <span class="em-status-dot"></span>
          <span>大盘资金流分时</span>
        </span>
        <span class="em-panel-header-actions">
          <button class="em-btn" id="em-btn-refresh" title="刷新">
            <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><polyline points="21 3 21 8 16 8"/></svg>
          </button>
          <button class="em-btn" id="em-btn-export" title="导出 CSV">
            <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="em-btn" id="em-btn-toggle" title="收起">
            <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </span>
      </div>
      <div class="em-panel-body">
        <div class="em-tabs" id="em-tabs">
          ${Object.entries(MARKETS).map(([key, m]) =>
            `<button class="em-tab ${key === state.currentMarket ? 'active' : ''}" data-market="${key}">${m.name}</button>`
          ).join('')}
        </div>
        <div class="em-kpi-grid" id="em-kpi-grid"></div>
        <div class="em-table-wrap">
          <div class="em-table-header">
            <div>时间</div>
            <div>主力</div>
            <div>超大</div>
            <div>大单</div>
            <div>中单</div>
            <div>小单</div>
            <div>主力净比</div>
          </div>
          <div class="em-table-body" id="em-table-body">
            <div class="em-empty">加载中...</div>
          </div>
        </div>
      </div>
      <div class="em-panel-footer">
        <span id="em-footer-time" class="em-footer-time">等待数据</span>
        <span id="em-footer-meta" class="em-footer-meta"></span>
      </div>
    `;

    document.body.appendChild(panel);

    bindEvents(panel);
  }

  function bindEvents(panel) {
    // tab 切换
    panel.querySelectorAll('.em-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.market;
        if (key === state.currentMarket) return;
        state.currentMarket = key;
        panel.querySelectorAll('.em-tab').forEach(b => b.classList.toggle('active', b === btn));
        state.klines = [];
        render();
        saveState();
        startPolling();
      });
    });

    // 刷新
    panel.querySelector('#em-btn-refresh').addEventListener('click', (e) => {
      e.stopPropagation();
      refreshKline();
    });

    // 导出
    panel.querySelector('#em-btn-export').addEventListener('click', (e) => {
      e.stopPropagation();
      exportCSV();
    });

    // 折叠/展开
    panel.querySelector('#em-btn-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      state.collapsed = true;
      panel.classList.add('collapsed');
      saveState();
    });

    // 折叠态点击展开
    panel.addEventListener('click', (e) => {
      if (state.collapsed) {
        state.collapsed = false;
        panel.classList.remove('collapsed');
        saveState();
        render();
      }
    });

    // 拖拽
    enableDrag(panel);
  }

  function enableDrag(panel) {
    const header = panel.querySelector('#em-header');
    let dragging = false;
    let startX = 0, startY = 0;
    let startTop = 0, startRight = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      if (state.collapsed) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startTop = parseInt(panel.style.top, 10) || 80;
      startRight = parseInt(panel.style.right, 10) || 20;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newTop = Math.max(0, Math.min(window.innerHeight - 50, startTop + dy));
      const newRight = Math.max(0, Math.min(window.innerWidth - 50, startRight - dx));
      panel.style.top = newTop + 'px';
      panel.style.right = newRight + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      state.panelPos = {
        top: parseInt(panel.style.top, 10),
        right: parseInt(panel.style.right, 10)
      };
      saveState();
    });
  }

  // ===== 入口 =====
  loadState(() => {
    buildPanel();
    startPolling();

    // 页面卸载时清理
    window.addEventListener('beforeunload', stopPolling);
  });

})();
