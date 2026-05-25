/**
 * background.js (Service Worker)
 * ----------------------------------------------------------------------------
 * 役割 : タブの URL に応じて拡張機能アイコンを色付き (アクティブ) と
 *        グレー (非アクティブ) で切り替える。
 *
 * セキュリティ方針 :
 *   - 外部通信なし。読み取るのは tab.url のホスト名のみ。
 *   - storage 等への書き込みなし。
 *   - 例外発生時は黙って無視し、Workato 本体の操作には影響させない。
 * ----------------------------------------------------------------------------
 */

'use strict';

const ICONS_ACTIVE = {
  '16': 'icons/active-16.png',
  '32': 'icons/active-32.png',
  '48': 'icons/active-48.png',
  '128': 'icons/active-128.png'
};

const ICONS_INACTIVE = {
  '16': 'icons/inactive-16.png',
  '32': 'icons/inactive-32.png',
  '48': 'icons/inactive-48.png',
  '128': 'icons/inactive-128.png'
};

/** Workato ドメイン (*.workato.com) かどうかを判定 */
function isWorkatoUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /(^|\.)workato\.com$/.test(u.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * 指定タブのアイコンを更新する。
 * @param {chrome.tabs.Tab} tab
 */
function updateIconForTab(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return;
  const path = isWorkatoUrl(tab.url) ? ICONS_ACTIVE : ICONS_INACTIVE;
  try {
    chrome.action.setIcon({ tabId: tab.id, path: path }, function () {
      // lastError は意図的に読み捨て (タブが既に閉じられた等の競合エラー対策)
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // 想定外エラーも無視
  }
}

// ----- イベント -----

// タブの URL 変更・ロード完了時
chrome.tabs.onUpdated.addListener(function (_tabId, changeInfo, tab) {
  // URL 変更 または ロード完了の瞬間のみ反応 (過剰な setIcon 呼び出しを避ける)
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateIconForTab(tab);
  }
});

// アクティブタブ切替時
chrome.tabs.onActivated.addListener(function (activeInfo) {
  chrome.tabs.get(activeInfo.tabId, function (tab) {
    if (chrome.runtime.lastError) return;
    updateIconForTab(tab);
  });
});

// 拡張の起動 / インストール時に既存の全タブへ反映
function refreshAllTabs() {
  chrome.tabs.query({}, function (tabs) {
    if (chrome.runtime.lastError) return;
    for (let i = 0; i < tabs.length; i++) updateIconForTab(tabs[i]);
  });
}

chrome.runtime.onInstalled.addListener(refreshAllTabs);
chrome.runtime.onStartup.addListener(refreshAllTabs);
