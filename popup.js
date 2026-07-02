// 1. נשמור את הכתובת של המשרה הנוכחית
let currentJobId = "";
chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (tabs[0] && tabs[0].url) {
        currentJobId = tabs[0].url;
    }
});

// 2. שומרים בצד את הפונקציות המקוריות של כרום כדי שנוכל להשתמש בהן בפנים
const originalSet = chrome.storage.local.set;
const originalGet = chrome.storage.local.get;

// 3. דריסת פונקציית ה-SET (שמירה) של כרום באופן גלובלי!
chrome.storage.local.set = function(items, callback) {
    // אם המשתנה הגלובלי jma_jobs_cache מעודכן, או שאין עדיין URL, נשמור כרגיל
    if (items.jma_jobs_cache || !currentJobId) {
        return originalSet.call(chrome.storage.local, items, callback);
    }

    // בכל מקרה אחר - תופסים את הנתונים ומנתבים אותם למגירה של ה-URL
    originalGet.call(chrome.storage.local, ['jma_jobs_cache'], function(data) {
        let cache = data.jma_jobs_cache || {};
        if (!cache[currentJobId]) cache[currentJobId] = {};

        // דוחפים את כל מה שהפונקציה המקורית ניסתה לשמור לתוך התת-אובייקט של המשרה
        for (const [key, value] of Object.entries(items)) {
            cache[currentJobId][key] = value;
        }

        // הגבלת כמות (מקסימום 5 משרות במטמון)
        const keys = Object.keys(cache);
        if (keys.length > 5) delete cache[keys[0]];

        // שומרים פיזית בדיסק של כרום את הארון המעודכן
        originalSet.call(chrome.storage.local, { jma_jobs_cache: cache }, callback);
    });
};

// 4. דריסת פונקציית ה-GET (שליפה) של כרום באופן גלובלי!
chrome.storage.local.get = function(keys, callback) {
    // אם מבקשים את כל הקאש באופן ישיר, נשמש בפונקציה המקורית
    if (keys === 'jma_jobs_cache' || (Array.isArray(keys) && keys.includes('jma_jobs_cache')) || !currentJobId) {
        return originalGet.call(chrome.storage.local, keys, callback);
    }

    // בכל בקשה אחרת - שולפים רק מהמגירה של המשרה הנוכחית
    originalGet.call(chrome.storage.local, ['jma_jobs_cache'], function(data) {
        let cache = data.jma_jobs_cache || {};
        let jobData = cache[currentJobId] || {};
        let result = {};

        // מחזירים רק את המפתחות שביקשו, מתוך המשרה הספציפית הזו
        const keysToFetch = Array.isArray(keys) ? keys : [keys];
        keysToFetch.forEach(key => {
            result[key] = jobData[key];
        });

        if (callback) callback(result);
    });
};
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

let cvOptions = { language: 'english', format: 'docx', coverLetter: false, tracking: true, model: 'sonnet' };

// ── Monthly quota constants ────────────────────────────────────────────────────
const QUOTA_STORAGE_KEY = 'jma_usage';
const QUOTA_LIMITS = {
  standard: { sonnet: 30, fable: 5  },
  premium:  { sonnet: Infinity, fable: 20 },
};

async function _getUsage() {
  const s = await chrome.storage.local.get([QUOTA_STORAGE_KEY, 'jma_is_premium']);
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let usage = s[QUOTA_STORAGE_KEY] || {};
  if (usage.month !== month) usage = { month, sonnet: 0, fable: 0 }; // monthly reset
  return { usage, isPremium: !!s.jma_is_premium };
}

async function _checkQuota(model) {
  const { usage, isPremium } = await _getUsage();
  const tier = isPremium ? 'premium' : 'standard';
  const limit = QUOTA_LIMITS[tier][model] ?? 0;
  const used  = usage[model] || 0;
  return { allowed: used < limit, used, limit, isPremium };
}

async function _incrementUsage(model) {
  const { usage } = await _getUsage();
  usage[model] = (usage[model] || 0) + 1;
  await chrome.storage.local.set({ [QUOTA_STORAGE_KEY]: usage });
}

