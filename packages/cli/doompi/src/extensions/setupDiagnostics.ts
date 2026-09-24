import { projectHarnessEnvironment } from '@agimon-ai/doompi-config/harnessState';
import type { DoomHeadlessSelection } from '@agimon-ai/doompi-core/headless';
import { DOOM_HELP_WHEN as HELP_WHEN } from '@agimon-ai/doompi-core/help';
import { defineTool } from '@agimon-ai/doompi-core/piExtension';
import { Type } from 'typebox';

import { collectDoctorReport } from '../cli/commands/doctor';

export const DIAGNOSE_SETUP_NAME = 'diagnose_setup';
export interface SetupDiagnosticScope {
  repoRoot: string;
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  selection: Pick<DoomHeadlessSelection, 'majorMode' | 'domains' | 'profile'>;
}

const guidance: Readonly<Record<string, string>> = {
  'config.yaml': 'doompi-author-config',
  'modes.yaml': 'doompi-author-major-mode',
  'domains.yaml': 'doompi-author-domain',
  'profiles.yaml': 'doompi-author-profile',
};

export function createSetupDiagnosticsTool(
  readScope: () => SetupDiagnosticScope,
  authorize: (signal?: AbortSignal) => AbortSignal,
) {
  return defineTool({
    name: DIAGNOSE_SETUP_NAME,
    description:
      "Check this session's saved configuration, installed packages, and sync drift without changing anything. Returns scoped check results and the relevant setup guidance, never configuration values or credentials.",
    parameters: Type.Object({}, { additionalProperties: false }),
    when: HELP_WHEN,
    executionMode: 'serial',
    async execute(_input, execution) {
      const signal = authorize(execution.signal);
      const scope = readScope();
      const environment = projectHarnessEnvironment(
        {
          root: scope.repoRoot,
          majorMode: scope.selection.majorMode,
          domains: [...scope.selection.domains],
          profile: scope.selection.profile,
        },
        { ...scope.environment },
      );
      const report = collectDoctorReport(environment, scope.cwd);
      signal.throwIfAborted();
      authorize(execution.signal);
      const result = {
        scope: 'current-session',
        configurationRoot: report.repoRoot,
        appliedSelection: {
          majorMode: scope.selection.majorMode,
          domains: [...scope.selection.domains],
          profile: scope.selection.profile,
        },
        status: report.problems === 0 && report.skipped.length === 0 ? 'checks-passed' : 'issues-found',
        checks: report.sections.map((section) => ({
          area: section.label,
          status: section.problems.length ? 'failed' : 'passed',
          problemCount: section.problems.length,
          guidance: guidance[section.label] ?? 'doompi-use-help',
        })),
        skipped: report.skipped,
        limitations:
          'These are saved configuration and installation checks, not a network authentication or agent health test. Error text and configuration values are omitted to protect credentials. Inspect a failed area with its package guidance before proposing a repair.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
