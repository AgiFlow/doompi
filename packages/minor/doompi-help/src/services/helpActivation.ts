import {
  DOOM_HELP_MAX_DIAGNOSTIC_LENGTH,
  DOOM_HELP_MAX_DIAGNOSTICS,
  DOOM_HELP_MAX_SKILLS,
  type DoomHelpContribution,
  type DoomHelpDiagnostic,
  type DoomHelpSkill,
} from '@agimon-ai/doompi-extension-contracts/help';
import type {
  HelpActivationDependencies,
  HelpActivationService,
  HelpRuntimeState,
  ResolvedHelpIndex,
} from '../types/help.ts';
import { MAX_AGGREGATE_LLMS_BYTES } from './llmsContent.ts';

const MAX_RESOLUTION_CONCURRENCY = 4;
const FAILURE_MESSAGE = 'No package Help source could be activated.';
const CANCELLATION_MESSAGE = 'Help activation was cancelled.';

interface LoadedSource {
  contribution: DoomHelpContribution;
  index: ResolvedHelpIndex;
  skills: readonly DoomHelpSkill[];
}

interface SourceOutcome {
  source: string;
  loaded?: LoadedSource;
  error?: unknown;
}

export class HelpActivationError extends Error {
  constructor(message = FAILURE_MESSAGE) {
    super(message);
    this.name = 'HelpActivationError';
  }
}

function cloneContribution(contribution: DoomHelpContribution): DoomHelpContribution {
  return {
    source: contribution.source,
    moduleUrl: contribution.moduleUrl,
    skills: contribution.skills.map((skill) => ({ ...skill })),
  };
}

