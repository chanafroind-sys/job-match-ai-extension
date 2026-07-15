// ═════════════════════════════════════════════════════════════════════════
// JMA V2 (Interactive Mode Beta) — exclusive-switch + V2 page-side pipeline.
//
// Replication contract (V1 ↔ V2 isolation):
//   • V1's FAB click handler lives in content.js — bubble phase, attached to
//     #jma-fab-wrap. content.js is FROZEN and never edited.
//   • This file registers a document-level CAPTURE-phase listener, so it runs
//     before V1's handler on every FAB click and routes exclusively:
//       Classic (V1)     → re-dispatch a flagged synthetic click on the FAB;
//                          this script ignores it, only V1 code executes.
//       Interactive (V2) → stopPropagation() starves V1's listener entirely;
//                          only V2 code executes.
//   • The extraction pipeline below is a physical 1:1 copy from content.js
//     (frozen); provenance is noted per block. Storage writes go exclusively
//     to the jma_v2_* namespace. Pre-click V1 state (window.jma_current_score,
//     jma_local_score_*) is produced BEFORE the replication boundary by the
//     passive V1 matcher — V2 reads it, never writes it.
//   • Message isolation: V2 answers only jmaV2* actions.
//
// V2-only additions (new interaction model, not cloned logic):
//   • Floating CV window (#jma-v2-cv-window) — spacious scrollable overlay on
//     the left/center of the screen, opened automatically with the panel.
//   • Reversed '+' insertion: + buttons rendered INSIDE the CV window next to
//     the Skills section and each role block; clicking one injects the active
//     answer (announced by the panel iframe via postMessage) into that block.
// ═════════════════════════════════════════════════════════════════════════
(() => {
  'use strict';

  const V2_JOBS_KEY = 'jma_v2_recent_jobs';
  const BYPASS = '_jmaV2Bypass';
  const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  let _v2PanelOpen = false;

  // ═══ 1. Job text extraction — physical copy of content.js:72-158 ═════════

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
    // קריטי: שומרים על שבירות שורה! הפרסר של matcher.js עובד לפי שורות/בולטים.
    return text
      .replace(/[ \t ]+/g, ' ')   // מכווצים רק רווחים אופקיים
      .replace(/ ?\n ?/g, '\n')        // מנקים רווחים סביב שבירות שורה
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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

  // ═══ 2. V2 job-state persistence — copy of content.js:24-48 (v2 key) ═════

  function _urlHash(url) {
    let h = 0;
    for (let i = 0; i < (url || '').length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }
  const _placementsKey = () => `jma_v2_placements_${_urlHash(location.href)}`;

  async function _v2GetRecentJobs() {
    const res = await chrome.storage.local.get(V2_JOBS_KEY);
    return res[V2_JOBS_KEY] || [];
  }

  async function _v2SaveJobState(fullJobState) {
    let jobs = await _v2GetRecentJobs();
    jobs = jobs.filter(j => j.url !== fullJobState.url);
    jobs.unshift(fullJobState);
    if (jobs.length > 5) jobs.length = 5;
    await chrome.storage.local.set({ [V2_JOBS_KEY]: jobs });
  }

  // ═══ 3. V2 pipeline — physical copy of runFabPipeline (content.js:578-664),
  //        storage → jma_v2_recent_jobs, cache lookup → V2 jobs array ════════
  async function jmaV2RunPipeline() {
    const currentUrl = window.location.href;
    const extractedText = extractJobText();
    const cached = (await _v2GetRecentJobs()).find(j => j.url === currentUrl) || null;

    // ── אסטרטגיית חילוץ כותרת דינמית ─────────────────────────────────────────
    const getJobTitle = () => {
      const h1 = document.querySelector('h1')?.innerText?.trim() || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim() || '';

      const rawTitle = h1 || ogTitle || document.title || 'משרה ללא כותרת';

      return rawTitle.split(/[|•\-–]/)[0].trim();
    };

    // ── אסטרטגיית חילוץ פלטפורמה דינמית ──────────────────────────────────────
    const getJobPlatform = () => {
      return detectPlatform();
    };

    // ── זיהוי שפה ואסימילציה של הנתונים ──────────────────────────────────────
    const jobLanguage = detectLanguage(extractedText);

    // שליפת הציון והבולטים שנשמרו זמנית על ה-window בחלק הפסיבי (pre-click,
    // V1-owned — read-only)
    const finalScore = window.jma_current_score || (cached ? cached.baseScore : 0);
    const finalBullets = window.jma_current_bullets || (cached ? cached.bullets : []);

    // 🎯 בניית אובייקט ה-state המלא והמאוחד למשרה הנוכחית
    const fullJobState = {
      url: currentUrl,
      jobUrl: currentUrl,
      jobText: extractedText,
      jobTitle: getJobTitle(),
      jobPlatform: getJobPlatform(),
      jobLanguage: jobLanguage,
      wizard_step: 'questions',
      baseScore: finalScore,
      bullets: finalBullets,
      ts: Date.now(),
      activelyOpened: true,
      analysis: cached?.analysis || null,
      questions: cached?.questions || [],
      answers: cached?.answers || [],
      generatedCV: cached?.generatedCV || '',
      gapPct: cached?.gapPct || 0
    };

    try {
      await _v2SaveJobState(fullJobState);
    } catch (err) {
      console.error("[JMA:V2] ⚠️ שגיאה בשמירת נתוני המשרה בסטורג':", err);
    }

    return { ok: true, baseScore: finalScore, url: currentUrl };
  }

  // ═══ 4. Exclusive switch — capture-phase FAB interception ═════════════════

  document.addEventListener('click', (e) => {
    if (e[BYPASS]) return; // Classic handoff in flight — let V1 take the event
    const wrap = e.target instanceof Element ? e.target.closest('#jma-fab-wrap') : null;
    if (!wrap) return;
    if (!wrap.classList.contains('jma-fab-clickable')) return;
    e.stopPropagation();
    e.preventDefault();
    _toggleChooser(wrap);
  }, true);

  document.addEventListener('click', (e) => {
    const chooser = document.getElementById('jma-v2-chooser');
    if (!chooser) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && (t.closest('#jma-v2-chooser') || t.closest('#jma-fab-wrap'))) return;
    chooser.remove();
  });

  function _toggleChooser(wrap) {
    const existing = document.getElementById('jma-v2-chooser');
    if (existing) { existing.remove(); return; }
    _injectStyles();

    const box = document.createElement('div');
    box.id = 'jma-v2-chooser';
    box.setAttribute('dir', 'rtl');
    box.innerHTML = `
      <div class="jma-v2-chooser-title">איך לנתח את המשרה?</div>
      <button type="button" id="jma-v2-btn-classic">
        ⚡ מצב קלאסי
        <span>הזרימה היציבה המוכרת (V1)</span>
      </button>
      <button type="button" id="jma-v2-btn-interactive">
        🧪 מצב אינטראקטיבי
        <span>V2 Beta — התאמה ויזואלית על הקו"ח</span>
      </button>`;
    document.body.appendChild(box);

    const rect = wrap.getBoundingClientRect();
    box.style.top = `${Math.max(8, rect.top - 8)}px`;
    box.style.right = `${Math.min(window.innerWidth - 8, window.innerWidth - rect.left + 12)}px`;

    box.querySelector('#jma-v2-btn-classic').addEventListener('click', (ev) => {
      ev.stopPropagation();
      box.remove();
      // Hand the click back to V1's untouched handler. The flag makes our
      // capture listener ignore it, so ONLY the V1 pipeline runs.
      const synth = new MouseEvent('click', { bubbles: true, cancelable: true });
      synth[BYPASS] = true;
      wrap.dispatchEvent(synth);
    });

    box.querySelector('#jma-v2-btn-interactive').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      box.remove();
      // V1 was starved by stopPropagation at capture — only V2 runs from here.
      await jmaV2RunPipeline();
      _v2TogglePanel(true);
      await _v2OpenCvWindow(); // floating CV window opens in parallel
    });
  }

  // ═══ 5. V2 slide-out panel ════════════════════════════════════════════════

  function _ensureV2Panel() {
    if (document.getElementById('jma-v2-panel')) return;
    _injectStyles();
    const panel = document.createElement('div');
    panel.id = 'jma-v2-panel';
    const closeBtn = document.createElement('button');
    closeBtn.id = 'jma-v2-panel-close';
    closeBtn.type = 'button';
    closeBtn.title = 'סגירת פאנל V2';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      _v2TogglePanel(false);
      _v2CloseCvWindow();
    });
    panel.appendChild(closeBtn);
    const iframe = document.createElement('iframe');
    iframe.id = 'jma-v2-panel-iframe';
    iframe.src = chrome.runtime.getURL('v2/v2_popup.html');
    iframe.setAttribute('allowtransparency', 'true');
    panel.appendChild(iframe);
    document.body.appendChild(panel);
  }

  function _v2TogglePanel(open) {
    _ensureV2Panel();
    _v2PanelOpen = open === undefined ? !_v2PanelOpen : !!open;
    document.getElementById('jma-v2-panel')
      .classList.toggle('jma-v2-panel-open', _v2PanelOpen);
  }

  // ═══ 6. Floating CV window + reversed '+' insertion (V2 addition) ═════════

  // The "active answer" — last answer the user focused/typed in the panel.
  // Announced by v2_popup.js via postMessage (validated extension origin).
  let _v2ActiveAnswer = null; // { idx, skill, text }

  window.addEventListener('message', (e) => {
    if (e.origin !== EXT_ORIGIN) return;
    const d = e.data;
    if (!d || d.type !== 'jmaV2ActiveAnswer') return;
    _v2ActiveAnswer = { idx: d.idx, skill: d.skill || '', text: (d.text || '').trim() };
    const hint = document.getElementById('jma-v2-cv-active-hint');
    if (hint) {
      hint.textContent = _v2ActiveAnswer.text
        ? `תשובה פעילה (${_v2ActiveAnswer.skill || 'שאלה ' + (d.idx + 1)}): "${_v2ActiveAnswer.text.slice(0, 60)}${_v2ActiveAnswer.text.length > 60 ? '…' : ''}"`
        : 'הקלידי תשובה בפאנל ואז לחצי + על הסעיף המתאים';
    }
  });

  // Heuristic structural mapping of the ORIGINAL CV text into blocks.
  // (Placeholder for the Task-1 AI semantic map — same block/anchor shape.)
  const SECTION_HEADINGS = [
    { type: 'skills',     re: /^(technical skills|core skills|skills|כישורים( טכניים)?|מיומנויות|טכנולוגיות)\b/i },
    { type: 'experience', re: /^(work experience|professional experience|experience|employment( history)?|ניסיון( מקצועי| תעסוקתי)?)\b/i },
    { type: 'education',  re: /^(education|academic|השכלה)\b/i },
    { type: 'summary',    re: /^(summary|profile|about( me)?|תקציר|פרופיל|אודות)\b/i },
    { type: 'languages',  re: /^(languages|שפות)\b/i },
    { type: 'projects',   re: /^(projects|personal projects|פרויקטים)\b/i },
    { type: 'military',   re: /^(military( service)?|שירות צבאי)\b/i },
  ];
  const ROLE_START_RE = /((19|20)\d{2})\s*[-–—]\s*((19|20)\d{2}|present|current|now|היום|כיום)/i;

  function _v2MapCvBlocks(cvText) {
    const lines = (cvText || '').split('\n');
    const sections = [];
    let cur = { type: 'header', label: 'פתיח', lines: [] };

    for (const line of lines) {
      const t = line.trim();
      const heading = t.length > 0 && t.length <= 45
        ? SECTION_HEADINGS.find(h => h.re.test(t.replace(/[:\-–—\s]+$/, '')))
        : null;
      if (heading) {
        if (cur.lines.some(l => l.trim())) sections.push(cur);
        cur = { type: heading.type, label: t.replace(/[:\s]+$/, ''), lines: [] };
      } else {
        cur.lines.push(line);
      }
    }
    if (cur.lines.some(l => l.trim())) sections.push(cur);

    // Split the experience section into per-role blocks
    const blocks = [];
    let blockId = 0;
    for (const sec of sections) {
      if (sec.type !== 'experience') {
        blocks.push({
          id: `b${blockId++}`,
          type: sec.type === 'skills' ? 'skills' : 'text',
          label: sec.label,
          insertable: sec.type === 'skills',
          text: sec.lines.join('\n').trim(),
        });
        continue;
      }
      // Experience: a new role starts on a line with a year range, or a
      // "Title | Company" / "Title @ Company" line following a blank line.
      let role = null;
      const flushRole = () => {
        if (role && role.lines.some(l => l.trim())) {
          const firstLine = role.lines.find(l => l.trim())?.trim() || sec.label;
          blocks.push({
            id: `b${blockId++}`,
            type: 'role',
            label: firstLine.slice(0, 60),
            insertable: true,
            sectionLabel: sec.label,
            text: role.lines.join('\n').trim(),
          });
        }
      };
      let prevBlank = true;
      for (const line of sec.lines) {
        const t = line.trim();
        const isRoleStart = t &&
          (ROLE_START_RE.test(t) || (prevBlank && /.+\s*[|@]\s*.+/.test(t) && t.length <= 80));
        if (isRoleStart && role && role.lines.some(l => l.trim())) {
          flushRole();
          role = { lines: [line] };
        } else {
          if (!role) role = { lines: [] };
          role.lines.push(line);
        }
        prevBlank = !t;
      }
      flushRole();
    }
    return blocks;
  }

  async function _v2OpenCvWindow() {
    _injectStyles();
    const existing = document.getElementById('jma-v2-cv-window');
    if (existing) { existing.style.display = 'flex'; return; }

    // cvText is shared user config (the uploaded CV) — read-only for V2.
    const stored = await chrome.storage.local.get(['cvText']);
    const cvText = stored.cvText || '';

    const win = document.createElement('div');
    win.id = 'jma-v2-cv-window';
    win.setAttribute('dir', 'ltr');
    win.innerHTML = `
      <div id="jma-v2-cv-header" dir="rtl">
        <span class="jma-v2-cv-title">📄 קורות החיים המקוריים — לחצי + כדי למקם תשובה</span>
        <button type="button" id="jma-v2-cv-close" title="סגירה">✕</button>
      </div>
      <div id="jma-v2-cv-active-hint" dir="rtl">הקלידי תשובה בפאנל ואז לחצי + על הסעיף המתאים</div>
      <div id="jma-v2-cv-paper"></div>`;
    document.body.appendChild(win);
    win.querySelector('#jma-v2-cv-close').addEventListener('click', () => _v2CloseCvWindow());
    _v2MakeDraggable(win, win.querySelector('#jma-v2-cv-header'));

    const paper = win.querySelector('#jma-v2-cv-paper');
    if (!cvText.trim()) {
      paper.innerHTML = '<div class="jma-v2-cv-empty" dir="rtl">לא נמצאו קורות חיים שמורים — העלי קובץ דרך הגדרות התוסף.</div>';
      return;
    }
    paper.dir = detectLanguage(cvText) === 'hebrew' ? 'rtl' : 'ltr';

    const blocks = _v2MapCvBlocks(cvText);
    for (const block of blocks) {
      const el = document.createElement('div');
      el.className = `jma-v2-cv-block jma-v2-cv-${block.type}`;
      el.dataset.blockId = block.id;

      if (block.type !== 'header') {
        const label = document.createElement('div');
        label.className = 'jma-v2-cv-block-label';
        label.textContent = block.label;
        el.appendChild(label);
      }
      const body = document.createElement('div');
      body.className = 'jma-v2-cv-block-body';
      body.textContent = block.text;
      el.appendChild(body);

      if (block.insertable) {
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.className = 'jma-v2-cv-plus';
        plus.title = block.type === 'skills'
          ? 'הוספת התשובה הפעילה ל-Skills'
          : `הוספת התשובה הפעילה ל-"${block.label}"`;
        plus.textContent = '+';
        plus.addEventListener('click', () => _v2InjectActiveAnswer(block, el, plus));
        el.appendChild(plus);
      }
      paper.appendChild(el);
    }

    // Restore placements already made for this job (e.g. window re-opened)
    try {
      const saved = (await chrome.storage.local.get(_placementsKey()))[_placementsKey()] || [];
      for (const p of saved) {
        const host = paper.querySelector(`[data-block-id="${p.blockId}"]`);
        if (host) _v2RenderInjected(host, p);
      }
    } catch {}
  }

  function _v2CloseCvWindow() {
    const win = document.getElementById('jma-v2-cv-window');
    if (win) win.style.display = 'none';
  }

  async function _v2InjectActiveAnswer(block, blockEl, plusBtn) {
    if (!_v2ActiveAnswer || !_v2ActiveAnswer.text) {
      plusBtn.classList.add('jma-v2-plus-nag');
      setTimeout(() => plusBtn.classList.remove('jma-v2-plus-nag'), 900);
      const hint = document.getElementById('jma-v2-cv-active-hint');
      if (hint) hint.textContent = '⚠️ אין תשובה פעילה — הקלידי תשובה בפאנל ואז לחצי +';
      return;
    }
    const placement = {
      id: `p_${Date.now().toString(36)}`,
      blockId: block.id,
      blockType: block.type,
      blockLabel: block.label,
      skill: _v2ActiveAnswer.skill,
      qIdx: _v2ActiveAnswer.idx,
      text: _v2ActiveAnswer.text,
      ts: Date.now(),
    };
    _v2RenderInjected(blockEl, placement);
    try {
      const key = _placementsKey();
      const saved = (await chrome.storage.local.get(key))[key] || [];
      saved.push(placement);
      await chrome.storage.local.set({ [key]: saved });
    } catch (err) {
      console.error('[JMA:V2] failed to save placement:', err);
    }
  }

  function _v2RenderInjected(blockEl, placement) {
    const inj = document.createElement('div');
    inj.className = 'jma-v2-injected';
    inj.dataset.placementId = placement.id;
    inj.innerHTML = `
      <span class="jma-v2-injected-tag">${placement.skill ? '＋ ' + placement.skill : '＋ תשובה'}</span>
      <span class="jma-v2-injected-text"></span>
      <button type="button" class="jma-v2-injected-remove" title="הסרה">✕</button>`;
    inj.querySelector('.jma-v2-injected-text').textContent = placement.text;
    inj.querySelector('.jma-v2-injected-remove').addEventListener('click', async () => {
      inj.remove();
      try {
        const key = _placementsKey();
        const saved = (await chrome.storage.local.get(key))[key] || [];
        await chrome.storage.local.set({ [key]: saved.filter(p => p.id !== placement.id) });
      } catch {}
    });
    blockEl.appendChild(inj);
    inj.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function _v2MakeDraggable(win, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = win.getBoundingClientRect();
      ox = r.left; oy = r.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      win.style.left = `${Math.max(0, ox + e.clientX - sx)}px`;
      win.style.top  = `${Math.max(0, oy + e.clientY - sy)}px`;
      win.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => { dragging = false; });
  }

  // ═══ 7. V2 message channel (jmaV2* actions only) ══════════════════════════

  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (req?.action === 'jmaV2OpenPanel') {
      jmaV2RunPipeline().then(() => {
        _v2TogglePanel(true);
        return _v2OpenCvWindow();
      }).finally(() => sendResponse({ ok: true }));
      return true;
    }
    if (req?.action === 'jmaV2RunPipeline') {
      jmaV2RunPipeline()
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (req?.action === 'jmaV2GetJobText') {
      // Same response shape as V1's getJobText, served entirely by V2 copies.
      const text = extractJobText();
      sendResponse({
        text,
        language: detectLanguage(text),
        platform: detectPlatform(),
        url: location.href,
        h1Title: document.querySelector('h1')?.innerText?.trim() || '',
        ogTitle: document.querySelector('meta[property="og:title"]')?.content?.trim() || '',
        title: document.title || '',
      });
      return; // sync response
    }
    // Every other action belongs to V1's listener in content.js.
  });

  // ═══ 8. Styles ════════════════════════════════════════════════════════════

  function _injectStyles() {
    if (document.getElementById('jma-v2-styles')) return;
    const style = document.createElement('style');
    style.id = 'jma-v2-styles';
    style.textContent = `
      #jma-v2-chooser{
        position:fixed;z-index:2147483646;min-width:230px;
        background:#1E1B2E;border:1px solid #7C3AED;border-radius:14px;
        padding:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);
        font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
        display:flex;flex-direction:column;gap:8px;direction:rtl;
      }
      #jma-v2-chooser .jma-v2-chooser-title{
        color:#E9E4F8;font-size:13px;font-weight:700;text-align:center;
        padding-bottom:2px;
      }
      #jma-v2-chooser button{
        all:unset;box-sizing:border-box;cursor:pointer;width:100%;
        display:flex;flex-direction:column;gap:2px;align-items:flex-start;
        padding:9px 12px;border-radius:10px;color:#fff;
        font-size:13.5px;font-weight:700;
      }
      #jma-v2-chooser button span{font-size:11px;font-weight:400;opacity:.75}
      #jma-v2-btn-classic{background:#31435C}
      #jma-v2-btn-classic:hover{background:#3D5474}
      #jma-v2-btn-interactive{background:#5B21B6}
      #jma-v2-btn-interactive:hover{background:#6D28D9}

      #jma-v2-panel{
        position:fixed;top:0;right:-420px;width:400px;height:100vh;
        z-index:2147483645;background:#14121F;
        border-left:2px solid #7C3AED;
        box-shadow:-8px 0 28px rgba(0,0,0,.4);
        transition:right .25s ease;
      }
      #jma-v2-panel.jma-v2-panel-open{right:0}
      #jma-v2-panel iframe{width:100%;height:100%;border:none;display:block}
      #jma-v2-panel-close{
        all:unset;cursor:pointer;position:absolute;top:8px;left:8px;
        width:26px;height:26px;text-align:center;line-height:26px;
        color:#B9AEDD;background:rgba(124,58,237,.18);border-radius:8px;
        font-size:13px;z-index:2;
      }
      #jma-v2-panel-close:hover{background:rgba(124,58,237,.4);color:#fff}

      /* ── Floating CV window ── */
      #jma-v2-cv-window{
        position:fixed;top:4vh;left:24px;
        width:min(720px, calc(100vw - 470px));min-width:340px;height:90vh;
        z-index:2147483644;display:flex;flex-direction:column;
        background:#EFEDF7;border:1px solid #C9C2E8;border-radius:14px;
        box-shadow:0 18px 50px rgba(20,15,45,.35);
        font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
      }
      #jma-v2-cv-header{
        display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding:10px 14px;cursor:grab;user-select:none;
        background:linear-gradient(90deg,#5B21B6,#7C3AED);color:#fff;
        border-radius:13px 13px 0 0;font-size:13px;font-weight:700;
      }
      #jma-v2-cv-header:active{cursor:grabbing}
      #jma-v2-cv-close{
        all:unset;cursor:pointer;width:24px;height:24px;text-align:center;
        line-height:24px;border-radius:7px;background:rgba(255,255,255,.15);
        font-size:12px;
      }
      #jma-v2-cv-close:hover{background:rgba(255,255,255,.35)}
      #jma-v2-cv-active-hint{
        padding:7px 14px;font-size:12px;color:#4C1D95;
        background:rgba(124,58,237,.1);border-bottom:1px solid #DDD6F3;
      }
      #jma-v2-cv-paper{
        flex:1;overflow-y:auto;margin:14px;padding:34px 38px;
        background:#fff;border:1px solid #E3E0F0;border-radius:4px;
        box-shadow:0 2px 10px rgba(20,15,45,.08);
        font-family:Georgia,'Times New Roman',serif;font-size:13.5px;
        line-height:1.6;color:#1F2333;
      }
      .jma-v2-cv-block{position:relative;padding:6px 0;border-radius:6px}
      .jma-v2-cv-block:hover{background:rgba(124,58,237,.04)}
      .jma-v2-cv-block-label{
        font-weight:700;font-size:14px;color:#3B3663;
        border-bottom:1.5px solid #D8D3EE;padding-bottom:2px;margin-bottom:5px;
        font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
      }
      .jma-v2-cv-role .jma-v2-cv-block-label{border-bottom-style:dashed;font-size:13px}
      .jma-v2-cv-block-body{white-space:pre-wrap;word-break:break-word}
      .jma-v2-cv-plus{
        all:unset;cursor:pointer;position:absolute;top:4px;
        inset-inline-end:-4px;width:26px;height:26px;text-align:center;
        line-height:24px;border-radius:50%;font-size:17px;font-weight:800;
        background:#7C3AED;color:#fff;box-shadow:0 3px 8px rgba(124,58,237,.45);
        transition:transform .12s ease, background .12s ease;
      }
      .jma-v2-cv-plus:hover{transform:scale(1.18);background:#6D28D9}
      .jma-v2-plus-nag{animation:jmaV2Nag .3s ease 2}
      @keyframes jmaV2Nag{50%{transform:translateX(4px);background:#DC2626}}
      .jma-v2-injected{
        position:relative;margin:7px 0 3px;padding:7px 10px;
        background:#F2FBF5;border:1px dashed #34C071;border-radius:8px;
        font-size:12.5px;line-height:1.5;color:#14532D;
        animation:jmaV2InjIn .25s ease;
        font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
      }
      @keyframes jmaV2InjIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
      .jma-v2-injected-tag{
        display:inline-block;font-size:10px;font-weight:800;color:#0F7A3D;
        background:rgba(52,192,113,.15);border-radius:5px;padding:1px 6px;
        margin-inline-end:6px;vertical-align:middle;
      }
      .jma-v2-injected-remove{
        all:unset;cursor:pointer;position:absolute;top:4px;inset-inline-end:6px;
        font-size:10px;color:#9CA3AF;width:16px;height:16px;text-align:center;
      }
      .jma-v2-injected-remove:hover{color:#DC2626}
      .jma-v2-cv-empty{padding:30px;text-align:center;color:#6B7280;font-size:13px}
    `;
    document.documentElement.appendChild(style);
  }
})();
