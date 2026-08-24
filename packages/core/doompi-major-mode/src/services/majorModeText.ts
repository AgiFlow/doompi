import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import type { TransitionExecutionStrategy } from '@agimon-ai/doompi-extension-contracts/transition';
import type { SelectItem } from '@earendil-works/pi-tui';

const OPTION_PREFIX = /^\[[ x]\] /;
const CORE_ONLY = 'core only';
const MARK_ON = '[x]';
const MARK_OFF = '[ ]';
const RELAUNCH = 'Relaunch with:';
const MAJOR_MODE_OPTION = '--major-mode';
export const MAJOR_MODE_COMMAND = 'mode';
export const VOICE_SWITCH_TOKEN_PREFIX = '--voice-switch-token=';

/** Picker rows show the resolved layers while retaining bare major mode values. */
export function majorModeItems(config: MajorModesConfig, names: string[]): SelectItem[] {
  return names.map((name) => ({
    value: name,
    label: name,
    description: config.majorMode[name]?.description ?? CORE_ONLY,
  }));
}

export function majorModeOptionLabel(name: string, layers: string[], current: string): string {
  return `${name === current ? MARK_ON : MARK_OFF} ${name}: ${layers.join(', ') || CORE_ONLY}`;
}

export function optionName(option: string): string {
  return option.replace(OPTION_PREFIX, '').split(':')[0] ?? option;
}

/**
 * What a switch actually applied.
 *
 * A synced session composes its extension set on every load, so a reload picks
 * up the new layers outright. A launcher session cannot: Pi freezes the CLI
 * `--extension` list at construction, so a layer that contributes extensions
 * needs a relaunch there and only the hooks change in place.
 */
export function applySummary(
  picked: string,
  layers: string[],
  stale: boolean,
  composed = false,
  strategy?: TransitionExecutionStrategy,
  supervised = false,
): string {
  const head = `Switched to ${picked}: ${layers.join(', ') || CORE_ONLY}`;
  if (strategy === 'process-relaunch') {
    if (supervised) {
      return `Major mode ${picked} is pending; the supervisor is restarting the agent with it.`;
    }
    return [
      `Major mode ${picked} is pending; the current process remains active.`,
      `  ./pi.sh ${MAJOR_MODE_OPTION} ${picked}`,
    ].join('\n');
  }
  if (strategy === 'pi-reload') return [head, 'Pi reloaded.'].join('\n');
  if (!stale || composed) return [head, 'Hooks reloaded.'].join('\n');
  return [
    head,
    'Hooks reloaded. Extensions are fixed at launch, so for those:',
    `  ./pi.sh ${MAJOR_MODE_OPTION} ${picked}`,
  ].join('\n');
}

export function majorModeSummary(picked: string, layers: string[], current: string, composed = false): string {
  const contents = `Major mode ${picked}: ${layers.join(', ') || CORE_ONLY}`;
  if (picked !== current && !composed) {
    return [contents, `${RELAUNCH}\n  ./pi.sh ${MAJOR_MODE_OPTION} ${picked}`].join('\n');
  }
  if (picked !== current) return contents;
  return [contents, 'Already using this major mode.'].join('\n');
}

/** The opaque token a voice switch hands to the follow-up command invocation. */
export function voiceSwitchToken(args: string): string | undefined {
  const trimmed = args.trim();
  if (!trimmed.startsWith(VOICE_SWITCH_TOKEN_PREFIX)) return undefined;
  const parts = trimmed.split(/\s+/u);
  if (parts.length !== 1) throw new Error('The voice major-mode switch token must be the only command argument.');
  const token = parts[0]?.slice(VOICE_SWITCH_TOKEN_PREFIX.length).trim();
  if (!token) throw new Error('The voice major-mode switch token is missing.');
  return token;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
