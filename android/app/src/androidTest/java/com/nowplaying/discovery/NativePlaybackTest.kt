package com.nowplaying.discovery

import android.net.Uri
import androidx.media3.common.Player
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sin

/** A synthetic tone is a decoder smoke fixture, NOT a recovered queue song. */
@RunWith(AndroidJUnit4::class)
class NativePlaybackTest {
  private val ctx get() = ApplicationProvider.getApplicationContext<android.content.Context>()
  private val instr get() = InstrumentationRegistry.getInstrumentation()

  private fun tone(): File {
    val frames = 44100 * 4
    val dataSize = frames * 2
    val file = File(ctx.cacheDir, "native-player-test.wav")
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray()).putInt(36 + dataSize).put("WAVEfmt ".toByteArray())
      .putInt(16).putShort(1).putShort(1).putInt(44100).putInt(88200).putShort(2).putShort(16)
      .put("data".toByteArray()).putInt(dataSize)
    FileOutputStream(file).use { out ->
      out.write(header.array())
      val samples = ByteBuffer.allocate(dataSize).order(ByteOrder.LITTLE_ENDIAN)
      for (i in 0 until frames) samples.putShort((sin(2.0 * Math.PI * 440 * i / 44100) * 1000).toInt().toShort())
      out.write(samples.array())
    }
    return file
  }

  @Test fun fullLocalFileAdvancesAndSeeksFromServiceOwnedPlayer() {
    val file = tone()
    var native: NativePlayback? = null
    try {
      instr.runOnMainSync {
        val p = NativePlayback(ctx)
        native = p
        p.loadLocal(Uri.fromFile(file), "Decoder smoke tone", "Test")
        p.player.play()
      }
      Thread.sleep(1400)
      instr.runOnMainSync {
        val p = requireNotNull(native)
        assertEquals("tone should be decoded", Player.STATE_READY, p.player.playbackState)
        assertTrue("position should advance", p.player.currentPosition > 300)
        assertTrue("duration should be known", p.player.duration >= 3500)
        p.player.seekTo(1900)
        p.player.pause()
        assertFalse(p.player.isPlaying)
      }
      instr.runOnMainSync { assertTrue("seek should work", requireNotNull(native).player.currentPosition >= 1800) }
    } finally {
      native?.let { p -> instr.runOnMainSync { p.release() } }
      file.delete()
    }
  }

  @Test fun remoteUriIsNotAcceptedAsALocalFullSong() {
    var native: NativePlayback? = null
    try {
      instr.runOnMainSync {
        val p = NativePlayback(ctx)
        native = p
        val rejected = runCatching { p.loadLocal(Uri.parse("https://example.com/preview.mp3"), "Not local", "Test") }.isFailure
        assertTrue("remote links need a verified download first", rejected)
        val missing = runCatching { p.loadLocal(Uri.fromFile(File(ctx.cacheDir, "missing-full-song.wav")), "Missing", "Test") }.isFailure
        assertTrue("missing cache bytes cannot become playable", missing)
        assertEquals(0, p.player.mediaItemCount)
      }
    } finally {
      native?.let { p -> instr.runOnMainSync { p.release() } }
    }
  }
}
