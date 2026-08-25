import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { doomComponentsLayerBoundary } from './componentLibrary.js';
import { webFileNaming } from './conventions.js';
import { noCrossFeatureImport } from './features.js';
import { preferSharedPrimitive } from './primitives.js';
import { doomWebLayerBoundary } from './layers.js';
import { noRawThemeColor } from './theming.js';

export const rules: Record<string, RuleDefinition> = {
  'doom-components-layer-boundary': doomComponentsLayerBoundary,
  'doom-web-layer-boundary': doomWebLayerBoundary,
  'no-cross-feature-import': noCrossFeatureImport,
  'no-raw-theme-color': noRawThemeColor,
  'prefer-shared-primitive': preferSharedPrimitive,
  'web-file-naming': webFileNaming,
};
