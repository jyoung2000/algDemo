package com.nowplaying.discovery.engine

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.nowplaying.discovery.Downloads
import com.nowplaying.discovery.MediaHub
import com.nowplaying.discovery.WebPlayer
import com.nowplaying.discovery.dsp.EqConfig
import com.nowplaying.discovery.dsp.TransitionStyle
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The service's own player: the [AudioEngine] (two decks, the app's EQ/crossfade/mixer, one
 * output) and a [PlayQueue], behind the standard Media3 [Player] interface, so the lock screen,
 * Bluetooth, the notification and Android Auto all control audio the service renders itself. Nothing
 * here needs the Activity or the WebView to be alive.
 *
 * Who decides what plays (plan ruling 2026-11-08, Task 2):
 * - While the page is awake ([Page.live]) it is the authority on order, as on Windows: it loads the
 *   song it chose ([pageLoad]) and cues the one it will play next ([pageCue]). The service plays,
 *   blends into the cue and hands over to it at the end without waiting for the page. Next, Previous
 *   and song choices from the car or lock screen are passed to the page, which answers with a load.
 * - With no page awake the service carries on alone on its queue (the page's last list, or the folder
 *   the car chose), and keeps a log of what played and how much was heard, so the page can still
 *   learn from it later ([pending], [ack]).
 * Play, pause and seek are always handled here, at once.
 *
 * A song is playable only when its complete audio is on the phone: [resolve] maps it to a local file
 * (`Downloads.localFile` re-checks the file each time). One the listener chose that is not on the
 * phone yet waits as buffering, and starts when the page reports its file; one reached by advancing
 * is skipped, never streamed or previewed.
 */
