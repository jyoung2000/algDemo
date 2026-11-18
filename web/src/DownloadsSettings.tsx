import React from 'react';
import { api, type Track } from './api';
import { DownloadsView, type Downloads } from './Downloads';
import { downloadsAvailable } from './engine/downloads';
import { makeTrack } from './engine/track';
import './downloads-settings.css';

/**
 * FOLDER-IMPORT-001: the Settings "Downloads" section.
 *
 * Hosts the download queue and kept-music folder controls (moved here from the old Downloads tab,
 * nothing lost), plus importing the user's own music folders as saved playlists: one playlist per
 * folder, named after the folder, each song playable as a full local file on the app's own deck
 * through the same local-audio path downloaded songs use. The folder list lives with the Windows
 * shell (userData/imported-folders.json), so it survives restarts; the playlists live in the
 * engine's own store like any other saved list.
 */

/** What the Windows shell reports for one audio file found in an imported folder. */
export interface ImportedSong {
  /** Opaque playback link: `imported:<absolute path>`. The page never parses it. */
  url: string;
  path: string;
  name: string;
  title: string;
  artist: string;
  bytes: number;
  /** IMPORT-GENRES-001: the genre word(s) the file's own tags state, when the scan found any. */
  genre?: string;
}

export interface ImportedFolder {
  folder: string;
  name: string;
  /** False when the folder has since vanished from disk; its songs cannot play until it is back. */
  present: boolean;
}

// ---- pure logic (unit-tested in downloads-settings.test.tsx) ---------------------------------

/** The playlist name a folder gets: its own name, on either slash style, ignoring trailing slashes. */
export function folderPlaylistName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || folder;
}

/**
 * One scanned file as a track the engine can store, queue and play. IMPORT-GENRES-001: it starts
 * with no genres and no cover; once it is saved in a list the engine looks it up in the background
 * (a confident title-plus-artist match only) and keeps what it finds on the list's copy. The file's
 * own genre word rides along as `file_genre`, used only after such a match confirms the song.
 */
export function importedTrack(song: ImportedSong): Track {
  const genre = typeof song.genre === 'string' ? song.genre.trim().slice(0, 100) : '';
  return makeTrack({
    provider: 'imported',
    platformId: song.path,
    title: song.title || song.name,
    artists: song.artist ? [song.artist] : [],
    url: song.url,
    kind: 'song',
    ...(genre ? { extra: { file_genre: genre } } : {}),
  }) as unknown as Track;
}

/** FOLDER-IMPORT-001: one folder of files -> one saved playlist named after the folder. */
export function folderPlaylist(folder: string, songs: readonly ImportedSong[]): { name: string; tracks: Track[] } {
  return { name: folderPlaylistName(folder), tracks: songs.map(importedTrack) };
}

// ---- the Windows shell's folders bridge ------------------------------------------------------

type FoldersNative = { folders?: (id: number, json: string) => void };

declare global {
  interface Window {
    __awFolders?: (id: number, json: string) => void;
  }
}

const native = (): FoldersNative | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as { AirwaveNative?: FoldersNative }).AirwaveNative;

/**
 * True only in the Windows app. Android's WebView has the downloads bridge but no folders bridge,
 * so the section says so honestly instead of pretending a picker exists.
 */
export const foldersAvailable = (): boolean => typeof native()?.folders === 'function';

const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 1;

function install(): void {
  window.__awFolders = (id, json) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    clearTimeout(w.timer);
    try {
      const out = JSON.parse(json) as { error?: string };
      if (out.error) w.no(new Error(out.error));
      else w.ok(out);
    } catch (e) {
      w.no(e as Error);
    }
  };
}

function call<T>(payload: Record<string, unknown>, waitMs = 120_000): Promise<T> {
  const n = native();
  if (!n?.folders) return Promise.reject(new Error('Folder import is only available in the Windows app.'));
  if (!window.__awFolders) install();
  return new Promise<T>((resolve, reject) => {
    const id = seq++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('The app did not answer.'));
    }, waitMs);
    waiting.set(id, { ok: resolve as (v: unknown) => void, no: reject, timer });
    n.folders!(id, JSON.stringify(payload));
  });
}

export const folderBridge = {
  pick: () => call<{ folders: string[] }>({ op: 'pick' }, 300_000),
  importFolder: (folder: string) => call<{ folder: string; name: string; songs: ImportedSong[] }>({ op: 'import', folder }, 300_000),
  rescan: (folder: string) => call<{ folder: string; name: string; songs: ImportedSong[] }>({ op: 'rescan', folder }, 300_000),
  list: () => call<{ folders: ImportedFolder[] }>({ op: 'list' }),
  remove: (folder: string) => call<{ ok: boolean; folders: string[] }>({ op: 'remove', folder }),
};

/**
 * Register imported songs with the engine's source chain (POST /api/import/local), so playing one
 * resolves straight to its own file. The engine runs in this page (or in the Android service, which
 * never has a folders bridge today), so this follows api.ts's local-engine path.
 */