async function _updateQuotaDisplay() {
  const { usage, isPremium } = await _getUsage();
  const tier = isPremium ? 'premium' : 'standard';
  const limits = QUOTA_LIMITS[tier];
  const sq = document.getElementById('sonnetQuota');
  const fq = document.getElementById('fableQuota');
  const fb = document.getElementById('fableBtn');
  if (sq) sq.textContent = limits.sonnet === Infinity ? '' : `${usage.sonnet || 0}/${limits.sonnet}`;
  if (fq) fq.textContent = `${usage.fable || 0}/${limits.fable}`;
  if (fb) {
    const fableOver = (usage.fable || 0) >= limits.fable;
    fb.disabled = fableOver;
    fb.title = fableOver ? `הגעת למכסה החודשית (${limits.fable} Fable)` : '';
    fb.style.opacity = fableOver ? '0.45' : '';
  }
}

// Strip platform suffixes and noise from page/og/h1 titles to get a clean job title
function _cleanPageTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s*[\|–\-]\s*(LinkedIn|Indeed|Glassdoor|Drushim|AllJobs|JobMaster|Comeet|Greenhouse|Lever|Workable|SmartRecruiters|Gotfriends|HeyAnter|Jobify360|Nvidia Jobs|Jobs).*/i, '')
    .replace(/\s*[\|–\-]\s*(דרושים|כל הג'ובים|ג'ובמסטר|חיפוש עבודה|משרות|לינקדאין).*/i, '')
    .replace(/Apply.*$/i, '')
    .trim()
    .slice(0, 80);
}

// Best job title: AI result first, then page-extracted, then fallback
function _bestJobTitle() {
  return state.analysis?.jobTitle?.trim() || state.jobTitle?.trim() || 'לא זוהה';
}
function _bestCompany() {
  return state.analysis?.company?.trim() || '';
}

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

