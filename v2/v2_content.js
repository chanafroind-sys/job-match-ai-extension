// ═════════════════════════════════════════════════════════════════════════
// JMA V2 (Interactive Mode Beta) — exclusive-switch content script.
//
// Replication contract (V1 ↔ V2 isolation):
//   • V1's FAB click handler lives in content.js — bubble phase, attached to
//     #jma-fab-wrap. content.js is FROZEN and never edited.
//   • This file registers a document-level CAPTURE-phase listener, so it runs
//     before V1's handler on every FAB click and routes exclusively:
//       Classic (V1)     → re-dispatch a flagged synthetic click on the FAB;
//                          this script ignores it, only V1 code executes.
//       Interactive (V2) → stopPropagation() starves V1's listener entirely;
//                          only V2 code executes.
//   • Strict OR-flow: zero double backend calls, zero background processing
//     of the non-selected pipeline.
//   • Storage isolation: V2 owns the jma_v2_* namespace and never reads or
//     writes V1 keys (jma_recent_jobs, jma_pf_*, …).
//   • Message isolation: V2 answers only jmaV2* actions; V1 actions
//     (runFabPipeline, openAnalysisPanel, …) are never handled here.
// ═════════════════════════════════════════════════════════════════════════
(() => {
  'use strict';

  const V2_JOBS_KEY = 'jma_v2_recent_jobs';
  const BYPASS = '_jmaV2Bypass';
  let _v2PanelOpen = false;

  // ── Exclusive switch: capture-phase FAB interception ─────────────────────
  document.addEventListener('click', (e) => {
    if (e[BYPASS]) return; // Classic handoff in flight — let V1 take the event
    const wrap = e.target instanceof Element ? e.target.closest('#jma-fab-wrap') : null;
    if (!wrap) return;
    // Mirror V1's own guard: non-clickable FAB clicks are no-ops in V1 too,
    // so we let them through untouched instead of showing the chooser.
    if (!wrap.classList.contains('jma-fab-clickable')) return;
    e.stopPropagation();
    e.preventDefault();
    _toggleChooser(wrap);
  }, true);

  // Dismiss the chooser on any click outside it (bubble phase, read-only).
  document.addEventListener('click', (e) => {
    const chooser = document.getElementById('jma-v2-chooser');
    if (!chooser) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && (t.closest('#jma-v2-chooser') || t.closest('#jma-fab-wrap'))) return;
    chooser.remove();
  });

  function _toggleChooser(wrap) {
    const existing = document.getElementById('jma-v2-chooser');
    if (existing) { existing.remove(); return; }
    _injectStyles();

    const box = document.createElement('div');
    box.id = 'jma-v2-chooser';
    box.setAttribute('dir', 'rtl');
    box.innerHTML = `
      <div class="jma-v2-chooser-title">איך לנתח את המשרה?</div>
      <button type="button" id="jma-v2-btn-classic">
        ⚡ מצב קלאסי
        <span>הזרימה היציבה המוכרת (V1)</span>
      </button>
      <button type="button" id="jma-v2-btn-interactive">
        🧪 מצב אינטראקטיבי
        <span>V2 Beta — התאמה ויזואלית</span>
      </button>`;
    document.body.appendChild(box);

    const rect = wrap.getBoundingClientRect();
    box.style.top = `${Math.max(8, rect.top - 8)}px`;
    box.style.right = `${Math.min(window.innerWidth - 8, window.innerWidth - rect.left + 12)}px`;

    box.querySelector('#jma-v2-btn-classic').addEventListener('click', (ev) => {
      ev.stopPropagation();
      box.remove();
      // Hand the click back to V1's untouched handler. The flag makes our
      // capture listener ignore it, so ONLY the V1 pipeline runs.
      const synth = new MouseEvent('click', { bubbles: true, cancelable: true });
      synth[BYPASS] = true;
      wrap.dispatchEvent(synth);
    });

    box.querySelector('#jma-v2-btn-interactive').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      box.remove();
      // V1 was already starved by stopPropagation at capture — from here on
      // ONLY the V2 pipeline runs.
      await _v2CaptureJobState();
      _v2TogglePanel(true);
    });
  }

  // ── V2 pipeline (Phase 1 scaffold) ────────────────────────────────────────
  // Writes exclusively to jma_v2_* keys. The full 1:1 clone of the V1 FAB
  // pipeline (extraction → local score → preflight) lands here in Phase 2.
  async function _v2CaptureJobState() {
    const rawTitle = (document.querySelector('h1')?.innerText
      || document.querySelector('meta[property="og:title"]')?.content
      || document.title || '').trim();
    const jobState = {
      url: location.href,
      jobUrl: location.href,
      jobTitle: rawTitle.split(/[|•–]/)[0].trim() || 'משרה ללא כותרת',
      ts: Date.now(),
      v2Phase: 'switch-scaffold',
    };
    try {
      const data = await chrome.storage.local.get(V2_JOBS_KEY);
      let jobs = data[V2_JOBS_KEY] || [];
      jobs = jobs.filter(j => j.url !== jobState.url);
      jobs.unshift(jobState);
      if (jobs.length > 5) jobs.length = 5;
      await chrome.storage.local.set({ [V2_JOBS_KEY]: jobs });
    } catch (err) {
      console.error('[JMA:V2] failed to save v2 job state:', err);
    }
  }

  // ── V2 slide-out panel (own DOM, own iframe, own popup page) ─────────────
  function _ensureV2Panel() {
    if (document.getElementById('jma-v2-panel')) return;
    _injectStyles();
    const panel = document.createElement('div');
    panel.id = 'jma-v2-panel';
    const closeBtn = document.createElement('button');
    closeBtn.id = 'jma-v2-panel-close';
    closeBtn.type = 'button';
    closeBtn.title = 'סגירת פאנל V2';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => _v2TogglePanel(false));
    panel.appendChild(closeBtn);
    const iframe = document.createElement('iframe');
    iframe.id = 'jma-v2-panel-iframe';
    iframe.src = chrome.runtime.getURL('v2/v2_popup.html');
    iframe.setAttribute('allowtransparency', 'true');
    panel.appendChild(iframe);
    document.body.appendChild(panel);
  }

  function _v2TogglePanel(open) {
    _ensureV2Panel();
    _v2PanelOpen = open === undefined ? !_v2PanelOpen : !!open;
    document.getElementById('jma-v2-panel')
      .classList.toggle('jma-v2-panel-open', _v2PanelOpen);
  }

  // ── V2 message channel (jmaV2* actions only) ─────────────────────────────
  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (req?.action === 'jmaV2OpenPanel') {
      _v2CaptureJobState().finally(() => {
        _v2TogglePanel(true);
        sendResponse({ ok: true });
      });
      return true; // async sendResponse
    }
    // Every other action belongs to V1's listener in content.js — never
    // answered here, so V1 message routing is untouched.
  });

  function _injectStyles() {
    if (document.getElementById('jma-v2-styles')) return;
    const style = document.createElement('style');
    style.id = 'jma-v2-styles';
    style.textContent = `
      #jma-v2-chooser{
        position:fixed;z-index:2147483646;min-width:230px;
        background:#1E1B2E;border:1px solid #7C3AED;border-radius:14px;
        padding:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);
        font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
        display:flex;flex-direction:column;gap:8px;direction:rtl;
      }
      #jma-v2-chooser .jma-v2-chooser-title{
        color:#E9E4F8;font-size:13px;font-weight:700;text-align:center;
        padding-bottom:2px;
      }
      #jma-v2-chooser button{
        all:unset;box-sizing:border-box;cursor:pointer;width:100%;
        display:flex;flex-direction:column;gap:2px;align-items:flex-start;
        padding:9px 12px;border-radius:10px;color:#fff;
        font-size:13.5px;font-weight:700;
      }
      #jma-v2-chooser button span{font-size:11px;font-weight:400;opacity:.75}
      #jma-v2-btn-classic{background:#31435C}
      #jma-v2-btn-classic:hover{background:#3D5474}
      #jma-v2-btn-interactive{background:#5B21B6}
      #jma-v2-btn-interactive:hover{background:#6D28D9}
      #jma-v2-panel{
        position:fixed;top:0;right:-420px;width:400px;height:100vh;
        z-index:2147483645;background:#14121F;
        border-left:2px solid #7C3AED;
        box-shadow:-8px 0 28px rgba(0,0,0,.4);
        transition:right .25s ease;
      }
      #jma-v2-panel.jma-v2-panel-open{right:0}
      #jma-v2-panel iframe{width:100%;height:100%;border:none;display:block}
      #jma-v2-panel-close{
        all:unset;cursor:pointer;position:absolute;top:8px;left:8px;
        width:26px;height:26px;text-align:center;line-height:26px;
        color:#B9AEDD;background:rgba(124,58,237,.18);border-radius:8px;
        font-size:13px;z-index:2;
      }
      #jma-v2-panel-close:hover{background:rgba(124,58,237,.4);color:#fff}
    `;
    document.documentElement.appendChild(style);
  }
})();
