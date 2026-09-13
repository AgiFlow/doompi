import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthorPanel } from '../../src/web/components/AuthorPanel';
import { AuthorRegionDrafts } from '../../src/web/components/AuthorRegionDrafts';
import { AuthorToolPalette } from '../../src/web/components/AuthorToolPalette';
import { multiRegionCaptureProvider } from '../../src/web/stores/authorCapture';
import * as workspace from '../../src/web/stores/authorWorkspaceStore';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock('@tanstack/react-store', () => ({
  useStore: (store: { state: unknown }, selector: (state: unknown) => unknown) => selector(store.state),
}));
vi.mock('../../src/web/stores/authorCapture', async (original) => ({
  ...(await original<typeof import('../../src/web/stores/authorCapture')>()),
  multiRegionCaptureProvider: vi.fn(() => ({
    capture: vi.fn(async () => ({ data: 'aW1hZ2U=', mimeType: 'image/png' })),
  })),
}));

type Props = {
  children?: ReactNode;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
};
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function setup() {
  workspace.putAuthorDocument('s', { path: 'clip.mp4', kind: 'video', sourceSha256: 'sha' });
  workspace.focusAuthorDocument('s', 'clip.mp4', 0, 'sha');
  workspace.setAuthorRegionCandidate('s', {
    documentPath: 'clip.mp4',
    revision: 0,
    sourceSha256: 'sha',
    anchor: { kind: 'video-time-rect', timeSeconds: 1.234, rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    viewport: { width: 800, height: 600 },
    createdAt: 1,
  });
  workspace.commitAuthorRegion('s', 'Brighten this frame');
  return {
    sessionId: 's',
    activeMinorModes: ['author'],
    statuses: {},
    attachComposerCapture: vi.fn(),
    submitCapture: vi.fn(async () => undefined),
    openTab: vi.fn(),
  } as unknown as WebPluginSlotProps;
}
afterEach(() => {
  workspace.authorWorkspace.reset();
  vi.clearAllMocks();
});

describe('Author annotation sidebar', () => {
  it('submits annotations asynchronously without navigation or changing the composer', async () => {
    const props = setup();
    const controls = nodes(AuthorPanel(props));
    const review = controls.find((node) => node.props['data-testid'] === 'author-attach-capture')!;
    expect(review.props.disabled).toBe(false);
    expect(review.props.className).toContain('min-h-11');
    await review.props.onClick!();
    expect(multiRegionCaptureProvider).toHaveBeenCalledOnce();
    expect(props.submitCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
        context: expect.objectContaining({ kind: 'author-capture' }),
      }),
    );
    expect(props.attachComposerCapture).not.toHaveBeenCalled();
    expect(props.openTab).not.toHaveBeenCalled();
    expect(workspace.authorSessionWorkspace('s').requests).toEqual([]);
  });

  it('blocks submission until the current candidate is added or discarded', () => {
    const props = setup();
    workspace.setAuthorRegionCandidate('s', workspace.authorSessionWorkspace('s').regions[0]);
    const review = nodes(AuthorPanel(props)).find((node) => node.props['data-testid'] === 'author-attach-capture')!;
    expect(review.props.disabled).toBe(true);
    void review.props.onClick!();
    expect(multiRegionCaptureProvider).not.toHaveBeenCalled();
    const drafts = nodes(AuthorRegionDrafts({ sessionId: 's', workspace: workspace.authorSessionWorkspace('s') }));
    void drafts.find((node) => node.props.children === 'Discard selection')!.props.onClick!();
    expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
    expect(workspace.authorSessionWorkspace('s').regions).toHaveLength(1);
  });

  it('offers timestamp navigation and disables it while a selection is pending', () => {
    setup();
    const seek = vi.spyOn(workspace, 'seekAuthorVideo');
    const drafts = () =>
      nodes(AuthorRegionDrafts({ sessionId: 's', workspace: workspace.authorSessionWorkspace('s') }));
    const timestamp = drafts().find(
      (node) => Array.isArray(node.props.children) && node.props.children[0] === 'Go to ',
    )!;
    expect(timestamp.props.children).toEqual(['Go to ', '1.234', 's']);
    expect(timestamp.props.disabled).toBe(false);
    void timestamp.props.onClick!();
    expect(seek).toHaveBeenCalledWith('s', 1.234);
    workspace.setAuthorRegionCandidate('s', workspace.authorSessionWorkspace('s').regions[0]);
    expect(
      drafts().find((node) => Array.isArray(node.props.children) && node.props.children[0] === 'Go to ')!.props
        .disabled,
    ).toBe(true);
    seek.mockRestore();
  });

  it('uses readable 44px targets for palette and draft actions', () => {
    setup();
    const controls = [
      ...nodes(AuthorToolPalette({ sessionId: 's', kind: 'video', activeTool: 'mark' })),
      ...nodes(AuthorRegionDrafts({ sessionId: 's', workspace: workspace.authorSessionWorkspace('s') })),
    ].filter((node) => node.props.onClick);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.props.className).toContain('min-h-11');
      expect(control.props.className).toContain('min-w-11');
      expect(control.props.className).toContain('text-base');
    }
  });
  it('keeps drafts when submission fails and handles the rejection', async () => {
    const props = setup();
    vi.mocked(props.submitCapture!).mockRejectedValueOnce(new Error('Disconnected'));
    const submit = nodes(AuthorPanel(props)).find((node) => node.props['data-testid'] === 'author-attach-capture')!;
    await submit.props.onClick!();
    expect(workspace.authorSessionWorkspace('s').regions).toHaveLength(1);
    expect(props.openTab).not.toHaveBeenCalled();
  });

  it('disables submission when the host has not loaded the new contract', async () => {
    const props = { ...setup(), submitCapture: undefined };
    const submit = nodes(AuthorPanel(props)).find((node) => node.props['data-testid'] === 'author-attach-capture')!;
    expect(submit.props.disabled).toBe(true);
    await submit.props.onClick!();
    expect(multiRegionCaptureProvider).not.toHaveBeenCalled();
  });
});
