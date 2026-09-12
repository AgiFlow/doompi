import type { DoomToolRestriction } from '@agimon-ai/doompi-extension-contracts/tool-surface';

/**
 * Hides the questionnaire tool while nobody can answer it.
 *
 * Autonomous Voice narrates its own question and then waits for the spoken reply, so a
 * questionnaire tool alongside it asks the same thing twice. A run without UI cannot render
 * the questionnaire at all. Both cases only ever remove the name: the tool surface recomputes
 * from every registered tool, so a visible gate restores it without tracking what it hid.
 */
export function askUserToolRestriction(toolName: string, visible: boolean): DoomToolRestriction {
  return (incoming) => (visible ? incoming : incoming.filter((name) => name !== toolName));
}
