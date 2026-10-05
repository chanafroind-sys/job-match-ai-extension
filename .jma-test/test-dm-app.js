// Daily Matches side panel (daily/dm-app.js and friends) against a scripted
// backend: deck rendering, escaping, keyboard flow, the build stream, PDF text
// caching, paywall routing and both apply paths. Only chrome.* and fetch are fake.
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = ['jma-auth.js', 'daily/dm-docx.js', 'daily/dm-api.js', 'daily/dm-cv-library.js',
  'daily/dm-apply.js', 'daily/dm-app.js'].map(read);

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✓ ${name}`); } else { failed++; console.log(`✗ ${name}`); }
  if (detail && !cond) console.log(`    ${detail}`);
}
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

const CV = 'Noa Levi\nnoa.levi@example.com · 050-123-4567 · linkedin.com/in/noa-levi\n' +
  'Senior backend engineer: Python, Kafka, AWS, microservices. '.repeat(8);

function card(id, score, title, extra = {}) {
  return {
    id, rank: id, match_score: score, vector_score: 0.6, best_cv_id: 'main', user_action: null,
    analysis: {
      match_score: score, best_cv_ref: 'main',
      cv_scores: [{ cv_id: 'main', label: 'Backend', score }, { cv_id: 'v2', label: 'Data', score: score - 20 }],
      requirements: [{ text: 'Python', status: 'met', importance: 'must' },
        { text: 'Kubernetes', status: 'partial', importance: 'must' },
        { text: 'Go', status: 'missing', importance: 'nice' }],
      fit_summary_he: 'התאמה טובה.', cv_choice_reason_he: 'מדגישה Kafka.', top_gap_he: 'חסר Go.',
    },
    job: { title, company: 'Acme', category: 'Backend', seniority: 'Senior', url: `https://jobs.lever.co/acme/${id}`,
      apply_url: `https://jobs.lever.co/acme/${id}/apply`, ats: 'lever', is_new: true, excerpt: 'Requirements: Python' },
    ...extra,
  };
}

const DECK = [
  card(1, 88, 'Senior Backend Engineer <img src=x onerror="window.__pwned=1">'),
  card(2, 72, 'Backend Developer'),
  card(3, 58, 'Data Engineer', { job: { title: 'Data Engineer', company: 'Datavine', category: 'Data', seniority: 'Mid',
    url: 'https://www.datavine.io/jobs/9?gh_jid=9', apply_url: 'https://job-boards.greenhouse.io/datavine/jobs/9',
    ats: 'greenhouse', is_new: false, excerpt: '' } }),
];
const SUB = (today) => ({ enabled: true, entitlement: 'subscription', reason: '', today, pool: { active: 1284, embedded: 1280 },
  next_reset_at: '2026-10-05T00:00:00+03:00' });

