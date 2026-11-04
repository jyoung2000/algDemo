package com.nowplaying.discovery

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * yt-dlp on Android, the same engine the Windows app ships, via the youtubedl-android library
 * (a Python runtime, yt-dlp and ffmpeg that unpack from the APK on first run; nothing to install).
 *
 * The page names a URL, a tool and a format; every flag is written here, `--ignore-config` first so a
 * config file can never add `--exec`. The URL goes last, after `--`, so it cannot be read as an option.
 * Manual downloads go to Music/Airwave Discovery; cache downloads stay in app-private storage.
 *
 * spotDL is not run here: it is a Python app that depends on packages with no Android build
 * (rapidfuzz, pydantic-core, uvloop). The page does what spotDL does instead (Spotify track ->
 * YouTube Music match -> yt-dlp) and `health` says so in `method`.
 */
object Downloads {
  /** Mirrored by web/src/engine/downloads.ts and windows/downloads.cjs; download-hosts.test.ts checks all three. */
  val YTDLP_HOSTS = setOf(
    "youtu.be", "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com",
  )
  val FORMATS = setOf("mp3", "m4a", "opus", "flac", "wav", "original")

  private val audioExtensions = setOf("mp3", "m4a", "aac", "flac", "opus", "ogg", "oga", "wav", "webm", "mka")
  private val mime = mapOf("mp3" to "audio/mpeg", "m4a" to "audio/mp4", "aac" to "audio/aac", "flac" to "audio/flac", "opus" to "audio/ogg", "ogg" to "audio/ogg", "oga" to "audio/ogg", "wav" to "audio/wav", "webm" to "audio/webm", "mka" to "audio/x-matroska")

  class Job(val id: String, val url: String, val format: String, val label: String, val dir: File, val cache: Boolean = false) {
    internal var queueTask: DownloadQueue.Task? = null
    @Volatile var state = "queued"
    @Volatile var stage = "queued"
    @Volatile var percent: Double? = null
    @Volatile var message: String? = null
    @Volatile var error: String? = null
    @Volatile var savedTo: String? = null
    @Volatile var cancelled = false
    val files = CopyOnWriteArrayList<Triple<String, Long, Uri?>>() // name, bytes, uri
  }

  private val jobs = ConcurrentHashMap<String, Job>()
  /**
   * Finished downloads indexed by the link they were fetched from, so the player can ask "do you
   * hold this song?" and play it on a deck through the equaliser and mixer (LOCAL-AUDIO-001). The
   * value is the saved file's URI (MediaStore on Android 10+, a file on older phones), kept in
   * SharedPreferences; an entry whose file has gone is dropped when read.
   */
  private const val LIBRARY = "airwave-library"
  private const val CACHE = "airwave-private-audio"
  private const val CACHE_NAMES = "airwave-private-audio-names"
  private const val CACHE_LIMIT = "limitGb"
  private const val CACHE_PROTECTED = "protectedUrls"
  private const val DEFAULT_LIMIT_GB = 2.0
  private const val DESTINATION = "airwave-download-destination"
  private const val TREE = "treeUri"
  private val libraryLock = Any()
  private var selection = DownloadSelection(emptyList())

  private fun cacheDir(context: Context) = File(context.filesDir, "audio-cache").also { it.mkdirs() }
  private fun cachePrefs(context: Context) = context.getSharedPreferences(CACHE, Context.MODE_PRIVATE)
  /**
   * Cache files are named by URL hash, which is useless to a listener. The song's own filename is
   * remembered separately so an explicit Download lands in Music as "Carefree.opus", not as a hash.
   */
  private fun cacheNames(context: Context) = context.getSharedPreferences(CACHE_NAMES, Context.MODE_PRIVATE)
  private fun cacheDisplayName(context: Context, url: String, fallback: String): String =
    cacheNames(context).getString(url, null)?.takeIf { it.isNotBlank() }?.let(::safeName) ?: fallback
  private fun cacheFile(context: Context, url: String): File? {
    val name = cachePrefs(context).getString(url, null) ?: return null
    if (!Regex("[a-f0-9]{64}\\.(mp3|m4a|aac|flac|opus|ogg|oga|wav|webm|mka)").matches(name)) return null
    return File(cacheDir(context), name)
  }

