package com.nowplaying.discovery

import org.junit.Assert.*
import org.junit.Test

class DownloadQueueTest {
  @Test fun separateLanesPromoteQueuedUrlAndDeduplicateRunningUrl() {
    val work = mutableListOf<() -> Unit>()
    val ran = mutableListOf<String>()
    val queue = DownloadQueue { work.add(it) }
    queue.submit("a", true) { ran.add("a") }
    queue.submit("b", true) { ran.add("b") }
    val c = queue.submit("c", true) { ran.add("c") }
    assertEquals(2, work.size)
    assertSame(c, queue.submit("c", false) { fail("duplicate c") })
    queue.submit("a", false) { fail("duplicate a") }
    queue.submit("d", false) { ran.add("d") }
    assertEquals(3, work.size)
    work[2]()
    assertEquals(listOf("c"), ran)
    assertEquals(4, work.size)
    work[0](); work[1](); work[3]()
    assertEquals(listOf("c", "a", "b", "d"), ran)
  }

  @Test fun concurrentSubmissionsDeduplicateAndForegroundDoesNotWaitForBackground() {
    val pool = java.util.concurrent.Executors.newFixedThreadPool(3)
    val callers = java.util.concurrent.Executors.newFixedThreadPool(8)
    val release = java.util.concurrent.CountDownLatch(1)
    val twoBackground = java.util.concurrent.CountDownLatch(2)
    val foreground = java.util.concurrent.CountDownLatch(1)
    val backgroundRunning = java.util.concurrent.atomic.AtomicInteger()
    val peak = java.util.concurrent.atomic.AtomicInteger()
    val queue = DownloadQueue { task -> pool.execute(task) }
    try {
      val submissions = (0 until 16).map {
        callers.submit<DownloadQueue.Task> {
          queue.submit("same", true) {
            val running = backgroundRunning.incrementAndGet()
            peak.accumulateAndGet(running, ::maxOf)
            twoBackground.countDown()
            release.await(5, java.util.concurrent.TimeUnit.SECONDS)
            backgroundRunning.decrementAndGet()
          }
        }
      }
      val same = submissions.map { it.get(5, java.util.concurrent.TimeUnit.SECONDS) }
      assertTrue(same.all { it === same.first() })
      queue.submit("second", true) {
        val running = backgroundRunning.incrementAndGet()
        peak.accumulateAndGet(running, ::maxOf)
        twoBackground.countDown()
        release.await(5, java.util.concurrent.TimeUnit.SECONDS)
        backgroundRunning.decrementAndGet()
      }
      val waiting = queue.submit("third", true) { fail("third background should stay queued") }
      assertTrue(twoBackground.await(5, java.util.concurrent.TimeUnit.SECONDS))
      queue.submit("play-now", false) { foreground.countDown() }
      assertTrue(foreground.await(5, java.util.concurrent.TimeUnit.SECONDS))
      assertEquals(2, peak.get())
      queue.cancel(waiting)
    } finally {
      release.countDown()
      callers.shutdownNow()
      pool.shutdown()
      assertTrue(pool.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS))
    }
  }

  @Test fun cancelledQueuedTaskNeverOccupiesALane() {
    val work = mutableListOf<() -> Unit>()
    val queue = DownloadQueue { work.add(it) }
    queue.submit("a", true) {}
    queue.submit("b", true) {}
    val cancelled = queue.submit("c", true) { fail("cancelled work ran") }
    queue.cancel(cancelled)
    queue.submit("d", true) {}
    work[0]()
    assertEquals(3, work.size)
    work[1](); work[2]()
  }
}
