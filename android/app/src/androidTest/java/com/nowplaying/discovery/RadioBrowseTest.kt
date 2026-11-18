package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Native radio routing and real service/browser routes, without MainActivity or remote audio. */
@RunWith(AndroidJUnit4::class)
class RadioBrowseTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private fun <T> await(call: () -> ListenableFuture<T>): T {
    val result = AtomicReference<T>()
    val error = AtomicReference<Throwable>()
    val done = CountDownLatch(1)
    instr.runOnMainSync { val f = call(); f.addListener({
      try { result.set(f.get()) } catch (e: Exception) { error.set(e) } finally { done.countDown() }
    }, Runnable::run) }
    assertTrue("service call completed", done.await(25, TimeUnit.SECONDS))
    error.get()?.let { throw it }
    return result.get()
  }
  @Test fun stationMediaIdsBypassBothPageCommandsAndSongLookup() {
    // Invalid UUID fails in the catalogue before any stream, decoder, or Activity can start.
    // Without the interception, the live page gets playId or native song lookup consumes the id.
    for (pageLive in listOf(false, true)) {
      val commands = mutableListOf<JSONObject>()
      val lookups = mutableListOf<String>()
      lateinit var player: com.nowplaying.discovery.engine.EnginePlayer
      lateinit var future: ListenableFuture<*>
      instr.runOnMainSync {
        player = com.nowplaying.discovery.engine.EnginePlayer(ctx, android.os.Looper.getMainLooper(),
          resolve = { null }, lookup = { lookups += it; null }, manageFocus = false,
          landed = { { } }, stream = { null })
        player.page = object : com.nowplaying.discovery.engine.EnginePlayer.Page {
          override val live = pageLive
          override fun command(cmd: JSONObject) { commands += cmd }
          override fun state(json: JSONObject) { }
        }
        val method = player.javaClass.getDeclaredMethod("handleSetMediaItems", MutableList::class.java,
          Int::class.javaPrimitiveType, Long::class.javaPrimitiveType).apply { isAccessible = true }
        future = method.invoke(player, mutableListOf(MediaItem.Builder()
          .setMediaId("radio/station/invalid%2Fid").build()), 0, 0L) as ListenableFuture<*>
      }
      try {
        try { future.get(25, TimeUnit.SECONDS); fail("Station ids must reach the native catalogue") }
        catch (e: java.util.concurrent.ExecutionException) { assertTrue(e.cause is IllegalArgumentException) }
        assertTrue("No page playId for a station", commands.isEmpty())
        assertTrue("No music lookup for a station", lookups.isEmpty())
      } finally { instr.runOnMainSync { player.release() } }
    }
  }

  @Test fun catalogueStartsCannotReselectAnOverwrittenSkipContext() {
    fun row(id: String) = JSONObject().put("id", id).put("name", id).put("url", "https://streams.example/$id")
    val a = "skip-context-a"; val b = "skip-context-b"; val c = "skip-context-c"
    RadioCatalog.rememberStations(JSONArray().put(row(a)).put(row(b)).put(row(c)))
    RadioCatalog.selectContext(a)
    try {
      // A favourite refresh overwrites B's cached browse list while A remains tuned.
      RadioCatalog.rememberStations(JSONArray().put(row(b)))
      RadioCatalog.retainingContext { RadioCatalog.selectContext(b) }
      assertTrue(RadioCatalog.canSkip(b))
      assertEquals(c, RadioCatalog.adjacent(b, 1)?.id)
      assertEquals(a, RadioCatalog.adjacent(b, -1)?.id)
      assertEquals(a, RadioCatalog.adjacent(c, 1)?.id)
      // The guard is scoped: a later explicit choice must use its own (singleton) list.
      RadioCatalog.selectContext(b)
      assertFalse(RadioCatalog.canSkip(b))
    } finally { RadioCatalog.selectContext("missing-radio-test-context") }
  }

  @Test fun radioHasItsOwnTabAndPhoneFavouritesResolveWithoutActivity() {
    val saved = RadioCatalog.favourites(ctx, null)
    val station = JSONObject().put("id", "radio-test-kexp").put("name", "KEXP test")
      .put("url", "https://streams.example/kexp").put("country", "United States")
    RadioNative.handle(ctx, JSONObject().put("op", "favourites").put("stations", JSONArray().put(station)))
    val browser = await { MediaBrowser.Builder(ctx, SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))).buildAsync() }
    try {
      val root = await { browser.getLibraryRoot(null) }.value!!
      val tabs = await { browser.getChildren(root.mediaId, 0, 10, null) }.value!!
      assertEquals(listOf("songs", "playlists", "radio", "search"), tabs.map { it.mediaId })
      val children = await { browser.getChildren("radio", 0, 10, null) }.value!!
      assertEquals(listOf("radio/favourites", "radio/all", "radio/search"), children.map { it.mediaId })
      assertEquals("All stations", children[1].mediaMetadata.title.toString())
      val letters = await { browser.getChildren("radio/all", 0, 40, null) }.value!!
      assertEquals(28, letters.size); assertTrue(letters.any { it.mediaId == "radio/letter/A/0" }); assertTrue(letters.any { it.mediaId == "radio/letter/Z/0" }); assertTrue(letters.any { it.mediaId == "radio/letter/#/0" })
      assertEquals("A", await { browser.getItem("radio/letter/A/0") }.value!!.mediaMetadata.title.toString())
      val digits = await { browser.getChildren("radio/letter/#/0", 0, 20, null) }.value!!
      assertEquals((0..9).map { "radio/letter/$it/0" }, digits.map { it.mediaId })
      assertEquals("1", await { browser.getItem("radio/letter/1/0") }.value!!.mediaMetadata.title.toString())
      assertNotEquals(0, await { browser.getChildren("radio/letter/AA/0", 0, 10, null) }.resultCode)
      val favourites = await { browser.getChildren("radio/favourites", 0, 10, null) }.value!!
      val id = favourites.single().mediaId
      assertEquals("radio/station/radio-test-kexp", id)
      assertEquals(true, favourites.single().mediaMetadata.isPlayable)
      assertEquals("KEXP test", await { browser.getItem(id) }.value!!.mediaMetadata.title.toString())
      val toggled = RadioCatalog.toggle(ctx, "radio-test-kexp").get(25, TimeUnit.SECONDS)
      assertEquals(0, toggled.length())
      assertEquals(0, RadioNative.handle(ctx, JSONObject().put("op", "favourites")).getJSONArray("stations").length())
      RadioCatalog.toggle(ctx, "radio-test-kexp").get(25, TimeUnit.SECONDS)
      assertEquals("radio-test-kexp", RadioNative.handle(ctx, JSONObject().put("op", "favourites"))
        .getJSONArray("stations").getJSONObject(0).getString("id"))
      assertTrue(await { browser.getChildren("radio/favourites", 1, 1, null) }.value!!.isEmpty())
      assertTrue(await { browser.getChildren("radio/favourites", Int.MAX_VALUE, Int.MAX_VALUE, null) }.value!!.isEmpty())
      assertNotEquals(0, await { browser.getChildren("radio/az/-1", 0, 10, null) }.resultCode)
      // Phone updates and the dedicated car list share the same native persistence authority.
      RadioNative.handle(ctx, JSONObject().put("op", "favourites").put("stations", JSONArray()))
      val empty = await { browser.getChildren("radio/favourites", 0, 10, null) }.value!!
      assertEquals("No favourite stations yet", empty.single().mediaMetadata.title.toString())
    } finally {
      instr.runOnMainSync { browser.release() }
      RadioCatalog.favourites(ctx, saved)
    }
  }

  /** RADIO-SHUFFLE-001: the Media3 shuffle command toggles RADIO shuffle while radio is live. */
  @Test fun carShuffleCommandTogglesRadioShuffleAndTheSessionMirrorsIt() {
    fun row(id: String) = JSONObject().put("id", id).put("name", id).put("url", "https://streams.example/$id")
    fun <T> onMain(read: () -> T): T {
      val out = AtomicReference<T>()
      instr.runOnMainSync { out.set(read()) }
      return out.get()
    }
    fun until(what: String, condition: () -> Boolean) {
      val deadline = System.currentTimeMillis() + 10000
      while (System.currentTimeMillis() < deadline) {
        if (condition()) return
        Thread.sleep(100)
      }
      fail(what)
    }
    val browser = await { MediaBrowser.Builder(ctx, SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))).buildAsync() }
    val sessionField = RadioNative::class.java.getDeclaredField("session").apply { isAccessible = true }
    try {
      RadioCatalog.rememberStations(JSONArray().put(row("shuffle-live-a")).put(row("shuffle-live-b")).put(row("shuffle-live-c")))
      RadioCatalog.selectContext("shuffle-live-a")
      // A live session without a network: the tuned flags are real, the stream never opens.
      val s = RadioNative.Session("shuffle-op-test", "shuffle-live-a", RadioRing(),
        JSONObject().put("id", "shuffle-live-a").put("name", "Shuffle live A"))
      sessionField.set(RadioNative, s)
      instr.runOnMainSync {
        com.nowplaying.discovery.engine.EngineHub.fromPage(
          JSONObject().put("op", "radio").put("id", s.id).put("title", "Shuffle live A").put("station", "shuffle-live-a").toString())
      }
      until("the radio session advertises the shuffle command, off by default") {
        onMain { browser.isCommandAvailable(Player.COMMAND_SET_SHUFFLE_MODE) && !browser.shuffleModeEnabled }
      }
      assertFalse("the state op reports shuffle off", RadioNative.handle(ctx, JSONObject().put("op", "state")).getBoolean("shuffle"))
      instr.runOnMainSync { browser.shuffleModeEnabled = true }
      until("the car's shuffle lands on the radio flag, not the song round") { RadioNative.shuffle }
      until("the session mirrors radio shuffle for the car's button") { onMain { browser.shuffleModeEnabled } }
      assertTrue("the state op reports shuffle on", RadioNative.handle(ctx, JSONObject().put("op", "state")).getBoolean("shuffle"))
      // The radio 'shuffle' op is the same switch, and the session follows it too.
      val off = RadioNative.handle(ctx, JSONObject().put("op", "shuffle").put("on", false))
      assertFalse("the shuffle op answers with the state object", off.getBoolean("shuffle"))
      until("the session heard the op") { onMain { !browser.shuffleModeEnabled } }
    } finally {
      runCatching { RadioNative.handle(ctx, JSONObject().put("op", "stop")) }
      instr.runOnMainSync {
        com.nowplaying.discovery.engine.EngineHub.fromPage(JSONObject().put("op", "load")
          .put("song", JSONObject().put("id", "radio-shuffle-cleanup").put("title", "Cleanup").put("ready", false))
          .put("play", false).put("rev", Int.MAX_VALUE).toString())
      }
      instr.waitForIdleSync()
      assertFalse("radio shuffle resets when radio ends", RadioNative.shuffle)
      instr.runOnMainSync { browser.release() }
    }
  }
}
