import {
  HEALTH_CHECK_CODE,
  TOOL_ADD_CODE_CELL,
  TOOL_RUN_CODE_CELL,
} from '../constants.js';
import { RuntimeDisconnectedError, wrapError } from '../errors/index.js';
import type { BrowserSession } from '../browser/BrowserSession.js';
import { extractCellId, parseCellResult } from '../cells/cellUtils.js';
import type { ColabProxy } from '../proxy/ColabProxy.js';
import type { ColabSessionInfo, RuntimeHealth, RuntimeType } from '../types/index.js';

export class RuntimeManager {
  constructor(
    private readonly proxy: () => ColabProxy,
    private readonly browser: BrowserSession,
  ) {}

  async select(gpu: RuntimeType): Promise<void> {
    try {
      // Free up session slots first — GPU runtimes are frequently refused with
      // "Too many sessions" when other sessions are still alive.
      await this.killOtherSessions().catch(() => 0);
      await this.browser.selectRuntime(gpu);
      // After saving a new runtime type, Colab shows a "Connect <GPU>" button.
      // Clicking it may trigger a GPU quota dialog ("Connect without GPU" fallback).
      await this.browser.ensureRuntimeConnected(120_000);
      await this.waitForReconnect();
    } catch (err) {
      throw wrapError(err, `Failed to select runtime ${gpu}`);
    }
  }

  /** List active sessions from Runtime > Manage sessions. */
  async sessions(): Promise<ColabSessionInfo[]> {
    try {
      return await this.browser.listSessions();
    } catch (err) {
      throw wrapError(err, 'Failed to list sessions');
    }
  }

  /** Terminate one session by its title. Returns false if no such session. */
  async killSession(title: string): Promise<boolean> {
    try {
      return await this.browser.terminateSession(title);
    } catch (err) {
      throw wrapError(err, `Failed to kill session "${title}"`);
    }
  }

  /** Terminate all sessions except the current one. Returns the count closed. */
  async killOtherSessions(): Promise<number> {
    try {
      return await this.browser.terminateOtherSessions();
    } catch (err) {
      throw wrapError(err, 'Failed to kill other sessions');
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.browser.stopRuntime();
    } catch (err) {
      throw wrapError(err, 'Failed to disconnect runtime');
    }
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const addResult = await this.proxy().callTool(TOOL_ADD_CODE_CELL, {
        cellIndex: 0,
        language: 'python',
        code: HEALTH_CHECK_CODE,
      });
      const cellId = extractCellId(addResult);
      if (!cellId) {
        return { alive: false, hasGpu: false, gpuName: '', runtimeType: 'unknown' };
      }

      const runResult = await this.proxy().callTool(TOOL_RUN_CODE_CELL, { cellId });
      const parsed = parseCellResult(runResult);
      const info = JSON.parse(parsed.stdout.trim() || '{}') as { has_gpu?: boolean; gpu_name?: string };

      return {
        alive: !parsed.isError,
        hasGpu: Boolean(info.has_gpu),
        gpuName: info.gpu_name ?? '',
        runtimeType: info.has_gpu ? info.gpu_name || 'GPU' : 'CPU',
      };
    } catch (err) {
      throw wrapError(err, 'Runtime health check failed');
    }
  }

  private async waitForReconnect(timeoutMs = 90_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.proxy().isConnected) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new RuntimeDisconnectedError('Runtime did not reconnect after GPU change');
  }
}
