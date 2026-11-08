package com.nowplaying.discovery.engine

import kotlin.random.Random

/**
 * The service's queue: the songs it was asked to play, which one is current, and what comes next
 * under repeat and shuffle. Pure Kotlin so the rules are tested on the JVM.
 *
 * Only songs [isPlayable] (their complete audio is on the phone) are ever chosen as current or next,
 * matching the page's native rule that an unready song is skipped rather than played as a preview.
 *
 * Shuffle plays every song of the list once per round in a random order. The following round is
 * drawn in advance, freshly shuffled, and never opens with the song that closed this one, so a song
 * is not heard twice in a row and "what's next" is known before the current song ends (the mixer
 * needs it early to blend). Peeks never change anything; [advance] and [previous] commit, and give
 * the same answer the matching peek gave.
 */
class PlayQueue<T>(
  private val keyOf: (T) -> String,
  private val isPlayable: (T) -> Boolean,
  private val random: Random = Random.Default,
) {
  enum class Repeat { OFF, ONE, ALL }

  var items: List<T> = emptyList()
    private set
  /** Index into [items] of the current song, or -1 when there is none. */
  var index: Int = -1
    private set
  var repeat: Repeat = Repeat.OFF
  var shuffle: Boolean = false
    set(value) {
      if (field == value) return
      field = value
      startRound()
    }

  /** This round's play order (indices into [items]); under shuffle the current song comes first. */
  private var order: List<Int> = emptyList()
  /** The round after this one, drawn in advance. */
  private var nextRound: List<Int> = emptyList()

  val current: T? get() = items.getOrNull(index)

  fun set(items: List<T>, startIndex: Int) {
    this.items = items
    index = if (items.isEmpty()) -1 else startIndex.coerceIn(0, items.size - 1)
    startRound()
  }

  /** Jump to a song of the queue by its key. Returns false when it is not in the queue. */
  fun select(key: String): Boolean = select(items.indexOfFirst { keyOf(it) == key })

  /** Jump to [i] (a tap on a queue row). Under shuffle the rest of the round is drawn afresh. */
  fun select(i: Int): Boolean {
    if (i !in items.indices) return false
    index = i
    startRound()
    return true
  }

  /**
   * What plays when the current song ends by itself: repeat-one repeats it, otherwise the next
   * playable song, carrying on into the next round only under repeat-all. Null means stop.
   */
  fun peekAfterEnd(): Int? = if (repeat == Repeat.ONE && index >= 0) index else findNext(repeat == Repeat.ALL)?.first

  /** The listener pressed Next: always moves on, even under repeat-one, wrapping like the page's Next. */
  fun peekNextPressed(): Int? = findNext(wrap = true)?.first

  /** The previous playable song of this round, or null at its start. */
  fun peekPrevious(): Int? {
    val pos = order.indexOf(index)
    for (p in pos - 1 downTo 0) if (isPlayable(items[order[p]])) return order[p]
    return null
  }

  /** Commit what [peekAfterEnd] ([pressed] false) or [peekNextPressed] ([pressed] true) said. */
  fun advance(pressed: Boolean): Int? {
    if (!pressed && repeat == Repeat.ONE && index >= 0) return index
    val (i, wrapped) = findNext(wrap = pressed || repeat == Repeat.ALL) ?: return null
    if (wrapped) {
      order = nextRound
      nextRound = drawRound(avoidFirst = order.lastOrNull() ?: -1)
    }
    index = i
    return i
  }

  /** Commit what [peekPrevious] said. */
  fun previous(): Int? {
    val i = peekPrevious() ?: return null
    index = i
    return i
  }

  /** The next playable index and whether reaching it crosses into the next round. */
  private fun findNext(wrap: Boolean): Pair<Int, Boolean>? {
    val pos = order.indexOf(index)
    for (p in pos + 1 until order.size) if (isPlayable(items[order[p]])) return order[p] to false
    if (!wrap) return null
    for (i in nextRound) if (isPlayable(items[i])) return i to true
    return null
  }

  private fun startRound() {
    val all = items.indices.toList()
    order = when {
      !shuffle -> all
      index >= 0 -> listOf(index) + all.filter { it != index }.shuffled(random)
      else -> all.shuffled(random)
    }
    nextRound = drawRound(avoidFirst = order.lastOrNull() ?: -1)
  }

  private fun drawRound(avoidFirst: Int): List<Int> {
    val all = items.indices.toList()
    if (!shuffle) return all
    val r = all.shuffled(random).toMutableList()
    if (r.size > 1 && r.first() == avoidFirst) r.add(r.removeAt(0))
    return r
  }
}
