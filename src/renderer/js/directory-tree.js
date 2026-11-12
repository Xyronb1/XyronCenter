/**
 * XYRON CENTER - Active Directory Tree Explorer
 * File: src/renderer/js/directory-tree.js
 * 
 * Synchronized with native ConPTY terminal CWD. Features interactive breadcrumbs,
 * horizontal file cards, double-click terminal navigation, and debounced file watcher updates.
 */

class DirectoryTree {
  constructor(options = {}) {
    this.currentPath = '';
    this.entries = [];
    this.unsubscribeWatcher = null;
    // Called with an absolute path to type it at the terminal prompt.
    this.onInsertPath = options.onInsertPath || null;
    this._menuCloser = null;
    this._badgeTimer = null;

    this.dom = {
      menu: document.getElementById('dir-menu'),
      breadcrumbs: document.getElementById('dir-breadcrumbs'),
      treeList: document.getElementById('dir-tree-list'),
      syncBadge: document.getElementById('dir-sync-badge'),
      btnRefresh: document.getElementById('btn-dir-refresh')
    };
  }

  /**
   * Initializes event listeners and fs watcher subscription.
   */
  init() {
    // 1. Manual Refresh Button
    if (this.dom.btnRefresh) {
      this.dom.btnRefresh.addEventListener('click', () => {
        if (this.currentPath) this.loadDirectory(this.currentPath);
      });
    }

    // 2. Real-time Filesystem Watcher Listener
    if (window.fsApi && typeof window.fsApi.onDirUpdated === 'function') {
      this.unsubscribeWatcher = window.fsApi.onDirUpdated((dirPath) => {
        if (!dirPath || dirPath.toLowerCase() === this.currentPath.toLowerCase()) {
          this.loadDirectory(this.currentPath, true);
        }
      });
    }
  }

  /**
   * Loads and renders contents of the specified path.
   * @param {string} targetPath - Directory path to inspect
   * @param {boolean} [silent=false] - Whether to suppress sync badge animation
   */
  async loadDirectory(targetPath, silent = false) {
    if (!targetPath || typeof targetPath !== 'string') return;
    this.currentPath = targetPath.trim();

    this._renderBreadcrumbs(this.currentPath);

    if (!window.fsApi || typeof window.fsApi.readDir !== 'function') {
      this._renderError('Filesystem API unavailable');
      return;
    }

    try {
      // Register active watcher
      if (window.fsApi.watchDir) {
        window.fsApi.watchDir(this.currentPath).catch(() => {});
      }

      const items = await window.fsApi.readDir(this.currentPath);
      this.entries = Array.isArray(items) ? items : [];
      this._renderItems(this.entries);

      if (!silent) {
        this._flashSyncBadge();
      }
    } catch (err) {
      this._renderError(`Access Denied / ${err.message}`);
    }
  }

