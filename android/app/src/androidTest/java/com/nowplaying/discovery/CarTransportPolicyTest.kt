package com.nowplaying.discovery

import android.content.Context

import android.os.Looper
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nowplaying.discovery.engine.EngineHub
import com.nowplaying.discovery.engine.EnginePlayer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** CAR-QUEUE-HANDOFF-001: a phone snapshot can precede player or page attachment. */
@UnstableApi
@RunWith(AndroidJUnit4::class)
class CarTransportPolicyTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private lateinit var player: EnginePlayer
  private var previousPlayer: EnginePlayer? = null
  private var previousPage: EnginePlayer.Page? = null
  private val page = object : EnginePlayer.Page {
    override val live = true
    override fun command(cmd: JSONObject) {}
    override fun state(json: JSONObject) {}
  }
  private val songs = (1..3).map { i -> JSONObject().put("id", "handoff$i").put("title", "Queue handoff fixture $i")
    .put("artist", "Instrumentation fixture").put("durationMs", 180000).put("ready", false) }

  @Before fun setUp() {
    // Borrow the bridge, not the service lifecycle. Stopping an in-flight Media3 foreground start
    // from a prior test can trip Android's promotion deadline. Leave that service intact and
    // temporarily detach its player so it cannot consume this fixture's pending phone load.
    instr.runOnMainSync {
      val field = EngineHub::class.java.getDeclaredField("player").apply { isAccessible = true }
      val pageField = EngineHub::class.java.getDeclaredField("page").apply { isAccessible = true }
      previousPlayer = field.get(EngineHub) as? EnginePlayer
      previousPage = pageField.get(EngineHub) as? EnginePlayer.Page
      previousPage?.let { EngineHub.detachPage(it) }
      previousPlayer?.let { EngineHub.detachPlayer(it) }
    }
    // EngineHub posts to the main handler. Drain those posts without waiting for a busy
    // service/WebView to reach global idle (which may never happen during a full suite).
    instr.runOnMainSync { }
    instr.runOnMainSync {
      player = EnginePlayer(ctx, Looper.getMainLooper(), resolve = { null }, stream = { null }, manageFocus = false)
      // The page's initial snapshot arrives before a player exists; do not rely on another push.
      val list = JSONArray(songs)
      MediaHub.apply(JSONObject().put("state", JSONObject().put("queue", list)).put("library", JSONObject().put("songs", list)))
    }
    instr.runOnMainSync { }
  }
  @After fun tearDown() {
    EngineHub.detachPage(page)
    EngineHub.detachPlayer(player)
    instr.runOnMainSync { }
    instr.runOnMainSync { player.release() }
    previousPage?.let { EngineHub.attachPage(it) }
    previousPlayer?.let { EngineHub.attachPlayer(it) }
    instr.runOnMainSync { }
  }
  private fun loadMiddle() = EngineHub.fromPage(JSONObject().put("op", "load").put("song", songs[1])
    .put("play", false).put("rev", Int.MAX_VALUE).toString())
  private fun assertFullTimeline() {
    instr.runOnMainSync { }
    instr.runOnMainSync {
      assertEquals("the full phone queue survives initialization", 3, player.mediaItemCount)
      assertEquals("the phone's chosen song stays current", "handoff2", player.currentMediaItem?.mediaId)
      assertEquals(1, player.currentMediaItemIndex)
      assertTrue(player.hasNextMediaItem())
      assertTrue(player.hasPreviousMediaItem())
      assertTrue(player.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT))
      assertTrue(player.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM))
      assertTrue(player.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS))
      assertTrue(player.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM))
      assertFalse("music controls must not offer timed forward jumps", player.isCommandAvailable(Player.COMMAND_SEEK_FORWARD))
      assertFalse("music controls must not offer timed back jumps", player.isCommandAvailable(Player.COMMAND_SEEK_BACK))
    }
  }
  @Test fun pageAndPendingLoadBeforeTheServiceStillRestoreTheFullPhoneQueue() {
    EngineHub.attachPage(page)
    loadMiddle()
    EngineHub.attachPlayer(player)
    assertFullTimeline()
  }
  @Test fun aPageAttachingAfterTheServiceReplaysItsAlreadyPublishedQueue() {
    EngineHub.attachPlayer(player)
    EngineHub.attachPage(page)
    loadMiddle()
    assertFullTimeline()
  }
  @Test fun clearingAPopulatedCarQueueDoesNotCrashTheSession() {
    EngineHub.attachPage(page)
    EngineHub.attachPlayer(player)
    loadMiddle()
    assertFullTimeline()
    instr.runOnMainSync {
      player.clearMediaItems()
      assertEquals(0, player.mediaItemCount)
      assertFalse(player.playWhenReady)
    }
  }
  @Test fun removingTheCurrentItemKeepsTheRemainingQueueNavigable() {
    EngineHub.attachPage(page)
    EngineHub.attachPlayer(player)
    loadMiddle()
    assertFullTimeline()
    instr.runOnMainSync {
      player.removeMediaItem(1)
      assertEquals(2, player.mediaItemCount)
      assertEquals("handoff3", player.currentMediaItem?.mediaId)
      assertEquals(1, player.currentMediaItemIndex)
    }
  }
}
