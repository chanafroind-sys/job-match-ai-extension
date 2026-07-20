/**
 * JMA Local Profile Matcher v5 — Categorical Hierarchy & Context-Aware Engine
 *
 * Input:  userProfile  — structured JSON from /api/extract-profile (stored as jma_user_profile)
 *         jobText      — raw job-description string
 * Output: { score: 0-100, bullets: string[] }
 *
 * No network calls. Runs synchronously in content.js context.
 * Exposed as window.JMA_Matcher = { computeScore }
 *
 * ── CHANGELOG v4 → v5 ───────────────────────────────────────────────────────
 * FIX-20 CATEGORY-LEVEL REQUIREMENTS (Category-over-Skill). Every tech already
 *        maps to a parent category (TECH_DOMAIN / profile.experience keys). New:
 *        when a job line asks for the CATEGORY ITSELF ("3+ years of backend
 *        development experience", "ניסיון בפיתוח צד שרת") it becomes a category
 *        requirement scored directly against the profile's category-level years
 *        (industry_summary.domain_years, with the FIX-8 fallback) — no diving
 *        into sub-skills. Guarded: the line must carry a years figure or an
 *        experience word, so "our backend team" is not an ask. Category lines
 *        are excluded from total-years extraction (no double count). Year-less
 *        category asks are skipped when concrete same-category techs were
 *        already extracted (those carry the ask).
 * FIX-21 CONSOLATION SCORING. When a specific tool is required and missing, but
 *        the candidate has SIBLING tools under the same parent category (asks
 *        Claude → has Gemini), the item is never a flat 0%: it earns up to
 *        CFG.CONSOLATION_MULT (35%) of its weight, scaled by category strength
 *        vs the ask: consolation = 0.35 × min(1, categoryYears/(reqYears||1)).
 *        Deliberately LINEAR (no FIX-19 curve) and capped — transferable-domain
 *        credit must stay conservative or unfit matches re-inflate (Job D guard).
 *        Replaces v3/v4 domain-coverage (unified across required/OR-group/
 *        advantage items; year-less baseline 3y → 1y, so a strong sibling now
 *        yields the full 35% instead of ~17%).
 * FIX-22 CONTEXT-ISOLATED YEARS (documented invariant + regression-proofed).
 *        A years figure binds ONLY to requirements extracted from ITS OWN line:
 *        "5 שנות ניסיון ב-Java" + "2+ years Node.js" stay 5y/2y respectively,
 *        and a year-less bullet between them inherits nothing (DEFAULT_REQ_YEARS
 *        applies). The only cross-line effect is FIX-5's same-tech upgrade.
 *        Job I in the suite asserts this.
 *
 * ── CHANGELOG v3 → v4 ───────────────────────────────────────────────────────
 * FIX-17 Advantage state machine restored (smart). A line that IS essentially the
 *        advantage phrase itself ("יתרון:", "יתרונות", "* נחשב יתרון -",
 *        "Nice to have:") flips the state machine: every subsequent bullet is an
 *        advantage until the next major section header (required/context). A
 *        CONTENT bullet with a trailing marker ("ניסיון עם Docker - יתרון") still
 *        routes only itself to the advantage bucket — otherwise one such bullet
 *        inside the required list demotes every requirement after it (the v2 bug
 *        that cost Job A 23 points). Trailing "חובה/must" still pins to required.
 * FIX-18 Years scoping made explicit and enforced: both per-skill years and
 *        total-experience years are searched ONLY in lines already classified as
 *        required/advantage — never in the context (company-blurb) bucket. In
 *        legacy header-less postings all lines are requirement-candidates, but
 *        every total-years pattern requires an explicit ניסיון/experience word,
 *        so "10 years in business" in a blurb still cannot match.
 * FIX-19 Non-linear experience curve: ratio' = 1 − (1 − ratio)^1.5 (capped at 1).
 *        Near-misses land near-full (1.75/2y → 96%, not 87.5%) and low partials
 *        get a warmer floor (0.5/2y → 35%, not 25%), while only a true
 *        years-met ratio yields 100%. Applied to skill, OR-group, advantage and
 *        total-years ratios. Domain-coverage consolation credit stays LINEAR on
 *        purpose — it must remain conservative for unfit domains (Job D guard).
 *
 * ── CHANGELOG v2 → v3 (QA fix IDs referenced in the review report) ──────────
 * FIX-1  Generic-tag stoplist. Tags like "AI"/"LLM"/"Backend"/"UI"/"Web" no longer
 *        trigger tech matches (hallucinations, e.g. PM job scoring 73) and no longer
 *        poison the dedupe set (false negatives, e.g. RAG dropped because a sibling
 *        entry's generic "LLM" tag was already seen).
 * FIX-2  Per-line claimed-term set: two profile entries can no longer both claim the
 *        same surface token (e.g. "OOP" matching both Java and the OOP entry).
 * FIX-3  Line-scoped "‑ יתרון / a plus" markers. A trailing marker routes only that
 *        line to the advantage bucket; it no longer flips the state machine and
 *        silently reclassifies every subsequent required bullet. Header detection is
 *        now stricter (short line + colon, or ≤4 words). Trailing "חובה/must" pins a
 *        line to required even inside an advantage section.
 * FIX-4  Years unit regex tightened: "שנ" → שנים/שנות/שנה/שנ'. "צוות של 4 שנמצא"
 *        no longer becomes a 4-year requirement.
 * FIX-5  seen is now a Map; re-encountering a tech on a line WITH years upgrades a
 *        previously year-less requirement instead of being discarded.
 * FIX-6  Total-years extraction is per-line and skips lines that produced a tech
 *        requirement — "3+ שנות ניסיון ב-Java" is no longer double-counted as both a
 *        skill requirement and the overall-experience requirement. Pattern broadened
 *        to catch "5+ years of product management experience". No fallback into the
 *        company-blurb (context) bucket.
 * FIX-7  Domain-coverage credit is scaled: w × 0.5 × min(1, domainYears / reqYears
 *        (or 3y baseline)) instead of a flat 50 %. A 0.5-year devops profile no
 *        longer collects half-credit on AWS/K8s/Terraform/Jenkins.
 * FIX-8  domain_years fallback: if industry_summary.domain_years lacks a domain that
 *        exists under experience (e.g. mobile), derive it from the entries.
 *        Coverage also consults the ontology-mapped domain (postgres→data_bi jobs
 *        still get backend-DB coverage).
 * FIX-9  Ambiguous token guard: bare "go" requires programming context on the line
 *        ("go-getter attitude" no longer creates a Go requirement). Same guard hook
 *        for future ambiguous tokens.
 * FIX-10 Word-boundary engine: '*' added to regex escaping; tags starting with a
 *        non-alphanumeric (".net") get a leading-boundary exemption so "ASP.NET"
 *        matches while "www.netflix.com" doesn't; '.' now blocks the left boundary
 *        for normal tags so tag "JS" no longer fires inside "node.js".
 * FIX-11 Tool section: rest/docker/kubernetes removed from TOOL_KW (already scored
 *        as techs → double counting); tools already matched as requirements are
 *        skipped; credit falls back to experience entries (Git/GitHub, CI/CD); if
 *        the profile has no tools_and_methods section at all (extraction gap), an
 *        unfound tool adds no dead weight.
 * FIX-12 Advantage extraction shares the seen-Map with required extraction — a tech
 *        can no longer be counted in both pools.
 * FIX-13 Presence floor: a requirement WITHOUT a years figure that the user has real
 *        hands-on exposure to (effective ≥ 0.5y) scores at least 70 % instead of
 *        being silently halved by personal_weight.
 * FIX-14 Role-domain requirements are read from the required section + title lines
 *        only, and need an engineering-role word on the same line ("work closely
 *        with Backend teams" in a PM post no longer manufactures a role match).
 * FIX-15 No-signal cap: if zero technologies were extracted from the whole posting,
 *        the score is capped (CFG.NO_SIGNAL_CAP) and a low-confidence bullet is
 *        emitted instead of returning a confident-looking mid score.
 */
