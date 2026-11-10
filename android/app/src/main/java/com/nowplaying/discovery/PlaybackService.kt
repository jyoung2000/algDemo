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
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.google.common.util.concurrent.FutureCallback
import com.google.common.util.concurrent.MoreExecutors
import com.nowplaying.discovery.engine.EngineHub
import com.nowplaying.discovery.engine.EnginePlayer
import com.nowplaying.discovery.engine.TapOutput
import com.nowplaying.discovery.engine.TrackOutput

/**
 * Owns playback. The session's player is the native [EnginePlayer]: it decodes the songs held on the
 * phone and renders them through the app's own EQ, crossfade and mixer, so audio carries on with the
 * screen off and after the app is swiped away, and the lock screen, Bluetooth and Android Auto
 * control it directly. Android Auto draws the standard host UI from the browse tree, search support
 * and the player's commands. (Cold start with no page ever opened is plan Task 3.)
 */
@UnstableApi
class PlaybackService : MediaLibraryService() {
  private lateinit var player: EnginePlayer
  private var session: MediaLibrarySession? = null
  private val libraryListener: () -> Unit = { EngineHub.libraryChanged() }

  override fun onCreate() {
    super.onCreate()
    // Playlist rows carry their list in the media id; the player resolves them as the browse tree does.
    // Debug builds can record what they play (TapOutput); release builds always get the plain track.
    val output = TapOutput.wrap(this, BuildConfig.DEBUG, TrackOutput())
    player = EnginePlayer(this, mainLooper, lookup = { id -> scopedSong(id) ?: MediaHub.findSong(id) }, output = output)
    EngineHub.attachPlayer(player)
    MediaHub.addListener(libraryListener)
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
    MediaHub.removeListener(libraryListener)
    EngineHub.detachPlayer(player)
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
        // Standard browser search hint; no fake Search folder or dead-end custom car screen.
        putBoolean("android.media.browse.SEARCH_SUPPORTED", true)
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
        parentId == ROOT -> listOfNotNull(
          folderItem(FOLDER_SONGS, "Now playing queue", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Your playback queue"),
          folderItem(FOLDER_PLAYLISTS, "Playlists", MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS, "Your saved playlists"),
          // ALBUM-SAVE-001: saved albums have their own section, shown once one is saved.
          if (MediaHub.savedAlbums().isNotEmpty()) folderItem(FOLDER_ALBUMS, "Albums", MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS, "Your saved albums") else null,
        )
        parentId == FOLDER_SONGS -> MediaHub.songs.map { songItem(it) }
        parentId == FOLDER_PLAYLISTS -> MediaHub.savedLists().map {
          folderItem("$PLAYLIST_PREFIX${Uri.encode(it.id)}", it.title, MediaMetadata.MEDIA_TYPE_PLAYLIST)
        }
        parentId == FOLDER_ALBUMS -> MediaHub.savedAlbums().map { albumItem(it) }
        // ALBUM-CAR-001: an album a car search found, its songs in album order.
        parentId.startsWith(CAR_ALBUM_PREFIX) && !parentId.contains("/track/") ->
          MediaHub.catalogAlbum(Uri.decode(parentId.removePrefix(CAR_ALBUM_PREFIX)))?.songs?.map { songItem(it) } ?: emptyList()
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
        mediaId == FOLDER_SONGS -> folderItem(FOLDER_SONGS, "Now playing queue", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Your playback queue")
        mediaId == FOLDER_PLAYLISTS -> folderItem(FOLDER_PLAYLISTS, "Playlists", MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS, "Your saved playlists")
        mediaId == FOLDER_ALBUMS -> folderItem(FOLDER_ALBUMS, "Albums", MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS, "Your saved albums")
        mediaId.startsWith(PLAYLIST_PREFIX) && mediaId.contains("/track/") ->
          scopedSong(mediaId)?.let { songItem(it, mediaId) }
        mediaId.startsWith(PLAYLIST_PREFIX) ->
          MediaHub.playlist(Uri.decode(mediaId.removePrefix(PLAYLIST_PREFIX)))?.let { if (it.album) albumItem(it) else folderItem(mediaId, it.title, MediaMetadata.MEDIA_TYPE_PLAYLIST) }
        mediaId.startsWith(CAR_ALBUM_PREFIX) && !mediaId.contains("/track/") ->
          MediaHub.catalogAlbum(Uri.decode(mediaId.removePrefix(CAR_ALBUM_PREFIX)))?.let { albumItem(it) }
        else -> MediaHub.findSong(mediaId)?.let { songItem(it) }
      }
      return if (item != null) Futures.immediateFuture(LibraryResult.ofItem(item, null))
      else Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
    }

    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> {
      // The legacy AA adapter ignores onSearch's future and completes only after this notification.
      // Notify on BOTH success and failure; otherwise an offline/timeout query spins forever.
      Futures.addCallback(MediaHub.searchCatalog(query), object : FutureCallback<List<MediaHub.Song>> {
        override fun onSuccess(songs: List<MediaHub.Song>?) {
          val count = (songs?.size ?: 0) + MediaHub.albumsFor(query).size
          android.os.Handler(mainLooper).post { session.notifySearchResultChanged(browser, query, count, params) }
        }
        override fun onFailure(error: Throwable) {
          android.os.Handler(mainLooper).post { session.notifySearchResultChanged(browser, query, 0, params) }
        }
      }, MoreExecutors.directExecutor())
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
      searchResult(query) { songs ->
        // ALBUM-CAR-001: the albums the words found come first, as folders the driver can open.
        val albums = MediaHub.albumsFor(query).map { albumItem(it) }
        LibraryResult.ofItemList(ImmutableList.copyOf(page(albums + songs.map { songItem(it) }, page, pageSize)), params)
      }

    private fun <T : Any> searchResult(query: String, value: (List<MediaHub.Song>) -> LibraryResult<T>): ListenableFuture<LibraryResult<T>> {
      val result = SettableFuture.create<LibraryResult<T>>()
      Futures.addCallback(MediaHub.searchCatalog(query), object : FutureCallback<List<MediaHub.Song>> {
        override fun onSuccess(songs: List<MediaHub.Song>?) {
          android.os.Handler(mainLooper).post { result.set(value(songs ?: emptyList())) }
        }
        override fun onFailure(error: Throwable) {
          result.set(LibraryResult.ofError(SessionError.ERROR_UNKNOWN))
        }
      }, MoreExecutors.directExecutor())
      return result
    }

    /** A tap in the car, or a voice request ("play X"), arrives here as bare ids or a search query;
     *  resolve each to a real song so the player can forward the right id to the page. */
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> =
      Futures.transform(Futures.allAsList(mediaItems.map(::resolveAsync)), { it!!.toMutableList() }, MoreExecutors.directExecutor())

    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      return Futures.transform(Futures.allAsList(mediaItems.map(::resolveAsync)), { resolved ->
        MediaSession.MediaItemsWithStartPosition(resolved!!, startIndex, startPositionMs)
      }, MoreExecutors.directExecutor())
    }

    private fun resolveAsync(item: MediaItem): ListenableFuture<MediaItem> {
      val query = item.requestMetadata.searchQuery
      if (!query.isNullOrBlank()) {
        val album = asksForAlbum(item.requestMetadata.extras)
        return Futures.transform(MediaHub.searchCatalog(query, album = album), { hits ->
          // ALBUM-CAR-001: "play the album …", or words naming an album, play that album from its start.
          MediaHub.albumToPlay(query, album)?.let { id ->
            (scopedSong(id) ?: MediaHub.findSong(id))?.let { return@transform songItem(it, id) }
          }
          val song = hits?.firstOrNull { it.ready } ?: hits?.firstOrNull()
            ?: throw IllegalArgumentException("No songs found")
          songItem(song)
        }, MoreExecutors.directExecutor())
      }
      val scoped = scopedSong(item.mediaId)
      if (scoped != null) return Futures.immediateFuture(songItem(scoped, item.mediaId))
      val song = MediaHub.findSong(item.mediaId)
        ?: return Futures.immediateFailedFuture(IllegalArgumentException("Unknown song"))
      return Futures.immediateFuture(songItem(song))
    }

  }

