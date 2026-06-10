<p align="center">
  <strong>@syrex1013/colab-sdk</strong><br>
  TypeScript SDK for programmatic Google Colab automation
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@syrex1013/colab-sdk"><img src="https://img.shields.io/npm/v/@syrex1013/colab-sdk.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://github.com/syrex1013/ColabSDK"><img src="https://img.shields.io/github/stars/syrex1013/ColabSDK?style=social" alt="GitHub stars"></a>
</p>

---

Control [Google Colab](https://colab.research.google.com) notebooks from TypeScript or Node.js — create cells, execute Python, select GPU runtimes, and manage sessions headlessly. Built on CloakBrowser automation and Colab's MCP WebSocket proxy.

> **Disclaimer:** Unofficial project. Not affiliated with Google. Use responsibly and in accordance with Google's terms of service.

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Documentation](#documentation)
- [Examples](#examples)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Publishing](#publishing)
- [License](#license)

## Features

| Category | Capabilities |
|----------|--------------|
| **Notebook** | Create, edit, list, move, and remove code and markdown cells |
| **Execution** | Run cells or arbitrary code, interrupt runs, stream output |
| **Runtime** | Select GPU type (T4, A100, L4, CPU, TPU) and check health |
| **Authentication** | Google login with 2FA, persistent browser sessions |
| **Reliability** | Keep-alive for headless sessions, typed error hierarchy |
| **Tooling** | `colab-dev` CLI, `.colabdev/` state directory |

## Requirements

- **Runtime:** [Bun](https://bun.sh) (recommended) or Node.js 20+
- **Account:** Google account with Colab access

## Installation

```bash
bun add @syrex1013/colab-sdk
```

```bash
npm install @syrex1013/colab-sdk
```

<details>
<summary><strong>Install from source</strong></summary>

```bash
git clone https://github.com/syrex1013/ColabSDK.git
cd ColabSDK
bun install
bun run build
```

</details>

## Quick start

### Step 1 — Authenticate (once)

Log in interactively. Two-factor authentication is supported in a visible browser window.

```bash
bunx colab-dev login
```

Or from code:

```typescript
import { ColabClient } from '@syrex1013/colab-sdk';

const client = new ColabClient();
await client.auth.login({ exportState: true });
```

Sessions persist in `.colabdev/browser-profile/` for subsequent headless runs.

### Step 2 — Connect and run code

```typescript
import { ColabClient } from '@syrex1013/colab-sdk';

const client = new ColabClient();

try {
  await client.connect({ headless: true, gpu: 't4' });

  const result = await client.execute.runCode('print("hello from Colab")');
  console.log(result.stdout);

  await client.cells.createMarkdown('# Analysis');
  await client.cells.createCode('import pandas as pd');
} finally {
  await client.disconnect();
}
```

## CLI reference

| Command | Description |
|---------|-------------|
| `colab-dev login` | Interactive Google sign-in |
| `colab-dev connect --headless --gpu t4` | Open a headless Colab session |
| `colab-dev exec "print('hello')"` | Execute Python code |
| `colab-dev exec "..." --stream` | Execute with streamed output |
| `colab-dev cells list` | List notebook cells |
| `colab-dev cells add "print(1)" --index 0` | Insert a code cell |
| `colab-dev runtime gpu a100` | Change GPU runtime |
| `colab-dev status --health` | Connection and runtime status |
| `colab-dev stop` | Disconnect and clean up |

## Documentation

| Resource | Link |
|----------|------|
| API reference | [docs/API.md](docs/API.md) |
| Example scripts | [examples/README.md](examples/README.md) |
| Publishing guide | [docs/PUBLISHING.md](docs/PUBLISHING.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Docs index | [docs/README.md](docs/README.md) |

## Examples

Runnable examples live in [`examples/`](examples/). From the repository root:

| Example | Command | Description |
|---------|---------|-------------|
| Login | `bun run example:login` | Interactive Google login |
| Run code | `bun run example:run` | Connect and execute Python |
| Cells | `bun run example:cells` | Cell CRUD operations |
| Stream | `bun run example:stream` | Streamed cell output |
| GPU | `bun run example:gpu` | GPU runtime selection |
| Workflow | `bun run example:workflow` | End-to-end notebook flow |
| Errors | `bun run example:errors` | Typed error handling |
| Smoke test | `bun run test:sdk` | Full integration test |

## Configuration

### Data directory (`.colabdev/`)

| Path | Purpose |
|------|---------|
| `browser-profile/` | Persisted Google session cookies |
| `settings.json` | SDK preferences |
| `session.json` | Active connection metadata |
| `debug/` | Debug screenshots on failure |

Set `COLABDEV_DIR` to override the default location (`./.colabdev`).

### Authentication modes

| Mode | How to use |
|------|------------|
| Interactive | `colab-dev login` or `client.auth.login()` |
| Headless reuse | `connect({ headless: true })` after a saved session exists |
| Remote CDP | `colab-dev login --remote-cdp 9222` for 2FA over SSH tunnel |

### Error handling

All errors extend `ColabSDKError` with a machine-readable `code` field. Common types:

`LoginRequiredError` · `TwoFactorPendingError` · `NotConnectedError` · `ConnectionTimeoutError` · `RpcError` · `ExecutionError` · `CellNotFoundError` · `BrowserError`

See the [error reference](docs/API.md#error-classes) for the full list.

## Architecture

```
┌─────────────┐     WebSocket MCP      ┌──────────────────┐
│  ColabClient │ ◄──────────────────► │  Colab frontend  │
│  (your code) │                       │  (notebook UI)   │
└──────┬──────┘                       └────────▲─────────┘
       │                                         │
       │ localhost proxy                         │ CloakBrowser
       ▼                                         │
┌─────────────┐     browser automation   ┌──────┴─────────┐
│  ColabProxy  │ ◄────────────────────── │ BrowserSession │
└─────────────┘                          └────────────────┘
```

1. The SDK starts a local MCP WebSocket proxy.
2. CloakBrowser opens Colab with an authenticated proxy URL.
3. The Colab frontend connects and exposes notebook tools.
4. The SDK invokes tools for cell management and execution.
5. A keep-alive script reduces idle disconnects in headless mode.

## Development

```bash
bun install
bun run build
bun test                 # unit tests
bun run test:coverage    # coverage gate (>90% lines on core modules)
bun run test:sdk         # live Colab smoke test
```

Browser automation (`src/browser/`) is covered by integration smoke tests rather than unit tests, because it requires a real Colab session.

## Publishing

Releases are automated via GitHub Actions when a [GitHub Release](https://github.com/syrex1013/ColabSDK/releases) is published.

```bash
# 1. Update CHANGELOG.md
npm version patch
git push origin main --follow-tags

# 2. Publish release (triggers npm publish workflow)
gh release create v0.1.1 --title "v0.1.1" --generate-notes
```

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for CI setup, secrets, and troubleshooting.

## License

[MIT](LICENSE) © [syrex1013](https://github.com/syrex1013)

If this project is useful to you, consider [sponsoring development](https://github.com/sponsors/syrex1013).
