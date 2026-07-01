// State
let state = {
  licenseKey: '',
  cvText: '',
  cvName: '',
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

let cvOptions = { language: 'english', format: 'docx', coverLetter: false };

// ── Per-URL job state persistence ────────────────────────────────────────────
function jobStateKey(url) {
  let h = 0;
  for (let i = 0; i < (url || '').length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return `jma_job_${Math.abs(h).toString(36)}`;
}
async function saveJobState(updates) {
  if (!state.jobUrl) return;
  const key = jobStateKey(state.jobUrl);
  const prev = (await chrome.storage.local.get([key]))[key] || {};
  await chrome.storage.local.set({ [key]: { ...prev, ...updates, url: state.jobUrl, ts: Date.now() } });
}
async function loadJobState(url) {
  if (!url) return null;
  const key = jobStateKey(url);
  const d = (await chrome.storage.local.get([key]))[key];
  if (!d || (Date.now() - d.ts) > 4 * 60 * 60 * 1000) return null;
  return d;
}

function _prefKey(url) {
  let h = 0;
  for (let i = 0; i < (url || '').length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return `jma_pf_${Math.abs(h).toString(36)}`;
}

// Typewriter effect — fills el.textContent character by character
function _typewriter(el, text, speed = 16) {
  el.textContent = '';
  let i = 0;
  const timer = setInterval(() => {
    if (i >= text.length) { clearInterval(timer); return; }
    el.textContent += text[i++];
  }, speed);
  return timer;
}

function _applyUpgradeUrl(result) {
  const url = result && result.upgradeUrl;
  if (!url) return;
  const link = document.getElementById('linkUpgradePremium');
  if (link) link.href = url;
}

// Screen management
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

// Score ring animation
function animateScore(score, color) {
  const circle = document.getElementById('scoreCircle');
  const numEl = document.getElementById('scoreNumber');
  const circumference = 213.6;
  const offset = circumference - (score / 100) * circumference;
  circle.style.stroke = color;
  circle.style.strokeDashoffset = offset;
  let current = 0;
  const step = score / 40;
  const interval = setInterval(() => {
    current = Math.min(current + step, score);
    numEl.textContent = Math.round(current);
    if (current >= score) clearInterval(interval);
  }, 16);
}

function scoreColor(score) {
  if (score >= 75) return '#3fb950';
  if (score >= 55) return '#d29922';
  if (score >= 35) return '#e3812b';
  return '#f85149';
}

function verdictInfo(score) {
  if (score >= 75) return { label: '⭐ מעולה', cls: 'verdict-great' };
  if (score >= 55) return { label: '👍 טוב', cls: 'verdict-good' };
  if (score >= 35) return { label: '🤔 בינוני', cls: 'verdict-ok' };
  return { label: '❌ לא מתאים', cls: 'verdict-bad' };
}

// Decompress DEFLATE-compressed data using DecompressionStream
async function inflateRaw(compressedBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { result.set(c, pos); pos += c.length; }
  return result;
}

// Extract text from DOCX file (handles DEFLATE-compressed ZIP entries)
async function extractDocxText(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);

    const findFile = async (name) => {
      for (let i = 0; i < bytes.length - 30; i++) {
        if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x03 && bytes[i+3] === 0x04) {
          const compression = bytes[i+8] | (bytes[i+9] << 8);
          const compressedSize = bytes[i+18] | (bytes[i+19] << 8) | (bytes[i+20] << 16) | (bytes[i+21] << 24);
          const fnLen = bytes[i+26] | (bytes[i+27] << 8);
          const extraLen = bytes[i+28] | (bytes[i+29] << 8);
          const fnStart = i + 30;
          const fn = new TextDecoder().decode(bytes.slice(fnStart, fnStart + fnLen));
          if (fn === name) {
            const dataStart = fnStart + fnLen + extraLen;
            const data = bytes.slice(dataStart, dataStart + compressedSize);
            return compression === 8 ? await inflateRaw(data) : data;
          }
        }
      }
      return null;
    };

    // Build rId → URL map from the relationships file
    const relsMap = {};
    const relsBytes = await findFile('word/_rels/document.xml.rels');
    if (relsBytes) {
      const relsXml = new TextDecoder('utf-8').decode(relsBytes);
      // Match any Relationship whose Target is an external http URL
      for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="(https?:[^"]+)"/g)) {
        relsMap[m[1]] = m[2];
      }
    }

    const xmlBytes = await findFile('word/document.xml');
    if (!xmlBytes) return null;

    let xml = new TextDecoder('utf-8').decode(xmlBytes);

    // Inject hyperlink URLs as plain text so Claude can see them naturally,
    // and collect them separately so the backend can add an explicit "must-include" instruction.
    const hyperlinkUrls = [];
    xml = xml.replace(
      /<w:hyperlink\b[^>]*\br:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/g,
      (_, rId, inner) => {
        const url = relsMap[rId];
        if (!url) return inner;
        hyperlinkUrls.push(url);
        // Append the raw URL to the last <w:t> inside the hyperlink so the
        // extracted text contains e.g. "chanimed03 https://github.com/chanimed03"
        const lastClose = inner.lastIndexOf('</w:t>');
        if (lastClose === -1) return inner;
        return inner.slice(0, lastClose) + ' ' + url + inner.slice(lastClose);
      }
    );

    // Split by paragraphs and extract w:t text
    const paras = xml.split(/<w:p[ >\/]/);
    let result = '';
    for (const para of paras) {
      const tMatches = [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
      if (tMatches.length > 0) {
        result += tMatches.map(m => m[1]).join('') + '\n';
      }
    }
    return { text: result.trim(), hyperlinkUrls };
  } catch (e) {
    console.error('DOCX extract error:', e);
    return null;
  }
}

// Read CV file
async function readCVFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'doc') {
    throw new Error('פורמט .doc לא נתמך. אנא המר ל-.docx');
  }
  if (ext === 'txt') {
    return await file.text();
  }
  if (ext === 'docx') {
    const buf = await file.arrayBuffer();
    const result = await extractDocxText(buf);
    if (!result?.text) throw new Error('לא ניתן לקרוא את הקובץ. נסה להמיר ל-.txt');
    return result; // { text, hyperlinkUrls }
  }
  if (ext === 'pdf') {
    // For PDF we store as base64 for Claude to process
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = reader.result.split(',')[1];
        resolve(`[PDF_BASE64:${b64}]`);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  throw new Error('פורמט לא נתמך');
}

// Checkbox → sentence mapping (single source of truth)
const CONSTRAINT_MAP = {
  constraintNoJobTitles:  'חוק קשיח: אל תשנה את כותרות התפקידים הרשמיות שלי (Job Titles) בשום אופן.',
  constraintProfileOnly:  'חוק קשיח: התאם אך ורק את פסקת הפתיחה / פרופיל (Summary). אל תשנה ואל תערוך את תוכן הניסיון התעסוקתי עצמו.',
  constraintNoDelete:     'חוק קשיח: אל תמחק ואל תקצר מקומות עבודה או תפקידים מהעבר כדי לחסוך במקום.',
  constraintBoldKeywords: 'הנחיה: סמן בכתב מודגש (Bold) מילות מפתח, טכנולוגיות וכלים קריטיים שמופיעים בדרישות המשרה לאורך קורות החיים.',
};

