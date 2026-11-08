package com.nowplaying.discovery.engine

import com.nowplaying.discovery.dsp.EqConfig
import com.nowplaying.discovery.dsp.MixBus
import com.nowplaying.discovery.dsp.TransitionStyle
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.max
import kotlin.math.min

/** The part of crossfade.ts `mixPlan` the engine acts on. */
data class BlendPlan(val seconds: Double, val startAt: Double, val style: TransitionStyle)

/** crossfade.ts `mixPlan(slider, outSeconds, inSeconds, { minPlayedFraction })`, called without tempos as the app does. */
fun interface BlendPlanner {
  fun plan(slider: Int, outSeconds: Double, inSeconds: Double, minPlayedFraction: Double): BlendPlan
}

/**
 * The service-owned playback engine: two decks into the parity-tested [MixBus], one [AudioOutput].
 *
 * Behaviour is ported from the app so the phone, the lock screen and the car hear the same thing:
 * - blend scheduling from web/src/engine/preview-mixer.ts `PreviewMixer` (`prepare`, `tick`, `cancel`,
 *   `finish`): the next song waits silent on the spare deck; once the outgoing song's position reaches
 *   the plan's `startAt` (MIXER-PLAY-THROUGH-001/-002: 95% by default) the spare is made inaudible,
 *   started from 0, and `transitionTo(spare, remaining, style)` runs; when the outgoing song ends the
 *   spare is promoted WITHOUT restarting it.
 * - end-of-song handling from web/src/Player.tsx `onEnded`: repeat-one replays the song and cancels
 *   any blend (a repeated song is not a next song); otherwise a blend is promoted, or the controller
 *   is told the song ended so it can load the next one.
 *
 * Threading: every public method only enqueues a command. Commands run on the engine thread between
 * quanta, so [MixBus] (not thread-safe, like an AudioContext's graph) is only ever touched by one
 * thread. [Listener] callbacks also run on the engine thread; hop to your own looper.
 * [renderQuanta] drives the same loop synchronously for tests.
 */
