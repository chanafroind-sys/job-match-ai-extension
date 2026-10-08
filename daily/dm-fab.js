// Daily Matches — a "new" tag on the job-page FAB (#jma-fab-wrap, created by
// content.js), for people who never open the popup. Its own content script,
// listed after content.js in the manifest; content.js isn't touched.
//
// While someone who can use Daily Matches hasn't opened it yet, the FAB wears
// a small "🎁 חדש" tag. Once a day the tag opens into a bubble that says what
// the feature is, with "try it" (opens the deck and starts the free run) and
// ✕ (closes the bubble until tomorrow; the tag stays). Clicking the tag opens
// the bubble again. Clicks never reach the FAB underneath.
//
// content.js removes and rebuilds the FAB on page and SPA navigations, so the
// tag is re-attached whenever a new FAB appears.
(() => {
  'use strict';

  if (window.__JMA_DM_FAB) return;
  window.__JMA_DM_FAB = true;

  const UI_KEY = 'jma_dm_ui';
  const TAG_ID = 'jma-dm-fab-tag';
  const BUBBLE_ID = 'jma-dm-fab-bubble';
  const STYLE_ID = 'jma-dm-fab-style';
  let invited = null; // null: not asked yet this page

  const today = () => new Date().toDateString();

  async function ui() {
    return (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
  }

  async function saveUi(patch) {
    await chrome.storage.local.set({ [UI_KEY]: { ...(await ui()), ...patch } });
  }

  function ask(action) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action }, (resp) => {
          void chrome.runtime.lastError; // worker asleep or reloaded: treat as "no"
          resolve(resp || null);
        });
      } catch (_) {
        resolve(null); // the extension was reloaded under this page
      }
    });
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #${TAG_ID} { position: absolute; top: -8px; right: -10px; z-index: 2; cursor: pointer;
        font: 700 11px/1 Rubik, -apple-system, 'Segoe UI', Arial, sans-serif; color: #fff; white-space: nowrap;
        padding: 4px 7px; border-radius: 12px; border: 2px solid #fff; direction: rtl;
        background: linear-gradient(135deg, #6366F1, #EC4899); box-shadow: 0 2px 8px rgba(236,72,153,0.45);
        animation: jmaDmTag 2.2s ease-in-out infinite; }
      @keyframes jmaDmTag { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } }
      #${BUBBLE_ID} { position: fixed; z-index: 2147483600; width: 260px; direction: rtl; text-align: right;
        font: 400 13px/1.55 Rubik, -apple-system, 'Segoe UI', Arial, sans-serif; color: #334155;
        background: #fff; border-radius: 14px; padding: 13px 14px 12px; box-shadow: 0 12px 32px rgba(15,23,42,0.28);
        border: 1px solid rgba(99,102,241,0.25); animation: jmaDmPop .25s cubic-bezier(.2,.8,.2,1); }
      @keyframes jmaDmPop { from { opacity: 0; transform: translateY(8px) scale(.97); } }
      #${BUBBLE_ID} .t { font-weight: 800; font-size: 14.5px; color: #0F172A; margin: 0 0 4px; }
      #${BUBBLE_ID} .b { display: inline-block; font-size: 10.5px; font-weight: 700; color: #fff; padding: 2px 8px;
        border-radius: 10px; background: linear-gradient(135deg, #6366F1, #EC4899); margin-bottom: 6px; }
      #${BUBBLE_ID} p { margin: 0 0 9px; }
      #${BUBBLE_ID} .g { font-size: 12px; color: #92400E; background: #FFFBEB; border: 1px dashed #F59E0B;
        border-radius: 8px; padding: 5px 8px; margin-bottom: 9px; text-align: center; }
      #${BUBBLE_ID} .go { display: block; width: 100%; border: 0; border-radius: 10px; padding: 9px; cursor: pointer;
        font: 700 13px/1 Rubik, -apple-system, 'Segoe UI', Arial, sans-serif; color: #fff; background: #6366F1; }
      #${BUBBLE_ID} .go:hover { background: #4F46E5; }
      #${BUBBLE_ID} .x { position: absolute; top: 8px; left: 8px; border: 0; background: #F1F5F9; color: #64748B;
        width: 24px; height: 24px; border-radius: 7px; cursor: pointer; font-size: 12px; }
      @media (prefers-reduced-motion: reduce) { #${TAG_ID}, #${BUBBLE_ID} { animation: none; } }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function closeBubble() {
    const b = document.getElementById(BUBBLE_ID);
    if (b) b.remove();
  }

  function placeBubble(bubble, fab) {
    const r = fab.getBoundingClientRect();
    const w = 260;
    let left = r.left - w - 12; // to the FAB's left by default
    if (left < 8) left = Math.min(window.innerWidth - w - 8, r.right + 12);
    const top = Math.max(8, Math.min(window.innerHeight - 270, r.top + r.height / 2 - 130));
    bubble.style.left = `${Math.max(8, left)}px`;
    bubble.style.top = `${top}px`;
  }

  function stop(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function openBubble(fab) {
    closeBubble();
    const bubble = document.createElement('div');
    bubble.id = BUBBLE_ID;
    bubble.setAttribute('role', 'dialog');
    bubble.setAttribute('aria-label', 'חדש: ההתאמות היומיות');
    // Static markup only: nothing from the page or the server goes in here.
    bubble.innerHTML = `
      <button type="button" class="x" aria-label="סגירה עד מחר">✕</button>
      <span class="b">✨ חדש ב-Job Match AI</span>
      <div class="t">ההתאמות היומיות</div>
      <p>כל בוקר: רוב המשרות החדשות בהייטק בארץ, מסוננות לגלגלת הגשה מהירה של מה שמתאים לך. לכל משרה, גרסת קורות החיים המומלצת ומילוי אוטומטי של הטופס כשאפשר.</p>
      <div class="g">🎁 ניסיון אחד עלינו · בלי מפתח ובלי כרטיס אשראי</div>
      <button type="button" class="go">לנסות עכשיו</button>`;
    bubble.addEventListener('click', (e) => e.stopPropagation());
    bubble.querySelector('.x').addEventListener('click', async (e) => {
      stop(e);
      closeBubble();
      await saveUi({ fabBubbleDismissedOn: today() });
    });
    bubble.querySelector('.go').addEventListener('click', async (e) => {
      stop(e);
      closeBubble();
      await ask('dmOpenDeck'); // in the click, so the side panel may open
    });
    document.body.appendChild(bubble);
    placeBubble(bubble, fab);
  }

  function attach(fab) {
    if (fab.querySelector(`#${TAG_ID}`)) return false;
    injectStyles();
    const tag = document.createElement('span');
    tag.id = TAG_ID;
    tag.textContent = '🎁 חדש';
    tag.title = 'חדש: ההתאמות היומיות';
    tag.setAttribute('role', 'button');
    tag.setAttribute('tabindex', '0');
    const show = (e) => { stop(e); openBubble(fab); };
    tag.addEventListener('click', show);
    tag.addEventListener('mousedown', (e) => e.stopPropagation());
    tag.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') show(e); });
    if (getComputedStyle(fab).position === 'static') fab.style.position = 'relative';
    fab.appendChild(tag);
    return true;
  }

  async function onFab(fab) {
    if (invited === null) invited = !!((await ask('dmFabStatus')) || {}).invited;
    if (!invited || !document.contains(fab)) return;
    const state = await ui();
    if (state.panelOpened) return;
    attach(fab);
    // The bubble opens by itself on the first FAB of the day; after that, the tag opens it.
    if (state.fabBubbleShownOn !== today() && state.fabBubbleDismissedOn !== today()) {
      await saveUi({ fabBubbleShownOn: today() });
      openBubble(fab);
    }
  }

  function scan() {
    const fab = document.getElementById('jma-fab-wrap');
    if (fab && !fab.querySelector(`#${TAG_ID}`)) onFab(fab);
    else if (!fab) closeBubble();
  }

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();

  // Opening the deck anywhere retires the tag on every open page.
  chrome.storage.onChanged.addListener((changes, area) => {
    const next = area === 'local' && changes[UI_KEY] && changes[UI_KEY].newValue;
    if (next && next.panelOpened) {
      const tag = document.getElementById(TAG_ID);
      if (tag) tag.remove();
      closeBubble();
      invited = false;
    }
  });

  window.JMA_DM_FAB = { scan };
})();
