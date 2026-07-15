// JMA V2 exclusive switch — popup entry point.
//
// Loaded by popup.html AFTER popup.js (the only popup.html change is this one
// script tag; popup.js itself is frozen). V1 wires startFlow directly to
// #btnStartAnalysis, bubble phase. This capture-phase listener fires first
// and routes exclusively:
//   Classic (V1)     → flagged synthetic click; only V1's startFlow runs.
//   Interactive (V2) → stopPropagation() starves V1; the V2 panel is opened
//                      on the job page via the jmaV2OpenPanel message, which
//                      only v2/v2_content.js answers.
(() => {
  'use strict';

  const BYPASS = '_jmaV2Bypass';

  document.addEventListener('click', (e) => {
    if (e[BYPASS]) return; // Classic handoff — V1's listener takes it
    const btn = e.target instanceof Element ? e.target.closest('#btnStartAnalysis') : null;
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    _toggleChooser(btn);
  }, true);

  function _toggleChooser(btn) {
    const existing = document.getElementById('jmaV2Chooser');
    if (existing) { existing.remove(); return; }
    _injectStyles();

    const box = document.createElement('div');
    box.id = 'jmaV2Chooser';
    box.setAttribute('dir', 'rtl');
    box.innerHTML = `
      <button type="button" id="jmaV2ChooseClassic">
        ⚡ מצב קלאסי <span>הזרימה היציבה המוכרת (V1)</span>
      </button>
      <button type="button" id="jmaV2ChooseInteractive">
        🧪 מצב אינטראקטיבי <span>V2 Beta — נפתח כפאנל בעמוד המשרה</span>
      </button>
      <div id="jmaV2ChooserStatus"></div>`;
    btn.insertAdjacentElement('afterend', box);

    box.querySelector('#jmaV2ChooseClassic').addEventListener('click', (ev) => {
      ev.stopPropagation();
      box.remove();
      // Only V1 runs from here: the flag makes this script ignore the event.
      const synth = new MouseEvent('click', { bubbles: true, cancelable: true });
      synth[BYPASS] = true;
      btn.dispatchEvent(synth);
    });

    box.querySelector('#jmaV2ChooseInteractive').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const status = box.querySelector('#jmaV2ChooserStatus');
      status.textContent = 'פותח פאנל V2…';
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'jmaV2OpenPanel' });
        if (!res || !res.ok) throw new Error('no-ack');
        status.textContent = '🧪 פאנל V2 נפתח בעמוד המשרה';
        setTimeout(() => box.remove(), 1200);
      } catch {
        status.textContent = 'V2 זמין רק בעמוד משרה פתוח — רענני את הדף ונסי שוב';
      }
    });
  }

  function _injectStyles() {
    if (document.getElementById('jmaV2EntryStyles')) return;
    const style = document.createElement('style');
    style.id = 'jmaV2EntryStyles';
    style.textContent = `
      #jmaV2Chooser{
        display:flex;flex-direction:column;gap:8px;margin-top:10px;
        background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.4);
        border-radius:12px;padding:10px;
      }
      #jmaV2Chooser button{
        all:unset;box-sizing:border-box;cursor:pointer;width:100%;
        padding:10px 12px;border-radius:9px;color:#fff;
        font-size:13px;font-weight:700;text-align:right;
      }
      #jmaV2Chooser button span{
        display:block;font-size:11px;font-weight:400;opacity:.75;margin-top:2px;
      }
      #jmaV2ChooseClassic{background:#31435C}
      #jmaV2ChooseClassic:hover{background:#3D5474}
      #jmaV2ChooseInteractive{background:#5B21B6}
      #jmaV2ChooseInteractive:hover{background:#6D28D9}
      #jmaV2ChooserStatus{font-size:11.5px;text-align:center;min-height:14px;color:#B9AEDD}
    `;
    document.head.appendChild(style);
  }
})();
