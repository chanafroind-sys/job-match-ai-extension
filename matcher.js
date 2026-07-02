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

    // Source multipliers applied to years
    INDUSTRY_MULT:   2.0,    // industry_years counts double
    PERSONAL_MULT:   1.0,    // personal_years counts single

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

  // ── JOB PARSER ────────────────────────────────────────────────────────────

  // Heuristically split job text into required vs. advantage sections.
  function _parseJobSections(jobText) {
    const lo = jobText.toLowerCase();

    // Split on known section headers
    const ADV_HEADERS = [
      /יתרון|advantage|nice.to.have|preferred|bonus|plus|desirable|beneficial/i,
    ];
    const REQ_HEADERS = [
      /requirement|חובה|must.have|essential|mandatory|we.require|what.you.need|you.have/i,
    ];

    // Find first advantage header position
    let advStart = lo.length;
    for (const re of ADV_HEADERS) {
      const m = lo.search(re);
      if (m !== -1 && m < advStart) advStart = m;
    }

    const requiredText  = jobText.slice(0, advStart);
    const advantageText = jobText.slice(advStart);

    return { requiredText, advantageText };
  }

  // Extract (tech, reqYears) pairs from a text segment.
  function _extractRequirements(text) {
    const lo = text.toLowerCase();
    const reqs = [];
    const seen = new Set();

    const techKeys = Object.keys(TECH_DOMAIN).sort((a, b) => b.length - a.length);
    for (const tech of techKeys) {
      const escaped = tech.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?<![a-z0-9])' + escaped + '(?![a-z0-9])', 'i');
      if (!re.test(lo)) continue;
      if (seen.has(tech)) continue;
      seen.add(tech);

      // Look for year mentions near the tech mention
      const idx = lo.search(re);
      const window = lo.slice(Math.max(0, idx - 180), idx + 180);
      const yearMatch = window.match(/(\d+(?:\.\d+)?)\s*(?:\+)?\s*(?:years?|yrs?|שנות?|שנ)/i);
      reqs.push({ tech, reqYears: yearMatch ? parseFloat(yearMatch[1]) : null, domain: TECH_DOMAIN[tech] });
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

  // Get effective years for a tech from profile.
  // industry_years × INDUSTRY_MULT + personal_years × PERSONAL_MULT.
  function _profileYears(profile, tech) {
    const exp = profile.experience || {};
    const domain = TECH_DOMAIN[tech.toLowerCase()];
    if (!domain) return { effective: 0, industry: 0, personal: 0 };
    const domainExp = exp[domain] || {};

    // Try exact key match (case-insensitive)
    const key = Object.keys(domainExp).find(k => k.toLowerCase() === tech.toLowerCase());
    if (!key) return { effective: 0, industry: 0, personal: 0 };

    const entry = domainExp[key] || {};
    const ind = parseFloat(entry.industry_years) || 0;
    const per = parseFloat(entry.personal_years) || 0;
    return {
      effective: ind * CFG.INDUSTRY_MULT + per * CFG.PERSONAL_MULT,
      industry: ind,
      personal: per,
    };
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

    const reqTechs  = _extractRequirements(requiredText);
    const advTechs  = _extractRequirements(advantageText);
    const jobTotalYears = _extractTotalYears(jobText);
    const jobRoles  = _extractRoleDomains(jobText);

    let earned = 0, total = 0;
    const matchBullets = [], gapBullets = [];

    // ── Required technologies ────────────────────────────────────────────
    for (const { tech, reqYears, domain } of reqTechs) {
      const mult   = CFG.REQUIRED_MULT;
      const wBase  = reqYears ? CFG.PTS_YEARS_SKILL : CFG.PTS_TECH_EXACT;
      const w      = wBase * mult;
      total += w;

      const { effective, industry, personal } = _profileYears(userProfile, tech);

      if (effective > 0) {
        if (reqYears) {
          // Proportional penalty: effective_years / (reqYears × INDUSTRY_MULT)
          const ratio = Math.min(1.0, effective / (reqYears * CFG.INDUSTRY_MULT));
          earned += w * ratio;
          const pct = Math.round(ratio * 100);
          const label = `${industry}i+${personal}p yr`;
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

      const { effective } = _profileYears(userProfile, tech);
      if (effective > 0) {
        const ratio = reqYears
          ? Math.min(1.0, effective / (reqYears * CFG.INDUSTRY_MULT))
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
    for (const kw of TOOL_KW) {
      const jobHas = jobLoTe.includes(kw.replace('/', '/').toLowerCase());
      if (!jobHas) continue;
      const w = CFG.PTS_TOOL;
      total += w;
      if (tools[kw] === true || tools[kw.replace('/', '')] === true) {
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
