import type { PiToolRenderers } from '@agimon-ai/doompi-core/pi-extension';
import { renderHashlineCall, renderHashlineResult } from '@agimon-ai/doompi-ui/hashlineRendering';

import { GrepParamsSchema, type GrepParams } from '../../../../../../schemas/grepTool';

export const grepRenderer: PiToolRenderers<typeof GrepParamsSchema> = {
  renderShell: 'self',
  renderCall(args, theme) {
    const input = args as GrepParams;
    const details = [
      input.path ?? '.',
      input.glob,
      input.ignoreCase === true ? 'ignore case' : undefined,
      input.limit === undefined ? undefined : `${input.limit} matches`,
    ].filter((value): value is string => value !== undefined);
    return renderHashlineCall('grep', input.pattern, details, theme);
  },
  renderResult(result, options, theme, context) {
    return renderHashlineResult(result, options, theme, context, 'grep');
  },
};
