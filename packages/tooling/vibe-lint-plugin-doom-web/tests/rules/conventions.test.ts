import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webFileNaming } from '../../src/rules/conventions.js';

describe('Web file naming rule', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-web-naming-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function check(relativePath: string): string | null | undefined {
    return webFileNaming.check?.(path.join(root, relativePath), root);
  }

  it('accepts the canonical component, hook, and store names', () => {
    expect(check('src/web/components/ChatPanel.tsx')).toBeNull();
    expect(check('src/web/features/chat/components/MessageList.tsx')).toBeNull();
    expect(check('src/web/features/chat/hooks/useChatSession.ts')).toBeNull();
    expect(check('src/web/stores/chatStore.ts')).toBeNull();
    expect(check('src/web/stores/useChatStore.ts')).toBeNull();
  });

  it('rejects a component file that is not PascalCase', () => {
    const result = check('src/web/components/chatPanel.tsx');

    expect(result).toContain('src/web/components/chatPanel.tsx is not PascalCase');
    expect(check('src/web/features/chat/components/message-list.tsx')).toContain('is not PascalCase');
  });

  it('rejects a hook file that is not a camelCase use* name', () => {
    expect(check('src/web/features/chat/hooks/use-chat-session.ts')).toContain('is not a camelCase use* name');
    expect(check('src/web/features/chat/hooks/ChatSession.ts')).toContain('is not a camelCase use* name');
    expect(check('src/web/lib/use_chat.ts')).toContain('is not a camelCase use* name');
  });

  it('rejects a store file that does not end in Store.ts', () => {
    const result = check('src/web/stores/chat.ts');

    expect(result).toContain('src/web/stores/chat.ts does not end in Store.ts');
    expect(check('src/web/stores/chatStore.tsx')).toContain('does not end in Store.ts');
  });

  it('leaves barrels, router files, variants, and non-source files alone', () => {
    expect(check('src/web/components/index.ts')).toBeNull();
    expect(check('src/web/features/chat/index.tsx')).toBeNull();
    expect(check('src/web/routes/__root.tsx')).toBeNull();
    expect(check('src/web/routes/chat.$sessionId.tsx')).toBeNull();
    expect(check('src/web/components/ChatPanel.test.tsx')).toBeNull();
    expect(check('src/web/components/chat-panel.stories.tsx')).toBeNull();
    expect(check('src/web/app/styles.css')).toBeNull();
  });

  it('leaves plain modules and files outside the browser bundle alone', () => {
    expect(check('src/web/lib/userProfile.ts')).toBeNull();
    expect(check('src/web/lib/format.ts')).toBeNull();
    expect(check('src/web/components/helpers.ts')).toBeNull();
    expect(check('src/services/chatStore.ts')).toBeNull();
    expect(check('tests/components/button.test.tsx')).toBeNull();
    expect(webFileNaming.check?.(path.join(root, '..', 'chatPanel.tsx'), root)).toBeNull();
  });
});