(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────────────────────
  const CFG = {
    REQUIRED_MULT:   1.00,   // חובה  — full weight
    ADVANTAGE_MULT:  0.40,   // יתרון — 40 % of weight

    DEFAULT_PERSONAL_WEIGHT: 50,
    // FIX-23: per-category default personal weight, used only when the entry has
    // no explicit personal_weight. Application-level AI/LLM work is a young field
    // where hands-on personal building (agents, RAG, prompt engineering) is the
    // accepted experience signal — a 50% haircut systematically under-scores
    // genuinely qualified candidates on application/agentic roles (Job C/C2).
    PERSONAL_WEIGHT_BY_DOMAIN: { ai_ml_llm: 75 },
    DEFAULT_REQ_YEARS: 1,

    // FIX-13: "experience with X" (no years) + real hands-on exposure ⇒ ≥70 %
    PRESENCE_FLOOR: 0.70,
    PRESENCE_FLOOR_MIN_EFFECTIVE: 0.5,

    // FIX-7: scaled domain-coverage credit
    // FIX-21: max fraction of an item's weight granted as consolation when the
    // specific tool is missing but same-category sibling tools exist.
    CONSOLATION_MULT: 0.35,

    MIN_SCORE: 18,
    MAX_SCORE: 94,
    NO_SIGNAL_CAP: 40,       // FIX-15
    // FIX-19: experience curve exponent k in ratio' = 1-(1-ratio)^k. k=1 is the old
    // linear scale; k=1.5 → 0.875→0.96, 0.5→0.65, 0.25→0.35. Only ratio=1 gives 100%.
    YEARS_CURVE_EXP: 1.5,

    PTS_TECH_EXACT:  12,
    PTS_TECH_DOMAIN:  6,
    PTS_YEARS_TOTAL: 15,
    PTS_YEARS_SKILL: 10,
    PTS_DOMAIN_ROLE:  8,
    PTS_TOOL:         4,
    PTS_TRAIT:        3,
  };

  // ── DOMAIN MAP (unchanged from v2 except noted) ───────────────────────────
  const TECH_DOMAIN = {
    java: 'backend', 'c#': 'backend', '.net': 'backend', python: 'backend',
    ruby: 'backend', go: 'backend', golang: 'backend', rust: 'backend',
    php: 'backend', scala: 'backend', kotlin: 'backend', 'node.js': 'backend',
    nodejs: 'backend', 'spring boot': 'backend', django: 'backend',
    flask: 'backend', fastapi: 'backend', express: 'backend', nestjs: 'backend',
    react: 'frontend', 'react.js': 'frontend', vue: 'frontend', 'vue.js': 'frontend',
    angular: 'frontend', svelte: 'frontend', 'next.js': 'frontend', nextjs: 'frontend',
    javascript: 'frontend', typescript: 'frontend', html: 'frontend', css: 'frontend',
    'tailwind css': 'frontend', sass: 'frontend', webpack: 'frontend',
    'machine learning': 'ai_ml_llm', 'deep learning': 'ai_ml_llm',
    tensorflow: 'ai_ml_llm', pytorch: 'ai_ml_llm', 'langchain': 'ai_ml_llm',
    'openai': 'ai_ml_llm', 'llm': 'ai_ml_llm', 'nlp': 'ai_ml_llm',
    'hugging face': 'ai_ml_llm', 'scikit-learn': 'ai_ml_llm', 'keras': 'ai_ml_llm',
    sql: 'data_bi', postgresql: 'data_bi', postgres: 'data_bi', mysql: 'data_bi',
    spark: 'data_bi', hadoop: 'data_bi', pandas: 'data_bi', numpy: 'data_bi',
    'power bi': 'data_bi', tableau: 'data_bi', 'looker': 'data_bi',
    dbt: 'data_bi', airflow: 'data_bi', kafka: 'data_bi',
    docker: 'devops_cloud', kubernetes: 'devops_cloud', k8s: 'devops_cloud',
    aws: 'devops_cloud', azure: 'devops_cloud', gcp: 'devops_cloud',
    terraform: 'devops_cloud', ansible: 'devops_cloud', jenkins: 'devops_cloud',
    'github actions': 'devops_cloud', gitlab: 'devops_cloud',
    swift: 'mobile', 'objective-c': 'mobile', flutter: 'mobile',
    'react native': 'mobile', 'android': 'mobile', 'ios': 'mobile',
    mongodb: 'backend', redis: 'backend', elasticsearch: 'backend',
    dynamodb: 'devops_cloud', 'cassandra': 'data_bi',
    'penetration testing': 'other_domains', 'siem': 'other_domains',
    selenium: 'other_domains', cypress: 'other_domains', jest: 'other_domains',
    pytest: 'other_domains',
  };

  // FIX-25: required techs are only ever detected if they appear in TECH_DOMAIN
  // (generic, candidate-independent) OR in the CANDIDATE'S OWN profile entries
  // (Pass 2 below). A term missing from BOTH is silently invisible — never
  // scored as a match, never as a gap — which shrinks `total` and inflates the
  // score for any candidate whose profile doesn't happen to use the job's exact
  // terminology. Closing common gaps HERE (not per-profile) is what keeps the
  // engine candidate-agnostic: previously "Hibernate"/"REST APIs" only scored at
  // all if the specific profile under test had entries named that; a candidate
  // without a matching entry name got that requirement dropped for free.
  Object.assign(TECH_DOMAIN, {
    hibernate: 'backend', spring: 'backend', rest: 'backend', restful: 'backend',
    soap: 'backend', grpc: 'backend', orm: 'backend', graphql: 'backend',
    laravel: 'backend', symfony: 'backend', 'asp.net': 'backend',
    microservices: 'backend', jpa: 'backend',
    jquery: 'frontend', bootstrap: 'frontend', redux: 'frontend',
    'material ui': 'frontend', jsx: 'frontend',
    linux: 'devops_cloud', nginx: 'devops_cloud', apache: 'devops_cloud',
    puppet: 'devops_cloud', chef: 'devops_cloud', circleci: 'devops_cloud',
    prometheus: 'devops_cloud', grafana: 'devops_cloud', vagrant: 'devops_cloud',
    etl: 'data_bi', 'big data': 'data_bi', snowflake: 'data_bi', redshift: 'data_bi',
    xamarin: 'mobile', cordova: 'mobile', ionic: 'mobile',
    junit: 'other_domains', mocha: 'other_domains', appium: 'other_domains',
    // FIX-26b: AI/robotics + common API/security terms surfaced by real postings
    'large language models': 'ai_ml_llm', 'vision language models': 'ai_ml_llm',
    vlm: 'ai_ml_llm', vlms: 'ai_ml_llm', 'fine-tuning': 'ai_ml_llm', 'fine tuning': 'ai_ml_llm',
    'reinforcement learning': 'ai_ml_llm', 'multi-agent systems': 'ai_ml_llm',
    'multi-agent': 'ai_ml_llm', ros: 'other_domains', robotics: 'other_domains',
    embedded: 'other_domains', kerberos: 'devops_cloud', jwt: 'devops_cloud',
    jwe: 'devops_cloud', oauth: 'devops_cloud', oauth1: 'devops_cloud',
    oauth2: 'devops_cloud', openapi: 'backend', yaml: 'devops_cloud', xml: 'backend',
  });

  // Secondary coverage domain for DB techs whose profile home differs (FIX-8)
  const TECH_DOMAIN_ALT = {
    postgresql: 'backend', postgres: 'backend', mysql: 'backend', sql: 'backend',
    android: 'mobile', ios: 'mobile',
  };

  // FIX-9: ambiguous tokens need supporting context on the same line
  const AMBIGUOUS_TECH_CONTEXT = {
    go: /(golang|programming|language|developer|engineer|backend|microservice|python|java(?![a-z])|rust|kotlin|scala|c\+\+|c#|פיתוח|שפת|שפות)/i,
    express: /(express\.?js|express\s+js|node)/i,
  };

  // FIX-1: tags too generic to identify a technology — never match or dedupe on these
  const GENERIC_TAGS = new Set([
    'ai', 'llm', 'ml', 'nlp', 'api', 'ui', 'ux', 'web', 'backend', 'frontend',
    'full stack', 'fullstack', 'mobile', 'cloud', 'deploy', 'hosting',
    'automation', 'devops', 'scripting', 'oop', 'design patterns', 'rdbms',
    'sql', 'version control', 'source control', 'no-code', 'cross-platform',
    'javascript backend', 'java frontend',
    'בינה מלאכותית', 'בינה-מלאכותית', 'אוטומציה', 'בסיסי נתונים', 'בק-אנד',
    'ממשק', 'סמנטי',
  ]);

  const ROLE_DOMAIN_KW = {
    backend:      ['backend', 'back-end', 'server-side', 'server side'],
    frontend:     ['frontend', 'front-end', 'client-side', 'ui developer'],
    fullstack:    ['full stack', 'full-stack', 'fullstack'],
    devops_cloud: ['devops', 'devsecops', 'platform engineer', 'sre', 'infrastructure'],
    ai_ml_llm:    ['machine learning', 'ml engineer', 'ai engineer', 'llm', 'nlp'],
    data_bi:      ['data engineer', 'data analyst', 'bi developer', 'data scientist'],
    mobile:       ['mobile developer', 'ios developer', 'android developer'],
    other_domains:['qa engineer', 'sdet', 'security engineer', 'cyber'],
  };
  // FIX-14: a role keyword only counts when the line is actually about the role
  const ROLE_CONTEXT_RE = /(developer|engineer|engineering|development|programmer|architect|team lead|position|role|מפתח|מפתחת|מהנדס|מהנדסת|פיתוח|תפקיד|משרה|ארכיטקט)/i;

  // FIX-20: keywords that name a parent CATEGORY itself in job text. A category
  // ask is evaluated against profile category-level years, not sub-skills.
  const CATEGORY_KW = {
    backend:      ['backend', 'back-end', 'back end', 'server-side', 'server side', 'צד שרת', 'פיתוח שרת'],
    frontend:     ['frontend', 'front-end', 'front end', 'client-side', 'client side', 'צד לקוח'],
    fullstack:    ['full stack', 'full-stack', 'fullstack', 'פולסטאק', 'פול סטאק'],
    ai_ml_llm:    ['artificial intelligence', 'machine learning', 'generative ai', 'gen ai', 'genai', 'בינה מלאכותית', 'למידת מכונה'],
    data_bi:      ['data engineering', 'data analysis', 'הנדסת נתונים', 'ניתוח נתונים'],
    devops_cloud: ['devops', 'infrastructure', 'ענן', 'אינפרה'],
    mobile:       ['mobile development', 'mobile apps', 'פיתוח מובייל', 'אפליקציות מובייל'],
  };
  // Category mention counts as an ask only with a years figure or experience word
  const CATEGORY_CONTEXT_RE = /(ניסיון|רקע|היכרות|experience|background|proficien|expertise|knowledge)/i;
  const CAT_LABEL = {
    backend: 'Backend', frontend: 'Frontend', fullstack: 'Full Stack',
    ai_ml_llm: 'AI/ML', data_bi: 'Data/BI', devops_cloud: 'DevOps/Cloud',
    mobile: 'Mobile', other_domains: 'QA/Security',
  };

  // FIX-26: UNKNOWN CRITICAL-TERM DETECTION. A requirement naming a niche
  // product/tool (e.g. "IBM API Connect", "DataPower") that appears in neither
  // TECH_DOMAIN nor the candidate's own profile was previously invisible: it
  // added ZERO weight to the score, so the single most important line in a job
  // (often the one marked "- חובה") silently stopped counting instead of
  // becoming a gap. That inflates scores on jobs anchored around a term the
  // engine doesn't recognize AND the candidate doesn't have.
  // Scoped deliberately: only fires on lines mixing Hebrew with a Latin term —
  // exactly the "ניסיון ב-X", "בסביבת X" pattern common in Israeli postings —
  // so English-only postings (where every sentence starts capitalized) are
  // untouched. Extracts runs of 1-4 capitalized/ALL-CAPS Latin words; each run
  // is scored against the WHOLE profile (any domain) — real cross-domain
  // aliases still credit it, but a true miss is now a real, counted ❌.
  const UNKNOWN_TERM_RE = /\b(?:[A-Z][A-Za-z0-9]*|[A-Z]{2,})(?:[\s-]+(?:[A-Z][A-Za-z0-9]*|[A-Z]{2,})){0,3}\b/g;
  // Degree-abbreviation fragments ("B.Sc" splits into "B"+"Sc") and TOOL_KW
  // terms (scored correctly by the separate tools pass — must not double-count
  // or contradict that pass with a spurious gap here) are excluded.
  const UNKNOWN_TERM_STOP = new Set([
    'b.sc', 'm.sc', 'ph.d', 'ba', 'ma', 'b', 'sc', 'm', 'bsc', 'msc', 'phd', 'ph', 'd',
    'ci', 'cd', 'cicd', 'agile', 'scrum', 'kanban', 'tdd', 'bdd', 'jira', 'git',
    'experience', 'background', 'familiarity', 'knowledge', 'proficiency',
    'understanding', 'proven', 'strong',
  ]);
  // FIX-29: an all-English line can ALSO hide a niche named product ("Experience
  // with Temporal or similar distributed workflow engines.") — but an unscoped
  // capitalized-run scan on English text is far too noisy (every "Team Player",
  // "Problem Solver" bullet-title would false-positive). Narrowly gated: only
  // fires when the line explicitly opens with an "Experience with X" — style
  // requirement phrase AND still yielded zero recognized techs.
  const ENGLISH_REQ_PREFIX_RE = /^[-*•\s]*(experience (with|in|building|integrating|deploying|working)|familiarity with|knowledge of|background in|proficiency in|proven experience (with|in|building)?|strong (background|experience) (with|in)|understanding of)\b/i;
  function _extractUnknownTerms(line, seen) {
    const hasHebrew = /[֐-׿]/.test(line);
    if (!hasHebrew && !ENGLISH_REQ_PREFIX_RE.test(line)) return [];
    const matches = line.match(UNKNOWN_TERM_RE) || [];
    const out = [];
    for (const m of matches) {
      const t = m.trim();
      const tl = t.toLowerCase();
      const tlSing = (tl.length > 3 && tl.endsWith('s')) ? tl.slice(0, -1) : tl; // FIX-30b
      if (t.length < 2 || UNKNOWN_TERM_STOP.has(tl)) continue;
      // FIX-30: never re-flag a term already resolved elsewhere on this
      // document (prevents "LLM"/"RAG"/"AI" reappearing as a duplicate unknown
      // item after being correctly matched via TECH_DOMAIN on an earlier line),
      // and never treat a bare GENERIC_TAGS word (AI, API, ML...) as a scorable
      // named product — the unknown-term path uses a strict exact-tag lookup
      // that can't apply the nuance GENERIC_TAGS exists for, so a generic word
      // here would either falsely miss (APIs vs tag "API", no plural handling)
      // or falsely hallucinate; better left uncounted, same as the original design.
      if (seen && (seen.has(tl) || seen.has(tlSing))) continue;
      if (GENERIC_TAGS.has(tl) || GENERIC_TAGS.has(tlSing)) continue;
      out.push(t);
    }
    return out;
  }

  // FIX-11: rest/docker/kubernetes removed — already scored as technologies
  const TOOL_KW = [
    'git', 'ci/cd', 'cicd', 'agile', 'scrum', 'kanban',
    'microservices', 'graphql', 'tdd', 'bdd', 'jira', 'linux',
  ];

  const TRAIT_KW = [
    'self-directed', 'self directed', 'independent', 'team player', 'collaborative',
    'analytical', 'problem solver', 'fast learner', 'proactive', 'detail-oriented',
  ];

  // ── HEBREW-AWARE TEXT MATCHING ────────────────────────────────────────────
  const _HE_PREFIXES = ['ב', 'כ', 'ל', 'מ', 'ו', 'ה', 'ש'];
  const _termReCache = new Map();

  function _includesHebrew(textLower, tag) {
    const tl = String(tag).toLowerCase();
    if (/[a-z0-9]/.test(tl) && !/[֐-׿]/.test(tl)) {
      // Latin/digit tag → word boundaries, compiled once and cached
      let re = _termReCache.get(tl);
      if (!re) {
        // FIX-10: escape '*' too
        const esc = tl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const startsAlnum = /^[a-z0-9]/.test(tl);
        const endsAlnum   = /[a-z0-9]$/.test(tl);
        // FIX-10: '.' blocks the left boundary (tag "js" must not fire inside
        // "node.js"); tags starting with a symbol (".net") skip the left guard
        // so "asp.net" matches while ".netflix" is blocked by the right guard.
        const left  = startsAlnum ? '(?<![a-z0-9.])' : '';
        // FIX-27: tolerate ONE trailing plural 's' — "LLMs", "VLMs", "Agents",
        // "APIs" must match their singular tag. Only when the tag itself doesn't
        // already end in 's' (avoids "ios" also matching as "io" + plural-s).
        const right = endsAlnum ? (/s$/.test(tl) ? '(?![a-z0-9])' : 's?(?![a-z0-9])') : '';
        re = new RegExp(left + esc + right);
        _termReCache.set(tl, re);
      }
      return re.test(textLower);
    }
    // Hebrew tag → substring + prefixed variants
    if (textLower.includes(tl)) return true;
    if (/[֐-׿]/.test(tl)) {
      for (const p of _HE_PREFIXES) {
        if (textLower.includes(p + tl)) return true;
      }
    }
    return false;
  }

  // Returns the matched surface term (name or tag) or null. FIX-1/FIX-2:
  // generic tags never match; claimed terms can't be re-used on the same line.
  function _techMatchTerm(lineLower, techName, searchTags, claimed) {
    const nameLo = String(techName).toLowerCase();
    if (!claimed.has(nameLo) && _includesHebrew(lineLower, techName)) return nameLo;
    if (Array.isArray(searchTags)) {
      for (const tag of searchTags) {
        const tagLo = String(tag).toLowerCase();
        if (GENERIC_TAGS.has(tagLo) || claimed.has(tagLo)) continue;
        if (_includesHebrew(lineLower, tag)) return tagLo;
      }
    }
    return null;
  }

  // ── JOB PARSER ────────────────────────────────────────────────────────────
  const ADV_HEADER_RE = /(יתרון|advantage|nice[ -]?to[ -]?have|preferred qualifications?|bonus points?|desirable|beneficial|a plus)/i;
  const REQ_HEADER_RE = /(requirements?|דרישות|חובה|must[ -]?have|qualifications?|essential|mandatory|what you(?:'|’)?ll need|what we(?:'|’)?re looking for|what you(?:'|’)?ll do|responsibilities|the role|תיאור המשרה|על התפקיד|תחומי אחריות)/i;
  const CTX_HEADER_RE = /(אודות|על החברה|מי אנחנו|קצת עלינו|למה לעבוד|הטבות|about (?:us|the company)|who we are|our (?:story|team|benefits)|perks|benefits)/i;

  // FIX-3: a header is a SHORT, header-shaped line (colon-terminated or ≤4 words)
  function _isHeaderLine(t) {
    if (t.length === 0 || t.length > 60) return false;
    if (/[:：]\s*$/.test(t)) return true;
    return t.replace(/^[-•*·]\s*/, '').split(/\s+/).length <= 4;
  }
  // FIX-3: trailing per-bullet markers ("... - יתרון", "... – a plus")
  const INLINE_ADV_RE = /(?:^|[\s(\-–—])(יתרון(?:\s+משמעותי)?|a plus|an advantage|advantage|nice to have|preferred|bonus)\s*[).!]?\s*$/i;
  const INLINE_REQ_RE = /(?:^|[\s(\-–—])(חובה|must(?:\s+have)?|required)\s*[).!]?\s*$/i;

  // FIX-17: an ADVANTAGE HEADER is a short line that is essentially just the
  // advantage phrase — after stripping bullet markers, the phrase itself and
  // punctuation, (almost) nothing remains. "יתרון:", "יתרונות", "נחשב יתרון -",
  // "Nice to have:" → header (flips state). "ניסיון עם Docker - יתרון" → NOT a
  // header (real content remains) → line-scoped routing only.
  const ADV_PHRASE_RE = /(יתרונות|יתרון(?:\s+משמעותי)?|advantages?|nice[ -]?to[ -]?have|preferred qualifications?|bonus points?|desirable|beneficial|a plus|נחשב(?:ים)?|ל?יתרון)/gi;
  function _isAdvHeaderLine(t) {
    if (t.length === 0 || t.length > 60) return false;
    if (!ADV_HEADER_RE.test(t)) return false;
    const residue = t
      .replace(/^[-•*·◦\s]+/, '')
      .replace(ADV_PHRASE_RE, '')
      .replace(/[:：().!\-–—,\s]+/g, '');
    return residue.length <= 6; // tolerates a stray word fragment, not real content
  }

  function _parseJobSections(jobText) {
    const lines = jobText.split(/\r?\n/);
    let state = 'context';
    let sawReqHeader = false;
    const buckets = { context: [], required: [], advantage: [] };

    for (const line of lines) {
      const t = line.trim();
      // FIX-17: pure advantage-phrase line → state machine flip (checked FIRST,
      // before the generic header-shape test, so "יתרונות" without a colon works)
      if (_isAdvHeaderLine(t)) { state = 'advantage'; sawReqHeader = true; buckets[state].push(line); continue; }
      if (_isHeaderLine(t)) {
        if (REQ_HEADER_RE.test(t))      { state = 'required'; sawReqHeader = true; buckets[state].push(line); continue; }
        else if (CTX_HEADER_RE.test(t)) { state = 'context';  buckets[state].push(line); continue; }
      }
      // FIX-3 / FIX-17: content bullet with trailing marker → line-scoped routing,
      // state unchanged (a lone "- יתרון" bullet must not demote later requirements)
      if (t.length > 0 && state !== 'context') {
        if (INLINE_REQ_RE.test(t))      { buckets.required.push(line);  continue; }
        if (INLINE_ADV_RE.test(t))      { buckets.advantage.push(line); continue; }
      }
      buckets[state].push(line);
    }

    let requiredText  = buckets.required.join('\n');
    const advantageText = buckets.advantage.join('\n');
    if (!sawReqHeader) requiredText = buckets.context.join('\n'); // legacy header-less jobs
    return { requiredText, advantageText };
  }

  const INDUSTRY_ONLY_RE = /(בתעשייה|ניסיון תעשייתי|industry experience|commercial experience|production environment|hands[ -]on (?:industry|commercial))/i;
  // FIX-4: years unit must be a real year word — "שנ" alone matched "שנמצא"/"שנפתחה"
  const YEARS_UNIT = "(?:years?|yrs?|שנים|שנות|שנה|שנ['׳])";
  const YEARS_RANGE_RE = new RegExp("(\\d+(?:\\.\\d+)?)\\s*(?:[-–—]|עד|to)\\s*(\\d+(?:\\.\\d+)?)\\s*\\+?\\s*" + YEARS_UNIT, 'i');
  const YEARS_RE = new RegExp("(\\d+(?:\\.\\d+)?)\\s*\\+?\\s*" + YEARS_UNIT, 'i');
  const OR_GROUP_RE = /(אחת|אחד) או יותר|לפחות (אחת|אחד)|one or more|at least one|one of the following| או |, or | or /i;

  const _HEB_YEAR_WORDS = [
    [/שנתיים/g, '2 שנים'], [/שלוש שנים/g, '3 שנים'], [/ארבע שנים/g, '4 שנים'],
    [/חמש שנים/g, '5 שנים'], [/שש שנים/g, '6 שנים'], [/שבע שנים/g, '7 שנים'],
    [/שמונה שנים/g, '8 שנים'], [/תשע שנים/g, '9 שנים'], [/עשר שנים/g, '10 שנים'],
    [/שנה אחת/g, '1 שנים'], [/שנה לפחות/g, '1 שנים לפחות'],
  ];
  function _normalizeYearWords(s) {
    let out = s;
    for (const [re, rep] of _HEB_YEAR_WORDS) out = out.replace(re, rep);
    return out;
  }

  /**
   * FIX-2/FIX-5/FIX-6/FIX-12: extraction now returns { reqs, techLineIdx } and
   * accepts a shared seen-Map. Re-encounters upgrade year-less requirements.
   */
  function _extractRequirements(text, profile, seen, seenCats) {
    seen = seen || new Map();
    seenCats = seenCats || new Map();
    const lines = text.split(/\r?\n/);
    const reqs = [];
    const catReqs = [];
    const techLineIdx = new Set();
    let groupSeq = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      const lineLo = _normalizeYearWords(line.toLowerCase());
      const rangeMatch = lineLo.match(YEARS_RANGE_RE);
      const singleMatch = rangeMatch ? null : lineLo.match(YEARS_RE);
      const lineYears = rangeMatch ? parseFloat(rangeMatch[1])
                      : singleMatch ? parseFloat(singleMatch[1]) : null;
      const industryOnly = INDUSTRY_ONLY_RE.test(line);
      const lineReqs = [];
      const claimed = new Set();  // FIX-2: surface terms already consumed on this line

      function _upgrade(key) {   // FIX-5
        const prev = seen.get(key);
        if (prev && lineYears != null && prev.reqYears == null) {
          prev.reqYears = lineYears;
          prev.industryOnly = prev.industryOnly || industryOnly;
        }
        if (prev) techLineIdx.add(i);
      }

      // Pass 1: hardcoded TECH_DOMAIN keywords
      for (const tech of Object.keys(TECH_DOMAIN)) {
        if (seen.has(tech)) { if (_includesHebrew(lineLo, tech)) _upgrade(tech); continue; }
        if (!_includesHebrew(lineLo, tech)) continue;
        const guard = AMBIGUOUS_TECH_CONTEXT[tech];      // FIX-9
        if (guard && !guard.test(lineLo)) continue;
        const req = { tech, reqYears: lineYears, domain: TECH_DOMAIN[tech], industryOnly };
        seen.set(tech, req);
        claimed.add(tech);
        lineReqs.push(req);
      }

      // Pass 2: profile techs. FIX-16: two sub-passes — entry NAMES first, then
      // specific search_tags — so an entry's own name always outranks a sibling
      // entry's cross-listed tag (job says "RAG": the RAG entry must win the
      // term, not the Embeddings entry whose tags happen to include "RAG").
      if (profile) {
        for (const namesOnly of [true, false]) {
          for (const [domain, techs] of Object.entries(profile.experience || {})) {
            for (const [techName, entry] of Object.entries(techs || {})) {
              const key = techName.toLowerCase();
              const tags = Array.isArray(entry && entry.search_tags) ? entry.search_tags : [];
              if (seen.has(key)) {
                if (namesOnly && _techMatchTerm(lineLo, techName, tags, new Set())) _upgrade(key);
                continue;
              }
              // FIX-1: dedupe only on SPECIFIC tags, and only when matching BY
              // tag — a literal name occurrence ("embeddings" in the text) always
              // creates its own requirement even if a sibling entry cross-lists it.
              if (!namesOnly && tags.some(t => {
                const tl = String(t).toLowerCase();
                return !GENERIC_TAGS.has(tl) && seen.has(tl);
              })) continue;
              // "sql server" when "sql" already matched on this posting = same req
              if (key.split(/[\s.\-/]+/).some(w => seen.has(w))) continue;
              const term = _techMatchTerm(lineLo, techName, namesOnly ? [] : tags, claimed);
              if (!term) continue;
              const req = { tech: techName, reqYears: lineYears, domain, industryOnly };
              seen.set(key, req);
              claimed.add(term);
              lineReqs.push(req);
            }
          }
        }
      }

      // FIX-26: unknown critical-term fallback — only when Pass 1+2 found NOTHING
      // on this line, so a recognized tech is never overridden or duplicated.
      if (lineReqs.length === 0) {
        for (const term of _extractUnknownTerms(line, seen)) {
          const tkey = 'unk:' + term.toLowerCase();
          if (seen.has(tkey)) continue;
          const req = { tech: term, reqYears: lineYears, domain: null, industryOnly, unknown: true };
          seen.set(tkey, req);
          lineReqs.push(req);
        }
      }

      // FIX-20: category-level asks ("3+ years of backend development experience")
      if (lineYears != null || CATEGORY_CONTEXT_RE.test(line)) {
        for (const [domain, kws] of Object.entries(CATEGORY_KW)) {
          if (!kws.some(kw => _includesHebrew(lineLo, kw))) continue;
          if (lineReqs.some(r => r.domain === domain)) continue; // concrete tech on this line carries the ask
          const prev = seenCats.get(domain);
          if (prev) { // FIX-5 semantics for categories: later years upgrade a year-less ask
            if (lineYears != null && prev.reqYears == null) prev.reqYears = lineYears;
            techLineIdx.add(i);
            continue;
          }
          const c = { domain, reqYears: lineYears, industryOnly };
          seenCats.set(domain, c);
          catReqs.push(c);
          techLineIdx.add(i); // FIX-20: total-years must not also swallow this line
        }
      }

      if (lineReqs.length > 0) techLineIdx.add(i);
      if (lineReqs.length >= 2 && OR_GROUP_RE.test(lineLo)) {
        const gid = 'g' + (groupSeq++);
        for (const r of lineReqs) r.group = gid;
      }
      reqs.push(...lineReqs);
    }
    return { reqs, catReqs, techLineIdx, seen, seenCats };
  }

  // FIX-6: per-line, skipping lines that already produced a skill requirement.
  const TOTAL_YEARS_PATTERNS = [
    // "5+ years of product management experience", "3 years hands-on experience"
    /(\d+(?:\.\d+)?)\s*\+?\s*years?\s+(?:of\s+)?(?:[a-z][a-z-]*\s+){0,3}experience/i,
    /(\d+(?:\.\d+)?)\s*\+?\s*שנות\s+ניסיון/i,
    /ניסיון\s+של\s+(\d+(?:\.\d+)?)\s*שנ/i,
    /experience\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*\+?\s*years?/i,
  ];
  function _extractTotalYears(lines, excludeIdx) {
    for (let i = 0; i < lines.length; i++) {
      if (excludeIdx && excludeIdx.has(i)) continue;
      const lo = _normalizeYearWords(lines[i].toLowerCase());
      for (const re of TOTAL_YEARS_PATTERNS) {
        const m = lo.match(re);
        if (m) return parseFloat(m[1]);
      }
    }
    return null;
  }

  // FIX-14: required section + title lines only, with role-context guard
  function _extractRoleDomains(requiredLines, titleLines) {
    const found = new Set();
    const scan = (line, isTitle) => {
      const lo = line.toLowerCase();
      for (const [domain, kws] of Object.entries(ROLE_DOMAIN_KW)) {
        if (found.has(domain)) continue;
        if (kws.some(kw => lo.includes(kw)) && (isTitle || ROLE_CONTEXT_RE.test(line))) {
          found.add(domain);
        }
      }
    };
    for (const line of titleLines) scan(line, true);
    for (const line of requiredLines) scan(line, false);
    return found;
  }

  // ── PROFILE LOOKUP HELPERS ────────────────────────────────────────────────
  function _entryYears(entry, domain) {
    const ind = parseFloat(entry.industry_years) || 0;
    const per = parseFloat(entry.personal_years) || 0;
    let w = parseInt(entry.personal_weight, 10);
    if (isNaN(w)) w = CFG.PERSONAL_WEIGHT_BY_DOMAIN[domain] ?? CFG.DEFAULT_PERSONAL_WEIGHT; // FIX-23
    w = Math.max(0, Math.min(100, w));
    return { effective: ind + per * (w / 100), industry: ind, personal: per };
  }

  function _profileYears(profile, tech, domainHint) {
    const exp = profile.experience || {};
    const tl = tech.toLowerCase();
    const domains = [];
    if (domainHint && exp[domainHint]) domains.push(domainHint);
    const mapped = TECH_DOMAIN[tl];
    if (mapped && mapped !== domainHint && exp[mapped]) domains.push(mapped);
    for (const d of Object.keys(exp)) {
      if (!domains.includes(d)) domains.push(d);
    }

    // Pass A: exact name
    for (const d of domains) {
      const domainExp = exp[d] || {};
      const key = Object.keys(domainExp).find(k => k.toLowerCase() === tl);
      if (key) return _entryYears(domainExp[key] || {}, d);
    }
    // Pass B: reverse alias via search_tags (kept: a job requiring "SQL" resolves
    // to a profile entry — resolution, not extraction, so generic tags are
    // acceptable here). FIX-28: when SEVERAL entries share the alias (a job
    // asking for "SQL" could tag PostgreSQL, MySQL, and SQL Server alike), pick
    // the entry with the HIGHEST effective years — not whichever happened to
    // come first in the profile JSON's key order. Previously "SQL" could
    // silently resolve to a shallow 0.5y MySQL entry while a real 2.5y
    // PostgreSQL entry sat right below it, unused.
    let best = null;
    for (const d of domains) {
      const domainExp = exp[d] || {};
      for (const key of Object.keys(domainExp)) {
        const entry = domainExp[key] || {};
        const tags = Array.isArray(entry.search_tags) ? entry.search_tags : [];
        if (!tags.some(t => String(t).toLowerCase() === tl)) continue;
        const y = _entryYears(entry, d);
        if (!best || y.effective > best.effective) best = y;
      }
    }
    if (best) return best;
    return { effective: 0, industry: 0, personal: 0 };
  }

  // FIX-8: fall back to experience entries when domain_years omits a domain
  function _profileDomainYears(profile, domain) {
    const dy = (profile.industry_summary && profile.industry_summary.domain_years) || {};
    if (dy[domain] != null) return parseFloat(dy[domain]) || 0;
    const domExp = (profile.experience || {})[domain] || {};
    let max = 0;
    for (const key of Object.keys(domExp)) {
      max = Math.max(max, _entryYears(domExp[key] || {}, domain).effective);
    }
    return max;
  }

  // FIX-7/FIX-8: coverage looks at the requirement's domain AND the alt domain
  function _coverageYears(profile, req) {
    const tl = req.tech.toLowerCase();
    let best = _profileDomainYears(profile, req.domain);
    const alt = TECH_DOMAIN_ALT[tl];
    if (alt) best = Math.max(best, _profileDomainYears(profile, alt));
    return best;
  }
  // FIX-21: does the candidate have ANY sibling tool under this category?
  function _hasSiblingTools(profile, domain) {
    const d = (profile.experience || {})[domain] || {};
    return Object.values(d).some(e => {
      const ind = parseFloat(e && e.industry_years) || 0;
      const per = parseFloat(e && e.personal_years) || 0;
      return ind + per > 0;
    });
  }
  // FIX-21: consolation fraction of the item's weight (LINEAR on purpose)
  function _consolationRatio(profile, req, catYears) {
    if (catYears <= 0 && !_hasSiblingTools(profile, req.domain)) return 0;
    return CFG.CONSOLATION_MULT * Math.min(1, catYears / (req.reqYears || CFG.DEFAULT_REQ_YEARS));
  }

  function _profileTotalYears(profile) {
    return parseFloat(profile.industry_summary && profile.industry_summary.total_years_industry) || 0;
  }

  // ── SCORING CORE ─────────────────────────────────────────────────────────
  function computeScore(userProfile, jobText, opts) {
    if (!userProfile || !jobText) return { score: CFG.MIN_SCORE, bullets: [] };
    // FIX-24: diagnostic trace — computeScore(profile, text, {trace:true})
    const trace = [];
    function _tr(kind, item, section, w, frac, note) {
      trace.push({ kind, item, section, weight: +w.toFixed(2), pct: Math.round(frac * 100), earned: +(w * frac).toFixed(2), note });
    }

    const { requiredText, advantageText } = _parseJobSections(jobText);
    const requiredLines = requiredText.split(/\r?\n/);

    const seen = new Map();                                            // FIX-12
    const reqRes = _extractRequirements(requiredText,  userProfile, seen);
    const advRes = _extractRequirements(advantageText, userProfile, seen, reqRes.seenCats);
    const reqTechs = reqRes.reqs, advTechs = advRes.reqs;
    const reqCats  = reqRes.catReqs, advCats = advRes.catReqs;      // FIX-20

    const jobTotalYears = _extractTotalYears(requiredLines, reqRes.techLineIdx)  // FIX-6
      ?? _extractTotalYears(advantageText.split(/\r?\n/), advRes.techLineIdx);

    const allLines = jobText.split(/\r?\n/).filter(l => l.trim().length > 0);
    const jobRoles = _extractRoleDomains(requiredLines, allLines.slice(0, 2));   // FIX-14

    let earned = 0, total = 0;
    const matchBullets = [], gapBullets = [];

    // ── Required technologies ────────────────────────────────────────────
    const _groups = new Map();
    const _singles = [];
    for (const r of reqTechs) {
      if (r.group) {
        if (!_groups.has(r.group)) _groups.set(r.group, []);
        _groups.get(r.group).push(r);
      } else _singles.push(r);
    }

    // FIX-19: forgiving non-linear scale for years ratios (see CFG.YEARS_CURVE_EXP)
    function _curveRatio(r) {
      if (r >= 1) return 1;
      if (r <= 0) return 0;
      return 1 - Math.pow(1 - r, CFG.YEARS_CURVE_EXP);
    }

    function _scoreReq(req) {
      const yrs = _profileYears(userProfile, req.tech, req.domain);
      const effective = req.industryOnly ? yrs.industry : yrs.effective;
      let ratio = _curveRatio(req.reqYears
        ? Math.min(1.0, effective / req.reqYears)
        : Math.min(1.0, effective / CFG.DEFAULT_REQ_YEARS));   // FIX-19
      // FIX-13: presence floor for year-less requirements
      if (!req.reqYears && !req.industryOnly && effective >= CFG.PRESENCE_FLOOR_MIN_EFFECTIVE) {
        ratio = Math.max(ratio, CFG.PRESENCE_FLOOR);
      }
      return { industry: yrs.industry, personal: yrs.personal, effective, ratio };
    }

    for (const req of _singles) {
      const { tech, reqYears, industryOnly } = req;
      const wBase = reqYears ? CFG.PTS_YEARS_SKILL : CFG.PTS_TECH_EXACT;
      const w = wBase * CFG.REQUIRED_MULT;
      total += w;

      const s = _scoreReq(req);
      if (s.effective > 0) {
        earned += w * s.ratio;
        _tr('tech', tech, 'required', w, s.ratio, `${s.industry}i+${s.personal}p eff=${s.effective}${reqYears ? ' vs ' + reqYears + 'y' : ''}${industryOnly ? ' [industry-only]' : ''}`);
        const pct = Math.round(s.ratio * 100);
        const label = industryOnly ? `${s.industry} שנ' תעשייה` : `${s.industry}i+${s.personal}p yr`;
        if (!reqYears && s.ratio >= 0.85) {
          matchBullets.push(`✅ ${_cap(tech)}`);
        } else if (!reqYears) {
          matchBullets.push(`⚡ ${_cap(tech)} — ניסיון חלקי (${pct}%)`);
        } else if (s.ratio >= 0.85) {
          matchBullets.push(`✅ ${_cap(tech)} — ${label} (${pct}%)`);
        } else if (s.ratio >= 0.5) {
          matchBullets.push(`⚡ ${_cap(tech)} — ${label} / ${reqYears} נדרש (${pct}%)`);
        } else {
          gapBullets.push(`⚠️ ${_cap(tech)} — ${label} / ${reqYears} שנות ניסיון נדרשות`);
        }
      } else {
        // FIX-21: consolation — sibling tools under the same parent category
        const dy = _coverageYears(userProfile, req);
        const cons = _consolationRatio(userProfile, req, dy);
        if (cons > 0) {
          earned += w * cons;
          _tr('tech', tech, 'required', w, cons, `CONSOLATION (FIX-21): missing, siblings in ${req.domain} (catYears=${dy})${industryOnly ? ' [industry-only ask, industry=0]' : ''}`);
          if (cons >= 0.15) {
            matchBullets.push(`↔️ ${_cap(tech)} — ניסיון בכלים דומים (${CAT_LABEL[req.domain] || req.domain}, ${Math.round(cons * 100)}% זיכוי)`);
          } else {
            gapBullets.push(`❌ ${_cap(tech)}`);
          }
        } else {
          _tr('tech', tech, 'required', w, 0, 'MISS: no experience, no category siblings');
          gapBullets.push(`❌ ${_cap(tech)}`);
        }
      }
    }

    for (const members of _groups.values()) {
      const anyYears = members.some(m => m.reqYears);
      const wBase = anyYears ? CFG.PTS_YEARS_SKILL : CFG.PTS_TECH_EXACT;
      const w = wBase * CFG.REQUIRED_MULT;
      total += w;

      let best = null, bestS = null;
      for (const m of members) {
        const s = _scoreReq(m);
        if (!bestS || s.ratio > bestS.ratio) { best = m; bestS = s; }
      }

      if (bestS && bestS.effective > 0) {
        earned += w * bestS.ratio;
        _tr('or-group', members.map(m => m.tech).join(' | '), 'required', w, bestS.ratio, `best=${best.tech} eff=${bestS.effective}`);
        const pct = Math.round(bestS.ratio * 100);
        matchBullets.push(`✅ ${_cap(best.tech)} — מכסה קבוצת בחירה (${pct}%)`);
      } else {
        let bestCov = 0;
        for (const m of members) {
          bestCov = Math.max(bestCov, _consolationRatio(userProfile, m, _coverageYears(userProfile, m))); // FIX-21
        }
        if (bestCov > 0) {
          earned += w * bestCov;
          _tr('or-group', members.map(m => m.tech).join(' | '), 'required', w, bestCov, 'CONSOLATION (FIX-21): all missing, category siblings');
          if (bestCov >= 0.15) matchBullets.push(`↔️ ${members.map(m => _cap(m.tech)).join('/')} — ניסיון בכלים דומים`);
          else gapBullets.push(`❌ ${members.map(m => _cap(m.tech)).join(' / ')} — אחת נדרשת`);
        } else {
          gapBullets.push(`❌ ${members.map(m => _cap(m.tech)).join(' / ')} — אחת נדרשת`);
        }
      }
    }

    // ── Advantage technologies (40 % weight) ───────────────────────────
    for (const req of advTechs) {
      const { tech, reqYears } = req;
      const wBase = reqYears ? CFG.PTS_YEARS_SKILL : CFG.PTS_TECH_EXACT;
      const w = wBase * CFG.ADVANTAGE_MULT;
      total += w;

      const { effective } = _profileYears(userProfile, tech, req.domain);
      if (effective > 0) {
        const ratio = reqYears ? _curveRatio(Math.min(1.0, effective / reqYears)) : 1.0; // FIX-19
        earned += w * ratio;
        _tr('tech', tech, 'advantage', w, ratio, `eff=${effective}`);
        matchBullets.push(`➕ ${_cap(tech)} (יתרון)`);
      } else {
        const _advCons = _consolationRatio(userProfile, req, _coverageYears(userProfile, req)); // FIX-21
        earned += w * _advCons;
        _tr('tech', tech, 'advantage', w, _advCons, _advCons > 0 ? 'CONSOLATION (FIX-21)' : 'MISS');
      }
    }

    // ── FIX-20: Category-level requirements ─────────────────────────────
    const catAsked = new Set();
    function _scoreCategoryReq(c, mult) {
      catAsked.add(c.domain);
      // year-less category ask + concrete same-category techs already scored → covered
      if (!c.reqYears && reqTechs.some(r => r.domain === c.domain)) return;
      const w = (c.reqYears ? CFG.PTS_YEARS_SKILL : CFG.PTS_DOMAIN_ROLE) * mult;
      total += w;
      const cy = _profileDomainYears(userProfile, c.domain);
      const label = CAT_LABEL[c.domain] || c.domain;
      if (cy > 0) {
        const ratio = _curveRatio(Math.min(1, cy / (c.reqYears || CFG.DEFAULT_REQ_YEARS)));
        earned += w * ratio;
        _tr('category', label, mult === CFG.REQUIRED_MULT ? 'required' : 'advantage', w, ratio, `FIX-20: categoryYears=${cy}${c.reqYears ? ' vs ' + c.reqYears + 'y' : ''}`);
        const pct = Math.round(ratio * 100);
        if (mult !== CFG.REQUIRED_MULT) {
          matchBullets.push(`➕ ניסיון ${label} (יתרון)`);
        } else if (ratio >= 0.85) {
          matchBullets.push(`✅ ניסיון ${label} — ${cy} שנים (${pct}%)`);
        } else if (ratio >= 0.5) {
          matchBullets.push(`⚡ ניסיון ${label} — ${cy}/${c.reqYears} שנים (${pct}%)`);
        } else {
          gapBullets.push(`⚠️ ניסיון ${label} — ${cy}/${c.reqYears} שנים (${pct}%)`);
        }
      } else if (mult === CFG.REQUIRED_MULT) {
        _tr('category', label, 'required', w, 0, 'FIX-20: no category years');
        gapBullets.push(`❌ ניסיון ${label}`);
      }
    }
    for (const c of reqCats) _scoreCategoryReq(c, CFG.REQUIRED_MULT);
    for (const c of advCats) _scoreCategoryReq(c, CFG.ADVANTAGE_MULT);

    // ── Role-domain requirements ────────────────────────────────────────
    for (const domain of jobRoles) {
      if (catAsked.has(domain)) continue;                    // FIX-20
      if (reqTechs.some(r => r.domain === domain)) continue;
      const w = CFG.PTS_DOMAIN_ROLE;
      total += w;
      const dy = _profileDomainYears(userProfile, domain);
      if (dy > 0) {
        earned += w;
        _tr('role', domain, 'required', w, 1, `role-domain, ${dy}y`);
        matchBullets.push(`✅ ניסיון ${domain} (${dy} שנים)`);
      } else {
        _tr('role', domain, 'required', w, 0, 'role-domain, none');
        gapBullets.push(`❌ חסר ניסיון ב-${domain}`);
      }
    }

    // ── Total years of experience ───────────────────────────────────────
    if (jobTotalYears) {
      const w = CFG.PTS_YEARS_TOTAL;
      total += w;
      const cvTotal = _profileTotalYears(userProfile);
      if (cvTotal > 0) {
        const ratio = _curveRatio(Math.min(1.0, cvTotal / jobTotalYears)); // FIX-19
        earned += w * ratio;
        _tr('total-years', `${cvTotal} vs ${jobTotalYears}`, 'required', w, ratio, '');
        const pct = Math.round(ratio * 100);
        if (ratio >= 0.9) {
          matchBullets.push(`✅ ${cvTotal} שנות ניסיון (${pct}%)`);
        } else {
          gapBullets.push(`⚠️ ${cvTotal} / ${jobTotalYears} שנות ניסיון (${pct}%)`);
        }
      } else {
        earned += w * 0.35;
      }
    }

    // ── Tools ──────────────────────────────────────────────────────────
    const toolsSection = userProfile.tools_and_methods;                 // FIX-11
    const tools = toolsSection || {};
    const jobLoTe = jobText.toLowerCase();

    function _toolFound(entry) {
      if (!entry) return false;
      if (entry === true) return true;
      if (typeof entry === 'object') {
        if (entry.found === true) return true;
        if (Array.isArray(entry.search_tags)) {
          return entry.search_tags.some(tag => _includesHebrew(jobLoTe, tag));
        }
      }
      return false;
    }
    // FIX-11: fall back to experience entries (Git/GitHub, CI/CD live there)
    function _toolInExperience(kw) {
      for (const techs of Object.values(userProfile.experience || {})) {
        for (const [name, entry] of Object.entries(techs || {})) {
          const nameParts = name.toLowerCase().split(/[\s/.\-]+/);
          if (name.toLowerCase() === kw || nameParts.includes(kw)) return true;
          const tags = Array.isArray(entry && entry.search_tags) ? entry.search_tags : [];
          if (tags.some(t => String(t).toLowerCase() === kw)) return true;
        }
      }
      return false;
    }
    function _alreadyCounted(kw) {                                      // FIX-11
      if (seen.has(kw)) return true;
      for (const key of seen.keys()) {
        if (key.split(/[\s/.\-]+/).includes(kw)) return true;
      }
      return false;
    }

    for (const kw of TOOL_KW) {
      if (!_includesHebrew(jobLoTe, kw)) continue;
      if (_alreadyCounted(kw)) continue;
      const entry = tools[kw] ?? tools[kw.replace('/', '')];
      const hit = _toolFound(entry) || _toolInExperience(kw);
      if (hit) {
        total += CFG.PTS_TOOL;
        earned += CFG.PTS_TOOL;
        matchBullets.push(`✅ ${kw}`);
      } else if (toolsSection && typeof toolsSection === 'object') {
        total += CFG.PTS_TOOL;   // real gap: the extractor DID emit a tools section
      }
      // FIX-11: no tools section at all → extraction gap, add no dead weight
    }

    // ── Compute score ──────────────────────────────────────────────────
    const noSignal = reqTechs.length === 0 && advTechs.length === 0;    // FIX-15
    const ratio = total > 0 ? earned / total : (noSignal ? 0.25 : 0.5);
    let raw = Math.round(ratio * 100);
    if (noSignal) {
      raw = Math.min(raw, CFG.NO_SIGNAL_CAP);
      matchBullets.unshift('⚠️ לא זוהו דרישות טכניות תואמות — התאמה באמינות נמוכה');
    }
    const score = Math.max(CFG.MIN_SCORE, Math.min(CFG.MAX_SCORE, raw));

    const bullets = [
      ...matchBullets.slice(0, 3),
      ...gapBullets.slice(0, 2),
    ].slice(0, 4);

    const out = { score, bullets };
    if (opts && opts.trace) { out.trace = trace; out.earned = +earned.toFixed(2); out.total = +total.toFixed(2); }
    return out;
  }

  function _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ── PUBLIC API ────────────────────────────────────────────────────────────
  window.JMA_Matcher = { computeScore, VERSION: '5.6' };
  // Internals exposed for the regression harness only (harmless in production)
  window.JMA_Matcher._parseJobSections = _parseJobSections;
  window.JMA_Matcher._extractRequirements = _extractRequirements;
  window.JMA_Matcher._extractTotalYears = _extractTotalYears;
  window.JMA_Matcher._profileYears = _profileYears;
})();