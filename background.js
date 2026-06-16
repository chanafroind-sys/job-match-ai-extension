const BACKEND_URL = 'https://job-match-ai-extension.onrender.com';

function friendlyError(msg) {
  if (!msg) return 'An unexpected error occurred.';
  if (msg.includes('401') || msg.toLowerCase().includes('invalid') && msg.toLowerCase().includes('license')) {
    return 'Invalid or expired license key. Please check your license in Settings.';
  }
  if (msg.includes('429') || msg.toLowerCase().includes('monthly usage')) {
    return 'Monthly usage limit reached. Resets on the 1st of next month.';
  }
  if (msg.includes('403')) {
    return msg; // pass through license / device limit messages
  }
  if (msg.match(/5\d\d/) || msg.toLowerCase().includes('server')) {
    return 'Server error — please try again in a moment.';
  }
  if (msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network') || msg.toLowerCase().includes('failed')) {
    return 'Cannot reach the server. Check your internet connection.';
  }
  return msg;
}

async function fetchWithRetry(endpoint, options, maxAttempts = 4, delayMs = 12000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(`${BACKEND_URL}${endpoint}`, options);
    } catch (e) {
      if (attempt === maxAttempts) throw new Error('Cannot reach the server. Check your internet connection.');
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    const text = await res.text();
    const isHtml = text.trimStart().startsWith('<') || text.includes('<html');

    if (isHtml || res.status === 502 || res.status === 503 || res.status === 504) {
      if (attempt === maxAttempts) {
        throw new Error('השרת לא מגיב. אנא פתח https://job-match-ai-extension.onrender.com/health בדפדפן כדי להעיר אותו, ונסה שוב.');
      }
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Server error ${res.status}: unexpected response.`);
    }

    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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

  if (req.action === 'injectContentScript') {
    chrome.scripting.executeScript({ target: { tabId: req.tabId }, files: ['content.js'] })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});
