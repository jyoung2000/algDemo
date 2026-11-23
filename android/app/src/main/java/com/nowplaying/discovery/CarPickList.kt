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
 * Only the choice is here — no Media3 or Android types — so it can be tested on the JVM.
 */
object CarPickList {
  /** One button in the picker: [listId] empty means Cancel. */
  data class Choice(val listId: String, val label: String, val holds: Boolean)

  /** Android Auto 17.9 shows four buttons before its overflow menu; Cancel takes the last of them. */
  const val VISIBLE = 4

  /**
   * The buttons for starring [songTitle] into [lists] (id to name, in the listener's own order), with
   * the lists that already hold the song marked. A list the song is already in is offered last: the
   * useful choices come first. With no lists at all there is nothing to pick, so the caller keeps the
   * ordinary buttons and the hint about making a list in the app.
   */
  fun choices(lists: List<Pair<String, String>>, holding: Set<String>): List<Choice> {
    if (lists.isEmpty()) return emptyList()
    val (free, held) = lists.map { (id, name) -> Choice(id, name.ifBlank { "Playlist" }, id in holding) }
      .partition { !it.holds }
    return free + held + Choice("", "Cancel", false)
  }

  /** What the car says when the picker opens. */
  fun hint(songTitle: String?, choices: List<Choice>): String {
    val song = songTitle?.takeIf { it.isNotBlank() }?.let { "\u201c${it.take(40)}\u201d" } ?: "This song"
    if (choices.isEmpty()) return "$song is starred. Make a playlist in jPlay to save it to one."
    val pickable = choices.count { it.listId.isNotEmpty() }
    val shown = minOf(pickable, VISIBLE - 1)
    return if (pickable > shown) "$song is starred. Choose a playlist, or open the menu for all $pickable."
    else "$song is starred. Choose a playlist."
  }

  /** What the car says after a pick. */
  fun added(listName: String, already: Boolean): String =
    if (already) "Already in $listName" else "Added to $listName"
}
