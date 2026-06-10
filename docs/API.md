# Colab SDK API Reference

Programmatic TypeScript API for Google Colab automation.

## Installation

```bash
bun add @syrex1013/colab-sdk
# or
npm install @syrex1013/colab-sdk
```

## Quick import

```typescript
import {
  ColabClient,
  ColabDevPaths,
  GPU_TYPES,
  ColabSDKError,
  LoginRequiredError,
  // ...other errors
} from '@syrex1013/colab-sdk';
```

---

## `ColabClient`

Main entry point. Implements `AsyncDisposable` (`await using client = new ColabClient()`).

### Constructor

```typescript
new ColabClient(rootDir?: string)
```

| Parameter | Description |
|-----------|-------------|
| `rootDir` | Optional override for `.colabdev/` storage root. Defaults to `COLABDEV_DIR` or `./.colabdev`. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `paths` | `ColabDevPaths` | Persistent storage paths and session files |
| `auth` | `AuthManager` | Google login helpers |
| `cells` | `CellManager` | Notebook cell CRUD |
| `execute` | `ExecutionManager` | Code execution |
| `runtime` | `RuntimeManager` | GPU/runtime control |

### Methods

#### `connect(options?: ConnectOptions): Promise<ConnectionInfo>`

Starts the MCP proxy, launches the browser session, waits for Colab to connect, validates tools, and starts keep-alive.

```typescript
await client.connect({
  headless: true,
  gpu: 't4',
  notebookUrl: 'https://colab.research.google.com/notebooks/empty.ipynb#...',
  keepAliveIntervalMs: 60_000,
  email: 'user@example.com',   // optional inline auth
  password: 'secret',
});
```

#### `createNotebook(): Promise<string>`

Returns the MCP proxy URL for a new empty notebook (proxy must be started separately via `connect` flow — used internally before navigation).

#### `openNotebook(url, options?): Promise<ConnectionInfo>`

Shorthand for `connect({ ...options, notebookUrl: url })`.

#### `status(): ConnectionInfo`

Returns current proxy connection metadata without awaiting.

#### `disconnect(): Promise<void>`

Stops keep-alive, closes browser, stops proxy, clears session file.

#### `[Symbol.asyncDispose]()`

Calls `disconnect()`.

---

## `AuthManager`

Access via `client.auth`.

### `login(options?: LoginOptions): Promise<void>`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `email` | `string` | — | Google account email |
| `password` | `string` | — | Google account password |
| `headless` | `boolean` | `false` | Run browser headless |
| `remoteCdpPort` | `number` | — | Attach via Chrome DevTools port |
| `exportState` | `boolean` | — | Persist browser profile after login |
| `twoFactorWaitMs` | `number` | — | Max wait for phone 2FA approval |
| `allowHeadedFallback` | `boolean` | — | Map `LoginRequiredError` → `TwoFactorPendingError` |

Without `email`/`password`, opens interactive login (supports 2FA in visible browser).

### `isLoggedIn(): Promise<boolean>`

Probes saved browser profile for an authenticated Colab session.

---

## `CellManager`

Access via `client.cells`. Requires active `connect()`.

### `list(): Promise<Cell[]>`

Returns all notebook cells.

### `createCode(code: string, options?: { index?: number }): Promise<Cell>`

Inserts a Python code cell at `index` (default `0`).

### `createMarkdown(text: string, options?: { index?: number }): Promise<Cell>`

Inserts a markdown/text cell.

### `edit(cellId: string, content: string): Promise<Cell>`

Updates cell source. Throws `CellNotFoundError` if missing after update.

### `remove(cellId: string): Promise<void>`

Deletes a cell.

### `move(cellId: string, toIndex: number): Promise<void>`

Reorders a cell.

### `resolve(ref: string | number): Promise<Cell>`

Resolves by cell ID or zero-based index. Throws `CellNotFoundError` when not found.

### `sourceOf(cell: Cell): string`

Returns normalized source string from a `Cell` object.

---

## `ExecutionManager`

Access via `client.execute`. Requires active `connect()`.

### `runCell(ref: string | number): Promise<CellResult>`

Executes an existing cell by ID or index. Retries transient RPC failures up to 3 times. Throws `ExecutionError` on notebook errors.

### `runCode(code: string, options?: { cleanup?: boolean; index?: number }): Promise<CellResult>`

