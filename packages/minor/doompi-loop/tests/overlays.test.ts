import type {
  DoomLoopLaunchersService,
  LoopInstanceSnapshot,
  LoopLauncherSummary,
} from '@agimon-ai/doompi-extension-contracts/loop-launchers';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopListOverlay, openLoopListOverlay } from '../src/tui/loopListOverlay.ts';
import { openStartLoopOverlay, StartLoopOverlay } from '../src/tui/startLoopOverlay.ts';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

function createTui(rows = 24): TUI {
  return { terminal: { rows, columns: 100 }, requestRender: vi.fn() } as unknown as TUI;
}

const launchers: readonly LoopLauncherSummary[] = [
  { id: 'first', source: 'test', label: 'First loop', description: 'First description' },
  { id: 'second', source: 'test', label: 'Second loop' },
];

function instance(instanceId: string, state: LoopInstanceSnapshot['state'] = 'running'): LoopInstanceSnapshot {
  return {
    instanceId,
    launcherId: 'first',
    launcherLabel: 'First loop',
    label: `Instance ${instanceId}`,
    detail: `detail ${instanceId}`,
    state,
  };
}

function createClient(initial: readonly LoopInstanceSnapshot[] = []) {
  let instances = initial;
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const stop = vi.fn(async (instanceId: string) => {
    instances = instances.filter((entry) => entry.instanceId !== instanceId);
    listener?.();
    return true;
  });
  const client: DoomLoopLaunchersService = {
    generation: 'overlay-test',
    register: vi.fn(),
    listLaunchers: () => launchers,
    listInstances: () => instances,
    subscribe: vi.fn((nextListener: () => void) => {
      listener = nextListener;
      return unsubscribe;
    }),
    launch: vi.fn(),
    stop,
    stopAll: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    client,
    stop,
    unsubscribe,
    replace(next: readonly LoopInstanceSnapshot[]) {
      instances = next;
      listener?.();
    },
  };
}

function printContext(
  select: (title: string, options: readonly string[]) => Promise<string | undefined>,
): ExtensionContext {
  return { mode: 'print', ui: { select } } as unknown as ExtensionContext;
}

describe('StartLoopOverlay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders descriptions and selects with keyboard navigation', () => {
    const done = vi.fn();
    const overlay = new StartLoopOverlay(createTui(), theme, launchers, done);
    const rendered = overlay.render(100).join('\n');
    expect(rendered).toContain('START LOOP');
    expect(rendered).toContain('First description');
    overlay.handleInput('j');
    overlay.handleInput('\r');
    expect(done).toHaveBeenCalledWith('second');
    overlay.handleInput('k');
    overlay.handleInput('\r');
    expect(done).toHaveBeenLastCalledWith('first');
  });

  it('uses the canonical list legend in full and compact chrome', () => {
    const full = new StartLoopOverlay(createTui(), theme, launchers, vi.fn()).render(100).join('\n');
    const compact = new StartLoopOverlay(createTui(5), theme, launchers, vi.fn()).render(100).join('\n');

    for (const rendered of [full, compact]) {
      expect(rendered).toContain('↑↓');
      expect(rendered).not.toContain('j/k');
    }
  });

  it('renders an empty state and cancels safely', () => {
    const done = vi.fn();
    const overlay = new StartLoopOverlay(createTui(), theme, [], done);
    expect(overlay.render(80).join('\n')).toContain('No loop launchers');
    overlay.handleInput('j');
    overlay.handleInput('q');
    overlay.handleInput('\x1b');
    expect(done).toHaveBeenCalledTimes(2);
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('uses ordinary selection outside TUI mode', async () => {
    await expect(
      openStartLoopOverlay(
        printContext(async (_title, options) => options[1]),
        launchers,
      ),
    ).resolves.toBe('second');
    await expect(
      openStartLoopOverlay(
        printContext(async () => undefined),
        launchers,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('LoopListOverlay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders live instances, navigates, and stops the selected schedule', async () => {
    const fixture = createClient([instance('one'), instance('two', 'starting')]);
    const done = vi.fn();
    const overlay = new LoopListOverlay(createTui(), theme, fixture.client, done);
    const rendered = overlay.render(100).join('\n');
    expect(rendered).toContain('Instance one');
    expect(rendered).toContain('starting');
    expect(rendered).toContain('does not cancel detached work already launched');
    overlay.handleInput('j');
    overlay.handleInput('x');
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalledWith('two', 'Stopped from the loop list.'));
    expect(overlay.render(100).join('\n')).not.toContain('Instance two');
    overlay.handleInput('k');
    overlay.handleInput('q');
    expect(done).toHaveBeenCalledWith(undefined);
    overlay.dispose();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  it('uses the canonical list legend in full and compact chrome', () => {
    const fixture = createClient([instance('one')]);
    const full = new LoopListOverlay(createTui(), theme, fixture.client, vi.fn());
    const compact = new LoopListOverlay(createTui(5), theme, fixture.client, vi.fn());

    for (const rendered of [full.render(100).join('\n'), compact.render(100).join('\n')]) {
      expect(rendered).toContain('↑↓');
      expect(rendered).not.toContain('j/k');
    }

    full.dispose();
    compact.dispose();
  });

  it('refreshes to empty and ignores unavailable controls', () => {
    const fixture = createClient([instance('one')]);
    const overlay = new LoopListOverlay(createTui(), theme, fixture.client, vi.fn());
    fixture.replace([]);
    expect(overlay.render(80).join('\n')).toContain('No loop instances');
    overlay.handleInput('j');
    overlay.handleInput('k');
    overlay.handleInput('x');
    expect(fixture.stop).not.toHaveBeenCalled();
    overlay.dispose();
  });

  it('uses ordinary selection outside TUI mode', async () => {
    const fixture = createClient([instance('one'), instance('two')]);
    await openLoopListOverlay(
      printContext(async (_title, options) => options[1]),
      fixture.client,
    );
    expect(fixture.stop).toHaveBeenCalledWith('two', 'Stopped from the loop list.');
  });

  it('does nothing when ordinary selection is cancelled', async () => {
    const fixture = createClient([instance('one')]);
    await openLoopListOverlay(
      printContext(async () => undefined),
      fixture.client,
    );
    expect(fixture.stop).not.toHaveBeenCalled();
  });
});
