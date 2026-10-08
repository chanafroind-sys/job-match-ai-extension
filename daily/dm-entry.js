// Daily Matches — popup entry point.
//
// The only change to popup.html is the script tag that loads this file, after
// v2/v2-entry.js. popup.js is untouched: this script adds its own card to the
// top of #screen-ready and a once-a-day strip under the header for the other
// screens, using the popup's existing classes and tokens. It loads
// daily/dm-api.js itself rather than taking a second script tag.
//
// The status call is free (no AI) and runs for keyless users too, because the
// free trial is open to them. On any failure (server asleep, feature off) the
// popup simply shows nothing new.
//
// The launch announcement: a dialog over the popup that explains the feature
// in three steps and offers the free run. Until a person has tried it, it
// comes back once a day ("later" hides it until tomorrow); subscribers see it
// once. The toolbar badge isn't used: V1 reads any badge as "a recruiter
// opened your link" (popup.js, the tracker dot).
(() => {
  'use strict';

  const UI_KEY = 'jma_dm_ui';
  const STYLE_ID = 'jma-dm-entry-style';
  let windowId = null;
  let lastStatus = null;

  // sidePanel.open() must run inside the click's user gesture, so the window
  // id is fetched up front instead of awaited in the handler.
  try {
    chrome.windows.getCurrent().then(w => { windowId = w && w.id; }).catch(() => {});
  } catch (_) { /* no windows API in this context */ }

  function loadScript(src) {
    if (window.JMA_DM && window.JMA_DM.api) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .dm-hero { text-align: right; background: var(--bg-card); border: 1.5px solid rgba(99,102,241,0.35);
        border-radius: var(--border-radius); padding: 14px 16px 12px; box-shadow: var(--shadow-sm); margin-bottom: 4px; }
      .dm-hero-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .dm-hero-title { font-weight: 700; font-size: 15px; letter-spacing: -0.2px; color: var(--text-primary); }
      .dm-pill { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 20px; white-space: nowrap;
        background: rgba(99,102,241,0.10); color: var(--accent-dark); border: 1px solid rgba(99,102,241,0.25); }
      .dm-pill.is-lock { background: #FFF7ED; color: #C2410C; border-color: #FED7AA; }
      .dm-hero-text { font-size: 12.5px; color: var(--text-muted); margin: 6px 0 12px; line-height: 1.6; }
      .dm-hero .btn { padding: 11px 14px; }
      .dm-hero-meta { font-size: 11px; color: var(--text-dim); margin-top: 8px; text-align: center; }
      .dm-strip { display: none; align-items: center; gap: 8px; padding: 8px 14px; font-size: 12.5px;
        background: var(--bg-accent-soft); border-bottom: 1px solid rgba(99,102,241,0.2); color: var(--text-secondary); }
      .dm-strip.is-on { display: flex; }
      .dm-strip-text { flex: 1; }
      .dm-strip button { background: none; border: 0; cursor: pointer; font: inherit; color: var(--accent-dark); font-weight: 600; }
      .dm-strip .dm-strip-x { color: var(--text-dim); font-weight: 400; padding: 0 4px; }
      .dm-hero.is-gift { border-color: transparent; background:
          linear-gradient(var(--bg-card), var(--bg-card)) padding-box,
          linear-gradient(135deg, #6366F1, #EC4899, #F59E0B) border-box; border: 2px solid transparent; }
      .dm-hero.is-gift .dm-pill { background: linear-gradient(135deg, #6366F1, #EC4899); color: #fff; border: 0;
        animation: dmPulse 2.4s ease-in-out infinite; }
      @keyframes dmPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(236,72,153,0.35); } 50% { box-shadow: 0 0 0 6px rgba(236,72,153,0); } }

      .dm-ann-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
        padding: 14px; background: rgba(15,23,42,0.55); direction: rtl; animation: dmFade .2s ease-out; }
      .dm-ann { position: relative; width: 100%; max-width: 380px; max-height: 100%; overflow-y: auto; background: var(--bg-card, #fff);
        border-radius: 18px; box-shadow: 0 20px 50px rgba(15,23,42,0.35); padding: 18px 18px 14px; text-align: right;
        animation: dmRise .28s cubic-bezier(.2,.8,.2,1); font-family: inherit; }
      .dm-ann-x { position: absolute; top: 10px; left: 10px; width: 28px; height: 28px; border-radius: 8px; border: 0;
        background: var(--bg-hover, #F1F5F9); color: var(--text-muted, #64748B); cursor: pointer; font-size: 13px; }
      .dm-ann-badge { display: inline-block; font-size: 11px; font-weight: 700; color: #fff; padding: 3px 10px; border-radius: 20px;
        background: linear-gradient(135deg, #6366F1, #EC4899); }
      .dm-ann h2 { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; margin: 8px 0 4px; color: var(--text-primary, #0F172A); }
      .dm-ann-sub { font-size: 13px; line-height: 1.6; color: var(--text-secondary, #334155); margin: 0 0 12px; }
      .dm-ann-demo { display: grid; gap: 7px; padding: 11px 12px; border-radius: 14px; margin-bottom: 12px;
        background: linear-gradient(135deg, rgba(99,102,241,0.08), rgba(236,72,153,0.06)); border: 1px solid rgba(99,102,241,0.2); }
      .dm-ann-demo-head { display: flex; align-items: center; gap: 10px; }
      .dm-ann-ring { width: 44px; height: 44px; flex: 0 0 44px; border-radius: 50%; display: grid; place-items: center;
        font-weight: 800; font-size: 15px; color: #15803D; background: conic-gradient(#16A34A 0 86%, #E2E8F0 86% 100%);
        -webkit-mask: radial-gradient(circle, transparent 15px, #000 16px); mask: radial-gradient(circle, transparent 15px, #000 16px); }
      .dm-ann-ring-wrap { position: relative; width: 44px; height: 44px; }
      .dm-ann-ring-num { position: absolute; inset: 0; display: grid; place-items: center; font-weight: 800; font-size: 14px; color: #15803D; }
      .dm-ann-jt { font-weight: 700; font-size: 13.5px; color: var(--text-primary, #0F172A); }
      .dm-ann-co { font-size: 11.5px; color: var(--text-muted, #64748B); }
      .dm-ann-chips { display: flex; flex-wrap: wrap; gap: 5px; }
      .dm-ann-chips span { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #fff; border: 1px solid #E2E8F0; }
      .dm-ann-chips .ok { color: #15803D; } .dm-ann-chips .mid { color: #B45309; }
      .dm-ann-cv { font-size: 11.5px; color: var(--accent-dark, #4F46E5); font-weight: 600; }
      .dm-ann-steps { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 9px; }
      .dm-ann-steps li { display: flex; gap: 10px; align-items: flex-start; font-size: 12.5px; line-height: 1.55; color: var(--text-secondary, #334155); }
      .dm-ann-steps .ico { flex: 0 0 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; font-size: 16px;
        background: var(--bg-hover, #F1F5F9); }
      .dm-ann-steps b { color: var(--text-primary, #0F172A); }
      .dm-ann-gift { font-size: 12.5px; text-align: center; padding: 8px 10px; border-radius: 10px; margin-bottom: 10px;
        background: #FFFBEB; border: 1px dashed #F59E0B; color: #92400E; }
      .dm-ann .btn { width: 100%; }
      .dm-ann-later { display: block; margin: 8px auto 0; background: none; border: 0; cursor: pointer; font: inherit;
        font-size: 12px; color: var(--text-muted, #64748B); }
      @keyframes dmFade { from { opacity: 0; } }
      @keyframes dmRise { from { opacity: 0; transform: translateY(14px) scale(.98); } }
      @media (prefers-reduced-motion: reduce) { .dm-ann-backdrop, .dm-ann, .dm-hero.is-gift .dm-pill { animation: none; } }
    `;
    document.head.appendChild(style);
  }

  const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '');

  // What the card says for each state, plus whether clicking should start a
  // run right away (the user already asked for one by clicking it).
  function cardModel(s) {
    const pool = s.pool && s.pool.active ? `${fmt(s.pool.active)} משרות פעילות במאגר של היום. ` : '';
    const today = s.today;
    if (today && today.status === 'done') {
      return { pill: `${today.cards || 0} בחפיסה`, text: 'החפיסה של היום מוכנה ומחכה לך.', btn: 'פתיחת החפיסה',
        meta: 'החפיסה הבאה מחר, מחצות', autoStart: false };
    }
    if (today && today.status === 'running') {
      return { pill: 'בבנייה', text: 'החפיסה של היום נבנית עכשיו.', btn: 'מעבר לחפיסה', meta: '', autoStart: false };
    }
    if (s.entitlement === 'locked') {
      return { pill: '🔒 למנויים', lock: true, text: 'ההרצה החינמית נוצלה. מנויים מקבלים חפיסה חדשה בכל יום.',
        btn: 'לפרטים', meta: s.last_run ? 'החפיסה החינמית עדיין זמינה לצפייה' : '', autoStart: false };
    }
    if (s.entitlement === 'trial') {
      return { pill: '🎁 ניסיון חינם', gift: true,
        text: 'המשרות החדשות בהייטק שבאמת מתאימות לך, כל אחת עם ציון מוסבר והגרסה הנכונה של קורות החיים. הרצה אחת עלינו.',
        btn: 'לנסות בחינם', meta: 'בלי מפתח ובלי כרטיס אשראי', autoStart: true };
    }
    return { pill: 'חדש להיום', text: `${pool}ננתח לעומק את המשרות שהכי מתאימות לך.`,
      btn: 'בניית החפיסה של היום', meta: 'פעם ביום · מתאפס בחצות', autoStart: true };
  }

  async function openDeck(autoStart) {
    let opened = false;
    if (chrome.sidePanel && chrome.sidePanel.open && windowId != null) {
      try {
        await chrome.sidePanel.open({ windowId }); // first, while the click's gesture is live
        opened = true;
      } catch (e) {
        console.warn('[JMA:DM] side panel unavailable, opening a tab:', e && e.message);
      }
    }
    if (autoStart) {
      const ui = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
      await chrome.storage.local.set({ [UI_KEY]: { ...ui, autoStartAt: Date.now() } });
    }
    if (!opened) await chrome.tabs.create({ url: chrome.runtime.getURL('daily/daily.html') });
    window.close();
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderHero(s) {
    const screen = document.getElementById('screen-ready');
    if (!screen) return;
    const m = cardModel(s);
    const old = document.getElementById('jma-dm-hero');
    if (old) old.remove();
    const hero = el('div', 'dm-hero' + (m.gift ? ' is-gift' : ''));
    hero.id = 'jma-dm-hero';
    const top = el('div', 'dm-hero-top');
    top.append(el('div', 'dm-hero-title', '✨ ההתאמות היומיות שלך'), el('span', 'dm-pill' + (m.lock ? ' is-lock' : ''), m.pill));
    const btn = el('button', 'btn btn-primary', m.btn);
    btn.type = 'button';
    btn.id = 'btnDmOpen';
    btn.addEventListener('click', () => openDeck(m.autoStart));
    hero.append(top, el('p', 'dm-hero-text', m.text), btn);
    if (m.meta) hero.append(el('div', 'dm-hero-meta', m.meta));
    screen.insertAdjacentElement('afterbegin', hero);
  }

  // A slim strip for the other popup screens, once a day, until opened or dismissed.
  function renderStrip(s) {
    const fresh = !s.today && (s.entitlement === 'subscription' || s.entitlement === 'trial');
    const header = document.querySelector('.header');
    if (!fresh || !header || document.getElementById('jma-dm-strip')) return;
    const strip = el('div', 'dm-strip');
    strip.id = 'jma-dm-strip';
    const open = el('button', '', 'פתיחה');
    open.type = 'button';
    open.addEventListener('click', () => openDeck(true));
    const close = el('button', 'dm-strip-x', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'הסתרה עד מחר');
    close.addEventListener('click', async () => {
      strip.remove();
      const ui = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
      await chrome.storage.local.set({ [UI_KEY]: { ...ui, stripDismissedOn: new Date().toDateString() } });
    });
    strip.append(el('span', 'dm-strip-text', '✨ ההתאמות היומיות שלך מחכות'), open, close);
    header.insertAdjacentElement('afterend', strip);

    const sync = () => {
      const ready = document.getElementById('screen-ready');
      strip.classList.toggle('is-on', !(ready && ready.classList.contains('active')));
    };
    sync();
    new MutationObserver(sync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  const todayKey = () => new Date().toDateString();

  // Who sees the announcement: anyone who can still try the feature (once a
  // day, until they do), and subscribers once. Nobody with a deck today, and
  // nobody whose free run is used up.
  function shouldAnnounce(s, ui) {
    if (s.today) return false;
    if (s.entitlement === 'trial') return ui.annDismissedOn !== todayKey();
    if (s.entitlement === 'subscription') return !ui.annSeen;
    return false;
  }

  async function saveUi(patch) {
    const ui = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
    await chrome.storage.local.set({ [UI_KEY]: { ...ui, ...patch } });
  }

  function renderAnnouncement(s) {
    if (document.getElementById('jma-dm-announce')) return;
    const trial = s.entitlement === 'trial';
    const back = el('div', 'dm-ann-backdrop');
    back.id = 'jma-dm-announce';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-labelledby', 'dmAnnTitle');
    // Static markup, no server or user text in it.
    back.innerHTML = `
      <div class="dm-ann">
        <button type="button" class="dm-ann-x" data-ann="later" aria-label="סגירה">✕</button>
        <span class="dm-ann-badge">✨ חדש בתוסף</span>
        <h2 id="dmAnnTitle">ההתאמות היומיות</h2>
        <p class="dm-ann-sub">כל בוקר, המשרות החדשות בהייטק שבאמת מתאימות לך, מוכנות להגשה.</p>
        <div class="dm-ann-demo" aria-hidden="true">
          <div class="dm-ann-demo-head"><div class="dm-ann-ring-wrap"><div class="dm-ann-ring"></div><span class="dm-ann-ring-num">86</span></div>
            <div><div class="dm-ann-jt" dir="ltr">Senior Backend Engineer</div><div class="dm-ann-co">פורסמה היום · ⭐ מעולה</div></div></div>
          <div class="dm-ann-chips"><span class="ok">✓ Python</span><span class="ok">✓ Kafka</span><span class="mid">◐ Kubernetes</span></div>
          <div class="dm-ann-cv">📄 מומלץ להגיש עם גרסת ה-Backend ⬇️</div>
        </div>
        <ol class="dm-ann-steps">
          <li><span class="ico">🌅</span><div><b>כל בוקר ב-6:00</b> אנחנו אוספים את משרות הפיתוח החדשות בארץ: מלינקדאין, מ-Indeed ומאתרי החברות.</div></li>
          <li><span class="ico">🎯</span><div><b>ה-AI בודק כל משרה מול קורות החיים שלך</b>, דרישה אחרי דרישה, ומציג רק את מה שבאמת מתאים, עם הסבר לכל ציון.</div></li>
          <li><span class="ico">🚀</span><div><b>מגישים מהר יותר</b>: הגרסה הנכונה של קורות החיים מוכנה להורדה, והטופס מתמלא אוטומטית באתרים נתמכים.</div></li>
        </ol>
        <div class="dm-ann-gift">${trial ? '🎁 <b>ניסיון אחד עלינו</b> · בלי מפתח ובלי כרטיס אשראי' : '✓ <b>כלול במנוי שלך</b> · חפיסה חדשה בכל יום'}</div>
        <button type="button" class="btn btn-primary" data-ann="go">${trial ? 'לנסות עכשיו בחינם' : 'לבנות את החפיסה הראשונה'}</button>
        <button type="button" class="dm-ann-later" data-ann="later">אחר כך</button>
      </div>`;
    const later = async () => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      await saveUi(trial ? { annDismissedOn: todayKey() } : { annSeen: true });
    };
    const onKey = (e) => { if (e.key === 'Escape') later(); };
    back.addEventListener('click', (e) => {
      const act = e.target.closest && e.target.closest('[data-ann]');
      if (e.target === back || (act && act.dataset.ann === 'later')) return later();
      if (act && act.dataset.ann === 'go') {
        saveUi({ annSeen: true });
        return openDeck(true); // inside the click: the side panel needs the gesture
      }
      return undefined;
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    const go = back.querySelector('[data-ann="go"]');
    if (go && go.focus) go.focus();
  }

  async function init() {
    try {
      await loadScript('daily/dm-api.js');
      lastStatus = await window.JMA_DM.api.status();
    } catch (_) {
      return; // server asleep or unreachable: the popup works exactly as before
    }
    if (!lastStatus || !lastStatus.enabled || lastStatus.error) return;
    injectStyles();
    renderHero(lastStatus);
    const ui = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
    if (ui.stripDismissedOn !== new Date().toDateString()) renderStrip(lastStatus);
    if (shouldAnnounce(lastStatus, ui)) renderAnnouncement(lastStatus);
    syncBadge(lastStatus, ui).catch(() => {});
  }

  // The toolbar's "חדש" until the deck is first opened (daily/dm-bg.js sets it
  // at install; this keeps it right). Never over V1's own "NEW".
  async function syncBadge(s, ui) {
    if (!chrome.action || !chrome.action.getBadgeText) return;
    const want = !ui.panelOpened && (s.entitlement === 'trial' || s.entitlement === 'subscription');
    const current = await chrome.action.getBadgeText({});
    if (want && !current) {
      await chrome.action.setBadgeText({ text: 'חדש' });
      await chrome.action.setBadgeBackgroundColor({ color: '#7C3AED' });
    } else if (!want && current === 'חדש') {
      await chrome.action.setBadgeText({ text: '' });
    }
  }

  window.JMA_DM_ENTRY = { init, cardModel, shouldAnnounce };
  init();
})();
