# Examples

Runnable scripts demonstrating [**@syrex1013/colab-sdk**](https://www.npmjs.com/package/@syrex1013/colab-sdk). Run all commands from the **repository root**.

---

## Prerequisites

```bash
bun install && bun run build
bun run example:login    # once — saves session to .colabdev/
```

---

## Example index

| # | Script | Command | Demonstrates |
|---|--------|---------|--------------|
| 01 | `01_login_interactive.ts` | `bun run example:login` | Interactive Google login with 2FA |
| 02 | `02_login_credentials.ts` | `bun run example:login-creds` | Email/password login via env vars |
| 03 | `03_connect_and_run.ts` | `bun run example:run` | `connect()` + `execute.runCode()` |
| 04 | `04_manage_cells.ts` | `bun run example:cells` | Create, edit, move, and delete cells |
| 05 | `05_stream_output.ts` | `bun run example:stream` | `execute.streamCell()` output streaming |
| 06 | `06_select_gpu.ts` | `bun run example:gpu` | GPU runtime selection and health check |
| 07 | `07_notebook_workflow.ts` | `bun run example:workflow` | Markdown + code cells + `runAll()` |
| 08 | `08_error_handling.ts` | `bun run example:errors` | Typed `ColabSDKError` hierarchy |
| 09 | `09_workflow_management.ts` | `bun run example:workflows` | List, load, run, stream, unload workflows |
| 10 | `10_file_upload.ts` | `bun run example:upload` | Upload local files with progress into `files.upload()` cells |
| — | `sdk_smoke_test.ts` | `bun run test:sdk` | Full API integration smoke test |

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COLAB_GOOGLE_EMAIL` | For `login-creds` | Google account email |
| `COLAB_GOOGLE_PASSWORD` | For `login-creds` | Google account password |
| `COLAB_HEADLESS` | No | Set to `0` to show the browser |
| `COLAB_RESET_SESSION` | No | Set to `1` to wipe `.colabdev/browser-profile` |
| `COLABDEV_DIR` | No | Custom data directory (default: `.colabdev/`) |

### Credential login example

```bash
COLAB_GOOGLE_EMAIL=you@example.com \
COLAB_GOOGLE_PASSWORD=your-password \
COLAB_HEADLESS=0 \
bun run example:login-creds
```

---

## Using examples with npm

After installing the published package, copy any example and update the import:

```typescript
import { ColabClient } from '@syrex1013/colab-sdk';
```

When working from the repository source, examples import from `../src/index.js` via the shared `_helpers.ts` module.

---

## CLI alternative

Equivalent operations via the `colab-dev` binary:

```bash
bunx colab-dev login
bunx colab-dev connect --headless
bunx colab-dev exec "print('hello')"
bunx colab-dev cells list
bunx colab-dev status --health
bunx colab-dev stop
```

---

<p align="center">
  <a href="../docs/API.md">API Reference</a> ·
  <a href="../README.md">Project README</a> ·
  <a href="../docs/README.md">Documentation</a>
</p>
