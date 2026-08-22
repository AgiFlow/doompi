/** Session identity inherited by commands launched from a Pi session. */
export const PI_SESSION_ID_ENV = 'PI_SESSION_ID';

/** Returns a usable inherited session id, failing closed on blank values. */
export function inheritedSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[PI_SESSION_ID_ENV]?.trim();
  return value ? value : undefined;
}

/** Returns the inherited Pi session id or fails closed outside a session. */
export function requiredSessionId(env: NodeJS.ProcessEnv = process.env): string {
  const sessionId = inheritedSessionId(env);
  if (!sessionId) throw new Error(`${PI_SESSION_ID_ENV} is required for doom-runner`);
  return sessionId;
}
