import { useEffect, useState } from 'react';
import { api, type Profile } from './api';
import { PROVIDER_LABEL, classNames, fmtBytes } from './util';
import { TastePicker, type TrailPoint } from './TastePicker';
import { familyName, placeGenre, placeSong } from './taste-map';
import { Art } from './Art';

/** What each scoring factor means, in the words the rest of the app uses. */
const FACTOR_TEXT: Record<string, [string, string]> = {
  audio: ['Sound', 'How close the 30-second preview sounds to a starting song (audio model).'],
  genre: ['Genre', 'Shared genres with a starting song.'],
  artist: ['Artist', 'Same artist as a starting song, or one the services call related.'],
  provider: ['Services', 'How high the music services ranked it as related to a starting song.'],
  feedback: ['Your feedback', 'Likes, saves, full listens, skips and dislikes on this song and artist.'],
  tempo: ['Tempo', 'BPM close to a starting song (half and double time count as close).'],
  freshness: ['New', 'Released recently, when the source gives a real date.'],
  novelty: ['Discovery', 'An artist that is not already in your starting songs.'],
  taste: ['Listening taste', 'Genres and tempo learned from what you finish and what you skip.'],
};

/** The formula as one readable line per step, built from the engine's numbers. */
function formulaText(f: Profile['formula']): string {
  const aff = f.affinity.factors.map((x) => `${x.weight}·${x.factor}`).join(' + ');
  const glob = f.affinity.global.map((x) => `${x.weight}·${x.factor}`).join(' + ');
  return [
    `seed fit = Σ w·factor / Σ w over [${aff}] (only factors with evidence)`,
    `blend = ${f.affinity.best_seed_share}·seed fit(best seed) + ${(1 - f.affinity.best_seed_share).toFixed(2)}·emphasis-weighted mean of seed fits`,
    `affinity = (blend·seedWeight + Σ w·global over [${glob}]) / (seedWeight + Σ w)`,
    `affinity' = affinity × (1 − ${f.taste.weight}) + ${f.taste.weight} × taste`,
    `final = affinity' × (${f.coverage.floor} + (1 − ${f.coverage.floor}) × coverage)`,
    `ranked = final − min(${f.exposure.max}, ${f.exposure.per_show} × shows)`,
  ].join('\n');
}

const KIND_LABEL: Record<string, string> = {
  complete: 'Full listens',
  replay: 'Replays',
  skip: 'Skips',
  like: 'Likes',
  save: 'Saves',
  dislike: 'Dislikes',
  hide: 'Hidden',
};

const TIER_LABEL: Record<string, string> = { strong: 'Close match', related: 'Related', emerging: 'New artist', experimental: 'Wildcard' };

const LIMIT_LABEL: Record<string, string> = {
  feedback_half_life_days: 'Feedback counts half after (days)',
  taste_half_life_days: 'Taste counts half after (days)',
  max_per_artist: 'Songs per artist in one list',
  artist_skip_threshold: 'Skipped songs before an artist sinks',
  exposure_penalty: 'Penalty per time already shown',
  exposure_penalty_max: 'Largest repeat penalty',
  coverage_floor: 'Score kept with thin evidence',
  best_seed_share: 'Weight of the best-matching starting song',
  new_release_days: 'New release window (days)',
  audio_candidates_per_request: 'Songs compared by sound per run',
};

const TIMING_LABEL: Record<string, string> = {
  profile_ms: 'Reading starting songs',
  gather_ms: 'Asking the services',
  metadata_ms: 'First list ready',
  total_ms: 'Finished',
};

function fmtListen(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function fmtWhen(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A bar from the centre: right and accented for positive, left and red for negative. */
function SignedBar({ value, max, label }: { value: number; max: number; label: string }) {
  const w = max > 0 ? Math.min(50, (Math.abs(value) / max) * 50) : 0;
  return (
    <span className="sbar" role="img" aria-label={label}>
      <span className={classNames('sbar__fill', value < 0 && 'is-neg')} style={value < 0 ? { right: '50%', width: `${w}%` } : { left: '50%', width: `${w}%` }} />
    </span>
  );
}

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <span className="pbar" role="img" aria-label={label}>
      <span className="pbar__fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </span>
  );
}

