import fs from 'node:fs';
import path from 'node:path';
import { buildPersonaPrompt, globalDoomConfigDirectory } from '@agimon-ai/doompi-config';
import type { HarnessContext } from '../adapters/harnessContext';
import { type McpServerCost, priceMcpToolSchemas } from '../adapters/mcpSchemaCost.ts';
import { buildSkillCatalog, counter } from '@agimon-ai/doompi-skill/catalog';
import type { HarnessOptions } from '../types/interfaces/harness';
import { BaseCommand } from './baseCommand.ts';

/**
 * What the selection costs before the first prompt, in tokens.
 *
 * Every figure is an estimate of what the provider will be sent, not a billed
 * total: skills are counted from files on disk and MCP tools from the schemas
 * their servers advertise, both with the same tokenizer.
 */
export interface MatrixCost {
  /** The always-on skill block Pi puts in the system prompt. */
  skillPromptTokens: number;
  /** Skill bodies on disk, read only when a skill is invoked. */
  skillBodyTokens: number;
  /** The persona prompt, when a profile selected one. */
  personaTokens: number;
  /** Always-on tool schemas, per configured MCP server. */
  mcpServers: McpServerCost[];
  mcpToolTokens: number;
}

export interface MatrixExplanation {
  majorMode: string;
  profile?: string;
  persona?: string;
  domains: string[];
  plugins: string[];
  layers: string[];
  hookGroups: string[];
  hooksEnabled: boolean;
  skillDirectories: string[];
  skillCount: number;
  agentCount: number;
  agentDirectories: string[];
  mcpConfigPath?: string;
  mcpServers: string[];
  mcpProxyUpstreams?: string[];
  mcpFiltered: boolean;
  cost?: MatrixCost;
}

function readMcpServers(configPath: string): Record<string, unknown> {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
  return config.mcpServers ?? {};
}

/**
 * Renders the resolved matrix for --explain. Composition spans three config
 * files, so this answers "why is that loaded" in one command instead of a
 * manual trace through domains, major modes, and plugin subsets.
 */
export function explainMatrix(explanation: MatrixExplanation): string {
  const section = (label: string, values: string[], empty = '(none)'): string =>
    `${label}:\n${values.length === 0 ? `  ${empty}` : values.map((value) => `  ${value}`).join('\n')}\n`;

  return [
    `doompi resolved matrix\n\n`,
    `major mode: ${explanation.majorMode}\n\n`,
    section('profile', explanation.profile ? [explanation.profile] : [], '(none)'),
    '\n',
    section('persona', explanation.persona ? [explanation.persona] : [], '(none)'),
    '\n',
    section('domains (content)', explanation.domains),
    '\n',
    section('layers (behavior, from the major mode)', explanation.layers, 'core only'),
    '\n',
    section(
      'hook groups from layers',
      explanation.hookGroups,
      explanation.hooksEnabled ? '(core groups only)' : '(hooks disabled)',
    ),
    '\n',
    section(
      'plugins',
      explanation.plugins.map((directory) => path.basename(directory)),
    ),
    '\n',
    section(
      'skill paths',
      explanation.skillDirectories.map((directory) => path.relative(process.cwd(), directory)),
    ),
    '\n',
    section(
      explanation.mcpFiltered ? 'mcp servers (filtered by domain allowlist)' : 'mcp servers (unfiltered)',
      explanation.mcpServers,
      '(mcp disabled)',
    ),
    '\n',
    explanation.mcpProxyUpstreams
      ? section('mcp proxy upstreams (filtered)', explanation.mcpProxyUpstreams)
      : 'mcp proxy upstreams:\n  (unfiltered, every upstream in mcp-config.yaml)\n',
    '\n',
    `skills: ${explanation.skillCount} (from ${explanation.skillDirectories.length} paths)\n`,
    `agents: ${explanation.agentCount}\n`,
    `mcp config: ${explanation.mcpConfigPath ?? '(disabled)'}\n`,
    explanation.cost ? renderCost(explanation.cost) : '',
  ].join('');
}

const TOKEN_COLUMN = 9;

function tokenLine(label: string, tokens: number, note = ''): string {
  const row = `  ${label.padEnd(16)}${tokens.toLocaleString('en-US').padStart(TOKEN_COLUMN)}`;
  return `${note ? `${row}  ${note}` : row}\n`;
}

/**
 * The bill, rendered last so the sections above keep their order.
 *
 * Skill and persona figures are derived from files on disk and MCP figures
 * from a cached handshake, so two runs of the same selection print the same
 * numbers and a reader can reproduce them without trusting this output.
 */
