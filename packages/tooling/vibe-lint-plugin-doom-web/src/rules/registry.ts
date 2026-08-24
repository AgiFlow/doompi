import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { webFileNaming } from './conventions.js';
import { noCrossFeatureImport } from './features.js';
import { doomWebLayerBoundary } from './layers.js';

export const rules: Record<string, RuleDefinition> = {
  'doom-web-layer-boundary': doomWebLayerBoundary,
  'no-cross-feature-import': noCrossFeatureImport,
  'web-file-naming': webFileNaming,
};
