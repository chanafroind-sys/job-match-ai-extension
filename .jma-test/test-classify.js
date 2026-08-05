// Which UI does content.js inject on each page shape?
const { run } = require('./harness');
const F = require('./fixtures');

const STORAGE = {
  licenseKey: 'TEST-KEY',
  cvText: '8 years of professional experience. Python, Node.js, PostgreSQL, Docker, Kubernetes, AWS, React.',
  shareJobsConsent: false,
};

const CASES = [
  { name: 'LinkedIn single job (/jobs/view) + similar-jobs rail',
    url: 'https://www.linkedin.com/jobs/view/4012345678/',
    html: F.linkedinSingle, expect: { fab: true, pill: false } },

  { name: 'LinkedIn search, nothing selected',
    url: 'https://www.linkedin.com/jobs/search/?keywords=backend',
    html: F.linkedinSearch, expect: { fab: false, pill: true } },

  { name: 'LinkedIn search with a job open (hybrid)',
    url: 'https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=backend',
    html: F.linkedinHybrid, expect: { fab: true, pill: true } },

  { name: 'Indeed single job (/viewjob) + more-jobs rail',
    url: 'https://www.indeed.com/viewjob?jk=abc123',
    html: F.indeedSingle, expect: { fab: true, pill: false } },

  { name: 'Greenhouse careers board',
    url: 'https://boards.greenhouse.io/acme',
    html: F.greenhouseBoard, expect: { fab: false, pill: true } },

  { name: 'LinkedIn single job, description behind "See more"',
    url: 'https://www.linkedin.com/jobs/view/4055555555/',
    html: F.linkedinTruncated, expect: { fab: true, pill: false } },

  // The FAB's gauge is scored locally by matcher.js, so it must not depend on
  // any key — a keyless user has to be able to see it and click through to the
  // prompt that asks for one.
  { name: 'LinkedIn single job, personal Claude key instead of a subscription',
    url: 'https://www.linkedin.com/jobs/view/4012345678/',
    html: F.linkedinSingle, expect: { fab: true, pill: false },
    storage: { licenseKey: undefined, anthropicKey: 'sk-ant-api03-test' } },

  { name: 'LinkedIn single job, no key at all',
    url: 'https://www.linkedin.com/jobs/view/4012345678/',
    html: F.linkedinSingle, expect: { fab: true, pill: false },
    storage: { licenseKey: undefined } },

  // The CV is the one genuine prerequisite: local scoring has nothing to score
  // against without it.
  { name: 'LinkedIn single job, no CV uploaded',
    url: 'https://www.linkedin.com/jobs/view/4012345678/',
    html: F.linkedinSingle, expect: { fab: false, pill: false },
    storage: { cvText: undefined } },
];

(async () => {
  let pass = 0, fail = 0;
  for (const c of CASES) {
    const storage = { ...STORAGE, ...(c.storage || {}) };
    for (const k of Object.keys(storage)) if (storage[k] === undefined) delete storage[k];
    const r = await run({ url: c.url, html: c.html, storage });
    if (r.error) { console.log(`✗ ${c.name}\n    ${r.error}`); fail++; continue; }
    const ok = r.fab === c.expect.fab && r.pill === c.expect.pill;
    const desc = `FAB=${r.fab} pill=${r.pill} (classified "${r.classified}")`;
    if (ok) { console.log(`✓ ${c.name}\n    ${desc}`); pass++; }
    else {
      console.log(`✗ ${c.name}\n    got      ${desc}`);
      console.log(`    expected FAB=${c.expect.fab} pill=${c.expect.pill}`);
      console.log(`    log: ${r.log.console.slice(0, 6).join(' | ')}`);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
