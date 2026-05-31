/**
 * background.js (Service Worker)
 * タブの URL に応じて拡張アイコンを active / inactive に切り替える。外部通信なし。
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

function isWorkatoUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /(^|\.)workato\.com$/.test(u.hostname);
  } catch (e) {
    return false;
  }
}

function updateIconForTab(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return;
  const path = isWorkatoUrl(tab.url) ? ICONS_ACTIVE : ICONS_INACTIVE;
  try {
    chrome.action.setIcon({ tabId: tab.id, path: path }, function () {
      // タブが既に閉じられた等の競合エラーは読み捨て
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // 想定外エラーも無視
  }
}

chrome.tabs.onUpdated.addListener(function (_tabId, changeInfo, tab) {
  // URL 変更 / ロード完了の瞬間のみ反応し、過剰な setIcon を避ける
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateIconForTab(tab);
  }
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
  chrome.tabs.get(activeInfo.tabId, function (tab) {
    if (chrome.runtime.lastError) return;
    updateIconForTab(tab);
  });
});

// 起動 / インストール時に既存の全タブへ反映
function refreshAllTabs() {
  chrome.tabs.query({}, function (tabs) {
    if (chrome.runtime.lastError) return;
    for (let i = 0; i < tabs.length; i++) updateIconForTab(tabs[i]);
  });
}

chrome.runtime.onInstalled.addListener(refreshAllTabs);
chrome.runtime.onStartup.addListener(refreshAllTabs);