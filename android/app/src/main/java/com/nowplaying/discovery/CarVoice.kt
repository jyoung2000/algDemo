package com.nowplaying.discovery

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * CAR-QUICK-SEARCH-001 (owner, 2026-11-22): "On android auto the search icon should bring up the quick search tab where
 * the user can select the search filter like song name, artist, album, lyric, shazam reverse search before voice
 * searching".
 *
 * Android Auto draws the search button and its voice/keyboard screen itself; a media app cannot change what that button
 * opens. So the Search tab is the quick search: tapping a kind (All, Artists, Singles, Albums, Features, Lyrics) beeps
 * and listens for the words straight away with Android's speech recognizer, then lists only that kind; Identify listens
 * to the music instead. The magnifier still works and still uses the last kind tapped.
 */
object CarVoice {
  /** The recognizer stops by itself after a pause; this bounds a recognizer that never answers. */
  const val LISTEN_MAX_MS = 12_000L

  sealed class Outcome {
    class Heard(val words: String) : Outcome()
    object NoPermission : Outcome()
    /** No speech recognizer on this phone: the driver is sent to the search button instead. */
    object Unavailable : Outcome()
    object NothingHeard : Outcome()
    class Failed(val why: String) : Outcome()
  }

  /** For tests: what the recognizer "heard", answered without the microphone. */
  @Volatile var fixture: Outcome? = null

  /** Listens once and calls [done] on the main thread exactly once. Call on the main thread. */
  fun listen(ctx: Context, done: (Outcome) -> Unit) {
    val main = Handler(Looper.getMainLooper())
    fixture?.let { f -> main.post { done(f) }; return }
    if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { main.post { done(Outcome.NoPermission) }; return }
    val recognizer = try {
      when {
        SpeechRecognizer.isRecognitionAvailable(ctx) -> SpeechRecognizer.createSpeechRecognizer(ctx)
        Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx) -> SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
        else -> null
      }
    } catch (e: Exception) { null }
    if (recognizer == null) { main.post { done(Outcome.Unavailable) }; return }
    var finished = false
    val finish = { o: Outcome ->
      if (!finished) {
        finished = true
        try { recognizer.destroy() } catch (_: Exception) {}
        done(o)
      }
    }
    val guard = Runnable { try { recognizer.cancel() } catch (_: Exception) {}; finish(Outcome.NothingHeard) }
    recognizer.setRecognitionListener(object : RecognitionListener {
      override fun onResults(results: Bundle?) {
        main.removeCallbacks(guard)
        val words = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull { it.isNotBlank() }?.trim()
        finish(if (words.isNullOrBlank()) Outcome.NothingHeard else Outcome.Heard(words.take(200)))
      }
      override fun onError(error: Int) {
        main.removeCallbacks(guard)
        finish(outcomeOf(error))
      }
      override fun onReadyForSpeech(params: Bundle?) {}
      override fun onBeginningOfSpeech() {}
      override fun onRmsChanged(rmsdB: Float) {}
      override fun onBufferReceived(buffer: ByteArray?) {}
      override fun onEndOfSpeech() {}
      override fun onPartialResults(partialResults: Bundle?) {}
      override fun onEvent(eventType: Int, params: Bundle?) {}
    })
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
      .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
    beep()
    main.postDelayed(guard, LISTEN_MAX_MS)
    try { recognizer.startListening(intent) } catch (e: Exception) { main.removeCallbacks(guard); finish(Outcome.Failed(e.message ?: "The speech recognizer did not start")) }
  }

  /** What a recognizer error means for the driver. Plain, so it is unit tested on the JVM. */
  fun outcomeOf(error: Int): Outcome = when (error) {
    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> Outcome.NothingHeard
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> Outcome.NoPermission
    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> Outcome.Failed("No connection for voice search")
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> Outcome.Failed("Voice search is busy; try again in a moment")
    SpeechRecognizer.ERROR_AUDIO -> Outcome.Failed("The microphone could not be used")
    else -> Outcome.Failed("Voice search stopped (code $error)")
  }

  /** A short beep through the car, so the driver knows when to speak. */
  private fun beep() {
    try {
      val t = ToneGenerator(AudioManager.STREAM_MUSIC, 70)
      t.startTone(ToneGenerator.TONE_PROP_BEEP, 150)
      Handler(Looper.getMainLooper()).postDelayed({ t.release() }, 400)
    } catch (_: Exception) {}
  }
}
