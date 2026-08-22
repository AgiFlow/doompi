import { SKILL_INVOCATION_PREFIX } from '../types/skills.ts';

/**
 * Prefills the draft rather than submitting it.
 *
 * `/skill:<name>` is expanded by Pi inside `prompt()`, which only the editor's
 * own submission path reaches: `sendUserMessage` sets `expandPromptTemplates`
 * false and would deliver the literal text. Leaving the command in the editor
 * keeps the expansion and costs one keystroke.
 */
export function skillInvocation(name: string): string {
  return `${SKILL_INVOCATION_PREFIX}${name} `;
}
