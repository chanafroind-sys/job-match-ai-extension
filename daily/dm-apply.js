// Daily Matches — the apply step.
//
// ==========================================================================
// HARD RULE (COMPANY_RADAR.md §7): the extension must NEVER programmatically
// click a submit button, dispatch a submit event, or call form.submit() /
// requestSubmit(). Auto-fill only: a human presses submit, every time, with no
// setting that changes this. Two corollaries: never create an ATS account or
// enter a password, and never invent answers. A field with no data the user
// gave us stays empty for them. .jma-test/test-dm-fill.js greps this folder to
// keep it that way.
// ==========================================================================
//
// One filler for every site (formFill): it reads a form the way a person
// does, by labels, names and autocomplete hints, in English and Hebrew,
// through iframes and shadow DOM, and fills only the person's own details and
// the CV file. Filled live, with test data and never submitted, on 2026-10-08:
//   Greenhouse   job-boards.greenhouse.io/embed/job_app (React; also inside
//                company sites such as wiz.io, in an iframe)
//   Lever        jobs.lever.co/…/apply (native form; its location field wants
//                a choice from its own list, so it's reported as left)
//   Ashby        jobs.ashbyhq.com/…/application, and inline on monday.com,
//                which renders the form twice (only the visible one is filled)
//   SmartRecruiters  oneclick-ui (web components with shadow roots; the
//                "apply with résumé" parser box is told apart from the CV)
//   Comeet       comeet.co/jobs/…/apply (the iframe in company sites)
//   Workable     apply.workable.com/…/apply (LinkedIn asked in a text box)
// Teamtailor's form was read but not filled. Workday asks to sign in first:
// the filler stops at any password field.
//
// Most deck jobs come from LinkedIn, where Apply either opens Easy Apply
// (LinkedIn's own form, which this never touches) or the company's site in a
// new tab. So the apply step follows the tab it opened and any tab opened
// from it, and fills the first application form that appears there. Company
// sites and Comeet's iframes are outside the manifest's hosts: one optional
// grant (https://*/*, asked for in a click) opens them all.
(function (root) {
  'use strict';

  const PROFILE_KEY = 'jma_dm_apply_profile';
  // The cards say "auto-fill" for these: the forms above.
  const AUTOFILL_ATS = ['lever', 'greenhouse', 'ashby', 'smartrecruiters', 'comeet', 'workable'];
  // Job boards keep their own apply flows (and the user's accounts): never filled.
  const BOARD_HOSTS = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com)$/i;
  const ALL_SITES = { origins: ['https://*/*'] };
  const FOLLOW_MS = 30 * 60e3; // how long an apply keeps following its tabs
  const WATCH_MS = 3 * 60e3;   // how long one page is watched for a form (Apply buttons that open one in place)
  // A form is filled only once the page has settled (settle, then the form on
  // two looks in a row, poll apart): a Greenhouse form is in the page before
  // its scripts are ready, and a CV attached then is lost ("Cannot read
  // properties of undefined (reading 'uploadFile')"). Tests shorten these.
  const timing = { settle: 2500, poll: 2000 };

  // ── the person's application details ─────────────────────────────────────────
  // Everything a form may ask that has one true answer for this person. Kept
  // only in this browser. An empty field stays empty in every form.
  const TEXT_FIELDS = ['firstName', 'lastName', 'firstNameHe', 'lastNameHe', 'email', 'phone', 'city',
    'linkedin', 'github', 'website', 'company', 'title', 'years', 'noticePeriod', 'salary', 'heardFrom'];
  const CHOICE_FIELDS = { gender: ['female', 'male', 'decline'], workAuth: ['yes', 'no'], sponsorship: ['yes', 'no'] };
  const FIELDS = TEXT_FIELDS.concat(Object.keys(CHOICE_FIELDS), ['coverLetter']);
  const LETTER_MAX = 5000;
  const HEBREW = /[֐-׿]/;

  function splitName(full) {
    const words = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return [words[0] || '', ''];
    return [words.slice(0, -1).join(' '), words[words.length - 1]];
  }

  function deriveProfile(text) {
    const t = text || '';
    const email = (t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0];
    const phone = (t.match(/(?:\+972[\s-]?|\b0)5\d[\s-]?\d{3}[\s-]?\d{4}\b/) ||
                   t.match(/\+\d{1,3}[\s-]?\d[\d\s-]{7,12}\d/) || [''])[0];
    const link = (re) => {
      let u = (t.match(re) || [''])[0];
      if (u && !/^https?:/i.test(u)) u = 'https://' + u;
      return u;
    };
    const linkedin = link(/(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/in\/[\w%-]+\/?/i);
    const github = link(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+\/?/i);
    const fullName = t.split('\n').map(s => s.trim()).find(s => {
      const words = s.split(/\s+/);
      return s && s.length <= 40 && words.length >= 2 && words.length <= 4 && !/[@\d|:•/,]/.test(s);
    }) || '';
    const [first, last] = splitName(fullName);
    const he = HEBREW.test(fullName);
    return { fullName, firstName: he ? '' : first, lastName: he ? '' : last, firstNameHe: he ? first : '',
      lastNameHe: he ? last : '', email, phone, city: '', linkedin, github, website: '', company: '', title: '' };
  }

  // Details saved before first and last names were separate fields keep working.
  function upgrade(stored) {
    const p = { ...stored };
    if (!p.firstName && !p.lastName && !p.firstNameHe && p.fullName) {
      const [first, last] = splitName(p.fullName);
      if (HEBREW.test(p.fullName)) { p.firstNameHe = first; p.lastNameHe = last; } else { p.firstName = first; p.lastName = last; }
    }
    if (!p.city && p.location) p.city = p.location;
    delete p.fullName;
    delete p.location;
    p.coverLetters = p.coverLetters && typeof p.coverLetters === 'object' ? p.coverLetters : {};
    return p;
  }

  async function getProfile() {
    const stored = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY];
    return stored ? { ...upgrade(stored), confirmed: true } : null;
  }

  async function suggestProfile() {
    const versions = await root.JMA_DM.cvLibrary.list();
    const main = versions.find(v => !v.needsExtraction) || { text: '' };
    return { ...upgrade(deriveProfile(main.text)), confirmed: false };
  }

  async function saveProfile(profile) {
    const clean = {};
    for (const f of TEXT_FIELDS) clean[f] = String(profile[f] || '').trim().slice(0, 200);
    for (const [f, allowed] of Object.entries(CHOICE_FIELDS)) clean[f] = allowed.includes(profile[f]) ? profile[f] : '';
    clean.coverLetter = String(profile.coverLetter || '').trim().slice(0, LETTER_MAX);
    clean.coverLetters = {};
    for (const [cvId, text] of Object.entries(profile.coverLetters || {})) {
      const letter = String(text || '').trim().slice(0, LETTER_MAX);
      if (letter) clean.coverLetters[String(cvId).slice(0, 80)] = letter;
    }
    await chrome.storage.local.set({ [PROFILE_KEY]: clean });
    return clean;
  }

  // How many of the details are filled in, for the page's progress line.
  function completeness(profile) {
    const p = profile || {};
    const keys = TEXT_FIELDS.filter(f => !['firstNameHe', 'lastNameHe', 'salary'].includes(f))
      .concat(Object.keys(CHOICE_FIELDS), ['coverLetter']);
    return { done: keys.filter(k => String(p[k] || '').trim()).length, total: keys.length };
  }

  // What the filler gets for one application: the details, with the cover
  // letter written for the CV version being sent (or the general one).
  function forForm(profile, cvId) {
    const p = upgrade(profile || {});
    return { ...p, coverLetter: (cvId && p.coverLetters[cvId]) || p.coverLetter || '', coverLetters: undefined };
  }

  // Runs inside the page (each frame) through chrome.scripting.executeScript,
  // so it must be self-contained. Fill-only: it sets values, picks the
  // person's own answers in lists and option buttons, attaches the CV (and a
  // cover letter), and reports what stuck. It never touches the form's
  // submission and never clicks anything.

  async function formFill(profile, file, opts) {
    opts = opts || {};
    const wait = { stick: 700, confirm: 1500, retry: 2000, ...(opts.timing || {}) };
    const out = { found: false, filled: [], left: [], attached: false, fileName: file ? file.name : '', blocked: '',
      questions: 0, letter: '' };
    const p = profile || {};
    const str = (v) => String(v || '').trim();
    const first = str(p.firstName), last = str(p.lastName);
    const firstHe = str(p.firstNameHe), lastHe = str(p.lastNameHe);
    // A Hebrew form gets the Hebrew name when there is one.
    const VALUE = (key, hebrewForm) => {
      const f = hebrewForm && firstHe ? firstHe : first || firstHe;
      const l = hebrewForm && lastHe ? lastHe : last || lastHe;
      return {
        firstName: f, lastName: l, fullName: [f, l].filter(Boolean).join(' '), email: str(p.email), phone: str(p.phone),
        linkedin: str(p.linkedin), github: str(p.github), website: str(p.website), location: str(p.city),
        company: str(p.company), title: str(p.title), years: str(p.years), notice: str(p.noticePeriod),
        salary: str(p.salary), heardFrom: str(p.heardFrom), coverLetter: str(p.coverLetter),
      }[key] || '';
    };
    const LABEL = { firstName: 'שם פרטי', lastName: 'שם משפחה', fullName: 'שם מלא', email: 'אימייל', phone: 'טלפון',
      linkedin: 'LinkedIn', github: 'GitHub', website: 'אתר', location: 'עיר', company: 'חברה נוכחית',
      title: 'תפקיד נוכחי', years: 'שנות ניסיון', notice: 'זמינות', salary: 'ציפיות שכר', heardFrom: 'איך שמעת',
      coverLetter: 'מכתב מקדים', gender: 'מגדר', workAuth: 'אישור עבודה', sponsorship: 'אשרה' };
    // Links first, then questions with their own wording, then the person's
    // identity, which a referrer's or a manager's name must never be mistaken for.
    const LINKS = [
      ['linkedin', /linkedin/i, /linked\s*in|לינקד/i],
      ['github', /github/i, /git\s*hub/i],
      ['website', /website|portfolio|personal.?site/i, /^(personal\s*)?(website|portfolio|site)(\s*(url|link))?$|^אתר(\s*אישי)?$|^תיק\s*עבודות$/i],
    ];
    const HEARD = /how did you hear|where did you (hear|find)|איך שמעת|היכן שמעת|איך הגעת/i;
    const ASKED = [
      ['years', /^(total\s*)?(years|yrs)\.?\s*of\s*(professional\s*|work\s*|relevant\s*)?experience\??$|^(מספר\s*)?שנות\s*ניסיון\??$/i],
      ['notice', /notice period|when (can|could) you start|earliest (possible )?start|availability to start|הודעה מוקדמת|מתי (תוכל|תוכלי|אפשר) להתחיל|זמינות להתחלה/i],
      ['salary', /salary expectation|expected salary|desired salary|ציפיות\s*שכר|שכר\s*מבוקש/i],
      ['heardFrom', HEARD],
      ['title', /^current\s*(job\s*)?(title|role|position)$|^תפקיד\s*נוכחי$/i],
    ];
    const IDENTITY = [
      ['email', /^email$/i, /e-?mail/i, /e-?mail|דוא["״']?ל|מייל/i],
      ['phone', /^tel(-national)?$/i, /phone|mobile|^tel$|cell/i, /phone|mobile|cell|טלפון|נייד|פלאפון/i],
      ['firstName', /^given-name$/i, /first.?name|fname|given.?name/i, /first\s*name|given\s*name|שם\s*פרטי/i],
      ['lastName', /^family-name$/i, /last.?name|lname|family.?name|surname/i, /last\s*name|family\s*name|surname|שם\s*(ה)?משפחה/i],
      ['fullName', /^name$/i, /^(name|full.?name|your.?name|candidate.?name|applicant.?name|_systemfield_name)$/i,
        /^(full\s*)?name$|^your\s*name$|^שם(\s*מלא)?$/i],
      ['location', /^address-level2$/i, /^(location|city|current.?location|candidate.?location)$/i,
        /^(current\s*)?(location|city)$|^עיר(\s*מגורים)?$|^מקום\s*מגורים$|^מיקום$/i],
      ['company', /^organization$/i, /^(org|company|current.?company|current.?employer)$/i,
        /^current\s*(company|employer)$|^company$|^חברה\s*נוכחית$|^מקום\s*עבודה\s*נוכחי$/i],
    ];
    const NOT = /refer|recruit|hear about|how did you|source|reference|emergency|manager|school|university|college|salary|compensation|notice|preferred|pronoun|github|twitter|facebook|instagram|ממליץ|הפני|שכר/i;
    // Text boxes are the company's questions, except these two.
    const LINKEDIN_BOX = /^(your\s*)?linked\s*in(\s*(profile|url|profile url|link))?$|^(פרופיל\s*)?לינקד(אי|י)ן$/i;
    const GITHUB_BOX = /^(your\s*)?git\s*hub(\s*(profile|url|link))?$/i;
    const LETTER_BOX = /cover\s*letter|motivation\s*letter|letter of motivation|מכתב\s*(מקדים|פנייה|מוטיבציה)/i;
    // Questions with a list of answers, and how the person's answer reads there.
    const CHOICES = {
      gender: { q: /^(gender|sex)\b|gender identity|^מגדר|^מין\b/i,
        a: { female: /^(female|woman|אישה|נקבה)\b/i, male: /^(male|man|גבר|זכר)\b/i,
          decline: /decline|prefer not|don.?t wish|not to (say|answer|disclose)|לא מעוניינ|מעדיפ/i } },
      workAuth: { q: /authori[sz]ed to work|eligible to work|legally (able|permitted|entitled) to work|right to work|work permit|רשאי.{0,15}לעבוד|מורשה.{0,15}לעבוד|זכאי.{0,15}לעבוד|היתר עבודה/i,
        a: { yes: /^(yes|כן)\b/i, no: /^(no|לא)\b/i } },
      sponsorship: { q: /sponsor|\bvisa\b|ויזה|אשרת עבודה/i, a: { yes: /^(yes|כן)\b/i, no: /^(no|לא)\b/i } },
    };
    const HEBREW_RE = /[֐-׿]/;
    const TEXTY = ['text', 'email', 'tel', 'url', 'search'];
    const textOf = (n) => (n ? (n.innerText || n.textContent || '') : '').replace(/\s+/g, ' ').trim();
    const clean = (t) => t.replace(/\(required\)|required|[*✱:]|\u200f|\u200e/gi, ' ').replace(/\s+/g, ' ').trim();
    const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
    const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    const pause = (ms) => new Promise(r => setTimeout(r, ms));

    // Every element matching sel, inside open shadow roots too (SmartRecruiters).
    function deep(sel) {
      const found = [];
      const walk = (root) => {
        root.querySelectorAll(sel).forEach(e => found.push(e));
        root.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); });
      };
      walk(document);
      return found;
    }
    const deepText = () => [textOf(document.body)].concat(deep('*').filter(e => e.shadowRoot).map(e => e.shadowRoot.textContent || '')).join(' ');

    function labelOf(el) {
      const root = el.getRootNode && el.getRootNode();
      const scope = root && root.querySelector ? root : document;
      const parts = [];
      if (el.id) {
        const l = scope.querySelector(`label[for="${esc(el.id)}"]`);
        if (l) parts.push(textOf(l));
      }
      const wrap = el.closest('label');
      if (wrap) parts.push(textOf(wrap));
      const by = el.getAttribute('aria-labelledby');
      if (by) by.split(/\s+/).forEach(id => { const n = (scope.getElementById ? scope : document).getElementById(id); if (n) parts.push(textOf(n)); });
      if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
      if (!parts.length) { // a wrapper around this field alone: its label-like text
        let n = el.parentElement;
        for (let i = 0; n && i < 4; i++, n = n.parentElement) {
          if (n.querySelectorAll('input:not([type="hidden"]), textarea, select').length > 1) break;
          const l = n.querySelector('label, legend, [class*="label" i], [class*="title" i]');
          if (l && !l.contains(el)) { parts.push(textOf(l)); break; }
        }
      }
      if (!parts.length && el.placeholder) parts.push(el.placeholder);
      return clean([...new Set(parts.map(clean))].join(' ')).slice(0, 160);
    }
    // The field, then each wrapper around it, nearest first: tags, classes,
    // short texts (a file input's own label is often just "Choose a file").
    function contextLevels(el) {
      const levels = [`${labelOf(el)} ${el.name || ''} ${el.id || ''}`];
      let n = el;
      for (let i = 0; i < 5 && (n = up(n)); i++) {
        const t = textOf(n);
        levels.push(`${n.tagName.toLowerCase()} ${n.id || ''} ${typeof n.className === 'string' ? n.className : ''} ${t.length < 60 ? t : ''}`);
      }
      return levels;
    }
    const contextOf = (el) => contextLevels(el).join(' ');
    // A list's or a group's question: the nearest text around it that says
    // more than its own options.
    function questionOf(el, optionTexts) {
      const strip = (t) => optionTexts.reduce((s, o) => (o ? s.split(o).join(' ') : s), t).replace(/\s+/g, ' ').trim();
      const own = strip(labelOf(el));
      if (own.length >= 3) return own;
      let n = el;
      for (let i = 0; i < 6 && (n = up(n)); i++) {
        const t = strip(textOf(n));
        if (t.length >= 8) return t.slice(0, 200);
      }
      return '';
    }
    function choiceKey(question) {
      const keys = Object.keys(CHOICES).filter(k => CHOICES[k].q.test(question));
      if (keys.includes('workAuth') && keys.includes('sponsorship')) return null; // "authorized without sponsorship?": not ours to read
      if (/pronoun|preferred/i.test(question)) return null;
      return keys[0] || null;
    }

    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const typeOf = (el) => (el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || 'text').toLowerCase());
    const usable = (el) => (typeOf(el) === 'textarea' || TEXTY.includes(typeOf(el)) || typeOf(el) === 'number') &&
      !el.disabled && !el.readOnly && el.getAttribute('role') !== 'combobox' && el.getAttribute('aria-autocomplete') !== 'list' &&
      visible(el);
    function keyOf(el) {
      const label = labelOf(el);
      const name = `${el.name || ''} ${el.id || ''}`;
      if (typeOf(el) === 'textarea') {
        return LINKEDIN_BOX.test(label) ? 'linkedin' : GITHUB_BOX.test(label) ? 'github' : LETTER_BOX.test(label) ? 'coverLetter' : null;
      }
      for (const [key, attrRe, labelRe] of LINKS) if (labelRe.test(label) || (!label && attrRe.test(name)) || attrRe.test(el.name || '')) return key;
      for (const [key, labelRe] of ASKED) if (labelRe.test(label)) return key;
      if (typeOf(el) === 'number') return null; // numbers are only ever years of experience
      if (NOT.test(label) || NOT.test(name)) return null;
      const ac = (el.getAttribute('autocomplete') || '').trim();
      for (const [key, acRe, attrRe, labelRe] of IDENTITY) {
        if (acRe.test(ac) || labelRe.test(label) || attrRe.test(el.name || '') || attrRe.test(el.id || '')) return key;
      }
      if (typeOf(el) === 'email') return 'email';
      if (typeOf(el) === 'tel') return 'phone';
      return null;
    }

    // Never on a sign-in or sign-up page: no passwords, no accounts.
    if (deep('input[type="password"]').some(visible)) { out.blocked = 'password'; return out; }

    const fields = deep('input, textarea').filter(usable).map(el => ({ el, key: keyOf(el), hebrew: HEBREW_RE.test(labelOf(el)) }))
      .filter(f => f.key);
    const emailField = fields.find(f => f.key === 'email');
    // File inputs are usually hidden behind a styled button: one of the first
    // few ancestors must show. A cover letter, photo or "fill from résumé"
    // parser is never the CV.
    const shown = (el) => { let n = el; for (let i = 0; n && i < 4; i++, n = up(n)) if (visible(n)) return true; return false; };
    // The nearest level that says anything decides, so a short form's
    // "Cover Letter" never spoils the CV box next to it.
    const CV_WORDS = /resume|r[eé]sum[eé]|\bcv\b|curriculum|קורות|קו["״]?ח/i;
    const NOT_CV = /cover|letter|מכתב|photo|image|avatar|picture|תמונה|portfolio/i;
    const PARSER = /autofill|autocomplete|apply.?with|parse/i; // "fill the form from your résumé" boxes
    const fileScore = (f) => {
      for (const level of contextLevels(f)) {
        if (PARSER.test(level)) return -3;
        const cv = CV_WORDS.test(level), other = NOT_CV.test(level);
        if (cv && !other) return 2;
        if (other && !cv) return -3;
        if (cv && other) return 0; // a wrapper around both: no telling from here up
      }
      return 0;
    };
    let files = deep('input[type="file"]').filter(f => !f.disabled && shown(f));
    const form = emailField && emailField.el.closest('form');
    if (form && files.some(f => form.contains(f))) files = files.filter(f => form.contains(f));
    let resume = files.filter(f => fileScore(f) > 0).sort((a, b) => fileScore(b) - fileScore(a))[0] || null;
    if (!resume && files.length === 1 && fileScore(files[0]) === 0) resume = files[0];
    // The cover letter's box: the nearest words around it name a letter.
    const nearest = (f) => contextLevels(f).find(l => CV_WORDS.test(l) || NOT_CV.test(l)) || '';
    const letterFile = files.find(f => f !== resume && /cover|letter|מכתב/i.test(nearest(f)) && !CV_WORDS.test(nearest(f))) || null;

    // An application form: an email field and a place for the CV. Anything
    // else (a newsletter box, a demo request) is left alone.
    out.found = !!emailField && !!resume;
    if (opts.dry) out.plan = fields.map(f => `${f.key} <- ${labelOf(f.el) || f.el.name || f.el.id}`).concat(resume ? [`resume <- ${contextOf(resume).slice(0, 60)}`] : []);
    if (!out.found || opts.dry) return out;

    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    // React and friends remember the last value they rendered and ignore an
    // input event that matches it; the prototype's setter goes around that.
    const setValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      fire(el, 'input');
      fire(el, 'change');
      el.dispatchEvent(new FocusEvent('blur'));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true })); // validation on leaving a field
    };
    const add = (list, label) => { if (!list.includes(label)) list.push(label); };
    const typed = [];
    for (const f of fields) {
      if (f.el.value && f.el.value.trim()) { add(out.filled, LABEL[f.key]); continue; } // never overwrite the user
      const value = VALUE(f.key, f.hebrew);
      if (!value) {
        if (!['github', 'website', 'title', 'years', 'notice', 'salary', 'heardFrom', 'coverLetter'].includes(f.key)) add(out.left, LABEL[f.key]);
        continue;
      }
      setValue(f.el, value);
      typed.push(f);
    }

    // Lists and option buttons: only the person's own saved answer, and only
    // when exactly one option says it. Anything else stays for the human.
    const choicesTyped = [];
    const optionText = (o) => clean(textOf(o) || o.value || '');
    for (const sel of deep('select').filter(s => !s.disabled && visible(s))) {
      const texts = [...sel.options].map(optionText);
      const question = questionOf(sel, texts);
      let key = choiceKey(question);
      let pattern = key && p[key] && CHOICES[key].a[p[key]];
      if (!key && HEARD.test(question) && str(p.heardFrom)) { // "how did you hear about us": the person's own wording
        key = 'heardFrom';
        pattern = new RegExp(str(p.heardFrom).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
      if (!key || !pattern) continue;
      const current = sel.selectedOptions && sel.selectedOptions[0];
      if (sel.selectedIndex > 0 && current && !/^(select|choose|בחר|-+)/i.test(optionText(current))) { add(out.filled, LABEL[key]); continue; }
      const matches = [...sel.options].filter(o => !o.disabled && pattern.test(optionText(o)));
      if (matches.length !== 1) continue;
      setValue(sel, matches[0].value);
      choicesTyped.push({ check: () => sel.value === matches[0].value, key });
    }
    const groups = new Map();
    for (const r of deep('input[type="radio"]').filter(r => !r.disabled && shown(r))) {
      const k = `${r.name}|${r.form ? 'f' : ''}`;
      if (!r.name) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const radioLabel = (r) => clean(labelOf(r) || textOf(r.parentElement));
    for (const radios of groups.values()) {
      if (radios.some(r => r.checked)) continue; // the user's own answer
      let box = radios[0];
      while (box && !radios.every(r => box.contains(r))) box = up(box);
      const texts = radios.map(radioLabel);
      const question = box ? questionOf(box, texts) : '';
      const key = choiceKey(question);
      const pattern = key && p[key] && CHOICES[key].a[p[key]];
      if (!pattern) continue;
      const matches = radios.filter(r => pattern.test(radioLabel(r)));
      if (matches.length !== 1) continue;
      const pick = matches[0];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set.call(pick, true);
      fire(pick, 'input');
      fire(pick, 'change');
      choicesTyped.push({ check: () => pick.checked, key });
    }

    // Attaches a file and makes sure the page took it: shown by name, or kept
    // by a plain form that sends its files itself (Lever). A page that wasn't
    // ready gets one more try; one that still doesn't take it is reported,
    // never claimed.
    async function attach(input, fileData) {
      const native = !!(input.form && /multipart/i.test(input.form.getAttribute('enctype') || input.form.enctype || '') && input.name);
      const put = () => {
        const bin = atob(fileData.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], fileData.name, { type: fileData.type || 'application/octet-stream' }));
        input.files = dt.files;
        // Lever's native form sends the file as is; its change handler only
        // starts an optional résumé parse. Elsewhere the change event is how
        // the page learns about the file.
        if (!/(^|\.)lever\.co$/.test(location.hostname)) { fire(input, 'input'); fire(input, 'change'); }
      };
      const taken = () => deepText().includes(fileData.name) || (native && input.files && input.files.length === 1);
      if (input.files && input.files.length && deepText().includes(input.files[0].name)) return input.files[0].name; // already there
      put();
      await pause(wait.confirm);
      if (!taken()) {
        await pause(wait.retry);
        try { input.value = ''; } catch (_) { /* some inputs refuse */ }
        put();
        await pause(wait.confirm);
      }
      if (!taken()) return '';
      if (!deepText().includes(fileData.name) && !document.getElementById('jma-dm-attached-note')) {
        const note = document.createElement('div');
        note.id = 'jma-dm-attached-note';
        note.dir = 'rtl';
        note.textContent = '✓ ' + fileData.name + ' צורף על ידי Job Match AI';
        note.style.cssText = 'margin:6px 0;padding:6px 10px;border-radius:8px;background:#F0FDF4;' +
          'border:1px solid #BBF7D0;color:#15803D;font:500 13px/1.4 Rubik,Arial,sans-serif;';
        let at = input;
        while (up(at) && !visible(at)) at = up(at);
        at.insertAdjacentElement('afterend', note);
      }
      return fileData.name;
    }

    if (file && file.b64 && typeof DataTransfer === 'function') {
      const name = await attach(resume, file);
      out.attached = !!name;
      if (name) out.fileName = name;
    }
    // A cover letter: in its text box (filled above), or as a text file where
    // the form wants a file and accepts plain text.
    const letter = VALUE('coverLetter');
    if (typed.some(f => f.key === 'coverLetter')) out.letter = 'typed';
    else if (letter && letterFile && typeof DataTransfer === 'function' && !(letterFile.files && letterFile.files.length) &&
             (!letterFile.accept || /txt|text\/plain/i.test(letterFile.accept))) {
      const who = [first, last].filter(Boolean).join(' ').replace(/\s+/g, '_') || 'Cover';
      let bin = '';
      for (const b of new TextEncoder().encode(letter)) bin += String.fromCharCode(b);
      const b64 = btoa(bin);
      out.letter = (await attach(letterFile, { name: `${who}_Cover_Letter.txt`, type: 'text/plain', b64 })) ? 'attached' : 'failed';
    }

    // Report what stuck, not what was typed: a field that wants a choice from
    // its own list (Lever's location) clears itself.
    await pause(wait.stick);
    for (const f of typed) add(f.el.isConnected && String(f.el.value || '').trim() ? out.filled : out.left, LABEL[f.key]);
    for (const c of choicesTyped) add(c.check() ? out.filled : out.left, LABEL[c.key]);
    out.left = out.left.filter(l => !out.filled.includes(l));
    if (!out.attached) out.left.push('קורות חיים');
    // The company's own questions are the human's.
    const SKIP = ['hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'image', 'reset'];
    out.questions = deep('input, textarea, select').filter(el => (el.required || el.getAttribute('aria-required') === 'true') &&
      !SKIP.includes(typeOf(el)) && visible(el) && !String(el.value || '').trim()).length;
    // Point the human at the button they press. Styling only.
    const submit = (form || document).querySelector('button[type="submit"], input[type="submit"]') ||
      deep('button').find(b => /^(submit|submit application|apply|apply now|send application|שליחה|שלח|הגשה|הגש|הגשת מועמדות|שליחת מועמדות)$/i.test(textOf(b)));
    if (submit) {
      submit.style.outline = '3px solid #F59E0B';
      submit.style.outlineOffset = '3px';
    }
    return out;
  }

  // ── access to company sites ─────────────────────────────────────────────────
  async function hasAccess(url) {
    try {
      return await chrome.permissions.contains({ origins: [new URL(url).origin + '/*'] });
    } catch (_) {
      return false;
    }
  }

  async function hasAllSites() {
    try {
      return await chrome.permissions.contains(ALL_SITES);
    } catch (_) {
      return false;
    }
  }

  // Must be called inside the click, before any other await: Chrome only
  // shows the prompt for a user gesture.
  function requestAccess() {
    try {
      return chrome.permissions.request(ALL_SITES).catch(() => false);
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  // ── following an apply ──────────────────────────────────────────────────────
  const _pause = (ms) => new Promise(r => setTimeout(r, ms));
  let watcher = null;

  function stopFollowing() {
    if (watcher) watcher.stop();
    watcher = null;
  }

  // Looks for an application form in every frame of the tab until one shows up
  // (an Apply button may open it in place, with no navigation), then fills it
  // in that frame only. Stops when the page changes (gen) or the apply ends.
  async function watchPage(w, tabId, gen) {
    const live = () => watcher === w && w.gens.get(tabId) === gen;
    const deadline = Date.now() + WATCH_MS;
    let seen = false; // the form must be there on two looks in a row
    await _pause(timing.settle);
    while (live() && Date.now() < deadline) {
      let found;
      try {
        found = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: formFill,
          args: [w.profile, null, { dry: true }] });
      } catch (_) {
        return { error: 'no_access' }; // a page the extension may not touch (or one that just closed)
      }
      const hit = (found || []).find(r => r && r.result && (r.result.found || r.result.blocked));
      if (hit && hit.result.blocked) return hit.result;
      if (hit && !seen) {
        seen = true;
      } else if (hit && live()) {
        const [done] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [hit.frameId] }, func: formFill,
          args: [w.profile, w.file, {}] });
        return (done && done.result) || { found: false };
      } else {
        seen = false;
      }
      await _pause(timing.poll);
    }
    return null; // no form while we looked, or the user moved on
  }

  async function onPage(w, tabId, url) {
    if (!/^https:\/\//i.test(url || '')) return;
    let host;
    try { host = new URL(url).hostname; } catch (_) { return; }
    const gen = (w.gens.get(tabId) || 0) + 1;
    w.gens.set(tabId, gen);
    if (BOARD_HOSTS.test(host)) return w.report({ kind: 'board', tabId, host });
    if (!(await hasAccess(url))) return w.report({ kind: 'no_access', tabId, host });
    w.report({ kind: 'watching', tabId, host });
    const result = await watchPage(w, tabId, gen);
    if (!result || watcher !== w) return undefined;
    if (result.error) return w.report({ kind: 'no_access', tabId, host });
    return w.report({ kind: result.blocked ? 'blocked' : result.found ? 'filled' : 'no_form', tabId, host, result });
  }

  // The tab Apply opened, and every tab opened from those (LinkedIn's Apply
  // opens the company's site in a new tab), for FOLLOW_MS.
  function follow(rootTabId, profile, file, report) {
    stopFollowing();
    const tabs = new Set([rootTabId]);
    const w = { profile, file, report, tabs, gens: new Map(), lastTab: rootTabId };
    const onCreated = (tab) => { if (tabs.has(tab.openerTabId)) tabs.add(tab.id); };
    const onUpdated = (tabId, info, tab) => {
      if (!tabs.has(tabId) || info.status !== 'complete') return;
      w.lastTab = tabId;
      onPage(w, tabId, (tab && tab.url) || '');
    };
    const onRemoved = (tabId) => { tabs.delete(tabId); };
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const timer = setTimeout(stopFollowing, FOLLOW_MS);
    w.stop = () => {
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    };
    watcher = w;
    // The first page may have finished loading before the listener was added.
    chrome.tabs.get(rootTabId).then(t => { if (t && t.status === 'complete' && watcher === w) onPage(w, rootTabId, t.url); })
      .catch(() => {});
    return w;
  }

  // Opens the job's application page next to the side panel and follows it.
  // Without a confirmed profile there is nothing to fill with, so it only opens.
  async function open(card, cvId, report) {
    const job = card.job || {};
    const tab = await chrome.tabs.create({ url: job.apply_url || job.url, active: true });
    const profile = await getProfile();
    if (!profile) {
      stopFollowing();
      return { mode: 'manual', tabId: tab.id, reason: 'no_profile' };
    }
    const file = await root.JMA_DM.cvLibrary.getFile(cvId);
    follow(tab.id, forForm(profile, cvId), file, report || (() => {}));
    return { mode: job.ats === 'workday' ? 'signin' : 'following', tabId: tab.id };
  }

  // "Fill the form that's open now": the active tab of this window, or the
  // tab the apply last moved to when the deck itself is the active tab.
  async function fillOpenForm(report) {
    const w = watcher;
    if (!w) return { kind: 'no_watch' };
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:/i.test(tab.url || '')) tab = await chrome.tabs.get(w.lastTab).catch(() => null);
    if (!tab) return { kind: 'no_form' };
    w.tabs.add(tab.id);
    w.lastTab = tab.id;
    if (report) w.report = report;
    await onPage(w, tab.id, tab.url || '');
    return { kind: 'done' };
  }

  const canAutofill = (ats) => AUTOFILL_ATS.includes(ats);

  async function downloadCv(cvId) {
    const file = await root.JMA_DM.cvLibrary.getFile(cvId);
    if (!file) return false;
    const bin = atob(file.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: file.type }));
    try {
      await chrome.downloads.download({ url, filename: file.name, saveAs: false });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    return true;
  }

  root.JMA_DM = root.JMA_DM || {};
  root.JMA_DM.apply = { FIELDS, TEXT_FIELDS, CHOICE_FIELDS, AUTOFILL_ATS, canAutofill, deriveProfile, getProfile,
    suggestProfile, saveProfile, completeness, forForm, formFill, open, follow, stopFollowing, fillOpenForm, hasAccess,
    hasAllSites, requestAccess, downloadCv, timing };
})(typeof globalThis !== 'undefined' ? globalThis : self);
