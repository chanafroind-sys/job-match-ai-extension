// "דרג משרות בעמוד" must score locally through matcher.js and never call the AI.
const { run } = require('./harness');
const F = require('./fixtures');

const PROFILE = {
  industry_summary: { total_years_industry: 6, domain_years: { backend: 6, devops_cloud: 3 } },
  experience: {
    backend: {
      Python:     { industry_years: 5, personal_years: 1, search_tags: ['python'] },
      'Node.js':  { industry_years: 3, personal_years: 1, search_tags: ['node.js', 'nodejs', 'node'] },
      PostgreSQL: { industry_years: 4, personal_years: 0, search_tags: ['postgresql', 'postgres', 'sql'] },
    },
    devops_cloud: {
      Docker:     { industry_years: 3, personal_years: 0, search_tags: ['docker'] },
      Kubernetes: { industry_years: 2, personal_years: 0, search_tags: ['kubernetes', 'k8s'] },
      AWS:        { industry_years: 3, personal_years: 0, search_tags: ['aws'] },
    },
  },
  tools_and_methods: { git: true, 'ci/cd': true },
};

const BASE = { licenseKey: 'TEST-KEY', cvText: 'Backend engineer, Python, Docker, AWS.', shareJobsConsent: false };

async function rankPage(storage, fetchedText = '') {
  const r = await run({
    url: 'https://www.linkedin.com/jobs/search/?keywords=backend',
    html: F.linkedinSearch,
    storage,
    fetchedText,
    waitMs: 4000,
  });
  // Click the pill exactly as a user would, then let ranking settle.
  const btn = r.doc.getElementById('jma-float-btn');
  if (btn) btn.dispatchEvent(new r.window.Event('click', { bubbles: true }));
  await new Promise(res => setTimeout(res, 3000));
  return r;
}

(async () => {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  // ── 1. AI-extracted profile present ───────────────────────────────────────
  const storage = { ...BASE, jma_user_profile: PROFILE };
  const r = await rankPage(storage);

  const actions = r.log.messages.map(m => m.action);
  check('no rankJobs message sent (AI path retired)', !actions.includes('rankJobs'),
        `actions=[${[...new Set(actions)].join(', ')}]`);
  check('fetchJobDetails still used for enrichment', actions.includes('fetchJobDetails'),
        `actions=[${[...new Set(actions)].join(', ')}]`);

  const cards = r.doc.querySelectorAll('#jma-sb-body .jma-card');
  check('sidebar rendered ranked cards', cards.length >= 2, `cards=${cards.length}`);

  const rendered = Array.from(cards).map(c => ({
    rank:  c.querySelector('.jma-rank')?.textContent.trim(),
    title: c.querySelector('.jma-title')?.textContent.trim(),
    pro:   c.querySelectorAll('.jma-fit-row')[0]?.textContent.trim(),
    con:   c.querySelectorAll('.jma-fit-row')[1]?.textContent.trim(),
  }));

  const scores = rendered.map(c => parseInt((c.rank || '').match(/(\d+)%/)?.[1] ?? '-1', 10));
  check('every card carries a real score', scores.length > 0 && scores.every(s => s > 0),
        `scores=[${scores.join(', ')}]`);
  check('cards are sorted high → low', scores.every((s, i) => i === 0 || scores[i - 1] >= s),
        `scores=[${scores.join(', ')}]`);
  check('pro/con bullets populated from matcher output',
        rendered.every(c => c.pro && c.con && c.pro.length > 2 && c.con.length > 2),
        `first pro="${rendered[0]?.pro}" con="${rendered[0]?.con}"`);
  check('matcher version logged', r.log.console.some(l => /matcher v[\d.]+/.test(l)),
        r.log.console.find(l => l.includes('[JMA:rank] scored')) || 'not logged');

  // Independently recompute one score and compare against what was rendered.
  const cardText = r.doc.querySelectorAll('.jobs-search-results__list-item')[0].innerText
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().substring(0, 800);
  const direct = r.window.JMA_Matcher.computeScore(PROFILE, cardText);
  check('rendered score equals a direct computeScore() call',
        scores.includes(direct.score),
        `direct=${direct.score} rendered=[${scores.join(', ')}]`);

  // Results must be cached under the page key for the 20-minute reuse path.
  const cacheKey = Object.keys(storage).find(k => k.startsWith('jma_rank_'));
  check('ranking cached for reuse', !!cacheKey && Array.isArray(storage[cacheKey]?.jobs),
        `key=${cacheKey} jobs=${storage[cacheKey]?.jobs?.length}`);

  // ── 2. No profile, only raw CV text → _profileFromCvText fallback ─────────
  const storage2 = { ...BASE, cvText: '6 years of professional experience with Python, Docker, Kubernetes, AWS and PostgreSQL.' };
  const r2 = await rankPage(storage2);
  const cards2 = r2.doc.querySelectorAll('#jma-sb-body .jma-card');
  check('falls back to CV-text profile when no jma_user_profile', cards2.length >= 2,
        `cards=${cards2.length}, body="${r2.doc.getElementById('jma-sb-body')?.textContent.trim().slice(0, 80)}"`);

  // ── 3. No CV at all → clear error, no crash ──────────────────────────────
  const r3 = await rankPage({ licenseKey: 'TEST-KEY', shareJobsConsent: false });
  const errText = r3.doc.querySelector('#jma-sb-body .jma-err')?.textContent || '';
  check('missing CV produces a friendly error', errText.includes('קורות חיים'), `err="${errText}"`);

  // ── 4. Background-fetched full text is preferred over the card snippet ────
  const storage4 = { ...BASE, jma_user_profile: PROFILE };
  const r4 = await rankPage(storage4, F.JD_BODY);
  const cards4 = r4.doc.querySelectorAll('#jma-sb-body .jma-card');
  const scores4 = Array.from(cards4).map(c => parseInt(c.querySelector('.jma-rank').textContent.match(/(\d+)%/)[1], 10));
  const directFull = r4.window.JMA_Matcher.computeScore(PROFILE, F.JD_BODY);
  check('full fetched text is what gets scored',
        scores4.length > 0 && scores4.every(s => s === directFull.score),
        `direct=${directFull.score} rendered=[${scores4.join(', ')}]`);

  let fail = 0;
  for (const t of results) {
    console.log(`${t.ok ? '✓' : '✗'} ${t.name}\n    ${t.detail}`);
    if (!t.ok) fail++;
  }
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
