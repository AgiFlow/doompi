import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMcpRegistrationStore } from '../../../../src/services/sessionMcpRegistrationStore';

const directories: string[] = [];

function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-session-mcp-store-'));
  directories.push(result);
  return result;
}

afterEach(() => {
  for (const target of directories.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

const registration = {
  client: {
    clientId: 'client-1',
    name: 'ChatGPT',
    redirectUri: 'https://chatgpt.com/connector/oauth/callback',
    tokenEndpointAuthMethod: 'client_secret_post' as const,
    createdAt: 1,
  },
  secretHash: 'a'.repeat(64),
  workspaceId: 'workspace-1',
  binding: {
    clientId: 'client-1',
    sessionId: 'session-1',
    audience: 'https://doompi.example/api/workspaces/workspace-1/sessions/session-1/mcp',
    scope: 'session' as const,
    tools: [],
    skills: [],
  },
  verifiedAt: 2,
};

describe('session MCP registration store', () => {
  it('persists only verified registration metadata in a private file', () => {
    const stateDir = directory();
    const store = createSessionMcpRegistrationStore({ stateDir });

    expect(store.save(registration)).toBe(true);
    const file = path.join(stateDir, 'session-mcp-registrations.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('client-secret');
    expect(createSessionMcpRegistrationStore({ stateDir }).registrations()).toEqual([registration]);
  });

  it('round-trips API key hashes without a callback and rejects malformed key metadata', () => {
    const stateDir = directory();
    const store = createSessionMcpRegistrationStore({ stateDir });
    const key = {
      ...registration,
      client: { ...registration.client, redirectUri: '', tokenEndpointAuthMethod: 'api_key' as const },
    };
    expect(store.save(key)).toBe(true);
    expect(createSessionMcpRegistrationStore({ stateDir }).registrations()).toEqual([key]);
    const file = path.join(stateDir, 'session-mcp-registrations.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, registrations: [{ ...key, client: registration.client }] }));
    expect(createSessionMcpRegistrationStore({ stateDir }).registrations()).toEqual([registration]);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        registrations: [{ ...key, client: { ...key.client, redirectUri: 'https://unexpected.example' } }],
      }),
    );
    expect(createSessionMcpRegistrationStore({ stateDir }).registrations()).toEqual([]);
  });

  it('fails closed for malformed registration data and failed writes', () => {
    const stateDir = directory();
    const file = path.join(stateDir, 'session-mcp-registrations.json');
    fs.writeFileSync(file, '{', { mode: 0o644 });
    const notice = vi.fn();
    expect(createSessionMcpRegistrationStore({ stateDir, onNotice: notice }).registrations()).toEqual([]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));

    const parent = directory();
    const blocked = path.join(parent, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    expect(createSessionMcpRegistrationStore({ stateDir: blocked }).save(registration)).toBe(false);
  });
});
