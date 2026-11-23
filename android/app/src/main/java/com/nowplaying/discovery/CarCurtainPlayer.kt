package com.nowplaying.discovery

import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * CAR-PICK-LIST-001 (owner, 2026-11-23): "on android auto the playlist menu should replace the current playing
 * track player and quick controls, open up a list where the user can select playlist then get taken back to the
 * song player once the track is added".
 *
 * A player with nothing in it. While the driver chooses a playlist, the media SESSION shows the car this player
 * instead of the real one: Android Auto leaves its player screen for the app's lists when the app has nothing
 * playing to show (measured on the head unit with Android Auto 17.9), and those lists hold the playlists then.
 * The real player is not touched, so the music keeps playing and everything in the service that reads it still
 * reads the truth.
 *
 * Anything a controller asks of this player ends the choice first ([lift] puts the real player back) and is then
 * done by the real player, so a Pause on the steering wheel is still a Pause.
 */
@UnstableApi
class CarCurtainPlayer(looper: Looper, private val real: () -> Player, private val lift: () -> Unit) : SimpleBasePlayer(looper) {
  override fun getState(): State = State.Builder()
    .setAvailableCommands(COMMANDS)
    .setPlaybackState(Player.STATE_IDLE)
    .setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
    .build()

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> { lift(); real().playWhenReady = playWhenReady; return Futures.immediateVoidFuture() }
  override fun handlePrepare(): ListenableFuture<*> { lift(); real().prepare(); return Futures.immediateVoidFuture() }
  override fun handleStop(): ListenableFuture<*> { lift(); real().stop(); return Futures.immediateVoidFuture() }
  override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
    lift(); real().setMediaItems(mediaItems, startIndex, startPositionMs); return Futures.immediateVoidFuture()
  }

  private companion object {
    /** What a row tap and a steering-wheel key need; nothing that reads a queue this player does not have. */
    val COMMANDS: Player.Commands = Player.Commands.Builder().addAll(
      Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE, Player.COMMAND_STOP, Player.COMMAND_SET_MEDIA_ITEM,
      Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA,
    ).build()
  }
}
