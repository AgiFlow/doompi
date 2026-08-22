import { describe, expect, it } from 'vitest';
import { collectVoiceCommandContext } from '../src/adapters/pi/voiceCommandContext.ts';

function message(messageValue: Record<string, unknown>): Record<string, unknown> {
  return { type: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(), message: messageValue };
}

function pendingQuestionEntries(): Record<string, unknown>[] {
  return [
    message({ role: 'user', content: [{ type: 'text', text: 'I need a choice' }], timestamp: Date.now() }),
    message({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'ask-1',
          name: 'ask_user_question',
          arguments: {
            questions: [
              {
                question: 'Which package should I update?',
                options: [
                  { label: 'DoomPi', description: 'Description must stay out' },
                  { label: 'Agiflow', description: 'Another private description' },
                ],
              },
            ],
          },
        },
      ],
      timestamp: Date.now(),
    }),
    message({
      role: 'toolResult',
      toolCallId: 'ask-1',
      toolName: 'ask_user_question',
      content: [{ type: 'text', text: 'Raw tool output must stay out' }],
      details: { awaitingResponse: true, voicePrompt: 'Private generated narration' },
      isError: false,
      timestamp: Date.now(),
    }),
  ];
}

function taskEntry(tasks: unknown[]): Record<string, unknown> {
  return message({
    role: 'toolResult',
    toolCallId: 'task-1',
    toolName: 'task',
    content: [{ type: 'text', text: 'Detailed task output must stay out' }],
    details: { tasks },
    isError: false,
    timestamp: Date.now(),
  });
}

describe('collectVoiceCommandContext', () => {
  it('projects only the active question text, option labels, and active task subjects', () => {
    const entries = [
      ...pendingQuestionEntries(),
      taskEntry([
        { id: 4, subject: 'Pending package migration', description: 'private detail', status: 'pending' },
        { id: 2, subject: 'Active DoomPi correction', description: 'private detail', status: 'in_progress' },
        { id: 3, subject: 'Failed Agiflow check', description: 'private detail', status: 'failed' },
        { id: 1, subject: 'Completed old work', description: 'private detail', status: 'completed' },
        { id: 5, subject: 'Deleted old work', description: 'private detail', status: 'deleted' },
      ]),
    ];

    const context = collectVoiceCommandContext(entries);

    expect(context).toEqual({
      pendingQuestions: ['Which package should I update? DoomPi | Agiflow'],
      tasks: ['Active DoomPi correction', 'Pending package migration', 'Failed Agiflow check'],
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('private detail');
    expect(serialized).not.toContain('Raw tool output');
    expect(serialized).not.toContain('Description must stay out');
    expect(serialized).not.toContain('Completed old work');
  });

  it('includes bounded available mode names and action names when a catalog snapshot exists', () => {
    const modes = Array.from({ length: 20 }, (_, index) => ({
      descriptor: {
        source: `owner-${index}`,
        id: `mode-${index}`,
        label: `Mode ${index}`,
        description: 'Available mode',
        order: index,
        actions: [
          {
            id: `activate-${index}`,
            label: 'Activate',
            description: 'Activate the mode',
            contexts: ['tui' as const],
            parameters: [],
          },
        ],
      },
      state: { activation: 'inactive' as const, condition: 'ready' as const, actions: [] },
      ownerGeneration: `owner-generation-${index}`,
      registrationId: `registration-${index}`,
      stateRevision: 1,
    }));

    const context = collectVoiceCommandContext([], modes);

    expect(context?.minorModes?.[0]).toBe('Mode 0 (mode-0) actions: activate-0');
    expect(context?.minorModes).toHaveLength(16);
    expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(2_048);
    expect(collectVoiceCommandContext([])).toBeUndefined();
  });

  it('drops the pending question after the next user turn while retaining active tasks', () => {
    const entries = [
      taskEntry([{ id: 1, subject: 'Answer DoomPi question', status: 'in_progress' }]),
      ...pendingQuestionEntries(),
      message({ role: 'user', content: [{ type: 'text', text: 'doom pie' }], timestamp: Date.now() }),
    ];

    expect(collectVoiceCommandContext(entries)).toEqual({ tasks: ['Answer DoomPi question'] });
  });

  it('ignores non-pending question results and stale task snapshots outside the bounded branch window', () => {
    const staleTask = taskEntry([{ id: 1, subject: 'Stale task name', status: 'in_progress' }]);
    const noise = Array.from({ length: 256 }, (_, index) =>
      message({ role: 'assistant', content: [{ type: 'text', text: `noise ${index}` }], timestamp: Date.now() }),
    );
    const question = pendingQuestionEntries();
    const result = question.at(-1);
    if (!result || typeof result.message !== 'object' || result.message === null)
      throw new Error('question result unavailable');
    (result.message as Record<string, unknown>).details = { awaitingResponse: false };

    expect(collectVoiceCommandContext([staleTask, ...noise])).toBeUndefined();
    expect(collectVoiceCommandContext(question)).toBeUndefined();
  });

  it('bounds question, option, task, and branch preprocessing', () => {
    const hugeQuestions = Array.from({ length: 100 }, (_, questionIndex) => ({
      question: `Question ${questionIndex} ${'q'.repeat(20_000)}`,
      options: Array.from({ length: 100 }, (_, optionIndex) => ({
        label: `Option ${optionIndex} ${'o'.repeat(20_000)}`,
      })),
    }));
    const entries = [
      message({
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'ask-large', name: 'ask_user_question', arguments: { questions: hugeQuestions } },
        ],
        timestamp: Date.now(),
      }),
      message({
        role: 'toolResult',
        toolCallId: 'ask-large',
        toolName: 'ask_user_question',
        details: { awaitingResponse: true },
        content: [],
        timestamp: Date.now(),
      }),
      taskEntry(
        Array.from({ length: 1_000 }, (_, index) => ({
          id: index + 1,
          subject: `Task ${index} ${'t'.repeat(20_000)}`,
          status: 'pending',
        })),
      ),
    ];

    const context = collectVoiceCommandContext(entries);

    expect(context?.pendingQuestions?.length).toBeLessThanOrEqual(4);
    expect(context?.tasks?.length).toBeLessThanOrEqual(8);
    expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(2_048);
  });
});
