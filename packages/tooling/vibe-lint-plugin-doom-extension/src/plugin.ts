import type { VibeLintPlugin } from '@agimon-ai/vibe-lint';
import { patterns } from './configs/patterns.js';
import { migration, recommended } from './configs/recommended.js';
import { rules } from './rules/registry.js';

export const doomExtensionPlugin: VibeLintPlugin = {
  name: 'doom-extension',
  rules,
  patterns,
  configs: { migration, recommended },
};
