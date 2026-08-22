import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import {
  formatWorkflowStepMessage,
  isWorkflowStepMessageDetails,
  renderWorkflowStepMessage,
  workflowStepMessageDetails,
} from '../../src/tui/workflow/workflowStepMessage';

const theme = {
  bg: (_colour: string, text: string) => text,
  fg: (_colour: string, text: string) => text,
} as unknown as Theme;

describe('workflow step messages', () => {
  it('omits duration for STARTED and uses the run display name plus job', () => {
    const details = workflowStepMessageDetails('Funny dancing dog today', {
      job: 'source-tiktok',
      key: 'started',
      status: 'STARTED',
      step: 'Source TikTok',
    });

    expect(formatWorkflowStepMessage(details)).toBe('[Funny dancing dog today]: source-tiktok\nSTARTED::Source TikTok');
  });

  it('includes elapsed duration for FINISHED and FAILED', () => {
    for (const status of ['FINISHED', 'FAILED'] as const) {
      const details = workflowStepMessageDetails('run', {
        duration: '5m32s',
        job: 'source-tiktok',
        key: status,
        status,
        step: 'Source TikTok',
      });

      expect(formatWorkflowStepMessage(details)).toContain(`${status}::5m32s::Source TikTok`);
    }
  });

  it('renders two compact fitted lines without the generic custom-type label', () => {
    const details = {
      displayName: 'A very long workflow display name',
      duration: '5m32s',
      job: 'source-tiktok',
      status: 'FINISHED' as const,
      step: 'A very long step that must be truncated to the terminal',
    };

    const lines = renderWorkflowStepMessage(details, 'fallback', 0, theme).render(32);
    const rendered = lines.join('\n');

    expect(rendered).toContain('[A very long workflow');
    expect(rendered).toContain('FINISHED::5m32s');
    expect(rendered).not.toContain('[workflow-step]');
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
  });

  it('validates every supported status and rejects malformed metadata', () => {
    const base = { displayName: 'run', job: 'job', step: 'step' };
    for (const status of ['STARTED', 'FINISHED', 'FAILED'] as const) {
      expect(isWorkflowStepMessageDetails({ ...base, status })).toBe(true);
    }
    expect(isWorkflowStepMessageDetails({ ...base, status: 'UNKNOWN' })).toBe(false);
    expect(isWorkflowStepMessageDetails({ ...base, status: 'STARTED', duration: 42 })).toBe(false);
    expect(isWorkflowStepMessageDetails(null)).toBe(false);
    expect(isWorkflowStepMessageDetails([])).toBe(false);
  });

  it('renders started and failed transitions without duration', () => {
    for (const status of ['STARTED', 'FAILED'] as const) {
      const lines = renderWorkflowStepMessage(
        { displayName: 'run', job: 'job', status, step: 'step' },
        'fallback',
        0,
        theme,
      ).render(40);
      expect(lines.join('\n')).toContain(`${status}::step`);
    }
  });

  it('falls back for old persisted messages', () => {
    const lines = renderWorkflowStepMessage(undefined, 'legacy workflow step', 0, theme).render(40);
    expect(lines.join('\n')).toContain('legacy workflow step');
  });
});
