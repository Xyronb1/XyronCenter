/**
 * XYRON CENTER - Command palette (Ctrl+Shift+P)
 * File: src/renderer/js/command-palette.js
 *
 * One searchable list for terminal actions, live theme presets and ready-made
 * PowerShell diagnostics. Read-only queries run right away; anything that
 * changes the system (DNS flush, SFC, DISM ...) is only put at the prompt so
 * the user confirms it with Enter. Shift+Enter always just inserts.
 */

'use strict';

/**
 * @typedef {Object} PaletteItem
 * @property {string} id
 * @property {string} group
 * @property {string} title
 * @property {string} [hint]     extra words for searching, shown dimmed
 * @property {string} [action]   terminal action name (TerminalView.runAction)
 * @property {string} [command]  line to put at the prompt
 * @property {boolean} [run]     execute the command immediately
 */

/** @type {PaletteItem[]} */
const DEFAULT_ITEMS = [
  // Terminal
  { id: 'save-log', group: 'TERMINAL', title: 'Save terminal output to file', hint: 'log export Ctrl+Shift+S', action: 'save-log' },
  { id: 'find', group: 'TERMINAL', title: 'Search scrollback', hint: 'find Ctrl+Shift+F', action: 'search' },
  { id: 'clear', group: 'TERMINAL', title: 'Clear scrollback', hint: 'cls Ctrl+Shift+K', action: 'clear' },
  { id: 'font-up', group: 'TERMINAL', title: 'Bigger text', hint: 'font zoom Ctrl+=', action: 'font-up' },
  { id: 'font-down', group: 'TERMINAL', title: 'Smaller text', hint: 'font zoom Ctrl+-', action: 'font-down' },
  { id: 'font-reset', group: 'TERMINAL', title: 'Reset text size', hint: 'font zoom Ctrl+0', action: 'font-reset' },
  { id: 'explorer-here', group: 'TERMINAL', title: 'Open current folder in Explorer', hint: 'explorer .', command: 'explorer .', run: true },

  // Diagnostics (read-only, run immediately)
  { id: 'ports', group: 'NETWORK', title: 'Listening ports and their process', hint: 'netstat port pid',
    command: `Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Select-Object LocalAddress,LocalPort,OwningProcess,@{n='Process';e={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}} | Format-Table -AutoSize`, run: true },
  { id: 'ipconfig', group: 'NETWORK', title: 'IP configuration', hint: 'ipconfig /all adapter dns gateway', command: 'ipconfig /all', run: true },
  { id: 'ping', group: 'NETWORK', title: 'Internet check (ping 1.1.1.1)', hint: 'ping latency', command: 'ping -n 4 1.1.1.1', run: true },
  { id: 'top-cpu', group: 'SYSTEM', title: 'Top processes by CPU time', hint: 'process cpu usage',
    command: `Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,Id,@{n='CPU(s)';e={[math]::Round($_.CPU,1)}},@{n='RAM(MB)';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize`, run: true },
  { id: 'top-ram', group: 'SYSTEM', title: 'Top processes by memory', hint: 'process ram usage',
    command: `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name,Id,@{n='RAM(MB)';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize`, run: true },
  { id: 'disks', group: 'SYSTEM', title: 'Drive usage', hint: 'disk free space storage',
    command: `Get-PSDrive -PSProvider FileSystem | Format-Table Name,@{n='Used(GB)';e={[math]::Round($_.Used/1GB,1)}},@{n='Free(GB)';e={[math]::Round($_.Free/1GB,1)}},Root -AutoSize`, run: true },
  { id: 'os-info', group: 'SYSTEM', title: 'Windows version and last boot', hint: 'os build uptime',
    command: 'Get-CimInstance Win32_OperatingSystem | Format-List Caption,Version,BuildNumber,OSArchitecture,LastBootUpTime', run: true },
  { id: 'services', group: 'SYSTEM', title: 'Running services', hint: 'service list',
    command: `Get-Service | Where-Object Status -eq 'Running' | Sort-Object DisplayName | Format-Table Name,DisplayName -AutoSize`, run: true },
  { id: 'startup', group: 'SYSTEM', title: 'Startup programs', hint: 'autorun boot',
    command: 'Get-CimInstance Win32_StartupCommand | Format-Table Name,Command,Location -AutoSize -Wrap', run: true },
  { id: 'errors', group: 'SYSTEM', title: 'Last 20 system errors', hint: 'event log crash',
    command: `Get-WinEvent -FilterHashtable @{LogName='System';Level=1,2} -MaxEvents 20 -ErrorAction SilentlyContinue | Format-Table TimeCreated,Id,ProviderName,Message -AutoSize -Wrap`, run: true },
  { id: 'path', group: 'SYSTEM', title: 'PATH entries', hint: 'environment variable', command: `$env:Path -split ';'`, run: true },
  { id: 'big-files', group: 'SYSTEM', title: 'Largest files under this folder', hint: 'size disk space cleanup',
    command: `Get-ChildItem -File -Recurse -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 15 @{n='MB';e={[math]::Round($_.Length/1MB,1)}},FullName | Format-Table -AutoSize` },

  // Changes the system: inserted only, Enter confirms
  { id: 'flushdns', group: 'REPAIR', title: 'Flush DNS cache', hint: 'network dns reset', command: 'ipconfig /flushdns' },
  { id: 'sfc', group: 'REPAIR', title: 'System file check (SFC)', hint: 'repair corrupt windows', command: 'sfc /scannow' },
  { id: 'dism', group: 'REPAIR', title: 'Repair Windows image (DISM)', hint: 'repair component store', command: 'DISM /Online /Cleanup-Image /RestoreHealth' },

  // Live theme + identity (handled by the app itself)
  { id: 'theme-white', group: 'THEME', title: 'Theme: white on black', hint: 'color reset default', command: '/xyron theme reset', run: true },
  { id: 'theme-green', group: 'THEME', title: 'Theme: green', hint: 'color matrix', command: '/xyron theme preset green', run: true },
  { id: 'theme-amber', group: 'THEME', title: 'Theme: amber', hint: 'color retro', command: '/xyron theme preset amber', run: true },
  { id: 'theme-cyan', group: 'THEME', title: 'Theme: cyan', hint: 'color', command: '/xyron theme preset cyan', run: true },
  { id: 'theme-red', group: 'THEME', title: 'Theme: red', hint: 'color', command: '/xyron theme preset red', run: true },
  { id: 'boot-preview', group: 'THEME', title: 'Replay boot intro', hint: 'animation splash', command: '/xyron boot preview', run: true },
  { id: 'whoami', group: 'THEME', title: 'Show security context', hint: 'admin op whoami', command: '/op whoami', run: true }
];

