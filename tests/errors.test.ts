import { describe, expect, it } from 'vitest';

import {
  BrowserError,
  CellNotFoundError,
  ColabSDKError,
  ConnectionTimeoutError,
  ExecutionError,
  ExecutionInterruptedError,
  LoginRequiredError,
  NotConnectedError,
  RpcError,
  RuntimeDisconnectedError,
  ToolNotAvailableError,
  TwoFactorPendingError,
  wrapError,
} from '../src/errors/index.js';

describe('errors', () => {
  it('wraps unknown errors', () => {
    const err = wrapError(new Error('boom'), 'fallback');
    expect(err).toBeInstanceOf(ColabSDKError);
    expect(err.message).toBe('boom');
  });

  it('preserves ColabSDKError instances', () => {
    const original = new LoginRequiredError();
    expect(wrapError(original, 'fallback')).toBe(original);
  });

  it('serializes to JSON', () => {
    const err = new RpcError('failed', 500, { detail: 'x' });
    const json = err.toJSON();
    expect(json.code).toBe('RPC_ERROR');
    expect(json.message).toBe('failed');
  });

  it('creates typed cell errors', () => {
    const err = new CellNotFoundError('missing');
    expect(err.code).toBe('CELL_NOT_FOUND');
  });

  it('wraps non-error values', () => {
    const err = wrapError('plain', 'fallback');
    expect(err.message).toBe('fallback');
  });

  it('exposes all typed error codes', () => {
    expect(new LoginRequiredError().code).toBe('LOGIN_REQUIRED');
    expect(new TwoFactorPendingError().code).toBe('TWO_FACTOR_PENDING');
    expect(new NotConnectedError().code).toBe('NOT_CONNECTED');
    expect(new ConnectionTimeoutError().code).toBe('CONNECTION_TIMEOUT');
    expect(new RuntimeDisconnectedError().code).toBe('RUNTIME_DISCONNECTED');
    expect(new ExecutionError('x').code).toBe('EXECUTION_ERROR');
    expect(new ExecutionInterruptedError().code).toBe('EXECUTION_INTERRUPTED');
    expect(new BrowserError('x').code).toBe('BROWSER_ERROR');
    expect(new ToolNotAvailableError('foo').toolName).toBe('foo');
  });
});
