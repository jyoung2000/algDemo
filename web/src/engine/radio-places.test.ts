// @vitest-environment happy-dom
// RADIO-PLACES-001 (owner, 2026-11-19): "in the radio tab under anywhere let the user type and save a location,
// address, or city to filter the radio list for only those locations, let users select multiple locations at
// once ... and ensure their choices persist with the app opening and closing".
import { beforeEach, describe, expect, it } from 'vitest';
import { RadioDirectory, type RadioStation } from './radio';
import { geocodePlace, placeFromGeocode, readPlaces, savePlaces, stationInPlace, type RadioPlace } from './radio-places';

const naperville = { lat: '41.7728699', lon: '-88.1479278', addresstype: 'city', display_name: 'Naperville, Naperville Township, DuPage County, Illinois, United States', name: 'Naperville',
  address: { city: 'Naperville', county: 'DuPage County', state: 'Illinois', country: 'United States', country_code: 'us' }, boundingbox: ['41.6662862', '41.8219910', '-88.2353456', '-88.0885106'] };
const illinois = { lat: '40.0796606', lon: '-89.4337288', addresstype: 'state', name: 'Illinois', display_name: 'Illinois, United States', address: { state: 'Illinois', country: 'United States', country_code: 'us' }, boundingbox: ['36.97', '42.51', '-91.51', '-87.01'] };
const canada = { lat: '61.06', lon: '-107.99', addresstype: 'country', name: 'Canada', display_name: 'Canada', address: { country: 'Canada', country_code: 'ca' }, boundingbox: ['41.6', '83.3', '-141', '-52.3'] };
const street = { lat: '41.8789', lon: '-87.6359', addresstype: 'road', name: 'West Jackson Boulevard', display_name: '233 South Wacker Drive, Loop, Chicago, Cook County, Illinois, 60606, United States',
  address: { house_number: '233', road: 'South Wacker Drive', city: 'Chicago', state: 'Illinois', country_code: 'us' }, boundingbox: ['41.8788', '41.8790', '-87.6360', '-87.6358'] };

const st = (o: Partial<RadioStation>): RadioStation => ({ id: 'x', name: 'X FM', url: 'https://x.example/live', homepage: '', image: '', country: 'The United States Of America', countryCode: 'US', region: '', language: 'english', tags: [], codec: 'MP3', bitrate: 128, latitude: null, longitude: null, ...o });

describe('turning what the listener typed into a place', () => {
  it('a city is an area around it, named by its own name and region', () => {
    const p = placeFromGeocode(naperville, 'naperville')!;
    expect(p.kind).toBe('area');
    expect(p.label).toBe('Naperville, Illinois');
    expect(p.countryCode).toBe('US');
    expect(p.city).toBe('Naperville');
    expect(p.lat).toBeCloseTo(41.77, 2);
    expect(p.radiusKm).toBeGreaterThanOrEqual(25);
    expect(p.radiusKm).toBeLessThanOrEqual(60);
    expect(p.selected).toBe(true);
  });
  it('an address is a small area around its city', () => {
    const p = placeFromGeocode(street, '233 S Wacker Dr, Chicago')!;
    expect(p.kind).toBe('area');
    expect(p.label).toBe('233 South Wacker Drive, Chicago');
    expect(p.city).toBe('Chicago');
    expect(p.radiusKm).toBe(25);
  });
  it('a state is a region, a country is a country', () => {
    expect(placeFromGeocode(illinois, 'illinois')).toMatchObject({ kind: 'region', region: 'Illinois', countryCode: 'US', label: 'Illinois, United States' });
    expect(placeFromGeocode(canada, 'canada')).toMatchObject({ kind: 'country', countryCode: 'CA', label: 'Canada' });
  });
  it('nothing found is nothing', () => {
    expect(placeFromGeocode(undefined, 'zzqx')).toBeNull();
    expect(placeFromGeocode({ lat: 'x', lon: 'y' }, 'zzqx')).toBeNull();
  });
  it('asks OpenStreetMap once, in English, for the first match', async () => {
    const seen: string[] = [];
    const p = await geocodePlace('Naperville, IL', async (u) => { seen.push(u); return JSON.stringify([naperville]); });
    expect(p?.label).toBe('Naperville, Illinois');
    const u = new URL(seen[0]!);
    expect(u.host).toBe('nominatim.openstreetmap.org');
    expect(u.searchParams.get('q')).toBe('Naperville, IL');
    expect(u.searchParams.get('limit')).toBe('1');
    expect(u.searchParams.get('accept-language')).toBe('en');
    expect(await geocodePlace('zzqx', async () => '[]')).toBeNull();
    expect(await geocodePlace('  ', async () => { throw new Error('should not ask'); })).toBeNull();
  });
});