// Settings screen
async function loadSettings() {
  const data = await chrome.storage.local.get(['cvText', 'cvName', 'licenseKey', 'licenseValid', 'isPremium', 'userConstraints']);
  if (data.cvName) {
    document.getElementById('uploadText').textContent = `✅ ${data.cvName}`;
    document.getElementById('uploadArea').classList.add('has-file');
  }
  const statusEl = document.getElementById('licenseSettingsStatus');
  const keyInput = document.getElementById('licenseKeySettings');
  keyInput.value = '';
  if (data.licenseKey) {
    const k = data.licenseKey;
    const masked = k.length > 8 ? k.slice(0, 4) + '-****-****-' + k.slice(-4) : '****';
    statusEl.textContent = `נוכחי: ${masked}${data.isPremium ? ' ⭐ פרימיום' : ' (בסיסי)'}`;
    statusEl.style.color = data.licenseValid ? '#4caf50' : '#e53935';
  } else {
    statusEl.textContent = 'לא הוגדר מפתח רישיון';
    statusEl.style.color = '#e53935';
  }
  const constraintsSection = document.getElementById('premiumConstraintsSection');
  const constraintsInput = document.getElementById('userConstraintsInput');
  if (data.licenseKey) {
    constraintsSection.style.display = 'block';
    const text = data.userConstraints || '';
    constraintsInput.value = text;
    // Derive checkbox states from what sentences are present in the textarea
    Object.entries(CONSTRAINT_MAP).forEach(([id, sentence]) => {
      document.getElementById(id).checked = text.includes(sentence);
    });
  } else {
    constraintsSection.style.display = 'none';
  }
}

document.getElementById('uploadArea').addEventListener('click', () => {
  document.getElementById('cvFileInput').click();
});

document.getElementById('cvFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const cvResult = await readCVFile(file);
    const cvText = typeof cvResult === 'object' ? cvResult.text : cvResult;
    const cvHyperlinkUrls = typeof cvResult === 'object' ? (cvResult.hyperlinkUrls || []) : [];
    document.getElementById('uploadText').textContent = `✅ ${file.name}`;
    document.getElementById('uploadArea').classList.add('has-file');
    const successEl = document.getElementById('uploadSuccess');
    successEl.textContent = `הועלה: ${file.name} (${Math.round(file.size / 1024)} KB)`;
    successEl.style.display = 'block';
    // Store temporarily until "Save settings" is clicked
    document.getElementById('cvFileInput')._extractedText = cvText;
    document.getElementById('cvFileInput')._hyperlinkUrls = cvHyperlinkUrls;
    document.getElementById('cvFileInput')._fileName = file.name;
    document.getElementById('cvFileInput')._fileSize = file.size;
  } catch (err) {
    showSettingsError(err.message);
  }
});

function showSettingsError(msg) {
  const el = document.getElementById('settingsError');
  el.textContent = msg;
  el.style.display = 'block';
}

// Two-way sync: checkbox ↔ textarea
Object.entries(CONSTRAINT_MAP).forEach(([id, sentence]) => {
  document.getElementById(id).addEventListener('change', (e) => {
    const ta = document.getElementById('userConstraintsInput');
    if (e.target.checked) {
      if (!ta.value.includes(sentence)) {
        ta.value = ta.value.trim() ? ta.value.trim() + '\n' + sentence : sentence;
      }
    } else {
      ta.value = ta.value.split('\n')
        .filter(line => line.trim() !== sentence.trim())
        .join('\n')
        .trim();
    }
  });
});

document.getElementById('btnSaveSettings').addEventListener('click', async () => {
  const fileInput = document.getElementById('cvFileInput');
  const errEl = document.getElementById('settingsError');
  const statusEl = document.getElementById('licenseSettingsStatus');
  errEl.style.display = 'none';

  const toSave = {};
  if (fileInput._extractedText) {
    toSave.cvText = fileInput._extractedText;
    toSave.cvName = fileInput._fileName;
    toSave.cvSize = fileInput._fileSize;
    toSave.cvHyperlinkUrls = fileInput._hyperlinkUrls || [];
  }
  const constraintsInput = document.getElementById('userConstraintsInput');
  if (constraintsInput && document.getElementById('premiumConstraintsSection').style.display !== 'none') {
    toSave.userConstraints = constraintsInput.value.trim();
  }

  const newKey = document.getElementById('licenseKeySettings').value.trim();
  if (newKey) {
    const btn = document.getElementById('btnSaveSettings');
    btn.textContent = '⏳ מאמת מפתח...';
    btn.disabled = true;
    statusEl.textContent = 'מאמת...';
    statusEl.style.color = '#888';

    const res = await chrome.runtime.sendMessage({ action: 'verifyLicense', licenseKey: newKey });

    btn.textContent = '💾 שמור הגדרות';
    btn.disabled = false;

    if (res.error) {
      statusEl.textContent = '❌ ' + res.error;
      statusEl.style.color = '#e53935';
      errEl.textContent = res.error;
      errEl.style.display = 'block';
      return;
    }

    toSave.licenseKey = newKey;
    toSave.licenseValid = true;
    toSave.isPremium = !!(res.result && res.result.isPremium);
    state.licenseKey = newKey;
    _applyUpgradeUrl(res.result);
    statusEl.textContent = `✅ אומת: ${newKey.slice(0, 4)}-****-****-${newKey.slice(-4)}${toSave.isPremium ? ' ⭐ פרימיום' : ' (בסיסי)'}`;
    statusEl.style.color = '#4caf50';
    document.getElementById('licenseKeySettings').value = '';
  }

  if (Object.keys(toSave).length > 0) await chrome.storage.local.set(toSave);
  document.getElementById('btnSaveSettings').textContent = '✅ נשמר!';
  setTimeout(async () => {
    document.getElementById('btnSaveSettings').textContent = '💾 שמור הגדרות';
    await loadSettings();
  }, 800);
});

document.getElementById('btnSettingsBack').addEventListener('click', () => {
  showScreen('main');
});

// Header buttons
document.getElementById('btnSettings').addEventListener('click', () => {
  loadSettings();
  showScreen('settings');
});

document.getElementById('btnTracker').addEventListener('click', () => {
  showTrackerScreen();
});

