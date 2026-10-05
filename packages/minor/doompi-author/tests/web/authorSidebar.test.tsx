import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthorDocumentPanel,
  authorOpenSourceAction,
} from '../../src/extensions/workspaces/sessions/(frontend)/_components/AuthorDocumentPanel';
import { multiRegionCaptureProvider } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorCapture';
import * as workspace from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorWorkspaceStore';
import { AuthorFeedbackControls } from '../../src/extensions/workspaces/sessions/(frontend)/dock/_components/AuthorFeedbackControls';
import { AuthorPanel } from '../../src/extensions/workspaces/sessions/(frontend)/dock/_components/AuthorPanel';
import { AuthorRegionDrafts } from '../../src/extensions/workspaces/sessions/(frontend)/dock/_components/AuthorRegionDrafts';
import { AuthorRequestLog } from '../../src/extensions/workspaces/sessions/(frontend)/dock/_components/AuthorRequestLog';
import { AuthorToolPalette } from '../../src/extensions/workspaces/sessions/(frontend)/dock/_components/AuthorToolPalette';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => undefined,
}));
vi.mock('@tanstack/react-store', () => ({
  useStore: (store: { state: unknown }, selector: (state: unknown) => unknown) => selector(store.state),
}));
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_lib/authorCapture', async (original) => ({
  ...(await original<typeof import('../../src/extensions/workspaces/sessions/(frontend)/_lib/authorCapture')>()),
  multiRegionCaptureProvider: vi.fn(() => ({
    capture: vi.fn(async () => ({ data: 'aW1hZ2U=', mimeType: 'image/png' })),
  })),
}));

