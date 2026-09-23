import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

import { createHelpPiRuntime } from '../../../../../services/helpPiRuntime';
import type { HelpRuntimeOptions } from '../../../../../services/helpRuntime';

export default (({ options }) => createHelpPiRuntime(options ?? {}, import.meta.url)) satisfies (
  context: PiPluginContext<HelpRuntimeOptions>,
) => PiPluginContributions<HelpRuntimeOptions>;
