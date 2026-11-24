package com.nowplaying.discovery.engine

import android.content.BroadcastReceiver
import android.content.Context
import com.nowplaying.discovery.RadioCatalog
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
import com.nowplaying.discovery.NativeStateCodec
import com.nowplaying.discovery.NowPlayingLabel
import com.nowplaying.discovery.Streams
import com.nowplaying.discovery.WebPlayer
import com.nowplaying.discovery.dsp.EqConfig
import com.nowplaying.discovery.dsp.EqMath
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
  /** DJ-XFADE-001: plans a blend from what was measured of the two songs. */
  cuePlanner: CuePlanner? = CrossfadeCuePlanner,
  /** Measures a downloaded song's cues; runs off the main thread. Null in tests without real files. */
  private val measure: ((Uri) -> TrackCues?)? = { uri -> CueReader.read(context, uri) },
  private val resolve: (MediaHub.Song) -> Uri? = { song -> song.source?.let { Downloads.localFile(context, it)?.first } },
  private val lookup: (String) -> MediaHub.Song? = { id -> MediaHub.findSong(id) },
  output: AudioOutput = TrackOutput(),
  initialEq: EqConfig = EqConfig.DEFAULTS,
  /** Off in tests that drive the player without a real audio route. */
  private val manageFocus: Boolean = true,
  /** Subscribes to "this link's file is now held"; returns the unsubscribe. */
  landed: ((String) -> Unit) -> () -> Unit = Downloads::onLanded,
  /** STREAM-DL-001: the song's audio file at its source, for playing while the download runs. */
  private val stream: (MediaHub.Song) -> Streams.Stream? = { song -> song.source?.let { Streams.resolve(it) } },
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

  /** NATIVE-STATE-OBSERVER-001: every state the page would get, page or not, as a copy (EngineHub saves it). */
  var observer: ((JSONObject) -> Unit)? = null
  /** Changes whenever the queue, its round, its modes or the current song change. */
  val queueVersion: Long get() = queue.version
  /** NATIVE-COLD-STATE-001: restored from storage and not opened yet: paused, nothing decoded, streamed or downloaded. */
  private var restored = false

  private val main = Handler(looper)
  private val opener = Executors.newSingleThreadExecutor { r -> Thread(r, "AirwaveOpen").apply { isDaemon = true } }
  /** Asks yt-dlp for a stream; seconds per song, so it never holds up opening a file. */
  private val streamer = Executors.newSingleThreadExecutor { r -> Thread(r, "AirwaveStream").apply { isDaemon = true } }
  /** The song now playing from its source rather than from a file (STREAM-DL-001). */
  private var streamingKey: String? = null
  private var radioLive = false
  /** CAR-RADIO-NOWPLAYING-001: the station playing, kept on the car's screen beside the song and album. */
  private var radioStation = ""

  /**
   * CAR-RADIO-CONTROLS-001: where the item on air began on the ring clock (ms) and how long it is, as
   * the page measured or the broadcaster published them; null when not known, and then the car is
   * shown no elapsed time or length rather than the time since tuning in.
   */
  private var radioStartMs: Long? = null
  private var radioLengthMs: Long? = null

  private fun forgetRadioItem() {
    radioStartMs = null; radioLengthMs = null
    MediaHub.setRadioSong(null, null)
  }

  /** RADIO-001: the same native engine and EQ, fed by a bounded live PCM source. */
  fun pageRadioMetadata(
    id: String, title: String, artist: String, artwork: String = "",
    song: MediaHub.Song? = null, track: JSONObject? = null, startMs: Long? = null, lengthMs: Long? = null,
  ) {
    if (!radioLive || loadedKey != "radio:$id" || title.isBlank()) return
    val old = queue.current ?: return
    radioStartMs = startMs; radioLengthMs = lengthMs
    MediaHub.setRadioSong(song, track)
    val album = song?.album ?: track?.optString("album")?.takeIf { it.isNotBlank() && it != "null" }
    queue.set(listOf(Entry(old.song.copy(title = title.take(200), artist = NowPlayingLabel.radioArtist(artist, radioStation).take(200),
      album = NowPlayingLabel.radioAlbum(radioStation, album).take(300), artwork = artwork.takeIf { it.isNotBlank() }, durationMs = lengthMs ?: -1L))), 0)
    invalidateState(); emitSoon()
  }

  fun pageRadio(id: String, title: String, station: String) {
    val live = com.nowplaying.discovery.RadioNative.session?.takeIf { it.id == id } ?: return
    loadGeneration++; restored = false; stopLanded()
    radioLive = true; loadedKey = "radio:$id"; waitingFor = null; streamingKey = null
    forgetRadioItem()
    radioStation = station.trim().take(200)
    val song = MediaHub.Song("radio:$id", title, NowPlayingLabel.radioArtist(station, radioStation), NowPlayingLabel.radioAlbum(radioStation, null), null, -1, true, null)
    queue.set(listOf(Entry(song)), 0); queue.shuffle = false; queue.repeat = PlayQueue.Repeat.OFF
    cue = null; cueFor = null; preparedNextKey = null; ended = false; error = null
    engine.setNext(null, null); engine.setRepeatOne(false)
    if (!requestFocus()) return
    playWhenReady = true; holdWake(true)
    engine.load(song.id, live.ring, 0, true); engine.play()
    invalidateState(); emitSoon()
  }

  /** A queue entry: the song, and the id it was chosen under (a playlist-scoped car id keeps its context). */
  data class Entry(val song: MediaHub.Song, val mediaId: String = song.id)

  private val queue = PlayQueue<Entry>(keyOf = { it.mediaId }, isPlayable = { it.song.source != null && it.song.ready }, heardBefore = { it.song.heard }, artistOf = { it.song.artist })
  private val repeatSync = RepeatSync()
  private var repeatFromPage = false
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
      Log.i(TAG, "blend into $key, ${"%.1f".format(seconds)} s ${style.id}" + if (TapOutput.frames > 0) " tapFrame=${TapOutput.frames}" else "")
    }
    override fun onBlendPlanned(key: String, plan: BlendPlan) {
      Log.i(TAG, "blend plan ${plan.beat.id} rate=${"%.4f".format(plan.rate)} from=${"%.2f".format(plan.startAt)} to=${"%.2f".format(plan.endAt)} in=${"%.2f".format(plan.inStart)} swap=${plan.swapAt?.let { "%.2f".format(it) } ?: "-"}")
    }
    override fun onError(key: String, error: Throwable) { main.post { songFailed(key, error) } }
  }, initialEq, cuePlanner).also { it.start() }

  /** Reads cues one song at a time, apart from [opener] so measuring never delays opening a file. */
  private val analyst = Executors.newSingleThreadExecutor { r -> Thread(r, "AirwaveCues").apply { isDaemon = true; priority = Thread.MIN_PRIORITY } }
  /** Songs whose cues are measured or being measured, newest last. */
  private val measured = LinkedHashSet<String>()

  /**
   * DJ-XFADE-001: measure [song]'s audio once, in the background, and give the result to the engine
   * so its blends sit on the music. Only files on the phone are read; a stream is never fetched twice.
   */
  private fun measureCues(song: MediaHub.Song) {
    val reader = measure ?: return
    if (mix <= 0 || !measured.add(song.id)) return
    while (measured.size > 8) measured.remove(measured.first())
    analyst.execute {
      val t0 = SystemClock.elapsedRealtime()
      val cues = runCatching { resolve(song)?.let(reader) }.getOrNull()
      if (cues == null) {
        main.post { measured.remove(song.id) }
        return@execute
      }
      Log.i(TAG, "cues ${song.id.take(40)} end=${"%.2f".format(cues.end)}/${"%.2f".format(cues.duration)} level-to=${"%.2f".format(cues.fullEnd)} start=${"%.2f".format(cues.start)}" +
        " head=${cues.head?.let { "${"%.1f".format(it.bpm)}@${"%.1f".format(it.confidence)}" } ?: "-"} tail=${cues.tail?.let { "${"%.1f".format(it.bpm)}@${"%.1f".format(it.confidence)}" } ?: "-"}" +
        " in ${SystemClock.elapsedRealtime() - t0} ms")
      engine.setCues(song.id, cues)
    }
  }

  /* -------------------------------------------------------------- settings (from the page) */

  fun setEq(config: EqConfig) = engine.setEq(config)
  fun setPlayThrough(percent: Int) = engine.setPlayThrough(percent)
  /** 0..2: past 1 is the VOLUME-BOOST-001 boost, carried by the mix bus before its limiter. */
  fun setVolume(v: Double) = engine.setVolume(v.coerceIn(0.0, EqMath.VOLUME_MAX))
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
    leaveRadio()
    val id = mediaId ?: song.id
    val current = queue.current
    Log.i(TAG, "page load ${song.id.take(60)} link=${song.source != null} play=$play rev=$pageRev/$rev")
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

  /** Ends a live broadcast (the song player takes over). Nothing when no radio plays. */
  private fun leaveRadio() {
    if (!radioLive) return
    radioLive = false; forgetRadioItem(); com.nowplaying.discovery.RadioNative.stop(); com.nowplaying.discovery.RadioNative.shuffle = false
  }

  /** What the page will play after the current song; null for nothing (end of list, repeat-one). */
  fun pageCue(song: MediaHub.Song?) {
    if (radioLive) return
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
    if (restored) { pendingStartMs = positionMs.coerceAtLeast(0); invalidateState(); emit(null); return }
    engine.seekTo(positionMs.coerceAtLeast(0) * SAMPLE_RATE / 1000)
    ended = false
    invalidateState()
    emitSoon()
  }
  fun pageRepeat(mode: Int) = applyRepeat(mode, fromPage = true)
  fun pageShuffle(on: Boolean) { queue.shuffle = on }

  /** RADIO-GO-LIVE-001: the listener asked for the live edge of the station playing. */
  fun radioToLive() {
    if (!radioLive) return
    engine.seekWith { (it as? com.nowplaying.discovery.RadioRing)?.toLive() }
    invalidateState()
    emitSoon()
  }

  /** RADIO-SHUFFLE-001: a radio op changed the station-shuffle flag; the session must mirror it. */
  fun radioShuffleChanged() { if (radioLive) { invalidateState(); emitSoon() } }

  /**
   * The page pushed its list or library (a new queue, a download finished, a song was evicted).
   * While the page is the authority its list is the queue — the current song stays current, kept
   * as an extra entry if it is not in the list (a search result) — and a chosen song that was
   * waiting for its file starts once the file is here.
   */
  fun libraryChanged(list: List<MediaHub.Song>, shuffle: Boolean, repeat: Int, once: Boolean = false) {
    if (radioLive) return
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
      queue.playsOnce = once
      val chosen = repeatSync.fromPage(repeat)
      if (chosen != null) { if (chosen != repeatMode()) applyRepeat(chosen, fromPage = true) }
      else resendRepeatToPage() // it still shows a value the service has since changed: say so again
      invalidateState()
    } else if (queue.items.isNotEmpty()) {
      // Carrying on alone (or with no page list at all: a car cold start): keep the native order and
      // context, but take newer copies of its own songs (a file that just landed), from the page's
      // list first, else the library. The playing song is only re-described here, never reopened.
      val byId = list.associateBy { it.id }
      val items = queue.items.map { e ->
        (byId[e.song.id] ?: lookup(e.mediaId)?.takeIf { it.id == e.song.id } ?: lookup(e.song.id)?.takeIf { it.id == e.song.id })
          ?.let { Entry(it, e.mediaId) } ?: e
      }
      if (items != queue.items) queue.refresh(items)
    }
    val waiting = waitingFor ?: return
    val fresh = lookup(waiting) ?: return
    if (fresh.source == null) return
    queue.current?.let { replaceCurrent(Entry(fresh, it.mediaId)) }
    loadCurrent(pendingStartMs, chosen = true)
  }

  /** Wire modes: 0 off, 1 infinite, 3 one extra, 4 two extra. 2 was repeat-list (retired). */
  private fun repeatMode() = when (queue.repeat) {
    PlayQueue.Repeat.ONE -> 1
    PlayQueue.Repeat.ONCE -> 3
    PlayQueue.Repeat.TWICE -> 4
    else -> 0
  }

  /** Current repeat-song selection (wire mode) for the car's button: 0 off, 3 one extra, 4 two extra, 1 infinite. */
  val repeatSelection: Int get() = repeatMode()
  /** The selection changed, by anyone: the phone, the car, a replay counted down, a song left. */
  var onRepeatSelectionChanged: (() -> Unit)? = null

  /** The car's repeat button: the same four-state cycle as the phone's. */
  fun cycleSongRepeat(): Int {
    val next = when (repeatMode()) { 0 -> 3; 3 -> 4; 4 -> 1; else -> 0 }
    applyRepeat(next)
    return next
  }

  /** A page that just woke: tell it a repeat change it slept through (the car's button, a countdown). */
  fun resendRepeatToPage() {
    if (repeatSync.owed != null && pageLive) page?.command(JSONObject().put("type", "repeat").put("mode", repeatMode()))
  }

  /** The page handled service-made changes up to [upTo]; forget them. */
  fun ack(upTo: Int) { while (unacked.isNotEmpty() && unacked.first().optInt("seq") <= upTo) unacked.removeFirst() }

  /** Changes the page has not acknowledged (played while it slept), oldest first. */
  fun pending(): JSONArray = JSONArray().apply { unacked.forEach { put(it) } }

  /** The full state for a page that just woke up: where things are, and what it missed. */
  fun snapshotForPage(): JSONObject = stateJson(null).put("pending", pending())

  /** NATIVE-COLD-STATE-001: the queue, its shuffle round and the native millisecond position, to save. */
  fun nativeState(): JSONObject = NativeStateCodec.nativeJson(
    NativeStateCodec.NativeQueue(queue.items.map { it.mediaId to it.song }, queue.control(), positionMs(engine.snapshot)),
  )

  /**
   * Put back a saved queue (every entry, the current song, repeat, shuffle and its round), paused and
   * unopened: nothing is decoded, streamed or downloaded until an explicit prepare or play, which
   * opens the remembered position through [loadCurrent]. Only into a player with no queue yet.
   */
  fun restoreNativeState(saved: JSONObject, sourceAllowed: (String) -> Boolean = Downloads::urlAllowed): Boolean {
    if (queue.items.isNotEmpty() || loadedKey != null || waitingFor != null) return false
    val q = NativeStateCodec.nativeOf(saved, sourceAllowed)?.takeIf { it.entries.isNotEmpty() } ?: return false
    queue.restore(q.entries.map { (m, s) -> Entry(s, m) }, q.control)
    engine.setRepeatOne(queue.repeatsSong)
    playWhenReady = false
    pendingStartMs = q.positionMs
    ended = false
    error = null
    restored = true
    invalidateState()
    emit(null)
    return true
  }

  /* -------------------------------------------------------------- Player state */

  override fun getState(): State {
    val snap = engine.snapshot
    val playlist = queue.items.mapIndexed { i, e ->
      MediaItemData.Builder("${e.mediaId}#$i")
        .setMediaItem(MediaItem.Builder().setMediaId(e.mediaId).setMediaMetadata(WebPlayer.metadataOf(e.song, playable = true, nowPlaying = true)).build())
        .setMediaMetadata(WebPlayer.metadataOf(e.song, playable = true, nowPlaying = true))
        .setDurationUs(durationUs(e.song, snap))
        .setIsSeekable(true)
        .build()
    }
    val positionMs = positionMs(snap)
    val state = playbackState(snap)
    publishedState = state
    val playing = playWhenReady && state == Player.STATE_READY
    return State.Builder()
      .setAvailableCommands(if (radioLive) radioCommands() else COMMANDS)
      .setPlaybackState(state)
      .setPlayerError(error)
      .setPlayWhenReady(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setPlaylist(playlist)
      .setCurrentMediaItemIndex(queue.index.coerceAtLeast(0))
      // CAR-RADIO-CLOCK-002: live radio with no known song start has no clock; a running count from zero would be invented.
      .setContentPositionMs(if (playing && !(radioLive && radioStartMs == null)) PositionSupplier.getExtrapolating(positionMs, 1f) else PositionSupplier.getConstant(positionMs))
      .setShuffleModeEnabled(if (radioLive) com.nowplaying.discovery.RadioNative.shuffle else queue.shuffle)
      .setRepeatMode(
        when (queue.repeat) {
          PlayQueue.Repeat.ONE -> Player.REPEAT_MODE_ONE
          PlayQueue.Repeat.ALL -> Player.REPEAT_MODE_OFF // legacy list mode is no longer offered
          PlayQueue.Repeat.OFF, PlayQueue.Repeat.ONCE, PlayQueue.Repeat.TWICE -> Player.REPEAT_MODE_OFF
        },
      )
      .build()
  }

  private fun playbackState(snap: AudioEngine.Snapshot): Int {
    val current = queue.current
    return when {
      error != null || current == null || restored -> Player.STATE_IDLE
      ended -> Player.STATE_ENDED
      loadedKey != current.song.id || snap.key != current.song.id || snap.buffering -> Player.STATE_BUFFERING
      else -> Player.STATE_READY
    }
  }

  private fun positionMs(snap: AudioEngine.Snapshot): Long {
    val current = queue.current ?: return 0
    if (radioLive) {
      // CAR-RADIO-CONTROLS-001: the item's own elapsed time, from where it began on the ring.
      val start = radioStartMs ?: return 0
      val ring = if (snap.key == current.song.id) snap.positionFrames * 1000 / SAMPLE_RATE else 0
      val elapsed = (ring - start).coerceAtLeast(0)
      return radioLengthMs?.let { elapsed.coerceAtMost(it) } ?: elapsed
    }
    return if (snap.key == current.song.id) snap.positionFrames * 1000 / SAMPLE_RATE else pendingStartMs
  }

  private fun durationUs(song: MediaHub.Song, snap: AudioEngine.Snapshot): Long = when {
    snap.key == song.id && snap.durationFrames > 0 -> snap.durationFrames * 1_000_000 / SAMPLE_RATE
    song.durationMs > 0 -> song.durationMs * 1000
    else -> C.TIME_UNSET
  }

  /* -------------------------------------------------------------- commands from controllers (car, lock screen, BT) */

  private val pageLive: Boolean get() = page?.live == true

  /** CAR-RESUME-001: the songs a car resume handed over, found here before the library has loaded. */
  private val resumed = HashMap<String, MediaHub.Song>()
  fun offerResumed(entries: List<Pair<String, MediaHub.Song>>) { resumed.clear(); for ((m, s) in entries) resumed[m] = s }
  private fun find(id: String): MediaHub.Song? = lookup(id) ?: resumed[id]

  override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
    val start = if (startIndex == C.INDEX_UNSET) 0 else startIndex.coerceIn(0, (mediaItems.size - 1).coerceAtLeast(0))
    val chosen = mediaItems.getOrNull(start)?.mediaId
    // CAR-CONTROLS-001: a pick in the car's playlist picker hands back the queue as it is. The song
    // stays loaded where it is (Media3 then only resumes it); the page would restart it and drop a
    // repeat count, so it is not asked.
    if (chosen != null && chosen == queue.current?.mediaId && mediaItems[start].requestMetadata.extras?.getBoolean(KEEP_PLAYING) == true) return Futures.immediateVoidFuture()
    // Radio is native even with a live page: never send station ids through music lookup/playId.
    if (chosen != null && RadioCatalog.stationId(chosen) != null) return RadioCatalog.play(context, chosen)
    // CAR-RADIO-TO-QUEUE-001 (owner, 2026-11-22): "on android auto playing radio and switching to now playing queue just
    // takes the user back to the radio queue". A song chosen in the car while the radio plays ends the broadcast first;
    // before, the native path loaded the song under a still-live radio session, so the car stayed on the station.
    // A playlist pick (KEEP_PLAYING) changes nothing that plays, the radio included.
    if (chosen != null && mediaItems[start].requestMetadata.extras?.getBoolean(KEEP_PLAYING) != true) leaveRadio()
    if (pageLive && chosen != null) {
      // The page knows the playlist context, the shuffle round and how to fetch a song it lacks.
      page?.command(JSONObject().put("type", "playId").put("id", chosen))
      return Futures.immediateVoidFuture()
    }
    val entries = mediaItems.mapNotNull { item -> find(item.mediaId)?.let { Entry(it, item.mediaId) } }
    queue.set(entries, entries.indexOfFirst { it.mediaId == chosen }.coerceAtLeast(0))
    nativeChange()
    loadCurrent(if (startPositionMs == C.TIME_UNSET) 0 else startPositionMs, chosen = true)
    return Futures.immediateVoidFuture()
  }

  override fun handleAddMediaItems(index: Int, mediaItems: MutableList<MediaItem>): ListenableFuture<*> {
    val add = mediaItems.mapNotNull { item -> find(item.mediaId)?.let { Entry(it, item.mediaId) } }
    if (add.isEmpty()) return Futures.immediateVoidFuture()
    val keep = queue.current?.mediaId
    val next = queue.items.toMutableList().apply { addAll(index.coerceIn(0, size), add) }
    queue.set(next, next.indexOfFirst { it.mediaId == keep }.coerceAtLeast(0))
    if (keep == null) loadCurrent(0, chosen = true) else prepareNext()
    return Futures.immediateVoidFuture()
  }

  /**
   * CAR-SIMILAR-001: songs the car's Find similar added go to the end of the queue, after the song
   * playing, which carries on. A live page owns the queue and sends its own list, so nothing here.
   */
  fun appendFound(songs: List<MediaHub.Song>): Int {
    if (pageLive) return 0
    val have = queue.items.map { it.mediaId }.toSet()
    val add = songs.filter { it.id !in have }.map { Entry(MediaHub.sourced(it)) }
    if (add.isEmpty()) return 0
    // WP7-APPEND-001: the queue spaces them away from the same artist instead of piling them on the end.
    queue.insertSpaced(add)
    nativeChange()
    prepareNext()
    invalidateState(); emitSoon()
    return add.size
  }

  /**
   * CAR-MOOD-001: the song playing and the songs the listening mood may re-arrange, or null. Only with
   * the phone app closed (a live page arranges its own queue, MOOD-QUEUE-001) and never on the radio.
   * In order: Discover queue songs after the current one. Shuffle: the rest of this round, any list.
   */
  fun moodCandidates(): Pair<String?, List<String>>? {
    if (pageLive || radioLive) return null
    val ids = if (queue.shuffle) queue.roundAhead().filterNot { it.startsWith("radio") }
      else com.nowplaying.discovery.CarMood.movable(queue.items.map { it.mediaId }, queue.index, shuffle = false)
    return if (ids.size < 2) null else queue.current?.mediaId to ids
  }

  /** CAR-MOOD-001: play the movable songs in [order] (media ids). True when the queue changed. */
  fun applyMood(order: List<String>): Boolean {
    if (pageLive || radioLive) return false
    val changed = if (queue.shuffle) queue.arrangeRound(order) else {
      val ids = queue.items.map { it.mediaId }
      val next = com.nowplaying.discovery.CarMood.apply(ids, queue.index, false, order) ?: return false
      val pool = queue.items.groupBy { it.mediaId }.mapValues { ArrayDeque(it.value) }
      queue.set(next.map { pool.getValue(it).removeFirst() }, queue.index)
      true
    }
    if (!changed) return false
    nativeChange()
    prepareNext()
    invalidateState(); emitSoon()
    return true
  }

  /** A car/controller may clear or remove queue entries between playback requests. Advertising
   * CHANGE_MEDIA_ITEMS without this handler crashed the entire media service on a non-empty clear. */
  override fun handleRemoveMediaItems(fromIndex: Int, toIndex: Int): ListenableFuture<*> {
    val current = queue.current
    val next = queue.items.filterIndexed { index, _ -> index !in fromIndex until toIndex }
    val keptAt = next.indexOfFirst { it.mediaId == current?.mediaId }
    queue.set(next, if (keptAt >= 0) keptAt else fromIndex.coerceAtMost((next.size - 1).coerceAtLeast(0)))
    cue = null
    cueFor = null
    preparedNextKey = null
    engine.setNext(null, null)
    nativeChange()
    if (next.isEmpty()) {
      ++loadGeneration // a decoder/stream lookup in flight must not resurrect the old song
      restored = false
      waitingFor = null
      loadedKey = null
      streamingKey = null
      pendingStartMs = 0
      ended = false
      error = null
      changePlayWhenReady(false)
    } else if (keptAt < 0) {
      loadCurrent(0, chosen = true)
    } else {
      prepareNext()
    }
    invalidateState()
    emit(null)
    return Futures.immediateVoidFuture()
  }

  override fun handlePrepare(): ListenableFuture<*> {
    if (restored) loadCurrent(pendingStartMs, chosen = true)
    else if (error != null) { error = null; loadCurrent(0, chosen = true) }
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

  /**
   * RADIO-001: live radio keeps Previous/Next, which SWITCH STATIONS in the station list the
   * listener is browsing (owner: "skipping back and forth should let you skip and progress
   * stations"). Seeking forward inside the broadcast stays impossible; rewinding into the retained
   * five minutes is the separate Rewind control. Repeat means nothing for a broadcast; shuffle
   * stays and makes Previous/Next tune a RANDOM other station of the list (RADIO-SHUFFLE-001).
   */
  private fun radioCommands(): Player.Commands {
    val station = com.nowplaying.discovery.RadioNative.session?.station
    val builder = COMMANDS.buildUpon().removeAll(Player.COMMAND_SEEK_FORWARD, Player.COMMAND_SET_REPEAT_MODE)
    if (station == null || !RadioCatalog.canSkip(station)) {
      builder.removeAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
    }
    return builder.build()
  }

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
    if (radioLive) {
      when (seekCommand) {
        Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> return RadioCatalog.skip(context, 1)
        Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> return RadioCatalog.skip(context, -1)
        Player.COMMAND_SEEK_BACK -> pageSeek((engine.snapshot.positionFrames * 1000 / SAMPLE_RATE - 15000).coerceAtLeast(0))
        // The car's bar shows the item's own time: a drag lands that far into the item on the ring.
        Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM -> radioStartMs?.let { pageSeek((it + positionMs).coerceAtLeast(0)) }
      }
      return Futures.immediateVoidFuture()
    }
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
    val mode = when (repeatMode) { Player.REPEAT_MODE_ONE, Player.REPEAT_MODE_ALL -> 1; else -> 0 }
    // The platform has no "N more times": a counted replay shows there as off, and a controller
    // that merely re-sends off must not cancel the count the listener asked for.
    if (mode == 0 && (queue.repeat == PlayQueue.Repeat.ONCE || queue.repeat == PlayQueue.Repeat.TWICE)) return Futures.immediateVoidFuture()
    applyRepeat(mode)
    return Futures.immediateVoidFuture()
  }

  override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean): ListenableFuture<*> {
    if (radioLive) {
      // RADIO-SHUFFLE-001: while radio is live the car's shuffle makes skips tune a random other
      // station; it never touches the song queue's round, and the session's flag mirrors it.
      com.nowplaying.discovery.RadioNative.shuffle = shuffleModeEnabled
      invalidateState()
      return Futures.immediateVoidFuture()
    }
    queue.shuffle = shuffleModeEnabled
    if (pageLive) page?.command(JSONObject().put("type", "shuffle").put("on", shuffleModeEnabled))
    else { preparedNextKey = null; prepareNext() }
    invalidateState()
    return Futures.immediateVoidFuture()
  }

  override fun handleRelease(): ListenableFuture<*> {
    loadGeneration++
    stopLanded()
    main.removeCallbacksAndMessages(null)
    holdWake(false)
    abandonFocus()
    engine.close()
    opener.shutdownNow()
    streamer.shutdownNow()
    analyst.shutdownNow()
    return Futures.immediateVoidFuture()
  }

  /* -------------------------------------------------------------- transport */

  private fun changePlayWhenReady(play: Boolean) {
    if (play && !requestFocus()) return
    // Car, lock-screen, focus and noisy-device controls share the phone radio pause state.
    if (radioLive) com.nowplaying.discovery.RadioNative.session?.paused = !play
    playWhenReady = play
    if (play) {
      if (restored) loadCurrent(pendingStartMs, chosen = true)
      else if (ended) { ended = false; if (queue.current != null) loadCurrent(0, chosen = true) } else engine.play()
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

  /**
   * CAR-X-001 (owner, 2026-11-24: "ensure the X button works on android auto"): the car's X took song [id] out while it
   * plays. With the phone page in charge the page drops it and plays the next one; otherwise the queue does
   * ([PlayQueue.leave], skipping songs [avoid] turns down). Media3's own Next was not enough: it does nothing for the
   * last song of the list, under shuffle too. Returns false when nothing can follow: the song is paused instead.
   */
  fun leaveSong(id: String, avoid: (MediaHub.Song) -> Boolean): Boolean {
    val cur = queue.current ?: return false
    if (cur.song.id != id && cur.mediaId != id) return false
    if (pageLive) { page?.command(JSONObject().put("type", "leave").put("id", cur.song.id)); Log.i(TAG, "leave ${id.take(60)}: page"); return true }
    val heard = heardNow()
    val size = queue.items.size
    if (queue.leave(cur.mediaId, avoid = { avoid(it.song) }, canFetch = { it.song.source != null }) == null) {
      Log.i(TAG, "leave ${id.take(60)}: nothing to follow in $size (heard ${queue.items.count { it.song.heard }}, ready ${queue.items.count { it.song.ready }}, once=${queue.playsOnce})")
      changePlayWhenReady(false)
      return false
    }
    Log.i(TAG, "leave ${id.take(60)}: now ${queue.current?.song?.id?.take(60)} (ready=${queue.current?.song?.ready})")
    cue = null
    cueFor = null
    nativeChange()
    log("next", heard)
    loadCurrent(0, chosen = queue.current?.song?.ready != true) // a song still to fetch waits for its file
    return true
  }

  /** Tests only: start the next test from an empty queue (CAR-X-001 tests take songs out of it). */
  internal fun forgetQueueForTests() { queue.set(emptyList(), -1); invalidateState() }

  /** Make [song] current: in the queue if it is there, appended otherwise (a cue from outside the list). */
  private fun moveTo(song: MediaHub.Song): Boolean {
    if (queue.select(song.id)) return true
    queue.set(queue.items + Entry(song), queue.items.size)
    return true
  }

  private fun applyRepeat(mode: Int, fromPage: Boolean = false) {
    repeatFromPage = fromPage
    try {
      queue.repeat = when (mode) { 1 -> PlayQueue.Repeat.ONE; 3 -> PlayQueue.Repeat.ONCE; 4 -> PlayQueue.Repeat.TWICE; else -> PlayQueue.Repeat.OFF }
    } finally { repeatFromPage = false }
    engine.setRepeatOne(queue.repeatsSong)
    preparedNextKey = null
    prepareNext()
    invalidateState()
  }

  /**
   * REPEAT-COUNT-001: every change of the queue's repeat lands here, whoever made it. The engine
   * follows at once (a count dropped by Next must not loop the next song). A change the page did
   * not make is owed to the page, and both it and the car's button are told once the queue has
   * finished whatever it was doing.
   */
  private fun queueRepeatChanged() {
    engine.setRepeatOne(queue.repeatsSong)
    if (!repeatFromPage) repeatSync.serviceSet(repeatMode())
    val tellPage = !repeatFromPage
    main.post {
      if (tellPage && repeatSync.owed == repeatMode() && pageLive) page?.command(JSONObject().put("type", "repeat").put("mode", repeatMode()))
      onRepeatSelectionChanged?.invoke()
      invalidateState()
    }
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
    restored = false
    loadedKey = null
    waitingFor = null
    streamingKey = null
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
            Log.i(TAG, "waiting for the file of ${song.id.take(60)} (link=${song.source != null})")
            watchForFile()
            playFromSource(song, gen)
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
        Log.i(TAG, "opened ${song.id.take(60)} at ${startMs} ms")
        engine.load(song.id, source, startMs * SAMPLE_RATE / 1000, play = playWhenReady)
        loadedKey = song.id
        invalidateState()
        prepareNext()
        emitSoon()
      }
    }
  }

  /**
   * STREAM-DL-001. While the chosen song's file downloads, play it from its source through the same
   * decoder, EQ and mixer. Whichever is playable first wins: a file that lands before the stream
   * opens is played instead ([waitingFor] is cleared then), and once the stream plays it plays to
   * the end of the song, because moving to the file would restart it. A stream that cannot be had
   * leaves the song waiting for its file, as before.
   */
  private fun playFromSource(song: MediaHub.Song, gen: Int) {
    if (!Streams.streamable(song.source)) return
    // Lookup and opening both stay on the stream's own thread: opening over the network takes
    // seconds, and the file opener must stay free for a download that lands first.
    streamer.execute {
      if (gen != loadGeneration) return@execute
      val s = runCatching { stream(song) }.onFailure { Log.w(TAG, "no stream for ${song.id.take(60)}", it) }.getOrNull() ?: return@execute
      if (gen != loadGeneration || waitingFor != song.id) return@execute
      val t0 = SystemClock.elapsedRealtime()
      val source = runCatching { DecodedSource(context, Uri.parse(s.url), s.headers) }
        .onFailure { Log.w(TAG, "could not open the stream of ${song.id.take(60)}", it) }
        .getOrNull()
      Log.i(TAG, "stream open ${if (source != null) "ok" else "failed"} in ${SystemClock.elapsedRealtime() - t0} ms")
      main.post {
        if (gen != loadGeneration || waitingFor != song.id) { source?.close(); return@post }
        if (source == null) return@post
        waitingFor = null
        main.removeCallbacks(fileWatch)
        Log.i(TAG, "streaming ${song.id.take(60)} while it downloads, from ${pendingStartMs} ms")
        engine.load(song.id, source, pendingStartMs * SAMPLE_RATE / 1000, play = playWhenReady)
        loadedKey = song.id
        streamingKey = song.id
        invalidateState()
        prepareNext()
        emitSoon()
      }
    }
  }

  /** What comes after the current song: the page's cue when it gave one, else the queue's choice. */
  private fun upcoming(): MediaHub.Song? {
    val now = queue.current?.song?.id ?: return null
    if (queue.repeatsSong) return null
    if (cueFor == now) return cue
    if (pageLive) return null // the page has not decided yet; never guess ahead of it
    return queue.peekAfterEnd()?.let { queue.items[it].song }?.takeIf { it.id != now }
  }

  /** Prepare silently even with mixing off; only decoder-end promotion changes the main song. */
  private fun prepareNext() {
    if (radioLive) return
    val next = upcoming()
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
        // Both songs of the coming blend are measured now, minutes before it is needed.
        measureCues(next)
        queue.current?.song?.takeIf { it.id == loadedKey && streamingKey != it.id }?.let(::measureCues)
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
    // The engine has ended the old source and begun this one; never reload or restart its fade.
    if (queue.current?.song?.id != outgoing.key) return
    val promoted = cue?.takeIf { it.id == key } ?: lookup(key)
    if (!queue.select(key)) promoted?.let { queue.set(queue.items + Entry(it), queue.items.size) }
    if (queue.current?.song?.id != key) return
    streamingKey = null
    waitingFor = null
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
    // One more whole play of this song has begun: one fewer is owed (infinity owes them all).
    if (queue.current?.song?.id == heard.key) queue.consumeRepeat()
    log("repeat", heard, advanced = false)
    preparedNextKey = null
    prepareNext() // on the last owed play, cue what follows it
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

  /**
   * The download says the moment a file lands, so the chosen song opens then instead of on the
   * watch's next look up to FILE_WATCH_MS later (measured 0.77 s). The watch stays as the backstop.
   */
  private val stopLanded = landed { url ->
    main.post {
      if (waitingFor != null && queue.current?.song?.source == url) {
        main.removeCallbacks(fileWatch)
        fileWatch.run()
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
      // QUEUE-HEARD-001: when, so the phone page and the service page give this listen the same id.
      .put("at", System.currentTimeMillis())
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
      .put("streaming", streamingKey != null && streamingKey == loadedKey)
      .put("ended", ended)
      .put("error", error?.message ?: JSONObject.NULL)
      .put("positionMs", positionMs(snap))
      .put("durationMs", if (current != null) durationUs(current.song, snap).let { if (it == C.TIME_UNSET) -1 else it / 1000 } else -1)
      .put("blending", snap.blendingInto ?: JSONObject.NULL)
      // PLAYER-TRUTH-001: the song the deck is actually sounding. Until a chosen song's audio opens the
      // engine keeps playing the one before, and the page keeps showing that one.
      .put("sounding", snap.key?.takeUnless { radioLive } ?: JSONObject.NULL)
      .put("soundingPlaying", snap.playing)
      .put("soundingMs", snap.positionFrames * 1000 / SAMPLE_RATE)
      .put("soundingDurMs", if (snap.durationFrames > 0) snap.durationFrames * 1000 / SAMPLE_RATE else -1)
      .put("at", SystemClock.elapsedRealtime())
      // QUEUE-HEARD-001: with no phone page open the service page records listens and tops the queue up.
      .put("pageLive", pageLive)
      .apply { if (event != null) put("event", event) }
  }

  private fun emit(event: JSONObject?) {
    val p = page?.takeIf { it.live }
    val o = observer
    if (p == null && o == null) return
    val json = stateJson(event)
    if (o != null) runCatching { o(JSONObject(json.toString())) }
    if (p != null) runCatching { p.state(json) }
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

  init {
    queue.onRepeatChanged = { queueRepeatChanged() }
    main.post(ticker)
  }

  companion object {
    private const val TAG = "AirwaveEnginePlayer"
    /** CAR-CONTROLS-001: request-metadata flag on the item the car's playlist picker answers with: keep it as it is. */
    const val KEEP_PLAYING = "com.nowplaying.discovery.KEEP_PLAYING"
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
