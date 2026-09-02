import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  describePrompt,
  hasArgumentTokens,
  isValidPromptName,
  PROMPT_NAME_RULE,
} from '../services/savedPromptDocument.ts';
import { COMMAND_NAME as PROMPTS_COMMAND_NAME } from './promptsCommand.ts';
import type { PromptExtensionDependencies } from '../types/prompt.ts';

/**
 * `/prompt-save <name>`: keep the current prompt for later sessions.
 *
 * DESIGN PATTERNS:
 * - Saves what the user is looking at: the editor draft, or the newest staged
 *   prompt when the editor is empty.
 * - Writes a plain Pi prompt template, so the saved prompt becomes `/<name>`
 *   on the next start without this package registering a command for it.
 *
 * AVOID:
 * - Overwriting an existing template without asking.
 */

export const COMMAND_NAME = 'prompt-save';
export const COMMAND_DESCRIPTION = 'Save the current prompt for reuse in later sessions';

const WARNING = 'warning';
const INFO = 'info';

export function registerPromptSaveCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  deps: PromptExtensionDependencies,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;

      const name = args.trim();
      if (!name) {
        ctx.ui.notify(`Usage: /${COMMAND_NAME} <name>`, WARNING);
        return;
      }
      if (!isValidPromptName(name)) {
        ctx.ui.notify(`"${name}" is not a usable prompt name. Use ${PROMPT_NAME_RULE}.`, WARNING);
        return;
      }

      const draft = ctx.ui.getEditorText().trim();
      const text = draft || deps.recent.list()[0] || '';
      if (!text) {
        ctx.ui.notify('Nothing to save: the editor is empty and no prompt is staged.', WARNING);
        return;
      }

      try {
        if (await deps.store.has(name)) {
          const replace = await ctx.ui.confirm('Replace saved prompt', `A prompt named "${name}" already exists.`);
          if (!replace) return;
        }

        const written = await deps.store.save({ name, description: describePrompt(text), text });
        const warning = hasArgumentTokens(text)
          ? ' It contains $ tokens, which Pi substitutes as template arguments when you run the command.'
          : '';
        ctx.ui.notify(
          `Saved ${written.path}. Use it from /${PROMPTS_COMMAND_NAME}, or as /${name} after the next start.${warning}`,
          INFO,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save "${name}": ${reason}`, WARNING);
      }
    },
  });
}