document.getElementById('btnDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

document.getElementById('btnTrackerBack').addEventListener('click', () => {
  showScreen('main');
});

// Main screen
document.getElementById('btnRetry').addEventListener('click', startFlow);
document.getElementById('btnReanalyze').addEventListener('click', startFlow);
document.getElementById('btnGoSettings').addEventListener('click', () => {
  loadSettings();
  showScreen('settings');
});

function showMainError(msg) {
  hideMainLoading();
  document.getElementById('mainLoading').style.display = 'none';
  document.getElementById('mainResult').style.display = 'none';
  document.getElementById('mainErrorMsg').textContent = msg;
  document.getElementById('mainError').style.display = 'block';
}

let _loadingHintTimer = null;

function showMainLoading(text) {
  document.getElementById('mainLoading').style.display = 'block';
  document.getElementById('mainResult').style.display = 'none';
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

function showMainResult(analysis, doTypewriter = false) {
  hideMainLoading();
  document.getElementById('mainLoading').style.display = 'none';
  document.getElementById('mainError').style.display = 'none';
  document.getElementById('mainResult').style.display = 'block';

  const score = analysis.score || 0;
  const color = scoreColor(score);
  const verdict = verdictInfo(score);

  animateScore(score, color);

  document.getElementById('jobTitleEl').textContent = analysis.jobTitle || 'תפקיד לא זוהה';
  document.getElementById('companyEl').textContent = analysis.company || '';
  document.getElementById('verdictEl').innerHTML = `<span class="verdict-badge ${verdict.cls}">${verdict.label}</span>`;
  const summaryEl = document.getElementById('summaryEl');
  if (doTypewriter && analysis.summary) {
    _typewriter(summaryEl, analysis.summary, 18);
  } else {
    summaryEl.textContent = analysis.summary || '';
  }

  // Strengths
  const strengthsWrap = document.getElementById('strengthsTags');
  strengthsWrap.innerHTML = '';
  const strengthsSec = document.getElementById('strengthsSection');
  if (analysis.strengths && analysis.strengths.length > 0) {
    analysis.strengths.forEach(s => {
      const tag = document.createElement('span');
      tag.className = 'tag tag-green';
      tag.textContent = s;
      strengthsWrap.appendChild(tag);
    });
    strengthsSec.style.display = 'block';
  } else {
    strengthsSec.style.display = 'none';
  }

  // Gaps
  const gapsWrap = document.getElementById('gapsTags');
  gapsWrap.innerHTML = '';
  const gapsSec = document.getElementById('gapsSection');
  if (analysis.hard_gaps && analysis.hard_gaps.length > 0) {
    analysis.hard_gaps.forEach(g => {
      const tag = document.createElement('span');
      tag.className = 'tag tag-red';
      tag.textContent = g;
      gapsWrap.appendChild(tag);
    });
    gapsSec.style.display = 'block';
  } else {
    gapsSec.style.display = 'none';
  }

  // CV button
  const btnCV = document.getElementById('btnGenerateCV');
  btnCV.style.display = score >= 40 ? 'block' : 'none';
}

async function startFlow() {
  // Reset parallel-gen state from any prior run
  state.cvGenPromise = null;
  const btn = document.getElementById('btnGenerateCV');
  if (btn) { btn.disabled = false; btn.style.background = ''; btn.style.boxShadow = ''; btn.onclick = null; }

  showScreen('main');
  showMainLoading('מאתר שאלות רלוונטיות למשרה...');

  const stored = await chrome.storage.local.get(['licenseKey', 'cvText', 'cvHyperlinkUrls', 'userConstraints']);
  if (!stored.licenseKey) { showMainError('לא נמצא רישיון פעיל. חזרי למסך הראשי.'); return; }
  if (!stored.cvText) { showMainError('עוד לא הועלו קורות חיים. לחצי על ⚙️ בפינה כדי להוסיף.'); return; }
  state.licenseKey = stored.licenseKey;
  state.cvText = stored.cvText;
  state.cvHyperlinkUrls = stored.cvHyperlinkUrls || [];
  state.userConstraints = stored.userConstraints || '';

  // Get job text from active tab
  let tabResult;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      tabResult = await chrome.tabs.sendMessage(tab.id, { action: 'getJobText' });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 300));
      tabResult = await chrome.tabs.sendMessage(tab.id, { action: 'getJobText' });
    }
  } catch { showMainError('לא הצלחנו לקרוא את הדף הנוכחי. נסי לרענן (F5) ואז לפתוח שוב.'); return; }

  if (!tabResult || !tabResult.text || tabResult.text.length < 100) {
    showMainError('לא זוהתה משרה בעמוד זה. פתחי את דף המשרה הספציפי ונסי שוב.');
    return;
  }

  state.jobText = tabResult.text;
  state.jobLanguage = tabResult.language || 'english';
  state.jobPlatform = tabResult.platform || '';
  state.jobUrl = tabResult.url || '';
  await saveJobState({ jobText: state.jobText, jobLanguage: state.jobLanguage, jobPlatform: state.jobPlatform });

  console.log(`[JMA:analyze] startFlow jobText_len=${state.jobText.length} platform=${state.jobPlatform}`);

  // ── Check for FAB-triggered preflight cache (instant path) ───────────────
  const pKey = _prefKey(state.jobUrl);
  const pCacheStore = await chrome.storage.local.get([pKey]);
  const pCache = pCacheStore[pKey];
  if (pCache && (Date.now() - pCache.ts) < 10 * 60 * 1000 && pCache.questions?.length > 0) {
    console.log('[JMA:startFlow] using FAB preflight cache — zero wait');
    state.baseScore = pCache.base_score ?? 0;
    state.gapPct    = pCache.gap_pct    ?? 0;
    state.analysis  = {
      score:       pCache.base_score ?? 0,
      jobTitle:    pCache.jobTitle   || '',
      company:     pCache.company    || '',
      jobLanguage: pCache.jobLanguage || 'hebrew',
      summary:     pCache.summary    || '',
      strengths:   pCache.strengths  || [],
      hard_gaps:   pCache.hard_gaps  || [],
    };
    state.questions = pCache.questions;
    await saveJobState({ analysis: state.analysis, baseScore: state.baseScore, gapPct: state.gapPct, questions: state.questions });
    // Clear cache so it won't be reused on a re-analysis
    chrome.storage.local.remove([pKey]);
    showQuestionsScreen(pCache.questions);
    return;
  }

  // ── Normal preflight path ─────────────────────────────────────────────────
  // Show "waking up" message after 15 s so user knows we're waiting for Render cold-start
  const wakeTimer = setTimeout(() => showMainLoading('השרת מתעורר, זה יכול לקחת עד דקה...'), 15000);

  // Preflight: get questions only (no score, no usage count)
  const preflightMsg = {
    action: 'analyzeJob',
    licenseKey: state.licenseKey,
    cvText: state.cvText,
    jobText: state.jobText,
    preflight: true,
    answers: [],
  };
  let prefResp = await chrome.runtime.sendMessage(preflightMsg);
  clearTimeout(wakeTimer);

  // On cold-start the first preflight may time out before Render + Claude finish.
  // If we got an error (not just empty questions), retry once — server is now awake.
  if (prefResp?.error) {
    console.log('[JMA:preflight] first attempt errored, retrying:', prefResp.error);
    showMainLoading('כמעט שם, מנסה שוב...');
    prefResp = await chrome.runtime.sendMessage(preflightMsg);
  }

  console.log('[JMA:preflight] resp=', JSON.stringify(prefResp));
  const preflightResult = prefResp?.result || {};
  const newQuestions = (!prefResp?.error && preflightResult.questions) || [];
  console.log('[JMA:preflight] questions count=', newQuestions.length,
    'base=', preflightResult.base_score, 'gap=', preflightResult.gap_pct);

  // Store base analysis from preflight pass-1 (summary, strengths, etc.)
  if (!prefResp?.error && preflightResult.base_score != null) {
    state.baseScore = preflightResult.base_score ?? 0;
    state.gapPct    = preflightResult.gap_pct    ?? 0;
    // Merge preflight analysis into state so main result screen can show it
    // even before the full analyze call
    state.analysis = {
      score:        preflightResult.base_score,
      jobTitle:     preflightResult.jobTitle    || '',
      company:      preflightResult.company     || '',
      jobLanguage:  preflightResult.jobLanguage || 'hebrew',
      summary:      preflightResult.summary     || '',
      strengths:    preflightResult.strengths   || [],
      hard_gaps:    preflightResult.hard_gaps   || [],
    };
    await saveJobState({
      analysis:  state.analysis,
      baseScore: state.baseScore,
      gapPct:    state.gapPct,
    });
  }

  if (newQuestions.length > 0) {
    // Fresh questions from preflight — save and show
    state.questions = newQuestions;
    await saveJobState({ questions: newQuestions });
    showQuestionsScreen(newQuestions);
  } else if (state.questions && state.questions.length > 0) {
    // Preflight returned empty but we have saved questions from this session — reuse them
    showQuestionsScreen(state.questions, state.answers || []);
  } else {
    // Truly no questions — go straight to full analysis
    await runFullAnalysis([]);
  }
}

async function runFullAnalysis(answers) {
  state.answers = answers;
  await saveJobState({ answers });
  showScreen('main');
  showMainLoading('מנתח התאמה בין קורות החיים למשרה...');

  console.log(`[JMA:analyze] runFullAnalysis answers=${answers.length}`);
  const response = await chrome.runtime.sendMessage({
    action: 'analyzeJob',
    licenseKey: state.licenseKey,
    cvText: state.cvText,
    jobText: state.jobText,
    preflight: false,
    answers,
  });

  console.log(`[JMA:analyze] response error=${response?.error} result_keys=${response?.result ? Object.keys(response.result).join(',') : 'none'}`);
  if (response.error) { showMainError(response.error); return; }

  state.analysis = response.result;
  await saveJobState({ analysis: response.result });
  showMainResult(response.result);
}

