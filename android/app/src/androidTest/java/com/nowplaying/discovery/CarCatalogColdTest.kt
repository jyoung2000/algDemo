package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import android.util.Log
import androidx.media3.session.legacy.MediaBrowserCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * CAR-CATALOG-SERVICE-001, opt-in live: with no phone Activity ever launched, the car's typed artist
 * search is answered by the service's own catalogue engine with the artist's real songs.
 */
@RunWith(AndroidJUnit4::class)
class CarCatalogColdTest {
  private fun liveActivities(): List<String> {
    val names = ArrayList<String>()
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      val reg = ActivityLifecycleMonitorRegistry.getInstance()
      for (s in listOf(Stage.PRE_ON_CREATE, Stage.CREATED, Stage.STARTED, Stage.RESUMED, Stage.PAUSED, Stage.STOPPED)) {
        reg.getActivitiesInStage(s).forEach { names += "${it.javaClass.simpleName}@$s" }
      }
    }
    return names
  }

  @Test fun coldArtistSearchIsAnsweredWithoutAnyPhonePage() {
    val args = InstrumentationRegistry.getArguments()
    assumeTrue("live network search only on request", args.getString("liveCatalog") == "1")
    val artist = args.getString("artist") ?: "Sade"
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    val instr = InstrumentationRegistry.getInstrumentation()
    assertTrue("no phone Activity before the search: ${liveActivities()}", liveActivities().isEmpty())
    assertFalse("no Activity command sink before the search", MediaHub.hasPage())
    CarSearch.pick(CarSearchType.ALL, 0)
    val connected = CountDownLatch(1)
    val got = AtomicReference<List<MediaBrowserCompat.MediaItem>>()
    val error = AtomicReference<String?>(null)
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
        browser!!.search("artist $artist", Bundle(), object : MediaBrowserCompat.SearchCallback() {
          override fun onSearchResult(q: String, extras: Bundle?, items: List<MediaBrowserCompat.MediaItem>) {
            got.set(items.toList()); done.countDown()
          }
          override fun onError(q: String, extras: Bundle?) { error.set("onError"); got.set(emptyList()); done.countDown() }
        })
      }
      assertTrue("car search answered", done.await(60, TimeUnit.SECONDS))
      val items = got.get()
      val rows = items.map { "${it.description.title} | ${it.description.subtitle} | playable=${it.isPlayable}" }
      Log.i("AirwaveCarCatalogCold", "artist=$artist error=${error.get()} rows=${rows.take(25)}")
      val songs = items.filter { it.isPlayable }
      assertTrue("cold artist search returned songs (error=${error.get()}): $rows", songs.isNotEmpty())
      val bySade = songs.filter { it.description.subtitle?.toString()?.contains(artist, ignoreCase = true) == true }
      assertTrue("every listed song is credited to $artist: $rows", bySade.size == songs.size)
      assertFalse("still no Activity command sink after the search", MediaHub.hasPage())
      assertTrue("still no phone Activity after the search: ${liveActivities()}", liveActivities().isEmpty())
      assertNoPreviewLengths(songs)
    } finally {
      instr.runOnMainSync { browser?.disconnect() }
    }
  }

  /** Owner rule: full songs only. A catalogue row never carries a 30 s preview's length. */
  private fun assertNoPreviewLengths(songs: List<MediaBrowserCompat.MediaItem>) {
    for (s in songs) {
      val d = MediaHub.findSong(s.mediaId!!)?.durationMs ?: continue
      Log.i("AirwaveCarCatalogCold", "duration ${s.description.title}: $d")
      assertFalse("${s.description.title} carries a preview length ($d ms)", d in 29_000L..31_000L)
    }
  }

  /**
   * DHU 2026-11-15 (cold, no Activity): the car keyboard sends every edited prefix about 0.9 s apart
   * with the default All type; the final query must answer with real songs inside MediaHub's 24 s car
   * deadline, and the songs come first on the results page with the type choice as one row after them.
   */
  @Test fun coldAllSearchTypedLikeTheCarListsSongsFirstWithinTheCarDeadline() {
    val args = InstrumentationRegistry.getArguments()
    assumeTrue("live network search only on request", args.getString("liveCatalog") == "1")
    val final = args.getString("query") ?: "sade"
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    val instr = InstrumentationRegistry.getInstrumentation()
    assertTrue("no phone Activity before the search: ${liveActivities()}", liveActivities().isEmpty())
    assertFalse("no Activity command sink before the search", MediaHub.hasPage())
    CarSearch.pick(CarSearchType.ALL, 0)
    val connected = CountDownLatch(1)
    val got = AtomicReference<List<MediaBrowserCompat.MediaItem>>()
    val error = AtomicReference<String?>(null)
    val done = CountDownLatch(1)
    var browser: MediaBrowserCompat? = null
    try {
      instr.runOnMainSync {
        browser = MediaBrowserCompat(ctx, ComponentName(ctx, PlaybackService::class.java), object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnected() { connected.countDown() }
        }, null).also { it.connect() }
      }
      assertTrue("car browser connected", connected.await(15, TimeUnit.SECONDS))
      // Wait for the service's catalogue engine as the car would (it shows the app before typing).
      val readyBy = System.currentTimeMillis() + 20_000
      while (!MediaHub.catalogReady && System.currentTimeMillis() < readyBy) Thread.sleep(100)
      assertTrue("service catalogue engine ready", MediaHub.catalogReady)
      var askedAt = 0L
      for (n in 1..final.length) {
        val q = final.take(n)
        if (q == final) askedAt = System.currentTimeMillis()
        instr.runOnMainSync {
          browser!!.search(q, Bundle(), object : MediaBrowserCompat.SearchCallback() {
            override fun onSearchResult(query: String, extras: Bundle?, items: List<MediaBrowserCompat.MediaItem>) {
              if (query == final) { got.set(items.toList()); done.countDown() }
            }
            override fun onError(query: String, extras: Bundle?) { if (query == final) { error.set("onError"); got.set(emptyList()); done.countDown() } }
          })
        }
        if (q != final) Thread.sleep(900)
      }
      assertTrue("car search answered", done.await(40, TimeUnit.SECONDS))
      val tookMs = System.currentTimeMillis() - askedAt
      val items = got.get()
      val rows = items.map { "${it.mediaId} | ${it.description.title} | ${it.description.subtitle} | playable=${it.isPlayable}" }
      Log.i("AirwaveCarCatalogCold", "all query=$final took=${tookMs}ms error=${error.get()} rows=${rows.take(40)}")
      assertNull("answered, not timed out (${tookMs} ms)", error.get())
      assertTrue("answered within the car deadline: $tookMs ms", tookMs <= 24_000)
      val songs = items.filter { it.isPlayable }
      assertTrue("cold All search returned songs: $rows", songs.isNotEmpty())
      assertTrue("every song is a real catalogue row: $rows", songs.all { s -> s.description.title?.isNotBlank() == true && MediaHub.findSong(s.mediaId!!) != null })
      // The found music leads the page: albums (browsable, never playable) then songs.
      val firstSong = items.indexOfFirst { it.isPlayable }
      assertTrue("only albums before the first song: $rows", items.take(firstSong).all { it.mediaId!!.startsWith("calbum/") && it.isBrowsable && !it.isPlayable })
      // The type choice stays available as exactly one browsable row, after the results.
      assertTrue("no type tile ahead of the results: $rows", items.none { it.mediaId!!.startsWith("sfilter/") || it.mediaId == "identify" })
      val chooser = items.last()
      assertTrue("the last row is the type chooser: $rows", chooser.mediaId!!.startsWith("schoose/all/") && chooser.isBrowsable && !chooser.isPlayable)
      assertEquals("one chooser row", 1, items.count { it.mediaId!!.startsWith("schoose/") })
      assertNoPreviewLengths(songs)
      assertFalse("still no Activity command sink after the search", MediaHub.hasPage())
      assertTrue("still no phone Activity after the search: ${liveActivities()}", liveActivities().isEmpty())
    } finally {
      instr.runOnMainSync { browser?.disconnect() }
    }
  }
}
