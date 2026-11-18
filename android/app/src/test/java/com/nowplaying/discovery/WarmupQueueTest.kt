package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * WEBVIEW-WARM-001: seen on a phone that had just booted. The first WebView of the process loads the
 * whole WebView provider on the main thread; that took 18 s and Android reported "ANR ... Input dispatching
 * timed out". The provider is now loaded on a background thread and every WebView waits here for it.
 */
class WarmupQueueTest {
  private val posted = ArrayDeque<Runnable>()
  private fun queue() = WarmupQueue { posted.addLast(it) }
  private fun drain() { while (posted.isNotEmpty()) posted.removeFirst().run() }

  @Test fun nothingRunsUntilTheProviderIsLoaded() {
    val q = queue(); var opened = 0
    q.whenReady { opened++ }
    drain()
    assertEquals("a WebView was made while the provider was still loading", 0, opened)
    q.markReady(); drain()
    assertEquals(1, opened)
  }

  @Test fun waitingTasksRunInTheOrderTheyAsked() {
    val q = queue(); val order = ArrayList<String>()
    q.whenReady { order += "service" }
    q.whenReady { order += "page" }
    q.markReady(); drain()
    assertEquals(listOf("service", "page"), order)
  }

  @Test fun aTaskAskedAfterTheProviderLoadedIsPostedNotRunInline() {
    val q = queue(); var opened = 0
    q.markReady(); drain()
    q.whenReady { opened++ }
    assertEquals("the caller's own method must return first", 0, opened)
    drain()
    assertEquals(1, opened)
  }

  @Test fun aCancelledTaskNeverRuns() {
    val q = queue(); var opened = 0
    val task = Runnable { opened++ }
    q.whenReady(task)
    q.cancel(task) // the Activity or service was destroyed while the provider loaded
    q.markReady(); drain()
    assertEquals(0, opened)
  }

  @Test fun readyIsAnnouncedOnce() {
    val q = queue(); var opened = 0
    q.whenReady { opened++ }
    q.markReady(); q.markReady(); drain()
    assertEquals(1, opened)
  }
}
