package com.nowplaying.discovery

import java.text.Normalizer
import java.util.Locale

/**
 * CAR-SEARCH-TYPES-001 (owner, 2026-11-15): the car's search gets the same icons as the phone's
 * results (a CD for singles, an album cover, two people for features, a note for lyrics) plus "All"
 * and a listen-and-identify icon, so a driver can say a single's name, an album's name or some lyrics,
 * or let the phone hear the music playing.
 *
 * Android Auto draws a media app's search screen itself and allows no buttons on it, so the icons
 * are offered where Android Auto does let an app show them: as the first row of every car search's
 * results (tap one to see only that kind) and on a Search tab (tap one before searching and the next
 * voice search looks for that kind). A spoken lead word ("album …", "lyrics …", "single …",
 * "what song is this") picks a kind too. Plain Kotlin, so the rules are unit tested on the JVM.
 *
 * RESULT-ARTIST-001 (owner, 2026-11-15): "add a single user icon for artist to the search results
 * list and android auto so users can search by artist". Artists (one person) lists only the songs
 * credited to the artist the words name; "artist …", "songs by …" and "music by …" pick it by voice.
 */
enum class CarSearchType(val key: String, val title: String, val hint: String, val icon: String) {
  ALL("all", "All", "Everything your search finds", "car_type_all"),
  ARTISTS("artists", "Artists", "Say an artist's name to hear their songs", "car_type_artist"),
  SINGLES("singles", "Singles", "Say a song or single name", "car_type_singles"),
  ALBUMS("albums", "Albums", "Say an album name", "car_type_albums"),
  FEATURES("features", "Features", "Say an artist to hear the songs they are featured on", "car_type_features"),
  LYRICS("lyrics", "Lyrics", "Say a line you remember from the song", "car_type_lyrics"),
  IDENTIFY("identify", "Identify", "Listen to the music playing and name it", "car_type_identify");

  companion object {
    fun of(key: String?): CarSearchType? = entries.firstOrNull { it.key == key }
    /** The kinds a search can be narrowed to (Identify is its own action, not a filter). */
    val FILTERS = listOf(ALL, ARTISTS, SINGLES, ALBUMS, FEATURES, LYRICS)
  }
}

object CarSearch {
  /** A kind chosen on the Search tab applies to the next search made within this long. */
  const val STICKY_MS = 3 * 60_000L

  @Volatile private var picked: Pair<CarSearchType, Long>? = null
  /** The words of the car's last search, so the Search tab's icons can narrow them. */
  @Volatile var lastWords: String? = null

  /** The driver tapped a kind on the Search tab at [now] (All clears it). */
  fun pick(type: CarSearchType, now: Long) { picked = if (type == CarSearchType.ALL || type == CarSearchType.IDENTIFY) null else type to now }
  /** The kind picked on the Search tab, while it still applies. */
  fun picked(now: Long): CarSearchType? = picked?.takeIf { now - it.second in 0..STICKY_MS }?.first

  /** Explicit typed/assistant station requests, independent of the music-result filter enum. */
  fun explicitRadioQuery(raw: String): String? = Regex("^(?:play |listen to )?(?:radio(?: station)?|station)\\s+(.+)$", RegexOption.IGNORE_CASE)
    .matchEntire(raw.trim().replace(Regex("\\s+"), " "))?.groupValues?.get(1)?.trim()?.takeIf { it.isNotBlank() }?.take(100)

  /** Station-shaped plain queries try real station results; the service falls back to music if none match. */
  fun radioQuery(raw: String, sticky: CarSearchType? = null): String? {
    explicitRadioQuery(raw)?.let { return it }
    val words = raw.trim().replace(Regex("^(?:play |listen to |tune to |find |search for )", RegexOption.IGNORE_CASE), "").trim()
    if (parse(words, sticky).first != CarSearchType.ALL) return null
    val alias = RadioNames.parts(words) ?: return null
    return if (alias.call != null && alias.frequency == null) alias.call else words.take(100)
  }

  private val LEADS: List<Pair<Regex, CarSearchType>> = listOf(
    Regex("^(?:what(?:'s| is) this song|what song is (?:this|playing)|identify(?: this| the)?(?: song| music)?|shazam(?: this)?|name this song|listen)$") to CarSearchType.IDENTIFY,
    Regex("^(?:(?:the |an? )?albums? (?:called |named )?|(?:search |find )(?:the |an? )?albums? (?:called |named )?)") to CarSearchType.ALBUMS,
    Regex("^(?:(?:the )?lyrics? |(?:the )?words |(?:a |the )?song (?:that goes|with the (?:lyrics?|words)) |(?:search |find )(?:the )?lyrics? )") to CarSearchType.LYRICS,
    Regex("^(?:(?:the |an? )?singles? (?:called |named )?|(?:the |an? )?song (?:called |named )|(?:search |find )(?:the |an? )?(?:single|song) (?:called |named )?)") to CarSearchType.SINGLES,
    Regex("^(?:(?:songs? |music )?(?:featuring |feat\\.? |ft\\.? )|features? (?:by |with |of )?)") to CarSearchType.FEATURES,
    Regex("^(?:(?:the |an )?artists? (?:called |named )?|(?:songs?|music|tracks?) by |(?:search |find )(?:the |an )?artists? (?:called |named )?)") to CarSearchType.ARTISTS,
  )

