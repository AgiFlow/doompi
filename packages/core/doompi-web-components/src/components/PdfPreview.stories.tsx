import { PdfPreview } from './PdfPreview.tsx';

// A one page PDF with no content stream, so the canvas draws an empty page.
const PDF =
  'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMTgwIDkwXT4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4=';

const meta = {
  title: 'Components/PdfPreview',
  component: PdfPreview,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">single page</span>
        <PdfPreview src={PDF} path="docs/spec.pdf" className="h-64" data-testid="pdf-preview" />
      </div>
    </div>
  ),
};
