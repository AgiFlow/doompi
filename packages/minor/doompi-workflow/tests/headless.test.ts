import { describe, expect, it, vi } from 'vitest';

const { missingUiMessage } = vi.hoisted(() => ({
  missingUiMessage: 'doom-pi-ui is not installed in this headless host',
}));

vi.mock('@agimon-ai/doompi-ui/leader', () => {
  throw new Error(missingUiMessage);
});
vi.mock('@agimon-ai/doompi-ui/skills', () => {
  throw new Error(missingUiMessage);
});
vi.mock('@agimon-ai/doompi-ui/components/doomOverlay', () => {
  throw new Error(missingUiMessage);
});
vi.mock('@agimon-ai/doompi-ui/footer', () => {
  throw new Error(missingUiMessage);
});

function headlessPi() {
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    events: {
      emit(channel: string, data: unknown) {
        for (const listener of eventListeners.get(channel) ?? []) listener(data);
      },
      on(channel: string, listener: (data: unknown) => void) {
        const listeners = eventListeners.get(channel) ?? new Set<(data: unknown) => void>();
        listeners.add(listener);
        eventListeners.set(channel, listeners);
        return () => listeners.delete(listener);
      },
    },
    exec: vi.fn(),
    getActiveTools: vi.fn(() => []),
    on: vi.fn(() => vi.fn()),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setActiveTools: vi.fn(),
  };
}

describe('doom-workflow headless entry', () => {
  it('loads the sole standard Pi entry without the optional UI provider', async () => {
    vi.resetModules();
    const standard = await import('../src/exports/extensions/pi.ts');
    const pi = headlessPi();

    await expect(standard.default(pi as never)).resolves.toBeUndefined();
    expect(pi.registerTool).toHaveBeenCalled();
  });
});
