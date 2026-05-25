/**
 * popup.js
 * ----------------------------------------------------------------------------
 * 実行コンテキスト : 拡張機能のポップアップ (popup.html) 内
 * 役割            :
 *   - アクティブタブの content script からキャプチャを取得し UI に描画
 *   - 各カードに 3 アクション: ハイライト / 全列 CSV / 表示列のみ CSV
 *   - ラベル (queryId -> 任意の表示名) を chrome.storage.local に永続化
 *
 * セキュリティ方針 :
 *   - すべての描画は textContent / DOM API で行い、innerHTML を使わない
 *   - 外部ネットワーク通信は行わない (Blob によるローカル DL のみ)
 *   - ラベルは chrome.storage.local (同期なし) にのみ保存し、文字数を制限する
 * ----------------------------------------------------------------------------
 */

(function () {
  'use strict';

  // ==========================================================================
  // 要素参照
  // ==========================================================================
  const listEl = document.getElementById('list');
  const refreshBtn = document.getElementById('refresh');

  // ==========================================================================
  // 状態キャッシュ
  //   常に「現在のページで表示中のテーブル」のみを表示する。Insights の別タブに
  //   移動した場合、前タブのウィジェットは DOM から消えるため自動的にリストから
  //   外れる。明示的なクリア操作は不要 (ページリロードで完全リセット可能)。
  // ==========================================================================
  const state = {
    /** 最新キャプチャ一覧 */
    captures: [],
    /** 各キャプチャに対応する可視ラベル Set (検出失敗 = 非表示扱い) */
    visibilityMaps: [],
    /** 永続ラベル ({queryId -> string}) */
    labels: {}
  };

  // ==========================================================================
  // 定数
  // ==========================================================================
  const LABEL_MAX_LEN = 100;
  const LABEL_STORAGE_KEY = 'labels';
  const FILENAME_MAX_LEN = 80;
  const FLASH_FEEDBACK_MS = 1500;
  const POPUP_CLOSE_DELAY_MS = 250;

  // ==========================================================================
  // タブ / URL ユーティリティ
  // ==========================================================================

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  function isWorkatoUrl(url) {
    try {
      const u = new URL(url);
      return /(^|\.)workato\.com$/.test(u.hostname);
    } catch (e) {
      return false;
    }
  }

  // ==========================================================================
  // ラベル永続化 (chrome.storage.local)
  // ==========================================================================

  async function getLabels() {
    const r = await chrome.storage.local.get(LABEL_STORAGE_KEY);
    const labels = r && r[LABEL_STORAGE_KEY];
    return (labels && typeof labels === 'object') ? labels : {};
  }

  async function setLabel(queryId, label) {
    if (typeof queryId !== 'string' || queryId.length === 0) return;
    const labels = await getLabels();
    const trimmed = (label || '').trim().slice(0, LABEL_MAX_LEN);
    if (trimmed) {
      labels[queryId] = trimmed;
    } else {
      delete labels[queryId];
    }
    await chrome.storage.local.set({ [LABEL_STORAGE_KEY]: labels });
  }

  // ==========================================================================
  // content script との通信
  // ==========================================================================

  /**
   * content script にメッセージを送信する汎用ヘルパ。
   * content script 未注入 / 通信エラーの場合は null を返す。
   *
   * @param {number} tabId
   * @param {object} message
   * @returns {Promise<any|null>}
   */
  function sendToContent(tabId, message) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, message, function (resp) {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function loadCaptures(tabId) {
    const resp = await sendToContent(tabId, { type: 'getCaptures' });
    if (resp === null) return null;
    return Array.isArray(resp.captures) ? resp.captures : [];
  }

  // ==========================================================================
  // CSV 変換
  // ==========================================================================

  /** CSV フィールドのエスケープ (RFC 4180 準拠) */
  function csvEscape(v) {
    if (v === null || v === undefined) return '';

    let s;
    if (typeof v === 'string') {
      s = v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      s = String(v);
    } else {
      // 配列・オブジェクトは JSON 文字列化して安全に格納
      s = JSON.stringify(v);
    }

    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * Insights のレスポンス (列指向) を CSV 文字列に変換する。
   * Excel での文字化け回避のため先頭に UTF-8 BOM を付与する。
   *
   * @param {object} capture
   * @param {number[]|null} columnIndices フィルタしたい列インデックス (null なら全列)
   * @returns {string}
   */
  function toCSV(capture, columnIndices) {
    const indices = (Array.isArray(columnIndices) && columnIndices.length > 0)
      ? columnIndices
      : capture.columns.map(function (_, i) { return i; });

    const headers = indices.map(function (i) {
      const c = capture.columns[i];
      return csvEscape(c && c.label);
    });

    const cols = capture.data;
    const rowCount = (cols[0] && cols[0].length) || 0;

    const lines = [headers.join(',')];
    for (let i = 0; i < rowCount; i++) {
      const row = indices.map(function (colIdx) {
        const col = cols[colIdx];
        return csvEscape(col ? col[i] : null);
      });
      lines.push(row.join(','));
    }

    // U+FEFF (BOM) + CRLF 区切り
    return '﻿' + lines.join('\r\n');
  }

  /**
   * 表示列ラベル配列から、capture.columns 上のインデックス配列を求める。
   * 元の列順を維持する。
   *
   * @param {object} capture
   * @param {string[]} visibleLabels
   * @returns {number[]}
   */
  function visibleLabelsToIndices(capture, visibleLabels) {
    if (!Array.isArray(visibleLabels) || visibleLabels.length === 0) return [];
    const want = new Set(visibleLabels.map(normalizeLabel));
    const indices = [];
    for (let i = 0; i < capture.columns.length; i++) {
      const c = capture.columns[i];
      const label = (c && c.label) ? normalizeLabel(c.label) : '';
      if (label && want.has(label)) indices.push(i);
    }
    return indices;
  }

  function safeFilenamePart(name) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>| -]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, FILENAME_MAX_LEN);
    return cleaned || 'workato-insights';
  }

  function dateStamp() {
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return (
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '_' +
      pad(d.getHours()) +
      pad(d.getMinutes())
    );
  }

  function downloadCSV(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // メモリリーク回避のため少し遅延して URL を解放
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ==========================================================================
  // データ型 → CSS クラス
  // ==========================================================================

  function typeClass(t) {
    const s = String(t || '').toLowerCase();
    if (s === 'varchar' || s === 'string' || s === 'text') return 'type-varchar';
    if (s === 'bigint' || s === 'long') return 'type-bigint';
    if (s === 'int' || s === 'integer' || s === 'smallint') return 'type-int';
    if (s === 'double' || s === 'float' || s === 'decimal' || s === 'numeric') return 'type-double';
    if (s === 'timestamp' || s === 'datetime') return 'type-timestamp';
    if (s === 'date') return 'type-date';
    if (s === 'boolean' || s === 'bool') return 'type-boolean';
    return 'type-default';
  }

  // ==========================================================================
  // 描画ヘルパ
  // ==========================================================================

  function renderEmpty(message, icon) {
    listEl.textContent = '';

    const div = document.createElement('div');
    div.className = 'empty';

    if (icon) {
      const ic = document.createElement('div');
      ic.className = 'empty-icon';
      ic.textContent = icon;
      div.appendChild(ic);
    }

    const textWrap = document.createElement('div');
    message.split('\n').forEach(function (line, i) {
      if (i > 0) textWrap.appendChild(document.createElement('br'));
      textWrap.appendChild(document.createTextNode(line));
    });
    div.appendChild(textWrap);

    listEl.appendChild(div);
  }

  /**
   * state に基づきリスト本体を描画。
   * content script 側で既にダッシュボード単位で絞り込まれた結果が state.captures に
   * 入っているため、ここでは追加の絞り込みは行わない (vmap はチップ色付けにのみ使用)。
   * 通信は伴わず、キャッシュからのみ再描画する。
   */
  function renderList() {
    listEl.textContent = '';

    if (state.captures.length === 0) {
      renderEmpty(
        'このダッシュボードでキャプチャされたデータがありません。\nテーブルを表示・スクロール・フィルタ操作してから「更新」を押してください。',
        '📊'
      );
      return;
    }

    state.captures.forEach(function (cap, i) {
      const labelText = cap.queryId ? (state.labels[cap.queryId] || '') : '';
      const vmap = state.visibilityMaps[i];
      listEl.appendChild(buildItem(cap, labelText, vmap));
    });
  }

  /** ボタンに一時的にフィードバック文言を表示し、自動復元する */
  function flashButton(btn, tempText, ms) {
    const orig = btn.textContent;
    btn.textContent = tempText;
    btn.disabled = true;
    setTimeout(function () {
      btn.textContent = orig;
      btn.disabled = false;
    }, ms || FLASH_FEEDBACK_MS);
  }

  /** capture から正規のラベル文字列配列を取り出す */
  function extractLabels(cap) {
    const out = [];
    if (!cap || !Array.isArray(cap.columns)) return out;
    for (let i = 0; i < cap.columns.length; i++) {
      const c = cap.columns[i];
      if (c && typeof c.label === 'string' && c.label.length > 0) {
        out.push(c.label);
      }
    }
    return out;
  }

  /** ラベルの正規化 (content.js の normalizeLabel と一致させる) */
  function normalizeLabel(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  /**
   * 各キャプチャに対応する可視列ラベル集合を取得する。
   * - ウィジェット検出に成功: Set<string> (正規化済み) を返す
   * - 検出失敗 or queryId 無し: null (= 判定不能)
   *
   * @param {number} tabId
   * @param {object[]} captures
   * @returns {Promise<(Set<string>|null)[]>}
   */
  async function fetchVisibilityMaps(tabId, captures) {
    const tasks = captures.map(function (cap) {
      const labels = extractLabels(cap);
      if (labels.length === 0) return Promise.resolve(null);
      return sendToContent(tabId, {
        type: 'getWidgetInfo',
        columnLabels: labels
      }).then(function (resp) {
        if (!resp || !resp.found || !Array.isArray(resp.visibleLabels)) return null;
        const set = new Set();
        for (let i = 0; i < resp.visibleLabels.length; i++) {
          set.add(normalizeLabel(resp.visibleLabels[i]));
        }
        return set;
      });
    });
    return Promise.all(tasks);
  }

  // ==========================================================================
  // 1 件分のカードを構築
  // ==========================================================================

  /**
   * 1 件のキャプチャを表すカード DOM を生成する。
   *
   * @param {object} cap キャプチャ
   * @param {string} labelText ユーザーが付けたラベル
   * @param {Set<string>|null} visibleSet 正規化済み可視ラベル集合 (null = 判定不能)
   * @returns {HTMLElement}
   */
  function buildItem(cap, labelText, visibleSet) {
    const item = document.createElement('div');
    item.className = 'item';

    // ----------------------------------------------------------------------
    // (1) ラベル入力行
    // ----------------------------------------------------------------------
    const labelRow = document.createElement('div');
    labelRow.className = 'item-label-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = LABEL_MAX_LEN;
    input.value = labelText || '';

    if (cap.queryId) {
      input.placeholder = '(ラベル未設定 — 名前を付けると次回も表示されます)';
      input.addEventListener('change', function () {
        setLabel(cap.queryId, input.value).catch(function () { /* noop */ });
      });
    } else {
      input.placeholder = '(query.id 無しのキャプチャ — ラベル保存不可)';
      input.disabled = true;
    }
    labelRow.appendChild(input);
    item.appendChild(labelRow);

    // ----------------------------------------------------------------------
    // (2) メタ行
    // ----------------------------------------------------------------------
    const meta = document.createElement('div');
    meta.className = 'item-meta';

    const colCount = Array.isArray(cap.columns) ? cap.columns.length : 0;
    const sizeBadge = document.createElement('span');
    sizeBadge.className = 'meta-badge';
    sizeBadge.textContent = cap.rowCount + ' 行 × ' + colCount + ' 列';
    meta.appendChild(sizeBadge);

    if (cap.hasMoreRows) {
      const warnBadge = document.createElement('span');
      warnBadge.className = 'meta-badge warn';
      warnBadge.textContent = '⚠ 続きあり';
      meta.appendChild(warnBadge);
    }

    if (cap.queryId) {
      const qid = document.createElement('span');
      qid.className = 'qid';
      qid.textContent = cap.queryId;
      meta.appendChild(qid);
    }

    const timeEl = document.createElement('span');
    timeEl.className = 'meta-time';
    timeEl.textContent = new Date(cap.timestamp).toLocaleTimeString();
    meta.appendChild(timeEl);

    item.appendChild(meta);

    // ----------------------------------------------------------------------
    // (3) 列名チップ
    //     visibleSet が与えられている場合は chip-visible / chip-hidden を付与し
    //     UI 上での表示有無を視覚的に区別する。
    // ----------------------------------------------------------------------
    const cols = document.createElement('div');
    cols.className = 'item-cols';
    cap.columns.forEach(function (c) {
      const label = (c && c.label) ? String(c.label) : '';
      if (!label) return;

      const chip = document.createElement('span');
      const classes = ['col-chip', typeClass(c && c.type)];

      if (visibleSet) {
        if (visibleSet.has(normalizeLabel(label))) {
          classes.push('chip-visible');
        } else {
          classes.push('chip-hidden');
        }
      }

      chip.className = classes.join(' ');
      chip.textContent = label;

      const titleParts = [];
      if (c && c.type) titleParts.push(String(c.type));
      if (visibleSet) {
        titleParts.push(
          visibleSet.has(normalizeLabel(label))
            ? '表示中'
            : 'UI 上で非表示'
        );
      }
      if (titleParts.length > 0) chip.title = titleParts.join(' / ');

      cols.appendChild(chip);
    });
    item.appendChild(cols);

    // ----------------------------------------------------------------------
    // (4) アクションボタン
    // ----------------------------------------------------------------------
    const actions = document.createElement('div');
    actions.className = 'item-actions';

    // 🔍 ハイライト
    const hlBtn = document.createElement('button');
    hlBtn.className = 'btn btn-secondary';
    hlBtn.textContent = '🔍 ハイライト';
    hlBtn.title = 'ページ上の該当ウィジェットを 3 秒間ハイライトします';
    hlBtn.addEventListener('click', async function () {
      const labels = extractLabels(cap);
      const tab = await getActiveTab();
      if (!tab || !tab.id) return;

      const resp = await sendToContent(tab.id, {
        type: 'highlightWidget',
        columnLabels: labels
      });

      if (resp && resp.found) {
        flashButton(hlBtn, '✓ 表示中', 1000);
        // ポップアップを閉じて画面の該当箇所を見やすくする
        setTimeout(function () { window.close(); }, POPUP_CLOSE_DELAY_MS);
      } else {
        flashButton(hlBtn, '✗ 見つかりません', FLASH_FEEDBACK_MS);
      }
    });
    actions.appendChild(hlBtn);

    // ⬇ 全列 CSV
    const dlAllBtn = document.createElement('button');
    dlAllBtn.className = 'btn btn-secondary';
    dlAllBtn.textContent = '⬇ 全列 CSV';
    dlAllBtn.title = 'API レスポンス上のすべての列を含めて CSV 出力します';
    dlAllBtn.addEventListener('click', function () {
      const enteredLabel = input.value.trim();
      const base = enteredLabel || cap.queryId || 'workato-insights';
      try {
        downloadCSV(
          safeFilenamePart(base) + '_all_' + dateStamp() + '.csv',
          toCSV(cap, null)
        );
      } catch (e) {
        flashButton(dlAllBtn, '✗ 失敗', FLASH_FEEDBACK_MS);
      }
    });
    actions.appendChild(dlAllBtn);

    // ⬇ 表示列のみ CSV
    const dlVisBtn = document.createElement('button');
    dlVisBtn.className = 'btn btn-primary';
    dlVisBtn.textContent = '⬇ 表示列のみ CSV';
    dlVisBtn.title = 'ページ上で見えている列だけを含めて CSV 出力します';
    dlVisBtn.addEventListener('click', async function () {
      const labels = extractLabels(cap);
      const tab = await getActiveTab();
      if (!tab || !tab.id) {
        flashButton(dlVisBtn, '✗ タブ取得失敗', FLASH_FEEDBACK_MS);
        return;
      }

      const resp = await sendToContent(tab.id, {
        type: 'getWidgetInfo',
        columnLabels: labels
      });

      if (!resp || !resp.found) {
        flashButton(dlVisBtn, '✗ ウィジェット未検出', FLASH_FEEDBACK_MS);
        return;
      }

      const visibleLabels = Array.isArray(resp.visibleLabels) ? resp.visibleLabels : [];
      const indices = visibleLabelsToIndices(cap, visibleLabels);

      if (indices.length === 0) {
        flashButton(dlVisBtn, '✗ 可視列なし', FLASH_FEEDBACK_MS);
        return;
      }

      const enteredLabel = input.value.trim();
      const base = enteredLabel || cap.queryId || 'workato-insights';
      try {
        downloadCSV(
          safeFilenamePart(base) + '_visible_' + dateStamp() + '.csv',
          toCSV(cap, indices)
        );
      } catch (e) {
        flashButton(dlVisBtn, '✗ 失敗', FLASH_FEEDBACK_MS);
      }
    });
    actions.appendChild(dlVisBtn);

    item.appendChild(actions);

    return item;
  }

  // ==========================================================================
  // メイン描画
  // ==========================================================================

  /**
   * popup を全面再描画する。content script と通信して最新キャプチャ・可視判定を
   * 取り直し、state にキャッシュした上で filterBar / list を描画する。
   * フィルタ切替時はこの関数ではなく renderFilterBar / renderList を直接呼ぶ。
   */
  async function render() {
    // 描画前にキャッシュリセット (描画が空状態で終わる経路でも state を綺麗に保つ)
    state.captures = [];
    state.visibilityMaps = [];

    const tab = await getActiveTab();

    if (!tab || !isWorkatoUrl(tab.url)) {
      renderEmpty('Workato (*.workato.com) のタブで開いてください。', '🔌');
      return;
    }

    const captures = await loadCaptures(tab.id);
    if (captures === null) {
      renderEmpty(
        'このページにはまだ拡張が注入されていません。\nページをリロードしてから、再度この拡張アイコンを押してください。',
        '🔄'
      );
      return;
    }

    if (captures.length === 0) {
      renderEmpty(
        'キャプチャされたデータがありません。\nInsightsダッシュボードでテーブルを表示・スクロール・フィルタ操作してから「更新」を押してください。',
        '📊'
      );
      return;
    }

    // 各キャプチャに対応する可視列ラベルを並列取得
    // (ウィジェット未検出 = "現在のページ" 以外と判定。null として保持)
    const visibilityMaps = await fetchVisibilityMaps(tab.id, captures);
    const labels = await getLabels();

    state.captures = captures;
    state.visibilityMaps = visibilityMaps;
    state.labels = labels;

    renderList();
  }

  // ==========================================================================
  // イベントバインド
  // ==========================================================================

  refreshBtn.addEventListener('click', function () {
    render().catch(function () { /* noop */ });
  });

  // 初回描画
  render().catch(function () { /* noop */ });
})();