// ── CV Profile Extraction ─────────────────────────────────────────────────────
// Called once after a new CV is saved. Sends the text to the backend, which uses
// Claude to produce a structured jma_user_profile JSON, then stores it locally.
// The FAB matcher reads jma_user_profile instead of raw cvText, giving accurate scoring.
async function _extractAndSaveProfile(cvText) {
  const { licenseKey } = await chrome.storage.local.get(['licenseKey']);
  if (!licenseKey || !cvText) return;

  // Show a subtle status on the settings upload area
  const statusEl = document.getElementById('uploadSuccess');
  if (statusEl) { statusEl.textContent = '⏳ מנתח פרופיל מיומנויות...'; statusEl.style.display = 'block'; }

  const BACKEND = 'https://job-match-ai-extension.onrender.com';
  try {
    const resp = await fetch(`${BACKEND}/api/extract-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': licenseKey },
      body: JSON.stringify({ cvText }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.profile) throw new Error('empty profile');
    await chrome.storage.local.set({ jma_user_profile: data.profile });
    if (statusEl) statusEl.textContent = '✅ פרופיל מיומנויות עודכן — ניקוד המשרות ישתפר מיידית';
    console.log('[JMA] profile extracted and saved', data.profile);
  } catch (e) {
    console.warn('[JMA] profile extraction failed:', e.message);
    if (statusEl) statusEl.textContent = '⚠️ שגיאה בחילוץ פרופיל. הניתוח המהיר ימשיך לפעול.';
  }
}

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
    toSave.jma_is_premium = toSave.isPremium;
    state.licenseKey = newKey;
    _applyUpgradeUrl(res.result);
    statusEl.textContent = `✅ אומת: ${newKey.slice(0, 4)}-****-****-${newKey.slice(-4)}${toSave.isPremium ? ' ⭐ פרימיום' : ' (בסיסי)'}`;
    statusEl.style.color = '#4caf50';
    document.getElementById('licenseKeySettings').value = '';
  }

  if (Object.keys(toSave).length > 0) await chrome.storage.local.set(toSave);
  document.getElementById('btnSaveSettings').textContent = '✅ נשמר!';

  // If a new CV was uploaded, extract the structured profile in the background.
  if (toSave.cvText) _extractAndSaveProfile(toSave.cvText);

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
  // Clear NEW badge from extension icon and tracker dot
  chrome.action.setBadgeText({ text: '' });
  document.getElementById('trackerNewDot').style.display = 'none';
  showTrackerScreen();
});

// Show NEW dot on tracker button if extension badge is currently set
chrome.action.getBadgeText({}, (text) => {
  if (text && text.trim()) {
    document.getElementById('trackerNewDot').style.display = 'block';
  }
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

// Load preflight cache into state
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

// Show animated waiting screen inside questionsContainer while Stage 2 runs
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
  // Rotate label
  const labels = ['מנתח את המשרה...', 'מזהה פערי מיומנויות...', 'מחשב משקלים...', 'מכין שאלות ממוקדות...', 'כמעט מוכן...'];
  let i = 0;
  const t = setInterval(() => {
    const el = document.getElementById('pfWaitLabel');
    if (!el) { clearInterval(t); return; }
    el.textContent = labels[i++ % labels.length];
  }, 1800);
  return () => clearInterval(t);
}

async function startFlow() {
  state.cvGenPromise = null;
  const btn = document.getElementById('btnGenerateCV');
  if (btn) { btn.disabled = false; btn.style.background = ''; btn.style.boxShadow = ''; btn.onclick = null; }

  showScreen('main');
  showMainLoading('טוען...');

  // ── 1. Load credentials ───────────────────────────────────────────────────
  const stored = await chrome.storage.local.get(['licenseKey', 'cvText', 'cvHyperlinkUrls', 'userConstraints', 'enableTracking']);
  if (!stored.licenseKey) { showMainError('לא נמצא רישיון פעיל. חזרי למסך הראשי.'); return; }
  if (!stored.cvText)     { showMainError('עוד לא הועלו קורות חיים. לחצי על ⚙️ כדי להוסיף.'); return; }
  state.licenseKey      = stored.licenseKey;
  state.cvText          = stored.cvText;
  state.cvHyperlinkUrls = stored.cvHyperlinkUrls || [];
  state.userConstraints = stored.userConstraints || '';
  cvOptions.tracking    = stored.enableTracking !== false;

  // ── 2. Get job text from active tab ──────────────────────────────────────
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
  const localStored = await chrome.storage.local.get(['jma_local_score', 'jma_is_premium']);
  if (localStored.jma_local_score) state.baseScore = localStored.jma_local_score;
  // Save premium flag to cvOptions for model selector rendering
  cvOptions._isPremium = !!localStored.jma_is_premium;
  await saveJobState({ jobText: state.jobText, jobLanguage: state.jobLanguage, jobPlatform: state.jobPlatform });

  // ── 3. Check FAB preflight cache ─────────────────────────────────────────
  const pKey = _prefKey(state.jobUrl);
  const pCache = (await chrome.storage.local.get([pKey]))[pKey];
  const fresh = pCache && (Date.now() - pCache.ts) < 10 * 60 * 1000 && pCache.questions?.length > 0;

  if (fresh) {
    // Perfect: Stage 2 already done — show questions immediately
    _loadPreflightCache(pCache);
    chrome.storage.local.remove([pKey]);
    showQuestionsScreen(pCache.questions);
    return;
  }

  // ── 4. Stage 2 still running — show waiting UI + poll for up to 60 s ─────
  const stopWaitAnim = _showQuestionsWaiting();
  const wakeTimer = setTimeout(() => {
    const lbl = document.getElementById('pfWaitLabel');
    if (lbl) lbl.textContent = 'השרת מתעורר... עוד רגע ☕';
  }, 15000);

  let found = null;
  const pollEnd = Date.now() + 60000;
  while (Date.now() < pollEnd) {
    await new Promise(r => setTimeout(r, 600));
    const s = (await chrome.storage.local.get([pKey]))[pKey];
    if (s && (Date.now() - s.ts) < 10 * 60 * 1000 && s.questions?.length > 0) {
      found = s;
      break;
    }
  }
  clearTimeout(wakeTimer);
  stopWaitAnim();

  if (found) {
    _loadPreflightCache(found);
    chrome.storage.local.remove([pKey]);
    showQuestionsScreen(found.questions);
    return;
  }

  // ── 5. Fallback: stream questions live (FAB was never clicked or timed out) ──
  // We skip the batch preflight and stream Pass1+Pass2 together so questions
  // appear word-by-word and the user can start typing before streaming finishes.
  await streamQuestionsIntoScreen();
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
// ── Score tracking: state.questionScores[idx] = 0..100 ──────────────────────
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

  // ── Question cards: skill label + question + glossary + why + 3 buttons + textarea ──
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

  // Button clicks → set score + highlight + optional textarea fill
  container.querySelectorAll('.qa-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const val = parseInt(btn.dataset.val);
      state.questionScores[idx] = val;
      // Highlight selected button; clear siblings
      const row = btn.closest('.quick-answers');
      row.querySelectorAll('.qa-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      // Pre-fill textarea with template if empty
      const ta = document.getElementById(`qs_ta_${questions[idx]?.id || idx}`);
      if (ta && !ta.value.trim()) {
        ta.value = val === 100 ? 'כן, יש לי ניסיון בתחום זה.' : val === 40 ? 'מכיר את התחום ברמה תיאורטית.' : 'אין לי ניסיון בתחום זה.';
      }
      _updateQuestionsScore();
    });
  });

  // Textarea free-text → debounced analysis → update score
  container.querySelectorAll('.q-textarea').forEach(ta => {
    ta.addEventListener('input', () => {
      clearTimeout(_scoreDebounceTimer);
      _scoreDebounceTimer = setTimeout(() => {
        const idx = parseInt(ta.dataset.idx);
        state.questionScores[idx] = _analyzeAnswer(ta.value);
        // Deselect buttons since user typed freely
        const card = ta.closest('.question-card');
        card?.querySelectorAll('.qa-btn').forEach(b => b.classList.remove('selected'));
        _updateQuestionsScore();
      }, 600);
    });
  });

  // Restore previously saved answers
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

  // ── Model selector ────────────────────────────────────────────────────────
  const modelRow = document.createElement('div');
  modelRow.className = 'model-selector-row';
  modelRow.innerHTML = `
    <div class="settings-label" style="margin:14px 0 7px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)">🤖 מודל ניתוח</div>
    <div class="cv-opts-row">
      <button class="cv-opt-btn ${cvOptions.model !== 'fable' ? 'active' : ''}" data-model="sonnet">
        ⚡ Sonnet <span class="model-quota-badge" id="sonnetQuota"></span>
      </button>
      <button class="cv-opt-btn ${cvOptions.model === 'fable' ? 'active' : ''}" data-model="fable" id="fableBtn">
        🔥 Fable <span class="model-quota-badge" id="fableQuota"></span>
      </button>
    </div>
    <div class="model-hint" id="modelHint"></div>
  `;
  outOpts.appendChild(modelRow);
  _updateQuotaDisplay(); // populate quota badges
  modelRow.querySelectorAll('[data-model]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      cvOptions.model = btn.dataset.model;
      modelRow.querySelectorAll('[data-model]').forEach(b => b.classList.toggle('active', b === btn));
      const hint = document.getElementById('modelHint');
      if (hint) hint.textContent = cvOptions.model === 'fable'
        ? '🔥 Fable — ניתוח קיצוני למשרות החשובות ביותר (מכסה מוגבלת)'
        : '⚡ Sonnet — מדויק ומהיר בזכות Prompt Caching';
    });
  });

  // ── Tracking opt ─────────────────────────────────────────────────────────
  chrome.storage.local.get(['enableTracking'], (s) => {
    cvOptions.tracking = s.enableTracking !== false;
    const trackRow = document.createElement('div');
    trackRow.className = 'tracking-opt-row';
    trackRow.innerHTML = `
      <label class="tracking-opt-label">
        <input type="checkbox" id="cbTracking" ${cvOptions.tracking ? 'checked' : ''}>
        <span>הפעל מעקב קישורים חכם</span>
      </label>
      <span class="info-icon" tabindex="0"
        title="מאפשר לדעת מתי מגייסים פתחו את הקישורים שלך (GitHub/LinkedIn). ⚠️ קישורי מעקב עלולים לגרום להודעת אזהרה ב-Word המקומי — פתיחה מהדפדפן/מייל תעבוד חלק.">ⓘ</span>
    `;
    outOpts.appendChild(trackRow);
    document.getElementById('cbTracking').addEventListener('change', (e) => {
      cvOptions.tracking = e.target.checked;
      chrome.storage.local.set({ enableTracking: cvOptions.tracking });
    });
  });

  showScreen('questions');
}

// ── Shared: append language/format/model/tracking options to questions screen ─
function _appendQuestionsOptions(container) {
  const autoLang = state.analysis?.jobLanguage || state.jobLanguage || 'english';
  cvOptions.language = autoLang;
  cvOptions.format   = 'docx';

  const outOpts = document.createElement('div');
  outOpts.className = 'output-options';
  outOpts.innerHTML = `
    <div class="settings-label" style="margin:14px 0 7px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)">📄 פורמט פלט</div>
    <div class="cv-opts-row">
      <button class="cv-opt-btn ${autoLang === 'english' ? 'active' : ''}" data-lang="english">🇺🇸 English</button>
      <button class="cv-opt-btn ${autoLang === 'hebrew'  ? 'active' : ''}" data-lang="hebrew">🇮🇱 עברית</button>
    </div>
    <div class="cv-opts-row" style="margin-top:8px">
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

  const modelRow = document.createElement('div');
  modelRow.className = 'model-selector-row';
  modelRow.innerHTML = `
    <div class="settings-label" style="margin:14px 0 7px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)">🤖 מודל ניתוח</div>
    <div class="cv-opts-row">
      <button class="cv-opt-btn ${cvOptions.model !== 'fable' ? 'active' : ''}" data-model="sonnet">
        ⚡ Sonnet <span class="model-quota-badge" id="sonnetQuota"></span>
      </button>
      <button class="cv-opt-btn ${cvOptions.model === 'fable' ? 'active' : ''}" data-model="fable">
        🔥 Fable <span class="model-quota-badge" id="fableQuota"></span>
      </button>
    </div>
    <div class="model-hint" id="modelHint"></div>
  `;
  outOpts.appendChild(modelRow);
  _updateQuotaDisplay();
  modelRow.querySelectorAll('[data-model]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      cvOptions.model = btn.dataset.model;
      modelRow.querySelectorAll('[data-model]').forEach(b => b.classList.toggle('active', b === btn));
      const hint = document.getElementById('modelHint');
      if (hint) hint.textContent = cvOptions.model === 'fable'
        ? '🔥 Fable — ניתוח קיצוני למשרות החשובות ביותר (מכסה מוגבלת)'
        : '⚡ Sonnet — מדויק ומהיר בזכות Prompt Caching';
    });
  });

  chrome.storage.local.get(['enableTracking'], (s) => {
    cvOptions.tracking = s.enableTracking !== false;
    const trackRow = document.createElement('div');
    trackRow.className = 'tracking-opt-row';
    trackRow.innerHTML = `
      <label class="tracking-opt-label">
        <input type="checkbox" id="cbTracking" ${cvOptions.tracking ? 'checked' : ''}>
        <span>הפעל מעקב קישורים חכם</span>
      </label>
      <span class="info-icon" tabindex="0"
        title="מאפשר לדעת מתי מגייסים פתחו את הקישורים שלך. ⚠️ קישורי מעקב עלולים לגרום להודעת אזהרה ב-Word המקומי.">ⓘ</span>
    `;
    outOpts.appendChild(trackRow);
    document.getElementById('cbTracking')?.addEventListener('change', (e) => {
      cvOptions.tracking = e.target.checked;
      chrome.storage.local.set({ enableTracking: cvOptions.tracking });
    });
  });
}

