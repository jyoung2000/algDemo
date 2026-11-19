package com.nowplaying.discovery

/**
 * CAR-MOOD-001 (owner, 2026-11-19): with the phone app closed, the car's now playing queue follows the
 * listening mood. The order comes from the engine page ([MediaHub.moodOrder]); this decides which
 * songs may move and puts the engine's order into their slots.
 *
 * Movable = after the song playing, and either from the Discover queue (a plain song id) or any list
 * while shuffle is on. Saved playlists and albums (encoded ids) keep their order unless shuffle is on;
 * radio never moves. The song playing and everything before it never move.
 */
object CarMood {
  /** Media ids of the songs after [current] that may be re-arranged. */
  fun movable(ids: List<String>, current: Int, shuffle: Boolean): List<String> =
    ids.drop((current + 1).coerceAtLeast(0)).filter { id -> isSong(id) && (shuffle || isDiscover(id)) }.distinct()

  /** Plain song ids are the Discover queue's; lists and albums carry a path ("playlist/…", "calbum/…"). */
  fun isDiscover(id: String): Boolean = '/' !in id

  private fun isSong(id: String): Boolean = id.isNotBlank() && !id.startsWith("radio")

  /**
   * The whole queue with the movable songs in [order]'s order, each in one of the movable slots. Ids
   * in [order] that are not movable are ignored; movable ones it leaves out keep their relative order
   * after the ones it names. Null when nothing changes.
   */
  fun apply(ids: List<String>, current: Int, shuffle: Boolean, order: List<String>): List<String>? {
    val movable = movable(ids, current, shuffle).toSet()
    if (movable.size < 2) return null
    val named = order.filter { it in movable }.distinct()
    val rest = ids.drop((current + 1).coerceAtLeast(0)).filter { it in movable && it !in named }.distinct()
    val queue = ArrayDeque(named + rest)
    val slotted = HashSet<String>() // by the slot's original id: a repeated id keeps its later copy
    val out = ids.mapIndexed { i, id ->
      if (i > current && id in movable && slotted.add(id)) queue.removeFirst() else id
    }
    return if (out == ids) null else out
  }
}
