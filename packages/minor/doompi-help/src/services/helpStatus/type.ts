import type { DoomHelpActivation } from '@agimon-ai/doompi-core/help';

export interface HelpStatusCapability {
  source: string;
  name: string;
  active: boolean;
  reason?: string;
}

export interface HelpStatusReport {
  activation: DoomHelpActivation;
  ready: boolean;
  revision: number;
  counts: { skills: number | null; tools: number };
  skills: readonly HelpStatusCapability[];
  tools: readonly HelpStatusCapability[];
  diagnostics: readonly { source?: string; code: string }[];
  truncated: boolean;
}
