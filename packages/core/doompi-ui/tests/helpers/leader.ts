import type { DoomLeaderBinding } from '../../src/exports/leader.ts';
import { DoomLeaderRegistry } from '../../src/exports/leaderRegistry.ts';

export const TASK_LEADER_SOURCE = '@agimon-ai/doompi-task';

/**
 * The doom-task root binding under test.
 *
 * `order` sits between doom-plan's 60 and the core help group's 70, so the
 * assertions can pin the position rather than the literal number.
 */
export const TASK_LEADER_BINDING: DoomLeaderBinding = {
  id: 'tasks.open',
  path: [{ key: 't', label: 'tasks', order: 65 }],
  command: { name: 'tasks' },
};

export function createPlanLeaderRegistry(): DoomLeaderRegistry {
  const registry = new DoomLeaderRegistry();
  registry.register({
    source: '@agimon-ai/doompi-plan',
    bindings: [
      {
        id: 'plan.toggle',
        path: [
          { key: 'p', label: 'plan', order: 60 },
          { key: 'p', label: 'toggle' },
        ],
        command: { name: 'plan' },
      },
    ],
  });
  return registry;
}

/** Plan plus doom-task, the shape the editor sees once DXX-2 lands. */
export function createDoomLeaderRegistry(): DoomLeaderRegistry {
  const registry = createPlanLeaderRegistry();
  registry.register({
    source: TASK_LEADER_SOURCE,
    bindings: [TASK_LEADER_BINDING],
  });
  return registry;
}