// ── Live streaming questions screen ──────────────────────────────────────────
// Called when no FAB cache is available. Calls /api/stream-questions which runs
// Pass 1 (score) then streams questions token-by-token. The textarea for each
// question is inserted the moment q_open arrives — before the sentence ends —
// so the user can start typing while remaining questions are still streaming.
async function streamQuestionsIntoScreen() {
  const BACKEND = 'https://job-match-ai-extension.onrender.com';
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
        _updateQuestionsScore();
      });
    });
    const ta = card.querySelector('.q-textarea');
    ta?.addEventListener('input', () => {
      clearTimeout(_scoreDebounceTimer);
      _scoreDebounceTimer = setTimeout(() => {
        const i = parseInt(ta.dataset.idx);
        state.questionScores[i] = _analyzeAnswer(ta.value);
        ta.closest('.question-card')?.querySelectorAll('.qa-btn')
          .forEach(b => b.classList.remove('selected'));
        _updateQuestionsScore();
      }, 600);
    });
  }

  try {
    const resp = await fetch(`${BACKEND}/api/stream-questions`, {
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
            if (q) q.explanation = explanation;
          }
          _cards[id]?.card.classList.remove('qs-streaming');
        }
      }
    }
  } catch (err) {
    console.error('[JMA:stream-q]', err);
    document.getElementById('qsLoader')?.remove();
    if (!state.questions.length) {
      // Hard fallback: show error + skip-to-analysis button
      const errEl = document.createElement('div');
      errEl.style.cssText = 'color:#ef4444;padding:16px;text-align:center;';
      errEl.textContent = 'שגיאה בטעינת שאלות. ניתן לדלג ישירות לניתוח.';
      qArea.appendChild(errEl);
    }
  }

  // ── Footer: output options + continue button ──────────────────────────────
  _appendQuestionsOptions(container);
}

