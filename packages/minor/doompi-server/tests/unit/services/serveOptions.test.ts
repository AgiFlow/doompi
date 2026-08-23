import { describe, expect, it } from 'vitest';
import { parseServeOptions } from '../../../src/services/serveOptions.ts';

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
    });
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
});
