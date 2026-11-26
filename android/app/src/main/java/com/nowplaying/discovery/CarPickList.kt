package com.nowplaying.discovery

/**
 * CAR-PICK-ON-PLAYER-001 (owner, 2026-11-23): "the heart button doesn't immediately bring up the
 * playlist selector on android auto".
 *
 * Android Auto will not let a media app open a browse list from a player button, so the star used to
 * save the song and ask the driver to go back to a list. Instead the picker comes to the player: after
 * the heart, the player's own buttons become one per playlist, then Cancel. Media3's SessionCommand
 * equality ignores a command's extras, so every one of these buttons can carry the same action with
 * its own list id.
 *
 * CAR-HEART-ALWAYS-001 (owner, 2026-11-23, again: "hearting a song doesnt bring up the playlist sub menu
 * like desired"): the heart ALWAYS brings the picker. Two cases used to bring nothing: a song already
 * starred (the press took the star off instead), and a listener with no playlist the car knew of (there
 * was nothing to offer). Now an already-starred song gets the same picker with "Remove star" in it, and
 * with no playlist the picker offers to start one.
 *
 * Only the choice is here — no Media3 or Android types — so it can be tested on the JVM.
 */
object CarPickList {
  /** One button in the picker: [listId] empty means Cancel; [NEW_LIST] and [UNSTAR] are the two that are not lists. */
  data class Choice(val listId: String, val label: String, val holds: Boolean)

  /** Android Auto 17.9 shows four buttons before its overflow menu; Cancel takes the last of them. */
  const val VISIBLE = 4

  /** A list id no saved playlist can have: start the car's own list and put the song in it. */
  const val NEW_LIST = "airwave:new-list"
  /** The name of that list. The page finds it by this name the next time, so it is made once. */
  const val NEW_LIST_NAME = "Car picks"
  /** The player's heart for a song that is already starred: it opens these choices, it does not take the star off. */
  const val STARRED_LABEL = "Starred: choose playlist"
  /** Take the star off again (offered only when the song was starred before the press). */
  const val UNSTAR = "airwave:unstar"

  /**
   * The buttons for starring a song into [lists] (id to name, in the listener's own order). With no lists
   * the one choice is to start one. [starredBefore] adds "Remove star", because the heart no longer takes
   * a star off by itself. Cancel is always last.
   *
   * CAR-NO-DUP-LIST-001 (owner, 2026-11-26): "ensure on android auto songs that are hearted / starred cant be
   * added to the same playlist". A list in [holding] (it already has the song) is not offered at all; it used
   * to be offered last as "Already in ...". A song in every playlist gets only the way back (and Remove star).
   */
  fun choices(lists: List<Pair<String, String>>, holding: Set<String>, starredBefore: Boolean = false): List<Choice> {
    val free = lists.filter { (id, _) -> id !in holding }.map { (id, name) -> Choice(id, name.ifBlank { "Playlist" }, false) }
    val offered = if (lists.isEmpty()) listOf(Choice(NEW_LIST, NEW_LIST_NAME, false)) else free
    return offered + (if (starredBefore) listOf(Choice(UNSTAR, "Remove star", false)) else emptyList()) + Choice("", "Cancel", false)
  }

  /** CAR-NO-DUP-LIST-001: whether a pick of [listId] may add the song, given the lists already [holding] it. A stale picker or a second tap never adds twice. */
  fun mayAdd(listId: String, holding: Set<String>): Boolean = listId !in holding

  /** No playlist is offered and none can be started: the song is already in every one of them. */
  private fun inEveryList(choices: List<Choice>): Boolean = choices.none { it.listId.isNotEmpty() && it.listId != UNSTAR && it.listId != CANCEL }

  /** The words on a choice's button. */
  fun buttonLabel(c: Choice): String = when {
    c.listId.isEmpty() -> "Cancel"
    c.listId == UNSTAR -> "Remove star"
    c.listId == NEW_LIST -> "New playlist \u201c${c.label}\u201d"
    c.holds -> "Already in ${c.label}"
    else -> "Add to ${c.label}"
  }