@UnstableApi
class EnginePlayer(
  private val context: Context,
  looper: Looper,
  planner: BlendPlanner = CrossfadePlanner,
  private val resolve: (MediaHub.Song) -> Uri? = { song -> song.source?.let { Downloads.localFile(context, it)?.first } },
  private val lookup: (String) -> MediaHub.Song? = { id -> MediaHub.findSong(id) },
  output: AudioOutput = TrackOutput(),
  initialEq: EqConfig = EqConfig.DEFAULTS,
  /** Off in tests that drive the player without a real audio route. */
  private val manageFocus: Boolean = true,
) : SimpleBasePlayer(looper) {

  /** The page, when there is one. All calls are made on the player's looper. */
  interface Page {
    /** True while the page's script is running and can answer. */
    val live: Boolean
    /** A request from the car, lock screen or Bluetooth that the page decides (Next, Previous, a song choice). */
    fun command(cmd: JSONObject)
    /** The engine's state, for the page to mirror. */
    fun state(json: JSONObject)
  }

  var page: Page? = null

  private val main = Handler(looper)
  private val opener = Executors.newSingleThreadExecutor { r -> Thread(r, "AirwaveOpen").apply { isDaemon = true } }

  /** A queue entry: the song, and the id it was chosen under (a playlist-scoped car id keeps its context). */
  data class Entry(val song: MediaHub.Song, val mediaId: String = song.id)

  private val queue = PlayQueue<Entry>(keyOf = { it.mediaId }, isPlayable = { it.song.source != null && it.song.ready })
  private var playWhenReady = false
  private var ended = false
  private var error: PlaybackException? = null
  /** Bumped whenever the current song changes, so a slow open for an old song is dropped. */
  private var loadGeneration = 0
  private var loadedKey: String? = null
  /** A chosen song whose file is not on the phone yet; it starts when the file is reported. */
  private var waitingFor: String? = null
  private var preparedNextKey: String? = null
  private var mix = 0
  private var pendingStartMs = 0L

  /** The page's cue: what it will play after [cueFor]. */
  private var cue: MediaHub.Song? = null
  private var cueFor: String? = null

  /** Bumped on every change of song the service made itself; a page load older than this is stale. */
  var rev = 0
    private set
  private var seq = 0
  private val unacked = ArrayDeque<JSONObject>()

  private val engine = AudioEngine(output, planner, object : AudioEngine.Listener {
    override fun onEnded(key: String, heard: AudioEngine.Heard) { main.post { songEnded(key, heard) } }
    override fun onAdvanced(key: String, outgoing: AudioEngine.Heard) { main.post { blendPromoted(key, outgoing) } }
    override fun onRepeated(key: String, heard: AudioEngine.Heard) { main.post { repeated(heard) } }
    override fun onBlendStarted(key: String, seconds: Double, style: TransitionStyle) {
      Log.i(TAG, "blend into $key, ${"%.1f".format(seconds)} s ${style.id}")
    }
    override fun onError(key: String, error: Throwable) { main.post { songFailed(key, error) } }
  }, initialEq).also { it.start() }

  /* -------------------------------------------------------------- settings (from the page) */

  fun setEq(config: EqConfig) = engine.setEq(config)
  fun setPlayThrough(percent: Int) = engine.setPlayThrough(percent)
  fun setVolume(v: Double) = engine.setVolume(v.coerceIn(0.0, 1.0))
  fun setMix(slider: Int) {
    mix = slider.coerceIn(0, 100)
    engine.setMix(mix)
    prepareNext()
  }

  /* -------------------------------------------------------------- the page's side */

  /**
   * The page chose [song] (a tap, its own Next/Previous, a resume). Loading the song already playing
   * is a no-op, which is what makes the page's adoption of a service-made change safe. [pageRev] is
   * the newest [rev] the page had seen; a load from before a change the service made is stale.
   */
  fun pageLoad(song: MediaHub.Song, mediaId: String?, positionMs: Long, play: Boolean, pageRev: Int) {
    val id = mediaId ?: song.id
    val current = queue.current
    if (current != null && current.song.id == song.id) {
      // Same song: keep it playing where it is; only pick up a file that arrived for it.
      if (waitingFor == song.id && song.source != null) { replaceCurrent(Entry(song, id)); loadCurrent(positionMs, chosen = true) }
      changePlayWhenReady(play)
      return
    }
    if (pageRev < rev) {
      Log.i(TAG, "ignoring a stale page load of ${song.id} (page rev $pageRev < $rev)")
      emit(null)
      return
    }
    // The list itself follows the page's pushes (libraryChanged); the chosen song is placed in it now.
    val items = queue.items
    val at = items.indexOfFirst { it.song.id == song.id }
    if (at >= 0) queue.set(items.toMutableList().also { it[at] = Entry(song, id) }, at) else queue.set(items + Entry(song, id), items.size)
    if (play && !requestFocus()) return
    playWhenReady = play
    holdWake(play)
    loadCurrent(positionMs.coerceAtLeast(0), chosen = true)
  }

  /** What the page will play after the current song; null for nothing (end of list, repeat-one). */
  fun pageCue(song: MediaHub.Song?) {
    val now = queue.current?.song?.id
    val wanted = song?.takeIf { it.source != null && it.id != now }
    if (wanted?.id == cue?.id && wanted?.source == cue?.source && cueFor == now) return
    cue = wanted
    cueFor = now
    if (preparedNextKey != null && preparedNextKey != cue?.id) { engine.setNext(null, null); preparedNextKey = null }
    prepareNext()
  }

  fun pagePlay(play: Boolean) = changePlayWhenReady(play)
  fun pageSeek(positionMs: Long) {
    if (queue.current == null) return
    engine.seekTo(positionMs.coerceAtLeast(0) * SAMPLE_RATE / 1000)
    ended = false
    invalidateState()
    emitSoon()
  }
  fun pageRepeat(mode: Int) = applyRepeat(mode)
  fun pageShuffle(on: Boolean) { queue.shuffle = on }

  /**
   * The page pushed its list or library (a new queue, a download finished, a song was evicted).
   * While the page is the authority its list is the queue — the current song stays current, kept
   * as an extra entry if it is not in the list (a search result) — and a chosen song that was
   * waiting for its file starts once the file is here.
   */
  fun libraryChanged(list: List<MediaHub.Song>, shuffle: Boolean, repeat: Int) {
    if (pageLive && list.isNotEmpty()) {
      val current = queue.current
      val entries = list.map { s -> if (current != null && s.id == current.song.id) Entry(s, current.mediaId) else Entry(s) }
      val at = if (current == null) -1 else entries.indexOfFirst { it.song.id == current.song.id }
      when {
        current == null -> queue.set(entries, 0)
        at >= 0 -> queue.set(entries, at)
        else -> queue.set(entries + current, entries.size)
      }
      queue.shuffle = shuffle
      if (repeat != repeatMode()) applyRepeat(repeat)
      invalidateState()
    } else if (list.isNotEmpty()) {
      // Carrying on alone: keep the order, but take the page's newer copies (a file that just landed).
      val byId = list.associateBy { it.id }
      val items = queue.items.map { e -> byId[e.song.id]?.let { Entry(it, e.mediaId) } ?: e }
      if (items != queue.items) queue.refresh(items)
    }
    val waiting = waitingFor ?: return
    val fresh = lookup(waiting) ?: return
    if (fresh.source == null) return
    queue.current?.let { replaceCurrent(Entry(fresh, it.mediaId)) }
    loadCurrent(pendingStartMs, chosen = true)
  }

  private fun repeatMode() = when (queue.repeat) { PlayQueue.Repeat.ONE -> 1; PlayQueue.Repeat.ALL -> 2; else -> 0 }

  /** The page handled service-made changes up to [upTo]; forget them. */
  fun ack(upTo: Int) { while (unacked.isNotEmpty() && unacked.first().optInt("seq") <= upTo) unacked.removeFirst() }

  /** Changes the page has not acknowledged (played while it slept), oldest first. */
  fun pending(): JSONArray = JSONArray().apply { unacked.forEach { put(it) } }

  /** The full state for a page that just woke up: where things are, and what it missed. */
  fun snapshotForPage(): JSONObject = stateJson(null).put("pending", pending())

  /* -------------------------------------------------------------- Player state */

  override fun getState(): State {
    val snap = engine.snapshot
    val playlist = queue.items.mapIndexed { i, e ->
      MediaItemData.Builder("${e.mediaId}#$i")
        .setMediaItem(MediaItem.Builder().setMediaId(e.mediaId).setMediaMetadata(WebPlayer.metadataOf(e.song, playable = true)).build())
        .setMediaMetadata(WebPlayer.metadataOf(e.song, playable = true))
        .setDurationUs(durationUs(e.song, snap))
        .setIsSeekable(true)
        .build()
    }
    val positionMs = positionMs(snap)
    val state = playbackState(snap)
    publishedState = state
    val playing = playWhenReady && state == Player.STATE_READY
    return State.Builder()
      .setAvailableCommands(COMMANDS)
      .setPlaybackState(state)
      .setPlayerError(error)
      .setPlayWhenReady(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setPlaylist(playlist)
      .setCurrentMediaItemIndex(queue.index.coerceAtLeast(0))
      .setContentPositionMs(if (playing) PositionSupplier.getExtrapolating(positionMs, 1f) else PositionSupplier.getConstant(positionMs))
      .setShuffleModeEnabled(queue.shuffle)
      .setRepeatMode(
        when (queue.repeat) {
          PlayQueue.Repeat.ONE -> Player.REPEAT_MODE_ONE
          PlayQueue.Repeat.ALL -> Player.REPEAT_MODE_ALL
          PlayQueue.Repeat.OFF -> Player.REPEAT_MODE_OFF
        },
      )
      .build()
  }

  private fun playbackState(snap: AudioEngine.Snapshot): Int {
    val current = queue.current
    return when {
      error != null || current == null -> Player.STATE_IDLE
      ended -> Player.STATE_ENDED
      loadedKey != current.song.id || snap.key != current.song.id || snap.buffering -> Player.STATE_BUFFERING
      else -> Player.STATE_READY
    }
  }

  private fun positionMs(snap: AudioEngine.Snapshot): Long {
    val current = queue.current ?: return 0
    return if (snap.key == current.song.id) snap.positionFrames * 1000 / SAMPLE_RATE else pendingStartMs
  }

  private fun durationUs(song: MediaHub.Song, snap: AudioEngine.Snapshot): Long = when {
    snap.key == song.id && snap.durationFrames > 0 -> snap.durationFrames * 1_000_000 / SAMPLE_RATE
    song.durationMs > 0 -> song.durationMs * 1000
    else -> C.TIME_UNSET
  }

  /* -------------------------------------------------------------- commands from controllers (car, lock screen, BT) */

  private val pageLive: Boolean get() = page?.live == true

  override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
    val start = if (startIndex == C.INDEX_UNSET) 0 else startIndex.coerceIn(0, (mediaItems.size - 1).coerceAtLeast(0))
    val chosen = mediaItems.getOrNull(start)?.mediaId
    if (pageLive && chosen != null) {
      // The page knows the playlist context, the shuffle round and how to fetch a song it lacks.
      page?.command(JSONObject().put("type", "playId").put("id", chosen))
      return Futures.immediateVoidFuture()
    }
    val entries = mediaItems.mapNotNull { item -> lookup(item.mediaId)?.let { Entry(it, item.mediaId) } }
    queue.set(entries, entries.indexOfFirst { it.mediaId == chosen }.coerceAtLeast(0))
    nativeChange()
    loadCurrent(if (startPositionMs == C.TIME_UNSET) 0 else startPositionMs, chosen = true)
    return Futures.immediateVoidFuture()
  }

  override fun handleAddMediaItems(index: Int, mediaItems: MutableList<MediaItem>): ListenableFuture<*> {
    val add = mediaItems.mapNotNull { item -> lookup(item.mediaId)?.let { Entry(it, item.mediaId) } }
    if (add.isEmpty()) return Futures.immediateVoidFuture()
    val keep = queue.current?.mediaId
    val next = queue.items.toMutableList().apply { addAll(index.coerceIn(0, size), add) }
    queue.set(next, next.indexOfFirst { it.mediaId == keep }.coerceAtLeast(0))
    if (keep == null) loadCurrent(0, chosen = true) else prepareNext()
    return Futures.immediateVoidFuture()
  }

  override fun handlePrepare(): ListenableFuture<*> {
    if (error != null) { error = null; loadCurrent(0, chosen = true) }
    return Futures.immediateVoidFuture()
  }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    changePlayWhenReady(playWhenReady)
    return Futures.immediateVoidFuture()
  }

  override fun handleStop(): ListenableFuture<*> {
    changePlayWhenReady(false)
    return Futures.immediateVoidFuture()
  }

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> skip(forward = true)
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> {
        // As every player does: a few seconds in, Previous restarts the song.
        val at = engine.snapshot.positionFrames * 1000 / SAMPLE_RATE
        if (seekCommand == Player.COMMAND_SEEK_TO_PREVIOUS && at > RESTART_THRESHOLD_MS) pageSeek(0) else skip(forward = false)
      }
      Player.COMMAND_SEEK_TO_MEDIA_ITEM -> {
        val entry = queue.items.getOrNull(mediaItemIndex)
        if (entry != null && pageLive) page?.command(JSONObject().put("type", "playId").put("id", entry.mediaId))
        else if (queue.select(mediaItemIndex)) { nativeChange(); loadCurrent(positionMs.coerceAtLeast(0), chosen = true) }
      }
      else -> pageSeek(positionMs)
    }
    return Futures.immediateVoidFuture()
  }

  override fun handleSetRepeatMode(repeatMode: Int): ListenableFuture<*> {
    val mode = when (repeatMode) { Player.REPEAT_MODE_ONE -> 1; Player.REPEAT_MODE_ALL -> 2; else -> 0 }
    applyRepeat(mode)
    if (pageLive) page?.command(JSONObject().put("type", "repeat").put("mode", mode))
    return Futures.immediateVoidFuture()
  }

  override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean): ListenableFuture<*> {
    queue.shuffle = shuffleModeEnabled
    if (pageLive) page?.command(JSONObject().put("type", "shuffle").put("on", shuffleModeEnabled))
    else { preparedNextKey = null; prepareNext() }
    invalidateState()
    return Futures.immediateVoidFuture()
  }

  override fun handleRelease(): ListenableFuture<*> {
    loadGeneration++
    main.removeCallbacksAndMessages(null)
    holdWake(false)
    abandonFocus()
    engine.close()
    opener.shutdownNow()
    return Futures.immediateVoidFuture()
  }

  /* -------------------------------------------------------------- transport */

  private fun changePlayWhenReady(play: Boolean) {
    if (play && !requestFocus()) return
    playWhenReady = play
    if (play) {
      if (ended) { ended = false; if (queue.current != null) loadCurrent(0, chosen = true) } else engine.play()
    } else engine.pause()
    holdWake(play)
    invalidateState()
    emit(null)
  }

  /** Next/Previous from a controller: the page's call while it is awake, the queue's otherwise. */
  private fun skip(forward: Boolean) {
    if (pageLive) { page?.command(JSONObject().put("type", if (forward) "next" else "prev")); return }
    val from = queue.current?.song?.id
    val heard = heardNow()
    val cued = cue?.takeIf { forward && cueFor == from }
    val moved = when {
      cued != null -> moveTo(cued)
      forward -> queue.advance(pressed = true) != null
      else -> queue.previous() != null
    }
    if (!moved) { if (!forward) pageSeek(0); return }
    nativeChange()
    log(if (forward) "next" else "prev", heard)
    loadCurrent(0, chosen = false)
  }

  /** Make [song] current: in the queue if it is there, appended otherwise (a cue from outside the list). */
  private fun moveTo(song: MediaHub.Song): Boolean {
    if (queue.select(song.id)) return true
    queue.set(queue.items + Entry(song), queue.items.size)
    return true
  }

  private fun applyRepeat(mode: Int) {
    queue.repeat = when (mode) { 1 -> PlayQueue.Repeat.ONE; 2 -> PlayQueue.Repeat.ALL; else -> PlayQueue.Repeat.OFF }
    engine.setRepeatOne(queue.repeat == PlayQueue.Repeat.ONE)
    preparedNextKey = null
    prepareNext()
    invalidateState()
  }

  /* -------------------------------------------------------------- loading */

  private fun replaceCurrent(e: Entry) {
    val items = queue.items.toMutableList()
    if (queue.index in items.indices) { items[queue.index] = e; queue.set(items, queue.index) }
  }

  /**
   * Open the current song (off the main thread) and hand it to the engine. [chosen]: the listener
   * picked this song, so if its file is not here yet it waits; otherwise it is skipped.
   */
  private fun loadCurrent(startMs: Long, chosen: Boolean) {
    val entry = queue.current ?: run { invalidateState(); emit(null); return }
    val song = entry.song
    val gen = ++loadGeneration
    loadedKey = null
    waitingFor = null
    preparedNextKey = null
    pendingStartMs = startMs
    ended = false
    error = null
    if (cueFor != song.id) { cue = null; cueFor = null }
    engine.setNext(null, null)
    invalidateState()
    emit(null)
    opener.execute {
      val source = runCatching { resolve(song)?.let { DecodedSource(context, it) } }
        .onFailure { Log.w(TAG, "could not open ${song.id}", it) }
        .getOrNull()
      main.post {
        if (gen != loadGeneration) { source?.close(); return@post }
        if (source == null) {
          if (chosen) {
            // The listener picked it: wait for the file rather than skip away from their choice.
            waitingFor = song.id
            watchForFile()
            invalidateState()
            emit(null)
            return@post
          }
          // Reached by advancing and not on the phone: skip it, as the page does.
          if (queue.advance(pressed = true) != null && queue.current?.song?.id != song.id) { nativeChange(); loadCurrent(0, chosen = false) }
          else {
            error = PlaybackException("“${song.title}” is not on this phone yet", null, PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND)
            invalidateState()
            emit(null)
          }
          return@post
        }
        engine.load(song.id, source, startMs * SAMPLE_RATE / 1000, play = playWhenReady)
        loadedKey = song.id
        invalidateState()
        prepareNext()
        emitSoon()
      }
    }
  }

  /** What comes after the current song: the page's cue when it gave one, else the queue's choice. */
  private fun upcoming(): MediaHub.Song? {
    val now = queue.current?.song?.id ?: return null
    if (queue.repeat == PlayQueue.Repeat.ONE) return null
    if (cueFor == now) return cue
    if (pageLive) return null // the page has not decided yet; never guess ahead of it
    return queue.peekAfterEnd()?.let { queue.items[it].song }?.takeIf { it.id != now }
  }

  /** With the mixer on, open the next song on the spare deck so the blend can start on time. */
  private fun prepareNext() {
    val next = if (mix > 0) upcoming() else null
    if (next == null || loadedKey == null) {
      if (preparedNextKey != null) engine.setNext(null, null)
      preparedNextKey = null
      return
    }
    if (next.id == preparedNextKey) return
    preparedNextKey = next.id
    val gen = loadGeneration
    opener.execute {
      val source = runCatching { resolve(next)?.let { DecodedSource(context, it) } }.getOrNull()
      main.post {
        if (gen != loadGeneration || preparedNextKey != next.id) { source?.close(); return@post }
        if (source == null) { preparedNextKey = null; return@post }
        engine.setNext(next.id, source)
      }
    }
  }

  /* -------------------------------------------------------------- engine events (main thread) */

  private fun songEnded(key: String, heard: AudioEngine.Heard) {
    if (queue.current?.song?.id != key) return
    val next = upcoming()
    val moved = when {
      next != null -> moveTo(next)
      pageLive -> false // the page decides what follows (it may still be fetching it)
      else -> queue.advance(pressed = false) != null
    }
    if (!moved) {
      ended = true
      holdWake(false)
      invalidateState()
      log("end", heard, advanced = false)
      return
    }
    nativeChange()
    log("end", heard)
    loadCurrent(0, chosen = false)
  }

  private fun blendPromoted(key: String, outgoing: AudioEngine.Heard) {
    // The engine already plays [key] from where the blend left it: move the queue, do not reload.
    if (!queue.select(key)) lookup(key)?.let { queue.set(queue.items + Entry(it), queue.items.size) }
    loadedKey = key
    preparedNextKey = null
    cue = null
    cueFor = null
    nativeChange()
    log("blend", outgoing)
    invalidateState()
    prepareNext()
  }

  private fun repeated(heard: AudioEngine.Heard) {
    log("repeat", heard, advanced = false)
    invalidateState()
  }

  private fun songFailed(key: String, cause: Throwable) {
    Log.w(TAG, "playback failed for $key", cause)
    if (queue.current?.song?.id != key) return
    error = PlaybackException("Could not play this song", cause, PlaybackException.ERROR_CODE_DECODING_FAILED)
    holdWake(false)
    invalidateState()
    emit(null)
  }

  /**
   * A chosen song is waiting for its file ([waitingFor]). Look for it every second and start the
   * song when it lands: the page that would otherwise say so may be asleep (app in the background,
   * a system dialog in front), and the listener asked for this song.
   */
  private val fileWatch = object : Runnable {
    override fun run() {
      val id = waitingFor ?: return
      val entry = queue.current?.takeIf { it.song.id == id && it.song.source != null } ?: return
      val gen = loadGeneration
      opener.execute {
        val landed = runCatching { resolve(entry.song) }.getOrNull() != null
        main.post {
          if (gen != loadGeneration || waitingFor != id) return@post
          if (landed) loadCurrent(pendingStartMs, chosen = true) else main.postDelayed(this, FILE_WATCH_MS)
        }
      }
    }
  }

  private fun watchForFile() {
    main.removeCallbacks(fileWatch)
    main.postDelayed(fileWatch, FILE_WATCH_MS)
  }

  /* -------------------------------------------------------------- telling the page */

  private fun nativeChange() { rev++ }

  private fun heardNow(): AudioEngine.Heard {
    val s = engine.snapshot
    return AudioEngine.Heard(s.key ?: "", s.positionFrames, s.durationFrames)
  }

  /** Record a change the service made (or an end), with how much of the outgoing song was heard. */
  private fun log(cause: String, heard: AudioEngine.Heard, advanced: Boolean = true) {
    val entry = JSONObject()
      .put("seq", ++seq)
      .put("cause", cause)
      .put("advanced", advanced)
      .put(
        "from",
        JSONObject().put("id", heard.key).put("heardMs", heard.heardFrames * 1000 / SAMPLE_RATE)
          .put("durationMs", if (heard.durationFrames > 0) heard.durationFrames * 1000 / SAMPLE_RATE else -1),
      )
    unacked.addLast(entry)
    while (unacked.size > MAX_LOG) unacked.removeFirst()
    emit(entry)
  }

  private fun stateJson(event: JSONObject?): JSONObject {
    val snap = engine.snapshot
    val current = queue.current
    val state = playbackState(snap)
    return JSONObject()
      .put("rev", rev)
      .put("id", current?.song?.id ?: JSONObject.NULL)
      .put("mediaId", current?.mediaId ?: JSONObject.NULL)
      .put("playing", playWhenReady && state == Player.STATE_READY)
      .put("playWhenReady", playWhenReady)
      .put("buffering", state == Player.STATE_BUFFERING)
      .put("waiting", waitingFor != null)
      .put("ended", ended)
      .put("error", error?.message ?: JSONObject.NULL)
      .put("positionMs", positionMs(snap))
      .put("durationMs", if (current != null) durationUs(current.song, snap).let { if (it == C.TIME_UNSET) -1 else it / 1000 } else -1)
      .put("blending", snap.blendingInto ?: JSONObject.NULL)
      .put("at", SystemClock.elapsedRealtime())
      .apply { if (event != null) put("event", event) }
  }

  private fun emit(event: JSONObject?) {
    val p = page ?: return
    if (!p.live) return
    runCatching { p.state(stateJson(event)) }
  }

  /**
   * Report soon after the engine has acted: its snapshot lags a command by a render chunk, so the
   * state published at the command (buffering, while the engine takes the new song) is refreshed.
   */
  private fun emitSoon() { main.postDelayed({ refresh(); emit(null) }, 60) }

  /** What controllers were last told; the session only re-reads [getState] on [invalidateState]. */
  private var publishedState = Player.STATE_IDLE

  /** Tell controllers if the state moved since they were last told (the engine caught up, or underran). */
  private fun refresh() { if (playbackState(engine.snapshot) != publishedState) invalidateState() }

  private val ticker = object : Runnable {
    override fun run() {
      refresh()
      // Nothing moves once the song has ended: the end itself was reported when it happened.
      if (playWhenReady && !ended) emit(null)
      main.postDelayed(this, TICK_MS)
    }
  }

  /* -------------------------------------------------------------- audio focus, noisy, wake lock */

  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var focusRequest: AudioFocusRequest? = null
  private var resumeOnFocusGain = false
  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS -> { resumeOnFocusGain = false; changePlayWhenReady(false); abandonFocus() }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> { resumeOnFocusGain = playWhenReady; changePlayWhenReady(false) }
      // Ducking is done by the system for media (setWillPauseWhenDucked false).
      AudioManager.AUDIOFOCUS_GAIN -> if (resumeOnFocusGain) { resumeOnFocusGain = false; changePlayWhenReady(true) }
    }
  }

  private fun requestFocus(): Boolean {
    if (!manageFocus) return true
    val req = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
      .setWillPauseWhenDucked(false)
      .setOnAudioFocusChangeListener(focusListener, main)
      .build().also { focusRequest = it }
    return audioManager.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocus() { if (manageFocus) focusRequest?.let { audioManager.abandonAudioFocusRequest(it) } }

  /** Headphones unplugged or Bluetooth dropped: pause, as every player must. */
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) { if (i.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) changePlayWhenReady(false) }
  }
  private var noisyRegistered = false

  private val wakeLock: PowerManager.WakeLock? = runCatching {
    (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Airwave:engine").apply { setReferenceCounted(false) }
  }.getOrNull()

  /** Keep the CPU awake while playing, so the render thread is not frozen with the screen off. */
  private fun holdWake(on: Boolean) {
    if (on) {
      runCatching { wakeLock?.acquire(WAKE_TIMEOUT_MS) }
      if (!noisyRegistered && manageFocus) {
        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(noisy, filter, Context.RECEIVER_NOT_EXPORTED)
        else context.registerReceiver(noisy, filter)
        noisyRegistered = true
      }
    } else {
      runCatching { wakeLock?.let { if (it.isHeld) it.release() } }
      if (noisyRegistered) { runCatching { context.unregisterReceiver(noisy) }; noisyRegistered = false }
    }
  }

  init { main.post(ticker) }

  companion object {
    private const val TAG = "AirwaveEnginePlayer"
    private const val SAMPLE_RATE = 48000L
    private const val RESTART_THRESHOLD_MS = 3000L
    private const val TICK_MS = 250L
    private const val FILE_WATCH_MS = 1000L
    private const val MAX_LOG = 64
    /** Renewed on every play; a safety net, not a playback limit. */
    private const val WAKE_TIMEOUT_MS = 6 * 60 * 60 * 1000L
    private val COMMANDS = Player.Commands.Builder()
      .addAll(
        Player.COMMAND_PLAY_PAUSE,
        Player.COMMAND_PREPARE,
        Player.COMMAND_STOP,
        Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_MEDIA_ITEM,
        Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
        Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
        Player.COMMAND_GET_METADATA,
        Player.COMMAND_GET_TIMELINE,
        Player.COMMAND_SET_SHUFFLE_MODE,
        Player.COMMAND_SET_REPEAT_MODE,
        Player.COMMAND_SET_MEDIA_ITEM,
        Player.COMMAND_CHANGE_MEDIA_ITEMS,
        Player.COMMAND_RELEASE,
      )
      .build()
  }
}
