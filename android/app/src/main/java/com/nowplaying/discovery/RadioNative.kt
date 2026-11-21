package com.nowplaying.discovery

import android.content.Context
import android.util.Base64
import android.webkit.WebResourceResponse
import com.nowplaying.discovery.engine.EngineHub
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URI
import java.util.UUID
import org.json.JSONObject

/** RADIO-001 native network/decoder boundary. The renderer never receives remote audio URLs to
 * play directly; redirects and HLS segments are individually checked against private destinations. */
object RadioNative {
  data class Session(val id: String, val station: String, val ring: RadioRing, val data: JSONObject, var paused: Boolean = false, @Volatile var stopped: Boolean = false, var process: Process? = null, var connection: HttpURLConnection? = null) {
    /** RADIO-ICY-CLOCK-001 / RADIO-TITLE-INBAND-001: in-band titles of earlier connections, each on the ring clock. */
    val icy: MutableList<RadioIcy.Mark> = java.util.Collections.synchronizedList(mutableListOf())
    /** The playing connection's titles and how many audio bytes it has delivered. */
    @Volatile var icyLive: RadioIcy.Marks? = null
    @Volatile var icyLiveBytes: () -> Long = { 0L }
    fun icyMarks(): List<RadioIcy.Mark> = (synchronized(icy) { icy.toList() } + (icyLive?.resolved(ring.end, icyLiveBytes()) ?: emptyList())).takeLast(8)
  }
  @Volatile var session: Session? = null; private set
  /** RADIO-SHUFFLE-001: with shuffle on, car/phone skips tune a RANDOM other station of the tuned
   * list. It survives station switches (each one is a new Session) and resets when radio ends. */
  @Volatile var shuffle: Boolean = false
  private val metadata = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()
  fun publicAddress(a: InetAddress): Boolean {
    if (a !is Inet4Address || a.isAnyLocalAddress || a.isLoopbackAddress || a.isLinkLocalAddress || a.isSiteLocalAddress || a.isMulticastAddress) return false
    val b = a.address.map { it.toInt() and 255 }
    return !(b[0] == 0 || b[0] >= 224 || b[0] == 100 && b[1] in 64..127 || b[0] == 198 && b[1] in 18..19 || b[0] == 192 && b[1] == 0)
  }
  private fun open(raw: String, icy: Boolean = false, hops: Int = 0): HttpURLConnection {
    require(raw.length <= 4096 && hops <= 5) { "Invalid station URL or redirect limit" }
    val u = URI(raw)
    require(u.scheme in listOf("https", "http") && u.host != null && u.userInfo == null) { "Not a public broadcast URL" }
    val addresses = InetAddress.getAllByName(u.host)
    require(addresses.isNotEmpty() && addresses.filterIsInstance<Inet4Address>().isNotEmpty() && addresses.all { a -> if (a is Inet4Address) publicAddress(a) else !(a.isLoopbackAddress || a.isSiteLocalAddress || a.isLinkLocalAddress || a.isAnyLocalAddress || a.isMulticastAddress) }) { "Private station addresses are not allowed" }
    val c = u.toURL().openConnection() as HttpURLConnection
    c.instanceFollowRedirects = false; c.connectTimeout = 8000; c.readTimeout = 10000
    c.setRequestProperty("User-Agent", "AirwaveDiscovery/1.0 (radio listener)")
    c.setRequestProperty("Icy-MetaData", if (icy) "1" else "0")
    c.setRequestProperty("Connection", "close")
    val status = c.responseCode
    if (status in 300..399) { val loc = c.getHeaderField("Location") ?: error("Missing redirect"); c.disconnect(); return open(u.resolve(loc).toString(), icy, hops + 1) }
    if (status != 200) { c.disconnect(); error("Station answered HTTP $status") }
    return c
  }
  fun fetchText(raw: String): String { val c = open(raw); return try { val b = c.inputStream.use { it.readNBytes(2_000_001) }; require(b.size <= 2_000_000) { "Radio response too large" }; b.toString(Charsets.UTF_8) } finally { c.disconnect() } }
  private fun meta(raw: String): JSONObject {
    val old = metadata[raw]
    if (old != null && System.currentTimeMillis() - old.optLong("checkedAt") < 15000) return old
    val out = JSONObject().put("checkedAt", System.currentTimeMillis())
    try {
      val c = open(raw, true)
      try {
        val n = c.getHeaderField("icy-metaint")?.toIntOrNull() ?: 0
        require(n in 1..262144) { "Broadcaster publishes no ICY now-playing information" }
        c.inputStream.use { input ->
          val audio = input.readNBytes(n); require(audio.size == n) { "Metadata did not arrive" }
          val size = input.read(); require(size >= 0) { "Metadata did not arrive" }
          val b = input.readNBytes(size * 16).toString(Charsets.UTF_8)
          val title = Regex("StreamTitle='([\\s\\S]*?)';", RegexOption.IGNORE_CASE).find(b)?.groupValues?.get(1)?.trim('\u0000', ' ') ?: ""
          out.put("title", title.ifBlank { null }).put("state", if (title.isNotBlank()) "current" else "unavailable").put("detail", if (title.isNotBlank()) "Broadcaster ICY" else "No current item supplied by broadcaster")
        }
      } finally { c.disconnect() }
    } catch (e: Exception) { out.put("title", JSONObject.NULL).put("state", "unavailable").put("detail", e.message ?: "Metadata unavailable") }
    metadata[raw] = out; if (metadata.size > 400) metadata.keys.firstOrNull()?.let { metadata.remove(it) }
    return out
  }
  fun stop() { session?.let { it.stopped = true; it.connection?.disconnect(); it.process?.destroy(); it.ring.close() }; session = null }
  private fun pump(s: Session, raw: String, depth: Int = 0): String? {
    require(depth <= 4) { "Too many station playlists" }
    val c = open(raw, icy = true); s.connection = c
    try {
      val type = c.contentType ?: ""
      if (type.contains("mpegurl", true) || type.contains("scpls", true) || Regex("\\.(m3u8?|pls)(\\?|$)", RegexOption.IGNORE_CASE).containsMatchIn(c.url.toString())) {
        val bytes = c.inputStream.use { it.readNBytes(1_000_001) }; require(bytes.size <= 1_000_000)
        val t = bytes.toString(Charsets.UTF_8); val lines = t.lines().map { it.trim() }
        if (!t.contains("#EXT-X-")) return RadioReconnect.firstThatPlays(RadioReconnect.playlistEntries(t), { s.ring.end }) { pump(s, it, depth + 1) }
        if (t.contains("#EXT-X-STREAM-INF")) { val i = lines.indexOfFirst { it.startsWith("#EXT-X-STREAM-INF") }; return pump(s, c.url.toURI().resolve(lines[i + 1]).toString(), depth + 1) }
        require(!Regex("#EXT-X-KEY:.*METHOD=(?!NONE)").containsMatchIn(t)) { "Encrypted broadcasts are not supported" }
        val seen = hlsSeen.getOrPut(s.id) { LinkedHashSet() }
        val init = Regex("#EXT-X-MAP:URI=\"([^\"]+)\"").find(t)?.groupValues?.get(1)
        val parts = (if (init != null) listOf(init) else emptyList()) + lines.filter { it.isNotBlank() && !it.startsWith('#') }.takeLast(3)
        for (part in parts) {
          val u = c.url.toURI().resolve(part).toString(); if (s.stopped || !seen.add(u)) continue
          val seg = open(u); try { seg.inputStream.use { it.copyTo(s.process!!.outputStream) } } finally { seg.disconnect() }
        }
        if (seen.size > 1000) { val keep = seen.toList().takeLast(100); seen.clear(); seen.addAll(keep) }
        if (!s.stopped && !t.contains("#EXT-X-ENDLIST")) { Thread.sleep(1500); return c.url.toString() }
        return null
      }
      // RADIO-ICY-CLOCK-001: a station that interleaves titles has them taken out here and placed on the ring clock.
      val metaint = c.getHeaderField("icy-metaint")?.toIntOrNull()?.takeIf { it in 1..262144 }
      val kbps = RadioIcy.kbps(c.getHeaderField("icy-br")); val at = s.ring.end
      val marks = metaint?.let { RadioIcy.Marks(at, kbps) }
      val demux = metaint?.let { RadioIcy.Demux(it) { title, bytes, first -> marks!!.add(title, bytes, first) } }
      if (marks != null) { s.icyLive = marks; s.icyLiveBytes = { demux!!.audioBytes } }
      try {
        c.inputStream.use { input -> val b = ByteArray(32768); while (!s.stopped) { val n = input.read(b); if (n < 0) error("Station disconnected"); val o = s.process!!.outputStream; if (demux == null) o.write(b, 0, n) else demux.feed(b, n) { x, off, len -> o.write(x, off, len) } } }
      } finally {
        // A reconnect starts a new set; this connection's titles stay on the ring clock.
        if (marks != null && s.icyLive === marks) { val done = marks.resolved(s.ring.end, demux!!.audioBytes); synchronized(s.icy) { s.icy += done; while (s.icy.size > 8) s.icy.removeAt(0) }; s.icyLive = null }
      }
      return null
    } finally { c.disconnect() }
  }
  private val hlsSeen = java.util.concurrent.ConcurrentHashMap<String, LinkedHashSet<String>>()
  private fun start(ctx: Context, cmd: JSONObject): Session {
    stop()
    // Radio may be the very first thing played. FFmpeg.init unpacks only its own package;
    // libc++_shared.so lives in the Python package, initialized by YoutubeDL.init. Both are
    // bundled/local; no tool download or song download is needed to prepare this decoder.
    YoutubeDL.getInstance().init(ctx.applicationContext)
    FFmpeg.getInstance().init(ctx.applicationContext)
    val data = cmd.optJSONObject("station") ?: JSONObject().put("id", cmd.optString("stationId")).put("name", cmd.optString("name")).put("url", cmd.optString("url")).put("country", "").put("region", "").put("language", "").put("tags", org.json.JSONArray())
    // A force-stopped process cannot close its session ring. Purge only our orphan session files.
    ctx.cacheDir.listFiles()?.filter { it.name.matches(Regex("radio-[0-9a-f-]{36}\\.pcm")) }?.forEach { it.delete() }
    val id = UUID.randomUUID().toString()
    val s = Session(id, cmd.optString("stationId"), RadioRing(48000 * 600, File(ctx.cacheDir, "radio-$id.pcm")), data); session = s
    val pb = ProcessBuilder(File(ctx.applicationInfo.nativeLibraryDir, "libffmpeg.so").path, "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "pipe", "-i", "pipe:0", "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1")
    // Measured 2026-11-16: ffmpeg's own libraries pull in librubberband, which needs libc++_shared
    // from the Python package youtubedl-android unpacks beside it. Without that directory the
    // decoder dies at link time ("CANNOT LINK EXECUTABLE ... libc++_shared.so not found").
    val packages = File(ctx.noBackupFilesDir, "youtubedl-android/packages")
    pb.environment()["LD_LIBRARY_PATH"] = listOf(File(packages, "ffmpeg/usr/lib"), File(packages, "python/usr/lib"))
      .joinToString(":") { it.path } + ":" + ctx.applicationInfo.nativeLibraryDir
    val p = pb.start(); s.process = p
    Thread({ try { val b = ByteArray(32768); var held = 0; while (!s.stopped) { val n = p.inputStream.read(b, held, b.size - held); if (n < 0) break; val size = n + held; val whole = size - size % 4; s.ring.write(b, whole); held = size % 4; if (held > 0) System.arraycopy(b, whole, b, 0, held) }; if (!s.stopped) s.ring.fail(IllegalStateException("Radio decoder stopped")) } catch (e: Throwable) { if (!s.stopped) s.ring.fail(e) } }, "AirwaveRadioPCM").start()
    // Stopping a station destroys ffmpeg, which interrupts this reader. An uncaught exception on a
    // background thread takes the whole app down, so every stream reader ends quietly.
    Thread({ runCatching { p.errorStream.bufferedReader().useLines { lines -> lines.forEach { if (!s.stopped) android.util.Log.d("AirwaveRadio", it.take(300)) } } } }, "AirwaveRadioLog").start()
    // RADIO-ROBUST-001: a stream that was playing and drops reconnects to the station's address (RadioReconnect).
    Thread({
      val first = cmd.getString("url"); var tries = 0; var mark = 0L
      try {
        while (!s.stopped) {
          try { var u: String? = first; mark = s.ring.end; while (!s.stopped && u != null) u = pump(s, u); break }
          catch (e: Throwable) {
            if (s.stopped) break
            val next = RadioReconnect.next(s.ring.end > 0, s.ring.end - mark, tries)
            if (next == null) { s.ring.fail(e); break }
            tries = next; android.util.Log.d("AirwaveRadio", "reconnect $tries after ${e.message}")
            Thread.sleep(RadioReconnect.delayMs(tries))
          }
        }
      } catch (e: Throwable) { if (!s.stopped) s.ring.fail(e) } finally { if (!s.stopped) p.destroy(); hlsSeen.remove(s.id) }
    }, "AirwaveRadioStream").start()
    EngineHub.fromPage(JSONObject().put("op", "radio").put("id", s.id).put("title", cmd.optString("title", "Live radio")).put("station", cmd.optString("name", "Radio")).toString())
    return s
  }
  private fun snapshot(s: Session): JSONObject = JSONObject().put("id", s.id).put("stationId", s.station).put("station", s.data).put("paused", s.paused).put("shuffle", shuffle).put("received", s.ring.end / 48000.0).put("position", s.ring.positionFrames / 48000.0).put("held", s.ring.held).put("starved", s.ring.starved).put("heardS", s.ring.heard / 48000.0).put("oldest", s.ring.oldest / 48000.0).put("heard", s.ring.heard / 48000.0).put("dropped", s.ring.dropped).put("state", if (s.ring.failed != null) "failed" else if (s.ring.end > 48000) "playing" else "buffering").put("error", s.ring.failed?.message ?: JSONObject.NULL).put("native", true).put("icy", org.json.JSONArray().also { a -> s.icyMarks().forEach { m -> a.put(JSONObject().put("at", m.at).put("title", m.title).put("first", m.first)) } })
  fun handle(ctx: Context, cmd: JSONObject): JSONObject {
    when (cmd.optString("op")) {
      "request" -> return JSONObject().put("text", fetchText(cmd.getString("url")))
      "metadata" -> return meta(cmd.getString("url"))
      "start" -> {
        // The station list the listener is browsing becomes the car's and the wheel's skip context.
        cmd.optJSONArray("stations")?.let { RadioCatalog.rememberStations(it) }
        val s = start(ctx, cmd)
        RadioCatalog.selectContext(s.station)
        return snapshot(s)
      }
      // One favourites store for the phone page, the car browse tree and the station star action.
      "favourites" -> return JSONObject().put("stations", RadioCatalog.favourites(ctx, cmd.optJSONArray("stations")))
      // CAR-RADIO-FILTERS-001: the phone's saved places, so the car can offer them as location presets.
      "places" -> return JSONObject().put("places", RadioCatalog.setPlaces(ctx, cmd.optJSONArray("places")))
      "stop" -> { EngineHub.fromPage("{\"op\":\"pause\"}"); stop(); shuffle = false; return JSONObject().put("stopped", true) }
    }
    val s = session ?: error("Radio session has ended")
    require(!cmd.has("id") || cmd.optString("id") == s.id) { "Radio session has ended" }
    when (cmd.optString("op")) {
      "nowplaying" -> {
        // CAR-RADIO-CONTROLS-001: also the identified song (for the car's star and playlist pick) and its clock.
        val meta = JSONObject().put("op", "radio-meta").put("id", s.id).put("title", cmd.optString("title")).put("artist", cmd.optString("artist")).put("artwork", cmd.optString("artwork"))
        cmd.optJSONObject("song")?.let { meta.put("song", it) }
        cmd.optJSONObject("track")?.takeIf { it.toString().length <= 16_000 }?.let { meta.put("track", it) }
        for (k in listOf("start", "duration")) cmd.optDouble(k, Double.NaN).takeIf { !cmd.isNull(k) && it.isFinite() }?.let { meta.put(k, it) }
        EngineHub.fromPage(meta.toString())
      }
      "export" -> {
        val from = cmd.optDouble("from", Double.NaN); val to = cmd.optDouble("to", Double.NaN)
        require(from.isFinite() && to.isFinite()) { "Invalid recording range" }
        val temp = File.createTempFile("radio-export-", ".wav", ctx.cacheDir)
        return try {
          val seconds = temp.outputStream().use { s.ring.writeWav(it, (from * 48000).toLong(), (to * 48000).toLong()) }
          Downloads.saveRadioRecording(ctx, temp, cmd.optString("title", "Live radio"))
            .put("seconds", seconds).put("partial", true)
        } finally { temp.delete() }
      }
      "pause" -> { s.paused = cmd.optBoolean("paused"); if (s.paused) s.ring.hold(); EngineHub.fromPage("{\"op\":\"${if (s.paused) "pause" else "play"}\"}") }
      // RADIO-SHUFFLE-001: set the station-shuffle flag; the state object below reports it.
      "shuffle" -> { shuffle = cmd.optBoolean("on"); EngineHub.fromPage(JSONObject().put("op", "radio-shuffle").put("id", s.id).toString()) }
      // RADIO-GO-LIVE-001: the engine seeks its radio source to just before the newest audio (RadioRing.toLive).
      "live" -> { if (s.paused) { s.paused = false; EngineHub.fromPage("{\"op\":\"play\"}") }; EngineHub.fromPage(JSONObject().put("op", "radio-live").toString()) }
      "rewind" -> EngineHub.fromPage(JSONObject().put("op", "seek").put("positionMs", ((s.ring.positionFrames / 48.0) - cmd.optDouble("seconds", 15.0).coerceIn(0.0, 600.0) * 1000).coerceAtLeast(0.0)).toString())
      "sample" -> { val b = s.ring.sample(); return JSONObject().put("pcm", Base64.encodeToString(b, Base64.NO_WRAP)).put("sampleRate", 16000).put("seconds", b.size / 32000.0) }
    }
    return snapshot(s)
  }
  fun serve(ctx: Context, uri: android.net.Uri): WebResourceResponse {
    val value = try { handle(ctx, JSONObject(uri.getQueryParameter("q") ?: "{}")) } catch (e: Exception) { JSONObject().put("error", e.message ?: "Radio request failed") }
    return WebResourceResponse("application/json", "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(value.toString().toByteArray()))
  }
}
