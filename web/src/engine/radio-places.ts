/**
 * RADIO-PLACES-001 (owner, 2026-11-19): "in the radio tab under anywhere let the user type and save a location,
 * address, or city to filter the radio list for only those locations, let users select multiple locations at
 * once to filter their radio list and ensure their choices persist with the app opening and closing".
 *
 * What the listener types is looked up once on OpenStreetMap (Nominatim) when they save it; the saved place
 * keeps its coordinates, so filtering never asks again. A city or address is an area around it (stations with
 * coordinates inside it, or whose location names the city); a state or province is a region; a country is a
 * country. Places and which of them are chosen live in localStorage, which both apps keep across restarts.
 */
export interface RadioPlace {
  id: string;
  /** What the list shows: "Naperville, Illinois", "233 South Wacker Drive, Chicago", "Canada". */
  label: string;
  /** What the listener typed. */
  query: string;
  kind: 'area' | 'region' | 'country';
  lat: number;
  lon: number;
  radiusKm: number;
  countryCode: string;
  region: string;
  city: string;
  selected: boolean;
}

const STORE = 'airwave:radio-places';
export const PLACES_MAX = 24;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

type Geo = { lat?: unknown; lon?: unknown; addresstype?: unknown; type?: unknown; name?: unknown; display_name?: unknown; address?: Record<string, unknown>; boundingbox?: unknown };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Great-circle distance in km. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const REGION_TYPES = new Set(['state', 'province', 'region', 'state_district']);
const COUNTRY_TYPES = new Set(['country']);

/** One Nominatim answer as a place, or null when it is not one. */
export function placeFromGeocode(g: Geo | undefined | null, query: string): RadioPlace | null {
  if (!g) return null;
  const lat = Number(g.lat), lon = Number(g.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const a = g.address ?? {};
  const type = str(g.addresstype) || str(g.type);
  const countryCode = str(a['country_code']).toUpperCase();
  const region = str(a['state']) || str(a['province']) || str(a['region']);
  const city = str(a['city']) || str(a['town']) || str(a['village']) || str(a['municipality']) || str(a['hamlet']) || str(a['suburb']);
  const country = str(a['country']);
  const kind: RadioPlace['kind'] = COUNTRY_TYPES.has(type) ? 'country' : REGION_TYPES.has(type) ? 'region' : 'area';
  let label: string;
  if (kind === 'country') label = country || str(g.name) || query;
  else if (kind === 'region') label = [region || str(g.name), country].filter(Boolean).join(', ');
  else {
    const street = [str(a['house_number']), str(a['road'])].filter(Boolean).join(' ');
    const head = street || city || str(g.name) || query;
    label = [head, street ? city || region : region].filter(Boolean).join(', ');
  }
  // An area reaches its own edge plus 25 km: a city's suburbs are part of it. Bounded so a county is not a state.
  let radiusKm = 25;
  if (kind === 'area' && Array.isArray(g.boundingbox) && g.boundingbox.length === 4) {
    const [s, n, w, e] = (g.boundingbox as unknown[]).map(Number) as [number, number, number, number];
    if ([s, n, w, e].every(Number.isFinite)) radiusKm = Math.round(Math.min(80, Math.max(25, distanceKm(s, w, n, e) / 2 + 25)));
  }
  if (kind !== 'area') radiusKm = 0;
  const id = `${kind}:${countryCode}:${(kind === 'country' ? countryCode : kind === 'region' ? region : `${lat.toFixed(3)},${lon.toFixed(3)}`).toLowerCase()}`;
  return { id, label: label || query, query, kind, lat, lon, radiusKm, countryCode, region, city, selected: true };
}

/** Look up what the listener typed; null when nothing matches. One request, made only when they save it. */
export async function geocodePlace(query: string, request: (url: string) => Promise<string>): Promise<RadioPlace | null> {
  const q = query.trim().slice(0, 200);
  if (!q) return null;
  const url = `${NOMINATIM}?${new URLSearchParams({ format: 'jsonv2', limit: '1', addressdetails: '1', 'accept-language': 'en', q })}`;
  const data = JSON.parse(await request(url)) as unknown;
  return Array.isArray(data) ? placeFromGeocode(data[0] as Geo, q) : null;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const names = (text: string, name: string) => !!name && ` ${norm(text)} `.includes(` ${norm(name)} `);

/** Whether a station belongs to a place: by its coordinates when it has them, else by the location it names. */
export function stationInPlace(s: { countryCode: string; region: string; latitude: number | null; longitude: number | null }, p: RadioPlace): boolean {
  const cc = (s.countryCode || '').toUpperCase();
  if (p.kind === 'country') return cc === p.countryCode;
  if (p.countryCode && cc && cc !== p.countryCode) return false;
  if (p.kind === 'region') return names(s.region, p.region);
  const hasGeo = typeof s.latitude === 'number' && typeof s.longitude === 'number' && Number.isFinite(s.latitude) && Number.isFinite(s.longitude) && !(s.latitude === 0 && s.longitude === 0);
  if (hasGeo) return distanceKm(p.lat, p.lon, s.latitude!, s.longitude!) <= p.radiusKm;
  return names(s.region, p.city);
}

const valid = (p: unknown): p is RadioPlace => {
  const x = p as RadioPlace | null;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.label === 'string' && ['area', 'region', 'country'].includes(x.kind)
    && Number.isFinite(x.lat) && Number.isFinite(x.lon) && typeof x.countryCode === 'string';
};

export function readPlaces(): RadioPlace[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || '[]') as unknown;
    return Array.isArray(v) ? v.filter(valid).slice(0, PLACES_MAX).map((p) => ({ ...p, region: p.region ?? '', city: p.city ?? '', query: p.query ?? p.label, radiusKm: Number(p.radiusKm) || 0, selected: p.selected !== false })) : [];
  } catch { return []; }
}

export function savePlaces(list: RadioPlace[]): RadioPlace[] {
  const out = list.slice(0, PLACES_MAX);
  try { localStorage.setItem(STORE, JSON.stringify(out)); } catch { /* storage full or blocked: this session still has them */ }
  return out;
}
