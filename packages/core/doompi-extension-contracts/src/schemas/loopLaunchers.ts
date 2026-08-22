import type { Context } from '@deepseek-ai/cordis';

/** Provider-owned Cordis service for session-scoped recurring-loop launchers. */
export const DOOM_LOOP_LAUNCHERS_SERVICE = 'doom/loop-launchers';

export interface LoopLaunchRequest {
  readonly instanceId: string;
  readonly signal: AbortSignal;
}

export interface StoppableLoop {
  readonly instanceId: string;
  readonly label?: string;
  readonly detail?: string;
  stop(reason?: string): void | Promise<void>;
}

export interface LoopLauncherSummary {
  readonly id: string;
  readonly source: string;
  readonly label: string;
  readonly description?: string;
}

export interface LoopInstanceSnapshot {
  readonly instanceId: string;
  readonly launcherId: string;
  readonly launcherLabel: string;
  readonly label?: string;
  readonly detail?: string;
  readonly state: 'starting' | 'running' | 'stopping';
  readonly startedAt?: string;
}

export interface LoopLauncherDefinition extends LoopLauncherSummary {
  launch(request: LoopLaunchRequest): Promise<StoppableLoop | undefined>;
}

export interface LoopLauncherRegistration {
  readonly id: string;
  readonly generation: string;
  dispose(reason?: string): Promise<void>;
}

/** Direct registrar/control seam owned and provided by doompi-loop. */
export interface DoomLoopLaunchersService {
  readonly generation: string;
  register(definition: LoopLauncherDefinition): LoopLauncherRegistration;
  listLaunchers(): readonly LoopLauncherSummary[];
  listInstances(): readonly LoopInstanceSnapshot[];
  subscribe(listener: () => void): () => void;
  launch(launcherId: string, options?: { instanceId?: string }): Promise<LoopInstanceSnapshot | undefined>;
  stop(instanceId: string, reason?: string): Promise<boolean>;
  stopAll(reason?: string): Promise<void>;
  dispose(reason?: string): Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/loop-launchers': DoomLoopLaunchersService;
  }
}

export function readDoomLoopLaunchers(context: Context): DoomLoopLaunchersService | undefined {
  return context.get(DOOM_LOOP_LAUNCHERS_SERVICE) as DoomLoopLaunchersService | undefined;
}

export function requireDoomLoopLaunchers(context: Context): DoomLoopLaunchersService {
  const service = readDoomLoopLaunchers(context);
  if (!service) throw new Error('Doom loop launchers are unavailable. Load @agimon-ai/doompi-loop.');
  return service;
}
