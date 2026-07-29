// popup.js asks the content script for the job text via chrome.runtime message
// 'getJobText'. That response must now carry the expanded description.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const F = require('./fixtures');

const ROOT = path.resolve(__dirname, '..');
const MATCHER = fs.readFileSync(path.join(ROOT, 'matcher.js'), 'utf8');
const CONTENT = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

(async () => {
  const dom = new JSDOM(F.linkedinTruncated, {
    url: 'https://www.linkedin.com/jobs/view/4055555555/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    get() { return this.parentElement; }, configurable: true,
  });
  const BLOCK = new Set(['P','DIV','LI','UL','OL','TR','SECTION','ARTICLE','H1','H2','H3','H4','H5','H6','HEADER','FOOTER','NAV','MAIN']);
  function innerTextOf(node) {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { out += c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      if (['SCRIPT','STYLE','NOSCRIPT'].includes(c.tagName)) continue;
      if (c.tagName === 'BR') { out += '\n'; continue; }
      out += BLOCK.has(c.tagName) ? '\n' + innerTextOf(c) + '\n' : innerTextOf(c);
    }
    return out;
  }
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return innerTextOf(this).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); },
    set(v) { this.textContent = v; }, configurable: true,
  });

  // Wire the fixture's "See more" to inject the rest, as LinkedIn does.
  const jd = window.document.getElementById('jd');
  window.document.querySelector('.jobs-description__footer-button')
    .addEventListener('click', function () {
      this.setAttribute('aria-expanded', 'true');
      jd.innerHTML += '<br>' + F.JD_TAIL.replace(/\n/g, '<br>');
    });

  let listener = null;
  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendMessage: (m, cb) => { if (cb) setTimeout(() => cb({}), 5); return true; },
    },
    storage: { local: { get: (k, cb) => setTimeout(() => cb({}), 1), set: (o, cb) => cb && cb() } },
  };
  window.console = { log: () => {}, warn: () => {}, error: () => {} };

  window.eval(MATCHER);
  window.eval(CONTENT);

  const results = [];
  const check = (n, ok, d) => results.push({ name: n, ok, detail: d });

  check('content.js registered a message listener', typeof listener === 'function', `typeof=${typeof listener}`);

  const resp = await new Promise((resolve) => {
    const kept = listener({ action: 'getJobText' }, {}, resolve);
    check('getJobText keeps the response channel open (returns true)', kept === true, `returned ${kept}`);
    setTimeout(() => resolve(null), 5000);
  });

  check('getJobText responded', !!resp, resp ? `keys=${Object.keys(resp).join(',')}` : 'timed out — sendResponse never fired');
  check('response text includes the "See more" tail',
        !!resp && resp.text.includes(F.TRUNCATED_TAIL_MARKER),
        resp ? `len=${resp.text.length} marker=${resp.text.includes(F.TRUNCATED_TAIL_MARKER)}` : 'n/a');
  check('response still carries language/platform/url',
        !!resp && resp.platform === 'LinkedIn' && !!resp.language && !!resp.url,
        resp ? `platform=${resp.platform} language=${resp.language}` : 'n/a');

  let fail = 0;
  for (const t of results) { console.log(`${t.ok ? '✓' : '✗'} ${t.name}\n    ${t.detail}`); if (!t.ok) fail++; }
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
