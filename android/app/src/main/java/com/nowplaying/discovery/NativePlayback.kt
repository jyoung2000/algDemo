package com.nowplaying.discovery

import android.content.Context
import android.net.Uri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import java.io.File

/** Thin native playback slice. This class deliberately accepts only readable local audio bytes;
 * source discovery/identity/license verification belongs to the catalogue and download resolver.
 * Do not confuse an ExoPlayer smoke fixture with a recovered song from the original queue. */
@UnstableApi
class NativePlayback(private val context: Context) {
  val player: ExoPlayer = ExoPlayer.Builder(context)
    .setAudioAttributes(
      AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
      true,
    )
    .setHandleAudioBecomingNoisy(true)
    .setWakeMode(C.WAKE_MODE_LOCAL)
    .build()

  fun loadLocal(uri: Uri, title: String, artist: String, album: String? = null) {
    require(title.isNotBlank()) { "A playable item needs a title" }
    when (uri.scheme) {
      "file" -> {
        val raw = uri.path ?: throw IllegalArgumentException("Missing file")
        val file = File(raw).canonicalFile
        val roots = listOf(context.cacheDir, context.filesDir).map { it.canonicalFile }
        require(roots.any { file.path.startsWith(it.path + File.separator) }) { "Audio file is not app-private" }
        require(file.isFile && file.length() > 0) { "Local audio is missing or empty" }
      }
      "content" -> {
        val size = context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
        require(size != null && size > 0) { "Kept audio is missing or empty" }
      }
      else -> throw IllegalArgumentException("Only a verified local file may be played")
    }
    player.setMediaItem(MediaItem.Builder()
      .setMediaId(uri.toString())
      .setUri(uri)
      .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setArtist(NowPlayingLabel.artistLine(artist, album)).setAlbumTitle(album).build())
      .build())
    player.prepare()
  }

  fun release() { player.release() }
}
