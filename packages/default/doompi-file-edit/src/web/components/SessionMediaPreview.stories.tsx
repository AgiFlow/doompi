/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * The component exists because a media element cannot issue the encrypted fetch
 * a remote session file needs, so the story answers that fetch and shows the
 * three states it settles into.
 */
import { SessionMediaPreview } from './SessionMediaPreview.tsx';

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">',
  '<rect width="240" height="120" fill="#1c2027"/>',
  '<circle cx="72" cy="60" r="34" fill="#7fd1c1"/>',
  '<rect x="128" y="38" width="84" height="44" rx="6" fill="#c8a2ff"/>',
  '</svg>',
].join('');

const IMAGE_SRC = '/api/sessions/s1/file?path=assets/logo.svg';
const DOWNLOAD_SRC = '/api/sessions/s1/file?path=assets/bundle.zip';

/**
 * `sealedTransport.fetch` is a pass-through off a tunnel, so replacing the
 * global is the seam that stands in for the session's bytes route; anything
 * unrecognised falls through to the real one.
 */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === IMAGE_SRC) {
    return Promise.resolve(new Response(new Blob([SVG], { type: 'image/svg+xml' })));
  }
  if (url === DOWNLOAD_SRC) {
    return Promise.resolve(new Response(new Blob(['PK\u0003\u0004'], { type: 'application/zip' })));
  }
  if (url.startsWith('/api/sessions/')) return Promise.resolve(new Response('not found', { status: 404 }));
  return realFetch(input, init);
};

const meta = {
  title: 'Files/SessionMediaPreview',
  component: SessionMediaPreview,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6 text-sm text-doom-text">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">an image the browser can show</span>
        <SessionMediaPreview src={IMAGE_SRC} path="assets/logo.svg" data-testid="story-media-image" />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          a format it cannot · the honest download
        </span>
        <SessionMediaPreview src={DOWNLOAD_SRC} path="assets/bundle.zip" data-testid="story-media-download" />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">the route refused</span>
        <SessionMediaPreview
          src="/api/sessions/s1/file?path=assets/missing.png"
          path="assets/missing.png"
          data-testid="story-media-error"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no source yet</span>
        <SessionMediaPreview src="" path="assets/logo.svg" data-testid="story-media-loading" />
      </div>
    </div>
  ),
};
