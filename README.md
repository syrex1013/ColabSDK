# @colab/sdk

TypeScript SDK for programmatic [Google Colab](https://colab.research.google.com) control via CloakBrowser automation and the Colab MCP WebSocket proxy protocol.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- Create, edit, remove, and move notebook cells
- Execute code and cells, interrupt execution, stream outputs
- Runtime GPU selection (T4, A100, L4, CPU, TPU)
- Google login with 2FA support and persistent browser sessions
- Keep-alive to reduce idle disconnects in headless mode
- Typed error hierarchy
- Optional `colab-dev` CLI
- Persistent state in `.colabdev/`

## Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js 20+
- Google account with Colab access

## Install

```bash
bun add @colab/sdk
# or
npm install @colab/sdk
```

From source:

```bash
git clone https://github.com/syrex1013/ColabSDK.git
cd ColabSDK
bun install
bun run build
```

## Quick start

### 1. Login (once, supports 2FA)

```bash
bunx colab-dev login
```

Or from code:

```typescript
import { ColabClient } from '@colab/sdk';

const client = new ColabClient();
await client.auth.login();
```

Sessions are saved to `.colabdev/browser-profile/`.

### 2. Connect headless and run code

```typescript
import { ColabClient } from '@colab/sdk';

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

### 3. CLI

```bash
bunx colab-dev connect --headless --gpu t4
bunx colab-dev exec "print('hello')"
bunx colab-dev exec "for i in range(5): print(i)" --stream
bunx colab-dev cells list
bunx colab-dev cells add "print(1)" --index 0
bunx colab-dev runtime gpu a100
bunx colab-dev status --health
bunx colab-dev stop
```

## API documentation

Full API reference: [docs/API.md](docs/API.md)

## `.colabdev/` directory

| Path | Purpose |
|------|---------|
| `.colabdev/browser-profile/` | Google session cookies |
| `.colabdev/settings.json` | SDK preferences |
| `.colabdev/session.json` | Active connection metadata |
| `.colabdev/debug/` | Screenshots on failures |

Override location with `COLABDEV_DIR`.

## Login modes

| Mode | Usage |
|------|-------|
| Interactive (default) | `colab-dev login` — complete password + 2FA in visible browser |
| Headless reuse | `connect({ headless: true })` after login |
| Remote CDP | `colab-dev login --remote-cdp 9222` — complete 2FA via DevTools over SSH tunnel |

## Examples

See [`examples/README.md`](examples/README.md) for the full list.

| Script | Command | Description |
|--------|---------|-------------|
| Login | `bun run example:login` | Interactive Google login (2FA) |
| Run code | `bun run example:run` | Connect and execute Python |
| Cells | `bun run example:cells` | Create, edit, move, delete cells |
| GPU | `bun run example:gpu` | Select GPU runtime |
| Workflow | `bun run example:workflow` | Full notebook automation |
| Smoke test | `bun run test:sdk` | Full API integration test |

## Development

```bash
bun install
bun run build
bun test                 # unit tests
bun run test:coverage    # unit tests + >90% line coverage
bun run test:sdk         # live Colab smoke test
```

### Coverage notes

Unit tests target **>90% line coverage** on core SDK modules (`ColabClient`, managers, proxy, paths, errors). Browser automation (`src/browser/`) is validated via live smoke tests (`test:sdk`) because it requires a real Colab session.

## Error handling

All SDK errors extend `ColabSDKError` with a `code` field:

- `LoginRequiredError`
- `TwoFactorPendingError`
- `NotConnectedError`
- `ConnectionTimeoutError`
- `RpcError`
- `ExecutionError`
- `CellNotFoundError`
- `BrowserError`

See [docs/API.md](docs/API.md#error-classes) for details.

## How it works

1. SDK starts a localhost MCP WebSocket proxy
2. CloakBrowser opens Colab with proxy token URL
3. Colab frontend connects and exposes notebook tools
4. SDK calls tools for cell CRUD and execution
5. Keep-alive JS prevents idle timeout in headless mode

## Publishing

Automated via GitHub Actions when you [publish a GitHub Release](https://github.com/syrex1013/ColabSDK/releases).

**Setup (once):** add an npm token as the GitHub secret `NPM_TOKEN`.  
**Full guide:** [docs/PUBLISHING.md](docs/PUBLISHING.md)

```bash
# 1. Update CHANGELOG.md
npm version patch          # bumps package.json + creates tag
git push origin main --follow-tags

# 2. Create GitHub Release from the tag → CI publishes to npm
gh release create v0.1.1 --title "v0.1.1" --generate-notes
```

CI runs `typecheck`, `test:coverage` (>90% lines), and `build` before every publish.

## Disclaimer

Unofficial project — not affiliated with Google. Uses Colab's frontend MCP bridge. Use responsibly and in accordance with Google's terms of service.

## License

[MIT](LICENSE) © [syrex1013](https://github.com/syrex1013)

## Support

If this project helps you, consider [sponsoring](https://github.com/sponsors/syrex1013).
