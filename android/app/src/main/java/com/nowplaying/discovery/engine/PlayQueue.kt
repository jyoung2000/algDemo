package com.nowplaying.discovery.engine

import kotlin.random.Random

/**
 * The service's queue: the songs it was asked to play, which one is current, and what comes next
 * under repeat and shuffle. Pure Kotlin so the rules are tested on the JVM.
 *
 * Automatic choices only use [isPlayable] songs (their complete audio is on the phone).
 * Explicit selection can choose an unready song, which the service waits for.
 *
 * Shuffle plays every ready song once per round. Heard keys survive library pushes, metadata
 * refreshes, reordering and explicit selection; newly ready songs get a turn before repeats.
 * The following round is drawn in advance so peeks are stable and non-consuming for the mixer.
 */
class PlayQueue<T>(
  private val keyOf: (T) -> String,
  private val isPlayable: (T) -> Boolean,
  private val random: Random = Random.Default,
  /**
   * SHUFFLE-ONCE-001 (owner, 2026-11-24: "shuffle should only play a song once before finding a new song"): a song the
   * page marks as heard before (the now playing queue's songs finished or skipped in any session). Under shuffle such a
   * song is never chosen again, and while the list holds any, no new round starts over heard songs: the queue stops and
   * waits for a new song. A list with no such marks (a saved playlist) keeps its rounds.
   */
  private val heardBefore: (T) -> Boolean = { false },
  /** ARTIST-RUN-001: the artist credit of a song, for the four-in-a-row limit of the now playing queue's shuffle. */
  private val artistOf: (T) -> String = { "" },
) {
  /** ARTIST-RUN-001: the artists (artistKey) of the last songs made current, oldest first. */
  private val playedArtists = ArrayDeque<String>()
  private var lastPlayedKey: String? = null
  private fun played(i: Int) {
    // One song is one play, however many paths (set, select, advance) make it current.
    val key = keyOf(items[i])
    if (key == lastPlayedKey) return
    lastPlayedKey = key
    playedArtists.addLast(artistKey(artistOf(items[i])))
    while (playedArtists.size > MAX_ARTIST_RUN) playedArtists.removeFirst()
  }
  /** The artist of the last MAX_ARTIST_RUN songs when they were all by one artist, else "". */
  private fun runArtist(): String {
    if (playedArtists.size < MAX_ARTIST_RUN) return ""
    val a = playedArtists.first()
    return if (a.isNotEmpty() && playedArtists.all { it == a }) a else ""
  }
  /**
   * SHUFFLE-ONCE-001: the list is the now playing queue, whose songs play once under shuffle (the page says so, and a
   * list whose songs carry heard marks is one too, so a queue restored without the page keeps the rule).
   */
  var playsOnce = false
  private val once: Boolean get() = shuffle && (playsOnce || items.any(heardBefore))
  private fun fresh(i: Int): Boolean = isPlayable(items[i]) && !heardBefore(items[i])
  /** ONE is the old id for infinite song repeat; ALL survives only for legacy saved states. */
  enum class Repeat { OFF, ONE, ALL, ONCE, TWICE }

  val repeatsSong: Boolean get() = repeat == Repeat.ONE || repeat == Repeat.ONCE || repeat == Repeat.TWICE
  /** A decoder-confirmed end has started one more full play; show the number still owed. */
  fun consumeRepeat(): Repeat {
    repeat = when (repeat) { Repeat.TWICE -> Repeat.ONCE; Repeat.ONCE -> Repeat.OFF; else -> repeat }
    return repeat
  }

  var items: List<T> = emptyList()
    private set
  /** Index into [items] of the current song, or -1 when there is none. */
  var index: Int = -1
    private set
  var repeat: Repeat = Repeat.OFF
    set(value) { if (field != value) { field = value; version++; onRepeatChanged?.invoke() } }
  /** Told of every change, including the ones made here: a count used up, or dropped with its song. */
  var onRepeatChanged: (() -> Unit)? = null
  var shuffle: Boolean = false
    set(value) {
      if (field == value) return
      field = value
      // Toggling the mode is not a new round: songs already played this round stay played.
      rebuildOrder()
    }

  /** Bumped by every change of items, current song, mode or round, so a saver can skip unchanged state. */
  var version: Long = 0
    private set

  /**
   * NATIVE-COLD-STATE-001: the round by key (not index), so a restored queue carries on the same
   * shuffle round instead of starting a new one after the process died.
   */
  data class Control(
    val index: Int,
    val repeat: Repeat,
    val shuffle: Boolean,
    val order: List<String>,
    val nextRound: List<String>,
    val heard: List<String>,
  )

  fun control(): Control = Control(
    index, repeat, shuffle,
    order.map { keyOf(items[it]) }, nextRound.map { keyOf(items[it]) }, heard.toList(),
  )

  /**
   * Put back [items] with a saved [c]. Saved keys keep their places; a key no longer present is
   * dropped from the order (heard keys stay until the round ends, as in [set]); an item the saved
   * order lacks is appended, drawn at random only under shuffle. Nothing here starts a new round.
   */
  fun restore(items: List<T>, c: Control) {
    this.items = items
    index = if (items.isEmpty()) -1 else c.index.coerceIn(0, items.size - 1)
    repeat = c.repeat
    shuffle = c.shuffle // its rebuild is replaced below by the saved round
    heard.clear()
    version++
    if (items.isEmpty()) { order = emptyList(); nextRound = emptyList(); return }
    val byKey = HashMap<String, Int>()
    items.indices.forEach { byKey.putIfAbsent(keyOf(items[it]), it) }
    fun remap(keys: List<String>): List<Int> {
      val seen = HashSet<Int>()
      val kept = keys.mapNotNull { byKey[it] }.filter { seen.add(it) }
      val rest = items.indices.filter { it !in seen }
      return kept + if (c.shuffle) rest.shuffled(random) else rest
    }
    order = if (c.shuffle) remap(c.order) else items.indices.toList()
    nextRound = if (c.shuffle) remap(c.nextRound) else items.indices.toList()
    heard += c.heard
    current?.let { heard += keyOf(it) }
  }

  /** This round's play order (indices into [items]); under shuffle the current song comes first. */
  private var order: List<Int> = emptyList()
  /** The round after this one, drawn in advance. */
  private var nextRound: List<Int> = emptyList()
  // Keep removed keys until the round ends: removing/re-adding a heard song is not a new turn.
  private val heard = mutableSetOf<String>()

  val current: T? get() = items.getOrNull(index)

  fun set(items: List<T>, startIndex: Int) {
    val old = this.items
    val oldKey = current?.let(keyOf)
    val oldOrder = order.map { keyOf(old[it]) }
    val oldNext = nextRound.map { keyOf(old[it]) }
    version++
    this.items = items
    index = if (items.isEmpty()) -1 else startIndex.coerceIn(0, items.size - 1)
    if (index >= 0) played(index)
    if (oldKey != null && current?.let(keyOf) != oldKey && (repeat == Repeat.ONCE || repeat == Repeat.TWICE)) repeat = Repeat.OFF
    if (items.isEmpty()) {
      heard.clear()
      order = emptyList()
      nextRound = emptyList()
      return
    }
    // A genuinely different list (a car or phone picking another playlist) is a new round.
    // Library pushes, page loads, adds and removals of the same list keep what was heard.
    if (old.isEmpty() || !sameList(old, items)) {
      startRound()
      return
    }
    if (!shuffle) {
      rebuildOrder()
      return
    }
    // Preserve random order by identity, not position. Only genuinely new keys need a draw.
    val byKey = items.indices.associateBy { keyOf(items[it]) }
    fun remap(keys: List<String>): List<Int> {
      val kept = keys.mapNotNull { byKey[it] }
      val known = keys.toHashSet()
      return kept + items.indices.filter { keyOf(items[it]) !in known }.shuffled(random)
    }
    order = remap(oldOrder)
    nextRound = remap(oldNext)
    // set() also serves page loads and controller choices, not only library pushes.
    if (current?.let(keyOf) != oldKey) {
      val chosen = index
      index = byKey[oldKey] ?: -1
      select(chosen)
    }
  }

  /** Swap in fresh copies of the same songs (same keys, same positions) without disturbing the order or the round. */
  fun refresh(items: List<T>): Boolean {
    if (items.size != this.items.size || items.indices.any { keyOf(items[it]) != keyOf(this.items[it]) }) return false
    this.items = items
    version++
    return true
  }

  /** Jump to a song of the queue by its key. Returns false when it is not in the queue. */
  fun select(key: String): Boolean = select(items.indexOfFirst { keyOf(it) == key })

  /** Explicit replay is allowed, but must not erase what automatic shuffle already played. */
  fun select(i: Int): Boolean {
    if (i !in items.indices) return false
    if (i != index && (repeat == Repeat.ONCE || repeat == Repeat.TWICE)) repeat = Repeat.OFF
    if (shuffle) {
      // Native natural-end and blend handoffs also select the peek. Commit that prepared round,
      // just as advance() would, instead of redrawing the rest after each song.
      val next = findNext(wrap = true)
      if (next?.first == i && next.second) commitRound(i)
    }
    heard += keyOf(items[i])
    index = i
    played(i)
    version++
    return true
  }

  /**
   * CAR-MOOD-001: under shuffle the next songs come from this round's drawn order, not the list's.
   * [roundAhead] names the songs of the round still to come, in play order; [arrangeRound] plays the
   * ones [keys] names in that order, in the same slots. Songs heard this round never move back.
   */
  fun roundAhead(): List<String> {
    if (!shuffle) return emptyList()
    return order.map { keyOf(items[it]) }.filter { it !in heard && it != current?.let(keyOf) }
  }

  fun arrangeRound(keys: List<String>): Boolean {
    if (!shuffle) return false
    val rank = HashMap<String, Int>()
    keys.forEachIndexed { i, k -> rank.putIfAbsent(k, i) }
    val now = current?.let(keyOf)
    val slots = order.indices.filter { val k = keyOf(items[order[it]]); k in rank && k !in heard && k != now }
    if (slots.size < 2) return false
    val sorted = slots.map { order[it] }.sortedBy { rank[keyOf(items[it])] }
    val next = order.toMutableList()
    slots.forEachIndexed { j, s -> next[s] = sorted[j] }
    if (next == order) return false
    order = next
    version++
    return true
  }

  /** On a natural end, repeat this song while extra plays remain; then move to the next. */
  fun peekAfterEnd(): Int? = if (repeatsSong && index >= 0) index else findNext(repeat == Repeat.ALL)?.first

  /** The listener pressed Next: always moves on, including under song repeat. */
  fun peekNextPressed(): Int? = findNext(wrap = true)?.first

  /** The previous playable song of this round, or null at its start. */
  fun peekPrevious(): Int? {
    val pos = order.indexOf(index)
    for (p in pos - 1 downTo 0) if (isPlayable(items[order[p]])) return order[p]
    return null
  }

  /** Commit what [peekAfterEnd] ([pressed] false) or [peekNextPressed] ([pressed] true) said. */
  fun advance(pressed: Boolean): Int? {
    if (!pressed && repeatsSong && index >= 0) { consumeRepeat(); return index }
    val (i, wrapped) = findNext(wrap = pressed || repeat == Repeat.ALL) ?: return null
    if (pressed && i != index && (repeat == Repeat.ONCE || repeat == Repeat.TWICE)) repeat = Repeat.OFF
    if (wrapped) commitRound(i)
    index = i
    played(i)
    version++
    // Tracked in order mode too, so switching shuffle on mid-list keeps those songs played.
    heard += keyOf(items[i])
    return i
  }

  /**
   * CAR-X-001 (owner, 2026-11-24: "ensure the X button works on android auto"): take the song playing ([key]) out of the
   * queue and make another current: the one Next would play, else the first playable one after it in the list
   * (wrapping), never one [avoid] turns down nor, when the list plays once, one already heard. Returns the new index,
   * or null (nothing changed) when [key] is not the song playing or nothing can follow it.
   */
  fun leave(key: String, avoid: (T) -> Boolean = { false }, canFetch: (T) -> Boolean = { false }): Int? {
    val at = index
    if (at < 0 || keyOf(items[at]) != key) return null
    fun open(i: Int) = i != at && !avoid(items[i]) && !(once && (heardBefore(items[i]) || keyOf(items[i]) in heard))
    fun usable(i: Int) = open(i) && isPlayable(items[i])
    val after = (1 until items.size).map { (at + it) % items.size }
    // With nothing held yet, a song that can still be fetched (it starts once its file is here), as a car pick does.
    val next = findNext(wrap = false)?.first?.takeIf(::usable)
      ?: after.firstOrNull(::usable)
      ?: after.firstOrNull { open(it) && canFetch(items[it]) }
      ?: return null
    val nextKey = keyOf(items[next])
    val rest = items.filterIndexed { i, _ -> i != at }
    set(rest, rest.indexOfFirst { keyOf(it) == nextKey })
    if (current?.let(keyOf) != nextKey) select(nextKey) else played(index)
    heard += nextKey
    version++
    return index.takeIf { it >= 0 }
  }

  /** Commit what [peekPrevious] said. */
  fun previous(): Int? {
    val i = peekPrevious() ?: return null
    if (i != index && (repeat == Repeat.ONCE || repeat == Repeat.TWICE)) repeat = Repeat.OFF
    index = i
    version++
    heard += keyOf(items[i])
    return i
  }

  /** The next playable index and whether reaching it crosses into the next round. */
  private fun findNext(wrap: Boolean): Pair<Int, Boolean>? {
    if (shuffle) {
      // ARTIST-RUN-001 (owner, 2026-11-24): the now playing queue never plays one artist more than four times in a row
      // while another artist's song is left to play.
      val run = if (once) runArtist() else ""
      val open = order.filter { fresh(it) && keyOf(items[it]) !in heard }
      (open.firstOrNull { run.isEmpty() || artistKey(artistOf(items[it])) != run } ?: open.firstOrNull())?.let { return it to false }
      if (!wrap || once) return null
      // Readiness and explicit selection can change which song really closes the round.
      val next = nextRound.firstOrNull { it != index && isPlayable(items[it]) }
        ?: nextRound.firstOrNull { isPlayable(items[it]) }
      return next?.let { it to true }
    }
    val pos = order.indexOf(index)
    for (p in pos + 1 until order.size) if (isPlayable(items[order[p]])) return order[p] to false
    if (!wrap) return null
    for (i in nextRound) if (isPlayable(items[i])) return i to true
    return null
  }

  private fun commitRound(first: Int) {
    order = if (shuffle) listOf(first) + nextRound.filter { it != first } else nextRound
    heard.clear()
    nextRound = drawRound(avoidFirst = order.lastOrNull() ?: -1)
  }

  private fun startRound() {
    heard.clear()
    rebuildOrder()
  }

  /** Recompute the play order for the current mode without forgetting this round's heard songs. */
  private fun rebuildOrder() {
    version++
    val all = items.indices.toList()
    order = when {
      !shuffle -> all
      index >= 0 -> listOf(index) + all.filter { it != index }.shuffled(random)
      else -> all.shuffled(random)
    }
    current?.let { heard += keyOf(it) }
    nextRound = drawRound(avoidFirst = order.lastOrNull() ?: -1)
  }

  /** Same list when at least half of the smaller list is shared (edits keep it, a new playlist does not). */
  private fun sameList(old: List<T>, new: List<T>): Boolean {
    val a = old.mapTo(HashSet(), keyOf)
    val b = new.mapTo(HashSet(), keyOf)
    val shared = b.count { it in a }
    return shared * 2 >= minOf(a.size, b.size)
  }

  private fun drawRound(avoidFirst: Int): List<Int> {
    val all = items.indices.toList()
    if (!shuffle) return all
    val r = all.shuffled(random).toMutableList()
    if (r.size > 1 && r.first() == avoidFirst) r.add(r.removeAt(0))
    return r
  }

  companion object {
    /** ARTIST-RUN-001: no more songs than this in a row by one artist (the now playing queue's shuffle). */
    const val MAX_ARTIST_RUN = 4
    private val SPLIT = Regex(",|&|\\s+(?:feat\\.?|ft\\.?|featuring|with|x)\\s+", RegexOption.IGNORE_CASE)
    /** The first-named artist of a credit, as one key however it is spelt ("SLAYR feat. X" and "Slayr" match). */
    fun artistKey(credit: String): String = credit.split(SPLIT).first().trim().lowercase()
  }
}
