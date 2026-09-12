import { renderHashlineCall, renderHashlineEditResult } from '@agimon-ai/doompi-ui/hashlineRendering';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { EditParamsSchema, type EditParams } from '../schemas/editTool';
import { executeHashlineEdit } from '../services/editTool';

export { assertNotAborted, executeHashlineEdit } from '../services/editTool';

export function createHashlineEditTool(): ToolDefinition<typeof EditParamsSchema> {
  return {
    name: 'edit',
    label: 'edit',
    description:
      'Edit one file using its exact snapshot hash and inclusive anchors such as 5#abc from read or grep. Each from and to value must contain one anchor, not a pasted block. All ranges refer to the original snapshot. Empty or omitted content deletes a range.',
    promptSnippet: 'Edit files with snapshot-bound hashline ranges',
    promptGuidelines: [
      'Copy path, hash, and anchors from the latest compatible read or grep result. Re-read after every successful edit.',
      'Pass one anchor such as 5#abc in each from and to value. Do not paste tagged lines or multiline blocks.',
      'Put multiple disjoint changes to one file in one edit call. All anchors must describe the original snapshot.',
      'Omit content or pass an empty string to delete an inclusive range. Merge overlapping ranges before calling edit.',
    ],
    parameters: EditParamsSchema,
    executionMode: 'parallel',
    renderShell: 'self',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeHashlineEdit(params as EditParams, ctx.cwd, signal);
    },
    renderCall(args, theme) {
      const input = args as EditParams;
      const count = input.edits.length;
      return renderHashlineCall('edit', input.path, [`${count} ${count === 1 ? 'range' : 'ranges'}`], theme);
    },
    renderResult(result, options, theme, context) {
      const input = context.args as EditParams;
      return renderHashlineEditResult(input.path, result, options, theme, context);
    },
  };
}