// Generate CV flow
document.getElementById('btnGenerateCV').addEventListener('click', (e) => {
  // When _armCvButton is active it sets btn.onclick which fires first and calls
  // stopImmediatePropagation; if cvGenPromise is set it means parallel flow is active
  if (state.cvGenPromise) return; // handled by _armCvButton's onclick
  showCVOptionsScreen();
});

// Questions screen
// ── Live score computation from textarea answers ────────────────────────────
let _scoreDebounceTimer = null;

function _localScore(text) {
  if (!text || text.trim().length < 4) return 0;
  const t = text.trim().toLowerCase();
  if (/אין לי|no experience|don't have|לא מכיר|לא יודע|never|never used/.test(t)) return 8;
  let s = Math.min(68, Math.round((t.length / 150) * 58) + 10);
  if (/שנ(תיים|ה|ות|י)|years|year/.test(t)) s = Math.min(88, s + 14);
  if (/ניסיון|experience|worked|עבדתי|פרויקט|project|built|developed|managed/.test(t)) s = Math.min(88, s + 10);
  if (/מומחה|expert|advanced|proficient|lead|מוביל|architect/.test(t)) s = Math.min(96, s + 14);
  return Math.max(5, s);
}

function _updateQuestionsScore() {
  const base = state.baseScore || 0;
  let bonus = 0;
  (state.questions || []).forEach((q, idx) => {
    const ta = document.getElementById(`qs_ta_${q.id || idx}`);
    if (!ta) return;
    bonus += (_localScore(ta.value) / 100) * (q.weight || 0);
  });
  const score = Math.min(100, Math.round(base + bonus));
  const fill = document.getElementById('qsScoreFill');
  const val  = document.getElementById('qsScoreValue');
  if (fill) fill.style.width = `${score}%`;
  if (val)  val.textContent  = `${score}%`;
  // Relay to FAB in the background page via background.js
  chrome.runtime.sendMessage({ action: 'updateFabScore', score });
}

function showQuestionsScreen(questions, savedAnswers) {
  const container = document.getElementById('questionsContainer');
  container.innerHTML = '';

  // ── Live score bar (only if we have base score from preflight) ────────────
  const base = state.baseScore || 0;
  const scoreBar = document.createElement('div');
  scoreBar.className = 'questions-score-bar';
  scoreBar.innerHTML = `
    <span class="qs-score-label">ציון נוכחי</span>
    <div class="qs-score-track"><div class="qs-score-fill" id="qsScoreFill" style="width:${base}%"></div></div>
    <span class="qs-score-value" id="qsScoreValue">${base}%</span>
  `;
  container.appendChild(scoreBar);

  // ── Question cards with open text fields ──────────────────────────────────
  questions.forEach((q, idx) => {
    const taId = `qs_ta_${q.id || idx}`;
    const card = document.createElement('div');
    card.className = 'question-card';
    card.innerHTML = `
      <div class="question-skill">${q.skill}</div>
      <div class="question-text">${q.question}</div>
      ${q.heExplanation ? `<div class="question-he-exp">💡 ${q.heExplanation}</div>` : ''}
      <textarea class="q-textarea" id="${taId}"
        placeholder="תאר את הניסיון שלך... (לדוגמה: עבדתי 2 שנים עם Python כולל pandas ו-scikit-learn)"
        rows="3" data-idx="${idx}" data-weight="${q.weight || 0}"></textarea>
    `;
    container.appendChild(card);
  });

  // Textarea input → debounced local score → update score bar + FAB
  container.querySelectorAll('.q-textarea').forEach(ta => {
    ta.addEventListener('input', () => {
      clearTimeout(_scoreDebounceTimer);
      _scoreDebounceTimer = setTimeout(_updateQuestionsScore, 600);
    });
  });

  // Restore previously saved answers
  if (savedAnswers && savedAnswers.length > 0) {
    savedAnswers.forEach((a, idx) => {
      const q = questions[idx];
      if (!q || !a.answer || a.answer === 'לא ענה') return;
      const ta = document.getElementById(`qs_ta_${q.id || idx}`);
      if (ta) ta.value = a.answer;
    });
    _updateQuestionsScore();
  }

  // ── Inline output options (language + format) ────────────────────────────
  const autoLang = state.analysis?.jobLanguage || state.jobLanguage || 'english';
  cvOptions.language = autoLang;
  cvOptions.format = 'docx';
  const outOpts = document.createElement('div');
  outOpts.className = 'output-opts-inline';
  outOpts.innerHTML = `
    <div class="settings-label" style="margin:18px 0 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)">📁 הגדרות הקובץ הסופי</div>
    <div class="cv-opts-row" id="_qsLangRow">
      <button class="cv-opt-btn ${autoLang === 'english' ? 'active' : ''}" data-lang="english">🇺🇸 English</button>
      <button class="cv-opt-btn ${autoLang === 'hebrew' ? 'active' : ''}" data-lang="hebrew">🇮🇱 עברית</button>
    </div>
    <div class="cv-opts-row" style="margin-top:8px" id="_qsFmtRow">
      <button class="cv-opt-btn active" data-fmt="docx">📄 Word (.docx)</button>
      <button class="cv-opt-btn" data-fmt="pdf">🖨️ PDF</button>
    </div>
  `;
  container.appendChild(outOpts);

  outOpts.querySelectorAll('[data-lang]').forEach(btn => {
    btn.addEventListener('click', () => {
      cvOptions.language = btn.dataset.lang;
      outOpts.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  outOpts.querySelectorAll('[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      cvOptions.format = btn.dataset.fmt;
      outOpts.querySelectorAll('[data-fmt]').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  showScreen('questions');
}

function collectAnswers() {
  return (state.questions || []).map((q, idx) => {
    const ta     = document.getElementById(`qs_ta_${q.id || idx}`);
    const answer = ta ? ta.value.trim() : '';
    const scorePct = _localScore(answer);
    return { skill: q.skill, answer: answer || 'לא ענה', sliderValue: scorePct, weight: q.weight || 0 };
  });
}

document.getElementById('btnContinueToCV').addEventListener('click', async () => {
  const answers = collectAnswers();
  state.answers = answers;
  await saveJobState({ answers });

  // Compute slider-based final score
  if (state.baseScore) {
    const bonus = answers.reduce((s, a) => s + ((a.sliderValue || 0) / 100) * (a.weight || 0), 0);
    const finalScore = Math.min(100, Math.round(state.baseScore + bonus));
    if (state.analysis) state.analysis.score = finalScore;
  }

  if (state.analysis) {
    // ── Fast path: we have preflight analysis — show result instantly ─────
    showScreen('main');
    showMainResult(state.analysis, true /* typewriter */);

    // Fire CV generation in the background (parallel)
    state.cvGenPromise = _startCvGenBackground(answers, cvOptions.language, cvOptions.format);
    _armCvButton(cvOptions.language);
  } else {
    // ── Fallback: no preflight data — full analysis first, then CV options ─
    runFullAnalysis(answers);
  }
});

document.getElementById('btnSkipQuestions').addEventListener('click', () => {
  runFullAnalysis([]);
});

// ── Parallel CV generation helpers ───────────────────────────────────────────

function _startCvGenBackground(answers, language, format) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: 'generateCV',
      licenseKey: state.licenseKey,
      cvText: state.cvText,
      jobText: state.jobText,
      jobLanguage: language || state.analysis?.jobLanguage || 'english',
      answers,
      cvUrls: state.cvHyperlinkUrls || [],
      userConstraints: state.userConstraints || '',
      generateCoverLetter: false,
    }, resolve);
  });
}

function _armCvButton(language) {
  const btn = document.getElementById('btnGenerateCV');
  if (!btn) return;
  state.cvIsRtl = (language || 'english') === 'hebrew';
  btn.style.display = 'block';
  btn.textContent = '⏳ מכין קורות חיים ברקע...';
  btn.disabled = true;

  (state.cvGenPromise || Promise.resolve(null)).then(async resp => {
    if (!resp || resp.error) {
      // Fallback to old flow on error
      btn.textContent = '✨ צור קורות חיים מותאמים';
      btn.disabled = false;
      btn.onclick = null; // restore original listener
      return;
    }

    state.generatedCV = resp.cvText || '';
    state.coverLetterText = resp.coverLetterText || '';
    await saveJobState({ generatedCV: state.generatedCV, cvLanguage: language, coverLetterText: state.coverLetterText });

    // Save to tracker
    const record = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      jobTitle: state.analysis?.jobTitle || 'לא זוהה',
      company: state.analysis?.company || '',
      platform: state.jobPlatform,
      url: state.jobUrl,
      score: state.analysis?.score || 0,
      cvGenerated: true,
      cvFilename: `CV_${(state.analysis?.jobTitle || 'job').replace(/[^a-zA-Z0-9א-ת]/g, '_')}.docx`,
      status: 'טרם טופל',
      appId: resp.appId || null,
    };
    await saveJob(record);

    btn.textContent = '📄 קורות חיים מוכנים — לחץ להורדה ←';
    btn.disabled = false;
    btn.style.background = 'var(--success)';
    btn.style.boxShadow = '0 2px 8px rgba(22,163,74,0.35)';
    btn.onclick = () => {
      if (resp.sections && resp.sections.length > 0) {
        renderDiffScreen(resp.sections);
      } else {
        showCVResult(state.generatedCV, state.coverLetterText);
      }
    };
  });
}

