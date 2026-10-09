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

const PROFILE = { firstName: 'Noa Bat-Sheva', lastName: 'Levi', email: 'noa@example.com', phone: '050-123-4567',
  city: '', company: 'Lumen', linkedin: 'https://linkedin.com/in/noa' };
// The real waits are for real pages; here a page answers at once.
const FAST = { timing: { stick: 20, confirm: 20, retry: 20 } };
// Pages that show a chosen file's name, as React upload widgets do.
function showsFiles(window) {
  window.document.querySelectorAll('input[type="file"]').forEach(input => input.addEventListener('change', () => {
    const span = window.document.createElement('span');
    span.textContent = input.files[0] ? input.files[0].name : '';
    input.insertAdjacentElement('afterend', span);
  }));
}
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
  let r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
  const val = (n) => w.document.querySelector(`[name="${n}"]`).value;
  ok('Lever: fills the person\'s own fields', val('name') === 'Noa Bat-Sheva Levi' && val('email') === 'noa@example.com' &&
     val('phone') === '050-123-4567' && val('urls[LinkedIn]') === 'https://linkedin.com/in/noa', JSON.stringify(r));
  ok('fires input events so the page sees the values', ['name', 'email', 'phone'].every(n => inputs.includes(n)));
  ok('never overwrites what the user already typed', val('org') === 'Already typed Ltd' && r.filled.includes('חברה נוכחית'));
  ok('a field with no data stays empty and is reported', val('location') === '' && r.left.includes('עיר'));
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
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
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
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
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
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
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
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
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
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
  ok('Workable: LinkedIn asked in a text box is filled; other text boxes are questions',
     w.document.getElementById('CA_2').value === 'https://linkedin.com/in/noa' && w.document.getElementById('CA_1').value === '' &&
     w.document.getElementById('summary').value === '', JSON.stringify(r));

  // ── Hebrew labels ───────────────────────────────────────────────────────────
  w = page(`<form dir="rtl">
      <label for="a">שם פרטי</label><input id="a"><label for="b">שם משפחה</label><input id="b">
      <label for="c">דוא"ל</label><input id="c"><label for="d">טלפון נייד</label><input id="d">
      <label for="e">שם הממליץ</label><input id="e">
      <label for="f">קורות חיים</label><input id="f" type="file"></form>`, 'https://careers.acme.co.il/job/1');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
  const hv = (id) => w.document.getElementById(id).value;
  ok('a Hebrew form is read by its Hebrew labels', hv('a') === 'Noa Bat-Sheva' && hv('b') === 'Levi' && hv('c') === 'noa@example.com' &&
     hv('d') === '050-123-4567' && hv('e') === '' && w.document.getElementById('f').files.length === 1, JSON.stringify(r));

  // ── the CV: confirmed by the page, retried once, never claimed ───────────────
  const GH_UPLOAD = `<form id="application-form">
      <label for="first_name">First Name*</label><input id="first_name" type="text">
      <label for="email">Email*</label><input id="email" type="email">
      <label for="resume">Attach</label><input id="resume" type="file" style="display:none">
      <button type="submit">Submit application</button></form>`;
  w = page(GH_UPLOAD, 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1');
  showsFiles(w);
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
  ok('a page that shows the file is a CV attached, with no note of ours', r.attached &&
     !w.document.getElementById('jma-dm-attached-note'));

  w = page(GH_UPLOAD, 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1');
  let changes = 0;
  w.document.getElementById('resume').addEventListener('change', () => { // its scripts wake up after the first try
    if (++changes < 2) return;
    const span = w.document.createElement('span');
    span.textContent = w.document.getElementById('resume').files[0].name;
    w.document.body.appendChild(span);
  });
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
  ok('a page that wasn\'t ready gets the file again', r.attached && changes === 2);

  w = page(GH_UPLOAD, 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
  ok('a page that never takes it: reported as left, never "attached"', !r.attached && r.left.includes('קורות חיים') &&
     !w.document.getElementById('jma-dm-attached-note'));

  // ── the person's own answers in lists and option buttons ─────────────────────
  const LEVER_QUESTIONS = `<form method="post" enctype="multipart/form-data" action="/apply">
      <label>Resume/CV <input type="file" name="resume"></label>
      <label>Full name <input name="name"></label><label>Email <input name="email"></label>
      <li class="application-question"><div>Are you currently authorized to work in the country in which you are applying? ✱</div>
        <ul><li><label><input type="radio" name="cards[a][field0]" value="Yes"><span>Yes</span></label></li>
            <li><label><input type="radio" name="cards[a][field0]" value="No"><span>No</span></label></li></ul></li>
      <li class="application-question"><div>Does your current authorization require renewal or sponsorship in the future? ✱</div>
        <ul><li><label><input type="radio" name="cards[a][field1]" value="Yes"><span>Yes</span></label></li>
            <li><label><input type="radio" name="cards[a][field1]" value="No"><span>No</span></label></li></ul></li>
      <li class="application-question"><div>Are you a current employee? ✱</div>
        <select name="cards[b][field0]"><option value="">Select...</option><option>No</option><option>Yes</option></select></li>
      <label>Gender <select name="eeo[gender]"><option value="">Select ...</option><option value="Male">Male</option>
        <option value="Female">Female</option><option value="Decline to self-identify">Decline to self-identify</option></select></label>
      <label>Veteran status <select name="eeo[veteran]"><option value="">Select ...</option><option>I am a veteran</option>
        <option>I am not a veteran</option></select></label>
      <label>How did you hear about us? <select name="cards[c][field0]"><option value="">Select...</option>
        <option>LinkedIn</option><option>Company website</option><option>Friend</option></select></label>
    </form>`;
  const ANSWERS = { ...PROFILE, gender: 'female', workAuth: 'yes', sponsorship: 'no', heardFrom: 'LinkedIn' };
  w = page(LEVER_QUESTIONS, 'https://jobs.lever.co/acme/1/apply');
  sends = guard(w);
  r = await w.JMA_DM.apply.formFill(ANSWERS, FILE, FAST);
  const q = (sel) => w.document.querySelector(sel);
  const picked = (name) => (w.document.querySelector(`input[name="${name}"]:checked`) || {}).value;
  ok('gender, work authorization and sponsorship come from the saved answers', q('[name="eeo[gender]"]').value === 'Female' &&
     picked('cards[a][field0]') === 'Yes' && picked('cards[a][field1]') === 'No', JSON.stringify(r));
  ok('"how did you hear" picks the person\'s own wording', q('[name="cards[c][field0]"]').value === 'LinkedIn');
  ok('questions with no saved answer stay the human\'s', q('[name="cards[b][field0]"]').value === '' &&
     q('[name="eeo[veteran]"]').value === '');
  ok('and are reported as filled only when picked', ['מגדר', 'אישור עבודה', 'אשרה', 'איך שמעת'].every(l => r.filled.includes(l)) &&
     sends() === 0);

  w = page(LEVER_QUESTIONS, 'https://jobs.lever.co/acme/1/apply');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
  ok('without saved answers nothing is picked, and nothing is reported missing',
     w.document.querySelector('[name="eeo[gender]"]').value === '' && !w.document.querySelector('input[type="radio"]:checked') &&
     !r.left.includes('מגדר'));

  w = page(`<form><label>Email <input name="email" type="email"></label><label>Resume <input type="file" name="resume"></label>
    <label>Gender <select name="g"><option value="">Select</option><option>Male</option><option>Female (cis)</option><option>Female (trans)</option></select></label>
    <label>Are you authorized to work in Israel without visa sponsorship? <select name="w"><option value="">-</option><option>Yes</option><option>No</option></select></label></form>`);
  r = await w.JMA_DM.apply.formFill(ANSWERS, FILE, FAST);
  ok('two matching options, or a question that mixes two of ours: left alone', w.document.querySelector('[name="g"]').value === '' &&
     w.document.querySelector('[name="w"]').value === '');

  w = page(`<form><label>Email <input name="email" type="email"></label><label>Resume <input type="file" name="resume"></label>
    <label>Gender <select name="g"><option value="">Select</option><option selected>Male</option><option>Female</option></select></label></form>`);
  r = await w.JMA_DM.apply.formFill(ANSWERS, FILE, FAST);
  ok('an answer the user already picked is kept', w.document.querySelector('[name="g"]').value === 'Male');

  // ── more of the person's details ────────────────────────────────────────────
  const MORE = { ...PROFILE, firstNameHe: 'נועה', lastNameHe: 'לוי', github: 'https://github.com/noa', website: 'https://noa.dev',
    title: 'Backend Developer', years: '6', salary: '', city: 'Tel Aviv',
    coverLetter: 'Hello, I am Noa. I build backend systems in Python and Kafka.' };
  w = page(`<form>
      <label for="fn">First name</label><input id="fn"><label for="ln">Last name</label><input id="ln">
      <label for="em">Email</label><input id="em" type="email">
      <label for="gh">GitHub URL</label><input id="gh"><label for="ws">Portfolio</label><input id="ws">
      <label for="tt">Current title</label><input id="tt"><label for="yr">Years of experience</label><input id="yr" type="number">
      <label for="yp">How many years of experience do you have with Go?</label><input id="yp" type="number">
      <label for="sl">Salary expectations</label><input id="sl">
      <label for="cl">Cover Letter</label><textarea id="cl"></textarea>
      <label for="why">Why do you want to join us?</label><textarea id="why"></textarea>
      <label for="cv">Resume</label><input id="cv" type="file"></form>`);
  showsFiles(w);
  r = await w.JMA_DM.apply.formFill(MORE, FILE, FAST);
  const v = (id) => w.document.getElementById(id).value;
  ok('links, title and total years go where they are asked', v('gh') === 'https://github.com/noa' && v('ws') === 'https://noa.dev' &&
     v('tt') === 'Backend Developer' && v('yr') === '6', JSON.stringify(r));
  ok('a years-with-one-technology question is the human\'s', v('yp') === '');
  ok('no saved salary: the salary field stays empty and is not "missing"', v('sl') === '' && !r.left.includes('ציפיות שכר'));
  ok('the cover letter goes in its box; other text boxes stay the human\'s', v('cl') === MORE.coverLetter && v('why') === '' &&
     r.letter === 'typed');

  w = page(`<form dir="rtl">
      <label for="a">שם פרטי</label><input id="a"><label for="b">שם משפחה</label><input id="b">
      <label for="c">דוא"ל</label><input id="c"><label for="f">קורות חיים</label><input id="f" type="file"></form>`);
  r = await w.JMA_DM.apply.formFill(MORE, FILE, FAST);
  ok('a Hebrew form gets the Hebrew name when there is one', w.document.getElementById('a').value === 'נועה' &&
     w.document.getElementById('b').value === 'לוי');

  w = page(`<form><label for="e">Email</label><input id="e" type="email">
      <div>Resume/CV <input id="cv" type="file"></div>
      <div>Cover Letter <input id="letter" type="file" accept=".pdf,.doc,.docx,.txt,.rtf"></div></form>`);
  showsFiles(w);
  r = await w.JMA_DM.apply.formFill(MORE, FILE, FAST);
  const letterFile = w.document.getElementById('letter').files[0];
  ok('a form that wants the letter as a file gets it as a text file', r.letter === 'attached' && letterFile &&
     letterFile.name === 'Noa_Bat-Sheva_Levi_Cover_Letter.txt' && letterFile.type === 'text/plain' &&
     w.document.getElementById('cv').files[0].name === 'Noa_Levi_CV.pdf');

  w = page(`<form><label for="e">Email</label><input id="e" type="email"><div>Resume <input id="cv" type="file"></div>
      <div>Cover Letter <input id="letter" type="file" accept=".pdf"></div></form>`);
  r = await w.JMA_DM.apply.formFill(MORE, FILE, FAST);
  ok('never a text file where the form takes only PDF', !w.document.getElementById('letter').files.length && !r.letter);

  // ── the details model ───────────────────────────────────────────────────────
  const A = w.JMA_DM.apply;
  ok('details saved as one full name are read as first and last', A.forForm({ fullName: 'Noa Levi', location: 'Haifa' }).firstName === 'Noa' &&
     A.forForm({ fullName: 'נועה לוי' }).firstNameHe === 'נועה' && A.forForm({ location: 'Haifa' }).city === 'Haifa');
  ok('each CV version can have its own cover letter, else the general one',
     A.forForm({ coverLetter: 'general', coverLetters: { be: 'backend' } }, 'be').coverLetter === 'backend' &&
     A.forForm({ coverLetter: 'general', coverLetters: { be: 'backend' } }, 'data').coverLetter === 'general');

  // ── what is never filled ────────────────────────────────────────────────────
  w = page(`<form><label for="e">Email</label><input id="e" type="email"><label for="n">Name</label><input id="n">
    <button type="submit">Request a demo</button></form>`, 'https://www.acme.com/careers');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
  ok('a form without a place for a CV (a demo request) is not an application: untouched',
     r.found === false && w.document.getElementById('e').value === '' && w.document.getElementById('n').value === '');

  w = page(`<form><label for="e">Email</label><input id="e" type="email"><label for="p">Password</label><input id="p" type="password">
    <label for="cv">Resume</label><input id="cv" type="file"></form>`, 'https://acme.wd3.myworkdayjobs.com/en-US/careers/apply');
  r = await w.JMA_DM.apply.formFill(PROFILE, FILE, FAST);
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
  ok('city and company are never guessed', derived.city === '' && derived.company === '' && derived.firstName === 'Noa' &&
     derived.lastName === 'Levi');

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
