package com.nowplaying.discovery

import android.content.Context
import android.net.ConnectivityManager
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.SequenceInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream

/**
 * The one guarded HTTP relay both app pages use (the phone page in [MainActivity] and the service's
 * catalogue page in [CatalogEngine]): HTTPS to the allow-listed music services only, no redirects
 * followed (the page re-checks each hop), a bounded body. Blocking; call it off the main thread.
 *
 * ALLOWANCE-ARCH-001: answers are asked for packed (gzip) and unpacked here; each one says how many bytes the
 * network carried (`wire`) and whether the connection is metered (`metered`).
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

  /**
   * ALLOWANCE-ARCH-001: whether the connection is metered (mobile data), or null when the phone cannot tell.
   * Set by [attach]; the app's mobile data allowance applies only on a metered connection.
   */
  @Volatile var metered: (() -> Boolean?)? = null

  /** Lets the relay ask Android about the connection. Safe to call from every entry point; the first one wins. */
  fun attach(context: Context) {
    if (metered != null) return
    val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    metered = { runCatching { cm.isActiveNetworkMetered }.getOrNull() }
  }

  private fun JSONObject.putMetered(): JSONObject {
    runCatching { metered?.invoke() }.getOrNull()?.let { put("metered", it) }
    return this
  }

  /** The headers sent: the page's own, and gzip asked for unless the page chose an encoding itself. */
  fun outgoingHeaders(asked: JSONObject?): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    asked?.keys()?.forEach { k -> out[k] = asked.getString(k) }
    if (out.keys.none { it.equals("accept-encoding", ignoreCase = true) }) out["Accept-Encoding"] = "gzip"
    return out
  }

  /**
   * Reads a body, unpacking gzip. Returns the unpacked bytes and how many bytes the network carried for them.
   * `cap` bounds the unpacked size.
   */
  fun readBody(raw: InputStream, encoding: String?, cap: Int): Pair<ByteArray, Int> {
    var wire = 0
    val counted = object : FilterInputStream(raw) {
      override fun read(): Int = super.read().also { if (it >= 0) wire += 1 }
      override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { if (it > 0) wire += it }
    }
    val packed = encoding.equals("gzip", ignoreCase = true) || encoding.equals("x-gzip", ignoreCase = true)
    // An empty answer marked gzip (a 204, a 304) has no gzip header to read.
    val first = counted.read()
    if (first < 0) return ByteArray(0) to 0
    val whole = SequenceInputStream(ByteArrayInputStream(byteArrayOf(first.toByte())), counted)
    val s: InputStream = if (packed) GZIPInputStream(whole) else whole
    val buf = ByteArrayOutputStream()
    val chunk = ByteArray(16384)
    while (true) {
      val n = s.read(chunk)
      if (n < 0) break
      buf.write(chunk, 0, n)
      if (buf.size() > cap) throw IOException("response larger than $cap bytes")
    }
    return buf.toByteArray() to wire
  }

  /** The answer's headers for the page; an unpacked answer loses the two that described the packed one. */
  fun pageHeaders(all: Map<String?, List<String>>, packed: Boolean): JSONObject {
    val headers = JSONObject()
    all.forEach { (k, v) ->
      if (k == null || v.isEmpty()) return@forEach
      val name = k.lowercase()
      if (packed && (name == "content-encoding" || name == "content-length")) return@forEach
      headers.put(name, v.last())
    }
    return headers
  }

  /**
   * One page request (`{url, method, headers, body, timeoutMs, maxBytes}`) to
   * `{status, headers, body(base64), wire, metered}` or `{error}`. `{probe: "network"}` asks only whether the
   * connection is metered and uses no network.
   */
  fun perform(json: String): JSONObject {
    val out = JSONObject()
    try {
      val req = JSONObject(json)
      if (req.optString("probe") == "network") return out.put("status", 204).put("headers", JSONObject()).put("body", "").put("wire", 0).putMetered()
      val url = URL(req.getString("url"))
      if (url.protocol != "https" || !allowed(url.host)) throw SecurityException("host not allowed: ${url.host}")
      val c = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = req.optString("method", "GET")
        connectTimeout = 15000
        readTimeout = req.optInt("timeoutMs", 30000)
        instanceFollowRedirects = false // the page re-checks each hop against the allow-list
        // Asking for gzip by name turns off the platform's silent unpacking, so the packed bytes can be counted.
        outgoingHeaders(req.optJSONObject("headers")).forEach { (k, v) -> setRequestProperty(k, v) }
        if (req.has("body") && !req.isNull("body")) {
          doOutput = true
          outputStream.use { it.write(req.getString("body").toByteArray(Charsets.UTF_8)) }
        }
      }
      val status = c.responseCode
      val stream = if (status >= 400) c.errorStream else c.inputStream
      val cap = req.optInt("maxBytes", 8_000_000)
      val encoding = c.contentEncoding
      val packed = encoding.equals("gzip", ignoreCase = true) || encoding.equals("x-gzip", ignoreCase = true)
      val (bytes, wire) = stream?.use { readBody(it, encoding, cap) } ?: (ByteArray(0) to 0)
      out.put("status", status).put("headers", pageHeaders(c.headerFields, packed)).put("body", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("wire", wire).putMetered()
    } catch (e: Exception) {
      out.put("error", "${e.javaClass.simpleName}: ${e.message}")
    }
    return out
  }
}
