import type { ToolPromptContribution, ToolPromptDialog } from '@agimon-ai/doompi-web-contracts';
import { pluginToolRenderer } from './pluginRegistry.ts';
import type { DialogRequest, SessionState, ToolEntry } from './sessionModel.ts';

/**
 * Which running tool, if any, owns the open extension UI request.
 *
 * The composer and the dialog have to agree, or the reader gets both surfaces
 * or neither, so the verdict is one pure function they both read rather than
 * a flag each keeps. It is pure for the same reason the rest of sessionModel
 * is: the interesting cases are combinations of session state, and none of
 * them need a browser to exercise.
 *
 * The pairing is an inference. Pi's protocol does not say which tool a request
 * belongs to, only that one is open, so this reads the newest running tool
 * whose plugin declared a prompt and lets that plugin confirm the request is
 * its own. A tool that declares no prompt never participates, and a request no
 * prompt claims stays with the host's dialog.
 */
export interface ToolPromptClaim {
  entry: ToolEntry;
  prompt: ToolPromptContribution;
  dialog: ToolPromptDialog;
}

/** The request as a plugin reads it; the same fields, without the host's own type. */
function promptDialog(dialog: DialogRequest): ToolPromptDialog {
  return {
    id: dialog.id,
    method: dialog.method,
    title: dialog.title,
    message: dialog.message,
    options: dialog.options,
    placeholder: dialog.placeholder,
    prefill: dialog.prefill,
  };
}

/** The three facts the verdict rests on, so a caller can memoize on exactly those. */
export type ToolPromptInput = Pick<SessionState, 'dialog' | 'entries' | 'activeTools' | 'statuses'>;

/**
 * `spokenFor` is a request some other surface has already taken: the one the
 * selection bar claimed with a click, or one whose prompt threw and handed it
 * back. Passed in rather than read, because both live in stores and this layer
 * sits below them so that every surface can reach it.
 */
export function toolPromptClaim(state: ToolPromptInput, spokenFor: string | null): ToolPromptClaim | null {
  const request = state.dialog;
  if (request === null) return null;
  if (spokenFor === request.id) return null;

  const dialog = promptDialog(request);
  // Live tools are kept outside the protocol-owned transcript. Search those
  // first, then fall back to timeline tools for threads and direct frame clients.
  const groups = [state.activeTools, state.entries] as const;
  for (const entries of groups) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined || entry.kind !== 'tool' || !entry.running) continue;
      const prompt = pluginToolRenderer(entry.name, state.statuses)?.prompt;
      if (prompt === undefined) continue;
      if (prompt.claims?.(dialog, entry.args) === false) continue;
      return { entry, prompt, dialog };
    }
  }
  return null;
}
