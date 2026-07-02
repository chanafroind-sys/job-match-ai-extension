const BACKEND_URL = 'https://job-match-ai-extension.onrender.com';
const WS_URL      = 'wss://job-match-ai-extension.onrender.com/ws/clicks';

// ── Real-time WebSocket push (replaces chrome.alarms polling) ─────────────────
let _ws = null;
let _wsReconnectTimer = null;
let _wsPingTimer = null;
let _wsUserId = null;
let _wsFailCount = 0;         // consecutive connection failures
const _WS_MAX_FAILS = 5;      // stop retrying after this many back-to-back failures

async function _getWsUserId() {
  if (_wsUserId) return _wsUserId;
  const { licenseKey } = await chrome.storage.local.get(['licenseKey']);
  if (!licenseKey) return null;
  // SHA-256 of license key → first 16 hex chars as stable, opaque user id
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(licenseKey));
  _wsUserId = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  return _wsUserId;
}

async function _connectWs() {
  // Close any existing connection first
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
  clearTimeout(_wsReconnectTimer);
  clearInterval(_wsPingTimer);

  const userId = await _getWsUserId();
  if (!userId) return; // no license key yet

  const ws = new WebSocket(`${WS_URL}?user_id=${userId}`);
  _ws = ws;

  ws.onopen = () => {
    console.log('[JMA:ws] connected');
    _wsFailCount = 0; // reset on successful connection
    // Ping every 4 min to keep connection alive (Render closes idle WS after ~5 min)
    _wsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 4 * 60 * 1000);
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.type !== 'click') return;

    // Look up job details from local tracker for the toast
    const { jobTracker } = await chrome.storage.local.get(['jobTracker']);
    const job = (jobTracker || []).find(j => j.appId === msg.app_id);
    const jobTitle = msg.jobTitle || job?.jobTitle || 'המשרה';
    const company  = msg.company  || job?.company  || '';
    const target   = msg.target === 'github' ? 'GitHub' : msg.target === 'linkedin' ? 'LinkedIn' : 'Portfolio';

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'showClickToast', jobTitle, company, target,
      }).catch(() => {});
    }
    chrome.action.setBadgeText({ text: 'NEW' });
    chrome.action.setBadgeBackgroundColor({ color: '#EA580C' });
  };

  ws.onerror = () => {};

  ws.onclose = (event) => {
    clearInterval(_wsPingTimer);
    if (_ws !== ws) return;

    // Code 1008 = Policy Violation — server rejected the connection (HTTP 403 upgrade).
    // Also stop if the server never opened at all (code 1006 = abnormal closure from a
    // failed HTTP upgrade).  After _WS_MAX_FAILS consecutive failures we give up so we
    // don't spam Render logs with hundreds of rejected connections.
    _wsFailCount++;
    const isPermanent = event.code === 1008;
    const tooManyFails = _wsFailCount >= _WS_MAX_FAILS;

    if (isPermanent || tooManyFails) {
      console.warn(`[JMA:ws] stopping reconnect — code=${event.code} fails=${_wsFailCount}`);
      return;
    }

    // Exponential back-off: 20 s → 40 s → 80 s (cap 2 min)
    const delay = Math.min(20000 * Math.pow(2, _wsFailCount - 1), 120000);
    console.log(`[JMA:ws] closed (code=${event.code}) — retry #${_wsFailCount} in ${delay / 1000} s`);
    _wsReconnectTimer = setTimeout(_connectWs, delay);
  };
}

// Connect on service-worker startup
_connectWs();

// Reconnect immediately when the license key is set or changed
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.licenseKey) {
    _wsUserId = null;   // invalidate cached user id
    _wsFailCount = 0;   // reset circuit-breaker so fresh key gets a clean slate
    _connectWs();
  }
});

