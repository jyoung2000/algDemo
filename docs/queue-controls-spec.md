# Merged spec: queue download controls + card visualizer (QUEUE-CTRL-001)

Inputs: `design-claude-fable-5.md`, `design-gpt-6-astra.md` (fresh queries, 2026-11-04).

## Where both agreed — this is the spec, not a choice

1. **Cache and Kept are two different things.** Both refused to conflate them. "Queue cache" is
   automatic, evictable, LRU, governed by the GB slider. "Kept" is a user action, permanent, lives in
   the Music folder, governed by the folder picker, and is NEVER cache-evicted. The card visualizer
   shows *cache* state; Kept is a separate badge.
2. **Bottom-edge progress rail**, 3px, width = `--dl` percent, positioned so it never crosses the
   text area — leaves the playing/hover/focus/selected backgrounds and text contrast untouched.
3. **State is glyph + text, never colour alone.**
4. **Per-row state is NOT aria-live** (31+ rows would spam a screen reader). One polite global status
   region carries the summary, updated on milestones, never on percentage ticks.
5. **The GB cap wins** over the preload count. Songs beyond it become `blocked` and say so, rather
   than being silently dropped or churned.
6. **The folder picker belongs in Storage and downloads**, but labelled for kept music only, with
   copy stating the queue cache lives in app data.
7. **Cost is disclosed, not hidden**: each simultaneous download is a separate yt-dlp process.
8. `prefers-reduced-motion` kills the rail transition.

## Where they differed — ruling

- **Parallelism range.** Fable: 1-4, default 2. Astra: platform-aware, Android 1-3 default 1,
  Windows 1-6 default 2. **Taking Astra's platform split** (a phone is not a desktop, and each slot
  is a real process) with Fable's default of 2 on desktop. Android max 3.
- **Preload count.** Astra's "All songs" default preserves shipped behaviour; take it, with an
  optional count. Fable's slider-of-31 is wrong because the list length changes.
- **Five states**, both agreed: ready / downloading / queued / missing / blocked.

## Deviations from both, with reasons

- Progress percentage must come from the real job (`dl.jobs()` percent), never interpolated. Neither
  designer knew the percent source; inventing a smooth animation would be a fabricated number.
- No mobile "More" popover (Astra): out of scope for this request, and the five actions already fit.

## Copy taken verbatim from Astra (it gave an exact table)

"Queue cache limit", "Simultaneous downloads", "Preload target", "All songs"/"Set a count",
"Songs to preload", "Kept music folder", "Choose folder", "No folder selected".
States: "Ready in queue cache", "Caching · {p}%", "Queued", "Unavailable · {reason}",
"Cache full · Raise the cache limit", "Kept in Music folder".
Cost note: "Each simultaneous download runs a separate yt-dlp process. More can increase CPU,
memory, battery and network use."
