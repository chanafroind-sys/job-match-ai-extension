/**
 * The popup's side of buying a subscription (jma-billing.js does the work).
 *
 * - "Buy" links (.jma-buy-link) stay hidden until the server offers a
 *   subscription, then open the payment page.
 * - Under the key field in settings (#jmaSubscriptionBox): the subscription's
 *   state and "cancel" for a key we issued, or "send me my key again" for
 *   someone who bought on another computer.
 * - Until then, the "subscription key" option itself is folded behind a
 *   small "I have a subscription key" link, so users are sent to their own
 *   Claude key.
 * - A key this page collects from a finished payment reloads the popup, so
 *   popup.js starts from the subscribed state.
 *
 * Its own file, loaded after popup.js, so popup.js isn't touched.
 */
(function () {
  'use strict';

  var B = window.JMA_Billing;
  if (!B) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function date(iso) {
    try { return new Date(iso).toLocaleDateString('he-IL'); } catch (_) { return ''; }
  }

  async function currentKey() {
    return ((await chrome.storage.local.get('licenseKey')).licenseKey || '').trim();
  }

  async function showBuyLinks() {
    var cfg = await B.getConfig();
    var key = await currentKey();
    var show = !!cfg.enabled && !B.isOwnKey(key);
    document.querySelectorAll('.jma-buy-link').forEach(function (a) {
      a.hidden = !show;
      if (show && cfg.price_label && !a.dataset.priced) {
        a.dataset.priced = '1';
        a.textContent = a.textContent.replace(' ↗', ' · ' + cfg.price_label + ' לחודש ↗');
      }
    });
    return cfg;
  }

  // Until a subscription can be bought, the "subscription key" option would
  // be a dead end: users are pointed at their own Claude key, and the option
  // stays one click away for whoever holds a key already (admins, testers).
  var revealed = false;
  var LICENSE_BLOCKS = ['keyOptionLicense', 'settingsOptionLicense'];
  var BYOK_SUBTITLE = 'כדי להשתמש ביכולות ה-AI צריך מפתח Claude API אישי.';

  function gateLicenseOption(cfg, key) {
    var show = !!cfg.enabled || !!key || revealed;
    LICENSE_BLOCKS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.style.display = show ? '' : 'none';
      var reveal = document.getElementById(id + 'Reveal');
      if (!reveal && !show) {
        reveal = document.createElement('a');
        reveal.href = '#';
        reveal.id = id + 'Reveal';
        reveal.className = 'key-option-link';
        reveal.style.cssText = 'display:block;margin:8px 0;color:var(--text-dim);font-size:11.5px';
        reveal.textContent = 'יש לי מפתח מנוי';
        reveal.addEventListener('click', function (e) {
          e.preventDefault();
          revealed = true;
          render().catch(function () {});
        });
        el.parentNode.insertBefore(reveal, el.nextSibling);
      }
      if (reveal) reveal.style.display = show ? 'none' : '';
    });
    var or = document.querySelector('#screen-license .key-or');
    if (or) or.style.display = show ? '' : 'none';
    var sub = document.getElementById('keysSubtitle');
    if (sub) {
      if (!sub.dataset.original) sub.dataset.original = sub.textContent;
      sub.textContent = show ? sub.dataset.original : BYOK_SUBTITLE;
    }
  }

  async function onBuy(e) {
    e.preventDefault();
    var a = e.currentTarget;
    var original = a.textContent;
    a.textContent = '⏳ פותחים את דף התשלום…';
    var err = await B.startCheckout();
    a.textContent = err ? original : '⏳ ממתינים לתשלום בלשונית שנפתחה…';
    if (err) renderMessage(err);
  }

  function box() {
    return document.getElementById('jmaSubscriptionBox');
  }

  function renderMessage(text) {
    var el = box();
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
  }

  var STATUS_TEXT = {
    active: function (s) { return '✅ המנוי פעיל · מתחדש ב-' + date(s.current_period_end); },
    past_due: function () { return '⚠️ החיוב האחרון לא עבר. ננסה שוב בימים הקרובים, והמנוי ממשיך לעבוד בינתיים.'; },
    cancelled: function (s) { return 'המנוי בוטל · פעיל עד ' + date(s.current_period_end); },
    expired: function () { return 'המנוי הסתיים.'; },
  };

  async function renderOwnSubscription() {
    var el = box();
    var s;
    try {
      s = await B.subscription();
    } catch (_) {
      el.hidden = true;
      return;
    }
    var text = (STATUS_TEXT[s.status] || STATUS_TEXT.expired)(s);
    el.hidden = false;
    el.innerHTML = esc(text) + (s.email ? '<br><span style="color:var(--text-dim)">' + esc(s.email) + '</span>' : '') +
      (s.status === 'active' || s.status === 'past_due'
        ? '<br><a href="#" id="jmaCancelSub" class="key-option-link" style="color:var(--text-dim)">ביטול המנוי</a>' : '');
    var cancel = document.getElementById('jmaCancelSub');
    if (cancel) cancel.addEventListener('click', onCancel);
  }

  async function onCancel(e) {
    e.preventDefault();
    var a = e.currentTarget;
    if (a.dataset.confirm !== '1') {
      a.dataset.confirm = '1';
      a.textContent = 'לבטל? החיובים הבאים ייעצרו, והמנוי ימשיך לעבוד עד סוף התקופה ששולמה. לחצי שוב לאישור';
      return;
    }
    a.textContent = '⏳ מבטלים…';
    try {
      await B.cancel();
    } catch (err) {
      renderMessage(err.message || 'הביטול לא הצליח. נסי שוב בעוד רגע.');
      return;
    }
    renderOwnSubscription();
  }

  function renderResend() {
    var el = box();
    el.hidden = false;
    el.innerHTML = '<a href="#" id="jmaResendOpen" class="key-option-link">קנית מנוי במחשב אחר? שלחו לי את המפתח למייל</a>';
    document.getElementById('jmaResendOpen').addEventListener('click', function (e) {
      e.preventDefault();
      el.innerHTML = '<input type="email" id="jmaResendEmail" class="license-input" dir="ltr" ' +
        'placeholder="המייל שאיתו נרכש המנוי" style="width:100%;box-sizing:border-box">' +
        '<button type="button" class="btn btn-secondary" id="jmaResendGo" style="margin-top:6px">שליחת מפתח</button>';
      document.getElementById('jmaResendGo').addEventListener('click', onResend);
    });
  }

  async function onResend() {
    var email = (document.getElementById('jmaResendEmail').value || '').trim();
    if (email.indexOf('@') < 1) return;
    try {
      await B.resendKey(email);
    } catch (_) { /* the answer is the same either way */ }
    renderMessage('אם יש מנוי פעיל על המייל הזה, שלחנו אליו מפתח. מדביקים אותו בשדה "מפתח מנוי" למעלה.');
  }

  async function render() {
    var cfg = await showBuyLinks();
    var key = await currentKey();
    gateLicenseOption(cfg, key);
    if (!box()) return;
    if (B.isOwnKey(key)) return renderOwnSubscription();
    if (cfg.enabled && !key) return renderResend();
    box().hidden = true;
  }

  document.querySelectorAll('.jma-buy-link').forEach(function (a) { a.addEventListener('click', onBuy); });
  render().catch(function () {});

  // A payment finished while this popup was open: start over from the subscribed state.
  window.addEventListener('jma-billing-claimed', function () { location.reload(); });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.licenseKey) render().catch(function () {});
  });
})();
