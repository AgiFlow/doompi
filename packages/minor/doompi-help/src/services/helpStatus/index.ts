import type { DoomHeadlessCapabilitySnapshot } from '@agimon-ai/doompi-core/headless';
import { DOOM_HELP_WHEN as HELP_WHEN, type DoomHelpSnapshot, type DoomHelpSkill } from '@agimon-ai/doompi-core/help';
import { defineTool } from '@agimon-ai/doompi-core/piExtension';
import type { DoomToolSurfaceEntry } from '@agimon-ai/doompi-core/toolSurface';

import {
  HELP_GUIDANCE,
  HELP_MODE_ID,
  HELP_STATUS_LIMIT,
  HELP_STATUS_TOOL_DESCRIPTION,
  HELP_STATUS_TOOL_NAME,
} from '../../constants/help';
import { helpStatusParameters } from '../../schemas/diagnostics';
import type { HelpStatusReport } from './type';

export function serverHelpStatus(snapshot: DoomHeadlessCapabilitySnapshot, enabled: boolean): HelpStatusReport {
  const entries = snapshot.capabilities.filter((entry) => entry.when?.state?.['minor-mode'] === HELP_MODE_ID);
  const skills = entries.filter((entry) => entry.kind === 'skill');
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const diagnostics = entries
    .filter((entry) => enabled && entry.reason && entry.reason !== 'inactive')
    .map((entry) => ({ source: entry.source, code: `HELP_${entry.reason!.replaceAll('-', '_').toUpperCase()}` }));
  const ready = snapshot.ready;
  return {
    activation: !enabled ? 'inactive' : !ready ? 'activating' : diagnostics.length ? 'degraded' : 'active',
    ready,
    revision: snapshot.revision,
    counts: {
      skills: ready ? skills.filter((entry) => entry.active && entry.discoverable).length : null,
      tools: tools.filter((entry) => entry.active).length,
    },
    skills: skills.slice(0, HELP_STATUS_LIMIT).map(({ name, source, active, discoverable, reason }) => ({
      name,
      source,
      active: active && discoverable,
      ...(reason ? { reason } : {}),
    })),
    tools: tools
      .slice(0, HELP_STATUS_LIMIT)
      .map(({ name, source, active, reason }) => ({ name, source, active, ...(reason ? { reason } : {}) })),
    diagnostics: diagnostics.slice(0, HELP_STATUS_LIMIT),
    truncated:
      skills.length > HELP_STATUS_LIMIT || tools.length > HELP_STATUS_LIMIT || diagnostics.length > HELP_STATUS_LIMIT,
  };
}

export function piHelpStatus(
  snapshot: DoomHelpSnapshot,
  accepted: readonly DoomHelpSkill[] | undefined,
  surface: readonly DoomToolSurfaceEntry[],
): HelpStatusReport {
  const paths = new Set(accepted?.map((skill) => skill.filePath));
  const tools = surface.filter(
    (entry) => entry.attribution?.kind === 'minor' && entry.attribution.mode === HELP_MODE_ID,
  );
  const skills = snapshot.skills.map(({ source, name, filePath }) => ({
    source,
    name,
    active: paths.has(filePath),
    ...(!paths.has(filePath) ? { reason: accepted === undefined ? 'not-ready' : 'shadowed' } : {}),
  }));
  // Codes and owners identify the failed checks without echoing arbitrary error text or filesystem paths.
  const diagnostics = [
    ...snapshot.diagnostics.map(({ source, code }) => ({ source, code })),
    ...(accepted === undefined ? [{ code: 'HELP_SKILL_INVENTORY_UNAVAILABLE' }] : []),
    ...skills
      .filter((skill) => skill.reason === 'shadowed')
      .map((skill) => ({ source: skill.source, code: 'HELP_SKILL_COLLISION' })),
  ];
  return {
    activation: snapshot.activation === 'active' && diagnostics.length ? 'degraded' : snapshot.activation,
    ready: accepted !== undefined,
    revision: snapshot.revision,
    counts: { skills: accepted?.length ?? null, tools: tools.filter((tool) => tool.active).length },
    skills: skills.slice(0, HELP_STATUS_LIMIT),
    tools: tools.slice(0, HELP_STATUS_LIMIT).map(({ source, name, active }) => ({
      source,
      name,
      active,
      ...(!active ? { reason: 'inactive-or-restricted' } : {}),
    })),
    diagnostics: diagnostics.slice(0, HELP_STATUS_LIMIT),
    truncated:
      skills.length > HELP_STATUS_LIMIT || tools.length > HELP_STATUS_LIMIT || diagnostics.length > HELP_STATUS_LIMIT,
  };
}

export function helpStatusDetail(report: HelpStatusReport): string {
  return `${report.counts.skills ?? 'pending'} Help skills, ${report.counts.tools} diagnostic tools${report.diagnostics.length ? ' (diagnostics available)' : ''}`;
}

export function createHelpStatusTool(
  inspect: () => HelpStatusReport | Promise<HelpStatusReport>,
  authorize: (signal?: AbortSignal) => AbortSignal,
) {
  return defineTool({
    name: HELP_STATUS_TOOL_NAME,
    description: HELP_STATUS_TOOL_DESCRIPTION,
    parameters: helpStatusParameters,
    when: HELP_WHEN,
    promptGuidelines: [HELP_GUIDANCE],
    async execute(_input, execution) {
      const signal = authorize(execution.signal);
      const report = await inspect();
      signal.throwIfAborted();
      authorize(execution.signal);
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }], details: report };
    },
  });
}
