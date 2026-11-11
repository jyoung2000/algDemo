// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Track } from './api';
import { SongCredits } from './SongCredits';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('keeps album above individually navigable lead and guest credits without starting playback', async () => {
  const track = { id:'singapore', platform_id:'1234', key:'singapore', title:'Singapore', album:'A Great Chaos', provider:'deezer', artist:'Ken Carson', artists:['Ken Carson','Destroy Lonely'], artist_ids:{deezer:'5323951'} } as Track;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const album = vi.fn(), artist = vi.fn();
  try {
    await act(async () => root.render(<SongCredits track={track} onOpenAlbum={album} onOpenArtist={artist} />));
    const button=host.querySelector<HTMLButtonElement>('.song-credits__album')!;
    expect(button.textContent).toBe('A Great Chaos');
    expect(button.querySelector('svg')).toBeNull();
    expect(button.parentElement!.nextElementSibling!.textContent).toContain('Ken Carson, Destroy Lonely');
    await act(async () => button.click());
    expect(album).toHaveBeenCalledWith(track);
    for (const b of host.querySelectorAll<HTMLButtonElement>('.artistlink')) await act(async () => b.click());
    expect(artist).toHaveBeenCalledWith({id:'dz:5323951',name:'Ken Carson'});
    expect(artist).toHaveBeenCalledWith({name:'Destroy Lonely'});
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('links an explicit title guest omitted by the provider artist array', async () => {
  const track = {id:'yt1',key:'yt1',platform_id:'abcdefghijk',provider:'ytmusic',title:'Singapore (feat. Destroy Lonely)',album:'A Great Chaos',artist:'Ken Carson',artists:['Ken Carson']} as Track;
  const host=document.createElement('div'); const root=createRoot(host); const open=vi.fn();
  try {
    await act(async()=>root.render(<SongCredits track={track} onOpenArtist={open} />));
    const names=[...host.querySelectorAll<HTMLButtonElement>('.artistlink')];
    expect(names.map(n=>n.textContent)).toEqual(['Ken Carson','Destroy Lonely']);
    await act(async()=>names[1]!.click());
    expect(open).toHaveBeenCalledWith({name:'Destroy Lonely'});
  } finally { await act(async()=>root.unmount()); }
});
