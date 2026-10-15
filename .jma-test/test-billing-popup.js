// The popup's billing pieces (jma-billing.js + billing-popup.js) against a
// scripted /api/billing: buy links follow the server, a pending checkout is
// collected when the popup reopens, and the settings box shows the
// subscription, cancels in two clicks, and resends a key by email.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = ['jma-auth.js', 'jma-billing.js', 'billing-popup.js'].map(read);

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✓ ${name}`); } else { failed++; console.log(`✗ ${name}`); }
  if (detail && !cond) console.log(`    ${detail}`);
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

const HTML = `<div id="screen-license"><div id="keysSubtitle">מנוי, או מפתח Claude API אישי.</div>
  <div class="key-option" id="keyOptionLicense">license</div><div class="key-or">או</div></div>
  <div class="key-option" id="settingsOptionLicense">settings license</div>
  <a href="#" id="linkBuyLicense" class="key-option-link jma-buy-link" hidden>אין לך מנוי? לרכישה ↗</a>
  <div id="licenseSettingsStatus"></div><div id="jmaSubscriptionBox" hidden></div>
  <a href="#" class="key-option-link jma-buy-link" hidden>רכישת מנוי ↗</a>`;

async function boot({ config = { enabled: false }, storage = {}, sub = null, claims = [{ status: 'pending' }] } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'chrome-extension://abc/popup.html' });
  const { window } = dom;
  const log = { calls: [], tabs: [], reloads: 0 };
  const json = (data, status = 200) => Promise.resolve({ ok: status < 400, status,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(data))) });
  window.fetch = (url, opts = {}) => {
    const p = new URL(url).pathname.replace('/api/billing', '');
    log.calls.push({ path: p, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (p === '/config') return json(config);
    if (p === '/checkout') return json({ checkout_id: 'c'.repeat(32), url: 'https://pay.example/co' });
    if (p.startsWith('/checkout/')) return json(claims.length > 1 ? claims.shift() : claims[0]);
    if (p === '/subscription') return sub ? json(sub) : json({ detail: 'no' }, 404);
    if (p === '/cancel') { sub = { ...sub, status: 'cancelled' }; return json(sub); }
    if (p === '/resend-key') return json({ ok: true });
    return Promise.reject(new Error('unexpected ' + p));
  };
  window.chrome = {
    storage: {
      onChanged: { addListener: () => {} },
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
    tabs: { create: (o) => { log.tabs.push(o); return Promise.resolve({ id: 1 }); } },
  };
  window.addEventListener('jma-billing-claimed', () => { log.reloads++; });
  for (const src of SCRIPTS) window.eval(src);
  await tick();
  return { window, doc: window.document, log, storage };
}

const links = (doc) => [...doc.querySelectorAll('.jma-buy-link')];

(async () => {
  let ctx = await boot();
  const shown = (id) => ctx.doc.getElementById(id).style.display !== 'none';
  ok('before payments open, the subscription-key option is folded away', !shown('keyOptionLicense') &&
     !shown('settingsOptionLicense') && ctx.doc.querySelector('.key-or').style.display === 'none');
  ok('and the key screen points at a personal Claude key', ctx.doc.getElementById('keysSubtitle').textContent.includes('Claude API אישי') &&
     !ctx.doc.getElementById('keysSubtitle').textContent.includes('מנוי'));
  ctx.doc.getElementById('settingsOptionLicenseReveal').click();
  await tick();
  ok('"I have a subscription key" brings it back', shown('keyOptionLicense') && shown('settingsOptionLicense') &&
     ctx.doc.getElementById('settingsOptionLicenseReveal').style.display === 'none');
  ctx = await boot({ storage: { licenseKey: 'ADMIN-KEY' } });
  ok('a stored key keeps the option visible', shown('keyOptionLicense'));
  ctx = await boot();
  ok('buy links stay hidden while the server offers nothing', links(ctx.doc).every(a => a.hidden));
  ok('and so does the subscription box', ctx.doc.getElementById('jmaSubscriptionBox').hidden);

  ctx = await boot({ config: { enabled: true, price_label: '$5.90', test: false } });
  ok('an offered subscription shows the links with the price', links(ctx.doc).every(a => !a.hidden && a.textContent.includes('$5.90')));
  ok('a keyless user is offered "send my key again"', !!ctx.doc.getElementById('jmaResendOpen'));
  links(ctx.doc)[0].click();
  await tick();
  ok('buying opens the server-given payment page', ctx.log.tabs[0].url === 'https://pay.example/co' &&
     ctx.storage.jma_billing_pending && ctx.storage.jma_billing_pending.id === 'c'.repeat(32));

  ctx.doc.getElementById('jmaResendOpen').click();
  ctx.doc.getElementById('jmaResendEmail').value = 'dana@example.com';
  ctx.doc.getElementById('jmaResendGo').click();
  await tick();
  const resend = ctx.log.calls.find(c => c.path === '/resend-key');
  ok('the resend form posts the email', resend && resend.body.email === 'dana@example.com' &&
     ctx.doc.getElementById('jmaSubscriptionBox').textContent.includes('שלחנו'));

  // A checkout started before the popup closed is collected when it reopens.
  ctx = await boot({ config: { enabled: true, price_label: '$5.90' },
    storage: { jma_billing_pending: { id: 'd'.repeat(32), at: Date.now() } },
    claims: [{ status: 'paid', license_key: 'JMA-AAAA-BBBB-CCCC-DDDD' }] });
  await tick();
  ok('a reopened popup collects the paid key', ctx.storage.licenseKey === 'JMA-AAAA-BBBB-CCCC-DDDD' && !ctx.storage.jma_billing_pending);
  ok('and starts over from the subscribed state', ctx.log.reloads === 1);

  ctx = await boot({ storage: { jma_billing_pending: { id: 'e'.repeat(32), at: Date.now() - 7 * 3600 * 1000 } } });
  ok('a checkout older than the server keeps it is dropped', !ctx.storage.jma_billing_pending &&
     !ctx.log.calls.some(c => c.path.startsWith('/checkout/')));

  // A subscriber sees their subscription, and cancels in two clicks.
  ctx = await boot({ config: { enabled: true, price_label: '$5.90' }, storage: { licenseKey: 'JMA-AAAA-BBBB-CCCC-DDDD' },
    sub: { status: 'active', current_period_end: '2026-11-15T10:00:00+00:00', email: 'da•••@example.com' } });
  const box = ctx.doc.getElementById('jmaSubscriptionBox');
  ok('a subscriber sees the subscription, not buy links', !box.hidden && box.textContent.includes('המנוי פעיל') &&
     box.textContent.includes('da•••@example.com') && links(ctx.doc).every(a => a.hidden));
  ctx.doc.getElementById('jmaCancelSub').click();
  await tick();
  ok('the first cancel click only asks', !ctx.log.calls.some(c => c.path === '/cancel') &&
     ctx.doc.getElementById('jmaCancelSub').textContent.includes('לחצי שוב'));
  ctx.doc.getElementById('jmaCancelSub').click();
  await tick();
  ok('the second cancels and shows until when it still works', ctx.log.calls.some(c => c.path === '/cancel') &&
     box.textContent.includes('המנוי בוטל') && !ctx.doc.getElementById('jmaCancelSub'));

  ctx = await boot({ config: { enabled: true, price_label: '$5.90' }, storage: { licenseKey: 'ADMIN-KEY' } });
  ok('an admin key can still buy (to test a payment) and gets no subscription box',
     ctx.doc.getElementById('jmaSubscriptionBox').hidden && links(ctx.doc).every(a => !a.hidden));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
