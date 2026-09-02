import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SelectItem } from '@earendil-works/pi-tui';
import { promptItems, resolvePromptSelection, stagedEditorText } from '../services/promptItems.ts';
import type { PromptExtensionDependencies } from '../types/prompt.ts';

/**
 * `/prompts`: browse staged and saved prompts, and stage one in the editor.
 *
 * DESIGN PATTERNS:
 * - Reads both sources at open time, so a prompt saved earlier in this session
 *   is listed even though Pi only rediscovers templates on the next start.
 * - The shared picker component loads on first use: every session registers this
 *   command and almost none of them open it.
 * - Stages text through the host's editor API instead of sending it, because
 *   reuse usually means editing before submitting.
 *
 * AVOID:
 * - Replacing a draft the user is in the middle of writing.
 */

export const COMMAND_NAME = 'prompts';
export const COMMAND_DESCRIPTION = 'Browse staged and saved prompts';

const PICKER_TITLE = 'Prompts';
const TUI_MODE = 'tui';
const WARNING = 'warning';
const INFO = 'info';

type PickerModule = typeof import('@agimon-ai/doompi-ui/components/matrixPicker');

function lazyPicker(): () => Promise<PickerModule> {
  let picker: Promise<PickerModule> | undefined;
  return () => (picker ??= import('@agimon-ai/doompi-ui/components/matrixPicker'));
}

/** Opens the picker and resolves the chosen row's value, or undefined. */
async function pickPrompt(
  ctx: ExtensionContext,
  items: readonly SelectItem[],
  loadPicker: () => Promise<PickerModule>,
): Promise<string | undefined> {
  if (ctx.mode !== TUI_MODE) {
    // The cockpit and the RPC runtime have no component to render into.
    const labels = items.map((item) => item.label);
    const chosen = await ctx.ui.select(PICKER_TITLE, labels);
    const index = chosen === undefined ? -1 : labels.indexOf(chosen);
    return index === -1 ? undefined : items[index]?.value;
  }

  const { MatrixPickerComponent } = await loadPicker();
  const chosen = await ctx.ui.custom<string[] | undefined>(
    (_tui, theme, keybindings, done) =>
      new MatrixPickerComponent(
        { title: PICKER_TITLE, items: [...items], selected: [], multi: false },
        theme,
        keybindings,
        done,
      ),
  );
  return chosen?.[0];
}

export function registerPromptsCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  deps: PromptExtensionDependencies,
): void {
  const loadPicker = lazyPicker();

  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const recent = deps.recent.list();
      let saved: Awaited<ReturnType<typeof deps.store.list>>;
      try {
        saved = await deps.store.list();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not read saved prompts: ${reason}`, WARNING);
        return;
      }

      const items = promptItems(recent, saved);
      if (items.length === 0) {
        ctx.ui.notify('No staged or saved prompts yet. Submit a prompt, or save one with /prompt-save.', INFO);
        return;
      }

      const value = await pickPrompt(ctx, items, loadPicker);
      if (!value) return;

      const text = resolvePromptSelection(value, recent, saved);
      if (!text) return;
      ctx.ui.setEditorText(stagedEditorText(ctx.ui.getEditorText(), text));
    },
  });
}
