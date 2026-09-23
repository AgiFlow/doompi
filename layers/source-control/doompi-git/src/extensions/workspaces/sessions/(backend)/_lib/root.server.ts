import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import {
  type DoomHeadlessResource,
  type DoomHeadlessTool,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import { readPackageResource, type DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import { readDoomSessionDelivery } from '@agimon-ai/doompi-session';

import { RunWorktreeToolSchema, type RunWorktreeToolParams } from '../../../../../schemas/runWorktreeTool';
import { createWorktreeGit } from '../../../../../services/gitCli';
import {
  executeRunWorktreeTool,
  RUN_WORKTREE_DESCRIPTION,
  RUN_WORKTREE_TOOL_NAME,
  validateParams,
} from '../../../../../services/runWorktree';
import { createWorktreeMessageInbox } from '../../../../../services/worktreeEvents';
import { createWorktreeOperations } from '../../../../../services/worktreeOperations';

function progressResult(action: RunWorktreeToolParams['action'], label: string): DoomHeadlessToolResult {
  return { content: [{ type: 'text', text: label }], details: { action } };
}

export function createGitSession({ context, host: serverHost }: DoomServerPluginContext) {
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
    sessionDelivery: () => readDoomSessionDelivery(context),
  });
  const resources: DoomHeadlessResource[] = [
    {
      // The package index is Help-catalog material, not standing instruction, so it
      // only enters the prompt while Help mode is active. Matches the Pi facet,
      // which has always routed this through the Help service.
      when: { state: { 'minor-mode': 'help' }, attribution: { kind: 'minor', mode: 'help' } },
      name: 'doompi-git',
      kind: 'context',
      read: () => readPackageResource(import.meta.url, 'llms.txt'),
    },
    {
      name: 'doompi-use-git',
      kind: 'skill',
      read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-git/SKILL.md'),
    },
  ];

  const tool: DoomHeadlessTool<typeof RunWorktreeToolSchema> = {
    name: RUN_WORKTREE_TOOL_NAME,
    label: 'Worktree',
    description: RUN_WORKTREE_DESCRIPTION,
    parameters: RunWorktreeToolSchema,
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
  return { value: { resources, tool }, onDispose: () => messageInbox.close() };
}

const root = defineRoot(createGitSession);
export type GitServerScope = Awaited<ReturnType<typeof root>>['value'];
export default root;
