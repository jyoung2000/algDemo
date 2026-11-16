package com.nowplaying.discovery

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import kotlin.math.sqrt

/**
 * CAR-SEARCH-TYPES-001: the car's Identify icon records the music playing near the phone, so the
 * page can fingerprint it as the phone's own mic search does. 16 kHz mono 16-bit, the rate the
 * fingerprint code reads.
 *
 * Android only lets an app hear the microphone while the person can see it is listening; when
 * Airwave is only behind the car's screen, Android may hand it silence instead. That is detected
 * (AudioRecordingConfiguration.isClientSilenced) and reported as [Outcome.Blocked], never sent on as
 * if it were a quiet room.
 */
object CarListener {
  const val SAMPLE_RATE = 16_000
  const val LISTEN_MS = 9_000L

  sealed class Outcome {
    class Heard(val pcm: ByteArray, val rms: Double) : Outcome()
    object NoPermission : Outcome()
    object Blocked : Outcome()
    object Silent : Outcome()
    class Failed(val why: String) : Outcome()
  }

  /** For tests: a clip to use instead of the microphone (16-bit LE mono PCM at [SAMPLE_RATE]). */
  @Volatile var fixture: ByteArray? = null

  /** Records for [ms] milliseconds on the calling (background) thread. */
  @SuppressLint("MissingPermission")
  fun listen(ctx: Context, ms: Long = LISTEN_MS): Outcome {
    fixture?.let { return Outcome.Heard(it, rms(it, it.size)) }
    if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return Outcome.NoPermission
    val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (min <= 0) return Outcome.Failed("This phone's microphone cannot record at 16 kHz")
    val rec = try {
      AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, SAMPLE_RATE))
    } catch (e: Exception) {
      return Outcome.Failed(e.message ?: "The microphone could not be opened")
    }
    try {
      if (rec.state != AudioRecord.STATE_INITIALIZED) return Outcome.Failed("The microphone is in use by another app")
      val total = (SAMPLE_RATE * ms / 1000).toInt() * 2
      val out = ByteArray(total)
      rec.startRecording()
      if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) return Outcome.Failed("The microphone did not start")
      var silenced = false
      var read = 0
      val end = SystemClock.elapsedRealtime() + ms + 3000
      while (read < total && SystemClock.elapsedRealtime() < end) {
        val n = rec.read(out, read, minOf(4096, total - read))
        if (n < 0) return Outcome.Failed("The microphone stopped (error $n)")
        read += n
        if (Build.VERSION.SDK_INT >= 29 && !silenced) silenced = rec.activeRecordingConfiguration?.isClientSilenced == true
      }
      android.util.Log.i("AirwaveCarIdentify", "recorded ${read / 2} samples silenced=$silenced")
      if (silenced) return Outcome.Blocked
      val level = rms(out, read)
      if (level < 1e-4) return Outcome.Silent
      return Outcome.Heard(if (read == total) out else out.copyOf(read), level)
    } finally {
      runCatching { rec.stop() }
      rec.release()
    }
  }

  fun rms(pcm: ByteArray, len: Int): Double {
    var sum = 0.0
    var n = 0
    var i = 0
    while (i + 1 < len) {
      val v = ((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xff)).toShort() / 32768.0
      sum += v * v
      n++
      i += 2
    }
    return if (n == 0) 0.0 else sqrt(sum / n)
  }
}
