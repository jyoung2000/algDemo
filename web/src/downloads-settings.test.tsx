// @vitest-environment happy-dom
// FOLDER-IMPORT-001: pure logic of the Settings Downloads section — folder-to-playlist mapping,
// and the honest fallbacks when the Electron folders bridge is absent (browser, Android WebView).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  DownloadsSettings,
  folderPlaylist,
  folderPlaylistName,
  foldersAvailable,
  importedTrack,
  type ImportedSong,
} from './DownloadsSettings';
import type { Downloads } from './Downloads';

const song = (over: Partial<ImportedSong> = {}): ImportedSong => ({
  url: 'imported:C:\\Music\\Road Trip\\Daft Punk - One More Time.mp3',
  path: 'C:\\Music\\Road Trip\\Daft Punk - One More Time.mp3',
  name: 'Daft Punk - One More Time.mp3',
  title: 'One More Time',
  artist: 'Daft Punk',
  bytes: 4,
  ...over,
});

/** A quiet downloads hook for the hosted DownloadsView: nothing on, nothing running. */
const noDownloads = {
  on: false, jobs: [], refresh: () => {}, format: 'original', setFormat: () => {},
  start: async () => null, downloadTrack: async () => false, trackState: () => 'idle', activeCount: 0,
} as unknown as Downloads;

type NativeWindow = { AirwaveNative?: unknown; __awFolders?: (id: number, json: string) => void };
const win = window as unknown as NativeWindow;

afterEach(() => {
  cleanup();
  delete win.AirwaveNative;
});

describe('folder-to-playlist mapping', () => {
  it('names the playlist after the folder, on either slash style', () => {
    expect(folderPlaylistName('C:\\Music\\Road Trip')).toBe('Road Trip');
    expect(folderPlaylistName('C:\\Music\\Road Trip\\')).toBe('Road Trip');
    expect(folderPlaylistName('/home/u/Jazz')).toBe('Jazz');
    expect(folderPlaylistName('/home/u/Jazz/')).toBe('Jazz');
  });

  it('maps one folder of files to one playlist of imported tracks', () => {
    const songs = [song(), song({ url: 'imported:C:\\Music\\Road Trip\\02 - Africa.opus', path: 'C:\\Music\\Road Trip\\02 - Africa.opus', name: '02 - Africa.opus', title: 'Africa', artist: '' })];
    const { name, tracks } = folderPlaylist('C:\\Music\\Road Trip', songs);
    expect(name).toBe('Road Trip');
    expect(tracks).toHaveLength(2);
    expect(tracks.every((t) => String(t.provider) === 'imported')).toBe(true);
    // The opaque imported link rides in track.url — it is what the deck will ask the shell for.
    expect(tracks[0]!.url).toBe(songs[0]!.url);
    expect(tracks[0]!.title).toBe('One More Time');
    expect(tracks[0]!.artists).toEqual(['Daft Punk']);
    // Every track gets the engine's usual identity so playlists and the queue can hold it.
    expect(tracks[0]!.key).toBeTruthy();
    expect(tracks[0]!.id).toContain('imported:');
    // A file with no artist in its name claims none, honestly.
    expect(tracks[1]!.artists).toEqual([]);
    expect(tracks[1]!.duration).toBeNull();
  });

  it('falls back to the file name when nothing better was derived', () => {
    const t = importedTrack(song({ title: '', artist: '' }));
    expect(t.title).toBe('Daft Punk - One More Time.mp3');
  });
});

describe('bridge-absent fallback', () => {
  it('reports no folders bridge in a plain browser and says the section needs the Windows app', () => {
    expect(foldersAvailable()).toBe(false);
    render(<DownloadsSettings downloads={noDownloads} />);
    expect(screen.getByText(/needs the Windows app/i)).toBeTruthy();
    expect(screen.queryByText(/Import music folders/)).toBeNull();
  });

  it('on Android (downloads bridge, no folders bridge) says folder import is Windows-only for now', () => {
    win.AirwaveNative = { downloads: () => {} };
    expect(foldersAvailable()).toBe(false);
    render(<DownloadsSettings downloads={{ ...noDownloads, on: true } as unknown as Downloads} />);
    expect(screen.getByText(/available in the Windows app for now/i)).toBeTruthy();
    expect(screen.queryByText(/Import music folders/)).toBeNull();
  });

  it('with the folders bridge present it offers the import button and reads the folder list', async () => {
    win.AirwaveNative = {
      downloads: () => {},
      folders: (id: number, json: string) => {
        const req = JSON.parse(json) as { op: string };
        const out = req.op === 'list' ? { folders: [{ folder: 'C:\\Music\\Road Trip', name: 'Road Trip', present: true }] } : {};
        setTimeout(() => win.__awFolders?.(id, JSON.stringify(out)), 0);
      },
    };
    expect(foldersAvailable()).toBe(true);
    render(<DownloadsSettings downloads={noDownloads} />);
    expect(screen.getByRole('button', { name: /Import music folders/ })).toBeTruthy();
    expect(await screen.findByText('Road Trip')).toBeTruthy();
    expect(screen.getByText('C:\\Music\\Road Trip')).toBeTruthy();
  });
});
