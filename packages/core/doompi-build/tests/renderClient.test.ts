import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateExtension } from '../src/services/generate';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ROUTE_LEAF = 'export default defineRoute(api);\n';
const ROUTE_TABLE = 'export default {};\n';
/** A browser half, which is what makes a client worth emitting at all. */
const FRONTEND = 'export default {};\n';

function packageWith(files: Readonly<Record<string, string>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-client-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@agimon-ai/doompi-file-edit' }));
  for (const relative of Object.keys(files)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, files[relative] as string);
  }
  return dir;
}

const clientOf = (dir: string): string | undefined => {
  const file = path.join(dir, 'generated/client.ts');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
};

describe('the generated client', () => {
  it('injects the base path and the scope the folder tree declares', () => {
    const dir = packageWith({
      'src/types/apiRoutes.ts': ROUTE_TABLE,
      'src/extensions/(frontend)/tab/Panel.web.tsx': FRONTEND,
      'src/extensions/workspaces/sessions/(backend)/api/file-edits/route.server.ts': ROUTE_LEAF,
    });
    generateExtension({ packageDir: dir });
    const client = clientOf(dir) as string;

    expect(client).toContain("export const apiScopes = ['session'] as const;");
    expect(client).toContain("basePath: 'file-edits',");
    expect(client).toContain("import routes from '../src/types/apiRoutes';");
  });

  it('cascades a global mount down, because a facet serves every scope below it', () => {
    const dir = packageWith({
      'src/types/apiRoutes.ts': ROUTE_TABLE,
      'src/extensions/(frontend)/tab/Panel.web.tsx': FRONTEND,
      'src/extensions/(backend)/api/log/route.server.ts': ROUTE_LEAF,
    });
    generateExtension({ packageDir: dir });
    expect(clientOf(dir)).toContain("export const apiScopes = ['global', 'workspace', 'session'] as const;");
  });

  it('gives a package with several mounts one client each, named from the folder', () => {
    const dir = packageWith({
      'src/types/apiRoutes.ts': ROUTE_TABLE,
      'src/extensions/(frontend)/tab/Panel.web.tsx': FRONTEND,
      'src/extensions/(backend)/api/voice-client-settings/route.server.ts': ROUTE_LEAF,
      'src/extensions/workspaces/sessions/(backend)/api/voice-media/route.server.ts': ROUTE_LEAF,
    });
    generateExtension({ packageDir: dir });
    const client = clientOf(dir) as string;

    expect(client).toContain('export const voiceClientSettings = createApiClient(routes, {');
    expect(client).toContain("basePath: 'voice-client-settings',");
    expect(client).toContain('export const voiceMedia = createApiClient(routes, {');
    expect(client).toContain("basePath: 'voice-media',");
  });

  it('emits nothing for a package with no route table', () => {
    const dir = packageWith({
      'src/extensions/workspaces/sessions/(backend)/api/file-edits/route.server.ts': ROUTE_LEAF,
    });
    generateExtension({ packageDir: dir });
    expect(clientOf(dir)).toBeUndefined();
  });

  /**
   * Ten packages still hold the flat `api/route.server.ts`, whose base path
   * lives in a hand-written value the build cannot read. They keep their own
   * URLs until the folder is renamed, and must not get a client naming the
   * wrong mount.
   */
  it('emits nothing for the flat api/ folder that predates the convention', () => {
    const dir = packageWith({
      'src/types/apiRoutes.ts': ROUTE_TABLE,
      'src/extensions/(frontend)/tab/Panel.web.tsx': FRONTEND,
      'src/extensions/workspaces/sessions/(backend)/api/route.server.ts': ROUTE_LEAF,
    });
    generateExtension({ packageDir: dir });
    expect(clientOf(dir)).toBeUndefined();
  });

  it('reports a route table that no api folder mounts', () => {
    const dir = packageWith({
      'src/types/apiRoutes.ts': ROUTE_TABLE,
      'src/extensions/(frontend)/tab/Panel.web.tsx': FRONTEND,
      'src/extensions/(backend)/tool/grep.server.ts': 'export default {};\n',
    });
    const result = generateExtension({ packageDir: dir });
    expect(result.notices.map((notice) => notice.message)).toContain(
      'declares API routes, but no (backend)/api/<base-path>/ folder says where they are mounted',
    );
  });

  it('deletes a stale client when the route table goes away', () => {
    const dir = packageWith({
      'src/types/apiRoutes.ts': ROUTE_TABLE,
      'src/extensions/(frontend)/tab/Panel.web.tsx': FRONTEND,
      'src/extensions/workspaces/sessions/(backend)/api/file-edits/route.server.ts': ROUTE_LEAF,
    });
    generateExtension({ packageDir: dir });
    expect(clientOf(dir)).toBeDefined();

    fs.rmSync(path.join(dir, 'src/types/apiRoutes.ts'));
    generateExtension({ packageDir: dir });
    expect(clientOf(dir)).toBeUndefined();
  });

  it('never writes a doompi-core import as anything but text, so the build stays dependency-free', () => {
    const dir = packageWith({
      'src/types/apiRoutes.ts': ROUTE_TABLE,
      'src/extensions/(frontend)/tab/Panel.web.tsx': FRONTEND,
      'src/extensions/workspaces/sessions/(backend)/api/file-edits/route.server.ts': ROUTE_LEAF,
    });
    generateExtension({ packageDir: dir });
    const client = clientOf(dir) as string;
    expect(client).toContain("from '@agimon-ai/doompi-core/web'");
    expect(client).toContain("from '@agimon-ai/doompi-web-security/browser'");
    expect(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies).toBeUndefined();
  });
});

describe('packages with no browser half', () => {
  const FRONTEND = 'export default {};\n';

  /**
   * The client carries the sealed transport and exists to be called from a
   * page. A node-only package that emitted one would have to depend on a
   * browser runtime it never loads, to satisfy a file nothing imports.
   */
  it('emits no client for a backend-only package, even with a route table', () => {
    const dir = packageWith({
      'src/types/apiRoutes.ts': ROUTE_TABLE,
      'src/extensions/(backend)/api/settings/route.server.ts': ROUTE_LEAF,
    });
    generateExtension({ packageDir: dir });
    expect(clientOf(dir)).toBeUndefined();
  });

  it('emits one as soon as the package grows a browser half', () => {
    const dir = packageWith({
      'src/types/apiRoutes.ts': ROUTE_TABLE,
      'src/extensions/(frontend)/tab/Panel.web.tsx': FRONTEND,
      'src/extensions/(backend)/api/settings/route.server.ts': ROUTE_LEAF,
      'src/extensions/(frontend)/tab/Panel.web.tsx': FRONTEND,
    });
    generateExtension({ packageDir: dir });
    expect(clientOf(dir)).toContain("basePath: 'settings',");
  });
});
