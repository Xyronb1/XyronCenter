/**
 * XYRON CENTER - Live theme engine tests
 * (config store bg/fg model, /xyron theme, CMD-style `color`, shell routing)
 * Run: node tests/test-theme-engine.js
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const ConfigStore = require(path.join(__dirname, '..', 'src', 'main', 'config-store'));
const ElevationDaemon = require(path.join(__dirname, '..', 'src', 'main', 'elevation-daemon'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${name}`); }
}

// Isolated temp config file so we never touch the real user config.
const tmpFile = path.join(os.tmpdir(), `xyron-theme-test-${Date.now()}.json`);
const store = new ConfigStore({ filePath: tmpFile });

// --- Defaults: pure black background, pure white text ---
check('default bg is pure black', store.getTheme().bgColor === '#000000');
check('default fg is pure white', store.getTheme().fgColor === '#ffffff');

// --- setTheme: text / background ---
check('fg accepted', store.setTheme('fgColor', '#ff8800').ok === true);
check('fg persisted', store.getTheme().fgColor === '#ff8800');
check('legacy accentColor key maps to text color', store.setTheme('accentColor', '#00ff00').key === 'fgColor');
check('shorthand hex expands', store.setTheme('fgColor', '#f08').value === '#ff0088');
check('missing # accepted', store.setTheme('fgColor', '00ff00').value === '#00ff00');
check('bad hex rejected', store.setTheme('fgColor', 'nothex').ok === false);
check('unknown key rejected', store.setTheme('bogus', 'x').ok === false);
check('bg accepted', store.setTheme('bgColor', '#101010').ok === true);
check('bg == fg rejected', store.setTheme('bgColor', '#00ff00').ok === false);

// --- setThemeColors (used by `color`) ---
const pair = store.setThemeColors('#ffffff', '#000000');
check('setThemeColors ok', pair.ok === true);
check('setThemeColors applied', store.getTheme().bgColor === '#ffffff' && store.getTheme().fgColor === '#000000');
check('setThemeColors same color rejected', store.setThemeColors('#123456', '#123456').ok === false);
check('setThemeColors bad hex rejected', store.setThemeColors('zzz', '#000000').ok === false);

// --- presets (text color preset keeps a black background) ---
store.setThemePreset('amber');
check('preset amber text', store.getTheme().fgColor === '#ffb703');
check('preset resets background to black', store.getTheme().bgColor === '#000000');
check('preset unknown rejected', store.setThemePreset('rainbow').ok === false);

// --- persistence across reload ---
store.setThemePreset('green');
const reloaded = new ConfigStore({ filePath: tmpFile });
check('theme persists to disk', reloaded.getTheme().fgColor === '#2bff4f');

// --- reset ---
store.resetTheme();
check('reset restores black', store.getTheme().bgColor === '#000000');
check('reset restores white', store.getTheme().fgColor === '#ffffff');

// --- daemon harness: collect everything sent to the renderer ---
const sends = [];
const mockWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: (ch, payload) => sends.push({ ch, payload }) }
};
const daemon = new ElevationDaemon({ mainWindow: mockWindow, configStore: store });
daemon.restorePrompt = () => {};
const themeSends = () => sends.filter((s) => s.ch === 'config:theme-updated');

// --- /xyron theme ---
daemon.executeXyronCommand('/xyron theme preset magenta');
check('/xyron theme preset broadcasts', themeSends().length === 1);
check('/xyron theme preset payload', themeSends()[0].payload.theme.fgColor === '#ff5fd7');
daemon.executeXyronCommand('/xyron theme color #123456');
check('/xyron theme color applied', store.getTheme().fgColor === '#123456');
daemon.executeXyronCommand('/xyron theme bg #222222');
check('/xyron theme bg applied', store.getTheme().bgColor === '#222222');

// --- CMD-style `color` through the real Enter-key path ---
function typeLine(d, text) {
  for (const ch of text) d.handleInput(ch);
  return d.handleInput('\r');
}
const before = sends.length;
check('"color a" is intercepted on Enter', typeLine(daemon, 'color a') === true);
check('color a -> light green text', store.getTheme().fgColor === '#2bff4f');
check('color a -> black background', store.getTheme().bgColor === '#000000');
check('color a broadcast the theme', themeSends().length >= 3);

// Success must be SILENT: no terminal text may be injected for a valid color.
const injected = sends.slice(before).filter((s) => s.ch === 'terminal:output');
check('color a prints nothing (silent success)', injected.length === 0);

typeLine(daemon, 'color c');
check('color c -> light red text', store.getTheme().fgColor === '#ff4b57');

typeLine(daemon, 'color f0');
check('color f0 -> white background', store.getTheme().bgColor === '#ffffff');
check('color f0 -> black text', store.getTheme().fgColor === '#000000');

typeLine(daemon, 'color');
check('bare color resets to black', store.getTheme().bgColor === '#000000');
check('bare color resets to white', store.getTheme().fgColor === '#ffffff');

const errBefore = sends.length;
typeLine(daemon, 'color zz');
check('invalid color prints an error', sends.slice(errBefore).some((s) => s.ch === 'terminal:output'));
check('invalid color leaves theme unchanged', store.getTheme().fgColor === '#ffffff');

// A normal command must NOT be swallowed by the color interceptor.
check('"echo color a" is passed through to the shell', typeLine(daemon, 'echo color a') === false);

// --- daemon routes /op command to the right shell (uses shell-router) ---
const execed = [];
const probe = new ElevationDaemon({ configStore: store });
probe.writeToTerminal = () => {};
probe.restorePrompt = () => {};
probe.executeSubCommand = function (cmd) {
  const { routeCommand } = require(path.join(__dirname, '..', 'src', 'main', 'shell-router'));
  execed.push(routeCommand(cmd, { default: this.shellType }));
};
probe.executeOpCommand('/op echo a && echo b');
check('op && routed to cmd', execed.length === 1 && execed[0].shell === 'cmd');
probe.executeOpCommand('/op Get-Process | Select-Object -First 1');
check('op cmdlet routed to powershell', execed[1] && execed[1].shell === 'powershell');

try { fs.unlinkSync(tmpFile); } catch (_e) {}

console.log(`\ntheme-engine: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
