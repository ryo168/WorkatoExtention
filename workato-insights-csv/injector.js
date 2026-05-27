/**
 * injector.js
 * ----------------------------------------------------------------------------
 * 実行コンテキスト : ページの MAIN world (manifest の content_scripts で指定)
 * 役割            : Workato Insights が発行する Crow-QL リクエストの fetch/XHR
 *                   をフックし、レスポンス JSON を content script へ転送する。
 *
 * セキュリティ方針 :
 *   - 既存リクエストの「観測のみ」を行い、追加のネットワーク通信は一切発生
 *     させない (response.clone() でクローンしてから JSON を読む)。
 *   - エラーは握りつぶし、Workato 本体の動作には影響させない。
 *   - 外部に postMessage しない。target origin は '*' だが宛先は同一ウィンドウ
 *     なので外部から参照される経路は存在しない。
 *   - eval / new Function / 動的 script 生成は一切行わない。
 *   - 取得対象 URL は ENDPOINT_RE で厳格に絞り込む。
 * ----------------------------------------------------------------------------
 */

(function () {
  'use strict';

  /** Workato Insights のチャートデータ取得エンドポイント (POST) */
  const ENDPOINT_RE = /\/insights\/crow-ql\/api\/v2\/execute/;

  /**
   * レイアウト API の URL は環境/バージョン差があるため URL では絞らない。
   * 代わりに全 JSON レスポンスの形を覗き、layout 構造を含むものだけ採用する。
   * これは『同じ列名のテーブルが複数ある』ケースで text 一致が使えないため、
   * queryId → data-id を必ず取りたいことから、漏れの少ない方針にしている。
   */

  /** content script との通信に用いる固定タグ (postMessage 偽装対策) */
  const MESSAGE_SOURCE = 'wkt-csv-ext';

  /**
   * 診断ログ。Workato 側のエンドポイント変更や Angular の内部構造変更で
   * 動作不能になった際、ユーザが DevTools コンソールで何が起きてるか
   * 即座に判別できるよう、目印付きで出力する。
   * 性能上の影響はほぼ無いので常時有効としている。
   */
  function debug() {
    try {
      const args = Array.prototype.slice.call(arguments);
      args.unshift('[wkt-csv]');
      // eslint-disable-next-line no-console
      console.debug.apply(console, args);
    } catch (e) { /* noop */ }
  }

  /**
   * 現在のページがどの Insights ダッシュボードを表示しているかを示す識別子。
   *   - `?handle=idb-XXX` (Workato Insights の標準)
   *   - `/dashboards/idb-XXX` (パスベース URL)
   *   - 上記いずれも無ければ pathname をそのまま使用
   * これを各キャプチャに付与しておき、popup 側で現在のダッシュボードに属する
   * キャプチャのみを表示する。
   *
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

  // --------------------------------------------------------------------------
  // ユーティリティ
  // --------------------------------------------------------------------------

  /**
   * 同一ウィンドウ内の content script (ISOLATED world) へキャプチャを通知する。
   * @param {object} payload キャプチャしたデータ
   */
  function postCapture(payload) {
    window.postMessage(
      { source: MESSAGE_SOURCE, type: 'capture', payload: payload },
      '*'
    );
  }

  /**
   * ダッシュボードレイアウトから取り出した queryId → widgetId 対応を通知する。
   * @param {{dashboardKey: string, mappings: {queryId: string, widgetId: string}[]}} payload
   */
  function postLayout(payload) {
    window.postMessage(
      { source: MESSAGE_SOURCE, type: 'layout', payload: payload },
      '*'
    );
  }

  /**
   * レスポンスがダッシュボードレイアウト JSON っぽいか判定。
   * URL を頼らない都合で形で見るが、Workato 側で複数バージョン/エンドポイントが
   * あるため、以下のいずれかに該当すれば候補として扱う。
   *   - result が配列で、要素のどれかが content.layout を持つ
   *   - 自身が content.layout を持つ (単一ダッシュボード取得)
   *   - 自身が type === 'dashboard' と layout を持つ
   */
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

  /**
   * レイアウト JSON を再帰的に走査し、queryId を持つウィジェット (= type:"dashboard")
   * の { widgetId, queryId, title, name } を全て収集する。
   * title は settings.title (UI 上の表示タイトル)、name は widget.name
   * (Workato エディタ内部の名称) を補助として持つ。
   *
   * 構造例: layout = [colCount, [widget, _], [widget, _], ...]
   *         widget = { id, queryId, name, settings:{ title, ... }, layout?, ... }
   */
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

  /**
   * Workato Insights のレスポンス形式に合致するかを判定する。
   * @param {*} json レスポンス JSON
   * @returns {boolean}
   */
  function looksLikeInsightsResponse(json) {
    return (
      json &&
      Array.isArray(json.columns) &&
      Array.isArray(json.data) &&
      json.columns.length > 0
    );
  }

  /**
   * キャプチャ用のペイロードを生成する。
   * @param {{queryId: string|null, url: string, method: string, json: object}} args
   * @returns {object}
   */
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

  /**
   * リクエストボディから Workato のクエリ ID (UUID) を抽出する。
   * body は string でも object でも受け付ける。
   * @param {string|object|null|undefined} body
   * @returns {string|null}
   */
  function extractQueryId(body) {
    if (!body) return null;
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      return (parsed && parsed.query && parsed.query.id) || null;
    } catch (e) {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // fetch フック
  // --------------------------------------------------------------------------

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
        // 解析失敗時はキャプチャ対象外として処理を続行
      }

      const isQueryTarget = ENDPOINT_RE.test(url);
      const queryId = isQueryTarget ? extractQueryId(bodyForId) : null;

      // 元の fetch をそのまま実行 (副作用ゼロを担保)
      const promise = originalFetch.apply(this, arguments);

      return promise.then(
        function (response) {
          // response.clone() でクローンを取得し、元のレスポンスは一切消費しない
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
                // クエリ以外の JSON は全部レイアウト候補として形だけチェック
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
          // 元のエラーをそのまま伝搬
          throw err;
        }
      );
    };
  }

  // --------------------------------------------------------------------------
  // XMLHttpRequest フック (jQuery / 旧 SDK 経由のリクエストに備える)
  // --------------------------------------------------------------------------

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
        // JSON ぽくないものは早期除外
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

  /**
   * 任意の JSON にレイアウト構造が含まれていれば mappings を抽出して通知する。
   * URL を頼りにせず、形だけで判定するためここに集約する。
   */
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

  // --------------------------------------------------------------------------
  // Angular コンポーネントからの queryId 直接取得 (最終手段)
  //
  // レイアウト API が何らかの事情でフックを通らない / Capture の queryId と
  // レイアウト上の queryId が別形式 / 等のケースに備える独立した経路。
  // MAIN world からのみ Angular の __ngContext__ 内部に到達できるため、
  // ここ (injector) で実装する。content script は postMessage で要求する。
  // --------------------------------------------------------------------------

  /**
   * DOM 要素から Angular コンポーネントインスタンスを取得し、深く走査して
   * queryId 文字列を取り出す。Angular Ivy の __ngContext__ は配列で、その
   * どこかにコンポーネントインスタンスや入力プロパティが入っている。
   * 構造が不明瞭なので key の名称を頼りに広く探す。
   *
   * @param {Element} el
   * @returns {string|null}
   */
  function readWidgetQueryId(el) {
    if (!el) return null;
    const ctx = el.__ngContext__;
    if (ctx == null) return null;
    return deepFindString(ctx, 'queryId');
  }

  /**
   * 任意のオブジェクトツリーを再帰的に走査し、指定 key に文字列値が見つかれば返す。
   * 巡回・深さ・分岐数を制限し暴走を防ぐ。
   */
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
          // 巡回しがちな循環キーは間引く
          if (k === 'parent' || k === '__ngContext__' || k === 'host' || k === 'previousSibling' || k === 'nextSibling') continue;
          stack.push({ node: node[k], depth: depth + 1 });
        }
      }
    }
    return null;
  }

  /**
   * 全 lcap-dashboard-widget を走査して queryId → widgetId を構築し、
   * content script に送信する。レイアウト API を捕まえられない時の保険。
   *
   * @returns {number} 抽出できたマッピング数
   */
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

  // content script からの問い合わせを受けて DOM スキャンを実行
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== MESSAGE_SOURCE) return;
    if (msg.type !== 'request-dom-mapping') return;
    emitMappingsFromDom();
  });
})();
