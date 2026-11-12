/**
 * Unit tests for the pro terminal helpers (key mapping + paste normalization).
 * Run: node tests/test-terminal-pro.js
 */
const assert = require('assert');
const TerminalView = require('../src/renderer/js/terminal-view.js');

const k = (key, mods = {}) => Object.assign({ type: 'keydown', key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, mods);

assert.strictEqual(TerminalView.keyAction(k('C', { ctrlKey: true, shiftKey: true }), false), 'copy');
assert.strictEqual(TerminalView.keyAction(k('V', { ctrlKey: true, shiftKey: true }), false), 'paste');
assert.strictEqual(TerminalView.keyAction(k('F', { ctrlKey: true, shiftKey: true }), false), 'search');
assert.strictEqual(TerminalView.keyAction(k('K', { ctrlKey: true, shiftKey: true }), false), 'clear');
// Ctrl+C without a selection must stay SIGINT for the shell.
assert.strictEqual(TerminalView.keyAction(k('c', { ctrlKey: true }), false), null);
assert.strictEqual(TerminalView.keyAction(k('c', { ctrlKey: true }), true), 'copy');
assert.strictEqual(TerminalView.keyAction(k('v', { ctrlKey: true }), false), 'paste');
assert.strictEqual(TerminalView.keyAction(k('=', { ctrlKey: true }), false), 'font-up');
assert.strictEqual(TerminalView.keyAction(k('-', { ctrlKey: true }), false), 'font-down');
assert.strictEqual(TerminalView.keyAction(k('0', { ctrlKey: true }), false), 'font-reset');
assert.strictEqual(TerminalView.keyAction(k('Insert', { shiftKey: true }), false), 'paste');
assert.strictEqual(TerminalView.keyAction(k('a'), false), null);
assert.strictEqual(TerminalView.keyAction(k('l', { ctrlKey: true }), false), null);
assert.strictEqual(TerminalView.keyAction(Object.assign(k('v', { ctrlKey: true }), { type: 'keyup' }), false), null);
assert.strictEqual(TerminalView.keyAction(k('v', { ctrlKey: true, altKey: true }), false), null);

assert.strictEqual(TerminalView.preparePaste('dir\r\n'), 'dir');
assert.strictEqual(TerminalView.preparePaste('a\r\nb\nc'), 'a\rb\rc');
assert.strictEqual(TerminalView.preparePaste(''), '');
assert.strictEqual(TerminalView.preparePaste(null), '');

assert.strictEqual(TerminalView.mapInput('\x1b', false), '\x7f');
assert.strictEqual(TerminalView.mapInput('\x1b', true), '\x1b');

console.log('test-terminal-pro: all assertions passed');
