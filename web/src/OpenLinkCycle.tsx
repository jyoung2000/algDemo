import { useEffect, useState } from 'react';
import { SourceMark } from './SourceMark';

/**
 * PLAYER-ONE-SOURCE-001 (owner, 2026-11-19): the player shows one platform at a time and cycles through
 * every platform the song is on. All of them in a row clipped ("usic") and crowded the title.
 * It holds still while pointed at or focused, so the shown platform can be pressed; the full list is
 * in the title for hover and for screen readers.
 */
export const OPEN_LINK_CYCLE_MS = 3500;

export interface OpenLink { provider: string; label: string; url: string }

const nameOf = (l: OpenLink) => l.label.replace(/^Open in\s+/i, '');
function listNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function OpenLinkCycle({ links }: { links: OpenLink[] }) {
  const sig = links.map((l) => l.provider).join('|');
  const [i, setI] = useState(0);
  const [hold, setHold] = useState({ pointer: false, focus: false });
  const held = hold.pointer || hold.focus;
  // A new song starts at its first platform.
  useEffect(() => { setI(0); }, [sig]);
  useEffect(() => {
    if (links.length < 2 || held) return;
    const t = setInterval(() => setI((n) => (n + 1) % links.length), OPEN_LINK_CYCLE_MS);
    return () => clearInterval(t);
  }, [sig, held, links.length]);
  if (!links.length) return null;
  const o = links[Math.min(i, links.length - 1)]!;
  const names = links.map(nameOf);
  return (
    <div className="np__open np__open--cycle" title={links.length > 1 ? `Also on ${listNames(names)}` : undefined}
      onMouseEnter={() => setHold((h) => ({ ...h, pointer: true }))} onMouseLeave={() => setHold((h) => ({ ...h, pointer: false }))}
      onFocus={() => setHold((h) => ({ ...h, focus: true }))} onBlur={() => setHold((h) => ({ ...h, focus: false }))}>
      <a key={o.provider} className="openlink" href={o.url} target="_blank" rel="noreferrer noopener" aria-label={o.label}>
        <SourceMark provider={o.provider} size={13} className="openlink__mark" />
        <span className="openlink__name">{nameOf(o)}</span>
        <span className="openlink__out" aria-hidden="true">↗</span>
      </a>
      {links.length > 1 && <span className="openlink__dots" aria-hidden="true">{links.map((l, n) => <i key={l.provider} className={n === i ? 'is-on' : undefined} />)}</span>}
    </div>
  );
}
