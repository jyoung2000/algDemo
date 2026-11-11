package com.nowplaying.discovery

import android.util.Log
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * STREAM-DL-001. Owner: "can we listen to a song while downloading it from source platforms".
 *
 * While a chosen song's file downloads, the engine can play the same song from its source: yt-dlp
 * names the source's own audio file (the Opus stream the download keeps) and [EnginePlayer] opens it
 * over the network through the same decoder, EQ and mixer as a file. The download carries on.
 *
 * Accepts every track link the native downloader accepts; the resolved format still has to be a
 * progressive audio file. A playlist-only (HLS) track cannot enter [DecodedSource] as a URL.
 * yt-dlp is asked with the fast client first, as downloads are ([YtdlpClients]).
 *
 * Mirrored by windows/streams.cjs.
 */
object Streams {
  private const val TAG = "AirwaveStream"
  private val HEADER_NAME = Regex("^[A-Za-z0-9-]{1,40}$")

  /**
   * FAST-PLAY-002. Owner: "I want to be able to play a song instantly when i click on it on all
   * platforms". Naming the source's file costs a yt-dlp run, so the answer is kept ([StreamCache])
   * and asked for before the tap: the page warms the row under the pointer, the first rows of a
   * list and the song queued next, and the tap then finds the answer already waiting.
   *
   * One warm runs at a time with a short queue, because each is a process on a phone; a tap's own
   * resolve never queues behind warms — it calls [resolve] directly and shares the cache.
   */
  private val cache = StreamCache()

  /**
   * One warm at a time, three waiting, and when they are full the *oldest* waiting one is dropped:
   * the row a listener has just scrolled to matters more than one they scrolled past.
   */
  private val warmers = ThreadPoolExecutor(
    1, 1, 0L, TimeUnit.MILLISECONDS, LinkedBlockingQueue(3),
    { r -> Thread(r, "airwave-warm").apply { isDaemon = true; priority = Thread.MIN_PRIORITY } },
    ThreadPoolExecutor.DiscardOldestPolicy(),
  )

  data class Stream(val url: String, val headers: Map<String, String>)

  fun streamable(raw: String?): Boolean = raw != null && Downloads.urlAllowed(raw)

  /** yt-dlp's options: name the best progressive audio file and print it; download nothing. */
  fun options(clients: String?): List<Pair<String, String?>> = buildList {
    add("--ignore-config" to null)
    add("--no-colors" to null)
    add("--no-cache-dir" to null)
    add("--no-playlist" to null)
    add("--no-warnings" to null)
    add("-f" to "bestaudio[protocol=https]/bestaudio[protocol=http]/best[protocol=https]/best[protocol=http]")
    add("--print" to "%(.{url,http_headers,ext,acodec,vcodec,protocol})j")
    if (clients != null) add("--extractor-args" to clients)
  }

  /** The printed JSON, checked: a web file, with the headers yt-dlp would send; null otherwise. */
  fun parse(out: String?): Stream? {
    val line = out?.lineSequence()?.map { it.trim() }?.firstOrNull { it.startsWith("{") } ?: return null
    val o = runCatching { JSONObject(line) }.getOrNull() ?: return null
    val protocol = o.optString("protocol")
    if (protocol != "https" && protocol != "http") return null
    if (o.optString("acodec") == "none" || (o.has("acodec") && o.isNull("acodec"))) return null
    val video = o.optString("vcodec")
    if (video.isNotEmpty() && video != "none" && video != "unknown") return null
    val ext = o.optString("ext")
    if (ext.isNotEmpty() && ext !in setOf("mp3", "m4a", "aac", "flac", "opus", "ogg", "oga", "wav", "webm")) return null
    val url = o.optString("url")
    val scheme = runCatching { URI(url).scheme }.getOrNull()
    if (scheme != "https" && scheme != "http") return null
    val headers = mutableMapOf<String, String>()
    o.optJSONObject("http_headers")?.let { h ->
      for (k in h.keys()) { val v = h.opt(k); if (v is String && HEADER_NAME.matches(k)) headers[k] = v }
    }
    return Stream(url, headers)
  }

  /** Ask yt-dlp for the song's audio file: the fast client first, then yt-dlp's own defaults. */
  /**
   * The source's audio file for this link. Cached, and shared with a warm already running for the
   * same link, so a tap right after a warm waits for that one run rather than starting another.
   */
  fun resolve(url: String): Stream? {
    if (!streamable(url)) return null
    cache.get(url, System.currentTimeMillis())?.let { return it }
    return runs.get(url)
  }

  private val runs = StreamRuns { url -> resolveNow(url) }

  private fun resolveNow(url: String): Stream? {
    cache.get(url, System.currentTimeMillis())?.let { return it }
    for (clients in YtdlpClients.attempts(url)) {
      val t0 = System.nanoTime()
      val found = runCatching {
        val r = YoutubeDLRequest(url)
        for ((k, v) in options(clients)) if (v == null) r.addOption(k) else r.addOption(k, v)
        parse(YoutubeDL.getInstance().execute(r).out)
      }.onFailure { Log.w(TAG, "no stream (${clients ?: "defaults"}): ${it.message?.take(200)}") }.getOrNull()
      Log.i(TAG, "resolve ${if (found != null) "ok" else "failed"} in ${(System.nanoTime() - t0) / 1_000_000} ms (${clients ?: "defaults"})")
      if (found != null) {
        cache.put(url, found, System.currentTimeMillis())
        return found
      }
    }
    cache.putFailure(url, System.currentTimeMillis())
    return null
  }

  /**
   * Name this song's file now, so a tap does not wait for it. Does nothing when the answer is
   * already held or a run is in flight, and drops the request when the short warm queue is full:
   * warming must never hold up the song the listener actually chose.
   */
  fun warm(url: String?) {
    val link = url ?: return
    if (!streamable(link)) return
    val at = System.currentTimeMillis()
    if (!cache.shouldWarm(link, at)) return
    cache.claim(link, at)
    runCatching {
      warmers.execute {
        // The claim was taken before queueing, so this is the run it stands for; a tap meanwhile
        // joins it through StreamRuns rather than starting its own.
        Log.i(TAG, "warming ahead of a tap")
        resolve(link)
      }
    }
  }
}
