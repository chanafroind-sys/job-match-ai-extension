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
  const FIELDS = ['fullName', 'email', 'phone', 'location', 'linkedin', 'company'];
  // The cards say "auto-fill" for these: the forms above.
  const AUTOFILL_ATS = ['lever', 'greenhouse', 'ashby', 'smartrecruiters', 'comeet', 'workable'];
  // Job boards keep their own apply flows (and the user's accounts): never filled.
  const BOARD_HOSTS = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com)$/i;
  const ALL_SITES = { origins: ['https://*/*'] };
  const FOLLOW_MS = 30 * 60e3; // how long an apply keeps following its tabs
  const WATCH_MS = 3 * 60e3;   // how long one page is watched for a form (Apply buttons that open one in place)
  const POLL_MS = 2000;

  function deriveProfile(text) {
    const t = text || '';
    const email = (t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0];
    const phone = (t.match(/(?:\+972[\s-]?|\b0)5\d[\s-]?\d{3}[\s-]?\d{4}\b/) ||
                   t.match(/\+\d{1,3}[\s-]?\d[\d\s-]{7,12}\d/) || [''])[0];
    let linkedin = (t.match(/(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/in\/[\w%-]+\/?/i) || [''])[0];
    if (linkedin && !/^https?:/i.test(linkedin)) linkedin = 'https://' + linkedin;
    const fullName = t.split('\n').map(s => s.trim()).find(s => {
      const words = s.split(/\s+/);
      return s && s.length <= 40 && words.length >= 2 && words.length <= 4 && !/[@\d|:•/,]/.test(s);
    }) || '';
    return { fullName, email, phone, location: '', linkedin, company: '' };
  }

  async function getProfile() {
    const stored = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY];
    return stored ? { ...stored, confirmed: true } : null;
  }

  async function suggestProfile() {
    const versions = await root.JMA_DM.cvLibrary.list();
    const main = versions.find(v => !v.needsExtraction) || { text: '' };
    return { ...deriveProfile(main.text), confirmed: false };
  }

  async function saveProfile(profile) {
    const clean = {};
    for (const f of FIELDS) clean[f] = String(profile[f] || '').trim().slice(0, 200);
    await chrome.storage.local.set({ [PROFILE_KEY]: clean });
    return clean;
  }

  // Runs inside the page (each frame) through chrome.scripting.executeScript,
  // so it must be self-contained. Fill-only: it sets values, attaches the CV,
  // and reports what stuck. It never touches the form's submission.
  async function formFill(profile, file, opts) {
    opts = opts || {};
    const out = { found: false, filled: [], left: [], attached: false, fileName: file ? file.name : '', blocked: '', questions: 0 };
    const words = String(profile.fullName || '').trim().split(/\s+/).filter(Boolean);
    const VALUE = {
      firstName: words.length > 1 ? words.slice(0, -1).join(' ') : (words[0] || ''),
      lastName: words.length > 1 ? words[words.length - 1] : '',
      fullName: words.join(' '),
      email: String(profile.email || '').trim(),
      phone: String(profile.phone || '').trim(),
      linkedin: String(profile.linkedin || '').trim(),
      location: String(profile.location || '').trim(),
      company: String(profile.company || '').trim(),
    };
    const LABEL = { firstName: 'שם פרטי', lastName: 'שם משפחה', fullName: 'שם מלא', email: 'אימייל', phone: 'טלפון',
      linkedin: 'LinkedIn', location: 'מיקום', company: 'חברה נוכחית' };
    // [field, autocomplete, name/id, label]. The loose ones are anchored, so
    // "Name of your current company" is never read as a name.
    const RULES = [
      ['linkedin', null, /linkedin/i, /linked\s*in|לינקד/i],
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
    // Fields that only look like ours: someone else's name, email or company.
    const NOT = /refer|recruit|hear about|how did you|source|reference|emergency|manager|school|university|college|salary|compensation|notice|preferred|pronoun|github|twitter|facebook|instagram|ממליץ|הפני|שכר/i;
    // A text box that asks only for the LinkedIn URL (Workable's custom question).
    const LINKEDIN_BOX = /^(your\s*)?linked\s*in(\s*(profile|url|profile url|link))?$|^(פרופיל\s*)?לינקד(אי|י)ן$/i;
    const TEXTY = ['text', 'email', 'tel', 'url', 'search'];
    const textOf = (n) => (n ? (n.innerText || n.textContent || '') : '').replace(/\s+/g, ' ').trim();
    const clean = (t) => t.replace(/\(required\)|required|[*✱:]|\u200f|\u200e/gi, ' ').replace(/\s+/g, ' ').trim();
    const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
    const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;

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
        let p = el.parentElement;
        for (let i = 0; p && i < 4; i++, p = p.parentElement) {
          if (p.querySelectorAll('input:not([type="hidden"]), textarea, select').length > 1) break;
          const l = p.querySelector('label, legend, [class*="label" i], [class*="title" i]');
          if (l && !l.contains(el)) { parts.push(textOf(l)); break; }
        }
      }
      if (!parts.length && el.placeholder) parts.push(el.placeholder);
      return clean([...new Set(parts.map(clean))].join(' ')).slice(0, 160);
    }
    // The field plus what surrounds it: tags, classes, short texts (a file
    // input's own label is often just "Choose a file").
    function contextOf(el) {
      const bits = [labelOf(el), el.name || '', el.id || ''];
      let n = el;
      for (let i = 0; i < 5 && (n = up(n)); i++) {
        bits.push(n.tagName.toLowerCase(), n.id || '', typeof n.className === 'string' ? n.className : '');
        const t = textOf(n);
        if (t && t.length < 60) bits.push(t);
      }
      return bits.join(' ');
    }

    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const typeOf = (el) => (el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || 'text').toLowerCase());
    const usable = (el) => (typeOf(el) === 'textarea' || TEXTY.includes(typeOf(el))) && !el.disabled && !el.readOnly &&
      el.getAttribute('role') !== 'combobox' && el.getAttribute('aria-autocomplete') !== 'list' && visible(el);
    function keyOf(el) {
      const ac = (el.getAttribute('autocomplete') || '').trim();
      const label = labelOf(el);
      if (typeOf(el) === 'textarea') return LINKEDIN_BOX.test(label) ? 'linkedin' : null; // other text boxes are questions
      if (NOT.test(label) || NOT.test(`${el.name || ''} ${el.id || ''}`)) return null;
      for (const [key, acRe, attrRe, labelRe] of RULES) {
        if ((acRe && acRe.test(ac)) || labelRe.test(label) || attrRe.test(el.name || '') || attrRe.test(el.id || '')) return key;
      }
      if (typeOf(el) === 'email') return 'email';
      if (typeOf(el) === 'tel') return 'phone';
      return null;
    }

    // Never on a sign-in or sign-up page: no passwords, no accounts.
    if (deep('input[type="password"]').some(visible)) { out.blocked = 'password'; return out; }

    const fields = deep('input, textarea').filter(usable).map(el => ({ el, key: keyOf(el) })).filter(f => f.key);
    const emailField = fields.find(f => f.key === 'email');
    // File inputs are usually hidden behind a styled button: one of the first
    // few ancestors must show. A cover letter, photo or "fill from résumé"
    // parser is never the CV.
    const shown = (el) => { let n = el; for (let i = 0; n && i < 4; i++, n = up(n)) if (visible(n)) return true; return false; };
    const fileScore = (f) => {
      const ctx = contextOf(f);
      let score = /resume|r[eé]sum[eé]|\bcv\b|curriculum|קורות|קו["״]?ח/i.test(ctx) ? 2 : 0;
      if (/cover|letter|מכתב|photo|image|avatar|picture|תמונה|portfolio|autofill|autocomplete|apply.?with|parse/i.test(ctx)) score -= 3;
      return score;
    };
    let files = deep('input[type="file"]').filter(f => !f.disabled && shown(f));
    const form = emailField && emailField.el.closest('form');
    if (form && files.some(f => form.contains(f))) files = files.filter(f => form.contains(f));
    let resume = files.filter(f => fileScore(f) > 0).sort((a, b) => fileScore(b) - fileScore(a))[0] || null;
    if (!resume && files.length === 1 && fileScore(files[0]) === 0) resume = files[0];

    // An application form: an email field and a place for the CV. Anything
    // else (a newsletter box, a demo request) is left alone.
    out.found = !!emailField && !!resume;
    if (opts.dry) out.plan = fields.map(f => `${f.key} <- ${labelOf(f.el) || f.el.name || f.el.id}`).concat(resume ? [`resume <- ${contextOf(resume).slice(0, 60)}`] : []);
    if (!out.found || opts.dry) return out;

    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    // React and friends remember the last value they rendered and ignore an
    // input event that matches it; the prototype's setter goes around that.
    const setValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
      if (!VALUE[f.key]) { add(out.left, LABEL[f.key]); continue; }
      setValue(f.el, VALUE[f.key]);
      typed.push(f);
    }
    if (resume.files && resume.files.length) {
      out.attached = true; // the user's own file stays
      out.fileName = resume.files[0].name;
    } else if (file && file.b64 && typeof DataTransfer === 'function') {
      const bin = atob(file.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file.name, { type: file.type || 'application/pdf' }));
      resume.files = dt.files;
      // Lever's native form sends the file as is; its change handler only
      // starts an optional résumé parse. Everywhere else the change event is
      // how the page learns about the file.
      if (!/(^|\.)lever\.co$/.test(location.hostname)) { fire(resume, 'input'); fire(resume, 'change'); }
    }
    // Report what stuck, not what was typed: a field that wants a choice from
    // its own list (Lever's location) clears itself.
    await new Promise(r => setTimeout(r, 700));
    for (const f of typed) add(f.el.isConnected && String(f.el.value || '').trim() ? out.filled : out.left, LABEL[f.key]);
    out.left = out.left.filter(l => !out.filled.includes(l));
    if (!out.attached && file && file.b64) {
      const pageShows = deepText().includes(file.name); // some upload widgets take the file and clear the input
      out.attached = (resume.files && resume.files.length === 1) || pageShows;
      if (out.attached && !pageShows && !document.getElementById('jma-dm-attached-note')) {
        const note = document.createElement('div');
        note.id = 'jma-dm-attached-note';
        note.dir = 'rtl';
        note.textContent = '✓ ' + file.name + ' צורף על ידי Job Match AI';
        note.style.cssText = 'margin:6px 0;padding:6px 10px;border-radius:8px;background:#F0FDF4;' +
          'border:1px solid #BBF7D0;color:#15803D;font:500 13px/1.4 Rubik,Arial,sans-serif;';
        let at = resume;
        while (up(at) && !visible(at)) at = up(at);
        at.insertAdjacentElement('afterend', note);
      }
    }
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
      if (hit && live()) {
        const [done] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [hit.frameId] }, func: formFill,
          args: [w.profile, w.file, {}] });
        return (done && done.result) || { found: false };
      }
      await _pause(POLL_MS);
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
    follow(tab.id, profile, file, report || (() => {}));
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
  root.JMA_DM.apply = { FIELDS, AUTOFILL_ATS, canAutofill, deriveProfile, getProfile, suggestProfile, saveProfile,
    formFill, open, follow, stopFollowing, fillOpenForm, hasAccess, hasAllSites, requestAccess, downloadCv };
})(typeof globalThis !== 'undefined' ? globalThis : self);
