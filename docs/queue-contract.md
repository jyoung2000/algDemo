# Shared queue: API contract

One queue holds everything you listen to. Songs you search and add are `searched` entries; songs the
discovery engine finds are `discovered` entries. Both sit in the same list and play in order. Searched
songs are the seeds, so discovery runs from them. This replaces the old starting-songs shelf and the
"Find my next favorite" button.

## Types

```ts
type QueueSource = 'searched' | 'discovered';

interface QueueEntry {
  id: string;                 // stable, unique per entry (a uuid); not the track key
  source: QueueSource;
  track: Track;               // same shape as api.ts Track
  playback: Playback;         // same shape as api.ts Playback (the server computes it)
  rec: RecItem | null;        // null for searched entries; full RecItem for discovered ones
  added_at: number;           // unix seconds
}

interface QueueState {
  entries: QueueEntry[];      // the one list, in play order
  current: string | null;     // id of the entry now playing, or null
  history: string[];          // ids already played, oldest first; Previous pops the last one
  discovering: boolean;       // true while a discovery run is still finding songs
  discover_note: string;      // one human line about discovery ('' when nothing to say)
  saved_at: number | null;    // set when the queue was restored from disk after a restart
}
```

## Endpoints (all JSON, all return `QueueState` unless noted)

| Method | Path | Body | Meaning |
|---|---|---|---|
| GET | `/api/queue` | | current state |
| GET | `/api/queue/events` | | Server-Sent Events. One `data: <QueueState JSON>` message on connect and after every change. Keep-alive comment every 15 s. |
| POST | `/api/queue/add` | `{ track: Track }` | append a searched entry (ignored with 409 if already queued); starts discovery |
| DELETE | `/api/queue/{id}` | | remove an entry. Removing the current entry moves to the next one |
| POST | `/api/queue/play` | `{ id: string }` | make `id` current; the previous current goes onto `history` |
| POST | `/api/queue/next` | | advance to the entry after `current`; `current` becomes null at the end |
| POST | `/api/queue/previous` | | pop `history` and make it current |

Existing endpoints stay as they are: `/api/search`, `/api/resolve`, `/api/feedback`, `/api/preview/...`,
`/api/full-song`, `/api/settings`, `/api/saved`, `/api/status`, `/api/health`, `/api/reset`.

## Behaviour the UI can rely on

- Entries arrive over the events stream as they are found. Discovered entries are appended to the end,
  de-duplicated against the queue by `track.key`.
- Nothing is reordered on the client. The order is the server's.
- `next` and the end of a song both move to the next entry. A discovered entry shows up in the queue
  before it is playable, so the UI can show a loading row.
- Settings `adventurous` (0–1) and `fresh` (bool) still apply. Changing them does not reorder the queue.
  It takes effect on the next discovery run.
- Feedback (`like`, `dislike`, `hide`, `complete`, `skip`) still goes to `/api/feedback`.
  Hiding a discovered entry also removes it from the queue (`DELETE /api/queue/{id}`).

## Visual rules for the UI

- One list. Searched and discovered rows have **different backgrounds** (for example a tinted
  "searched" row and a plain "discovered" row), with a small label on each.
- The row that is playing is marked clearly. Entries already played stay visible above it, dimmed.
- The transport is Previous / Play-Pause / Next, and Previous uses `history`.
- Discovery shows a live "Finding more…" state while `discovering` is true. Nothing blocks the list.
