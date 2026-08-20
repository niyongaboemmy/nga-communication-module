import React from 'react';

/**
 * The Tupo mark.
 *
 * GENERATED FILE — produced by `brand/build-assets.py` from `brand/src/mark.svg`.
 * Edit the master artwork or that script, not this file.
 *
 * Inlined rather than loaded from `/logo.svg` so the mark inherits
 * `currentColor` in mono mode, costs no extra request, and cannot flash in
 * before the stylesheet lands.
 */

const BRAND_COLOR = '#005EF9';

const VIEW_W = 128;
const VIEW_H = 128;

export interface LogoProps {
  /** Rendered height in pixels. Width follows the artwork's aspect ratio. */
  size?: number;
  /** `brand` uses the brand blue; `mono` inherits currentColor. */
  variant?: 'brand' | 'mono';
  className?: string;
  /** Set when the logo is decorative and adjacent text already names the app. */
  decorative?: boolean;
}

export const Logo: React.FC<LogoProps> = ({
  size = 32, variant = 'brand', className, decorative = false,
}) => (
  <svg
    viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
    height={size}
    width={(size * VIEW_W) / VIEW_H}
    className={className}
    role={decorative ? undefined : 'img'}
    aria-label={decorative ? undefined : 'Tupo'}
    aria-hidden={decorative || undefined}
    focusable="false"
  >
    <g fill={variant === 'mono' ? 'currentColor' : BRAND_COLOR} fillRule="evenodd">
        <path d="M64 10a48 48 0 1 1 0 96 48 48 0 0 1-15.5-2.6l-26.8 17.4 8.9-25.6A48 48 0 0 1 64 10zm-28 34a6.5 6.5 0 0 0 0 13h56a6.5 6.5 0 0 0 0-13zm0 22a6.5 6.5 0 0 0 0 13h34a6.5 6.5 0 0 0 0-13z" />
    </g>
  </svg>
);