type Props = {
  children?: ReactNode;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  'aria-pressed'?: boolean;
  'data-testid'?: string;
};
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  const children =
    node.type === AuthorFeedbackControls
      ? AuthorFeedbackControls(node.props as Parameters<typeof AuthorFeedbackControls>[0])
      : node.props.children;
  return [node, ...nodes(children)];
}
function setup() {
  workspace.putAuthorDocument('s', { path: 'clip.mp4', kind: 'video', sourceSha256: 'sha' });
  workspace.focusAuthorDocument('s', 'clip.mp4');
  workspace.setAuthorRegionCandidate('s', 'clip.mp4', {
    documentPath: 'clip.mp4',
    revision: 0,
    sourceSha256: 'sha',
    anchor: { kind: 'video-time-rect', timeSeconds: 1.234, rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    viewport: { width: 800, height: 600 },
    createdAt: 1,
  });
  workspace.commitAuthorRegion('s', 'clip.mp4', 'Brighten this frame');
  return {
    sessionId: 's',
    activeMinorModes: ['author'],
    statuses: {},
    attachComposerCapture: vi.fn(),
    submitCapture: vi.fn(async () => undefined),
    openTab: vi.fn(),
    renderSlot: vi.fn(() => null),
  } as unknown as WebPluginSlotProps;
}
afterEach(() => {
  workspace.authorWorkspace.reset();
  vi.clearAllMocks();
});

describe('Author annotation sidebar', () => {
  it('offers an embedded preview toggle for focused story source', () => {
    const props = setup();
    workspace.putAuthorDocument('s', { path: 'Button.stories.tsx', kind: 'story-preview', sourceSha256: 'sha' });
    workspace.focusAuthorDocument('s', 'Button.stories.tsx');
    workspace.reviseAuthorDocument('s', 'Button.stories.tsx', 'unsaved story source');
    const supportsSource = vi.fn(() => true);
    const createTab = vi.fn();
    props.slotData = vi.fn(
      () =>
        [
          {
            pluginId: 'style-system',
            id: 'story-preview',
            data: {
              version: 1,
              label: 'Preview',
              supportsSource,
              embeddedPanel: () => null,
              createTab,
            },
          },
        ] as never,
    ) as unknown as WebPluginSlotProps['slotData'];

    const element = AuthorDocumentPanel({ ...props, path: 'Button.stories.tsx' } as WebPluginSlotProps & {
      path: string;
    });
    const controls = nodes((element.type as (props: unknown) => ReactNode)(element.props));
    const toggle = controls.find((node) => node.props['data-testid'] === 'author-story-preview-toggle');

    expect(toggle?.props.children).toBe('Preview');
    expect(toggle?.props['aria-pressed']).toBe(false);
    expect(controls.find((node) => node.props['data-testid'] === 'author-save')?.props.children).toBe('Save');
    expect(supportsSource).toHaveBeenCalledWith({
      path: 'Button.stories.tsx',
      kind: 'story-preview',
      hasUnsavedChanges: true,
      revision: 0,
      sourceSha256: 'sha',
    });
    expect(createTab).not.toHaveBeenCalled();
  });

  it('opens the handed-off exact project and export in the embedded preview', () => {
    const props = setup();
    const path = 'Button.stories.tsx';
    workspace.putAuthorDocument('s', { path, kind: 'story-preview', sourceSha256: 'sha' });
    const preview = { appPath: 'apps/native', storyExport: 'Disabled', snapshot: true };
    authorOpenSourceAction.createTab({ sessionId: 's', path, preview });
    const embeddedPanel = () => null;
    props.slotData = (() => [
      {
        pluginId: 'style-system',
        id: 'preview',
        data: {
          version: 1,
          label: 'Preview',
          createTab: vi.fn(),
          embeddedPanel,
        },
      },
    ]) as unknown as WebPluginSlotProps['slotData'];
    const element = AuthorDocumentPanel({ ...props, path });
    const controls = nodes((element.type as (props: unknown) => ReactNode)(element.props));
    expect(
      controls.find((node) => node.props['data-testid'] === 'author-story-preview-toggle')?.props['aria-pressed'],
    ).toBe(true);
    const embedded = controls.find((node) => node.type === embeddedPanel);
    expect(embedded).toBeDefined();
    expect((embedded?.props as { source?: { preview?: unknown } } | undefined)?.source?.preview).toEqual(preview);
  });

  it("shows only the open document's requests, and every request when no document is open", () => {
    const props = setup();
    const region = workspace.authorDocumentAnnotations('s', 'clip.mp4').annotations[0]!;
    for (const [id, documentPath] of [
      ['clip-request', 'clip.mp4'],
      ['other-request', 'other.png'],
    ] as const) {
      workspace.putAuthorRequest('s', {
        id,
        documentPath,
        requestText: 'change',
        regions: [{ ...region, documentPath }],
        status: 'REQUESTED',
        createdAt: 1,
        updatedAt: 1,
        revision: 0,
      });
    }
    const logged = () =>
      (
        nodes(AuthorPanel(props)).find((node) => node.type === AuthorRequestLog)!.props as unknown as {
          requests: { id: string }[];
        }
      ).requests.map(({ id }) => id);
    expect(logged()).toEqual(['clip-request']);
    workspace.releaseAuthorDocumentFocus('s', workspace.authorSessionWorkspace('s').focusedDocument!.generation);
    expect(logged()).toEqual(['clip-request', 'other-request']);
  });
  it('submits annotations asynchronously without navigation or changing the composer', async () => {
    const props = setup();
    const controls = nodes(AuthorPanel(props));
    expect(props.renderSlot).toHaveBeenCalledWith('author.preview-provider');
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
    workspace.setAuthorRegionCandidate(
      's',
      'clip.mp4',
      workspace.authorDocumentAnnotations('s', 'clip.mp4').annotations[0],
    );
    const review = nodes(AuthorPanel(props)).find((node) => node.props['data-testid'] === 'author-attach-capture')!;
    expect(review.props.disabled).toBe(true);
    void review.props.onClick!();
    expect(multiRegionCaptureProvider).not.toHaveBeenCalled();
    const drafts = nodes(
      AuthorRegionDrafts({
        sessionId: 's',
        path: 'clip.mp4',
        drafts: workspace.authorDocumentAnnotations('s', 'clip.mp4'),
      }),
    );
    void drafts.find((node) => node.props.children === 'Discard annotation')!.props.onClick!();
    expect(workspace.authorDocumentAnnotations('s', 'clip.mp4').candidate).toBeUndefined();
    expect(workspace.authorDocumentAnnotations('s', 'clip.mp4').annotations).toHaveLength(1);
  });

  it('offers timestamp navigation and disables it while a selection is pending', () => {
    setup();
    const seek = vi.spyOn(workspace, 'seekAuthorVideo');
    const drafts = () =>
      nodes(
        AuthorRegionDrafts({
          sessionId: 's',
          path: 'clip.mp4',
          drafts: workspace.authorDocumentAnnotations('s', 'clip.mp4'),
        }),
      );
    const timestamp = drafts().find(
      (node) => Array.isArray(node.props.children) && node.props.children[0] === 'Go to ',
    )!;
    expect(timestamp.props.children).toEqual(['Go to ', '1.234', 's']);
    expect(timestamp.props.disabled).toBe(false);
    void timestamp.props.onClick!();
    expect(seek).toHaveBeenCalledWith('s', 'clip.mp4', 1.234);
    workspace.setAuthorRegionCandidate(
      's',
      'clip.mp4',
      workspace.authorDocumentAnnotations('s', 'clip.mp4').annotations[0],
    );
    expect(
      drafts().find((node) => Array.isArray(node.props.children) && node.props.children[0] === 'Go to ')!.props
        .disabled,
    ).toBe(true);
    seek.mockRestore();
  });

  it('uses readable 44px targets for palette and draft actions', () => {
    setup();
    const controls = [
      ...nodes(AuthorToolPalette({ sessionId: 's', path: 'clip.mp4', kind: 'video', activeTool: 'mark' })),
      ...nodes(
        AuthorRegionDrafts({
          sessionId: 's',
          path: 'clip.mp4',
          drafts: workspace.authorDocumentAnnotations('s', 'clip.mp4'),
        }),
      ),
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
    expect(workspace.authorDocumentAnnotations('s', 'clip.mp4').annotations).toHaveLength(1);
    expect(props.openTab).not.toHaveBeenCalled();
  });

  it('disables submission when the host has not loaded the new contract', async () => {
    const props = { ...setup(), submitCapture: undefined };
    const submit = nodes(AuthorPanel(props)).find((node) => node.props['data-testid'] === 'author-attach-capture')!;
    expect(submit.props.disabled).toBe(true);
    await submit.props.onClick!();
    expect(multiRegionCaptureProvider).not.toHaveBeenCalled();
  });

  it('shows host activity only for focused REQUESTED or CHANGING work', () => {
    const renderSessionActivity = vi.fn(() =>
      createElement('div', { 'data-testid': 'host-session-activity' }, 'working'),
    );
    const props = { ...setup(), renderSessionActivity };
    const region = workspace.authorDocumentAnnotations('s', 'clip.mp4').annotations[0]!;
    workspace.putAuthorRequest('s', {
      id: 'other',
      documentPath: 'other.png',
      requestText: 'change',
      regions: [region],
      status: 'CHANGING',
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
    });
    const footer = () =>
      nodes(AuthorPanel(props)).find((node) => node.props['data-testid'] === 'author-session-activity');
    expect(footer()).toBeUndefined();
    expect(renderSessionActivity).not.toHaveBeenCalled();
    workspace.putAuthorRequest('s', {
      id: 'focused',
      documentPath: 'clip.mp4',
      requestText: 'change',
      regions: [region],
      status: 'COMPLETE',
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
    });
    expect(footer()).toBeUndefined();
    for (const status of ['REQUESTED', 'CHANGING'] as const) {
      workspace.updateAuthorRequest('s', 'focused', (record) => ({ ...record, status }));
      expect(footer()?.props.className).toContain('shrink-0');
      expect(footer()?.props.className).toContain('border-t');
    }
    workspace.releaseAuthorDocumentFocus('s', workspace.authorSessionWorkspace('s').focusedDocument!.generation);
    expect(footer()).toBeUndefined();
  });
});
