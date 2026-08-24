import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { collectSpecifiers, locate, readSource, relativeTarget } from './moduleGraph.js';

export const noCrossFeatureImport: RuleDefinition = {
  preflight: true,
  rule: 'A feature under src/web/features never imports a sibling feature',
  rationale:
    'A feature is the unit a team owns, ships, and removes. One import into a sibling makes that untrue: the two now share a release, a regression surface, and a reviewer, and the next import is easier to justify than the first. What both features need is not feature code, it is shared code that has not been named yet. Lift it down a layer and each feature keeps a single direction of dependency.',
  check(filePath, configRoot) {
    const source = locate(filePath, configRoot);
    if (source?.feature === undefined) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;

    const messages = new Set<string>();
    for (const specifier of collectSpecifiers(sourceFile)) {
      const target = relativeTarget(filePath, specifier, configRoot);
      if (target?.feature === undefined || target.feature === source.feature) continue;
      messages.add(
        `src/web/features/${source.feature} may not import src/web/features/${target.feature} ('${specifier}'). Features stay independent. Lift the shared code into src/web/components, src/web/lib or src/web/stores and import it from both features.`,
      );
    }

    return messages.size > 0 ? [...messages].join(' ') : null;
  },
};
