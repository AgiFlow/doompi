/**
 * Translation from Claude tool names to Pi tool names.
 *
 * Agent definitions inside a domain's plugins are authored with Claude names and
 * have to be rewritten before Pi loads them. The reverse map is derived from the
 * forward one so a name that is already written for Pi passes through without a
 * second hand-maintained table to keep in step.
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

const PI_TOOL_NAMES = new Set(CLAUDE_TO_PI.values());

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
  if (tool === MCP_TOOL || PI_TOOL_NAMES.has(tool)) return tool;
  throw new Error(`Unsupported agent tool: ${tool}`);
}
