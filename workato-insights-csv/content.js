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

  // ==========================================================================
  // キャプチャ保持
  // ==========================================================================

  /** queryId をキーにした最新キャプチャ */
  const captures = new Map();

  /** queryId が取得できなかったキャプチャの FIFO バッファ */
  const orphans = [];

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
    if (msg.type !== 'capture') return;
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
  });

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
   * ページ全体のテキストノードを 1 回だけ走査し、
   * 各列ラベルに完全一致するノードの親要素を収集する。
   * SCRIPT / STYLE / NOSCRIPT などは無視する。
   *
   * @param {Set<string>} normalizedLabelSet 正規化済みラベル集合
   * @returns {Map<string, Element[]>} 正規化ラベル -> 親要素配列
   */
  function collectTextMatches(normalizedLabelSet) {
    const result = new Map();
    normalizedLabelSet.forEach(function (l) { result.set(l, []); });

    if (!document.body) return result;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
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
      if (result.has(norm)) {
        const parent = node.parentElement;
        if (parent) result.get(norm).push(parent);
      }
    }
    return result;
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

    let best = null;
    let bestScore = 0;
    let bestSize = Infinity;

    for (let i = 0; i < widgets.length; i++) {
      const widget = widgets[i];
      const headerEls = widget.querySelectorAll(INSIGHTS_COLUMN_HEADER_SELECTOR);
      if (headerEls.length === 0) continue;

      const matched = new Set();
      for (let j = 0; j < headerEls.length; j++) {
        const text = normalizeLabel(headerEls[j].textContent);
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
   * 汎用 TreeWalker フォールバック。Workato 側で DOM 構造が変わった場合に備える。
   * テキストノードを走査して列ラベルと一致するノードを集め、それらを最も多く
   * 内包する最小サブツリーを返す。
   *
   * @param {string[]} normalizedLabels 正規化済みラベル配列
   * @returns {Element|null}
   */
  function findWidgetByTextScan(normalizedLabels) {
    const matches = collectTextMatches(new Set(normalizedLabels));

    // 起点ラベル: 候補が空でない中で最も候補数が少ないものを選ぶ
    let startLabel = null;
    let minCount = Infinity;
    matches.forEach(function (els, label) {
      if (els.length > 0 && els.length < minCount) {
        minCount = els.length;
        startLabel = label;
      }
    });
    if (!startLabel) return null;

    let best = null;
    let bestScore = 0;
    let bestSize = Infinity;

    const startElements = matches.get(startLabel);
    for (let i = 0; i < startElements.length; i++) {
      let el = startElements[i];
      while (el && el !== document.body) {
        let score = 0;
        matches.forEach(function (els) {
          for (let j = 0; j < els.length; j++) {
            if (el.contains(els[j])) { score++; return; }
          }
        });

        if (score > bestScore) {
          bestScore = score;
          best = el;
          bestSize = el.getElementsByTagName('*').length;
        } else if (score === bestScore && score > 0) {
          const sz = el.getElementsByTagName('*').length;
          if (sz < bestSize) {
            best = el;
            bestSize = sz;
          }
        }

        if (score === normalizedLabels.length) break;
        el = el.parentElement;
      }
    }

    const minMatches = Math.min(MIN_MATCH_COUNT, normalizedLabels.length);
    if (best && bestScore >= minMatches) return best;
    return null;
  }

  /**
   * 列ラベルから DOM 上のウィジェットを推定する。
   *
   * 戦略:
   *   1. Workato Insights 専用構造 (`lcap-dashboard-widget` + 列ヘッダ要素) を優先
   *   2. 失敗した場合は汎用テキストスキャンにフォールバック
   *
   * UI 上で API レスポンス全列のうち一部しか表示しないケース (列の非表示設定など)
   * に対応するため、判定は「全列の何%」ではなく「最低 MIN_MATCH_COUNT 列一致」とする。
   *
   * @param {string[]} columnLabels 元のラベル配列 (順序付き)
   * @returns {Element|null}
   */
  function findBestWidget(columnLabels) {
    if (!Array.isArray(columnLabels) || columnLabels.length === 0) return null;

    const normalized = normalizeLabelArray(columnLabels);
    if (normalized.length === 0) return null;

    const primary = findWidgetByInsightsStructure(normalized);
    if (primary) return primary;

    return findWidgetByTextScan(normalized);
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
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      // 古いブラウザ向けフォールバック
      el.scrollIntoView();
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
    if (!msg || typeof msg !== 'object') return;

    // ---------------------------------------------------------------------
    // キャプチャ一覧取得
    // ---------------------------------------------------------------------
    if (msg.type === 'getCaptures') {
      // 現在のダッシュボードに属するキャプチャだけを返す。
      // dashboardKey が無い (旧バージョンで取得したもの) は念のため通す。
      const currentKey = getDashboardKey();
      const list = [].concat(
        Array.from(captures.values()),
        orphans
      ).filter(function (c) {
        if (!c.dashboardKey) return true;
        return c.dashboardKey === currentKey;
      }).sort(function (a, b) {
        return b.timestamp - a.timestamp;
      });
      sendResponse({ captures: list });
      return;
    }

    // ---------------------------------------------------------------------
    // ウィジェット情報のみ取得 (可視列ラベル)
    // ---------------------------------------------------------------------
    if (msg.type === 'getWidgetInfo') {
      const widget = findBestWidget(msg.columnLabels);
      if (!widget) {
        sendResponse({ found: false, visibleLabels: [] });
        return;
      }
      sendResponse({
        found: true,
        visibleLabels: collectVisibleHeaders(widget, msg.columnLabels)
      });
      return;
    }

    // ---------------------------------------------------------------------
    // ハイライト
    // ---------------------------------------------------------------------
    if (msg.type === 'highlightWidget') {
      const widget = findBestWidget(msg.columnLabels);
      if (!widget) {
        sendResponse({ found: false });
        return;
      }
      applyHighlight(widget);
      sendResponse({ found: true });
      return;
    }

    // ---------------------------------------------------------------------
    // ハイライト解除
    // ---------------------------------------------------------------------
    if (msg.type === 'clearHighlight') {
      clearHighlight();
      sendResponse({ ok: true });
      return;
    }
  });
})();
