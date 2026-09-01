import { describe, expect, it } from 'vitest';
import type { WebTask } from '../src/types/webTasks.ts';
import {
  requestTaskEdit,
  requestTaskMessage,
  requestTaskRemoval,
  taskEditDraft,
  taskEditInstruction,
  taskMessageInstruction,
  tasks,
  tasksChannel,
} from '../src/web/tasksStore.ts';

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

  it('names only the changed fields in an edit prompt', () => {
    const task: WebTask = { id: 4, subject: 'Ship it', description: 'old plan', status: 'pending', blockedBy: [] };
    expect(taskEditInstruction(task, taskEditDraft(task))).toBeNull();

    const instruction = taskEditInstruction(task, { subject: 'Ship it', description: 'old plan', status: 'failed' });
    expect(instruction).toContain('Update task #4');
    expect(instruction).toContain('set status to failed');
    expect(instruction).not.toContain('subject');

    const cleared = taskEditInstruction(task, { subject: 'Ship it later', description: '  ', status: 'pending' });
    expect(cleared).toContain('set subject to "Ship it later"');
    expect(cleared).toContain('clear the description');
  });

  it('sends edits, agent messages, and dependency-safe removal as prompt frames', () => {
    const task: WebTask = { id: 4, subject: 'Ship it', status: 'pending', blockedBy: [] };
    const frames: Array<{ sessionId: string; frame: Record<string, unknown> }> = [];
    const send = (sessionId: string, frame: Record<string, unknown>): void => {
      frames.push({ sessionId, frame });
    };

    expect(requestTaskEdit(send, 's1', task, taskEditDraft(task))).toBe(false);
    expect(requestTaskEdit(send, 's1', task, { subject: 'Ship it', description: '', status: 'in_progress' })).toBe(
      true,
    );
    requestTaskMessage(send, 's1', 4, 'doompi-developer', ' use the API ');
    requestTaskRemoval(send, 's1', 4);

    expect(frames).toHaveLength(3);
    expect(frames[0]?.frame.message).toContain('set status to in_progress');
    expect(frames[1]?.frame.message).toBe(taskMessageInstruction(4, 'doompi-developer', 'use the API'));
    expect(frames[1]?.frame.message).toContain('doompi-developer');
    expect(frames[2]?.frame.message).toContain('repair every dependency');
  });
});
