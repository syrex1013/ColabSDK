# API Reference

Programmatic TypeScript API for [**@syrex1013/colab-sdk**](https://www.npmjs.com/package/@syrex1013/colab-sdk).

**Package:** `@syrex1013/colab-sdk`  
**Entry point:** `ColabClient`

---

## Table of contents

- [Installation](#installation)
- [ColabClient](#colabclient)
- [AuthManager](#authmanager)
- [CellManager](#cellmanager)
- [ExecutionManager](#executionmanager)
- [RuntimeManager](#runtimemanager)
- [ColabDevPaths](#colabdevpaths)
- [Types](#types)
- [Constants](#constants)
- [Error classes](#error-classes)
- [Environment variables](#environment-variables)
- [CLI](#cli)

---

## Installation

```bash
bun add @syrex1013/colab-sdk
```

```typescript
import {
  ColabClient,
  ColabDevPaths,
  GPU_TYPES,
  ColabSDKError,
  LoginRequiredError,
} from '@syrex1013/colab-sdk';
```

---

## ColabClient

The primary entry point for all SDK operations. Implements `AsyncDisposable`:

```typescript
await using client = new ColabClient();
await client.connect();
```

### Constructor

```typescript
new ColabClient(rootDir?: string)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `rootDir` | `string` | Optional root for `.colabdev/` storage. Defaults to `COLABDEV_DIR` or `./.colabdev`. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `paths` | `ColabDevPaths` | Persistent storage paths and session files |
| `auth` | `AuthManager` | Google authentication |
| `cells` | `CellManager` | Notebook cell operations |
| `execute` | `ExecutionManager` | Code execution |
| `runtime` | `RuntimeManager` | GPU and runtime control |

### Methods

#### `connect(options?): Promise<ConnectionInfo>`

Establishes a full Colab session: starts the MCP proxy, launches the browser, waits for Colab to connect, validates required tools, and starts keep-alive.

```typescript
const info = await client.connect({
  headless: true,
  gpu: 't4',
  notebookUrl: 'https://colab.research.google.com/notebooks/empty.ipynb#...',
  keepAliveIntervalMs: 60_000,
  email: 'user@example.com',    // optional inline auth
  password: 'secret',
});
```

| Option | Type | Description |
|--------|------|-------------|
| `headless` | `boolean` | Run browser without a visible window |
| `gpu` | `RuntimeType` | GPU to select after connecting |
| `notebookUrl` | `string` | Target notebook URL |
| `keepAliveIntervalMs` | `number` | Keep-alive interval (default: 60 000 ms) |
| `email` | `string` | Inline Google email |
| `password` | `string` | Inline Google password |

**Returns:** `ConnectionInfo`

**Throws:** `ColabSDKError` subclasses on connection failure. Calls `disconnect()` on error.

---

#### `createNotebook(): Promise<string>`

Starts the MCP proxy (if needed) and returns the connection URL for a new empty notebook.

---

#### `openNotebook(url, options?): Promise<ConnectionInfo>`

Equivalent to `connect({ ...options, notebookUrl: url })`.

---

#### `status(): ConnectionInfo`

Returns current proxy connection metadata synchronously.

---

#### `disconnect(): Promise<void>`

Stops keep-alive, closes the browser, stops the proxy, and clears the session file.

---

#### `[Symbol.asyncDispose]()`

Calls `disconnect()`. Enables `await using` syntax.

---

## AuthManager

Accessed via `client.auth`. Handles Google sign-in and session probing.

### `login(options?): Promise<void>`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `email` | `string` | — | Google account email |
| `password` | `string` | — | Google account password |
| `headless` | `boolean` | `false` | Run browser headlessly |
| `remoteCdpPort` | `number` | — | Chrome DevTools Protocol port |
| `exportState` | `boolean` | — | Persist browser profile after login |
| `twoFactorWaitMs` | `number` | — | Max wait for 2FA approval (ms) |
| `allowHeadedFallback` | `boolean` | — | Map `LoginRequiredError` → `TwoFactorPendingError` |

When `email` and `password` are omitted, opens an interactive login flow (2FA supported in a visible browser).

---

### `isLoggedIn(): Promise<boolean>`

Probes the saved browser profile for an authenticated Colab session.

---

## CellManager

Accessed via `client.cells`. **Requires an active connection** (`connect()`).

| Method | Signature | Description |
|--------|-----------|-------------|
| `list` | `() => Promise<Cell[]>` | List all notebook cells |
| `createCode` | `(code, { index? }) => Promise<Cell>` | Insert a Python code cell |
| `createMarkdown` | `(text, { index? }) => Promise<Cell>` | Insert a markdown cell |
| `edit` | `(cellId, content) => Promise<Cell>` | Update cell source |
| `remove` | `(cellId) => Promise<void>` | Delete a cell |
| `move` | `(cellId, toIndex) => Promise<void>` | Reorder a cell |
| `resolve` | `(ref: string \| number) => Promise<Cell>` | Resolve by ID or index |
| `sourceOf` | `(cell) => string` | Normalize cell source to a string |

**Throws:** `CellNotFoundError` when a referenced cell does not exist.

---

## ExecutionManager

Accessed via `client.execute`. **Requires an active connection.**

| Method | Signature | Description |
|--------|-----------|-------------|
| `runCell` | `(ref) => Promise<CellResult>` | Execute an existing cell (retries up to 3×) |
| `runCode` | `(code, { cleanup?, index? }) => Promise<CellResult>` | Create, run, and optionally delete a cell |
| `runAll` | `() => Promise<CellResult[]>` | Run all non-empty code cells sequentially |
| `interrupt` | `() => Promise<void>` | Interrupt the current kernel execution |
| `streamCell` | `(ref) => AsyncGenerator<OutputChunk>` | Stream output while a cell runs |

```typescript
for await (const chunk of client.execute.streamCell(0)) {
  console.log(`[${chunk.type}]`, chunk.text);
}
```

**Throws:** `ExecutionError` on notebook errors; `ExecutionInterruptedError` after `interrupt()`.

---

## RuntimeManager

Accessed via `client.runtime`. **Requires an active connection.**

| Method | Signature | Description |
|--------|-----------|-------------|
| `select` | `(gpu: RuntimeType) => Promise<void>` | Change runtime via Colab UI; waits for reconnect |
| `disconnect` | `() => Promise<void>` | Disconnect the Colab kernel |
| `health` | `() => Promise<RuntimeHealth>` | Run a health-check cell and return status |

**Supported GPU values:** `'cpu'` · `'t4'` · `'a100'` · `'v100'` · `'l4'` · `'tpu'`

---

## ColabDevPaths

Accessed via `client.paths`. Manages the `.colabdev/` directory layout.

| Property | Resolved path |
|----------|---------------|
| `root` | Base directory |
| `browserProfile` | `browser-profile/` |
| `settingsFile` | `settings.json` |
| `sessionFile` | `session.json` |
| `debugDir` | `debug/` |

| Method | Description |
|--------|-------------|
| `ensureDirs()` | Create required directories |
| `loadSettings()` | Read `settings.json` (returns `{}` if missing) |
| `saveSettings(settings)` | Write `settings.json` |
| `saveSession(session)` | Write `session.json` |
| `loadSession()` | Read `session.json` |
| `clearSession()` | Reset `session.json` |

---

## Types

### `ConnectOptions`

```typescript
interface ConnectOptions {
  headless?: boolean;
  gpu?: RuntimeType;
  notebookUrl?: string;
  keepAliveIntervalMs?: number;
  streamOutputs?: boolean;
  email?: string;
  password?: string;
}
```

### `LoginOptions`

```typescript
interface LoginOptions {
  headless?: boolean;
  remoteCdpPort?: number;
  exportState?: boolean;
  allowHeadedFallback?: boolean;
  email?: string;
  password?: string;
  twoFactorWaitMs?: number;
}
```

### `Cell`

```typescript
interface Cell {
  cellId: string;
  cellIndex: number;
  cellType: 'code' | 'text';
  source: string;
  outputs?: unknown[];
}
```

### `CellResult`

```typescript
interface CellResult {
  stdout: string;
  stderr: string;
  outputs: unknown[];
  isError: boolean;
  executionCount?: number;
  cellId?: string;
}
```

### `OutputChunk`

```typescript
interface OutputChunk {
  type: 'stdout' | 'stderr' | 'result' | 'error';
  text: string;
  timestamp: number;
}
```

### `ConnectionInfo`

```typescript
interface ConnectionInfo {
  connected: boolean;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'expired';
  connectedForSeconds?: number;
  lastCloseCode?: number;
  port?: number;
}
```

### `RuntimeHealth`

```typescript
interface RuntimeHealth {
  alive: boolean;
  hasGpu: boolean;
  gpuName: string;
  runtimeType: string;
}
```

### `RuntimeType`

```typescript
type RuntimeType = 'cpu' | 't4' | 'a100' | 'v100' | 'l4' | 'tpu';
```

---

## Constants

### `GPU_TYPES`

Maps runtime keys to Colab UI labels.

```typescript
GPU_TYPES.cpu  // "None (CPU)"
GPU_TYPES.t4   // "T4 GPU"
GPU_TYPES.a100 // "A100 GPU"
```

---

## Error classes

All errors extend `ColabSDKError`, which provides:

- `code: ColabErrorCode` — machine-readable identifier
- `cause?: unknown` — underlying error
- `toJSON()` — serializable representation

| Class | Code | When thrown |
|-------|------|-------------|
| `LoginRequiredError` | `LOGIN_REQUIRED` | Google sign-in wall detected |
| `TwoFactorPendingError` | `TWO_FACTOR_PENDING` | 2FA approval required |
| `NotConnectedError` | `NOT_CONNECTED` | Method called before `connect()` |
| `ConnectionTimeoutError` | `CONNECTION_TIMEOUT` | Colab did not attach to proxy |
| `RpcError` | `RPC_ERROR` | MCP JSON-RPC failure |
| `RuntimeDisconnectedError` | `RUNTIME_DISCONNECTED` | Runtime lost after GPU change |
| `ExecutionError` | `EXECUTION_ERROR` | Cell execution failed |
| `ExecutionInterruptedError` | `EXECUTION_INTERRUPTED` | Run attempted after `interrupt()` |
| `CellNotFoundError` | `CELL_NOT_FOUND` | Invalid cell reference |
| `BrowserError` | `BROWSER_ERROR` | Browser automation failure |
| `ToolNotAvailableError` | `TOOL_NOT_AVAILABLE` | Required MCP tool missing |

### `wrapError(err, fallbackMessage): ColabSDKError`

Normalizes unknown thrown values into a `ColabSDKError`.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `COLABDEV_DIR` | Override `.colabdev/` directory location |
| `COLAB_GOOGLE_EMAIL` | Google email for scripted login |
| `COLAB_GOOGLE_PASSWORD` | Google password for scripted login |
| `COLAB_HEADLESS` | Set to `0` to show the browser in tests |
| `COLAB_RESET_SESSION` | Set to `1` to wipe the browser profile |

---

## CLI

The package includes the `colab-dev` binary:

```bash
bunx colab-dev login
bunx colab-dev connect --headless --gpu t4
bunx colab-dev exec "print('hello')"
bunx colab-dev cells list
bunx colab-dev status --health
bunx colab-dev stop
```

---

<p align="center">
  <a href="./README.md">← Documentation index</a> ·
  <a href="../README.md">Project README</a> ·
  <a href="../examples/README.md">Examples</a>
</p>
