import { describe, expect, it } from 'vitest';
import { parseServeOptions, resolveSessionIdentity } from '../../../src/services/serveOptions.ts';

describe('parseServeOptions', () => {
  it('reads the socket, token file, and agent arguments', () => {
    const options = parseServeOptions([
      '--listen',
      '/run/doompi/session.sock',
      '--auth-token-file',
      '/run/doompi/token',
      '--',
      '--major-mode',
      'copilot',
    ]);

    expect(options).toEqual({
      socketPath: '/run/doompi/session.sock',
      tokenFile: '/run/doompi/token',
      agentArgs: ['--major-mode', 'copilot'],
      webPort: undefined,
      sessionName: 'untitled',
      sessionId: undefined,
      registryDir: undefined,
    });
  });

  it('reads the session name, session id, and registry directory', () => {
    const options = parseServeOptions([
      '--listen',
      '/s.sock',
      '--auth-token-file',
      '/t',
      '--name',
      'doompi-web',
      '--session-id',
      'a1b2',
      '--registry-dir',
      '/custom/run',
    ]);

    expect(options.sessionName).toBe('doompi-web');
    expect(options.sessionId).toBe('a1b2');
    expect(options.registryDir).toBe('/custom/run');
  });

  it('rejects a session id that would escape the record namespace', () => {
    const base = ['--listen', '/s.sock', '--auth-token-file', '/t'];
    expect(() => parseServeOptions([...base, '--session-id', '../etc/x'])).toThrowError(/must not contain/);
  });

  it('accepts a server with no agent arguments', () => {
    expect(parseServeOptions(['--listen', '/s.sock', '--auth-token-file', '/t']).agentArgs).toEqual([]);
  });

  it('never treats the server flags as agent arguments', () => {
    const options = parseServeOptions(['--listen', '/s.sock', '--auth-token-file', '/t', '--', '--listen', 'x']);

    expect(options.socketPath).toBe('/s.sock');
    expect(options.agentArgs).toEqual(['--listen', 'x']);
  });

  it('requires both the socket and the token file', () => {
    expect(() => parseServeOptions(['--listen', '/s.sock'])).toThrowError(/--auth-token-file is required/);
    expect(() => parseServeOptions(['--auth-token-file', '/t'])).toThrowError(/--listen is required/);
  });

  it('rejects a flag with a missing value or an unknown option', () => {
    expect(() => parseServeOptions(['--listen', '--auth-token-file'])).toThrowError(/--listen requires a value/);
    expect(() => parseServeOptions(['--verbose'])).toThrowError(/Unknown option --verbose/);
  });

  it('serves no cockpit unless asked', () => {
    expect(parseServeOptions(['--listen', '/s.sock', '--auth-token-file', '/t']).webPort).toBeUndefined();
  });

  it('takes a cockpit port, or defaults one when the flag stands alone', () => {
    const base = ['--listen', '/s.sock', '--auth-token-file', '/t'];
    expect(parseServeOptions([...base, '--web', '9000']).webPort).toBe(9000);
    expect(parseServeOptions([...base, '--web']).webPort).toBe(7433);
    // The bare flag must not swallow the flag that follows it.
    expect(parseServeOptions(['--web', ...base]).webPort).toBe(7433);
  });

  it('keeps the cockpit port out of the agent arguments', () => {
    const options = parseServeOptions(['--listen', '/s.sock', '--auth-token-file', '/t', '--web', '--', '--mode', 'x']);
    expect(options.webPort).toBe(7433);
    expect(options.agentArgs).toEqual(['--mode', 'x']);
  });

  it('rejects a cockpit port outside the valid range', () => {
    const base = ['--listen', '/s.sock', '--auth-token-file', '/t'];
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
