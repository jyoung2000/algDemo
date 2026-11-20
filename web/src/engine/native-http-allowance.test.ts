// @vitest-environment happy-dom
// ALLOWANCE-ARCH-001: the page's side of the shell bridge passes on what the shell says about each answer (bytes the
// network carried, whether the connection is metered) and can ask about the connection without using it.
import { afterEach, describe, expect, it } from 'vitest';
import { nativeHttpPort } from './native-http';

type Sent = { id: number; req: Record<string, unknown> };
function shell(answer: (req: Record<string, unknown>) => Record<string, unknown>) {
  const sent: Sent[] = [];
  window.AirwaveNative = {
    version: () => 'test',
    request: (id: number, json: string) => {
      const req = JSON.parse(json) as Record<string, unknown>;
      sent.push({ id, req });
      queueMicrotask(() => window.__awHttp?.(id, JSON.stringify(answer(req))));
    },
  };
  return sent;
}
afterEach(() => { delete window.AirwaveNative; });
const body = btoa('{}');

describe('the shell bridge', () => {
  it('passes on the wire size and the metered flag of an answer', async () => {
    shell(() => ({ status: 200, headers: {}, body, wire: 1234, metered: true }));
    const r = await nativeHttpPort().request({ url: 'https://api.deezer.com/x' });
    expect(r.wireBytes).toBe(1234);
    expect(r.metered).toBe(true);
    expect(new TextDecoder().decode(r.body)).toBe('{}');
  });
  it('an older shell that says neither leaves both out', async () => {
    shell(() => ({ status: 200, headers: {}, body }));
    const r = await nativeHttpPort().request({ url: 'https://api.deezer.com/x' });
    expect('wireBytes' in r).toBe(false);
    expect('metered' in r).toBe(false);
  });
  it('asks about the connection with a probe, not a web address', async () => {
    const sent = shell((req) => (req['probe'] === 'network' ? { status: 204, headers: {}, body: '', metered: false } : { error: 'unexpected' }));
    expect(await nativeHttpPort().metered!()).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.req).toEqual({ probe: 'network' });
  });
  it('a shell that cannot tell (or is too old to know the question) reads as null', async () => {
    shell(() => ({ error: 'JSONException: No value for url' }));
    expect(await nativeHttpPort().metered!()).toBeNull();
    shell(() => ({ status: 204, headers: {}, body: '' }));
    expect(await nativeHttpPort().metered!()).toBeNull();
  });
});
