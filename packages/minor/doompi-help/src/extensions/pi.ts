import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { createHelpPiRuntime } from '../controllers/helpPiRuntime';
import type { HelpRuntimeOptions } from '../services/helpRuntime';

export const helpExtension = definePiExtension<HelpRuntimeOptions>('@agimon-ai/doompi-help', ({ options }) =>
  createHelpPiRuntime(options ?? {}, import.meta.url),
);
export default helpExtension;
