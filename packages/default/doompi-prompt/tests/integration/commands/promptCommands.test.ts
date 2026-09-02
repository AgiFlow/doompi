import { describe, expect, it, vi } from 'vitest';
import { registerPromptSaveCommand } from '../../../src/commands/promptSaveCommand.ts';
import { registerPromptsCommand } from '../../../src/commands/promptsCommand.ts';
import { createRecentPrompts } from '../../../src/services/recentPrompts.ts';
import type { PromptExtensionDependencies, SavedPrompt } from '../../../src/types/prompt.ts';

interface CommandHandler {
  (args: string, ctx: unknown): Promise<void>;
}

/**
 * The shared Pi test host cannot resolve a custom component and drops editor
 * text on the floor, so these tests drive the handlers through a local double
 * that records what the commands actually do to the editor.
 */
function testHost() {
  const handlers = new Map<string, CommandHandler>();
  const notifications: { message: string; level: string }[] = [];
  let editorText = '';
  let confirmAnswer = true;

  const pi = {
    registerCommand(name: string, options: { handler: CommandHandler }) {
      handlers.set(name, options.handler);
    },
  };

  const ctx = {
    hasUI: true,
    // 'rpc' keeps the picker on Pi's plain selector, which resolves in tests.
    mode: 'rpc',
    ui: {
      notify: (message: string, level: string) => void notifications.push({ message, level }),
      select: vi.fn(async (_title: string, options: string[]): Promise<string | undefined> => options[0]),
      confirm: vi.fn(async () => confirmAnswer),
      getEditorText: () => editorText,
      setEditorText: (text: string) => {
        editorText = text;
      },
    },
  };

  return {
    pi,
    ctx,
    notifications,
    run: async (name: string, args = '') => handlers.get(name)?.(args, ctx),
    editor: () => editorText,
    setEditor: (text: string) => {
      editorText = text;
    },
    answerConfirm: (answer: boolean) => {
      confirmAnswer = answer;
    },
  };
}

function dependencies(overrides: Partial<PromptExtensionDependencies> = {}): PromptExtensionDependencies {
  const saved: SavedPrompt[] = [];
  return {
    recent: overrides.recent ?? createRecentPrompts(),
    store: overrides.store ?? {
      list: async () => saved,
      has: async (name: string) => saved.some((prompt) => prompt.name === name),
      save: async (prompt: SavedPrompt) => {
        saved.push(prompt);
        return { name: prompt.name, path: `/tmp/prompts/${prompt.name}.md` };
      },
      remove: async (name: string) => {
        const index = saved.findIndex((prompt) => prompt.name === name);
        if (index === -1) return false;
        saved.splice(index, 1);
        return true;
      },
    },
  };
}

describe('/prompts', () => {
  it('stages the picked prompt in an empty editor', async () => {
    const host = testHost();
    const deps = dependencies();
    deps.recent.push('review the diff');
    registerPromptsCommand(host.pi, deps);

    await host.run('prompts');

    expect(host.editor()).toBe('review the diff');
  });

  it('appends to a draft rather than replacing it', async () => {
    const host = testHost();
    const deps = dependencies();
    deps.recent.push('review the diff');
    registerPromptsCommand(host.pi, deps);
    host.setEditor('half written');

    await host.run('prompts');

    expect(host.editor()).toBe('half written\nreview the diff');
  });

  it('says so when there is nothing staged or saved', async () => {
    const host = testHost();
    registerPromptsCommand(host.pi, dependencies());

    await host.run('prompts');

    expect(host.notifications[0]?.message).toContain('No staged or saved prompts yet');
    expect(host.ctx.ui.select).not.toHaveBeenCalled();
  });

  it('reports a store it cannot read instead of failing the command', async () => {
    const host = testHost();
    const deps = dependencies({
      store: {
        list: async () => {
          throw new Error('permission denied');
        },
        has: async () => false,
        save: async () => ({ name: 'x', path: 'x' }),
        remove: async () => false,
      },
    });
    registerPromptsCommand(host.pi, deps);

    await host.run('prompts');

    expect(host.notifications[0]).toEqual({
      message: 'Could not read saved prompts: permission denied',
      level: 'warning',
    });
  });

  it('leaves the editor alone when the picker is cancelled', async () => {
    const host = testHost();
    const deps = dependencies();
    deps.recent.push('review the diff');
    host.ctx.ui.select.mockResolvedValueOnce(undefined);
    registerPromptsCommand(host.pi, deps);

    await host.run('prompts');

    expect(host.editor()).toBe('');
  });

  it('does nothing on a host with no UI', async () => {
    const host = testHost();
    host.ctx.hasUI = false;
    const deps = dependencies();
    deps.recent.push('review the diff');
    registerPromptsCommand(host.pi, deps);

    await host.run('prompts');

    expect(host.ctx.ui.select).not.toHaveBeenCalled();
  });
});

