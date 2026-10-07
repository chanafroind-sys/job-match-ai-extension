// Daily Matches — the CV library: the versions a run matches against.
//
// Version "main" is V1's own CV (cvText / cvName), read live and never
// written, so updating the CV in settings updates it here too. Extra versions
// live under jma_dm_cv_library, and their original files (for attaching to an
// application) under jma_dm_cv_file_<id>.
//
// Each version has a focus: the job categories it targets (Backend, DevOps…).
// A run searches each version's own categories only. Until the person picks
// them, a version's focus is guessed from its text (focusAuto) and shown as
// such. The person's experience level (lib.level) drops jobs of the wrong
// seniority before any analysis.
//
// V1 stores an uploaded PDF as "[PDF_BASE64:…]" rather than text. The first
// run sends that blob as-is, the server reads it once and streams the text
// back (a cv_text event), and cacheExtracted() keeps it, keyed by a hash of
// the blob so a newly uploaded main CV is read again. A main CV that V1 holds
// only as text can get a file attached here for downloading and auto-attach;
// that file is tied to a hash of the text, so replacing the CV in settings
// retires it.
(function (root) {
  'use strict';

  const LIB_KEY = 'jma_dm_cv_library';
  const FILE_PREFIX = 'jma_dm_cv_file_';
  const MAIN_FILE_KEY = FILE_PREFIX + 'main';
  const PDF_PREFIX = '[PDF_BASE64:';
  const MAX_VERSIONS = 5;
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
  const MAX_STORED_FILE_BYTES = 1.5 * 1024 * 1024; // chrome.storage.local holds ~10 MB for everything
  const MIN_TEXT = 200;
  const MAX_TEXT = 30000;
  // The pool's own categories (server-python/daily_matches/config.py CATEGORIES).
  const CATEGORIES = ['Backend', 'Full Stack', 'Frontend', 'AI / ML', 'DevOps', 'Data', 'QA', 'Security',
    'Mobile', 'Embedded', 'Hardware'];
  const LEVELS = ['junior', 'mid', 'senior', 'lead'];

  const isPdfBlob = (t) => typeof t === 'string' && t.trimStart().startsWith(PDF_PREFIX);
  const blobBody = (t) => { const b = t.trim().slice(PDF_PREFIX.length); return b.endsWith(']') ? b.slice(0, -1) : b; };
  const cleanFocus = (focus) => CATEGORIES.filter(c => (focus || []).includes(c));

  // A first guess at what a CV targets, from technology words. Two mentions
  // or more count; frontend plus backend reads as full stack.
  const FOCUS_HINTS = [
    ['AI / ML', /\b(llms?|rag|langchain|pytorch|tensorflow|machine learning|deep learning|nlp|computer vision|genai|hugging ?face|fine[- ]tun\w*)\b/gi],
    ['DevOps', /\b(kubernetes|k8s|terraform|helm|devops|sre|argo ?cd|ansible|prometheus|grafana|ci\/cd)\b/gi],
    ['Data', /\b(spark|airflow|etl|dbt|snowflake|bigquery|databricks|data warehouse|data pipelines?)\b/gi],
    ['Frontend', /\b(react|angular|vue|css|html|redux|next\.?js|front[- ]?end)\b/gi],
    ['Backend', /\b(back[- ]?end|microservices?|node\.?js|django|flask|fastapi|spring|java|golang|\.net|c#|rest(ful)? apis?|postgres(ql)?|mongodb|redis|kafka)\b/gi],
    ['QA', /\b(qa|selenium|playwright|cypress|test automation|automation engineer)\b/gi],
    ['Mobile', /\b(ios|android|swift|react native|flutter)\b/gi],
    ['Security', /\b(penetration|pentest\w*|reverse engineering|malware|cyber ?security|appsec)\b/gi],
    ['Embedded', /\b(embedded|firmware|rtos|linux kernel|device drivers?|bare[- ]metal)\b/gi],
  ];
  function suggestFocus(text) {
    const t = text || '';
    const hits = Object.fromEntries(FOCUS_HINTS.map(([cat, re]) => [cat, (t.match(re) || []).length]));
    if (hits.Frontend >= 2 && hits.Backend >= 2) {
      return ['Full Stack', hits.Backend >= hits.Frontend ? 'Backend' : 'Frontend'];
    }
    return Object.entries(hits).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
  }

  async function sha256(text) {
    const buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function _load() {
    const stored = (await chrome.storage.local.get(LIB_KEY))[LIB_KEY] || {};
    return { versions: [], mainLabel: '', mainFocus: [], mainExtracted: null, level: null, ...stored };
  }
  const _save = (lib) => chrome.storage.local.set({ [LIB_KEY]: lib });

  // The file attached to a text-only main CV, while that CV is still current.
  async function _mainFile(cvText) {
    const stored = (await chrome.storage.local.get(MAIN_FILE_KEY))[MAIN_FILE_KEY];
    return stored && cvText && stored.cvHash === await sha256(cvText) ? stored : null;
  }

  async function list() {
    const lib = await _load();
    const { cvText, cvName } = await chrome.storage.local.get(['cvText', 'cvName']);
    const out = [];
    if (cvText) {
      let text = cvText;
      let needsExtraction = false;
      if (isPdfBlob(cvText)) {
        const hash = await sha256(cvText);
        if (lib.mainExtracted && lib.mainExtracted.blobHash === hash) text = lib.mainExtracted.text;
        else needsExtraction = true;
      }
      const attached = isPdfBlob(cvText) ? null : await _mainFile(cvText);
      out.push({
        id: 'main', source: 'main', label: lib.mainLabel || 'קורות החיים הראשיים',
        fileName: attached ? attached.name : (cvName || ''), text, needsExtraction,
        hasFile: isPdfBlob(cvText) || !!attached, focus: cleanFocus(lib.mainFocus),
        focusAuto: needsExtraction ? [] : suggestFocus(text),
      });
    }
    for (const v of lib.versions) {
      out.push({ ...v, source: 'upload', needsExtraction: false, focus: cleanFocus(v.focus),
        focusAuto: suggestFocus(v.text) });
    }
    return out;
  }

  // What a run uses: the chosen focus, else the guess.
  const effectiveFocus = (v) => (v.focus && v.focus.length ? v.focus : v.focusAuto || []);

  function _b64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function _readFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('הקובץ גדול מ-5MB.');
    const buffer = await file.arrayBuffer();
    const b64 = _b64(buffer);
    let text;
    if (ext === 'txt') {
      text = new TextDecoder('utf-8').decode(buffer);
    } else if (ext === 'docx') {
      text = await root.JMA_DM.extractDocxText(buffer);
    } else if (ext === 'pdf') {
      text = (await root.JMA_DM.api.extractPdf(b64)).text;
    } else if (ext === 'doc') {
      throw new Error('פורמט ‎.doc לא נתמך. שמור/י את הקובץ כ-‎.docx ונסה/י שוב.');
    } else {
      throw new Error('אפשר להעלות PDF,‏ DOCX או TXT.');
    }
    if (!text || text.trim().length < MIN_TEXT) throw new Error('לא נמצא מספיק טקסט בקובץ.');
    const type = ext === 'pdf' ? 'application/pdf'
      : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain';
    return { text: text.trim().slice(0, MAX_TEXT), b64, type };
  }

  async function _storeFile(key, file, extra = {}) {
    const { b64, type } = extra.read || await _readFile(file);
    if (file.size > MAX_STORED_FILE_BYTES) return false;
    try {
      await chrome.storage.local.set({ [key]: { name: file.name, type, b64, ...(extra.fields || {}) } });
      return true;
    } catch (e) {
      console.warn('[JMA:DM] original file not stored (storage full):', e && e.message);
      return false;
    }
  }

  async function add(file, label, focus) {
    if ((await list()).length >= MAX_VERSIONS) throw new Error(`אפשר לשמור עד ${MAX_VERSIONS} גרסאות קורות חיים.`);
    const read = await _readFile(file);
    const id = 'v' + Date.now().toString(36);
    const hasFile = await _storeFile(FILE_PREFIX + id, file, { read });
    const lib = await _load();
    lib.versions.push({
      id, label: (label || '').trim().slice(0, 60) || file.name.replace(/\.[^.]+$/, ''),
      fileName: file.name, text: read.text, addedAt: Date.now(), hasFile, focus: cleanFocus(focus),
    });
    await _save(lib);
    return id;
  }

  // A downloadable file for a main CV that V1 keeps only as text (DOCX or
  // pasted). Its text isn't used: V1's CV stays the source of truth.
  async function attachMainFile(file) {
    const { cvText } = await chrome.storage.local.get('cvText');
    if (!cvText) throw new Error('קודם צריך קורות חיים ראשיים בהגדרות ⚙️.');
    if (file.size > MAX_STORED_FILE_BYTES) throw new Error('הקובץ גדול מ-1.5MB, ולכן אי אפשר לשמור אותו להורדה.');
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['pdf', 'docx'].includes(ext)) throw new Error('אפשר לצרף קובץ PDF או DOCX.');
    const b64 = _b64(await file.arrayBuffer());
    const type = ext === 'pdf' ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const stored = await _storeFile(MAIN_FILE_KEY, file, { read: { b64, type }, fields: { cvHash: await sha256(cvText) } });
    if (!stored) throw new Error('לא הצלחנו לשמור את הקובץ (האחסון של התוסף מלא).');
  }

  async function setFocus(id, focus) {
    const clean = cleanFocus(focus);
    const lib = await _load();
    if (id === 'main') lib.mainFocus = clean;
    else lib.versions = lib.versions.map(v => (v.id === id ? { ...v, focus: clean } : v));
    await _save(lib);
  }

  async function getLevel() {
    const lib = await _load();
    return LEVELS.includes(lib.level) ? lib.level : null;
  }

  async function setLevel(level) {
    const lib = await _load();
    lib.level = LEVELS.includes(level) ? level : null;
    await _save(lib);
  }

  async function rename(id, label) {
    const clean = (label || '').trim().slice(0, 60);
    if (!clean) return;
    const lib = await _load();
    if (id === 'main') lib.mainLabel = clean;
    else lib.versions = lib.versions.map(v => (v.id === id ? { ...v, label: clean } : v));
    await _save(lib);
  }

  async function remove(id) {
    if (id === 'main') throw new Error('את קורות החיים הראשיים מחליפים בהגדרות ⚙️.');
    const lib = await _load();
    lib.versions = lib.versions.filter(v => v.id !== id);
    await _save(lib);
    await chrome.storage.local.remove(FILE_PREFIX + id);
  }

  async function cacheExtracted(cvId, text) {
    if (!text) return;
    const lib = await _load();
    if (cvId === 'main') {
      const { cvText } = await chrome.storage.local.get('cvText');
      if (!isPdfBlob(cvText)) return;
      lib.mainExtracted = { blobHash: await sha256(cvText), text: text.slice(0, MAX_TEXT) };
    } else {
      lib.versions = lib.versions.map(v => (v.id === cvId ? { ...v, text: text.slice(0, MAX_TEXT) } : v));
    }
    await _save(lib);
  }

  // The original file for attaching to an application, or null.
  async function getFile(id) {
    if (id === 'main') {
      const { cvText, cvName } = await chrome.storage.local.get(['cvText', 'cvName']);
      if (isPdfBlob(cvText)) return { name: cvName || 'CV.pdf', type: 'application/pdf', b64: blobBody(cvText) };
      const attached = await _mainFile(cvText);
      return attached ? { name: attached.name, type: attached.type, b64: attached.b64 } : null;
    }
    return (await chrome.storage.local.get(FILE_PREFIX + id))[FILE_PREFIX + id] || null;
  }

  async function runPayload() {
    const versions = await list();
    return {
      cvs: versions.map(v => ({ id: v.id, label: v.label, text: v.text, focus: effectiveFocus(v) })),
      primaryCvId: versions.length ? versions[0].id : null,
      prefs: { level: await getLevel() },
    };
  }

  root.JMA_DM = root.JMA_DM || {};
  root.JMA_DM.cvLibrary = {
    MAX_VERSIONS, CATEGORIES, LEVELS, list, add, rename, remove, cacheExtracted, getFile, runPayload, isPdfBlob,
    setFocus, getLevel, setLevel, attachMainFile, suggestFocus, effectiveFocus,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
