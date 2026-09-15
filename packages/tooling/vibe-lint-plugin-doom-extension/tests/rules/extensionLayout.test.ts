import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  doomExtensionSideBoundary,
  doomLegacySourceRoot,
  doomRoutedFileContract,
  doomRoutedFilePosition,
} from '../../src/rules/extensionLayout.js';

describe('extension side boundary', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-extension-layout-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function check(relativePath: string, source: string): string | null {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
    return doomExtensionSideBoundary.check?.(filePath, root) ?? null;
  }

  it('lets a session Pi command open a colocated CLI overlay', () => {
    expect(
      check(
        'src/extensions/workspaces/sessions/(backend)/command/subagents-fleet.cli.ts',
        "import { openSubagentFleet } from '../../(frontend)/overlay/fleet.cli';",
      ),
    ).toBeNull();
  });

  it('lets the session Pi root and commands use private overlay presentation', () => {
    expect(
      check(
        'src/extensions/workspaces/sessions/(backend)/root.cli.ts',
        "import { createAgentStatus } from '../(frontend)/overlay/_lib/contributions';",
      ),
    ).toBeNull();
    expect(
      check(
        'src/extensions/workspaces/sessions/(backend)/command/subagents-list.cli.ts',
        "import { buildAgentCatalogEntries } from '../../(frontend)/overlay/_lib/agentResourceProjection';",
      ),
    ).toBeNull();
  });

  it('rejects other backend imports of frontend code', () => {
    expect(
      check(
        'src/extensions/workspaces/sessions/(backend)/tool/subagent.cli.ts',
        "import { createAgentStatus } from '../../(frontend)/overlay/_lib/contributions';",
      ),
    ).toMatch(/frontend code/u);
  });

  it('rejects frontend imports of backend code', () => {
    expect(
      check(
        'src/extensions/workspaces/sessions/(frontend)/overlay/fleet.cli.ts',
        "import { createFleetCommand } from '../../(backend)/command/subagents-fleet.cli';",
      ),
    ).toMatch(/backend code/u);
  });
});

describe('canonical routed layout', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-extension-layout-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, source = 'export default {};\n'): string {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
    return filePath;
  }

  it.each(['src/controllers/feature.ts', 'src/tools/feature.ts'])('rejects legacy source root %s', (relativePath) => {
    expect(doomLegacySourceRoot.check?.(write(relativePath), root)).toMatch(/named routed file/u);
  });

  it.each([
    'src/extensions/(backend)/extra.cli.ts',
    'src/extensions/(backend)/extra.server.ts',
    'src/extensions/(frontend)/extra.web.ts',
  ])('rejects catch-all route %s', (relativePath) => {
    expect(doomRoutedFilePosition.check?.(write(relativePath), root)).toMatch(/named surface folder/u);
  });

  it('reserves defineRoutedContribution for explicit non-one cardinality', () => {
    const singular = write(
      'src/extensions/(backend)/resource/help.ts',
      'export default defineRoutedContribution(resource, {});\n',
    );
    expect(doomRoutedFileContract.check?.(singular, root)).toMatch(/typed surface define helper/u);

    const many = write(
      'src/extensions/(backend)/provider/broker.cli.ts',
      "export default defineRoutedContribution(providers, { cardinality: 'many' });\n",
    );
    expect(doomRoutedFileContract.check?.(many, root)).toBeNull();
  });
});
