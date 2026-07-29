# JMA content-script test harness

Loads the **real** `matcher.js` + `content.js` (and the extractor out of
`background.js`) into a jsdom page and asserts on what the extension actually
injects. Nothing in the extension is mocked — only the `chrome.*` APIs.

```
cd .jma-test
npm install      # jsdom, once
node run-all.js
```

Two jsdom gaps are polyfilled in `harness.js` because the extension depends on
them: `innerText` (jsdom implements none at all, and the extension relies on its
line breaks) and `offsetParent` (no layout engine, so everything would look
hidden to the "See more" clicker).

| Suite | Covers |
| --- | --- |
| `test-classify.js` | single-job vs. listings decision on 6 page shapes |
| `test-seemore.js` | "See more" expansion, and that Apply is never clicked |
| `test-ranking.js` | ranking runs through matcher.js, not the AI |
| `test-htmltext.js` | `background.js` HTML→text without DOM APIs |
| `test-getjobtext.js` | the `getJobText` message returns expanded text |
| `test-spa.js` | SPA re-routing, no duplicate/stale UI |

To confirm a fix still reproduces against the old code:

```
git show HEAD:content.js > content.before.js
JMA_CONTENT_JS=./content.before.js node test-classify.js
```
