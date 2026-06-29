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
};

let cvOptions = { language: 'english', format: 'docx' };

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
            // compression method 8 = DEFLATE, 0 = stored
            return compression === 8 ? await inflateRaw(data) : data;
          }
        }
      }
      return null;
    };

    const xmlBytes = await findFile('word/document.xml');
    if (!xmlBytes) return null;

    const xml = new TextDecoder('utf-8').decode(xmlBytes);
    // Split by paragraphs and extract w:t text
    const paras = xml.split(/<w:p[ >\/]/);
    let result = '';
    for (const para of paras) {
      const tMatches = [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
      if (tMatches.length > 0) {
        result += tMatches.map(m => m[1]).join('') + '\n';
      }
    }
    return result.trim();
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
    const text = await extractDocxText(buf);
    if (!text) throw new Error('לא ניתן לקרוא את הקובץ. נסה להמיר ל-.txt');
    return text;
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

// Settings screen
async function loadSettings() {
  const data = await chrome.storage.local.get(['cvText', 'cvName', 'licenseKey', 'licenseValid', 'isPremium']);
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
}

document.getElementById('uploadArea').addEventListener('click', () => {
  document.getElementById('cvFileInput').click();
});

document.getElementById('cvFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await readCVFile(file);
    document.getElementById('uploadText').textContent = `✅ ${file.name}`;
    document.getElementById('uploadArea').classList.add('has-file');
    const successEl = document.getElementById('uploadSuccess');
    successEl.textContent = `הועלה: ${file.name} (${Math.round(file.size / 1024)} KB)`;
    successEl.style.display = 'block';
    // Store temporarily
    document.getElementById('cvFileInput')._extractedText = text;
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
    statusEl.textContent = `✅ אומת: ${newKey.slice(0, 4)}-****-****-${newKey.slice(-4)}${toSave.isPremium ? ' ⭐ פרימיום' : ' (בסיסי)'}`;
    statusEl.style.color = '#4caf50';
    document.getElementById('licenseKeySettings').value = '';
  }

  if (Object.keys(toSave).length > 0) await chrome.storage.local.set(toSave);
  document.getElementById('btnSaveSettings').textContent = '✅ נשמר!';
  setTimeout(() => {
    document.getElementById('btnSaveSettings').textContent = '💾 שמור הגדרות';
    showReadyScreen();
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

function showMainResult(analysis) {
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
  document.getElementById('summaryEl').textContent = analysis.summary || '';

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
  showScreen('main');
  showMainLoading('מאתר שאלות רלוונטיות למשרה...');

  const stored = await chrome.storage.local.get(['licenseKey', 'cvText']);
  if (!stored.licenseKey) { showMainError('לא נמצא רישיון פעיל. חזרי למסך הראשי.'); return; }
  if (!stored.cvText) { showMainError('עוד לא הועלו קורות חיים. לחצי על ⚙️ בפינה כדי להוסיף.'); return; }
  state.licenseKey = stored.licenseKey;
  state.cvText = stored.cvText;

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

  // Preflight: get questions only (no score, no usage count)
  const prefResp = await chrome.runtime.sendMessage({
    action: 'analyzeJob',
    licenseKey: state.licenseKey,
    cvText: state.cvText,
    jobText: state.jobText,
    preflight: true,
    answers: [],
  });

  console.log('[JMA:preflight] resp=', JSON.stringify(prefResp));
  const newQuestions = (!prefResp?.error && prefResp?.result?.questions) || [];
  console.log('[JMA:preflight] questions count=', newQuestions.length);

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
document.getElementById('btnGenerateCV').addEventListener('click', () => {
  showCVOptionsScreen();
});

// Questions screen
function showQuestionsScreen(questions, savedAnswers) {
  const container = document.getElementById('questionsContainer');
  container.innerHTML = '';

  questions.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'question-card';
    card.innerHTML = `
      <div class="question-skill">${q.skill}</div>
      <div class="question-text">${q.question}</div>
      <div class="question-why">${q.why}</div>
      ${q.heExplanation ? `<div class="question-he-exp">💡 ${q.heExplanation}</div>` : ''}
      <div class="quick-answers">
        <button class="qa-btn" data-idx="${idx}" data-val="כן, יש לי ניסיון">✅ כן, יש לי ניסיון</button>
        <button class="qa-btn" data-idx="${idx}" data-val="ידע תיאורטי בלבד">📚 תיאורטי בלבד</button>
        <button class="qa-btn" data-idx="${idx}" data-val="לא, אין לי">❌ לא, אין לי</button>
      </div>
      <textarea class="question-textarea" data-idx="${idx}" placeholder="או כתוב תשובה חופשית..."></textarea>
    `;
    container.appendChild(card);
  });

  // Quick answer buttons
  container.querySelectorAll('.qa-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      container.querySelectorAll(`.qa-btn[data-idx="${idx}"]`).forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const ta = container.querySelector(`.question-textarea[data-idx="${idx}"]`);
      ta.value = btn.dataset.val;
    });
  });

  // Restore previously saved answers
  if (savedAnswers && savedAnswers.length > 0) {
    savedAnswers.forEach((a, idx) => {
      const val = a.answer || '';
      if (!val || val === 'לא ענה') return;
      const ta = container.querySelector(`.question-textarea[data-idx="${idx}"]`);
      if (ta) ta.value = val;
      container.querySelectorAll(`.qa-btn[data-idx="${idx}"]`).forEach(btn => {
        if (btn.dataset.val === val) btn.classList.add('selected');
      });
    });
  }

  showScreen('questions');
}

