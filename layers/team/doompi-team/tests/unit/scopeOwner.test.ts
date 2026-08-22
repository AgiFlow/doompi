import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSessionScope,
  type SessionScope,
  scopeOwnerPath,
  sessionScopeDir,
} from '../../src/adapters/filesystem/paths';
import {
  readScopeOwner,
  readScopeOwnerAsync,
  writeScopeOwner,
  writeScopeOwnerAsync,
} from '../../src/adapters/scopeOwner';

const temporaryScopes: SessionScope[] = [];

function makeScope(label: string): SessionScope {
  const scope = createSessionScope(`scope-owner-${label}-${Math.random().toString(36).slice(2, 10)}`);
  temporaryScopes.push(scope);
  return scope;
}

afterEach(() => {
  while (temporaryScopes.length > 0) {
    const scope = temporaryScopes.pop();
    if (scope) fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
  }
});

describe('writeScopeOwner', () => {
  it('records this process against the scope', () => {
    const scope = makeScope('claim');

    const record = writeScopeOwner(scope, 1234);

    expect(record).toEqual({ version: 1, rootSessionId: scope.rootSessionId, hostPid: process.pid, startedAt: 1234 });
    expect(readScopeOwner(scope)).toEqual(record);
  });

  it('writes and reads the owner through promise-based startup I/O', async () => {
    const scope = makeScope('async-claim');

    const record = await writeScopeOwnerAsync(scope, 4321);

    await expect(readScopeOwnerAsync(scope)).resolves.toEqual(record);
  });

  it('rewrites rather than refusing, because /resume re-adopts a scope under a new process', () => {
    const scope = makeScope('readopt');
    writeScopeOwner(scope, 1);

    const second = writeScopeOwner(scope, 2);

    expect(readScopeOwner(scope)).toEqual(second);
    expect(second.startedAt).toBe(2);
  });
});

describe('readScopeOwner', () => {
  it('reports unknown, not dead, for a scope with no owner file', async () => {
    const scope = makeScope('absent');

    expect(readScopeOwner(scope)).toBeUndefined();
    await expect(readScopeOwnerAsync(scope)).resolves.toBeUndefined();
  });

  it('reports unknown for an unparseable owner file rather than throwing mid-sweep', async () => {
    const scope = makeScope('torn');
    fs.mkdirSync(sessionScopeDir(scope), { recursive: true });
    fs.writeFileSync(scopeOwnerPath(scope), '{"version": 1, "rootSess');

    expect(readScopeOwner(scope)).toBeUndefined();
    await expect(readScopeOwnerAsync(scope)).resolves.toBeUndefined();
  });

  it('rejects a record written by a newer build instead of misreading it', () => {
    const scope = makeScope('future');
    fs.mkdirSync(sessionScopeDir(scope), { recursive: true });
    fs.writeFileSync(
      scopeOwnerPath(scope),
      JSON.stringify({ version: 99, rootSessionId: scope.rootSessionId, hostPid: 1, startedAt: 0 }),
    );

    expect(readScopeOwner(scope)).toBeUndefined();
  });

  it('rejects a record whose hostPid is not an integer, so a sweep cannot probe garbage', () => {
    const scope = makeScope('bad-pid');
    fs.mkdirSync(sessionScopeDir(scope), { recursive: true });
    fs.writeFileSync(
      scopeOwnerPath(scope),
      JSON.stringify({ version: 1, rootSessionId: scope.rootSessionId, hostPid: 'not-a-pid', startedAt: 0 }),
    );

    expect(readScopeOwner(scope)).toBeUndefined();
  });

  it('rejects an empty root session id instead of treating it as an owner', async () => {
    const scope = makeScope('empty-root');
    fs.mkdirSync(sessionScopeDir(scope), { recursive: true });
    fs.writeFileSync(
      scopeOwnerPath(scope),
      JSON.stringify({ version: 1, rootSessionId: '', hostPid: process.pid, startedAt: 0 }),
    );

    expect(readScopeOwner(scope)).toBeUndefined();
    await expect(readScopeOwnerAsync(scope)).resolves.toBeUndefined();
  });
});
