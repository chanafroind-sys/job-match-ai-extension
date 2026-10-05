// Daily Matches auto-fill (daily/dm-apply.js leverFill) on a Lever-shaped
// form, plus the COMPANY_RADAR.md §7 hard rule as a test: the extension never
// submits, never clicks a submit control, never invents answers.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const DAILY = path.join(ROOT, 'daily');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✓ ${name}`); } else { failed++; console.log(`✗ ${name}`); }
  if (detail && !cond) console.log(`    ${detail}`);
}

// Field names verified on a live Lever form (COMPANY_RADAR.md §8).
const LEVER_FORM = `
  <form id="application-form" method="post" enctype="multipart/form-data" action="/apply">
    <input type="file" name="resume" id="resume-upload-input">
    <input name="name"><input name="email"><input name="phone">
    <input name="location"><input name="org" value="Already typed Ltd">
    <input name="urls[LinkedIn]"><textarea name="comments"></textarea>
    <button id="btn-submit" type="submit">Submit application</button>
  </form>`;

function page(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://jobs.lever.co/acme/1/apply' });
  dom.window.eval(fs.readFileSync(path.join(DAILY, 'dm-apply.js'), 'utf8'));
  return dom.window;
}

const PROFILE = { fullName: 'Noa Levi', email: 'noa@example.com', phone: '050-123-4567',
  location: '', company: 'Lumen', linkedin: 'https://linkedin.com/in/noa' };

(() => {
  const window = page(LEVER_FORM);
  const doc = window.document;
  const form = doc.getElementById('application-form');
  let submits = 0;
  form.addEventListener('submit', (e) => { submits++; e.preventDefault(); });
  form.submit = () => { submits++; };
  form.requestSubmit = () => { submits++; };
  doc.getElementById('btn-submit').addEventListener('click', () => { submits++; });
  const inputs = [];
  doc.querySelectorAll('input').forEach(i => i.addEventListener('input', () => inputs.push(i.name)));

  const result = window.JMA_DM.apply.leverFill(PROFILE, null);
  const val = (n) => doc.querySelector(`[name="${n}"]`).value;
  ok('fills the fields it has data for', val('name') === 'Noa Levi' && val('email') === 'noa@example.com' &&
     val('phone') === '050-123-4567' && val('urls[LinkedIn]') === 'https://linkedin.com/in/noa');
  ok('fires input events so the page sees the values', ['name', 'email', 'phone'].every(n => inputs.includes(n)));
  ok('never overwrites what the user already typed', val('org') === 'Already typed Ltd');
  ok('leaves a field empty when there is no data for it', val('location') === '' && result.left.includes('Current location'));
  ok('never touches free-text questions', doc.querySelector('[name="comments"]').value === '');
  ok('reports what it did', result.found && result.filled.length === 5, JSON.stringify(result));
  ok('no CV file means nothing is attached, and says so', result.attached === false && result.left.includes('Resume/CV'));
  ok('NEVER submits, clicks submit or fires a submit event', submits === 0);
  ok('only highlights the submit button for the human', doc.getElementById('btn-submit').style.outline.includes('3px'));

  const other = page('<form><input name="q"></form>');
  const none = other.JMA_DM.apply.leverFill(PROFILE, null);
  ok('a page without Lever fields is reported as not found', none.found === false && none.filled.length === 0);

  const derived = window.JMA_DM.apply.deriveProfile(
    'Noa Levi\nTel Aviv | noa.levi@example.com | +972 50-123-4567\nlinkedin.com/in/noa-levi\nExperience\n• Python');
  ok('profile suggestions come from the CV', derived.fullName === 'Noa Levi' && derived.email === 'noa.levi@example.com' &&
     derived.phone === '+972 50-123-4567' && derived.linkedin === 'https://linkedin.com/in/noa-levi', JSON.stringify(derived));
  ok('location and company are never guessed', derived.location === '' && derived.company === '');

  // ── the hard rule, enforced on the source ──────────────────────────────────
  const FORBIDDEN = [/\.submit\s*\(/, /requestSubmit/, /new\s+(?:Submit)?Event\(\s*['"]submit/, /\.click\s*\(\s*\)/];
  const offenders = [];
  for (const file of fs.readdirSync(DAILY).filter(f => f.endsWith('.js'))) {
    fs.readFileSync(path.join(DAILY, file), 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (FORBIDDEN.some(re => re.test(code))) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  ok('no daily/*.js code can submit a form or click a control', offenders.length === 0, offenders.join('\n    '));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
