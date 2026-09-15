import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import type { BashParams } from '../../../../../schemas/bashTool';
import { renderBashCall, renderBashResult } from './_lib/bashRender';
export default defineRoutedContribution(
  {
    renderCall: (args: unknown, theme: Parameters<typeof renderBashCall>[1]) =>
      renderBashCall(args as BashParams, theme),
    renderResult: (
      result: Parameters<typeof renderBashResult>[0],
      options: Parameters<typeof renderBashResult>[1],
      theme: Parameters<typeof renderBashResult>[2],
      context: { isError: boolean },
    ) => renderBashResult(result, { ...options, isError: context.isError }, theme),
  },
  {},
);
