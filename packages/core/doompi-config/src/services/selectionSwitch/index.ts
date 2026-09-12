import fs from 'node:fs';
import path from 'node:path';
import type { DoomHarnessContext, HarnessState } from '../../types/config';
import { requireHarnessPaths, updateHarnessState } from '../harnessStore';
import { filterHookDisabledLayers, layerHookGroups, type MajorModesConfig, resolveLayers } from '../majorModes';
import { type AgentProfile, buildPersonaPrompt, replaceProfileEnvironment } from '../profiles';

const PERSONA_FILE = 'persona.md';

/**
 * Applying a selection axis to harness state.
 *
 * Every axis writes through the harness store and relies on Pi's reload
 * re-executing extension modules, which drops their module-level caches and
 * makes them re-read the environment.
 *
 * These live here rather than in the packages that own the /mode and /profile
 * commands because the synced startup path applies the same switches from its
 * --major-mode and --profile flags before any command exists to run them.
 * Domains is the exception and stays with its resource staging.
 */

/** Applies one major mode and the hook groups its effective layers contribute. */
export function applyMajorMode(
  config: MajorModesConfig,
  majorMode: string,
  state: DoomHarnessContext,
  compositionFingerprint?: string,
  childExtensions?: readonly string[],
): HarnessState {
  const selected = filterHookDisabledLayers(config, resolveLayers(config, majorMode), state.hooks);
  return updateHarnessState({
    majorMode,
    layers: selected,
    compositionFingerprint,
    ...(childExtensions ? { childExtensions: [...childExtensions] } : {}),
    hookGroups: layerHookGroups(config, selected),
  });
}

/**
 * Persona: rewrites the assembled prompt file that the persona extension reads.
 *
 * The extension re-reads the file on reload and appends its block to whatever
 * system prompt it is given, so the repository's own AGENTS.md keeps applying
 * underneath. Returns false when the directories hold no readable persona.
 */
export async function applyPersona(
  personaDirectory: string,
  state: DoomHarnessContext,
  personaRoot?: string,
): Promise<boolean> {
  const { root, temporaryDirectory } = requireHarnessPaths(state);

  const prompt = buildPersonaPrompt(personaRoot ?? root, personaDirectory);
  if (!prompt) return false;

  const personaPath = path.join(temporaryDirectory, PERSONA_FILE);
  await fs.promises.writeFile(personaPath, `${prompt}\n`, { mode: 0o600 });
  updateHarnessState({ personaFile: personaPath });
  return true;
}

/** Profile: one persona plus the environment defaults it declares. */
export async function applyProfile(profile: AgentProfile, state: DoomHarnessContext): Promise<string> {
  const appliedPersona = await applyPersona(profile.persona, state, profile.personaRoot);
  if (!appliedPersona) throw new Error(`Profile ${profile.name} has no readable persona files`);

  const profileEnvironment = replaceProfileEnvironment(process.env, state.profileEnvironment, profile.env);
  // Written unconditionally, including as undefined, so switching to a profile
  // that declares nothing clears the previous persona's name, icon, and voice.
  updateHarnessState({
    profile: profile.name,
    profileEnvironment,
    profileIdentity: profile.identity,
    profileVoice: profile.voice,
  });

  const environmentKeys = Object.keys(profile.env).sort();
  const environmentSummary = environmentKeys.length > 0 ? `; env defaults ${environmentKeys.join(', ')}` : '';
  return `Loaded ${profile.name}: persona ${profile.persona}${environmentSummary}.`;
}
