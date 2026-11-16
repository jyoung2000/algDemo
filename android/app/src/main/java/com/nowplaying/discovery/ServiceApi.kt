package com.nowplaying.discovery

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject

/**
 * SERVICE-API-001: who holds the original database (`airwave-discovery` in IndexedDB) on Android.
 *
 * Exactly one page may open it: the playback service's own engine page (car.html, [CatalogEngine]),
 * or, only when that page never opened it, the UI page (index.html, MainActivity). The rule:
 *  - The Activity reserves the database for the service before its page loads ([reserveForService]);
 *    the service is started by the same Activity, so the UI page starts as the service's client.
 *  - The service page claims before it opens anything ([claimService]). Once claimed it counts as
 *    opened for as long as that page lives, failed or not: the UI never falls back then.
 *  - The UI may open the database itself ([claimUi]) only when the service page reported failing
 *    before it opened it, or never claimed within [reserveMs] of the reservation.
 *  - A service page that finds the UI holding the database is refused and runs metadata-only; it may
 *    claim again once the UI page is gone ([releaseUi] returns true then).
 * Pure and synchronized, so the rule is tested on the JVM; the time comes from the caller.
 */
class EngineOwner(private val reserveMs: Long) {
  enum class Holder { NONE, RESERVED, SERVICE, UI }

  var holder = Holder.NONE; private set
  /** The service page claimed the database and then failed to start its engine. */
  var serviceFailed = false; private set
  /** NONE was reached without the service page ever opening the database: the UI may open it. */
  private var localAllowed = false
  private var reservedAt = 0L

  @Synchronized fun reserveForService(now: Long) {
    lapse(now)
    if (holder == Holder.NONE && !localAllowed) { holder = Holder.RESERVED; reservedAt = now }
  }

  /** "service" (send every request to the service) or "local" (this page may open the database). */
  @Synchronized fun modeForUi(now: Long): String {
    lapse(now)
    return if (holder == Holder.UI || (holder == Holder.NONE && localAllowed)) MODE_LOCAL else MODE_SERVICE
  }

  @Synchronized fun claimService(): Boolean {
    if (holder == Holder.UI) return false
    holder = Holder.SERVICE
    serviceFailed = false
    localAllowed = false
    return true
  }

  /** The service page could not start its engine; [opened] says whether it had begun opening the database. */
  @Synchronized fun serviceFailed(opened: Boolean) {
    if (holder != Holder.SERVICE) return
    if (opened) serviceFailed = true else { holder = Holder.NONE; localAllowed = true }
  }

  /** The service page is gone (its WebView destroyed). It had claimed, so the UI keeps waiting for a new one. */
  @Synchronized fun releaseService() {
    if (holder == Holder.SERVICE) { holder = Holder.NONE; serviceFailed = false }
  }

  /** [page] identifies the UI page; a newer page (a recreated Activity) takes over an older one's hold. */
  @Synchronized fun claimUi(now: Long, page: Any): Boolean {
    lapse(now)
    if (holder == Holder.UI || (holder == Holder.NONE && localAllowed)) { holder = Holder.UI; uiPage = page; return true }
    return false
  }

  /** [page] is gone; true when it held the database, so a metadata-only service page may claim now. */
  @Synchronized fun releaseUi(page: Any): Boolean {
    if (holder != Holder.UI || uiPage !== page) return false
    holder = Holder.NONE
    uiPage = null
    localAllowed = false
    return true
  }
  private var uiPage: Any? = null

  private fun lapse(now: Long) {
    if (holder == Holder.RESERVED && now - reservedAt >= reserveMs) { holder = Holder.NONE; localAllowed = true }
  }

  companion object {
    const val MODE_SERVICE = "service"
    const val MODE_LOCAL = "local"
  }
}

/**
 * SERVICE-API-001: the UI page's requests to the service engine page, and its replies back. Requests
 * made before the service page is ready wait (bounded, [waitMs]); none ever hangs: each is answered
 * by the service, or with a real error on timeout, overflow, or service loss, or with `local: true`
 * when [EngineOwner] lets the UI open the database itself. Not thread-safe: one thread (main).
 */