// CV Options screen
function showCVOptionsScreen() {
  // Auto-detect language from job language; default to english
  const autoLang = state.analysis?.jobLanguage || state.jobLanguage || 'english';
  cvOptions.language = autoLang;
  cvOptions.format = 'docx';
  cvOptions.coverLetter = false;
  document.querySelectorAll('.cv-opt-btn[data-lang]').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === autoLang);
  });
  document.querySelectorAll('.cv-opt-btn[data-fmt]').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === 'docx');
  });
  document.getElementById('chkCoverLetter').checked = false;
  showScreen('cv-options');
}

document.querySelectorAll('.cv-opt-btn[data-lang]').forEach(btn => {
  btn.addEventListener('click', () => {
    cvOptions.language = btn.dataset.lang;
    document.querySelectorAll('.cv-opt-btn[data-lang]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.querySelectorAll('.cv-opt-btn[data-fmt]').forEach(btn => {
  btn.addEventListener('click', () => {
    cvOptions.format = btn.dataset.fmt;
    document.querySelectorAll('.cv-opt-btn[data-fmt]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('chkCoverLetter').addEventListener('change', (e) => {
  cvOptions.coverLetter = e.target.checked;
});

document.getElementById('btnStartCvGen').addEventListener('click', () => {
  startCVGeneration(state.answers, cvOptions.language, cvOptions.format, cvOptions.coverLetter);
});

document.getElementById('btnCvOptsBack').addEventListener('click', () => {
  showScreen('main');
});



// CV Generation
async function startCVGeneration(answers, language, format, coverLetter) {
  language = language || state.analysis?.jobLanguage || state.jobLanguage || 'english';
  format = format || 'docx';
  state.cvIsRtl = language === 'hebrew';
  showScreen('generating');
  setProgress(0, 'מתאים קורות חיים למשרה...', 'מתחברת לשרת...');

  // Smooth progress: +2% every 400 ms, capped at 90% until response arrives
  let _pct = 0;
  const _progressStages = [
    [0,  'מתאים קורות חיים למשרה...'],
    [28, 'בוחן פערי התאמה...'],
    [52, 'כותב גרסה משופרת...'],
    [72, 'מנתח שינויים...'],
  ];
  const _progressInterval = setInterval(() => {
    if (_pct >= 90) return;
    _pct = Math.min(_pct + 2, 90);
    const label = _progressStages.reduce((acc, [at, lbl]) => _pct >= at ? lbl : acc, _progressStages[0][1]);
    setProgress(_pct, label, '');
  }, 400);

  const response = await chrome.runtime.sendMessage({
    action: 'generateCV',
    licenseKey: state.licenseKey,
    cvText: state.cvText,
    jobText: state.jobText,
    jobLanguage: language,
    answers,
    cvUrls: state.cvHyperlinkUrls || [],
    userConstraints: state.userConstraints || '',
    generateCoverLetter: !!coverLetter,
  });

  clearInterval(_progressInterval);

  if (response.error) {
    showMainError(response.error);
    showScreen('main');
    return;
  }

  setProgress(100, 'הושלם!', '');

  state.generatedCV = response.cvText;
  state.coverLetterText = response.coverLetterText || '';
  await saveJobState({ generatedCV: response.cvText, cvLanguage: language, coverLetterText: state.coverLetterText });

  await new Promise(r => setTimeout(r, 400));

  // Save to tracker
  const record = {
    id: Date.now().toString(),
    date: new Date().toISOString(),
    jobTitle: state.analysis?.jobTitle || 'לא זוהה',
    company: state.analysis?.company || '',
    platform: state.jobPlatform,
    url: state.jobUrl,
    score: state.analysis?.score || 0,
    cvGenerated: true,
    cvFilename: `CV_${(state.analysis?.jobTitle || 'job').replace(/[^a-zA-Z0-9א-ת]/g, '_')}.docx`,
    status: 'טרם טופל',
    appId: response.appId || null,
  };
  await saveJob(record);

  if (response.sections && response.sections.length > 0) {
    renderDiffScreen(response.sections);
  } else {
    showCVResult(response.cvText, state.coverLetterText);
  }
}

function setProgress(pct, title, subtitle) {
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressLabel').textContent = pct + '%';
  if (title) document.getElementById('genTitle').textContent = title;
  if (subtitle) document.getElementById('genSubtitle').textContent = subtitle;
}

function showCVResult(cvText, coverLetterText) {
  document.getElementById('cvPreview').textContent = cvText;
  const clSection = document.getElementById('coverLetterSection');
  const clTextarea = document.getElementById('coverLetterTextarea');
  if (coverLetterText) {
    clTextarea.value = coverLetterText;
    clSection.style.display = 'block';
  } else {
    clSection.style.display = 'none';
  }
  showScreen('cv-result');
}

// ── Diff & Control screen ─────────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function assembleCVText(secs) {
  const ORDER = ['[NAME]','[HEADLINE]','[CONTACT]','[PROFILE]','[EXPERIENCE]','[EDUCATION]','[SKILLS]','[LANGUAGES]'];
  return ORDER.filter(m => secs[m]).map(m => `${m}\n${secs[m]}`).join('\n\n');
}

function applyDiffChoices(cvText, sections, choices) {
  if (!sections || sections.length === 0) return cvText;
  const secs = parseCVSections(cvText);
  for (const sec of sections) {
    const approved = choices[sec.id] !== false;
    if (!approved && sec.changed && sec.original_text && sec.original_text.trim().length > 5) {
      secs[sec.section_name] = sec.original_text;
    }
  }
  return assembleCVText(secs);
}

// ── Word/line diff engine ──────────────────────────────────────────────────────

// Generic LCS → edit-ops on any array, with custom equality fn
function lcsOps(a, b, eq) {
  const m = a.length, n = b.length;
  // Guard: fall back to simple replacement for very large inputs
  if (m * n > 40000) return [...a.map(v => ({t:'del',v})), ...b.map(v => ({t:'ins',v}))];
  const dp = Array.from({length: m + 1}, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = eq(a[i-1], b[j-1]) ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && eq(a[i-1], b[j-1])) { ops.unshift({t:'eq', v:a[i-1]}); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.unshift({t:'ins', v:b[j-1]}); j--; }
    else { ops.unshift({t:'del', v:a[i-1]}); i--; }
  }
  return ops;
}

// Word-level diff on a single line; returns HTML string
function wordDiffHtml(oldLine, newLine) {
  const a = oldLine.split(/(\s+)/);
  const b = newLine.split(/(\s+)/);
  return lcsOps(a, b, (x, y) => x === y).map(op => {
    const v = escHtml(op.v);
    if (op.t === 'eq')  return v;
    if (op.t === 'ins') return `<mark class="diff-ins">${v}</mark>`;
    return `<del class="diff-del">${v}</del>`;
  }).join('');
}

// Unified HTML for a whole section (line-level LCS → word diff on changed lines)
function buildDiffHtml(oldText, newText, hasOriginal) {
  if (!hasOriginal || !oldText.trim()) {
    // No original — just render updated text as fully added
    return `<mark class="diff-ins">${escHtml(newText.trim())}</mark>`;
  }

  const oldLines = oldText.trim().split('\n');
  const newLines = newText.trim().split('\n');
  const lineOps  = lcsOps(oldLines, newLines, (a, b) => a.trim() === b.trim());

  // Count changed lines to decide between unified vs block view
  const changed = lineOps.filter(o => o.t !== 'eq').length;
  const changeRatio = changed / Math.max(lineOps.length, 1);

  // > 75% of lines changed → show two separate blocks (cleaner for heavy rewrites)
  if (changeRatio > 0.75 && oldLines.length > 2) {
    return [
      `<div class="diff-block-label lbl-before">לפני (מקורי)</div>`,
      escHtml(oldText.trim()),
      `<div class="diff-block-sep"></div>`,
      `<div class="diff-block-label lbl-after">אחרי (מותאם)</div>`,
      escHtml(newText.trim()),
    ].join('\n');
  }

  // Unified view: process line ops, do word diff on adjacent del+ins pairs
  const htmlLines = [];
  let k = 0;
  while (k < lineOps.length) {
    const op = lineOps[k];
    if (op.t === 'eq') {
      htmlLines.push(escHtml(op.v));
      k++;
    } else if (op.t === 'del' && k + 1 < lineOps.length && lineOps[k + 1].t === 'ins') {
      // Modified line — word-level diff
      htmlLines.push(wordDiffHtml(op.v, lineOps[k + 1].v));
      k += 2;
    } else if (op.t === 'ins') {
      htmlLines.push(`<mark class="diff-ins">${escHtml(op.v)}</mark>`);
      k++;
    } else {
      htmlLines.push(`<del class="diff-del">${escHtml(op.v)}</del>`);
      k++;
    }
  }
  return htmlLines.join('\n');
}

// ── Render diff screen ─────────────────────────────────────────────────────────

function renderDiffScreen(sections) {
  state.diffSections = sections || [];
  const changed = state.diffSections.filter(s => s.changed);
  const container = document.getElementById('diffCardsContainer');
  container.innerHTML = '';

  document.getElementById('diffCount').textContent =
    changed.length > 0
      ? `ה-AI שינה ${changed.length} סעיף${changed.length > 1 ? 'ים' : ''} — בדוק ואשר:`
      : '';

  if (changed.length === 0) {
    container.innerHTML = '<div class="diff-no-changes">✅ ה-AI לא ביצע שינויים משמעותיים — קורות החיים ייוצאו כפי שהם.</div>';
  } else {
    changed.forEach(sec => {
      const origTrimmed = (sec.original_text || '').trim();
      const updTrimmed  = (sec.updated_text  || '').trim();
      const hasOriginal = origTrimmed.length > 5;
      // Skip card if no meaningful content to show
      if (!updTrimmed) return;

      const card = document.createElement('div');
      card.className = 'diff-card';
      card.innerHTML = `
        ${sec.explanation_hebrew
          ? `<div class="diff-explanation-banner">💡 ${escHtml(sec.explanation_hebrew)}</div>`
          : ''}
        <div class="diff-card-header">
          <span class="diff-card-title">${escHtml(sec.label || sec.section_name)}</span>
          <label class="diff-approve-label">
            <input type="checkbox" class="diff-approve-check" data-id="${sec.id}"
              ${hasOriginal ? 'checked' : 'checked disabled'}>
            <span>אשר שינוי</span>
          </label>
        </div>
        ${hasOriginal ? `<div class="diff-before">${escHtml(origTrimmed)}</div>` : ''}
        <div class="diff-after">${escHtml(updTrimmed)}</div>
      `;
      container.appendChild(card);
    });
  }

  showScreen('diff');
}

document.getElementById('btnDiffSelectAll').addEventListener('click', () => {
  document.querySelectorAll('.diff-approve-check:not([disabled])').forEach(cb => { cb.checked = true; });
});
document.getElementById('btnDiffSelectNone').addEventListener('click', () => {
  document.querySelectorAll('.diff-approve-check:not([disabled])').forEach(cb => { cb.checked = false; });
});
document.getElementById('btnDiffBack').addEventListener('click', () => showScreen('main'));

document.getElementById('btnApproveDiff').addEventListener('click', async () => {
  const choices = {};
  document.querySelectorAll('.diff-approve-check').forEach(cb => {
    choices[parseInt(cb.dataset.id)] = cb.checked;
  });
  const finalCvText = applyDiffChoices(state.generatedCV, state.diffSections, choices);
  state.generatedCV = finalCvText;
  showCVResult(finalCvText, state.coverLetterText);
});

document.getElementById('btnDownloadPdf').addEventListener('click', () => {
  downloadAsPdf(state.generatedCV, state.cvIsRtl);
});

document.getElementById('btnDownloadDocx').addEventListener('click', async () => {
  const isRtl = state.cvIsRtl;
  const jobTitle = (state.analysis?.jobTitle || 'CV').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_').trim();
  // Extract candidate name from CV text for filename
  const stored = await chrome.storage.local.get(['cvName']);
  const cvName = (stored.cvName || '').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_').trim();
  const namePart = cvName ? `_${cvName}` : '';
  const filename = `CV_${jobTitle}${namePart}.docx`;
  console.log('[JobMatchAI] CV text being converted to DOCX:', state.generatedCV.substring(0, 500));
  downloadDocx(state.generatedCV, filename, isRtl);
});

function buildCvPrintHtml(cvText, isRtl) {
  const dir = isRtl ? 'rtl' : 'ltr';
  const ta  = isRtl ? 'right' : 'left';
  const secs = parseCVSections(cvText);

  // Wrap English technical terms/sequences in <bdi> so the browser bidi algorithm
  // keeps them inline-level LTR without disrupting the surrounding RTL flow.
  function bdiWrap(text) {
    if (!isRtl) return text;
    // Match runs of ASCII letters/digits/common tech punctuation (URLs, versions, etc.)
    return text.replace(/([A-Za-z][A-Za-z0-9_.+\-/#@]*(?:\s[A-Za-z][A-Za-z0-9_.+\-/#@]*)*)/g,
      (m) => `<bdi>${m}</bdi>`);
  }

  function renderInline(text) {
    const linked = text
      .replace(/\[LINK:([^\|]*)\|([^\]]*)\]/g, (_, display, url) =>
        `<a href="${url}" style="color:#7c3aed"><bdi>${display}</bdi></a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return bdiWrap(linked);
  }

  // Group consecutive bullet lines inside a <ul> so browser list styling applies.
  function ren(txt) {
    if (!txt) return '';
    const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
    const parts = [];
    let inList = false;
    for (const l of lines) {
      const isBul = l.startsWith('$ ') || l.startsWith('•') || l.startsWith('- ');
      const cl = isBul ? l.replace(/^\$\s+|^[•\-]\s*/, '') : l;
      const html = renderInline(cl);
      if (isBul) {
        if (!inList) { parts.push(`<ul dir="${dir}">`); inList = true; }
        parts.push(`<li>${html}</li>`);
      } else {
        if (inList) { parts.push('</ul>'); inList = false; }
        parts.push(`<p>${html}</p>`);
      }
    }
    if (inList) parts.push('</ul>');
    return parts.join('');
  }

  const labels = isRtl
    ? { profile: 'פרופיל', experience: 'ניסיון', education: 'השכלה', skills: 'כישורים', languages: 'שפות' }
    : { profile: 'Profile', experience: 'Experience', education: 'Education', skills: 'Skills', languages: 'Languages' };

  const secHtml = [
    secs['[PROFILE]']    ? `<h2>${labels.profile}</h2>${ren(secs['[PROFILE]'])}` : '',
    secs['[EXPERIENCE]'] ? `<h2>${labels.experience}</h2>${ren(secs['[EXPERIENCE]'])}` : '',
    secs['[EDUCATION]']  ? `<h2>${labels.education}</h2>${ren(secs['[EDUCATION]'])}` : '',
    secs['[SKILLS]']     ? `<h2>${labels.skills}</h2>${ren(secs['[SKILLS]'])}` : '',
    secs['[LANGUAGES]']  ? `<h2>${labels.languages}</h2>${ren(secs['[LANGUAGES]'])}` : '',
  ].join('');

  return `<!DOCTYPE html><html lang="${isRtl ? 'he' : 'en'}" dir="${dir}"><head><meta charset="UTF-8"><title>CV</title>
<style>
  @media print { @page { margin: 1.5cm; } body { margin: 0; } }
  body {
    font-family: 'Arial', 'Calibri', sans-serif;
    font-size: 11pt; color: #1f2937;
    direction: ${dir} !important;
    text-align: ${ta} !important;
    unicode-bidi: plaintext;
    margin: 1.5cm;
  }
  h1 { text-align: center; font-size: 18pt; margin: 0 0 4px; }
  .hl { text-align: center; color: #7c3aed; font-size: 12pt; margin: 0 0 3px; }
  .ct { text-align: center; color: #6b7280; font-size: 10pt; margin: 0 0 14px; }
  h2 {
    font-size: 11pt; color: #7c3aed;
    border-bottom: 1px solid #7c3aed;
    margin: 10px 0 3px; padding-bottom: 2px;
    text-transform: uppercase; letter-spacing: 0.5px;
    text-align: ${ta};
  }
  p { margin: 2px 0; line-height: 1.35; direction: ${dir}; text-align: ${ta}; }
  ul, ol {
    margin: 2px 0;
    ${isRtl ? 'padding-right: 20px; padding-left: 0;' : 'padding-left: 20px; padding-right: 0;'}
    list-style-position: outside;
    direction: ${dir};
    text-align: ${ta};
  }
  li {
    margin: 1px 0; line-height: 1.4;
    direction: ${dir}; text-align: ${ta};
    unicode-bidi: plaintext;
  }
  bdi { unicode-bidi: isolate; }
  strong { font-weight: 700; }
</style></head><body>
${secs['[NAME]']     ? `<h1>${secs['[NAME]']}</h1>` : ''}
${secs['[HEADLINE]'] ? `<p class="hl">${secs['[HEADLINE]']}</p>` : ''}
${secs['[CONTACT]']  ? `<p class="ct">${secs['[CONTACT]'].split('\n').filter(l=>l.trim()).map(renderInline).join(' ‏|‏ ')}</p>` : ''}
${secHtml}
<script>window.onload=()=>{ setTimeout(()=>window.print(),300); };<\/script>
</body></html>`;
}

function downloadAsPdf(cvText, isRtl) {
  const html = buildCvPrintHtml(cvText, isRtl || false);
  const encoded = encodeURIComponent(html);
  chrome.tabs.create({ url: `data:text/html;charset=utf-8,${encoded}` });
}

document.getElementById('btnCopyCV').addEventListener('click', async () => {
  await navigator.clipboard.writeText(state.generatedCV);
  const btn = document.getElementById('btnCopyCV');
  btn.textContent = '✅ הועתק!';
  setTimeout(() => { btn.textContent = '📋 העתק טקסט'; }, 1500);
});

document.getElementById('btnCopyCoverLetter').addEventListener('click', async () => {
  const text = document.getElementById('coverLetterTextarea').value;
  await navigator.clipboard.writeText(text);
  const btn = document.getElementById('btnCopyCoverLetter');
  btn.textContent = '✅ הועתק!';
  setTimeout(() => { btn.textContent = '📋 העתק מכתב מקדים'; }, 1500);
});

document.getElementById('btnBackToMain').addEventListener('click', () => {
  showScreen('main');
});

// Tracker screen
async function showTrackerScreen() {
  showScreen('tracker');
  const jobs = await getAllJobs();
  const container = document.getElementById('trackerContent');

  if (jobs.length === 0) {
    container.innerHTML = `
      <div class="tracker-empty">
        <div class="tracker-empty-icon">📋</div>
        <div>עדיין לא נבדקו משרות</div>
        <div style="font-size:11px;margin-top:6px;color:var(--text-dim)">פתח דף משרה ולחץ על הניתוח</div>
      </div>`;
    return;
  }

  // Fetch link click data for all jobs that have an appId
  const appIds = jobs.map(j => j.appId).filter(Boolean);
  let clicksMap = {};
  if (appIds.length > 0) {
    try {
      const resp = await fetch(`https://job-match-ai-extension.onrender.com/api/v1/clicks?app_ids=${appIds.join(',')}`);
      if (resp.ok) {
        const data = await resp.json();
        clicksMap = data.clicks || {};
      }
    } catch { /* ignore — show dash if backend unreachable */ }
  }

  const rows = jobs.map(j => {
    const score = j.score || 0;
    const scoreClass = score >= 75 ? 'score-green' : score >= 55 ? 'score-yellow' : score >= 35 ? 'score-orange' : 'score-red';
    const date = new Date(j.date).toLocaleDateString('he-IL');
    const status = j.status || 'טרם טופל';

    // Link-click cell
    let linkCell = '<span class="no-data">-</span>';
    if (j.appId) {
      const clicks = clicksMap[j.appId] || [];
      if (clicks.length > 0) {
        const targets = [...new Set(clicks.map(c => c.target))];
        const label = targets.map(t => t === 'github' ? 'GitHub' : t === 'linkedin' ? 'LinkedIn' : 'Portfolio').join(', ');
        linkCell = `<span title="${label}" style="color:#16a34a;font-weight:600;cursor:default">✅ ${label}</span>`;
      } else {
        linkCell = `<span title="הלינקים בקוח לא נפתחו עדיין" style="color:#9ca3af;cursor:default">⏳</span>`;
      }
    }

    return `<tr>
      <td>${date}</td>
      <td style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${j.jobTitle || '-'}</td>
      <td style="max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${j.company || '-'}</td>
      <td><span class="platform-tag">${j.platform || '-'}</span></td>
      <td class="score-cell ${scoreClass}">${score}%</td>
      <td>${j.cvGenerated ? '✅' : '❌'}</td>
      <td>${linkCell}</td>
      <td>
        <select class="status-select" data-id="${j.id}">
          <option ${status === 'טרם טופל' ? 'selected' : ''}>טרם טופל</option>
          <option ${status === 'הגשתי' ? 'selected' : ''}>הגשתי</option>
          <option ${status === 'מחכה' ? 'selected' : ''}>מחכה</option>
          <option ${status === 'לא רלוונטי' ? 'selected' : ''}>לא רלוונטי</option>
        </select>
      </td>
      <td>
        ${j.url ? `<a href="${j.url}" target="_blank" class="job-link">🔗</a>` : '<span class="no-data">-</span>'}
        <button class="delete-btn" data-id="${j.id}" title="מחק">🗑️</button>
      </td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="tracker-table-wrap">
      <table>
        <thead>
          <tr>
            <th>תאריך</th>
            <th>תפקיד</th>
            <th>חברה</th>
            <th>פלטפורמה</th>
            <th>ציון</th>
            <th>CV</th>
            <th>לינקים</th>
            <th>סטטוס</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <button class="btn btn-secondary export-btn" id="btnExportExcel">⬇️ ייצא Excel</button>`;

  // Status change
  container.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      await updateJobStatus(sel.dataset.id, sel.value);
    });
  });

  // Delete
  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('למחוק רשומה זו?')) {
        await deleteJob(btn.dataset.id);
        showTrackerScreen();
      }
    });
  });

  // Export
  document.getElementById('btnExportExcel').addEventListener('click', async () => {
    const allJobs = await getAllJobs();
    exportToExcel(allJobs);
  });
}

