/**
 * content.js
 * ----------------------------------------------------------------------------
 * 実行コンテキスト : ページの ISOLATED world (Chrome 拡張の通常 content script)
 * 役割            :
 *   1. injector.js から postMessage で送られてくるキャプチャをタブ内メモリに保持
 *   2. popup からの問い合わせに応答
 *      - getCaptures      : 保持中のキャプチャ一覧を返す
 *      - clearCaptures    : キャプチャをクリア
 *      - highlightWidget  : 列ラベルから DOM 上のウィジェットを推定してハイライト
 *      - getWidgetInfo    : 同推定 + ウィジェット内で可視な列ラベル一覧を返す
 *
 * セキュリティ方針 :
 *   - postMessage の発信元検証 (同一ウィンドウ + 専用タグ + ペイロード形状)
 *   - メモリ枯渇対策: タブあたり最大 MAX_CAPTURES 件で打ち切り
 *   - 永続化なし: ページ再読込やタブ破棄でキャプチャは消える (意図的設計)
 *   - 外部送信なし: chrome.runtime.sendMessage も popup への応答にしか使わない
 *   - DOM 探索は対象タグ (SCRIPT/STYLE/NOSCRIPT) を除外し、想定外の領域を走査しない
 * ----------------------------------------------------------------------------
 */

