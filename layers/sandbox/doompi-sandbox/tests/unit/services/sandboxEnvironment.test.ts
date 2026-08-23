import { describe, expect, it } from 'vitest';
import { filterSandboxEnvironment } from '../../../src/services/sandboxEnvironment.ts';

describe('filterSandboxEnvironment', () => {
  it('passes terminal, locale, proxy, and credential variables through', () => {
    const filtered = filterSandboxEnvironment({
      TERM: 'xterm-256color',
      LC_ALL: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      ANTHROPIC_API_KEY: 'anthropic',
      OPENAI_API_KEY: 'openai',
      KIMI_AUTH_TOKEN: 'kimi',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
    });

    expect(filtered).toEqual({
      TERM: 'xterm-256color',
      LC_ALL: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      ANTHROPIC_API_KEY: 'anthropic',
      OPENAI_API_KEY: 'openai',
      KIMI_AUTH_TOKEN: 'kimi',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
    });
  });

  it('drops everything a rule does not name', () => {
    const filtered = filterSandboxEnvironment({
      PATH: '/usr/bin',
      HOME: '/Users/someone',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      AWS_SECRET_ACCESS_KEY: 'aws',
      GITHUB_TOKEN: 'gh',
      DOOMPI_SANDBOX: '1',
      EMPTY: undefined,
    });

    expect(filtered).toEqual({});
  });
});
