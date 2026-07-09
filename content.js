// פונקציית עזר פנימית לשליפת המערך המלא של 5 המשרות מהסטורג'
async function getRecentJobsArray() {
  const res = await chrome.storage.local.get(['jma_recent_jobs']);
  return res.jma_recent_jobs || [];
}

// 🛡️ רשימה לבנה - חייבת להיות זהה לזו שב-popup.js!
const JOB_FIELDS = [
  'url', 'jobUrl', 'jobText', 'jobTitle', 'jobPlatform', 'jobLanguage',
  'wizard_step', 'baseScore', 'bullets', 'ts', 'activelyOpened',
  'analysis', 'questions', 'answers', 'generatedCV', 'coverLetterText',
  'cvLanguage', 'gapPct'
];

function _pickJobFields(obj) {
  const out = {};
  if (!obj) return out;
  for (const k of JOB_FIELDS) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

async function saveJobState(updates) {
  // ב-content script רץ בתוך עמוד המשרה - location.href הוא ה-URL הנכון
  const url = (typeof state !== 'undefined' && state.jobUrl) ? state.jobUrl
            : (typeof location !== 'undefined' ? location.href : null);

  if (!url) return;

  let jobs = await getRecentJobsArray();
  const existingIndex = jobs.findIndex(j => j.url === url);

  let jobData = existingIndex !== -1 ? jobs[existingIndex] : { url, ts: Date.now() };
  jobData = { ...jobData, ..._pickJobFields(updates), url, ts: Date.now() };

  if (existingIndex !== -1) {
    jobs.splice(existingIndex, 1);
  }

  jobs.unshift(jobData);

  if (jobs.length > 5) {
    jobs = jobs.slice(0, 5);
  }

  await chrome.storage.local.set({ 'jma_recent_jobs': jobs });
}

async function loadJobState(url) {
  const targetUrl = url || ((typeof state !== 'undefined' && state.jobUrl) ? state.jobUrl
                 : (typeof location !== 'undefined' ? location.href : null));

  if (!targetUrl) return null;

  const jobs = await getRecentJobsArray();
  const job = jobs.find(j => j.url === targetUrl);

  if (!job) return null;

  if ((Date.now() - job.ts) > 4 * 60 * 60 * 1000) {
    const filteredJobs = jobs.filter(j => j.url !== targetUrl);
    await chrome.storage.local.set({ 'jma_recent_jobs': filteredJobs });
    return null;
  }

  return job;
}
(() => {
  // ── Job text extraction (for popup analysis) ───────────────────────────────

  const PLATFORM_SELECTORS = {
    'linkedin.com': ['.job-view-layout', '.jobs-description', '.scaffold-layout__detail', '.jobs-box__html-content'],
    'jobmaster.co.il': ['.job-description', '.job-content', '#job-description', '.jobDescription'],
    'alljobs.co.il': ['.job-inner-description', '.job-description-text', '.jobContent'],
    'indeed.com': ['#jobDescriptionText', '.jobsearch-jobDescriptionText', '.job-snippet'],
    'glassdoor.com': ['.jobDescriptionContent', '[class*="JobDescription"]', '[class*="jobDescription"]'],
    'drushim.co.il': ['.job-description', '#job-content', '.position-description'],
    'gotfriends.co.il': ['.job-desc', '.position-description', '.job-content'],
    'comeet.co': ['.position-details', '.job-description', '.position-description'],
    'hunter.io': ['.job-body', '.description-body'],
    'heyanter.com': ['.job-body', '.description-body'],
    'jobify360.co.il': ['.job-description', '.job-content', '.position-description', '[class*="job"]', 'article', 'main'],
    'jobs.nvidia.com': ['.job-description', '.position-description', '[class*="description"]', 'main', 'article'],
    'greenhouse.io': ['.job__description', '#content', '.content'],
    'lever.co': ['.section-wrapper', '.posting-content'],
    'smartrecruiters.com': ['.job-description', '[class*="description"]'],
    'workable.com': ['.job-description', '[class*="description"]'],
  };

  const GENERIC_SELECTORS = [
    'article[class*="job"]', 'main[class*="job"]',
    '[class*="job-description"]', '[class*="jobDescription"]',
    '[id*="job-description"]', '[id*="jobDescription"]',
    '[class*="position-description"]', '[class*="vacancy-description"]',
    '[class*="job-details"]', '[class*="jobDetails"]',
    'article', 'main',
    '[class*="description"]', '[class*="content"]',
    '#content', '.content',
  ];

  function detectPlatform() {
    const hostname = window.location.hostname.replace('www.', '');
    const map = {
      'linkedin.com': 'LinkedIn', 'jobmaster.co.il': 'JobMaster',
      'alljobs.co.il': 'AllJobs', 'indeed.com': 'Indeed',
      'glassdoor.com': 'Glassdoor', 'drushim.co.il': 'דרושים',
      'gotfriends.co.il': 'גוטפרנדס', 'comeet.co': 'Comeet',
      'hunter.io': 'Hunter', 'heyanter.com': 'הייאנטר',
      'jobify360.co.il': 'Jobify360', 'jobs.nvidia.com': 'NVIDIA',
      'greenhouse.io': 'Greenhouse', 'lever.co': 'Lever',
      'smartrecruiters.com': 'SmartRecruiters', 'workable.com': 'Workable',
      'jobnet.co.il': 'JobNet', 'jobs.gov.il': 'שירות התעסוקה',
    };
    for (const [domain, name] of Object.entries(map)) {
      if (hostname.includes(domain)) return name;
    }
    return hostname;
  }

  function detectLanguage(text) {
    const hebrewChars = (text.match(/[֐-׿]/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    return totalChars > 0 && (hebrewChars / totalChars) > 0.2 ? 'hebrew' : 'english';
  }

  function cleanText(text) {
    return text.replace(/\s+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractJobText() {
    const hostname = window.location.hostname.replace('www.', '');
    for (const [domain, selectors] of Object.entries(PLATFORM_SELECTORS)) {
      if (hostname.includes(domain)) {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText && el.innerText.trim().length > 100) {
            return cleanText(el.innerText).substring(0, 7000);
          }
        }
      }
    }
    for (const sel of GENERIC_SELECTORS) {
      try {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          const text = el.innerText || el.textContent || '';
          if (text.trim().length > 200) return cleanText(text).substring(0, 7000);
        }
      } catch {}
    }
    return cleanText(document.body.innerText || '').substring(0, 7000);
  }

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'triggerSidebar') {
      if (!document.getElementById('jma-float-btn')) {
        initSidebar();
      }
      setTimeout(() => {
        const sidebar = document.getElementById('jma-sidebar');
        if (sidebar && !_sidebarOpen) {
          _sidebarOpen = true;
          sidebar.classList.add('jma-open');
          startRanking();
          sendResponse({ ok: true });
        } else if (!document.getElementById('jma-float-btn')) {
          sendResponse({ error: 'לא זוהו משרות בעמוד זה' });
        }
      }, 600);
      return true;
    }

    if (req.action === 'toggleSidebar') {
      _togglePanel();
      sendResponse({ ok: true });
    }

    if (req.action === 'preflightQuickScore') {
      // Stage-1 result: cheap fast score + reason bullets — show IMMEDIATELY
      clearInterval(_fabProgressTimer);
      _fabState = 'quick_ready';
      _updateFabArc(req.score, true);
      const wrap = document.getElementById('jma-fab-wrap');
      if (wrap) { wrap.classList.remove('jma-fab-loading'); wrap.classList.add('jma-fab-ready'); }
      const inner = document.getElementById('jma-fab-inner');
      if (inner) {
        const color = req.score >= 75 ? '#3fb950' : req.score >= 55 ? '#d29922' : req.score >= 35 ? '#e3812b' : '#f85149';
        inner.innerHTML = `
          <span class="jma-fab-score-num" style="color:${color}">${req.score}</span>
          <span class="jma-fab-score-pct">%</span>
          <span class="jma-fab-score-lbl">▶ ניתוח מעמיק</span>`;
      }
      if (req.bullets && req.bullets.length > 0) _showFabReasons(req.bullets);
    }

    if (req.action === 'preflightDone') {
      _fabSetScore(req.score);
      document.getElementById('jma-fab-reasons')?.remove();
      // Do NOT auto-open panel — user clicks FAB to open when ready
    }

    if (req.action === 'preflightError') {
      clearInterval(_fabProgressTimer);
      _fabState = 'idle';
      _updateFabArc(0, false);
      document.getElementById('jma-fab-reasons')?.remove();
      const inner = document.getElementById('jma-fab-inner');
      if (inner) inner.innerHTML = '<span class="jma-fab-icon">⚡</span><span class="jma-fab-text">בדיקה<br>מהירה</span>';
    }

    if (req.action === 'updateFabScore') {
      // Always update arc; if FAB is showing score text, update the number too
      _updateFabArc(req.score, true);
      const inner = document.getElementById('jma-fab-inner');
      const numEl = inner?.querySelector('.jma-fab-score-num');
      if (numEl) {
        const color = req.score >= 75 ? '#3fb950' : req.score >= 55 ? '#d29922' : req.score >= 35 ? '#e3812b' : '#f85149';
        numEl.style.color = color;
        numEl.textContent = req.score;
      }
    }

    if (req.action === 'openAnalysisPanel') {
      _openAnalysisPanel();
    }

    if (req.action === 'analysisEvent') {
      _handleAnalysisEvent(req.evt);
    }

    if (req.action === 'showClickToast') {
      _showToast(req.jobTitle, req.company, req.target);
    }

    if (req.action === 'getJobText') {
      const text = extractJobText();
      // Try to extract a clean job title from the page
      const h1 = document.querySelector('h1')?.innerText?.trim() || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim() || '';
      sendResponse({
        text,
        language: detectLanguage(text),
        platform: detectPlatform(),
        url: window.location.href,
        title: document.title,
        h1Title: h1,
        ogTitle,
      });
    }

    if (req.action === 'runFabPipeline') {
      runFabPipeline()
        .then(res => sendResponse(res || { ok: true }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // async response
    }
    return true;
  });

  // ── Sidebar: Job listing page ranking ─────────────────────────────────────

  const CARD_CONFIGS = {
    'linkedin.com': {
      cards: '.jobs-search-results__list-item, .job-card-container--clickable',
      title: '.job-card-list__title--link strong, .job-card-container__link strong, .job-card-list__title',
      company: '.job-card-container__primary-description, .artdeco-entity-lockup__subtitle span',
      snippet: '.job-card-list__footer-wrapper',
    },
    'indeed.com': {
      cards: '.job_seen_beacon, .resultContent',
      title: '.jobTitle span[title], .jobTitle a span',
      company: '.companyName',
      snippet: '.job-snippet',
    },
    'glassdoor.com': {
      cards: '[class*="JobCard_jobCard"], [data-test="jobListing"]',
      title: '[class*="JobCard_jobTitle"], [data-test="job-title"]',
      company: '[class*="EmployerProfile_employerName"], [data-test="employer-short-name"]',
      snippet: '[class*="JobCard_location"]',
    },
    'jobs.nvidia.com': {
      cards: '[class*="position"], tr[class*="job"], [data-ph-at-id]',
      title: 'h3 a, [class*="title"] a, a[class*="job"]',
      company: null,
      snippet: '[class*="location"], [class*="department"]',
    },
    'greenhouse.io': { cards: '.opening', title: '.opening a', company: null, snippet: '.location' },
    'lever.co': { cards: '.posting', title: '.posting-title h5', company: null, snippet: '.posting-categories .sort-by-team' },
    'jobmaster.co.il': { cards: '[class*="job-item"], [class*="jobItem"], li[class*="job"]', title: '[class*="job-title"], h2 a, h3 a', company: '[class*="company"]', snippet: '[class*="snippet"]' },
    'alljobs.co.il': { cards: '.job-item, [class*="job-box"]', title: '.job-title a, h2 a', company: '.company-name', snippet: '.job-description-short' },
    'drushim.co.il': { cards: '[class*="job-item"], .job-box', title: '.job-title, h3 a', company: '.company-name', snippet: '.job-brief' },
  };

  // ── Single-job-page circular FAB + injected sidebar panel ────────────────

  // Build a minimal profile stub from raw CV text for users without a jma_user_profile yet.
  // Accuracy is lower than the AI-extracted version but good enough as a fallback.
  function _profileFromCvText(cvText) {
    const lo = (cvText || '').toLowerCase();
    const TECH_DOMAIN_LOCAL = {
      java:'backend','c#':'backend','.net':'backend',python:'backend',ruby:'backend',
      go:'backend',golang:'backend',rust:'backend',php:'backend',scala:'backend',
      kotlin:'backend','node.js':'backend',nodejs:'backend',
      react:'frontend','vue':'frontend',angular:'frontend','next.js':'frontend',
      nextjs:'frontend',javascript:'frontend',typescript:'frontend',
      tensorflow:'ai_ml_llm',pytorch:'ai_ml_llm','machine learning':'ai_ml_llm',
      spark:'data_bi',sql:'data_bi',postgresql:'data_bi',pandas:'data_bi',
      docker:'devops_cloud',kubernetes:'devops_cloud',aws:'devops_cloud',
      azure:'devops_cloud',gcp:'devops_cloud',terraform:'devops_cloud',
      swift:'mobile',flutter:'mobile','react native':'mobile',android:'mobile',
    };
    const totalMatch = lo.match(/(\d+)\+?\s*years?\s*(?:of\s*)?(?:professional\s*)?experience/i)
                    || lo.match(/(\d+)\s*שנות?\s*ניסיון/i);
    const totalYears = totalMatch ? parseFloat(totalMatch[1]) : 0;

    const exp = { backend:{}, frontend:{}, ai_ml_llm:{}, data_bi:{}, devops_cloud:{}, mobile:{}, other_domains:{} };
    const domainYears = {};

    for (const [tech, domain] of Object.entries(TECH_DOMAIN_LOCAL)) {
      const escaped = tech.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?<![a-z0-9])' + escaped + '(?![a-z0-9])', 'i');
      if (!re.test(lo)) continue;
      // Try to find a year near the tech
      const idx = lo.search(re);
      const win = lo.slice(Math.max(0, idx - 150), idx + 150);
      const ym = win.match(/(\d+(?:\.\d+)?)\s*(?:\+)?\s*(?:years?|yrs?|שנות?)/i);
      const yrs = ym ? parseFloat(ym[1]) : (totalYears > 0 ? Math.round(totalYears * 0.5 * 10) / 10 : 1.0);
      exp[domain][tech] = { industry_years: yrs, personal_years: 0, personal_weight: 0 };
      domainYears[domain] = (domainYears[domain] || 0) + yrs;
    }

    return {
      industry_summary: { total_years_industry: totalYears, domain_years: domainYears },
      traits: [],
      experience: exp,
      tools_and_methods: {},
      languages: {},
      _isFallback: true,
    };
  }

  function _urlHash(url) {
    let h = 0;
    for (let i = 0; i < (url || '').length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }
  function _prefKey(url)         { return `jma_pf_${_urlHash(url)}`; }
  function _autoStreamKey(url)   { return `jma_auto_stream_${_urlHash(url)}`; }
  function _jobTextKey(url)      { return `jma_job_text_${_urlHash(url)}`; }
  function _localScoreKey(url)   { return `jma_local_score_${_urlHash(url)}`; }
  function _localBulletsKey(url) { return `jma_local_bullets_${_urlHash(url)}`; }

  // FAB state: 'idle' | 'loading' | 'ready'
  let _fabState = 'idle';
  let _fabProgress = 0;
  let _fabProgressTimer = null;
  let _panelOpen = false;
  const FAB_CIRC = 207.3; // 2π×33

  // ref ל-runFabPipeline של ה-FAB הפעיל הנוכחי, כדי שגם onMessage (מחוץ ל-scope
  // של _createFabGauge) יוכל להפעיל אותה כשמגיעה הודעה מהפופ-אפ.
  let runFabPipeline = null;

  // שער קשיח: ה-FAB מופיע רק אם בטקסט יש סימן מובהק לסעיף דרישות/תפקיד
  const REQUIREMENTS_SIGNALS = [
    // עברית
    'דרישות התפקיד', 'דרישות המשרה', 'דרישות:', 'כישורים נדרשים', 'ניסיון נדרש',
    'תיאור המשרה', 'על התפקיד', 'תחומי אחריות', 'יתרון משמעותי', 'חובה:',
    // אנגלית (הטקסט מנורמל לגרש ישר לפני ההשוואה)
    'requirements', 'qualifications', "what you'll need", "what we're looking for",
    "what you'll do", 'the role', 'about the role', 'responsibilities',
    'must have', 'nice to have', 'we are looking for', 'bonus points', 'skills',
  ];
  function _hasJobRequirementsSignal(text) {
    // נרמול גרשיים טיפוגרפיים (' ') לגרש ישר - "What We're" מגיע לרוב עם ’
    const lo = (text || '').toLowerCase().replace(/[‘’]/g, "'");
    return REQUIREMENTS_SIGNALS.some(sig => lo.includes(sig));
  }
function initJobFab() {
  if (document.getElementById('jma-float-btn')) return; 
  if (document.getElementById('jma-fab-wrap')) return;
  if (!pageHasJobKeywords() && !_hasJobRequirementsSignal(document.body.innerText || '')) return;
  const jobText = extractJobText();
  if (!jobText || jobText.length < 350) return;

  if (!_hasJobRequirementsSignal(jobText)) return; // אין סעיף דרישות - לא עמוד משרה מלא

  // עמוד משרה מאומת: מעירים את השרת + שומרים את המשרה למאגר (השרת מסנן כפילויות לפי URL)
  chrome.runtime.sendMessage({ action: 'pingBackend' });
  chrome.runtime.sendMessage({
    action: 'scrapeJob',
    url: location.href,
    text: jobText.substring(0, 5000),
    title: document.title || '',
  });

  chrome.storage.local.get(['licenseKey', 'cvText', 'jma_recent_jobs'], (conf) => {
    if (!conf.licenseKey || !conf.cvText) return;

    // שליפת המשרה הנוכחית מתוך המערך המאוחד
    const recentJobs = conf.jma_recent_jobs || [];
    const cachedJob = recentJobs.find(j => j.url === location.href);

    // תוקף של 10 דקות לחישוב מקומי
    const isFresh = cachedJob && cachedJob.ts && (Date.now() - cachedJob.ts) < 10 * 60 * 1000;

    // מעבירים את הנתונים השמורים (אם ישנם וטריים) לתוך ה-Gauge
    _createFabGauge(jobText, isFresh ? cachedJob : null);
  });
}
  // function initJobFab() {
  //   if (document.getElementById('jma-float-btn')) return; // listing page has own FAB
  //   if (document.getElementById('jma-fab-wrap')) return;
  //   if (!pageHasJobKeywords()) return; // must look like a job page
  //   const jobText = extractJobText();
  //   if (!jobText || jobText.length < 350) return;
  //   chrome.storage.local.get(['licenseKey', 'cvText', 'jma_user_profile'], (conf) => {
  //     if (!conf.licenseKey || !conf.cvText) return;
  //     const cKey = _prefKey(location.href);
  //     chrome.storage.local.get([cKey], (stored) => {
  //       const cached = stored[cKey];
  //       const fresh = cached && (Date.now() - cached.ts) < 10 * 60 * 1000;
  //       _createFabGauge(jobText, fresh ? cached : null);
  //     });
  //   });
  // }
function _createFabGauge(jobText, cached) {
  // 1. הזרקת ה-CSS - שימי לב שהאפקטים של הכפתור (Hover ו-Active) יפעלו רק כשיש את הקלאס .jma-fab-clickable
  const fabStyle = document.createElement('style');
  fabStyle.innerHTML = `
    /* המצב ההתחלתי: עיגול תצוגה רגיל, לא מגיב לעכבר כפתור */
    #jma-fab-wrap {
      background: radial-gradient(circle at 40% 35%, #A78BFA 0%, #5B21B6 100%) !important;
      border-radius: 50% !important;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15) !important;
      transition: all 0.3s ease-in-out !important;
      cursor: default !important; /* לא מראה סימן של יד לחיצה בהתחלה */
    }

    /* 🔥 מצב כפתור אקטיבי: מופעל רק אחרי שהניתוח עלה והאחוזים מוכנים! */
    #jma-fab-wrap.jma-fab-clickable {
      cursor: pointer !important; /* הופך ליד לחיצה */
      box-shadow: 0 5px 16px rgba(91, 33, 182, 0.45), inset 0 2px 4px rgba(255, 255, 255, 0.3) !important;
    }

    /* אפקט ריחוף - יעבוד רק כשהכפתור במצב לחיץ */
    #jma-fab-wrap.jma-fab-clickable:hover {
      transform: scale(1.08) translateY(-3px) !important;
      box-shadow: 0 8px 24px rgba(91, 33, 182, 0.65), inset 0 2px 4px rgba(255, 255, 255, 0.4) !important;
      filter: brightness(1.1);
    }

    /* אפקט לחיצה פיזי - יעבוד רק כשהכפתור במצב לחיץ */
    #jma-fab-wrap.jma-fab-clickable:active {
      transform: scale(0.95) translateY(-1px) !important;
      box-shadow: 0 3px 8px rgba(91, 33, 182, 0.4) !important;
    }

    /* סידור אלמנטים פנימיים */
    .jma-fab-score-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #ffffff;
      font-family: system-ui, sans-serif;
      line-height: 1.15;
    }

    .jma-fab-score-num {
      font-size: 22px !important;
      font-weight: 800 !important;
      text-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }

    .jma-fab-score-lbl {
      font-size: 9px !important;
      font-weight: bold !important;
      white-space: nowrap;
      opacity: 0.95;
      margin-top: 2px;
      background: rgba(255, 255, 255, 0.2);
      padding: 1px 5px;
      border-radius: 10px;
    }
  `;
  document.head.appendChild(fabStyle);

  if (typeof injectStyles === 'function') injectStyles();

  const wrap = document.createElement('div');
  wrap.id = 'jma-fab-wrap';
  wrap.innerHTML = `
    <svg viewBox="0 0 84 84" width="84" height="84">
      <defs>
        <radialGradient id="jma-grad" cx="40%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#A78BFA"/>
          <stop offset="100%" stop-color="#5B21B6"/>
        </radialGradient>
      </defs>
      <circle class="jma-fab-bg" cx="42" cy="42" r="41"/>
      <circle class="jma-fab-track" cx="42" cy="42" r="33"/>
      <circle class="jma-fab-arc" id="jma-fab-arc" cx="42" cy="42" r="33"/>
    </svg>
    <div class="jma-fab-inner" id="jma-fab-inner">
      <span class="jma-fab-icon">⚡</span>
      <span class="jma-fab-text">בדיקה<br>מהירה</span>
    </div>`;
  document.body.appendChild(wrap);

  // פונקציה שהופכת את העיגול לכפתור לחיץ משתנה רק בסיום הניתוח
  function _activateFabButton(score) {
    _fabState = 'quick_ready';
    wrap.classList.remove('jma-fab-loading');
    wrap.classList.add('jma-fab-ready');
    
    // 🔥 הוספת הקלאס שמפעיל את ה-Hover, ה-Active ומשנה את ה-cursor ללחיץ
    wrap.classList.add('jma-fab-clickable'); 
    
    const inner2 = document.getElementById('jma-fab-inner');
    if (inner2) {
      inner2.innerHTML = `
        <div class="jma-fab-score-container">
          <span class="jma-fab-score-num">${score}%</span>
          <span class="jma-fab-score-lbl">התאמה מעמיקה ➔</span>
        </div>`;
    }
  }

  if (cached && cached.baseScore != null && cached.baseScore > 0) {
    _fabSetScore(cached.baseScore);
    _activateFabButton(cached.baseScore);
} else {
    chrome.storage.local.get(['jma_user_profile', 'cvText'], async (s) => {
      if (!window.JMA_Matcher) return;
      let profile = s.jma_user_profile || null;
      if (!profile && s.cvText) {
        profile = _profileFromCvText(s.cvText);
      }
      if (!profile) return;
      
      const { score, bullets } = window.JMA_Matcher.computeScore(profile, jobText);
      _updateFabArc(score, true);

      // 🔥 שמירה זמנית במשתנים בקובץ (לא בסטורג') עד לרגע הלחיצה האקטיבית!
      window.jma_current_score = score;
      window.jma_current_bullets = bullets;
      
      if (bullets.length > 0) {
        setTimeout(() => _showFabReasons(bullets), 600);
      }

      setTimeout(() => {
        _activateFabButton(score);
      }, 700); 
    });
  }
  // הצינור המלא של ה-FAB: חילוץ → ציון מקומי → שמירה מלאה ל-storage.
  // משמש גם את לחיצת ה-FAB וגם את כפתור "ניתוח והתאמה מעמיקה" בפופ-אפ.
  runFabPipeline = async function () {
    const currentUrl = window.location.href;
    const extractedText = extractJobText();

    // ── אסטרטגיית חילוץ כותרת דינמית (מתוך ה-onMessage שלך) ──────────────────
    const getJobTitle = () => {
      const h1 = document.querySelector('h1')?.innerText?.trim() || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim() || '';
    
      const rawTitle = h1 || ogTitle || document.title || 'משרה ללא כותרת';
    
      // ניקוי סיומות מיותרות מהכותרת (למשל: "מפתח תוכנה - LinkedIn")
      if (typeof _cleanPageTitle === 'function') {
        return _cleanPageTitle(rawTitle);
      }
      return rawTitle.split(/[|•\-–]/)[0].trim();
    };

    // ── אסטרטגיית חילוץ פלטפורמה דינמית ──────────────────────────────────────
    const getJobPlatform = () => {
      if (typeof detectPlatform === 'function') {
        return detectPlatform();
      }
      const metaSiteName = document.querySelector('meta[property="og:site_name"]')?.content;
      if (metaSiteName) return metaSiteName.trim();

      const host = window.location.hostname;
      const parts = host.replace('www.', '').split('.');
      if (parts.length >= 2) {
        return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      }
      return host;
    };

    // ── זיהוי שפה ואסימילציה של הנתונים ──────────────────────────────────────
    const jobLanguage = (typeof detectLanguage === 'function') 
      ? detectLanguage(extractedText) 
      : (/[\u0590-\u05FF]/.test(extractedText.substring(0, 300)) ? 'hebrew' : 'english');

    // שליפת הציון והבולטים הקיים שנשמרו זמנית על ה-window בחלק הפסיבי
    const finalScore = window.jma_current_score || (cached ? cached.baseScore : 0);
    const finalBullets = window.jma_current_bullets || (cached ? cached.bullets : []);

    // 🎯 2. בניית אובייקט ה-state המלא והמאוחד למשרה הנוכחית
    const fullJobState = {
      url: currentUrl,          // מפתח הזיהוי בתוך המערך המאוחד
      jobUrl: currentUrl,
      jobText: extractedText,
      jobTitle: getJobTitle(),
      jobPlatform: getJobPlatform(),
      jobLanguage: jobLanguage,
      wizard_step: 'questions', // מעביר את הפופ-אפ ישירות למסך השאלות
      baseScore: finalScore,
      bullets: finalBullets,
      ts: Date.now(),
      activelyOpened: true,      // דגל מסמן: נפתח אקטיבית ע"י המשתמש!
      analysis: cached?.analysis || null,
      questions: cached?.questions || [],
      answers: cached?.answers || [],
      generatedCV: cached?.generatedCV || '',
      gapPct: cached?.gapPct || 0
    };

    try {
      // 📦 3. שמירה אקטיבית ומרוכזת לתוך מערך 5 המשרות ב-Storage
      if (typeof saveJobState === 'function') {
        await saveJobState(fullJobState);
      } else {
        // פתרון גיבוי ישיר במידה ו-saveJobState לא נגישה באותו הסקופ
        const storageData = await chrome.storage.local.get('jma_recent_jobs');
        let recentJobs = storageData.jma_recent_jobs || [];
        recentJobs = recentJobs.filter(j => j.url !== currentUrl);
        recentJobs.unshift(fullJobState);
        if (recentJobs.length > 5) recentJobs.pop();
        await chrome.storage.local.set({ jma_recent_jobs: recentJobs });
      }

      // 🔄 4. עדכון משתנה הסטייט הלוקאלי המקומי (אם קיים בסקופ הקובץ)
      if (typeof state !== 'undefined') {
        Object.assign(state, fullJobState);
      }
    } catch (err) {
      console.error("⚠️ שגיאה בשמירת נתוני המשרה בסטורג':", err);
    }

    return { ok: true, baseScore: finalScore };
  };

wrap.addEventListener('click', async () => {
  // 1. הגנה: מאפשר לחיצה רק אם הכפתור מוכן (clickable)
  if (!wrap.classList.contains('jma-fab-clickable')) return;

  await runFabPipeline();

  // 🚀 5. פתיחת הפאנל הצדדי/סידבר למשתמש
  if (typeof _togglePanel === 'function') {
    _togglePanel();
  } else if (typeof initSidebar === 'function') {
    initSidebar();
  }
});
  // לוגיקת הלחיצה - תעבוד רק אם הכפתור כבר סומן כבלחיץ ( clickable )
  // wrap.addEventListener('click', () => {

      // const currentStep = res[`wizard_step_${currentUrl}`];
      // const questionsAnalyzed = res[`questions_analyzed_${currentUrl}`];

      // if (currentStep === 'analysis' || currentStep === 'settings' || questionsAnalyzed) {
      //   _togglePanel(); 
      // } else {
      //   chrome.storage.local.set({
      //     [_autoStreamKey(currentUrl)]: true,
      //     [_jobTextKey(currentUrl)]: extractJobText(),
      //     [`wizard_step_${currentUrl}`]: 'questions'
      //   }, () => {
      //     _togglePanel();
      //   });
      // }
    // });
  // });
}
  // function _createFabGauge(jobText, cached) {
  //   injectStyles();
  //   const wrap = document.createElement('div');
  //   wrap.id = 'jma-fab-wrap';
  //   wrap.innerHTML = `
  //     <svg viewBox="0 0 84 84" width="84" height="84">
  //       <defs>
  //         <radialGradient id="jma-grad" cx="40%" cy="35%" r="65%">
  //           <stop offset="0%" stop-color="#A78BFA"/>
  //           <stop offset="100%" stop-color="#5B21B6"/>
  //         </radialGradient>
  //       </defs>
  //       <circle class="jma-fab-bg" cx="42" cy="42" r="41"/>
  //       <circle class="jma-fab-track" cx="42" cy="42" r="33"/>
  //       <circle class="jma-fab-arc" id="jma-fab-arc" cx="42" cy="42" r="33"/>
  //     </svg>
  //     <div class="jma-fab-inner" id="jma-fab-inner">
  //       <span class="jma-fab-icon">⚡</span>
  //       <span class="jma-fab-text">בדיקה<br>מהירה</span>
  //     </div>`;
  //   document.body.appendChild(wrap);

  //   if (cached && cached.base_score != null) {
  //     // Preflight cache already has a full AI score — use it directly
  //     _fabSetScore(cached.base_score);
  //   } else {
  //     // ── Stage A: run local matcher immediately, zero network cost ───────
  //     // Uses the AI-extracted profile (jma_user_profile) when available.
  //     // Falls back to a stub profile built from raw cvText for users who haven't re-saved yet.
  //     chrome.storage.local.get(['jma_user_profile', 'cvText'], (s) => {
  //       if (!window.JMA_Matcher) return;
  //       let profile = s.jma_user_profile || null;
  //       if (!profile && s.cvText) {
  //         // Minimal stub so the matcher has something to work with
  //         profile = _profileFromCvText(s.cvText);
  //       }
  //       if (!profile) return;
  //       const { score, bullets } = window.JMA_Matcher.computeScore(profile, jobText);
  //       _fabState = 'quick_ready';
  //       _updateFabArc(score, true);
  //       wrap.classList.remove('jma-fab-loading');
  //       wrap.classList.add('jma-fab-ready');
  //       const inner2 = document.getElementById('jma-fab-inner');
  //       if (inner2) {
  //         const color = score >= 75 ? '#3fb950' : score >= 55 ? '#d29922' : score >= 35 ? '#e3812b' : '#f85149';
  //         inner2.innerHTML = `
  //           <span class="jma-fab-score-num" style="color:${color}">${score}</span>
  //           <span class="jma-fab-score-pct">%</span>
  //           <span class="jma-fab-score-lbl">▶ ניתוח מעמיק</span>`;
  //       }
  //       // Persist local score so popup can read it as initial baseScore
  //       chrome.storage.local.set({
  //         [_localScoreKey(location.href)]:   score,
  //         [_localBulletsKey(location.href)]: bullets,
  //       });
  //       // Show reason pills briefly (staggered fade-in)
  //       if (bullets.length > 0) setTimeout(() => _showFabReasons(bullets), 600);
  //     });
  //   }

  //   wrap.addEventListener('click', () => {
  //     if (_fabState === 'quick_ready') {
  //       // Open popup → auto-start streaming questions immediately
  //       chrome.storage.local.set({
  //         [_autoStreamKey(location.href)]: true,
  //         [_jobTextKey(location.href)]:    extractJobText(),
  //       });
  //       _togglePanel();
  //     } else {
  //       // 'idle', 'loading', or 'ready' → just toggle panel
  //       _togglePanel();
  //     }
  //   });
  // }

  function _fabStartProgress() {
    _fabProgress = 5;
    _updateFabArc(_fabProgress, false);
    const wrap = document.getElementById('jma-fab-wrap');
    if (wrap) wrap.classList.add('jma-fab-loading');
    const inner = document.getElementById('jma-fab-inner');
    if (inner) inner.innerHTML = '<span class="jma-fab-text" style="font-size:10px">מנתח...<br>⏳</span>';
    clearInterval(_fabProgressTimer);
    _fabProgressTimer = setInterval(() => {
      if (_fabProgress >= 87) return;
      const step = _fabProgress < 40 ? 3 : _fabProgress < 70 ? 1.2 : 0.4;
      _fabProgress = Math.min(87, _fabProgress + step);
      _updateFabArc(_fabProgress, false);
    }, 380);
  }

  function _fabSetScore(score) {
    clearInterval(_fabProgressTimer);
    _fabState = 'ready';
    _updateFabArc(score, true);
    const wrap = document.getElementById('jma-fab-wrap');
    if (wrap) wrap.classList.add('jma-fab-ready');
    const inner = document.getElementById('jma-fab-inner');
    if (inner) {
      const color = score >= 75 ? '#3fb950' : score >= 55 ? '#d29922' : score >= 35 ? '#e3812b' : '#f85149';
      inner.innerHTML = `
        <span class="jma-fab-score-num" style="color:${color}">${score}</span>
        <span class="jma-fab-score-pct">%</span>
        <span class="jma-fab-score-lbl">התאמה</span>`;
    }
  }

  function _updateFabArc(pct, colorByScore) {
    const arc = document.getElementById('jma-fab-arc');
    if (!arc) return;
    arc.style.strokeDashoffset = FAB_CIRC - (pct / 100) * FAB_CIRC;
    if (colorByScore) {
      arc.style.stroke = pct >= 75 ? '#3fb950' : pct >= 55 ? '#d29922' : pct >= 35 ? '#e3812b' : '#f85149';
    }
  }

  function _showToast(jobTitle, company, target) {
    document.getElementById('jma-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'jma-toast';
    toast.className = 'jma-toast';
    const companyStr = company ? ` בחברת <strong>${escHtml(company)}</strong>` : '';
    toast.innerHTML = `
      <div class="jma-toast-flame">🔥</div>
      <div class="jma-toast-body">
        <div class="jma-toast-title">מגייס מגלה עניין עכשיו!</div>
        <div class="jma-toast-sub">קורות החיים עבור <strong>${escHtml(jobTitle)}</strong>${companyStr} נפתחו ב-${escHtml(target)}</div>
      </div>
      <button class="jma-toast-x" title="סגור">✕</button>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('jma-toast-in'));
    toast.querySelector('.jma-toast-x').addEventListener('click', () => toast.remove());
    setTimeout(() => document.getElementById('jma-toast')?.remove(), 13000);
  }

  function _showFabReasons(bullets) {
    document.getElementById('jma-fab-reasons')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'jma-fab-reasons';
    document.body.appendChild(wrap);
    bullets.forEach((b, i) => {
      setTimeout(() => {
        if (!document.getElementById('jma-fab-reasons')) return;
        const pill = document.createElement('div');
        pill.className = 'jma-fab-reason-pill';
        pill.textContent = b;
        wrap.appendChild(pill);
        requestAnimationFrame(() => pill.classList.add('jma-fab-reason-in'));
      }, i * 190);
    });
    // Auto-dismiss after 8 s
    setTimeout(() => wrap.remove(), 8000);
  }

  // ── Injected sidebar panel (contains popup.html as iframe) ────────────────

  function _ensurePanel() {
    if (document.getElementById('jma-panel')) return;
    injectStyles();
    const panel = document.createElement('div');
    panel.id = 'jma-panel';

    // ── Collapse / expand grab tab on the left edge of the panel ────────
    const tab = document.createElement('button');
    tab.id = 'jma-panel-tab';
    tab.setAttribute('aria-label', 'כווץ/הרחב פאנל');
    tab.innerHTML = `
      <span class="jma-tab-arrow">◀</span>
      <span class="jma-tab-dots">
        <span class="jma-tab-dot"></span>
        <span class="jma-tab-dot"></span>
        <span class="jma-tab-dot"></span>
      </span>`;
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      _togglePanel();
      const arrow = tab.querySelector('.jma-tab-arrow');
      // ▶ when open (click closes), ◀ when closed (click opens)
      if (arrow) arrow.textContent = _panelOpen ? '▶' : '◀';
    });
    panel.appendChild(tab);

    const iframe = document.createElement('iframe');
    iframe.id = 'jma-panel-iframe';
    iframe.src = chrome.runtime.getURL('popup.html');
    iframe.setAttribute('allowtransparency', 'true');
    panel.appendChild(iframe);
    document.body.appendChild(panel);
  }

  function _togglePanel() {
    _ensurePanel();
    _panelOpen = !_panelOpen;
    const panel = document.getElementById('jma-panel');
    if (panel) panel.classList.toggle('jma-panel-open', _panelOpen);
    if (_panelOpen) document.getElementById('jma-fab-reasons')?.remove();
  }

  // Keywords that indicate a job listing page — checked locally, zero API cost
  const JOB_KEYWORDS_HE = ['משרה', 'משרות', 'תפקיד', 'דרישות', 'ניסיון', 'קו"ח', 'גיוס', 'פיתוח', 'מפתח', 'הגש'];
  const JOB_KEYWORDS_EN = ['job', 'position', 'vacancy', 'career', 'apply', 'requirements', 'experience', 'hiring', 'full-time', 'part-time', 'salary'];

  function pageHasJobKeywords() {
    const text = (document.body.innerText || '').toLowerCase();
    const heCount = JOB_KEYWORDS_HE.filter(kw => text.includes(kw)).length;
    const enCount = JOB_KEYWORDS_EN.filter(kw => text.includes(kw)).length;
    return heCount >= 2 || enCount >= 3;
  }

  // Structural CSS selectors — ordered from precise to generic
  const GENERIC_CARD_SELECTORS = [
    // Explicit job semantics
    '[class*="job-card"]', '[class*="jobCard"]', '[class*="job-listing"]',
    '[class*="job-item"]', '[class*="jobItem"]', '[class*="job-result"]',
    '[class*="position-item"]', '[class*="vacancy-item"]', '[class*="vacancy-card"]',
    '[class*="opening-item"]', '[class*="opening"]',
    '[data-job-id]', '[data-jobid]', '[data-position-id]',
    'li[class*="position"]', 'li[class*="job"]',
    'article[class*="job"]', 'article[class*="position"]',
    // Common ATS patterns
    'tr.job', 'tr[class*="job"]', 'tr[class*="position"]',
    '.posting', '[class*="posting-item"]',
    '[class*="result-card"]', '[class*="resultCard"]',
  ];

  function getCardConfig() {
    const host = window.location.hostname.replace('www.', '');
    for (const [domain, cfg] of Object.entries(CARD_CONFIGS)) {
      if (host.includes(domain)) return cfg;
    }
    return null;
  }

  // Last-resort: find repeated same-class elements that each contain a link
  function findRepeatedLinkContainers() {
    const candidates = [
      ...document.querySelectorAll('li'),
      ...document.querySelectorAll('article'),
      ...document.querySelectorAll('div[class*="card"]'),
      ...document.querySelectorAll('div[class*="item"]'),
      ...document.querySelectorAll('div[class*="result"]'),
      ...document.querySelectorAll('div[class*="listing"]'),
    ];
    const groups = {};
    for (const el of candidates) {
      const key = el.tagName + '|' + el.className;
      if (!key || key.length < 5) continue;
      groups[key] = groups[key] || [];
      groups[key].push(el);
    }
    for (const els of Object.values(groups)) {
      if (els.length < 3 || els.length > 150) continue;
      // Require substantial text — nav/UI items are short; real job cards have descriptions
      const withContent = els.filter(el => {
        const text = (el.innerText || el.textContent || '').trim();
        return text.length > 60 && el.querySelector('a');
      });
      if (withContent.length >= 3) return withContent;
    }
    return null;
  }

  function detectJobCards() {
    // 1. Known platform — precise selectors
    const cfg = getCardConfig();
    if (cfg) {
      const cards = document.querySelectorAll(cfg.cards);
      if (cards.length >= 2) return { cards: Array.from(cards), cfg };
    }

    // 2. Generic structural selectors
    for (const sel of GENERIC_CARD_SELECTORS) {
      try {
        const cards = document.querySelectorAll(sel);
        if (cards.length >= 2) return { cards: Array.from(cards), cfg: null };
      } catch {}
    }

    // 3. Pattern-based: repeated containers with links, but ONLY if page has job keywords
    if (pageHasJobKeywords()) {
      const els = findRepeatedLinkContainers();
      if (els) return { cards: els, cfg: null };
    }

    return null;
  }

  function extractJobsFromCards(cards, cfg) {
    return cards.slice(0, 12).map((card, i) => {
      let title = '', company = '', snippet = '';
      if (cfg) {
        if (cfg.title) { const el = card.querySelector(cfg.title); title = el ? el.textContent.trim() : ''; }
        if (cfg.company) { const el = card.querySelector(cfg.company); company = el ? el.textContent.trim() : ''; }
        if (cfg.snippet) { const el = card.querySelector(cfg.snippet); snippet = el ? el.textContent.trim().substring(0, 150) : ''; }
      }
      if (!title) {
        const h = card.querySelector('h2, h3, h4, a[class*="title"], [class*="title"] a');
        title = h ? h.textContent.trim() : card.textContent.trim().substring(0, 80);
      }
      if (!company) {
        const c = card.querySelector('[class*="company"], [class*="employer"]');
        company = c ? c.textContent.trim().substring(0, 60) : '';
      }
      // Extract job URL for full-text background fetch
      const link = card.querySelector('a[href]');
      const href = link ? link.href : '';

      // Capture full card text as reliable fallback
      const cardText = (card.innerText || card.textContent || '').trim().replace(/\s+/g,' ').substring(0, 500);

      return { index: i, title: title.substring(0, 100), company: company.substring(0, 60), snippet: snippet.substring(0, 200), href, cardText };
    })
    .filter(j => {
      if (j.title.length < 5) return false;
      // Skip UI action items (short titles that are verbs/buttons)
      const UI_ACTIONS = /^(עדכן|הוסף|חדש|מחק|שמור|בטל|צור|הגש|קרא|פתח|update|add|new|delete|save|cancel|submit|apply|sign|log|register|view|read)/i;
      if (UI_ACTIONS.test(j.title.trim())) return false;
      // Require card to have some real content
      if (j.cardText.length < 15) return false;
      return true;
    });
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function scoreColor(s) {
    if (s >= 75) return '#3fb950';
    if (s >= 55) return '#d29922';
    if (s >= 35) return '#e3812b';
    return '#f85149';
  }

  function injectStyles() {
    if (document.getElementById('jma-styles')) return;
    const style = document.createElement('style');
    style.id = 'jma-styles';
    style.textContent = `
      #jma-float-btn {
        position:fixed;bottom:28px;right:28px;z-index:2147483646;
        height:48px;
        padding:0 20px 0 16px;
        border-radius:24px;
        background:rgba(109,40,217,0.88);
        backdrop-filter:blur(16px) saturate(160%);
        -webkit-backdrop-filter:blur(16px) saturate(160%);
        border:1px solid rgba(255,255,255,0.18);
        box-shadow:0 4px 8px rgba(0,0,0,0.2),0 12px 28px rgba(109,40,217,0.45),inset 0 1px 0 rgba(255,255,255,0.15);
        cursor:pointer;color:#fff;
        display:flex;align-items:center;gap:9px;
        font-size:13px;font-weight:700;letter-spacing:.3px;
        direction:rtl;white-space:nowrap;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
        transition:transform .2s ease,box-shadow .25s ease;
      }
      #jma-float-btn:hover{
        transform:translateY(-3px);
        box-shadow:0 8px 16px rgba(0,0,0,0.25),0 20px 40px rgba(109,40,217,0.58),inset 0 1px 0 rgba(255,255,255,0.22);
      }
      #jma-float-btn .jma-icon{font-size:18px;line-height:1;flex-shrink:0}
      #jma-float-btn .jma-label{font-size:13px;font-weight:700}
      #jma-sidebar{
        position:fixed;top:0;right:-400px;width:380px;height:100vh;z-index:2147483645;
        background:#0d1117;border-left:1px solid #21262d;
        box-shadow:-4px 0 30px rgba(0,0,0,.6);transition:right .3s ease;
        display:flex;flex-direction:column;direction:rtl;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
      }
      #jma-sidebar.jma-open{right:0}
      #jma-sb-header{
        display:flex;align-items:center;justify-content:space-between;
        padding:13px 16px;border-bottom:1px solid #21262d;background:#161b22;flex-shrink:0;
      }
      #jma-sb-title{font-size:14px;font-weight:700;color:#f0f6fc;display:flex;align-items:center;gap:6px}
      #jma-sb-close{background:none;border:1px solid #21262d;color:#8b949e;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:13px}
      #jma-sb-close:hover{background:#21262d;color:#f0f6fc}
      #jma-sb-body{flex:1;overflow-y:auto;padding:12px}
      #jma-sb-body::-webkit-scrollbar{width:4px}
      #jma-sb-body::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
      .jma-loading{text-align:center;padding:40px 20px;color:#8b949e;font-size:13px}
      .jma-spinner{width:32px;height:32px;border:3px solid #21262d;border-top-color:#7c3aed;
        border-radius:50%;animation:jma-spin .8s linear infinite;margin:0 auto 12px}
      @keyframes jma-spin{to{transform:rotate(360deg)}}
      .jma-card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px;margin-bottom:8px}
      .jma-rank{font-size:10px;color:#8b949e;margin-bottom:3px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
      .jma-title{font-size:13px;font-weight:700;color:#f0f6fc;margin-bottom:2px}
      .jma-company{font-size:11px;color:#8b949e;margin-bottom:8px}
      .jma-bar-wrap{height:5px;background:#21262d;border-radius:3px;margin-bottom:8px}
      .jma-bar{height:5px;border-radius:3px;transition:width .5s ease}
      .jma-fit{display:flex;flex-direction:column;gap:5px}
      .jma-fit-row{font-size:11px;display:flex;gap:5px;align-items:flex-start;line-height:1.4;color:#e6edf3}
      .jma-err{background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.3);border-radius:8px;padding:14px;color:#f85149;font-size:12px;text-align:center}
      .jma-empty{text-align:center;padding:30px;color:#8b949e;font-size:13px}
      /* ── Circular FAB gauge ── */
      @keyframes jma-pulse{
        0%,100%{transform:scale(1);filter:drop-shadow(0 5px 14px rgba(109,40,217,0.6))}
        50%{transform:scale(1.06);filter:drop-shadow(0 8px 22px rgba(109,40,217,0.85))}
      }
      #jma-fab-wrap{
        position:fixed;top:80px;left:20px;width:84px;height:84px;
        z-index:2147483646;cursor:pointer;user-select:none;
        filter:drop-shadow(0 5px 14px rgba(109,40,217,0.6));
        transition:filter .3s,transform .2s;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
        animation:jma-pulse 3s ease-in-out infinite;
      }
      #jma-fab-wrap.jma-fab-loading{animation:none}
      #jma-fab-wrap:hover{transform:scale(1.12)!important;filter:drop-shadow(0 8px 22px rgba(109,40,217,0.9))!important}
      #jma-fab-wrap.jma-fab-ready{animation:none;filter:drop-shadow(0 5px 14px rgba(16,163,74,0.6))}
      #jma-fab-wrap.jma-fab-ready:hover{filter:drop-shadow(0 8px 22px rgba(16,163,74,0.85))!important}
      .jma-fab-bg{fill:url(#jma-grad)}
      .jma-fab-track{fill:none;stroke:rgba(255,255,255,0.2);stroke-width:6}
      .jma-fab-arc{
        fill:none;stroke:rgba(255,255,255,0.95);stroke-width:6;stroke-linecap:round;
        stroke-dasharray:207.3;stroke-dashoffset:207.3;
        transform-origin:42px 42px;transform:rotate(-90deg);
        transition:stroke-dashoffset .5s ease,stroke .4s ease;
      }
      .jma-fab-inner{
        position:absolute;inset:0;display:flex;flex-direction:column;
        align-items:center;justify-content:center;color:#fff;text-align:center;
        pointer-events:none;
      }
      .jma-fab-icon{font-size:22px;line-height:1}
      .jma-fab-text{font-size:9px;font-weight:700;line-height:1.4;margin-top:2px}
      .jma-fab-score-num{font-size:24px;font-weight:800;line-height:1}
      .jma-fab-score-pct{font-size:11px;font-weight:700;margin-top:-2px}
      .jma-fab-score-lbl{font-size:8px;opacity:.85;margin-top:2px}
      /* ── Recruiter click toast ── */
      #jma-toast{
        position:fixed;bottom:28px;left:50%;
        transform:translateX(-50%) translateY(90px);
        z-index:2147483647;
        display:flex;align-items:center;gap:14px;
        background:#0f172a;color:#f8fafc;
        border-radius:16px;padding:14px 18px 14px 16px;
        max-width:400px;width:max-content;
        box-shadow:0 8px 32px rgba(0,0,0,0.45);
        border:1px solid rgba(234,88,12,0.45);
        opacity:0;transition:transform .35s cubic-bezier(.4,0,.2,1),opacity .35s;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
      }
      #jma-toast.jma-toast-in{transform:translateX(-50%) translateY(0);opacity:1}
      .jma-toast-flame{font-size:28px;line-height:1;flex-shrink:0}
      .jma-toast-body{flex:1;min-width:0}
      .jma-toast-title{font-size:13px;font-weight:700;color:#fb923c;margin-bottom:4px;direction:rtl}
      .jma-toast-sub{font-size:12px;color:#e2e8f0;line-height:1.45;direction:rtl}
      .jma-toast-sub strong{color:#fff}
      .jma-toast-x{
        background:none;border:none;color:#64748b;cursor:pointer;
        font-size:14px;padding:2px 4px;flex-shrink:0;line-height:1;
        transition:color .15s;
      }
      .jma-toast-x:hover{color:#f8fafc}
      /* ── Quick-score reason bullets ── */
      #jma-fab-reasons{
        position:fixed;top:80px;left:116px;
        z-index:2147483646;display:flex;flex-direction:column;gap:7px;
        max-width:210px;pointer-events:none;
      }
      .jma-fab-reason-pill{
        background:rgba(15,23,42,0.90);color:#f8fafc;
        border-radius:10px;padding:6px 11px;
        font-size:12px;font-weight:500;line-height:1.35;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
        border:1px solid rgba(255,255,255,0.12);
        backdrop-filter:blur(6px);
        opacity:0;transform:translateX(-10px);
        transition:opacity .22s ease,transform .22s ease;
        white-space:nowrap;
      }
      .jma-fab-reason-pill.jma-fab-reason-in{opacity:1;transform:translateX(0)}
      /* ── Injected sidebar panel ── */
      /* Default: panel body off-screen but grab tab (36px wide at left:-36px) is fully
         visible at the viewport's right edge. right = -(panel_width - tab_width) = -364px */
      #jma-panel{
        position:fixed;top:0;right:-400px !important;width:400px;height:100vh;
        z-index:2147483647;border-left:1px solid #e2e8f0;
        box-shadow:-6px 0 28px rgba(0,0,0,0.15);
        transition:right .35s cubic-bezier(.4,0,.2,1);
      }
      #jma-panel.jma-panel-open{right:0 !important}
      #jma-panel iframe{width:100%;height:100%;border:none;display:block}
      /* Grab tab — always visible at right edge; slides with the panel */
      #jma-panel-tab{
        position:absolute;top:50%;left:-36px;transform:translateY(-50%);
        width:36px;height:72px;
        background:linear-gradient(160deg,#7c3aed 0%,#6d28d9 100%);
        color:#fff;border:none;
        border-radius:12px 0 0 12px;cursor:pointer;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
        box-shadow:-4px 0 16px rgba(109,40,217,0.45),-1px 0 0 rgba(255,255,255,0.1);
        transition:background .15s,box-shadow .15s;
        z-index:1;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
      }
      #jma-panel-tab:hover{
        background:linear-gradient(160deg,#8b5cf6 0%,#7c3aed 100%);
        box-shadow:-6px 0 20px rgba(109,40,217,0.65),-1px 0 0 rgba(255,255,255,0.15);
      }
      .jma-tab-arrow{font-size:14px;line-height:1;transition:transform .3s ease}
      .jma-tab-dots{display:flex;flex-direction:column;gap:3px;align-items:center}
      .jma-tab-dot{width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,0.55)}
    `;
    document.head.appendChild(style);
  }

  let _sidebarOpen = false;
  let _rankingDone = false;
  let _collectedJobs = null;

  function showSidebarLoading() {
    const body = document.getElementById('jma-sb-body');
    if (body) body.innerHTML = '<div class="jma-loading"><div class="jma-spinner"></div><div>מנתח ומדרג משרות...</div><div style="font-size:11px;margin-top:6px;color:#484f58">יכול לקחת עד דקה</div></div>';
  }

  function showSidebarError(msg) {
    const body = document.getElementById('jma-sb-body');
    if (body) body.innerHTML = `<div class="jma-err">${escHtml(msg)}</div>`;
  }

  function renderRanked(jobs) {
    const body = document.getElementById('jma-sb-body');
    if (!jobs || !jobs.length) { body.innerHTML = '<div class="jma-empty">לא נמצאו משרות לדירוג</div>'; return; }
    const sorted = [...jobs].sort((a, b) => b.score - a.score);
    body.innerHTML = sorted.map((j, i) => {
      const col = scoreColor(j.score);
      return `<div class="jma-card">
        <div class="jma-rank">#${i+1} · ${j.score}% התאמה</div>
        <div class="jma-title">${escHtml(j.title)}</div>
        ${j.company ? `<div class="jma-company">${escHtml(j.company)}</div>` : ''}
        <div class="jma-bar-wrap"><div class="jma-bar" style="width:${j.score}%;background:${col}"></div></div>
        <div class="jma-fit">
          <div class="jma-fit-row"><span>✅</span><span>${escHtml(j.pro)}</span></div>
          <div class="jma-fit-row"><span>⚠️</span><span>${escHtml(j.con)}</span></div>
        </div>
      </div>`;
    }).join('');
  }

  function setSidebarStatus(html) {
    const body = document.getElementById('jma-sb-body');
    if (body) body.innerHTML = html;
  }

  function rankCacheKey() {
    return `jma_rank_${location.origin}${location.pathname}`;
  }

  function startRanking() {
    if (_rankingDone) return;
    console.log(`[JMA:rank] startRanking jobs_collected=${_collectedJobs.length}`);

    // Check local cache first — results valid for 20 minutes
    const cKey = rankCacheKey();
    chrome.storage.local.get([cKey], (stored) => {
      const cached = stored[cKey];
      if (cached && (Date.now() - cached.ts) < 20 * 60 * 1000) {
        _rankingDone = true;
        const cacheNote = document.createElement('div');
        cacheNote.style.cssText = 'font-size:10px;color:#484f58;text-align:center;padding:4px 0 8px';
        cacheNote.textContent = '⚡ תוצאות שמורות מניתוח קודם';
        const body = document.getElementById('jma-sb-body');
        if (body) {
          renderRanked(cached.jobs);
          body.prepend(cacheNote);
        }
        return;
      }

      // No cache — fetch + rank
      setSidebarStatus('<div class="jma-loading"><div class="jma-spinner"></div><div>אוסף מידע מלא על המשרות...</div><div style="font-size:11px;margin-top:6px;color:#484f58">ממשיך ברקע ☕</div></div>');

      const urls = _collectedJobs.map(j => j.href || '');

      console.log(`[JMA:rank] fetching job details for ${urls.length} URLs`);
      chrome.runtime.sendMessage({ action: 'fetchJobDetails', urls }, (fetchResp) => {
        if (chrome.runtime.lastError) {
          console.log(`[JMA:rank] fetchJobDetails runtime error: ${chrome.runtime.lastError.message}`);
        }
        const enrichedJobs = _collectedJobs.map((job, i) => {
          const fetched = fetchResp?.texts?.[i] || '';
          const bestText = fetched.length > 200 ? fetched
                         : job.cardText && job.cardText.length > 60 ? job.cardText
                         : job.snippet || '';
          return { ...job, fullText: bestText };
        }).filter(j => (j.fullText || '').length > 15);

        console.log(`[JMA:rank] enrichedJobs=${enrichedJobs.length} (filtered from ${_collectedJobs.length})`);
        enrichedJobs.forEach((j,i) => console.log(`[JMA:rank]   [${i}] "${j.title}" fullText_len=${(j.fullText||'').length}`));

        if (!enrichedJobs.length) {
          showSidebarError('לא הצלחנו לאסוף מספיק מידע על המשרות בעמוד זה.');
          return;
        }

        setSidebarStatus('<div class="jma-loading"><div class="jma-spinner"></div><div>מנתח ומדרג משרות...</div><div style="font-size:11px;margin-top:6px;color:#484f58">יכול לקחת עד דקה</div></div>');

        console.log(`[JMA:rank] sending rankJobs with ${enrichedJobs.length} jobs`);
        chrome.runtime.sendMessage({ action: 'rankJobs', jobs: enrichedJobs }, (resp) => {
          if (chrome.runtime.lastError) {
            console.log(`[JMA:rank] rankJobs runtime error: ${chrome.runtime.lastError.message}`);
            showSidebarError('לא הצלחנו לנתח את המשרות. נסי שוב.');
            return;
          }
          console.log(`[JMA:rank] rankJobs response: error=${resp?.error} rankedJobs_len=${resp?.rankedJobs?.length}`);
          if (!resp) { showSidebarError('לא הצלחנו לנתח את המשרות. נסי שוב.'); return; }
          if (resp.error) { showSidebarError(resp.error); return; }
          _rankingDone = true;
          // Save to cache
          chrome.storage.local.set({ [cKey]: { jobs: resp.rankedJobs, ts: Date.now() } });
          renderRanked(resp.rankedJobs);
        });
      });
    });
  }

  function initSidebar() {
    if (document.getElementById('jma-float-btn')) return;
    const detected = detectJobCards();
    if (!detected) return;
    _collectedJobs = extractJobsFromCards(detected.cards, detected.cfg);
    if (!_collectedJobs || _collectedJobs.length < 2) return;

    injectStyles();

    const btn = document.createElement('button');
    btn.id = 'jma-float-btn';
    btn.innerHTML = '<span class="jma-icon">🎯</span><span class="jma-label">דרג משרות בעמוד</span>';
    document.body.appendChild(btn);

    const sidebar = document.createElement('div');
    sidebar.id = 'jma-sidebar';
    sidebar.innerHTML = `
      <div id="jma-sb-header">
        <div id="jma-sb-title">🎯 Job Match AI</div>
        <button id="jma-sb-close">✕</button>
      </div>
      <div id="jma-sb-body"><div class="jma-empty">לחץ על הכפתור כדי לדרג את המשרות בעמוד</div></div>`;
    document.body.appendChild(sidebar);

    btn.addEventListener('click', () => {
      _sidebarOpen = !_sidebarOpen;
      sidebar.classList.toggle('jma-open', _sidebarOpen);
      if (_sidebarOpen) startRanking();
    });
    document.getElementById('jma-sb-close').addEventListener('click', () => {
      _sidebarOpen = false;
      sidebar.classList.remove('jma-open');
    });
  }

  // ── SPA navigation detection + page init ────────────────────────────────────

  let _currentUrl = location.href;
  let _navDebounceTimer = null;

  // Tear down all per-page FAB state so _initPage() starts fresh.
  function _teardownFab() {
    clearInterval(_fabProgressTimer);
    document.getElementById('jma-fab-wrap')?.remove();
    document.getElementById('jma-fab-reasons')?.remove();
    document.getElementById('jma-float-btn')?.remove();
    document.getElementById('jma-sidebar')?.remove();
    _fabState = 'idle';
    _fabProgress = 0;
    _panelOpen = false;
    _sidebarOpen = false;
    _rankingDone = false;
    _collectedJobs = null;
    // Close panel so next page starts closed (panel element persists)
    const panel = document.getElementById('jma-panel');
    if (panel) {
      panel.classList.remove('jma-panel-open');
      const arrow = panel.querySelector('.jma-tab-arrow');
      if (arrow) { arrow.textContent = '◀'; arrow.style.transform = ''; }
    }
  }

  // Full page init: LAZY - שום דבר לא מוזרק בעמוד רגיל.
  // הפאנל (iframe) נוצר רק בלחיצה על ה-FAB או בהודעת toggleSidebar.
  // pingBackend + scrapeJob עברו לתוך initJobFab, אחרי שער הדרישות.
  function _initPage() {
    // עמוד רגיל: יציאה מוחלטת. סימן דרישות מובהק מספיק גם כשספירת מילות המפתח נמוכה
    // (למשל משרה באנגלית בתוך לוח ישראלי).
    const _bodySample = (document.body.innerText || '').slice(0, 30000);
    if (!pageHasJobKeywords() && !_hasJobRequirementsSignal(_bodySample)) return;

    injectStyles();

    // Listing page: delayed to let SPA finish rendering cards
    setTimeout(() => {
      if (!document.getElementById('jma-float-btn')) initSidebar();
    }, 1800);

    // Single-job FAB: slightly later so page content is fully rendered
    setTimeout(() => {
      if (!document.getElementById('jma-fab-wrap')) initJobFab();
    }, 2200);
  }

  // Called whenever a navigation to a new URL is detected.
  function _onUrlChange() {
    if (location.href === _currentUrl) return;
    _currentUrl = location.href;
    clearTimeout(_navDebounceTimer);
    // Debounce: SPA routers often fire multiple events in rapid succession.
    _navDebounceTimer = setTimeout(() => {
      _rankingDone = false; _collectedJobs = null; _sidebarOpen = false;
      _fabState = 'idle'; _panelOpen = false;
      clearInterval(_fabProgressTimer);
      document.getElementById('jma-float-btn')?.remove();
      document.getElementById('jma-sidebar')?.remove();
      _teardownFab();
      _initPage();
    }, 400);
  }

  // 1. popstate — back/forward navigation
  window.addEventListener('popstate', _onUrlChange);

  // 2. Intercept history.pushState / replaceState — the main SPA navigation method.
  //    These are synchronous calls that don't fire any native events we can listen to,
  //    so we wrap them ourselves.
  (function _patchHistory() {
    const wrap = (orig) => function (...args) {
      const ret = orig.apply(this, args);
      _onUrlChange();
      return ret;
    };
    history.pushState    = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
  })();

  // 3. MutationObserver on <title> — final safety net for frameworks that update
  //    the document title when routing (virtually all of them do).
  new MutationObserver(() => _onUrlChange()).observe(
    document.querySelector('title') || document.head,
    { childList: true, subtree: true, characterData: true }
  );

  // ── Initial page load ──────────────────────────────────────────────────────
  _initPage();

  // רשת ביטחון ל-SPA: יירוט history.pushState לא רואה ניווטים של סקריפטים של
  // האתר עצמו (עולם מבודד ב-MV3), לכן בדיקה תקופתית זולה הכרחית.
  // _onUrlChange בודק בעצמו אם ה-URL השתנה ויוצא מיד אם לא - עלות זניחה.
  setInterval(_onUrlChange, 1500);
})();

// ── Deep-analysis floating panel (left side of page, separate from popup) ──────
let _apTextNode = null;
let _apFull     = '';

function _openAnalysisPanel() {
  document.getElementById('jma-ap')?.remove();
  _apTextNode = null;
  _apFull     = '';

  if (!document.getElementById('jma-ap-style')) {
    const st = document.createElement('style');
    st.id = 'jma-ap-style';
    st.textContent = `
      #jma-ap {
        position:fixed; left:20px; top:50%; transform:translateY(-50%);
        width:300px; max-height:420px;
        background:#12152a; border-radius:14px;
        box-shadow:0 8px 40px rgba(0,0,0,.65);
        z-index:2147483640; display:flex; flex-direction:column;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        animation:jma-ap-in .3s cubic-bezier(.22,1,.36,1);
      }
      @keyframes jma-ap-in { from{opacity:0;transform:translateY(-50%) translateX(-18px)} to{opacity:1;transform:translateY(-50%) translateX(0)} }
      #jma-ap-head {
        display:flex; align-items:center; justify-content:space-between;
        padding:10px 13px; border-bottom:1px solid #242740; flex-shrink:0;
      }
      #jma-ap-title  { font-weight:700; font-size:13px; color:#e2e8f0; }
      #jma-ap-score  { font-size:12px; font-weight:700; color:#6366f1; }
      #jma-ap-close  { background:none; border:none; cursor:pointer; color:#8892b0; font-size:17px; line-height:1; padding:0 2px; }
      #jma-ap-body   {
        padding:12px 13px; overflow-y:auto; flex:1;
        font-size:12.5px; line-height:1.72; direction:rtl; text-align:right;
        color:#e2e8f0; white-space:pre-wrap;
      }
      .jma-ap-cur    { animation:jma-ap-blink .7s step-end infinite; color:#6366f1; }
      @keyframes jma-ap-blink { 0%,100%{opacity:1} 50%{opacity:0} }
      .jma-ap-strength { color:#3fb950; }
      .jma-ap-gap      { color:#f85149; }
      .jma-ap-neutral  { color:#e2e8f0; }
    `;
    document.head.appendChild(st);
  }

  const panel = document.createElement('div');
  panel.id = 'jma-ap';
  panel.innerHTML = `
    <div id="jma-ap-head">
      <span id="jma-ap-title">🔍 ניתוח מעמיק</span>
      <span id="jma-ap-score">מחשב ציון…</span>
      <button id="jma-ap-close">✕</button>
    </div>
    <div id="jma-ap-body"><span class="jma-ap-cur">|</span></div>`;
  document.body.appendChild(panel);

  document.getElementById('jma-ap-close').onclick = () => panel.remove();

  _apTextNode = document.createTextNode('');
  const body   = document.getElementById('jma-ap-body');
  const cursor = body.querySelector('.jma-ap-cur');
  body.insertBefore(_apTextNode, cursor);
}

function _handleAnalysisEvent(evt) {
  if (!evt) return;
  const body    = document.getElementById('jma-ap-body');
  const scoreEl = document.getElementById('jma-ap-score');
  if (!body) return;

  if (evt.score !== undefined) {
    const c = evt.score >= 75 ? '#3fb950' : evt.score >= 55 ? '#d29922' : evt.score >= 35 ? '#e3812b' : '#f85149';
    if (scoreEl) { scoreEl.style.color = c; scoreEl.textContent = `ציון AI: ${evt.score}%`; }
    // Update FAB
    _updateFabArc(evt.score, true);
    const inner  = document.getElementById('jma-fab-inner');
    const numEl  = inner?.querySelector('.jma-fab-score-num');
    if (numEl) { numEl.style.color = c; numEl.textContent = evt.score; }
  }

  if (evt.token && _apTextNode) {
    _apFull += evt.token;
    _apTextNode.textContent = _apFull;
    body.scrollTop = body.scrollHeight;
  }

  if (evt.done) {
    // Remove cursor and apply color coding
    body.querySelector('.jma-ap-cur')?.remove();
    if (_apTextNode) {
      const colored = _apColorize(_apFull);
      _apTextNode.remove();
      _apTextNode = null;
      body.innerHTML = colored;
    }
  }
}

function _apColorize(text) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let mode = 'neutral';
  return text.split('\n').map(line => {
    const t = line.trim();
    if (/חוזק|strength|יתרון|חיובי/i.test(t))            mode = 'strength';
    else if (/פער|חסר|gap|weakness|לשפר|missing|בעי/i.test(t)) mode = 'gap';
    else if (/המלצ|לסיכום|conclusion|summary/i.test(t))    mode = 'neutral';
    const cls = mode === 'strength' ? 'jma-ap-strength' : mode === 'gap' ? 'jma-ap-gap' : 'jma-ap-neutral';
    return `<span class="${cls}">${esc(line)}</span>`;
  }).join('\n');
}
