// A keyless user must not generate doomed 401s in the background.
//
// v2-entry.js fires the CV semantic-map on popup open and on every Save. Before
// this suite existed it fired unconditionally, so saving a CV without a key
// produced two red 401s in the console and no message anywhere the user looks.
// The rule under test: no key configured → no request at all.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'jma-auth.js'), 'utf8');
const ENTRY_SRC = fs.readFileSync(path.join(ROOT, 'v2', 'v2-entry.js'), 'utf8');

const CV = 'Senior Backend Engineer. '.repeat(10) + 'Python, FastAPI, PostgreSQL, Docker. 8 years.';

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✓ ${name}`); } else { failed++; console.log(`✗ ${name}`); }
  if (detail) console.log(`    ${detail}`);
}

/** Loads jma-auth.js + v2-entry.js into a fresh page and records every fetch. */
async function boot(storage) {
  const dom = new JSDOM(
    '<div class="screen active" id="screen-settings">' +
    '<input type="file" id="cvFileInput">' +
    '<button id="btnSaveSettings">save</button>' +
    '<div id="settingsError" style="display:none"></div>' +
    '</div><button id="btnStartAnalysis">start</button>',
    { runScripts: 'outside-only', url: 'https://example.org/' },
  );
  const { window } = dom;
  const calls = [];

  window.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ saved: true, blocks: [1, 2, 3] }),
    });
  };
  const changeListeners = [];
  window.chrome = {
    storage: {
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
      local: {
        get: (keys, cb) => {
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) {
            if (storage[k] !== undefined) out[k] = storage[k];
          }
          if (cb) setTimeout(() => cb(out), 0);
          return Promise.resolve(out);
        },
        set: (obj, cb) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) changes[k] = { oldValue: storage[k], newValue: v };
          Object.assign(storage, obj);
          for (const fn of changeListeners) fn(changes, 'local');
          if (cb) setTimeout(cb, 0);
          return Promise.resolve();
        },
      },
    },
    tabs: { query: () => Promise.resolve([{ id: 1 }]), sendMessage: () => Promise.resolve({ ok: true }) },
    runtime: { sendMessage: () => Promise.resolve({}) },
  };

  window.eval(AUTH_SRC);
  window.eval(ENTRY_SRC);
  await new Promise(r => setTimeout(r, 120));   // let the open-time self-heal settle
  return { window, calls, dom, storage };
}

(async () => {
  // ── popup open, CV saved, no key ───────────────────────────────────────────
  let { calls } = await boot({ cvText: CV });
  ok('popup open with no key sends no semantic-map request', calls.length === 0,
     `fetches=${calls.length}${calls.length ? ' → ' + calls[0].url : ''}`);

  // ── clicking Save with no key ──────────────────────────────────────────────
  let ctx = await boot({ cvText: CV });
  ctx.window.document.getElementById('btnSaveSettings').click();
  await new Promise(r => setTimeout(r, 120));
  ok('saving with no key sends no semantic-map request', ctx.calls.length === 0,
     `fetches=${ctx.calls.length}${ctx.calls.length ? ' → ' + ctx.calls[0].url : ''}`);

  // ── the same click WITH a key must still work ──────────────────────────────
  ctx = await boot({ cvText: CV, anthropicKey: 'sk-ant-api03-test1234567890' });
  ctx.window.document.getElementById('btnSaveSettings').click();
  await new Promise(r => setTimeout(r, 150));
  const mapCalls = ctx.calls.filter(c => c.url.includes('/api/v2/semantic-map'));
  ok('saving WITH a personal key still maps the CV', mapCalls.length >= 1,
     `semantic-map calls=${mapCalls.length}`);
  ok('the request carries the personal key',
     mapCalls.length > 0 && mapCalls[0].opts.headers['X-Anthropic-Key'] === 'sk-ant-api03-test1234567890',
     mapCalls.length ? `headers=${Object.keys(mapCalls[0].opts.headers).join(',')}` : 'no call');

  // ── a subscription key works the same way ──────────────────────────────────
  ctx = await boot({ cvText: CV, licenseKey: 'ABCD-1234-5678-WXYZ' });
  ctx.window.document.getElementById('btnSaveSettings').click();
  await new Promise(r => setTimeout(r, 150));
  ok('saving WITH a subscription key maps the CV',
     ctx.calls.some(c => c.url.includes('/api/v2/semantic-map')),
     `fetches=${ctx.calls.length}`);

  // ── a key arriving later must trigger the map that was skipped ─────────────
  // popup.js verifies a new key over the network before writing it, while this
  // listener reads storage immediately — so "enter a key + upload a CV in one
  // click" skipped the map until the write itself became the trigger.
  ctx = await boot({ cvText: CV });
  ctx.window.document.getElementById('btnSaveSettings').click();
  await new Promise(r => setTimeout(r, 120));
  ok('still quiet while the key is being verified', ctx.calls.length === 0);
  await ctx.window.chrome.storage.local.set({ anthropicKey: 'sk-ant-api03-arrived123456' });
  await new Promise(r => setTimeout(r, 150));
  ok('the map runs as soon as the key is written',
     ctx.calls.some(c => c.url.includes('/api/v2/semantic-map')),
     `fetches=${ctx.calls.length}`);

  // ── no CV means nothing to map, key or not ─────────────────────────────────
  ctx = await boot({ anthropicKey: 'sk-ant-api03-test1234567890' });
  ctx.window.document.getElementById('btnSaveSettings').click();
  await new Promise(r => setTimeout(r, 120));
  ok('no CV means no request even with a key', ctx.calls.length === 0,
     `fetches=${ctx.calls.length}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
