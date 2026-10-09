import type { SessionMcpTool } from '../../types/sessionMcp';

const LOAD_CONTEXT = 'load_context';
const LOAD_EXTRA_TOOLS = 'load_extra_tools';
const USE_EXTRA_TOOLS = 'use_extra_tools';

/** Remote name a connected agent sees. Activity snapshots carry internal names. */
export function sessionMcpRemoteToolName(name: string, toolPrefix?: string): string {
  return toolPrefix ? `${toolPrefix}_${name}` : name;
}

/** Pasteable instructions that steer a remote agent to this session's MCP tools. Uses the grant-filtered list. */
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
      `${remote(LOAD_EXTRA_TOOLS)} lists tools added or changed after you connected. Run one of those with ${remote(USE_EXTRA_TOOLS)}, passing the exact name it returns.`,
    );
  lines.push(
    'If a tool below is not in your visible tool list, find it in ALL_TOOLS (code mode) before concluding it is missing; do not use tool search or guess names.',
    'Await every call, print its result, and check isError. If a call may have changed files or state, inspect before retrying.',
    '',
    'Tools:',
    ...tools.map((tool) => `- ${remote(tool.name)}: ${tool.description.replace(/\s+/g, ' ').trim()}`),
  );
  return lines.join('\n');
}
