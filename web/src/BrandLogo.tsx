import type { CSSProperties } from 'react';

/**
 * JPLAY-BRAND-001 (owner, 2026-11-19): the jPlay logo, from the owner's artwork (public/brand/). The
 * wordmark (its "j" is the note figure) shows where there is room, the note figure alone where there is
 * not. `tint` colours the logo with the listening mood (see brand-tint.ts); the grey shading of the
 * artwork stays, so the logo keeps its metal look in any colour. null = the artwork's own grey.
 */
export function BrandLogo({ tint, className }: { tint: string | null; className?: string }) {
  const style = tint ? ({ '--brand-tint': tint } as CSSProperties) : undefined;
  return (
    <span className={`brandlogo${tint ? ' is-tinted' : ''}${className ? ` ${className}` : ''}`} role="img" aria-label="jPlay" style={style}>
      <span className="brandlogo__mark" aria-hidden="true" />
      <span className="brandlogo__word" aria-hidden="true" />
    </span>
  );
}
