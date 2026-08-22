/**
 * `/subagents-doctor`: a diagnostic report of this package's own runtime
 * state - filesystem roots, agent/skill discovery, the intercom bridge, and
 * the child-process signal env vars - for a user debugging "why didn't my
 * subagent do X".
 *
 * WHY THIS PORTS AS A SMALL PORT, NOT A DEFERRAL:
 * Read (not ported) the predecessor's foreground executor's `doctor` action
 * and `extension/doctor.ts`'s `buildDoctorReport` in full before deciding.
 * Every section it builds has a real doom-team equivalent: filesystem roots
 * (`shared/paths.ts`), agent/skill discovery (`AgentDiscoveryService`/
 * `SkillDiscoveryService`), the permission-system env signals
 * (`SUBAGENT_CHILD_ENV`/`SUBAGENT_PARENT_SESSION_ENV` - same wire names),
 * and the intercom bridge diagnostic (`diagnoseIntercomBridge`, already
 * ported). This package is also inherently async-only, so the predecessor's
 * "async support: available/unavailable" runtime check has nothing to
 * branch on here - it always reports available.
 *
 * WHAT IS DELIBERATELY LEFT OUT, AND WHY:
 * - Chain and prompt-workflow counts. The saved-work surface was REMOVED BY
 *   DECISION (see `slashCommands.ts`'s header), so there is nothing to
 *   count rather than something not yet built. Reporting a zero would imply
 *   a feature that is simply absent
 * - The spawn-budget section entirely. `runs/shared/spawn-budget.ts` DOES
 *   exist, but its own header says `maxSubagentSpawnsPerSession` is NOT
 *   enforced by `SpawnPlanner` yet. Reporting a budget number nothing
 *   enforces would be the same class of lie as parsing an inline-config
 *   field and silently ignoring it - see `spawnRequestMapping.ts`
 *
 * AVOID:
 * - Reporting a spawn budget. There is no enforcement to report on yet
 */

import * as fs from 'node:fs';
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from '../../../../types/environment';
import type { DiscoveredSkill, SkillDiscoveryContract, SkillSource } from '../../../agents/skills';
import type { AgentScope, AgentSource, AgentDiscoveryContract } from '../../../agents/types';
import { diagnoseIntercomBridge, type IntercomBridgeConfigInput } from '../../../../services/intercom/intercomBridge';
import { currentResultsDir, currentRunsDir, TEMP_ROOT_DIR } from '../../../filesystem/paths';

export interface DoctorReportInput {
  cwd: string;
  agentScope: AgentScope;
  intercomBridgeConfig?: IntercomBridgeConfigInput;
  context?: 'fresh' | 'fork';
  orchestratorTarget?: string;
  currentSessionFile?: string | null;
  currentSessionId?: string | null;
  sessionError?: string;
}

export interface DoctorReportDeps {
  discovery: AgentDiscoveryContract;
  skills: SkillDiscoveryContract;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function lineFromCheck(label: string, check: () => string): string {
  try {
    return check();
  } catch (error) {
    return `- ${label}: failed - ${errorText(error)}`;
  }
}

function formatExistingDirectory(label: string, dirPath: string): string {
  try {
    if (!fs.existsSync(dirPath)) return `- ${label}: missing (${dirPath})`;
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) throw new Error(`not a directory: ${dirPath}`);
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    return `- ${label}: ok (${dirPath})`;
  } catch (error) {
    return `- ${label}: failed (${dirPath}) - ${errorText(error)}`;
  }
}

const AGENT_SOURCE_ORDER: AgentSource[] = ['plugin', 'user', 'project'];
const SKILL_SOURCE_ORDER: SkillSource[] = [
  'project',
  'project-settings',
  'user',
  'user-settings',
  'extension',
  'builtin',
  'unknown',
];

