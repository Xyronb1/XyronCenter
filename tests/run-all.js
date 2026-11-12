/**
 * XYRON CENTER - run every test file and print one summary table.
 * Usage:  node tests/run-all.js            (or: npm test)
 *         node tests/run-all.js --fast     (skip the slow stress/challenger suites)
 *
 * Each file runs in its own process with a timeout; exit code 0 = pass.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FAST = process.argv.includes('--fast');
const TIMEOUT_MS = 240000;
const dir = __dirname;

const files = fs.readdirSync(dir)
  .filter((f) => /^(test|challenger)-.*\.js$/.test(f))
  .filter((f) => !(FAST && f.startsWith('challenger-')))
  .sort();

let failed = 0;
const rows = [];

for (const file of files) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(dir, file)], {
    cwd: path.join(dir, '..'),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    env: Object.assign({}, process.env, { XYRON_NO_ELEVATE: '1' })
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const ok = res.status === 0 && !timedOut;
  if (!ok) {
    failed++;
    const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().split(/\r?\n/).slice(-8).join('\n    ');
    rows.push({ file, ok, secs, note: timedOut ? 'TIMEOUT' : `exit ${res.status}`, tail });
  } else {
    rows.push({ file, ok, secs, note: 'ok' });
  }
}

console.log('\n=== XYRON CENTER test results ===');
for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file.padEnd(46)} ${r.secs.padStart(6)}s  ${r.note}`);
  if (!r.ok && r.tail) console.log(`    ${r.tail}`);
}
console.log(`\n${rows.length - failed}/${rows.length} test files passed`);
process.exit(failed === 0 ? 0 : 1);
