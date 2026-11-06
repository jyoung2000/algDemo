import { describe, expect, it } from 'vitest';
import { InternetArchive, parseArchiveItem } from './internet-archive';
import { Http, type HttpPort, type HttpRequest } from './net';
import { matchRecordings } from './identity';

// Trimmed from live /metadata/cold-funk-by-kevin-macleod. A declared CC license is
// required; a public IA upload with no license must not become a local download.
const item = {
  metadata: { mediatype: 'audio', identifier: 'cold-funk-by-kevin-macleod',
    title: 'cold-funk-by-kevin-macleod', creator: 'Kevin MacLeod',
    licenseurl: 'https://creativecommons.org/licenses/by-nd/4.0/' },
  files: [
    { name: 'cold-funk-by-kevin-macleod.mp3', size: '11690184', length: '288.29', format: 'VBR MP3', source: 'original' },
    { name: 'cold-funk-by-kevin-macleod.ogg', size: '3388915', length: '288.29', source: 'derivative' },
  ],
};
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

describe('licensed Internet Archive item', () => {
  it('selects one original, full-length audio file with a direct download URL', () => {
    const [t] = parseArchiveItem(item, 'cold-funk-by-kevin-macleod');
    expect(t).toMatchObject({ provider: 'archive', title: 'cold funk', artists: ['Kevin MacLeod'], duration: 288,
      preview: null, url: 'https://archive.org/download/cold-funk-by-kevin-macleod/cold-funk-by-kevin-macleod.mp3' });
    expect(matchRecordings({ title: 'Cold Funk', artists: ['Kevin MacLeod'], duration: 288 }, t! ).verdict).toBe('same');
  });
  it('rejects unlicensed, non-audio, misleading, oversized or partial files', () => {
    expect(parseArchiveItem({ ...item, metadata: { ...item.metadata, licenseurl: undefined } }, item.metadata.identifier)).toEqual([]);
    expect(parseArchiveItem({ ...item, metadata: { ...item.metadata, licenseurl: 'https://evil.example/cc-by' } }, item.metadata.identifier)).toEqual([]);
    expect(parseArchiveItem({ ...item, metadata: { ...item.metadata, mediatype: 'movies' } }, item.metadata.identifier)).toEqual([]);
    expect(parseArchiveItem({ ...item, metadata: { ...item.metadata, identifier: 'other-id' } }, item.metadata.identifier)).toEqual([]);
    for (const file of [
      { name: 'preview.mp3', size: '1000000', length: '30', source: 'original' },
      { name: '../secret.mp3', size: '2000000', length: '288.29', source: 'original' },
      { name: 'song%2F.mp3', size: '2000000', length: '288.29', source: 'original' },
      { name: 'song.mp3', size: '1000000000', length: '288.29', source: 'original' },
      { name: 'song.zip', size: '1000000', length: '288.29', source: 'original' },
      { name: 'song.mp3', size: '1000000', length: undefined, source: 'original' },
      { name: 'song.mp3', size: '1000000', length: '288.29', source: 'original', private: true },
    ]) expect(parseArchiveItem({ ...item, files: [file] }, item.metadata.identifier)).toEqual([]);
  });
  it('rejects malformed responses and catalogues that are not individual songs', () => {
    expect(parseArchiveItem({}, 'cold-funk-by-kevin-macleod')).toEqual([]);
    expect(parseArchiveItem({ ...item, files: [...item.files, { name: 'other.mp3', size: '3000000', length: '200', source: 'original' }] }, item.metadata.identifier)).toEqual([]);
  });
});

describe('InternetArchive.search', () => {
  it('searches only licensed audio and resolves bounded item metadata', async () => {
    const seen: HttpRequest[] = [];
    const port: HttpPort = { async request(req) {
      seen.push(req);
      if (req.url.includes('/metadata/')) return { status: 200, headers: {}, body: enc(item) };
      return { status: 200, headers: {}, body: enc({ response: { docs: [{ identifier: item.metadata.identifier }] } }) };
    } };
    const found = await new InternetArchive(new Http(port)).search('Cold Funk', 5);
    expect(found).toHaveLength(1);
    const q = new URL(seen[0]!.url);
    expect(q.host).toBe('archive.org');
    expect(q.pathname).toBe('/advancedsearch.php');
    expect(q.searchParams.get('q')).toContain('licenseurl:');
    expect(q.searchParams.get('q')).toContain('mediatype:audio');
    expect(new URL(seen[1]!.url).pathname).toBe('/metadata/cold-funk-by-kevin-macleod');
  });
});
