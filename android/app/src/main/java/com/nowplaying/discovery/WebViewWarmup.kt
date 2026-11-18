package com.nowplaying.discovery

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.CookieManager

/** Main-thread order of the tasks that wait for the WebView provider (WEBVIEW-WARM-001). Pure, tested on the JVM. */
internal class WarmupQueue(private val post: (Runnable) -> Unit) {
  private val waiting = ArrayList<Runnable>()
  private var ready = false

  /** Runs [task] once the provider is loaded. Always posted, never run inside the caller. */
  fun whenReady(task: Runnable) { if (ready) post(task) else waiting.add(task) }

  fun cancel(task: Runnable) { waiting.remove(task) }

  fun markReady() {
    if (ready) return
    ready = true
    val run = ArrayList(waiting)
    waiting.clear()
    run.forEach(post)
  }
}

/**
 * WEBVIEW-WARM-001: the first WebView of a process loads the whole WebView provider (its package, class
 * loader and native library) inside the constructor, on the main thread. On a phone that had just booted
 * that took 18 s: the window could not take focus and Android reported "ANR ... Input dispatching timed out"
 * (main thread in WebViewChromiumFactoryProvider.<init>, called from CatalogEngine.start).
 *
 * The provider is loaded here on a background thread instead. CookieManager.getInstance() is the
 * documented any-thread entry that creates it. Every WebView the app makes waits for that, so the main
 * thread stays free to draw and take input meanwhile. All methods are main-thread only.
 */
internal object WebViewWarmup {
  private const val TAG = "AirwaveWebViewWarm"
  private val main = Handler(Looper.getMainLooper())
  private val queue = WarmupQueue { main.post(it) }
  private var started = false

  fun whenReady(task: Runnable) {
    queue.whenReady(task)
    if (started) return
    started = true
    Thread({
      val t0 = SystemClock.elapsedRealtime()
      // A failure here is not fatal: the WebView constructor then loads the provider itself, as before.
      runCatching { CookieManager.getInstance() }.onFailure { Log.w(TAG, "provider warm-up failed", it) }
      Log.i(TAG, "WebView provider loaded off the main thread in ${SystemClock.elapsedRealtime() - t0} ms")
      main.post { queue.markReady() }
    }, "aw-webview-warm").start()
  }

  fun cancel(task: Runnable) {
    queue.cancel(task)
    main.removeCallbacks(task)
  }
}
