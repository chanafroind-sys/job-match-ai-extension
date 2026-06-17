const BACKEND_URL = 'https://job-match-ai-extension.onrender.com';

function friendlyError(msg) {
  if (!msg) return 'קרתה תקלה לא צפויה. נסי שוב.';
  const lo = msg.toLowerCase();
  if (msg.includes('401') || (lo.includes('invalid') && lo.includes('license'))) {
    return 'קוד הרישיון לא תקין. בדקי שהעתקת אותו נכון בהגדרות.';
  }
  if (msg.includes('429') || lo.includes('monthly usage') || lo.includes('monthly limit')) {
    return 'הגעת למגבלה החודשית (100 ניתוחים). המכסה מתחדשת ב-1 לחודש הבא.';
  }
  if (msg.includes('403') || lo.includes('devices') || lo.includes('already activated')) {
    return 'הרישיון כבר בשימוש במספר מקסימלי של מכשירים.';
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

async function fetchWithRetry(endpoint, options, maxAttempts = 4, delayMs = 12000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res, text;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      res = await fetch(`${BACKEND_URL}${endpoint}`, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      text = await res.text();
    } catch (e) {
      const isLast = attempt === maxAttempts;
      if (isLast) throw new Error('אין חיבור לאינטרנט או שהשירות לא זמין. בדקי את החיבור ונסי שוב.');
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    const isHtml = text.trimStart().startsWith('<') || text.includes('<html');
    if (isHtml || res.status === 502 || res.status === 503 || res.status === 504) {
      if (attempt === maxAttempts) {
        throw new Error('לא הצלחנו להגיע לשירות. פתחי https://job-match-ai-extension.onrender.com/health בדפדפן כדי להעיר אותו, ונסי שוב.');
      }
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    let data;
    try { data = JSON.parse(text); } catch { throw new Error('תגובה לא צפויה מהשירות. נסי שוב.'); }
    if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
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

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  if (req.action === 'verifyLicense') {
    backendPost('/api/verify-license', { licenseKey: req.licenseKey }, null)
      .then(data => sendResponse({ result: data }))
      .catch(err => sendResponse({ error: friendlyError(err.message) }));
    return true;
  }

  if (req.action === 'analyzeJob') {
    backendPost('/api/analyze', { cvText: req.cvText, jobText: req.jobText }, req.licenseKey)
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
    }, req.licenseKey)
      .then(data => sendResponse({ cvText: data.cvText }))
      .catch(err => sendResponse({ error: friendlyError(err.message) }));
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
});
