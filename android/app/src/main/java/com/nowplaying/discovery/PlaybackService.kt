package com.nowplaying.discovery

import android.content.Intent
import android.app.PendingIntent
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * The native music player service (MEDIA-NATIVE-001). It hosts the [WebPlayer] proxy and a
 * [MediaLibraryService.MediaLibrarySession], which gives the app:
 *  - background playback: while the page is playing the service runs in the foreground with a media
 *    notification, so the WebView keeps rendering audio with the screen off;
 *  - lock-screen and quick-panel controls, Bluetooth/headset buttons: System UI/One UI draw them
 *    from the session and the buttons route back through [WebPlayer] to the page;
 *  - Android Auto: the browse tree below (Song list + Playlists) and voice/typed search, with every
 *    tap resolved to the page's song id so the car plays the real local recording.
 */
@UnstableApi
class PlaybackService : MediaLibraryService() {
  private lateinit var player: WebPlayer
  private var session: MediaLibrarySession? = null

  override fun onCreate() {
    super.onCreate()
    player = WebPlayer(mainLooper)
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    session = MediaLibrarySession.Builder(this, player, LibraryCallback())
      .setSessionActivity(open)
      .build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    val p = player
    if (!p.playWhenReady || p.mediaItemCount == 0) {
      // Nothing is playing and the user swiped the app away: let the service die with the task.
      session?.let { it.release() }
      session = null
      stopSelf()
    }
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    session?.release()
    session = null
    player.release()
    super.onDestroy()
  }

  private inner class LibraryCallback : MediaLibrarySession.Callback {
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
      MediaSession.ConnectionResult.AcceptedResultBuilder(session).build()

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val extras = android.os.Bundle().apply {
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
      }
      val root = folderItem(ROOT, "Airwave Discovery", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
      return Futures.immediateFuture(
        LibraryResult.ofItem(root, LibraryParams.Builder().setExtras(extras).build()),
      )
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val items: List<MediaItem> = when {
        parentId == ROOT -> listOf(
          folderItem(FOLDER_SONGS, "Song list", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED),
          folderItem(FOLDER_PLAYLISTS, "Playlists", MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS),
        )
        parentId == FOLDER_SONGS -> MediaHub.songs.map { songItem(it) }
        parentId == FOLDER_PLAYLISTS -> MediaHub.playlists.map {
          folderItem("$PLAYLIST_PREFIX${Uri.encode(it.id)}", it.title, MediaMetadata.MEDIA_TYPE_PLAYLIST)
        }
        parentId.startsWith(PLAYLIST_PREFIX) -> {
          val listId = Uri.decode(parentId.removePrefix(PLAYLIST_PREFIX))
          MediaHub.playlist(listId)?.songs?.map { songItem(it, playlistTrackId(listId, it.id)) } ?: emptyList()
        }
        else -> emptyList()
      }
      return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(page(items, page, pageSize)), params))
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val item: MediaItem? = when {
        mediaId == ROOT -> folderItem(ROOT, "Airwave Discovery", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
        mediaId == FOLDER_SONGS -> folderItem(FOLDER_SONGS, "Song list", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
        mediaId == FOLDER_PLAYLISTS -> folderItem(FOLDER_PLAYLISTS, "Playlists", MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS)
        mediaId.startsWith(PLAYLIST_PREFIX) && mediaId.contains("/track/") ->
          scopedSong(mediaId)?.let { songItem(it, mediaId) }
        mediaId.startsWith(PLAYLIST_PREFIX) ->
          MediaHub.playlist(Uri.decode(mediaId.removePrefix(PLAYLIST_PREFIX)))?.let { folderItem(mediaId, it.title, MediaMetadata.MEDIA_TYPE_PLAYLIST) }
        else -> MediaHub.findSong(mediaId)?.let { songItem(it) }
      }
      return if (item != null) Futures.immediateFuture(LibraryResult.ofItem(item, null))
      else Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
    }

    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> {
      session.notifySearchResultChanged(browser, query, MediaHub.search(query).size, params)
      return Futures.immediateFuture(LibraryResult.ofVoid())
    }

    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
      Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(page(MediaHub.search(query).map { songItem(it) }, page, pageSize)), params))

    /** A tap in the car, or a voice request ("play X"), arrives here as bare ids or a search query;
     *  resolve each to a real song so the player can forward the right id to the page. */
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> =
      Futures.immediateFuture(mediaItems.map(::resolve).toMutableList())

    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val resolved = mediaItems.map(::resolve)
      return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(resolved, startIndex, startPositionMs))
    }

    private fun resolve(item: MediaItem): MediaItem {
      val query = item.requestMetadata.searchQuery
      val scoped = if (query.isNullOrBlank()) scopedSong(item.mediaId) else null
      if (scoped != null) return songItem(scoped, item.mediaId)
      val song = if (!query.isNullOrBlank()) {
        val hits = MediaHub.search(query)
        hits.firstOrNull { it.ready } ?: hits.firstOrNull()
      } else {
        item.mediaId.takeIf { it.isNotBlank() }?.let { MediaHub.findSong(it) }
      }
      return song?.let { songItem(it) } ?: item
    }
  }

  private fun <T> page(items: List<T>, index: Int, size: Int): List<T> {
    if (index < 0 || size <= 0) return emptyList()
    val from = index.toLong() * size
    if (from >= items.size) return emptyList()
    return items.subList(from.toInt(), (from + size).coerceAtMost(items.size.toLong()).toInt())
  }

  private fun folderItem(id: String, title: String, mediaType: Int): MediaItem =
    MediaItem.Builder()
      .setMediaId(id)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(title)
          .setIsBrowsable(true)
          .setIsPlayable(false)
          .setMediaType(mediaType)
          .build(),
      )
      .build()

  private fun playlistTrackId(listId: String, songId: String) =
    "$PLAYLIST_PREFIX${Uri.encode(listId)}/track/${Uri.encode(songId)}"

  private fun scopedSong(mediaId: String): MediaHub.Song? {
    val match = Regex("^playlist/([^/]+)/track/([^/]+)$").matchEntire(mediaId) ?: return null
    val listId = Uri.decode(match.groupValues[1])
    val songId = Uri.decode(match.groupValues[2])
    if (mediaId != playlistTrackId(listId, songId)) return null
    return MediaHub.playlist(listId)?.songs?.firstOrNull { it.id == songId }
  }

  private fun songItem(song: MediaHub.Song, id: String = song.id): MediaItem =
    MediaItem.Builder()
      .setMediaId(id)
      .setMediaMetadata(WebPlayer.metadataOf(song, playable = true))
      .build()

  private companion object {
    const val ROOT = "/"
    const val FOLDER_SONGS = "songs"
    const val FOLDER_PLAYLISTS = "playlists"
    const val PLAYLIST_PREFIX = "playlist/"
  }
}