  private fun cachedGet(context: Context, url: String): File? = synchronized(libraryLock) {
    val file = cacheFile(context, url) ?: return null
    if (!file.isFile || file.length() == 0L) {
      cachePrefs(context).edit().remove(url).commit()
      return null
    }
    file.setLastModified(System.currentTimeMillis()) // LRU on actual playback lookup, not download time alone.
    file
  }

  private fun cacheLimit(context: Context): Long = (cachePrefs(context).getFloat(CACHE_LIMIT, DEFAULT_LIMIT_GB.toFloat()) * 1_073_741_824.0).toLong()
  private fun protectedUrls(context: Context): Set<String> = cachePrefs(context).getStringSet(CACHE_PROTECTED, emptySet())?.toSet() ?: emptySet()

  /** All cache mutation runs under libraryLock. Plan evictions first, so a rejected quota never deletes anything. */
  private fun evictions(context: Context, incoming: Long, keep: String? = null, limit: Long = cacheLimit(context), protected: Set<String> = protectedUrls(context)): List<Pair<String, File>> {
    val entries = cachePrefs(context).all.keys.filter { it != CACHE_LIMIT && it != CACHE_PROTECTED }.mapNotNull { url ->
      cacheFile(context, url)?.takeIf { it.isFile }?.let { url to it }
    }
    val names = planCacheEvictions(entries.map { CacheEntry(it.first, it.second.length(), it.second.lastModified()) }, incoming, keep, limit, protected).toSet()
    return entries.filter { it.first in names }
  }

  private fun removeEntries(context: Context, entries: List<Pair<String, File>>) {
    val editor = cachePrefs(context).edit()
    val names = cacheNames(context).edit()
    for ((url, file) in entries) {
      if (!file.delete()) throw IOException("Could not evict cached audio.")
      editor.remove(url)
      names.remove(url)
    }
    if (!editor.commit()) throw IOException("Could not update cache index.")
    names.commit()
  }

  private fun configureCache(context: Context, req: JSONObject): JSONObject = synchronized(libraryLock) {
    val gb = req.optDouble("limitGb", Double.NaN)
    require(gb.isFinite() && gb in 0.25..20.0) { "limitGb must be between 0.25 and 20." }
    fun urls(name: String, max: Int, optional: Boolean = false): List<String> {
      if (optional && !req.has(name)) return emptyList()
      val arr = req.optJSONArray(name) ?: throw IllegalArgumentException("$name must be an array of URLs.")
      require(arr.length() <= max) { "Too many $name URLs." }
      return (0 until arr.length()).map {
        val value = arr.get(it)
        require(value is String) { "$name must contain only URL strings." }
        value
      }
    }
    val next = DownloadSelection(urls("protected", 3), urls("wanted", 10000, optional = true))
    // Validate before anything is written: a bad parallel must not half-apply the new selection.
    val parallel = parsedParallel(if (req.has("parallel")) req.get("parallel") else null, queue.parallel())
    val protected = next.protected
    val limit = (gb * 1_073_741_824.0).toLong()
    val discard = evictions(context, 0, limit = limit, protected = protected)
    removeEntries(context, discard)
    if (!cachePrefs(context).edit().putFloat(CACHE_LIMIT, gb.toFloat()).putStringSet(CACHE_PROTECTED, protected).commit()) throw IOException("Could not save cache limit.")
    selection = next
    queue.setParallel(parallel)
    // Keep the entire active playlist, not just the currently cued decks.
    jobs.values.filter { it.cache && !next.retains(it.url) && (it.state == "queued" || it.state == "running") }
      .forEach { cancel(it.id) }
    JSONObject().put("ok", true).put("limitGb", gb).put("limitBytes", limit).put("bytes", cacheBytes(context)).put("parallel", parallel)
  }

  private fun cacheBytes(context: Context): Long = synchronized(libraryLock) {
    cachePrefs(context).all.keys.filter { it != CACHE_LIMIT && it != CACHE_PROTECTED }
      .sumOf { cacheFile(context, it)?.takeIf(File::isFile)?.length() ?: 0L }
  }

