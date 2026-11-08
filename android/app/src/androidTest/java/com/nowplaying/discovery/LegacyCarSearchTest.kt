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
}
