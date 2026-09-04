import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/webpack.mjs';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { Button } from './Button.tsx';

export interface PdfNormalizedRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageState {
  page: number;
  pageCount: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface PdfPageRegion {
  page: number;
  rect: PdfNormalizedRectangle;
}

export interface PdfPreviewController {
  getState: () => PdfPageState;
  setPage: (page: number) => void;
  resolveViewportRegion: (rectangle: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }) => PdfPageRegion | null;
  capturePage: (type?: 'image/png' | 'image/jpeg', quality?: number) => Promise<Blob | null>;
}

export interface PdfPreviewProps {
  src: string;
  path: string;
  className?: string;
  'data-testid'?: string;
  controllerRef?: import('react').Ref<PdfPreviewController>;
}

const EMPTY_STATE: PdfPageState = { page: 1, pageCount: 0, sourceWidth: 0, sourceHeight: 0 };

function boundedPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page) || pageCount <= 0) return 1;
  return Math.min(pageCount, Math.max(1, Math.trunc(page)));
}

export function resolvePdfViewportRegion(
  page: number,
  bounds: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  rectangle: { left: number; top: number; right: number; bottom: number },
): PdfPageRegion | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const left = Math.max(bounds.left, Math.min(bounds.right, rectangle.left));
  const right = Math.max(bounds.left, Math.min(bounds.right, rectangle.right));
  const top = Math.max(bounds.top, Math.min(bounds.bottom, rectangle.top));
  const bottom = Math.max(bounds.top, Math.min(bounds.bottom, rectangle.bottom));
  if (right <= left || bottom <= top) return null;
  return {
    page,
    rect: {
      x: (left - bounds.left) / bounds.width,
      y: (top - bounds.top) / bounds.height,
      width: (right - left) / bounds.width,
      height: (bottom - top) / bounds.height,
    },
  };
}
function canvasBlob(
  canvas: HTMLCanvasElement,
  type: 'image/png' | 'image/jpeg',
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** A page-aware PDF canvas. Coordinates resolve against PDF page geometry rather than an opaque browser iframe. */
export function PdfPreview({ src, path, className, controllerRef, 'data-testid': testId }: PdfPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const renderTask = useRef<{ cancel(): void } | null>(null);
  const [page, setPage] = useState(1);
  const [pageState, setPageState] = useState<PdfPageState>(EMPTY_STATE);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const loading = getDocument({ url: src });
    let disposed = false;
    void loading.promise
      .then((document) => {
        if (disposed) return;
        documentRef.current = document;
        setError(undefined);
        setPage(1);
        setPageState({ ...EMPTY_STATE, pageCount: document.numPages });
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      void loading.destroy();
      renderTask.current?.cancel();
      renderTask.current = null;
      documentRef.current = null;
    };
  }, [src]);

  useEffect(() => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    if (document === null || canvas === null) return;
    let disposed = false;
    void document
      .getPage(page)
      .then((pdfPage: PDFPageProxy) => {
        if (disposed) return;
        const source = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        setPageState({ page, pageCount: document.numPages, sourceWidth: source.width, sourceHeight: source.height });
        const context = canvas.getContext('2d');
        if (context === null) return;
        const task = pdfPage.render({ canvas, canvasContext: context, viewport });
        renderTask.current = task;
        return task.promise;
      })
      .catch((reason: unknown) => {
        if (!disposed && (reason as { name?: unknown }).name !== 'RenderingCancelledException') {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      disposed = true;
      renderTask.current?.cancel();
      renderTask.current = null;
    };
  }, [page, pageState.pageCount]);

  useImperativeHandle(
    controllerRef,
    () => ({
      getState: () => pageState,
      setPage: (next) => setPage(boundedPage(next, pageState.pageCount)),
      resolveViewportRegion: (rectangle) => {
        const canvas = canvasRef.current;
        if (canvas === null || pageState.pageCount === 0) return null;
        return resolvePdfViewportRegion(pageState.page, canvas.getBoundingClientRect(), rectangle);
      },
      capturePage: async (type = 'image/png', quality) => {
        const canvas = canvasRef.current;
        return canvas === null ? null : await canvasBlob(canvas, type, quality);
      },
    }),
    [pageState],
  );

  return (
    <section data-testid={testId} data-kind="pdf" className={cn('flex min-h-0 flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2 text-[10px] text-doom-faint">
        <span>{path}</span>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            previous
          </Button>
          <span data-testid={testId === undefined ? undefined : `${testId}-page`}>
            {pageState.pageCount === 0 ? 'loading' : `${page} / ${pageState.pageCount}`}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={pageState.pageCount === 0 || page >= pageState.pageCount}
            onClick={() => setPage((value) => boundedPage(value + 1, pageState.pageCount))}
          >
            next
          </Button>
        </div>
      </div>
      {error === undefined ? null : <output className="text-[10px] text-doom-red">{error}</output>}
      <div className="min-h-0 overflow-auto rounded border border-doom-border bg-doom-deep">
        <canvas ref={canvasRef} aria-label={path} className="mx-auto block max-w-full" />
      </div>
    </section>
  );
}
