package com.nowplaying.discovery

import android.content.Context
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

/** The app's own files, served from the APK's assets at https://[HOST]/ with the right MIME types
 *  (wasm and ES modules need them). Shared by the phone page and the service's catalogue page. */
object AppAssets {
  const val HOST = "appassets.androidplatform.net"

  /** Serve /path; an unknown extensionless path falls back to [spaFallback] when one is given. */
  fun serve(ctx: Context, rawPath: String, spaFallback: String? = "index.html"): WebResourceResponse {
    var path = rawPath.trimStart('/')
    if (path.isEmpty()) path = spaFallback ?: return notFound()
    val mime = mimeOf(path)
    return try {
      val stream = ctx.assets.open("web/$path")
      val enc = if (mime.startsWith("text/") || mime == "application/json") "utf-8" else null
      // addJavascriptInterface is exposed to every frame. Installed-app playback uses no embeds;
      // refuse third-party frames so they cannot call the privileged downloader/HTTP bridge.
      val headers = mapOf("Cache-Control" to "no-cache", "Content-Security-Policy" to "frame-src 'none'; object-src 'none'; base-uri 'none'")
      WebResourceResponse(mime, enc, 200, "OK", headers, stream)
    } catch (e: java.io.IOException) {
      if (spaFallback != null && !path.substringAfterLast('/').contains('.')) serve(ctx, "/$spaFallback", null)
      else notFound()
    }
  }

  fun notFound(): WebResourceResponse = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

  fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
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
}
