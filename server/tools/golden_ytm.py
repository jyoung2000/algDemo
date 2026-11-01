"""Trim live-recorded music.youtube.com responses to fixtures and write what ytmusicapi's own
parsers return for them, so web/src/engine/ytmusic.ts is checked against the real library.

Usage: python tools/golden_ytm.py <recorded-dir> <out-dir>   (recorded-dir holds search/watch/related/playlist.json)
"""
import json, sys
from pathlib import Path
from ytmusicapi.navigation import nav, SECTION_LIST, MRLIR
from ytmusicapi.parsers.search import parse_search_results
from ytmusicapi.parsers.watch import parse_watch_playlist, get_tab_browse_ids
from ytmusicapi.parsers.browsing import parse_mixed_content
from ytmusicapi.parsers.playlists import parse_playlist_items

src, out = Path(sys.argv[1]), Path(sys.argv[2])
N = 6
ld = lambda n: json.loads((src / f"{n}.json").read_text(encoding="utf8"))

# search
s = ld("search")
sec = s["contents"]["tabbedSearchResultsRenderer"]["tabs"][0]["tabRenderer"]["content"]["sectionListRenderer"]["contents"]
sec[0]["musicShelfRenderer"]["contents"] = sec[0]["musicShelfRenderer"]["contents"][:N]
sec[:] = sec[:1]
shelf = sec[0]["musicShelfRenderer"]["contents"]
exp_search = parse_search_results(shelf, "song", "Songs")

# watch
w = ld("watch")
wn = w["contents"]["singleColumnMusicWatchNextResultsRenderer"]["tabbedRenderer"]["watchNextTabbedResultsRenderer"]
for t in wn["tabs"]:
    c = t["tabRenderer"].get("content", {})
    if "musicQueueRenderer" in c:
        pp = c["musicQueueRenderer"]["content"]["playlistPanelRenderer"]
        pp["contents"] = pp["contents"][:N]
        for k in list(pp):
            if k not in ("contents",): pp.pop(k)
w = {"contents": {"singleColumnMusicWatchNextResultsRenderer": {"tabbedRenderer": {"watchNextTabbedResultsRenderer": wn}}}}
pp = wn["tabs"][0]["tabRenderer"]["content"]["musicQueueRenderer"]["content"]["playlistPanelRenderer"]["contents"]
exp_watch = [{k: v for k, v in t.items() if k in ("videoId", "title", "length", "videoType", "artists", "album", "views", "duration", "duration_seconds", "year")} for t in parse_watch_playlist(pp)]
exp_related_id = get_tab_browse_ids(wn).get("MUSIC_PAGE_TYPE_TRACK_RELATED")
for item in pp:
    item["playlistPanelVideoRenderer"].pop("menu", None)

# related
r = ld("related")
secs = [x for x in r["contents"]["sectionListRenderer"]["contents"] if "musicCarouselShelfRenderer" in x]
keep = []
for x in secs:
    sh = x["musicCarouselShelfRenderer"]
    title = sh["header"]["musicCarouselShelfBasicHeaderRenderer"]["title"]["runs"][0]["text"].lower()
    if title in ("you might also like", "similar artists"):
        sh["contents"] = sh["contents"][:N]
        keep.append(x)
r = {"contents": {"sectionListRenderer": {"contents": keep}}}
exp_rel = parse_mixed_content(keep)
exp_related = [{"title": s["title"], "contents": [{k: v for k, v in c.items() if k in ("videoId", "title", "artists", "album", "duration", "duration_seconds", "year", "browseId")} for c in s["contents"]]} for s in exp_rel]

# playlist
p = ld("playlist")
two = p["contents"]["twoColumnBrowseResultsRenderer"]
shelf = two["secondaryContents"]["sectionListRenderer"]["contents"][0]["musicPlaylistShelfRenderer"]
shelf["contents"] = shelf["contents"][:N]
for k in list(shelf):
    if k not in ("contents",): shelf.pop(k)
exp_pl = [{k: v for k, v in song.items() if k in ("videoId", "title", "artists", "album", "duration", "duration_seconds")}
          for song in parse_playlist_items(shelf["contents"])]
for c in shelf["contents"]:
    c["musicResponsiveListItemRenderer"].pop("menu", None)
head = two["tabs"][0]["tabRenderer"]["content"]["sectionListRenderer"]["contents"][0]["musicResponsiveHeaderRenderer"]
two["tabs"][0]["tabRenderer"]["content"]["sectionListRenderer"]["contents"][0] = {"musicResponsiveHeaderRenderer": {"title": head["title"], "secondSubtitle": head["secondSubtitle"]}}
p = {"contents": {"twoColumnBrowseResultsRenderer": two}}
keys = lambda d, ks: d
out.mkdir(parents=True, exist_ok=True)
for name, obj in (("ytm-search", s), ("ytm-watch", w), ("ytm-related", r), ("ytm-playlist", p)):
    (out / f"{name}.json").write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
(out / "ytm-expected.json").write_text(json.dumps({
    "search": [{k: v for k, v in x.items() if k in ("videoId", "title", "artists", "album", "duration", "duration_seconds", "year", "videoType", "isExplicit")} for x in exp_search],
    "watch": exp_watch, "related_browse": exp_related_id, "related": exp_related, "playlist": exp_pl,
    "playlist_title": head["title"]["runs"][0]["text"],
}, ensure_ascii=False, indent=1), encoding="utf8")
print("ok", len(exp_search), len(exp_watch), len(exp_related), len(exp_pl))
