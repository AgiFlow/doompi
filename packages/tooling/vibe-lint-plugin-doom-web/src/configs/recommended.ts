import type { PluginConfigPreset, Severity } from '@agimon-ai/vibe-lint';

const rules: Record<string, Severity> = {
  'doom-web-layer-boundary': 'error',
  'no-cross-feature-import': 'error',
  'web-file-naming': 'error',
};

export const recommended: PluginConfigPreset = { rules };
