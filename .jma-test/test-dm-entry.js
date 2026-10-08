// Daily Matches popup entry (daily/dm-entry.js): which card appears for which
// status, what a click does, and what the requests carry. Runs the real
// jma-auth.js + dm-api.js + dm-entry.js in a jsdom popup; only chrome.* and
// fetch are faked.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const AUTH = read('jma-auth.js');
const API = read('daily/dm-api.js');
const ENTRY = read('daily/dm-entry.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✓ ${name}`); } else { failed++; console.log(`✗ ${name}`); }
  if (detail && !cond) console.log(`    ${detail}`);
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

async function boot({ status, storage = {}, sidePanel = true, fetchFails = false }) {
  const dom = new JSDOM(
    '<div class="header"><div class="header-logo">Job Match AI</div></div>' +
    '<div class="screen active" id="screen-ready"><div class="ready-wrap"><div class="ready-title">מוכן לניתוח</div></div></div>' +
    '<div class="screen" id="screen-main"></div>',
    { runScripts: 'outside-only', url: 'chrome-extension://abc/popup.html' });
  const { window } = dom;
  const log = { fetches: [], sidePanel: [], tabs: [], closed: 0 };
  window.close = () => { log.closed++; };
  window.fetch = (url, opts) => {
    log.fetches.push({ url: String(url), opts });
    if (fetchFails) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status) });
  };
  window.crypto.randomUUID = () => '11111111-2222-3333-4444-555555555555';
  window.chrome = {
    storage: {
      onChanged: { addListener: () => {} },
      local: {
        // Both styles, like the real API: jma-auth.js uses the callback form.
        get: (keys, cb) => {
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) if (storage[k] !== undefined) out[k] = storage[k];
          if (cb) setTimeout(() => cb(out), 0);
          return Promise.resolve(out);
        },
        set: (obj, cb) => { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
      },
    },
    windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
    tabs: { create: (o) => { log.tabs.push(o); return Promise.resolve({ id: 99 }); } },
    runtime: { getURL: (p) => `chrome-extension://abc/${p}` },
  };
  if (sidePanel) window.chrome.sidePanel = { open: (o) => { log.sidePanel.push(o); return Promise.resolve(); } };
  window.eval(AUTH);
  window.eval(API);
  window.eval(ENTRY);
  await tick();
  return { window, doc: window.document, log, storage };
}

const SUB = { enabled: true, entitlement: 'subscription', today: null, pool: { active: 1284, embedded: 1280 } };

