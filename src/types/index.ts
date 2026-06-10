import { z } from 'zod';

export type RuntimeType = 'cpu' | 't4' | 'a100' | 'v100' | 'l4' | 'tpu';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'expired';

export interface ColabSettings {
  keepAliveIntervalMs?: number;
  defaultGpu?: RuntimeType;
  headless?: boolean;
}

export interface ConnectOptions {
  headless?: boolean;
  gpu?: RuntimeType;
  notebookUrl?: string;
  keepAliveIntervalMs?: number;
  streamOutputs?: boolean;
  email?: string;
  password?: string;
}

export interface LoginOptions {
  headless?: boolean;
  remoteCdpPort?: number;
  exportState?: boolean;
  allowHeadedFallback?: boolean;
  email?: string;
  password?: string;
  twoFactorWaitMs?: number;
}

export interface Cell {
  cellId: string;
  cellIndex: number;
  cellType: 'code' | 'text';
  source: string;
  outputs?: unknown[];
}

export interface OutputChunk {
  type: 'stdout' | 'stderr' | 'result' | 'error';
  text: string;
  timestamp: number;
}

export interface CellResult {
  stdout: string;
  stderr: string;
  outputs: unknown[];
  isError: boolean;
  executionCount?: number;
  cellId?: string;
}

export interface ConnectionInfo {
  connected: boolean;
  connectionState: ConnectionState;
  connectedForSeconds?: number;
  lastCloseCode?: number;
  port?: number;
}

export interface RuntimeHealth {
  alive: boolean;
  hasGpu: boolean;
  gpuName: string;
  runtimeType: string;
}

/** A row in Colab's Runtime > Manage sessions dialog. */
export interface ColabSessionInfo {
  /** Notebook title shown in the dialog (e.g. "scratchpad"). */
  title: string;
  /** True for the session belonging to this notebook tab. */
  isCurrent: boolean;
  /** e.g. "0 minutes ago" */
  lastExecution: string;
  /** e.g. "1.16 GB" */
  ramUsed: string;
}

export interface RpcTool {
  name: string;
  description?: string;
}

const textContentSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
});

const structuredOutputSchema = z.object({
  text: z.union([z.string(), z.array(z.string())]).optional(),
});

const structuredContentSchema = z.object({
  outputs: z.array(structuredOutputSchema).optional(),
  isError: z.boolean().optional(),
});

export const toolResultSchema = z.object({
  content: z.array(textContentSchema).optional(),
  structuredContent: structuredContentSchema.optional(),
  isError: z.boolean().optional(),
});

export type ToolResult = z.infer<typeof toolResultSchema>;

export const cellSchema = z.object({
  cellId: z.string().optional(),
  id: z.string().optional(),
  cellIndex: z.number().optional(),
  index: z.number().optional(),
  cellType: z.enum(['code', 'text']).optional(),
  cell_type: z.enum(['code', 'text', 'markdown']).optional(),
  source: z.union([z.string(), z.array(z.string())]).optional(),
  content: z.string().optional(),
  outputs: z.array(z.unknown()).optional(),
});

export type RawCell = z.infer<typeof cellSchema>;
