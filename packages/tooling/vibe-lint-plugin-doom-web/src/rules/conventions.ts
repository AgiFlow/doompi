import * as path from 'node:path';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { projectPath } from './moduleGraph.js';

const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]*$/;
const HOOK_NAME = /^use[A-Z0-9][A-Za-z0-9]*$/;
/** `useChat` and `use-chat` read as hooks; `userProfile` does not. */
const HOOK_LIKE = /^use[-_A-Z0-9]/;

export const webFileNaming: RuleDefinition = {
  preflight: true,
  rule: 'Browser files are named after what they export: PascalCase components, use* hooks, <topic>Store stores',
  rationale:
    'A client tree is read by filename far more often than by content, in a file list, a stack trace, and an import statement. When the name states the kind, a reader knows whether a module renders, holds state, or wraps behavior before opening it, and a search for a component finds one spelling instead of three. Router files are exempt because their names are the URL, not the export.',
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    if (!relativePath?.startsWith('src/web/')) return null;

    const parts = relativePath.split('/');
    const fileName = parts[parts.length - 1];
    const extension = path.extname(fileName);
    if (extension !== '.ts' && extension !== '.tsx') return null;
    if (fileName === 'index.ts' || fileName === 'index.tsx') return null;
    // src/web/routes names the URL tree, so TanStack owns the spelling there.
    if (parts[2] === 'routes') return null;

    const stem = fileName.slice(0, -extension.length);
    // A dotted stem is a variant of another file (Panel.test.tsx, Panel.stories.tsx).
    if (stem.includes('.')) return null;
    const directory = parts[parts.length - 2];

    if (directory === 'hooks' || HOOK_LIKE.test(stem)) {
      return HOOK_NAME.test(stem)
        ? null
        : `${relativePath} is not a camelCase use* name. A hook file is named after the hook it exports, for example useChatSession.ts.`;
    }
    if (directory === 'stores') {
      return stem.endsWith('Store') && extension === '.ts'
        ? null
        : `${relativePath} does not end in Store.ts. A file under stores/ is named after the store it exports, for example chatStore.ts.`;
    }
    if (directory === 'components' && extension === '.tsx') {
      return COMPONENT_NAME.test(stem)
        ? null
        : `${relativePath} is not PascalCase. A .tsx file under components/ is named after the component it exports, for example ChatPanel.tsx.`;
    }
    return null;
  },
};
