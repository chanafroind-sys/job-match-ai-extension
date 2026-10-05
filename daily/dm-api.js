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
    if (Array.isArray(d)) return 'הבקשה לא תקינה. רענן/י את התוסף ונסה/י שוב.';
    return `HTTP ${status}`;
  }

  async function request(path, { method = 'GET', json } = {}) {
    const resp = await fetch(BASE + path, {
      method,
      headers: await headers(!!json),
      body: json ? JSON.stringify(json) : undefined,
    });
    let data = null;
    try { data = await resp.json(); } catch (_) { /* empty or non-JSON body */ }
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
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
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
          onEvent(event);
        }
      }
    }
  }

  root.JMA_DM = root.JMA_DM || {};
  root.JMA_DM.api = {
    BACKEND,
    installId,
    status: () => request('/status'),
    today: (latest) => request('/today' + (latest ? '?latest=1' : '')),
    action: (resultId, action) => request(`/results/${resultId}/action`, { method: 'POST', json: { action } }),
    saved: () => request('/saved'),
    extractPdf: (pdf) => request('/cv/extract', { method: 'POST', json: { pdf } }),
    run,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
