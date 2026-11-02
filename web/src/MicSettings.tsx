import { useEffect, useRef, useState } from 'react';
import { classNames } from './util';

const listen = () => import('./engine/listen');

type Phase = 'idle' | 'opening' | 'testing';
type Verdict = { kind: 'ok' | 'warn' | 'info'; text: string } | null;

const TEST_SECONDS = 10;

/**
 * Settings: which microphone song identification listens with, and a live test of it. The test opens the microphone the
 * same way the search bar's Listen button does and draws the same bars, so what it shows is what Listen will do.
 */
export function MicSettings() {
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [named, setNamed] = useState(true);
  const [selected, setSelected] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [verdict, setVerdict] = useState<Verdict>(null);
  const bars = useRef<HTMLSpanElement>(null);
  const levelEl = useRef<HTMLSpanElement>(null);
  const stopTest = useRef<(() => void) | null>(null);

  const refresh = async () => {
    try {
      const L = await listen();
      const r = await L.listMics();
      setMics(r.mics);
      setNamed(r.named);
      const saved = L.savedMicId();
      // a remembered microphone that is no longer plugged in shows as System default (and openMic falls back the same way)
      setSelected(r.mics.some((m) => m.id === saved) ? saved : '');
    } catch {
      setMics([]);
    }
  };

  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    const onChange = () => void refresh();
    md?.addEventListener?.('devicechange', onChange);
    return () => {
      md?.removeEventListener?.('devicechange', onChange);
      stopTest.current?.();
    };
  }, []);

  const choose = async (id: string) => {
    setSelected(id);
    (await listen()).saveMicId(id);
    stopTest.current?.();
    setVerdict(null);
  };

  /** Opens the microphone once so the browser reveals the device names, then closes it again. */
  const allow = async () => {
    setVerdict(null);
    try {
      const L = await listen();
      (await L.openMic('')).getTracks().forEach((t) => t.stop());
      await refresh();
    } catch (e) {
      setVerdict({ kind: 'warn', text: denied(e) });
    }
  };

  const test = async () => {
    if (phase !== 'idle') return;
    setPhase('opening');
    setVerdict(null);
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let stopBands = () => {};
    let timer = 0;
    let ended = false;
    const end = (v: Verdict) => {
      if (ended) return;
      ended = true;
      window.clearTimeout(timer);
      stopBands();
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      stopTest.current = null;
      setPhase('idle');
      if (v) setVerdict(v);
      bars.current?.childNodes.forEach((n) => (n as HTMLElement).style.setProperty('--h', '0.08'));
    };
    try {
      const L = await listen();
      stream = await L.openMic(selected);
      const track = stream.getAudioTracks()[0];
      const label = track?.label || 'the microphone';
      ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      const source = ctx.createMediaStreamSource(stream);
      let loudest = 0;
      const t0 = performance.now();
      stopTest.current = () => end(null);
      stopBands = L.startBands(ctx, source, (b, peak) => {
        loudest = Math.max(loudest, peak);
        if (levelEl.current) levelEl.current.textContent = peak > 0 ? `${Math.round(20 * Math.log10(peak))} dB` : '−∞ dB';
        const el = bars.current;
        if (!el) return;
        for (let i = 0; i < b.length; i++) (el.children[i] as HTMLElement | undefined)?.style.setProperty('--h', String(Math.max(0.08, b[i]!)));
        if (peak >= L.SILENT_PEAK && performance.now() - t0 > 400) setVerdict((v) => (v?.kind === 'ok' ? v : { kind: 'ok', text: `Receiving sound from ${label}. If the bars do not move when you make a noise, pick another microphone.` }));
      });
      track?.addEventListener('ended', () => end({ kind: 'warn', text: `${label} stopped (unplugged or taken by another app).` }));
      setPhase('testing');
      setVerdict({ kind: 'info', text: `Listening on ${label}. Play some music near it or speak.` });
      timer = window.setTimeout(
        () =>
          end(
            loudest >= L.SILENT_PEAK
              ? { kind: 'ok', text: `${label} is sending sound (peak ${Math.round(20 * Math.log10(loudest))} dB).` }
              : { kind: 'warn', text: `${label} is open but sending nothing. It may be muted, turned right down, or not the one you are speaking into. Pick another from the list.` },
          ),
        TEST_SECONDS * 1000,
      );
      void refresh(); // names are available now
    } catch (e) {
      end({ kind: 'warn', text: denied(e) });
    }
  };

  return (
    <div className="pref" aria-label="Microphone">
      <span className="k">Microphone</span>
      <div className="micset">
        <p className="note">The microphone the search bar's Listen button uses to identify a song. Test it here before you rely on it.</p>
        <div className="micset__row">
          <label className="sr" htmlFor="mic-select">
            Microphone
          </label>
          <select id="mic-select" className="field micset__select" value={selected} disabled={phase !== 'idle'} onChange={(e) => void choose(e.target.value)}>
            <option value="">System default</option>
            {mics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {phase === 'testing' ? (
            <button className="push" type="button" onClick={() => stopTest.current?.()}>
              Stop test
            </button>
          ) : (
            <button className="push push--default" type="button" disabled={phase !== 'idle'} onClick={() => void test()}>
              {phase === 'opening' ? 'Opening…' : 'Test microphone'}
            </button>
          )}
        </div>
        {!named && (
          <p className="note">
            The list shows generic names until the app is allowed to use a microphone.{' '}
            <button className="push" type="button" onClick={() => void allow()}>
              Allow and show names
            </button>
          </p>
        )}
        {mics.length === 0 && named && <p className="note">No microphone was found. Plug one in; this list updates by itself.</p>}
        <div className="micset__test" hidden={phase !== 'testing'} aria-hidden={phase !== 'testing'}>
          <span className="listen__bars" ref={bars} aria-hidden="true">
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i} className="listen__bar" />
            ))}
          </span>
          <span className="micset__db" ref={levelEl} aria-hidden="true" />
        </div>
        {verdict && (
          <p className={classNames('micset__state', verdict.kind === 'ok' && 'is-ok', verdict.kind === 'warn' && 'is-warn')} role="status">
            {verdict.text}
          </p>
        )}
      </div>
    </div>
  );
}

function denied(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === 'denied') return 'The microphone is blocked. Allow it in Windows Settings → Privacy & security → Microphone (and "Let desktop apps access your microphone"), or in the Android app\'s permissions.';
  if (code === 'no_mic') return 'No microphone was found. Plug one in and test again.';
  if (code === 'unsupported') return 'This device cannot record from a microphone here.';
  return `The microphone could not be opened: ${e instanceof Error ? e.message : String(e)}`;
}
