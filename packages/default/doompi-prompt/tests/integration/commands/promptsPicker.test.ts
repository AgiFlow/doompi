import { describe, expect, it, vi } from 'vitest';
import { COMMAND_NAME, registerPromptsCommand } from '../../../src/commands/promptsCommand.ts';
import { createRecentPrompts } from '../../../src/services/recentPrompts.ts';
import type { PromptExtensionDependencies } from '../../../src/types/prompt.ts';

const pickerConstructed = vi.hoisted(() => vi.fn());

vi.mock('@agimon-ai/doompi-ui/components/matrixPicker', () => ({
  MatrixPickerComponent: class MatrixPickerComponent {
    constructor(...args: unknown[]) {
      pickerConstructed(...args);
    }
  },
}));

/**
 * The TUI branch of the picker, which the rpc-mode command tests never reach:
 * there the command opens a component instead of the host's plain selector.
 */
function tuiHost(picked: string[] | undefined) {
  const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  let editorText = '';

  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      notify: vi.fn(),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
        factory(undefined, {}, {}, vi.fn());
        return picked;
      }),
      select: vi.fn(async () => undefined),
      getEditorText: () => editorText,
      setEditorText: (text: string) => {
        editorText = text;
      },
    },
  };

  return {
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        handlers.set(name, options.handler);
      },
    },
    ctx,
    run: async () => handlers.get(COMMAND_NAME)?.('', ctx),
    editor: () => editorText,
  };
}

function dependencies(staged: string[]): PromptExtensionDependencies {
  const recent = createRecentPrompts();
  for (const text of [...staged].reverse()) recent.push(text);
  return {
    recent,
    store: {
      list: async () => [{ name: 'review', description: 'Review', text: 'Review the diff' }],
      has: async () => true,
      save: async (prompt) => ({ name: prompt.name, path: `/memory/${prompt.name}.md` }),
      remove: async () => true,
    },
  };
}

describe('/prompts in the TUI', () => {
  it('opens the shared picker with both sections', async () => {
    const host = tuiHost(['recent:0']);
    registerPromptsCommand(host.pi, dependencies(['staged one']));

    await host.run();

    expect(host.ctx.ui.custom).toHaveBeenCalledOnce();
    expect(pickerConstructed).toHaveBeenCalled();
    const [options] = pickerConstructed.mock.calls.at(-1) as [{ title: string; items: { value: string }[] }];
    expect(options.title).toBe('Prompts');
    expect(options.items.map((item) => item.value)).toEqual(['recent:0', 'saved:review']);
  });

  it('stages the picked staged prompt', async () => {
    const host = tuiHost(['recent:0']);
    registerPromptsCommand(host.pi, dependencies(['staged one']));

    await host.run();

    expect(host.editor()).toBe('staged one');
  });

  it('stages the picked saved prompt', async () => {
    const host = tuiHost(['saved:review']);
    registerPromptsCommand(host.pi, dependencies([]));

    await host.run();

    expect(host.editor()).toBe('Review the diff');
  });

  it('leaves the editor alone when the picker is dismissed', async () => {
    const host = tuiHost(undefined);
    registerPromptsCommand(host.pi, dependencies(['staged one']));

    await host.run();

    expect(host.editor()).toBe('');
  });
});
