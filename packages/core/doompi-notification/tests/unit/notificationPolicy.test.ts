import { describe, expect, it } from 'vitest';
import {
  askUserPromptBody,
  supportsShellTitle,
  warrantsAttentionNotification,
  warrantsSettledNotification,
} from '../../src/services/notificationPolicy.ts';

describe('warrantsAttentionNotification', () => {
  it('announces a dialog the agent opened mid-run', () => {
    expect(warrantsAttentionNotification({ agentRunning: true, askUserBlocked: false })).toBe(true);
  });

  it('stays quiet for a dialog the user opened themselves', () => {
    expect(warrantsAttentionNotification({ agentRunning: false, askUserBlocked: false })).toBe(false);
  });

  it('stays quiet while an ask-user prompt already announced itself', () => {
    expect(warrantsAttentionNotification({ agentRunning: true, askUserBlocked: true })).toBe(false);
  });
});

describe('warrantsSettledNotification', () => {
  it('reports a run that has actually stopped', () => {
    expect(warrantsSettledNotification(false)).toBe(true);
  });

  it('stays quiet while a follow-up message is queued', () => {
    expect(warrantsSettledNotification(true)).toBe(false);
  });
});

describe('supportsShellTitle', () => {
  it('writes titles to an attached terminal', () => {
    expect(supportsShellTitle({ hasUI: true, mode: 'tui' })).toBe(true);
  });

  it('keeps escape sequences out of RPC output', () => {
    expect(supportsShellTitle({ hasUI: true, mode: 'rpc' })).toBe(false);
  });

  it('writes nothing when the session has no UI', () => {
    expect(supportsShellTitle({ hasUI: false })).toBe(false);
  });
});

describe('askUserPromptBody', () => {
  it('uses the question the prompt is blocking on', () => {
    expect(askUserPromptBody([{ question: 'Which implementation?' }, { question: 'Ignored' }])).toBe(
      'Which implementation?',
    );
  });

  it('falls back to a generic body when the prompt asked nothing', () => {
    expect(askUserPromptBody([])).toBe('The agent is waiting for your feedback.');
  });
});
