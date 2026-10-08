// Daily Matches discovery outside the popup: the "new" tag on the job-page FAB
// (daily/dm-fab.js) and the toolbar badge (daily/dm-bg.js). Real files in
// jsdom; chrome.* is faked.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const FAB = fs.readFileSync(path.join(ROOT, 'daily/dm-fab.js'), 'utf8');
const BG = fs.readFileSync(path.join(ROOT, 'daily/dm-bg.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✓ ${name}`); } else { failed++; console.log(`✗ ${name}`); }
  if (detail && !cond) console.log(`    ${detail}`);
}
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

function fakeStorage(storage) {
  const listeners = [];
  return {
    listeners,
    api: {
      onChanged: { addListener: (fn) => listeners.push(fn) },
      local: {
        get: (keys) => {
          const out = {};
          for (const k of [].concat(keys)) if (storage[k] !== undefined) out[k] = storage[k];
          return Promise.resolve(out);
        },
        set: (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: storage[k], newValue: v }; storage[k] = v; }
          listeners.forEach(fn => fn(changes, 'local'));
          return Promise.resolve();
        },
      },
    },
  };
}

async function page({ invited = true, storage = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main>job</main></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://www.linkedin.com/jobs/view/1' });
  const { window } = dom;
  const sent = [];
  const store = fakeStorage(storage);
  window.chrome = {
    storage: store.api,
    runtime: {
      lastError: undefined,
      sendMessage: (msg, cb) => {
        sent.push(msg.action);
        setTimeout(() => cb(msg.action === 'dmFabStatus' ? { invited } : { ok: true, how: 'panel' }), 0);
      },
    },
  };
  window.eval(FAB);
  const addFab = () => {
    const fab = window.document.createElement('div');
    fab.id = 'jma-fab-wrap';
    fab.innerHTML = '<div id="jma-fab-inner">⚡</div>';
    let fabClicks = 0;
    fab.addEventListener('click', () => { fabClicks++; });
    window.document.body.appendChild(fab);
    return { fab, clicks: () => fabClicks };
  };
  return { window, doc: window.document, sent, storage, store, addFab };
}

(async () => {
  // ── the FAB tag ────────────────────────────────────────────────────────────────
  let p = await page();
  let f = p.addFab();
  await tick(80);
  let tag = p.doc.getElementById('jma-dm-fab-tag');
  ok('a FAB that appears later gets the "new" tag', tag && f.fab.contains(tag) && tag.textContent.includes('חדש'));
  let bubble = p.doc.getElementById('jma-dm-fab-bubble');
  ok('the first FAB of the day opens the explanation by itself', bubble && bubble.textContent.includes('ההתאמות היומיות') &&
     bubble.textContent.includes('ניסיון אחד עלינו'));
  bubble.querySelector('.x').dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
  await tick();
  ok('✕ closes it until tomorrow, the tag stays', !p.doc.getElementById('jma-dm-fab-bubble') &&
     p.storage.jma_dm_ui.fabBubbleDismissedOn === new Date().toDateString() && !!p.doc.getElementById('jma-dm-fab-tag'));
  tag.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
  ok('clicking the tag opens it again, and never clicks the FAB', !!p.doc.getElementById('jma-dm-fab-bubble') && f.clicks() === 0);
  p.doc.querySelector('#jma-dm-fab-bubble .go').dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
  await tick();
  ok('"try it" asks the worker to open the deck', p.sent.includes('dmOpenDeck') && !p.doc.getElementById('jma-dm-fab-bubble') &&
     f.clicks() === 0);

  f.fab.remove();
  await tick();
  f = p.addFab();
  await tick(80);
  ok('a rebuilt FAB (navigation) is tagged again', !!f.fab.querySelector('#jma-dm-fab-tag'));
  ok('without opening the bubble again the same day', !p.doc.getElementById('jma-dm-fab-bubble'));
  ok('the status is asked once per page', p.sent.filter(a => a === 'dmFabStatus').length === 1);

  await p.store.api.local.set({ jma_dm_ui: { ...p.storage.jma_dm_ui, panelOpened: true } });
  await tick();
  ok('opening the deck anywhere removes the tag', !p.doc.getElementById('jma-dm-fab-tag'));

  p = await page({ invited: false });
  p.addFab();
  await tick(80);
  ok('nobody who can\'t use it gets a tag', !p.doc.getElementById('jma-dm-fab-tag') && !p.doc.getElementById('jma-dm-fab-bubble'));

  p = await page({ storage: { jma_dm_ui: { panelOpened: true } } });
  p.addFab();
  await tick(80);
  ok('nor anyone who has opened the deck', !p.doc.getElementById('jma-dm-fab-tag'));

  // ── the worker side ────────────────────────────────────────────────────────────
  async function worker({ status, badge = '', storage = {}, sidePanelFails = false }) {
    const ctx = { badge, tabs: [], panels: [], listeners: {} };
    const store = fakeStorage(storage);
    const g = {
      chrome: {
        storage: store.api,
        action: {
          getBadgeText: () => Promise.resolve(ctx.badge),
          setBadgeText: ({ text }) => { ctx.badge = text; return Promise.resolve(); },
          setBadgeBackgroundColor: () => Promise.resolve(),
        },
        sidePanel: { open: (o) => (sidePanelFails ? Promise.reject(new Error('no gesture')) : (ctx.panels.push(o), Promise.resolve())) },
        tabs: { create: (o) => { ctx.tabs.push(o.url); return Promise.resolve({}); } },
        runtime: {
          getURL: (p2) => `chrome-extension://abc/${p2}`,
          onMessage: { addListener: (fn) => { ctx.listeners.message = fn; } },
          onInstalled: { addListener: (fn) => { ctx.listeners.installed = fn; } },
          onStartup: { addListener: () => {} },
        },
      },
      JMA_DM: { api: { status: () => (status instanceof Error ? Promise.reject(status) : Promise.resolve(status)) } },
    };
    new Function('globalThis', 'self', 'chrome', 'importScripts', BG)(g, g, g.chrome, () => { throw new Error('test'); });
    return { ctx, bg: g.JMA_DM.bg, storage };
  }

  let w = await worker({ status: { enabled: true, entitlement: 'trial' } });
  await w.bg.syncBadge(true);
  ok('the toolbar shows "חדש" to someone who can try it', w.ctx.badge === 'חדש');
  w = await worker({ status: { enabled: true, entitlement: 'trial' }, badge: 'NEW' });
  await w.bg.syncBadge(true);
  ok('it never replaces V1\'s "NEW" (a recruiter opened a link)', w.ctx.badge === 'NEW');
  w = await worker({ status: { enabled: true, entitlement: 'locked' }, badge: 'חדש' });
  await w.bg.syncBadge(true);
  ok('it goes once the person can\'t use it', w.ctx.badge === '');
  w = await worker({ status: { enabled: true, entitlement: 'locked' }, badge: 'NEW' });
  await w.bg.syncBadge(true);
  ok('and it never clears V1\'s badge', w.ctx.badge === 'NEW');
  w = await worker({ status: { enabled: true, entitlement: 'subscription' }, storage: { jma_dm_ui: { panelOpened: true } } });
  await w.bg.syncBadge(true);
  ok('no badge after the deck has been opened', w.ctx.badge === '');

  w = await worker({ status: new Error('asleep'),
    storage: { jma_dm_status_cache: { at: 0, status: { enabled: true, entitlement: 'trial' } } } });
  ok('a sleeping server falls back to the last known status', await w.bg.invited(await w.bg.cachedStatus(true)));

  w = await worker({ status: { enabled: true, entitlement: 'trial' } });
  let reply = null;
  const kept = w.ctx.listeners.message({ action: 'dmOpenDeck' }, { tab: { id: 12 } }, (r) => { reply = r; });
  await tick();
  ok('the FAB\'s "try it" opens the side panel for that tab and starts the run', kept === true && reply.how === 'panel' &&
     w.ctx.panels[0].tabId === 12 && w.storage.jma_dm_ui.autoStartAt > 0);
  w = await worker({ status: { enabled: true, entitlement: 'trial' }, sidePanelFails: true });
  w.ctx.listeners.message({ action: 'dmOpenDeck' }, { tab: { id: 12 } }, (r) => { reply = r; });
  await tick();
  ok('without a side panel, the deck opens in a tab', reply.how === 'tab' && w.ctx.tabs[0].endsWith('daily/daily.html'));
  ok('V1\'s own messages are left alone', w.ctx.listeners.message({ action: 'fetchJobDetails' }, {}, () => {}) === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
