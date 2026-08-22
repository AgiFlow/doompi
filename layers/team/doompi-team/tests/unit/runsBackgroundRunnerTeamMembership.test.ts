import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { RunnerTeamMembership } from '../../src/adapters/runs/background/runnerTeamMembership';
import {
  applyNativeTeamRootEnvironment,
  clearNativeTeamRootEnvironment,
  ensureNativeTeamRoot,
  readMember,
  type TeamRootContext,
} from '../../src/adapters/intercom/nativeTeamChannel';
import {
  SUBAGENT_TEAM_ID_ENV,
  SUBAGENT_TEAM_MAIN_MEMBER_ENV,
  SUBAGENT_TEAM_MEMBER_ID_ENV,
  SUBAGENT_TEAM_MEMBER_TOKEN_ENV,
  SUBAGENT_TEAM_ROOT_SESSION_ENV,
} from '../../src/exports/env';
import { TEMP_ROOT_DIR } from '../../src/adapters/filesystem/paths';
import * as path from 'node:path';

const ENV_KEYS = [
  SUBAGENT_TEAM_ID_ENV,
  SUBAGENT_TEAM_ROOT_SESSION_ENV,
  SUBAGENT_TEAM_MAIN_MEMBER_ENV,
  SUBAGENT_TEAM_MEMBER_ID_ENV,
  SUBAGENT_TEAM_MEMBER_TOKEN_ENV,
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const createdTeamIds: string[] = [];

function freshRoot(): TeamRootContext {
  const root = ensureNativeTeamRoot(`session-${Math.random().toString(36).slice(2)}`);
  createdTeamIds.push(root.teamId);
  return root;
}

afterEach(() => {
  restoreEnv();
  while (createdTeamIds.length > 0) {
    const teamId = createdTeamIds.pop();
    if (teamId) fs.rmSync(path.join(TEMP_ROOT_DIR, 'team-channels', teamId), { recursive: true, force: true });
  }
});

describe('RunnerTeamMembership (thin composition seam over nativeTeamChannel.ts)', () => {
  it('readRoot() returns undefined when this process has no team root', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const membership = new RunnerTeamMembership();

    expect(membership.readRoot()).toBeUndefined();
  });

  it('readRoot() returns the real root once one has been applied to this process', () => {
    const root = freshRoot();
    applyNativeTeamRootEnvironment(root);
    const membership = new RunnerTeamMembership();

    expect(membership.readRoot()).toEqual(root);

    clearNativeTeamRootEnvironment(root);
  });

  it('register() joins the real team and dispose() marks the real member inactive', () => {
    const root = freshRoot();
    const membership = new RunnerTeamMembership();

    const registration = membership.register({
      root,
      role: 'subagent',
      agent: 'worker',
      runId: 'run-1',
      childIndex: 0,
    });

    expect(registration.context.agent).toBe('worker');
    expect(readMember(root, registration.context.memberId)?.active).toBe(true);

    registration.dispose();

    expect(readMember(root, registration.context.memberId)?.active).toBe(false);
  });

  it("register() propagates the real function's throw (e.g. no name or agent to derive one from)", () => {
    const root = freshRoot();
    const membership = new RunnerTeamMembership();

    expect(() => membership.register({ root, role: 'subagent' })).toThrow(
      /needs a name or an agent to derive one from/,
    );
  });
});
