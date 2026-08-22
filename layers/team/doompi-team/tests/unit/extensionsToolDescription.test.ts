import { describe, expect, it } from 'vitest';

import { SUBAGENT_ACTIONS } from '@agimon-ai/doompi-extension-contracts/subagent-tool';
import { SUBAGENT_SAFETY_GUIDANCE, SUBAGENT_TOOL_DESCRIPTION } from '../../src/adapters/pi/extensions/toolDescription';

describe('SUBAGENT_TOOL_DESCRIPTION', () => {
  it('mentions every supported action and no removed action or alias', () => {
    for (const action of Object.values(SUBAGENT_ACTIONS)) expect(SUBAGENT_TOOL_DESCRIPTION).toContain(`${action}:`);
    expect(SUBAGENT_TOOL_DESCRIPTION).not.toContain('wait:');
    for (const removed of ['subagent_wait', 'subagent_team', 'subagent_supervisor', 'contact_supervisor', 'chain']) {
      expect(SUBAGENT_TOOL_DESCRIPTION).not.toContain(removed);
    }
  });

  it('documents the canonical request array and external runtime limits', () => {
    expect(SUBAGENT_TOOL_DESCRIPTION).toContain('requests:[{agent,task,cwd?,model?,runtime?}]');
    expect(SUBAGENT_TOOL_DESCRIPTION).toContain('do not support steering or intercom');
    expect(SUBAGENT_TOOL_DESCRIPTION).toContain('Team package tool exclusions are best effort');
  });

  it('reserves delegation for work that repays its overhead', () => {
    expect(SUBAGENT_TOOL_DESCRIPTION).toContain('Delegate only independent parallel work');
    expect(SUBAGENT_TOOL_DESCRIPTION).toContain('long-running work');
    expect(SUBAGENT_TOOL_DESCRIPTION).toContain('fresh context');
    expect(SUBAGENT_TOOL_DESCRIPTION).toContain('handle small direct tasks yourself');
  });

  it('requires self-contained child tasks instead of promising coordination', () => {
    expect(SUBAGENT_SAFETY_GUIDANCE).toContain('self-contained task');
    expect(SUBAGENT_SAFETY_GUIDANCE).toContain('Team package policy');
    expect(SUBAGENT_SAFETY_GUIDANCE).not.toContain('through intercom');
  });

  it('includes the shared safety guidance once', () => {
    expect(SUBAGENT_TOOL_DESCRIPTION.indexOf(SUBAGENT_SAFETY_GUIDANCE)).toBe(
      SUBAGENT_TOOL_DESCRIPTION.lastIndexOf(SUBAGENT_SAFETY_GUIDANCE),
    );
  });
});