(async () => {
  // ── a subscriber who hasn't built today's deck ───────────────────────────────
  let ctx = await boot({ status: SUB, storage: { licenseKey: 'LIC-1', anthropicKey: 'sk-ant-api03-secret', cvText: 'cv' } });
  let hero = ctx.doc.getElementById('jma-dm-hero');
  ok('card is injected at the top of the ready screen', hero && ctx.doc.getElementById('screen-ready').firstElementChild === hero);
  ok('card says new today and shows the pool size',
     hero && hero.querySelector('.dm-pill').textContent === 'חדש להיום' && hero.textContent.includes('1,284'));
  ok('existing ready content is untouched', !!ctx.doc.querySelector('#screen-ready .ready-wrap .ready-title'));

  const req = ctx.log.fetches[0];
  ok('status call goes to the daily-matches endpoint', req && req.url.endsWith('/api/daily-matches/status'));
  ok('request carries the license key and a persisted install id',
     req && req.opts.headers['X-License-Key'] === 'LIC-1' &&
     req.opts.headers['X-JMA-Install-Id'] === '11111111-2222-3333-4444-555555555555' &&
     ctx.storage.jma_dm_install_id === '11111111-2222-3333-4444-555555555555');
  ok('the personal Claude key is never sent', req && !('X-Anthropic-Key' in req.opts.headers),
     req ? Object.keys(req.opts.headers).join(',') : 'no request');

  const strip = ctx.doc.getElementById('jma-dm-strip');
  ok('strip is hidden while the ready screen (with its card) is showing', strip && !strip.classList.contains('is-on'));
  ctx.doc.getElementById('screen-ready').classList.remove('active');
  ctx.doc.getElementById('screen-main').classList.add('active');
  await tick(20);
  ok('strip appears on other screens', strip.classList.contains('is-on'));

  ctx.doc.getElementById('btnDmOpen').click();
  await tick();
  ok('click opens the side panel in the current window', ctx.log.sidePanel.length === 1 && ctx.log.sidePanel[0].windowId === 7);
  ok('click asks the panel to start building', ctx.storage.jma_dm_ui && ctx.storage.jma_dm_ui.autoStartAt > 0);
  ok('popup closes after opening the panel', ctx.log.closed === 1);

  // ── trial, locked, done, running ──────────────────────────────────────────────
  ctx = await boot({ status: { ...SUB, entitlement: 'trial' } });
  ok('trial card offers the free run, highlighted', ctx.doc.querySelector('#jma-dm-hero .dm-pill').textContent.includes('ניסיון חינם') &&
     ctx.doc.getElementById('jma-dm-hero').classList.contains('is-gift'));

  ctx = await boot({ status: { ...SUB, entitlement: 'locked', reason: 'trial_used', last_run: { id: 3 } } });
  ok('locked card is marked for subscribers', ctx.doc.querySelector('#jma-dm-hero .dm-pill').textContent.includes('למנויים'));
  ok('locked users get no strip', !ctx.doc.getElementById('jma-dm-strip'));
  ctx.doc.getElementById('btnDmOpen').click();
  await tick();
  ok('opening the paywall does not request a build', !(ctx.storage.jma_dm_ui && ctx.storage.jma_dm_ui.autoStartAt));

  ctx = await boot({ status: { ...SUB, today: { status: 'done', cards: 12 } } });
  ok('done card shows the deck size', ctx.doc.querySelector('#jma-dm-hero .dm-pill').textContent === '12 בחפיסה');
  ok('no strip once today\'s deck exists', !ctx.doc.getElementById('jma-dm-strip'));

  // ── nothing new when the feature is off or the server is away ─────────────────
  ctx = await boot({ status: { enabled: false, reason: 'off' } });
  ok('disabled feature adds nothing', !ctx.doc.getElementById('jma-dm-hero') && !ctx.doc.getElementById('jma-dm-strip'));
  ctx = await boot({ status: SUB, fetchFails: true });
  ok('unreachable server adds nothing and throws nothing', !ctx.doc.getElementById('jma-dm-hero'));

  // ── dismissed strip stays dismissed today ─────────────────────────────────────
  ctx = await boot({ status: SUB, storage: { jma_dm_ui: { stripDismissedOn: new Date().toDateString() } } });
  ok('a strip dismissed today stays hidden', !ctx.doc.getElementById('jma-dm-strip') && !!ctx.doc.getElementById('jma-dm-hero'));

  // ── older Chrome without the side panel API ───────────────────────────────────
  ctx = await boot({ status: SUB, sidePanel: false });
  ctx.doc.getElementById('btnDmOpen').click();
  await tick();
  ok('without a side panel it opens the deck in a tab',
     ctx.log.tabs.length === 1 && ctx.log.tabs[0].url === 'chrome-extension://abc/daily/daily.html');

  // ── the launch announcement ───────────────────────────────────────────────────
  const TRIAL = { ...SUB, entitlement: 'trial' };
  ctx = await boot({ status: TRIAL });
  let ann = ctx.doc.getElementById('jma-dm-announce');
  ok('someone who can try it sees the announcement', ann && ann.getAttribute('role') === 'dialog' &&
     ann.textContent.includes('ניסיון אחד עלינו') && ann.querySelectorAll('.dm-ann-steps li').length === 3);
  ann.querySelector('[data-ann="go"]').click();
  await tick();
  ok('"try it" opens the deck and starts the free run', ctx.log.sidePanel.length === 1 &&
     ctx.storage.jma_dm_ui.autoStartAt > 0 && ctx.log.closed === 1);

  ctx = await boot({ status: TRIAL });
  ctx.doc.querySelector('.dm-ann-later').click();
  await tick();
  ok('"later" hides it until tomorrow', !ctx.doc.getElementById('jma-dm-announce') &&
     ctx.storage.jma_dm_ui.annDismissedOn === new Date().toDateString());
  const storage = ctx.storage;
  ctx = await boot({ status: TRIAL, storage });
  ok('the same day it stays away, while the card keeps offering the trial',
     !ctx.doc.getElementById('jma-dm-announce') && ctx.doc.getElementById('jma-dm-hero').classList.contains('is-gift'));
  ctx = await boot({ status: TRIAL, storage: { jma_dm_ui: { annDismissedOn: 'Mon Jan 01 2001' } } });
  ok('a new day brings it back until it is tried', !!ctx.doc.getElementById('jma-dm-announce'));

  ctx = await boot({ status: TRIAL });
  ctx.doc.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  ok('Escape closes it', !ctx.doc.getElementById('jma-dm-announce'));

  ctx = await boot({ status: SUB });
  ann = ctx.doc.getElementById('jma-dm-announce');
  ok('subscribers see it once, as part of their plan', ann && ann.textContent.includes('כלול במנוי'));
  ann.querySelector('.dm-ann-x').click();
  await tick();
  ctx = await boot({ status: SUB, storage: ctx.storage });
  ok('and not again after closing it', !ctx.doc.getElementById('jma-dm-announce'));

  ctx = await boot({ status: { ...SUB, entitlement: 'locked', reason: 'trial_used' } });
  ok('no announcement once the free run is used', !ctx.doc.getElementById('jma-dm-announce'));
  ctx = await boot({ status: { ...TRIAL, today: { status: 'done', cards: 3 } } });
  ok('no announcement over a deck that is already waiting', !ctx.doc.getElementById('jma-dm-announce'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
