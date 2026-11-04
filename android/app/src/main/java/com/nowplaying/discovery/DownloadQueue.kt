package com.nowplaying.discovery

/** One slot is one yt-dlp process, so a phone takes fewer of them than a desktop. */
internal const val PARALLEL_MIN = 1
internal const val PARALLEL_MAX = 3
internal const val PARALLEL_DEFAULT = 1

/**
 * The cache-config `parallel` field: absent keeps the limit in force, anything that is not a whole
 * number in range is refused with a message instead of being quietly clamped to the nearest value.
 */
internal fun parsedParallel(raw: Any?, current: Int): Int {
  if (raw == null) return current
  val message = "parallel must be a whole number of background downloads between $PARALLEL_MIN and $PARALLEL_MAX."
  require(raw is Int) { message }
  require(raw in PARALLEL_MIN..PARALLEL_MAX) { message }
  return raw
}

/** Bounded process lanes. A running promotion keeps its original slot until it exits. */
internal class DownloadQueue(private val dispatch: (() -> Unit) -> Unit) {
  class Task(val key: String, background: Boolean, val action: () -> Unit) {
    @Volatile var background = background
    var dispatched = false
    @Volatile var cancelled = false
  }
  private val tasks = linkedMapOf<String, Task>()
  private var foreground = 0
  private var background = 0
  private var backgroundParallel = PARALLEL_DEFAULT

  @Synchronized fun parallel() = backgroundParallel

  /**
   * Lowering the limit never kills a download: the extra processes finish in their own time and no
   * new one starts until the running count is back under the limit. Raising it starts queued songs
   * at once rather than waiting for a current download to end.
   */
  @Synchronized fun setParallel(value: Int) {
    require(value in PARALLEL_MIN..PARALLEL_MAX) { "parallel must be a whole number of background downloads between $PARALLEL_MIN and $PARALLEL_MAX." }
    backgroundParallel = value
    pump()
  }

  @Synchronized fun submit(key: String, background: Boolean, action: () -> Unit): Task {
    tasks[key]?.let {
      if (!background) it.background = false
      pump()
      return it
    }
    val task = Task(key, background, action)
    tasks[key] = task
    pump()
    return task
  }

  @Synchronized fun cancel(task: Task) {
    task.cancelled = true
    if (!task.dispatched) tasks.remove(task.key)
    pump()
  }

  private fun pump() {
    for (lane in listOf(false, true)) {
      for (task in tasks.values.toList()) {
        // The limit is read per candidate, so a change mid-flight takes effect on this same pass.
        if (if (lane) background >= backgroundParallel else foreground >= 1) break
        if (task.dispatched || task.cancelled || task.background != lane) continue
        task.dispatched = true
        if (lane) background++ else foreground++
        dispatch {
          try {
            if (!task.cancelled) task.action()
          } finally {
            synchronized(this) {
              tasks.remove(task.key)
              if (lane) background-- else foreground--
              pump()
            }
          }
        }
      }
    }
  }
}
