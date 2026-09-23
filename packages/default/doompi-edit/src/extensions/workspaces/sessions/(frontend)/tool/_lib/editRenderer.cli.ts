import type { PiToolRenderers } from '@agimon-ai/doompi-core/piExtension';
import { renderHashlineCall, renderHashlineEditResult } from '@agimon-ai/doompi-ui/hashlineRendering';

import { EditParamsSchema, type EditParams } from '../../../../../../schemas/editTool';

export const editRenderer: PiToolRenderers<typeof EditParamsSchema> = {
  renderShell: 'self',
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
