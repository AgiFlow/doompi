import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../src/components/Sheet.tsx';

describe('sheet composition', () => {
  // Render the semantic sections directly: server rendering does not mount the portal.
  it('composes a titled, described panel with a labelled dismissal control', () => {
    const out = renderToStaticMarkup(
      <Sheet>
        <SheetHeader closeLabel="close details">
          <SheetTitle>File details</SheetTitle>
        </SheetHeader>
        <SheetBody className="custom-body" aria-label="details">
          <SheetDescription>Current file metadata</SheetDescription>
          Contents
        </SheetBody>
        <SheetFooter className="custom-footer">
          <SheetClose>Done</SheetClose>
        </SheetFooter>
      </Sheet>,
    );
    expect(out).toMatch(/<h2[^>]*data-slot="sheet-title"[^>]*>File details<\/h2>/);
    expect(out).toMatch(/<p[^>]*data-slot="sheet-description"[^>]*>Current file metadata<\/p>/);
    expect(out).toContain('aria-label="close details"');
    expect(out).toContain('data-slot="sheet-body"');
    expect(out).toContain('custom-body');
    expect(out).toContain('aria-label="details"');
    expect(out).toContain('custom-footer');
    expect(out).toMatch(/<button[^>]*data-slot="sheet-close"[^>]*>Done<\/button>/);
  });

  it('defaults to an accessible close control and lets the caller omit it', () => {
    expect(
      renderToStaticMarkup(
        <Sheet>
          <SheetHeader>Details</SheetHeader>
        </Sheet>,
      ),
    ).toContain('aria-label="close"');
    const out = renderToStaticMarkup(
      <Sheet>
        <SheetHeader dismissible={false}>Details</SheetHeader>
      </Sheet>,
    );
    expect(out).toContain('Details');
    expect(out).not.toContain('<button');
  });
});
