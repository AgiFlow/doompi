export type { DoomNarrationService, NarrationRequest } from '../schemas/narration.ts';
export {
  createNarrationRequest,
  DOOM_NARRATION_SERVICE,
  DOOM_VOICE_AUTO_MODE_ID,
  DOOM_VOICE_SOURCE,
  isNarrationRequest,
  MAX_NARRATION_TEXT_CHARACTERS,
  NarrationRequestSchema,
  normalizeNarrationText,
  readDoomNarrationService,
  requireDoomNarrationService,
} from '../schemas/narration.ts';
