// Daily Matches — the CV library: the versions a run matches against.
//
// Version "main" is V1's own CV (cvText / cvName), read live and never
// written, so updating the CV in settings updates it here too. Extra versions
// live under jma_dm_cv_library, and their original files (for attaching to an
// application) under jma_dm_cv_file_<id>.
//
// V1 stores an uploaded PDF as "[PDF_BASE64:…]" rather than text. The first
// run sends that blob as-is, the server reads it once and streams the text
// back (a cv_text event), and cacheExtracted() keeps it, keyed by a hash of
// the blob so a newly uploaded main CV is read again.
(function (root) {
  'use strict';

  const LIB_KEY = 'jma_dm_cv_library';
  const FILE_PREFIX = 'jma_dm_cv_file_';
  const PDF_PREFIX = '[PDF_BASE64:';
  const MAX_VERSIONS = 5;
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
  const MAX_STORED_FILE_BYTES = 1.5 * 1024 * 1024; // chrome.storage.local holds ~10 MB for everything
  const MIN_TEXT = 200;
  const MAX_TEXT = 30000;

  const isPdfBlob = (t) => typeof t === 'string' && t.trimStart().startsWith(PDF_PREFIX);
  const blobBody = (t) => { const b = t.trim().slice(PDF_PREFIX.length); return b.endsWith(']') ? b.slice(0, -1) : b; };

  async function sha256(text) {
    const buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function _load() {
    const stored = (await chrome.storage.local.get(LIB_KEY))[LIB_KEY] || {};
    return { versions: [], mainLabel: '', mainExtracted: null, ...stored };
  }
  const _save = (lib) => chrome.storage.local.set({ [LIB_KEY]: lib });

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
      out.push({
        id: 'main', source: 'main', label: lib.mainLabel || 'קורות החיים הראשיים',
        fileName: cvName || '', text, needsExtraction, hasFile: isPdfBlob(cvText),
      });
    }
    for (const v of lib.versions) out.push({ ...v, source: 'upload', needsExtraction: false });
    return out;
  }

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

  async function add(file, label) {
    if ((await list()).length >= MAX_VERSIONS) throw new Error(`אפשר לשמור עד ${MAX_VERSIONS} גרסאות קורות חיים.`);
    const { text, b64, type } = await _readFile(file);
    const id = 'v' + Date.now().toString(36);
    let hasFile = false;
    if (file.size <= MAX_STORED_FILE_BYTES) {
      try {
        await chrome.storage.local.set({ [FILE_PREFIX + id]: { name: file.name, type, b64 } });
        hasFile = true;
      } catch (e) {
        console.warn('[JMA:DM] original file not stored (storage full):', e && e.message);
      }
    }
    const lib = await _load();
    lib.versions.push({
      id, label: (label || '').trim().slice(0, 60) || file.name.replace(/\.[^.]+$/, ''),
      fileName: file.name, text, addedAt: Date.now(), hasFile,
    });
    await _save(lib);
    return id;
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
      if (!isPdfBlob(cvText)) return null;
      return { name: cvName || 'CV.pdf', type: 'application/pdf', b64: blobBody(cvText) };
    }
    return (await chrome.storage.local.get(FILE_PREFIX + id))[FILE_PREFIX + id] || null;
  }

  async function runPayload() {
    const versions = await list();
    return {
      cvs: versions.map(v => ({ id: v.id, label: v.label, text: v.text })),
      primaryCvId: versions.length ? versions[0].id : null,
    };
  }

  root.JMA_DM = root.JMA_DM || {};
  root.JMA_DM.cvLibrary = { MAX_VERSIONS, list, add, rename, remove, cacheExtracted, getFile, runPayload, isPdfBlob };
})(typeof globalThis !== 'undefined' ? globalThis : self);
