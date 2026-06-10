import { z } from 'zod';

export const workflowStepSchema = z.object({
  type: z.enum(['code', 'markdown']),
  source: z.string(),
  skipIfEmpty: z.boolean().optional(),
});

export const workflowDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  gpu: z.enum(['cpu', 't4', 'a100', 'v100', 'l4', 'tpu']).optional(),
  steps: z.array(workflowStepSchema).min(1),
});

export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const loadedWorkflowSchema = z.object({
  id: z.string(),
  source: z.enum(['local', 'uploaded']),
  localPath: z.string().optional(),
  loadedAt: z.string(),
  cellIds: z.array(z.string()),
});

export type LoadedWorkflow = z.infer<typeof loadedWorkflowSchema>;

export const workflowRegistrySchema = z.record(loadedWorkflowSchema);

export type WorkflowRegistry = z.infer<typeof workflowRegistrySchema>;
