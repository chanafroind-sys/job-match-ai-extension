// LINE B (קו ב') — the local-matcher import line. Every job in the pool window
// goes straight through matcher.js in the popup: no keyword pre-filter, no
// per-job Claude call, no 100-job cap. This exercises that scoring core against
// pool-shaped rows (the {url,title,text,ts} objects /api/jobs-pool returns) and
// pins the two behaviours the line depends on:
//   1. profileFromCvText lives in matcher.js, so the popup can build a profile
//      for users who never ran /api/extract-profile.
//   2. filtering is purely score >= minScore — a job the keyword pre-filter of
//      LINE A would have dropped still gets scored on its merits.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// matcher.js expects a browser `window` and nothing else — no DOM, no chrome.
const mwin = {};
const msandbox = { window: mwin, console };
vm.createContext(msandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'matcher.js'), 'utf8'), msandbox);
const Matcher = mwin.JMA_Matcher;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}`); }
  if (detail) console.log(`    ${detail}`);
}

const PROFILE = {
  industry_summary: { total_years_industry: 6, domain_years: { backend: 6, devops_cloud: 3 } },
  experience: {
    backend: {
      Python:     { industry_years: 5, personal_years: 1, search_tags: ['python'] },
      PostgreSQL: { industry_years: 4, personal_years: 0, search_tags: ['postgresql', 'postgres', 'sql'] },
    },
    devops_cloud: {
      Docker: { industry_years: 3, personal_years: 0, search_tags: ['docker'] },
      AWS:    { industry_years: 3, personal_years: 0, search_tags: ['aws'] },
    },
  },
  tools_and_methods: { git: true },
};

// Shaped exactly like the rows /api/jobs-pool hands back.
const POOL = [
  {
    url: 'https://ex.com/jobs/1', title: 'Senior Backend Engineer', ts: '2026-07-28T09:00:00+00:00',
    text: 'About the job\nRequirements:\n5+ years of professional experience in backend development\n' +
          '4 years experience with Python\nStrong knowledge of SQL and PostgreSQL\nExperience with Docker and AWS\n',
  },
  {
    url: 'https://ex.com/jobs/2', title: 'Pastry Chef', ts: '2026-07-28T10:00:00+00:00',
    text: 'About the job\nRequirements:\n5 years experience in a professional bakery\n' +
          'Expertise in laminated doughs and sugar work\nCulinary school diploma required\n',
  },
  {
    url: 'https://ex.com/jobs/3', title: 'Backend Developer', ts: '2026-07-27T08:00:00+00:00',
    text: 'About the job\nRequirements:\n2 years experience with Python\nFamiliarity with SQL databases\n' +
          'Nice to have:\nExperience with Docker\n',
  },
];

// The scoring core of _runLocalImport in popup.js.
function runLocalLine(profile, jobs, minScore) {
  const rows = [];
  for (const job of jobs) {
    if (!job.text) continue;
    const { score, bullets } = Matcher.computeScore(profile, job.text);
    if (score < minScore) continue;
    rows.push({
      Title: job.title, URL: job.url, Score: score,
      Pro: bullets[0] || '', Con: bullets[bullets.length - 1] || '',
      Date: (job.ts || '').slice(0, 10),
    });
  }
  rows.sort((a, b) => b.Score - a.Score);
  return rows;
}

// ── 1. matcher.js exposes the CV-text fallback the popup needs ───────────────
ok('matcher.js exposes profileFromCvText',
   typeof Matcher.profileFromCvText === 'function',
   `typeof=${typeof Matcher.profileFromCvText}`);

const stub = Matcher.profileFromCvText(
  'Backend engineer with 6 years of professional experience. Python, PostgreSQL, Docker, AWS.');
ok('CV-text stub picks up techs and years',
   stub.experience.backend.python && stub.industry_summary.total_years_industry === 6,
   `total_years=${stub.industry_summary.total_years_industry} backend=${Object.keys(stub.experience.backend)}`);

ok('stub scores the matching job well above the mismatched one',
   Matcher.computeScore(stub, POOL[0].text).score > Matcher.computeScore(stub, POOL[1].text).score,
   `backend=${Matcher.computeScore(stub, POOL[0].text).score} chef=${Matcher.computeScore(stub, POOL[1].text).score}`);

// ── 2. every pool job is scored, then filtered on score alone ────────────────
const all = runLocalLine(PROFILE, POOL, 0);
ok('scores every job in the window (no pre-filter drops any)',
   all.length === POOL.length, `scored=${all.length}/${POOL.length}`);

ok('results are sorted by score, descending',
   all.every((r, i) => i === 0 || all[i - 1].Score >= r.Score),
   all.map(r => `${r.Title}=${r.Score}`).join(', '));

const strong = runLocalLine(PROFILE, POOL, 70);
ok('minScore=70 keeps the backend roles and drops the chef role',
   strong.length > 0 && strong.every(r => r.Score >= 70) && !strong.some(r => r.Title === 'Pastry Chef'),
   strong.map(r => `${r.Title}=${r.Score}`).join(', ') || '(empty)');

ok('a high threshold can legitimately return nothing',
   runLocalLine(PROFILE, POOL, 100).length === 0,
   `kept=${runLocalLine(PROFILE, POOL, 100).length}`);

// ── 3. rows carry the six xlsx columns /api/export-jobs-xlsx expects ─────────
const COLS = ['Title', 'URL', 'Score', 'Pro', 'Con', 'Date'];
ok('rows carry exactly the six export columns',
   all.length > 0 && COLS.every(c => c in all[0]),
   `keys=${Object.keys(all[0]).join(',')}`);

ok('Date is derived from the pool timestamp',
   all.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.Date)),
   `dates=${all.map(r => r.Date).join(', ')}`);

// ── 4. malformed pool rows must not abort the run ────────────────────────────
const messy = runLocalLine(PROFILE, [...POOL, { url: 'https://ex.com/4', title: 'Empty', text: '', ts: '' }], 0);
ok('a text-less pool row is skipped, not fatal',
   messy.length === POOL.length, `scored=${messy.length}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