async function boot({ statuses, today = { run: { id: 1, status: 'done', pool_size: 1284 }, cards: DECK, entitlement: 'subscription' },
  runEvents = [], storage = {}, injection = null }) {
  const dom = new JSDOM('<main id="dm-app"></main>', { runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'chrome-extension://abc/daily/daily.html' });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  if (!window.crypto || !window.crypto.subtle) Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
  window.__JMA_DM_NO_AUTOBOOT = true;
  const log = { requests: [], tabs: [], scripting: [], downloads: [] };
  const statusQueue = [...statuses];
  const json = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(data))) });
  window.fetch = (url, opts = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace('/api/daily-matches', '');
    log.requests.push({ path: p + u.search, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (p === '/status') return json(statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0]);
    if (p === '/today') return json(today);
    if (p.startsWith('/results/')) return json({ ok: true });
    if (p === '/saved') return json({ cards: [] });
    if (p === '/run') {
      const chunks = runEvents.map(e => `data: ${JSON.stringify(e)}\n\n`).concat(['data: [DONE]\n\n']);
      let i = 0;
      return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({
        read: () => Promise.resolve(i < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[i++]) } : { done: true }),
      }) } });
    }
    return Promise.reject(new Error('unexpected ' + p));
  };
  const listeners = [];
  window.chrome = {
    storage: {
      onChanged: { addListener: (fn) => listeners.push(fn) },
      local: {
        get: (keys, cb) => {
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) if (storage[k] !== undefined) out[k] = storage[k];
          if (cb) setTimeout(() => cb(out), 0);
          return Promise.resolve(out);
        },
        set: (obj) => { Object.assign(storage, obj); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
    },
    tabs: {
      create: (o) => { log.tabs.push(o); return Promise.resolve({ id: 5 }); },
      get: () => Promise.resolve({ id: 5, status: 'complete' }),
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    scripting: { executeScript: (o) => { log.scripting.push(o); return Promise.resolve([{ result: injection }]); } },
    downloads: { download: (o) => { log.downloads.push(o); return Promise.resolve(1); } },
    runtime: { getURL: (p) => `chrome-extension://abc/${p}` },
  };
  for (const src of SCRIPTS) window.eval(src);
  await window.JMA_DM.app.boot();
  await tick();
  return { window, doc: window.document, log, storage, app: window.JMA_DM.app };
}

const key = (window, k) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
const actions = (log) => log.requests.filter(r => r.path.startsWith('/results/')).map(r => `${r.path.split('/')[2]}:${r.body.action}`);

(async () => {
  // ── today's deck ──────────────────────────────────────────────────────────────
  let ctx = await boot({ statuses: [SUB({ status: 'done', cards: 3 })] });
  ok('opens on the deck when today\'s run is done', ctx.app.state.view === 'deck' && ctx.doc.querySelectorAll('.dm-slide').length === 3);
  ok('counter starts at 1 / 3', ctx.doc.getElementById('dmCount').textContent === '1 / 3');
  ok('score ring and V1 verdict render', ctx.doc.querySelector('.ring-num').textContent === '88' &&
     ctx.doc.querySelector('.verdict-badge').textContent.includes('מעולה'));
  ok('requirements checklist renders with must/nice tags', ctx.doc.querySelectorAll('.dm-slide')[0].querySelectorAll('.req').length === 3 &&
     !!ctx.doc.querySelector('.req--partial') && ctx.doc.querySelector('.req-imp--nice').textContent === 'יתרון');
  ok('job text from the board is escaped, not executed', !ctx.doc.querySelector('.dm-card img') && !ctx.window.__pwned &&
     ctx.doc.querySelector('.dm-jt').textContent.includes('<img'));
  ok('first card is marked viewed once', JSON.stringify(actions(ctx.log)) === JSON.stringify(['1:viewed']));
  ok('apply label names the method and CV', (ctx.doc.getElementById('applySub').textContent || '').includes('Backend'));

  key(ctx.window, 'ArrowLeft');
  await tick();
  ok('← moves to the next card (RTL)', ctx.doc.getElementById('dmCount').textContent === '2 / 3' && actions(ctx.log).includes('2:viewed'));
  key(ctx.window, 's');
  await tick(20);
  ok('S saves the current card', actions(ctx.log).includes('2:saved') && ctx.doc.querySelectorAll('.dm-slide')[1].querySelector('.s-saved'));
  await tick(700);
  ok('saving advances to the next card', ctx.doc.getElementById('dmCount').textContent === '3 / 3');
  key(ctx.window, 'x');
  await tick(750);
  ok('skipping the last card ends the deck', ctx.app.state.view === 'end' && actions(ctx.log).includes('3:skipped'));
  ok('end screen counts what happened', ctx.doc.querySelectorAll('.en-stat b')[1].textContent === '1' &&
     ctx.doc.querySelectorAll('.en-stat b')[2].textContent === '1');

  // ── comparing CV versions ─────────────────────────────────────────────────────
  ctx = await boot({ statuses: [SUB({ status: 'done', cards: 3 })] });
  ctx.doc.querySelector('[data-act="cmp"]').click();
  const firstSlide = ctx.doc.querySelectorAll('.dm-slide')[0];
  ok('compare opens the per-version scores', !firstSlide.querySelector('.dm-cv-cmp').hidden &&
     firstSlide.querySelectorAll('.dm-cv-opt').length === 2);
  const radio = ctx.doc.querySelector('input[name="cv-1"][value="v2"]');
  radio.checked = true;
  radio.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  await tick();
  ok('choosing another version updates the strip and the apply label',
     ctx.doc.querySelector('.dm-cv-k').textContent === 'נבחר להגשה' && ctx.doc.getElementById('applySub').textContent.includes('Data'));

  // ── building today's deck ─────────────────────────────────────────────────────
  const events = [{ type: 'started', run_id: 9 }, { type: 'cv_ready', count: 1, embedded_now: 1 },
    { type: 'candidates', pool: 1284, embedded: 1280, candidates: 3 },
    { type: 'progress', done: 1, total: 3 }, { type: 'progress', done: 2, total: 3 }, { type: 'progress', done: 3, total: 3 },
    { type: 'done', run_id: 9, count: 3 }];
  ctx = await boot({ statuses: [SUB(null)], runEvents: events, storage: { cvText: CV, cvName: 'Noa.docx', licenseKey: 'LIC', anthropicKey: 'sk-ant-x' } });
  ok('with no deck yet it shows the ready screen with the CV', ctx.app.state.view === 'ready' &&
     ctx.doc.querySelector('.cv-row-name').textContent === 'קורות החיים הראשיים');
  ctx.doc.querySelector('[data-act="build"]').click();
  await tick(200);
  const runReq = ctx.log.requests.find(r => r.path === '/run');
  ok('build sends the CV versions', runReq && runReq.body.cvs[0].id === 'main' && runReq.body.cvs[0].text === CV &&
     runReq.body.primaryCvId === 'main');
  ok('build never sends the personal Claude key', runReq && !('X-Anthropic-Key' in runReq.opts.headers) &&
     runReq.opts.headers['X-License-Key'] === 'LIC');
  ok('a finished build opens the deck', ctx.app.state.view === 'deck');

  // ── PDF main CV: text comes back once and is kept ─────────────────────────────
  const blob = '[PDF_BASE64:JVBERi0xLjQK]';
  ctx = await boot({ statuses: [SUB(null)], storage: { cvText: blob, cvName: 'cv.pdf' },
    runEvents: [{ type: 'started', run_id: 1 }, { type: 'cv_text', cv_id: 'main', text: CV }, ...events.slice(1)] });
  ok('a PDF CV is flagged for reading on the first run', ctx.doc.querySelector('.cv-row-meta').textContent.includes('PDF'));
  ctx.doc.querySelector('[data-act="build"]').click();
  await tick(250);
  const lib = ctx.storage.jma_dm_cv_library;
  ok('the extracted text is kept for next time', lib && lib.mainExtracted && lib.mainExtracted.text === CV);
  ok('V1\'s own cvText is never rewritten', ctx.storage.cvText === blob);
  const listed = await ctx.window.JMA_DM.cvLibrary.list();
  ok('the next run sends text instead of the PDF', listed[0].text === CV && !listed[0].needsExtraction);

  // ── autostart from the popup click ────────────────────────────────────────────
  ctx = await boot({ statuses: [SUB(null)], runEvents: events, storage: { cvText: CV, jma_dm_ui: { autoStartAt: Date.now() } } });
  await tick(200);
  ok('a fresh popup click starts the build by itself', ctx.log.requests.some(r => r.path === '/run'));
  ok('the autostart flag is consumed', ctx.storage.jma_dm_ui.autoStartAt === 0);

  // ── paywall routing ───────────────────────────────────────────────────────────
  ctx = await boot({ statuses: [{ ...SUB(null), entitlement: 'locked', reason: 'trial_used', last_run: { id: 4 } }] });
  ok('locked users land on the paywall', ctx.app.state.view === 'paywall' && !!ctx.doc.querySelector('[data-act="last-deck"]'));
  ctx.doc.querySelector('[data-act="buy"]').click();
  ctx.doc.querySelector('[data-act="have-key"]').click();
  ok('paywall links go to Gumroad and the key screen', ctx.log.tabs[0].url.includes('gumroad.com') &&
     ctx.log.tabs[1].url === 'chrome-extension://abc/popup.html#keys');

  ctx = await boot({ statuses: [SUB(null), { ...SUB(null), entitlement: 'locked', reason: 'trial_used' }], storage: { cvText: CV },
    runEvents: [{ type: 'error', code: 'LICENSE_REQUIRED', message: 'trial used [jma:LICENSE_REQUIRED]' }] });
  ctx.doc.querySelector('[data-act="build"]').click();
  await tick(250);
  ok('a LICENSE_REQUIRED run error routes to the paywall', ctx.app.state.view === 'paywall');

  ctx = await boot({ statuses: [SUB(null)], storage: { cvText: CV },
    runEvents: [{ type: 'error', code: 'DM_POOL_EMPTY', message: 'המאגר לא מוכן [jma:DM_POOL_EMPTY]' }] });
  ctx.doc.querySelector('[data-act="build"]').click();
  await tick(250);
  ok('an empty pool explains itself and offers a retry', ctx.app.state.view === 'error' &&
     ctx.doc.querySelector('.dm-h').textContent.includes('לא מוכן') && !!ctx.doc.querySelector('[data-act="reload"]'));

  ctx = await boot({ statuses: [{ enabled: false, reason: 'off' }] });
  ok('a disabled feature says so', ctx.app.state.view === 'disabled');

  // ── apply: Lever auto-fill needs a confirmed profile first ────────────────────
  ctx = await boot({ statuses: [SUB({ status: 'done', cards: 3 })], storage: { cvText: CV },
    injection: { found: true, filled: ['Full name', 'Email'], left: ['Current location'], attached: false, fileName: '' } });
  ctx.doc.querySelector('[data-act="apply"]').click();
  await tick();
  ok('first Lever apply asks to confirm the form details', ctx.app.state.view === 'profile' &&
     ctx.doc.querySelector('[data-field="email"]').value === 'noa.levi@example.com' &&
     ctx.doc.querySelector('[data-field="fullName"]').value === 'Noa Levi');
  ctx.doc.querySelector('[data-act="save-profile"]').click();
  await tick(250);
  const inj = ctx.log.scripting[0];
  ok('after confirming, the Lever form is filled in its own tab', ctx.log.tabs[0].url === 'https://jobs.lever.co/acme/1/apply' &&
     inj && inj.func.name === 'leverFill' && inj.target.tabId === 5 && inj.args[0].email === 'noa.levi@example.com');
  ok('the apply view reports what was filled and what was left', ctx.app.state.view === 'apply' &&
     ctx.doc.body.textContent.includes('מולאו 2 שדות') && ctx.doc.body.textContent.includes('Current location'));
  ok('the hard rule is stated on screen', ctx.doc.querySelector('.ap-rule').textContent.includes('Submit'));
  ctx.doc.querySelector('[data-act="applied"]').click();
  await tick(800);
  ok('"I applied" records it and moves on', actions(ctx.log).includes('1:applied') && ctx.doc.getElementById('dmCount').textContent === '2 / 3');

  // ── apply: Greenhouse gets the hosted form plus download-and-copy ─────────────
  ctx = await boot({ statuses: [SUB({ status: 'done', cards: 3 })], storage: { cvText: CV } });
  ctx.app.goTo(2, false);
  ctx.doc.querySelector('[data-act="apply"]').click();
  await tick(200);
  ok('Greenhouse opens the hosted application form', ctx.log.tabs[0].url === 'https://job-boards.greenhouse.io/datavine/jobs/9');
  ok('and offers details to copy instead of filling', ctx.log.scripting.length === 0 &&
     ctx.doc.querySelectorAll('.cp-row').length >= 2 && ctx.doc.body.textContent.includes('Greenhouse'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
