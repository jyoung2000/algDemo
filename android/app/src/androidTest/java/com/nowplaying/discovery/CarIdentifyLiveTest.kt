package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.media3.session.legacy.MediaBrowserCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * CAR-SEARCH-TYPES-001, live: the car's Identify through the REAL phone page and the real Shazam
 * lookup, with a supplied clip standing in for the microphone (an emulator hears no music).
 * Opt-in: `-e liveIdentify 1`, with 16 kHz mono s16le PCM pushed to the app's external files dir as
 * `identify-clip.pcm`, and `-e expectTitle <title>`.
 */
@RunWith(AndroidJUnit4::class)
class CarIdentifyLiveTest {
  @Test fun theCarsIdentifyNamesARealRecording() {
    val args = InstrumentationRegistry.getArguments()
    assumeTrue("live network identify only on request", args.getString("liveIdentify") == "1")
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    val instr = InstrumentationRegistry.getInstrumentation()
    val clip = File(ctx.getExternalFilesDir(null), "identify-clip.pcm")
    assumeTrue("clip supplied", clip.exists())
    CarListener.fixture = clip.readBytes()
    var browser: MediaBrowserCompat? = null
    try {
      // The real page answers identify requests once it is open and has pushed its state.
      ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      val end = System.currentTimeMillis() + 45000
      while (!(MediaHub.hasPage() && MediaHub.pageAnswering) && System.currentTimeMillis() < end) Thread.sleep(250)
      assertTrue("the phone page is answering", MediaHub.hasPage() && MediaHub.pageAnswering)
      val connected = CountDownLatch(1)
      instr.runOnMainSync {
        browser = MediaBrowserCompat(ctx, ComponentName(ctx, PlaybackService::class.java), object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnected() { connected.countDown() }
        }, null).also { it.connect() }
      }
      assertTrue(connected.await(15, TimeUnit.SECONDS))
      val got = AtomicReference<List<MediaBrowserCompat.MediaItem>>()
      val done = CountDownLatch(1)
      instr.runOnMainSync {
        browser!!.subscribe("identify", Bundle(), object : MediaBrowserCompat.SubscriptionCallback() {
          override fun onChildrenLoaded(parentId: String?, children: MutableList<MediaBrowserCompat.MediaItem>?, options: Bundle?) { got.set(children.orEmpty().toList()); done.countDown() }
          override fun onChildrenLoaded(parentId: String?, children: MutableList<MediaBrowserCompat.MediaItem>?) { got.set(children.orEmpty().toList()); done.countDown() }
        })
      }
      assertTrue("identify answered", done.await(60, TimeUnit.SECONDS))
      val rows = got.get().map { "${it.description.title} | ${it.description.subtitle} | playable=${it.isPlayable}" }
      android.util.Log.i("AirwaveCarIdentify", "live result: $rows")
      val expect = args.getString("expectTitle")
      assertTrue("named $expect: $rows", got.get().any { it.isPlayable && it.description.title.toString().contains(expect ?: "", ignoreCase = true) })
    } finally {
      CarListener.fixture = null
      instr.runOnMainSync { browser?.disconnect() }
    }
  }

  /**
   * CAR-IDENTIFY-LIVE-001: the same, with NO phone page: the service's own catalogue engine fingerprints the
   * clip and asks the real lookup. The emulator's host-audio capture distorts sound (DHU 2026-11-16), so only
   * the microphone is replaced; real-mic matching is proven on a phone. Run this method on its own (the other
   * one opens the Activity).
   */
  @Test fun theCarsIdentifyNamesARealRecordingWithNoPhonePage() {
    val args = InstrumentationRegistry.getArguments()
    assumeTrue("live network identify only on request", args.getString("liveIdentify") == "1")
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    val instr = InstrumentationRegistry.getInstrumentation()
    val clip = File(ctx.getExternalFilesDir(null), "identify-clip.pcm")
    assumeTrue("clip supplied", clip.exists() && clip.length() >= 16000 * 2 * 4)
    assumeTrue("no phone page open", !MediaHub.hasPage())
    CarIdentifyReuse.reset()
    CarListener.fixture = clip.readBytes()
    var browser: MediaBrowserCompat? = null
    try {
      val connected = CountDownLatch(1)
      instr.runOnMainSync {
        browser = MediaBrowserCompat(ctx, ComponentName(ctx, PlaybackService::class.java), object : MediaBrowserCompat.ConnectionCallback() {
          override fun onConnected() { connected.countDown() }
        }, null).also { it.connect() }
      }
      assertTrue(connected.await(15, TimeUnit.SECONDS))
      val end = System.currentTimeMillis() + 45000
      while (!MediaHub.canIdentify() && System.currentTimeMillis() < end) Thread.sleep(250)
      assertTrue("the service's own engine can identify", MediaHub.canIdentify())
      assertFalse("still no phone page", MediaHub.hasPage())
      val got = AtomicReference<List<MediaBrowserCompat.MediaItem>>()
      val done = CountDownLatch(1)
      instr.runOnMainSync {
        browser!!.subscribe("identify", Bundle(), object : MediaBrowserCompat.SubscriptionCallback() {
          override fun onChildrenLoaded(parentId: String?, children: MutableList<MediaBrowserCompat.MediaItem>?, options: Bundle?) { got.set(children.orEmpty().toList()); done.countDown() }
          override fun onChildrenLoaded(parentId: String?, children: MutableList<MediaBrowserCompat.MediaItem>?) { got.set(children.orEmpty().toList()); done.countDown() }
        })
      }
      assertTrue("identify answered", done.await(60, TimeUnit.SECONDS))
      val rows = got.get().map { "${it.description.title} | ${it.description.subtitle} | playable=${it.isPlayable}" }
      android.util.Log.i("AirwaveCarIdentify", "live no-page result: $rows")
      val expect = args.getString("expectTitle")
      assertTrue("named $expect: $rows", got.get().any { it.isPlayable && it.description.title.toString().contains(expect ?: "", ignoreCase = true) })
    } finally {
      CarListener.fixture = null
      instr.runOnMainSync { browser?.disconnect() }
    }
  }
}
