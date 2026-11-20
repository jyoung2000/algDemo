package com.nowplaying.discovery

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.media3.common.util.UnstableApi
import com.nowplaying.discovery.engine.EngineHub
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

/**
 * CAR-CATALOG-SERVICE-001: the service's own catalogue engine, so the car searches with the phone
 * page hidden or never opened. It is a WebView that is NEVER attached to a window: such a view stays
 * "visible" to Chromium for background work (BrowserViewRenderer::IsClientVisible, !was_attached_),
 * which a once-attached Activity view never regains. It loads only the app's own car.html (the same
 * LocalApi and CarCatalog the phone uses; no React, no audio) from the app's own asset origin, and
 * reaches the network only through the shared guarded [NativeHttp]. Its replies carry search and
 * Identify answers only ([MediaHub.applyCatalog]); playback stays with the native engine.
 *
 * Owned by [PlaybackService]: registered in its onCreate, started after onCreate returns, destroyed
 * in its onDestroy, main thread only.
 *
 * SERVICE-API-001: when it holds the original database ([EngineOwner]) this page is the ONE engine:
 * the UI page's requests ([ServiceApi]) are answered here, its queue cache acquires and downloads the
 * car-selected songs, and the files it holds reach the native player as `sourceUpdates`.
 */
@UnstableApi
class CatalogEngine(private val context: Context) {
  init { NativeHttp.attach(context) } // ALLOWANCE-ARCH-001: the car's catalogue page learns about the connection too
  private val main = Handler(Looper.getMainLooper())
  private val pool = Executors.newFixedThreadPool(4)
  private var clock: NativeClock? = null
  private var web: WebView? = null
  private var stopped = false
  private var restarts = 0
  /** This page claimed the original database (until it is torn down). */
  @Volatile private var claimed = false

  /** The native player's state into the engine page (CarSources), on the main thread. */
  private val stateObserver: (String) -> Unit = { json ->
    val v = web
    if (v != null) main.post { if (web === v) v.evaluateJavascript("window.__awServiceState && window.__awServiceState(${JSONObject.quote(json)})", null) }
  }

  /** One UI request envelope into the engine page; false when there is no page to take it. */
  private val apiSink: (String) -> Boolean = { envelope ->
    val v = web
    if (v != null) v.evaluateJavascript("window.__awServiceApi && window.__awServiceApi(${JSONObject.quote(envelope)})", null)
    v != null
  }

  /** Car catalogue commands into the engine page (`window.__awMediaCmd`). */
  private val sink: (JSONObject) -> Unit = { cmd ->
    // main, not v.post: View.post on a never-attached view queues until attachment, i.e. forever.
    val v = web
    if (v != null) main.post { if (web === v) v.evaluateJavascript("window.__awMediaCmd && window.__awMediaCmd(${JSONObject.quote(cmd.toString())})", null) }
  }

  /** Register before the deferred start so a car request in that gap waits for catalogReady. */
  fun prepare() { if (!stopped) MediaHub.setCatalogSink(sink) }

