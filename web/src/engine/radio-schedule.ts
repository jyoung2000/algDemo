/**
 * What is on the air at an iHeart station, from iHeart's own published data — never guessed.
 *
 * An iHeart stream URL names its station (`stream.revma.ihrhls.com/zc841` is station 841). The
 * station's record (`us.api.iheart.com/api/v2/content/liveStations/841`) names its website
 * (`wgci.iheart.com`), and the website's on-air schedule (`webapi.radioedit.iheart.com/graphql`) says
 * which show is on now, with its start and stop. Only a show whose window contains `now` is returned.
 *
 * Pure apart from the injected `getJson`: the hub passes its host-limited HTTP client and the
 * companion's helper its guarded fetch, so both answer the same way and reach only these hosts.
 */

export const IHEART_API_HOST = 'us.api.iheart.com';
export const IHEART_SCHEDULE_HOST = 'webapi.radioedit.iheart.com';
export const IHEART_HOSTS: readonly string[] = [IHEART_API_HOST, IHEART_SCHEDULE_HOST];

const STREAM = /^https?:\/\/(?:stream|cloud)\.revma\.ihrhls\.com\/zc(\d{1,7})(?:[/?#]|$)/i;
const SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.iheart\.com$/;

/** The iHeart station id in a revma stream URL, or null for any other stream. */
export function iheartStationId(stream: string): string | null {
  let url: URL;
  try { url = new URL(stream); } catch { return null; }
  if (url.username || url.password || url.port) return null;
  return STREAM.exec(`${url.protocol}//${url.hostname}${url.pathname}`)?.[1] ?? null;
}

export type GetJson = (url: string) => Promise<unknown>;

const sites = new Map<string, { at: number; host: string | null }>();
const SITE_TTL_MS = 6 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function siteFor(id: string, getJson: GetJson, now: number): Promise<string | null> {
  const hit = sites.get(id);
  if (hit && now - hit.at < SITE_TTL_MS) return hit.host;
  const body = record(await getJson(`https://${IHEART_API_HOST}/api/v2/content/liveStations/${id}`));
  const station = record(Array.isArray(body?.hits) ? body!.hits[0] : null);
  const website = typeof station?.website === 'string' ? station.website.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
  const host = String(station?.id ?? '') === id && SITE.test(website) ? website : null;
  if (sites.size >= 500) sites.delete(sites.keys().next().value!);
  sites.set(id, { at: now, host });
  return host;
}

const QUERY = 'query($host:String!){sites{find(type:HOSTNAME,value:$host){onAirSchedule{current{name startMs stopMs}}}}}';

/** The show on the air now at the iHeart station this stream belongs to, or null. Never throws. */
export async function readIheartProgrammeDetails(stream: string, getJson: GetJson, now: number): Promise<{ title: string; startedAt: number; duration: number; validUntil: number } | null> {
  const id = iheartStationId(stream);
  if (!id) return null;
  try {
    const host = await siteFor(id, getJson, now);
    if (!host) return null;
    const url = `https://${IHEART_SCHEDULE_HOST}/graphql?query=${encodeURIComponent(QUERY)}&variables=${encodeURIComponent(JSON.stringify({ host }))}`;
    const body = record(await getJson(url));
    const current = record(record(record(record(record(body?.data)?.sites)?.find)?.onAirSchedule)?.current);
    const name = typeof current?.name === 'string' ? current.name.trim() : '';
    const start = typeof current?.startMs === 'number' ? current.startMs : NaN;
    const stop = typeof current?.stopMs === 'number' ? current.stopMs : NaN;
    if (!name || name.length > 300 || !(start <= now && now < stop)) return null;
    return { title: name, startedAt: start, duration: (stop - start) / 1000, validUntil: stop };
  } catch {
    // A schedule that cannot be read must never erase the station's own song title.
    return null;
  }
}

/** Tests only: forget the station → website answers. */
export function resetIheartSiteCache(): void {
  sites.clear();
}

/** Compatibility for callers that need only the published title. */
export async function readIheartProgramme(stream: string, getJson: GetJson, now: number): Promise<string | null> {
  return (await readIheartProgrammeDetails(stream, getJson, now))?.title ?? null;
}
