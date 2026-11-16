package com.nowplaying.discovery

import android.content.ComponentName
import android.os.Bundle
import androidx.media3.session.legacy.MediaBrowserCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Android Auto uses the legacy browse adapter: a modern future alone must never leave it waiting. */
@RunWith(AndroidJUnit4::class)
class LegacyCarSearchTest {
  @Test fun failedCatalogueQueryTerminatesLegacySearchInsteadOfSpinningForever() {
    val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
    val instr = InstrumentationRegistry.getInstrumentation()
    val connected = CountDownLatch(1)
    val finished = CountDownLatch(1)
    val sink: (JSONObject) -> Unit = { cmd ->
      if (cmd.optString("type") == "catalogSearch") MediaHub.apply(JSONObject().put("search", JSONObject()
        .put("requestId", cmd.getString("requestId")).put("query", cmd.getString("query"))
        .put("error", "Network unavailable").put("songs", org.json.JSONArray())))
    }
    MediaHub.setCommandSink(sink)
    // A real page pushes its first snapshot before it answers; car search waits for that (MediaHub.pageAnswering).
    MediaHub.apply(JSONObject())
    var browser: MediaBrowserCompat? = null
    try {
      instr.runOnMainSync {
        browser = MediaBrowserCompat(ctx, ComponentName(ctx, PlaybackService::class.java), object: MediaBrowserCompat.ConnectionCallback() {
          override fun onConnected() { connected.countDown() }
        }, null).also { it.connect() }
      }
      assertTrue("legacy browser connects", connected.await(10, TimeUnit.SECONDS))
      instr.runOnMainSync {
        browser!!.search("unobtainable-query-z928", null, object: MediaBrowserCompat.SearchCallback() {
          override fun onSearchResult(query: String, extras: Bundle?, items: MutableList<MediaBrowserCompat.MediaItem>) { finished.countDown() }
          override fun onError(query: String, extras: Bundle?) { finished.countDown() }
        })
      }
      assertTrue("legacy car search must finish even when catalogue lookup fails", finished.await(5, TimeUnit.SECONDS))
    } finally {
      MediaHub.clearCommandSink(sink)
      instr.runOnMainSync { browser?.disconnect() }
    }
  }

  /** A typed car search before the page has loaded is held, never sent, and still ends at its timeout. */
  @Test fun debouncedSearchWaitsForPageSnapshotYetStillTerminates() {
    val sent = java.util.concurrent.atomic.AtomicInteger()
    val sink: (JSONObject) -> Unit = { cmd -> if (cmd.optString("type") == "catalogSearch") sent.incrementAndGet() }
    // CAR-CATALOG-SERVICE-001: once the service's own catalogue engine is ready it answers (correctly), so an
    // earlier test that started the service made this premise false. Hold a never-ready engine here and
    // put the real one back after, so this checks only the "nobody can answer yet" case.
    val sinkField = MediaHub::class.java.getDeclaredField("catalogSink").apply { isAccessible = true }
    val readyField = MediaHub::class.java.getDeclaredField("catalogReady").apply { isAccessible = true }
    val realEngine = sinkField.get(null)
    val realReady = readyField.getBoolean(null)
    val heldEngine: (JSONObject) -> Unit = { cmd -> if (cmd.optString("type") == "catalogSearch") sent.incrementAndGet() }
    MediaHub.setCatalogSink(heldEngine)
    MediaHub.setCommandSink(sink)
    try {
      val future = MediaHub.searchCatalog("unloaded-page-query-z928", timeoutMs = 1500, debounceMs = 650)
      val error = try { future.get(5, TimeUnit.SECONDS); null } catch (e: java.util.concurrent.ExecutionException) { e.cause }
      assertTrue("held search fails with a timeout, got $error", error is java.util.concurrent.TimeoutException)
      assertEquals("nothing is sent to a page that has not pushed its first snapshot", 0, sent.get())
    } finally {
      MediaHub.clearCommandSink(sink)
      MediaHub.clearCatalogSink(heldEngine)
      sinkField.set(null, realEngine)
      readyField.setBoolean(null, realReady)
    }
  }
}