function collectAnswers() {
  return (state.questions || []).map((q, idx) => {
    const ta     = document.getElementById(`qs_ta_${q.id || idx}`);
    const answer = ta ? ta.value.trim() : '';
    const scorePct = state.questionScores?.[idx] ?? _analyzeAnswer(answer);
    return { skill: q.skill, answer: answer || 'לא ענה', sliderValue: scorePct, weight: q.weight || 0 };
  });
}

document.getElementById('btnContinueToCV').addEventListener('click', async () => {
  const answers = collectAnswers();
  state.answers = answers;
  await saveJobState({ answers });

  // ── Quota check ────────────────────────────────────────────────────────
  const model = cvOptions.model || 'sonnet';
  const { allowed, used, limit } = await _checkQuota(model);
  if (!allowed) {
    const modelName = model === 'fable' ? 'Fable' : 'Sonnet';
    showMainError(`הגעת למכסה החודשית של ${modelName} (${used}/${limit}). המכסה מתחדשת ב-1 לחודש הבא.`);
    showScreen('main');
    return;
  }
  await _incrementUsage(model);

  // Compute weighted score from question answers
  if (state.baseScore) {
    const bonus = answers.reduce((s, a) => s + ((a.sliderValue || 0) / 100) * (a.weight || 0), 0);
    const finalScore = Math.min(100, Math.round(state.baseScore + bonus));
    if (state.analysis) state.analysis.score = finalScore;
  }

  // Start CV generation in background (parallel with streaming analysis)
  state.cvGenPromise = _startCvGenBackground(answers, cvOptions.language, cvOptions.format);

  await runStreamingAnalysis(answers);
});

