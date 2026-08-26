import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doomWebLayerBoundary } from '../../src/rules/layers.js';

describe('Doom web layer boundary rule', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-web-layers-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, source: string): string {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, 'utf8');
    return filePath;
  }

  function check(relativePath: string, source: string): string | null | undefined {
    return doomWebLayerBoundary.check?.(write(relativePath, source), root);
  }

  it('accepts a client layer reaching only lower client layers', () => {
    const result = check(
      'src/web/features/chat/ChatPanel.tsx',
      [
        "import { Button } from '../../components/Button';",
        "import { formatTime } from '../../lib/format';",
        "import { chatStore } from '../../stores/chatStore';",
        "import type { Message } from '../../types/message';",
        "import { useQuery } from '@tanstack/react-query';",
        'export const ChatPanel = () => null;',
      ].join('\n'),
    );

    expect(result).toBeNull();
  });

  it('accepts imports inside the same layer on either side', () => {
    expect(
      check('src/web/components/Button.tsx', "import { Icon } from './Icon';\nexport const Button = () => null;\n"),
    ).toBeNull();
    expect(check('src/services/a.ts', "import { b } from './b';\nexport const a = b;\n")).toBeNull();
    expect(
      check('src/web/features/chat/ChatPanel.tsx', "import { state } from './state';\nexport const p = state;\n"),
    ).toBeNull();
  });

  it('rejects a client layer reaching a higher one', () => {
    const result = check('src/web/components/Button.tsx', "import { state } from '../features/chat/state';\n");

    expect(result).toContain("src/web/components may not import src/web/features ('../features/chat/state')");
    expect(result).toContain('The client layer order is types, lib, stores, components, features, routes, app');
  });

  it('follows re-exports and lazy dynamic imports', () => {
    const reExport = check('src/web/stores/chatStore.ts', "export { panel } from '../routes/chat';\n");
    const dynamic = check(
      'src/web/components/Lazy.tsx',
      "export const load = () => import('../features/chat/ChatPanel');\n",
    );

    expect(reExport).toContain("src/web/stores may not import src/web/routes ('../routes/chat')");
    expect(dynamic).toContain("src/web/components may not import src/web/features ('../features/chat/ChatPanel')");
  });

  it('keeps the browser bundle out of server code', () => {
    const result = check(
      'src/web/lib/api.ts',
      ["import { chatService } from '../../services/chat';", "import { httpAdapter } from '../../adapters/http';"].join(
        '\n',
      ),
    );

    expect(result).toContain("src/web/lib may not import src/services ('../../services/chat')");
    expect(result).toContain("src/web/lib may not import src/adapters ('../../adapters/http')");
    expect(result).toContain('Browser code may not reach server code');
  });

  it('lets the browser bundle read the shared contracts in src/types', () => {
    expect(check('src/web/lib/api.ts', "import type { Message } from '../../types/message';\n")).toBeNull();
  });

  it('keeps server code out of the browser bundle', () => {
    const result = check('src/services/chat.ts', "import { chatStore } from '../web/stores/chatStore';\n");

    expect(result).toContain("src/services may not import src/web/stores ('../web/stores/chatStore')");
    expect(result).toContain('Server code may not reach the browser bundle');
  });

  it('rejects a server layer reaching a higher one', () => {
    const result = check('src/services/chat.ts', "import { httpAdapter } from '../adapters/http';\n");

    expect(result).toContain("src/services may not import src/adapters ('../adapters/http')");
    expect(result).toContain('The server layer order is types, services, adapters, bin, exports');
  });

  it('accepts a server layer reaching lower ones', () => {
    expect(
      check(
        'src/bin/serve.ts',
        ["import { httpAdapter } from '../adapters/http';", "import { chatService } from '../services/chat';"].join(
          '\n',
        ),
      ),
    ).toBeNull();
  });

  it('lets src/exports aggregate every root including the browser bundle', () => {
    expect(
      check(
        'src/exports/index.ts',
        ["export { httpAdapter } from '../adapters/http';", "export { mount } from '../web/app/mount';"].join('\n'),
      ),
    ).toBeNull();
  });

  it('ignores files outside a recognized source root', () => {
    expect(check('tests/smoke.test.ts', "import { chatStore } from '../src/web/stores/chatStore';\n")).toBeNull();
    expect(check('src/index.ts', "import { chatService } from './services/chat';\n")).toBeNull();
    expect(doomWebLayerBoundary.check?.(path.join(root, '..', 'outside.ts'), root)).toBeNull();
  });

  it('ignores unreadable and non-TypeScript files', () => {
    expect(doomWebLayerBoundary.check?.(path.join(root, 'src/web/lib/missing.ts'), root)).toBeNull();
    expect(check('src/web/app/styles.css', '.root { color: red; }\n')).toBeNull();
  });
});
