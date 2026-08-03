const BACKEND_URL = 'https://job-match-ai-extension.onrender.com';

// ── Click tracking via chrome.alarms polling ──────────────────────────────────
// בקשת HTTP אחת בדקה במקום WebSocket - chrome.alarms מעיר את ה-service worker,
// כך שההתראות מגיעות גם אחרי שה-worker נהרג (הבעיה הקלאסית של setInterval ב-MV3).
const CLICKS_ALARM = 'jma-clicks-poll';
const CLICKS_SEEN_KEY = 'jma_clicks_seen'; // { [app_id]: מספר קליקים שכבר הותרעו }

function _ensureClicksAlarm() {
  chrome.alarms.get(CLICKS_ALARM, (a) => {
    if (!a) chrome.alarms.create(CLICKS_ALARM, { periodInMinutes: 1 });
  });
}
chrome.runtime.onInstalled.addListener(_ensureClicksAlarm);
chrome.runtime.onStartup.addListener(_ensureClicksAlarm);
_ensureClicksAlarm();

async function _pollClicks() {
  const stored = await chrome.storage.local.get(['licenseKey', 'jobTracker', CLICKS_SEEN_KEY]);
  if (!stored.licenseKey) return;

  const appIds = (stored.jobTracker || [])
    .filter(j => j.appId)
    .slice(0, 60)
    .map(j => j.appId);
  if (appIds.length === 0) return;

  let data;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000); // שרת ישן = ויתור שקט
    const res = await fetch(`${BACKEND_URL}/api/v1/clicks?app_ids=${appIds.join(',')}`, {
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return;
    data = await res.json();
  } catch { return; } // כישלון שקט - ננסה שוב בדקה הבאה

  const clicksMap = data.clicks || {};
  const seen = stored[CLICKS_SEEN_KEY] || {};
  const tracker = stored.jobTracker || [];
  let seenChanged = false;

  for (const [appId, clicks] of Object.entries(clicksMap)) {
    const prevCount = seen[appId] || 0;
    if (clicks.length <= prevCount) continue;

    const newClicks = clicks.slice(prevCount);
    seen[appId] = clicks.length;
    seenChanged = true;

    const job = tracker.find(j => j.appId === appId);
    const jobTitle = job?.jobTitle || 'המשרה';
    const company  = job?.company ? ` ב${job.company}` : '';
    const latest = newClicks[newClicks.length - 1];
    const target = latest.target === 'github' ? 'GitHub'
                 : latest.target === 'linkedin' ? 'LinkedIn' : 'Portfolio';

    // 1. התראת מערכת - מגיעה גם כשאין אף טאב רלוונטי פתוח
    chrome.notifications.create(`jma-click-${appId}-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '🎉 מגייס פתח את הקישור שלך!',
      message: `${jobTitle}${company} — נפתח קישור ${target}`,
      priority: 2,
    });

    // 2. טוסט בטאב הפעיל (ה-UX הקיים נשמר)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, {
        action: 'showClickToast', jobTitle, company: job?.company || '', target,
      }).catch(() => {});
    });

    // 3. Badge על סמל התוסף
    chrome.action.setBadgeText({ text: 'NEW' });
    chrome.action.setBadgeBackgroundColor({ color: '#EA580C' });
  }

  if (seenChanged) await chrome.storage.local.set({ [CLICKS_SEEN_KEY]: seen });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLICKS_ALARM) _pollClicks();
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
  if (lo.includes('לא הצלחנו') || lo.includes('מגבלה') || lo.includes('רישיון') || lo.includes('אימייל') || lo.includes('מגייס') || lo.includes('עובד')) return msg;
  return 'משהו השתבש. נסי שוב בעוד רגע.';
}

async function fetchWithRetry(endpoint, options, maxAttempts = 6, delayMs = 12000, timeoutMs = 90000) {
  // Render free-tier servers return 502 immediately when sleeping and take ~60s to wake.
  // We use a longer delay (25 s) specifically for sleeping-server responses so that
  // across 5 retries (5 × 25 = 125 s) the server has enough time to come online.
  const SLEEPING_DELAY_MS = 25000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res, text;
    console.log(`[JMA:fetch] ${endpoint} attempt ${attempt}/${maxAttempts}`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
  }, opts.maxAttempts || 6, opts.delayMs || 12000, opts.timeoutMs || 90000);
}

async function backendGet(endpoint, licenseKey, opts = {}) {
  return fetchWithRetry(endpoint, {
    method: 'GET',
    headers: {
      'x-license-key': licenseKey || '',
    },
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
      strategyChoices: req.strategyChoices || [],
      fitType: req.fitType || '',
    }, req.licenseKey, {
      // The CV pipeline runs 2-4 LLM calls and can legitimately take minutes — the default
      // 90s abort was killing healthy requests while the server kept working (and billing).
      // Retrying a multi-minute pipeline is expensive, so cap attempts at 2; the server is
      // reliably awake by this point (analysis stream + points calls precede generation).
      timeoutMs: 300000, maxAttempts: 2,
    })
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

  if (req.action === 'getPointsBalance') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) { sendResponse({ error: 'no license key' }); return; }
      try {
        const data = await backendGet('/api/points/balance', stored.licenseKey, { maxAttempts: 1, delayMs: 0 });
        sendResponse({ balance: data.balance ?? 0, isAdmin: !!data.isAdmin });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;
  }

  if (req.action === 'getAdminStats') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) { sendResponse({ error: friendlyError('license key') }); return; }
      try {
        const data = await backendGet('/api/admin/stats', stored.licenseKey, { maxAttempts: 1, delayMs: 0 });
        sendResponse({ result: data });
      } catch (e) {
        sendResponse({ error: friendlyError(e.message) });
      }
    });
    return true;
  }

  if (req.action === 'addRecruiter') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) { sendResponse({ error: friendlyError('license key') }); return; }
      try {
        const data = await backendPost('/api/recruiters', {
          full_name: req.fullName || '',
          email: req.email || '',
          phone: req.phone || null,
          company: req.company || '',
        }, stored.licenseKey);
        sendResponse({ result: data });
      } catch (e) {
        sendResponse({ error: friendlyError(e.message) });
      }
    });
    return true;
  }

  if (req.action === 'addEmployee') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) { sendResponse({ error: friendlyError('license key') }); return; }
      try {
        const data = await backendPost('/api/employees', {
          full_name: req.fullName || '',
          email: req.email || '',
          company: req.company || '',
        }, stored.licenseKey);
        sendResponse({ result: data });
      } catch (e) {
        sendResponse({ error: friendlyError(e.message) });
      }
    });
    return true;
  }

  if (req.action === 'searchRecruiters') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) { sendResponse({ results: [] }); return; }
      try {
        const data = await backendGet(
          `/api/recruiters/search?company=${encodeURIComponent(req.company || '')}`,
          stored.licenseKey,
          { maxAttempts: 1, delayMs: 0 }
        );
        sendResponse({ results: data.results || [] });
      } catch (e) {
        sendResponse({ results: [], error: e.message });
      }
    });
    return true;
  }

  if (req.action === 'draftRecruiterLetter') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) { sendResponse({ error: friendlyError('license key') }); return; }
      try {
        const data = await backendPost('/api/recruiter-letter', {
          jobTitle: req.jobTitle || '',
          company: req.company || '',
          jobText: req.jobText || '',
          recruiterName: req.recruiterName || '',
          cvSummary: req.cvSummary || '',
        }, stored.licenseKey, { maxAttempts: 2, delayMs: 8000 });
        sendResponse({ result: data });
      } catch (e) {
        sendResponse({ error: friendlyError(e.message) });
      }
    });
    return true;
  }

  if (req.action === 'logRecruiterEmailOpen') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) { sendResponse({ error: friendlyError('license key') }); return; }
      try {
        const data = await backendPost('/api/emails/log-open', {
          recruiter_id: req.recruiterId,
          job_url_hash: req.jobUrlHash || '',
          job_title: req.jobTitle || '',
          company: req.company || '',
        }, stored.licenseKey, { maxAttempts: 1, delayMs: 0 });
        sendResponse({ result: data });
      } catch (e) {
        sendResponse({ error: friendlyError(e.message) });
      }
    });
    return true;
  }

  if (req.action === 'checkReferral') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) { sendResponse({ available: false }); return; }
      try {
        const params = new URLSearchParams({
          company: req.company || '',
          score: String(req.score || 0),
          job_url_hash: req.jobUrlHash || '',
        });
        const data = await backendGet(`/api/referrals/check?${params.toString()}`, stored.licenseKey, { maxAttempts: 1, delayMs: 0 });
        sendResponse({ available: !!data.available, cost: data.cost ?? 5 });
      } catch (e) {
        sendResponse({ available: false, error: e.message });
      }
    });
    return true;
  }

  if (req.action === 'confirmReferral') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) { sendResponse({ error: friendlyError('license key') }); return; }
      try {
        const data = await backendPost('/api/referrals', {
          job_url_hash: req.jobUrlHash || '',
          job_title: req.jobTitle || '',
          company: req.company || '',
          score: req.score || 0,
          candidate_summary: req.candidateSummary || '',
        }, stored.licenseKey, { maxAttempts: 1, delayMs: 0 });
        sendResponse({ result: data });
      } catch (e) {
        sendResponse({ error: friendlyError(e.message) });
      }
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
    // Fetch full HTML of each job page and extract text — no Claude cost, pure browser fetch.
    //
    // This used to run DOMParser + querySelector. DOMParser does not exist in an
    // MV3 service worker, so `new DOMParser()` threw on every call and the catch
    // handed back '' — the enrichment step has been a no-op and ranking always
    // fell back to the card snippet. Reimplemented without any DOM API.
    //
    // Block tags become newlines rather than spaces: matcher.js splits the job
    // text into lines and routes each one through its requirements/advantages
    // state machine, so a flattened blob scores as if the job listed nothing.
    const HTML_ENTITIES = {
      '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
      '&#39;': "'", '&apos;': "'", '&rsquo;': '’', '&lsquo;': '‘',
      '&ldquo;': '“', '&rdquo;': '”', '&ndash;': '–', '&mdash;': '—',
      '&bull;': '•', '&middot;': '·', '&hellip;': '…',
    };

    function htmlToText(html) {
      let s = html;
      // Drop non-content subtrees wholesale.
      s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
      s = s.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
      s = s.replace(/<!--[\s\S]*?-->/g, ' ');
      // Block-level boundaries → newline, so bullets and headers stay on their own lines.
      s = s.replace(/<br\s*\/?>/gi, '\n');
      s = s.replace(/<\/(p|div|li|ul|ol|tr|section|article|h[1-6]|dd|dt|blockquote)\s*>/gi, '\n');
      s = s.replace(/<(li|tr)\b[^>]*>/gi, '\n');
      s = s.replace(/<[^>]+>/g, '');
      // Entities.
      s = s.replace(/&[a-z#0-9]+;/gi, (m) => {
        const lit = HTML_ENTITIES[m.toLowerCase()];
        if (lit !== undefined) return lit;
        const num = /^&#(\d+);$/.exec(m);
        if (num) { try { return String.fromCodePoint(+num[1]); } catch { return ' '; } }
        return ' ';
      });
      // Collapse horizontal whitespace only — never newlines.
      s = s.replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
      return s.trim();
    }

    // Prefer the slice of the page that actually reads like a job description:
    // start at the first requirements-ish heading and keep what follows.
    const DESC_ANCHOR_RE = /^\s*(?:requirements?|qualifications?|responsibilities|about the (?:role|job)|the role|what you'?ll (?:do|need)|we(?:'| a)re looking for|must have|nice to have|דרישות(?: התפקיד)?|תיאור התפקיד|מה נדרש|על התפקיד)\b/i;

    function extractJobTextFromHtml(html) {
      try {
        const text = htmlToText(html || '');
        if (!text) return '';
        const lines = text.split('\n');
        const anchor = lines.findIndex(l => DESC_ANCHOR_RE.test(l));
        // Keep ~25 lines of lead-in (title, company, location) before the anchor.
        const sliced = anchor > 0 ? lines.slice(Math.max(0, anchor - 25)).join('\n') : text;
        return sliced.substring(0, 7000);
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

  // Batch variant, emitted by the listings ranker: one request for a whole page
  // of jobs instead of a dozen round trips. Same fire-and-forget contract as
  // scrapeJob — contributing to the pool must never block or fail the UI.
  if (req.action === 'scrapeJobsBatch') {
    fetch(`${BACKEND_URL}/api/scrape-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobs: req.jobs || [] }),
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (req.action === 'importPremiumJobs') {
    chrome.storage.local.get(['licenseKey', 'cvText', 'shareJobsConsent'], async (stored) => {
      if (!stored.licenseKey || !stored.cvText) {
        sendResponse({ error: 'נדרשים רישיון וקורות חיים כדי להשתמש בפיצ\'ר זה.' });
        return;
      }
      if (!stored.shareJobsConsent) {
        sendResponse({ error: 'נדרש אישור שיתוף משרות אנונימי בהגדרות התוסף כדי לגשת לייבוא משרות.' });
        return;
      }
      sendResponse(await postForXlsx('/api/import-jobs', stored.licenseKey, {
        cvText: stored.cvText,
        minScore: req.minScore,
        timeRange: req.timeRange,
        days: req.days,
        shareJobsConsent: true,
      }));
    });
    return true;
  }

  // LINE B step 1 — the raw pool window. Scoring happens in the popup with
  // matcher.js, so no cvText is sent and no AI runs on the server.
  if (req.action === 'fetchJobsPool') {
    chrome.storage.local.get(['licenseKey', 'shareJobsConsent'], async (stored) => {
      if (!stored.licenseKey) {
        sendResponse({ error: 'נדרש רישיון כדי להשתמש בפיצ\'ר זה.' });
        return;
      }
      if (!stored.shareJobsConsent) {
        sendResponse({ error: 'נדרש אישור שיתוף משרות אנונימי בהגדרות התוסף כדי לגשת לייבוא משרות.' });
        return;
      }
      try {
        const data = await backendPost('/api/jobs-pool', {
          timeRange: req.timeRange,
          days: req.days,
          shareJobsConsent: true,
        }, stored.licenseKey);
        sendResponse({ jobs: data.jobs || [], count: data.count || 0 });
      } catch (err) {
        sendResponse({ error: friendlyError(err.message) });
      }
    });
    return true;
  }

  // LINE B step 2 — format already-scored rows as xlsx.
  if (req.action === 'exportJobsXlsx') {
    chrome.storage.local.get(['licenseKey'], async (stored) => {
      if (!stored.licenseKey) {
        sendResponse({ error: 'נדרש רישיון כדי להשתמש בפיצ\'ר זה.' });
        return;
      }
      sendResponse(await postForXlsx('/api/export-jobs-xlsx', stored.licenseKey, { rows: req.rows || [] }));
    });
    return true;
  }

  // Downloads are driven from here, not from a synthetic <a download> in the
  // popup: clicking an anchor can dismiss an MV3 popup and cancel the transfer.
  if (req.action === 'downloadFile') {
    chrome.downloads.download({ url: req.dataUrl, filename: req.filename, saveAs: false })
      .then(id => sendResponse({ ok: true, downloadId: id }))
      .catch(err => sendResponse({ error: err.message || 'ההורדה נכשלה.' }));
    return true;
  }
});

/**
 * POST a JSON body to an endpoint that answers with an .xlsx stream, and hand
 * the popup a data: URL it can pass straight to chrome.downloads.
 * Shared by both import lines.
 */
async function postForXlsx(path, licenseKey, body) {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 180000); // 3 min for big batches
    const resp = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(tid);

    if (!resp.ok) {
      let errMsg = `שגיאה ${resp.status}`;
      try { const d = await resp.json(); errMsg = d.detail || errMsg; } catch {}
      return { error: errMsg };
    }

    const bytes = new Uint8Array(await resp.arrayBuffer());
    // Convert to base64 in chunks to avoid stack overflow on large files
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return {
      dataUrl: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${btoa(binary)}`,
    };
  } catch (err) {
    return {
      error: err.name === 'AbortError'
        ? 'הייבוא לקח יותר מדי זמן. נסי שוב בעוד רגע.'
        : friendlyError(err.message),
    };
  }
}
