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

  // Position a floating box next to an anchor element, fully clamped to the
  // viewport. BUG FIX: this used to assume the FAB was docked to the right
  // edge and computed `right: innerWidth - rect.left`. V1's real FAB is
  // docked at left:20px (content.js:1111) — for a left-docked anchor that
  // formula produces a `right` value near innerWidth, pinning the chooser's
  // right edge a few px from the LEFT edge and pushing its ~230px body to a
  // negative x-coordinate, i.e. fully off-screen (the reported "sliver on
  // the far left"). Fixed by measuring the anchor's actual rect and always
  // clamping the result inside [0, viewport]. `setProperty(...,'important')`
  // is used so an inline declaration (which always wins specificity ties,
  // even against a host stylesheet's own `!important` rules) pins the final
  // position regardless of any page CSS trying to override left/right.
  function _v2PositionNear(box, anchorEl) {
    const a = anchorEl.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const margin = 10;
    const roomRight = window.innerWidth - a.right;
    const roomLeft  = a.left;
    let left = (roomRight >= b.width + margin || roomRight >= roomLeft)
      ? a.right + margin   // open toward the side with more room
      : a.left - b.width - margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - b.width - margin));
    const top = Math.max(margin, Math.min(a.top, window.innerHeight - b.height - margin));

    box.style.setProperty('left', `${left}px`, 'important');
    box.style.setProperty('top', `${top}px`, 'important');
    box.style.setProperty('right', 'auto', 'important');
  }

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
    // Appended to <html> (sibling of <body>) rather than document.body so a
    // transform/filter the host page applies to <body> itself (a common
    // cause of position:fixed being reinterpreted relative to that ancestor
    // instead of the viewport) can't hijack our containing block.
    document.documentElement.appendChild(box);
    _v2PositionNear(box, wrap);

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
    // Appended to <html>, not document.body — same reasoning as the chooser:
    // avoids a body-level transform/filter hijacking position:fixed.
    document.documentElement.appendChild(panel);
  }

  function _v2TogglePanel(open) {
    _ensureV2Panel();
    _v2PanelOpen = open === undefined ? !_v2PanelOpen : !!open;
    const panel = document.getElementById('jma-v2-panel');
    panel.classList.toggle('jma-v2-panel-open', _v2PanelOpen);
    // Belt-and-suspenders: also pin the offset as an inline !important
    // declaration. Inline declarations always win specificity ties over
    // stylesheet rules of equal importance, so this holds the panel at the
    // right edge even if a host stylesheet has its own `!important` rule
    // forcing `left`/`right` on injected elements (common in RTL sites that
    // blanket-flip left/right for their own components).
    panel.style.setProperty('right', _v2PanelOpen ? '0px' : '-420px', 'important');
    panel.style.setProperty('left', 'auto', 'important');
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
    _v2UpdateActiveHighlights();
  });

  // V2 addition (requirement 2): keep every '+' target inside the CV window
  // visually tied to whichever question card is glowing in the panel — same
  // purple highlight, plus a small pill naming what a click would insert
  // there. Re-run on every active-answer change so both sides update in the
  // same tick; also re-run once after (re)building the blocks so a window
  // opened/restored while an answer is already active shows the glow right away.
  function _v2UpdateActiveHighlights() {
    const paper = document.getElementById('jma-v2-cv-paper');
    if (!paper) return;
    const active = !!(_v2ActiveAnswer && _v2ActiveAnswer.text);
    const labelText = active
      ? `[+] הוסף "${(_v2ActiveAnswer.skill || _v2ActiveAnswer.text).slice(0, 24)}"`
      : '';
    paper.querySelectorAll('.jma-v2-cv-block').forEach(block => {
      const wrap = block.querySelector('.jma-v2-cv-plus-wrap');
      if (!wrap) return; // not an insertable block
      block.classList.toggle('jma-v2-active-target', active);
      const labelEl = wrap.querySelector('.jma-v2-cv-plus-label');
      if (labelEl) labelEl.textContent = labelText;
    });
  }

  // ═══ 6a. Real AI semantic block mapping (Task 1), with heuristic fallback ═
  //
  // Answering the architecture questions directly:
  //   Q: Does a one-time AI parser register exact role boundaries on upload?
  //   A: It did not until this endpoint — the ONLY AI touchpoint that already
  //      existed for the raw uploaded CV was /api/extract-profile (main.py:1497),
  //      which extracts a skills/years-per-domain PROFILE for local-matcher
  //      scoring (stored as jma_user_profile). It has no text offsets or role
  //      labels and isn't shaped for layout — it can't be repurposed for block
  //      boundaries. The only other CV-splitting logic in the codebase
  //      (main.py:754 split_experience_units / _is_role_header_line) is a
  //      deterministic regex heuristic run on the ALREADY-tailored output
  //      during generate_cv, for diff-highlighting — not on the raw upload.
  //   Q: Where would AI mapping data live and how do we use it for blocks?
  //   A: /api/v2/semantic-map (server-python/v2/semantic_map.py) — new, since
  //      no V1 equivalent exists to replicate. It returns start_line/end_line
  //      per block instead of trusting the model to retype CV content, so the
  //      ORIGINAL lines are sliced back out server-side byte-for-byte — this
  //      mirrors V1's own anti-hallucination diff-matching design (main.py's
  //      "never an LLM's re-typed approximation" comment at _split_original_lines).
  //      That's what guarantees native spacing/line-breaks survive untouched.
  //      Cached client-side per unique CV text (jma_v2_semantic_map_<hash>) so
  //      it only runs once per CV, not on every panel open.
  function _v2HashText(text) {
    let h = 0;
    for (let i = 0; i < (text || '').length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }

  async function _v2FetchSemanticMap(cvText) {
    const stored = await chrome.storage.local.get(['licenseKey']);
    const resp = await fetch(`${BACKEND}/api/v2/semantic-map`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': stored.licenseKey || '' },
      body: JSON.stringify({ cvText }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const blocks = data.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('empty semantic map');
    return blocks.map((b, i) => ({
      id: `b${i}`,
      type: b.type === 'skills' ? 'skills' : (b.type === 'role' ? 'role' : 'text'),
      label: (b.label || '').slice(0, 60),
      insertable: b.type === 'skills' || b.type === 'role',
      text: b.text || '',
    }));
  }

  // Tries the cached AI map, then a fresh AI call, then falls back to the
  // local heuristic below on any failure (offline, invalid license, server
  // error, malformed response) — the CV window must never fail to render.
  async function _v2GetCvBlocks(cvText) {
    const cacheKey = `jma_v2_semantic_map_${_v2HashText(cvText)}`;
    try {
      const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
      if (cached?.blocks?.length) return cached.blocks;
    } catch {}

    try {
      const blocks = await _v2FetchSemanticMap(cvText);
      chrome.storage.local.set({ [cacheKey]: { blocks, ts: Date.now() } }).catch(() => {});
      return blocks;
    } catch (err) {
      console.warn('[JMA:V2] semantic-map AI call failed, using heuristic fallback:', err);
      return _v2MapCvBlocks(cvText);
    }
  }

  // Heuristic structural mapping of the ORIGINAL CV text into blocks — the
  // fallback path when the AI semantic map is unavailable. Kept intentionally
  // simple/robust (no network dependency) since it must always succeed.
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
        <div class="jma-v2-cv-header-actions">
          <button type="button" id="jma-v2-cv-min" title="מזעור">_</button>
          <button type="button" id="jma-v2-cv-close" title="סגירה">✕</button>
        </div>
      </div>
      <div id="jma-v2-cv-active-hint" dir="rtl">הקלידי תשובה בפאנל ואז לחצי + על הסעיף המתאים</div>
      <div id="jma-v2-cv-paper"></div>`;
    // Appended to <html>, not document.body — consistent with the panel/
    // chooser fix above.
    document.documentElement.appendChild(win);
    win.querySelector('#jma-v2-cv-close').addEventListener('click', () => _v2CloseCvWindow());
    win.querySelector('#jma-v2-cv-min').addEventListener('click', (e) => {
      e.stopPropagation();
      _v2ToggleMinimizeCvWindow(win);
    });
    _v2MakeDraggable(win, win.querySelector('#jma-v2-cv-header'));

    const paper = win.querySelector('#jma-v2-cv-paper');
    if (!cvText.trim()) {
      paper.innerHTML = '<div class="jma-v2-cv-empty" dir="rtl">לא נמצאו קורות חיים שמורים — העלי קובץ דרך הגדרות התוסף.</div>';
      return;
    }
    paper.dir = detectLanguage(cvText) === 'hebrew' ? 'rtl' : 'ltr';
    paper.innerHTML = '<div class="jma-v2-cv-empty" dir="rtl">מנתחת את מבנה הקו"ח…</div>';

    const blocks = await _v2GetCvBlocks(cvText);
    paper.innerHTML = '';
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
        // Requirement 2: a dynamic pill next to the + button names what a
        // click would insert here, and both the pill and the surrounding
        // block glow in sync with the active question card in the panel
        // (state driven entirely by _v2UpdateActiveHighlights).
        const wrap = document.createElement('div');
        wrap.className = 'jma-v2-cv-plus-wrap';
        const label = document.createElement('span');
        label.className = 'jma-v2-cv-plus-label';
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.className = 'jma-v2-cv-plus';
        plus.title = block.type === 'skills'
          ? 'הוספת התשובה הפעילה ל-Skills'
          : `הוספת התשובה הפעילה ל-"${block.label}"`;
        plus.textContent = '+';
        plus.addEventListener('click', () => _v2InjectActiveAnswer(block, el, plus));
        wrap.appendChild(label);
        wrap.appendChild(plus);
        el.appendChild(wrap);
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

    _v2UpdateActiveHighlights(); // reflect an already-active answer immediately
  }

  function _v2CloseCvWindow() {
    const win = document.getElementById('jma-v2-cv-window');
    if (win) win.style.display = 'none';
  }

  // Requirement 1: minimize collapses the window into a small badge anchored
  // at a screen corner; clicking again restores it to its EXACT prior
  // position, not just wherever the badge happened to land. The snapshot is
  // taken at minimize time (not once at open time) so repeated minimize/drag/
  // minimize cycles always restore to the most recent full-size position.
  let _v2CvPrevPos = null; // {left, top} of the window just before it was minimized

  function _v2ToggleMinimizeCvWindow(win) {
    const minBtn = win.querySelector('#jma-v2-cv-min');
    const minimized = win.classList.toggle('jma-v2-cv-minimized');
    if (minimized) {
      const rect = win.getBoundingClientRect();
      _v2CvPrevPos = { left: win.style.left || `${rect.left}px`, top: win.style.top || `${rect.top}px` };
      if (minBtn) { minBtn.textContent = '▢'; minBtn.title = 'שחזור לגודל מלא'; }
    } else {
      if (_v2CvPrevPos) {
        win.style.left = _v2CvPrevPos.left;
        win.style.top  = _v2CvPrevPos.top;
      }
      if (minBtn) { minBtn.textContent = '_'; minBtn.title = 'מזעור'; }
    }
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
      if (win.classList.contains('jma-v2-cv-minimized')) return; // badge isn't draggable
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
        position:fixed!important;z-index:2147483647!important;
        min-width:230px;max-width:260px;
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
        position:fixed!important;top:0!important;right:-420px!important;
        left:auto!important;width:400px!important;height:100vh!important;
        z-index:2147483647!important;background:#14121F;
        border-left:2px solid #7C3AED;
        box-shadow:-8px 0 28px rgba(0,0,0,.4);
        transition:right .25s ease;
      }
      #jma-v2-panel.jma-v2-panel-open{right:0!important}
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
      .jma-v2-cv-header-actions{display:flex;gap:6px;flex-shrink:0}
      #jma-v2-cv-min,#jma-v2-cv-close{
        all:unset;cursor:pointer;width:24px;height:24px;text-align:center;
        line-height:24px;border-radius:7px;background:rgba(255,255,255,.15);
        font-size:12px;
      }
      #jma-v2-cv-min:hover,#jma-v2-cv-close:hover{background:rgba(255,255,255,.35)}

      /* ── Minimized state (requirement 1): collapse to a small badge
         anchored at a screen corner. !important is required here because a
         prior drag may have left a plain (non-important) inline left/top on
         the element, which this state must override; restoring removes the
         class and re-applies the pre-minimize position (see
         _v2ToggleMinimizeCvWindow), so no !important is needed for that. ── */
      #jma-v2-cv-window.jma-v2-cv-minimized{
        top:auto!important;left:16px!important;bottom:16px!important;
        right:auto!important;width:auto!important;height:auto!important;
        box-shadow:0 6px 18px rgba(20,15,45,.35);
      }
      #jma-v2-cv-window.jma-v2-cv-minimized #jma-v2-cv-header{
        border-radius:20px;padding:8px 12px;
      }
      #jma-v2-cv-window.jma-v2-cv-minimized #jma-v2-cv-active-hint,
      #jma-v2-cv-window.jma-v2-cv-minimized #jma-v2-cv-paper{display:none}
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
      .jma-v2-cv-plus-wrap{
        position:absolute;top:2px;inset-inline-end:-4px;z-index:1;
        display:flex;align-items:center;gap:6px;direction:rtl;
      }
      .jma-v2-cv-plus{
        all:unset;cursor:pointer;flex-shrink:0;width:26px;height:26px;
        text-align:center;line-height:24px;border-radius:50%;
        font-size:17px;font-weight:800;
        background:#7C3AED;color:#fff;box-shadow:0 3px 8px rgba(124,58,237,.45);
        transition:transform .12s ease, background .12s ease;
      }
      .jma-v2-cv-plus:hover{transform:scale(1.18);background:#6D28D9}
      .jma-v2-plus-nag{animation:jmaV2Nag .3s ease 2}
      @keyframes jmaV2Nag{50%{transform:translateX(4px);background:#DC2626}}

      /* ── Requirement 2: dynamic label + coordinated glow ──────────────────
         Mirrors the panel's .jma-v2-active-question pulse (same purple, same
         rhythm) so the two sides read as one linked state. */
      .jma-v2-cv-plus-label{
        display:none;font-size:10.5px;font-weight:700;color:#5B21B6;
        background:#fff;border:1px solid #C9B8F0;border-radius:8px;
        padding:2px 8px;white-space:nowrap;max-width:170px;overflow:hidden;
        text-overflow:ellipsis;box-shadow:0 2px 6px rgba(124,58,237,.2);
        font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
        animation:jmaV2LabelIn .18s ease;
      }
      @keyframes jmaV2LabelIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
      .jma-v2-cv-block.jma-v2-active-target .jma-v2-cv-plus-label{display:inline-block}
      .jma-v2-cv-block.jma-v2-active-target{
        outline:2px solid #7C3AED;outline-offset:3px;border-radius:8px;
        animation:jmaV2TargetPulse 1.6s ease-in-out infinite;
      }
      @keyframes jmaV2TargetPulse{
        0%,100%{box-shadow:0 0 0 0 rgba(124,58,237,.3)}
        50%{box-shadow:0 0 14px 3px rgba(124,58,237,.4)}
      }
      .jma-v2-cv-block.jma-v2-active-target .jma-v2-cv-plus{
        background:#7C3AED;animation:jmaV2PlusPulse 1.6s ease-in-out infinite;
      }
      @keyframes jmaV2PlusPulse{50%{transform:scale(1.14)}}
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
