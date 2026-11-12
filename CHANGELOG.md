# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-11-12

First public release.

### Added
- Full-screen, five-zone HUD: header, hardware telemetry, terminal, processes and entropy, directory.
- Native ConPTY terminal (PowerShell and CMD) with UTF-8, a syntax-based shell router and `/cmd` / `/ps` prefixes.
- Command palette (`Ctrl+Shift+P`) with terminal actions, network, system and repair diagnostics, and theme presets.
- `Ctrl+click` links for URLs and Windows paths, including `file:line:col` suffixes.
- Drag and drop of files from Explorer or the directory panel as quoted paths.
- Terminal log export (`Ctrl+Shift+S`) to `Documents\XyronCenter\logs`.
- Live telemetry: per-core CPU, memory, NVIDIA GPU, thermal sensors, storage per drive and network throughput.
- Load warnings (hatched above 85%, blinking above 95%).
- Process list with filtering, sorting and process-tree termination.
- Directory panel synced with the terminal's working directory, with a right-click menu and double-click to open files.
- Restores the last working directory on launch.
- OP engine: `/op`, `/op-system`, `/op-unlock [min]` with auto-lock, `/op-lock`, `/op status`, `/op whoami`, `/op !!`.
- Live themes (`/xyron theme`, CMD-style `color`) and a configurable boot intro with procedural audio.
- Portable single-file EXE and unpacked folder builds.

### Security
- Elevation uses only the standard UAC consent flow.
- Main-process validation rejects non-http(s) URLs, relative paths, device paths and paths with embedded quotes.
- Log files are created atomically, so an existing file is never overwritten.
- Probes of unresponsive drives are capped, so a dead network share cannot exhaust the I/O thread pool.

[1.0.0]: ../../releases/tag/v1.0.0
