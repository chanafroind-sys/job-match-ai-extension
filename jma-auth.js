/**
 * Shared key handling for every part of the extension.
 *
 * A user pays for AI calls one of two ways:
 *   1. A Gumroad subscription key — the call runs on the server's Claude key.
 *   2. Their own Claude API key   — the call runs on their key and their credits.
 *
 * Both are sent on every request; the server picks the subscription first and
 * falls back to the personal key, so this file never has to decide. What it does
 * own is: where the keys live, how they reach the server, and how a server error
 * turns into a sentence the user can act on.
 *
 * Loaded as a plain script by popup.html, as a content script (manifest), and by
 * the service worker via importScripts — hence globalThis rather than window.
 */
(function (root) {
  'use strict';

  var LICENSE_KEY_FIELD   = 'licenseKey';
  var ANTHROPIC_KEY_FIELD = 'anthropicKey';

  var GUMROAD_URL = 'https://expertdevai.gumroad.com/l/job-match-ai';
  var CONSOLE_KEYS_URL = 'https://console.anthropic.com/settings/keys';
  var CONSOLE_BILLING_URL = 'https://console.anthropic.com/settings/billing';

  // Codes the server appends as "…message [jma:CODE]".
  var CODES = {
    NO_KEY:      'AI_NO_KEY',
    // Client-side only: the community features (points, referrals, recruiter
    // directory) are what the subscription buys. A personal Claude key pays for
    // AI calls and nothing else, so it can't unlock them.
    LICENSE_ONLY: 'LICENSE_REQUIRED',
    KEY_INVALID: 'AI_KEY_INVALID',
    NO_CREDIT:   'AI_NO_CREDIT',
    RATE_LIMIT:  'AI_RATE_LIMIT',
    KEY_DENIED:  'AI_KEY_DENIED',
    UNAVAILABLE: 'AI_UNAVAILABLE',
  };

  var CODE_RE = /\s*\[jma:([A-Z_]+)\]\s*/;

  function _get(fields) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(fields, function (data) { resolve(data || {}); });
    });
  }

  /** Both keys plus which mode the next AI call will run in. */
  async function getKeys() {
    var data = await _get([LICENSE_KEY_FIELD, ANTHROPIC_KEY_FIELD, 'licenseValid']);
    var license = (data[LICENSE_KEY_FIELD] || '').trim();
    var own = (data[ANTHROPIC_KEY_FIELD] || '').trim();
    return {
      licenseKey: license,
      anthropicKey: own,
      // Mirrors the server's resolution order exactly.
      mode: license ? 'license' : (own ? 'byok' : 'none'),
      hasAny: !!(license || own),
    };
  }

  /** True when at least one key is configured — the gate for any AI action. */
  async function hasKey() {
    return (await getKeys()).hasAny;
  }

  /** Auth headers for a backend call, merged over whatever else you pass. */
  async function headers(extra) {
    var keys = await getKeys();
    var out = Object.assign({}, extra || {});
    out['X-License-Key'] = keys.licenseKey;
    // Omitted rather than sent empty: an empty header on a proxy that strips
    // blanks is fine, but a present-but-empty key would read as "user has a key".
    if (keys.anthropicKey) out['X-Anthropic-Key'] = keys.anthropicKey;
    return out;
  }

  /**
   * The "you have no key yet" error, worded and coded exactly like the server's
   * so a locally-detected miss and a server-detected one travel the same path.
   */
  function noKeyError() {
    return 'כדי להשתמש ביכולות ה-AI צריך מפתח אחד משניים: מפתח מנוי מ-Gumroad, ' +
           'או מפתח Claude API אישי. אפשר להזין אותו בהגדרות ⚙️. [jma:' + CODES.NO_KEY + ']';
  }

  /** The error for a community feature reached without a Gumroad subscription. */
  function subscriptionOnlyError() {
    return 'הפיצ\'ר הזה זמין למנויים בלבד. מפתח Claude API אישי מכסה קריאות AI, ' +
           'אבל למאגר המגייסים, לנקודות ולהפניות צריך מפתח מנוי מ-Gumroad ' +
           '(אפשר לרכוש ולהזין בהגדרות ⚙️). [jma:' + CODES.LICENSE_ONLY + ']';
  }

  /** Split a server error into its machine code and the text meant for the user. */
  function parseError(message) {
    var text = String(message || '');
    var match = text.match(CODE_RE);
    return {
      code: match ? match[1] : '',
      text: match ? text.replace(CODE_RE, ' ').trim() : text.trim(),
    };
  }

  /**
   * Should this failure send the user to the key screen? Only when the fix is
   * literally "enter or replace a key" — an empty wallet or a rate limit are
   * things the user fixes elsewhere, and reopening the key form would mislead.
   */
  function needsKeySetup(message) {
    var code = parseError(message).code;
    return code === CODES.NO_KEY || code === CODES.KEY_INVALID;
  }

  function errorCode(message) {
    return parseError(message).code;
  }

  /**
   * A sentence the user can act on. Server messages already arrive written for
   * the user, so they pass through untouched (minus the code); everything else
   * is a transport-level failure this maps to plain Hebrew.
   */
  function friendly(message) {
    var parsed = parseError(message);
    if (parsed.code) return parsed.text;

    var msg = parsed.text;
    if (!msg) return 'קרתה תקלה לא צפויה. נסי שוב.';
    var lo = msg.toLowerCase();

    if (lo.includes('devices') || lo.includes('already activated')) {
      return 'הרישיון כבר בשימוש במספר מקסימלי של מכשירים.';
    }
    if (msg.includes('401') || msg.includes('403') ||
        (lo.includes('invalid') && lo.includes('license')) ||
        lo.includes('expired license') || lo.includes('license key')) {
      return 'המפתח אינו בתוקף או שלא הוגדר. אנא הזן מפתח תקין בהגדרות ⚙️ כדי להמשיך.';
    }
    if (msg.includes('429') || lo.includes('monthly usage') || lo.includes('monthly limit')) {
      return 'הגעת למגבלה החודשית (100 ניתוחים). המכסה מתחדשת ב-1 לחודש הבא, ' +
             'או שאפשר להזין מפתח Claude API אישי בהגדרות ⚙️ ולהמשיך מיד.';
    }
    if (lo.includes('אין חיבור') || lo.includes('internet') || lo.includes('network') ||
        lo.includes('cannot reach')) {
      return 'אין חיבור לאינטרנט או שהשירות לא זמין. בדקי את החיבור ונסי שוב.';
    }
    if (lo.includes('מתעורר') || lo.includes('waking') || msg.includes('502') || msg.includes('503')) {
      return 'האפליקציה מתעוררת — זה יכול לקחת עד דקה. נסי שוב בעוד רגע.';
    }
    if (lo.includes('לא הצלחנו') || lo.includes('מגבלה') || lo.includes('רישיון') ||
        lo.includes('אימייל') || lo.includes('מגייס') || lo.includes('עובד')) return msg;
    return 'משהו השתבש. נסי שוב בעוד רגע.';
  }

  root.JMA_Auth = {
    LICENSE_KEY_FIELD: LICENSE_KEY_FIELD,
    ANTHROPIC_KEY_FIELD: ANTHROPIC_KEY_FIELD,
    GUMROAD_URL: GUMROAD_URL,
    CONSOLE_KEYS_URL: CONSOLE_KEYS_URL,
    CONSOLE_BILLING_URL: CONSOLE_BILLING_URL,
    CODES: CODES,
    getKeys: getKeys,
    hasKey: hasKey,
    noKeyError: noKeyError,
    subscriptionOnlyError: subscriptionOnlyError,
    headers: headers,
    parseError: parseError,
    errorCode: errorCode,
    needsKeySetup: needsKeySetup,
    friendly: friendly,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
