import { readFile } from 'node:fs/promises';

import {
  type DoomHeadlessResource,
  type DoomHeadlessTool,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';

import { RunWorktreeParams, type RunWorktreeToolParams } from '../schemas/runWorktreeTool';
import { createWorktreeGit } from '../services/gitCli';
import {
  executeRunWorktreeTool,
  RUN_WORKTREE_DESCRIPTION,
  RUN_WORKTREE_TOOL_NAME,
  validateParams,
} from '../services/runWorktree';
import { createWorktreeMessageInbox } from '../services/worktreeEvents';
import { createWorktreeOperations } from '../services/worktreeOperations';

const PACKAGE_ROOT = new URL('../../', import.meta.url);

async function readPackageResource(name: string): Promise<string> {
  try {
    return await readFile(new URL(name, PACKAGE_ROOT), 'utf8');
  } catch {
    return `(resource unavailable: ${name})`;
  }
}

function progressResult(action: RunWorktreeToolParams['action'], label: string): DoomHeadlessToolResult {
  return { content: [{ type: 'text', text: label }], details: { action } };
}

export function createGitSession({ host: serverHost }: DoomServerPluginContext): DoomServerSessionPlugin {
  if (serverHost.context.directEvents === undefined)
    throw new Error('Git headless facet requires the session direct event bus.');
  if (serverHost.context.sessionId === undefined) throw new Error('Git headless facet requires a session identity.');
  const sessionId = serverHost.context.sessionId;
  const directEvents = serverHost.context.directEvents;
  const messageInbox = createWorktreeMessageInbox(directEvents, sessionId);
  const operations = createWorktreeOperations({
    git: createWorktreeGit(),
    sessionService: serverHost.context.sessionService,
    messageInbox,
  });
  const resources: DoomHeadlessResource[] = [
    { name: 'doompi-git', kind: 'context', read: () => readPackageResource('llms.txt') },
    {
      name: 'doompi-use-git',
      kind: 'skill',
      read: () => readPackageResource('src/prompts/doompi-use-git/SKILL.md'),
    },
    { name: 'doompi-git-readme', kind: 'context', read: () => readPackageResource('README.md') },
  ];

  const tool: DoomHeadlessTool<typeof RunWorktreeParams> = {
    name: RUN_WORKTREE_TOOL_NAME,
    label: 'Worktree',
    description: RUN_WORKTREE_DESCRIPTION,
    parameters: RunWorktreeParams,
    promptSnippet: 'Create and manage Git worktree sessions',
    executionMode: 'serial',
    async execute(_toolCallId, parameters, signal, onUpdate, execution) {
      const params = validateParams(parameters) as RunWorktreeToolParams;
      return executeRunWorktreeTool(params, operations, execution, {
        ...(signal === undefined ? {} : { signal }),
        onProgress: (label) => onUpdate?.(progressResult(params.action, label)),
      });
    },
  };
  return { resources, tools: [tool], onDispose: () => messageInbox.close() };
}
