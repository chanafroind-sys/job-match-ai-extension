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
// Lever is the one ATS with verified auto-fill (COMPANY_RADAR.md §8: native
// multipart form, native file input, no React). Workday puts the form behind a
// sign-in wall, so it gets download-and-copy, as does every ATS not yet probed.
(function (root) {
  'use strict';

  const PROFILE_KEY = 'jma_dm_apply_profile';
  const FIELDS = ['fullName', 'email', 'phone', 'location', 'linkedin', 'company'];

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

  // Opens the application page next to the side panel. Auto-fills only on
  // Lever, and only with a profile the user has confirmed.
  async function open(card, cvId) {
    const job = card.job || {};
    const tab = await chrome.tabs.create({ url: job.apply_url || job.url, active: true });
    if (job.ats !== 'lever') return { mode: job.ats === 'workday' ? 'signin' : 'manual', tabId: tab.id };
    const profile = await getProfile();
    if (!profile) return { mode: 'manual', tabId: tab.id };
    await _waitForComplete(tab.id, 25000);
    const file = await root.JMA_DM.cvLibrary.getFile(cvId);
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: leverFill, args: [profile, file],
      });
      const result = injection && injection.result;
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
  root.JMA_DM.apply = { FIELDS, deriveProfile, getProfile, suggestProfile, saveProfile, leverFill, open, downloadCv };
})(typeof globalThis !== 'undefined' ? globalThis : self);
