import type { DoomHeadlessHook } from '@agimon-ai/doompi-extension-contracts/headless';
export interface ServerIdleShutdown {
  hooks: DoomHeadlessHook[];
  dispose(this: void): void;
}