  /**
   * Builds interactive breadcrumbs from path string.
   * @private
   */
  _renderBreadcrumbs(dirPath) {
    if (!this.dom.breadcrumbs) return;
    this.dom.breadcrumbs.innerHTML = '';

    // Handle Windows drive root and path segments
    const normalized = dirPath.replace(/\//g, '\\');
    const parts = normalized.split('\\').filter(p => p.length > 0);

    let accumulated = '';
    parts.forEach((part, idx) => {
      if (idx === 0) {
        accumulated = part.endsWith(':') ? `${part}\\` : part;
      } else {
        accumulated += (accumulated.endsWith('\\') ? '' : '\\') + part;
      }

      const crumb = document.createElement('span');
      crumb.className = 'breadcrumb-crumb';
      crumb.textContent = part;
      crumb.title = accumulated;

      const targetNavPath = accumulated;
      crumb.addEventListener('click', () => {
        this._navigateTerminal(targetNavPath);
      });

      this.dom.breadcrumbs.appendChild(crumb);

      if (idx < parts.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '>';
        this.dom.breadcrumbs.appendChild(sep);
      }
    });
  }

  /**
   * Renders horizontal directory items.
   * @private
   */
  _renderItems(items) {
    if (!this.dom.treeList) return;
    this.dom.treeList.innerHTML = '';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dir-empty-notice';
      empty.textContent = '[EMPTY DIRECTORY]';
      this.dom.treeList.appendChild(empty);
      return;
    }

    // Sort folders first, then alphabetical
    const sorted = [...items].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return String(a.name).localeCompare(String(b.name));
    });

    const fragment = document.createDocumentFragment();

    sorted.forEach(item => {
      const card = document.createElement('div');
      card.className = `dir-item-card ${item.isDirectory ? 'is-dir' : 'is-file'}`;

      // Top Row: Icon + Name
      const topRow = document.createElement('div');
      topRow.className = 'dir-item-top';

      const icon = document.createElement('span');
      icon.className = 'dir-icon';
      icon.textContent = this._getIcon(item);

      const name = document.createElement('span');
      name.className = 'dir-name';
      name.textContent = item.name;
      name.title = item.name;

      topRow.appendChild(icon);
      topRow.appendChild(name);

      // Bottom Row: Size + Date
      const metaRow = document.createElement('div');
      metaRow.className = 'dir-item-meta';

      const sizeSpan = document.createElement('span');
      sizeSpan.textContent = item.isDirectory ? '<DIR>' : this._formatSize(item.size);

      const dateSpan = document.createElement('span');
      dateSpan.textContent = item.mtime ? item.mtime.slice(0, 10) : '';

      metaRow.appendChild(sizeSpan);
      metaRow.appendChild(dateSpan);

      card.appendChild(topRow);
      card.appendChild(metaRow);

      const fullPath = this._childPath(item.name);
      card.title = fullPath;

      // Double-click: folders -> terminal cd, files -> default program.
      card.addEventListener('dblclick', () => {
        if (item.isDirectory) this._navigateTerminal(fullPath);
        else this._openPath(fullPath);
      });

      // Right-click: actions menu.
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._openMenu(e.clientX, e.clientY, item, fullPath);
      });

      // Drag onto the terminal to type the path.
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData('application/x-xyron-path', fullPath);
        e.dataTransfer.setData('text/plain', fullPath);
        e.dataTransfer.effectAllowed = 'copy';
      });

      fragment.appendChild(card);
    });

    this.dom.treeList.appendChild(fragment);
  }

  /**
   * Short monochrome type tag: "DIR" for folders, the upper-cased extension for
   * files. Typographic on purpose - color emoji would break the black & white
   * theme and ignore the live `color` setting.
   * @private
   */
  _getIcon(item) {
    if (item.isDirectory) return 'DIR';
    const name = String(item.name || '');
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) return 'FILE';
    return name.slice(dot + 1, dot + 5).toUpperCase();
  }

  /**
   * Format bytes into readable format.
   * @private
   */
  _formatSize(bytes) {
    if (typeof bytes !== 'number' || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /**
   * Display error or access denied message.
   * @private
   */
  _renderError(msg) {
    if (!this.dom.treeList) return;
    // textContent, not innerHTML: the message can contain file names.
    this.dom.treeList.innerHTML = '';
    const notice = document.createElement('div');
    notice.className = 'dir-error-notice';
    notice.textContent = `[ERROR: ${msg}]`;
    this.dom.treeList.appendChild(notice);
  }

  /**
   * Send navigation instruction into ConPTY terminal session.
   * @private
   */
  _navigateTerminal(targetDir) {
    if (window.terminalApi) {
      if (typeof window.terminalApi.setCwd === 'function') {
        window.terminalApi.setCwd(targetDir);
      } else if (typeof window.terminalApi.sendInput === 'function') {
        window.terminalApi.sendInput(`cd "${targetDir}"\r`);
      }
    }
  }

  /**
   * @param {string} name - entry name inside the current folder
   * @returns {string} absolute path
   * @private
   */
  _childPath(name) {
    const sep = this.currentPath.endsWith('\\') ? '' : '\\';
    return `${this.currentPath}${sep}${name}`;
  }

  /** @private */
  _openPath(fullPath) {
    if (!window.systemApi) return;
    window.systemApi.openPath(fullPath).then((res) => {
      if (res && !res.ok) this._flashMessage(res.message || 'OPEN FAILED');
    });
  }

  /**
   * Menu entries for one directory item. Pure (no DOM), so it can be tested.
   * @param {{isDirectory: boolean}} item
   * @returns {Array<{id: string, label: string}>}
   */
  static menuEntries(item) {
    const entries = item && item.isDirectory
      ? [{ id: 'cd', label: 'Open in terminal (cd)' }, { id: 'open', label: 'Open in Explorer' }]
      : [{ id: 'open', label: 'Open' }, { id: 'reveal', label: 'Show in Explorer' }];
    return entries.concat([
      { id: 'insert', label: 'Insert path at prompt' },
      { id: 'copy-path', label: 'Copy full path' },
      { id: 'copy-name', label: 'Copy name' }
    ]);
  }

  /** @private */
  _runMenuEntry(id, item, fullPath) {
    switch (id) {
      case 'cd': this._navigateTerminal(fullPath); break;
      case 'open': this._openPath(fullPath); break;
      case 'reveal':
        if (window.systemApi) window.systemApi.revealPath(fullPath);
        break;
      case 'insert':
        if (typeof this.onInsertPath === 'function') this.onInsertPath(fullPath);
        break;
      case 'copy-path':
        if (window.clipboardApi && window.clipboardApi.writeText(fullPath)) this._flashMessage('PATH COPIED');
        break;
      case 'copy-name':
        if (window.clipboardApi && window.clipboardApi.writeText(item.name)) this._flashMessage('NAME COPIED');
        break;
      default: break;
    }
  }

  /** @private */
  _openMenu(x, y, item, fullPath) {
    const menu = this.dom.menu;
    if (!menu) return;
    this._closeMenu();
    menu.innerHTML = '';
    DirectoryTree.menuEntries(item).forEach((entry) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dir-menu-item';
      btn.textContent = entry.label;
      btn.addEventListener('click', () => {
        this._closeMenu();
        this._runMenuEntry(entry.id, item, fullPath);
      });
      menu.appendChild(btn);
    });
    menu.classList.remove('hidden');
    // Keep the menu fully on screen (it opens upwards near the bottom panel).
    const rect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const closer = (e) => {
      if (e && e.type === 'keydown' && e.key !== 'Escape') return;
      if (e && e.type === 'mousedown' && menu.contains(e.target)) return;
      this._closeMenu();
    };
    this._menuCloser = closer;
    // Attach after this event finishes, or the opening right-click closes it.
    setTimeout(() => {
      if (this._menuCloser !== closer) return;
      document.addEventListener('mousedown', closer, true);
      document.addEventListener('keydown', closer, true);
      window.addEventListener('blur', closer);
      window.addEventListener('resize', closer);
    }, 0);
  }

  /** @private */
  _closeMenu() {
    if (this.dom.menu) this.dom.menu.classList.add('hidden');
    const closer = this._menuCloser;
    if (!closer) return;
    this._menuCloser = null;
    document.removeEventListener('mousedown', closer, true);
    document.removeEventListener('keydown', closer, true);
    window.removeEventListener('blur', closer);
    window.removeEventListener('resize', closer);
  }

  /**
   * Short status text in the sync badge (e.g. "PATH COPIED").
   * @private
   */
  _flashMessage(text) {
    const badge = this.dom.syncBadge;
    if (!badge) return;
    if (!badge.hasAttribute('data-default')) badge.setAttribute('data-default', badge.textContent);
    badge.textContent = String(text).slice(0, 28);
    badge.classList.add('flash');
    clearTimeout(this._badgeTimer);
    this._badgeTimer = setTimeout(() => {
      badge.textContent = badge.getAttribute('data-default') || 'SYNCED';
      badge.classList.remove('flash');
    }, 1400);
  }

  /**
   * Flashes sync badge to indicate updated contents.
   * @private
   */
  _flashSyncBadge() {
    if (!this.dom.syncBadge) return;
    // Flash via a class so the effect follows the live theme.
    this.dom.syncBadge.classList.add('flash');
    setTimeout(() => {
      if (this.dom.syncBadge) this.dom.syncBadge.classList.remove('flash');
    }, 400);
  }

  /**
   * Cleanup listeners.
   */
  destroy() {
    this._closeMenu();
    clearTimeout(this._badgeTimer);
    if (typeof this.unsubscribeWatcher === 'function') {
      this.unsubscribeWatcher();
      this.unsubscribeWatcher = null;
    }
  }
}

// Attach to window or CommonJS
if (typeof window !== 'undefined') {
  window.DirectoryTree = DirectoryTree;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DirectoryTree;
}