  @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
  fun start() {
    if (stopped || web != null) return
    val c = NativeClock(NativeClock.mainLooper()).also { clock = it }
    val view = WebView(context)
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      mediaPlaybackRequiresUserGesture = true
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      allowFileAccess = false
      allowContentAccess = false
    }
    view.addJavascriptInterface(Bridge(view, c), "AirwaveNative")
    view.webChromeClient = object : WebChromeClient() {
      override fun onConsoleMessage(m: ConsoleMessage): Boolean {
        Log.d(TAG, "${m.messageLevel()} ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
        return true
      }
    }
    view.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse {
        val u = request.url
        // Only the app's own files; everything else goes through the guarded bridge or nowhere.
        if (u.scheme == "https" && u.host == AppAssets.HOST) {
          if (u.path == "/radio-native") return RadioNative.serve(context, u)
          return AppAssets.serve(context, u.path ?: "/", null)
        }
        return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
      }
      override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean = request.url.host != AppAssets.HOST

      override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
        Log.w(TAG, "renderer gone (crash=${detail.didCrash()})")
        if (web === v) {
          teardown()
          if (!stopped && restarts++ < 3) {
            prepare() // Hold new car commands while the renderer restarts.
            main.postDelayed({ start() }, 2000)
          }
        }
        return true
      }
    }
    web = view
    MediaHub.setCatalogSink(sink)
    // A page that found the UI holding the database runs metadata-only; reload it once the UI lets go.
    ServiceApi.onUiReleased = { main.post { if (!stopped && web != null && !claimed) { teardown(); start() } } }
    view.loadUrl("https://${AppAssets.HOST}/car.html")
  }

  fun destroy() {
    stopped = true
    ServiceApi.onUiReleased = null
    teardown()
    pool.shutdownNow()
  }

  private fun teardown() {
    MediaHub.clearCatalogSink(sink)
    EngineHub.removeObserver(stateObserver)
    if (claimed) {
      claimed = false
      ServiceApi.core.toService = null
      ServiceApi.core.serviceLost()
      ServiceApi.owner.releaseService()
    }
    clock?.dispose(); clock = null
    web?.let { it.stopLoading(); it.destroy() }
    web = null
  }

  /** What the catalogue page can ask for: guarded HTTP, native waits, and reporting its answers. */
  private inner class Bridge(private val view: WebView, private val clock: NativeClock) {
    @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun delay(id: Int, ms: Int): Boolean = clock.schedule(id, ms.toLong()) { fired ->
      if (web === view) view.evaluateJavascript("window.__awDelay && window.__awDelay($fired)", null)
    }

    @JavascriptInterface fun cancelDelay(id: Int) = clock.cancel(id)

    @JavascriptInterface
    fun request(id: Int, json: String) {
      runCatching {
        pool.execute {
          val out = NativeHttp.perform(json)
          main.post { if (web === view) view.evaluateJavascript("window.__awHttp($id, ${JSONObject.quote(out.toString())})", null) }
        }
      }
    }

    /**
     * The page's answers (media-native `send`): search and Identify replies, and SERVICE-API-001
     * `sourceUpdates` (the complete files its queue cache holds for the car-selected list). An update
     * names only known songs and allowed download links; it never starts audio: a chosen song that
     * waits for its file starts when it lands, through the player's own libraryChanged path.
     */
    @JavascriptInterface
    fun media(json: String) {
      if (json.length > 1_000_000) return
      val obj = runCatching { JSONObject(json) }.getOrNull() ?: return
      main.post {
        if (web !== view) return@post
        MediaHub.applyCatalog(obj)
        // QUEUE-HEARD-001: songs this engine's listening top-up found with the phone app closed join the queue's end.
        obj.optJSONArray("queueTopUp")?.let { found ->
          if (claimed) Log.i(TAG, "queue top-up: ${EngineHub.appendFound(MediaHub.songsOf(found))} new songs")
        }
        val updates = obj.optJSONArray("sourceUpdates")
        if (claimed && updates != null && MediaHub.applySourceUpdates(updates) > 0) EngineHub.libraryChanged()
      }
    }

    /** SERVICE-API-001: v1 = claim, ready, replies, downloads, library and native state are all wired here. */
    @JavascriptInterface fun serviceApiVersion(): Int = 1

    /** Before the page opens the original database: true = it is this page's; false = run metadata-only. */
    @JavascriptInterface
    fun claimEngine(): Boolean {
      if (web !== view) return false
      val ok = ServiceApi.owner.claimService()
      if (ok) claimed = true
      Log.i(TAG, "engine claim ${if (ok) "granted" else "refused (the UI page holds the database)"}")
      return ok
    }

    /** The page installed `window.__awServiceApi` and `window.__awServiceState`. */
    @JavascriptInterface
    fun apiReady() {
      main.post {
        if (web !== view || !claimed) return@post
        ServiceApi.core.toService = apiSink
        ServiceApi.core.serviceReady()
        EngineHub.addObserver(stateObserver)
      }
    }

    /** The engine could not start; [opened]: it had begun opening the original database. */
    @JavascriptInterface
    fun engineFailed(opened: Boolean) {
      main.post { if (web === view && claimed) { Log.w(TAG, "engine failed (opened=$opened)"); ServiceApi.core.serviceFailed(opened) } }
    }

    /** A reply to one UI request (`id` as the envelope carried it). */
    @JavascriptInterface
    fun apiReply(id: String, json: String) {
      main.post { if (web === view && claimed) ServiceApi.core.reply(id, json) }
    }

    /** The queue cache's downloader, answered through `window.__awDl`. The folder picker is the UI's alone. */
    @JavascriptInterface
    fun downloads(id: Int, json: String) {
      val req = runCatching { JSONObject(json) }.getOrNull()
      val refused = when {
        req == null -> "Invalid download request."
        req.optString("op") == "choose-folder" -> "Choose a folder in the jPlay app."
        else -> null
      }
      if (refused != null) { replyDownload(id, JSONObject().put("error", refused)); return }
      runCatching {
        pool.execute {
          val out = try { Downloads.handle(context.applicationContext, req!!) } catch (e: Exception) { JSONObject().put("error", e.message ?: e.javaClass.simpleName) }
          replyDownload(id, out)
        }
      }.onFailure { replyDownload(id, JSONObject().put("error", "The downloader stopped.")) }
    }

    private fun replyDownload(id: Int, out: JSONObject) {
      main.post { if (web === view) view.evaluateJavascript("window.__awDl && window.__awDl($id, ${JSONObject.quote(out.toString())})", null) }
    }

    /** The saved library and the original Tracks the UI page last sent, for the engine's bootstrap. */
    @JavascriptInterface
    fun library(): String {
      val out = JSONObject()
        .put("library", NativeLibraryState.library() ?: JSONObject.NULL)
        .put("tracks", NativeLibraryState.tracks() ?: JSONArray())
      return out.toString().takeIf { it.length <= NativeStateCodec.MAX_CHARS } ?: "{\"library\":null,\"tracks\":[]}"
    }

    /** Sent by car-main once its engine and handlers are installed. */
    @JavascriptInterface
    fun catalogReady() {
      main.post { if (web === view) { Log.i(TAG, "ready"); MediaHub.markCatalogReady(sink) } }
    }
  }

  private companion object { const val TAG = "AirwaveCatalog" }
}
