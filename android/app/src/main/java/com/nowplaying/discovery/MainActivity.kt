package com.nowplaying.discovery

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Airwave Discovery on Android, standalone: the web app, the recommendation engine and the audio model all
 * live inside the APK and run in this WebView. There is no server to install or connect to.
 *
 * Two things need the native side:
 *  - the app's own files are served from the APK's assets over https://appassets.androidplatform.net/ (so
 *    the page has a real https origin and wasm / ES modules get the right MIME types);
 *  - network calls to the music services go through [Bridge.request], because the page cannot call
 *    Deezer or YouTube directly (CORS). Only an allow-list of hosts is reachable.
 *  - song identification: the search bar's Mic asks for RECORD_AUDIO when tapped (never at start-up) and
 *    its File button opens the system picker for one audio file. Only the app's own page can get either.
 */
class MainActivity : Activity() {
  private lateinit var root: FrameLayout
  private var web: WebView? = null
  private val pool = Executors.newFixedThreadPool(16)
  private var pendingMic: PermissionRequest? = null
  private var pendingFile: ValueCallback<Array<Uri>>? = null
  private var pendingFolderId: Int? = null
  @Volatile private var webAudioPlaying = false
  private var activityPaused = false
  private var notificationRequested = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#f7f6f3")) }
    setContentView(root)
    edgeToEdge()
    Downloads.warmUp(this) // unpacks yt-dlp, Python and ffmpeg in the background
    open()
  }

  /**
   * The page never sits under the status bar (ANDROID-INSETS-001).
   *
   * From Android 15 (targetSdk 35) the system draws every app edge to edge and ignores a request not
   * to, so the WebView's top row ends up behind the clock and the battery. Rather than have two
   * behaviours to reason about, this asks for edge to edge from API 30 up — an API 34 emulator then
   * runs the same path the phone does — and pays for it by padding the root view with the real inset
   * the window reports.
   *
   * Three things this has to get right:
   *  - the inset is READ from the window, never computed from a dimen: a notch, a hole punch and a
   *    plain 24dp bar all give different numbers, and only the window knows which one this phone has;
   *  - the insets are CONSUMED, so the WebView inside reports `env(safe-area-inset-*)` as zero. The
   *    padding is then the single place the bars are paid for, and the stylesheet's existing
   *    `env(safe-area-inset-bottom)` terms add nothing instead of paying a second time;
   *  - `setDecorFitsSystemWindows(false)` also takes the keyboard out of `adjustResize`'s hands, so
   *    the bottom padding is the larger of the navigation bar and the IME. Without this the search
   *    field would sit under the keyboard it just opened.
   */
  private fun edgeToEdge() {
    if (android.os.Build.VERSION.SDK_INT < 30) return
    window.setDecorFitsSystemWindows(false)
    root.setOnApplyWindowInsetsListener { v, insets ->
      val types = android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout()
      val bars = insets.getInsets(types)
      val ime = insets.getInsets(android.view.WindowInsets.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      Log.d("AirwaveInsets", "top=${bars.top} bottom=${bars.bottom} ime=${ime.bottom} left=${bars.left} right=${bars.right}")
      android.view.WindowInsets.CONSUMED
    }
    root.requestApplyInsets()
  }

  @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
  private fun open() {
    val view = WebView(this).apply {
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.mediaPlaybackRequiresUserGesture = false
      settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      settings.allowFileAccess = false
      settings.allowContentAccess = false
      settings.setSupportZoom(false)
      setBackgroundColor(Color.parseColor("#f7f6f3"))
      overScrollMode = View.OVER_SCROLL_NEVER
      addJavascriptInterface(Bridge(this), "AirwaveNative")
      webChromeClient = object : WebChromeClient() {
        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
          Log.d("AirwaveWeb", "${m.messageLevel()} ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
          return true
        }

        // getUserMedia({ audio }) from the search bar's Mic. Granted to our own page only, for audio only, and only
        // once Android's RECORD_AUDIO is granted; a refusal reaches the page as NotAllowedError ("denied").
        override fun onPermissionRequest(request: PermissionRequest) {
          val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
          if (request.origin.host != APP_HOST || !wantsMic) return request.deny()
          if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
          } else {
            pendingMic?.deny()
            pendingMic = request
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
          }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
          if (pendingMic === request) pendingMic = null
        }

        // <input type="file" accept="audio/*"> from the search bar's File: one audio file from the system picker.
        override fun onShowFileChooser(v: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
          pendingFile?.onReceiveValue(null)
          pendingFile = callback
          val pick = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "audio/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("audio/*", "video/webm", "application/ogg"))
          }
          return try {
            startActivityForResult(Intent.createChooser(pick, "Choose an audio file"), REQ_FILE)
            true
          } catch (e: Exception) {
            pendingFile = null
            callback.onReceiveValue(null)
            false
          }
        }
      }
      webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? {
          val u = request.url
          if (u.scheme == "https" && u.host == APP_HOST) {
            // A downloaded full song at the app's own origin, so the page may route it through Web
            // Audio (a cross-origin element without CORS is silent there). Range requests, because an
            // <audio> element seeks with them and reports no duration without them.
            if (u.path == "/local-audio") return localAudio(u.getQueryParameter("u") ?: "", request.requestHeaders["Range"])
            return asset(u.path ?: "/")
          }
          return null
        }

        override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
          val target = request.url
          if (target.host == APP_HOST) return false
          // YouTube's player loads in an iframe, which is not a top-level navigation. A tapped link to
          // another site is, and it goes to the browser.
          if (request.isForMainFrame) {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, target)) }
            return true
          }
          return false
        }
      }
      loadUrl("https://$APP_HOST/index.html")
    }
    web = view
    root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  private fun localAudio(sourceUrl: String, rangeHeader: String?): WebResourceResponse {
    val notFound = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    val (uri, size, type) = Downloads.localFile(this, sourceUrl) ?: return notFound
    // WebView's own loader handles Range for an intercepted stream: it reads the Range header from
    // the request, skips that far into the stream it is given and sizes the answer from the
    // stream's available(). So the whole file is handed over from byte 0 with an honest
    // available(), and nothing is skipped or sized here — doing it twice served garbage.
    val stream = contentResolver.openInputStream(uri) ?: return notFound
    val headers = mapOf("Accept-Ranges" to "bytes", "Cache-Control" to "no-cache")
    return WebResourceResponse(type, null, 200, "OK", headers, SizedInputStream(stream, size))
  }

  /** The file's stream with an available() that tells the truth about its size, which WebView's loader relies on. */
  private class SizedInputStream(private val inner: java.io.InputStream, private var remaining: Long) : java.io.InputStream() {
    override fun available(): Int = minOf(remaining, Int.MAX_VALUE.toLong()).toInt()
    override fun read(): Int { val b = inner.read(); if (b >= 0) remaining-- ; return b }
    override fun read(b: ByteArray, off: Int, len: Int): Int { val n = inner.read(b, off, len); if (n > 0) remaining -= n; return n }
    override fun skip(n: Long): Long {
      // skip() on a MediaStore stream may claim progress it did not make; read instead.
      var done = 0L
      val buf = ByteArray(64 * 1024)
      while (done < n) { val r = inner.read(buf, 0, minOf(buf.size.toLong(), n - done).toInt()); if (r <= 0) break; done += r }
      remaining -= done
      return done
    }
    override fun close() = inner.close()
  }

  /** Serve /path from the APK's assets with the right MIME type (wasm and ES modules need them). */
  private fun asset(rawPath: String): WebResourceResponse {
    var path = rawPath.trimStart('/')
    if (path.isEmpty()) path = "index.html"
    val mime = mimeOf(path)
    return try {
      val stream = assets.open("web/$path")
      val enc = if (mime.startsWith("text/") || mime == "application/json") "utf-8" else null
      // addJavascriptInterface is exposed to every frame. Installed-app playback uses no embeds;
      // refuse third-party frames so they cannot call the privileged downloader/HTTP bridge.
      val headers = mapOf("Cache-Control" to "no-cache", "Content-Security-Policy" to "frame-src 'none'; object-src 'none'; base-uri 'none'")
      WebResourceResponse(mime, enc, 200, "OK", headers, stream)
    } catch (e: java.io.IOException) {
      if (!path.substringAfterLast('/').contains('.')) asset("/index.html")
      else WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
  }

  private fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
    "html" -> "text/html"
    "js", "mjs" -> "text/javascript"
    "css" -> "text/css"
    "json" -> "application/json"
    "wasm" -> "application/wasm"
    "svg" -> "image/svg+xml"
    "png" -> "image/png"
    "ico" -> "image/x-icon"
    "woff2" -> "font/woff2"
    "md" -> "text/plain"
    else -> "application/octet-stream"
  }

  /** What the page can ask the phone to do: HTTP to the music services, nothing else. */
  inner class Bridge(private val view: WebView) {
    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    /** JS opt-in: AirwaveNative.playbackState(JSON.stringify({playing, title})).
     * Reports state for the notification only; no native player or media session is created.
     */
    @JavascriptInterface
    fun playbackState(json: String) {
      if (json.length > 2048) return
      val state = runCatching { JSONObject(json) }.getOrNull() ?: return
      val playing = state.optBoolean("playing", false)
      val title = state.optString("title", "Airwave Discovery").take(120)
      view.post {
        if (web !== view) return@post
        webAudioPlaying = playing
        if (playing) {
          if (Build.VERSION.SDK_INT >= 33 && !activityPaused && !notificationRequested &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationRequested = true
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
          }
          if (activityPaused) view.onResume()
          val service = Intent(this@MainActivity, PlaybackNotificationService::class.java)
            .setAction(PlaybackNotificationService.ACTION_PLAYING)
            .putExtra(PlaybackNotificationService.EXTRA_TITLE, title)
          try {
            startForegroundService(service)
          } catch (e: RuntimeException) {
            // Android 12+ can reject an FGS start made after the Activity went to background.
            Log.w("AirwavePlayback", "Could not start playback notification", e)
          }
        } else {
          stopService(Intent(this@MainActivity, PlaybackNotificationService::class.java))
          if (activityPaused) view.onPause()
        }
      }
    }

    /** Fire-and-forget requests, except choose-folder: it resolves after the system picker returns. */
    @JavascriptInterface
    fun downloads(id: Int, json: String) {
      val req = runCatching { JSONObject(json) }.getOrElse {
        view.post { replyDownload(view, id, JSONObject().put("error", "Invalid download request.")) }
        return
      }
      if (req.optString("op") == "choose-folder") {
        view.post {
          if (pendingFolderId != null) {
            replyDownload(view, id, JSONObject().put("error", "A folder picker is already open."))
          } else {
            pendingFolderId = id
            try {
              @Suppress("DEPRECATION")
              startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
              ), REQ_FOLDER)
            } catch (e: Exception) {
              pendingFolderId = null
              replyDownload(view, id, JSONObject().put("error", e.message ?: "No folder picker available."))
            }
          }
        }
        return
      }
      pool.execute {
        val out = try {
          Downloads.handle(applicationContext, req)
        } catch (e: Exception) {
          JSONObject().put("error", e.message ?: e.javaClass.simpleName)
        }
        view.post { replyDownload(view, id, out) }
      }
    }

    /** Fire-and-forget; the answer comes back through window.__awHttp(id, json). */
    @JavascriptInterface
    fun request(id: Int, json: String) {
      pool.execute {
        val out = JSONObject()
        try {
          val req = JSONObject(json)
          val url = URL(req.getString("url"))
          if (url.protocol != "https" || !allowed(url.host)) throw SecurityException("host not allowed: ${url.host}")
          val c = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = req.optString("method", "GET")
            connectTimeout = 15000
            readTimeout = req.optInt("timeoutMs", 30000)
            instanceFollowRedirects = false // the page re-checks each hop against the allow-list
            req.optJSONObject("headers")?.let { h -> h.keys().forEach { k -> setRequestProperty(k, h.getString(k)) } }
            if (req.has("body") && !req.isNull("body")) {
              doOutput = true
              outputStream.use { it.write(req.getString("body").toByteArray(Charsets.UTF_8)) }
            }
          }
          val status = c.responseCode
          val stream = if (status >= 400) c.errorStream else c.inputStream
          val cap = req.optInt("maxBytes", 8_000_000)
          val bytes = stream?.use { s ->
            val buf = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(16384)
            while (true) {
              val n = s.read(chunk)
              if (n < 0) break
              buf.write(chunk, 0, n)
              if (buf.size() > cap) throw java.io.IOException("response larger than $cap bytes")
            }
            buf.toByteArray()
          } ?: ByteArray(0)
          val headers = JSONObject()
          c.headerFields.forEach { (k, v) -> if (k != null && v.isNotEmpty()) headers.put(k.lowercase(), v.last()) }
          out.put("status", status).put("headers", headers).put("body", Base64.encodeToString(bytes, Base64.NO_WRAP))
        } catch (e: Exception) {
          out.put("error", "${e.javaClass.simpleName}: ${e.message}")
        }
        view.post { view.evaluateJavascript("window.__awHttp($id, ${JSONObject.quote(out.toString())})", null) }
      }
    }
  }

  private fun replyDownload(view: WebView, id: Int, result: JSONObject) {
    if (web === view) view.evaluateJavascript("window.__awDl($id, ${JSONObject.quote(result.toString())})", null)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQ_MIC) return
    val req = pendingMic ?: return
    pendingMic = null
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else req.deny()
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == REQ_FOLDER) {
      val id = pendingFolderId ?: return
      pendingFolderId = null
      val out = try {
        val uri = if (resultCode == RESULT_OK) data?.data else null
        if (uri == null) throw IllegalStateException("Folder selection cancelled.")
        if (((data?.flags ?: 0) and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0) throw SecurityException("Folder write permission was not granted.")
        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        Downloads.setFolder(applicationContext, uri)
        JSONObject().put("saves_to", Downloads.health(applicationContext).getString("saves_to"))
      } catch (e: Exception) {
        JSONObject().put("error", e.message ?: "Could not save selected folder.")
      }
      web?.let { replyDownload(it, id, out) }
      return
    }
    if (requestCode != REQ_FILE) return
    val cb = pendingFile ?: return
    pendingFile = null
    val uri = if (resultCode == RESULT_OK) data?.data else null
    cb.onReceiveValue(uri?.let { arrayOf(it) }) // null = cancelled; the page simply stays where it was
  }

  private fun allowed(host: String): Boolean = host in HOSTS || SUFFIXES.any { host.endsWith(it) }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    val w = web
    if (w != null && w.canGoBack()) w.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
  }

  override fun onPause() { activityPaused = true; if (!webAudioPlaying) web?.onPause(); super.onPause() }
  override fun onResume() { super.onResume(); activityPaused = false; web?.onResume() }
  override fun onDestroy() {
    stopService(Intent(this, PlaybackNotificationService::class.java))
    web?.destroy(); web = null; pool.shutdownNow(); super.onDestroy()
  }

  private companion object {
    const val APP_HOST = "appassets.androidplatform.net"
    const val REQ_MIC = 41
    const val REQ_FILE = 42
    const val REQ_FOLDER = 43
    const val REQ_NOTIFY = 44
    // Mirrors server/airwave_discovery/net.py ALLOWED_HOSTS / ALLOWED_SUFFIXES.
    val HOSTS = setOf(
      "api.deezer.com", "www.deezer.com", "deezer.com", "deezer.page.link", "link.deezer.com",
      "open.spotify.com", "spotify.link", "spotify.app.link",
      "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com", "api-v2.soundcloud.com",
      "bandcamp.com", "www.bandcamp.com", "api.audius.co", "audius.co", "archive.org",
      "www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
      "itunes.apple.com", "music.apple.com",
      "api-partner.spotify.com", "clienttoken.spotify.com", "open.spotifycdn.com",
      "open.qobuz.com",
      "music.amazon.com", "na.web.skill.music.a2z.com",
      "tidal.com", "resources.tidal.com",
      "api.song.link",
      "lrclib.net", "musicbrainz.org",
      "genius.com", "amp.shazam.com",
      "i.ytimg.com",
    )
    val SUFFIXES = listOf(".dzcdn.net", ".sndcdn.com")
  }
}
