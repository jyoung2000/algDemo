package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.media3.session.legacy.MediaBrowserCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Opt-in live car search; the phone page must be open behind Android Auto. */
@RunWith(AndroidJUnit4::class)
class CarSearchLiveTest {
  @Test fun typedCarSearchReturnsRealCatalogueRowsWhileThePageIsBehindTheCar() {
    val args = InstrumentationRegistry.getArguments()
    assumeTrue("live network search only on request", args.getString("liveCatalog") == "1")
    val query = args.getString("query") ?: "Sade"
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    val instr = InstrumentationRegistry.getInstrumentation()
    ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    val deadline = System.currentTimeMillis() + 45_000
    while (!(MediaHub.hasPage() && MediaHub.pageAnswering) && System.currentTimeMillis() < deadline) Thread.sleep(250)
    assertTrue("phone page is answering", MediaHub.hasPage() && MediaHub.pageAnswering)
    // Replicate the DHU: Android Auto's car surface has the foreground, the phone page does not.
    ctx.startActivity(Intent().setClassName("com.google.android.projection.gearhead", "com.google.android.projection.gearhead.companion.settings.DefaultSettingsActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    // Let the phone renderer settle into its actual idle/background state; an immediate
    // request after launching the page can pass even though Android Auto search later hangs.
    Thread.sleep(30_000)
    CarSearch.pick(CarSearchType.ALL, 0)
    val connected = CountDownLatch(1)
    val got = AtomicReference<List<MediaBrowserCompat.MediaItem>>()
    val done = CountDownLatch(1)
    var browser: MediaBrowserCompat? = null
    try {
      instr.runOnMainSync {
        browser = MediaBrowserCompat(ctx, ComponentName(ctx, PlaybackService::class.java), object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnected() { connected.countDown() }
        }, null).also { it.connect() }
      }
      assertTrue("car browser connected", connected.await(15, TimeUnit.SECONDS))
      instr.runOnMainSync {
        browser!!.search(query, Bundle(), object : MediaBrowserCompat.SearchCallback() {
          override fun onSearchResult(q: String, extras: Bundle?, items: List<MediaBrowserCompat.MediaItem>) {
            got.set(items.toList()); done.countDown()
          }
          override fun onError(q: String, extras: Bundle?) { got.set(emptyList()); done.countDown() }
        })
      }
      assertTrue("car search answered", done.await(40, TimeUnit.SECONDS))
      val rows = got.get().map { "${it.description.title} | ${it.description.subtitle} | playable=${it.isPlayable}" }
      Log.i("AirwaveCarSearchLive", "query=$query rows=${rows.take(20)}")
      assertTrue("car search returned an actual song: $rows", got.get().any { it.isPlayable })
    } finally {
      instr.runOnMainSync { browser?.disconnect() }
    }
  }
}