describe('which stations belong to a place', () => {
  const city = placeFromGeocode(naperville, 'naperville')!;
  it('a station with coordinates inside the area; one far away is not', () => {
    expect(stationInPlace(st({ latitude: 41.85, longitude: -88.05 }), city)).toBe(true);
    expect(stationInPlace(st({ latitude: 34.05, longitude: -118.24, region: 'California' }), city)).toBe(false);
  });
  it('a station without coordinates that names the city or region', () => {
    expect(stationInPlace(st({ region: 'Naperville, IL' }), city)).toBe(true);
    expect(stationInPlace(st({ region: 'Ohio' }), city)).toBe(false);
    expect(stationInPlace(st({ region: 'Illinois' }), placeFromGeocode(illinois, 'il')!)).toBe(true);
    expect(stationInPlace(st({ countryCode: 'CA' }), placeFromGeocode(canada, 'ca')!)).toBe(true);
    expect(stationInPlace(st({ countryCode: 'US' }), placeFromGeocode(canada, 'ca')!)).toBe(false);
  });
});

describe('saved places', () => {
  beforeEach(() => localStorage.clear());
  it('keep their choices when the app is closed and opened again', () => {
    const a = placeFromGeocode(naperville, 'naperville')!;
    const b = { ...placeFromGeocode(canada, 'canada')!, selected: false };
    savePlaces([a, b]);
    const back = readPlaces();
    expect(back.map((p) => [p.label, p.selected])).toEqual([['Naperville, Illinois', true], ['Canada', false]]);
  });
  it('unreadable storage is no places, not an error', () => {
    localStorage.setItem('airwave:radio-places', '{nope');
    expect(readPlaces()).toEqual([]);
    localStorage.setItem('airwave:radio-places', JSON.stringify([{ label: 'bad' }, null]));
    expect(readPlaces()).toEqual([]);
  });
});

describe('the station list for chosen places', () => {
  const raw = (id: string, o: Record<string, unknown> = {}) => ({ stationuuid: id, name: `Station ${id}`, url_resolved: `https://s${id}.example/live`, countrycode: 'US', state: 'Illinois', ...o });
  it('asks the directory once per place (distance, the place named as the station location, region, country) and merges them', async () => {
    const asked: URL[] = [];
    const d = new RadioDirectory(async (u) => {
      const url = new URL(u); asked.push(url);
      const p = url.searchParams;
      if (p.get('geo_lat')) return JSON.stringify([raw('near1'), raw('near2'), raw('both')]);
      if (p.get('state') === 'Naperville') return JSON.stringify([raw('named'), raw('both')]);
      if (p.get('countrycode') === 'CA') return JSON.stringify([raw('ca1', { countrycode: 'CA', state: '' })]);
      return '[]';
    });
    const places: RadioPlace[] = [placeFromGeocode(naperville, 'naperville')!, placeFromGeocode(canada, 'canada')!];
    const r = await d.page({ places, offset: 0 });
    const ids = r.stations.map((s) => s.id);
    expect(new Set(ids)).toEqual(new Set(['near1', 'near2', 'both', 'named', 'ca1']));
    expect(ids.filter((x) => x === 'both')).toHaveLength(1);
    // Each place is represented near the top, not one place's whole list first.
    expect(ids.slice(0, 3)).toContain('ca1');
    const geo = asked.find((u) => u.searchParams.get('geo_lat'))!;
    expect(Number(geo.searchParams.get('geo_lat'))).toBeCloseTo(41.77, 2);
    expect(Number(geo.searchParams.get('geo_distance'))).toBeGreaterThanOrEqual(25000);
    expect(asked.some((u) => u.searchParams.get('countrycode') === 'CA')).toBe(true);
    // A chosen place replaces the single-country filter.
    expect(asked.every((u) => !u.searchParams.get('countrycode') || u.searchParams.get('countrycode') === 'CA' || u.searchParams.get('countrycode') === 'US')).toBe(true);
  });
  it('a region asks for stations in that state of that country', async () => {
    const asked: URL[] = [];
    const d = new RadioDirectory(async (u) => { asked.push(new URL(u)); return '[]'; });
    await d.page({ places: [placeFromGeocode(illinois, 'il')!], offset: 0, tag: 'jazz' });
    expect(asked.some((u) => u.searchParams.get('state') === 'Illinois' && u.searchParams.get('countrycode') === 'US' && u.searchParams.get('tag') === 'jazz')).toBe(true);
  });
});
