import { cn } from '@agimon-ai/doompi-web-components';
import { qrMatrix } from '../lib/qrMatrix.ts';

/** Modules of white space a scanner needs around the code, per the QR spec. */
const QUIET_ZONE = 4;

export interface QrCodeProps {
  /** What the code encodes. */
  value: string;
  /** Rendered edge length in pixels. */
  size?: number;
  className?: string;
  /** Announced to a screen reader, which cannot read the code itself. */
  label?: string;
}

/**
 * A QR code drawn as one SVG path.
 *
 * Modules take `currentColor` and the quiet zone is transparent, so the code
 * inherits the theme rather than naming a colour: a hardcoded black on white
 * would be the one element on the page that ignored a theme switch. Scanners
 * need the dark modules darker than their surround, so the caller places this
 * on a light surface and sets the text colour dark.
 */
export function QrCode({ value, size = 208, className, label }: QrCodeProps) {
  const matrix = qrMatrix(value);
  const span = matrix.length + QUIET_ZONE * 2;
  // One path of many little squares beats one rect per module: a typical code
  // is well over a thousand modules, and that many DOM nodes is measurably
  // slower to lay out than a single d attribute.
  const path = matrix
    .flatMap((row, rowIndex) =>
      row.map((dark, columnIndex) =>
        dark ? `M${String(columnIndex + QUIET_ZONE)} ${String(rowIndex + QUIET_ZONE)}h1v1h-1z` : '',
      ),
    )
    .join('');

  return (
    <svg
      viewBox={`0 0 ${String(span)} ${String(span)}`}
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      role="img"
      aria-label={label ?? 'Pairing QR code'}
      shapeRendering="crispEdges"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
