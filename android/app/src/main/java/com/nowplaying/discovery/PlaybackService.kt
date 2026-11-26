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
  private val libraryListener: () -> Unit = { EngineHub.libraryChanged(); refreshCarButtons(); mainHandler.post { refreshCarLists() } }
  /**
   * CAR-LOCAL-001: Android Auto keeps a list it loaded until told it changed. The library arrives
   * after the car may have opened Playlists (a cold start) and "On this phone" grows as songs land,
   * so the car's lists reload when what they show changes (not on every push).
   */
  private var carListsShown = 0
  private fun refreshCarLists() {
    val now = listOf(MediaHub.playlists.map { f -> listOf(f.id, f.title, f.album, f.songs.map { it.id }) }, MediaHub.phoneSongs().map { it.id }, MediaHub.songs.map { it.id }).hashCode()
    if (now == carListsShown) return
    val first = carListsShown == 0
    carListsShown = now
    if (first && synchronized(carLists) { carLists.isEmpty() }) return
    val shown = synchronized(carLists) { carLists.toList() + FOLDER_PLAYLISTS + FOLDER_SONGS }.distinct()
    for (parent in shown) if (!parent.startsWith("radio/") && parent != RadioCatalog.ROOT) session?.notifyChildrenChanged(parent, 1, null)
  }
  /** CAR-ACTIONS-001: the Star / Dislike / Shuffle buttons follow the song and the shuffle mode. */
  private val carButtonListener = object : Player.Listener {
    // CAR-MOOD-001: a song that played to its end is part of the listening mood.
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      val ended = lastSongId
      lastSongId = mediaItem?.mediaId
      if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && ended != null && ended != mediaItem?.mediaId) moodNudge(ended, "complete")
    }
    override fun onEvents(player: Player, events: Player.Events) {
      if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED, Player.EVENT_REPEAT_MODE_CHANGED, Player.EVENT_TIMELINE_CHANGED, Player.EVENT_MEDIA_METADATA_CHANGED)) refreshCarButtons()
      if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_MEDIA_METADATA_CHANGED) && pickFor != null && pickFor != currentSongId()) setPickFor(null)
    }
  }
  private var shownCarButtons: List<String> = emptyList()
  /**
   * CAR-CONTROLS-001: the song just starred in the car's player. While it is the song playing, the
   * car's Now playing tab opens with its playlist picker (Android Auto cannot open a list from a
   * player button, and 17.9 draws no row actions). Cleared by a pick, an un-star or the next song.
   */
  @Volatile private var pickFor: String? = null
  private fun setPickFor(id: String?, asList: Boolean = false) {
    val list = id != null && asList
    if (pickFor == id && listPick == list) return
    pickFor = id
    showList(list)
    // CAR-PICK-ON-PLAYER-001: the player's own buttons come back after a while, picked or not.
    mainHandler.removeCallbacks(dropPicker)
    if (id != null) mainHandler.postDelayed(dropPicker, PICK_WINDOW_MS)
    // CAR-STAR-PICKER-001: every list the car has shown reloads, so the one it goes back to has the picker.
    val shown = synchronized(carLists) { carLists.toList() + FOLDER_SONGS }.distinct()
    for (parent in shown) session?.notifyChildrenChanged(parent, 1, null)
  }
  /**
   * CAR-PICK-ON-PLAYER-001: the player's buttons while a just-starred song waits for a playlist: one
   * per list, then Cancel. Null when nothing is being picked, so the ordinary controls are drawn.
   * Android Auto shows four and puts the rest in its menu, so the lists come first.
   */
  private fun pickerButtons(): List<CommandButton>? {
    val id = pickFor ?: return null
    if (id != currentSongId()) return null
    val choices = pickChoices(id)
    return choices.map { c ->
      val extras = Bundle().apply { putString(PICK_LIST_EXTRA, c.listId); putString(PICK_SONG_EXTRA, id) }
      CommandButton.Builder(CommandButton.ICON_UNDEFINED)
        .setCustomIconResId(if (c.listId.isEmpty() || c.listId == CarPickList.UNSTAR) R.drawable.car_dislike else R.drawable.car_star_add)
        .setDisplayName(CarPickList.buttonLabel(c))
        .setSessionCommand(SessionCommand(ACTION_PICK_LIST, extras))
        .setSlots(CommandButton.SLOT_OVERFLOW)
        .build()
    }
  }

  /** CAR-PICK-ON-PLAYER-001: the lists offered for [songId], for the hint and the buttons alike. */
  private fun pickChoices(songId: String): List<CarPickList.Choice> = CarPickList.choices(
    MediaHub.playlists.filter { !it.album }.map { it.id to it.title },
    MediaHub.playlists.filter { f -> f.songs.any { it.id == songId } }.map { it.id }.toSet(),
    starredBefore = pickUnstar,
  )
  /** CAR-HEART-ALWAYS-001: the song was starred before the heart was pressed, so the picker offers "Remove star". */
  @Volatile private var pickUnstar = false

  /** CAR-PICK-ON-PLAYER-001: the picker leaves the player on its own if the driver ignores it. */
  private val dropPicker = Runnable { setPickFor(null); refreshCarButtons() }

  /** CAR-STAR-PICKER-001: the lists the car loaded lately (newest last), which a star must refresh. */
  private val carLists = LinkedHashSet<String>()
  private fun shownToCar(parentId: String) = synchronized(carLists) {
    carLists.remove(parentId); carLists.add(parentId)
    while (carLists.size > 24) carLists.remove(carLists.first())
  }
  /** Lists of songs or stations the car can go back to from the player; the picker goes on top of these. */
  private fun takesPicker(parentId: String) =
    parentId == FOLDER_SONGS || parentId == FOLDER_PLAYLISTS || parentId == FOLDER_ALBUMS || parentId.startsWith(PLAYLIST_PREFIX) ||
      (parentId.startsWith(CAR_ALBUM_PREFIX) && !parentId.contains("/track/")) || parentId.startsWith(FILTER_PREFIX) ||
      parentId == RadioCatalog.ROOT || parentId.startsWith("radio/")
  private fun withPicker(parentId: String, items: List<MediaItem>): List<MediaItem> {
    if (!takesPicker(parentId)) return items
    val song = pickFor?.let { id -> MediaHub.findSong(id) } ?: return items
    // CAR-PICK-LIST-001: while the driver chooses, the list the car shows IS the playlists, by name.
    if (listPick) return pickRows(song)
    val row = pickerRow(song)
    return listOf(row) + items.filter { it.mediaId != row.mediaId }
  }

  /**
   * CAR-PICK-LIST-001 (owner, 2026-11-23): "on android auto the playlist menu should replace the current playing
   * track player and quick controls, open up a list where the user can select playlist then get taken back to the
   * song player once the track is added". While true the session shows the car [curtain] (nothing playing), which
   * makes Android Auto leave its player for the lists; the lists hold the playlists ([pickRows]). [player] is never
   * touched: the music plays on and everything here still reads the real player.
   */
  @Volatile private var listPick = false
  private val curtain by lazy { CarCurtainPlayer(mainLooper, real = { player }, lift = { setPickFor(null) }) }
  private fun showList(on: Boolean) {
    if (listPick == on) return
    listPick = on
    val s = session ?: return
    s.player = if (on) curtain else player
    android.util.Log.i("AirwaveCar", "playlist list ${if (on) "shown in place of the player" else "closed; the player is back"}")
  }

  /** Whether the heart was pressed somewhere that shows lists in place of its player (Android Auto does). */
  private fun picksFromList(s: MediaSession, controller: MediaSession.ControllerInfo): Boolean =
    CarPickList.listForTests ?: s.isAutoCompanionController(controller)

  /** The playlists as rows the driver taps: the way back first, then one per playlist, by name. */
  private fun pickRows(song: MediaHub.Song): List<MediaItem> = CarPickList.rows(song.title, pickChoices(song.id)).map { row ->
    val leaves = row.listId == CarPickList.CANCEL || row.listId == CarPickList.UNSTAR
    val art = Uri.parse("android.resource://$packageName/drawable/${resources.getResourceEntryName(if (leaves) R.drawable.car_dislike else R.drawable.car_star_add)}")
    MediaItem.Builder()
      .setMediaId(CarPickList.rowId(row.listId, song.id))
      .setMediaMetadata(
        MediaMetadata.Builder().setTitle(row.title).setSubtitle(row.subtitle).setArtworkUri(art)
          .setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST).build(),
      ).build()
  }

  /** A row of that list was tapped: the (playlist or choice, song) it stands for. */
  private fun rowPick(items: List<MediaItem>): Pair<String, String>? = items.singleOrNull()?.let { CarPickList.parseRow(it.mediaId) }

  /** CAR-PICK-ON-PLAYER-001 / CAR-PICK-LIST-001: the driver chose [listId] (a playlist, or one of the other choices) for [songId]. */
  private fun applyPick(listId: String, songId: String) {
    setPickFor(null)
    if (listId == CarPickList.UNSTAR && songId.isNotEmpty()) {
      CarFeedback.submit(songId, "unlike")
      tellDriver("Star removed")
    } else if (listId == CarPickList.NEW_LIST && songId.isNotEmpty()) {
      // CAR-HEART-ALWAYS-001: no playlist yet, so the car starts one (the page makes it, once, by name).
      CarFeedback.addToPlaylist(songId, listId)
      tellDriver(CarPickList.added(CarPickList.NEW_LIST_NAME, false))
    } else if (listId.isNotEmpty() && listId != CarPickList.CANCEL && songId.isNotEmpty()) {
      val list = MediaHub.playlist(listId)
      val already = list?.songs?.any { it.id == songId } == true
      if (!already) CarFeedback.addToPlaylist(songId, listId)
      tellDriver(CarPickList.added(list?.title ?: "the playlist", already))
    }
    refreshCarButtons()
  }

  /** CAR-PICK-LIST-001: the notification and the foreground service stay as they are while the car is shown the list. */
  override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
    if (listPick) return
    super.onUpdateNotification(session, startInForegroundRequired)
  }
  private var radioSearchUntil = 0L
  private val radioListener: () -> Unit = { mainHandler.post {
    refreshCarButtons()
    session?.notifyChildrenChanged(RadioCatalog.FAVOURITES, RadioCatalog.favouriteCount().coerceAtLeast(1), null)
    session?.notifyChildrenChanged(RadioCatalog.ROOT, 5, null)
    session?.notifyChildrenChanged(CarRadioFilters.PLACE, 8, null)
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
  private var voiceRun: Triple<Long, CarSearchType, ListenableFuture<List<MediaItem>>>? = null
  @Volatile private var voiceHeard = false
  /** The host may ask for an old prefix's result after a newer query has arrived. */
  private val latestSearchByClient = java.util.concurrent.ConcurrentHashMap<String, String>()
  private fun searchClient(browser: MediaSession.ControllerInfo): String = "${browser.uid}:${browser.packageName}"

  override fun onCreate() {
    super.onCreate()
    // JPLAY-BRAND-002: a car may start the app with no activity; move earlier folders here too.
    BrandFolders.moveOnce(this)
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
      // CAR-STAR-PICKER-001: the car's list loads must not clear a message held on the player (CarMessage).
      .setLibraryErrorReplicationMode(MediaLibrarySession.LIBRARY_ERROR_REPLICATION_MODE_NONE)
      .setMediaButtonPreferences(carButtons())
      // CAR-CONTROLS-001: the star on a song row ("custom browse action") opens the playlist picker.
      .setCommandButtonsForMediaItems(listOf(starToPlaylistButton()))
      .build()
    player.addListener(carButtonListener)
    // A counted replay maps to the platform's "repeat off", so no player event announces it.
    player.onRepeatSelectionChanged = { refreshCarButtons() }
    // VOLUME-BOOST-001: the car's Volume button follows the phone's slider too.
    EngineHub.onCarLabels = { refreshCarButtons(); mainHandler.post { for ((id, n) in listOf(CarSettings.ROOT to 3, CarSettings.EQ to CarSettings.PRESETS.size + 1, CarSettings.DISCOVERY to CarSettings.LEVELS.size, FOLDER_PLAYLISTS to 8)) session?.notifyChildrenChanged(id, n, null) } }
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
    EngineHub.onCarLabels = null
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
    val shuffle = player.shuffleModeEnabled
    RadioNative.session?.station?.let { station ->
      // CAR-RADIO-CONTROLS-001 (owner, 2026-11-18): the radio works as the song player does, less Repeat,
      // Find similar and Dislike: shuffle (stations), star the song on air (which opens the playlist
      // picker), and the station's own favourite after them.
      val favourite = RadioCatalog.isFavourite(station)
      val song = MediaHub.radioSong
      return listOf(
        shuffleButton(shuffle, if (shuffle) "Shuffle stations on" else "Shuffle stations off"),
        starButton(song != null && CarFeedback.state(song.id).first),
        // HEART-ICON-001: the song's like is the heart now; the station's favourite is a radio with a small heart.
        CommandButton.Builder(CommandButton.ICON_UNDEFINED)
          .setCustomIconResId(if (favourite) R.drawable.car_station_fav_on else R.drawable.car_station_fav)
          .setDisplayName(if (favourite) "Remove favourite station" else "Favourite station")
          .setSessionCommand(FAVOURITE_STATION).setSlots(CommandButton.SLOT_OVERFLOW).build(),
        artistStarButton(song?.artist),
        volumeButton(),
      )
    }
    val (starred, disliked) = CarFeedback.state(currentSongId())
    // CAR-PICK-ON-PLAYER-001 (owner, 2026-11-23): "the heart button doesn't immediately bring up the
    // playlist selector on android auto". While a song is freshly starred its own lists ARE the player's
    // buttons, so the choice is right there instead of a trip back to a browse list.
    pickerButtons()?.let { return it }
    // CAR-RADIO-CONTROLS-001 (owner, 2026-11-18): "dont remove the like button and dislike button".
    // Android Auto 17.9 draws four buttons after the transport on an 800x480 screen, or three and a
    // menu when there are more, so Star and Dislike come right after Shuffle; Repeat and Find similar
    // (side by side, CAR-SIMILAR-001) follow and show on wider screens, else in the menu.
    return listOf(
      shuffleButton(shuffle, if (shuffle) "Shuffle on" else "Shuffle off"),
      starButton(starred),
      // DISLIKE-X-001 (owner, 2026-11-19): an X, as on the phone, instead of Media3's thumbs down.
      CommandButton.Builder(CommandButton.ICON_UNDEFINED)
        .setCustomIconResId(if (disliked) R.drawable.car_dislike_on else R.drawable.car_dislike)
        .setDisplayName(if (disliked) "Undo dislike" else "Dislike")
        .setSessionCommand(DISLIKE)
        .setSlots(CommandButton.SLOT_OVERFLOW)
        .build(),
      artistStarButton(currentSongId()?.let { id -> scopedSong(player.currentMediaItem?.mediaId ?: id) ?: MediaHub.findSong(id) }?.artist),
      repeatButton(),
      similarButton(),
      volumeButton(),
    )
  }

  /**
   * CAR-SETTINGS-001 (owner 2026-11-19): "a button for settings to quickly change the algorithm and eq presets",
   * then "should be in a sub menu on android auto not in player controls": EQ and discovery live only in
   * Playlists > Sound & discovery settings, so the player keeps Shuffle, Star and Dislike in view.
   */
  /* Playlists > Sound & discovery settings: every preset and level, each row naming the value it sets. */
  private fun settingsFolder(): MediaItem = asRow(folderItem(CarSettings.ROOT, "Sound & discovery settings", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED,
    CarSettings.summary(EngineHub.carEq(), EngineHub.carLevel(), EngineHub.carMood())))
  private fun settingsItem(id: String): MediaItem? = when {
    id == CarSettings.ROOT -> settingsFolder()
    id == CarSettings.EQ -> asRow(folderItem(id, "EQ preset: ${CarSettings.presetName(EngineHub.carEq())}", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Choose a sound for the car"))
    id == CarSettings.DISCOVERY -> asRow(folderItem(id, "Discovery: ${CarSettings.levelShort(EngineHub.carLevel())}", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, CarSettings.levelLabel(EngineHub.carLevel())))
    CarSettings.parse(id) != null -> asRow(folderItem(id, "Setting", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED))
    else -> null
  }
  private fun settingsChildren(id: String): List<MediaItem>? {
    val type = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
    CarSettings.parse(id)?.let { change ->
      EngineHub.carSettings(change)
      return settingsChildren(if (change.eq != null) CarSettings.EQ else if (change.adventurous != null) CarSettings.DISCOVERY else CarSettings.ROOT)
    }
    return when (id) {
      CarSettings.ROOT -> listOfNotNull(settingsItem(CarSettings.EQ), settingsItem(CarSettings.DISCOVERY),
        asRow(folderItem(if (EngineHub.carMood()) CarSettings.MOOD_OFF else CarSettings.MOOD_ON, "Follow my listening mood: ${if (EngineHub.carMood()) "On" else "Off"}", type,
          if (EngineHub.carMood()) "Tap to turn off" else "Tap to turn on")))
      CarSettings.EQ -> { val cur = EngineHub.carEq()
        (listOf(CarSettings.OFF) + CarSettings.PRESETS.map { it.id }).map { p -> asRow(folderItem(CarSettings.setEq(p), check(cur == p, CarSettings.presetName(p)), type)) } }
      CarSettings.DISCOVERY -> { val cur = EngineHub.carLevel()
        CarSettings.LEVELS.map { a -> asRow(folderItem(CarSettings.setLevel(a), check(kotlin.math.abs(cur - a) < 0.1, CarSettings.levelShort(a)), type, CarSettings.levelLabel(a))) } }
      else -> null
    }
  }

  /**
   * VOLUME-BOOST-001 (owner 2026-11-19): "increase volume up to 200% with a slider or android auto". The car has no
   * slider for an app, so each press steps 100, 125, 150, 175, 200% and back to 100%. Last in the list: in the menu on
   * an 800x480 screen (four slots), beside Find similar on wider ones.
   */
  private fun volumeButton(): CommandButton =
    CommandButton.Builder(CommandButton.ICON_VOLUME_UP)
      .setDisplayName(CarVolume.label(EngineHub.volume()))
      .setSessionCommand(VOLUME)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  /**
   * CAR-CONTROLS-001: Media3's stock "shuffle on" icon drew exactly like "off" on a real Android Auto
   * screen, so shuffle carries this app's own pair: the same arrows, with a dot under them when on.
   */
  private fun shuffleButton(on: Boolean, name: String): CommandButton =
    CommandButton.Builder(CommandButton.ICON_UNDEFINED)
      .setCustomIconResId(if (on) R.drawable.car_shuffle_on else R.drawable.car_shuffle_off)
      .setDisplayName(name)
      .setSessionCommand(SHUFFLE)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  private fun starButton(starred: Boolean): CommandButton =
    // HEART-ICON-001 (owner, 2026-11-22): "change the star icon to a heart icon everywhere in the app and in android auto".
    CommandButton.Builder(if (starred) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED)
      // CAR-HEART-ALWAYS-001: a starred song's heart opens the playlist choices (with "Remove star" among them),
      // so it is named for what it does.
      .setDisplayName(if (starred) CarPickList.STARRED_LABEL else "Star")
      .setSessionCommand(STAR)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  /**
   * CAR-CONTROLS-001: "a star icon to star the song then it brings up a sub menu where users can
   * select an existing playlist to add the song to before going back to the player". Android Auto
   * cannot open a list from a player button, so this star sits on song rows (Now playing queue,
   * playlists, search results) as a custom browse action: it stars the song and opens the picker.
   */
  private fun starToPlaylistButton(): CommandButton =
    CommandButton.Builder(CommandButton.ICON_UNDEFINED)
      .setCustomIconResId(R.drawable.car_star_add)
      .setIconUri(Uri.parse("android.resource://$packageName/drawable/${resources.getResourceEntryName(R.drawable.car_star_add)}"))
      .setDisplayName("Star and add to a playlist")
      .setSessionCommand(STAR_TO_PLAYLIST)
      .build()

  /**
   * ARTIST-FAV-CAR-001 (owner, 2026-11-22): "add a player control button to android auto to star the artist of current
   * playing track and add the artist / artist on the current track to your prefered artist so your algorithim can
   * tailor your music better". In the menu on an 800x480 screen (Shuffle, Star and Dislike stay in view).
   */
  private fun artistStarButton(artist: String?): CommandButton =
    CommandButton.Builder(CommandButton.ICON_UNDEFINED)
      .setCustomIconResId(R.drawable.car_star_artist)
      .setDisplayName(if (artist != null && CarArtists.names(artist).size > 1) "Star the artists" else "Star the artist")
      .setSessionCommand(STAR_ARTISTS)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  /**
   * REPEAT-COUNT-001 (owner, 2026-11-18): the car shows the same four states as the phone, with
   * the number of extra plays still owed inside the two arrows: nothing (off), 1, 2 or infinity.
   * Media3's stock repeat icons cannot show a count, so each state is this app's own drawable; the
   * wording matches the phone's button.
   */
  private fun repeatButton(): CommandButton {
    val (icon, name) = when (player.repeatSelection) {
      3 -> R.drawable.car_repeat_once to "Repeat song: 1 extra play"
      4 -> R.drawable.car_repeat_twice to "Repeat song: 2 extra plays"
      1 -> R.drawable.car_repeat_infinite to "Repeat song: infinite plays"
      else -> R.drawable.car_repeat_off to "Repeat song: off"
    }
    return CommandButton.Builder(CommandButton.ICON_UNDEFINED)
      .setCustomIconResId(icon)
      .setDisplayName(name)
      .setSessionCommand(REPEAT)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()
  }

  /**
   * CAR-SIMILAR-001 (owner, 2026-11-18): "add the button to find similar songs based on the current
   * playing song ... next to the repeat icon". While the sound match runs the button shows three dots
   * and a second press does nothing.
   */
  private fun similarButton(): CommandButton =
    CommandButton.Builder(CommandButton.ICON_UNDEFINED)
      .setCustomIconResId(if (similarBusy) R.drawable.car_similar_busy else R.drawable.car_similar)
      .setDisplayName(if (similarBusy) "Finding similar songs\u2026" else "Find similar songs")
      .setSessionCommand(SIMILAR)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  @Volatile private var similarBusy = false

  /* ------------------------------------------------------------------ CAR-MOOD-001 */

  private var lastSongId: String? = null
  private var moodBusy = false
  private var moodAgain: Pair<String?, String>? = null

  /**
   * CAR-MOOD-001 (owner, 2026-11-19): after a star, a dislike, a Find similar or a song played to its
   * end, the songs still to come are re-arranged for the listening mood (genre, subgenre and sound,
   * steered by Familiar/Adventurous), as in the phone's queue. Only with the phone app closed: a live
   * page arranges its own queue, which is the car's. Saved lists and albums move only with shuffle on.
   * Android Auto cannot animate its queue, so a short message says it happened.
   */
  private fun moodNudge(signalId: String?, kind: String) {
    val (current, upcoming) = player.moodCandidates() ?: return
    if (moodBusy) { moodAgain = signalId to kind; return }
    moodBusy = true
    Futures.addCallback(MediaHub.moodOrder(current, upcoming, signalId?.let { it to kind }), object : FutureCallback<MediaHub.MoodAnswer> {
      override fun onSuccess(a: MediaHub.MoodAnswer) {
        mainHandler.post {
          moodDone()
          val applied = a.changed && player.applyMood(a.order)
          android.util.Log.i("AirwaveCar", "mood after $kind: changed=${a.changed} applied=$applied leading=${a.leading} next=${a.order.take(6)}")
          if (applied) {
            val text = "Queue re-arranged for your mood" + if (a.leading.isEmpty()) "" else ": " + a.leading.joinToString(" · ")
            // The star's playlist hint goes first; the mood note follows it.
            if (pickFor != null) mainHandler.postDelayed({ tellDriver(text) }, 4000) else tellDriver(text)
          }
        }
      }
      override fun onFailure(t: Throwable) {
        mainHandler.post { moodDone(); android.util.Log.i("AirwaveCar", "mood order: ${t.message}") }
      }
    }, MoreExecutors.directExecutor())
  }

  private fun moodDone() {
    moodBusy = false
    moodAgain?.let { (id, kind) -> moodAgain = null; moodNudge(id, kind) }
  }

  /** Runs the phone's sound match for the car's song; found songs join the end of the queue. */
  private fun findSimilar(id: String) {
    // CAR-ACTIONS-EVERY-TIME-001: a second press while one runs is answered, not silently dropped.
    if (similarBusy) { tellDriver("Still finding songs similar to this one."); return }
    similarBusy = true
    refreshCarButtons()
    tellDriver(CarSimilarText.looking(MediaHub.findSong(id)?.title))
    Futures.addCallback(MediaHub.findSimilar(id), object : FutureCallback<MediaHub.SimilarAnswer> {
      override fun onSuccess(a: MediaHub.SimilarAnswer) {
        mainHandler.post {
          similarBusy = false
          if (a.songs.isNotEmpty()) {
            player.appendFound(a.songs); moodNudge(id, "similar")
            // SIMILAR-NOTICE-001: say how many new songs joined the queue.
            tellDriver(CarSimilarText.added(if (a.added > 0) a.added else a.songs.size, a.minimum))
          }
          else tellDriver(a.reason.ifBlank { "No new songs reached ${a.minimum}% sound match. The list is unchanged." })
          refreshCarButtons()
        }
      }
      override fun onFailure(t: Throwable) {
        mainHandler.post {
          similarBusy = false
          tellDriver(t.message?.take(200) ?: "Could not find similar songs")
          refreshCarButtons()
        }
      }
    }, MoreExecutors.directExecutor())
  }

  /** MOOD-DEFAULT-CAR-001: Playlists > Discover for my mood. */
  private fun moodDiscoverRow(): MediaItem = asRow(folderItem(CarMoodDiscover.ID, if (moodDiscoverBusy) "Discovering for my mood\u2026" else "Discover for my mood",
    MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, CarMoodDiscover.subtitle(EngineHub.carMood(), moodDiscoverBusy)))
  @Volatile private var moodDiscoverBusy = false
  @Volatile private var moodDiscoverAnswer: Pair<Long, String>? = null

  /** Opening the row: starts a run unless one is running or has just answered, and lists what is happening. */
  private fun moodDiscoverOpened(): List<MediaItem> {
    val shown = moodDiscoverAnswer?.takeIf { android.os.SystemClock.elapsedRealtime() - it.first < CarMoodDiscover.SHOW_ANSWER_MS }
    if (moodDiscoverBusy) return listOf(note("Finding songs for your mood\u2026", "They join the end of your now playing queue"))
    if (shown != null) return listOf(note(shown.second, "Go back and open again to discover more"))
    startMoodDiscover()
    return listOf(note("Finding songs for your mood\u2026", "They join the end of your now playing queue"))
  }

  private fun startMoodDiscover() {
    if (moodDiscoverBusy) return
    moodDiscoverBusy = true
    mainHandler.post { session?.notifyChildrenChanged(FOLDER_PLAYLISTS, 8, null) }
    tellDriver("Finding songs for your mood\u2026")
    Futures.addCallback(MediaHub.discoverMood(), object : FutureCallback<MediaHub.MoodDiscoverAnswer> {
      override fun onSuccess(a: MediaHub.MoodDiscoverAnswer) {
        mainHandler.post {
          // The page's own queue already holds the songs; appendFound only fills the service engine's queue.
          val appended = if (a.songs.isNotEmpty()) player.appendFound(a.songs) else 0
          val added = if (a.added > 0) a.added else appended
          android.util.Log.i("AirwaveCar", "mood discover: ${a.songs.size} songs, appended $appended, added $added, leading ${a.leading}")
          finishMoodDiscover(CarMoodDiscover.answerText(added, a.leading, a.reason))
        }
      }
      override fun onFailure(t: Throwable) {
        mainHandler.post {
          android.util.Log.i("AirwaveCar", "mood discover failed: ${t.message}")
          finishMoodDiscover(t.message?.take(200) ?: "Could not discover for your mood")
        }
      }
    }, MoreExecutors.directExecutor())
  }

  private fun finishMoodDiscover(text: String) {
    moodDiscoverBusy = false
    moodDiscoverAnswer = android.os.SystemClock.elapsedRealtime() to text
    tellDriver(text)
    session?.notifyChildrenChanged(FOLDER_PLAYLISTS, 8, null)
    session?.notifyChildrenChanged(CarMoodDiscover.ID, 1, null)
  }

  /**
   * A short message the car shows over the player (a toast); playback is not affected. The car's toast
   * is one or two lines, so only the first sentence of a longer reason is sent.
   */
  private fun tellDriver(message: String) {
    val first = message.trim().substringBefore(". ")
    val shown = if (first.length < message.trim().length) "$first." else first
    val s = session ?: return
    // CAR-STAR-PICKER-001: held for a few seconds (sendError's one passing state was often lost).
    val turn = ++driverMessage
    mainHandler.post {
      runCatching { androidx.media3.session.CarMessage.show(s, shown.take(160)) }
        .onFailure { s.sendError(SessionError(SessionError.ERROR_UNKNOWN, shown.take(160))) }
      mainHandler.postDelayed({ if (turn == driverMessage) runCatching { androidx.media3.session.CarMessage.clear(s) } }, DRIVER_MESSAGE_MS)
    }
  }
  @Volatile private var driverMessage = 0

  /** ARTIST-FAV-CAR-001: the song's artists join the listener's starred artists (the active algorithm's list). */
  private fun starArtists(songId: String, artist: String) {
    val names = CarArtists.names(artist)
    if (names.isEmpty()) { tellDriver("This song names no artist to star."); return }
    // CAR-ANSWERABLE-001 (owner, 2026-11-23): "sometimes the ... heart artist buttons don't work". The
    // press is only reported as done once a surface says it saved them; nothing listening is said too.
    val answer = CarFeedback.starArtists(songId, artist)
    if (answer == null) { tellDriver(CarArtists.waiting(names)); return }
    Futures.addCallback(answer, object : FutureCallback<MediaHub.ArtistAnswer> {
      override fun onSuccess(a: MediaHub.ArtistAnswer) {
        mainHandler.post { tellDriver(CarArtists.told(a.names.ifEmpty { names })) }
      }
      override fun onFailure(t: Throwable) {
        mainHandler.post { tellDriver(CarArtists.waiting(names)) }
      }
    }, MoreExecutors.directExecutor())
  }

  /** CAR-SCRUB-001: hold Next or Previous to move through the song at twice real time. */
  private val scrub: CarScrub by lazy {
    CarScrub(
      now = { android.os.SystemClock.elapsedRealtime() },
      later = { d, run -> val r = Runnable(run); mainHandler.postDelayed(r, d); r },
      cancel = { mainHandler.removeCallbacks(it as Runnable) },
      positionMs = { player.currentPosition },
      durationMs = { player.duration.takeIf { it > 0 } ?: 0L },
      seek = { player.seekTo(it) },
      skip = { forward -> if (forward) player.seekToNext() else player.seekToPrevious() },
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

  /** The song now playing, as the page names it (a playlist row's id carries its list too; on the radio, the song on air). */
  private fun currentSongId(): String? {
    val id = player.currentMediaItem?.mediaId ?: return null
    if (id.startsWith("radio:")) return MediaHub.radioSong?.id
    val scoped = Regex("^playlist/([^/]+)/track/([^/]+)$").matchEntire(id) ?: return id
    return Uri.decode(scoped.groupValues[2])
  }

  /* ------------------------------------------------------------------- CAR-RADIO-FILTERS-001
   * Genre, saved places, language and starred-only, combined, from the car. Each choice is a row whose id names the
   * value it sets (CarRadioFilters.apply), so a car asking for the same list twice never flips a choice back. */
  private fun check(on: Boolean, label: String) = if (on) "\u2713 $label" else label
  /** Filter choices read as full-width rows: a grid tile cuts "Places: Chicago +1" down to "Places: Anywh...". */
  private fun asRow(item: MediaItem): MediaItem {
    val extras = Bundle().apply {
      putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_SINGLE_ITEM, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
      putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
    }
    return item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build()).build()
  }
  private fun filterFolder(id: String): MediaItem? {
    val f = RadioCatalog.carFilters(this); val saved = RadioCatalog.savedPlaces(this)
    val chosen = CarRadioFilters.chosen(f, saved); val summary = CarRadioFilters.summary(f, saved)
    val type = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
    return when {
      id == CarRadioFilters.FILTERS -> asRow(folderItem(id, "Radio filters", type, summary))
      id.startsWith(CarRadioFilters.STATIONS) -> id.removePrefix(CarRadioFilters.STATIONS).toIntOrNull()?.takeIf { it in 0..1_000_000 }
        ?.let { asRow(folderItem(id, if (it == 0) "Filtered stations" else "More filtered stations", type, summary)) }
      id == CarRadioFilters.GENRE -> asRow(folderItem(id, "Genre: ${f.genre?.let(CarRadioFilters::genreLabel) ?: "Any"}", type, "Choose one genre"))
      id == CarRadioFilters.PLACE -> asRow(folderItem(id, "Places: ${CarRadioFilters.placesLabel(chosen)}", type,
        if (saved.isEmpty()) "Save places on your phone: Radio, Country, Anywhere" else "Choose any of your ${saved.size} saved places"))
      id == CarRadioFilters.LANGUAGE -> asRow(folderItem(id, "Language: ${f.language?.let(CarRadioFilters::words) ?: "Any"}", type, "Your phone's languages first"))
      CarRadioFilters.isSetRow(id) -> if (CarRadioFilters.apply(id, f, saved) != null) asRow(folderItem(id, "Radio filter", type)) else null
      else -> null
    }
  }
  private fun filterRoot(): List<MediaItem> {
    val f = RadioCatalog.carFilters(this)
    val type = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
    return listOfNotNull(
      filterFolder(CarRadioFilters.stations(0))?.let { it.buildUpon().setMediaMetadata(it.mediaMetadata.buildUpon().setTitle("Show filtered stations").build()).build() },
      filterFolder(CarRadioFilters.GENRE), filterFolder(CarRadioFilters.PLACE), filterFolder(CarRadioFilters.LANGUAGE),
      asRow(folderItem(if (f.starredOnly) CarRadioFilters.STARRED_OFF else CarRadioFilters.STARRED_ON, "Starred stations only: ${if (f.starredOnly) "On" else "Off"}", type,
        if (f.starredOnly) "Tap to include every station" else "Tap to show only stations you starred")),
      if (f.any) asRow(folderItem(CarRadioFilters.CLEAR, "Clear all filters", type, "Back to the most listened-to stations")) else null,
    )
  }
  private fun genreRows(f: CarRadioFilters.Filters): List<MediaItem> = (listOf(folderItem(CarRadioFilters.setGenre(null), check(f.genre == null, "Any genre"), MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)) +
    CarRadioFilters.GENRES.map { folderItem(CarRadioFilters.setGenre(it), check(f.genre == it, CarRadioFilters.genreLabel(it)), MediaMetadata.MEDIA_TYPE_FOLDER_MIXED) }).map(::asRow)
  private fun languageRows(f: CarRadioFilters.Filters): List<MediaItem> {
    val locales = resources.configuration.locales.let { l -> (0 until l.size()).map { l[it] } }
    val choices = CarRadioFilters.languageChoices(CarRadioFilters.preferredLanguages(locales), f.language)
    return (listOf(folderItem(CarRadioFilters.setLanguage(null), check(f.language == null, "Any language"), MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)) +
      choices.map { folderItem(CarRadioFilters.setLanguage(it), check(f.language == it, CarRadioFilters.words(it)), MediaMetadata.MEDIA_TYPE_FOLDER_MIXED) }).map(::asRow)
  }
  private fun placeRows(f: CarRadioFilters.Filters): List<MediaItem> {
    val saved = RadioCatalog.savedPlaces(this)
    if (saved.isEmpty()) return listOf(note("No saved places yet", "On your phone: Radio, Country, Anywhere, then type a city and save it"))
    val type = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
    val head = folderItem(CarRadioFilters.stations(0), "Show stations: ${CarRadioFilters.summary(f, saved)}", type, "Choose more places below, or tap to listen")
    return (listOfNotNull(head, folderItem(CarRadioFilters.ANYWHERE, check(f.places.isEmpty(), "Anywhere"), type),
      if (saved.size > 1) folderItem(CarRadioFilters.ALL_PLACES, check(saved.all { it.id in f.places }, "All saved places"), type) else null) +
      saved.map { p -> val on = p.id in f.places
        folderItem(if (on) CarRadioFilters.removePlace(p.id) else CarRadioFilters.addPlace(p.id), check(on, p.label), type, if (on) "Chosen \u00b7 tap to remove" else "Tap to add") }).map(::asRow)
  }
  private fun filteredStationRows(offset: Int): ListenableFuture<List<MediaItem>> = Futures.transform(RadioCatalog.filteredStations(this, offset), { found ->
    val stations = found?.stations.orEmpty().map(RadioCatalog::item)
    val f = RadioCatalog.carFilters(this)
    val head = if (offset == 0) listOf(note(CarRadioFilters.summary(f, RadioCatalog.savedPlaces(this)), "Change these in Radio filters")) else emptyList()
    head + stations + if (found?.nextOffset != null) listOfNotNull(filterFolder(CarRadioFilters.stations(found.nextOffset)))
      else if (stations.isEmpty()) listOf(note(if (f.starredOnly) "No starred stations match these filters" else "No stations match these filters", "Change a filter in Radio filters")) else emptyList()
  }, MoreExecutors.directExecutor())
  /** A set row: save the choice, refresh what the car shows, and answer with what the listener wants next. */
  private fun setFilter(id: String): ListenableFuture<List<MediaItem>> {
    val next = CarRadioFilters.apply(id, RadioCatalog.carFilters(this), RadioCatalog.savedPlaces(this))
      ?: return Futures.immediateFailedFuture(IllegalArgumentException("Unknown radio filter"))
    RadioCatalog.setCarFilters(this, next)
    mainHandler.post {
      for (parent in listOf(RadioCatalog.ROOT, CarRadioFilters.FILTERS, CarRadioFilters.GENRE, CarRadioFilters.PLACE, CarRadioFilters.LANGUAGE, CarRadioFilters.stations(0)))
        session?.notifyChildrenChanged(parent, 8, null)
    }
    // Places are chosen several at a time, so the list stays; any other choice goes straight to the stations.
    return if (id.startsWith("${CarRadioFilters.PLACE}/")) Futures.immediateFuture(placeRows(next)) else filteredStationRows(0)
  }

  private fun radioFolder(id: String): MediaItem? = filterFolder(id) ?: when (id) {
    RadioCatalog.ROOT -> folderItem(id, "Radio", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "World radio and favourite stations")
    RadioCatalog.ALL -> folderItem(id, "All stations", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Browse stations by initial: A–Z, # and 0–9")
    RadioCatalog.FAVOURITES -> folderItem(id, "Favourite stations", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Shared with your phone")
    RadioCatalog.SEARCH -> folderItem(id, "Search stations", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Tap the search button, or say radio KEXP")
    // RADIO-AZ-ALL-001 (owner, 2026-11-24): numbers have their own folder, and '#' is the home of every name the
    // Latin alphabet cannot index, so the car tree reaches the whole world without dumping it into one node.
    RadioCatalog.NUMBERS_FOLDER -> folderItem(id, "Numbers 0–9", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Stations whose names begin with a number")
    else -> RadioCatalog.letterFolder(id)?.let { (letter, _) ->
      if (letter == "#") folderItem(id, "#", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Names in other scripts and symbols")
      else folderItem(id, letter, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "Stations beginning with this initial")
    } ?: if (id.matches(Regex("radio/az/[0-9]{1,7}"))) folderItem(id, "Stations A–Z", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, "World stations in alphabetical order") else null
  }

  private fun radioResults(words: String): ListenableFuture<List<MediaItem>> = Futures.catching(
    Futures.transform(RadioCatalog.stations(this, words), { rows -> rows.orEmpty().map(RadioCatalog::item).ifEmpty {
      listOf(note("No stations found", "Try another station name"))
    } }, MoreExecutors.directExecutor()),
    Exception::class.java, { listOf(note("Station search didn't finish", "Try Favourite stations or search again")) }, MoreExecutors.directExecutor(),
  )

  private fun radioChildren(id: String): ListenableFuture<List<MediaItem>> = when {
    id == RadioCatalog.ROOT -> Futures.immediateFuture(listOfNotNull(radioFolder(RadioCatalog.FAVOURITES), radioFolder(CarRadioFilters.stations(0)), radioFolder(CarRadioFilters.FILTERS), radioFolder(RadioCatalog.ALL), radioFolder(RadioCatalog.SEARCH)))
    id == CarRadioFilters.FILTERS -> Futures.immediateFuture(filterRoot())
    id == CarRadioFilters.GENRE -> Futures.immediateFuture(genreRows(RadioCatalog.carFilters(this)))
    id == CarRadioFilters.PLACE -> Futures.immediateFuture(placeRows(RadioCatalog.carFilters(this)))
    id == CarRadioFilters.LANGUAGE -> Futures.immediateFuture(languageRows(RadioCatalog.carFilters(this)))
    CarRadioFilters.isSetRow(id) -> setFilter(id)
    id.startsWith(CarRadioFilters.STATIONS) -> filteredStationRows(id.removePrefix(CarRadioFilters.STATIONS).toInt())
    id == RadioCatalog.ALL -> Futures.immediateFuture(RadioCatalog.allFolders().mapNotNull(::radioFolder))
    id == RadioCatalog.NUMBERS_FOLDER -> Futures.immediateFuture(RadioCatalog.numberFolders().mapNotNull(::radioFolder))
    id.startsWith("radio/letter/") -> {
      val folder = RadioCatalog.letterFolder(id)
      if (folder == null) Futures.immediateFailedFuture(IllegalArgumentException("Invalid station initial or page"))
      else Futures.transform(RadioCatalog.letterStations(this, folder.first, folder.second), { found ->
        val stations = found?.stations.orEmpty().map(RadioCatalog::item)
        // RADIO-AZ-ALL-001: a bounded page plus a next-page folder; an empty page still offers the next one, because
        // the stations for this initial may sit deeper in the directory than this page reached.
        stations + if (found?.nextOffset != null) listOf(folderItem("radio/letter/${folder.first}/${found.nextOffset}", if (folder.first == "#") "More stations" else "More ${folder.first} stations", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED))
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
      // RADIO-AZ-ALL-001: "More stations A–Z" follows the directory's own answer, so the list runs to the real end
      // and a page of unplayable rows no longer reads as the end of the world's stations.
      else Futures.transform(RadioCatalog.azStations(this, offset), { page ->
        val stations = page?.stations.orEmpty().map(RadioCatalog::item)
        stations + if (page?.nextOffset != null) listOf(folderItem("radio/az/${page.nextOffset}", "More stations A–Z", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED))
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

  /**
   * CAR-QUICK-SEARCH-001: a kind tapped on the Search tab beeps, listens for the driver's words with Android's speech
   * recognizer (playback paused meanwhile), then lists what that kind of search finds. Android Auto asks for a folder's
   * children more than once, so a run is reused for a few seconds rather than listening again.
   */
  private fun voiceItems(type: CarSearchType): ListenableFuture<List<MediaItem>> {
    val now = android.os.SystemClock.elapsedRealtime()
    // Android Auto asks for a list again on the way back from the player: words heard are kept a while, but a listen
    // that heard nothing is not, so tapping the kind again listens again.
    voiceRun?.let { (at, t, f) -> if (t == type && (!f.isDone || now - at < (if (voiceHeard) VOICE_REUSE_MS else VOICE_RETRY_MS))) return f }
    val out = SettableFuture.create<List<MediaItem>>()
    voiceRun = Triple(now, type, out)
    voiceHeard = false
    val tapSearch = note(if (type == CarSearchType.ALL) "Tap the search button and say anything" else "Tap the search button. ${type.hint}", "${type.title} search is on")
    val wasPlaying = player.isPlaying
    if (wasPlaying) player.pause()
    mainHandler.post {
      CarVoice.listen(this) { heard ->
        if (wasPlaying && !player.isPlaying) player.play()
        when (heard) {
          is CarVoice.Outcome.Heard -> {
            voiceHeard = true
            val (kind, words) = CarSearch.parse(heard.words, type)
            if (kind == CarSearchType.IDENTIFY) { out.setFuture(identifyItems()); return@listen }
            if (words.isBlank()) { out.set(listOf(note("Didn\u2019t catch that", "Go back and tap ${type.title} to try again"))); return@listen }
            CarSearch.lastWords = words
            val said = note("You said \u201c$words\u201d", "${kind.title} \u00b7 tap a song to play it")
            Futures.addCallback(typedResults(words, kind) { it.title }, object : FutureCallback<List<MediaItem>> {
              override fun onSuccess(r: List<MediaItem>?) {
                mainHandler.post {
                  out.set(listOf(said) + r.orEmpty().ifEmpty { listOf(note("No ${kind.title.lowercase()} found for \u201c$words\u201d", "Go back and tap ${type.title} to try again")) })
                }
              }
              override fun onFailure(error: Throwable) {
                val why = generateSequence(error) { it.cause }.mapNotNull { it.message?.takeIf(String::isNotBlank) }.firstOrNull()?.take(120)
                mainHandler.post { out.set(listOf(said, note("${kind.title} search didn\u2019t finish", why ?: "Try again in a moment"))) }
              }
            }, MoreExecutors.directExecutor())
          }
          CarVoice.Outcome.NoPermission -> out.set(listOf(note("jPlay can\u2019t use the microphone", "Allow microphone access for jPlay on your phone"), tapSearch))
          CarVoice.Outcome.Unavailable -> out.set(listOf(tapSearch))
          CarVoice.Outcome.NothingHeard -> out.set(listOf(note("Didn\u2019t catch that", "Go back and tap ${type.title} to try again, or tap the search button"), tapSearch))
          is CarVoice.Outcome.Failed -> out.set(listOf(note("Couldn\u2019t listen", heard.why.take(120)), tapSearch))
        }
      }
    }
    return out
  }

  /** Identify: listen to the music playing for a few seconds and name it with the phone's app. */
  private fun identifyItems(): ListenableFuture<List<MediaItem>> {
    val now = android.os.SystemClock.elapsedRealtime()
    identifyRun?.let { (at, epoch, f) -> if (epoch == CarIdentifyReuse.epoch && (!f.isDone || now - at < IDENTIFY_REUSE_MS)) return f }
    val out = SettableFuture.create<List<MediaItem>>()
    identifyRun = Triple(now, CarIdentifyReuse.epoch, out)
    if (!MediaHub.canIdentify()) {
      out.set(listOf(note("Open jPlay on your phone", "Then tap Identify again to name the music playing")))
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
        CarListener.Outcome.NoPermission -> out.set(listOf(note("jPlay can't use the microphone", "Allow microphone access for jPlay on your phone")))
        CarListener.Outcome.Blocked -> out.set(listOf(note("Android kept the microphone off", "Open jPlay on your phone, then tap Identify again")))
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
          MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().add(STAR).add(DISLIKE).add(SHUFFLE).add(REPEAT).add(SIMILAR).add(VOLUME).add(STAR_TO_PLAYLIST).add(FAVOURITE_STATION).add(STAR_ARTISTS).add(PICK_LIST).build(),
        )
        .setMediaButtonPreferences(carButtons())
        .build()

    /** CAR-SCRUB-001: the car's and the steering wheel's Next/Previous keys; a hold scrubs at twice real time. */
    override fun onMediaButtonEvent(session: MediaSession, controllerInfo: MediaSession.ControllerInfo, intent: Intent): Boolean {
      // CAR-PICK-LIST-001: a key on the wheel ends the playlist choice first, so it acts on the real player (with
      // the empty one in place a Play key would be taken as "resume what was playing" and reload the queue).
      if (listPick) setPickFor(null)
      // The radio's Next/Previous change station; only songs scrub.
      if (RadioNative.session?.station != null) return false
      @Suppress("DEPRECATION")
      val e = intent.getParcelableExtra<android.view.KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return false
      val key = when (e.keyCode) {
        android.view.KeyEvent.KEYCODE_MEDIA_NEXT -> CarScrub.Key.NEXT
        android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS -> CarScrub.Key.PREVIOUS
        android.view.KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> CarScrub.Key.FAST_FORWARD
        android.view.KeyEvent.KEYCODE_MEDIA_REWIND -> CarScrub.Key.REWIND
        else -> return false
      }
      if (e.action != android.view.KeyEvent.ACTION_DOWN && e.action != android.view.KeyEvent.ACTION_UP) return false
      return scrub.key(key, down = e.action == android.view.KeyEvent.ACTION_DOWN, repeat = e.repeatCount,
        longPress = (e.flags and android.view.KeyEvent.FLAG_LONG_PRESS) != 0)
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      if (customCommand.customAction == ACTION_STAR_TO_PLAYLIST) {
        // CAR-CONTROLS-001: star the song on that row (never un-star it) and open the picker for it.
        val song = rowSong(args.getString(MediaConstants.EXTRA_KEY_MEDIA_ID))
          ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
        if (!CarFeedback.state(song.id).first) { CarFeedback.submit(song.id, "like"); moodNudge(song.id, "like") }
        refreshCarButtons()
        val open = Bundle().apply { putString(RESULT_BROWSE_NODE, "$ADD_TO_PREFIX${Uri.encode(song.id)}") }
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS, open))
      }
      RadioNative.session?.station?.let { station ->
        when (customCommand.customAction) {
          ACTION_FAVOURITE_STATION -> return Futures.catching(Futures.transform(RadioCatalog.toggle(this@PlaybackService, station), {
            SessionResult(SessionResult.RESULT_SUCCESS)
          }, MoreExecutors.directExecutor()), Exception::class.java, { SessionResult(SessionError.ERROR_UNKNOWN) }, MoreExecutors.directExecutor())
          ACTION_SHUFFLE -> player.shuffleModeEnabled = !player.shuffleModeEnabled
          ACTION_VOLUME -> EngineHub.carVolumeStep()
          // CAR-RADIO-CONTROLS-001: the song on air, as the song player's star (which opens the picker).
          // A programme or an unmatched title is never starred: programmes never train taste.
          ACTION_STAR -> {
            val song = MediaHub.radioSong
            if (song == null) tellDriver("No song has been identified on this station yet.")
            else {
              // CAR-HEART-ALWAYS-001: the heart always brings the picker; it no longer takes a star off by itself.
              val starredBefore = CarFeedback.state(song.id).first
              if (!starredBefore) CarFeedback.submit(song.id, "like")
              pickUnstar = starredBefore
              // CAR-PICK-LIST-001: in the car the playlists come as a list in place of the player, radio included.
              val asList = picksFromList(session, controller)
              setPickFor(song.id, asList)
              if (!asList) tellDriver(CarPickList.hint(song.title, pickChoices(song.id), starredBefore))
            }
          }
          ACTION_STAR_ARTISTS -> {
            val song = MediaHub.radioSong
            if (song == null) tellDriver("No song has been identified on this station yet.") else starArtists(song.id, song.artist)
          }
          else -> return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
        }
        refreshCarButtons()
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
      when (customCommand.customAction) {
        ACTION_SHUFFLE -> player.shuffleModeEnabled = !player.shuffleModeEnabled
        ACTION_REPEAT -> player.cycleSongRepeat()
        ACTION_VOLUME -> EngineHub.carVolumeStep()
        // CAR-SIMILAR-ID-001 (owner, 2026-11-23): "sometimes the find similar songs ... buttons don't work".
        // A playlist row's media id carries its list ("playlist/<id>/track/<key>") and the radio's starts
        // with "radio:"; the page knows neither. currentSongId() is the song as the page names it.
        ACTION_SIMILAR -> findSimilar(currentSongId() ?: run { tellDriver("Play a song first, then press Find similar."); return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE)) })
        ACTION_STAR -> {
          val id = currentSongId() ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
          // CAR-HEART-ALWAYS-001 (owner, 2026-11-23): "hearting a song doesnt bring up the playlist sub menu like
          // desired". The heart always brings the picker: a song already starred keeps its star and gets the same
          // choices plus "Remove star". Only a song the car cannot name (nothing to add) still toggles.
          val starredBefore = CarFeedback.state(id).first
          val picking = MediaHub.findSong(id) != null
          if (!starredBefore) CarFeedback.submit(id, "like") else if (!picking) CarFeedback.submit(id, "unlike")
          pickUnstar = starredBefore
          // CAR-PICK-LIST-001: in the car the playlists come as a list in place of the player. Anywhere else
          // (CAR-PICK-ON-PLAYER-001) they become the player's buttons, so say what to do, not where to go.
          val asList = picking && picksFromList(session, controller)
          setPickFor(if (picking) id else null, asList)
          if (picking && !asList) tellDriver(CarPickList.hint(MediaHub.findSong(id)?.title, pickChoices(id), starredBefore))
          if (!starredBefore) moodNudge(id, "like")
        }
        // CAR-PICK-ON-PLAYER-001: one of those list buttons (or Cancel) was pressed.
        ACTION_PICK_LIST -> {
          val listId = customCommand.customExtras.getString(PICK_LIST_EXTRA).orEmpty()
          val songId = customCommand.customExtras.getString(PICK_SONG_EXTRA).orEmpty().ifEmpty { currentSongId().orEmpty() }
          applyPick(listId, songId)
        }
        ACTION_DISLIKE -> {
          val id = currentSongId() ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
          val already = CarFeedback.state(id).second
          CarFeedback.submit(id, if (already) "undislike" else "dislike")
          // Not for me: move on, as the car's other music apps do. Undoing a dislike stays put.
          // CAR-X-001 (owner, 2026-11-24): wherever the song sits, not only when Media3 sees a next item.
          if (!already && !player.leaveSong(id) { CarFeedback.state(it.id).second }) tellDriver("Nothing else is ready to play yet")
          if (!already) moodNudge(id, "dislike")
        }
        ACTION_STAR_ARTISTS -> {
          val id = currentSongId() ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
          val song = scopedSong(player.currentMediaItem?.mediaId ?: id) ?: MediaHub.findSong(id)
          starArtists(id, song?.artist ?: player.mediaMetadata.artist?.toString().orEmpty())
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
      // CAR-CONTROLS-001: whether this car draws row actions (the star that opens the playlist picker).
      android.util.Log.i("AirwaveCar", "root for ${browser.packageName}: row actions ${browser.maxCommandsForMediaItems}, hints ${params?.extras?.keySet()?.sorted()}")
      val extras = android.os.Bundle().apply {
        // Standard browser search hint; no fake Search folder or dead-end custom car screen.
        putBoolean("android.media.browse.SEARCH_SUPPORTED", true)
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
      }
      val root = folderItem(ROOT, "jPlay", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
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
        shownToCar(parentId)
        return Futures.catching(Futures.transform(radioChildren(parentId), {
          LibraryResult.ofItemList(ImmutableList.copyOf(page(withPicker(parentId, it.orEmpty()), page, pageSize)), params)
        }, MoreExecutors.directExecutor()), Exception::class.java, {
          LibraryResult.ofItemList(ImmutableList.copyOf(page(listOf(note("Station directory is unavailable", "Try Favourite stations or retry")), page, pageSize)), params)
        }, MoreExecutors.directExecutor())
      }
      radioSearchUntil = 0
      // MOOD-DEFAULT-CAR-001: Playlists > Discover for my mood. Opening it starts a run; its answer shows as a note.
      if (parentId == CarMoodDiscover.ID) {
        return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(page(moodDiscoverOpened(), page, pageSize)), params))
      }
      // CAR-SETTINGS-001: Playlists > Sound & discovery settings. A set row applies its choice and shows its list again.
      if (CarSettings.isSettings(parentId)) {
        val kids = settingsChildren(parentId) ?: return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
        return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(page(kids, page, pageSize)), params))
      }
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
          // CAR-QUICK-SEARCH-001: tapping a kind listens for the words at once and lists only that kind.
          return Futures.transform(voiceItems(type), { LibraryResult.ofItemList(ImmutableList.copyOf(page(it!!, page, pageSize)), params) }, MoreExecutors.directExecutor())
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
          settingsFolder(),
          moodDiscoverRow(),
          phoneFolder(),
          if (MediaHub.savedAlbums().isNotEmpty()) folderItem(FOLDER_ALBUMS, "Albums", MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS, "Your saved albums") else null,
        ) + MediaHub.savedLists().map {
          folderItem("$PLAYLIST_PREFIX${Uri.encode(it.id)}", it.title, MediaMetadata.MEDIA_TYPE_PLAYLIST)
        }
        parentId == FOLDER_ALBUMS -> MediaHub.savedAlbums().map { albumItem(it) }
        // CAR-CONTROLS-001: the playlist picker a row's star opens; a tap adds the song (onSetMediaItems).
        parentId.startsWith(ADD_TO_PREFIX) && !parentId.removePrefix(ADD_TO_PREFIX).contains('/') -> {
          val songId = Uri.decode(parentId.removePrefix(ADD_TO_PREFIX))
          if (MediaHub.findSong(songId) == null) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
          MediaHub.savedLists().map { pickItem(it, songId) }
            .ifEmpty { listOf(note("No playlists yet", "Make one in jPlay on your phone, then star again")) }
        }
        // ALBUM-CAR-001: an album a car search found, its songs in album order.
        parentId.startsWith(CAR_ALBUM_PREFIX) && !parentId.contains("/track/") ->
          MediaHub.catalogAlbum(Uri.decode(parentId.removePrefix(CAR_ALBUM_PREFIX)))?.songs?.map { songItem(it) } ?: emptyList()
        parentId.startsWith(PLAYLIST_PREFIX) -> {
          val listId = Uri.decode(parentId.removePrefix(PLAYLIST_PREFIX))
          MediaHub.playlist(listId)?.songs?.map { songItem(it, playlistTrackId(listId, it.id)) }
            ?.ifEmpty { if (listId == MediaHub.PHONE_LIST) listOf(note("No songs on this phone yet", "Download songs in jPlay on your phone")) else emptyList() }
            ?: emptyList()
        }
        else -> emptyList()
      }
      if (takesPicker(parentId)) shownToCar(parentId)
      return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(page(withPicker(parentId, items), page, pageSize)), params))
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      radioFolder(mediaId)?.let { return Futures.immediateFuture(LibraryResult.ofItem(it, null)) }
      settingsItem(mediaId)?.let { return Futures.immediateFuture(LibraryResult.ofItem(it, null)) }
      if (mediaId == CarMoodDiscover.ID) return Futures.immediateFuture(LibraryResult.ofItem(moodDiscoverRow(), null))
      RadioCatalog.stationId(mediaId)?.let { id ->
        return Futures.catching(Futures.transform(RadioCatalog.async { RadioCatalog.resolve(this@PlaybackService, id) }, { station ->
          if (station == null) LibraryResult.ofError(SessionError.ERROR_BAD_VALUE) else LibraryResult.ofItem(RadioCatalog.item(station), null)
        }, MoreExecutors.directExecutor()), Exception::class.java, { LibraryResult.ofError(SessionError.ERROR_BAD_VALUE) }, MoreExecutors.directExecutor())
      }
      val item: MediaItem? = when {
        mediaId == ROOT -> folderItem(ROOT, "jPlay", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
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
        mediaId.startsWith(CarPickList.ROW_PREFIX) -> CarPickList.parseRow(mediaId)?.let { (_, songId) ->
          MediaHub.findSong(songId)?.let { song -> pickRows(song).firstOrNull { it.mediaId == mediaId } }
        }
        mediaId.startsWith(ADD_TO_PREFIX) -> pickTarget(mediaId)?.let { (list, songId) -> pickItem(list, songId) }
          ?: MediaHub.findSong(Uri.decode(mediaId.removePrefix(ADD_TO_PREFIX)))?.let(::pickerRow)
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
      if (radioFolder(parentId) != null || settingsItem(parentId) != null) Futures.immediateFuture(LibraryResult.ofVoid()) else super.onSubscribe(session, browser, parentId, params)

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

    /**
     * CAR-RESUME-001: Android Auto asks to play when the car connects, and a car or Bluetooth head unit
     * sends Play. With nothing loaded yet Media3 asks here; unanswered, the play was dropped and a Play
     * button that started this service killed the app 10 s later (no foreground notification). The
     * answer is the queue last played, at its song and place.
     */
    override fun onPlaybackResumption(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      isForPlayback: Boolean,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      // CAR-PICK-LIST-001: asked to resume while the car was shown the playlist list: nothing stopped, so the answer
      // is the queue as it is, the song where it is.
      if (listPick) { setPickFor(null); currentSongId()?.let { return Futures.immediateFuture(stayOnCurrent(it)) } }
      NativeLibraryState.init(this@PlaybackService)
      val plan = CarResume.plan(NativeLibraryState.nativeState(), MediaHub.state.queue, Downloads::urlAllowed)
        ?: return Futures.immediateFailedFuture(UnsupportedOperationException("Nothing has been played yet."))
      player.offerResumed(plan.entries)
      android.util.Log.i("AirwaveCar", "resuming ${plan.entries.size} songs at ${plan.index} (${if (isForPlayback) "play" else "show"} for ${controller.packageName})")
      return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(plan.entries.map { (m, s) -> songItem(s, m) }.toMutableList(), plan.index, plan.positionMs))
    }

    /** A tap in the car, or a voice request ("play X"), arrives here as bare ids or a search query;
     *  resolve each to a real song so the player can forward the right id to the page. */
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> =
      if (rowPick(mediaItems)?.let { (choice, songId) -> applyPick(choice, songId) } != null) Futures.immediateFuture(mutableListOf())
      else if (pickTarget(mediaItems)?.let { (list, songId) -> addPicked(list, songId) } != null) Futures.immediateFuture(mutableListOf())
      else Futures.transform(Futures.allAsList(mediaItems.map(::resolveAsync)), { it!!.toMutableList() }, MoreExecutors.directExecutor())

    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      // CAR-CONTROLS-001: a tap in the playlist picker adds the song and changes nothing that plays.
      // Android Auto opens its player on the tap and shows "Could not load your selection" when the
      // request fails, so the answer is the queue as it is, the current song at its current place.
      // CAR-PICK-LIST-001: a row of the playlist list. The real player is back before the answer is read, so the
      // answer is the real queue; Android Auto opens its player on the tap, on the song that never stopped.
      rowPick(mediaItems)?.let { (choice, songId) -> applyPick(choice, songId); return Futures.immediateFuture(stayOnCurrent(songId)) }
      pickTarget(mediaItems)?.let { (list, songId) -> addPicked(list, songId); return Futures.immediateFuture(stayOnCurrent(songId)) }
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
      .setMediaMetadata(WebPlayer.metadataOf(song, playable = true).buildUpon().setSupportedCommands(listOf(ACTION_STAR_TO_PLAYLIST)).build())
      .build()

  /** CAR-LOCAL-001: "On this phone", the songs whose full recordings are on the phone, first under Playlists. */
  private fun phoneFolder(): MediaItem {
    val n = MediaHub.phoneSongs().size
    val base = folderItem("$PLAYLIST_PREFIX${Uri.encode(MediaHub.PHONE_LIST)}", "On this phone", MediaMetadata.MEDIA_TYPE_PLAYLIST,
      if (n == 1) "1 song saved on this phone" else "$n songs saved on this phone")
    val art = Uri.parse("android.resource://$packageName/drawable/${resources.getResourceEntryName(R.drawable.car_on_phone)}")
    return base.buildUpon().setMediaMetadata(base.mediaMetadata.buildUpon().setArtworkUri(art).build()).build()
  }

  /** CAR-CONTROLS-001: the row that opens the playlist picker for [song]. */
  private fun pickerRow(song: MediaHub.Song): MediaItem {
    val base = folderItem("$ADD_TO_PREFIX${Uri.encode(song.id)}", "Add \u201c${song.title}\u201d to a playlist", MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS, "Starred \u00b7 choose a playlist")
    // A full-width row with the star-plus picture, not a grid tile with no picture above the songs.
    val extras = Bundle().apply { putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_SINGLE_ITEM, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM) }
    val art = Uri.parse("android.resource://$packageName/drawable/${resources.getResourceEntryName(R.drawable.car_star_add)}")
    return base.buildUpon().setMediaMetadata(base.mediaMetadata.buildUpon().setArtworkUri(art).setExtras(extras).build()).build()
  }

  /** CAR-CONTROLS-001: the song a row stands for, whatever list it is shown in. */
  private fun rowSong(mediaId: String?): MediaHub.Song? {
    if (mediaId.isNullOrBlank()) return null
    return scopedSong(mediaId) ?: MediaHub.findSong(mediaId)
  }

  /** One playlist in the picker: a tap target, saying whether the song is already in it. */
  private fun pickItem(list: MediaHub.Folder, songId: String): MediaItem {
    val has = list.songs.any { it.id == songId }
    return MediaItem.Builder()
      .setMediaId("$ADD_TO_PREFIX${Uri.encode(list.id)}/${Uri.encode(songId)}")
      .setMediaMetadata(
        MediaMetadata.Builder().setTitle(list.title)
          .setSubtitle(if (has) "Already in this playlist" else "${list.songs.size} song${if (list.songs.size == 1) "" else "s"} \u00b7 tap to add")
          .setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST).build(),
      ).build()
  }

  /** `addto/<list>/<song>` -> the playlist (never a saved album) and the song id; null for anything else. */
  private fun pickTarget(mediaId: String): Pair<MediaHub.Folder, String>? {
    val rest = mediaId.removePrefix(ADD_TO_PREFIX).takeIf { mediaId.startsWith(ADD_TO_PREFIX) } ?: return null
    val parts = rest.split('/')
    if (parts.size != 2) return null
    val list = MediaHub.playlist(Uri.decode(parts[0]))?.takeIf { !it.album } ?: return null
    val songId = Uri.decode(parts[1]).takeIf { MediaHub.findSong(it) != null } ?: return null
    return list to songId
  }

  private fun pickTarget(items: List<MediaItem>): Pair<MediaHub.Folder, String>? = items.singleOrNull()?.let { pickTarget(it.mediaId) }

  private fun addPicked(list: MediaHub.Folder, songId: String) {
    if (list.songs.none { it.id == songId }) CarFeedback.addToPlaylist(songId, list.id)
    if (pickFor == songId) mainHandler.post { setPickFor(null) }
  }

  /** The queue unchanged, its current song flagged to stay loaded where it is; or the picked song when nothing is queued. */
  private fun stayOnCurrent(songId: String): MediaSession.MediaItemsWithStartPosition {
    val n = player.mediaItemCount
    val at = player.currentMediaItemIndex
    if (n == 0 || at !in 0 until n) return MediaSession.MediaItemsWithStartPosition(mutableListOf(songItem(MediaHub.findSong(songId)!!)), 0, 0)
    val keep = MediaItem.RequestMetadata.Builder().setExtras(Bundle().apply { putBoolean(EnginePlayer.KEEP_PLAYING, true) }).build()
    val items = (0 until n).map { i -> player.getMediaItemAt(i).let { if (i == at) it.buildUpon().setRequestMetadata(keep).build() else it } }
    return MediaSession.MediaItemsWithStartPosition(items.toMutableList(), at, player.currentPosition)
  }

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
    const val VOICE_REUSE_MS = 15_000L
    const val VOICE_RETRY_MS = 2_000L
    const val ACTION_STAR = "com.nowplaying.discovery.STAR"
    const val ACTION_DISLIKE = "com.nowplaying.discovery.DISLIKE"
    const val ACTION_SHUFFLE = "com.nowplaying.discovery.SHUFFLE"
    const val ACTION_REPEAT = "com.nowplaying.discovery.REPEAT"
    val STAR = SessionCommand(ACTION_STAR, Bundle.EMPTY)
    val DISLIKE = SessionCommand(ACTION_DISLIKE, Bundle.EMPTY)
    val SHUFFLE = SessionCommand(ACTION_SHUFFLE, Bundle.EMPTY)
    val REPEAT = SessionCommand(ACTION_REPEAT, Bundle.EMPTY)
    const val ACTION_SIMILAR = "com.nowplaying.discovery.SIMILAR"
    val SIMILAR = SessionCommand(ACTION_SIMILAR, Bundle.EMPTY)
    const val ACTION_VOLUME = "com.nowplaying.discovery.VOLUME"
    val VOLUME = SessionCommand(ACTION_VOLUME, Bundle.EMPTY)
    /** CAR-STAR-PICKER-001: Android Auto cannot open a list from a player button, so the driver is told where the picker is. */
    const val DRIVER_MESSAGE_MS = 4000L
    const val PICK_HINT = "Starred \u2013 go back to choose a playlist"
    const val ACTION_FAVOURITE_STATION = "com.nowplaying.discovery.FAVOURITE_STATION"
    val FAVOURITE_STATION = SessionCommand(ACTION_FAVOURITE_STATION, Bundle.EMPTY)
    const val ACTION_STAR_ARTISTS = "com.nowplaying.discovery.STAR_ARTISTS"
    val STAR_ARTISTS = SessionCommand(ACTION_STAR_ARTISTS, Bundle.EMPTY)
    const val ACTION_STAR_TO_PLAYLIST = "com.nowplaying.discovery.STAR_TO_PLAYLIST"
    val STAR_TO_PLAYLIST = SessionCommand(ACTION_STAR_TO_PLAYLIST, Bundle.EMPTY)
    /** CAR-PICK-ON-PLAYER-001: one command behind every list button; Media3 ignores extras when matching it. */
    const val ACTION_PICK_LIST = "com.nowplaying.discovery.PICK_LIST"
    val PICK_LIST = SessionCommand(ACTION_PICK_LIST, Bundle.EMPTY)
    const val PICK_LIST_EXTRA = "list"
    const val PICK_SONG_EXTRA = "song"
    /** How long the player keeps the playlist buttons up when the driver does not choose. */
    const val PICK_WINDOW_MS = 25_000L
    const val ADD_TO_PREFIX = "addto/"
    /** androidx.media.utils.MediaConstants.EXTRAS_KEY_CUSTOM_BROWSER_ACTION_RESULT_BROWSE_NODE: the list the car opens next. */
    const val RESULT_BROWSE_NODE = "androidx.media.utils.extras.KEY_CUSTOM_BROWSER_ACTION_RESULT_BROWSE_NODE"
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
