/** STREAM-DL-001: when the player streams a song while its download runs. */
import { describe, expect, it } from 'vitest';
import { pickStream, streamAudioUrl, streamableSource, type StreamInputs } from './stream-pick';

const YT = 'https://music.youtube.com/watch?v=KavaUJxnNVU';
const base: StreamInputs = { canStream: true, source: YT, localStatus: 'running', localSrc: null, current: null };
const URL_ = streamAudioUrl(YT);

describe('pickStream', () => {
  it('streams a YouTube song while its download runs, or before it starts', () => {
    expect(URL_).toBe('/stream-audio?u=https%3A%2F%2Fmusic.youtube.com%2Fwatch%3Fv%3DKavaUJxnNVU');
    expect(pickStream(base)).toBe(URL_);
    expect(pickStream({ ...base, localStatus: 'missing' })).toBe(URL_);
  });

  it('never streams once the file is here, nor before the shell has said whether it holds it', () => {
    expect(pickStream({ ...base, localStatus: 'ready', localSrc: 'blob:x' })).toBeNull();
    expect(pickStream({ ...base, localStatus: 'unknown' })).toBeNull();
    expect(pickStream({ ...base, localStatus: 'ready', localSrc: null })).toBeNull();
  });

  it('gives way to a file that lands before the stream has made a sound', () => {
    expect(pickStream({ ...base, localStatus: 'ready', localSrc: 'blob:x', current: { url: URL_, started: false, failed: false } })).toBeNull();
  });

  it('keeps a stream that has started to the end, even once the file lands', () => {
    expect(pickStream({ ...base, localStatus: 'ready', localSrc: 'blob:x', current: { url: URL_, started: true, failed: false } })).toBe(URL_);
  });

  it('does not try a failed stream again or where the shell cannot stream', () => {
    expect(pickStream({ ...base, current: { url: null, started: false, failed: true } })).toBeNull();
    expect(pickStream({ ...base, canStream: false })).toBeNull();
    expect(pickStream({ ...base, source: null })).toBeNull();
  });

  it('tries every downloader-approved source, including SoundCloud while its download is in flight', () => {
    for (const source of [
      'https://soundcloud.com/forss/flickermood',
      'https://audius.co/Lofibeat/stars-in-the-sky-lofi-beats-370899',
      'https://benprunty.bandcamp.com/track/giant-step',
      'https://hearthis.at/random1-ej/deep-by-random-creative-commons-royalty-free/',
      'https://archive.org/download/cold-funk-by-kevin-macleod/cold-funk-by-kevin-macleod.mp3',
    ]) expect(pickStream({ ...base, source })).toBe(streamAudioUrl(source));
  });
});

describe('streamableSource', () => {
  it('accepts only downloader-approved HTTPS song links, never Spotify or an arbitrary host', () => {
    expect(streamableSource('https://www.youtube.com/watch?v=jfKfPfyJRdk')).toBe(true);
    expect(streamableSource('https://soundcloud.com/forss/flickermood')).toBe(true);
    expect(streamableSource('https://audius.co/Lofibeat/stars-in-the-sky-lofi-beats-370899')).toBe(true);
    expect(streamableSource('https://benprunty.bandcamp.com/track/giant-step')).toBe(true);
    expect(streamableSource('https://hearthis.at/random1-ej/deep-by-random-creative-commons-royalty-free/')).toBe(true);
    expect(streamableSource('https://archive.org/download/cold-funk-by-kevin-macleod/cold-funk-by-kevin-macleod.mp3')).toBe(true);
    expect(streamableSource('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl')).toBe(false);
    expect(streamableSource('https://hearthis.at/a/song/../secret/')).toBe(false);
    expect(streamableSource('https://archive.org/download/item/evil.zip')).toBe(false);
    expect(streamableSource('http://www.youtube.com/watch?v=jfKfPfyJRdk')).toBe(false);
    expect(streamableSource('https://evil.youtube.com.example/watch')).toBe(false);
    expect(streamableSource('not a url')).toBe(false);
  });
});