  /**
   * What the car says when the picker opens. ONE sentence: the car shows only a message's first sentence
   * (PlaybackService.tellDriver), and the two-sentence wording this replaced lost "Choose a playlist" there, so
   * the driver was told the song was starred and never that the buttons had become the playlists.
   */
  fun hint(songTitle: String?, choices: List<Choice>, starredBefore: Boolean = false): String {
    val song = songTitle?.takeIf { it.isNotBlank() }?.let { "\u201c${it.take(40)}\u201d" } ?: "This song"
    val state = if (starredBefore) "$song is already starred" else "$song starred"
    val lists = choices.filter { it.listId.isNotEmpty() && it.listId != UNSTAR }
    if (lists.isEmpty()) return "$state: it is already in every playlist"
    if (lists.size == 1 && lists[0].listId == NEW_LIST) return "$state: start a playlist for it"
    val shown = minOf(lists.size, VISIBLE - 1)
    return if (lists.size > shown) "$state: choose a playlist, or open the menu for all ${lists.size}"
    else "$state: choose a playlist"
  }

  /**
   * CAR-PICK-LIST-001 (owner, 2026-11-23): "on android auto the playlist menu should replace the current playing
   * track player and quick controls, open up a list where the user can select playlist then get taken back to the
   * song player once the track is added to the right playlist. Ensure hearting songs on radio works the same way".
   *
   * Measured on the head unit (Android Auto 17.9): the player draws its buttons as pictures with no words, so two
   * playlists were two identical hearts, and its overflow menu is more of the same pictures. A list has names.
   * Android Auto leaves its player for the app's lists when the app has nothing playing to show (also measured),
   * so for the length of the choice the car is shown these rows instead; the music itself never stops.
   */
  data class Row(val listId: String, val title: String, val subtitle: String)

  /** The row that takes the driver back to the song without adding it anywhere. */
  const val CANCEL = "airwave:cancel"
  /** Media ids of the list's rows: `pick/<playlist or choice>/<song>`, each part URL-encoded. */
  const val ROW_PREFIX = "pick/"
  /** For tests only: show the list (true) or the player's buttons (false) whoever is asking. */
  @Volatile var listForTests: Boolean? = null

  /** The rows of the car's playlist list for [choices]: the way back first, then every choice by name. */
  fun rows(songTitle: String?, choices: List<Choice>): List<Row> {
    val song = songTitle?.takeIf { it.isNotBlank() }?.let { "\u201c${it.take(60)}\u201d" }
    val starredBefore = choices.any { it.listId == UNSTAR }
    val back = Row(
      CANCEL,
      if (song != null) "Back to $song" else "Back to the song",
      if (inEveryList(choices)) "${if (starredBefore) "It was already starred" else "It is starred"} and already in every playlist."
      else "${if (starredBefore) "It was already starred" else "It is starred"}. Pick a playlist below to add it too.",
    )
    return listOf(back) + choices.filter { it.listId.isNotEmpty() }.map { c ->
      Row(
        c.listId,
        buttonLabel(c),
        when {
          c.listId == UNSTAR -> "${song ?: "This song"} will no longer be starred"
          c.listId == NEW_LIST -> "Starts it with ${song ?: "this song"}"
          c.holds -> "Tap to go back to the song"
          else -> song ?: "This song"
        },
      )
    }
  }

  fun rowId(listId: String, songId: String): String =
    ROW_PREFIX + java.net.URLEncoder.encode(listId, "UTF-8") + "/" + java.net.URLEncoder.encode(songId, "UTF-8")

  /** The (playlist or choice, song) a row id stands for; null for any other id. */
  fun parseRow(mediaId: String): Pair<String, String>? {
    if (!mediaId.startsWith(ROW_PREFIX)) return null
    val parts = mediaId.removePrefix(ROW_PREFIX).split('/')
    if (parts.size != 2 || parts.any { it.isEmpty() }) return null
    return runCatching { java.net.URLDecoder.decode(parts[0], "UTF-8") to java.net.URLDecoder.decode(parts[1], "UTF-8") }.getOrNull()
  }

  /** What the car says after a pick. */
  fun added(listName: String, already: Boolean): String =
    if (already) "Already in $listName" else "Added to $listName"
}
