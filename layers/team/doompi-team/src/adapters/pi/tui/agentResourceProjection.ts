import type { ResolvedSubagentCapabilityCeiling } from '../../../schemas/team/capabilityCeiling';
import { buildSkillInjection, type SkillDiscoveryContract } from '../../agents/skills';
import type { AgentConfig } from '../../agents/types';
import { type PiLaunchToolPlan, type PiSdkResourcePlan, resolvePiSdkResourcePlan } from '../../runs/shared/piArgs';
import { isPiRuntime } from '../../runs/shared/runtimeRegistry';

const CONDITIONAL_TOOLS = 'Request-specific internal tools';
const HOST_DEFAULT_TOOLS = 'Pi host-default tool set';
const AMBIENT_EXTENSIONS = 'Ambient Pi extensions';
const AMBIENT_SKILLS = 'Ambient Pi skills';

export interface ProjectedResource {
  name: string;
  detail?: string;
}

export interface ResourceTabProjection {
  effective: readonly ProjectedResource[];
  removed: readonly ProjectedResource[];
  unresolved: readonly ProjectedResource[];
}

export interface AgentResourceProjection {
  tools: ResourceTabProjection;
  skills: ResourceTabProjection;
  extensions: ResourceTabProjection;
  notice: string;
  configuredOnly: boolean;
  error?: string;
}

export interface AgentCatalogEntry {
  agent: AgentConfig;
  resources: AgentResourceProjection;
}

export interface AgentResourceProjectionContext {
  cwd: string;
  skills: Pick<SkillDiscoveryContract, 'resolveSkillsWithFallback' | 'discoverAvailableSkills'>;
  capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
  excludeTools?: readonly string[];
  exclusionSource?: string;
  environment?: NodeJS.ProcessEnv;
}

function emptyTab(): ResourceTabProjection {
  return { effective: [], removed: [], unresolved: [] };
}

function resource(name: string, detail?: string): ProjectedResource {
  return detail ? { name, detail } : { name };
}