class ServiceApiCore(
  private val owner: EngineOwner,
  private val now: () -> Long,
  private val schedule: (delayMs: Long, run: () -> Unit) -> Unit,
  private val waitMs: Long = 20_000,
) {
  /** Delivers one request envelope into the service page; false when there is no page to take it. */
  var toService: ((String) -> Boolean)? = null
  /** Delivers one reply into the UI page as `window.__awApi(id, json)`. */
  var toUi: ((Int, String) -> Unit)? = null

  var ready = false; private set
  private class Waiting(val id: Int, val envelope: String)
  private val waiting = ArrayDeque<Waiting>()
  private val inFlight = LinkedHashSet<Int>()

  val waitingCount: Int get() = waiting.size
  val inFlightCount: Int get() = inFlight.size

  fun fromUi(id: Int, json: String) {
    if (json.length > MAX_REQUEST_CHARS) return answer(id, error(413, "The request is too large."))
    val req = runCatching { JSONObject(json) }.getOrNull() ?: return answer(id, error(400, "Bad engine request."))
    if (owner.modeForUi(now()) == EngineOwner.MODE_LOCAL) return answer(id, local())
    if (owner.serviceFailed) return answer(id, error(503, "The music engine could not start."))
    val envelope = req.put("id", id.toString()).toString()
    if (ready) return send(id, envelope)
    if (waiting.size >= MAX_WAITING) return answer(id, error(503, "Too many requests are waiting for the music engine."))
    val w = Waiting(id, envelope)
    waiting.addLast(w)
    schedule(waitMs) {
      if (waiting.remove(w)) answer(id, if (owner.modeForUi(now()) == EngineOwner.MODE_LOCAL) local() else error(503, "The music engine did not start in time."))
    }
  }

  /** The service page installed its request handler. */
  fun serviceReady() {
    ready = true
    while (waiting.isNotEmpty() && ready) { val w = waiting.removeFirst(); send(w.id, w.envelope) }
  }

  /** The service page went away: what it was answering fails now; waiting requests keep waiting for a new one. */
  fun serviceLost() {
    ready = false
    val lost = inFlight.toList()
    inFlight.clear()
    lost.forEach { toUi?.invoke(it, error(503, "The music engine stopped.")) }
  }

  /** The service page could not start. Every request fails now, or is told to go local when it may. */
  fun serviceFailed(opened: Boolean) {
    owner.serviceFailed(opened)
    serviceLost()
    val mode = owner.modeForUi(now())
    val all = waiting.toList()
    waiting.clear()
    all.forEach { answer(it.id, if (mode == EngineOwner.MODE_LOCAL) local() else error(503, "The music engine could not start.")) }
  }

  /** A reply from the service page. Unknown, stale or duplicate ids are dropped. */
  fun reply(id: String, json: String) {
    val n = id.toIntOrNull() ?: return
    if (!inFlight.remove(n)) return
    toUi?.invoke(n, if (json.length > MAX_REPLY_CHARS) error(500, "The engine reply was too large.") else json)
  }

  /** The UI page is gone: nothing is left to answer. */
  fun uiGone() {
    waiting.clear()
    inFlight.clear()
  }

  private fun send(id: Int, envelope: String) {
    inFlight += id
    while (inFlight.size > MAX_IN_FLIGHT) inFlight.remove(inFlight.first())
    val delivered = runCatching { toService?.invoke(envelope) == true }.getOrDefault(false)
    if (!delivered && inFlight.remove(id)) answer(id, error(503, "The music engine is not running."))
  }

  private fun answer(id: Int, json: String) { toUi?.invoke(id, json) }

  companion object {
    const val MAX_REQUEST_CHARS = 2_000_000
    const val MAX_REPLY_CHARS = 8_000_000
    const val MAX_WAITING = 64
    const val MAX_IN_FLIGHT = 256

    fun error(status: Int, message: String): String =
      JSONObject().put("status", status).put("body", JSONObject().put("message", message)).toString()

    fun local(): String = JSONObject().put("status", 503)
      .put("body", JSONObject().put("message", "The music engine is not running.").put("code", "local"))
      .put("local", true).toString()
  }
}

/** The process's one [EngineOwner] and [ServiceApiCore], driven on the main thread. */
object ServiceApi {
  private val main = Handler(Looper.getMainLooper())
  val owner = EngineOwner(RESERVE_MS)
  val core = ServiceApiCore(owner, SystemClock::elapsedRealtime, { ms, run -> main.postDelayed(run, ms) })
  /** Told when the UI page let go of the database it held, so the service page can claim it. */
  @Volatile var onUiReleased: (() -> Unit)? = null

  fun onMain(run: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) run() else main.post(run) }

  /** The UI page [page] is gone, with [replies] its reply sink: forget its requests and any hold it had. */
  fun releaseUi(page: Any, replies: (Int, String) -> Unit) = onMain {
    if (core.toUi === replies) { core.toUi = null; core.uiGone() }
    if (owner.releaseUi(page)) onUiReleased?.invoke()
  }

  private const val RESERVE_MS = 15_000L
}
