package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Explicit live-network smoke. Run with -e liveRadio true; normal offline suites skip it. */
@RunWith(AndroidJUnit4::class)
class RadioLivePlaybackTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private fun main(block: () -> Unit) = instr.runOnMainSync(block)
  private fun <T> await(call: () -> ListenableFuture<T>): T {
    val result = AtomicReference<ListenableFuture<T>>()
    main { result.set(call()) }
    return result.get().get(40, TimeUnit.SECONDS)
  }
  private fun until(message: String, timeout: Long = 40000, test: () -> Boolean) {
    val end = SystemClock.elapsedRealtime() + timeout
    while (SystemClock.elapsedRealtime() < end) { if (test()) return; Thread.sleep(100) }
    fail(message + ": " + RadioNative.session?.let { "station=${it.station},frames=${it.ring.end},heard=${it.ring.heard},error=${it.ring.failed}" })
  }
  @Test fun liveVoiceSearchAlphabeticalBrowseAndStationTransport() {
    assumeTrue("Live radio requires explicit network opt-in", InstrumentationRegistry.getArguments().getString("liveRadio") == "true")
    val browser = await { MediaBrowser.Builder(ctx, SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))).buildAsync() }
    try {
      val az = await { browser.getChildren("radio/az/0", 0, 50, null) }.value!!
        .filter { it.mediaMetadata.isPlayable == true }
      assertTrue("Real world A-Z directory returned stations", az.isNotEmpty())
      val names = az.map { it.mediaMetadata.title.toString().lowercase(Locale.ROOT) }
      assertEquals("A-Z browsing is alphabetical", names.sorted(), names)
      await { browser.search("radio KEXP", null) }
      val rows = await { browser.getSearchResult("radio KEXP", 0, 20, null) }.value!!
        .filter { RadioCatalog.stationId(it.mediaId) != null }
      assertTrue("Typed/voice station search returned skip context", rows.size > 1)
      // Android Auto's voice-play route is the searchQuery request metadata, not a music song id.
      main {
        browser.setMediaItem(MediaItem.Builder().setRequestMetadata(
          MediaItem.RequestMetadata.Builder().setSearchQuery("radio KEXP").build()).build())
        browser.prepare(); browser.play()
      }
      until("Voice-selected radio actually decoded and played") { RadioNative.session?.ring?.heard?.let { it > 48000 } == true }
      val first = RadioNative.session!!.station
      var hasNext = false
      until("Car exposes Next station") { main { hasNext = browser.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM) }; hasNext }
      main { browser.seekToNextMediaItem() }
      until("Next switched and played another station") { RadioNative.session?.let { it.station != first && it.ring.heard > 48000 } == true }
      main { browser.seekToPreviousMediaItem() }
      until("Previous returned to the original station and played") { RadioNative.session?.let { it.station == first && it.ring.heard > 48000 } == true }
      val session = RadioNative.session!!
      main { browser.pause() }; Thread.sleep(800)
      assertTrue("Car pause is reflected in the phone/native radio state", session.paused)
      val pausedAt = session.ring.positionFrames
      Thread.sleep(1500)
      assertEquals("Paused audio did not advance", pausedAt, session.ring.positionFrames)
      main { browser.play() }
      until("Car resume advances radio") { !session.paused && session.ring.positionFrames > pausedAt + 24000 }
      android.util.Log.i("AirwaveRadioLiveQA", "PASS A-Z=${az.size} search=${rows.size} first=$first Next/Previous=played pause/resume=measured")
    } finally { main { browser.pause(); browser.release() }; RadioNative.handle(ctx, org.json.JSONObject().put("op", "stop")) }
  }
}