describe('/prompt-save', () => {
  it('saves the editor draft under the given name', async () => {
    const host = testHost();
    const deps = dependencies();
    registerPromptSaveCommand(host.pi, deps);
    host.setEditor('Review the diff\nand report');

    await host.run('prompt-save', 'review');

    await expect(deps.store.list()).resolves.toEqual([
      { name: 'review', description: 'Review the diff', text: 'Review the diff\nand report' },
    ]);
    expect(host.notifications[0]?.message).toContain('/tmp/prompts/review.md');
  });

  it('falls back to the newest staged prompt when the editor is empty', async () => {
    const host = testHost();
    const deps = dependencies();
    deps.recent.push('older');
    deps.recent.push('newest');
    registerPromptSaveCommand(host.pi, deps);

    await host.run('prompt-save', 'again');

    await expect(deps.store.list()).resolves.toEqual([{ name: 'again', description: 'newest', text: 'newest' }]);
  });

  it('asks before replacing an existing prompt and honours a refusal', async () => {
    const host = testHost();
    const deps = dependencies();
    registerPromptSaveCommand(host.pi, deps);
    host.setEditor('first');
    await host.run('prompt-save', 'review');
    host.answerConfirm(false);
    host.setEditor('second');

    await host.run('prompt-save', 'review');

    expect(host.ctx.ui.confirm).toHaveBeenCalledOnce();
    await expect(deps.store.list()).resolves.toEqual([{ name: 'review', description: 'first', text: 'first' }]);
  });

  it('rejects a name that would not work as a file or a command', async () => {
    const host = testHost();
    const deps = dependencies();
    registerPromptSaveCommand(host.pi, deps);
    host.setEditor('body');

    await host.run('prompt-save', '../escape');

    expect(host.notifications[0]?.level).toBe('warning');
    await expect(deps.store.list()).resolves.toEqual([]);
  });

  it('asks for a name when none is given', async () => {
    const host = testHost();
    registerPromptSaveCommand(host.pi, dependencies());

    await host.run('prompt-save', '   ');

    expect(host.notifications[0]?.message).toBe('Usage: /prompt-save <name>');
  });

  it('refuses to save nothing', async () => {
    const host = testHost();
    registerPromptSaveCommand(host.pi, dependencies());

    await host.run('prompt-save', 'empty');

    expect(host.notifications[0]?.message).toContain('Nothing to save');
  });

  it('warns when the saved text carries template argument tokens', async () => {
    const host = testHost();
    registerPromptSaveCommand(host.pi, dependencies());
    host.setEditor('Review $1 carefully');

    await host.run('prompt-save', 'review');

    expect(host.notifications[0]?.message).toContain('$ tokens');
  });

  it('reports a failed write instead of throwing', async () => {
    const host = testHost();
    const deps = dependencies({
      store: {
        list: async () => [],
        has: async () => false,
        save: async () => {
          throw new Error('disk full');
        },
        remove: async () => false,
      },
    });
    registerPromptSaveCommand(host.pi, deps);
    host.setEditor('body');

    await host.run('prompt-save', 'review');

    expect(host.notifications[0]).toEqual({ message: 'Could not save "review": disk full', level: 'warning' });
  });

  it('does nothing on a host with no UI', async () => {
    const host = testHost();
    host.ctx.hasUI = false;
    const deps = dependencies();
    registerPromptSaveCommand(host.pi, deps);
    host.setEditor('body');

    await host.run('prompt-save', 'review');

    await expect(deps.store.list()).resolves.toEqual([]);
  });
});
