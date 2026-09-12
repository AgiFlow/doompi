import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorVideoControls, videoTimeLabel } from '../../src/web/components/AuthorVideoControls';
import {
  authorSessionWorkspace,
  authorWorkspace,
  focusAuthorDocument,
  putAuthorDocument,
  seekAuthorVideo,
  setAuthorRegionCandidate,
} from '../../src/web/stores/authorWorkspaceStore';

const hooks = vi.hoisted(() => ({ seconds: '', set: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: () => [hooks.seconds, hooks.set],
}));
type Props = {
  children?: ReactNode;
  'aria-label'?: string;
  disabled?: boolean;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault(): void }) => void;
};
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function fixture(locked = false, ready = true, marking = false, duration = 3) {
  const onSeek = vi.fn();
  const onToggle = vi.fn();
  const onAnnotate = vi.fn();
  const tree = nodes(
    AuthorVideoControls({
      playback: { playing: false, currentTime: 1, duration },
      locked,
      ready,
      marking,
      onSeek,
      onToggle,
      onAnnotate,
    }),
  );
  return {
    tree,
    onSeek,
    onToggle,
    onAnnotate,
    find: (label: string) => tree.find((n) => n.props['aria-label'] === label || n.props.children === label)!,
  };
}
afterEach(() => {
  hooks.seconds = '';
  vi.clearAllMocks();
  authorWorkspace.update(() => ({ documents: {}, sessions: {} }));
});
describe('video annotation controls', () => {
  it('formats precise timestamps without claiming a frame rate', () => {
    expect(videoTimeLabel(61.234)).toBe('01:01.234');
    expect(videoTimeLabel(NaN)).toBe('00:00.000');
  });
  it('seeks from the timeline and fine controls and selects the displayed frame', () => {
    const f = fixture();
    f.find('Video timeline').props.onChange!({ target: { value: '2.125' } });
    f.find('Seek back 0.1 seconds').props.onClick!();
    f.find('Seek forward 0.1 seconds').props.onClick!();
    expect(f.onSeek.mock.calls).toEqual([[2.125], [0.9], [1.1]]);
    f.find('Play').props.onClick!();
    f.find('Annotate this frame').props.onClick!();
    expect(f.onToggle).toHaveBeenCalledOnce();
    expect(f.onAnnotate).toHaveBeenCalledOnce();
  });
  it('submits a precise timestamp and rejects out-of-range input', () => {
    hooks.seconds = '1.250';
    const f = fixture();
    f.tree.find((n) => n.type === 'form')!.props.onSubmit!({ preventDefault: vi.fn() });
    expect(f.onSeek).toHaveBeenCalledWith(1.25);
    f.tree.find((n) => n.type === 'input' && n.props['aria-label'] === undefined)!.props.onChange!({
      target: { value: '2' },
    });
    expect(hooks.set).toHaveBeenCalledWith('2');
    for (const input of ['', '-1', '4', 'NaN']) {
      hooks.seconds = input;
      expect(fixture().find('Go').props.disabled).toBe(true);
    }
  });
  it('locks seek while a draft exists and disables annotation until decoding finishes', () => {
    expect(fixture(true).find('Video timeline').props.disabled).toBe(true);
    expect(fixture(false, false).find('Annotate this frame').props.disabled).toBe(true);
    expect(fixture(false, true, true, 0).find('Play').props.disabled).toBe(true);
  });
});
describe('saved video annotation navigation', () => {
  it('binds seek requests to the focused video and rejects pending selections', () => {
    expect(seekAuthorVideo('s', 1)).toBe(false);
    putAuthorDocument('s', { path: 'clip.mp4', kind: 'video' });
    const generation = focusAuthorDocument('s', 'clip.mp4', 0);
    expect(seekAuthorVideo('s', 1.25)).toBe(true);
    expect(authorSessionWorkspace('s').videoSeekRequest).toEqual({
      path: 'clip.mp4',
      generation,
      timeSeconds: 1.25,
      sequence: 1,
    });
    expect(seekAuthorVideo('s', -1)).toBe(false);
    expect(seekAuthorVideo('s', NaN)).toBe(false);
    setAuthorRegionCandidate('s', {
      documentPath: 'clip.mp4',
      revision: 0,
      anchor: {
        kind: 'video-time-rect',
        timeSeconds: 1.25,
        intrinsicWidth: 100,
        intrinsicHeight: 100,
        rect: { x: 0, y: 0, width: 1, height: 1 },
      },
      viewport: { width: 100, height: 100 },
      createdAt: 1,
    });
    expect(seekAuthorVideo('s', 2)).toBe(false);
  });
});
