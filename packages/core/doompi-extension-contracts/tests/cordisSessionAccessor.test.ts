import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import {
  DOOM_CORDIS_SESSION_SERVICE,
  requireDoomCordisSession,
  type DoomCordisSessionService,
} from '../src/exports/cordisHost';

describe('requireDoomCordisSession', () => {
  it('returns the exact scoped service and throws when absent', () => {
    const context = new Context();
    expect(() => requireDoomCordisSession(context)).toThrow('Doom Cordis session service is unavailable.');
    const session = {
      sessionId: 'session',
      generation: 'generation',
      reason: 'startup',
      context: {},
    } as DoomCordisSessionService;
    context.provide(DOOM_CORDIS_SESSION_SERVICE, session);
    expect(requireDoomCordisSession(context)).toBe(session);
  });
});
