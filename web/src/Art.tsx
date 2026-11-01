import { useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';

/** Album art with a quiet placeholder when there is none or it fails to load. Loaded by the browser from the provider's CDN. */
export function Art({ src, size, alt = '' }: { src?: string | null; size: number; alt?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <span className="art art--none" style={{ width: size, height: size }} aria-hidden={alt ? undefined : true}>
        <Glyph name="note" size={Math.round(size * 0.42)} />
      </span>
    );
  }
  return <img className="art" src={src} alt={alt} width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}
