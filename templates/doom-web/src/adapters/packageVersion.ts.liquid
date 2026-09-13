import { createRequire } from 'node:module';
import path from 'node:path';

// createRequire rather than a JSON import: this module runs from src under
// Node's strip-only TypeScript mode and from the unbundled dist tree, and the
// package self-reference resolves the same manifest from either one.
const require = createRequire(import.meta.url);
const PACKAGE_MANIFEST = '@agimon-ai/doompi-web/package.json';
const WEB_PACKAGE_ROOT_ENV = 'DOOMPI_WEB_PACKAGE_ROOT';

/**
 * The version of the package this process is running from.
 *
 * Published on `/api/health` so a second `doompi-web` start can tell an
 * upgrade apart from a duplicate launch. An upgraded CLI that silently hands
 * back to an older running hub serves the older cockpit forever, because a
 * long-lived process signs its asset directory once and never revisits it.
 *
 * Nothing else may be imported here: `--version` answers from this module
 * before the CLI loads anything that costs a process warning or a socket.
 */
export function packagedVersion(): string {
  const configuredRoot = process.env[WEB_PACKAGE_ROOT_ENV];
  const manifest =
    configuredRoot !== undefined && configuredRoot !== ''
      ? path.join(configuredRoot, 'package.json')
      : PACKAGE_MANIFEST;
  try {
    const { version } = require(manifest) as { version?: unknown };
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
