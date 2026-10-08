// Daily Matches auto-fill (daily/dm-apply.js formFill) on forms shaped like
// the live ones it was tried on (2026-10-08), plus the COMPANY_RADAR.md §7
// hard rule as a test: the extension never submits, never clicks a submit
// control, never invents answers, never touches a password page.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const DAILY = path.join(ROOT, 'daily');
const APPLY = fs.readFileSync(path.join(DAILY, 'dm-apply.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✓ ${name}`); } else { failed++; console.log(`✗ ${name}`); }
  if (detail && !cond) console.log(`    ${detail}`);
}

// jsdom has no layout: "visible" here means no hidden attribute and no
// display:none on the element or above it (through shadow hosts too). It has
// no DataTransfer either; a minimal one lets a file input take a File.
function page(html, url = 'https://jobs.example-ats.com/acme/1/apply') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  const { window } = dom;
  const hidden = (el) => {
    for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
      if (n.hidden || (n.style && n.style.display === 'none')) return true;
    }
    return false;
  };
  const P = window.HTMLElement.prototype;
  Object.defineProperty(P, 'offsetWidth', { configurable: true, get() { return hidden(this) ? 0 : 100; } });
  Object.defineProperty(P, 'offsetHeight', { configurable: true, get() { return hidden(this) ? 0 : 20; } });
  P.getClientRects = function () { return hidden(this) ? [] : [{}]; };
  window.DataTransfer = class {
    constructor() { this.list = []; this.items = { add: (f) => this.list.push(f) }; }
    get files() { return this.list; }
  };
  Object.defineProperty(window.HTMLInputElement.prototype, 'files', { configurable: true,
    get() { return this._files || []; }, set(v) { this._files = v; } });
  window.eval(APPLY);
  return window;
}

const PROFILE = { fullName: 'Noa Bat-Sheva Levi', email: 'noa@example.com', phone: '050-123-4567',
  location: '', company: 'Lumen', linkedin: 'https://linkedin.com/in/noa' };
const FILE = { name: 'Noa_Levi_CV.pdf', type: 'application/pdf', b64: Buffer.from('%PDF-1.4 cv').toString('base64') };

// Counts every way a form could be sent, so "never submits" is checked, not assumed.
function guard(window) {
  let sends = 0;
  const doc = window.document;
  doc.addEventListener('submit', (e) => { sends++; e.preventDefault(); }, true);
  doc.querySelectorAll('form').forEach(f => { f.submit = () => { sends++; }; f.requestSubmit = () => { sends++; }; });
  doc.querySelectorAll('button, input[type="submit"]').forEach(b => b.addEventListener('click', () => { sends++; }));
  return () => sends;
}

