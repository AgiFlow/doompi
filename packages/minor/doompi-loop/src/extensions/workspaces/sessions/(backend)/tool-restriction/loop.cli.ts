import { defineToolRestriction, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

export default defineToolRestriction(
  (context: WithRoot<unknown, PiPluginContributions<undefined>>) => context.root.toolRestrictions![0]!,
);