  private fun cacheSong(context: Context, job: Job, source: File): File = synchronized(libraryLock) {
    check(!job.cancelled) { "Download cancelled." }
    val extension = source.extension.lowercase()
    val hash = MessageDigest.getInstance("SHA-256").digest(job.url.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    val target = File(cacheDir(context), "$hash.$extension")
    val size = source.length()
    val protection = protectedUrls(context) + if (job.queueTask?.background == true) selection.wanted else emptySet()
    val discard = evictions(context, size, keep = job.url, protected = protection)
    val temp = File(cacheDir(context), "$hash.$extension.partial")
    try {
      source.inputStream().use { input -> temp.outputStream().use { output -> input.copyTo(output) } }
      if (temp.length() != size) throw IOException("Incomplete cache copy.")
      removeEntries(context, discard)
      if (target.exists() && !target.delete()) throw IOException("Could not replace cached audio.")
      if (!temp.renameTo(target)) throw IOException("Could not finish cached audio.")
      val previous = cacheFile(context, job.url)
      if (!cachePrefs(context).edit().putString(job.url, target.name).commit()) {
        target.delete()
        throw IOException("Could not index cached audio.")
      }
      if (previous != null && previous != target) previous.delete()
      cacheNames(context).edit().putString(job.url, safeName(source.name)).commit()
      target.setLastModified(System.currentTimeMillis())
      target
    } finally {
      temp.delete()
    }
  }

  private fun keep(context: Context, url: String): JSONObject = synchronized(libraryLock) {
    require(urlAllowed(url)) { "Not a link this app downloads from." }
    val saved = libraryGet(context, url)
    if (saved != null) return JSONObject().put("ok", true).put("job", JSONObject.NULL).put("alreadyKept", true)
    val cached = cachedGet(context, url) ?: throw IllegalArgumentException("Song is not in the private cache.")
    val (name, uri, where) = saveToMusic(context, cached, cacheDisplayName(context, url, cached.name))
    check(uri != null) { "Could not save song." }
    librarySet(context, url, uri)
    // Keep the cache copy for any open WebView stream; it remains subject to the configured LRU.
    JSONObject().put("ok", true).put("job", JSONObject.NULL).put("file", JSONObject().put("name", name).put("bytes", cached.length())).put("saved_to", where)
  }

  fun setFolder(context: Context, uri: Uri) {
    require(DocumentsContract.isTreeUri(uri)) { "Selected destination is not a folder." }
    if (!context.getSharedPreferences(DESTINATION, Context.MODE_PRIVATE).edit().putString(TREE, uri.toString()).commit()) {
      throw IOException("Could not save selected folder.")
    }
  }

  private fun chosenFolder(context: Context): Uri? = context.getSharedPreferences(DESTINATION, Context.MODE_PRIVATE)
    .getString(TREE, null)?.let(Uri::parse)

  private fun destinationName(context: Context): String {
    val tree = chosenFolder(context) ?: return "Music/Airwave Discovery"
    val label = runCatching { DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':') }.getOrDefault("folder")
    return "Selected folder: ${safeName(label).take(80)}"
  }

  private fun libraryGet(context: Context, url: String): Uri? = synchronized(libraryLock) {
    val prefs = context.getSharedPreferences(LIBRARY, Context.MODE_PRIVATE)
    val raw = prefs.getString(url, null) ?: return null
    val uri = Uri.parse(raw)
    val present = runCatching { context.contentResolver.openFileDescriptor(uri, "r")?.use { true } ?: false }.getOrDefault(false)
    if (!present) { prefs.edit().remove(url).apply(); return null }
    uri
  }

  private fun librarySet(context: Context, url: String, uri: Uri) = synchronized(libraryLock) {
    context.getSharedPreferences(LIBRARY, Context.MODE_PRIVATE).edit().putString(url, uri.toString()).apply()
  }

