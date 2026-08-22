import type {
  DoomHelpActivation,
  DoomHelpContribution,
  DoomHelpDiagnostic,
  DoomHelpSkill,
} from '@agimon-ai/doompi-extension-contracts/help';

export interface HelpPackageIdentity {
  source: string;
  version: string;
  packageRoot: string;
  modulePath: string;
}

export type HelpIndexLocation = 'local' | 'cache' | 'remote';

export interface ResolvedHelpIndex {
  identity: HelpPackageIdentity;
  location: HelpIndexLocation;
  filePath: string;
  referenceBase: string;
  byteLength: number;
  digest: string;
}

export interface HelpIndexResolver {
  resolve(contribution: DoomHelpContribution, signal: AbortSignal): Promise<ResolvedHelpIndex>;
}

export interface HelpSkillMaterializer {
  materialize(
    contribution: DoomHelpContribution,
    index: ResolvedHelpIndex,
    signal: AbortSignal,
  ): Promise<readonly DoomHelpSkill[]>;
}

export interface HelpRuntimeState {
  activation: DoomHelpActivation;
  skills: readonly DoomHelpSkill[];
  diagnostics: readonly DoomHelpDiagnostic[];
}

export interface HelpSnapshotPublisher {
  publish(snapshot: HelpRuntimeState): unknown;
}

export interface HelpActivationDependencies {
  resolver: HelpIndexResolver;
  materializer: HelpSkillMaterializer;
  publisher: HelpSnapshotPublisher;
  onBackgroundError(error: unknown): void;
}

export interface HelpActivationService {
  getState(): HelpRuntimeState;
  replaceContributions(contributions: readonly DoomHelpContribution[]): void;
  subscribe(listener: (state: HelpRuntimeState) => void): () => void;
  activate(signal?: AbortSignal): Promise<HelpRuntimeState>;
  deactivate(): HelpRuntimeState;
  dispose(): void;
}

export interface HelpFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type HelpFetch = (
  input: string,
  init: { signal: AbortSignal; redirect: 'manual' },
) => Promise<HelpFetchResponse>;
