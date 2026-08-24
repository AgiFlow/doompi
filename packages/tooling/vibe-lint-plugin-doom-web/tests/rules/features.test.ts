import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noCrossFeatureImport } from '../../src/rules/features.js';

describe('No cross feature import rule', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-web-features-'));
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
    return noCrossFeatureImport.check?.(write(relativePath, source), root);
  }

  it('accepts imports inside the same feature and into shared layers', () => {
    const result = check(
      'src/web/features/chat/ChatPanel.tsx',
      [
        "import { useChatSession } from './hooks/useChatSession';",
        "import { chatMachine } from './state';",
        "import { Button } from '../../components/Button';",
        "import { formatTime } from '../../lib/format';",
        "import { create } from 'zustand';",
        'export const ChatPanel = () => null;',
      ].join('\n'),
    );

    expect(result).toBeNull();
  });

  it('rejects reaching into a sibling feature', () => {
    const result = check(
      'src/web/features/chat/ChatPanel.tsx',
      "import { editorStore } from '../editor/state';\nexport const ChatPanel = () => null;\n",
    );

    expect(result).toContain("src/web/features/chat may not import src/web/features/editor ('../editor/state')");
    expect(result).toContain('Lift the shared code into src/web/components, src/web/lib or src/web/stores');
  });

  it('reports every sibling a feature reaches once', () => {
    const result = check(
      'src/web/features/chat/hooks/useChatSession.ts',
      [
        "import { editorStore } from '../../editor/state';",
        "export { toolbar } from '../../editor/state';",
        "export const load = () => import('../../settings/panel');",
      ].join('\n'),
    );

    expect(result).toContain('src/web/features/chat may not import src/web/features/editor');
    expect(result).toContain('src/web/features/chat may not import src/web/features/settings');
    expect(result?.match(/may not import/g)).toHaveLength(2);
  });

  it('ignores files that are not inside a feature', () => {
    expect(check('src/web/components/Button.tsx', "import { chat } from '../features/chat/state';\n")).toBeNull();
    expect(check('src/services/chat.ts', "import { chat } from '../web/features/chat/state';\n")).toBeNull();
  });

  it('ignores unreadable files', () => {
    expect(noCrossFeatureImport.check?.(path.join(root, 'src/web/features/chat/missing.ts'), root)).toBeNull();
  });
});