function friendlyError(msg) {
  if (!msg) return 'קרתה תקלה לא צפויה. נסי שוב.';
  const lo = msg.toLowerCase();
  if (lo.includes('devices') || lo.includes('already activated')) {
    return 'הרישיון כבר בשימוש במספר מקסימלי של מכשירים.';
  }
  if (
    msg.includes('401') ||
    msg.includes('403') ||
    lo.includes('invalid') && lo.includes('license') ||
    lo.includes('expired license') ||
    lo.includes('license key')
  ) {
    return 'המפתח אינו בתוקף או שלא הוגדר. אנא הזן מפתח תקין בהגדרות ⚙️ כדי להמשיך.';
  }
  if (msg.includes('429') || lo.includes('monthly usage') || lo.includes('monthly limit')) {
    return 'הגעת למגבלה החודשית (100 ניתוחים). המכסה מתחדשת ב-1 לחודש הבא.';
  }
  if (lo.includes('אין חיבור') || lo.includes('internet') || lo.includes('network') || lo.includes('cannot reach')) {
    return 'אין חיבור לאינטרנט או שהשירות לא זמין. בדקי את החיבור ונסי שוב.';
  }
  if (lo.includes('מתעורר') || lo.includes('waking') || msg.includes('502') || msg.includes('503')) {
    return 'האפליקציה מתעוררת — זה יכול לקחת עד דקה. נסי שוב בעוד רגע.';
  }
  if (lo.includes('לא הצלחנו') || lo.includes('מגבלה') || lo.includes('רישיון')) return msg;
  return 'משהו השתבש. נסי שוב בעוד רגע.';
}

async function fetchWithRetry(endpoint, options, maxAttempts = 6, delayMs = 12000) {
  // Render free-tier servers return 502 immediately when sleeping and take ~60s to wake.
  // We use a longer delay (25 s) specifically for sleeping-server responses so that
  // across 5 retries (5 × 25 = 125 s) the server has enough time to come online.
  const SLEEPING_DELAY_MS = 25000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res, text;
    console.log(`[JMA:fetch] ${endpoint} attempt ${attempt}/${maxAttempts}`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);
      res = await fetch(`${BACKEND_URL}${endpoint}`, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      text = await res.text();
      console.log(`[JMA:fetch] ${endpoint} status=${res.status} body_len=${text.length} body_start=${text.slice(0,120)}`);
    } catch (e) {
      console.log(`[JMA:fetch] ${endpoint} network error: ${e.message}`);
      const isLast = attempt === maxAttempts;
      if (isLast) throw new Error('אין חיבור לאינטרנט או שהשירות לא זמין. בדקי את החיבור ונסי שוב.');
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    const isHtml = text.trimStart().startsWith('<') || text.includes('<html');
    const isSleeping = isHtml || res.status === 502 || res.status === 503 || res.status === 504;
    if (isSleeping || res.status === 500) {
      console.log(`[JMA:fetch] ${endpoint} server sleeping (status=${res.status} isHtml=${isHtml}), retrying...`);
      if (attempt === maxAttempts) {
        throw new Error('לא הצלחנו להגיע לשירות. פתחי https://job-match-ai-extension.onrender.com/health בדפדפן כדי להעיר אותו, ונסי שוב.');
      }
      // Use longer delay when the server is sleeping so it has time to start up
      await new Promise(r => setTimeout(r, isSleeping ? SLEEPING_DELAY_MS : delayMs));
      continue;
    }

    let data;
    try { data = JSON.parse(text); } catch { throw new Error('תגובה לא צפויה מהשירות. נסי שוב.'); }
    if (!res.ok) {
      const errMsg = data.detail || data.error || `שגיאה ${res.status}`;
      console.log(`[JMA:fetch] ${endpoint} ERROR ${res.status}: ${errMsg}`);
      throw new Error(errMsg);
    }
    console.log(`[JMA:fetch] ${endpoint} OK`);
    return data;
  }
}

async function backendPost(endpoint, body, licenseKey, opts = {}) {
  return fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-license-key': licenseKey || '',
    },
    body: JSON.stringify(body),
  }, opts.maxAttempts || 6, opts.delayMs || 12000);
}

function _urlHash(url) {
  let h = 0;
  for (let i = 0; i < (url || '').length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
function _prefKey(url) { return `jma_pf_${_urlHash(url)}`; }
function _navKey(url)  { return `jma_nav_${_urlHash(url)}`; }

// Extension icon click → toggle injected sidebar panel
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 400));
      chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' }).catch(() => {});
    } catch (e) { console.log('[JMA:sidebar] inject failed:', e.message); }
  }
});

