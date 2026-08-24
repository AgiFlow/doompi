/**
 * `--import` preamble for detached SDK child runners.
 *
 * A child spawned as plain `node dist/runs/sdkRunnerEntry.mjs` resolves
 * modules from the team package's own install location. In a managed install
 * (`<project>/.pi/npm/node_modules/@agimon-ai/doompi-team`) the Pi SDK is not
 * present there: the parent process only reaches it because its host aliases
 * the specifier in-process, and that aliasing dies at the process boundary.
 * This hook re-creates it for the child: when normal resolution of the Pi SDK
 * fails, the same specifier is resolved again as if the import sat beside the
 * host's own Pi package, whose root the parent hands over in
 * PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT. Registration is a top-level side
 * effect because `--import` offers no call site.
 */
import * as fs from 'node:fs';
import { registerHooks } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from '../../types/environment';

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const PACKAGE_MANIFEST_NAME = 'package.json';

/**
 * The file URL resolution should pretend the Pi import came from, or
 * undefined when the parent provided no usable package root.
 */
export function resolvePiAliasAnchor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]?.trim();
  if (!root) return undefined;
  const manifest = path.join(root, PACKAGE_MANIFEST_NAME);
  if (!fs.existsSync(manifest)) return undefined;
  return pathToFileURL(manifest).href;
}

function installPiModuleAlias(): void {
  const anchor = resolvePiAliasAnchor();
  if (anchor === undefined) return;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== PI_PACKAGE_NAME && !specifier.startsWith(`${PI_PACKAGE_NAME}/`)) {
        return nextResolve(specifier, context);
      }
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        try {
          return nextResolve(specifier, { ...context, parentURL: anchor });
        } catch {
          // The anchored retry is best-effort; the original failure names the
          // import site the reader actually cares about.
          throw error;
        }
      }
    },
  });
}

installPiModuleAlias();
