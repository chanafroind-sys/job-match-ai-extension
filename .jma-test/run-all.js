const { execFileSync } = require('child_process');
const SUITES = ['test-classify.js', 'test-seemore.js', 'test-ranking.js', 'test-htmltext.js', 'test-getjobtext.js', 'test-spa.js', 'test-poolmatch.js', 'test-auth.js', 'test-nokey-quiet.js'];
let failed = 0;
for (const s of SUITES) {
  console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 50 - s.length))}`);
  try {
    console.log(execFileSync(process.execPath, [s], { cwd: __dirname, encoding: 'utf8' }).trim());
  } catch (e) {
    console.log((e.stdout || '').trim() || e.message);
    failed++;
  }
}
console.log(`\n${'='.repeat(56)}\n${SUITES.length - failed}/${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