// LinkedIn SPA navigation detector
// When the user browses between job postings inside LinkedIn, the URL changes
// but the page never fully reloads, so the old analysis would re-appear.
// We stamp a flag in storage; the popup reads it on open and forces a fresh start.
{
  const _linkedinTabUrls = {};
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    const url = changeInfo.url;
    if (!url.includes('linkedin.com')) return;
    const prev = _linkedinTabUrls[tabId];
    _linkedinTabUrls[tabId] = url;
    if (prev && prev !== url) {
      chrome.storage.local.set({ [_navKey(url)]: Date.now() }).catch(() => {});
    }
  });
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  if (req.action === 'verifyLicense') {
    backendPost('/api/verify-license', { licenseKey: req.licenseKey }, null)
      .then(data => sendResponse({ result: data }))
      .catch(err => sendResponse({ error: friendlyError(err.message) }));
    return true;
  }

  if (req.action === 'analyzeJob') {
    backendPost('/api/analyze', {
      cvText: req.cvText,
      jobText: req.jobText,
      answers: req.answers || [],
      preflight: req.preflight || false,
    }, req.licenseKey)
      .then(data => sendResponse({ result: data.result }))
      .catch(err => sendResponse({ error: friendlyError(err.message) }));
    return true;
  }

  if (req.action === 'generateCV') {
    backendPost('/api/generate-cv', {
      cvText: req.cvText,
      jobText: req.jobText,
      jobLanguage: req.jobLanguage,
      answers: req.answers,
      cvUrls: req.cvUrls || [],
      userConstraints: req.userConstraints || '',
      generateCoverLetter: req.generateCoverLetter || false,
      enableTracking: req.enableTracking !== false,
      jobTitle: req.jobTitle || '',
      company: req.company || '',
      model: req.model || 'sonnet',
    }, req.licenseKey)
      .then(data => sendResponse({ cvText: data.cvText, appId: data.appId, sections: data.sections || [], coverLetterText: data.coverLetterText || '' }))
      .catch(err => sendResponse({ error: friendlyError(err.message) }));
    return true;
  }

  if (req.action === 'updateFabScore') {
    // Relay: popup iframe → background → content script of active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'updateFabScore', score: req.score }).catch(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }

  if (req.action === 'scoreAnswer') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey || !(req.answer || '').trim()) { sendResponse({ score_pct: 0 }); return; }
      try {
        const data = await backendPost('/api/score-answer', {
          question: req.question || '',
          skill: req.skill || '',
          answer: req.answer,
        }, stored.licenseKey, { maxAttempts: 1, delayMs: 0 });
        sendResponse({ score_pct: data.score_pct ?? 50 });
      } catch { sendResponse({ score_pct: 50 }); }
    });
    return true;
  }

  if (req.action === 'pingBackend') {
    // Fire-and-forget wake-up call to prevent Render cold start delay
    fetch(`${BACKEND_URL}/health`).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (req.action === 'startJobPreflight') {
    const tabId = sender.tab?.id;
    sendResponse({ ok: true }); // immediate ack so content script doesn't wait
    chrome.storage.local.get(['licenseKey', 'cvText', 'cvHyperlinkUrls'], async (stored) => {
      if (!stored.licenseKey || !stored.cvText) return;

      // Stage 1 is now handled locally in content.js via matcher.js (instant, zero network cost).
      // ── Stage 2: deep analysis — weighted questions + gap ─────────────────────
      try {
        const data = await backendPost('/api/analyze', {
          cvText: stored.cvText,
          jobText: req.jobText,
          answers: [],
          preflight: true,
          model: req.model || 'sonnet',
        }, stored.licenseKey, { maxAttempts: 2, delayMs: 8000 });
        const result = data?.result || data || {};
        const cKey = _prefKey(req.url || '');
        await chrome.storage.local.set({
          [cKey]: { ...result, ts: Date.now(), url: req.url },
        });
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            action: 'preflightDone',
            score: result.base_score || result.score || 0,
          }).catch(() => {});
        }
      } catch (e) {
        console.log('[JMA:fab_preflight] Stage2 error:', e.message);
        if (tabId) chrome.tabs.sendMessage(tabId, { action: 'preflightError' }).catch(() => {});
      }
    });
    return true;
  }

  if (req.action === 'fetchJobDetails') {
    // Fetch full HTML of each job page and extract text — no Claude cost, pure browser fetch
    function extractJobTextFromHtml(html) {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        ['script','style','nav','header','footer','aside','[class*="cookie"]','[class*="banner"]','[class*="nav"]'].forEach(sel => {
          try { doc.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
        });
        const selectors = [
          '[class*="job-description"]','[class*="jobDescription"]','[id*="job-description"]',
          '[class*="position-description"]','[class*="vacancy-description"]',
          '.job__description','#jobDescriptionText','.jobDescriptionContent',
          '#content','.content','main','article',
        ];
        for (const sel of selectors) {
          try {
            const el = doc.querySelector(sel);
            const text = el?.textContent?.trim();
            if (text && text.length > 150) return text.replace(/\s+/g,' ').substring(0, 2500);
          } catch {}
        }
        return (doc.body?.textContent?.trim() || '').replace(/\s+/g,' ').substring(0, 2500);
      } catch { return ''; }
    }

    const fetchOne = async (url) => {
      if (!url || !url.startsWith('http')) return '';
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 9000);
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { 'Accept': 'text/html', 'Accept-Language': 'he,en;q=0.9' },
        });
        clearTimeout(tid);
        if (!resp.ok) return '';
        const html = await resp.text();
        return extractJobTextFromHtml(html);
      } catch { return ''; }
    };

    Promise.all((req.urls || []).map(fetchOne)).then(texts => {
      sendResponse({ texts });
    });
    return true;
  }

  if (req.action === 'rankJobs') {
    chrome.storage.local.get(['licenseKey', 'cvText'], async (stored) => {
      if (!stored.licenseKey || !stored.cvText) {
        sendResponse({ error: 'כדי לדרג משרות יש להגדיר קורות חיים ורישיון תחילה. פתחי את ה-extension.' });
        return;
      }
      try {
        const data = await backendPost('/api/rank-jobs', {
          cvText: stored.cvText,
          jobs: req.jobs,
        }, stored.licenseKey);
        sendResponse({ rankedJobs: data.rankedJobs });
      } catch (err) {
        sendResponse({ error: friendlyError(err.message) });
      }
    });
    return true;
  }

  if (req.action === 'injectContentScript') {
    chrome.scripting.executeScript({ target: { tabId: req.tabId }, files: ['content.js'] })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (req.action === 'scrapeJob') {
    // Fire-and-forget — silently send job content to backend for crowdsourced collection
    fetch(`${BACKEND_URL}/api/scrape-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: req.url, text: req.text, title: req.title || '' }),
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (req.action === 'importPremiumJobs') {
    chrome.storage.local.get(['licenseKey', 'cvText'], async (stored) => {
      if (!stored.licenseKey || !stored.cvText) {
        sendResponse({ error: 'נדרשים רישיון וקורות חיים כדי להשתמש בפיצ\'ר זה.' });
        return;
      }
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 180000); // 3 min for big batches
        const resp = await fetch(`${BACKEND_URL}/api/import-jobs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-license-key': stored.licenseKey,
          },
          body: JSON.stringify({
            cvText: stored.cvText,
            minScore: req.minScore,
            timeRange: req.timeRange,
          }),
          signal: controller.signal,
        });
        clearTimeout(tid);

        if (!resp.ok) {
          let errMsg = `שגיאה ${resp.status}`;
          try { const d = await resp.json(); errMsg = d.detail || errMsg; } catch {}
          sendResponse({ error: errMsg });
          return;
        }

        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        // Convert to base64 in chunks to avoid stack overflow on large files
        let binary = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        sendResponse({
          dataUrl: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${btoa(binary)}`,
        });
      } catch (err) {
        sendResponse({
          error: err.name === 'AbortError'
            ? 'הייבוא לקח יותר מדי זמן. נסי שוב בעוד רגע.'
            : friendlyError(err.message),
        });
      }
    });
    return true;
  }
});
