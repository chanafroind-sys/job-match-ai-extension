// Daily Matches — backend client for /api/daily-matches/*.
//
// Sends only what these endpoints need: the subscription key (if any) and a
// random install ID generated once per installation. The personal Claude key
// is deliberately not sent, because Daily Matches never runs on it.
(function (root) {
  'use strict';

  const BACKEND = 'https://job-match-ai-extension.onrender.com';
  const BASE = BACKEND + '/api/daily-matches';
  const INSTALL_KEY = 'jma_dm_install_id';
  const INSTALL_RE = /^[A-Za-z0-9-]{16,64}$/;

  function _uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    const b = new Uint8Array(16);
    root.crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  async function installId() {
    const stored = await chrome.storage.local.get(INSTALL_KEY);
    let id = stored[INSTALL_KEY];
    if (!id || !INSTALL_RE.test(id)) {
      id = _uuid();
      await chrome.storage.local.set({ [INSTALL_KEY]: id });
    }
    return id;
  }

  async function headers(json) {
    const keys = root.JMA_Auth ? await root.JMA_Auth.getKeys() : { licenseKey: '' };
    const h = { 'X-JMA-Install-Id': await installId() };
    if (keys.licenseKey) h['X-License-Key'] = keys.licenseKey;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function _detail(data, status) {
    const d = data && data.detail;
    if (typeof d === 'string' && d) return d;
    // A refused field is named, so a report of this error says what to fix.
    if (Array.isArray(d)) {
      const where = d.map(e => (e && Array.isArray(e.loc) ? e.loc.filter(x => x !== 'body').join('.') : '')).filter(Boolean);
      return `לא הצלחנו לשלוח את הבקשה: השרת דחה את ${where.join(', ') || 'הנתונים'}. רענן/י את התוסף ונסה/י שוב. [jma:DM_BAD_REQUEST]`;
    }
    return `HTTP ${status}`;
  }

  // Israeli content filters (Etrog, Rimon, NetFree…) answer a request they block
  // with their own HTML page, status 200, in place of ours. Seen on 2026-10-14:
  // Etrog blocked the run (POST /run) and let every other call through.
  const FILTERS = [[/etrog/i, 'אתרוג'], [/rimon/i, 'רימון'], [/netfree/i, 'נטפרי'], [/safepage|blocked|filter/i, '']];
  const SERVER_HOST = new URL(BACKEND).host;
  function filterBlock(text) {
    const t = String(text || '').trimStart();
    if (!t.startsWith('<')) return null; // ours is JSON or an event stream, never HTML
    const hit = FILTERS.find(([re]) => re.test(t.slice(0, 2000)));
    if (!hit) return null;
    const name = hit[1] ? ` (${hit[1]})` : '';
    return new Error(`החיבור לשרת של התוסף נחסם על ידי סינון האינטרנט שלך${name}. כדי שההתאמות היומיות יעבדו, `
      + `צריך לבקש מחברת הסינון לאשר את הכתובת ${SERVER_HOST}. [jma:DM_FILTERED]`);
  }

  async function request(path, { method = 'GET', json } = {}) {
    const resp = await fetch(BASE + path, {
      method,
      headers: await headers(!!json),
      body: json ? JSON.stringify(json) : undefined,
    });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {
      const blocked = filterBlock(text);
      if (blocked) throw blocked;
    }
    if (!resp.ok) throw new Error(_detail(data, resp.status));
    return data;
  }

  // EventSource can't POST or send headers, so the run's SSE stream is read
  // off a plain fetch. Events are "data: {json}" lines; "[DONE]" ends it.
  async function run(body, onEvent, signal) {
    const resp = await fetch(BASE + '/run', {
      method: 'POST', headers: await headers(true), body: JSON.stringify(body), signal,
    });
    if (!resp.ok || !resp.body) {
      let data = null;
      try { data = await resp.json(); } catch (_) { /* not JSON */ }
      throw new Error(_detail(data, resp.status));
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // What arrived, for the error when the stream ends without its last line.
    const seen = { bytes: 0, events: [], head: '' };
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw new Error(`stream broke after ${seen.bytes} bytes, events [${seen.events.join(',')}]: ${e && e.message}`);
      }
      const { done, value } = chunk;
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      seen.bytes += text.length;
      if (seen.head.length < 160) seen.head += text.slice(0, 160 - seen.head.length);
      buf += text;
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') return;
          let event;
          try { event = JSON.parse(payload); } catch (_) { continue; }
          seen.events.push(event.type);
          onEvent(event);
        }
      }
    }
    throw filterBlock(seen.head + buf) || new Error(`stream ended without [DONE]: HTTP ${resp.status}, ${seen.bytes} bytes, events [${seen.events.join(',')}], `
      + `starts with: ${JSON.stringify(seen.head)}`);
  }

  root.JMA_DM = root.JMA_DM || {};
  root.JMA_DM.api = {
    BACKEND,
    installId,
    status: () => request('/status'),
    today: (latest) => request('/today' + (latest ? '?latest=1' : '')),
    action: (resultId, action) => request(`/results/${resultId}/action`, { method: 'POST', json: { action } }),
    // Admins: which analysis was right on a job (main | other | both | neither | clear).
    judge: (resultId, winner) => request(`/results/${resultId}/judge`, { method: 'POST', json: { winner } }),
    saved: () => request('/saved'),
    extractPdf: (pdf) => request('/cv/extract', { method: 'POST', json: { pdf } }),
    run,
    SERVER_HOST,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
