/**
 * XYRON CENTER - In-shell helper functions
 * File: src/main/shell-helpers.js
 *
 * The /op family used to inject its output into the terminal view directly.
 * That text never passed through ConPTY, so ConPTY's own screen buffer drifted
 * out of sync with the terminal and later output landed on top of earlier
 * lines. Instead, /op now *types a short command into the real shell*, so every
 * byte of output flows through ConPTY and stays in sync.
 *
 * These PowerShell functions are what the typed commands call:
 *
 *   xcmd '<cmd line>'          run a CMD-syntax line (&&, %VAR%, for /f ...) via cmd.exe
 *   xadmin ps|cmd '<line>'     run with admin rights; asks UAC only if not already admin
 *   xsys '<powershell>'        run as NT AUTHORITY\SYSTEM via a one-shot scheduled task
 *
 * The script is written to disk once and dot-sourced when the shell starts.
 * Content is ASCII-only on purpose (PowerShell 5.1 reads BOM-less files as ANSI).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HELPER_FILENAME = 'xyron-shell.ps1';

const HELPER_SCRIPT = String.raw`# XYRON CENTER - in-shell helpers (generated; safe to delete, recreated on start)

$global:XyronHelperDir = $PSScriptRoot

# Print an app message (written by the app to xyron-msg-<id>.txt) through this
# shell, so ConPTY renders it and its screen model stays in sync with the view.
# The app typed "xmsg <id>" to get here; that echoed line is overwritten with
# the prompt + what the user actually typed, then the message follows.
# Record format, one per line:  T|<typed line>   C|<color>|<text>   N (newline)
function xmsg {
  param([string]$Id)
  if ($Id -notmatch '^\d+$') { return }
  $f = Join-Path $global:XyronHelperDir ('xyron-msg-' + $Id + '.txt')
  if (-not (Test-Path -LiteralPath $f)) { return }
  $lines = [IO.File]::ReadAllLines($f, [Text.Encoding]::UTF8)
  Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  $p = [string](prompt)
  $echoLen = $p.Length + ([string]$MyInvocation.Line).Length
  try {
    $w = [Math]::Max(1, [Console]::BufferWidth)
    $rows = [Math]::Max(1, [int][Math]::Ceiling($echoLen / $w))
    [Console]::SetCursorPosition(0, [Math]::Max(0, [Console]::CursorTop - $rows))
  } catch {}
  foreach ($l in $lines) {
    if ($l.StartsWith('T|')) {
      $head = $p + $l.Substring(2)
      if ($head.Length -lt $echoLen) { $head = $head.PadRight($echoLen) }
      Write-Host $head
    } elseif ($l -eq 'N') {
      Write-Host ''
    } elseif ($l.StartsWith('C|')) {
      $parts = $l.Split([char]'|', 3)
      if ($parts.Count -lt 3 -or $parts[2].Length -eq 0) { continue }
      if ($parts[1]) { Write-Host $parts[2] -NoNewline -ForegroundColor $parts[1] }
      else { Write-Host $parts[2] -NoNewline }
    }
  }
  # Never leave the next prompt glued to the end of the message.
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -ne 'N' -and -not $lines[$lines.Count - 1].StartsWith('T|')) { Write-Host '' }
}

function Test-XyronAdmin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Run a CMD-syntax command line through cmd.exe inside this same console.
# The line is handed to cmd.exe verbatim (no PowerShell argument re-quoting), so
# &&, ||, %VAR%, for /f %i, >nul and embedded quotes all behave exactly as in cmd.
# The child inherits this console, so its output flows through ConPTY.
function xcmd {
  $line = ($args -join ' ')
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /s /c "' + $line + '"'
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  $global:LASTEXITCODE = $p.ExitCode
}

# Run with administrator rights. Already admin -> runs right here, no prompt.
# Not admin -> one UAC prompt, command runs in an elevated window.
function xadmin {
  param([string]$Shell, [string]$Cmd)
  if (Test-XyronAdmin) {
    if ($Shell -eq 'cmd') { xcmd $Cmd } else { Invoke-Expression $Cmd }
    return
  }
  try {
    if ($Shell -eq 'cmd') {
      Start-Process -FilePath cmd.exe -Verb RunAs -Wait -ErrorAction Stop -ArgumentList ('/d /s /c "' + $Cmd + ' & pause"')
    } else {
      $e = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Cmd + '; Write-Host; Read-Host ''Enter ile kapat'' | Out-Null'))
      Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ErrorAction Stop -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$e)
    }
  } catch {
    Write-Host ('Yonetici izni verilmedi: ' + $_.Exception.Message) -ForegroundColor Yellow
  }
}

# Run a PowerShell command as NT AUTHORITY\SYSTEM (needs an administrator shell).
function xsys {
  $cmd = ($args -join ' ')
  if (-not (Test-XyronAdmin)) {
    Write-Host 'SYSTEM yetkisi icin uygulamanin yonetici olarak calismasi gerekir.' -ForegroundColor Yellow
    return
  }
  $dir = Join-Path $env:ProgramData 'XyronCenter'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $id  = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $ps1 = Join-Path $dir ('op_' + $id + '.ps1')
  $out = Join-Path $dir ('op_' + $id + '.txt')
  $tn  = 'XyronOp_' + $id
  Set-Content -LiteralPath $ps1 -Value ('[Console]::OutputEncoding=[Text.Encoding]::UTF8' + [Environment]::NewLine + $cmd) -Encoding UTF8
  try {
    $arg = '/c powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $ps1 + '" > "' + $out + '" 2>&1'
    $act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg
    $pri = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $tn -Action $act -Principal $pri -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $tn -ErrorAction Stop
    $t0 = Get-Date
    do {
      Start-Sleep -Milliseconds 200
      $state = (Get-ScheduledTask -TaskName $tn).State
      $last  = (Get-ScheduledTaskInfo -TaskName $tn).LastTaskResult
    } while (($state -eq 'Running' -or $last -eq 267011) -and (((Get-Date) - $t0).TotalSeconds -lt 120))
    Start-Sleep -Milliseconds 250
    if (Test-Path -LiteralPath $out) { Get-Content -LiteralPath $out -Encoding UTF8 }
  } catch {
    Write-Host ('SYSTEM gorevi basarisiz: ' + $_.Exception.Message) -ForegroundColor Red
  } finally {
    Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ps1, $out -Force -ErrorAction SilentlyContinue
  }
}
`;

/**
 * Write the helper script into a directory (idempotent: only rewrites when the
 * content changed). Returns the absolute file path, or null on failure.
 *
 * @param {string} dir
 * @returns {string|null}
 */
