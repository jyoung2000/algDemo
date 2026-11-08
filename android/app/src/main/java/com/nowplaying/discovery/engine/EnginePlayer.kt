package com.nowplaying.discovery.engine

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
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
import java.util.concurrent.Executors

/**
 * The service's own player: the [AudioEngine] (two decks, the app's EQ/crossfade/mixer, one
 * output) and the [PlayQueue], behind the standard Media3 [Player] interface, so the lock screen,
 * Bluetooth, the notification and Android Auto all control audio the service renders itself. Nothing
 * here depends on the Activity or the WebView being alive.
 *
 * A song is playable only when its complete audio is on the phone: [resolve] maps it to a local file
 * (by default `Downloads.localFile`, which re-checks the file every time) and an unplayable song is
 * skipped, never streamed or previewed. Opening a file happens off the main thread.
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
) : SimpleBasePlayer(looper) {
  private val main = Handler(looper)
  private val opener = Executors.newSingleThreadExecutor { r -> Thread(r, "AirwaveOpen").apply { isDaemon = true } }

  private val queue = PlayQueue<MediaHub.Song>(keyOf = { it.id }, isPlayable = { it.source != null && it.ready })
  private var playWhenReady = false
  private var ended = false
  private var error: PlaybackException? = null
  /** Bumped whenever the current song changes, so a slow open for an old song is dropped. */
  private var loadGeneration = 0
  private var loadedKey: String? = null
  private var preparedNextKey: String? = null
  private var mix = 0

  private val engine = AudioEngine(output, planner, object : AudioEngine.Listener {
    override fun onEnded(key: String) { main.post { songEnded(key) } }
    override fun onAdvanced(key: String) { main.post { blendPromoted(key) } }
    override fun onRepeated(key: String) { main.post { invalidateState() } }
    override fun onBlendStarted(key: String, seconds: Double, style: TransitionStyle) {
      Log.i(TAG, "blend into $key, ${"%.1f".format(seconds)} s ${style.id}")
    }
    override fun onError(key: String, error: Throwable) { main.post { songFailed(key, error) } }
  }, initialEq).also { it.start() }

  /* -------------------------------------------------------------- the mixer settings */

  fun setEq(config: EqConfig) = engine.setEq(config)
  fun setPlayThrough(percent: Int) = engine.setPlayThrough(percent)
  fun setMix(slider: Int) {
    mix = slider.coerceIn(0, 100)
    engine.setMix(mix)
    prepareNext()
  }

  /* -------------------------------------------------------------- Player state */

  override fun getState(): State {
    val snap = engine.snapshot
    val current = queue.current
    val playlist = queue.items.map { song ->
      MediaItemData.Builder(song.id)
        .setMediaItem(MediaItem.Builder().setMediaId(song.id).setMediaMetadata(WebPlayer.metadataOf(song, playable = true)).build())
        .setMediaMetadata(WebPlayer.metadataOf(song, playable = true))
        .setDurationUs(durationUs(song, snap))
        .setIsSeekable(true)
        .build()
    }
    val positionMs = if (current != null && snap.key == current.id) snap.positionFrames * 1000 / SAMPLE_RATE else 0L
    val loading = current != null && (loadedKey != current.id || snap.buffering)
    val state = when {
      error != null -> Player.STATE_IDLE
      current == null -> Player.STATE_IDLE
      ended -> Player.STATE_ENDED
      loading -> Player.STATE_BUFFERING
      else -> Player.STATE_READY
    }
    val playing = playWhenReady && state == Player.STATE_READY
    return State.Builder()
      .setAvailableCommands(COMMANDS)
      .setPlaybackState(state)
      .setPlayerError(error)
      .setPlayWhenReady(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setPlaylist(playlist)
      .setCurrentMediaItemIndex(queue.index.coerceAtLeast(0))
      .setContentPositionMs(
        if (playing) PositionSupplier.getExtrapolating(positionMs, 1f) else PositionSupplier.getConstant(positionMs),
      )
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

  private fun durationUs(song: MediaHub.Song, snap: AudioEngine.Snapshot): Long = when {
    snap.key == song.id && snap.durationFrames > 0 -> snap.durationFrames * 1_000_000 / SAMPLE_RATE
    song.durationMs > 0 -> song.durationMs * 1000
    else -> C.TIME_UNSET
  }

  /* -------------------------------------------------------------- commands from controllers */

  override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
    val songs = mediaItems.mapNotNull { item -> lookup(item.mediaId) }
    val start = if (startIndex == C.INDEX_UNSET) 0 else startIndex
    // Keep the start pointing at the same song even if unknown ids were dropped before it.
    val startId = mediaItems.getOrNull(start)?.mediaId
    queue.set(songs, songs.indexOfFirst { it.id == startId }.coerceAtLeast(0))
    loadCurrent(if (startPositionMs == C.TIME_UNSET) 0 else startPositionMs)
    return Futures.immediateVoidFuture()
  }

  override fun handleAddMediaItems(index: Int, mediaItems: MutableList<MediaItem>): ListenableFuture<*> {
    val add = mediaItems.mapNotNull { lookup(it.mediaId) }
    if (add.isEmpty()) return Futures.immediateVoidFuture()
    val at = index.coerceIn(0, queue.items.size)
    val keep = queue.current?.id
    val next = queue.items.toMutableList().apply { addAll(at, add) }
    queue.set(next, next.indexOfFirst { it.id == keep }.coerceAtLeast(0))
    if (keep == null) loadCurrent(0) else prepareNext()
    return Futures.immediateVoidFuture()
  }

  override fun handlePrepare(): ListenableFuture<*> {
    if (error != null) { error = null; loadCurrent(0) }
    return Futures.immediateVoidFuture()
  }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    this.playWhenReady = playWhenReady
    if (playWhenReady) {
      if (ended) { ended = false; queue.current?.let { loadCurrent(0) } } else engine.play()
    } else engine.pause()
    return Futures.immediateVoidFuture()
  }

  override fun handleStop(): ListenableFuture<*> {
    playWhenReady = false
    engine.pause()
    return Futures.immediateVoidFuture()
  }

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> queue.advance(pressed = true)?.let { loadCurrent(0) }
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> {
        // As every player does: a few seconds in, Previous restarts the song.
        val at = engine.snapshot.positionFrames * 1000 / SAMPLE_RATE
        if (seekCommand == Player.COMMAND_SEEK_TO_PREVIOUS && at > RESTART_THRESHOLD_MS) engine.seekTo(0)
        else if (queue.previous() != null) loadCurrent(0) else engine.seekTo(0)
      }
      Player.COMMAND_SEEK_TO_MEDIA_ITEM -> if (queue.select(mediaItemIndex)) loadCurrent(positionMs.coerceAtLeast(0))
      Player.COMMAND_SEEK_TO_DEFAULT_POSITION -> engine.seekTo(0)
      else -> engine.seekTo(positionMs.coerceAtLeast(0) * SAMPLE_RATE / 1000)
    }
    ended = false
    return Futures.immediateVoidFuture()
  }

  override fun handleSetRepeatMode(repeatMode: Int): ListenableFuture<*> {
    queue.repeat = when (repeatMode) {
      Player.REPEAT_MODE_ONE -> PlayQueue.Repeat.ONE
      Player.REPEAT_MODE_ALL -> PlayQueue.Repeat.ALL
      else -> PlayQueue.Repeat.OFF
    }
    engine.setRepeatOne(queue.repeat == PlayQueue.Repeat.ONE)
    preparedNextKey = null
    prepareNext()
    return Futures.immediateVoidFuture()
  }

  override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean): ListenableFuture<*> {
    queue.shuffle = shuffleModeEnabled
    preparedNextKey = null
    prepareNext()
    return Futures.immediateVoidFuture()
  }

  override fun handleRelease(): ListenableFuture<*> {
    loadGeneration++
    engine.close()
    opener.shutdownNow()
    return Futures.immediateVoidFuture()
  }

  /* -------------------------------------------------------------- loading */

  /** Open the current song (off the main thread) and hand it to the engine. Skips unplayable songs. */
  private fun loadCurrent(startMs: Long) {
    val song = queue.current ?: run { invalidateState(); return }
    val gen = ++loadGeneration
    loadedKey = null
    preparedNextKey = null
    ended = false
    error = null
    invalidateState()
    opener.execute {
      val source = runCatching { resolve(song)?.let { DecodedSource(context, it) } }
        .onFailure { Log.w(TAG, "could not open ${song.id}", it) }
        .getOrNull()
      main.post {
        if (gen != loadGeneration) { source?.close(); return@post }
        if (source == null) {
          // Not on the phone (evicted, never downloaded, unreadable): skip it rather than fake it.
          val next = queue.advance(pressed = true)
          if (next == null || queue.current?.id == song.id) {
            error = PlaybackException("“${song.title}” is not on this phone yet", null, PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND)
            invalidateState()
          } else loadCurrent(0)
          return@post
        }
        engine.load(song.id, source, startMs * SAMPLE_RATE / 1000, play = playWhenReady)
        loadedKey = song.id
        invalidateState()
        prepareNext()
      }
    }
  }

  /** With the mixer on, open the song after this one on the spare deck so the blend can start on time. */
  private fun prepareNext() {
    val nextIndex = queue.peekAfterEnd()
    val next = nextIndex?.let { queue.items[it] }
    if (mix <= 0 || next == null || next.id == queue.current?.id) {
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

  private fun songEnded(key: String) {
    if (queue.current?.id != key) return
    val next = queue.advance(pressed = false)
    if (next == null) {
      ended = true
      invalidateState()
      return
    }
    loadCurrent(0)
  }

  private fun blendPromoted(key: String) {
    // The engine already plays [key] from where the blend left it: move the queue, do not reload.
    val moved = queue.advance(pressed = false)
    if (moved == null || queue.current?.id != key) queue.select(key)
    loadedKey = key
    preparedNextKey = null
    invalidateState()
    prepareNext()
  }

  private fun songFailed(key: String, cause: Throwable) {
    Log.w(TAG, "playback failed for $key", cause)
    if (queue.current?.id != key) return
    if (queue.advance(pressed = true) != null && queue.current?.id != key) loadCurrent(0)
    else {
      error = PlaybackException("Could not play this song", cause, PlaybackException.ERROR_CODE_DECODING_FAILED)
      invalidateState()
    }
  }

  companion object {
    private const val TAG = "AirwaveEnginePlayer"
    private const val SAMPLE_RATE = 48000L
    private const val RESTART_THRESHOLD_MS = 3000L
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
