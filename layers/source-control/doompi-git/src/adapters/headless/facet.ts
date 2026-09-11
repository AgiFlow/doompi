import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessResource,
  type DoomHeadlessTool,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { DOOM_SERVER_HOST_SERVICE, requireDoomServerHost } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { readFile } from 'node:fs/promises';
import { RunWorktreeParams, type RunWorktreeToolParams } from '../../schemas/runWorktreeTool.ts';
import { createWorktreeGit } from '../worktree/gitCli.ts';
import { createWorktreeOperations } from '../worktree/worktreeOperations.ts';
import { createWorktreeMessageInbox } from '../worktree/worktreeEvents.ts';
import {
  executeRunWorktreeTool,
  RUN_WORKTREE_DESCRIPTION,
  RUN_WORKTREE_TOOL_NAME,
  validateParams,
} from '../runWorktreeTool.ts';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

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

export const gitHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE, DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const serverHost = requireDoomServerHost(context);
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
      { name: 'doompi-use-git', kind: 'skill', read: () => readPackageResource('src/prompts/doompi-use-git/SKILL.md') },
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
    const registrations = [...resources.map((resource) => host.registerResource(resource)), host.registerTool(tool)];
    return () => {
      messageInbox.close();
      for (const registration of registrations.reverse()) registration.dispose();
    };
  },
};

export default gitHeadlessFacet;