/**
 * Case-insensitive filter: every space-separated word of the query must
 * appear (as a word prefix or substring) in title + hint + group + command.
 * Title matches rank first. Pure, so it can be unit tested.
 *
 * @param {PaletteItem[]} items
 * @param {string} query
 * @returns {PaletteItem[]}
 */
function filterItems(items, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice();
  const scored = [];
  items.forEach((item, index) => {
    const title = String(item.title || '').toLowerCase();
    const hay = `${title} ${item.hint || ''} ${item.group || ''} ${item.command || ''}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return;
    const score = words.reduce((s, w) => s + (title.includes(w) ? 2 : 0) + (title.startsWith(w) ? 1 : 0), 0);
    scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}

class CommandPalette {
  /**
   * @param {{ terminalView: Object, items?: PaletteItem[] }} options
   */
  constructor(options = {}) {
    this.terminalView = options.terminalView || null;
    this.items = options.items || DEFAULT_ITEMS;
    this.filtered = this.items.slice();
    this.index = 0;
    this.dom = {
      root: document.getElementById('cmd-palette'),
      input: document.getElementById('cmd-palette-input'),
      list: document.getElementById('cmd-palette-list')
    };
    this._bound = false;
  }

  init() {
    const { root, input, list } = this.dom;
    if (!root || !input || !list || this._bound) return;
    this._bound = true;

    input.addEventListener('input', () => this.render(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
      else if (e.key === 'PageDown') { e.preventDefault(); this.move(8); }
      else if (e.key === 'PageUp') { e.preventDefault(); this.move(-8); }
      else if (e.key === 'Enter') { e.preventDefault(); this.execute(this.filtered[this.index], e.shiftKey); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    // Click outside the box closes the palette.
    root.addEventListener('mousedown', (e) => { if (e.target === root) this.close(); });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-index]');
      if (row) this.execute(this.filtered[Number(row.getAttribute('data-index'))], e.shiftKey);
    });
  }

  get isOpen() {
    return !!(this.dom.root && !this.dom.root.classList.contains('hidden'));
  }

  open() {
    const { root, input } = this.dom;
    if (!root || !input) return;
    if (this.isOpen) { this.close(); return; }
    root.classList.remove('hidden');
    input.value = '';
    this.render('');
    input.focus();
  }

  close() {
    if (this.dom.root) this.dom.root.classList.add('hidden');
    if (this.terminalView) this.terminalView.focus();
  }

  move(delta) {
    if (!this.filtered.length) return;
    this.index = Math.max(0, Math.min(this.filtered.length - 1, this.index + delta));
    this._highlight();
  }

  render(query) {
    const { list } = this.dom;
    if (!list) return;
    this.filtered = filterItems(this.items, query);
    this.index = 0;
    list.innerHTML = '';
    if (!this.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'cmd-empty';
      empty.textContent = 'no match';
      list.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    let lastGroup = '';
    this.filtered.forEach((item, i) => {
      if (!query && item.group !== lastGroup) {
        lastGroup = item.group;
        const head = document.createElement('div');
        head.className = 'cmd-group';
        head.textContent = item.group;
        frag.appendChild(head);
      }
      const row = document.createElement('div');
      row.className = 'cmd-row';
      row.setAttribute('data-index', String(i));
      const title = document.createElement('span');
      title.className = 'cmd-title';
      title.textContent = item.title;
      const tag = document.createElement('span');
      tag.className = 'cmd-tag';
      tag.textContent = item.action ? 'ACTION' : (item.run ? 'RUN' : 'INSERT');
      row.appendChild(title);
      row.appendChild(tag);
      if (item.command) {
        const cmd = document.createElement('span');
        cmd.className = 'cmd-preview';
        cmd.textContent = item.command;
        cmd.title = item.command;
        row.appendChild(cmd);
      }
      row.addEventListener('mousemove', () => { if (this.index !== i) { this.index = i; this._highlight(); } });
      frag.appendChild(row);
    });
    list.appendChild(frag);
    this._highlight();
  }

  /** @private */
  _highlight() {
    const rows = this.dom.list ? this.dom.list.querySelectorAll('.cmd-row') : [];
    rows.forEach((row) => {
      const active = Number(row.getAttribute('data-index')) === this.index;
      row.classList.toggle('active', active);
      if (active && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    });
  }

  /**
   * @param {PaletteItem} item
   * @param {boolean} [insertOnly=false] - Shift held: never execute
   */
  execute(item, insertOnly = false) {
    if (!item || !this.terminalView) return;
    this.close();
    if (item.action) {
      this.terminalView.runAction(item.action);
      return;
    }
    if (typeof item.command === 'string') {
      this.terminalView.insertLine(item.command, item.run === true && !insertOnly);
    }
  }
}

if (typeof window !== 'undefined') {
  window.CommandPalette = CommandPalette;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CommandPalette;
  module.exports.filterItems = filterItems;
  module.exports.DEFAULT_ITEMS = DEFAULT_ITEMS;
}
