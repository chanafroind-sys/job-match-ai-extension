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

  const GENERIC_CARD_SELECTORS = [
    '[class*="job-card"]', '[class*="jobCard"]', '[class*="job-listing"]',
    '[class*="position-item"]', '[class*="vacancy-item"]', '[data-job-id]',
    'li[class*="position"]', 'li[class*="job"]', 'article[class*="job"]',
  ];

  function getCardConfig() {
    const host = window.location.hostname.replace('www.', '');
    for (const [domain, cfg] of Object.entries(CARD_CONFIGS)) {
      if (host.includes(domain)) return cfg;
    }
    return null;
  }

  function detectJobCards() {
    const cfg = getCardConfig();
    if (cfg) {
      const cards = document.querySelectorAll(cfg.cards);
      if (cards.length >= 2) return { cards: Array.from(cards), cfg };
    }
    for (const sel of GENERIC_CARD_SELECTORS) {
      try {
        const cards = document.querySelectorAll(sel);
        if (cards.length >= 2) return { cards: Array.from(cards), cfg: null };
      } catch {}
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
      return { index: i, title: title.substring(0, 100), company: company.substring(0, 60), snippet: snippet.substring(0, 200) };
    }).filter(j => j.title.length > 2);
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
        position:fixed;bottom:24px;right:24px;z-index:2147483646;
        background:#7c3aed;color:#fff;border:none;border-radius:24px;
        padding:11px 18px;font-size:14px;font-weight:700;cursor:pointer;
        box-shadow:0 4px 20px rgba(124,58,237,.5);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
        transition:all .2s;display:flex;align-items:center;gap:7px;direction:rtl;
      }
      #jma-float-btn:hover{background:#6d28d9;transform:translateY(-2px)}
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

  function startRanking() {
    if (_rankingDone) return;
    showSidebarLoading();
    chrome.runtime.sendMessage({ action: 'rankJobs', jobs: _collectedJobs }, (resp) => {
      if (chrome.runtime.lastError || !resp) { showSidebarError('לא הצלחנו לנתח את המשרות. נסי שוב.'); return; }
      if (resp.error) { showSidebarError(resp.error); return; }
      _rankingDone = true;
      renderRanked(resp.rankedJobs);
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
    btn.innerHTML = '🎯 דרג משרות בעמוד';
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
