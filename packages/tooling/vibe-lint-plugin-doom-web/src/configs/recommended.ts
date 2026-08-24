import type { PluginConfigPreset, Severity } from '@agimon-ai/vibe-lint';

const rules: Record<string, Severity> = {
  'doom-components-layer-boundary': 'error',
  'doom-web-layer-boundary': 'error',
  'no-cross-feature-import': 'error',
  'no-raw-theme-color': 'error',
  'web-file-naming': 'error',
};

export const recommended: PluginConfigPreset = { rules };
