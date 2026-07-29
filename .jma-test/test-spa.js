// LinkedIn re-routes constantly. Navigating mid-expansion must not leave a
// stale FAB, a duplicate FAB, or both UIs on screen at once.
const { run } = require('./harness');
const F = require('./fixtures');

const STORAGE = {
  licenseKey: 'TEST-KEY',
  cvText: '8 years of professional experience. Python, Node.js, PostgreSQL, Docker, Kubernetes, AWS.',
  shareJobsConsent: false,
};

(async () => {
  const results = [];
  const check = (n, ok, d) => results.push({ name: n, ok, detail: d });

  // 1. Single job → user clicks through to the search page.
  const r = await run({
    url: 'https://www.linkedin.com/jobs/view/4012345678/',
    html: F.linkedinSingle,
    storage: { ...STORAGE },
    waitMs: 6000,
  });
  check('starts as a single-job page', r.fab && !r.pill, `FAB=${r.fab} pill=${r.pill}`);

  // Swap the DOM and the URL exactly as an SPA route change would.
  r.doc.body.innerHTML = new (require('jsdom').JSDOM)(F.linkedinSearch).window.document.body.innerHTML;
  r.window.history.pushState({}, '', '/jobs/search/?keywords=backend');
  await new Promise(res => setTimeout(res, 8000));

  const fabAfter = !!r.doc.getElementById('jma-fab-wrap');
  const pillAfter = !!r.doc.getElementById('jma-float-btn');
  check('stale FAB torn down after navigating to a search page', !fabAfter, `FAB=${fabAfter}`);
  check('listings pill takes over on the search page', pillAfter, `pill=${pillAfter}`);

  // 2. Never more than one of each element, whatever the retries do.
  const r2 = await run({
    url: 'https://www.linkedin.com/jobs/view/4099999999/',
    html: F.linkedinTruncated,
    storage: { ...STORAGE },
    waitMs: 9000,
    onReady: (window) => {
      const jd = window.document.getElementById('jd');
      window.document.querySelector('.jobs-description__footer-button')
        .addEventListener('click', function () {
          this.setAttribute('aria-expanded', 'true');
          jd.innerHTML += '<br>' + F.JD_TAIL.replace(/\n/g, '<br>');
        });
    },
  });
  check('exactly one FAB injected (no duplicate from the retry tick)',
        r2.doc.querySelectorAll('#jma-fab-wrap').length === 1,
        `count=${r2.doc.querySelectorAll('#jma-fab-wrap').length}`);
  check('no listings pill alongside it',
        r2.doc.querySelectorAll('#jma-float-btn').length === 0,
        `count=${r2.doc.querySelectorAll('#jma-float-btn').length}`);

  // 3. A non-job page gets nothing at all.
  const r3 = await run({
    url: 'https://example.com/blog/hello',
    html: '<!doctype html><html><body><h1>Hello</h1><p>A blog post about nothing in particular.</p></body></html>',
    storage: { ...STORAGE },
    waitMs: 5000,
  });
  check('non-job page injects neither UI', !r3.fab && !r3.pill, `FAB=${r3.fab} pill=${r3.pill}`);

  let fail = 0;
  for (const t of results) { console.log(`${t.ok ? '✓' : '✗'} ${t.name}\n    ${t.detail}`); if (!t.ok) fail++; }
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
