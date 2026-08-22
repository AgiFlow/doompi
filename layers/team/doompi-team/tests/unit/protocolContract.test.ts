import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import * as env from '../../src/exports/env';
import * as ceiling from '../../src/schemas/team/capabilityCeiling';
import * as delegation from '../../src/schemas/team/delegation';

describe('capability ceiling process contract', () => {
  it('pins the child-process wire literals', () => {
    expect(ceiling.SUBAGENT_CAPABILITY_CEILING_ENV).toBe('PI_SUBAGENT_CAPABILITY_CEILING_V1');
    expect(ceiling.SUBAGENT_CAPABILITY_CEILING_VERSION).toBe(2);
  });

  it('intersects tools and trusted profiles without widening either contributor', () => {
    const plan = ceiling.parseSubagentCapabilityCeiling({
      version: 2,
      allowedTools: ['read', 'bash', 'mcp'],
      requiredTools: ['bash', 'mcp'],
      allowMcpTools: true,
      allowedExternalProfiles: ['claude/fable-plan-v1', 'trusted/other'],
      denyExtensions: true,
      sources: ['plan'],
    });
    const team = ceiling.parseSubagentCapabilityCeiling({
      version: 2,
      allowedTools: ['read', 'bash'],
      requiredTools: ['bash'],
      allowMcpTools: false,
      allowedExternalProfiles: ['claude/fable-plan-v1'],
      denyExtensions: true,
      sources: ['team'],
    });

    expect(ceiling.intersectSubagentCapabilityCeilings(plan, team)).toEqual({
      version: 2,
      allowedTools: ['bash', 'read'],
      requiredTools: ['bash'],
      allowedExternalProfiles: ['claude/fable-plan-v1'],
      denyExtensions: true,
      sources: ['plan', 'team'],
    });
  });

  it('round-trips an encoded ceiling and refuses an unknown version', () => {
    const value = ceiling.parseSubagentCapabilityCeiling({
      version: 2,
      allowedTools: ['read'],
      denyExtensions: true,
      sources: ['parent'],
    });
    expect(ceiling.decodeSubagentCapabilityCeiling(ceiling.encodeSubagentCapabilityCeiling(value))).toEqual(value);
    expect(() => ceiling.decodeSubagentCapabilityCeiling(Buffer.from('{"version":1}').toString('base64url'))).toThrow(
      /Invalid inherited capability ceiling version/,
    );
  });
});

describe('legacy delegation payload vocabulary', () => {
  it('keeps versioned payload shapes independently of live transport', () => {
    const request: delegation.SubagentDelegationV2Request = {
      version: delegation.SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
      requestId: 'request-1',
      ownerRunId: 'run-1',
      nodeId: 'node-1',
      agent: 'reviewer',
      task: 'review',
      context: 'fork',
      cwd: '/repo',
      result: { kind: 'text' },
    };
    expect([request.requestId, request.ownerRunId, request.nodeId]).toEqual(['request-1', 'run-1', 'node-1']);
  });
});

describe('cross-process environment names', () => {
  it('pins unique names and shares the capability key with the codec', () => {
    expect(env.SUBAGENT_CHILD_ENV).toBe('PI_SUBAGENT_CHILD');
    expect(env.SUBAGENT_PARENT_SESSION_ENV).toBe('PI_SUBAGENT_PARENT_SESSION');
    expect(env.SUBAGENT_CAPABILITY_CEILING_ENV).toBe(ceiling.SUBAGENT_CAPABILITY_CEILING_ENV);
    const values = Object.values(env);
    expect(new Set(values).size).toBe(values.length);
  });
});
