import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessTool,
  DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';

import { EditParamsSchema, type EditParams } from '../schemas/editTool';
import { executeHashlineEdit } from '../services/editTool';

export function createHeadlessEditTool(): DoomHeadlessTool<typeof EditParamsSchema> {
  return {
    name: 'edit',
    label: 'edit',
    description:
      'Edit one file using its exact snapshot hash and inclusive anchors such as 5#abc from read or grep. Each from and to value must contain one anchor, not a pasted block. All ranges refer to the original snapshot. Empty or omitted content deletes a range.',
    promptSnippet: 'Edit files with snapshot-bound hashline ranges',
    promptGuidelines: [
      'Copy path, hash, and anchors from the latest compatible read or grep result. Re-read after every successful edit.',
      'Pass one anchor such as 5#abc in each from and to value. Do not paste tagged lines or multiline blocks.',
    ],
    parameters: EditParamsSchema,
    executionMode: 'parallel',
    execute: (
      _toolCallId: string,
      params: EditParams,
      signal: AbortSignal | undefined,
      _onUpdate: ((result: DoomHeadlessToolResult) => void) | undefined,
      context: DoomHeadlessExecutionContext,
    ) => executeHashlineEdit(params, context.cwd, signal),
  };
}