function cloneState(state: HelpRuntimeState): HelpRuntimeState {
  return {
    activation: state.activation,
    skills: state.skills.map((skill) => ({ ...skill })),
    diagnostics: state.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

function diagnostic(source: string, code: string, error: unknown): DoomHelpDiagnostic {
  const raw = error instanceof Error ? error.message : String(error);
  const message = (raw || 'Unknown Help activation failure.').slice(0, DOOM_HELP_MAX_DIAGNOSTIC_LENGTH);
  return { source, code, message };
}

function contributionFingerprint(contributions: readonly DoomHelpContribution[]): string {
  return JSON.stringify(
    contributions.map((contribution) => ({
      source: contribution.source,
      moduleUrl: contribution.moduleUrl,
      skills: contribution.skills,
    })),
  );
}

export class DefaultHelpActivationService implements HelpActivationService {
  private readonly dependencies: HelpActivationDependencies;
  private readonly listeners = new Set<(state: HelpRuntimeState) => void>();
  private contributions: DoomHelpContribution[] = [];
  private fingerprint = '[]';
  private state: HelpRuntimeState = { activation: 'inactive', skills: [], diagnostics: [] };
  private settledState: HelpRuntimeState = { activation: 'inactive', skills: [], diagnostics: [] };
  private generation = 0;
  private controller: AbortController | undefined;
  private disposed = false;

  constructor(dependencies: HelpActivationDependencies) {
    this.dependencies = dependencies;
  }

  getState(): HelpRuntimeState {
    return cloneState(this.state);
  }

  replaceContributions(contributions: readonly DoomHelpContribution[]): void {
    if (this.disposed) return;
    const next = contributions.map(cloneContribution).sort((left, right) => left.source.localeCompare(right.source));
    const fingerprint = contributionFingerprint(next);
    if (fingerprint === this.fingerprint) return;
    this.contributions = next;
    this.fingerprint = fingerprint;
    if (this.state.activation !== 'inactive') {
      void this.activate().catch((error: unknown) => {
        // Activation failures publish a bounded settled state before rejecting.
        // Only unexpected implementation failures need an out-of-band report.
        if (error instanceof HelpActivationError) return;
        this.dependencies.onBackgroundError(error);
      });
    }
  }

  subscribe(listener: (state: HelpRuntimeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(state: HelpRuntimeState): HelpRuntimeState {
    this.state = cloneState(state);
    if (state.activation !== 'activating') this.settledState = cloneState(state);
    this.dependencies.publisher.publish(this.state);
    for (const listener of this.listeners) listener(cloneState(this.state));
    return this.getState();
  }

  private async loadSources(signal: AbortSignal): Promise<SourceOutcome[]> {
    const outcomes: SourceOutcome[] = Array.from({ length: this.contributions.length });
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < this.contributions.length) {
        const index = cursor;
        cursor += 1;
        const contribution = this.contributions[index];
        if (!contribution) return;
        if (signal.aborted) throw new HelpActivationError(CANCELLATION_MESSAGE);
        try {
          const resolved = await this.dependencies.resolver.resolve(contribution, signal);
          const skills = await this.dependencies.materializer.materialize(contribution, resolved, signal);
          outcomes[index] = { source: contribution.source, loaded: { contribution, index: resolved, skills } };
        } catch (error) {
          if (signal.aborted) throw new HelpActivationError(CANCELLATION_MESSAGE);
          outcomes[index] = { source: contribution.source, error };
        }
      }
    };
    const count = Math.min(MAX_RESOLUTION_CONCURRENCY, this.contributions.length);
    await Promise.all(Array.from({ length: count }, () => worker()));
    return outcomes;
  }

  async activate(externalSignal?: AbortSignal): Promise<HelpRuntimeState> {
    if (this.disposed) throw new HelpActivationError('Help runtime is disposed.');
    this.controller?.abort('Help activation generation replaced.');
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    if (externalSignal?.aborted) abortFromExternal();

    const settledState = cloneState(this.settledState);
    this.publish({ activation: 'activating', skills: settledState.skills, diagnostics: settledState.diagnostics });
    try {
      const outcomes = await this.loadSources(controller.signal);
      if (controller.signal.aborted || generation !== this.generation) {
        throw new HelpActivationError(CANCELLATION_MESSAGE);
      }

      const diagnostics: DoomHelpDiagnostic[] = [];
      const loaded: LoadedSource[] = [];
      let aggregateBytes = 0;
      for (const outcome of outcomes) {
        if (!outcome) continue;
        if (outcome.error || !outcome.loaded) {
          diagnostics.push(diagnostic(outcome.source, 'HELP_SOURCE_FAILED', outcome.error));
          continue;
        }
        if (aggregateBytes + outcome.loaded.index.byteLength > MAX_AGGREGATE_LLMS_BYTES) {
          diagnostics.push(
            diagnostic(outcome.source, 'HELP_AGGREGATE_LIMIT', 'The aggregate llms.txt byte limit was exceeded.'),
          );
          continue;
        }
        aggregateBytes += outcome.loaded.index.byteLength;
        loaded.push(outcome.loaded);
      }

      const skills: DoomHelpSkill[] = [];
      const names = new Set<string>();
      for (const source of loaded) {
        for (const skill of source.skills) {
          if (skills.length >= DOOM_HELP_MAX_SKILLS) {
            diagnostics.push(
              diagnostic(source.contribution.source, 'HELP_SKILL_LIMIT', 'The Help skill limit was reached.'),
            );
            break;
          }
          if (names.has(skill.name)) {
            diagnostics.push(
              diagnostic(
                source.contribution.source,
                'HELP_SKILL_COLLISION',
                `Help skill '${skill.name}' was already provided by an earlier package source.`,
              ),
            );
            continue;
          }
          names.add(skill.name);
          skills.push({ ...skill });
        }
      }

      const boundedDiagnostics = diagnostics.slice(0, DOOM_HELP_MAX_DIAGNOSTICS);
      if (skills.length === 0) {
        this.publish({ activation: 'inactive', skills: [], diagnostics: boundedDiagnostics });
        throw new HelpActivationError();
      }
      return this.publish({
        activation: boundedDiagnostics.length > 0 ? 'degraded' : 'active',
        skills,
        diagnostics: boundedDiagnostics,
      });
    } catch (error) {
      if (generation === this.generation && this.state.activation === 'activating') this.publish(settledState);
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', abortFromExternal);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  deactivate(): HelpRuntimeState {
    this.generation += 1;
    this.controller?.abort('Help deactivated.');
    this.controller = undefined;
    return this.publish({ activation: 'inactive', skills: [], diagnostics: [] });
  }

  dispose(): void {
    if (this.disposed) return;
    this.deactivate();
    this.disposed = true;
    this.listeners.clear();
  }
}
