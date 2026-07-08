/**
 * JMA Local Profile Matcher v2
 *
 * Input:  userProfile  — structured JSON from /api/extract-profile (stored as jma_user_profile)
 *         jobText      — raw job-description string
 * Output: { score: 0-100, bullets: string[] }
 *
 * No network calls. Runs synchronously in content.js context.
 * Exposed as window.JMA_Matcher = { computeScore }
 */
(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────────────────────
  const CFG = {
    // Requirement-type multipliers
    REQUIRED_MULT:   1.00,   // חובה  — full weight
    ADVANTAGE_MULT:  0.40,   // יתרון — 40 % of weight

    // personal_weight (0-100) from the profile scales personal_years.
    // 50 = ברירת מחדל לפרופילים ישנים - משחזר בדיוק את ההתנהגות הקודמת (i + 0.5p).
    DEFAULT_PERSONAL_WEIGHT: 50,

    // Caps / floors
    MIN_SCORE:  18,
    MAX_SCORE:  94,

    // Point allocations (used as weights in the scoring pool)
    PTS_TECH_EXACT:    12,   // exact tech name match
    PTS_TECH_DOMAIN:    6,   // same domain (ontology) but not exact tech
    PTS_YEARS_TOTAL:   15,   // total experience requirement
    PTS_YEARS_SKILL:   10,   // per-skill years requirement
    PTS_DOMAIN_ROLE:    8,   // role-level domain requirement (e.g. "Backend Developer")
    PTS_TOOL:           4,   // tools_and_methods boolean match
    PTS_TRAIT:          3,   // soft-skill / trait match
  };

  // ── DOMAIN MAP ────────────────────────────────────────────────────────────
  // Maps technology keywords (lowercase) → profile experience domain key
  const TECH_DOMAIN = {
    // Backend
    java: 'backend', 'c#': 'backend', '.net': 'backend', python: 'backend',
    ruby: 'backend', go: 'backend', golang: 'backend', rust: 'backend',
    php: 'backend', scala: 'backend', kotlin: 'backend', 'node.js': 'backend',
    nodejs: 'backend', 'spring boot': 'backend', django: 'backend',
    flask: 'backend', fastapi: 'backend', express: 'backend', nestjs: 'backend',
    // Frontend
    react: 'frontend', 'react.js': 'frontend', vue: 'frontend', 'vue.js': 'frontend',
    angular: 'frontend', svelte: 'frontend', 'next.js': 'frontend', nextjs: 'frontend',
    javascript: 'frontend', typescript: 'frontend', html: 'frontend', css: 'frontend',
    'tailwind css': 'frontend', sass: 'frontend', webpack: 'frontend',
    // AI / ML / LLM
    'machine learning': 'ai_ml_llm', 'deep learning': 'ai_ml_llm',
    tensorflow: 'ai_ml_llm', pytorch: 'ai_ml_llm', 'langchain': 'ai_ml_llm',
    'openai': 'ai_ml_llm', 'llm': 'ai_ml_llm', 'nlp': 'ai_ml_llm',
    'hugging face': 'ai_ml_llm', 'scikit-learn': 'ai_ml_llm', 'keras': 'ai_ml_llm',
    // Data / BI
    sql: 'data_bi', postgresql: 'data_bi', postgres: 'data_bi', mysql: 'data_bi',
    spark: 'data_bi', hadoop: 'data_bi', pandas: 'data_bi', numpy: 'data_bi',
    'power bi': 'data_bi', tableau: 'data_bi', 'looker': 'data_bi',
    dbt: 'data_bi', airflow: 'data_bi', kafka: 'data_bi',
    // DevOps / Cloud
    docker: 'devops_cloud', kubernetes: 'devops_cloud', k8s: 'devops_cloud',
    aws: 'devops_cloud', azure: 'devops_cloud', gcp: 'devops_cloud',
    terraform: 'devops_cloud', ansible: 'devops_cloud', jenkins: 'devops_cloud',
    'github actions': 'devops_cloud', gitlab: 'devops_cloud',
    // Mobile
    swift: 'mobile', 'objective-c': 'mobile', flutter: 'mobile',
    'react native': 'mobile', 'android': 'mobile', 'ios': 'mobile',
    // Databases (cross-domain)
    mongodb: 'backend', redis: 'backend', elasticsearch: 'backend',
    dynamodb: 'devops_cloud', 'cassandra': 'data_bi',
    // Cyber / QA (other_domains)
    'penetration testing': 'other_domains', 'siem': 'other_domains',
    selenium: 'other_domains', cypress: 'other_domains', jest: 'other_domains',
    pytest: 'other_domains',
  };

  // Role-level domain keywords in job text → profile domain keys
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

  // Tools that appear in tools_and_methods
  const TOOL_KW = [
    'git', 'ci/cd', 'cicd', 'agile', 'scrum', 'kanban', 'docker', 'kubernetes',
    'microservices', 'rest', 'graphql', 'tdd', 'bdd', 'jira', 'linux',
  ];

  // Trait keywords to look for in job text
  const TRAIT_KW = [
    'self-directed', 'self directed', 'independent', 'team player', 'collaborative',
    'analytical', 'problem solver', 'fast learner', 'proactive', 'detail-oriented',
  ];

  // ── HEBREW-AWARE TEXT MATCHING ────────────────────────────────────────────

  // Hebrew prepositions attach directly to words: "בפייתון" = "in Python".
  // Latin tags get word-boundary matching so "rest" never matches "interested".
  const _HE_PREFIXES = ['ב', 'כ', 'ל', 'מ', 'ו', 'ה', 'ש'];
  const _termReCache = new Map();

  function _includesHebrew(textLower, tag) {
    const tl = tag.toLowerCase();
    if (/^[a-z0-9]/.test(tl)) {
      // Latin/digit tag → strict word boundaries, compiled once and cached
      let re = _termReCache.get(tl);
      if (!re) {
        const esc = tl.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp('(?<![a-z0-9])' + esc + '(?![a-z0-9])');
        _termReCache.set(tl, re);
      }
      return re.test(textLower);
    }
    // Hebrew tag → substring + prefixed variants
    if (textLower.includes(tl)) return true;
    if (/[֐-׿]/.test(tag)) {
      for (const p of _HE_PREFIXES) {
        if (textLower.includes(p + tl)) return true;
      }
    }
    return false;
  }

  // Returns true if techName OR any of its search_tags appear in jobTextLower.
  function _techMentionedInJob(jobTextLower, techName, searchTags) {
    if (_includesHebrew(jobTextLower, techName)) return true;
    if (Array.isArray(searchTags)) {
      for (const tag of searchTags) {
        if (_includesHebrew(jobTextLower, tag)) return true;
      }
    }
    return false;
  }

  // ── JOB PARSER ────────────────────────────────────────────────────────────

  // Tri-state, line-based section parser: context (company blurb) / required / advantage.
  // A header is a SHORT line (≤80 chars) matching the patterns - so "bonus" inside a
  // salary sentence never flips the state. Requirements after an advantage section
  // return to full weight. If no required-header exists, pre-advantage text is required
  // (legacy behavior) so header-less jobs keep working.
  const ADV_HEADER_RE = /(יתרון|advantage|nice[ -]?to[ -]?have|preferred qualifications?|bonus points?|desirable|beneficial|a plus)/i;
  const REQ_HEADER_RE = /(requirements?|דרישות|חובה|must[ -]?have|qualifications?|essential|mandatory|what you(?:'|’)?ll need|what we(?:'|’)?re looking for|what you(?:'|’)?ll do|responsibilities|the role|תיאור המשרה|על התפקיד|תחומי אחריות)/i;

  function _parseJobSections(jobText) {
    const lines = jobText.split(/\r?\n/);
    let state = 'context';
    let sawReqHeader = false;
    const buckets = { context: [], required: [], advantage: [] };

    for (const line of lines) {
      const t = line.trim();
      if (t.length > 0 && t.length <= 80) {
        if (ADV_HEADER_RE.test(t))      { state = 'advantage'; sawReqHeader = true; }
        else if (REQ_HEADER_RE.test(t)) { state = 'required';  sawReqHeader = true; }
      }
      buckets[state].push(line);
    }

    let requiredText  = buckets.required.join('\n');
    let advantageText = buckets.advantage.join('\n');

    if (!sawReqHeader) {
      // No headers at all - legacy split: everything is required
      requiredText = buckets.context.join('\n');
    }
    return { requiredText, advantageText };
  }

  // Bullet-aware extraction: years are searched ONLY inside the same line/bullet as
  // the tech, so "3+ years Python" never leaks onto an adjacent "Docker" bullet.
  // Each requirement also gets industryOnly=true when its line demands industry experience.
  const INDUSTRY_ONLY_RE = /(בתעשייה|ניסיון תעשייתי|industry experience|commercial experience|production environment|hands[ -]on (?:industry|commercial))/i;
  const YEARS_RE = /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?|שנות?|שנ)/i;

  function _extractRequirements(text, profile) {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    const reqs = [];
    const seen = new Set();

    for (const line of lines) {
      const lineLo = line.toLowerCase();
      const yearMatch = lineLo.match(YEARS_RE);
      const lineYears = yearMatch ? parseFloat(yearMatch[1]) : null;
      const industryOnly = INDUSTRY_ONLY_RE.test(line);

      // Pass 1: hardcoded TECH_DOMAIN keywords
      for (const tech of Object.keys(TECH_DOMAIN)) {
        if (seen.has(tech)) continue;
        if (!_includesHebrew(lineLo, tech)) continue;
        seen.add(tech);
        reqs.push({ tech, reqYears: lineYears, domain: TECH_DOMAIN[tech], industryOnly });
      }

      // Pass 2: profile techs via search_tags (Hebrew + synonyms)
      if (profile) {
        for (const [domain, techs] of Object.entries(profile.experience || {})) {
          for (const [techName, entry] of Object.entries(techs || {})) {
            const key = techName.toLowerCase();
            if (seen.has(key)) continue;
            const tags = Array.isArray(entry.search_tags) ? entry.search_tags : [];
            if (!_techMentionedInJob(lineLo, techName, tags)) continue;
            seen.add(key);
            reqs.push({ tech: techName, reqYears: lineYears, domain, industryOnly });
          }
        }
      }
    }
    return reqs;
  }

  // Extract total-years-of-experience requirement from job text.
  function _extractTotalYears(text) {
    const lo = text.toLowerCase();
    const patterns = [
      /(\d+)\+?\s*years?\s*(?:of\s*)?(?:professional\s*)?experience/i,
      /(\d+)\+?\s*שנות?\s*ניסיון/i,
      /ניסיון\s*(?:של\s*)?(\d+)/i,
      /experience\s*(?:of\s*)?(\d+)\+?\s*years?/i,
    ];
    for (const re of patterns) {
      const m = lo.match(re);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }

  // Extract role-domain requirements from job text.
  function _extractRoleDomains(text) {
    const lo = text.toLowerCase();
    const found = new Set();
    for (const [domain, kws] of Object.entries(ROLE_DOMAIN_KW)) {
      if (kws.some(kw => lo.includes(kw))) found.add(domain);
    }
    return found;
  }

  // ── PROFILE LOOKUP HELPERS ────────────────────────────────────────────────

  // Effective years = industry + personal × (personal_weight/100).
  // Searches the hinted domain first, then ALL domains - the AI may place Python
  // under ai_ml_llm while TECH_DOMAIN says backend.
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

    for (const d of domains) {
      const domainExp = exp[d] || {};
      const key = Object.keys(domainExp).find(k => k.toLowerCase() === tl);
      if (!key) continue;
      const entry = domainExp[key] || {};
      const ind = parseFloat(entry.industry_years) || 0;
      const per = parseFloat(entry.personal_years) || 0;
      let w = parseInt(entry.personal_weight, 10);
      if (isNaN(w)) w = CFG.DEFAULT_PERSONAL_WEIGHT;
      w = Math.max(0, Math.min(100, w));
      return { effective: ind + per * (w / 100), industry: ind, personal: per };
    }
    return { effective: 0, industry: 0, personal: 0 };
  }

  // Get total domain years from profile (capped by total career years).
  function _profileDomainYears(profile, domain) {
    const dy = profile.industry_summary?.domain_years || {};
    return parseFloat(dy[domain]) || 0;
  }

  // Get total industry years from profile.
  function _profileTotalYears(profile) {
    return parseFloat(profile.industry_summary?.total_years_industry) || 0;
  }

  // ── SCORING CORE ─────────────────────────────────────────────────────────

  /**
   * computeScore(userProfile, jobText)
   * userProfile — the JSON object from chrome.storage.local['jma_user_profile']
   * jobText     — raw job description string
   * Returns { score: 0-100, bullets: string[] }
   */
  function computeScore(userProfile, jobText) {
    if (!userProfile || !jobText) return { score: CFG.MIN_SCORE, bullets: [] };

    const { requiredText, advantageText } = _parseJobSections(jobText);

    const reqTechs  = _extractRequirements(requiredText,  userProfile);
    const advTechs  = _extractRequirements(advantageText, userProfile);
    // שנות ניסיון כלליות: מחפשים קודם בסעיף הדרישות (לא "10 years in business" מתיאור החברה)
    const jobTotalYears = _extractTotalYears(requiredText) ?? _extractTotalYears(jobText);
    const jobRoles  = _extractRoleDomains(jobText);

    let earned = 0, total = 0;
    const matchBullets = [], gapBullets = [];

    // ── Required technologies ────────────────────────────────────────────
    for (const { tech, reqYears, domain, industryOnly } of reqTechs) {
      const mult   = CFG.REQUIRED_MULT;
      const wBase  = reqYears ? CFG.PTS_YEARS_SKILL : CFG.PTS_TECH_EXACT;
      const w      = wBase * mult;
      total += w;

      const yrs = _profileYears(userProfile, tech, domain);
      const industry = yrs.industry, personal = yrs.personal;
      // דרישת תעשייה מפורשת: ניסיון אישי לא נספר
      const effective = industryOnly ? yrs.industry : yrs.effective;

      if (effective > 0) {
        if (reqYears) {
          // Proportional penalty: effective_years / reqYears
          const ratio = Math.min(1.0, effective / reqYears);
          earned += w * ratio;
          const pct = Math.round(ratio * 100);
          const label = industryOnly ? `${industry} שנ' תעשייה` : `${industry}i+${personal}p yr`;
          if (ratio >= 0.85) {
            matchBullets.push(`✅ ${_cap(tech)} — ${label} (${pct}%)`);
          } else if (ratio >= 0.5) {
            matchBullets.push(`⚡ ${_cap(tech)} — ${label} / ${reqYears} נדרש (${pct}%)`);
          } else {
            gapBullets.push(`⚠️ ${_cap(tech)} — ${label} / ${reqYears} שנות ניסיון נדרשות`);
          }
        } else {
          earned += w;
          matchBullets.push(`✅ ${_cap(tech)}`);
        }
      } else {
        // No exact match — check domain coverage
        const domainYears = _profileDomainYears(userProfile, domain);
        if (domainYears > 0) {
          earned += w * 0.50;
          matchBullets.push(`↔️ ${_cap(tech)} — כיסוי דומיין (${domain})`);
        } else {
          // Absolute zero — deduct full weight (no "free" points)
          gapBullets.push(`❌ ${_cap(tech)}`);
        }
      }
    }

    // ── Advantage technologies (40 % weight) ───────────────────────────
    for (const { tech, reqYears, domain } of advTechs) {
      const mult  = CFG.ADVANTAGE_MULT;
      const wBase = reqYears ? CFG.PTS_YEARS_SKILL : CFG.PTS_TECH_EXACT;
      const w     = wBase * mult;
      total += w;

      const { effective } = _profileYears(userProfile, tech, domain);
      if (effective > 0) {
        const ratio = reqYears
          ? Math.min(1.0, effective / reqYears)
          : 1.0;
        earned += w * ratio;
        matchBullets.push(`➕ ${_cap(tech)} (יתרון)`);
      } else {
        const domainYears = _profileDomainYears(userProfile, domain);
        if (domainYears > 0) earned += w * 0.35;
        // advantage gaps don't generate bullet clutter
      }
    }

    // ── Role-domain requirements ────────────────────────────────────────
    for (const domain of jobRoles) {
      if (reqTechs.some(r => r.domain === domain)) continue; // already covered
      const w = CFG.PTS_DOMAIN_ROLE;
      total += w;
      const dy = _profileDomainYears(userProfile, domain);
      if (dy > 0) {
        earned += w;
        matchBullets.push(`✅ ניסיון ${domain} (${dy} שנים)`);
      } else {
        gapBullets.push(`❌ חסר ניסיון ב-${domain}`);
      }
    }

    // ── Total years of experience ───────────────────────────────────────
    if (jobTotalYears) {
      const w = CFG.PTS_YEARS_TOTAL;
      total += w;
      const cvTotal = _profileTotalYears(userProfile);
      if (cvTotal > 0) {
        const ratio = Math.min(1.0, cvTotal / jobTotalYears);
        earned += w * ratio;
        const pct = Math.round(ratio * 100);
        if (ratio >= 0.9) {
          matchBullets.push(`✅ ${cvTotal} שנות ניסיון (${pct}%)`);
        } else {
          gapBullets.push(`⚠️ ${cvTotal} / ${jobTotalYears} שנות ניסיון (${pct}%)`);
        }
      } else {
        earned += w * 0.35; // profile present but years unknown
      }
    }

    // ── Tools ──────────────────────────────────────────────────────────
    const tools   = userProfile.tools_and_methods || {};
    const jobLoTe = jobText.toLowerCase();

    // _toolFound: handles both old schema (bool) and new schema ({found, search_tags})
    function _toolFound(entry) {
      if (!entry) return false;
      if (entry === true) return true;                     // legacy bool
      if (typeof entry === 'object') {
        if (entry.found === true) return true;
        // Also accept if any search_tag appears in the job text
        if (Array.isArray(entry.search_tags)) {
          return entry.search_tags.some(tag => _includesHebrew(jobLoTe, tag));
        }
      }
      return false;
    }

    for (const kw of TOOL_KW) {
      if (!_includesHebrew(jobLoTe, kw)) continue;
      const w = CFG.PTS_TOOL;
      total += w;
      const entry = tools[kw] ?? tools[kw.replace('/', '')] ?? tools[kw.replace('ci/cd', 'cicd')];
      if (_toolFound(entry)) {
        earned += w;
        matchBullets.push(`✅ ${kw}`);
      }
    }

    // ── Compute score ──────────────────────────────────────────────────
    const ratio = total > 0 ? earned / total : 0.5;
    const raw   = Math.round(ratio * 100);
    const score = Math.max(CFG.MIN_SCORE, Math.min(CFG.MAX_SCORE, raw));

    // Build bullets: matches first, then gaps, capped at 4
    const bullets = [
      ...matchBullets.slice(0, 3),
      ...gapBullets.slice(0, 2),
    ].slice(0, 4);

    return { score, bullets };
  }

  function _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ── PUBLIC API ────────────────────────────────────────────────────────────
  window.JMA_Matcher = { computeScore };
})();