function renderCost(cost: MatrixCost): string {
  const startup = cost.skillPromptTokens + cost.personaTokens + cost.mcpToolTokens;
  const unpriced = cost.mcpServers.filter((server) => server.unavailable);
  return [
    '\ncontext cost (tokens)\n',
    tokenLine('skills prompt', cost.skillPromptTokens, 'always on'),
    tokenLine('persona', cost.personaTokens, 'always on'),
    tokenLine('mcp tools', cost.mcpToolTokens, mcpNote(cost.mcpServers)),
    tokenLine('startup total', startup),
    tokenLine('skill bodies', cost.skillBodyTokens, 'read on demand'),
    ...cost.mcpServers.filter((server) => !server.unavailable).map(serverLine),
    unpriced.length > 0
      ? `\n  Not priced: ${unpriced.map((server) => `${server.name} (${server.unavailable})`).join(', ')}\n`
      : '',
    '\n  Excludes skills contributed by extensions, which register after startup.\n',
  ].join('');
}

function mcpNote(servers: McpServerCost[]): string {
  const priced = servers.filter((server) => !server.unavailable);
  if (priced.length === 0) return 'always on';
  const tools = priced.reduce((total, server) => total + server.toolCount, 0);
  return `always on, ${tools} tools from ${priced.length} server${priced.length === 1 ? '' : 's'}`;
}

function serverLine(server: McpServerCost): string {
  return tokenLine(`  ${server.name}`, server.tokens, server.cached ? 'cached' : 'measured now');
}

/** Prints the fully resolved matrix instead of launching Pi. */
export class ExplainCommand extends BaseCommand {
  readonly name = 'explain';

  matches(options: HarnessOptions): boolean {
    return options.explain;
  }

  /**
   * Prices the selection from files on disk and configured MCP servers.
   *
   * `extensionSources` is empty because extensions publish their skill
   * directories over the session event bus, which has not started here. The
   * rendering names that gap rather than presenting the figure as a total.
   */
  private async cost(context: HarnessContext): Promise<MatrixCost | undefined> {
    const { options, resources } = context;
    try {
      const [catalog, countTokens] = await Promise.all([
        buildSkillCatalog({
          repoRoot: options.repoRoot,
          activeSkillDirectories: resources.skillDirectories,
          extensionSources: [],
        }),
        counter(),
      ]);
      const persona = context.personaDirectory
        ? buildPersonaPrompt(context.personaRoot ?? options.repoRoot, context.personaDirectory)
        : undefined;
      const mcp = resources.mcpConfigPath
        ? await priceMcpToolSchemas({
            configPath: resources.mcpConfigPath,
            homeDoomDirectory: globalDoomConfigDirectory(),
            cwd: options.repoRoot,
            environment: context.environment,
            countTokens,
          })
        : { servers: [], totalTokens: 0 };
      return {
        skillPromptTokens: catalog.promptTokens,
        skillBodyTokens: catalog.bodyTokens,
        personaTokens: persona ? countTokens(persona) : 0,
        mcpServers: mcp.servers,
        mcpToolTokens: mcp.totalTokens,
      };
    } catch (error) {
      // Pricing reads the skill files, so an unreadable one must not take the
      // whole explanation down: the resolved matrix is the point, the bill is
      // the extra. Reported rather than swallowed.
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[doompi] ${this.name}: could not price the selection: ${detail}\n`);
      return undefined;
    }
  }

  async execute(context: HarnessContext): Promise<number> {
    const { options, resources, plugins, mcpAllowlist } = context;
    const cost = await this.cost(context);

    process.stdout.write(
      explainMatrix({
        cost,
        majorMode: options.majorMode,
        profile: context.profile,
        persona: context.personaDirectory,
        domains: options.domains,
        plugins: plugins.map((entry) => entry.directory),
        layers: context.selectedLayers,
        hookGroups: context.hookGroups,
        hooksEnabled: options.hooks,
        skillDirectories: resources.skillDirectories,
        skillCount: resources.skillCount,
        agentCount: resources.agentCount,
        agentDirectories: resources.agentDirectories,
        mcpConfigPath: resources.mcpConfigPath,
        // Read back from the generated config so this reports what Pi will
        // actually load, not what the allowlist intended.
        mcpServers: resources.mcpConfigPath ? Object.keys(readMcpServers(resources.mcpConfigPath)) : [],
        mcpProxyUpstreams: mcpAllowlist?.proxy,
        mcpFiltered: Boolean(mcpAllowlist),
      }),
    );
    return 0;
  }
}
