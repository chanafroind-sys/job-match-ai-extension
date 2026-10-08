// Daily Matches — the side panel: build today's deck, browse it, apply.
//
// Views: loading · disabled · error · nocv · ready · building · deck · quiet ·
// apply · end · saved · paywall · library · profile. Everything renders into
// #dm-app from state; clicks are delegated through data-act attributes. Every
// string from the server or a job board is escaped before it reaches
// innerHTML: job text is third-party content inside a privileged page.
//
// A deck holds only new jobs that scored 60 or more: strong ones (70+) first,
// then "worth a look" (60-69). A day with none says so (quiet) instead of
// showing weak matches.
(function (root) {
  'use strict';

  const DM = root.JMA_DM;
  const UI_KEY = 'jma_dm_ui';
  const AUTOSTART_MS = 20000;
  const ACTED = new Set(['saved', 'skipped', 'applied']);
  const CIRC = 188.5;
  const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const state = {
    view: 'loading', status: null, cards: [], idx: 0, run: null, readOnly: false,
    cvs: [], cvSel: {}, build: null, applying: null, error: null, prevView: null,
    pendingApply: false, saved: [], busy: false, notice: '', level: null, newFocus: [],
  };
  const LEVELS = [['junior', 'ג׳וניור', '0-2 שנים'], ['mid', 'מיד', '2-5 שנים'], ['senior', 'סניור', '5+ שנים'],
    ['lead', 'ליד / ניהול', '']];
  const MAX_ANALYZED = 40; // server-python/daily_matches/config.py MAX_ANALYZED

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const $ = (sel) => document.querySelector(sel);
  const app = () => document.getElementById('dm-app');
  const fmtInt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '');
  const todayLabel = () => {
    try { return new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()); }
    catch (_) { return ''; }
  };

  // ── score presentation (V1's bands and labels, popup.js scoreColor/verdictInfo) ──
  const bandColor = s => (s >= 75 ? '#16A34A' : s >= 55 ? '#D97706' : s >= 35 ? '#EA580C' : '#DC2626');
  const verdict = s => (s >= 75 ? ['⭐ מעולה', 'verdict-great'] : s >= 55 ? ['👍 טוב', 'verdict-good']
    : s >= 35 ? ['🤔 בינוני', 'verdict-ok'] : ['❌ לא מתאים', 'verdict-bad']);
  function ring(score, small) {
    if (score == null) {
      return `<div class="ring${small ? ' ring-sm' : ''}"><svg viewBox="0 0 72 72" aria-hidden="true"><circle class="ring-track" cx="36" cy="36" r="30"/></svg><span class="ring-num">—</span></div>`;
    }
    const off = (CIRC * (1 - score / 100)).toFixed(1);
    return `<div class="ring${small ? ' ring-sm' : ''}" style="--c:${bandColor(score)}"><svg viewBox="0 0 72 72" aria-hidden="true"><circle class="ring-track" cx="36" cy="36" r="30"/><circle class="ring-val" cx="36" cy="36" r="30" stroke-dasharray="${CIRC}" stroke-dashoffset="${off}"/></svg><span class="ring-num" aria-hidden="true">${score}</span><span class="sr">ציון התאמה ${score} מתוך 100</span></div>`;
  }

  const ATS_NAME = { lever: 'Lever', greenhouse: 'Greenhouse', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workday: 'Workday', other: 'אתר החברה' };

  function cvLabel(card, cvId) {
    const fromScores = card.analysis && (card.analysis.cv_scores || []).find(s => s.cv_id === cvId);
    if (fromScores && fromScores.label) return fromScores.label;
    const fromLib = state.cvs.find(v => v.id === cvId);
    return fromLib ? fromLib.label : 'קורות החיים';
  }
  const selectedCv = (card) => state.cvSel[card.id] || card.best_cv_id || (state.cvs[0] && state.cvs[0].id);

  async function applySubLabel(card) {
    const ats = card.job && card.job.ats;
    const label = cvLabel(card, selectedCv(card));
    if (DM.apply.canAutofill(ats)) {
      const profile = await DM.apply.getProfile();
      return `${profile ? '⚡ מילוי אוטומטי + צירוף קו״ח' : '⚡ מילוי אוטומטי (אחרי אישור פרטים)'} · ${label}`;
    }
    if (ats === 'workday') return `🔐 נדרשת התחברות לאתר החברה · ${label}`;
    return `📎 קו״ח מוכנים לצירוף · ${label}`;
  }

  // ── rendering ────────────────────────────────────────────────────────────────
  function setView(view) {
    state.view = view;
    render();
  }

  function render() {
    const views = {
      loading, disabled, error: errorView, nocv, ready, building, deck, quiet, apply: applyView,
      end, saved: savedView, paywall, library, profile,
    };
    app().innerHTML = (views[state.view] || loading)();
    if (state.view === 'deck') afterDeckRender();
  }

  const topBar = (title, extra = '') => `<header class="dm-top"><div><h1 class="dm-title">${title}</h1><div class="dm-date">${esc(todayLabel())}</div></div>${extra}</header>`;
  const back = (act = 'back', text = 'חזרה') => `<button type="button" class="btn btn-secondary" data-act="${act}">${text}</button>`;

  function loading() {
    return `<div class="dm-center"><div class="spinner" aria-hidden="true"></div><p class="dm-muted">טוען…</p></div>`;
  }

  function disabled() {
    return `<div class="dm-center"><div class="dm-big" aria-hidden="true">✨</div><h1 class="dm-h">ההתאמות היומיות עדיין לא זמינות</h1><p class="dm-muted">הפיצ'ר בהפעלה הדרגתית. ברגע שייפתח, הכפתור בחלון התוסף יוביל לכאן.</p></div>`;
  }

  function errorView() {
    const e = state.error || {};
    const lib = e.code === 'DM_NO_CV' || e.code === 'DM_CV_UNREADABLE';
    return `<div class="dm-center"><div class="dm-big" aria-hidden="true">⚠️</div><h1 class="dm-h">${esc(e.title || 'משהו השתבש')}</h1><p class="dm-muted">${esc(e.message || '')}</p>
      <div class="dm-stack">${lib ? '<button type="button" class="btn btn-primary" data-act="library">ניהול גרסאות קורות החיים</button>' : ''}
      ${e.retry ? `<button type="button" class="btn ${lib ? 'btn-secondary' : 'btn-primary'}" data-act="${e.retry}">לנסות שוב</button>` : ''}</div></div>`;
  }

  function nocv() {
    return `${topBar('✨ ההתאמות היומיות')}<div class="dm-body"><div class="dm-card-plain"><h2 class="dm-h2">קודם כל, קורות חיים</h2>
      <p class="dm-muted">כדי לבנות חפיסה צריך לפחות גרסה אחת של קורות החיים. אפשר להעלות אותה בהגדרות ⚙️ של התוסף, או להוסיף כאן.</p>
      <button type="button" class="btn btn-primary" data-act="library">הוספת קורות חיים</button></div></div>`;
  }

  // A version's categories as chips: read-only, or toggles in the library.
  function focusChips(v, editable) {
    const chosen = v.focus || [];
    const shown = DM.cvLibrary.effectiveFocus(v);
    if (editable) {
      return `<div class="fchips" role="group" aria-label="תחומים ל${esc(v.label)}">${DM.cvLibrary.CATEGORIES.map(c => {
        const on = shown.includes(c);
        return `<button type="button" class="fchip${on ? ' is-on' : ''}" data-act="toggle-focus" data-id="${esc(v.id)}" data-cat="${esc(c)}" aria-pressed="${on}"><bdi dir="ltr">${esc(c)}</bdi></button>`;
      }).join('')}</div>${!chosen.length && shown.length ? '<p class="dm-fine">זוהו אוטומטית מתוך הקובץ. לחיצה על תחום מעדכנת.</p>' : ''}`;
    }
    if (!shown.length) return '<span class="dm-fine">כל התחומים</span>';
    return shown.map(c => `<span class="chip"><bdi dir="ltr">${esc(c)}</bdi></span>`).join('') +
      (chosen.length ? '' : '<span class="dm-fine">(זוהה אוטומטית)</span>');
  }

  function ready() {
    const s = state.status || {};
    const trial = s.entitlement === 'trial';
    const pool = s.pool || {};
    const n = state.cvs.length;
    const versions = state.cvs.map(v => `<li class="cvv"><div class="cvv-top"><span aria-hidden="true">📄</span><span class="cv-row-name">${esc(v.label)}</span><span class="dm-fine cv-row-meta">${v.needsExtraction ? 'PDF · ייקרא בהרצה הראשונה' : v.hasFile ? '⬇️ קובץ להורדה' : 'בלי קובץ להורדה'}</span></div><div class="cvv-focus">${focusChips(v, false)}</div></li>`).join('');
    const poolNote = !pool.embedded ? 'מאגר המשרות של היום עדיין מתעדכן.'
      : pool.fresh != null ? `${fmtInt(pool.fresh)} משרות חדשות נכנסו למאגר ב-3 הימים האחרונים.`
        : `${fmtInt(pool.active)} משרות פעילות במאגר של היום.`;
    const levels = LEVELS.map(([k, label, sub]) => `<button type="button" class="lvl${state.level === k ? ' is-on' : ''}" data-act="set-level" data-level="${k}" aria-pressed="${state.level === k}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`).join('');
    return `${topBar('✨ ההתאמות היומיות שלך')}<div class="dm-body">
      ${state.notice ? `<p class="dm-notice">${esc(state.notice)}</p>` : ''}
      <div class="dm-card-plain"><h2 class="dm-h2">${trial ? 'הרצה אחת עלינו 🎁' : 'החפיסה של היום מחכה'}</h2>
        <p class="dm-muted">${esc(poolNote)} נבדוק רק משרות שעוד לא ראית, בתחומים של גרסאות הקו״ח שלך, ננתח לעומק עד ${MAX_ANALYZED} מהן, ונציג רק את אלה שבאמת מתאימות.</p>
        <button type="button" class="btn btn-primary dm-cta" data-act="build">בניית החפיסה של היום</button>
        <p class="dm-fine">${trial ? 'ניסיון חינם חד-פעמי. ריצה שנכשלת או שלא מצאה כלום לא נספרת.' : 'פעם ביום · מתאפס בחצות (שעון ישראל) · ריצה שנכשלת לא נספרת'}</p></div>
      <div class="dm-card-plain"><div class="dm-row"><h2 class="dm-h2">📄 גרסאות הקו״ח שלי <span class="dm-fine">(${n}/${DM.cvLibrary.MAX_VERSIONS})</span></h2><button type="button" class="link-btn" data-act="library">עריכה</button></div>
        <ul class="cv-list">${versions}</ul>
        ${n < 2 ? `<p class="dm-tip">💡 אפשר להעלות גרסה לכל כיוון, למשל Backend, ‏Full Stack + LLM או DevOps. לכל משרה נבחר את הגרסה המתאימה ונכין אותה להורדה.</p>` : ''}
        ${n < DM.cvLibrary.MAX_VERSIONS ? '<button type="button" class="btn btn-secondary" data-act="library">➕ הוספת גרסת קו״ח</button>' : ''}</div>
      <div class="dm-card-plain"><h2 class="dm-h2">רמת הניסיון שלי</h2>
        <div class="lvls" role="group" aria-label="רמת ניסיון">${levels}</div>
        <p class="dm-fine">${state.level ? 'משרות ברמה שלא מתאימה לך לא ייכנסו לחפיסה.' : 'בלי בחירה נבדוק משרות בכל הרמות.'}</p></div>
      <button type="button" class="link-btn dm-link" data-act="profile">פרטים למילוי טפסים</button>
    </div>`;
  }

  function building() {
    const b = state.build || {};
    const step = (key, title, sub, extra = '') => `<li class="bd-step is-${b[key] || 'wait'}"><span class="bd-dot" aria-hidden="true"></span><div class="bd-body"><div class="bd-st">${title}</div><div class="bd-sd">${esc(sub)}</div>${extra}</div></li>`;
    const total = b.total || 0;
    const cells = Array.from({ length: total }, (_, i) => `<span class="bd-cell${i < (b.done || 0) ? ' is-done' : ''}"></span>`).join('');
    const grid = total ? `<div class="bd-grid" style="grid-template-columns:repeat(${Math.min(total, 20)},1fr)" aria-hidden="true">${cells}</div>` : '';
    return `${topBar(esc(b.title || 'בונים את החפיסה של היום'))}<div class="dm-body bd">
      <ol class="bd-steps">
        ${step('s1', 'מחפשים משרות חדשות בתחומים שלך', b.s1text || 'רק משרות שעוד לא ראית')}
        ${step('s2', total ? `ניתוח לעומק של ${total} משרות` : 'ניתוח לעומק של כל משרה', b.s2text || 'כל משרה בנפרד: דרישות, פערים ואיזו גרסה להגיש', grid)}
        ${step('s3', 'מסננים לפי ציון', b.s3text || 'רק משרות עם ציון 60 ומעלה נכנסות לחפיסה')}
      </ol>
      <div class="bd-skel" aria-hidden="true"><span style="width:60%"></span><span style="width:40%"></span><span style="width:85%"></span><span style="width:70%"></span></div>
      <p class="dm-fine dm-centered">אפשר לסגור את החלונית. החפיסה תחכה כאן כשתחזור/י.<br>ריצה שנכשלת לא נספרת, ואפשר לנסות שוב.</p></div>`;
  }

  function reqSummary(reqs) {
    const c = { met: 0, partial: 0, missing: 0 };
    reqs.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
    const part = (n, one, many, cls) => (n ? `<b class="${cls}">${n}</b> ${n === 1 ? one : many}` : '');
    return [part(c.met, 'מתקיימת', 'מתקיימות', 'c-ok'), part(c.partial, 'חלקית', 'חלקיות', 'c-mid'),
      part(c.missing, 'חסרה', 'חסרות', 'c-no')].filter(Boolean).join(' · ');
  }

  const STATUS_ICON = { met: ['✓', 'מתקיימת'], partial: ['◐', 'חלקית'], missing: ['✕', 'חסרה'] };
  const ACTION_RIBBON = { applied: ['✓ הוגש', 's-applied'], saved: ['🔖 נשמר', 's-saved'], skipped: ['דולג', 's-skipped'] };
  const MODEL_NAME = { 'claude-sonnet-5-5': 'Sonnet 5.5' };

  function postedLabel(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const days = Math.floor((Date.now() - t) / 86400000);
    return days <= 0 ? 'פורסמה היום' : days === 1 ? 'פורסמה אתמול' : `פורסמה לפני ${days} ימים`;
  }

  const hasCvFile = (cvId) => !!(state.cvs.find(v => v.id === cvId) || {}).hasFile;
  const isAdmin = () => !!(state.status && state.status.is_admin);

  // The server computes the score from the model's classifications
  // (server-python/daily_matches/reasoning.py score_of); this shows the sum.
  const CAP_HE = {
    level_unproven: 'תפקיד בכיר בלי הוכחה לניסיון ברמה הזו', no_people_leadership: 'תפקיד ניהולי בלי ניסיון בניהול אנשים',
    overqualified: 'תפקיד ג׳וניור לניסיון בכיר', hard_blocker: 'דרישת סף שלא מופיעה בקורות החיים',
    domain_mismatch: 'תחום שונה מהניסיון שלך', not_a_job: 'זו לא מודעת דרושים', no_requirements: 'המודעה לא מפרטת דרישות',
  };
  const OFFSET_HE = { strong_academics: 'השכלה חזקה', adjacent_skills: 'כישורים קרובים', relevant_projects: 'פרויקטים רלוונטיים' };

  function whyHtml(a) {
    if (!Array.isArray(a.breakdown)) return ''; // decks scored before the breakdown existed
    const row = (pts, label, cls = '') => `<li class="why-row${cls}"><b class="why-pts" dir="ltr">${pts}</b><span>${label}</span></li>`;
    const rows = a.breakdown.map(b => {
      const pts = `${b.points > 0 ? '+' : '−'}${Math.abs(b.points)}`;
      if (b.kind === 'requirement') {
        return row(pts, `<bdi dir="ltr">${esc(b.text)}</bdi> · ${b.importance === 'must' ? 'חובה' : 'יתרון'}, ${b.status === 'missing' ? 'חסר' : 'חלקי'}`, ' is-neg');
      }
      if (b.kind === 'years') return row(pts, `ניסיון: ${esc(b.relevant)} מתוך ${esc(b.required)} שנים נדרשות`, ' is-neg');
      if (b.kind === 'offsets') return row(pts, esc((b.names || []).map(n => OFFSET_HE[n] || n).join(', ')), ' is-pos');
      return '';
    }).join('');
    const cap = a.cap ? row(`≤${esc(a.cap.value)}`, `תקרה: ${esc(CAP_HE[a.cap.name] || a.cap.name)}`, ' is-cap') : '';
    return `<div><button type="button" class="link-btn" data-act="why" aria-expanded="false">🧮 איך חושב הציון ▾</button>
      <div class="dm-why" hidden><p class="dm-fine">מתחילים מ-100 ומורידים לפי כל פער. אותם פערים תמיד נותנים אותו ציון.</p>
        <ul class="why-list">${row('100', 'נקודת ההתחלה')}${rows}${cap}${row(esc(a.match_score), '<b>הציון</b>', ' is-total')}</ul></div></div>`;
  }

  function cardHtml(card, i, n) {
    const a = card.analysis;
    const job = card.job || {};
    const score = card.match_score;
    const [vl, vc] = score == null ? ['ללא ניתוח', 'verdict-ok'] : verdict(score);
    const posted = postedLabel(job.published_at);
    const chips = [
      card.tier === 'maybe' && '<span class="chip chip-maybe">👀 שווה הצצה</span>',
      job.category && `<span class="chip"><bdi dir="ltr">${esc(job.category)}</bdi></span>`,
      job.seniority && job.seniority !== 'Unknown' && `<span class="chip"><bdi dir="ltr">${esc(job.seniority)}</bdi></span>`,
      posted && `<span class="chip chip-new">${posted}</span>`,
      DM.apply.canAutofill(job.ats) && '<span class="chip chip-auto">⚡ מילוי אוטומטי</span>',
      job.ats === 'workday' && '<span class="chip chip-lock">🔐 Workday</span>',
    ].filter(Boolean).join('');
    const ribbon = ACTION_RIBBON[card.user_action];
    let body;
    if (a) {
      const sel = selectedCv(card);
      const scores = (a.cv_scores || []).slice().sort((x, y) => y.score - x.score);
      const selScore = (scores.find(s => s.cv_id === sel) || {}).score;
      const reqs = a.requirements || [];
      const hard = reqs.some(r => r.status === 'missing' && r.importance === 'must');
      const compare = scores.length > 1 ? `<button type="button" class="link-btn" data-act="cmp" aria-expanded="false">השוואת גרסאות</button>` : '';
      const dl = `<button type="button" class="cv-dl" data-act="dl-cv" title="הורדת הגרסה הזו"${hasCvFile(sel) ? '' : ' hidden'}>⬇️ הורדה</button>`;
      const alt = a.compare ? `<p class="dm-alt">🧪 ${esc(MODEL_NAME[a.compare.model] || a.compare.model)}: <b>${esc(a.compare.match_score)}</b>${a.compare.fit_summary_he ? ` · ${esc(a.compare.fit_summary_he)}` : ''}</p>` : '';
      body = `${alt}
        <div class="dm-cv"><div class="dm-cv-row"><span class="dm-cv-ico" aria-hidden="true">📄</span><div class="dm-cv-main"><div class="dm-cv-k">${sel === card.best_cv_id ? 'מומלץ להגיש עם' : 'נבחר להגשה'}</div><div class="dm-cv-v"><strong>${esc(cvLabel(card, sel))}</strong>${selScore != null ? ` · התאמה ${selScore}` : ''}</div></div>${dl}${compare}</div>
          ${a.cv_choice_reason_he ? `<p class="dm-cv-reason">${esc(a.cv_choice_reason_he)}</p>` : ''}
          <div class="dm-cv-cmp" hidden>${scores.map(s => `<label class="dm-cv-opt"><input type="radio" name="cv-${card.id}" value="${esc(s.cv_id)}"${s.cv_id === sel ? ' checked' : ''}><span>${esc(s.label)}${s.cv_id === card.best_cv_id ? '<em>מומלץ</em>' : ''}</span><span class="bar"><i style="width:${Math.max(0, Math.min(100, s.score))}%"></i></span><b>${s.score}</b></label>`).join('')}</div></div>
        ${a.fit_summary_he ? `<section><h3 class="dm-sec-h">🤖 ניתוח ההתאמה</h3><p class="dm-ai">${esc(a.fit_summary_he)}</p></section>` : ''}
        ${reqs.length ? `<section><div class="dm-sec-row"><h3 class="dm-sec-h">דרישות התפקיד</h3><span class="req-sum">${reqSummary(reqs)}</span></div><ul class="reqs">${reqs.map(r => `<li class="req req--${esc(r.status)}${r.status === 'missing' && r.importance === 'must' ? ' req--hard' : ''}"><span class="req-ico" aria-hidden="true">${(STATUS_ICON[r.status] || ['?'])[0]}</span><span class="sr">${(STATUS_ICON[r.status] || ['', ''])[1]}:</span><bdi dir="ltr" class="req-t">${esc(r.text)}</bdi><span class="req-imp req-imp--${r.importance === 'must' ? 'must' : 'nice'}">${r.importance === 'must' ? 'חובה' : 'יתרון'}</span></li>`).join('')}</ul></section>` : ''}
        ${a.top_gap_he ? `<div class="dm-gap${hard ? ' is-hard' : ''}"><b>${hard ? '⚠️' : '💡'} הפער המרכזי:</b> ${esc(a.top_gap_he)}</div>` : ''}
        ${whyHtml(a)}`;
    } else {
      body = `<p class="dm-muted">הניתוח המעמיק לא הושלם למשרה הזו. היא כאן כי היא קרובה מאוד לקורות החיים שלך.</p>`;
    }
    return `<div class="dm-slide" role="group" aria-roledescription="כרטיס" aria-label="משרה ${i + 1} מתוך ${n}" data-i="${i}">
      <article class="dm-card">
        ${ribbon ? `<span class="dm-status ${ribbon[1]}">${ribbon[0]}</span>` : ''}
        <div class="dm-head">${ring(score)}<div class="dm-info"><h2 class="dm-jt"><bdi dir="ltr">${esc(job.title)}</bdi></h2><p class="dm-co"><bdi dir="ltr">${esc(job.company)}</bdi></p><p class="dm-meta"><span class="verdict-badge ${vc}">${vl}</span></p></div></div>
        ${chips ? `<div class="dm-chips">${chips}</div>` : ''}
        ${body}
        <div><button type="button" class="link-btn" data-act="jd" aria-expanded="false">תיאור המשרה ▾</button><div class="dm-jd-body" hidden><p dir="auto">${esc(job.excerpt || '')}</p><button type="button" class="link-btn" data-act="open-job">פתיחת המשרה באתר ↗</button></div></div>
      </article></div>`;
  }

  function deckSummary() {
    const strong = state.cards.filter(c => c.tier !== 'maybe').length;
    const maybe = state.cards.length - strong;
    const parts = [`${strong} התאמות חזקות`];
    if (maybe) parts.push(`${maybe} שווה הצצה`);
    const run = state.run || {};
    if (run.candidates) parts.push(`מתוך ${fmtInt(run.candidates)} משרות חדשות שנבדקו`);
    return parts.join(' · ');
  }

  function deck() {
    const n = state.cards.length;
    return `<div class="dm" tabindex="-1">
      <header class="dm-top"><div><h1 class="dm-title">✨ ההתאמות שלך${state.readOnly ? ' (הניסיון החינמי)' : ' להיום'}</h1><div class="dm-date">${esc(deckSummary())}${isAdmin() && !state.readOnly ? ' · <button type="button" class="link-btn dm-admin" data-act="rebuild">🔁 בנייה מחדש</button>' : ''}</div></div>
        <div class="dm-nav"><button type="button" class="icon-btn" data-act="library" aria-label="גרסאות קורות החיים" title="גרסאות קורות החיים">📄</button><button type="button" class="icon-btn" data-act="prev" aria-label="המשרה הקודמת">→</button><span class="dm-count" id="dmCount" dir="ltr" aria-live="polite"></span><button type="button" class="icon-btn" data-act="next" aria-label="המשרה הבאה">←</button></div></header>
      <div class="dm-progress" aria-hidden="true">${state.cards.map(() => '<span class="dm-seg"></span>').join('')}</div>
      <div class="dm-track" id="dmTrack" role="region" aria-roledescription="קרוסלה" aria-label="משרות שהותאמו לך">${state.cards.map((c, i) => cardHtml(c, i, n)).join('')}</div>
      <div class="dm-toast" id="dmToast" role="status"></div>
      <div class="dm-actions"><button type="button" class="apply-btn" data-act="apply"><span class="apply-main">🚀 הגשת מועמדות</span><span class="apply-sub" id="applySub"></span></button>
        <button type="button" class="round-btn" data-act="save" aria-label="שמירה (S)" title="שמירה (S)">🔖</button>
        <button type="button" class="round-btn" data-act="skip" aria-label="דילוג (X)" title="דילוג (X)">✕</button></div>
    </div>`;
  }

  function applyView() {
    const ap = state.applying || {};
    const card = ap.card || {};
    const job = card.job || {};
    const label = cvLabel(card, ap.cvId);
    const head = `<div class="ap-job">${ring(card.match_score, true)}<div class="dm-info"><h2 class="dm-jt"><bdi dir="ltr">${esc(job.title)}</bdi></h2><p class="dm-co"><bdi dir="ltr">${esc(job.company)}</bdi> · מגישים עם ${esc(label)}</p></div></div>`;
    const done = `<div class="dm-stack"><button type="button" class="btn btn-primary" data-act="applied">✓ הגשתי. סימון ומעבר למשרה הבאה</button>${back('back-deck', 'חזרה לחפיסה')}</div>`;
    const rule = `<p class="ap-rule">🛑 התוסף אף פעם לא לוחץ Submit בשבילך, לא יוצר חשבונות ולא ממציא תשובות.</p>`;
    if (ap.mode === 'opening') {
      return `<div class="dm-body ap">${head}<div class="ap-box"><p class="dm-muted">פותחים את טופס ההגשה…</p></div></div>`;
    }
    if (ap.mode === 'autofill') {
      const r = ap.result || {};
      const items = [
        ['is-done', 'טופס ההגשה נפתח בלשונית הסמוכה'],
        r.attached ? ['is-done', `צירפנו את ${r.fileName}`] : ['is-info', 'לא צירפנו קובץ: לגרסה הזו אין קובץ שמור. אפשר להוסיף אותו בספריית הקו״ח (📄 בראש החפיסה).'],
        r.filled && r.filled.length ? ['is-done', `מולאו ${r.filled.length} שדות: ${r.filled.join(', ')}`] : null,
        r.left && r.left.length ? ['is-info', `נשארו לך: ${r.left.join(', ')}. אנחנו לא ממציאים תשובות.`] : null,
        ['is-you', 'עבר/י על הטופס ולחץ/י Submit בעצמך'],
      ].filter(Boolean);
      return `<div class="dm-body ap">${head}<div class="ap-box"><h3 class="ap-h">⚡ מילוי אוטומטי ב-${esc(ATS_NAME[job.ats] || 'טופס ההגשה')}</h3><ol class="ap-list">${items.map(([cls, t]) => `<li class="ap-i ${cls}">${esc(t)}</li>`).join('')}</ol></div>${rule}${done}</div>`;
    }
    const signin = ap.mode === 'signin';
    const title = signin ? '🔐 Workday דורש חשבון באתר החברה' : `📎 הכל מוכן להגשה ב-${esc(ATS_NAME[job.ats] || 'אתר החברה')}`;
    const note = signin
      ? 'אנחנו לא יוצרים חשבונות ולא מזינים סיסמאות. אחרי שתתחבר/י בעצמך, הכל מוכן כאן:'
      : !DM.apply.canAutofill(job.ats)
        ? 'מילוי אוטומטי לאתר הזה עדיין לא זמין. בינתיים: גרור/י את הקובץ לטופס והעתק/י את הפרטים.'
        : ap.reason === 'form_not_found' ? 'לא מצאנו את טופס ההגשה בעמוד (אולי צריך ללחוץ שם קודם על Apply). בינתיים:'
          : ap.reason ? 'המילוי האוטומטי לא הצליח בעמוד הזה. בינתיים:'
            : 'כדי למלא אוטומטית צריך קודם לאשר את הפרטים למילוי טפסים. בינתיים:';
    const profile = ap.profile || {};
    const rows = [['שם מלא', profile.fullName], ['אימייל', profile.email], ['טלפון', profile.phone], ['LinkedIn', profile.linkedin]]
      .filter(([, v]) => v).map(([k, v]) => `<div class="cp-row"><span class="cp-k">${k}</span><bdi dir="ltr" class="cp-v">${esc(v)}</bdi><button type="button" class="cp-btn" data-act="copy" data-copy="${esc(v)}">העתקה</button></div>`).join('');
    const dl = ap.hasFile ? `<button type="button" class="dl-btn" data-act="download">⬇️ הורדת ${esc(label)}</button>` : '<div class="dm-nofile"><p class="dm-fine">לגרסה הזו אין עדיין קובץ להורדה.</p><button type="button" class="btn btn-secondary" data-act="library">📄 הוספת קובץ בספריית הקו״ח</button></div>';
    return `<div class="dm-body ap">${head}<div class="ap-box"><h3 class="ap-h">${title}</h3><p class="ap-p">${note}</p>${dl}${rows ? `<div class="cp">${rows}</div>` : '<button type="button" class="link-btn" data-act="profile">הוספת פרטים להעתקה</button>'}</div>${rule}${done}</div>`;
  }

  function end() {
    const count = k => state.cards.filter(c => c.user_action === k).length;
    const saved = state.cards.filter(c => c.user_action === 'saved');
    return `${topBar('🎉 סיימת את החפיסה של היום')}<div class="dm-body en">
      <div class="en-stats"><div class="en-stat"><b>${count('applied')}</b><span>הוגשו</span></div><div class="en-stat"><b>${count('saved')}</b><span>נשמרו</span></div><div class="en-stat"><b>${count('skipped')}</b><span>דולגו</span></div></div>
      <p class="en-next">${state.readOnly ? 'זו הייתה החפיסה החינמית. מנויים מקבלים חפיסה חדשה בכל יום.' : 'החפיסה הבאה תהיה זמינה מחר, מחצות (שעון ישראל).'}</p>
      <div class="dm-card-plain"><h2 class="dm-h2">🔖 נשמרו היום</h2>${saved.length ? saved.map(c => `<div class="en-row"><bdi dir="ltr">${esc(c.job.title)}</bdi><span>${c.match_score == null ? '' : c.match_score}</span></div>`).join('') : '<p class="dm-muted">עוד לא שמרת משרות.</p>'}
        <button type="button" class="link-btn" data-act="saved">כל המשרות השמורות</button></div>
      ${back('restart-deck', 'חזרה לחפיסה')}
      ${state.readOnly ? '<button type="button" class="btn btn-primary" data-act="buy">שדרוג למנוי</button>' : ''}</div>`;
  }

  // A finished run with no cards: nothing new in the person's fields, or
  // nothing new that scored 60.
  function quiet() {
    const run = state.run || {};
    const analyzed = run.candidates || 0;
    const head = analyzed
      ? ['היום אין התאמות חזקות', `בדקנו לעומק ${fmtInt(analyzed)} משרות חדשות בתחומים שלך, ואף אחת לא הגיעה לציון 60. עדיף לא להציג אותן מאשר לשלוח אותך להגיש למשרות שלא באמת מתאימות.`]
      : ['אין משרות חדשות בתחומים שלך', 'מאז החפיסה הקודמת לא נכנסו למאגר משרות חדשות בתחומים שבחרת.'];
    return `${topBar('✨ ההתאמות היומיות שלך')}<div class="dm-body">
      <div class="dm-card-plain"><div class="dm-big" aria-hidden="true">🌤️</div><h2 class="dm-h2">${head[0]}</h2><p class="dm-muted">${head[1]}</p>
        <p class="dm-fine">המאגר מתעדכן כל בוקר ב-6:00. אפשר גם להרחיב את התחומים או להוסיף גרסת קו״ח.</p></div>
      <div class="dm-stack"><button type="button" class="btn ${analyzed ? 'btn-primary' : 'btn-secondary'}" data-act="library">עריכת התחומים והגרסאות</button>
        ${analyzed ? '' : '<button type="button" class="btn btn-primary" data-act="build">חיפוש מחדש</button>'}
        ${analyzed && isAdmin() ? '<button type="button" class="btn btn-secondary" data-act="rebuild">🔁 בנייה מחדש (מנהלת)</button>' : ''}</div>
      <button type="button" class="link-btn dm-link" data-act="saved">משרות שמורות</button></div>`;
  }

  function savedView() {
    const rows = state.saved.map(c => `<div class="saved-row"><div class="saved-main"><bdi dir="ltr" class="saved-title">${esc(c.job.title)}</bdi><span class="dm-muted"><bdi dir="ltr">${esc(c.job.company)}</bdi> · ${esc(c.match_day || '')}</span></div><span class="saved-score">${c.match_score == null ? '' : c.match_score}</span><button type="button" class="link-btn" data-act="open-saved" data-url="${esc(c.job.apply_url || c.job.url)}">פתיחה ↗</button></div>`).join('');
    return `${topBar('🔖 משרות שמורות')}<div class="dm-body">${rows || '<p class="dm-muted">אין עדיין משרות שמורות.</p>'}${back()}</div>`;
  }

  function paywall() {
    const s = state.status || {};
    const limit = s.reason === 'trial_limit';
    return `<div class="dm-body pw"><div class="dm-big" aria-hidden="true">🔒</div>
      <h1 class="dm-h">ההתאמות היומיות שמורות למנויים</h1>
      <p class="dm-muted">${limit ? 'הניסיונות החינמיים מוגבלים כרגע מהרשת שלך או להיום.' : 'ההרצה החינמית שלך כבר נוצלה.'} מנויים מקבלים חפיסה חדשה בכל יום.</p>
      <ul class="pw-list"><li>✓ כל יום: המשרות החדשות בתחומים שלך, עד ${MAX_ANALYZED} מנותחות לעומק</li><li>✓ רק התאמות אמיתיות: ציון, דרישות ופערים לכל משרה</li><li>✓ המלצה איזו גרסת קו״ח להגיש, מוכנה להורדה</li><li>✓ מילוי אוטומטי בטפסים נתמכים</li></ul>
      <button type="button" class="btn btn-primary" data-act="buy">שדרוג למנוי</button>
      <button type="button" class="btn btn-secondary" data-act="have-key">יש לי מפתח מנוי</button>
      <p class="dm-fine">מפתח Claude אישי מכסה קריאות AI. ההתאמות היומיות נשענות על מאגר המשרות שלנו, ולכן הן חלק מהמנוי.</p>
      ${s.last_run ? '<button type="button" class="link-btn" data-act="last-deck">לצפייה בחפיסה החינמית שלך</button>' : ''}</div>`;
  }

  function library() {
    const rows = state.cvs.map(v => {
      const file = v.source === 'main'
        ? (v.hasFile ? `מההגדרות · ⬇️ ${esc(v.fileName || 'קובץ')} להורדה` : 'מההגדרות · אין קובץ להורדה')
        : `${esc(v.fileName || '')}${v.hasFile ? ' · ⬇️ להורדה' : ''}`;
      const attach = v.source === 'main' && !v.hasFile && !v.needsExtraction
        ? '<label class="link-btn lib-attach">צירוף קובץ PDF/DOCX להורדה<input type="file" id="mainFile" accept=".pdf,.docx" hidden></label>' : '';
      return `<li class="lib-row"><input class="lib-label" data-id="${esc(v.id)}" value="${esc(v.label)}" maxlength="60" aria-label="שם הגרסה">
      ${v.source === 'main' ? '' : `<button type="button" class="link-btn lib-del" data-act="remove-cv" data-id="${esc(v.id)}">הסרה</button>`}
      <span class="dm-fine lib-file">${file}</span>${attach}
      <div class="lib-focus"><span class="lib-k">תחומים שהגרסה מכוונת אליהם:</span>${focusChips(v, true)}</div></li>`;
    }).join('');
    const full = state.cvs.length >= DM.cvLibrary.MAX_VERSIONS;
    const newChips = DM.cvLibrary.CATEGORIES.map(c => {
      const on = state.newFocus.includes(c);
      return `<button type="button" class="fchip${on ? ' is-on' : ''}" data-act="toggle-new-focus" data-cat="${esc(c)}" aria-pressed="${on}"><bdi dir="ltr">${esc(c)}</bdi></button>`;
    }).join('');
    return `${topBar('📄 גרסאות קורות החיים')}<div class="dm-body">
      <p class="dm-muted">אפשר להעלות גרסה לכל כיוון שמעניין אותך. לפי התחומים של כל גרסה נחפש משרות, ולכל משרה נמליץ על הגרסה המתאימה ונכין אותה להורדה.</p>
      <ul class="lib-list">${rows || '<li class="dm-muted">אין עדיין קורות חיים.</li>'}</ul>
      <p class="dm-error" id="libFileError" role="alert"></p>
      <div class="dm-card-plain"><h2 class="dm-h2">➕ הוספת גרסה</h2>
        ${full ? `<p class="dm-muted">הגעת למקסימום של ${DM.cvLibrary.MAX_VERSIONS} גרסאות.</p>` : `<label class="fld"><span>שם הגרסה (למשל Full Stack + LLM)</span><input id="libNewLabel" maxlength="60"></label>
        <label class="fld"><span>קובץ PDF, DOCX או TXT</span><input id="libNewFile" type="file" accept=".pdf,.docx,.txt"></label>
        <div class="lib-focus"><span class="lib-k">תחומים (אפשר לבחור כמה; בלי בחירה נזהה מתוך הקובץ):</span><div class="fchips">${newChips}</div></div>
        <button type="button" class="btn btn-primary" data-act="add-cv">הוספה</button>`}
        <p class="dm-error" id="libError" role="alert"></p></div>
      ${back()}</div>`;
  }

  function profile() {
    const p = state.profileDraft || {};
    const field = (key, label, type = 'text', dir = 'ltr') => `<label class="fld"><span>${label}</span><input data-field="${key}" type="${type}" dir="${dir}" value="${esc(p[key] || '')}" maxlength="200"></label>`;
    return `${topBar('📝 פרטים למילוי טפסים')}<div class="dm-body">
      <p class="dm-muted">אלה הפרטים שהתוסף ממלא בטפסים נתמכים. הם נשמרים רק בדפדפן שלך. שדה ריק נשאר ריק בטופס.</p>
      ${field('fullName', 'שם מלא', 'text', 'auto')}${field('email', 'אימייל', 'email')}${field('phone', 'טלפון', 'tel')}
      ${field('location', 'מיקום נוכחי (עיר)', 'text', 'auto')}${field('company', 'חברה נוכחית', 'text', 'auto')}${field('linkedin', 'LinkedIn', 'url')}
      <div class="dm-stack"><button type="button" class="btn btn-primary" data-act="save-profile">${state.pendingApply ? 'שמירה והמשך להגשה' : 'שמירה'}</button>${back()}</div></div>`;
  }

  // ── deck mechanics ──────────────────────────────────────────────────────────
  function afterDeckRender() {
    const track = document.getElementById('dmTrack');
    if (!track) return;
    let raf = 0;
    track.addEventListener('scroll', () => {
      if (raf) return;
      raf = (root.requestAnimationFrame || setTimeout)(() => {
        raf = 0;
        const left = track.getBoundingClientRect().left;
        let best = state.idx, bd = Infinity;
        track.querySelectorAll('.dm-slide').forEach((s, i) => {
          const d = Math.abs(s.getBoundingClientRect().left - left);
          if (d < bd) { bd = d; best = i; }
        });
        if (best !== state.idx && bd !== Infinity) { state.idx = best; updateDeckChrome(); }
      });
    });
    goTo(state.idx, false);
    const dm = document.querySelector('.dm');
    if (dm && dm.focus) dm.focus({ preventScroll: true });
  }

  function goTo(i, smooth = true) {
    if (i >= state.cards.length) { setView('end'); return; }
    i = Math.max(0, i);
    const track = document.getElementById('dmTrack');
    const slide = track && track.querySelectorAll('.dm-slide')[i];
    if (slide && track.scrollBy) {
      const d = slide.getBoundingClientRect().left - track.getBoundingClientRect().left;
      track.scrollBy({ left: d, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
    }
    state.idx = i;
    updateDeckChrome();
  }

  function updateDeckChrome() {
    const card = state.cards[state.idx];
    const count = document.getElementById('dmCount');
    if (count) count.textContent = `${state.idx + 1} / ${state.cards.length}`;
    document.querySelectorAll('.dm-seg').forEach((seg, i) => {
      const a = state.cards[i] && state.cards[i].user_action;
      seg.className = 'dm-seg' + (i === state.idx ? ' is-current' : ACTED.has(a) ? ` is-${a}` : '');
    });
    document.querySelectorAll('.dm-slide').forEach((slide, i) => {
      const a = state.cards[i] && state.cards[i].user_action;
      const art = slide.querySelector('.dm-card');
      let rib = art.querySelector('.dm-status');
      if (ACTION_RIBBON[a]) {
        if (!rib) { rib = document.createElement('span'); art.prepend(rib); }
        rib.className = 'dm-status ' + ACTION_RIBBON[a][1];
        rib.textContent = ACTION_RIBBON[a][0];
      } else if (rib) {
        rib.remove();
      }
    });
    const saveBtn = document.querySelector('[data-act="save"]');
    if (saveBtn && card) saveBtn.classList.toggle('is-on', card.user_action === 'saved');
    if (card) {
      applySubLabel(card).then(t => { const el = document.getElementById('applySub'); if (el) el.textContent = t; });
      if (!card.user_action) {
        card.user_action = 'viewed';
        DM.api.action(card.id, 'viewed').catch(() => {});
      }
    }
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = document.getElementById('dmToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 1900);
  }

  async function act(kind) {
    const card = state.cards[state.idx];
    if (!card) return;
    const undo = card.user_action === kind;
    card.user_action = undo ? 'viewed' : kind;
    updateDeckChrome();
    toast(undo ? 'בוטל' : kind === 'saved' ? 'נשמר. לא יופיע בחפיסות הבאות.' : 'דילגנו. לא נציג אותה שוב.');
    try { await DM.api.action(card.id, undo ? 'clear' : kind); } catch (_) { toast('הפעולה לא נשמרה. נסה/י שוב.'); return; }
    if (!undo) setTimeout(() => { if (state.view === 'deck') goTo(state.idx + 1); }, reduced() ? 150 : 600);
  }

  // ── flows ───────────────────────────────────────────────────────────────────
  function showError(err) {
    state.error = err;
    setView('error');
  }

  function handleRunError(ev) {
    const message = ev.message || '';
    const code = ev.code || (root.JMA_Auth ? root.JMA_Auth.errorCode(message) : '');
    const text = root.JMA_Auth ? root.JMA_Auth.friendly(message) : message;
    if (code === 'LICENSE_REQUIRED') return refresh();
    if (code === 'DM_DISABLED') return setView('disabled');
    if (code === 'DM_POOL_EMPTY' || code === 'DM_POOL_PREPARING' || code === 'DM_NOT_READY') {
      return showError({ title: 'המאגר של היום עדיין לא מוכן', message: text, retry: 'reload' });
    }
    return showError({ code, title: 'לא הצלחנו לבנות את החפיסה', message: text, retry: code === 'DM_NO_CV' ? null : 'build' });
  }

  async function build() {
    if (state.busy) return;
    const payload = await DM.cvLibrary.runPayload();
    if (!payload.cvs.length) return setView('nocv');
    state.busy = true;
    const pool = state.status && state.status.pool;
    state.build = { s1: 'active', s1text: pool && pool.fresh ? `${fmtInt(pool.fresh)} משרות חדשות במאגר מ-3 הימים האחרונים` : '', s2: 'wait', done: 0, total: 0, s3: 'wait' };
    setView('building');
    let terminal = null;
    try {
      await DM.api.run(payload, ev => {
        const b = state.build;
        if (ev.type === 'cv_text') DM.cvLibrary.cacheExtracted(ev.cv_id, ev.text).catch(() => {});
        else if (ev.type === 'cv_ready') b.s1text = 'קורות החיים מוכנים · מחפשים';
        else if (ev.type === 'candidates') {
          const fresh = ev.fresh != null ? ev.fresh : ev.candidates;
          const s1text = !fresh ? 'אין משרות חדשות בתחומים שלך מאז החפיסה הקודמת'
            : fresh > ev.candidates ? `✓ ${fmtInt(fresh)} משרות חדשות בתחומים שלך · מנתחים את ${ev.candidates} הקרובות ביותר`
              : `✓ ${fmtInt(fresh)} משרות חדשות בתחומים שלך`;
          Object.assign(b, { s1: 'done', s1text, s2: ev.candidates ? 'active' : 'done', total: ev.candidates });
        } else if (ev.type === 'progress') {
          Object.assign(b, { done: ev.done, total: ev.total, s2text: `הושלמו ${ev.done} מתוך ${ev.total} ניתוחים` });
        } else if (ev.type === 'done') {
          const s3text = ev.count ? `✓ ${ev.count} משרות בחפיסה` : 'אין היום משרות עם ציון 60 ומעלה';
          Object.assign(b, { s2: 'done', s3: 'done', s3text, title: 'החפיסה מוכנה' });
        }
        if (['done', 'already', 'error'].includes(ev.type)) terminal = ev;
        if (state.view === 'building') render();
      });
    } catch (e) {
      terminal = terminal || { type: 'error', message: e.message };
    } finally {
      state.busy = false;
    }
    if (!terminal) terminal = { type: 'error', message: 'החיבור לשרת נקטע. אפשר לנסות שוב.' };
    if (terminal.type === 'done' || (terminal.type === 'already' && terminal.status === 'done')) {
      return loadDeck(false);
    }
    if (terminal.type === 'already') return pollRunning();
    return handleRunError(terminal);
  }

  async function loadDeck(latest) {
    let data;
    try { data = await DM.api.today(latest); } catch (e) {
      return showError({ title: 'לא הצלחנו לטעון את החפיסה', message: root.JMA_Auth ? root.JMA_Auth.friendly(e.message) : e.message, retry: 'reload' });
    }
    state.run = data.run;
    state.cards = data.cards || [];
    state.readOnly = data.entitlement === 'locked';
    if (!state.cards.length) {
      if (latest) return setView('paywall');
      return setView(data.run && data.run.status === 'done' ? 'quiet' : 'ready');
    }
    const firstOpen = state.cards.findIndex(c => !ACTED.has(c.user_action));
    if (firstOpen === -1) return setView('end');
    state.idx = firstOpen;
    setView('deck');
  }

  async function pollRunning() {
    state.build = { s1: 'done', s1text: 'החפיסה נבנית ברקע', s2: 'active', s2text: 'ממשיכים מאיפה שעצרנו…', done: 0, total: 0, s3: 'wait' };
    setView('building');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (state.view !== 'building') return;
      let data;
      try { data = await DM.api.today(false); } catch (_) { continue; }
      const st = data.run && data.run.status;
      if (st === 'done') return loadDeck(false);
      if (st === 'failed') { state.notice = 'הבנייה הקודמת לא הושלמה ולא נספרה. אפשר לנסות שוב.'; return refresh(); }
    }
    return showError({ title: 'הבנייה לוקחת יותר מהרגיל', message: 'אפשר לנסות לטעון שוב בעוד דקה.', retry: 'reload' });
  }

  async function refresh() {
    try {
      state.status = await DM.api.status();
    } catch (e) {
      return showError({ title: 'אין חיבור לשרת', message: root.JMA_Auth ? root.JMA_Auth.friendly(e.message) : e.message, retry: 'reload' });
    }
    state.cvs = await DM.cvLibrary.list();
    state.level = await DM.cvLibrary.getLevel();
    const s = state.status;
    if (!s || s.enabled === false) return setView('disabled');
    if (s.error) return showError({ title: 'לא הצלחנו לאמת את המנוי', message: root.JMA_Auth ? root.JMA_Auth.friendly(s.error) : s.error, retry: 'reload' });
    const today = s.today;
    if (today && today.status === 'done') return loadDeck(false);
    if (today && today.status === 'running') return pollRunning();
    if (s.entitlement === 'locked') return setView('paywall');
    if (!state.cvs.length) return setView('nocv');
    setView('ready');
    return maybeAutoStart();
  }

  async function maybeAutoStart() {
    const ui = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
    if (ui.autoStartAt && Date.now() - ui.autoStartAt < AUTOSTART_MS) {
      await chrome.storage.local.set({ [UI_KEY]: { ...ui, autoStartAt: 0 } });
      if (state.view === 'ready') build();
    }
  }

  async function startApply() {
    const card = state.cards[state.idx];
    if (!card) return;
    const cvId = selectedCv(card);
    if (card.job && DM.apply.canAutofill(card.job.ats) && !(await DM.apply.getProfile())) {
      state.pendingApply = true;
      return openProfile();
    }
    state.applying = { card, cvId, mode: 'opening' };
    setView('apply');
    let info;
    try { info = await DM.apply.open(card, cvId); } catch (_) { info = { mode: 'manual' }; }
    const profileData = (await DM.apply.getProfile()) || (await DM.apply.suggestProfile());
    const file = await DM.cvLibrary.getFile(cvId);
    state.applying = { card, cvId, ...info, profile: profileData, hasFile: !!file };
    if (state.view === 'apply') render();
  }

  async function openProfile() {
    state.profileDraft = (await DM.apply.getProfile()) || (await DM.apply.suggestProfile());
    state.prevView = state.view === 'profile' ? state.prevView : state.view;
    setView('profile');
  }

  async function openLibrary() {
    state.cvs = await DM.cvLibrary.list();
    state.prevView = state.view === 'library' ? state.prevView : state.view;
    setView('library');
  }

  function goBack() {
    const to = state.prevView || 'ready';
    state.prevView = null;
    if (to === 'deck' && state.cards.length) return setView('deck');
    if (to === 'end') return setView('end');
    return refresh();
  }

  // ── events ──────────────────────────────────────────────────────────────────
  async function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const actName = btn.dataset.act;
    const card = state.cards[state.idx];
    switch (actName) {
      case 'build': return build();
      case 'reload': state.notice = ''; return refresh();
      case 'prev': return goTo(state.idx - 1);
      case 'next': return goTo(state.idx + 1);
      case 'save': return act('saved');
      case 'skip': return act('skipped');
      case 'apply': return startApply();
      case 'cmp': {
        const box = btn.closest('.dm-cv').querySelector('.dm-cv-cmp');
        box.hidden = !box.hidden;
        btn.setAttribute('aria-expanded', String(!box.hidden));
        btn.textContent = box.hidden ? 'השוואת גרסאות' : 'סגירה';
        return undefined;
      }
      case 'jd': {
        const body = btn.nextElementSibling;
        body.hidden = !body.hidden;
        btn.setAttribute('aria-expanded', String(!body.hidden));
        btn.textContent = body.hidden ? 'תיאור המשרה ▾' : 'הסתרת התיאור ▴';
        return undefined;
      }
      case 'why': {
        const body = btn.nextElementSibling;
        body.hidden = !body.hidden;
        btn.setAttribute('aria-expanded', String(!body.hidden));
        btn.textContent = body.hidden ? '🧮 איך חושב הציון ▾' : '🧮 הסתרת החישוב ▴';
        return undefined;
      }
      case 'rebuild': {
        // Admins only (the server refuses everyone else): analyzes today's jobs again.
        const sure = typeof root.confirm === 'function'
          ? root.confirm('לבנות מחדש את החפיסה של היום? כל המשרות של היום ינותחו שוב (כ-$0.09).') : true;
        return sure ? build() : undefined;
      }
      case 'open-job': return card && chrome.tabs.create({ url: card.job.url });
      case 'open-saved': return chrome.tabs.create({ url: btn.dataset.url });
      case 'applied': {
        const c = state.applying && state.applying.card;
        if (!c) return setView('deck');
        c.user_action = 'applied';
        DM.api.action(c.id, 'applied').catch(() => {});
        state.idx = state.cards.indexOf(c);
        setView('deck');
        toast('סומן כהוגש. לא יופיע בחפיסות הבאות.');
        return setTimeout(() => { if (state.view === 'deck') goTo(state.idx + 1); }, reduced() ? 150 : 700);
      }
      case 'back-deck': return setView('deck');
      case 'restart-deck': state.idx = 0; return setView('deck');
      case 'download': {
        const ok = await DM.apply.downloadCv(state.applying.cvId).catch(() => false);
        btn.textContent = ok ? '✓ הקובץ ירד לתיקיית ההורדות' : 'ההורדה נכשלה';
        return undefined;
      }
      case 'dl-cv': {
        if (!card) return undefined;
        const ok = await DM.apply.downloadCv(selectedCv(card)).catch(() => false);
        btn.textContent = ok ? '✓ ירד' : 'נכשל';
        return setTimeout(() => { btn.textContent = '⬇️ הורדה'; }, 1800);
      }
      case 'toggle-focus': {
        // In place, so a half-typed new version below isn't wiped by a re-render.
        const v = state.cvs.find(x => x.id === btn.dataset.id);
        if (!v) return undefined;
        const current = DM.cvLibrary.effectiveFocus(v);
        const cat = btn.dataset.cat;
        const next = current.includes(cat) ? current.filter(c => c !== cat) : current.concat(cat);
        await DM.cvLibrary.setFocus(v.id, next);
        v.focus = DM.cvLibrary.CATEGORIES.filter(c => next.includes(c));
        btn.closest('.fchips').querySelectorAll('.fchip').forEach(b => {
          const on = DM.cvLibrary.effectiveFocus(v).includes(b.dataset.cat);
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        const hint = btn.closest('.lib-focus').querySelector('.dm-fine');
        if (hint && v.focus.length) hint.remove();
        return undefined;
      }
      case 'toggle-new-focus': {
        const cat = btn.dataset.cat;
        state.newFocus = state.newFocus.includes(cat) ? state.newFocus.filter(c => c !== cat) : state.newFocus.concat(cat);
        const on = state.newFocus.includes(cat);
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', String(on));
        return undefined;
      }
      case 'set-level': {
        const level = btn.dataset.level === state.level ? null : btn.dataset.level;
        await DM.cvLibrary.setLevel(level);
        state.level = level;
        return render();
      }
      case 'copy': {
        const done = () => { btn.textContent = 'הועתק'; setTimeout(() => { btn.textContent = 'העתקה'; }, 1400); };
        try { await navigator.clipboard.writeText(btn.dataset.copy); } catch (_) { /* clipboard refused */ }
        return done();
      }
      case 'buy': return chrome.tabs.create({ url: root.JMA_Auth ? root.JMA_Auth.GUMROAD_URL : 'https://expertdevai.gumroad.com/l/job-match-ai' });
      case 'have-key': return chrome.tabs.create({ url: chrome.runtime.getURL('popup.html#keys') });
      case 'last-deck': return loadDeck(true);
      case 'saved': {
        try { state.saved = (await DM.api.saved()).cards || []; } catch (_) { state.saved = []; }
        state.prevView = state.view;
        return setView('saved');
      }
      case 'library': return openLibrary();
      case 'profile': return openProfile();
      case 'back': return goBack();
      case 'remove-cv': {
        try { await DM.cvLibrary.remove(btn.dataset.id); } catch (err) { $('#libError').textContent = err.message; return undefined; }
        return openLibrary();
      }
      case 'add-cv': {
        const fileInput = $('#libNewFile');
        const errEl = $('#libError');
        const file = fileInput && fileInput.files && fileInput.files[0];
        if (!file) { errEl.textContent = 'בחר/י קובץ קודם.'; return undefined; }
        btn.disabled = true;
        btn.textContent = /\.pdf$/i.test(file.name) ? 'קוראים את ה-PDF…' : 'מוסיפים…';
        try {
          await DM.cvLibrary.add(file, $('#libNewLabel').value, state.newFocus);
        } catch (err) {
          errEl.textContent = root.JMA_Auth ? root.JMA_Auth.friendly(err.message) : err.message;
          btn.disabled = false;
          btn.textContent = 'הוספה';
          return undefined;
        }
        state.newFocus = [];
        return openLibrary();
      }
      case 'save-profile': {
        const draft = {};
        document.querySelectorAll('[data-field]').forEach(inp => { draft[inp.dataset.field] = inp.value; });
        await DM.apply.saveProfile(draft);
        if (state.pendingApply) {
          state.pendingApply = false;
          state.prevView = null;
          setView('deck');
          return startApply();
        }
        return goBack();
      }
      default: return undefined;
    }
  }

  async function onChange(e) {
    const t = e.target;
    if (t.type === 'radio' && t.name && t.name.startsWith('cv-')) {
      const card = state.cards[state.idx];
      if (!card) return;
      state.cvSel[card.id] = t.value;
      const strip = t.closest('.dm-cv');
      const score = ((card.analysis && card.analysis.cv_scores) || []).find(s => s.cv_id === t.value);
      strip.querySelector('.dm-cv-k').textContent = t.value === card.best_cv_id ? 'מומלץ להגיש עם' : 'נבחר להגשה';
      strip.querySelector('.dm-cv-v').innerHTML = `<strong>${esc(cvLabel(card, t.value))}</strong>${score ? ` · התאמה ${score.score}` : ''}`;
      strip.querySelector('.cv-dl').hidden = !hasCvFile(t.value);
      updateDeckChrome();
    } else if (t.classList && t.classList.contains('lib-label')) {
      await DM.cvLibrary.rename(t.dataset.id, t.value);
      state.cvs = await DM.cvLibrary.list();
    } else if (t.id === 'mainFile' && t.files && t.files[0]) {
      try {
        await DM.cvLibrary.attachMainFile(t.files[0]);
      } catch (err) {
        const el = $('#libFileError');
        if (el) el.textContent = err.message;
        return;
      }
      await openLibrary();
    }
  }

  function onKey(e) {
    // The target is the document itself when nothing has focus, and it has no closest().
    const within = (sel) => !!(e.target && e.target.closest && e.target.closest(sel));
    if (state.view !== 'deck' || within('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(state.idx + 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(state.idx - 1); }
    else if (e.key === 'x' || e.key === 'X') act('skipped');
    else if (e.key === 's' || e.key === 'S') act('saved');
    else if (e.key === 'Enter' && !within('button, a')) startApply();
  }

  function onStorage(changes, area) {
    if (area !== 'local') return;
    if (changes[UI_KEY] && state.view === 'ready') maybeAutoStart();
    // Library edits made in this panel already update state; only a CV changed
    // elsewhere (V1's settings) or a first CV needs a reload here.
    if ((changes.cvText && ['ready', 'nocv'].includes(state.view)) || (changes.jma_dm_cv_library && state.view === 'nocv')) refresh();
  }

  async function boot() {
    app().addEventListener('click', onClick);
    app().addEventListener('change', onChange);
    document.addEventListener('keydown', onKey);
    if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(onStorage);
    setView('loading');
    await refresh();
  }

  DM.app = { state, boot, render, goTo, build, loadDeck, refresh, setView };
  if (document.getElementById('dm-app') && !root.__JMA_DM_NO_AUTOBOOT) boot();
})(typeof globalThis !== 'undefined' ? globalThis : self);