async function registerImported(tracks: readonly Track[]): Promise<number> {
  if (!tracks.length) return 0;
  const { startLocal } = await import('./engine/runtime');
  const local = await startLocal();
  const r = await local.handle('POST', '/api/import/local', { songs: tracks as unknown } as never);
  if (r.status < 200 || r.status >= 300) throw new Error('The imported songs could not be registered for playback.');
  return Number((r.body as { registered?: number })?.registered ?? 0);
}

// ---- the section -----------------------------------------------------------------------------

export function DownloadsSettings({ downloads }: { downloads: Downloads }) {
  const canImport = foldersAvailable();
  const inShell = downloadsAvailable();
  const [folders, setFolders] = React.useState<ImportedFolder[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notes, setNotes] = React.useState<string[]>([]);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!canImport) return;
    let live = true;
    void (async () => {
      try {
        const r = await folderBridge.list();
        if (!live) return;
        setFolders(r.folders);
        // Quietly re-register every folder's songs: playback answers live in an LRU cache, so a
        // long-lived install re-primes them whenever Settings opens. Failures stay silent here —
        // playing a song that lost its registration reports its own honest error.
        for (const f of r.folders) {
          if (!f.present) continue;
          try {
            const scan = await folderBridge.rescan(f.folder);
            await registerImported(folderPlaylist(scan.folder, scan.songs).tracks);
          } catch {
            /* re-registration is best-effort */
          }
        }
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [canImport]);

  async function importFolders() {
    setBusy(true);
    setErr(null);
    setNotes([]);
    const said: string[] = [];
    try {
      const picked = await folderBridge.pick();
      for (const folder of picked.folders) {
        const r = await folderBridge.importFolder(folder);
        const { name, tracks } = folderPlaylist(r.folder, r.songs);
        if (!tracks.length) {
          await folderBridge.remove(r.folder).catch(() => undefined);
          said.push(`“${name}” holds no audio files this app can play; it was not imported.`);
          continue;
        }
        await registerImported(tracks);
        try {
          await api.playlistEdit('create', { name, tracks });
          said.push(`Imported “${name}”: ${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} as a saved playlist.${tracks.length > 500 ? ' The playlist keeps the first 500.' : ''}`);
        } catch (e) {
          // Usually "You already have a list called …": the songs are registered and playable either way.
          said.push(`“${name}”: ${(e as Error).message} Its ${tracks.length} songs were re-registered for playback.`);
        }
      }
      if (!picked.folders.length) said.push('No folder was chosen.');
      const r = await folderBridge.list();
      setFolders(r.folders);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setNotes(said);
      setBusy(false);
    }
  }

  async function removeFolder(folder: ImportedFolder) {
    setErr(null);
    try {
      await folderBridge.remove(folder.folder);
      const r = await folderBridge.list();
      setFolders(r.folders);
      setNotes([`Removed “${folder.name}” from the imported folders. Its saved playlist stays, but those songs cannot play until the folder is imported again.`]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      {/* The download queue, tools and kept-music folder — the old Downloads tab's content, now here. */}
      <DownloadsView d={downloads} />
      <section className="card dlf" aria-labelledby="dlf-h">
        <h2 id="dlf-h">Local music folders</h2>
        {canImport ? (
          <>
            <p className="note">
              Import folders of your own music as saved playlists: one playlist per folder, named
              after the folder. The songs play as full local files from where they are — nothing is
              copied, so keep the folder in place.
            </p>
            <div className="dlf__actions">
              <button className="push push--default" type="button" disabled={busy} onClick={() => void importFolders()}>
                {busy ? 'Importing…' : 'Import music folders…'}
              </button>
            </div>
            {folders === null ? (
              <p className="note">Reading the imported folder list…</p>
            ) : folders.length === 0 ? (
              <p className="empty">No folders imported yet.</p>
            ) : (
              <ul className="dlf__list" aria-label="Imported folders">
                {folders.map((f) => (
                  <li key={f.folder} className="dlf__row">
                    <span className="dlf__text">
                      <span className="dlf__name">{f.name}</span>
                      <span className="dlf__path" title={f.folder}>{f.folder}</span>
                      {!f.present && <span className="dlf__warn" role="status">This folder is missing from disk; its songs cannot play until it is back.</span>}
                    </span>
                    <button className="push" type="button" onClick={() => void removeFolder(f)} aria-label={`Stop importing ${f.name}`}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="note">
            {inShell
              ? 'Importing local music folders is available in the Windows app for now. This Android build will get it in a later update.'
              : 'Importing local music folders needs the Windows app. This page is running in a browser.'}
          </p>
        )}
        {notes.map((n) => (
          <p key={n} className="note" role="status">{n}</p>
        ))}
        {err && <p className="note note--bad" role="alert">{err}</p>}
      </section>
    </>
  );
}
