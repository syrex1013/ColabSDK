import {
  HEALTH_CHECK_CODE,
  TOOL_ADD_CODE_CELL,
  TOOL_RUN_CODE_CELL,
} from '../constants.js';
import { RuntimeDisconnectedError, wrapError } from '../errors/index.js';
import type { BrowserSession } from '../browser/BrowserSession.js';
import { extractCellId, parseCellResult } from '../cells/cellUtils.js';
import type { ColabProxy } from '../proxy/ColabProxy.js';
import type { RuntimeHealth, RuntimeType } from '../types/index.js';

export class RuntimeManager {
  constructor(
    private readonly proxy: () => ColabProxy,
    private readonly browser: BrowserSession,
  ) {}

  async select(gpu: RuntimeType): Promise<void> {
    try {
      await this.browser.selectRuntime(gpu);
      await this.waitForReconnect();
    } catch (err) {
      throw wrapError(err, `Failed to select runtime ${gpu}`);
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
