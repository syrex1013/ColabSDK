import { basename, extname } from 'node:path';

import type { WorkflowDefinition } from './workflowSchema.js';

export function workflowIdFromPath(filePath: string): string {
  const base = basename(filePath);
  if (base.endsWith('.workflow.json')) {
    return base.slice(0, -'.workflow.json'.length);
  }
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

export function normalizeWorkflowDefinition(
  raw: unknown,
  fallbackId?: string,
): WorkflowDefinition {
  const data = raw as WorkflowDefinition;
  if (!data.id && fallbackId) {
    data.id = fallbackId;
  }
  if (!data.name) {
    data.name = data.id;
  }
  return data;
}

export function isCodeStep(step: { type: string; source: string; skipIfEmpty?: boolean }): boolean {
  if (step.type !== 'code') return false;
  if (step.skipIfEmpty && !step.source.trim()) return false;
  return true;
}

export function parseWorkflowListResult(result: Record<string, unknown>): Array<{
  id: string;
  name?: string;
  source?: string;
}> {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const workflows =
    (structured?.workflows as Array<Record<string, unknown>> | undefined) ??
    (result.workflows as Array<Record<string, unknown>> | undefined) ??
    [];

  return workflows
    .map((w) => ({
      id: String(w.id ?? w.workflowId ?? ''),
      name: typeof w.name === 'string' ? w.name : undefined,
      source: typeof w.source === 'string' ? w.source : undefined,
    }))
    .filter((w) => w.id.length > 0);
}