(async () => {
  // ── Lever: a native form ────────────────────────────────────────────────────
  let w = page(`
    <form id="application-form" method="post" enctype="multipart/form-data" action="/apply">
      <label>Resume/CV ✱ <input type="file" name="resume" style="display:none"></label>
      <label>Full name ✱ <input name="name"></label><label>Email ✱ <input name="email"></label>
      <label>Phone ✱ <input name="phone"></label><label>Current location <input name="location"></label>
      <label>Current company <input name="org" value="Already typed Ltd"></label>
      <label>LinkedIn URL <input name="urls[LinkedIn]"></label>
      <label>Anything else? <textarea name="comments"></textarea></label>
      <button id="btn-submit" type="submit">Submit application</button>
    </form>`, 'https://jobs.lever.co/acme/1/apply');
  let sends = guard(w);
  const inputs = [];
  w.document.querySelectorAll('input').forEach(i => i.addEventListener('input', () => inputs.push(i.name)));
  let r = await w.JMA_DM.apply.formFill(PROFILE, FILE);
  const val = (n) => w.document.querySelector(`[name="${n}"]`).value;
  ok('Lever: fills the person\'s own fields', val('name') === 'Noa Bat-Sheva Levi' && val('email') === 'noa@example.com' &&
     val('phone') === '050-123-4567' && val('urls[LinkedIn]') === 'https://linkedin.com/in/noa', JSON.stringify(r));
  ok('fires input events so the page sees the values', ['name', 'email', 'phone'].every(n => inputs.includes(n)));
  ok('never overwrites what the user already typed', val('org') === 'Already typed Ltd' && r.filled.includes('חברה נוכחית'));
  ok('a field with no data stays empty and is reported', val('location') === '' && r.left.includes('מיקום'));
  ok('never answers free-text questions', w.document.querySelector('[name="comments"]').value === '');
  ok('attaches the CV to the resume input', r.attached && w.document.querySelector('[name="resume"]').files[0].name === 'Noa_Levi_CV.pdf');
  ok('and says so next to it when the page won\'t', !!w.document.getElementById('jma-dm-attached-note'));
  ok('NEVER submits, clicks submit or fires a submit event', sends() === 0);
  ok('only highlights the submit button for the human', w.document.getElementById('btn-submit').style.outline.includes('3px'));

  // ── Greenhouse: React ids, LinkedIn as a custom question ────────────────────
  w = page(`
    <form id="application-form">
      <label for="first_name">First Name*</label><input id="first_name" type="text" autocomplete="given-name">
      <label for="last_name">Last Name*</label><input id="last_name" type="text" autocomplete="family-name">
      <label for="email">Email*</label><input id="email" type="text" value="mine@example.com">
      <label for="country">Country*</label><input id="country" role="combobox" type="text">
      <label for="phone">Phone*</label><input id="phone" type="tel">
      <label for="resume">Attach</label><input id="resume" type="file" style="display:none">
      <label for="cover_letter">Attach</label><div>Cover Letter <input id="cover_letter" type="file" style="display:none"></div>
      <label for="question_1">LinkedIn Profile</label><input id="question_1" type="text">
      <label for="question_2">Referrer email</label><input id="question_2" type="email">
      <label for="question_3">How many years of experience do you have?*</label><input id="question_3" type="text" required>
      <button type="submit">Submit application</button>
    </form>`, 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1');
  sends = guard(w);
  const first = w.document.getElementById('first_name');
  // React's value tracker lives on the element itself; a fill that went through
  // it would leave React thinking nothing changed.
  const proto = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value');
  let trackerWrites = 0;
  Object.defineProperty(first, 'value', { configurable: true, get() { return proto.get.call(this); },
    set(v) { trackerWrites++; proto.set.call(this, v); } });
  const events = [];
  first.addEventListener('input', () => events.push('input'));
  first.addEventListener('focusout', () => events.push('focusout'));
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE);
  const gv = (id) => w.document.getElementById(id).value;
  ok('Greenhouse: splits the name and fills phone and LinkedIn', gv('first_name') === 'Noa Bat-Sheva' && gv('last_name') === 'Levi' &&
     gv('phone') === '050-123-4567' && gv('question_1') === 'https://linkedin.com/in/noa', JSON.stringify(r));
  ok('goes around React\'s value tracker and fires the events React reads',
     trackerWrites === 0 && events.includes('input') && events.includes('focusout'));
  ok('keeps the user\'s email, skips lists, never fills someone else\'s email', gv('email') === 'mine@example.com' &&
     gv('country') === '' && gv('question_2') === '');
  ok('the CV goes in the resume input, never the cover letter', w.document.getElementById('resume').files.length === 1 &&
     w.document.getElementById('cover_letter').files.length === 0);
  ok('the company\'s required questions are counted for the human', r.questions === 1 && gv('question_3') === '');
  ok('Greenhouse: never submits', sends() === 0);

  // ── Ashby on a company site: the form twice, one hidden; a résumé parser box ──
  w = page(`
    <div class="careers">
      <div class="copy-desktop">
        <div>Autofill from resume <input type="file" id="autofill-resume" style="display:none"></div>
        <label for="_systemfield_name">Name</label><input id="_systemfield_name" type="text">
        <label for="_systemfield_email">Email</label><input id="_systemfield_email" type="email">
        <label for="src-li">LinkedIn</label><input id="src-li" type="radio" name="source">
        <label for="u-phone">Phone</label><input id="u-phone" type="tel">
        <div><label for="_systemfield_resume">Resume</label><input id="_systemfield_resume" type="file" style="display:none"></div>
        <button class="ashby-application-form-submit-button">Submit Application</button>
      </div>
      <div class="copy-mobile" style="display:none">
        <input id="m_name" name="_systemfield_name" type="text"><input id="m_email" name="_systemfield_email" type="email">
        <div>Resume <input id="m_resume" type="file"></div>
      </div>
    </div>`, 'https://monday.com/careers/1');
  sends = guard(w);
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE);
  const d = w.document;
  ok('Ashby: fills the visible form', d.getElementById('_systemfield_name').value === 'Noa Bat-Sheva Levi' &&
     d.getElementById('_systemfield_email').value === 'noa@example.com' && d.getElementById('u-phone').value === '050-123-4567',
     JSON.stringify(r));
  ok('and leaves the hidden copy alone', d.getElementById('m_name').value === '' && d.getElementById('m_resume').files.length === 0);
  ok('the CV skips the "autofill from resume" parser', d.getElementById('_systemfield_resume').files.length === 1 &&
     d.getElementById('autofill-resume').files.length === 0);
  ok('never picks the "how did you hear" LinkedIn option', d.getElementById('src-li').checked === false);
  ok('highlights a submit button found by its text', d.querySelector('.ashby-application-form-submit-button').style.outline.includes('3px') &&
     sends() === 0);

  // ── SmartRecruiters: fields inside shadow roots ─────────────────────────────
  w = page(`<main><section id="easy"><p>Easy Apply. Choose an option to autocomplete your application.</p></section>
    <section id="personal"></section><section id="cv"><h3>Resume</h3></section></main>`,
    'https://jobs.smartrecruiters.com/oneclick-ui/company/acme/publication/1');
  const shadowField = (where, html) => {
    const host = w.document.createElement('spl-input');
    w.document.getElementById(where).appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML = html;
    return host.shadowRoot;
  };
  const parse = shadowField('easy', '<oc-apply-with-resume><div>Choose a file or drop it here <input type="file" id="f2"></div></oc-apply-with-resume>');
  const fn = shadowField('personal', '<label for="first-name-input">First name</label><input id="first-name-input" autocomplete="given-name">');
  const em = shadowField('personal', '<label for="email-input">Email</label><input type="email" id="email-input" autocomplete="email">');
  const cf = shadowField('personal', '<label for="confirm-email-input">Confirm your email</label><input type="email" id="confirm-email-input" autocomplete="email">');
  const cvRoot = shadowField('cv', '<oc-resume-upload><div>Choose a file or drop it here <input type="file" id="f1"></div></oc-resume-upload>');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE);
  ok('SmartRecruiters: reads and fills fields inside shadow roots', fn.getElementById('first-name-input').value === 'Noa Bat-Sheva' &&
     em.getElementById('email-input').value === 'noa@example.com' && cf.getElementById('confirm-email-input').value === 'noa@example.com',
     JSON.stringify(r));
  ok('and tells the résumé box from the "apply with résumé" parser', cvRoot.getElementById('f1').files.length === 1 &&
     parse.getElementById('f2').files.length === 0);

  // ── Comeet (the comeet.co iframe) and Workable (LinkedIn in a text box) ──────
  w = page(`<form>
      <label for="inputFirstName">First name</label><input id="inputFirstName" name="firstName" autocomplete="given-name">
      <label for="inputLastName">Last name</label><input id="inputLastName" name="lastName" autocomplete="family-name">
      <label for="inputEmail">Email</label><input id="inputEmail" type="email" name="email">
      <label for="inputTel">Phone</label><input id="inputTel" type="tel" name="phone">
      <label for="cv">Resume</label><input id="cv" name="cv" type="file">
      <label for="coverLetter">Cover Letter</label><input id="coverLetter" name="coverLetter" type="file">
      <label for="portfolio">Portfolio</label><input id="portfolio" name="portfolio" type="file">
      <label for="inputNote">Personal note</label><textarea id="inputNote" name="comment"></textarea>
      <button type="submit">Submit application</button></form>`, 'https://www.comeet.co/jobs/73.00B/46.076/apply');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE);
  const cd = w.document;
  ok('Comeet: name, email, phone and the CV, nothing else', cd.getElementById('inputLastName').value === 'Levi' &&
     cd.getElementById('inputTel').value === '050-123-4567' && cd.getElementById('cv').files.length === 1 &&
     cd.getElementById('coverLetter').files.length === 0 && cd.getElementById('portfolio').files.length === 0 &&
     cd.getElementById('inputNote').value === '', JSON.stringify(r));

  w = page(`<form>
      <label for="firstname">*First name</label><input id="firstname" name="firstname">
      <label for="lastname">*Last name</label><input id="lastname" name="lastname">
      <label for="email">*Email</label><input id="email" name="email" type="email">
      <div><span>Resume</span><input type="file" id="input_files_input_x"></div>
      <label for="CA_1">*Github profile</label><textarea id="CA_1"></textarea>
      <label for="CA_2">*Linkedin</label><textarea id="CA_2"></textarea>
      <label for="summary">Summary (Optional)</label><textarea id="summary"></textarea></form>`,
    'https://apply.workable.com/acme/j/1/apply/');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE);
  ok('Workable: LinkedIn asked in a text box is filled; other text boxes are questions',
     w.document.getElementById('CA_2').value === 'https://linkedin.com/in/noa' && w.document.getElementById('CA_1').value === '' &&
     w.document.getElementById('summary').value === '', JSON.stringify(r));

  // ── Hebrew labels ───────────────────────────────────────────────────────────
  w = page(`<form dir="rtl">
      <label for="a">שם פרטי</label><input id="a"><label for="b">שם משפחה</label><input id="b">
      <label for="c">דוא"ל</label><input id="c"><label for="d">טלפון נייד</label><input id="d">
      <label for="e">שם הממליץ</label><input id="e">
      <label for="f">קורות חיים</label><input id="f" type="file"></form>`, 'https://careers.acme.co.il/job/1');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE);
  const hv = (id) => w.document.getElementById(id).value;
  ok('a Hebrew form is read by its Hebrew labels', hv('a') === 'Noa Bat-Sheva' && hv('b') === 'Levi' && hv('c') === 'noa@example.com' &&
     hv('d') === '050-123-4567' && hv('e') === '' && w.document.getElementById('f').files.length === 1, JSON.stringify(r));

  // ── what is never filled ────────────────────────────────────────────────────
  w = page(`<form><label for="e">Email</label><input id="e" type="email"><label for="n">Name</label><input id="n">
    <button type="submit">Request a demo</button></form>`, 'https://www.acme.com/careers');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE);
  ok('a form without a place for a CV (a demo request) is not an application: untouched',
     r.found === false && w.document.getElementById('e').value === '' && w.document.getElementById('n').value === '');

  w = page(`<form><label for="e">Email</label><input id="e" type="email"><label for="p">Password</label><input id="p" type="password">
    <label for="cv">Resume</label><input id="cv" type="file"></form>`, 'https://acme.wd3.myworkdayjobs.com/en-US/careers/apply');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE);
  ok('a sign-in or sign-up page is never filled: no passwords, no accounts',
     r.blocked === 'password' && w.document.getElementById('e').value === '' && w.document.getElementById('cv').files.length === 0);

  w = page(LEVER_FORM_LIKE());
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, { dry: true });
  ok('a dry run only looks', r.found === true && w.document.querySelector('[name="email"]').value === '' && r.plan.length >= 3);

  // ── profile suggestions ─────────────────────────────────────────────────────
  const derived = w.JMA_DM.apply.deriveProfile(
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
  ok('LinkedIn, Indeed and Glassdoor pages are never filled', /BOARD_HOSTS = .*linkedin\\\.com.*indeed\\\.com.*glassdoor/.test(APPLY));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

function LEVER_FORM_LIKE() {
  return `<form><label>Full name <input name="name"></label><label>Email <input name="email"></label>
    <label>Phone <input name="phone"></label><label>Resume <input type="file" name="resume"></label></form>`;
}
