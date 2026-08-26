import type { VibeLintPlugin } from '@agimon-ai/vibe-lint';
import { patterns } from './configs/patterns.js';
import { recommended } from './configs/recommended.js';
import { rules } from './rules/registry.js';

export const doomWebPlugin: VibeLintPlugin = {
  name: 'doom-web',
  rules,
  patterns,
  configs: { recommended },
};
