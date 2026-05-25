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

  /** content script との通信に用いる固定タグ (postMessage 偽装対策) */
  const MESSAGE_SOURCE = 'wkt-csv-ext';

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

      const isTarget = ENDPOINT_RE.test(url);
      const queryId = isTarget ? extractQueryId(bodyForId) : null;

      // 元の fetch をそのまま実行 (副作用ゼロを担保)
      const promise = originalFetch.apply(this, arguments);
      if (!isTarget) return promise;

      return promise.then(
        function (response) {
          // response.clone() でクローンを取得し、元のレスポンスは一切消費しない
          try {
            const cloned = response.clone();
            cloned
              .json()
              .then(function (json) {
                if (looksLikeInsightsResponse(json)) {
                  postCapture(
                    buildPayload({
                      queryId: queryId,
                      url: url,
                      method: method,
                      json: json
                    })
                  );
                }
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
      this.__wkt_isTarget = ENDPOINT_RE.test(this.__wkt_url);
    } catch (e) {
      // 失敗してもオリジナル動作は維持
    }
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__wkt_isTarget) {
      this.__wkt_queryId = extractQueryId(body);

      this.addEventListener('load', function () {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const text = this.responseText;
          if (!text) return;

          const json = JSON.parse(text);
          if (looksLikeInsightsResponse(json)) {
            postCapture(
              buildPayload({
                queryId: this.__wkt_queryId,
                url: this.__wkt_url,
                method: this.__wkt_method,
                json: json
              })
            );
          }
        } catch (e) {
          // 取得失敗は無視
        }
      });
    }
    return originalSend.apply(this, arguments);
  };
})();