  /**
   * What was said, split into the kind its lead words ask for and the words to search. A search with
   * no lead words keeps [sticky] (a kind picked on the Search tab), else it is a search for everything.
   */
  fun parse(raw: String, sticky: CarSearchType? = null): Pair<CarSearchType, String> {
    val said = raw.trim().replace(Regex("\\s+"), " ")
    val low = said.lowercase(Locale.ROOT)
    for ((lead, type) in LEADS) {
      val m = lead.find(low) ?: continue
      if (type == CarSearchType.IDENTIFY) return type to ""
      val rest = said.substring(m.range.last + 1).trim()
      if (rest.isNotEmpty()) return type to rest
    }
    return (sticky?.takeIf { it != CarSearchType.IDENTIFY } ?: CarSearchType.ALL) to said
  }

  private val FEAT = Regex("\\((?:feat\\.?|ft\\.?|featuring|with)\\s[^)]*\\)|\\[(?:feat\\.?|ft\\.?|featuring|with)\\s[^]]*]|\\s(?:feat\\.?|ft\\.?|featuring)\\s.*$", RegexOption.IGNORE_CASE)
  private val SINGLE_SUFFIX = Regex("\\s*[-\\u2013\\u2014]\\s*single\\s*$|\\s*\\(single\\)\\s*$|\\s*\\[single]\\s*$", RegexOption.IGNORE_CASE)

  private fun norm(s: String) = Normalizer.normalize(s.replace(FEAT, "").replace(SINGLE_SUFFIX, ""), Normalizer.Form.NFKD)
    .replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT).replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()

  /**
   * The kinds a song is, by the same rules as the phone's icon menu (web `result-types.ts`): a single
   * when its release is named after it, an album song when it sits on a differently named release, a
   * feature when more than one artist is credited or the title credits a guest. `lyrics` comes only
   * from the page (a lyric match), in [pageKinds].
   */
  fun kindsOf(title: String, artist: String, album: String?, pageKinds: Set<String> = emptySet(), words: String? = null): Set<String> {
    val out = pageKinds.filter { it in KINDS }.toMutableSet()
    if (words != null && artistNames(artist).any { namesArtist(words, it) }) out += "artist"
    val rel = album?.trim().orEmpty()
    if (rel.isNotEmpty()) {
      val single = SINGLE_SUFFIX.containsMatchIn(rel) || norm(rel).let { it.isNotEmpty() && it == norm(title) }
      out += if (single) "single" else "album"
    }
    if (artist.contains(", ") || artist.contains(" & ") || FEAT.containsMatchIn(title)) out += "feature"
    return out
  }

  val KINDS = setOf("single", "album", "feature", "lyrics", "artist")

  private fun plain(s: String) = Normalizer.normalize(s, Normalizer.Form.NFKD)
    .replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT).replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()

  /** The credited names in a song's artist line ("Lil Tecca, Ken Carson", "A & B"). */
  fun artistNames(artist: String): List<String> = artist.split(Regex("\\s*,\\s*|\\s+&\\s+")).filter { it.isNotBlank() }

  /**
   * RESULT-ARTIST-001, the same rule as the phone (web `namesArtistIn`): the words name an artist when
   * they are the name, hold the whole name ("ken carson songs"), or start it ("ken car"). One word of
   * the name ("carson") does not.
   */
  fun namesArtist(words: String, name: String): Boolean {
    val q = plain(words)
    val a = plain(name)
    if (q.isEmpty() || a.isEmpty()) return false
    return q == a || " $q ".contains(" $a ") || (q.length >= 3 && a.startsWith(q))
  }

  /** Whether a song with [kinds] shows under [type]. */
  fun matches(type: CarSearchType, kinds: Set<String>): Boolean = when (type) {
    CarSearchType.ALL -> true
    CarSearchType.ARTISTS -> "artist" in kinds
    CarSearchType.SINGLES -> "single" in kinds
    CarSearchType.ALBUMS -> "album" in kinds
    CarSearchType.FEATURES -> "feature" in kinds
    CarSearchType.LYRICS -> "lyrics" in kinds
    CarSearchType.IDENTIFY -> false
  }
}