function collectAnswers() {
  const questions = state.questions || [];
  const answers = [];
  questions.forEach((q, idx) => {
    const ta = document.querySelector(`.question-textarea[data-idx="${idx}"]`);
    const val = ta ? ta.value.trim() : '';
    answers.push({ skill: q.skill, answer: val || 'לא ענה' });
  });
  return answers;
}

document.getElementById('btnContinueToCV').addEventListener('click', () => {
  const answers = collectAnswers();
  runFullAnalysis(answers);
});

document.getElementById('btnSkipQuestions').addEventListener('click', () => {
  runFullAnalysis([]);
});

// CV Options screen
function showCVOptionsScreen() {
  cvOptions.language = 'english';
  cvOptions.format = 'docx';
  document.querySelectorAll('.cv-opt-btn[data-lang]').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === jobLang);
  });
  document.querySelectorAll('.cv-opt-btn[data-fmt]').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === 'docx');
  });
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

document.getElementById('btnStartCvGen').addEventListener('click', () => {
  startCVGeneration(state.answers, cvOptions.language, cvOptions.format);
});

document.getElementById('btnCvOptsBack').addEventListener('click', () => {
  showScreen('main');
});

// CV Generation
async function startCVGeneration(answers, language, format) {
  language = language || state.analysis?.jobLanguage || state.jobLanguage || 'english';
  format = format || 'docx';
  state.cvIsRtl = language === 'hebrew';
  showScreen('generating');
  setProgress(0, 'מתאים קורות חיים למשרה...', 'Pass 1 מ-2');

  setTimeout(() => setProgress(25, 'מתאים קורות חיים למשרה...', 'שולח ל-AI...'), 300);

  const response = await chrome.runtime.sendMessage({
    action: 'generateCV',
    licenseKey: state.licenseKey,
    cvText: state.cvText,
    jobText: state.jobText,
    jobLanguage: language,
    answers,
  });

  if (response.error) {
    showMainError(response.error);
    showScreen('main');
    return;
  }

  setProgress(75, 'בודק איכות מקצועית...', 'Pass 2 מ-2');
  await new Promise(r => setTimeout(r, 500));
  setProgress(100, 'הושלם!', '');

  state.generatedCV = response.cvText;
  await saveJobState({ generatedCV: response.cvText, cvLanguage: language });

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
  };
  await saveJob(record);

  showCVResult(response.cvText);
}

function setProgress(pct, title, subtitle) {
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressLabel').textContent = pct + '%';
  if (title) document.getElementById('genTitle').textContent = title;
  if (subtitle) document.getElementById('genSubtitle').textContent = subtitle;
}

