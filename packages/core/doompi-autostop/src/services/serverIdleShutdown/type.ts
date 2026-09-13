import type { DoomHeadlessHook } from '@agimon-ai/doompi-core/headless';
export interface ServerIdleShutdown {
  hooks: DoomHeadlessHook[];
  dispose(this: void): void;
}