function formatSourceCounts(agents: Array<{ source: AgentSource }>): string {
  const counts = new Map<AgentSource, number>();
  for (const agent of agents) counts.set(agent.source, (counts.get(agent.source) ?? 0) + 1);
  const parts = AGENT_SOURCE_ORDER.map((source) => `${source} ${counts.get(source) ?? 0}`).filter(
    (part) => !part.endsWith(' 0'),
  );
  return parts.length > 0 ? parts.join(', ') : 'none';
}

function formatSkillSourceCounts(skills: DiscoveredSkill[]): string {
  const counts = new Map<SkillSource, number>();
  for (const skill of skills) counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
  const parts = SKILL_SOURCE_ORDER.map((source) => `${source} ${counts.get(source) ?? 0}`).filter(
    (part) => !part.endsWith(' 0'),
  );
  return parts.length > 0 ? parts.join(', ') : 'none';
}

function formatSessionLines(input: DoctorReportInput): string[] {
  const lines = [
    `- current session file: ${input.currentSessionFile ?? 'not available'}`,
    `- current session id: ${input.currentSessionId ?? 'not available'}`,
  ];
  if (input.sessionError) lines.push(`- session manager: failed - ${input.sessionError}`);
  return lines;
}

function formatDiscovery(input: DoctorReportInput, deps: DoctorReportDeps): string[] {
  return [
    lineFromCheck('agents', () => {
      const agents = deps.discovery.discover(input.cwd, input.agentScope).agents;
      return `- agents: total ${agents.length} (${formatSourceCounts(agents)})`;
    }),
    lineFromCheck('skills', () => {
      const skills = deps.skills.discoverAvailableSkills(input.cwd);
      return `- skills: total ${skills.length} (${formatSkillSourceCounts(skills)})`;
    }),
  ];
}

function formatPermissionSystemSection(): string[] {
  const lines: string[] = [];
  const parentSession = (process.env[SUBAGENT_PARENT_SESSION_ENV] ?? '').trim();
  lines.push(
    parentSession
      ? `- parent session: set (${parentSession})`
      : '- parent session: not set - ask forwarding from a subprocess child will not reach a parent UI',
  );
  const isChild = process.env[SUBAGENT_CHILD_ENV] === '1';
  lines.push(`- subagent process: ${isChild ? `yes (${SUBAGENT_CHILD_ENV}=1)` : 'no'}`);
  return lines;
}

function formatIntercomSection(input: DoctorReportInput): string[] {
  return lineFromCheck('intercom bridge', () => {
    const diagnostic = diagnoseIntercomBridge({
      config: input.intercomBridgeConfig,
      context: input.context,
      orchestratorTarget: input.orchestratorTarget,
    });
    return [
      `- bridge: ${diagnostic.active ? 'active' : 'inactive'}${diagnostic.reason ? ` (${diagnostic.reason})` : ''}`,
      `- mode: ${diagnostic.mode}; context: ${input.context ?? 'unspecified'}`,
      `- orchestrator target: ${diagnostic.orchestratorTarget ?? 'not available'}`,
      `- intercom: ${diagnostic.intercomAvailable ? 'available' : 'unavailable'} (${diagnostic.extensionDir})`,
    ].join('\n');
  }).split('\n');
}

export function buildDoctorReport(input: DoctorReportInput, deps: DoctorReportDeps): string {
  const lines = [
    'Subagents doctor report',
    '',
    'Runtime',
    `- cwd: ${input.cwd}`,
    '- async support: available (this package is async-only)',
    ...formatSessionLines(input),
    '',
    'Filesystem',
    formatExistingDirectory('temp root', TEMP_ROOT_DIR),
    formatExistingDirectory('runs', currentRunsDir()),
    formatExistingDirectory('results', currentResultsDir()),
    '',
    'Discovery',
    ...formatDiscovery(input, deps),
    '',
    'Permission system',
    ...formatPermissionSystemSection(),
    '',
    'Intercom bridge',
    ...formatIntercomSection(input),
  ];
  return lines.join('\n');
}