function showCVResult(cvText) {
  document.getElementById('cvPreview').textContent = cvText;
  showScreen('cv-result');
}

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
  const ta = isRtl ? 'right' : 'left';
  const secs = parseCVSections(cvText);
  function ren(txt) {
    if (!txt) return '';
    return txt.split('\n').map(l => {
      l = l.trim(); if (!l) return '';
      const isBul = l.startsWith('•') || l.startsWith('- ');
      const cl = isBul ? l.replace(/^[•-]\s*/, '') : l;
      const bd = cl.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return isBul ? `<li>${bd}</li>` : `<p>${bd}</p>`;
    }).join('');
  }
  const secHtml = [
    secs['[PROFILE]'] ? `<h2>Profile</h2>${ren(secs['[PROFILE]'])}` : '',
    secs['[EXPERIENCE]'] ? `<h2>Experience</h2>${ren(secs['[EXPERIENCE]'])}` : '',
    secs['[EDUCATION]'] ? `<h2>Education</h2>${ren(secs['[EDUCATION]'])}` : '',
    secs['[SKILLS]'] ? `<h2>Skills</h2>${ren(secs['[SKILLS]'])}` : '',
    secs['[LANGUAGES]'] ? `<h2>Languages</h2>${ren(secs['[LANGUAGES]'])}` : '',
  ].join('');
  return `<!DOCTYPE html><html dir="${dir}"><head><meta charset="UTF-8"><title>CV</title>
<style>
  @media print { @page { margin: 1.5cm; } body { margin: 0; } }
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1f2937; direction: ${dir}; text-align: ${ta}; margin: 1.5cm; }
  h1 { text-align: center; font-size: 18pt; margin: 0 0 4px; }
  .hl { text-align: center; color: #7c3aed; font-size: 12pt; margin: 0 0 3px; }
  .ct { text-align: center; color: #6b7280; font-size: 10pt; margin: 0 0 14px; }
  h2 { font-size: 11pt; color: #7c3aed; border-bottom: 1px solid #7c3aed; margin: 10px 0 3px; padding-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  p { margin: 2px 0; line-height: 1.35; }
  li { margin: 1px 0; line-height: 1.35; }
  ul, ol { margin: 2px 0; padding-${isRtl ? 'right' : 'left'}: 18px; }
</style></head><body>
${secs['[NAME]'] ? `<h1>${secs['[NAME]']}</h1>` : ''}
${secs['[HEADLINE]'] ? `<p class="hl">${secs['[HEADLINE]']}</p>` : ''}
${secs['[CONTACT]'] ? `<p class="ct">${secs['[CONTACT]'].replace(/\n/g, ' | ')}</p>` : ''}
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
  setTimeout(() => { btn.textContent = '📋 העתק'; }, 1500);
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

  const rows = jobs.map(j => {
    const score = j.score || 0;
    const scoreClass = score >= 75 ? 'score-green' : score >= 55 ? 'score-yellow' : score >= 35 ? 'score-orange' : 'score-red';
    const date = new Date(j.date).toLocaleDateString('he-IL');
    const status = j.status || 'טרם טופל';
    return `<tr>
      <td>${date}</td>
      <td style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${j.jobTitle || '-'}</td>
      <td style="max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${j.company || '-'}</td>
      <td><span class="platform-tag">${j.platform || '-'}</span></td>
      <td class="score-cell ${scoreClass}">${score}%</td>
      <td>${j.cvGenerated ? '✅' : '❌'}</td>
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
  await chrome.storage.local.set({
    licenseKey: key,
    licenseValid: true,
    isPremium: !!(res.result && res.result.isPremium),
  });
  okEl.textContent = '✅ רישיון אומת בהצלחה!';
  okEl.style.display = 'block';
  setTimeout(() => showReadyScreen(), 900);
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
    const stored = await chrome.storage.local.get(['licenseKey', 'cvText']);
    const saved = await loadJobState(tab?.url);

    if (saved) {
      state.licenseKey = stored.licenseKey || '';
      state.cvText = stored.cvText || '';
      state.jobText = saved.jobText || '';
      state.jobLanguage = saved.jobLanguage || 'english';
      state.jobPlatform = saved.jobPlatform || '';
      state.jobUrl = saved.url || '';
      state.answers = saved.answers || [];
      state.questions = saved.questions || [];

      if (saved.generatedCV) {
        state.generatedCV = saved.generatedCV;
        state.analysis = saved.analysis;
        state.cvIsRtl = (saved.cvLanguage || saved.jobLanguage || 'english') === 'hebrew';
        showCVResult(saved.generatedCV);
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
