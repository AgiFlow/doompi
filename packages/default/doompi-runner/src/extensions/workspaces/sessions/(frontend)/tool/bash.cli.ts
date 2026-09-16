import { definePiToolRenderer } from '@agimon-ai/doompi-core/pi-extension';

import type { BashParams } from '../../../../../schemas/bashTool';
import { renderBashCall, renderBashResult } from './_lib/bashRender.cli';
export default definePiToolRenderer({
  renderCall: (args: unknown, theme: Parameters<typeof renderBashCall>[1]) => renderBashCall(args as BashParams, theme),
  renderResult: (
    result: Parameters<typeof renderBashResult>[0],
    options: Parameters<typeof renderBashResult>[1],
    theme: Parameters<typeof renderBashResult>[2],
    context: { isError: boolean },
  ) => renderBashResult(result, { ...options, isError: context.isError }, theme),
});
