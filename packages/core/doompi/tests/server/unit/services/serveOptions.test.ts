import { describe, expect, it } from 'vitest';
import { parseServeOptions, relaunchAgentArgs, resolveSessionIdentity } from '../../../../src/services/serveOptions';

describe('parseServeOptions', () => {
  it('reads the token file, protocol port, and direct harness arguments', () => {
    expect(
      parseServeOptions(['--auth-token-file', '/run/doompi/token', '--web', '9000', '--', '--major-mode', 'copilot']),
    ).toEqual({
      tokenFile: '/run/doompi/token',
      agentArgs: ['--major-mode', 'copilot'],
      webPort: 9000,
      sessionName: 'untitled',
      sessionId: undefined,
    });
  });

  it('reads session identity and defaults the external protocol port', () => {
    const options = parseServeOptions(['--auth-token-file', '/t', '--name', 'doompi-web', '--session-id', 'a1b2']);
    expect(options.sessionName).toBe('doompi-web');
    expect(options.sessionId).toBe('a1b2');
    expect(options.webPort).toBe(7433);
  });

  it('rejects a session id containing a path separator', () => {
    expect(() => parseServeOptions(['--auth-token-file', '/t', '--session-id', '../etc/x'])).toThrowError(
      /must not contain/,
    );
  });

  it('requires an external protocol token file', () => {
    expect(() => parseServeOptions([])).toThrowError(/--auth-token-file is required/);
  });

  it('rejects a flag with a missing value or an unknown option', () => {
    expect(() => parseServeOptions(['--auth-token-file'])).toThrowError(/requires a value/);
    expect(() => parseServeOptions(['--verbose'])).toThrowError(/Unknown option --verbose/);
  });

  it('accepts an explicit port or a bare default-port flag', () => {
    const base = ['--auth-token-file', '/t'];
    expect(parseServeOptions([...base, '--web', '9000']).webPort).toBe(9000);
    expect(parseServeOptions([...base, '--web']).webPort).toBe(7433);
    expect(parseServeOptions(['--web', ...base]).webPort).toBe(7433);
  });

  it('keeps server options out of direct harness arguments', () => {
    const options = parseServeOptions(['--auth-token-file', '/t', '--', '--web', '--mode', 'x']);
    expect(options.webPort).toBe(7433);
    expect(options.agentArgs).toEqual(['--web', '--mode', 'x']);
  });

  it('rejects an external protocol port outside the valid range', () => {
    const base = ['--auth-token-file', '/t'];
    expect(() => parseServeOptions([...base, '--web', '0'])).toThrowError(/expects a port number/);
    expect(() => parseServeOptions([...base, '--web', '70000'])).toThrowError(/expects a port number/);
  });
});

describe('resolveSessionIdentity', () => {
  const fallback = { sessionId: 'minted-id', sessionName: 'untitled' };

  it('appends the fallback identity when the agent arguments carry none', () => {
    const resolved = resolveSessionIdentity(['--major-mode', 'copilot'], fallback);

    expect(resolved.identity).toEqual(fallback);
    expect(resolved.agentArgs).toEqual(['--major-mode', 'copilot', '--session-id', 'minted-id', '--name', 'untitled']);
  });

  it('honors an identity the caller already put in the agent arguments', () => {
    const resolved = resolveSessionIdentity(['--session-id', 'given-id', '--name', 'given-name'], fallback);

    expect(resolved.identity).toEqual({ sessionId: 'given-id', sessionName: 'given-name' });
    expect(resolved.agentArgs).toEqual(['--session-id', 'given-id', '--name', 'given-name']);
  });

  it('mixes a given id with an appended name', () => {
    const resolved = resolveSessionIdentity(['--session-id', 'given-id'], fallback);

    expect(resolved.identity).toEqual({ sessionId: 'given-id', sessionName: 'untitled' });
    expect(resolved.agentArgs).toEqual(['--session-id', 'given-id', '--name', 'untitled']);
  });
});

describe('relaunchAgentArgs', () => {
  it('pins the target mode after untouched agent arguments', () => {
    expect(relaunchAgentArgs(['--session-id', 'id', '--mode', 'rpc'], 'minimal')).toEqual([
      '--session-id',
      'id',
      '--mode',
      'rpc',
      '--major-mode',
      'minimal',
    ]);
  });

  it('replaces a previous selection instead of accumulating flags', () => {
    expect(relaunchAgentArgs(['--major-mode', 'copilot', '--name', 'web'], 'minimal')).toEqual([
      '--name',
      'web',
      '--major-mode',
      'minimal',
    ]);
  });
});
