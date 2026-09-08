import { MediaPreview } from './MediaPreview.tsx';

const IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='90'%3E%3Crect width='160' height='90' fill='gray'/%3E%3C/svg%3E";

// An empty payload: the player chrome is the variant here, not decoded frames.
const VIDEO = 'data:video/mp4,';

// A one page PDF with no content stream, so the canvas draws an empty page.
const PDF =
  'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMTgwIDkwXT4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4=';

const meta = {
  title: 'Components/MediaPreview',
  component: MediaPreview,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">image</span>
        <MediaPreview src={IMAGE} path="assets/logo.svg" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">video</span>
        <MediaPreview src={VIDEO} path="clips/demo.mp4" className="max-h-40" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">pdf</span>
        <MediaPreview src={PDF} path="docs/spec.pdf" className="h-64" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">download</span>
        <MediaPreview src={IMAGE} path="reports/summary.docx" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">kind overrides the path</span>
        <MediaPreview src={IMAGE} path="assets/logo.svg" kind="download" />
      </div>
    </div>
  ),
};
