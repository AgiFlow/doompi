import type { Context } from '@deepseek-ai/cordis';

/** Session-scoped broker for bounded context rendered by optional Doom packages. */
export const DOOM_CONTEXT_CONTRIBUTIONS_SERVICE = 'doom/context-contributions';

export interface DoomContextContribution {
  readonly source: string;
  readonly id: string;
  readonly label: string;
  readonly order: number;
  /** Returns provider-rendered, already-redacted text, or omits this contribution. */
  snapshot(): string | undefined;
}

export interface DoomContextContributionEntry {
  readonly source: string;
  readonly id: string;
  readonly label: string;
  readonly order: number;
  readonly text: string;
}

export interface DoomContextContributionError {
  readonly source: string;
  readonly id: string;
  readonly label: string;
  readonly order: number;
  readonly message: string;
}

export interface DoomContextContributionsSnapshot {
  readonly entries: readonly DoomContextContributionEntry[];
  readonly errors: readonly DoomContextContributionError[];
}

export interface DoomContextContributionRegistration {
  /** Removes the contribution. Repeated disposal is a no-op. */
  dispose(): void;
}

export interface DoomContextContributionsService {
  /** Fences registrations and snapshots against a replaced Doom session. */
  readonly generation: string;
  register(contribution: DoomContextContribution): DoomContextContributionRegistration;
  snapshot(): DoomContextContributionsSnapshot;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/context-contributions': DoomContextContributionsService;
  }
}

export function readDoomContextContributions(context: Context): DoomContextContributionsService | undefined {
  return context.get(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE) as DoomContextContributionsService | undefined;
}

export function requireDoomContextContributions(context: Context): DoomContextContributionsService {
  const service = readDoomContextContributions(context);
  if (!service) throw new Error('Doom context contributions are unavailable. Start a Doom session first.');
  return service;
}