function unique(items: readonly ProjectedResource[]): ProjectedResource[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.name}\0${item.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ceilingReason(toolPlan: PiLaunchToolPlan): string {
  const sources = toolPlan.capabilityCeiling?.sources ?? [];
  return sources.length > 0
    ? `removed by capability ceiling from ${sources.join(', ')}`
    : 'removed by capability ceiling';
}

function toolRemovalReason(name: string, toolPlan: PiLaunchToolPlan, context: AgentResourceProjectionContext): string {
  if (toolPlan.excludedTools.includes(name)) {
    return context.exclusionSource
      ? `excluded by Team package policy at ${context.exclusionSource}`
      : 'excluded by Team package policy';
  }
  return ceilingReason(toolPlan);
}

function pathShapedToolEntries(agent: AgentConfig, toolPlan: PiLaunchToolPlan): string[] {
  const builtinTools = new Set(toolPlan.requestedBuiltinTools);
  return (agent.tools ?? []).filter((tool) => !builtinTools.has(tool));
}

function selectorResolved(selector: string, toolPlan: PiLaunchToolPlan): boolean {
  return toolPlan.resolvedMcpSelections.some(
    (selection) => selection.selector === selector || selection.selector.startsWith(`${selector}/`),
  );
}

function removedBuiltinCandidates(agent: AgentConfig, toolPlan: PiLaunchToolPlan): string[] {
  if (agent.tools !== undefined) return toolPlan.requestedBuiltinTools;
  if (toolPlan.capabilityCeiling?.allowedTools) return toolPlan.capabilityCeiling.allowedTools;
  return toolPlan.excludedTools;
}

function toolProjection(
  agent: AgentConfig,
  plan: PiSdkResourcePlan,
  context: AgentResourceProjectionContext,
): ResourceTabProjection {
  const { toolPlan } = plan;
  const mcpNames = new Set(toolPlan.effectiveMcpTools);
  const effective = toolPlan.explicitToolAllowlist
    ? toolPlan.effectiveToolAllowlist.map((name) =>
        resource(
          name,
          mcpNames.has(name)
            ? 'resolved MCP tool'
            : agent.tools === undefined
              ? 'granted by parent capability ceiling'
              : 'configured builtin tool',
        ),
      )
    : [];
  const removedBuiltins = removedBuiltinCandidates(agent, toolPlan)
    .filter((name) => !toolPlan.declaredBuiltinTools.includes(name))
    .map((name) => resource(name, toolRemovalReason(name, toolPlan, context)));
  const effectiveMcpNames = new Set(toolPlan.effectiveMcpTools);
  const removedMcp = toolPlan.resolvedMcpSelections
    .filter((selection) => !effectiveMcpNames.has(selection.name))
    .map((selection) =>
      resource(selection.name, `${selection.selector} · ${toolRemovalReason(selection.name, toolPlan, context)}`),
    );
  const deniedMcpSelectors = toolPlan.capabilityCeiling?.denyExtensions
    ? (agent.mcpDirectTools ?? []).map((selector) =>
        resource(selector, `${ceilingReason(toolPlan)} · MCP extensions denied`),
      )
    : [];
  const unresolvedSelectors = toolPlan.capabilityCeiling?.denyExtensions
    ? []
    : (agent.mcpDirectTools ?? [])
        .filter((selector) => !selectorResolved(selector, toolPlan))
        .map((selector) => resource(selector, 'MCP selector did not resolve from the current parent catalog'));
  return {
    effective: unique(effective),
    removed: unique([...removedBuiltins, ...removedMcp, ...deniedMcpSelectors]),
    unresolved: unique([
      ...(toolPlan.explicitToolAllowlist
        ? []
        : [resource(HOST_DEFAULT_TOOLS, 'resolved by Pi only after the child host loads resources')]),
      ...unresolvedSelectors,
      resource(CONDITIONAL_TOOLS, 'intercom and structured_output depend on the concrete spawn request'),
    ]),
  };
}

function skillProjection(
  agent: AgentConfig,
  context: AgentResourceProjectionContext,
): { tab: ResourceTabProjection; requireReadTool: boolean } {
  const resolution = context.skills.resolveSkillsWithFallback(
    agent.skills ?? [],
    context.cwd,
    context.cwd,
    agent.skillPath,
    context.cwd,
  );
  const explicitNames = new Set(resolution.resolved.map((skill) => skill.name));
  const ambient = agent.inheritSkills
    ? context.skills
        .discoverAvailableSkills(context.cwd)
        .filter((skill) => !explicitNames.has(skill.name))
        .map((skill) => resource(skill.name, `ambient parent snapshot · ${skill.source}`))
    : [];
  return {
    tab: {
      effective: unique([
        ...resolution.resolved.map((skill) => resource(skill.name, `configured · ${skill.source} · ${skill.path}`)),
        ...ambient,
      ]),
      removed: [],
      unresolved: unique([
        ...resolution.missing.map((name) =>
          resource(name, 'configured skill was not found from the current session cwd'),
        ),
        ...(agent.inheritSkills
          ? [resource(AMBIENT_SKILLS, 'Pi rediscovers ambient skills when the child resource loader starts')]
          : []),
      ]),
    },
    requireReadTool: buildSkillInjection(resolution.resolved).length > 0,
  };
}

function extensionProjection(agent: AgentConfig, plan: PiSdkResourcePlan): ResourceTabProjection {
  const runtimeExtensions = new Set(plan.toolPlan.runtimeExtensions);
  const configuredExtensions = new Set(plan.toolPlan.configuredExtensions);
  const effective = plan.extensions.map((name) =>
    resource(
      name,
      runtimeExtensions.has(name)
        ? 'internal runtime extension'
        : configuredExtensions.has(name)
          ? 'configured agent extension'
          : 'inherited parent harness extension',
    ),
  );
  const removed = plan.toolPlan.capabilityCeiling?.denyExtensions
    ? [
        ...pathShapedToolEntries(agent, plan.toolPlan),
        ...(agent.extensions ?? []),
        ...(agent.subagentOnlyExtensions ?? []),
      ].map((name) => resource(name, ceilingReason(plan.toolPlan)))
    : [];
  return {
    effective: unique(effective),
    removed: unique(removed),
    unresolved: plan.noAmbientExtensions
      ? []
      : [resource(AMBIENT_EXTENSIONS, 'Pi discovers additional ambient extensions only when the child loads')],
  };
}

function configuredOnlyProjection(agent: AgentConfig): AgentResourceProjection {
  const tools = emptyTab();
  tools.unresolved = unique([
    ...(agent.tools ?? []).map((name) => resource(name, 'configured for external runtime')),
    ...(agent.mcpDirectTools ?? []).map((name) => resource(name, 'configured MCP selector')),
    ...(agent.tools === undefined ? [resource('Runtime-default tools', 'determined by the external runtime')] : []),
  ]);
  const skills = emptyTab();
  skills.unresolved = unique([
    ...(agent.skills ?? []).map((name) => resource(name, 'configured skill name')),
    ...(agent.inheritSkills ? [resource(AMBIENT_SKILLS, 'determined by the external runtime')] : []),
  ]);
  const extensions = emptyTab();
  extensions.unresolved = unique([
    ...[...(agent.extensions ?? []), ...(agent.subagentOnlyExtensions ?? [])].map((name) =>
      resource(name, 'configured extension'),
    ),
    ...(agent.extensions === undefined ? [resource(AMBIENT_EXTENSIONS, 'determined by the external runtime')] : []),
  ]);
  return {
    tools,
    skills,
    extensions,
    notice: `Configured values only. Runtime '${agent.runtime}' does not use the Pi launch projection.`,
    configuredOnly: true,
  };
}

function failedProjection(error: unknown): AgentResourceProjection {
  return {
    tools: emptyTab(),
    skills: emptyTab(),
    extensions: emptyTab(),
    notice: 'Launch projection failed for this agent.',
    configuredOnly: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function projectAgentResources(
  agent: AgentConfig,
  context: AgentResourceProjectionContext,
): AgentResourceProjection {
  if (!isPiRuntime(agent.runtime)) return configuredOnlyProjection(agent);
  try {
    const skills = skillProjection(agent, context);
    const plan = resolvePiSdkResourcePlan({
      tools: agent.tools,
      extensions: agent.extensions,
      subagentOnlyExtensions: agent.subagentOnlyExtensions,
      mcpDirectTools: agent.mcpDirectTools,
      cwd: context.cwd,
      requireReadTool: skills.requireReadTool,
      excludeTools: context.excludeTools ? [...context.excludeTools] : undefined,
      capabilityCeiling: context.capabilityCeiling,
      inheritSkills: agent.inheritSkills,
      environment: context.environment,
    });
    return {
      tools: toolProjection(agent, plan, context),
      skills: skills.tab,
      extensions: extensionProjection(agent, plan),
      notice:
        'Launch projection from the current parent-policy and cwd snapshot. Child loading or request overrides may change qualified resources.',
      configuredOnly: false,
    };
  } catch (error) {
    return failedProjection(error);
  }
}

export function buildAgentCatalogEntries(
  agents: readonly AgentConfig[],
  context: AgentResourceProjectionContext,
): AgentCatalogEntry[] {
  return agents.map((agent) => ({ agent, resources: projectAgentResources(agent, context) }));
}
