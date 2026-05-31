/**
 * content.js  (ISOLATED world)
 * injector からのキャプチャをタブ内メモリに保持し、popup からの問い合わせ
 * (getCaptures / getWidgetInfo / highlightWidget / clearHighlight) に応答する。
 * 永続化・外部送信はなし。キャプチャはページ再読込で消える (意図的)。
 */

(function () {
  'use strict';

  // --- 定数 ---

  /** タブ内に保持するキャプチャの最大件数 (メモリ枯渇対策) */
  const MAX_CAPTURES = 100;

  /** injector が送る固定タグ */
  const MESSAGE_SOURCE = 'wkt-csv-ext';

  // injector.js の同名関数と完全に同じロジック
  function getDashboardKey() {
    try {
      const url = new URL(window.location.href);
      const handle = url.searchParams.get('handle');
      if (handle) return 'h:' + handle;
      const m = url.pathname.match(/\/dashboards\/([^/?#]+)/);
      if (m) return 'p:' + m[1];
      return 'u:' + url.pathname;
    } catch (e) {
      return '';
    }
  }

  /** ハイライトを自動解除するまでのミリ秒 */
  const HIGHLIGHT_DURATION_MS = 3000;

  /** ハイライト用 CSS クラス (content.css 側で定義) */
  const HIGHLIGHT_CLASS = 'wkt-csv-highlight';

  /** カスタムスムーススクロールの所要時間 (ms) */
  const SCROLL_DURATION_MS = 850;

  // ウィジェット推定の最低一致数。通常 2、候補列が 1 つしかない時は 1 にフォールバック。
  // 表ウィジェットは API 上の列の一部しか UI 表示しないため割合でなく絶対数で判定する。
  const MIN_MATCH_COUNT = 2;

  /** ダッシュボードウィジェット要素のセレクタ */
  const INSIGHTS_WIDGET_SELECTOR = 'lcap-dashboard-widget';

  /** テーブル列ヘッダ文字列を含む要素のセレクタ */
  const INSIGHTS_COLUMN_HEADER_SELECTOR = '.data-table-column-title__text';

  // ラベル/系列名/軸タイトル/KPI ラベル候補が出る要素群。
  // 表/チャート/KPI で DOM 構造が違うため複数セレクタを束ねる。
  const INSIGHTS_LABEL_SELECTORS = [
    '.data-table-column-title__text',
    '.chart-container__legend-item-title',
    '.highcharts-axis-title',
    '.kpi-vis__label'
  ];

  // テキストスキャンのフォールバック時に読み飛ばす「データ値」セレクタ。
  // 行セル内文字列は列名と偶然一致しやすくノイズになる。
  const INSIGHTS_DATA_CELL_SELECTORS = [
    'w-data-table-row-cell-value',
    '.data-table-row-cell__value',
    '.data-table-row-cell',
    'lcap-text-widget'
  ].join(',');

  // --- キャプチャ保持 ---

  /** queryId をキーにした最新キャプチャ */
  const captures = new Map();

  /** queryId が取得できなかったキャプチャの FIFO バッファ */
  const orphans = [];

  // queryId → widgetId。レイアウト API から抽出し data-id 属性で widget を引く辞書。
  const queryIdToWidgetId = new Map();

  // queryId → settings.title。data-id 一致が失敗した時の予備ルート (見出しテキスト一致)。
  const queryIdToTitle = new Map();

  let currentHighlightEl = null;
  let currentHighlightTimer = null;

  // --- ペイロード検証 ---

  function isValidCapture(p) {
    return (
      p &&
      typeof p === 'object' &&
      Array.isArray(p.columns) &&
      Array.isArray(p.data) &&
      typeof p.rowCount === 'number' &&
      typeof p.timestamp === 'number'
    );
  }

  // --- injector からの postMessage 受信 ---

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;

    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.source !== MESSAGE_SOURCE) return;

    if (msg.type === 'capture') {
      if (!isValidCapture(msg.payload)) return;
      const payload = msg.payload;
      if (typeof payload.queryId === 'string' && payload.queryId.length > 0) {
        captures.set(payload.queryId, payload);
        if (captures.size > MAX_CAPTURES) {
          const oldestKey = captures.keys().next().value;
          captures.delete(oldestKey);
        }
      } else {
        orphans.push(payload);
        if (orphans.length > MAX_CAPTURES) orphans.shift();
      }
      return;
    }

    if (msg.type === 'layout') {
      const p = msg.payload;
      if (!p || !Array.isArray(p.mappings)) return;
      for (let i = 0; i < p.mappings.length; i++) {
        const m = p.mappings[i];
        if (!m || typeof m.queryId !== 'string') continue;
        if (typeof m.widgetId === 'string') queryIdToWidgetId.set(m.queryId, m.widgetId);
        if (typeof m.title === 'string' && m.title.length > 0) queryIdToTitle.set(m.queryId, m.title);
      }
      try { console.debug('[wkt-csv] content: id-map', queryIdToWidgetId.size, 'title-map', queryIdToTitle.size); } catch (e) {}
      return;
    }
  });

  // injector (MAIN world) に DOM スキャンでの queryId 取得を依頼する。
  // レイアウト API 経由のマッピングが空/不完全な時の保険。結果は 'layout' で返る。
  function requestDomMapping() {
    try {
      window.postMessage({ source: MESSAGE_SOURCE, type: 'request-dom-mapping' }, '*');
    } catch (e) { /* noop */ }
  }

  // --- ウィジェット推定 ---

  // 列ラベルの正規化 (前後空白除去 + 小文字化)
  function normalizeLabel(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  // 列ラベルを正規化済み配列に変換する (重複除去)
  function normalizeLabelArray(columnLabels) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < columnLabels.length; i++) {
      const n = normalizeLabel(columnLabels[i]);
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  }

  // 各 widget 内のラベル要素テキストを capture の列ラベルと照合し、
  // 最も多く一致した widget を返す (同点なら要素数が少ない方)。
  function findWidgetByInsightsStructure(normalizedLabels) {
    const widgets = document.querySelectorAll(INSIGHTS_WIDGET_SELECTOR);
    if (widgets.length === 0) return null;

    const labelSet = new Set(normalizedLabels);
    const selector = INSIGHTS_LABEL_SELECTORS.join(',');

    let best = null;
    let bestScore = 0;
    let bestSize = Infinity;

    for (let i = 0; i < widgets.length; i++) {
      const widget = widgets[i];
      const labelEls = widget.querySelectorAll(selector);
      if (labelEls.length === 0) continue;

      const matched = new Set();
      for (let j = 0; j < labelEls.length; j++) {
        const text = normalizeLabel(labelEls[j].textContent);
        if (labelSet.has(text)) matched.add(text);
      }

      const score = matched.size;
      if (score === 0) continue;

      if (score > bestScore) {
        bestScore = score;
        best = widget;
        bestSize = widget.getElementsByTagName('*').length;
      } else if (score === bestScore) {
        const sz = widget.getElementsByTagName('*').length;
        if (sz < bestSize) {
          best = widget;
          bestSize = sz;
        }
      }
    }

    const minMatches = Math.min(MIN_MATCH_COUNT, normalizedLabels.length);
    if (best && bestScore >= minMatches) return best;
    return null;
  }

  // フォールバック: 専用構造で見つからない時の汎用テキストスキャン。
  // 検索範囲を widget 内に閉じ、行セル/テキスト本文を除外してノイズを避ける。
  function findWidgetByTextScan(normalizedLabels) {
    const widgets = document.querySelectorAll(INSIGHTS_WIDGET_SELECTOR);
    if (widgets.length === 0) return null;

    const labelSet = new Set(normalizedLabels);

    let best = null;
    let bestScore = 0;
    let bestSize = Infinity;

    for (let i = 0; i < widgets.length; i++) {
      const widget = widgets[i];
      const matched = new Set();

      const walker = document.createTreeWalker(
        widget,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
              return NodeFilter.FILTER_REJECT;
            }
            // 行データやテキスト本文は列名と無関係なのでスキップ
            if (parent.closest && parent.closest(INSIGHTS_DATA_CELL_SELECTORS)) {
              return NodeFilter.FILTER_REJECT;
            }
            const v = node.nodeValue;
            if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let node;
      while ((node = walker.nextNode())) {
        const norm = normalizeLabel(node.nodeValue);
        if (labelSet.has(norm)) matched.add(norm);
      }

      const score = matched.size;
      if (score === 0) continue;

      if (score > bestScore) {
        bestScore = score;
        best = widget;
        bestSize = widget.getElementsByTagName('*').length;
      } else if (score === bestScore) {
        const sz = widget.getElementsByTagName('*').length;
        if (sz < bestSize) {
          best = widget;
          bestSize = sz;
        }
      }
    }

    const minMatches = Math.min(MIN_MATCH_COUNT, normalizedLabels.length);
    if (best && bestScore >= minMatches) return best;
    return null;
  }

  // queryId から DOM 上の widget を直接特定する。
  // ルート1: data-id 直結。ルート2: settings.title で見出しテキスト一致。
  function findWidgetByQueryId(queryId) {
    if (!queryId || typeof queryId !== 'string') return null;

    const widgetId = queryIdToWidgetId.get(queryId);
    if (widgetId) {
      const escaped = widgetId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const el = document.querySelector(INSIGHTS_WIDGET_SELECTOR + '[data-id="' + escaped + '"]');
      if (el) return el;
    }

    const title = queryIdToTitle.get(queryId);
    if (title) {
      const normTarget = String(title).trim();
      const widgets = document.querySelectorAll(INSIGHTS_WIDGET_SELECTOR);
      for (let i = 0; i < widgets.length; i++) {
        const titleEl = widgets[i].querySelector('.lcap-dashboard-widget__title');
        if (titleEl && titleEl.textContent.trim() === normTarget) return widgets[i];
      }
    }
    return null;
  }

  // ウィジェットを非同期に推定する。優先順:
  //   1. queryId + レイアウトマッピングがあれば data-id で即特定
  //   2. マッピング未取得なら injector に DOM スキャンを依頼して再試行
  //   3. 専用構造で照合 (列ヘッダ/凡例/KPI/軸)
  //   4. widget 内に閉じたテキストスキャン
  async function findBestWidget(columnLabels, queryId) {
    const direct1 = findWidgetByQueryId(queryId);
    if (direct1) return direct1;

    if (queryId && typeof queryId === 'string') {
      requestDomMapping();
      const direct2 = await waitForMapping(queryId, 800);
      if (direct2) return direct2;
    }

    if (!Array.isArray(columnLabels) || columnLabels.length === 0) return null;

    const normalized = normalizeLabelArray(columnLabels);
    if (normalized.length === 0) return null;

    const primary = findWidgetByInsightsStructure(normalized);
    if (primary) return primary;

    return findWidgetByTextScan(normalized);
  }

  // queryId のマッピング到着を最大 timeoutMs まで待ち、届いたら要素を返す
  function waitForMapping(queryId, timeoutMs) {
    return new Promise(function (resolve) {
      const start = performance.now();
      function tick() {
        const el = findWidgetByQueryId(queryId);
        if (el) { resolve(el); return; }
        if (performance.now() - start >= timeoutMs) { resolve(null); return; }
        setTimeout(tick, 50);
      }
      tick();
    });
  }

  // --- 可視判定 / 可視列の抽出 ---

  // display:none / visibility:hidden / サイズ 0 を除外する程度の簡易可視判定
  function isElementVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  }

  // widget 内で UI に表示中の列ラベルを、元のラベル配列の順序を保って抽出する。
  // 優先: 専用ヘッダ要素を直接走査 → 無ければ TreeWalker でテキストノード走査。
  function collectVisibleHeaders(widgetEl, allColumnLabels) {
    if (!widgetEl || !Array.isArray(allColumnLabels)) return [];

    const labelToOriginal = new Map();
    for (let i = 0; i < allColumnLabels.length; i++) {
      const orig = allColumnLabels[i];
      const norm = normalizeLabel(orig);
      if (norm) labelToOriginal.set(norm, orig);
    }

    const visibleNorms = new Set();

    const headerEls = widgetEl.querySelectorAll(INSIGHTS_COLUMN_HEADER_SELECTOR);
    if (headerEls.length > 0) {
      for (let i = 0; i < headerEls.length; i++) {
        const text = normalizeLabel(headerEls[i].textContent);
        if (!labelToOriginal.has(text)) continue;
        if (visibleNorms.has(text)) continue;
        if (isElementVisible(headerEls[i])) {
          visibleNorms.add(text);
        }
      }
    } else {
      // フォールバック: 汎用 TreeWalker
      const walker = document.createTreeWalker(
        widgetEl,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let node;
      while ((node = walker.nextNode())) {
        const norm = normalizeLabel(node.nodeValue);
        if (!labelToOriginal.has(norm)) continue;
        if (visibleNorms.has(norm)) continue;
        if (isElementVisible(node.parentElement)) {
          visibleNorms.add(norm);
        }
      }
    }

    // 元の順序を維持
    const out = [];
    for (let i = 0; i < allColumnLabels.length; i++) {
      const orig = allColumnLabels[i];
      const norm = normalizeLabel(orig);
      if (visibleNorms.has(norm)) out.push(orig);
    }
    return out;
  }

  // --- ハイライト制御 ---

  /** 進行中のスクロールアニメをキャンセルするためのトークン */
  let currentScrollToken = 0;

  // el を内包する最寄のスクロールコンテナを返す (無ければ window スクロール)
  function findScrollContainer(el) {
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      const canScrollY = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay');
      if (canScrollY && node.scrollHeight > node.clientHeight + 1) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function easeInOutCubic(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // 要素を画面中央へ requestAnimationFrame + easeInOutCubic で滑らかにスクロールする
  function smoothScrollIntoView(el) {
    const token = ++currentScrollToken;
    const container = findScrollContainer(el);
    const isWindow = (container === document.scrollingElement || container === document.documentElement);

    const elRect = el.getBoundingClientRect();
    let startY;
    let viewportH;
    let containerTop;

    if (isWindow) {
      startY = window.scrollY || window.pageYOffset || 0;
      viewportH = window.innerHeight;
      containerTop = 0;
    } else {
      startY = container.scrollTop;
      const cRect = container.getBoundingClientRect();
      viewportH = container.clientHeight;
      containerTop = cRect.top;
    }

    const elCenterFromContainerTop = (elRect.top - containerTop) + elRect.height / 2;
    const targetY = startY + elCenterFromContainerTop - viewportH / 2;
    const delta = targetY - startY;

    if (Math.abs(delta) < 2) return;

    const start = performance.now();
    const duration = SCROLL_DURATION_MS;

    function step(now) {
      if (token !== currentScrollToken) return;
      const t = Math.min(1, (now - start) / duration);
      const y = startY + delta * easeInOutCubic(t);
      if (isWindow) {
        window.scrollTo(0, y);
      } else {
        container.scrollTop = y;
      }
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // 要素にハイライトを付与し画面中央へスクロール。既存ハイライトは事前解除、一定時間後に自動解除。
  function applyHighlight(el) {
    clearHighlight();
    if (!el) return;

    el.classList.add(HIGHLIGHT_CLASS);
    currentHighlightEl = el;

    try {
      smoothScrollIntoView(el);
    } catch (e) {
      // 失敗時は標準スクロールにフォールバック
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      catch (_) { el.scrollIntoView(); }
    }

    currentHighlightTimer = window.setTimeout(function () {
      clearHighlight();
    }, HIGHLIGHT_DURATION_MS);
  }

  function clearHighlight() {
    if (currentHighlightTimer != null) {
      window.clearTimeout(currentHighlightTimer);
      currentHighlightTimer = null;
    }
    if (currentHighlightEl && currentHighlightEl.classList) {
      currentHighlightEl.classList.remove(HIGHLIGHT_CLASS);
    }
    currentHighlightEl = null;
  }

  // --- popup からの問い合わせに応答 ---

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return false;

    // キャプチャ一覧取得 (同期応答)
    if (msg.type === 'getCaptures') {
      const currentKey = getDashboardKey();

      // popup のカード順をダッシュボードの見た目順 (左上→右下) に合わせるため、
      // queryId → widgetId → DOM index を用意して並び替える。
      const domOrder = new Map();
      const widgetEls = document.querySelectorAll(INSIGHTS_WIDGET_SELECTOR);
      for (let i = 0; i < widgetEls.length; i++) {
        const id = widgetEls[i].getAttribute('data-id');
        if (id) domOrder.set(id, i);
      }

      const list = [].concat(
        Array.from(captures.values()),
        orphans
      ).filter(function (c) {
        if (!c.dashboardKey) return true;
        return c.dashboardKey === currentKey;
      }).map(function (c) {
        // レイアウト API 由来の title があれば付与 (popup のカード表示が優先利用)
        const title = c.queryId ? queryIdToTitle.get(c.queryId) : null;
        return title ? Object.assign({}, c, { title: title }) : c;
      }).sort(function (a, b) {
        // 主キー: DOM 順 (該当無しは末尾)。副キー: タイムスタンプ降順 (同 index の安定化)。
        const aWid = a.queryId ? queryIdToWidgetId.get(a.queryId) : null;
        const bWid = b.queryId ? queryIdToWidgetId.get(b.queryId) : null;
        const aIdx = (aWid != null && domOrder.has(aWid)) ? domOrder.get(aWid) : Infinity;
        const bIdx = (bWid != null && domOrder.has(bWid)) ? domOrder.get(bWid) : Infinity;
        if (aIdx !== bIdx) return aIdx - bIdx;
        return b.timestamp - a.timestamp;
      });
      sendResponse({ captures: list });
      return false;
    }

    // ウィジェット情報のみ取得 (非同期 — findBestWidget が async)
    if (msg.type === 'getWidgetInfo') {
      findBestWidget(msg.columnLabels, msg.queryId).then(function (widget) {
        if (!widget) { sendResponse({ found: false, visibleLabels: [] }); return; }
        sendResponse({
          found: true,
          visibleLabels: collectVisibleHeaders(widget, msg.columnLabels)
        });
      }).catch(function () { sendResponse({ found: false, visibleLabels: [] }); });
      return true;
    }

    // ハイライト (非同期応答)
    if (msg.type === 'highlightWidget') {
      findBestWidget(msg.columnLabels, msg.queryId).then(function (widget) {
        if (!widget) { sendResponse({ found: false }); return; }
        applyHighlight(widget);
        sendResponse({ found: true });
      }).catch(function () { sendResponse({ found: false }); });
      return true;
    }

    // ハイライト解除
    if (msg.type === 'clearHighlight') {
      clearHighlight();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
