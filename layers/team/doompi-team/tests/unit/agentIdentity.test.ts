import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  adoptAgentIdentity,
  AGENT_NAMES,
  agentIdentitiesDir,
  claimAgentIdentity,
  composeIdentity,
  formatAgentIdentity,
  roleFromAgent,
} from '../../src/services/agentIdentity';
import { normalizeTeamMemberName } from '../../src/services/nativeTeamChannel';
import { createSessionScope, sessionScopeDir } from '../../src/services/sessionPaths';

const scopes: ReturnType<typeof createSessionScope>[] = [];

/** A scope of its own, so a counter assertion does not depend on what else ran. */
function freshScope() {
  const scope = createSessionScope(`agent-identity-${crypto.randomUUID()}`);
  scopes.push(scope);
  return scope;
}

afterEach(() => {
  for (const scope of scopes.splice(0)) fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
});

describe('roleFromAgent', () => {
  it('drops the package prefix, which every agent from one package shares', () => {
    expect(roleFromAgent('doompi-reviewer')).toBe('reviewer');
    expect(roleFromAgent('agiflow-dispatcher')).toBe('dispatcher');
  });

  it('keeps a bare agent name as its own role', () => {
    expect(roleFromAgent('worker')).toBe('worker');
  });

  it('falls back rather than producing an empty role for a name with no word characters', () => {
    expect(roleFromAgent('***')).toBe('agent');
    expect(roleFromAgent('')).toBe('agent');
  });
});

describe('composeIdentity', () => {
  it('reads as name, role, number', () => {
    expect(composeIdentity('reviewer', 1)).toBe(`${AGENT_NAMES[0]}-reviewer-1`);
  });

  it('keeps producing distinct identities after the name list wraps', () => {
    const first = composeIdentity('worker', 1);
    const wrapped = composeIdentity('worker', AGENT_NAMES.length + 1);
    expect(wrapped.startsWith(`${AGENT_NAMES[0]}-`)).toBe(true);
    expect(wrapped).not.toBe(first);
  });
});