function ensureHelperScript(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, HELPER_FILENAME);
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch (_e) {}
    if (current !== HELPER_SCRIPT) fs.writeFileSync(file, HELPER_SCRIPT, 'utf8');
    return file;
  } catch (_e) {
    return null;
  }
}

/**
 * Quote a string as a PowerShell single-quoted literal.
 * @param {string} s
 * @returns {string}
 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ANSI SGR foreground code -> PowerShell ConsoleColor name.
const SGR_TO_CONSOLE_COLOR = {
  30: 'DarkGray', 31: 'Red', 32: 'Green', 33: 'Yellow', 34: 'Blue', 35: 'Magenta', 36: 'Cyan', 37: 'White',
  90: 'DarkGray', 91: 'Red', 92: 'Green', 93: 'Yellow', 94: 'Blue', 95: 'Magenta', 96: 'Cyan', 97: 'White'
};

/**
 * Convert an ANSI-colored message into the record format `xmsg` prints:
 *   T|<typed line>        first line: what the user typed after the prompt
 *   C|<color>|<text>      a text run (color empty = default)
 *   N                     newline
 * Non-color escape sequences are dropped; CR/LF in any form become N.
 *
 * @param {string} typed - the line the user typed (e.g. "/op")
 * @param {string} message - ANSI text that was meant for the terminal
 * @returns {string[]}
 */
function buildMessageRecords(typed, message) {
  const records = [`T|${String(typed || '').replace(/[\r\n]/g, ' ')}`];
  let color = '';
  const text = String(message || '').replace(/^(?:\r?\n|\r)+/, '');
  const tokenRe = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r\n|\n|\r|[^\x1b\r\n]+|\x1b/g;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const tok = m[0];
    if (m[1] !== undefined) {
      const codes = m[1] === '' ? [0] : m[1].split(';').map((c) => parseInt(c, 10));
      for (const c of codes) {
        if (c === 0 || c === 39) color = '';
        else if (SGR_TO_CONSOLE_COLOR[c]) color = SGR_TO_CONSOLE_COLOR[c];
      }
    } else if (tok === '\r\n' || tok === '\n' || tok === '\r') {
      records.push('N');
    } else if (tok[0] !== '\x1b') {
      records.push(`C|${color}|${tok}`);
    }
  }
  return records;
}

module.exports = { HELPER_FILENAME, HELPER_SCRIPT, ensureHelperScript, psQuote, buildMessageRecords };
