import { defineWebPlugin, type ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';

/** Throws when the call asks it to; every other call renders a plain line. */
function CrashToolMessage({ args }: ToolMessageRenderProps) {
  if (args.boom === true) throw new Error('crash fixture: this renderer throws on purpose');
  return <span data-testid="tool-result-crash">rendered without a crash</span>;
}

export const webPlugin = defineWebPlugin({
  id: 'crash',
  toolRenderers: [{ tools: ['crash'], message: CrashToolMessage }],
});
