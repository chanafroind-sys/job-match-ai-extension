// ═════════════════════════════════════════════════════════════════════════
// JMA V2 questions wizard — physical 1:1 copy of the V1 flow from popup.js
// (frozen), per the replication contract. Provenance of each block is noted.
//
// Documented deltas vs. V1 (everything else is verbatim):
//   1. SSE endpoint → /api/v2/stream-questions  (THE functional change)
//   2. Storage namespace → jma_v2_recent_jobs / jma_v2_pf_* / jma_v2_answer_bank
//      (V1 keys are never written; shared user config — licenseKey, cvText,
//      enableTracking, and the pre-click local matcher score — is read-only)
//   3. Content-script messages → jmaV2RunPipeline / jmaV2GetJobText
//      (V1 actions like runFabPipeline / getJobText would execute V1 code)
//   4. updateFabScore message removed — the FAB is V1-owned UI
//   5. The 60s preflight poll is skipped: V2 has no background preflight
//      writer yet, so polling would always burn the full 60s
//   6. V2 addition: active-answer bridge — focus/typing posts the current
//      answer to the parent page so the floating CV window's + buttons know
//      what to inject (new interaction model, not a rewrite of cloned logic)
// ═════════════════════════════════════════════════════════════════════════

// ── State — copy of popup.js:1-28 ──────────────────────────────────────────
let stateG = {
  licenseKey: '',
  cvText: '',
  cvName: '',
};
let stateQ = {
  jobText: '',
  jobLanguage: 'english',
  jobPlatform: '',
  jobUrl: '',
  jobTitle: '',
  analysis: null,
  questions: [],
  answers: [],
  generatedCV: '',
  cvIsRtl: false,
  baseScore: 0,   // score before user answers (from preflight pass-1)
  gapPct: 0,      // max points available from answering questions
};
const state = stateQ;

let cvOptions = { language: 'english', format: 'docx', coverLetter: false, tracking: true, model: 'sonnet' };

// ── V2 storage namespace (delta 2) ──────────────────────────────────────────
const V2_JOBS_KEY = 'jma_v2_recent_jobs';
const BACKEND = 'https://job-match-ai-extension.onrender.com';

// ── Job-state persistence — copy of popup.js:37-108 (key → jma_v2_*) ────────
async function getRecentJobsArray() {
  const res = await chrome.storage.local.get([V2_JOBS_KEY]);
  return res[V2_JOBS_KEY] || [];
}

const JOB_FIELDS = [
  'url', 'jobUrl', 'jobText', 'jobTitle', 'jobPlatform', 'jobLanguage',
  'wizard_step', 'baseScore', 'bullets', 'ts', 'activelyOpened',
  'analysis', 'questions', 'answers', 'generatedCV', 'coverLetterText',
  'cvLanguage', 'gapPct', 'sentToRecruiter', 'referralStatus'
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
  // 🔥 בפופ-אפ אסור location.href (יהיה chrome-extension://). URL רק מהסטייט.
  const url = stateQ.jobUrl;
  if (!url || url.startsWith('chrome-extension://')) {
    console.warn('[JMA:V2] saveJobState skipped - no valid job URL in stateQ');
    return;
  }

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

  await chrome.storage.local.set({ [V2_JOBS_KEY]: jobs });
}

async function loadJobState(url) {
  const targetUrl = url || stateQ.jobUrl || null;
  if (!targetUrl || targetUrl.startsWith('chrome-extension://')) return null;

  const jobs = await getRecentJobsArray();
  const job = jobs.find(j => j.url === targetUrl);

  if (!job) return null;

  if ((Date.now() - job.ts) > 4 * 60 * 60 * 1000) {
    const filteredJobs = jobs.filter(j => j.url !== targetUrl);
    await chrome.storage.local.set({ [V2_JOBS_KEY]: filteredJobs });
    return null;
  }

  return job;
}

// ── Title cleanup + URL keys — copy of popup.js:158-191 (pf key → v2) ───────
function _cleanPageTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s*[\|–\-]\s*(LinkedIn|Indeed|Glassdoor|Drushim|AllJobs|JobMaster|Comeet|Greenhouse|Lever|Workable|SmartRecruiters|Gotfriends|HeyAnter|Jobify360|Nvidia Jobs|Jobs).*/i, '')
    .replace(/\s*[\|–\-]\s*(דרושים|כל הג'ובים|ג'ובמסטר|חיפוש עבודה|משרות|לינקדאין).*/i, '')
    .replace(/Apply.*$/i, '')
    .trim()
    .slice(0, 80);
}

