async function callClaude(apiKey, messages, maxTokens = 1200) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages
    })
  });

  if (!res.ok) {
    let errMsg = `API Error ${res.status}`;
    try {
      const e = await res.json();
      errMsg = e.error?.message || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const data = await res.json();
  return data.content.map(b => b.text || '').join('');
}

function parseJsonFromResponse(text) {
  // Try to extract JSON from markdown code blocks or raw
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : text;
  return JSON.parse(jsonStr.trim());
}

const ANALYZE_PROMPT = `אתה מומחה גיוס בכיר. נתח את ההתאמה בין קורות החיים למשרה.
חוקים:
- ציון 0-100 לפי כמה הניסיון האמיתי תואם את הדרישות
- זהה דרישות חובה שחסרות (hard_gaps)
- זהה דרישות "nice to have" שחסרות — אלה ישאלו את המועמד (questions)
- שאלות: רק על דברים שיכולים לשנות את ההחלטה, מקסימום 3 שאלות
- זהה את שפת המשרה
החזר JSON בלבד (ללא markdown, ללא הסברים):
{
  "score": <0-100>,
  "jobTitle": "<שם התפקיד>",
  "company": "<שם החברה>",
  "jobLanguage": "hebrew" | "english",
  "summary": "<2 משפטים: למה מתאים/לא מתאים>",
  "strengths": ["<חוזקה קצרה>", ...],
  "hard_gaps": ["<חסר חובה>", ...],
  "questions": [
    {
      "id": "q1",
      "skill": "<שם הכישור>",
      "question": "<שאלה קצרה בשפת המשרה>",
      "why": "<למה חשוב למשרה הזו>"
    }
  ]
}
=== קורות החיים ===
{cvText}
=== תיאור המשרה ===
{jobText}`;

const CV_PASS1_PROMPT = `You are a senior CV writer and recruiter expert.
Create a tailored CV in {language} based on the original CV and job requirements.
ABSOLUTE RULES — never break these:
1. ONE PAGE MAXIMUM — cut less relevant content if needed to fit one page
2. NEVER invent experience, skills, dates, or company names
3. Do not reorder major sections — always: Profile → Experience → Education → Skills → Languages
4. Languages section is ALWAYS last
WHAT YOU CAN CHANGE:
- PROFILE: Rewrite completely to match this specific job. Make it personal, specific, human — not generic.
  The first thing the recruiter reads should make them think "this is exactly who we need."
- JOB TITLE / HEADLINE: Change to match the job title if it's truthful
- Within experience entries: reorder bullet points to put most relevant first
- Remove irrelevant bullet points ONLY if needed to stay on one page
- Skills section: highlight relevant skills, remove irrelevant ones if needed for space
WHAT YOU MUST NEVER CHANGE:
- Actual company names, dates, job titles held
- Any factual information
- The chronological order of experience entries
TONE: Professional but human. Sounds like a real person wrote it, not AI.
OUTPUT FORMAT — use these exact section markers:
[NAME]
Full name here
[HEADLINE]
Job title here
[CONTACT]
Contact details here
[PROFILE]
Profile text here
[EXPERIENCE]
Experience entries here
[EDUCATION]
Education entries here
[SKILLS]
Skills here
[LANGUAGES]
Languages here (always last)
=== ORIGINAL CV ===
{cvText}
=== CANDIDATE ANSWERS TO QUESTIONS ===
{answersText}
=== JOB DESCRIPTION ===
{jobText}`;

const CV_PASS2_PROMPT = `You are a ruthless senior recruiter reviewing a tailored CV before it goes to a hiring manager.
Review and improve this CV against these criteria:
1. PROFILE: Does it immediately show this person is the answer to this job's needs?
   If it's generic or weak — rewrite it completely.
2. SPECIFICITY: Remove vague buzzwords. Replace with concrete examples or remove.
3. LENGTH: Must fit ONE page. Cut anything that doesn't add value for THIS job.
4. HUMAN TONE: Should not sound AI-generated. Adjust if needed.
5. RELEVANCE: Most relevant experience/skills must be visible in the first third of the CV.
6. HONESTY: Do not add anything not in the original CV.
Output ONLY the improved CV with the same section markers:
[NAME], [HEADLINE], [CONTACT], [PROFILE], [EXPERIENCE], [EDUCATION], [SKILLS], [LANGUAGES]
Do NOT add explanations, comments, or notes outside the CV.
=== CV TO REVIEW ===
{cvDraft}
=== JOB DESCRIPTION ===
{jobText}`;

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'analyzeJob') {
    handleAnalyzeJob(req).then(sendResponse).catch(err => sendResponse({ error: friendlyError(err) }));
    return true;
  }
  if (req.action === 'generateCV') {
    handleGenerateCV(req).then(sendResponse).catch(err => sendResponse({ error: friendlyError(err) }));
    return true;
  }
});

function friendlyError(err) {
  const msg = err.message || String(err);
  if (msg.includes('401') || msg.toLowerCase().includes('invalid x-api-key') || msg.toLowerCase().includes('authentication')) {
    return 'מפתח API לא תקין. עדכן בהגדרות.';
  }
  if (msg.includes('429')) {
    return 'יותר מדי בקשות, נסה שוב בעוד רגע.';
  }
  if (msg.match(/5\d\d/)) {
    return 'שגיאה זמנית בשרת, נסה שוב.';
  }
  if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('failed')) {
    return 'בעיית חיבור לאינטרנט.';
  }
  return msg;
}

async function handleAnalyzeJob({ apiKey, cvText, jobText }) {
  const prompt = ANALYZE_PROMPT
    .replace('{cvText}', cvText)
    .replace('{jobText}', jobText);

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await callClaude(apiKey, [{ role: 'user', content: prompt }], 1200);
      const parsed = parseJsonFromResponse(raw);
      return { result: parsed };
    } catch (e) {
      lastError = e;
      if (e.message && (e.message.includes('401') || e.message.includes('429'))) break;
      // JSON parse errors: retry
    }
  }
  throw lastError;
}

async function handleGenerateCV({ apiKey, cvText, jobText, jobLanguage, answers }) {
  const answersText = answers && answers.length > 0
    ? answers.map(a => `${a.skill}: ${a.answer}`).join('\n')
    : 'No additional information provided.';

  const language = jobLanguage === 'hebrew' ? 'Hebrew' : 'English';

  // Pass 1
  const pass1Prompt = CV_PASS1_PROMPT
    .replace('{language}', language)
    .replace('{cvText}', cvText)
    .replace('{answersText}', answersText)
    .replace('{jobText}', jobText);

  const cvDraft = await callClaude(apiKey, [{ role: 'user', content: pass1Prompt }], 2000);

  // Pass 2
  const pass2Prompt = CV_PASS2_PROMPT
    .replace('{cvDraft}', cvDraft)
    .replace('{jobText}', jobText);

  const cvFinal = await callClaude(apiKey, [{ role: 'user', content: pass2Prompt }], 2000);

  return { cvText: cvFinal };
}
