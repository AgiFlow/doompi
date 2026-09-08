export type { AgentProfile, PersonaIdentity } from '../adapters/profiles.ts';
export type { PersonaFrontMatter, PersonaVoiceOverride } from '../services/personaFrontMatter.ts';
export { parsePersonaFrontMatter } from '../services/personaFrontMatter.ts';
export { readPersonaIcon } from '../adapters/personaIcon.ts';
export {
  applyProfileEnvironment,
  buildPersonaPrompt,
  listProfileNames,
  loadProfileCatalog,
  loadProfiles,
  PERSONA_FILES,
  replaceProfileEnvironment,
  resolveProfile,
} from '../adapters/profiles.ts';
