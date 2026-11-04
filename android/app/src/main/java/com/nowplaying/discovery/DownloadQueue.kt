package com.nowplaying.discovery

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
        if (if (lane) background >= 2 else foreground >= 1) break
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
