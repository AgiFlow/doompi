import type { DoomHarnessContext, HarnessState } from '@agimon-ai/doompi-config/types';
import type { VoiceReloadHandoffStore } from '@agimon-ai/doompi-core/voiceReloadHandoff';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { DomainCompletion, DomainListing } from './domains';
import type { DomainSwitchHandoffStore } from './handoff';

/** Everything the manifest reader gives the command, resolved lazily behind it. */
export interface DomainCatalogPort {
  list(ctx: ExtensionContext): Promise<DomainListing>;
  validate(ctx: ExtensionContext, values: readonly string[]): Promise<string[]>;
  describe(ctx: ExtensionContext): Promise<Record<string, string | undefined>>;
  completions(root: string, textBeforeCursor: string): Promise<DomainCompletion | undefined>;
}

export interface DomainsCommandDependencies {
  readonly cordisContext: () => Context;
  readonly catalog: DomainCatalogPort;
  readonly handoffs: DomainSwitchHandoffStore;
  readonly reloadHandoffs: VoiceReloadHandoffStore;
  readonly applyDomains: (domains: string[], state: DoomHarnessContext) => Promise<HarnessState>;
  readonly loadConfigJournal: () => Promise<typeof import('@agimon-ai/doompi-config/piContext')>;
  readonly loadPicker: () => Promise<typeof import('@agimon-ai/doompi-ui/matrix-picker')>;
}
