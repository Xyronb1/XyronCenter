/**
 * XYRON CENTER - Shell Router unit tests
 * Run: node tests/test-shell-router.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { classifyShell, routeCommand, parseExplicitPrefix } =
  require(path.join(__dirname, '..', 'src', 'main', 'shell-router'));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    pass++;
  } catch (_e) {
    fail++;
    console.error(`  FAIL: ${name} -> got "${actual}", expected "${expected}"`);
  }
}

// --- Explicit prefixes always win ---
check('explicit /cmd', classifyShell('/cmd dir /b'), 'cmd');
check('explicit /ps', classifyShell('/ps Get-Process'), 'powershell');
check('explicit /powershell', classifyShell('/powershell $env:PATH'), 'powershell');
check('prefix strips command', parseExplicitPrefix('/cmd  dir /b *.txt').command, 'dir /b *.txt');

// --- CMD-only / PS-5.1-breaking syntax -> cmd ---
check('&& chaining', classifyShell('echo a && echo b'), 'cmd');
check('|| chaining', classifyShell('ping x || echo fail'), 'cmd');
check('%VAR% expansion', classifyShell('echo %USERNAME%'), 'cmd');
check('for /f loop', classifyShell('for /f %i in (list.txt) do echo %i'), 'cmd');
check('redirect to nul', classifyShell('ipconfig /all >nul'), 'cmd');
check('if exist', classifyShell('if exist C:\\x.txt del C:\\x.txt'), 'cmd');
check('dir switch', classifyShell('dir /b /s'), 'cmd');
check('del switch', classifyShell('del /q /s temp'), 'cmd');
check('@echo batch', classifyShell('@echo off'), 'cmd');

// --- Genuine PowerShell -> powershell ---
check('cmdlet Verb-Noun', classifyShell('Get-ChildItem -Recurse'), 'powershell');
check('$env variable', classifyShell('$env:PATH -split ";"'), 'powershell');
check('pipeline cmdlet', classifyShell('Get-Process | Where-Object { $_.CPU -gt 10 }'), 'powershell');
check('type accelerator', classifyShell('[System.IO.Path]::GetTempPath()'), 'powershell');
check('comparison operator', classifyShell('1 -eq 1'), 'powershell');

// --- PS signal overrides a weak CMD match ---
check('cmdlet with redirect stays PS', classifyShell('Get-Process > out.txt'), 'powershell');

// --- Neutral commands default to PowerShell (superset host) ---
check('plain exe', classifyShell('ipconfig'), 'powershell');
check('whoami', classifyShell('whoami /groups'), 'powershell');
check('empty -> default', classifyShell(''), 'powershell');
check('default override', classifyShell('ipconfig', { default: 'cmd' }), 'cmd');

// --- routeCommand wrapper ---
const r1 = routeCommand('/cmd dir /b');
check('routeCommand explicit shell', r1.shell, 'cmd');
check('routeCommand explicit flag', r1.explicit, true);
check('routeCommand explicit command', r1.command, 'dir /b');
const r2 = routeCommand('Get-Process');
check('routeCommand auto shell', r2.shell, 'powershell');
check('routeCommand auto flag', r2.explicit, false);

console.log(`\nshell-router: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
