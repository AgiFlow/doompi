// @scaffold-generated
import { validRefName } from '../worktreeNaming';
import type { NewSessionRequestResult } from './type';

const MAX_NAME_LENGTH = 120;

/** Trimmed text, undefined when absent or blank, false when not text at all. */
function optionalText(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Validates a new-session dialog request for a worktree session. Every ref is
 * checked here, before it can reach git as a positional argument.
 */
export function newSessionRequest(body: unknown): NewSessionRequestResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'A request body is required.' };
  const record = body as Record<string, unknown>;
  const branch = optionalText(record.branch);
  if (branch === undefined || branch === false || !validRefName(branch))
    return { error: 'A valid branch name is required.' };
  const name = optionalText(record.name);
  if (name === false || (name !== undefined && name.length > MAX_NAME_LENGTH))
    return { error: `The session name must be text of up to ${String(MAX_NAME_LENGTH)} characters.` };
  const named = name === undefined ? {} : { name };
  if (record.mode === 'existing-branch') {
    const remote = optionalText(record.remote);
    if (remote === false || (remote !== undefined && !validRefName(remote)))
      return { error: 'That remote name is not valid.' };
    return { mode: 'existing-branch', branch, ...(remote === undefined ? {} : { remote }), ...named };
  }
  if (record.mode === 'new-branch') {
    const baseRef = optionalText(record.baseRef);
    if (baseRef === false || (baseRef !== undefined && !validRefName(baseRef)))
      return { error: 'That base branch is not valid.' };
    return { mode: 'new-branch', branch, ...(baseRef === undefined ? {} : { baseRef }), ...named };
  }
  return { error: 'The mode must be existing-branch or new-branch.' };
}
