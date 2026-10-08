// Daily Matches — the service-worker side. Loaded by one importScripts line in
// background.js; nothing else in the worker changes.
//
// Two jobs:
//   1. The toolbar badge "חדש" while someone who can use Daily Matches hasn't
//      opened it yet. V1 uses the same badge for "a recruiter opened your
//      link" (text "NEW"): this one is set only over an empty badge and
//      cleared only when it is still ours, and popup.js lights its tracker dot
//      only for "NEW".
//   2. For the "new" tag on the job-page FAB (daily/dm-fab.js), which can't
//      reach the backend or the side panel itself: the cached status, and
//      opening the deck.
(function (root) {
  'use strict';

  const BADGE = 'חדש';
  const BADGE_COLOR = '#7C3AED';
  const UI_KEY = 'jma_dm_ui';
  const CACHE_KEY = 'jma_dm_status_cache';
  const CACHE_MS = 3 * 60 * 60 * 1000;

  try { importScripts('daily/dm-api.js'); } catch (_) { /* not a worker (tests load it directly) */ }

  async function cachedStatus(force) {
    const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
    if (!force && stored && Date.now() - stored.at < CACHE_MS) return stored.status;
    try {
      const status = await root.JMA_DM.api.status();
      await chrome.storage.local.set({ [CACHE_KEY]: { at: Date.now(), status } });
      return status;
    } catch (_) {
      return stored ? stored.status : null; // server asleep: last known, or nothing
    }
  }

  // Someone who can still discover the feature: it's on, they may use it,
  // and they have never opened the deck.
  async function invited(status) {
    const ui = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
    return !!(status && status.enabled && !status.error && !ui.panelOpened &&
      (status.entitlement === 'trial' || status.entitlement === 'subscription'));
  }

  async function syncBadge(force) {
    const status = await cachedStatus(force);
    const want = await invited(status);
    const current = await chrome.action.getBadgeText({});
    if (want && !current) {
      await chrome.action.setBadgeText({ text: BADGE });
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    } else if (!want && current === BADGE) {
      await chrome.action.setBadgeText({ text: '' });
    }
  }

  async function openDeck(tabId) {
    const ui = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
    await chrome.storage.local.set({ [UI_KEY]: { ...ui, autoStartAt: Date.now() } });
    if (chrome.sidePanel && chrome.sidePanel.open && tabId != null) {
      try {
        await chrome.sidePanel.open({ tabId });
        return 'panel';
      } catch (_) { /* no user gesture reached us, or no side panel: a tab instead */ }
    }
    await chrome.tabs.create({ url: chrome.runtime.getURL('daily/daily.html') });
    return 'tab';
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.action !== 'string' || !msg.action.startsWith('dm')) return false; // V1's messages
    if (msg.action === 'dmFabStatus') {
      cachedStatus(false).then(async (status) => sendResponse({ invited: await invited(status) }))
        .catch(() => sendResponse({ invited: false }));
      return true;
    }
    if (msg.action === 'dmOpenDeck') {
      openDeck(sender.tab && sender.tab.id).then(how => sendResponse({ ok: true, how }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.runtime.onInstalled.addListener(() => { syncBadge(true).catch(() => {}); });
  if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => { syncBadge(false).catch(() => {}); });

  root.JMA_DM = root.JMA_DM || {};
  root.JMA_DM.bg = { BADGE, cachedStatus, invited, syncBadge, openDeck, onMessage };
})(typeof globalThis !== 'undefined' ? globalThis : self);
