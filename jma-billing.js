/**
 * Job Match AI — buying a subscription.
 *
 * The extension doesn't know which card processor sells it. It asks the
 * server whether to offer a subscription (/api/billing/config: off until the
 * rollout switch, a processor and a price are all set), opens the URL the
 * server gives it in a tab, and polls until the payment lands. The server then
 * hands over a license key once, and it is stored exactly where a typed key
 * goes, so everything that already reads `licenseKey` just starts working.
 *
 * A pending checkout survives closing the popup: whichever page loads this
 * file next (popup, side panel) picks the polling up again.
 *
 * Loaded by popup.html and daily/daily.html after jma-auth.js.
 */
(function (root) {
  'use strict';

  var BASE = 'https://job-match-ai-extension.onrender.com/api/billing';
  var PENDING_KEY = 'jma_billing_pending';
  var POLL_MS = 4000;
  // After a quarter of an hour the payer has most likely left the payment page;
  // an abandoned checkout polled every 4 s for its whole 6 h, from every open
  // page, was most of the server's traffic. A page that opens later still
  // checks at once (watch), so a late payment is picked up right away.
  var POLL_SLOW_MS = 30000;
  var FAST_FOR_MS = 15 * 60 * 1000;
  var PENDING_MAX_MS = 6 * 60 * 60 * 1000; // the server's CHECKOUT_TTL
  var NOT_AVAILABLE = 'המנוי עדיין לא זמין לרכישה.';

  var pollTimer = null;
  var configCache = null;

  async function _headers(extra) {
    return root.JMA_Auth ? root.JMA_Auth.headers(extra) : Object.assign({}, extra || {});
  }

  async function _json(path, opts) {
    var resp = await fetch(BASE + path, opts || {});
    var body = {};
    try { body = await resp.json(); } catch (_) { /* not JSON */ }
    if (!resp.ok) throw new Error((body && body.detail) || ('HTTP ' + resp.status));
    return body;
  }

  /** {enabled, price_label, test}. A server that can't be reached reads as off. */
  async function getConfig(fresh) {
    if (configCache && !fresh) return configCache;
    try {
      configCache = await _json('/config', { headers: await _headers() });
    } catch (_) {
      return { enabled: false };
    }
    return configCache;
  }

  /** Opens the payment page. Returns '' or an error to show. */
  async function startCheckout() {
    var co;
    try {
      co = await _json('/checkout', { method: 'POST', headers: await _headers() });
    } catch (e) {
      return e.message || NOT_AVAILABLE;
    }
    await chrome.storage.local.set({ [PENDING_KEY]: { id: co.checkout_id, at: Date.now() } });
    chrome.tabs.create({ url: co.url });
    watch();
    return '';
  }

  async function _pending() {
    var p = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY];
    if (p && Date.now() - p.at > PENDING_MAX_MS) {
      await chrome.storage.local.remove(PENDING_KEY);
      return null;
    }
    return p || null;
  }

  /** One look at the pending checkout. True once nothing is left to wait for. */
  async function pollOnce() {
    var p = await _pending();
    if (!p) return true;
    var res;
    try {
      res = await _json('/checkout/' + p.id);
    } catch (_) {
      return false; // offline or asleep: try again on the next tick
    }
    if (res.status === 'paid' && res.license_key) {
      await chrome.storage.local.set({
        licenseKey: res.license_key, licenseValid: true, isPremium: true, jma_is_premium: true,
      });
      await chrome.storage.local.remove(PENDING_KEY);
      try { root.dispatchEvent(new Event('jma-billing-claimed')); } catch (_) { /* no window here */ }
      return true;
    }
    if (res.status === 'pending') return false;
    // claimed elsewhere or expired: nothing more will arrive for this checkout
    await chrome.storage.local.remove(PENDING_KEY);
    return true;
  }

  /** Poll while this page is open and a checkout is pending. */
  function watch() {
    if (pollTimer) return;
    var tick = async function () {
      var done = await pollOnce();
      if (done) {
        pollTimer = null;
      } else {
        var p = await _pending();
        var fast = !p || Date.now() - p.at < FAST_FOR_MS;
        pollTimer = setTimeout(tick, fast ? POLL_MS : POLL_SLOW_MS);
      }
    };
    pollTimer = setTimeout(tick, 0);
  }

  async function subscription() {
    return _json('/subscription', { headers: await _headers() });
  }

  async function cancel() {
    return _json('/cancel', { method: 'POST', headers: await _headers() });
  }

  async function resendKey(email) {
    return _json('/resend-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }),
    });
  }

  /** A key this billing issued (the rest are admin or legacy keys). */
  function isOwnKey(key) {
    return /^JMA-/i.test(String(key || '').trim());
  }

  root.JMA_Billing = {
    NOT_AVAILABLE: NOT_AVAILABLE,
    getConfig: getConfig,
    startCheckout: startCheckout,
    pollOnce: pollOnce,
    watch: watch,
    subscription: subscription,
    cancel: cancel,
    resendKey: resendKey,
    isOwnKey: isOwnKey,
  };

  // Pick up a checkout that was started before this page opened.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    _pending().then(function (p) { if (p) watch(); }).catch(function () {});
  }
})(typeof self !== 'undefined' ? self : this);