// ── License screen ────────────────────────────────────────────────────────────
async function checkLicense() {
  const data = await chrome.storage.local.get(['licenseKey', 'licenseValid']);
  return !!(data.licenseKey && data.licenseValid);
}

document.getElementById('btnActivateLicense').addEventListener('click', async () => {
  const key = document.getElementById('licenseKeyInput').value.trim();
  const errEl = document.getElementById('licenseError');
  const okEl = document.getElementById('licenseSuccess');
  errEl.style.display = 'none';
  okEl.style.display = 'none';

  if (!key) {
    errEl.textContent = 'נא להזין מפתח רישיון.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btnActivateLicense');
  btn.textContent = '⏳ מאמת...';
  btn.disabled = true;

  const res = await chrome.runtime.sendMessage({ action: 'verifyLicense', licenseKey: key });

  btn.textContent = '🔓 הפעל רישיון';
  btn.disabled = false;

  if (res.error) {
    errEl.textContent = res.error;
    errEl.style.display = 'block';
    return;
  }

  state.licenseKey = key;
  _applyUpgradeUrl(res.result);
  await chrome.storage.local.set({
    licenseKey: key,
    licenseValid: true,
    isPremium: !!(res.result && res.result.isPremium),
  });
  okEl.textContent = '✅ רישיון אומת בהצלחה! כעת הגדר את קורות החיים שלך ⬇️';
  okEl.style.display = 'block';
  setTimeout(async () => {
    await loadSettings();
    showScreen('settings');
  }, 900);
});