async function runStreamingAnalysis(answers) {
  // ── Quota check (120 analyses/month for free tier) ───────────────────────
  const { allowed: streamAllowed, used: streamUsed, limit: streamLimit } = await _checkQuota(cvOptions.model || 'sonnet');
  if (!streamAllowed) {
    const modelName = (cvOptions.model || 'sonnet') === 'fable' ? 'Fable' : 'Sonnet';
    showMainError(`הגעת למכסת הניתוחים החודשית (${streamUsed}/${streamLimit} ${modelName}). המכסה מתחדשת ב-1 לחודש.`);
    return;
  }

  showScreen('main');
  const mainContent = document.getElementById('mainContent');
  mainContent.innerHTML = `
    <div class="stream-wrap">
      <div class="stream-header">
        <span class="stream-icon">🔍</span>
        <span class="stream-title">ניתוח התאמה מלא</span>
        <span class="stream-score" id="streamScore">${state.analysis?.score ?? '—'}%</span>
      </div>
      <div class="stream-questions" id="streamQuestions"></div>
      <div class="stream-body" id="streamBody" dir="auto"></div>
      <div class="stream-footer" id="streamFooter" style="display:none">
        <button class="btn-primary" id="btnGoToCV">הבא — קורות חיים מותאמים ›</button>
      </div>
    </div>`;
  document.getElementById('mainLoading').style.display = 'none';
  document.getElementById('mainError').style.display = 'none';

  const stored = await chrome.storage.local.get(['licenseKey', 'cvText', 'userConstraints']);
  const licenseKey = stored.licenseKey || state.licenseKey || '';
  const BACKEND = 'https://job-match-ai.onrender.com';

  const streamQuestions = document.getElementById('streamQuestions');
  const streamBody = document.getElementById('streamBody');
  let accText = '';
  let streamOk = false;
  let phase = 'questions'; // 'questions' → 'analysis'

  function _appendQuestion(q) {
    const pill = document.createElement('div');
    pill.className = 'stream-q-pill stream-q-in';
    pill.innerHTML = `
      <span class="stream-q-skill">${q.skill || ''}</span>
      <span class="stream-q-text">${q.question || ''}</span>
      ${q.explanation ? `<span class="stream-q-exp">${q.explanation}</span>` : ''}`;
    streamQuestions.appendChild(pill);
    streamQuestions.scrollTop = streamQuestions.scrollHeight;
  }

  try {
    const resp = await fetch(`${BACKEND}/api/analyze-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': licenseKey },
      body: JSON.stringify({
        cvText: stored.cvText || state.cvText || '',
        jobText: state.jobText || '',
        answers: answers,
        userConstraints: stored.userConstraints || state.userConstraints || '',
        model: cvOptions.model || 'sonnet',
      }),
    });

    if (!resp.ok) {
      if (resp.status === 422) {
        let detail = 'Analysis body too long';
        try { const j = await resp.json(); detail = j.detail || detail; } catch {}
        if (detail.includes('too long')) {
          showMainError('טקסט המשרה ארוך מדי לניתוח. אנא קצר את תיאור המשרה ונסה שנית.');
          return;
        }
      }
      throw new Error(`HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
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
        if (raw === '[DONE]') { streamOk = true; break; }
        try {
          const chunk = JSON.parse(raw);
          if (chunk.error) {
            showMainError(chunk.error);
            return;
          }
          if (chunk.question && phase === 'questions') {
            _appendQuestion(chunk.question);
          } else if (chunk.phase === 'analysis') {
            phase = 'analysis';
            if (streamQuestions.children.length > 0) {
              streamQuestions.style.borderBottom = '1px solid var(--border)';
              streamQuestions.style.marginBottom = '12px';
              streamQuestions.style.paddingBottom = '12px';
            }
          } else if (chunk.text && phase === 'analysis') {
            accText += chunk.text;
            streamBody.textContent = accText;
            streamBody.scrollTop = streamBody.scrollHeight;
          }
        } catch {}
      }
      if (streamOk) break;
    }
  } catch (err) {
    console.error('[JMA:stream] error', err);
    if (state.analysis?.summary) {
      streamBody.textContent = state.analysis.summary;
      streamOk = true;
    } else {
      streamBody.innerHTML = `<span style="color:#ef4444">שגיאה בניתוח. נסה שוב.</span>`;
    }
  }

  // Show "Next" button — CV gen runs in parallel so it may already be ready
  document.getElementById('streamFooter').style.display = '';
  document.getElementById('btnGoToCV').addEventListener('click', async () => {
    _armCvButton(cvOptions.language);
    showScreen('main');
  });
}

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
      enableTracking: cvOptions.tracking !== false,
      jobTitle: _bestJobTitle(),
      company: _bestCompany(),
      model: cvOptions.model || 'sonnet',
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
    const jt = _bestJobTitle();
    const record = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      jobTitle: jt,
      company: _bestCompany(),
      platform: state.jobPlatform,
      url: state.jobUrl,
      score: state.analysis?.score || 0,
      cvGenerated: true,
      cvFilename: `CV_${jt.replace(/[^a-zA-Z0-9א-ת]/g, '_')}.docx`,
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
    enableTracking: cvOptions.tracking !== false,
    jobTitle: _bestJobTitle(),
    company: _bestCompany(),
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
  const jt2 = _bestJobTitle();
  const record = {
    id: Date.now().toString(),
    date: new Date().toISOString(),
    jobTitle: jt2,
    company: _bestCompany(),
    platform: state.jobPlatform,
    url: state.jobUrl,
    score: state.analysis?.score || 0,
    cvGenerated: true,
    cvFilename: `CV_${jt2.replace(/[^a-zA-Z0-9א-ת]/g, '_')}.docx`,
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
  const jobTitle = _bestJobTitle().replace(/[^a-zA-Z0-9\sא-ת]/g, '').replace(/\s+/g, '_').trim() || 'CV';
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

  // Find the job with the globally newest recruiter click (for row highlight)
  let newestClickTs = 0;
  let newestClickJobId = null;
  for (const j of jobs) {
    if (!j.appId) continue;
    const clicks = clicksMap[j.appId] || [];
    if (clicks.length === 0) continue;
    const latest = clicks.reduce((a, b) => (a.ts > b.ts ? a : b));
    const ts = new Date(latest.ts).getTime();
    if (ts > newestClickTs) { newestClickTs = ts; newestClickJobId = j.id; }
  }

  const rows = jobs.map(j => {
    const score = j.score || 0;
    const scoreClass = score >= 75 ? 'score-green' : score >= 55 ? 'score-yellow' : score >= 35 ? 'score-orange' : 'score-red';
    const date = new Date(j.date).toLocaleDateString('he-IL');
    const status = j.status || 'טרם טופל';
    const isNewest = j.id === newestClickJobId;

    // Link-click cells: which target | click count | last opened
    let linkTargetCell  = '<span class="no-data">-</span>';
    let clickCountCell  = '<span class="no-data">-</span>';
    let lastOpenedCell  = '<span class="no-data">-</span>';
    if (j.appId) {
      const clicks = clicksMap[j.appId] || [];
      if (clicks.length > 0) {
        const targets = [...new Set(clicks.map(c => c.target))];
        const label = targets.map(t => t === 'github' ? 'GitHub' : t === 'linkedin' ? 'LinkedIn' : 'Portfolio').join(', ');
        linkTargetCell = `<span style="color:#16a34a;font-weight:600">✅ ${label}</span>`;
        clickCountCell = `<span style="font-weight:700;color:var(--accent)">${clicks.length}</span>`;
        const latest = clicks.reduce((a, b) => (a.ts > b.ts ? a : b));
        const ld = new Date(latest.ts);
        const timeStr = ld.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
        if (isNewest) {
          lastOpenedCell = `<span class="tracker-latest-blink" style="font-size:11px;font-weight:700">${ld.toLocaleDateString('he-IL')} ${timeStr} 🔥</span>`;
        } else {
          lastOpenedCell = `<span style="font-size:11px;color:var(--text-secondary)">${ld.toLocaleDateString('he-IL')}<br><span style="color:var(--text-muted)">${timeStr}</span></span>`;
        }
      } else {
        linkTargetCell = `<span style="color:#9ca3af">⏳ ממתין</span>`;
      }
    }

    return `<tr${isNewest ? ' class="tracker-row-hot"' : ''}>
      <td>${date}</td>
      <td style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${j.jobTitle || '-'}</td>
      <td style="max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${j.company || '-'}</td>
      <td><span class="platform-tag">${j.platform || '-'}</span></td>
      <td class="score-cell ${scoreClass}">${score}%</td>
      <td>${j.cvGenerated ? '✅' : '❌'}</td>
      <td>${linkTargetCell}</td>
      <td style="text-align:center">${clickCountCell}</td>
      <td>${lastOpenedCell}</td>
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
            <th>לינק נפתח</th>
            <th>לחיצות</th>
            <th>פתיחה אחרונה</th>
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
    exportToExcel(allJobs, clicksMap);
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
  const isPrem = !!(res.result && res.result.isPremium);
  await chrome.storage.local.set({
    licenseKey: key,
    licenseValid: true,
    isPremium: isPrem,
    jma_is_premium: isPrem,
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

    // FAB click → auto-stream: skip all state restoration, go straight to questions
    const autoStreamData = await chrome.storage.local.get(['jma_auto_stream', 'jma_job_text', 'licenseKey', 'cvText', 'jma_local_score']);
    if (autoStreamData.jma_auto_stream) {
      await chrome.storage.local.remove(['jma_auto_stream']);
      const stored2 = await chrome.storage.local.get(['licenseKey', 'cvText', 'jma_local_score']);
      state.licenseKey = stored2.licenseKey || '';
      state.cvText     = stored2.cvText     || '';
      state.baseScore  = stored2.jma_local_score || 0;
      state.jobText    = autoStreamData.jma_job_text || '';
      await streamQuestionsIntoScreen();
      return;
    }

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
