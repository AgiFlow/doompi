import type { DoomHeadlessResource } from '@agimon-ai/doompi-core/headless';

export interface DomainServerScope {
  readonly resources: readonly DoomHeadlessResource[];
}
