/**
 * The system-prompt block describing the tools a session currently exposes.
 *
 * Pi's CLI builds this from each tool's `promptSnippet` and `promptGuidelines`.
 * The headless host does not run that builder, so a tool's guidance reached the
 * cost estimate in `toolCost` but never the model. This renders the same two
 * sections, in Pi's shape, from whatever the host has just applied.
 */

export interface ToolPromptEntry {
  readonly name: string;
  /** One line describing the tool. Pi omits a tool without one, and so does this. */
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
}

export function formatToolPrompt(entries: readonly ToolPromptEntry[]): string {
  const listed = entries.filter((entry) => (entry.promptSnippet ?? '').trim().length > 0);
  // Two tools may repeat one guideline, and the reader should see it once.
  const guidelines = [
    ...new Set(entries.flatMap((entry) => entry.promptGuidelines ?? []).filter((line) => line.trim().length > 0)),
  ];
  const sections: string[] = [];
  if (listed.length > 0) {
    sections.push(`Available tools:\n${listed.map((entry) => `- ${entry.name}: ${entry.promptSnippet!}`).join('\n')}`);
  }
  if (guidelines.length > 0) {
    sections.push(`Guidelines:\n${guidelines.map((line) => `- ${line}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