Creates a temporary code cell, runs it, optionally deletes it (`cleanup: true`).

### `runAll(): Promise<CellResult[]>`

Runs all non-empty code cells sequentially.

### `interrupt(): Promise<void>`

Signals the browser to interrupt the kernel. Throws `ExecutionInterruptedError` on subsequent `runCell` attempts in the same manager instance.

### `streamCell(ref: string | number): AsyncGenerator<OutputChunk>`

Polls cell outputs while execution runs, then yields final stdout/stderr/result chunks.

```typescript
for await (const chunk of client.execute.streamCell(0)) {
  console.log(chunk.type, chunk.text);
}
```

---

## `RuntimeManager`

Access via `client.runtime`. Requires active `connect()`.

### `select(gpu: RuntimeType): Promise<void>`

Changes runtime type via the Colab UI. Waits for MCP reconnect.

Supported values: `'cpu' | 't4' | 'a100' | 'v100' | 'l4' | 'tpu'`.

### `disconnect(): Promise<void>`

Disconnects the Colab runtime (kernel).

### `health(): Promise<RuntimeHealth>`

Runs an inline health-check cell and returns:

```typescript
interface RuntimeHealth {
  alive: boolean;
  hasGpu: boolean;
  gpuName: string;
  runtimeType: string;
}
```

---

## `ColabDevPaths`

Persistent filesystem layout under `.colabdev/`.

| Property | Path |
|----------|------|
| `root` | Base directory |
| `browserProfile` | `browser-profile/` |
| `settingsFile` | `settings.json` |
| `sessionFile` | `session.json` |
| `debugDir` | `debug/` |

### Methods

- `ensureDirs(): Promise<void>`
- `loadSettings(): Promise<ColabSettings>`
- `saveSettings(settings: ColabSettings): Promise<void>`
- `saveSession(session: Record<string, unknown>): Promise<void>`
- `loadSession(): Promise<Record<string, unknown> | null>`
- `clearSession(): Promise<void>`

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

### `RuntimeType`

`'cpu' | 't4' | 'a100' | 'v100' | 'l4' | 'tpu'`

---

## Constants

### `GPU_TYPES`

Maps short runtime keys to Colab UI labels:

```typescript
GPU_TYPES.t4   // "T4 GPU"
GPU_TYPES.cpu  // "None (CPU)"
```

---

## Error classes

All extend `ColabSDKError` with a `code` field and `toJSON()`.

| Class | Code | When |
|-------|------|------|
| `LoginRequiredError` | `LOGIN_REQUIRED` | Auth wall detected |
| `TwoFactorPendingError` | `TWO_FACTOR_PENDING` | 2FA approval needed |
| `NotConnectedError` | `NOT_CONNECTED` | API used before `connect()` |
| `ConnectionTimeoutError` | `CONNECTION_TIMEOUT` | Colab never attached to proxy |
| `RpcError` | `RPC_ERROR` | MCP JSON-RPC failure |
| `RuntimeDisconnectedError` | `RUNTIME_DISCONNECTED` | Runtime lost after GPU change |
| `ExecutionError` | `EXECUTION_ERROR` | Cell raised an error |
| `ExecutionInterruptedError` | `EXECUTION_INTERRUPTED` | Run after `interrupt()` |
| `CellNotFoundError` | `CELL_NOT_FOUND` | Invalid cell ref |
| `BrowserError` | `BROWSER_ERROR` | Playwright/browser failure |
| `ToolNotAvailableError` | `TOOL_NOT_AVAILABLE` | Required MCP tool missing |

### `wrapError(err: unknown, fallbackMessage: string): ColabSDKError`

Normalizes unknown thrown values into `ColabSDKError`.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `COLABDEV_DIR` | Override `.colabdev/` location |
| `COLAB_GOOGLE_EMAIL` | Email for scripted login examples |
| `COLAB_GOOGLE_PASSWORD` | Password for scripted login examples |
| `COLAB_HEADLESS` | Set `0` for headed smoke tests |
| `COLAB_RESET_SESSION` | Set `1` to wipe saved browser profile |

---

## CLI

The package ships a `colab-dev` binary after build:

```bash
bunx colab-dev login
bunx colab-dev connect --headless --gpu t4
bunx colab-dev exec "print('hello')"
bunx colab-dev cells list
bunx colab-dev status --health
bunx colab-dev stop
```
