const BACKEND_URL = 'https://job-match-ai-extension.onrender.com';

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
      const timeout = setTimeout(() => controller.abort(), 60000);
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

async function backendPost(endpoint, body, licenseKey) {
  return fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-license-key': licenseKey || '',
    },
    body: JSON.stringify(body),
  });
}

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
      chrome.storage.local.set({ [`jma_nav_${tabId}`]: Date.now() }).catch(() => {});
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
    }, req.licenseKey)
      .then(data => sendResponse({ cvText: data.cvText, appId: data.appId, sections: data.sections || [] }))
      .catch(err => sendResponse({ error: friendlyError(err.message) }));
    return true;
  }

  if (req.action === 'pingBackend') {
    // Fire-and-forget wake-up call to prevent Render cold start delay
    fetch(`${BACKEND_URL}/health`).catch(() => {});
    sendResponse({ ok: true });
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
