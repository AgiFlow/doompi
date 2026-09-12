import { describe, expect, it, vi } from 'vitest';
import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { MinorModeCatalogService, MinorModeRecord } from '../../src/schemas/mode';
import { headlessMinorModeCommand } from '../../src/services/headlessCommand';

function harness(answers: unknown[]) {
  const record: MinorModeRecord = {
    descriptor: {
      source: '@agimon-ai/test',
      id: 'plan',
      label: 'Plan',
      description: 'Planning',
      order: 1,
      actions: [
        {
          id: 'start',
          label: 'Start',
          description: 'Start planning',
          contexts: ['headless'],
          parameters: [
            { name: 'confirm', label: 'Confirm', kind: 'boolean', required: true },
            { name: 'note', label: 'Note', kind: 'string', required: true },
            { name: 'count', label: 'Count', kind: 'number', required: true },
            {
              name: 'style',
              label: 'Style',
              kind: 'enum',
              required: true,
              choices: [{ label: 'Brief', value: 'brief' }],
            },
          ],
        },
      ],
    },
    state: { activation: 'inactive', condition: 'ready', actions: [] },
    ownerGeneration: 'owner',
    registrationId: 'registration',
    stateRevision: 1,
  };
  const invoke = vi.fn(async () => ({ operationId: 'operation', catalogRevision: 1, mode: record }));
  const catalog = { list: () => [record], invoke } as unknown as MinorModeCatalogService;
  const request = vi.fn(async () => answers.shift());
  const notify = vi.fn();
  const execution = { client: { request, notify } } as unknown as DoomHeadlessExecutionContext;
  return { command: headlessMinorModeCommand(catalog), execution, request, notify, invoke };
}

describe('headless minor command interaction', () => {
  it('converts typed client replies into catalog arguments, retaining false', async () => {
    const h = harness(['[ ] Plan: Planning', false, 'hello', '3', 'Brief']);
    await h.command.execute('', h.execution);
    expect(h.request.mock.calls).toHaveLength(5);
    expect(h.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'start',
        arguments: { confirm: false, note: 'hello', count: 3, style: 'brief' },
      }),
      expect.any(String),
    );
    expect(h.notify).toHaveBeenCalledWith({ body: 'Plan is inactive.', level: 'info' });
  });

  it.each([
    [null],
    ['unrecognized'],
    ['[ ] Plan: Planning', null],
    ['[ ] Plan: Planning', true, null],
    ['[ ] Plan: Planning', true, ''],
    ['[ ] Plan: Planning', true, 'note', 'NaN'],
    ['[ ] Plan: Planning', true, 'note', '2', null],
    ['[ ] Plan: Planning', true, 'note', '2', 'invalid'],
  ])('does not invoke a mode after cancellation or invalid replies: %j', async (...answers) => {
    const h = harness(answers);
    await h.command.execute('', h.execution);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('reports a rejected action to the requesting client', async () => {
    const h = harness([true, 'note', '2', 'Brief']);
    h.invoke.mockRejectedValueOnce(new Error('Owner stopped'));
    await h.command.execute('plan start', h.execution);
    expect(h.notify).toHaveBeenCalledWith({ body: 'Plan Start failed: Owner stopped', level: 'error' });
  });
});
