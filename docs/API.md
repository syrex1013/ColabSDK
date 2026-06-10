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
- [WorkflowManager](#workflowmanager)
- [FileUploadManager](#fileuploadmanager)
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
| `workflows` | `WorkflowManager` | Local and uploaded workflow orchestration |
| `files` | `FileUploadManager` | Upload local files into notebook upload widgets |

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
| `select` | `(gpu: RuntimeType) => Promise<void>` | Change runtime via Colab UI; kills other sessions first, waits for reconnect |
| `disconnect` | `() => Promise<void>` | Disconnect the Colab kernel |
| `health` | `() => Promise<RuntimeHealth>` | Run a health-check cell and return status |
| `sessions` | `() => Promise<ColabSessionInfo[]>` | List active sessions from Runtime > Manage sessions |
| `killSession` | `(title: string) => Promise<boolean>` | Terminate one session by title; `false` if not found |
| `killOtherSessions` | `() => Promise<number>` | Terminate every session except the current; returns count |

**Supported GPU values:** `'cpu'` · `'t4'` · `'a100'` · `'v100'` · `'l4'` · `'tpu'`

### Session limits

Colab caps concurrent sessions per account. `select()` terminates other sessions before changing the runtime type, and the connect loop detects the "Too many sessions" dialog, frees a slot, and retries automatically. If the account has no GPU quota, Colab's "Cannot connect to GPU backend" dialog is answered with **Connect without GPU**, so the session falls back to CPU instead of hanging.

```typescript
const sessions = await client.runtime.sessions();
// [{ title: "scratchpad", isCurrent: true, lastExecution: "0 minutes ago", ramUsed: "1.03 GB" }]

await client.runtime.killOtherSessions();
await client.runtime.select('t4');
```

---

## WorkflowManager

Accessed via `client.workflows`. Manages multi-step notebook workflows stored as JSON files under `.colabdev/workflows/`, with optional delegation to Colab MCP workflow tools when available.

### Workflow definition format

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "description": "Optional summary",
  "version": "1.0.0",
  "gpu": "t4",
  "steps": [
    { "type": "markdown", "source": "# Title" },
    { "type": "code", "source": "print('ok')" }
  ]
}
```

| Method | Signature | Description |
|--------|-----------|-------------|
| `list` | `(filter?: 'all' \| 'local' \| 'uploaded') => Promise<WorkflowInfo[]>` | List local and loaded workflows |
| `get` | `(idOrPath) => Promise<WorkflowDefinition>` | Read a workflow definition |
| `save` | `(definition) => Promise<string>` | Save a workflow to `.colabdev/workflows/` |
| `upload` | `(filePath, { load? }) => Promise<WorkflowInfo>` | Register a local file and optionally load it |
| `load` | `(idOrPath, { gpu? }) => Promise<LoadedWorkflow>` | Load workflow cells into the notebook |
| `unload` | `(id) => Promise<void>` | Remove loaded workflow cells |
| `run` | `(id, { autoLoad?, gpu? }) => Promise<WorkflowRunResult>` | Run all code steps sequentially |
| `runStream` | `(id, options?) => AsyncGenerator<WorkflowStreamChunk>` | Stream output while running |
| `stop` | `() => Promise<void>` | Interrupt the running workflow |
| `isRunning` | `() => boolean` | Whether a workflow run is in progress |
| `runningId` | `() => string \| null` | ID of the active workflow run |

```typescript
await client.workflows.upload('./my.workflow.json');
const result = await client.workflows.run('my-workflow');

for await (const chunk of client.workflows.runStream('my-workflow')) {
  console.log(chunk.stepIndex, chunk.type, chunk.text);
}
```

**Throws:** `WorkflowNotFoundError`, `WorkflowNotLoadedError`, `WorkflowAlreadyLoadedError`, `WorkflowExecutionError`.

When Colab exposes MCP tools (`list_workflows`, `load_workflow`, `unload_workflow`, `run_workflow`, `stop_workflow`), the manager uses them automatically; otherwise it falls back to cell-based execution.

---

## FileUploadManager

Accessed via `client.files`. Uploads local files into Colab cells that use `google.colab.files.upload()` or similar file-upload widgets. The manager tries the browser widget first (run cell → fill file input via Playwright → watch progress). When the widget is unavailable (common with MCP `run_code_cell`), it falls back to writing files into `/content` via temporary runtime cells.

| Method | Signature | Description |
|--------|-----------|-------------|
| `findUploadCells` | `() => Promise<UploadCellInfo[]>` | Scan notebook for upload cells |
| `upload` | `(ref, filePaths, options?) => Promise<FileUploadResult>` | Upload file(s) with optional `onProgress` callback |
| `watchUpload` | `(ref, filePaths, options?) => AsyncGenerator<UploadProgressEvent>` | Stream upload progress events |

```typescript
const cell = await client.cells.createCode(
  'from google.colab import files\nuploaded = files.upload()',
);

for await (const event of client.files.watchUpload(cell.cellId, './data.csv')) {
  console.log(event.phase, event.percent, event.message);
}
```

| Option | Type | Description |
|--------|------|-------------|
| `runCell` | `boolean` | Run the cell to show the widget (default: `true`) |
| `widgetTimeoutMs` | `number` | Wait for widget (default: 120 000 ms) |
| `uploadTimeoutMs` | `number` | Wait for upload completion (default: 300 000 ms) |
| `runtimeFallback` | `boolean` | Write to `/content` when widget is missing (default: `true`) |
| `runtimeOnly` | `boolean` | Skip widget flow and upload via runtime only |
| `onProgress` | `(event) => void` | Progress callback for `upload()` |

`FileUploadResult.method` is `'widget'` or `'runtime'`. Runtime uploads set `remotePaths` (e.g. `/content/data.csv`).

**Progress phases:** `starting` · `waiting` · `uploading` · `processing` · `complete` · `error`

**Throws:** `FileUploadError`, `UploadWidgetNotFoundError`

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

### `ColabSessionInfo`

A row in Colab's Runtime > Manage sessions dialog.

```typescript
interface ColabSessionInfo {
  title: string;         // notebook title, e.g. "scratchpad"
  isCurrent: boolean;    // true for this notebook's session
  lastExecution: string; // e.g. "0 minutes ago"
  ramUsed: string;       // e.g. "1.16 GB"
}
```

---

## Constants

### `GPU_TYPES`

Maps runtime keys to Colab UI labels.

```typescript
GPU_TYPES.cpu  // "CPU"
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
| `WorkflowNotFoundError` | `WORKFLOW_NOT_FOUND` | Workflow file or ID not found |
| `WorkflowNotLoadedError` | `WORKFLOW_NOT_LOADED` | `run()` called without loading |
| `WorkflowAlreadyLoadedError` | `WORKFLOW_ALREADY_LOADED` | Duplicate `load()` |
| `WorkflowExecutionError` | `WORKFLOW_EXECUTION_ERROR` | Step failed during `run()` |
| `FileUploadError` | `FILE_UPLOAD_ERROR` | File upload to cell failed |
| `UploadWidgetNotFoundError` | `UPLOAD_WIDGET_NOT_FOUND` | No file input in cell output |

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
