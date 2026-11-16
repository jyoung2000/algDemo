package com.nowplaying.discovery

import android.os.Handler
import android.os.Looper

/**
 * NATIVE-CLOCK-001. Finite one-shot delays for the page. A hidden WebView suspends its DOM timers, so
 * metadata pacing and backoff wait here instead and are resumed through window.__awDelay(id). A wait is
 * never shortened: out-of-range, duplicate or excess requests are refused and the page falls back to its
 * own full wait. Owned by one [MainActivity.Bridge]; [dispose] drops every job when the page goes.
 */
class NativeClock(private val scheduler: Scheduler, private val maxPending: Int = MAX_PENDING) {
  interface Scheduler {
    fun post(job: Runnable, delayMs: Long)
    fun remove(job: Runnable)
  }

  private val jobs = HashMap<Int, Runnable>()
  private var disposed = false

  val pending: Int @Synchronized get() = jobs.size

  /** Calls [fire] once with [id], no sooner than [delayMs]. False when refused. */
  @Synchronized
  fun schedule(id: Int, delayMs: Long, fire: (Int) -> Unit): Boolean {
    if (disposed || id <= 0 || delayMs < 0 || delayMs > MAX_DELAY_MS) return false
    if (jobs.containsKey(id) || jobs.size >= maxPending) return false
    lateinit var job: Runnable
    job = Runnable {
      val live = synchronized(this) { if (!disposed && jobs[id] === job) { jobs.remove(id); true } else false }
      if (live) fire(id)
    }
    jobs[id] = job
    scheduler.post(job, delayMs)
    return true
  }

  @Synchronized
  fun cancel(id: Int) {
    jobs.remove(id)?.let(scheduler::remove)
  }

  @Synchronized
  fun dispose() {
    disposed = true
    jobs.values.forEach(scheduler::remove)
    jobs.clear()
  }

  companion object {
    const val MAX_DELAY_MS = 120_000L
    const val MAX_PENDING = 256

    /** Main-looper delays: Handler.postDelayed counts uptime, so a wait can run late but never early. */
    fun mainLooper(): Scheduler = object : Scheduler {
      private val handler = Handler(Looper.getMainLooper())
      override fun post(job: Runnable, delayMs: Long) { handler.postDelayed(job, delayMs) }
      override fun remove(job: Runnable) { handler.removeCallbacks(job) }
    }
  }
}
