export type ColabErrorCode =
  | 'LOGIN_REQUIRED'
  | 'TWO_FACTOR_PENDING'
  | 'NOT_CONNECTED'
  | 'CONNECTION_TIMEOUT'
  | 'RPC_ERROR'
  | 'RUNTIME_DISCONNECTED'
  | 'EXECUTION_ERROR'
  | 'EXECUTION_INTERRUPTED'
  | 'CELL_NOT_FOUND'
  | 'BROWSER_ERROR'
  | 'TOOL_NOT_AVAILABLE'
  | 'UNKNOWN';

export class ColabSDKError extends Error {
  readonly code: ColabErrorCode;
  readonly cause?: unknown;

  constructor(message: string, code: ColabErrorCode = 'UNKNOWN', cause?: unknown) {
    super(message);
    this.name = 'ColabSDKError';
    this.code = code;
    this.cause = cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
    };
  }
}

export class LoginRequiredError extends ColabSDKError {
  constructor(message = 'Google login required. Run client.auth.login() first.', cause?: unknown) {
    super(message, 'LOGIN_REQUIRED', cause);
    this.name = 'LoginRequiredError';
  }
}

export class TwoFactorPendingError extends ColabSDKError {
  constructor(
    message = '2FA challenge detected. Complete login in the visible browser window.',
    cause?: unknown,
  ) {
    super(message, 'TWO_FACTOR_PENDING', cause);
    this.name = 'TwoFactorPendingError';
  }
}

export class NotConnectedError extends ColabSDKError {
  constructor(message = 'Not connected to Colab. Call connect() first.', cause?: unknown) {
    super(message, 'NOT_CONNECTED', cause);
    this.name = 'NotConnectedError';
  }
}

export class ConnectionTimeoutError extends ColabSDKError {
  constructor(message = 'Timed out waiting for Colab frontend connection.', cause?: unknown) {
    super(message, 'CONNECTION_TIMEOUT', cause);
    this.name = 'ConnectionTimeoutError';
  }
}

export class RpcError extends ColabSDKError {
  readonly rpcCode?: number | string;
  readonly data?: unknown;

  constructor(message: string, rpcCode?: number | string, data?: unknown, cause?: unknown) {
    super(message, 'RPC_ERROR', cause);
    this.name = 'RpcError';
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

export class RuntimeDisconnectedError extends ColabSDKError {
  constructor(message = 'Colab runtime disconnected.', cause?: unknown) {
    super(message, 'RUNTIME_DISCONNECTED', cause);
    this.name = 'RuntimeDisconnectedError';
  }
}

export class ExecutionError extends ColabSDKError {
  readonly result?: unknown;

  constructor(message: string, result?: unknown, cause?: unknown) {
    super(message, 'EXECUTION_ERROR', cause);
    this.name = 'ExecutionError';
    this.result = result;
  }
}

export class ExecutionInterruptedError extends ColabSDKError {
  constructor(message = 'Cell execution was interrupted.', cause?: unknown) {
    super(message, 'EXECUTION_INTERRUPTED', cause);
    this.name = 'ExecutionInterruptedError';
  }
}

export class CellNotFoundError extends ColabSDKError {
  constructor(message = 'Cell not found.', cause?: unknown) {
    super(message, 'CELL_NOT_FOUND', cause);
    this.name = 'CellNotFoundError';
  }
}

export class BrowserError extends ColabSDKError {
  constructor(message: string, cause?: unknown) {
    super(message, 'BROWSER_ERROR', cause);
    this.name = 'BrowserError';
  }
}

export class ToolNotAvailableError extends ColabSDKError {
  readonly toolName: string;

  constructor(toolName: string, cause?: unknown) {
    super(`Required MCP tool not available: ${toolName}`, 'TOOL_NOT_AVAILABLE', cause);
    this.name = 'ToolNotAvailableError';
    this.toolName = toolName;
  }
}

export function wrapError(err: unknown, fallbackMessage: string): ColabSDKError {
  if (err instanceof ColabSDKError) return err;
  if (err instanceof Error) return new ColabSDKError(err.message || fallbackMessage, 'UNKNOWN', err);
  return new ColabSDKError(fallbackMessage, 'UNKNOWN', err);
}
