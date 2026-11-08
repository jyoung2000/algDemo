package com.nowplaying.discovery

import org.junit.Assert.*
import org.junit.Test

class DownloadQueueTest {
  // The phone default is one background download; these lane tests ask for two explicitly.
  @Test fun separateLanesPromoteQueuedUrlAndDeduplicateRunningUrl() {
    val work = mutableListOf<() -> Unit>()
    val ran = mutableListOf<String>()
    val queue = DownloadQueue { work.add(it) }
    queue.setParallel(2)
    queue.submit("a", true) { ran.add("a") }
    queue.submit("b", true) { ran.add("b") }
    val c = queue.submit("c", true) { ran.add("c") }
    assertEquals(2, work.size)
    assertSame(c, queue.submit("c", false) { fail("duplicate c") })
    queue.submit("a", false) { fail("duplicate a") }
    queue.submit("d", false) { ran.add("d") }
    // Two foreground slots (DL-FAST-001): d starts beside the promoted c instead of after it.
    assertEquals(4, work.size)
    work[2]()
    assertEquals(listOf("c"), ran)
    work[0](); work[1](); work[3]()
    assertEquals(listOf("c", "a", "b", "d"), ran)
  }

  @Test fun aNewTapStartsAtOnceBesideTheSongTheListenerLeftAndTheNewestQueuedTapGoesFirst() {
    // DL-FAST-001: measured on the emulator, a tap waited 5.4 s for the previous song's download.
    val work = mutableListOf<() -> Unit>()
    val ran = mutableListOf<String>()
    val queue = DownloadQueue { work.add(it) }
    queue.submit("left", false) { ran.add("left") }
    queue.submit("tapped", false) { ran.add("tapped") }
    assertEquals("the second tap does not wait for the first", 2, work.size)
    queue.submit("older", false) { ran.add("older") }
    queue.submit("newest", false) { ran.add("newest") }
    assertEquals("only $FOREGROUND_SLOTS foreground downloads at once", 2, work.size)
    work[0]()
    assertEquals("a freed slot goes to the newest tap", 3, work.size)
    work[2]()
    assertEquals(listOf("left", "newest"), ran)
    work[1](); work[3]()
    assertEquals(listOf("left", "newest", "tapped", "older"), ran)
  }

  @Test fun theWorkerPoolHoldsEveryLaneAtOnceSoATapNeverWaitsForAThread() {
    assertEquals(PARALLEL_MAX + FOREGROUND_SLOTS, DOWNLOAD_THREADS)
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
      queue.setParallel(2)
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

  @Test fun raisingParallelStartsMoreQueuedWorkAtOnceWithoutWaitingForAFinish() {
    val work = mutableListOf<() -> Unit>()
    val queue = DownloadQueue { work.add(it) }
    for (key in listOf("a", "b", "c", "d")) queue.submit(key, true) {}
    assertEquals(1, work.size)
    queue.setParallel(3)
    assertEquals(3, work.size)
    work[0](); work[1](); work[2]()
    assertEquals(4, work.size)
    work[3]()
  }

  @Test fun loweringParallelKeepsRunningWorkAndStartsNothingNewUntilTheCountDrops() {
    val work = mutableListOf<() -> Unit>()
    val ran = mutableListOf<String>()
    val queue = DownloadQueue { work.add(it) }
    queue.setParallel(3)
    val tasks = listOf("a", "b", "c", "d").map { key -> queue.submit(key, true) { ran.add(key) } }
    assertEquals(3, work.size)
    queue.setParallel(1)
    assertEquals(3, work.size)
    assertTrue(tasks.none { it.cancelled })
    assertTrue(tasks.take(3).all { it.dispatched })
    work[0]()
    assertEquals(listOf("a"), ran)
    assertEquals(3, work.size)
    work[1]()
    assertEquals(3, work.size)
    work[2]()
    assertEquals(4, work.size)
    work[3]()
    assertEquals(listOf("a", "b", "c", "d"), ran)
  }

  @Test fun invalidParallelIsRejectedRatherThanClampedAndAnAbsentFieldKeepsTheCurrentLimit() {
    val queue = DownloadQueue { }
    assertEquals(1, queue.parallel())
    for (bad in listOf<Any>(0, 4, -1, 7, 2.5, 2.0, "2", true, 2L)) {
      assertThrows(bad.toString(), IllegalArgumentException::class.java) { parsedParallel(bad, 1) }
    }
    assertThrows(IllegalArgumentException::class.java) { queue.setParallel(0) }
    assertThrows(IllegalArgumentException::class.java) { queue.setParallel(4) }
    assertEquals(1, queue.parallel())
    assertEquals(3, parsedParallel(3, 1))
    assertEquals(2, parsedParallel(null, 2))
    assertEquals(3, parsedParallel(null, 3))
    queue.setParallel(3)
    queue.setParallel(parsedParallel(null, queue.parallel()))
    assertEquals(3, queue.parallel())
  }

  @Test fun theForegroundSlotRunsAlongsideAFullBackgroundSet() {
    val pool = java.util.concurrent.Executors.newFixedThreadPool(4)
    val release = java.util.concurrent.CountDownLatch(1)
    val threeBackground = java.util.concurrent.CountDownLatch(3)
    val foreground = java.util.concurrent.CountDownLatch(1)
    val queue = DownloadQueue { task -> pool.execute(task) }
    try {
      queue.setParallel(3)
      for (key in listOf("a", "b", "c")) queue.submit(key, true) {
        threeBackground.countDown()
        release.await(5, java.util.concurrent.TimeUnit.SECONDS)
      }
      val waiting = queue.submit("d", true) { fail("a fourth background download should stay queued") }
      assertTrue(threeBackground.await(5, java.util.concurrent.TimeUnit.SECONDS))
      queue.submit("play-now", false) { foreground.countDown() }
      assertTrue(foreground.await(5, java.util.concurrent.TimeUnit.SECONDS))
      queue.cancel(waiting)
    } finally {
      release.countDown()
      pool.shutdown()
      assertTrue(pool.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS))
    }
  }

  @Test fun cancelledQueuedTaskNeverOccupiesALane() {
    val work = mutableListOf<() -> Unit>()
    val queue = DownloadQueue { work.add(it) }
    queue.setParallel(2)
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
