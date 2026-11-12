/**
 * XYRON CENTER - Syntax-Based Shell Router
 * File: src/main/shell-router.js
 *
 * Classifies a raw command line as CMD or PowerShell by inspecting its syntax,
 * so the elevation engine can dispatch each command to the shell that actually
 * understands it. PowerShell is the default host (it runs native executables,
 * cmdlets and most CMD aliases), but a number of constructs are either CMD-only
 * or outright broken under Windows PowerShell 5.1 - those are routed to cmd.exe.
 *
 * Pure, dependency-free and headless-testable: no Electron, no child_process.
 */

'use strict';

/**
 * Explicit routing prefixes the user can type to force a shell, e.g.
 *   /cmd dir /b *.txt
 *   /ps  Get-ChildItem -Recurse
 * Returns { shell, command } when an explicit prefix is present, else null.
 *
 * @param {string} line
 * @returns {{ shell: 'cmd'|'powershell', command: string }|null}
 */
function parseExplicitPrefix(line) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  const m = trimmed.match(/^\/(cmd|ps|powershell)\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const shell = m[1].toLowerCase() === 'cmd' ? 'cmd' : 'powershell';
  return { shell, command: m[2].trim() };
}

// Patterns that are CMD-specific or that Windows PowerShell 5.1 cannot parse.
// Each is a strong signal to route to cmd.exe.
const CMD_SIGNALS = [
  /&&|\|\|/,                 // conditional chaining - PS 5.1 throws on these
  /%[A-Za-z_][A-Za-z0-9_]*%/, // %VAR% environment expansion
  /%%?[A-Za-z]\b/,           // for-loop variables: %i / %%i
  /[12]?>\s*nul\b/i,         // redirection to nul (PS uses $null)
  /\bfor\s+\/[a-z]/i,        // for /f, for /l, for /d
  /\bif\s+(?:not\s+)?exist\b/i,
  /\bif\s+(?:not\s+)?["']?%/i,
  /\bgoto\s+:?\w+/i,
  /\b(?:dir|del|copy|move|ren|type)\b.*\/[a-z]/i, // cmd switches like dir /b, del /q
  /^@/,                      // @echo off style batch lines
  /\bassoc\b|\bftype\b/i,
  /\berrorlevel\b/i
];

// Patterns that are clearly PowerShell. Used to override a weak CMD guess and to
// keep genuine PowerShell on the PowerShell host.
const PS_SIGNALS = [
  /\$(?:env:|_|PSVersionTable|PWD|Host|null\b)/i, // $env: $_ $PSVersionTable ...
  /\$[A-Za-z_][A-Za-z0-9_]*\b/,                   // $variable
  /\b[A-Z][a-z]+-[A-Z][a-zA-Z]+\b/,               // Verb-Noun cmdlets: Get-Process
  /\[[A-Za-z_][\w.]*\]/,                          // [System.IO.Path] / [int]
  /@\(|@\{/,                                       // @( ) array / @{ } hashtable
  /`[nrt]/,                                        // PS escape sequences
  /\bWrite-(?:Host|Output|Error)\b/i,
  /\bForEach-Object\b|\bWhere-Object\b|\bSelect-Object\b/i,
  /-\b(?:eq|ne|gt|lt|ge|le|match|like|contains|and|or|not)\b/i
];

/**
 * Classify a command line as 'cmd' or 'powershell' based on its syntax.
 * Explicit /cmd and /ps prefixes always win. Otherwise CMD-only / PS-5.1-breaking
 * constructs route to cmd.exe, genuine PowerShell constructs stay on PowerShell,
 * and everything else defaults to PowerShell (the superset host).
 *
 * @param {string} command - Raw command line (without any /op prefix)
 * @param {Object} [opts]
 * @param {'cmd'|'powershell'} [opts.default='powershell'] - fallback host
 * @returns {'cmd'|'powershell'}
 */
function classifyShell(command, opts = {}) {
  const fallback = opts.default === 'cmd' ? 'cmd' : 'powershell';
  if (!command || typeof command !== 'string') return fallback;

  const explicit = parseExplicitPrefix(command);
  if (explicit) return explicit.shell;

  const cmd = command.trim();
  if (!cmd) return fallback;

  const hasCmdSignal = CMD_SIGNALS.some((re) => re.test(cmd));
  const hasPsSignal = PS_SIGNALS.some((re) => re.test(cmd));

  // Genuine PowerShell syntax overrides a weak CMD match (e.g. a cmdlet that
  // happens to contain "del" or a redirection). A real CMD-breaking construct
  // like && or %VAR% still wins, because PS 5.1 would simply fail on it.
  const cmdBreaksPs = /&&|\|\||%[A-Za-z_][A-Za-z0-9_]*%|\bfor\s+\/[a-z]/i.test(cmd);

  if (cmdBreaksPs) return 'cmd';
  if (hasPsSignal) return 'powershell';
  if (hasCmdSignal) return 'cmd';
  return fallback;
}

/**
 * Resolve a raw line into the shell and the command to run, honoring explicit
 * prefixes and auto-detection. Convenience wrapper for the elevation engine.
 *
 * @param {string} line
 * @param {Object} [opts]
 * @param {'cmd'|'powershell'} [opts.default='powershell']
 * @returns {{ shell: 'cmd'|'powershell', command: string, explicit: boolean }}
 */
function routeCommand(line, opts = {}) {
  const explicit = parseExplicitPrefix(line);
  if (explicit) {
    return { shell: explicit.shell, command: explicit.command, explicit: true };
  }
  const command = (line || '').trim();
  return { shell: classifyShell(command, opts), command, explicit: false };
}

module.exports = {
  classifyShell,
  routeCommand,
  parseExplicitPrefix,
  CMD_SIGNALS,
  PS_SIGNALS
};
