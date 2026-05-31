/**
 * injector.js  (MAIN world)
 * Workato Insights の Crow-QL リクエスト (fetch/XHR) をフックし、レスポンス JSON を
 * content script へ転送する。観測のみで追加通信はしない (response.clone() で読む)。
 */

(function () {
  'use strict';

  /** Workato Insights のチャートデータ取得エンドポイント (POST) */
  const ENDPOINT_RE = /\/insights\/crow-ql\/api\/v2\/execute/;

  // レイアウト API は環境/バージョンで URL が変わるため URL では絞らず、
  // 全 JSON レスポンスの形を見て layout 構造を含むものだけ採用する。

  /** content script との通信タグ (postMessage 偽装対策) */
  const MESSAGE_SOURCE = 'wkt-csv-ext';

  // エンドポイント変更や Angular の内部構造変更で動作不能になった際に
  // DevTools で原因を追えるよう、目印付きで常時出力する。
  function debug() {
    try {
      const args = Array.prototype.slice.call(arguments);
      args.unshift('[wkt-csv]');
      // eslint-disable-next-line no-console
      console.debug.apply(console, args);
    } catch (e) { /* noop */ }
  }

  // 表示中の Insights ダッシュボード識別子。各キャプチャに付与し、popup 側で
  // 現在のダッシュボードに属するものだけ表示するために使う。
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

  // --- 通信 ---

  // targetOrigin は '*' だが宛先は同一ウィンドウ (event.source === window で検証)
  // のため外部から参照される経路はない。
  function postCapture(payload) {
    window.postMessage(
      { source: MESSAGE_SOURCE, type: 'capture', payload: payload },
      '*'
    );
  }

  function postLayout(payload) {
    window.postMessage(
      { source: MESSAGE_SOURCE, type: 'layout', payload: payload },
      '*'
    );
  }

  // レスポンスがダッシュボードレイアウト JSON っぽいか形で判定する
  // (Workato 側に複数バージョン/エンドポイントがあるため URL を頼らない)。
  function looksLikeLayoutResponse(json) {
    if (!json || typeof json !== 'object') return false;
    if (Array.isArray(json.result)) {
      for (let i = 0; i < json.result.length; i++) {
        const r = json.result[i];
        if (r && r.content && r.content.layout) return true;
      }
      return false;
    }
    if (json.content && json.content.layout) return true;
    if (json.type === 'dashboard' && json.layout) return true;
    return false;
  }

  // レイアウト JSON を再帰走査し、queryId を持つウィジェットの
  // { widgetId, queryId, title, name } を全て収集する。
  // title=settings.title (UI 表示名), name=widget.name (エディタ内部名)。
  function collectWidgetMappings(node, acc) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) collectWidgetMappings(node[i], acc);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.id === 'string' && typeof node.queryId === 'string') {
        const m = { widgetId: node.id, queryId: node.queryId };
        if (node.settings && typeof node.settings.title === 'string') m.title = node.settings.title;
        if (typeof node.name === 'string') m.name = node.name;
        acc.push(m);
      }
      if (node.layout) collectWidgetMappings(node.layout, acc);
      if (node.content) collectWidgetMappings(node.content, acc);
      if (Array.isArray(node.result)) collectWidgetMappings(node.result, acc);
    }
  }

  // Workato Insights のチャートデータ形式 (columns[] + data[]) か判定する
  function looksLikeInsightsResponse(json) {
    return (
      json &&
      Array.isArray(json.columns) &&
      Array.isArray(json.data) &&
      json.columns.length > 0
    );
  }

  function buildPayload(args) {
    const json = args.json;
    const firstColumn = json.data[0];
    return {
      queryId: args.queryId || null,
      url: args.url,
      method: args.method,
      timestamp: Date.now(),
      dashboardKey: getDashboardKey(),
      columns: json.columns,
      data: json.data,
      rowCount: (firstColumn && firstColumn.length) || 0,
      hasMoreRows: !!json.hasMoreRows
    };
  }

  // リクエストボディからクエリ ID (UUID) を抽出する。body は string でも object でも可。
  function extractQueryId(body) {
    if (!body) return null;
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      return (parsed && parsed.query && parsed.query.id) || null;
    } catch (e) {
      return null;
    }
  }

  // --- fetch フック ---

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '';
      let method = 'GET';
      let bodyForId = null;

      try {
        if (typeof input === 'string') {
          url = input;
        } else if (input && typeof input.url === 'string') {
          url = input.url;
          method = input.method || method;
        }
        if (init) {
          method = init.method || method;
          bodyForId = init.body || null;
        }
      } catch (e) {
        // 解析失敗時はキャプチャ対象外として続行
      }

      const isQueryTarget = ENDPOINT_RE.test(url);
      const queryId = isQueryTarget ? extractQueryId(bodyForId) : null;

      // 元の fetch をそのまま実行 (副作用ゼロ)
      const promise = originalFetch.apply(this, arguments);

      return promise.then(
        function (response) {
          // クローンを読み、元のレスポンスは消費しない
          try {
            const cloned = response.clone();
            cloned
              .json()
              .then(function (json) {
                if (isQueryTarget && looksLikeInsightsResponse(json)) {
                  postCapture(
                    buildPayload({
                      queryId: queryId,
                      url: url,
                      method: method,
                      json: json
                    })
                  );
                  return;
                }
                // クエリ以外の JSON はレイアウト候補として形だけチェック
                tryEmitLayout(json);
              })
              .catch(function () {
                // JSON でないレスポンスは無視
              });
          } catch (e) {
            // クローン失敗は無視
          }
          return response;
        },
        function (err) {
          throw err;
        }
      );
    };
  }

  // --- XMLHttpRequest フック (jQuery / 旧 SDK 経由に備える) ---

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__wkt_url = url || '';
      this.__wkt_method = method || 'GET';
      this.__wkt_isQueryTarget = ENDPOINT_RE.test(this.__wkt_url);
    } catch (e) {
      // 失敗してもオリジナル動作は維持
    }
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__wkt_isQueryTarget) this.__wkt_queryId = extractQueryId(body);

    this.addEventListener('load', function () {
      try {
        if (this.status < 200 || this.status >= 300) return;
        const text = this.responseText;
        if (!text || text.length < 2) return;
        const first = text.charAt(0);
        if (first !== '{' && first !== '[') return;

        const json = JSON.parse(text);
        if (this.__wkt_isQueryTarget && looksLikeInsightsResponse(json)) {
          postCapture(
            buildPayload({
              queryId: this.__wkt_queryId,
              url: this.__wkt_url,
              method: this.__wkt_method,
              json: json
            })
          );
          return;
        }
        tryEmitLayout(json);
      } catch (e) {
        // 取得失敗は無視
      }
    });
    return originalSend.apply(this, arguments);
  };

  function tryEmitLayout(json) {
    if (!looksLikeLayoutResponse(json)) return;
    const mappings = [];
    collectWidgetMappings(json, mappings);
    if (mappings.length === 0) return;
    debug('layout captured:', mappings.length, 'mappings', mappings);
    postLayout({
      dashboardKey: getDashboardKey(),
      mappings: mappings
    });
  }

  // --- Angular コンポーネントからの queryId 直接取得 (最終手段) ---
  // レイアウト API がフックを通らない等のケースに備える独立経路。
  // __ngContext__ への到達は MAIN world でしかできないため injector に置く。

  // DOM 要素の Angular コンポーネント (__ngContext__) を走査して queryId を取り出す。
  // Ivy の __ngContext__ は構造不定の配列なので key 名を頼りに広く探す。
  function readWidgetQueryId(el) {
    if (!el) return null;
    const ctx = el.__ngContext__;
    if (ctx == null) return null;
    return deepFindString(ctx, 'queryId');
  }

  // オブジェクトツリーを再帰走査し、指定 key の文字列値を返す。
  // 深さ・分岐数・巡回を制限して暴走を防ぐ。
  function deepFindString(root, key) {
    const seen = new WeakSet();
    const stack = [{ node: root, depth: 0 }];
    const MAX_DEPTH = 8;
    const MAX_BRANCH = 40;
    while (stack.length > 0) {
      const cur = stack.pop();
      const node = cur.node;
      const depth = cur.depth;
      if (depth > MAX_DEPTH || node == null) continue;
      if (typeof node !== 'object') continue;
      if (seen.has(node)) continue;
      seen.add(node);
      const direct = node[key];
      if (typeof direct === 'string' && direct.length > 0) return direct;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length && i < MAX_BRANCH; i++) {
          stack.push({ node: node[i], depth: depth + 1 });
        }
      } else {
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length && i < MAX_BRANCH; i++) {
          const k = keys[i];
          // 循環しがちなキーは間引く
          if (k === 'parent' || k === '__ngContext__' || k === 'host' || k === 'previousSibling' || k === 'nextSibling') continue;
          stack.push({ node: node[k], depth: depth + 1 });
        }
      }
    }
    return null;
  }

  // 全 lcap-dashboard-widget を走査して queryId → widgetId を構築し送信する。
  // レイアウト API を捕まえられない時の保険。
  function emitMappingsFromDom() {
    const widgets = document.querySelectorAll('lcap-dashboard-widget');
    if (widgets.length === 0) return 0;
    const mappings = [];
    for (let i = 0; i < widgets.length; i++) {
      const w = widgets[i];
      const widgetId = w.getAttribute('data-id');
      if (!widgetId) continue;
      const queryId = readWidgetQueryId(w);
      if (queryId) mappings.push({ widgetId: widgetId, queryId: queryId });
    }
    if (mappings.length > 0) {
      debug('mappings from DOM scan:', mappings.length, mappings);
      postLayout({ dashboardKey: getDashboardKey(), mappings: mappings });
    } else {
      debug('DOM scan found no queryId in', widgets.length, 'widgets');
    }
    return mappings.length;
  }

  // content script からの依頼で DOM スキャンを実行
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== MESSAGE_SOURCE) return;
    if (msg.type !== 'request-dom-mapping') return;
    emitMappingsFromDom();
  });
})();
