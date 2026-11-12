# Contributing to Xyron Center

Thanks for taking the time to help. This guide gets you from clone to pull request.

## Development setup

**Requirements:** Windows 10 (1809+) or 11 x64, Node.js 20+, Git.

```powershell
git clone https://github.com/Xyronb1/XyronCenter.git
cd XyronCenter
npm install
npm start
```

`node-pty` uses prebuilt binaries, so you do not need Visual Studio or a C++ toolchain.

To run the app in a normal window instead of full-screen while developing (this also skips the UAC relaunch, so `/op` runs in limited mode):

```powershell
$env:XYRON_WINDOWED = "1"; npm start
```

## Before you open a pull request

1. **Run the tests:** `npm run test:fast`. Every suite must pass.
2. **Add a test for any logic you change.** Most modules expose pure helpers (`TerminalView.findLinks`, `normalizeTargetPath`, `filterItems`, …) so they can be tested without Electron. Name new test files `tests/test-<topic>.js`. The runner picks them up automatically; slow stress suites go in `challenger-*.js`, which `--fast` skips.
3. **Keep the scope small.** One feature or fix per pull request.
4. **Describe how you tested it**, ideally with a screenshot or GIF for UI changes.

## Ground rules

- **Monochrome first.** The default look is pure black and white. Colors belong in themes, not in the base UI. Load warnings use patterns (hatching, blinking), not red and green.
- **Never block the main process.** Anything that touches the disk, the network or another process must be asynchronous and have a timeout. A dead network drive must never freeze the HUD.
- **Validate at the boundary.** Every path or URL that comes from the renderer is validated in the main process before it reaches the shell or `shell.openPath`.
- **No UAC tricks.** Elevation goes through the standard Windows consent flow only.
- **No new dependencies** unless they clearly beat a few lines of standard-library code.
- **Code style:** follow the existing style. `'use strict'`, small single-purpose functions, JSDoc on public methods, and comments only where the *why* is not obvious.

## Commit messages

Use short, imperative subjects, e.g. `Add AMD GPU telemetry` or `Fix palette focus after Esc`. Reference an issue when there is one (`Fixes #12`).

## Reporting bugs and requesting features

Use the [issue templates](../../issues/new/choose). For a bug, include your Windows version, the steps to reproduce it and, if you can, a saved terminal log (`Ctrl+Shift+S`).

Security problems should **not** go into public issues. See [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
