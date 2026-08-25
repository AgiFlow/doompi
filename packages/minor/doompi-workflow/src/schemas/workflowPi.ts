import { z } from 'zod';

const RUN_SELECTOR_FIELDS = {
  runKey: z.string().min(1).describe('Run key of the workflow run.'),
  workspace: z.string().optional().describe('Workspace the run belongs to.'),
} as const;

export const workflowRunInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), ...RUN_SELECTOR_FIELDS }).strict(),
  z.object({ action: z.literal('tail'), ...RUN_SELECTOR_FIELDS }).strict(),
  z.object({ action: z.literal('recovery-evidence'), ...RUN_SELECTOR_FIELDS }).strict(),
  z.object({ action: z.literal('follow'), ...RUN_SELECTOR_FIELDS }).strict(),
  z.object({ action: z.literal('open'), ...RUN_SELECTOR_FIELDS }).strict(),
  z.object({ action: z.literal('pause'), ...RUN_SELECTOR_FIELDS, reason: z.string().optional() }).strict(),
  z.object({ action: z.literal('resume'), ...RUN_SELECTOR_FIELDS, reason: z.string().optional() }).strict(),
  z.object({ action: z.literal('stop'), ...RUN_SELECTOR_FIELDS, reason: z.string().optional() }).strict(),
  z
    .object({
      action: z.literal('recover'),
      ...RUN_SELECTOR_FIELDS,
      dryRun: z.boolean().optional(),
      job: z.string().optional(),
      runner: z.string().optional(),
    })
    .strict(),
]);

export type WorkflowRunInput = z.infer<typeof workflowRunInputSchema>;

export const dispatchInputSchema = z
  .object({
    description: z.string().optional().describe('Description shown for the workflow input.'),
    required: z.boolean().optional().describe('Whether the workflow input must be provided.'),
    default: z.string().optional().describe('Default value for the workflow input.'),
    type: z.string().optional().describe('Declared workflow input type.'),
    options: z.array(z.string()).optional().describe('Allowed values for the workflow input.'),
  })
  .passthrough();

export type DispatchInput = z.infer<typeof dispatchInputSchema>;

export const workflowDispatchInputsSchema = z
  .object({
    inputs: z.record(z.string(), dispatchInputSchema).optional().describe('Workflow dispatch input definitions.'),
  })
  .passthrough();

export const workflowCatalogPageSchema = z
  .object({
    directory: z.string().min(1).describe('Directory searched for workflow definitions.'),
    hasNextPage: z.boolean().describe('Whether another catalog page exists.'),
    page: z.number().int().positive().describe('One-based catalog page number.'),
    pageSize: z.number().int().positive().describe('Catalog page size.'),
    workflows: z
      .array(
        z
          .object({
            path: z.string().min(1).describe('Workflow path relative to the catalog directory.'),
            name: z.string().describe('Workflow display name.'),
            description: z.string().describe('Workflow description.'),
            tags: z.array(z.string()).describe('Workflow tags.'),
          })
          .passthrough(),
      )
      .describe('Workflow definitions on this page.'),
  })
  .passthrough();
