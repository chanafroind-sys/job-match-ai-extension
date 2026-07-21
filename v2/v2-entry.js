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
//
// CV upload is NOT a V1-vs-V2 choice — it's shared infrastructure (both
// pipelines read the same cvText). So the upload-time semantic-map trigger
// below is a second, independent, non-exclusive 'click' listener on V1's own
// #btnSaveSettings — it never intercepts or stops that event, popup.js's own
// handler still runs exactly as before. This is the ONLY legitimate place
// the AI CV-structure parser fires (see server-python/v2/semantic_map.py's
// upload-time-only contract) — v2_content.js's CV window only ever reads the
// already-computed result, never computes one during job navigation.
(() => {
  'use strict';

  const BYPASS = '_jmaV2Bypass';
  const V2_BACKEND = 'https://job-match-ai-extension.onrender.com';
  const LAST_MAPPED_HASH_KEY = 'jma_v2_last_mapped_cv_hash';

  function _v2HashText(text) {
    let h = 0;
    for (let i = 0; i < (text || '').length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }

  // Runs the AI structural map and saves it to the profile DB. Deduped by CV
  // text hash so it only actually calls the server when THIS CV hasn't been
  // mapped yet — clicking Save repeatedly, or for unrelated settings, is a
  // cheap no-op. `sync:true` skips the dedup (used by a fresh file upload,
  // where we always want to (re)map even if the hash somehow matches).
  async function _v2EnsureSemanticMap(cvText, { force = false } = {}) {
    if (!cvText || cvText.trim().length < 50) return;
    const hash = _v2HashText(cvText);
    if (!force) {
      const { [LAST_MAPPED_HASH_KEY]: lastHash } = await chrome.storage.local.get(LAST_MAPPED_HASH_KEY);
      if (lastHash === hash) return; // already mapped this exact CV
    }
    try {
      console.log('[JMA:V2] upload-time semantic-map: sending CV for structural mapping…');
      const { licenseKey } = await chrome.storage.local.get('licenseKey');
      const resp = await fetch(`${V2_BACKEND}/api/v2/semantic-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-License-Key': licenseKey || '' },
        body: JSON.stringify({ cvText }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.saved) {
        await chrome.storage.local.set({ [LAST_MAPPED_HASH_KEY]: hash });
        console.log(`[JMA:V2] upload-time semantic-map: saved ${data.blocks?.length ?? 0} blocks to profile DB`);
      } else {
        console.warn(`[JMA:V2] upload-time semantic-map: NOT saved (HTTP ${resp.status}, saved=${data.saved ?? 'n/a'}, error=${data.error ?? 'none'})`);
      }
    } catch (err) {
      console.warn('[JMA:V2] upload-time semantic-map call failed:', err);
    }
  }

  // Fires alongside (not instead of) popup.js's own save handler — never
  // intercepts or stops the event. Document-level delegation (not a direct
  // getElementById at load time) so it works no matter when the settings
  // screen / button is rendered. BUG FIX: previously this only read
  // fileInput._extractedText, which is set ONLY on a fresh file pick — so
  // clicking Save with an already-saved CV (no re-selection) mapped nothing.
  // Now it falls back to the stored cvText, which also self-heals CVs that
  // were uploaded before this feature existed.
  document.addEventListener('click', (e) => {
    const saveBtn = e.target instanceof Element ? e.target.closest('#btnSaveSettings') : null;
    if (!saveBtn) return;
    const freshUpload = document.getElementById('cvFileInput')?._extractedText;
    (async () => {
      const cvText = freshUpload || (await chrome.storage.local.get('cvText')).cvText || '';
      await _v2EnsureSemanticMap(cvText, { force: !!freshUpload });
    })();
  });

  // Extra self-heal: when the popup opens and a CV is already saved but has
  // never been mapped, kick the mapping off in the background. Makes existing
  // users work without needing to re-save at all. Deduped, so it's a no-op
  // once mapped.
  (async () => {
    const { cvText } = await chrome.storage.local.get('cvText');
    if (cvText) _v2EnsureSemanticMap(cvText);
  })();

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
