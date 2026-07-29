// Loads the real matcher.js + content.js into a jsdom page and reports what the
// extension injected. No mocks of the code under test — only of the chrome APIs.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const MATCHER = fs.readFileSync(path.join(ROOT, 'matcher.js'), 'utf8');
// JMA_CONTENT_JS lets the suite run against the pre-change file for comparison.
const CONTENT = fs.readFileSync(process.env.JMA_CONTENT_JS || path.join(ROOT, 'content.js'), 'utf8');

function makeChromeStub(storage, log) {
  return {
    runtime: {
      lastError: null,
      onMessage: { addListener: () => {} },
      sendMessage: (msg, cb) => {
        log.messages.push(msg);
        if (msg.action === 'fetchJobDetails') {
          // Simulate the background fetch returning nothing (login walls, CORS),
          // which is the realistic worst case — ranking must still work off cards.
          const texts = (msg.urls || []).map(() => log.fetchedText || '');
          if (cb) setTimeout(() => cb({ texts }), 5);
        } else if (cb) {
          setTimeout(() => cb({}), 5);
        }
        return true;
      },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const k = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of k) if (storage[key] !== undefined) out[key] = storage[key];
          setTimeout(() => cb(out), 1);
        },
        set: (obj, cb) => { Object.assign(storage, obj); if (cb) setTimeout(cb, 1); },
      },
    },
  };
}

async function run({ url, html, storage = {}, waitMs = 7000, fetchedText = '', onReady }) {
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom has no layout, so offsetParent is always null and getClientRects() is
  // always empty — every element would look hidden to the "See more" clicker.
  // Report elements as visible unless the fixture explicitly hides them.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    get() { return this.hasAttribute('data-test-hidden') ? null : this.parentElement; },
    configurable: true,
  });

  // jsdom implements no innerText at all. The extension reads innerText
  // everywhere (and depends on its line breaks), so approximate the real thing:
  // block boundaries and <br> become newlines, hidden subtrees are skipped.
  const BLOCK = new Set(['P','DIV','LI','UL','OL','TR','SECTION','ARTICLE','H1','H2',
                         'H3','H4','H5','H6','DD','DT','BLOCKQUOTE','HEADER','FOOTER',
                         'NAV','ASIDE','MAIN','FORM','TABLE','PRE','FIGURE']);
  function innerTextOf(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      if (child.hasAttribute('data-test-hidden')) continue;
      if (tag === 'BR') { out += '\n'; continue; }
      if (BLOCK.has(tag)) out += '\n' + innerTextOf(child) + '\n';
      else out += innerTextOf(child);
    }
    return out;
  }
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return innerTextOf(this).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); },
    set(v) { this.textContent = v; },
    configurable: true,
  });

  const log = { messages: [], console: [], fetchedText };
  window.chrome = makeChromeStub(storage, log);
  window.console = {
    log: (...a) => log.console.push(a.join(' ')),
    warn: () => {}, error: (...a) => log.console.push('ERR ' + a.join(' ')),
  };

  // Fixture-side behaviour (e.g. a "See more" button that injects the rest of
  // the description) must be wired before the extension runs.
  if (onReady) onReady(window, log);

  try {
    window.eval(MATCHER);
    window.eval(CONTENT);
  } catch (err) {
    return { error: `script threw: ${err.message}`, log, window };
  }

  await new Promise(r => setTimeout(r, waitMs));

  const doc = window.document;
  return {
    fab: !!doc.getElementById('jma-fab-wrap'),
    pill: !!doc.getElementById('jma-float-btn'),
    classified: (log.console.find(l => l.startsWith('[JMA:page] classified')) || '').match(/"(\w+)"/)?.[1] || null,
    log, window, doc,
  };
}

module.exports = { run };
