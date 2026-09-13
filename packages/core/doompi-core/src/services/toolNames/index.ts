/**
 * Translation between Claude and Pi tool names.
 *
 * Both directions are needed: agent definitions are authored with Claude names
 * and have to be rewritten for Pi, while repository hook matchers are written
 * against Claude names and are tested against the Pi name of the tool that
 * fired. Deriving the reverse map from the forward one is what stops the two
 * drifting, which they previously could because each direction had its own
 * hand-maintained table.
 */

const CLAUDE_TO_PI = new Map([
  ['Read', 'read'],
  ['Edit', 'edit'],
  ['Write', 'write'],
  ['Bash', 'bash'],
  ['Glob', 'find'],
  ['Grep', 'grep'],
  ['Agent', 'subagent'],
]);

const PI_TO_CLAUDE = new Map([...CLAUDE_TO_PI].map(([claudeName, piName]) => [piName, claudeName]));

const MCP_TOOL = 'mcp';
const SKILL_TOOL = 'Skill';
const MCP_TOOL_PREFIX = 'mcp__';
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);

/**
 * Pi's name for a tool named in an agent definition.
 *
 * Returns undefined for Skill, which Pi discovers rather than declares. Web and
 * MCP tools all collapse onto Pi's single `mcp` tool. Definitions already
 * written against Pi pass through unchanged, and an unrecognised name throws
 * rather than reaching Pi as a tool it will silently ignore.
 */
export function toPiToolName(tool: string): string | undefined {
  if (tool === SKILL_TOOL) return undefined;
  if (WEB_TOOLS.has(tool) || tool.startsWith(MCP_TOOL_PREFIX)) return MCP_TOOL;
  const mapped = CLAUDE_TO_PI.get(tool);
  if (mapped) return mapped;
  if (tool === MCP_TOOL || PI_TO_CLAUDE.has(tool)) return tool;
  throw new Error(`Unsupported agent tool: ${tool}`);
}

/** The Claude name a hook matcher expects for a tool Pi just ran. */
export function toClaudeToolName(tool: string): string {
  return PI_TO_CLAUDE.get(tool) ?? tool;
}
