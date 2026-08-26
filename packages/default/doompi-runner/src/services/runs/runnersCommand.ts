/** The `/runners` verb that stops one runner without opening Runner Space. */
export const RUNNERS_STOP_VERB = 'stop';

export type RunnersCommandRequest =
  /** No arguments: open Runner Space. */
  | { kind: 'space' }
  /** `stop <id> [reason]`: stop one runner headlessly; id is empty when it was left out. */
  | { kind: 'stop'; id: string; reason?: string };

/**
 * Parses `/runners` arguments. Anything other than the stop verb opens Runner
 * Space, which is what the bare command has always done.
 */
export function parseRunnersCommand(args: string): RunnersCommandRequest {
  const [verb = '', id = '', ...rest] = args.trim().split(/\s+/u).filter(Boolean);
  if (verb !== RUNNERS_STOP_VERB) return { kind: 'space' };
  const reason = rest.join(' ').trim();
  return { kind: 'stop', id, ...(reason ? { reason } : {}) };
}
