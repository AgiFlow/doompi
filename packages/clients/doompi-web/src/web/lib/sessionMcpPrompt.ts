import type { SessionMcpTool } from '../../types/sessionMcp';

const LOAD_CONTEXT = 'load_context';
const LOAD_EXTRA_TOOLS = 'load_extra_tools';
const USE_EXTRA_TOOLS = 'use_extra_tools';

/** Remote name a connected agent sees. Activity snapshots carry internal names. */
export function sessionMcpRemoteToolName(name: string, toolPrefix?: string): string {
  return toolPrefix ? `${toolPrefix}_${name}` : name;
}

/** Pasteable instructions that steer a remote agent to this session's MCP tools. Uses the full, unfiltered list. */
export function sessionMcpToolsPrompt(
  tools: readonly Pick<SessionMcpTool, 'name' | 'description'>[],
  toolPrefix?: string,
): string {
  const names = new Set(tools.map((tool) => tool.name));
  const remote = (name: string): string => sessionMcpRemoteToolName(name, toolPrefix);
  const lines = [
    'Use the DoomPi MCP tools below for work in the DoomPi session repository. They run on the DoomPi host, not on your local machine.',
    'Prefer them over your built-in bash, read, edit, write, grep, find, or ls tools for that repository.',
  ];
  if (toolPrefix) lines.push(`Every tool name starts with "${toolPrefix}_".`);
  if (names.has(LOAD_CONTEXT)) lines.push(`Start each task with ${remote(LOAD_CONTEXT)}.`);
  if (names.has(LOAD_EXTRA_TOOLS) && names.has(USE_EXTRA_TOOLS))
    lines.push(
      `If a tool below is missing from your tool list, call ${remote(LOAD_EXTRA_TOOLS)}, then run it with ${remote(USE_EXTRA_TOOLS)}.`,
    );
  lines.push(
    '',
    'Tools:',
    ...tools.map((tool) => `- ${remote(tool.name)}: ${tool.description.replace(/\s+/g, ' ').trim()}`),
  );
  return lines.join('\n');
}
