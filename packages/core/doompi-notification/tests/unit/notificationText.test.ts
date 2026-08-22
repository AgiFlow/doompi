import { describe, expect, it } from 'vitest';
import {
  attentionNotification,
  notificationBody,
  promptTitle,
  settledNotification,
  shellTabTitle,
} from '../../src/services/notificationText.ts';

const MAX_PROMPT_TITLE_LENGTH = 36;
const MAX_BODY_LENGTH = 240;

describe('promptTitle', () => {
  it('collapses the prompt onto one line', () => {
    expect(promptTitle('  Fix   the\nshell title  ')).toBe('Fix the shell title');
  });

  it('gives a blank prompt no title at all', () => {
    expect(promptTitle('   \n\t ')).toBeUndefined();
  });

  it('truncates a prompt too long for a tab', () => {
    const title = promptTitle('a'.repeat(MAX_PROMPT_TITLE_LENGTH * 2));

    expect(title).toBe(`${'a'.repeat(MAX_PROMPT_TITLE_LENGTH - 1)}…`);
    expect(title).toHaveLength(MAX_PROMPT_TITLE_LENGTH);
  });
});

describe('shellTabTitle', () => {
  it('names the repository when nothing else identifies the session', () => {
    expect(shellTabTitle({ cwd: '/repo/example' })).toBe('π - example');
  });

  it('prefers the session name the user chose over the first prompt', () => {
    expect(shellTabTitle({ cwd: '/repo/example', sessionName: 'loader-work', prompt: 'Fix the title' })).toBe(
      'π - loader-work - example',
    );
  });

  it('falls back to the first prompt for an unnamed session', () => {
    expect(shellTabTitle({ cwd: '/repo/example', prompt: 'Fix the title' })).toBe('π - Fix the title - example');
  });
});

describe('notificationBody', () => {
  it('collapses a multi-line body onto one line', () => {
    expect(notificationBody('Done.\n\n  Ready for review. ')).toBe('Done. Ready for review.');
  });

  it('truncates a body longer than a notification panel shows', () => {
    const body = notificationBody('b'.repeat(MAX_BODY_LENGTH * 2));

    expect(body).toHaveLength(MAX_BODY_LENGTH);
    expect(body.endsWith('…')).toBe(true);
  });
});

describe('notification messages', () => {
  it('labels an attention notification as needing the user', () => {
    expect(attentionNotification('Allow this operation once?')).toEqual({
      title: 'Pi needs your input',
      subtitle: 'Approval or feedback required',
      body: 'Allow this operation once?',
    });
  });

  it('subtitles a settled run with the repository when the session is unnamed', () => {
    expect(settledNotification({ cwd: '/repo/example' })).toEqual({
      title: 'Pi finished',
      subtitle: 'example',
      body: 'The agent finished its work and is waiting for you.',
    });
  });

  it('subtitles a settled run with the session name when there is one', () => {
    expect(settledNotification({ cwd: '/repo/example', sessionName: 'loader-work' }).subtitle).toBe('loader-work');
  });
});
