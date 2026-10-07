// Preview harness for the Daily Matches side panel: fakes chrome.* and the
// backend so the real daily/*.js + dm-styles.css render in a normal browser
// tab. Pick a scenario with ?state=deck|ready|building|quiet|library|paywall|end|disabled.
// Sample data only: companies, people and jobs are fictional.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const scenario = params.get('state') || 'deck';

  const CV = 'Noa Levi\nnoa.levi@example.com · 050-123-4567 · linkedin.com/in/noa-levi-example\n' +
    'Senior backend engineer with 6 years of Python and Java microservices on AWS. Kafka, PostgreSQL, Kubernetes.\n'.repeat(3);
  const storage = {
    cvText: CV, cvName: 'Backend_CV.docx', licenseKey: 'PREVIEW-KEY',
    jma_dm_cv_library: { versions: [{ id: 'vdata', label: 'Data', fileName: 'Data_Engineer_CV.pdf', text: 'Spark Airflow SQL '.repeat(30), hasFile: true }], mainLabel: 'Backend' },
  };
  if (scenario === 'building') storage.jma_dm_ui = { autoStartAt: Date.now() };

  const reqs = (rows) => rows.map(([text, status, importance]) => ({ text, status, importance }));
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const card = (id, score, title, company, ats, analysis, extra = {}) => ({
    id, rank: id, match_score: score, tier: score >= 70 ? 'strong' : 'maybe', vector_score: 0.6, best_cv_id: analysis.best || 'main', user_action: extra.user_action || null,
    analysis: {
      match_score: score, best_cv_ref: analysis.best || 'main',
      cv_scores: [{ cv_id: 'main', label: 'Backend', score: analysis.be }, { cv_id: 'vdata', label: 'Data', score: analysis.data }],
      requirements: reqs(analysis.reqs), fit_summary_he: analysis.summary, cv_choice_reason_he: analysis.reason, top_gap_he: analysis.gap,
      breakdown: analysis.breakdown || [], cap: analysis.cap || null,
    },
    job: { title, company, category: extra.category || 'Backend', seniority: extra.seniority || 'Senior',
      url: `https://jobs.example.com/${id}`, apply_url: `https://jobs.example.com/${id}/apply`, ats,
      is_new: !!extra.is_new, published_at: daysAgo(extra.age || 0), excerpt: 'Requirements:\n• 5+ years of backend development\n• Kafka, AWS\nNice to have:\n• Go' },
  });
  const DECK = [
    card(1, 89, 'Senior Backend Engineer', 'Lumen Security', 'lever', { be: 89, data: 61,
      breakdown: [{ kind: 'requirement', text: 'Kubernetes at scale', importance: 'must', status: 'partial', points: -8 },
        { kind: 'requirement', text: 'Go', importance: 'nice', status: 'missing', points: -3 }],
      summary: 'שש שנות ניסיון ב-Python ובמיקרו-סרוויסים על AWS עונות ישירות על ליבת התפקיד. הפער המשמעותי היחיד הוא תפעול קלאסטרים ב-Kubernetes.',
      reason: 'גרסת ה-Backend מדגישה Kafka ו-AWS, שתי דרישות החובה המרכזיות.',
      gap: 'Kubernetes: יש ניסיון בפריסה, לא בתפעול קלאסטרים.',
      reqs: [['5+ years backend (Python / Java)', 'met', 'must'], ['Microservices, event-driven (Kafka)', 'met', 'must'],
        ['AWS in production', 'met', 'must'], ['Kubernetes at scale', 'partial', 'must'], ['Go', 'missing', 'nice']] }),
    card(2, 81, 'Data Engineer', 'Datavine', 'greenhouse', { best: 'vdata', be: 70, data: 81,
      breakdown: [{ kind: 'requirement', text: 'dbt', importance: 'nice', status: 'partial', points: -1 },
        { kind: 'requirement', text: 'Snowflake', importance: 'nice', status: 'missing', points: -3 },
        { kind: 'years', required: 4, relevant: 2, points: -15 }],
      summary: 'ניסיון מוכח בפייפליינים של Spark ו-Airflow ושליטה גבוהה ב-SQL. Snowflake לא מופיע בקורות החיים.',
      reason: 'גרסת ה-Data מציגה בראשה את פרויקטי ה-Spark וה-Airflow.', gap: 'dbt: ניסיון בסיסי בלבד.',
      reqs: [['Python and advanced SQL', 'met', 'must'], ['Spark / Databricks', 'met', 'must'], ['dbt', 'partial', 'nice'], ['Snowflake', 'missing', 'nice']] },
      { category: 'Data', seniority: 'Mid', is_new: true, age: 1 }),
    card(3, 64, 'Platform Engineer', 'Orbitform', 'workday', { be: 64, data: 52,
      breakdown: [{ kind: 'requirement', text: 'Kubernetes operations', importance: 'must', status: 'partial', points: -8 },
        { kind: 'requirement', text: 'On-call and SRE practices', importance: 'must', status: 'missing', points: -20 },
        { kind: 'years', required: 4, relevant: 3, points: -8 }],
      summary: 'רקע חזק בתשתיות ענן ו-CI/CD. המשרה דורשת תורנויות On-call, שלא מופיעות אצלך.',
      reason: 'Terraform ו-CI/CD מופיעים רק בגרסת ה-Backend.', gap: 'On-call: אין ניסיון מוצהר, וזו דרישת חובה.',
      reqs: [['Terraform / IaC', 'met', 'must'], ['Kubernetes operations', 'partial', 'must'], ['On-call and SRE practices', 'missing', 'must']] },
      { category: 'DevOps', age: 2 }),
  ];
  if (scenario === 'end') DECK.forEach((c, i) => { c.user_action = ['applied', 'saved', 'skipped'][i]; });

  const STATUS = {
    deck: { today: { status: 'done', cards: 3 } }, end: { today: { status: 'done', cards: 3 } },
    quiet: { today: { status: 'done', cards: 0 } }, library: { today: null },
    ready: { today: null }, building: { today: null }, paywall: { entitlement: 'locked', reason: 'trial_used', last_run: { id: 1 } },
    disabled: null,
  };
  const status = scenario === 'disabled' ? { enabled: false, reason: 'off' } : {
    enabled: true, entitlement: 'subscription', reason: '', today: null,
    pool: { active: 1284, embedded: 1280, fresh: 47 }, next_reset_at: '2026-10-05T00:00:00+03:00', ...(STATUS[scenario] || {}),
  };

  const json = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(data))) });
  let built = scenario !== 'building';
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    const u = new URL(String(url), location.href);
    if (!u.pathname.startsWith('/api/daily-matches')) return realFetch(url, opts);
    const p = u.pathname.replace('/api/daily-matches', '');
    if (p === '/status') return json(built && scenario === 'building' ? { ...status, today: { status: 'done', cards: 3 } } : status);
    if (p === '/today') {
      if (scenario === 'quiet') return json({ run: { id: 1, status: 'done', pool_size: 1284, fresh: 18, candidates: 18, cards: 0 }, cards: [], entitlement: 'subscription' });
      return json({ run: { id: 1, status: 'done', pool_size: 1284, fresh: 31, candidates: 23, cards: 3 }, cards: DECK, entitlement: 'subscription' });
    }
    if (p.startsWith('/results/')) return json({ ok: true });
    if (p === '/saved') return json({ cards: [] });
    if (p === '/run') {
      const events = [{ type: 'started', run_id: 1 }, { type: 'cv_ready', count: 2 }, { type: 'candidates', pool: 1284, embedded: 1280, fresh: 31, candidates: 23 }]
        .concat(Array.from({ length: 23 }, (_, i) => ({ type: 'progress', done: i + 1, total: 23 })))
        .concat([{ type: 'done', run_id: 1, count: 3, strong: 2, maybe: 1, analyzed: 23, fresh: 31 }]);
      let i = 0;
      const enc = new TextEncoder();
      return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({
        read: () => new Promise(r => setTimeout(() => {
          if (i < events.length) r({ done: false, value: enc.encode(`data: ${JSON.stringify(events[i++])}\n\n`) });
          else { built = true; r({ done: true }); }
        }, i < 3 ? 500 : 280)),
      }) } });
    }
    return Promise.reject(new Error('preview: unknown ' + p));
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
    tabs: { create: (o) => { console.log('[preview] tabs.create', o.url); return Promise.resolve({ id: 1 }); },
      get: () => Promise.resolve({ status: 'complete' }), onUpdated: { addListener() {}, removeListener() {} } },
    scripting: { executeScript: () => Promise.resolve([{ result: { found: true, filled: ['Full name', 'Email', 'Phone', 'LinkedIn'], left: ['Current location'], attached: true, fileName: 'Backend_CV.pdf' } }]) },
    downloads: { download: () => Promise.resolve(1) },
    runtime: { getURL: (p) => p },
  };
  if (scenario === 'library') {
    const open = () => { const b = document.querySelector('[data-act="library"]'); if (b) b.click(); else setTimeout(open, 100); };
    setTimeout(open, 300);
  }
})();
