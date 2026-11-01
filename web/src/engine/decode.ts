/**
 * Decode an MP3/AAC/other container to 48 kHz mono float32 inside the WebView (Web Audio's decoder,
 * which resamples to the context's rate), then the int16 round-trip the model's README prescribes.
 */
import { SR, int16RoundTrip, stripId3v2 } from './audio';

export async function decodeToMono48k(data: Uint8Array): Promise<Float32Array> {
  const Ctor = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctor) throw new Error('This device cannot decode audio here (no Web Audio).');
  // The length is only a placeholder: decodeAudioData ignores it and returns the full decoded clip.
  const ctx = new Ctor(1, SR, SR);
  const copy = stripId3v2(data);
  const buf = await ctx.decodeAudioData(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer);
  const out = new Float32Array(buf.length);
  const ch = buf.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i]! += d[i]! / ch;
  }
  return int16RoundTrip(out);
}
