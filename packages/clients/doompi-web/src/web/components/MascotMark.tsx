/** The glyph's intrinsic box, tight to the horns and the paws. */
const VIEW_BOX = '3 2.5 26 25';
const ASPECT = 26 / 25;

export interface MascotMarkProps {
  /** Rendered height in pixels; the width follows the glyph's aspect ratio. */
  size?: number;
  className?: string;
}

/**
 * The DoomPi mascot reduced to a wordmark glyph, so the pi it is built from
 * can stand in for the "Pi" in DoomPi and the lockup reads DOOM + mark.
 *
 * The traced mascot carries over a thousand points and thins to hairlines
 * below thirty pixels, which is smaller than every place a wordmark sits, so
 * this is the favicon's geometry without its badge: the same silhouette in
 * four flat shapes that still reads at twenty. Decorative by itself, because
 * the lockup around it is what carries the accessible name.
 */
export function MascotMark({ size = 24, className }: MascotMarkProps) {
  return (
    <svg
      viewBox={VIEW_BOX}
      height={size}
      width={size * ASPECT}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g className="fill-doom-yellow">
        <path d="M7 10Q6.2 4.2 9.3 3q1.1 3.3 2.8 6.6Z" />
        <path d="M25 10q.8-5.8-2.3-7-1.1 3.3-2.8 6.6Z" />
      </g>
      <g className="fill-doom-magenta">
        <rect x="3.2" y="8.6" width="25.6" height="7.6" rx="3.4" />
        <rect x="6.9" y="14" width="5.5" height="13" rx="2.5" />
        <rect x="19.6" y="14" width="5.5" height="13" rx="2.5" />
      </g>
      <g className="fill-doom-deep">
        <circle cx="10.9" cy="12.3" r="1.9" />
        <circle cx="21.1" cy="12.3" r="1.9" />
      </g>
    </svg>
  );
}
