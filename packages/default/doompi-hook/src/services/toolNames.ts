/**
 * Pi's tool names translated into the Claude names hook matchers are written
 * against.
 *
 * Hook authors write `matcher: Bash`, and Pi reports `bash`, so a matcher would
 * never fire without this. Only this direction belongs here: rewriting Claude
 * names for Pi is an agent-definition concern the harness owns.
 */
const PI_TO_CLAUDE = new Map([
  ['read', 'Read'],
  ['edit', 'Edit'],
  ['write', 'Write'],
  ['bash', 'Bash'],
  ['find', 'Glob'],
  ['grep', 'Grep'],
  ['subagent', 'Agent'],
]);

/** The Claude name a hook matcher expects for a tool Pi just ran. */
export function toClaudeToolName(tool: string): string {
  return PI_TO_CLAUDE.get(tool) ?? tool;
}

/** Whether a matcher, if the row declares one, accepts the tool that fired. */
export function matchesTool(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!toolName || !matcher) return true;
  return new RegExp(matcher).test(toClaudeToolName(toolName));
}
