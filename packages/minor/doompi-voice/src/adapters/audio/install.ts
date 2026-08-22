/**
 * Turns "I picked this model" into working voice.
 *
 * Voice needs four things at once: macOS, ffmpeg for the recorder, the engine's
 * own binary, and a model the engine can load. Before this existed, a user had
 * to discover all four from error messages that appeared one at a time, after
 * recording, and hand-write a `voice:` block to satisfy them.
 *
 * So the plan is computed up front and shown whole. Steps that are already
 * satisfied are marked as such rather than skipped silently, because "why is it
 * not installing anything?" is the next question otherwise. Config is written
 * last: an aborted or failed install leaves the file exactly as it was, so a
 * half-installed engine is never selected.
 *
 * AVOID:
 * - Writing config before the model is actually present
 * - Running a shell command the user has not seen
 */

import type { VoiceCatalogEntry } from '../../services/catalog.ts';
import { ENGINE_TOOLING, installerRequirements, resolveInstaller } from '../../services/catalog.ts';

export type InstallStepKind = 'preflight' | 'tool' | 'model' | 'config' | 'verify';
export type InstallStepState = 'pending' | 'satisfied' | 'running' | 'done' | 'failed';

export interface InstallStep {
  kind: InstallStepKind;
  label: string;
  /** The exact shell command this step runs, when it runs one. */
  command?: string;
  detail?: string;
  state: InstallStepState;
}

export interface InstallPlan {
  entry: VoiceCatalogEntry;
  steps: InstallStep[];
  /** Every command the plan would run, for the confirmation the panel shows. */
  commands: string[];
}

export interface InstallEnvironment {
  platform: NodeJS.Platform;
  /** Resolves a binary on PATH, or undefined. Must not throw. */
  find: (binary: string) => string | undefined;
  /** True when the model file is already on disk. Irrelevant for id-based engines. */
  modelPresent: boolean;
  modelPath?: string;
}

export const UNSUPPORTED_PLATFORM = 'Voice recording is supported on macOS only';

/**
 * Works out what this machine still needs.
 *
 * Pure, so the panel can render the plan before anything runs and the tests can
 * assert every branch without a filesystem.
 */
export function planInstall(entry: VoiceCatalogEntry, environment: InstallEnvironment): InstallPlan {
  const tooling = ENGINE_TOOLING[entry.engine];
  const steps: InstallStep[] = [];

  const platformOk = environment.platform === 'darwin';
  const ffmpeg = environment.find('ffmpeg');
  steps.push({
    kind: 'preflight',
    label: 'preflight',
    state: platformOk ? 'satisfied' : 'failed',
    detail: platformOk ? `${environment.platform} · ffmpeg ${ffmpeg ? 'found' : 'missing'}` : UNSUPPORTED_PLATFORM,
  });
  if (platformOk && !ffmpeg) {
    steps.push({ kind: 'tool', label: 'install ffmpeg', command: 'brew install ffmpeg', state: 'pending' });
  }

  const toolPath = environment.find(tooling.binary);
  if (toolPath) {
    steps.push({ kind: 'tool', label: `install ${tooling.binary}`, detail: toolPath, state: 'satisfied' });
  } else {
    // Resolved here rather than at run time so the confirmation names the command
    // that will actually run, and so a machine with no way to install it says so
    // up front instead of failing with ENOENT halfway through.
    const installer = resolveInstaller(entry.engine, environment.find);
    steps.push({
      kind: 'tool',
      label: `install ${tooling.binary}`,
      ...(installer ? { command: installer.command } : {}),
      detail: installer
        ? installer.command
        : `no installer found: needs ${installerRequirements(entry.engine)} on PATH`,
      state: installer ? 'pending' : 'failed',
    });
  }

  if (entry.download) {
    steps.push({
      kind: 'model',
      label: `download ${entry.download.fileName}`,
      detail: environment.modelPresent ? (environment.modelPath ?? 'already downloaded') : entry.download.url,
      state: environment.modelPresent ? 'satisfied' : 'pending',
    });
    steps.push({ kind: 'model', label: 'verify sha256', state: environment.modelPresent ? 'satisfied' : 'pending' });
  } else {
    steps.push({
      kind: 'model',
      label: 'model',
      detail: `${entry.id} · fetched by ${tooling.binary} on first use`,
      state: 'satisfied',
    });
  }

  steps.push({ kind: 'config', label: 'write config', detail: configDetail(entry), state: 'pending' });
  steps.push({ kind: 'verify', label: 'verify', detail: 'run the adapter preflight', state: 'pending' });

  return {
    entry,
    steps,
    commands: steps.flatMap((step) => (step.command ? [step.command] : [])),
  };
}

function configDetail(entry: VoiceCatalogEntry): string {
  const suffix = entry.download ? 'model.path' : 'model.id';
  return `voice.engine, voice.adapters.${entry.engine}.${suffix}`;
}

/** Non-fatal: an unusable plan still renders, it just cannot be run. */
export function planBlocker(plan: InstallPlan): string | undefined {
  const failed = plan.steps.find((step) => step.state === 'failed');
  return failed?.detail ?? undefined;
}
