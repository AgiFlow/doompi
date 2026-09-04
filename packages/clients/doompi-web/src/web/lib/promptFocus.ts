/**
 * Where the keyboard belongs when no overlay holds it.
 *
 * Overlays opened by a shortcut have no trigger element, so the browser has
 * nothing to restore focus to when they close and the caret lands on the
 * body: the next keystroke goes nowhere. The composer registers its input
 * here and every overlay hands focus back to it, which is what makes
 * "ctrl+k, escape, keep typing" work. A module-level ref rather than a store
 * because nothing renders from it.
 */
let promptInput: HTMLTextAreaElement | null = null;

/** The composer claims the keyboard on mount; the returned disposer releases it. */
export function registerPromptInput(element: HTMLTextAreaElement | null): () => void {
  promptInput = element;
  return () => {
    if (promptInput === element) promptInput = null;
  };
}

/** Returns the caret to the composer, if there is one and it can take it. */
export function focusPrompt(caret?: number): void {
  if (promptInput === null || promptInput.disabled) return;
  promptInput.focus();
  if (caret !== undefined) promptInput.setSelectionRange(caret, caret);
}
