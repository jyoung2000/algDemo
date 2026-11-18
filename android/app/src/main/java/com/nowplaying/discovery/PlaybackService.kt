package com.nowplaying.discovery

import android.content.Intent
import android.app.PendingIntent
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
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
  private val libraryListener: () -> Unit = { EngineHub.libraryChanged(); refreshCarButtons() }
  /** CAR-ACTIONS-001: the Star / Dislike / Shuffle buttons follow the song and the shuffle mode. */
  private val carButtonListener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED, Player.EVENT_TIMELINE_CHANGED)) refreshCarButtons()
    }
  }
  private var shownCarButtons: List<String> = emptyList()
  private var radioSearchUntil = 0L
  private val radioListener: () -> Unit = { mainHandler.post {
    refreshCarButtons()
    session?.notifyChildrenChanged(RadioCatalog.FAVOURITES, RadioCatalog.favouriteCount().coerceAtLeast(1), null)
    session?.notifyChildrenChanged(RadioCatalog.ROOT, 3, null)
  }; Unit }
  /** CAR-SEARCH-TYPES-001: Identify records on its own thread; never on the session's. */
  private val listenExec = java.util.concurrent.Executors.newSingleThreadExecutor()
  private val mainHandler by lazy { android.os.Handler(mainLooper) }
  private val catalogStart = CatalogStartGate()
  private val startCatalog = Runnable {
    if (catalogStart.runQueued()) {
      // Preferences and saved-library parsing can touch disk; neither belongs in onCreate.
      CarFeedback.init(this)
      EngineHub.init(this)
      MediaHub.restoreLibrary()
      EngineHub.attachPlayer(player)
      // WEBVIEW-WARM-001: the WebView itself waits until its provider has loaded off the main thread.
      WebViewWarmup.whenReady(startCatalogWeb)
    }
  }
  /** WebView construction and loadUrl stay on the main thread. A destroyed service has no catalogue left to start. */
  private val startCatalogWeb = Runnable { catalog?.start() }
  /** The Identify run in progress or just finished, so the car asking twice does not listen twice. */
  private var identifyRun: Triple<Long, Int, ListenableFuture<List<MediaItem>>>? = null
  /** The host may ask for an old prefix's result after a newer query has arrived. */
  private val latestSearchByClient = java.util.concurrent.ConcurrentHashMap<String, String>()
  private fun searchClient(browser: MediaSession.ControllerInfo): String = "${browser.uid}:${browser.packageName}"

  override fun onCreate() {
    super.onCreate()
    // DL-COLD-READY-001: a car session may be the only thing running; unpack yt-dlp now, in the background.
    Downloads.warmUp(this)
    // Playlist rows carry their list in the media id; the player resolves them as the browse tree does.
    // Debug builds can record what they play (TapOutput); release builds always get the plain track.
    val output = TapOutput.wrap(this, BuildConfig.DEBUG, TrackOutput())
    player = EnginePlayer(this, mainLooper, lookup = { id -> scopedSong(id) ?: MediaHub.findSong(id) }, output = output)
    MediaHub.addListener(libraryListener)
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    session = MediaLibrarySession.Builder(this, player, LibraryCallback())
      .setSessionActivity(open)
      .setMediaButtonPreferences(carButtons())
      .build()
    player.addListener(carButtonListener)
    RadioCatalog.addListener(radioListener)
    RadioCatalog.load(this).addListener({ mainHandler.post { refreshCarButtons() } }, MoreExecutors.directExecutor())
    // CAR-CATALOG-SERVICE-001: register the command sink before returning, but make no WebView here.
    // MediaHub holds requests until catalogReady even if the car asks before the posted start runs.
    catalog = CatalogEngine(this).also { it.prepare() }
    if (catalogStart.schedule()) mainHandler.post(startCatalog)
  }

  private var catalog: CatalogEngine? = null

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
    catalogStart.destroy()
    mainHandler.removeCallbacks(startCatalog)
    WebViewWarmup.cancel(startCatalogWeb)
    RadioCatalog.removeListener(radioListener)
    MediaHub.removeListener(libraryListener)
    player.removeListener(carButtonListener)
    listenExec.shutdownNow()
    catalog?.destroy()
    catalog = null
    EngineHub.detachPlayer(player)
    session?.release()
    session = null
    player.release()
    super.onDestroy()
  }

  /**
   * CAR-ACTIONS-001: Star, Dislike and Shuffle on the car's player (owner, 2026-11-15). They sit in
   * the overflow slot, so Previous / Play-Pause / Next keep their places: the car still shows track
   * skips, never timed seeks. Media3 turns these into the platform session's custom actions, which
   * is what Android Auto draws.
   */
  private fun carButtons(): List<CommandButton> {
    RadioNative.session?.station?.let { station ->
      val starred = RadioCatalog.isFavourite(station)
      return listOf(CommandButton.Builder(if (starred) CommandButton.ICON_STAR_FILLED else CommandButton.ICON_STAR_UNFILLED)
        .setDisplayName(if (starred) "Remove favourite station" else "Favourite station")
        .setSessionCommand(STAR).setSlots(CommandButton.SLOT_OVERFLOW).build())
    }
    val id = currentSongId()
    val (starred, disliked) = CarFeedback.state(id)
    val shuffle = player.shuffleModeEnabled
    return listOf(
      CommandButton.Builder(if (starred) CommandButton.ICON_STAR_FILLED else CommandButton.ICON_STAR_UNFILLED)
        .setDisplayName(if (starred) "Remove star" else "Star")
        .setSessionCommand(STAR)
        .setSlots(CommandButton.SLOT_OVERFLOW)
        .build(),
      CommandButton.Builder(if (disliked) CommandButton.ICON_THUMB_DOWN_FILLED else CommandButton.ICON_THUMB_DOWN_UNFILLED)
        .setDisplayName(if (disliked) "Undo dislike" else "Dislike")
        .setSessionCommand(DISLIKE)
        .setSlots(CommandButton.SLOT_OVERFLOW)
        .build(),
      CommandButton.Builder(if (shuffle) CommandButton.ICON_SHUFFLE_ON else CommandButton.ICON_SHUFFLE_OFF)
        .setDisplayName(if (shuffle) "Shuffle on" else "Shuffle off")
        .setSessionCommand(SHUFFLE)
        .setSlots(CommandButton.SLOT_OVERFLOW)
        .build(),
    )
  }

  private fun refreshCarButtons() {
    val s = session ?: return
    val buttons = carButtons()
    val shown = buttons.map { "${it.sessionCommand?.customAction}:${it.icon}:${it.displayName}" }
    if (shown == shownCarButtons) return
    shownCarButtons = shown
    s.setMediaButtonPreferences(buttons)
  }

  /** The song now playing, as the page names it (a playlist row's id carries its list too). */
  private fun currentSongId(): String? {
    val id = player.currentMediaItem?.mediaId ?: return null
    val scoped = Regex("^playlist/([^/]+)/track/([^/]+)$").matchEntire(id) ?: return id
    return Uri.decode(scoped.groupValues[2])
  }

  private fun radioFolder(id: String): MediaItem? = when (id) {
    RadioCatalog.ROOT -> folderItem(id, "Radio", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "World radio and favourite stations")
    RadioCatalog.ALL -> folderItem(id, "All stations", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Browse stations by initial: A–Z and #")
    RadioCatalog.FAVOURITES -> folderItem(id, "Favourite stations", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Shared with your phone")
    RadioCatalog.SEARCH -> folderItem(id, "Search stations", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Tap the search button, or say radio KEXP")
    else -> if (id.matches(Regex("radio/letter/[A-Z0-9#]/[0-9]{1,7}"))) folderItem(id, id.split('/')[2].let { if (it == "#") "Numbers 0–9" else it }, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Stations beginning with this initial")
    else if (id.matches(Regex("radio/az/[0-9]{1,7}"))) folderItem(id, "Stations A–Z", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "World stations in alphabetical order") else null
  }

  private fun radioResults(words: String): ListenableFuture<List<MediaItem>> = Futures.catching(
    Futures.transform(RadioCatalog.stations(this, words), { rows -> rows.orEmpty().map(RadioCatalog::item).ifEmpty {
      listOf(note("No stations found", "Try another station name"))
    } }, MoreExecutors.directExecutor()),
    Exception::class.java, { listOf(note("Station search didn't finish", "Try Favourite stations or search again")) }, MoreExecutors.directExecutor(),
  )

  private fun radioChildren(id: String): ListenableFuture<List<MediaItem>> = when {
    id == RadioCatalog.ROOT -> Futures.immediateFuture(listOfNotNull(radioFolder(RadioCatalog.FAVOURITES), radioFolder(RadioCatalog.ALL), radioFolder(RadioCatalog.SEARCH)))
    id == RadioCatalog.ALL -> Futures.immediateFuture(listOfNotNull(radioFolder(RadioCatalog.AZ)) + RadioCatalog.LETTERS.mapNotNull { radioFolder("radio/letter/$it/0") })
    id == "radio/letter/#/0" -> Futures.immediateFuture(RadioCatalog.NUMBERS.mapNotNull { radioFolder("radio/letter/$it/0") })
    id.startsWith("radio/letter/") -> {
      val parts = id.split('/'); val letter = parts.getOrNull(2).orEmpty(); val offset = parts.getOrNull(3)?.toIntOrNull()
      if (offset == null || offset !in 0..1_000_000 || letter !in RadioCatalog.LETTERS + RadioCatalog.NUMBERS) Futures.immediateFailedFuture(IllegalArgumentException("Invalid station initial or page"))
      else Futures.transform(RadioCatalog.letterStations(this, letter, offset), { found ->
        val stations = found?.stations.orEmpty().map(RadioCatalog::item)
        stations + if (found?.nextOffset != null) listOf(folderItem("radio/letter/$letter/${found.nextOffset}", "More $letter stations", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED))
          else if (stations.isEmpty()) listOf(note("No stations with this initial", "Choose another initial or search")) else emptyList()
      }, MoreExecutors.directExecutor())
    }
    id == RadioCatalog.FAVOURITES -> Futures.transform(RadioCatalog.favouriteItems(this), { it.orEmpty().ifEmpty {
      listOf(note("No favourite stations yet", "Star a playing station here or on your phone"))
    } }, MoreExecutors.directExecutor())
    id == RadioCatalog.SEARCH -> {
      radioSearchUntil = android.os.SystemClock.elapsedRealtime() + CarSearch.STICKY_MS
      Futures.immediateFuture(listOf(note("Search stations is on", "Tap the search button and type a station name, or say radio KEXP")))
    }
    else -> {
      val offset = id.removePrefix("radio/az/").toIntOrNull()
      if (offset == null || offset !in 0..1_000_000) Futures.immediateFailedFuture(IllegalArgumentException("Invalid radio page"))
      else Futures.transform(RadioCatalog.stations(this, offset = offset), { rows ->
        val stations = rows.orEmpty().map(RadioCatalog::item)
        stations + if (rows.orEmpty().isNotEmpty() && offset <= 999900) listOf(folderItem("radio/az/${offset + RadioCatalog.PAGE_SIZE}", "More stations A–Z", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED))
        else if (stations.isEmpty()) listOf(note("End of stations", "Go back or search for a station")) else emptyList()
      }, MoreExecutors.directExecutor())
    }
  }

  private fun radioWords(query: String): String? {
    val now = android.os.SystemClock.elapsedRealtime(); val picked = CarSearch.picked(now)
    return CarSearch.radioQuery(query, picked) ?: query.trim().take(100).takeIf {
      it.isNotBlank() && now < radioSearchUntil && CarSearch.parse(query).first == CarSearchType.ALL
    }
  }
  private fun explicitRadio(query: String) = CarSearch.explicitRadioQuery(query) != null || android.os.SystemClock.elapsedRealtime() < radioSearchUntil
  private fun optionalStations(words: String): ListenableFuture<List<RadioCatalog.Station>> = Futures.catching(
    RadioCatalog.stations(this, words), Exception::class.java, { emptyList() }, MoreExecutors.directExecutor())

  // ------------------------------------------------------------------ CAR-SEARCH-TYPES-001

  private fun iconUri(type: CarSearchType): Uri {
    val res = when (type) {
      CarSearchType.ALL -> R.drawable.car_type_all
      CarSearchType.ARTISTS -> R.drawable.car_type_artist
      CarSearchType.SINGLES -> R.drawable.car_type_singles
      CarSearchType.ALBUMS -> R.drawable.car_type_albums
      CarSearchType.FEATURES -> R.drawable.car_type_features
      CarSearchType.LYRICS -> R.drawable.car_type_lyrics
      CarSearchType.IDENTIFY -> R.drawable.car_type_identify
    }
    return Uri.parse("android.resource://$packageName/drawable/${resources.getResourceEntryName(res)}")
  }

  private fun styled(item: MediaItem, group: String?, category: Boolean = false): MediaItem {
    val extras = Bundle(item.mediaMetadata.extras ?: Bundle.EMPTY)
    if (group != null) extras.putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, group)
    if (category) extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_SINGLE_ITEM, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_CATEGORY_GRID_ITEM)
    return item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build()).build()
  }

  /** An icon tile: a kind of result to show (or pick), or Identify. */
  private fun typeTile(id: String, type: CarSearchType, subtitle: String?, group: String?): MediaItem = styled(
    MediaItem.Builder().setMediaId(id).setMediaMetadata(
      MediaMetadata.Builder().setTitle(type.title).setSubtitle(subtitle).setArtworkUri(iconUri(type))
        .setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build(),
    ).build(),
    group, category = true,
  )

  /** A line of guidance in a list (Android Auto lists only folders and songs, so it is a folder). */
  private fun note(title: String, subtitle: String?): MediaItem {
    val base = folderItem("$HINT_PREFIX${Uri.encode(title)}", title, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, subtitle)
    // A plain row, so the whole sentence is readable (an icon tile cuts it off).
    val extras = Bundle().apply { putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_SINGLE_ITEM, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM) }
    return base.buildUpon().setMediaMetadata(base.mediaMetadata.buildUpon().setExtras(extras).build()).build()
  }

  /** The Search tab; its tiles are drawn as icons (category grid). */
  private fun searchFolder(): MediaItem {
    val base = folderItem(FOLDER_SEARCH, "Search", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Artists, singles, albums, lyrics, or identify a song")
    val extras = Bundle().apply { putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_CATEGORY_GRID_ITEM) }
    return base.buildUpon().setMediaMetadata(base.mediaMetadata.buildUpon().setExtras(extras).build()).build()
  }

  /** The Search tab: tap a kind, then the search button; or tap Identify. */
  private fun searchTab(): List<MediaItem> {
    val now = android.os.SystemClock.elapsedRealtime()
    val on = CarSearch.picked(now)
    return CarSearchType.entries.map { t ->
      val sub = if (t == on) "On for your next search" else t.hint
      typeTile(if (t == CarSearchType.IDENTIFY) IDENTIFY else "$TYPE_PREFIX${t.key}", t, sub, null)
    }
  }

  /** The songs (and for albums, the album folders) of [words] that are [type]. */
  private fun typedResults(words: String, type: CarSearchType, debounceMs: Long = 0, group: (CarSearchType) -> String?): ListenableFuture<List<MediaItem>> =
    Futures.transform(MediaHub.searchCatalog(words, mode = type, debounceMs = debounceMs), { songs ->
      val albums = if (type == CarSearchType.ALL || type == CarSearchType.ALBUMS) MediaHub.albumsFor(words, mode = type).map { styled(albumItem(it), group(CarSearchType.ALBUMS)) } else emptyList()
      val rows = songs.orEmpty().filter { CarSearch.matches(type, MediaHub.kindsOf(it, words)) }
        .map { styled(songItem(it), if (type == CarSearchType.ALL) "Songs" else group(type)) }
      albums + rows
    }, MoreExecutors.directExecutor())

  /**
   * What a car search shows (CAR-RESULTS-FIRST-001): what it found first (albums, then songs), then ONE
   * browsable "Show only" row that opens the type tiles. Android Auto showed only the first three
   * tiles of a leading seven-tile row and no song beneath it (DHU 2026-11-15), so results must lead.
   */
  private fun searchItems(query: String): ListenableFuture<List<MediaItem>> {
    radioWords(query)?.let { words ->
      if (explicitRadio(query)) return radioResults(words)
      return Futures.transformAsync(optionalStations(words), { rows ->
        if (rows.isNullOrEmpty()) musicSearchItems(query) else Futures.immediateFuture(rows.map(RadioCatalog::item))
      }, MoreExecutors.directExecutor())
    }
    return musicSearchItems(query)
  }
  private fun musicSearchItems(query: String): ListenableFuture<List<MediaItem>> {
    val (type, words) = CarSearch.parse(query, CarSearch.picked(android.os.SystemClock.elapsedRealtime()))
    if (type == CarSearchType.IDENTIFY) return identifyItems()
    if (words.isBlank()) return Futures.immediateFuture(emptyList())
    CarSearch.lastWords = words
    return Futures.transform(typedResults(words, type, 650) { it.title }, { it.orEmpty() + chooserRow(type, words) }, MoreExecutors.directExecutor())
  }

  /** The one row after a search's results: opens [chooserTiles]. Browsable, never playable. */
  private fun chooserRow(type: CarSearchType, words: String): MediaItem {
    val base = folderItem("$CHOOSE_PREFIX${type.key}/${Uri.encode(words)}", SHOW_ONLY, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Showing ${type.title.lowercase()} \u00b7 tap to change")
    val extras = Bundle().apply { putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_SINGLE_ITEM, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM) }
    return base.buildUpon().setMediaMetadata(base.mediaMetadata.buildUpon().setArtworkUri(iconUri(type)).setExtras(extras).build()).build()
  }

  /** The kinds a search can be narrowed to, the showing one marked; each opens [FILTER_PREFIX]. */
  private fun chooserTiles(type: CarSearchType, words: String): List<MediaItem> = CarSearchType.entries.map { t ->
    val id = if (t == CarSearchType.IDENTIFY) IDENTIFY else "$FILTER_PREFIX${t.key}/${Uri.encode(words)}"
    typeTile(id, t, if (t == type) "Showing now" else null, SHOW_ONLY)
  }

  /** Identify: listen to the music playing for a few seconds and name it with the phone's app. */
  private fun identifyItems(): ListenableFuture<List<MediaItem>> {
    val now = android.os.SystemClock.elapsedRealtime()
    identifyRun?.let { (at, epoch, f) -> if (epoch == CarIdentifyReuse.epoch && (!f.isDone || now - at < IDENTIFY_REUSE_MS)) return f }
    val out = SettableFuture.create<List<MediaItem>>()
    identifyRun = Triple(now, CarIdentifyReuse.epoch, out)
    if (!MediaHub.canIdentify()) {
      out.set(listOf(note("Open Airwave on your phone", "Then tap Identify again to name the music playing")))
      return out
    }
    // The phone would only hear Airwave itself; pause it while listening and carry on after.
    val wasPlaying = player.isPlaying
    if (wasPlaying) player.pause()
    val heard = "Identified"
    listenExec.execute {
      val clip = CarListener.listen(this)
      mainHandler.post { if (wasPlaying && !player.isPlaying) player.play() }
      when (clip) {
        is CarListener.Outcome.Heard -> Futures.addCallback(MediaHub.identify(clip.pcm), object : FutureCallback<List<MediaHub.Song>> {
          override fun onSuccess(songs: List<MediaHub.Song>?) {
            mainHandler.post {
              out.set(if (songs.isNullOrEmpty()) listOf(note("No match for that music", "Try again closer to the speaker, with the music louder"))
              else songs.map { styled(songItem(it), heard) })
            }
          }
          override fun onFailure(error: Throwable) {
            mainHandler.post { out.set(listOf(note("Couldn't identify the music", error.message?.take(120)))) }
          }
        }, MoreExecutors.directExecutor())
        CarListener.Outcome.NoPermission -> out.set(listOf(note("Airwave can't use the microphone", "Allow microphone access for Airwave on your phone")))
        CarListener.Outcome.Blocked -> out.set(listOf(note("Android kept the microphone off", "Open Airwave on your phone, then tap Identify again")))
        CarListener.Outcome.Silent -> out.set(listOf(note("No music heard", "Turn the music up and tap Identify again")))
        is CarListener.Outcome.Failed -> out.set(listOf(note("Couldn't use the microphone", clip.why.take(120))))
      }
    }
    return out
  }

  private inner class LibraryCallback : MediaLibrarySession.Callback {
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
      MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands(
          MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().add(STAR).add(DISLIKE).add(SHUFFLE).build(),
        )
        .setMediaButtonPreferences(carButtons())
        .build()

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      RadioNative.session?.station?.let { station ->
        if (customCommand.customAction != ACTION_STAR) return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
        return Futures.catching(Futures.transform(RadioCatalog.toggle(this@PlaybackService, station), {
          SessionResult(SessionResult.RESULT_SUCCESS)
        }, MoreExecutors.directExecutor()), Exception::class.java, { SessionResult(SessionError.ERROR_UNKNOWN) }, MoreExecutors.directExecutor())
      }
      when (customCommand.customAction) {
        ACTION_SHUFFLE -> player.shuffleModeEnabled = !player.shuffleModeEnabled
        ACTION_STAR -> {
          val id = currentSongId() ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
          CarFeedback.submit(id, if (CarFeedback.state(id).first) "unlike" else "like")
        }
        ACTION_DISLIKE -> {
          val id = currentSongId() ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
          val already = CarFeedback.state(id).second
          CarFeedback.submit(id, if (already) "undislike" else "dislike")
          // Not for me: move on, as the car's other music apps do. Undoing a dislike stays put.
          if (!already && player.hasNextMediaItem()) player.seekToNext()
        }
        else -> return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
      }
      refreshCarButtons()
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }


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
      if (parentId == RadioCatalog.ROOT || parentId.startsWith("radio/")) {
        if (radioFolder(parentId) == null) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
        radioSearchUntil = android.os.SystemClock.elapsedRealtime() + CarSearch.STICKY_MS
        return Futures.catching(Futures.transform(radioChildren(parentId), {
          LibraryResult.ofItemList(ImmutableList.copyOf(page(it.orEmpty(), page, pageSize)), params)
        }, MoreExecutors.directExecutor()), Exception::class.java, {
          LibraryResult.ofItemList(ImmutableList.copyOf(page(listOf(note("Station directory is unavailable", "Try Favourite stations or retry")), page, pageSize)), params)
        }, MoreExecutors.directExecutor())
      }
      radioSearchUntil = 0
      val items: List<MediaItem> = when {
        parentId == ROOT -> listOfNotNull(
          folderItem(FOLDER_SONGS, "Now playing queue", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Your playback queue"),
          folderItem(FOLDER_PLAYLISTS, "Playlists", MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS, "Your saved playlists"),
          // Android Auto shows at most four tabs. Albums remain under Playlists and via search.
          radioFolder(RadioCatalog.ROOT),
          searchFolder(),
        )
        parentId == FOLDER_SEARCH -> searchTab()
        parentId == IDENTIFY -> return Futures.transform(identifyItems(), { LibraryResult.ofItemList(ImmutableList.copyOf(page(it!!, page, pageSize)), params) }, MoreExecutors.directExecutor())
        parentId.startsWith(TYPE_PREFIX) -> {
          val type = CarSearchType.of(parentId.removePrefix(TYPE_PREFIX)) ?: return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
          radioSearchUntil = 0
          CarSearch.pick(type, android.os.SystemClock.elapsedRealtime())
          val hint = note(if (type == CarSearchType.ALL) "Tap the search button and say anything" else "Tap the search button. ${type.hint}", "${type.title} search is on")
          val last = CarSearch.lastWords
          if (last.isNullOrBlank()) listOf(hint)
          else return Futures.catching(
            Futures.transform(typedResults(last, type) { it.title }, { r -> LibraryResult.ofItemList(ImmutableList.copyOf(page(listOf(hint) + r!!, page, pageSize)), params) }, MoreExecutors.directExecutor()),
            Throwable::class.java, { LibraryResult.ofItemList(ImmutableList.of(hint), params) }, MoreExecutors.directExecutor(),
          )
        }
        // CAR-RESULTS-FIRST-001: the chooser row after a search's results opens the type tiles.
        parentId.startsWith(CHOOSE_PREFIX) -> {
          val rest = parentId.removePrefix(CHOOSE_PREFIX)
          val type = CarSearchType.of(rest.substringBefore('/')) ?: return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
          val words = Uri.decode(rest.substringAfter('/', ""))
          if (words.isBlank()) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
          chooserTiles(type, words)
        }
        parentId.startsWith(FILTER_PREFIX) -> {
          val rest = parentId.removePrefix(FILTER_PREFIX)
          val type = CarSearchType.of(rest.substringBefore('/')) ?: return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
          val words = Uri.decode(rest.substringAfter('/', ""))
          if (words.isBlank()) emptyList()
          else return Futures.catching(
            Futures.transform(typedResults(words, type) { it.title }, { r ->
              LibraryResult.ofItemList(ImmutableList.copyOf(page(r!!.ifEmpty { listOf(note("No ${type.title.lowercase()} found for \u201c$words\u201d", "Go back and tap All to see everything")) }, page, pageSize)), params)
            }, MoreExecutors.directExecutor()),
            // CAR-LYRICS-TRUTH-001: a typed search that could not run says so, and why, rather than an
            // empty error the car renders as nothing (or a "none found" that is not true).
            Throwable::class.java, { e ->
              val why = generateSequence(e) { it.cause }.mapNotNull { it.message?.takeIf(String::isNotBlank) }.firstOrNull()?.take(120)
              LibraryResult.ofItemList(ImmutableList.of(note("${type.title} search didn\u2019t finish", why ?: "Try again in a moment")), params)
            }, MoreExecutors.directExecutor(),
          )
        }
        parentId.startsWith(HINT_PREFIX) -> emptyList()
        parentId == FOLDER_SONGS -> MediaHub.songs.map { songItem(it) }
        parentId == FOLDER_PLAYLISTS -> listOfNotNull(
          if (MediaHub.savedAlbums().isNotEmpty()) folderItem(FOLDER_ALBUMS, "Albums", MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS, "Your saved albums") else null,
        ) + MediaHub.savedLists().map {
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
      radioFolder(mediaId)?.let { return Futures.immediateFuture(LibraryResult.ofItem(it, null)) }
      RadioCatalog.stationId(mediaId)?.let { id ->
        return Futures.catching(Futures.transform(RadioCatalog.async { RadioCatalog.resolve(this@PlaybackService, id) }, { station ->
          if (station == null) LibraryResult.ofError(SessionError.ERROR_BAD_VALUE) else LibraryResult.ofItem(RadioCatalog.item(station), null)
        }, MoreExecutors.directExecutor()), Exception::class.java, { LibraryResult.ofError(SessionError.ERROR_BAD_VALUE) }, MoreExecutors.directExecutor())
      }
      val item: MediaItem? = when {
        mediaId == ROOT -> folderItem(ROOT, "Airwave Discovery", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
        mediaId == FOLDER_SONGS -> folderItem(FOLDER_SONGS, "Now playing queue", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Your playback queue")
        mediaId == FOLDER_PLAYLISTS -> folderItem(FOLDER_PLAYLISTS, "Playlists", MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS, "Your saved playlists")
        mediaId == FOLDER_ALBUMS -> folderItem(FOLDER_ALBUMS, "Albums", MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS, "Your saved albums")
        mediaId == FOLDER_SEARCH -> searchFolder()
        mediaId == IDENTIFY -> typeTile(IDENTIFY, CarSearchType.IDENTIFY, CarSearchType.IDENTIFY.hint, null)
        mediaId.startsWith(TYPE_PREFIX) -> CarSearchType.of(mediaId.removePrefix(TYPE_PREFIX))?.let { typeTile(mediaId, it, it.hint, null) }
        mediaId.startsWith(CHOOSE_PREFIX) -> {
          val rest = mediaId.removePrefix(CHOOSE_PREFIX)
          val words = Uri.decode(rest.substringAfter('/', ""))
          CarSearchType.of(rest.substringBefore('/'))?.takeIf { words.isNotBlank() }?.let { chooserRow(it, words) }
        }
        mediaId.startsWith(FILTER_PREFIX) -> CarSearchType.of(mediaId.removePrefix(FILTER_PREFIX).substringBefore('/'))?.let { typeTile(mediaId, it, null, SHOW_ONLY) }
        mediaId.startsWith(HINT_PREFIX) -> note(Uri.decode(mediaId.removePrefix(HINT_PREFIX)), null)
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

    override fun onSubscribe(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> =
      if (radioFolder(parentId) != null) Futures.immediateFuture(LibraryResult.ofVoid()) else super.onSubscribe(session, browser, parentId, params)

    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> {
      latestSearchByClient[searchClient(browser)] = query
      // The legacy AA adapter ignores onSearch's future and completes only after this notification.
      // Notify on BOTH success and failure; otherwise an offline/timeout query spins forever.
      Futures.addCallback(searchItems(query), object : FutureCallback<List<MediaItem>> {
        override fun onSuccess(items: List<MediaItem>?) {
          android.os.Handler(mainLooper).post { session.notifySearchResultChanged(browser, query, items?.size ?: 0, params) }
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
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val latest = latestSearchByClient[searchClient(browser)]
      if (latest != null && latest != query && latest.startsWith(query, ignoreCase = true)) {
        // Superseded keyboard prefix: answer it without re-starting its network request.
        return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.of(), params))
      }
      // CAR-SEARCH-TYPES-001: the icon row first, then albums (ALBUM-CAR-001) and songs, grouped.
      val result = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
      Futures.addCallback(searchItems(query), object : FutureCallback<List<MediaItem>> {
        override fun onSuccess(items: List<MediaItem>?) {
          android.os.Handler(mainLooper).post { result.set(LibraryResult.ofItemList(ImmutableList.copyOf(page(items.orEmpty(), page, pageSize)), params)) }
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
      // AUTO-QUEUE-001: the queue as it stands when the driver taps, read on the session thread.
      val queueNow = (0 until player.mediaItemCount).map { player.getMediaItemAt(it) }
      return Futures.transform(Futures.allAsList(mediaItems.map(::resolveAsync)), { resolved ->
        val items = resolved!!
        // AUTO-QUEUE-001: a single found song plays at the FRONT of the current queue and keeps
        // the rest of it (a song already queued plays in place). Albums and saved playlists carry
        // scoped ids, skip this plan, and REPLACE the queue with their whole collection below.
        val plan = if (items.size == 1) CarQueue.planFor(items[0], queueNow) { it.mediaId } else null
        if (plan != null) MediaSession.MediaItemsWithStartPosition(plan.items.toMutableList(), plan.index, startPositionMs)
        else {
          // CAR-SKIP-001: a head unit can request a single item. Restore its surrounding list so
          // track skips have real destinations. Timeline length alone does not determine the host's
          // button choice; the platform command/action policy is verified separately.
          val whole = if (items.size == 1) listAround(items[0]) else null
          if (whole != null) MediaSession.MediaItemsWithStartPosition(whole.items, whole.index, startPositionMs)
          else MediaSession.MediaItemsWithStartPosition(items, startIndex, startPositionMs)
        }
      }, MoreExecutors.directExecutor())
    }

    /** The list a car-played song belongs to, and where it sits in it; null when it belongs to none. */
    private fun listAround(item: MediaItem): ItemsAt? {
      val id = item.mediaId
      val scoped = Regex("^playlist/([^/]+)/track/([^/]+)$").matchEntire(id)
      if (scoped != null) {
        val listId = Uri.decode(scoped.groupValues[1])
        val songs = MediaHub.playlist(listId)?.songs ?: return null
        val at = songs.indexOfFirst { playlistTrackId(listId, it.id) == id }
        if (at < 0) return null
        return ItemsAt(songs.map { songItem(it, playlistTrackId(listId, it.id)) }.toMutableList(), at)
      }
      val album = Regex("^calbum/([^/]+)$").matchEntire(id)
      if (album != null) return null
      // An album song a car search opened plays in that album; a found song in the answer it came in.
      // SERVICE-API-001: with the phone page closed this is the whole list the service engine caches.
      if (id.startsWith(CAR_ALBUM_PREFIX)) return MediaHub.catalogListAround(id)?.let { (songs, at) -> ItemsAt(songs.map { songItem(it) }.toMutableList(), at) }
      // A plain song id: the now playing queue is the list the driver is listening to.
      val queue = MediaHub.songs
      val at = queue.indexOfFirst { it.id == id }
      if (at >= 0) return ItemsAt(queue.map { songItem(it) }.toMutableList(), at)
      return MediaHub.catalogListAround(id)?.let { (songs, i) -> ItemsAt(songs.map { songItem(it) }.toMutableList(), i) }
    }

    private fun resolveMusicQuery(item: MediaItem, query: String): ListenableFuture<MediaItem> {
      val album = asksForAlbum(item.requestMetadata.extras)
      return Futures.transform(MediaHub.searchCatalog(query, album = album), { hits ->
        MediaHub.albumToPlay(query, album)?.let { id ->
          (scopedSong(id) ?: MediaHub.findSong(id))?.let { return@transform songItem(it, id) }
        }
        val song = hits?.firstOrNull { it.ready } ?: hits?.firstOrNull() ?: throw IllegalArgumentException("No songs found")
        songItem(song)
      }, MoreExecutors.directExecutor())
    }
    private fun resolveAsync(item: MediaItem): ListenableFuture<MediaItem> {
      val query = item.requestMetadata.searchQuery
      if (!query.isNullOrBlank()) {
        if (!asksForAlbum(item.requestMetadata.extras)) radioWords(query)?.let { words ->
          if (explicitRadio(query)) return Futures.transform(RadioCatalog.stations(this@PlaybackService, words), { rows ->
            RadioCatalog.item(rows?.firstOrNull() ?: throw IllegalArgumentException("No stations found"))
          }, MoreExecutors.directExecutor())
          return Futures.transformAsync(optionalStations(words), { rows ->
            if (rows.isNullOrEmpty()) resolveMusicQuery(item, query) else Futures.immediateFuture(RadioCatalog.item(rows.first()))
          }, MoreExecutors.directExecutor())
        }
        return resolveMusicQuery(item, query)
      }
      RadioCatalog.stationId(item.mediaId)?.let { id -> return Futures.transform(RadioCatalog.async {
        RadioCatalog.resolve(this@PlaybackService, id) ?: throw IllegalArgumentException("Unknown station")
      }, { RadioCatalog.item(it!!) }, MoreExecutors.directExecutor()) }
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
    return MediaHub.playlist(listId)?.songs?.firstOrNull { it.id == songId }?.let(MediaHub::sourced)
  }

  private fun songItem(song: MediaHub.Song, id: String = song.id): MediaItem =
    MediaItem.Builder()
      .setMediaId(id)
      .setMediaMetadata(WebPlayer.metadataOf(song, playable = true))
      .build()

  private companion object {
    const val ROOT = "/"
    // CAR-SEARCH-TYPES-001
    const val FOLDER_SEARCH = "search"
    const val TYPE_PREFIX = "stype/"
    const val FILTER_PREFIX = "sfilter/"
    const val CHOOSE_PREFIX = "schoose/"
    const val IDENTIFY = "identify"
    const val HINT_PREFIX = "hint/"
    const val SHOW_ONLY = "Show only"
    const val IDENTIFY_REUSE_MS = 15_000L
    const val ACTION_STAR = "com.nowplaying.discovery.STAR"
    const val ACTION_DISLIKE = "com.nowplaying.discovery.DISLIKE"
    const val ACTION_SHUFFLE = "com.nowplaying.discovery.SHUFFLE"
    val STAR = SessionCommand(ACTION_STAR, Bundle.EMPTY)
    val DISLIKE = SessionCommand(ACTION_DISLIKE, Bundle.EMPTY)
    val SHUFFLE = SessionCommand(ACTION_SHUFFLE, Bundle.EMPTY)
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
/** CAR-SKIP-001: a list to play and the index of the song the driver actually tapped. */
private class ItemsAt(val items: MutableList<MediaItem>, val index: Int)

/** Tests start each Identify afresh; the reuse itself stays with the service instance that listened. */
internal object CarIdentifyReuse {
  @Volatile var epoch = 0
  fun reset() { epoch++ }
}

object VoiceRequest {
  fun asksForAlbum(focus: String?, album: String?, title: String?): Boolean =
    focus == android.provider.MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE || (!album.isNullOrBlank() && title.isNullOrBlank())
}
