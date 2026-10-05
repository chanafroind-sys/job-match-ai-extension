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
      return { pill: 'ניסיון חינם', text: `${pool}הרצה אחת עלינו: עד 15 משרות מנותחות מול קורות החיים שלך.`,
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
    const hero = el('div', 'dm-hero');
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
  }

  window.JMA_DM_ENTRY = { init, cardModel };
  init();
})();
