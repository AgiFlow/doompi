import { describe, expect, it } from 'vitest';
import { requestTaskInstruction, requestTaskRemoval, taskInstruction, tasks, tasksChannel } from '../web/tasksStore.ts';

describe('task cockpit store', () => {
  it('parses task payloads and rejects invalid envelopes', () => {
    tasks.reset();
    expect(tasksChannel.parse({ tasks: [], rev: 'bad' })).toBeNull();
    const payload = tasksChannel.parse({
      rev: 2,
      tasks: [
        { id: 1, subject: 'Pending', status: 'pending', blockedBy: [2, 'bad'] },
        { id: 2, subject: 'Failed', status: 'failed' },
        { id: 'bad', subject: 'Ignored', status: 'pending' },
      ],
    });
    expect(payload).not.toBeNull();
    tasksChannel.apply('s1', payload!);
    expect(tasks.select(tasks.store.state, 's1')).toEqual({
      rev: 2,
      tasks: [
        { id: 1, subject: 'Pending', status: 'pending', blockedBy: [2] },
        { id: 2, subject: 'Failed', status: 'failed', blockedBy: [] },
      ],
    });
    tasks.reset();
  });

  it('builds explicit prompts for edits, notes, and dependency-safe removal', () => {
    expect(taskInstruction(4, 'edit', ' change owner ')).toContain('Update task #4');
    expect(taskInstruction(4, 'note', ' use the API ')).toContain('note to the agent working on task #4');

    const frames: Array<{ sessionId: string; frame: Record<string, unknown> }> = [];
    const send = (sessionId: string, frame: Record<string, unknown>): void => {
      frames.push({ sessionId, frame });
    };
    requestTaskInstruction(send, 's1', 4, 'note', 'use the API');
    requestTaskRemoval(send, 's1', 4);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.frame.message).toContain('use the API');
    expect(frames[1]?.frame.message).toContain('repair every dependency');
  });
});