describe('claimAgentIdentity', () => {
  it('numbers every agent in the session from one counter, whatever its role', () => {
    const scope = freshScope();
    const first = claimAgentIdentity(scope, { agent: 'doompi-reviewer', inline: false, runId: 'run-1' });
    const second = claimAgentIdentity(scope, { agent: 'doompi-reviewer', inline: false, runId: 'run-2' });
    const third = claimAgentIdentity(scope, { agent: 'doompi-developer', inline: false, runId: 'run-3' });

    expect([first.identity, second.identity, third.identity]).toEqual([
      `${AGENT_NAMES[0]}-reviewer-1`,
      `${AGENT_NAMES[1]}-reviewer-2`,
      `${AGENT_NAMES[2]}-developer-3`,
    ]);
    expect(first.persisted).toBe(true);
  });

  it('never hands the same identity to two runs', () => {
    const scope = freshScope();
    const claimed = Array.from(
      { length: 40 },
      (_, index) => claimAgentIdentity(scope, { agent: 'worker', inline: false, runId: `run-${index}` }).identity,
    );
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  // An operation journal replays a run id after a crash; that must not burn a
  // second number or rename an agent its peers already know.
  it('returns the same identity when the same run id claims again', () => {
    const scope = freshScope();
    const first = claimAgentIdentity(scope, { agent: 'worker', inline: false, runId: 'run-1' });
    claimAgentIdentity(scope, { agent: 'worker', inline: false, runId: 'run-2' });
    const replay = claimAgentIdentity(scope, { agent: 'worker', inline: false, runId: 'run-1' });

    expect(replay.identity).toBe(first.identity);
    expect(fs.readdirSync(agentIdentitiesDir(scope))).toHaveLength(2);
  });

  // Two processes in one session can allocate at the same moment. The `wx`
  // create is what arbitrates, so a number already taken by someone else must
  // move this caller along rather than fail it or overwrite them.
  it('skips a number another writer already took', () => {
    const scope = freshScope();
    const directory = agentIdentitiesDir(scope);
    fs.mkdirSync(directory, { recursive: true });
    // One entry present, so allocation starts at 2, and 2 is already taken by
    // a different run id than the one claiming here.
    const taken = composeIdentity('worker', 2);
    fs.writeFileSync(
      path.join(directory, `${taken}.json`),
      JSON.stringify({
        version: 1,
        identity: taken,
        name: 'x',
        role: 'worker',
        number: 2,
        agent: 'worker',
        inline: false,
        runId: 'someone-else',
        claimedAt: 1,
      }),
    );

    const claimed = claimAgentIdentity(scope, { agent: 'worker', inline: false, runId: 'run-mine' });

    expect(claimed.identity).toBe(composeIdentity('worker', 3));
    expect(claimed.persisted).toBe(true);
    // The other writer's claim is untouched.
    expect(JSON.parse(fs.readFileSync(path.join(directory, `${taken}.json`), 'utf-8')).runId).toBe('someone-else');
  });
  it('records the inline flag, which is the one thing the agent name cannot say', () => {
    const scope = freshScope();
    const inline = claimAgentIdentity(scope, { agent: 'doompi-developer', inline: true, runId: 'run-1' });
    expect(inline.inline).toBe(true);
    expect(formatAgentIdentity(inline.identity, inline.inline)).toBe(`${inline.identity} (inline)`);
  });

  // The identity is the intercom address, so it has to survive the channel's
  // own normalization untouched or a peer could not send to what it is shown.
  it('produces an identity that normalizes to itself and is never the reserved name', () => {
    const scope = freshScope();
    for (const agent of ['doompi-reviewer', 'Weird Name!', '***']) {
      const { identity } = claimAgentIdentity(scope, { agent, inline: false, runId: `run-${agent}` });
      expect(normalizeTeamMemberName(identity)).toBe(identity);
      expect(identity).not.toBe('main');
    }
  });

  it('still names a run when the scope directory cannot be written', () => {
    const blocked = createSessionScope('agent-identity-blocked');
    const directory = sessionScopeDir(blocked);
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    // A file where the identities directory belongs makes mkdir fail.
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(agentIdentitiesDir(blocked), 'not a directory');
    try {
      const identity = claimAgentIdentity(blocked, { agent: 'worker', inline: false, runId: 'abcdef1234' });
      expect(identity.persisted).toBe(false);
      expect(identity.identity).toBe('worker-abcdef12');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('adoptAgentIdentity', () => {
  // Restore mints a fresh run id for the same logical agent, so the claim has
  // to follow it rather than the agent being renamed.
  it('points an existing claim at the new run id without consuming a number', () => {
    const scope = freshScope();
    const { identity } = claimAgentIdentity(scope, { agent: 'worker', inline: false, runId: 'run-1' });

    adoptAgentIdentity(scope, identity, 'run-restored');

    const file = path.join(agentIdentitiesDir(scope), `${identity}.json`);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({ identity, runId: 'run-restored', version: 1 });
    expect(fs.readdirSync(agentIdentitiesDir(scope))).toHaveLength(1);
  });

  it('ignores an identity that was never claimed rather than inventing one', () => {
    const scope = freshScope();
    adoptAgentIdentity(scope, 'nobody-worker-9', 'run-1');
    expect(fs.existsSync(agentIdentitiesDir(scope))).toBe(false);
  });
});

describe('formatAgentIdentity', () => {
  it('marks inline and leaves everything else bare', () => {
    expect(formatAgentIdentity('alan-reviewer-1', false)).toBe('alan-reviewer-1');
    expect(formatAgentIdentity('alan-reviewer-1', true)).toBe('alan-reviewer-1 (inline)');
  });

  it('has nothing to render for a run that predates identities', () => {
    expect(formatAgentIdentity(undefined, false)).toBeUndefined();
  });
});

describe('the name list', () => {
  it('holds only lowercase ASCII names, so an identity is safe as a member id', () => {
    for (const name of AGENT_NAMES) expect(name).toMatch(/^[a-z]+$/);
  });

  it('has no duplicates, which would make two counters read alike', () => {
    expect(new Set(AGENT_NAMES).size).toBe(AGENT_NAMES.length);
  });

  it('is kept away from the reserved root member name', () => {
    expect(AGENT_NAMES).not.toContain('main');
  });
});

describe('temporary directory hygiene', () => {
  it('keeps claims under the session scope, not loose in the temp root', () => {
    const scope = freshScope();
    claimAgentIdentity(scope, { agent: 'worker', inline: false, runId: 'run-1' });
    expect(agentIdentitiesDir(scope).startsWith(sessionScopeDir(scope))).toBe(true);
    expect(sessionScopeDir(scope).startsWith(os.tmpdir())).toBe(true);
  });
});
