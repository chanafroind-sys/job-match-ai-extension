// Does the extension expand a "See more" description before scoring it?
// The scrapeJob message carries the exact text that was extracted, so we read
// the answer straight out of it.
const { run } = require('./harness');
const F = require('./fixtures');

const STORAGE = {
  licenseKey: 'TEST-KEY',
  cvText: '8 years of professional experience. Python, Node.js, PostgreSQL, Docker, Kubernetes, AWS.',
  shareJobsConsent: true,   // makes initJobFab emit scrapeJob with the extracted text
};

// LinkedIn's real behaviour: the rest of the description is injected on click.
function wireSeeMore(window, log) {
  const doc = window.document;
  const btn = doc.querySelector('.jobs-description__footer-button');
  const jd = doc.getElementById('jd');
  log.applyClicked = false;
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-expanded', 'true');
    jd.innerHTML += '<br>' + F.JD_TAIL.replace(/\n/g, '<br>');
    log.expanded = true;
  });
  // An Apply button sitting inside the description subtree — the expander must
  // never touch it.
  const apply = doc.createElement('button');
  apply.textContent = 'Apply now';
  apply.addEventListener('click', () => { log.applyClicked = true; });
  doc.querySelector('.jobs-description').appendChild(apply);
}

(async () => {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

  const r = await run({
    url: 'https://www.linkedin.com/jobs/view/4055555555/',
    html: F.linkedinTruncated,
    storage: { ...STORAGE },
    onReady: wireSeeMore,
  });

  const scrape = r.log.messages.find(m => m.action === 'scrapeJob');
  const text = scrape ? scrape.text : '';

  check('"See more" was clicked', !!r.log.expanded, `expanded=${!!r.log.expanded}`);
  check('extracted text contains the hidden tail', text.includes(F.TRUNCATED_TAIL_MARKER),
        `len=${text.length}, marker=${text.includes(F.TRUNCATED_TAIL_MARKER)}`);
  check('"Apply now" was NOT clicked', r.log.applyClicked === false, `applyClicked=${r.log.applyClicked}`);
  check('expansion logged', r.log.console.some(l => l.includes('[JMA:expand]')),
        r.log.console.find(l => l.includes('[JMA:expand]')) || 'no expand log');
  check('FAB still injected', r.fab === true && r.pill === false, `FAB=${r.fab} pill=${r.pill}`);

  // Control: with no expander wired, we must still get the un-truncated part.
  const r2 = await run({
    url: 'https://www.linkedin.com/jobs/view/4055555556/',
    html: F.linkedinSingle,
    storage: { ...STORAGE },
  });
  const scrape2 = r2.log.messages.find(m => m.action === 'scrapeJob');
  check('page without a "See more" still extracts normally',
        !!scrape2 && scrape2.text.length > 350, `len=${scrape2 ? scrape2.text.length : 0}`);

  let fail = 0;
  for (const t of results) {
    console.log(`${t.ok ? '✓' : '✗'} ${t.name}\n    ${t.detail}`);
    if (!t.ok) fail++;
  }
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
