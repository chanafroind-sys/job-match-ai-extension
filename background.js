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
5. Do NOT present freelance or independent projects as full-time employment positions
6. Do NOT change the chronological order of work experience entries

LANGUAGE RULE — 100% ENGLISH ONLY:
- The entire CV must be written in English from start to finish — no exceptions
- The candidate's name must always appear in English only (e.g. Chana Froind) — never translate it to Hebrew or any other language, even if the job description is written in Hebrew
- Do not mix any Hebrew words or characters anywhere in the document

COMPANY STRUCTURE IS SACRED — never break this:
- Keep every employer as its own separate block with its own company name, job title, and dates
- NEVER merge bullet points from different companies or roles into a single thematic list
- Recruiters must be able to clearly see what was done in a large company vs. a startup vs. a freelance project
- You may reorder bullet points WITHIN a single role to highlight the most relevant ones first
- You may remove irrelevant bullet points within a role to save space
- You may NOT move bullets across roles or companies under any circumstances

HEADLINE / SENIORITY GUARDRAILS:
- Use the candidate's real core title as the base (e.g. Backend Developer, Software Engineer)
- You may append a focused orientation if supported by real coursework or projects (e.g. Backend Developer | AI & Data Foundations) — but keep it subtle and credible
- Do NOT add seniority levels (Senior, Lead, Staff, Principal, Engineer III, etc.) unless the candidate's CV explicitly shows they held such a title
- Do NOT introduce a completely new domain title (e.g. Machine Learning Engineer) based on courses alone

PROFILE WRITING RULES:
- Write what the candidate genuinely brings from their real experience and how their existing skills naturally connect to this role's needs
- Do NOT copy or paraphrase sentences from the job description — it sounds fake and recruiters notice immediately
- The profile must sound like the candidate speaking about themselves, not echoing the employer's language
- Make it personal, specific, and grounded in what is actually in the CV

BOLD FORMATTING FOR RECRUITER SCANNING:
- Use **double asterisks** around 3–6 key terms per section that a recruiter's eye should land on immediately
- Bold: specific technologies, measurable achievements, and role-critical skills that match this job
- Do NOT bold generic words (e.g. "team player", "motivated", "experience")
- Example: "Built **RESTful APIs** in **Python/Django** serving **50K+ daily requests**"

WHAT YOU CAN CHANGE:
- PROFILE: Rewrite to authentically position the candidate for this job based on their real background
- Within a single experience entry: reorder bullet points to put most relevant first, remove irrelevant ones
- Skills section: highlight relevant skills, remove irrelevant ones if needed for space

WHAT YOU MUST NEVER CHANGE:
- Actual company names, dates, or job titles the candidate held
- The chronological order or grouping of experience entries
- Any factual information
- The candidate's name (keep in English exactly as written)

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
Review and improve this CV against ALL of these criteria — fix every issue you find:

1. LANGUAGE: Is the entire CV in 100% English? If any Hebrew words or characters appear anywhere — translate or remove them.
   The candidate's name must remain in English exactly as written (e.g. Chana Froind) — never translate it.

2. COMPANY STRUCTURE: Is every employer kept as its own separate block? If bullet points from different companies
   or roles have been merged into a thematic list — restore the original per-company structure immediately.
   Recruiters must clearly see what was done where. This is non-negotiable.

3. PROFILE AUTHENTICITY: Does the profile sound like the candidate speaking from their real experience?
   If it echoes the job description's language or sounds copy-pasted — rewrite it from the candidate's perspective.
   The profile must be grounded in what is shown in the experience section, not what the job posting says.

4. SENIORITY CHECK: Is the headline accurate? Remove any Senior/Lead/Staff/Principal or inflated domain title
   (e.g. Machine Learning Engineer) not supported by actual held job titles in the experience section.
   A subtle orientation suffix (e.g. "| AI & Data Foundations") is acceptable if backed by real projects or courses.

5. BOLD FORMATTING: Are 3–6 key terms per section bolded with **double asterisks**?
   Bold specific technologies, measurable results, and role-critical skills. Remove bold from generic phrases.

6. SPECIFICITY: Remove vague buzzwords. Replace with concrete examples or remove entirely.

7. LENGTH: Must fit ONE page. Cut anything that doesn't add value for THIS specific job.

8. HUMAN TONE: Should not sound AI-generated. Adjust phrasing if needed.

9. HONESTY: Do not add anything not in the original CV. Do not present freelance work as full-time employment.

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
