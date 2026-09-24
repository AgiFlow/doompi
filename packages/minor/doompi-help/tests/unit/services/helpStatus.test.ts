import { DOOM_HELP_WHEN as HELP_WHEN, type DoomHelpSnapshot } from '@agimon-ai/doompi-core/help';
import { describe, expect, it, vi } from 'vitest';

import {
  createHelpStatusTool,
  helpStatusDetail,
  piHelpStatus,
  serverHelpStatus,
} from '../../../src/services/helpStatus';

const snapshot: DoomHelpSnapshot = {
  hostGeneration: 'host',
  revision: 1,
  activation: 'active',
  diagnostics: [],
  skills: [
    {
      source: '@fixture/owner',
      name: 'help-skill',
      description: 'help',
      filePath: '/private/SKILL.md',
      baseDir: '/private',
    },
  ],
};

describe('Help applied-capability diagnostics', () => {
  it('counts only usable Help entries and reports missing paths without exposing declarations', () => {
    const report = serverHelpStatus(
      {
        revision: 4,
        ready: true,
        capabilities: [
          { source: '@fixture/help', name: 'good', kind: 'skill', when: HELP_WHEN, active: true, discoverable: true },
          {
            source: '@fixture/help',
            name: 'bad',
            kind: 'skill',
            when: HELP_WHEN,
            active: true,
            discoverable: false,
            reason: 'not-discoverable',
          },
          {
            source: '@fixture/help',
            name: 'restricted',
            kind: 'tool',
            when: HELP_WHEN,
            active: false,
            discoverable: false,
            reason: 'restricted',
          },
          {
            source: '@fixture/help',
            name: 'diagnostic',
            kind: 'tool',
            when: HELP_WHEN,
            active: true,
            discoverable: true,
          },
          { source: '@fixture/ordinary', name: 'read', kind: 'tool', active: true, discoverable: true },
        ],
      },
      true,
    );
    expect(report).toMatchObject({ activation: 'degraded', counts: { skills: 1, tools: 1 }, truncated: false });
    expect(report.tools.map((tool) => tool.name)).toEqual(['restricted', 'diagnostic']);
    expect(helpStatusDetail(report)).toBe('1 Help skills, 1 diagnostic tools (diagnostics available)');
    expect(serverHelpStatus({ revision: 1, ready: false, capabilities: [] }, true)).toMatchObject({
      activation: 'activating',
      counts: { skills: null },
    });
    expect(serverHelpStatus({ revision: 1, ready: true, capabilities: [] }, false).activation).toBe('inactive');
  });

  it('bounds the reported inventory while retaining accurate totals', () => {
    const capabilities = Array.from({ length: 140 }, (_, index) => ({
      source: '@fixture/help',
      name: `tool${index}`,
      kind: 'tool' as const,
      when: HELP_WHEN,
      active: true,
      discoverable: true,
    }));
    const report = serverHelpStatus({ revision: 1, ready: true, capabilities }, true);
    expect(report.tools).toHaveLength(128);
    expect(report).toMatchObject({ counts: { tools: 140 }, truncated: true, activation: 'active' });
  });

  it('uses the Pi skill consumer inventory instead of counting unresolved or shadowed descriptors', () => {
    const tool = { source: '@fixture/log', name: 'diagnostic', active: true, attribution: HELP_WHEN.attribution };
    expect(piHelpStatus(snapshot, undefined, [tool])).toMatchObject({
      ready: false,
      activation: 'degraded',
      counts: { skills: null, tools: 1 },
    });
    expect(piHelpStatus(snapshot, [], [tool])).toMatchObject({
      counts: { skills: 0 },
      skills: [{ active: false, reason: 'shadowed' }],
    });
    const report = piHelpStatus(
      {
        ...snapshot,
        diagnostics: [{ source: '@fixture/owner', code: 'HELP_SOURCE_FAILED', message: 'credential=secret' }],
      },
      snapshot.skills,
      [{ ...tool, active: false }],
    );
    expect(report).toMatchObject({
      counts: { skills: 1, tools: 0 },
      tools: [{ active: false, reason: 'inactive-or-restricted' }],
    });
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(JSON.stringify(report)).not.toContain('/private');
    expect(piHelpStatus(snapshot, snapshot.skills, []).activation).toBe('active');
  });

  it('does not return evidence after the owning Help invocation has been revoked', async () => {
    const controller = new AbortController();
    const report = serverHelpStatus({ revision: 1, ready: true, capabilities: [] }, true);
    const inspect = vi.fn(async () => {
      controller.abort(new Error('revoked'));
      return report;
    });
    const tool = createHelpStatusTool(inspect, () => controller.signal);
    const execution = { cwd: '/fixture', toolCallId: 'call', notify() {}, update() {} };
    await expect(tool.execute({}, execution)).rejects.toThrow('revoked');
    const ready = createHelpStatusTool(
      () => report,
      () => new AbortController().signal,
    );
    expect((await ready.execute({}, execution)).details).toEqual(report);
  });
});
