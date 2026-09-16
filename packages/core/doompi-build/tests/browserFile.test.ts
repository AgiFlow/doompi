import { describe, expect, it } from 'vitest';

import { isBrowserFile } from '../src/services/browserFile';

const SESSION = 'src/extensions/workspaces/sessions';

describe('isBrowserFile', () => {
  it('reads nothing outside the routing root as browser code', () => {
    expect(isBrowserFile('src/web/components/Panel.tsx')).toBe(false);
    expect(isBrowserFile('src/services/tasks/index.ts')).toBe(false);
    expect(isBrowserFile('tests/web.test.ts')).toBe(false);
  });

  it('accepts the singular routing root alias', () => {
    expect(isBrowserFile('src/extension/workspaces/sessions/(frontend)/tool/task.web.tsx')).toBe(true);
  });

  it('never reads the backend side as browser code', () => {
    expect(isBrowserFile(`${SESSION}/(backend)/tool/task.server.ts`)).toBe(false);
    expect(isBrowserFile(`${SESSION}/(backend)/tool/task.cli.ts`)).toBe(false);
    expect(isBrowserFile(`${SESSION}/(backend)/tool/_lib/taskStore.ts`)).toBe(false);
  });

  it('reads a routed file with no side group as neither side', () => {
    expect(isBrowserFile('src/extensions/pi.ts')).toBe(false);
  });

  it('separates the two renderers of a shared surface by their platform', () => {
    expect(isBrowserFile(`${SESSION}/(frontend)/tool/task.web.tsx`)).toBe(true);
    expect(isBrowserFile(`${SESSION}/(frontend)/tool/task.cli.tsx`)).toBe(false);
    expect(isBrowserFile(`${SESSION}/(frontend)/tool/task.cli.ts`)).toBe(false);
  });

  it('reads a terminal-only surface as terminal whatever the filename says', () => {
    expect(isBrowserFile(`${SESSION}/(frontend)/overlay/task-space.cli.ts`)).toBe(false);
    expect(isBrowserFile(`${SESSION}/(frontend)/overlay/_lib/taskOverlay.ts`)).toBe(false);
    expect(isBrowserFile(`${SESSION}/(frontend)/message/doom-task-notify.cli.ts`)).toBe(false);
    expect(isBrowserFile(`${SESSION}/(frontend)/message/_lib/workflowStepRenderer.ts`)).toBe(false);
  });

  it('reads the private folders colocated beside a browser surface as browser code', () => {
    expect(isBrowserFile(`${SESSION}/(frontend)/tool/_components/GrepToolMessage.tsx`)).toBe(true);
    expect(isBrowserFile(`${SESSION}/(frontend)/tool/_lib/grepRenderer.ts`)).toBe(true);
    expect(isBrowserFile(`${SESSION}/(frontend)/fill/_lib/TaskDetailDialog.stories.tsx`)).toBe(true);
  });

  it('looks past a gate folder and its id to reach the surface', () => {
    expect(isBrowserFile(`${SESSION}/(frontend)/mode/plan/mode.web.ts`)).toBe(true);
    expect(isBrowserFile(`${SESSION}/(frontend)/mode/plan/tool/plan.web.tsx`)).toBe(true);
    expect(isBrowserFile(`${SESSION}/(frontend)/mode/plan/overlay/plan.cli.ts`)).toBe(false);
    expect(isBrowserFile(`${SESSION}/(frontend)/domain/git/tool/status.cli.ts`)).toBe(false);
  });

  it('reads a private folder at the side root as browser code, having no surface to read', () => {
    expect(isBrowserFile(`${SESSION}/(frontend)/_lib/loopActivitySource.ts`)).toBe(true);
    expect(isBrowserFile('src/extensions/(frontend)/_legacy/index.ts')).toBe(true);
  });

  it('reads the side root itself by platform, since the scope constructor names one', () => {
    expect(isBrowserFile(`${SESSION}/(frontend)/root.web.ts`)).toBe(true);
    expect(isBrowserFile(`${SESSION}/(frontend)/root.cli.ts`)).toBe(false);
  });
});
