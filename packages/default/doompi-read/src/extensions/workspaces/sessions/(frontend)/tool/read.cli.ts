import { definePiToolRenderer } from '@agimon-ai/doompi-core/pi-extension';
import { renderHashlineCall, renderHashlineResult } from '@agimon-ai/doompi-ui/hashlineRendering';

import { ReadParamsSchema, type ReadParams } from '../../../../../schemas/readTool';

export default definePiToolRenderer<typeof ReadParamsSchema>({
  renderShell: 'self',
  renderCall(args, theme) {
    const input = args as ReadParams;
    const details = [
      input.offset === undefined ? undefined : `from ${input.offset}`,
      input.limit === undefined ? undefined : `${input.limit} lines`,
    ].filter((value): value is string => value !== undefined);
    return renderHashlineCall('read', input.path, details, theme);
  },
  renderResult(result, options, theme, context) {
    return renderHashlineResult(result, options, theme, context, 'read');
  },
});
