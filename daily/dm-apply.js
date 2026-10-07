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
// Auto-fill runs on the ATSes whose application form was probed live:
//   Lever (COMPANY_RADAR.md §8): native multipart form, native file input, no
//     React. leverFill.
//   Greenhouse (job-boards.greenhouse.io, probed 2026-10-07): a React form.
//     #first_name, #last_name, #email, #phone; LinkedIn is a custom question
//     found by its label; the CV is input#resume with a React onChange.
//   Ashby (jobs.ashbyhq.com/…/application, probed 2026-10-07): a React app with
//     no <form> at all. #_systemfield_name, #_systemfield_email; phone and
//     LinkedIn by label; the CV is input#_systemfield_resume (not the
//     "Autofill from resume" input, which would let Ashby fill fields itself).
//   reactFill covers both React forms.
// Workday puts the form behind a sign-in wall, so it gets download-and-copy, as
// does every ATS not probed yet (Comeet, SmartRecruiters…).
(function (root) {
  'use strict';

  const PROFILE_KEY = 'jma_dm_apply_profile';
  const FIELDS = ['fullName', 'email', 'phone', 'location', 'linkedin', 'company'];
  const AUTOFILL_ATS = ['lever', 'greenhouse', 'ashby'];

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

  // Runs inside the Lever page via chrome.scripting.executeScript, so it must
  // be self-contained. Fill-only: it sets values and attaches a file, and
  // reports what it did. It never touches the form's submission.
  function leverFill(profile, file) {
    const out = { found: false, filled: [], left: [], attached: false, fileName: file ? file.name : '' };
    const fields = [
      ['input[name="name"]', profile.fullName, 'Full name'],
      ['input[name="email"]', profile.email, 'Email'],
      ['input[name="phone"]', profile.phone, 'Phone'],
      ['input[name="location"]', profile.location, 'Current location'],
      ['input[name="org"]', profile.company, 'Current company'],
      ['input[name="urls[LinkedIn]"]', profile.linkedin, 'LinkedIn'],
    ];
    for (const [selector, value, label] of fields) {
      const el = document.querySelector(selector);
      if (!el) continue;
      out.found = true;
      if (el.value && el.value.trim()) { out.filled.push(label); continue; } // never overwrite the user
      if (!value) { out.left.push(label); continue; }
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      out.filled.push(label);
    }
    const resume = document.querySelector('input[type="file"][name="resume"]');
    if (resume) out.found = true;
    if (resume && file && file.b64 && typeof DataTransfer === 'function') {
      const bin = atob(file.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file.name, { type: file.type || 'application/pdf' }));
      resume.files = dt.files;
      out.attached = resume.files.length === 1;
      // No change event: on Lever it only starts an optional résumé-parse
      // upload; the native multipart form sends the file anyway (§8). A note
      // next to the input says it's attached, since Lever's own label won't.
      if (out.attached && !document.getElementById('jma-dm-attached-note')) {
        const note = document.createElement('div');
        note.id = 'jma-dm-attached-note';
        note.dir = 'rtl';
        note.textContent = '✓ ' + file.name + ' צורף על ידי Job Match AI';
        note.style.cssText = 'margin:6px 0;padding:6px 10px;border-radius:8px;background:#F0FDF4;' +
          'border:1px solid #BBF7D0;color:#15803D;font:500 13px/1.4 Rubik,Arial,sans-serif;';
        resume.insertAdjacentElement('afterend', note);
      }
    }
    if (resume && !out.attached) out.left.push('Resume/CV');
    // Point the human at the button they press. Styling only.
    const submit = document.querySelector('#btn-submit, button[type="submit"], input[type="submit"]');
    if (submit) {
      submit.style.outline = '3px solid #F59E0B';
      submit.style.outlineOffset = '3px';
    }
    return out;
  }

  // Runs inside a Greenhouse or Ashby application page via
  // chrome.scripting.executeScript, so it must be self-contained. Same contract
  // as leverFill: fills, attaches, reports; never touches submission.
  function reactFill(ats, profile, file) {
    const out = { found: false, filled: [], left: [], attached: false, fileName: file ? file.name : '' };
    const names = String(profile.fullName || '').trim().split(/\s+/).filter(Boolean);
    const first = names.length > 1 ? names.slice(0, -1).join(' ') : (names[0] || '');
    const last = names.length > 1 ? names[names.length - 1] : '';
    const TEXTY = ['text', 'email', 'tel', 'url'];
    const byId = (id) => document.getElementById(id);
    const byLabel = (re) => {
      for (const label of document.querySelectorAll('label')) {
        if (!re.test(label.textContent || '')) continue;
        const el = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input');
        if (el && el.tagName === 'INPUT' && TEXTY.includes(el.type)) return el;
      }
      return null;
    };
    const spec = {
      greenhouse: {
        fields: [[() => byId('first_name'), first, 'First name'], [() => byId('last_name'), last, 'Last name'],
          [() => byId('email'), profile.email, 'Email'], [() => byId('phone'), profile.phone, 'Phone'],
          [() => byLabel(/linkedin/i), profile.linkedin, 'LinkedIn']],
        resume: () => byId('resume'),
        submit: 'button[type="submit"]',
      },
      ashby: {
        fields: [[() => byId('_systemfield_name'), profile.fullName, 'Full name'],
          [() => byId('_systemfield_email'), profile.email, 'Email'],
          [() => byLabel(/^\s*phone/i), profile.phone, 'Phone'], [() => byLabel(/linkedin/i), profile.linkedin, 'LinkedIn']],
        resume: () => byId('_systemfield_resume'),
        submit: '.ashby-application-form-submit-button, button[type="submit"]',
      },
    }[ats];
    if (!spec) return out;
    // React remembers the last value it rendered and ignores an input event
    // whose value matches it. Setting through the prototype's setter goes
    // around that memory, so the event below reads as the user's typing.
    const setValue = (el, value) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); // Ashby validates when a field is left
    };
    for (const [find, value, label] of spec.fields) {
      const el = find();
      if (!el) continue;
      out.found = true;
      if (el.value && el.value.trim()) { out.filled.push(label); continue; } // never overwrite the user
      if (!value) { out.left.push(label); continue; }
      setValue(el, value);
      out.filled.push(label);
    }
    const resume = spec.resume();
    if (resume) out.found = true;
    if (resume && file && file.b64 && typeof DataTransfer === 'function') {
      const bin = atob(file.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file.name, { type: file.type || 'application/pdf' }));
      resume.files = dt.files;
      // Unlike Lever's native form, these forms keep the file only through
      // React's change handler, so the change event is required here.
      resume.dispatchEvent(new Event('change', { bubbles: true }));
      out.attached = resume.files.length === 1;
    }
    if (resume && !out.attached) out.left.push('Resume/CV');
    // Point the human at the button they press. Styling only.
    const submit = document.querySelector(spec.submit);
    if (submit) {
      submit.style.outline = '3px solid #F59E0B';
      submit.style.outlineOffset = '3px';
    }
    return out;
  }

  function _waitForComplete(tabId, timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
      chrome.tabs.onUpdated.addListener(listener);
      const timer = setTimeout(finish, timeoutMs);
      chrome.tabs.get(tabId).then(t => { if (t && t.status === 'complete') finish(); }).catch(() => {});
    });
  }

  const canAutofill = (ats) => AUTOFILL_ATS.includes(ats);
  const _pause = (ms) => new Promise(r => setTimeout(r, ms));

  // Opens the application page next to the side panel. Auto-fills on the
  // probed ATSes only, and only with a profile the user has confirmed.
  async function open(card, cvId) {
    const job = card.job || {};
    const tab = await chrome.tabs.create({ url: job.apply_url || job.url, active: true });
    if (!canAutofill(job.ats)) return { mode: job.ats === 'workday' ? 'signin' : 'manual', tabId: tab.id };
    const profile = await getProfile();
    if (!profile) return { mode: 'manual', tabId: tab.id };
    await _waitForComplete(tab.id, 25000);
    const file = await root.JMA_DM.cvLibrary.getFile(cvId);
    const call = job.ats === 'lever'
      ? { func: leverFill, args: [profile, file] }
      : { func: reactFill, args: [job.ats, profile, file] };
    try {
      // React pages can finish loading before the form renders: look again a few times.
      let result = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await _pause(1200);
        const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, ...call });
        result = injection && injection.result;
        if (result && result.found) break;
      }
      if (!result || !result.found) return { mode: 'manual', tabId: tab.id, reason: 'form_not_found' };
      return { mode: 'autofill', tabId: tab.id, result };
    } catch (e) {
      console.warn('[JMA:DM] auto-fill failed:', e && e.message);
      return { mode: 'manual', tabId: tab.id, reason: 'inject_failed' };
    }
  }

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
    leverFill, reactFill, open, downloadCv };
})(typeof globalThis !== 'undefined' ? globalThis : self);
