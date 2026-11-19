package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import android.media.browse.MediaBrowser
import android.media.session.MediaController as PlatformController
import android.media.session.PlaybackState
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.sin

/**
 * The platform MediaBrowser/MediaController is the legacy surface a car host consumes, not merely
 * a modern Media3 controller. Optional DHU hold uses clearly labelled, generated local PCM tones;
 * these are test fixtures, not catalogue recordings or provider/download success evidence.
 */
@RunWith(AndroidJUnit4::class)
class CarLegacyControlsTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private fun <T> main(block: () -> T): T {
    val r=AtomicReference<T>();instr.runOnMainSync {r.set(block())};return r.get()
  }
  private fun until(what:String,timeout:Long=10000,condition:()->Boolean) {
    val end=System.currentTimeMillis()+timeout
    while(System.currentTimeMillis()<end){if(condition())return;Thread.sleep(50)}
    throw AssertionError("Timeout: $what")
  }
  private fun fixtureSongs(): JSONArray = JSONArray().apply {
    for(i in 1..3)put(JSONObject().put("id","car-tone-$i").put("title","Transport test tone $i")
      .put("artist","Airwave diagnostic fixture").put("album","Car transport test (not catalogue music)")
      .put("durationMs",120000).put("ready",true).put("source",link(i)))
  }
  private fun link(i:Int)="https://music.youtube.com/watch?v=carqatone00$i"
  private fun seed() {
    val songs=fixtureSongs()
    MediaHub.apply(JSONObject().put("state",JSONObject().put("queue",songs)).put("library",JSONObject()
      .put("songs",songs).put("playlists",JSONArray().put(JSONObject().put("id","car-qa").put("title","Transport test fixtures").put("songs",songs)))))
  }
  private fun resetServiceQueue() {
    // A prior instrumentation class can leave the service player's timeline populated.
    // CarQueue plans a single car tap against that timeline, so clear it before this test
    // checks expansion from MediaHub's three-song fixture rather than inherited items.
    val future = main { MediaController.Builder(ctx, SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))).buildAsync() }
    val modern = future.get(15, TimeUnit.SECONDS)
    try {
      main { modern.stop(); modern.clearMediaItems() }
      until("service timeline cleared") { main { modern.mediaItemCount == 0 } }
    } finally { main { modern.release() } }
  }
  @Test fun platformMusicSessionOffersTrackSkipAndPlayPauseNotTimedJumps() {
    for(i in 1..3)storeTone(i)
    resetServiceQueue()
    main {seed()}
    val ready=CountDownLatch(1)
    var browser:MediaBrowser?=null
    var controller:PlatformController?=null
    main {
      browser=MediaBrowser(ctx,ComponentName(ctx,PlaybackService::class.java),object:MediaBrowser.ConnectionCallback(){
        override fun onConnected(){controller=PlatformController(ctx,browser!!.sessionToken);ready.countDown()}
        override fun onConnectionFailed(){ready.countDown()}
      },null)
      browser!!.connect()
    }
    try{
      assertTrue(ready.await(15,TimeUnit.SECONDS));assertNotNull("legacy media browser connected",controller)
      main {controller!!.transportControls.playFromMediaId("car-tone-2",null)}
      until("legacy metadata"){main {controller!!.metadata?.getString("android.media.metadata.TITLE")=="Transport test tone 2"}}
      val actions=main {controller!!.playbackState?.actions?:0L}
      assertTrue("previous track action offered",actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS!=0L)
      assertTrue("next track action offered",actions and PlaybackState.ACTION_SKIP_TO_NEXT!=0L)
      assertTrue("play/pause action offered",actions and PlaybackState.ACTION_PLAY_PAUSE!=0L)
      assertEquals("no timed fast-forward",0L,actions and PlaybackState.ACTION_FAST_FORWARD)
      assertEquals("no timed rewind",0L,actions and PlaybackState.ACTION_REWIND)
      assertEquals("whole queue visible to legacy host",3,main {controller!!.queue?.size?:0})
    }finally{main {controller?.transportControls?.stop();browser?.disconnect()}}
  }
  private fun storeTone(i:Int) {
    val rate=24000;val frames=rate*120;val pcm=ByteBuffer.allocate(frames*2).order(ByteOrder.LITTLE_ENDIAN)
    for(f in 0 until frames)pcm.putShort((0.12*sin(2*PI*(330.0+i*110)/rate*f)*32767).toInt().toShort())
    val name=MessageDigest.getInstance("SHA-256").digest(link(i).toByteArray()).joinToString(""){"%02x".format(it)}+".wav"
    val file=File(File(ctx.filesDir,"audio-cache").apply{mkdirs()},name)
    RandomAccessFile(file,"rw").use {out->
      out.setLength(0);val h=ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      h.put("RIFF".toByteArray()).putInt(36+pcm.capacity()).put("WAVEfmt ".toByteArray()).putInt(16)
        .putShort(1).putShort(1).putInt(rate).putInt(rate*2).putShort(2).putShort(16).put("data".toByteArray()).putInt(pcm.capacity())
      out.write(h.array());out.write(pcm.array())
    }
    ctx.getSharedPreferences("airwave-private-audio",Context.MODE_PRIVATE).edit().putString(link(i),name).commit()
  }
  @Test fun holdsLocalTransportFixturesForTheActualHeadUnit() {
    assumeTrue("interactive DHU-only fixture",InstrumentationRegistry.getArguments().getString("holdProjection")=="1")
    for(i in 1..3)storeTone(i)
    main {seed()}
    var controller:MediaController?=null
    val ready=CountDownLatch(1)
    main {
      val f=MediaController.Builder(ctx,SessionToken(ctx,ComponentName(ctx,PlaybackService::class.java))).buildAsync()
      f.addListener({controller=f.get();ready.countDown()},Runnable::run)
    }
    assertTrue(ready.await(15,TimeUnit.SECONDS))
    try{
      main {controller!!.setMediaItems((1..3).map{MediaItem.Builder().setMediaId("car-tone-$it").build()},0,0);controller!!.prepare();controller!!.play()}
      until("real local PCM playing"){main {controller!!.isPlaying}}
      android.util.Log.i("CarProjectionQA","READY current=${main{controller!!.currentMediaItem?.mediaId}} count=${main{controller!!.mediaItemCount}}")
      val hold=InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull()?.coerceIn(10000,600000)?:300000L
      val end=System.currentTimeMillis()+hold
      while(System.currentTimeMillis()<end){
        android.util.Log.i("CarProjectionQA","current=${main{controller!!.currentMediaItem?.mediaId}} position=${main{controller!!.currentPosition}} playing=${main{controller!!.isPlaying}}")
        Thread.sleep(1000)
      }
    }finally{main {controller?.pause();controller?.release()}}
  }
}