// ── Ready screen ───────────────────────────────────────────────────────────────
async function showReadyScreen() {
  const data = await chrome.storage.local.get(['cvText', 'cvName', 'licenseKey']);

  if (data.licenseKey) state.licenseKey = data.licenseKey;
  if (data.cvText) state.cvText = data.cvText;

  if (data.cvName && data.cvText) {
    document.getElementById('readyCvName').textContent = data.cvName;
    document.getElementById('readyCvMeta').style.display = 'flex';
    document.getElementById('readyNoCv').style.display = 'none';
  } else {
    document.getElementById('readyCvMeta').style.display = 'none';
    document.getElementById('readyNoCv').style.display = 'flex';
  }

  document.getElementById('readyWarning').textContent = '';

  showScreen('ready');
}

document.getElementById('btnStartAnalysis').addEventListener('click', startFlow);

document.getElementById('btnRankPageJobs').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Inject content script in case it wasn't loaded yet (e.g. tab opened before extension)
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch {}
  // Give the script time to initialize, then open sidebar
  setTimeout(() => {
    chrome.tabs.sendMessage(tab.id, { action: 'triggerSidebar' }, (resp) => {
      // Close popup whether it worked or not — sidebar is in the page
    });
  }, 1200);
  window.close();
});

// ── Premium import screen ─────────────────────────────────────────────────────

