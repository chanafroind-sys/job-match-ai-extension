const BACKEND_URL = 'http://127.0.0.1:8000'; // Replace with your deployed server URL before release

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

async function backendPost(endpoint, body, licenseKey) {
  const res = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-license-key': licenseKey || '',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
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
