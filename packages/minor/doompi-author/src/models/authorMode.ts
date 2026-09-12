import { defineMinorMode } from '@agimon-ai/doompi-minor-mode';
import { AUTHOR_MODE_ID } from '../types/author';

export interface AuthorModeBackend {
  isActive(): boolean;
  detail(): string | undefined;
  setActive(active: boolean, signal: AbortSignal): void | Promise<void>;
}

export const authorMinorMode = defineMinorMode<AuthorModeBackend>({
  descriptor: {
    source: '@agimon-ai/doompi-author',
    id: AUTHOR_MODE_ID,
    label: 'Author',
    description: 'Focused document review and bounded authoring through the current visual viewport.',
    order: 440,
    actions: [
      {
        id: 'activate',
        label: 'Activate',
        description: 'Expose the current Author viewport capabilities to the agent.',
        contexts: ['tui', 'headless'],
        parameters: [],
      },
      {
        id: 'deactivate',
        label: 'Deactivate',
        description: 'Hide Author viewport capabilities from the agent.',
        contexts: ['tui', 'headless'],
        parameters: [],
      },
    ],
  },
  state(runtime) {
    const active = runtime.isActive();
    const detail = active ? runtime.detail() : undefined;
    return {
      activation: active ? 'active' : 'inactive',
      condition: 'ready',
      ...(detail ? { detail } : {}),
      actions: [
        { id: 'activate', enabled: !active, ...(active ? { disabledReason: 'Author mode is already active.' } : {}) },
        { id: 'deactivate', enabled: active, ...(!active ? { disabledReason: 'Author mode is not active.' } : {}) },
      ],
    };
  },
  async handleAction(runtime, actionId, _args, { signal }) {
    if (actionId === 'activate') {
      await runtime.setActive(true, signal);
      return { message: 'Author mode activated.' };
    }
    if (actionId === 'deactivate') {
      await runtime.setActive(false, signal);
      return { message: 'Author mode deactivated.' };
    }
    throw new Error(`Unknown Author mode action: ${actionId}`);
  },
});