async function showPremiumScreen() {
  const data = await chrome.storage.local.get(['isPremium']);
  document.getElementById('premiumLocked').style.display = data.isPremium ? 'none' : 'block';
  document.getElementById('premiumActive').style.display = data.isPremium ? 'block' : 'none';
  // Reset UI state
  document.getElementById('importStatus').textContent = '';
  document.getElementById('importError').style.display = 'none';
  const btn = document.getElementById('btnImportJobs');
  if (btn) { btn.disabled = false; btn.textContent = '📥 ייבוא והתאמת משרות'; }
  showScreen('premium');
}

document.getElementById('btnPremium').addEventListener('click', () => showPremiumScreen());
document.getElementById('btnPremiumBack').addEventListener('click', () => showScreen('ready'));

document.getElementById('btnImportJobs').addEventListener('click', async () => {
  const minScore = parseInt(document.getElementById('minScoreInput').value, 10) || 70;
  const timeRange = document.getElementById('timeRangeSelect').value;
  const btn = document.getElementById('btnImportJobs');
  const statusEl = document.getElementById('importStatus');
  const errEl = document.getElementById('importError');

  btn.disabled = true;
  btn.textContent = '⏳ מסנן ומדרג...';
  statusEl.textContent = 'שלב 1 מתוך 2: סינון ראשוני לפי מילות מפתח...';
  errEl.style.display = 'none';

  // Show stage 2 hint after a few seconds
  const stageHint = setTimeout(() => {
    statusEl.textContent = 'שלב 2 מתוך 2: דירוג עם AI — זה עלול לקחת דקה...';
  }, 4000);

  const resp = await chrome.runtime.sendMessage({
    action: 'importPremiumJobs',
    minScore,
    timeRange,
  });

  clearTimeout(stageHint);
  btn.disabled = false;
  btn.textContent = '📥 ייבוא והתאמת משרות';

  if (resp.error) {
    statusEl.textContent = '';
    errEl.textContent = resp.error;
    errEl.style.display = 'block';
    return;
  }

  // Trigger download
  statusEl.textContent = '✅ הקובץ מוכן להורדה!';
  const a = document.createElement('a');
  a.href = resp.dataUrl;
  a.download = `JobMatchAI_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// ── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  const licensed = await checkLicense();
  if (!licensed) { showScreen('license'); return; }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // LinkedIn SPA: if user navigated to a new job since the last analysis,
    // skip state restoration and go straight to the ready screen
    if (tab?.id) {
      const navKey = `jma_nav_${tab.id}`;
      const navCheck = await chrome.storage.local.get([navKey]);
      if (navCheck[navKey]) {
        await chrome.storage.local.remove([navKey]);
        await showReadyScreen();
        return;
      }
    }

    const stored = await chrome.storage.local.get(['licenseKey', 'cvText']);
    const saved = await loadJobState(tab?.url);

    if (saved) {
      state.licenseKey = stored.licenseKey || '';
      state.cvText = stored.cvText || '';
      state.jobText = saved.jobText || '';
      state.jobLanguage = saved.jobLanguage || 'english';
      state.jobPlatform = saved.jobPlatform || '';
      state.jobUrl = saved.url || '';
      state.answers   = saved.answers   || [];
      state.questions = saved.questions || [];
      state.baseScore = saved.baseScore ?? 0;
      state.gapPct    = saved.gapPct    ?? 0;

      if (saved.generatedCV) {
        state.generatedCV = saved.generatedCV;
        state.coverLetterText = saved.coverLetterText || '';
        state.analysis = saved.analysis;
        state.cvIsRtl = (saved.cvLanguage || saved.jobLanguage || 'english') === 'hebrew';
        showCVResult(saved.generatedCV, state.coverLetterText);
        return;
      }
      if (saved.analysis) {
        state.analysis = saved.analysis;
        showScreen('main');
        showMainResult(saved.analysis);
        return;
      }
      if (saved.questions && saved.questions.length > 0) {
        showQuestionsScreen(saved.questions, saved.answers || []);
        return;
      }
    }
  } catch (e) { console.log('[JMA:init] restore error:', e); }

  await showReadyScreen();
})();
