# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-06-10

### Added

- `WorkflowManager` on `client.workflows` — list, upload, load, unload, run, stop workflows
- Local workflow JSON definitions in `.colabdev/workflows/`
- Streaming workflow execution via `runStream()`
- MCP workflow tool delegation when Colab exposes `list_workflows`, `load_workflow`, etc.
- Workflow error types: `WorkflowNotFoundError`, `WorkflowNotLoadedError`, `WorkflowAlreadyLoadedError`, `WorkflowExecutionError`
- CLI: `colab-dev workflows list|load|unload|run|stop|upload`
- Example: `examples/09_workflow_management.ts` (`bun run example:workflows`)
- `FileUploadManager` on `client.files` — upload local files into cells with `files.upload()` widgets
- Upload progress watching via `onProgress` callback and `watchUpload()` async generator
- `findUploadCells()` to scan notebook for upload-capable cells
- Errors: `FileUploadError`, `UploadWidgetNotFoundError`
- CLI: `colab-dev files list-upload-cells`, `colab-dev files upload <cell> <paths...> [--stream]`
- Example: `examples/10_file_upload.ts` (`bun run example:upload`)

### Fixed

- File upload falls back to writing files into `/content` when Colab does not render a browser upload widget (e.g. MCP `run_code_cell` path)
- Upload cells are started via the Colab UI so MCP stays available for runtime fallback uploads

## [0.1.1] - 2026-06-10

### Added

- Professional documentation restyle (README, API reference, publishing guide, examples index, docs hub)
- `docs/README.md` documentation index

### Changed

- npm publish workflow switched to manual dispatch only (bypass GitHub Actions billing lock)
- CLI bin entry uses `bin/colab-dev.js` wrapper

## [0.1.0] - 2026-06-10

Initial public release published as [`@syrex1013/colab-sdk`](https://www.npmjs.com/package/@syrex1013/colab-sdk) on npm.

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
- GitHub Actions CI and npm publish workflows

### Fixed

- `extractCellId` reads `newCellId` from `add_code_cell` responses
- `parseCellResult` handles Jupyter `stream` output format
- `move_cell` RPC uses `cellIndex` argument
- False-positive Colab login detection on Google redirect URLs
- 2FA "Tap Yes" flow and post-approval redirect handling
- `connect({ gpu })` sets connected state before runtime selection

[Unreleased]: https://github.com/syrex1013/ColabSDK/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/syrex1013/ColabSDK/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/syrex1013/ColabSDK/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/syrex1013/ColabSDK/releases/tag/v0.1.0