function _urlHash(url) {
  let h = 0;
  for (let i = 0; i < (url || '').length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function _prefKey(url)       { return `jma_v2_pf_${_urlHash(url)}`; }
// Read-only V1 key: the local matcher score is produced PRE-click (before the
// replication boundary) by the passive V1 FAB scorer — V2 reads, never writes.
function _localScoreKey(url) { return `jma_local_score_${_urlHash(url)}`; }

// ── Screen management — copy of popup.js:226-229 ────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

// ── Main loading / error — copy of popup.js:776-802 ─────────────────────────
function showMainError(msg) {
  hideMainLoading();
  document.getElementById('mainLoading').style.display = 'none';
  document.getElementById('mainErrorMsg').textContent = msg;
  document.getElementById('mainError').style.display = 'block';
}

let _loadingHintTimer = null;

function showMainLoading(text) {
  document.getElementById('mainLoading').style.display = 'block';
  document.getElementById('mainError').style.display = 'none';
  document.getElementById('loadingHint').style.display = 'none';
  document.getElementById('loadingText').textContent = text || 'מנתח את דף המשרה...';
  clearTimeout(_loadingHintTimer);
  _loadingHintTimer = setTimeout(() => {
    document.getElementById('loadingHint').style.display = 'block';
    document.getElementById('loadingText').textContent = 'מנתחת... עוד רגע ☕';
  }, 8000);
}

function hideMainLoading() {
  clearTimeout(_loadingHintTimer);
  document.getElementById('loadingHint').style.display = 'none';
}

// ── Preflight cache loader — copy of popup.js:1083-1101 ─────────────────────
function _loadPreflightCache(pCache) {
  // Prefer AI score, but if it looks like the server's uncertainty fallback (50–65)
  // AND we already have a local-matcher score, keep whichever is higher.
  const aiScore = pCache.base_score ?? 0;
  const localScore = state.baseScore || 0; // set earlier from jma_local_score
  state.baseScore = aiScore > 0 ? Math.max(aiScore, localScore > 0 ? localScore : 0) : localScore;
  state.gapPct    = pCache.gap_pct    ?? 0;
  state.questions = pCache.questions  || [];
  state.analysis  = {
    score:       pCache.base_score  ?? 0,
    jobTitle:    pCache.jobTitle    || '',
    company:     pCache.company     || '',
    jobLanguage: pCache.jobLanguage || state.jobLanguage || 'english',
    summary:     pCache.summary     || '',
    strengths:   pCache.strengths   || [],
    hard_gaps:   pCache.hard_gaps   || [],
  };
  saveJobState({ analysis: state.analysis, baseScore: state.baseScore, gapPct: state.gapPct, questions: state.questions });
}

// ── Waiting screen — copy of popup.js:1104-1123 ─────────────────────────────
function _showQuestionsWaiting() {
  showScreen('questions');
  const container = document.getElementById('questionsContainer');
  container.innerHTML = `
    <div class="pf-wait-wrap">
      <div class="pf-wait-icon">🔍</div>
      <div class="pf-wait-title" id="pfWaitLabel">מנתח את המשרה...</div>
      <div class="pf-wait-bar"><div class="pf-wait-fill" id="pfWaitFill"></div></div>
      <div class="pf-wait-hint">מכינים שאלות פער ממוקדות עבורך</div>
    </div>`;
  const labels = ['מנתח את המשרה...', 'מזהה פערי מיומנויות...', 'מחשב משקלים...', 'מכין שאלות ממוקדות...', 'כמעט מוכן...'];
  let i = 0;
  const t = setInterval(() => {
    const el = document.getElementById('pfWaitLabel');
    if (!el) { clearInterval(t); return; }
    el.textContent = labels[i++ % labels.length];
  }, 1800);
  return () => clearInterval(t);
}

// ── Flow orchestrator — copy of popup.js:1125-1243 (deltas 3 + 5 marked) ────
async function startFlow() {
  showScreen('main');
  showMainLoading('טוען...');

  // ── 1. Load credentials (shared user config — read-only) ─────────────────
  const stored = await chrome.storage.local.get(['licenseKey', 'cvText', 'cvHyperlinkUrls', 'userConstraints', 'enableTracking']);
  if (!stored.licenseKey) { showMainError('לא נמצא רישיון פעיל. חזרי למסך הראשי.'); return; }
  if (!stored.cvText)     { showMainError('עוד לא הועלו קורות חיים. לחצי על ⚙️ כדי להוסיף.'); return; }
  state.licenseKey      = stored.licenseKey;
  state.cvText          = stored.cvText;
  state.cvHyperlinkUrls = stored.cvHyperlinkUrls || [];
  state.userConstraints = stored.userConstraints || '';
  cvOptions.tracking    = stored.enableTracking !== false;

  // ── 2. Get job text from active tab ──────────────────────────────────────
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // מפעילים את צינור ה-V2 המלא ב-content script (delta 3: jmaV2RunPipeline)
  let pipeRes = null;
  try {
    pipeRes = await chrome.tabs.sendMessage(tab.id, { action: 'jmaV2RunPipeline' });
  } catch (e) {
    console.warn('[JMA:V2] content script unavailable, falling back:', e);
  }

  if (pipeRes?.ok) {
    // הצינור שמר הכל ל-storage - טוענים ומעדכנים את ה-state בזיכרון
    state.jobUrl = pipeRes.url || state.jobUrl;
    const saved = await loadJobState(state.jobUrl);
    if (saved) Object.assign(state, saved);
  } else {
    // fallback: חילוץ ישיר דרך ה-content script של V2 (delta 3: jmaV2GetJobText)
    let tabResult;
    try {
      tabResult = await chrome.tabs.sendMessage(tab.id, { action: 'jmaV2GetJobText' });
    } catch { showMainError('לא הצלחנו לקרוא את הדף. נסי לרענן (F5) ואז לפתוח שוב.'); return; }

    if (!tabResult?.text || tabResult.text.length < 100) {
      showMainError('לא זוהתה משרה בעמוד זה. פתחי את דף המשרה הספציפי ונסי שוב.');
      return;
    }

    state.jobText     = tabResult.text;
    state.jobLanguage = tabResult.language || 'english';
    state.jobPlatform = tabResult.platform || '';
    state.jobUrl      = tabResult.url || '';
    state.jobTitle    = _cleanPageTitle(tabResult.h1Title || tabResult.ogTitle || tabResult.title || '');
    // Seed baseScore from local matcher (fixes arbitrary 65% default from AI fallback)
    const localStored = await chrome.storage.local.get([_localScoreKey(state.jobUrl), 'jma_is_premium']);
    if (localStored[_localScoreKey(state.jobUrl)]) state.baseScore = localStored[_localScoreKey(state.jobUrl)];
    cvOptions._isPremium = !!localStored.jma_is_premium;
    await saveJobState({
      jobText: state.jobText,
      jobTitle: state.jobTitle,
      jobLanguage: state.jobLanguage,
      jobPlatform: state.jobPlatform,
      baseScore: state.baseScore || 0,
      wizard_step: 'questions',
      activelyOpened: true,
    });
  }

  // ── 3. Check preflight cache (V2 namespace) ───────────────────────────────
  const pKey = _prefKey(state.jobUrl);
  const pCache = (await chrome.storage.local.get([pKey]))[pKey];
  const fresh = pCache && (Date.now() - pCache.ts) < 10 * 60 * 1000 && pCache.questions?.length > 0;

  if (fresh) {
    _loadPreflightCache(pCache);
    chrome.storage.local.remove([pKey]);
    showQuestionsScreen(pCache.questions);
    return;
  }

  // ── 4. (delta 5) V1 polls storage for up to 60s here waiting for its
  // background preflight. V2 has no preflight writer yet, so the poll would
  // always time out at the full 60s — skipped until a V2 preflight exists. ──

  // ── 5. Stream questions live ──────────────────────────────────────────────
  await streamQuestionsIntoScreen();
}

// ── Answer scoring heuristics — copy of popup.js:1279-1316 (delta 4) ────────
let _scoreDebounceTimer = null;

function _analyzeAnswer(text) {
  if (!text || text.trim().length < 3) return 0;
  const t = text.trim().toLowerCase();
  if (/^כן,?\s*יש לי ניסיון/.test(t)) return 100;
  if (/^מכיר(\.?)$|^תיאורטי|^מכיר את התחום ברמה תיאורטית/.test(t)) return 40;
  if (/^אין לי ניסיון בתחום זה/.test(t)) return 0;
  if (/אין לי|no experience|don't have|לא מכיר|לא יודע|never used|אף פעם|לא עבדתי/.test(t)) return 5;
  if (/תיאורטי|theoretical|familiar with|מכיר.*קצת|heard of|שמעתי|קראתי|no hands.on/.test(t)
      && !/(עבדתי|built|developed|worked|שנה|years)/.test(t)) return 35;
  let s = 15 + Math.min(20, Math.floor(t.length / 9));
  if (/(עבדתי|worked|developed|built|managed|led|הובלתי|פיתחתי)/.test(t)) s += 20;
  if (/(שנה|שנתיים|שנים|year|years)/.test(t)) s += 15;
  if (/(פרויקט|project|production|פרודקשן|live|deployed)/.test(t)) s += 15;
  if (/(מומחה|expert|advanced|senior|מוביל|lead|architect)/.test(t)) s += 15;
  if (/(ניסיון|experience|extensive|רב|בכיר)/.test(t)) s += 10;
  if (/(מאוד|very|highly|deeply|extensively)/.test(t)) s += 8;
  if (/(קצת|little|basic|בסיסי|beginner|מתחיל)/.test(t)) s -= 15;
  if (/(לא הרבה|not much|limited|מוגבל)/.test(t)) s -= 10;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function _updateQuestionsScore() {
  const base = state.baseScore || 0;
  if (!state.questionScores) state.questionScores = {};
  let bonus = 0;
  (state.questions || []).forEach((q, idx) => {
    const pct = state.questionScores[idx] ?? 0;
    bonus += (pct / 100) * (q.weight || 0);
  });
  const score = Math.min(100, Math.round(base + bonus));
  const fill = document.getElementById('qsScoreFill');
  const val  = document.getElementById('qsScoreValue');
  if (fill) fill.style.width = `${score}%`;
  if (val)  val.textContent  = `${score}%`;
  // delta 4: V1 sends {action:'updateFabScore'} here — the FAB is V1-owned UI,
  // so V2 does not message it.
}

// ── V2 addition (delta 6): active-answer bridge to the floating CV window ───
// Whenever the user focuses or types an answer, the parent page (v2_content.js)
// is told what the "active answer" is, so the CV window's + buttons can inject
// it. Posted to the host page; carries only the user's own typed answer.
function _announceActiveAnswer(idx) {
  const q  = state.questions?.[idx];
  const ta = document.getElementById(`qs_ta_${q?.id ?? idx}`);
  const text = (ta?.value || '').trim();
  try {
    window.parent.postMessage({
      type:  'jmaV2ActiveAnswer',
      idx:   idx,
      skill: q?.skill || '',
      text:  text,
    }, '*');
  } catch { /* not inside the panel iframe — nothing to announce */ }
}

// ── Questions screen (cached path) — copy of popup.js:1318-1406 ─────────────
function showQuestionsScreen(questions, savedAnswers) {
  const container = document.getElementById('questionsContainer');
  container.innerHTML = '';

  const base = state.baseScore || 0;
  const scoreBar = document.createElement('div');
  scoreBar.className = 'questions-score-bar';
  scoreBar.innerHTML = `
    <span class="qs-score-label">ציון נוכחי</span>
    <div class="qs-score-track"><div class="qs-score-fill" id="qsScoreFill" style="width:${base}%"></div></div>
    <span class="qs-score-value" id="qsScoreValue">${base}%</span>
  `;
  container.appendChild(scoreBar);

  if (!state.questionScores) state.questionScores = {};

  questions.forEach((q, idx) => {
    const taId = `qs_ta_${q.id || idx}`;
    const card = document.createElement('div');
    card.className = 'question-card';
    card.innerHTML = `
      <div class="question-skill">${q.skill}</div>
      <div class="question-text">${q.question}</div>
      ${q.heExplanation ? `<div class="question-he-exp">💡 ${q.heExplanation}</div>` : ''}
      ${q.why ? `<div class="question-why">🎯 ${q.why}</div>` : ''}
      <div class="quick-answers">
        <button class="qa-btn qa-yes" data-val="100" data-idx="${idx}">✅ כן, יש לי ניסיון</button>
        <button class="qa-btn qa-partial" data-val="40" data-idx="${idx}">📚 תיאורטי בלבד</button>
        <button class="qa-btn qa-no" data-val="0" data-idx="${idx}">❌ בכלל לא</button>
      </div>
      <textarea class="q-textarea" id="${taId}"
        placeholder="פרט בקצרה (אופציונלי)..." rows="2"
        data-idx="${idx}" data-weight="${q.weight || 0}"></textarea>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.qa-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const val = parseInt(btn.dataset.val);
      state.questionScores[idx] = val;
      const row = btn.closest('.quick-answers');
      row.querySelectorAll('.qa-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const ta = document.getElementById(`qs_ta_${questions[idx]?.id || idx}`);
      if (ta && !ta.value.trim()) {
        ta.value = val === 100 ? 'כן, יש לי ניסיון בתחום זה.' : val === 40 ? 'מכיר את התחום ברמה תיאורטית.' : 'אין לי ניסיון בתחום זה.';
      }
      _updateQuestionsScore();
      _persistAnswersDebounced();
      _announceActiveAnswer(idx); // V2 addition (delta 6)
    });
  });

  container.querySelectorAll('.q-textarea').forEach(ta => {
    ta.addEventListener('focus', () => _announceActiveAnswer(parseInt(ta.dataset.idx))); // V2 addition
    ta.addEventListener('input', () => {
      _announceActiveAnswer(parseInt(ta.dataset.idx)); // V2 addition (delta 6)
      clearTimeout(_scoreDebounceTimer);
      _scoreDebounceTimer = setTimeout(() => {
        const idx = parseInt(ta.dataset.idx);
        state.questionScores[idx] = _analyzeAnswer(ta.value);
        const card = ta.closest('.question-card');
        card?.querySelectorAll('.qa-btn').forEach(b => b.classList.remove('selected'));
        _updateQuestionsScore();
        _persistAnswersDebounced();
      }, 600);
    });
  });

  if (savedAnswers && savedAnswers.length > 0) {
    savedAnswers.forEach((a, idx) => {
      const q = questions[idx];
      if (!q || !a.answer || a.answer === 'לא ענה') return;
      const ta = document.getElementById(`qs_ta_${q.id || idx}`);
      if (ta) ta.value = a.answer;
      state.questionScores[idx] = a.sliderValue ?? _analyzeAnswer(a.answer);
    });
    _updateQuestionsScore();
  }

  showScreen('questions');
}

// ── Live streaming questions — copy of popup.js:1495-1690 (delta 1) ─────────
// Calls /api/v2/stream-questions which runs Pass 1 (score) then streams
// questions token-by-token. The textarea for each question is inserted the
// moment q_open arrives — before the sentence ends — so the user can start
// typing while remaining questions are still streaming.
async function streamQuestionsIntoScreen() {
  console.log('[JMA:V2:stream] streaming questions into screen...');
  state.questions      = [];
  state.questionScores = {};

  // ── Build skeleton UI ─────────────────────────────────────────────────────
  showScreen('questions');
  const container = document.getElementById('questionsContainer');
  container.innerHTML = '';

  const scoreBar = document.createElement('div');
  scoreBar.className = 'questions-score-bar';
  scoreBar.innerHTML = `
    <span class="qs-score-label">ציון נוכחי</span>
    <div class="qs-score-track"><div class="qs-score-fill" id="qsScoreFill" style="width:0%"></div></div>
    <span class="qs-score-value" id="qsScoreValue">…</span>`;
  container.appendChild(scoreBar);

  const qArea = document.createElement('div');
  qArea.id = 'qsStreamArea';
  container.appendChild(qArea);

  const loader = document.createElement('div');
  loader.id = 'qsLoader';
  loader.className = 'qs-stream-loader';
  loader.textContent = 'מנתח פערים…';
  qArea.appendChild(loader);

  // ── SSE fetch ─────────────────────────────────────────────────────────────
  const stored = await chrome.storage.local.get(['licenseKey', 'cvText']);
  const licenseKey = stored.licenseKey || state.licenseKey || '';

  // Per-question card registry: id → {card, textEl, idx}
  const _cards = {};

  function _wireCard(card, idx) {
    card.querySelectorAll('.qa-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.idx);
        state.questionScores[i] = parseInt(btn.dataset.val);
        btn.closest('.quick-answers').querySelectorAll('.qa-btn')
          .forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const ta = document.getElementById(`qs_ta_${state.questions[i]?.id ?? i}`);
        if (ta && !ta.value.trim()) {
          ta.value = btn.dataset.val === '100' ? 'כן, יש לי ניסיון בתחום זה.'
                   : btn.dataset.val === '40'  ? 'מכיר את התחום ברמה תיאורטית.'
                   : 'אין לי ניסיון בתחום זה.';
        }
        if (state.questions[i]) {
          state.answers[i] = ta ? ta.value : btn.textContent;
        }
        _updateQuestionsScore();
        _persistAnswersDebounced();
        _announceActiveAnswer(i); // V2 addition (delta 6)
      });
    });
    const ta = card.querySelector('.q-textarea');
    ta?.addEventListener('focus', () => _announceActiveAnswer(parseInt(ta.dataset.idx))); // V2 addition
    ta?.addEventListener('input', () => {
      _announceActiveAnswer(parseInt(ta.dataset.idx)); // V2 addition (delta 6)
      clearTimeout(_scoreDebounceTimer);
      _scoreDebounceTimer = setTimeout(() => {
        const i = parseInt(ta.dataset.idx);
        state.questionScores[i] = _analyzeAnswer(ta.value);
        state.answers[i] = ta.value;
        ta.closest('.question-card')?.querySelectorAll('.qa-btn')
          .forEach(b => b.classList.remove('selected'));
        _updateQuestionsScore();
        _persistAnswersDebounced();
      }, 600);
    });
  }

  try {
    // delta 1: THE functional change — V2 endpoint instead of /api/stream-questions
    const resp = await fetch(`${BACKEND}/api/v2/stream-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': licenseKey },
      body: JSON.stringify({
        cvText:    stored.cvText || state.cvText || '',
        jobText:   state.jobText || '',
        model:     cvOptions.model || 'sonnet',
        baseScore: state.baseScore || -1,
        gapPct:    state.gapPct    || -1,
      }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') break;
        let chunk;
        try { chunk = JSON.parse(raw); } catch { continue; }

        if (chunk.error) {
          showMainError(chunk.error);
          return;
        }

        // ── {meta} — Pass 1 result ───────────────────────────────────────
        if (chunk.meta) {
          const m = chunk.meta;
          if (m.base_score != null) {
            _loadPreflightCache({ ...m, ts: Date.now(), questions: [] });
            const fill = document.getElementById('qsScoreFill');
            const val  = document.getElementById('qsScoreValue');
            if (fill) fill.style.width = `${state.baseScore}%`;
            if (val)  val.textContent  = `${state.baseScore}%`;
          }
          document.getElementById('qsLoader')?.remove();
        }

        // ── {q_open} — new question starts ──────────────────────────────
        else if (chunk.q_open) {
          const meta = chunk.q_open;
          const idx  = state.questions.length;
          state.questions.push({ id: meta.id, skill: meta.skill, weight: meta.weight || 0, question: '' });

          const taId = `qs_ta_${meta.id ?? idx}`;
          const card = document.createElement('div');
          card.className = 'question-card qs-streaming';
          card.innerHTML = `
            <div class="question-skill">${meta.skill || ''}</div>
            <div class="question-text" id="qtext_${meta.id}"></div>
            <div class="quick-answers">
              <button class="qa-btn qa-yes"     data-val="100" data-idx="${idx}">✅ כן, יש לי ניסיון</button>
              <button class="qa-btn qa-partial" data-val="40"  data-idx="${idx}">📚 תיאורטי בלבד</button>
              <button class="qa-btn qa-no"      data-val="0"   data-idx="${idx}">❌ בכלל לא</button>
            </div>
            <textarea class="q-textarea" id="${taId}"
              placeholder="פרט בקצרה (אופציונלי)…" rows="2"
              data-idx="${idx}" data-weight="${meta.weight || 0}" dir="auto"></textarea>`;
          qArea.appendChild(card);
          _wireCard(card, idx);
          _cards[meta.id] = { card, idx };
          qArea.scrollTop = qArea.scrollHeight;
        }

        // ── {q_token} — append text to current question ──────────────────
        else if (chunk.q_token) {
          const { id, text } = chunk.q_token;
          const el = document.getElementById(`qtext_${id}`);
          if (el) { el.textContent += text; qArea.scrollTop = qArea.scrollHeight; }
          const q = state.questions.find(q => q.id === id);
          if (q) q.question += text;
        }

        // ── {q_close} — explanation received, card complete ──────────────
        else if (chunk.q_close) {
          const { id, explanation } = chunk.q_close;
          const info = _cards[id];
          if (info && explanation) {
            const exp = document.createElement('div');
            exp.className = 'question-he-exp';
            exp.textContent = `💡 ${explanation}`;
            const qa = info.card.querySelector('.quick-answers');
            info.card.insertBefore(exp, qa);
            const q = state.questions.find(q => q.id === id);
            if (q) { q.explanation = explanation; q.heExplanation = explanation; }
          }
          _cards[id]?.card.classList.remove('qs-streaming');
        }
      }
    }
  } catch (err) {
    console.error('[JMA:V2:stream-q]', err);
    document.getElementById('qsLoader')?.remove();
    if (!state.questions.length) {
      const errEl = document.createElement('div');
      errEl.style.cssText = 'color:#ef4444;padding:16px;text-align:center;';
      errEl.textContent = 'שגיאה בטעינת שאלות. ניתן לדלג ישירות לניתוח.';
      qArea.appendChild(errEl);
    }
  }

  // 💾 שמירת השאלות שהוזרמו למערך המשרות
  if (state.questions.length > 0) {
    await saveJobState({ questions: state.questions, wizard_step: 'questions' });
  }
}

// ── Answer persistence — copy of popup.js:1692-1731 (bank key → v2) ─────────
let _answersSaveTimer = null;
function _persistAnswersDebounced() {
  clearTimeout(_answersSaveTimer);
  _answersSaveTimer = setTimeout(() => {
    saveJobState({ answers: collectAnswers() });
  }, 1500);
}

const ANSWER_BANK_KEY = 'jma_v2_answer_bank';
async function updateAnswerBank(answers, jobTitle) {
  try {
    const stored = await chrome.storage.local.get([ANSWER_BANK_KEY]);
    const bank = stored[ANSWER_BANK_KEY] || [];
    for (const a of (answers || [])) {
      const txt = (a.answer || '').trim();
      if (!txt || txt === 'לא ענה' || txt.length < 4) continue; // רק תשובות אמיתיות
      const rec = {
        skill: a.skill || '', answer: txt.slice(0, 300),
        sliderValue: a.sliderValue ?? null, jobTitle: (jobTitle || '').slice(0, 80),
        ts: Date.now(),
      };
      const idx = bank.findIndex(b => (b.skill || '').toLowerCase() === rec.skill.toLowerCase());
      if (idx !== -1) bank[idx] = rec; else bank.unshift(rec); // עדכני גובר על ישן
    }
    await chrome.storage.local.set({ [ANSWER_BANK_KEY]: bank.slice(0, 100) });
  } catch (e) { console.warn('[JMA:V2] answer bank update failed:', e); }
}

function collectAnswers() {
  return (state.questions || []).map((q, idx) => {
    const ta     = document.getElementById(`qs_ta_${q.id || idx}`);
    const answer = ta ? ta.value.trim() : '';
    const scorePct = state.questionScores?.[idx] ?? _analyzeAnswer(answer);
    return { skill: q.skill, answer: answer || 'לא ענה', sliderValue: scorePct, weight: q.weight || 0 };
  });
}

// ── Wizard footer buttons — V2 Phase-2 boundary ──────────────────────────────
// V1 continues into the fit-strategy / CV-generation flow here; that arrives in
// the next phase (fit diagnosis + finalize). For now answers are persisted and
// the user is told the placements are saved.
async function _finishQuestions(skipped) {
  const answers = collectAnswers();
  state.answers = answers;
  await saveJobState({ answers, wizard_step: 'questions_done' });
  if (!skipped) await updateAnswerBank(answers, state.jobTitle);

  const container = document.getElementById('questionsContainer');
  const note = document.createElement('div');
  note.className = 'v2-done-note';
  note.textContent = skipped
    ? '✔️ דילגת על השאלות. שלב הסיום (אבחון התאמה + יצירת קו"ח) יגיע בפאזה הבאה של V2.'
    : '✔️ התשובות והמיקומים שסימנת בחלון הקו"ח נשמרו. שלב הסיום (אבחון התאמה + יצירת קו"ח) יגיע בפאזה הבאה של V2.';
  container.appendChild(note);
  note.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnRetry')?.addEventListener('click', () => startFlow());
  document.getElementById('btnContinueToCV')?.addEventListener('click', () => _finishQuestions(false));
  document.getElementById('btnSkipQuestions')?.addEventListener('click', () => _finishQuestions(true));
  startFlow();
});
