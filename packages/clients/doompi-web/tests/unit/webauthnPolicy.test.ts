import { describe, expect, it } from 'vitest';
import {
  STEP_UP_ACTIONS,
  challengeIsFresh,
  counterVerdict,
  isStepUpAction,
  relyingPartyId,
  stepUpActionFor,
} from '../../src/services/webauthnPolicy.ts';

describe('counterVerdict', () => {
  it('accepts an authenticator that does not count', () => {
    // A zero counter means the device does not implement one, which is common
    // and says nothing about cloning.
    expect(counterVerdict(0, 0)).toBe('ok');
  });

  it('accepts a counter that moved forward', () => {
    expect(counterVerdict(4, 5)).toBe('ok');
    expect(counterVerdict(0, 1)).toBe('ok');
  });

  it('calls a repeated or reversed counter a clone', () => {
    // Two things signing with one key is the definition, and the only signal
    // WebAuthn gives for it.
    expect(counterVerdict(5, 5)).toBe('clone-suspected');
    expect(counterVerdict(5, 4)).toBe('clone-suspected');
  });
});

describe('relyingPartyId', () => {
  it('binds a passkey to a named tunnel hostname', () => {
    expect(relyingPartyId('https://doom.example.com')).toBe('doom.example.com');
  });

  it('refuses a quick tunnel, whose hostname rotates every start', () => {
    // A passkey registered against one of these would be dead on the next
    // start, which reads as a broken feature rather than an expired credential.
    expect(relyingPartyId('https://calm-river-1234.trycloudflare.com')).toBeUndefined();
  });

  it('refuses an IP address, which WebAuthn will not accept as a relying party', () => {
    // Better to find this out here than in the browser, mid-ceremony.
    expect(relyingPartyId('http://127.0.0.1:7433')).toBeUndefined();
    expect(relyingPartyId('http://192.168.1.5')).toBeUndefined();
    expect(relyingPartyId('http://[::1]:7433')).toBeUndefined();
  });

  it('refuses a bare hostname that cannot be a public tunnel', () => {
    expect(relyingPartyId('http://localhost:7433')).toBeUndefined();
  });

  it('refuses an absent or unparseable origin rather than guessing', () => {
    expect(relyingPartyId(undefined)).toBeUndefined();
    expect(relyingPartyId('not-a-url')).toBeUndefined();
  });
});

describe('challengeIsFresh', () => {
  it('expires exactly at the deadline', () => {
    expect(challengeIsFresh(1000, 1000 + 59_999, 60_000)).toBe(true);
    expect(challengeIsFresh(1000, 1000 + 60_000, 60_000)).toBe(false);
  });
});

describe('stepUpActionFor', () => {
  it.each([
    ['POST', '/api/sessions', 'session.create'],
    ['POST', '/api/sessions/live/resume', 'session.create'],
    ['POST', '/api/auth/logins/flow-1/answer', 'provider.login'],
    ['DELETE', '/api/auth/providers/anthropic', 'provider.logout'],
    ['PUT', '/api/settings/repository/selection', 'settings.write'],
    ['POST', '/api/plugin/mcp/repository/discover', 'mcp.discover'],
    ['POST', '/api/plugin/mcp/repository/authorize', 'mcp.authorize'],
    ['DELETE', '/api/plugin/mcp/repository/authorize/flow-1', 'mcp.authorize'],
  ])('gates %s %s', (method, path, action) => {
    expect(stepUpActionFor(method, path)).toBe(action);
  });

  it('leaves ordinary work ungated so a gesture never lands in the hot loop', () => {
    for (const [method, path] of [
      ['GET', '/api/sessions'],
      ['GET', '/api/health'],
      ['DELETE', '/api/sessions/abc'],
      ['GET', '/api/auth/providers'],
      ['POST', '/api/auth/logins'],
      ['GET', '/api/plugin/mcp/repository'],
      ['GET', '/api/plugin/mcp/repository/authorize/flow-1'],
    ]) {
      expect(stepUpActionFor(method, path), `${method} ${path}`).toBeUndefined();
    }
  });

  it('does not gate a path that merely starts the same way', () => {
    expect(stepUpActionFor('POST', '/api/sessions/extra')).toBeUndefined();
    expect(stepUpActionFor('DELETE', '/api/auth/providers/a/b')).toBeUndefined();
    expect(stepUpActionFor('POST', '/api/auth/logins/a/b/answer')).toBeUndefined();
    expect(stepUpActionFor('POST', '/api/plugin/mcp/repository/discover/extra')).toBeUndefined();
  });
});

describe('isStepUpAction', () => {
  it('accepts every declared action and nothing else', () => {
    for (const action of STEP_UP_ACTIONS) expect(isStepUpAction(action)).toBe(true);
    for (const value of ['session.delete', '', undefined, 7, {}]) expect(isStepUpAction(value)).toBe(false);
  });
});
