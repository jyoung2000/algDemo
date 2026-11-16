package com.nowplaying.discovery

import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The one guarded HTTP relay both app pages use (the phone page in [MainActivity] and the service's
 * catalogue page in [CatalogEngine]): HTTPS to the allow-listed music services only, no redirects
 * followed (the page re-checks each hop), a bounded body. Blocking; call it off the main thread.
 */
object NativeHttp {
  // Mirrors server/airwave_discovery/net.py ALLOWED_HOSTS / ALLOWED_SUFFIXES.
  val HOSTS = setOf(
    "api.deezer.com", "www.deezer.com", "deezer.com", "deezer.page.link", "link.deezer.com",
    "open.spotify.com", "spotify.link", "spotify.app.link",
    "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com", "api-v2.soundcloud.com",
    "bandcamp.com", "www.bandcamp.com", "api.audius.co", "audius.co", "api-v2.hearthis.at", "archive.org",
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

  fun allowed(host: String): Boolean = host in HOSTS || SUFFIXES.any { host.endsWith(it) }

  /** One page request (`{url, method, headers, body, timeoutMs, maxBytes}`) to `{status, headers, body(base64)}` or `{error}`. */
  fun perform(json: String): JSONObject {
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
    return out
  }
}
