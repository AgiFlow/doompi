import { describe, expect, it, vi } from 'vitest';
import { registerLeaderContribution } from '../../../src/adapters/pi/leader.ts';
import { LEADER_GROUP, LEADER_KEY, PACKAGE_SOURCE } from '../../../src/adapters/pi/promptConstants.ts';
import { COMMAND_NAME } from '../../../src/commands/promptsCommand.ts';

describe('the leader contribution', () => {
  it('binds the picker under the shared extension group', () => {
    const dispose = vi.fn();
    const registerLeader = vi.fn(() => ({ dispose, update: vi.fn() }));

    registerLeaderContribution({ registerLeader } as never);

    expect(registerLeader).toHaveBeenCalledWith({
      source: PACKAGE_SOURCE,
      bindings: [
        {
          id: 'doom-prompt.open',
          path: [LEADER_GROUP, { key: LEADER_KEY, label: 'prompts', detail: 'staged and saved prompts' }],
          command: { name: COMMAND_NAME },
        },
      ],
    });
  });

  it('withdraws the binding when the fiber unwinds', () => {
    const dispose = vi.fn();
    const registerLeader = vi.fn(() => ({ dispose, update: vi.fn() }));

    registerLeaderContribution({ registerLeader } as never)();

    expect(dispose).toHaveBeenCalledOnce();
  });
});
