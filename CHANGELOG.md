# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- (nothing yet)

## [0.1.0] - 2026-06-10

Published as `@syrex1013/colab-sdk` on npm.

### Added

- `ColabClient` with `auth`, `cells`, `execute`, and `runtime` managers
- Google login with 2FA support and persistent browser sessions (`.colabdev/`)
- Notebook cell CRUD: create, edit, list, move, remove, resolve
- Code execution: `runCell`, `runCode`, `runAll`, `interrupt`, `streamCell`
- GPU/runtime selection and health checks
- MCP WebSocket proxy integration with Colab frontend tools
- CloakBrowser-based headless automation
- Typed error hierarchy (`ColabSDKError` and subclasses)
- `colab-dev` CLI
- Example scripts (`examples/01`–`08`)
- API reference (`docs/API.md`)
- Unit test suite with >90% line coverage on core modules

### Fixed

- `extractCellId` reads `newCellId` from `add_code_cell` responses
- `parseCellResult` handles Jupyter `stream` output format
- `move_cell` RPC uses `cellIndex` argument
- False-positive Colab login detection on Google redirect URLs
- 2FA "Tap Yes" flow and post-approval redirect handling
- `connect({ gpu })` sets connected state before runtime selection

[Unreleased]: https://github.com/syrex1013/ColabSDK/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/syrex1013/ColabSDK/releases/tag/v0.1.0