class AudioEngine(
  private val output: AudioOutput,
  private val planner: BlendPlanner,
  private val listener: Listener = object : Listener {},
  initialEq: EqConfig = EqConfig.DEFAULTS,
) : AutoCloseable {
  /**
   * How much of a song was actually heard: frames rendered from it while audible (a seek does not
   * count the skipped part), out of its length. The page's listen telemetry, and so the taste it
   * learns, is built from this when it was not awake to measure the song itself.
   */
  data class Heard(val key: String, val heardFrames: Long, val durationFrames: Long)

  interface Listener {
    /** The active song reached its end and nothing was blended in: the controller decides what's next. */
    fun onEnded(key: String, heard: Heard) {}
    /** A blend completed: [key] (already playing for the length of the blend) is now the current song. */
    fun onAdvanced(key: String, outgoing: Heard) {}
    /** Repeat-one restarted [key]. */
    fun onRepeated(key: String, heard: Heard) {}
    /** A blend into [key] started, [seconds] long. */
    fun onBlendStarted(key: String, seconds: Double, style: TransitionStyle) {}
    fun onError(key: String, error: Throwable) {}
  }

  /** What the session reads. Positions are in engine frames (48 kHz). */
  data class Snapshot(
    val key: String?,
    val playing: Boolean,
    val buffering: Boolean,
    val positionFrames: Long,
    val durationFrames: Long,
    val blendingInto: String?,
  )

  private class Deck(val id: String) {
    var key: String? = null
    var source: PcmSource? = null
    /** Frames of [source] rendered while it was audible, for [Heard]. */
    var heard = 0L
    val left = FloatArray(QUANTUM)
    val right = FloatArray(QUANTUM)
    val planar = arrayOf(left, right)
  }

  private enum class NextState { NONE, READY, RUNNING, FAILED }

  val bus = MixBus(initialEq = initialEq)
  private val decks = mapOf("a" to Deck("a"), "b" to Deck("b"))
  private var active = "a"
  private val other: String get() = if (active == "a") "b" else "a"
  private var playing = false
  private var mix = 0
  private var playThrough = 95
  private var repeatOne = false
  private var next = NextState.NONE
  private var endedReported: String? = null

  private val commands = ConcurrentLinkedQueue<() -> Unit>()
  private val lock = Object()
  @Volatile private var closed = false
  @Volatile private var thread: Thread? = null
  @Volatile var snapshot: Snapshot = Snapshot(null, false, false, 0, PcmSource.UNKNOWN, null)
    private set

  private val out = arrayOf(FloatArray(QUANTUM * CHUNK_QUANTA), FloatArray(QUANTUM * CHUNK_QUANTA))
  private val quantumOut = arrayOf(FloatArray(QUANTUM), FloatArray(QUANTUM))
  private val interleaved = FloatArray(QUANTUM * CHUNK_QUANTA * 2)

  init {
    // Both decks exist for the engine's lifetime, as both <audio> elements do in the app: `a` is live
    // at gain 1, `b` waits at gain 0 (audio-bus.ts attach).
    bus.attach(bus.createSource(), "a")
    bus.attach(bus.createSource(), "b")
  }

  /* -------------------------------------------------------------- commands (any thread) */

  /** Make [source] the current song and (re)start from [startFrame]. Cancels any blend. */
  fun load(key: String, source: PcmSource, startFrame: Long = 0, play: Boolean = true) = post {
    cancelBlend()
    val deck = decks.getValue(active)
    deck.source?.takeIf { it !== source }?.close()
    deck.key = key
    deck.source = source
    deck.heard = 0
    source.seekTo(startFrame)
    endedReported = null
    output.flush()
    playing = play
    if (play) output.play() else output.pause()
  }

  /**
   * The song after the current one, for the blend (preview-mixer.ts `prepare`). A source is handed
   * over only when its audio is local; `null` means nothing to blend into, which is a normal handoff.
   * Re-offering the same key keeps the prepared deck.
   */
  fun setNext(key: String?, source: PcmSource?) = post {
    val spare = decks.getValue(other)
    if (key != null && key == spare.key && source === spare.source) return@post
    cancelBlend()
    if (key == null || source == null) return@post
    spare.key = key
    spare.source = source
    spare.heard = 0
    next = NextState.READY
  }

  fun play() = post { if (decks.getValue(active).source != null) { playing = true; output.play() } }
  fun pause() = post { playing = false; output.pause() }

  /**
   * Jump within the current song. A blend in progress is abandoned (the listener chose a place), but
   * the song lined up next stays lined up and blends in when this one next reaches its play-through
   * point — preview-mixer.ts keeps its candidate across a seek too. Dropping it here was why a song
   * seeked with the progress bar never blended (the player does not offer the same song twice).
   */
  fun seekTo(frame: Long) = post {
    val src = decks.getValue(active).source ?: return@post
    // RUNNING: the blend restarts from the spare's start at the next play-through point (tick seeks
    // it to 0). FAILED (too little song was left): a seek can leave room for it again.
    if (next != NextState.NONE && decks.getValue(other).source != null) next = NextState.READY
    bus.cut(active)
    src.seekTo(frame)
    endedReported = null
    output.flush()
  }

  fun setEq(config: EqConfig) = post { bus.setEq(config) }
  /** The mixer slider, 0 (off) .. 100. Turning it off cancels a blend, as Player.tsx does. */
  fun setMix(slider: Int) = post { mix = slider.coerceIn(0, 100); if (mix == 0) cancelBlend() }
  /** "Play before blending", percent (MIXER-PLAY-THROUGH-002), 50..100. */
  fun setPlayThrough(percent: Int) = post { playThrough = percent.coerceIn(50, 100) }
  fun setRepeatOne(on: Boolean) = post { repeatOne = on; if (on) cancelBlend() }
  fun setVolume(v: Double) = post { bus.setMasterGain(v) }

  /** Run the engine on its own thread, paced by the output. */
  fun start() {
    if (thread != null) return
    thread = Thread({ loop() }, "AirwaveAudioEngine").apply {
      priority = Thread.MAX_PRIORITY
      start()
    }
  }

  override fun close() {
    closed = true
    synchronized(lock) { lock.notifyAll() }
    thread?.join(2000)
    thread = null
    decks.values.forEach { it.source?.close(); it.source = null }
    output.close()
  }

  /* -------------------------------------------------------------- engine thread */

  private fun post(cmd: () -> Unit) {
    commands.add(cmd)
    synchronized(lock) { lock.notifyAll() }
  }

  private fun drain() {
    while (true) commands.poll()?.invoke() ?: break
  }

  private fun loop() {
    while (!closed) {
      drain()
      if (!playing) {
        publish()
        synchronized(lock) { if (commands.isEmpty() && !closed) lock.wait(250) }
        continue
      }
      renderChunk(CHUNK_QUANTA)
    }
  }

  /** Tests: run pending commands and render [quanta] quanta synchronously (nothing renders while paused). */
  fun renderQuanta(quanta: Int) {
    var left = quanta
    while (left > 0) {
      drain()
      if (!playing) { publish(); return }
      val n = min(left, CHUNK_QUANTA)
      renderChunk(n)
      left -= n
    }
    drain()
    publish()
  }

  private fun renderChunk(quanta: Int) {
    var frames = 0
    for (q in 0 until quanta) {
      if (!playing) break
      renderQuantum(q * QUANTUM)
      frames += QUANTUM
    }
    if (frames == 0) return
    for (i in 0 until frames) {
      interleaved[2 * i] = out[0][i]
      interleaved[2 * i + 1] = out[1][i]
    }
    output.write(interleaved, frames)
    publish()
  }

  private fun renderQuantum(offset: Int) {
    tick()
    val live = decks.getValue(active)
    val spare = decks.getValue(other)
    val liveRead = fill(live)
    live.heard += liveRead
    if (next == NextState.RUNNING) spare.heard += fill(spare) else silence(spare)
    // MixBus.process reads its inputs AND writes its output at the same offset, and the deck buffers
    // are one quantum long, so render at 0 into a quantum-sized scratch and place it in the chunk.
    bus.process(decks.getValue("a").planar, decks.getValue("b").planar, quantumOut, 0)
    System.arraycopy(quantumOut[0], 0, out[0], offset, QUANTUM)
    System.arraycopy(quantumOut[1], 0, out[1], offset, QUANTUM)
    val src = live.source
    if (src != null && src.ended && liveRead < QUANTUM) onLiveEnded(live)
    src?.error?.let { e -> live.key?.let { k -> listener.onError(k, e) }; playing = false; output.pause() }
  }

  /** Read one quantum from a deck's source into its buffers, zero-filling a shortfall. */
  private fun fill(deck: Deck): Int {
    val src = deck.source
    val n = if (src == null || src.error != null) 0 else src.read(deck.planar, 0, QUANTUM)
    if (n < QUANTUM) {
      deck.left.fill(0f, n, QUANTUM)
      deck.right.fill(0f, n, QUANTUM)
    }
    return n
  }

  private fun silence(deck: Deck) {
    deck.left.fill(0f)
    deck.right.fill(0f)
  }

  /** preview-mixer.ts `tick`: start the blend once the outgoing song has played its share. */
  private fun tick() {
    if (mix <= 0 || next != NextState.READY || repeatOne) return
    val live = decks.getValue(active).source ?: return
    val incoming = decks.getValue(other).source ?: return
    if (live.ended || !live.ready || !incoming.ready || incoming.error != null) return
    val outSeconds = seconds(live.durationFrames)
    val inSeconds = seconds(incoming.durationFrames)
    val plan = planner.plan(mix, outSeconds, inSeconds, playThrough / 100.0)
    val at = live.positionFrames / RATE
    if (plan.seconds <= 0 || at < plan.startAt) return
    // The spare must be inaudible before it starts — never start at full volume then fade it down.
    bus.cut(active)
    incoming.seekTo(0)
    val remaining = min(plan.seconds, outSeconds - at)
    if (remaining < MIN_USEFUL_SECONDS) {
      next = NextState.FAILED
      return
    }
    bus.transitionTo(other, remaining, plan.style)
    next = NextState.RUNNING
    decks.getValue(other).key?.let { listener.onBlendStarted(it, remaining, plan.style) }
  }

  /** Player.tsx `onEnded` + preview-mixer.ts `finish`. */
  private fun onLiveEnded(live: Deck) {
    val key = live.key ?: return
    if (repeatOne) {
      cancelBlend()
      val heard = heardOf(live)
      live.source?.seekTo(0)
      live.heard = 0
      listener.onRepeated(key, heard)
      return
    }
    val spare = decks.getValue(other)
    val incoming = spare.source
    if (next == NextState.RUNNING && incoming != null && !incoming.ended && incoming.error == null) {
      // Promote: the incoming song keeps its playhead; the old deck is emptied.
      val outgoing = heardOf(live)
      live.source?.close()
      live.source = null
      live.key = null
      active = spare.id
      next = NextState.NONE
      bus.cut(active)
      endedReported = null
      spare.key?.let { listener.onAdvanced(it, outgoing) }
      return
    }
    if (endedReported == key) return
    endedReported = key
    cancelBlend()
    playing = false
    output.pause()
    listener.onEnded(key, heardOf(live))
  }

  private fun heardOf(deck: Deck) = Heard(deck.key ?: "", deck.heard, deck.source?.durationFrames ?: PcmSource.UNKNOWN)

  /** preview-mixer.ts `cancel`: forget the spare and put all the level back on the live deck. */
  private fun cancelBlend() {
    val spare = decks.getValue(other)
    if (next != NextState.NONE || spare.source != null) {
      spare.source?.close()
      spare.source = null
      spare.key = null
    }
    next = NextState.NONE
    bus.cut(active)
  }

  private fun publish() {
    val live = decks.getValue(active)
    val src = live.source
    val pending = output.pendingFrames()
    snapshot = Snapshot(
      key = live.key,
      playing = playing,
      buffering = playing && src != null && !src.ready && !src.ended,
      positionFrames = max(0L, (src?.positionFrames ?: 0L) - pending),
      durationFrames = src?.durationFrames ?: PcmSource.UNKNOWN,
      blendingInto = if (next == NextState.RUNNING) decks.getValue(other).key else null,
    )
  }

  private fun seconds(frames: Long): Double = if (frames > 0) frames / RATE else Double.NaN

  companion object {
    const val QUANTUM = 128
    /** Quanta rendered per output write: 1024 frames, about 21 ms. */
    const val CHUNK_QUANTA = 8
    const val RATE = 48000.0
    /** crossfade.ts MIN_USEFUL_SECONDS. */
    const val MIN_USEFUL_SECONDS = 0.25
  }
}