/** "Your profile": everything the recommender tracks, what it learned, and how it uses it. Read-only. */
export function ProfileView() {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => {
    setBusy(true);
    setErr(null);
    api
      .profile()
      .then(setP, (e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);

  if (!p) {
    return (
      <div className="profile">
        <section className="card">
          <h2>Your profile</h2>
          {err ? <p className="state state--bad">{err}</p> : <p className="state">Loading what the recommender knows…</p>}
        </section>
      </div>
    );
  }

  const t = p.tracked;
  const gMax = Math.max(0.01, ...p.taste.genres.map((g) => Math.abs(g.score)));
  // TASTE-ACCURACY-001: only the genres the listener actually KEPT are drawn as their taste.
  // `taste.genres` filters on Math.abs(score), so it carries avoided genres too; plotting those
  // alongside the kept ones put genres the listener had only ever skipped on their own taste map.
  const keptGenres = p.taste.genres.filter((g) => g.score > 0);
  const placedAll = keptGenres.map((g) => ({ g, at: placeGenre(g.name) }));
  const placed = placedAll.flatMap(({ g, at }) =>
    at
      ? [
          {
            hue: at.hue,
            bpm: at.bpm,
            // A family word places at its band centre; say so rather than naming a subgenre the
            // listener may never have played.
            label: at.broad
              ? `${g.label} (anywhere in ${familyName(at.family)}): score ${g.score}`
              : `${g.label} (${at.sub.name}): score ${g.score}`,
          },
        ]
      : [],
  );
  const unplaced = placedAll.length - placed.length;
  // Where the field should open, so the reading under it describes the listener from the first
  // frame instead of a hardcoded point in the Electronic band. A genre they actually named wins
  // over a bare family word: opening on the middle of the hip-hop band reads out whichever
  // subgenre happens to sit there, which is the same mistake in a smaller form. Only if they have
  // no named subgenre at all does the strongest family placement stand in.
  const strongestBy = (pick: (broad: boolean) => boolean) =>
    placedAll.reduce<{ hue: number; bpm: number; score: number } | null>((best, { g, at }) => {
      if (!at || !pick(at.broad)) return best;
      return !best || g.score > best.score ? { hue: at.hue, bpm: at.bpm, score: g.score } : best;
    }, null);
  const focus = strongestBy((broad) => !broad) ?? strongestBy(() => true);
  // The last ten DISTINCT songs played, oldest first, on the same field. One song on repeat was
  // ten tiles of one cover (the owner: "the same cover art over and over"); now it is one tile, at
  // its latest play. A song with no known genre or tempo cannot be placed.
  const seenKeys = new Set<string>();
  const distinctNewestFirst = p.played.filter((s) => {
    if (seenKeys.has(s.key)) return false;
    seenKeys.add(s.key);
    return true;
  });
  const playedOldestFirst = distinctNewestFirst.slice(0, 10).reverse();
  const trail: TrailPoint[] = [];
  const notPlaced: string[] = [];
  for (const s of playedOldestFirst) {
    const at = placeSong(s.genre_names, s.bpm);
    if (at) trail.push({ hue: at.hue, bpm: at.bpm, label: `${s.title} (${Math.round(at.bpm)} BPM)`, art: s.artwork, title: s.title });
    else notPlaced.push(s.title);
  }
  const aMax = Math.max(0.01, ...p.artists.map((a) => Math.abs(a.score)));
  const sMax = Math.max(0.01, ...p.songs.map((s) => Math.abs(s.score)));
  const run = p.last_run;

  const copy = () => {
    const text = JSON.stringify(p, null, 2);
    const done = (ok: boolean) => {
      setCopied(ok ? 'Copied' : 'Copy failed');
      window.setTimeout(() => setCopied(null), 1500);
    };
    // Fallback for WebViews and unfocused windows where the async clipboard is refused.
    const legacy = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => done(true),
        () => done(legacy()),
      );
    } else done(legacy());
  };

  return (
    <div className="profile">
      <section className="card" aria-labelledby="pf-h">
        <div className="card__head">
          <h2 id="pf-h">Your profile</h2>
          <button className="push" type="button" onClick={load} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <p className="note">
          Everything the recommender has recorded on this device, what it learned from it, and how it is set to use it. Nothing here leaves the device.
        </p>
        <div className="tiles" role="list" aria-label="What is tracked">
          {(
            [
              ['Starting songs', p.seeds.length],
              ['Events recorded', t.events],
              ['Songs played', t.songs_played],
              ['Listening time', fmtListen(t.listened_sec)],
              ['Artists heard', t.artists],
              ['Shown in lists', `${t.impressions.shown}`],
              ['Songs analysed by sound', t.vectors],
              ['Excluded or hidden', p.excluded + p.hidden],
            ] as const
          ).map(([k, v]) => (
            <div className="tile" role="listitem" key={k}>
              <span className="tile__v">{v}</span>
              <span className="tile__k">{k}</span>
            </div>
          ))}
        </div>
        <dl className="kv">
          {Object.entries(KIND_LABEL).map(([k, l]) => (
            <div key={k}>
              <dt>{l}</dt>
              <dd>{t.counts[k] ?? 0}</dd>
            </div>
          ))}
          <div>
            <dt>First event</dt>
            <dd>{fmtWhen(t.first)}</dd>
          </div>
          <div>
            <dt>Latest event</dt>
            <dd>{fmtWhen(t.last)}</dd>
          </div>
          <div>
            <dt>Songs shown (last {t.impressions.window_days} days)</dt>
            <dd>{t.impressions.songs}</dd>
          </div>
        </dl>
      </section>

      <section className="card" aria-labelledby="pf-taste">
        <h2 id="pf-taste">Listening taste</h2>
        {p.taste.events === 0 ? (
          <p className="note">Nothing learned yet. Play songs from a discovery list: finishing one, skipping one, liking or saving one all teach it.</p>
        ) : (
          <>
            <p className="note">
              Learned from {p.taste.events} {p.taste.events === 1 ? 'event' : 'events'} ({p.taste.positives} kept, {p.taste.negatives} turned away). Recent listening counts more.
            </p>
            <dl className="kv">
              <div>
                <dt>Tempo you keep</dt>
                <dd>{p.taste.bpm !== null ? `${p.taste.bpm} BPM${p.taste.bpm_used ? '' : ' (not used yet: too few songs)'}` : 'not known yet'}</dd>
              </div>
              <div>
                <dt>Tempo you skip</dt>
                <dd>{p.taste.skip_bpm !== null ? `${p.taste.skip_bpm} BPM` : '—'}</dd>
              </div>
            </dl>
            {p.taste.genres.length > 0 && (
              <table className="ptable">
                <caption>Genres, from liked to avoided</caption>
                <thead>
                  <tr>
                    <th scope="col">Genre</th>
                    <th scope="col">Kept</th>
                    <th scope="col">Skipped</th>
                    <th scope="col" className="ptable__bar">
                      Score
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {p.taste.genres.map((g) => (
                    <tr key={g.name}>
                      <th scope="row">{g.label}</th>
                      <td>{g.plays}</td>
                      <td>{g.skips}</td>
                      <td className="ptable__bar">
                        <div className="pcell">
                        <SignedBar value={g.score} max={gMax} label={`${g.label} ${g.score > 0 ? 'liked' : g.score < 0 ? 'avoided' : 'neutral'}, score ${g.score}`} />
                        <span className="num">{g.score > 0 ? `+${g.score}` : g.score}</span>
                      </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="pf-map">
        <h2 id="pf-map">Taste map</h2>
        <p className="note">
          Every genre and subgenre on the picker's field, tempo up the side. The field plots the cover art of what
          you played, newest ringed. The genres you keep playing decide where it is framed — tap "My taste" to go
          back to them{unplaced > 0 ? `; ${unplaced} could not be placed on the field` : ''}.
        </p>
        <TastePicker placed={placed} trail={trail} focus={focus} />
        <div className="card__head">
          <h3>Last {p.played.length} played</h3>
          <span className="note">oldest 1 → newest {p.played.length}</span>
        </div>
        {p.played.length === 0 ? (
          <p className="note">Nothing played yet. Finish or skip a song and it appears here.</p>
        ) : (
          <ol className="plog">
            {playedOldestFirst.map((s, i) => (
              <li key={`${s.ts}-${s.key}-${i}`} className="plog__row">
                <span className="plog__when">{i + 1}</span>
                <Art src={s.artwork} size={28} />
                <span className={classNames('fact', `plog__kind--${s.kind}`)}>{KIND_LABEL[s.kind] ?? s.kind}</span>
                <span className="plog__what">
                  {s.title}
                  {s.artist ? ` — ${s.artist}` : ''}
                  <span className="note">
                    {' '}
                    {s.bpm !== null ? `· ${s.bpm} BPM` : '· no tempo'}
                    {s.genres.length ? ` · ${s.genres.join(', ')}` : ' · no genre'}
                  </span>
                </span>
                {s.listened !== null && <span className="plog__len">{fmtListen(Math.round(s.listened))}</span>}
              </li>
            ))}
          </ol>
        )}
        {notPlaced.length > 0 && (
          <p className="note">Not on the map (no known genre, or no genre with a tempo): {notPlaced.join(', ')}.</p>
        )}
      </section>

      {(p.artists.length > 0 || p.songs.length > 0) && (
        <section className="card" aria-labelledby="pf-fb">
          <h2 id="pf-fb">Artists and songs</h2>
          <p className="note">Feedback scores. A song carries its own score; half of it also goes to the artist. One skip never marks an artist, three skipped songs do.</p>
          {p.artists.length > 0 && (
            <table className="ptable">
              <caption>Artists</caption>
              <tbody>
                {p.artists.slice(0, 20).map((a) => (
                  <tr key={a.name}>
                    <th scope="row">
                      {a.name}
                      {a.liked && <span className="fact">favourite</span>}
                    </th>
                    <td className="ptable__bar">
                      <div className="pcell">
                      <SignedBar value={a.score} max={aMax} label={`${a.name} score ${a.score}`} />
                      <span className="num">{a.score > 0 ? `+${a.score}` : a.score}</span>
                    </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {p.songs.length > 0 && (
            <table className="ptable">
              <caption>Songs</caption>
              <tbody>
                {p.songs.slice(0, 25).map((s) => (
                  <tr key={s.key}>
                    <th scope="row">
                      <span className="ptable__title">{s.title}</span>
                      <span className="ptable__sub">{s.artist}</span>
                      {s.excluded && <span className="fact">never suggested again</span>}
                      {s.hidden && <span className="fact">hidden for 30 days</span>}
                    </th>
                    <td className="ptable__bar">
                      <div className="pcell">
                      <SignedBar value={s.score} max={sMax} label={`${s.title} score ${s.score}`} />
                      <span className="num">{s.score > 0 ? `+${s.score}` : s.score}</span>
                    </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="pf-formula">
        <h2 id="pf-formula">Recommendation formula</h2>
        <p className="note">
          The score the app gives each candidate, with the numbers it uses right now. The slider and the new-releases switch change the
          weights; the values below are read from the engine, not typed in.
        </p>
        <pre className="formula">{formulaText(p.formula)}</pre>
        <table className="ptable">
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col">Value</th>
              <th scope="col">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {p.formula.affinity.factors.map((f) => (
              <tr key={f.factor}>
                <th scope="row">{(FACTOR_TEXT[f.factor] ?? [f.factor])[0]}</th>
                <td>{f.weight}</td>
                <td>{(FACTOR_TEXT[f.factor] ?? ['', ''])[1]}</td>
              </tr>
            ))}
            {p.formula.affinity.global.map((f) => (
              <tr key={f.factor}>
                <th scope="row">{(FACTOR_TEXT[f.factor] ?? [f.factor])[0]}</th>
                <td>{f.weight}</td>
                <td>{(FACTOR_TEXT[f.factor] ?? ['', ''])[1]}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Listening taste</th>
              <td>{p.formula.taste.weight}</td>
              <td>
                Blended into the affinity; a song's genres and tempo, with events counting half after {p.formula.taste.half_life_days} days.
              </td>
            </tr>
            <tr>
              <th scope="row">Coverage floor</th>
              <td>{p.formula.coverage.floor}</td>
              <td>The score kept when a song has little evidence.</td>
            </tr>
            <tr>
              <th scope="row">Repeat penalty</th>
              <td>
                {p.formula.exposure.per_show} per show, max {p.formula.exposure.max}
              </td>
              <td>Subtracted for songs already shown in the last {p.formula.exposure.window_days} days.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card" aria-labelledby="pf-algo">
        <h2 id="pf-algo">How songs are scored</h2>
        <p className="note">
          Each candidate gets a score from these factors. The weights shift with the Familiar–Adventurous slider ({pct(p.algorithm.settings.adventurous)} adventurous
          {p.algorithm.settings.fresh ? ', new releases on' : ''}). A factor with no evidence for a song is left out for that song instead of counting as zero.
        </p>
        <table className="ptable">
          <thead>
            <tr>
              <th scope="col">Factor</th>
              <th scope="col">Base</th>
              <th scope="col">Now</th>
              <th scope="col" className="ptable__bar">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {p.algorithm.weights.map((w) => {
              const [name, help] = FACTOR_TEXT[w.factor] ?? [w.factor, ''];
              return (
                <tr key={w.factor}>
                  <th scope="row">
                    <span className="ptable__title">{name}</span>
                    <span className="ptable__sub">{help}</span>
                  </th>
                  <td>{w.base}</td>
                  <td>{w.effective}</td>
                  <td className="ptable__bar">
                    <div className="pcell">
                    <Bar value={w.share} label={`${name} ${pct(w.share)} of the score`} />
                    <span className="num">{pct(w.share)}</span>
                  </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="note">Listening taste is blended in last at a fixed {pct(p.algorithm.weights.find((w) => w.factor === 'taste')?.base ?? 0)}, once you have played something.</p>
        <dl className="kv">
          {Object.entries(p.algorithm.tiers).map(([k, v]) => (
            <div key={k}>
              <dt>{TIER_LABEL[k] ?? k} share of a list</dt>
              <dd>{pct(v)}</dd>
            </div>
          ))}
          <div>
            <dt>New songs per discovery</dt>
            <dd>{p.algorithm.settings.queue_size}</dd>
          </div>
          <div>
            <dt>Audio matching</dt>
            <dd>{p.algorithm.settings.audio ? 'on' : 'off'}</dd>
          </div>
          {Object.entries(p.algorithm.limits).map(([k, v]) => (
            <div key={k}>
              <dt>{LIMIT_LABEL[k] ?? k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <dl className="kv">
          {Object.entries(p.algorithm.feedback_weights)
            .filter(([k]) => k !== 'seed')
            .map(([k, v]) => (
              <div key={k}>
                <dt>{KIND_LABEL[k] ?? k}: song score / taste</dt>
                <dd>
                  {v > 0 ? `+${v}` : v} / {(p.algorithm.taste_weights[k] ?? 0) > 0 ? `+${p.algorithm.taste_weights[k]}` : (p.algorithm.taste_weights[k] ?? 0)}
                </dd>
              </div>
            ))}
        </dl>
      </section>

      {p.seeds.length > 0 && (
        <section className="card" aria-labelledby="pf-seeds">
          <h2 id="pf-seeds">Starting songs</h2>
          <table className="ptable">
            <tbody>
              {p.seeds.map((s) => (
                <tr key={s.key}>
                  <th scope="row">
                    <span className="ptable__title">{s.title}</span>
                    <span className="ptable__sub">{s.artist}</span>
                  </th>
                  <td className="ptable__facts">
                    {s.bpm !== null && <span className="fact">{s.bpm} BPM</span>}
                    {s.genres.map((g) => (
                      <span className="fact" key={g}>
                        {g}
                      </span>
                    ))}
                    {s.emphasis !== 1 && <span className="fact">weight ×{s.emphasis}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card" aria-labelledby="pf-run">
        <h2 id="pf-run">Last discovery run</h2>
        {!run ? (
          <p className="note">No run yet. Press “Find my next favorite” on Discover.</p>
        ) : (
          <>
            <p className="note">
              {fmtWhen(run.at)}: {run.candidates ?? '?'} candidates gathered, {run.songs} chosen
              {run.asked ? ` of ${run.asked} asked` : ''}
              {run.pool !== null ? `; ${run.pool} kept for live re-ranking while you listen` : ''}.
            </p>
            {run.score && (
              <dl className="kv">
                <div>
                  <dt>Best score</dt>
                  <dd>{run.score.top}</dd>
                </div>
                <div>
                  <dt>Median score</dt>
                  <dd>{run.score.median}</dd>
                </div>
                <div>
                  <dt>Lowest score</dt>
                  <dd>{run.score.low}</dd>
                </div>
                {Object.entries(run.tiers).map(([k, v]) => (
                  <div key={k}>
                    <dt>{TIER_LABEL[k] ?? k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
                {Object.entries(run.evidence).map(([k, v]) => (
                  <div key={`e-${k}`}>
                    <dt>Evidence: {k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {run.factors.length > 0 && (
              <table className="ptable">
                <caption>Average factor value across the list (0 to 1), and for how many songs it was known</caption>
                <tbody>
                  {run.factors.map((f) => {
                    const name = FACTOR_TEXT[f.factor]?.[0] ?? f.factor;
                    return (
                      <tr key={f.factor}>
                        <th scope="row">{name}</th>
                        <td>
                          {f.known}/{f.of}
                        </td>
                        <td className="ptable__bar">
                          <div className="pcell">
                          <Bar value={f.mean} label={`${name} average ${f.mean}`} />
                          <span className="num">{f.mean}</span>
                        </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <dl className="kv">
              {run.sources.map((s) => (
                <div key={s.name}>
                  <dt>{PROVIDER_LABEL[s.name] ?? s.name}</dt>
                  <dd title={s.detail ?? ''}>
                    {s.state}
                    {s.count !== null ? ` · ${s.count}` : ''}
                  </dd>
                </div>
              ))}
              {Object.entries(run.audio)
                .filter(([, v]) => typeof v === 'number')
                .map(([k, v]) => (
                  <div key={`a-${k}`}>
                    <dt>Sound: {k.replace(/_/g, ' ')}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
              {Object.entries(run.timings)
                .filter(([k]) => k in TIMING_LABEL)
                .map(([k, v]) => (
                  <div key={`t-${k}`}>
                    <dt>{TIMING_LABEL[k]}</dt>
                    <dd>{(v / 1000).toFixed(1)} s</dd>
                  </div>
                ))}
              {Object.entries(run.transfer).map(([k, v]) => (
                <div key={`x-${k}`}>
                  <dt>Downloaded: {k}</dt>
                  <dd>{fmtBytes(v)}</dd>
                </div>
              ))}
            </dl>
            {(run.audio.skipped || run.audio.stopped) && <p className="note">{run.audio.skipped || run.audio.stopped}</p>}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="pf-recent">
        <h2 id="pf-recent">Recent activity</h2>
        {p.recent.length === 0 ? (
          <p className="note">No events yet.</p>
        ) : (
          <ol className="plog">
            {p.recent.map((e, i) => (
              <li key={`${e.ts}-${i}`}>
                <span className="plog__when">{fmtWhen(e.ts)}</span>
                <span className={classNames('fact', `plog__kind--${e.kind}`)}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                <span className="plog__what">
                  {e.title}
                  {e.artist ? ` — ${e.artist}` : ''}
                </span>
                {e.listened !== null && <span className="plog__len">{fmtListen(Math.round(e.listened))}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card" aria-labelledby="pf-raw">
        <div className="card__head">
          <h2 id="pf-raw">Raw data</h2>
          <button className="push" type="button" onClick={copy} aria-live="polite">
            {copied ?? 'Copy JSON'}
          </button>
        </div>
        <details>
          <summary>Show the profile exactly as the recommender sees it</summary>
          <pre className="raw">{JSON.stringify(p, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
