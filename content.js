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

    if (req.action === 'getJobText') {
      const text = extractJobText();
      sendResponse({
        text,
        language: detectLanguage(text),
        platform: detectPlatform(),
        url: window.location.href,
        title: document.title,
      });
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

  function startRanking() {
    if (_rankingDone) return;

    setSidebarStatus('<div class="jma-loading"><div class="jma-spinner"></div><div>אוסף מידע מלא על המשרות...</div><div style="font-size:11px;margin-top:6px;color:#484f58">ממשיך ברקע ☕</div></div>');

    const urls = _collectedJobs.map(j => j.href || '');

    chrome.runtime.sendMessage({ action: 'fetchJobDetails', urls }, (fetchResp) => {
      // Merge texts — prefer fetched full text (>200 chars) over card text over snippet
      const enrichedJobs = _collectedJobs.map((job, i) => {
        const fetched = fetchResp?.texts?.[i] || '';
        const bestText = fetched.length > 200 ? fetched
                       : job.cardText && job.cardText.length > 60 ? job.cardText
                       : job.snippet || '';
        return { ...job, fullText: bestText };
      }).filter(j => (j.fullText || '').length > 15); // drop jobs with truly no content

      if (!enrichedJobs.length) {
        showSidebarError('לא הצלחנו לאסוף מספיק מידע על המשרות בעמוד זה.');
        return;
      }

      setSidebarStatus('<div class="jma-loading"><div class="jma-spinner"></div><div>מנתח ומדרג משרות...</div><div style="font-size:11px;margin-top:6px;color:#484f58">יכול לקחת עד דקה</div></div>');

      chrome.runtime.sendMessage({ action: 'rankJobs', jobs: enrichedJobs }, (resp) => {
        if (chrome.runtime.lastError || !resp) { showSidebarError('לא הצלחנו לנתח את המשרות. נסי שוב.'); return; }
        if (resp.error) { showSidebarError(resp.error); return; }
        _rankingDone = true;
        renderRanked(resp.rankedJobs);
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

  setTimeout(initSidebar, 2000);

  // Re-init on SPA navigation
  let _lastHref = location.href;
  setInterval(() => {
    if (location.href !== _lastHref) {
      _lastHref = location.href;
      _rankingDone = false; _collectedJobs = null; _sidebarOpen = false;
      document.getElementById('jma-float-btn')?.remove();
      document.getElementById('jma-sidebar')?.remove();
      document.getElementById('jma-styles')?.remove();
      setTimeout(initSidebar, 2000);
    }
  }, 1200);
})();