  private fun <T> page(items: List<T>, index: Int, size: Int): List<T> {
    if (index < 0 || size <= 0) return emptyList()
    val from = index.toLong() * size
    if (from >= items.size) return emptyList()
    return items.subList(from.toInt(), (from + size).coerceAtMost(items.size.toLong()).toInt())
  }

  private fun folderItem(id: String, title: String, mediaType: Int, subtitle: String? = null): MediaItem =
    MediaItem.Builder()
      .setMediaId(id)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(title)
          .setSubtitle(subtitle)
          .setIsBrowsable(true)
          .setIsPlayable(false)
          .setMediaType(mediaType)
          .build(),
      )
      .build()

  /** A saved album or one a car search found, as a browsable album with its artist and cover. */
  private fun albumItem(album: MediaHub.Folder): MediaItem {
    val id = if (MediaHub.playlist(album.id) === album) "$PLAYLIST_PREFIX${Uri.encode(album.id)}" else "$CAR_ALBUM_PREFIX${Uri.encode(album.id)}"
    return MediaItem.Builder()
      .setMediaId(id)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(album.title)
          .setSubtitle(album.artist)
          .setArtist(album.artist)
          .setAlbumTitle(album.title)
          .setArtworkUri(album.artwork?.let(Uri::parse))
          .setIsBrowsable(true)
          .setIsPlayable(false)
          .setMediaType(MediaMetadata.MEDIA_TYPE_ALBUM)
          .build(),
      )
      .build()
  }

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
    const val FOLDER_ALBUMS = "albums"
    const val CAR_ALBUM_PREFIX = "calbum/"

    fun asksForAlbum(extras: android.os.Bundle?): Boolean = extras != null && VoiceRequest.asksForAlbum(
      extras.getString(android.provider.MediaStore.EXTRA_MEDIA_FOCUS),
      extras.getString(android.provider.MediaStore.EXTRA_MEDIA_ALBUM),
      extras.getString(android.provider.MediaStore.EXTRA_MEDIA_TITLE),
    )
  }
}

/**
 * ALBUM-CAR-001: a voice request asks for an album when the assistant says so (the album focus), or
 * names an album and no song. Android Auto and Google Assistant pass these as MEDIA_PLAY_FROM_SEARCH extras.
 */
object VoiceRequest {
  fun asksForAlbum(focus: String?, album: String?, title: String?): Boolean =
    focus == android.provider.MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE || (!album.isNullOrBlank() && title.isNullOrBlank())
}
