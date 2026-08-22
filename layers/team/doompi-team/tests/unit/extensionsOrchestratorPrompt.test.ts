import { describe, expect, it } from 'vitest';

import {
  appendOrchestratorPrompt,
  ORCHESTRATOR_PROMPT,
  ORCHESTRATOR_PROMPT_MARKER,
  shouldInjectOrchestratorPrompt,
} from '../../src/adapters/pi/extensions/orchestratorPrompt';

describe('shouldInjectOrchestratorPrompt', () => {
  it('is on by default, because the extension loads in every session and the guidance is the point', () => {
    expect(shouldInjectOrchestratorPrompt({})).toBe(true);
  });

  it('is off only for an explicit false', () => {
    expect(shouldInjectOrchestratorPrompt({ orchestratorPrompt: false })).toBe(false);
  });

  it('treats an explicit true the same as absent', () => {
    expect(shouldInjectOrchestratorPrompt({ orchestratorPrompt: true })).toBe(true);
  });
});

describe('appendOrchestratorPrompt', () => {
  it('appends to an existing system prompt without discarding it', () => {
    const result = appendOrchestratorPrompt('You are a helpful assistant.');

    expect(result).toContain('You are a helpful assistant.');
    expect(result).toContain(ORCHESTRATOR_PROMPT_MARKER);
  });

  it('returns the addendum alone when there is no base prompt', () => {
    expect(appendOrchestratorPrompt(undefined)).toBe(ORCHESTRATOR_PROMPT);
  });

  it('is idempotent, so a replayed per-turn hook cannot stack two copies', () => {
    const once = appendOrchestratorPrompt('base');
    const twice = appendOrchestratorPrompt(once);

    expect(twice).toBe(once);
    expect(twice.split(ORCHESTRATOR_PROMPT_MARKER)).toHaveLength(2);
  });
});

describe('what the addendum actually teaches', () => {
  // These assert the behaviours the tool description could not enforce on its
  // own, and that the sibling implementation gets right via a coordinator
  // prompt. They are deliberately about substance, not wording.
  it('reserves delegation for work that repays launch and context costs', () => {
    expect(ORCHESTRATOR_PROMPT).toMatch(/Do it yourself/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/few steps should not become a subagent/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/merely because an agent\s+is available/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/plan has multiple items/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/meaningful wall-clock savings/i);
  });

  it('lets the model choose whether to continue non-overlapping work or end its turn without polling', () => {
    // `\s+` rather than a literal space: the prompt is hard-wrapped, so any of
    // these phrases can straddle a line break.
    expect(ORCHESTRATOR_PROMPT).toMatch(/do not sleep or poll/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/does not duplicate the delegated scope/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/end your\s+turn/i);
  });

  it('does not advertise removed chain or wait tools', () => {
    expect(ORCHESTRATOR_PROMPT).not.toMatch(/\bchain\b/i);
    expect(ORCHESTRATOR_PROMPT).not.toContain('subagent_wait');
    expect(ORCHESTRATOR_PROMPT).not.toContain('{action:"wait"}');
  });

  it('forbids inventing results that have not arrived', () => {
    expect(ORCHESTRATOR_PROMPT).toMatch(/never invent or predict a\s+result/is);
  });

  it('states that workers cannot see the conversation', () => {
    expect(ORCHESTRATOR_PROMPT).toMatch(/cannot see this conversation/i);
  });

  it('hands known context over for direct reads instead of a repository inventory', () => {
    expect(ORCHESTRATOR_PROMPT).toMatch(/Known context is a handoff, not a hint/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/parent-verified paths and facts/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/read known paths\s+directly before broad discovery/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/satisfies generic initial-context\s+exploration/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/not a repository\s+inventory/i);
  });

  it('does not promise child coordination or delegation tools', () => {
    expect(ORCHESTRATOR_PROMPT).toMatch(/self-contained task/i);
    expect(ORCHESTRATOR_PROMPT).toMatch(/must not assume they can contact main or delegate further/i);
    expect(ORCHESTRATOR_PROMPT).not.toContain('receives only `intercom`');
  });

  it('stays short enough to carry on every turn', () => {
    // Not a style rule: this is prepended to every turn of every session, so
    // its length is a recurring cost. The sibling implementation's equivalent
    // is ~90 lines; this one deliberately is not.
    expect(ORCHESTRATOR_PROMPT.split('\n').length).toBeLessThan(60);
  });
});
