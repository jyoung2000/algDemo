// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { Results } from './Results';
import { cacheStateOf } from './engine/queue-controls';
import type { RecItem, Track } from './api';
import type { CardCache } from './engine/queue-controls';
const track = {key:'ready-song',title:'Ready song',artists:['Test artist'],provider:'deezer',platform_id:'1',tags:[],preview:'https://test.invalid/audio.mp3'} as unknown as Track;
const item = {track,rank:1,playback:{preview:'https://test.invalid/audio.mp3'},reasons:[],characteristics:{}} as unknown as RecItem;
const ready = cacheStateOf({status:'ready',kept:false,percent:null,blocked:false,inTarget:true,error:null});
const cache = (state:CardCache['state']):CardCache => ({...ready,state});
const props = (c:CardCache|null, seedsOnly=false, onPlay=vi.fn()) => ({
  seeds:seedsOnly?[track]:[],items:seedsOnly?[]:[item],onRemoveSeed:vi.fn(),onEmphasis:vi.fn(),focusKey:null,playingKey:null,
  flags:{},onFocus:vi.fn(),onPlay,onPlayTrack:onPlay,onFeedback:vi.fn(),cacheOf:()=>c,
});
const action = (container:HTMLElement) => container.querySelector<HTMLButtonElement>('.rec__actions button[aria-label="Play Ready song"]')!;
afterEach(cleanup);
describe('READY-PLAY-001: readiness subtly tints the Play button',()=>{
  for (const seedsOnly of [false,true]) it(`marks the ${seedsOnly?'starting-song':'queue'} Play control ready and preserves its action`,()=>{
    const play=vi.fn(); const {container}=render(<Results {...props(ready,seedsOnly,play)}/>);
    const b=action(container); expect(b.dataset.ready).toBe('true'); expect(b.classList.contains('playbtn')).toBe(true);
    expect(b.title).toMatch(/ready locally/i); fireEvent.click(b); expect(play).toHaveBeenCalledWith(seedsOnly?track:item);
  });
  for(const state of ['queued','downloading','failed','blocked'] as const) it(`leaves ${state} neutral`,()=>{
    const {container}=render(<Results {...props(cache(state))}/>);
    expect(action(container).dataset.ready).not.toBe('true');
  });
  it('does not invent readiness when no cache state is available',()=>{
    const {container}=render(<Results {...props(null)}/>);expect(action(container).dataset.ready).not.toBe('true');
  });
  it('updates on completion and removes the tint again after eviction',()=>{
    const {container,rerender}=render(<Results {...props(cache('downloading'))}/>);
    expect(action(container).dataset.ready).not.toBe('true');
    rerender(<Results {...props(ready)}/>);expect(action(container).dataset.ready).toBe('true');
    rerender(<Results {...props(cache('queued'))}/>);expect(action(container).dataset.ready).not.toBe('true');
  });
  it('counts a kept copy as locally ready too',()=>{
    const kept=cacheStateOf({status:'unknown',kept:true,percent:null,blocked:false,inTarget:false,error:null});
    const {container}=render(<Results {...props(kept)}/>);expect(action(container).dataset.ready).toBe('true');
  });
  it('defines a ready-only accent background and icon colour without resizing buttons',()=>{
    const css=readFileSync(`${process.cwd()}/src/styles.css`,'utf8');
    expect(css).toMatch(/\.rec__actions \.iconbtn\.playbtn\[data-ready='true'\]\s*\{[^}]*background:\s*var\(--accent-soft\);[^}]*color:\s*var\(--accent\);/);
  });
});