(function () {
  'use strict';

  // ==========================================================================
  // 定数
  // ==========================================================================

  /** タブ内に保持するキャプチャの最大件数 */
  const MAX_CAPTURES = 100;

  /** injector が送る固定タグ */
  const MESSAGE_SOURCE = 'wkt-csv-ext';

  /**
   * 現在のページがどの Insights ダッシュボードを表示しているかを示す識別子。
   * 詳細は injector.js の同名関数を参照。両者は完全に同じロジック。
   * @returns {string}
   */
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

  /** ハイライト適用に使う CSS クラス (content.css 側で定義) */
  const HIGHLIGHT_CLASS = 'wkt-csv-highlight';

  /** カスタムスムーススクロールの所要時間 (ms) */
  const SCROLL_DURATION_MS = 850;

  /**
   * ウィジェット推定の最低一致数。
   *   - 通常は 2 (= 2 列以上一致しないと採用しない)
   *   - 候補列がもともと 1 つしか無いキャプチャの場合は 1 にフォールバック
   * Workato Insights の表ウィジェットは API レスポンス上の列のうち UI には
   * 一部しか表示しないことが多いため、「全列の何%」ではなく「絶対数」で判定する。
   */
  const MIN_MATCH_COUNT = 2;

  /** Workato Insights のダッシュボードウィジェット要素のセレクタ */
  const INSIGHTS_WIDGET_SELECTOR = 'lcap-dashboard-widget';

  /** Workato Insights のテーブル列ヘッダ文字列を含む要素のセレクタ */
  const INSIGHTS_COLUMN_HEADER_SELECTOR = '.data-table-column-title__text';

  /**
   * ウィジェット内で「列ラベル / 系列名 / 軸タイトル / KPI ラベル」候補が出現
   * しうる要素のセレクタ群。Workato Insights は表/チャート/KPI で DOM 構造が
   * 異なるため、テーブル列ヘッダだけ見てるとチャート系のキャプチャを取りこぼす。
   *  - 表           : .data-table-column-title__text
   *  - チャート凡例 : .chart-container__legend-item-title
   *  - チャート軸   : .highcharts-axis-title (SVG <text>)
   *  - KPI         : .kpi-vis__label
   */
  const INSIGHTS_LABEL_SELECTORS = [
    '.data-table-column-title__text',
    '.chart-container__legend-item-title',
    '.highcharts-axis-title',
    '.kpi-vis__label'
  ];

  /**
   * テキストスキャンのフォールバック時に「データ値」を読み飛ばすためのセレクタ。
   * 表の行セル内文字列はラベルと無関係に列名と偶然一致しがちで、ノイズの元になる。
   */
  const INSIGHTS_DATA_CELL_SELECTORS = [
    'w-data-table-row-cell-value',
    '.data-table-row-cell__value',
    '.data-table-row-cell',
    'lcap-text-widget'
  ].join(',');

  // ==========================================================================
  // キャプチャ保持
  // ==========================================================================

  /** queryId をキーにした最新キャプチャ */
  const captures = new Map();

  /** queryId が取得できなかったキャプチャの FIFO バッファ */
  const orphans = [];

  /**
   * queryId → widgetId のマッピング。
   * Workato Insights のダッシュボードレイアウト API レスポンスから抽出し、
   * `lcap-dashboard-widget[data-id=...]` に直接ぶつけるための辞書。
   */
  const queryIdToWidgetId = new Map();

  /**
   * queryId → settings.title のマッピング。
   * data-id 一致が何らかの理由で失敗した時の予備ルートとして、
   * `.lcap-dashboard-widget__title` のテキスト一致で widget を引く。
   */
  const queryIdToTitle = new Map();

  /** ハイライト中の要素 (連打時の解除タイマーをクリアするため) */
  let currentHighlightEl = null;
  let currentHighlightTimer = null;

  // ==========================================================================
  // ペイロード検証
  // ==========================================================================

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

  // ==========================================================================
  // injector からの postMessage 受信
  // ==========================================================================

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

  /**
   * injector (MAIN world) に DOM 上の lcap-dashboard-widget から
   * Angular コンポーネントを覗いて queryId を取り直すよう依頼する。
   * レイアウト API 経由のマッピングが空 / 不完全な時の保険。
   * 結果は通常の 'layout' メッセージで返ってくる。
   */
  function requestDomMapping() {
    try {
      window.postMessage({ source: MESSAGE_SOURCE, type: 'request-dom-mapping' }, '*');
    } catch (e) { /* noop */ }
  }

  // ==========================================================================
  // ウィジェット推定アルゴリズム
  // ==========================================================================

  /**
   * 列ラベルの正規化 (前後空白除去 + 小文字化)。
   * @param {*} s
   * @returns {string}
   */
  function normalizeLabel(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  /**
   * 列ラベルを正規化済みの配列に変換する (重複除去)。
   * @param {string[]} columnLabels
   * @returns {string[]}
   */
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

  /**
   * Workato Insights 専用 DOM 構造を直接ターゲットしたウィジェット推定。
   * `lcap-dashboard-widget` 要素を全件走査し、各ウィジェット内の
   * `.data-table-column-title__text` のテキストを capture の列ラベルと
   * 照合する。最も多く一致したウィジェットを返す。
   *
   * @param {string[]} normalizedLabels 正規化済みラベル配列
   * @returns {Element|null}
   */
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

  /**
   * フォールバック: Workato 側で DOM 構造が変わった場合に備えた汎用スキャン。
   *
   * 構造判定が失敗した時のみ呼ばれる。検索範囲は `lcap-dashboard-widget` 内に
   * 閉じ込め、データテーブルの行セルやテキストウィジェット本文は除外して
   * 「列名/系列名と無関係な値が偶然一致してしまうノイズ」を避ける。
   *
   * @param {string[]} normalizedLabels 正規化済みラベル配列
   * @returns {Element|null}
   */
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
            // 行データやテキストウィジェット本文は列名と無関係なのでスキップ
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

  /**
   * queryId から DOM 上のウィジェットを直接特定する。
   * Workato Insights のダッシュボードレイアウト API レスポンスを掴めていれば
   * queryId → widgetId の対応が確実にあり、`data-id` 属性で一発で取れる。
   *
   * @param {string} queryId
   * @returns {Element|null}
   */
  function findWidgetByQueryId(queryId) {
    if (!queryId || typeof queryId !== 'string') return null;

    // ルート1: data-id 直結
    const widgetId = queryIdToWidgetId.get(queryId);
    if (widgetId) {
      const escaped = widgetId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const el = document.querySelector(INSIGHTS_WIDGET_SELECTOR + '[data-id="' + escaped + '"]');
      if (el) return el;
    }

    // ルート2: settings.title → ウィジェット見出しテキスト一致
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

  /**
   * ウィジェットを非同期に推定する。
   *
   * 戦略 (上から優先):
   *   1. queryId + レイアウト API のマッピングがあれば data-id で即特定
   *   2. queryId はあるがマッピング未取得なら injector に DOM スキャンを依頼し、
   *      Angular コンポーネントから queryId を読んでマッピングを構築 → 再試行
   *   3. Workato Insights 専用構造で照合 (列ヘッダ / 凡例 / KPI ラベル / 軸タイトル)
   *   4. ウィジェット内に閉じたテキストスキャン
   *
   * @param {string[]} columnLabels 元のラベル配列 (順序付き)
   * @param {string|null} queryId キャプチャの queryId (任意)
   * @returns {Promise<Element|null>}
   */
  async function findBestWidget(columnLabels, queryId) {
    const direct1 = findWidgetByQueryId(queryId);
    if (direct1) return direct1;

    // マッピング不在 → DOM スキャンを injector に頼んで少し待つ
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

  /**
   * queryId のマッピングが届くのを最大 timeoutMs まで待ち、届いたらその要素を返す。
   */
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

  // ==========================================================================
  // 可視判定 / 可視列の抽出
  // ==========================================================================

  /**
   * 要素が UI 上に「描画されている」か簡易判定する。
   * 厳密な可視判定ではなく、display:none / visibility:hidden / サイズ 0 を除外する程度。
   *
   * @param {Element} el
   * @returns {boolean}
   */
  function isElementVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  }

  /**
   * 推定したウィジェット内で、UI に表示されている列ラベルを抽出する。
   * 元のラベル配列の順序を保つ。
   *
   * 優先戦略:
   *   1. Workato Insights のヘッダ要素 (`.data-table-column-title__text`) を直接走査
   *   2. 見つからなければ TreeWalker でテキストノードを走査
   *
   * @param {Element} widgetEl
   * @param {string[]} allColumnLabels 元のラベル配列 (順序付き)
   * @returns {string[]} 可視列ラベルの配列 (元の順序を維持)
   */
  function collectVisibleHeaders(widgetEl, allColumnLabels) {
    if (!widgetEl || !Array.isArray(allColumnLabels)) return [];

    const labelToOriginal = new Map();
    for (let i = 0; i < allColumnLabels.length; i++) {
      const orig = allColumnLabels[i];
      const norm = normalizeLabel(orig);
      if (norm) labelToOriginal.set(norm, orig);
    }

    const visibleNorms = new Set();

    // -------- 優先: Workato 専用のヘッダ要素を直接走査 --------
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
      // -------- フォールバック: 汎用 TreeWalker --------
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

  // ==========================================================================
  // ハイライト制御
  // ==========================================================================

  /** 進行中のスクロールアニメをキャンセルするためのフラグ */
  let currentScrollToken = 0;

  /**
   * 指定要素を内包する最寄のスクロールコンテナを返す。
   * 見つからなければ window スクロール扱い (document.scrollingElement)。
   */
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

  /** easeInOutCubic : 加速→等速っぽい巡航→減速 で品のある軌道 */
  function easeInOutCubic(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /**
   * 要素を画面中央へ滑らかにスクロールする。requestAnimationFrame で
   * easeInOutCubic を効かせ、ブラウザ標準より少し長めに見せて高級感を出す。
   */
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

  /**
   * 指定要素にハイライトクラスを付与し、スクロールで画面中央に表示する。
   * 既存ハイライトは事前にクリアする。一定時間後に自動解除。
   *
   * @param {Element} el
   */
  function applyHighlight(el) {
    clearHighlight();
    if (!el) return;

    el.classList.add(HIGHLIGHT_CLASS);
    currentHighlightEl = el;

    try {
      smoothScrollIntoView(el);
    } catch (e) {
      // 何かあれば標準スクロールにフォールバック
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

  // ==========================================================================
  // popup からの問い合わせに応答
  // ==========================================================================

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return false;

    // ---------------------------------------------------------------------
    // キャプチャ一覧取得 (同期応答)
    // ---------------------------------------------------------------------
    if (msg.type === 'getCaptures') {
      const currentKey = getDashboardKey();
      const list = [].concat(
        Array.from(captures.values()),
        orphans
      ).filter(function (c) {
        if (!c.dashboardKey) return true;
        return c.dashboardKey === currentKey;
      }).map(function (c) {
        // レイアウト API から取得済の title があれば付与する。
        // popup 側のカード表示はこれを優先利用する。
        const title = c.queryId ? queryIdToTitle.get(c.queryId) : null;
        return title ? Object.assign({}, c, { title: title }) : c;
      }).sort(function (a, b) {
        return b.timestamp - a.timestamp;
      });
      sendResponse({ captures: list });
      return false;
    }

    // ---------------------------------------------------------------------
    // ウィジェット情報のみ取得 (非同期応答 — findBestWidget が async)
    // ---------------------------------------------------------------------
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

    // ---------------------------------------------------------------------
    // ハイライト (非同期応答)
    // ---------------------------------------------------------------------
    if (msg.type === 'highlightWidget') {
      findBestWidget(msg.columnLabels, msg.queryId).then(function (widget) {
        if (!widget) { sendResponse({ found: false }); return; }
        applyHighlight(widget);
        sendResponse({ found: true });
      }).catch(function () { sendResponse({ found: false }); });
      return true;
    }

    // ---------------------------------------------------------------------
    // ハイライト解除
    // ---------------------------------------------------------------------
    if (msg.type === 'clearHighlight') {
      clearHighlight();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
