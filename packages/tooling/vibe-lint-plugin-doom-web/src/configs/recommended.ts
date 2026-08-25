import type { PluginConfigPreset, Severity } from '@agimon-ai/vibe-lint';

const rules: Record<string, Severity> = {
  'doom-components-layer-boundary': 'error',
  'doom-web-layer-boundary': 'error',
  'no-cross-feature-import': 'error',
  'no-raw-theme-color': 'error',
  // Warn until every surface has been migrated; the sweep would otherwise
  // block the very change that clears it.
  'prefer-shared-primitive': 'warn',
  'web-file-naming': 'error',
};

export const recommended: PluginConfigPreset = { rules };
