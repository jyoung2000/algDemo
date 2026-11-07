package com.nowplaying.discovery

import android.net.Uri
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject

/**
 * A [SimpleBasePlayer] that renders no audio of its own. Its state is whatever the WebView last
 * reported to [MediaHub], and every transport command (play/pause, seek, next/previous, select a
 * queue item, shuffle, repeat) is forwarded back to the page, which drives the real Web Audio
 * engine. That is what lets the lock screen, Bluetooth and Android Auto control the same playback
 * that carries the equaliser, crossfade and mixer (MEDIA-NATIVE-001).
 *
 * The page is the authority: this player does not optimistically mutate its own state, it asks the
 * page and re-reads once the page pushes the result back through [MediaHub.apply].
 */
@UnstableApi
class WebPlayer(looper: Looper) : SimpleBasePlayer(looper) {
  private val onHubChange: () -> Unit = { invalidateState() }

  init { MediaHub.addListener(onHubChange) }

  override fun getState(): State {
    val s = MediaHub.state
    val commands = Player.Commands.Builder()
      .addAll(
        Player.COMMAND_PLAY_PAUSE,
        Player.COMMAND_PREPARE,
        Player.COMMAND_STOP,
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        Player.COMMAND_SEEK_BACK,
        Player.COMMAND_SEEK_FORWARD,
        Player.COMMAND_SEEK_TO_MEDIA_ITEM,
        Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
        Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
        Player.COMMAND_GET_METADATA,
        Player.COMMAND_GET_TIMELINE,
        Player.COMMAND_SET_SHUFFLE_MODE,
        Player.COMMAND_SET_REPEAT_MODE,
        Player.COMMAND_SET_MEDIA_ITEM,
        Player.COMMAND_CHANGE_MEDIA_ITEMS,
        Player.COMMAND_SET_SPEED_AND_PITCH,
      )
      .build()

    // The page can switch to a saved-list song before it has published the matching queue. Never
    // let the OS/car announce an unrelated queue entry as the song that is actually playing.
    val currentInQueue = s.queue.indexOfFirst { it.id == s.mediaId }
    val actualQueue = if (s.hasTrack && currentInQueue < 0) listOf(currentAsSong(s)) + s.queue else s.queue
    val playlist: List<MediaItemData> =
      if (actualQueue.isNotEmpty()) actualQueue.map { mediaItemData(it) }
      else if (s.hasTrack) listOf(mediaItemData(currentAsSong(s)))
      else emptyList()

    val index = if (playlist.isEmpty()) 0 else if (currentInQueue >= 0) currentInQueue else 0
    val basePos = if (s.hasTrack) {
      val elapsed = if (s.playing) (SystemClock.elapsedRealtime() - s.reportedAt).coerceAtLeast(0) else 0
      (s.positionMs + elapsed).coerceAtLeast(0)
    } else 0L
    val position =
      if (s.playing && s.hasTrack) PositionSupplier.getExtrapolating(basePos, 1f)
      else PositionSupplier.getConstant(basePos)

    return State.Builder()
      .setAvailableCommands(commands)
      .setPlaybackState(if (s.hasTrack) Player.STATE_READY else Player.STATE_IDLE)
      .setPlayWhenReady(s.playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setPlaylist(playlist)
      .setCurrentMediaItemIndex(index)
      .setContentPositionMs(position)
      .setShuffleModeEnabled(s.shuffle)
      .setRepeatMode(
        when (s.repeat) {
          1 -> Player.REPEAT_MODE_ONE
          2 -> Player.REPEAT_MODE_ALL
          else -> Player.REPEAT_MODE_OFF
        },
      )
      .build()
  }

  private fun currentAsSong(s: MediaHub.State) = MediaHub.Song(
    id = s.mediaId ?: "now",
    title = s.title,
    artist = s.artist,
    album = s.album,
    artwork = s.artwork,
    durationMs = s.durationMs,
    ready = true,
  )

  private fun mediaItemData(song: MediaHub.Song): MediaItemData =
    MediaItemData.Builder(song.id)
      .setMediaItem(
        MediaItem.Builder()
          .setMediaId(song.id)
          .setMediaMetadata(metadataOf(song, playable = true))
          .build(),
      )
      .setMediaMetadata(metadataOf(song, playable = true))
      .setDurationUs(if (song.durationMs > 0) song.durationMs * 1000 else C.TIME_UNSET)
      .setIsSeekable(true)
      .build()

  private fun send(cmd: JSONObject): ListenableFuture<*> {
    MediaHub.command(cmd)
    return Futures.immediateVoidFuture()
  }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> =
    send(JSONObject().put("type", if (playWhenReady) "play" else "pause"))

  override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleStop(): ListenableFuture<*> = send(JSONObject().put("type", "pause"))

  override fun handleRelease(): ListenableFuture<*> {
    MediaHub.removeListener(onHubChange)
    return Futures.immediateVoidFuture()
  }

  override fun handleSetRepeatMode(repeatMode: Int): ListenableFuture<*> =
    send(
      JSONObject().put(
        "type", "repeat",
      ).put(
        "mode",
        when (repeatMode) {
          Player.REPEAT_MODE_ONE -> 1
          Player.REPEAT_MODE_ALL -> 2
          else -> 0
        },
      ),
    )

  override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean): ListenableFuture<*> =
    send(JSONObject().put("type", "shuffle").put("on", shuffleModeEnabled))

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> =
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM ->
        send(JSONObject().put("type", "next"))
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM ->
        send(JSONObject().put("type", "prev"))
      Player.COMMAND_SEEK_TO_MEDIA_ITEM -> {
        val song = MediaHub.state.queue.getOrNull(mediaItemIndex)
        if (song != null) send(JSONObject().put("type", "playId").put("id", song.id))
        else send(JSONObject().put("type", "playIndex").put("index", mediaItemIndex))
      }
      else -> send(JSONObject().put("type", "seek").put("positionMs", positionMs.coerceAtLeast(0)))
    }

  override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
    val pick = mediaItems.getOrNull(if (startIndex == C.INDEX_UNSET) 0 else startIndex) ?: mediaItems.firstOrNull()
    val id = pick?.mediaId?.takeIf { it.isNotBlank() }
    return if (id != null) send(JSONObject().put("type", "playId").put("id", id))
    else Futures.immediateVoidFuture()
  }

  override fun handleAddMediaItems(index: Int, mediaItems: MutableList<MediaItem>): ListenableFuture<*> {
    val id = mediaItems.firstOrNull()?.mediaId?.takeIf { it.isNotBlank() }
    return if (id != null) send(JSONObject().put("type", "playId").put("id", id))
    else Futures.immediateVoidFuture()
  }

  companion object {
    /** Shared metadata builder so the browse tree and the now-playing card describe a song the same way. */
    fun metadataOf(song: MediaHub.Song, playable: Boolean, browsable: Boolean = false): MediaMetadata {
      val b = MediaMetadata.Builder()
        .setTitle(song.title)
        .setArtist(song.artist)
        .setIsBrowsable(browsable)
        .setIsPlayable(playable)
        .setMediaType(if (browsable) MediaMetadata.MEDIA_TYPE_PLAYLIST else MediaMetadata.MEDIA_TYPE_MUSIC)
      song.album?.let { b.setAlbumTitle(it) }
      artworkUri(song.artwork)?.let { b.setArtworkUri(it) }
      if (song.durationMs > 0) b.setDurationMs(song.durationMs)
      return b.build()
    }

    /** Only http(s) artwork is handed to the system BitmapLoader; the app-origin art lives inside the
     *  WebView and cannot be fetched by System UI or the car, so it is left unset there. */
    fun artworkUri(url: String?): Uri? {
      if (url.isNullOrBlank()) return null
      val lower = url.lowercase()
      return if (lower.startsWith("https://") || lower.startsWith("http://")) runCatching { Uri.parse(url) }.getOrNull() else null
    }
  }
}
