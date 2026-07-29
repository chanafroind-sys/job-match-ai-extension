// background.js runs in an MV3 service worker: no DOM, no DOMParser.
// Pull the extractor out of the real file and exercise it under those rules.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

const start = bg.indexOf('const HTML_ENTITIES = {');
const endMarker = '    function extractJobTextFromHtml(html) {';
const end = bg.indexOf('\n    }', bg.indexOf(endMarker)) + '\n    }'.length;
if (start < 0 || end < start) { console.error('could not slice extractor out of background.js'); process.exit(1); }
const src = bg.slice(start, end);

// A service-worker-like sandbox: explicitly no DOM globals.
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(src + '\n; this.extractJobTextFromHtml = extractJobTextFromHtml; this.htmlToText = htmlToText;', sandbox);
const { extractJobTextFromHtml } = sandbox;

// matcher.js expects a browser `window`.
const mwin = { };
const msandbox = { window: mwin, console };
vm.createContext(msandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'matcher.js'), 'utf8'), msandbox);
const Matcher = mwin.JMA_Matcher;

const LINKEDIN_HTML = `<!doctype html><html><head><style>.x{color:red}</style>
<script>var tracking = {a:1};</script></head><body>
<nav><a href="/">Home</a><a href="/jobs">Jobs</a></nav>
<header>LinkedIn&nbsp;&mdash; sign in</header>
<div class="jobs-description">
  <h2>About the job</h2>
  <p>We are hiring a Senior Backend Engineer.</p>
  <h3>Requirements:</h3>
  <ul>
    <li>5+ years of professional experience in backend development</li>
    <li>3 years experience with Python</li>
    <li>Strong knowledge of SQL and PostgreSQL</li>
    <li>Experience with Docker, Kubernetes &amp; AWS</li>
  </ul>
  <h3>Nice to have:</h3>
  <ul><li>Experience with Kafka</li><li>Familiarity with Terraform</li></ul>
</div>
<footer>&copy; 2026</footer></body></html>`;

const PROFILE = {
  industry_summary: { total_years_industry: 6, domain_years: { backend: 6, devops_cloud: 3 } },
  experience: {
    backend: {
      Python:     { industry_years: 5, personal_years: 1, search_tags: ['python'] },
      PostgreSQL: { industry_years: 4, personal_years: 0, search_tags: ['postgresql', 'sql'] },
    },
    devops_cloud: {
      Docker:     { industry_years: 3, personal_years: 0, search_tags: ['docker'] },
      Kubernetes: { industry_years: 2, personal_years: 0, search_tags: ['kubernetes'] },
      AWS:        { industry_years: 3, personal_years: 0, search_tags: ['aws'] },
    },
  },
};

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const text = extractJobTextFromHtml(LINKEDIN_HTML);

check('returns text without DOMParser (old code threw here)', text.length > 100, `len=${text.length}`);
check('scripts and styles stripped',
      !text.includes('tracking') && !text.includes('color:red'), text.slice(0, 60).replace(/\n/g, '⏎'));
check('nav/header/footer stripped', !text.includes('sign in') && !text.includes('© 2026'), 'ok');
check('entities decoded', text.includes('Docker, Kubernetes & AWS'), 'ok');
check('each <li> is on its own line',
      text.split('\n').filter(l => l.trim().startsWith('3 years experience with Python')).length === 1 &&
      text.split('\n').length >= 8,
      `lines=${text.split('\n').length}`);
check('anchored on the requirements heading', /Requirements:/.test(text), 'ok');

// The point of preserving newlines: matcher.js routes lines through a
// requirements/advantages state machine.
const sections = Matcher._parseJobSections(text);
check('matcher finds a required section', sections.requiredText.length > 50,
      `required=${sections.requiredText.length} chars`);
check('matcher finds an advantages section', sections.advantageText.includes('Kafka'),
      `advantage="${sections.advantageText.replace(/\n/g, ' | ').slice(0, 70)}"`);

// Compare against the old flattening behaviour on the same content.
const flattened = text.replace(/\s+/g, ' ');
const flatSections = Matcher._parseJobSections(flattened);
const withLines = Matcher.computeScore(PROFILE, text);
const withoutLines = Matcher.computeScore(PROFILE, flattened);
check('flattened text loses the section split (why newlines matter)',
      flatSections.advantageText.length === 0,
      `lines: req=${sections.requiredText.length}/adv=${sections.advantageText.length} · ` +
      `flat: req=${flatSections.requiredText.length}/adv=${flatSections.advantageText.length}`);
check('scoring works on the line-preserved text', withLines.score > 0,
      `score(lines)=${withLines.score} vs score(flattened)=${withoutLines.score}`);

// Malformed input must not throw.
for (const bad of ['', null, undefined, '<div><p>unclosed', '<<>>', 'plain text no tags']) {
  try { extractJobTextFromHtml(bad); } catch (e) {
    check(`survives malformed input ${JSON.stringify(bad)}`, false, e.message);
  }
}
check('survives empty/malformed input', true, 'no throw');

let fail = 0;
for (const t of results) {
  console.log(`${t.ok ? '✓' : '✗'} ${t.name}\n    ${t.detail}`);
  if (!t.ok) fail++;
}
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
