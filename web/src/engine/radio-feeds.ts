// Publisher feeds and schedules ported from the original Airwave player TRACK_FEEDS and Hub
// readCurrentProgramme. Only an exact broadcaster hostname/stream mount selects an adapter.
import { parseBroadcast, freshBroadcast, publicUrl, type Broadcast, type RadioStation } from './radio';
import { IHEART_HOSTS, readIheartProgrammeDetails } from './radio-schedule';
type GetText = (url: string) => Promise<string>;
const BBC = new Set(['bbc_radio_one', 'bbc_radio_two', 'bbc_radio_three', 'bbc_radio_fourfm', 'bbc_radio_fourlw', 'bbc_radio_five_live', 'bbc_6music', 'bbc_1xtra', 'bbc_radio_four_extra', 'bbc_asian_network', 'bbc_world_service']);
export function tritonCue(text: string, now = Date.now()): Broadcast | null {
  const prop = (block: string, name: string) => new RegExp(`name="${name}"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`).exec(block)?.[1]?.trim() || '';
  const items = text.match(/<nowplaying-info[\s\S]*?<\/nowplaying-info>/g) || [], head = items[0]; if (!head) return null;
  const title = prop(head, 'cue_title'), artist = prop(head, 'track_artist_name'), programme = prop(head, 'program_id'); if (!title) return null;
  let began = Number(prop(head, 'cue_time_start')); const duration = Number(prop(head, 'cue_time_duration')) / 1000;
  // Every ~12 s Triton republishes the SAME cue with a newer timestamp. The earliest identical cue
  // in an unbroken run is the actual start; otherwise the player is permanently near 0:00.
  for (const i of items.slice(1)) { if (prop(i, 'cue_title') !== title || prop(i, 'track_artist_name') !== artist || prop(i, 'program_id') !== programme) break; const t = Number(prop(i, 'cue_time_start')); if (t > 0 && (!began || t < began)) began = t; }
  const b = parseBroadcast(artist ? `${artist} - ${title}` : title, 'Triton official feed', now); return freshBroadcast({ ...b, startedAt: began > 0 ? began : null, duration: duration > 0 ? duration : null }, now);
}
export async function publisherBroadcast(s: RadioStation, get: GetText, now = Date.now()): Promise<Broadcast | null> {
  const u = new URL(s.url), host = u.hostname.toLowerCase(); const j = async (url: string) => JSON.parse(await get(url));
  let m: RegExpExecArray | null;
  if (/(^|\.)somafm\.com$/.test(host) && (m = /^\/([a-z0-9]+)-/i.exec(u.pathname))) {
    const x = (await j(`https://somafm.com/songs/${m[1]}.json`)).songs?.[0]; if (!x?.title) return null;
    return { ...parseBroadcast(x.artist ? `${x.artist} - ${x.title}` : x.title, 'SomaFM official feed', now), startedAt: Number(x.date) > 0 ? Number(x.date) * 1000 : null };
  }
  if (/(^|\.)(streamtheworld|tritondigital)\.com$/.test(host) && (m = /\/([A-Za-z0-9_]+?)(?:\.[a-z0-9]+)?$/.exec(u.pathname))) return tritonCue(await get(`https://np.tritondigital.com/public/nowplaying?mountName=${encodeURIComponent(m[1]!)}&numberToFetch=24&eventType=track`), now);
  if (/(^|\.)radio\.co$/.test(host) && (m = /\/(s[a-z0-9]+)\//i.exec(u.pathname))) {
    const x = await j(`https://public.radio.co/stations/${m[1]}/status`); return parseBroadcast(x.current_track?.title || null, 'radio.co official feed', now);
  }
  if (/(^|\.)revma\.ihrhls\.com$/.test(host) && (m = /^\/zc(\d{1,7})(?:\/|$)/.exec(u.pathname))) {
    try { const x = await j(`https://us.api.iheart.com/api/v3/live-meta/stream/${m[1]}/currentTrackMeta?defaultMetadata=true`); if (x?.title && !(Number(x.endTime) > 0 && now > x.endTime + 15000)) return { ...parseBroadcast(x.artist ? `${x.artist} - ${x.title}` : x.title, 'iHeart official feed', now), startedAt: x.startTime, duration: x.trackDuration || null, validUntil: x.endTime || null }; } catch { /* schedule is a separate, useful answer */ }
    const programme = await readIheartProgrammeDetails(s.url, async url => { if (!IHEART_HOSTS.includes(new URL(url).hostname)) throw Error('Untrusted schedule host'); return j(url); }, now);
    return programme ? { ...parseBroadcast(programme.title, 'iHeart official schedule', now), ...programme, kind: 'programme', artist: null } : null;
  }
  if (host === 'stream.live.vc.bbcmedia.co.uk' && BBC.has(u.pathname.slice(1))) {
    const id = u.pathname.slice(1), x = await j(`https://ess.api.bbci.co.uk/schedules?serviceId=${id}`); if (x.service?.id !== id || !Array.isArray(x.items)) return null;
    const item = x.items.find((r: { service?: { id?: string }; published_time?: { start?: string; end?: string } }) => r.service?.id === id && Date.parse(r.published_time?.start || '') <= now && Date.parse(r.published_time?.end || '') > now);
    const title = item?.brand?.title || item?.episode?.title; return title ? { ...parseBroadcast(title, 'BBC official schedule', now), title, kind: 'programme', artist: null, startedAt: Date.parse(item.published_time.start), duration: (Date.parse(item.published_time.end) - Date.parse(item.published_time.start)) / 1000, validUntil: Date.parse(item.published_time.end) } : null;
  }
  if (/(^|\.)radioparadise\.com$/.test(host)) { const x = await j('https://api.radioparadise.com/api/now_playing'); return parseBroadcast(x.artist && x.title ? `${x.artist} - ${x.title}` : null, 'Radio Paradise official feed', now); }
  if (host.endsWith('.kexp.org') || /(^|\.)kexp\.(?:streamguys1\.com)$/.test(host) || host.startsWith('kexp-') && host.endsWith('.streamguys1.com')) {
    const x = (await j('https://api.kexp.org/v2/plays/?limit=1&ordering=-airdate')).results?.[0]; if (!x || Date.parse(x.airdate || '') < now - 20 * 60000) return null;
    return { ...parseBroadcast(x.artist && x.song ? `${x.artist} - ${x.song}` : x.comment, 'KEXP official feed', now), startedAt: Date.parse(x.airdate) || null, artwork: typeof x.image_uri === 'string' && publicUrl(x.image_uri) ? x.image_uri : null };
  }
  return null;
}
export async function icecastBroadcast(s: RadioStation, get: GetText, now = Date.now()): Promise<Broadcast | null> {
  const u = new URL(s.url); const x = JSON.parse(await get(`${u.origin}/status-json.xsl`)); const raw = x.icestats?.source; const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  // Mount identity is mandatory. A different mount at the same server is another broadcast.
  const a = items.find((r: { listenurl?: string }) => { try { return new URL(r.listenurl || '').pathname.replace(/\/$/, '') === u.pathname.replace(/\/$/, ''); } catch { return false; } });
  if (!a) return null; const title = a.title || a.yp_currently_playing; return parseBroadcast(a.artist && title ? `${a.artist} - ${title}` : title, 'Icecast broadcaster feed', now);
}