  /** The held file for a link (its URI, size and MIME type), for the activity to serve at the app origin. */
  fun localFile(context: Context, url: String): Triple<Uri, Long, String>? {
    if (!urlAllowed(url)) return null
    val uri = libraryGet(context, url) ?: cachedGet(context, url)?.let(Uri::fromFile) ?: return null
    val size = runCatching { context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull() ?: return null
    val type = context.contentResolver.getType(uri) ?: mime[uri.lastPathSegment?.substringAfterLast('.', "")?.lowercase() ?: ""] ?: "application/octet-stream"
    return Triple(uri, size, type)
  }
  private val order = CopyOnWriteArrayList<String>()
  private val workers = Executors.newFixedThreadPool(3)
  private val queue = DownloadQueue { task -> workers.execute(task) }
  private val setup = Executors.newSingleThreadExecutor()
  private val starting = AtomicBoolean(false)

  @Volatile private var ready = false
  @Volatile private var failure: String? = null
  @Volatile private var version: String? = null

  /** First-run setup: unpacks Python, yt-dlp and ffmpeg on a background thread. Safe to call repeatedly. */
  fun warmUp(context: Context) {
    if (ready || !starting.compareAndSet(false, true)) return
    val app = context.applicationContext
    setup.execute {
      try {
        YoutubeDL.getInstance().init(app)
        FFmpeg.getInstance().init(app)
        version = YoutubeDL.getInstance().version(app)
        failure = null
        ready = true
        // YouTube changes often and old yt-dlp builds stop working, so fetch the newest release in the
        // background. If the phone is offline or the update fails, the bundled build keeps working.
        try {
          YoutubeDL.getInstance().updateYoutubeDL(app, YoutubeDL.UpdateChannel.STABLE)
          version = YoutubeDL.getInstance().version(app)
        } catch (_: Throwable) {
        }
      } catch (e: Throwable) {
        failure = e.message ?: e.javaClass.simpleName
        starting.set(false)
      }
    }
  }

  fun urlAllowed(raw: String): Boolean {
    if (raw.length > 500 || raw.any { it.isWhitespace() || it.code < 32 }) return false
    val u = runCatching { URI(raw) }.getOrNull() ?: return false
    if (u.scheme != "https" || u.userInfo != null) return false
    return (u.host ?: return false).lowercase() in YTDLP_HOSTS
  }

  fun health(context: Context): JSONObject {
    val tools = JSONArray()
    val state = when {
      ready -> null
      failure != null -> "This app could not set up yt-dlp: $failure"
      else -> "Setting up on first run; it unpacks itself the first time the app opens, which takes a few seconds."
    }
    tools.put(JSONObject().put("id", "yt-dlp").put("present", ready).put("version", version ?: JSONObject.NULL).put("method", "the real yt-dlp, run inside this app").put("detail", state ?: JSONObject.NULL))
    tools.put(
      JSONObject().put("id", "spotdl").put("present", ready).put("version", JSONObject.NULL)
        .put("method", "spotDL's own method: Spotify track, matched on YouTube Music, downloaded with yt-dlp. The spotdl program itself needs packages with no Android build.")
        .put("detail", state ?: JSONObject.NULL),
    )
    tools.put(JSONObject().put("id", "ffmpeg").put("present", ready).put("version", if (ready) "bundled with this app" else JSONObject.NULL).put("method", "the real ffmpeg, run inside this app").put("detail", state ?: JSONObject.NULL))
    // The private audio cache is the app's real audio footprint, so the page can show it against
    // the owner's limit instead of the WebView's own storage estimate, which never sees these files.
    return JSONObject().put("ready", ready).put("runs_spotdl", false).put("tools", tools).put("saves_to", destinationName(context))
      .put("cache_bytes", cacheBytes(context)).put("cache_limit_bytes", cacheLimit(context))
  }

  fun handle(context: Context, req: JSONObject): JSONObject = when (val op = req.optString("op")) {
    "health" -> health(context)
    "start" -> JSONObject().put("job", view(start(context, req.optString("url"), req.optString("tool"), req.optString("format"), req.optString("label"), req.optBoolean("cache", false), req.optBoolean("background", false))))
    "cache-config" -> configureCache(context, req)
    "keep" -> keep(context, req.optString("url"))
    "jobs" -> JSONObject().put("jobs", JSONArray().also { a -> order.mapNotNull { jobs[it] }.forEach { a.put(view(it)) } })
    "cancel" -> JSONObject().put("ok", cancel(req.optString("id")))
    "forget" -> { val id = req.optString("id"); cancel(id); order.remove(id); JSONObject().put("ok", jobs.remove(id) != null) }
    "reveal" -> JSONObject().put("ok", reveal(context, req.optString("id")))
    "local" -> {
      val url = req.optString("url")
      require(urlAllowed(url)) { "Not a link this app downloads from." }
      val held = localFile(context, url)
      val running = jobs.values.any { it.url == url && (it.state == "queued" || it.state == "running") }
      JSONObject()
        .put("file", held?.let { (uri, size, _) -> JSONObject().put("name", uri.lastPathSegment ?: "song").put("bytes", size) } ?: JSONObject.NULL)
        .put("cached", cachedGet(context, url) != null)
        .put("kept", libraryGet(context, url) != null)
        .put("running", running)
    }
    else -> throw IllegalArgumentException("Unknown request: $op")
  }

  private fun start(context: Context, url: String, tool: String, format: String, label: String, cache: Boolean, background: Boolean = false): Job = synchronized(libraryLock) {
    // The page maps a Spotify link to a YouTube Music link first, so only yt-dlp is ever run here.
    require(tool == "yt-dlp") { "Only yt-dlp runs on this device." }
    require(format in FORMATS) { "Unsupported format." }
    require(urlAllowed(url)) { "yt-dlp downloads from YouTube, YouTube Music and SoundCloud links." }
    jobs.values.firstOrNull { it.url == url && (it.state == "queued" || it.state == "running") }?.let {
      if (!background) queue.submit(it.id, false) {}
      return it
    }
    require(jobs.values.count { it.state == "queued" || it.state == "running" } < 20) { "Too many downloads are waiting. Let some finish first." }
    val id = UUID.randomUUID().toString()
    val dir = File(File(context.cacheDir, "dl-jobs"), id).also { it.mkdirs() }
    val job = Job(id, url, format, label.take(200), dir, cache)
    jobs[id] = job
    order.add(id)
    val app = context.applicationContext
    job.queueTask = queue.submit(job.id, background) {
      try {
        run(app, job)
      } catch (e: Throwable) {
        if (!job.cancelled) fail(job, e.message ?: e.javaClass.simpleName)
      } finally {
        if (job.cancelled && job.state != "failed") job.state = "cancelled"
        runCatching { job.dir.deleteRecursively() }
      }
    }
    return job
  }

  private fun run(context: Context, job: Job) {
    if (job.cancelled) { job.state = "cancelled"; job.stage = "done"; return }
    if (!ready) return fail(job, failure?.let { "yt-dlp could not be set up: $it" } ?: "yt-dlp is still unpacking itself. Try again in a moment.")
    synchronized(libraryLock) {
      if (job.cancelled) return
      job.state = "running"
      job.stage = "fetching"
    }
    val r = YoutubeDLRequest(job.url)
    r.addOption("--ignore-config")
    r.addOption("--no-colors")
    r.addOption("--newline")
    r.addOption("--no-mtime")
    r.addOption("--no-cache-dir")
    r.addOption("--no-playlist")
    if (job.cache) r.addOption("--max-filesize", cacheLimit(context).toString())
    r.addOption("--paths", job.dir.absolutePath)
    r.addOption("--output", "%(title).180B.%(ext)s")
    r.addOption("--extract-audio")
    r.addOption("--embed-metadata")
    if (job.format != "original") r.addOption("--audio-format", job.format)
    val resp = YoutubeDL.getInstance().execute(r, job.id) { progress, _, line ->
      if (progress >= 0f) job.percent = progress.toDouble().coerceIn(0.0, 100.0)
      val t = line.trim()
      if (t.isNotEmpty()) {
        job.message = t.take(300)
        if (t.startsWith("[ExtractAudio]") || t.startsWith("[Merger]") || t.startsWith("[Metadata]")) job.stage = "converting"
      }
    }
    if (job.cancelled) return
    if (resp.exitCode != 0) return fail(job, lastLine(resp.err) ?: "yt-dlp exited with code ${resp.exitCode}.")
    job.stage = "finalizing"
    val found = job.dir.walkTopDown().maxDepth(4).filter { it.isFile && it.extension.lowercase() in audioExtensions }.sortedBy { it.name }.toList()
    if (found.isEmpty()) return fail(job, "yt-dlp finished without producing an audio file.")
    if (job.cache) {
      if (found.size != 1) return fail(job, "Private playback cache requires exactly one audio file.")
      val cached = cacheSong(context, job, found.single())
      job.files.add(Triple(safeName(found.single().name), cached.length(), Uri.fromFile(cached)))
      job.savedTo = "Private audio cache"
      job.state = "done"
      job.stage = "done"
      job.percent = 100.0
      return
    }
    for (f in found) {
      val (name, uri, where) = saveToMusic(context, f)
      job.files.add(Triple(name, f.length(), uri))
      job.savedTo = where
    }
    if (found.size == 1) job.files.firstOrNull()?.third?.let { librarySet(context, job.url, it) }
    job.state = "done"
    job.stage = "done"
    job.percent = 100.0
  }

  /** Copies into a chosen SAF tree, otherwise Music/Airwave Discovery. */
  private fun saveToMusic(context: Context, f: File, displayName: String = f.name): Triple<String, Uri?, String> {
    val name = safeName(displayName)
    val type = mime[f.extension.lowercase()] ?: "application/octet-stream"
    chosenFolder(context)?.let { tree ->
      val resolver = context.contentResolver
      val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
      val uri = DocumentsContract.createDocument(resolver, parent, type, name)
        ?: throw IOException("Selected folder is unavailable; choose it again.")
      try {
        (resolver.openOutputStream(uri) ?: throw IOException("Could not write to selected folder.")).use { out ->
          f.inputStream().use { it.copyTo(out) }
        }
      } catch (e: Exception) {
        runCatching { DocumentsContract.deleteDocument(resolver, uri) }
        throw e
      }
      return Triple(name, uri, destinationName(context))
    }
    if (Build.VERSION.SDK_INT >= 29) {
      val values = ContentValues().apply {
        put(MediaStore.Audio.Media.DISPLAY_NAME, name)
        put(MediaStore.Audio.Media.MIME_TYPE, type)
        put(MediaStore.Audio.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MUSIC}/Airwave Discovery")
        put(MediaStore.Audio.Media.IS_PENDING, 1)
      }
      val resolver = context.contentResolver
      val uri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values) ?: throw java.io.IOException("Could not create a file in the Music folder.")
      try {
        (resolver.openOutputStream(uri) ?: throw IOException("Could not open Music destination.")).use { out -> f.inputStream().use { it.copyTo(out) } }
        if (resolver.update(uri, ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null) < 1) throw IOException("Could not publish Music file.")
      } catch (e: Exception) {
        resolver.delete(uri, null, null)
        throw e
      }
      return Triple(name, uri, "Music/Airwave Discovery")
    }
    val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "Airwave Discovery").also { it.mkdirs() }
    val dest = File(dir, name)
    f.copyTo(dest, overwrite = false)
    return Triple(name, Uri.fromFile(dest), dir.absolutePath)
  }

  private fun cancel(id: String): Boolean = synchronized(libraryLock) {
    val j = jobs[id] ?: return false
    if (j.state == "queued" || j.state == "running") {
      j.cancelled = true
      j.queueTask?.let(queue::cancel)
      runCatching { YoutubeDL.getInstance().destroyProcessById(id) }
      if (j.state == "queued") { j.state = "cancelled"; j.stage = "done"; j.dir.deleteRecursively() }
    }
    return true
  }

  private fun reveal(context: Context, id: String): Boolean {
    val uri = jobs[id]?.files?.firstOrNull()?.third ?: return false
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "audio/*").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return runCatching { context.startActivity(intent) }.isSuccess
  }

  private fun fail(job: Job, reason: String) {
    job.state = "failed"
    job.stage = "done"
    job.error = reason.take(600)
  }

  private fun view(j: Job): JSONObject {
    val files = JSONArray()
    j.files.forEach { (n, b, _) -> files.put(JSONObject().put("name", n).put("bytes", b)) }
    return JSONObject().put("id", j.id).put("url", j.url).put("tool", "yt-dlp").put("format", j.format).put("label", j.label)
      .put("state", j.state).put("stage", j.stage).put("percent", j.percent ?: JSONObject.NULL).put("message", j.message ?: JSONObject.NULL)
      .put("error", j.error ?: JSONObject.NULL).put("files", files).put("saved_to", j.savedTo ?: JSONObject.NULL)
      .put("cached", j.cache)
  }

  fun safeName(name: String): String {
    val cleaned = name.replace(Regex("[\\u0000-\\u001f<>:\"/\\\\|?*]"), "_").trim().trim('.')
    return if (cleaned.isEmpty()) "song" else cleaned.take(160)
  }

  /** yt-dlp's last ERROR line; warnings (an old version, skipped formats) are not the reason it failed. */
  private fun lastLine(stderr: String): String? {
    val at = stderr.lastIndexOf("ERROR:")
    if (at < 0) return stderr.split("\n").map { it.trim() }.lastOrNull { it.isNotEmpty() && !it.startsWith("WARNING:", ignoreCase = true) }?.take(600)
    return stderr.substring(at + 6).trim().lineSequence().first().trim().take(600)
  }
}
