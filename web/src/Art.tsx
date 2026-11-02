import { useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';

/** Album art with a quiet placeholder when there is none or it fails to load. Loaded by the browser from the provider's CDN. */
export function Art({ src, size, alt = '' }: { src?: string | null; size: number; alt?: string }) {
  // The failure is remembered against the URL that failed, so a song whose artwork arrives later
  // (or a reused row showing a different song) is not left with the placeholder for good.
  const [failed, setFailed] = useState<string | null>(null);
  const broken = Boolean(src) && failed === src;
  if (!src || broken) {
    return (
      <span className="art art--none" style={{ width: size, height: size }} aria-hidden={alt ? undefined : true}>
        <Glyph name="note" size={Math.round(size * 0.42)} />
      </span>
    );
  }
  return <img className="art" src={src} alt={alt} width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
}
