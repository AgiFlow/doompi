import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { buildAgentCatalogEntries } from '../../(frontend)/overlay/_lib/agentResourceProjection';
import { SUBAGENT_LIST_COMMAND } from '../../(frontend)/overlay/_lib/contributions';
import { type AgentLaunchRequest, openAgentCatalog } from '../../(frontend)/overlay/agent-catalog.cli';
import type { SubagentCapabilityPolicyStore } from '../../../../../schemas/team/capabilityCeiling';
import { resolveActiveTeamPackageConfig } from '../../../../../services/agentDiscovery';
import type { SkillDiscoveryContract } from '../../../../../services/agentSkills';
import type { AgentDiscoveryContract } from '../../../../../types/agent';
import type { TeamPiScope } from '../root.cli';
import { startSingleAgentRun } from './_lib/launch';
import { readyCommand } from './_lib/ready';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) => {
  const { discovery, skills, capabilityPolicies } = context.root.runtime;
  const [command] = createAgentListCommand({
    discovery,
    skills,
    policies: capabilityPolicies,
    launchAgent: (execution, request) =>
      startSingleAgentRun(context.pi, execution, context.root.state, context.root.slashCommandDeps, {
        agent: request.agent,
        task: request.task,
        fork: request.context === 'fork',
      }),
  });
  return readyCommand(context.root, command);
};

export interface RegisterAgentListCommandDeps {
  discovery: AgentDiscoveryContract;
  skills: SkillDiscoveryContract;
  policies: SubagentCapabilityPolicyStore;
  /** Optional: absent until a composition root wires the catalog's launch keys to a real spawn path. */
  launchAgent?: (ctx: ExtensionContext, request: AgentLaunchRequest) => void;
}

export function createAgentListCommand(
  deps: RegisterAgentListCommandDeps,
): Array<readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]]> {
  return [
    [
      SUBAGENT_LIST_COMMAND,
      {
        description: 'Browse agents available from this session cwd and inspect their projected launch resources',
        handler: async (_args: string, ctx: ExtensionContext) => {
          const agents = deps.discovery.discover(ctx.cwd, 'both').agents;
          const teamPackage = resolveActiveTeamPackageConfig();
          const availableSkills = deps.skills.discoverAvailableSkills(ctx.cwd);
          const skillSnapshot = {
            resolveSkillsWithFallback: (
              ...args: Parameters<SkillDiscoveryContract['resolveSkillsWithFallback']>
            ): ReturnType<SkillDiscoveryContract['resolveSkillsWithFallback']> =>
              deps.skills.resolveSkillsWithFallback(...args),
            discoverAvailableSkills: (): ReturnType<SkillDiscoveryContract['discoverAvailableSkills']> =>
              availableSkills,
          };
          const entries = buildAgentCatalogEntries(agents, {
            cwd: ctx.cwd,
            skills: skillSnapshot,
            capabilityCeiling: deps.policies.resolve(),
            ...(teamPackage?.config.excludeTools
              ? { excludeTools: teamPackage.config.excludeTools, exclusionSource: teamPackage.path }
              : {}),
            environment: { ...process.env },
          });
          const launchAgent = deps.launchAgent;
          await openAgentCatalog(
            ctx,
            entries,
            launchAgent ? { launchAgent: (request: AgentLaunchRequest) => launchAgent(ctx, request) } : {},
          );
        },
      },
    ],
  ];
}
