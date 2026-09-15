import * as fs from 'node:fs';

import { scanExtensions } from '@agimon-ai/doompi-build';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';

import { projectPath } from './manifestEntries.js';

/**
 * The folder convention, enforced from the same scanner that builds it.
 *
 * These rules deliberately import `@agimon-ai/doompi-build` rather than
 * restating its vocabulary. A second copy of "which folders are surfaces" is
 * exactly the drift the folder convention exists to remove, and a lint that
 * disagrees with the build is worse than no lint: it either blocks a legal
 * layout or blesses one the generator will ignore.
 */

const BACKEND_GROUP = '/(backend)/';
const FRONTEND_GROUP = '/(frontend)/';

function sideOf(posixPath: string): 'backend' | 'frontend' | undefined {
  const padded = `/${posixPath}`;
  if (padded.includes(BACKEND_GROUP)) return 'backend';
  if (padded.includes(FRONTEND_GROUP)) return 'frontend';
  return undefined;
}

/**
 * A routed file sits somewhere the scanner understands.
 *
 * The scanner already answers this, and answers it the way the build will, so
 * the rule reports its notices rather than reimplementing them. A misspelled
 * surface, a dynamic segment outside `api/`, a contribution above its side
 * group and a stray file at a side root all surface here, at the file that
 * caused them, instead of as a silently missing contribution at runtime.
 */
export const doomRoutedFilePosition: RuleDefinition = {
  preflight: true,
  rule: 'A file under the extensions routing root sits at a position the folder convention defines',
  rationale:
    'The generator reads the path and nothing else. A file it cannot place contributes nothing, and does so without failing, which is the most expensive way for a layout mistake to behave.',
  check(filePath, configRoot) {
    const relative = projectPath(filePath, configRoot);
    if (!relative || !relative.startsWith('src/extension')) return null;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;

    // A notice can name a folder rather than a file, such as a misspelled
    // surface, so every file beneath it reports the same cause.
    const notice = scanExtensions({ packageDir: configRoot }).notices.find(
      (entry) => relative === entry.path || relative.startsWith(`${entry.path}/`),
    );
    return notice === undefined ? null : notice.message;
  },
};

/**
 * Browser code cannot import backend code. Session Pi commands open frontend
 * CLI overlays, and the session Pi root mounts their colocated status helper.
 *
 * They are compiled by different toolchains against different libraries and
 * shipped differently: the backend is built to dist for Node, the browser half
 * ships as source and is bundled by the cockpit. A single import across the
 * line pulls JSX and DOM types into the Node build, or a Node builtin into the
 * browser bundle, and the failure surfaces far from its cause.
 *
 * Shared code goes in `src/types`, `src/constants` or `src/schemas`, and the
 * generated API contract carries anything the browser needs to know about a
 * route.
 */
export const doomExtensionSideBoundary: RuleDefinition = {
  preflight: true,
  rule: 'Browser and backend code stay separate, except session Pi entry points using CLI overlay presentation',
  rationale:
    'The two sides target different runtimes and ship by different routes. Crossing the line compiles today and breaks in the bundle, far from the import that caused it.',
  check(filePath, configRoot) {
    const relative = projectPath(filePath, configRoot);
    if (!relative) return null;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;

    const side = sideOf(relative);
    if (side === undefined) return null;

    const contents = fs.readFileSync(filePath, 'utf8');

    const opposite = side === 'backend' ? 'frontend' : 'backend';
    const marker = `(${opposite})`;
    const crossing = [...contents.matchAll(/from\s+'([^']+)'|import\s*\(\s*'([^']+)'/gu)]
      .map((match) => match[1] ?? match[2] ?? '')
      .find((specifier) => {
        if (!specifier.includes(marker)) return false;
        if (
          side === 'backend' &&
          /^src\/extensions\/workspaces\/sessions\/\(backend\)\/command\/[^/]+\.cli\.tsx?$/u.test(relative) &&
          /^\.\.\/\.\.\/\(frontend\)\/overlay\/[^/]+\.cli$/u.test(specifier)
        )
          return false;
        if (
          side === 'backend' &&
          /^src\/extensions\/workspaces\/sessions\/\(backend\)\/(?:root\.cli\.tsx?|command\/[^/]+\.cli\.tsx?)$/u.test(
            relative,
          ) &&
          /^(?:\.\.\/|\.\.\/\.\.\/)\(frontend\)\/overlay\/_lib\/[^/]+$/u.test(specifier)
        )
          return false;
        return true;
      });

    if (crossing === undefined) return null;
    return `This ${side} file imports '${crossing}', which is ${opposite} code. Move what both sides need into src/types, src/constants or src/schemas, or let the generated API contract carry it.`;
  },
};

/**
 * The roots the folder convention replaces.
 *
 * `src/tools` held whichever tool shape a package wrote first, so the same
 * capability landed under `tools` for one host and `services` for the other,
 * and neither root said which host it targeted. The convention splits it: a
 * routed file under src/extensions is the shape one host expects, and a
 * service is host-neutral.
 *
 * `src/web` is deliberately not reported. Browser code used by one routed
 * file should colocate beside it, but code shared across several surfaces has
 * to live somewhere, and that root is the right somewhere. Colocation is a
 * preference the layout doc states, not a rule worth failing a build over.
 */
export const doomLegacySourceRoot: RuleDefinition = {
  preflight: true,
  rule: 'Platform-specific code lives in a routed file, not under src/tools',
  rationale:
    'A root named after a host tells you nothing about which host, and splits one capability across two roots. The routed file already says which host it targets, and the service beneath it says the logic targets none.',
  check(filePath, configRoot) {
    const relative = projectPath(filePath, configRoot);
    if (!relative) return null;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;

    if (relative.startsWith('src/tools/')) {
      return 'Move the host-neutral half to src/services and the host-specific shape to a routed file under src/extensions, such as (backend)/tool/<name>.cli.ts or .server.ts.';
    }
    return null;
  },
};
