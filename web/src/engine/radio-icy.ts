/**
 * ICY ("SHOUTcast") in-stream metadata — the song titles internet radio stations send.
 *
 * A client that asks with `Icy-MetaData: 1` gets `icy-metaint: N` back, and from then on the stream
 * is N bytes of audio, one length byte (×16), that many bytes of `StreamTitle='…';` text padded with
 * NULs, N bytes of audio, and so on. A page cannot see any of this (the browser consumes the stream
 * and the header needs CORS few stations grant), which is why reading it is the hub's and the
 * companion's job; this file is the pure part both of them share.
 */

/** Splits a raw ICY byte stream into its metadata blocks. Feed it chunks in order. */
export class IcyReader {
  private audioLeft: number;
  private metaLeft = -1;
  private meta: number[] = [];
  /** Every metadata block completed so far, empty ones included (a zero length byte means "unchanged"). */
  blocks = 0;

  constructor(private readonly metaint: number) {
    if (!Number.isInteger(metaint) || metaint <= 0) throw new RangeError('icy-metaint must be a positive integer');
    this.audioLeft = metaint;
  }

  /** Returns the text of every non-empty metadata block completed by this chunk. */
  feed(chunk: Uint8Array): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.audioLeft > 0) {
        const skip = Math.min(this.audioLeft, chunk.length - i);
        this.audioLeft -= skip;
        i += skip;
        continue;
      }
      if (this.metaLeft < 0) {
        this.metaLeft = chunk[i]! * 16;
        this.meta = [];
        i += 1;
      } else {
        const take = Math.min(this.metaLeft, chunk.length - i);
        for (let k = 0; k < take; k++) this.meta.push(chunk[i + k]!);
        this.metaLeft -= take;
        i += take;
      }
      if (this.metaLeft === 0) {
        this.blocks += 1;
        const text = decodeMeta(Uint8Array.from(this.meta));
        if (text) out.push(text);
      }
      if (this.metaLeft <= 0 && this.metaLeft !== -1) {
        this.metaLeft = -1;
        this.audioLeft = this.metaint;
      }
    }
    return out;
  }
}

/** UTF-8 when the bytes are valid UTF-8, Latin-1 otherwise — what stations actually send. */
function decodeMeta(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  const body = bytes.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body).trim();
  } catch {
    return new TextDecoder('latin1').decode(body).trim();
  }
}

/** The `StreamTitle` value of one metadata block, or null when the station sent none. */
export function parseStreamTitle(meta: string): string | null {
  // The value ends at the first `';` — titles are full of apostrophes, the terminator is not.
  const match = /StreamTitle='(.*?)';/s.exec(meta) ?? /StreamTitle='(.*)'\s*$/s.exec(meta);
  const title = match?.[1]?.trim();
  return title ? title : null;
}

/**
 * iHeart's revma streams write `Artist - text="Song" song_spot="M" length="00:03:03" …`: the artist
 * before the dash, the song quoted in `text=`, and a `song_spot` that is "M" for music and "T" (and
 * friends) for station imaging. Ad markers come as ` - text="Spot Block End" …` or `adContext="…"`.
 */
const TAGGED = /^(.*?)\s*-\s*text="([^"]*)"(.*)$/s;
const AD_CONTEXT = /^adContext="/;
const ENTITIES: Record<string, string> = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>' };

function decodeEntities(value: string): string {
  return value.replace(/&(amp|apos|quot|lt|gt|#\d+|#x[0-9a-f]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function splitTagged(text: string): { artist: string | null; title: string } | null | undefined {
  if (AD_CONTEXT.test(text)) return null;
  // iHeart occasionally sends a second, key/value cue shape rather than "Artist - text=...".
  // A live F (fallback) cue was observed while the official song feed returned 204: do not
  // print its raw attributes as a song. Only an explicitly marked M cue may name one.
  if (/^title=\"/i.test(text)) {
    const cue = /^title="([^"]*)",artist="([^"]*)",url="song_spot="([^"]*)"/i.exec(text);
    if (!cue || cue[3]!.toUpperCase() !== 'M') return null;
    const title = decodeEntities(cue[1]!).trim();
    if (!/[\p{L}\p{N}]/u.test(title)) return null;
    return { title, artist: decodeEntities(cue[2]!).trim() || null };
  }
  const tagged = TAGGED.exec(text);
  if (!tagged) return undefined;
  const rest = tagged[3] ?? '';
  const spot = /\bsong_spot="([^"]*)"/.exec(rest)?.[1];
  // Without a song_spot an artist-less cue ("Spot Block End") is an ad marker; with one, only music counts.
  if (spot !== undefined ? spot.toUpperCase() !== 'M' : !tagged[1]!.trim()) return null;
  const title = decodeEntities(tagged[2]!).trim();
  const artist = decodeEntities(tagged[1]!).trim();
  if (!/[\p{L}\p{N}]/u.test(title)) return null;
  return { artist: artist || null, title };
}

/** "Artist - Title" as stations write it; a title with no spaced dash keeps no artist. */
export function splitOnAir(value: string): { artist: string | null; title: string } | null {
  const text = value.trim();
  // WGN transmits this literal cue during ad breaks; a cue is not a track or a programme.
  if (/^(?:[-–—]\s*)?(?:advertisement|commercial break|ad break)$/i.test(text)) return null;
  // A block of dashes or a lone separator is a station between songs, not a song.
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  const tagged = splitTagged(text);
  if (tagged !== undefined) return tagged;
  /* Stations pad a fixed-width field with the separator itself: WFMT sends
     " - Fiesta! with Elbio Barilari -  -  - " for a programme with no track. Splitting on the
     first dash alone made the padding the song and the programme the artist, so a dash standing
     on its own is dropped and only what the station actually wrote is read. A dash inside a word
     ("-M-") is left alone. */
  const fields = text
    .split(' - ')
    .map((f) => f.trim().replace(/^-+(?=\s)/, '').replace(/(?<=\s)-+$/, '').trim())
    .filter((f) => /[\p{L}\p{N}]/u.test(f));
  if (!fields.length) return null;
  if (fields.length === 1) return { artist: null, title: fields[0]! };
  return { artist: fields[0]!, title: fields.slice(1).join(' - ') };
}
