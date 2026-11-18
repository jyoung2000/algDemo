package com.nowplaying.discovery

/** Main-thread lifecycle decision for a service-owned engine started by a posted callback. */
internal class CatalogStartGate {
  private var queued = false
  private var started = false
  private var destroyed = false

  fun schedule(): Boolean {
    if (destroyed || queued || started) return false
    queued = true
    return true
  }

  fun runQueued(): Boolean {
    if (destroyed || !queued || started) return false
    queued = false
    started = true
    return true
  }

  fun destroy() {
    destroyed = true
    queued = false
  }
}
