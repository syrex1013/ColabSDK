# Colab SDK Examples

Runnable scripts demonstrating the SDK API. Run from the repository root.

## Prerequisites

1. Install dependencies: `bun install && bun run build`
2. Log in once: `bun run example:login`

## Examples

| Script | Command | What it shows |
|--------|---------|---------------|
| Interactive login | `bun run example:login` | `auth.login()` with 2FA |
| Credential login | `bun run example:login-creds` | Email/password via env vars |
| Run code | `bun run example:run` | `connect()` + `execute.runCode()` |
| Manage cells | `bun run example:cells` | Create, edit, move, delete cells |
| Stream output | `bun run example:stream` | `execute.streamCell()` |
| GPU runtime | `bun run example:gpu` | `connect({ gpu })` + health check |
| Full workflow | `bun run example:workflow` | Markdown + code cells + `runAll()` |
| Error handling | `bun run example:errors` | Typed `ColabSDKError` hierarchy |
| Smoke test | `bun run test:sdk` | Full API integration test |

## Environment variables

| Variable | Description |
|----------|-------------|
| `COLAB_GOOGLE_EMAIL` | Google account email |
| `COLAB_GOOGLE_PASSWORD` | Google account password |
| `COLAB_HEADLESS` | Set `0` to show the browser |
| `COLAB_RESET_SESSION` | Set `1` to wipe `.colabdev/browser-profile` |
| `COLABDEV_DIR` | Custom data directory (default: `.colabdev/`) |

## Using from npm

After installing `@syrex1013/colab-sdk`, copy any example and change the import:

```typescript
// In the published package:
import { ColabClient } from '@syrex1013/colab-sdk';
```

## CLI alternative

```bash
bunx colab-dev login
bunx colab-dev connect --headless
bunx colab-dev exec "print('hello')"
bunx colab-dev cells list
```
