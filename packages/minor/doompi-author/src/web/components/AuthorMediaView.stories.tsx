/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The view fetches `document.mediaUrl` before
 * it can paint, so the image variants use an inline data URL rather than a
 * session endpoint that only exists inside a running cockpit. The video
 * variant reuses that still, so it shows the player frame and the locked
 * controls, not real playback.
 */
import type { AuthorDisplayedRegion } from '../lib/authorViewportTypes';
import type { AuthorWorkspaceDocument } from '../stores/authorWorkspaceStore';
import { AuthorMediaView } from './AuthorMediaView';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABGUlEQVR4nO3RwQmDABAAQQuRPC0lRaQIy/FtqalBJJhbBraAhVnW16Zwy+MH+mmA4wGOBzge4HiA4wGOBzge4HiA4wGOBzge4HiA4wGOBzge4HiA4wGOBzjeZeDPfup+gOMBjgc4HuB4gOMBjgc4HuB4gOMBjgc4HuB4gOP9L7BmBTge4HiA4wGOBzge4HiA4wGOBzge4HiA4wGOBzge4HiA410GPvZ3uMc9AAMGDBgwYMCRAAMGPDnAgAFPDjBgwJMDDBjw5AADBjw5wIABTw4wYMCTAwwY8OQAAwY8OcCANTnA8QDHAxwPcDzA8QDHAxwPcDzA8QDHAxwPcDzA8QDHAxwPcDzA8QDHAxwPcDzA8QDHAxwPcLwvgg7vHumFeDwAAAAASUVORK5CYII=';

const picture: AuthorWorkspaceDocument = {
  path: 'assets/diagram.png',
  kind: 'image',
  mediaUrl: PNG,
  sourceSha256: 'abc123',
  annotations: [],
  revisions: [],
  saveRequest: 0,
  version: 1,
  savedVersion: 1,
};

const clip: AuthorWorkspaceDocument = { ...picture, path: 'clips/intro.mp4', kind: 'video' };

const marked: readonly AuthorDisplayedRegion[] = [
  {
    ordinal: 1,
    region: {
      id: 'r1',
      documentPath: picture.path,
      revision: 1,
      comment: 'Re-align this block.',
      anchor: {
        kind: 'image-rect',
        rect: { x: 0.09, y: 0.2, width: 0.69, height: 0.15 },
        naturalWidth: 160,
        naturalHeight: 100,
      },
      viewport: { width: 160, height: 100 },
      createdAt: 1_717_000_000_000,
    },
  },
];

const meta = {
  title: 'Author/AuthorMediaView',
  component: AuthorMediaView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">image · select mode</span>
        <AuthorMediaView sessionId="s1" document={picture} activeTool="select" displayedRegions={[]} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">image · mark mode with one region</span>
        <AuthorMediaView sessionId="s1" document={picture} activeTool="mark" displayedRegions={marked} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">video · locked by an unsent draft</span>
        <AuthorMediaView sessionId="s2" document={clip} activeTool="select" displayedRegions={[]} pendingCandidate />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no media url · stays pending</span>
        <AuthorMediaView
          sessionId="s3"
          document={{ ...picture, path: 'assets/missing.png', mediaUrl: undefined }}
          activeTool="select"
          displayedRegions={[]}
        />
      </div>
    </div>
  ),
};
