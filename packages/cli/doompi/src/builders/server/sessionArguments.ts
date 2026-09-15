const SESSION_ID_OPTION = '--session-id';
const NAME_OPTION = '--name';
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
