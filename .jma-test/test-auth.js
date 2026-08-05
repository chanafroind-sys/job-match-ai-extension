// Exercises the real jma-auth.js against a stubbed chrome.storage. This is the
// one module every surface (popup, sidebar, service worker) shares, so a
// regression here silently changes how all three pick a key and word an error.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AUTH_SRC = fs.readFileSync(path.join(__dirname, '..', 'jma-auth.js'), 'utf8');

let passed = 0, failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}`); }
  if (detail) console.log(`    ${detail}`);
}

function load(storage) {
  const sandbox = {
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            for (const k of (Array.isArray(keys) ? keys : [keys])) {
              if (storage[k] !== undefined) out[k] = storage[k];
            }
            setTimeout(() => cb(out), 0);
          },
        },
      },
    },
    setTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(AUTH_SRC, sandbox);
  return sandbox.JMA_Auth;
}

(async () => {
  const LIC = 'ABCD-1234-5678-WXYZ';
  const OWN = 'sk-ant-api03-abcdefghij1234567890';

  // ── Resolution order ───────────────────────────────────────────────────────
  let A = load({ licenseKey: LIC, anthropicKey: OWN });
  let keys = await A.getKeys();
  ok('subscription wins when both keys are present', keys.mode === 'license',
     `mode=${keys.mode}`);

  A = load({ anthropicKey: OWN });
  keys = await A.getKeys();
  ok('personal key alone selects byok mode', keys.mode === 'byok', `mode=${keys.mode}`);

  A = load({});
  keys = await A.getKeys();
  ok('no keys reports mode none', keys.mode === 'none' && !keys.hasAny, `mode=${keys.mode}`);

  A = load({ licenseKey: '   ' });
  ok('a whitespace-only key does not count as configured', !(await A.hasKey()));

  // ── Headers ────────────────────────────────────────────────────────────────
  A = load({ licenseKey: LIC, anthropicKey: OWN });
  let h = await A.headers({ 'Content-Type': 'application/json' });
  ok('both keys are sent so the server can pick',
     h['X-License-Key'] === LIC && h['X-Anthropic-Key'] === OWN);
  ok('caller headers are preserved', h['Content-Type'] === 'application/json');

  A = load({ licenseKey: LIC });
  h = await A.headers();
  ok('an absent personal key sends no empty header', !('X-Anthropic-Key' in h),
     `keys=${Object.keys(h).join(',')}`);

  // ── Error codes ────────────────────────────────────────────────────────────
  A = load({});
  const credit = 'נגמרו הקרדיטים בחשבון שלך. [jma:AI_NO_CREDIT]';
  ok('code is extracted', A.errorCode(credit) === 'AI_NO_CREDIT');
  ok('code is stripped from the displayed text', !A.friendly(credit).includes('[jma:'),
     A.friendly(credit));

  ok('a missing key opens the key screen', A.needsKeySetup(A.noKeyError()));
  ok('a rejected key opens the key screen',
     A.needsKeySetup('bad key [jma:AI_KEY_INVALID]'));
  ok('an empty wallet does NOT open the key screen', !A.needsKeySetup(credit),
     'the fix is topping up, not re-entering the key');
  ok('a rate limit does NOT open the key screen',
     !A.needsKeySetup('slow down [jma:AI_RATE_LIMIT]'));
  ok('a subscription-only feature does NOT open the key screen',
     !A.needsKeySetup(A.subscriptionOnlyError()));

  // ── Legacy uncoded errors still map to something readable ──────────────────
  ok('an uncoded transport error still gets Hebrew',
     A.friendly('HTTP 502 Bad Gateway').length > 10, A.friendly('HTTP 502 Bad Gateway'));
  ok('an empty message never renders blank', A.friendly('').length > 0);
  ok('the monthly-cap message now mentions the personal-key escape hatch',
     A.friendly('monthly usage limit reached').includes('Claude API'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
