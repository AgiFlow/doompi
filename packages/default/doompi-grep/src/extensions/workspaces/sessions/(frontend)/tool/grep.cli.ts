import { definePiToolRenderer } from '@agimon-ai/doompi-core/pi-extension';
import { renderHashlineCall, renderHashlineResult } from '@agimon-ai/doompi-ui/hashlineRendering';

import { GrepParamsSchema, type GrepParams } from '../../../../../schemas/grepTool';

/**
 * Grep as the terminal draws it.
 *
 * The sibling under `(backend)/` is the same tool's logic. A terminal is a
 * frontend that is not a browser, so this sits beside `grep.tsx`, which draws
 * the same call in the cockpit, rather than beside the search that produces it.
 *
 * `renderShell: 'self'` means the tool paints its own frame rather than having
 * Pi wrap the result in the default one.
 */
export default definePiToolRenderer<typeof GrepParamsSchema>({
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
});
