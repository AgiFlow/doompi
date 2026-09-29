import type { DoomHubSessionCreateRequest } from '@agimon-ai/doompi-core/hubChannel';

const SESSION_ID_OPTION = '--session-id';
const NAME_OPTION = '--name';
const PROFILE_OPTION = '--profile';
const DOMAINS_OPTION = '--domains';
const NO_DOMAINS_OPTION = '--no-domains';
const MODEL_OPTION = '--model';
const THINKING_OPTION = '--thinking';
const APPEND_SYSTEM_PROMPT_OPTION = '--append-system-prompt';
export interface SessionIdentity {
  sessionId: string;
  sessionName: string;
}

/** Settles the direct session identity from explicit arguments or caller defaults. */
export function resolveSessionIdentity(
  agentArgs: readonly string[],
  fallback: SessionIdentity,
): { agentArgs: string[]; identity: SessionIdentity } {
  const args = [...agentArgs];
  const identity = { ...fallback };
  for (const [option, key] of [
    [SESSION_ID_OPTION, 'sessionId'],
    [NAME_OPTION, 'sessionName'],
  ] as const) {
    const index = args.indexOf(option);
    const value = index === -1 ? undefined : args[index + 1];
    if (value !== undefined && !value.startsWith('-')) identity[key] = value;
    else args.push(option, identity[key]);
  }
  return { agentArgs: args, identity };
}

const MAJOR_MODE_OPTION = '--major-mode';

/** Selection axes a request pins, which later inherited defaults must not replace. */
export type PinnedSelectionAxis = 'majorMode' | 'domains' | 'profile';

/**
 * The harness arguments for a session a package created with explicit settings.
 *
 * Translating to flags keeps one validation path: the same parser that checks
 * a `doompi --major-mode ... --model ...` launch checks these. Minor modes have
 * no flag; the caller seeds them into the selection state directly.
 */
export function sessionSelectionArgs(
  request: Pick<DoomHubSessionCreateRequest, 'selection' | 'model' | 'thinking' | 'appendSystemPrompt'>,
): {
  args: string[];
  pinned: PinnedSelectionAxis[];
} {
  const { selection, model, thinking, appendSystemPrompt } = request;
  const args: string[] = [];
  const pinned: PinnedSelectionAxis[] = [];
  if (selection?.majorMode !== undefined) {
    args.push(MAJOR_MODE_OPTION, selection.majorMode);
    pinned.push('majorMode');
  }
  if (selection?.profile !== undefined) {
    args.push(PROFILE_OPTION, selection.profile);
    pinned.push('profile');
  }
  if (selection?.domains !== undefined) {
    if (selection.domains.length === 0) args.push(NO_DOMAINS_OPTION);
    else args.push(DOMAINS_OPTION, selection.domains.join(','));
    pinned.push('domains');
  }
  if (model !== undefined) args.push(MODEL_OPTION, model);
  if (thinking !== undefined) args.push(THINKING_OPTION, thinking);
  // Unknown to the harness parser, so it reaches Pi, which appends it to the system prompt.
  if (appendSystemPrompt !== undefined) args.push(APPEND_SYSTEM_PROMPT_OPTION, appendSystemPrompt);
  return { args, pinned };
}

/**
 * The agent arguments with the major mode pinned to a relaunch target.
 *
 * Any prior selection is dropped so repeated switches never accumulate flags.
 * The new pair goes last, the position launcher scripts already use, which
 * also keeps a leading script path intact when the agent runs via node.
 */
export function relaunchAgentArgs(args: readonly string[], majorMode: string): string[] {
  const kept: string[] = [];
  let skipValue = false;
  for (const argument of args) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (argument === MAJOR_MODE_OPTION) {
      skipValue = true;
      continue;
    }
    kept.push(argument);
  }
  return [...kept, MAJOR_MODE_OPTION, majorMode];
}
