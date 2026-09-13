import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { COMMAND_NAME } from '../../../src/constants/prompts';
import { createPromptsCommand } from '../../../src/controllers/promptsCommand';
import { createRecentPrompts } from '../../../src/models/recentPrompts';
import type { PromptExtensionDependencies } from '../../../src/types/prompt';

const pickerConstructed = vi.hoisted(() => vi.fn());

vi.mock('@agimon-ai/doompi-ui/matrix-picker', () => ({
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
  const handlers = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]['handler']>();
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
      registerCommand(name: string, options: { handler: Parameters<ExtensionAPI['registerCommand']>[1]['handler'] }) {
        handlers.set(name, options.handler);
      },
    },
    ctx,
    run: async () => handlers.get(COMMAND_NAME)?.('', ctx as unknown as ExtensionCommandContext),
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
    host.pi.registerCommand(...createPromptsCommand(dependencies(['staged one'])));

    await host.run();

    expect(host.ctx.ui.custom).toHaveBeenCalledOnce();
    expect(pickerConstructed).toHaveBeenCalled();
    const [options] = pickerConstructed.mock.calls.at(-1) as [{ title: string; items: { value: string }[] }];
    expect(options.title).toBe('Prompts');
    expect(options.items.map((item) => item.value)).toEqual(['recent:0', 'saved:review']);
  });

  it('stages the picked staged prompt', async () => {
    const host = tuiHost(['recent:0']);
    host.pi.registerCommand(...createPromptsCommand(dependencies(['staged one'])));

    await host.run();

    expect(host.editor()).toBe('staged one');
  });

  it('stages the picked saved prompt', async () => {
    const host = tuiHost(['saved:review']);
    host.pi.registerCommand(...createPromptsCommand(dependencies([])));

    await host.run();

    expect(host.editor()).toBe('Review the diff');
  });

  it('leaves the editor alone when the picker is dismissed', async () => {
    const host = tuiHost(undefined);
    host.pi.registerCommand(...createPromptsCommand(dependencies(['staged one'])));

    await host.run();

    expect(host.editor()).toBe('');
  });
});
