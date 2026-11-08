package com.nowplaying.discovery.engine

import android.content.Context
import android.util.Log
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A debug-build check of what the app really plays: passes every write to [inner] (the speaker) and
 * also appends it to `files/audio-tap.f32` (interleaved stereo little-endian float32, 48 kHz).
 *
 * Only used when the build is debuggable AND `files/audio-tap.on` exists when the service starts
 * ([wrap]); otherwise the service gets the plain [TrackOutput]. [frames] lets logs mark where in the
 * recording a setting arrived or a blend began.
 */
class TapOutput private constructor(private val inner: AudioOutput, file: File) : AudioOutput by inner {
  private val out = BufferedOutputStream(FileOutputStream(file, false), 1 shl 16)
  private var bytes = ByteBuffer.allocate(0).order(ByteOrder.LITTLE_ENDIAN)

  override fun write(interleaved: FloatArray, frames: Int): Int {
    val n = inner.write(interleaved, frames)
    if (n > 0) {
      if (bytes.capacity() < n * 8) bytes = ByteBuffer.allocate(n * 8).order(ByteOrder.LITTLE_ENDIAN)
      bytes.clear()
      bytes.asFloatBuffer().put(interleaved, 0, n * 2)
      synchronized(this) { out.write(bytes.array(), 0, n * 8) }
      Companion.frames += n
    }
    return n
  }

  override fun close() {
    synchronized(this) { runCatching { out.close() } }
    inner.close()
  }

  companion object {
    /** Frames recorded so far, or 0 when no tap is running. */
    @Volatile var frames = 0L
      private set

    fun wrap(context: Context, debuggable: Boolean, inner: AudioOutput): AudioOutput {
      if (!debuggable || !File(context.filesDir, "audio-tap.on").exists()) return inner
      frames = 0
      Log.i("AirwaveTap", "recording what the app plays to files/audio-tap.f32")
      return TapOutput(inner, File(context.filesDir, "audio-tap.f32"))
    }
  }
}
