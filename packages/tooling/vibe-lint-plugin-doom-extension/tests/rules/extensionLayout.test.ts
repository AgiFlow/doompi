import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { doomExtensionSideBoundary } from '../../src/rules/extensionLayout.js';

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

  it('rejects other backend imports of frontend code', () => {
    expect(
      check(
        'src/extensions/workspaces/sessions/(backend)/service/runtime.cli.ts',
        "import { openSubagentFleet } from '../../(frontend)/overlay/fleet.cli';",
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
