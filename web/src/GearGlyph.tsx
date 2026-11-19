import type { SVGProps } from 'react';

/**
 * GEAR-ICON-001 (owner, 2026-11-19: "can we make the settings icon a gear"): eight square teeth around an
 * open hub. The kit's gear filled its hub, so at nav size it read as a blob, not a cog.
 */
export const GEAR_PATH = 'M10.13 4.22 L10.59 1.49 L13.41 1.49 L13.87 4.22 L16.18 5.18 L18.43 3.57 L20.43 5.57 L18.82 7.82 L19.78 10.13 L22.51 10.59 L22.51 13.41 L19.78 13.87 L18.82 16.18 L20.43 18.43 L18.43 20.43 L16.18 18.82 L13.87 19.78 L13.41 22.51 L10.59 22.51 L10.13 19.78 L7.82 18.82 L5.57 20.43 L3.57 18.43 L5.18 16.18 L4.22 13.87 L1.49 13.41 L1.49 10.59 L4.22 10.13 L5.18 7.82 L3.57 5.57 L5.57 3.57 L7.82 5.18 Z M15.30 12 A3.3 3.3 0 1 0 8.70 12 A3.3 3.3 0 1 0 15.30 12 Z';

export function GearGlyph({ size = 16, ...props }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className="glyph glyph--gear" {...props}>
      <path d={GEAR_PATH} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}
