import type { RuleDefinition } from '@agimon-ai/vibe-lint';

import { doomComponentsLayerBoundary } from './componentLibrary.js';
import { webFileNaming } from './conventions.js';
import { noCrossFeatureImport } from './features.js';
import { doomWebLayerBoundary } from './layers.js';
import { preferSharedPrimitive } from './primitives.js';
import { noArbitraryStyleValue, noRawThemeColor } from './theming.js';

export const rules: Record<string, RuleDefinition> = {
  'doom-components-layer-boundary': doomComponentsLayerBoundary,
  'doom-web-layer-boundary': doomWebLayerBoundary,
  'no-arbitrary-style-value': noArbitraryStyleValue,
  'no-cross-feature-import': noCrossFeatureImport,
  'no-raw-theme-color': noRawThemeColor,
  'prefer-shared-primitive': preferSharedPrimitive,
  'web-file-naming': webFileNaming,
};
